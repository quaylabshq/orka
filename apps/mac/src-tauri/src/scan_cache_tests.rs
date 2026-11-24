use super::*;
use crate::{history, plans, scan_cache};

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

#[test]
fn matching_session_cache_skips_unchanged_sessions_and_rechecks_only_edited_ones() {
    let f = Fixture::new();
    let codex_a = write_session(
        &f,
        "codex",
        &uuid::Uuid::new_v4().to_string(),
        &[json!({"type":"event_msg","payload":{"message":"codex a"}})],
    );
    let codex_b = write_session(
        &f,
        "codex",
        &uuid::Uuid::new_v4().to_string(),
        &[json!({"type":"event_msg","payload":{"message":"codex b"}})],
    );
    let claude_a = write_session(
        &f,
        "claude",
        &uuid::Uuid::new_v4().to_string(),
        &[json!({"type":"assistant","message":{"role":"assistant","content":"claude a"}})],
    );
    let claude_b = write_session(
        &f,
        "claude",
        &uuid::Uuid::new_v4().to_string(),
        &[json!({"type":"assistant","message":{"role":"assistant","content":"claude b"}})],
    );

    indexer::scan(&f.db, &f.project).unwrap();
    f.db.execute("DELETE FROM outbox", []).unwrap();
    assert_eq!(history::read_counts(&codex_a), (1, 1));
    assert_eq!(history::read_counts(&codex_b), (1, 1));
    assert_eq!(history::read_counts(&claude_a), (1, 0));
    assert_eq!(history::read_counts(&claude_b), (1, 0));

    // Repeat scan with 0 changes: none of the matching transcripts are re-read.
    indexer::scan(&f.db, &f.project).unwrap();
    assert!(f.outbox().is_empty());
    assert_eq!(history::read_counts(&codex_a), (1, 1));
    assert_eq!(history::read_counts(&codex_b), (1, 1));
    assert_eq!(history::read_counts(&claude_a), (1, 0));
    assert_eq!(history::read_counts(&claude_b), (1, 0));

    // Edit only codex_a (same byte length, newer mtime/ctime): only codex_a re-reads.
    let updated = fs::read_to_string(&codex_a)
        .unwrap()
        .replace("codex a", "codex A");
    assert_eq!(updated.len(), fs::read(&codex_a).unwrap().len());
    fs::write(&codex_a, updated).unwrap();

    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(f.outbox().len(), 1);
    assert_eq!(history::read_counts(&codex_a), (2, 2));
    assert_eq!(history::read_counts(&codex_b), (1, 1));
    assert_eq!(history::read_counts(&claude_a), (1, 0));
    assert_eq!(history::read_counts(&claude_b), (1, 0));

    // Deleting claude_b still emits a deletion even though sibling sessions stayed cached.
    f.db.execute("DELETE FROM outbox", []).unwrap();
    fs::remove_file(&claude_b).unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(f.outbox().len(), 1);
    assert_eq!(f.outbox()[0]["resource"]["deleted"], true);
    assert_eq!(history::read_counts(&claude_a), (1, 0));
    assert_eq!(history::read_counts(&codex_b), (1, 1));
}

#[test]
fn cached_session_still_detects_referenced_plan_edits_and_enabling_plan_sharing() {
    let f = Fixture::new();
    let global_plans = plans::native_directory("claude").unwrap();
    fs::create_dir_all(&global_plans).unwrap();
    let claude_plan = global_plans.join("steady-plan.md");
    fs::write(&claude_plan, "# Initial plan\n\nStep 1.\n").unwrap();

    let claude_id = uuid::Uuid::new_v4().to_string();
    let claude_path = write_session(
        &f,
        "claude",
        &claude_id,
        &[json!({
            "type": "assistant",
            "slug": "steady-plan",
            "message": {
                "content": [{
                    "type": "tool_use",
                    "name": "ExitPlanMode",
                    "input": {"plan": "Inline fallback", "planFilePath": claude_plan}
                }]
            }
        })],
    );

    // First scan with plan sharing OFF caches the session with plans_checked = false.
    let mut sessions_only = f.project.clone();
    sessions_only["sharing"] =
        json!({"memory":false,"skill":false,"session":true,"plan":false,"env":false});
    indexer::scan(&f.db, &sessions_only).unwrap();
    assert_eq!(history::read_counts(&claude_path), (1, 0));
    assert!(!f.resources().iter().any(|r| r["kind"] == "plan"));

    // Enabling plan sharing invalidates the plan-less cache entry and discovers the plan.
    let mut with_plans = f.project.clone();
    with_plans["sharing"] =
        json!({"memory":false,"skill":false,"session":true,"plan":true,"env":false});
    indexer::scan(&f.db, &with_plans).unwrap();
    assert_eq!(history::read_counts(&claude_path), (2, 0));
    f.db.execute("DELETE FROM outbox", []).unwrap();
    assert_eq!(
        f.resources().iter().filter(|r| r["kind"] == "plan").count(),
        1
    );
    assert_eq!(scan_cache::plan_file_reads(&claude_plan), 1);

    // Repeat scan with 0 changes reads neither the transcript nor the plan file.
    indexer::scan(&f.db, &with_plans).unwrap();
    assert!(f.outbox().is_empty());
    assert_eq!(history::read_counts(&claude_path), (2, 0));
    assert_eq!(scan_cache::plan_file_reads(&claude_plan), 1);

    // Editing only the referenced plan file detects the plan edit WITHOUT re-reading the transcript.
    fs::write(&claude_plan, "# Updated plan\n\nStep 2.\n").unwrap();
    indexer::scan(&f.db, &with_plans).unwrap();
    assert_eq!(history::read_counts(&claude_path), (2, 0));
    assert_eq!(scan_cache::plan_file_reads(&claude_plan), 2);
    assert_eq!(f.outbox().len(), 1);
    assert_eq!(f.outbox()[0]["resource"]["kind"], "plan");
    assert_eq!(f.outbox()[0]["resource"]["title"], "Updated plan");
}

#[test]
fn paginated_session_cache_invalidates_when_ancestor_segment_changes() {
    let f = Fixture::new();
    let (_, paths) = segmented_chain(&f);
    indexer::scan(&f.db, &f.project).unwrap();
    f.db.execute("DELETE FROM outbox", []).unwrap();
    let leaf = &paths[2];
    assert_eq!(history::read_counts(leaf), (1, 1));

    // Unchanged repeat scan hits the cache.
    indexer::scan(&f.db, &f.project).unwrap();
    assert!(f.outbox().is_empty());
    assert_eq!(history::read_counts(leaf), (1, 1));

    // Modifying an ancestor segment (same byte length, same ordinal boundary) invalidates the leaf cache.
    let ancestor = &paths[0];
    let original = fs::read_to_string(ancestor).unwrap();
    let mut records = native::complete_records(original.as_bytes()).unwrap();
    let msg = records
        .iter_mut()
        .find_map(|r| {
            r["payload"]["content"][0]["text"]
                .as_str()
                .map(str::to_owned)
        })
        .expect("ancestor message text");
    let mut replacement = msg.clone();
    replacement.replace_range(..1, if msg.starts_with('Z') { "Y" } else { "Z" });
    let mutated = original.replacen(&msg, &replacement, 1);
    assert_ne!(mutated, original);
    assert_eq!(mutated.len(), original.len());
    fs::write(ancestor, mutated).unwrap();

    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(history::read_counts(leaf), (2, 2));
    assert_eq!(f.outbox().len(), 1);
    assert_eq!(f.outbox()[0]["resource"]["kind"], "session");
}

#[test]
fn file_skill_and_codex_summary_caches_re_read_only_modified_entries_and_recover_missing_blobs() {
    let f = Fixture::new();
    let agents_a = f.root.join("AGENTS.md");
    let agents_b = f.root.join("CLAUDE.md");
    fs::write(&agents_a, "# Agents A\n").unwrap();
    fs::write(&agents_b, "# Claude B\n").unwrap();

    let skill_a = f.root.join(".agents/skills/alpha");
    let skill_b = f.root.join(".agents/skills/beta");
    for (dir, name) in [(&skill_a, "alpha"), (&skill_b, "beta")] {
        fs::create_dir_all(dir).unwrap();
        fs::write(dir.join("SKILL.md"), format!("# {name}\n")).unwrap();
        fs::write(dir.join("run.sh"), "#!/bin/sh\necho hi\n").unwrap();
    }

    let plan_a = f.root.join(".codex/plans/one.md");
    let plan_b = f.root.join(".codex/plans/two.md");
    fs::create_dir_all(plan_a.parent().unwrap()).unwrap();
    fs::write(&plan_a, "# Plan One\n").unwrap();
    fs::write(&plan_b, "# Plan Two\n").unwrap();

    let summaries = native::codex_home()
        .unwrap()
        .join("memories/rollout_summaries");
    fs::create_dir_all(&summaries).unwrap();
    let summary_match = summaries.join("match.md");
    let summary_other = summaries.join("other.md");
    fs::write(
        &summary_match,
        format!(
            "thread_id: {}\ncwd: {}\nupdated_at: 2026-11-24T00:00:00Z\n\nFact\n",
            uuid::Uuid::new_v4(),
            f.root.display()
        ),
    )
    .unwrap();
    fs::write(
        &summary_other,
        format!(
            "thread_id: {}\ncwd: /unrelated/repo\nupdated_at: 2026-11-24T00:00:00Z\n\nOther\n",
            uuid::Uuid::new_v4()
        ),
    )
    .unwrap();

    // Cold scan reads each item once.
    indexer::scan(&f.db, &f.project).unwrap();
    f.db.execute("DELETE FROM outbox", []).unwrap();
    assert_eq!(scan_cache::package_file_reads(&agents_a), 1);
    assert_eq!(scan_cache::package_file_reads(&agents_b), 1);
    assert_eq!(scan_cache::skill_dir_reads(&skill_a), 1);
    assert_eq!(scan_cache::skill_dir_reads(&skill_b), 1);
    assert_eq!(scan_cache::plan_file_reads(&plan_a), 1);
    assert_eq!(scan_cache::plan_file_reads(&plan_b), 1);
    assert_eq!(scan_cache::codex_summary_reads(&summary_match), 1);
    assert_eq!(scan_cache::codex_summary_reads(&summary_other), 1);

    // Warm scan with 0 changes reads nothing again.
    indexer::scan(&f.db, &f.project).unwrap();
    assert!(f.outbox().is_empty());
    assert_eq!(scan_cache::package_file_reads(&agents_a), 1);
    assert_eq!(scan_cache::package_file_reads(&agents_b), 1);
    assert_eq!(scan_cache::skill_dir_reads(&skill_a), 1);
    assert_eq!(scan_cache::skill_dir_reads(&skill_b), 1);
    assert_eq!(scan_cache::plan_file_reads(&plan_a), 1);
    assert_eq!(scan_cache::plan_file_reads(&plan_b), 1);
    assert_eq!(scan_cache::codex_summary_reads(&summary_match), 1);
    assert_eq!(scan_cache::codex_summary_reads(&summary_other), 1);

    // Edit only agents_a, chmod +x inside skill_a, edit only plan_a.
    fs::write(&agents_a, "# Agents A updated\n").unwrap();
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        fs::set_permissions(skill_a.join("run.sh"), fs::Permissions::from_mode(0o755)).unwrap();
    }
    fs::write(&plan_a, "# Plan One updated\n").unwrap();

    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(scan_cache::package_file_reads(&agents_a), 2);
    assert_eq!(scan_cache::package_file_reads(&agents_b), 1);
    assert_eq!(scan_cache::skill_dir_reads(&skill_a), 2);
    assert_eq!(scan_cache::skill_dir_reads(&skill_b), 1);
    assert_eq!(scan_cache::plan_file_reads(&plan_a), 2);
    assert_eq!(scan_cache::plan_file_reads(&plan_b), 1);
    assert_eq!(scan_cache::codex_summary_reads(&summary_match), 1);
    assert_eq!(scan_cache::codex_summary_reads(&summary_other), 1);
    assert_eq!(f.outbox().len(), 3);

    // Removing a cached blob from disk forces a cache miss and restores the blob.
    let hash = db::digest(b"# Claude B\n");
    let blob = db::blob_path(&hash).unwrap();
    fs::remove_file(&blob).unwrap();
    assert!(!blob.exists());
    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(scan_cache::package_file_reads(&agents_b), 2);
    assert!(blob.exists());
}

#[test]
fn codex_segment_index_handles_non_ascii_filenames_without_panicking() {
    let f = Fixture::new();
    let sessions_dir = native::codex_home().unwrap().join("sessions/2026/11/24");
    fs::create_dir_all(&sessions_dir).unwrap();
    // 2-byte UTF-8 'é' + 35 ASCII 'a's => 37-byte stem where len - 36 == 1 splits 'é'.
    let non_ascii = sessions_dir.join(format!("é{}.jsonl", "a".repeat(35)));
    fs::write(&non_ascii, "{}\n").unwrap();

    let codex_id = uuid::Uuid::new_v4().to_string();
    write_session(
        &f,
        "codex",
        &codex_id,
        &[json!({"type":"event_msg","payload":{"type":"user_message","message":"Hello"}})],
    );

    indexer::scan(&f.db, &f.project).unwrap();
    assert!(f
        .resources()
        .iter()
        .any(|r| r["kind"] == "session" && r["source"] == "codex"));
}

#[test]
fn cached_session_plan_refs_reject_swapped_symlink_ancestor_directories() {
    let f = Fixture::new();
    let global_plans = plans::native_directory("claude").unwrap();
    fs::create_dir_all(&global_plans).unwrap();
    let claude_plan = global_plans.join("steady-plan.md");

    let claude_id = uuid::Uuid::new_v4().to_string();
    let claude_path = write_session(
        &f,
        "claude",
        &claude_id,
        &[json!({
            "type": "assistant",
            "slug": "steady-plan",
            "message": {
                "content": [{
                    "type": "tool_use",
                    "name": "ExitPlanMode",
                    "input": {"planFilePath": claude_plan}
                }]
            }
        })],
    );

    // Scan 1 caches session with plan_refs containing ~/.claude/plans/steady-plan.md (absent so far).
    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(history::read_counts(&claude_path), (1, 0));
    assert!(!f.resources().iter().any(|r| r["kind"] == "plan"));

    // Swap ~/.claude/plans with a symlink pointing to an external directory with a secret .md file.
    let outside = f._home.path().join("outside-plans");
    fs::create_dir_all(&outside).unwrap();
    fs::write(outside.join("steady-plan.md"), "# Secret outside file\n").unwrap();
    fs::remove_dir_all(&global_plans).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, &global_plans).unwrap();

    // Scan 2 hits CachedSession; ancestor symlink check must reject the external file.
    indexer::scan(&f.db, &f.project).unwrap();
    assert!(!f.resources().iter().any(|r| r["kind"] == "plan"));
    let errors = db::rows(
        &f.db,
        "SELECT json_object('source',source,'error',error) FROM errors",
        &[],
    )
    .unwrap();
    assert!(
        errors
            .iter()
            .any(|e| e["error"] == "Symlinked plans are excluded"),
        "expected symlink rejection error, got {errors:?}"
    );
}

#[test]
fn malformed_worktree_claude_settings_records_session_plan_error_without_aborting_scan() {
    let f = Fixture::new();
    let run_git = |dir: &Path, args: &[&str]| {
        let status = std::process::Command::new("git")
            .current_dir(dir)
            .args(args)
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?} failed");
    };
    run_git(&f.root, &["init", "--quiet"]);
    fs::write(f.root.join("README.md"), "# repo\n").unwrap();
    run_git(&f.root, &["add", "README.md"]);
    run_git(
        &f.root,
        &[
            "-c",
            "user.name=Test",
            "-c",
            "user.email=test@example.com",
            "commit",
            "-q",
            "-m",
            "init",
        ],
    );
    let wt = f._home.path().join("linked-wt");
    run_git(
        &f.root,
        &[
            "worktree",
            "add",
            "-q",
            "-b",
            "wt-branch",
            wt.to_str().unwrap(),
        ],
    );
    fs::create_dir_all(wt.join(".claude")).unwrap();
    fs::write(wt.join(".claude/settings.local.json"), "{invalid json").unwrap();

    // Write a session in the malformed worktree and another in the healthy main checkout.
    let wt_id = uuid::Uuid::new_v4().to_string();
    let claude_wt_dir = native::claude_home().unwrap().join("projects/wt-proj");
    fs::create_dir_all(&claude_wt_dir).unwrap();
    let wt_session = claude_wt_dir.join(format!("{wt_id}.jsonl"));
    fs::write(
        &wt_session,
        format!(
            "{}\n",
            json!({"sessionId": wt_id, "cwd": wt, "type": "user", "message": {"content": "wt"}})
        ),
    )
    .unwrap();
    let main_id = uuid::Uuid::new_v4().to_string();
    write_session(
        &f,
        "claude",
        &main_id,
        &[json!({"type":"user","message":{"content":"main"}})],
    );

    // Scan must succeed (not abort), collect both sessions, and record the worktree plan error.
    indexer::scan(&f.db, &f.project).unwrap();
    let session_count = f
        .resources()
        .iter()
        .filter(|r| r["kind"] == "session")
        .count();
    assert_eq!(session_count, 2);
    let errors = db::rows(
        &f.db,
        "SELECT json_object('source',source,'error',error) FROM errors",
        &[],
    )
    .unwrap();
    assert!(
        errors.iter().any(|e| e["source"]
            .as_str()
            .is_some_and(|s| s.contains(":scan:plans:"))),
        "expected per-session plan error, got {errors:?}"
    );
}

#[test]
fn governed_cached_session_still_persists_active_context_sources_when_handoffs_exist() {
    let mut f = Fixture::new();
    let project_id = f.project["id"].as_str().unwrap().to_owned();
    f.project["governed"] = json!(true);
    db::upsert(&f.db, "projects", &project_id, "", &f.project).unwrap();

    // Record an unrelated handoff so has_handoffs is true for the project.
    let handoff_file = f.root.join(".orka/handoff.md");
    fs::create_dir_all(handoff_file.parent().unwrap()).unwrap();
    fs::write(&handoff_file, "# Handoff\n").unwrap();
    native::record_handoff(
        &f.db,
        &f.project,
        &json!({"resourceId": "mem-handoff", "contextSources": ["mem-handoff"]}),
        &handoff_file,
    )
    .unwrap();

    let claude_id = uuid::Uuid::new_v4().to_string();
    let claude_path = write_session(
        &f,
        "claude",
        &claude_id,
        &[json!({"type":"user","message":{"content":"Governed session"}})],
    );

    // Scan 1 caches the session under the current handoff_scope.
    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(history::read_counts(&claude_path), (1, 0));

    // Hook adds new active.contextSources while transcript stays untouched.
    f.db.execute(
        "INSERT OR REPLACE INTO active VALUES(?,?)",
        rusqlite::params![
            &claude_id,
            json!({"project": project_id, "contextSources": ["mem-live-1"]}).to_string()
        ],
    )
    .unwrap();

    // Scan 2 hits CachedSession; active.contextSources must still be persisted to sessionSources.
    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(history::read_counts(&claude_path), (1, 0));

    // After session closes (active row removed), sessionSources must still retain mem-live-1.
    f.db.execute("DELETE FROM active WHERE native_id=?", [&claude_id])
        .unwrap();
    let persisted = native::session_sources(&f.db, &project_id, &claude_id).unwrap();
    assert_eq!(persisted, json!(["mem-live-1"]));
}

#[test]
fn claude_referenced_plan_file_skips_invalid_inline_fallback_until_file_is_deleted() {
    let f = Fixture::new();
    let global_plans = plans::native_directory("claude").unwrap();
    fs::create_dir_all(&global_plans).unwrap();
    let claude_plan = global_plans.join("valid-file.md");
    fs::write(&claude_plan, "# Valid File Plan\n\nBody.\n").unwrap();

    let claude_id = uuid::Uuid::new_v4().to_string();
    let claude_path = write_session(
        &f,
        "claude",
        &claude_id,
        &[json!({
            "type": "assistant",
            "slug": "valid-file",
            "message": {
                "content": [{
                    "type": "tool_use",
                    "name": "ExitPlanMode",
                    "input": {"plan": "invalid\0nul-inline", "planFilePath": claude_plan}
                }]
            }
        })],
    );

    // With referenced plan file present, invalid inline fallback must be skipped (no error, cached).
    indexer::scan(&f.db, &f.project).unwrap();
    let errors = db::rows(
        &f.db,
        "SELECT json_object('source',source,'error',error) FROM errors",
        &[],
    )
    .unwrap();
    assert!(errors.is_empty(), "unexpected errors: {errors:?}");
    assert_eq!(history::read_counts(&claude_path), (1, 0));

    // Repeat scan hits cache with zero errors.
    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(history::read_counts(&claude_path), (1, 0));

    // Deleting the referenced plan file invalidates cache and evaluates the inline fallback.
    fs::remove_file(&claude_plan).unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(history::read_counts(&claude_path), (2, 0));
    let errors = db::rows(
        &f.db,
        "SELECT json_object('source',source,'error',error) FROM errors",
        &[],
    )
    .unwrap();
    assert!(
        errors.iter().any(|e| e["source"]
            .as_str()
            .is_some_and(|s| s.contains(":scan:plan:"))),
        "expected inline fallback validation error after plan file deletion, got {errors:?}"
    );
}

#[test]
fn git_instruction_discovery_catches_broken_nested_git_and_top_level_ignored_nested_repo() {
    let f = Fixture::new();
    let run_git = |dir: &Path, args: &[&str]| {
        let status = std::process::Command::new("git")
            .current_dir(dir)
            .args(args)
            .status()
            .unwrap();
        assert!(status.success(), "git {args:?} failed");
    };
    run_git(&f.root, &["init", "--quiet"]);
    fs::write(f.root.join(".gitignore"), "subapp/\n").unwrap();

    // Top-level ignored nested Git repo should still be discovered using its own ignore rules.
    let subapp = f.root.join("subapp");
    fs::create_dir_all(&subapp).unwrap();
    run_git(&subapp, &["init", "--quiet"]);
    fs::write(subapp.join("AGENTS.md"), "# Subapp instructions\n").unwrap();
    let found = indexer::instruction_files(&f.root).unwrap();
    assert!(found.contains(Path::new("subapp/AGENTS.md")));

    // Broken untracked nested .git whose .gitignore ignores private/ must fail instead of returning Ok.
    let broken = f.root.join("broken-nested");
    fs::create_dir_all(broken.join("private")).unwrap();
    fs::write(broken.join(".git"), "gitdir: missing-repository\n").unwrap();
    fs::write(broken.join(".gitignore"), "private/\n").unwrap();
    fs::write(broken.join("private/AGENTS.md"), "# Hidden\n").unwrap();
    let err = indexer::instruction_files(&f.root).unwrap_err();
    assert!(
        err.contains("Cannot verify Git ignore rules"),
        "expected git ignore verification error, got {err}"
    );
}

#[test]
fn paginated_cache_detects_new_ambiguous_ancestor_segment_and_remove_local_prunes_cache() {
    let f = Fixture::new();
    let project_id = f.project["id"].as_str().unwrap().to_owned();
    let (_, paths) = segmented_chain(&f);
    let ancestor = &paths[0];
    let leaf = &paths[2];

    // Scan 1 caches the paginated session.
    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(history::read_counts(leaf), (1, 1));
    let before_errors = db::rows(
        &f.db,
        "SELECT json_object('source',source,'error',error) FROM errors",
        &[],
    )
    .unwrap();
    assert!(
        before_errors.is_empty(),
        "unexpected errors: {before_errors:?}"
    );

    // Add a conflicting sibling segment for the ancestor ID in archived_sessions with the same byte length.
    let archive_dir = native::codex_home().unwrap().join("archived_sessions");
    fs::create_dir_all(&archive_dir).unwrap();
    let original = fs::read_to_string(ancestor).unwrap();
    let records = native::complete_records(original.as_bytes()).unwrap();
    let ancestor_id = records[0]["payload"]["id"].as_str().unwrap();
    let msg = records
        .iter()
        .find_map(|r| r["payload"]["content"][0]["text"].as_str())
        .expect("ancestor message text");
    let mut replacement = msg.to_owned();
    replacement.replace_range(..1, if msg.starts_with('Z') { "Y" } else { "Z" });
    let mutated = original.replacen(msg, &replacement, 1);
    assert_eq!(mutated.len(), original.len());
    let sibling = archive_dir.join(format!(
        "rollout-2026-11-24T00-00-01-{ancestor_id}_000.jsonl"
    ));
    fs::write(&sibling, mutated).unwrap();

    // Scan 2 must invalidate the cached leaf and report ambiguous inherited history.
    indexer::scan(&f.db, &f.project).unwrap();
    let errors = db::rows(
        &f.db,
        "SELECT json_object('source',source,'error',error) FROM errors",
        &[],
    )
    .unwrap();
    assert!(
        errors
            .iter()
            .any(|e| e["error"] == "Ambiguous inherited history; original sources preserved"),
        "expected ambiguity error, got {errors:?}"
    );

    // Removing the local project prunes its scanCache session entries.
    let before_cache: i64 =
        f.db.query_row(
            "SELECT count(*) FROM meta WHERE key LIKE ?",
            [format!("scanCache:%:session:{project_id}:%")],
            |r| r.get(0),
        )
        .unwrap();
    assert!(before_cache > 0);
    crate::projects::remove_local(&f.db, &project_id).unwrap();
    let after_cache: i64 =
        f.db.query_row(
            "SELECT count(*) FROM meta WHERE key LIKE ?",
            [format!("scanCache:%:session:{project_id}:%")],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(after_cache, 0);
}

fn run_git(dir: &Path, args: &[&str]) {
    let status = std::process::Command::new("git")
        .current_dir(dir)
        .args(args)
        .status()
        .unwrap();
    assert!(status.success(), "git {args:?} failed");
}

#[test]
fn excludes_instructions_outside_connected_folder() {
    let f = Fixture::new();
    run_git(&f.root, &["init", "--quiet"]);
    let relative = Path::new("docs/AGENTS.md");
    let docs = f.root.join("docs");
    fs::create_dir(&docs).unwrap();
    fs::write(f.root.join(relative), "# In scope\n").unwrap();
    run_git(&f.root, &["add", "docs/AGENTS.md"]);
    assert!(indexer::instruction_files(&f.root)
        .unwrap()
        .contains(relative));

    let outside = f._home.path().join("another-project");
    fs::create_dir(&outside).unwrap();
    let outside_bytes = b"# Separate fixture\n";
    fs::write(outside.join("AGENTS.md"), outside_bytes).unwrap();
    fs::remove_dir_all(&docs).unwrap();
    std::os::unix::fs::symlink(&outside, &docs).unwrap();

    indexer::scan(&f.db, &f.project).unwrap();
    let outside_hash = db::digest(outside_bytes);
    assert!(
        !f.outbox()
            .iter()
            .any(|q| q["resource"]["files"][0]["hash"] == outside_hash),
        "scan queued a memory backed by bytes outside the connected folder"
    );
}

#[test]
fn discovers_nested_repos_below_an_ignored_directory() {
    let f = Fixture::new();
    run_git(&f.root, &["init", "--quiet"]);
    fs::write(f.root.join(".gitignore"), "build/\n").unwrap();
    let nested = f.root.join("build/nested");
    fs::create_dir_all(&nested).unwrap();
    run_git(&nested, &["init", "--quiet"]);
    fs::write(nested.join("AGENTS.md"), "# Nested project\n").unwrap();
    assert!(
        indexer::instruction_files(&f.root)
            .unwrap()
            .contains(Path::new("build/nested/AGENTS.md")),
        "nested repository has its own Git ignore scope"
    );
}

#[test]
fn falls_back_to_inline_plan_when_reference_turns_invalid() {
    let f = Fixture::new();
    let plans_dir = crate::plans::native_directory("claude").unwrap();
    fs::create_dir_all(&plans_dir).unwrap();
    let path = plans_dir.join("valid-file.md");
    fs::write(&path, "# Valid File Plan\n\nBody.\n").unwrap();
    let sid = uuid::Uuid::new_v4().to_string();
    write_session(
        &f,
        "claude",
        &sid,
        &[json!({
            "type":"assistant", "slug":"valid-file", "message":{"content":[{
                "type":"tool_use", "name":"ExitPlanMode",
                "input":{"plan":"# Inline fallback\n\nStill valid.", "planFilePath":path}
            }]}
        })],
    );
    let inline_exists = || {
        f.resources().iter().any(|r| {
            r["kind"] == "plan"
                && r["logicalPath"]
                    .as_str()
                    .is_some_and(|p| p.starts_with("claude/sessions/"))
        })
    };
    indexer::scan(&f.db, &f.project).unwrap();
    assert!(
        !inline_exists(),
        "valid external plan should take precedence"
    );
    fs::write(&path, [0xff, 0xfe]).unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    assert!(
        inline_exists(),
        "referenced file is invalid and the inline plan is still valid"
    );
}

#[test]
fn detects_edits_to_existing_alternate_ancestor() {
    let f = Fixture::new();
    let project_id = f.project["id"].as_str().unwrap();
    let (_, paths) = segmented_chain(&f);
    let original = fs::read_to_string(&paths[0]).unwrap();
    let records = native::complete_records(original.as_bytes()).unwrap();
    let id = records[0]["payload"]["id"].as_str().unwrap();
    let msg = records
        .iter()
        .find_map(|r| r["payload"]["content"][0]["text"].as_str())
        .unwrap();
    let mut replacement = msg.to_owned();
    replacement.replace_range(..1, if msg.starts_with('Z') { "Y" } else { "Z" });
    let mutated = original.replacen(msg, &replacement, 1);
    assert_eq!(mutated.len(), original.len());
    let directory = native::codex_home().unwrap().join("archived_sessions");
    fs::create_dir_all(&directory).unwrap();
    let sibling = directory.join(format!("rollout-2026-11-24T00-00-01-{id}_000.jsonl"));
    fs::write(&sibling, &original).unwrap();

    let errors = || {
        db::rows(
            &f.db,
            "SELECT json_object('source',source,'error',error) FROM errors WHERE source LIKE ?",
            &[&format!("{project_id}:%")],
        )
        .unwrap()
    };
    indexer::scan(&f.db, &f.project).unwrap();
    assert!(
        errors().is_empty(),
        "identical ancestor candidates are safe: {:?}",
        errors()
    );

    fs::write(&sibling, mutated).unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    assert!(
        errors()
            .iter()
            .any(|e| e["error"] == "Ambiguous inherited history; original sources preserved"),
        "conflicting ancestor candidate must be visible: {:?}",
        errors()
    );
}

#[test]
fn local_scan_repairs_same_length_blob_corruption() {
    let f = Fixture::new();
    let bytes = b"# Local instructions\n";
    fs::write(f.root.join("AGENTS.md"), bytes).unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    let hash = db::digest(bytes);
    let path = db::blob_path(&hash).unwrap();
    assert_eq!(db::blob_read(&hash).unwrap(), bytes);
    indexer::scan(&f.db, &f.project).unwrap();
    fs::write(path, vec![b'X'; bytes.len()]).unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(
        db::blob_read(&hash).as_deref(),
        Ok(bytes.as_slice()),
        "scan should repair cache from intact local source"
    );
}

#[test]
fn paginated_scan_resolves_compact_codex_ancestor_ids() {
    let f = Fixture::new();
    let (_, paths) = segmented_chain(&f);
    let mut previous_size = 0;
    for path in paths {
        let mut records = native::complete_records(&fs::read(&path).unwrap()).unwrap();
        let payload = &mut records[0]["payload"];
        let id = payload["id"].as_str().unwrap().to_owned();
        let compact = uuid::Uuid::parse_str(&id).unwrap().simple().to_string();
        payload["id"] = json!(compact);
        payload["session_id"] = json!(compact);
        if payload["history_base"].is_object() {
            payload["history_base"]["thread_id"] = json!(compact);
            payload["history_base"]["end_byte_offset"] = json!(previous_size);
        }
        let bytes = native::encode(&records);
        previous_size = bytes.len();
        let next = path.with_file_name(
            path.file_name()
                .unwrap()
                .to_str()
                .unwrap()
                .replace(&id, &compact),
        );
        fs::remove_file(path).unwrap();
        fs::write(next, bytes).unwrap();
    }

    indexer::scan(&f.db, &f.project).unwrap();
    assert_eq!(
        f.outbox()
            .iter()
            .filter(|entry| entry["resource"]["kind"] == "session")
            .count(),
        1
    );
    let errors = db::rows(&f.db, "SELECT json_quote(error) FROM errors", &[]).unwrap();
    assert!(
        errors.is_empty(),
        "compact ancestor identities should resolve: {errors:?}"
    );
}

#[test]
fn memory_index_skips_unchanged_rewrites_and_rebuilds_only_when_inputs_or_files_change() {
    let f = Fixture::new();
    let project_id = f.project["id"].as_str().unwrap();
    let agents = f.root.join("AGENTS.md");
    let docs_claude = f.root.join("docs/CLAUDE.md");
    fs::create_dir_all(docs_claude.parent().unwrap()).unwrap();
    fs::write(&agents, "# Agents memory\n\nAlpha fact.\n").unwrap();
    fs::write(&docs_claude, "# Docs memory\n\nBeta fact.\n").unwrap();

    indexer::scan(&f.db, &f.project).unwrap();
    for item in f.outbox() {
        f.accept(&item["resource"]);
    }
    f.db.execute("DELETE FROM outbox", []).unwrap();

    let out_agents = f.root.join(".orka/memory/instructions/AGENTS.md");
    let out_docs = f.root.join(".orka/memory/instructions/docs/CLAUDE.md");
    let out_index = f.root.join(".orka/memory/index.md");

    let before_builds = scan_cache::memory_index_builds(project_id);
    indexer::memory_index(&f.db, &f.project).unwrap();
    assert_eq!(
        scan_cache::memory_index_builds(project_id),
        before_builds + 1
    );
    let stamp_agents_1 = scan_cache::FileStamp::of(&out_agents).unwrap();
    let stamp_docs_1 = scan_cache::FileStamp::of(&out_docs).unwrap();
    let stamp_index_1 = scan_cache::FileStamp::of(&out_index).unwrap();

    // Repeat with zero changes: fast path skips rebuild and leaves all files untouched.
    indexer::memory_index(&f.db, &f.project).unwrap();
    assert_eq!(
        scan_cache::memory_index_builds(project_id),
        before_builds + 1
    );
    assert_eq!(
        scan_cache::FileStamp::of(&out_agents).unwrap(),
        stamp_agents_1
    );
    assert_eq!(scan_cache::FileStamp::of(&out_docs).unwrap(), stamp_docs_1);
    assert_eq!(
        scan_cache::FileStamp::of(&out_index).unwrap(),
        stamp_index_1
    );

    // Update only AGENTS.md: rebuilds index, updates AGENTS mirror & index.md, keeps docs mirror untouched.
    fs::write(&agents, "# Agents memory\n\nAlpha fact updated.\n").unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    for item in f.outbox() {
        f.accept(&item["resource"]);
    }
    f.db.execute("DELETE FROM outbox", []).unwrap();

    indexer::memory_index(&f.db, &f.project).unwrap();
    assert_eq!(
        scan_cache::memory_index_builds(project_id),
        before_builds + 2
    );
    let stamp_agents_2 = scan_cache::FileStamp::of(&out_agents).unwrap();
    let stamp_index_2 = scan_cache::FileStamp::of(&out_index).unwrap();
    assert_ne!(stamp_agents_2, stamp_agents_1);
    assert_ne!(stamp_index_2, stamp_index_1);
    assert_eq!(scan_cache::FileStamp::of(&out_docs).unwrap(), stamp_docs_1);
    assert!(fs::read_to_string(&out_index)
        .unwrap()
        .contains("Alpha fact updated."));

    // Deleting a mirrored file on disk invalidates the fast path, restores that file,
    // and leaves unchanged files (AGENTS mirror & index.md) untouched.
    fs::remove_file(&out_docs).unwrap();
    indexer::memory_index(&f.db, &f.project).unwrap();
    assert_eq!(
        scan_cache::memory_index_builds(project_id),
        before_builds + 3
    );
    assert!(out_docs.is_file());
    assert_eq!(
        scan_cache::FileStamp::of(&out_agents).unwrap(),
        stamp_agents_2
    );
    assert_eq!(
        scan_cache::FileStamp::of(&out_index).unwrap(),
        stamp_index_2
    );

    // Governed mode: editing a mirrored memory file on disk invalidates cache, captures a local draft, and restores it.
    let mut governed = f.project.clone();
    governed["governed"] = json!(true);
    let learned_id = uuid::Uuid::new_v4().to_string();
    let shared_bytes = b"# Shared Fact\n\nOriginal governed content.\n";
    let learned = json!({
        "resourceId": learned_id,
        "projectId": project_id,
        "kind": "memory",
        "source": "claude",
        "logicalPath": "claude/learned.md",
        "title": "Shared Fact",
        "revision": 1,
        "deleted": false,
        "files": [{"path":"content.md","hash":db::blob(shared_bytes).unwrap(),"size":shared_bytes.len(),"executable":false}]
    });
    db::upsert(&f.db, "resources", &learned_id, project_id, &learned).unwrap();
    indexer::memory_index(&f.db, &governed).unwrap();
    let governed_path = f
        .root
        .join(".orka/memory/resources")
        .join(&learned_id)
        .join("content.md");
    let builds_after_governed = scan_cache::memory_index_builds(project_id);
    // Warm governed pass hits cache.
    indexer::memory_index(&f.db, &governed).unwrap();
    assert_eq!(
        scan_cache::memory_index_builds(project_id),
        builds_after_governed
    );
    // Mutating the governed mirror on disk triggers rebuild, draft capture, and restoration.
    fs::write(&governed_path, "# Shared Fact\n\nLocal private edit.\n").unwrap();
    indexer::memory_index(&f.db, &governed).unwrap();
    assert_eq!(
        scan_cache::memory_index_builds(project_id),
        builds_after_governed + 1
    );
    assert_eq!(
        fs::read(&governed_path).unwrap(),
        shared_bytes,
        "governed mirror should be restored to shared content"
    );
    let drafts = db::rows(
        &f.db,
        "SELECT value FROM drafts WHERE project=?",
        &[&project_id],
    )
    .unwrap();
    assert!(
        drafts
            .iter()
            .any(|draft| draft["resource"]["resourceId"] == learned_id),
        "editing a governed memory mirror should still capture a private draft"
    );

    // Replacing a governed memory's parent directory with a symlink must fail closed without capturing a draft.
    f.db.execute("DELETE FROM drafts WHERE project=?", [&project_id])
        .unwrap();
    let outside_dir = f._home.path().join("outside-memory-dir");
    fs::create_dir_all(&outside_dir).unwrap();
    fs::write(outside_dir.join("content.md"), "# Secret external memory\n").unwrap();
    let governed_parent = governed_path.parent().unwrap();
    fs::remove_dir_all(governed_parent).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside_dir, governed_parent).unwrap();
    indexer::memory_index(&f.db, &governed).unwrap();
    let drafts_after_symlink = db::rows(
        &f.db,
        "SELECT value FROM drafts WHERE project=?",
        &[&project_id],
    )
    .unwrap();
    assert!(
        drafts_after_symlink.is_empty(),
        "symlinked parent directory must not ingest or capture external files as drafts: {drafts_after_symlink:?}"
    );
    let symlink_errors = db::rows(
        &f.db,
        "SELECT json_object('source',source,'error',error) FROM errors",
        &[],
    )
    .unwrap();
    assert!(
        symlink_errors
            .iter()
            .any(|e| e["error"] == "Directory contains symlink or file"),
        "expected parent symlink error, got {symlink_errors:?}"
    );
}

#[test]
fn materialize_skips_rewriting_matching_memory_file_and_writes_remote_updates() {
    let f = Fixture::new();
    let agents = f.root.join("AGENTS.md");
    fs::write(&agents, "# Local instructions\n").unwrap();

    indexer::scan(&f.db, &f.project).unwrap();
    let queued = f.outbox().remove(0)["resource"].clone();
    let stamp_before = scan_cache::FileStamp::of(&agents).unwrap();

    // Accepting our own uploaded bytes should update the binding without rewriting AGENTS.md.
    f.accept(&queued);
    assert_eq!(
        scan_cache::FileStamp::of(&agents).unwrap(),
        stamp_before,
        "materialize should not rewrite an already-matching memory file on disk"
    );

    // Accepting a different remote revision must write the new bytes.
    let remote_bytes = b"# Remote instructions v2\n";
    let mut remote = queued.clone();
    remote["revision"] = json!(2);
    remote["files"] = json!([{
        "path": "content.md",
        "hash": db::blob(remote_bytes).unwrap(),
        "size": remote_bytes.len(),
        "executable": false
    }]);
    db::upsert(
        &f.db,
        "resources",
        remote["resourceId"].as_str().unwrap(),
        f.project["id"].as_str().unwrap(),
        &remote,
    )
    .unwrap();
    sync::materialize(&f.db, &f.project, &remote).unwrap();
    assert_eq!(fs::read(&agents).unwrap(), remote_bytes);
}

#[test]
fn incremental_sync_skips_current_resources_repairs_stale_caches_and_honors_cancel() {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc, Mutex,
    };

    let f = Fixture::new();
    let project_id = f.project["id"].as_str().unwrap().to_owned();
    let agents = f.root.join("AGENTS.md");
    let docs_claude = f.root.join("docs/CLAUDE.md");
    fs::create_dir_all(docs_claude.parent().unwrap()).unwrap();
    fs::write(&agents, "# Agents\n").unwrap();
    fs::write(&docs_claude, "# Docs\n").unwrap();
    let skill_dir = f.root.join(".agents/skills/alpha");
    fs::create_dir_all(&skill_dir).unwrap();
    fs::write(skill_dir.join("SKILL.md"), "# Alpha\n").unwrap();
    let plan_file = f.root.join(".codex/plans/one.md");
    fs::create_dir_all(plan_file.parent().unwrap()).unwrap();
    fs::write(&plan_file, "# Plan One\n").unwrap();

    // Minimal loopback mock server supporting register, catalog, blobs, push, pull, devices.
    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let addr = listener.local_addr().unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let stop_srv = Arc::clone(&stop);
    let blobs_store: Arc<Mutex<std::collections::HashMap<String, Vec<u8>>>> =
        Arc::new(Mutex::new(std::collections::HashMap::new()));
    let revisions: Arc<Mutex<std::collections::HashMap<String, u64>>> =
        Arc::new(Mutex::new(std::collections::HashMap::new()));
    let project_json = f.project.clone();

    let cancel_pull = Arc::new(AtomicBool::new(false));
    let cancel_on_server = Arc::clone(&cancel_pull);
    let fail_finish = Arc::new(AtomicBool::new(false));
    let fail_on_server = Arc::clone(&fail_finish);
    let server_project = project_id.clone();
    let server_blobs = Arc::clone(&blobs_store);
    let server = std::thread::spawn(move || {
        while !stop_srv.load(Ordering::Relaxed) {
            let Ok((mut stream, _)) = listener.accept() else {
                std::thread::sleep(std::time::Duration::from_millis(2));
                continue;
            };
            stream.set_nonblocking(false).unwrap();
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            let header_end = loop {
                let n = stream.read(&mut chunk).unwrap_or(0);
                if n == 0 {
                    break None;
                }
                buf.extend_from_slice(&chunk[..n]);
                if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    break Some(pos + 4);
                }
            };
            let Some(header_end) = header_end else {
                continue;
            };
            let header_str = String::from_utf8_lossy(&buf[..header_end]).to_string();
            let content_len = header_str
                .lines()
                .find_map(|line| {
                    let (k, v) = line.split_once(':')?;
                    k.eq_ignore_ascii_case("content-length")
                        .then(|| v.trim().parse::<usize>().ok())
                        .flatten()
                })
                .unwrap_or(0);
            while buf.len() < header_end + content_len {
                let n = stream.read(&mut chunk).unwrap_or(0);
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
            }
            let first = header_str.lines().next().unwrap_or("");
            let mut parts = first.split_whitespace();
            let method = parts.next().unwrap_or("");
            let path = parts.next().unwrap_or("");
            let body = &buf[header_end..header_end + content_len];

            let (status, content_type, resp_bytes): (&str, &str, Vec<u8>) = if method == "PUT"
                && path.starts_with("/v2/blobs/")
            {
                let hash = path.rsplit('/').next().unwrap_or("").to_owned();
                server_blobs.lock().unwrap().insert(hash, body.to_vec());
                ("200 OK", "application/json", b"{\"ok\":true}".to_vec())
            } else if method == "GET" && path.starts_with("/v2/blobs/") {
                let hash = path.rsplit('/').next().unwrap_or("");
                if let Some(data) = server_blobs.lock().unwrap().get(hash).cloned() {
                    ("200 OK", "application/octet-stream", data)
                } else {
                    ("404 Not Found", "application/json", b"{}".to_vec())
                }
            } else if method == "POST" && path == "/v2/devices/register" {
                (
                    "200 OK",
                    "application/json",
                    json!({"capabilities": {}}).to_string().into_bytes(),
                )
            } else if method == "GET" && path.starts_with("/v2/projects/capabilities") {
                ("200 OK", "application/json", b"{}".to_vec())
            } else if method == "GET" && path.starts_with("/v2/projects") {
                (
                    "200 OK",
                    "application/json",
                    json!([project_json]).to_string().into_bytes(),
                )
            } else if method == "GET" && path == "/v2/devices" {
                if fail_on_server.load(Ordering::SeqCst) {
                    (
                        "503 Service Unavailable",
                        "application/json",
                        b"{}".to_vec(),
                    )
                } else {
                    ("200 OK", "application/json", b"[]".to_vec())
                }
            } else if method == "GET" && path.starts_with("/v2/sync/pull") {
                if cancel_on_server.swap(false, Ordering::SeqCst) {
                    crate::sync_queue::SyncQueue::mark_cancelled(
                        &db::open().unwrap(),
                        &server_project,
                    )
                    .unwrap();
                }
                (
                        "200 OK",
                        "application/json",
                        json!({"events":[],"cursor":1,"hasMore":false,"policyRevision":1,"requests":[],"presence":[]})
                            .to_string()
                            .into_bytes(),
                    )
            } else if method == "POST" && path == "/v2/sync/push" {
                let payload: Value = serde_json::from_slice(body).unwrap();
                let mut resource = payload["resource"].clone();
                let rid = resource["resourceId"].as_str().unwrap().to_owned();
                let mut revs = revisions.lock().unwrap();
                let next = revs.get(&rid).copied().unwrap_or(0) + 1;
                revs.insert(rid, next);
                resource["revision"] = json!(next);
                resource["projectId"] = project_json["id"].clone();
                let receipt = json!({
                    "conflict": false,
                    "event": {
                        "resource": resource,
                        "conflicts": [],
                        "related": [],
                        "activity": null
                    }
                });
                (
                    "200 OK",
                    "application/json",
                    receipt.to_string().into_bytes(),
                )
            } else {
                ("200 OK", "application/json", b"{}".to_vec())
            };
            let head = format!(
                "HTTP/1.1 {status}\r\nContent-Type: {content_type}\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                resp_bytes.len()
            );
            let _ = stream.write_all(head.as_bytes());
            let _ = stream.write_all(&resp_bytes);
            let _ = stream.flush();
        }
    });

    let origin = format!("http://{addr}");
    db::set(&f.db, "config", &json!({"apiUrl": origin})).unwrap();
    crate::env::test_support::install_memory_keychain();
    let owner = db::get(&f.db, "user").unwrap().as_str().unwrap().to_owned();
    crate::auth::test_session(&json!({
        "user": {"id": owner},
        "access_token": "test-token",
        "refresh_token": "test-refresh",
        "expires_at": i64::MAX
    }))
    .unwrap();
    let account_db = db::open().unwrap();
    db::set(&account_db, "user", &json!(owner)).unwrap();
    db::upsert(
        &account_db,
        "projects",
        &project_id,
        &project_id,
        &f.project,
    )
    .unwrap();

    let rt = tokio::runtime::Runtime::new().unwrap();

    // Sync 1 (cold): pushes & applies all 4 resources.
    let applied_0 = sync::pull_applied_resources(&project_id);
    rt.block_on(sync::once()).unwrap();
    let applied_1 = sync::pull_applied_resources(&project_id);
    assert_eq!(applied_1 - applied_0, 4);
    let sync1_errors = db::rows(
        &account_db,
        "SELECT json_object('source',source,'error',error) FROM errors",
        &[],
    )
    .unwrap();
    assert!(
        sync1_errors.is_empty(),
        "unexpected sync1 errors: {sync1_errors:?}"
    );

    let out_agents = f.root.join(".orka/memory/instructions/AGENTS.md");
    let out_docs = f.root.join(".orka/memory/instructions/docs/CLAUDE.md");
    let out_index = f.root.join(".orka/memory/index.md");
    let stamp_out_agents = scan_cache::FileStamp::of(&out_agents).unwrap();
    let stamp_out_docs = scan_cache::FileStamp::of(&out_docs).unwrap();
    let stamp_out_index = scan_cache::FileStamp::of(&out_index).unwrap();
    let builds_1 = scan_cache::memory_index_builds(&project_id);

    // Sync 2 (idle): applies 0 resources and skips rebuilding memory index.
    rt.block_on(sync::once()).unwrap();
    let applied_2 = sync::pull_applied_resources(&project_id);
    assert_eq!(
        applied_2 - applied_1,
        0,
        "idle sync should skip applying already-current resources"
    );
    assert_eq!(scan_cache::memory_index_builds(&project_id), builds_1);
    assert_eq!(
        scan_cache::FileStamp::of(&out_agents).unwrap(),
        stamp_out_agents
    );
    assert_eq!(
        scan_cache::FileStamp::of(&out_docs).unwrap(),
        stamp_out_docs
    );
    assert_eq!(
        scan_cache::FileStamp::of(&out_index).unwrap(),
        stamp_out_index
    );

    // Sync 3 (1-file edit): applies only the 1 changed resource (not all 4).
    fs::write(&agents, "# Agents edited once\n").unwrap();
    let agents_stamp_after_edit = scan_cache::FileStamp::of(&agents).unwrap();
    rt.block_on(sync::once()).unwrap();
    let applied_3 = sync::pull_applied_resources(&project_id);
    assert_eq!(
        applied_3 - applied_2,
        1,
        "editing one file should only apply that 1 resource"
    );
    assert_eq!(
        scan_cache::FileStamp::of(&agents).unwrap(),
        agents_stamp_after_edit,
        "own edited file should not be rewritten back onto disk"
    );
    assert_eq!(
        scan_cache::FileStamp::of(&out_docs).unwrap(),
        stamp_out_docs
    );

    // Sync 4 (missing blob on a remote snapshot): deleting its cached blob forces only
    // that 1 resource to re-download from the server in pull_project.
    let remote_bytes = b"{\"type\":\"session_meta\",\"payload\":{\"id\":\"remote-1\"}}\n";
    let remote_hash = db::digest(remote_bytes);
    let remote_id = uuid::Uuid::new_v4().to_string();
    let remote_session = json!({
        "resourceId": remote_id,
        "projectId": project_id,
        "kind": "session",
        "source": "codex",
        "logicalPath": "codex/remote-1.jsonl",
        "title": "Remote Session",
        "revision": 1,
        "deleted": false,
        "files": [{"path":"transcript.jsonl","hash":remote_hash,"size":remote_bytes.len(),"executable":false}]
    });
    let remote_binding = json!({
        "base": remote_session,
        "paths": [],
        "guards": [],
        "managed": true,
        "installationState": "current",
        "lastSeenHash": indexer::manifest_hash(&remote_session["files"]),
        "writeGuard": indexer::manifest_hash(&remote_session["files"])
    });
    blobs_store
        .lock()
        .unwrap()
        .insert(remote_hash.clone(), remote_bytes.to_vec());
    db::upsert(
        &account_db,
        "resources",
        &remote_id,
        &project_id,
        &remote_session,
    )
    .unwrap();
    db::upsert(
        &account_db,
        "bindings",
        &remote_id,
        &project_id,
        &remote_binding,
    )
    .unwrap();
    let remote_blob = db::blob_path(&remote_hash).unwrap();
    assert!(!remote_blob.exists());
    rt.block_on(sync::once()).unwrap();
    let applied_4 = sync::pull_applied_resources(&project_id);
    assert_eq!(
        applied_4 - applied_3,
        1,
        "missing blob should force only that 1 resource to re-download"
    );
    assert!(remote_blob.exists());

    let cadence = format!("syncReconciliation:{project_id}");
    assert_eq!(db::get(&account_db, &cadence).unwrap(), 4);

    // Rejected rows stay visible for manual resolution and must not starve
    // reconciliation for the rest of the project.
    let rejected = uuid::Uuid::new_v4().to_string();
    account_db
        .execute(
            "INSERT INTO outbox VALUES(?,?,?,?,?)",
            rusqlite::params![
                rejected,
                project_id,
                "/v2/sync/push",
                json!({
                    "id":rejected,
                    "resource":{"resourceId":uuid::Uuid::new_v4().to_string()}
                })
                .to_string(),
                "403: Access denied"
            ],
        )
        .unwrap();

    // Prime the verified-blob memo before replacing the stored bytes.
    let blobs = db::BlobStore::current().unwrap();
    assert!(blobs.present(&remote_hash, remote_bytes.len() as u64));
    fs::write(&remote_blob, vec![b'X'; remote_bytes.len()]).unwrap();

    // Simulate a missed local edit by keeping the old manifest behind an
    // otherwise-current file stamp. The fifth pass still takes the fast path.
    let old_hash = db::digest(&fs::read(&agents).unwrap());
    let old_stamp = json!(scan_cache::FileStamp::of(&agents).unwrap());
    let revised = b"# Agents edited behind a stale manifest\n";
    fs::write(&agents, revised).unwrap();
    let mut cached = db::rows(
        &account_db,
        "SELECT json_object('key',key,'value',json(value)) FROM meta WHERE key LIKE 'scanCache:%:file:%' AND json_extract(value,'$.file.hash')=?",
        &[&old_hash],
    ).unwrap();
    cached.retain(|entry| entry["value"]["stamp"] == old_stamp);
    assert_eq!(cached.len(), 1);
    let mut cached = cached.pop().unwrap();
    cached["value"]["stamp"] = json!(scan_cache::FileStamp::of(&agents).unwrap());
    db::set(
        &account_db,
        cached["key"].as_str().unwrap(),
        &cached["value"],
    )
    .unwrap();

    let agents_resource = || {
        let rows = db::rows(&account_db, "SELECT value FROM resources WHERE json_extract(value,'$.logicalPath')='instructions/AGENTS.md'", &[]).unwrap();
        assert_eq!(rows.len(), 1);
        rows.into_iter().next().unwrap()
    };
    rt.block_on(sync::once()).unwrap();
    assert_eq!(db::blob_read(&remote_hash).unwrap(), remote_bytes);
    assert_eq!(agents_resource()["files"][0]["hash"], old_hash);
    assert_eq!(db::get(&account_db, &cadence).unwrap(), 5);

    // The sixth pass bypasses the cached manifest and uploads the edit. A
    // failure in the final remote stage leaves the durable cadence due.
    fail_finish.store(true, Ordering::SeqCst);
    assert!(rt.block_on(sync::once()).is_err());
    fail_finish.store(false, Ordering::SeqCst);
    assert_eq!(agents_resource()["files"][0]["hash"], db::digest(revised));
    let reopened = db::open().unwrap();
    assert_eq!(db::get(&reopened, &cadence).unwrap(), 5);
    rt.block_on(sync::once()).unwrap();
    assert_eq!(db::get(&account_db, &cadence).unwrap(), 0);
    let rejected_status: String = account_db
        .query_row("SELECT error FROM outbox WHERE id=?", [&rejected], |row| {
            row.get(0)
        })
        .unwrap();
    assert_eq!(rejected_status, "403: Access denied");

    // Cancellation while pulling an already-current project must stop local
    // post-pull work and must not consume any reconciliation credit.
    fs::remove_file(&out_index).unwrap();
    cancel_pull.store(true, Ordering::SeqCst);
    rt.block_on(sync::once()).unwrap();
    assert!(!cancel_pull.load(Ordering::SeqCst));
    assert!(!out_index.exists());
    assert_eq!(db::get(&account_db, &cadence).unwrap(), 0);

    stop.store(true, Ordering::Relaxed);
    let _ = server.join();
}

#[test]
fn memory_index_multi_source_hits_cache_rebuilds_on_source_reattribution_and_prunes_on_remove_local(
) {
    let f = Fixture::new();
    let project_id = f.project["id"].as_str().unwrap().to_owned();
    let root_a = f._home.path().join("repo-a");
    let root_b = f._home.path().join("repo-b");
    fs::create_dir_all(&root_a).unwrap();
    fs::create_dir_all(&root_b).unwrap();
    let source_a = uuid::Uuid::new_v4().to_string();
    let source_b = uuid::Uuid::new_v4().to_string();
    let multi_project = json!({
        "id": project_id,
        "name": "multi",
        "sources": [
            {"id": source_a, "name": "Repo A", "path": root_a, "folderIdentity": indexer::folder_identity(&root_a).unwrap()},
            {"id": source_b, "name": "Repo B", "path": root_b, "folderIdentity": indexer::folder_identity(&root_b).unwrap()}
        ]
    });
    db::upsert(&f.db, "projects", &project_id, &project_id, &multi_project).unwrap();

    let id_a = uuid::Uuid::new_v4().to_string();
    let id_b = uuid::Uuid::new_v4().to_string();
    let bytes_a = b"# Memory A\n\nFact from repo A.\n";
    let bytes_b = b"# Memory B\n\nFact from repo B.\n";
    let mut mem_a = json!({
        "resourceId": id_a,
        "projectId": project_id,
        "sourceId": source_a,
        "kind": "memory",
        "source": "shared",
        "logicalPath": "instructions/AGENTS.md",
        "title": "AGENTS A",
        "revision": 1,
        "deleted": false,
        "files": [{"path":"content.md","hash":db::blob(bytes_a).unwrap(),"size":bytes_a.len(),"executable":false}]
    });
    let mem_b = json!({
        "resourceId": id_b,
        "projectId": project_id,
        "sourceId": source_b,
        "kind": "memory",
        "source": "shared",
        "logicalPath": "instructions/CLAUDE.md",
        "title": "CLAUDE B",
        "revision": 1,
        "deleted": false,
        "files": [{"path":"content.md","hash":db::blob(bytes_b).unwrap(),"size":bytes_b.len(),"executable":false}]
    });
    db::upsert(&f.db, "resources", &id_a, &project_id, &mem_a).unwrap();
    db::upsert(&f.db, "resources", &id_b, &project_id, &mem_b).unwrap();

    let key_a = format!("{project_id}:{source_a}");
    let key_b = format!("{project_id}:{source_b}");
    let builds_a_0 = scan_cache::memory_index_builds(&key_a);
    let builds_b_0 = scan_cache::memory_index_builds(&key_b);

    // Run 1 builds both sources.
    indexer::memory_index(&f.db, &multi_project).unwrap();
    assert_eq!(scan_cache::memory_index_builds(&key_a), builds_a_0 + 1);
    assert_eq!(scan_cache::memory_index_builds(&key_b), builds_b_0 + 1);
    let idx_a_stamp = scan_cache::FileStamp::of(&root_a.join(".orka/memory/index.md")).unwrap();
    let idx_b_stamp = scan_cache::FileStamp::of(&root_b.join(".orka/memory/index.md")).unwrap();

    // Run 2 with zero changes hits cache for BOTH sources (no contextSources thrashing).
    indexer::memory_index(&f.db, &multi_project).unwrap();
    assert_eq!(scan_cache::memory_index_builds(&key_a), builds_a_0 + 1);
    assert_eq!(scan_cache::memory_index_builds(&key_b), builds_b_0 + 1);
    assert_eq!(
        scan_cache::FileStamp::of(&root_a.join(".orka/memory/index.md")).unwrap(),
        idx_a_stamp
    );
    assert_eq!(
        scan_cache::FileStamp::of(&root_b.join(".orka/memory/index.md")).unwrap(),
        idx_b_stamp
    );

    // Re-attributing mem_a to source_b at the same revision invalidates both sources.
    mem_a["sourceId"] = json!(source_b);
    db::upsert(&f.db, "resources", &id_a, &project_id, &mem_a).unwrap();
    indexer::memory_index(&f.db, &multi_project).unwrap();
    assert_eq!(scan_cache::memory_index_builds(&key_a), builds_a_0 + 2);
    assert_eq!(scan_cache::memory_index_builds(&key_b), builds_b_0 + 2);
    assert!(fs::read_to_string(root_b.join(".orka/memory/index.md"))
        .unwrap()
        .contains("Fact from repo A."));

    // Replacing index.md with a symlink must be rejected on warm cache.
    let outside = f._home.path().join("outside-index.md");
    fs::write(&outside, "# outside\n").unwrap();
    let idx_a = root_a.join(".orka/memory/index.md");
    fs::remove_file(&idx_a).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&outside, &idx_a).unwrap();
    indexer::memory_index(&f.db, &multi_project).unwrap();
    let errors = db::rows(
        &f.db,
        "SELECT json_object('source',source,'error',error) FROM errors",
        &[],
    )
    .unwrap();
    assert!(
        errors
            .iter()
            .any(|e| e["error"] == "Destination is a symlink"),
        "expected symlink rejection, got {errors:?}"
    );

    // remove_local must prune scanCache memoryIndex rows for this project.
    let before_cache: i64 =
        f.db.query_row(
            "SELECT count(*) FROM meta WHERE key LIKE ?",
            [format!("scanCache:%:memoryIndex:{project_id}:%")],
            |r| r.get(0),
        )
        .unwrap();
    assert!(before_cache > 0);
    crate::projects::remove_local(&f.db, &project_id).unwrap();
    let after_cache: i64 =
        f.db.query_row(
            "SELECT count(*) FROM meta WHERE key LIKE ?",
            [format!("scanCache:%:memoryIndex:{project_id}:%")],
            |r| r.get(0),
        )
        .unwrap();
    assert_eq!(after_cache, 0);
}

#[test]
fn preflight_fresh_preserves_multi_source_scan_errors_and_runs_post_authorize_scan_on_governed_first_sync(
) {
    use std::io::{Read, Write};
    use std::net::TcpListener;
    use std::sync::{
        atomic::{AtomicBool, Ordering},
        Arc,
    };

    let f = Fixture::new();
    let multi_id = uuid::Uuid::new_v4().to_string();
    let gov_id = uuid::Uuid::new_v4().to_string();
    let root_ok = f._home.path().join("multi-ok");
    let root_bad = f._home.path().join("multi-bad");
    let root_gov = f._home.path().join("gov-repo");
    fs::create_dir_all(&root_ok).unwrap();
    fs::create_dir_all(root_bad.join(".codex")).unwrap();
    fs::create_dir_all(&root_gov).unwrap();
    // Create a symlinked .codex/plans directory in root_bad (scan-only error; sources::validate passes).
    let ext_plans = f._home.path().join("ext-plans");
    fs::create_dir_all(&ext_plans).unwrap();
    #[cfg(unix)]
    std::os::unix::fs::symlink(&ext_plans, root_bad.join(".codex/plans")).unwrap();
    fs::write(root_gov.join("AGENTS.md"), "# Governed first sync\n").unwrap();

    let src_ok = uuid::Uuid::new_v4().to_string();
    let src_bad = uuid::Uuid::new_v4().to_string();
    let multi_project = json!({
        "id": multi_id,
        "name": "multi-errors",
        "sources": [
            {"id": src_ok, "name": "Ok", "path": root_ok, "folderIdentity": indexer::folder_identity(&root_ok).unwrap()},
            {"id": src_bad, "name": "Bad", "path": root_bad, "folderIdentity": indexer::folder_identity(&root_bad).unwrap()}
        ]
    });
    let gov_project = json!({
        "id": gov_id,
        "name": "gov-first",
        "governed": true,
        "path": root_gov,
        "folderIdentity": indexer::folder_identity(&root_gov).unwrap()
    });

    let listener = TcpListener::bind("127.0.0.1:0").unwrap();
    listener.set_nonblocking(true).unwrap();
    let addr = listener.local_addr().unwrap();
    let stop = Arc::new(AtomicBool::new(false));
    let stop_srv = Arc::clone(&stop);
    let projects_payload = json!([multi_project, gov_project]);

    let server = std::thread::spawn(move || {
        while !stop_srv.load(Ordering::Relaxed) {
            let Ok((mut stream, _)) = listener.accept() else {
                std::thread::sleep(std::time::Duration::from_millis(2));
                continue;
            };
            stream.set_nonblocking(false).unwrap();
            let mut buf = Vec::new();
            let mut chunk = [0u8; 4096];
            let header_end = loop {
                let n = stream.read(&mut chunk).unwrap_or(0);
                if n == 0 {
                    break None;
                }
                buf.extend_from_slice(&chunk[..n]);
                if let Some(pos) = buf.windows(4).position(|w| w == b"\r\n\r\n") {
                    break Some(pos + 4);
                }
            };
            let Some(header_end) = header_end else {
                continue;
            };
            let header_str = String::from_utf8_lossy(&buf[..header_end]).to_string();
            let content_len = header_str
                .lines()
                .find_map(|line| {
                    let (k, v) = line.split_once(':')?;
                    k.eq_ignore_ascii_case("content-length")
                        .then(|| v.trim().parse::<usize>().ok())
                        .flatten()
                })
                .unwrap_or(0);
            while buf.len() < header_end + content_len {
                let n = stream.read(&mut chunk).unwrap_or(0);
                if n == 0 {
                    break;
                }
                buf.extend_from_slice(&chunk[..n]);
            }
            let first = header_str.lines().next().unwrap_or("");
            let mut parts = first.split_whitespace();
            let method = parts.next().unwrap_or("");
            let path = parts.next().unwrap_or("");

            let resp_bytes: Vec<u8> = if method == "POST" && path == "/v2/devices/register" {
                json!({"capabilities": {}}).to_string().into_bytes()
            } else if method == "GET" && path.starts_with("/v2/projects/capabilities") {
                b"{}".to_vec()
            } else if method == "GET" && path.starts_with("/v2/projects") {
                projects_payload.to_string().into_bytes()
            } else if method == "GET" && path == "/v2/devices" {
                b"[]".to_vec()
            } else if method == "POST" && path == "/v2/governance/action" {
                json!({"owner": true, "access": {"instructions": {"create": "publish"}}})
                    .to_string()
                    .into_bytes()
            } else if method == "GET" && path.starts_with("/v2/sync/pull") {
                json!({"events":[],"cursor":1,"hasMore":false,"policyRevision":1,"requests":[],"presence":[]})
                    .to_string()
                    .into_bytes()
            } else {
                b"{}".to_vec()
            };
            let head = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n",
                resp_bytes.len()
            );
            let _ = stream.write_all(head.as_bytes());
            let _ = stream.write_all(&resp_bytes);
            let _ = stream.flush();
        }
    });

    let origin = format!("http://{addr}");
    db::set(&f.db, "config", &json!({"apiUrl": origin})).unwrap();
    crate::env::test_support::install_memory_keychain();
    let owner = db::get(&f.db, "user").unwrap().as_str().unwrap().to_owned();
    crate::auth::test_session(&json!({
        "user": {"id": owner},
        "access_token": "test-token",
        "refresh_token": "test-refresh",
        "expires_at": i64::MAX
    }))
    .unwrap();
    let account_db = db::open().unwrap();
    db::set(&account_db, "user", &json!(owner)).unwrap();
    db::upsert(
        &account_db,
        "projects",
        &multi_id,
        &multi_id,
        &multi_project,
    )
    .unwrap();
    db::upsert(&account_db, "projects", &gov_id, &gov_id, &gov_project).unwrap();

    let rt = tokio::runtime::Runtime::new().unwrap();
    rt.block_on(sync::once()).unwrap();

    // Finding #1: multi-source scan error on src_bad must NOT be wiped by pull_project.
    let bad_source_key = format!("{multi_id}:source:{src_bad}");
    let bad_errors = db::rows(
        &account_db,
        "SELECT json_object('source',source,'error',error) FROM errors WHERE source=?",
        &[&bad_source_key],
    )
    .unwrap();
    assert_eq!(
        bad_errors.len(),
        1,
        "expected multi-source scan error to be preserved, got {bad_errors:?}"
    );

    // Finding #2: governed first sync must invalidate preflight_fresh after authorize()
    // so automatic sharing queues AGENTS.md in the same sync cycle.
    let gov_outbox = db::rows(
        &account_db,
        "SELECT value FROM outbox WHERE project=?",
        &[&gov_id],
    )
    .unwrap();
    assert!(
        !gov_outbox.is_empty(),
        "expected governed first sync to queue AGENTS.md after authorize() fetched permissions"
    );

    stop.store(true, Ordering::Relaxed);
    let _ = server.join();
}
