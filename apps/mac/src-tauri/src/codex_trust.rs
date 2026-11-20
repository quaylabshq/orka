//! Whether Codex actually runs the hooks Orka writes into a source folder.
//!
//! Codex only loads a project's `.codex/hooks.json` when the folder is trusted,
//! and it only runs each project hook after that hook's current hash has been
//! approved (`hooks.state.<key>.trusted_hash` in the user's `config.toml`). A
//! correct hook file is therefore not proof that Codex receives Orka memory.
//! Status reads Codex configuration. Only the explicit trust action writes it.
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
    inspect_with(roots, classify)
}

fn inspect_with(roots: &[PathBuf], classify: impl Fn(&Path, &Value, &Value) -> Trust) -> Report {
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
    Report::Folders(
        roots
            .iter()
            .map(|root| {
                let trust = match rpc.call("config/read", json!({"cwd":root})) {
                    Ok(read) => classify(root, &listed, &read["config"]),
                    Err(error) => Trust::Unknown(error),
                };
                (root.clone(), trust)
            })
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
    let tokens: Vec<_> = roots.iter().map(|root| folder_token(root).ok()).collect();
    Ok(
        match inspect_with(&roots, |root, listed, config| {
            let trust = classify(root, listed, config);
            let original = folders
                .iter()
                .find(|(_, path)| path == root)
                .and_then(|(source, _)| source["path"].as_str())
                .map_or(root, Path::new);
            if matches!(
                trust,
                Trust::FolderNotTrusted | Trust::HooksChanged | Trust::HooksNotApproved
            ) && explicitly_untrusted(root, original, config)
            {
                Trust::FolderUntrusted
            } else {
                trust
            }
        }) {
            Report::Folders(found) => {
                let folders: Vec<Value> = folders
                    .iter()
                    .zip(found)
                    .zip(tokens)
                    .map(|(((source, root), (_, trust)), token)| {
                        let mut value = trust.to_json();
                        value["sourceId"] = source["sourceId"].clone();
                        value["path"] = json!(root);
                        value["folderToken"] = json!(token);
                        value
                    })
                    .collect();
                json!({"state":"ready","folders":folders})
            }
            Report::Unsupported => json!({"state":"unsupported","folders":[]}),
            Report::Unavailable(reason) => {
                json!({"state":"unavailable","reason":reason,"folders":[]})
            }
        },
    )
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
            let root = Path::new(source["path"].as_str()?).canonicalize().ok()?;
            for path in [root.join(".codex"), root.join(".codex/hooks.json")] {
                if std::fs::symlink_metadata(path)
                    .ok()?
                    .file_type()
                    .is_symlink()
                {
                    return None;
                }
            }
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
pub fn trust(
    db: &rusqlite::Connection,
    project_id: &str,
    source_id: &str,
    token: &str,
) -> Result<Value> {
    let (source, root) = connected_sources(db, project_id)?
        .into_iter()
        .find(|(source, _)| {
            source["sourceId"].as_str().or(source["id"].as_str()) == Some(source_id)
        })
        .ok_or("Reconnect this folder in Orka before trusting it in Codex")?;
    let original = Path::new(source["path"].as_str().ok_or("Missing source folder")?);
    let verify_folder = || {
        let current = connected_sources(db, project_id)?
            .into_iter()
            .find(|(source, _)| {
                source["sourceId"].as_str().or(source["id"].as_str()) == Some(source_id)
            });
        if current.as_ref().is_some_and(|(source, path)| {
            path == &root
                && source["path"]
                    .as_str()
                    .is_some_and(|path| Path::new(path) == original)
        }) && folder_token(&root)? == token
        {
            Ok(())
        } else {
            Err(
                "The connected folder changed. Reopen Settings and review it before trusting it."
                    .to_owned(),
            )
        }
    };
    verify_folder()?;
    let executable = crate::updates::executable().map_err(|e| e.to_string())?;
    let mut rpc = native::Rpc::connect_for_trust()?;
    // A concurrent edit makes Codex reject the write; read again and retry once.
    for attempt in 0..2 {
        match approve(&mut rpc, &root, original, &executable, &verify_folder) {
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

fn folder_token(root: &Path) -> Result<String> {
    let identity = crate::indexer::folder_identity(root)?;
    Ok(db::digest(
        &serde_json::to_vec(&json!([root, identity])).map_err(|e| e.to_string())?,
    ))
}

fn explicitly_untrusted(root: &Path, original: &Path, config: &Value) -> bool {
    config["projects"].as_object().is_some_and(|projects| {
        projects.iter().any(|(path, entry)| {
            entry["trust_level"] == "untrusted"
                && root
                    .ancestors()
                    .chain(original.ancestors())
                    .any(|ancestor| same_path(Some(path), ancestor))
        })
    })
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
    original: &Path,
    executable: &Path,
    verify_folder: &impl Fn() -> Result<()>,
) -> std::result::Result<Trust, Write> {
    let (mut listed, mut config, mut version) = read(rpc, root, original)?;
    match classify(root, &listed, &config) {
        Trust::Trusted => return Ok(Trust::Trusted),
        Trust::FolderUntrusted => {
            return Err("This folder is marked untrusted in Codex. Orka won't change that; edit its trust_level in your Codex config.toml if you want Orka memory there.".into())
        }
        Trust::HooksDisabled => {
            return Err("Codex hooks are turned off. Turn them back on in Codex, then try again.".into())
        }
        Trust::FolderNotTrusted => {
            let key = root.to_str().ok_or("Unsupported Codex folder path")?;
            verify_folder()?;
            write(rpc, json!({"keyPath":"projects","value":{key:{"trust_level":"trusted"}},"mergeStrategy":"upsert"}), &version)?;
            // Hooks are visible only after Codex loads the newly trusted layer.
            (listed, config, version) = read(rpc, root, original)?;
        }
        Trust::HooksNotApproved | Trust::HooksChanged => {}
        Trust::Unknown(reason) => return Err(reason.into()),
    }
    match classify(root, &listed, &config) {
        Trust::Trusted => return Ok(Trust::Trusted),
        Trust::HooksNotApproved | Trust::HooksChanged => {}
        other => return Ok(other),
    }
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
                && hook["handlerType"] == "command"
                && hook["enabled"] == true
                && matches!(hook["trustStatus"].as_str(), Some("modified" | "untrusted"))
                && native::Hooks::EVENTS.iter().any(|event| {
                    hook["eventName"]
                        .as_str()
                        .is_some_and(|name| name.eq_ignore_ascii_case(event))
                })
        })
        .filter_map(|hook| {
            Some((
                hook["key"].as_str()?.to_owned(),
                json!({"trusted_hash": hook["currentHash"].as_str()?}),
            ))
        })
        .collect();
    if !approvals.is_empty() {
        verify_folder()?;
        write(
            rpc,
            json!({"keyPath":"hooks.state","value":approvals,"mergeStrategy":"upsert"}),
            &version,
        )?;
    }
    let (listed, config, _) = read(rpc, root, original)?;
    Ok(classify(root, &listed, &config))
}

fn refuse_untrusted(
    root: &Path,
    original: &Path,
    config: &Value,
) -> std::result::Result<(), Write> {
    if explicitly_untrusted(root, original, config) {
        return Err(
            "This folder or a parent is marked untrusted in Codex. Orka won't change that.".into(),
        );
    }
    Ok(())
}

/// Bind the hook listing to the user-layer revision on both sides of the read.
fn read(
    rpc: &mut native::Rpc,
    root: &Path,
    original: &Path,
) -> std::result::Result<(Value, Value, String), Write> {
    let before = rpc.call("config/read", json!({"includeLayers":true,"cwd":root}))?;
    let listed = rpc
        .call_optional("hooks/list", json!({"cwds":[root]}))?
        .ok_or(MANUAL)?;
    let after = rpc.call("config/read", json!({"includeLayers":true,"cwd":root}))?;
    let layer = user_layer(&after)?;
    let version = layer["version"]
        .as_str()
        .filter(|version| !version.is_empty())
        .ok_or(MANUAL)?;
    if user_layer(&before)?["version"] != version || before["config"] != after["config"] {
        return Err(Write::Conflict);
    }
    refuse_untrusted(root, original, &layer["config"])?;
    refuse_untrusted(root, original, &after["config"])?;
    Ok((listed, after["config"].clone(), version.to_owned()))
}

fn user_layer(read: &Value) -> std::result::Result<&Value, Write> {
    read["layers"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|layer| layer["name"]["type"] == "user")
        .ok_or_else(|| MANUAL.into())
}

fn write(rpc: &mut native::Rpc, edit: Value, version: &str) -> std::result::Result<(), Write> {
    let method = "config/batchWrite";
    let response = rpc.request(method, json!({"edits":[edit],"expectedVersion":version}))?;
    let error = &response["error"];
    if native::unsupported_method(error, method) {
        return Err(MANUAL.into());
    }
    if error["data"]["config_write_error_code"] == "configVersionConflict" {
        return Err(Write::Conflict);
    }
    if !error.is_null() {
        return Err(error["message"]
            .as_str()
            .unwrap_or("Codex could not save its settings")
            .into());
    }
    Ok(())
}
