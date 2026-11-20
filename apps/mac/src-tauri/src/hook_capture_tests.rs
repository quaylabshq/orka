//! Hooks keep tracking a session in a deleted project that can still be
//! restored, but inject no shared context until the project is back.
use super::*;

fn memory(f: &Fixture, title: &str, content: &str) -> Value {
    let id = uuid::Uuid::new_v4().to_string();
    let r = json!({"resourceId":id,"projectId":f.project["id"],"kind":"memory","source":"codex","logicalPath":format!("codex/entries/{id}.md"),"title":title,"files":[{"path":"content.md","hash":db::blob(content.as_bytes()).unwrap(),"size":content.len(),"executable":false}],"deleted":false,"revision":1,"updatedAt":db::now()});
    db::upsert(
        &f.db,
        "resources",
        &id,
        f.project["id"].as_str().unwrap(),
        &r,
    )
    .unwrap();
    r
}

fn set_lifecycle(f: &Fixture, lifecycle: Value) {
    let mut project = f.project.clone();
    for (key, value) in lifecycle.as_object().unwrap() {
        project[key] = value.clone();
    }
    db::upsert(
        &f.db,
        "projects",
        f.project["id"].as_str().unwrap(),
        "",
        &project,
    )
    .unwrap();
}

fn restorable() -> Value {
    json!({"deletedAt":"2026-11-01T00:00:00Z","archivedAt":"2026-11-01T00:00:00Z","purgeAfter":(chrono::Utc::now()+chrono::Duration::days(30)).to_rfc3339()})
}

fn hook(f: &Fixture, session: &str, event: &str, prompt: &str) -> Value {
    native::hook(
        "codex",
        json!({"cwd":f.root,"session_id":session,"hook_event_name":event,"prompt":prompt,"transcript_path":f.root.join("session.jsonl")}),
    )
    .unwrap()
}

fn active_row(f: &Fixture, session: &str) -> Option<Value> {
    db::rows(
        &f.db,
        "SELECT value FROM active WHERE native_id=?",
        &[&session],
    )
    .unwrap()
    .into_iter()
    .next()
}

fn session_sources(f: &Fixture, session: &str) -> Value {
    db::get(
        &f.db,
        &format!(
            "sessionSources:{}:{session}",
            f.project["id"].as_str().unwrap()
        ),
    )
    .unwrap()
}

#[test]
fn a_deleted_project_tracks_the_session_without_injecting_context() {
    let f = Fixture::new();
    let fact = memory(
        &f,
        "Signing notarization",
        "Signing notarization requires the Developer ID certificate.",
    );
    set_lifecycle(&f, json!({"governed":true}));
    let session = uuid::Uuid::new_v4().to_string();
    let output = hook(
        &f,
        &session,
        "UserPromptSubmit",
        "Check signing notarization",
    );
    assert!(output.to_string().contains("Developer ID"), "{output}");
    let known = json!([fact["resourceId"]]);

    // Leave matching, undelivered context so deduplication cannot explain {}.
    memory(
        &f,
        "Signing notarization status",
        "Check signing notarization status with notarytool.",
    );
    let mut deleted = restorable();
    deleted["governed"] = json!(true);
    set_lifecycle(&f, deleted);
    let output = hook(
        &f,
        &session,
        "UserPromptSubmit",
        "Check signing notarization",
    );
    assert_eq!(output, json!({}));
    // The session is still recorded against the project, with its sources.
    let active = active_row(&f, &session).unwrap();
    assert_eq!(active["project"], f.project["id"]);
    assert_eq!(active["source"], "codex");
    assert_eq!(active["ended"], false);
    assert_eq!(active["contextSources"], known);
    assert_eq!(session_sources(&f, &session), known);
    assert!(db::get(&f.db, "hookSeen:codex").unwrap().is_string());
    // A later prompt still injects nothing.
    assert_eq!(
        hook(
            &f,
            &session,
            "UserPromptSubmit",
            "Check signing notarization"
        ),
        json!({})
    );
    // Ending the session closes it and keeps the sources for the upload.
    assert_eq!(hook(&f, &session, "SessionEnd", ""), json!({}));
    assert!(active_row(&f, &session).is_none());
    assert_eq!(session_sources(&f, &session), known);
}

#[test]
fn an_active_project_still_injects_shared_context_once() {
    let f = Fixture::new();
    // A governed project records the sources it delivered in the session.
    set_lifecycle(&f, json!({"governed":true}));
    let fact = memory(
        &f,
        "Signing notarization",
        "Signing notarization requires the Developer ID certificate.",
    );
    let session = uuid::Uuid::new_v4().to_string();
    let output = hook(
        &f,
        &session,
        "UserPromptSubmit",
        "Check signing notarization",
    );
    assert!(output.to_string().contains("Developer ID"), "{output}");
    // The same context is not delivered twice in a session.
    assert_eq!(
        hook(
            &f,
            &session,
            "UserPromptSubmit",
            "Check signing notarization"
        ),
        json!({})
    );
    let active = active_row(&f, &session).unwrap();
    assert_eq!(active["contextSources"], json!([fact["resourceId"]]));
    assert_eq!(session_sources(&f, &session), json!([fact["resourceId"]]));
    assert_eq!(hook(&f, &session, "Stop", ""), json!({}));
    assert_eq!(hook(&f, &session, "SessionEnd", ""), json!({}));
    assert!(active_row(&f, &session).is_none());
}

#[test]
fn other_inactive_projects_record_nothing() {
    let f = Fixture::new();
    memory(
        &f,
        "Signing notarization",
        "Signing notarization requires the Developer ID certificate.",
    );
    let deleted_with = |key: &str, value: Value| {
        let mut lifecycle = restorable();
        lifecycle[key] = value;
        lifecycle
    };
    let cases = [
        (
            "archived only",
            json!({"archivedAt":"2026-11-01T00:00:00Z"}),
        ),
        // A server before 0.7.4 sends no purgeAfter, so nothing is captured.
        (
            "deleted without purgeAfter",
            json!({"deletedAt":"2026-11-01T00:00:00Z"}),
        ),
        ("revoked", deleted_with("revoked", json!(true))),
        (
            "detached",
            deleted_with("detachedAt", json!("2026-11-02T00:00:00Z")),
        ),
        ("purged", deleted_with("purged", json!(true))),
        ("hidden", deleted_with("hidden", json!(true))),
    ];
    for (name, lifecycle) in cases {
        set_lifecycle(&f, lifecycle);
        let session = uuid::Uuid::new_v4().to_string();
        assert_eq!(
            hook(
                &f,
                &session,
                "UserPromptSubmit",
                "Check signing notarization"
            ),
            json!({}),
            "{name}"
        );
        assert!(active_row(&f, &session).is_none(), "{name}");
        assert_eq!(session_sources(&f, &session), Value::Null, "{name}");
    }
}

#[test]
fn a_deleted_project_does_not_persist_sources_for_an_unknown_session() {
    let f = Fixture::new();
    set_lifecycle(&f, restorable());
    assert_eq!(hook(&f, "unknown", "SessionEnd", ""), json!({}));
    assert_eq!(session_sources(&f, "unknown"), Value::Null);
}

#[test]
fn a_past_deadline_still_tracks_until_the_catalog_drops_the_project() {
    let f = Fixture::new();
    memory(
        &f,
        "Signing notarization",
        "Signing notarization requires the Developer ID certificate.",
    );
    // The restore window ends with a purge tombstone or a catalog that no
    // longer lists the project, not with this Mac's clock.
    set_lifecycle(
        &f,
        json!({"deletedAt":"2026-11-01T00:00:00Z","archivedAt":"2026-11-01T00:00:00Z","purgeAfter":"2026-11-02T00:00:00Z"}),
    );
    let session = uuid::Uuid::new_v4().to_string();
    assert_eq!(
        hook(
            &f,
            &session,
            "UserPromptSubmit",
            "Check signing notarization"
        ),
        json!({})
    );
    assert_eq!(
        active_row(&f, &session).unwrap()["project"],
        f.project["id"]
    );
    assert_eq!(session_sources(&f, &session), Value::Null);
    // A detached copy records nothing for a new session.
    set_lifecycle(
        &f,
        json!({"deletedAt":"2026-11-01T00:00:00Z","purgeAfter":"2026-11-02T00:00:00Z","detachedAt":"2026-11-02T00:00:00Z"}),
    );
    let later = uuid::Uuid::new_v4().to_string();
    assert_eq!(
        hook(&f, &later, "UserPromptSubmit", "Check signing notarization"),
        json!({})
    );
    assert!(active_row(&f, &later).is_none());
    assert_eq!(session_sources(&f, &later), Value::Null);
}

#[test]
fn hook_activity_is_recorded_per_source_folder_and_tool_wide() {
    let f = Fixture::new();
    let second = f.root.join("second");
    fs::create_dir(&second).unwrap();
    let mut project = f.project.clone();
    project["path"] = Value::Null;
    project["sources"] = json!([{"id":"one","path":f.root},{"id":"two","path":second}]);
    let id = project["id"].as_str().unwrap();
    db::upsert(&f.db, "projects", id, "", &project).unwrap();
    native::hook(
        "codex",
        json!({"cwd":second.join("nested"),"session_id":"s","hook_event_name":"SessionStart"}),
    )
    .unwrap();
    // Older Orka versions and setup status still read the tool-wide key.
    assert!(db::get(&f.db, "hookSeen:codex").unwrap().is_string());
    assert!(db::get(&f.db, "hookSeen:codex:two").unwrap().is_string());
    assert!(db::get(&f.db, "hookSeen:codex:one").unwrap().is_null());
    assert!(db::get(&f.db, "hookSeen:claude:two").unwrap().is_null());
}
