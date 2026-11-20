use super::*;
use crate::sources;
use uuid::Uuid;

fn multi_source(f: &Fixture) -> Value {
    let backend = f.root.parent().unwrap().join("backend");
    fs::create_dir(&backend).unwrap();
    let mut project = f.project.clone();
    project.as_object_mut().unwrap().remove("path");
    project["sources"] = json!([
        {"id":uuid::Uuid::new_v4().to_string(),"name":"desktop","path":f.root,"folderIdentity":indexer::folder_identity(&f.root).unwrap()},
        {"id":uuid::Uuid::new_v4().to_string(),"name":"backend","path":backend,"folderIdentity":indexer::folder_identity(&backend).unwrap()}
    ]);
    project
}

#[test]
fn folder_identity_preserves_directory_moves_and_rejects_replacements() {
    let home = tempfile::tempdir().unwrap();
    let root = home.path().join("项目 checkout");
    fs::create_dir(&root).unwrap();
    let identity = indexer::folder_identity(&root).unwrap();
    #[cfg(target_os = "macos")]
    assert!(identity.starts_with("volume:"));
    let moved = home.path().join("moved");
    fs::rename(&root, &moved).unwrap();
    assert!(indexer::folder_identity_matches(&moved, &identity).unwrap());
    let linked = home.path().join("linked");
    std::os::unix::fs::symlink(&moved, &linked).unwrap();
    assert!(indexer::folder_identity_matches(&linked, &identity).unwrap());
    fs::create_dir(&root).unwrap();
    assert!(!indexer::folder_identity_matches(&root, &identity).unwrap());
    assert!(sources::validate(&json!({"path":root,"folderIdentity":identity})).is_err());
    fs::remove_dir(&root).unwrap();
    assert!(sources::validate(&json!({"path":root,"folderIdentity":identity})).is_err());
}

#[test]
fn catalog_upgrades_verified_legacy_identities_without_trusting_changed_devices() {
    use std::os::unix::fs::MetadataExt;
    let f = Fixture::new();
    let mut project = multi_source(&f);
    for (index, source) in project["sources"]
        .as_array_mut()
        .unwrap()
        .iter_mut()
        .enumerate()
    {
        let meta = fs::metadata(source["path"].as_str().unwrap()).unwrap();
        source["folderIdentity"] = json!(format!("{}:{}", meta.dev() + index as u64, meta.ino()));
    }
    let views = sources::views(&project);
    sources::validate(&views[0]).unwrap();
    assert!(sources::validate(&views[1]).is_err());
    let id = project["id"].as_str().unwrap();
    db::upsert(&f.db, "projects", id, id, &project).unwrap();
    let mut remote = project.clone();
    for source in remote["sources"].as_array_mut().unwrap() {
        source.as_object_mut().unwrap().remove("path");
        source.as_object_mut().unwrap().remove("folderIdentity");
    }
    crate::projects::merge_catalog(&f.db, &json!([remote])).unwrap();
    let saved = db::rows(&f.db, "SELECT value FROM projects WHERE id=?", &[&id])
        .unwrap()
        .remove(0);
    assert_eq!(
        saved["sources"][0]["folderIdentity"],
        indexer::folder_identity(&f.root).unwrap()
    );
    assert_eq!(saved["sources"][1], project["sources"][1]);
    let views = sources::views(&saved);
    sources::validate(&views[0]).unwrap();
    assert!(sources::validate(&views[1]).is_err());
}

#[test]
fn global_skill_publication_adopts_the_selected_repository_in_a_multi_source_project() {
    let f = Fixture::new();
    let mut project = multi_source(&f);
    project["governed"] = json!(true);
    let project_id = project["id"].as_str().unwrap();
    db::upsert(&f.db, "projects", project_id, "", &project).unwrap();
    let global = f._home.path().join(".codex/skills/example");
    fs::create_dir_all(&global).unwrap();
    fs::write(
        global.join("SKILL.md"),
        "---\nname: example\ndescription: Example\n---\n# Example\n",
    )
    .unwrap();
    for source in sources::views(&project) {
        let scan = crate::global_skills::scan(&f.db, &source).unwrap();
        let id = &scan.skills[0].id;
        crate::global_skills::add(&f.db, &source, id).unwrap();
        let value = f
            .outbox()
            .into_iter()
            .find(|item| item["resource"]["sourceId"] == source["sourceId"])
            .unwrap();
        let queued = json!({"project":project_id,"id":value["id"],"value":value});
        let mut resource = queued["value"]["resource"].clone();
        resource["projectId"] = json!(project_id);
        resource["updatedBy"] = db::get(&f.db, "user").unwrap();
        resource["revision"] = json!(1);
        crate::global_skills::complete_share(
            &f.db,
            &queued,
            &json!({"event":{"resource":resource,"conflicts":[]}}),
        )
        .unwrap();
        let binding = indexer::binding(&f.db, resource["resourceId"].as_str().unwrap()).unwrap();
        assert_eq!(binding["installationState"], "current");
        assert_eq!(binding["reviewedRevision"], 1);
        assert!(binding["paths"]
            .as_array()
            .unwrap()
            .iter()
            .all(|path| PathBuf::from(path.as_str().unwrap())
                .starts_with(source["path"].as_str().unwrap())));
        assert_eq!(binding["base"]["sourceId"], source["sourceId"]);
    }
}

#[test]
fn scans_and_materializes_identical_paths_in_independent_sources() {
    let f = Fixture::new();
    let project = multi_source(&f);
    let views = sources::views(&project);
    for source in &views {
        fs::write(
            PathBuf::from(source["path"].as_str().unwrap()).join("AGENTS.md"),
            source["sourceId"].as_str().unwrap(),
        )
        .unwrap();
    }
    indexer::scan(&f.db, &project).unwrap();
    let resources = f.resources();
    assert_eq!(resources.len(), 2);
    assert_ne!(resources[0]["resourceId"], resources[1]["resourceId"]);
    assert_ne!(resources[0]["sourceId"], resources[1]["sourceId"]);
    assert!(f
        .outbox()
        .iter()
        .all(|queued| queued["resource"]["sourceId"].is_string()));
    f.db.execute("DELETE FROM outbox", []).unwrap();
    for mut resource in resources {
        let source = sources::for_resource(&project, &resource).unwrap();
        let root = PathBuf::from(source["path"].as_str().unwrap());
        let text = format!("Remote {}\n", resource["sourceId"].as_str().unwrap());
        resource["files"] = json!([{"path":"content.md","hash":db::blob(text.as_bytes()).unwrap(),"size":text.len(),"executable":false}]);
        resource["revision"] = json!(1);
        f.db.execute(
            "DELETE FROM bindings WHERE id=?",
            [resource["resourceId"].as_str().unwrap()],
        )
        .unwrap();
        fs::remove_file(root.join("AGENTS.md")).unwrap();
        sync::materialize(&f.db, &project, &resource).unwrap();
        assert_eq!(fs::read_to_string(root.join("AGENTS.md")).unwrap(), text);
    }
}

#[test]
fn an_unavailable_source_does_not_block_another_or_receive_writes() {
    let f = Fixture::new();
    let mut project = multi_source(&f);
    fs::write(f.root.join("AGENTS.md"), "Desktop instructions\n").unwrap();
    project["sources"][1]["folderIdentity"] = json!("unavailable");
    indexer::scan(&f.db, &project).unwrap();
    assert_eq!(f.resources().len(), 1);
    assert_eq!(f.resources()[0]["sourceId"], project["sources"][0]["id"]);
    let mut wrong = f.resources()[0].clone();
    wrong["sourceId"] = project["sources"][1]["id"].clone();
    assert!(sync::materialize(&f.db, &project, &wrong).is_err());
    assert!(sources::select(&project, None).is_err());
}

#[test]
fn parent_scan_finds_git_directories_and_worktree_files_without_recursing_or_following_links() {
    let f = Fixture::new();
    let parent = f.root.parent().unwrap();
    fs::create_dir(f.root.join(".git")).unwrap();
    let backend = parent.join("backend");
    fs::create_dir(&backend).unwrap();
    fs::write(backend.join(".git"), "gitdir: ../worktree-data\n").unwrap();
    let nested = parent.join("unrelated/nested");
    fs::create_dir_all(nested.join(".git")).unwrap();
    std::os::unix::fs::symlink(&backend, parent.join("linked-backend")).unwrap();
    let found = sources::scan_project_folders(parent.to_string_lossy().into()).unwrap();
    assert_eq!(found.len(), 2);
    assert!(found
        .iter()
        .all(|item| item["name"] == "backend" || item["name"] == "project"));
}

#[test]
fn source_catalog_refresh_preserves_each_macs_bindings_by_id() {
    let f = Fixture::new();
    let project = multi_source(&f);
    let id = project["id"].as_str().unwrap();
    db::upsert(&f.db, "projects", id, id, &project).unwrap();
    let mut remote = project.clone();
    for source in remote["sources"].as_array_mut().unwrap() {
        source.as_object_mut().unwrap().remove("path");
        source.as_object_mut().unwrap().remove("folderIdentity");
    }
    crate::projects::merge_catalog(&f.db, &json!([remote])).unwrap();
    let saved = db::rows(&f.db, "SELECT value FROM projects WHERE id=?", &[&id])
        .unwrap()
        .remove(0);
    assert_eq!(saved["sources"], project["sources"]);
}

#[test]
fn removed_sources_disconnect_without_deleting_files_or_shared_history() {
    let f = Fixture::new();
    let project = multi_source(&f);
    let project_id = project["id"].as_str().unwrap();
    let source_id = project["sources"][0]["id"].as_str().unwrap();
    fs::write(f.root.join("AGENTS.md"), "Keep local instructions\n").unwrap();
    let resource = json!({"resourceId":uuid::Uuid::new_v4().to_string(),"sourceId":source_id,"projectId":project_id,"kind":"memory","source":"shared","logicalPath":"instructions/AGENTS.md","title":"Instructions","revision":1,"deleted":false,"files":[]});
    let resource_id = resource["resourceId"].as_str().unwrap();
    db::upsert(&f.db, "projects", project_id, project_id, &project).unwrap();
    db::upsert(&f.db, "resources", resource_id, project_id, &resource).unwrap();
    db::upsert(
        &f.db,
        "bindings",
        resource_id,
        project_id,
        &json!({"base":resource,"paths":[f.root.join("AGENTS.md")]}),
    )
    .unwrap();
    let mut remote = project.clone();
    remote["sources"][0]["removedAt"] = json!("2026-11-13T00:00:00Z");
    crate::projects::merge_catalog(&f.db, &json!([remote])).unwrap();
    let saved = db::rows(
        &f.db,
        "SELECT value FROM projects WHERE id=?",
        &[&project_id],
    )
    .unwrap()
    .remove(0);
    assert!(saved["sources"][0]["path"].is_null());
    assert!(saved["sources"][0]["folderIdentity"].is_null());
    assert_eq!(saved["sources"][0]["name"], "desktop");
    assert_eq!(saved["sources"][1]["path"], project["sources"][1]["path"]);
    assert_eq!(sources::views(&saved).len(), 1);
    assert!(sources::select(&saved, Some(source_id)).is_err());
    assert!(sources::validate(&saved["sources"][0]).is_err());
    assert!(db::rows(
        &f.db,
        "SELECT value FROM bindings WHERE id=?",
        &[&resource_id]
    )
    .unwrap()
    .is_empty());
    assert_eq!(f.resources(), vec![resource]);
    assert_eq!(
        fs::read_to_string(f.root.join("AGENTS.md")).unwrap(),
        "Keep local instructions\n"
    );
    indexer::scan(&f.db, &saved).unwrap();
    assert!(f.outbox().is_empty());
    crate::projects::merge_catalog(&f.db, &json!([project])).unwrap();
    let stale_refresh = db::rows(
        &f.db,
        "SELECT value FROM projects WHERE id=?",
        &[&project_id],
    )
    .unwrap()
    .remove(0);
    assert!(stale_refresh["sources"][0]["removedAt"].is_string());
    assert!(stale_refresh["sources"][0]["path"].is_null());
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let result = runtime.block_on(sources::connect_sources(
        project_id.into(),
        vec![f.root.to_string_lossy().into()],
        Some(source_id.into()),
        None,
        None,
    ));
    assert!(result.unwrap_err().contains("removed from the project"));
}

#[test]
fn source_removal_keeps_queued_changes_until_they_are_synced() {
    let f = Fixture::new();
    let mut project = multi_source(&f);
    project["role"] = json!("owner");
    let id = project["id"].as_str().unwrap();
    db::upsert(&f.db, "projects", id, id, &project).unwrap();
    fs::write(f.root.join("AGENTS.md"), "Queued local instructions\n").unwrap();
    indexer::scan(&f.db, &project).unwrap();
    let before = f.outbox();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let result = runtime.block_on(crate::projects::project_command(
        "remove-source".into(),
        json!({"projectId":id,"sourceId":project["sources"][0]["id"]}),
    ));
    assert!(result.unwrap_err().contains("Sync queued changes"));
    assert_eq!(f.outbox(), before);
    assert_eq!(
        fs::read_to_string(f.root.join("AGENTS.md")).unwrap(),
        "Queued local instructions\n"
    );
}

#[test]
fn remote_source_removal_preserves_unsent_snapshots_and_releases_only_its_queue() {
    let f = Fixture::new();
    let project = multi_source(&f);
    let id = project["id"].as_str().unwrap();
    let removed = project["sources"][0]["id"].as_str().unwrap();
    let other = project["sources"][1]["id"].as_str().unwrap();
    db::upsert(&f.db, "projects", id, id, &project).unwrap();
    let text = "Frozen unsent session snapshot\n";
    let hash = db::blob(text.as_bytes()).unwrap();
    let session = json!({"resourceId":Uuid::new_v4().to_string(),"sourceId":removed,"projectId":id,"kind":"session","source":"codex","logicalPath":"codex/frozen","title":"Unsent session","files":[{"path":"session.jsonl","hash":hash,"size":text.len(),"executable":false}],"revision":1,"deleted":false});
    let selected = json!({"resourceId":Uuid::new_v4().to_string(),"sourceId":removed,"projectId":id,"kind":"memory","source":"shared","logicalPath":"knowledge/frozen.md","title":"Selected memory","files":[{"path":"content.md","hash":hash,"size":text.len(),"executable":false}],"deleted":false});
    let path = f.root.join("unsent-session.jsonl");
    fs::write(&path, text).unwrap();
    db::upsert(
        &f.db,
        "resources",
        session["resourceId"].as_str().unwrap(),
        id,
        &session,
    )
    .unwrap();
    db::upsert(
        &f.db,
        "bindings",
        session["resourceId"].as_str().unwrap(),
        id,
        &json!({"base":session,"paths":[path]}),
    )
    .unwrap();
    let push = json!({"id":Uuid::new_v4().to_string(),"projectId":id,"resource":session});
    let share = json!({"id":Uuid::new_v4().to_string(),"projectId":id,"resource":selected});
    let copy = json!({"id":Uuid::new_v4().to_string(),"projectId":id,"resourceId":session["resourceId"],"expectedRevision":1});
    let active = json!({"id":Uuid::new_v4().to_string(),"projectId":id,"resource":{"resourceId":Uuid::new_v4().to_string(),"sourceId":other,"kind":"session","files":[]}});
    for (endpoint, value) in [
        ("/v2/sync/push", &push),
        (crate::selective_sharing::QUEUE_PATH, &share),
        ("/v2/sessions/copy", &copy),
        ("/v2/sync/push", &active),
    ] {
        f.db.execute(
            "INSERT INTO outbox VALUES(?,?,?,?,NULL)",
            rusqlite::params![value["id"].as_str(), id, endpoint, value.to_string()],
        )
        .unwrap();
    }
    for queued in [&push, &copy, &active] {
        db::set(
            &f.db,
            &format!("sessionOutboxRedaction:{}", queued["id"].as_str().unwrap()),
            &json!({"drop":true}),
        )
        .unwrap();
    }
    f.db.execute(
        "UPDATE outbox SET error='409: Source folder was removed' WHERE id=?",
        [push["id"].as_str().unwrap()],
    )
    .unwrap();
    db::set(
        &f.db,
        &format!("selected-share:{}", share["id"].as_str().unwrap()),
        &json!({"status":"queued","paths":[path]}),
    )
    .unwrap();
    let pending = json!({"header":{"manifest":{"projectId":id,"sourceId":removed}},"mutation":{"version":{"ciphertext":"retained-encrypted-ENV"}}});
    let active_pending = json!({"header":{"manifest":{"projectId":id,"sourceId":other}},"mutation":{"version":{"ciphertext":"other-encrypted-ENV"}}});
    db::set(&f.db, "env:test:pending:removed", &pending).unwrap();
    db::set(&f.db, "env:test:pending:other", &active_pending).unwrap();
    let mut remote = project.clone();
    remote["sources"][0]["removedAt"] = json!("2026-11-13T00:00:00Z");
    crate::projects::merge_catalog(&f.db, &json!([remote.clone()])).unwrap();
    assert_eq!(f.outbox(), vec![active.clone()]);
    for queued in [&push, &copy] {
        assert!(db::get(
            &f.db,
            &format!("sessionOutboxRedaction:{}", queued["id"].as_str().unwrap())
        )
        .unwrap()
        .is_null());
    }
    assert_eq!(
        db::get(
            &f.db,
            &format!("sessionOutboxRedaction:{}", active["id"].as_str().unwrap())
        )
        .unwrap(),
        json!({"drop":true})
    );
    let drafts = db::rows(&f.db, "SELECT value FROM drafts", &[]).unwrap();
    assert_eq!(drafts.len(), 3);
    for queued in [&push, &share, &copy] {
        let draft = drafts
            .iter()
            .find(|draft| draft["sourceRemoval"]["queued"]["value"]["id"] == queued["id"])
            .unwrap();
        assert_eq!(draft["sourceRemoval"]["queued"]["value"], *queued);
        assert_eq!(draft["status"], "local");
        let bytes = db::blob_read(draft["resource"]["files"][0]["hash"].as_str().unwrap()).unwrap();
        assert_eq!(bytes, text.as_bytes());
        let runtime = tokio::runtime::Runtime::new().unwrap();
        let preview = runtime
            .block_on(crate::governance::governance_command(
                "draft".into(),
                json!({"projectId":id,"id":draft["id"]}),
            ))
            .unwrap();
        assert_eq!(preview["draft"]["resource"], draft["resource"]);
    }
    assert_eq!(fs::read_to_string(&path).unwrap(), text);
    assert_eq!(
        db::get(
            &f.db,
            &format!("selected-share:{}", share["id"].as_str().unwrap())
        )
        .unwrap()["status"],
        "conflict"
    );
    let preserved = db::get(&f.db, "env:test:pending:removed").unwrap();
    assert_eq!(preserved["mutation"], pending["mutation"]);
    assert_eq!(preserved["header"], pending["header"]);
    assert_eq!(preserved["sourceRemoval"]["sourceId"], removed);
    assert_eq!(
        db::get(&f.db, "env:test:pending:other").unwrap(),
        active_pending
    );
    crate::projects::merge_catalog(&f.db, &json!([remote])).unwrap();
    assert_eq!(
        db::rows(&f.db, "SELECT value FROM drafts", &[])
            .unwrap()
            .len(),
        3
    );
}

#[test]
fn pending_env_publications_block_local_source_removal_without_discarding_ciphertext() {
    let f = Fixture::new();
    let mut project = multi_source(&f);
    project["role"] = json!("owner");
    let id = project["id"].as_str().unwrap();
    db::upsert(&f.db, "projects", id, id, &project).unwrap();
    let pending = json!({"header":{"manifest":{"projectId":id,"sourceId":project["sources"][0]["id"]}},"mutation":{"version":{"ciphertext":"encrypted-pending-value"}}});
    db::set(&f.db, "env:test:pending:value", &pending).unwrap();
    let runtime = tokio::runtime::Runtime::new().unwrap();
    let error = runtime
        .block_on(crate::projects::project_command(
            "remove-source".into(),
            json!({"projectId":id,"sourceId":project["sources"][0]["id"]}),
        ))
        .unwrap_err();
    assert!(error.contains("pending ENV publications"));
    assert_eq!(db::get(&f.db, "env:test:pending:value").unwrap(), pending);
}

#[test]
fn imported_resource_ids_are_reused_within_their_source() {
    let f = Fixture::new();
    let project = multi_source(&f);
    let id = uuid::Uuid::new_v4().to_string();
    let text = "Approved remote instructions\n";
    let resource = json!({"resourceId":id,"sourceId":project["sources"][0]["id"],"projectId":project["id"],"kind":"memory","source":"shared","logicalPath":"instructions/AGENTS.md","title":"Instructions","files":[{"path":"content.md","hash":db::blob(text.as_bytes()).unwrap(),"size":text.len(),"executable":false}],"revision":1,"owner":db::get(&f.db,"user").unwrap(),"deleted":false});
    db::upsert(
        &f.db,
        "resources",
        &id,
        project["id"].as_str().unwrap(),
        &resource,
    )
    .unwrap();
    sync::materialize(&f.db, &project, &resource).unwrap();
    indexer::scan(&f.db, &project).unwrap();
    assert_eq!(f.resources().len(), 1);
    assert_eq!(f.resources()[0]["resourceId"], id);
    assert!(f.outbox().is_empty());
}

#[test]
fn permission_reset_never_reads_or_removes_files_in_a_replaced_checkout() {
    let f = Fixture::new();
    let mut project = multi_source(&f);
    project["governed"] = json!(true);
    project["sources"][0]["folderIdentity"] = json!("replaced");
    let id = uuid::Uuid::new_v4().to_string();
    let path = f.root.join(".agents/skills/keep/SKILL.md");
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(&path, "Unrelated checkout content\n").unwrap();
    let resource = json!({"resourceId":id,"sourceId":project["sources"][0]["id"],"projectId":project["id"],"kind":"skill","source":"shared","logicalPath":"keep","files":[],"revision":1,"deleted":false});
    let project_id = project["id"].as_str().unwrap();
    db::upsert(&f.db, "projects", project_id, project_id, &project).unwrap();
    db::upsert(&f.db, "resources", &id, project_id, &resource).unwrap();
    db::upsert(
        &f.db,
        "bindings",
        &id,
        project_id,
        &json!({"base":resource,"managed":true,"paths":[path.parent().unwrap()]}),
    )
    .unwrap();
    crate::governance::reset(&f.db, project_id, &json!([])).unwrap();
    assert_eq!(
        fs::read_to_string(path).unwrap(),
        "Unrelated checkout content\n"
    );
    assert!(f.resources().is_empty());
    assert!(db::rows(&f.db, "SELECT value FROM drafts", &[])
        .unwrap()
        .is_empty());
}

#[test]
fn only_a_folders_own_or_unattributed_uploads_block_disconnecting_it() {
    let f = Fixture::new();
    let project = multi_source(&f);
    let id = project["id"].as_str().unwrap();
    let desktop = project["sources"][0]["id"].as_str().unwrap();
    let backend = project["sources"][1]["id"].as_str().unwrap();
    db::upsert(&f.db, "projects", id, id, &project).unwrap();
    let queue = |value: Value| {
        f.db.execute(
            "INSERT INTO outbox VALUES(?,?,?,?,NULL)",
            rusqlite::params![
                Uuid::new_v4().to_string(),
                id,
                "/v2/sync/push",
                value.to_string()
            ],
        )
        .unwrap();
    };
    assert_eq!(sources::queued_for_source(&f.db, id, desktop).unwrap(), 0);
    // A change to the other folder never blocks this one.
    queue(json!({"resource":{"sourceId":backend}}));
    assert_eq!(sources::queued_for_source(&f.db, id, desktop).unwrap(), 0);
    assert_eq!(sources::queued_for_source(&f.db, id, backend).unwrap(), 1);
    // Ownership through the indexed resource counts.
    let resource = Uuid::new_v4().to_string();
    f.db.execute(
        "INSERT INTO resources VALUES(?,?,?)",
        rusqlite::params![resource, id, json!({"sourceId":desktop}).to_string()],
    )
    .unwrap();
    queue(json!({"resourceId":resource}));
    assert_eq!(sources::queued_for_source(&f.db, id, desktop).unwrap(), 1);
    // A change whose folder is unknown blocks every folder rather than being stranded.
    queue(json!({"kind":"memory"}));
    assert_eq!(sources::queued_for_source(&f.db, id, desktop).unwrap(), 2);
    assert_eq!(sources::queued_for_source(&f.db, id, backend).unwrap(), 2);
}

#[test]
fn a_newly_connected_folder_waits_before_sync_scans_or_writes_into_it() {
    use crate::sync_queue::{Priority, SyncQueue};
    let f = Fixture::new();
    let project = multi_source(&f);
    let id = project["id"].as_str().unwrap();
    let desktop = project["sources"][0]["id"].as_str().unwrap();
    let backend = project["sources"][1]["id"].as_str().unwrap();
    db::upsert(&f.db, "projects", id, id, &project).unwrap();
    let now = chrono::Utc::now().timestamp_millis();
    let at = now + sources::NEW_FOLDER_DELAY_MS;
    db::set(
        &f.db,
        &format!("source-sync-after:{id}:{desktop}"),
        &json!(at),
    )
    .unwrap();

    // Sync sees only the folder that is not waiting.
    let (view, earliest) = sources::without_waiting(&f.db, &project).unwrap();
    assert_eq!(earliest, Some(at));
    assert!(view["sources"][0]["path"].is_null());
    assert_eq!(view["sources"][1]["path"], project["sources"][1]["path"]);
    assert_eq!(
        sources::views(&view)
            .iter()
            .filter(|v| v["path"].is_string())
            .count(),
        1
    );
    assert_eq!(sources::sync_after(&f.db, id, backend).unwrap(), None);

    // The queue shows the held-back job as scheduled, not as a retry.
    SyncQueue::request_at(&f.db, id, Priority::User, "new folder", at).unwrap();
    let states = SyncQueue::states(&f.db, now).unwrap();
    assert_eq!(states[0]["state"], "scheduled");
    assert!(states[0]["notBefore"].is_string());

    // Sync now on the folder clears the wait.
    sources::clear_sync_after(&f.db, id, desktop).unwrap();
    let (view, earliest) = sources::without_waiting(&f.db, &project).unwrap();
    assert_eq!(earliest, None);
    assert_eq!(view["sources"][0]["path"], project["sources"][0]["path"]);

    // An elapsed wait no longer holds the folder back.
    db::set(
        &f.db,
        &format!("source-sync-after:{id}:{desktop}"),
        &json!(now - 1),
    )
    .unwrap();
    assert_eq!(sources::without_waiting(&f.db, &project).unwrap().1, None);
}

#[test]
fn a_pinned_source_accepts_any_checkout_of_its_repository_and_nothing_else() {
    let temp = tempfile::tempdir().unwrap();
    let git = |dir: &std::path::Path, args: &[&str]| {
        let output = std::process::Command::new("/usr/bin/git")
            .env("GIT_CONFIG_GLOBAL", "/dev/null")
            .args([
                "-c",
                "user.name=Fixture",
                "-c",
                "user.email=fixture@example.test",
            ])
            .args(args)
            .current_dir(dir)
            .output()
            .unwrap();
        assert!(
            output.status.success(),
            "{}",
            String::from_utf8_lossy(&output.stderr)
        );
    };
    let main = temp.path().join("api");
    fs::create_dir(&main).unwrap();
    git(&main, &["init", "-q"]);
    git(
        &main,
        &["remote", "add", "origin", "git@github.com:team/api.git"],
    );
    git(&main, &["commit", "-q", "--allow-empty", "-m", "fixture"]);
    use crate::onboarding::discovery::remote_keys;
    let pin = remote_keys(&main).unwrap().remove(0);
    // A linked worktree shares the repository's remote.
    let worktree = temp.path().join("api-feature");
    git(
        &main,
        &["worktree", "add", "-q", worktree.to_str().unwrap()],
    );
    assert_eq!(remote_keys(&worktree).unwrap(), vec![pin.clone()]);
    // HTTPS and a different case name the same GitHub repository.
    let https = temp.path().join("https");
    fs::create_dir(&https).unwrap();
    git(&https, &["init", "-q"]);
    git(
        &https,
        &["remote", "add", "origin", "https://github.com/Team/API.git"],
    );
    assert_eq!(remote_keys(&https).unwrap(), vec![pin.clone()]);
    // Another repository, a repository without a remote and a plain folder differ.
    let other = temp.path().join("other");
    fs::create_dir(&other).unwrap();
    git(&other, &["init", "-q"]);
    git(
        &other,
        &["remote", "add", "origin", "git@github.com:someone/api.git"],
    );
    assert_ne!(remote_keys(&other).unwrap(), vec![pin.clone()]);
    let bare = temp.path().join("no-remote");
    fs::create_dir(&bare).unwrap();
    git(&bare, &["init", "-q"]);
    assert!(remote_keys(&bare).unwrap().is_empty());
    let plain = temp.path().join("plain");
    fs::create_dir(&plain).unwrap();
    assert!(remote_keys(&plain).unwrap().is_empty());

    // A connected folder whose remote now names another repository pauses.
    let view = |root: &std::path::Path| json!({"path":root,"folderIdentity":indexer::folder_identity(root).unwrap(),"sourceRemoteKey":pin});
    assert!(sources::validate(&view(&main)).is_ok());
    assert!(sources::validate(&view(&worktree)).is_ok());
    assert!(sources::validate(&view(&other)).is_err());
    // Without a known remote the folder is not treated as another repository.
    assert!(sources::validate(&view(&bare)).is_ok());
    // A legacy project's remote hint is not a source pin.
    let mut legacy = view(&other);
    legacy["sourceRemoteKey"] = Value::Null;
    legacy["remoteKey"] = json!(pin);
    assert!(sources::validate(&legacy).is_ok());
    assert_eq!(sources::folder_state(&view(&other)), "repository-conflict");
    let mut linked = view(&other);
    linked["repository"] = json!({"cloneUrl":"https://github.com/team/api.git"});
    assert!(sources::validate(&linked).is_err());
    git(
        &other,
        &["remote", "add", "upstream", "git@github.com:team/api.git"],
    );
    // An extra matching remote passes the mistake guard even on the wrong checkout.
    assert!(sources::validate(&linked).is_ok());
    let subfolder = other.join("packages/frontend");
    fs::create_dir_all(&subfolder).unwrap();
    assert!(sources::validate(&view(&subfolder)).is_ok());
    let mut renamed = view(&subfolder);
    renamed["repository"] = json!({"cloneUrl":"https://github.com/team/new-name.git", "previousCloneUrls":["https://github.com/team/api.git"]});
    assert!(sources::validate(&renamed).is_ok());
    renamed["sourceRemoteKey"] = json!(remote_keys(&other).unwrap()[0]);
    assert!(sources::validate(&renamed).is_err());
}

#[test]
fn pin_backfill_only_sends_writes_for_supported_unpinned_sources() {
    let mut f = Fixture::new();
    let git = f.root.join(".git");
    fs::create_dir_all(&git).unwrap();
    fs::write(
        git.join("config"),
        "[remote \"origin\"]\nurl = git@github.com:team/api.git\n",
    )
    .unwrap();
    let key = db::digest(b"orka-remote-v1:github.com/team/api");
    let id = f.project["id"].as_str().unwrap().to_owned();
    f.project["sources"] = json!([{"id":"source","path":f.root}]);
    db::upsert(&f.db, "projects", &id, &id, &f.project).unwrap();

    let supported = json!({"sourceRemoteKey":1});
    tauri::async_runtime::block_on(async {
        sources::backfill_remote_pins(&mut f.db, &json!({}), |_| async {
            panic!("unsupported service received a pin write")
        })
        .await
        .unwrap();

        let mut sent = Vec::new();
        sources::backfill_remote_pins(&mut f.db, &supported, |body| {
            sent.push(body);
            std::future::ready(Ok(json!({"sourceId":"source", "remoteKey":key})))
        })
        .await
        .unwrap();
        assert_eq!(
            sent,
            vec![
                json!({"action":"set-source-remote","projectId":id,"sourceId":"source","remoteKey":key})
            ]
        );

        sources::backfill_remote_pins(&mut f.db, &supported, |_| async {
            panic!("fully pinned project sent another pin write")
        })
        .await
        .unwrap();
    });
}
