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
        bundles::export_project(&f.db, id, &path).unwrap();
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
    let before: i64 =
        f.db.query_row("SELECT total_changes()", [], |r| r.get(0))
            .unwrap();
    let path = f.root.join("project.zip");
    bundles::export_project(&f.db, &id, &path).unwrap();
    let after: i64 =
        f.db.query_row("SELECT total_changes()", [], |r| r.get(0))
            .unwrap();
    assert_eq!(after, before);
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
    bundles::export_project(&f.db, id, &path).unwrap();
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
    bundles::export_project(&f.db, id, &path).unwrap();
    let mut zip = zip::ZipArchive::new(fs::File::open(path).unwrap()).unwrap();
    let prefix = format!("pending/{}/", request["id"].as_str().unwrap());
    assert_eq!(blob(&mut zip, &format!("{prefix}blobs/{hash}")), bytes);
    let exported: Value =
        serde_json::from_slice(&blob(&mut zip, &format!("{prefix}resource.json"))).unwrap();
    assert_eq!(exported["revision"], 7);
    assert_eq!(f.outbox(), before);
    assert_eq!(db::get(&f.db, &state_key).unwrap(), copy_before);
}
