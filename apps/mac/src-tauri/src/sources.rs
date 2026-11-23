use crate::{
    db::{self, Result},
    indexer, native,
    onboarding::discovery::{key_for_remote, remote_keys},
    projects, sync,
    sync_queue::{Priority, SyncQueue},
};
use serde_json::{json, Value};
use std::{
    collections::BTreeSet,
    fs,
    path::{Path, PathBuf},
};
use uuid::Uuid;

pub fn views(project: &Value) -> Vec<Value> {
    if !project["removedAt"].is_null() {
        return Vec::new();
    }
    if project["sourceId"].is_string() || !project["sources"].is_array() {
        return vec![project.clone()];
    }
    project["sources"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|source| source["removedAt"].is_null())
        .map(|source| source_view(project, source))
        .collect()
}

fn source_view(project: &Value, source: &Value) -> Value {
    let mut view = project.clone();
    view["sourceId"] = source["id"].clone();
    for key in ["path", "folderIdentity", "repository", "repositoryRevision"] {
        view[key] = source[key].clone();
    }
    view["firstSyncWaiting"] = source["firstSyncWaiting"].clone();
    view["sourceRemoteKey"] = source["remoteKey"].clone();
    view["verifiedRemoteKey"] = source["verifiedRemoteKey"].clone();
    view
}

pub fn for_resource(project: &Value, resource: &Value) -> Option<Value> {
    views(project)
        .into_iter()
        .find(|view| view["path"].is_string() && view["sourceId"] == resource["sourceId"])
}

pub fn select(project: &Value, source_id: Option<&str>) -> Result<Value> {
    let candidates: Vec<_> = views(project)
        .into_iter()
        .filter(|view| {
            view["path"].is_string() && source_id.is_none_or(|id| view["sourceId"] == id)
        })
        .collect();
    match candidates.as_slice() {
        [source] => Ok(source.clone()),
        [] => Err("Connect this repository's folder on this Mac".into()),
        _ => Err("Choose a repository for this action".into()),
    }
}

pub fn registered(project: &Value, source_id: Option<&str>) -> Result<Value> {
    let candidates: Vec<_> = views(project)
        .into_iter()
        .filter(|view| source_id.is_none_or(|id| view["sourceId"] == id))
        .collect();
    match candidates.as_slice() {
        [source] => Ok(source.clone()),
        [] => Err("Add a source folder to this project first".into()),
        _ => Err("Choose a repository for this action".into()),
    }
}

pub fn matches(project: &Value, resource: &Value) -> bool {
    project["sourceId"] == resource["sourceId"]
}

pub fn meta_key(project: &Value, name: &str) -> Result<String> {
    let id = project["id"].as_str().ok_or("Missing project")?;
    Ok(match project["sourceId"].as_str() {
        Some(source) => format!("{name}:{id}:{source}"),
        None => format!("{name}:{id}"),
    })
}

pub fn scope(project: &Value, resource: &mut Value) {
    if project["sourceId"].is_string() {
        resource["sourceId"] = project["sourceId"].clone();
    }
}

/// How long a folder newly connected on this Mac waits before its first sync,
/// so a folder chosen by mistake can be disconnected before a long scan starts.
pub const NEW_FOLDER_DELAY_MS: i64 = 3 * 60 * 1000;

fn sync_after_key(project: &str, source: &str) -> String {
    format!("source-sync-after:{project}:{source}")
}

/// When a newly connected folder's first sync may start, if that is still ahead.
pub fn sync_after(db: &rusqlite::Connection, project: &str, source: &str) -> Result<Option<i64>> {
    let key = sync_after_key(project, source);
    Ok(db::get(db, &key)?
        .as_i64()
        .filter(|at| *at > chrono::Utc::now().timestamp_millis()))
}

/// Starts a waiting folder's first sync now.
pub(crate) fn clear_sync_after(
    db: &rusqlite::Connection,
    project: &str,
    source: &str,
) -> Result<()> {
    db::set(db, &sync_after_key(project, source), &Value::Null)
}

/// The project as sync should see it: folders still waiting for their first
/// sync are treated as not yet connected on this Mac, so nothing scans them or
/// writes into them. Also returns when the earliest of them may start.
pub(crate) fn without_waiting(
    db: &rusqlite::Connection,
    project: &Value,
) -> Result<(Value, Option<i64>)> {
    let mut view = project.clone();
    let mut earliest: Option<i64> = None;
    let id = project["id"].as_str().unwrap_or_default();
    if let Some(sources) = view["sources"].as_array_mut() {
        for source in sources {
            let Some(source_id) = source["id"].as_str() else {
                continue;
            };
            if source["path"].is_string() && source["removedAt"].is_null() {
                if let Some(at) = sync_after(db, id, source_id)? {
                    source["path"] = Value::Null;
                    // The rest of this pass must agree with the masked view,
                    // even if the deadline expires or Sync now clears it.
                    source["firstSyncWaiting"] = json!(true);
                    earliest = Some(earliest.map_or(at, |e| e.min(at)));
                }
            }
        }
    }
    Ok((view, earliest))
}

pub(crate) fn waiting_to_sync(db: &rusqlite::Connection, source: &Value) -> Result<bool> {
    match (source["id"].as_str(), source["sourceId"].as_str()) {
        (Some(id), Some(source_id)) => Ok(sync_after(db, id, source_id)?.is_some()),
        _ => Ok(false),
    }
}

#[tauri::command]
pub fn start_source_sync(id: String, source_id: String) -> Result<()> {
    let db = db::open()?;
    clear_sync_after(&db, &id, &source_id)?;
    SyncQueue::request(&db, &id, Priority::User, "folder")
}

const PIN_MISMATCH: &str = "This folder does not match the source's saved Git repository. Choose the matching checkout, or ask a project owner to use Reset Git repository in Settings → Source folders.";

// The first key is authoritative for new pins; older URLs are aliases for
// validating older checkouts and pins after a rename.
fn linked_keys(repository: &Value) -> Vec<String> {
    repository["cloneUrl"]
        .as_str()
        .into_iter()
        .chain(
            repository["previousCloneUrls"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(Value::as_str),
        )
        .filter_map(key_for_remote)
        .collect()
}

// Any matching remote guards against mistakes, not tampering: Git config is editable.
fn matches_pin(pinned: &str, repository: &Value, keys: &[String]) -> bool {
    if repository["cloneUrl"].is_string() {
        let linked = linked_keys(repository);
        linked.iter().any(|key| key == pinned) && linked.iter().any(|key| keys.contains(key))
    } else {
        keys.iter().any(|key| key == pinned)
    }
}

/// A new connection must prove its identity when a pin exists.
fn check_pin(source: &Value, remotes: &Result<Vec<String>>) -> Result<()> {
    let Some(pinned) = source["remoteKey"].as_str() else {
        return Ok(());
    };
    match remotes {
        Ok(keys) if matches_pin(pinned, &source["repository"], keys) => Ok(()),
        Ok(keys) if keys.is_empty() => Err("This source is linked to a Git repository, but this folder has no Git remote to compare. Choose a checkout of that repository.".into()),
        Ok(_) => Err(PIN_MISMATCH.into()),
        Err(_) => Err("Orka can't read this folder's Git settings to confirm it is this source's repository. Check the folder's permissions, then try again.".into()),
    }
}

fn checked_root(project: &Value) -> Result<&Path> {
    if !project["removedAt"].is_null() {
        return Err("This source folder was removed from the project".into());
    }
    let raw = project["path"]
        .as_str()
        .ok_or("Connect this repository's folder")?;
    let root = Path::new(raw);
    if !root.is_dir()
        || project["folderIdentity"].as_str().is_some_and(|identity| {
            !indexer::folder_identity_matches(root, identity).unwrap_or(false)
        })
    {
        return Err(
            "Connected source folder changed or is unavailable; local writes and deletions paused. Reconnect it in Settings → Source folders."
                .into(),
        );
    }
    Ok(root)
}

fn check_link(repository: &Value, remotes: &Result<Vec<String>>) -> Result<()> {
    let Some(url) = repository["cloneUrl"].as_str() else {
        return Ok(());
    };
    let keys = remotes.as_ref().map_err(Clone::clone)?;
    if key_for_remote(url).is_none() {
        return Err("Invalid repository URL".into());
    }
    if linked_keys(repository).iter().any(|key| keys.contains(key)) {
        Ok(())
    } else if keys.is_empty() {
        Err("This folder has no Git remote, so Orka can't confirm it is the linked repository. Choose the checkout cloned from GitHub, or add its remote.".into())
    } else {
        Err("This folder's Git remote does not match the linked repository. Choose the correct checkout in Source folders.".into())
    }
}

fn pin_conflict(view: &Value, remotes: &Result<Vec<String>>) -> bool {
    view["sourceRemoteKey"].as_str().is_some_and(|pinned| {
        match remotes {
            Ok(keys) if !keys.is_empty() => !matches_pin(pinned, &view["repository"], keys),
            // A missing or unreadable remote can only be tolerated for a
            // checkout that previously proved it matched this pin.
            _ => view["verifiedRemoteKey"] != pinned,
        }
    })
}

/// Keep local verification bound to this checkout and to the current pin.
pub(crate) fn refresh_pin_verification(source: &mut Value, previous: &Value) {
    let Some(pinned) = source["remoteKey"].as_str() else {
        return;
    };
    if checked_root(source).is_ok_and(|root| match remote_keys(root) {
        Ok(keys) if !keys.is_empty() => matches_pin(pinned, &source["repository"], &keys),
        _ => previous == pinned,
    }) {
        source["verifiedRemoteKey"] = json!(pinned);
    } else {
        source["verifiedRemoteKey"] = Value::Null;
    }
}

pub fn validate(project: &Value) -> Result<()> {
    let root = checked_root(project)?;
    if project["sourceRemoteKey"].is_string() || project["repository"]["cloneUrl"].is_string() {
        let remotes = remote_keys(root);
        if pin_conflict(project, &remotes) {
            return Err(PIN_MISMATCH.into());
        }
        check_link(&project["repository"], &remotes)?;
    }
    Ok(())
}

/// Sources this pass must leave untouched, including those whose wait expires
/// while it is running.
pub(crate) fn paused_upload_sources(project: &Value) -> BTreeSet<String> {
    views(project)
        .into_iter()
        .filter(|source| {
            source["firstSyncWaiting"] == true
                || (source["path"].is_string()
                    && (source["sourceRemoteKey"].is_string()
                        || source["repository"]["cloneUrl"].is_string())
                    && validate(source).is_err())
        })
        .filter_map(|source| source["sourceId"].as_str().map(str::to_owned))
        .collect()
}

pub(crate) fn upload_paused(paused_sources: &BTreeSet<String>, source_id: &Value) -> bool {
    !paused_sources.is_empty()
        && source_id
            .as_str()
            .is_none_or(|id| paused_sources.contains(id))
}

/// [`folder_state`] for an entry of a project's `sources`, which keeps its pin
/// as `remoteKey`; views and legacy projects use other fields.
pub fn source_folder_state(source: &Value) -> &'static str {
    let mut view = source.clone();
    view["sourceRemoteKey"] = source["remoteKey"].clone();
    folder_state(&view)
}

/// Presentation-only local state; paths and identity checks remain native.
pub fn folder_state(source: &Value) -> &'static str {
    if !source["path"].is_string() {
        return "locate";
    }
    let Ok(root) = checked_root(source) else {
        return "reconnect";
    };
    if source["sourceRemoteKey"].is_string() || source["repository"]["cloneUrl"].is_string() {
        let remotes = remote_keys(root);
        if pin_conflict(source, &remotes) {
            return "repository-conflict";
        }
        if check_link(&source["repository"], &remotes).is_err() {
            return "reconnect";
        }
    }
    "connected"
}

pub fn upgrade_identity(source: &mut Value) {
    let (Some(path), Some(expected)) = (source["path"].as_str(), source["folderIdentity"].as_str())
    else {
        return;
    };
    let root = Path::new(path);
    if !expected.starts_with("volume:")
        && indexer::folder_identity_matches(root, expected) == Ok(true)
    {
        if let Ok(identity) = indexer::folder_identity(root) {
            source["folderIdentity"] = json!(identity);
        }
    }
}

pub fn resource_id(project: &Value, kind: &str, path: &str) -> Result<String> {
    let id = project["id"].as_str().ok_or("Missing project")?;
    let namespace = project["sourceId"]
        .as_str()
        .filter(|source| *source != id)
        .map(|source| format!("{id}:{source}"))
        .unwrap_or(id.into());
    Ok(indexer::resource_id(&namespace, kind, path))
}

/// Why a folder is too broad to be one project's source, if it is: syncing it
/// would scan a whole disk, account or system area. `root` is canonical.
pub(crate) fn too_broad(root: &Path, home: Option<&Path>) -> Option<&'static str> {
    if root.parent().is_none() {
        return Some("It is the top of the disk.");
    }
    if let Some(home) = home {
        if root == home {
            return Some("It is your home folder.");
        }
        if home.starts_with(root) {
            return Some("It contains your home folder.");
        }
        if root.starts_with(home.join("Library")) {
            return Some("It is inside your Library folder.");
        }
    }
    let depth = root.components().count();
    if (root.starts_with("/Volumes") && depth <= 3) || is_mount_root(root) {
        return Some("It is the top of a drive.");
    }
    if root.starts_with("/System")
        || root.starts_with("/Library")
        || [
            "/Applications",
            "/Users",
            "/private",
            "/private/var",
            "/private/etc",
            "/var",
            "/usr",
            "/opt",
            "/etc",
        ]
        .iter()
        .any(|system| root == Path::new(system))
    {
        return Some("It is a system folder.");
    }
    None
}

#[cfg(target_os = "macos")]
fn is_mount_root(path: &Path) -> bool {
    use std::{
        ffi::{CString, OsStr},
        mem::MaybeUninit,
        os::unix::ffi::OsStrExt,
    };

    let Ok(name) = CString::new(path.as_os_str().as_bytes()) else {
        return false;
    };
    let mut stats = MaybeUninit::<libc::statfs>::uninit();
    // statfs initializes the structure on success and reports the mount point
    // even when it is outside /Volumes or shares a device with its parent.
    if unsafe { libc::statfs(name.as_ptr(), stats.as_mut_ptr()) } != 0 {
        return false;
    }
    let stats = unsafe { stats.assume_init() };
    let mount: Vec<u8> = stats
        .f_mntonname
        .iter()
        .take_while(|&&byte| byte != 0)
        .map(|&byte| byte as u8)
        .collect();
    let mount = Path::new(OsStr::from_bytes(&mount));
    mount == path || mount.canonicalize().is_ok_and(|resolved| resolved == path)
}

#[cfg(not(target_os = "macos"))]
fn is_mount_root(path: &Path) -> bool {
    use std::os::unix::fs::MetadataExt;

    let Some(parent) = path.parent() else {
        return true;
    };
    fs::metadata(path)
        .and_then(|metadata| Ok(metadata.dev() != fs::metadata(parent)?.dev()))
        .unwrap_or(false)
}

fn home_folder() -> Option<PathBuf> {
    dirs::home_dir().and_then(|home| home.canonicalize().ok())
}

fn canonical(raw: &str) -> Result<PathBuf> {
    let root = PathBuf::from(raw)
        .canonicalize()
        .map_err(|e| format!("Cannot open folder: {e}"))?;
    if !root.is_dir() {
        return Err("Choose a folder".into());
    }
    Ok(root)
}

fn registration_id(sources: &[Value], pending: &Value, root: &Path) -> String {
    pending
        .as_array()
        .and_then(|items| {
            items.iter().find(|item| {
                item["path"] == json!(root)
                    && !sources
                        .iter()
                        .any(|source| source["id"] == item["id"] && !source["removedAt"].is_null())
            })
        })
        .and_then(|item| item["id"].as_str())
        .map(str::to_owned)
        .unwrap_or_else(|| Uuid::new_v4().to_string())
}

pub(crate) fn preserve_removed_queue(
    db: &rusqlite::Connection,
    project: &str,
    source: &Value,
) -> Result<()> {
    let source_id = source["id"].as_str().ok_or("Missing source")?;
    let queued = db::rows(db, "SELECT json_object('id',id,'path',path,'value',json(value),'error',error) FROM outbox WHERE project=?1 AND (json_extract(value,'$.resource.sourceId')=?2 OR json_extract(value,'$.sourceId')=?2 OR EXISTS(SELECT 1 FROM resources r WHERE r.project=outbox.project AND r.id=json_extract(outbox.value,'$.resourceId') AND json_extract(r.value,'$.sourceId')=?2))", &[&project,&source_id])?;
    for entry in queued {
        let request_id = entry["id"].as_str().ok_or("Missing queued request")?;
        let resource = if entry["value"]["resource"].is_object() {
            entry["value"]["resource"].clone()
        } else if matches!(
            entry["path"].as_str(),
            Some("/v2/sessions/copy" | "/v2/sessions/resolve")
        ) {
            sync::queued_session_snapshot(db, &entry["value"])?
                .ok_or("The queued session selection is unavailable; local work was preserved")?
        } else {
            crate::governance::resource(
                db,
                entry["value"]["resourceId"]
                    .as_str()
                    .ok_or("Missing queued resource")?,
            )?
        };
        let binding = indexer::binding(
            db,
            resource["resourceId"].as_str().ok_or("Missing resource")?,
        )?;
        let receipt_key = format!("selected-share:{request_id}");
        let mut receipt = db::get(db, &receipt_key)?;
        let paths = if receipt["paths"].is_array() {
            &receipt["paths"]
        } else {
            &binding["paths"]
        };
        let id = Uuid::new_v5(
            &Uuid::NAMESPACE_URL,
            format!("removed-source:{project}:{source_id}:{request_id}").as_bytes(),
        )
        .to_string();
        let draft = json!({"id":id,"projectId":project,"resource":resource,"paths":paths,"status":"local","createdAt":db::now(),"sourceRemoval":{"sourceId":source_id,"removedAt":source["removedAt"],"queued":entry}});
        db.execute(
            "INSERT OR IGNORE INTO drafts VALUES(?,?,?)",
            rusqlite::params![id, project, draft.to_string()],
        )
        .map_err(|e| e.to_string())?;
        if entry["path"] == crate::selective_sharing::QUEUE_PATH && receipt.is_object() {
            receipt["status"] = json!("conflict");
            receipt["result"] = json!({"status":"conflict","reason":"source_removed","draftId":id,"message":"Source folder removed. The selected snapshot is kept in Changes on this Mac."});
            db::set(db, &receipt_key, &receipt)?;
        }
        db.execute("DELETE FROM outbox WHERE id=?", [request_id])
            .map_err(|e| e.to_string())?;
        sync::clear_session_copy(db, request_id)?;
    }
    for mut pending in db::rows(db, "SELECT json_object('key',key,'value',json(value)) FROM meta WHERE key LIKE 'env:%:pending:%' AND json_extract(value,'$.header.manifest.projectId')=?1 AND coalesce(json_extract(value,'$.header.manifest.sourceId'),?1)=?2", &[&project,&source_id])? {
        pending["value"]["sourceRemoval"] = json!({"sourceId":source_id,"removedAt":source["removedAt"]});
        db::set(db, pending["key"].as_str().ok_or("Missing ENV pending key")?, &pending["value"])?;
    }
    Ok(())
}

#[tauri::command]
pub fn scan_project_folders(path: String) -> Result<Vec<Value>> {
    let parent = canonical(&path)?;
    let mut folders = Vec::new();
    for entry in fs::read_dir(parent).map_err(|e| e.to_string())? {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().map_err(|e| e.to_string())?.is_dir() {
            continue;
        }
        let root = entry.path();
        // .git can be a directory or a file (worktrees and submodules).
        if !root.join(".git").exists() {
            continue;
        }
        folders.push(json!({"name":entry.file_name().to_string_lossy(),"path":root}));
        if folders.len() > 100 {
            return Err("More than 100 repositories found; select a smaller parent folder".into());
        }
    }
    folders.sort_by(|a, b| a["name"].as_str().cmp(&b["name"].as_str()));
    Ok(folders)
}

fn pin_candidate(project: &Value, source: &Value) -> Option<(String, Vec<String>)> {
    if !source["remoteKey"].is_null() || !source["removedAt"].is_null() {
        return None;
    }
    let view = source_view(project, source);
    let remotes = remote_keys(checked_root(&view).ok()?);
    check_link(&view["repository"], &remotes).ok()?;
    let keys = remotes.ok()?;
    let key = if let Some(url) = source["repository"]["cloneUrl"].as_str() {
        key_for_remote(url)?
    } else {
        keys.first()?.clone()
    };
    Some((key, keys))
}

/// Try again after every catalog refresh. Nothing records a failed attempt as
/// complete, and the server returns the winner even if another Mac wrote first.
pub(crate) async fn backfill_remote_pins<F: std::future::Future<Output = Result<Value>> + Send>(
    db: &mut rusqlite::Connection,
    capabilities: &Value,
    mut post_pin: impl FnMut(Value) -> F + Send,
) -> Result<()> {
    if capabilities["sourceRemoteKey"] != 1 {
        return Ok(());
    }
    let projects = db::rows(
        db,
        &format!("SELECT value FROM projects WHERE {}", projects::ACTIVE),
        &[],
    )?;
    let mut yield_to_foreground = false;
    for mut project in projects {
        let Some(mut sources) = project["sources"].as_array().cloned() else {
            continue;
        };
        for source in &mut sources {
            if projects::foreground_waiting()? {
                yield_to_foreground = true;
                break;
            }
            let Some(id) = source["id"].as_str() else {
                continue;
            };
            let Some((key, _)) = pin_candidate(&project, source) else {
                continue;
            };
            let body = pin_request(&project["id"], id, &key);
            // The workspace lock is held for this pass. Leave enough of the
            // foreground wait budget for a pending connect or disconnect.
            let response =
                tokio::time::timeout(std::time::Duration::from_secs(5), post_pin(body)).await;
            match response {
                Ok(response) => match pin_receipt(response, id) {
                    Ok(pin) => {
                        source["remoteKey"] = json!(pin);
                        refresh_pin_verification(source, &Value::Null);
                    }
                    Err(error) => eprintln!("source repository pin deferred: {error}"),
                },
                Err(_) => {
                    eprintln!("source repository pin deferred: service timed out");
                    yield_to_foreground = true;
                    break;
                }
            }
        }
        if project["sources"].as_array() != Some(&sources) {
            let project_id = project["id"].as_str().ok_or("Missing project")?.to_owned();
            project["sources"] = json!(sources);
            db::upsert(db, "projects", &project_id, &project_id, &project)?;
        }
        if yield_to_foreground {
            break;
        }
    }
    Ok(())
}

pub(crate) async fn post_remote_pin(owner: &str, origin: &str, body: &Value) -> Result<Value> {
    sync::api_at(owner, origin, "POST", "/v2/projects/action", Some(body)).await
}

fn pin_request(project: &Value, source_id: &str, key: &str) -> Value {
    json!({"action":"set-source-remote","projectId":project,"sourceId":source_id,"remoteKey":key})
}

fn pin_receipt(receipt: Result<Value>, source_id: &str) -> Result<String> {
    let receipt = receipt?;
    if receipt["sourceId"] == source_id {
        if let Some(key) = receipt["remoteKey"].as_str() {
            return Ok(key.to_owned());
        }
    }
    Err("Invalid source repository pin response".into())
}

/// Refresh before matching by name, including folders without any Git remote.
/// An unavailable or older service leaves the saved catalog usable offline.
async fn refresh_pin_catalog(db: &mut rusqlite::Connection) -> Result<Option<(String, String)>> {
    let owner = db::get(db, "user")?;
    let config = db::get(db, "config")?;
    let (Some(owner), Some(origin)) = (owner.as_str(), config["apiUrl"].as_str()) else {
        return Ok(None);
    };
    if !sync::api_at(owner, origin, "GET", "/v2/projects/capabilities", None)
        .await
        .is_ok_and(|capabilities| capabilities["sourceRemoteKey"] == 1)
    {
        return Ok(None);
    }
    match sync::api_at(owner, origin, "GET", projects::CATALOG_PATH, None).await {
        Ok(catalog) => projects::merge_catalog(db, &catalog)?,
        Err(error) if sync::service_error(&error) => {
            eprintln!("source repository catalog refresh deferred: {error}");
        }
        Err(error) => return Err(error),
    }
    Ok(Some((owner.to_owned(), origin.to_owned())))
}

#[tauri::command]
pub async fn connect_project_sources(
    id: String,
    paths: Vec<String>,
    source_id: Option<String>,
) -> Result<()> {
    connect_sources(id, paths, source_id, None, None).await
}
pub(crate) async fn connect_sources(
    id: String,
    paths: Vec<String>,
    source_id: Option<String>,
    context: Option<(&str, &str)>,
    sharing: Option<projects::Sharing>,
) -> Result<()> {
    if paths.is_empty() || paths.len() > 100 || (source_id.is_some() && paths.len() != 1) {
        return Err("Choose between 1 and 100 source folders".into());
    }
    // Connecting is a foreground action, often right after creating the project
    // whose first sync is already queued; ask sync to pause instead of failing.
    let lock = tauri::async_runtime::spawn_blocking(|| {
        projects::wait_for_lock(std::time::Duration::from_secs(30))
    })
    .await
    .map_err(|error| error.to_string())??;
    connect_sources_locked(id, paths, source_id, context, sharing, None, lock).await
}

/// Keep the clone's verified repository binding and the attachment under one
/// workspace lock. Cloning supplies exactly one finished checkout and source.
pub(crate) async fn connect_sources_locked(
    id: String,
    paths: Vec<String>,
    source_id: Option<String>,
    context: Option<(&str, &str)>,
    sharing: Option<projects::Sharing>,
    binding: Option<(&str, u64)>,
    _lock: fs::File,
) -> Result<()> {
    let mut db = db::open()?;
    if let Some((user, service)) = context {
        if db::get(&db, "user")? != user || db::get(&db, "config")?["apiUrl"] != service {
            return Err("Account or service changed; reopen repository setup".into());
        }
    }
    let roots = paths
        .iter()
        .map(|path| canonical(path))
        .collect::<Result<Vec<_>>>()?;
    let home = home_folder();
    for root in &roots {
        if let Some(reason) = too_broad(root, home.as_deref()) {
            return Err(format!(
                "{} can't be a source folder. {reason} Choose the project's own folder instead.",
                root.display()
            ));
        }
    }
    let pin_scope = refresh_pin_catalog(&mut db).await?;
    let mut project = crate::governance::project(&db, &id)?;
    let pending_key = format!("source-registration:{id}");
    let pending = db::get(&db, &pending_key)?;
    let mut sources = project["sources"]
        .as_array()
        .cloned()
        .ok_or("Refresh this project or run the project-source migration")?;
    if source_id.as_ref().is_some_and(|id| {
        sources
            .iter()
            .any(|source| source["id"] == *id && !source["removedAt"].is_null())
    }) {
        return Err("This source folder was removed from the project".into());
    }
    if let Some((repository_id, revision)) = binding {
        let same_link = sources.iter().any(|source| {
            source["id"].as_str() == source_id.as_deref()
                && crate::repositories::binding_matches(source, repository_id, revision)
        });
        if !same_link {
            return Err("Repository link changed. Review this source before connecting.".into());
        }
    }
    let mut used = BTreeSet::new();
    for root in &roots {
        if !used.insert(root.clone()) {
            return Err("The same folder was selected more than once".into());
        }
        for other in db::rows(&db, "SELECT value FROM projects", &[])? {
            for view in views(&other) {
                if let Some(path) = view["path"].as_str() {
                    if other["id"] == id && Path::new(path) == root {
                        if source_id.as_ref().is_some_and(|id| view["sourceId"] != *id) {
                            return Err("This folder is already connected to another source".into());
                        }
                        continue;
                    }
                    if root.starts_with(path) || Path::new(path).starts_with(root) {
                        return Err("A connected source folder already covers this location".into());
                    }
                }
            }
        }
        if roots
            .iter()
            .any(|other| other != root && (root.starts_with(other) || other.starts_with(root)))
        {
            return Err("Choose independent folders; selected folders overlap".into());
        }
    }
    let mut additions = Vec::new();
    let mut newly_connected = Vec::new();
    for root in roots {
        let name = root
            .file_name()
            .ok_or("Choose a named folder")?
            .to_string_lossy()
            .to_string();
        let remote = remote_keys(&root);
        let mut skipped_pinned = false;
        let exact = sources.iter().position(|source| {
            source["path"]
                .as_str()
                .is_some_and(|path| Path::new(path) == root)
        });
        let candidates: Vec<_> = if let (None, Some(exact)) = (source_id.as_ref(), exact) {
            vec![exact]
        } else {
            sources
                .iter()
                .enumerate()
                .filter(|(_, source)| {
                    if !source["removedAt"].is_null() {
                        return false;
                    }
                    source_id.as_ref().map_or_else(
                        || {
                            let named = source["name"] == name
                                && source["path"]
                                    .as_str()
                                    .is_none_or(|path| Path::new(path) == root);
                            // A same-named folder of another repository is not this source.
                            let other_repository = check_pin(source, &remote).is_err();
                            skipped_pinned |= named && other_repository;
                            named && !other_repository
                        },
                        |id| source["id"] == *id,
                    )
                })
                .map(|(index, _)| index)
                .collect()
        };
        let index = match candidates.as_slice() {
            [index] => *index,
            [] if source_id.is_some() => return Err("Repository no longer belongs to this project; refresh and try again".into()),
            [] if skipped_pinned => return Err(format!("“{name}” is a different Git repository from the project's “{name}” source. Choose that repository's checkout, or use Locate folder beside the intended source.")),
            [] => {
                let source_id = registration_id(&sources, &pending, &root);
                let source = json!({"id":source_id,"name":name});
                additions.push(source.clone()); sources.push(source); sources.len()-1
            },
            _ => return Err("Several repositories have this name. Use Locate folder beside the intended repository".into()),
        };
        if sources[index]["path"]
            .as_str()
            .is_some_and(|old| Path::new(old) != root)
        {
            return Err("Disconnect this repository before changing its folder".into());
        }
        check_pin(&sources[index], &remote)?;

        if sources[index]["path"].is_null() {
            if let Some(source) = sources[index]["id"].as_str() {
                newly_connected.push(source.to_owned());
            }
        }
        sources[index]["path"] = json!(root);
        sources[index]["folderIdentity"] = json!(indexer::folder_identity(&root)?);
    }
    // Validate every selected folder before registration, hooks, or pinning.
    for source in &sources {
        if source["path"]
            .as_str()
            .is_some_and(|path| used.contains(Path::new(path)))
        {
            validate(&source_view(&project, source))?;
        }
    }
    if !additions.is_empty() {
        db::set(
            &db,
            &pending_key,
            &json!(sources
                .iter()
                .filter(|source| additions
                    .iter()
                    .any(|addition| addition["id"] == source["id"]))
                .collect::<Vec<_>>()),
        )?;
        sync::api(
            "POST",
            "/v2/projects/sources",
            Some(&json!({"projectId":id,"sources":additions})),
        )
        .await?;
    }
    for source in &mut sources {
        if source["path"]
            .as_str()
            .is_some_and(|path| used.contains(Path::new(path)))
        {
            refresh_pin_verification(source, &Value::Null);
        }
    }
    for source in &sources {
        if let Some(path) = source["path"]
            .as_str()
            .filter(|path| used.contains(Path::new(path)))
        {
            native::Hooks::install(Path::new(path))?;
        }
    }
    project["sources"] = json!(sources);
    let previous_sharing = project["sharing"].clone();
    if let Some(sharing) = sharing {
        project["sharing"] = json!(sharing);
        crate::env::clear();
    }
    project
        .as_object_mut()
        .ok_or("Invalid project")?
        .remove("path");
    project
        .as_object_mut()
        .ok_or("Invalid project")?
        .remove("folderIdentity");
    {
        let tx = db.transaction().map_err(|error| error.to_string())?;
        db::upsert(&tx, "projects", &id, &id, &project)?;
        db::set(&tx, &pending_key, &Value::Null)?;
        if newly_connected.is_empty() {
            SyncQueue::request(&tx, &id, Priority::User, "project")?;
        } else {
            let at = chrono::Utc::now().timestamp_millis() + NEW_FOLDER_DELAY_MS;
            db::set(&tx, &format!("firstScan:{id}"), &Value::Null)?;
            for source in &newly_connected {
                db::set(&tx, &sync_after_key(&id, source), &json!(at))?;
            }
            SyncQueue::request_at(&tx, &id, Priority::User, "new folder", at)?;
        }
        if pin_scope.is_some() && !newly_connected.is_empty() {
            // Reconcile before the delayed scan, including plain folders that
            // could not submit a candidate if another Mac pinned concurrently.
            SyncQueue::request(
                &tx,
                crate::sync_queue::WORKSPACE,
                Priority::User,
                "source repository pin",
            )?;
        }
        tx.commit().map_err(|error| error.to_string())?;
    }

    // Claim the pin only after the checkout, hooks and local binding have
    // passed validation and saved. A batch is already saved as one unit and
    // workspace sync backfills it, keeping any later conflicting path paused.
    if used.len() == 1 {
        if let (Some((owner, origin)), [source_id]) = (&pin_scope, newly_connected.as_slice()) {
            finish_connection_pin(
                &mut db,
                &mut project,
                source_id,
                previous_sharing,
                owner,
                origin,
            )
            .await?;
        }
    }
    Ok(())
}

async fn finish_connection_pin(
    db: &mut rusqlite::Connection,
    project: &mut Value,
    source_id: &str,
    previous_sharing: Value,
    owner: &str,
    origin: &str,
) -> Result<()> {
    let Some(index) = project["sources"]
        .as_array()
        .and_then(|sources| sources.iter().position(|source| source["id"] == source_id))
    else {
        return Ok(());
    };
    let Some((key, keys)) = pin_candidate(project, &project["sources"][index]) else {
        return Ok(());
    };
    let body = pin_request(&project["id"], source_id, &key);
    let source = &mut project["sources"][index];
    let result = match pin_receipt(post_remote_pin(owner, origin, &body).await, source_id) {
        Ok(pin) => {
            let matches = matches_pin(&pin, &source["repository"], &keys);
            source["remoteKey"] = json!(pin);
            if matches {
                refresh_pin_verification(source, &Value::Null);
                Ok(())
            } else {
                Err(PIN_MISMATCH.into())
            }
        }
        Err(error) if error.starts_with("409:") || error.starts_with("403:") => Err(error),
        Err(error) => {
            eprintln!("source repository pin deferred: {error}");
            return Ok(());
        }
    };
    let project_id = project["id"].as_str().ok_or("Missing project")?.to_owned();
    let tx = db.transaction().map_err(|error| error.to_string())?;
    if result.is_err() {
        let source = &mut project["sources"][index];
        source["path"] = Value::Null;
        source["folderIdentity"] = Value::Null;
        source["verifiedRemoteKey"] = Value::Null;
        project["sharing"] = previous_sharing;
        clear_sync_after(&tx, &project_id, source_id)?;
    }
    db::upsert(&tx, "projects", &project_id, &project_id, project)?;
    tx.commit().map_err(|error| error.to_string())?;
    result
}

// Use the requested snapshot first. Older queued requests can be attributed
// through their indexed resource or saved binding.
pub(crate) const OUTBOX_SOURCE: &str = "coalesce(
    json_extract(o.value,'$.resource.sourceId'),
    json_extract(o.value,'$.sourceId'),
    json_extract(o.value,'$.sourceSnapshot.sourceId'),
    (SELECT json_extract(r.value,'$.sourceId') FROM resources r WHERE r.project=o.project AND r.id=json_extract(o.value,'$.resourceId')),
    (SELECT json_extract(b.value,'$.base.sourceId') FROM bindings b WHERE b.project=o.project AND b.id=json_extract(o.value,'$.resourceId'))
)";

/// Queued uploads that may belong to `source`. A change whose source cannot be
/// determined counts too, so disconnecting never strands unsent work.
pub(crate) fn queued_for_source(
    db: &rusqlite::Connection,
    project: &str,
    source: &str,
) -> Result<i64> {
    db.query_row(
        &format!(
            "SELECT count(*) FROM outbox o WHERE o.project=?1 AND coalesce({OUTBOX_SOURCE},?2)=?2"
        ),
        [project, source],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

#[tauri::command]
pub async fn disconnect_project_source(id: String, source_id: String) -> Result<()> {
    // A running sync pauses for this instead of failing it.
    let _lock = projects::wait_for_lock_async(projects::FOREGROUND_LOCK_WAIT).await?;
    let db = db::open()?;
    let mut project = crate::governance::project(&db, &id)?;
    let source = project["sources"]
        .as_array_mut()
        .and_then(|sources| sources.iter_mut().find(|source| source["id"] == source_id))
        .ok_or("Repository not found")?;
    // Only this folder's unsent changes matter; other folders keep syncing.
    match queued_for_source(&db, &id, &source_id)? {
        0 => {}
        1 => return Err("This folder has 1 change waiting to upload. Let it sync, then disconnect the folder.".into()),
        count => return Err(format!("This folder has {count} changes waiting to upload. Let them sync, then disconnect the folder.")),
    }
    source["path"] = Value::Null;
    source["folderIdentity"] = Value::Null;
    source["verifiedRemoteKey"] = Value::Null;
    db::upsert(&db, "projects", &id, &id, &project)?;
    clear_sync_after(&db, &id, &source_id)?;
    db.execute(
        &format!(
            "DELETE FROM bindings WHERE project=? AND json_extract(value,'$.base.sourceId')=?{}",
            crate::pi_sessions::KEEP_COPY_BINDINGS
        ),
        [id, source_id],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

#[cfg(test)]
mod folder_state_tests {
    use super::*;

    #[test]
    fn removed_registration_ids_are_never_reused_for_the_same_folder() {
        let root = Path::new("/fixture/repository");
        let pending = json!([{"id":"removed-id","path":root}]);
        let removed = vec![json!({"id":"removed-id","removedAt":"2026-11-13T00:00:00Z"})];
        let next = registration_id(&removed, &pending, root);
        assert_ne!(next, "removed-id");
        assert!(Uuid::parse_str(&next).is_ok());
        assert_eq!(
            registration_id(&[json!({"id":"removed-id"})], &pending, root),
            "removed-id"
        );
    }

    #[test]
    fn whole_disks_accounts_and_system_areas_are_refused_as_source_folders() {
        let home = Path::new("/Users/alex");
        for broad in [
            "/",
            "/Users",
            "/Users/alex",
            "/Users/alex/Library",
            "/Users/alex/Library/Application Support",
            "/Volumes/Backup",
            "/System/Library",
            "/Library",
            "/Applications",
            "/private",
            "/private/etc",
            "/private/var",
        ] {
            assert!(too_broad(Path::new(broad), Some(home)).is_some(), "{broad}");
        }
        for project in [
            "/Users/alex/code/api",
            "/Users/alex/Documents/notes",
            "/Volumes/Backup/code/api",
            "/private/var/folders/xy/T/fixture",
            "/Users/sam/code/api",
        ] {
            assert_eq!(too_broad(Path::new(project), Some(home)), None, "{project}");
        }
    }

    #[cfg(target_os = "macos")]
    #[test]
    fn canonical_system_aliases_and_mounts_outside_volumes_are_refused() {
        for alias in ["/etc", "/var", "/dev"] {
            let root = canonical(alias).unwrap();
            assert!(too_broad(&root, None).is_some(), "{alias}: {root:?}");
        }
        let project = tempfile::tempdir().unwrap();
        let root = project.path().canonicalize().unwrap();
        assert_eq!(too_broad(&root, None), None);
    }

    #[test]
    fn folder_states_follow_native_path_and_identity_validation() {
        let root = std::env::temp_dir().join(format!("orka-folder-state-{}", Uuid::new_v4()));
        fs::create_dir(&root).unwrap();
        let source = json!({"path":root,"folderIdentity":indexer::folder_identity(&root).unwrap()});
        assert_eq!(folder_state(&json!({"path":null})), "locate");
        assert_eq!(folder_state(&source), "connected");
        let mut replaced = source.clone();
        replaced["folderIdentity"] = json!("unrecognized-folder-identity");
        assert_eq!(folder_state(&replaced), "reconnect");
        fs::remove_dir(&root).unwrap();
        assert_eq!(folder_state(&source), "reconnect");
    }
}
