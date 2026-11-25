use super::{blob_hash, candidate, inspect, lock_for_apply, open_lock, RUNTIME_LOCK};
use crate::{db, native};
use fs2::FileExt;
use serde_json::{json, Value};
use std::{
    fs::{self, File},
    os::unix::fs::symlink,
    path::{Path, PathBuf},
};
use uuid::Uuid;

fn transcript(tool: &str, text: &str) -> Vec<u8> {
    let id = Uuid::new_v4();
    if tool == "codex" {
        return native::encode(&[
            json!({"type":"session_meta","payload":{"id":id,"cwd":"/synthetic","history_mode":"legacy"}}),
            json!({"type":"event_msg","payload":{"type":"user_message","message":text}}),
        ]);
    }
    native::encode(&[
        json!({"type":"queue-operation","operation":"enqueue"}),
        json!({"type":"user","sessionId":id,"cwd":"/synthetic","message":{"role":"user","content":text}}),
    ])
}

fn write_blob(directory: &Path, bytes: &[u8]) -> (String, PathBuf) {
    fs::create_dir_all(directory).unwrap();
    let hash = db::digest(bytes);
    let path = directory.join(&hash);
    fs::write(&path, bytes).unwrap();
    (hash, path)
}

fn manifest(hash: &str) -> Value {
    json!({"resource":{"kind":"session","files":[{"path":"session.jsonl","hash":hash}]}})
}

#[test]
fn cleanup_preserves_every_durable_reference_across_legacy_and_service_accounts() {
    let state = tempfile::tempdir().unwrap();
    let root = state.path();
    let legacy = root.join("blobs");
    let service_id = db::digest(b"https://fixture.invalid");
    let service = root.join("services").join(service_id);
    let scoped = service.join("blobs");
    let legacy_db = db::open_at(&root.join(Uuid::new_v4().to_string())).unwrap();
    let service_db = db::open_at(&service.join(Uuid::new_v4().to_string())).unwrap();
    let guest_db = db::open_at(&root.join("guest")).unwrap();

    let mut pinned = Vec::new();
    for table in [
        "resources",
        "bindings",
        "drafts",
        "local_resources",
        "conflicts",
    ] {
        let (hash, blob) = write_blob(&legacy, &transcript("codex", table));
        db::upsert(&service_db, table, table, "project", &manifest(&hash)).unwrap();
        pinned.push(blob);
    }
    let (hash, blob) = write_blob(&scoped, &transcript("claude", "outbox"));
    legacy_db
        .execute(
            "INSERT INTO outbox VALUES ('queued','project','/v2/change',?,NULL)",
            [manifest(&hash).to_string()],
        )
        .unwrap();
    pinned.push(blob);
    for key in [
        "sessionCopy:pending",
        "sessionOutboxRedaction:sending",
        "queuedExport:manifest",
    ] {
        let (hash, blob) = write_blob(&scoped, &transcript("claude", key));
        db::set(&guest_db, key, &manifest(&hash)).unwrap();
        pinned.push(blob);
    }
    let (soon, preview) = write_blob(&legacy, &transcript("claude", "frozen preview"));
    db::set(
        &guest_db,
        "share-preview:current",
        &json!({"expires":100,"change":manifest(&soon)}),
    )
    .unwrap();
    pinned.push(preview);
    let (hash, unknown_preview) = write_blob(&legacy, &transcript("claude", "old format preview"));
    db::set(
        &guest_db,
        "share-preview:unknown",
        &json!({"change":manifest(&hash)}),
    )
    .unwrap();
    pinned.push(unknown_preview);

    let (old, expired) = write_blob(&scoped, &transcript("claude", "expired"));
    db::set(
        &legacy_db,
        "share-preview:expired",
        &json!({"expires":99,"change":manifest(&old)}),
    )
    .unwrap();
    let (cached, cache_only) = write_blob(&legacy, &transcript("codex", "rebuildable scan"));
    db::set(
        &legacy_db,
        "scanCache:v3-0.3.25:session:synthetic",
        &manifest(&cached),
    )
    .unwrap();
    let (catalog, catalog_only) = write_blob(&scoped, &transcript("codex", "metadata-only row"));
    let mut metadata = manifest(&catalog);
    metadata["resource"]["nativeSession"] = true.into();
    db::upsert(
        &legacy_db,
        "local_resources",
        "metadata",
        "project",
        &metadata,
    )
    .unwrap();
    let (hash, published_old) =
        write_blob(&scoped, &transcript("claude", "superseded publication"));
    db::set(&service_db, "selected-share:done", &json!({"status":"published","result":{"status":"published","receipt":{"event":manifest(&hash)}}})).unwrap();
    let (_, other_resource) = write_blob(&scoped, b"# Memory resource\n");
    drop((legacy_db, service_db, guest_db));

    let dry = inspect(root, "fixture", false, 100);
    assert!(!dry.blocked);
    assert_eq!(dry.scopes.len(), 2);
    assert_eq!(dry.scopes[0].eligible_count, 1);
    assert_eq!(dry.scopes[1].eligible_count, 3);
    assert!(dry.scopes.iter().all(|scope| scope.removed_count == 0));
    assert!(dry
        .scopes
        .iter()
        .all(|scope| scope.eligible_allocated_bytes > 0));
    assert!(!root.join(RUNTIME_LOCK).exists());
    assert!(expired.exists() && cache_only.exists() && catalog_only.exists());

    let applied = inspect(root, "fixture", true, 100);
    assert!(!applied.blocked);
    assert_eq!(applied.scopes[0].removed_count, 1);
    assert_eq!(applied.scopes[1].removed_count, 3);
    assert!(!expired.exists() && !cache_only.exists() && !catalog_only.exists());
    assert!(!published_old.exists());
    pinned.push(other_resource);
    for path in pinned {
        let bytes = fs::read(&path).unwrap();
        assert_eq!(
            db::digest(&bytes),
            path.file_name().unwrap().to_str().unwrap()
        );
    }
    assert!(inspect(root, "fixture", true, 100)
        .scopes
        .iter()
        .all(|scope| scope.removed_count == 0));
}

#[test]
fn cleanup_skips_live_profiles_unsafe_files_and_ambiguous_databases() {
    let state = tempfile::tempdir().unwrap();
    let root = state.path();
    let db_path = root.join("guest");
    let database = db::open_at(&db_path).unwrap();
    db::set(
        &database,
        "pending",
        &json!({"hash":db::digest(b"pending")}),
    )
    .unwrap();
    let (_, reclaimable) = write_blob(&root.join("blobs"), &transcript("codex", "orphan"));
    let dry = inspect(root, "fixture", false, 100);
    assert!(dry.blocked);
    assert_eq!(dry.scopes[0].skips["database_has_journal"], 1);
    drop(database);

    let reader = open_lock(root, RUNTIME_LOCK).unwrap();
    FileExt::try_lock_shared(&reader).unwrap();
    let busy = inspect(root, "fixture", true, 100);
    assert!(busy.blocked);
    assert_eq!(busy.scopes[0].skips["profile_in_use"], 1);
    assert!(reclaimable.exists());
    drop(reader);

    let outside = root.join("native-session.jsonl");
    fs::write(&outside, transcript("claude", "native original")).unwrap();
    let symlink_path = root
        .join("blobs")
        .join(db::digest(&fs::read(&outside).unwrap()));
    symlink(&outside, &symlink_path).unwrap();
    let invalid = root.join("blobs").join("a".repeat(64));
    fs::write(&invalid, transcript("codex", "bad digest")).unwrap();
    let hardlink = root.join("blobs").join("c".repeat(64));
    fs::hard_link(&outside, &hardlink).unwrap();
    let ambiguous = root.join(Uuid::new_v4().to_string());
    symlink(&db_path, &ambiguous).unwrap();
    let blocked = inspect(root, "fixture", true, 100);
    assert!(blocked.blocked);
    assert!(reclaimable.exists());
    fs::remove_file(ambiguous).unwrap();
    let missing = root.join(Uuid::new_v4().to_string());
    fs::create_dir(&missing).unwrap();
    assert_eq!(
        inspect(root, "fixture", true, 100).scopes[0].skips["missing_database"],
        1
    );
    fs::write(missing.join("sync.sqlite"), b"corrupt").unwrap();
    assert_eq!(
        inspect(root, "fixture", true, 100).scopes[0].skips["invalid_database"],
        1
    );
    fs::remove_file(missing.join("sync.sqlite")).unwrap();
    fs::remove_dir(missing).unwrap();

    let applied = inspect(root, "fixture", true, 100);
    assert!(!applied.blocked);
    assert_eq!(applied.scopes[0].removed_count, 1);
    assert!(!reclaimable.exists());
    assert!(symlink_path.is_symlink() && outside.exists() && invalid.exists() && hardlink.exists());
}

#[test]
fn cleanup_resumes_after_partial_unlink() {
    let state = tempfile::tempdir().unwrap();
    let root = state.path();
    drop(db::open_at(&root.join("guest")).unwrap());
    let blobs = root.join("blobs");
    let (first_hash, first) = write_blob(&blobs, &transcript("codex", "first"));
    let (_, second) = write_blob(&blobs, &transcript("claude", "second"));
    {
        let _locks = lock_for_apply(root).unwrap();
        let dir = File::open(blobs).unwrap();
        assert!(blob_hash(&first_hash));
        candidate(&dir, &first, &first_hash, true).unwrap();
        assert!(!first.exists());
        assert!(second.exists());
    }
    assert_eq!(
        inspect(root, "fixture", true, 100).scopes[0].removed_count,
        1
    );
    assert_eq!(
        inspect(root, "fixture", true, 100).scopes[0].removed_count,
        0
    );
}

#[test]
fn cleanup_requires_a_database_for_an_existing_legacy_store() {
    let state = tempfile::tempdir().unwrap();
    let root = state.path();
    let service_origin = "https://legacy.example.invalid";
    let matching_service = root
        .join("services")
        .join(db::digest(service_origin.as_bytes()));
    let database = db::open_at(&matching_service.join(Uuid::new_v4().to_string())).unwrap();
    let (_, original) = write_blob(&root.join("blobs"), &transcript("codex", "unreferenced"));
    drop(database);

    let ambiguous = inspect(root, "fixture", true, 100);
    assert!(ambiguous.blocked);
    assert_eq!(ambiguous.scopes[0].skips["missing_database"], 1);
    assert!(original.is_file());

    db::atomic(
        &root.join("legacy-service.json"),
        json!(service_origin).to_string().as_bytes(),
    )
    .unwrap();
    let applied = inspect(root, "fixture", true, 100);
    assert!(!applied.blocked);
    assert_eq!(applied.scopes[0].removed_count, 1);
    assert!(!original.exists());
}

#[test]
fn cleanup_preserves_a_pending_snapshot_from_an_uncheckpointed_wal() {
    let state = tempfile::tempdir().unwrap();
    let source = state.path().join("source");
    let root = state.path().join("fixture");
    let guest = root.join("guest");
    fs::create_dir_all(&guest).unwrap();
    let database = db::open_at(&source).unwrap();
    database
        .execute_batch("PRAGMA wal_checkpoint(TRUNCATE); PRAGMA wal_autocheckpoint=0;")
        .unwrap();
    let (hash, pending) = write_blob(
        &root.join("blobs"),
        &transcript("codex", "uncheckpointed pending snapshot"),
    );
    db::set(&database, "sessionCopy:pending", &manifest(&hash)).unwrap();
    for name in ["sync.sqlite", "sync.sqlite-wal"] {
        fs::copy(source.join(name), guest.join(name)).unwrap();
    }
    drop(database);
    assert!(guest.join("sync.sqlite-wal").metadata().unwrap().len() > 0);
    assert!(!guest.join("sync.sqlite-shm").exists());

    let dry = inspect(&root, "fixture", false, 100);
    assert_eq!(dry.scopes[0].skips["database_has_journal"], 1);
    assert!(!guest.join("sync.sqlite-shm").exists());

    let applied = inspect(&root, "fixture", true, 100);
    assert!(!applied.blocked);
    assert_eq!(applied.scopes[0].removed_count, 0);
    assert_eq!(applied.scopes[0].skips["referenced"], 1);
    assert_eq!(db::digest(&fs::read(pending).unwrap()), hash);
}
