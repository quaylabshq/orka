//! Whether Codex actually runs the hooks Orka writes into a source folder.
//!
//! Codex only loads a project's `.codex/hooks.json` when the folder is trusted,
//! and it only runs each project hook after that hook's current hash has been
//! approved (`hooks.state.<key>.trusted_hash` in the user's `config.toml`). A
//! correct hook file is therefore not proof that Codex receives Orka memory.
//! This module asks Codex itself through `hooks/list` and `config/read`, and
//! never writes Codex configuration.
use crate::native;
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
