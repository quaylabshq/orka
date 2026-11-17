use super::*;
use crate::plans;

fn write_session(f: &Fixture, source: &str, id: &str, records: &[Value]) -> PathBuf {
    let directory = if source == "codex" {
        native::codex_home().unwrap().join("sessions")
    } else {
        native::claude_home().unwrap().join("projects/test")
    };
    fs::create_dir_all(&directory).unwrap();
    let path = directory.join(if source == "codex" {
        format!("rollout-{id}.jsonl")
    } else {
        format!("{id}.jsonl")
    });
    let metadata = if source == "codex" {
        json!({"type":"session_meta","payload":{"id":id,"cwd":f.root,"cli_version":"0.159.2","history_mode":"legacy","source":"cli"}})
    } else {
        json!({"type":"user","cwd":f.root,"sessionId":id,"version":"2.1.286","message":{"role":"user","content":"Build this feature"}})
    };
    let records = std::iter::once(metadata)
        .chain(records.iter().cloned())
        .collect::<Vec<_>>();
    fs::write(&path, native::encode(&records)).unwrap();
    path
}

fn resources(f: &Fixture) -> Vec<Value> {
    f.resources()
        .into_iter()
        .filter(|r| r["kind"] == "plan")
        .collect()
}

fn session_project(f: &Fixture) -> Value {
    let mut project = f.project.clone();
    project["sharing"] =
        json!({"memory":false,"skill":false,"session":true,"plan":false,"env":false});
    project
}

#[test]
fn negative_history_cache_skips_unchanged_unrelated_transcripts() {
    let f = Fixture::new();
    let project = session_project(&f);
    let mut paths = Vec::new();
    for tool in ["claude", "codex"] {
        let path = write_session(&f, tool, &uuid::Uuid::new_v4().to_string(), &[]);
        let bytes = fs::read_to_string(&path).unwrap().replace(
            f.root.to_str().unwrap(),
            f.root.with_file_name("outside").to_str().unwrap(),
        );
        fs::write(&path, &bytes).unwrap();
        if tool == "codex" {
            let compressed = path.with_extension("jsonl.zst");
            fs::write(
                &compressed,
                zstd::stream::encode_all(bytes.as_bytes(), 0).unwrap(),
            )
            .unwrap();
            paths.push((compressed, (0, 1)));
        }
        paths.push((path, if tool == "claude" { (1, 0) } else { (0, 1) }));
    }
    for _ in 0..2 {
        indexer::scan(&f.db, &project).unwrap();
        assert!(f.resources().is_empty());
        assert!(f.outbox().is_empty());
        for (path, expected) in &paths {
            assert_eq!(
                crate::history::read_counts(path),
                *expected,
                "{}",
                path.display()
            );
        }
    }
}

#[test]
fn negative_history_cache_rechecks_same_size_edits_with_newer_mtime() {
    use std::time::{Duration, UNIX_EPOCH};
    let f = Fixture::new();
    let project = session_project(&f);
    for tool in ["claude", "codex"] {
        let path = write_session(&f, tool, &uuid::Uuid::new_v4().to_string(), &[]);
        let related = fs::read_to_string(&path).unwrap();
        let unrelated = related.replace(
            f.root.to_str().unwrap(),
            f.root.with_file_name("outside").to_str().unwrap(),
        );
        assert_eq!(related.len(), unrelated.len());
        fs::write(&path, unrelated).unwrap();
        let file = fs::File::open(&path).unwrap();
        let before = UNIX_EPOCH + Duration::new(1_700_000_000, 10);
        let after = UNIX_EPOCH + Duration::new(1_700_000_000, 11);
        file.set_times(fs::FileTimes::new().set_modified(before))
            .unwrap();
        indexer::scan(&f.db, &project).unwrap();
        assert!(!f.resources().iter().any(|r| r["source"] == tool));
        fs::write(&path, related).unwrap();
        file.set_times(fs::FileTimes::new().set_modified(after))
            .unwrap();
        assert_eq!(file.metadata().unwrap().modified().unwrap(), after);
        indexer::scan(&f.db, &project).unwrap();
        assert_eq!(
            f.resources().iter().filter(|r| r["source"] == tool).count(),
            1
        );
    }
}

#[test]
fn negative_history_cache_keeps_related_sessions_on_repeated_scans() {
    let f = Fixture::new();
    let project = session_project(&f);
    for tool in ["claude", "codex"] {
        write_session(&f, tool, &uuid::Uuid::new_v4().to_string(), &[]);
    }
    indexer::scan(&f.db, &project).unwrap();
    let resources = f.resources();
    let outbox = f.outbox();
    assert_eq!(resources.len(), 2);
    indexer::scan(&f.db, &project).unwrap();
    assert_eq!(f.resources(), resources);
    assert_eq!(f.outbox(), outbox);
    let first = indexer::discover(&f.db, &project, "session").unwrap();
    let second = indexer::discover(&f.db, &project, "session").unwrap();
    assert_eq!(second.len(), 2);
    for (before, after) in first.iter().zip(&second) {
        assert_eq!(before["resource"], after["resource"]);
        assert_eq!(before["updatedAt"], after["updatedAt"]);
    }
}

#[test]
fn negative_history_cache_scopes_results_to_each_source() {
    let f = Fixture::new();
    let other = f.root.with_file_name("outside");
    fs::create_dir(&other).unwrap();
    let mut project = session_project(&f);
    project["sources"] = json!([
        {"id":"first","path":f.root}, {"id":"second","path":other}
    ]);
    for root in [&f.root, &other] {
        for tool in ["claude", "codex"] {
            let path = write_session(&f, tool, &uuid::Uuid::new_v4().to_string(), &[]);
            let bytes = fs::read_to_string(&path)
                .unwrap()
                .replace(f.root.to_str().unwrap(), root.to_str().unwrap());
            fs::write(path, bytes).unwrap();
        }
    }
    indexer::scan(&f.db, &project).unwrap();
    let first = f.resources();
    assert_eq!(first.len(), 4);
    indexer::scan(&f.db, &project).unwrap();
    assert_eq!(f.resources(), first);
    for source in ["first", "second"] {
        assert_eq!(first.iter().filter(|r| r["sourceId"] == source).count(), 2);
    }
}

#[test]
fn negative_history_cache_rechecks_changed_root_and_source() {
    let f = Fixture::new();
    let other = f.root.with_file_name("outside");
    fs::create_dir(&other).unwrap();
    let mut project = session_project(&f);
    let path = write_session(&f, "claude", &uuid::Uuid::new_v4().to_string(), &[]);
    let bytes = fs::read_to_string(&path)
        .unwrap()
        .replace(f.root.to_str().unwrap(), other.to_str().unwrap());
    fs::write(&path, bytes).unwrap();
    indexer::scan(&f.db, &project).unwrap();
    project["sourceId"] = json!("another-source");
    indexer::scan(&f.db, &project).unwrap();
    assert_eq!(crate::history::read_counts(&path), (2, 0));
    assert!(f.resources().is_empty());
    project["path"] = json!(other);
    indexer::scan(&f.db, &project).unwrap();
    assert_eq!(f.resources().len(), 1);
}

#[test]
fn plan_only_scan_skips_unrelated_codex_histories_before_parsing_their_bodies() {
    let f = Fixture::new();
    let mut project = f.project.clone();
    project["sharing"] =
        json!({"memory":false,"skill":false,"session":false,"plan":true,"env":false});
    let id = uuid::Uuid::new_v4().to_string();
    write_session(
        &f,
        "codex",
        &id,
        &[
            json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"<proposed_plan># Keep this plan</proposed_plan>"}]}}),
        ],
    );
    let directory = native::codex_home().unwrap().join("sessions");
    let mut unrelated = native::encode(&[
        json!({"type":"session_meta","payload":{"id":uuid::Uuid::new_v4().to_string(),"cwd":f.root.with_file_name("project-other")}}),
        json!({"type":"event_msg","payload":{"message":"x".repeat(1024 * 1024)}}),
    ]);
    // Past the attribution prefix: parsing the entire body must fail.
    unrelated.extend_from_slice(b"not JSON\n");
    let mut originals = Vec::new();
    for extension in ["jsonl", "jsonl.zst"] {
        let path = directory.join(format!("unrelated.{extension}"));
        let bytes = if extension.ends_with("zst") {
            zstd::stream::encode_all(&unrelated[..], 0).unwrap()
        } else {
            unrelated.clone()
        };
        fs::write(&path, &bytes).unwrap();
        let source = format!(
            "{}{}",
            crate::history::UNATTRIBUTED_SESSION_PREFIX,
            path.display()
        );
        f.db.execute(
            "INSERT INTO errors VALUES(?,?)",
            [&source, crate::history::UNATTRIBUTED_SESSION_ERROR],
        )
        .unwrap();
        originals.push((path, bytes));
    }
    indexer::scan(&f.db, &project).unwrap();
    assert_eq!(
        db::rows(&f.db, "SELECT json_object('error',error) FROM errors", &[]).unwrap(),
        Vec::<Value>::new(),
        "unrelated bodies must not be parsed and stale attribution errors must clear"
    );
    let plans = resources(&f);
    assert_eq!(plans.len(), 1);
    assert_eq!(plans[0]["title"], "Keep this plan");
    assert!(!f
        .resources()
        .iter()
        .any(|resource| resource["kind"] == "session"));
    for (path, bytes) in originals {
        assert_eq!(fs::read(path).unwrap(), bytes);
    }
}

#[test]
fn codex_scan_falls_back_when_metadata_exceeds_the_attribution_prefix() {
    let f = Fixture::new();
    for extension in ["jsonl", "jsonl.zst"] {
        let id = uuid::Uuid::new_v4().to_string();
        let path = write_session(
            &f,
            "codex",
            &id,
            &[
                json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"<proposed_plan># Bounded Codex plan</proposed_plan>"}]}}),
            ],
        );
        let mut records = native::complete_records(&fs::read(&path).unwrap()).unwrap();
        records[0]["payload"]["padding"] = json!("x".repeat(1024 * 1024));
        let mut bytes = native::encode(&records);
        let target = path.with_extension(extension);
        if extension.ends_with("zst") {
            bytes = zstd::stream::encode_all(&bytes[..], 0).unwrap();
            fs::remove_file(&path).unwrap();
        }
        fs::write(&target, &bytes).unwrap();
        assert_eq!(crate::history::session_cwd_prefix(&target, "codex"), None);
    }
    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(resources(&f).len(), 2);
    assert_eq!(
        f.resources()
            .iter()
            .filter(|r| r["kind"] == "session")
            .count(),
        2
    );
    assert!(db::rows(&f.db, "SELECT json_quote(error) FROM errors", &[])
        .unwrap()
        .is_empty());
}

#[test]
fn codex_scan_preserves_errors_when_prefix_attribution_is_unknown() {
    let f = Fixture::new();
    let directory = native::codex_home().unwrap().join("sessions");
    fs::create_dir_all(&directory).unwrap();
    fs::write(directory.join("corrupt.jsonl"), b"not JSON\n").unwrap();
    fs::write(
        directory.join("missing-metadata.jsonl"),
        native::encode(&[json!({"type":"event_msg","payload":{"cwd":f.root}})]),
    )
    .unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    let errors = db::rows(
        &f.db,
        "SELECT json_quote(error) FROM errors ORDER BY error",
        &[],
    )
    .unwrap();
    assert_eq!(
        errors,
        vec![
            json!("Missing initial Codex session metadata"),
            json!("Unknown or corrupt native transcript; source preserved"),
        ]
    );
    assert!(f.resources().is_empty());
    assert!(f.outbox().is_empty());
}

#[test]
fn claude_scan_uses_authoritative_metadata_after_the_attribution_prefix() {
    let f = Fixture::new();
    let id = uuid::Uuid::new_v4().to_string();
    let directory = native::claude_home().unwrap().join("projects/test");
    fs::create_dir_all(&directory).unwrap();
    let path = directory.join(format!("{id}.jsonl"));
    let bytes = native::encode(&[
        json!({"type":"attachment","sessionId":id,"cwd":f.root.with_file_name("other-project")}),
        json!({"type":"progress","message":"x".repeat(1024 * 1024)}),
        json!({"type":"user","sessionId":id,"cwd":f.root,"message":{"role":"user","content":"Make a plan"}}),
        json!({"type":"assistant","sessionId":id,"message":{"content":[{"type":"tool_use","name":"ExitPlanMode","input":{"plan":"# Claude after prefix"}}]}}),
    ]);
    fs::write(&path, &bytes).unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(resources(&f).len(), 1);
    assert_eq!(resources(&f)[0]["title"], "Claude after prefix");
    assert_eq!(fs::read(path).unwrap(), bytes);
}

#[test]
fn paginated_plans_read_all_segments_and_keep_incomplete_history_intact() {
    let f = Fixture::new();
    let (_, paths) = segmented_chain(&f);
    let mut previous_size = 0;
    for (index, path) in paths.iter().enumerate() {
        let mut records = native::complete_records(&fs::read(path).unwrap()).unwrap();
        if index > 0 {
            records[0]["payload"]["history_base"]["end_byte_offset"] = json!(previous_size);
        }
        let assistant = records
            .iter_mut()
            .find(|record| {
                record["type"] == "response_item" && record["payload"]["role"] == "assistant"
            })
            .unwrap();
        assistant["payload"]["content"][0]["text"] = json!(format!(
            "<proposed_plan># Segment {index} proposal\n\nComplete plan.</proposed_plan>"
        ));
        if index == 2 {
            let ordinal = records.last().unwrap()["ordinal"].as_u64().unwrap() + 1;
            records.push(json!({"type":"event_msg","ordinal":ordinal,"payload":{"type":"plan_update","plan":[{"step":"Verify","status":"completed"}]}}));
        }
        let bytes = native::encode(&records);
        previous_size = bytes.len();
        fs::write(path, bytes).unwrap();
    }
    let originals = paths
        .iter()
        .map(|path| fs::read(path).unwrap())
        .collect::<Vec<_>>();
    indexer::scan(&f.db, &f.project).unwrap();
    let plans = resources(&f);
    assert_eq!(plans.len(), 2);
    assert!(plans
        .iter()
        .any(|plan| plan["title"] == "Segment 2 proposal"));
    let progress = plans
        .iter()
        .find(|plan| plan["title"] == "Plan progress")
        .unwrap();
    assert!(String::from_utf8(
        db::blob_read(progress["files"][0]["hash"].as_str().unwrap()).unwrap()
    )
    .unwrap()
    .contains("- [x] Verify"));
    for (path, original) in paths.iter().zip(&originals) {
        assert_eq!(fs::read(path).unwrap(), *original);
    }
    f.db.execute("DELETE FROM outbox", []).unwrap();
    let mut incomplete = originals[2].clone();
    incomplete.extend_from_slice(b"{\"type\":");
    fs::write(&paths[2], &incomplete).unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(resources(&f).len(), 2);
    assert!(f.outbox().is_empty());
    assert_eq!(fs::read(&paths[2]).unwrap(), incomplete);
}

#[test]
fn embedded_plans_use_only_provider_output_and_latest_complete_updates() {
    let records = vec![
        json!({"type":"response_item","payload":{"type":"message","role":"developer","content":[{"text":"<proposed_plan>Private instructions</proposed_plan>"}]}}),
        json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"text":"<proposed_plan>User example</proposed_plan>"}]}}),
        json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"text":"<proposed_plan># Initial plan</proposed_plan>"}]}}),
        json!({"type":"response_item","payload":{"type":"function_call","name":"functions.update_plan","arguments":json!({"explanation":"Start work","plan":[{"step":"Design","status":"completed"},{"step":"Implement","status":"in_progress"},{"step":"Test","status":"pending"}]}).to_string()}}),
        json!({"type":"event_msg","payload":{"type":"item_completed","item":{"type":"Plan","text":"# Final proposal\n\nShip the feature."}}}),
        json!({"type":"response_item","payload":{"type":"function_call","name":"update_plan","arguments":"not JSON"}}),
        json!({"type":"event_msg","payload":{"type":"agent_message","message":"<proposed_plan>Incomplete"}}),
    ];
    let plans = plans::embedded("codex", &records);
    assert_eq!(plans.len(), 2);
    assert_eq!(
        plans[0],
        ("plan.md", "# Final proposal\n\nShip the feature.".into())
    );
    assert!(plans[1]
        .1
        .contains("- [x] Design\n- [ ] **In progress:** Implement\n- [ ] Test"));
    assert!(!plans
        .iter()
        .any(|(_, text)| text.contains("Private instructions") || text.contains("User example")));
    assert_eq!(plans::embedded("claude", &[json!({"type":"assistant","message":{"content":[{"type":"tool_use","name":"ExitPlanMode","input":{"plan":"# Claude proposal"}}]}})])[0].1, "# Claude proposal");
}

#[test]
fn file_plans_are_project_scoped_and_honor_claude_directory_settings() {
    let f = Fixture::new();
    fs::create_dir_all(f.root.join(".codex/plans/nested")).unwrap();
    fs::write(
        f.root.join(".codex/plans/nested/feature.md"),
        "# Codex file plan\n\nImplement it.",
    )
    .unwrap();
    fs::create_dir_all(f.root.join(".claude")).unwrap();
    fs::write(
        f.root.join(".claude/settings.json"),
        r#"{"plansDirectory":"./docs/plans"}"#,
    )
    .unwrap();
    fs::create_dir_all(f.root.join("docs/plans")).unwrap();
    fs::write(f.root.join("docs/plans/feature.md"), "# Claude file plan").unwrap();
    for source in ["claude", "codex"] {
        fs::create_dir_all(plans::native_directory(source).unwrap()).unwrap();
        fs::write(
            plans::native_directory(source)
                .unwrap()
                .join("unrelated.md"),
            "# Unrelated private plan",
        )
        .unwrap();
    }
    indexer::scan(&f.db, &f.project).unwrap();
    let plans = resources(&f);
    assert_eq!(plans.len(), 2);
    assert!(plans
        .iter()
        .any(|r| r["logicalPath"] == "codex/files/nested/feature.md"));
    assert!(plans
        .iter()
        .any(|r| r["logicalPath"] == "claude/files/feature.md"));
    assert!(!plans.iter().any(|r| r["title"] == "Unrelated private plan"));
    assert_eq!(f.outbox().len(), 2);
    indexer::scan(&db::open().unwrap(), &f.project).unwrap();
    assert_eq!(f.outbox().len(), 2);
    fs::write(
        f.root.join(".claude/settings.local.json"),
        r#"{"plansDirectory":"../private"}"#,
    )
    .unwrap();
    assert!(indexer::scan(&f.db, &f.project).is_err());
    assert!(!f.outbox().iter().any(|c| c["resource"]["deleted"] == true));
}

#[test]
fn session_plans_and_referenced_claude_files_sync_without_rewriting_history() {
    let f = Fixture::new();
    let codex_id = uuid::Uuid::new_v4().to_string();
    let claude_id = uuid::Uuid::new_v4().to_string();
    let records = vec![
        json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"<proposed_plan># Build a feature\n\nOriginal proposal.</proposed_plan>"}]}}),
        json!({"type":"event_msg","payload":{"type":"plan_update","plan":[{"step":"Implement","status":"in_progress"}]}}),
    ];
    let codex = write_session(&f, "codex", &codex_id, &records);
    let global = plans::native_directory("claude").unwrap();
    fs::create_dir_all(&global).unwrap();
    let claude_plan = global.join("steady-feature.md");
    fs::write(
        &claude_plan,
        "# Claude native plan\n\nCurrent file content.",
    )
    .unwrap();
    fs::write(global.join("unrelated.md"), "Private").unwrap();
    let claude = write_session(
        &f,
        "claude",
        &claude_id,
        &[
            json!({"type":"assistant","slug":"steady-feature","message":{"content":[{"type":"tool_use","name":"ExitPlanMode","input":{"plan":"Stale inline version","planFilePath":claude_plan}}]}}),
        ],
    );
    let original_codex = fs::read(&codex).unwrap();
    let original_claude = fs::read(&claude).unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(resources(&f).len(), 3);
    assert!(!resources(&f)
        .iter()
        .any(|r| r["title"] == "Stale inline version"));
    let proposal = resources(&f)
        .into_iter()
        .find(|r| r["title"] == "Build a feature")
        .unwrap();
    f.accept(&proposal);
    let binding = indexer::binding(&f.db, proposal["resourceId"].as_str().unwrap()).unwrap();
    let cache = PathBuf::from(binding["paths"][0].as_str().unwrap());
    assert!(cache.starts_with(f.root.join(".orka/plans")));
    assert!(f.outbox().is_empty());
    fs::write(&cache, "# Build a feature\n\nTeam edits.").unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(f.outbox().len(), 1);
    let change = f.outbox().remove(0);
    let bytes = db::blob_read(change["resource"]["files"][0]["hash"].as_str().unwrap()).unwrap();
    assert!(String::from_utf8(bytes).unwrap().contains("Team edits"));
    let mut edited = change["resource"].clone();
    for field in ["projectId", "owner", "updatedBy", "updatedAt"] {
        edited[field] = proposal[field].clone();
    }
    edited["revision"] = json!(2);
    f.db.execute("DELETE FROM outbox", []).unwrap();
    sync::materialize(&f.db, &f.project, &edited).unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    assert!(
        f.outbox().is_empty(),
        "Unchanged native proposals must not revert shared edits"
    );
    assert_eq!(fs::read(&codex).unwrap(), original_codex);
    assert_eq!(fs::read(&claude).unwrap(), original_claude);
    assert!(fs::read_to_string(&cache).unwrap().contains("Team edits"));
    let mut updated_records = native::complete_records(&original_codex).unwrap();
    updated_records.push(json!({"type":"event_msg","payload":{"type":"item_completed","item":{"type":"Plan","text":"# Updated native proposal\n\nNew requirements."}}}));
    fs::write(&codex, native::encode(&updated_records)).unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    let updates = f.outbox();
    assert_eq!(
        updates.len(),
        2,
        "The native session and its proposal both changed"
    );
    let update = updates
        .iter()
        .find(|change| change["resource"]["kind"] == "plan")
        .unwrap()["resource"]
        .clone();
    assert_eq!(update["resourceId"], proposal["resourceId"]);
    assert_eq!(update["title"], "Updated native proposal");
    let mut accepted = edited;
    accepted["files"] = update["files"].clone();
    accepted["title"] = update["title"].clone();
    accepted["revision"] = json!(3);
    f.db.execute("DELETE FROM outbox", []).unwrap();
    sync::materialize(&f.db, &f.project, &accepted).unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    assert!(f.outbox().is_empty());
    assert!(fs::read_to_string(&cache)
        .unwrap()
        .contains("New requirements"));
}

#[test]
fn incoming_plans_materialize_export_import_and_guard_concurrent_edits() {
    let f = Fixture::new();
    for source in ["codex", "claude"] {
        let logical = format!("{source}/native/remote.md");
        let id = indexer::resource_id(f.project["id"].as_str().unwrap(), "plan", &logical);
        let r = json!({"resourceId":id,"projectId":f.project["id"],"kind":"plan","source":source,"logicalPath":logical,"title":"Remote plan","files":[plans::content(b"# Remote plan\n\nShared content.").unwrap()],"deleted":false,"revision":1,"owner":db::get(&f.db,"user").unwrap()});
        let r = f.accept(&r);
        let path = plans::destination(&f.root, &r).unwrap();
        assert_eq!(
            fs::read_to_string(&path).unwrap(),
            "# Remote plan\n\nShared content."
        );
        assert!(!plans::native_directory(source)
            .unwrap()
            .join("remote.md")
            .exists());
        let bundle = f.root.join(format!("{source}.zip"));
        bundles::export(&f.db, &id, &bundle).unwrap();
        let other_project = uuid::Uuid::new_v4().to_string();
        db::upsert(&f.db, "projects", &other_project, &other_project,
            &json!({"id":other_project,"name":"Import destination","sharing":{"memory":false,"skill":false,"session":false,"plan":true,"env":false}})).unwrap();
        let imported_id = bundles::import(&f.db, &other_project, &bundle).unwrap();
        assert_ne!(imported_id, id);
        let queued = f.outbox().remove(0);
        assert_eq!(queued["resource"]["kind"], "plan");
        assert_eq!(queued["resource"]["source"], source);
        f.db.execute("DELETE FROM outbox", []).unwrap();
        fs::write(&path, "# Local edit").unwrap();
        let mut newer = r.clone();
        newer["revision"] = json!(2);
        newer["files"] = json!([plans::content(b"# Incoming edit").unwrap()]);
        assert!(sync::materialize(&f.db, &f.project, &newer)
            .unwrap_err()
            .contains("Files changed"));
        assert_eq!(fs::read_to_string(&path).unwrap(), "# Local edit");
        indexer::scan(&f.db, &f.project).unwrap();
        assert!(f.outbox().iter().any(|c| c["resource"]["resourceId"] == id));
        f.db.execute("DELETE FROM outbox", []).unwrap();
    }
}

#[test]
fn invalid_and_symlinked_plans_preserve_sources_and_pause_deletions() {
    let f = Fixture::new();
    let directory = f.root.join(".codex/plans");
    fs::create_dir_all(&directory).unwrap();
    let path = directory.join("valid.md");
    fs::write(&path, "# Valid plan").unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    f.accept(&resources(&f)[0]);
    fs::write(directory.join("binary.md"), [0xff, 0xfe]).unwrap();
    fs::write(directory.join("large.md"), vec![b'x'; 1_000_001]).unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(resources(&f).len(), 1);
    assert_eq!(
        db::rows(&f.db, "SELECT json_object('error',error) FROM errors", &[])
            .unwrap()
            .len(),
        2
    );
    let outside = f._home.path().join("private.md");
    fs::write(&outside, "# Private plan").unwrap();
    std::os::unix::fs::symlink(&outside, directory.join("linked.md")).unwrap();
    assert!(indexer::scan(&f.db, &f.project).is_err());
    assert!(f.outbox().is_empty());
    assert_eq!(fs::read_to_string(&outside).unwrap(), "# Private plan");
    fs::remove_file(directory.join("linked.md")).unwrap();
    fs::remove_file(&path).unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(f.outbox().len(), 1);
    assert_eq!(f.outbox()[0]["resource"]["deleted"], true);
}
