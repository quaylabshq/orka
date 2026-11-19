//! A deleted project that can still be restored keeps capturing local edits
//! into the outbox and sends nothing until it is restored.
use super::*;
use crate::{
    sync_queue::{Priority, SyncQueue},
    sync_schedule::Interval,
};
use std::{collections::BTreeSet, sync::MutexGuard};

const DELETED_AT: &str = "2026-11-01T00:00:00Z";

struct Capture {
    _lock: MutexGuard<'static, ()>,
    home: tempfile::TempDir,
    root: PathBuf,
    db: rusqlite::Connection,
    id: String,
    owner: String,
    /// The configured service. Nothing should ever connect to it.
    service: std::net::TcpListener,
}

fn future() -> String {
    (chrono::Utc::now() + chrono::Duration::days(30)).to_rfc3339()
}

fn restorable() -> Value {
    json!({"deletedAt":DELETED_AT,"archivedAt":DELETED_AT,"purgeAfter":future()})
}

impl Capture {
    fn new(lifecycle: Value) -> Self {
        let lock = crate::tests::SERIAL
            .lock()
            .unwrap_or_else(|error| error.into_inner());
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("ORKA_TEST_HOME", home.path());
        std::env::set_var("CODEX_HOME", home.path().join(".codex"));
        std::env::set_var("CLAUDE_CONFIG_DIR", home.path().join(".claude"));
        let root = home.path().join("project");
        fs::create_dir(&root).unwrap();
        let root = root.canonicalize().unwrap();
        let db = db::open().unwrap();
        let owner = uuid::Uuid::new_v4().to_string();
        db::set(&db, "user", &json!(owner)).unwrap();
        // A local listener on a free port stands in for the service, so any
        // connection a capture makes is observable.
        let service = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        service.set_nonblocking(true).unwrap();
        let url = format!("http://127.0.0.1:{}", service.local_addr().unwrap().port());
        db::set(&db, "config", &json!({"apiUrl":url})).unwrap();
        let id = uuid::Uuid::new_v4().to_string();
        let mut project = json!({"id":id,"name":"Deleted","role":"member","path":root});
        for (key, value) in lifecycle.as_object().unwrap() {
            project[key] = value.clone();
        }
        db::upsert(&db, "projects", &id, "", &project).unwrap();
        Self {
            _lock: lock,
            home,
            root,
            db,
            id,
            owner,
            service,
        }
    }

    /// No connection reached the service and the project recorded no error,
    /// so the capture neither sent anything nor failed quietly.
    fn assert_sent_nothing(&self) {
        match self.service.accept() {
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => {}
            other => panic!("the service received a connection: {other:?}"),
        }
        let errors = db::rows(
            &self.db,
            "SELECT json_object('source',source,'error',error) FROM errors
             WHERE source=?1 OR source GLOB ?1||':*'
               OR source IN (SELECT id FROM resources WHERE project=?1)",
            &[&self.id],
        )
        .unwrap();
        assert!(errors.is_empty(), "{errors:?}");
    }

    fn project(&self) -> Value {
        db::rows(
            &self.db,
            "SELECT value FROM projects WHERE id=?",
            &[&self.id],
        )
        .unwrap()
        .remove(0)
    }

    fn edit_memory(&self, text: &str) {
        fs::write(self.root.join("CLAUDE.md"), text).unwrap();
    }

    fn edit_everything(&self) {
        self.edit_memory("Captured while deleted\n");
        let skill = self.root.join(".agents/skills/release");
        fs::create_dir_all(&skill).unwrap();
        fs::write(
            skill.join("SKILL.md"),
            "---\nname: release\ndescription: Ship it\n---\nSteps\n",
        )
        .unwrap();
        let plans = self.root.join(".codex/plans");
        fs::create_dir_all(&plans).unwrap();
        fs::write(plans.join("launch.md"), "# Launch plan\n").unwrap();
        let sessions = self.home.path().join(".claude/projects/deleted");
        fs::create_dir_all(&sessions).unwrap();
        let session = uuid::Uuid::new_v4().to_string();
        fs::write(
            sessions.join(format!("{session}.jsonl")),
            native::encode(&[
                json!({"type":"user","sessionId":session,"cwd":self.root,"version":"2.1.283","message":{"role":"user","content":"Work done while deleted"}}),
            ]),
        )
        .unwrap();
    }

    /// Outbox rows as `{id, kind, held, value, error}` in queue order.
    fn outbox(&self) -> Vec<Value> {
        db::rows(
            &self.db,
            "SELECT json_object('id',id,'kind',json_extract(value,'$.resource.kind'),'held',EXISTS(SELECT 1 FROM meta WHERE key='heldCapture:'||outbox.id),'value',json(value),'error',error) FROM outbox WHERE project=? ORDER BY rowid",
            &[&self.id],
        )
        .unwrap()
    }

    fn kinds(&self) -> BTreeSet<String> {
        self.outbox()
            .iter()
            .filter_map(|row| row["kind"].as_str().map(str::to_owned))
            .collect()
    }

    async fn run_job(&self) -> Option<Outcome> {
        SyncQueue::request(&self.db, &self.id, Priority::User, "test").unwrap();
        let outcome = std::sync::Arc::new(std::sync::Mutex::new(None));
        let seen = outcome.clone();
        let mut queue = SyncQueue::new(SyncQueue::now());
        assert!(queue
            .run_next(
                &Interval::from_config(&json!({})),
                async move |db: &mut rusqlite::Connection, job: &crate::sync_queue::Job| {
                    let result = run_job(db, job).await;
                    *seen.lock().unwrap() = result.as_ref().ok().map(|o| format!("{o:?}"));
                    result
                },
            )
            .await
            .unwrap());
        let outcome = outcome.lock().unwrap().clone();
        outcome.map(|name| match name.as_str() {
            "Captured" => Outcome::Captured,
            "Skipped" => Outcome::Skipped,
            "Synced" => Outcome::Synced,
            "Deferred" => Outcome::Deferred,
            "Yielded" => Outcome::Yielded,
            _ => Outcome::Cancelled,
        })
    }

    fn restore(&self) {
        crate::projects::merge_catalog(
            &self.db,
            &json!([{"id":self.id,"name":"Deleted","role":"member"}]),
        )
        .unwrap();
        crate::projects::active(&self.db, &self.id).unwrap();
    }
}

#[tokio::test]
async fn capture_preparation_failure_leaves_service_status_alone() {
    let f = Capture::new(restorable());
    let status = json!({"online":true,"lastSync":"2026-11-01T00:00:00Z"});
    db::set(&f.db, "sync", &status).unwrap();
    // A broken cached resource makes repair fail before capture can scan.
    db::upsert(&f.db, "resources", "broken-cache", &f.id, &json!({})).unwrap();

    assert!(f.run_job().await.is_none());
    assert_eq!(db::get(&f.db, "sync").unwrap(), status);
    assert!(db::get(&f.db, "syncOutage").unwrap().is_null());
    let error = db::rows(
        &f.db,
        "SELECT json_quote(error) FROM errors WHERE source=?",
        &[&f.id],
    )
    .unwrap();
    assert_eq!(error, [json!("Missing resource")]);
}

#[tokio::test]
async fn a_restorable_deleted_project_captures_every_kind_and_sends_nothing() {
    let f = Capture::new(restorable());
    f.edit_everything();
    assert!(matches!(f.run_job().await, Some(Outcome::Captured)));
    assert_eq!(
        f.kinds(),
        ["memory", "plan", "session", "skill"]
            .map(String::from)
            .into_iter()
            .collect()
    );
    for row in f.outbox() {
        assert_eq!(row["held"], 1, "{row}");
        assert!(row["error"].is_null());
        // The request stays exactly the protocol body older clients send.
        assert!(row["value"].get("heldCapture").is_none());
        let marker = db::get(
            &f.db,
            &indexer::held_capture_key(row["id"].as_str().unwrap()),
        )
        .unwrap();
        assert_eq!(marker["heldCapture"], true);
        assert_eq!(marker["projectId"], f.id.as_str());
        assert_eq!(marker["deletedAt"], DELETED_AT);
    }
    // No request was made: no connection, no error, no sync result, no
    // outage and no queued work.
    f.assert_sent_nothing();
    assert!(db::get(&f.db, "sync").unwrap().is_null());
    assert!(db::get(&f.db, "syncOutage").unwrap().is_null());
    assert!(SyncQueue::next(&f.db, i64::MAX - 1).unwrap().is_none());
    // The capture job is not offered as a sync the user can follow.
    SyncQueue::request(&f.db, &f.id, Priority::User, "test").unwrap();
    assert!(SyncQueue::states(&f.db, SyncQueue::now())
        .unwrap()
        .as_array()
        .unwrap()
        .is_empty());
    // A second pass with nothing new queues nothing more.
    let before = f.outbox();
    assert!(matches!(f.run_job().await, Some(Outcome::Captured)));
    assert_eq!(f.outbox(), before);
    f.assert_sent_nothing();
}

#[tokio::test]
async fn the_workspace_scan_captures_a_deleted_project_without_sending() {
    let f = Capture::new(restorable());
    f.edit_memory("Workspace capture\n");
    let mut db = db::open().unwrap();
    let owner = f.owner.clone();
    // The catalog request fails, which only ends the cycle after local work.
    assert!(sync_workspace(&mut db, &owner, None).await.is_err());
    assert_eq!(f.kinds(), ["memory".to_string()].into_iter().collect());
    assert!(f.outbox().iter().all(|row| row["held"] == 1));
    // Only the catalog request was attempted, and it failed before connecting
    // because tests have no signed-in session; the capture itself sent nothing.
    f.assert_sent_nothing();
    // The timer queues it with every capturable project.
    SyncQueue::request_all(&f.db, Priority::Timer, "timer").unwrap();
    assert!(
        db::rows(&f.db, "SELECT json_quote(project) FROM sync_queue", &[])
            .unwrap()
            .contains(&json!(f.id))
    );
}

#[tokio::test]
async fn nothing_captures_outside_the_restore_window() {
    let cases = [
        (
            "revoked",
            json!({"deletedAt":DELETED_AT,"purgeAfter":future(),"revoked":true}),
        ),
        (
            "hidden",
            json!({"deletedAt":DELETED_AT,"purgeAfter":future(),"hidden":true}),
        ),
        (
            "detached",
            json!({"deletedAt":DELETED_AT,"purgeAfter":future(),"detachedAt":DELETED_AT}),
        ),
        (
            "purged",
            json!({"deletedAt":DELETED_AT,"purgeAfter":future(),"purged":true}),
        ),
        ("archived only", json!({"archivedAt":DELETED_AT})),
        // A server before 0.7.4 sends no purgeAfter.
        ("pre-0.7.4 catalog", json!({"deletedAt":DELETED_AT})),
        (
            "unreadable purgeAfter",
            json!({"deletedAt":DELETED_AT,"purgeAfter":"soon"}),
        ),
    ];
    for (name, lifecycle) in cases {
        let f = Capture::new(lifecycle);
        f.edit_everything();
        let capturable: i64 =
            f.db.query_row(
                &format!(
                    "SELECT count(*) FROM projects WHERE {}",
                    *crate::projects::CAPTURABLE
                ),
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(capturable, 0, "{name}");
        assert!(
            crate::projects::require_capture(&f.db, &f.id, "memory").is_err(),
            "{name}"
        );
        assert!(
            matches!(f.run_job().await, Some(Outcome::Skipped)),
            "{name}"
        );
        let mut db = db::open().unwrap();
        let _ = sync_workspace(&mut db, &f.owner, None).await;
        assert!(f.outbox().is_empty(), "{name}");
        assert!(db::get(&f.db, "sync").unwrap().is_null(), "{name}");
    }
}

#[tokio::test]
async fn a_passed_purge_after_keeps_capturing_until_the_catalog_purges() {
    // The Mac's clock is not trusted to end the window.
    let f = Capture::new(
        json!({"deletedAt":DELETED_AT,"archivedAt":DELETED_AT,"purgeAfter":"2026-01-01T00:00:00Z"}),
    );
    f.edit_memory("Captured after the local deadline\n");
    assert!(matches!(f.run_job().await, Some(Outcome::Captured)));
    assert_eq!(f.outbox().len(), 1);
    f.assert_sent_nothing();
    // The purge tombstone ends it: held rows become drafts and their markers go.
    crate::projects::merge_catalog(
        &f.db,
        &json!([{"id":f.id,"deletedAt":DELETED_AT,"purged":true}]),
    )
    .unwrap();
    assert!(f.outbox().is_empty());
    assert!(
        !db::rows(&f.db, "SELECT value FROM drafts WHERE project=?", &[&f.id])
            .unwrap()
            .is_empty()
    );
    assert!(db::rows(
        &f.db,
        "SELECT value FROM meta WHERE key GLOB 'heldCapture:*'",
        &[]
    )
    .unwrap()
    .is_empty());
    f.edit_memory("After the purge\n");
    assert!(matches!(f.run_job().await, Some(Outcome::Skipped)));
    assert!(f.outbox().is_empty());
}

#[test]
fn capturable_adds_only_restorable_deletions_to_active_projects() {
    let f = Capture::new(json!({}));
    let count = |predicate: &str| -> i64 {
        f.db.query_row(
            &format!("SELECT count(*) FROM projects WHERE {predicate}"),
            [],
            |row| row.get(0),
        )
        .unwrap()
    };
    assert_eq!(count(crate::projects::ACTIVE), 1);
    assert_eq!(count(&crate::projects::CAPTURABLE), 1);
    assert_eq!(count(crate::projects::CAPTURE_ONLY), 0);
    // An active project keeps the ordinary sharing check, not the capture one.
    assert!(crate::projects::require_capture(&f.db, &f.id, "memory").is_err());
    crate::projects::require_sharing(&f.db, &f.id, "memory").unwrap();
    let mut project = f.project();
    project["deletedAt"] = json!(DELETED_AT);
    project["purgeAfter"] = json!(future());
    db::upsert(&f.db, "projects", &f.id, "", &project).unwrap();
    assert_eq!(count(crate::projects::ACTIVE), 0);
    assert_eq!(count(&crate::projects::CAPTURABLE), 1);
    assert_eq!(count(crate::projects::CAPTURE_ONLY), 1);
    crate::projects::require_capture(&f.db, &f.id, "memory").unwrap();
    assert!(crate::projects::require_sharing(&f.db, &f.id, "memory").is_err());
    project["sharing"] =
        json!({"memory":false,"skill":true,"session":false,"plan":true,"env":false});
    db::upsert(&f.db, "projects", &f.id, "", &project).unwrap();
    assert!(crate::projects::require_capture(&f.db, &f.id, "memory").is_err());
}

#[tokio::test]
async fn a_governed_deleted_project_drafts_but_defers_automatic_sharing() {
    let mut lifecycle = restorable();
    lifecycle["governed"] = json!(true);
    let f = Capture::new(lifecycle);
    f.edit_memory("Governed edit while deleted\n");
    assert!(matches!(f.run_job().await, Some(Outcome::Captured)));
    f.assert_sent_nothing();
    let drafts = db::rows(&f.db, "SELECT value FROM drafts WHERE project=?", &[&f.id]).unwrap();
    assert!(!drafts.is_empty());
    assert!(drafts.iter().all(|draft| draft["status"] == "local"));
    // Nothing is queued for automatic context sharing until a restore.
    assert!(f.outbox().iter().all(|row| row["kind"] != "memory"));
    assert!(db::rows(
        &f.db,
        "SELECT value FROM outbox WHERE path=?",
        &[&crate::context_sharing::QUEUE_PATH],
    )
    .unwrap()
    .is_empty());
}

#[tokio::test]
async fn a_restore_sends_held_rows_as_ordinary_uploads() {
    let f = Capture::new(restorable());
    f.edit_memory("Held until restore\n");
    assert!(matches!(f.run_job().await, Some(Outcome::Captured)));
    let held = f.outbox();
    assert_eq!(held.len(), 1);
    assert_eq!(held[0]["held"], 1);
    f.restore();
    let project = f.project();
    let id = held[0]["id"].as_str().unwrap();
    {
        let outbox = ProjectOutbox::open(&f.db, &f.id).unwrap();
        let queued = outbox.queued(&f.db).unwrap();
        assert_eq!(
            outbox
                .batch(&queued)
                .iter()
                .map(|row| row["id"].clone())
                .collect::<Vec<_>>(),
            [json!(id)]
        );
    }
    // The upload stage takes the row; it is no longer a never-sent capture
    // once handed to the network, even though this service is unreachable.
    let mut db = db::open().unwrap();
    let mut pass = SyncPass::new(&mut db, &f.owner, None);
    assert!(pass.drain_outbox(&project).await.is_err());
    let after = f.outbox();
    assert_eq!(after.len(), 1);
    assert_eq!(after[0]["id"], id);
    assert_eq!(after[0]["held"], 0);
    assert_eq!(after[0]["value"], held[0]["value"]);
    // The failed attempt is recorded and retried like any other upload.
    assert!(after[0]["error"]
        .as_str()
        .is_some_and(|error| error.starts_with("Sync authentication")));
    let outbox = ProjectOutbox::open(&f.db, &f.id).unwrap();
    assert_eq!(outbox.queued(&f.db).unwrap().len(), 1);
}

#[tokio::test]
async fn a_row_without_the_held_marker_still_loads_and_is_kept() {
    let f = Capture::new(restorable());
    // A row queued before the deletion, or by an older client, has no marker.
    let resource = "legacy-memory";
    let legacy = json!({"version":2,"id":"legacy","projectId":f.id,"deviceId":"old-mac","baseRevision":3,"resource":{"resourceId":resource,"kind":"memory","source":"shared","logicalPath":"instructions/CLAUDE.md","title":"CLAUDE.md","files":[],"deleted":true}});
    f.db.execute(
        "INSERT INTO outbox VALUES('legacy',?,'/v2/sync/push',?,NULL)",
        params![f.id, legacy.to_string()],
    )
    .unwrap();
    // A marker left by a row that an older client already sent is dropped.
    db::set(
        &f.db,
        &indexer::held_capture_key("sent-by-old-client"),
        &json!({"heldCapture":true,"projectId":f.id}),
    )
    .unwrap();
    f.edit_memory("New edit while deleted\n");
    assert!(matches!(f.run_job().await, Some(Outcome::Captured)));
    let rows = f.outbox();
    assert_eq!(rows[0]["id"], "legacy");
    assert_eq!(rows[0]["held"], 0);
    assert_eq!(rows[0]["value"], legacy);
    assert!(
        db::get(&f.db, &indexer::held_capture_key("sent-by-old-client"))
            .unwrap()
            .is_null()
    );
    f.restore();
    let outbox = ProjectOutbox::open(&f.db, &f.id).unwrap();
    let queued = outbox.queued(&f.db).unwrap();
    assert!(outbox
        .batch(&queued)
        .iter()
        .any(|row| row["id"] == "legacy"));
}

#[test]
fn removing_the_local_copy_drops_its_held_markers() {
    let f = Capture::new(restorable());
    db::set(
        &f.db,
        &indexer::held_capture_key("held"),
        &json!({"heldCapture":true,"projectId":f.id}),
    )
    .unwrap();
    db::set(
        &f.db,
        &indexer::held_capture_key("other"),
        &json!({"heldCapture":true,"projectId":"another-project"}),
    )
    .unwrap();
    crate::projects::remove_local(&f.db, &f.id).unwrap();
    assert!(db::get(&f.db, &indexer::held_capture_key("held"))
        .unwrap()
        .is_null());
    assert!(!db::get(&f.db, &indexer::held_capture_key("other"))
        .unwrap()
        .is_null());
}

#[tokio::test]
async fn explicit_purge_preserves_local_captures_and_guards_other_pending_work() {
    use crate::projects::ProjectLifecycle;

    let f = Capture::new(restorable());
    f.edit_memory("Recoverable held edit");
    assert!(matches!(f.run_job().await, Some(Outcome::Captured)));
    let held = f.outbox()[0]["id"].as_str().unwrap().to_string();
    assert!(f.db.queued_changes(&f.id, false).unwrap());
    assert!(!f.db.queued_changes(&f.id, true).unwrap());

    db::set(
        &f.db,
        "env:test:pending:publication",
        &json!({"header":{"manifest":{"projectId":f.id}}}),
    )
    .unwrap();
    assert!(f.db.queued_changes(&f.id, true).unwrap());
    f.db.execute(
        "DELETE FROM meta WHERE key='env:test:pending:publication'",
        [],
    )
    .unwrap();
    f.db.execute(
        "INSERT INTO outbox VALUES('older',?,'/v2/sync/push','{}',NULL)",
        [&f.id],
    )
    .unwrap();
    assert!(f.db.queued_changes(&f.id, true).unwrap());
    f.db.execute("DELETE FROM outbox WHERE id='older'", [])
        .unwrap();

    f.db.purge_local(&f.id).unwrap();
    assert!(f.outbox().is_empty());
    assert!(db::get(&f.db, &indexer::held_capture_key(&held))
        .unwrap()
        .is_null());
    let drafts = db::rows(&f.db, "SELECT value FROM drafts WHERE project=?", &[&f.id]).unwrap();
    let hash = drafts[0]["resource"]["files"][0]["hash"].as_str().unwrap();
    assert_eq!(db::blob_read(hash).unwrap(), b"Recoverable held edit");
    let snapshot = crate::commands::snapshot().unwrap();
    assert_eq!(snapshot["inactive"][0]["id"], f.id);
    assert_eq!(snapshot["inactive"][0]["purged"], true);
    assert_eq!(snapshot["inactive"][0]["purgeAfter"], Value::Null);
    assert!(snapshot["projects"].as_array().unwrap().is_empty());
    let path = f.home.path().join("purged-project.zip");
    bundles::export_project(&f.db, &f.id, &path).unwrap();
    let mut zip = zip::ZipArchive::new(fs::File::open(path).unwrap()).unwrap();
    let id = drafts[0]["id"].as_str().unwrap();
    assert!(zip.by_name(&format!("drafts/{id}/blobs/{hash}")).is_ok());
}
