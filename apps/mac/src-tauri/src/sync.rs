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
        return Err(format!(
            "{}: {}",
            status.as_u16(),
            value["error"].as_str().unwrap_or("Service unavailable")
        ));
    }
    Ok(value)
}

pub(crate) async fn register_device(owner: &str, origin: &str, device: &str) -> Result<()> {
    let mut registration =
        json!({"id":device,"name":std::env::var("HOSTNAME").unwrap_or("Mac".into())});
    if api_at(owner, origin, "GET", "/v2/projects/capabilities", None)
        .await
        .is_ok_and(|caps| caps["deviceHardware"] == 1)
    {
        registration["hardwareFamily"] = json!(crate::device_metadata::local_family(&db::open()?)?);
    }
    api_at(owner, origin, "POST", "/v2/devices", Some(&registration)).await?;
    Ok(())
}
pub(crate) async fn upload(owner: &str, project: &str, files: &[Value]) -> Result<()> {
    packages::reject_env_files(files).map_err(|e| format!("Local upload: {e}"))?;
    for f in files {
        let hash = f["hash"].as_str().ok_or("Local upload: missing hash")?;
        let bytes = db::blob_read(hash).map_err(|e| format!("Local upload: {e}"))?;
        let response = request(owner, "PUT", &format!("/v2/blobs/{project}/{hash}"))
            .await?
            .body(bytes)
            .send()
            .await
            .map_err(|_| "Blob upload failed; retry retained")?;
        if !response.status().is_success() {
            return Err(format!(
                "{}: Blob upload rejected",
                response.status().as_u16()
            ));
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
    db.execute("DELETE FROM meta WHERE key=?", [copy_state_key(id)])
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
    if path == "/v2/sessions/copy" {
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
        let memory = indexer::claude_memory(&root)?;
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
) -> Result<Value> {
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
    binding["paths"] = json!(paths);
    let guards = live_hash(&binding, "skill", root)?;
    let empty = indexer::manifest_hash(&json!([]));
    let base = indexer::manifest_hash(&binding["base"]["files"]);
    let incoming = indexer::manifest_hash(&resource["files"]);
    if guards
        .iter()
        .any(|hash| hash != &empty && hash != &base && hash != &incoming)
    {
        binding["installationState"] = json!("locally_modified");
        binding["availableRevision"] = resource["revision"].clone();
        db::upsert(
            db,
            "bindings",
            resource["resourceId"].as_str().ok_or("Missing resource")?,
            project["id"].as_str().ok_or("Missing project")?,
            &binding,
        )?;
        return Err(
            "Local skill edits preserved; resolve them before applying the shared update".into(),
        );
    }
    binding["reviewedRevision"] = resource["revision"].clone();
    binding["guards"] = json!(guards);
    binding["installationState"] = json!("current");
    Ok(binding)
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

pub fn materialize(db: &rusqlite::Connection, project: &Value, resource: &Value) -> Result<()> {
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
        b = automatic_skill_binding(db, project, resource, b)?;
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
    if b["base"]["revision"] == resource["revision"] && b["base"]["deleted"] == resource["deleted"]
    {
        if kind == "skill" {
            crate::codex_skills::queue(db, project, false)?;
        }
        return db::upsert(db, "bindings", id, project_id, &b);
    }
    let pending:bool=db.query_row("SELECT EXISTS(SELECT 1 FROM outbox WHERE json_extract(value,'$.resource.resourceId')=? OR json_extract(value,'$.resourceId')=?)",params![id,id],|r|r.get(0)).map_err(|e|e.to_string())?;
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
    if kind == "session" && resource["source"] == "codex" && resource["deleted"] != true {
        // Sync keeps snapshots in Orka. Only an explicit launch creates native history.
        if b["nativeId"].is_string() {
            b["availableRevision"] = resource["revision"].clone();
        } else {
            crate::history::History::resource(resource)?;
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
                } else if resource["source"] == "claude" && kind == "memory" {
                    indexer::claude_memory(&root)?
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
            fs::create_dir_all(&base).map_err(|e| e.to_string())?;
            packages::write_file(&base, &path, files.first().ok_or("Missing plan file")?)?;
            vec![path]
        } else {
            let (base, path) = if project["governed"] != true
                && b["paths"].is_array()
                && resource["source"] == "claude"
            {
                (
                    indexer::claude_memory(&root)?,
                    PathBuf::from(b["paths"][0].as_str().ok_or("Invalid memory path")?),
                )
            } else {
                project_memory(project, resource)?
            };
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

    async fn sync_project(&mut self, p: &Value) -> Stage {
        let project = p["id"].as_str().ok_or("Missing project")?;
        if boundary(self.db, project)?.is_break()
            || self.prepare_project(p)?.is_break()
            || boundary(self.db, project)?.is_break()
            || self.preflight(p)?.is_break()
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
        for source in crate::sources::views(project) {
            crate::repair::project_state(self.db, &source)?;
        }
        packages::recover_project_installations(self.db, project)?;
        Ok(Continue(()))
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
    fn preflight(&mut self, p: &Value) -> Stage {
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
        match preflight_project(db, p, retry_only) {
            Ok(()) => {
                if !retry_only {
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
        register_device(owner, &origin, &device).await?;
        let projects = api_as(owner, "GET", "/v2/projects?includeArchived=true", None).await?;
        crate::projects::merge_catalog(db, &projects)?;
        Ok(Continue(()))
    }

    /// Refreshes a governed project's permissions; a failure blocks its uploads and pull.
    async fn authorize(&mut self, p: &Value) -> Stage {
        let db = &mut *self.db;
        let owner = self.owner;
        let retry_only = self.mode == ProjectMode::RetryOnly;
        let blocked_projects = &mut self.blocked;
        if crate::projects::foreground_waiting()? {
            return Ok(Break(()));
        }
        if p["governed"] == true {
            let id = p["id"].as_str().ok_or("Missing project")?;
            let result: Result<()> = async {
                let local = crate::governance::project(db, id)?;
                if !retry_only {
                    crate::governance::localize_outbox(db, &local)?;
                } else {
                    crate::governance::block_legacy_retry(db, &local)?;
                }
                let catalog = api_as(
                    owner,
                    "POST",
                    "/v2/governance/action",
                    Some(&json!({"action":"catalog","input":{"projectId":id}})),
                )
                .await?;
                db::set(db, &format!("governance:{id}"), &catalog)?;
                if !retry_only {
                    crate::context_sharing::approve_own_pending(db, owner, &local, &catalog)
                        .await?;
                }
                Ok(())
            }
            .await;
            if result.as_ref().is_err_and(|e| service_error(e)) {
                return result.map(Continue);
            }
            if result.is_err() {
                blocked_projects.insert(id.to_string());
            }
            record_result(db, &format!("{id}:permissions"), result)?;
        }
        Ok(Continue(()))
    }

    /// Sends this project's queued changes from its own upload cursor.
    async fn drain_outbox(&mut self, p: &Value) -> Stage {
        let device = self.device()?;
        let db = &mut *self.db;
        let owner = self.owner;
        let deferred = &mut self.deferred;
        let project = p["id"].as_str().ok_or("Missing project")?;
        if self.blocked.contains(project) {
            return Ok(Continue(()));
        }
        let mut outbox = ProjectOutbox::open(db, project)?;
        let queued: Vec<_> = outbox
            .queued(db)?
            .into_iter()
            .filter(|q| {
                if q["path"] == crate::selective_sharing::QUEUE_PATH {
                    crate::selective_sharing::authorized(db, q).unwrap_or(false)
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
        for (index, q) in uploads.iter().enumerate() {
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
                    return crate::selective_sharing::send(db, owner, q).await;
                }
                if q["path"] == crate::context_sharing::QUEUE_PATH {
                    crate::context_sharing::upload(db, owner, q).await?;
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
                    return crate::context_sharing::share(db, owner, q).await;
                }
                api_as(
                    owner,
                    "POST",
                    q["path"].as_str().ok_or("Missing upload path")?,
                    Some(&input),
                )
                .await
            }
            .await;
            match result {
                Ok(receipt) => {
                    let tx = db.transaction().map_err(|e| e.to_string())?;
                    if q["path"] == crate::selective_sharing::QUEUE_PATH {
                        crate::selective_sharing::complete(&tx, q, &receipt)?;
                    } else if q["path"] == crate::global_skills::IMPORT_PATH
                        || q["path"] == crate::context_sharing::QUEUE_PATH
                    {
                        crate::context_sharing::complete(&tx, q, &receipt)?;
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
                    db.execute(
                        "UPDATE outbox SET error=? WHERE id=?",
                        params![error, q["id"].as_str()],
                    )
                    .map_err(|e| e.to_string())?;
                    if consolidation_pending(q, &error) || error.starts_with("Local upload: ") {
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
        if self.blocked.contains(p["id"].as_str().unwrap_or("")) {
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
        let scan = preflight_project(db, p, retry_only);
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
    .collect::<Vec<_>>();
    for p in &local {
        if pass.preflight(p)?.is_break() {
            return Ok(WorkspaceSync::Yielded);
        }
    }
    if pass.connect().await?.is_break() {
        return Ok(WorkspaceSync::Yielded);
    }
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
    .collect::<Vec<_>>();
    for p in &local {
        if pass.authorize(p).await?.is_break() {
            return Ok(WorkspaceSync::Yielded);
        }
    }
    for p in &local {
        if pass.drain_outbox(p).await?.is_break() {
            return Ok(WorkspaceSync::Yielded);
        }
    }
    for p in &local {
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
        !pass.deferred.is_empty() || has_errors,
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
    let previous = db::get(db, "sync")?;
    let status = match &result {
        Ok(Outcome::Yielded | Outcome::Cancelled) => previous,
        Ok(_) => json!({"online":true,"lastSync":db::now(),"updatedAt":db::now()}),
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
    if !matches!(result, Ok(Outcome::Yielded | Outcome::Cancelled)) {
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
    let mut pass = SyncPass::new(db, &owner, None);
    let flow = match project.first() {
        _ if job.project == WORKSPACE => pass.sync_workspace_global().await?,
        Some(p) => pass.sync_project(p).await?,
        // Removed or archived since it was queued.
        None => return Ok(Outcome::Synced),
    };
    let errors: bool = pass
        .db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM errors WHERE source=?1 OR substr(source,1,length(?1)+1)=?1||':' OR source IN (SELECT id FROM resources WHERE project=?1))",
            [&job.project],
            |r| r.get(0),
        )
        .map_err(|e| e.to_string())?;
    Ok(if SyncQueue::cancelled(pass.db, &job.project)? {
        Outcome::Cancelled
    } else if flow.is_break() {
        Outcome::Yielded
    } else if !pass.deferred.is_empty() || errors {
        Outcome::Deferred
    } else {
        Outcome::Synced
    })
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
        db::rows(db, "SELECT json_object('sequence',rowid,'id',id,'project',project,'path',path,'value',json(value),'error',error) FROM outbox WHERE project=? AND (error IS NULL OR error NOT GLOB '4[0-9][0-9]:*' OR substr(error,1,3) IN ('401','408','429')) ORDER BY rowid", &[&self.project])
    }

    fn batch<'q>(&self, queued: &'q [Value]) -> Vec<&'q Value> {
        select_uploads(queued, self.cursor)
    }

    fn advance(&mut self, db: &rusqlite::Connection, sequence: &Value) -> Result<()> {
        self.cursor = sequence.as_i64().unwrap_or(self.cursor);
        db::set(db, &self.cursor_key, sequence)
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

pub fn terminal_error(error: &str) -> bool {
    let code = error
        .split_once(':')
        .and_then(|(s, _)| s.parse::<u16>().ok());
    matches!(code, Some(400..=499)) && !matches!(code, Some(401 | 408 | 429))
}
async fn heartbeat() -> Result<()> {
    if crate::projects::foreground_waiting()? {
        return Ok(());
    }
    let _lock = crate::projects::lock()?;
    let db = db::open()?;
    let user = db::get(&db, "user")?;
    let owner = user.as_str().ok_or("Sign in required")?;
    for p in db::rows(
        &db,
        &format!(
            "SELECT value FROM projects WHERE {}",
            crate::projects::ACTIVE
        ),
        &[],
    )? {
        if crate::projects::foreground_waiting()? {
            return Ok(());
        }
        let project = p["id"].as_str().ok_or("Missing project")?;
        let mut ids = Vec::new();
        if crate::projects::sharing_allowed(&p, "session") {
            for b in db::rows(&db,"SELECT value FROM bindings WHERE project=? AND json_extract(value,'$.base.kind')='session'",&[&project])?{if let Some(id)=b["nativeId"].as_str(){if native::active(&db,id,b["base"]["source"].as_str().unwrap_or("")){ids.push(b["base"]["resourceId"].clone());}}}
        }
        api_as(
            owner,
            "POST",
            "/v2/presence",
            Some(&json!({"projectId":project,"deviceId":db::device(&db)?,"sessions":ids})),
        )
        .await?;
    }
    Ok(())
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

#[cfg(test)]
mod queue_tests {
    use super::*;

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
