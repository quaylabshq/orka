use crate::{
    db::{self, Result},
    env,
    governance::DetachProject,
    sync,
};
use fs2::FileExt;
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    fs::{File, OpenOptions},
    time::{Duration, Instant},
};

pub const ACTIVE: &str = "coalesce(json_extract(value,'$.revoked'),0)=0 AND coalesce(json_extract(value,'$.hidden'),0)=0 AND json_extract(value,'$.archivedAt') IS NULL AND json_extract(value,'$.deletedAt') IS NULL";
pub const CATALOG_PATH: &str = "/v2/projects?includeArchived=true&projectLifecycle=1";

pub(crate) fn require_soft_delete(capabilities: &Value) -> Result<()> {
    if capabilities["softDelete"] != 1 {
        return Err("This service does not support recoverable project deletion. Update the server and try again.".into());
    }
    Ok(())
}

pub fn display_name(project: &Value) -> Option<&str> {
    if project["role"] == "owner" {
        return project["name"].as_str();
    }
    project["localName"].as_str().or(project["name"].as_str())
}

fn set_local_name(db: &Connection, id: &str, name: &Value) -> Result<()> {
    let name = if name.is_null() {
        Value::Null
    } else {
        let name = name.as_str().ok_or("Enter a project name")?.trim();
        if name.is_empty() || name.encode_utf16().count() > 100 {
            return Err("Enter a project name from 1 to 100 characters".into());
        }
        json!(name)
    };
    // One SQLite update keeps this local preference safe during catalog sync.
    let changed = db.execute(
        &format!("UPDATE projects SET value=json_set(value,'$.localName',json(?)) WHERE id=? AND {ACTIVE}"),
        rusqlite::params![name.to_string(), id],
    ).map_err(|e| e.to_string())?;
    if changed == 0 {
        return Err("Project is removed, archived, or unavailable".into());
    }
    Ok(())
}

#[derive(Default, Deserialize, Serialize)]
#[serde(deny_unknown_fields)]
pub struct Sharing {
    memory: bool,
    skill: bool,
    session: bool,
    plan: bool,
    env: bool,
}

impl Sharing {
    pub fn new_project() -> Self {
        Self {
            memory: true,
            skill: true,
            plan: true,
            session: false,
            env: false,
        }
    }
}

pub fn sharing_allowed(project: &Value, kind: &str) -> bool {
    if kind == "env" && !env::enabled() {
        return false;
    }
    if !matches!(kind, "memory" | "skill" | "session" | "plan" | "env") {
        return false;
    }
    // Projects saved before opt-in sharing retain their existing behavior.
    project["sharing"].is_null() || project["sharing"][kind] == true
}

pub fn require_sharing(db: &Connection, id: &str, kind: &str) -> Result<()> {
    active(db, id)?;
    let project = db::rows(db, "SELECT value FROM projects WHERE id=?", &[&id])?
        .into_iter()
        .next()
        .ok_or("Project not found")?;
    if !sharing_allowed(&project, kind) {
        return Err(format!(
            "Sharing for {kind} is off on this Mac. Enable it in Settings → Project sharing."
        ));
    }
    Ok(())
}

/// Local project lifecycle work shared by the command and its tests.
pub(crate) trait ProjectLifecycle {
    /// Work that has not reached the service yet; deleting with it would lose
    /// the only copy. The same check guards source removal.
    fn queued_changes(&self, project: &str) -> Result<bool>;
    /// Records a server soft delete without touching the local copy, so a
    /// restore keeps its folders and queue.
    fn mark_deleted(&self, project: &str, receipt: &Value) -> Result<()>;
    /// Detaches the project, then removes its local state. The user's files
    /// stay on disk.
    fn purge_local(&self, project: &str) -> Result<()>;
    /// Ends this Mac's access but keeps the local copy as an inactive project.
    fn leave(&self, project: &str) -> Result<()>;
}

impl ProjectLifecycle for Connection {
    fn queued_changes(&self, project: &str) -> Result<bool> {
        self.query_row(
            "SELECT EXISTS(SELECT 1 FROM outbox WHERE project=?1 UNION ALL SELECT 1 FROM meta WHERE key LIKE 'env:%:pending:%' AND json_extract(value,'$.header.manifest.projectId')=?1 AND json_extract(value,'$.sourceRemoval') IS NULL)",
            [project],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())
    }

    fn mark_deleted(&self, project: &str, receipt: &Value) -> Result<()> {
        let Some(mut saved) = db::rows(self, "SELECT value FROM projects WHERE id=?", &[&project])?
            .into_iter()
            .next()
        else {
            return Ok(());
        };
        // The successful, capability-checked action is enough to stop local
        // work even with a soft-delete service that predates dated receipts.
        saved["deletedAt"] = receipt["deletedAt"]
            .as_str()
            .map_or_else(|| json!(db::now()), |at| json!(at));
        saved["archivedAt"] = receipt["archivedAt"]
            .as_str()
            .map_or_else(|| saved["deletedAt"].clone(), |at| json!(at));
        if receipt["purgeAfter"].is_string() {
            saved["purgeAfter"] = receipt["purgeAfter"].clone();
        }
        saved["lifecycleRevision"] = receipt["lifecycleRevision"].clone();
        db::upsert(self, "projects", project, project, &saved)
    }

    fn purge_local(&self, project: &str) -> Result<()> {
        self.detach_project(project)?;
        remove_local(self, project)
    }

    fn leave(&self, project: &str) -> Result<()> {
        self.detach_project(project)
    }
}

pub fn queued_kind<'a>(path: &str, input: &'a Value) -> &'a str {
    if matches!(path, "/v2/sessions/copy" | "/v2/sessions/resolve") {
        "session"
    } else {
        input["resource"]["kind"].as_str().unwrap_or("")
    }
}

// Serialize local project changes with the daemon across processes. A removal
// cannot race an already selected upload or a write into the connected folder.
fn lock_file(name: &str) -> Result<File> {
    OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(db::root()?.join(name))
        .map_err(|e| e.to_string())
}

pub fn lock() -> Result<File> {
    try_lock()?.ok_or_else(|| {
        "A sync or project operation is in progress. Wait for it to finish and try again.".into()
    })
}

pub fn try_lock() -> Result<Option<File>> {
    let file = lock_file("workspace.lock")?;
    match file.try_lock_exclusive() {
        Ok(()) => Ok(Some(file)),
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => Ok(None),
        Err(error) => Err(format!("Cannot access the project lock: {error}")),
    }
}

pub fn launch_lock() -> Result<File> {
    let file = lock_file("session-launch.lock")?;
    file.try_lock_exclusive().map_err(|_| {
        "A session launch is already in progress. Check that attempt before trying again."
    })?;
    Ok(file)
}

pub fn wait_for_lock(timeout: Duration) -> Result<File> {
    let waiting = lock_file("workspace-waiters.lock")?;
    FileExt::lock_shared(&waiting).map_err(|e| e.to_string())?;
    let file = lock_file("workspace.lock")?;
    let start = Instant::now();
    loop {
        match file.try_lock_exclusive() {
            Ok(()) => return Ok(file),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {
                let remaining = timeout.saturating_sub(start.elapsed());
                if remaining.is_zero() {
                    return Err("Sync or another project operation is still running. Try again after it finishes.".into());
                }
                std::thread::sleep(remaining.min(Duration::from_millis(50)));
            }
            Err(error) => return Err(format!("Cannot access the project lock: {error}")),
        }
    }
}

pub fn foreground_waiting() -> Result<bool> {
    let waiting = lock_file("workspace-waiters.lock")?;
    match waiting.try_lock_exclusive() {
        Ok(()) => Ok(false),
        Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => Ok(true),
        Err(error) => Err(error.to_string()),
    }
}

pub fn active(db: &Connection, id: &str) -> Result<()> {
    if db
        .query_row(
            &format!("SELECT count(*) FROM projects WHERE id=? AND {ACTIVE}"),
            [id],
            |r| r.get::<_, i64>(0),
        )
        .map_err(|e| e.to_string())?
        == 0
    {
        return Err(
            "Project is removed, archived, or unavailable. Restore it in Settings → Projects first."
                .into(),
        );
    }
    Ok(())
}

pub fn merge_catalog(db: &Connection, remote: &Value) -> Result<()> {
    let remote = remote.as_array().ok_or("Invalid project list")?;
    let tx = rusqlite::Transaction::new_unchecked(db, rusqlite::TransactionBehavior::Immediate)
        .map_err(|e| e.to_string())?;
    let mut detached = Vec::new();
    let mut revoked = false;
    for item in remote {
        let id = item["id"].as_str().ok_or("Missing project")?;
        let old = db::rows(&tx, "SELECT value FROM projects WHERE id=?", &[&id])?
            .into_iter()
            .next()
            .unwrap_or(json!({}));
        // Purging is terminal. A catalog fetched before the purge must not
        // reattach a project after its tombstone has already been applied.
        if old["purged"] == true && item["purged"] != true {
            continue;
        }
        if item["purged"] != true
            && item["lifecycleRevision"]
                .as_u64()
                .is_some_and(|revision| revision < old["lifecycleRevision"].as_u64().unwrap_or(0))
        {
            continue;
        }
        if !item["deletedAt"].is_null() && item["role"] != "owner" {
            // Members receive a reduced row; owners receive their complete
            // catalog entry and use the normal merge below. Keep local source
            // bindings while recording authoritative lifecycle/membership data.
            let mut project = old.clone();
            project["id"] = item["id"].clone();
            for key in [
                "name",
                "deletedAt",
                "purgeAfter",
                "purged",
                "role",
                "lifecycleRevision",
            ] {
                if !item[key].is_null() {
                    project[key] = item[key].clone();
                }
            }
            if item["purged"] != true {
                // A listed, unpurged row establishes current membership even
                // if this Mac previously observed an access removal.
                project["revoked"] = Value::Null;
                project["detachedAt"] = Value::Null;
                if project["role"].is_null() || project["role"] == "owner" {
                    project["role"] = json!("member");
                }
            }
            if old["id"].is_null() {
                project["sharing"] = json!(Sharing::default());
            }
            db::upsert(&tx, "projects", id, id, &project)?;
            if item["purged"] == true {
                detached.push(id.to_string());
            }
            continue;
        }
        let mut project = item.clone();
        if let Some(sources) = project["sources"].as_array_mut() {
            for source in sources {
                if let Some(local) = old["sources"].as_array().and_then(|items| {
                    items
                        .iter()
                        .find(|local| local["id"] == source["id"] && !local["removedAt"].is_null())
                }) {
                    source["removedAt"] = local["removedAt"].clone();
                    source["repository"] = Value::Null;
                }
                if !source["removedAt"].is_null() {
                    crate::sources::preserve_removed_queue(&tx, id, source)?;
                    source["path"] = Value::Null;
                    source["folderIdentity"] = Value::Null;
                    tx.execute("DELETE FROM bindings WHERE project=? AND json_extract(value,'$.base.sourceId')=?", [id, source["id"].as_str().ok_or("Missing source")?]).map_err(|e| e.to_string())?;
                    continue;
                }
                if let Some(local) = old["sources"]
                    .as_array()
                    .and_then(|items| items.iter().find(|local| local["id"] == source["id"]))
                {
                    source["path"] = local["path"].clone();
                    source["folderIdentity"] = local["folderIdentity"].clone();
                    crate::sources::upgrade_identity(source);
                }
            }
        }
        for key in ["path", "folderIdentity", "hidden", "sharing", "localName"] {
            project[key] = old[key].clone();
        }
        crate::sources::upgrade_identity(&mut project);
        if old["id"].is_null() {
            project["sharing"] = json!(Sharing::default());
        }
        db::upsert(&tx, "projects", id, id, &project)?;
        // A project that is active again sends what its 403 stopped. One that is
        // still archived or deleted waits until it can send.
        if (!old["deletedAt"].is_null() || !old["archivedAt"].is_null())
            && project["deletedAt"].is_null()
            && project["archivedAt"].is_null()
        {
            tx.execute(
                "UPDATE outbox SET error=NULL WHERE project=? AND error LIKE '403:%'",
                [id],
            )
            .map_err(|e| e.to_string())?;
        }
    }
    for mut project in db::rows(&tx, "SELECT value FROM projects", &[])? {
        if !remote.iter().any(|p| p["id"] == project["id"]) {
            let id = project["id"].as_str().ok_or("Missing project")?.to_string();
            if project["detachedAt"].is_null() {
                detached.push(id.clone());
            }
            revoked |= project["revoked"] != true;
            project["revoked"] = json!(true);
            db::upsert(&tx, "projects", &id, "", &project)?;
        }
    }
    tx.commit().map_err(|e| e.to_string())?;
    if revoked {
        env::clear();
    }
    // Detaching after the commit keeps the catalog write atomic. Retrying also
    // recovers a crash between the commit and the local draft capture.
    for id in detached {
        db.detach_project(&id)?;
    }
    Ok(())
}

pub fn remove_local(db: &Connection, id: &str) -> Result<()> {
    let mut project = db::rows(db, "SELECT value FROM projects WHERE id=?", &[&id])?
        .into_iter()
        .next()
        .ok_or("Project not found")?;
    let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
    project["hidden"] = json!(true);
    project["path"] = Value::Null;
    project["folderIdentity"] = Value::Null;
    if let Some(sources) = project["sources"].as_array_mut() {
        for source in sources {
            source["path"] = Value::Null;
            source["folderIdentity"] = Value::Null;
        }
    }
    db::upsert(&tx, "projects", id, id, &project)?;
    tx.execute("DELETE FROM activity WHERE json_extract(value,'$.resourceId') IN (SELECT id FROM resources WHERE project=?)",[id]).map_err(|e| e.to_string())?;
    tx.execute(
        "DELETE FROM errors WHERE source IN (SELECT id FROM resources WHERE project=?)",
        [id],
    )
    .map_err(|e| e.to_string())?;
    for request in db::rows(&tx, "SELECT json_quote(id) FROM outbox WHERE project=?1 UNION SELECT json_quote(substr(key,length('sessionCopy:')+1)) FROM meta WHERE key LIKE 'sessionCopy:%' AND json_extract(value,'$.source.projectId')=?1", &[&id])? {
        sync::clear_session_copy(&tx, request.as_str().ok_or("Missing request ID")?)?;
    }
    for table in [
        "resources",
        "bindings",
        "outbox",
        "conflicts",
        "cursors",
        "local_resources",
    ] {
        tx.execute(&format!("DELETE FROM {table} WHERE project=?"), [id])
            .map_err(|e| e.to_string())?;
    }
    tx.execute("DELETE FROM errors WHERE source=?", [id])
        .map_err(|e| e.to_string())?;
    // Keep signed trust pins, but discard encrypted pending publications for this project.
    tx.execute("DELETE FROM meta WHERE key LIKE 'env:%' AND (json_extract(value,'$.header.manifest.projectId')=? OR json_extract(value,'$.projectId')=?)",[id,id]).map_err(|e| e.to_string())?;
    tx.execute("DELETE FROM meta WHERE (key LIKE 'share-preview:%' OR key LIKE 'selected-share:%' OR key LIKE 'resource-delete:%') AND json_extract(value,'$.projectId')=?",[id]).map_err(|e|e.to_string())?;
    tx.commit().map_err(|e| e.to_string())?;
    env::clear();
    Ok(())
}

#[tauri::command]
pub async fn project_command(action: String, input: Value) -> Result<Value> {
    let db = db::open()?;
    let owner = db::get(&db, "user")?
        .as_str()
        .ok_or("Sign in first")?
        .to_string();
    if action == "capabilities" {
        return sync::api_as(&owner, "GET", "/v2/projects/capabilities", None).await;
    }
    if action == "list" {
        let capable =
            sync::api_as(&owner, "GET", "/v2/projects/capabilities", None).await?["lifecycle"] == 1;
        let list = sync::api_as(&owner, "GET", CATALOG_PATH, None).await?;
        let _lock = lock()?;
        merge_catalog(&db, &list)?;
        return Ok(
            json!({"supported":capable,"projects":db::rows(&db,"SELECT value FROM projects ORDER BY json_extract(value,'$.name')",&[])?}),
        );
    }
    let id = input["projectId"].as_str().ok_or("Choose a project")?;
    uuid::Uuid::parse_str(id).map_err(|_| "Invalid project")?;
    if action == "local_name" {
        set_local_name(&db, id, input.get("name").ok_or("Enter a project name")?)?;
        return Ok(json!({"ok":true}));
    }
    let _lock = lock()?;
    match action.as_str() {
        "remove-source" => {
            active(&db, id)?;
            let mut project = crate::governance::project(&db, id)?;
            if project["role"] != "owner" {
                return Err("Only project owners can remove source folders".into());
            }
            let source_id = input["sourceId"].as_str().ok_or("Choose a source folder")?;
            uuid::Uuid::parse_str(source_id).map_err(|_| "Invalid source folder")?;
            if db.queued_changes(id)? {
                return Err("Sync queued changes and finish pending ENV publications before removing a source folder".into());
            }
            if sync::api_as(&owner, "GET", "/v2/projects/capabilities", None).await?
                ["sourcesRemoval"]
                != 1
            {
                return Err("This service does not support removing source folders. Update the server and try again.".into());
            }
            let receipt = sync::api_as(
                &owner,
                "POST",
                "/v2/projects/sources/remove",
                Some(&json!({"projectId":id,"sourceId":source_id})),
            )
            .await?;
            let source = project["sources"]
                .as_array_mut()
                .and_then(|items| items.iter_mut().find(|source| source["id"] == source_id))
                .ok_or("Source folder not found")?;
            source["removedAt"] = json!(receipt["removedAt"]
                .as_str()
                .ok_or("Invalid source removal response")?);
            source["path"] = Value::Null;
            source["folderIdentity"] = Value::Null;
            source["repository"] = Value::Null;
            {
                let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
                db::upsert(&tx, "projects", id, id, &project)?;
                tx.execute(
                    "DELETE FROM bindings WHERE project=? AND json_extract(value,'$.base.sourceId')=?",
                    [id, source_id],
                )
                .map_err(|e| e.to_string())?;
                tx.commit().map_err(|e| e.to_string())?;
            }
            if let Ok(remote) = sync::api_as(&owner, "GET", CATALOG_PATH, None).await {
                merge_catalog(&db, &remote)?;
            }
            env::clear();
        }
        "sharing" => {
            active(&db, id)?;
            let sharing: Sharing = serde_json::from_value(input["sharing"].clone())
                .map_err(|_| "Invalid project sharing choices")?;
            let mut project = db::rows(&db, "SELECT value FROM projects WHERE id=?", &[&id])?
                .into_iter()
                .next()
                .ok_or("Project not found")?;
            project["sharing"] = json!(sharing);
            db::upsert(&db, "projects", id, id, &project)?;
            env::clear();
        }
        "remove" => remove_local(&db, id)?,
        "show" => {
            let mut project = db::rows(&db, "SELECT value FROM projects WHERE id=?", &[&id])?
                .into_iter()
                .next()
                .ok_or("Project not found")?;
            if project["revoked"] == true || !project["archivedAt"].is_null() {
                return Err("Restore cloud access before adding this project to this Mac".into());
            }
            project["hidden"] = json!(false);
            db::upsert(&db, "projects", id, id, &project)?;
        }
        "leave" => {
            active(&db, id)?;
            if db.queued_changes(id)? {
                return Err("Sync queued changes and finish pending ENV publications before leaving this project".into());
            }
            let expected = input["expectedPolicyRevision"]
                .as_u64()
                .ok_or("Refresh the project's membership and try again")?;
            sync::api_as(
                &owner,
                "POST",
                "/v2/governance/action",
                Some(&json!({"action":"leave-project","input":{"projectId":id,"expectedPolicyRevision":expected}})),
            )
            .await?;
            db.leave(id)?;
            env::clear();
        }
        "archive" | "restore" | "delete" | "purge" | "rename" => {
            if action == "rename" {
                active(&db, id)?;
                if sync::api_as(&owner, "GET", "/v2/projects/capabilities", None).await?["rename"]
                    != 1
                {
                    return Err("This service does not support shared project renaming. Update the server and try again.".into());
                }
            }
            if matches!(action.as_str(), "delete" | "purge") && db.queued_changes(id)? {
                return Err("Sync queued changes and finish pending ENV publications before deleting this project".into());
            }
            if matches!(action.as_str(), "delete" | "purge") {
                require_soft_delete(
                    &sync::api_as(&owner, "GET", "/v2/projects/capabilities", None).await?,
                )?;
            }
            let mut request = input.clone();
            request["action"] = json!(action);
            let receipt =
                sync::api_as(&owner, "POST", "/v2/projects/action", Some(&request)).await?;
            if action != "rename" {
                env::clear();
            }
            if action == "delete" {
                // The service keeps the project recoverable; the local copy
                // stays too, and the next catalog merge leaves it inactive.
                db.mark_deleted(id, &receipt)?;
            } else if action == "purge" {
                db.purge_local(id)?;
            } else if let Some(mut project) =
                db::rows(&db, "SELECT value FROM projects WHERE id=?", &[&id])?
                    .into_iter()
                    .next()
            {
                if action == "rename"
                    && receipt["lifecycleRevision"].as_u64().unwrap_or(0)
                        < project["lifecycleRevision"].as_u64().unwrap_or(0)
                {
                    return Ok(json!({"ok":true}));
                }
                if action == "rename" {
                    project["name"] = receipt["name"].clone();
                } else {
                    project["archivedAt"] =
                        receipt.get("archivedAt").cloned().unwrap_or_else(|| {
                            if action == "archive" {
                                json!(db::now())
                            } else {
                                Value::Null
                            }
                        });
                    if action == "restore" {
                        project["deletedAt"] = Value::Null;
                        project["purgeAfter"] = Value::Null;
                        project["hidden"] = json!(false);
                        project["revoked"] = json!(false);
                        project["detachedAt"] = Value::Null;
                    }
                }
                project["lifecycleRevision"] = receipt["lifecycleRevision"].clone();
                db::upsert(&db, "projects", id, id, &project)?;
            }
        }
        _ => return Err("Unknown project action".into()),
    }
    crate::commands::sync_now()?;
    Ok(json!({"ok":true}))
}
