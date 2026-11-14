//! Native consent and lifecycle binding for the remote plugin's local tools.
use crate::{
    auth,
    db::{self, Result},
    projects, sync,
};
use fs2::FileExt;
use serde_json::{json, Value};
use std::{
    fs,
    sync::{LazyLock, Mutex},
};
use uuid::Uuid;

pub const RECONNECT: &str =
    "Reconnect the Orka plugin and choose Use account in Orka to use local tools.";
const STATE_FILE: &str = "plugin-connection.json";

fn state_lock() -> Result<fs::File> {
    let root = db::root()?;
    fs::create_dir_all(&root).map_err(|e| e.to_string())?;
    let file = fs::OpenOptions::new()
        .create(true)
        .truncate(false)
        .read(true)
        .write(true)
        .open(root.join("plugin-connection.lock"))
        .map_err(|e| e.to_string())?;
    file.lock_exclusive().map_err(|e| e.to_string())?;
    Ok(file)
}

fn read_state() -> Result<Value> {
    match fs::read(db::root()?.join(STATE_FILE)) {
        Ok(raw) => {
            let state: Value = serde_json::from_slice(&raw).map_err(|_| RECONNECT)?;
            Uuid::parse_str(state["generation"].as_str().ok_or(RECONNECT)?)
                .map_err(|_| RECONNECT)?;
            Ok(state)
        }
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => {
            let state =
                json!({"generation":Uuid::new_v4().to_string(),"reason":null,"approval":null});
            write_state(&state)?;
            Ok(state)
        }
        Err(error) => Err(error.to_string()),
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
    // A damaged plugin cache must not prevent signing out or switching service.
    // Replacing it always invalidates previous proofs.
    let mut state = read_state().unwrap_or_else(|_| json!({"approval":null}));
    state["generation"] = json!(Uuid::new_v4().to_string());
    state["reason"] = json!(reason);
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

#[derive(Clone)]
pub(crate) struct Binding {
    pub(crate) account_id: String,
    pub(crate) service_origin: String,
    pub(crate) device_id: String,
    pub(crate) generation: String,
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
        Ok(())
    }
}

fn unexpired(value: &Value) -> bool {
    value
        .as_str()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .is_some_and(|expires| expires.timestamp() > chrono::Utc::now().timestamp())
}

fn canonical_service(origin: &str) -> Result<String> {
    Ok(db::validate_url(origin)?
        .as_str()
        .trim_end_matches('/')
        .into())
}

fn same_service(value: &Value, origin: &str) -> bool {
    value.as_str().is_some_and(|actual| {
        canonical_service(actual)
            .ok()
            .zip(canonical_service(origin).ok())
            .is_some_and(|(a, b)| a == b)
    })
}

fn check_proof(value: &Value, binding: &Binding, write: bool) -> Result<()> {
    if value["accountId"] != binding.account_id
        || !same_service(&value["serviceOrigin"], &binding.service_origin)
        || value["deviceId"] != binding.device_id
        || value["generation"] != binding.generation
        || Uuid::parse_str(value["connectionId"].as_str().unwrap_or("")).is_err()
        || !unexpired(&value["expiresAt"])
    {
        return Err(RECONNECT.into());
    }
    let scopes = value["scopes"].as_array().ok_or(RECONNECT)?;
    if !scopes.contains(&json!("orka.read")) || write && !scopes.contains(&json!("orka.write")) {
        return Err(if write {
            "Reconnect the Orka plugin with the required read and write access, then approve it in Orka."
        } else {
            "Reconnect the Orka plugin with the required read access, then approve it in Orka."
        }.into());
    }
    Ok(())
}

pub(crate) async fn verify(input: &Value, write: bool) -> Result<Binding> {
    let proof = input["connectionProof"]
        .as_str()
        .filter(|p| !p.is_empty() && p.len() <= 8192)
        .ok_or(RECONNECT)?;
    let binding = Binding::current()?;
    if input["accountId"] != binding.account_id
        || !same_service(&input["serviceOrigin"], &binding.service_origin)
    {
        return Err(RECONNECT.into());
    }
    let verified = sync::api_at(
        &binding.account_id,
        &binding.service_origin,
        "POST",
        "/v2/plugin/connection/verify",
        Some(&json!({"proof":proof,"deviceId":binding.device_id,"generation":binding.generation})),
    )
    .await;
    binding.check_current()?;
    let value = verified.map_err(|error| {
        if error.starts_with("401:")
            || error.starts_with("403:")
            || error.starts_with("404:")
            || error.starts_with("409:")
        {
            RECONNECT.to_string()
        } else if error.starts_with("Sync authentication:") {
            "Sign in to Orka, then reconnect the Orka plugin using Use account in Orka.".into()
        } else {
            "Cannot verify the Orka plugin connection. Try again when the service is available."
                .into()
        }
    })?;
    check_proof(&value, &binding, write)?;
    Ok(binding)
}

#[tauri::command]
pub fn plugin_connection_status() -> Result<Value> {
    let state = {
        let _lock = state_lock()?;
        read_state()?
    };
    let db = db::open()?;
    let user = db::get(&db, "user")?;
    let service = db::get(&db, "config")?["apiUrl"].clone();
    let approval = &state["approval"];
    let linked = user.is_string()
        && approval["account"]["id"] == user
        && approval["serviceOrigin"] == service
        && approval["generation"] == state["generation"]
        && state["generation"] == generation()?;
    let label = if !user.is_string() {
        "signed_out"
    } else if linked {
        "linked"
    } else if approval.is_object() {
        "reconnect_required"
    } else {
        "not_linked"
    };
    let actual_account = if user.is_string() {
        account(&db).unwrap_or_else(|_| json!({"id":user,"email":null,"displayName":null}))
    } else {
        Value::Null
    };
    Ok(
        json!({"state":label,"account":actual_account,"serviceOrigin":service,"client":approval["client"],
        "scopes":approval["scopes"].as_array().cloned().unwrap_or_default(),"connectedAt":approval["connectedAt"],
        "reason":if linked {Value::Null} else if !user.is_string() {json!("Sign in to Orka, then reconnect the plugin.")}
            else if state["reason"].is_string() {state["reason"].clone()} else {json!(RECONNECT)},
        "reconnectRequired":!linked}),
    )
}

pub(crate) fn callback(raw: &str) -> Result<(String, String, String)> {
    if raw.len() > 8192 {
        return Err("Invalid Orka plugin connection link".into());
    }
    let url = reqwest::Url::parse(raw).map_err(|_| "Invalid Orka plugin connection link")?;
    if url.scheme() != "orka"
        || url.host_str() != Some("mcp")
        || url.path() != "/authorize"
        || !url.username().is_empty()
        || url.password().is_some()
        || url.port().is_some()
        || url.fragment().is_some()
    {
        return Err("Invalid Orka plugin connection link".into());
    }
    let mut handoff = None;
    let mut service = None;
    let mut profile = None;
    for (key, value) in url.query_pairs() {
        let target = match key.as_ref() {
            "handoff" => &mut handoff,
            "service" => &mut service,
            "profile" => &mut profile,
            _ => return Err("Invalid Orka plugin connection link".into()),
        };
        if target.replace(value.into_owned()).is_some() {
            return Err("Invalid Orka plugin connection link".into());
        }
    }
    let handoff = handoff.ok_or("Invalid Orka plugin connection link")?;
    if handoff.len() != 43
        || !handoff
            .bytes()
            .all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
    {
        return Err("Invalid Orka plugin connection link".into());
    }
    let service = service.ok_or("Invalid Orka plugin connection link")?;
    db::validate_url(&service)?;
    let profile = profile.unwrap_or_else(|| "default".into());
    crate::profiles::validate(&profile)?;
    Ok((profile, handoff, service))
}

#[derive(Clone)]
struct Pending {
    request_id: String,
    handoff: String,
    binding: Binding,
    preview: Value,
}
static PENDING: LazyLock<Mutex<Option<Pending>>> = LazyLock::new(|| Mutex::new(None));

#[tauri::command]
pub async fn plugin_authorization(operation: String, input: Value) -> Result<Value> {
    let _lock = projects::lock()?;
    if operation == "preview" {
        let (profile, handoff, service) = callback(
            input["callback"]
                .as_str()
                .ok_or("Open the plugin connection link again")?,
        )?;
        if profile != crate::profiles::current() {
            return Err("Open this connection in the Orka window that received it".into());
        }
        let binding = Binding::current()?;
        if canonical_service(&service)? != canonical_service(&binding.service_origin)? {
            return Err("This plugin connection uses a different Orka service. Reconnect the plugin to the service selected in Orka.".into());
        }
        let actual_account = account(&db::open()?)?;
        let value = sync::api_at(
            &binding.account_id,
            &binding.service_origin,
            "GET",
            &format!("/v2/plugin/connection?handoff={handoff}"),
            None,
        )
        .await?;
        binding.check_current()?;
        if value["accountId"] != binding.account_id
            || !same_service(&value["serviceOrigin"], &binding.service_origin)
            || !value["client"]["id"].is_string()
            || !value["client"]["name"].is_string()
            || !value["scopes"].is_array()
            || !value["permissionDescriptions"].is_array()
            || !unexpired(&value["expiresAt"])
            || value["scopes"].as_array().unwrap().iter().any(|scope| {
                ![
                    json!("orka.read"),
                    json!("orka.write"),
                    json!("orka.manage"),
                ]
                .contains(scope)
            })
            || value["permissionDescriptions"]
                .as_array()
                .unwrap()
                .iter()
                .any(|description| !description.is_string())
        {
            return Err("Invalid or expired Orka plugin connection".into());
        }
        let request_id = Uuid::new_v4().to_string();
        let preview = json!({"requestId":request_id,"account":actual_account,"serviceOrigin":binding.service_origin,
            "client":value["client"],"scopes":value["scopes"],"permissionDescriptions":value["permissionDescriptions"],"expiresAt":value["expiresAt"]});
        *PENDING
            .lock()
            .map_err(|_| "Plugin connection unavailable")? = Some(Pending {
            request_id,
            handoff,
            binding,
            preview: preview.clone(),
        });
        return Ok(preview);
    }
    if !matches!(operation.as_str(), "approve" | "cancel") {
        return Err("Unknown plugin connection action".into());
    }
    let pending = PENDING
        .lock()
        .map_err(|_| "Plugin connection unavailable")?
        .clone()
        .ok_or("Open the plugin connection link again")?;
    if input["requestId"] != pending.request_id || !unexpired(&pending.preview["expiresAt"]) {
        return Err(
            "This plugin connection expired. Open a new connection from the plugin.".into(),
        );
    }
    pending.binding.check_current()?;
    if operation == "approve" {
        sync::register_device(
            &pending.binding.account_id,
            &pending.binding.service_origin,
            &pending.binding.device_id,
        )
        .await?;
        pending.binding.check_current()?;
    }
    let result = sync::api_at(&pending.binding.account_id, &pending.binding.service_origin, "POST", "/v2/plugin/connection",
        Some(&json!({"handoff":pending.handoff,"deviceId":pending.binding.device_id,"generation":pending.binding.generation,"action":operation}))).await?;
    pending.binding.check_current()?;
    if operation == "approve" {
        if result["approved"] != true {
            return Err("Invalid Orka plugin approval response".into());
        }
        let _state_lock = state_lock()?;
        let mut state = read_state()?;
        state["approval"] = pending.preview.clone();
        state["approval"]["generation"] = json!(pending.binding.generation);
        state["approval"]["connectedAt"] = json!(db::now());
        state["reason"] = Value::Null;
        write_state(&state)?;
    } else if result["cancelled"] != true {
        return Err("Invalid Orka plugin cancellation response".into());
    }
    *PENDING
        .lock()
        .map_err(|_| "Plugin connection unavailable")? = None;
    Ok(if operation == "approve" {
        json!({"approved":true})
    } else {
        json!({"cancelled":true})
    })
}

#[cfg(test)]
pub(crate) fn validate_proof_for_test(value: &Value, binding: &Binding, write: bool) -> Result<()> {
    check_proof(value, binding, write)
}
