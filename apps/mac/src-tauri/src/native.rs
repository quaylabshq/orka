use crate::{
    db::{self, Result},
    packages, session_translation,
};
use rusqlite::params;
use serde_json::{json, Value};
use std::{
    fs,
    io::{BufRead, BufReader, Write},
    path::{Path, PathBuf},
    process::{Command, Stdio},
    sync::mpsc,
    time::Duration,
};
use uuid::Uuid;
pub fn binary(tool: &str) -> Result<PathBuf> {
    if !["codex", "claude"].contains(&tool) {
        return Err("Unknown tool".into());
    }
    let mut candidates = vec![
        db::home()?.join(".local/bin").join(tool),
        PathBuf::from("/opt/homebrew/bin").join(tool),
        PathBuf::from("/usr/local/bin").join(tool),
    ];
    if let Some(path) = std::env::var_os("PATH") {
        candidates.extend(std::env::split_paths(&path).map(|p| p.join(tool)));
    }
    let home = db::home()?;
    for directory in [
        ".volta/bin",
        ".npm-global/bin",
        "Library/pnpm",
        ".local/share/pnpm",
        ".asdf/shims",
        ".local/share/mise/shims",
    ] {
        candidates.push(home.join(directory).join(tool));
    }
    if tool == "claude" {
        candidates.push(home.join(".claude/local/claude"));
    }
    if let Ok(entries) = fs::read_dir(home.join(".nvm/versions/node")) {
        let mut versions: Vec<_> = entries
            .filter_map(|entry| entry.ok())
            .map(|entry| entry.path())
            .collect();
        versions.sort_by_key(|path| {
            std::cmp::Reverse(fs::metadata(path).and_then(|meta| meta.modified()).ok())
        });
        candidates.extend(versions.into_iter().map(|path| path.join("bin").join(tool)));
    }
    if tool == "codex" {
        candidates.extend(crate::session_launcher::bundled_cli());
        for applications in [PathBuf::from("/Applications"), home.join("Applications")] {
            candidates.push(applications.join("Codex.app/Contents/Resources/codex"));
            candidates.push(applications.join("ChatGPT.app/Contents/Resources/codex"));
        }
    }
    candidates
        .into_iter()
        .find(|p| {
            use std::os::unix::fs::PermissionsExt;
            fs::metadata(p)
                .is_ok_and(|meta| meta.is_file() && meta.permissions().mode() & 0o111 != 0)
        })
        .ok_or(format!("Install {tool} to enable native sessions"))
}
pub(crate) fn cli_path(binary: &Path) -> std::ffi::OsString {
    let mut paths = vec![binary
        .parent()
        .unwrap_or(Path::new("/usr/bin"))
        .to_path_buf()];
    if let Some(path) = std::env::var_os("PATH") {
        paths.extend(std::env::split_paths(&path));
    }
    paths.extend(["/opt/homebrew/bin", "/usr/local/bin", "/usr/bin", "/bin"].map(PathBuf::from));
    std::env::join_paths(paths).unwrap_or_else(|_| "/usr/bin:/bin".into())
}

pub fn version(tool: &str) -> Result<String> {
    let binary = binary(tool)?;
    let mut child = Command::new(&binary)
        .env("PATH", cli_path(&binary))
        .arg("--version")
        .stdout(Stdio::piped())
        .stderr(Stdio::null())
        .spawn()
        .map_err(|e| e.to_string())?;
    let deadline = std::time::Instant::now() + Duration::from_secs(10);
    loop {
        match child.try_wait() {
            Ok(Some(_)) => break,
            Ok(None) if std::time::Instant::now() < deadline => {
                std::thread::sleep(Duration::from_millis(20))
            }
            result => {
                let _ = child.kill();
                let _ = child.wait();
                return Err(match result {
                    Err(error) => format!("Cannot read {tool} version: {error}"),
                    _ => format!("{tool} --version timed out; check the installed CLI and retry"),
                });
            }
        }
    }
    let output = child.wait_with_output().map_err(|e| e.to_string())?;
    let v = String::from_utf8_lossy(&output.stdout).trim().to_string();
    if !output.status.success() || v.is_empty() {
        return Err(format!("Cannot determine installed {tool} version"));
    }
    Ok(v)
}
pub fn session_sources(db: &rusqlite::Connection, project: &str, session: &str) -> Result<Value> {
    let mut sources = db::get(db, &format!("sessionSources:{project}:{session}"))?
        .as_array()
        .cloned()
        .unwrap_or_default();
    for active in db::rows(
        db,
        "SELECT value FROM active WHERE native_id=? AND json_extract(value,'$.project')=?",
        &[&session, &project],
    )? {
        for source in active["contextSources"]
            .as_array()
            .cloned()
            .unwrap_or_default()
        {
            if !sources.contains(&source) {
                sources.push(source);
            }
        }
    }
    Ok(json!(sources))
}
pub fn record_handoff(
    db: &rusqlite::Connection,
    project: &Value,
    resource: &Value,
    path: &Path,
) -> Result<()> {
    if project["governed"] != true {
        return Ok(());
    }
    let project_id = project["id"].as_str().ok_or("Missing project")?;
    let id = resource["resourceId"].as_str().ok_or("Missing source")?;
    let mut sources = resource["contextSources"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if !sources.contains(&resource["resourceId"]) {
        sources.push(resource["resourceId"].clone());
    }
    db::set(
        db,
        &format!(
            "handoff:{project_id}:{id}:{}",
            db::digest(path.to_string_lossy().as_bytes())
        ),
        &json!({"path":path,"resource":resource,"sources":sources,"hash":db::digest(&fs::read(path).map_err(|e|e.to_string())?)}),
    )?;
    let mut pending = db::get(db, &format!("pendingHandoffSources:{project_id}"))?
        .as_array()
        .cloned()
        .unwrap_or_default();
    for id in sources {
        if !pending.contains(&id) {
            pending.push(id);
        }
    }
    db::set(
        db,
        &format!("pendingHandoffSources:{project_id}"),
        &json!(pending),
    )
}
pub fn bind_handoff(
    db: &rusqlite::Connection,
    project: &str,
    session: &str,
    records: &[Value],
) -> Result<()> {
    fn mentions(v: &Value, path: &str) -> bool {
        match v {
            Value::String(s) => s.contains(path),
            Value::Array(a) => a.iter().any(|v| mentions(v, path)),
            Value::Object(o) => o.values().any(|v| mentions(v, path)),
            _ => false,
        }
    }
    let mut known = session_sources(db, project, session)?
        .as_array()
        .cloned()
        .unwrap_or_default();
    let mut pending = db::get(db, &format!("pendingHandoffSources:{project}"))?
        .as_array()
        .cloned()
        .unwrap_or_default();
    for handoff in db::rows(
        db,
        "SELECT value FROM meta WHERE key GLOB ?",
        &[&format!("handoff:{project}:*")],
    )? {
        let path = handoff["path"].as_str().ok_or("Invalid handoff path")?;
        if !records.iter().any(|v| mentions(v, path)) {
            continue;
        }
        for source in handoff["sources"].as_array().cloned().unwrap_or_default() {
            if !known.contains(&source) {
                known.push(source.clone());
            }
            pending.retain(|id| id != &source);
        }
    }
    db::set(
        db,
        &format!("sessionSources:{project}:{session}"),
        &json!(known),
    )?;
    db::set(
        db,
        &format!("pendingHandoffSources:{project}"),
        &json!(pending),
    )
}
pub fn codex_home() -> Result<PathBuf> {
    Ok(std::env::var_os("CODEX_HOME")
        .map(PathBuf::from)
        .unwrap_or(db::home()?.join(".codex")))
}
pub fn claude_home() -> Result<PathBuf> {
    Ok(std::env::var_os("CLAUDE_CONFIG_DIR")
        .map(PathBuf::from)
        .unwrap_or(db::home()?.join(".claude")))
}
pub struct Rpc {
    child: std::process::Child,
    input: mpsc::Sender<(Value, mpsc::Sender<Result<()>>)>,
    rx: mpsc::Receiver<Value>,
    next: u64,
    deadline: Option<std::time::Instant>,
}
impl Rpc {
    fn spawn(proxy: bool) -> Result<Self> {
        let binary = binary("codex")?;
        let mut command = Command::new(&binary);
        command.env("PATH", cli_path(&binary));
        command.args(if proxy {
            vec!["app-server", "proxy"]
        } else {
            vec!["app-server"]
        });
        command.env("CODEX_HOME", codex_home()?);
        let mut child = command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::null())
            .spawn()
            .map_err(|e| e.to_string())?;
        let mut stdin = child.stdin.take().ok_or("No app-server stdin")?;
        let output = child.stdout.take().ok_or("No app-server stdout")?;
        let (input, requests) = mpsc::channel::<(Value, mpsc::Sender<Result<()>>)>();
        std::thread::spawn(move || {
            for (value, complete) in requests {
                let result = writeln!(stdin, "{value}")
                    .and_then(|()| stdin.flush())
                    .map_err(|e| e.to_string());
                if complete.send(result).is_err() {
                    break;
                }
            }
        });
        let (tx, rx) = mpsc::channel();
        std::thread::spawn(move || {
            for line in BufReader::new(output).lines() {
                let Ok(line) = line else { break };
                if let Ok(v) = serde_json::from_str(&line) {
                    if tx.send(v).is_err() {
                        break;
                    }
                }
            }
        });
        Ok(Self {
            child,
            input,
            rx,
            next: 0,
            deadline: None,
        })
    }
    pub fn connect() -> Result<Self> {
        version("codex")?;
        Self::connect_with(&[true, false], None)
    }
    pub fn connect_for_trust() -> Result<Self> {
        Self::connect_with(
            &[false],
            Some(std::time::Instant::now() + Duration::from_secs(8)),
        )
    }
    fn connect_with(modes: &[bool], deadline: Option<std::time::Instant>) -> Result<Self> {
        let mut failures = Vec::new();
        for &proxy in modes {
            let mut rpc = Self::spawn(proxy)?;
            rpc.deadline = deadline;
            let initialized = match rpc.call("initialize",json!({"clientInfo":{"name":"orka","version":"0.1.0"},"capabilities":{"experimentalApi":true}})) {
                Ok(value) if value.is_object() => value,
                Ok(_) => { failures.push("invalid app-server initialization response".into()); continue; }
                Err(error) => { failures.push(error); continue; }
            };
            let expected = codex_home()?;
            let actual = initialized["codexHome"].as_str().map(PathBuf::from);
            // Older direct servers omit codexHome. Only a child explicitly
            // started in our configured home may omit this identity check.
            if actual.as_ref().map_or(proxy, |home| {
                match (home.canonicalize(), expected.canonicalize()) {
                    (Ok(actual), Ok(expected)) => actual != expected,
                    _ => true,
                }
            }) {
                failures
                    .push("app-server reported a different or unverifiable Codex home".to_owned());
                continue;
            }
            rpc.send(json!({"method":"initialized"}))?;
            return Ok(rpc);
        }
        Err(format!(
            "Codex app server unavailable: {}",
            failures.join("; ")
        ))
    }
    fn send(&mut self, value: Value) -> Result<()> {
        let remaining = self.remaining();
        if remaining.is_zero() {
            return Err("Codex app server request timed out".into());
        }
        let (complete, result) = mpsc::channel();
        self.input
            .send((value, complete))
            .map_err(|_| "Codex app server closed stdin")?;
        result
            .recv_timeout(remaining)
            .map_err(|_| "Codex app server did not accept the request")?
    }
    fn remaining(&self) -> Duration {
        self.deadline.map_or(Duration::from_secs(20), |deadline| {
            deadline.saturating_duration_since(std::time::Instant::now())
        })
    }
    pub fn call(&mut self, method: &str, params: Value) -> Result<Value> {
        self.call_optional(method, params)?
            .ok_or_else(|| format!("Installed Codex does not support {method}"))
    }
    /// Only an explicit unknown-method response permits a compatibility fallback.
    /// Timeouts and ordinary RPC failures must remain retryable errors.
    pub fn call_optional(&mut self, method: &str, params: Value) -> Result<Option<Value>> {
        let response = self.request(method, params)?;
        if unsupported_method(&response["error"], method) {
            return Ok(None);
        }
        if !response["error"].is_null() {
            return Err(format!(
                "Codex {method}: {}",
                response["error"]["message"]
                    .as_str()
                    .unwrap_or("request failed")
            ));
        }
        Ok(Some(response["result"].clone()))
    }
    pub fn supports_pagination(&mut self) -> Result<bool> {
        let method = "thread/turns/list";
        let response = self.request(
            method,
            json!({"threadId":Uuid::nil().to_string(),"limit":1}),
        )?;
        if unsupported_method(&response["error"], method) {
            return Ok(false);
        }
        // A recognized method may reject the deliberately absent thread. Other
        // failures do not establish that the receiving server can read it.
        if response["error"].is_null() {
            return Ok(true);
        }
        let message = response["error"]["message"].as_str().unwrap_or_default();
        if message.to_ascii_lowercase().contains("not found")
            || message.contains("no rollout found")
            || message.starts_with("thread not loaded:")
        {
            return Ok(true);
        }
        Err(format!("Cannot detect Codex pagination support: {message}"))
    }
    pub(crate) fn request(&mut self, method: &str, params: Value) -> Result<Value> {
        self.next += 1;
        let id = self.next;
        let deadline = std::time::Instant::now() + self.remaining();
        self.send(json!({"id":id,"method":method,"params":params}))?;
        loop {
            let remaining = deadline.saturating_duration_since(std::time::Instant::now());
            let v = self
                .rx
                .recv_timeout(remaining)
                .map_err(|_| format!("Codex {method} did not respond"))?;
            if v["id"].as_u64() != Some(id) {
                continue;
            }
            if v.get("result").is_none() && v["error"].is_null() {
                return Err(format!("Codex {method} returned an invalid RPC response"));
            }
            return Ok(v);
        }
    }
}
pub(crate) fn unsupported_method(error: &Value, method: &str) -> bool {
    error["code"] == -32601
        || (error["code"] == -32600
            && error["message"]
                .as_str()
                .is_some_and(|message| message.contains(&format!("unknown variant `{method}`"))))
}
impl Drop for Rpc {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}
pub fn complete_records(bytes: &[u8]) -> Result<Vec<Value>> {
    let end = bytes
        .iter()
        .rposition(|b| *b == b'\n')
        .map(|p| p + 1)
        .unwrap_or(0);
    let mut records = Vec::new();
    for line in bytes[..end]
        .split(|b| *b == b'\n')
        .filter(|s| !s.is_empty())
    {
        records.push(
            serde_json::from_slice(line)
                .map_err(|_| "Unknown or corrupt native transcript; source preserved")?,
        );
    }
    Ok(records)
}
pub fn encode(records: &[Value]) -> Vec<u8> {
    let mut b = Vec::new();
    for r in records {
        b.extend_from_slice(r.to_string().as_bytes());
        b.push(b'\n');
    }
    b
}
pub fn session_cwd(tool: &str, records: &[Value]) -> Result<PathBuf> {
    let metadata = session_translation::metadata(tool, records)?;
    let cwd = PathBuf::from(metadata["cwd"].as_str().ok_or("Missing session cwd")?);
    if !cwd.is_absolute() {
        return Err("Session cwd must be absolute".into());
    }
    if tool == "pi"
        && cwd
            .components()
            .any(|part| part == std::path::Component::ParentDir)
    {
        return Err("Pi session cwd cannot contain parent components".into());
    }
    Ok(cwd)
}
pub fn session_info(tool: &str, records: &[Value]) -> Result<(String, PathBuf, String)> {
    let metadata = session_translation::metadata(tool, records)?;
    let cwd = session_cwd(tool, records)?;
    session_translation::format(tool, records)?;
    let id = metadata[if tool == "claude" { "sessionId" } else { "id" }]
        .as_str()
        .ok_or("Missing native ID")?;
    let title = if tool == "pi" {
        crate::pi_sessions::branch(records)?
            .into_iter()
            .filter(|record| record["type"] == "message")
            .find_map(title_from_record)
            .unwrap_or_else(|| "Pi session".into())
    } else {
        transcript_title(records)
    };
    Ok((id.into(), cwd, title))
}
pub fn validate_session_import(tool: &str, records: &[Value]) -> Result<()> {
    session_info(tool, records)?;
    Ok(())
}
fn transcript_title(records: &[Value]) -> String {
    records
        .iter()
        .find_map(title_from_record)
        .unwrap_or_else(|| "Imported session".into())
}
fn title_from_record(record: &Value) -> Option<String> {
    let text = session_translation::user_text(record)?;
    let redacted = crate::session_redaction::SessionRedactor::text(&text);
    crate::session_presentation::request_text(&redacted)
}
pub fn transcript_messages(records: &[Value]) -> Vec<Value> {
    session_translation::messages(records)
        .into_iter()
        .map(|message| json!({"role":message.role,"content":message.full_text}))
        .collect()
}
pub fn transcript(records: &[Value]) -> String {
    transcript_messages(records)
        .iter()
        .map(|message| {
            format!(
                "## {}\n\n{}\n\n",
                message["role"].as_str().unwrap_or_default(),
                message["content"].as_str().unwrap_or_default()
            )
        })
        .collect()
}

fn active_record(db: &rusqlite::Connection, id: &str) -> bool {
    if let Ok(rows) = db::rows(db, "SELECT value FROM active WHERE native_id=?", &[&id]) {
        if let Some(v) = rows.first() {
            if let Some(pid) = v["pid"].as_u64() {
                if Command::new("/bin/ps")
                    .args(["-p", &pid.to_string(), "-o", "pid="])
                    .output()
                    .is_ok_and(|o| !o.stdout.is_empty())
                {
                    return true;
                }
            }
            if v["pid"].is_null() {
                return true;
            }
            let _ = db.execute("DELETE FROM active WHERE native_id=?", [id]);
        }
    }
    false
}

pub fn active_for_resume(
    db: &rusqlite::Connection,
    id: &str,
    tool: &str,
    paths: &[PathBuf],
) -> bool {
    if tool == "codex" {
        return active(db, id, tool);
    }
    if active_record(db, id) {
        return true;
    }
    !paths.is_empty()
        && Command::new("/usr/sbin/lsof")
            .args(["-t", "--"])
            .args(paths)
            .output()
            .is_ok_and(|output| !output.stdout.is_empty())
}

pub fn active(db: &rusqlite::Connection, id: &str, tool: &str) -> bool {
    if active_record(db, id) {
        return true;
    }
    if tool == "codex" {
        return match Rpc::connect().and_then(|mut r| r.call("thread/loaded/list", json!({}))) {
            Ok(v) => v["data"]
                .as_array()
                .is_some_and(|a| a.iter().any(|v| v == id)),
            Err(_) => true,
        };
    }
    // A native process holding the transcript also protects sessions without hooks.
    let home = claude_home().ok();
    if let Some(home) = home {
        let root = home.join("projects");
        if let Ok(output) = Command::new("/usr/sbin/lsof")
            .args(["-t", "+D", &root.to_string_lossy()])
            .output()
        {
            if !output.stdout.is_empty() {
                return true;
            }
        }
    }
    false
}
pub fn materialize(
    db: &rusqlite::Connection,
    project: &Value,
    resource: &Value,
    old: &Value,
) -> Result<Value> {
    let tool = resource["source"].as_str().ok_or("Missing session tool")?;
    version(tool)?;
    let files = resource["files"]
        .as_array()
        .ok_or("Missing session files")?;
    let source = files
        .iter()
        .find(|f| f["path"] == "session.jsonl")
        .ok_or("Missing transcript")?;
    let records = complete_records(&db::blob_read(
        source["hash"].as_str().ok_or("Missing hash")?,
    )?)?;
    validate_session_import(tool, &records)?;
    if let Some(id) = old["nativeId"].as_str() {
        if active(db, id, tool) {
            return Err("Open session: incoming version staged until it closes".into());
        }
    }
    let (id, path) = if tool == "codex" {
        crate::codex_import::materialize(db, project, resource, old)?
    } else {
        crate::claude_import::materialize(db, project, resource, old, &records)?
    };
    Ok(
        json!({"nativeId":id,"paths":[path],"base":resource,"writeGuard":db::digest(&json!(files).to_string().into_bytes())}),
    )
}
pub fn fork_session(db: &rusqlite::Connection, project: &Value, resource: &Value) -> Result<Value> {
    let mut fork = resource.clone();
    fork["resourceId"] = json!(Uuid::new_v4().to_string());
    fork["owner"] = db::get(db, "user")?;
    // A fresh import identity and no old binding keep every source file untouched.
    materialize(db, project, &fork, &Value::Null)
}

#[derive(Debug, PartialEq, Eq)]
pub enum HookState {
    Configured,
    Missing,
    Partial,
    WrongProfile,
    WrongExecutable,
    Malformed,
    Unreadable,
}
#[derive(Debug)]
pub struct HookFileStatus {
    pub tool: &'static str,
    pub file: PathBuf,
    pub state: HookState,
}
#[derive(Debug)]
pub struct HookStatus {
    pub files: [HookFileStatus; 2],
}
pub struct Hooks;
impl Hooks {
    pub(crate) const FILES: [(&'static str, &'static str); 2] = [
        ("claude", ".claude/settings.local.json"),
        ("codex", ".codex/hooks.json"),
    ];
    pub(crate) const EVENTS: [&'static str; 4] =
        ["SessionStart", "UserPromptSubmit", "Stop", "SessionEnd"];
    const FLAG: &'static str = "--orka-hook";

    fn quote(value: &str) -> String {
        format!("'{}'", value.replace('\'', "'\\''"))
    }
    fn command(executable: &Path, tool: &str) -> String {
        format!(
            "{} --profile {} {} {tool}",
            Self::quote(&executable.to_string_lossy()),
            Self::quote(crate::profiles::current()),
            Self::FLAG
        )
    }
    pub(crate) fn claude_worktree_plugin() -> Result<PathBuf> {
        let scope = db::CacheScope::current()?
            .claude_worktree_scope()
            .ok_or("Sign in to Orka before setting up its Claude worktree plugin")?;
        let executable = crate::updates::executable().map_err(|e| e.to_string())?;
        let executable = executable
            .to_str()
            .ok_or("Orka's installation path is not valid UTF-8")?;
        let root = db::root()?;
        let directory = root.join("claude-worktree-plugins").join(&scope);
        let manifest = directory.join(".claude-plugin");
        packages::safe_directory(&root, &manifest)?;
        let command = format!(
            "{} --profile {} --orka-claude-worktree-hook {scope}",
            Self::quote(executable),
            Self::quote(crate::profiles::current()),
        );
        let handler = json!([{"hooks":[{"type":"command","command":command,"timeout":3}]}]);
        let contents = json!({
            "name":"orka-worktree-context",
            "version":env!("CARGO_PKG_VERSION"),
            "description":"Load shared Orka context on the first prompt in a connected Git worktree.",
            "hooks":{"UserPromptSubmit":handler,"SessionEnd":handler}
        });
        let bytes = serde_json::to_vec_pretty(&contents).map_err(|e| e.to_string())?;
        db::atomic(&manifest.join("plugin.json"), &bytes)?;
        Ok(directory)
    }

    fn parts<'a>(hook: &'a Value, tool: &str) -> Option<(&'a str, &'a str)> {
        if hook["type"] != "command" {
            return None;
        }
        let command = hook["command"].as_str()?;
        let prefix = [Self::FLAG, "--workspace-hook"]
            .into_iter()
            .find_map(|flag| command.strip_suffix(&format!(" {flag} {tool}")))?;
        let (executable, profile) = prefix.rsplit_once(" --profile ").unwrap_or((prefix, ""));
        let literal = executable.strip_prefix("'/")?.strip_suffix('\'')?;
        (!literal.replace("'\\''", "").contains('\'')).then_some((executable, profile))
    }
    /// The exact command this Orka build writes for `tool`.
    pub fn current_command(executable: &Path, tool: &str) -> String {
        Self::command(executable, tool)
    }
    /// Whether a hook command string is one Orka wrote for `tool`, under any
    /// profile or executable.
    pub fn owns(command: &Value, tool: &str) -> bool {
        Self::parts(&json!({"type":"command","command":command}), tool).is_some()
    }
    fn configure(cfg: &mut Value, executable: &Path, tool: &str) {
        if cfg["hooks"].is_null() {
            cfg["hooks"] = json!({});
        }
        for event in Self::EVENTS {
            if cfg["hooks"][event].is_null() {
                cfg["hooks"][event] = json!([]);
            }
            cfg["hooks"][event].as_array_mut().expect("validated hook event").push(json!({"hooks":[{"type":"command","command":Self::command(executable, tool),"timeout":3}]}));
        }
    }
    fn strip_orka(cfg: &mut Value, tool: &str) -> Result<bool> {
        if !cfg.is_object() || (!cfg["hooks"].is_null() && !cfg["hooks"].is_object()) {
            return Err("Hook config must be an object".into());
        }
        let Some(events) = cfg.get_mut("hooks").and_then(Value::as_object_mut) else {
            return Ok(false);
        };
        let mut owned = false;
        for event in Self::EVENTS {
            let Some(value) = events.get_mut(event).filter(|value| !value.is_null()) else {
                continue;
            };
            let groups = value.as_array_mut().ok_or("Hook event must be an array")?;
            let mut stripped = false;
            groups.retain_mut(|group| {
                let Some(hooks) = group.get_mut("hooks").and_then(Value::as_array_mut) else {
                    return true;
                };
                let before = hooks.len();
                hooks.retain(|hook| Self::parts(hook, tool).is_none());
                stripped |= hooks.len() != before;
                hooks.len() == before || !hooks.is_empty()
            });
            if stripped && groups.is_empty() {
                events.remove(event);
            }
            owned |= stripped;
        }
        if owned && events.is_empty() {
            cfg.as_object_mut()
                .expect("validated config")
                .remove("hooks");
        }
        Ok(owned)
    }

    pub(crate) fn worktree_config(
        old: Option<&[u8]>,
        executable: &Path,
        tool: &str,
    ) -> Result<(Vec<u8>, Option<Vec<u8>>)> {
        let mut cfg: Value = old
            .map(serde_json::from_slice)
            .transpose()
            .map_err(|e| format!("Existing hook config conflict: {e}"))?
            .unwrap_or_else(|| json!({}));
        if !Self::strip_orka(&mut cfg, tool)? && old.is_some() {
            return Err("Existing hook config has no recognized Orka command".into());
        }
        let restore = (!cfg.as_object().expect("validated config").is_empty())
            .then(|| serde_json::to_vec_pretty(&cfg))
            .transpose()
            .map_err(|e| e.to_string())?;
        Self::configure(&mut cfg, executable, tool);
        Ok((
            serde_json::to_vec_pretty(&cfg).map_err(|e| e.to_string())?,
            restore,
        ))
    }
    pub fn install(root: &Path) -> Result<()> {
        let base = root.canonicalize().map_err(|e| e.to_string())?;
        let executable = crate::updates::executable().map_err(|e| e.to_string())?;
        use crate::{
            git_artifacts::{self, Excludes, ProtectionError},
            onboarding::discovery,
        };
        let home = crate::worktrees::home()?;
        let mut git = discovery::enclosing_checkout(&base, &home)
            .map(|checkout| {
                let common = discovery::registered_worktree(&checkout)
                    .map(|(_, common)| common)
                    .or_else(|| discovery::primary_common_dir(&checkout))
                    .ok_or("Cannot validate hook destination's Git checkout")?;
                Ok::<_, String>((checkout, Excludes::open(&common)?))
            })
            .transpose()?;
        let mut failures = Vec::new();
        for (tool, relative) in Self::FILES {
            let path = base.join(relative);
            let result = (|| -> std::result::Result<(), ProtectionError> {
                let prepared = (|| -> Result<_> {
                    packages::safe_directory(&base, path.parent().ok_or("Missing parent")?)?;
                    let old = match fs::symlink_metadata(&path) {
                        Ok(metadata) if metadata.is_file() => {
                            Some(fs::read(&path).map_err(|e| e.to_string())?)
                        }
                        Ok(_) => return Err("Hook destination is not a regular file".into()),
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => None,
                        Err(error) => return Err(error.to_string()),
                    };
                    let mut cfg: Value = old
                        .as_deref()
                        .map(serde_json::from_slice)
                        .transpose()
                        .map_err(|e| e.to_string())?
                        .unwrap_or_else(|| json!({}));
                    if Self::state(&cfg, &executable, tool) == HookState::Configured {
                        return Ok((old, None));
                    }
                    // The explicit source installer has always repaired malformed event values.
                    if let Some(events) = cfg.get_mut("hooks").and_then(Value::as_object_mut) {
                        for event in Self::EVENTS {
                            if events.get(event).is_some_and(|value| !value.is_array()) {
                                events.remove(event);
                            }
                        }
                    }
                    Self::strip_orka(&mut cfg, tool)?;
                    Self::configure(&mut cfg, &executable, tool);
                    let bytes = serde_json::to_vec_pretty(&cfg).map_err(|e| e.to_string())?;
                    Ok((old, Some(bytes)))
                })();
                if let Some((checkout, excludes)) = &mut git {
                    // Tracked and explicitly re-included files are user-owned even when malformed.
                    let relative = path
                        .strip_prefix(checkout.as_path())
                        .map_err(|e| e.to_string())?;
                    if prepared.is_ok() {
                        excludes.protect(checkout, relative, true)?;
                    } else {
                        git_artifacts::check_hook_ownership(checkout, relative)?;
                    }
                }
                let (old, Some(bytes)) = prepared? else {
                    return Ok(());
                };
                let mut save = |path: &Path,
                                bytes: &[u8],
                                replacing|
                 -> std::result::Result<(), ProtectionError> {
                    let Some((checkout, excludes)) = &mut git else {
                        return db::atomic(path, bytes).map_err(Into::into);
                    };
                    let relative = path
                        .strip_prefix(checkout.as_path())
                        .map_err(|e| e.to_string())?;
                    let scratch = git_artifacts::scratch(relative);
                    excludes.protect(checkout, relative, true)?;
                    excludes.protect(checkout, &scratch, false)?;
                    let scratch_path = checkout.join(&scratch);
                    let result =
                        git_artifacts::publish(path, &scratch_path, bytes, 0o600, replacing);
                    if matches!(fs::symlink_metadata(scratch_path), Err(error) if error.kind() == std::io::ErrorKind::NotFound)
                    {
                        excludes.release(&scratch)?;
                    }
                    result.map_err(Into::into)
                };
                let backup = path.with_extension("json.orka-backup");
                if let Some(old) = &old {
                    match fs::symlink_metadata(&backup) {
                        Ok(_) => (),
                        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                            save(&backup, old, false)?
                        }
                        Err(error) => return Err(error.to_string().into()),
                    }
                }
                save(&path, &bytes, old.is_some())
            })();
            match result {
                Ok(()) => (),
                Err(ProtectionError::Refused(reason)) => {
                    eprintln!("Skipped {tool} hook setup at {}: {reason}", path.display());
                }
                Err(ProtectionError::Failed(error)) => {
                    failures.push(format!("{}: {error}", path.display()));
                }
            }
        }
        if failures.is_empty() {
            Ok(())
        } else {
            Err(failures.join("; "))
        }
    }
    pub fn inspect(root: &Path) -> Result<HookStatus> {
        let executable = crate::updates::executable().map_err(|e| e.to_string())?;
        Ok(HookStatus {
            files: Self::FILES.map(|(tool, file)| {
                let file = root.join(file);
                let state = match fs::read(&file) {
                    Ok(bytes) => serde_json::from_slice::<Value>(&bytes)
                        .map_or(HookState::Malformed, |cfg| {
                            Self::state(&cfg, &executable, tool)
                        }),
                    Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
                        HookState::Missing
                    }
                    Err(_) => HookState::Unreadable,
                };
                HookFileStatus { tool, file, state }
            }),
        })
    }
    fn state(cfg: &Value, executable: &Path, tool: &str) -> HookState {
        if !cfg.is_object() || (!cfg["hooks"].is_null() && !cfg["hooks"].is_object()) {
            return HookState::Malformed;
        }
        let mut configured = 0;
        let mut owned = false;
        for event in Self::EVENTS {
            if cfg["hooks"][event].is_null() {
                continue;
            }
            let Some(groups) = cfg["hooks"][event].as_array() else {
                return HookState::Malformed;
            };
            let mut found = false;
            for group in groups {
                let Some(hooks) = group["hooks"].as_array() else {
                    continue;
                };
                for hook in hooks {
                    if let Some((path, profile)) = Self::parts(hook, tool) {
                        owned = true;
                        if profile != Self::quote(crate::profiles::current()) {
                            return HookState::WrongProfile;
                        }
                        if path != Self::quote(&executable.to_string_lossy()) {
                            return HookState::WrongExecutable;
                        }
                        found |= hook["command"] == Self::command(executable, tool)
                            && group.get("matcher").is_none_or(|v| v == "");
                    }
                }
            }
            configured += usize::from(found);
        }
        if configured == Self::EVENTS.len() {
            HookState::Configured
        } else if !owned {
            HookState::Missing
        } else {
            HookState::Partial
        }
    }
}
#[cfg(test)]
#[path = "hook_tests.rs"]
mod hook_tests;
/// The project folder that contains `cwd`. An active project wins; otherwise a
/// deleted project that can still be restored is returned to track the
/// session, flagged as capture-only. An active parent folder still wins over
/// a deleted nested project.
fn hook_project(
    db: &rusqlite::Connection,
    cwd: &str,
    tool: &str,
    id: &str,
    worktree_only: bool,
) -> Result<Option<(Value, PathBuf, bool)>> {
    let home = crate::worktrees::home()?;
    if crate::worktrees::is_stale(db, Path::new(cwd), &home)? {
        return Ok(None);
    }
    let pinned = crate::worktrees::pinned_session(db, tool, id)?;
    for (predicate, capture_only) in [
        (crate::projects::ACTIVE, false),
        (crate::projects::CAPTURE_ONLY, true),
    ] {
        let views = crate::worktrees::source_views(db, predicate)?;
        let resolver = crate::worktrees::Resolver::new(&views, &home);
        if let Some(route) = resolver.resolve(Path::new(cwd)) {
            if worktree_only && (route.observed.is_none() || capture_only) {
                return Ok(None);
            }
            // A cwd change must not inject another source's context into a pinned session.
            if pinned
                .as_ref()
                .is_some_and(|pin| !pin.matches(route.source))
            {
                return Ok(None);
            }
            if let Some(observed) = route.observed {
                // The launch plugin pins this native session only. A later,
                // unrelated session cannot inherit its path from this callback.
                if !worktree_only {
                    observed.remember(db)?;
                }
                observed.pin(db, tool, id)?;
            }
            return Ok(Some((route.source.clone(), route.equivalent, capture_only)));
        }
    }
    Ok(None)
}

/// Where hook activity for one connected source folder is recorded. A
/// single-folder project without source records is keyed by its project id.
pub fn hook_seen_key(tool: &str, source: &Value) -> Option<String> {
    let id = source["sourceId"].as_str().or(source["id"].as_str())?;
    Some(format!("hookSeen:{tool}:{id}"))
}

pub fn hook(tool: &str, input: Value) -> Result<Value> {
    run_hook(tool, input, None)
}

pub(crate) fn claude_worktree_hook(scope: &str, input: Value) -> Result<Value> {
    if !matches!(
        input["hook_event_name"].as_str(),
        Some("UserPromptSubmit" | "SessionEnd")
    ) || !input["session_id"]
        .as_str()
        .is_some_and(|id| !id.is_empty() && id != "unknown")
    {
        return Ok(json!({}));
    }
    run_hook("claude", input, Some(scope))
}

fn run_hook(tool: &str, input: Value, worktree_scope: Option<&str>) -> Result<Value> {
    let scope = db::CacheScope::current()?;
    if worktree_scope
        .is_some_and(|expected| scope.claude_worktree_scope().as_deref() != Some(expected))
    {
        return Ok(json!({}));
    }
    let mut connection = scope.open()?;
    let Some(cwd) = input["cwd"].as_str() else {
        return Ok(json!({}));
    };
    let id = input["session_id"].as_str().unwrap_or("unknown");
    let worktree_only = worktree_scope.is_some();
    let file_route = if worktree_only {
        None
    } else {
        let Some(route) = hook_project(&connection, cwd, tool, id, false)? else {
            return Ok(json!({}));
        };
        Some(route)
    };
    let event = input["hook_event_name"].as_str().unwrap_or("SessionStart");
    let pid = if worktree_only || event == "SessionEnd" {
        Value::Null
    } else {
        hook_parent_pid(tool)?
    };
    let transaction = connection
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let db = &*transaction;
    let (project, equivalent_cwd, capture_only) = match file_route {
        Some(route) => route,
        None => {
            let Some(route) = hook_project(db, cwd, tool, id, true)? else {
                return Ok(json!({}));
            };
            route
        }
    };
    let project = &project;
    let project_id = project["id"].as_str().ok_or("Missing project")?;
    if matches!(tool, "claude" | "codex") {
        let now = json!(db::now());
        // The tool-wide key stays for older Orka versions and setup status.
        db::set(db, &format!("hookSeen:{tool}"), &now)?;
        if let Some(key) = hook_seen_key(tool, project) {
            db::set(db, &key, &now)?;
        }
    }
    // Launch hooks deliver context and record provenance. File hooks own
    // live-session tracking, even when both hook sources are present.
    if !worktree_only {
        if event == "SessionEnd" {
            if !capture_only || id != "unknown" {
                db::set(
                    db,
                    &format!("sessionSources:{project_id}:{id}"),
                    &session_sources(db, project_id, id)?,
                )?;
            }
            db.execute("DELETE FROM active WHERE native_id=?", [id])
                .map_err(|e| e.to_string())?;
        } else {
            let known = session_sources(db, project_id, id)?;
            let value = json!({"contextSources":known,"nativeId":id,"project":project["id"],"source":tool,"pid":pid,"ended":false,"updatedAt":db::now(),"transcriptPath":input["transcript_path"]});
            db.execute("INSERT INTO active VALUES(?,?) ON CONFLICT(native_id) DO UPDATE SET value=excluded.value",params![id,value.to_string()]).map_err(|e|e.to_string())?;
            // Promotion is local and durable; the daemon creates the server copy before uploads.
            for mut binding in db::rows(
                db,
                "SELECT value FROM bindings WHERE json_extract(value,'$.nativeId')=?",
                &[&id],
            )? {
                if binding["base"]["owner"] != db::get(db, "user")?
                    && !binding["base"]["owner"].is_null()
                {
                    binding["needsCopy"] = json!(true);
                    db::upsert(
                        db,
                        "bindings",
                        binding["base"]["resourceId"]
                            .as_str()
                            .ok_or("Missing resource")?,
                        project["id"].as_str().ok_or("Missing project")?,
                        &binding,
                    )?;
                }
            }
        }
    }
    // A deleted project that can still be restored tracks the session, but its
    // shared context is frozen: inject nothing until it is restored.
    if capture_only
        || (project["governed"] != true && !crate::projects::sharing_allowed(project, "memory"))
    {
        transaction.commit().map_err(|e| e.to_string())?;
        return Ok(json!({}));
    }
    let delivery_key = format!("contextDelivery:{project_id}:{tool}:{id}");
    if matches!(event, "Stop" | "SessionEnd") {
        if event == "SessionEnd" {
            db::set(db, &delivery_key, &Value::Null)?;
        }
        transaction.commit().map_err(|e| e.to_string())?;
        return Ok(json!({}));
    }
    transaction.commit().map_err(|e| e.to_string())?;
    let context = deliver_hook_context(
        &mut connection,
        tool,
        &input,
        project,
        &equivalent_cwd,
        worktree_only,
    )?;
    if worktree_only && db::CacheScope::current()? != scope {
        return Ok(json!({}));
    }
    Ok(context)
}

fn deliver_hook_context(
    db: &mut rusqlite::Connection,
    tool: &str,
    input: &Value,
    project: &Value,
    equivalent_cwd: &Path,
    worktree_only: bool,
) -> Result<Value> {
    let id = input["session_id"].as_str().unwrap_or("unknown");
    let project_id = project["id"].as_str().ok_or("Missing project")?;
    let event = input["hook_event_name"].as_str().unwrap_or("SessionStart");
    let delivery_key = format!("contextDelivery:{project_id}:{tool}:{id}");
    for _ in 0..2 {
        let delivered = db::get(db, &delivery_key)?;
        let (text, sources, fingerprints) = crate::governance::prepare_context(
            db,
            project,
            equivalent_cwd,
            Some(input["prompt"].as_str().unwrap_or("")),
            (id != "unknown").then_some(&delivered),
        )?;
        let transaction = db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        // Claude may call the file hook and the launch plugin concurrently.
        // Compare after reading the context so only the short commit holds
        // the writer lock. Replay with fresh fingerprints if another hook won.
        if id != "unknown" && db::get(&transaction, &delivery_key)? != delivered {
            continue;
        }
        if crate::worktrees::pinned_session(&transaction, tool, id)?
            .is_some_and(|pinned| !pinned.matches(project))
        {
            return Ok(json!({}));
        }
        if worktree_only {
            let cwd = input["cwd"].as_str().ok_or("Missing worktree")?;
            let current = hook_project(&transaction, cwd, tool, id, true)?;
            if !current
                .is_some_and(|(source, path, _)| source == *project && path == equivalent_cwd)
            {
                return Ok(json!({}));
            }
        }
        crate::governance::record_context_sources(&transaction, project, &sources)?;
        if project["governed"] == true {
            let mut active = db::rows(
                &transaction,
                "SELECT value FROM active WHERE native_id=? AND json_extract(value,'$.project')=?",
                &[&id, &project_id],
            )?
            .into_iter()
            .next();
            let mut known = session_sources(&transaction, project_id, id)?
                .as_array()
                .cloned()
                .unwrap_or_default();
            for source in sources {
                if !known.contains(&source) {
                    known.push(source);
                }
            }
            let known = json!(known);
            db::set(
                &transaction,
                &format!("sessionSources:{project_id}:{id}"),
                &known,
            )?;
            if let Some(active) = &mut active {
                active["contextSources"] = known;
                transaction
                    .execute(
                        "UPDATE active SET value=? WHERE native_id=?",
                        params![active.to_string(), id],
                    )
                    .map_err(|e| e.to_string())?;
            }
        }
        if id != "unknown" {
            db::set(&transaction, &delivery_key, &fingerprints)?;
        }
        transaction.commit().map_err(|e| e.to_string())?;
        if text.is_empty() {
            return Ok(json!({}));
        }
        let content = format!("{text}\nNative provider: {tool}; sessionId: {id}.\n");
        return Ok(
            json!({"hookSpecificOutput":{"hookEventName":event,"additionalContext":format!("Shared Orka project memory. Source labels are preserved; consult linked files for details.\n{content}")}}),
        );
    }
    Ok(json!({}))
}

fn hook_parent_pid(tool: &str) -> Result<Value> {
    let mut pid = std::process::id();
    let mut found = false;
    for _ in 0..8 {
        let output = Command::new("/bin/ps")
            .args(["-p", &pid.to_string(), "-o", "ppid="])
            .output()
            .map_err(|e| e.to_string())?;
        let Ok(parent) = String::from_utf8_lossy(&output.stdout)
            .trim()
            .parse::<u32>()
        else {
            break;
        };
        pid = parent;
        let command = Command::new("/bin/ps")
            .args(["-p", &pid.to_string(), "-o", "comm="])
            .output()
            .map_err(|e| e.to_string())?;
        if String::from_utf8_lossy(&command.stdout).contains(tool) {
            found = true;
            break;
        }
    }
    Ok(if found { json!(pid) } else { Value::Null })
}
