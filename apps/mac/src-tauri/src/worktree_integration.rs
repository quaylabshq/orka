use crate::{
    db::{self, Result},
    git_artifacts::{self, Excludes},
    native::Hooks,
    onboarding::discovery::{registered_checkout, worktree_admin_dirs},
    worktrees,
};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{self, Read},
    os::unix::fs::{MetadataExt, OpenOptionsExt},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const LEDGER: &str = "worktreeIntegration";
const MAX_FILE: u64 = 1_000_000;

pub(crate) struct Poll(tokio::task::JoinHandle<()>);

impl Poll {
    pub(crate) fn start() -> Self {
        Self(tokio::spawn(async {
            let mut state = Backoff::default();
            loop {
                let worker = tokio::task::spawn_blocking(move || {
                    let result = (|| -> Result<()> {
                        use fs2::FileExt;
                        let lock = fs::OpenOptions::new()
                            .create(true)
                            .truncate(false)
                            .write(true)
                            .open(db::root()?.join("worktree-poll.lock"))
                            .map_err(|e| e.to_string())?;
                        // A previous daemon's blocking pass can outlive foreground handoff.
                        if lock.try_lock_exclusive().is_err() {
                            return Ok(());
                        }
                        let db = db::open()?;
                        if db::get(&db, "user")?
                            .as_str()
                            .is_some_and(|s| !s.is_empty())
                        {
                            let result = reconcile_with(
                                &db,
                                &crate::updates::executable().map_err(|e| e.to_string())?,
                                &mut state,
                            );
                            crate::sync::record_result(&db, LEDGER, result)?;
                        }
                        Ok(())
                    })();
                    if let Err(error) = result {
                        eprintln!("Worktree integration: {error}");
                    }
                    state
                });
                let Ok(next) = worker.await else {
                    return;
                };
                state = next;
                tokio::time::sleep(Duration::from_secs(5)).await;
            }
        }))
    }
}

impl Drop for Poll {
    fn drop(&mut self) {
        self.0.abort();
    }
}

#[derive(Default)]
struct Backoff(BTreeMap<PathBuf, (Instant, Duration)>);

impl Backoff {
    fn ready(&self, path: &Path) -> bool {
        self.0
            .get(path)
            .is_none_or(|(until, _)| Instant::now() >= *until)
    }

    fn failed(&mut self, path: &Path) {
        let delay = self
            .0
            .get(path)
            .map_or(Duration::from_secs(10), |(_, previous)| {
                (*previous * 2).min(Duration::from_secs(120))
            });
        self.0
            .insert(path.to_path_buf(), (Instant::now() + delay, delay));
    }

    fn available(&mut self, path: &Path) {
        self.0.remove(path);
    }
}

#[derive(Serialize, Deserialize)]
struct Installed {
    checkout: PathBuf,
    admin: PathBuf,
    relative: PathBuf,
    device: u64,
    inode: u64,
    fingerprint: String,
    #[serde(default)]
    source_root: PathBuf,
    #[serde(default)]
    restore: Option<Vec<u8>>,
    #[serde(default)]
    pending: Option<Pending>,
    #[serde(default)]
    retired: bool,
    #[serde(default)]
    protected: bool,
}

#[derive(Serialize, Deserialize)]
struct Pending {
    fingerprint: String,
    scratch: PathBuf,
}

impl Installed {
    fn key(&self) -> Result<String> {
        serde_json::to_string(&(&self.admin, &self.relative)).map_err(|e| e.to_string())
    }

    fn common(&self) -> Result<&Path> {
        common_for(&self.admin)
    }

    fn save(&self, db: &Connection) -> Result<()> {
        let value = serde_json::to_string(self).map_err(|e| e.to_string())?;
        db.execute("INSERT INTO worktree_artifacts(id,value) VALUES(?,?) ON CONFLICT(id) DO UPDATE SET value=excluded.value", params![self.key()?, value]).map_err(|e| e.to_string())?;
        Ok(())
    }

    fn finish(&mut self, db: &Connection, file: &File) -> Result<()> {
        self.pending = None;
        self.protected = true;
        self.device = file.device;
        self.inode = file.inode;
        self.fingerprint.clone_from(&file.hash);
        self.save(db)
    }
}

fn common_for(admin: &Path) -> Result<&Path> {
    admin
        .parent()
        .and_then(Path::parent)
        .ok_or_else(|| "Missing common Git directory".into())
}

fn ledger(db: &Connection) -> Result<Vec<Installed>> {
    db::rows(db, "SELECT value FROM worktree_artifacts ORDER BY id", &[])?
        .into_iter()
        .map(|value| serde_json::from_value(value).map_err(|e| e.to_string()))
        .collect()
}

fn migrate_ledger(db: &Connection) -> Result<()> {
    db.execute_batch(
        "CREATE TABLE IF NOT EXISTS worktree_artifacts(id TEXT PRIMARY KEY,value TEXT NOT NULL);",
    )
    .map_err(|e| e.to_string())?;
    let stored = db::get(db, LEDGER)?;
    if stored.is_null() || stored == serde_json::json!([]) {
        return Ok(());
    }
    let entries: Vec<Installed> = serde_json::from_value(stored).map_err(|e| e.to_string())?;
    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    for entry in entries {
        entry.save(&tx)?;
    }
    db::set(&tx, LEDGER, &serde_json::json!([]))?;
    tx.commit().map_err(|e| e.to_string())
}

struct File {
    bytes: Vec<u8>,
    hash: String,
    device: u64,
    inode: u64,
    mode: u32,
}

impl File {
    fn identity(&self) -> (u64, u64, &str) {
        (self.device, self.inode, &self.hash)
    }
}

fn read_file(path: &Path) -> io::Result<Option<File>> {
    let metadata = match fs::symlink_metadata(path) {
        Ok(metadata) => metadata,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(error) => return Err(error),
    };
    let (bytes, hash) = if metadata.file_type().is_symlink() {
        // Match only legacy ledger entries; never deliver or read through a link.
        (
            Vec::new(),
            format!("link:{}", fs::read_link(path)?.display()),
        )
    } else if metadata.is_file() && metadata.len() <= MAX_FILE {
        let file = fs::OpenOptions::new()
            .read(true)
            .custom_flags(libc::O_NOFOLLOW | libc::O_NONBLOCK)
            .open(path)?;
        let opened = file.metadata()?;
        if !opened.is_file() || (opened.dev(), opened.ino()) != (metadata.dev(), metadata.ino()) {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Integration file changed while opening",
            ));
        }
        let mut bytes = Vec::new();
        file.take(MAX_FILE + 1).read_to_end(&mut bytes)?;
        if bytes.len() as u64 > MAX_FILE {
            return Err(io::Error::new(
                io::ErrorKind::InvalidData,
                "Integration file is too large",
            ));
        }
        let hash = db::digest(&bytes);
        (bytes, hash)
    } else {
        return Err(io::Error::new(
            io::ErrorKind::InvalidData,
            "Not a regular integration file, or too large",
        ));
    };
    Ok(Some(File {
        bytes,
        hash,
        device: metadata.dev(),
        inode: metadata.ino(),
        mode: metadata.mode(),
    }))
}

#[derive(Clone)]
struct SkillFile {
    bytes: Vec<u8>,
    hash: String,
    mode: u32,
}

fn skills(root: &Path) -> Result<BTreeMap<PathBuf, SkillFile>> {
    let mut files = BTreeMap::new();
    for folder in [".agents/skills", ".claude/skills"] {
        let directory = root.join(folder);
        match directory.canonicalize() {
            Ok(resolved) if resolved == directory => (),
            Ok(_) => continue,
            Err(error) if error.kind() == io::ErrorKind::NotFound => continue,
            Err(error) => return Err(error.to_string()),
        }
        for entry in fs::read_dir(directory).map_err(|e| e.to_string())? {
            let entry = entry.map_err(|e| e.to_string())?;
            if !entry.file_type().map_err(|e| e.to_string())?.is_dir()
                || entry.file_name().to_string_lossy().starts_with('.')
                || !fs::symlink_metadata(entry.path().join("SKILL.md")).is_ok_and(|m| m.is_file())
            {
                continue;
            }
            let mut count = 0;
            let mut size = 0;
            for file in walkdir::WalkDir::new(entry.path()).follow_links(false) {
                let file = file.map_err(|e| e.to_string())?;
                if !file.file_type().is_file() {
                    continue;
                }
                let relative = file.path().strip_prefix(root).map_err(|e| e.to_string())?;
                if crate::packages::is_env_path(&relative.to_string_lossy()) {
                    continue;
                }
                let Some(file) = read_file(file.path()).map_err(|e| e.to_string())? else {
                    continue;
                };
                if file.hash.starts_with("link:") {
                    continue;
                }
                count += 1;
                size += file.bytes.len();
                if count > 200 || size > 4_000_000 {
                    return Err(format!(
                        "Skill package is too large: {}",
                        entry.path().display()
                    ));
                }
                files.insert(
                    relative.to_path_buf(),
                    SkillFile {
                        bytes: file.bytes,
                        hash: file.hash,
                        mode: file.mode & 0o100 | 0o600,
                    },
                );
            }
        }
    }
    Ok(files)
}

#[derive(Clone, Copy)]
enum Artifact<'a> {
    Hook(&'static str),
    Skill(&'a SkillFile),
}

struct Destination<'a> {
    checkout: &'a Path,
    root: &'a Path,
    relative: PathBuf,
    artifact: Artifact<'a>,
}

#[derive(Default)]
struct Topology {
    admins: BTreeMap<PathBuf, Option<PathBuf>>,
    unavailable: BTreeSet<PathBuf>,
}

impl Topology {
    fn common(&mut self, common: &Path, backoff: &mut Backoff) -> Result<()> {
        if !backoff.ready(common) {
            self.unavailable.insert(common.to_path_buf());
            return Ok(());
        }
        let admins = match worktree_admin_dirs(common) {
            Ok(admins) => admins,
            Err(error) => {
                backoff.failed(common);
                self.unavailable.insert(common.to_path_buf());
                return Err(error.to_string());
            }
        };
        backoff.available(common);
        for admin in admins {
            self.registration(&admin, backoff);
        }
        Ok(())
    }

    fn registration(&mut self, admin: &Path, backoff: &mut Backoff) -> Option<&Path> {
        self.admins
            .entry(admin.to_path_buf())
            .or_insert_with(|| {
                if !backoff.ready(admin) {
                    return None;
                }
                let checkout = registered_checkout(admin);
                if checkout.is_some() || matches!(fs::symlink_metadata(admin), Err(error) if error.kind() == io::ErrorKind::NotFound) {
                    backoff.available(admin);
                } else {
                    backoff.failed(admin);
                }
                checkout
            })
            .as_deref()
    }
}

#[derive(Default)]
struct Pass {
    failures: Vec<String>,
}

impl Pass {
    fn diagnostic(&mut self, path: &Path, message: impl std::fmt::Display) {
        self.failures.push(format!("{}: {message}", path.display()));
    }

    fn finish(mut self, db: &Connection) -> Result<()> {
        let entries = ledger(db)?;
        let mut kept = BTreeSet::new();
        for entry in entries.iter().filter(|entry| !entry.retired) {
            kept.insert((entry.common()?, entry.relative.as_path()));
        }
        for entry in entries.iter().filter(|entry| entry.retired) {
            let common = entry.common()?;
            let result = (|| -> Result<()> {
                let release = !kept.contains(&(common, entry.relative.as_path()));
                if release || entry.pending.is_some() {
                    let mut excludes = Excludes::open(common)?;
                    if release {
                        excludes.release(&entry.relative)?;
                    }
                    if let Some(pending) = &entry.pending {
                        excludes.release(&pending.scratch)?;
                    }
                }
                db.execute("DELETE FROM worktree_artifacts WHERE id=?", [entry.key()?])
                    .map_err(|e| e.to_string())?;
                Ok(())
            })();
            if let Err(error) = result {
                self.diagnostic(common, error);
            }
        }
        if self.failures.is_empty() {
            Ok(())
        } else {
            Err(self.failures.join("; "))
        }
    }
}

fn install(
    db: &Connection,
    mut entry: Installed,
    destination: &Destination<'_>,
    executable: &Path,
    owned: bool,
    existing: Option<File>,
) -> Result<()> {
    let replacing = existing.is_some();
    let hook_config;
    let (bytes, hash, mode) = match destination.artifact {
        Artifact::Skill(skill) => {
            if replacing && !owned {
                return Err("Existing skill file is not managed by Orka".into());
            }
            (skill.bytes.as_slice(), skill.hash.clone(), skill.mode)
        }
        Artifact::Hook(tool) => {
            if existing
                .as_ref()
                .is_some_and(|file| file.hash.starts_with("link:"))
            {
                return Err("Existing hook file is a symlink".into());
            }
            let (bytes, restore) = Hooks::worktree_config(
                existing.as_ref().map(|file| file.bytes.as_slice()),
                executable,
                tool,
            )?;
            let hash = db::digest(&bytes);
            hook_config = bytes;
            entry.restore = restore;
            (hook_config.as_slice(), hash, 0o600)
        }
    };
    if owned && entry.fingerprint == hash && entry.protected {
        return Ok(());
    }
    let path = entry.checkout.join(&entry.relative);
    let mut excludes = Excludes::open(entry.common()?)?;
    git_artifacts::untracked(&entry.checkout, &entry.relative)?;
    let scratch = entry
        .relative
        .with_file_name(format!(".orka-{}.pending", uuid::Uuid::new_v4()));
    entry.pending = Some(Pending {
        fingerprint: hash.clone(),
        scratch: scratch.clone(),
    });
    entry.save(db)?;
    excludes.protect(&entry.checkout, &entry.relative, false)?;
    if let Some(file) = existing.as_ref().filter(|file| file.hash == hash) {
        return entry.finish(db, file);
    }
    excludes.protect(&entry.checkout, &scratch, false)?;
    let parent = path.parent().ok_or("Missing integration parent")?;
    crate::packages::safe_directory(&entry.checkout, parent)?;
    let scratch_path = entry.checkout.join(&scratch);
    let current = read_file(&path).map_err(|e| e.to_string())?;
    if current.as_ref().map(File::identity) != existing.as_ref().map(File::identity) {
        return Err("Destination changed while checking Git protection".into());
    }
    git_artifacts::publish(&path, &scratch_path, bytes, mode, replacing)?;
    excludes.release(&scratch)?;
    let file = read_file(&path)
        .map_err(|e| e.to_string())?
        .ok_or("Published integration file disappeared")?;
    if file.hash != hash {
        return Err("Published integration file changed".into());
    }
    entry.finish(db, &file)
}

fn checked_parent(checkout: &Path, path: &Path) -> Result<()> {
    for parent in path.ancestors().skip(1).take_while(|p| *p != checkout) {
        match fs::symlink_metadata(parent) {
            Ok(m) if m.is_dir() => (),
            Err(error) if error.kind() == io::ErrorKind::NotFound => (),
            Ok(_) => return Err("Integration parent is a symlink or not a directory".into()),
            Err(error) => return Err(error.to_string()),
        }
    }
    Ok(())
}

fn retire(db: &Connection, mut entry: Installed) -> Result<()> {
    entry.retired = true;
    entry.save(db)
}

fn recover_pending(
    db: &Connection,
    entry: &mut Installed,
    file: Option<&File>,
    registered: bool,
) -> Result<()> {
    let Some(pending) = &entry.pending else {
        return Ok(());
    };
    let scratch = entry.checkout.join(&pending.scratch);
    match read_file(&scratch).map_err(|e| e.to_string())? {
        Some(file) if file.hash == pending.fingerprint => {
            if registered {
                git_artifacts::untracked(&entry.checkout, &pending.scratch)?;
            }
            fs::remove_file(scratch).map_err(|e| e.to_string())?;
        }
        Some(_) => {
            return Err("Interrupted scratch file does not match its ownership journal".into())
        }
        None => (),
    }
    let mut excludes = Excludes::open(entry.common()?)?;
    excludes.release(&pending.scratch)?;
    if let Some(file) = file.filter(|file| file.hash == pending.fingerprint) {
        if registered {
            excludes.protect(&entry.checkout, &entry.relative, false)?;
        }
        entry.finish(db, file)?;
    } else {
        entry.pending = None;
        entry.save(db)?;
    }
    Ok(())
}

fn reconcile_entry(
    db: &Connection,
    mut entry: Installed,
    destination: Option<&Destination<'_>>,
    executable: &Path,
    registered: bool,
) -> Result<()> {
    let path = entry.checkout.join(&entry.relative);
    checked_parent(&entry.checkout, &path)?;
    let file = read_file(&path).map_err(|e| e.to_string())?;
    recover_pending(db, &mut entry, file.as_ref(), registered)?;
    let owned = file.as_ref().is_some_and(|file| {
        file.hash == entry.fingerprint
            && ((registered && !file.hash.starts_with("link:"))
                || (file.device, file.inode) == (entry.device, entry.inode))
    });
    if let Some(destination) = destination {
        if owned
            || entry.fingerprint.is_empty()
            || matches!(destination.artifact, Artifact::Hook(_))
        {
            return install(db, entry, destination, executable, owned, file);
        }
        return Err("Managed file was changed or removed in this worktree; left untouched".into());
    }
    if owned {
        if registered {
            git_artifacts::untracked(&entry.checkout, &entry.relative)?;
        }
        if let Some(restore) = &entry.restore {
            if !registered {
                return Err(
                    "Cannot safely restore foreign hooks without a registered checkout".into(),
                );
            }
            let common = entry.common()?.to_path_buf();
            let mut excludes = Excludes::open(&common)?;
            excludes.protect(&entry.checkout, &entry.relative, false)?;
            let scratch = git_artifacts::scratch(&entry.relative);
            excludes.protect(&entry.checkout, &scratch, false)?;
            git_artifacts::publish(&path, &entry.checkout.join(&scratch), restore, 0o600, true)?;
            excludes.release(&scratch)?;
        } else {
            fs::remove_file(&path).map_err(|e| e.to_string())?;
        }
    } else if file
        .as_ref()
        .is_some_and(|file| entry.restore.as_ref() != Some(&file.bytes))
        && registered
        && !entry.fingerprint.is_empty()
    {
        // The user's edit survives disconnect. Do not turn a formerly ignored file into a stageable one.
        let mut excludes = Excludes::open(entry.common()?)?;
        excludes.protect(&entry.checkout, &entry.relative, true)?;
    }
    retire(db, entry)
}

fn reconcile_with(db: &Connection, executable: &Path, backoff: &mut Backoff) -> Result<()> {
    migrate_ledger(db)?;
    let home = worktrees::home()?;
    let mut pass = Pass::default();
    let mut sources = Vec::new();
    let mut unavailable_roots = BTreeSet::new();
    for source in worktrees::active_sources(db)? {
        let Some(path) = source["path"].as_str().map(Path::new) else {
            continue;
        };
        if !backoff.ready(path) {
            unavailable_roots.insert(path.to_path_buf());
            continue;
        }
        match fs::metadata(path) {
            Ok(_) => {
                backoff.available(path);
                sources.push(source);
            }
            Err(error) => {
                backoff.failed(path);
                unavailable_roots.insert(path.to_path_buf());
                pass.diagnostic(path, error);
            }
        }
    }
    let resolver = worktrees::Resolver::new(&sources, &home);
    let mut inventories = BTreeMap::new();
    let mut topology = Topology::default();
    let mut scanned = BTreeSet::new();
    let mut candidates = Vec::new();
    for (source, root, main, common) in resolver.primary_sources() {
        if scanned.insert(common) {
            if let Err(error) = topology.common(common, backoff) {
                pass.diagnostic(common, error);
            }
        }
        match crate::sources::waiting_to_sync(db, source) {
            Ok(false) => (),
            Ok(true) => {
                unavailable_roots.insert(root.to_path_buf());
                continue;
            }
            Err(error) => {
                unavailable_roots.insert(root.to_path_buf());
                pass.diagnostic(root, error);
                continue;
            }
        }
        if crate::projects::sharing_allowed(source, "skill") {
            inventories
                .entry(root)
                .or_insert_with(|| match skills(root) {
                    Ok(files) => files,
                    Err(error) => {
                        unavailable_roots.insert(root.to_path_buf());
                        pass.diagnostic(root, error);
                        BTreeMap::new()
                    }
                });
        }
        candidates.push((source, root, main, common));
    }
    let entries = ledger(db)?;
    for entry in entries.iter().filter(|entry| !entry.retired) {
        if !topology.unavailable.contains(entry.common()?)
            && !unavailable_roots.contains(&entry.source_root)
        {
            topology.registration(&entry.admin, backoff);
        }
    }
    let mut desired = BTreeMap::new();
    for (source, root, main, common) in candidates {
        if unavailable_roots.contains(root) {
            continue;
        }
        let Ok(relative) = root.strip_prefix(main) else {
            continue;
        };
        for (admin, checkout) in &topology.admins {
            let Some(checkout) = checkout
                .as_ref()
                .filter(|_| admin.parent() == Some(common.join("worktrees").as_path()))
            else {
                continue;
            };
            let target = checkout.join(relative);
            let registration = (admin.clone(), common.to_path_buf());
            let Some(route) = resolver.registered(&target, checkout, &registration) else {
                continue;
            };
            let Some(observed) = route.observed else {
                continue;
            };
            if let Err(error) = observed.remember(db) {
                pass.diagnostic(&target, error);
                continue;
            }
            if !worktrees::same_source(route.source, source) || route.equivalent != root {
                continue;
            }
            let mut add = |path: &Path, artifact| {
                let relative = relative.join(path);
                desired.insert(
                    (admin.clone(), relative.clone()),
                    Destination {
                        checkout,
                        root,
                        relative,
                        artifact,
                    },
                );
            };
            for (tool, path) in Hooks::FILES {
                add(Path::new(path), Artifact::Hook(tool));
            }
            if let Some(files) = inventories
                .get(root)
                .filter(|_| crate::projects::sharing_allowed(source, "skill"))
            {
                for (path, file) in files {
                    add(path, Artifact::Skill(file));
                }
            }
        }
    }
    let mut handled = BTreeSet::new();
    for mut entry in entries.into_iter().filter(|entry| !entry.retired) {
        let key = (entry.admin.clone(), entry.relative.clone());
        handled.insert(key.clone());
        let next = desired.get(&key);
        let original = entry.checkout.clone();
        let registered = topology
            .admins
            .get(&entry.admin)
            .and_then(Option::as_ref)
            .is_some_and(|checkout| {
                entry.checkout.clone_from(checkout);
                true
            });
        let result = (|| -> Result<()> {
            if topology.unavailable.contains(entry.common()?)
                || unavailable_roots.contains(&entry.source_root)
            {
                return Ok(());
            }
            if !registered {
                if !backoff.ready(&entry.admin) || !backoff.ready(&entry.checkout) {
                    return Err("Worktree registration is unavailable".into());
                }
                match fs::symlink_metadata(&entry.admin) {
                    Err(error) if error.kind() == io::ErrorKind::NotFound => (),
                    Ok(_) => return Err("Worktree registration is unavailable".into()),
                    Err(error) => return Err(error.to_string()),
                }
                if !entry.common()?.is_dir() {
                    return Err("Common Git directory is unavailable".into());
                }
                let checkout = fs::symlink_metadata(&entry.checkout);
                match checkout {
                    Ok(metadata)
                        if metadata.is_dir()
                            && (entry.device == 0 || metadata.dev() == entry.device) => {}
                    Err(error) if error.kind() == io::ErrorKind::NotFound => {
                        let parent = entry.checkout.parent().ok_or("Missing worktree parent")?;
                        if fs::metadata(parent).is_ok_and(|m| m.is_dir() && m.dev() == entry.device)
                        {
                            return retire(db, entry);
                        }
                        backoff.failed(&entry.checkout);
                        return Err("Worktree volume or parent is unavailable".into());
                    }
                    _ => {
                        backoff.failed(&entry.checkout);
                        return Err("Worktree checkout is unavailable or was replaced".into());
                    }
                }
                backoff.available(&entry.checkout);
                if crate::onboarding::discovery::enclosing_checkout(&entry.checkout, &home)
                    .is_some_and(|checkout| {
                        checkout != entry.checkout
                            || crate::onboarding::discovery::primary_common_dir(&checkout).is_some()
                    })
                {
                    return Err("Pruned worktree is now inside a different Git checkout".into());
                }
            }
            if original != entry.checkout {
                entry.save(db)?;
            }
            reconcile_entry(db, entry, next, executable, registered)
        })();
        if let Err(error) = result {
            pass.diagnostic(&original.join(key.1), error);
        }
    }
    for (key, next) in desired {
        if handled.contains(&key) {
            continue;
        }
        let path = next.checkout.join(&next.relative);
        let result = (|| -> Result<()> {
            checked_parent(next.checkout, &path)?;
            let existing = read_file(&path).map_err(|e| e.to_string())?;
            let entry = Installed {
                checkout: next.checkout.to_path_buf(),
                admin: key.0,
                relative: next.relative.clone(),
                device: fs::metadata(next.checkout)
                    .map_err(|e| e.to_string())?
                    .dev(),
                inode: 0,
                fingerprint: String::new(),
                source_root: next.root.to_path_buf(),
                restore: None,
                pending: None,
                retired: false,
                protected: false,
            };
            install(db, entry, &next, executable, false, existing)
        })();
        if let Err(error) = result {
            pass.diagnostic(&path, error);
        }
    }
    pass.finish(db)
}

#[cfg(test)]
pub(crate) fn reconcile(db: &Connection, executable: &Path) -> Result<()> {
    reconcile_with(db, executable, &mut Backoff::default())
}
