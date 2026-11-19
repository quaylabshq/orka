use crate::db::{self, Result};
use fs2::FileExt;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    collections::BTreeMap,
    fs,
    path::{Path, PathBuf},
    process::Command,
    sync::OnceLock,
};

static CURRENT: OnceLock<String> = OnceLock::new();

pub fn validate(name: &str) -> Result<()> {
    if name.is_empty()
        || name.len() > 48
        || !name.as_bytes()[0].is_ascii_lowercase()
        || !name
            .bytes()
            .all(|c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
    {
        return Err(
            "Use 1–48 lowercase letters, numbers or hyphens, starting with a letter".into(),
        );
    }
    Ok(())
}

pub fn initialize(args: &mut Vec<String>) -> Result<()> {
    let mut selected = None;
    let mut index = 1;
    while index < args.len() {
        if args[index] == "--profile" {
            if selected.is_some() || index + 1 == args.len() {
                return Err("Pass --profile followed by one profile name".into());
            }
            args.remove(index);
            selected = Some(args.remove(index));
        } else {
            index += 1;
        }
    }
    let name = selected
        .or_else(|| std::env::var("ORKA_PROFILE").ok())
        .unwrap_or_else(|| "default".into());
    validate(&name)?;
    CURRENT
        .set(name)
        .map_err(|_| "Profile is already selected".into())
}

pub fn current() -> &'static str {
    CURRENT.get().map(String::as_str).unwrap_or("default")
}

pub fn root(name: &str) -> Result<PathBuf> {
    validate(name)?;
    let base = db::base_root()?;
    Ok(if name == "default" {
        base
    } else {
        base.join("profiles").join(name)
    })
}

fn prepare(name: &str) -> Result<PathBuf> {
    use std::os::unix::fs::PermissionsExt;
    let path = root(name)?;
    if fs::symlink_metadata(&path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("Profile directory cannot be a symlink".into());
    }
    fs::create_dir_all(&path).map_err(|e| e.to_string())?;
    fs::set_permissions(&path, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    Ok(path)
}

pub fn label() -> String {
    if current() == "default" {
        "com.orka.v1".into()
    } else {
        format!("com.orka.v1.profile.{}", current())
    }
}

pub fn credential_service() -> Result<String> {
    #[cfg(debug_assertions)]
    if current() == "default" && std::env::var_os("ORKA_TEST_HOME").is_some() {
        return Ok(format!(
            "com.orka.v1.test.{}",
            db::digest(db::root()?.to_string_lossy().as_bytes())
        ));
    }
    let isolated = current() != "default"
        || cfg!(debug_assertions) && std::env::var_os("ORKA_TEST_HOME").is_some();
    Ok(if isolated {
        format!(
            "com.orka.v1.profile.{}",
            db::digest(db::root()?.to_string_lossy().as_bytes())
        )
    } else {
        "com.orka.v1".into()
    })
}

pub fn background_default() -> bool {
    current() == "default"
}

pub fn instance_lock(name: &str) -> Result<fs::File> {
    let path = prepare(name)?.join("ui.lock");
    fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(path)
        .map_err(|e| e.to_string())
}

pub fn acquire_instance() -> Result<Option<fs::File>> {
    let lock = instance_lock(current())?;
    match lock.try_lock_exclusive() {
        Ok(()) => Ok(Some(lock)),
        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
            db::atomic(&root(current())?.join("focus"), b"")?;
            Ok(None)
        }
        Err(e) => Err(e.to_string()),
    }
}

#[tauri::command]
pub fn profile_list() -> Result<Value> {
    let mut names = vec!["default".to_string()];
    let directory = db::base_root()?.join("profiles");
    if directory.exists() {
        for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name().to_string_lossy().into_owned();
            if validate(&name).is_ok() && entry.file_type().map_err(|e| e.to_string())?.is_dir() {
                names.push(name);
            }
        }
    }
    names.push(current().into());
    names.sort();
    names.dedup();
    Ok(json!({"current":current(),"names":names}))
}

#[tauri::command]
pub fn open_profile(name: String) -> Result<()> {
    let lock = instance_lock(&name)?;
    match lock.try_lock_exclusive() {
        Ok(()) => {
            FileExt::unlock(&lock).map_err(|e| e.to_string())?;
            let mut child = Command::new(crate::updates::executable().map_err(|e| e.to_string())?)
                .args(["--profile", &name])
                .spawn()
                .map_err(|e| e.to_string())?;
            std::thread::spawn(move || {
                let _ = child.wait();
            });
            Ok(())
        }
        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
            db::atomic(&root(&name)?.join("focus"), b"")
        }
        Err(e) => Err(e.to_string()),
    }
}

// The deep-link plugin also forwards Opened URLs to the WebView. A valid
// foreign callback must succeed here without queueing or falling back to local
// sign-in: the native Opened handler already owns that delivery.
#[tauri::command]
pub fn route_auth_callback(callback: String) -> Result<()> {
    let name = crate::auth::callback_profile(&callback)?;
    if name == current() {
        queue_callback_for(&name, &callback)?;
    }
    Ok(())
}

pub fn route_foreign_auth_callback(name: String, callback: &str) -> Result<()> {
    if queue_callback_for(&name, callback)? {
        open_profile(name)?;
    }
    Ok(())
}

#[tauri::command]
pub fn route_plugin_callback(callback: String) -> Result<()> {
    let (name, _, _) = crate::plugin_connection::callback(&callback)?;
    queue_callback_for(&name, &callback)?;
    if name != current() {
        open_profile(name)?;
    }
    Ok(())
}

fn callback_lock(root: &Path) -> Result<fs::File> {
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(root.join("auth-callback.lock"))
        .map_err(|e| e.to_string())?;
    FileExt::lock_exclusive(&file).map_err(|e| e.to_string())?;
    Ok(file)
}

pub fn queue_callback(callback: &str) -> Result<String> {
    let name = crate::auth::callback_profile(callback)?;
    queue_callback_for(&name, callback)?;
    Ok(name)
}

#[derive(Default, Deserialize, Serialize)]
#[serde(rename_all = "camelCase")]
struct CallbackInbox {
    url: Option<String>,
    expires_at: i64,
    // Keep digests, not callback URLs, after delivery. The same lock protects
    // the pending URL and receipts across all receiving profile processes.
    #[serde(default)]
    seen: BTreeMap<String, i64>,
}

impl CallbackInbox {
    fn read(path: &Path) -> Result<Self> {
        match fs::read(path) {
            Ok(raw) => Ok(serde_json::from_slice(&raw).unwrap_or_default()),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Self::default()),
            Err(e) => Err(e.to_string()),
        }
    }

    fn write(&self, path: &Path) -> Result<()> {
        db::atomic(path, &serde_json::to_vec(self).map_err(|e| e.to_string())?)
    }
}

fn queue_callback_for(name: &str, callback: &str) -> Result<bool> {
    let root = root(name)?;
    if !root.is_dir() {
        return Err("The window that requested this sign-in is unavailable".into());
    }
    let _lock = callback_lock(&root)?;
    let path = root.join("auth-callback.json");
    let mut inbox = CallbackInbox::read(&path)?;
    let now = chrono::Utc::now().timestamp();
    inbox.seen.retain(|_, expires| *expires >= now);
    let digest = db::digest(callback.as_bytes());
    if inbox.seen.contains_key(&digest) {
        return Ok(false);
    }
    inbox.expires_at = now + 600;
    inbox.seen.insert(digest, inbox.expires_at);
    inbox.url = Some(callback.into());
    inbox.write(&path)?;
    Ok(true)
}

pub fn take_callback() -> Result<Option<String>> {
    let root = db::root()?;
    let _lock = callback_lock(&root)?;
    let path = root.join("auth-callback.json");
    let mut inbox = CallbackInbox::read(&path)?;
    let now = chrono::Utc::now().timestamp();
    let callback = inbox.url.take();
    if callback.is_some() {
        inbox.write(&path)?;
    }
    Ok(callback.filter(|_| inbox.expires_at >= now))
}

/// Consumes a request from another process to bring this profile forward.
fn take_focus_request(root: &std::path::Path) -> bool {
    fs::remove_file(root.join("focus")).is_ok()
}

/// Brings this profile forward when another process asks, without the webview.
///
/// WebKit suspends the page of a minimized window, so `profile_events` stops
/// polling and a callback routed here would wait unseen. Revealing the window
/// natively wakes the page, which then takes the callback.
pub fn watch_focus_requests(app: tauri::AppHandle) {
    std::thread::spawn(move || loop {
        std::thread::sleep(std::time::Duration::from_millis(500));
        if db::root().is_ok_and(|root| take_focus_request(&root)) {
            let _ = crate::menu_bar::open_main(&app);
        }
    });
}

#[tauri::command]
pub fn profile_events(app: tauri::AppHandle) -> Result<Option<String>> {
    let focus = take_focus_request(&db::root()?);
    let callback = take_callback()?;
    if focus || callback.is_some() {
        let _ = crate::menu_bar::open_main(&app);
    }
    Ok(callback)
}

#[cfg(test)]
mod tests {
    #[test]
    fn a_focus_request_is_taken_once() {
        let root = tempfile::tempdir().unwrap();
        assert!(!super::take_focus_request(root.path()));
        std::fs::write(root.path().join("focus"), b"").unwrap();
        assert!(super::take_focus_request(root.path()));
        assert!(!root.path().join("focus").exists());
        assert!(!super::take_focus_request(root.path()));
    }

    #[test]
    fn profile_names_cannot_escape_storage_or_arguments() {
        for name in ["default", "alice", "wt-feature-123"] {
            assert!(super::validate(name).is_ok());
        }
        for name in [
            "",
            "..",
            "../alice",
            "/tmp/alice",
            "ALICE",
            "-flag",
            "a b",
            "a.b",
            &"a".repeat(49),
        ] {
            assert!(super::validate(name).is_err(), "{name}");
        }
    }
}
