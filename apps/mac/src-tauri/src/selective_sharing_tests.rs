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
    let records = crate::history::resource_records(resource).unwrap();
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
    request["previewToken"] = preview["previewToken"].clone();
    assert_eq!(
        selective_sharing::queue(&f.db, &f.project, &request).unwrap()["status"],
        "queued"
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
