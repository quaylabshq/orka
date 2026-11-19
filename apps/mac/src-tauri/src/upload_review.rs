use crate::{
    db::{self, Result},
    governance, indexer, packages, resource_commands, sources, sync,
    sync_queue::{Priority, SyncQueue},
};
use rusqlite::{params, Connection};
use serde_json::{json, Value};
use std::path::Path;
use uuid::Uuid;

const CHANGED: &str = "The shared plan or queued upload changed. Review the latest versions again.";

pub(crate) fn reviewable(path: &str, error: Option<&str>, resource: &Value) -> bool {
    path == "/v2/sync/push"
        && error.is_some_and(|error| error.starts_with("409:"))
        && resource["kind"] == "plan"
        && resource["deleted"] != true
}

fn active_context(db: &Connection, input: &Value) -> Result<Value> {
    // An existing connection still points at its old account cache after sign-out.
    resource_commands::context(&db::open()?, input)?;
    resource_commands::context(db, input)
}

fn queued(db: &Connection, input: &Value) -> Result<Value> {
    let id = input["uploadId"].as_str().ok_or("Choose a queued upload")?;
    Uuid::parse_str(id).map_err(|_| "Invalid queued upload")?;
    Uuid::parse_str(input["resourceId"].as_str().ok_or("Choose a plan")?)
        .map_err(|_| "Invalid plan")?;
    let row = db::rows(
        db,
        "SELECT json_object('id',id,'project',project,'path',path,'raw',value,'value',json(value),'error',error) FROM outbox WHERE id=?",
        &[&id],
    )?
    .into_iter()
    .next()
    .ok_or(CHANGED)?;
    if row["project"] != input["projectId"]
        || row["value"]["projectId"] != input["projectId"]
        || row["value"]["resource"]["resourceId"] != input["resourceId"]
        || row["value"]["id"] != row["id"]
        || !reviewable(
            row["path"].as_str().unwrap_or(""),
            row["error"].as_str(),
            &row["value"]["resource"],
        )
    {
        return Err(
            "Only a rejected plan upload can be reviewed here. Local work was kept.".into(),
        );
    }
    Ok(row)
}

fn source_identity(project: &Value, resource: &Value) -> Result<Value> {
    let source = sources::registered(project, resource["sourceId"].as_str())?;
    if source["sourceId"] != resource["sourceId"] {
        return Err(CHANGED.into());
    }
    sources::validate(&source)?;
    let live_identity = indexer::folder_identity(Path::new(
        source["path"].as_str().ok_or("Connect this repository")?,
    ))?;
    Ok(
        json!({"sourceId":source["sourceId"],"path":source["path"],"folderIdentity":source["folderIdentity"],"repository":source["repository"],"repositoryRevision":source["repositoryRevision"],"liveFolderIdentity":live_identity}),
    )
}

fn validate_current(project: &Value, input: &Value, row: &Value, current: &Value) -> Result<()> {
    let selected = &row["value"]["resource"];
    if current["projectId"] != input["projectId"]
        || current["resourceId"] != input["resourceId"]
        || current["kind"] != "plan"
        || current["deleted"] == true
        || current["revision"]
            .as_u64()
            .is_none_or(|revision| revision == 0)
        || ["sourceId", "source", "logicalPath"]
            .iter()
            .any(|key| current[key] != selected[key])
    {
        return Err(
            "The shared plan is unavailable or its identity changed. The queued snapshot was kept."
                .into(),
        );
    }
    let can_publish = current["access"]["mode"]
        .as_str()
        .map(|mode| mode == "publish")
        .unwrap_or(project["role"] == "owner" || project["governed"] != true);
    if !can_publish {
        return Err(
            "You no longer have permission to publish this plan. The queued snapshot was kept."
                .into(),
        );
    }
    Ok(())
}

async fn current(input: &Value) -> Result<Value> {
    let owner = input["accountId"].as_str().ok_or("Sign in required")?;
    let origin = input["serviceOrigin"].as_str().ok_or("Choose a service")?;
    let project = input["projectId"].as_str().ok_or("Choose a project")?;
    let mut cursor = 0;
    let mut latest = Value::Null;
    loop {
        let response = sync::api_at(
            owner,
            origin,
            "GET",
            &format!(
                "/v2/sync/pull?projectId={project}&cursor={cursor}&governance=1&policyRevision=-1"
            ),
            None,
        )
        .await?;
        for event in response["events"]
            .as_array()
            .ok_or("Invalid resource feed")?
        {
            let resource = &event["resource"];
            if resource["resourceId"] == input["resourceId"]
                && resource["revision"].as_u64() >= latest["revision"].as_u64()
            {
                latest = resource.clone();
            }
        }
        if response["hasMore"] != true {
            break;
        }
        let next = response["cursor"]
            .as_u64()
            .ok_or("Invalid resource cursor")?;
        if next <= cursor {
            return Err(
                "The service could not refresh this plan. The queued snapshot was kept.".into(),
            );
        }
        cursor = next;
    }
    Ok(latest)
}

pub(crate) fn preview_with_current(
    db: &Connection,
    input: &Value,
    current: &Value,
) -> Result<Value> {
    let project = active_context(db, input)?;
    let row = queued(db, input)?;
    validate_current(&project, input, &row, current)?;
    let source = source_identity(&project, &row["value"]["resource"])?;
    let selected = &row["value"]["resource"];
    packages::reject_env_files(selected["files"].as_array().ok_or("Missing queued files")?)?;
    let (before, before_manifest) = governance::preview_files(&current["files"])?;
    let (files, after_manifest) = governance::preview_files(&selected["files"])?;
    let token = Uuid::new_v4().to_string();
    let expires = chrono::Utc::now().timestamp() + 600;
    db::set(
        db,
        &format!("upload-preview:{token}"),
        &json!({"accountId":input["accountId"],"serviceOrigin":input["serviceOrigin"],"projectId":input["projectId"],"resourceId":input["resourceId"],"uploadId":input["uploadId"],"queue":row,"current":current,"source":source,"expires":expires}),
    )?;
    Ok(
        json!({"previewToken":token,"title":selected["title"],"kind":"plan","revision":current["revision"],"before":before,"files":files,"beforeManifest":before_manifest,"afterManifest":after_manifest,"note":"Only this queued snapshot will be resent against the reviewed shared version. It replaces that shared plan after sync. Files on this Mac are kept; later local edits are not included."}),
    )
}

fn saved_preview(db: &Connection, input: &Value) -> Result<Value> {
    active_context(db, input)?;
    let token = input["previewToken"]
        .as_str()
        .ok_or("Review this upload first")?;
    let preview = db::get(db, &format!("upload-preview:{token}"))?;
    for key in [
        "accountId",
        "serviceOrigin",
        "projectId",
        "resourceId",
        "uploadId",
    ] {
        if preview[key] != input[key] {
            return Err("This upload preview belongs to another item or account.".into());
        }
    }
    if preview["invalidated"] == true {
        return Err(CHANGED.into());
    }
    Ok(preview)
}

fn reject_review(
    db: &Connection,
    input: &Value,
    mut preview: Value,
    error: String,
) -> Result<Value> {
    preview["invalidated"] = json!(true);
    db::set(
        db,
        &format!(
            "upload-preview:{}",
            input["previewToken"].as_str().ok_or("Missing preview")?
        ),
        &preview,
    )?;
    Err(error)
}

pub(crate) fn retry_with_current(db: &Connection, input: &Value, current: &Value) -> Result<Value> {
    let mut preview = saved_preview(db, input)?;
    if preview["result"].is_object() {
        return Ok(preview["result"].clone());
    }
    if preview["expires"].as_i64().unwrap_or(0) < chrono::Utc::now().timestamp() {
        return reject_review(
            db,
            input,
            preview,
            "Upload preview expired. Review the latest versions again.".into(),
        );
    }
    let checked = (|| {
        let project = active_context(db, input)?;
        let row = queued(db, input)?;
        validate_current(&project, input, &row, current)?;
        if row != preview["queue"]
            || current != &preview["current"]
            || source_identity(&project, &row["value"]["resource"])? != preview["source"]
        {
            return Err(CHANGED.into());
        }
        // Keep the reviewed bytes frozen; do not rescan or write the user's files.
        governance::preview_files(&row["value"]["resource"]["files"])?;
        Ok(row)
    })();
    let row = match checked {
        Ok(row) => row,
        Err(error) => return reject_review(db, input, preview, error),
    };
    let request_id = Uuid::new_v4().to_string();
    let mut replacement = row["value"].clone();
    replacement["id"] = json!(request_id);
    replacement["baseRevision"] = current["revision"].clone();
    let result = json!({"status":"queued","requestId":request_id});
    preview["result"] = result.clone();
    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    let removed = tx
        .execute(
            "DELETE FROM outbox WHERE id=? AND project=? AND path=? AND value=? AND error=?",
            params![
                row["id"].as_str(),
                row["project"].as_str(),
                row["path"].as_str(),
                row["raw"].as_str(),
                row["error"].as_str()
            ],
        )
        .map_err(|e| e.to_string())?;
    if removed != 1 {
        return Err(CHANGED.into());
    }
    tx.execute(
        "INSERT INTO outbox VALUES(?,?,?,?,NULL)",
        params![
            request_id,
            row["project"].as_str(),
            row["path"].as_str(),
            replacement.to_string()
        ],
    )
    .map_err(|e| e.to_string())?;
    db::set(
        &tx,
        &format!(
            "upload-preview:{}",
            input["previewToken"].as_str().ok_or("Missing preview")?
        ),
        &preview,
    )?;
    SyncQueue::request(
        &tx,
        input["projectId"].as_str().ok_or("Missing project")?,
        Priority::User,
        "reviewed-upload",
    )?;
    tx.commit().map_err(|e| e.to_string())?;
    Ok(result)
}

pub(crate) async fn preview(db: &Connection, input: &Value) -> Result<Value> {
    let project = active_context(db, input)?;
    let row = queued(db, input)?;
    source_identity(&project, &row["value"]["resource"])?;
    let latest = current(input).await?;
    validate_current(&project, input, &row, &latest)?;
    sync::download(
        input["accountId"].as_str().ok_or("Sign in required")?,
        &latest,
    )
    .await?;
    preview_with_current(db, input, &latest)
}

pub(crate) async fn retry(db: &Connection, input: &Value) -> Result<Value> {
    let preview = saved_preview(db, input)?;
    if preview["result"].is_object() {
        return Ok(preview["result"].clone());
    }
    let latest = current(input).await?;
    retry_with_current(db, input, &latest)
}
