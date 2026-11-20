//! Claude keeps auto memory per git repository. Orka must collect it from
//! there, keep files at the older per-folder location, and collect a shared
//! repository's memory once per project.
use super::*;
use crate::sources;

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
    // New pulls for the other folder go where only that folder collects them.
    let b = sources::views(&project)
        .into_iter()
        .find(|s| s["sourceId"] == "b")
        .unwrap();
    assert_ne!(
        indexer::claude_memory_target(&b, &root.join("b")).unwrap(),
        memory
    );
    let a = sources::views(&project)
        .into_iter()
        .find(|s| s["sourceId"] == "a")
        .unwrap();
    assert_eq!(
        indexer::claude_memory_target(&a, &root.join("a")).unwrap(),
        memory
    );
    // The repository root wins when it is itself a source folder.
    f.db.execute("DELETE FROM resources", []).unwrap();
    let project = connect(
        &f,
        json!([{"id":"a","path":root.join("a")},{"id":"root","path":root}]),
    );
    assert_eq!(
        collected(&f, &project),
        vec![(
            "root".into(),
            "claude/MEMORY.md".into(),
            "Repository learning\n".into()
        )]
    );
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
    assert_eq!(indexer::claude_memory(&f.root).unwrap(), project);
    // A broken user file is skipped; a broken project file still fails.
    fs::remove_file(f.root.join(".claude/settings.local.json")).unwrap();
    fs::write(user.join("settings.json"), "{ not json").unwrap();
    assert_ne!(indexer::claude_memory(&f.root).unwrap(), custom);
    fs::write(f.root.join(".claude/settings.local.json"), "{ not json").unwrap();
    assert!(indexer::claude_memory(&f.root).is_err());
}
