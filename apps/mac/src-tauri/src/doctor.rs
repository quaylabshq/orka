use crate::{
    auth,
    codex_trust::{self, Report, Trust},
    db, native, projects, sources, sync,
};
use chrono::{DateTime, Utc};
use serde_json::Value;
use std::{
    collections::BTreeSet,
    io::Write,
    path::{Path, PathBuf},
};

#[derive(Clone, Copy)]
enum Verdict {
    Pass,
    Warn,
    Fail,
}
type Finding = db::Result<(Verdict, String)>;
#[derive(Default)]
pub struct Doctor {
    pub(crate) output: String,
    pub(crate) code: i32,
}
impl Doctor {
    pub fn run() -> i32 {
        let db = db::open();
        let report = Self::collect(db.as_ref().ok(), auth::session());
        std::io::stdout()
            .write_all(report.output.as_bytes())
            .map_or(1, |_| report.code)
    }
    pub(crate) fn collect(db: Option<&rusqlite::Connection>, session: db::Result<Value>) -> Self {
        Self::collect_with(db, session, &codex_trust::inspect)
    }
    pub(crate) fn collect_with(
        db: Option<&rusqlite::Connection>,
        session: db::Result<Value>,
        codex: &dyn Fn(&[PathBuf]) -> Report,
    ) -> Self {
        let mut report = Self::default();
        report.record("Login", Self::login(db, session), "Open Orka, allow Keychain access, and sign in to the selected service; choose Sync now to refresh an expired session.");
        report.record("Sync", Self::sync(db), "Open Orka's sync menu, review issues, and choose Retry uploads or Sync now. If sync is in progress, wait and rerun doctor.");
        if let Err(error) = report.hooks(db, codex) {
            report.record(
                "Hooks",
                Err(error),
                "Check access to Orka's local storage and source folders, then rerun doctor.",
            );
        }
        report
    }
    fn record(&mut self, name: &str, finding: Finding, next: &str) {
        let (verdict, detail) =
            finding.unwrap_or((Verdict::Fail, "Local status unavailable.".into()));
        let (label, code) = match verdict {
            Verdict::Pass => ("PASS", 0),
            Verdict::Warn => ("WARN", 2),
            Verdict::Fail => ("FAIL", 1),
        };
        if self.code != 1 && code != 0 {
            self.code = code;
        }
        self.output.push_str(&format!("{label} {name}: {detail}\n"));
        if code != 0 {
            self.output.push_str(&format!("  Next: {next}\n"));
        }
    }
    fn hooks(
        &mut self,
        db: Option<&rusqlite::Connection>,
        codex: &dyn Fn(&[PathBuf]) -> Report,
    ) -> db::Result<()> {
        use native::HookState::*;
        let db = db.ok_or("Local database unavailable")?;
        let projects = db::rows(
            db,
            &format!("SELECT value FROM projects WHERE {}", projects::ACTIVE),
            &[],
        )?;
        let mut roots = BTreeSet::new();
        let mut any = false;
        let mut folders = Vec::new();
        for source in projects.iter().flat_map(sources::views) {
            let Some(path) = source["path"].as_str().map(str::to_owned) else {
                continue;
            };
            let path = &*path;
            any = true;
            if path.is_empty() || sources::validate(&source).is_err() {
                self.record(
                    "Hooks",
                    Ok((
                        Verdict::Warn,
                        format!("Source folder unavailable: {path:?}."),
                    )),
                    "Open Orka Settings > Source folders and use Locate Folder/Reconnect.",
                );
                continue;
            }
            if !roots.insert(path.to_owned()) {
                continue;
            }
            match native::Hooks::inspect(Path::new(path)) {
                Ok(status) => folders.push((source, PathBuf::from(path), status)),
                Err(error) => self.record(
                    "Hooks",
                    Err(error),
                    "Check the Orka installation and source-folder permissions, then rerun doctor.",
                ),
            }
        }
        // Ask Codex once, and only about folders whose Codex hook file is correct.
        let asked: Vec<PathBuf> = folders
            .iter()
            .filter(|(_, _, status)| {
                status
                    .files
                    .iter()
                    .any(|file| file.tool == "codex" && file.state == Configured)
            })
            .map(|(_, path, _)| path.clone())
            .collect();
        let trust = codex(&asked);
        for (source, root, status) in folders {
            for file in status.files {
                let (finding, next) = match file.state {
                    Configured => {
                        let seen = native::hook_seen_key(file.tool, &source)
                            .map(|key| db::get(db, &key))
                            .transpose()
                            .map(|value| value.as_ref().and_then(Self::time));
                        let is_codex = file.tool == "codex";
                        let label = if is_codex { ", trusted by Codex" } else { "" };
                        let codex_trust = is_codex.then(|| Self::codex(&trust, &root));
                        match codex_trust {
                            Some(Err((finding, next))) => (Ok(finding), next),
                            _ => (
                                seen.map(|seen| match seen {
                                    Some(time) => (
                                        Verdict::Pass,
                                        format!(
                                            "configured{label}; last seen in this folder {}",
                                            Self::stamp(Some(time))
                                        ),
                                    ),
                                    None => (
                                        Verdict::Warn,
                                        format!(
                                            "configured{label}; no activity recorded in this folder yet"
                                        ),
                                    ),
                                }),
                                "Check local storage access, then start this tool in this source folder and rerun doctor.",
                            ),
                        }
                    }
                    state => {
                        let next = if state == Unreadable {
                            "Allow read access to this hook file, then rerun doctor."
                        } else {
                            "Restore Orka's entries in this file, or disconnect and reconnect this source folder in the intended Orka profile to reinstall hooks."
                        };
                        let problem = match state {
                            Missing => "missing hooks",
                            Partial => "partial configuration",
                            WrongProfile => "wrong Orka profile",
                            WrongExecutable => "wrong Orka executable",
                            Malformed => "malformed configuration",
                            Unreadable => "file unreadable",
                            Configured => unreachable!(),
                        };
                        (Ok((Verdict::Fail, problem.into())), next)
                    }
                };
                let finding = finding
                    .map(|(verdict, detail)| (verdict, format!("{detail}; file {:?}.", file.file)));
                self.record(&format!("{} hooks", file.tool), finding, next);
            }
        }
        if !any {
            self.record(
                "Hooks",
                Ok((
                    Verdict::Warn,
                    "No connected source folders to inspect.".into(),
                )),
                "Connect a source folder in Orka, then start Claude or Codex there.",
            );
        }
        Ok(())
    }
    /// Ok when Codex runs Orka's hooks in `root`; otherwise the finding and
    /// next step that replace the activity check.
    fn codex(trust: &Report, root: &Path) -> Result<(), ((Verdict, String), &'static str)> {
        const APPROVE: &str = "Run codex in this folder, trust the folder when asked, then open /hooks and approve Orka's hooks. Rerun doctor.";
        let trust =
            match trust {
                Report::Folders(folders) => folders
                    .iter()
                    .find(|(path, _)| path == root)
                    .map(|(_, trust)| trust.clone())
                    .unwrap_or_else(|| Trust::Unknown("not checked".into())),
                Report::Unsupported => return Err((
                    (
                        Verdict::Warn,
                        "configured; this Codex version can't report whether it runs Orka's hooks"
                            .into(),
                    ),
                    "Update Codex, then rerun doctor.",
                )),
                Report::Unavailable(reason) => {
                    return Err((
                        (
                            Verdict::Warn,
                            format!(
                        "configured; couldn't ask Codex whether it runs Orka's hooks ({reason})"
                    ),
                        ),
                        "Check that Codex is installed and opens, then rerun doctor.",
                    ))
                }
            };
        let (detail, next) = match trust {
            Trust::Trusted => return Ok(()),
            Trust::FolderNotTrusted => ("Codex skips this folder's hooks because the folder isn't trusted in Codex", APPROVE),
            Trust::FolderUntrusted => ("Codex skips this folder's hooks because it's marked untrusted in Codex", "To use Orka memory in Codex here, change this folder's trust_level in your Codex config.toml, then rerun doctor."),
            Trust::HooksNotApproved => ("Codex trusts this folder but Orka's hooks haven't been approved", APPROVE),
            Trust::HooksChanged => ("Orka's hooks changed since they were approved in Codex, so Codex skips them", APPROVE),
            Trust::HooksDisabled => ("Codex hooks are turned off", "Remove features.hooks = false from your Codex config.toml, or turn Orka's hooks back on in Codex /hooks, then rerun doctor."),
            Trust::Unknown(_) => ("configured; Codex's answer didn't show whether it runs Orka's hooks", "Run codex in this folder and check /hooks, then rerun doctor."),
        };
        let verdict = if matches!(trust, Trust::Unknown(_)) {
            Verdict::Warn
        } else {
            Verdict::Fail
        };
        Err(((verdict, detail.into()), next))
    }
    fn time(value: &Value) -> Option<DateTime<Utc>> {
        value.as_str()?.parse().ok()
    }
    fn stamp(time: Option<DateTime<Utc>>) -> String {
        time.map(|t| t.to_rfc3339())
            .unwrap_or_else(|| "none".into())
    }
    fn login(db: Option<&rusqlite::Connection>, session: db::Result<Value>) -> Finding {
        let db = db.ok_or("Local database unavailable")?;
        let session = session?;
        let user = db::get(db, "user")?;
        let config = db::get(db, "config")?;
        let service = config["apiUrl"].as_str().unwrap_or("");
        let valid = user
            .as_str()
            .is_some_and(|id| uuid::Uuid::parse_str(id).is_ok())
            && session["user"]["id"] == user
            && db::validate_url(service).is_ok()
            && session["apiUrl"].as_str().unwrap_or(service) == service
            && ["access_token", "refresh_token"]
                .iter()
                .all(|key| session[key].as_str().is_some_and(|v| !v.is_empty()));
        let expires = session["expires_at"].as_i64().unwrap_or(0);
        let (verdict, detail) = match (valid, expires <= Utc::now().timestamp() + 60) {
            (false, _) => (Verdict::Fail, "Saved login is invalid or mismatched."),
            (true, true) => (Verdict::Warn, "Saved session needs refresh."),
            (true, false) => (
                Verdict::Pass,
                "Saved session available; server login unverified.",
            ),
        };
        Ok((verdict, detail.into()))
    }
    fn sync(db: Option<&rusqlite::Connection>) -> Finding {
        let db = db.ok_or("Local database unavailable")?;
        let summary = sync::Summary::read(db, db::daemon_running()?)?;
        let config = db::get(db, "config")?;
        let last = Self::time(&summary.status["lastSync"]);
        let updated = Self::time(&summary.status["updatedAt"]);
        let error = &summary.status["error"];
        let has_error = error.as_str().is_some_and(|e| !e.is_empty());
        let stale_after = crate::sync_schedule::Interval::from_config(&config).stale_after();
        let invalid = (!summary.status.is_null() && !summary.status.is_object())
            || (!error.is_null() && !error.is_string())
            || (!summary.status["lastSync"].is_null() && last.is_none())
            || (!summary.status["updatedAt"].is_null() && updated.is_none());
        let (verdict, reason) =
            if invalid || summary.issues > 0 || has_error || summary.status["online"] == false {
                (Verdict::Fail, "recorded sync needs attention")
            } else if summary.pending > 0 {
                (Verdict::Warn, "queued work")
            } else if !summary.progress.is_null() {
                (Verdict::Warn, "sync in progress")
            } else if last.is_none() {
                (Verdict::Warn, "never synced")
            } else if last.is_some_and(|t| {
                Utc::now().signed_duration_since(t)
                    > chrono::Duration::seconds(stale_after.as_secs() as i64)
            }) {
                (Verdict::Warn, "last success is stale")
            } else {
                (Verdict::Pass, "last recorded sync succeeded")
            };
        let error = match (has_error, invalid) {
            (true, _) => "present (review in Orka)",
            (_, true) => "unverified",
            _ => "none",
        };
        let (pending, issues) = (summary.pending, summary.issues);
        let (last, updated) = (Self::stamp(last), Self::stamp(updated));
        Ok((verdict, format!("{reason}; {pending} queued; {issues} issues; last success {last}; updated {updated}; recorded error {error}.")))
    }
}
