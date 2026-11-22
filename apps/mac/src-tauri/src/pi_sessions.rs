use crate::db::{self, Result};
use serde_json::Value;
use std::{collections::HashMap, path::PathBuf};

pub(crate) fn directory() -> Result<PathBuf> {
    #[cfg(debug_assertions)]
    if std::env::var_os("ORKA_TEST_HOME").is_some() {
        return Ok(db::home()?.join(".pi/agent/sessions"));
    }
    if let Some(path) = std::env::var_os("PI_CODING_AGENT_SESSION_DIR").filter(|p| !p.is_empty()) {
        return Ok(path.into());
    }
    let agent_dir = std::env::var_os("PI_CODING_AGENT_DIR")
        .filter(|p| !p.is_empty())
        .map(PathBuf::from)
        .map_or_else(|| db::home().map(|home| home.join(".pi/agent")), Ok)?;
    Ok(agent_dir.join("sessions"))
}

pub(crate) fn branch(records: &[Value]) -> Result<Vec<&Value>> {
    let header = records.first().ok_or("Missing Pi session header")?;
    if header["type"] != "session" || !matches!(header["version"].as_u64(), Some(2 | 3)) {
        return Err("Unsupported Pi session format; original preserved".into());
    }
    let mut entries = HashMap::with_capacity(records.len() - 1);
    let mut leaf = None;
    for record in &records[1..] {
        let id = record["id"]
            .as_str()
            .filter(|id| !id.is_empty())
            .ok_or("Missing Pi entry ID")?;
        let parent = match record.get("parentId") {
            Some(Value::Null) => None,
            Some(Value::String(parent)) if entries.contains_key(parent.as_str()) => {
                Some(parent.as_str())
            }
            _ => return Err("Invalid Pi entry parent".into()),
        };
        if !record["type"]
            .as_str()
            .is_some_and(|kind| !kind.is_empty() && kind != "session")
            || entries.insert(id, (record, parent)).is_some()
        {
            return Err("Invalid Pi session tree".into());
        }
        leaf = Some(id);
    }

    // Pi reopens at the last persisted entry, not at the last message.
    let mut branch = Vec::new();
    while let Some(id) = leaf {
        let (record, parent) = entries[id];
        branch.push(record);
        leaf = parent;
    }
    branch.reverse();
    Ok(branch)
}
