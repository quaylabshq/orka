use crate::{
    db::{self, Result},
    governance, indexer, projects,
    sync_queue::{Priority, SyncQueue},
};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::path::Path;
use uuid::Uuid;

pub const QUEUE_PATH: &str = "/local/context-share";

/// Keep automatic publication metadata on the draft. Older desktops forward
/// unknown fields from the outbox body as part of the strict change contract.
pub(crate) fn automatic_skill_request(db: &Connection, queued: &Value) -> Result<bool> {
    if queued["path"] != crate::global_skills::IMPORT_PATH {
        return Ok(false);
    }
    if queued["value"]["automaticSkillMerge"] == true {
        return Ok(true);
    }
    db.query_row(
        "SELECT EXISTS(SELECT 1 FROM drafts WHERE id=?1 AND project=?2
           AND json_extract(value,'$.automaticMergeRequestId')=?3)",
        rusqlite::params![
            queued["value"]["skillImport"].as_str(),
            queued["project"].as_str(),
            queued["id"].as_str()
        ],
        |row| row.get(0),
    )
    .map_err(|error| error.to_string())
}

/// Prepare persisted skill requests before selecting uploads. Pilot rows can
/// carry an older local marker, a downgraded desktop can refresh their drafts,
/// and a definitive server refusal can outlive the conditions that caused it.
pub(crate) fn reconcile_skill_requests(db: &Connection, project: &str) -> Result<()> {
    let rows = db::rows(db,
        "SELECT json_object('id',o.id,'project',o.project,'path',o.path,'body',o.value,'error',o.error,'draft',d.value)
         FROM outbox o JOIN drafts d ON d.project=o.project AND d.id=json_extract(o.value,'$.skillImport')
         WHERE o.project=?1 AND o.path=?2
           AND (json_extract(o.value,'$.automaticSkillMerge')=1 OR
                (json_extract(d.value,'$.automaticMergeRequestId')=o.id AND
                 (json_extract(d.value,'$.submission') IS NULL OR o.error IN (?3,?4))))",
        &[&project, &crate::global_skills::IMPORT_PATH, &crate::sync::EXACT_REVISION_CONFLICT, &crate::sync::PUBLISH_DENIED])?;
    for mut row in rows {
        let id = row["id"]
            .as_str()
            .ok_or("Missing queued skill request")?
            .to_owned();
        let saved_draft = row["draft"]
            .as_str()
            .ok_or("Missing queued skill draft")?
            .to_owned();
        let draft: Value = serde_json::from_str(&saved_draft).map_err(|error| error.to_string())?;
        let original = row["body"]
            .as_str()
            .ok_or("Missing queued skill change")?
            .to_owned();
        row["value"] = serde_json::from_str(&original).map_err(|error| error.to_string())?;
        let change = wire_change(&row)?;
        // An older refresh-draft can clear these two fields while retaining the
        // outbox. Reattach only the frozen request for this exact captured draft.
        let refreshed = draft["submission"].is_null()
            && draft["requestId"].is_null()
            && (draft["automaticMergeRequestId"] == id
                || (row["value"]["automaticSkillMerge"] == true
                    && draft["automaticMergeCandidate"] == true
                    && draft["skillReconciliation"] == true))
            && change["resource"].as_object().is_some_and(|fields| {
                fields
                    .iter()
                    .all(|(field, value)| draft["resource"].get(field) == Some(value))
            });
        if change["id"] != id
            || change["projectId"] != project
            || (!refreshed && (draft["submission"] != change || draft["requestId"] != id))
        {
            continue;
        }
        if refreshed || row["value"]["automaticSkillMerge"] == true {
            let tx =
                rusqlite::Transaction::new_unchecked(db, rusqlite::TransactionBehavior::Immediate)
                    .map_err(|error| error.to_string())?;
            let draft_id = draft["id"].as_str().ok_or("Missing queued skill draft")?;
            let updated = tx.execute(
                "UPDATE drafts SET value=json_set(value,'$.automaticMergeRequestId',?1,'$.requestId',?1,'$.submission',json(?2))
                 WHERE id=?3 AND project=?4 AND value=?5
                 AND EXISTS(SELECT 1 FROM outbox WHERE id=?1 AND project=?4 AND value=?6)",
                rusqlite::params![id,change.to_string(),draft_id,project,saved_draft,original]
            ).map_err(|error| error.to_string())?;
            if updated != 1 {
                continue;
            }
            if row["value"]["automaticSkillMerge"] == true {
                row["value"]
                    .as_object_mut()
                    .ok_or("Missing queued skill change")?
                    .remove("automaticSkillMerge");
                tx.execute(
                    "UPDATE outbox SET value=?1,error=CASE WHEN error='400: Invalid request' THEN NULL ELSE error END
                     WHERE project=?2 AND id=?3",
                    rusqlite::params![row["value"].to_string(),project,id],
                ).map_err(|error| error.to_string())?;
            }
            tx.commit().map_err(|error| error.to_string())?;
        }
        if row["error"] == crate::sync::EXACT_REVISION_CONFLICT {
            crate::skill_reconciliation::release_stale(
                db,
                &row,
                crate::sync::EXACT_REVISION_CONFLICT,
            )?;
        } else if row["error"] == crate::sync::PUBLISH_DENIED
            && row["value"]["reviewRequired"] != true
            && check_automatic_skill_upload(db, &row).is_ok()
        {
            // Access can change between our last pull and the server check.
            // Retry exactly the original publication after publish access returns.
            db.execute(
                "UPDATE outbox SET error=NULL WHERE project=?1 AND id=?2 AND error=?3 AND value=?4",
                rusqlite::params![
                    project,
                    id,
                    crate::sync::PUBLISH_DENIED,
                    row["value"].to_string()
                ],
            )
            .map_err(|error| error.to_string())?;
        }
    }
    Ok(())
}

pub(crate) fn check_upload_eligibility(db: &Connection, queued: &Value) -> Result<()> {
    if automatic_skill_request(db, queued)? {
        return check_automatic_skill_upload(db, queued)
            .map_err(|error| format!("Local upload: {error}"));
    }
    if queued["path"] != QUEUE_PATH {
        return Ok(());
    }
    let resource = &queued["value"]["resource"];
    let Some(relative) = resource["logicalPath"]
        .as_str()
        .filter(|_| resource["kind"] == "memory")
        .and_then(|path| path.strip_prefix("instructions/"))
    else {
        return Ok(());
    };
    let project = governance::project(db, queued["project"].as_str().ok_or("Missing project")?)?;
    let source = crate::sources::for_resource(&project, resource)
        .ok_or("409: Reconnect the queued instruction's repository before retrying; original queued bytes and request ID preserved")?;
    crate::sources::validate(&source)?;
    let root = Path::new(source["path"].as_str().ok_or("Missing source folder")?);
    let instructions = indexer::instruction_files(root)?;
    if !indexer::instruction_allowed(root, Path::new(relative), &instructions)? {
        return Err("409: Queued instruction is now ignored or excluded; review its source in Orka before retrying. Original queued bytes and request ID preserved".into());
    }
    Ok(())
}

// Local eligibility can recover after a role or repository change. Keep these
// failures retryable and distinct from a definitive HTTP refusal.
fn check_automatic_skill_upload(db: &Connection, queued: &Value) -> Result<()> {
    let project_id = queued["project"].as_str().ok_or("Missing project")?;
    let project = governance::project(db, project_id)?;
    let skill = &queued["value"]["resource"];
    let current = governance::resource(db, skill["resourceId"].as_str().ok_or("Missing skill")?)?;
    // A newer tombstone cannot be overwritten by this governed exact-base
    // request. Retrying its original ID retrieves a lost receipt or a definitive
    // stale rejection so the local draft can settle.
    let newer_revision = current["revision"]
        .as_u64()
        .zip(queued["value"]["baseRevision"].as_u64())
        .is_some_and(|(current, base)| current > base);
    if project["governed"] != true
        || project["sharing"]["skill"] != true
        || current["projectId"] != project_id
        || current["sourceId"] != skill["sourceId"]
        || current["kind"] != "skill"
        || (current["deleted"] == true && !newer_revision)
        || !(current["access"]["mode"] == "publish"
            || (queued["value"]["reviewRequired"] == true
                && current["access"]["mode"] == "suggest"))
    {
        return Err("Automatic skill publication needs sharing and publish access. The queued edit is preserved.".into());
    }
    let source = crate::sources::for_resource(&project, skill)
        .filter(|source| source["firstSyncWaiting"] != true)
        .ok_or("Reconnect the skill's source folder to resume automatic publication.")?;
    crate::sources::validate(&source)
}

pub(crate) async fn upload(db: &Connection, owner: &str, queued: &Value) -> Result<()> {
    check_upload_eligibility(db, queued)?;
    crate::repair::upload(
        owner,
        queued["project"].as_str().ok_or("Missing project")?,
        &queued["value"]["resource"],
    )
    .await
}

pub fn require_active_source(project: &Value, draft: &Value) -> Result<()> {
    if draft["sourceRemoval"].is_object() || !project["removedAt"].is_null() {
        return Err(
            "Source folder removed. These saved changes remain private on this Mac.".into(),
        );
    }
    if let Some(id) = draft["resource"]["sourceId"].as_str() {
        crate::sources::registered(project, Some(id))?;
    }
    Ok(())
}

fn preserve_removed_draft(db: &Connection, project: &Value, draft: &mut Value) -> Result<bool> {
    if let Some(source) = project["sources"].as_array().and_then(|sources| {
        sources.iter().find(|source| {
            source["id"] == draft["resource"]["sourceId"] && !source["removedAt"].is_null()
        })
    }) {
        if draft["sourceRemoval"]["sourceId"] == source["id"]
            && draft["sourceRemoval"]["removedAt"] == source["removedAt"]
            && draft["automaticSharing"] == false
        {
            return Ok(true);
        }
        if !draft["sourceRemoval"].is_object() {
            draft["sourceRemoval"] = json!({});
        }
        draft["sourceRemoval"]["sourceId"] = source["id"].clone();
        draft["sourceRemoval"]["removedAt"] = source["removedAt"].clone();
        draft["automaticSharing"] = json!(false);
        db::upsert(
            db,
            "drafts",
            draft["id"].as_str().ok_or("Missing draft")?,
            project["id"].as_str().ok_or("Missing project")?,
            draft,
        )?;
        return Ok(true);
    }
    Ok(draft["sourceRemoval"].is_object())
}

pub fn publication_id(db: &Connection, project: &str, resource: &Value) -> Result<String> {
    let original = resource["resourceId"].as_str().ok_or("Missing resource")?;
    if resource["kind"] == "memory" && resource["source"] != "shared" {
        // Reuse earlier promotions, including requests created before automatic sharing.
        let previous = db::rows(db, "SELECT value FROM drafts WHERE project=? AND json_extract(value,'$.resource.resourceId')=? AND json_extract(value,'$.submission.resource.resourceId') IS NOT NULL ORDER BY rowid LIMIT 1", &[&project, &original])?;
        return Ok(previous
            .first()
            .and_then(|draft| draft["submission"]["resource"]["resourceId"].as_str())
            .map(str::to_owned)
            .unwrap_or_else(|| {
                Uuid::new_v5(
                    &Uuid::NAMESPACE_URL,
                    format!(
                        "selected-memory:{}:{}",
                        json!(project),
                        resource["resourceId"]
                    )
                    .as_bytes(),
                )
                .to_string()
            }));
    }
    Ok(original.to_owned())
}

pub fn publication_resource(db: &Connection, project: &str, resource: &Value) -> Result<Value> {
    let id = publication_id(db, project, resource)?;
    let mut resource = resource.clone();
    if resource["kind"] == "memory" && resource["source"] != "shared" {
        resource["memory"] = json!({"topic":resource["title"].as_str().unwrap_or("Shared memory").chars().take(160).collect::<String>(),"scope":"","provider":resource["source"],"supersedes":[]});
        resource["resourceId"] = json!(id);
        if let Some(sources) = resource["contextSources"].as_array_mut() {
            sources.retain(|source| source != &id);
        }
        resource["source"] = json!("shared");
        resource["logicalPath"] = json!(format!("knowledge/{id}.md"));
    }
    Ok(resource)
}

pub fn publication_mode(db: &Connection, project: &str, resource: &Value) -> Result<String> {
    let catalog = db::get(db, &format!("governance:{project}"))?;
    if catalog["owner"] == true {
        return Ok("publish".into());
    }
    let resource = publication_resource(db, project, resource)?;
    let existing = db::rows(
        db,
        "SELECT value FROM resources WHERE id=? AND project=?",
        &[&resource["resourceId"].as_str(), &project],
    )?;
    if let Some(existing) = existing.first() {
        return Ok(existing["access"]["mode"]
            .as_str()
            .unwrap_or("hidden")
            .into());
    }
    let category = if governance::protected(&resource) && resource["kind"] == "memory" {
        "instructions"
    } else {
        resource["kind"]
            .as_str()
            .ok_or("Missing resource category")?
    };
    Ok(catalog["access"][category]["create"]
        .as_str()
        .unwrap_or("hidden")
        .into())
}

pub fn queue_automatic(db: &Connection, project: &Value, draft_id: &str) -> Result<()> {
    let project_id = project["id"].as_str().ok_or("Missing project")?;
    let mut draft = db::rows(
        db,
        "SELECT value FROM drafts WHERE id=? AND project=?",
        &[&draft_id, &project_id],
    )?
    .into_iter()
    .next()
    .ok_or("Draft unavailable")?;
    if preserve_removed_draft(db, project, &mut draft)?
        || require_active_source(project, &draft).is_err()
    {
        return Ok(());
    }
    if matches!(draft["resource"]["kind"].as_str(), Some("memory" | "skill"))
        && draft["status"] == "local"
        && draft["conflictReview"] != true
        && matches!(
            publication_mode(db, project_id, &draft["resource"])?.as_str(),
            "publish" | "suggest"
        )
    {
        if project["deferAutomaticSharing"] == true {
            let mut draft = draft;
            draft["automaticSharing"] = json!(true);
            db::upsert(db, "drafts", draft_id, project_id, &draft)?;
        } else {
            queue(db, project, draft_id)?;
        }
    }
    Ok(())
}

pub fn queue_waiting(db: &Connection, project: &Value) -> Result<()> {
    let project_id = project["id"].as_str().ok_or("Missing project")?;
    for mut draft in db::rows(db, "SELECT value FROM drafts WHERE project=? AND json_extract(value,'$.status')='local' AND json_extract(value,'$.automaticSharing')=1 AND json_extract(value,'$.submission') IS NULL ORDER BY rowid", &[&project_id])? {
        if preserve_removed_draft(db, project, &mut draft)? { continue; }
        let latest = governance::latest_draft(db,project_id,draft["resource"]["resourceId"].as_str().ok_or("Missing resource")?)?;
        if latest.as_ref().is_none_or(|latest|latest["id"]!=draft["id"]) { continue; }
        if projects::sharing_allowed(project, draft["resource"]["kind"].as_str().unwrap_or("")) {
            queue_automatic(db, project, draft["id"].as_str().ok_or("Missing draft")?)?;
        }
    }
    Ok(())
}

pub async fn approve_own_pending(
    db: &Connection,
    owner: &str,
    project: &Value,
    catalog: &Value,
) -> Result<()> {
    let project_id = project["id"].as_str().ok_or("Missing project")?;
    db.execute(
        "DELETE FROM errors WHERE source GLOB ?",
        [format!("{project_id}:publish:*")],
    )
    .map_err(|error| error.to_string())?;
    let mut catalog = catalog.clone();
    for request in pending_publications(db, owner, project, &catalog)? {
        let result = crate::sync::api_as(owner, "POST", "/v2/governance/action", Some(&json!({"action":"decide","input":{"projectId":project_id,"id":request["id"],"decision":"approve","previewHash":request["previewHash"],"expectedPolicyRevision":catalog["policyRevision"]}}))).await;
        if result
            .as_ref()
            .is_err_and(|error| crate::sync::service_error(error))
        {
            return result.map(|_| ());
        }
        let result = result.and_then(|result| {
            governance::reconcile_requests(db, project_id, &json!([result.clone()]))?;
            if let Some(requests) = catalog["requests"].as_array_mut() {
                if let Some(current) = requests
                    .iter_mut()
                    .find(|current| current["id"] == result["id"])
                {
                    *current = result;
                }
            }
            db::set(db, &format!("governance:{project_id}"), &catalog)
        });
        crate::sync::record_result(
            db,
            &format!(
                "{project_id}:publish:{}",
                request["id"].as_str().unwrap_or("")
            ),
            result,
        )?;
    }
    Ok(())
}

pub(crate) fn pending_publications(
    db: &Connection,
    owner: &str,
    project: &Value,
    catalog: &Value,
) -> Result<Vec<Value>> {
    let project_id = project["id"].as_str().ok_or("Missing project")?;
    let paused_sources = crate::sources::paused_upload_sources(project);
    let mut pending = Vec::new();
    for mut draft in db::rows(
        db,
        "SELECT value FROM drafts WHERE project=? AND json_extract(value,'$.status')='proposed'",
        &[&project_id],
    )? {
        if preserve_removed_draft(db, project, &mut draft)?
            || require_active_source(project, &draft).is_err()
            || crate::sources::upload_paused(&paused_sources, &draft["resource"]["sourceId"])
        {
            continue;
        }
        let kind = draft["resource"]["kind"].as_str().unwrap_or("");
        if !matches!(kind, "memory" | "skill") || !projects::sharing_allowed(project, kind) {
            continue;
        }
        let Some(request) = catalog["requests"].as_array().and_then(|requests| {
            requests
                .iter()
                .find(|request| request["id"] == draft["requestId"])
        }) else {
            continue;
        };
        if request["author"] != owner
            || request["status"] != "pending"
            || request["canReview"] != true
            || (draft["automaticMergeRequestId"].is_string()
                && draft["automaticMergeRequestId"] == request["id"]
                && !matches_skill_proposal(&draft["submission"], request, owner))
        {
            continue;
        }
        pending.push(request.clone());
    }
    Ok(pending)
}

pub fn queue(db: &Connection, project: &Value, draft_id: &str) -> Result<Value> {
    let tx = rusqlite::Transaction::new_unchecked(db, rusqlite::TransactionBehavior::Immediate)
        .map_err(|error| error.to_string())?;
    let result = queue_in(&tx, project, draft_id, false)?;
    tx.commit().map_err(|error| error.to_string())?;
    Ok(result)
}

pub(crate) fn queue_in(
    db: &rusqlite::Transaction<'_>,
    project: &Value,
    draft_id: &str,
    automatic_merge: bool,
) -> Result<Value> {
    let project_id = project["id"].as_str().ok_or("Missing project")?;
    let mut draft = db::rows(
        db,
        "SELECT value FROM drafts WHERE id=? AND project=?",
        &[&draft_id, &project_id],
    )?
    .into_iter()
    .next()
    .ok_or("Draft unavailable")?;
    require_active_source(project, &draft)?;
    let kind = draft["resource"]["kind"]
        .as_str()
        .ok_or("Missing resource category")?;
    if !matches!(kind, "memory" | "skill") || draft["resource"]["deleted"] == true {
        return Err("Choose a memory or skill".into());
    }
    projects::require_sharing(db, project_id, kind)?;
    let (path, marker) = if kind == "skill" {
        (crate::global_skills::IMPORT_PATH, "skillImport")
    } else {
        (QUEUE_PATH, "contextDraft")
    };
    if matches!(
        draft["status"].as_str(),
        Some("proposed" | "published" | "approved" | "dismissed")
    ) {
        return Ok(json!({"status":draft["status"]}));
    }
    if draft["submission"].is_null() {
        let prepared = publication_resource(db, project_id, &draft["resource"])?;
        let pending: bool = db.query_row("SELECT EXISTS(SELECT 1 FROM outbox WHERE project=?1 AND json_extract(value,'$.resource.resourceId')=?2) OR EXISTS(SELECT 1 FROM drafts WHERE project=?1 AND json_extract(value,'$.status')='proposed' AND json_extract(value,'$.submission.resource.resourceId')=?2)", rusqlite::params![project_id, prepared["resourceId"].as_str()], |row| row.get(0)).map_err(|error|error.to_string())?;
        if pending {
            draft["automaticSharing"] = json!(true);
            db::upsert(db, "drafts", draft_id, project_id, &draft)?;
            return Ok(json!({"status":"queued"}));
        }
        let mut resource = json!({});
        for key in [
            "resourceId",
            "sourceId",
            "kind",
            "source",
            "logicalPath",
            "title",
            "files",
            "deleted",
            "contextSources",
            "memory",
        ] {
            if !prepared[key].is_null() {
                resource[key] = prepared[key].clone();
            }
        }
        let current = db::rows(
            db,
            "SELECT value FROM resources WHERE id=? AND project=?",
            &[
                &resource["resourceId"].as_str().ok_or("Missing resource")?,
                &project_id,
            ],
        )?
        .into_iter()
        .next()
        .unwrap_or(Value::Null);
        let mut base = draft["baseRevision"].as_u64().unwrap_or(0);
        let revision = current["revision"].as_u64().unwrap_or(0);
        if let Some(preceding) = draft["precedingDraft"].as_str() {
            if let Some(previous) = db::rows(
                db,
                "SELECT value FROM drafts WHERE id=? AND project=?",
                &[&preceding, &project_id],
            )?
            .first()
            {
                if matches!(previous["status"].as_str(), Some("published" | "approved"))
                    && current["updatedBy"] == db::get(db, "user")?
                    && previous["submission"]["resource"]["files"] == current["files"]
                {
                    base = revision;
                }
            }
        }
        if governance::protected(&resource) && base != revision {
            draft["automaticSharing"] = json!(false);
            draft["conflictReview"] = json!(true);
            db::upsert(db, "drafts", draft_id, project_id, &draft)?;
            return Ok(json!({"status":"review_required"}));
        }
        draft["requestId"] = json!(uuid::Uuid::new_v4().to_string());
        draft["submission"] = json!({"version":2,"id":draft["requestId"],"projectId":project_id,"deviceId":db::device(db)?,"baseRevision":base,"resource":resource});
    }
    draft["automaticSharing"] = json!(true);
    let mut change = draft["submission"].clone();
    change[marker] = json!(draft_id);
    if automatic_merge {
        draft["automaticMergeRequestId"] = change["id"].clone();
    }
    db::upsert(db, "drafts", draft_id, project_id, &draft)?;
    let pending: bool = db
        .query_row(
            "SELECT EXISTS(SELECT 1 FROM outbox WHERE id=?)",
            [change["id"].as_str()],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())?;
    if !pending {
        indexer::queue(db, project_id, path, &change)?;
        SyncQueue::request(db, project_id, Priority::Local, "share")?;
    }
    Ok(json!({"status":"queued"}))
}

fn wire_change(queued: &Value) -> Result<Value> {
    let mut change = queued["value"].clone();
    let fields = change.as_object_mut().ok_or("Missing import change")?;
    fields.remove("skillImport");
    fields.remove("contextDraft");
    fields.remove("reviewRequired");
    fields.remove("automaticSkillMerge");
    Ok(change)
}

pub(crate) fn matches_skill_proposal(change: &Value, proposal: &Value, owner: &str) -> bool {
    let submitted = &change["resource"];
    proposal["id"] == change["id"]
        && proposal["projectId"] == change["projectId"]
        && proposal["resourceId"] == submitted["resourceId"]
        && proposal["baseRevision"] == change["baseRevision"]
        && proposal["author"] == owner
        && proposal["type"] == "change"
        && matches!(
            proposal["status"].as_str(),
            Some("pending" | "approved" | "rejected" | "stale")
        )
        && proposal["previewHash"] == db::digest(submitted.to_string().as_bytes())
}

/// The preceding desktop durably chose suggestion on a publish denial. The
/// freshly authorized catalog can settle that exact proposal without another
/// upload, including after its author loses publish access.
pub(crate) fn frozen_skill_proposal(
    db: &Connection,
    queued: &Value,
    owner: &str,
) -> Result<Option<Value>> {
    if queued["value"]["reviewRequired"] != true || !automatic_skill_request(db, queued)? {
        return Ok(None);
    }
    let project = queued["project"].as_str().ok_or("Missing project")?;
    let catalog = db::get(db, &format!("governance:{project}"))?;
    Ok(catalog["requests"]
        .as_array()
        .and_then(|requests| {
            requests
                .iter()
                .find(|request| matches_skill_proposal(&queued["value"], request, owner))
        })
        .map(|request| json!({"proposal":request})))
}

pub async fn share(db: &Connection, owner: &str, queued: &Value) -> Result<Value> {
    let automatic_merge = automatic_skill_request(db, queued)?;
    if automatic_merge {
        // Sharing or source access can change while the blobs upload.
        check_automatic_skill_upload(db, queued)
            .map_err(|error| format!("Local upload: {error}"))?;
    }
    let change = wire_change(queued)?;
    if queued["value"]["reviewRequired"] != true {
        match crate::sync::api_as(owner, "POST", "/v2/sync/push", Some(&change)).await {
            Ok(receipt) => return Ok(receipt),
            Err(error) if error.starts_with("403:") && !automatic_merge => {
                // Persist the route before submitting, so a lost response retries
                // the same approval request even if permissions later change.
                let mut value = queued["value"].clone();
                value["reviewRequired"] = json!(true);
                db.execute(
                    "UPDATE outbox SET value=? WHERE id=?",
                    rusqlite::params![value.to_string(), queued["id"].as_str()],
                )
                .map_err(|error| error.to_string())?;
            }
            Err(error) => return Err(error),
        }
    }
    let request = crate::sync::api_as(
        owner,
        "POST",
        "/v2/governance/action",
        Some(&json!({"action":"submit","input":{"projectId":change["projectId"],"change":change}})),
    )
    .await?;
    Ok(json!({"proposal":request}))
}

pub fn complete(db: &Connection, queued: &Value, receipt: &Value) -> Result<()> {
    let project_id = queued["project"].as_str().ok_or("Missing project")?;
    let draft_id = queued["value"]["skillImport"]
        .as_str()
        .or(queued["value"]["contextDraft"].as_str())
        .ok_or("Missing context draft")?;
    let mut draft = db::rows(
        db,
        "SELECT value FROM drafts WHERE id=? AND project=?",
        &[&draft_id, &project_id],
    )?
    .into_iter()
    .next()
    .ok_or("Context draft unavailable")?;
    let automatic_merge = automatic_skill_request(db, queued)?;
    if automatic_merge && receipt["proposal"].is_object() {
        let owner = db::get(db, "user")?;
        if queued["value"]["reviewRequired"] != true
            || !owner.as_str().is_some_and(|owner| {
                matches_skill_proposal(&queued["value"], &receipt["proposal"], owner)
            })
        {
            return Err("Approval request differs from the frozen skill update".into());
        }
    } else if automatic_merge {
        let submitted = &queued["value"]["resource"];
        let accepted = &receipt["event"]["resource"];
        if queued["value"]["reviewRequired"] == true
            || receipt["conflict"] == true
            || receipt["event"]["conflicts"]
                .as_array()
                .is_none_or(|conflicts| !conflicts.is_empty())
            || accepted["updatedBy"] != db::get(db, "user")?
            || accepted["revision"]
                .as_u64()
                .zip(queued["value"]["baseRevision"].as_u64())
                .is_none_or(|(revision, base)| revision <= base)
            || submitted.as_object().is_none_or(|fields| {
                fields
                    .iter()
                    .any(|(field, value)| accepted.get(field) != Some(value))
            })
        {
            return Err(
                "Published skill differs from the queued merge. The original edit is preserved."
                    .into(),
            );
        }
    }
    if receipt["proposal"].is_object() {
        if receipt["proposal"]["projectId"] != project_id
            || receipt["proposal"]["resourceId"] != queued["value"]["resource"]["resourceId"]
            || receipt["proposal"]["id"] != queued["id"]
        {
            return Err("Approval request differs from the queued context".into());
        }
        draft["status"] = if automatic_merge {
            match receipt["proposal"]["status"].as_str() {
                Some("pending") => json!("proposed"),
                Some("approved") => json!("published"),
                _ => receipt["proposal"]["status"].clone(),
            }
        } else {
            json!("proposed")
        };
        draft["request"] = receipt["proposal"].clone();
    } else {
        let resource = &receipt["event"]["resource"];
        if resource["projectId"] != project_id
            || resource["resourceId"] != queued["value"]["resource"]["resourceId"]
            || resource["kind"] != queued["value"]["resource"]["kind"]
            || resource["deleted"] == true
            || (resource["kind"] == "skill"
                && resource["files"] != queued["value"]["resource"]["files"])
        {
            return Err("Published resource differs from the queued context".into());
        }
        crate::sync::apply_event(db, &receipt["event"])?;
        draft["status"] = json!("published");
    }
    db::upsert(db, "drafts", draft_id, project_id, &draft)?;
    if !receipt["proposal"].is_object()
        && draft["status"] == "published"
        && draft["resource"]["kind"] == "skill"
    {
        let resource = &receipt["event"]["resource"];
        let project = governance::project(db, project_id)?;
        let binding = crate::global_skills::adopt_import(
            db,
            &project,
            resource,
            indexer::binding(
                db,
                resource["resourceId"].as_str().ok_or("Missing resource")?,
            )?,
        )?;
        db::upsert(
            db,
            "bindings",
            resource["resourceId"].as_str().ok_or("Missing resource")?,
            project_id,
            &binding,
        )?;
    }
    Ok(())
}
