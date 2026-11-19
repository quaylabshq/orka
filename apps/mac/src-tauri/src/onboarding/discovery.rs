//! Bounded discovery reads tool history, never project content.
use crate::{
    db::{self, Result},
    native,
};
use serde_json::{json, Value};
use std::{
    collections::{BTreeMap, BTreeSet},
    fs,
    io::{BufRead, BufReader, Read},
    path::{Path, PathBuf},
    time::{Duration, Instant, SystemTime},
};

#[derive(Default)]
struct Candidate {
    tools: BTreeSet<String>,
    last: u64,
    sessions: usize,
    worktrees: usize,
    days: BTreeSet<u64>,
    worktree_paths: BTreeSet<PathBuf>,
}
impl Candidate {
    fn activity(&mut self, tool: Option<&str>, last: u64, sessions: usize, days: BTreeSet<u64>) {
        if let Some(tool) = tool {
            self.tools.insert(tool.into());
        }
        self.last = self.last.max(last);
        self.sessions += sessions;
        self.days.extend(days);
    }
    fn fold(&mut self, other: Self) {
        self.tools.extend(other.tools);
        self.last = self.last.max(other.last);
        self.sessions += other.sessions;
        self.worktrees += other.worktrees;
        self.days.extend(other.days);
        self.worktree_paths.extend(other.worktree_paths);
    }
}
const DAY: u64 = 86_400_000;
/// Day numbers for history file times, used for the active-day signal.
fn active_days<I: IntoIterator<Item = u64>>(times: I) -> BTreeSet<u64> {
    times
        .into_iter()
        .filter(|time| *time > 0)
        .map(|time| time / DAY)
        .collect()
}
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum Kind {
    Project,
    Folder,
    Chat,
}
impl Kind {
    fn of(path: &Path, home: &Path) -> Self {
        if path.join(".git").exists() {
            Kind::Project
        } else if chat(path, home) {
            Kind::Chat
        } else {
            Kind::Folder
        }
    }
    fn multiplier(self) -> f64 {
        match self {
            Self::Project => 1.0,
            Self::Folder => 0.6,
            Self::Chat => 0.2,
        }
    }
}
/// Conversation folders hold one chat each, so they are not offers of a project.
fn chat(path: &Path, home: &Path) -> bool {
    ["Documents/Codex", ".t3/scratch"].iter().any(|root| {
        let root = home.join(root);
        path != root && path.starts_with(root)
    })
}
/// Relevance blends recency, sessions, active days, and a working tree.
fn relevance(candidate: &Candidate, kind: Kind, now: u64) -> f64 {
    let age = now.saturating_sub(candidate.last) as f64 / DAY as f64;
    let recency = (-age / 14.0).exp();
    // 50 sessions and 30 active days saturate their terms.
    let sessions = (1.0 + candidate.sessions as f64).ln() / 51.0_f64.ln();
    // Today and the 89 days before it.
    let active = candidate
        .days
        .iter()
        .filter(|day| **day + 90 > now / DAY)
        .count();
    let active = (1.0 + active as f64).ln() / 31.0_f64.ln();
    let git = if kind == Kind::Project { 1.0 } else { 0.0 };
    let both = if candidate.tools.len() > 1 { 3.0 } else { 0.0 };
    100.0
        * (0.35 * recency + 0.25 * sessions.min(1.0) + 0.25 * active.min(1.0) + 0.15 * git)
        * kind.multiplier()
        + both
}
struct Ranked {
    path: PathBuf,
    candidate: Candidate,
    kind: Kind,
    relevance: f64,
}
fn ranked(found: BTreeMap<PathBuf, Candidate>, home: &Path, now: u64) -> Vec<Ranked> {
    let mut rows: Vec<Ranked> = found
        .into_iter()
        .map(|(path, candidate)| {
            let kind = Kind::of(&path, home);
            let relevance = relevance(&candidate, kind, now);
            Ranked {
                path,
                candidate,
                kind,
                relevance,
            }
        })
        .collect();
    rows.sort_by(|a, b| {
        b.relevance
            .total_cmp(&a.relevance)
            .then(b.candidate.last.cmp(&a.candidate.last))
            .then(a.path.cmp(&b.path))
    });
    rows
}
struct Budget {
    start: Instant,
    files: usize,
    walked: usize,
    denied: bool,
    truncated: bool,
}
impl Budget {
    fn new() -> Self {
        Self {
            start: Instant::now(),
            files: 0,
            walked: 0,
            denied: false,
            truncated: false,
        }
    }
    fn next(&mut self) -> bool {
        if self.files >= 2000 || self.start.elapsed() >= Duration::from_secs(5) {
            self.truncated = true;
            return false;
        }
        self.files += 1;
        true
    }
    fn tick(&mut self) -> bool {
        self.walked += 1;
        if self.walked > 20_000 || self.start.elapsed() >= Duration::from_secs(5) {
            self.truncated = true;
            return false;
        }
        true
    }
    fn entries(&mut self, path: &Path) -> Vec<fs::DirEntry> {
        match fs::read_dir(path) {
            Ok(entries) => entries.flatten().take(2001).collect(),
            Err(e) => {
                self.denied |= e.kind() == std::io::ErrorKind::PermissionDenied;
                vec![]
            }
        }
    }
}
fn modified(path: &Path) -> u64 {
    fs::metadata(path)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|v| v.duration_since(SystemTime::UNIX_EPOCH).ok())
        .map(|v| v.as_millis() as u64)
        .unwrap_or(0)
}
#[derive(Default)]
struct ImportedHistory {
    claude: BTreeSet<String>,
    codex: BTreeSet<String>,
}
impl ImportedHistory {
    fn load(db: &rusqlite::Connection) -> Result<Self> {
        let mut imported = Self::default();
        for receipt in db::rows(
            db,
            "SELECT value FROM meta WHERE key GLOB 'claudeImport:*'",
            &[],
        )? {
            if let Some(id) = receipt["id"].as_str() {
                imported.claude.insert(id.into());
            }
        }
        for receipt in crate::codex_import::attempts(db)? {
            imported.codex.extend(
                receipt["ids"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .chain(std::iter::once(&receipt["child"]["id"]))
                    .filter_map(|id| id.as_str().map(str::to_owned)),
            );
        }
        Ok(imported)
    }
}

fn usable_root(path: &Path, home: &Path) -> bool {
    path.is_dir()
        && path != Path::new("/")
        && path != home
        && (path.starts_with(home) || !(path.starts_with("/tmp") || path.starts_with("/private")))
}
/// Resolves a Git directory and the common directory shared by its worktrees.
fn git_dirs(path: &Path) -> Option<(PathBuf, PathBuf)> {
    let git = path.join(".git");
    if !git.is_file() {
        return None;
    }
    let value = fs::read_to_string(&git).ok()?;
    let target = value.trim().strip_prefix("gitdir:")?.trim();
    if target.is_empty() {
        return None;
    }
    let directory = resolved(&path.join(target));
    let common = match fs::read_to_string(directory.join("commondir")) {
        Ok(common) => resolved(&directory.join(common.trim())),
        Err(_) => directory.clone(),
    };
    Some((directory, common))
}
fn resolved(path: &Path) -> PathBuf {
    fs::canonicalize(path).unwrap_or_else(|_| path.to_path_buf())
}
#[derive(Default)]
struct MainCheckouts(BTreeMap<PathBuf, BTreeSet<PathBuf>>);
impl MainCheckouts {
    fn from_paths<'a>(paths: impl Iterator<Item = &'a PathBuf>, home: &Path) -> Self {
        let mut checkouts = Self::default();
        for path in paths {
            let Some((directory, common)) = git_dirs(path) else {
                continue;
            };
            if directory == common && common.is_dir() && usable_root(path, home) {
                checkouts.0.entry(common).or_default().insert(path.clone());
            }
        }
        checkouts
    }

    /// Returns a linked worktree's main checkout when its location is known.
    fn main_of(&self, path: &Path) -> Option<PathBuf> {
        let (directory, common) = git_dirs(path)?;
        if directory == common {
            return None;
        }
        if common.file_name()? == ".git" && common.is_dir() {
            return common.parent().map(Path::to_path_buf);
        }
        // An external Git directory has no backlink to its primary checkout.
        let mut matches = self.0.get(&common)?.iter();
        match (matches.next(), matches.next()) {
            (Some(only), None) => Some(only.clone()),
            _ => None,
        }
    }
}
/// Worktrees connect to their main checkout, so they are one project, not two.
fn fold_worktrees(
    found: &mut BTreeMap<PathBuf, Candidate>,
    home: &Path,
    connected: &BTreeMap<PathBuf, u64>,
) {
    let mains = MainCheckouts::from_paths(found.keys().chain(connected.keys()), home);
    let worktrees: Vec<PathBuf> = found
        .keys()
        .filter(|path| path.join(".git").is_file() && !connected.contains_key(*path))
        .cloned()
        .collect();
    for path in worktrees {
        let Some(main) = mains.main_of(&path).filter(|main| usable_root(main, home)) else {
            continue;
        };
        let Some(mut worktree) = found.remove(&path) else {
            continue;
        };
        worktree.worktrees += 1;
        worktree.worktree_paths.insert(path);
        found.entry(main).or_default().fold(worktree);
    }
}
fn project_root(path: &Path, home: &Path) -> Option<PathBuf> {
    let path = match fs::canonicalize(path) {
        Ok(path) => path,
        // Keep known history entries visible so the native picker can grant access.
        Err(e)
            if e.kind() == std::io::ErrorKind::PermissionDenied
                && path.is_absolute()
                && !path
                    .components()
                    .any(|c| matches!(c, std::path::Component::ParentDir)) =>
        {
            return Some(path.to_path_buf())
        }
        Err(_) => return None,
    };
    if fs::metadata(&path).is_err_and(|e| e.kind() == std::io::ErrorKind::PermissionDenied) {
        return Some(path);
    }
    if !usable_root(&path, home) {
        return None;
    }
    for parent in path.ancestors() {
        if parent == home || parent == Path::new("/") {
            break;
        }
        if parent.join(".git").exists() {
            return Some(parent.to_path_buf());
        }
    }
    Some(path)
}
fn add(
    found: &mut BTreeMap<PathBuf, Candidate>,
    path: &Path,
    home: &Path,
    tool: Option<&str>,
    last: u64,
    sessions: usize,
) {
    let Some(path) = project_root(path, home) else {
        return;
    };
    found
        .entry(path)
        .or_default()
        .activity(tool, last, sessions, active_days([last]));
}
fn cwd_record(path: &Path, codex: bool, budget: &mut Budget) -> Option<Value> {
    if fs::symlink_metadata(path).is_ok_and(|m| m.file_type().is_symlink()) {
        return None;
    }
    let file = match crate::history::reader(path) {
        Ok(f) => f,
        Err(_) => {
            budget.denied |= fs::File::open(path)
                .is_err_and(|e| e.kind() == std::io::ErrorKind::PermissionDenied);
            return None;
        }
    };
    for line in BufReader::new(file.take(65_536))
        .lines()
        .map_while(std::result::Result::ok)
    {
        if let Ok(record) = serde_json::from_str::<Value>(&line) {
            if codex {
                return (record["type"] == "session_meta" && record["payload"]["cwd"].is_string())
                    .then_some(record);
            }
            if record["cwd"].is_string() {
                return Some(record);
            }
        }
    }
    None
}
fn claude(
    home: &Path,
    root: &Path,
    imported: &BTreeSet<String>,
    budget: &mut Budget,
) -> Result<Vec<Record>> {
    let mut records = Vec::new();
    for folder in budget.entries(&root.join("projects")) {
        if !budget.tick() {
            break;
        }
        if !folder
            .file_type()
            .is_ok_and(|k| k.is_dir() && !k.is_symlink())
        {
            continue;
        }
        let mut files: Vec<_> = budget
            .entries(&folder.path())
            .into_iter()
            .filter(|f| {
                let path = f.path();
                path.extension().is_some_and(|e| e == "jsonl")
                    && f.file_type().is_ok_and(|k| k.is_file())
                    // Sync imports use their own native IDs and carry historical timestamps.
                    && !path.file_stem().and_then(|name| name.to_str()).is_some_and(|id| imported.contains(id))
            })
            .collect();
        files.sort_by_key(|f| std::cmp::Reverse(modified(&f.path())));
        let count = files.len();
        let days = active_days(files.iter().map(|f| modified(&f.path())));
        for file in files {
            if !budget.next() {
                break;
            }
            if let Some(record) = cwd_record(&file.path(), false, budget) {
                records.push(Record {
                    cwd: PathBuf::from(record["cwd"].as_str().unwrap()),
                    tool: Some("claude"),
                    last: modified(&file.path()),
                    sessions: count,
                    days,
                    remote: None,
                });
                break;
            }
        }
    }
    let config = home.join(".claude.json");
    if budget.next() {
        let file = if fs::symlink_metadata(&config).is_ok_and(|m| m.file_type().is_symlink()) {
            return Ok(records);
        } else {
            fs::File::open(config)
        };
        if file
            .as_ref()
            .is_err_and(|e| e.kind() == std::io::ErrorKind::PermissionDenied)
        {
            budget.denied = true;
        }
        if let Ok(file) = file {
            if let Ok(value) = serde_json::from_reader::<_, Value>(file.take(4_000_000)) {
                if let Some(projects) = value["projects"].as_object() {
                    for (path, data) in projects {
                        if !budget.next() {
                            break;
                        }
                        let last = data["lastSessionDate"].as_u64().unwrap_or(0);
                        records.push(Record {
                            cwd: PathBuf::from(path),
                            tool: Some("claude"),
                            last,
                            sessions: 0,
                            days: active_days([last]),
                            remote: None,
                        });
                    }
                }
            }
        }
    }
    Ok(records)
}
fn codex_files(root: &Path, depth: usize, budget: &mut Budget, files: &mut Vec<PathBuf>) {
    if depth == 0 {
        return;
    }
    let mut entries = budget.entries(root);
    entries.sort_by_key(|e| std::cmp::Reverse(e.file_name()));
    for entry in entries {
        if files.len() >= 1000 || !budget.tick() {
            break;
        }
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_symlink() {
            continue;
        }
        if kind.is_dir() {
            codex_files(&entry.path(), depth - 1, budget, files);
        } else if entry.file_name().to_string_lossy().starts_with("rollout-")
            && crate::history::is_session(&entry.path())
        {
            files.push(entry.path());
        }
    }
}
fn folder(
    root: &Path,
    depth: usize,
    found: &mut BTreeMap<PathBuf, Candidate>,
    home: &Path,
    budget: &mut Budget,
    top: bool,
) {
    if depth == 0 || found.len() >= 200 || !budget.next() {
        return;
    }
    if root.join(".git").exists()
        || (top && (root.join(".claude").is_dir() || root.join(".codex").is_dir()))
    {
        add(found, root, home, None, 0, 0);
    }
    for entry in budget.entries(root) {
        if found.len() >= 200 || !budget.next() {
            break;
        }
        let name = entry.file_name();
        let name = name.to_string_lossy();
        if name.starts_with('.')
            || [
                "node_modules",
                "target",
                "vendor",
                "dist",
                "build",
                "Library",
            ]
            .contains(&name.as_ref())
        {
            continue;
        }
        if entry
            .file_type()
            .is_ok_and(|k| k.is_dir() && !k.is_symlink())
        {
            folder(&entry.path(), depth - 1, found, home, budget, false);
        }
    }
}
fn history(
    home: &Path,
    claude_root: &Path,
    codex_root: &Path,
    imported: &ImportedHistory,
    budget: &mut Budget,
) -> Result<Vec<Record>> {
    let mut records = claude(home, claude_root, &imported.claude, budget)?;
    let mut files = vec![];
    codex_files(&codex_root.join("sessions"), 5, budget, &mut files);
    files.sort_by_key(|p| std::cmp::Reverse(modified(p)));
    for file in files.into_iter().take(1000) {
        if !budget.next() {
            break;
        }
        if let Some(record) = cwd_record(&file, true, budget) {
            if record["payload"]["id"]
                .as_str()
                .is_some_and(|id| imported.codex.contains(id))
            {
                continue;
            }
            let payload = &record["payload"];
            // Subagent and review rollouts continue another thread, not a new session.
            let derived = payload["parent_thread_id"]
                .as_str()
                .is_some_and(|parent| Some(parent) != payload["id"].as_str())
                || matches!(
                    payload["thread_source"].as_str(),
                    Some("subagent") | Some("guardian_review")
                );
            records.push(Record {
                cwd: PathBuf::from(payload["cwd"].as_str().unwrap()),
                tool: Some("codex"),
                last: modified(&file),
                sessions: usize::from(!derived),
                days: active_days([modified(&file)]),
                remote: payload["git"]["repository_url"].as_str().map(str::to_owned),
            });
        }
    }
    Ok(records)
}
/// One history entry before it is attributed to a project.
struct Record {
    cwd: PathBuf,
    tool: Option<&'static str>,
    last: u64,
    sessions: usize,
    days: BTreeSet<u64>,
    remote: Option<String>,
}
/// Attributes history to projects, including history from folders that were deleted.
fn resolve(
    records: Vec<Record>,
    home: &Path,
    codex: &Path,
    found: &mut BTreeMap<PathBuf, Candidate>,
    connected: &BTreeMap<PathBuf, u64>,
) {
    let mut missing = Vec::new();
    for record in records {
        match project_root(&record.cwd, home) {
            Some(path) => found.entry(path).or_default().activity(
                record.tool,
                record.last,
                record.sessions,
                record.days,
            ),
            None => missing.push(record),
        }
    }
    if missing.is_empty() {
        return;
    }
    let mains = MainCheckouts::from_paths(found.keys().chain(connected.keys()), home);
    let roots: BTreeSet<_> = found
        .keys()
        .chain(connected.keys())
        .filter_map(|root| fs::canonicalize(root).ok())
        .filter(|root| usable_root(root, home))
        .map(|root| {
            mains
                .main_of(&root)
                .filter(|main| usable_root(main, home))
                .unwrap_or(root)
        })
        .collect();
    let mut remotes = Remotes::default();
    for record in missing {
        if let Some((path, worktree)) =
            credited_root(&record, home, codex, &roots, &mains, &mut remotes)
        {
            let candidate = found.entry(path).or_default();
            candidate.activity(record.tool, record.last, record.sessions, record.days);
            candidate.worktree_paths.extend(worktree);
        }
    }
}
/// Remote identities of discovered projects, read once per scan.
#[derive(Default)]
struct Remotes {
    keys: BTreeMap<PathBuf, Option<String>>,
    reads: usize,
}
impl Remotes {
    fn key(&mut self, root: &Path) -> Option<String> {
        if let Some(key) = self.keys.get(root) {
            return key.clone();
        }
        self.reads += 1;
        let key = root
            .to_str()
            .and_then(|root| remote_key(root).ok().flatten());
        self.keys.insert(root.to_path_buf(), key.clone());
        key
    }
}
/// Extracts the checkout root from a known worktree layout even if the CWD is gone.
fn worktree_below(path: &Path, root: &Path, depth: usize) -> Option<PathBuf> {
    let mut components = path.strip_prefix(root).ok()?.components();
    let mut worktree = root.to_path_buf();
    for _ in 0..depth {
        let std::path::Component::Normal(part) = components.next()? else {
            return None;
        };
        worktree.push(part);
    }
    Some(worktree)
}

/// Returns the repository to credit and an old checkout path when its identity is known.
fn credited_root(
    record: &Record,
    home: &Path,
    codex: &Path,
    roots: &BTreeSet<PathBuf>,
    mains: &MainCheckouts,
    remotes: &mut Remotes,
) -> Option<(PathBuf, Option<PathBuf>)> {
    let path = &record.cwd;
    if !path.is_absolute()
        || path
            .components()
            .any(|part| matches!(part, std::path::Component::ParentDir))
    {
        return None;
    }
    // Claude Code keeps its worktrees inside the repository they belong to.
    let claude = path.ancestors().find_map(|checkout| {
        let worktrees = checkout.parent()?;
        let config = worktrees.parent()?;
        if worktrees.file_name()?.to_str()? != "worktrees"
            || config.file_name()?.to_str()? != ".claude"
        {
            return None;
        }
        let main = fs::canonicalize(config.parent()?).ok()?;
        (usable_root(&main, home) && main.join(".git").exists())
            .then(|| (main, checkout.to_path_buf()))
    });
    let t3 = worktree_below(path, &home.join(".t3/worktrees"), 2);
    // Live T3 siblings point at the main checkout, even when history only has deleted rows.
    let siblings: BTreeSet<_> = t3
        .as_deref()
        .and_then(Path::parent)
        .and_then(|workspace| fs::read_dir(workspace).ok())
        .into_iter()
        .flatten()
        .flatten()
        .filter_map(|entry| mains.main_of(&entry.path()))
        .filter(|main| usable_root(main, home))
        .collect();
    if let Some(remote) = &record.remote {
        let key = normalize_remote(remote)?;
        let key = db::digest(format!("orka-remote-v1:{key}").as_bytes());
        let mut matching = roots
            .iter()
            .chain(siblings.iter())
            .chain(claude.iter().map(|(main, _)| main))
            .filter(|root| remotes.key(root).as_ref() == Some(&key));
        let selected = matching.next()?;
        if matching.any(|root| root != selected) {
            return None;
        }
        let worktree = claude
            .map(|(_, checkout)| checkout)
            .or(t3)
            .or_else(|| worktree_below(path, &codex.join("worktrees"), 2));
        return Some((selected.clone(), worktree));
    }
    if let Some((main, worktree)) = claude {
        return Some((main, Some(worktree)));
    }
    let t3 = t3?;
    match siblings.len() {
        1 => return siblings.into_iter().next().map(|main| (main, Some(t3))),
        2.. => return None,
        _ => {}
    }
    let basename = t3.parent()?.file_name();
    let mut named = roots
        .iter()
        .filter(|root| root.file_name() == basename && root.join(".git").exists());
    match (named.next(), named.next()) {
        (Some(only), None) => Some((only.clone(), None)),
        _ => None,
    }
}
pub fn discover(path: Option<&str>) -> Result<Value> {
    let home = db::home()?;
    let db = db::open()?;
    let mut found = BTreeMap::new();
    let mut budget = Budget::new();
    let connected = db::rows(
        &db,
        &format!(
            "SELECT json_set(value,'$.pendingChanges',(SELECT count(*) FROM outbox WHERE project=projects.id)) FROM projects WHERE {}",
            crate::projects::ACTIVE
        ),
        &[],
    )?;
    let connected_folders: BTreeMap<_, _> = connected
        .iter()
        .flat_map(|project| {
            let pending = project["pendingChanges"].as_u64().unwrap_or(0);
            crate::sources::views(project)
                .into_iter()
                .filter_map(move |view| Some((PathBuf::from(view["path"].as_str()?), pending)))
        })
        .collect();
    if let Some(path) = path {
        let root = fs::canonicalize(path)
            .map_err(|_| "Orka couldn’t read this folder. Choose it again to give Orka access.")?;
        if !root.is_dir() {
            return Err("Choose a project folder".into());
        }
        folder(&root, 4, &mut found, &home, &mut budget, true);
        if found.is_empty() && !budget.denied {
            add(&mut found, &root, &home, None, 0, 0);
        }
    } else {
        let imported = ImportedHistory::load(&db)?;
        let codex = native::codex_home()?;
        let records = history(
            &home,
            &native::claude_home()?,
            &codex,
            &imported,
            &mut budget,
        )?;
        resolve(records, &home, &codex, &mut found, &connected_folders);
        fold_worktrees(&mut found, &home, &connected_folders);
    }
    if found.is_empty() && budget.denied {
        return Err("Orka couldn’t read your coding history. Check Privacy & Security in System Settings, or choose a folder instead.".into());
    }
    let now = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|v| v.as_millis() as u64)
        .unwrap_or(0);
    let projects: Vec<Value> = ranked(found, &home, now)
        .into_iter()
        // Chats stay available as folder picks, but never fill the history scan.
        .filter(|row| {
            path.is_some() || row.kind != Kind::Chat || connected_folders.contains_key(&row.path)
        })
        .map(|row| {
            let path = row.path;
            let c = row.candidate;
            let display = path
                .strip_prefix(&home)
                .map(|p| format!("~/{}", p.display()))
                .unwrap_or_else(|_| path.display().to_string());
            let relevance = (row.relevance * 10.0).round() / 10.0;
            let mut project = json!({
                "name":path.file_name().unwrap_or_default().to_string_lossy(),
                "path":path,
                "displayPath":display,
                "sources":c.tools,
                "lastActiveAt":c.last,
                "sessions":c.sessions,
                "worktrees":c.worktrees,
                "relevance":relevance,
                "readable":fs::read_dir(&path).is_ok(),
                "alreadyConnected":connected_folders.contains_key(&path),
                "pendingChanges":connected_folders.get(&path).copied().unwrap_or(0)
            });
            if !c.worktree_paths.is_empty() {
                project["worktreePaths"] = json!(c.worktree_paths);
            }
            project
        })
        .collect();
    if budget.truncated {
        eprintln!("Some history was skipped (onboarding discovery budget)");
    }
    Ok(json!({
        "projects":projects,
        "tools":{"claude":native::binary("claude").is_ok(),"codex":native::binary("codex").is_ok()},
        "truncated":budget.truncated,
        "incomplete":budget.denied || budget.truncated
    }))
}

pub fn normalize_remote(raw: &str) -> Option<String> {
    let raw = raw.trim().trim_end_matches('/').trim_end_matches(".git");
    let url = if raw.contains("://") {
        reqwest::Url::parse(raw).ok()?
    } else {
        let (host, path) = raw.split_once(':')?;
        reqwest::Url::parse(&format!("ssh://{}/{}", host.rsplit('@').next()?, path)).ok()?
    };
    if !["https", "http", "ssh", "git"].contains(&url.scheme()) {
        return None;
    }
    let mut host = url.host_str()?.to_lowercase();
    let path = url.path().trim_matches('/').trim_end_matches(".git");
    let path = if host == "github.com" {
        path.to_lowercase()
    } else {
        path.to_string()
    };
    if let Some(port) = url
        .port()
        .filter(|port| !matches!((url.scheme(), *port), ("ssh", 22) | ("git", 9418)))
    {
        host = format!("{host}:{port}");
    }
    if path.is_empty() {
        return None;
    }
    Some(format!("{host}/{path}"))
}
pub fn remote_key(path: &str) -> Result<Option<String>> {
    let root = fs::canonicalize(path).map_err(|_| "Project folder is unavailable")?;
    let git = root.join(".git");
    let directory = if git.is_file() {
        git_dirs(&root)
            .map(|(directory, _)| directory)
            .ok_or("Invalid Git directory")?
    } else {
        git
    };
    let config = if directory.join("config").is_file() {
        directory.join("config")
    } else if let Ok(common) = fs::read_to_string(directory.join("commondir")) {
        directory.join(common.trim()).join("config")
    } else {
        return Ok(None);
    };
    let file = fs::File::open(config).map_err(|e| e.to_string())?;
    let mut remote = None;
    let mut origin = None;
    let mut current = String::new();
    for line in BufReader::new(file.take(1_000_000))
        .lines()
        .map_while(std::result::Result::ok)
    {
        let line = line.trim();
        if line.starts_with('[') {
            current = line.to_string();
        } else if current.starts_with("[remote ") {
            if let Some((key, value)) = line.split_once('=') {
                if key.trim() == "url" {
                    let value = value.trim().trim_matches('"').to_string();
                    if remote.is_none() {
                        remote = Some(value.clone());
                    }
                    if current == "[remote \"origin\"]" {
                        origin = Some(value);
                    }
                }
            }
        }
    }
    Ok(origin
        .or(remote)
        .and_then(|v| normalize_remote(&v))
        .map(|v| db::digest(format!("orka-remote-v1:{v}").as_bytes())))
}
#[cfg(test)]
mod tests {
    use super::*;
    /// Creates a T3 linked worktree whose Git directory lives in `main`.
    fn linked_worktree(home: &Path, main: &Path, name: &str) -> PathBuf {
        let git = main.join(".git/worktrees").join(name);
        fs::create_dir_all(&git).unwrap();
        fs::write(git.join("commondir"), "../..\n").unwrap();
        let worktree = home
            .join(".t3/worktrees")
            .join(main.file_name().unwrap())
            .join(name);
        fs::create_dir_all(&worktree).unwrap();
        fs::write(
            worktree.join(".git"),
            format!("gitdir: {}\n", git.display()),
        )
        .unwrap();
        worktree
    }
    #[test]
    fn remote_identity_is_transport_independent() {
        for value in [
            "https://GitHub.com/Owner/Repo.git/",
            "ssh://git@github.com:22/OWNER/repo.git",
            "git@github.com:owner/repo.git",
            "https://user:password@github.com:443/owner/repo",
        ] {
            assert_eq!(
                normalize_remote(value),
                Some("github.com/owner/repo".into())
            );
        }
        assert_eq!(normalize_remote("/local/repo"), None);
        assert_eq!(normalize_remote("file:///local/repo"), None);
    }
    #[test]
    fn private_remote_identity_preserves_non_default_ports_and_path_case() {
        let first = normalize_remote("ssh://git@git.example.test:2222/team/Repo.git");
        assert_eq!(first.as_deref(), Some("git.example.test:2222/team/Repo"));
        assert_ne!(
            first,
            normalize_remote("ssh://git@git.example.test:2223/team/Repo.git")
        );
        assert_ne!(
            first,
            normalize_remote("ssh://git@git.example.test:2222/team/repo.git")
        );
        for remote in [
            "ssh://git@git.example.test:22/team/Repo.git",
            "git@git.example.test:team/Repo.git",
            "https://git.example.test:443/team/Repo.git",
            "git://git.example.test:9418/team/Repo.git",
        ] {
            assert_eq!(
                normalize_remote(remote).as_deref(),
                Some("git.example.test/team/Repo")
            );
        }
        assert_eq!(
            normalize_remote("https://git.example.test:8443/team/Repo.git").as_deref(),
            Some("git.example.test:8443/team/Repo")
        );
    }
    #[test]
    fn worktree_reads_common_config() {
        let temp = tempfile::tempdir().unwrap();
        let root = temp.path();
        fs::create_dir_all(root.join("main/.git/worktrees/feature")).unwrap();
        fs::create_dir_all(root.join("feature")).unwrap();
        fs::write(
            root.join("feature/.git"),
            "gitdir: ../main/.git/worktrees/feature\n",
        )
        .unwrap();
        fs::write(
            root.join("main/.git/worktrees/feature/commondir"),
            "../..\n",
        )
        .unwrap();
        fs::write(
            root.join("main/.git/config"),
            "[remote \"origin\"]\n url = git@github.com:owner/repo.git\n",
        )
        .unwrap();
        assert_eq!(
            remote_key(root.join("feature").to_str().unwrap()).unwrap(),
            Some(db::digest(b"orka-remote-v1:github.com/owner/repo"))
        );
    }
    fn history_record(cwd: &Path, last: u64, sessions: usize) -> Record {
        Record {
            cwd: cwd.to_path_buf(),
            tool: Some("claude"),
            last,
            sessions,
            days: active_days([last]),
            remote: None,
        }
    }
    #[test]
    fn deleted_worktree_history_is_credited_to_a_live_sibling() {
        let temp = tempfile::tempdir().unwrap();
        let home = fs::canonicalize(temp.path()).unwrap();
        let main = home.join("Development/orka");
        fs::create_dir_all(main.join(".git")).unwrap();
        let _live = linked_worktree(&home, &main, "live");
        let records = vec![
            history_record(&main, 10, 1),
            history_record(&home.join(".t3/worktrees/orka/deleted"), 20, 3),
        ];
        let mut found = BTreeMap::new();
        resolve(
            records,
            &home,
            &home.join(".codex"),
            &mut found,
            &BTreeMap::new(),
        );
        assert_eq!(found.keys().collect::<Vec<_>>(), vec![&main]);
        assert_eq!(found[&main].sessions, 4);
        assert_eq!(found[&main].last, 20);
        assert_eq!(
            found[&main].worktree_paths,
            BTreeSet::from([home.join(".t3/worktrees/orka/deleted")])
        );
    }
    #[test]
    fn deleted_worktree_history_is_credited_by_a_unique_folder_name() {
        let temp = tempfile::tempdir().unwrap();
        let home = fs::canonicalize(temp.path()).unwrap();
        let project = home.join("Development/orka-api");
        fs::create_dir_all(project.join(".git")).unwrap();
        let records = vec![
            history_record(&project, 10, 1),
            history_record(&home.join(".t3/worktrees/orka-api/gone"), 20, 2),
        ];
        let mut found = BTreeMap::new();
        resolve(
            records,
            &home,
            &home.join(".codex"),
            &mut found,
            &BTreeMap::new(),
        );
        assert_eq!(found.keys().collect::<Vec<_>>(), vec![&project]);
        assert_eq!(found[&project].sessions, 3);
        assert!(found[&project].worktree_paths.is_empty());
    }
    #[test]
    fn deleted_history_is_not_credited_when_names_collide() {
        let temp = tempfile::tempdir().unwrap();
        let home = fs::canonicalize(temp.path()).unwrap();
        let first = home.join("work/orka");
        let second = home.join("archive/orka");
        for project in [&first, &second] {
            fs::create_dir_all(project.join(".git")).unwrap();
        }
        let records = vec![
            history_record(&first, 10, 1),
            history_record(&second, 10, 1),
            history_record(&home.join(".t3/worktrees/orka/gone"), 20, 2),
        ];
        let mut found = BTreeMap::new();
        resolve(
            records,
            &home,
            &home.join(".codex"),
            &mut found,
            &BTreeMap::new(),
        );
        assert_eq!(found.len(), 2);
        assert_eq!(found[&first].sessions, 1);
        assert_eq!(found[&second].sessions, 1);
    }
    #[test]
    fn deleted_claude_worktree_history_is_credited_to_its_repository() {
        let temp = tempfile::tempdir().unwrap();
        let home = fs::canonicalize(temp.path()).unwrap();
        let main = home.join("Development/orka");
        fs::create_dir_all(main.join(".git")).unwrap();
        let records = vec![
            history_record(&main, 10, 1),
            history_record(&main.join(".claude/worktrees/fix-menu"), 20, 2),
        ];
        let mut found = BTreeMap::new();
        resolve(
            records,
            &home,
            &home.join(".codex"),
            &mut found,
            &BTreeMap::new(),
        );
        assert_eq!(found.keys().collect::<Vec<_>>(), vec![&main]);
        assert_eq!(found[&main].sessions, 3);
        assert_eq!(
            found[&main].worktree_paths,
            BTreeSet::from([main.join(".claude/worktrees/fix-menu")])
        );
    }
    #[test]
    fn deleted_codex_history_is_credited_by_its_repository_url() {
        let temp = tempfile::tempdir().unwrap();
        let home = fs::canonicalize(temp.path()).unwrap();
        let main = home.join("Development/orka");
        fs::create_dir_all(main.join(".git")).unwrap();
        fs::write(
            main.join(".git/config"),
            "[remote \"origin\"]\n url = git@github.com:owner/repo.git\n",
        )
        .unwrap();
        let records = vec![
            history_record(&main, 10, 1),
            Record {
                cwd: home.join("old/checkout"),
                tool: Some("codex"),
                last: 20,
                sessions: 1,
                days: active_days([20]),
                remote: Some("https://github.com/owner/repo.git".into()),
            },
        ];
        let mut found = BTreeMap::new();
        resolve(
            records,
            &home,
            &home.join(".codex"),
            &mut found,
            &BTreeMap::new(),
        );
        assert_eq!(found.keys().collect::<Vec<_>>(), vec![&main]);
        assert_eq!(found[&main].sessions, 2);
        assert!(found[&main].tools.contains("codex"));
    }
    fn candidate(sessions: usize, last: u64, days: &[u64], tools: &[&str]) -> Candidate {
        let mut candidate = Candidate::default();
        for tool in tools {
            candidate.activity(
                Some(tool),
                last,
                sessions,
                active_days(days.iter().copied()),
            );
        }
        candidate
    }
    #[test]
    fn relevance_ranks_active_repositories_above_quiet_folders_and_chats() {
        let temp = tempfile::tempdir().unwrap();
        let home = fs::canonicalize(temp.path()).unwrap();
        let repository = home.join("Development/orka");
        fs::create_dir_all(repository.join(".git")).unwrap();
        let quiet = home.join("Development/quiet");
        fs::create_dir_all(quiet.join(".git")).unwrap();
        let notes = home.join("Development/notes");
        fs::create_dir_all(&notes).unwrap();
        let conversation = home.join("Documents/Codex/2026-11-19/hi");
        fs::create_dir_all(&conversation).unwrap();
        let now = 1_795_000_000_000;
        let found = BTreeMap::from([
            (
                repository.clone(),
                candidate(
                    12,
                    now - DAY,
                    &[now, now - DAY, now - 2 * DAY, now - 3 * DAY],
                    &["claude", "codex"],
                ),
            ),
            (
                quiet.clone(),
                candidate(
                    3,
                    now - 40 * DAY,
                    &[now - 40 * DAY, now - 41 * DAY],
                    &["claude"],
                ),
            ),
            (
                notes.clone(),
                candidate(2, now - DAY, &[now, now - DAY], &["claude"]),
            ),
            (
                conversation.clone(),
                candidate(3, now - DAY, &[now, now - DAY, now - 2 * DAY], &["codex"]),
            ),
        ]);
        let rows = ranked(found, &home, now);
        let order: Vec<_> = rows.iter().map(|row| row.path.clone()).collect();
        assert_eq!(
            order,
            vec![repository, quiet, notes, conversation],
            "recent sessions on a checkout outrank a quiet checkout, a plain folder, and a chat"
        );
        assert_eq!(rows.last().unwrap().kind, Kind::Chat);
        assert!(rows.last().unwrap().relevance < 11.0);
        assert!(rows[0].relevance > 70.0);
    }
    #[test]
    fn active_days_count_the_last_ninety_days() {
        let now = 1_795_000_000_000;
        let score = |days: &[u64]| {
            relevance(
                &candidate(1, now - 200 * DAY, days, &["claude"]),
                Kind::Project,
                now,
            )
        };
        assert_eq!(score(&[now - 90 * DAY]), score(&[]));
        assert!(score(&[now - 89 * DAY]) > score(&[]));
    }
    #[test]
    fn conversation_folders_are_chats_but_the_workspace_root_is_not() {
        let home = Path::new("/Users/test");
        for path in [
            "/Users/test/Documents/Codex/2026-11-19/hi",
            "/Users/test/.t3/scratch/2026-11-19-hello",
        ] {
            assert_eq!(Kind::of(Path::new(path), home), Kind::Chat, "{path}");
        }
        for path in [
            "/Users/test/Documents/Codex",
            "/Users/test/.t3/scratch",
            "/Users/test/Development/orka",
        ] {
            assert_ne!(Kind::of(Path::new(path), home), Kind::Chat, "{path}");
        }
    }
    #[test]
    fn git_checkouts_inside_conversation_roots_are_projects() {
        let temp = tempfile::tempdir().unwrap();
        let home = fs::canonicalize(temp.path()).unwrap();
        for root in ["Documents/Codex/2026-11-19", ".t3/scratch"] {
            let project = home.join(root).join("repository");
            fs::create_dir_all(project.join(".git")).unwrap();
            let conversation = home.join(root).join("conversation");
            fs::create_dir_all(&conversation).unwrap();
            assert_eq!(Kind::of(&project, &home), Kind::Project);
            assert_eq!(Kind::of(&conversation, &home), Kind::Chat);
        }
    }
    #[test]
    fn codex_subagent_rollouts_do_not_add_sessions() {
        let temp = tempfile::tempdir().unwrap();
        let home = fs::canonicalize(temp.path()).unwrap();
        let project = home.join("Development/orka");
        fs::create_dir_all(project.join(".git")).unwrap();
        let sessions = home.join(".codex/sessions/2026/11/19");
        fs::create_dir_all(&sessions).unwrap();
        for (name, payload) in [
            ("rollout-user.jsonl", json!({"id":"a","cwd":project})),
            (
                "rollout-child.jsonl",
                json!({"id":"b","parent_thread_id":"a","cwd":project}),
            ),
            (
                "rollout-review.jsonl",
                json!({"id":"c","thread_source":"guardian_review","cwd":project}),
            ),
        ] {
            fs::write(
                sessions.join(name),
                format!("{}\n", json!({"type":"session_meta","payload":payload})),
            )
            .unwrap();
        }
        let records = history(
            &home,
            &home.join(".claude"),
            &home.join(".codex"),
            &ImportedHistory::default(),
            &mut Budget::new(),
        )
        .unwrap();
        let mut found = BTreeMap::new();
        resolve(
            records,
            &home,
            &home.join(".codex"),
            &mut found,
            &BTreeMap::new(),
        );
        assert_eq!(found[&project].sessions, 1);
    }
    fn add_origin(project: &Path, repo: &str) {
        fs::create_dir_all(project.join(".git")).unwrap();
        fs::write(
            project.join(".git/config"),
            format!("[remote \"origin\"]\n url = git@github.com:owner/{repo}.git\n"),
        )
        .unwrap();
    }
    #[test]
    fn a_checkout_and_its_live_worktree_are_one_remote_match() {
        let temp = tempfile::tempdir().unwrap();
        let home = fs::canonicalize(temp.path()).unwrap();
        let main = home.join("Development/orka");
        add_origin(&main, "orka");
        let live = linked_worktree(&home, &main, "live");
        let codex = home.join("custom-codex-home");
        let stale = codex.join("worktrees/old/orka");
        let records = vec![
            history_record(&main, 10, 1),
            history_record(&live, 20, 2),
            Record {
                remote: Some("https://github.com/owner/orka".into()),
                ..history_record(&stale.join("subdirectory"), 30, 3)
            },
        ];
        let connected = BTreeMap::new();
        let mut found = BTreeMap::new();
        resolve(records, &home, &codex, &mut found, &connected);
        fold_worktrees(&mut found, &home, &connected);
        assert_eq!(found.keys().collect::<Vec<_>>(), vec![&main]);
        assert_eq!(found[&main].sessions, 6);
        assert_eq!(found[&main].worktree_paths, BTreeSet::from([live, stale]));
    }
    #[test]
    fn recorded_remote_takes_precedence_over_t3_folder_names() {
        let temp = tempfile::tempdir().unwrap();
        let home = fs::canonicalize(temp.path()).unwrap();
        let wrong = home.join("work/orka");
        let right = home.join("archive/renamed");
        add_origin(&wrong, "wrong");
        add_origin(&right, "right");
        let stale = home.join(".t3/worktrees/orka/gone");
        let records = vec![
            history_record(&wrong, 10, 1),
            history_record(&right, 10, 1),
            Record {
                remote: Some("https://github.com/owner/right.git".into()),
                ..history_record(&stale, 20, 2)
            },
            Record {
                remote: Some("https://github.com/owner/missing.git".into()),
                ..history_record(&stale, 30, 4)
            },
        ];
        let mut found = BTreeMap::new();
        resolve(
            records,
            &home,
            &home.join(".codex"),
            &mut found,
            &BTreeMap::new(),
        );
        assert_eq!(found[&wrong].sessions, 1);
        assert_eq!(found[&right].sessions, 3);
        assert_eq!(found[&right].worktree_paths, BTreeSet::from([stale]));
    }
    #[test]
    fn remote_identities_are_read_once_per_project() {
        let temp = tempfile::tempdir().unwrap();
        let home = fs::canonicalize(temp.path()).unwrap();
        let mut found = BTreeMap::new();
        for name in ["a", "b", "c"] {
            let project = home.join("Development").join(name);
            fs::create_dir_all(project.join(".git")).unwrap();
            fs::write(
                project.join(".git/config"),
                format!("[remote \"origin\"]\n url = git@github.com:owner/{name}.git\n"),
            )
            .unwrap();
            found.insert(project, Candidate::default());
        }
        let mut remotes = Remotes::default();
        let roots = found.keys().cloned().collect();
        let mains = MainCheckouts::default();
        for index in 0..50 {
            let record = Record {
                cwd: home.join(format!(".codex/worktrees/{index}/b")),
                tool: Some("codex"),
                last: 20,
                sessions: 1,
                days: BTreeSet::new(),
                remote: Some("https://github.com/owner/b.git".into()),
            };
            assert_eq!(
                credited_root(
                    &record,
                    &home,
                    &home.join(".codex"),
                    &roots,
                    &mains,
                    &mut remotes
                ),
                Some((home.join("Development/b"), Some(record.cwd)))
            );
        }
        assert_eq!(remotes.reads, 3);
    }
    #[test]
    fn a_sibling_checkout_outside_usable_roots_is_not_credited() {
        let temp = tempfile::tempdir().unwrap();
        let home = fs::canonicalize(temp.path()).unwrap();
        fs::create_dir_all(home.join(".git")).unwrap();
        let _live = linked_worktree(&home, &home, "live");
        let name = home.file_name().unwrap();
        let records = vec![history_record(
            &home.join(".t3/worktrees").join(name).join("gone"),
            20,
            2,
        )];
        let mut found = BTreeMap::new();
        resolve(
            records,
            &home,
            &home.join(".codex"),
            &mut found,
            &BTreeMap::new(),
        );
        assert!(found.is_empty());
    }
    #[test]
    fn worktrees_fold_into_their_main_checkout() {
        let temp = tempfile::tempdir().unwrap();
        let home = fs::canonicalize(temp.path()).unwrap();
        let main = home.join("Development/orka");
        fs::create_dir_all(main.join(".git")).unwrap();
        let first = linked_worktree(&home, &main, "feature-a");
        let second = linked_worktree(&home, &main, "feature-b");
        let mut found = BTreeMap::new();
        add(&mut found, &main, &home, Some("claude"), 10, 4);
        add(&mut found, &first, &home, Some("claude"), 20, 1);
        add(&mut found, &second, &home, Some("codex"), 30, 2);
        fold_worktrees(&mut found, &home, &BTreeMap::new());
        assert_eq!(
            found.keys().collect::<Vec<_>>(),
            vec![&main],
            "two live worktrees must not stay separate projects"
        );
        let row = &found[&main];
        assert_eq!(row.sessions, 7);
        assert_eq!(row.last, 30);
        assert_eq!(row.worktrees, 2);
        assert_eq!(row.tools.len(), 2);
    }
    #[test]
    fn worktrees_fold_into_a_known_checkout_using_a_separate_git_directory() {
        let temp = tempfile::tempdir().unwrap();
        let home = fs::canonicalize(temp.path()).unwrap();
        let main = home.join("Development/orka");
        let metadata = home.join("metadata/orka.git");
        let feature = home.join("feature");
        fs::create_dir_all(&main).unwrap();
        fs::create_dir_all(metadata.join("worktrees/feature")).unwrap();
        fs::create_dir_all(&feature).unwrap();
        fs::write(
            main.join(".git"),
            format!("gitdir: {}\n", metadata.display()),
        )
        .unwrap();
        fs::write(
            feature.join(".git"),
            "gitdir: ../metadata/orka.git/worktrees/feature\n",
        )
        .unwrap();
        fs::write(metadata.join("worktrees/feature/commondir"), "../..\n").unwrap();

        let mut found = BTreeMap::new();
        add(&mut found, &main, &home, Some("claude"), 10, 1);
        add(&mut found, &feature, &home, Some("codex"), 20, 2);
        fold_worktrees(&mut found, &home, &BTreeMap::new());
        assert_eq!(found.keys().collect::<Vec<_>>(), vec![&main]);
        assert_eq!(found[&main].sessions, 3);
        assert_eq!(found[&main].worktrees, 1);

        found.clear();
        add(&mut found, &feature, &home, Some("codex"), 20, 2);
        fold_worktrees(&mut found, &home, &BTreeMap::from([(main.clone(), 0)]));
        assert_eq!(found.keys().collect::<Vec<_>>(), vec![&main]);
        assert_eq!(found[&main].sessions, 2);
    }
    #[test]
    fn connected_worktrees_keep_their_own_row() {
        let temp = tempfile::tempdir().unwrap();
        let home = fs::canonicalize(temp.path()).unwrap();
        let main = home.join("Development/orka");
        fs::create_dir_all(main.join(".git")).unwrap();
        let worktree = linked_worktree(&home, &main, "feature-a");
        let mut found = BTreeMap::new();
        add(&mut found, &main, &home, Some("claude"), 10, 1);
        add(&mut found, &worktree, &home, Some("claude"), 20, 1);
        let connected = BTreeMap::from([(worktree.clone(), 0)]);
        fold_worktrees(&mut found, &home, &connected);
        assert_eq!(found.len(), 2);
        assert_eq!(found[&worktree].worktrees, 0);
    }
    #[test]
    fn submodules_and_bare_worktrees_are_not_folded() {
        let temp = tempfile::tempdir().unwrap();
        let home = fs::canonicalize(temp.path()).unwrap();
        let superproject = home.join("Development/super");
        fs::create_dir_all(superproject.join(".git/modules/sub")).unwrap();
        let submodule = superproject.join("sub");
        fs::create_dir_all(&submodule).unwrap();
        fs::write(submodule.join(".git"), "gitdir: ../.git/modules/sub\n").unwrap();
        let bare = home.join("repos/orka.git");
        fs::create_dir_all(bare.join("worktrees/feature")).unwrap();
        fs::write(bare.join("worktrees/feature/commondir"), "../..\n").unwrap();
        let checkout = home.join(".t3/worktrees/orka/feature");
        fs::create_dir_all(&checkout).unwrap();
        fs::write(
            checkout.join(".git"),
            format!("gitdir: {}/worktrees/feature\n", bare.display()),
        )
        .unwrap();
        let mut found = BTreeMap::new();
        add(&mut found, &superproject, &home, Some("claude"), 10, 1);
        add(&mut found, &submodule, &home, Some("claude"), 10, 1);
        add(&mut found, &checkout, &home, Some("claude"), 10, 1);
        fold_worktrees(&mut found, &home, &BTreeMap::new());
        assert_eq!(found.len(), 3);
        assert_eq!(found[&submodule].worktrees, 0);
        assert_eq!(found[&checkout].worktrees, 0);
        assert!(!found.contains_key(&home.join("repos")));
    }
    #[test]
    fn claude_finds_cwd_after_metadata() {
        let temp = tempfile::tempdir().unwrap();
        let file = temp.path().join("a.jsonl");
        fs::write(
            &file,
            "{\"type\":\"summary\"}\n{\"cwd\":\"/Users/test/project\"}\n",
        )
        .unwrap();
        assert_eq!(
            cwd_record(&file, false, &mut Budget::new()).unwrap()["cwd"],
            "/Users/test/project"
        );
    }
    #[test]
    fn imported_claude_history_does_not_count_as_local_activity() {
        let temp = tempfile::tempdir().unwrap();
        let home = fs::canonicalize(temp.path()).unwrap();
        let project = home.join("project");
        fs::create_dir_all(project.join(".git")).unwrap();
        let claude_home = home.join(".claude");
        let transcripts = claude_home.join("projects/project");
        fs::create_dir_all(&transcripts).unwrap();
        for (id, date) in [
            ("local", "2026-01-01T00:00:00Z"),
            ("imported", "2026-02-01T00:00:00Z"),
        ] {
            fs::write(
                transcripts.join(format!("{id}.jsonl")),
                format!("{}\n", json!({"cwd":project, "timestamp":date})),
            )
            .unwrap();
        }
        let records = claude(
            &home,
            &claude_home,
            &BTreeSet::from(["imported".into()]),
            &mut Budget::new(),
        )
        .unwrap();
        let mut found = BTreeMap::new();
        resolve(
            records,
            &home,
            &home.join(".codex"),
            &mut found,
            &BTreeMap::new(),
        );
        assert_eq!(
            found[&project].last,
            modified(&transcripts.join("local.jsonl"))
        );
        assert_eq!(found[&project].sessions, 1);
    }
    #[test]
    fn compressed_codex_history_is_discovered_without_changing_the_source() {
        let temp = tempfile::tempdir().unwrap();
        let home = fs::canonicalize(temp.path()).unwrap();
        let project = home.join("compressed-project");
        fs::create_dir_all(project.join(".git")).unwrap();
        let codex = home.join(".codex");
        let sessions = codex.join("sessions/2026/10/21");
        fs::create_dir_all(&sessions).unwrap();
        let source = sessions.join("rollout-compressed.jsonl.zst");
        let bytes = zstd::stream::encode_all(
            format!(
                "{}\n",
                json!({"type":"session_meta","payload":{"cwd":project}})
            )
            .as_bytes(),
            1,
        )
        .unwrap();
        fs::write(&source, &bytes).unwrap();
        fs::write(sessions.join("rollout-corrupt.jsonl.zst"), b"invalid zstd").unwrap();
        let records = history(
            &home,
            &home.join(".claude"),
            &codex,
            &ImportedHistory::default(),
            &mut Budget::new(),
        )
        .unwrap();
        let mut found = BTreeMap::new();
        resolve(
            records,
            &home,
            &home.join(".codex"),
            &mut found,
            &BTreeMap::new(),
        );
        assert_eq!(found.len(), 1);
        assert_eq!(found[&project].sessions, 1);
        assert!(found[&project].tools.contains("codex"));
        assert_eq!(fs::read(source).unwrap(), bytes);
    }
    #[test]
    fn five_projects_merge_tools_collapse_subfolders_and_stay_read_only() {
        let temp = tempfile::tempdir().unwrap();
        let home = fs::canonicalize(temp.path()).unwrap();
        let claude = home.join(".claude");
        let codex = home.join(".codex");
        fs::create_dir_all(codex.join("sessions/2026/10/21")).unwrap();
        for n in 0..5 {
            let project = home.join(format!("project-{n}"));
            fs::create_dir_all(project.join(".git")).unwrap();
            fs::create_dir_all(project.join("src")).unwrap();
            fs::write(
                project.join("never-read.txt"),
                "not valid JSON; discovery must never open this",
            )
            .unwrap();
            let dir = claude.join(format!("projects/encoded-{n}"));
            fs::create_dir_all(&dir).unwrap();
            fs::write(
                dir.join("session.jsonl"),
                format!(
                    "{{\"type\":\"summary\"}}\n{}\n",
                    json!({"cwd":project.join("src")})
                ),
            )
            .unwrap();
            fs::write(
                codex.join(format!("sessions/2026/10/21/rollout-{n}.jsonl")),
                format!(
                    "{}\n",
                    json!({"type":"session_meta","payload":{"cwd":project}})
                ),
            )
            .unwrap();
        }
        let mut found = BTreeMap::new();
        let mut budget = Budget::new();
        let records = history(
            &home,
            &claude,
            &codex,
            &ImportedHistory::default(),
            &mut budget,
        )
        .unwrap();
        resolve(
            records,
            &home,
            &home.join(".codex"),
            &mut found,
            &BTreeMap::new(),
        );
        assert_eq!(found.len(), 5);
        assert!(found
            .values()
            .all(|p| p.tools.len() == 2 && p.sessions == 2));
        assert!(budget.start.elapsed() < Duration::from_secs(5));
        for path in found.keys() {
            assert!(!path.join(".orka").exists());
            assert_eq!(
                fs::read_to_string(path.join("never-read.txt")).unwrap(),
                "not valid JSON; discovery must never open this"
            );
        }
    }
    #[test]
    fn folder_search_stops_at_three_levels_and_ignores_symlinks() {
        let temp = tempfile::tempdir().unwrap();
        let home = fs::canonicalize(temp.path()).unwrap();
        fs::create_dir_all(home.join("projects/one/two/three/.git")).unwrap();
        fs::create_dir_all(home.join("projects/one/two/three/four/.git")).unwrap();
        let outside = tempfile::tempdir().unwrap();
        fs::create_dir_all(outside.path().join(".git")).unwrap();
        std::os::unix::fs::symlink(outside.path(), home.join("projects/linked")).unwrap();
        let mut found = BTreeMap::new();
        folder(
            &home.join("projects"),
            4,
            &mut found,
            &home,
            &mut Budget::new(),
            true,
        );
        assert_eq!(found.len(), 1);
    }
}
