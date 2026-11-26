// The normal desktop uses these same materialize, queue and receipt paths.
use super::*;

fn setup(base: &str, current: &str, local: &str, mode: &str) -> (Fixture, Value, PathBuf, PathBuf) {
    let mut f = governed_fixture();
    f.project["sharing"] = json!({"skill":true});
    db::upsert(
        &f.db,
        "projects",
        f.project["id"].as_str().unwrap(),
        "",
        &f.project,
    )
    .unwrap();
    let mut shared = shared(&f, "skill", "decision", base);
    shared["access"]["mode"] = json!(mode);
    persist(&f, &shared);
    sync::materialize(&f.db, &f.project, &shared).unwrap();
    let agents = f.root.join(".agents/skills/decision/SKILL.md");
    let claude = f.root.join(".claude/skills/decision/SKILL.md");
    fs::write(&claude, local).unwrap();
    shared["revision"] = json!(2);
    shared["files"][0]["hash"] = json!(db::blob(current.as_bytes()).unwrap());
    shared["files"][0]["size"] = json!(current.len());
    persist(&f, &shared);
    (f, shared, agents, claude)
}

const BASE: &str = "## References\n[guide]: https://example.test/guide\n";
const TEAM: &str =
    "## References\n[guide]: https://example.test/guide\n[team]: https://example.test/team\n";
const LOCAL: &str =
    "## References\n[guide]: https://example.test/guide\n[local]: https://example.test/local\n";

#[test]
fn skill_decision_queues_once_and_installs_only_after_exact_receipt() {
    let (f, mut shared, agents, claude) = setup(BASE, TEAM, LOCAL, "publish");
    let id = shared["resourceId"].as_str().unwrap().to_owned();
    assert_eq!(
        sync::materialize(&f.db, &f.project, &shared).unwrap_err(),
        crate::skill_reconciliation::LOCAL_EDITS
    );
    assert!(f.outbox().is_empty());
    crate::skill_reconciliation::queue_verified(&f.db, &f.project).unwrap();
    let row = db::rows(
        &f.db,
        "SELECT json_object('id',id,'project',project,'path',path,'value',json(value)) FROM outbox",
        &[],
    )
    .unwrap()
    .remove(0);
    assert_eq!(row["value"]["baseRevision"], 2);
    let mut legacy_wire = row["value"].clone();
    let fields = legacy_wire.as_object_mut().unwrap();
    for marker in ["skillImport", "contextDraft", "reviewRequired"] {
        fields.remove(marker);
    }
    let draft = governance::latest_draft(&f.db, f.project["id"].as_str().unwrap(), &id)
        .unwrap()
        .unwrap();
    assert_eq!(legacy_wire, draft["submission"]);
    assert_eq!(draft["automaticMergeRequestId"], row["id"]);
    let files = &row["value"]["resource"]["files"];
    let expected = format!("{TEAM}[local]: https://example.test/local\n");
    assert_eq!(
        db::blob_read(files[0]["hash"].as_str().unwrap()).unwrap(),
        expected.as_bytes()
    );
    assert_eq!(fs::read_to_string(&agents).unwrap(), BASE);
    assert_eq!(fs::read_to_string(&claude).unwrap(), LOCAL);
    assert_eq!(indexer::binding(&f.db, &id).unwrap()["base"]["revision"], 1);
    sync::materialize(&f.db, &f.project, &shared).unwrap();
    crate::skill_reconciliation::queue_verified(&f.db, &f.project).unwrap();
    assert_eq!(f.outbox(), vec![row["value"].clone()]);
    shared["revision"] = json!(3);
    shared["updatedBy"] = db::get(&f.db, "user").unwrap();
    assert!(crate::context_sharing::complete(
        &f.db,
        &row,
        &json!({"event":{"resource":shared,"conflicts":[]}})
    )
    .is_err());
    assert_eq!(fs::read_to_string(&claude).unwrap(), LOCAL);
    shared["files"] = files.clone();
    crate::context_sharing::complete(
        &f.db,
        &row,
        &json!({"event":{"resource":shared,"conflicts":[]}}),
    )
    .unwrap();
    f.db.execute("DELETE FROM outbox WHERE id=?", [row["id"].as_str()])
        .unwrap();
    sync::materialize(&f.db, &f.project, &shared).unwrap();
    assert_eq!(fs::read_to_string(&agents).unwrap(), expected);
    assert_eq!(fs::read_to_string(&claude).unwrap(), expected);
    assert_eq!(indexer::binding(&f.db, &id).unwrap()["base"]["revision"], 3);
}

#[test]
fn skill_decision_rechecks_role_sharing_head_live_mirrors_and_pending_work() {
    for condition in [
        "read",
        "suggest",
        "sharing_off",
        "legacy_sharing",
        "moved_head",
        "local_changed",
        "pending",
        "kept",
        "unopposed",
    ] {
        let mode = if matches!(condition, "read" | "suggest") {
            condition
        } else {
            "publish"
        };
        let baseline_current = if condition == "unopposed" { BASE } else { TEAM };
        let (mut f, mut shared, _, claude) = setup(BASE, baseline_current, LOCAL, mode);
        let id = shared["resourceId"].as_str().unwrap().to_owned();
        if condition == "kept" {
            let mut binding = indexer::binding(&f.db, &id).unwrap();
            binding["keptLocalSkill"] = json!({"revision":1});
            db::upsert(
                &f.db,
                "bindings",
                &id,
                f.project["id"].as_str().unwrap(),
                &binding,
            )
            .unwrap();
        }
        assert!(sync::materialize(&f.db, &f.project, &shared).is_err());
        match condition {
            "sharing_off" | "legacy_sharing" => {
                f.project["sharing"] = if condition == "sharing_off" {
                    json!({"skill":false})
                } else {
                    Value::Null
                };
                db::upsert(
                    &f.db,
                    "projects",
                    f.project["id"].as_str().unwrap(),
                    "",
                    &f.project,
                )
                .unwrap();
            }
            "moved_head" => {
                shared["revision"] = json!(3);
                persist(&f, &shared);
            }
            "local_changed" => fs::write(&claude, "Edited again.\n").unwrap(),
            "pending" => db::set(
                &f.db,
                &format!("requests:{}", f.project["id"].as_str().unwrap()),
                &json!([{"resourceId":id,"status":"pending"}]),
            )
            .unwrap(),
            _ => {}
        }
        crate::skill_reconciliation::queue_verified(&f.db, &f.project).unwrap();
        assert_eq!(
            f.outbox().len(),
            usize::from(condition == "unopposed"),
            "{condition}"
        );
    }
}

#[test]
fn skill_decision_holds_delayed_ack_and_keeps_later_local_edits() {
    let (f, mut shared, agents, claude) = setup(BASE, TEAM, LOCAL, "publish");
    assert!(sync::materialize(&f.db, &f.project, &shared).is_err());
    crate::skill_reconciliation::queue_verified(&f.db, &f.project).unwrap();
    let row = db::rows(
        &f.db,
        "SELECT json_object('id',id,'project',project,'path',path,'value',json(value)) FROM outbox",
        &[],
    )
    .unwrap()
    .remove(0);
    crate::context_sharing::check_upload_eligibility(&f.db, &row).unwrap();
    shared["access"]["mode"] = json!("suggest");
    persist(&f, &shared);
    assert!(crate::context_sharing::check_upload_eligibility(&f.db, &row).is_err());
    assert_eq!(f.outbox(), vec![row["value"].clone()]);
    shared["access"]["mode"] = json!("publish");
    shared["revision"] = json!(3);
    shared["updatedBy"] = db::get(&f.db, "user").unwrap();
    shared["files"] = row["value"]["resource"]["files"].clone();
    persist(&f, &shared);
    let _ = sync::materialize(&f.db, &f.project, &shared);
    assert_eq!(fs::read_to_string(&agents).unwrap(), BASE);
    assert_eq!(fs::read_to_string(&claude).unwrap(), LOCAL);
    let later = "A later local edit was never part of this request.\n";
    fs::write(&claude, later).unwrap();
    let mut incorrect = shared.clone();
    incorrect["title"] = json!("Unexpected receipt title");
    assert!(crate::context_sharing::complete(
        &f.db,
        &row,
        &json!({"event":{"resource":incorrect, "conflicts":[]}})
    )
    .is_err());
    crate::context_sharing::complete(
        &f.db,
        &row,
        &json!({"event":{"resource":shared,"conflicts":[]}}),
    )
    .unwrap();
    f.db.execute("DELETE FROM outbox WHERE id=?", [row["id"].as_str()])
        .unwrap();
    assert!(sync::materialize(&f.db, &f.project, &shared).is_err());
    assert_eq!(fs::read_to_string(claude).unwrap(), later);
    assert_eq!(fs::read_to_string(agents).unwrap(), BASE);
}

#[test]
fn skill_decision_settles_a_frozen_request_after_a_newer_deletion() {
    for accepted_before_delete in [false, true] {
        let (f, mut current, agents, claude) = setup(BASE, TEAM, LOCAL, "publish");
        let project = f.project["id"].as_str().unwrap();
        assert!(sync::materialize(&f.db, &f.project, &current).is_err());
        crate::skill_reconciliation::queue_verified(&f.db, &f.project).unwrap();
        let row = db::rows(&f.db,
            "SELECT json_object('id',id,'project',project,'path',path,'value',json(value)) FROM outbox", &[])
            .unwrap().remove(0);
        let mut accepted = current.clone();
        accepted["revision"] = json!(3);
        accepted["updatedBy"] = db::get(&f.db, "user").unwrap();
        accepted["files"] = row["value"]["resource"]["files"].clone();
        current["deleted"] = json!(true);
        current["revision"] = json!(4);
        current["files"] = json!([]);
        sync::apply_event(&f.db, &json!({"resource":current,"conflicts":[]})).unwrap();

        let tx = f.db.unchecked_transaction().unwrap();
        crate::context_sharing::check_upload_eligibility(&tx, &row).unwrap();
        if accepted_before_delete {
            crate::context_sharing::complete(
                &tx,
                &row,
                &json!({"event":{"resource":accepted,"conflicts":[]}}),
            )
            .unwrap();
            tx.execute("DELETE FROM outbox WHERE id=?", [row["id"].as_str()])
                .unwrap();
            tx.commit().unwrap();
        } else {
            tx.commit().unwrap();
            assert!(crate::skill_reconciliation::release_stale(
                &f.db,
                &row,
                "409: Resource changed; refresh and review the exact version again"
            )
            .unwrap());
        }

        let id = current["resourceId"].as_str().unwrap();
        assert!(f.outbox().is_empty());
        assert_eq!(governance::resource(&f.db, id).unwrap(), current);
        assert_eq!(fs::read_to_string(&claude).unwrap(), LOCAL);
        let draft = governance::latest_draft(&f.db, project, id)
            .unwrap()
            .unwrap();
        if accepted_before_delete {
            assert_eq!(draft["status"], "published");
        } else {
            assert_eq!(draft["lastRejectedSubmission"]["id"], row["id"]);
        }
        // The owner can now accept the deletion; their divergent edit is archived first.
        let preview = command(&f, "preview-install", json!({"resourceId":id})).unwrap();
        command(
            &f,
            "apply-install",
            json!({"resourceId":id,"token":preview["token"],"preserveLocal":true}),
        )
        .unwrap();
        assert!(!agents.exists() && !claude.exists());
    }
}

#[test]
fn skill_decision_migrates_old_outbox_metadata_and_retries_the_original_id() {
    let (f, current, _, _) = setup(BASE, TEAM, LOCAL, "publish");
    let project = f.project["id"].as_str().unwrap();
    assert!(sync::materialize(&f.db, &f.project, &current).is_err());
    crate::skill_reconciliation::queue_verified(&f.db, &f.project).unwrap();
    let frozen = f.outbox().remove(0);
    f.db.execute(
        "UPDATE drafts SET value=json_remove(value,'$.automaticMergeRequestId')",
        [],
    )
    .unwrap();
    f.db.execute("UPDATE outbox SET value=json_set(value,'$.automaticSkillMerge', json('true')), error='400: Invalid request'", []).unwrap();
    for _ in 0..2 {
        crate::context_sharing::reconcile_skill_requests(&f.db, project).unwrap();
        assert_eq!(f.outbox(), vec![frozen.clone()]);
        let row = db::rows(&f.db, "SELECT json_object('id',id,'path',path,'project',project,'value',json(value),'error',error) FROM outbox", &[]).unwrap().remove(0);
        assert!(row["error"].is_null());
        assert!(crate::context_sharing::automatic_skill_request(&f.db, &row).unwrap());
        assert!(
            command(&f, "refresh-draft", json!({"id":frozen["skillImport"]}))
                .unwrap_err()
                .contains("queued")
        );
    }
    // The base desktop parses the new body and may receive a real stale
    // rejection. Returning to the newer desktop must release that terminal row.
    f.db.execute(
        "UPDATE outbox SET error=?1",
        [crate::sync::EXACT_REVISION_CONFLICT],
    )
    .unwrap();
    crate::context_sharing::reconcile_skill_requests(&f.db, project).unwrap();
    assert!(f.outbox().is_empty());
}

#[test]
fn skill_decision_resumes_only_the_exact_proposal_route_frozen_by_an_older_desktop() {
    let (f, mut current, _, claude) = setup(BASE, TEAM, LOCAL, "publish");
    let project = f.project["id"].as_str().unwrap();
    let owner = db::get(&f.db, "user").unwrap();
    let owner = owner.as_str().unwrap();
    assert!(sync::materialize(&f.db, &f.project, &current).is_err());
    crate::skill_reconciliation::queue_verified(&f.db, &f.project).unwrap();
    let mut row = db::rows(
        &f.db,
        "SELECT json_object('id',id,'path',path,'project',project,'value',json(value)) FROM outbox",
        &[],
    )
    .unwrap()
    .remove(0);
    let change = row["value"].clone();
    let proposal = json!({"id":row["id"],"type":"change","projectId":project,"resourceId":current["resourceId"],
        "author":owner,"status":"pending","baseRevision":current["revision"],
        "previewHash":db::digest(change["resource"].to_string().as_bytes())});
    db::set(
        &f.db,
        &format!("governance:{project}"),
        &json!({"requests":[proposal]}),
    )
    .unwrap();
    current["access"]["mode"] = json!("suggest");
    persist(&f, &current);
    assert!(crate::context_sharing::check_upload_eligibility(&f.db, &row).is_err());
    assert!(
        crate::context_sharing::frozen_skill_proposal(&f.db, &row, owner)
            .unwrap()
            .is_none()
    );
    assert!(crate::context_sharing::complete(&f.db, &row, &json!({"proposal":proposal})).is_err());
    row["value"]["reviewRequired"] = json!(true);
    f.db.execute("UPDATE outbox SET value=?", [row["value"].to_string()])
        .unwrap();
    crate::context_sharing::check_upload_eligibility(&f.db, &row).unwrap();
    for (field, value) in [
        ("previewHash", json!("different")),
        ("id", json!("different")),
        ("author", json!("another")),
        ("baseRevision", json!(0)),
    ] {
        let mut wrong = proposal.clone();
        wrong[field] = value;
        assert!(crate::context_sharing::complete(&f.db, &row, &json!({"proposal":wrong})).is_err());
    }
    let receipt = crate::context_sharing::frozen_skill_proposal(&f.db, &row, owner)
        .unwrap()
        .unwrap();
    crate::context_sharing::complete(&f.db, &row, &receipt).unwrap();
    let draft = || {
        governance::latest_draft(&f.db, project, current["resourceId"].as_str().unwrap())
            .unwrap()
            .unwrap()
    };
    assert_eq!(draft()["status"], "proposed");
    let mut approved = proposal;
    approved["status"] = json!("approved");
    crate::context_sharing::complete(&f.db, &row, &json!({"proposal":approved})).unwrap();
    assert_eq!(draft()["status"], "published");
    assert_eq!(fs::read_to_string(claude).unwrap(), LOCAL);
}

#[test]
fn skill_decision_recovers_the_exact_outbox_after_an_older_draft_refresh() {
    let (f, current, _, _) = setup(BASE, TEAM, LOCAL, "publish");
    let project = f.project["id"].as_str().unwrap();
    assert!(sync::materialize(&f.db, &f.project, &current).is_err());
    crate::skill_reconciliation::queue_verified(&f.db, &f.project).unwrap();
    let original = f.outbox().remove(0);
    let draft = || {
        governance::latest_draft(&f.db, project, current["resourceId"].as_str().unwrap())
            .unwrap()
            .unwrap()
    };
    let frozen = draft()["submission"].clone();
    f.db.execute("UPDATE drafts SET value=json_set(value,'$.submission',null,'$.requestId',null,'$.request',null,'$.status','local')", []).unwrap();
    crate::context_sharing::reconcile_skill_requests(&f.db, project).unwrap();
    assert_eq!(draft()["submission"], frozen);
    assert_eq!(draft()["requestId"], original["id"]);
    f.db.execute(
        "UPDATE outbox SET error=?1",
        [sync::EXACT_REVISION_CONFLICT],
    )
    .unwrap();
    f.db.execute(
        "UPDATE drafts SET value=json_set(value,'$.submission.id','newer','$.requestId','newer')",
        [],
    )
    .unwrap();
    crate::context_sharing::reconcile_skill_requests(&f.db, project).unwrap();
    assert_eq!(draft()["requestId"], "newer");
    assert_eq!(f.outbox(), vec![original]);
    f.db.execute(
        "UPDATE drafts SET value=json_remove(value,'$.submission','$.requestId')",
        [],
    )
    .unwrap();
    crate::context_sharing::reconcile_skill_requests(&f.db, project).unwrap();
    assert!(f.outbox().is_empty());
    assert_eq!(draft()["lastRejectedSubmission"], frozen);
}

#[test]
fn skill_decision_retries_a_server_publish_denial_only_after_access_returns() {
    let (f, mut current, _, _) = setup(BASE, TEAM, LOCAL, "publish");
    let project = f.project["id"].as_str().unwrap();
    assert!(sync::materialize(&f.db, &f.project, &current).is_err());
    crate::skill_reconciliation::queue_verified(&f.db, &f.project).unwrap();
    let original = f.outbox().remove(0);
    f.db.execute("UPDATE outbox SET error=?", [sync::PUBLISH_DENIED])
        .unwrap();
    let error = || {
        f.db.query_row("SELECT error FROM outbox", [], |row| {
            row.get::<_, Option<String>>(0)
        })
        .unwrap()
    };
    current["access"]["mode"] = json!("suggest");
    persist(&f, &current);
    crate::context_sharing::reconcile_skill_requests(&f.db, project).unwrap();
    assert_eq!(error().as_deref(), Some(sync::PUBLISH_DENIED));
    current["access"]["mode"] = json!("publish");
    persist(&f, &current);
    crate::context_sharing::reconcile_skill_requests(&f.db, project).unwrap();
    assert_eq!(error(), None);
    assert_eq!(f.outbox(), vec![original.clone()]);
    assert!(original["reviewRequired"].is_null());
    f.db.execute("UPDATE outbox SET error='403: Receipt access denied'", [])
        .unwrap();
    crate::context_sharing::reconcile_skill_requests(&f.db, project).unwrap();
    assert_eq!(error().as_deref(), Some("403: Receipt access denied"));
}

#[test]
fn skill_decision_recovers_definitive_stale_rejection_without_replacing_transport_retries() {
    let (f, mut shared, agents, claude) = setup(BASE, TEAM, LOCAL, "publish");
    assert!(sync::materialize(&f.db, &f.project, &shared).is_err());
    crate::skill_reconciliation::queue_verified(&f.db, &f.project).unwrap();
    let row = db::rows(
        &f.db,
        "SELECT json_object('id',id,'project',project,'path',path,'value',json(value)) FROM outbox",
        &[],
    )
    .unwrap()
    .remove(0);
    let refresh = command(
        &f,
        "refresh-draft",
        json!({"id":row["value"]["skillImport"]}),
    );
    assert!(refresh.unwrap_err().contains("queued"));
    for uncertain in [
        "request timed out",
        "409: Retry ID reused with different content",
        "403: Receipt access denied",
    ] {
        assert!(!crate::skill_reconciliation::release_stale(&f.db, &row, uncertain).unwrap());
        assert_eq!(f.outbox(), vec![row["value"].clone()]);
    }
    assert!(crate::skill_reconciliation::release_stale(
        &f.db,
        &row,
        "409: Resource changed; refresh and review the exact version again"
    )
    .unwrap());
    assert!(f.outbox().is_empty());
    crate::skill_reconciliation::queue_verified(&f.db, &f.project).unwrap();
    assert!(f.outbox().is_empty());
    let draft = db::rows(
        &f.db,
        "SELECT value FROM drafts WHERE id=?",
        &[&row["value"]["skillImport"].as_str()],
    )
    .unwrap()
    .remove(0);
    assert_eq!(draft["lastRejectedSubmission"]["id"], row["id"]);
    assert_eq!(
        draft["lastRejectedSubmission"]["resource"],
        row["value"]["resource"]
    );
    shared["revision"] = json!(3);
    persist(&f, &shared);
    assert!(sync::materialize(&f.db, &f.project, &shared).is_err());
    crate::skill_reconciliation::queue_verified(&f.db, &f.project).unwrap();
    assert_eq!(f.outbox().len(), 1);
    assert_eq!(f.outbox()[0]["baseRevision"], 3);
    assert_ne!(f.outbox()[0]["id"], row["id"]);
    assert_eq!(fs::read_to_string(claude).unwrap(), LOCAL);
    assert_eq!(fs::read_to_string(agents).unwrap(), BASE);
}

#[test]
fn skill_decision_holds_cross_file_edits_modes_blank_files_and_ambiguous_references() {
    let _f = Fixture::new();
    let file = |path: &str, text: &str| json!({"path":path,"hash":db::blob(text.as_bytes()).unwrap(),"size":text.len(),"executable":false});
    let base = json!([file("SKILL.md", BASE), file("notes.md", "original")]);
    let team = json!([file("SKILL.md", TEAM), file("notes.md", "original")]);
    let local = json!([file("SKILL.md", LOCAL), file("notes.md", "original")]);
    assert!(crate::skill_decision::candidate(&base, &team, [&base, &local].into_iter()).is_some());
    let mut mode = local.clone();
    mode[0]["executable"] = json!(true);
    let added = json!([
        file("SKILL.md", LOCAL),
        file("new.md", "new"),
        file("notes.md", "original")
    ]);
    for blocked in [
        mode,
        added,
        json!([
            file("SKILL.md", BASE),
            file("notes.md", "Use the old team link.")
        ]),
        json!([
            file(
                "SKILL.md",
                &format!("{BASE}[TEAM]: https://other.test/team\n")
            ),
            file("notes.md", "original")
        ]),
    ] {
        assert!(
            crate::skill_decision::candidate(&base, &team, [&base, &blocked].into_iter()).is_none()
        );
    }
    let empty = json!([file("SKILL.md", ""), file("notes.md", "original")]);
    assert!(crate::skill_decision::candidate(&base, &base, [&base, &empty].into_iter()).is_none());
}

#[test]
fn skill_decision_format_specs_require_the_entire_package() {
    let _f = Fixture::new();
    let manifest = |input: &str, output: &str| {
        let body = format!("Input format: {input}\nOutput format: {output}\n");
        json!([
            {"path":"SKILL.md","hash":db::blob(body.as_bytes()).unwrap(),"size":body.len(),"executable":false},
            {"path":"verify.md","hash":db::blob(b"Reject XML.").unwrap(),"size":11,"executable":false}
        ])
    };
    let base = manifest("CSV", "JSON");
    let shared = manifest("CSV", "XML");
    let local = manifest("TSV", "JSON");
    assert!(
        crate::skill_decision::candidate(&base, &shared, [&base, &local].into_iter()).is_none()
    );
}

#[test]
fn skill_decision_reconsiders_old_private_preview_but_preserves_rejection() {
    for rejected in [false, true] {
        let (f, current, _, _) = setup(
            "title = \"Review\"\n\n# Output\nReturn YAML.",
            "title = \"Parse\"\n\n# Output\nReturn YAML.",
            "title = \"Review\"\n\n# Output\nReturn CSV.",
            "publish",
        );
        let id = current["resourceId"].as_str().unwrap();
        assert!(sync::materialize(&f.db, &f.project, &current).is_err());
        // Existing installations can have this exact private preview from
        // the previous policy's generic three-way merge.
        f.db.execute(
            "UPDATE bindings SET value=json_set(value,'$.skillDecisionVersion',1) WHERE id=?",
            [id],
        )
        .unwrap();
        f.db.execute(
            "UPDATE drafts SET value=json_set(value,'$.automaticMergeCandidate',json('false'))",
            [],
        )
        .unwrap();
        if rejected {
            f.db.execute(
                "UPDATE drafts SET value=json_set(value,'$.lastRejectedSubmission',json('{}'))",
                [],
            )
            .unwrap();
        }
        assert!(sync::materialize(&f.db, &f.project, &current).is_err());
        crate::skill_reconciliation::queue_verified(&f.db, &f.project).unwrap();
        assert_eq!(f.outbox().len(), usize::from(!rejected));
    }
}

/// Replays frozen synthetic skill rows against native materialization and the actual publish queue.
/// Input fixtures are trusted test data. The destination contains the synthetic candidate text.
#[test]
#[ignore = "requires ORKA_SKILL_BACKTEST_INPUT and ORKA_SKILL_BACKTEST_OUTPUT"]
fn skill_decision_backtest() {
    let input =
        std::env::var("ORKA_SKILL_BACKTEST_INPUT").expect("Set the frozen synthetic input file");
    let output =
        std::env::var("ORKA_SKILL_BACKTEST_OUTPUT").expect("Set the benchmark result destination");
    let rows: Vec<Value> = serde_json::from_slice(&fs::read(input).unwrap()).unwrap();
    let mut reports = Vec::new();
    for row in rows {
        if row["kind"] != "skill" {
            continue;
        }
        let ctx = &row["context"];
        let mut report =
            json!({"id":row["id"],"kind":"skill","disposition":"review","candidate":null});
        if ctx["resource_deleted"] == true
            || ctx["encoding"] != "utf-8"
            || ctx["current_rev"] != ctx["observed_rev"]
            || ctx["base_executable"] != ctx["current_executable"]
            || ctx["base_executable"] != ctx["incoming_executable"]
            || ctx["trusted_base"] != true
            || ctx["auto_share"] != true
            || ctx["publish"] != true
        {
            report["disposition"] = json!("excluded");
            reports.push(report);
            continue;
        }
        let (f, shared, agents, claude) = setup(
            row["base"].as_str().unwrap(),
            row["current"].as_str().unwrap(),
            row["incoming"].as_str().unwrap(),
            "publish",
        );
        let installed = sync::materialize(&f.db, &f.project, &shared).is_ok();
        crate::skill_reconciliation::queue_verified(&f.db, &f.project).unwrap();
        let queued = f.outbox();
        if let Some(request) = queued.first() {
            assert_eq!(queued.len(), 1);
            report["disposition"] = json!("queued");
            report["candidate"] = json!(String::from_utf8(
                db::blob_read(request["resource"]["files"][0]["hash"].as_str().unwrap()).unwrap()
            )
            .unwrap());
        } else if installed {
            let a = fs::read_to_string(agents).unwrap();
            assert_eq!(a, fs::read_to_string(claude).unwrap());
            report["disposition"] = json!("installed");
            report["candidate"] = json!(a);
        } else if let Some(draft) = db::rows(
            &f.db,
            "SELECT value FROM drafts WHERE json_extract(value,'$.status')='local'",
            &[],
        )
        .unwrap()
        .first()
        {
            report["candidate"] = json!(String::from_utf8(
                db::blob_read(draft["resource"]["files"][0]["hash"].as_str().unwrap()).unwrap()
            )
            .unwrap());
        }
        reports.push(report);
    }
    fs::write(output, serde_json::to_vec_pretty(&reports).unwrap()).unwrap();
}
