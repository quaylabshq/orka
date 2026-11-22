use crate::{
    codex_trust,
    db::{self, Result},
    sync,
};
use serde_json::Value;

#[tauri::command]
pub async fn settings_command(
    action: String,
    context: Value,
    input: Option<Value>,
) -> Result<Value> {
    let db = db::open()?;
    let owner = db::get(&db, "user")?;
    let service = db::get(&db, "config")?["apiUrl"].clone();
    if context["user"] != owner || context["service"] != service {
        return Err("Account or service changed. Reopen Settings.".into());
    }
    if matches!(
        action.as_str(),
        "codex-trust" | "open-codex-source" | "approve-codex-hooks"
    ) {
        drop(db);
        let input = input.unwrap_or_default();
        return tauri::async_runtime::spawn_blocking(move || {
            let db = db::open()?;
            if db::get(&db, "user")? != owner || db::get(&db, "config")?["apiUrl"] != service {
                return Err("Account or service changed. Reopen Settings.".into());
            }
            let project = input["projectId"].as_str().ok_or("Missing project")?;
            if action == "codex-trust" {
                return codex_trust::project_status(&db, project);
            }
            let source = input["sourceId"].as_str().ok_or("Missing source folder")?;
            let token = input["folderToken"]
                .as_str()
                .ok_or("Refresh Codex trust status first")?;
            if action == "open-codex-source" {
                codex_trust::open_in_codex(&db, project, source, token)?;
                return Ok(Value::Null);
            }
            codex_trust::approve_hooks(&db, project, source, token)
        })
        .await
        .map_err(|e| e.to_string())?;
    }
    let path = match action.as_str() {
        "capabilities" => "/v2/projects/capabilities",
        "devices" => "/v2/devices",
        _ => return Err("Unknown Settings action".into()),
    };
    let mut result =
        sync::api_as(owner.as_str().ok_or("Sign in first")?, "GET", path, None).await?;
    let current = db::open()?;
    if db::get(&current, "user")? != owner || db::get(&current, "config")?["apiUrl"] != service {
        return Err("Account or service changed. Reopen Settings.".into());
    }
    if action == "devices" {
        result = crate::device_metadata::update_devices(&current, &result)?;
    }
    Ok(result)
}
