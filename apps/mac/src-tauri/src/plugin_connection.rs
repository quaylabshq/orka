//! Desktop-owned connector consent. Local session credentials never contain account tokens.
use crate::{
    auth,
    db::{self, Result},
    projects,
};
use fs2::FileExt;
use serde_json::{json, Value};
use std::fs;
use uuid::Uuid;

pub const RECONNECT: &str =
    "Reconnect the Orka connector in your assistant, then approve the new session in Orka.";
const STATE_FILE: &str = "plugin-connection.json";
const SCOPES: [&str; 3] = ["orka.read", "orka.write", "orka.manage"];

fn state_lock() -> Result<fs::File> {
    use std::os::unix::fs::OpenOptionsExt;
    let root = db::root()?;
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .mode(0o600)
        .custom_flags(libc::O_NOFOLLOW)
        .open(root.join("plugin-connection.lock"))
        .map_err(|e| e.to_string())?;
    file.lock_exclusive().map_err(|e| e.to_string())?;
    Ok(file)
}

fn read_state() -> Result<Value> {
    match fs::read(db::root()?.join(STATE_FILE)) {
        Ok(raw) => {
            let mut state: Value = serde_json::from_slice(&raw).map_err(|_| RECONNECT)?;
            Uuid::parse_str(state["generation"].as_str().ok_or(RECONNECT)?)
                .map_err(|_| RECONNECT)?;
            // Old remote-proof approvals are intentionally not migrated into desktop grants.
            if !state["sessions"].is_object() {
                state["sessions"] = json!({});
            }
            state.as_object_mut().ok_or(RECONNECT)?.remove("approval");
            Ok(state)
        }
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => {
            let state =
                json!({"generation":Uuid::new_v4().to_string(),"reason":null,"sessions":{}});
            write_state(&state)?;
            Ok(state)
        }
        Err(e) => Err(e.to_string()),
    }
}
fn write_state(state: &Value) -> Result<()> {
    db::atomic(&db::root()?.join(STATE_FILE), state.to_string().as_bytes())
}
pub(crate) fn generation() -> Result<String> {
    let _lock = state_lock()?;
    Ok(read_state()?["generation"]
        .as_str()
        .ok_or(RECONNECT)?
        .into())
}
pub(crate) fn invalidate(reason: &str) -> Result<()> {
    let _lock = state_lock()?;
    let mut state = read_state().unwrap_or_else(|_| json!({"sessions":{}}));
    state["generation"] = json!(Uuid::new_v4().to_string());
    state["reason"] = json!(reason);
    // Keep tombstones: a live old helper must never acquire a new account's grant.
    for session in state["sessions"]
        .as_object_mut()
        .ok_or(RECONNECT)?
        .values_mut()
    {
        session["state"] = json!("reconnect_required");
    }
    write_state(&state)
}

fn account(db: &rusqlite::Connection) -> Result<Value> {
    let user = db::get(db, "user")?;
    let Some(id) = user.as_str() else {
        return Ok(Value::Null);
    };
    let session = auth::session()?;
    if session["user"]["id"] != id {
        return Err(RECONNECT.into());
    }
    let profile = db::get(db, "accountProfile")?;
    Ok(
        json!({"id":id,"email":session["user"]["email"].as_str(),"displayName":profile["displayName"].as_str()}),
    )
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub(crate) struct Binding {
    pub(crate) account_id: String,
    pub(crate) service_origin: String,
    pub(crate) device_id: String,
    pub(crate) generation: String,
    #[serde(default)]
    pub(crate) session_id: Option<String>,
}

impl Binding {
    pub(crate) fn current() -> Result<Self> {
        let db = db::open()?;
        let account_id = db::get(&db, "user")?.as_str().ok_or(RECONNECT)?.to_string();
        let service_origin = db::get(&db, "config")?["apiUrl"]
            .as_str()
            .ok_or(RECONNECT)?
            .to_string();
        db::validate_url(&service_origin)?;
        Ok(Self {
            account_id,
            service_origin,
            device_id: db::device(&db)?,
            generation: generation()?,
            session_id: None,
        })
    }

    pub(crate) fn check_current(&self) -> Result<()> {
        let current = Self::current()?;
        if self.account_id != current.account_id
            || self.service_origin != current.service_origin
            || self.device_id != current.device_id
            || self.generation != current.generation
        {
            return Err(RECONNECT.into());
        }
        if let Some(id) = &self.session_id {
            let _lock = state_lock()?;
            let state = read_state()?;
            if state["sessions"][id]["state"] != "approved"
                || state["sessions"][id]["binding"]["generation"] != self.generation
            {
                return Err(RECONNECT.into());
            }
        }
        Ok(())
    }
}

fn expires(value: &Value) -> bool {
    value
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .is_some_and(|t| t.timestamp() > chrono::Utc::now().timestamp())
}
fn session<'a>(state: &'a Value, id: &str, secret: &str) -> Result<&'a Value> {
    Uuid::parse_str(id).map_err(|_| "Invalid connector session")?;
    if secret.len() != 64 || !secret.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("Invalid connector credential".into());
    }
    let value = &state["sessions"][id];
    if value["secretHash"] != db::digest(secret.as_bytes()) {
        return Err(RECONNECT.into());
    }
    Ok(value)
}
fn public_session(value: &Value, generation: &Value) -> Value {
    let mut result = json!({"id":value["id"],"client":value["client"],"scopes":value["scopes"],"connectedAt":value["connectedAt"],"state":value["state"]});
    if value["binding"].is_object() && value["binding"]["generation"] != *generation
        || value["state"] == "pending" && !expires(&value["expiresAt"])
    {
        result["state"] = json!("reconnect_required");
    }
    result
}
fn preview(value: &Value) -> Value {
    json!({"requestId":value["requestId"],"account":value["account"],"serviceOrigin":value["binding"]["service_origin"],
        "client":value["client"],"scopes":value["requestedScopes"],"expiresAt":value["expiresAt"],
        "permissionDescriptions":["Read local and shared project context.","Share selected content, install skills, update memories and plans, and retry or repair synchronization.","Manage project permissions and review requests within your existing authority."]})
}

pub(crate) fn initialize_session(id: &str, secret: &str, name: &str) -> Result<Value> {
    Uuid::parse_str(id).map_err(|_| "Invalid connector session")?;
    if secret.len() != 64 || !secret.bytes().all(|c| c.is_ascii_hexdigit()) {
        return Err("Invalid connector credential".into());
    }
    let _operation = projects::lock()?;
    let binding = Binding::current().ok();
    let actual = account(&db::open()?).unwrap_or(Value::Null);
    let _lock = state_lock()?;
    let mut state = read_state()?;
    if !state["sessions"][id].is_null() {
        return Err(
            "This connector session was already initialized. Reconnect in your assistant.".into(),
        );
    }
    if state["sessions"].as_object().ok_or(RECONNECT)?.len() >= 512 {
        // Only initialize may create a grant. A live helper initializes once; an
        // evicted credential can only fail subsequent calls, never adopt a grant.
        let oldest = state["sessions"]
            .as_object()
            .ok_or(RECONNECT)?
            .iter()
            .min_by_key(|(_, v)| {
                (
                    v["state"] == "approved",
                    v["createdAt"].as_i64().unwrap_or(0),
                )
            })
            .map(|(k, _)| k.clone())
            .ok_or(RECONNECT)?;
        state["sessions"]
            .as_object_mut()
            .ok_or(RECONNECT)?
            .remove(&oldest);
    }
    let requested = json!(SCOPES);
    let label = name
        .chars()
        .filter(|c| !c.is_control())
        .take(100)
        .collect::<String>();
    let request_id = Uuid::new_v4().to_string();
    let valid = binding.is_some() && !actual.is_null();
    state["sessions"][id] = json!({"id":id,"secretHash":db::digest(secret.as_bytes()),"binding":binding,"account":actual,
        "client":{"id":id,"name":if label.trim().is_empty(){"Assistant"}else{label.as_str()}},
        "requestId":request_id,"createdAt":chrono::Utc::now().timestamp_millis(),"requestedScopes":requested,"scopes":[],"connectedAt":null,
        "state":if valid{"pending"}else{"signed_out"},"expiresAt":(chrono::Utc::now()+chrono::Duration::minutes(10)).to_rfc3339()});
    write_state(&state)?;
    Ok(
        json!({"state":if valid{"pending"}else{"signed_out"},"requestId":if valid{json!(request_id)}else{Value::Null}}),
    )
}

pub(crate) fn close_session(id: &str, secret: &str) -> Result<()> {
    let _lock = state_lock()?;
    let mut state = read_state()?;
    session(&state, id, secret)?;
    state["sessions"]
        .as_object_mut()
        .ok_or(RECONNECT)?
        .remove(id);
    write_state(&state)
}

pub(crate) fn authorize(id: &str, secret: &str, scope: &str) -> Result<Binding> {
    let value = {
        let _lock = state_lock()?;
        session(&read_state()?, id, secret)?.clone()
    };
    if value["state"] != "approved" {
        return Err(match value["state"].as_str() {
            Some("pending") if expires(&value["expiresAt"]) => "Approve this connector session in Orka, then retry the tool.",
            Some("signed_out") => "Sign in to Orka desktop, then reconnect this connector in your assistant and approve it in Orka.",
            Some("denied") => "This connector session was denied in Orka. Reconnect in your assistant to request approval again.",
            _ => RECONNECT,
        }.into());
    }
    let mut binding: Binding =
        serde_json::from_value(value["binding"].clone()).map_err(|_| RECONNECT)?;
    binding.check_current()?;
    if !value["scopes"]
        .as_array()
        .is_some_and(|s| s.contains(&json!(scope)))
    {
        return Err(format!("This connector session lacks {scope}. Reconnect in your assistant and approve the required access in Orka."));
    }
    if account(&db::open()?)?["id"] != binding.account_id {
        return Err(RECONNECT.into());
    }
    binding.session_id = Some(id.into());
    Ok(binding)
}

#[tauri::command]
pub fn plugin_connection_requests() -> Result<Value> {
    let current = Binding::current().ok();
    let _lock = state_lock()?;
    let state = read_state()?;
    Ok(json!(state["sessions"]
        .as_object()
        .ok_or(RECONNECT)?
        .values()
        .filter(|v| {
            v["state"] == "pending"
                && expires(&v["expiresAt"])
                && current
                    .as_ref()
                    .is_some_and(|b| v["binding"]["generation"] == b.generation)
        })
        .map(preview)
        .collect::<Vec<_>>()))
}
#[tauri::command]
pub fn plugin_connection_status() -> Result<Value> {
    let db = db::open()?;
    let actual = account(&db).unwrap_or(Value::Null);
    let service = db::get(&db, "config")?["apiUrl"].clone();
    let _lock = state_lock()?;
    let state = read_state()?;
    let connections = state["sessions"]
        .as_object()
        .ok_or(RECONNECT)?
        .values()
        .map(|v| public_session(v, &state["generation"]))
        .collect::<Vec<_>>();
    let linked = !actual.is_null() && connections.iter().any(|v| v["state"] == "approved");
    let pending = connections
        .iter()
        .filter(|v| v["state"] == "pending")
        .count();
    Ok(
        json!({"state":if actual.is_null(){"signed_out"}else if linked{"linked"}else if pending>0{"pending"}else if connections.is_empty(){"not_linked"}else{"reconnect_required"},
        "account":actual,"serviceOrigin":service,"connections":connections,"pendingCount":pending,"reconnectRequired":!linked,
        "reason":if linked{Value::Null}else if actual.is_null(){json!("Sign in to Orka desktop, then reconnect the connector in your assistant.")}else if pending>0{json!("Approve the connector session in Orka.")}else{json!(RECONNECT)}}),
    )
}
pub(crate) fn session_status(id: &str, secret: &str) -> Result<Value> {
    let mut result = plugin_connection_status()?;
    let _lock = state_lock()?;
    let state = read_state()?;
    let value = session(&state, id, secret)?;
    result
        .as_object_mut()
        .ok_or(RECONNECT)?
        .remove("connections");
    result["connection"] = public_session(value, &state["generation"]);
    result["state"] = result["connection"]["state"].clone();
    result["reconnectRequired"] = json!(result["state"] != "approved");
    if result["state"] != "approved" {
        result["reason"]=json!(match result["state"].as_str(){Some("pending")=>"Approve this connector session in Orka, then retry.",Some("denied")=>"This connector session was denied. Reconnect in your assistant to request approval again.",Some("signed_out")=>"Sign in to Orka desktop, then reconnect in your assistant.",_=>RECONNECT});
    }
    Ok(result)
}

#[tauri::command]
pub async fn plugin_authorization(operation: String, input: Value) -> Result<Value> {
    let _operation = projects::lock()?;
    let current = Binding::current()?;
    if account(&db::open()?)?["id"] != current.account_id {
        return Err(RECONNECT.into());
    }
    let _lock = state_lock()?;
    let mut state = read_state()?;
    if operation == "revoke" {
        let id = input["connectionId"]
            .as_str()
            .ok_or("Choose a connector session")?;
        let value = state["sessions"]
            .get_mut(id)
            .ok_or("Connector session unavailable")?;
        value["state"] = json!("reconnect_required");
        write_state(&state)?;
        return Ok(json!({"revoked":true}));
    }
    let request = input["requestId"]
        .as_str()
        .ok_or("Open the pending connector request in Orka")?;
    let id = state["sessions"]
        .as_object()
        .ok_or(RECONNECT)?
        .iter()
        .find(|(_, v)| v["requestId"] == request)
        .map(|(k, _)| k.clone())
        .ok_or("This connector request is no longer available")?;
    if state["generation"] != current.generation {
        return Err(RECONNECT.into());
    }
    let value = &mut state["sessions"][&id];
    if value["state"] != "pending" || !expires(&value["expiresAt"]) {
        return Err(
            "This connector request expired or was already completed. Reconnect in your assistant."
                .into(),
        );
    }
    if value["binding"]["generation"] != current.generation
        || value["account"]["id"] != current.account_id
    {
        return Err(RECONNECT.into());
    }
    if operation == "preview" {
        return Ok(preview(value));
    }
    if operation == "cancel" {
        value["state"] = json!("denied");
        write_state(&state)?;
        return Ok(json!({"cancelled":true}));
    }
    if operation != "approve" {
        return Err("Unknown connector action".into());
    }
    let scopes = input
        .get("scopes")
        .cloned()
        .unwrap_or_else(|| value["requestedScopes"].clone());
    let list = scopes.as_array().ok_or("Choose connector access")?;
    if !list.contains(&json!("orka.read"))
        || list.iter().any(|s| !SCOPES.iter().any(|a| s == a))
        || list.len() > 3
    {
        return Err("Choose read access and only the requested connector scopes".into());
    }
    value["scopes"] = scopes;
    value["state"] = json!("approved");
    value["connectedAt"] = json!(db::now());
    write_state(&state)?;
    Ok(json!({"approved":true}))
}

// Browser OAuth handoffs no longer grant access to the desktop connector.
pub(crate) fn callback(_raw: &str) -> Result<(String, String, String)> {
    Err("Connect the Orka desktop connector in your assistant. Browser plugin login is no longer supported.".into())
}
