use crate::{
    db::{self, BlobStore, Result},
    memory_context, packages, plans,
};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    cell::Cell,
    fs,
    path::{Path, PathBuf},
    time::UNIX_EPOCH,
};
use walkdir::WalkDir;

const CACHE_VERSION: &str = concat!("v3-", env!("CARGO_PKG_VERSION"));

/// These entries are optimization hints. A scan can validate or rebuild them
/// from the original files if a cached blob has been reclaimed.
pub(crate) fn is_rebuildable_key(key: &str) -> bool {
    let mut parts = key.splitn(4, ':');
    parts.next() == Some("scanCache")
        && parts.next().is_some_and(|version| !version.is_empty())
        && matches!(
            parts.next(),
            Some("file" | "plan" | "skill" | "codexSummary" | "session" | "memoryIndex")
        )
        && parts.next().is_some_and(|key| !key.is_empty())
}

thread_local! {
    static RECONCILING: Cell<bool> = const { Cell::new(false) };
}

pub(crate) fn is_reconciling() -> bool {
    RECONCILING.get()
}

/// Run a synchronous scan without trusting cached reads, while still refreshing its caches.
pub(crate) fn reconcile<T>(scan: impl FnOnce() -> T) -> T {
    struct Restore(bool);
    impl Drop for Restore {
        fn drop(&mut self) {
            RECONCILING.set(self.0);
        }
    }
    let _restore = Restore(RECONCILING.replace(true));
    scan()
}

fn read_cache(db: &Connection, key: &str) -> Result<Value> {
    if is_reconciling() {
        Ok(Value::Null)
    } else {
        db::get(db, key)
    }
}

#[cfg(test)]
thread_local! {
    static PACKAGE_FILE_READS: std::cell::RefCell<std::collections::BTreeMap<PathBuf, usize>> = Default::default();
    static PLAN_FILE_READS: std::cell::RefCell<std::collections::BTreeMap<PathBuf, usize>> = Default::default();
    static SKILL_DIR_READS: std::cell::RefCell<std::collections::BTreeMap<PathBuf, usize>> = Default::default();
    static CODEX_SUMMARY_READS: std::cell::RefCell<std::collections::BTreeMap<PathBuf, usize>> = Default::default();
    static MEMORY_INDEX_BUILDS: std::cell::RefCell<std::collections::BTreeMap<String, usize>> = Default::default();
}

#[cfg(test)]
pub(crate) fn package_file_reads(path: &Path) -> usize {
    PACKAGE_FILE_READS.with_borrow(|counts| counts.get(path).copied().unwrap_or(0))
}

#[cfg(test)]
pub(crate) fn plan_file_reads(path: &Path) -> usize {
    PLAN_FILE_READS.with_borrow(|counts| counts.get(path).copied().unwrap_or(0))
}

#[cfg(test)]
pub(crate) fn skill_dir_reads(path: &Path) -> usize {
    SKILL_DIR_READS.with_borrow(|counts| counts.get(path).copied().unwrap_or(0))
}

#[cfg(test)]
pub(crate) fn codex_summary_reads(path: &Path) -> usize {
    CODEX_SUMMARY_READS.with_borrow(|counts| counts.get(path).copied().unwrap_or(0))
}

#[cfg(test)]
pub(crate) fn memory_index_builds(memory_id: &str) -> usize {
    MEMORY_INDEX_BUILDS.with_borrow(|counts| counts.get(memory_id).copied().unwrap_or(0))
}

#[cfg(test)]
pub(crate) fn record_memory_index_build(memory_id: &str) {
    MEMORY_INDEX_BUILDS
        .with_borrow_mut(|counts| *counts.entry(memory_id.to_owned()).or_default() += 1);
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub(crate) struct FileStamp {
    pub(crate) length: u64,
    pub(crate) modified: u128,
    pub(crate) changed: (i64, i64),
    pub(crate) device: u64,
    pub(crate) inode: u64,
    pub(crate) executable: bool,
}

impl FileStamp {
    pub(crate) fn of(path: &Path) -> Option<Self> {
        let metadata = fs::symlink_metadata(path).ok()?;
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return None;
        }
        Self::from_metadata(&metadata)
    }

    pub(crate) fn from_metadata(metadata: &fs::Metadata) -> Option<Self> {
        if !metadata.is_file() || metadata.file_type().is_symlink() {
            return None;
        }
        let modified = metadata
            .modified()
            .ok()?
            .duration_since(UNIX_EPOCH)
            .ok()?
            .as_nanos();
        #[cfg(unix)]
        {
            use std::os::unix::fs::{MetadataExt, PermissionsExt};
            Some(Self {
                length: metadata.len(),
                modified,
                changed: (metadata.ctime(), metadata.ctime_nsec()),
                device: metadata.dev(),
                inode: metadata.ino(),
                executable: metadata.permissions().mode() & 0o111 != 0,
            })
        }
        #[cfg(not(unix))]
        {
            Some(Self {
                length: metadata.len(),
                modified,
                changed: (0, 0),
                device: 0,
                inode: 0,
                executable: false,
            })
        }
    }
}

pub(crate) fn verified_stamp(path: &Path, hash: &str, expected_size: u64) -> Option<FileStamp> {
    let before = FileStamp::of(path)?;
    if before.length != expected_size {
        return None;
    }
    let bytes = fs::read(path).ok()?;
    if bytes.len() as u64 == expected_size
        && db::digest(&bytes) == hash
        && FileStamp::of(path).as_ref() == Some(&before)
    {
        return Some(before);
    }
    None
}

fn cache_key(namespace: &str, scope: &Value) -> String {
    format!(
        "scanCache:{CACHE_VERSION}:{namespace}:{}",
        db::digest(scope.to_string().as_bytes())
    )
}

fn abs_path(path: &Path) -> PathBuf {
    std::path::absolute(path).unwrap_or_else(|_| path.to_path_buf())
}

#[derive(Deserialize, Serialize)]
struct CachedPackageFile {
    stamp: FileStamp,
    file: Value,
}

pub(crate) fn package_file(
    db: &Connection,
    blobs: &BlobStore,
    path: &Path,
    name: &str,
) -> Result<Value> {
    if packages::is_env_path(name) {
        return packages::file(path, name);
    }
    let Some(before) = FileStamp::of(path) else {
        return packages::file(path, name);
    };
    let key = cache_key("file", &json!([abs_path(path), name]));
    if let Ok(cached) = serde_json::from_value::<CachedPackageFile>(read_cache(db, &key)?) {
        if cached.stamp == before && blobs.all_present(std::slice::from_ref(&cached.file)) {
            return Ok(cached.file);
        }
    }
    #[cfg(test)]
    PACKAGE_FILE_READS
        .with_borrow_mut(|counts| *counts.entry(path.to_path_buf()).or_default() += 1);
    let file = packages::file(path, name)?;
    if FileStamp::of(path).as_ref() == Some(&before) {
        let entry = CachedPackageFile {
            stamp: before,
            file: file.clone(),
        };
        if let Ok(value) = serde_json::to_value(entry) {
            db::set(db, &key, &value)?;
        }
    }
    Ok(file)
}

#[derive(Deserialize, Serialize)]
struct CachedPlanFile {
    stamp: FileStamp,
    file: Value,
    title: String,
}

pub(crate) fn plan_file(
    db: &Connection,
    blobs: &BlobStore,
    path: &Path,
) -> Result<(Value, String)> {
    let Some(before) = FileStamp::of(path) else {
        return plans::file(path);
    };
    let key = cache_key("plan", &json!([abs_path(path)]));
    if let Ok(cached) = serde_json::from_value::<CachedPlanFile>(read_cache(db, &key)?) {
        if cached.stamp == before && blobs.all_present(std::slice::from_ref(&cached.file)) {
            return Ok((cached.file, cached.title));
        }
    }
    #[cfg(test)]
    PLAN_FILE_READS.with_borrow_mut(|counts| *counts.entry(path.to_path_buf()).or_default() += 1);
    let (file, title) = plans::file(path)?;
    if FileStamp::of(path).as_ref() == Some(&before) {
        let entry = CachedPlanFile {
            stamp: before,
            file: file.clone(),
            title: title.clone(),
        };
        if let Ok(value) = serde_json::to_value(entry) {
            db::set(db, &key, &value)?;
        }
    }
    Ok((file, title))
}

#[derive(Deserialize, Serialize)]
struct CachedSkillDir {
    entries: Vec<(String, FileStamp)>,
    files: Vec<Value>,
}

fn snapshot_skill_dir(path: &Path) -> Option<Vec<(String, FileStamp)>> {
    let root_meta = fs::symlink_metadata(path).ok()?;
    if !root_meta.is_dir() || root_meta.file_type().is_symlink() {
        return None;
    }
    let mut entries = Vec::new();
    for entry in WalkDir::new(path).follow_links(false) {
        let entry = entry.ok()?;
        if entry.file_type().is_symlink() {
            return None;
        }
        let rel = entry
            .path()
            .strip_prefix(path)
            .ok()?
            .to_string_lossy()
            .to_string();
        if !rel.is_empty() && packages::is_env_path(&rel) {
            return None;
        }
        if !entry.file_type().is_file() {
            continue;
        }
        packages::safe_relative(&rel).ok()?;
        let meta = entry.metadata().ok()?;
        let stamp = FileStamp::from_metadata(&meta)?;
        entries.push((rel, stamp));
    }
    entries.sort_by(|a, b| a.0.cmp(&b.0));
    Some(entries)
}

pub(crate) fn skill_directory(
    db: &Connection,
    blobs: &BlobStore,
    path: &Path,
) -> Result<Vec<Value>> {
    let Some(before) = snapshot_skill_dir(path) else {
        return packages::directory(path);
    };
    let key = cache_key("skill", &json!([abs_path(path)]));
    if let Ok(cached) = serde_json::from_value::<CachedSkillDir>(read_cache(db, &key)?) {
        if cached.entries == before && blobs.all_present(&cached.files) {
            return Ok(cached.files);
        }
    }
    #[cfg(test)]
    SKILL_DIR_READS.with_borrow_mut(|counts| *counts.entry(path.to_path_buf()).or_default() += 1);
    let files = packages::directory(path)?;
    if snapshot_skill_dir(path).as_ref() == Some(&before) {
        let entry = CachedSkillDir {
            entries: before,
            files: files.clone(),
        };
        if let Ok(value) = serde_json::to_value(entry) {
            db::set(db, &key, &value)?;
        }
    }
    Ok(files)
}

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct CodexSummaryMeta {
    pub(crate) cwd: Option<String>,
    pub(crate) thread: Option<String>,
    pub(crate) updated_at: String,
}

#[derive(Deserialize, Serialize)]
struct CachedCodexSummary {
    stamp: FileStamp,
    meta: CodexSummaryMeta,
}

pub(crate) fn codex_summary_meta(db: &Connection, path: &Path) -> Result<CodexSummaryMeta> {
    let before = FileStamp::of(path);
    let key = cache_key("codexSummary", &json!([abs_path(path)]));
    if let Some(before) = &before {
        if let Ok(cached) = serde_json::from_value::<CachedCodexSummary>(read_cache(db, &key)?) {
            if &cached.stamp == before {
                return Ok(cached.meta);
            }
        }
    }
    #[cfg(test)]
    CODEX_SUMMARY_READS
        .with_borrow_mut(|counts| *counts.entry(path.to_path_buf()).or_default() += 1);
    let text = fs::read_to_string(path).map_err(|e| e.to_string())?;
    let meta = CodexSummaryMeta {
        cwd: text
            .lines()
            .find_map(|line| line.strip_prefix("cwd: "))
            .map(|p| p.trim_matches('"').to_owned()),
        thread: memory_context::summary_thread(&text),
        updated_at: text
            .lines()
            .find_map(|line| line.strip_prefix("updated_at: "))
            .unwrap_or("")
            .to_owned(),
    };
    if let Some(before) = before {
        if FileStamp::of(path).as_ref() == Some(&before) {
            let entry = CachedCodexSummary {
                stamp: before,
                meta: meta.clone(),
            };
            if let Ok(value) = serde_json::to_value(entry) {
                db::set(db, &key, &value)?;
            }
        }
    }
    Ok(meta)
}

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct CachedEmbeddedPlan {
    pub(crate) name: String,
    pub(crate) title: String,
    pub(crate) file: Value,
    pub(crate) origin_hash: String,
}

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct CachedSession {
    pub(crate) topology: String,
    pub(crate) handoff_scope: String,
    pub(crate) deps: Vec<(PathBuf, FileStamp)>,
    #[serde(default)]
    pub(crate) ancestor_candidates: Vec<(String, Vec<PathBuf>)>,
    #[serde(default)]
    pub(crate) ancestor_cwds: Vec<PathBuf>,
    pub(crate) id: String,
    pub(crate) cwd: PathBuf,
    pub(crate) title: String,
    pub(crate) files: Vec<Value>,
    pub(crate) logical: String,
    pub(crate) native_parent: Option<String>,
    pub(crate) plans_checked: bool,
    #[serde(default)]
    pub(crate) had_plan_file: bool,
    pub(crate) plans_dir: Option<PathBuf>,
    pub(crate) plan_refs: Vec<PathBuf>,
    pub(crate) embedded_plans: Vec<CachedEmbeddedPlan>,
}

impl CachedSession {
    pub(crate) fn stamps_match(&self, path: &Path, leaf_stamp: &FileStamp) -> bool {
        let abs = abs_path(path);
        let Some((first_path, first_stamp)) = self.deps.first() else {
            return false;
        };
        if first_path != &abs || first_stamp != leaf_stamp {
            return false;
        }
        self.deps[1..]
            .iter()
            .all(|(dep_path, dep_stamp)| FileStamp::of(dep_path).as_ref() == Some(dep_stamp))
    }

    pub(crate) fn ancestors_match(
        &self,
        index: &crate::history::CodexSegmentIndex,
        checkout: &crate::worktrees::SessionCheckout,
    ) -> bool {
        self.ancestor_candidates.iter().all(|(id, expected)| {
            index
                .candidate_paths(id)
                .is_ok_and(|paths| paths == *expected)
        }) && (checkout.historical
            || self.ancestor_cwds.is_empty()
            || checkout.scope.canonicalize().is_ok_and(|scope| {
                self.ancestor_cwds.iter().all(|cwd| {
                    cwd.canonicalize()
                        .is_ok_and(|path| path.starts_with(&scope))
                })
            }))
    }

    pub(crate) fn blobs_present(
        &self,
        blobs: &BlobStore,
        check_session: bool,
        check_plans: bool,
    ) -> bool {
        (!check_session || blobs.all_present(&self.files))
            && (!check_plans
                || self
                    .embedded_plans
                    .iter()
                    .all(|plan| blobs.all_present(std::slice::from_ref(&plan.file))))
    }
}

pub(crate) fn session_key(project: &Value, root: &Path, tool: &str, path: &Path) -> String {
    let project_id = project["id"].as_str().unwrap_or("");
    format!(
        "scanCache:{CACHE_VERSION}:session:{project_id}:{}",
        db::digest(
            json!([project["sourceId"], root, tool, abs_path(path)])
                .to_string()
                .as_bytes()
        )
    )
}

pub(crate) fn clear_project(db: &Connection, project_id: &str) -> Result<()> {
    db.execute(
        "DELETE FROM meta WHERE key LIKE ?1 OR key LIKE ?2",
        rusqlite::params![
            format!("scanCache:%:session:{project_id}:%"),
            format!("scanCache:%:memoryIndex:{project_id}:%")
        ],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn load_session(db: &Connection, key: &str) -> Result<Option<CachedSession>> {
    let raw = read_cache(db, key)?;
    if raw.is_null() {
        return Ok(None);
    }
    Ok(serde_json::from_value(raw).ok())
}

pub(crate) fn save_session(db: &Connection, key: &str, cached: &CachedSession) -> Result<()> {
    if cached
        .deps
        .iter()
        .all(|(dep_path, dep_stamp)| FileStamp::of(dep_path).as_ref() == Some(dep_stamp))
    {
        if let Ok(value) = serde_json::to_value(cached) {
            db::set(db, key, &value)?;
        }
    }
    Ok(())
}

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct CachedMemoryIndexTarget {
    pub(crate) path: PathBuf,
    pub(crate) stamp: FileStamp,
    pub(crate) hash: String,
    pub(crate) size: u64,
}

#[derive(Clone, Deserialize, Serialize)]
pub(crate) struct CachedMemoryIndex {
    pub(crate) fingerprint: String,
    pub(crate) index_stamp: FileStamp,
    pub(crate) targets: Vec<CachedMemoryIndexTarget>,
    pub(crate) sources: Vec<Value>,
}

pub(crate) fn memory_index_key(project_id: &str, memory_id: &str) -> String {
    format!(
        "scanCache:{CACHE_VERSION}:memoryIndex:{project_id}:{}",
        db::digest(memory_id.as_bytes())
    )
}

pub(crate) fn load_memory_index(db: &Connection, key: &str) -> Result<Option<CachedMemoryIndex>> {
    let raw = read_cache(db, key)?;
    if raw.is_null() {
        return Ok(None);
    }
    Ok(serde_json::from_value(raw).ok())
}

pub(crate) fn save_memory_index(
    db: &Connection,
    key: &str,
    cached: &CachedMemoryIndex,
) -> Result<()> {
    if let Ok(value) = serde_json::to_value(cached) {
        db::set(db, key, &value)?;
    }
    Ok(())
}

pub(crate) fn clear_memory_index(db: &Connection, key: &str) -> Result<()> {
    let exists: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM meta WHERE key=?)",
            [key],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if exists {
        db.execute("DELETE FROM meta WHERE key=?", [key])
            .map_err(|e| e.to_string())?;
    }
    Ok(())
}
