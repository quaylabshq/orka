use crate::{
    db::{self, Result},
    indexer, native, projects, sync,
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
        .map(|source| {
            let mut view = project.clone();
            view["sourceId"] = source["id"].clone();
            view["path"] = source["path"].clone();
            view["folderIdentity"] = source["folderIdentity"].clone();
            view["repository"] = source["repository"].clone();
            view["repositoryRevision"] = source["repositoryRevision"].clone();
            view
        })
        .collect()
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

pub fn validate(project: &Value) -> Result<()> {
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
    if let Some(url) = project["repository"]["cloneUrl"].as_str() {
        if let Err(error) = crate::repositories::verify_remote(root, url) {
            if !project["repository"]["previousCloneUrls"]
                .as_array()
                .is_some_and(|urls| {
                    urls.iter()
                        .filter_map(Value::as_str)
                        .any(|url| crate::repositories::verify_remote(root, url).is_ok())
                })
            {
                return Err(error);
            }
        }
    }
    Ok(())
}

/// Presentation-only local state; paths and identity checks remain native.
pub fn folder_state(source: &Value) -> &'static str {
    if !source["path"].is_string() {
        "locate"
    } else if validate(source).is_ok() {
        "connected"
    } else {
        "reconnect"
    }
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
    connect_sources_locked(id, paths, source_id, context, sharing, lock).await
}

/// Keep the clone's verified repository binding and the attachment under one
/// workspace lock. Cloning supplies exactly one finished checkout and source.
pub(crate) async fn connect_sources_locked(
    id: String,
    paths: Vec<String>,
    source_id: Option<String>,
    context: Option<(&str, &str)>,
    sharing: Option<projects::Sharing>,
    _lock: fs::File,
) -> Result<()> {
    let db = db::open()?;
    if let Some((user, service)) = context {
        if db::get(&db, "user")? != user || db::get(&db, "config")?["apiUrl"] != service {
            return Err("Account or service changed; reopen repository setup".into());
        }
    }
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
                    source_id.as_ref().map_or(
                        source["name"] == name
                            && source["path"]
                                .as_str()
                                .is_none_or(|path| Path::new(path) == root),
                        |id| source["id"] == *id,
                    )
                })
                .map(|(index, _)| index)
                .collect()
        };
        let index = match candidates.as_slice() {
            [index] => *index,
            [] if source_id.is_some() => return Err("Repository no longer belongs to this project; refresh and try again".into()),
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
        if sources[index]["path"].is_null() {
            if let Some(source) = sources[index]["id"].as_str() {
                newly_connected.push(source.to_owned());
            }
        }
        sources[index]["path"] = json!(root);
        sources[index]["folderIdentity"] = json!(indexer::folder_identity(&root)?);
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
    for source in &sources {
        if let Some(path) = source["path"]
            .as_str()
            .filter(|path| used.contains(Path::new(path)))
        {
            let mut view = project.clone();
            view["path"] = source["path"].clone();
            view["folderIdentity"] = source["folderIdentity"].clone();
            view["repository"] = source["repository"].clone();
            validate(&view)?;
            native::Hooks::install(Path::new(path))?;
        }
    }
    project["sources"] = json!(sources);
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
    db::upsert(&db, "projects", &id, &id, &project)?;
    db::set(&db, &pending_key, &Value::Null)?;
    if newly_connected.is_empty() {
        return SyncQueue::request(&db, &id, Priority::User, "project");
    }
    // A folder connected on this Mac waits a few minutes before its first sync.
    let at = chrono::Utc::now().timestamp_millis() + NEW_FOLDER_DELAY_MS;
    db::set(&db, &format!("firstScan:{id}"), &Value::Null)?;
    for source in &newly_connected {
        db::set(&db, &sync_after_key(&id, source), &json!(at))?;
    }
    SyncQueue::request_at(&db, &id, Priority::User, "new folder", at)
}

/// Queued uploads that may belong to `source`. A change whose source cannot be
/// determined counts too, so disconnecting never strands unsent work.
pub(crate) fn queued_for_source(
    db: &rusqlite::Connection,
    project: &str,
    source: &str,
) -> Result<i64> {
    db.query_row(
        "SELECT count(*) FROM outbox o LEFT JOIN resources r ON r.project=o.project AND r.id=json_extract(o.value,'$.resourceId') \
         WHERE o.project=?1 AND coalesce(json_extract(o.value,'$.resource.sourceId'),json_extract(o.value,'$.sourceId'),json_extract(r.value,'$.sourceId'),?2)=?2",
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
    db::upsert(&db, "projects", &id, &id, &project)?;
    clear_sync_after(&db, &id, &source_id)?;
    db.execute(
        "DELETE FROM bindings WHERE project=? AND json_extract(value,'$.base.sourceId')=?",
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
