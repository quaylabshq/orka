//! A deleted project that can still be restored keeps capturing local edits
//! into the outbox and sends nothing until it is restored.
use super::*;
use crate::{
    bundles,
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

    fn held_count(&self) -> i64 {
        indexer::held_count(&self.db, &self.id).unwrap()
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
async fn a_catalog_restore_queues_a_local_sync_and_hands_off_the_held_row() {
    let f = Capture::new(restorable());
    f.edit_memory("Held until the catalog restores it\n");
    assert!(matches!(f.run_job().await, Some(Outcome::Captured)));
    let held = f.outbox();
    assert_eq!(held.len(), 1);
    assert_eq!(held[0]["held"], 1);
    let id = held[0]["id"].as_str().unwrap().to_string();
    let jobs = || {
        db::rows(
            &f.db,
            "SELECT json_object('project',project,'priority',priority,'reason',reason) FROM sync_queue",
            &[],
        )
        .unwrap()
    };
    assert!(jobs().is_empty());
    // The catalog merge, not a manual request, wakes the restored project at
    // local priority so the held row does not wait for a timer.
    f.restore();
    assert_eq!(
        jobs(),
        [json!({"project":f.id.as_str(),"priority":Priority::Local as i64,"reason":"restore"})]
    );
    // The held row is an ordinary upload candidate, and the upload stage
    // releases its marker before the request goes out.
    let project = f.project();
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
    let mut db = db::open().unwrap();
    let mut pass = SyncPass::new(&mut db, &f.owner, None);
    assert!(pass.drain_outbox(&project).await.is_err());
    let after = f.outbox();
    assert_eq!(after.len(), 1);
    assert_eq!(after[0]["id"], id);
    assert_eq!(after[0]["held"], 0);
    assert_eq!(after[0]["value"], held[0]["value"]);
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

fn rowid(f: &Capture, id: &Value) -> i64 {
    f.db.query_row(
        "SELECT rowid FROM outbox WHERE id=?",
        [id.as_str().unwrap()],
        |row| row.get(0),
    )
    .unwrap()
}

fn write_session(f: &Capture, session: &str, messages: &[&str]) {
    let sessions = f.home.path().join(".claude/projects/deleted");
    fs::create_dir_all(&sessions).unwrap();
    let records = messages
        .iter()
        .map(|text| json!({"type":"user","sessionId":session,"cwd":f.root,"version":"2.1.283","message":{"role":"user","content":text}}))
        .collect::<Vec<_>>();
    fs::write(
        sessions.join(format!("{session}.jsonl")),
        native::encode(&records),
    )
    .unwrap();
}

#[tokio::test]
async fn three_edits_while_deleted_coalesce_into_one_row_with_the_latest_content() {
    let f = Capture::new(restorable());
    let session = uuid::Uuid::new_v4().to_string();
    let mut first: Option<Vec<Value>> = None;
    let mut ids = BTreeSet::new();
    let mut positions = Vec::new();
    for (round, text) in ["first\n", "second\n", "third\n"].iter().enumerate() {
        f.edit_memory(text);
        let messages = ["one", "two", "three"];
        write_session(&f, &session, &messages[..=round]);
        assert!(matches!(f.run_job().await, Some(Outcome::Captured)));
        let rows = f.outbox();
        assert_eq!(rows.len(), 2, "round {round}: {rows:?}");
        assert!(rows.iter().all(|row| row["held"] == 1));
        if first.is_none() {
            // Keep the original base to prove a replacement does not move it.
            for row in &rows {
                let mut value = row["value"].clone();
                value["baseRevision"] = json!(7);
                f.db.execute(
                    "UPDATE outbox SET value=? WHERE id=?",
                    params![value.to_string(), row["id"].as_str()],
                )
                .unwrap();
            }
            first = Some(f.outbox());
            positions = rows.iter().map(|row| rowid(&f, &row["id"])).collect();
        }
        for row in &rows {
            ids.insert(row["id"].as_str().unwrap().to_owned());
        }
    }
    let first = first.unwrap();
    let last = f.outbox();
    // Every replacement got a fresh request ID and kept its place and base.
    assert_eq!(ids.len(), 6);
    for (before, after) in first.iter().zip(&last) {
        assert_eq!(before["kind"], after["kind"]);
        assert_ne!(before["id"], after["id"]);
        assert_eq!(after["value"]["id"], after["id"]);
        assert_eq!(after["value"]["baseRevision"], 7);
        // A replaced row's blobs stay readable.
        for file in before["value"]["resource"]["files"].as_array().unwrap() {
            db::blob_read(file["hash"].as_str().unwrap()).unwrap();
        }
        // No marker is left for a replaced request.
        assert!(db::get(
            &f.db,
            &indexer::held_capture_key(before["id"].as_str().unwrap())
        )
        .unwrap()
        .is_null());
    }
    // Each replacement kept the first row's place in the queue.
    assert_eq!(
        last.iter()
            .map(|row| rowid(&f, &row["id"]))
            .collect::<Vec<_>>(),
        positions
    );
    let memory = last.iter().find(|row| row["kind"] == "memory").unwrap();
    let hash = memory["value"]["resource"]["files"][0]["hash"]
        .as_str()
        .unwrap();
    assert_eq!(db::blob_read(hash).unwrap(), b"third\n");
    let session = last.iter().find(|row| row["kind"] == "session").unwrap();
    let hash = session["value"]["resource"]["files"][0]["hash"]
        .as_str()
        .unwrap();
    assert!(String::from_utf8(db::blob_read(hash).unwrap())
        .unwrap()
        .contains("three"));
    // A restore sends only the latest version.
    f.restore();
    let outbox = ProjectOutbox::open(&f.db, &f.id).unwrap();
    let queued = outbox.queued(&f.db).unwrap();
    assert_eq!(
        outbox
            .batch(&queued)
            .iter()
            .map(|row| row["id"].clone())
            .collect::<Vec<_>>(),
        last.iter().map(|row| row["id"].clone()).collect::<Vec<_>>()
    );
}

#[tokio::test]
async fn rows_queued_before_the_deletion_are_never_rewritten() {
    let f = Capture::new(json!({}));
    f.edit_memory("Before the deletion\n");
    indexer::scan(&f.db, &f.project()).unwrap();
    let before = f.outbox();
    assert_eq!(before.len(), 1);
    assert_eq!(before[0]["held"], 0);
    let mut project = f.project();
    for (key, value) in restorable().as_object().unwrap() {
        project[key] = value.clone();
    }
    db::upsert(&f.db, "projects", &f.id, "", &project).unwrap();
    for text in ["During the deletion\n", "Later during the deletion\n"] {
        f.edit_memory(text);
        assert!(matches!(f.run_job().await, Some(Outcome::Captured)));
        // Keep the retry identity and a recoverable copy of the newer bytes.
        assert_eq!(f.outbox(), before);
        let drafts = db::rows(
            &f.db,
            "SELECT value FROM drafts WHERE project=? AND json_extract(value,'$.status')='local'",
            &[&f.id],
        )
        .unwrap();
        assert_eq!(drafts.len(), 1);
        let hash = drafts[0]["resource"]["files"][0]["hash"].as_str().unwrap();
        assert_eq!(db::blob_read(hash).unwrap(), text.as_bytes());
    }
}

#[tokio::test]
async fn sent_failed_or_earlier_deletion_rows_are_never_rewritten() {
    for case in ["handed to the network", "failed", "earlier deletion"] {
        let f = Capture::new(restorable());
        f.edit_memory("Captured\n");
        assert!(matches!(f.run_job().await, Some(Outcome::Captured)));
        let id = f.outbox()[0]["id"].as_str().unwrap().to_owned();
        match case {
            "handed to the network" => indexer::release_held_capture(&f.db, &id).unwrap(),
            "failed" => {
                f.db.execute(
                    "UPDATE outbox SET error=? WHERE id=?",
                    params![PLAN_REVISION_CONFLICT, id],
                )
                .unwrap();
            }
            _ => {
                // Restored before it drained, then deleted again.
                f.restore();
                let mut project = f.project();
                project["deletedAt"] = json!("2026-11-10T00:00:00Z");
                project["archivedAt"] = project["deletedAt"].clone();
                project["purgeAfter"] = json!(future());
                db::upsert(&f.db, "projects", &f.id, "", &project).unwrap();
            }
        }
        let before = f.outbox();
        f.edit_memory("Edited again\n");
        assert!(matches!(f.run_job().await, Some(Outcome::Captured)));
        assert_eq!(f.outbox(), before, "{case}");
    }
}

#[tokio::test]
async fn a_governed_plan_keeps_its_held_marker_when_its_context_grows() {
    let mut lifecycle = restorable();
    lifecycle["governed"] = json!(true);
    let f = Capture::new(lifecycle);
    let plans = f.root.join(".claude/plans");
    fs::create_dir_all(&plans).unwrap();
    let plan = plans.join("launch.md");
    fs::write(&plan, "# Launch plan\n").unwrap();
    // Another plan was queued before the deletion and may already be on its
    // way, so it has no held marker.
    let notes = plans.join("notes.md");
    fs::write(&notes, "# Notes\n").unwrap();
    let logical = "claude/files/notes.md";
    let earlier = json!({"version":2,"id":"before-delete","projectId":f.id,"deviceId":"this-mac","baseRevision":0,"resource":{
        "resourceId":indexer::scoped_resource_id(&f.db, &f.project(), "plan", logical).unwrap(),
        "kind":"plan","source":"claude","logicalPath":logical,"title":"Notes",
        "files":[crate::plans::content(b"# Notes\n").unwrap()],"deleted":false,"contextSources":[]}});
    f.db.execute(
        "INSERT INTO outbox VALUES('before-delete',?,'/v2/sync/push',?,NULL)",
        params![f.id, earlier.to_string()],
    )
    .unwrap();
    let earlier_row = || -> Vec<Value> {
        f.outbox()
            .into_iter()
            .filter(|row| row["value"]["resource"]["logicalPath"] == logical)
            .collect()
    };
    assert!(matches!(f.run_job().await, Some(Outcome::Captured)));
    let plan_rows = || -> Vec<Value> {
        f.outbox()
            .into_iter()
            .filter(|row| {
                row["kind"] == "plan" && row["value"]["resource"]["logicalPath"] != logical
            })
            .collect()
    };
    let first = plan_rows();
    assert_eq!(first.len(), 1);
    assert_eq!(first[0]["held"], 1);
    // A transcript referencing the plan, with sources its hooks recorded
    // before the deletion, adds context to the queued plan.
    let session = uuid::Uuid::new_v4().to_string();
    db::set(
        &f.db,
        &format!("sessionSources:{}:{session}", f.id),
        &json!(["shared-memory"]),
    )
    .unwrap();
    let sessions = f.home.path().join(".claude/projects/deleted");
    fs::create_dir_all(&sessions).unwrap();
    fs::write(
        sessions.join(format!("{session}.jsonl")),
        native::encode(&[
            json!({"type":"user","sessionId":session,"cwd":f.root,"version":"2.1.283","planFilePath":plan,"message":{"role":"user","content":"Write the launch plan"}}),
            json!({"type":"user","sessionId":session,"cwd":f.root,"version":"2.1.283","planFilePath":notes,"message":{"role":"user","content":"Read the notes"}}),
        ]),
    )
    .unwrap();
    assert!(matches!(f.run_job().await, Some(Outcome::Captured)));
    let grown = plan_rows();
    assert_eq!(grown.len(), 1);
    assert_ne!(grown[0]["id"], first[0]["id"]);
    assert!(grown[0]["value"]["resource"]["contextSources"]
        .as_array()
        .unwrap()
        .contains(&json!("shared-memory")));
    assert_eq!(grown[0]["held"], 1);
    // The plan queued before the deletion would also gain that context, but
    // keeps its request ID and body exactly as they were.
    let planned = db::get(&f.db, &format!("planSources:{}:{logical}", f.id)).unwrap();
    assert!(planned
        .as_array()
        .unwrap()
        .contains(&json!("shared-memory")));
    let kept = earlier_row();
    assert_eq!(kept.len(), 1);
    assert_eq!(kept[0]["id"], "before-delete");
    assert_eq!(kept[0]["held"], 0);
    assert_eq!(kept[0]["value"], earlier);
    // A second edit still coalesces into that one held row.
    fs::write(&plan, "# Launch plan\n\nRevised\n").unwrap();
    assert!(matches!(f.run_job().await, Some(Outcome::Captured)));
    let last = plan_rows();
    assert_eq!(last.len(), 1, "{last:?}");
    assert_eq!(last[0]["held"], 1);
    assert_eq!(earlier_row()[0]["value"], earlier);
    let hash = last[0]["value"]["resource"]["files"][0]["hash"]
        .as_str()
        .unwrap();
    assert!(String::from_utf8(db::blob_read(hash).unwrap())
        .unwrap()
        .contains("Revised"));
    assert!(db::rows(&f.db, "SELECT value FROM meta WHERE key GLOB 'heldCapture:*' AND substr(key,13) NOT IN (SELECT id FROM outbox)", &[])
        .unwrap()
        .is_empty());
    f.assert_sent_nothing();
}

#[tokio::test]
async fn a_held_row_in_a_redaction_rebuild_is_never_rewritten() {
    let f = Capture::new(restorable());
    let session = uuid::Uuid::new_v4().to_string();
    write_session(&f, &session, &["one"]);
    assert!(matches!(f.run_job().await, Some(Outcome::Captured)));
    let before = f.outbox();
    assert_eq!(before.len(), 1);
    db::set(
        &f.db,
        &outbox_redaction_key(before[0]["id"].as_str().unwrap()),
        &json!({"value":before[0]["value"],"state":null}),
    )
    .unwrap();
    write_session(&f, &session, &["one", "two"]);
    assert!(matches!(f.run_job().await, Some(Outcome::Captured)));
    assert_eq!(f.outbox(), before);
}

#[tokio::test]
async fn an_item_created_then_deleted_while_deleted_leaves_one_held_deletion() {
    let f = Capture::new(restorable());
    let file = f.root.join("AGENTS.md");
    fs::write(&file, "Short-lived instructions\n").unwrap();
    assert!(matches!(f.run_job().await, Some(Outcome::Captured)));
    let created = f.outbox();
    assert_eq!(created.len(), 1);
    let created_position = rowid(&f, &created[0]["id"]);
    let created_hash = created[0]["value"]["resource"]["files"][0]["hash"]
        .as_str()
        .unwrap()
        .to_owned();
    fs::remove_file(&file).unwrap();
    assert!(matches!(f.run_job().await, Some(Outcome::Captured)));
    let rows = f.outbox();
    assert_eq!(rows.len(), 1, "{rows:?}");
    assert_eq!(rows[0]["held"], 1);
    assert_ne!(rows[0]["id"], created[0]["id"]);
    assert_eq!(rows[0]["value"]["resource"]["deleted"], true);
    assert_eq!(rows[0]["value"]["baseRevision"], 0);
    // The deletion took the creation's place in the queue.
    assert_eq!(rowid(&f, &rows[0]["id"]), created_position);
    // The created version's blob stays readable.
    db::blob_read(&created_hash).unwrap();
    f.assert_sent_nothing();
}

#[tokio::test]
async fn held_count_covers_captured_and_unsent_rows_but_not_failed_ones() {
    let f = Capture::new(restorable());
    assert_eq!(f.held_count(), 0);
    f.edit_memory("Captured while deleted\n");
    assert!(matches!(f.run_job().await, Some(Outcome::Captured)));
    assert_eq!(f.held_count(), 1);
    // Another item captured in the same deletion adds up.
    let skill = f.root.join(".agents/skills/release");
    fs::create_dir_all(&skill).unwrap();
    fs::write(
        skill.join("SKILL.md"),
        "---\nname: release\ndescription: Ship it\n---\nSteps\n",
    )
    .unwrap();
    assert!(matches!(f.run_job().await, Some(Outcome::Captured)));
    assert_eq!(f.held_count(), 2);
    // A row queued before the deletion that was never sent is waiting too.
    let queued = uuid::Uuid::new_v4().to_string();
    f.db.execute(
        "INSERT INTO outbox VALUES(?,?,?,?,NULL)",
        params![
            queued,
            f.id,
            "/v2/sync/push",
            json!({"id":queued,"projectId":f.id,"resource":{"resourceId":"earlier","kind":"plan"}})
                .to_string()
        ],
    )
    .unwrap();
    assert_eq!(f.held_count(), 3);
    // Restore retries 403s, but not other failures, even on marked rows.
    f.db.execute(
        "UPDATE outbox SET error='403: Project access denied' WHERE id=?",
        [&queued],
    )
    .unwrap();
    assert_eq!(f.held_count(), 3);
    let first = f.outbox()[0]["id"].as_str().unwrap().to_owned();
    f.db.execute(
        "UPDATE outbox SET error=? WHERE id=?",
        params![PLAN_REVISION_CONFLICT, first],
    )
    .unwrap();
    assert_eq!(f.held_count(), 2);
    f.db.execute("UPDATE outbox SET error=NULL WHERE id=?", [&first])
        .unwrap();
    f.db.execute(
        "UPDATE outbox SET error=? WHERE id=?",
        params![PLAN_REVISION_CONFLICT, queued],
    )
    .unwrap();
    assert_eq!(f.held_count(), 2);
    let publication = "env:test:pending:publication";
    db::set(
        &f.db,
        publication,
        &json!({"header":{"manifest":{"projectId":f.id}}}),
    )
    .unwrap();
    let snapshot = crate::commands::snapshot().unwrap();
    assert_eq!(snapshot["inactive"][0]["heldChanges"], 2);
    assert_eq!(snapshot["inactive"][0]["pendingChanges"], 4);
    assert_eq!(snapshot["inactive"][0]["pendingEnvPublications"], 1);
    // A restore releases the marker just before upload, but the row is still
    // local work waiting, so it stays counted until it leaves the outbox.
    f.restore();
    indexer::release_held_capture(&f.db, &first).unwrap();
    assert_eq!(f.held_count(), 2);
    f.db.execute("DELETE FROM outbox WHERE id=?", [&first])
        .unwrap();
    assert_eq!(f.held_count(), 1);
    // Removing the local copy drops what was waiting with it.
    crate::projects::remove_local(&f.db, &f.id).unwrap();
    assert_eq!(f.held_count(), 0);
    assert!(f.outbox().is_empty());
    assert_eq!(db::get(&f.db, publication).unwrap(), Value::Null);
}

#[tokio::test]
async fn export_captures_edits_made_while_deleted() {
    let f = Capture::new(restorable());
    f.edit_memory("Exported while deleted\n");
    assert!(f.outbox().is_empty());
    let path = f.root.join("project.zip");
    bundles::export_project(&f.db, &f.id, &path).unwrap();
    let rows = f.outbox();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["held"], 1);
    let mut zip = zip::ZipArchive::new(fs::File::open(&path).unwrap()).unwrap();
    let mut header = Vec::new();
    use std::io::Read;
    zip.by_name("project.json")
        .unwrap()
        .read_to_end(&mut header)
        .unwrap();
    let header: Value = serde_json::from_slice(&header).unwrap();
    assert_eq!(header["pendingChanges"], 1);
    let prefix = format!("pending/{}/", rows[0]["id"].as_str().unwrap());
    let hash = rows[0]["value"]["resource"]["files"][0]["hash"]
        .as_str()
        .unwrap()
        .to_owned();
    let mut exported = Vec::new();
    zip.by_name(&format!("{prefix}blobs/{hash}"))
        .unwrap()
        .read_to_end(&mut exported)
        .unwrap();
    assert_eq!(exported, b"Exported while deleted\n");
    // An active project is not scanned by export, so nothing new is queued.
    f.restore();
    let before = f.outbox();
    bundles::export_project(&f.db, &f.id, &path).unwrap();
    assert_eq!(f.outbox(), before);
}

#[tokio::test]
async fn export_keeps_held_changes_when_the_deleted_project_folder_is_missing() {
    use std::io::Read;

    let f = Capture::new(restorable());
    f.edit_memory("Held before the folder went missing\n");
    assert!(matches!(f.run_job().await, Some(Outcome::Captured)));
    let rows = f.outbox();
    assert_eq!(rows.len(), 1);
    assert_eq!(rows[0]["held"], 1);
    fs::remove_dir_all(&f.root).unwrap();

    let path = f.home.path().join("project.zip");
    bundles::export_project(&f.db, &f.id, &path).unwrap();
    assert_eq!(f.outbox(), rows);
    let error: String =
        f.db.query_row("SELECT error FROM errors WHERE source=?", [&f.id], |row| {
            row.get(0)
        })
        .unwrap();
    assert!(
        error.contains("folder") && error.contains("unavailable"),
        "{error}"
    );
    let mut zip = zip::ZipArchive::new(fs::File::open(path).unwrap()).unwrap();
    let header: Value = serde_json::from_reader(zip.by_name("project.json").unwrap()).unwrap();
    assert_eq!(header["pendingChanges"], 1);
    let id = rows[0]["id"].as_str().unwrap();
    let hash = rows[0]["value"]["resource"]["files"][0]["hash"]
        .as_str()
        .unwrap();
    let mut exported = Vec::new();
    zip.by_name(&format!("pending/{id}/blobs/{hash}"))
        .unwrap()
        .read_to_end(&mut exported)
        .unwrap();
    assert_eq!(exported, b"Held before the folder went missing\n");
}

#[test]
fn deleted_project_export_includes_the_latest_edit_behind_a_pending_request() {
    use std::io::Read;

    let f = Capture::new(json!({}));
    f.edit_memory("Queued before deletion\n");
    indexer::scan(&f.db, &f.project()).unwrap();
    let queued = f.outbox();
    let mut project = f.project();
    for (key, value) in restorable().as_object().unwrap() {
        project[key] = value.clone();
    }
    db::upsert(&f.db, "projects", &f.id, "", &project).unwrap();
    f.edit_memory("Latest edit while deleted\n");

    let path = f.home.path().join("project.zip");
    bundles::export_project(&f.db, &f.id, &path).unwrap();
    assert_eq!(f.outbox(), queued);
    let mut zip = zip::ZipArchive::new(fs::File::open(path).unwrap()).unwrap();
    let header: Value = serde_json::from_reader(zip.by_name("project.json").unwrap()).unwrap();
    assert_eq!(header["pendingChanges"], 1);
    assert_eq!(header["drafts"], 1);
    let draft = db::rows(&f.db, "SELECT value FROM drafts WHERE project=?", &[&f.id])
        .unwrap()
        .remove(0);
    let id = draft["id"].as_str().unwrap();
    let hash = draft["resource"]["files"][0]["hash"].as_str().unwrap();
    let mut bytes = Vec::new();
    zip.by_name(&format!("drafts/{id}/blobs/{hash}"))
        .unwrap()
        .read_to_end(&mut bytes)
        .unwrap();
    assert_eq!(bytes, b"Latest edit while deleted\n");
}

async fn a_new_embedded_plan_proposal_replaces_the_held_plan() {
    let f = Capture::new(restorable());
    let id = uuid::Uuid::new_v4().to_string();
    let sessions = f.home.path().join(".claude/projects/deleted");
    fs::create_dir_all(&sessions).unwrap();
    let transcript = sessions.join(format!("{id}.jsonl"));
    let mut records = vec![
        json!({"type":"user","sessionId":id,"cwd":f.root,"version":"2.1.283","message":{"role":"user","content":"Plan the update"}}),
    ];
    let mut previous = None;
    for text in ["# First proposal", "# Revised proposal"] {
        records.push(json!({"type":"assistant","sessionId":id,"cwd":f.root,"message":{"role":"assistant","content":[{"type":"tool_use","name":"ExitPlanMode","input":{"plan":text}}]}}));
        fs::write(&transcript, native::encode(&records)).unwrap();
        assert!(matches!(f.run_job().await, Some(Outcome::Captured)));
        let plans: Vec<_> = f
            .outbox()
            .into_iter()
            .filter(|row| row["kind"] == "plan")
            .collect();
        assert_eq!(plans.len(), 1);
        let hash = plans[0]["value"]["resource"]["files"][0]["hash"]
            .as_str()
            .unwrap();
        assert_eq!(db::blob_read(hash).unwrap(), text.as_bytes());
        assert_ne!(previous, Some(plans[0]["id"].clone()));
        previous = Some(plans[0]["id"].clone());
    }
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
}
