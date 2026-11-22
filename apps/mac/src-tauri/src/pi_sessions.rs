use crate::{
    db::{self, Result},
    history, native, packages,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    os::unix::fs::PermissionsExt,
    path::{Path, PathBuf},
};
use uuid::Uuid;

pub(crate) fn directory() -> Result<PathBuf> {
    #[cfg(debug_assertions)]
    if std::env::var_os("ORKA_TEST_HOME").is_some() {
        return Ok(db::home()?.join(".pi/agent/sessions"));
    }
    if let Some(path) = std::env::var_os("PI_CODING_AGENT_SESSION_DIR").filter(|p| !p.is_empty()) {
        return Ok(path.into());
    }
    Ok(agent_directory()?.join("sessions"))
}

pub(crate) fn agent_directory() -> Result<PathBuf> {
    #[cfg(debug_assertions)]
    if std::env::var_os("ORKA_TEST_HOME").is_some() {
        return Ok(db::home()?.join(".pi/agent"));
    }
    std::env::var_os("PI_CODING_AGENT_DIR")
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .map_or_else(|| db::home().map(|home| home.join(".pi/agent")), Ok)
}

pub(crate) fn copy_directory() -> Result<PathBuf> {
    Ok(db::root()?.join("pi-session-copies"))
}

pub(crate) fn is_private_copy(binding: &Value) -> bool {
    binding.get("piCopyOrigin").is_some() && binding["base"]["source"] == "pi"
}

pub(crate) fn copy_location(binding: &Value) -> Result<PathBuf> {
    let id = binding["nativeId"]
        .as_str()
        .ok_or("Missing Pi session ID")?;
    Uuid::parse_str(id).map_err(|_| "Invalid Pi session ID")?;
    let directory = copy_directory()?;
    let path = directory.join(format!("{id}.jsonl"));
    if binding["paths"] != json!([path])
        || !std::fs::symlink_metadata(&directory).is_ok_and(|meta| meta.is_dir())
        || !std::fs::symlink_metadata(&path).is_ok_and(|meta| meta.is_file())
    {
        return Err(
            "The local Pi copy is unavailable. Choose Fork and open to create another copy.".into(),
        );
    }
    Ok(path)
}

pub(crate) fn copy_path(binding: &Value, root: &Path) -> Result<PathBuf> {
    let path = copy_location(binding)?;
    let records = native::complete_records(&history::read_session(&path)?)?;
    let (actual, cwd, _) = native::session_info("pi", &records)?;
    if binding["nativeId"] != actual || cwd != root {
        return Err("The local Pi copy no longer matches its session or repository.".into());
    }
    Ok(path)
}

/// The Pi file a launch opens: a private copy, or the user's own native session
/// that `local_resources::native_binding` already validated.
pub(crate) fn launch_path(binding: &Value, root: &Path) -> Result<PathBuf> {
    if is_private_copy(binding) {
        return copy_path(binding, root);
    }
    let path = PathBuf::from(
        binding["paths"][0]
            .as_str()
            .ok_or("Pi session file unavailable")?,
    );
    let home = directory()?.canonicalize().map_err(|e| e.to_string())?;
    if !path.is_file()
        || !path
            .canonicalize()
            .is_ok_and(|path| path.starts_with(&home))
    {
        return Err("This Pi session moved. Open the collection again.".into());
    }
    Ok(path)
}

/// Fork from the session's own local file when there is one, so a copy keeps
/// every turn and unredacted content. Shared or unreadable sessions fall back to
/// the stored snapshot.
pub(crate) fn fork_snapshot(db: &rusqlite::Connection, resource: &Value) -> Result<Value> {
    // An unusable own file falls back to the snapshot like a missing copy does.
    let path = if let Ok(Some(native)) = crate::local_resources::native_binding(db, resource) {
        native["paths"][0].as_str().map(PathBuf::from)
    } else {
        let id = resource["resourceId"].as_str().ok_or("Missing session")?;
        let binding = crate::indexer::binding(db, id)?;
        is_private_copy(&binding)
            .then(|| copy_location(&binding).ok())
            .flatten()
    };
    let Some(path) = path else {
        return Ok(resource.clone());
    };
    let bytes = match fs::read(&path) {
        Ok(bytes) => bytes,
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => return Ok(resource.clone()),
        Err(error) => return Err(error.to_string()),
    };
    let valid = native::complete_records(&bytes)
        .is_ok_and(|records| records.first().is_some_and(|r| r["type"] == "session"));
    if !valid {
        return Ok(resource.clone());
    }
    let mut snapshot = resource.clone();
    snapshot["files"] = json!([{"path":"session.jsonl","hash":db::blob(&bytes)?,"size":bytes.len(),"executable":false}]);
    Ok(snapshot)
}

/// Keep copies of a deleted or inaccessible shared session as local-only work.
pub(crate) fn detach_copies(db: &rusqlite::Connection, project: &str, origin: &str) -> Result<()> {
    db.execute(
        "UPDATE bindings SET value=json_set(value,'$.piCopyOrigin',json('null')) WHERE project=?1 AND json_extract(value,'$.base.source')='pi' AND json_extract(value,'$.piCopyOrigin')=?2",
        [project, origin],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

/// Orka-owned lock for a Pi session file, kept outside Pi's own directories.
pub(crate) fn lock_file(path: &Path) -> Result<PathBuf> {
    let path = path.canonicalize().unwrap_or_else(|_| path.to_path_buf());
    Ok(db::root()?.join("pi-session-locks").join(format!(
        "{}.lock",
        db::digest(path.to_string_lossy().as_bytes())
    )))
}

pub(crate) fn prepare_lock(path: &Path) -> Result<PathBuf> {
    let lock = lock_file(path)?;
    let directory = lock.parent().ok_or("Missing lock directory")?;
    packages::safe_directory(&db::root()?, directory)?;
    fs::set_permissions(directory, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    Ok(lock)
}

pub(crate) fn launch_in_use(path: &Path) -> bool {
    use std::os::fd::AsRawFd;
    let Ok(lock) = lock_file(path) else {
        return true;
    };
    match fs::File::open(lock) {
        Ok(file) => {
            // The terminal's lockf process holds this same lock until Pi exits.
            unsafe { libc::flock(file.as_raw_fd(), libc::LOCK_EX | libc::LOCK_NB) != 0 }
        }
        Err(error) => error.kind() != std::io::ErrorKind::NotFound,
    }
}

pub(crate) fn fork(project: &Value, resource: &Value) -> Result<Value> {
    let root = Path::new(project["path"].as_str().ok_or("Connect a folder first")?);
    let mut records = history::resource_records(resource)?;
    let header = records[0]
        .as_object_mut()
        .ok_or("Missing Pi session header")?;
    let id = Uuid::new_v4().to_string();
    header.remove("parentSession");
    header.insert("id".into(), json!(id));
    header.insert("cwd".into(), json!(root));
    header.insert("timestamp".into(), json!(db::now()));
    let directory = copy_directory()?;
    packages::safe_directory(&db::root()?, &directory)?;
    fs::set_permissions(&directory, fs::Permissions::from_mode(0o700))
        .map_err(|e| e.to_string())?;
    let path = directory.join(format!("{id}.jsonl"));
    let bytes = native::encode(&records);
    let hash = db::blob(&bytes)?;
    db::atomic(&path, &bytes)?;
    let mut base = resource.clone();
    let fields = base.as_object_mut().ok_or("Invalid Pi session resource")?;
    for key in [
        "paths",
        "nativeId",
        "local",
        "localChanges",
        "sharedRevision",
        "localForkId",
        "nativeForkParentId",
    ] {
        fields.remove(key);
    }
    base["resourceId"] = json!(Uuid::new_v4());
    base["files"] =
        json!([{"path":"session.jsonl","hash":hash,"size":bytes.len(),"executable":false}]);
    Ok(json!({"base":base,"nativeId":id,"paths":[path]}))
}

pub(crate) fn branch(records: &[Value]) -> Result<Vec<&Value>> {
    let header = records.first().ok_or("Missing Pi session header")?;
    if header["type"] != "session" || !matches!(header["version"].as_u64(), Some(2 | 3)) {
        return Err("Unsupported Pi session format; original preserved".into());
    }
    let mut entries = HashMap::with_capacity(records.len() - 1);
    let mut leaf = None;
    for record in &records[1..] {
        let id = record["id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or("Missing Pi entry ID")?;
        let parent = match record.get("parentId") {
            Some(Value::Null) => None,
            Some(Value::String(parent)) if entries.contains_key(parent.as_str()) => {
                Some(parent.as_str())
            }
            _ => return Err("Invalid Pi entry parent".into()),
        };
        if !record["type"]
            .as_str()
            .is_some_and(|kind| !kind.is_empty() && kind != "session")
            || entries.insert(id, (record, parent)).is_some()
        {
            return Err("Invalid Pi session tree".into());
        }
        leaf = Some(id);
    }

    // Pi reopens at the last persisted entry, not at the last message.
    let mut branch = Vec::new();
    while let Some(id) = leaf {
        let (record, parent) = entries[id];
        branch.push(record);
        leaf = parent;
    }
    branch.reverse();
    Ok(branch)
}
