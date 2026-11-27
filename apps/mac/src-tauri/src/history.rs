use crate::{
    db::{self, Result},
    native, session_translation,
};
use serde_json::{json, Value};
use std::{
    cell::RefCell,
    collections::{BTreeSet, HashMap},
    fs,
    io::{self, BufRead, BufReader, Read},
    os::unix::fs::OpenOptionsExt,
    path::{Path, PathBuf},
};
use uuid::Uuid;
use walkdir::WalkDir;

pub(crate) const MAX_FILE: u64 = 128 * 1024 * 1024;
pub(crate) const NATIVE_READ_UNAVAILABLE: &str = "The native session file is unavailable.";
pub(crate) const INVALID_SEGMENT_METADATA: &str = "Invalid native segment metadata";
pub(crate) const ANCESTOR_MISSING: &str =
    "Inherited Codex history is missing. Sync this session again from the original device.";
pub(crate) const ANCESTOR_BOUNDARY_UNAVAILABLE: &str = "Inherited Codex history is missing or has an invalid boundary. Sync this session again from the original device.";
pub(crate) const SESSION_SIZE_ERROR: &str = "Session exceeds 128 MB; source preserved";
pub(crate) const UNATTRIBUTED_SESSION_PREFIX: &str = "history:unattributed:";
pub(crate) const UNATTRIBUTED_SESSION_ERROR: &str =
    "Session exceeds 128 MB; Orka could not identify its project. Source preserved.";
const MAX_ATTRIBUTION_PREFIX: u64 = 1024 * 1024;
const MAX_TOTAL: usize = 256 * 1024 * 1024;

#[derive(Debug)]
pub(crate) enum SessionReadError {
    Unavailable(String),
    Rejected(String),
}

impl From<String> for SessionReadError {
    fn from(error: String) -> Self {
        if matches!(
            error.as_str(),
            "Item is not available on this Mac"
                | NATIVE_READ_UNAVAILABLE
                | INVALID_SEGMENT_METADATA
                | ANCESTOR_MISSING
                | ANCESTOR_BOUNDARY_UNAVAILABLE
                | "Unknown or corrupt native transcript; source preserved"
                | SESSION_SIZE_ERROR
        ) {
            Self::Unavailable(error)
        } else {
            Self::Rejected(error)
        }
    }
}

impl From<&str> for SessionReadError {
    fn from(error: &str) -> Self {
        error.to_owned().into()
    }
}

impl From<SessionReadError> for String {
    fn from(error: SessionReadError) -> Self {
        match error {
            SessionReadError::Unavailable(message) | SessionReadError::Rejected(message) => message,
        }
    }
}

impl SessionReadError {
    fn unavailable(message: &str) -> Self {
        Self::Unavailable(message.to_owned())
    }
}

pub(crate) fn session_identity<'a>(
    tool: &str,
    records: &'a [Value],
) -> std::result::Result<&'a str, SessionReadError> {
    let metadata =
        session_translation::metadata(tool, records).map_err(SessionReadError::Unavailable)?;
    let key = if tool == "claude" { "sessionId" } else { "id" };
    let id = metadata[key]
        .as_str()
        .ok_or_else(|| SessionReadError::unavailable("Missing native ID"))?;
    Uuid::parse_str(id).map_err(|_| SessionReadError::unavailable("Invalid native session ID"))?;
    Ok(id)
}

#[cfg(test)]
thread_local! {
    static READ_COUNTS: std::cell::RefCell<std::collections::BTreeMap<PathBuf, (usize, usize)>> = Default::default();
}

#[cfg(test)]
pub(crate) fn read_counts(path: &Path) -> (usize, usize) {
    READ_COUNTS.with_borrow(|counts| counts.get(path).copied().unwrap_or_default())
}

pub(crate) struct NegativeAttribution {
    key: String,
    fingerprint: Value,
    topology: String,
}

impl NegativeAttribution {
    pub(crate) fn new(
        project: &Value,
        root: &Path,
        topology: &str,
        tool: &str,
        path: &Path,
    ) -> Option<Self> {
        let path = std::path::absolute(path).ok()?;
        let scope = json!([project["id"], project["sourceId"], root, tool, path]);
        Some(Self {
            key: format!(
                "unrelatedHistory:{}",
                db::digest(scope.to_string().as_bytes())
            ),
            fingerprint: Self::fingerprint(&path)?,
            topology: topology.into(),
        })
    }

    fn fingerprint(path: &Path) -> Option<Value> {
        serde_json::to_value(crate::scan_cache::FileStamp::of(path)?).ok()
    }

    pub(crate) fn contains(&self, db: &rusqlite::Connection) -> Result<bool> {
        Ok(!crate::scan_cache::is_reconciling()
            && db::get(db, &self.key)? == json!([self.topology, self.fingerprint]))
    }

    pub(crate) fn forget(&self, db: &rusqlite::Connection) -> Result<()> {
        db.execute("DELETE FROM meta WHERE key=?", [&self.key])
            .map_err(|e| e.to_string())?;
        Ok(())
    }

    pub(crate) fn remember(&self, db: &rusqlite::Connection, path: &Path) -> Result<()> {
        if Self::fingerprint(path).as_ref() == Some(&self.fingerprint) {
            db::set(db, &self.key, &json!([self.topology, self.fingerprint]))?;
        }
        Ok(())
    }
}

pub fn clear_missing_session_errors(db: &rusqlite::Connection) -> Result<()> {
    for source in db::rows(
        db,
        "SELECT json_quote(source) FROM errors WHERE source GLOB ?",
        &[&format!("{UNATTRIBUTED_SESSION_PREFIX}*")],
    )? {
        if let Some(path) = source
            .as_str()
            .and_then(|source| source.strip_prefix(UNATTRIBUTED_SESSION_PREFIX))
        {
            if fs::symlink_metadata(path)
                .is_err_and(|error| error.kind() == std::io::ErrorKind::NotFound)
            {
                db.execute("DELETE FROM errors WHERE source=?", [source.as_str()])
                    .map_err(|e| e.to_string())?;
            }
        }
    }
    Ok(())
}

fn ordinal_reference(value: &Value) -> bool {
    match value {
        Value::Object(fields) => fields
            .iter()
            .any(|(key, value)| key.contains("ordinal") || ordinal_reference(value)),
        Value::Array(values) => values.iter().any(ordinal_reference),
        _ => false,
    }
}

pub struct Rollout {
    pub id: String,
    pub records: Vec<Value>,
}

// Oldest ancestor first, followed by the complete leaf. Ancestors contain only
// the prefix inherited by their child, never later messages from another fork.
pub struct History {
    pub rollouts: Vec<Rollout>,
}

fn metadata(records: &[Value]) -> Result<&Value> {
    records
        .first()
        .filter(|r| r["type"] == "session_meta")
        .map(|r| &r["payload"])
        .ok_or("Missing initial Codex session metadata".into())
}

pub(crate) fn eligible_codex_session(
    db: &rusqlite::Connection,
    id: &str,
    records: &[Value],
) -> Result<bool> {
    if records
        .iter()
        .find(|r| r["type"] == "session_meta")
        .is_some_and(|r| r["payload"]["source"].is_object())
    {
        return Ok(false);
    }
    Ok(!crate::codex_import::is_pending_or_dependency(
        db, id, records,
    )?)
}

pub fn is_session(path: &Path) -> bool {
    let name = path.file_name().unwrap_or_default().to_string_lossy();
    name.ends_with(".jsonl") || name.ends_with(".jsonl.zst")
}

pub(crate) fn native_read_error(error: io::Error) -> String {
    if matches!(
        error.kind(),
        io::ErrorKind::NotFound
            | io::ErrorKind::PermissionDenied
            | io::ErrorKind::InvalidData
            | io::ErrorKind::UnexpectedEof
    ) {
        return NATIVE_READ_UNAVAILABLE.into();
    }
    error.to_string()
}

pub(crate) fn session_file(path: &Path) -> Result<fs::File> {
    let info = fs::symlink_metadata(path).map_err(native_read_error)?;
    if !info.is_file() || info.file_type().is_symlink() {
        return Err("History must be a regular file".into());
    }
    let file = fs::OpenOptions::new()
        .read(true)
        .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
        .open(path)
        .map_err(native_read_error)?;
    if !file.metadata().map_err(native_read_error)?.is_file() {
        return Err("History must be a regular file".into());
    }
    Ok(file)
}

pub(crate) fn reader(path: &Path) -> Result<Box<dyn Read>> {
    let file = session_file(path)?;
    if path.to_string_lossy().ends_with(".jsonl.zst") {
        let mut decoder = zstd::stream::read::Decoder::new(file).map_err(native_read_error)?;
        decoder.window_log_max(27).map_err(|e| e.to_string())?;
        Ok(Box::new(decoder))
    } else {
        Ok(Box::new(file))
    }
}

fn read(path: &Path, prefix: Option<u64>) -> Result<Vec<u8>> {
    if prefix.is_some_and(|size| size > MAX_FILE) {
        return Err("History exceeds its file or size boundary".into());
    }
    let mut bytes = Vec::new();
    // Codex's inherited offsets address decoded JSONL bytes, not compressed bytes.
    reader(path)?
        .take(prefix.unwrap_or(MAX_FILE + 1))
        .read_to_end(&mut bytes)
        .map_err(native_read_error)?;
    if bytes.len() as u64 > MAX_FILE {
        return Err(SESSION_SIZE_ERROR.into());
    }
    Ok(bytes)
}

pub fn read_session(path: &Path) -> Result<Vec<u8>> {
    #[cfg(test)]
    READ_COUNTS.with_borrow_mut(|counts| counts.entry(path.into()).or_default().0 += 1);
    if path.extension().is_some_and(|ext| ext == "jsonl")
        && fs::symlink_metadata(path).is_ok_and(|info| info.is_file() && info.len() > MAX_FILE)
    {
        return Err(SESSION_SIZE_ERROR.into());
    }
    read(path, None)
}

pub(crate) fn session_cwd_prefix(path: &Path, tool: &str) -> Option<PathBuf> {
    session_route_prefix(path, tool).map(|(_, cwd)| cwd)
}

pub(crate) fn session_route_prefix(path: &Path, tool: &str) -> Option<(Option<String>, PathBuf)> {
    #[cfg(test)]
    READ_COUNTS.with_borrow_mut(|counts| counts.entry(path.into()).or_default().1 += 1);
    let mut prefix = Vec::new();
    reader(path)
        .ok()?
        .take(MAX_ATTRIBUTION_PREFIX)
        .read_to_end(&mut prefix)
        .ok()?;
    let records = native::complete_records(&prefix).ok()?;
    let cwd = native::session_cwd(tool, &records).ok()?;
    let metadata = crate::session_translation::metadata(tool, &records).ok()?;
    let id = metadata[if tool == "claude" { "sessionId" } else { "id" }].as_str();
    Some((id.map(str::to_owned), cwd))
}

pub fn first_line(path: &Path) -> Result<String> {
    let mut line = String::new();
    BufReader::new(reader(path)?.take(MAX_FILE + 1))
        .read_line(&mut line)
        .map_err(native_read_error)?;
    if line.len() as u64 > MAX_FILE {
        return Err(SESSION_SIZE_ERROR.into());
    }
    Ok(line)
}

pub fn find_rollout(home: &Path, id: &str) -> Result<PathBuf> {
    Uuid::parse_str(id).map_err(|_| "Invalid history reference")?;
    let mut found = None;
    for directory in [home.join("sessions"), home.join("archived_sessions")] {
        if !directory.exists() {
            continue;
        }
        if fs::symlink_metadata(&directory)
            .map_err(|e| e.to_string())?
            .file_type()
            .is_symlink()
        {
            return Err("Native history directory is a symlink".into());
        }
        for entry in WalkDir::new(directory).follow_links(false) {
            let entry = entry.map_err(|e| e.to_string())?;
            if entry.file_type().is_file()
                && is_session(entry.path())
                && entry
                    .file_name()
                    .to_string_lossy()
                    .trim_end_matches(".zst")
                    .ends_with(&format!("-{id}.jsonl"))
            {
                if found.is_some() {
                    return Err("Duplicate native history identity".into());
                }
                found = Some(entry.into_path());
            }
        }
    }
    found.ok_or(ANCESTOR_MISSING.into())
}

#[derive(Clone)]
struct Segment {
    ordinal: u64,
    path: PathBuf,
    multi_agent_v2: bool,
    cwd: Option<PathBuf>,
}

fn parse_segment(path: &Path, id: &str) -> Result<Option<Segment>> {
    let first = first_line(path)?;
    let record: Value = serde_json::from_str(&first).map_err(|_| INVALID_SEGMENT_METADATA)?;
    if record["type"] == "session_meta" && record["payload"]["id"] == id {
        Ok(Some(Segment {
            ordinal: record["ordinal"].as_u64().unwrap_or(0),
            path: path.to_path_buf(),
            multi_agent_v2: record["payload"]["multi_agent_version"] == "v2",
            cwd: record["payload"]["cwd"].as_str().map(PathBuf::from),
        }))
    } else {
        Ok(None)
    }
}

const INDEXED_UUID_LENGTHS: [usize; 2] = [36, 32];

fn candidate_uuids(name: &str) -> Vec<&str> {
    let name = name.strip_suffix(".zst").unwrap_or(name);
    let Some(stem) = name.strip_suffix(".jsonl") else {
        return Vec::new();
    };
    let mut ids = Vec::new();
    for width in INDEXED_UUID_LENGTHS {
        if stem.len() >= width && stem.is_char_boundary(stem.len() - width) {
            let tail = &stem[stem.len() - width..];
            if Uuid::parse_str(tail).is_ok() {
                ids.push(tail);
            }
        }
        for (idx, _) in stem.match_indices('_') {
            if idx > width
                && stem.as_bytes()[idx - width - 1] == b'-'
                && stem.is_char_boundary(idx - width)
            {
                let cand = &stem[idx - width..idx];
                if Uuid::parse_str(cand).is_ok() && !ids.contains(&cand) {
                    ids.push(cand);
                }
            }
        }
    }
    ids
}

/// Indexes Codex rollout filenames once per scan so resolving current segments
/// and paginated ancestors does not re-walk `sessions/` and `archived_sessions/`
/// for every transcript.
pub(crate) struct CodexSegmentIndex {
    home: PathBuf,
    by_id: HashMap<String, Vec<PathBuf>>,
    parsed: RefCell<HashMap<String, IndexedSegments>>,
    error: Option<String>,
}

struct IndexedSegments {
    candidates: Vec<Segment>,
    stamps: Vec<crate::scan_cache::FileStamp>,
}

impl CodexSegmentIndex {
    pub(crate) fn new(home: &Path) -> Self {
        let mut by_id: HashMap<String, Vec<PathBuf>> = HashMap::new();
        let mut error = None;
        'trees: for directory in [home.join("sessions"), home.join("archived_sessions")] {
            match fs::symlink_metadata(&directory) {
                Ok(meta) if meta.file_type().is_symlink() => {
                    error = Some("Native history directory is a symlink".into());
                    break;
                }
                Ok(_) => {}
                Err(err) if err.kind() == io::ErrorKind::NotFound => continue,
                Err(err) => {
                    let message = native_read_error(err);
                    let unavailable = message == NATIVE_READ_UNAVAILABLE;
                    error = Some(message);
                    if unavailable {
                        continue;
                    }
                    break;
                }
            }
            for entry in WalkDir::new(directory).follow_links(false) {
                let entry = match entry {
                    Ok(entry) => entry,
                    Err(err) => {
                        let detail = err.to_string();
                        let message = err.into_io_error().map_or(detail, native_read_error);
                        let unavailable = message == NATIVE_READ_UNAVAILABLE;
                        error = Some(message);
                        if unavailable {
                            continue;
                        }
                        break 'trees;
                    }
                };
                if !entry.file_type().is_file() || !is_session(entry.path()) {
                    continue;
                }
                let name = entry.file_name().to_string_lossy();
                for id in candidate_uuids(&name) {
                    by_id
                        .entry(id.to_owned())
                        .or_default()
                        .push(entry.path().to_path_buf());
                }
            }
        }
        Self {
            home: home.to_path_buf(),
            by_id,
            parsed: RefCell::new(HashMap::new()),
            error,
        }
    }

    fn segments(&self, id: &str) -> Result<Vec<Segment>> {
        use crate::scan_cache::FileStamp;

        Uuid::parse_str(id).map_err(|_| "Invalid history identity")?;
        if !INDEXED_UUID_LENGTHS.contains(&id.len()) {
            return segments(&self.home, id);
        }
        if let Some(err) = &self.error {
            return Err(err.clone());
        }
        let Some(paths) = self.by_id.get(id) else {
            return Ok(Vec::new());
        };
        let stamps = paths
            .iter()
            .map(|path| FileStamp::of(path))
            .collect::<Option<Vec<_>>>();
        if let Some(stamps) = &stamps {
            if let Some(cached) = self.parsed.borrow().get(id) {
                if cached.stamps == *stamps {
                    return Ok(cached.candidates.clone());
                }
            }
        }
        let mut candidates = Vec::new();
        for path in paths {
            if let Some(segment) = parse_segment(path, id)? {
                candidates.push(segment);
            }
        }
        candidates.sort_by_key(|segment| segment.ordinal);
        if let Some(stamps) = stamps {
            if !paths
                .iter()
                .zip(&stamps)
                .all(|(path, stamp)| FileStamp::of(path).as_ref() == Some(stamp))
            {
                return Err("Codex history changed during scan; retry sync".into());
            }
            self.parsed.borrow_mut().insert(
                id.to_owned(),
                IndexedSegments {
                    candidates: candidates.clone(),
                    stamps,
                },
            );
        }
        Ok(candidates)
    }

    pub(crate) fn current_path(&self, path: &Path, id: &str) -> Result<PathBuf> {
        let candidates = self.segments(id)?;
        resolve_current_path(&self.home, path, id, &candidates)
    }

    /// Use collected ancestry candidates when an interrupted traversal cannot
    /// prove the current generation. The caller must verify the entire catalog
    /// manifest before using the reconstructed snapshot.
    pub(crate) fn catalog_read_path(&mut self, path: &Path, id: &str) -> Result<(PathBuf, bool)> {
        if self.error.as_deref() == Some(NATIVE_READ_UNAVAILABLE) {
            self.error = None;
            return Ok((path.to_path_buf(), true));
        }
        Ok((self.current_path(path, id)?, false))
    }

    pub(crate) fn candidate_paths(&self, id: &str) -> Result<Vec<PathBuf>> {
        Uuid::parse_str(id).map_err(|_| "Invalid history identity")?;
        if let Some(err) = &self.error {
            return Err(err.clone());
        }
        let mut paths = self.by_id.get(id).cloned().unwrap_or_default();
        paths.sort();
        Ok(paths)
    }

    fn parent_prefix(
        &self,
        id: &str,
        end: u64,
        offset: u64,
    ) -> Result<(Vec<u8>, PathBuf, Option<crate::scan_cache::FileStamp>)> {
        parent_prefix_in(self.segments(id)?, end, offset)
    }
}

fn segments(home: &Path, id: &str) -> Result<Vec<Segment>> {
    Uuid::parse_str(id).map_err(|_| "Invalid history identity")?;
    let mut candidates = Vec::new();
    for directory in [home.join("sessions"), home.join("archived_sessions")] {
        if !directory.exists() {
            continue;
        }
        if fs::symlink_metadata(&directory)
            .map_err(|e| e.to_string())?
            .file_type()
            .is_symlink()
        {
            return Err("Native history directory is a symlink".into());
        }
        for entry in WalkDir::new(directory).follow_links(false) {
            let entry = entry.map_err(|e| e.to_string())?;
            let name = entry.file_name().to_string_lossy();
            let name = name.strip_suffix(".zst").unwrap_or(&name);
            if !entry.file_type().is_file()
                || !is_session(entry.path())
                || !(name.ends_with(&format!("{id}.jsonl")) || name.contains(&format!("-{id}_")))
            {
                continue;
            }
            if let Some(segment) = parse_segment(entry.path(), id)? {
                candidates.push(segment);
            }
        }
    }
    candidates.sort_by_key(|segment| segment.ordinal);
    Ok(candidates)
}

// Codex can replace a rollout when entering multi-agent v2, keeping the thread
// ID but restarting ordinals. Its state index identifies the current generation.
// This optional lookup never starts an app server, repairs its index, or creates
// a database. Unavailable or unfamiliar state leaves ambiguity checks in charge.
fn indexed_v2_segment<'a>(home: &Path, id: &str, candidates: &'a [Segment]) -> Option<&'a Segment> {
    let mut databases = fs::read_dir(home)
        .ok()?
        .filter_map(|entry| {
            let entry = entry.ok()?;
            let name = entry.file_name();
            let version = name
                .to_str()?
                .strip_prefix("state_")?
                .strip_suffix(".sqlite")?;
            if !version.bytes().all(|byte| byte.is_ascii_digit()) {
                return None;
            }
            let version = version.parse::<u64>().ok()?;
            Some((version, entry.path()))
        })
        .collect::<Vec<_>>();
    databases.sort_by_key(|(version, _)| *version);
    let (version, path) = databases.last()?;
    if databases.iter().filter(|(v, _)| v == version).count() != 1
        || !fs::symlink_metadata(path).ok()?.is_file()
    {
        return None;
    }
    let db = rusqlite::Connection::open_with_flags(
        path.canonicalize().ok()?,
        rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY
            | rusqlite::OpenFlags::SQLITE_OPEN_NO_MUTEX
            | rusqlite::OpenFlags::SQLITE_OPEN_NOFOLLOW,
    )
    .ok()?;
    db.busy_timeout(std::time::Duration::from_millis(50)).ok()?;
    let raw: String = db
        .query_row("SELECT rollout_path FROM threads WHERE id=?", [id], |row| {
            row.get(0)
        })
        .ok()?;
    let indexed = Path::new(&raw);
    if !indexed.is_absolute()
        || indexed
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
        || !fs::symlink_metadata(indexed).ok()?.is_file()
    {
        return None;
    }
    let indexed = indexed.canonicalize().ok()?;
    let selected = candidates
        .iter()
        .find(|candidate| candidate.path.canonicalize().ok().as_ref() == Some(&indexed))?;
    let cwd = selected.cwd.as_ref().filter(|cwd| cwd.is_absolute())?;
    if !selected.multi_agent_v2
        || candidates
            .iter()
            .any(|candidate| candidate.cwd.as_ref() != Some(cwd))
    {
        return None;
    }
    let record: Value = serde_json::from_str(&first_line(&selected.path).ok()?).ok()?;
    if record["type"] != "session_meta"
        || record["payload"]["id"] != id
        || record["payload"]["session_id"] != id
        || record["payload"]["multi_agent_version"] != "v2"
        || record["payload"]["cwd"]
            .as_str()
            .map(PathBuf::from)
            .as_ref()
            != Some(cwd)
        || record["payload"]["history_mode"] != "paginated"
        || record["ordinal"].as_u64() != Some(selected.ordinal)
    {
        return None;
    }
    // A valid index can lag behind an appended segment. Do not mistake an
    // indexed ancestor for the current generation and silently omit its child.
    for child in candidates
        .iter()
        .filter(|child| child.ordinal > selected.ordinal)
    {
        let record: Value = serde_json::from_str(&first_line(&child.path).ok()?).ok()?;
        let base = &record["payload"]["history_base"];
        if base["thread_id"] != id || base["end_ordinal_exclusive"].as_u64() != Some(child.ordinal)
        {
            continue;
        }
        let offset = base["end_byte_offset"].as_u64()?;
        let prefix = read(&selected.path, Some(offset)).ok()?;
        if prefix.len() as u64 == offset
            && prefix.last() == Some(&b'\n')
            && native::complete_records(&prefix)
                .ok()?
                .last()
                .and_then(|record| record["ordinal"].as_u64())
                .and_then(|ordinal| ordinal.checked_add(1))
                == Some(child.ordinal)
        {
            return None;
        }
    }
    Some(selected)
}

fn resolve_current_path(
    home: &Path,
    path: &Path,
    id: &str,
    candidates: &[Segment],
) -> Result<PathBuf> {
    if candidates.len() > 1 && candidates.iter().any(|segment| segment.multi_agent_v2) {
        let reset = candidates
            .iter()
            .any(|segment| segment.multi_agent_v2 && segment.ordinal == 0);
        let duplicate_ordinal = candidates
            .windows(2)
            .any(|pair| pair[0].ordinal == pair[1].ordinal);
        if duplicate_ordinal || (reset && candidates.iter().any(|segment| !segment.multi_agent_v2))
        {
            if let Some(selected) = indexed_v2_segment(home, id, candidates) {
                return Ok(selected.path.clone());
            }
            return Err("Ambiguous native history segments; source preserved".into());
        }
    }
    if candidates.len() > 1
        && candidates[candidates.len() - 2].ordinal == candidates[candidates.len() - 1].ordinal
    {
        return Err("Ambiguous native history segments; source preserved".into());
    }
    Ok(candidates
        .last()
        .map(|segment| segment.path.clone())
        .unwrap_or_else(|| path.into()))
}

pub fn current_path(path: &Path, id: &str) -> Result<PathBuf> {
    let home = native::codex_home()?;
    let candidates = segments(&home, id)?;
    resolve_current_path(&home, path, id, &candidates)
}

fn parent_prefix_in(
    candidates: Vec<Segment>,
    end: u64,
    offset: u64,
) -> Result<(Vec<u8>, PathBuf, Option<crate::scan_cache::FileStamp>)> {
    let mut found: Option<(Vec<u8>, PathBuf, Option<crate::scan_cache::FileStamp>)> = None;
    for segment in candidates.into_iter().rev() {
        if segment.ordinal >= end {
            continue;
        }
        let stamp_before = crate::scan_cache::FileStamp::of(&segment.path);
        let bytes = read(&segment.path, Some(offset))?;
        if bytes.len() as u64 != offset {
            continue;
        }
        let records = native::complete_records(&bytes)?;
        if bytes.last() == Some(&b'\n')
            && records
                .last()
                .and_then(|r| r["ordinal"].as_u64())
                .and_then(|n| n.checked_add(1))
                == Some(end)
        {
            if found
                .as_ref()
                .is_some_and(|(previous, _, _)| previous != &bytes)
            {
                return Err("Ambiguous inherited history; original sources preserved".into());
            }
            found = Some((bytes, segment.path, stamp_before));
        }
    }
    found.ok_or(ANCESTOR_BOUNDARY_UNAVAILABLE.into())
}

fn parent_prefix(home: &Path, id: &str, end: u64, offset: u64) -> Result<Vec<u8>> {
    parent_prefix_in(segments(home, id)?, end, offset).map(|(bytes, _, _)| bytes)
}

fn codex_record_shape(record: &Value) -> bool {
    record["type"].is_string()
        && record["payload"].is_object()
        && (record["payload"]["type"] != "thread_settings_applied"
            || record["payload"]["thread_settings"].is_object())
}

struct StoredManifest<'a> {
    files: &'a [Value],
    names: BTreeSet<&'a str>,
}

impl<'a> StoredManifest<'a> {
    fn new(resource: &'a Value) -> Result<Self> {
        let files = resource["files"]
            .as_array()
            .ok_or("Missing history files")?;
        if files.len() > 200 {
            return Err("Too many history files".into());
        }
        let mut names = BTreeSet::new();
        for file in files {
            if !names.insert(file["path"].as_str().ok_or("Missing history path")?) {
                return Err("Duplicate history file".into());
            }
        }
        Ok(Self { files, names })
    }

    fn file(&self, path: &str) -> Result<&'a Value> {
        self.files.iter().find(|file| file["path"] == path)
            .ok_or_else(|| "Inherited Codex history is missing. Sync this session again from the original device.".into())
    }

    fn parent(&self, id: &str, end: u64) -> Result<&'a Value> {
        let path = format!("lineage/{id}/{end}.jsonl");
        if self.names.contains(path.as_str()) {
            self.file(&path)
        } else {
            self.file(&format!("lineage/{id}.jsonl"))
        }
    }
}

#[derive(Clone, Debug)]
struct Inheritance {
    id: String,
    end_ordinal: u64,
    end_byte: u64,
}

fn inheritance(meta: &Value, paginated: bool) -> Result<Option<Inheritance>> {
    let base = &meta["history_base"];
    if base.is_null() {
        return Ok(None);
    }
    if !paginated {
        return Err("Legacy history cannot reference paginated ancestors".into());
    }
    let id = base["thread_id"]
        .as_str()
        .ok_or("Missing history ancestor")?;
    Uuid::parse_str(id).map_err(|_| "Invalid history ancestor")?;
    let end_ordinal = base["end_ordinal_exclusive"]
        .as_u64()
        .ok_or("Missing history ordinal boundary")?;
    let end_byte = base["end_byte_offset"]
        .as_u64()
        .filter(|end| *end > 0 && *end <= MAX_FILE)
        .ok_or("Invalid history byte boundary")?;
    Ok(Some(Inheritance {
        id: id.into(),
        end_ordinal,
        end_byte,
    }))
}

fn visit_stored_lines(
    scope: &db::CacheScope,
    manifest: &Value,
    cancelled: &impl Fn() -> Result<()>,
    mut visit: impl FnMut(&[u8]) -> Result<()>,
) -> Result<(u64, bool)> {
    use sha2::{Digest, Sha256};
    use std::io::{BufRead, BufReader};

    let hash = manifest["hash"].as_str().ok_or("Missing history hash")?;
    let size = manifest["size"].as_u64().ok_or("Missing history size")?;
    if size > MAX_FILE {
        return Err(SESSION_SIZE_ERROR.into());
    }
    let blob = scope.open_blob(hash)?;
    let length = blob.metadata().map_err(|error| error.to_string())?.len();
    if length != size {
        return Err("History size does not match the manifest".into());
    }
    // Keep parser and formatter memory bounded for a single exceptional
    // record as well as for a history with many ordinary records.
    const MAX_RECORD_BYTES: u64 = 16 * 1024 * 1024;
    let mut reader = BufReader::with_capacity(64 * 1024, blob.take(size + 1));
    let mut digest = Sha256::new();
    let mut line = Vec::new();
    let mut bytes = 0_u64;
    let mut complete = true;
    loop {
        cancelled()?;
        line.clear();
        let count = (&mut reader)
            .take(MAX_RECORD_BYTES + 1)
            .read_until(b'\n', &mut line)
            .map_err(|error| error.to_string())?;
        if count as u64 > MAX_RECORD_BYTES {
            return Err(crate::transcript::PREVIEW_TOO_LARGE.into());
        }
        if count == 0 {
            break;
        }
        bytes += count as u64;
        if bytes > size {
            return Err("History size does not match the manifest".into());
        }
        digest.update(&line);
        complete = line.ends_with(b"\n");
        if complete && count > 1 {
            visit(&line[..count - 1])?;
        }
    }
    if bytes != size || db::hex(&digest.finalize()) != hash {
        return Err("Blob hash mismatch".into());
    }
    Ok((bytes, complete))
}

fn visit_stored_jsonl(
    scope: &db::CacheScope,
    manifest: &Value,
    cancelled: &impl Fn() -> Result<()>,
    mut visit: impl FnMut(&Value) -> Result<()>,
) -> Result<(u64, bool)> {
    visit_stored_lines(scope, manifest, cancelled, |line| {
        let record = serde_json::from_slice(line)
            .map_err(|_| "Unknown or corrupt native transcript; source preserved")?;
        visit(&record)
    })
}

/// A prior successful stored Conversation decoded these exact content hashes.
/// Recheck the bytes, lengths and transcript record limit before exposing its prefix.
pub(crate) fn authenticate_transcript_prefix(
    scope: &db::CacheScope,
    resource: &Value,
    cancelled: impl Fn() -> Result<()>,
) -> Result<()> {
    for file in StoredManifest::new(resource)?.files {
        visit_stored_lines(scope, file, &cancelled, |_| Ok(()))?;
    }
    Ok(())
}

/// Visit immutable snapshot records in manifest lineage order (leaf first).
/// The reader stores each segment separately, then presents oldest ancestors
/// first. It publishes pages only after all blob checks have succeeded.
pub(crate) fn visit_stored_transcript(
    scope: &db::CacheScope,
    resource: &Value,
    cancelled: impl Fn() -> Result<()>,
    mut visit: impl FnMut(Option<&Value>) -> Result<()>,
) -> Result<()> {
    let manifest = StoredManifest::new(resource)?;
    let mut file = manifest.file("session.jsonl")?;
    if resource["source"] != "codex" {
        visit_stored_jsonl(scope, file, &cancelled, |record| visit(Some(record)))?;
        return visit(None);
    }

    let mut expected: Option<Inheritance> = None;
    let mut seen = BTreeSet::new();
    let mut total = 0_u64;
    loop {
        if seen.len() >= 200 {
            return Err("Complete session history exceeds the sync limit".into());
        }
        let mut header = None;
        let mut next_ordinal: Option<u64> = None;
        let mut paginated = false;
        let (length, complete) = visit_stored_jsonl(scope, file, &cancelled, |record| {
            if !codex_record_shape(record) {
                return Err("Unsupported Codex record shape; original preserved".into());
            }
            if header.is_none() {
                let records = std::slice::from_ref(record);
                let meta = metadata(records)?;
                let (id, _, _) = native::session_info("codex", records)?;
                paginated = meta["history_mode"] == "paginated";
                next_ordinal = record["ordinal"].as_u64();
                if paginated
                    && next_ordinal
                        != Some(
                            meta["history_base"]["end_ordinal_exclusive"]
                                .as_u64()
                                .unwrap_or(0),
                        )
                {
                    return Err("History starts outside its inherited ordinal boundary".into());
                }
                if !seen.insert((id.clone(), next_ordinal.unwrap_or(0))) {
                    return Err("Cyclic Codex history reference".into());
                }
                header = Some((id, inheritance(meta, paginated)?));
            }
            if paginated {
                if next_ordinal.is_none() || record["ordinal"].as_u64() != next_ordinal {
                    return Err("Non-contiguous Codex history ordinals".into());
                }
                next_ordinal = next_ordinal.and_then(|ordinal| ordinal.checked_add(1));
            }
            visit(Some(record))
        })?;
        let (id, base) = header.ok_or("Missing initial Codex session metadata")?;
        total += length;
        if total > MAX_TOTAL as u64 {
            return Err("Complete session history exceeds the sync limit".into());
        }
        if let Some(parent) = expected.take() {
            if id != parent.id
                || !paginated
                || !complete
                || length != parent.end_byte
                || next_ordinal != Some(parent.end_ordinal)
            {
                return Err("Inherited history identity or boundary does not match".into());
            }
        }
        visit(None)?;
        let Some(parent) = base else {
            break;
        };
        if seen.len() == manifest.files.len() {
            return Err("Inherited Codex history is missing or cyclic".into());
        }
        file = manifest.parent(&parent.id, parent.end_ordinal)?;
        expected = Some(parent);
    }
    if seen.len() != manifest.files.len() {
        return Err("Session contains unreferenced history files".into());
    }
    Ok(())
}

impl History {
    fn load(
        bytes: Vec<u8>,
        parent: impl FnMut(&str, u64, u64) -> Result<Vec<u8>>,
        scope: Option<&Path>,
    ) -> Result<Self> {
        let len = bytes.len();
        let records = native::complete_records(&bytes)?;
        Self::load_from_records(len, records, parent, scope).map_err(String::from)
    }

    fn load_from_records(
        mut bytes_len: usize,
        mut records: Vec<Value>,
        mut parent: impl FnMut(&str, u64, u64) -> Result<Vec<u8>>,
        scope: Option<&Path>,
    ) -> std::result::Result<Self, SessionReadError> {
        let mut rollouts = Vec::new();
        let mut seen = BTreeSet::new();
        let mut expected: Option<(String, u64)> = None;
        let mut total = 0;
        let mut trailing_newline = true;
        loop {
            total += bytes_len;
            if bytes_len as u64 > MAX_FILE || total > MAX_TOTAL || rollouts.len() >= 200 {
                return Err(SessionReadError::unavailable(
                    "Complete session history exceeds the sync limit",
                ));
            }
            let id = session_identity("codex", &records)?.to_owned();
            if expected
                .as_ref()
                .is_some_and(|(expected_id, _)| &id != expected_id)
            {
                return Err("Inherited history identity or boundary does not match".into());
            }
            let cwd =
                native::session_cwd("codex", &records).map_err(SessionReadError::Unavailable)?;
            if !seen.insert((id.clone(), records[0]["ordinal"].as_u64().unwrap_or(0))) {
                return Err("Cyclic Codex history reference".into());
            }
            if scope.is_some_and(|root| {
                !cwd.starts_with(root)
                    || cwd
                        .components()
                        .any(|c| matches!(c, std::path::Component::ParentDir))
                    || cwd.canonicalize().is_ok_and(|p| !p.starts_with(root))
            }) {
                return Err(
                    "Inherited history belongs to another folder; session sharing paused".into(),
                );
            }
            if records.iter().any(|r| {
                !r["payload"].is_object()
                    || (r["payload"]["type"] == "thread_settings_applied"
                        && !r["payload"]["thread_settings"].is_object())
            }) {
                return Err(SessionReadError::unavailable(
                    "Unsupported Codex record shape; original preserved",
                ));
            }
            session_translation::format("codex", &records)
                .map_err(SessionReadError::Unavailable)?;
            let meta = metadata(&records).map_err(SessionReadError::Unavailable)?;
            let paginated = meta["history_mode"] == "paginated";
            if paginated {
                let first = records[0]["ordinal"]
                    .as_u64()
                    .ok_or_else(|| SessionReadError::unavailable("Missing history ordinal"))?;
                for (index, record) in records.iter().enumerate() {
                    if record["ordinal"].as_u64() != first.checked_add(index as u64) {
                        return Err(SessionReadError::unavailable(
                            "Non-contiguous Codex history ordinals",
                        ));
                    }
                }
                let base = &meta["history_base"];
                if first != base["end_ordinal_exclusive"].as_u64().unwrap_or(0) {
                    return Err(SessionReadError::unavailable(
                        "History starts outside its inherited ordinal boundary",
                    ));
                }
            }
            if let Some((_, end)) = expected.take() {
                if !paginated
                    || !trailing_newline
                    || records
                        .last()
                        .and_then(|r| r["ordinal"].as_u64())
                        .and_then(|n| n.checked_add(1))
                        != Some(end)
                {
                    return Err(SessionReadError::unavailable(
                        "Inherited history identity or boundary does not match",
                    ));
                }
            }
            let base = meta["history_base"].clone();
            rollouts.push(Rollout { id, records });
            if base.is_null() {
                break;
            }
            if !paginated {
                return Err(SessionReadError::unavailable(
                    "Legacy history cannot reference paginated ancestors",
                ));
            }
            let parent_id = base["thread_id"]
                .as_str()
                .ok_or_else(|| SessionReadError::unavailable("Missing history ancestor"))?;
            Uuid::parse_str(parent_id)
                .map_err(|_| SessionReadError::unavailable("Invalid history ancestor"))?;
            let end = base["end_ordinal_exclusive"]
                .as_u64()
                .ok_or_else(|| SessionReadError::unavailable("Missing history ordinal boundary"))?;
            let offset = base["end_byte_offset"]
                .as_u64()
                .filter(|n| *n > 0 && *n <= MAX_FILE)
                .ok_or_else(|| SessionReadError::unavailable("Invalid history byte boundary"))?;
            let next_bytes = parent(parent_id, end, offset)?;
            if next_bytes.len() as u64 != offset || next_bytes.last() != Some(&b'\n') {
                return Err(SessionReadError::unavailable(
                    "History byte boundary must end at a complete record",
                ));
            }
            bytes_len = next_bytes.len();
            trailing_newline = next_bytes.last() == Some(&b'\n');
            records =
                native::complete_records(&next_bytes).map_err(SessionReadError::Unavailable)?;
            expected = Some((parent_id.to_owned(), end));
        }
        rollouts.reverse();
        let mut history = Self { rollouts };
        history.rebase_offsets();
        Ok(history)
    }

    pub fn local(path: &Path, scope: Option<&Path>) -> Result<Self> {
        let home = native::codex_home()?;
        Self::load(
            read(path, None)?,
            |id, end, offset| parent_prefix(&home, id, end, offset),
            scope,
        )
    }

    pub fn resource(resource: &Value) -> Result<Self> {
        Self::resource_with(resource, &db::blob_read)
    }

    fn resource_with(
        resource: &Value,
        read_blob: &impl Fn(&str) -> Result<Vec<u8>>,
    ) -> Result<Self> {
        let files = resource["files"]
            .as_array()
            .ok_or("Missing history files")?;
        if files.len() > 200 {
            return Err("Too many history files".into());
        }
        let mut names = BTreeSet::new();
        for file in files {
            if !names.insert(file["path"].as_str().ok_or("Missing history path")?) {
                return Err("Duplicate history file".into());
            }
        }
        let load = |path: &str| -> Result<Vec<u8>> {
            let file = files
                .iter()
                .find(|f| f["path"] == path)
                .ok_or(ANCESTOR_MISSING)?;
            let bytes = read_blob(file["hash"].as_str().ok_or("Missing history hash")?)?;
            if bytes.len() as u64 != file["size"].as_u64().ok_or("Missing history size")? {
                return Err("History size does not match the manifest".into());
            }
            Ok(bytes)
        };
        let history = Self::load(
            load("session.jsonl")?,
            |id, end, offset| {
                let path = format!("lineage/{id}/{end}.jsonl");
                let bytes = if names.contains(path.as_str()) {
                    load(&path)?
                } else {
                    load(&format!("lineage/{id}.jsonl"))?
                };
                if bytes.len() as u64 != offset {
                    return Err("Ancestor contains history beyond its inherited boundary".into());
                }
                Ok(bytes)
            },
            None,
        )?;
        if history.rollouts.len() != files.len() {
            return Err("Session contains unreferenced history files".into());
        }
        Ok(history)
    }

    fn rebase_offsets(&mut self) {
        for i in 1..self.rollouts.len() {
            let offset = native::encode(&self.rollouts[i - 1].records).len();
            self.rollouts[i].records[0]["payload"]["history_base"]["end_byte_offset"] =
                json!(offset);
        }
    }

    pub fn remap(&mut self, ids: &[String], root: &Path) -> Result<()> {
        if ids.len() != self.rollouts.len() {
            return Err("Import identity count changed".into());
        }
        for i in 0..self.rollouts.len() {
            let meta = &mut self.rollouts[i].records[0]["payload"];
            meta["id"] = json!(ids[i]);
            if meta["session_id"].is_string() {
                meta["session_id"] = json!(ids[i]);
            }
            meta["cwd"] = json!(root);
            if i > 0 {
                meta["history_base"]["thread_id"] = json!(ids[i - 1]);
                meta["forked_from_id"] = json!(ids[i - 1]);
            }
            let original_id = self.rollouts[i].id.clone();
            for record in &mut self.rollouts[i].records {
                session_translation::relocate_codex(record, &[&original_id], &ids[i], root);
            }
            self.rollouts[i].id = ids[i].clone();
        }
        self.rebase_offsets();
        Ok(())
    }

    pub fn files(&self) -> Result<Vec<Value>> {
        self.content()?.persist()
    }

    fn content(&self) -> Result<SessionContent> {
        let last = self.rollouts.len() - 1;
        let mut content = SessionContent::default();
        for i in std::iter::once(last).chain(0..last) {
            let rollout = &self.rollouts[i];
            let bytes = native::encode(&rollout.records);
            let path = if i == last {
                "session.jsonl".into()
            } else {
                format!(
                    "lineage/{}/{}.jsonl",
                    rollout.id,
                    rollout
                        .records
                        .last()
                        .and_then(|r| r["ordinal"].as_u64())
                        .and_then(|n| n.checked_add(1))
                        .ok_or("Missing ancestor ordinal")?
                )
            };
            content.push(path, bytes);
        }
        Ok(content)
    }

    pub fn records(&self) -> Vec<Value> {
        self.rollouts
            .iter()
            .flat_map(|r| r.records.iter().cloned())
            .collect()
    }

    pub fn independent_paginated(&self, id: &str, root: &Path) -> Result<Rollout> {
        if self.rollouts.iter().any(|r| {
            r.records[0]["payload"]["source"].is_object()
                || !r.records[0]["payload"]["subagent_history_start_ordinal"].is_null()
        }) {
            return Err("Subagent history cannot be imported as a standalone conversation".into());
        }
        let mut first = self.rollouts.last().ok_or("Empty history")?.records[0].clone();
        let meta = first["payload"]
            .as_object_mut()
            .ok_or("Missing history metadata")?;
        if meta.get("history_mode") != Some(&json!("paginated")) {
            return Err("Expected paginated history".into());
        }
        // A portable copy gets a new native identity and fresh pagination
        // ordinals; retained items, turn IDs, and conversation text stay intact.
        for key in [
            "history_base",
            "forked_from_id",
            "forked_from_ordinal_exclusive",
        ] {
            meta.remove(key);
        }
        meta.insert("id".into(), json!(id));
        meta.insert("session_id".into(), json!(id));
        meta.insert("cwd".into(), json!(root));
        meta.insert("runtime_workspace_roots".into(), json!([root]));
        meta.insert("source".into(), json!("cli"));
        meta.insert("thread_source".into(), json!("cli"));
        let mut records = vec![first];
        records.extend(
            self.rollouts
                .iter()
                .flat_map(|r| r.records.iter())
                .filter(|r| r["type"] != "session_meta")
                .cloned(),
        );
        let ids = self
            .rollouts
            .iter()
            .map(|r| r.id.as_str())
            .collect::<Vec<_>>();
        for (ordinal, record) in records.iter_mut().enumerate() {
            record["ordinal"] = json!(ordinal);
            if ordinal_reference(&record["metadata"]) || ordinal_reference(&record["payload"]) {
                return Err(
                    "Unsupported ordinal reference in paginated history; original preserved".into(),
                );
            }
            session_translation::relocate_codex(record, &ids, id, root);
        }
        if native::encode(&records).len() as u64 > MAX_FILE {
            return Err(
                "Combined paginated history exceeds the native import limit of 128 MB".into(),
            );
        }
        Ok(Rollout {
            id: id.into(),
            records,
        })
    }

    pub fn independent_legacy(&self, id: &str, root: &Path) -> Result<Rollout> {
        let mut rollout = self.independent_paginated(id, root)?;
        rollout.records[0]["payload"]["history_mode"] = json!("legacy");
        for record in &mut rollout.records {
            record
                .as_object_mut()
                .ok_or("Invalid history record")?
                .remove("ordinal");
        }
        Ok(rollout)
    }
}

/// Redacted snapshot bytes held for one operation. A manifest does not imply
/// those bytes were written to the blob store.
#[derive(Default)]
pub(crate) struct SessionContent {
    files: Vec<(Value, Vec<u8>)>,
}

impl SessionContent {
    fn push(&mut self, path: String, bytes: Vec<u8>) {
        let hash = db::digest(&bytes);
        let entry = json!({"path":path,"hash":hash,"size":bytes.len(),"executable":false});
        self.files.push((entry, bytes));
    }

    pub(crate) fn single(bytes: Vec<u8>) -> Self {
        let mut content = Self::default();
        content.push("session.jsonl".into(), bytes);
        content
    }

    pub(crate) fn manifest(&self) -> Vec<Value> {
        self.files.iter().map(|(entry, _)| entry.clone()).collect()
    }

    pub(crate) fn persist(&self) -> Result<Vec<Value>> {
        for (_, bytes) in &self.files {
            db::blob(bytes)?;
        }
        Ok(self.manifest())
    }

    pub(crate) fn read(&self, hash: &str) -> Result<Vec<u8>> {
        self.files
            .iter()
            .find(|(entry, _)| entry["hash"] == hash)
            .map(|(_, bytes)| bytes.clone())
            .ok_or("Missing transcript segment".into())
    }
}

/// One read or export can use native bytes together with the ordinary frozen
/// snapshot format. Native bytes leave memory only if explicitly persisted.
pub(crate) struct SessionRead {
    pub(crate) resource: Value,
    content: Option<SessionContent>,
    records: Option<Vec<Value>>,
}

impl SessionRead {
    pub(crate) fn stored(resource: Value) -> Self {
        Self {
            resource,
            content: None,
            records: None,
        }
    }

    pub(crate) fn live(mut resource: Value, content: SessionContent) -> Self {
        resource["files"] = json!(content.manifest());
        resource["hash"] = json!(crate::indexer::manifest_hash(&resource["files"]));
        Self {
            resource,
            content: Some(content),
            records: None,
        }
    }

    pub(crate) fn from_snapshot(resource: Value, snapshot: SessionSnapshot) -> Self {
        let mut read = Self::live(resource, snapshot.content);
        read.records = Some(snapshot.redacted_records);
        read
    }

    pub(crate) fn is_live(&self) -> bool {
        self.content.is_some()
    }

    pub(crate) fn read_blob(&self, hash: &str) -> Result<Vec<u8>> {
        match &self.content {
            Some(content) => content.read(hash),
            None => db::blob_read(hash),
        }
    }

    pub(crate) fn records(&self) -> Result<std::borrow::Cow<'_, [Value]>> {
        match &self.records {
            Some(records) => Ok(std::borrow::Cow::Borrowed(records)),
            None => resource_records_with(&self.resource, &|hash| self.read_blob(hash))
                .map(std::borrow::Cow::Owned),
        }
    }

    pub(crate) fn persist(mut self) -> Result<Value> {
        if let Some(content) = self.content {
            content.persist()?;
        }
        if let Some(resource) = self.resource.as_object_mut() {
            resource.remove("nativeSession");
        }
        Ok(self.resource)
    }
}

pub(crate) struct SessionSnapshot {
    pub(crate) content: SessionContent,
    pub(crate) redacted_records: Vec<Value>,
    pub(crate) deps: Vec<(PathBuf, crate::scan_cache::FileStamp)>,
    pub(crate) ancestor_candidates: Vec<(String, Vec<PathBuf>)>,
    pub(crate) ancestor_cwds: Vec<PathBuf>,
}

/// Builds a redacted session manifest from already-parsed leaf records without
/// re-reading or re-parsing the transcript, returning the redacted records and
/// file stamps of every input segment for scan caching.
pub(crate) fn session_snapshot(
    tool: &str,
    path: &Path,
    leaf_bytes_len: usize,
    mut leaf_records: Vec<Value>,
    leaf_stamp: Option<crate::scan_cache::FileStamp>,
    scope: Option<&Path>,
    codex_index: Option<&CodexSegmentIndex>,
) -> std::result::Result<SessionSnapshot, SessionReadError> {
    let abs = std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf());
    let mut deps = Vec::new();
    if let Some(stamp) = leaf_stamp {
        deps.push((abs, stamp));
    }
    if tool == "codex" {
        let mut ancestor_deps = Vec::new();
        let mut ancestor_candidates = Vec::new();
        let mut missing_stamp = false;
        let mut history = History::load_from_records(
            leaf_bytes_len,
            leaf_records,
            |id, end, offset| {
                let (bytes, parent_path, stamp_before) = match codex_index {
                    Some(index) if INDEXED_UUID_LENGTHS.contains(&id.len()) => {
                        let cands = index.candidate_paths(id)?;
                        for candidate in &cands {
                            if let Some(stamp) = crate::scan_cache::FileStamp::of(candidate) {
                                ancestor_deps.push((candidate.clone(), stamp));
                            } else {
                                missing_stamp = true;
                            }
                        }
                        let loaded = index.parent_prefix(id, end, offset)?;
                        ancestor_candidates.push((id.to_owned(), cands));
                        loaded
                    }
                    _ => {
                        let home = native::codex_home()?;
                        let loaded = parent_prefix_in(segments(&home, id)?, end, offset)?;
                        missing_stamp = true;
                        loaded
                    }
                };
                if let Some(stamp) = stamp_before {
                    let abs_parent =
                        std::path::absolute(&parent_path).unwrap_or_else(|_| parent_path.clone());
                    ancestor_deps.push((abs_parent, stamp));
                } else {
                    missing_stamp = true;
                }
                Ok(bytes)
            },
            scope,
        )?;
        let ancestor_cwds = history.rollouts[..history.rollouts.len().saturating_sub(1)]
            .iter()
            .filter_map(|rollout| {
                rollout
                    .records
                    .first()
                    .and_then(|record| record["payload"]["cwd"].as_str())
                    .map(PathBuf::from)
            })
            .collect();
        for rollout in &mut history.rollouts {
            rollout
                .records
                .iter_mut()
                .for_each(crate::session_redaction::SessionRedactor::redact);
        }
        history.rebase_offsets();
        let content = history.content()?;
        let redacted_records = history
            .rollouts
            .into_iter()
            .flat_map(|rollout| rollout.records)
            .collect();
        if missing_stamp {
            deps.clear();
        } else {
            deps.extend(ancestor_deps);
        }
        return Ok(SessionSnapshot {
            content,
            redacted_records,
            deps,
            ancestor_candidates,
            ancestor_cwds,
        });
    }
    if tool == "pi" {
        let (_, cwd, _) = native::session_info(tool, &leaf_records)?;
        if let Some(root) = scope {
            let cwd = cwd.canonicalize().unwrap_or(cwd);
            let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
            if !cwd.starts_with(root) {
                return Err("Pi session belongs to a different repository".into());
            }
        }
    }
    leaf_records
        .iter_mut()
        .for_each(crate::session_redaction::SessionRedactor::redact);
    Ok(SessionSnapshot {
        content: SessionContent::single(native::encode(&leaf_records)),
        redacted_records: leaf_records,
        deps,
        ancestor_candidates: Vec::new(),
        ancestor_cwds: Vec::new(),
    })
}

#[cfg(test)]
pub fn session_files(tool: &str, path: &Path, scope: Option<&Path>) -> Result<Vec<Value>> {
    session_content(tool, path, scope)?.persist()
}

pub(crate) fn session_content(
    tool: &str,
    path: &Path,
    scope: Option<&Path>,
) -> Result<SessionContent> {
    if tool == "codex" {
        let mut history = History::local(path, scope)?;
        let id = &history.rollouts.last().ok_or("Empty history")?.id;
        let latest = current_path(path, id)?;
        if latest != path {
            history = History::local(&latest, scope)?;
        }
        for rollout in &mut history.rollouts {
            rollout
                .records
                .iter_mut()
                .for_each(crate::session_redaction::SessionRedactor::redact);
        }
        history.rebase_offsets();
        return history.content();
    }
    let mut records = native::complete_records(&read(path, None)?)?;
    if tool == "pi" {
        let (_, cwd, _) = native::session_info(tool, &records)?;
        if let Some(root) = scope {
            let cwd = cwd.canonicalize().unwrap_or(cwd);
            let root = root.canonicalize().unwrap_or_else(|_| root.to_path_buf());
            if !cwd.starts_with(root) {
                return Err("Pi session belongs to a different repository".into());
            }
        }
    }
    records
        .iter_mut()
        .for_each(crate::session_redaction::SessionRedactor::redact);
    Ok(SessionContent::single(native::encode(&records)))
}

/// Rebuild a stored session snapshot through the same record redaction used
/// for new snapshots, preserving the frozen revision rather than the live file.
pub fn redacted_files(source: &Value, files: &Value) -> Result<Vec<Value>> {
    let resource = json!({"source":source,"files":files});
    if source == "codex" {
        let mut history = History::resource(&resource)?;
        for rollout in &mut history.rollouts {
            rollout
                .records
                .iter_mut()
                .for_each(crate::session_redaction::SessionRedactor::redact);
        }
        history.rebase_offsets();
        return history.files();
    }
    let mut records = resource_records(&resource)?;
    records
        .iter_mut()
        .for_each(crate::session_redaction::SessionRedactor::redact);
    let bytes = native::encode(&records);
    Ok(vec![
        json!({"path":"session.jsonl","hash":db::blob(&bytes)?,"size":bytes.len(),"executable":false}),
    ])
}

pub fn resource_records(resource: &Value) -> Result<Vec<Value>> {
    resource_records_with(resource, &db::blob_read)
}

pub(crate) fn resource_records_with(
    resource: &Value,
    read_blob: &impl Fn(&str) -> Result<Vec<u8>>,
) -> Result<Vec<Value>> {
    if resource["source"] == "codex" {
        return Ok(History::resource_with(resource, read_blob)?.records());
    }
    let file = resource["files"]
        .as_array()
        .and_then(|files| files.iter().find(|f| f["path"] == "session.jsonl"))
        .ok_or("Missing transcript")?;
    let records =
        native::complete_records(&read_blob(file["hash"].as_str().ok_or("Missing hash")?)?)?;
    if resource["source"] == "pi" {
        native::validate_session_import("pi", &records)?;
    }
    Ok(records)
}
