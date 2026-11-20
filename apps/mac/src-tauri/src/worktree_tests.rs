use super::*;
use crate::worktrees::Location;

fn git(root: &Path, args: &[&str]) {
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
}

fn init(root: &Path) {
    git(root, &["init", "-q"]);
    for name in ["app", "docs"] {
        fs::create_dir(root.join(name)).unwrap();
        fs::write(root.join(name).join("README.md"), name).unwrap();
    }
    fs::write(root.join(".gitignore"), ".claude/\n.codex/\n.agents/\n").unwrap();
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
    for path in [&outside, &nested] {
        for (relative, expected) in [("app", "app"), ("docs", "root")] {
            let location = Location::new(&path.join(relative), &home);
            let (source, equivalent) = location.resolve(&sources, &home).unwrap();
            assert_eq!(source["sourceId"], expected);
            assert_eq!(equivalent, f.root.join(relative));
        }
    }
    assert!(Location::new(&outside, &home).resolve(&[], &home).is_none());
    let unrelated = home.join("unrelated");
    fs::create_dir(&unrelated).unwrap();
    init(&unrelated);
    let unrelated_tree = f.root.join(".claude/worktrees/unrelated");
    worktree(&unrelated, &unrelated_tree);
    assert!(Location::new(&unrelated_tree, &home)
        .resolve(&sources, &home)
        .is_none());

    // A copied .git pointer does not turn a folder into a registered checkout.
    let copied = f.root.join(".claude/worktrees/copied");
    write(&copied.join(".git"), fs::read(nested.join(".git")).unwrap());
    assert!(Location::new(&copied, &home)
        .resolve(&sources, &home)
        .is_none());
    let (directory, _) = crate::onboarding::discovery::registered_worktree(&nested).unwrap();
    fs::remove_file(directory.join("commondir")).unwrap();
    assert!(Location::new(&nested, &home)
        .resolve(&sources, &home)
        .is_none());
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
    assert!(Location::new(&tree, &home)
        .resolve(&[bare_source.clone()], &home)
        .is_none());
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
    let location = Location::new(&sub_tree.join("app"), &home);
    assert_eq!(
        location.resolve(&sources, &home).unwrap().1,
        submodule.join("app")
    );
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
