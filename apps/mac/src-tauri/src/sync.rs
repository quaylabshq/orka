use crate::{
    auth,
    db::{self, Result},
    indexer, native, packages,
    sync_queue::{Outcome, Priority, SyncQueue, WORKSPACE},
    sync_schedule::Interval,
};
use fs2::FileExt;
use rusqlite::params;
use serde_json::{json, Value};
use std::{
    collections::HashSet,
    fs,
    ops::ControlFlow::{self, Break, Continue},
    path::{Path, PathBuf},
    time::{Duration, Instant},
};

const PLAN_REVISION_CONFLICT: &str =
    "409: Resource changed; refresh and review the exact version again";
const PLAN_REVIEW_PENDING: &str = "Queued plan upload needs review";

pub async fn api(method: &str, path: &str, body: Option<&Value>) -> Result<Value> {
    let owner = db::get(&db::open()?, "user")?;
    api_as(
        owner.as_str().ok_or("Sign in required")?,
        method,
        path,
        body,
    )
    .await
}
async fn request(owner: &str, method: &str, path: &str) -> Result<reqwest::RequestBuilder> {
    let cfg = db::get(&db::open()?, "config")?;
    let base = cfg["apiUrl"].as_str().ok_or("Configure the service")?;
    request_at(owner, base, method, path).await
}
async fn request_at(
    owner: &str,
    base: &str,
    method: &str,
    path: &str,
) -> Result<reqwest::RequestBuilder> {
    db::validate_url(base)?;
    Ok(reqwest::Client::builder()
        .timeout(Duration::from_secs(30))
        .redirect(reqwest::redirect::Policy::none())
        .build()
        .map_err(|e| e.to_string())?
        .request(
            method
                .parse::<reqwest::Method>()
                .map_err(|e| e.to_string())?,
            format!("{}{}", base.trim_end_matches('/'), path),
        )
        .header("X-Orka-Governance", "1")
        .bearer_auth(
            auth::token_for_service(owner, base)
                .await
                .map_err(|e| format!("Sync authentication: {e}"))?,
        ))
}
pub(crate) async fn api_as(
    owner: &str,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Result<Value> {
    let config = db::get(&db::open()?, "config")?;
    api_at(
        owner,
        config["apiUrl"].as_str().ok_or("Configure the service")?,
        method,
        path,
        body,
    )
    .await
}
pub(crate) async fn api_at(
    owner: &str,
    origin: &str,
    method: &str,
    path: &str,
    body: Option<&Value>,
) -> Result<Value> {
    let mut request = request_at(owner, origin, method, path).await?;
    if let Some(body) = body {
        request = request.json(body);
    }
    let response = request
        .send()
        .await
        .map_err(|_| "Cloud unavailable; local work stays queued")?;
    let status = response.status();
    let value: Value = response.json().await.map_err(|_| {
        format!(
            "{}: Sync service returned an unreadable response",
            status.as_u16()
        )
    })?;
    if !status.is_success() {
        return Err(SyncError::message(
            status.as_u16(),
            &value,
            "Service unavailable",
        ));
    }
    Ok(value)
}

async fn register_device(owner: &str, origin: &str, device: &str) -> Result<Value> {
    let capabilities = api_at(owner, origin, "GET", "/v2/projects/capabilities", None)
        .await
        .unwrap_or(Value::Null);
    let mut registration = crate::device_metadata::registration(device, &capabilities);
    if capabilities["deviceHardware"] == 1 {
        registration["hardwareFamily"] = json!(crate::device_metadata::local_family(&db::open()?)?);
    }
    post_device_registration(owner, origin, registration).await?;
    Ok(capabilities)
}

pub(crate) async fn post_device_registration(
    owner: &str,
    origin: &str,
    registration: Value,
) -> Result<()> {
    send_registration(registration, async |body| {
        api_at(owner, origin, "POST", "/v2/devices", Some(body)).await?;
        Ok(())
    })
    .await
}

async fn send_registration(
    mut registration: Value,
    mut post: impl AsyncFnMut(&Value) -> Result<()>,
) -> Result<()> {
    let Err(error) = post(&registration).await else {
        return Ok(());
    };
    // During a rollout an older replica can reject the privateName field
    // advertised by another replica. Retry the same ID with public metadata.
    if error != "400: Invalid request" {
        return Err(error);
    }
    match registration
        .as_object_mut()
        .and_then(|fields| fields.remove("privateName"))
    {
        Some(_) => post(&registration).await,
        None => Err(error),
    }
}
pub(crate) async fn upload(owner: &str, project: &str, resource: &Value) -> Result<()> {
    use crate::session_redaction::SessionRedactor;

    let session = resource["kind"] == "session";
    if let Some(title) = resource["title"].as_str().filter(|_| session) {
        SessionRedactor::check_upload(title.as_bytes())?;
    }
    let files = resource["files"]
        .as_array()
        .ok_or("Local upload: missing files")?;
    packages::reject_env_files(files).map_err(|e| format!("Local upload: {e}"))?;
    for f in files {
        let hash = f["hash"].as_str().ok_or("Local upload: missing hash")?;
        let bytes = db::blob_read(hash).map_err(|e| format!("Local upload: {e}"))?;
        if session {
            SessionRedactor::check_upload(&bytes)?;
        }
        let response = request(owner, "PUT", &format!("/v2/blobs/{project}/{hash}"))
            .await?
            .body(bytes)
            .send()
            .await
            .map_err(|_| "Blob upload failed; retry retained")?;
        if !response.status().is_success() {
            let status = response.status().as_u16();
            let body = response.json().await.unwrap_or(Value::Null);
            return Err(SyncError::message(status, &body, "Blob upload rejected"));
        }
    }
    Ok(())
}
pub(crate) async fn download(owner: &str, resource: &Value) -> Result<()> {
    if resource["kind"] == "skill" {
        packages::reject_env_files(resource["files"].as_array().ok_or("Missing files")?)?;
    }
    let project = resource["projectId"].as_str().ok_or("Missing project")?;
    for f in resource["files"].as_array().ok_or("Missing files")? {
        let hash = f["hash"].as_str().ok_or("Missing hash")?;
        if db::blob_read(hash).is_ok() {
            continue;
        }
        let response = request(owner, "GET", &format!("/v2/blobs/{project}/{hash}"))
            .await?
            .send()
            .await
            .map_err(|_| "Blob download failed")?;
        if !response.status().is_success() {
            return Err(format!(
                "{}: Blob download rejected",
                response.status().as_u16()
            ));
        }
        let bytes = response.bytes().await.map_err(|e| e.to_string())?;
        if bytes.len() as u64 != f["size"].as_u64().ok_or("Missing size")?
            || db::digest(&bytes) != hash
        {
            return Err("Downloaded blob failed verification".into());
        }
        db::blob(&bytes).map_err(|e| format!("Local download: {e}"))?;
    }
    Ok(())
}
pub fn apply_event(db: &rusqlite::Connection, event: &Value) -> Result<()> {
    let r = &event["resource"];
    let project = r["projectId"].as_str().ok_or("Missing project")?;
    let id = r["resourceId"].as_str().ok_or("Missing resource")?;
    let current = db::rows(db, "SELECT value FROM resources WHERE id=?", &[&id])?
        .into_iter()
        .next();
    if current
        .is_none_or(|c| c["revision"].as_u64().unwrap_or(0) <= r["revision"].as_u64().unwrap_or(0))
    {
        db::upsert(db, "resources", id, project, r)?;
        if r["source"] == "pi" && r["deleted"] == true {
            crate::pi_sessions::detach_copies(db, project, id)?;
        }
        db.execute(
            "DELETE FROM conflicts WHERE project=? AND json_extract(value,'$.resourceId')=?",
            params![project, id],
        )
        .map_err(|e| e.to_string())?;
        for c in event["conflicts"]
            .as_array()
            .ok_or("Missing conflict list")?
        {
            db::upsert(
                db,
                "conflicts",
                c["id"].as_str().ok_or("Missing conflict")?,
                project,
                c,
            )?;
        }
    }
    if let Some(related) = event["related"].as_array() {
        for e in related {
            let e = json!({"resource":e["resource"],"conflicts":e["conflicts"]});
            apply_event(db, &e)?;
        }
    }
    if !event["activity"].is_null() {
        let a = &event["activity"];
        db.execute(
            "INSERT OR IGNORE INTO activity VALUES(?,?)",
            params![a["id"].as_str(), a.to_string()],
        )
        .map_err(|e| e.to_string())?;
    }
    Ok(())
}

fn copy_state_key(id: &str) -> String {
    format!("sessionCopy:{id}")
}

fn outbox_redaction_key(id: &str) -> String {
    format!("sessionOutboxRedaction:{id}")
}

fn copy_source_snapshot(base: &Value) -> Result<Value> {
    if base["kind"] != "session"
        || base["deleted"] == true
        || base["files"].as_array().is_none_or(Vec::is_empty)
    {
        return Err("The cached session snapshot is unavailable; local work was preserved".into());
    }
    let mut snapshot = serde_json::Map::new();
    for field in [
        "resourceId",
        "sourceId",
        "kind",
        "source",
        "logicalPath",
        "title",
        "files",
        "deleted",
        "contextSources",
    ] {
        if let Some(value) = base.get(field).filter(|value| !value.is_null()) {
            snapshot.insert(field.into(), value.clone());
        }
    }
    Ok(Value::Object(snapshot))
}

fn store_session_snapshot(
    db: &rusqlite::Connection,
    source: &Value,
    device: &str,
    negotiate: bool,
) -> Result<Value> {
    let project = source["projectId"].as_str().ok_or("Missing project")?;
    let resource = source["resourceId"].as_str().ok_or("Missing resource")?;
    if source["revision"]
        .as_u64()
        .is_none_or(|revision| revision == 0)
    {
        return Err("The cached session revision is unavailable; local work was preserved".into());
    }
    let id = uuid::Uuid::new_v4().to_string();
    let request = json!({"version":2,"id":id,"projectId":project,"resourceId":resource,"deviceId":device,"expectedRevision":source["revision"],"sourceSnapshot":copy_source_snapshot(source)?});
    indexer::queue(db, project, "/v2/sessions/copy", &request)?;
    // Keep the selected local snapshot even when an older service needs the
    // legacy wire body. It remains the source for a later known-failed retry.
    db::set(
        db,
        &copy_state_key(&id),
        &json!({"source":source,"negotiate":negotiate}),
    )?;
    Ok(request)
}

pub(crate) fn queue_session_snapshot(
    db: &rusqlite::Connection,
    source: &Value,
    device: &str,
) -> Result<Value> {
    let tx = db
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    let request = store_session_snapshot(&tx, source, device, true)?;
    tx.commit().map_err(|error| error.to_string())?;
    Ok(request)
}

pub(crate) fn queue_session_copy(
    db: &rusqlite::Connection,
    binding: &Value,
    device: &str,
) -> Result<Value> {
    let tx = db
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    let request = store_session_snapshot(&tx, &binding["base"], device, true)?;
    let mut binding = binding.clone();
    binding["copyRequest"] = request["id"].clone();
    db::upsert(
        &tx,
        "bindings",
        request["resourceId"].as_str().ok_or("Missing resource")?,
        request["projectId"].as_str().ok_or("Missing project")?,
        &binding,
    )?;
    tx.commit().map_err(|error| error.to_string())?;
    Ok(request)
}

fn selected_resolution_snapshot(db: &rusqlite::Connection, input: &Value) -> Result<Option<Value>> {
    let source = if input["selected"] == "candidate" {
        db::rows(db,"SELECT json_extract(value,'$.candidate') FROM conflicts WHERE id=? AND project=? AND json_extract(value,'$.resourceId')=?",&[&input["conflictId"].as_str(),&input["projectId"].as_str(),&input["resourceId"].as_str()])?
            .into_iter()
            .next()
    } else if input["selected"] == "current" {
        db::rows(db,"SELECT value FROM resources WHERE id=? AND project=? AND json_extract(value,'$.revision')=?",&[&input["resourceId"].as_str(),&input["projectId"].as_str(),&input["expectedRevision"].as_i64()])?
            .into_iter()
            .next()
    } else {
        None
    };
    Ok(source.filter(|source| {
        source["kind"] == "session"
            && source["resourceId"] == input["resourceId"]
            && source["projectId"] == input["projectId"]
    }))
}

/// A resolution's wire body names a version but carries no files. Freeze that
/// selection locally so a later pull or project removal cannot replace it.
pub(crate) fn queue_session_resolution(db: &rusqlite::Connection, input: &Value) -> Result<()> {
    let tx = db
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    let source = selected_resolution_snapshot(&tx, input)?
        .ok_or("The selected session version is unavailable; refresh before resolving")?;
    indexer::queue(
        &tx,
        input["projectId"].as_str().ok_or("Missing project")?,
        "/v2/sessions/resolve",
        input,
    )?;
    db::set(
        &tx,
        &copy_state_key(input["id"].as_str().ok_or("Missing request ID")?),
        &json!({"source":source,"resolution":input}),
    )?;
    tx.commit().map_err(|error| error.to_string())
}

/// Freeze the wire body before its first attempt. A service upgrade must not
/// change the identity of an uncertain legacy request.
pub(crate) fn prepare_session_copy(
    db: &rusqlite::Connection,
    input: &Value,
    latest_only: bool,
) -> Result<Value> {
    let id = input["id"].as_str().ok_or("Missing request ID")?;
    let key = copy_state_key(id);
    let mut state = db::get(db, &key)?;
    if state["negotiate"] != true {
        return Ok(input.clone());
    }
    let mut request = input.clone();
    if !latest_only {
        request
            .as_object_mut()
            .ok_or("Invalid session copy request")?
            .remove("sourceSnapshot");
    }
    let tx = db
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    if tx
        .execute(
            "UPDATE outbox SET value=? WHERE id=? AND value=?",
            params![request.to_string(), id, input.to_string()],
        )
        .map_err(|error| error.to_string())?
        != 1
    {
        return Err("The queued session copy changed; retry was preserved".into());
    }
    state["negotiate"] = json!(false);
    db::set(&tx, &key, &state)?;
    tx.commit().map_err(|error| error.to_string())?;
    Ok(request)
}

/// Return only the selected revision, never a newer cache entry. This also
/// lets permission/source removal preserve an unsent explicit copy as a draft.
pub(crate) fn queued_session_snapshot(
    db: &rusqlite::Connection,
    input: &Value,
) -> Result<Option<Value>> {
    let Some(id) = input["resourceId"].as_str() else {
        return Ok(None);
    };
    let state = match input["id"].as_str() {
        Some(request) => db::get(db, &copy_state_key(request))?,
        None => Value::Null,
    };
    if input["conflictId"].is_string() {
        if state["resolution"] == *input
            && state["source"]["kind"] == "session"
            && state["source"]["resourceId"] == input["resourceId"]
            && state["source"]["projectId"] == input["projectId"]
        {
            return Ok(Some(state["source"].clone()));
        }
        // Old queued resolutions have no frozen local snapshot. A selected
        // current version must still have precisely the observed revision.
        return selected_resolution_snapshot(db, input);
    }
    let mut wire = input["sourceSnapshot"].clone();
    if wire.is_object() {
        wire["projectId"] = input["projectId"].clone();
        wire["revision"] = input["expectedRevision"].clone();
    }
    let binding = indexer::binding(db, id)?;
    let current = db::rows(db, "SELECT value FROM resources WHERE id=?", &[&id])?
        .into_iter()
        .next()
        .unwrap_or(Value::Null);
    for source in [&state["source"], &wire, &binding["base"], &current] {
        if source["kind"] == "session"
            && source["resourceId"] == input["resourceId"]
            && source["projectId"] == input["projectId"]
            && source["revision"] == input["expectedRevision"]
        {
            return Ok(Some(source.clone()));
        }
    }
    Ok(None)
}

pub(crate) fn clear_session_copy(db: &rusqlite::Connection, id: &str) -> Result<()> {
    db.execute(
        "DELETE FROM meta WHERE key IN (?,?)",
        params![copy_state_key(id), outbox_redaction_key(id)],
    )
    .map_err(|error| error.to_string())?;
    Ok(())
}

/// A legacy copy can be replaced only after the service explicitly reports that
/// no outcome exists for its unavailable revision. Its selected snapshot remains
/// durable independently of native bindings and newer remote snapshots.
pub(crate) fn replace_unavailable_session_copy(
    db: &rusqlite::Connection,
    input: &Value,
    device: &str,
) -> Result<bool> {
    if input["sourceSnapshot"].is_object() {
        return Ok(false);
    }
    let Some(source) = queued_session_snapshot(db, input)? else {
        return Ok(false);
    };
    let resource = input["resourceId"].as_str().ok_or("Missing resource")?;
    let mut binding = indexer::binding(db, resource)?;
    let rebind = binding["needsCopy"] == true && binding["copyRequest"] == input["id"];
    if rebind
        && (binding["base"]["resourceId"] != input["resourceId"]
            || binding["base"]["projectId"] != input["projectId"]
            || binding["base"]["revision"] != input["expectedRevision"])
    {
        return Ok(false);
    }
    let tx = db
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    let replacement = store_session_snapshot(&tx, &source, device, false)?;
    if rebind {
        binding["copyRequest"] = replacement["id"].clone();
        db::upsert(
            &tx,
            "bindings",
            resource,
            input["projectId"].as_str().ok_or("Missing project")?,
            &binding,
        )?;
    }
    if tx
        .execute("DELETE FROM outbox WHERE id=?", [input["id"].as_str()])
        .map_err(|error| error.to_string())?
        != 1
    {
        return Err("The queued session copy changed; local work was preserved".into());
    }
    clear_session_copy(&tx, input["id"].as_str().ok_or("Missing request ID")?)?;
    tx.commit().map_err(|error| error.to_string())?;
    Ok(true)
}

/// Stage old snapshots once. Their original request bodies remain frozen until
/// the service acknowledges or cancels their potentially accepted operation.
const OUTBOX_REDACTION_KEY: &str = "sessionOutboxRedactionPrepared";

fn redact_session_snapshot(snapshot: &mut Value) -> Result<()> {
    if snapshot["kind"] != "session" {
        return Ok(());
    }
    if let Some(title) = snapshot["title"].as_str() {
        snapshot["title"] = json!(crate::session_redaction::SessionRedactor::text(title));
    }
    if snapshot["files"]
        .as_array()
        .is_some_and(|files| !files.is_empty())
    {
        snapshot["files"] = json!(crate::history::redacted_files(
            &snapshot["source"],
            &snapshot["files"]
        )?);
    }
    Ok(())
}

/// Prepare redacted replacements without changing an uncertain request's identity.
/// Even a local 422 can follow an earlier accepted request whose response was lost.
pub(crate) fn rebuild_unredacted_outbox(db: &rusqlite::Connection) -> Result<()> {
    rebuild_unredacted_outbox_for(db, None)
}

fn project_redaction_key(project: &str) -> String {
    format!("{OUTBOX_REDACTION_KEY}:{project}")
}

fn rebuild_unredacted_outbox_for(db: &rusqlite::Connection, project: Option<&str>) -> Result<()> {
    if db::get(db, OUTBOX_REDACTION_KEY)? == true {
        return Ok(());
    }
    let key = project.map_or_else(|| OUTBOX_REDACTION_KEY.to_string(), project_redaction_key);
    if db::get(db, &key)? == true {
        return Ok(());
    }
    let tx = db
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    let previously_rebuilt = db::get(&tx, "sessionOutboxRedacted")? == true;
    let rows = db::rows(
        &tx,
        "SELECT json_object('id',id,'project',project,'path',path,'value',json(value),'error',error) FROM outbox WHERE (?1 IS NULL OR project=?1) AND (path='/v2/sessions/copy' OR (path='/v2/sync/push' AND json_extract(value,'$.resource.kind')='session')) ORDER BY rowid",
        &[&project],
    )?;
    for row in rows {
        let project_id = row["project"].as_str().ok_or("Missing project")?;
        // A project job may have completed this migration before the first
        // workspace job. Its later requests already use the current format.
        if project.is_none() && db::get(&tx, &project_redaction_key(project_id))? == true {
            continue;
        }
        let id = row["id"].as_str().ok_or("Missing request ID")?;
        let mut value = row["value"].clone();
        let mut state = db::get(&tx, &copy_state_key(id))?;
        let rebuilt = if row["path"] == "/v2/sessions/copy" {
            (|| {
                let mut source = queued_session_snapshot(&tx, &value)?
                    .ok_or("The selected session snapshot is unavailable")?;
                redact_session_snapshot(&mut source)?;
                value["sourceSnapshot"] = copy_source_snapshot(&source)?;
                state["source"] = source;
                Ok::<_, String>(())
            })()
        } else {
            redact_session_snapshot(&mut value["resource"])
        };
        let replacement = match rebuilt {
            Ok(())
                if previously_rebuilt
                    || value != row["value"]
                    || row["error"] == "409: Retry ID reused with different content" =>
            {
                json!({"value":value,"state":state})
            }
            Ok(()) => continue,
            Err(_) => json!({"drop":true}),
        };
        db::set(&tx, &outbox_redaction_key(id), &replacement)?;
    }
    db::set(&tx, &key, &json!(true))?;
    tx.commit().map_err(|error| error.to_string())?;
    Ok(())
}

/// Called only after the service has fenced the old ID against delayed uploads.
/// UPDATE preserves rowid, so later edits cannot overtake this replacement.
pub(crate) fn replace_redacted_outbox(
    db: &rusqlite::Connection,
    queued: &mut Value,
) -> Result<bool> {
    let id = queued["id"].as_str().ok_or("Missing request ID")?;
    let project = queued["project"].as_str().ok_or("Missing project")?;
    let replacement = db::get(db, &outbox_redaction_key(id))?;
    if !replacement.is_object() {
        return Err("The queued session replacement is unavailable".into());
    }
    let tx = db
        .unchecked_transaction()
        .map_err(|error| error.to_string())?;
    if db::rows(&tx, "SELECT value FROM outbox WHERE id=?", &[&id])?.first()
        != Some(&queued["value"])
    {
        return Err("The queued session changed; retry was preserved".into());
    }
    if replacement["drop"] == true {
        tx.execute("DELETE FROM outbox WHERE id=?", [id])
            .map_err(|error| error.to_string())?;
        let push = queued["path"] == "/v2/sync/push";
        let resource = if push {
            queued["value"]["resource"]["resourceId"].as_str()
        } else {
            queued["value"]["resourceId"].as_str()
        };
        if let Some(resource) = resource {
            let mut binding = indexer::binding(&tx, resource)?;
            let rebind = if push {
                binding["lastSeenHash"].is_string()
            } else {
                binding["copyRequest"] == id
            };
            if rebind {
                if push {
                    // Keep a string so a teammate's session stays on the copy path.
                    binding["lastSeenHash"] = json!("");
                } else {
                    binding["copyRequest"] = Value::Null;
                }
                db::upsert(&tx, "bindings", resource, project, &binding)?;
            }
        }
        clear_session_copy(&tx, id)?;
        tx.commit().map_err(|error| error.to_string())?;
        return Ok(false);
    }
    let new_id = uuid::Uuid::new_v4().to_string();
    let mut value = replacement["value"].clone();
    value["id"] = json!(new_id);
    if tx
        .execute(
            "UPDATE outbox SET id=?,value=?,error=NULL WHERE id=?",
            params![new_id, value.to_string(), id],
        )
        .map_err(|error| error.to_string())?
        != 1
    {
        return Err("The queued session changed; retry was preserved".into());
    }
    if queued["path"] == "/v2/sessions/copy" {
        let mut state = replacement["state"].clone();
        // The reconciliation capability requires exact cached-snapshot copying.
        state["negotiate"] = json!(false);
        db::set(&tx, &copy_state_key(&new_id), &state)?;
        let resource = value["resourceId"]
            .as_str()
            .ok_or("Missing copied resource")?;
        let mut binding = indexer::binding(&tx, resource)?;
        if binding["copyRequest"] == id {
            binding["copyRequest"] = json!(new_id);
            db::upsert(&tx, "bindings", resource, project, &binding)?;
        }
    }
    clear_session_copy(&tx, id)?;
    tx.commit().map_err(|error| error.to_string())?;
    queued["id"] = json!(new_id);
    queued["value"] = value;
    queued["error"] = Value::Null;
    Ok(true)
}

pub(crate) fn acknowledge_session(
    db: &rusqlite::Connection,
    project: &str,
    path: &str,
    input: &Value,
    receipt: &Value,
) -> Result<()> {
    if input["resource"]["kind"] == "session"
        && input["resource"]["deleted"] != true
        && receipt["conflict"] == false
    {
        let id = input["resource"]["resourceId"]
            .as_str()
            .ok_or("Missing resource")?;
        let mut binding = indexer::binding(db, id)?;
        if !binding["nativeId"].is_null() {
            // An original ACK may precede the latest pull. Its uploaded bytes
            // still describe this native binding; never substitute the latest.
            binding["previous"] = binding["base"].clone();
            binding["base"] = receipt["event"]["resource"].clone();
            db::upsert(db, "bindings", id, project, &binding)?;
        }
    }
    if path == "/v2/sessions/copy" || (path == "/v2/sessions/resolve" && input["action"] == "copy")
    {
        let old = input["resourceId"]
            .as_str()
            .ok_or("Missing copied resource")?;
        let mut binding = indexer::binding(db, old)?;
        if (binding["needsCopy"] == true && binding["copyRequest"] == input["id"])
            || input["action"] == "copy"
        {
            let resource = &receipt["event"]["resource"];
            binding["base"] = resource.clone();
            binding["needsCopy"] = json!(false);
            binding["copyRequest"] = Value::Null;
            db.execute("DELETE FROM bindings WHERE id=?", [old])
                .map_err(|error| error.to_string())?;
            db::upsert(
                db,
                "bindings",
                resource["resourceId"].as_str().ok_or("Missing copy")?,
                project,
                &binding,
            )?;
        }
    }
    if matches!(path, "/v2/sessions/copy" | "/v2/sessions/resolve") {
        clear_session_copy(db, input["id"].as_str().ok_or("Missing request ID")?)?;
    }
    Ok(())
}

pub fn live_hash(binding: &Value, kind: &str, root: &Path) -> Result<Vec<String>> {
    let mut hashes = Vec::new();
    for path in binding["paths"].as_array().ok_or("Missing binding paths")? {
        let path = Path::new(path.as_str().ok_or("Invalid native path")?);
        let resolved;
        let path = if kind == "session" && binding["base"]["source"] == "codex" {
            resolved = crate::history::current_path(
                path,
                binding["nativeId"]
                    .as_str()
                    .ok_or("Missing native identity")?,
            )?;
            if resolved.starts_with(native::codex_home()?.join("archived_sessions")) {
                hashes.push(indexer::manifest_hash(&json!([])));
                continue;
            }
            resolved.as_path()
        } else {
            path
        };
        if !path.try_exists().map_err(|e| e.to_string())? {
            hashes.push(indexer::manifest_hash(&json!([])));
            continue;
        }
        let files = if kind == "skill" {
            json!(packages::directory(path)?)
        } else if kind == "session" {
            json!(crate::history::session_files(
                binding["base"]["source"]
                    .as_str()
                    .ok_or("Missing session source")?,
                path,
                Some(root)
            )?)
        } else if kind == "plan" {
            let source = binding["base"]["source"]
                .as_str()
                .ok_or("Missing plan source")?;
            crate::plans::path_base(root, source, path)?;
            json!([crate::plans::file(path)?.0])
        } else {
            json!([packages::file(path, "content.md")?])
        };
        hashes.push(indexer::manifest_hash(&files));
    }
    Ok(hashes)
}
fn project_memory(project: &Value, resource: &Value) -> Result<(PathBuf, PathBuf)> {
    let root = PathBuf::from(project["path"].as_str().ok_or("Connect a folder")?);
    let logical = resource["logicalPath"]
        .as_str()
        .ok_or("Missing logical path")?;
    if project["governed"] == true && !crate::governance::protected(resource) {
        return Ok((
            root.clone(),
            root.join(".orka/memory/resources")
                .join(resource["resourceId"].as_str().ok_or("Missing resource")?)
                .join("content.md"),
        ));
    }
    let path = if resource["source"] == "shared" {
        root.join(packages::safe_relative(
            logical
                .strip_prefix("instructions/")
                .ok_or("Invalid instruction path")?,
        )?)
    } else if resource["source"] == "claude" {
        let memory = indexer::claude_memory_target(&root)?;
        return Ok((
            memory.clone(),
            memory.join(packages::safe_relative(
                logical
                    .strip_prefix("claude/")
                    .ok_or("Invalid memory path")?,
            )?),
        ));
    } else {
        root.join(".orka/memory")
            .join(packages::safe_relative(logical)?)
    };
    Ok((root, path))
}
fn automatic_skill_binding(
    db: &rusqlite::Connection,
    project: &Value,
    resource: &Value,
    mut binding: Value,
) -> Result<Option<Value>> {
    if resource["access"]["mode"] == "hidden" {
        return Err("Skill access denied; local files preserved".into());
    }
    let root = Path::new(project["path"].as_str().ok_or("Connect a folder")?);
    if !root.is_dir()
        || project["folderIdentity"].as_str().is_some_and(|identity| {
            !indexer::folder_identity_matches(root, identity).unwrap_or(false)
        })
    {
        return Err("Connected folder changed or unavailable; reconnect it in Settings".into());
    }
    let name = packages::safe_relative(
        resource["logicalPath"]
            .as_str()
            .ok_or("Missing skill path")?,
    )?;
    if name.components().count() != 1 {
        return Err("Skill must have a single folder name".into());
    }
    let paths = [
        root.join(".agents/skills").join(&name),
        root.join(".claude/skills").join(&name),
    ];
    let canonical_root = root.canonicalize().map_err(|error| error.to_string())?;
    let canonical_paths = [
        canonical_root.join(".agents/skills").join(&name),
        canonical_root.join(".claude/skills").join(&name),
    ];
    if binding["paths"].as_array().is_some_and(|mapped| {
        mapped.iter().any(|value| {
            let Some(path) = value.as_str().map(PathBuf::from) else {
                return true;
            };
            !paths.contains(&path)
                && !canonical_paths.contains(&path)
                && !path
                    .canonicalize()
                    .is_ok_and(|path| canonical_paths.contains(&path))
        })
    }) {
        return Err("Skill binding no longer matches the connected folder".into());
    }
    for folder in [root.join(".agents"), root.join(".claude")] {
        for path in [&folder, &folder.join("skills")] {
            if fs::symlink_metadata(path)
                .is_ok_and(|meta| meta.file_type().is_symlink() || !meta.is_dir())
            {
                return Err(
                    "Skill destination contains a symlink or file; local files preserved".into(),
                );
            }
        }
    }
    let copies = paths
        .iter()
        .map(|path| {
            let files = if path.try_exists().map_err(|error| error.to_string())? {
                packages::directory(path)?
            } else {
                Vec::new()
            };
            Ok((path, json!(files)))
        })
        .collect::<Result<Vec<_>>>()?;
    if crate::skill_reconciliation::kept(&binding, resource, &copies) {
        return Ok(None);
    }
    binding["paths"] = json!(paths);
    let guards: Vec<_> = copies
        .iter()
        .map(|(_, files)| indexer::manifest_hash(files))
        .collect();
    let empty = indexer::manifest_hash(&json!([]));
    let base = indexer::manifest_hash(&binding["base"]["files"]);
    let incoming = indexer::manifest_hash(&resource["files"]);
    if guards
        .iter()
        .any(|hash| hash != &empty && hash != &base && hash != &incoming)
        && !crate::skill_reconciliation::reconcile(db, project, resource, &mut binding, &copies)?
    {
        return Err(crate::skill_reconciliation::LOCAL_EDITS.into());
    }
    binding["reviewedRevision"] = resource["revision"].clone();
    binding["guards"] = json!(guards);
    binding["installationState"] = json!("current");
    Ok(Some(binding))
}

fn guard_unbound_destinations(
    binding: &Value,
    resource: &Value,
    root: &Path,
    paths: &[PathBuf],
) -> Result<()> {
    let unbound: Vec<_> = paths
        .iter()
        .filter(|path| {
            !binding["paths"]
                .as_array()
                .is_some_and(|mapped| mapped.contains(&json!(path)))
        })
        .collect();
    if unbound.is_empty() {
        return Ok(());
    }
    let incoming = indexer::manifest_hash(&resource["files"]);
    let empty = indexer::manifest_hash(&json!([]));
    let current = live_hash(
        &json!({"paths":unbound,"base":resource}),
        resource["kind"].as_str().ok_or("Missing kind")?,
        root,
    )?;
    if current
        .iter()
        .any(|hash| hash != &empty && hash != &incoming)
    {
        return Err("Unindexed local files preserved; incoming version staged. Review or index the local files in Orka before applying this update.".into());
    }
    Ok(())
}

fn check_claude_memory_claim(
    db: &rusqlite::Connection,
    project_id: &str,
    id: &str,
    path: &Path,
) -> Result<()> {
    let claimed: bool = db.query_row(
        "SELECT EXISTS(SELECT 1 FROM bindings, json_each(bindings.value,'$.paths') AS paths WHERE bindings.project=?1 AND bindings.id<>?2 AND paths.value=?3 AND coalesce(json_extract(bindings.value,'$.base.deleted'),0)=0)",
        params![project_id, id, path.to_str().ok_or("Invalid memory path")?],
        |row| row.get(0),
    ).map_err(|e| e.to_string())?;
    if claimed {
        return Err(
            "Claude memory path belongs to another synced item; local file preserved".into(),
        );
    }
    Ok(())
}

pub fn materialize(db: &rusqlite::Connection, project: &Value, resource: &Value) -> Result<()> {
    materialize_install(db, project, resource, false)
}

pub(crate) fn materialize_reviewed(
    db: &rusqlite::Connection,
    project: &Value,
    resource: &Value,
) -> Result<()> {
    materialize_install(db, project, resource, true)
}

fn materialize_install(
    db: &rusqlite::Connection,
    project: &Value,
    resource: &Value,
    reviewed: bool,
) -> Result<()> {
    let scoped;
    let project = if project["sources"].is_array() && !project["sourceId"].is_string() {
        let Some(source) = crate::sources::for_resource(project, resource) else {
            return Ok(());
        };
        scoped = source;
        &scoped
    } else {
        project
    };
    if !crate::sources::matches(project, resource) {
        return Err("Resource belongs to another repository".into());
    }
    crate::sources::validate(project)?;
    if !crate::projects::sharing_allowed(project, resource["kind"].as_str().unwrap_or("")) {
        return Ok(());
    }
    let id = resource["resourceId"].as_str().ok_or("Missing resource")?;
    let project_id = project["id"].as_str().ok_or("Missing project")?;
    if resource["kind"] == "skill" && !db::get(db, &format!("installation:{id}"))?.is_null() {
        return Err("Skill installation recovery pending; local copies preserved".into());
    }
    let mut b = crate::repair::binding(db, resource, indexer::binding(db, id)?)?;
    if resource["kind"] == "skill" && b["mirrorReview"] == true {
        return Err(indexer::SKILL_MIRROR_REVIEW.into());
    }
    if project["governed"] == true
        && resource["kind"] == "skill"
        && resource["revision"].as_u64().unwrap_or(0) > 0
        && b["reviewedRevision"] != resource["revision"]
    {
        let Some(binding) = automatic_skill_binding(db, project, resource, b)? else {
            return Ok(());
        };
        b = binding;
    }
    if project["governed"] == true
        && crate::governance::protected(resource)
        && b["reviewedRevision"] != resource["revision"]
    {
        if let Some(current) = crate::attention::matching_instruction(db, project, resource, &b)? {
            return db::upsert(db, "bindings", id, project_id, &current);
        }
        b["availableRevision"] = resource["revision"].clone();
        b["installationState"] = json!(if b["base"]["revision"].is_null() {
            "review_pending"
        } else {
            "update_available"
        });
        return db::upsert(
            db,
            "bindings",
            id,
            project["id"].as_str().ok_or("Missing project")?,
            &b,
        );
    }
    if project["governed"] == true
        && resource["kind"] == "memory"
        && !crate::governance::protected(resource)
    {
        // Native learned memory belongs to this user. Shared imports have their own destinations.
        let destination = project_memory(project, resource)?.1;
        if b["paths"][0].as_str() != destination.to_str() {
            b["paths"] = Value::Null;
            b["writeGuard"] = Value::Null;
            b["guards"] = Value::Null;
            b["base"]["revision"] = json!(0);
        }
    }

    let kind = resource["kind"].as_str().ok_or("Missing kind")?;
    if kind == "plan" {
        crate::plans::validate(resource)?;
    }
    if kind == "skill" {
        packages::reject_env_files(resource["files"].as_array().ok_or("Missing files")?)?;
        if let Some(paths) = b["paths"].as_array() {
            for path in paths {
                let path = Path::new(path.as_str().ok_or("Invalid skill path")?);
                if path.exists() {
                    packages::check_skill_directory(path)?;
                }
            }
        }
    }
    if b["base"]["revision"] == resource["revision"]
        && b["base"]["deleted"] == resource["deleted"]
        && !(reviewed && kind == "skill")
    {
        if kind == "skill" {
            crate::codex_skills::queue(db, project, false)?;
        }
        return db::upsert(db, "bindings", id, project_id, &b);
    }
    let pending:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM outbox WHERE json_extract(value,'$.resource.resourceId')=? OR json_extract(value,'$.resourceId')=?)",params![id,id],|r|r.get(0)).map_err(|e|e.to_string())?;
    if kind == "plan" && pending && plan_upload_needs_review(db, project_id, id)? {
        return Err(PLAN_REVIEW_PENDING.into());
    }
    if pending || b["needsCopy"] == true {
        return Err("Local changes are queued; incoming version staged".into());
    }
    let has_conflict: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM conflicts WHERE json_extract(value,'$.resourceId')=?)",
            [id],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    if has_conflict {
        return Err("Session conflict: choose Keep, Override, or Create copy".into());
    }
    if crate::repair::deletion_complete(resource, &b)? {
        return crate::repair::settle_deletion(db, project, resource, b);
    }
    if kind == "session"
        && matches!(resource["source"].as_str(), Some("codex" | "pi"))
        && resource["deleted"] != true
    {
        // Sync keeps snapshots in Orka. Only an explicit launch creates native history.
        if b["nativeId"].is_string() {
            b["availableRevision"] = resource["revision"].clone();
        } else {
            if resource["source"] == "pi" {
                crate::history::resource_records(resource)?;
            } else {
                crate::history::History::resource(resource)?;
            }
            b["previous"] = b["base"].clone();
            b["base"] = resource.clone();
            b["paths"] = json!([]);
            b["guards"] = json!([]);
            b["managed"] = json!(true);
            b["installationState"] = json!("current");
            b["lastSeenHash"] = json!(indexer::manifest_hash(&resource["files"]));
            b["writeGuard"] = b["lastSeenHash"].clone();
        }
        return db::upsert(db, "bindings", id, project_id, &b);
    }
    if kind == "session" {
        if let Some(n) = b["nativeId"].as_str() {
            if native::active(db, n, resource["source"].as_str().ok_or("Missing tool")?) {
                return Err("Open session: incoming version staged".into());
            }
        }
    }
    if b["paths"].is_array() && !(kind == "memory" && resource["source"] == "codex") {
        let expected = b["writeGuard"].as_str().unwrap_or("");
        let base = indexer::manifest_hash(&b["base"]["files"]);
        if live_hash(
            &b,
            kind,
            Path::new(project["path"].as_str().ok_or("Connect a folder")?),
        )?
        .iter()
        .enumerate()
        .any(|(i, h)| h != b["guards"][i].as_str().unwrap_or(expected) && h != &base)
        {
            return Err("Files changed during sync; incoming version staged".into());
        }
    }
    let root = PathBuf::from(project["path"].as_str().ok_or("Connect a folder")?);
    if !root.is_dir() {
        return Err("Connected folder unavailable".into());
    }
    let previous = b["base"].clone();
    if resource["deleted"] == true {
        if kind == "skill" && project["governed"] == true {
            let paths = b["paths"]
                .as_array()
                .cloned()
                .unwrap_or_default()
                .iter()
                .map(|p| {
                    p.as_str()
                        .map(PathBuf::from)
                        .ok_or("Invalid path".to_string())
                })
                .collect::<Result<Vec<_>>>()?;
            packages::install_mirrors(db, project, id, &paths, &[])?;
            for path in paths {
                fs::remove_dir(path).map_err(|e| e.to_string())?;
            }
        } else if kind == "session" && resource["source"] == "codex" {
            if let Some(n) = b["nativeId"].as_str() {
                native::Rpc::connect()?.call("thread/archive", json!({"threadId":n}))?;
            }
        } else if kind == "memory" && resource["source"] == "claude" {
            for path in b["paths"].as_array().into_iter().flatten() {
                let path = Path::new(path.as_str().ok_or("Invalid memory path")?);
                let (base, expected) =
                    if project["governed"] == true && !crate::governance::protected(resource) {
                        project_memory(project, resource)?
                    } else {
                        let base = indexer::claude_memory_base(&root, path)?;
                        let relative = resource["logicalPath"]
                            .as_str()
                            .and_then(|p| p.strip_prefix("claude/"))
                            .ok_or("Invalid Claude memory path")?;
                        let expected = base.join(packages::safe_relative(relative)?);
                        (base, expected)
                    };
                if path != expected {
                    return Err("Unexpected Claude memory deletion path".into());
                }
                check_claude_memory_claim(db, project_id, id, path)?;
                match fs::symlink_metadata(path) {
                    Ok(meta) if meta.is_file() => {
                        packages::safe_directory(&base, path.parent().ok_or("Missing parent")?)?;
                        fs::remove_file(path).map_err(|e| e.to_string())?;
                    }
                    Ok(_) => return Err("Claude memory deletion requires a regular file".into()),
                    Err(e) if e.kind() == std::io::ErrorKind::NotFound => (),
                    Err(e) => return Err(e.to_string()),
                }
            }
        } else if let Some(paths) = b["paths"].as_array() {
            for p in paths {
                let p = Path::new(p.as_str().ok_or("Invalid path")?);
                let base = if kind == "plan" {
                    crate::plans::path_base(
                        &root,
                        resource["source"].as_str().ok_or("Missing plan source")?,
                        p,
                    )?
                } else if p.starts_with(&root) {
                    root.clone()
                } else {
                    native::claude_home()?
                };
                packages::safe_directory(&base, p.parent().ok_or("Missing parent")?)?;
                if fs::symlink_metadata(p).is_ok_and(|m| m.file_type().is_symlink()) {
                    return Err("Deletion target is a symlink".into());
                }
                if p.is_dir() {
                    fs::remove_dir_all(p).map_err(|e| e.to_string())?;
                } else if p.exists() {
                    fs::remove_file(p).map_err(|e| e.to_string())?;
                }
            }
        }
        b["base"] = resource.clone();
        b["lastSeenHash"] = json!(indexer::manifest_hash(&json!([])));
        b["writeGuard"] = b["lastSeenHash"].clone();
    } else if kind == "session" {
        b = native::materialize(db, project, resource, &b)?;
        let live = live_hash(
            &b,
            kind,
            Path::new(project["path"].as_str().ok_or("Connect a folder")?),
        )?;
        b["lastSeenHash"] = if resource["source"] == "codex" && crate::repair::archived(&b)? {
            json!(indexer::manifest_hash(&json!(
                crate::history::session_files(
                    "codex",
                    Path::new(b["paths"][0].as_str().ok_or("Missing import path")?),
                    Some(&root)
                )?
            )))
        } else {
            json!(live.first())
        };
        b["writeGuard"] = b["lastSeenHash"].clone();
    } else {
        let files = resource["files"].as_array().ok_or("Missing files")?;
        let paths = if kind == "skill" {
            let name =
                packages::safe_relative(resource["logicalPath"].as_str().ok_or("Missing path")?)?;
            if name.components().count() != 1 {
                return Err("Skill must have a single folder name".into());
            }
            let paths = vec![
                root.join(".agents/skills").join(&name),
                root.join(".claude/skills").join(&name),
            ];
            guard_unbound_destinations(&b, resource, &root, &paths)?;
            packages::install_mirrors(db, project, id, &paths, files)?;
            paths
        } else if kind == "plan" {
            let path = b["paths"][0]
                .as_str()
                .map(PathBuf::from)
                .unwrap_or(crate::plans::destination(&root, resource)?);
            let base = crate::plans::path_base(
                &root,
                resource["source"].as_str().ok_or("Missing plan source")?,
                &path,
            )?;
            guard_unbound_destinations(&b, resource, &root, std::slice::from_ref(&path))?;
            let accepted_file = files.first().ok_or("Missing plan file")?;
            if !crate::plans::file(&path).is_ok_and(|(local_file, _)| &local_file == accepted_file)
            {
                fs::create_dir_all(&base).map_err(|e| e.to_string())?;
                packages::write_file(&base, &path, accepted_file)?;
            }
            vec![path]
        } else {
            let (base, path) = if project["governed"] != true
                && b["paths"].is_array()
                && resource["source"] == "claude"
            {
                let path = PathBuf::from(b["paths"][0].as_str().ok_or("Invalid memory path")?);
                let base = indexer::claude_memory_base(&root, &path)?;
                let relative = resource["logicalPath"]
                    .as_str()
                    .and_then(|p| p.strip_prefix("claude/"))
                    .ok_or("Invalid Claude memory path")?;
                if path != base.join(packages::safe_relative(relative)?) {
                    return Err("Unexpected Claude memory write path".into());
                }
                (base, path)
            } else {
                project_memory(project, resource)?
            };
            if resource["source"] == "claude" {
                check_claude_memory_claim(db, project_id, id, &path)?;
            }
            guard_unbound_destinations(&b, resource, &root, std::slice::from_ref(&path))?;
            fs::create_dir_all(&base).map_err(|e| e.to_string())?;
            packages::write_file(&base, &path, files.first().ok_or("Missing memory file")?)?;
            vec![path]
        };
        b["paths"] = json!(paths);
        b["base"] = resource.clone();
        b["writeGuard"] = json!(indexer::manifest_hash(&resource["files"]));
        if kind == "plan" || resource["source"] != "codex" || b["lastSeenHash"].is_null() {
            b["lastSeenHash"] = b["writeGuard"].clone();
        }
    }
    b["previous"] = previous;
    b["managed"] = json!(true);
    b["installationState"] = json!("current");
    if kind == "skill" {
        b["skillReviewFingerprint"] = Value::Null;
        b["keptLocalSkill"] = Value::Null;
        crate::codex_skills::queue(db, project, true)?;
    }
    b["guards"] = json!(live_hash(
        &b,
        kind,
        Path::new(project["path"].as_str().ok_or("Connect a folder")?)
    )?);
    db::upsert(db, "bindings", id, project_id, &b)?;
    if kind == "session" && resource["source"] == "codex" {
        if let Some(native_id) = b["nativeId"].as_str() {
            crate::codex_import::finish(db, native_id)?;
        }
    }
    Ok(())
}
pub(crate) fn progress(
    db: &rusqlite::Connection,
    label: &str,
    detail: Option<&str>,
    completed: usize,
    total: Option<usize>,
) -> Result<()> {
    let mut value = json!({"label":label,"detail":detail,"completed":completed,"total":total});
    if let Some(project) = SyncQueue::progress_project(db)? {
        value["projectId"] = json!(project);
    }
    db::set(db, "syncProgress", &value)
}

pub struct Summary {
    pub status: Value,
    pub progress: Value,
    pub project_count: usize,
    pub pending: u64,
    pub issues: u64,
}
impl Summary {
    pub fn read(db: &rusqlite::Connection, running: bool) -> Result<Self> {
        let projects = db::rows(
            db,
            &format!(
                "SELECT json_object('pending',(SELECT count(*) FROM outbox WHERE project=p.id),\
                 'issues',(SELECT count(*) FROM outbox WHERE project=p.id AND error IS NOT NULL)+(SELECT count(*) FROM conflicts WHERE project=p.id)+(SELECT count(*) FROM errors WHERE source=p.id OR substr(source,1,length(p.id)+1)=p.id||':' OR source IN (SELECT id FROM resources WHERE project=p.id)))\
                 FROM projects p WHERE {} AND json_extract(p.value,'$.removedAt') IS NULL AND CASE WHEN json_type(p.value,'$.sources')='array' THEN EXISTS(SELECT 1 FROM json_each(p.value,'$.sources') WHERE json_extract(json_each.value,'$.removedAt') IS NULL AND coalesce(json_extract(json_each.value,'$.path'),'')<>'') ELSE coalesce(json_extract(p.value,'$.path'),'')<>'' END",
                crate::projects::ACTIVE
            ),
            &[],
        )?;
        let pending = projects
            .iter()
            .filter_map(|project| project["pending"].as_u64())
            .sum();
        let project_issues: u64 = projects
            .iter()
            .filter_map(|project| project["issues"].as_u64())
            .sum();
        let account_issues: u64 = db
            .query_row(
                "SELECT count(*) FROM errors WHERE source LIKE 'history:unattributed:%'",
                [],
                |row| row.get::<_, i64>(0).map(|count| count as u64),
            )
            .map_err(|error| error.to_string())?;
        let status = db::get(db, "sync")?;
        let issues = (project_issues + account_issues).max(u64::from(
            status["error"]
                .as_str()
                .is_some_and(|error| !error.is_empty()),
        ));
        Ok(Self {
            status,
            progress: current_progress(db, running)?,
            project_count: projects.len(),
            pending,
            issues,
        })
    }
}

pub fn current_progress(db: &rusqlite::Connection, running: bool) -> Result<Value> {
    if !running || !db::get(db, "user")?.is_string() {
        return Ok(Value::Null);
    }
    let current = db::get(db, "syncProgress")?;
    if !current.is_null() {
        return Ok(current);
    }
    let request = db::get(db, "syncRequest")?;
    if request.is_string() && request != db::get(db, "syncHandledRequest")? {
        return Ok(json!({"label":"Waiting for sync to start…"}));
    }
    Ok(Value::Null)
}

async fn pull(owner: &str, db: &mut rusqlite::Connection, project: &str, name: &str) -> Result<()> {
    let mut downloaded = 0;
    loop {
        progress(
            db,
            "Downloading updates",
            Some(&format!("{name} · {downloaded} updates received")),
            downloaded,
            None,
        )?;
        let cursor = db
            .query_row(
                "SELECT cursor FROM cursors WHERE project=?",
                [project],
                |r| r.get::<_, i64>(0),
            )
            .unwrap_or(0);
        let response = api_as(
            owner,
            "GET",
            &format!(
                "/v2/sync/pull?projectId={project}&cursor={cursor}&governance=1&policyRevision={}",
                db::get(db, &format!("policyRevision:{project}"))?
                    .as_i64()
                    .unwrap_or(-1)
            ),
            None,
        )
        .await?;
        if response["reset"] == true {
            // Drafts must commit before files are removed. Retain the cursor and
            // epoch until events commit, so interruption retries the refresh.
            crate::governance::reset(db, project, &response["events"])?;
        }
        // Persist the feed before fetching bytes. Each resource remains a durable
        // download retry even after the feed cursor advances past a missing blob.
        downloaded += response["events"]
            .as_array()
            .ok_or("Invalid event feed")?
            .len();
        let tx = db.transaction().map_err(|e| e.to_string())?;
        db::set(
            &tx,
            &format!("policyRevision:{project}"),
            &response["policyRevision"],
        )?;
        let requests = response
            .get("requests")
            .filter(|requests| !requests.is_null())
            .cloned()
            .unwrap_or_else(|| json!([]));
        db::set(&tx, &format!("requests:{project}"), &requests)?;
        crate::governance::reconcile_requests(&tx, project, &requests)?;
        for e in response["events"].as_array().ok_or("Invalid events")? {
            apply_event(&tx, e)?;
        }
        tx.execute("INSERT INTO cursors VALUES(?,?) ON CONFLICT(project) DO UPDATE SET cursor=excluded.cursor",params![project,response["cursor"].as_i64()]).map_err(|e|e.to_string())?;
        db::set(&tx, &format!("presence:{project}"), &response["presence"])?;
        tx.commit().map_err(|e| e.to_string())?;
        if response["hasMore"] != true {
            break;
        }
    }
    Ok(())
}
pub async fn once() -> Result<()> {
    cycle().await.map(|_| ())
}
pub(crate) async fn onboarding_once(scope: Option<(&str, &str)>) -> Result<()> {
    // The current onboarding job already owns its retry lock.
    match workspace_cycle(Ok(()), scope, None, None).await? {
        WorkspaceSync::Complete(_) => Ok(()),
        WorkspaceSync::Yielded => Err("A sync or project operation is in progress".into()),
    }
}

enum WorkspaceSync {
    Complete(bool),
    Yielded,
}

// Item failures retain retry backoff without reporting a connectivity failure.
async fn cycle() -> Result<bool> {
    let preparation = crate::onboarding::resume_pending_connections().await;
    // Only a service-wide failure should prevent unrelated projects from syncing.
    workspace_cycle(
        preparation.or_else(|error| {
            if service_error(&error) {
                Err(error)
            } else {
                Ok(())
            }
        }),
        None,
        None,
        None,
    )
    .await
    .map(|outcome| match outcome {
        WorkspaceSync::Complete(deferred) => deferred,
        WorkspaceSync::Yielded => true,
    })
}
struct SyncSlot {
    _file: fs::File,
}

impl SyncSlot {
    async fn acquire(base: &Path) -> Result<Self> {
        fs::create_dir_all(base).map_err(|e| e.to_string())?;
        let file = fs::OpenOptions::new()
            .write(true)
            .create(true)
            .truncate(false)
            .open(base.join("sync-slot.lock"))
            .map_err(|e| e.to_string())?;
        loop {
            match FileExt::try_lock_exclusive(&file) {
                Ok(()) => return Ok(Self { _file: file }),
                Err(e) if e.kind() == std::io::ErrorKind::WouldBlock => {
                    tokio::time::sleep(Duration::from_millis(250)).await;
                }
                Err(e) => return Err(e.to_string()),
            }
        }
    }
}

async fn workspace_cycle(
    preparation: Result<()>,
    scope: Option<(&str, &str)>,
    project_filter: Option<&str>,
    connection: Option<&crate::plugin_connection::Binding>,
) -> Result<WorkspaceSync> {
    let _slot = SyncSlot::acquire(&db::base_root()?).await?;
    let _lock = crate::projects::lock()?;
    if let Some(connection) = connection {
        connection.check_current()?;
    }
    let mut db = db::open()?;
    SyncQueue::clear_progress_scope(&db)?;
    let user = db::get(&db, "user")?;
    let owner = user.as_str().ok_or("Sign in required")?.to_string();
    if let Some((expected, service)) = scope {
        if owner != expected || db::get(&db, "config")?["apiUrl"] != service {
            return Err("Account or service changed. Reopen onboarding.".into());
        }
    }
    if let Some(project) = project_filter {
        crate::projects::active(&db, project)?;
    }
    if project_filter.is_none() {
        db::set(&db, "syncHandledRequest", &db::get(&db, "syncRequest")?)?;
        let _ = crate::account_profile::flush_pending().await;
    }
    progress(&db, "Preparing sync", None, 0, None)?;
    let result = match preparation {
        Ok(()) => sync_workspace(&mut db, &owner, project_filter).await,
        Err(error) => Err(error),
    };
    let status_key = project_filter
        .map(|id| format!("plugin-sync:{id}"))
        .unwrap_or_else(|| "sync".into());
    let previous = db::get(&db, &status_key)?;
    let status = match &result {
        Ok(WorkspaceSync::Complete(_)) => {
            json!({"online":true,"lastSync":db::now(),"updatedAt":db::now()})
        }
        Ok(WorkspaceSync::Yielded) => previous.clone(),
        Err(error) => {
            json!({"online":false,"lastSync":previous["lastSync"],"error":error,"updatedAt":db::now()})
        }
    };
    let tx = db.transaction().map_err(|e| e.to_string())?;
    db::set(&tx, &status_key, &status)?;
    db::set(&tx, "syncProgress", &Value::Null)?;
    tx.commit().map_err(|e| e.to_string())?;
    if project_filter.is_none() && !matches!(&result, Ok(WorkspaceSync::Yielded)) {
        let _ = crate::onboarding::reconcile_workspace_sync(
            &db,
            result.as_ref().err().map(String::as_str),
        );
    }
    result
}

pub(crate) async fn plugin_once(owner: &str, origin: &str, project: &str) -> Result<()> {
    plugin_once_bound(owner, origin, project, None).await
}

pub(crate) async fn plugin_once_bound(
    owner: &str,
    origin: &str,
    project: &str,
    binding: Option<&crate::plugin_connection::Binding>,
) -> Result<()> {
    match workspace_cycle(Ok(()), Some((owner, origin)), Some(project), binding).await? {
        WorkspaceSync::Complete(_) => Ok(()),
        WorkspaceSync::Yielded => {
            Err("A foreground project operation is in progress; retry retained".into())
        }
    }
}

/// A project retry can settle its old connection error without claiming an account-wide sync.
pub(crate) fn settle_retry_error(
    db: &rusqlite::Connection,
    owner: &str,
    origin: &str,
    previous: &Value,
    retried_errors: &[String],
) -> Result<bool> {
    let Some(error) = previous["error"].as_str() else {
        return Ok(false);
    };
    if !retried_errors.iter().any(|retried| retried == error)
        || db::get(db, "user")? != owner
        || db::get(db, "config")?["apiUrl"] != origin
    {
        return Ok(false);
    }
    let mut current = previous.clone();
    current["online"] = json!(true);
    current
        .as_object_mut()
        .ok_or("Invalid sync status")?
        .remove("error");
    db.execute(
        "UPDATE meta SET value=?1 WHERE key='sync' AND value=?2",
        params![current.to_string(), previous.to_string()],
    )
    .map(|changed| changed > 0)
    .map_err(|error| error.to_string())
}

fn preflight_project(db: &rusqlite::Connection, project: &Value, retry_only: bool) -> Result<()> {
    if !retry_only {
        let mut discovery = project.clone();
        discovery["deferAutomaticSharing"] = json!(true);
        return indexer::scan_with_progress(db, &discovery);
    }
    let mut failures = Vec::new();
    for source in crate::sources::views(project) {
        if source["path"].is_null() {
            continue;
        }
        let checked = crate::sources::validate(&source);
        if let Err(error) = &checked {
            failures.push(error.clone());
        }
        record_result(
            db,
            &format!(
                "{}:source:{}",
                project["id"].as_str().unwrap_or(""),
                source["sourceId"].as_str().unwrap_or("default")
            ),
            checked,
        )?;
    }
    if !project["sources"].is_array() && !failures.is_empty() {
        return Err(failures.join("; "));
    }
    Ok(())
}

fn scan_off_runtime<T: Send + 'static>(
    db: &rusqlite::Connection,
    project: &Value,
    scan: impl FnOnce(&rusqlite::Connection, &Value) -> Result<T> + Send + 'static,
) -> impl std::future::Future<Output = Result<T>> + Send + 'static {
    let root = db
        .path()
        .and_then(|path| Path::new(path).parent())
        .filter(|root| !root.as_os_str().is_empty());
    let work = if let Some(root) = root {
        // Use the job's database, not whichever account is current when the worker starts.
        let (root, project) = (root.to_path_buf(), project.clone());
        Ok(tokio::task::spawn_blocking(move || {
            scan(&db::open_at(&root)?, &project)
        }))
    } else {
        Err(scan(db, project))
    };
    async move {
        match work {
            Ok(worker) => worker.await.map_err(|e| e.to_string())?,
            Err(result) => result,
        }
    }
}

/// Each sync stage either carries on or breaks so the cycle yields the
/// workspace lock to a waiting foreground operation.
type Stage = Result<ControlFlow<()>>;

/// A stage boundary. A cancelled project's job stops here, between requests and
/// transactions, so nothing is cut in half and nothing already sent is undone.
fn boundary(db: &rusqlite::Connection, project: &str) -> Stage {
    Ok(if SyncQueue::cancelled(db, project)? {
        Break(())
    } else {
        Continue(())
    })
}

/// How much a project's sync does. A plugin retry only resends what is already
/// queued: it validates sources without scanning and prepares no new sharing.
#[derive(Clone, Copy, PartialEq, Eq)]
enum ProjectMode {
    Full,
    RetryOnly,
}

/// One sync cycle. `sync_workspace_global` holds the workspace-wide stages and
/// `sync_project` one project's stages. A whole-workspace cycle interleaves the
/// same stages stage by stage across projects, in `sync_workspace`.
struct SyncPass<'a> {
    db: &'a mut rusqlite::Connection,
    owner: &'a str,
    project_filter: Option<&'a str>,
    mode: ProjectMode,
    device: Option<String>,
    blocked: HashSet<String>,
    held: HashSet<String>,
    deferred: HashSet<Value>,
}

impl<'a> SyncPass<'a> {
    fn new(
        db: &'a mut rusqlite::Connection,
        owner: &'a str,
        project_filter: Option<&'a str>,
    ) -> Self {
        Self {
            db,
            owner,
            project_filter,
            mode: if project_filter.is_some() {
                ProjectMode::RetryOnly
            } else {
                ProjectMode::Full
            },
            device: None,
            blocked: HashSet::new(),
            held: HashSet::new(),
            deferred: HashSet::new(),
        }
    }

    fn device(&mut self) -> Result<String> {
        if self.device.is_none() {
            self.device = Some(db::device(self.db)?);
        }
        Ok(self.device.clone().unwrap_or_default())
    }

    async fn sync_workspace_global(&mut self) -> Stage {
        if self.prepare().await?.is_break() || self.connect().await?.is_break() {
            return Ok(Break(()));
        }
        self.finish().await.map(Continue)
    }

    async fn sync_project(&mut self, project: &Value) -> Stage {
        let (p, waiting) = sync_ready_view(self.db, project)?;
        let p = &p;
        let project = p["id"].as_str().ok_or("Missing project")?;
        if boundary(self.db, project)?.is_break()
            || self.prepare_project(p)?.is_break()
            || boundary(self.db, project)?.is_break()
            || self.preflight(p, waiting).await?.is_break()
            || boundary(self.db, project)?.is_break()
        {
            return Ok(Break(()));
        }
        // Include continuations discovered by this scan in the same project job.
        self.prepare_copies(Some(project))?;
        if boundary(self.db, project)?.is_break()
            || self.authorize(p).await?.is_break()
            || boundary(self.db, project)?.is_break()
            || self.drain_outbox(p).await?.is_break()
            || self.pull_project(p).await?.is_break()
            || boundary(self.db, project)?.is_break()
        {
            return Ok(Break(()));
        }
        crate::codex_skills::retry_project(self.db, project)?;
        Ok(Continue(()))
    }

    fn prepare_project(&mut self, project: &Value) -> Stage {
        if crate::projects::foreground_waiting()? {
            return Ok(Break(()));
        }
        let (view, _) = crate::sources::without_waiting(self.db, project)?;
        prepare_local(self.db, &view)?;
        Ok(Continue(()))
    }

    /// A deleted project that can still be restored: repair and scan its local
    /// files into the outbox, with no authorization, upload, pull or other
    /// request. Governed edits become drafts whose automatic sharing waits for
    /// a restore.
    async fn capture_project(&mut self, p: &Value) -> Stage {
        let project = p["id"].as_str().ok_or("Missing project")?;
        if boundary(self.db, project)?.is_break() || self.prepare_project(p)?.is_break() {
            return Ok(Break(()));
        }
        if crate::projects::foreground_waiting()? || boundary(self.db, project)?.is_break() {
            return Ok(Break(()));
        }
        match scan_off_runtime(self.db, p, scan_held).await {
            Ok(_) => {
                self.db
                    .execute("DELETE FROM errors WHERE source=?", [project])
                    .map_err(|e| e.to_string())?;
            }
            Err(error) => {
                self.db.execute("INSERT INTO errors VALUES(?,?) ON CONFLICT(source) DO UPDATE SET error=excluded.error",params![project,error]).map_err(|e|e.to_string())?;
            }
        }
        boundary(self.db, project)
    }

    /// Repairs local state and queues pending session copies before any project syncs.
    async fn prepare(&mut self) -> Stage {
        let project_filter = self.project_filter;
        let db = &mut *self.db;
        if crate::projects::foreground_waiting()? {
            return Ok(Break(()));
        }
        if let Some(id) = project_filter {
            let project = crate::governance::project(db, id)?;
            crate::governance::block_legacy_retry(db, &project)?;
            if self.prepare_project(&project)?.is_break() {
                return Ok(Break(()));
            }
        } else {
            crate::repair::workspace(db)?;
            packages::recover_installations(db)?;
            rebuild_unredacted_outbox(db)?;
        }
        self.prepare_copies(project_filter)?;
        if project_filter.is_none() {
            crate::history::clear_missing_session_errors(self.db)?;
        }
        Ok(Continue(()))
    }

    fn prepare_copies(&mut self, project_filter: Option<&str>) -> Result<()> {
        let device = self.device()?;
        let db = &mut *self.db;
        for binding in db::rows(
            db,
            &format!("SELECT value FROM bindings WHERE json_extract(value,'$.needsCopy')=1 AND (?1 IS NULL OR project=?1) AND project IN (SELECT id FROM projects WHERE {})",crate::projects::ACTIVE),
            &[&project_filter],
        )? {
            if binding["copyRequest"].is_null() {
                queue_session_copy(db, &binding, &device)?;
            }
        }
        Ok(())
    }

    /// Scans (or, for a retry, validates) one project's local files.
    async fn preflight(&mut self, p: &Value, waiting: Option<i64>) -> Stage {
        let db = &mut *self.db;
        let retry_only = self.mode == ProjectMode::RetryOnly;
        if crate::projects::foreground_waiting()? {
            return Ok(Break(()));
        }
        progress(
            db,
            "Checking local files",
            crate::projects::display_name(p),
            0,
            None,
        )?;
        match scan_off_runtime(db, p, move |db, p| preflight_project(db, p, retry_only)).await {
            Ok(()) => {
                if !retry_only && waiting.is_none() {
                    db::set(
                        db,
                        &format!("firstScan:{}", p["id"].as_str().unwrap_or("")),
                        &json!(db::now()),
                    )?;
                }
                db.execute("DELETE FROM errors WHERE source=?", [p["id"].as_str()])
                    .map_err(|e| e.to_string())?;
            }
            Err(error) => {
                db.execute("INSERT INTO errors VALUES(?,?) ON CONFLICT(source) DO UPDATE SET error=excluded.error",params![p["id"].as_str(),error]).map_err(|e|e.to_string())?;
            }
        }
        Ok(Continue(()))
    }

    /// Registers this Mac and merges the account's project catalog.
    async fn connect(&mut self) -> Stage {
        let device = self.device()?;
        let db = &mut *self.db;
        let owner = self.owner;
        if crate::projects::foreground_waiting()? {
            return Ok(Break(()));
        }
        progress(db, "Connecting to sync service", None, 0, None)?;
        let origin = db::get(db, "config")?["apiUrl"]
            .as_str()
            .ok_or("Configure the service")?
            .to_string();
        let capabilities = register_device(owner, &origin, &device).await?;
        let projects = api_as(owner, "GET", crate::projects::CATALOG_PATH, None).await?;
        crate::projects::merge_catalog(db, &projects)?;
        // Reuse registration's capabilities instead of probing again for pins.
        let origin = origin.as_str();
        crate::sources::backfill_remote_pins(db, &capabilities, |body| async move {
            crate::sources::post_remote_pin(owner, origin, &body).await
        })
        .await?;
        Ok(Continue(()))
    }

    /// Refreshes a governed project's permissions; a failure blocks its uploads and pull.
    async fn authorize(&mut self, p: &Value) -> Stage {
        let db = &mut *self.db;
        let owner = self.owner;
        let retry_only = self.mode == ProjectMode::RetryOnly;
        if crate::projects::foreground_waiting()? {
            return Ok(Break(()));
        }
        if p["governed"] == true {
            let id = p["id"].as_str().ok_or("Missing project")?;
            let result: Result<()> = async {
                crate::projects::active(db, id)?;
                let catalog = api_as(
                    owner,
                    "POST",
                    "/v2/governance/action",
                    Some(&json!({"action":"catalog","input":{"projectId":id}})),
                )
                .await?;
                db::set(db, &format!("governance:{id}"), &catalog)?;
                // A lifecycle refusal must leave queued work unchanged. Only
                // prepare legacy knowledge after current access is confirmed.
                if !retry_only {
                    crate::governance::localize_outbox(db, p)?;
                } else {
                    crate::governance::block_legacy_retry(db, p)?;
                }
                if !retry_only {
                    crate::context_sharing::approve_own_pending(db, owner, p, &catalog).await?;
                }
                Ok(())
            }
            .await;
            return self.record_authorization(id, result);
        }
        Ok(Continue(()))
    }

    fn record_authorization(&mut self, project: &str, result: Result<()>) -> Stage {
        if result.as_ref().is_err_and(|e| service_error(e)) {
            return result.map(Continue);
        }
        let result = if result.as_ref().is_err_and(|error| SyncError(error).holds()) {
            // The catalog may have changed since the workspace refresh. Preserve
            // pending work and wait quietly for the project to become active.
            self.held.insert(project.to_string());
            Ok(())
        } else {
            if result.is_err() {
                self.blocked.insert(project.to_string());
            }
            result
        };
        record_result(self.db, &format!("{project}:permissions"), result)?;
        Ok(Continue(()))
    }

    /// Sends this project's queued changes from its own upload cursor.
    async fn drain_outbox(&mut self, p: &Value) -> Stage {
        let device = self.device()?;
        let db = &mut *self.db;
        let owner = self.owner;
        let deferred = &mut self.deferred;
        let held = &mut self.held;
        let project = p["id"].as_str().ok_or("Missing project")?;
        if self.blocked.contains(project) || held.contains(project) {
            return Ok(Continue(()));
        }
        let blocked_projects = &mut self.blocked;
        let mut outbox = ProjectOutbox::open(db, project)?;
        let paused_sources = crate::sources::paused_upload_sources(p);
        let queued: Vec<_> = outbox
            .queued(db)?
            .into_iter()
            .filter(|q| {
                // Unattributed older rows may belong to the paused source.
                // Keep the bytes and request ID untouched for a verified retry.
                if crate::sources::upload_paused(&paused_sources, &q["sourceId"]) {
                    return false;
                }
                if q["path"] == crate::selective_sharing::QUEUE_PATH {
                    crate::selective_sharing::authorized_origin(db, q)
                        .is_ok_and(|origin| origin.is_some())
                } else {
                    crate::projects::sharing_allowed(
                        p,
                        crate::projects::queued_kind(q["path"].as_str().unwrap_or(""), &q["value"]),
                    )
                }
            })
            .collect();
        deferred.extend(
            queued
                .iter()
                .filter(|q| {
                    let error = q["error"].as_str().unwrap_or("");
                    consolidation_pending(q, error) || error.starts_with("Local upload: ")
                })
                .map(|q| q["id"].clone()),
        );
        let uploads = outbox.batch(&queued);
        for (index, original) in uploads.iter().enumerate() {
            let mut q = (*original).clone();
            if crate::projects::foreground_waiting()? || SyncQueue::cancelled(db, project)? {
                return Ok(Break(()));
            }
            let project_name = crate::projects::display_name(p);
            let mut input = q["value"].clone();
            let resource_name = input["resource"]["title"]
                .as_str()
                .or(input["resource"]["logicalPath"].as_str());
            let detail = [project_name, resource_name]
                .into_iter()
                .flatten()
                .collect::<Vec<_>>()
                .join(" · ");
            progress(
                db,
                "Uploading changes",
                Some(&detail),
                index,
                Some(uploads.len()),
            )?;
            let result = async {
                let id = q["id"].as_str().ok_or("Missing request ID")?;
                indexer::release_held_capture(db, id)?;
                if db::get(db, &outbox_redaction_key(id))?.is_object() {
                    let capabilities =
                        api_as(owner, "GET", "/v2/projects/capabilities", None).await?;
                    if capabilities["sessionUploadReconcile"] != 1
                        || (q["path"] == "/v2/sessions/copy"
                            && capabilities["sessionLatestOnly"] != 1)
                    {
                        // A permission-feed reset would discard an initial upload
                        // absent from the server snapshot before its ID is fenced.
                        blocked_projects
                            .insert(q["project"].as_str().ok_or("Missing project")?.to_string());
                        return Err(
                            "409: Update the service to safely rebuild queued session uploads"
                                .into(),
                        );
                    }
                    let outcome = api_as(
                        owner,
                        "POST",
                        "/v2/sessions/reconcile",
                        Some(&json!({"projectId":q["project"],"deviceId":device,"id":id})),
                    )
                    .await?;
                    match outcome["status"].as_str() {
                        Some("accepted") => return Ok(Some(outcome["receipt"].clone())),
                        Some("cancelled") => {
                            deferred.remove(&q["id"]);
                            if !replace_redacted_outbox(db, &mut q)? {
                                return Ok(None);
                            }
                            input = q["value"].clone();
                        }
                        _ => {
                            return Err(
                                "The service returned an invalid session reconciliation".into()
                            )
                        }
                    }
                }
                if q["path"] == "/v2/sessions/copy" {
                    let id = input["id"].as_str().ok_or("Missing request ID")?;
                    if db::get(db, &copy_state_key(id))?["negotiate"] == true {
                        let capabilities =
                            api_as(owner, "GET", "/v2/projects/capabilities", None).await?;
                        input = prepare_session_copy(
                            db,
                            &input,
                            capabilities["sessionLatestOnly"] == 1,
                        )?;
                    }
                    if input["sourceSnapshot"].is_object() {
                        crate::repair::upload(
                            owner,
                            q["project"].as_str().ok_or("Missing project")?,
                            &input["sourceSnapshot"],
                        )
                        .await?;
                    }
                }
                if q["path"] == crate::selective_sharing::QUEUE_PATH {
                    return crate::selective_sharing::send(db, owner, &q)
                        .await
                        .map(Some);
                }
                if q["path"] == crate::context_sharing::QUEUE_PATH {
                    crate::context_sharing::upload(db, owner, &q).await?;
                } else if input["resource"]["files"].is_array() {
                    crate::repair::upload(
                        owner,
                        q["project"].as_str().ok_or("Missing project")?,
                        &input["resource"],
                    )
                    .await?;
                }
                if q["path"] == crate::global_skills::IMPORT_PATH
                    || q["path"] == crate::context_sharing::QUEUE_PATH
                {
                    return crate::context_sharing::share(db, owner, &q).await.map(Some);
                }
                api_as(
                    owner,
                    "POST",
                    q["path"].as_str().ok_or("Missing upload path")?,
                    Some(&input),
                )
                .await
                .map(Some)
            }
            .await;
            match result {
                Ok(receipt) => {
                    let tx = db.transaction().map_err(|e| e.to_string())?;
                    if let Some(receipt) = receipt {
                        if q["path"] == crate::selective_sharing::QUEUE_PATH {
                            crate::selective_sharing::complete(&tx, &q, &receipt)?;
                        } else if q["path"] == crate::global_skills::IMPORT_PATH
                            || q["path"] == crate::context_sharing::QUEUE_PATH
                        {
                            crate::context_sharing::complete(&tx, &q, &receipt)?;
                        } else {
                            apply_event(&tx, &receipt["event"])?;
                        }
                        acknowledge_session(
                            &tx,
                            q["project"].as_str().ok_or("Missing project")?,
                            q["path"].as_str().ok_or("Missing upload path")?,
                            &input,
                            &receipt,
                        )?;
                    }
                    clear_session_copy(&tx, q["id"].as_str().ok_or("Missing request ID")?)?;
                    tx.execute("DELETE FROM outbox WHERE id=?", [q["id"].as_str()])
                        .map_err(|e| e.to_string())?;
                    tx.commit().map_err(|e| e.to_string())?;
                    deferred.remove(&q["id"]);
                }
                Err(error) => {
                    if q["path"] == "/v2/sessions/copy"
                        && error == "409: Cached session revision unavailable"
                        && api_as(owner, "GET", "/v2/projects/capabilities", None).await?
                            ["sessionLatestOnly"]
                            == 1
                        && replace_unavailable_session_copy(db, &input, &device)?
                    {
                        deferred.remove(&q["id"]);
                        outbox.advance(db, &q["sequence"])?;
                        continue;
                    }
                    if outbox.fail(db, &q, &error)? {
                        // Archived or deleted: keep the row for a restore and let
                        // the project's job back off without an error.
                        held.insert(project.to_string());
                        return Ok(Continue(()));
                    }
                    if consolidation_pending(&q, &error) || error.starts_with("Local upload: ") {
                        deferred.insert(q["id"].clone());
                    } else if terminal_error(&error) {
                        deferred.remove(&q["id"]);
                    } else {
                        return Err(error);
                    }
                }
            }
            outbox.advance(db, &q["sequence"])?;
            progress(
                db,
                "Uploading changes",
                Some(&detail),
                index + 1,
                Some(uploads.len()),
            )?;
        }
        Ok(Continue(()))
    }

    /// Rescans one project, pulls its changes and applies them on this Mac.
    async fn pull_project(&mut self, p: &Value) -> Stage {
        if boundary(&*self.db, p["id"].as_str().unwrap_or(""))?.is_break() {
            return Ok(Break(()));
        }
        let db = &mut *self.db;
        let owner = self.owner;
        let retry_only = self.mode == ProjectMode::RetryOnly;
        if crate::projects::foreground_waiting()? {
            return Ok(Break(()));
        }
        if self.blocked.contains(p["id"].as_str().unwrap_or(""))
            || self.held.contains(p["id"].as_str().unwrap_or(""))
        {
            return Ok(Continue(()));
        }
        progress(
            db,
            "Checking for new local changes",
            crate::projects::display_name(p),
            0,
            None,
        )?;
        let project = p["id"].as_str().ok_or("Missing project")?;
        let scan = scan_off_runtime(db, p, move |db, p| preflight_project(db, p, retry_only)).await;
        let scanned = scan.is_ok();
        record_result(db, project, scan)?;
        // A failed project preflight must not run permission-reset filesystem
        // cleanup against an unavailable or replaced folder.
        if !scanned {
            return Ok(Continue(()));
        }
        if crate::projects::foreground_waiting()? {
            return Ok(Break(()));
        }
        let result = pull(
            owner,
            db,
            project,
            crate::projects::display_name(p).unwrap_or("Project"),
        )
        .await;
        if result.as_ref().is_err_and(|error| SyncError(error).holds()) {
            // Archived or deleted: hold the project's next attempt quietly.
            self.held.insert(project.to_string());
            return Ok(Continue(()));
        }
        if result.as_ref().is_err_and(|e| service_error(e)) {
            return result.map(Continue);
        }
        let pulled = result.is_ok();
        record_result(db, &format!("{project}:pull"), result)?;
        if !pulled {
            return Ok(Continue(()));
        }
        // Prepare unsent context only after pending approvals and accepted
        // revisions have arrived; exact-base resources must not freeze early.
        if !retry_only {
            record_result(
                db,
                &format!("{project}:sharing"),
                crate::context_sharing::queue_waiting(db, p),
            )?;
        }
        if db::get(&db::open()?, "user")? != owner {
            return Err("Account changed; sync will restart with its own cache".into());
        }
        reconcile_shared_plan_uploads(db, project)?;
        let resources = db::rows(
            db,
            "SELECT value FROM resources WHERE project=?",
            &[&project],
        )?;
        for (index, r) in resources.iter().enumerate() {
            if crate::projects::foreground_waiting()? || SyncQueue::cancelled(db, project)? {
                return Ok(Break(()));
            }
            let detail = format!(
                "{} · {}",
                crate::projects::display_name(p).unwrap_or("Project"),
                r["title"]
                    .as_str()
                    .or(r["logicalPath"].as_str())
                    .unwrap_or("Update")
            );
            progress(
                db,
                "Applying updates on this Mac",
                Some(&detail),
                index,
                Some(resources.len()),
            )?;
            let id = r["resourceId"].as_str().ok_or("Missing resource")?;
            let result: Result<()> = async {
                download(owner, r).await?;
                for conflict in db::rows(db, "SELECT value FROM conflicts WHERE project=? AND json_extract(value,'$.resourceId')=?", &[&project, &id])? {
                    download(owner, &conflict["candidate"]).await?;
                }
                if crate::sources::for_resource(p, r).is_some() {
                    materialize(db, p, r)?;
                }
                Ok(())
            }.await;
            if result.as_ref().is_err_and(|e| service_error(e)) {
                return result.map(Continue);
            }
            record_result(db, id, result)?;
            progress(
                db,
                "Applying updates on this Mac",
                Some(&detail),
                index + 1,
                Some(resources.len()),
            )?;
        }
        record_result(
            db,
            &format!("{project}:history"),
            crate::attention::reconcile_project(db, p, true).map(|_| ()),
        )?;
        progress(
            db,
            "Updating memory index",
            crate::projects::display_name(p),
            0,
            None,
        )?;
        record_result(
            db,
            &format!("{project}:memory-index"),
            indexer::memory_index(db, p),
        )?;
        Ok(Continue(()))
    }

    /// Retries pending Codex skill refreshes and records the account's devices.
    async fn finish(&mut self) -> Result<()> {
        let db = &mut *self.db;
        let owner = self.owner;
        let project_filter = self.project_filter;
        progress(db, "Finishing sync", None, 0, None)?;
        if let Some(project) = project_filter {
            crate::codex_skills::retry_project(db, project)?;
        } else {
            crate::codex_skills::retry(db)?;
        }
        let devices = api_as(owner, "GET", "/v2/devices", None).await?;
        crate::device_metadata::update_devices(db, &devices)?;
        Ok(())
    }
}

async fn sync_workspace(
    db: &mut rusqlite::Connection,
    owner: &str,
    project_filter: Option<&str>,
) -> Result<WorkspaceSync> {
    let mut pass = SyncPass::new(db, owner, project_filter);
    if pass.prepare().await?.is_break() {
        return Ok(WorkspaceSync::Yielded);
    }
    let selected = |project: &Value| project_filter.is_none_or(|id| project["id"] == id);
    // Refresh the catalog before scanning, so a project that was archived or
    // deleted meanwhile is not scanned one more time. A failed connection keeps
    // its error for the end, because local work must not wait for the network.
    let connected = pass.connect().await;
    let local = db::rows(
        pass.db,
        &format!(
            "SELECT value FROM projects WHERE {}",
            crate::projects::ACTIVE
        ),
        &[],
    )?
    .into_iter()
    .filter(selected)
    .map(|project| sync_ready_view(pass.db, &project))
    .collect::<Result<Vec<_>>>()?;
    for (p, waiting) in &local {
        if pass.preflight(p, *waiting).await?.is_break() {
            return Ok(WorkspaceSync::Yielded);
        }
    }
    if pass.mode == ProjectMode::Full {
        let held = db::rows(
            pass.db,
            &format!(
                "SELECT value FROM projects WHERE {}",
                crate::projects::CAPTURE_ONLY
            ),
            &[],
        )?;
        for p in &held {
            if pass.capture_project(p).await?.is_break() {
                return Ok(WorkspaceSync::Yielded);
            }
        }
    }
    if connected?.is_break() {
        return Ok(WorkspaceSync::Yielded);
    }
    for (p, _) in &local {
        if pass.authorize(p).await?.is_break() {
            return Ok(WorkspaceSync::Yielded);
        }
    }
    for (p, _) in &local {
        if pass.drain_outbox(p).await?.is_break() {
            return Ok(WorkspaceSync::Yielded);
        }
    }
    for (p, _) in &local {
        if pass.pull_project(p).await?.is_break() {
            return Ok(WorkspaceSync::Yielded);
        }
    }
    pass.finish().await?;
    let db = pass.db;
    let has_errors: bool = db
        .query_row("SELECT EXISTS(SELECT 1 FROM errors)", [], |r| r.get(0))
        .map_err(|e| e.to_string())?;
    Ok(WorkspaceSync::Complete(
        !pass.deferred.is_empty() || !pass.held.is_empty() || has_errors,
    ))
}

/// Runs ready queue jobs one at a time, releasing the shared sync slot and the
/// workspace lock between jobs, until none is ready or foreground work waits.
async fn drain_queue(queue: &mut SyncQueue, interval: &Interval) {
    let Ok(base) = db::base_root() else { return };
    loop {
        let next = db::open().and_then(|db| SyncQueue::next(&db, SyncQueue::now()));
        let Ok(Some(job)) = next else { return };
        if job.project == WORKSPACE {
            // Onboarding takes the workspace lock itself, so it resumes outside a job.
            let _ = crate::onboarding::resume_pending_connections().await;
        }
        let Ok(_slot) = SyncSlot::acquire(&base).await else {
            return;
        };
        if !matches!(queue.run_next(interval, run_job).await, Ok(true)) {
            return;
        }
    }
}

/// One queue job, in full-scan mode: the workspace-wide steps or one project's.
async fn run_job(db: &mut rusqlite::Connection, job: &crate::sync_queue::Job) -> Result<Outcome> {
    let result = sync_job(db, job).await;
    // A request already in flight may fail after Cancel was pressed. Its error
    // must not turn the cancelled run into another retry or connectivity error.
    let result = if SyncQueue::cancelled(db, &job.project)? {
        Ok(Outcome::Cancelled)
    } else {
        result
    };
    let capture_failed = result.is_err() && SyncQueue::is_capture_only(db, &job.project)?;
    let previous = db::get(db, "sync")?;
    let status = match &result {
        Ok(Outcome::Yielded | Outcome::Cancelled | Outcome::Skipped | Outcome::Captured) => {
            previous
        }
        Ok(_) => json!({"online":true,"lastSync":db::now(),"updatedAt":db::now()}),
        Err(error) if capture_failed => {
            record_result(db, &job.project, Err(error.clone()))?;
            previous
        }
        Err(error) => {
            json!({"online":false,"lastSync":previous["lastSync"],"error":error,"updatedAt":db::now()})
        }
    };
    db::set(db, "sync", &status)?;
    // Stop showing progress before giving up the workspace lock. Settlement
    // also invalidates claim-bound progress before the next job starts.
    let more = SyncQueue::next(db, SyncQueue::now())?.is_some();
    if !more || crate::projects::foreground_waiting()? {
        db::set(db, "syncProgress", &Value::Null)?;
    }
    if !capture_failed
        && !matches!(
            result,
            Ok(Outcome::Yielded | Outcome::Cancelled | Outcome::Skipped | Outcome::Captured)
        )
    {
        let error = result.as_ref().err().map(String::as_str);
        let _ = crate::onboarding::reconcile_workspace_sync(db, error);
    }
    result
}

async fn sync_job(db: &mut rusqlite::Connection, job: &crate::sync_queue::Job) -> Result<Outcome> {
    let owner = db::get(db, "user")?
        .as_str()
        .ok_or("Sign in required")?
        .to_string();
    if job.project == WORKSPACE {
        let _ = crate::account_profile::flush_pending().await;
        progress(db, "Preparing sync", None, 0, None)?;
    }
    let project = db::rows(
        db,
        &format!(
            "SELECT value FROM projects WHERE id=? AND {}",
            crate::projects::ACTIVE
        ),
        &[&job.project],
    )?;
    let held = if project.is_empty() && job.project != WORKSPACE {
        db::rows(
            db,
            &format!(
                "SELECT value FROM projects WHERE id=? AND {}",
                crate::projects::CAPTURE_ONLY
            ),
            &[&job.project],
        )?
    } else {
        Vec::new()
    };
    let mut pass = SyncPass::new(db, &owner, None);
    let flow = match (project.first(), held.first()) {
        _ if job.project == WORKSPACE => pass.sync_workspace_global().await?,
        (Some(p), _) => pass.sync_project(p).await?,
        // Deleted but restorable: capture locally and send nothing.
        (None, Some(p)) => {
            let flow = pass.capture_project(p).await?;
            return Ok(if SyncQueue::cancelled(pass.db, &job.project)? {
                Outcome::Cancelled
            } else if flow.is_break() {
                Outcome::Yielded
            } else {
                Outcome::Captured
            });
        }
        // Removed or archived since it was queued.
        (None, None) => return Ok(Outcome::Skipped),
    };
    Ok(if SyncQueue::cancelled(pass.db, &job.project)? {
        Outcome::Cancelled
    } else if flow.is_break() {
        Outcome::Yielded
    } else if !pass.deferred.is_empty()
        || !pass.held.is_empty()
        || project_has_retryable_errors(pass.db, &job.project)?
    {
        Outcome::Deferred
    } else {
        Outcome::Synced
    })
}

/// A sooner sync can serve ready folders without consuming the delayed run.
fn sync_ready_view(db: &rusqlite::Connection, project: &Value) -> Result<(Value, Option<i64>)> {
    let (view, waiting) = crate::sources::without_waiting(db, project)?;
    if let Some(at) = waiting {
        let id = project["id"].as_str().ok_or("Missing project")?;
        SyncQueue::request_at(db, id, Priority::Local, "new folder", at)?;
    }
    Ok((view, waiting))
}

fn project_has_retryable_errors(db: &rusqlite::Connection, project: &str) -> Result<bool> {
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM errors
         WHERE (source=?1 OR substr(source,1,length(?1)+1)=?1||':'
           OR source IN (SELECT id FROM resources WHERE project=?1))
         AND error NOT IN (?2,?3,?4))",
        params![
            project,
            crate::skill_reconciliation::LOCAL_EDITS,
            indexer::SKILL_MIRROR_REVIEW,
            PLAN_REVIEW_PENDING
        ],
        |row| row.get(0),
    )
    .map_err(|error| error.to_string())
}

fn plan_upload_needs_review(
    db: &rusqlite::Connection,
    project: &str,
    resource: &str,
) -> Result<bool> {
    let uploads = db::rows(
        db,
        "SELECT json_object('path',path,'error',error,'resource',json_extract(value,'$.resource'))
         FROM outbox WHERE project=? AND error IS NOT NULL
           AND json_extract(value,'$.resource.resourceId')=?",
        &[&project, &resource],
    )?;
    Ok(uploads.iter().any(|upload| {
        crate::upload_review::reviewable(
            upload["path"].as_str().unwrap_or(""),
            upload["error"].as_str(),
            &upload["resource"],
        )
    }))
}

/// A rejected exact-version upload is already satisfied when the fresh feed
/// contains the identical live plan. Leave differing and unrecognized requests
/// in the outbox so neither a local edit nor an explicit review is lost.
fn reconcile_shared_plan_uploads(db: &mut rusqlite::Connection, project: &str) -> Result<()> {
    let tx = db.transaction().map_err(|error| error.to_string())?;
    let stale = db::rows(
        &tx,
        "SELECT json_object('id',o.id,'change',json(o.value),'current',json(r.value))
         FROM outbox o JOIN resources r ON r.project=o.project
           AND r.id=json_extract(o.value,'$.resource.resourceId')
         WHERE o.project=? AND o.path='/v2/sync/push' AND o.error=?
           AND json_extract(o.value,'$.resource.kind')='plan'",
        &[&project, &PLAN_REVISION_CONFLICT],
    )?;
    for row in stale {
        let change = &row["change"];
        let current = &row["current"];
        let Some(input) = change["resource"].as_object() else {
            continue;
        };
        if change["id"] != row["id"]
            || change["projectId"] != project
            || current["projectId"] != project
            || current["access"]["mode"] == "hidden"
            || current["kind"] != "plan"
            || change["resource"]["deleted"] != false
            || ["resourceId", "source", "logicalPath", "title", "files"]
                .iter()
                .any(|key| input.get(*key).is_none_or(Value::is_null))
            || current["revision"]
                .as_u64()
                .zip(change["baseRevision"].as_u64())
                .is_none_or(|(revision, base)| revision <= base)
        {
            continue;
        }
        // Compare every submitted protocol field and account for any optional
        // fields present only in the accepted resource.
        if input
            .iter()
            .all(|(key, value)| current.get(key) == Some(value))
            && ["sourceId", "memory", "contextSources"]
                .iter()
                .all(|key| current[*key].is_null() || input.contains_key(*key))
        {
            tx.execute(
                "DELETE FROM outbox WHERE project=? AND id=? AND error=?",
                params![project, row["id"].as_str(), PLAN_REVISION_CONFLICT],
            )
            .map_err(|error| error.to_string())?;
        }
    }
    tx.commit().map_err(|error| error.to_string())
}

pub(crate) fn record_result(
    db: &rusqlite::Connection,
    source: &str,
    result: Result<()>,
) -> Result<()> {
    match result {
        Ok(()) => db.execute("DELETE FROM errors WHERE source=?", [source]),
        Err(error) => db.execute(
            "INSERT INTO errors VALUES(?,?) ON CONFLICT(source) DO UPDATE SET error=excluded.error",
            params![source, error],
        ),
    }
    .map_err(|e| e.to_string())?;
    Ok(())
}

pub(crate) fn service_error(error: &str) -> bool {
    let code = error
        .split_once(':')
        .and_then(|(code, _)| code.parse::<u16>().ok());
    matches!(code, Some(401 | 408 | 429 | 500..=599))
        || error == "Cloud unavailable; local work stays queued"
        || error == "Blob download failed"
        || error == "Blob upload failed; retry retained"
        || error == "Sign in required"
        || error == "Missing sign-in session"
        || error == "Session is invalid"
        || error.starts_with("Sync authentication: ")
        || error.ends_with(": Sync service returned an unreadable response")
        || error.starts_with("Account ")
        || error.starts_with("Service changed")
}

// Match only the packaged backend's resource-local MemoryUnavailable contract.
// General 503s, blob failures, auth failures and transport errors remain fatal.
fn consolidation_pending(queued: &Value, error: &str) -> bool {
    if !matches!(
        queued["path"].as_str(),
        Some(
            "/v2/sync/push"
                | crate::context_sharing::QUEUE_PATH
                | crate::selective_sharing::QUEUE_PATH
        )
    ) || queued["value"]["resource"]["kind"] != "memory"
    {
        return false;
    }
    let Some(reason) = error.strip_prefix("503: Memory consolidation pending: ") else {
        return false;
    };
    matches!(
        reason,
        "invalid_answers"
            | "jev_disabled"
            | "jev_missing_key"
            | "jev_context_limit"
            | "jev_network"
            | "jev_invalid_response"
            | "jev_invalid_answers"
            | "jev_invalid_probabilities"
            | "jev_uncertain"
    ) || reason
        .strip_prefix("jev_http_")
        .and_then(|code| code.parse::<u16>().ok())
        .is_some_and(|code| (100..=599).contains(&code))
}

/// One project's outbox and the position its next upload batch starts from.
/// Each project keeps its own cursor, so projects can drain independently.
struct ProjectOutbox<'p> {
    project: &'p str,
    cursor_key: String,
    cursor: i64,
}

impl<'p> ProjectOutbox<'p> {
    /// Before cursors were per project, one key held the whole outbox's position.
    const LEGACY_CURSOR: &'static str = "syncUploadCursor";

    fn open(db: &rusqlite::Connection, project: &'p str) -> Result<Self> {
        Self::migrate(db)?;
        let cursor_key = format!("{}:{project}", Self::LEGACY_CURSOR);
        let cursor = db::get(db, &cursor_key)?.as_i64().unwrap_or(0);
        Ok(Self {
            project,
            cursor_key,
            cursor,
        })
    }

    /// Every project resumes from the old shared position once, so no project
    /// restarts its rotation from the beginning.
    fn migrate(db: &rusqlite::Connection) -> Result<()> {
        let legacy = db::get(db, Self::LEGACY_CURSOR)?;
        if legacy.is_null() {
            return Ok(());
        }
        let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
        tx.execute(
            "INSERT OR IGNORE INTO meta(key,value) SELECT ?1 || ':' || id, ?2 FROM projects",
            params![Self::LEGACY_CURSOR, legacy.to_string()],
        )
        .map_err(|e| e.to_string())?;
        tx.execute("DELETE FROM meta WHERE key=?", [Self::LEGACY_CURSOR])
            .map_err(|e| e.to_string())?;
        tx.commit().map_err(|e| e.to_string())
    }

    /// Queued rows that may be sent now, oldest first.
    fn queued(&self, db: &rusqlite::Connection) -> Result<Vec<Value>> {
        let source = crate::sources::OUTBOX_SOURCE;
        db::rows(db, &format!("SELECT json_object('sequence',o.rowid,'id',o.id,'project',o.project,'path',o.path,'value',json(o.value),'error',o.error,'sourceId',{source}) FROM outbox o WHERE o.project=? AND (EXISTS(SELECT 1 FROM meta WHERE key='sessionOutboxRedaction:'||o.id) OR o.error IS NULL OR o.error NOT GLOB '4[0-9][0-9]:*' OR substr(o.error,1,3) IN ('401','408','429')) ORDER BY o.rowid"), &[&self.project])
    }

    fn batch<'q>(&self, queued: &'q [Value]) -> Vec<&'q Value> {
        select_uploads(queued, self.cursor)
    }

    fn advance(&mut self, db: &rusqlite::Connection, sequence: &Value) -> Result<()> {
        self.cursor = sequence.as_i64().unwrap_or(self.cursor);
        db::set(db, &self.cursor_key, sequence)
    }

    /// Records a failed send. An archived or deleted project keeps its row with
    /// no error, so a restore sends it again; every other failure is recorded.
    fn fail(&self, db: &rusqlite::Connection, queued: &Value, error: &str) -> Result<bool> {
        let held = SyncError(error).holds();
        db.execute(
            "UPDATE outbox SET error=? WHERE id=?",
            params![(!held).then_some(error), queued["id"].as_str()],
        )
        .map_err(|e| e.to_string())?;
        Ok(held)
    }
}

fn select_uploads(queued: &[Value], cursor: i64) -> Vec<&Value> {
    let mut resources = HashSet::new();
    // A later operation must never overtake its resource's oldest eligible edit,
    // even when rotating the batch. Independent resources can keep progressing.
    let mut uploads: Vec<_> = queued
        .iter()
        .filter(|q| {
            let input = &q["value"];
            let resource = input["resource"]["resourceId"]
                .as_str()
                .or_else(|| input["resourceId"].as_str())
                .or_else(|| q["id"].as_str());
            resources.insert((q["project"].as_str(), resource))
        })
        .collect();
    let start = uploads.partition_point(|q| q["sequence"].as_i64().unwrap_or(0) <= cursor);
    uploads.rotate_left(start);
    uploads.truncate(100);
    uploads
}

/// A failed response as the outbox records it: `"<status>: <message>"`, with the
/// server's access `code` between the two when the response carries one.
pub(crate) struct SyncError<'a>(&'a str);

impl<'a> SyncError<'a> {
    /// The codes that close a project to this Mac. Other endpoints send codes
    /// too, so only these keep the extra token in the recorded message.
    const ACCESS: [&'static str; 3] = ["project_archived", "project_deleted", "not_member"];

    /// Formats a rejected response. An access code stays a leading token so a
    /// project that is archived or deleted can be told apart from a caller's
    /// error; every other code keeps the plain `"<status>: <message>"` shape.
    fn message(status: u16, body: &Value, fallback: &str) -> String {
        let message = body["error"].as_str().unwrap_or(fallback);
        match body["code"]
            .as_str()
            .filter(|code| Self::ACCESS.contains(code))
        {
            Some(code) => format!("{status}: {code}: {message}"),
            None => format!("{status}: {message}"),
        }
    }

    fn status(&self) -> Option<u16> {
        self.0
            .split_once(':')
            .and_then(|(status, _)| status.parse().ok())
    }

    /// The server's access code, when it reports one. Older servers send none,
    /// so only the status and the message decide.
    fn access(&self) -> Option<&'a str> {
        let (_, rest) = self.0.split_once(": ")?;
        let (code, _) = rest.split_once(": ")?;
        Self::ACCESS.into_iter().find(|known| *known == code)
    }

    /// Work for an archived or deleted project is held, not failed: a restore
    /// within the window sends it again.
    fn holds(&self) -> bool {
        matches!(self.access(), Some("project_archived" | "project_deleted"))
    }

    fn terminal(&self) -> bool {
        matches!(self.status(), Some(400..=499)) && !matches!(self.status(), Some(401 | 408 | 429))
    }
}

pub fn terminal_error(error: &str) -> bool {
    SyncError(error).terminal()
}

/// The presence heartbeat: one post per active project, each one independent.
struct Presence;

impl Presence {
    /// Every active project's presence body, with the sessions open on this Mac.
    fn bodies(db: &rusqlite::Connection) -> Result<Vec<Value>> {
        let device = db::device(db)?;
        let mut bodies = Vec::new();
        for p in db::rows(
            db,
            &format!(
                "SELECT value FROM projects WHERE {}",
                crate::projects::ACTIVE
            ),
            &[],
        )? {
            let project = p["id"].as_str().ok_or("Missing project")?;
            let mut ids = Vec::new();
            if crate::projects::sharing_allowed(&p, "session") {
                for b in db::rows(db,"SELECT value FROM bindings WHERE project=? AND json_extract(value,'$.base.kind')='session'",&[&project])? {if let Some(id) = b["nativeId"].as_str() {if native::active(db,id,b["base"]["source"].as_str().unwrap_or("")){ids.push(b["base"]["resourceId"].clone());}}}
            }
            bodies.push(json!({"projectId":project,"deviceId":device,"sessions":ids}));
        }
        Ok(bodies)
    }

    /// Posts each body in turn. One project's failure says nothing about the
    /// others, so presence moves on instead of stopping the heartbeat.
    async fn send(bodies: Vec<Value>, post: impl AsyncFn(Value) -> Result<()>) -> Result<()> {
        for body in bodies {
            if crate::projects::foreground_waiting()? {
                break;
            }
            let _ = post(body).await;
        }
        Ok(())
    }
}

async fn heartbeat() -> Result<()> {
    if crate::projects::foreground_waiting()? {
        return Ok(());
    }
    let _lock = crate::projects::lock()?;
    let db = db::open()?;
    let user = db::get(&db, "user")?;
    let owner = user.as_str().ok_or("Sign in required")?;
    let bodies = Presence::bodies(&db)?;
    Presence::send(bodies, async |body| {
        api_as(owner, "POST", "/v2/presence", Some(&body))
            .await
            .map(|_| ())
    })
    .await
}
pub(crate) fn foreground_enabled(db: &rusqlite::Connection) -> Result<bool> {
    let enabled = db::get(db, "background")?.as_bool().unwrap_or_else(|| {
        // First-run background registration is an explicit choice after sync.
        crate::onboarding::snapshot(db)
            .map(|v| v["active"] != true && crate::profiles::background_default())
            .unwrap_or(false)
    });
    Ok(!enabled && db::get(db, "backgroundHandoff")? != true)
}
pub fn start_foreground() {
    std::thread::spawn(|| {
        let Ok(runtime) = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        else {
            return;
        };
        runtime.block_on(async {
            loop {
                if db::open()
                    .and_then(|db| foreground_enabled(&db))
                    .unwrap_or(false)
                {
                    run_mode(true).await;
                }
                tokio::time::sleep(Duration::from_secs(1)).await;
            }
        });
    });
}
pub async fn run() {
    run_mode(false).await;
}
async fn run_mode(foreground: bool) {
    let Ok(lock) = db::daemon_lock() else { return };
    if lock.try_lock_exclusive().is_err() {
        return;
    }
    let executable_identity = db::executable_identity().unwrap_or_default();
    let mut queue = SyncQueue::new(SyncQueue::now());
    let mut beat = Instant::now();
    let mut network_poll = Instant::now();
    let _worktrees = crate::worktree_integration::Poll::start();
    let mut network = String::new();
    loop {
        if !foreground && crate::updates::installation_pending() {
            return;
        }
        let Ok(db) = db::open() else {
            tokio::time::sleep(Duration::from_secs(1)).await;
            continue;
        };
        if foreground && !foreground_enabled(&db).unwrap_or(false) {
            // Release the shared daemon lock before the registered agent takes over.
            return;
        }
        let cfg = db::get(&db, "config").unwrap_or(json!({}));
        let interval = Interval::from_config(&cfg);
        let user = db::get(&db, "user")
            .unwrap_or(Value::Null)
            .as_str()
            .unwrap_or("")
            .to_string();
        let reconnect = if !user.is_empty() && Instant::now() >= network_poll {
            network_poll = Instant::now() + Duration::from_secs(10);
            let state = std::process::Command::new("/usr/sbin/scutil")
                .arg("--nwi")
                .output()
                .ok()
                .filter(|o| o.status.success())
                .map(|o| db::digest(&o.stdout))
                .unwrap_or_default();
            let changed = !network.is_empty() && !state.is_empty() && network != state;
            network = state;
            changed
        } else {
            false
        };
        db::set(
            &db,
            "daemon",
            &json!({"running":true,"heartbeat":db::now(),"executableIdentity":executable_identity}),
        )
        .ok();
        drop(db);
        let onboarding_active = db::open()
            .and_then(|db| crate::onboarding::snapshot(&db))
            .is_ok_and(|value| value["active"] == true);
        let onboarding_sync = crate::onboarding::sync_running().unwrap_or(false);
        if !user.is_empty() && !onboarding_active && !onboarding_sync {
            let queued = db::open().and_then(|db| {
                let now = SyncQueue::now();
                SyncQueue::recover(&db, now)?;
                SyncQueue::accept_request(&db, now)?;
                if reconnect {
                    SyncQueue::enqueue_all(&db, Priority::Local, "network", now)?;
                }
                queue.enqueue_due(&db, now, &interval)
            });
            if queued.is_ok() {
                drain_queue(&mut queue, &interval).await;
            }
        }
        if !onboarding_active && !user.is_empty() && Instant::now() >= beat {
            let _ = heartbeat().await;
            beat = Instant::now() + Duration::from_secs(60);
        }
        tokio::time::sleep(Duration::from_secs(1)).await;
    }
}

/// Local repair every project pass does before it looks at files.
fn prepare_local(db: &rusqlite::Connection, project: &Value) -> Result<()> {
    for source in crate::sources::views(project) {
        crate::repair::project_state(db, &source)?;
    }
    packages::recover_project_installations(db, project)?;
    rebuild_unredacted_outbox_for(db, Some(project["id"].as_str().ok_or("Missing project")?))
}

/// Scans a deleted project's files into the outbox as held captures.
fn scan_held(db: &rusqlite::Connection, project: &Value) -> Result<bool> {
    indexer::clear_orphan_held_captures(db)?;
    let (mut capture, _) = crate::sources::without_waiting(db, project)?;
    capture["captureOnly"] = json!(true);
    capture["deferAutomaticSharing"] = json!(true);
    indexer::scan_with_status(db, &capture, false)
}

/// Captures changes made while a project is deleted but still restorable, so an
/// export taken before a restore contains them. A copy the catalog has detached
/// is left alone and keeps exporting what it has.
pub fn capture_held(db: &rusqlite::Connection, project: &str) -> Result<bool> {
    let saved = db::rows(
        db,
        &format!(
            "SELECT value FROM projects WHERE id=? AND {}",
            crate::projects::CAPTURE_ONLY
        ),
        &[&project],
    )?
    .into_iter()
    .next();
    let Some(saved) = saved else {
        return Ok(true);
    };
    prepare_local(db, &saved)?;
    scan_held(db, &saved)
}

#[cfg(test)]
mod queue_tests {
    use super::*;

    #[tokio::test]
    async fn mixed_replica_registration_retries_once_with_only_public_fields() {
        let public = json!({"id":"device","name":"Mac","hardwareFamily":"laptop"});
        let mut private = public.clone();
        private["privateName"] = json!("Studio Mac");
        for second in [Ok(()), Err("400: Invalid request".to_string())] {
            let mut requests = Vec::new();
            let result = send_registration(private.clone(), async |body| {
                requests.push(body.clone());
                match requests.len() {
                    1 => Err("400: Invalid request".into()),
                    2 => second.clone(),
                    _ => panic!("retried a legacy registration"),
                }
            })
            .await;
            assert_eq!(requests, [private.clone(), public.clone()]);
            assert_eq!(result, second);
        }

        for (body, response) in [
            (public, Err("400: Invalid request".to_string())),
            (private.clone(), Err("400: Invalid device".to_string())),
            (private.clone(), Err("403: Forbidden".to_string())),
            (private.clone(), Err("503: Service unavailable".to_string())),
            (private, Ok(())),
        ] {
            let mut requests = Vec::new();
            let result = send_registration(body.clone(), async |sent| {
                requests.push(sent.clone());
                response.clone()
            })
            .await;
            assert_eq!(requests, [body]);
            assert_eq!(result, response);
        }
    }

    #[test]
    fn archived_and_deleted_projects_hold_while_a_member_error_stays_terminal() {
        for code in ["project_archived", "project_deleted"] {
            let error = format!("403: {code}: Project is unavailable");
            assert!(SyncError(&error).holds(), "{error}");
            assert!(terminal_error(&error), "{error}");
        }
        for error in ["403: not_member: Not a member", "403: Forbidden"] {
            assert!(!SyncError(error).holds(), "{error}");
            assert!(terminal_error(error), "{error}");
        }
        // A service message that happens to look like a code is not one.
        assert!(!SyncError("403: Project: deleted").holds());
        // The formatted message keeps the status parsers working.
        let reply = json!({"error":"Project is deleted","code":"project_deleted"});
        let error = SyncError::message(403, &reply, "Service unavailable");
        assert_eq!(error, "403: project_deleted: Project is deleted");
        assert_eq!(SyncError(&error).status(), Some(403));
        assert!(!service_error(&error));
        let older = SyncError::message(403, &json!({"error":"Forbidden"}), "Rejected");
        assert_eq!(older, "403: Forbidden");
        assert!(terminal_error(&older));
        // Other endpoints send codes too; they keep the plain message shape that
        // the UI already parses.
        let other = SyncError::message(
            409,
            &json!({"error":"Already invited","code":"already_member"}),
            "Rejected",
        );
        assert_eq!(other, "409: Already invited");
        assert_eq!(SyncError(&other).access(), None);
        assert!(!SyncError(&other).holds());
    }

    #[tokio::test]
    async fn governance_lifecycle_refusals_hold_pending_work_without_permission_errors() {
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("ORKA_TEST_HOME", home.path());
        db::open().unwrap();
        for code in ["project_archived", "project_deleted"] {
            let (_root, mut db) = outbox_db(&["a"]);
            enqueue(&db, "a", "memory");
            let before = db::rows(&db, "SELECT value FROM outbox", &[]).unwrap();
            record_result(
                &db,
                "a:permissions",
                Err("403: stale permission error".into()),
            )
            .unwrap();
            let mut pass = SyncPass::new(&mut db, "owner", None);
            let error = format!("403: {code}: Project is unavailable");
            assert!(pass
                .record_authorization("a", Err(error))
                .unwrap()
                .is_continue());
            assert!(pass.held.contains("a"));
            assert!(!pass.blocked.contains("a"));
            let project = json!({"id":"a"});
            // No service configuration is available: these stages must skip the
            // held project before trying any upload or pull.
            assert!(pass.drain_outbox(&project).await.unwrap().is_continue());
            assert!(pass.pull_project(&project).await.unwrap().is_continue());
            assert_eq!(
                db::rows(pass.db, "SELECT value FROM outbox", &[]).unwrap(),
                before
            );
            assert!(
                db::rows(pass.db, "SELECT json_quote(error) FROM errors", &[])
                    .unwrap()
                    .is_empty()
            );
        }
    }

    #[test]
    fn governance_member_refusals_and_outages_keep_their_existing_behavior() {
        for error in ["403: not_member: Not a member", "403: Forbidden"] {
            let (_root, mut db) = outbox_db(&["a"]);
            let mut pass = SyncPass::new(&mut db, "owner", None);
            assert!(pass
                .record_authorization("a", Err(error.into()))
                .unwrap()
                .is_continue());
            assert!(pass.blocked.contains("a"));
            assert!(!pass.held.contains("a"));
            assert_eq!(
                db::rows(pass.db, "SELECT json_quote(error) FROM errors", &[]).unwrap(),
                [json!(error)]
            );
            assert!(pass
                .record_authorization("a", Ok(()))
                .unwrap()
                .is_continue());
            assert!(
                db::rows(pass.db, "SELECT json_quote(error) FROM errors", &[])
                    .unwrap()
                    .is_empty()
            );
        }
        let (_root, mut db) = outbox_db(&["a"]);
        let mut pass = SyncPass::new(&mut db, "owner", None);
        assert_eq!(
            pass.record_authorization("a", Err("503: Service unavailable".into()))
                .unwrap_err(),
            "503: Service unavailable"
        );
        assert!(pass.held.is_empty());
        assert!(pass.blocked.is_empty());
    }

    #[test]
    fn held_rows_keep_no_error_so_a_restore_sends_them_again() {
        let (_root, db) = outbox_db(&["a"]);
        enqueue(&db, "a", "memory");
        let outbox = ProjectOutbox::open(&db, "a").unwrap();
        let row = outbox.queued(&db).unwrap().remove(0);
        let saved = || {
            db.query_row("SELECT error FROM outbox", [], |r| {
                r.get::<_, Option<String>>(0)
            })
            .unwrap()
        };
        for code in ["project_archived", "project_deleted"] {
            db.execute("UPDATE outbox SET error='403: project_deleted: stale'", [])
                .unwrap();
            let error = format!("403: {code}: Project is unavailable");
            assert!(outbox.fail(&db, &row, &error).unwrap(), "{error}");
            // Held, not failed: the row stays queued for a restore.
            assert_eq!(saved(), None);
            assert_eq!(outbox.queued(&db).unwrap().len(), 1);
        }
        // A member-only refusal keeps today's terminal behaviour.
        let error = "403: not_member: Not a member";
        assert!(!outbox.fail(&db, &row, error).unwrap());
        assert_eq!(saved().as_deref(), Some(error));
        assert!(outbox.queued(&db).unwrap().is_empty());
    }

    #[test]
    fn identical_rejected_plan_upload_is_settled_without_resending_or_dropping_other_edits() {
        let (_root, mut db) = outbox_db(&["a", "b"]);
        let shared_fields = json!({
            "resourceId":"plan","sourceId":"source","kind":"plan","source":"codex",
            "logicalPath":"codex/files/plan.md","title":"Shared plan","deleted":false,
            "files":[{"path":"content.md","hash":"shared","size":10,"executable":false}],
            "contextSources":["related"]
        });
        let mut accepted = shared_fields.clone();
        accepted["projectId"] = json!("a");
        accepted["revision"] = json!(1);
        accepted["owner"] = json!("teammate");
        accepted["access"] = json!({"mode":"publish"});
        db::upsert(&db, "resources", "plan", "a", &accepted).unwrap();
        let put = |id: &str, project: &str, base: u64, resource: Value, error: Option<&str>| {
            let request =
                json!({"id":id,"projectId":project,"baseRevision":base,"resource":resource});
            db.execute(
                "INSERT INTO outbox VALUES(?,?,'/v2/sync/push',?,?)",
                params![id, project, request.to_string(), error],
            )
            .unwrap();
        };
        put(
            "identical",
            "a",
            0,
            shared_fields.clone(),
            Some(PLAN_REVISION_CONFLICT),
        );
        put(
            "another-project",
            "b",
            0,
            shared_fields.clone(),
            Some(PLAN_REVISION_CONFLICT),
        );
        put("newer-request", "a", 1, shared_fields.clone(), None);
        put(
            "different-error",
            "a",
            0,
            shared_fields.clone(),
            Some("403: Forbidden"),
        );
        let mut different_copy = shared_fields.clone();
        different_copy["files"][0]["hash"] = json!("local-only");
        put(
            "different-content",
            "a",
            0,
            different_copy,
            Some(PLAN_REVISION_CONFLICT),
        );
        let mut different_context = shared_fields;
        different_context
            .as_object_mut()
            .unwrap()
            .remove("contextSources");
        put(
            "different-context",
            "a",
            0,
            different_context,
            Some(PLAN_REVISION_CONFLICT),
        );

        reconcile_shared_plan_uploads(&mut db, "a").unwrap();
        reconcile_shared_plan_uploads(&mut db, "a").unwrap();
        assert_eq!(
            db::rows(&db, "SELECT json_quote(id) FROM outbox ORDER BY rowid", &[]).unwrap(),
            [
                json!("another-project"),
                json!("newer-request"),
                json!("different-error"),
                json!("different-content"),
                json!("different-context"),
            ]
        );
        assert_eq!(
            db::rows(&db, "SELECT value FROM resources WHERE id='plan'", &[]).unwrap(),
            [accepted]
        );
        assert!(plan_upload_needs_review(&db, "a", "plan").unwrap());
    }

    #[test]
    fn review_only_items_do_not_schedule_failure_backoff_or_hide_other_errors() {
        let (_root, db) = outbox_db(&["a", "b"]);
        for (source, error) in [
            ("a:skills", crate::skill_reconciliation::LOCAL_EDITS),
            ("a:mirrors", indexer::SKILL_MIRROR_REVIEW),
            ("a:plans", PLAN_REVIEW_PENDING),
            ("b:pull", "Could not download an update"),
        ] {
            record_result(&db, source, Err(error.into())).unwrap();
        }
        assert!(!project_has_retryable_errors(&db, "a").unwrap());
        assert!(project_has_retryable_errors(&db, "b").unwrap());
        record_result(&db, "a:pull", Err("Could not download an update".into())).unwrap();
        assert!(project_has_retryable_errors(&db, "a").unwrap());
        assert_eq!(
            db::rows(&db, "SELECT json_quote(error) FROM errors", &[])
                .unwrap()
                .len(),
            5
        );
    }

    #[test]
    fn reconciled_plan_installs_its_baseline_without_rewriting_an_identical_file() {
        use std::os::unix::fs::MetadataExt;

        let (home, mut db) = outbox_db(&["a"]);
        std::env::set_var("ORKA_TEST_HOME", home.path());
        let root = home.path().join("workspace");
        let path = root.join(".codex/plans/plan.md");
        fs::create_dir_all(path.parent().unwrap()).unwrap();
        fs::write(&path, "# Shared plan\n").unwrap();
        let original_inode = fs::metadata(&path).unwrap().ino();
        let project = json!({"id":"a","path":root,"sharing":{"plan":true}});
        let files = json!([crate::plans::content(b"# Shared plan\n").unwrap()]);
        let guard = indexer::manifest_hash(&files);
        let input = json!({"resourceId":"plan","kind":"plan","source":"codex","logicalPath":"codex/files/plan.md","title":"Shared plan","deleted":false,"files":files});
        let mut accepted = input.clone();
        accepted["projectId"] = json!("a");
        accepted["revision"] = json!(1);
        db::upsert(&db, "resources", "plan", "a", &accepted).unwrap();
        db::upsert(
            &db,
            "bindings",
            "plan",
            "a",
            &json!({"paths":[path],"base":{"source":"codex","revision":0,"files":[]},"guards":[guard]}),
        )
        .unwrap();
        let change = json!({"id":"upload","projectId":"a","baseRevision":0,"resource":input});
        db.execute(
            "INSERT INTO outbox VALUES('upload','a','/v2/sync/push',?,?)",
            params![change.to_string(), PLAN_REVISION_CONFLICT],
        )
        .unwrap();

        db.execute(
            "UPDATE outbox SET error='409: Unknown base revision' WHERE id='upload'",
            [],
        )
        .unwrap();
        assert_eq!(
            materialize(&db, &project, &accepted).unwrap_err(),
            PLAN_REVIEW_PENDING
        );
        reconcile_shared_plan_uploads(&mut db, "a").unwrap();
        assert!(plan_upload_needs_review(&db, "a", "plan").unwrap());
        db.execute(
            "UPDATE outbox SET error=? WHERE id='upload'",
            [PLAN_REVISION_CONFLICT],
        )
        .unwrap();
        reconcile_shared_plan_uploads(&mut db, "a").unwrap();
        materialize(&db, &project, &accepted).unwrap();

        assert_eq!(indexer::binding(&db, "plan").unwrap()["base"], accepted);
        assert!(!plan_upload_needs_review(&db, "a", "plan").unwrap());
        assert_eq!(fs::metadata(path).unwrap().ino(), original_inode);
    }

    #[tokio::test]
    async fn the_presence_heartbeat_continues_past_a_project_error() {
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("ORKA_TEST_HOME", home.path());
        db::open().unwrap();
        let bodies = ["a", "b", "c"]
            .into_iter()
            .map(|id| json!({"projectId":id}))
            .collect();
        let seen = std::sync::Mutex::new(Vec::new());
        Presence::send(bodies, async |body| {
            let id = body["projectId"].as_str().unwrap().to_string();
            seen.lock().unwrap().push(id.clone());
            if id == "a" {
                return Err("403: project_deleted: Project is deleted".into());
            }
            Ok(())
        })
        .await
        .unwrap();
        assert_eq!(*seen.lock().unwrap(), ["a", "b", "c"]);
    }

    #[tokio::test]
    async fn project_and_retry_prepare_session_redaction_without_rebuilding_other_projects() {
        for retry_only in [false, true] {
            let home = tempfile::tempdir().unwrap();
            std::env::set_var("ORKA_TEST_HOME", home.path());
            let mut db = db::open().unwrap();
            let owner = uuid::Uuid::new_v4().to_string();
            db::set(&db, "user", &json!(owner)).unwrap();
            // An older candidate may have changed bytes under a used request
            // ID. Even safe rows from that candidate must be reconciled once.
            db::set(&db, "sessionOutboxRedacted", &json!(true)).unwrap();
            let secret = "sk-abcdefghijklmnopqrstuvwx";
            let bytes = native::encode(&[
                json!({"type":"user","message":{"role":"user","content":format!("Use {secret}")}}),
            ]);
            let hash = db::blob(&bytes).unwrap();
            let mut requests = Vec::new();
            for project in ["a", "b"] {
                db::upsert(&db, "projects", project, "", &json!({"id":project})).unwrap();
                let input = json!({"id":format!("old-{project}"),"projectId":project,"resource":{"resourceId":format!("session-{project}"),"kind":"session","source":"claude","title":format!("Use {secret}"),"files":[{"path":"session.jsonl","hash":hash,"size":bytes.len()}]}});
                indexer::queue(&db, project, "/v2/sync/push", &input).unwrap();
                requests.push(input);
            }
            db.execute("UPDATE outbox SET error='422: Session upload blocked'", [])
                .unwrap();
            let project = json!({"id":"a"});
            let mut pass = SyncPass::new(&mut db, &owner, retry_only.then_some("a"));
            let prepared = if retry_only {
                pass.prepare().await
            } else {
                pass.prepare_project(&project)
            };
            assert!(prepared.unwrap().is_continue());
            assert_eq!(db::get(pass.db, OUTBOX_REDACTION_KEY).unwrap(), Value::Null);
            assert_eq!(db::get(pass.db, &project_redaction_key("a")).unwrap(), true);
            let replacement = db::get(pass.db, &outbox_redaction_key("old-a")).unwrap();
            assert!(!replacement["value"]["resource"]["title"]
                .as_str()
                .unwrap()
                .contains(secret));
            assert_eq!(
                db::get(pass.db, &outbox_redaction_key("old-b")).unwrap(),
                Value::Null
            );
            // A terminal error cannot hide a row that still needs server-side
            // reconciliation. Its original ID and bytes remain untouched.
            let a = ProjectOutbox::open(pass.db, "a").unwrap();
            assert_eq!(a.queued(pass.db).unwrap()[0]["value"], requests[0]);
            assert!(ProjectOutbox::open(pass.db, "b")
                .unwrap()
                .queued(pass.db)
                .unwrap()
                .is_empty());

            let fresh = json!({"id":"fresh-a","projectId":"a","resource":{"resourceId":"new-a","kind":"session","source":"claude","title":"Safe new request","files":[]}});
            indexer::queue(pass.db, "a", "/v2/sync/push", &fresh).unwrap();
            rebuild_unredacted_outbox(pass.db).unwrap();
            assert_eq!(db::get(pass.db, OUTBOX_REDACTION_KEY).unwrap(), true);
            assert!(db::get(pass.db, &outbox_redaction_key("old-b"))
                .unwrap()
                .is_object());
            assert_eq!(
                db::get(pass.db, &outbox_redaction_key("fresh-a")).unwrap(),
                Value::Null
            );
            assert_eq!(
                db::rows(pass.db, "SELECT value FROM outbox ORDER BY rowid", &[]).unwrap(),
                vec![requests[0].clone(), requests[1].clone(), fresh]
            );
        }
    }

    #[tokio::test]
    async fn removing_an_inactive_project_does_not_record_a_cloud_sync() {
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("ORKA_TEST_HOME", home.path());
        let db = db::open().unwrap();
        db::set(&db, "user", &json!(uuid::Uuid::new_v4().to_string())).unwrap();
        let project = uuid::Uuid::new_v4().to_string();
        db::upsert(
            &db,
            "projects",
            &project,
            "",
            &json!({"id":project,"name":"Offline archive","role":"owner","archivedAt":"2026-11-19T00:00:00Z"}),
        )
        .unwrap();
        let previous = json!({"online":false,"error":"503: Service unavailable","lastSync":"2026-11-18T00:00:00Z","updatedAt":"2026-11-18T01:00:00Z"});
        let outage = json!({"notBefore":SyncQueue::now()+60_000,"attempts":3});
        db::set(&db, "sync", &previous).unwrap();
        db::set(&db, "syncOutage", &outage).unwrap();

        crate::projects::project_command("remove".into(), json!({"projectId":project}))
            .await
            .unwrap();
        assert_eq!(db::get(&db, "sync").unwrap(), previous);
        // The real command queues a User job, which bypasses the outage hold.
        // With no service configured, only the skipped-project path can finish.
        assert_eq!(
            SyncQueue::next(&db, SyncQueue::now())
                .unwrap()
                .unwrap()
                .project,
            project
        );
        let mut queue = SyncQueue::new(SyncQueue::now());
        assert!(queue
            .run_next(&Interval::from_config(&json!({})), run_job)
            .await
            .unwrap());
        assert_eq!(db::get(&db, "sync").unwrap(), previous);
        assert_eq!(db::get(&db, "syncOutage").unwrap(), outage);
        assert!(SyncQueue::states(&db, SyncQueue::now())
            .unwrap()
            .as_array()
            .unwrap()
            .is_empty());
        assert!(db::get(&db, &format!("syncCancelledAt:{project}"))
            .unwrap()
            .is_null());
    }

    #[tokio::test]
    async fn a_cancelled_job_does_not_retry_a_late_job_error() {
        for requested_again in [false, true] {
            let home = tempfile::tempdir().unwrap();
            std::env::set_var("ORKA_TEST_HOME", home.path());
            let db = db::open().unwrap();
            let previous = json!({"online":true,"lastSync":"2026-11-19T00:00:00Z"});
            db::set(&db, "sync", &previous).unwrap();
            let project = uuid::Uuid::new_v4().to_string();
            SyncQueue::request(&db, &project, Priority::User, "sync now").unwrap();
            let app = db::open().unwrap();
            let mut queue = SyncQueue::new(SyncQueue::now());
            assert!(queue
                .run_next(&Interval::from_config(&json!({})), async |db, job| {
                    SyncQueue::cancel(&app, &project)?;
                    if requested_again {
                        SyncQueue::request(&app, &project, Priority::Local, "new change")?;
                    }
                    // No signed-in user: sync_job returns an error before its
                    // final cancellation check, just as a failed request can.
                    run_job(db, job).await
                })
                .await
                .unwrap());
            assert_eq!(db::get(&db, "sync").unwrap(), previous);
            let pending = SyncQueue::next(&db, SyncQueue::now()).unwrap();
            assert_eq!(pending.is_some(), requested_again);
            if let Some(job) = pending {
                assert_eq!(job.project, project);
            }
        }
    }

    #[tokio::test]
    async fn another_profile_waits_for_the_shared_sync_slot() {
        let base = tempfile::tempdir().unwrap();
        let first = SyncSlot::acquire(base.path()).await.unwrap();
        let mut second = std::pin::pin!(SyncSlot::acquire(base.path()));
        tokio::select! {
            biased;
            _ = &mut second => panic!("second profile entered an occupied slot"),
            _ = std::future::ready(()) => {}
        }
        drop(first);
        tokio::time::timeout(Duration::from_secs(2), second)
            .await
            .unwrap()
            .unwrap();
    }

    #[tokio::test]
    async fn project_jobs_prepare_new_session_copies_without_preparing_other_projects() {
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("ORKA_TEST_HOME", home.path());
        std::env::set_var("CODEX_HOME", home.path().join(".codex"));
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path().join(".claude"));
        let root = home.path().join("project");
        fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let mut db = db::open().unwrap();
        let owner = uuid::Uuid::new_v4().to_string();
        db::set(&db, "user", &json!(owner)).unwrap();
        let project = json!({"id":uuid::Uuid::new_v4().to_string(),"name":"Project","path":root});
        let project_id = project["id"].as_str().unwrap();
        db::upsert(&db, "projects", project_id, "", &project).unwrap();

        let native_id = uuid::Uuid::new_v4().to_string();
        let resource = uuid::Uuid::new_v4().to_string();
        let directory = native::claude_home().unwrap().join("projects/test");
        fs::create_dir_all(&directory).unwrap();
        let path = directory.join(format!("{native_id}.jsonl"));
        let bytes = native::encode(&[
            json!({"type":"user","cwd":root,"sessionId":native_id,"version":"2.1.286","message":{"role":"user","content":"A teammate session continued here"}}),
        ]);
        fs::write(&path, &bytes).unwrap();
        let base = json!({"resourceId":resource,"projectId":project_id,"owner":uuid::Uuid::new_v4().to_string(),"revision":1,"kind":"session","source":"claude","logicalPath":format!("claude/{native_id}"),"title":"Peer session","deleted":false,"files":[{"path":"session.jsonl","hash":db::blob(&bytes).unwrap(),"size":bytes.len(),"executable":false}]});
        let binding = json!({"nativeId":native_id,"paths":[path],"lastSeenHash":"before-the-local-edit","base":base});
        db::upsert(&db, "bindings", &resource, project_id, &binding).unwrap();

        // An unrelated project has an unavailable copy source. It must neither
        // block this project nor acquire a request as a side effect of its job.
        let other_project = uuid::Uuid::new_v4().to_string();
        let other_resource = uuid::Uuid::new_v4().to_string();
        db::upsert(
            &db,
            "projects",
            &other_project,
            "",
            &json!({"id":other_project}),
        )
        .unwrap();
        let other = json!({"needsCopy":true,"base":{"resourceId":other_resource,"projectId":other_project,"revision":0}});
        db::upsert(&db, "bindings", &other_resource, &other_project, &other).unwrap();

        let mut pass = SyncPass::new(&mut db, &owner, None);
        // No service is configured: the first network attempt fails, after
        // preparation has durably frozen this project's copy for retry.
        assert_eq!(
            pass.sync_project(&project).await.unwrap_err(),
            "Configure the service"
        );
        let copy = indexer::binding(pass.db, &resource).unwrap();
        assert_eq!(copy["needsCopy"], true);
        assert!(copy["copyRequest"].is_string());
        let queued = db::rows(
            pass.db,
            "SELECT json_object('project',project,'path',path,'value',json(value)) FROM outbox",
            &[],
        )
        .unwrap();
        assert_eq!(queued.len(), 1);
        assert_eq!(queued[0]["project"], project_id);
        assert_eq!(queued[0]["path"], "/v2/sessions/copy");
        assert_eq!(queued[0]["value"]["id"], copy["copyRequest"]);
        assert_eq!(queued[0]["value"]["expectedRevision"], 1);
        assert!(indexer::binding(pass.db, &other_resource).unwrap()["copyRequest"].is_null());

        assert_eq!(
            pass.sync_project(&project).await.unwrap_err(),
            "Configure the service"
        );
        assert_eq!(
            indexer::binding(pass.db, &resource).unwrap()["copyRequest"],
            copy["copyRequest"]
        );
        assert_eq!(
            db::rows(pass.db, "SELECT value FROM outbox", &[])
                .unwrap()
                .len(),
            1
        );
    }

    fn queued(sequence: i64, resource: &str) -> Value {
        json!({"sequence":sequence,"id":format!("request-{sequence}"),"project":"project","path":"/v2/sync/push","value":{"resource":{"resourceId":resource,"kind":"memory"}}})
    }

    #[test]
    fn only_known_memory_consolidation_failures_are_deferred() {
        let memory = queued(1, "memory");
        for path in [
            "/v2/sync/push",
            crate::context_sharing::QUEUE_PATH,
            crate::selective_sharing::QUEUE_PATH,
        ] {
            let mut shared = memory.clone();
            shared["path"] = json!(path);
            assert!(
                consolidation_pending(
                    &shared,
                    "503: Memory consolidation pending: jev_missing_key"
                ),
                "{path}"
            );
        }
        for reason in [
            "jev_uncertain",
            "jev_http_503",
            "jev_network",
            "invalid_answers",
        ] {
            assert!(consolidation_pending(
                &memory,
                &format!("503: Memory consolidation pending: {reason}")
            ));
        }
        for error in [
            "503: Service unavailable",
            "503: Blob upload rejected",
            "401: Sign in required",
            "429: Rate limited",
            "Cloud unavailable; local work stays queued",
            "503: Memory consolidation pending: unknown_reason",
            "503: Memory consolidation pending: jev_http_invalid",
        ] {
            assert!(!consolidation_pending(&memory, error), "{error}");
        }
        let mut other = memory.clone();
        other["value"]["resource"]["kind"] = json!("skill");
        assert!(!consolidation_pending(
            &other,
            "503: Memory consolidation pending: jev_uncertain"
        ));
        other = memory;
        other["path"] = json!("/v2/sessions/resolve");
        assert!(!consolidation_pending(
            &other,
            "503: Memory consolidation pending: jev_uncertain"
        ));
    }

    #[test]
    fn capped_batches_rotate_past_pending_rows_and_missing_cursor_rows() {
        let mut queue: Vec<_> = (1..=101)
            .map(|sequence| queued(sequence, &format!("memory-{sequence}")))
            .collect();
        let first = select_uploads(&queue, 0);
        assert_eq!(first.len(), 100);
        let cursor = first.last().unwrap()["sequence"].as_i64().unwrap();
        assert_eq!(cursor, 100);
        assert_eq!(select_uploads(&queue, cursor)[0]["sequence"], 101);
        // The stored cursor still works after its successful row is deleted or
        // after a process restart. New rows and wrapped older rows remain fair.
        queue.retain(|q| q["sequence"] != cursor);
        let next = select_uploads(&queue, cursor);
        assert_eq!(next.len(), 100);
        assert_eq!(next[0]["sequence"], 101);
        assert_eq!(next[1]["sequence"], 1);
        assert_eq!(select_uploads(&queue, 1000)[0]["sequence"], 1);
    }

    fn outbox_db(projects: &[&str]) -> (tempfile::TempDir, rusqlite::Connection) {
        let root = tempfile::tempdir().unwrap();
        let db = db::open_at(root.path()).unwrap();
        for id in projects {
            db.execute(
                "INSERT INTO projects VALUES(?,?)",
                params![id, json!({"id": id}).to_string()],
            )
            .unwrap();
        }
        (root, db)
    }

    fn enqueue(db: &rusqlite::Connection, project: &str, resource: &str) -> i64 {
        let value = json!({"resource":{"resourceId":resource,"kind":"memory"}});
        db.execute(
            "INSERT INTO outbox VALUES(?,?,'/v2/sync/push',?,NULL)",
            params![
                format!("{project}-{resource}-{}", db.last_insert_rowid() + 1),
                project,
                value.to_string()
            ],
        )
        .unwrap();
        db.last_insert_rowid()
    }

    fn batch(db: &rusqlite::Connection, project: &str) -> Vec<i64> {
        let outbox = ProjectOutbox::open(db, project).unwrap();
        let queued = outbox.queued(db).unwrap();
        outbox
            .batch(&queued)
            .iter()
            .map(|q| q["sequence"].as_i64().unwrap())
            .collect()
    }

    #[test]
    fn project_upload_cursors_start_from_the_old_global_cursor() {
        let (_root, db) = outbox_db(&["a", "b"]);
        db::set(&db, "syncUploadCursor", &json!(7)).unwrap();
        db::set(&db, "syncUploadCursor:b", &json!(3)).unwrap();
        assert_eq!(ProjectOutbox::open(&db, "a").unwrap().cursor, 7);
        assert!(db::get(&db, "syncUploadCursor").unwrap().is_null());
        // A cursor the project already owns is never replaced by the old one.
        assert_eq!(db::get(&db, "syncUploadCursor:b").unwrap(), 3);
        db::set(&db, "syncUploadCursor:a", &json!(9)).unwrap();
        assert_eq!(ProjectOutbox::open(&db, "a").unwrap().cursor, 9);
        // A project added after the migration starts from the beginning.
        assert_eq!(ProjectOutbox::open(&db, "c").unwrap().cursor, 0);
    }

    #[test]
    fn project_batches_reconcile_fenced_terminal_rows_without_overtaking_them() {
        let (_root, db) = outbox_db(&["a", "b"]);
        let fenced = enqueue(&db, "a", "session");
        let later = enqueue(&db, "a", "session");
        let other = enqueue(&db, "a", "independent");
        let terminal = enqueue(&db, "a", "terminal");
        let peer = enqueue(&db, "b", "peer-session");
        for sequence in [fenced, later, peer] {
            db.execute(
                "UPDATE outbox SET value=json_set(value,'$.resource.kind','session') WHERE rowid=?",
                [sequence],
            )
            .unwrap();
        }
        for sequence in [fenced, terminal, peer] {
            db.execute(
                "UPDATE outbox SET error='422: Session upload blocked' WHERE rowid=?",
                [sequence],
            )
            .unwrap();
        }
        for sequence in [fenced, peer] {
            let id: String = db
                .query_row("SELECT id FROM outbox WHERE rowid=?", [sequence], |row| {
                    row.get(0)
                })
                .unwrap();
            db::set(&db, &outbox_redaction_key(&id), &json!({"drop":true})).unwrap();
        }
        assert_eq!(batch(&db, "a"), vec![fenced, other]);
        assert_eq!(batch(&db, "b"), vec![peer]);
        // A rotated cursor still cannot let a later edit of the same session
        // overtake the fenced request while its service outcome is unknown.
        let mut outbox = ProjectOutbox::open(&db, "a").unwrap();
        outbox.advance(&db, &json!(other)).unwrap();
        assert_eq!(batch(&db, "a"), vec![fenced, other]);
        db.execute("DELETE FROM outbox WHERE rowid=?", [fenced])
            .unwrap();
        assert_eq!(batch(&db, "a"), vec![later, other]);
    }

    #[test]
    fn projects_drain_independently_without_overtaking_a_resource() {
        let (_root, db) = outbox_db(&["a", "b"]);
        let a1 = enqueue(&db, "a", "shared");
        let b1 = enqueue(&db, "b", "note");
        let a2 = enqueue(&db, "a", "independent");
        let a3 = enqueue(&db, "a", "shared");
        let b2 = enqueue(&db, "b", "other");
        assert_eq!(batch(&db, "a"), vec![a1, a2]);
        assert_eq!(batch(&db, "b"), vec![b1, b2]);
        // A rotates past its first edit; its later edit of the same resource
        // still waits behind it, and B's batch does not move.
        let mut a = ProjectOutbox::open(&db, "a").unwrap();
        a.advance(&db, &json!(a1)).unwrap();
        assert_eq!(batch(&db, "a"), vec![a2, a1]);
        assert_eq!(batch(&db, "b"), vec![b1, b2]);
        db.execute("DELETE FROM outbox WHERE rowid=?", [a1])
            .unwrap();
        assert_eq!(batch(&db, "a"), vec![a2, a3]);
        let mut b = ProjectOutbox::open(&db, "b").unwrap();
        b.advance(&db, &json!(b2)).unwrap();
        assert_eq!(batch(&db, "b"), vec![b1, b2]);
        assert_eq!(batch(&db, "a"), vec![a2, a3]);
    }

    #[test]
    fn only_a_cancelled_project_stops_at_a_stage_boundary() {
        let (_root, db) = outbox_db(&[]);
        let project = uuid::Uuid::new_v4().to_string();
        assert!(boundary(&db, &project).unwrap().is_continue());
        SyncQueue::mark_cancelled(&db, &project).unwrap();
        assert!(boundary(&db, &project).unwrap().is_break());
        assert!(boundary(&db, &uuid::Uuid::new_v4().to_string())
            .unwrap()
            .is_continue());
    }

    #[tokio::test]
    async fn a_cancelled_job_stops_before_its_next_request_and_keeps_the_outbox() {
        let (_root, db) = outbox_db(&[]);
        let project = uuid::Uuid::new_v4().to_string();
        db.execute(
            "INSERT INTO projects VALUES(?,?)",
            params![project, json!({"id": project}).to_string()],
        )
        .unwrap();
        db::set(&db, "user", &json!(uuid::Uuid::new_v4().to_string())).unwrap();
        let mut db = db;
        enqueue(&db, &project, "memory");
        enqueue(&db, &project, "skill");
        SyncQueue::request(&db, &project, Priority::User, "sync now").unwrap();
        let job = SyncQueue::next(&db, i64::MAX - 1).unwrap().unwrap();
        SyncQueue::mark_cancelled(&db, &project).unwrap();
        let outcome = sync_job(&mut db, &job).await;
        assert!(matches!(outcome, Ok(Outcome::Cancelled)), "{outcome:?}");
        // Nothing already sent is rolled back and nothing unsent is dropped.
        assert_eq!(
            db::rows(&db, "SELECT value FROM outbox", &[])
                .unwrap()
                .len(),
            2
        );
    }

    #[test]
    fn rotated_batches_do_not_overtake_a_pending_resource() {
        let mut later = queued(3, "blocked");
        later["path"] = json!("/v2/sessions/resolve");
        later["value"] = json!({"resourceId":"blocked"});
        let queue = vec![queued(1, "blocked"), queued(2, "independent"), later];
        let batch = select_uploads(&queue, 1);
        assert_eq!(
            batch
                .iter()
                .map(|q| q["sequence"].as_i64().unwrap())
                .collect::<Vec<_>>(),
            vec![2, 1]
        );
    }
}

#[cfg(test)]
#[path = "capture_tests.rs"]
mod capture_tests;
