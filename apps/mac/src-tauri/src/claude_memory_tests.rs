//! Claude keeps auto memory per git repository. Orka must collect it from
//! there, keep files at the older per-folder location, and collect a shared
//! repository's memory once per project.
use super::*;

fn git(args: &[&str], dir: &Path) {
    let status = std::process::Command::new("git")
        .args(args)
        .current_dir(dir)
        .env_remove("GIT_DIR")
        .env_remove("GIT_WORK_TREE")
        .status()
        .unwrap();
    assert!(status.success(), "git {args:?}");
}

fn repository(f: &Fixture) {
    git(&["init", "-q"], &f.root);
    git(
        &[
            "-c",
            "user.email=t@t",
            "-c",
            "user.name=t",
            "commit",
            "-q",
            "--allow-empty",
            "-m",
            "init",
        ],
        &f.root,
    );
}

fn connect(f: &Fixture, sources: Value) -> Value {
    let mut project = f.project.clone();
    project["path"] = Value::Null;
    project["sources"] = sources;
    let id = project["id"].as_str().unwrap();
    db::upsert(&f.db, "projects", id, "", &project).unwrap();
    project
}

fn write(dir: &Path, name: &str, text: &str) {
    fs::create_dir_all(dir).unwrap();
    fs::write(dir.join(name), text).unwrap();
}

/// Claude memory resources Orka collected, as (source id, logical path, text).
fn collected(f: &Fixture, project: &Value) -> Vec<(String, String, String)> {
    indexer::scan(&f.db, project).unwrap();
    let mut found: Vec<_> = f
        .resources()
        .into_iter()
        .filter(|r| r["kind"] == "memory" && r["source"] == "claude")
        .map(|r| {
            let hash = r["files"][0]["hash"].as_str().unwrap().to_owned();
            let text = String::from_utf8(db::blob_read(&hash).unwrap()).unwrap();
            (
                r["sourceId"].as_str().unwrap_or("").to_owned(),
                r["logicalPath"].as_str().unwrap().to_owned(),
                text,
            )
        })
        .collect();
    found.sort();
    found
}

#[test]
fn a_source_folder_inside_a_repository_collects_the_repository_memory() {
    let f = Fixture::new();
    repository(&f);
    let sub = f.root.join("apps/web");
    fs::create_dir_all(&sub).unwrap();
    let sub = sub.canonicalize().unwrap();
    let project = connect(&f, json!([{"id":"web","path":sub}]));
    assert_eq!(
        indexer::claude_memory_root(&sub),
        f.root.canonicalize().unwrap()
    );
    let memory = indexer::claude_memory(&sub).unwrap();
    assert_eq!(
        memory,
        indexer::claude_memory(&f.root.canonicalize().unwrap()).unwrap()
    );
    write(&memory, "MEMORY.md", "Claude learning\n");
    assert_eq!(
        collected(&f, &project),
        vec![(
            "web".into(),
            "claude/MEMORY.md".into(),
            "Claude learning\n".into()
        )]
    );
}

#[test]
fn both_hooks_use_synced_memory_from_the_other_tool() {
    let mut f = Fixture::new();
    repository(&f);
    let sub = f.root.join("web");
    fs::create_dir(&sub).unwrap();
    f.project["path"] = json!(sub);
    db::upsert(
        &f.db,
        "projects",
        f.project["id"].as_str().unwrap(),
        "",
        &f.project,
    )
    .unwrap();
    write(
        &indexer::claude_memory(&f.root).unwrap(),
        "notarization.md",
        "Notarization needs the Developer ID certificate.\n",
    );
    let codex = native::codex_home()
        .unwrap()
        .join("memories/rollout_summaries");
    write(
        &codex,
        "cache.md",
        &format!(
            "cwd: {}\n\nQuartz cache uses a read-through adapter.\n",
            sub.display()
        ),
    );
    indexer::scan(&f.db, &f.project).unwrap();
    for (tool, query, expected) in [
        (
            "codex",
            "Notarization Developer ID",
            "Developer ID certificate",
        ),
        ("claude", "Quartz cache", "read-through adapter"),
    ] {
        let response = native::hook(tool, json!({"cwd":sub,"hook_event_name":"UserPromptSubmit","prompt":query,"session_id":uuid::Uuid::new_v4().to_string()})).unwrap();
        assert!(
            response["hookSpecificOutput"]["additionalContext"]
                .as_str()
                .is_some_and(|context| context.contains(expected)),
            "{tool}: {response}"
        );
    }
    let config = native::claude_home().unwrap();
    write(
        &config,
        ".claude.json",
        &json!({"projects":{sub.to_str().unwrap():{"hasTrustDialogAccepted":true}}}).to_string(),
    );
    write(&sub.join(".claude"), "settings.json", "{invalid");
    f.project["sharing"] = json!({"memory":true});
    write(
        &codex,
        "routing.md",
        &format!(
            "cwd: {}\n\nThe routing table is refreshed every hour.\n",
            sub.display()
        ),
    );
    indexer::scan(&f.db, &f.project).unwrap();
    assert!(f
        .resources()
        .iter()
        .any(|r| r["source"] == "codex" && r["title"] == "routing.md"));
}

#[test]
fn a_linked_worktree_shares_the_main_worktree_memory() {
    let f = Fixture::new();
    repository(&f);
    let worktree = f.root.parent().unwrap().join("feature");
    git(
        &["worktree", "add", "-q", worktree.to_str().unwrap()],
        &f.root,
    );
    let worktree = worktree.canonicalize().unwrap();
    assert_eq!(
        indexer::claude_memory_root(&worktree),
        f.root.canonicalize().unwrap()
    );
    let impostor = f.root.parent().unwrap().join("impostor");
    fs::create_dir(&impostor).unwrap();
    fs::copy(worktree.join(".git"), impostor.join(".git")).unwrap();
    assert_eq!(indexer::claude_memory_root(&impostor), impostor);
    // A folder without readable Git metadata keeps its own path.
    let broken = f.root.parent().unwrap().join("broken");
    fs::create_dir_all(&broken).unwrap();
    fs::write(broken.join(".git"), "gitdir: /does/not/exist\n").unwrap();
    assert_eq!(indexer::claude_memory_root(&broken), broken);
    let plain = f.root.parent().unwrap().join("plain");
    fs::create_dir_all(&plain).unwrap();
    assert_eq!(indexer::claude_memory_root(&plain), plain);
}

#[test]
fn files_at_the_older_per_folder_location_are_kept_and_claude_wins_a_shared_name() {
    let f = Fixture::new();
    repository(&f);
    let sub = f.root.join("web");
    fs::create_dir_all(&sub).unwrap();
    let sub = sub.canonicalize().unwrap();
    let project = connect(&f, json!([{"id":"web","path":sub}]));
    let claude = indexer::claude_memory(&sub).unwrap();
    let older = native::claude_home()
        .unwrap()
        .join("projects")
        .join(
            sub.to_string_lossy()
                .replace(|c: char| !c.is_ascii_alphanumeric(), "-"),
        )
        .join("memory");
    assert_ne!(claude, older);
    write(&older, "teammate.md", "Pulled by an older Orka\n");
    write(&older, "MEMORY.md", "Older copy\n");
    write(&claude, "MEMORY.md", "Claude's copy\n");
    assert_eq!(
        collected(&f, &project),
        vec![
            (
                "web".into(),
                "claude/MEMORY.md".into(),
                "Claude's copy\n".into()
            ),
            (
                "web".into(),
                "claude/teammate.md".into(),
                "Pulled by an older Orka\n".into()
            ),
        ]
    );
    // Files Orka already tracks at the older location stay inside a safe base.
    let tracked = older.join("teammate.md");
    assert_eq!(indexer::claude_memory_base(&sub, &tracked).unwrap(), older);
    assert_eq!(
        indexer::claude_memory_base(&sub, &claude.join("x.md")).unwrap(),
        claude
    );
    assert!(older.join("MEMORY.md").exists());
}

#[test]
fn source_folders_sharing_a_repository_collect_its_memory_once() {
    let f = Fixture::new();
    repository(&f);
    let root = f.root.canonicalize().unwrap();
    for name in ["a", "b"] {
        fs::create_dir_all(root.join(name)).unwrap();
    }
    let memory = indexer::claude_memory(&root).unwrap();
    write(&memory, "MEMORY.md", "Repository learning\n");
    // Without the repository root connected, the first folder by path owns it.
    let project = connect(
        &f,
        json!([{"id":"b","path":root.join("b")},{"id":"a","path":root.join("a")}]),
    );
    assert_eq!(
        collected(&f, &project),
        vec![(
            "a".into(),
            "claude/MEMORY.md".into(),
            "Repository learning\n".into()
        )]
    );
    // A late root registration must not re-upload the file under another ID.
    let expected = collected(&f, &project);
    let project = connect(
        &f,
        json!([{"id":"a","path":root.join("a")},{"id":"root","path":root}]),
    );
    assert_eq!(collected(&f, &project), expected);
    fs::rename(root.join("a"), root.join("offline")).unwrap();
    write(&memory, "new.md", "While offline\n");
    assert_eq!(collected(&f, &project), expected);
    fs::rename(root.join("offline"), root.join("a")).unwrap();
    assert!(collected(&f, &project)
        .iter()
        .any(|(id, logical, _)| id == "a" && logical == "claude/new.md"));
    let removed = connect(
        &f,
        json!([{"id":"a","removedAt":db::now()},{"id":"root","path":root}]),
    );
    write(&memory, "after.md", "After removal\n");
    assert!(collected(&f, &removed).iter().all(|(id, _, _)| id == "a"));
    assert!(memory.join("after.md").is_file());
}

#[test]
fn an_old_install_keeps_synced_and_pulled_files_when_checkout_root_changes() {
    let mut f = Fixture::new();
    let repo = f.root.parent().unwrap().join("repo");
    let checkout = repo.join("project");
    fs::create_dir_all(&checkout).unwrap();
    f.root = checkout.canonicalize().unwrap();
    f.project["path"] = json!(f.root);
    git(&["init", "-q"], &f.root);
    let legacy = indexer::claude_memory_target(&f.root).unwrap();
    write(&legacy, "MEMORY.md", "Synced by 0.3.17\n");
    let _ = collected(&f, &f.project);
    f.accept(
        &f.resources()
            .into_iter()
            .find(|r| r["logicalPath"] == "claude/MEMORY.md")
            .unwrap(),
    );
    let pulled = json!({"resourceId":uuid::Uuid::new_v4().to_string(),"projectId":f.project["id"],"kind":"memory","source":"claude","title":"Teammate","logicalPath":"claude/teammate.md","deleted":false,"revision":1,"owner":"teammate","files":[{"path":"content.md","hash":db::blob(b"Pulled\n").unwrap(),"size":7,"executable":false}]});
    f.accept(&pulled);
    assert_eq!(indexer::claude_memory_root(&f.root), f.root);
    fs::rename(f.root.join(".git"), repo.join(".git")).unwrap();
    assert_eq!(indexer::claude_memory_root(&f.root), repo);
    let native = indexer::claude_memory(&f.root).unwrap();
    write(&native, "MEMORY.md", "Different Claude file\n");
    write(&native, "teammate.md", "Different Claude file\n");
    indexer::scan(&f.db, &f.project).unwrap();
    assert!(f.outbox().is_empty());
    assert_eq!(
        fs::read_to_string(legacy.join("teammate.md")).unwrap(),
        "Pulled\n"
    );
    fs::rename(&legacy, legacy.with_extension("offline")).unwrap();
    indexer::scan(&f.db, &f.project).unwrap();
    assert!(
        f.outbox().is_empty(),
        "missing local files must not send tombstones"
    );
}

#[test]
fn home_git_does_not_own_unrelated_folders_and_symlinks_do_not_change_the_key() {
    let f = Fixture::new();
    git(&["init", "-q"], f.root.parent().unwrap());
    assert_eq!(indexer::claude_memory_root(&f.root), f.root);
    repository(&f);
    let alias = f.root.with_extension("alias");
    std::os::unix::fs::symlink(&f.root, &alias).unwrap();
    assert_eq!(
        indexer::claude_memory(&alias).unwrap(),
        indexer::claude_memory(&f.root).unwrap()
    );
}

#[test]
fn native_encoding_matches_claude_for_astral_unicode_and_long_paths() {
    let f = Fixture::new();
    let folder = f.root.join("W-é😀");
    fs::create_dir_all(&folder).unwrap();
    let memory = indexer::claude_memory(&folder).unwrap();
    assert!(memory
        .parent()
        .unwrap()
        .file_name()
        .unwrap()
        .to_string_lossy()
        .ends_with("-W----"));
    let folder = f.root.join("a".repeat(180)).join("b".repeat(90));
    fs::create_dir_all(&folder).unwrap();
    let memory = indexer::claude_memory(&folder).unwrap();
    let key = memory
        .parent()
        .unwrap()
        .file_name()
        .unwrap()
        .to_str()
        .unwrap();
    assert_eq!(key.as_bytes()[200], b'-');
    assert!(key.len() <= 208);
    write(&memory, "topic.md", "Long path\n");
    let project = connect(&f, json!([{"id":"long","path":folder}]));
    assert_eq!(collected(&f, &project)[0].2, "Long path\n");
}

#[test]
fn symlinked_memory_parent_cannot_be_used_to_write_or_delete() {
    let f = Fixture::new();
    let target = indexer::claude_memory_target(&f.root).unwrap();
    let outside = f.root.join("outside");
    write(&outside.join("memory"), "note.md", "Keep me\n");
    let keyed_dir = target.parent().unwrap();
    fs::create_dir_all(keyed_dir.parent().unwrap()).unwrap();
    std::os::unix::fs::symlink(&outside, keyed_dir).unwrap();
    assert!(indexer::claude_memory_target(&f.root).is_err());
    assert!(indexer::claude_memory_base(&f.root, &target.join("note.md")).is_err());
    assert_eq!(
        fs::read_to_string(outside.join("memory/note.md")).unwrap(),
        "Keep me\n"
    );
}

#[test]
fn incoming_delete_only_removes_the_expected_legacy_file() {
    let f = Fixture::new();
    let memory = indexer::claude_memory_target(&f.root).unwrap();
    write(&memory, "note.md", "Imported\n");
    let _ = collected(&f, &f.project);
    let synced = f.accept(&f.resources()[0]);
    let mut deleted = synced.clone();
    deleted["revision"] = json!(2);
    deleted["deleted"] = json!(true);
    deleted["files"] = json!([]);
    let other = f.root.join("note.md");
    fs::write(&other, "Imported\n").unwrap();
    let id = synced["resourceId"].as_str().unwrap();
    let binding = indexer::binding(&f.db, id).unwrap();
    let mut bad_binding = binding.clone();
    bad_binding["paths"] = json!([other]);
    let project_id = f.project["id"].as_str().unwrap();
    db::upsert(&f.db, "bindings", id, project_id, &bad_binding).unwrap();
    assert!(sync::materialize(&f.db, &f.project, &deleted).is_err());
    assert!(other.is_file());
    assert!(memory.join("note.md").is_file());
    db::upsert(&f.db, "bindings", id, project_id, &binding).unwrap();
    sync::materialize(&f.db, &f.project, &deleted).unwrap();
    assert!(!memory.join("note.md").exists());
    assert!(other.is_file());
}

#[test]
fn managed_settings_take_precedence_and_expand_tilde() {
    let f = Fixture::new();
    let config = native::claude_home().unwrap();
    let managed = f.root.join("managed");
    write(
        &config,
        "settings.json",
        r#"{"autoMemoryDirectory":"~/user"}"#,
    );
    write(
        &config,
        ".claude.json",
        &json!({"projects":{f.root.to_str().unwrap():{"hasTrustDialogAccepted":true}}}).to_string(),
    );
    write(
        &f.root.join(".claude"),
        "settings.json",
        r#"{"autoMemoryDirectory":"~/project"}"#,
    );
    write(
        &f.root.join(".claude"),
        "settings.local.json",
        r#"{"autoMemoryDirectory":"~/local"}"#,
    );
    let resolved = || indexer::claude_memory_setting(&f.root, &f.root, &managed);
    assert_eq!(resolved().unwrap(), Some(db::home().unwrap().join("local")));
    write(
        &managed,
        "managed-settings.json",
        r#"{"autoMemoryDirectory":"~/policy"}"#,
    );
    write(
        &managed.join("managed-settings.d"),
        "10-memory.json",
        r#"{"autoMemoryDirectory":"~/drop-in"}"#,
    );
    write(
        &managed.join("managed-settings.d"),
        "20-invalid.json",
        r#"{"autoMemoryDirectory":"relative"}"#,
    );
    assert_eq!(
        resolved().unwrap(),
        Some(db::home().unwrap().join("drop-in"))
    );
}

#[test]
fn a_repository_pin_uses_the_same_collector_even_when_that_source_is_not_connected() {
    let f = Fixture::new();
    repository(&f);
    let sub = f.root.join("web");
    fs::create_dir(&sub).unwrap();
    write(
        &indexer::claude_memory(&sub).unwrap(),
        "MEMORY.md",
        "Shared\n",
    );
    let pin = json!({"id":"same-repository"});
    let laptop = connect(
        &f,
        json!([{"id":"a","repository":pin},{"id":"b","path":sub,"repository":pin}]),
    );
    assert!(collected(&f, &laptop).is_empty());
    let desktop = connect(
        &f,
        json!([{"id":"a","path":f.root,"repository":pin},{"id":"b","repository":pin}]),
    );
    assert_eq!(collected(&f, &desktop)[0].0, "a");
}

#[test]
fn user_settings_can_move_claude_memory_and_project_settings_override_them() {
    let f = Fixture::new();
    let user = native::claude_home().unwrap();
    fs::create_dir_all(&user).unwrap();
    let custom = f.root.parent().unwrap().join("user-memory");
    fs::write(
        user.join("settings.json"),
        json!({"autoMemoryDirectory": custom}).to_string(),
    )
    .unwrap();
    assert_eq!(indexer::claude_memory(&f.root).unwrap(), custom);
    write(&custom, "MEMORY.md", "From user settings\n");
    let source = f.project["sourceId"].as_str().unwrap_or("").to_owned();
    assert_eq!(
        collected(&f, &f.project),
        vec![(
            source,
            "claude/MEMORY.md".to_owned(),
            "From user settings\n".to_owned()
        )]
    );
    let project = f.root.parent().unwrap().join("project-memory");
    write(
        &f.root.join(".claude"),
        "settings.local.json",
        &json!({"autoMemoryDirectory": project}).to_string(),
    );
    assert_eq!(
        indexer::claude_memory(&f.root).unwrap(),
        custom,
        "an untrusted checkout cannot point the scanner at arbitrary files"
    );
    write(
        &user,
        ".claude.json",
        &json!({"projects":{f.root.to_str().unwrap():{"hasTrustDialogAccepted":true}}}).to_string(),
    );
    assert_eq!(indexer::claude_memory(&f.root).unwrap(), project);
    assert!(indexer::claude_memory_base(&f.root, &project.join("MEMORY.md")).is_err());
    // A broken user file is skipped; a broken trusted project file still fails.
    fs::remove_file(f.root.join(".claude/settings.local.json")).unwrap();
    fs::write(user.join("settings.json"), "{ not json").unwrap();
    assert_ne!(indexer::claude_memory(&f.root).unwrap(), custom);
    fs::write(f.root.join(".claude/settings.local.json"), "{ not json").unwrap();
    assert!(indexer::claude_memory(&f.root).is_err());
}
