use super::*;

#[test]
fn project_removal_clears_only_its_frozen_pending_session_snapshots() {
    let f = Fixture::new();
    let id = f.project["id"].as_str().unwrap();
    db::set(
        &f.db,
        "sessionCopy:removed",
        &json!({"source":{"projectId":id}}),
    )
    .unwrap();
    db::set(
        &f.db,
        "sessionCopy:other",
        &json!({"source":{"projectId":"other"}}),
    )
    .unwrap();
    db::set(&f.db, "env:trust", &json!({"projectId":id})).unwrap();
    crate::projects::remove_local(&f.db, id).unwrap();
    assert!(db::get(&f.db, "sessionCopy:removed").unwrap().is_null());
    assert_eq!(
        db::get(&f.db, "sessionCopy:other").unwrap()["source"]["projectId"],
        "other"
    );
}

fn session(f: &Fixture, label: &str, revision: i64) -> Value {
    let resource_id = uuid::Uuid::new_v4().to_string();
    let bytes = native::encode(&[
        json!({"type":"user","uuid":uuid::Uuid::new_v4().to_string(),"message":{"role":"user","content":label}}),
    ]);
    json!({"resourceId":resource_id,"projectId":f.project["id"],"kind":"session","source":"claude","logicalPath":format!("claude/{resource_id}"),"title":label,"files":[{"path":"session.jsonl","hash":db::blob(&bytes).unwrap(),"size":bytes.len(),"executable":false}],"deleted":false,"revision":revision,"owner":db::get(&f.db,"user").unwrap()})
}

fn conflict(f: &Fixture, current: &Value, label: &str, author: &str) -> Value {
    let mut candidate = session(f, label, 5);
    candidate["resourceId"] = current["resourceId"].clone();
    candidate["sourceId"] = current["sourceId"].clone();
    let conflict = json!({"id":uuid::Uuid::new_v4().to_string(),"resourceId":current["resourceId"],"candidate":candidate,"author":author});
    db::upsert(
        &f.db,
        "conflicts",
        conflict["id"].as_str().unwrap(),
        f.project["id"].as_str().unwrap(),
        &conflict,
    )
    .unwrap();
    conflict
}

fn save(f: &Fixture, resource: &Value) {
    db::upsert(
        &f.db,
        "resources",
        resource["resourceId"].as_str().unwrap(),
        f.project["id"].as_str().unwrap(),
        resource,
    )
    .unwrap();
}

fn only_draft(f: &Fixture) -> Value {
    let drafts = db::rows(&f.db, "SELECT value FROM drafts", &[]).unwrap();
    assert_eq!(drafts.len(), 1);
    drafts[0].clone()
}

#[test]
fn project_detach_preserves_own_conflict_candidate_without_retaining_teammates() {
    let f = Fixture::new();
    let current = session(&f, "Accepted current", 7);
    save(&f, &current);
    let user = db::get(&f.db, "user").unwrap();
    let own = conflict(&f, &current, "My rejected upload", user.as_str().unwrap());
    conflict(
        &f,
        &current,
        "Teammate rejected upload",
        &uuid::Uuid::new_v4().to_string(),
    );
    assert!(
        f.outbox().is_empty(),
        "The conflicted upload was already acknowledged"
    );
    crate::projects::merge_catalog(&f.db, &json!([])).unwrap();
    assert_eq!(
        only_draft(&f)["resource"]["files"],
        own["candidate"]["files"]
    );
    assert!(db::rows(&f.db, "SELECT value FROM conflicts", &[])
        .unwrap()
        .is_empty());
    crate::projects::merge_catalog(&f.db, &json!([])).unwrap();
    assert_eq!(
        only_draft(&f)["resource"]["files"],
        own["candidate"]["files"]
    );
}

#[test]
fn project_detach_keeps_an_explicit_resolution_selection_after_the_cache_changes() {
    for (action, selected) in [
        ("copy", "candidate"),
        ("override", "candidate"),
        ("keep", "current"),
    ] {
        let f = Fixture::new();
        let current = session(&f, "Selected current", 7);
        save(&f, &current);
        let other = conflict(
            &f,
            &current,
            "Explicitly selected candidate",
            &uuid::Uuid::new_v4().to_string(),
        );
        crate::commands::session_action(
            current["resourceId"].as_str().unwrap().into(),
            action.into(),
            Some(other["id"].as_str().unwrap().into()),
            Some(selected.into()),
        )
        .unwrap();
        let queued = f.outbox()[0].clone();
        assert!(
            queued["resource"].is_null(),
            "The strict wire contract is unchanged"
        );
        let expected = if selected == "candidate" {
            &other["candidate"]
        } else {
            &current
        };
        f.db.execute("DELETE FROM conflicts", []).unwrap();
        let mut latest = session(&f, "Newer cache", 8);
        latest["resourceId"] = current["resourceId"].clone();
        save(&f, &latest);
        assert_eq!(
            sync::queued_session_snapshot(&f.db, &queued)
                .unwrap()
                .unwrap()["files"],
            expected["files"]
        );
        crate::projects::merge_catalog(&f.db, &json!([])).unwrap();
        assert_eq!(only_draft(&f)["resource"]["files"], expected["files"]);
        assert!(f.outbox().is_empty());
        assert!(db::get(
            &f.db,
            &format!("sessionCopy:{}", queued["id"].as_str().unwrap())
        )
        .unwrap()
        .is_null());
    }
}

#[test]
fn project_detach_never_substitutes_a_newer_current_for_a_legacy_resolution() {
    let f = Fixture::new();
    let current = session(&f, "Current at revision seven", 7);
    save(&f, &current);
    let other = conflict(
        &f,
        &current,
        "Legacy candidate",
        &uuid::Uuid::new_v4().to_string(),
    );
    let mut queued = json!({"version":2,"id":uuid::Uuid::new_v4().to_string(),"projectId":f.project["id"],"deviceId":"device","resourceId":current["resourceId"],"conflictId":other["id"],"expectedRevision":7,"action":"override","selected":"candidate"});
    assert_eq!(
        sync::queued_session_snapshot(&f.db, &queued)
            .unwrap()
            .unwrap()["files"],
        other["candidate"]["files"]
    );
    queued["selected"] = json!("current");
    assert_eq!(
        sync::queued_session_snapshot(&f.db, &queued)
            .unwrap()
            .unwrap()["files"],
        current["files"]
    );
    let mut latest = current.clone();
    latest["revision"] = json!(8);
    save(&f, &latest);
    assert!(sync::queued_session_snapshot(&f.db, &queued)
        .unwrap()
        .is_none());
    indexer::queue(
        &f.db,
        f.project["id"].as_str().unwrap(),
        "/v2/sessions/resolve",
        &queued,
    )
    .unwrap();
    let error = crate::projects::merge_catalog(&f.db, &json!([])).unwrap_err();
    assert!(
        error.contains("queued session selection is unavailable"),
        "{error}"
    );
    assert_eq!(f.outbox(), vec![queued]);
    assert_eq!(f.resources()[0]["revision"], 8);
    assert!(db::rows(&f.db, "SELECT value FROM drafts", &[])
        .unwrap()
        .is_empty());
}

#[test]
fn project_resolution_snapshot_is_removed_after_acknowledgement() {
    let f = Fixture::new();
    let current = session(&f, "Current", 7);
    save(&f, &current);
    let other = conflict(&f, &current, "Candidate", &uuid::Uuid::new_v4().to_string());
    crate::commands::session_action(
        current["resourceId"].as_str().unwrap().into(),
        "keep".into(),
        Some(other["id"].as_str().unwrap().into()),
        Some("current".into()),
    )
    .unwrap();
    let queued = f.outbox()[0].clone();
    let key = format!("sessionCopy:{}", queued["id"].as_str().unwrap());
    assert!(db::get(&f.db, &key).unwrap().is_object());
    sync::acknowledge_session(
        &f.db,
        f.project["id"].as_str().unwrap(),
        "/v2/sessions/resolve",
        &queued,
        &json!({}),
    )
    .unwrap();
    assert!(db::get(&f.db, &key).unwrap().is_null());
}

#[test]
fn project_source_removal_keeps_the_explicit_conflict_selection() {
    let mut f = Fixture::new();
    let source_id = uuid::Uuid::new_v4().to_string();
    let source =
        json!({"id":source_id,"name":"repo","path":f.root,"removedAt":"2026-11-19T00:00:00Z"});
    f.project["sources"] = json!([{"id":source_id,"name":"repo","path":f.root}]);
    let project = f.project["id"].as_str().unwrap();
    db::upsert(&f.db, "projects", project, project, &f.project).unwrap();
    let mut current = session(&f, "Current", 7);
    current["sourceId"] = json!(source_id);
    save(&f, &current);
    let other = conflict(
        &f,
        &current,
        "Selected candidate",
        &uuid::Uuid::new_v4().to_string(),
    );
    crate::commands::session_action(
        current["resourceId"].as_str().unwrap().into(),
        "override".into(),
        Some(other["id"].as_str().unwrap().into()),
        Some("candidate".into()),
    )
    .unwrap();
    let queued = f.outbox()[0].clone();
    crate::sources::preserve_removed_queue(&f.db, project, &source).unwrap();
    assert_eq!(
        only_draft(&f)["resource"]["files"],
        other["candidate"]["files"]
    );
    assert!(f.outbox().is_empty());
    assert!(db::get(
        &f.db,
        &format!("sessionCopy:{}", queued["id"].as_str().unwrap())
    )
    .unwrap()
    .is_null());
}

#[test]
fn recovery_choices_need_the_displayed_tombstone_owner_and_sole_candidate() {
    let f = Fixture::new();
    let user = db::get(&f.db, "user").unwrap();
    let mut current = session(&f, "Review fixture", 5);
    current["deleted"] = json!(true);
    current["files"] = json!([]);
    save(&f, &current);
    let project = f.project["id"].as_str().unwrap();
    let id = current["resourceId"].as_str().unwrap().to_owned();
    let mut incoming = conflict(&f, &current, "Incoming session", user.as_str().unwrap());
    incoming["revision"] = json!(5);
    incoming["deviceId"] = json!("laptop");
    incoming["candidate"]["updatedAt"] = json!("2026-11-13T10:03:00Z");
    incoming["candidate"]["updatedBy"] = user.clone();
    incoming["candidate"]["logicalPath"] = current["logicalPath"].clone();
    let cid = incoming["id"].as_str().unwrap();
    db::upsert(&f.db, "conflicts", cid, project, &incoming).unwrap();
    let queue = |revision, choice: &str, single| {
        crate::commands::resolve_session_recovery(
            project.into(),
            id.clone(),
            revision,
            cid.into(),
            choice.into(),
            single,
        )
    };
    assert!(queue(4, "restore", true).is_err());
    let other = conflict(
        &f,
        &current,
        "Second incoming version",
        user.as_str().unwrap(),
    );
    assert!(queue(5, "restore", true).is_err());
    f.db.execute("DELETE FROM conflicts WHERE id=?", [other["id"].as_str()])
        .unwrap();
    db::set(&f.db, "user", &json!("other-owner")).unwrap();
    assert!(queue(5, "keep", true).is_err());
    db::set(&f.db, "user", &user).unwrap();
    current["access"] = json!({"mode":"read"});
    save(&f, &current);
    assert!(queue(5, "restore", true).is_err());
    current["access"] = json!({"mode":"publish","create":"read"});
    save(&f, &current);
    assert!(queue(5, "copy", false).is_err());
    assert!(f.outbox().is_empty());
    db::upsert(&f.db, "bindings", &id, project, &json!({"needsCopy":true})).unwrap();
    assert!(queue(5, "restore", true).is_err());
    f.db.execute("DELETE FROM bindings WHERE id=?", [&id])
        .unwrap();
    f.db.execute(
        "INSERT INTO errors VALUES(?,?)",
        rusqlite::params![
            id,
            "Session conflict: choose Keep, Override, or Create copy"
        ],
    )
    .unwrap();
    queue(5, "restore", true).unwrap();
    assert!(queue(5, "keep", true).is_err());
    let out = f.outbox();
    assert_eq!(out.len(), 1);
    assert_eq!(out[0]["expectedRevision"], 5);
    assert_eq!(out[0]["selected"], "candidate");
    assert_eq!(out[0]["action"], "override");
    assert_eq!(out[0]["conflictId"], cid);
    assert_eq!(
        crate::commands::snapshot().unwrap()["outbox"][0]["sessionResolution"],
        json!({"revision":5, "conflictId":cid})
    );
    assert_eq!(f.resources()[0]["deleted"], true);
    let frozen = db::get(
        &f.db,
        &format!("sessionCopy:{}", out[0]["id"].as_str().unwrap()),
    )
    .unwrap();
    assert_eq!(frozen["source"]["files"], incoming["candidate"]["files"]);
}

#[test]
fn recovery_rereview_retires_only_a_definitively_rejected_older_choice() {
    let f = Fixture::new();
    let user = db::get(&f.db, "user").unwrap();
    let mut current = session(&f, "Deleted", 5);
    current["deleted"] = json!(true);
    current["files"] = json!([]);
    save(&f, &current);
    let project = f.project["id"].as_str().unwrap();
    let id = current["resourceId"].as_str().unwrap();
    let candidate = conflict(&f, &current, "Incoming", user.as_str().unwrap());
    let cid = candidate["id"].as_str().unwrap();
    let request = json!({"id":"rejected","projectId":project,"resourceId":id,"expectedRevision":4,"conflictId":cid});
    indexer::queue(&f.db, project, "/v2/sessions/resolve", &request).unwrap();
    db::set(
        &f.db,
        "sessionCopy:rejected",
        &json!({"source":"preserve until certain"}),
    )
    .unwrap();
    let choose = || {
        crate::commands::resolve_session_recovery(
            project.into(),
            id.into(),
            5,
            cid.into(),
            "keep".into(),
            false,
        )
    };
    for error in [None, Some("503: unavailable"), Some("409: unknown failure")] {
        f.db.execute("UPDATE outbox SET error=? WHERE id='rejected'", [error])
            .unwrap();
        assert!(choose().is_err());
        assert_eq!(f.outbox(), vec![request.clone()]);
        assert!(!db::get(&f.db, "sessionCopy:rejected").unwrap().is_null());
    }
    f.db.execute("UPDATE outbox SET error='409: Conflict changed; refresh before resolving' WHERE id='rejected'", []).unwrap();
    choose().unwrap();
    assert_eq!(f.outbox().len(), 1);
    assert_eq!(f.outbox()[0]["expectedRevision"], 5);
    assert_eq!(f.outbox()[0]["selected"], "current");
    assert!(db::get(&f.db, "sessionCopy:rejected").unwrap().is_null());
}
