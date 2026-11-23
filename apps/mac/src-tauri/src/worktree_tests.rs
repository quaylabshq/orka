use super::*;
use crate::{worktree_integration, worktrees::Resolver};

fn git(root: &Path, args: &[&str]) -> String {
    let result = std::process::Command::new("/usr/bin/git")
        .current_dir(root)
        .env("GIT_CONFIG_NOSYSTEM", "1")
        .env("GIT_CONFIG_GLOBAL", "/dev/null")
        .args([
            "-c",
            "user.name=Orka Fixture",
            "-c",
            "user.email=fixture@example.invalid",
        ])
        .args(args)
        .output()
        .unwrap();
    assert!(
        result.status.success(),
        "git {args:?}: {}",
        String::from_utf8_lossy(&result.stderr)
    );
    String::from_utf8(result.stdout).unwrap()
}

fn init(root: &Path) {
    git(root, &["init", "-q"]);
    for name in ["app", "docs"] {
        fs::create_dir(root.join(name)).unwrap();
        fs::write(root.join(name).join("README.md"), name).unwrap();
    }
    git(root, &["add", "."]);
    git(root, &["commit", "-qm", "fixture"]);
}

fn worktree(root: &Path, path: &Path) {
    git(root, &["worktree", "add", "-qd", path.to_str().unwrap()]);
}

fn write(path: &Path, bytes: impl AsRef<[u8]>) {
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    fs::write(path, bytes).unwrap();
}

fn set_project(f: &Fixture, project: &Value) {
    db::upsert(
        &f.db,
        "projects",
        project["id"].as_str().unwrap(),
        "",
        project,
    )
    .unwrap();
}

#[tokio::test]
async fn watcher_installs_hooks_for_first_worktree_and_coalesces_a_burst() {
    use std::time::Duration;
    // macOS excludes its per-user temporary directory from FSEvents.
    let f = Fixture::with_home(tempfile::tempdir_in(dirs::home_dir().unwrap()).unwrap());
    init(&f.root);
    let home = crate::worktrees::home().unwrap();
    let (_poll, mut passes) = worktree_integration::test_poll(Duration::from_secs(60), false);
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(3), passes.recv())
            .await
            .unwrap(),
        Some((true, (1, 1)))
    );
    assert!(!f.root.join(".git/worktrees").exists());

    let trees: Vec<_> = (0..4).map(|i| home.join(format!("watched-{i}"))).collect();
    for tree in &trees {
        worktree(&f.root, tree);
    }
    // FSEvents latency on shared CI runners can exceed a second, so wait on
    // events with a generous bound. Any pass before the 60s poll is event-driven.
    let count = tokio::time::timeout(Duration::from_secs(20), async {
        let mut count = 0;
        loop {
            assert_eq!(passes.recv().await, Some((false, (1, 1))));
            count += 1;
            if trees
                .iter()
                .all(|tree| tree.join(".claude/settings.local.json").is_file())
            {
                return count;
            }
        }
    })
    .await
    .expect("hooks should arrive through watcher events before the fallback poll");
    // The four registrations coalesce into a handful of passes, not one per event.
    assert!(count <= 4, "expected coalesced passes, got {count}");
    for tree in trees {
        assert!(git(&tree, &["status", "--porcelain"]).is_empty());
    }
}

#[tokio::test]
async fn watcher_is_removed_when_the_source_disconnects() {
    use std::time::Duration;
    let f = Fixture::new();
    init(&f.root);
    let home = crate::worktrees::home().unwrap();
    let (_poll, mut passes) = worktree_integration::test_poll(Duration::from_millis(500), false);
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(3), passes.recv())
            .await
            .unwrap(),
        Some((true, (1, 1)))
    );
    let mut disconnected = f.project.clone();
    disconnected["revoked"] = json!(true);
    set_project(&f, &disconnected);
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(3), passes.recv())
            .await
            .unwrap(),
        Some((true, (0, 0)))
    );

    let tree = home.join("disconnected");
    worktree(&f.root, &tree);
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(3), passes.recv())
            .await
            .unwrap(),
        Some((true, (0, 0)))
    );
    assert!(!tree.join(".claude/settings.local.json").exists());
}

#[tokio::test]
async fn watcher_startup_failure_keeps_polling() {
    use std::time::Duration;
    let f = Fixture::new();
    init(&f.root);
    let home = crate::worktrees::home().unwrap();
    let (_poll, mut passes) = worktree_integration::test_poll(Duration::from_millis(500), true);
    assert_eq!(
        tokio::time::timeout(Duration::from_secs(3), passes.recv())
            .await
            .unwrap(),
        Some((true, (1, 0)))
    );
    let tree = home.join("fallback");
    worktree(&f.root, &tree);
    tokio::time::timeout(Duration::from_secs(3), async {
        loop {
            assert_eq!(passes.recv().await, Some((true, (1, 0))));
            if tree.join(".claude/settings.local.json").is_file() {
                break;
            }
        }
    })
    .await
    .unwrap();
}

#[test]
fn claude_launch_hook_checks_scope_and_delivers_once_with_the_file_hook() {
    let mut f = Fixture::new();
    let user = uuid::Uuid::new_v4().to_string();
    db::set(
        &f.db,
        "config",
        &json!({"apiUrl":"https://fixture.invalid"}),
    )
    .unwrap();
    db::profile(&user).unwrap();
    f.db = db::open().unwrap();
    db::set(&f.db, "user", &json!(user)).unwrap();
    set_project(&f, &f.project);
    init(&f.root);
    let tree = crate::worktrees::home().unwrap().join("claude-launch");
    worktree(&f.root, &tree);
    let scope = db::CacheScope::current()
        .unwrap()
        .claude_worktree_scope()
        .unwrap();
    let settings = tree.join(".claude/settings.local.json");
    let user_settings = r#"{"permissions":{"deny":["Bash"]}}"#;
    write(&settings, user_settings);
    let plugin = native::Hooks::claude_worktree_plugin().unwrap();
    let manifest_file = plugin.join(".claude-plugin/plugin.json");
    let manifest_bytes = fs::read(&manifest_file).unwrap();
    let manifest: Value = serde_json::from_slice(&manifest_bytes).unwrap();
    assert!(
        manifest["hooks"]["UserPromptSubmit"][0]["hooks"][0]["command"]
            .as_str()
            .unwrap()
            .ends_with(&format!(" --orka-claude-worktree-hook {scope}"))
    );
    assert_eq!(fs::read_to_string(&settings).unwrap(), user_settings);

    let id = uuid::Uuid::new_v4().to_string();
    let event = json!({"cwd":tree,"session_id":id,"hook_event_name":"UserPromptSubmit"});
    assert_eq!(
        native::claude_worktree_hook("stale-scope", event.clone()).unwrap(),
        json!({}),
    );
    assert_eq!(
        native::claude_worktree_hook(
            &scope,
            json!({
                "cwd":f.root,"session_id":id,"hook_event_name":"UserPromptSubmit"
            })
        )
        .unwrap(),
        json!({}),
    );
    let barrier = std::sync::Barrier::new(2);
    let outputs = std::thread::scope(|threads| {
        let barrier = &barrier;
        let plugin = threads.spawn(|| {
            barrier.wait();
            native::claude_worktree_hook(&scope, event.clone()).unwrap()
        });
        let file = threads.spawn(|| {
            barrier.wait();
            native::hook("claude", event.clone()).unwrap()
        });
        [plugin.join().unwrap(), file.join().unwrap()]
    });
    assert_eq!(
        outputs
            .iter()
            .filter(|value| value["hookSpecificOutput"]["additionalContext"].is_string())
            .count(),
        1,
        "{outputs:?}",
    );
    let ended = json!({"cwd":tree,"session_id":id,"hook_event_name":"SessionEnd"});
    assert_eq!(
        native::claude_worktree_hook(&scope, ended).unwrap(),
        json!({})
    );
    assert!(
        native::claude_worktree_hook(&scope, event.clone()).unwrap()["hookSpecificOutput"]
            ["additionalContext"]
            .is_string()
    );
    let mut disconnected = f.project.clone();
    disconnected["path"] = Value::Null;
    set_project(&f, &disconnected);
    assert_eq!(
        native::claude_worktree_hook(&scope, event.clone()).unwrap(),
        json!({})
    );
    db::set(
        &f.db,
        "config",
        &json!({"apiUrl":"https://second.fixture.invalid"}),
    )
    .unwrap();
    let new_plugin = native::Hooks::claude_worktree_plugin().unwrap();
    assert_ne!(new_plugin, plugin);
    assert_eq!(fs::read(&manifest_file).unwrap(), manifest_bytes);
    db::guest().unwrap();
    assert_eq!(
        native::claude_worktree_hook(&scope, event).unwrap(),
        json!({})
    );
}

#[test]
fn worktree_routes_to_the_most_specific_equivalent_source() {
    let f = Fixture::new();
    init(&f.root);
    let home = crate::worktrees::home().unwrap();
    let outside = home.join(".t3/worktrees/old");
    let nested = f.root.join(".claude/worktrees/nested");
    worktree(&f.root, &outside);
    worktree(&f.root, &nested);
    let mut project = f.project.clone();
    project["sources"] =
        json!([{"id":"root","path":f.root},{"id":"app","path":f.root.join("app")}]);
    let sources = crate::sources::views(&project);
    let resolver = Resolver::new(&sources, &home);
    for path in [&outside, &nested] {
        for (relative, expected) in [("app", "app"), ("docs", "root")] {
            let route = resolver.resolve(&path.join(relative)).unwrap();
            assert_eq!(route.source["sourceId"], expected);
            assert_eq!(route.equivalent, f.root.join(relative));
        }
    }
    assert!(Resolver::new(&[], &home).resolve(&outside).is_none());
    let unrelated = home.join("unrelated");
    fs::create_dir(&unrelated).unwrap();
    init(&unrelated);
    let unrelated_tree = f.root.join(".claude/worktrees/unrelated");
    worktree(&unrelated, &unrelated_tree);
    assert!(resolver.resolve(&unrelated_tree).is_none());

    // A copied .git pointer does not turn a folder into a registered checkout.
    let copied = f.root.join(".claude/worktrees/copied");
    write(&copied.join(".git"), fs::read(nested.join(".git")).unwrap());
    assert!(resolver.resolve(&copied).is_none());
    let (directory, _) = crate::onboarding::discovery::registered_worktree(&nested).unwrap();
    fs::remove_file(directory.join("commondir")).unwrap();
    assert!(resolver.resolve(&nested).is_none());
}

#[test]
fn removed_checkout_routes_capture_but_not_hooks_and_direct_root_wins_ties() {
    let f = Fixture::new();
    init(&f.root);
    let home = crate::worktrees::home().unwrap();
    let tree = f.root.join(".claude/worktrees/old");
    worktree(&f.root, &tree);
    let mut project = f.project.clone();
    project["sources"] =
        json!([{"id":"root","path":f.root},{"id":"app","path":f.root.join("app")}]);
    set_project(&f, &project);
    let sources = crate::sources::views(&project);
    let mut explicit = sources.clone();
    let mut direct = sources[0].clone();
    direct["path"] = json!(tree.join("app"));
    direct["sourceId"] = json!("worktree-app");
    explicit.push(direct);
    let cwd = tree.join("app");
    assert_eq!(
        Resolver::new(&explicit, &home)
            .resolve(&cwd)
            .unwrap()
            .source["sourceId"],
        "worktree-app"
    );
    let nested = cwd.join("nested");
    fs::create_dir(&nested).unwrap();
    init(&nested);
    assert!(Resolver::new(&sources, &home).resolve(&nested).is_none());
    worktree_integration::reconcile(&f.db, Path::new("/fixture/orka")).unwrap();
    fs::remove_dir_all(&tree).unwrap();
    let tool = "claude";
    let id = uuid::Uuid::new_v4().to_string();
    assert_eq!(
        native::hook(tool, json!({"cwd":cwd,"session_id":id})).unwrap(),
        json!({})
    );
    write(
        &native::claude_home()
            .unwrap()
            .join(format!("projects/old/{id}.jsonl")),
        native::encode(&[
            json!({"type":"user","cwd":cwd,"sessionId":id,"version":"2.1.286","message":{"role":"user","content":"old worktree"}}),
        ]),
    );
    indexer::scan(&f.db, &project).unwrap();
    let captures: Vec<_> = f
        .outbox()
        .into_iter()
        .filter(|v| v["resource"]["kind"] == "session")
        .collect();
    assert_eq!(captures.len(), 1, "{captures:?}");
    assert_eq!(captures[0]["resource"]["sourceId"], "app");
    let main = &sources[0];
    let scope = crate::worktrees::SessionScope::new(&f.db, main, &f.root, &sources, &home).unwrap();
    assert!(
        scope.for_session(tool, &id, &f.root).unwrap().is_none(),
        "a pinned native ID must not become a main-checkout session"
    );
    assert_eq!(
        native::hook(tool, json!({"cwd":f.root,"session_id":id})).unwrap(),
        json!({})
    );
    assert!(
        db::rows(&f.db, "SELECT value FROM active WHERE native_id=?", &[&id])
            .unwrap()
            .is_empty(),
        "hook must not move the pinned app session to the root source"
    );
}

#[test]
fn worktree_plans_have_distinct_keys_and_preserve_the_main_key() {
    let f = Fixture::new();
    init(&f.root);
    let home = crate::worktrees::home().unwrap();
    let a = home.join("first");
    let b = home.join("second");
    for tree in [&a, &b] {
        worktree(&f.root, tree);
    }
    for (tree, title) in [(&f.root, "Main"), (&a, "First"), (&b, "Second")] {
        let plan = tree.join(".codex/plans/same.md");
        write(&plan, format!("# {title}\n\nDifferent content."));
        let id = uuid::Uuid::new_v4().to_string();
        write(
            &native::codex_home()
                .unwrap()
                .join(format!("sessions/rollout-{id}.jsonl")),
            native::encode(&[
                json!({"type":"session_meta","payload":{"id":id,"cwd":tree,"cli_version":"0.159.2","history_mode":"legacy","source":"cli"}}),
                json!({"type":"response_item","payload":{"type":"function_call","arguments":json!({"path":plan}).to_string()}}),
            ]),
        );
    }
    indexer::scan(&f.db, &f.project).unwrap();
    let plans: Vec<_> = f
        .outbox()
        .into_iter()
        .map(|v| v["resource"].clone())
        .filter(|r| r["kind"] == "plan")
        .collect();
    assert_eq!(plans.len(), 3, "{plans:?}");
    assert!(plans
        .iter()
        .any(|plan| plan["title"] == "Main" && plan["logicalPath"] == "codex/files/same.md"));
    let worktree_keys: std::collections::BTreeSet<_> = plans
        .iter()
        .filter(|p| p["title"] == "First" || p["title"] == "Second")
        .map(|p| p["logicalPath"].as_str().unwrap())
        .collect();
    assert_eq!(worktree_keys.len(), 2);
    assert!(worktree_keys
        .iter()
        .all(|key| key.starts_with("codex/worktrees/")));
}

#[test]
fn bare_worktree_is_not_inherited_and_submodule_is_its_own_repository() {
    let f = Fixture::new();
    init(&f.root);
    let home = crate::worktrees::home().unwrap();
    let bare = home.join("bare.git");
    git(
        &f.root,
        &["clone", "-q", "--bare", ".", bare.to_str().unwrap()],
    );
    let tree = home.join("bare-worktree");
    worktree(&bare, &tree);
    let mut bare_source = f.project.clone();
    bare_source["path"] = json!(bare);
    assert!(Resolver::new(std::slice::from_ref(&bare_source), &home)
        .resolve(&tree)
        .is_none());
    set_project(&f, &bare_source);
    worktree_integration::reconcile(&f.db, Path::new("/fixture/orka")).unwrap();
    assert!(!tree.join(".codex/hooks.json").exists());

    let repo = home.join("submodule-repo");
    fs::create_dir(&repo).unwrap();
    init(&repo);
    git(
        &f.root,
        &[
            "-c",
            "protocol.file.allow=always",
            "submodule",
            "add",
            "-q",
            repo.to_str().unwrap(),
            "vendor/sub",
        ],
    );
    let submodule = f.root.join("vendor/sub");
    let mut sub_source = f.project.clone();
    sub_source["path"] = json!(submodule);
    set_project(&f, &sub_source);
    let sub_tree = home.join("submodule-worktree");
    worktree(&submodule, &sub_tree);
    let sources = [sub_source];
    assert_eq!(
        Resolver::new(&sources, &home)
            .resolve(&sub_tree.join("app"))
            .unwrap()
            .equivalent,
        submodule.join("app")
    );
    worktree_integration::reconcile(&f.db, Path::new("/fixture/orka")).unwrap();
    assert!(sub_tree.join(".codex/hooks.json").is_file());
}

#[test]
fn delivery_preserves_user_files_and_only_removes_owned_artifacts() {
    let f = Fixture::new();
    init(&f.root);
    let home = crate::worktrees::home().unwrap();
    let first = f.root.join(".claude/worktrees/first");
    let second = home.join(".t3/worktrees/second");
    let moved = home.join("moved");
    worktree(&f.root, &first);
    let skill = ".claude/skills/example/SKILL.md";
    let claude = ".claude/settings.local.json";
    let codex = ".codex/hooks.json";
    write(&f.root.join(skill), "before");
    write(&f.root.join(claude), "source personal settings");
    write(&first.join(claude), "{\"permissions\":{}}\n");
    let reconcile = || worktree_integration::reconcile(&f.db, Path::new("/fixture/orka"));
    assert!(reconcile()
        .unwrap_err()
        .contains("no recognized Orka command"));
    assert_eq!(
        fs::read_to_string(first.join(claude)).unwrap(),
        "{\"permissions\":{}}\n"
    );
    assert!(first.join(codex).is_file());
    assert!(first.join(skill).is_file());
    assert!(!first.join(".claude/skills/example").is_symlink());
    let supplemental = ".claude/skills/example/scripts/example.txt";
    write(&f.root.join(supplemental), "supplemental");
    assert!(reconcile().is_err());
    fs::remove_file(first.join(supplemental)).unwrap();
    assert!(f.root.join(supplemental).is_file());
    assert!(reconcile().unwrap_err().contains("changed or removed"));
    assert!(!first.join(supplemental).exists());
    fs::write(first.join(skill), "edited in worktree").unwrap();
    assert_eq!(fs::read_to_string(f.root.join(skill)).unwrap(), "before");

    worktree(&f.root, &second);
    assert!(reconcile().is_err());
    assert!(second.join(claude).is_file());
    assert_eq!(fs::read_to_string(second.join(skill)).unwrap(), "before");
    fs::write(f.root.join(skill), "updated at source").unwrap();
    assert!(reconcile().is_err());
    assert_eq!(
        fs::read_to_string(first.join(skill)).unwrap(),
        "edited in worktree"
    );
    assert_eq!(
        fs::read_to_string(second.join(skill)).unwrap(),
        "updated at source"
    );
    git(&second, &["add", "-A"]);
    assert!(git(&second, &["status", "--porcelain"]).is_empty());
    let unrelated = ".claude/skills/user/SKILL.md";
    write(&second.join(unrelated), "user skill");
    git(&second, &["add", "-A"]);
    assert_eq!(
        git(&second, &["diff", "--cached", "--name-only"]).trim(),
        unrelated
    );
    fs::write(second.join(claude), "user took ownership").unwrap();
    git(
        &f.root,
        &[
            "worktree",
            "move",
            second.to_str().unwrap(),
            moved.to_str().unwrap(),
        ],
    );
    fs::remove_dir_all(&first).unwrap(); // stale entry still on disk
    assert!(reconcile().is_err());
    assert!(!first.exists());
    git(&f.root, &["worktree", "prune", "--expire=now"]);
    assert!(moved.join(codex).is_file());
    let mut disconnected = f.project.clone();
    disconnected["path"] = Value::Null;
    set_project(&f, &disconnected);
    reconcile().unwrap();
    assert_eq!(
        fs::read_to_string(moved.join(claude)).unwrap(),
        "user took ownership"
    );
    assert!(!moved.join(codex).exists());
    assert!(!moved.join(skill).exists());
    assert!(f.root.join(skill).exists());
    assert!(db::rows(&f.db, "SELECT value FROM worktree_artifacts", &[])
        .unwrap()
        .is_empty());
}

#[test]
fn worktree_skill_copies_update_source_modes_and_preserve_local_mode_edits() {
    use std::os::unix::fs::{MetadataExt, PermissionsExt};

    let f = Fixture::new();
    init(&f.root);
    let tree = crate::worktrees::home().unwrap().join("skill-mode");
    worktree(&f.root, &tree);
    write(&f.root.join(".claude/skills/example/SKILL.md"), "example");
    let relative = ".claude/skills/example/scripts/example.sh";
    let source = f.root.join(relative);
    let copy = tree.join(relative);
    write(&source, "#!/bin/sh\n");
    let set_mode = |path: &Path, mode| {
        fs::set_permissions(path, fs::Permissions::from_mode(mode)).unwrap();
    };
    let executable_mode = |path: &Path| fs::metadata(path).unwrap().mode() & 0o111;
    let reconcile = || worktree_integration::reconcile(&f.db, Path::new("/fixture/orka"));

    set_mode(&source, 0o600);
    reconcile().unwrap();
    assert_eq!(executable_mode(&copy), 0);
    set_mode(&source, 0o610);
    reconcile().unwrap();
    assert_eq!(executable_mode(&copy), 0o100);

    set_mode(&copy, 0o710);
    fs::write(&source, "#!/bin/sh\necho updated\n").unwrap();
    assert!(reconcile().unwrap_err().contains("changed or removed"));
    assert_eq!(executable_mode(&copy), 0o110);
    assert_eq!(fs::read_to_string(&copy).unwrap(), "#!/bin/sh\n");

    let mut disconnected = f.project.clone();
    disconnected["path"] = Value::Null;
    set_project(&f, &disconnected);
    reconcile().unwrap();
    assert_eq!(fs::read_to_string(&copy).unwrap(), "#!/bin/sh\n");
    git(&tree, &["add", "-A"]);
    assert!(git(&tree, &["status", "--porcelain"]).is_empty());
}

#[test]
fn repairs_older_hooks_and_leaves_foreign_hooks_after_disconnect() {
    let f = Fixture::new();
    init(&f.root);
    let tree = crate::worktrees::home().unwrap().join("repair");
    worktree(&f.root, &tree);
    let stale =
        json!({"type":"command","command":"'/missing/Portable Workspace' --workspace-hook claude"});
    let foreign = json!({"type":"command","command":"echo hello"});
    let claude = tree.join(".claude/settings.local.json");
    let codex = tree.join(".codex/hooks.json");
    write(&claude, json!({"permissions":{"allow":[]},"hooks":{"SessionStart":[{"matcher":"startup","hooks":[stale, foreign]}]}}).to_string());
    write(&codex, json!({"hooks":{"Stop":[{"hooks":[{"type":"command","command":"'/old/orka' --orka-hook codex"}]}]}}).to_string());
    let reconcile = || worktree_integration::reconcile(&f.db, Path::new("/fixture/orka")).unwrap();
    reconcile();
    let read = || serde_json::from_slice::<Value>(&fs::read(&claude).unwrap()).unwrap();
    assert_eq!(
        read()["hooks"]["SessionStart"][0]["hooks"],
        json!([foreign])
    );
    assert!(read()["hooks"]["Stop"][0]["hooks"][0]["command"]
        .as_str()
        .unwrap()
        .contains("/fixture/orka"));
    assert!(git(&tree, &["status", "--porcelain"]).is_empty());
    let mut disconnected = f.project.clone();
    disconnected["path"] = Value::Null;
    set_project(&f, &disconnected);
    reconcile();
    assert!(!codex.exists());
    assert_eq!(
        read(),
        json!({"permissions":{"allow":[]},"hooks":{"SessionStart":[{"matcher":"startup","hooks":[foreign]}]}})
    );
    assert!(!fs::read_to_string(f.root.join(".git/info/exclude"))
        .unwrap()
        .contains("Orka integration"));
}

#[test]
fn git_protection_rejects_tracked_paths_and_negations_for_both_installers() {
    let f = Fixture::new();
    init(&f.root);
    let claude = ".claude/settings.local.json";
    let codex = ".codex/hooks.json";
    let old = r#"{"hooks":{"Stop":[{"hooks":[{"type":"command","command":"'/old/orka' --orka-hook claude"}]}]}}"#;
    write(&f.root.join(claude), old);
    write(&f.root.join(".gitignore"), "!.codex/hooks.json\n");
    git(&f.root, &["add", "-A"]);
    git(
        &f.root,
        &["commit", "-qm", "tracked user hook and negation"],
    );
    let tree = crate::worktrees::home().unwrap().join("tracked");
    worktree(&f.root, &tree);
    native::Hooks::install(&f.root).unwrap();
    let error = worktree_integration::reconcile(&f.db, Path::new("/fixture/orka")).unwrap_err();
    assert!(error.contains("tracked by Git"), "{error}");
    assert!(error.contains("not ignored by Git"), "{error}");
    for checkout in [&f.root, &tree] {
        assert_eq!(fs::read_to_string(checkout.join(claude)).unwrap(), old);
        assert!(!checkout.join(codex).exists());
        git(checkout, &["add", "-A"]);
        assert!(git(checkout, &["status", "--porcelain"]).is_empty());
    }
}

#[test]
fn source_installer_protects_generated_hooks_and_original_backup() {
    let f = Fixture::new();
    init(&f.root);
    let claude = ".claude/settings.local.json";
    write(&f.root.join(claude), r#"{"permissions":{}}"#);
    native::Hooks::install(&f.root).unwrap();
    assert!(f
        .root
        .join(".claude/settings.local.json.orka-backup")
        .is_file());
    assert!(f.root.join(".codex/hooks.json").is_file());
    git(&f.root, &["add", "-A"]);
    assert!(git(&f.root, &["status", "--porcelain"]).is_empty());
}

#[test]
fn old_ledger_skill_links_are_replaced_with_managed_copies() {
    use std::os::unix::fs::{symlink, MetadataExt};
    let f = Fixture::new();
    init(&f.root);
    let tree = crate::worktrees::home().unwrap().join("legacy-link");
    worktree(&f.root, &tree);
    let relative = ".agents/skills/example";
    let source = f.root.join(relative);
    let link = tree.join(relative);
    write(&source.join("SKILL.md"), "old source");
    fs::create_dir_all(link.parent().unwrap()).unwrap();
    symlink(&source, &link).unwrap();
    let metadata = fs::symlink_metadata(&link).unwrap();
    let (admin, _) = crate::onboarding::discovery::registered_worktree(&tree).unwrap();
    let legacy = json!({"checkout":tree,"admin":admin,"relative":relative,"device":metadata.dev(),"inode":metadata.ino(),"fingerprint":format!("link:{}",source.display())});
    db::set(&f.db, "worktreeIntegration", &json!([legacy])).unwrap();
    worktree_integration::reconcile(&f.db, Path::new("/fixture/orka")).unwrap();
    assert!(!link.is_symlink());
    assert_eq!(
        fs::read_to_string(link.join("SKILL.md")).unwrap(),
        "old source"
    );
    assert_eq!(
        fs::read_to_string(source.join("SKILL.md")).unwrap(),
        "old source"
    );
    git(&tree, &["add", "-A"]);
    assert!(git(&tree, &["status", "--porcelain"]).is_empty());
}

#[test]
fn pending_ownership_recovers_after_publication() {
    let f = Fixture::new();
    init(&f.root);
    let tree = crate::worktrees::home().unwrap().join("pending");
    worktree(&f.root, &tree);
    let hook = ".codex/hooks.json";
    let content = b"complete Orka file";
    write(&tree.join(hook), content);
    write(&tree.join(".codex/.pending"), content);
    let (admin, _) = crate::onboarding::discovery::registered_worktree(&tree).unwrap();
    let pending = json!({"checkout":tree,"admin":admin,"relative":hook,"device":0,"inode":0,"fingerprint":"","pending":{"fingerprint":db::digest(content),"scratch":".codex/.pending"}});
    db::set(&f.db, "worktreeIntegration", &json!([pending])).unwrap();
    let mut disconnected = f.project.clone();
    disconnected["path"] = Value::Null;
    set_project(&f, &disconnected);
    worktree_integration::reconcile(&f.db, Path::new("/fixture/orka")).unwrap();
    assert!(!tree.join(hook).exists());
    assert!(!tree.join(".codex/.pending").exists());
    assert!(db::rows(&f.db, "SELECT value FROM worktree_artifacts", &[])
        .unwrap()
        .is_empty());
}

#[test]
fn interrupted_hook_restore_cleans_scratch_and_keeps_foreign_hooks() {
    let f = Fixture::new();
    init(&f.root);
    let home = crate::worktrees::home().unwrap();
    let hook = Path::new(".codex/hooks.json");
    let orka = b"installed hook";
    let foreign = b"foreign hook";
    let mut entries = Vec::new();
    for (name, published) in [("before-restore", false), ("after-restore", true)] {
        let tree = home.join(name);
        worktree(&f.root, &tree);
        let (admin, common) = crate::onboarding::discovery::registered_worktree(&tree).unwrap();
        let scratch = Path::new(".codex").join(format!(".{name}.pending"));
        let mut excludes = crate::git_artifacts::Excludes::open(&common).unwrap();
        excludes.protect(&tree, hook, false).unwrap();
        excludes.protect(&tree, &scratch, false).unwrap();
        write(
            &tree.join(hook),
            if published { &foreign[..] } else { &orka[..] },
        );
        write(&tree.join(&scratch), foreign);
        entries.push(json!({"checkout":tree,"admin":admin,"relative":hook,"device":0,"inode":0,"fingerprint":db::digest(orka),"restore":foreign,"pending":{"fingerprint":db::digest(foreign),"scratch":scratch,"restoring":true}}));
    }
    db::set(&f.db, "worktreeIntegration", &json!(entries)).unwrap();
    let mut disconnected = f.project.clone();
    disconnected["path"] = Value::Null;
    set_project(&f, &disconnected);
    worktree_integration::reconcile(&f.db, Path::new("/fixture/orka")).unwrap();
    for name in ["before-restore", "after-restore"] {
        let tree = home.join(name);
        assert_eq!(fs::read(tree.join(hook)).unwrap(), foreign);
        assert!(!tree.join(format!(".codex/.{name}.pending")).exists());
    }
    assert!(db::rows(&f.db, "SELECT value FROM worktree_artifacts", &[])
        .unwrap()
        .is_empty());
}

#[test]
fn unavailable_checkout_keeps_ownership_without_blocking_another_repo() {
    let f = Fixture::new();
    init(&f.root);
    let home = crate::worktrees::home().unwrap();
    let parent = home.join("offline");
    let relocated = home.join("offline-moved");
    let tree = parent.join("tree");
    worktree(&f.root, &tree);
    let other = home.join("other");
    let other_tree = home.join("other-tree");
    fs::create_dir(&other).unwrap();
    init(&other);
    worktree(&other, &other_tree);
    let mut project = f.project.clone();
    project["sources"] = json!([{"id":"main","path":f.root},{"id":"other","path":other}]);
    set_project(&f, &project);
    let reconcile = || worktree_integration::reconcile(&f.db, Path::new("/fixture/orka"));
    reconcile().unwrap();
    let hook = ".codex/hooks.json";
    assert!(tree.join(hook).is_file() && other_tree.join(hook).is_file());
    fs::rename(&parent, &relocated).unwrap();
    git(&f.root, &["worktree", "prune", "--expire=now"]);
    project["sources"] = json!([]);
    project["path"] = Value::Null;
    set_project(&f, &project);
    assert!(reconcile().unwrap_err().contains("unavailable"));
    assert!(!other_tree.join(hook).exists());
    assert!(relocated.join("tree").join(hook).is_file());
    fs::rename(&relocated, &parent).unwrap();
    reconcile().unwrap();
    assert!(!tree.join(hook).exists());
}

#[test]
fn pruning_a_registration_cleans_surviving_worktree_files() {
    let f = Fixture::new();
    init(&f.root);
    let tree = crate::worktrees::home().unwrap().join("pruned");
    worktree(&f.root, &tree);
    let reconcile = || worktree_integration::reconcile(&f.db, Path::new("/fixture/orka")).unwrap();
    reconcile();
    assert!(tree.join(".codex/hooks.json").is_file());
    fs::remove_file(tree.join(".git")).unwrap();
    git(&f.root, &["worktree", "prune", "--expire=now"]);
    reconcile();
    assert!(tree.join("app/README.md").is_file());
    assert!(!tree.join(".codex/hooks.json").exists());
    assert!(!tree.join(".claude/settings.local.json").exists());
}

#[test]
fn both_provider_transcripts_sync_under_the_existing_monorepo_source() {
    let f = Fixture::new();
    init(&f.root);
    let home = crate::worktrees::home().unwrap();
    let tree = home.join("outside");
    worktree(&f.root, &tree);
    let mut project = f.project.clone();
    project["sources"] =
        json!([{"id":"root","path":f.root},{"id":"app","path":f.root.join("app")}]);
    project["sharing"] = json!({"session":true});
    set_project(&f, &project);
    let cwd = tree.join("app");
    let codex_id = uuid::Uuid::new_v4().to_string();
    let claude_id = uuid::Uuid::new_v4().to_string();
    write(
        &native::codex_home()
            .unwrap()
            .join(format!("sessions/rollout-{codex_id}.jsonl")),
        native::encode(&[
            json!({"type":"session_meta","payload":{"id":codex_id,"cwd":cwd,"cli_version":"0.159.2","history_mode":"legacy","source":"cli"}}),
        ]),
    );
    write(
        &native::claude_home()
            .unwrap()
            .join(format!("projects/test/{claude_id}.jsonl")),
        native::encode(&[
            json!({"type":"user","cwd":cwd,"sessionId":claude_id,"version":"2.1.286","message":{"role":"user","content":"fixture"}}),
        ]),
    );
    indexer::scan(&f.db, &project).unwrap();
    let captures: Vec<_> = f
        .outbox()
        .into_iter()
        .filter(|value| value["resource"]["kind"] == "session")
        .collect();
    assert_eq!(captures.len(), 2, "{captures:?}");
    for capture in captures {
        assert_eq!(capture["projectId"], project["id"]);
        assert_eq!(capture["resource"]["sourceId"], "app");
        assert!(capture["resource"].get("path").is_none());
    }
}
