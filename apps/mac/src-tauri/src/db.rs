use rusqlite::{params, Connection};
use serde_json::{json, Value};
use sha2::{Digest, Sha256};
use std::{
    fs,
    path::{Path, PathBuf},
};
use uuid::Uuid;
pub type Result<T> = std::result::Result<T, String>;
pub fn hex(bytes: &[u8]) -> String {
    bytes.iter().map(|b| format!("{b:02x}")).collect()
}
pub fn digest(bytes: &[u8]) -> String {
    hex(&Sha256::digest(bytes))
}
pub fn now() -> String {
    chrono::Utc::now().to_rfc3339_opts(chrono::SecondsFormat::Millis, true)
}
pub fn executable_identity() -> Result<String> {
    let path = std::env::current_exe().map_err(|e| e.to_string())?;
    let metadata = fs::metadata(&path).map_err(|e| e.to_string())?;
    let modified = metadata
        .modified()
        .map_err(|e| e.to_string())?
        .duration_since(std::time::UNIX_EPOCH)
        .map_err(|e| e.to_string())?
        .as_nanos();
    Ok(digest(
        format!("{}:{}:{modified}", path.display(), metadata.len()).as_bytes(),
    ))
}
pub fn home() -> Result<PathBuf> {
    #[cfg(debug_assertions)]
    if let Some(p) = std::env::var_os("ORKA_TEST_HOME") {
        return Ok(p.into());
    }
    dirs::home_dir().ok_or("Home directory unavailable".into())
}
pub fn root() -> Result<PathBuf> {
    crate::profiles::root(crate::profiles::current())
}
pub fn base_root() -> Result<PathBuf> {
    #[cfg(debug_assertions)]
    if let Some(p) = std::env::var_os("ORKA_TEST_HOME") {
        return Ok(PathBuf::from(p).join("orka"));
    }
    Ok(dirs::data_local_dir()
        .ok_or("Application data unavailable")?
        .join("com.orka.v1"))
}
pub fn daemon_lock() -> Result<fs::File> {
    let root = root()?;
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(root.join("daemon.lock"))
        .map_err(|e| e.to_string())
}
pub fn daemon_running() -> Result<bool> {
    use fs2::FileExt;
    let lock = daemon_lock()?;
    match lock.try_lock_exclusive() {
        Ok(()) => {
            FileExt::unlock(&lock).map_err(|e| e.to_string())?;
            Ok(false)
        }
        Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => Ok(true),
        Err(e) => Err(e.to_string()),
    }
}
pub fn profile(id: &str) -> Result<()> {
    Uuid::parse_str(id).map_err(|e| e.to_string())?;
    let r = root()?;
    fs::create_dir_all(&r).map_err(|e| e.to_string())?;
    if fs::read_to_string(r.join("account")).ok().as_deref() != Some(id) {
        crate::plugin_connection::invalidate("The Orka account changed. Reconnect the plugin.")?;
    }
    atomic(&r.join("account"), id.as_bytes())
}
pub fn guest() -> Result<()> {
    crate::plugin_connection::invalidate(
        "You signed out of Orka. Sign in and reconnect the plugin.",
    )?;
    let p = root()?.join("account");
    if p.exists() {
        fs::remove_file(p).map_err(|e| e.to_string())?;
    }
    Ok(())
}
#[derive(PartialEq, Eq)]
pub(crate) struct CacheScope {
    root: PathBuf,
    account: String,
    origin: String,
}

impl CacheScope {
    pub(crate) fn current() -> Result<Self> {
        let root = root()?;
        let account = fs::read_to_string(root.join("account")).unwrap_or("guest".into());
        if account != "guest" {
            Uuid::parse_str(&account).map_err(|e| e.to_string())?;
        }
        let config = global_setting("config")?;
        let origin = config["apiUrl"].as_str().unwrap_or("").to_owned();
        Ok(Self {
            root,
            account,
            origin,
        })
    }

    pub(crate) fn record_usage(&self, name: &'static str) {
        if self.account != "guest" && !self.origin.is_empty() {
            crate::desktop_usage::native_event(&self.account, &self.origin, name);
        }
    }

    pub(crate) fn claude_worktree_scope(&self) -> Option<String> {
        self.account_scope_digest()
    }
    pub(crate) fn account_scope_digest(&self) -> Option<String> {
        (self.account != "guest" && !self.origin.is_empty()).then(|| {
            digest(
                json!([self.root, self.account, self.origin])
                    .to_string()
                    .as_bytes(),
            )
        })
    }

    pub(crate) fn open(&self) -> Result<Connection> {
        // Bind pre-mode caches to their original service once, before any switch.
        let legacy = self.root.join("legacy-service.json");
        if !self.origin.is_empty() && !legacy.exists() {
            fs::create_dir_all(&self.root).map_err(|e| e.to_string())?;
            atomic(&legacy, json!(self.origin).to_string().as_bytes())?;
        }
        open_at(&self.path()?)
    }

    pub(crate) fn path(&self) -> Result<PathBuf> {
        if self.account == "guest" {
            Ok(self.root.join(&self.account))
        } else {
            profile_path(&self.account, &self.origin)
        }
    }

    pub(crate) fn open_read_only(&self) -> Result<Connection> {
        Connection::open_with_flags(
            self.path()?.join("sync.sqlite"),
            rusqlite::OpenFlags::SQLITE_OPEN_READ_ONLY,
        )
        .map_err(|e| e.to_string())
    }

    pub(crate) fn blob_reader(&self) -> impl Fn(&str) -> Result<Vec<u8>> {
        let dir = blob_dir(&self.root, &self.origin);
        move |hash| read_blob(&dir, hash)
    }
}

pub fn open() -> Result<Connection> {
    CacheScope::current()?.open()
}
pub fn profile_path(id: &str, origin: &str) -> Result<PathBuf> {
    Uuid::parse_str(id).map_err(|e| e.to_string())?;
    let root = root()?;
    let legacy: Value = fs::read(root.join("legacy-service.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(Value::Null);
    if legacy.as_str() == Some(origin) && root.join(id).is_dir() {
        return Ok(root.join(id));
    }
    Ok(root
        .join("services")
        .join(digest(origin.as_bytes()))
        .join(id))
}
pub fn open_at(root: &Path) -> Result<Connection> {
    fs::create_dir_all(root).map_err(|e| e.to_string())?;
    use std::os::unix::fs::PermissionsExt;
    fs::set_permissions(root, fs::Permissions::from_mode(0o700)).map_err(|e| e.to_string())?;
    let db = Connection::open(root.join("sync.sqlite")).map_err(|e| e.to_string())?;
    db.busy_timeout(std::time::Duration::from_secs(5))
        .map_err(|e| e.to_string())?;
    db.execute_batch("PRAGMA journal_mode=WAL; CREATE TABLE IF NOT EXISTS meta(key TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS projects(id TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS resources(id TEXT PRIMARY KEY,project TEXT NOT NULL,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS bindings(id TEXT PRIMARY KEY,project TEXT NOT NULL,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS outbox(id TEXT PRIMARY KEY,project TEXT NOT NULL,path TEXT NOT NULL,value TEXT NOT NULL,error TEXT); CREATE TABLE IF NOT EXISTS cursors(project TEXT PRIMARY KEY,cursor INTEGER NOT NULL); CREATE TABLE IF NOT EXISTS conflicts(id TEXT PRIMARY KEY,project TEXT NOT NULL,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS activity(id TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS active(native_id TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS errors(source TEXT PRIMARY KEY,error TEXT NOT NULL); CREATE TABLE IF NOT EXISTS drafts(id TEXT PRIMARY KEY,project TEXT NOT NULL,value TEXT NOT NULL);").map_err(|e|e.to_string())?;
    db.execute_batch(
        "CREATE TRIGGER IF NOT EXISTS prune_hook_activity AFTER UPDATE OF value ON projects BEGIN
            DELETE FROM meta WHERE key IN (
                SELECT tool.prefix || source.id FROM
                (SELECT 'hookSeen:claude:' AS prefix UNION ALL SELECT 'hookSeen:codex:') tool,
                (SELECT old.id AS id WHERE json_type(old.value,'$.sources') IS NOT 'array'
                    UNION SELECT json_extract(value,'$.id') FROM json_each(old.value,'$.sources')) source
                WHERE json_extract(new.value,'$.purged') = 1 OR NOT (
                    (source.id = new.id AND json_type(new.value,'$.sources') IS NOT 'array') OR
                    EXISTS (SELECT 1 FROM json_each(new.value,'$.sources')
                        WHERE json_extract(value,'$.id') = source.id
                          AND json_extract(value,'$.removedAt') IS NULL)
                )
            );
        END;",
    ).map_err(|e| e.to_string())?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS local_resources(id TEXT PRIMARY KEY,project TEXT NOT NULL,value TEXT NOT NULL);").map_err(|e|e.to_string())?;
    db.execute_batch("CREATE TABLE IF NOT EXISTS worktree_routes(scope TEXT PRIMARY KEY,value TEXT NOT NULL); CREATE TABLE IF NOT EXISTS worktree_sessions(tool TEXT NOT NULL,native_id TEXT NOT NULL,value TEXT NOT NULL,PRIMARY KEY(tool,native_id));").map_err(|e| e.to_string())?;
    // One pending sync job per project; '*' is the workspace-wide steps. Times are Unix milliseconds.
    db.execute_batch("CREATE TABLE IF NOT EXISTS sync_queue(project TEXT PRIMARY KEY,priority INTEGER NOT NULL,reason TEXT NOT NULL,requested_at INTEGER NOT NULL,not_before INTEGER NOT NULL,attempts INTEGER NOT NULL DEFAULT 0);").map_err(|e|e.to_string())?;
    crate::selective_sharing::migrate_share_destinations(&db)?;
    Ok(db)
}
fn global_setting(key: &str) -> Result<Value> {
    match fs::read(root()?.join(format!("{key}.json"))) {
        Ok(bytes) => serde_json::from_slice(&bytes).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(Value::Null),
        Err(e) => Err(e.to_string()),
    }
}

pub(crate) fn service_config() -> Result<Value> {
    global_setting("config")
}

pub(crate) fn matches_cloud_account(account: &str, origin: &str) -> Result<bool> {
    if Uuid::parse_str(account).is_err() || origin.is_empty() {
        return Ok(false);
    }
    let config = service_config()?;
    // A pre-mode profile can still connect to Cloud, subject to its live capability.
    Ok(config["apiUrl"] == origin
        && (config["mode"].is_null() || config["mode"] == "cloud")
        && fs::read_to_string(root()?.join("account")).is_ok_and(|selected| selected == account))
}

pub fn get(db: &Connection, key: &str) -> Result<Value> {
    if key == "config" || key == "background" {
        return global_setting(key);
    }
    let raw = db.query_row("SELECT value FROM meta WHERE key=?", [key], |r| {
        r.get::<_, String>(0)
    });
    match raw {
        Ok(s) => serde_json::from_str(&s).map_err(|e| e.to_string()),
        Err(rusqlite::Error::QueryReturnedNoRows) => Ok(Value::Null),
        Err(e) => Err(e.to_string()),
    }
}
pub fn set(db: &Connection, key: &str, value: &Value) -> Result<()> {
    if key == "config" || key == "background" {
        let r = root()?;
        fs::create_dir_all(&r).map_err(|e| e.to_string())?;
        if key == "config" && global_setting(key)?["apiUrl"] != value["apiUrl"] {
            crate::plugin_connection::invalidate(
                "The Orka service changed. Reconnect the plugin.",
            )?;
        }
        return atomic(&r.join(format!("{key}.json")), value.to_string().as_bytes());
    }
    let encoded = value.to_string();
    let existing = db
        .query_row("SELECT value FROM meta WHERE key=?", [key], |r| {
            r.get::<_, String>(0)
        })
        .ok();
    if existing.as_deref() == Some(encoded.as_str()) {
        return Ok(());
    }
    db.execute(
        "INSERT INTO meta VALUES(?,?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
        params![key, encoded],
    )
    .map_err(|e| e.to_string())?;
    Ok(())
}
pub fn rows(db: &Connection, sql: &str, values: &[&dyn rusqlite::ToSql]) -> Result<Vec<Value>> {
    let mut q = db.prepare(sql).map_err(|e| e.to_string())?;
    let rows = q
        .query_map(values, |r| r.get::<_, String>(0))
        .map_err(|e| e.to_string())?;
    rows.map(|r| serde_json::from_str(&r.map_err(|e| e.to_string())?).map_err(|e| e.to_string()))
        .collect()
}
pub fn upsert(db: &Connection, table: &str, id: &str, project: &str, value: &Value) -> Result<()> {
    if ![
        "projects",
        "resources",
        "bindings",
        "conflicts",
        "drafts",
        "local_resources",
    ]
    .contains(&table)
    {
        return Err("Invalid table".into());
    }
    let sql = if table == "projects" {
        // Only the local-name command changes this preference. Preserve it even
        // when a folder operation saves a project read before that command ran.
        format!(
            "INSERT INTO {table} VALUES(?1,?3) ON CONFLICT(id) DO UPDATE SET value=json_set(excluded.value,'$.localName',json_extract(projects.value,'$.localName'))"
        )
    } else {
        format!("INSERT INTO {table} VALUES(?1,?2,?3) ON CONFLICT(id) DO UPDATE SET value=excluded.value")
    };
    db.execute(&sql, params![id, project, value.to_string()])
        .map_err(|e| e.to_string())?;
    Ok(())
}
pub fn device(db: &Connection) -> Result<String> {
    let v = get(db, "device")?;
    if let Some(s) = v.as_str() {
        return Ok(s.into());
    }
    // An account store lives in a folder named for its account. Guest and
    // standalone stores, or a Mac that cannot be identified, stay random.
    let account = db
        .path()
        .and_then(|path| Path::new(path).parent()?.file_name()?.to_str())
        .and_then(|name| Uuid::parse_str(name).ok());
    let id = account
        .and_then(|account| crate::device_metadata::stable_id(&account))
        .unwrap_or_else(|| Uuid::new_v4().to_string());
    set(db, "device", &json!(id))?;
    Ok(id)
}
pub fn atomic(path: &Path, bytes: &[u8]) -> Result<()> {
    let parent = path.parent().ok_or("Missing parent")?;
    if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        return Err("Destination is a symlink".into());
    }
    let mut staged = tempfile::NamedTempFile::new_in(parent).map_err(|e| e.to_string())?;
    use std::io::Write;
    staged.write_all(bytes).map_err(|e| e.to_string())?;
    staged.as_file().sync_all().map_err(|e| e.to_string())?;
    staged.persist(path).map_err(|e| e.to_string())?;
    fs::File::open(parent)
        .and_then(|f| f.sync_all())
        .map_err(|e| e.to_string())?;
    Ok(())
}
pub(crate) fn checked_blob_path(dir: &Path, hash: &str) -> Result<PathBuf> {
    if hash.len() != 64 || !hash.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err("Invalid hash".into());
    }
    Ok(dir.join(hash))
}

fn blob_dir(root: &Path, origin: &str) -> PathBuf {
    let legacy: Value = fs::read(root.join("legacy-service.json"))
        .ok()
        .and_then(|bytes| serde_json::from_slice(&bytes).ok())
        .unwrap_or(Value::Null);
    let digest =
        (!origin.is_empty() && legacy.as_str() != Some(origin)).then(|| digest(origin.as_bytes()));
    blob_dir_in_scope(root, digest.as_deref())
}

pub(crate) fn blob_dir_in_scope(root: &Path, service_digest: Option<&str>) -> PathBuf {
    match service_digest {
        Some(digest) => root.join("services").join(digest).join("blobs"),
        None => root.join("blobs"),
    }
}

pub(crate) struct BlobStore {
    dir: PathBuf,
}

impl BlobStore {
    pub(crate) fn current() -> Result<Self> {
        let config = global_setting("config")?;
        let dir = blob_dir(&root()?, config["apiUrl"].as_str().unwrap_or(""));
        Ok(Self { dir })
    }

    pub(crate) fn present(&self, hash: &str, expected_size: u64) -> bool {
        use crate::scan_cache::FileStamp;
        use std::{
            collections::HashMap,
            sync::{LazyLock, Mutex},
        };

        // Memoize successful digest checks in the worker process.
        // The service-scoped path includes the expected digest in its filename.
        static VERIFIED: LazyLock<Mutex<HashMap<PathBuf, FileStamp>>> =
            LazyLock::new(|| Mutex::new(HashMap::new()));

        let Ok(path) = checked_blob_path(&self.dir, hash) else {
            return false;
        };
        let Some(stamp) = FileStamp::of(&path) else {
            return false;
        };
        if stamp.length != expected_size {
            return false;
        }
        if !crate::scan_cache::is_reconciling()
            && VERIFIED
                .lock()
                .is_ok_and(|cache| cache.get(&path) == Some(&stamp))
        {
            return true;
        }
        let Some(verified) = crate::scan_cache::verified_stamp(&path, hash, expected_size) else {
            return false;
        };
        if let Ok(mut cache) = VERIFIED.lock() {
            if cache.len() >= 8192 {
                cache.clear();
            }
            cache.insert(path, verified);
        }
        true
    }

    pub(crate) fn all_present(&self, files: &[Value]) -> bool {
        files.iter().all(|file| {
            file["hash"]
                .as_str()
                .zip(file["size"].as_u64())
                .is_some_and(|(hash, size)| self.present(hash, size))
        })
    }
}

pub fn blob_path(hash: &str) -> Result<PathBuf> {
    let config = global_setting("config")?;
    let dir = blob_dir(&root()?, config["apiUrl"].as_str().unwrap_or(""));
    let path = checked_blob_path(&dir, hash)?;
    fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
    Ok(path)
}
pub fn blob(bytes: &[u8]) -> Result<String> {
    let h = digest(bytes);
    let p = blob_path(&h)?;
    if !fs::read(&p).is_ok_and(|cached| digest(&cached) == h) {
        atomic(&p, bytes)?;
    }
    Ok(h)
}
pub fn blob_read(hash: &str) -> Result<Vec<u8>> {
    let config = global_setting("config")?;
    read_blob(
        &blob_dir(&root()?, config["apiUrl"].as_str().unwrap_or("")),
        hash,
    )
}

fn read_blob(dir: &Path, hash: &str) -> Result<Vec<u8>> {
    let b = fs::read(checked_blob_path(dir, hash)?).map_err(|e| e.to_string())?;
    if digest(&b) != hash {
        return Err("Blob hash mismatch".into());
    }
    Ok(b)
}
pub fn validate_url(raw: &str) -> Result<reqwest::Url> {
    let u = reqwest::Url::parse(raw).map_err(|e| e.to_string())?;
    if u.scheme() != "https"
        && !(u.scheme() == "http" && matches!(u.host_str(), Some("127.0.0.1" | "localhost")))
    {
        return Err("Use HTTPS; localhost HTTP is allowed for development".into());
    }
    if !u.username().is_empty()
        || u.password().is_some()
        || u.query().is_some()
        || u.fragment().is_some()
    {
        return Err("Invalid service URL".into());
    }
    Ok(u)
}
