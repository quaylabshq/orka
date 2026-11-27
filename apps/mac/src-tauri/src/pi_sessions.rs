use crate::{
    db::{self, Result},
    history, native, packages,
};
use serde_json::{json, Value};
use std::{
    collections::HashMap,
    fs,
    path::{Path, PathBuf},
};
use uuid::Uuid;

pub(crate) fn directory() -> Result<PathBuf> {
    #[cfg(debug_assertions)]
    if std::env::var_os("ORKA_TEST_HOME").is_some() {
        return Ok(db::home()?.join(".pi/agent/sessions"));
    }
    if let Some(path) = std::env::var_os("PI_CODING_AGENT_SESSION_DIR").filter(|p| !p.is_empty()) {
        return Ok(expand_home(path.into(), &db::home()?));
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
        .map_or_else(
            || db::home().map(|home| home.join(".pi/agent")),
            |path| Ok(expand_home(path, &db::home()?)),
        )
}

fn expand_home(path: PathBuf, home: &Path) -> PathBuf {
    match path.strip_prefix("~") {
        Ok(relative) if relative.as_os_str().is_empty() => home.to_path_buf(),
        Ok(relative) => home.join(relative),
        Err(_) => path,
    }
}

#[test]
fn pi_directory_overrides_expand_only_a_leading_home_component() {
    let home = Path::new("/Users/pi");
    assert_eq!(
        expand_home("~/custom/sessions".into(), home),
        home.join("custom/sessions")
    );
    assert_eq!(expand_home("~".into(), home), home);
    assert_eq!(
        expand_home("~other/sessions".into(), home),
        Path::new("~other/sessions")
    );
}

pub(crate) fn copy_directory() -> Result<PathBuf> {
    Ok(db::root()?.join("pi-session-copies"))
}

pub(crate) fn is_private_copy(binding: &Value) -> bool {
    binding.get("piCopyOrigin").is_some() && binding["base"]["source"] == "pi"
}

/// SQL condition for a private Pi copy's binding, which is its only record.
pub(crate) const COPY_BINDING: &str = " AND json_type(value,'$.piCopyOrigin') IS NOT NULL";

/// Folder disconnects keep private Pi copies so they reappear on reconnect.
pub(crate) const KEEP_COPY_BINDINGS: &str = " AND NOT (json_extract(value,'$.base.source')='pi' AND json_type(value,'$.piCopyOrigin') IS NOT NULL)";

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

/// The redacted bytes of a private copy as its file now reads, independent of
/// the checkout path. Unreadable or invalid files fall back to the stored snapshot.
pub(crate) fn live_copy_bytes(binding: &Value) -> Option<Vec<u8>> {
    let path = copy_location(binding).ok()?;
    let mut records = valid_records(&path)?;
    if records[0]["id"] != binding["nativeId"] {
        return None;
    }
    records
        .iter_mut()
        .for_each(crate::session_redaction::SessionRedactor::redact);
    Some(native::encode(&records))
}

pub(crate) fn with_session_file(resource: &Value, bytes: &[u8], hash: &str) -> Value {
    let mut current = resource.clone();
    current["files"] =
        json!([{"path":"session.jsonl","hash":hash,"size":bytes.len(),"executable":false}]);
    current["hash"] = json!(crate::indexer::manifest_hash(&current["files"]));
    current
}

pub(crate) fn copy_snapshot_bytes(
    binding: &Value,
    resource: &Value,
    read_blob: &impl Fn(&str) -> Result<Vec<u8>>,
) -> Result<Vec<u8>> {
    if let Some(bytes) = live_copy_bytes(binding) {
        return Ok(bytes);
    }
    let mut records = history::resource_records_with(resource, read_blob)?;
    records
        .iter_mut()
        .for_each(crate::session_redaction::SessionRedactor::redact);
    Ok(native::encode(&records))
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
fn fork_records(db: &rusqlite::Connection, resource: &Value) -> Result<Vec<Value>> {
    // An unusable own file falls back to the snapshot like a missing copy does.
    let (path, binding) =
        if let Ok(Some(binding)) = crate::local_resources::native_binding(db, resource) {
            (binding["paths"][0].as_str().map(PathBuf::from), binding)
        } else {
            let id = resource["resourceId"].as_str().ok_or("Missing session")?;
            let binding = crate::indexer::binding(db, id)?;
            let path = is_private_copy(&binding)
                .then(|| copy_location(&binding).ok())
                .flatten();
            (path, binding)
        };
    if let Some(path) = path {
        if let Some(records) =
            local_records(&path)?.filter(|records| records[0]["id"] == binding["nativeId"])
        {
            return Ok(records);
        }
    }
    let mut records = history::resource_records(resource)?;
    records
        .iter_mut()
        .for_each(crate::session_redaction::SessionRedactor::redact);
    Ok(records)
}

/// The raw records of a local Pi file under Pi's or Orka's session directory.
/// None means the file has no valid session, so the fork uses the snapshot.
fn local_records(path: &Path) -> Result<Option<Vec<Value>>> {
    let allowed = [directory()?, copy_directory()?];
    let Ok(actual) = path.canonicalize() else {
        return Ok(None);
    };
    if !allowed
        .iter()
        .filter_map(|home| home.canonicalize().ok())
        .any(|home| actual.starts_with(home))
    {
        return Ok(None);
    }
    Ok(valid_records(&actual))
}

fn valid_records(path: &Path) -> Option<Vec<Value>> {
    let bytes = history::read_session(path).ok()?;
    let records = native::complete_records(&bytes).ok()?;
    native::validate_session_import("pi", &records).ok()?;
    Some(records)
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
    crate::compat::set_permissions_owner_rwx(directory)?;
    Ok(lock)
}

pub(crate) fn launch_in_use(path: &Path) -> bool {
    use fs2::FileExt;
    let Ok(lock) = lock_file(path) else {
        return true;
    };
    match fs::File::open(lock) {
        Ok(file) => file.try_lock_exclusive().is_err(),
        Err(error) => error.kind() != std::io::ErrorKind::NotFound,
    }
}

pub(crate) fn fork(db: &rusqlite::Connection, project: &Value, resource: &Value) -> Result<Value> {
    let root = Path::new(project["path"].as_str().ok_or("Connect a folder first")?);
    let mut records = fork_records(db, resource)?;
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
    crate::compat::set_permissions_owner_rwx(&directory)?;
    let path = directory.join(format!("{id}.jsonl"));
    db::atomic(&path, &native::encode(&records))?;
    // The stored snapshot, like every other cached session, is redacted.
    records
        .iter_mut()
        .for_each(crate::session_redaction::SessionRedactor::redact);
    let bytes = native::encode(&records);
    let hash = db::blob(&bytes)?;
    let mut base = resource.clone();
    let fields = base.as_object_mut().ok_or("Invalid Pi session resource")?;
    for key in [
        "paths",
        "nativeId",
        "nativeSession",
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
