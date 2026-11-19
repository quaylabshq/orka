use super::*;
use crate::{history, local_resources};

const AMBIGUOUS: &str = "Ambiguous native history segments; source preserved";

fn setup() -> Fixture {
    let mut f = Fixture::new();
    f.project["sharing"] =
        json!({"memory":false,"skill":false,"plan":false,"session":false,"env":false});
    db::upsert(
        &f.db,
        "projects",
        f.project["id"].as_str().unwrap(),
        "",
        &f.project,
    )
    .unwrap();
    fs::create_dir_all(native::codex_home().unwrap().join("sessions")).unwrap();
    fs::create_dir_all(native::claude_home().unwrap().join("projects")).unwrap();
    f
}

fn records(f: &Fixture, id: &str, v2: bool, start: u64, message: &str) -> Vec<Value> {
    let mut meta = json!({"type":"session_meta","ordinal":start,"payload":{"id":id,"session_id":id,"cwd":f.root,"history_mode":"paginated","source":"vscode","originator":"Codex Desktop","cli_version":"0.169.0-alpha.11.1"}});
    if v2 {
        meta["payload"]["multi_agent_version"] = json!("v2");
    }
    vec![
        meta,
        json!({"type":"event_msg","ordinal":start+1,"payload":{"type":"user_message","message":message}}),
        json!({"type":"response_item","ordinal":start+2,"payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Retained answer"}]}}),
    ]
}

fn write_rollout(id: &str, suffix: &str, records: &[Value]) -> PathBuf {
    let path = native::codex_home()
        .unwrap()
        .join("sessions")
        .join(format!("rollout-2026-11-19T00-00-00-{id}{suffix}.jsonl"));
    fs::write(&path, native::encode(records)).unwrap();
    path
}

fn replacement_pair(f: &Fixture) -> (String, PathBuf, PathBuf) {
    let id = uuid::Uuid::new_v4().to_string();
    let original = write_rollout(&id, "", &records(f, &id, false, 0, "Original history"));
    let replacement = write_rollout(
        &id,
        &format!("_{}", uuid::Uuid::new_v4()),
        &records(f, &id, true, 0, "Complete v2 history"),
    );
    (id, original, replacement)
}

fn state(version: u32, id: &str, path: &Path) -> rusqlite::Connection {
    let db = rusqlite::Connection::open(
        native::codex_home()
            .unwrap()
            .join(format!("state_{version}.sqlite")),
    )
    .unwrap();
    db.execute_batch("CREATE TABLE threads(id TEXT PRIMARY KEY,rollout_path TEXT NOT NULL)")
        .unwrap();
    db.execute(
        "INSERT INTO threads VALUES(?,?)",
        rusqlite::params![id, path.to_str().unwrap()],
    )
    .unwrap();
    db
}

fn snapshot(paths: &[&Path]) -> Vec<(PathBuf, Vec<u8>)> {
    paths
        .iter()
        .map(|path| ((*path).to_path_buf(), fs::read(path).unwrap()))
        .collect()
}

fn unchanged(before: &[(PathBuf, Vec<u8>)]) {
    for (path, bytes) in before {
        assert_eq!(&fs::read(path).unwrap(), bytes, "{}", path.display());
    }
}

#[test]
fn codex_v2_canonical_replacement_is_discovered_once_without_sharing_or_source_writes() {
    let f = setup();
    let (id, original, replacement) = replacement_pair(&f);
    drop(state(5, &id, &replacement));
    let state_path = native::codex_home().unwrap().join("state_5.sqlite");
    let before = snapshot(&[&original, &replacement, &state_path]);
    assert_eq!(history::current_path(&original, &id).unwrap(), replacement);
    let catalog = local_resources::catalog(&f.db, &f.project, "session").unwrap();
    assert_eq!(catalog["errors"], json!([]));
    let resources = catalog["resources"].as_array().unwrap();
    assert_eq!(resources.len(), 1);
    assert_eq!(resources[0]["title"], "Complete v2 history");
    assert_eq!(
        History::resource(&resources[0]).unwrap().records(),
        records(&f, &id, true, 0, "Complete v2 history")
    );
    assert!(f.outbox().is_empty());
    assert!(f.resources().is_empty());
    unchanged(&before);
}

#[test]
fn codex_v2_reset_overrides_an_older_higher_ordinal_segment() {
    let f = setup();
    let (id, original, replacement) = replacement_pair(&f);
    let old_segment = write_rollout(
        &id,
        &format!("_{}", uuid::Uuid::new_v4()),
        &records(&f, &id, false, 300, "Old segmented continuation"),
    );
    assert_eq!(
        history::current_path(&old_segment, &id).unwrap_err(),
        AMBIGUOUS
    );
    drop(state(5, &id, &replacement));
    let before = snapshot(&[&original, &replacement, &old_segment]);
    assert_eq!(
        history::current_path(&old_segment, &id).unwrap(),
        replacement
    );
    assert_eq!(
        History::local(&replacement, Some(&f.root))
            .unwrap()
            .records(),
        records(&f, &id, true, 0, "Complete v2 history")
    );
    unchanged(&before);
}

#[test]
fn codex_v2_marker_alone_never_resolves_conflicting_reset_histories() {
    let f = setup();
    let (id, original, replacement) = replacement_pair(&f);
    let before = snapshot(&[&original, &replacement]);
    assert_eq!(
        history::current_path(&original, &id).unwrap_err(),
        AMBIGUOUS
    );
    assert!(!native::codex_home()
        .unwrap()
        .join("state_5.sqlite")
        .exists());
    unchanged(&before);
}

#[test]
fn codex_v2_stale_or_unusable_canonical_state_preserves_ambiguity() {
    for case in [
        "missing_row",
        "outside_path",
        "original_path",
        "corrupt",
        "schema",
        "locked",
    ] {
        let f = setup();
        let (id, original, replacement) = replacement_pair(&f);
        let mut lock = None;
        let state_path = native::codex_home().unwrap().join("state_5.sqlite");
        match case {
            "missing_row" => drop(state(5, &uuid::Uuid::new_v4().to_string(), &replacement)),
            "outside_path" => {
                let outside = f._home.path().join("outside.jsonl");
                fs::copy(&replacement, &outside).unwrap();
                drop(state(5, &id, &outside));
            }
            "original_path" => drop(state(5, &id, &original)),
            "corrupt" => fs::write(&state_path, b"not a SQLite database").unwrap(),
            "schema" => {
                let db = rusqlite::Connection::open(&state_path).unwrap();
                db.execute_batch("CREATE TABLE threads(id TEXT PRIMARY KEY)")
                    .unwrap();
            }
            "locked" => {
                let db = state(5, &id, &replacement);
                db.execute_batch("BEGIN EXCLUSIVE").unwrap();
                lock = Some(db);
            }
            _ => unreachable!(),
        }
        let before = snapshot(&[&original, &replacement]);
        assert_eq!(
            history::current_path(&original, &id).unwrap_err(),
            AMBIGUOUS,
            "{case}"
        );
        unchanged(&before);
        drop(lock);
    }
}

#[test]
fn codex_v2_never_falls_back_from_newer_invalid_state_to_older_selection() {
    for newer in ["corrupt", "missing_row", "symlink"] {
        let f = setup();
        let (id, original, replacement) = replacement_pair(&f);
        drop(state(4, &id, &replacement));
        let newer_path = native::codex_home().unwrap().join("state_5.sqlite");
        match newer {
            "corrupt" => fs::write(&newer_path, b"unreadable newer state").unwrap(),
            "missing_row" => drop(state(5, &uuid::Uuid::new_v4().to_string(), &replacement)),
            "symlink" => std::os::unix::fs::symlink(
                native::codex_home().unwrap().join("state_4.sqlite"),
                &newer_path,
            )
            .unwrap(),
            _ => unreachable!(),
        }
        let before = snapshot(&[&original, &replacement]);
        assert_eq!(
            history::current_path(&original, &id).unwrap_err(),
            AMBIGUOUS,
            "{newer}"
        );
        unchanged(&before);
    }
}

#[test]
fn codex_v2_canonical_candidate_must_keep_its_session_and_folder_identity() {
    for field in ["session_id", "cwd"] {
        let f = setup();
        let (id, original, replacement) = replacement_pair(&f);
        let mut altered = records(&f, &id, true, 0, "Complete v2 history");
        altered[0]["payload"][field] = if field == "session_id" {
            json!(uuid::Uuid::new_v4().to_string())
        } else {
            json!(f._home.path().join("another-project"))
        };
        fs::write(&replacement, native::encode(&altered)).unwrap();
        drop(state(5, &id, &replacement));
        let before = snapshot(&[&original, &replacement]);
        assert_eq!(
            history::current_path(&original, &id).unwrap_err(),
            AMBIGUOUS,
            "{field}"
        );
        unchanged(&before);
    }
}

#[test]
fn codex_v2_archived_canonical_replacement_does_not_resurrect_active_original() {
    let f = setup();
    let (id, original, replacement) = replacement_pair(&f);
    let archive = native::codex_home().unwrap().join("archived_sessions");
    fs::create_dir(&archive).unwrap();
    let archived = archive.join(replacement.file_name().unwrap());
    fs::rename(&replacement, &archived).unwrap();
    drop(state(5, &id, &archived));
    let before = snapshot(&[&original, &archived]);
    assert_eq!(history::current_path(&original, &id).unwrap(), archived);
    let catalog = local_resources::catalog(&f.db, &f.project, "session").unwrap();
    assert_eq!(catalog["errors"], json!([]));
    assert!(catalog["resources"].as_array().unwrap().is_empty());
    assert!(f.outbox().is_empty());
    unchanged(&before);
}

#[test]
fn codex_v2_compressed_canonical_replacement_preserves_native_bytes() {
    let f = setup();
    let (id, original, replacement) = replacement_pair(&f);
    let compressed = PathBuf::from(format!("{}.zst", replacement.display()));
    let bytes = fs::read(&replacement).unwrap();
    fs::write(
        &compressed,
        zstd::stream::encode_all(bytes.as_slice(), 1).unwrap(),
    )
    .unwrap();
    fs::remove_file(&replacement).unwrap();
    drop(state(5, &id, &compressed));
    let before = snapshot(&[&original, &compressed]);
    assert_eq!(history::current_path(&original, &id).unwrap(), compressed);
    assert_eq!(
        History::local(&compressed, Some(&f.root))
            .unwrap()
            .records(),
        records(&f, &id, true, 0, "Complete v2 history")
    );
    unchanged(&before);
}

#[test]
fn codex_v2_duplicate_warnings_are_unique_and_discovery_recovers_without_sync() {
    let f = setup();
    let (id, original, replacement) = replacement_pair(&f);
    let healthy_id = uuid::Uuid::new_v4().to_string();
    let healthy = write_rollout(
        &healthy_id,
        "",
        &records(&f, &healthy_id, false, 0, "Healthy neighbor"),
    );
    let broken = native::codex_home().unwrap().join("sessions/broken.jsonl");
    fs::write(&broken, b"invalid native JSON\n").unwrap();
    let before = snapshot(&[&original, &replacement, &healthy]);
    let first = local_resources::catalog(&f.db, &f.project, "session").unwrap();
    let errors = first["errors"].as_array().unwrap();
    assert_eq!(
        errors.len(),
        2,
        "one ambiguity diagnostic plus one distinct corrupt-file diagnostic"
    );
    assert_eq!(
        errors
            .iter()
            .filter(|error| error.as_str().unwrap().contains(AMBIGUOUS))
            .count(),
        1
    );
    assert_eq!(first["resources"].as_array().unwrap().len(), 1);
    drop(state(5, &id, &replacement));
    let second = local_resources::catalog(&f.db, &f.project, "session").unwrap();
    assert_eq!(second["errors"].as_array().unwrap().len(), 1);
    assert_eq!(second["resources"].as_array().unwrap().len(), 2);
    fs::remove_file(broken).unwrap();
    let recovered = local_resources::catalog(&f.db, &f.project, "session").unwrap();
    assert_eq!(recovered["errors"], json!([]));
    assert_eq!(recovered["resources"].as_array().unwrap().len(), 2);
    assert!(f.outbox().is_empty());
    unchanged(&before);
}

#[test]
fn codex_v2_mixed_marker_same_thread_segments_and_cross_thread_forks_keep_exact_prefixes() {
    for same_thread in [true, false] {
        let f = setup();
        let parent_id = uuid::Uuid::new_v4().to_string();
        let parent_records = records(&f, &parent_id, false, 0, "Inherited parent");
        let parent = write_rollout(&parent_id, "", &parent_records);
        let child_id = if same_thread {
            parent_id.clone()
        } else {
            uuid::Uuid::new_v4().to_string()
        };
        let mut child_records = records(&f, &child_id, true, 3, "V2 continuation");
        child_records[0]["payload"]["history_base"] = json!({"thread_id":parent_id,"end_ordinal_exclusive":3,"end_byte_offset":native::encode(&parent_records).len()});
        let child = write_rollout(
            &child_id,
            &format!("_{}", uuid::Uuid::new_v4()),
            &child_records,
        );
        let before = snapshot(&[&parent, &child]);
        assert_eq!(history::current_path(&child, &child_id).unwrap(), child);
        let history = History::local(&child, Some(&f.root)).unwrap();
        assert_eq!(history.rollouts.len(), 2);
        assert_eq!(history.rollouts[0].records, parent_records);
        assert_eq!(history.rollouts[1].records, child_records);
        unchanged(&before);
    }
}

#[test]
fn codex_v2_conflicting_inherited_prefixes_stay_blocked() {
    let f = setup();
    let id = uuid::Uuid::new_v4().to_string();
    let parent_records = records(&f, &id, false, 0, "Parent A");
    let parent = write_rollout(&id, "", &parent_records);
    let conflicting = write_rollout(
        &id,
        &format!("_{}", uuid::Uuid::new_v4()),
        &records(&f, &id, false, 0, "Parent B"),
    );
    let mut child_records = records(&f, &id, true, 3, "V2 continuation");
    child_records[0]["payload"]["history_base"] = json!({"thread_id":id,"end_ordinal_exclusive":3,"end_byte_offset":native::encode(&parent_records).len()});
    let child = write_rollout(&id, &format!("_{}", uuid::Uuid::new_v4()), &child_records);
    drop(state(5, &id, &child));
    let before = snapshot(&[&parent, &conflicting, &child]);
    assert!(History::local(&child, Some(&f.root))
        .err()
        .unwrap()
        .contains("Ambiguous inherited history"));
    unchanged(&before);
}

#[test]
fn codex_v2_uses_numeric_latest_state_and_preserves_identical_compressed_copies() {
    let f = setup();
    let (id, original, replacement) = replacement_pair(&f);
    let newer = write_rollout(
        &id,
        &format!("_{}", uuid::Uuid::new_v4()),
        &records(&f, &id, true, 0, "Current v2 generation"),
    );
    let compressed = PathBuf::from(format!("{}.zst", newer.display()));
    let bytes = fs::read(&newer).unwrap();
    fs::write(
        &compressed,
        zstd::stream::encode_all(bytes.as_slice(), 1).unwrap(),
    )
    .unwrap();
    drop(state(9, &id, &replacement));
    drop(state(10, &id, &compressed));
    let before = snapshot(&[&original, &replacement, &newer, &compressed]);
    assert_eq!(history::current_path(&original, &id).unwrap(), compressed);
    let catalog = local_resources::catalog(&f.db, &f.project, "session").unwrap();
    assert_eq!(catalog["errors"], json!([]));
    assert_eq!(catalog["resources"].as_array().unwrap().len(), 1);
    assert_eq!(catalog["resources"][0]["title"], "Current v2 generation");
    unchanged(&before);
    assert!(f.outbox().is_empty());
}
