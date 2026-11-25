//! Offline reclamation of unreferenced transcript blobs in one Orka profile.
use crate::{db, history, profiles, session_translation};
use fs2::FileExt;
use rusqlite::{Connection, OpenFlags};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::{
    collections::{BTreeMap, BTreeSet},
    ffi::CString,
    fs::{self, File, Metadata, OpenOptions},
    io::{self, BufRead, BufReader, Read},
    os::{
        fd::{AsRawFd, FromRawFd},
        unix::{
            ffi::OsStrExt,
            fs::{MetadataExt, OpenOptionsExt},
        },
    },
    path::{Path, PathBuf},
};
use uuid::Uuid;

const RUNTIME_LOCK: &str = "session-storage.lock";
const LEGACY_LOCKS: &[&str] = &["ui.lock", "daemon.lock", "workspace.lock"];
// Historical account databases can predate drafts. Any existing drafts are
// still scanned for references through VALUE_TABLES.
const CORE_TABLES: &[&str] = &["meta", "resources", "bindings", "outbox", "conflicts"];
const VALUE_TABLES: &[&str] = &[
    "projects",
    "resources",
    "bindings",
    "outbox",
    "conflicts",
    "drafts",
    "local_resources",
    "active",
    "activity",
    "worktree_routes",
    "worktree_sessions",
    "worktree_artifacts",
];

/// Hold for the lifetime of each invocation, including readers and CLI helpers.
pub(crate) fn lock_runtime() -> db::Result<File> {
    let root = db::root()?;
    fs::create_dir_all(&root).map_err(|error| error.to_string())?;
    let file = open_lock(&root, RUNTIME_LOCK).map_err(str::to_owned)?;
    FileExt::try_lock_shared(&file).map_err(|_| {
        "Orka session storage maintenance is running. Try again shortly.".to_owned()
    })?;
    Ok(file)
}

pub(crate) fn run(arguments: &[String]) -> i32 {
    let apply = match arguments {
        [] => false,
        [flag] if flag == "--apply" => true,
        _ => {
            eprintln!("Usage: Orka --orka-clean-session-blobs [--profile NAME] [--apply]");
            return 2;
        }
    };
    let root = match db::root() {
        Ok(root) => root,
        Err(error) => {
            eprintln!("{error}");
            return 1;
        }
    };
    let report = inspect(
        &root,
        profiles::current(),
        apply,
        chrono::Utc::now().timestamp(),
    );
    println!(
        "{}",
        serde_json::to_string_pretty(&report).expect("cleanup report")
    );
    i32::from(apply && report.blocked)
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct Report {
    profile: String,
    applied: bool,
    blocked: bool,
    scopes: Vec<ScopeReport>,
}

#[derive(Default, Serialize)]
#[serde(rename_all = "camelCase")]
struct ScopeReport {
    scope: String,
    eligible_count: u64,
    eligible_allocated_bytes: u64,
    removed_count: u64,
    removed_allocated_bytes: u64,
    skips: BTreeMap<&'static str, u64>,
}

impl ScopeReport {
    fn new(scope: &str) -> Self {
        Self {
            scope: scope.to_owned(),
            ..Self::default()
        }
    }

    fn skip(&mut self, reason: &'static str) {
        *self.skips.entry(reason).or_default() += 1;
    }
}

type Result<T> = std::result::Result<T, &'static str>;

fn open_lock(root: &Path, name: &str) -> Result<File> {
    if !plain_directory(root)? {
        return Err("invalid_profile_directory");
    }
    let file = OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(root.join(name))
        .map_err(|_| "lock_unavailable")?;
    if !owned_file(&file.metadata().map_err(|_| "lock_unavailable")?) {
        return Err("invalid_lock");
    }
    Ok(file)
}

fn lock_for_apply(root: &Path) -> Result<Vec<File>> {
    std::iter::once(RUNTIME_LOCK)
        .chain(LEGACY_LOCKS.iter().copied())
        .map(|name| {
            let file = open_lock(root, name)?;
            FileExt::try_lock_exclusive(&file).map_err(|_| "profile_in_use")?;
            Ok(file)
        })
        .collect()
}

fn inspect(root: &Path, profile: &str, apply: bool, now: i64) -> Report {
    let mut report = Report {
        profile: profile.to_owned(),
        applied: apply,
        ..Report::default()
    };
    match inspect_profile(root, apply, now) {
        Ok(scopes) => {
            report.blocked = scopes.iter().any(|scope| {
                [
                    "file_changed",
                    "unlink_failed",
                    "store_read_failed",
                    "store_sync_failed",
                ]
                .into_iter()
                .any(|reason| scope.skips.contains_key(reason))
            });
            report.scopes = scopes;
        }
        Err(reason) => {
            report.blocked = true;
            let mut scope = ScopeReport::new("profile");
            scope.skip(reason);
            report.scopes.push(scope);
        }
    }
    report
}

fn inspect_profile(root: &Path, apply: bool, now: i64) -> Result<Vec<ScopeReport>> {
    if !plain_directory(root)? {
        return Ok(Vec::new());
    }
    let root = &fs::canonicalize(root).map_err(|_| "unreadable_directory")?;
    let _locks = apply.then(|| lock_for_apply(root)).transpose()?;
    let inventory = inventory(root)?;
    if inventory.stores.is_empty() {
        return Ok(Vec::new());
    }

    // A guest can use different origins over time. The legacy origin may have
    // accounts in both layouts, so protect references from every account and
    // guest DB in the profile before considering a store.
    let mut references = BTreeSet::new();
    for database in inventory.databases {
        scan_references(&database, apply, now, &mut references)?;
    }
    Ok(inventory
        .stores
        .into_iter()
        .map(|(scope, directory)| inspect_store(root, &scope, &directory, &references, apply))
        .collect())
}

#[derive(Default)]
struct Inventory {
    databases: Vec<PathBuf>,
    stores: Vec<(String, PathBuf)>,
}

fn inventory(root: &Path) -> Result<Inventory> {
    let mut result = Inventory::default();
    account_databases(root, true, &mut result.databases)?;
    let mut legacy_database_found = !result.databases.is_empty();
    let legacy = db::blob_dir_in_scope(root, None);
    let has_legacy_store = plain_directory(&legacy)?;
    let legacy_digest = if has_legacy_store && !legacy_database_found {
        legacy_scope_digest(root)?
    } else {
        None
    };
    if has_legacy_store {
        result.stores.push(("legacy".into(), legacy));
    }

    let services = root.join("services");
    if plain_directory(&services)? {
        let mut number = 0;
        for service in entries(&services)? {
            let Some(digest) = service.file_name().and_then(|name| name.to_str()) else {
                return Err("ambiguous_service_directory");
            };
            if !blob_hash(digest) || !plain_directory(&service)? {
                return Err("ambiguous_service_directory");
            }
            let before = result.databases.len();
            account_databases(&service, false, &mut result.databases)?;
            let has_accounts = before != result.databases.len();
            if has_accounts && legacy_digest.as_deref() == Some(digest) {
                legacy_database_found = true;
            }
            let blobs = db::blob_dir_in_scope(root, Some(digest));
            if plain_directory(&blobs)? {
                // Guest data can reference a service store even without a
                // signed-in account there. An empty account directory would
                // already have stopped the scan above.
                if !has_accounts && !root.join("guest/sync.sqlite").is_file() {
                    return Err("missing_database");
                }
                number += 1;
                result.stores.push((format!("service-{number}"), blobs));
            }
        }
    }
    if has_legacy_store && !legacy_database_found {
        return Err("missing_database");
    }
    Ok(result)
}

fn legacy_scope_digest(root: &Path) -> Result<Option<String>> {
    let path = root.join("legacy-service.json");
    let info = match fs::symlink_metadata(&path) {
        Ok(info) if owned_file(&info) && info.len() <= 64 * 1024 => info,
        Ok(_) => return Err("ambiguous_legacy_service"),
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => return Err("ambiguous_legacy_service"),
    };
    let file = OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(|_| "ambiguous_legacy_service")?;
    let origin: String = serde_json::from_reader(file.take(info.len() + 1))
        .map_err(|_| "ambiguous_legacy_service")?;
    Ok(Some(db::digest(origin.as_bytes())))
}

fn account_databases(root: &Path, guest: bool, databases: &mut Vec<PathBuf>) -> Result<()> {
    for directory in entries(root)? {
        let Some(name) = directory.file_name().and_then(|name| name.to_str()) else {
            continue;
        };
        if Uuid::parse_str(name).is_err() && !(guest && name == "guest") {
            continue;
        }
        if !plain_directory(&directory)? {
            return Err("ambiguous_account_directory");
        }
        let database = directory.join("sync.sqlite");
        match fs::symlink_metadata(&database) {
            Ok(info) if owned_file(&info) => databases.push(database),
            Ok(_) => return Err("invalid_database"),
            Err(error) if error.kind() == io::ErrorKind::NotFound => {
                return Err("missing_database")
            }
            Err(_) => return Err("unreadable_database"),
        }
    }
    Ok(())
}

fn plain_directory(path: &Path) -> Result<bool> {
    match fs::symlink_metadata(path) {
        Ok(info) if info.is_dir() && info.uid() == unsafe { libc::geteuid() } => Ok(true),
        Ok(_) => Err("unsafe_directory"),
        Err(error) if error.kind() == io::ErrorKind::NotFound => Ok(false),
        Err(_) => Err("unreadable_directory"),
    }
}

fn entries(path: &Path) -> Result<Vec<PathBuf>> {
    let mut result = fs::read_dir(path)
        .map_err(|_| "unreadable_directory")?
        .map(|entry| entry.map(|entry| entry.path()))
        .collect::<std::result::Result<Vec<_>, _>>()
        .map_err(|_| "unreadable_directory")?;
    result.sort();
    Ok(result)
}

fn owned_file(info: &Metadata) -> bool {
    info.is_file() && info.nlink() == 1 && info.uid() == unsafe { libc::geteuid() }
}

fn sidecars(database: &Path) -> Result<bool> {
    let directory = database.parent().ok_or("invalid_database")?;
    let mut pending = false;
    for name in ["sync.sqlite-wal", "sync.sqlite-shm", "sync.sqlite-journal"] {
        match fs::symlink_metadata(directory.join(name)) {
            Ok(info) if owned_file(&info) => pending = true,
            Ok(_) => return Err("invalid_database_sidecar"),
            Err(error) if error.kind() == io::ErrorKind::NotFound => (),
            Err(_) => return Err("unreadable_database"),
        }
    }
    Ok(pending)
}

fn scan_references(
    path: &Path,
    apply: bool,
    now: i64,
    references: &mut BTreeSet<String>,
) -> Result<()> {
    let sidecars_before = sidecars(path)?;
    if sidecars_before && !apply {
        // SQLite may update its shared-memory index even on a read-only
        // connection. A dry run leaves the profile tree completely untouched.
        return Err("database_has_journal");
    }
    let before = crate::scan_cache::FileStamp::of(path).ok_or("invalid_database")?;
    let flags = OpenFlags::SQLITE_OPEN_READ_ONLY
        | OpenFlags::SQLITE_OPEN_URI
        | OpenFlags::SQLITE_OPEN_NOFOLLOW;
    let db = if sidecars_before {
        Connection::open_with_flags(path, flags)
    } else {
        let url = reqwest::Url::from_file_path(path).map_err(|_| "invalid_database")?;
        Connection::open_with_flags(format!("{url}?immutable=1"), flags)
    }
    .map_err(|_| "unreadable_database")?;
    db.execute_batch("PRAGMA query_only=ON; PRAGMA trusted_schema=OFF;")
        .map_err(|_| "unreadable_database")?;
    let integrity: String = db
        .query_row("PRAGMA quick_check(1)", [], |row| row.get(0))
        .map_err(|_| "invalid_database")?;
    if integrity != "ok" {
        return Err("invalid_database");
    }

    let mut query = db
        .prepare("SELECT name FROM sqlite_schema WHERE type='table' AND name NOT GLOB 'sqlite_*'")
        .map_err(|_| "invalid_database")?;
    let tables = query
        .query_map([], |row| row.get::<_, String>(0))
        .and_then(|rows| rows.collect::<rusqlite::Result<BTreeSet<_>>>())
        .map_err(|_| "invalid_database")?;
    if !CORE_TABLES.iter().all(|name| tables.contains(*name))
        || tables.iter().any(|name| {
            !VALUE_TABLES.contains(&name.as_str())
                && !matches!(
                    name.as_str(),
                    "meta" | "cursors" | "errors" | "sync_queue" | "ai_usage_outbox"
                )
        })
    {
        return Err("unsupported_database_schema");
    }
    // Some older profiles retain this auxiliary table. An empty table holds
    // no references. Leave a profile with data in the table for investigation.
    if tables.contains("ai_usage_outbox")
        && db
            .query_row("SELECT EXISTS(SELECT 1 FROM ai_usage_outbox)", [], |row| {
                row.get::<_, bool>(0)
            })
            .map_err(|_| "invalid_database")?
    {
        return Err("unsupported_database_schema");
    }

    let mut meta = db
        .prepare("SELECT key, value FROM meta")
        .map_err(|_| "invalid_database")?;
    let mut rows = meta.query([]).map_err(|_| "invalid_database")?;
    while let Some(row) = rows.next().map_err(|_| "invalid_database")? {
        let key: String = row.get(0).map_err(|_| "invalid_database")?;
        let value = decode_value(row, 1)?;
        if key.starts_with("share-preview:")
            && value["expires"]
                .as_i64()
                .is_some_and(|expires| expires < now)
        {
            continue;
        }
        // These scanner hints are recomputed from the original if a file or
        // blob is absent. Every durable consumer has a separate reference.
        if crate::scan_cache::is_rebuildable_key(&key) {
            continue;
        }
        collect_hashes(&key, references);
        if crate::selective_sharing::published_receipt_key(&key, &value) {
            for (field, item) in value.as_object().into_iter().flatten() {
                if field != "result" {
                    collect_value(item, references);
                }
            }
        } else {
            collect_value(&value, references);
        }
    }

    for table in VALUE_TABLES
        .iter()
        .copied()
        .filter(|name| tables.contains(*name))
    {
        let mut query = db
            .prepare(&format!("SELECT value FROM {table}"))
            .map_err(|_| "invalid_database")?;
        let mut rows = query.query([]).map_err(|_| "invalid_database")?;
        while let Some(row) = rows.next().map_err(|_| "invalid_database")? {
            let mut value = decode_value(row, 0)?;
            if table == "local_resources"
                && value["resource"]["kind"] == "session"
                && value["resource"]["nativeSession"] == true
            {
                value["resource"]["files"] = Value::Null;
            }
            collect_value(&value, references);
        }
    }
    if !apply
        && (sidecars(path)? || crate::scan_cache::FileStamp::of(path).as_ref() != Some(&before))
    {
        return Err("database_changed");
    }
    Ok(())
}

fn decode_value(row: &rusqlite::Row<'_>, column: usize) -> Result<Value> {
    let text: String = row.get(column).map_err(|_| "invalid_database_value")?;
    serde_json::from_str(&text).map_err(|_| "invalid_database_value")
}

fn collect_value(value: &Value, references: &mut BTreeSet<String>) {
    match value {
        Value::String(text) => collect_hashes(text, references),
        Value::Array(items) => {
            for item in items {
                collect_value(item, references);
            }
        }
        Value::Object(fields) => {
            for (key, item) in fields {
                collect_hashes(key, references);
                collect_value(item, references);
            }
        }
        _ => (),
    }
}

fn collect_hashes(text: &str, references: &mut BTreeSet<String>) {
    for candidate in text.split(|character: char| !character.is_ascii_hexdigit()) {
        if candidate.len() == 64 {
            references.insert(candidate.to_ascii_lowercase());
        }
    }
}

fn blob_hash(name: &str) -> bool {
    name.len() == 64
        && name
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
}

fn inspect_store(
    root: &Path,
    scope: &str,
    directory: &Path,
    references: &BTreeSet<String>,
    apply: bool,
) -> ScopeReport {
    let mut report = ScopeReport::new(scope);
    let Some(dir) = open_store(root, directory) else {
        report.skip("store_read_failed");
        return report;
    };
    let Ok(paths) = entries(directory) else {
        report.skip("store_read_failed");
        return report;
    };
    for path in paths {
        let Some(hash) = path
            .file_name()
            .and_then(|name| name.to_str())
            .filter(|name| blob_hash(name))
        else {
            report.skip("unexpected_blob_name");
            continue;
        };
        if references.contains(hash) {
            report.skip("referenced");
            continue;
        }
        match candidate(&dir, &path, hash, apply) {
            Ok(bytes) => {
                report.eligible_count += 1;
                report.eligible_allocated_bytes += bytes;
                if apply {
                    report.removed_count += 1;
                    report.removed_allocated_bytes += bytes;
                }
            }
            Err(reason) => report.skip(reason),
        }
    }
    if apply && report.removed_count != 0 && dir.sync_all().is_err() {
        report.skip("store_sync_failed");
    }
    report
}

fn open_store(root: &Path, path: &Path) -> Option<File> {
    let flags = libc::O_DIRECTORY | libc::O_NOFOLLOW | libc::O_CLOEXEC;
    let mut directory = OpenOptions::new()
        .read(true)
        .custom_flags(flags)
        .open(root)
        .ok()?;
    for component in path.strip_prefix(root).ok()?.components() {
        let std::path::Component::Normal(name) = component else {
            return None;
        };
        let name = CString::new(name.as_bytes()).ok()?;
        let fd =
            unsafe { libc::openat(directory.as_raw_fd(), name.as_ptr(), libc::O_RDONLY | flags) };
        if fd < 0 {
            return None;
        }
        directory = unsafe { File::from_raw_fd(fd) };
    }
    directory
        .metadata()
        .ok()
        .filter(|info| info.uid() == unsafe { libc::geteuid() })?;
    Some(directory)
}

fn candidate(directory: &File, path: &Path, hash: &str, apply: bool) -> Result<u64> {
    let name = CString::new(hash).map_err(|_| "unexpected_blob_name")?;
    // Resolve the leaf relative to the already-open store so a path replacement
    // cannot redirect a deletion outside the inspected directory.
    let fd = unsafe {
        libc::openat(
            directory.as_raw_fd(),
            name.as_ptr(),
            libc::O_RDONLY | libc::O_NOFOLLOW | libc::O_NONBLOCK | libc::O_CLOEXEC,
        )
    };
    if fd < 0 {
        return Err("unsafe_or_unreadable_blob");
    }
    let file = unsafe { File::from_raw_fd(fd) };
    let info = file.metadata().map_err(|_| "unsafe_or_unreadable_blob")?;
    if !owned_file(&info) || info.len() == 0 || info.len() > history::MAX_FILE {
        return Err("unsafe_or_unsupported_blob");
    }
    let before =
        crate::scan_cache::FileStamp::from_metadata(&info).ok_or("unsafe_or_unreadable_blob")?;
    verify_transcript(&file, hash)?;
    if crate::scan_cache::FileStamp::of(path).as_ref() != Some(&before) {
        return Err("file_changed");
    }
    if apply && unsafe { libc::unlinkat(directory.as_raw_fd(), name.as_ptr(), 0) } != 0 {
        return Err("unlink_failed");
    }
    Ok(info.blocks() * 512)
}

fn verify_transcript(file: &File, expected: &str) -> Result<()> {
    let mut stream = BufReader::new(file.take(history::MAX_FILE + 1));
    let mut digest = Sha256::new();
    let mut line = Vec::new();
    let mut first = true;
    let mut codex = false;
    let mut claude_id: Option<Uuid> = None;
    let mut claude_metadata = false;
    loop {
        line.clear();
        if stream
            .read_until(b'\n', &mut line)
            .map_err(|_| "unreadable_blob")?
            == 0
        {
            break;
        }
        if line.len() as u64 > history::MAX_FILE || line.last() != Some(&b'\n') {
            return Err("unverified_transcript");
        }
        let record: Value = serde_json::from_slice(&line).map_err(|_| "unverified_transcript")?;
        let kind = record["type"].as_str().ok_or("unverified_transcript")?;
        let bytes = record.to_string();
        if bytes.as_bytes() != &line[..line.len() - 1] {
            return Err("unverified_transcript");
        }
        if kind == "session_meta" {
            if !first {
                return Err("unverified_transcript");
            }
            let records = std::slice::from_ref(&record);
            if session_translation::format("codex", records).is_err()
                || crate::native::session_cwd("codex", records).is_err()
            {
                return Err("unverified_transcript");
            }
            codex = true;
        } else if !codex {
            if matches!(kind, "user" | "assistant") && !record["message"].is_object() {
                return Err("unverified_transcript");
            }
            if let Some(id) = record["sessionId"].as_str() {
                let id = Uuid::parse_str(id).map_err(|_| "unverified_transcript")?;
                if claude_id.is_some_and(|seen| seen != id) {
                    return Err("unverified_transcript");
                }
                claude_id = Some(id);
                claude_metadata |=
                    crate::native::session_cwd("claude", std::slice::from_ref(&record)).is_ok();
            }
        }
        digest.update(&line);
        first = false;
    }
    if !codex && !claude_metadata {
        return Err("unverified_transcript");
    }
    if db::hex(&digest.finalize()) != expected {
        return Err("digest_mismatch");
    }
    Ok(())
}

#[cfg(test)]
#[path = "session_cleanup_tests.rs"]
mod tests;
