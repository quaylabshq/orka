//! Whether Codex actually runs the hooks Orka writes into a source folder.
//!
//! Codex only loads a project's `.codex/hooks.json` when the folder is trusted,
//! and it only runs each project hook after that hook's current hash has been
//! approved (`hooks.state.<key>.trusted_hash` in the user's `config.toml`). A
//! correct hook file is therefore not proof that Codex receives Orka memory.
//! This module asks Codex itself through `hooks/list` and `config/read`, and
//! never writes Codex configuration.
use crate::{
    db::{self, Result},
    native, projects, sources,
};
use serde_json::{json, Value};
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Trust {
    /// Codex loads and runs every Orka hook it lists for this folder.
    Trusted,
    /// The folder has no trust entry, so Codex skips its `.codex/` files.
    FolderNotTrusted,
    /// The user explicitly marked this folder (or a parent) untrusted.
    FolderUntrusted,
    /// The folder is trusted but Orka's hooks were never approved.
    HooksNotApproved,
    /// Orka's hook commands changed since the user approved them.
    HooksChanged,
    /// `features.hooks = false`, or the hooks are disabled in Codex.
    HooksDisabled,
    /// Codex answered, but the result does not establish either way.
    Unknown(String),
}

impl Trust {
    pub fn code(&self) -> &'static str {
        match self {
            Self::Trusted => "trusted",
            Self::FolderNotTrusted => "folder-not-trusted",
            Self::FolderUntrusted => "folder-untrusted",
            Self::HooksNotApproved => "hooks-not-approved",
            Self::HooksChanged => "hooks-changed",
            Self::HooksDisabled => "hooks-disabled",
            Self::Unknown(_) => "unknown",
        }
    }
    pub fn to_json(&self) -> Value {
        match self {
            Self::Unknown(reason) => json!({"state":self.code(),"reason":reason}),
            _ => json!({"state":self.code()}),
        }
    }
}

/// The result of one inspection across several source folders.
#[derive(Debug)]
pub enum Report {
    /// One entry per requested folder, in request order.
    Folders(Vec<(PathBuf, Trust)>),
    /// The installed Codex predates `hooks/list`, so trust can't be read.
    Unsupported,
    /// Codex is missing or its app server could not be reached.
    Unavailable(String),
}

/// Asks the installed Codex about each folder. Read-only.
pub fn inspect(roots: &[PathBuf]) -> Report {
    if roots.is_empty() {
        return Report::Folders(Vec::new());
    }
    let mut rpc = match native::Rpc::connect_for_trust() {
        Ok(rpc) => rpc,
        Err(error) => return Report::Unavailable(error),
    };
    let cwds: Vec<String> = roots
        .iter()
        .map(|root| root.to_string_lossy().into_owned())
        .collect();
    let listed = match rpc.call_optional("hooks/list", json!({ "cwds": cwds })) {
        Ok(Some(listed)) => listed,
        Ok(None) => return Report::Unsupported,
        Err(error) => return Report::Unavailable(error),
    };
    let config = match rpc.call("config/read", json!({})) {
        Ok(read) => read["config"].clone(),
        Err(error) => return Report::Unavailable(error),
    };
    Report::Folders(
        roots
            .iter()
            .map(|root| (root.clone(), classify(root, &listed, &config)))
            .collect(),
    )
}

/// Classifies one folder from Codex's `hooks/list` and `config/read` results.
pub fn classify(root: &Path, listed: &Value, config: &Value) -> Trust {
    if !config.is_object() {
        return Trust::Unknown("Codex did not return its configuration".into());
    }
    if config["features"]["hooks"] == false {
        return Trust::HooksDisabled;
    }
    let root_text = root.to_string_lossy();
    let Some(entry) = listed["data"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|entry| same_path(entry["cwd"].as_str(), root))
    else {
        return Trust::Unknown(format!("Codex did not report hooks for {root_text}"));
    };
    if ["errors", "warnings"].iter().any(|field| {
        entry[*field]
            .as_array()
            .is_some_and(|items| !items.is_empty())
    }) || !entry["hooks"].is_array()
    {
        return Trust::Unknown("Codex could not inspect the folder's hooks reliably".into());
    }
    let file = root.join(".codex/hooks.json");
    let ours: Vec<&Value> = entry["hooks"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|hook| {
            hook["source"] == "project"
                && same_path(hook["sourcePath"].as_str(), &file)
                && native::Hooks::owns(&hook["command"], "codex")
        })
        .collect();
    if !ours.is_empty() {
        let status = |wanted: &str| ours.iter().any(|hook| hook["trustStatus"] == wanted);
        return if ours.iter().any(|hook| hook["enabled"] == false) {
            Trust::HooksDisabled
        } else if status("modified") {
            Trust::HooksChanged
        } else if status("untrusted") {
            Trust::HooksNotApproved
        } else if ours
            .iter()
            .all(|hook| matches!(hook["trustStatus"].as_str(), Some("trusted" | "managed")))
        {
            if native::Hooks::EVENTS.iter().all(|event| {
                ours.iter().any(|hook| {
                    hook["eventName"]
                        .as_str()
                        .is_some_and(|name| name.eq_ignore_ascii_case(event))
                })
            }) {
                Trust::Trusted
            } else {
                Trust::Unknown("Codex did not load every Orka hook event".into())
            }
        } else {
            Trust::Unknown("Codex reported an unrecognized hook trust status".into())
        };
    }
    match folder_trust(root, config) {
        Some("untrusted") => Trust::FolderUntrusted,
        Some("trusted") => {
            Trust::Unknown("Codex trusts this folder but did not load Orka's hooks".into())
        }
        _ => Trust::FolderNotTrusted,
    }
}

/// The trust level Codex applies to `root`: its own entry, or the nearest
/// parent's (a repository root entry also covers its subfolders).
fn folder_trust<'a>(root: &Path, config: &'a Value) -> Option<&'a str> {
    let projects = config["projects"].as_object()?;
    let canonical = root.canonicalize().ok();
    canonical
        .as_deref()
        .unwrap_or(root)
        .ancestors()
        .find_map(|folder| {
            projects
                .iter()
                .filter_map(|(key, entry)| {
                    let level = entry["trust_level"].as_str()?;
                    same_path(Some(key), folder).then_some(level)
                })
                .min_by_key(|level| *level != "untrusted")
        })
        .or_else(|| {
            root.ancestors()
                .find_map(|folder| projects.get(folder.to_str()?)?["trust_level"].as_str())
        })
}

fn same_path(reported: Option<&str>, expected: &Path) -> bool {
    let Some(reported) = reported else {
        return false;
    };
    let reported = Path::new(reported);
    reported == expected
        || matches!(
            (reported.canonicalize(), expected.canonicalize()),
            (Ok(a), Ok(b)) if a == b
        )
}

#[cfg(test)]
#[path = "codex_trust_tests.rs"]
mod codex_trust_tests;

/// Codex trust for each connected source folder of an active project whose
/// Codex hook file Orka configured. Folders with hook-file problems are left
/// to the existing reconnect and doctor paths.
pub fn project_status(db: &rusqlite::Connection, project_id: &str) -> Result<Value> {
    let folders = connected_sources(db, project_id)?;
    let roots: Vec<PathBuf> = folders.iter().map(|(_, root)| root.clone()).collect();
    Ok(match inspect(&roots) {
        Report::Folders(found) => {
            let folders: Vec<Value> = folders
                .iter()
                .zip(found)
                .map(|((source, root), (_, trust))| {
                    let mut value = trust.to_json();
                    value["sourceId"] = source["sourceId"].clone();
                    value["path"] = json!(root);
                    value
                })
                .collect();
            json!({"state":"ready","folders":folders})
        }
        Report::Unsupported => json!({"state":"unsupported","folders":[]}),
        Report::Unavailable(reason) => json!({"state":"unavailable","reason":reason,"folders":[]}),
    })
}

fn connected_sources(db: &rusqlite::Connection, project_id: &str) -> Result<Vec<(Value, PathBuf)>> {
    let project = db::rows(
        db,
        &format!(
            "SELECT value FROM projects WHERE id=? AND {}",
            projects::ACTIVE
        ),
        &[&project_id],
    )?
    .into_iter()
    .next()
    .ok_or("Project not found")?;
    let mut seen = std::collections::BTreeSet::new();
    Ok(sources::views(&project)
        .into_iter()
        .filter(|source| sources::validate(source).is_ok())
        .filter_map(|source| {
            let root = PathBuf::from(source["path"].as_str()?);
            let configured = native::Hooks::inspect(&root)
                .ok()?
                .files
                .iter()
                .any(|file| file.tool == "codex" && file.state == native::HookState::Configured);
            (configured && seen.insert(root.clone())).then_some((source, root))
        })
        .collect())
}

/// Lets Codex run Orka's hooks in one source folder, on the user's request.
/// Trusts the folder if needed, then approves Orka's current hook commands in
/// that folder only. Never overrides a folder the user marked untrusted, never
/// turns hooks back on, and writes through Codex with a version check so a
/// concurrent edit to config.toml is never overwritten.
pub fn trust(db: &rusqlite::Connection, project_id: &str, source_id: &str) -> Result<Value> {
    let (_, root) = connected_sources(db, project_id)?
        .into_iter()
        .find(|(source, _)| {
            source["sourceId"].as_str().or(source["id"].as_str()) == Some(source_id)
        })
        .ok_or("Reconnect this folder in Orka before trusting it in Codex")?;
    let executable = crate::updates::executable().map_err(|e| e.to_string())?;
    let mut rpc = native::Rpc::connect()?;
    // A concurrent edit makes Codex reject the write; read again and retry once.
    for attempt in 0..2 {
        match approve(&mut rpc, &root, &executable) {
            Err(Write::Conflict) if attempt == 0 => continue,
            Err(Write::Conflict) => {
                return Err("Codex settings changed while Orka was saving. Try again.".into())
            }
            Err(Write::Failed(error)) => return Err(error),
            Ok(trust) => return Ok(trust.to_json()),
        }
    }
    unreachable!()
}

enum Write {
    Conflict,
    Failed(String),
}
impl From<String> for Write {
    fn from(error: String) -> Self {
        Self::Failed(error)
    }
}
impl From<&str> for Write {
    fn from(error: &str) -> Self {
        Self::Failed(error.into())
    }
}

const MANUAL: &str = "This Codex version can't be updated by Orka. Update Codex, or run codex in this folder, trust it, and approve Orka's hooks in /hooks.";

fn approve(
    rpc: &mut native::Rpc,
    root: &Path,
    executable: &Path,
) -> std::result::Result<Trust, Write> {
    let (listed, config, version) = read(rpc, root)?;
    match classify(root, &listed, &config) {
        Trust::Trusted => return Ok(Trust::Trusted),
        Trust::FolderUntrusted => {
            return Err("This folder is marked untrusted in Codex. Orka won't change that; edit its trust_level in your Codex config.toml if you want Orka memory there.".into())
        }
        Trust::HooksDisabled => {
            return Err("Codex hooks are turned off. Turn them back on in Codex, then try again.".into())
        }
        Trust::FolderNotTrusted => {
            let key = root.canonicalize().unwrap_or_else(|_| root.to_owned());
            let key = key.to_string_lossy();
            write(rpc, json!({"keyPath":"projects","value":{key:{"trust_level":"trusted"}},"mergeStrategy":"upsert"}), &version)?;
        }
        Trust::HooksNotApproved | Trust::HooksChanged | Trust::Unknown(_) => {}
    }
    // Project hooks only appear in hooks/list once the folder is trusted.
    let (listed, _, version) = read(rpc, root)?;
    let expected = native::Hooks::current_command(executable, "codex");
    let file = root.join(".codex/hooks.json");
    let approvals: serde_json::Map<String, Value> = listed["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|entry| same_path(entry["cwd"].as_str(), root))
        .flat_map(|entry| entry["hooks"].as_array().into_iter().flatten())
        .filter(|hook| {
            hook["source"] == "project"
                && same_path(hook["sourcePath"].as_str(), &file)
                && hook["command"] == expected
                && hook["trustStatus"] != "trusted"
        })
        .filter_map(|hook| {
            Some((
                hook["key"].as_str()?.to_owned(),
                json!({"trusted_hash": hook["currentHash"].as_str()?}),
            ))
        })
        .collect();
    if !approvals.is_empty() {
        write(
            rpc,
            json!({"keyPath":"hooks.state","value":approvals,"mergeStrategy":"upsert"}),
            &version,
        )?;
    }
    let (listed, config, _) = read(rpc, root)?;
    Ok(classify(root, &listed, &config))
}

/// Codex's hooks for `root`, its effective config, and the user config
/// version a write must match.
fn read(rpc: &mut native::Rpc, root: &Path) -> std::result::Result<(Value, Value, Value), Write> {
    let listed = rpc
        .call_optional("hooks/list", json!({"cwds":[root]}))?
        .ok_or(MANUAL)?;
    let read = rpc.call("config/read", json!({"includeLayers":true}))?;
    let version = read["layers"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|layer| layer["name"]["type"] == "user")
        .map(|layer| layer["version"].clone())
        .unwrap_or(Value::Null);
    Ok((listed, read["config"].clone(), version))
}

fn write(rpc: &mut native::Rpc, edit: Value, version: &Value) -> std::result::Result<(), Write> {
    match rpc.call_optional(
        "config/batchWrite",
        json!({"edits":[edit],"expectedVersion":version}),
    ) {
        Ok(Some(_)) => Ok(()),
        Ok(None) => Err(MANUAL.into()),
        Err(error) if error.contains("modified since last read") => Err(Write::Conflict),
        Err(error) => Err(error.into()),
    }
}
