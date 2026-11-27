use super::*;
use crate::{governance, selective_sharing};

fn input(f: &Fixture) -> Value {
    json!({"accountId":db::get(&f.db,"user").unwrap(),"serviceOrigin":"https://selected.example","projectId":f.project["id"]})
}

fn prepare(f: &mut Fixture) {
    f.project["sharing"] = json!(crate::projects::Sharing::default());
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
        &json!({"apiUrl":"https://selected.example"}),
    )
    .unwrap();
    super::sharing_tests::seed(f);
}

#[test]
fn selected_discovery_keeps_all_categories_private_and_excludes_envs() {
    let mut f = Fixture::new();
    prepare(&mut f);
    for kind in ["memory", "skill", "plan", "session"] {
        let items = indexer::discover(&f.db, &f.project, kind).unwrap();
        assert!(!items.is_empty(), "{kind}");
        assert!(items.iter().all(|item| item["resource"]["kind"] == kind));
        assert!(f.outbox().is_empty());
        assert!(f.resources().is_empty());
        assert!(db::rows(&f.db, "SELECT value FROM bindings", &[])
            .unwrap()
            .is_empty());
        assert!(db::rows(&f.db, "SELECT value FROM drafts", &[])
            .unwrap()
            .is_empty());
    }
    assert!(indexer::discover(&f.db, &f.project, "env").is_err());
    assert!(!f.root.join(".orka/plans/codex").exists());
    assert_eq!(
        f.project["sharing"],
        json!(crate::projects::Sharing::default())
    );
}

#[tokio::test]
async fn pi_session_discovery_reads_the_saved_branch_and_queues_only_an_explicit_snapshot() {
    let mut f = Fixture::new();
    prepare(&mut f);
    f.db = db::open().unwrap();
    let directory = crate::pi_sessions::directory().unwrap();
    fs::create_dir_all(&directory).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let path = directory.join(format!("{id}.jsonl"));
    let mut original = native::encode(&[
        json!({"type":"session","version":3,"id":id,"cwd":f.root}),
        json!({"type":"message","id":"root","parentId":null,"message":{"role":"user","content":"Explore Pi"}}),
        json!({"type":"message","id":"old","parentId":"root","message":{"role":"assistant","content":"Abandoned answer"}}),
        json!({"type":"message","id":"saved","parentId":"root","message":{"role":"assistant","content":[{"type":"text","text":"Saved answer"},{"type":"thinking","thinking":"Hidden reasoning"}]}}),
    ]);
    original.extend_from_slice(b"{\"type\":\"message\"");
    fs::write(&path, &original).unwrap();
    let mut unrelated = native::complete_records(&original).unwrap();
    unrelated[0]["id"] = json!(uuid::Uuid::new_v4());
    unrelated[0]["cwd"] = json!(f._home.path().join("different-project"));
    fs::write(
        directory.join("unrelated.jsonl"),
        native::encode(&unrelated),
    )
    .unwrap();

    let pi: Vec<_> = indexer::discover(&f.db, &f.project, "session")
        .unwrap()
        .into_iter()
        .filter(|item| item["resource"]["source"] == "pi")
        .collect();
    assert_eq!(pi.len(), 1);
    let local = &pi[0];
    let resource = &local["resource"];
    let resource_id = resource["resourceId"].as_str().unwrap();
    let page = crate::commands::session_messages(resource_id.into(), None, None, None)
        .await
        .unwrap();
    assert_eq!(
        page["messages"],
        json!([
            {"index":0,"role":"user","text":"Explore Pi"},
            {"index":1,"role":"assistant","text":"Saved answer"}
        ])
    );
    let prompt = crate::session_launcher::handoff_prompt(resource_id).unwrap();
    let prompt = prompt["text"].as_str().unwrap();
    assert!(prompt.contains("Saved answer") && !prompt.contains("Abandoned answer"));
    let read = crate::session_forks::reading_resource(
        &f.db,
        &crate::local_resources::resource(&f.db, resource_id).unwrap(),
    )
    .unwrap();
    let records = read.records().unwrap();
    assert_eq!(records.len(), 4);
    assert_eq!(records[2]["id"], "old");
    assert_eq!(fs::read(&path).unwrap(), original);
    let mut auto = f.project.clone();
    auto["sharing"]["session"] = json!(true);
    indexer::scan(&f.db, &auto).unwrap();
    assert!(f
        .outbox()
        .iter()
        .all(|entry| entry["resource"]["source"] != "pi"));

    let mut request = input(&f);
    request["kind"] = json!("session");
    request["resourceId"] = json!(resource_id);
    let preview = selective_sharing::preview(&f.db, &f.project, &request).unwrap();
    assert!(preview["note"]
        .as_str()
        .unwrap()
        .contains("abandoned branches"));
    assert!(preview["note"].as_str().unwrap().contains("tool records"));
    assert_eq!(
        preview["piScope"],
        json!({"entries":3,"offBranchEntries":1})
    );
    request["previewToken"] = preview["previewToken"].clone();
    assert!(selective_sharing::queue(&f.db, &f.project, &request)
        .unwrap_err()
        .contains("Confirm sharing the complete Pi session"));
    request["acknowledgedPiPreviewToken"] = json!(uuid::Uuid::new_v4());
    assert!(selective_sharing::queue(&f.db, &f.project, &request)
        .unwrap_err()
        .contains("Confirm sharing the complete Pi session"));
    assert!(f
        .outbox()
        .iter()
        .all(|entry| entry["resource"]["source"] != "pi"));
    request["acknowledgedPiPreviewToken"] = preview["previewToken"].clone();
    let receipt = selective_sharing::queue(&f.db, &f.project, &request).unwrap();
    assert_eq!(receipt["status"], "queued");
    assert_eq!(
        selective_sharing::queue(&f.db, &f.project, &request).unwrap(),
        receipt
    );
    let queued = db::rows(
        &f.db,
        "SELECT value FROM outbox WHERE path=?",
        &[&selective_sharing::QUEUE_PATH],
    )
    .unwrap();
    assert_eq!(queued.len(), 1);
    assert_eq!(queued[0]["resource"]["files"], resource["files"]);
    assert_eq!(queued[0]["resource"]["source"], "pi");

    let mut incoming = queued[0]["resource"].clone();
    incoming["resourceId"] = json!(uuid::Uuid::new_v4());
    incoming["revision"] = json!(1);
    sync::materialize(&f.db, &auto, &incoming).unwrap();
    let cached = indexer::binding(&f.db, incoming["resourceId"].as_str().unwrap()).unwrap();
    assert_eq!(cached["base"]["files"], incoming["files"]);
    assert_eq!(cached["paths"], json!([]));
    assert_eq!(fs::read(&path).unwrap(), original);
}

#[test]
fn pi_and_codex_sessions_with_the_same_native_id_keep_separate_identity() {
    let mut f = Fixture::new();
    prepare(&mut f);
    let codex = indexer::discover(&f.db, &f.project, "session")
        .unwrap()
        .into_iter()
        .find(|r| r["resource"]["source"] == "codex")
        .unwrap();
    let id = codex["nativeId"].as_str().unwrap().to_owned();
    // A binding written by an ordinary scan must not let Pi adopt its identity.
    db::upsert(
        &f.db,
        "bindings",
        codex["resource"]["resourceId"].as_str().unwrap(),
        f.project["id"].as_str().unwrap(),
        &json!({"base":codex["resource"],"nativeId":id,"paths":[f.root.join("codex.jsonl")]}),
    )
    .unwrap();
    let folder = crate::pi_sessions::directory().unwrap();
    fs::create_dir_all(&folder).unwrap();
    let path = folder.join(format!("{id}.jsonl"));
    fs::write(&path, native::encode(&[
        json!({"type":"session","version":3,"id":id,"cwd":f.root}),
        json!({"type":"message","id":"a","parentId":null,"message":{"role":"user","content":"Different Pi chat"}}),
    ])).unwrap();
    assert_eq!(
        crate::history::session_route_prefix(&path, "pi"),
        Some((Some(id.to_owned()), f.root.clone()))
    );
    let entries = indexer::discover(&f.db, &f.project, "session").unwrap();
    let pi = entries
        .iter()
        .find(|r| r["resource"]["source"] == "pi")
        .unwrap();
    let found = entries
        .iter()
        .find(|r| r["resource"]["source"] == "codex")
        .unwrap();
    assert_eq!(
        found["resource"]["resourceId"],
        codex["resource"]["resourceId"]
    );
    assert_ne!(
        pi["resource"]["resourceId"],
        found["resource"]["resourceId"]
    );
    // A pre-provider binding must keep serving older tools but never Pi.
    let legacy = json!({"base":{"resourceId":codex["resource"]["resourceId"],"owner":f.project["id"],"projectId":f.project["id"]},"nativeId":id,"paths":[f.root.join("codex.jsonl")]});
    db::upsert(
        &f.db,
        "bindings",
        codex["resource"]["resourceId"].as_str().unwrap(),
        f.project["id"].as_str().unwrap(),
        &legacy,
    )
    .unwrap();
    let entries = indexer::discover(&f.db, &f.project, "session").unwrap();
    let pi = entries
        .iter()
        .find(|r| r["resource"]["source"] == "pi")
        .unwrap();
    let found = entries
        .iter()
        .find(|r| r["resource"]["source"] == "codex")
        .unwrap();
    assert_eq!(
        found["resource"]["resourceId"],
        codex["resource"]["resourceId"]
    );
    assert_ne!(
        pi["resource"]["resourceId"],
        found["resource"]["resourceId"]
    );
}

#[test]
fn selected_discovery_does_not_reconcile_divergent_or_removed_skill_mirrors() {
    let mut f = Fixture::new();
    prepare(&mut f);
    let original = indexer::discover(&f.db, &f.project, "skill")
        .unwrap()
        .remove(0);
    let id = original["resource"]["resourceId"].as_str().unwrap();
    let other = f.root.join(".claude/skills/example");
    fs::create_dir_all(&other).unwrap();
    fs::write(other.join("SKILL.md"), "Different private skill").unwrap();
    assert!(indexer::discover(&f.db, &f.project, "skill")
        .unwrap()
        .is_empty());
    assert!(db::rows(&f.db, "SELECT value FROM bindings", &[])
        .unwrap()
        .is_empty());
    assert!(db::rows(&f.db, "SELECT value FROM drafts", &[])
        .unwrap()
        .is_empty());
    fs::remove_dir_all(&other).unwrap();
    let binding = json!({"base":original["resource"],"paths":[original["paths"][0],other],"guards":["old","old"],"mirrorReview":true});
    db::upsert(
        &f.db,
        "bindings",
        id,
        f.project["id"].as_str().unwrap(),
        &binding,
    )
    .unwrap();
    let found = indexer::discover(&f.db, &f.project, "skill").unwrap();
    assert_eq!(found[0]["resource"]["files"], original["resource"]["files"]);
    assert_eq!(indexer::binding(&f.db, id).unwrap(), binding);
    assert!(f.outbox().is_empty());
    assert!(f.resources().is_empty());
}

#[test]
fn selected_share_freezes_one_snapshot_deduplicates_and_never_enables_future_turns() {
    let mut f = Fixture::new();
    prepare(&mut f);
    let local = indexer::discover(&f.db, &f.project, "session")
        .unwrap()
        .remove(0);
    let mut request = input(&f);
    request["kind"] = json!("session");
    request["resourceId"] = local["resource"]["resourceId"].clone();
    let preview = selective_sharing::preview(&f.db, &f.project, &request).unwrap();
    let source = PathBuf::from(local["paths"][0].as_str().unwrap());
    let mut bytes = fs::read(&source).unwrap();
    bytes.extend_from_slice(b"{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"text\":\"Future private turn\"}]}}\n");
    fs::write(&source, &bytes).unwrap();
    request["previewToken"] = preview["previewToken"].clone();
    let receipt = selective_sharing::queue(&f.db, &f.project, &request).unwrap();
    assert_eq!(receipt["status"], "queued");
    assert_eq!(
        selective_sharing::queue(&f.db, &f.project, &request).unwrap(),
        receipt
    );
    assert_eq!(
        db::rows(
            &f.db,
            "SELECT json_object('project',project,'priority',priority,'reason',reason) FROM sync_queue",
            &[]
        )
        .unwrap(),
        [json!({"project":f.project["id"],"priority":2,"reason":"share"})]
    );
    let queued = db::rows(
        &f.db,
        "SELECT json_object('id',id,'project',project,'path',path,'value',json(value)) FROM outbox",
        &[],
    )
    .unwrap()
    .remove(0);
    assert_eq!(
        queued["value"]["resource"]["files"],
        local["resource"]["files"]
    );
    assert_eq!(
        selective_sharing::authorized_origin(&f.db, &queued)
            .unwrap()
            .as_deref(),
        Some("https://selected.example")
    );
    let mut tampered = queued.clone();
    tampered["value"]["resource"]["title"] = json!("Different snapshot");
    assert!(selective_sharing::authorized_origin(&f.db, &tampered)
        .unwrap()
        .is_none());
    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(f.outbox().len(), 1);
    assert_eq!(
        governance::project(&f.db, f.project["id"].as_str().unwrap()).unwrap()["sharing"],
        f.project["sharing"]
    );
    let next = selective_sharing::preview(&f.db, &f.project, &request).unwrap();
    assert_ne!(next["snapshotHash"], preview["snapshotHash"]);
    request["previewToken"] = next["previewToken"].clone();
    assert_ne!(
        selective_sharing::queue(&f.db, &f.project, &request).unwrap()["requestId"],
        receipt["requestId"]
    );
    crate::projects::remove_local(&f.db, f.project["id"].as_str().unwrap()).unwrap();
    assert!(f.outbox().is_empty());
    assert!(db::rows(&f.db, "SELECT value FROM local_resources", &[])
        .unwrap()
        .is_empty());
    assert!(db::rows(
        &f.db,
        "SELECT value FROM meta WHERE key LIKE 'share-preview:%' OR key LIKE 'selected-share:%'",
        &[]
    )
    .unwrap()
    .is_empty());
    assert_eq!(fs::read(source).unwrap(), bytes);
}

#[test]
fn selected_preview_is_bound_to_account_service_project_expiry_and_folder() {
    let mut f = Fixture::new();
    prepare(&mut f);
    let local = indexer::discover(&f.db, &f.project, "skill")
        .unwrap()
        .remove(0);
    let mut request = input(&f);
    request["kind"] = json!("skill");
    request["resourceId"] = local["resource"]["resourceId"].clone();
    let preview = selective_sharing::preview(&f.db, &f.project, &request).unwrap();
    request["previewToken"] = preview["previewToken"].clone();
    for key in ["accountId", "serviceOrigin", "projectId"] {
        let mut wrong = request.clone();
        wrong[key] = json!("another");
        assert!(selective_sharing::queue(&f.db, &f.project, &wrong).is_err());
    }
    let key = format!(
        "share-preview:{}",
        preview["previewToken"].as_str().unwrap()
    );
    let saved = db::get(&f.db, &key).unwrap();
    let mut expired = saved.clone();
    expired["expires"] = json!(0);
    db::set(&f.db, &key, &expired).unwrap();
    assert!(selective_sharing::queue(&f.db, &f.project, &request)
        .unwrap_err()
        .contains("expired"));
    db::set(&f.db, &key, &saved).unwrap();
    let mut moved = f.project.clone();
    moved["folderIdentity"] = json!("different-folder");
    assert!(selective_sharing::queue(&f.db, &moved, &request).is_err());
    assert!(f.outbox().is_empty());
}

#[test]
fn selected_preview_from_discovery_rejects_mismatched_identity() {
    let mut f = Fixture::new();
    prepare(&mut f);
    let local = indexer::discover(&f.db, &f.project, "session")
        .unwrap()
        .remove(0);
    let mut request = input(&f);
    request["kind"] = json!("session");
    request["resourceId"] = local["resource"]["resourceId"].clone();
    for key in ["kind", "resourceId"] {
        let mut wrong = request.clone();
        wrong[key] = json!("another");
        assert!(selective_sharing::preview_from_local(&f.db, &f.project, &wrong, &local).is_err());
    }
    let mut wrong = local.clone();
    wrong["resource"]["projectId"] = json!(uuid::Uuid::new_v4().to_string());
    assert!(selective_sharing::preview_from_local(&f.db, &f.project, &request, &wrong).is_err());
    assert!(db::rows(
        &f.db,
        "SELECT value FROM meta WHERE key LIKE 'share-preview:%'",
        &[]
    )
    .unwrap()
    .is_empty());
    assert!(f.outbox().is_empty());
    assert!(f.resources().is_empty());
}

#[test]
fn selected_requests_survive_governance_localization_and_respect_account_changes() {
    let mut f = Fixture::new();
    prepare(&mut f);
    f.project["governed"] = json!(true);
    let local = indexer::discover(&f.db, &f.project, "memory")
        .unwrap()
        .remove(0);
    let mut request = input(&f);
    request["kind"] = json!("memory");
    request["resourceId"] = local["resource"]["resourceId"].clone();
    request["previewToken"] =
        selective_sharing::preview(&f.db, &f.project, &request).unwrap()["previewToken"].clone();
    selective_sharing::queue(&f.db, &f.project, &request).unwrap();
    governance::localize_outbox(&f.db, &f.project).unwrap();
    assert_eq!(f.outbox().len(), 1);
    let queued = db::rows(
        &f.db,
        "SELECT json_object('id',id,'project',project,'path',path,'value',json(value)) FROM outbox",
        &[],
    )
    .unwrap()
    .remove(0);
    let config = db::get(&f.db, "config").unwrap();
    db::set(
        &f.db,
        "config",
        &json!({"apiUrl":"https://another.example"}),
    )
    .unwrap();
    assert!(selective_sharing::authorized_origin(&f.db, &queued)
        .unwrap()
        .is_none());
    db::set(&f.db, "config", &config).unwrap();
    db::set(&f.db, "user", &json!(uuid::Uuid::new_v4().to_string())).unwrap();
    assert!(selective_sharing::authorized_origin(&f.db, &queued)
        .unwrap()
        .is_none());
}

#[tokio::test]
async fn selected_tools_check_local_account_before_discovering_private_items() {
    let mut f = Fixture::new();
    prepare(&mut f);
    let mut request = input(&f);
    request["kind"] = json!("session");
    request["accountId"] = json!(uuid::Uuid::new_v4().to_string());
    assert!(selective_sharing::command("list_local_resources", &request)
        .await
        .unwrap_err()
        .contains("same Orka account"));
    request = input(&f);
    request["kind"] = json!("session");
    request["serviceOrigin"] = json!("https://another.example");
    assert!(selective_sharing::command("list_local_resources", &request)
        .await
        .unwrap_err()
        .contains("same Orka service"));
    assert!(db::rows(&f.db, "SELECT value FROM local_resources", &[])
        .unwrap()
        .is_empty());
}

#[test]
fn a_review_only_share_keeps_its_destination_across_retries() {
    let mut f = Fixture::new();
    prepare(&mut f);
    let mut input = input(&f);
    input["kind"] = json!("session");
    let local = indexer::discover(&f.db, &f.project, "session")
        .unwrap()
        .remove(0);
    input["resourceId"] = local["resource"]["resourceId"].clone();
    let preview = selective_sharing::preview(&f.db, &f.project, &input).unwrap();
    input["previewToken"] = preview["previewToken"].clone();
    input["requireApproval"] = json!(true);
    let receipt = selective_sharing::queue(&f.db, &f.project, &input).unwrap();
    let id = receipt["requestId"].as_str().unwrap();
    let queued = db::rows(&f.db,
        "SELECT json_object('id',id,'project',project,'path',path,'value',json(value)) FROM outbox WHERE id=?",
        &[&id]).unwrap().remove(0);
    assert!(selective_sharing::authorized_origin(&f.db, &queued)
        .unwrap()
        .is_some());
    assert_ne!(
        receipt["payloadHash"],
        db::digest(queued["value"].to_string().as_bytes())
    );
    input.as_object_mut().unwrap().remove("requireApproval");
    assert_eq!(
        selective_sharing::queue(&f.db, &f.project, &input).unwrap(),
        receipt
    );
    f.db.execute("DELETE FROM outbox WHERE id=?", [id]).unwrap();
    assert_eq!(
        selective_sharing::queue(&f.db, &f.project, &input).unwrap(),
        receipt
    );
}

#[test]
fn a_suggest_only_preview_keeps_approval_after_promotion_without_a_client_hint() {
    let mut f = Fixture::new();
    prepare(&mut f);
    f.project["governed"] = json!(true);
    let mut request = input(&f);
    let catalog = format!("governance:{}", f.project["id"].as_str().unwrap());
    db::set(
        &f.db,
        &catalog,
        &json!({"access":{"session":{"create":"suggest"}}}),
    )
    .unwrap();
    let local = indexer::discover(&f.db, &f.project, "session")
        .unwrap()
        .remove(0);
    request["kind"] = json!("session");
    request["resourceId"] = local["resource"]["resourceId"].clone();
    let preview = selective_sharing::preview(&f.db, &f.project, &request).unwrap();
    assert_eq!(preview["publicationMode"], "suggest");
    db::set(
        &f.db,
        &catalog,
        &json!({"access":{"session":{"create":"publish"}}}),
    )
    .unwrap();
    request["previewToken"] = preview["previewToken"].clone();
    let receipt = selective_sharing::queue(&f.db, &f.project, &request).unwrap();
    assert_eq!(receipt["requireApproval"], true);
}

#[test]
fn upgrade_routes_only_intact_legacy_shares_and_keeps_the_frozen_change() {
    let mut f = Fixture::new();
    prepare(&mut f);
    let mut request = input(&f);
    request["kind"] = json!("session");
    let local = indexer::discover(&f.db, &f.project, "session")
        .unwrap()
        .remove(0);
    request["resourceId"] = local["resource"]["resourceId"].clone();
    request["previewToken"] =
        selective_sharing::preview(&f.db, &f.project, &request).unwrap()["previewToken"].clone();
    let direct = selective_sharing::queue(&f.db, &f.project, &request).unwrap();
    assert_eq!(direct["requireApproval"], false);
    let key = format!("selected-share:{}", direct["requestId"].as_str().unwrap());
    let queued = db::rows(
        &f.db,
        "SELECT json_object('id',id,'project',project,'path',path,'value',json(value)) FROM outbox",
        &[],
    )
    .unwrap()
    .remove(0);
    let mut legacy = direct.clone();
    legacy.as_object_mut().unwrap().remove("requireApproval");

    for (governed, review) in [
        (json!(false), false),
        (json!(true), true),
        (Value::Null, true),
    ] {
        f.project["governed"] = governed;
        db::upsert(
            &f.db,
            "projects",
            f.project["id"].as_str().unwrap(),
            "",
            &f.project,
        )
        .unwrap();
        db::set(&f.db, &key, &legacy).unwrap();
        assert_eq!(
            selective_sharing::authorized_origin(&f.db, &queued).unwrap(),
            None
        );
        let upgraded = db::open().unwrap();
        let receipt = db::get(&upgraded, &key).unwrap();
        assert_eq!(receipt["requireApproval"], review);
        assert_eq!(receipt["requestId"], legacy["requestId"]);
        assert_eq!(receipt["payloadHash"] == direct["payloadHash"], !review);
        assert_eq!(
            selective_sharing::authorized_origin(&upgraded, &queued)
                .unwrap()
                .as_deref(),
            Some("https://selected.example")
        );
        assert_eq!(f.outbox(), vec![queued["value"].clone()]);
        assert_eq!(db::get(&db::open().unwrap(), &key).unwrap(), receipt);
    }

    let mut damaged = legacy.clone();
    damaged["payloadHash"] = json!("invalid digest");
    db::set(&f.db, &key, &damaged).unwrap();
    let upgraded = db::open().unwrap();
    assert_eq!(db::get(&upgraded, &key).unwrap(), damaged);
    assert_eq!(
        selective_sharing::authorized_origin(&upgraded, &queued).unwrap(),
        None
    );

    // Recover an outbox row missing at upgrade using a fresh confirmation.
    db::set(&f.db, &key, &legacy).unwrap();
    f.db.execute("DELETE FROM outbox", []).unwrap();
    assert_eq!(db::get(&db::open().unwrap(), &key).unwrap(), legacy);
    request["previewToken"] =
        selective_sharing::preview(&f.db, &f.project, &request).unwrap()["previewToken"].clone();
    let restored = selective_sharing::queue(&f.db, &f.project, &request).unwrap();
    assert_eq!(restored["requireApproval"], true);
    assert_eq!(restored["requestId"], legacy["requestId"]);
    assert_eq!(f.outbox(), vec![queued["value"].clone()]);
}

#[test]
fn selected_conflict_receipt_preserves_current_and_candidate_snapshots() {
    let mut f = Fixture::new();
    prepare(&mut f);
    let local = indexer::discover(&f.db, &f.project, "session")
        .unwrap()
        .remove(0);
    let mut request = input(&f);
    request["kind"] = json!("session");
    request["resourceId"] = local["resource"]["resourceId"].clone();
    request["previewToken"] =
        selective_sharing::preview(&f.db, &f.project, &request).unwrap()["previewToken"].clone();
    selective_sharing::queue(&f.db, &f.project, &request).unwrap();
    let queued = db::rows(
        &f.db,
        "SELECT json_object('id',id,'project',project,'path',path,'value',json(value)) FROM outbox",
        &[],
    )
    .unwrap()
    .remove(0);
    let selected = queued["value"]["resource"].clone();
    let mut current = selected.clone();
    current["projectId"] = f.project["id"].clone();
    current["revision"] = json!(2);
    current["files"] =
        json!([{"path":"session.jsonl","hash":"0".repeat(64),"size":0,"executable":false}]);
    let result = json!({"status":"conflict","receipt":{"conflict":true,"event":{"resource":current,"conflicts":[{"id":queued["id"],"resourceId":selected["resourceId"],"candidate":selected,"revision":2}]}}});
    selective_sharing::complete(&f.db, &queued, &result).unwrap();
    assert_eq!(f.resources()[0]["files"], current["files"]);
    assert_eq!(
        db::rows(&f.db, "SELECT value FROM conflicts", &[]).unwrap()[0]["candidate"]["files"],
        selected["files"]
    );
    assert_eq!(
        db::get(
            &f.db,
            &format!("selected-share:{}", queued["id"].as_str().unwrap())
        )
        .unwrap()["status"],
        "conflict"
    );
}

#[test]
fn selected_publication_continues_from_its_revision_when_automation_is_later_enabled() {
    let mut f = Fixture::new();
    prepare(&mut f);
    let local = indexer::discover(&f.db, &f.project, "session")
        .unwrap()
        .remove(0);
    let mut request = input(&f);
    request["kind"] = json!("session");
    request["resourceId"] = local["resource"]["resourceId"].clone();
    request["previewToken"] =
        selective_sharing::preview(&f.db, &f.project, &request).unwrap()["previewToken"].clone();
    let receipt = selective_sharing::queue(&f.db, &f.project, &request).unwrap();
    // An explicit retry restores the identical frozen request after outbox cleanup.
    f.db.execute("DELETE FROM outbox", []).unwrap();
    assert_eq!(
        selective_sharing::queue(&f.db, &f.project, &request).unwrap(),
        receipt
    );
    let queued = db::rows(
        &f.db,
        "SELECT json_object('id',id,'project',project,'path',path,'value',json(value)) FROM outbox",
        &[],
    )
    .unwrap()
    .remove(0);
    let mut resource = queued["value"]["resource"].clone();
    resource["projectId"] = f.project["id"].clone();
    resource["revision"] = json!(1);
    resource["owner"] = db::get(&f.db, "user").unwrap();
    selective_sharing::complete(
        &f.db,
        &queued,
        &json!({"status":"published","receipt":{"event":{"resource":resource,"conflicts":[]}}}),
    )
    .unwrap();
    f.db.execute("DELETE FROM outbox", []).unwrap();
    let source = PathBuf::from(local["paths"][0].as_str().unwrap());
    let mut bytes = fs::read(&source).unwrap();
    bytes.extend_from_slice(b"{\"type\":\"response_item\",\"payload\":{\"type\":\"message\",\"role\":\"user\",\"content\":[{\"text\":\"New turn\"}]}}\n");
    fs::write(&source, &bytes).unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    assert!(f.outbox().is_empty());
    f.project["sharing"]["session"] = json!(true);
    db::upsert(
        &f.db,
        "projects",
        f.project["id"].as_str().unwrap(),
        "",
        &f.project,
    )
    .unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    let change = f
        .outbox()
        .into_iter()
        .find(|change| change["resource"]["resourceId"] == resource["resourceId"])
        .unwrap();
    assert_eq!(change["baseRevision"], 1);
    assert_ne!(change["resource"]["files"], resource["files"]);
    assert_eq!(fs::read(source).unwrap(), bytes);
}

#[test]
fn discovers_pi_session_when_its_cwd_is_a_symlink_to_the_project() {
    let mut f = Fixture::new();
    prepare(&mut f);
    f.db = db::open().unwrap();
    let link = f._home.path().join("linked-project");
    std::os::unix::fs::symlink(&f.root, &link).unwrap();
    let directory = crate::pi_sessions::directory().unwrap();
    fs::create_dir_all(&directory).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    fs::write(
        directory.join(format!("{id}.jsonl")),
        native::encode(&[
            json!({"type":"session","version":3,"id":id,"cwd":link}),
            json!({"type":"message","id":"a","parentId":null,"message":{"role":"user","content":"Symlinked project"}}),
        ]),
    )
    .unwrap();
    let pi: Vec<_> = indexer::discover(&f.db, &f.project, "session")
        .unwrap()
        .into_iter()
        .filter(|item| item["resource"]["source"] == "pi")
        .collect();
    assert_eq!(pi.len(), 1);
    assert_eq!(pi[0]["nativeId"], id);
}

#[test]
fn queued_shares_name_a_service_update_only_when_one_is_needed() {
    for error in [
        "Update the Orka service to support one-off sharing. The selected snapshot is queued on this Mac.",
        selective_sharing::PI_SERVICE_UPGRADE,
    ] {
        let receipt = selective_sharing::queued_receipt("request", error);
        assert_eq!(receipt["status"], "queued");
        assert_eq!(receipt["reason"], "unsupported");
    }
    for error in [
        "403: Permission denied",
        "409: Stale resource",
        "422: Invalid item",
    ] {
        assert_eq!(
            selective_sharing::queued_receipt("request", error)["reason"],
            "rejected"
        );
    }
    assert_eq!(
        selective_sharing::queued_receipt("request", "403: project_archived: Restore the project")
            ["reason"],
        "project_inactive"
    );
    for transient in [
        "401: Sign in required",
        "408: Timeout",
        "429: Busy",
        "503: Service unavailable",
    ] {
        assert!(selective_sharing::queued_receipt("request", transient)
            .get("reason")
            .is_none());
    }
    let offline =
        selective_sharing::queued_receipt("request", "Cloud unavailable; local work stays queued");
    assert_eq!(offline["status"], "queued");
    assert!(offline.get("reason").is_none());
}

#[test]
fn refused_selected_snapshot_keeps_its_frozen_bytes_and_requires_a_new_preview() {
    let mut f = Fixture::new();
    prepare(&mut f);
    let resource = indexer::discover(&f.db, &f.project, "session")
        .unwrap()
        .remove(0);
    let mut request = input(&f);
    request["kind"] = json!("session");
    request["resourceId"] = resource["resource"]["resourceId"].clone();
    let preview = selective_sharing::preview(&f.db, &f.project, &request).unwrap();
    request["previewToken"] = preview["previewToken"].clone();
    let first = selective_sharing::queue(&f.db, &f.project, &request).unwrap();
    let id = first["requestId"].as_str().unwrap();
    request["requireApproval"] = json!(true);
    assert!(selective_sharing::queue(&f.db, &f.project, &request)
        .unwrap_err()
        .contains("already queued"));
    let row = json!({"id":id, "path":selective_sharing::QUEUE_PATH});
    let error = "409: Resource path already exists; edit the accepted resource";
    assert!(!sync::record_upload_failure(&f.db, &row, error).unwrap());
    assert_eq!(f.outbox()[0]["resource"]["files"], preview["files"]);
    let saved: String =
        f.db.query_row("SELECT error FROM outbox WHERE id=?", [id], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(saved, error);
    assert!(selective_sharing::queue(&f.db, &f.project, &request)
        .unwrap_err()
        .contains("fresh share preview"));
    let next = selective_sharing::preview(&f.db, &f.project, &request).unwrap();
    assert_ne!(next["previewToken"], preview["previewToken"]);
    request["previewToken"] = next["previewToken"].clone();
    let reviewed = selective_sharing::queue(&f.db, &f.project, &request).unwrap();
    assert_eq!(reviewed["requestId"], id);
    assert_eq!(reviewed["requireApproval"], true);
    assert_ne!(reviewed["payloadHash"], first["payloadHash"]);
    assert_eq!(f.outbox().len(), 1);
}

#[test]
fn new_snapshots_use_creation_access_and_distinguish_an_unknown_rule() {
    let mut f = Fixture::new();
    prepare(&mut f);
    f.project["governed"] = json!(true);
    f.project["role"] = json!("member");
    let mut request = input(&f);
    let local = indexer::discover(&f.db, &f.project, "skill")
        .unwrap()
        .remove(0);
    request["kind"] = json!("skill");
    request["resourceId"] = local["resource"]["resourceId"].clone();
    let preview = || selective_sharing::preview(&f.db, &f.project, &request).unwrap();
    assert_eq!(preview()["publicationMode"], Value::Null);
    db::set(
        &f.db,
        &format!("governance:{}", f.project["id"].as_str().unwrap()),
        &json!({"access":{"skill":{"mode":"hidden","create":"publish"}}}),
    )
    .unwrap();
    let snapshot = preview();
    assert_eq!(snapshot["baseRevision"], 0);
    assert_eq!(snapshot["publicationMode"], "publish");
}

fn preview_memory(f: &Fixture, contents: &str, mut request: Value) -> Value {
    let dir = indexer::claude_memory(&f.root).unwrap();
    fs::create_dir_all(&dir).unwrap();
    fs::write(dir.join("MEMORY.md"), contents).unwrap();
    let local = indexer::discover(&f.db, &f.project, "memory")
        .unwrap()
        .into_iter()
        .find(|item| item["resource"]["source"] == "claude")
        .unwrap();
    request["kind"] = json!("memory");
    request["resourceId"] = local["resource"]["resourceId"].clone();
    request["previewToken"] =
        selective_sharing::preview_from_local(&f.db, &f.project, &request, &local).unwrap()
            ["previewToken"]
            .clone();
    request
}

fn enqueue_reviewed(f: &Fixture, request: &Value) -> Value {
    let receipt = selective_sharing::queue(&f.db, &f.project, request).unwrap();
    db::rows(&f.db, "SELECT json_object('id',id,'project',project,'path',path,'value',json(value)) FROM outbox WHERE id=?", &[&receipt["requestId"].as_str()]).unwrap().remove(0)
}

#[test]
fn corrected_share_retires_the_refusal_and_prevents_replay_of_an_obsolete_review() {
    for status in ["published", "approval_required", "conflict"] {
        let mut f = Fixture::new();
        prepare(&mut f);
        let mut initial = preview_memory(&f, "Original instructions", input(&f));
        initial["requireApproval"] = json!(true);
        let rejected = enqueue_reviewed(&f, &initial);
        assert_ne!(
            initial["resourceId"],
            rejected["value"]["resource"]["resourceId"]
        );
        sync::record_upload_failure(&f.db, &rejected, "409: Stale revision").unwrap();
        let obsolete = preview_memory(&f, "Original instructions", input(&f));

        // The same local memory can acquire a different publication ID through
        // an earlier promotion. Its local selection remains the same.
        db::upsert(&f.db, "drafts", "promotion", f.project["id"].as_str().unwrap(),
            &json!({"resource":{"resourceId":initial["resourceId"]},"submission":{"resource":{"resourceId":uuid::Uuid::new_v4()}}})).unwrap();
        let mut revised = preview_memory(&f, "Corrected instructions", input(&f));
        revised["requireApproval"] = json!(status == "approval_required");
        let queued = enqueue_reviewed(&f, &revised);
        assert_ne!(
            queued["value"]["resource"]["resourceId"],
            rejected["value"]["resource"]["resourceId"]
        );
        assert_eq!(f.outbox().len(), 2);
        let mut resource = queued["value"]["resource"].clone();
        resource["projectId"] = f.project["id"].clone();
        resource["revision"] = json!(1);
        let result = match status {
            "approval_required" => {
                json!({"status":status,"request":{"id":queued["id"],"resourceId":resource["resourceId"],"projectId":resource["projectId"]}})
            }
            "conflict" => {
                let mut accepted = resource.clone();
                accepted["files"] = rejected["value"]["resource"]["files"].clone();
                json!({"status":status,"receipt":{"event":{"resource":accepted,"conflicts":[{"id":queued["id"],"resourceId":resource["resourceId"],"candidate":resource,"revision":1}]}}})
            }
            _ => json!({"status":status,"receipt":{"event":{"resource":resource,"conflicts":[]}}}),
        };
        let tx = f.db.unchecked_transaction().unwrap();
        selective_sharing::complete(&tx, &queued, &result).unwrap();
        tx.execute("DELETE FROM outbox WHERE id=?", [queued["id"].as_str()])
            .unwrap();
        tx.commit().unwrap();

        assert!(
            f.outbox().is_empty(),
            "the earlier refusal still blocks Sync"
        );
        assert!(selective_sharing::authorized_origin(&f.db, &rejected)
            .unwrap()
            .is_none());
        assert!(selective_sharing::queue(&f.db, &f.project, &obsolete)
            .unwrap_err()
            .contains("fresh share preview"));
        // Deliberately restoring the former content and mapping is a new user action.
        f.db.execute("DELETE FROM drafts WHERE id='promotion'", [])
            .unwrap();
        let restored = preview_memory(&f, "Original instructions", input(&f));
        let replay = selective_sharing::queue(&f.db, &f.project, &restored).unwrap();
        assert_eq!(replay["requestId"], rejected["id"]);
        assert_eq!(replay["requireApproval"], true);
    }
}

#[test]
fn corrected_share_preserves_unrelated_waiting_held_and_more_recent_attempts() {
    let mut f = Fixture::new();
    prepare(&mut f);
    let fixed = "Snapshot eventually accepted";
    let refuse = |queued: &Value| {
        sync::record_upload_failure(&f.db, queued, "403: Permission denied").unwrap();
    };
    let first = enqueue_reviewed(&f, &preview_memory(&f, fixed, input(&f)));
    refuse(&first);
    let obsolete = enqueue_reviewed(&f, &preview_memory(&f, "Rejected edit", input(&f)));
    refuse(&obsolete);
    let mut keep = Vec::new();
    for (contents, error) in [
        (
            "Offline",
            Some("Cloud unavailable; local work stays queued"),
        ),
        ("Still queued", None),
        (
            "Waiting for restore",
            Some("403: project_archived: Restore the project"),
        ),
    ] {
        let pending = enqueue_reviewed(&f, &preview_memory(&f, contents, input(&f)));
        if let Some(error) = error {
            sync::record_upload_failure(&f.db, &pending, error).unwrap();
        }
        keep.push(pending["id"].clone());
    }
    for (key, other) in [
        ("accountId", "another-account"),
        ("serviceOrigin", "https://another.example"),
    ] {
        let mut scope = input(&f);
        scope[key] = json!(other);
        let pending = enqueue_reviewed(&f, &preview_memory(&f, "Another scope", scope));
        refuse(&pending);
        keep.push(pending["id"].clone());
    }
    let skill = indexer::discover(&f.db, &f.project, "skill")
        .unwrap()
        .remove(0);
    let mut request = input(&f);
    request["kind"] = json!("skill");
    request["resourceId"] = skill["resource"]["resourceId"].clone();
    request["previewToken"] =
        selective_sharing::preview_from_local(&f.db, &f.project, &request, &skill).unwrap()
            ["previewToken"]
            .clone();
    let other_item = enqueue_reviewed(&f, &request);
    refuse(&other_item);
    keep.push(other_item["id"].clone());

    let fresh = preview_memory(&f, fixed, input(&f));
    let retry = enqueue_reviewed(&f, &fresh);
    assert_eq!(retry["id"], first["id"]);
    let later = enqueue_reviewed(&f, &preview_memory(&f, "Later review", input(&f)));
    refuse(&later);
    keep.push(later["id"].clone());
    let count = f.outbox().len();
    let result = json!({"status":"approval_required","request":{"id":retry["id"],"resourceId":retry["value"]["resource"]["resourceId"],"projectId":retry["project"]}});
    let tx = f.db.unchecked_transaction().unwrap();
    selective_sharing::complete(&tx, &retry, &result).unwrap();
    tx.rollback().unwrap();
    assert_eq!(f.outbox().len(), count);
    let tx = f.db.unchecked_transaction().unwrap();
    selective_sharing::complete(&tx, &retry, &result).unwrap();
    tx.execute("DELETE FROM outbox WHERE id=?", [retry["id"].as_str()])
        .unwrap();
    tx.commit().unwrap();
    let pending = db::rows(
        &f.db,
        "SELECT json_quote(id) FROM outbox ORDER BY rowid",
        &[],
    )
    .unwrap();
    assert_eq!(pending, keep);
}
