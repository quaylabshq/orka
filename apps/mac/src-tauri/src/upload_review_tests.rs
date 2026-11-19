use super::*;
use crate::upload_review;

fn prepare() -> (Fixture, Value, Value, Value, PathBuf) {
    let mut f = Fixture::new();
    f.project["role"] = json!("owner");
    f.project["governed"] = json!(true);
    f.project["folderIdentity"] = json!(indexer::folder_identity(&f.root).unwrap());
    db::upsert(
        &f.db,
        "projects",
        f.project["id"].as_str().unwrap(),
        "",
        &f.project,
    )
    .unwrap();
    db::set(
        &f.db,
        "config",
        &json!({"apiUrl":"https://plan-review.example"}),
    )
    .unwrap();
    // The normal configure path opens the selected service before caching blobs.
    // Complete that initialization here too, before constructing file manifests.
    drop(db::open().unwrap());
    let resource_id = uuid::Uuid::new_v4().to_string();
    let upload_id = uuid::Uuid::new_v4().to_string();
    let file = |text: &[u8]| json!({"path":"content.md","hash":db::blob(text).unwrap(),"size":text.len(),"executable":false});
    let selected = json!({"resourceId":resource_id,"kind":"plan","source":"codex","logicalPath":"codex/files/release.md","title":"Release plan","files":[file(b"# Frozen queued plan\n")],"deleted":false});
    let request = json!({"version":2,"id":upload_id,"projectId":f.project["id"],"deviceId":uuid::Uuid::new_v4().to_string(),"baseRevision":2,"resource":selected});
    f.db.execute(
        "INSERT INTO outbox VALUES(?,?,?,?,?)",
        rusqlite::params![
            upload_id,
            f.project["id"].as_str(),
            "/v2/sync/push",
            request.to_string(),
            "409: Resource changed; refresh and review the exact version again"
        ],
    )
    .unwrap();
    let mut current = selected;
    current["projectId"] = f.project["id"].clone();
    current["revision"] = json!(3);
    current["files"] = json!([file(b"# Current shared plan\n")]);
    current["access"] = json!({"mode":"publish"});
    let input = json!({"accountId":db::get(&f.db,"user").unwrap(),"serviceOrigin":"https://plan-review.example","projectId":f.project["id"],"resourceId":resource_id,"uploadId":upload_id});
    let path = f.root.join(".codex/plans/release.md");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, "# Newer private local edits\n").unwrap();
    (f, input, current, request, path)
}

fn review_input(f: &Fixture, input: &Value, current: &Value) -> Value {
    let preview = upload_review::preview_with_current(&f.db, input, current).unwrap();
    let mut input = input.clone();
    input["previewToken"] = preview["previewToken"].clone();
    input
}

#[test]
fn upload_review_reads_frozen_queue_and_current_shared_version_without_touching_local_files() {
    let (f, input, current, request, path) = prepare();
    let preview = upload_review::preview_with_current(&f.db, &input, &current).unwrap();
    assert_eq!(preview["before"]["content.md"], "# Current shared plan\n");
    assert_eq!(preview["files"]["content.md"], "# Frozen queued plan\n");
    assert_eq!(preview["revision"], 3);
    assert_eq!(
        preview["afterManifest"][0]["hash"],
        request["resource"]["files"][0]["hash"]
    );
    assert_eq!(f.outbox(), vec![request]);
    assert_eq!(
        fs::read_to_string(path).unwrap(),
        "# Newer private local edits\n"
    );
}

#[test]
fn upload_review_retry_changes_only_request_identity_and_reviewed_base_and_replays_once() {
    let (f, input, current, original, path) = prepare();
    let input = review_input(&f, &input, &current);
    let result = upload_review::retry_with_current(&f.db, &input, &current).unwrap();
    assert_eq!(result["status"], "queued");
    assert_ne!(result["requestId"], original["id"]);
    let mut expected = original.clone();
    expected["id"] = result["requestId"].clone();
    expected["baseRevision"] = json!(3);
    assert_eq!(f.outbox(), vec![expected]);
    assert_eq!(
        f.db.query_row("SELECT count(*) FROM sync_queue", [], |row| row
            .get::<_, i64>(0))
            .unwrap(),
        1
    );
    assert_eq!(
        upload_review::retry_with_current(&f.db, &input, &json!({})).unwrap(),
        result
    );
    assert_eq!(f.outbox().len(), 1);
    assert_eq!(
        fs::read_to_string(path).unwrap(),
        "# Newer private local edits\n"
    );
    let retained = db::get(
        &f.db,
        &format!("upload-preview:{}", input["previewToken"].as_str().unwrap()),
    )
    .unwrap();
    assert_eq!(retained["queue"]["value"], original);
    assert!(db::blob_read(original["resource"]["files"][0]["hash"].as_str().unwrap()).is_ok());
}

#[test]
fn upload_review_rejects_remote_changes_and_invalidates_the_preview_without_losing_queue() {
    let (f, input, current, original, path) = prepare();
    let input = review_input(&f, &input, &current);
    let mut changed = current.clone();
    changed["revision"] = json!(4);
    assert!(upload_review::retry_with_current(&f.db, &input, &changed).is_err());
    assert!(upload_review::retry_with_current(&f.db, &input, &current).is_err());
    assert_eq!(f.outbox(), vec![original]);
    assert_eq!(
        fs::read_to_string(path).unwrap(),
        "# Newer private local edits\n"
    );
}

#[test]
fn upload_review_rejects_changed_queued_bytes_and_new_source_bindings() {
    let (f, input, current, mut request, _) = prepare();
    let reviewed = review_input(&f, &input, &current);
    request["resource"]["title"] = json!("A later queued snapshot");
    f.db.execute(
        "UPDATE outbox SET value=? WHERE id=?",
        rusqlite::params![request.to_string(), input["uploadId"].as_str()],
    )
    .unwrap();
    assert!(upload_review::retry_with_current(&f.db, &reviewed, &current).is_err());
    assert_eq!(f.outbox(), vec![request]);
    let reviewed = review_input(&f, &input, &current);
    let mut project = f.project.clone();
    project["repositoryRevision"] = json!(2);
    db::upsert(
        &f.db,
        "projects",
        project["id"].as_str().unwrap(),
        "",
        &project,
    )
    .unwrap();
    assert!(upload_review::retry_with_current(&f.db, &reviewed, &current).is_err());
    assert_eq!(f.outbox().len(), 1);
}

#[test]
fn upload_review_scopes_previews_to_account_service_project_resource_and_upload() {
    let (f, input, current, original, _) = prepare();
    let reviewed = review_input(&f, &input, &current);
    for (key, value) in [
        ("accountId", json!(uuid::Uuid::new_v4().to_string())),
        ("serviceOrigin", json!("https://other.example")),
        ("projectId", json!(uuid::Uuid::new_v4().to_string())),
        ("resourceId", json!(uuid::Uuid::new_v4().to_string())),
        ("uploadId", json!(uuid::Uuid::new_v4().to_string())),
    ] {
        let mut other = reviewed.clone();
        other[key] = value;
        assert!(
            upload_review::retry_with_current(&f.db, &other, &current).is_err(),
            "{key}"
        );
    }
    assert_eq!(f.outbox(), vec![original]);
    assert!(upload_review::retry_with_current(&f.db, &reviewed, &current).is_ok());
}

#[test]
fn upload_review_expiry_lost_access_deleted_resource_and_corrupt_blob_preserve_queue() {
    let (f, input, current, original, _) = prepare();
    for (key, value) in [
        ("access", json!({"mode":"read"})),
        ("deleted", json!(true)),
        ("source", json!("claude")),
        ("kind", json!("session")),
    ] {
        let mut changed = current.clone();
        changed[key] = value;
        assert!(upload_review::preview_with_current(&f.db, &input, &changed).is_err());
    }
    let reviewed = review_input(&f, &input, &current);
    let key = format!(
        "upload-preview:{}",
        reviewed["previewToken"].as_str().unwrap()
    );
    let mut preview = db::get(&f.db, &key).unwrap();
    preview["expires"] = json!(0);
    db::set(&f.db, &key, &preview).unwrap();
    assert!(upload_review::retry_with_current(&f.db, &reviewed, &current).is_err());
    let reviewed = review_input(&f, &input, &current);
    fs::write(
        db::blob_path(original["resource"]["files"][0]["hash"].as_str().unwrap()).unwrap(),
        "corrupted",
    )
    .unwrap();
    assert!(upload_review::retry_with_current(&f.db, &reviewed, &current).is_err());
    assert_eq!(f.outbox(), vec![original]);
}

#[test]
fn upload_review_only_marks_rejected_push_plans_and_snapshot_keeps_wire_body_private() {
    let (f, _, current, original, _) = prepare();
    assert!(upload_review::reviewable(
        "/v2/sync/push",
        Some("409: stale"),
        &original["resource"]
    ));
    for path in [
        "/local/selected-share",
        "/v2/sessions/resolve",
        "/local/context-share",
    ] {
        assert!(!upload_review::reviewable(
            path,
            Some("409: stale"),
            &original["resource"]
        ));
    }
    for error in [None, Some("503: offline"), Some("403: denied")] {
        assert!(!upload_review::reviewable(
            "/v2/sync/push",
            error,
            &original["resource"]
        ));
    }
    for kind in ["memory", "skill", "session"] {
        let mut resource = current.clone();
        resource["kind"] = json!(kind);
        assert!(!upload_review::reviewable(
            "/v2/sync/push",
            Some("409: stale"),
            &resource
        ));
    }
    let snapshot = crate::commands::snapshot().unwrap();
    assert_eq!(snapshot["outbox"][0]["reviewable"], true);
    for field in ["value", "raw", "path", "reviewPath", "reviewResource"] {
        assert!(snapshot["outbox"][0].get(field).is_none(), "{field}");
    }
    f.db.execute("UPDATE outbox SET error=NULL", []).unwrap();
    assert_eq!(
        crate::commands::snapshot().unwrap()["outbox"][0]["reviewable"],
        false
    );
    let mut deletion = original.clone();
    deletion["resource"]["deleted"] = json!(true);
    f.db.execute(
        "UPDATE outbox SET value=?,error='409: stale'",
        [deletion.to_string()],
    )
    .unwrap();
    assert_eq!(
        crate::commands::snapshot().unwrap()["outbox"][0]["reviewable"],
        false
    );
}

#[test]
fn upload_review_detects_replaced_legacy_folders_without_a_stored_identity() {
    let (f, input, current, original, _) = prepare();
    let mut legacy = f.project.clone();
    legacy.as_object_mut().unwrap().remove("folderIdentity");
    db::upsert(
        &f.db,
        "projects",
        legacy["id"].as_str().unwrap(),
        "",
        &legacy,
    )
    .unwrap();
    let reviewed = review_input(&f, &input, &current);
    let preserved = f._home.path().join("original-project");
    fs::rename(&f.root, &preserved).unwrap();
    fs::create_dir(&f.root).unwrap();
    assert!(upload_review::retry_with_current(&f.db, &reviewed, &current).is_err());
    assert_eq!(f.outbox(), vec![original]);
    assert_eq!(
        fs::read_to_string(preserved.join(".codex/plans/release.md")).unwrap(),
        "# Newer private local edits\n"
    );
}
