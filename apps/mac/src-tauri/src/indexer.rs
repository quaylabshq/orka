use crate::{
    db::{self, Result},
    history, memory_context, native, packages, plans, scan_cache,
    sync_queue::{Priority, SyncQueue},
};
use rusqlite::params;
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    collections::{BTreeMap, BTreeSet, HashMap, HashSet},
    fs,
    io::Read,
    path::{Path, PathBuf},
    time::{Duration, Instant},
};
use uuid::Uuid;
use walkdir::WalkDir;
pub const SKILL_MIRROR_REVIEW: &str = "Skill copies differ between .agents/skills and .claude/skills. Review and align them to resume this skill's sync; both local copies are preserved.";
pub fn folder_identity(path: &Path) -> Result<String> {
    use std::os::unix::fs::MetadataExt;
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    #[cfg(target_os = "macos")]
    if let Some(volume) = volume_identity(path) {
        return Ok(format!("volume:{volume}:{}", meta.ino()));
    }
    Ok(format!("{}:{}", meta.dev(), meta.ino()))
}

#[cfg(target_os = "macos")]
fn volume_identity(path: &Path) -> Option<String> {
    use objc2_foundation::{NSString, NSURLVolumeUUIDStringKey, NSURL};
    objc2::rc::autoreleasepool(|_| {
        let url = NSURL::fileURLWithPath(&NSString::from_str(path.to_str()?));
        let mut value = None;
        // This resource key returns an NSString when the volume has a persistent UUID.
        unsafe { url.getResourceValue_forKey_error(&mut value, NSURLVolumeUUIDStringKey) }.ok()?;
        let volume = value?.downcast::<NSString>().ok()?.to_string();
        (!volume.is_empty()).then_some(volume)
    })
}

pub fn folder_identity_matches(path: &Path, expected: &str) -> Result<bool> {
    if expected.starts_with("volume:") {
        return Ok(folder_identity(path)? == expected);
    }
    use std::os::unix::fs::MetadataExt;
    let meta = fs::metadata(path).map_err(|e| e.to_string())?;
    Ok(format!("{}:{}", meta.dev(), meta.ino()) == expected)
}
#[cfg(test)]
pub fn claude_memory(root: &Path) -> Result<PathBuf> {
    Ok(ClaudeMemory::resolve(root)?.native)
}

pub fn claude_memory_target(root: &Path) -> Result<PathBuf> {
    let root = fs::canonicalize(root).map_err(|e| e.to_string())?;
    let base = legacy_claude_memory(&root)?;
    check_memory_directory(&base)?;
    Ok(base)
}

pub fn claude_memory_base(root: &Path, path: &Path) -> Result<PathBuf> {
    let root = fs::canonicalize(root).map_err(|e| e.to_string())?;
    let legacy = legacy_claude_memory(&root)?;
    let default = claude_memory_for(&claude_memory_root(&root), true)?;
    let base = [legacy, default]
        .into_iter()
        .find(|dir| path.starts_with(dir))
        .ok_or("Claude memory outside the default locations is read-only")?;
    check_memory_directory(&base)?;
    Ok(base)
}

// Check from the config directory, not just the memory leaf: a symlink in
// projects/<key> can otherwise redirect a write or delete outside Claude home.
fn check_memory_directory(base: &Path) -> Result<()> {
    let home = native::claude_home()?;
    if fs::symlink_metadata(&home).is_ok_and(|meta| !meta.is_dir()) {
        return Err("Claude config directory is a symlink or file".into());
    }
    let relative = base
        .strip_prefix(&home)
        .map_err(|_| "Invalid Claude memory directory")?;
    let mut current = home;
    for component in relative.components() {
        current.push(component);
        match fs::symlink_metadata(&current) {
            Ok(meta) if !meta.is_dir() => {
                return Err("Claude memory directory contains a symlink or file".into())
            }
            Ok(_) => (),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => break,
            Err(e) => return Err(e.to_string()),
        }
    }
    Ok(())
}

fn legacy_claude_memory(root: &Path) -> Result<PathBuf> {
    if root.to_string_lossy().chars().count() > 255 {
        // The old key could not be created on APFS.
        return claude_memory_for(root, true);
    }
    claude_memory_for(root, false)
}

pub fn claude_memory_read_base(root: &Path, path: &Path) -> Result<PathBuf> {
    let memory = ClaudeMemory::resolve(root)?;
    let base = [memory.legacy, memory.native]
        .into_iter()
        .find(|base| path.starts_with(base))
        .ok_or("Path is outside the Claude memory directories")?;
    if base.starts_with(native::claude_home()?) {
        check_memory_directory(&base)?;
    }
    Ok(base)
}

fn claude_memory_for(project: &Path, native_encoding: bool) -> Result<PathBuf> {
    let path = project.to_string_lossy();
    let mut encoded = if native_encoding {
        path.encode_utf16()
            .map(|c| {
                u8::try_from(c)
                    .ok()
                    .filter(u8::is_ascii_alphanumeric)
                    .map_or('-', char::from)
            })
            .collect::<String>()
    } else {
        path.replace(|c: char| !c.is_ascii_alphanumeric(), "-")
    };
    if native_encoding && encoded.len() > 200 {
        let mut hash = path
            .encode_utf16()
            .fold(0i32, |hash, c| {
                hash.wrapping_mul(31).wrapping_add(i32::from(c))
            })
            .unsigned_abs();
        let mut digits = Vec::new();
        loop {
            digits.push(char::from_digit(hash % 36, 36).expect("base 36 digit"));
            hash /= 36;
            if hash == 0 {
                break;
            }
        }
        encoded.truncate(200);
        encoded.push('-');
        encoded.extend(digits.into_iter().rev());
    }
    Ok(native::claude_home()?
        .join("projects")
        .join(encoded)
        .join("memory"))
}

struct ClaudeMemory {
    native: PathBuf,
    legacy: PathBuf,
}

impl ClaudeMemory {
    fn resolve(root: &Path) -> Result<Self> {
        let root = fs::canonicalize(root).map_err(|e| e.to_string())?;
        let checkout = claude_memory_root(&root);
        let native = match claude_memory_setting(
            &root,
            &checkout,
            Path::new("/Library/Application Support/ClaudeCode"),
        )? {
            Some(custom) => fs::canonicalize(&custom).unwrap_or(custom),
            None => {
                let name = std::env::var_os("CLAUDE_CONFIG_DIR")
                    .and_then(|_| std::env::var_os("CLAUDE_CODE_PROJECT_DIR_NAME"));
                if let Some(name) = name.filter(|name| {
                    let path = Path::new(name);
                    path.components().count() == 1
                        && matches!(
                            path.components().next(),
                            Some(std::path::Component::Normal(_))
                        )
                }) {
                    native::claude_home()?
                        .join("projects")
                        .join(name)
                        .join("memory")
                } else {
                    claude_memory_for(&checkout, true)?
                }
            }
        };
        let legacy = legacy_claude_memory(&root)?;
        Ok(Self { native, legacy })
    }
}

fn small_git_file(path: &Path) -> Option<String> {
    if !fs::symlink_metadata(path).ok()?.is_file() {
        return None;
    }
    let mut text = String::new();
    fs::File::open(path)
        .ok()?
        .take(8193)
        .read_to_string(&mut text)
        .ok()?;
    (text.len() <= 8192).then_some(text)
}

pub(crate) fn claude_memory_root(root: &Path) -> PathBuf {
    let home = db::home()
        .ok()
        .and_then(|home| home.canonicalize().ok().or(Some(home)));
    let Some(checkout) = root
        .ancestors()
        .take_while(|dir| !home.as_ref().is_some_and(|home| home.starts_with(dir)))
        .find(|dir| fs::symlink_metadata(dir.join(".git")).is_ok())
    else {
        return root.to_path_buf();
    };
    let dot_git = checkout.join(".git");
    if dot_git.is_dir() && dot_git.join("HEAD").is_file() {
        return checkout.to_path_buf();
    }
    let Some(pointer) = small_git_file(&dot_git) else {
        return root.to_path_buf();
    };
    let Some(gitdir) = pointer
        .trim()
        .strip_prefix("gitdir:")
        .map(str::trim)
        .filter(|p| !p.is_empty())
    else {
        return root.to_path_buf();
    };
    let Ok(gitdir) = checkout.join(gitdir).canonicalize() else {
        return root.to_path_buf();
    };
    if !gitdir.join("HEAD").is_file() {
        return root.to_path_buf();
    }
    // Submodules and separate Git directories do not have a common-dir link.
    // Linked worktrees of a bare repository have no main checkout to use.
    if let Some(common) = small_git_file(&gitdir.join("commondir"))
        .and_then(|text| gitdir.join(text.trim()).canonicalize().ok())
    {
        let matching_worktree = gitdir.parent() == Some(common.join("worktrees").as_path())
            && small_git_file(&gitdir.join("gitdir"))
                .and_then(|back| gitdir.join(back.trim()).canonicalize().ok())
                .as_deref()
                == Some(dot_git.as_path());
        if let Some(main) = common.parent().filter(|main| {
            matching_worktree
                && common.ends_with(".git")
                && common.join("HEAD").is_file()
                && !home.as_ref().is_some_and(|home| home.starts_with(main))
        }) {
            return main.to_path_buf();
        }
    }
    checkout.to_path_buf()
}

pub(crate) fn claude_memory_setting(
    root: &Path,
    checkout: &Path,
    managed: &Path,
) -> Result<Option<PathBuf>> {
    let config = native::claude_home()?;
    let mut policies: Vec<_> = fs::read_dir(managed.join("managed-settings.d"))
        .into_iter()
        .flatten()
        .filter_map(std::result::Result::ok)
        .map(|entry| entry.path())
        .filter(|path| {
            path.extension().is_some_and(|ext| ext == "json")
                && path
                    .file_name()
                    .is_some_and(|name| !name.as_encoded_bytes().starts_with(b"."))
        })
        .collect();
    policies.sort_unstable();
    if let Some(custom) = policies
        .iter()
        .rev()
        .cloned()
        .chain([managed.join("managed-settings.json")])
        .find_map(|path| memory_setting_in(&path).ok().flatten())
    {
        return Ok(Some(custom));
    }
    let trust_file = if std::env::var_os("CLAUDE_CONFIG_DIR").is_some() {
        config.join(".claude.json")
    } else {
        db::home()?.join(".claude.json")
    };
    let trust = fs::read(trust_file)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
        .unwrap_or_default();
    let trusted = |path: &Path| {
        trust["projects"][path.to_string_lossy().as_ref()]["hasTrustDialogAccepted"] == true
    };
    for (path, name) in [
        (checkout, "settings.local.json"),
        (root, "settings.local.json"),
        (root, "settings.json"),
    ] {
        if trusted(path) {
            if let Some(custom) = memory_setting_in(&path.join(".claude").join(name))? {
                return Ok(Some(custom));
            }
        }
    }
    Ok(memory_setting_in(&config.join("settings.json"))
        .ok()
        .flatten())
}

fn memory_setting_in(path: &Path) -> Result<Option<PathBuf>> {
    if !path.try_exists().map_err(|e| e.to_string())? {
        return Ok(None);
    }
    let value: Value = serde_json::from_slice(&fs::read(path).map_err(|e| e.to_string())?)
        .map_err(|e| e.to_string())?;
    let Some(custom) = value["autoMemoryDirectory"].as_str() else {
        return Ok(None);
    };
    let p = custom
        .strip_prefix("~/")
        .map(|rest| db::home().map(|home| home.join(rest.trim_start_matches('/'))))
        .transpose()?
        .unwrap_or(PathBuf::from(custom));
    if !p.is_absolute() || p.components().any(|c| c == std::path::Component::ParentDir) {
        return Err("Claude auto-memory directory must be absolute".into());
    }
    Ok(Some(p))
}
#[derive(Default)]
struct ClaudeMemoryScan {
    sources: BTreeMap<String, Result<ClaudeMemory>>,
    owners: BTreeMap<PathBuf, (u8, String)>,
}

impl ClaudeMemoryScan {
    fn new(project: &Value) -> Self {
        let mut scan = Self::default();
        for source in crate::sources::views(project) {
            let Some(path) = source["path"].as_str() else {
                continue;
            };
            let id = source["sourceId"].as_str().unwrap_or("").to_owned();
            let memory = ClaudeMemory::resolve(Path::new(path));
            if let Ok(memory) = &memory {
                // Registered repository identity is shared by Macs even when
                // their connected folders differ. Include disconnected pins.
                let pinned = source["repository"]["id"].as_str().and_then(|repository| {
                    project["sources"]
                        .as_array()?
                        .iter()
                        .filter(|other| other["repository"]["id"] == repository)
                        .filter_map(|other| other["id"].as_str())
                        .min()
                });
                let priority = if pinned.is_some() {
                    0
                } else if memory.native == memory.legacy {
                    1
                } else {
                    2
                };
                let candidate = (priority, pinned.unwrap_or(&id).to_owned());
                let owner = scan
                    .owners
                    .entry(memory.native.clone())
                    .or_insert_with(|| candidate.clone());
                if candidate < *owner {
                    *owner = candidate;
                }
            }
            scan.sources.insert(id, memory);
        }
        scan
    }

    fn permits_untracked(
        &self,
        db: &rusqlite::Connection,
        project: &Value,
        directory: &Path,
    ) -> Result<bool> {
        let Some((_, candidate)) = self.owners.get(directory) else {
            return Ok(true);
        };
        let id = project["sourceId"].as_str().unwrap_or("");
        let project_id = project["id"].as_str().ok_or("Missing project")?;
        let key = format!(
            "claude-memory-owner:{project_id}:{}",
            db::digest(directory.as_os_str().as_encoded_bytes())
        );
        let owner = db::get(db, &key)?;
        if let Some(owner) = owner.as_str() {
            return Ok(owner == id || (owner.is_empty() && id == project_id));
        }
        if candidate != id {
            return Ok(false);
        }
        // Do not hand off a shared directory when its collector disappears.
        // The source ID is part of the server resource identity.
        db::set(db, &key, &json!(id))?;
        Ok(true)
    }
}

pub fn resource_id(project: &str, kind: &str, path: &str) -> String {
    Uuid::new_v5(
        &Uuid::NAMESPACE_URL,
        format!("orka:{project}:{kind}:{path}").as_bytes(),
    )
    .to_string()
}

pub fn scoped_resource_id(
    db: &rusqlite::Connection,
    project: &Value,
    kind: &str,
    path: &str,
) -> Result<String> {
    let project_id = project["id"].as_str().ok_or("Missing project")?;
    if let Some(resource) = db::rows(db,"SELECT value FROM resources WHERE project=? AND json_extract(value,'$.kind')=? AND json_extract(value,'$.logicalPath')=? AND coalesce(json_extract(value,'$.sourceId'),'')=?", &[&project_id,&kind,&path,&project["sourceId"].as_str().unwrap_or("")])?.first() {
        return Ok(resource["resourceId"].as_str().ok_or("Missing resource ID")?.into());
    }
    crate::sources::resource_id(project, kind, path)
}
pub(crate) fn has_git_repository(path: &Path) -> bool {
    path.ancestors()
        .any(|directory| fs::symlink_metadata(directory.join(".git")).is_ok())
}

fn unversioned_instruction_files(root: &Path) -> Result<BTreeSet<PathBuf>> {
    let filter_root = root.to_path_buf();
    let walker = ignore::WalkBuilder::new(root)
        .hidden(false)
        .ignore(false)
        .require_git(false)
        .current_dir(root)
        .filter_entry(move |entry| {
            entry
                .path()
                .strip_prefix(&filter_root)
                .is_ok_and(memory_context::discoverable)
                && !(entry.file_type().is_some_and(|kind| kind.is_dir())
                    && fs::symlink_metadata(entry.path().join(".git")).is_ok())
        })
        .build();
    let mut files = BTreeSet::new();
    for entry in walker {
        let entry = entry.map_err(|e| e.to_string())?;
        if let Some(error) = entry.error() {
            return Err(error.to_string());
        }
        if entry.file_type().is_some_and(|kind| kind.is_file())
            && matches!(
                entry.file_name().to_str(),
                Some("AGENTS.md" | "AGENTS.override.md" | "CLAUDE.md")
            )
        {
            files.insert(
                entry
                    .path()
                    .strip_prefix(root)
                    .map_err(|e| e.to_string())?
                    .to_path_buf(),
            );
        }
    }
    Ok(files)
}

fn git_instruction_allowed(path: &Path) -> Result<Option<bool>> {
    let parent = path
        .parent()
        .and_then(|parent| parent.ancestors().find(|directory| directory.is_dir()))
        .ok_or("Missing instruction folder")?;
    if !has_git_repository(parent) {
        return Ok(None);
    }
    let mut command = std::process::Command::new("git");
    for (key, _) in std::env::vars_os() {
        if key.to_string_lossy().starts_with("GIT_") {
            command.env_remove(key);
        }
    }
    let output = command
        .arg("-C")
        .arg(parent)
        .args(["check-ignore", "--quiet", "--"])
        .arg(path)
        .output()
        .map_err(|e| e.to_string())?;
    match output.status.code() {
        Some(0) => Ok(Some(false)),
        Some(1) => Ok(Some(true)),
        _ => Err(format!(
            "Cannot verify Git ignore rules for {}",
            path.display()
        )),
    }
}

pub(crate) fn instruction_files(root: &Path) -> Result<BTreeSet<PathBuf>> {
    let unversioned = if has_git_repository(root) {
        BTreeSet::new()
    } else {
        unversioned_instruction_files(root)?
    };
    let mut files = BTreeSet::new();
    for entry in WalkDir::new(root)
        .follow_links(false)
        .into_iter()
        .filter_entry(|entry| {
            entry
                .path()
                .strip_prefix(root)
                .is_ok_and(memory_context::discoverable)
        })
    {
        let entry = entry.map_err(|e| e.to_string())?;
        if !entry.file_type().is_file()
            || !matches!(
                entry.file_name().to_str(),
                Some("AGENTS.md" | "AGENTS.override.md" | "CLAUDE.md")
            )
        {
            continue;
        }
        let relative = entry.path().strip_prefix(root).map_err(|e| e.to_string())?;
        if !git_instruction_allowed(entry.path())?.unwrap_or_else(|| unversioned.contains(relative))
        {
            continue;
        }
        files.insert(relative.to_path_buf());
    }
    Ok(files)
}

pub(crate) fn instruction_allowed(
    root: &Path,
    relative: &Path,
    instructions: &BTreeSet<PathBuf>,
) -> Result<bool> {
    packages::safe_relative(relative.to_str().ok_or("Invalid instruction path")?)?;
    let path = root.join(relative);
    Ok(memory_context::discoverable(relative)
        && if path.try_exists().map_err(|error| error.to_string())? {
            instructions.contains(relative)
        } else {
            git_instruction_allowed(&path)?.unwrap_or(true)
        })
}
pub fn manifest_hash(files: &Value) -> String {
    db::digest(files.to_string().as_bytes())
}
pub fn queue(db: &rusqlite::Connection, project: &str, path: &str, value: &Value) -> Result<()> {
    crate::projects::require_sharing(db, project, crate::projects::queued_kind(path, value))?;
    db.execute(
        "INSERT INTO outbox VALUES(?,?,?,?,NULL)",
        params![
            value["id"].as_str().ok_or("Missing request ID")?,
            project,
            path,
            value.to_string()
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

const HELD_CAPTURE: &str = "heldCapture:";

/// The sidecar that marks an outbox row as captured while its project was
/// deleted and not yet sent. It lives in `meta`, not in the request: the push
/// contract rejects unknown fields and hashes the body for retries, and older
/// clients send queued values unchanged, so a field in the row would break a
/// downgrade. A row without it is an ordinary outbox row.
pub(crate) fn held_capture_key(id: &str) -> String {
    format!("{HELD_CAPTURE}{id}")
}

/// Returns whether the scan recorded a sendable request. When an earlier request
/// must stay intact, back up the new bytes as a draft and leave the scanner's
/// upload guards alone so a later active scan can pick up the live edit.
fn queue_scanned(
    db: &rusqlite::Connection,
    project: &Value,
    value: &Value,
    paths: &[PathBuf],
) -> Result<bool> {
    let project_id = project["id"].as_str().ok_or("Missing project ID")?;
    let path = "/v2/sync/push";
    if project["captureOnly"] != true {
        queue(db, project_id, path, value)?;
        return Ok(true);
    }
    let resource = &value["resource"];
    crate::projects::require_capture(db, project_id, crate::projects::queued_kind(path, value))?;
    let id = value["id"].as_str().ok_or("Missing request ID")?;
    let resource_id = resource["resourceId"].as_str().ok_or("Missing resource")?;
    // Each skill mirror can change independently. A resource deletion has no
    // origin path and supersedes every unsent variant of that resource.
    let mirror = if resource["kind"] == "skill" {
        json!(paths.first())
    } else {
        Value::Null
    };
    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    let Some(held) = replaceable_held(&tx, project, resource_id)? else {
        crate::governance::capture(&tx, project, resource, &json!(paths))?;
        tx.commit().map_err(|e| e.to_string())?;
        return Ok(false);
    };
    let aligned_mirrors = !mirror.is_null()
        && held.iter().any(|row| {
            row["resource"] == *resource
                && (row["mirror"].is_string() && row["mirror"] != mirror
                    || row["alignedMirrors"] == 1)
        });
    let marker = json!({
        "heldCapture": true,
        "projectId": project_id,
        "resourceId": resource_id,
        "deletedAt": project["deletedAt"],
        "mirror": mirror,
        "alignedMirrors": aligned_mirrors,
    });
    let mut matching = held.iter().filter(|row| {
        mirror.is_null()
            || row["mirror"] == mirror
            || row["alignedMirrors"] == 1
            || row["resource"] == *resource
    });
    if let Some(first) = matching.next() {
        // Preserve queue order and the original base. Mint a fresh ID for the
        // changed body. The marker check prevents rewriting a released row.
        let mut value = value.clone();
        value["baseRevision"] = first["base"].clone();
        let first = first["id"].as_str().ok_or("Missing held request ID")?;
        if tx
            .execute(
                "UPDATE outbox SET id=?1,value=?2 WHERE id=?3 AND error IS NULL
                 AND EXISTS(SELECT 1 FROM meta WHERE key=?4)",
                params![id, value.to_string(), first, held_capture_key(first)],
            )
            .map_err(|e| e.to_string())?
            != 1
        {
            return Err("A held change was sent meanwhile; capture will retry".into());
        }
        release_held_capture(&tx, first)?;
        crate::sync::clear_session_copy(&tx, first)?;
        for old in matching {
            discard_held(&tx, old["id"].as_str().ok_or("Missing held request ID")?)?;
        }
    } else {
        tx.execute(
            "INSERT INTO outbox VALUES(?,?,?,?,NULL)",
            params![id, project_id, path, value.to_string()],
        )
        .map_err(|e| e.to_string())?;
    }
    db::set(&tx, &held_capture_key(id), &marker)?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(true)
}

/// Returns the current deletion's replaceable requests in queue order, or
/// None if any older, attempted, failed or rebuilding request blocks the item.
fn replaceable_held(
    db: &rusqlite::Connection,
    project: &Value,
    resource: &str,
) -> Result<Option<Vec<Value>>> {
    let project_id = project["id"].as_str().ok_or("Missing project ID")?;
    let rows = db::rows(
        db,
        "SELECT json_object('id',o.id,'path',o.path,'error',o.error,
           'base',json_extract(o.value,'$.baseRevision'),
           'resource',json_extract(o.value,'$.resource'),
           'mirror',json_extract(m.value,'$.mirror'),
           'alignedMirrors',json_extract(m.value,'$.alignedMirrors'),
           'held',json(m.value),
           'rebuilding',EXISTS(SELECT 1 FROM meta WHERE key='sessionOutboxRedaction:'||o.id))
         FROM outbox o LEFT JOIN meta m ON m.key=?2||o.id
         WHERE o.project=?3 AND (json_extract(o.value,'$.resource.resourceId')=?1
           OR json_extract(o.value,'$.resourceId')=?1)
         ORDER BY o.rowid",
        &[&resource, &HELD_CAPTURE, &project_id],
    )?;
    Ok(rows
        .iter()
        .all(|row| {
            row["path"] == "/v2/sync/push"
                && row["error"].is_null()
                && row["rebuilding"] == 0
                && held_in_deletion(&row["held"], project)
        })
        .then_some(rows))
}

fn held_in_deletion(marker: &Value, project: &Value) -> bool {
    !project["deletedAt"].is_null()
        && marker["heldCapture"] == true
        && marker["projectId"] == project["id"]
        && marker["deletedAt"] == project["deletedAt"]
}

fn discard_held(db: &rusqlite::Connection, id: &str) -> Result<()> {
    if db
        .execute(
            "DELETE FROM outbox WHERE id=?1 AND error IS NULL
         AND EXISTS(SELECT 1 FROM meta WHERE key=?2)",
            params![id, held_capture_key(id)],
        )
        .map_err(|e| e.to_string())?
        != 1
    {
        return Err("A held change was sent meanwhile; capture will retry".into());
    }
    release_held_capture(db, id)?;
    crate::sync::clear_session_copy(db, id)
}

/// A held row is about to be sent, so it may already have reached the service
/// and must never be rewritten again.
pub(crate) fn release_held_capture(db: &rusqlite::Connection, id: &str) -> Result<()> {
    db.execute("DELETE FROM meta WHERE key=?", [held_capture_key(id)])
        .map_err(|e| e.to_string())?;
    Ok(())
}

/// Drops markers whose row was sent, removed or turned into a draft elsewhere,
/// including by an older client that does not know them.
pub(crate) fn clear_orphan_held_captures(db: &rusqlite::Connection) -> Result<()> {
    db.execute(
        "DELETE FROM meta WHERE key GLOB ?1||'*' AND substr(key,length(?1)+1) NOT IN (SELECT id FROM outbox)",
        [HELD_CAPTURE],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Outbox rows eligible to send after a restore clears the project's 403s.
pub(crate) fn held_count(db: &rusqlite::Connection, project: &str) -> Result<i64> {
    db.query_row(
        "SELECT count(*) FROM outbox WHERE project=? AND (error IS NULL OR error LIKE '403:%')",
        [project],
        |row| row.get(0),
    )
    .map_err(|e| e.to_string())
}

pub fn binding(db: &rusqlite::Connection, id: &str) -> Result<Value> {
    Ok(
        db::rows(db, "SELECT value FROM bindings WHERE id=?", &[&id])?
            .into_iter()
            .next()
            .unwrap_or(json!({})),
    )
}
fn error(db: &rusqlite::Connection, source: &str, error: &str) -> Result<()> {
    db.execute(
        "INSERT INTO errors VALUES(?,?) ON CONFLICT(source) DO UPDATE SET error=excluded.error",
        params![source, error],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
struct Scanned<'a> {
    kind: &'a str,
    source: &'a str,
    logical: &'a str,
    title: &'a str,
    files: Vec<Value>,
    paths: Vec<PathBuf>,
    native_id: Option<&'a str>,
    native_parent: Option<&'a str>,
}
fn collect(
    db: &rusqlite::Connection,
    project: &Value,
    scanned: Scanned<'_>,
    seen: &mut BTreeSet<String>,
) -> Result<()> {
    let Scanned {
        kind,
        source,
        logical,
        title,
        files,
        paths,
        native_id,
        native_parent,
    } = scanned;
    if !crate::projects::sharing_allowed(project, kind) {
        return Ok(());
    }
    let project_id = project["id"].as_str().ok_or("Missing project ID")?;
    let mut id = scoped_resource_id(db, project, kind, logical)?;
    if let Some(native_id) = native_id {
        if let Some(b) = db::rows(
            db,
            // Legacy bindings predate the provider field and must keep matching.
            "SELECT value FROM bindings WHERE project=? AND json_extract(value,'$.nativeId')=? AND coalesce(json_extract(value,'$.base.sourceId'),'')=? AND (json_extract(value,'$.base.source')=? OR (? != 'pi' AND json_extract(value,'$.base.source') IS NULL))",
            &[&project_id, &native_id, &project["sourceId"].as_str().unwrap_or(""), &source, &source],
        )?
        .first()
        {
            if let Some(existing) = b["base"]["resourceId"].as_str() {
                id = existing.into();
            }
        }
    }
    let origin = if project["catalogOnly"] == true {
        crate::local_resources::origin(db, project, kind, source, logical, native_id)?
    } else {
        Value::Null
    };
    if project["catalogOnly"] == true
        && db::rows(db, "SELECT value FROM resources WHERE id=?", &[&id])?.is_empty()
    {
        if let Some(known_id) = origin["resourceId"].as_str() {
            id = known_id.to_owned();
        } else if let Some(previous) = db::rows(db,"SELECT value FROM local_resources WHERE project=? AND json_extract(value,'$.resource.kind')=? AND coalesce(json_extract(value,'$.resource.sourceId'),'')=? AND json_extract(value,'$.resource.source')=? AND (json_extract(value,'$.resource.logicalPath')=? OR (? IS NOT NULL AND json_extract(value,'$.nativeId')=?)) LIMIT 1",&[&project_id,&kind,&project["sourceId"].as_str().unwrap_or(""),&source,&logical,&native_id,&native_id])?.first() {
            id = previous["resource"]["resourceId"].as_str().ok_or("Missing resource")?.to_owned();
        }
    }
    seen.insert(id.clone());
    let mut b = binding(db, &id)?;
    let original_binding = b.clone();
    if project["catalogOnly"] == true {
        let mut resource = json!({"resourceId":id,"kind":kind,"source":source,"logicalPath":logical,"title":title,"files":files,"deleted":false});
        crate::sources::scope(project, &mut resource);
        resource["contextSources"] = if source == "pi" {
            json!([])
        } else {
            scanned_sources(db, project, logical, native_id)?
        };
        let previous = db::rows(db, "SELECT value FROM local_resources WHERE id=?", &[&id])?
            .into_iter()
            .next()
            .unwrap_or(Value::Null);
        let modified = paths
            .iter()
            .filter_map(|path| {
                fs::metadata(path)
                    .ok()
                    .and_then(|meta| meta.modified().ok())
            })
            .max()
            .map(|time| chrono::DateTime::<chrono::Utc>::from(time).to_rfc3339());
        let updated = modified
            .or_else(|| {
                (previous["resource"]["files"] == resource["files"])
                    .then(|| previous["updatedAt"].as_str().map(str::to_owned))
                    .flatten()
            })
            .unwrap_or_else(db::now);
        let published = db::rows(db, "SELECT value FROM resources WHERE id=?", &[&id])?
            .into_iter()
            .next()
            .unwrap_or(Value::Null);
        let owner = b["base"]["owner"]
            .as_str()
            .map(str::to_owned)
            .or_else(|| previous["owner"].as_str().map(str::to_owned))
            .or_else(|| published["owner"].as_str().map(str::to_owned))
            .or_else(|| origin["owner"].as_str().map(str::to_owned));
        if let Some(owner) = &owner {
            let mut known = resource.clone();
            known["owner"] = json!(owner);
            crate::local_resources::remember_origin(
                db,
                project,
                &known,
                &json!({"nativeId":native_id,"paths":paths}),
            )?;
        }
        return db::upsert(
            db,
            "local_resources",
            &id,
            project_id,
            &json!({"resource":resource,"paths":paths,"nativeId":native_id,"nativeParentId":native_parent,"discoveredAt":db::now(),"updatedAt":updated,"path":project["path"],"folderIdentity":project["folderIdentity"],"owner":owner,"generation":project["catalogGeneration"]}),
        );
    }
    if kind == "session" {
        let fork = crate::session_forks::info(db, &id)?;
        if let (Some(parent), Some(destination), Some(native_id)) = (
            fork["parentId"].as_str(),
            fork["destination"].as_str(),
            native_id,
        ) {
            b["base"]["logicalPath"] =
                json!(format!("{source}/forks/{parent}/{destination}/{native_id}"));
        }
    }
    if project["governed"] == true {
        let existing = db::rows(db, "SELECT value FROM resources WHERE id=?", &[&id])?
            .into_iter()
            .next()
            .unwrap_or(Value::Null);
        let mut local = json!({"resourceId":id,"kind":kind,"source":source,"logicalPath":logical,"title":title,"files":files,"deleted":files.is_empty()});
        crate::sources::scope(project, &mut local);
        if kind == "session" || kind == "plan" {
            local["contextSources"] = scanned_sources(db, project, logical, native_id)?;
        }
        if kind == "memory"
            || kind == "skill"
            || (existing["access"]["mode"]
                .as_str()
                .is_some_and(|m| m != "publish"))
        {
            // Acknowledged deletions reach the cache before native materialization.
            // The unchanged installed base is not a new private edit during that scan.
            if existing["deleted"] == true
                && b["base"]["deleted"] != true
                && b["base"]["revision"]
                    .as_u64()
                    .zip(existing["revision"].as_u64())
                    .is_some_and(|(base, current)| base < current)
                && manifest_hash(&json!(files)) == manifest_hash(&b["base"]["files"])
            {
                return Ok(());
            }
            if !files.is_empty()
                && manifest_hash(&json!(files)) != manifest_hash(&existing["files"])
            {
                let draft = crate::governance::capture(db, project, &local, &json!(paths))?;
                crate::context_sharing::queue_automatic(db, project, &draft)?;
                if !b.is_null() && b.is_object() {
                    b["installationState"] = json!("locally_modified");
                    db::upsert(db, "bindings", &id, project_id, &b)?;
                }
            }
            return Ok(());
        }
    }
    if kind == "session"
        && !paths.is_empty()
        && b["nativeId"].as_str() == native_id
        && !b["paths"].is_null()
        && b["paths"] != json!(&paths)
    {
        b["paths"] = json!(&paths);
        if b["lastSeenHash"] == manifest_hash(&json!(&files)) {
            b["guards"] = json!(vec![b["lastSeenHash"].clone(); paths.len()]);
        }
        db::upsert(db, "bindings", &id, project_id, &b)?;
    }
    if b["needsCopy"] == true {
        return Ok(());
    }
    // Archiving a teammate's local copy does not edit or delete their shared session.
    if kind == "session"
        && files.is_empty()
        && b["base"]["owner"].is_string()
        && b["base"]["owner"] != db::get(db, "user")?
    {
        return Ok(());
    }
    let files = json!(files);
    let hash = manifest_hash(&files);
    if kind == "session"
        && b["base"]["owner"].is_string()
        && b["base"]["owner"] != db::get(db, "user")?
        && b["lastSeenHash"].as_str().is_some_and(|last| last != hash)
    {
        b["needsCopy"] = json!(true);
        db::upsert(db, "bindings", &id, project_id, &b)?;
        SyncQueue::request(db, project_id, Priority::Local, "indexer")?;
        return Ok(());
    }
    let deleted = files.as_array().is_none_or(|a| a.is_empty());
    let base_revision = b["base"]["revision"].as_u64().unwrap_or(0);
    let pending:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM outbox WHERE json_extract(value,'$.resource.resourceId')=? OR json_extract(value,'$.resourceId')=?)",params![id,id],|r|r.get(0)).map_err(|e|e.to_string())?;
    let captured_mirror = if project["captureOnly"] == true && kind == "skill" {
        paths.first().and_then(|origin| {
            b["paths"]
                .as_array()?
                .iter()
                .position(|path| path.as_str() == origin.to_str())
        })
    } else {
        None
    };
    let last = captured_mirror
        .and_then(|index| b["guards"][index].as_str())
        .or_else(|| b["lastSeenHash"].as_str())
        .unwrap_or("");
    let changed = hash != last;
    if b["paths"].is_null() {
        b["paths"] = json!(&paths);
        b["base"] = json!({"resourceId":id,"revision":0,"files":[],"kind":kind,"source":source,"logicalPath":logical,"title":title,"owner":db::get(db,"user")?,"projectId":project_id,"deleted":false});
        crate::sources::scope(project, &mut b["base"]);
        if let Some(n) = native_id {
            b["nativeId"] = json!(n);
        }
    }
    if changed && (!pending || project["captureOnly"] == true) {
        let title = if kind == "plan" {
            title
        } else {
            b["base"]["title"].as_str().unwrap_or(title)
        };
        let title = if kind == "session" {
            std::borrow::Cow::Owned(crate::session_redaction::SessionRedactor::text(title))
        } else {
            std::borrow::Cow::Borrowed(title)
        };
        let mut input = json!({"resourceId":id,"kind":kind,"source":source,"logicalPath":b["base"]["logicalPath"].as_str().unwrap_or(logical),"title":title,"files":files,"deleted":deleted});
        crate::sources::scope(project, &mut input);
        if project["governed"] == true && (kind == "session" || kind == "plan") {
            input["contextSources"] = scanned_sources(db, project, logical, native_id)?;
            if input["contextSources"].is_null() {
                input
                    .as_object_mut()
                    .ok_or("Invalid resource")?
                    .remove("contextSources");
            }
        }
        let change = json!({"version":2,"id":Uuid::new_v4().to_string(),"projectId":project_id,"deviceId":db::device(db)?,"baseRevision":base_revision,"resource":input});
        if !queue_scanned(db, project, &change, &paths)? {
            return db::upsert(db, "bindings", &id, project_id, &b);
        }
        let mut guards = crate::sync::live_hash(
            &b,
            kind,
            Path::new(project["path"].as_str().ok_or("Connect a folder")?),
        )?;
        if let Some(origin_index) = captured_mirror {
            let base = manifest_hash(&b["base"]["files"]);
            for (index, guard) in guards.iter_mut().enumerate() {
                if index != origin_index && *guard != hash {
                    // A differing mirror has its own capture and write guard.
                    *guard = b["guards"][index].as_str().unwrap_or(&base).to_owned();
                }
            }
        }
        if let Some(origin) = paths.first() {
            if let Some(index) = b["paths"]
                .as_array()
                .and_then(|mapped| mapped.iter().position(|p| p.as_str() == origin.to_str()))
            {
                guards[index] = hash.clone();
            }
        }
        b["guards"] = json!(guards);
        b["writeGuard"] = json!(hash);
        b["lastSeenHash"] = json!(hash);
        if base_revision == 0 {
            let mut local = input;
            local["hash"] = json!(hash);
            local["projectId"] = json!(project_id);
            local["revision"] = json!(0);
            local["owner"] = db::get(db, "user")?;
            local["updatedBy"] = db::get(db, "user")?;
            local["updatedAt"] = json!(db::now());
            db::upsert(db, "resources", &id, project_id, &local)?;
        }
    }
    if b != original_binding {
        db::upsert(db, "bindings", &id, project_id, &b)?;
    }
    Ok(())
}
fn scanned_sources(
    db: &rusqlite::Connection,
    project: &Value,
    logical: &str,
    native_id: Option<&str>,
) -> Result<Value> {
    let embedded_session = logical.split('/').collect::<Vec<_>>();
    let session = native_id.or_else(|| {
        if embedded_session.get(1) == Some(&"sessions") {
            embedded_session.get(2).copied()
        } else {
            None
        }
    });
    if let Some(session) = session {
        return native::session_sources(
            db,
            project["id"].as_str().ok_or("Missing project")?,
            session,
        );
    }
    let mut sources = db::get(
        db,
        &format!(
            "{}:{logical}",
            crate::sources::meta_key(project, "planSources")?
        ),
    )?
    .as_array()
    .cloned()
    .unwrap_or_default();
    for id in db::get(db, &crate::sources::meta_key(project, "exposedSources")?)?
        .as_array()
        .cloned()
        .unwrap_or_default()
    {
        if !sources.contains(&id) {
            sources.push(id);
        }
    }
    Ok(json!(sources))
}
fn collect_plan_file(
    db: &rusqlite::Connection,
    blobs: &db::BlobStore,
    project: &Value,
    source: &str,
    logical: &str,
    path: &Path,
    seen: &mut BTreeSet<String>,
) -> Result<()> {
    let (file, title) = scan_cache::plan_file(db, blobs, path)?;
    collect(
        db,
        project,
        Scanned {
            kind: "plan",
            source,
            logical,
            title: &title,
            files: vec![file],
            paths: vec![path.into()],
            native_id: None,
            native_parent: None,
        },
        seen,
    )
}

fn collect_embedded_plan(
    db: &rusqlite::Connection,
    blobs: &db::BlobStore,
    project: &Value,
    source: &str,
    logical: &str,
    plan: &scan_cache::CachedEmbeddedPlan,
    seen: &mut BTreeSet<String>,
) -> Result<()> {
    let project_id = project["id"].as_str().ok_or("Missing project")?;
    let id = scoped_resource_id(db, project, "plan", logical)?;
    seen.insert(id.clone());
    if project["catalogOnly"] == true {
        return collect(
            db,
            project,
            Scanned {
                kind: "plan",
                source,
                logical,
                title: &plan.title,
                files: vec![plan.file.clone()],
                paths: vec![],
                native_id: None,
                native_parent: None,
            },
            seen,
        );
    }
    let b = binding(db, &id)?;
    let root = Path::new(project["path"].as_str().ok_or("Connect a folder")?);
    if b["planOriginHash"] == plan.origin_hash {
        if let Some(path) = b["paths"][0].as_str() {
            let path = Path::new(path);
            plans::check_path(root, path)?;
            if path.try_exists().map_err(|e| e.to_string())? {
                return collect_plan_file(db, blobs, project, source, logical, path, seen);
            }
        }
        return Ok(());
    }
    let pending: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM outbox WHERE json_extract(value,'$.resource.resourceId')=?)", [&id], |r| r.get(0)).map_err(|e| e.to_string())?;
    if pending && project["captureOnly"] != true {
        return Ok(());
    }
    let hash = manifest_hash(&json!([&plan.file]));
    let path = plans::destination(root, &json!({"source":source,"logicalPath":logical}))?;
    plans::check_path(root, &path)?;
    if b["paths"].is_null() && !path.try_exists().map_err(|e| e.to_string())? {
        packages::write_file(root, &path, &plan.file)?;
    }
    collect(
        db,
        project,
        Scanned {
            kind: "plan",
            source,
            logical,
            title: &plan.title,
            files: vec![plan.file.clone()],
            paths: vec![path],
            native_id: None,
            native_parent: None,
        },
        seen,
    )?;
    let mut b = binding(db, &id)?;
    // A draft made behind a blocked request leaves the original plan eligible
    // for a later active scan, even when its materialized file is stale.
    if !pending || project["captureOnly"] != true || b["lastSeenHash"] == hash {
        b["planOriginHash"] = json!(plan.origin_hash);
        db::upsert(db, "bindings", &id, project_id, &b)?;
    }
    Ok(())
}

pub fn discover(db: &rusqlite::Connection, project: &Value, kind: &str) -> Result<Vec<Value>> {
    discover_with_progress(db, project, kind, None)
}

pub(crate) type DiscoveryProgress<'a> = Option<&'a dyn Fn(&str, Option<&Path>)>;

pub(crate) fn discover_with_progress(
    db: &rusqlite::Connection,
    project: &Value,
    kind: &str,
    progress: DiscoveryProgress<'_>,
) -> Result<Vec<Value>> {
    let id = project["id"].as_str().ok_or("Missing project")?;
    let generation = Uuid::new_v4().to_string();
    refresh_catalog(
        db,
        project,
        kind,
        &generation,
        !project["sources"].is_array(),
        progress,
    )?;
    // Sharing may use fresh discoveries only; incomplete scans retain older
    // entries exclusively for the desktop's private reading catalog.
    db::rows(db, "SELECT value FROM local_resources WHERE project=? AND json_extract(value,'$.resource.kind')=? AND json_extract(value,'$.generation')=? ORDER BY json_extract(value,'$.resource.title'),id", &[&id,&kind,&generation])
}

fn restore_catalog_metadata(
    db: &rusqlite::Connection,
    project: &str,
    previous: Vec<Value>,
) -> Result<()> {
    for old in previous {
        let id = old["resource"]["resourceId"]
            .as_str()
            .ok_or("Missing resource")?;
        let Some(mut current) =
            db::rows(db, "SELECT value FROM local_resources WHERE id=?", &[&id])?
                .into_iter()
                .next()
        else {
            continue;
        };
        if old["owner"].is_string() && !current["owner"].is_string() {
            current["owner"] = old["owner"].clone();
        }
        if old["resource"]["files"] == current["resource"]["files"] && old["updatedAt"].is_string()
        {
            current["updatedAt"] = old["updatedAt"].clone();
        }
        db::upsert(db, "local_resources", id, project, &current)?;
    }
    Ok(())
}

/// Refresh each source independently. Incomplete histories keep cached entries
/// while healthy discoveries become available; fatal source errors roll back.
pub fn discover_library(
    db: &rusqlite::Connection,
    project: &Value,
    kind: &str,
) -> Result<Vec<String>> {
    refresh_catalog(db, project, kind, &Uuid::new_v4().to_string(), false, None)
}

fn refresh_catalog(
    db: &rusqlite::Connection,
    project: &Value,
    kind: &str,
    generation: &str,
    propagate_source_error: bool,
    progress: DiscoveryProgress<'_>,
) -> Result<Vec<String>> {
    if !matches!(kind, "memory" | "skill" | "session" | "plan") {
        return Err("Choose memories, skills, sessions, or plans".into());
    }
    let id = project["id"].as_str().ok_or("Missing project")?;
    let reads_history = matches!(kind, "session" | "plan");
    if reads_history {
        history::clear_missing_session_errors(db)?;
    }
    let mut errors = Vec::new();
    let claude_scan = (kind == "memory").then(|| ClaudeMemoryScan::new(project));
    for mut source in crate::sources::views(project) {
        if !source["path"].is_string() {
            continue;
        }
        source["catalogOnly"] = json!(true);
        source["sharing"] =
            json!({"memory":false,"skill":false,"session":false,"plan":false,"env":false});
        source["sharing"][kind] = json!(true);
        source["catalogGeneration"] = json!(generation);
        let source_id = source["sourceId"].as_str().unwrap_or("");
        let scan_id = if source_id.is_empty() {
            id.to_owned()
        } else {
            format!("{id}:{source_id}")
        };
        let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
        let previous = db::rows(&tx, "SELECT value FROM local_resources WHERE project=? AND json_extract(value,'$.resource.kind')=? AND coalesce(json_extract(value,'$.resource.sourceId'),'')=?", &[&id,&kind,&source_id])?;
        let scan = scan_source(&tx, &source, false, progress, claude_scan.as_ref());
        let failures = db::rows(
            &tx,
            "SELECT json_object('error',error) FROM errors WHERE source GLOB ? OR (? AND source GLOB ?)",
            &[
                &format!("{scan_id}:scan:*"),
                &reads_history,
                &format!("{}*", history::UNATTRIBUTED_SESSION_PREFIX),
            ],
        )?;
        let mut messages = failures
            .iter()
            .filter_map(|value| value["error"].as_str().map(str::to_owned))
            .collect::<Vec<_>>();
        if reads_history {
            for (tool, directory) in session_directories(
                &native::codex_home()?,
                &native::claude_home()?,
                kind == "session",
            )? {
                let previously_discovered = previous.iter().any(|entry| {
                    entry["resource"]["source"] == tool
                        && (kind == "session"
                            || entry["resource"]["logicalPath"]
                                .as_str()
                                .is_some_and(|path| {
                                    path.starts_with(&format!("{tool}/sessions/"))
                                        || path.starts_with(&format!("{tool}/native/"))
                                }))
                });
                if previously_discovered && !directory.is_dir() {
                    messages.push(format!(
                        "{tool} history is unavailable; keeping previously discovered items"
                    ));
                }
            }
        }
        match scan {
            Ok(()) => {
                if messages.is_empty() {
                    tx.execute("DELETE FROM local_resources WHERE project=? AND json_extract(value,'$.resource.kind')=? AND coalesce(json_extract(value,'$.resource.sourceId'),'')=? AND coalesce(json_extract(value,'$.generation'),'')!=?",params![id,kind,source_id,generation]).map_err(|e|e.to_string())?;
                }
                // Embedded content has no physical timestamp. Preserve its timestamp
                // across unchanged scans rather than making every refresh look new.
                restore_catalog_metadata(&tx, id, previous)?;
                tx.commit().map_err(|e| e.to_string())?;
            }
            Err(error) => {
                tx.rollback().map_err(|e| e.to_string())?;
                if propagate_source_error {
                    return Err(error);
                }
                messages.push(error);
            }
        }
        errors.extend(messages.into_iter().map(|message| {
            format!(
                "{}: {message}",
                source["name"].as_str().unwrap_or("Local discovery")
            )
        }));
    }
    let mut unique = BTreeSet::new();
    errors.retain(|message| unique.insert(message.clone()));
    Ok(errors)
}

fn session_handoff_scope(
    db: &rusqlite::Connection,
    project_id: &str,
    governed_sync: bool,
) -> Result<(String, bool)> {
    let handoff_prefix = format!("handoff:{project_id}:");
    let rows = db::rows(
        db,
        "SELECT json_object('key',key,'value',json(value)) FROM meta WHERE key GLOB ?1 OR key LIKE 'sessionForkHandoff:%' OR key LIKE 'codexImport:%' ORDER BY key",
        &[&format!("{handoff_prefix}*")],
    )?;
    let has_handoffs = rows.iter().any(|row| {
        row["key"]
            .as_str()
            .is_some_and(|key| key.starts_with(&handoff_prefix))
    });
    let scope = db::digest(
        json!([governed_sync && has_handoffs, rows])
            .to_string()
            .as_bytes(),
    );
    Ok((scope, has_handoffs))
}

fn resolve_plans_dir(
    cache: &mut HashMap<(PathBuf, &'static str), Result<PathBuf>>,
    scope: &Path,
    tool: &'static str,
) -> Result<PathBuf> {
    let key = (scope.to_path_buf(), tool);
    if let Some(dir) = cache.get(&key) {
        return dir.clone();
    }
    let dir = plans::project_directory(scope, tool);
    cache.insert(key, dir.clone());
    dir
}

#[allow(clippy::too_many_arguments)]
fn collect_session_plan_refs(
    db: &rusqlite::Connection,
    blobs: &db::BlobStore,
    project: &Value,
    project_id: &str,
    scan_id: &str,
    session_path: &Path,
    tool: &str,
    id: &str,
    checkout: &crate::worktrees::SessionCheckout,
    plans_dir: &Path,
    plan_refs: &[PathBuf],
    seen: &mut BTreeSet<String>,
) -> Result<bool> {
    let native_dir = plans::native_directory(tool)?;
    let native_parent = native_dir.parent().ok_or("Missing native home")?;
    let mut validated = Vec::with_capacity(plan_refs.len());
    for path in plan_refs {
        let checked = if let Ok(relative) = path.strip_prefix(plans_dir) {
            plans::check_path(&checkout.scope, path).map(|()| checkout.plan_key(tool, relative))
        } else {
            path.strip_prefix(&native_dir)
                .map_err(|e| e.to_string())
                .and_then(|relative| {
                    plans::check_path(native_parent, path)
                        .map(|()| format!("{tool}/native/{}", relative.to_string_lossy()))
                })
        };
        match checked {
            Ok(logical) => validated.push((path, logical)),
            Err(err) => {
                error(
                    db,
                    &format!("{scan_id}:scan:plans:{}", session_path.display()),
                    &err,
                )?;
                return Ok(false);
            }
        }
    }
    let mut has_plan_file = false;
    for (path, logical) in validated {
        if !path.try_exists().map_err(|e| e.to_string())? {
            continue;
        }
        if project["governed"] == true && project["catalogOnly"] != true {
            let mut known = db::get(
                db,
                &format!(
                    "{}:{logical}",
                    crate::sources::meta_key(project, "planSources")?
                ),
            )?
            .as_array()
            .cloned()
            .unwrap_or_default();
            for source in native::session_sources(db, project_id, id)?
                .as_array()
                .cloned()
                .unwrap_or_default()
            {
                if !known.contains(&source) {
                    known.push(source);
                }
            }
            db::set(
                db,
                &format!(
                    "{}:{logical}",
                    crate::sources::meta_key(project, "planSources")?
                ),
                &json!(known),
            )?;
        }
        match collect_plan_file(db, blobs, project, tool, &logical, path, seen) {
            Ok(()) => has_plan_file = true,
            Err(err) => error(db, &format!("{scan_id}:scan:{}", path.display()), &err)?,
        }
    }
    Ok(has_plan_file)
}

#[allow(clippy::too_many_arguments)]
fn collect_session_embedded_plans(
    db: &rusqlite::Connection,
    blobs: &db::BlobStore,
    project: &Value,
    scan_id: &str,
    tool: &str,
    id: &str,
    has_plan_file: bool,
    embedded_plans: &[scan_cache::CachedEmbeddedPlan],
    seen: &mut BTreeSet<String>,
) -> Result<()> {
    for plan in embedded_plans {
        if tool == "claude" && has_plan_file {
            continue;
        }
        if let Err(err) = collect_embedded_plan(
            db,
            blobs,
            project,
            tool,
            &format!("{tool}/sessions/{id}/{}", plan.name),
            plan,
            seen,
        ) {
            error(
                db,
                &format!("{scan_id}:scan:plan:{tool}/{id}/{}", plan.name),
                &err,
            )?;
        }
    }
    Ok(())
}

fn session_directories(
    codex: &Path,
    claude: &Path,
    include_pi: bool,
) -> Result<Vec<(&'static str, PathBuf)>> {
    let mut directories = vec![
        ("codex", codex.join("sessions")),
        ("claude", claude.join("projects")),
    ];
    if include_pi {
        directories.push(("pi", crate::pi_sessions::directory()?));
    }
    Ok(directories)
}

pub fn scan(db: &rusqlite::Connection, project: &Value) -> Result<()> {
    scan_with_status(db, project, false).map(|_| ())
}

pub(crate) fn scan_with_progress(db: &rusqlite::Connection, project: &Value) -> Result<()> {
    scan_with_status(db, project, true).map(|_| ())
}

/// Records per-source errors and reports whether all attached content was captured.
pub(crate) fn scan_with_status(
    db: &rusqlite::Connection,
    project: &Value,
    report_progress: bool,
) -> Result<bool> {
    let mut failures = Vec::new();
    let mut complete = true;
    let claude_scan =
        crate::projects::sharing_allowed(project, "memory").then(|| ClaudeMemoryScan::new(project));
    for source in crate::sources::views(project) {
        let result = scan_source(db, &source, report_progress, None, claude_scan.as_ref());
        let key = format!(
            "{}:source:{}",
            project["id"].as_str().unwrap_or(""),
            source["sourceId"].as_str().unwrap_or("default")
        );
        if let Err(error) = &result {
            failures.push(error.clone());
        }
        crate::sync::record_result(db, &key, result)?;
        if project["captureOnly"] == true {
            let id = project["id"].as_str().ok_or("Missing project ID")?;
            let prefix = match source["sourceId"].as_str() {
                Some(source_id) => format!("{id}:{source_id}:scan:*"),
                None => format!("{id}:scan:*"),
            };
            // Individual files can fail independently of a source scan.
            let has_errors: bool = db
                .query_row(
                    "SELECT EXISTS(SELECT 1 FROM errors WHERE source GLOB ?)",
                    [&prefix],
                    |row| row.get(0),
                )
                .map_err(|error| error.to_string())?;
            complete &= !has_errors;
        }
    }
    // Other repositories still scan when one checkout is missing. Filesystem
    // application validates each source independently after the project pull.
    if !project["sources"].is_array() && !failures.is_empty() {
        return Err(failures.join("; "));
    }
    Ok(complete && failures.is_empty())
}

fn scan_source(
    db: &rusqlite::Connection,
    project: &Value,
    report_progress: bool,
    progress: DiscoveryProgress<'_>,
    claude_scan: Option<&ClaudeMemoryScan>,
) -> Result<()> {
    let Some(raw) = project["path"].as_str() else {
        return Ok(());
    };
    let root = Path::new(raw);
    if !root.is_dir() {
        return Err("Connected folder unavailable; deletions paused".into());
    }
    let root = root.canonicalize().map_err(|e| e.to_string())?;
    let progress_state: RefCell<(Option<Instant>, Option<String>)> = RefCell::new((None, None));
    let report_file = |path: &Path| -> Result<()> {
        if let Some(progress) = progress {
            progress("Checking local files", Some(path));
        }
        if report_progress {
            let relative = path.strip_prefix(&root).ok();
            let path = relative
                .or_else(|| path.file_name().map(Path::new))
                .unwrap_or(path);
            let detail = format!(
                "{} · {}",
                crate::projects::display_name(project).unwrap_or("Project"),
                path.display()
            );
            let mut state = progress_state.borrow_mut();
            if state
                .0
                .is_none_or(|last| last.elapsed() >= Duration::from_millis(100))
            {
                crate::sync::progress(db, "Checking local files", Some(&detail), 0, None)?;
                state.0 = Some(Instant::now());
                state.1 = None;
            } else {
                state.1 = Some(detail);
            }
        }
        Ok(())
    };
    fs::read_dir(&root).map_err(|e| e.to_string())?;
    let project_id = project["id"].as_str().ok_or("Missing project ID")?;
    let earlier_plans: BTreeSet<String> = if project["governed"] == true
        && project["catalogOnly"] != true
        && project["captureOnly"] != true
    {
        db::rows(db, "SELECT json_quote(id) FROM outbox WHERE project=? AND json_extract(value,'$.resource.kind')='plan'", &[&project_id])?
            .into_iter().filter_map(|value| value.as_str().map(str::to_owned)).collect()
    } else {
        BTreeSet::new()
    };
    let scan_id = project["sourceId"]
        .as_str()
        .map(|source| format!("{project_id}:{source}"))
        .unwrap_or(project_id.into());
    if let Some(identity) = project["folderIdentity"].as_str() {
        if !folder_identity_matches(&root, identity)? {
            return Err(
                "Connected folder changed or its mount is missing; deletions paused".into(),
            );
        }
    }
    db.execute(
        "DELETE FROM errors WHERE source GLOB ? OR source GLOB ? OR source GLOB ? OR source GLOB ?",
        [
            format!("{scan_id}:scan:*"),
            format!("{scan_id}:/*"),
            format!("{scan_id}:plans:*"),
            format!("{scan_id}:plan:*"),
        ],
    )
    .map_err(|e| e.to_string())?;
    let mut seen = BTreeSet::new();
    let drafts: Vec<_> = db::rows(db, "SELECT value FROM drafts WHERE project=?1 AND json_extract(value,'$.resource.kind')='memory' AND (json_extract(value,'$.status')='local' OR EXISTS (SELECT 1 FROM outbox WHERE path=?2 AND json_extract(outbox.value,'$.contextDraft')=drafts.id))", &[&project_id,&crate::context_sharing::QUEUE_PATH])?.into_iter().filter(|_| project["catalogOnly"] != true).collect();
    // Finish ignore discovery before retiring drafts or inferring deletions.
    let instructions = if crate::projects::sharing_allowed(project, "memory") || !drafts.is_empty()
    {
        instruction_files(&root)?
    } else {
        BTreeSet::new()
    };
    let mut ignored_drafts = Vec::new();
    for draft in drafts {
        if !crate::sources::matches(project, &draft["resource"]) {
            continue;
        }
        let Some(relative) = draft["resource"]["logicalPath"]
            .as_str()
            .and_then(|path| path.strip_prefix("instructions/"))
        else {
            continue;
        };
        let allowed = instruction_allowed(&root, Path::new(relative), &instructions)?;
        if !allowed {
            ignored_drafts.push(draft);
        }
    }
    // Keep ignored source drafts recoverable without leaving fixture copies in review.
    for mut draft in ignored_drafts {
        draft["status"] = json!("dismissed");
        draft["dismissalReason"] = json!("ignored_source");
        db::upsert(
            db,
            "drafts",
            draft["id"].as_str().ok_or("Missing draft")?,
            project_id,
            &draft,
        )?;
        db.execute(
            "DELETE FROM outbox WHERE path=? AND json_extract(value,'$.contextDraft')=?",
            params![crate::context_sharing::QUEUE_PATH, draft["id"].as_str()],
        )
        .map_err(|error| error.to_string())?;
    }
    let claude = native::claude_home()?;
    let codex = native::codex_home()?;
    let blobs = db::BlobStore::current()?;
    let mut memory_complete = true;
    if crate::projects::sharing_allowed(project, "memory") {
        let result = (|| {
            for relative in &instructions {
                let path = root.join(relative);
                let rel = relative.to_string_lossy().to_string();
                let logical = format!("instructions/{rel}");
                packages::check_existing_directory(
                    &root,
                    path.parent().ok_or("Missing instruction parent")?,
                )?;
                report_file(&path)?;
                seen.insert(scoped_resource_id(db, project, "memory", &logical)?);
                let result = (|| {
                    collect(
                        db,
                        project,
                        Scanned {
                            kind: "memory",
                            source: "shared",
                            logical: &logical,
                            title: &rel,
                            files: vec![scan_cache::package_file(db, &blobs, &path, "content.md")?],
                            paths: vec![path],
                            native_id: None,
                            native_parent: None,
                        },
                        &mut seen,
                    )?;
                    Ok(())
                })();
                crate::sync::record_result(db, &format!("{scan_id}:scan:{logical}"), result)?;
            }
            let claude_result = (|| {
                let layout = claude_scan.ok_or("Missing Claude memory scan")?;
                let source_id = project["sourceId"].as_str().unwrap_or("");
                let memory = layout
                    .sources
                    .get(source_id)
                    .ok_or("Missing Claude memory source")?
                    .as_ref()
                    .map_err(Clone::clone)?;
                let tracked = db::rows(db, "SELECT value FROM bindings WHERE project=?1 AND json_extract(value,'$.base.kind')='memory' AND json_extract(value,'$.base.source')='claude' UNION ALL SELECT json_set(value,'$.base',json_extract(value,'$.resource')) FROM drafts WHERE project=?1 AND json_extract(value,'$.resource.kind')='memory' AND json_extract(value,'$.resource.source')='claude' AND json_extract(value,'$.status')='local'", &[&project_id])?;
                let mut claimed_paths = BTreeMap::new();
                let mut claimed_names = BTreeMap::new();
                for claim in &tracked {
                    if let (Some(path), Some(name)) = (
                        claim["paths"][0].as_str(),
                        claim["base"]["logicalPath"].as_str(),
                    ) {
                        let owner = claim["base"]["sourceId"].as_str().unwrap_or("");
                        claimed_paths.entry(Path::new(path)).or_insert(owner);
                        if owner == source_id {
                            claimed_names.entry(name).or_insert(Path::new(path));
                        }
                    }
                }
                let mut claude_names = BTreeSet::new();
                for directory in [&memory.native, &memory.legacy]
                    .into_iter()
                    .take(if memory.native == memory.legacy { 1 } else { 2 })
                {
                    if !directory.try_exists().map_err(|e| e.to_string())? {
                        continue;
                    }
                    if directory.starts_with(&claude) {
                        check_memory_directory(directory)?;
                    }
                    let mut permits_untracked = None;
                    for entry in WalkDir::new(directory)
                        .follow_links(false)
                        .follow_root_links(false)
                    {
                        let e = entry.map_err(|e| e.to_string())?;
                        if e.file_type().is_file()
                            && e.path().extension().is_some_and(|s| s == "md")
                        {
                            let rel = e
                                .path()
                                .strip_prefix(directory)
                                .map_err(|e| e.to_string())?
                                .to_string_lossy()
                                .to_string();
                            let logical = format!("claude/{rel}");
                            if let Some(path) = claimed_names.get(logical.as_str()) {
                                if *path != e.path() {
                                    continue;
                                }
                            } else if claimed_paths.contains_key(e.path()) {
                                continue;
                            } else {
                                let allowed = match permits_untracked {
                                    Some(allowed) => allowed,
                                    None => {
                                        let allowed =
                                            layout.permits_untracked(db, project, directory)?;
                                        permits_untracked = Some(allowed);
                                        allowed
                                    }
                                };
                                if !allowed {
                                    continue;
                                }
                            }
                            if !claude_names.insert(logical.clone()) {
                                continue;
                            }
                            report_file(e.path())?;
                            seen.insert(scoped_resource_id(db, project, "memory", &logical)?);
                            let result = (|| {
                                collect(
                                    db,
                                    project,
                                    Scanned {
                                        kind: "memory",
                                        source: "claude",
                                        logical: &logical,
                                        title: &rel,
                                        files: vec![scan_cache::package_file(
                                            db,
                                            &blobs,
                                            e.path(),
                                            "content.md",
                                        )?],
                                        paths: vec![e.path().into()],
                                        native_id: None,
                                        native_parent: None,
                                    },
                                    &mut seen,
                                )?;
                                Ok(())
                            })();
                            crate::sync::record_result(
                                db,
                                &format!("{scan_id}:scan:{logical}"),
                                result,
                            )?;
                        }
                    }
                }
                Ok(())
            })();
            crate::sync::record_result(
                db,
                &format!("{scan_id}:scan:claude-memory"),
                claude_result,
            )?;
            struct CodexSummary {
                path: PathBuf,
                name: String,
                thread: Option<String>,
                updated_at: String,
            }
            let [legacy, current] = native::codex_memory_stores(&codex);
            let mut legacy_summaries = BTreeMap::new();
            let mut summary_files: BTreeMap<String, CodexSummary> = BTreeMap::new();
            // Dual-write can give one thread different filenames. Keep the legacy
            // file for equal timestamps so existing shared content doesn't churn.
            for store in [&legacy, &current] {
                let result = (|| {
                    let summaries = store.join("rollout_summaries");
                    for dir in [store.as_path(), &summaries] {
                        match fs::symlink_metadata(dir) {
                            Ok(metadata) if metadata.is_dir() => {}
                            Ok(_) => {
                                return Err("Codex memory directory is a symlink or file".into())
                            }
                            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                            Err(e) => return Err(e.to_string()),
                        }
                    }
                    for entry in fs::read_dir(&summaries).map_err(|e| e.to_string())? {
                        let entry = entry.map_err(|e| e.to_string())?;
                        let path = entry.path();
                        if path.extension().is_none_or(|e| e != "md")
                            || !entry.file_type().map_err(|e| e.to_string())?.is_file()
                        {
                            continue;
                        }
                        let meta = match scan_cache::codex_summary_meta(db, &path) {
                            Ok(meta) => meta,
                            Err(error) => {
                                // Codex may rewrite or remove a summary during consolidation.
                                crate::sync::record_result(
                                    db,
                                    &format!("{scan_id}:scan:{}", path.display()),
                                    Err(error),
                                )?;
                                continue;
                            }
                        };
                        let belongs = meta
                            .cwd
                            .as_deref()
                            .is_some_and(|p| Path::new(p).starts_with(&root));
                        let name = entry.file_name().to_string_lossy().into_owned();
                        let thread = meta.thread;
                        if store == &legacy {
                            legacy_summaries.insert(name.clone(), (belongs, thread.clone()));
                        }
                        if !belongs {
                            continue;
                        }
                        let key = thread
                            .as_ref()
                            .map(|id| format!("{id}.md"))
                            .unwrap_or_else(|| name.clone());
                        let updated_at = meta.updated_at;
                        if summary_files
                            .get(&key)
                            .is_none_or(|old| updated_at > old.updated_at)
                        {
                            summary_files.insert(
                                key,
                                CodexSummary {
                                    path,
                                    name,
                                    thread,
                                    updated_at,
                                },
                            );
                        }
                    }
                    Ok(())
                })();
                crate::sync::record_result(
                    db,
                    &format!(
                        "{scan_id}:scan:{}",
                        store.file_name().unwrap_or_default().to_string_lossy()
                    ),
                    result,
                )?;
            }
            // V2's memory_summary.md is a cross-project index. The v1 digest
            // must resolve its references only against files in its own store.
            let durable = legacy.join("MEMORY.md");
            let mut covered = BTreeSet::new();
            let durable_result = (|| {
                if legacy_summaries.is_empty() {
                    return Ok(());
                }
                match fs::symlink_metadata(&durable) {
                    Ok(metadata) if metadata.is_file() => {}
                    Ok(_) => return Err("Codex MEMORY.md is not a regular file".into()),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(()),
                    Err(e) => return Err(e.to_string()),
                }
                let text = fs::read_to_string(&durable).map_err(|e| e.to_string())?;
                let references =
                    regex::Regex::new(r"(?m)^\s*-\s*([^\s]+\.md)").map_err(|e| e.to_string())?;
                for section in text.split("\n# ") {
                    let refs = references
                        .captures_iter(section)
                        .filter_map(|c| {
                            Path::new(&c[1])
                                .file_name()
                                .map(|name| name.to_string_lossy().to_string())
                        })
                        .collect::<Vec<_>>();
                    if refs.is_empty()
                        || !refs
                            .iter()
                            .all(|r| legacy_summaries.get(r).is_some_and(|(belongs, _)| *belongs))
                    {
                        continue;
                    }
                    let title = section
                        .lines()
                        .next()
                        .unwrap_or("Learned memory")
                        .trim_start_matches('#')
                        .trim();
                    let name = format!("{}.md", &db::digest(title.as_bytes())[..20]);
                    let bytes = section.as_bytes();
                    collect(
                        db,
                        project,
                        Scanned {
                            kind: "memory",
                            source: "codex",
                            logical: &format!("codex/entries/{name}"),
                            title,
                            files: vec![
                                json!({"path":"content.md","hash":db::blob(bytes)?,"size":bytes.len(),"executable":false}),
                            ],
                            paths: vec![durable.clone()],
                            native_id: None,
                            native_parent: None,
                        },
                        &mut seen,
                    )?;
                    covered.extend(refs);
                }
                Ok(())
            })();
            crate::sync::record_result(
                db,
                &format!("{scan_id}:scan:codex-durable"),
                durable_result,
            )?;
            let covered_threads: BTreeSet<_> = covered
                .iter()
                .filter_map(|name| legacy_summaries.get(name)?.1.as_ref())
                .collect();
            for (
                key,
                CodexSummary {
                    path, name, thread, ..
                },
            ) in summary_files
            {
                if (path.starts_with(&legacy) && covered.contains(&name))
                    || thread
                        .as_ref()
                        .is_some_and(|id| covered_threads.contains(id))
                {
                    continue;
                }
                let result = (|| {
                    report_file(&path)?;
                    collect(
                        db,
                        project,
                        Scanned {
                            kind: "memory",
                            source: "codex",
                            logical: &format!("codex/summaries/{key}"),
                            title: &name,
                            files: vec![scan_cache::package_file(db, &blobs, &path, "content.md")?],
                            paths: vec![path],
                            native_id: None,
                            native_parent: None,
                        },
                        &mut seen,
                    )
                })();
                crate::sync::record_result(
                    db,
                    &format!("{scan_id}:scan:codex-summaries/{key}"),
                    result,
                )?;
            }
            Ok(())
        })();
        memory_complete = result.is_ok();
        crate::sync::record_result(db, &format!("{scan_id}:scan:memory"), result)?;
    }
    if crate::projects::sharing_allowed(project, "skill") {
        let mut skills: BTreeMap<String, Vec<PathBuf>> = BTreeMap::new();
        for folder in [".agents/skills", ".claude/skills"] {
            let directory = root.join(folder);
            if !directory.exists() {
                continue;
            }
            for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
                let e = entry.map_err(|e| e.to_string())?;
                let name = e.file_name().to_string_lossy().to_string();
                if name.starts_with('.') || !e.path().join("SKILL.md").is_file() {
                    continue;
                }
                skills.entry(name).or_default().push(e.path());
            }
        }
        for (name, paths) in skills {
            report_file(&paths[0].join("SKILL.md"))?;
            let id = scoped_resource_id(db, project, "skill", &name)?;
            seen.insert(id.clone());
            let result = (|| {
                if !db::get(db, &format!("installation:{id}"))?.is_null() {
                    return Err(
                        "Skill installation recovery pending; local copies preserved".into(),
                    );
                }
                if project["catalogOnly"] == true {
                    let copies = paths
                        .iter()
                        .map(|p| scan_cache::skill_directory(db, &blobs, p).map(|f| (p, json!(f))))
                        .collect::<Result<Vec<_>>>()?;
                    if copies.windows(2).any(|pair| pair[0].1 != pair[1].1) {
                        return Err(
                            "Local skill copies differ; resolve them before sharing this skill"
                                .into(),
                        );
                    }
                    return collect(
                        db,
                        project,
                        Scanned {
                            kind: "skill",
                            source: "shared",
                            logical: &name,
                            title: &name,
                            files: copies[0].1.as_array().ok_or("Missing skill files")?.clone(),
                            paths: paths.clone(),
                            native_id: None,
                            native_parent: None,
                        },
                        &mut seen,
                    );
                }
                let mut b = binding(db, &id)?;
                let empty = manifest_hash(&json!([]));
                let removed = b["paths"].as_array().is_some_and(|mapped| {
                    mapped.iter().enumerate().any(|(i, p)| {
                        b["guards"][i].as_str().is_some_and(|h| h != empty)
                            && p.as_str().is_some_and(|p| !Path::new(p).exists())
                    })
                });
                if removed && b["mirrorReview"] != true {
                    collect(
                        db,
                        project,
                        Scanned {
                            kind: "skill",
                            source: "shared",
                            logical: &name,
                            title: &name,
                            files: vec![],
                            paths: vec![],
                            native_id: None,
                            native_parent: None,
                        },
                        &mut seen,
                    )?;
                    return Ok(());
                }
                let pending:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM outbox WHERE json_extract(value,'$.resource.resourceId')=?)",[&id],|r|r.get(0)).map_err(|e|e.to_string())?;
                let base = b["base"].clone();
                let copies = paths
                    .iter()
                    .map(|p| scan_cache::skill_directory(db, &blobs, p).map(|f| (p, json!(f))))
                    .collect::<Result<Vec<_>>>()?;
                if project["governed"] == true
                    && crate::skill_reconciliation::defer_scan(
                        db, project, &id, &name, &mut b, &copies,
                    )?
                {
                    return Ok(());
                }
                if project["governed"] != true
                    && base["revision"].as_u64().unwrap_or(0) == 0
                    && copies.windows(2).any(|pair| pair[0].1 != pair[1].1)
                {
                    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
                    for (path, files) in &copies {
                        let mut resource = json!({"resourceId":id,"kind":"skill","source":"shared","logicalPath":name,"title":name,"files":files,"deleted":false});
                        crate::sources::scope(project, &mut resource);
                        crate::governance::capture(&tx, project, &resource, &json!([path]))?;
                    }
                    let held = if project["captureOnly"] == true {
                        replaceable_held(&tx, project, &id)?
                    } else {
                        None
                    };
                    // A pending row already protected by a deleted-project
                    // mirror review must also survive the first active scan.
                    if (project["captureOnly"] != true && b["mirrorReview"] != true)
                        || held.is_some()
                    {
                        for queued in db::rows(&tx, "SELECT value FROM outbox WHERE project=? AND json_extract(value,'$.resource.resourceId')=?", &[&project_id, &id])? {
                            crate::governance::capture(&tx, project, &queued["resource"], &json!(paths))?;
                        }
                        if let Some(held) = held {
                            for row in held {
                                discard_held(
                                    &tx,
                                    row["id"].as_str().ok_or("Missing held request ID")?,
                                )?;
                            }
                        } else {
                            tx.execute("DELETE FROM outbox WHERE project=? AND json_extract(value,'$.resource.resourceId')=?", params![project_id,id]).map_err(|e|e.to_string())?;
                        }
                    }
                    b["mirrorReview"] = json!(true);
                    db::upsert(&tx, "bindings", &id, project_id, &b)?;
                    tx.commit().map_err(|e| e.to_string())?;
                    error(db, &id, SKILL_MIRROR_REVIEW)?;
                    seen.insert(id.clone());
                    return Ok(());
                }
                if b["mirrorReview"] == true && !pending {
                    b["mirrorReview"] = json!(false);
                    db::upsert(db, "bindings", &id, project_id, &b)?;
                }
                let changed = copies
                    .iter()
                    .filter(|(path, files)| {
                        let guard = b["paths"]
                            .as_array()
                            .and_then(|mapped| {
                                mapped.iter().position(|p| p.as_str() == path.to_str())
                            })
                            .and_then(|index| b["guards"][index].as_str())
                            .or_else(|| b["lastSeenHash"].as_str());
                        guard.is_some_and(|h| manifest_hash(files) != h)
                    })
                    .collect::<Vec<_>>();
                let selected_index = changed
                    .first()
                    .and_then(|(path, _)| copies.iter().position(|(p, _)| p == path))
                    .or_else(|| {
                        copies
                            .iter()
                            .position(|(_, files)| b["lastSeenHash"] == manifest_hash(files))
                    })
                    .unwrap_or(0);
                let selected = copies[selected_index].0.clone();
                let selected_files = copies[selected_index]
                    .1
                    .as_array()
                    .ok_or("Missing skill files")?
                    .clone();
                collect(
                    db,
                    project,
                    Scanned {
                        kind: "skill",
                        source: "shared",
                        logical: &name,
                        title: &name,
                        files: selected_files,
                        paths: vec![
                            selected.clone(),
                            if selected == root.join(".agents/skills").join(&name) {
                                root.join(".claude/skills").join(&name)
                            } else {
                                root.join(".agents/skills").join(&name)
                            },
                        ],
                        native_id: None,
                        native_parent: None,
                    },
                    &mut seen,
                )?;
                if project["governed"] != true
                    && changed.len() > 1
                    && (changed[0].1 != changed[1].1 || project["captureOnly"] == true)
                    && (!pending || project["captureOnly"] == true)
                {
                    let mut input = json!({"version":2,"id":Uuid::new_v4().to_string(),"projectId":project_id,"deviceId":db::device(db)?,"baseRevision":base["revision"].as_u64().unwrap_or(0),"resource":{"resourceId":id,"kind":"skill","source":"shared","logicalPath":name,"title":name,"files":changed[1].1,"deleted":false}});
                    crate::sources::scope(project, &mut input["resource"]);
                    if !queue_scanned(db, project, &input, std::slice::from_ref(changed[1].0))? {
                        return Ok(());
                    }
                    let mut b = binding(db, &id)?;
                    if let Some(i) = b["paths"].as_array().and_then(|mapped| {
                        mapped
                            .iter()
                            .position(|p| p.as_str() == changed[1].0.to_str())
                    }) {
                        b["guards"][i] = json!(manifest_hash(&changed[1].1));
                        db::upsert(db, "bindings", &id, project_id, &b)?;
                    }
                }
                Ok(())
            })();
            crate::sync::record_result(db, &format!("{scan_id}:scan:skills/{name}"), result)?;
        }
    }
    let mut sessions_complete = true;
    let unattributed_pattern = format!("{}*", history::UNATTRIBUTED_SESSION_PREFIX);
    let unattributed_paths: BTreeSet<_> = db::rows(
        db,
        "SELECT json_quote(source) FROM errors WHERE source GLOB ?",
        &[&unattributed_pattern],
    )?
    .into_iter()
    .filter_map(|source| source.as_str().map(str::to_owned))
    .collect();
    if crate::projects::sharing_allowed(project, "plan") {
        for source in ["codex", "claude"] {
            let directory = plans::project_directory(&root, source)?;
            plans::check_path(&root, &directory)?;
            if !directory.try_exists().map_err(|e| e.to_string())? {
                continue;
            }
            for entry in WalkDir::new(&directory).follow_links(false) {
                let entry = entry.map_err(|e| e.to_string())?;
                if entry.file_type().is_symlink() {
                    return Err("Symlinked plans are excluded; deletions paused".into());
                }
                if !entry.file_type().is_file()
                    || entry
                        .path()
                        .extension()
                        .is_none_or(|s| !s.eq_ignore_ascii_case("md"))
                {
                    continue;
                }
                let relative = entry
                    .path()
                    .strip_prefix(&directory)
                    .map_err(|e| e.to_string())?
                    .to_string_lossy();
                let logical = format!("{source}/files/{relative}");
                report_file(entry.path())?;
                if let Err(err) = collect_plan_file(
                    db,
                    &blobs,
                    project,
                    source,
                    &logical,
                    entry.path(),
                    &mut seen,
                ) {
                    error(
                        db,
                        &format!("{scan_id}:scan:{}", entry.path().display()),
                        &err,
                    )?;
                }
            }
        }
    }
    if crate::projects::sharing_allowed(project, "session")
        || crate::projects::sharing_allowed(project, "plan")
    {
        let sources = crate::worktrees::session_sources(db, project)?;
        let home = crate::worktrees::home()?;
        let session_scope =
            crate::worktrees::SessionScope::new(db, project, &root, &sources, &home)?;
        let topology = session_scope.cache_scope()?;
        let governed_sync = project["governed"] == true && project["catalogOnly"] != true;
        let (handoff_scope, _) = session_handoff_scope(db, project_id, governed_sync)?;
        let share_plans = crate::projects::sharing_allowed(project, "plan");
        let codex_index = history::CodexSegmentIndex::new(&codex);
        let mut plan_dirs: HashMap<(PathBuf, &'static str), Result<PathBuf>> = HashMap::new();
        let mut last_history_progress = None;
        let include_pi =
            project["catalogOnly"] == true && crate::projects::sharing_allowed(project, "session");
        for (tool, directory) in session_directories(&codex, &claude, include_pi)? {
            if !directory.exists() {
                if tool != "pi" {
                    sessions_complete = false;
                }
                continue;
            }
            for entry in WalkDir::new(&directory).follow_links(false) {
                let e = entry.map_err(|e| e.to_string())?;
                if !e.file_type().is_file()
                    || !(e.path().extension().is_some_and(|s| s == "jsonl")
                        || (tool == "codex" && crate::history::is_session(e.path())))
                {
                    continue;
                }
                let unattributed = format!(
                    "{}{}",
                    history::UNATTRIBUTED_SESSION_PREFIX,
                    e.path().display()
                );
                if let Some(progress) = progress {
                    if last_history_progress
                        .is_none_or(|last: Instant| last.elapsed() >= Duration::from_millis(100))
                    {
                        progress("Reading local history", None);
                        last_history_progress = Some(Instant::now());
                    }
                }
                let negative =
                    history::NegativeAttribution::new(project, &root, &topology, tool, e.path());
                let cached_unrelated = negative
                    .as_ref()
                    .map(|cache| cache.contains(db))
                    .transpose()?
                    .unwrap_or(false);
                if cached_unrelated {
                    if unattributed_paths.contains(&unattributed) {
                        db.execute("DELETE FROM errors WHERE source=?", [&unattributed])
                            .map_err(|e| e.to_string())?;
                    }
                    continue;
                }
                let leaf_stamp = scan_cache::FileStamp::of(e.path());
                let session_cache_key = scan_cache::session_key(project, &root, tool, e.path());
                if let Some(stamp) = &leaf_stamp {
                    if let Some(cached) = scan_cache::load_session(db, &session_cache_key)? {
                        if cached.topology == topology
                            && cached.handoff_scope == handoff_scope
                            && cached.stamps_match(e.path(), stamp)
                        {
                            if let Some(checkout) =
                                session_scope.for_session(tool, &cached.id, &cached.cwd)?
                            {
                                let codex_status = if tool == "codex" {
                                    Some(codex_index.current_path(e.path(), &cached.id))
                                } else {
                                    None
                                };
                                match codex_status {
                                    Some(Ok(latest)) if latest != e.path() => {
                                        if unattributed_paths.contains(&unattributed) {
                                            db.execute(
                                                "DELETE FROM errors WHERE source=?",
                                                [&unattributed],
                                            )
                                            .map_err(|e| e.to_string())?;
                                        }
                                        continue;
                                    }
                                    Some(Err(_)) => {}
                                    _ => {
                                        let ancestors_valid = if tool == "codex" {
                                            let candidates_ok = cached
                                                .ancestor_candidates
                                                .iter()
                                                .all(|(ancestor_id, expected_paths)| {
                                                    codex_index
                                                        .candidate_paths(ancestor_id)
                                                        .is_ok_and(|paths| paths == *expected_paths)
                                                });
                                            let cwds_ok = checkout.historical
                                                || cached.ancestor_cwds.is_empty()
                                                || checkout.scope.canonicalize().is_ok_and(
                                                    |canonical_scope| {
                                                        cached.ancestor_cwds.iter().all(|cwd| {
                                                            cwd.canonicalize().is_ok_and(|c| {
                                                                c.starts_with(&canonical_scope)
                                                            })
                                                        })
                                                    },
                                                );
                                            candidates_ok && cwds_ok
                                        } else {
                                            true
                                        };
                                        let need_plans =
                                            tool != "pi" && !checkout.historical && share_plans;
                                        let current_plans_dir = if need_plans {
                                            resolve_plans_dir(&mut plan_dirs, &checkout.scope, tool)
                                                .ok()
                                        } else {
                                            None
                                        };
                                        let plans_ready = !need_plans
                                            || (cached.plans_checked
                                                && current_plans_dir.is_some()
                                                && cached.plans_dir == current_plans_dir);
                                        if ancestors_valid
                                            && plans_ready
                                            && cached.blobs_present(&blobs, need_plans)
                                        {
                                            if unattributed_paths.contains(&unattributed) {
                                                db.execute(
                                                    "DELETE FROM errors WHERE source=?",
                                                    [&unattributed],
                                                )
                                                .map_err(|e| e.to_string())?;
                                            }
                                            report_file(e.path())?;
                                            session_scope.pin(&checkout, tool, &cached.id)?;
                                            if governed_sync {
                                                native::bind_handoff(
                                                    db,
                                                    project_id,
                                                    &cached.id,
                                                    &[],
                                                )?;
                                            }
                                            let has_plan_file =
                                                if let Some(plans_dir) = &current_plans_dir {
                                                    collect_session_plan_refs(
                                                        db,
                                                        &blobs,
                                                        project,
                                                        project_id,
                                                        &scan_id,
                                                        e.path(),
                                                        tool,
                                                        &cached.id,
                                                        &checkout,
                                                        plans_dir,
                                                        &cached.plan_refs,
                                                        &mut seen,
                                                    )?
                                                } else {
                                                    false
                                                };
                                            // Claude snapshots omit inline plans when a referenced plan
                                            // succeeded. Reparse if collection can no longer use a reference.
                                            if !need_plans
                                                || tool != "claude"
                                                || !cached.had_plan_file
                                                || has_plan_file
                                            {
                                                if current_plans_dir.is_some() {
                                                    collect_session_embedded_plans(
                                                        db,
                                                        &blobs,
                                                        project,
                                                        &scan_id,
                                                        tool,
                                                        &cached.id,
                                                        has_plan_file,
                                                        &cached.embedded_plans,
                                                        &mut seen,
                                                    )?;
                                                }
                                                let result = collect(
                                                    db,
                                                    project,
                                                    Scanned {
                                                        kind: "session",
                                                        source: tool,
                                                        logical: &cached.logical,
                                                        title: &cached.title,
                                                        files: cached.files,
                                                        paths: vec![e.path().into()],
                                                        native_id: Some(&cached.id),
                                                        native_parent: if project["catalogOnly"]
                                                            == true
                                                        {
                                                            cached.native_parent.as_deref()
                                                        } else {
                                                            None
                                                        },
                                                    },
                                                    &mut seen,
                                                );
                                                if result.is_err() {
                                                    sessions_complete = false;
                                                }
                                                crate::sync::record_result(
                                                    db,
                                                    &format!(
                                                        "{scan_id}:scan:{}",
                                                        e.path().display()
                                                    ),
                                                    result,
                                                )?;
                                                continue;
                                            }
                                        }
                                    }
                                }
                            }
                        }
                    }
                }
                // Codex and Pi put the working directory in the first record.
                let unrelated_prefix = if matches!(tool, "codex" | "pi") {
                    match history::session_route_prefix(e.path(), tool) {
                        Some((Some(id), cwd)) => {
                            session_scope.for_session(tool, &id, &cwd)?.is_none()
                        }
                        Some((None, cwd)) => session_scope.checkout_scope(&cwd).is_none(),
                        None => false,
                    }
                } else {
                    false
                };
                if unrelated_prefix {
                    if let Some(cache) = &negative {
                        cache.remember(db, e.path())?;
                    }
                    if unattributed_paths.contains(&unattributed) {
                        db.execute("DELETE FROM errors WHERE source=?", [&unattributed])
                            .map_err(|e| e.to_string())?;
                    }
                    continue;
                }
                let bytes = match history::read_session(e.path()) {
                    Ok(bytes) => {
                        if unattributed_paths.contains(&unattributed) {
                            db.execute("DELETE FROM errors WHERE source=?", [&unattributed])
                                .map_err(|e| e.to_string())?;
                        }
                        bytes
                    }
                    Err(err) => {
                        if err == history::SESSION_SIZE_ERROR {
                            match history::session_cwd_prefix(e.path(), tool) {
                                None => {
                                    // An unattributed transcript must never imply a local deletion.
                                    error(db, &unattributed, history::UNATTRIBUTED_SESSION_ERROR)?;
                                    sessions_complete = false;
                                    continue;
                                }
                                Some(cwd) => {
                                    db.execute(
                                        "DELETE FROM errors WHERE source=?",
                                        [&unattributed],
                                    )
                                    .map_err(|e| e.to_string())?;
                                    if session_scope.checkout_scope(&cwd).is_none() {
                                        if let Some(cache) = &negative {
                                            cache.remember(db, e.path())?;
                                        }
                                        continue;
                                    }
                                }
                            }
                        }
                        error(db, &format!("{scan_id}:scan:{}", e.path().display()), &err)?;
                        sessions_complete = false;
                        continue;
                    }
                };
                let leaf_bytes_len = bytes.len();
                let records = match native::complete_records(&bytes) {
                    Ok(r) => r,
                    Err(err) => {
                        error(db, &format!("{scan_id}:scan:{}", e.path().display()), &err)?;
                        sessions_complete = false;
                        continue;
                    }
                };
                let (id, cwd, title) = match native::session_info(tool, &records) {
                    Ok(v) => v,
                    Err(err) => {
                        let attributable = native::session_cwd(tool, &records).map_or_else(
                            |_| {
                                records.iter().any(|r| {
                                    r["cwd"]
                                        .as_str()
                                        .or(r["payload"]["cwd"].as_str())
                                        .is_some_and(|p| {
                                            session_scope.checkout_scope(Path::new(p)).is_some()
                                        })
                                })
                            },
                            |cwd| session_scope.checkout_scope(&cwd).is_some(),
                        );
                        if attributable {
                            report_file(e.path())?;
                            error(db, &format!("{scan_id}:scan:{}", e.path().display()), &err)?;
                            sessions_complete = false;
                        } else if native::session_cwd(tool, &records).is_ok() {
                            if let Some(cache) = &negative {
                                cache.remember(db, e.path())?;
                            }
                        }
                        continue;
                    }
                };
                let Some(checkout) = session_scope.for_session(tool, &id, &cwd)? else {
                    if let Some(cache) = &negative {
                        cache.remember(db, e.path())?;
                    }
                    continue;
                };
                if scan_cache::is_reconciling() {
                    if let Some(cache) = &negative {
                        cache.forget(db)?;
                    }
                }
                report_file(e.path())?;
                if tool == "codex" {
                    match codex_index.current_path(e.path(), &id) {
                        Ok(latest) if latest != e.path() => continue,
                        Err(err) => {
                            error(db, &format!("{scan_id}:scan:{}", e.path().display()), &err)?;
                            sessions_complete = false;
                            continue;
                        }
                        _ => (),
                    }
                }
                if tool == "claude"
                    && e.path()
                        .file_stem()
                        .is_none_or(|name| name.to_string_lossy() != id)
                {
                    continue;
                }
                if tool == "codex"
                    && records
                        .iter()
                        .find(|r| r["type"] == "session_meta")
                        .is_some_and(|r| r["payload"]["source"].is_object())
                {
                    continue;
                }
                if tool == "codex"
                    && crate::codex_import::is_pending_or_dependency(db, &id, &records)?
                {
                    continue;
                }
                session_scope.pin(&checkout, tool, &id)?;
                let handoff = crate::session_forks::handoff_origin(db, project, tool, &records)?;
                let logical = if let Some(origin) = &handoff {
                    format!(
                        "{tool}/forks/{}/{}/{id}",
                        origin["parentId"].as_str().ok_or("Missing parent")?,
                        origin["destination"]
                            .as_str()
                            .ok_or("Missing destination")?
                    )
                } else {
                    format!("{tool}/{id}")
                };
                let native_parent =
                    crate::session_forks::native_parent(tool, &id, &records).map(str::to_owned);
                let checkout_scope = &checkout.scope;
                let snapshot = match crate::history::session_snapshot(
                    tool,
                    e.path(),
                    leaf_bytes_len,
                    records,
                    leaf_stamp,
                    (!checkout.historical).then_some(checkout_scope.as_path()),
                    (tool == "codex").then_some(&codex_index),
                ) {
                    Ok(snapshot) => snapshot,
                    Err(err) => {
                        error(db, &format!("{scan_id}:scan:{}", e.path().display()), &err)?;
                        sessions_complete = false;
                        continue;
                    }
                };
                if governed_sync {
                    native::bind_handoff(db, project_id, &id, &snapshot.redacted_records)?;
                }
                let mut can_cache = !snapshot.deps.is_empty();
                let mut plans_checked = false;
                let mut cached_had_plan_file = false;
                let mut cached_plans_dir = None;
                let mut cached_plan_refs = Vec::new();
                let mut cached_embedded_plans = Vec::new();
                if tool != "pi" && !checkout.historical && share_plans {
                    let mut has_plan_file = false;
                    let mut plan_refs_ok = false;
                    match resolve_plans_dir(&mut plan_dirs, checkout_scope, tool) {
                        Ok(plans_dir) => {
                            match plans::references(
                                tool,
                                checkout_scope,
                                &snapshot.redacted_records,
                            ) {
                                Ok(paths) => {
                                    cached_plan_refs = paths;
                                    plan_refs_ok = true;
                                    has_plan_file = collect_session_plan_refs(
                                        db,
                                        &blobs,
                                        project,
                                        project_id,
                                        &scan_id,
                                        e.path(),
                                        tool,
                                        &id,
                                        &checkout,
                                        &plans_dir,
                                        &cached_plan_refs,
                                        &mut seen,
                                    )?;
                                }
                                Err(err) => {
                                    can_cache = false;
                                    error(
                                        db,
                                        &format!("{scan_id}:scan:plans:{}", e.path().display()),
                                        &err,
                                    )?;
                                }
                            }
                            if plan_refs_ok {
                                cached_plans_dir = Some(plans_dir);
                            }
                        }
                        Err(err) => {
                            can_cache = false;
                            error(
                                db,
                                &format!("{scan_id}:scan:plans:{}", e.path().display()),
                                &err,
                            )?;
                        }
                    }
                    let mut embedded_ok = true;
                    for (name, text) in plans::embedded(tool, &snapshot.redacted_records) {
                        if tool == "claude" && has_plan_file {
                            continue;
                        }
                        match plans::content(text.as_bytes()) {
                            Ok(file) => {
                                let plan = scan_cache::CachedEmbeddedPlan {
                                    name: name.to_owned(),
                                    title: plans::title(&text, "Plan"),
                                    file,
                                    origin_hash: db::digest(text.as_bytes()),
                                };
                                if let Err(err) = collect_embedded_plan(
                                    db,
                                    &blobs,
                                    project,
                                    tool,
                                    &format!("{tool}/sessions/{id}/{}", plan.name),
                                    &plan,
                                    &mut seen,
                                ) {
                                    embedded_ok = false;
                                    can_cache = false;
                                    error(
                                        db,
                                        &format!("{scan_id}:scan:plan:{tool}/{id}/{}", plan.name),
                                        &err,
                                    )?;
                                } else {
                                    cached_embedded_plans.push(plan);
                                }
                            }
                            Err(err) => {
                                embedded_ok = false;
                                can_cache = false;
                                error(
                                    db,
                                    &format!("{scan_id}:scan:plan:{tool}/{id}/{name}"),
                                    &err,
                                )?;
                            }
                        }
                    }
                    if plan_refs_ok && embedded_ok {
                        plans_checked = true;
                        cached_had_plan_file = has_plan_file;
                    }
                }
                let result = collect(
                    db,
                    project,
                    Scanned {
                        kind: "session",
                        source: tool,
                        logical: &logical,
                        title: &title,
                        files: snapshot.files.clone(),
                        paths: vec![e.path().into()],
                        native_id: Some(&id),
                        native_parent: if project["catalogOnly"] == true {
                            native_parent.as_deref()
                        } else {
                            None
                        },
                    },
                    &mut seen,
                );
                if result.is_ok() && can_cache {
                    scan_cache::save_session(
                        db,
                        &session_cache_key,
                        &scan_cache::CachedSession {
                            topology: topology.clone(),
                            handoff_scope: handoff_scope.clone(),
                            deps: snapshot.deps,
                            ancestor_candidates: snapshot.ancestor_candidates,
                            ancestor_cwds: snapshot.ancestor_cwds,
                            id,
                            cwd,
                            title,
                            files: snapshot.files,
                            logical,
                            native_parent,
                            plans_checked,
                            had_plan_file: cached_had_plan_file,
                            plans_dir: cached_plans_dir,
                            plan_refs: cached_plan_refs,
                            embedded_plans: cached_embedded_plans,
                        },
                    )?;
                }
                if result.is_err() {
                    sessions_complete = false;
                }
                crate::sync::record_result(
                    db,
                    &format!("{scan_id}:scan:{}", e.path().display()),
                    result,
                )?;
            }
        }
    }
    if project["catalogOnly"] == true {
        return Ok(());
    }
    if project["governed"] == true {
        // A plan file can be seen before its transcript references. Reconcile all
        // discovered sources before any queued version is sent to the service.
        for queued in db::rows(db,"SELECT json_object('id',id,'value',json(value),'error',error) FROM outbox WHERE project=? AND json_extract(value,'$.resource.kind')='plan'",&[&project_id])? {
            let mut change=queued["value"].clone();
            if !crate::sources::matches(project, &change["resource"]) { continue; }
            let mut known=change["resource"]["contextSources"].as_array().cloned().unwrap_or_default();
            for source in scanned_sources(db,project,change["resource"]["logicalPath"].as_str().ok_or("Missing plan path")?,None)?.as_array().cloned().unwrap_or_default() {if !known.contains(&source){known.push(source);}}
            if change["resource"]["contextSources"]!=json!(known) {
                let old_id=queued["id"].as_str().ok_or("Missing request ID")?;
                let held=held_capture_key(old_id);
                // While deleted, only never-sent captures are rewritten; a row
                // queued before the deletion stays exactly as it was.
                let tx=db.unchecked_transaction().map_err(|e|e.to_string())?;
                if earlier_plans.contains(old_id)
                    || (project["captureOnly"] == true
                        && (!queued["error"].is_null() || !held_in_deletion(&db::get(&tx, &held)?, project))) {
                    continue;
                }
                let new_id=Uuid::new_v4().to_string();change["id"]=json!(new_id);change["resource"]["contextSources"]=json!(known);
                tx.execute("UPDATE outbox SET id=?,value=?,error=NULL WHERE id=?",params![new_id,change.to_string(),old_id]).map_err(|e|e.to_string())?;
                // The held marker follows the row to its new request ID.
                tx.execute("UPDATE meta SET key=? WHERE key=?",params![held_capture_key(&new_id),held]).map_err(|e|e.to_string())?;
                tx.commit().map_err(|e|e.to_string())?;
            }
        }
    }
    for b in db::rows(
        db,
        "SELECT value FROM bindings WHERE project=?",
        &[&project_id],
    )? {
        let base = &b["base"];
        if crate::pi_sessions::is_private_copy(&b) || !crate::sources::matches(project, base) {
            continue;
        }
        let Some(id) = base["resourceId"].as_str() else {
            continue;
        };
        if seen.contains(id) || base["deleted"] == true || b["needsCopy"] == true {
            continue;
        }
        let result = (|| {
            let kind = base["kind"].as_str().unwrap_or("");
            if !crate::projects::sharing_allowed(project, kind) {
                return Ok(());
            }
            if kind == "plan" {
                if let Some(path) = b["paths"][0].as_str() {
                    let path = Path::new(path);
                    if path.starts_with(root.join(".orka/plans"))
                        && path.try_exists().map_err(|e| e.to_string())?
                    {
                        plans::check_path(&root, path)?;
                        collect_plan_file(
                            db,
                            &blobs,
                            project,
                            base["source"].as_str().ok_or("Missing plan source")?,
                            base["logicalPath"].as_str().ok_or("Missing plan path")?,
                            path,
                            &mut seen,
                        )?;
                        return Ok(());
                    }
                }
            }
            if project["governed"] == true && matches!(kind, "memory" | "skill") {
                if crate::governance::protected(base)
                    && b["paths"].is_array()
                    && b["base"]["deleted"] != true
                {
                    let mut next = b.clone();
                    if crate::sync::live_hash(&b, kind, &root)?
                        .iter()
                        .any(|h| h != &manifest_hash(&base["files"]))
                    {
                        next["installationState"] = json!("locally_modified");
                        db::upsert(
                            db,
                            "bindings",
                            base["resourceId"].as_str().ok_or("Missing resource")?,
                            project_id,
                            &next,
                        )?;
                    }
                }
                return Ok(());
            }
            if kind == "session" && !sessions_complete {
                return Ok(());
            }
            // Claude's directory, settings and mounts can change independently
            // of the connected folder. Absence is not an explicit shared delete.
            if kind == "memory"
                && (!memory_complete || base["source"] == "codex" || base["source"] == "claude")
            {
                return Ok(());
            }
            if kind == "plan"
                && base["logicalPath"]
                    .as_str()
                    .is_some_and(|p| p.contains("/sessions/"))
            {
                return Ok(());
            }
            let paths = b["paths"].as_array().ok_or("Missing binding paths")?;
            for p in paths {
                Path::new(p.as_str().ok_or("Invalid path")?)
                    .try_exists()
                    .map_err(|e| e.to_string())?;
            }
            let codex_archived = if kind == "session" && base["source"] == "codex" {
                if let (Some(path), Some(native_id)) = (
                    paths.first().and_then(Value::as_str),
                    b["nativeId"].as_str(),
                ) {
                    crate::history::current_path(Path::new(path), native_id)?
                        .starts_with(native::codex_home()?.join("archived_sessions"))
                } else {
                    false
                }
            } else {
                false
            };
            if !codex_archived
                && (paths.is_empty()
                    || paths
                        .iter()
                        .any(|p| p.as_str().is_some_and(|p| Path::new(p).exists())))
            {
                return Ok(());
            }
            if kind == "session"
                && native::active(
                    db,
                    b["nativeId"].as_str().unwrap_or(""),
                    base["source"].as_str().unwrap_or(""),
                )
            {
                return Ok(());
            }
            collect(
                db,
                project,
                Scanned {
                    kind,
                    source: base["source"].as_str().ok_or("Missing source")?,
                    logical: base["logicalPath"].as_str().ok_or("Missing logical path")?,
                    title: base["title"].as_str().ok_or("Missing title")?,
                    files: vec![],
                    paths: vec![],
                    native_id: b["nativeId"].as_str(),
                    native_parent: None,
                },
                &mut seen,
            )?;
            Ok(())
        })();
        crate::sync::record_result(db, &format!("{scan_id}:scan:{id}"), result)?;
    }
    if let Some(detail) = progress_state.borrow_mut().1.take() {
        crate::sync::progress(db, "Checking local files", Some(&detail), 0, None)?;
    }
    Ok(())
}
pub fn memory_index(db: &rusqlite::Connection, project: &Value) -> Result<()> {
    for source in crate::sources::views(project) {
        let result = source_memory_index(db, &source);
        crate::sync::record_result(
            db,
            &format!(
                "{}:memory-index:{}",
                project["id"].as_str().unwrap_or(""),
                source["sourceId"].as_str().unwrap_or("default")
            ),
            result,
        )?;
    }
    Ok(())
}

fn memory_index_fingerprint(
    project: &Value,
    memory_id: &str,
    blobs: &db::BlobStore,
    resources: &[Value],
) -> String {
    let entries: Vec<Value> = resources
        .iter()
        .map(|r| {
            let blobs_present = r["files"]
                .as_array()
                .is_some_and(|files| blobs.all_present(files));
            json!([
                r["resourceId"],
                r["sourceId"],
                r["revision"],
                r["logicalPath"],
                r["title"],
                r["source"],
                r["updatedAt"],
                r["updatedBy"],
                r["memory"],
                r["access"],
                r["files"],
                blobs_present
            ])
        })
        .collect();
    db::digest(
        json!([
            memory_id,
            project["governed"],
            project["sourceId"],
            project["path"],
            project["sharing"],
            entries
        ])
        .to_string()
        .as_bytes(),
    )
}

fn memory_index_cache_valid(
    blobs: &db::BlobStore,
    root: &Path,
    index_path: &Path,
    fingerprint: &str,
    cached: &scan_cache::CachedMemoryIndex,
) -> bool {
    if cached.fingerprint != fingerprint {
        return false;
    }
    if scan_cache::FileStamp::of(index_path).as_ref() != Some(&cached.index_stamp) {
        return false;
    }
    let mut checked_parents = HashSet::new();
    for target in &cached.targets {
        let Some(parent) = target.path.parent() else {
            return false;
        };
        if checked_parents.insert(parent)
            && packages::check_existing_directory(root, parent).is_err()
        {
            return false;
        }
        if scan_cache::FileStamp::of(&target.path).as_ref() != Some(&target.stamp)
            || !blobs.present(&target.hash, target.size)
        {
            return false;
        }
    }
    true
}

fn source_memory_index(db: &rusqlite::Connection, project: &Value) -> Result<()> {
    if !crate::projects::sharing_allowed(project, "memory") {
        return Ok(());
    }
    let Some(raw) = project["path"].as_str() else {
        return Ok(());
    };
    crate::sources::validate(project)?;
    crate::governance::detach_legacy_memory(db, project)?;
    let root = Path::new(raw);
    let directory = root.join(".orka/memory");
    packages::safe_directory(root, &directory)?;
    let project_id = project["id"].as_str().ok_or("Missing project")?;
    let memory_id = project["sourceId"]
        .as_str()
        .map(|source| format!("{project_id}:{source}"))
        .unwrap_or(project_id.into());
    let resources=db::rows(db,"SELECT value FROM resources WHERE project=? AND json_extract(value,'$.kind')='memory' AND json_extract(value,'$.deleted')=0 ORDER BY id",&[&project_id])?;
    let error_glob = format!("{memory_id}:memory-index:*");
    let has_errors: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM errors WHERE source GLOB ?)",
            [&error_glob],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())?;
    let blobs = db::BlobStore::current()?;
    let index_path = directory.join("index.md");
    let fingerprint = memory_index_fingerprint(project, &memory_id, &blobs, &resources);
    let cache_key = scan_cache::memory_index_key(project_id, &memory_id);
    if !has_errors {
        if let Some(cached) = scan_cache::load_memory_index(db, &cache_key)? {
            if memory_index_cache_valid(&blobs, root, &index_path, &fingerprint, &cached) {
                db::set(
                    db,
                    &format!("contextSources:{project_id}"),
                    &json!(cached.sources),
                )?;
                return Ok(());
            }
        }
    }
    #[cfg(test)]
    scan_cache::record_memory_index_build(&memory_id);
    let canonical_text: HashMap<String, String> = memory_context::catalog(db, project)?
        .into_iter()
        .filter_map(|entry| {
            entry.resource["resourceId"]
                .as_str()
                .map(|id| (id.to_owned(), entry.text))
        })
        .collect();
    if has_errors {
        db.execute("DELETE FROM errors WHERE source GLOB ?", [&error_glob])
            .map_err(|e| e.to_string())?;
    }
    let superseded = resources
        .iter()
        .flat_map(|r| {
            r["memory"]["supersedes"]
                .as_array()
                .cloned()
                .unwrap_or_default()
        })
        .collect::<Vec<_>>();
    let mut text=String::from("# Shared project knowledge\n\nUse these as scoped reference facts. Keep personal learning in your native memory. Submit changes through Orka; local drafts are private.\n\n");
    let mut sources = Vec::new();
    let mut targets = Vec::new();
    let mut had_error = false;
    let mut cacheable = true;
    let mut checked_parents = HashSet::new();
    for r in resources {
        if !crate::sources::matches(project, &r) {
            continue;
        }
        if project["governed"] == true
            && (crate::governance::protected(&r) || superseded.contains(&r["resourceId"]))
        {
            continue;
        }
        let id = r["resourceId"].as_str().ok_or("Missing resource")?;
        let result: Result<(String, Option<scan_cache::CachedMemoryIndexTarget>)> = (|| {
            let target = if project["governed"] == true {
                directory.join("resources").join(id).join("content.md")
            } else {
                directory.join(packages::safe_relative(
                    r["logicalPath"].as_str().ok_or("Missing memory path")?,
                )?)
            };
            let file = r["files"]
                .as_array()
                .and_then(|v| v.first())
                .ok_or("Missing memory file")?;
            let hash = file["hash"].as_str().ok_or("Missing hash")?;
            let size = file["size"].as_u64().ok_or("Missing size")?;
            let parent = target.parent().ok_or("No parent")?;
            let before = scan_cache::FileStamp::of(&target);
            let is_regular = before.is_some();
            let mut local_file: Option<Value> = None;
            if project["governed"] == true && target.is_file() {
                if !checked_parents.contains(parent) {
                    packages::check_existing_directory(root, parent)?;
                    checked_parents.insert(parent.to_path_buf());
                }
                let local = if is_regular {
                    scan_cache::package_file(db, &blobs, &target, "content.md")?
                } else {
                    packages::file(&target, "content.md")?
                };
                if local["hash"] != file["hash"] {
                    let mut draft = r.clone();
                    draft["files"] = json!([local]);
                    crate::governance::capture(db, project, &draft, &json!([target]))?;
                }
                local_file = Some(local);
            }
            let owned_content;
            let content = if let Some(text) = canonical_text.get(id) {
                text.as_str()
            } else {
                owned_content =
                    String::from_utf8(db::blob_read(hash)?).map_err(|_| "Memory must be UTF-8")?;
                owned_content.as_str()
            };
            let parent_safe_existing = checked_parents.contains(parent)
                || packages::check_existing_directory(root, parent)
                    .map(|()| {
                        checked_parents.insert(parent.to_path_buf());
                    })
                    .is_ok();
            let already_written = if is_regular && parent_safe_existing && blobs.present(hash, size)
            {
                let local = match local_file {
                    Some(local) => local,
                    None => scan_cache::package_file(db, &blobs, &target, "content.md")?,
                };
                local["hash"] == file["hash"]
                    && local["size"] == file["size"]
                    && local["executable"] == file["executable"]
            } else {
                false
            };
            let stamp = if already_written {
                before.filter(|stamp| scan_cache::FileStamp::of(&target).as_ref() == Some(stamp))
            } else {
                packages::write_file(root, &target, file)?;
                checked_parents.insert(parent.to_path_buf());
                scan_cache::verified_stamp(&target, hash, size)
            };
            let cached_target = stamp.map(|stamp| scan_cache::CachedMemoryIndexTarget {
                path: target.clone(),
                stamp,
                hash: hash.to_owned(),
                size,
            });
            if !canonical_text.contains_key(id) {
                return Ok((String::new(), cached_target));
            }
            Ok((
                format!(
                    "## {} [{}]\nScope: {} | Author: {} | Resource: {}\nFile: {}\n{}\n\n",
                    r["title"].as_str().unwrap_or("Knowledge"),
                    r["memory"]["provider"]
                        .as_str()
                        .or(r["source"].as_str())
                        .unwrap_or("shared"),
                    r["memory"]["scope"]
                        .as_str()
                        .filter(|s| !s.is_empty())
                        .unwrap_or("project"),
                    r["updatedBy"].as_str().unwrap_or("unknown"),
                    id,
                    target.display(),
                    memory_context::preview(content)
                ),
                cached_target,
            ))
        })();
        let source = format!("{memory_id}:memory-index:{id}");
        match result {
            Ok((entry, cached_target)) => {
                if let Some(target) = cached_target {
                    targets.push(target);
                } else {
                    cacheable = false;
                }
                if entry.is_empty() {
                    continue;
                }
                text.push_str(&entry);
                sources.push(json!(id));
            }
            Err(err) => {
                had_error = true;
                error(db, &source, &err)?;
            }
        }
    }
    db::set(db, &format!("contextSources:{project_id}"), &json!(sources))?;
    let index_hash = db::digest(text.as_bytes());
    let index_size = text.len() as u64;
    let mut index_stamp = scan_cache::verified_stamp(&index_path, &index_hash, index_size);
    if index_stamp.is_none() {
        db::atomic(&index_path, text.as_bytes())?;
        index_stamp = scan_cache::verified_stamp(&index_path, &index_hash, index_size);
    }
    if !had_error && cacheable {
        if let Some(index_stamp) = index_stamp {
            scan_cache::save_memory_index(
                db,
                &cache_key,
                &scan_cache::CachedMemoryIndex {
                    fingerprint,
                    index_stamp,
                    targets,
                    sources,
                },
            )?;
        }
    } else {
        scan_cache::clear_memory_index(db, &cache_key)?;
    }
    Ok(())
}
