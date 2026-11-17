use super::*;

fn cached_session(f: &Fixture, provider: &str) -> (Value, Value, PathBuf) {
    let id = uuid::Uuid::new_v4().to_string();
    let native_id = uuid::Uuid::new_v4().to_string();
    let records = if provider == "codex" {
        vec![
            json!({"type":"session_meta","payload":{"id":native_id,"cwd":f.root,"history_mode":"legacy","cli_version":"0.159.2"}}),
            json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Complete cached conversation"}]}}),
        ]
    } else {
        vec![
            json!({"type":"user","uuid":uuid::Uuid::new_v4().to_string(),"sessionId":native_id,"cwd":f.root,"message":{"role":"user","content":"Complete cached conversation"}}),
        ]
    };
    let bytes = native::encode(&records);
    let path = f.root.join(format!("{native_id}.jsonl"));
    fs::write(&path, &bytes).unwrap();
    let resource = json!({"resourceId":id,"projectId":f.project["id"],"kind":"session","source":provider,"logicalPath":format!("{provider}/{native_id}"),"title":"Cached conversation","files":[{"path":"session.jsonl","hash":db::blob(&bytes).unwrap(),"size":bytes.len(),"executable":false}],"deleted":false,"owner":uuid::Uuid::new_v4().to_string(),"revision":7,"updatedBy":uuid::Uuid::new_v4().to_string(),"updatedAt":"2026-11-17T00:00:00Z","access":{"mode":"read"},"contextSources":[]});
    let binding = json!({"base":resource,"paths":[path],"nativeId":native_id,"needsCopy":true,"lastSeenHash":indexer::manifest_hash(&resource["files"])});
    db::upsert(
        &f.db,
        "resources",
        &id,
        f.project["id"].as_str().unwrap(),
        &resource,
    )
    .unwrap();
    db::upsert(
        &f.db,
        "bindings",
        &id,
        f.project["id"].as_str().unwrap(),
        &binding,
    )
    .unwrap();
    (resource, binding, path)
}

#[test]
fn session_copy_freezes_complete_source_before_capability_negotiation() {
    for provider in ["codex", "claude"] {
        let f = Fixture::new();
        let (mut source, mut binding, path) = cached_session(&f, provider);
        source["sourceId"] = json!(uuid::Uuid::new_v4().to_string());
        if provider == "codex" {
            let lineage = b"Complete inherited history\n";
            source["files"].as_array_mut().unwrap().push(json!({"path":format!("lineage/{}/2.jsonl",uuid::Uuid::new_v4()),"hash":db::blob(lineage).unwrap(),"size":lineage.len(),"executable":false}));
        }
        binding["base"] = source.clone();
        let queued = sync::queue_session_copy(&f.db, &binding, "device").unwrap();
        assert_eq!(queued["sourceSnapshot"]["files"], source["files"]);
        assert_eq!(queued["sourceSnapshot"]["sourceId"], source["sourceId"]);
        for field in [
            "projectId",
            "revision",
            "owner",
            "updatedBy",
            "updatedAt",
            "access",
        ] {
            assert!(queued["sourceSnapshot"].get(field).is_none(), "{field}");
        }

        // Native continuation and a newer remote snapshot cannot change the
        // already frozen source body or its inherited files.
        fs::write(&path, "New local continuation\n").unwrap();
        source["revision"] = json!(8);
        source["files"] = json!([]);
        db::upsert(
            &f.db,
            "resources",
            source["resourceId"].as_str().unwrap(),
            f.project["id"].as_str().unwrap(),
            &source,
        )
        .unwrap();
        let prepared = sync::prepare_session_copy(&f.db, &queued, true).unwrap();
        assert_eq!(prepared, queued);
        let reopened = db::open().unwrap();
        assert_eq!(
            sync::prepare_session_copy(&reopened, &prepared, false).unwrap(),
            prepared
        );
        assert_eq!(
            fs::read_to_string(path).unwrap(),
            "New local continuation\n"
        );
    }
}

#[test]
fn session_copy_legacy_wire_identity_survives_service_upgrade() {
    let f = Fixture::new();
    let (source, binding, path) = cached_session(&f, "claude");
    let queued = sync::queue_session_copy(&f.db, &binding, "device").unwrap();
    let legacy = sync::prepare_session_copy(&f.db, &queued, false).unwrap();
    assert!(legacy.get("sourceSnapshot").is_none());
    assert_eq!(legacy["id"], queued["id"]);
    assert_eq!(
        sync::prepare_session_copy(&f.db, &legacy, true).unwrap(),
        legacy
    );

    // Only a known unavailable-revision response permits replacement with a
    // different request ID. Keep the cached base even if the remote advanced.
    let bytes = fs::read(&path).unwrap();
    let mut latest = source.clone();
    latest["revision"] = json!(9);
    latest["files"] = json!([]);
    db::upsert(
        &f.db,
        "resources",
        source["resourceId"].as_str().unwrap(),
        f.project["id"].as_str().unwrap(),
        &latest,
    )
    .unwrap();
    assert!(sync::replace_unavailable_session_copy(&f.db, &legacy, "device").unwrap());
    let replacement = &f.outbox()[0];
    assert_ne!(replacement["id"], legacy["id"]);
    assert_eq!(replacement["expectedRevision"], source["revision"]);
    assert_eq!(replacement["sourceSnapshot"]["files"], source["files"]);
    assert_eq!(f.outbox().len(), 1);
    let retained = indexer::binding(&f.db, source["resourceId"].as_str().unwrap()).unwrap();
    assert_eq!(retained["copyRequest"], replacement["id"]);
    assert_eq!(retained["needsCopy"], true);
    assert_eq!(fs::read(path).unwrap(), bytes);
}

#[test]
fn session_copy_cannot_replace_a_request_from_a_different_cached_revision() {
    let f = Fixture::new();
    let (source, binding, path) = cached_session(&f, "claude");
    let queued = sync::queue_session_copy(&f.db, &binding, "device").unwrap();
    let legacy = sync::prepare_session_copy(&f.db, &queued, false).unwrap();
    let mut changed = indexer::binding(&f.db, source["resourceId"].as_str().unwrap()).unwrap();
    changed["base"]["revision"] = json!(8);
    db::upsert(
        &f.db,
        "bindings",
        source["resourceId"].as_str().unwrap(),
        f.project["id"].as_str().unwrap(),
        &changed,
    )
    .unwrap();
    let before = f.outbox();
    let bytes = fs::read(&path).unwrap();
    assert!(!sync::replace_unavailable_session_copy(&f.db, &legacy, "device").unwrap());
    assert_eq!(f.outbox(), before);
    assert_eq!(
        indexer::binding(&f.db, source["resourceId"].as_str().unwrap()).unwrap(),
        changed
    );
    assert_eq!(fs::read(path).unwrap(), bytes);
}

#[test]
fn session_copy_latest_pull_reset_preserves_cached_source_and_pending_continuation() {
    let f = Fixture::new();
    let (source, binding, path) = cached_session(&f, "codex");
    let queued = sync::queue_session_copy(&f.db, &binding, "device").unwrap();
    fs::write(&path, "Private unsent continuation\n").unwrap();
    let mut latest = source.clone();
    latest["revision"] = json!(12);
    let events = json!([{"resource":latest,"conflicts":[],"activity":null}]);
    crate::governance::reset(&f.db, f.project["id"].as_str().unwrap(), &events).unwrap();
    sync::apply_event(&f.db, &events[0]).unwrap();
    let retained = indexer::binding(&f.db, source["resourceId"].as_str().unwrap()).unwrap();
    assert_eq!(retained["base"], source);
    assert_eq!(retained["needsCopy"], true);
    assert_eq!(f.outbox(), vec![queued]);
    assert_eq!(f.resources()[0]["revision"], 12);
    assert_eq!(
        fs::read_to_string(path).unwrap(),
        "Private unsent continuation\n"
    );
}

#[test]
fn session_copy_original_ack_preserves_native_base_after_newer_pull() {
    let f = Fixture::new();
    let (source, binding, path) = cached_session(&f, "claude");
    let input = sync::queue_session_copy(&f.db, &binding, "device").unwrap();
    let mut copied = source.clone();
    copied["resourceId"] = json!(uuid::Uuid::new_v4().to_string());
    copied["owner"] = db::get(&f.db, "user").unwrap();
    copied["revision"] = json!(10);
    let original_ack =
        json!({"event":{"resource":copied,"conflicts":[],"activity":null},"conflict":false});
    let mut newer = copied.clone();
    newer["revision"] = json!(11);
    newer["files"] = json!([]);
    sync::apply_event(
        &f.db,
        &json!({"resource":newer,"conflicts":[],"activity":null}),
    )
    .unwrap();
    let bytes = fs::read(&path).unwrap();
    sync::apply_event(&f.db, &original_ack["event"]).unwrap();
    sync::acknowledge_session(
        &f.db,
        f.project["id"].as_str().unwrap(),
        "/v2/sessions/copy",
        &input,
        &original_ack,
    )
    .unwrap();
    let adopted = indexer::binding(&f.db, copied["resourceId"].as_str().unwrap()).unwrap();
    assert_eq!(adopted["base"], copied);
    assert_eq!(adopted["needsCopy"], false);
    assert!(db::rows(
        &f.db,
        "SELECT value FROM bindings WHERE id=?",
        &[&source["resourceId"].as_str().unwrap()]
    )
    .unwrap()
    .is_empty());
    assert_eq!(
        f.resources()
            .iter()
            .find(|r| r["resourceId"] == copied["resourceId"])
            .unwrap()["revision"],
        11
    );
    assert_eq!(fs::read(path).unwrap(), bytes);
}

#[test]
fn session_copy_original_upload_ack_does_not_adopt_remote_bytes_for_native_binding() {
    let f = Fixture::new();
    let (mut source, mut binding, path) = cached_session(&f, "codex");
    source["owner"] = db::get(&f.db, "user").unwrap();
    binding["base"] = source.clone();
    binding["needsCopy"] = json!(false);
    db::upsert(
        &f.db,
        "bindings",
        source["resourceId"].as_str().unwrap(),
        f.project["id"].as_str().unwrap(),
        &binding,
    )
    .unwrap();
    let mut uploaded = source.clone();
    uploaded["revision"] = json!(8);
    let input = json!({"resource":source});
    let receipt =
        json!({"event":{"resource":uploaded,"conflicts":[],"activity":null},"conflict":false});
    let mut latest = uploaded.clone();
    latest["revision"] = json!(9);
    latest["files"] = json!([]);
    sync::apply_event(
        &f.db,
        &json!({"resource":latest,"conflicts":[],"activity":null}),
    )
    .unwrap();
    sync::apply_event(&f.db, &receipt["event"]).unwrap();
    sync::acknowledge_session(
        &f.db,
        f.project["id"].as_str().unwrap(),
        "/v2/sync/push",
        &input,
        &receipt,
    )
    .unwrap();
    let retained = indexer::binding(&f.db, source["resourceId"].as_str().unwrap()).unwrap();
    assert_eq!(retained["base"], uploaded);
    assert_eq!(retained["previous"], source);
    assert_eq!(f.resources()[0]["revision"], 9);
    assert_eq!(
        fs::read(path).unwrap(),
        db::blob_read(source["files"][0]["hash"].as_str().unwrap()).unwrap()
    );
}

#[test]
fn session_copy_command_freezes_a_cached_selection_without_a_native_binding() {
    let f = Fixture::new();
    let (source, _, path) = cached_session(&f, "claude");
    f.db.execute("DELETE FROM bindings", []).unwrap();
    crate::commands::session_action(
        source["resourceId"].as_str().unwrap().into(),
        "copy".into(),
        None,
        None,
    )
    .unwrap();
    let queued = f.outbox()[0].clone();
    assert_eq!(queued["expectedRevision"], source["revision"]);
    assert_eq!(queued["sourceSnapshot"]["files"], source["files"]);
    let legacy = sync::prepare_session_copy(&f.db, &queued, false).unwrap();
    let mut latest = source.clone();
    latest["revision"] = json!(8);
    latest["files"] = json!([]);
    db::upsert(
        &f.db,
        "resources",
        source["resourceId"].as_str().unwrap(),
        f.project["id"].as_str().unwrap(),
        &latest,
    )
    .unwrap();
    assert_eq!(
        sync::prepare_session_copy(&f.db, &legacy, true).unwrap(),
        legacy
    );
    assert!(sync::replace_unavailable_session_copy(&f.db, &legacy, "device").unwrap());
    let replacement = f.outbox()[0].clone();
    assert_ne!(replacement["id"], queued["id"]);
    assert_eq!(replacement["expectedRevision"], source["revision"]);
    assert_eq!(replacement["sourceSnapshot"]["files"], source["files"]);
    assert!(db::rows(&f.db, "SELECT value FROM bindings", &[])
        .unwrap()
        .is_empty());
    assert_eq!(
        fs::read(path).unwrap(),
        db::blob_read(source["files"][0]["hash"].as_str().unwrap()).unwrap()
    );
}

#[test]
fn session_copy_command_uses_selected_revision_and_does_not_rebind_a_continuation() {
    let f = Fixture::new();
    let (source, mut binding, path) = cached_session(&f, "claude");
    binding["copyRequest"] = json!(uuid::Uuid::new_v4().to_string());
    db::upsert(
        &f.db,
        "bindings",
        source["resourceId"].as_str().unwrap(),
        f.project["id"].as_str().unwrap(),
        &binding,
    )
    .unwrap();
    let mut selected = source.clone();
    selected["revision"] = json!(8);
    let bytes = b"A different complete selected snapshot\n";
    selected["files"][0]["hash"] = json!(db::blob(bytes).unwrap());
    selected["files"][0]["size"] = json!(bytes.len());
    db::upsert(
        &f.db,
        "resources",
        source["resourceId"].as_str().unwrap(),
        f.project["id"].as_str().unwrap(),
        &selected,
    )
    .unwrap();
    crate::commands::session_action(
        source["resourceId"].as_str().unwrap().into(),
        "copy".into(),
        None,
        None,
    )
    .unwrap();
    let queued = f.outbox()[0].clone();
    assert_eq!(queued["expectedRevision"], selected["revision"]);
    assert_eq!(queued["sourceSnapshot"]["files"], selected["files"]);
    assert_ne!(queued["sourceSnapshot"]["files"], binding["base"]["files"]);
    let mut copy = selected.clone();
    copy["resourceId"] = queued["id"].clone();
    copy["owner"] = db::get(&f.db, "user").unwrap();
    copy["revision"] = json!(9);
    let receipt =
        json!({"event":{"resource":copy,"conflicts":[],"activity":null},"conflict":false});
    sync::apply_event(&f.db, &receipt["event"]).unwrap();
    sync::acknowledge_session(
        &f.db,
        f.project["id"].as_str().unwrap(),
        "/v2/sessions/copy",
        &queued,
        &receipt,
    )
    .unwrap();
    assert_eq!(
        indexer::binding(&f.db, source["resourceId"].as_str().unwrap()).unwrap(),
        binding
    );
    assert_eq!(
        db::get(
            &f.db,
            &format!("sessionCopy:{}", queued["id"].as_str().unwrap())
        )
        .unwrap(),
        Value::Null
    );
    assert_eq!(
        fs::read(path).unwrap(),
        db::blob_read(source["files"][0]["hash"].as_str().unwrap()).unwrap()
    );
}

#[test]
fn session_copy_permission_reset_preserves_the_selected_snapshot_as_a_private_draft() {
    let f = Fixture::new();
    let (source, _, _) = cached_session(&f, "claude");
    f.db.execute("DELETE FROM bindings", []).unwrap();
    crate::commands::session_action(
        source["resourceId"].as_str().unwrap().into(),
        "copy".into(),
        None,
        None,
    )
    .unwrap();
    let queued = f.outbox()[0].clone();
    sync::prepare_session_copy(&f.db, &queued, false).unwrap();
    let mut latest = source.clone();
    latest["revision"] = json!(8);
    latest["files"] = json!([]);
    db::upsert(
        &f.db,
        "resources",
        source["resourceId"].as_str().unwrap(),
        f.project["id"].as_str().unwrap(),
        &latest,
    )
    .unwrap();
    crate::governance::reset(&f.db, f.project["id"].as_str().unwrap(), &json!([])).unwrap();
    let drafts = db::rows(&f.db, "SELECT value FROM drafts", &[]).unwrap();
    assert!(drafts
        .iter()
        .any(|draft| draft["resource"]["files"] == source["files"] && draft["status"] == "local"));
    assert!(f.outbox().is_empty());
    assert_eq!(
        db::get(
            &f.db,
            &format!("sessionCopy:{}", queued["id"].as_str().unwrap())
        )
        .unwrap(),
        Value::Null
    );
    assert!(db::blob_read(source["files"][0]["hash"].as_str().unwrap()).is_ok());
}

#[test]
fn session_copy_source_removal_preserves_the_selected_snapshot_before_clearing_its_queue() {
    let f = Fixture::new();
    let (mut source, _, _) = cached_session(&f, "claude");
    source["sourceId"] = json!(uuid::Uuid::new_v4().to_string());
    f.db.execute("DELETE FROM bindings", []).unwrap();
    db::upsert(
        &f.db,
        "resources",
        source["resourceId"].as_str().unwrap(),
        f.project["id"].as_str().unwrap(),
        &source,
    )
    .unwrap();
    crate::commands::session_action(
        source["resourceId"].as_str().unwrap().into(),
        "copy".into(),
        None,
        None,
    )
    .unwrap();
    let queued = f.outbox()[0].clone();
    sync::prepare_session_copy(&f.db, &queued, false).unwrap();
    let mut latest = source.clone();
    latest["revision"] = json!(8);
    latest["files"] = json!([]);
    db::upsert(
        &f.db,
        "resources",
        source["resourceId"].as_str().unwrap(),
        f.project["id"].as_str().unwrap(),
        &latest,
    )
    .unwrap();
    crate::sources::preserve_removed_queue(
        &f.db,
        f.project["id"].as_str().unwrap(),
        &json!({"id":source["sourceId"],"removedAt":"2026-11-17T00:00:00Z"}),
    )
    .unwrap();
    let drafts = db::rows(&f.db, "SELECT value FROM drafts", &[]).unwrap();
    assert!(drafts
        .iter()
        .any(|draft| draft["resource"]["files"] == source["files"]
            && draft["sourceRemoval"]["queued"]["value"]["expectedRevision"]
                == source["revision"]));
    assert!(f.outbox().is_empty());
    assert_eq!(
        db::get(
            &f.db,
            &format!("sessionCopy:{}", queued["id"].as_str().unwrap())
        )
        .unwrap(),
        Value::Null
    );
}

#[test]
fn session_copy_conflict_resolution_still_adopts_the_selected_copy() {
    let f = Fixture::new();
    let (source, mut binding, path) = cached_session(&f, "claude");
    binding["needsCopy"] = json!(false);
    binding["copyRequest"] = Value::Null;
    db::upsert(
        &f.db,
        "bindings",
        source["resourceId"].as_str().unwrap(),
        f.project["id"].as_str().unwrap(),
        &binding,
    )
    .unwrap();
    let request = json!({"id":uuid::Uuid::new_v4().to_string(),"resourceId":source["resourceId"],"action":"copy","selected":"candidate"});
    let mut copied = source.clone();
    copied["resourceId"] = request["id"].clone();
    copied["owner"] = db::get(&f.db, "user").unwrap();
    copied["revision"] = json!(8);
    let receipt =
        json!({"event":{"resource":copied,"conflicts":[],"activity":null},"conflict":false});
    sync::acknowledge_session(
        &f.db,
        f.project["id"].as_str().unwrap(),
        "/v2/sessions/resolve",
        &request,
        &receipt,
    )
    .unwrap();
    let adopted = indexer::binding(&f.db, copied["resourceId"].as_str().unwrap()).unwrap();
    assert_eq!(adopted["base"], copied);
    assert_eq!(adopted["needsCopy"], false);
    assert_eq!(adopted["paths"], binding["paths"]);
    assert_eq!(
        fs::read(path).unwrap(),
        db::blob_read(source["files"][0]["hash"].as_str().unwrap()).unwrap()
    );
}
