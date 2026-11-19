use super::*;

fn blob(zip: &mut zip::ZipArchive<fs::File>, path: &str) -> Vec<u8> {
    let mut bytes = Vec::new();
    zip.by_name(path).unwrap().read_to_end(&mut bytes).unwrap();
    bytes
}

fn header(zip: &mut zip::ZipArchive<fs::File>) -> Value {
    serde_json::from_slice(&blob(zip, "project.json")).unwrap()
}

#[test]
fn project_export_preserves_held_edits_before_local_removal() {
    for deleted in [false, true] {
        let f = Fixture::new();
        let id = f.project["id"].as_str().unwrap();
        let original = f.root.join("CLAUDE.md");
        fs::write(&original, "Accepted instructions\n").unwrap();
        indexer::scan(&f.db, &f.project).unwrap();
        let accepted = f.accept(&f.resources()[0]);
        fs::write(&original, "Unsent instructions\n").unwrap();
        indexer::scan(&f.db, &f.project).unwrap();
        let before = f.outbox();
        assert_eq!(before.len(), 1);
        let request = &before[0];
        let hash = request["resource"]["files"][0]["hash"].as_str().unwrap();
        assert_ne!(request["resource"]["files"], accepted["files"]);
        fs::remove_file(&original).unwrap();
        let mut remote = f.project.clone();
        remote["archivedAt"] = json!("2026-11-19T00:00:00Z");
        if deleted {
            remote["deletedAt"] = json!("2026-11-19T00:00:00Z");
            remote["purgeAfter"] = json!("2026-12-19T00:00:00Z");
        }
        crate::projects::merge_catalog(&f.db, &json!([remote])).unwrap();
        let path = f.root.join("project.zip");
        let workspace = crate::projects::lock().unwrap();
        let writer = db::open().unwrap();
        writer.execute_batch("BEGIN IMMEDIATE").unwrap();
        db::upsert(
            &writer,
            "projects",
            "another-project",
            "",
            &json!({"id":"another-project","name":"Another project"}),
        )
        .unwrap();
        tauri::async_runtime::block_on(crate::commands::export_project(
            id.into(),
            path.to_string_lossy().into_owned(),
        ))
        .unwrap();
        writer.execute_batch("ROLLBACK").unwrap();
        drop(workspace);
        let mut zip = zip::ZipArchive::new(fs::File::open(&path).unwrap()).unwrap();
        assert_eq!(header(&mut zip)["pendingChanges"], 1);
        let prefix = format!("pending/{}/", request["id"].as_str().unwrap());
        assert_eq!(
            blob(&mut zip, &format!("{prefix}blobs/{hash}")),
            b"Unsent instructions\n"
        );
        let exported: Value =
            serde_json::from_slice(&blob(&mut zip, &format!("{prefix}request.json"))).unwrap();
        assert_eq!(exported["value"], *request);
        assert_eq!(f.outbox(), before);
        assert!(!original.exists());
        crate::projects::remove_local(&f.db, id).unwrap();
        assert!(f.outbox().is_empty());
        assert_eq!(
            blob(&mut zip, &format!("{prefix}blobs/{hash}")),
            b"Unsent instructions\n"
        );
    }
}

#[test]
fn project_export_waits_for_access_cleanup_before_reading_stale_shared_cache() {
    let f = Fixture::new();
    let project = f.project["id"].as_str().unwrap();
    session_conflict(&f, "Cached teammate conversation", "teammate");
    let mut saved = f.project.clone();
    saved["revoked"] = json!(true);
    db::upsert(&f.db, "projects", project, project, &saved).unwrap();
    let path = f.root.join("project.zip");
    fs::write(&path, b"previous export").unwrap();
    let error =
        bundles::export_project(&db::CacheScope::current().unwrap(), project, &path).unwrap_err();
    assert!(error.contains("updating access"));
    assert_eq!(fs::read(path).unwrap(), b"previous export");
}

#[test]
fn project_export_keeps_its_blob_scope_and_discards_output_after_service_switch() {
    let f = Fixture::new();
    let project = f.project["id"].as_str().unwrap();
    db::set(&f.db, "config", &json!({"apiUrl":"https://first.example"})).unwrap();
    db::profile(&uuid::Uuid::new_v4().to_string()).unwrap();
    let db = db::open().unwrap();
    let mut saved = f.project.clone();
    saved["archivedAt"] = json!("2026-11-19T00:00:00Z");
    db::upsert(&db, "projects", project, project, &saved).unwrap();
    let bytes = b"Only cached on the first service";
    let hash = db::blob(bytes).unwrap();
    let resource = json!({"resourceId":"memory","kind":"memory","files":[{"hash":hash}]});
    db::upsert(&db, "resources", "memory", project, &resource).unwrap();
    let cache = db::CacheScope::current().unwrap();
    let read_blob = cache.blob_reader();
    db::set(&db, "config", &json!({"apiUrl":"https://second.example"})).unwrap();
    assert!(
        db::rows(&db::open().unwrap(), "SELECT value FROM projects", &[])
            .unwrap()
            .is_empty()
    );
    assert!(db::blob_read(&hash).is_err());
    assert_eq!(read_blob(&hash).unwrap(), bytes);
    let path = f.root.join("project.zip");
    fs::write(&path, b"previous export").unwrap();
    let error = bundles::export_project(&cache, project, &path).unwrap_err();
    assert!(error.contains("account or service changed"), "{error}");
    assert_eq!(fs::read(path).unwrap(), b"previous export");
}

#[test]
fn project_export_reads_private_cache_without_discovery_or_writes() {
    let mut f = Fixture::new();
    f.project["sharing"] =
        json!({"memory":false,"skill":false,"session":false,"plan":false,"env":false});
    let id = f.project["id"].as_str().unwrap().to_owned();
    db::upsert(&f.db, "projects", &id, &id, &f.project).unwrap();
    let original = f.root.join("CLAUDE.md");
    fs::write(&original, "Private cached instructions\n").unwrap();
    let catalog = crate::local_resources::catalog(&f.db, &f.project, "memory").unwrap();
    let resource = &catalog["resources"][0];
    assert_eq!(catalog["resources"].as_array().unwrap().len(), 1);
    assert!(f.resources().is_empty());
    assert!(f.outbox().is_empty());
    fs::remove_file(&original).unwrap();
    f.project["archivedAt"] = json!("2026-11-19T00:00:00Z");
    db::upsert(&f.db, "projects", &id, &id, &f.project).unwrap();
    let before = db::rows(&f.db, "SELECT value FROM local_resources", &[]).unwrap();
    let path = f.root.join("project.zip");
    bundles::export_project(&db::CacheScope::current().unwrap(), &id, &path).unwrap();
    assert_eq!(
        db::rows(&f.db, "SELECT value FROM local_resources", &[]).unwrap(),
        before
    );
    assert!(!original.exists());
    assert!(f.outbox().is_empty());
    let mut zip = zip::ZipArchive::new(fs::File::open(path).unwrap()).unwrap();
    assert_eq!(header(&mut zip)["localResources"], 1);
    let prefix = format!(
        "local-resources/{}/",
        resource["resourceId"].as_str().unwrap()
    );
    let hash = resource["files"][0]["hash"].as_str().unwrap();
    assert_eq!(
        blob(&mut zip, &format!("{prefix}blobs/{hash}")),
        b"Private cached instructions\n"
    );
    assert!(
        zip.by_name("manifest.json").is_err(),
        "A project export is not an importable Orka bundle"
    );
}

#[test]
fn project_export_does_not_resurrect_revoked_teammate_cache() {
    let f = Fixture::new();
    let id = f.project["id"].as_str().unwrap();
    let teammate = json!({"resourceId":"former-teammate","kind":"memory","source":"shared","logicalPath":"knowledge/former.md","title":"Former teammate memory","files":[{"path":"content.md","hash":db::blob(b"No longer authorized").unwrap(),"size":20,"executable":false}],"deleted":false});
    db::upsert(&f.db,"local_resources","former-teammate",id,&json!({"resource":teammate,"owner":"former-owner","path":f.project["path"],"folderIdentity":f.project["folderIdentity"]})).unwrap();
    let mut saved = f.project.clone();
    saved["revoked"] = json!(true);
    saved["detachedAt"] = json!("2026-11-19T00:00:00Z");
    db::upsert(&f.db, "projects", id, id, &saved).unwrap();
    let path = f.root.join("project.zip");
    bundles::export_project(&db::CacheScope::current().unwrap(), id, &path).unwrap();
    let mut zip = zip::ZipArchive::new(fs::File::open(path).unwrap()).unwrap();
    assert_eq!(header(&mut zip)["localResources"], 0);
    assert_eq!(zip.len(), 1);
}

#[test]
fn project_export_keeps_the_selected_legacy_session_copy_snapshot() {
    let f = Fixture::new();
    let id = f.project["id"].as_str().unwrap();
    let records = vec![
        json!({"type":"user","uuid":"entry","sessionId":"conversation","cwd":f.root,"message":{"role":"user","content":"Selected cached conversation"}}),
    ];
    let bytes = native::encode(&records);
    let hash = db::blob(&bytes).unwrap();
    let resource = json!({"resourceId":"conversation","projectId":id,"kind":"session","source":"claude","logicalPath":"claude/conversation","title":"Cached conversation","files":[{"path":"session.jsonl","hash":hash,"size":bytes.len(),"executable":false}],"deleted":false,"revision":7});
    let request = sync::queue_session_snapshot(&f.db, &resource, "device").unwrap();
    let legacy = sync::prepare_session_copy(&f.db, &request, false).unwrap();
    assert!(legacy["sourceSnapshot"].is_null());
    let mut latest = resource.clone();
    latest["revision"] = json!(8);
    latest["files"] = json!([]);
    db::upsert(&f.db, "resources", "conversation", id, &latest).unwrap();
    let before = f.outbox();
    let state_key = format!("sessionCopy:{}", request["id"].as_str().unwrap());
    let copy_before = db::get(&f.db, &state_key).unwrap();
    let mut saved = f.project.clone();
    saved["archivedAt"] = json!("2026-11-19T00:00:00Z");
    db::upsert(&f.db, "projects", id, id, &saved).unwrap();
    let path = f.root.join("project.zip");
    bundles::export_project(&db::CacheScope::current().unwrap(), id, &path).unwrap();
    let mut zip = zip::ZipArchive::new(fs::File::open(path).unwrap()).unwrap();
    let prefix = format!("pending/{}/", request["id"].as_str().unwrap());
    assert_eq!(blob(&mut zip, &format!("{prefix}blobs/{hash}")), bytes);
    let exported: Value =
        serde_json::from_slice(&blob(&mut zip, &format!("{prefix}resource.json"))).unwrap();
    assert_eq!(exported["revision"], 7);
    assert_eq!(f.outbox(), before);
    assert_eq!(db::get(&f.db, &state_key).unwrap(), copy_before);
}

fn session_conflict(f: &Fixture, label: &str, author: &str) -> Value {
    let resource = session_snapshot(f, "Current cached version", 7);
    let mut candidate = session_snapshot(f, label, 5);
    candidate["resourceId"] = resource["resourceId"].clone();
    db::upsert(
        &f.db,
        "resources",
        resource["resourceId"].as_str().unwrap(),
        f.project["id"].as_str().unwrap(),
        &resource,
    )
    .unwrap();
    let conflict = json!({"id":uuid::Uuid::new_v4().to_string(),"resourceId":resource["resourceId"],"author":author,"candidate":candidate});
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

fn session_snapshot(f: &Fixture, text: &str, revision: i64) -> Value {
    let id = uuid::Uuid::new_v4().to_string();
    let bytes = native::encode(&[
        json!({"type":"user","uuid":uuid::Uuid::new_v4().to_string(),"message":{"role":"user","content":text}}),
    ]);
    json!({"resourceId":id,"projectId":f.project["id"],"kind":"session","source":"claude","logicalPath":format!("claude/{id}"),"title":text,"files":[{"path":"session.jsonl","hash":db::blob(&bytes).unwrap(),"size":bytes.len(),"executable":false}],"deleted":false,"revision":revision,"owner":db::get(&f.db,"user").unwrap()})
}

#[test]
fn project_export_preserves_cached_conflict_versions_while_inactive() {
    for deleted in [false, true] {
        let f = Fixture::new();
        let project = f.project["id"].as_str().unwrap();
        let conflict = session_conflict(
            &f,
            "Cached rejected conversation",
            &uuid::Uuid::new_v4().to_string(),
        );
        let mut saved = f.project.clone();
        saved["archivedAt"] = json!("2026-11-19T00:00:00Z");
        if deleted {
            saved["deletedAt"] = json!("2026-11-19T00:00:00Z");
        }
        db::upsert(&f.db, "projects", project, project, &saved).unwrap();
        assert!(
            f.outbox().is_empty(),
            "The rejected upload is already acknowledged"
        );
        let path = f.root.join("project.zip");
        bundles::export_project(&db::CacheScope::current().unwrap(), project, &path).unwrap();
        let mut zip = zip::ZipArchive::new(fs::File::open(path).unwrap()).unwrap();
        assert_eq!(header(&mut zip)["conflicts"], 1);
        let prefix = format!("conflicts/{}/", conflict["id"].as_str().unwrap());
        let exported: Value =
            serde_json::from_slice(&blob(&mut zip, &format!("{prefix}conflict.json"))).unwrap();
        assert_eq!(exported, conflict);
        let hash = conflict["candidate"]["files"][0]["hash"].as_str().unwrap();
        assert_eq!(
            blob(&mut zip, &format!("{prefix}blobs/{hash}")),
            db::blob_read(hash).unwrap()
        );
        assert_eq!(
            db::rows(&f.db, "SELECT value FROM conflicts", &[]).unwrap(),
            vec![conflict]
        );
    }
}

#[test]
fn project_export_after_detach_contains_only_preserved_private_conflicts() {
    let f = Fixture::new();
    let project = f.project["id"].as_str().unwrap();
    let user = db::get(&f.db, "user").unwrap();
    let own = session_conflict(&f, "My rejected conversation", user.as_str().unwrap());
    let foreign = session_conflict(
        &f,
        "Teammate rejected conversation",
        &uuid::Uuid::new_v4().to_string(),
    );
    crate::projects::merge_catalog(&f.db, &json!([])).unwrap();
    let path = f.root.join("project.zip");
    bundles::export_project(&db::CacheScope::current().unwrap(), project, &path).unwrap();
    let mut zip = zip::ZipArchive::new(fs::File::open(path).unwrap()).unwrap();
    assert_eq!(header(&mut zip)["conflicts"], 0);
    assert_eq!(header(&mut zip)["drafts"], 1);
    let own_hash = own["candidate"]["files"][0]["hash"].as_str().unwrap();
    let foreign_hash = foreign["candidate"]["files"][0]["hash"].as_str().unwrap();
    let names = (0..zip.len())
        .map(|i| zip.by_index(i).unwrap().name().unwrap().to_string())
        .collect::<Vec<_>>();
    assert!(names
        .iter()
        .any(|name| name.starts_with("drafts/") && name.ends_with(own_hash)));
    assert!(!names
        .iter()
        .any(|name| name.starts_with("conflicts/") || name.ends_with(foreign_hash)));
}

#[test]
fn project_export_keeps_a_frozen_resolution_after_newer_remote_state() {
    for selected in ["current", "candidate"] {
        let f = Fixture::new();
        let project = f.project["id"].as_str().unwrap();
        let conflict = session_conflict(
            &f,
            "Selected rejected version",
            &uuid::Uuid::new_v4().to_string(),
        );
        let current = f.resources()[0].clone();
        crate::commands::session_action(
            current["resourceId"].as_str().unwrap().into(),
            "override".into(),
            Some(conflict["id"].as_str().unwrap().into()),
            Some(selected.into()),
        )
        .unwrap();
        let request = f.outbox()[0].clone();
        let source = if selected == "current" {
            &current
        } else {
            &conflict["candidate"]
        };
        let mut latest = session_snapshot(&f, "Newer accepted conversation", 8);
        latest["resourceId"] = current["resourceId"].clone();
        db::upsert(
            &f.db,
            "resources",
            latest["resourceId"].as_str().unwrap(),
            project,
            &latest,
        )
        .unwrap();
        f.db.execute("DELETE FROM conflicts", []).unwrap();
        let mut saved = f.project.clone();
        saved["archivedAt"] = json!("2026-11-19T00:00:00Z");
        db::upsert(&f.db, "projects", project, project, &saved).unwrap();
        let path = f.root.join("project.zip");
        bundles::export_project(&db::CacheScope::current().unwrap(), project, &path).unwrap();
        let mut zip = zip::ZipArchive::new(fs::File::open(path).unwrap()).unwrap();
        let prefix = format!("pending/{}/", request["id"].as_str().unwrap());
        let exported: Value =
            serde_json::from_slice(&blob(&mut zip, &format!("{prefix}resource.json"))).unwrap();
        assert_eq!(exported["files"], source["files"]);
        let hash = source["files"][0]["hash"].as_str().unwrap();
        assert_eq!(
            blob(&mut zip, &format!("{prefix}blobs/{hash}")),
            db::blob_read(hash).unwrap()
        );
        assert_eq!(f.outbox(), vec![request]);
    }
}
