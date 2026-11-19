use super::*;
use rusqlite::OptionalExtension;

fn set_error(f: &Fixture, row: &str, project: &str, error: &str) {
    f.db.execute(
        "INSERT OR REPLACE INTO outbox VALUES(?,?,'/v2/sync/push','{}',?)",
        rusqlite::params![row, project, error],
    )
    .unwrap();
}

fn error(f: &Fixture, row: &str) -> Option<String> {
    f.db.query_row("SELECT error FROM outbox WHERE id=?", [row], |r| r.get(0))
        .optional()
        .unwrap()
        .flatten()
}

fn queue(f: &Fixture, project: &str) -> Option<(i64, String)> {
    f.db.query_row(
        "SELECT priority, reason FROM sync_queue WHERE project=?",
        [project],
        |r| Ok((r.get(0)?, r.get(1)?)),
    )
    .optional()
    .unwrap()
}

fn future() -> String {
    (chrono::Utc::now() + chrono::Duration::days(30)).to_rfc3339()
}

#[test]
fn leaving_the_deleted_or_archived_state_queues_a_local_sync() {
    for (lifecycle, restore) in [
        (
            json!({"deletedAt":"2026-01-01T00:00:00Z","purgeAfter":future()}),
            json!({"archivedAt":null,"deletedAt":null}),
        ),
        (
            json!({"archivedAt":"2026-01-01T00:00:00Z"}),
            json!({"archivedAt":null}),
        ),
    ] {
        let f = Fixture::new();
        let id = f.project["id"].as_str().unwrap().to_string();
        let mut inactive = json!({"id":id,"name":"test","role":"member","lifecycleRevision":1});
        for (key, value) in lifecycle.as_object().unwrap() {
            inactive[key.as_str()] = value.clone();
        }
        crate::projects::merge_catalog(&f.db, &json!([inactive])).unwrap();
        assert!(crate::projects::active(&f.db, &id).is_err());
        assert_eq!(queue(&f, &id), None);
        // 0.3.13 left this uncoded refusal behind. A restore clears it with the
        // other 403 rows even though the one-time sweep already ran.
        set_error(&f, "refused", &id, "403: Project access denied");
        let mut active = json!({"id":id,"name":"test","role":"member","lifecycleRevision":2});
        for (key, value) in restore.as_object().unwrap() {
            active[key.as_str()] = value.clone();
        }
        crate::projects::merge_catalog(&f.db, &json!([active])).unwrap();
        crate::projects::active(&f.db, &id).unwrap();
        assert_eq!(error(&f, "refused"), None);
        assert_eq!(queue(&f, &id), Some((1, "restore".to_string())));
    }
}

#[test]
fn a_second_merge_without_a_flip_does_not_queue_again() {
    let f = Fixture::new();
    let id = f.project["id"].as_str().unwrap().to_string();
    let deleted =
        json!([{"id":id,"name":"test","deletedAt":"2026-01-01T00:00:00Z","purgeAfter":future()}]);
    crate::projects::merge_catalog(&f.db, &deleted).unwrap();
    let restored = json!([{"id":id,"name":"test","role":"member","lifecycleRevision":2}]);
    crate::projects::merge_catalog(&f.db, &restored).unwrap();
    assert_eq!(queue(&f, &id), Some((1, "restore".to_string())));
    f.db.execute("DELETE FROM sync_queue", []).unwrap();
    crate::projects::merge_catalog(&f.db, &restored).unwrap();
    assert_eq!(queue(&f, &id), None);
}

#[test]
fn an_owner_restore_receipt_unblocks_held_uploads_after_the_legacy_sweep() {
    let f = Fixture::new();
    let id = f.project["id"].as_str().unwrap();
    let deleted = json!([{
        "id":id, "name":"test", "role":"owner", "lifecycleRevision":1,
        "deletedAt":"2026-01-01T00:00:00Z", "purgeAfter":future()
    }]);
    set_error(&f, "refused", id, "403: Project access denied");
    set_error(&f, "conflict", id, "409: Project changed");
    crate::projects::merge_catalog(&f.db, &deleted).unwrap();
    assert_eq!(db::get(&f.db, "legacyDeniedRetry").unwrap(), json!(true));
    assert_eq!(
        error(&f, "refused").as_deref(),
        Some("403: Project access denied")
    );
    assert_eq!(queue(&f, id), None);

    let receipt = json!({"lifecycleRevision":2,"archivedAt":null,"deletedAt":null});
    crate::projects::apply_restore_receipt(&f.db, id, &receipt).unwrap();

    crate::projects::active(&f.db, id).unwrap();
    assert_eq!(error(&f, "refused"), None);
    assert_eq!(
        error(&f, "conflict").as_deref(),
        Some("409: Project changed")
    );
    assert_eq!(queue(&f, id), Some((2, "restore".to_string())));

    // A retry of the same mutation receipt does not retry a fresh denial.
    set_error(&f, "refused", id, "403: Project access denied");
    crate::projects::apply_restore_receipt(&f.db, id, &receipt).unwrap();
    assert_eq!(
        error(&f, "refused").as_deref(),
        Some("403: Project access denied")
    );

    // The old receipt cannot bring back a project deleted again elsewhere.
    let mut deleted_again = deleted;
    deleted_again[0]["lifecycleRevision"] = json!(3);
    crate::projects::merge_catalog(&f.db, &deleted_again).unwrap();
    crate::projects::apply_restore_receipt(&f.db, id, &receipt).unwrap();
    assert!(crate::projects::active(&f.db, id).is_err());
    assert_eq!(
        error(&f, "refused").as_deref(),
        Some("403: Project access denied")
    );
}

#[test]
fn the_legacy_access_denied_retry_runs_once_and_leaves_other_errors_alone() {
    let f = Fixture::new();
    let id = f.project["id"].as_str().unwrap().to_string();
    let archived = uuid::Uuid::new_v4().to_string();
    db::upsert(
        &f.db,
        "projects",
        &archived,
        "",
        &json!({"id":archived,"name":"archive","archivedAt":"2026-01-01T00:00:00Z","lifecycleRevision":1}),
    )
    .unwrap();
    for (row, project, failure) in [
        ("legacy", id.as_str(), "403: Project access denied"),
        ("coded", id.as_str(), "403: not_member: Not a member"),
        ("offline", id.as_str(), "503: Service unavailable"),
        ("inactive", archived.as_str(), "403: Project access denied"),
    ] {
        set_error(&f, row, project, failure);
    }
    let catalog = json!([
        {"id":id,"name":"test","role":"member","lifecycleRevision":2},
        {"id":archived,"name":"archive","archivedAt":"2026-01-01T00:00:00Z","lifecycleRevision":2}
    ]);
    crate::projects::merge_catalog(&f.db, &catalog).unwrap();
    // The uncoded 0.3.13 row retries now; every other failure keeps its meaning.
    assert_eq!(error(&f, "legacy"), None);
    assert_eq!(
        error(&f, "coded").as_deref(),
        Some("403: not_member: Not a member")
    );
    assert_eq!(
        error(&f, "offline").as_deref(),
        Some("503: Service unavailable")
    );
    // A project that still cannot send waits for its own restore.
    assert_eq!(
        error(&f, "inactive").as_deref(),
        Some("403: Project access denied")
    );
    assert_eq!(db::get(&f.db, "legacyDeniedRetry").unwrap(), json!(true));
    assert_eq!(queue(&f, &id), Some((1, "retry".to_string())));
    // The sweep never runs again, so a later legacy row is left in place.
    f.db.execute("DELETE FROM sync_queue", []).unwrap();
    set_error(&f, "later", &id, "403: Project access denied");
    crate::projects::merge_catalog(&f.db, &catalog).unwrap();
    assert_eq!(
        error(&f, "later").as_deref(),
        Some("403: Project access denied")
    );
    assert_eq!(queue(&f, &id), None);
}
