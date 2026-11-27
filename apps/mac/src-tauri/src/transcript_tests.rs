use super::*;
use crate::transcript::{close_transcript, open_transcript, read_transcript};

fn publish_fixture(f: &Fixture, source: &str, bytes: &[u8]) -> Value {
    let resource = json!({
        "resourceId":uuid::Uuid::new_v4().to_string(),"projectId":f.project["id"],
        "kind":"session","source":source,"owner":db::get(&f.db,"user").unwrap(),
        "logicalPath":format!("{source}/transcript-range-test"),"title":"Transcript range test",
        "revision":1,"deleted":false,
        "files":[{"path":"session.jsonl","hash":db::blob(bytes).unwrap(),"size":bytes.len()}]
    });
    store_resource(f, &resource);
    resource
}

fn store_resource(f: &Fixture, resource: &Value) {
    db::upsert(
        &f.db,
        "resources",
        resource["resourceId"].as_str().unwrap(),
        f.project["id"].as_str().unwrap(),
        resource,
    )
    .unwrap();
}

fn open(resource: &Value, conflict: Option<String>) -> Value {
    let id = resource["resourceId"].as_str().unwrap().to_owned();
    serde_json::to_value(tauri::async_runtime::block_on(open_transcript(id, conflict)).unwrap())
        .unwrap()
}

fn page(id: &str, offset: Option<u64>, budget: usize, before: bool) -> Value {
    let page = tauri::async_runtime::block_on(read_transcript(
        id.to_owned(),
        offset,
        budget,
        Some(before),
    ))
    .unwrap();
    serde_json::to_value(page).unwrap()
}

fn verify_parity(resource: &Value, reader_id: &str, budget: usize) {
    let expected = native::transcript(&crate::history::resource_records(resource).unwrap());
    let head = page(reader_id, Some(0), budget, false);
    assert_eq!(head["offset"], 0);
    let end = head["nextOffset"].as_u64().unwrap() as usize;
    assert_eq!(head["text"], &expected[..end]);
    assert_eq!(head["eof"], end == expected.len());
    let tail = page(reader_id, None, budget, false);
    assert_eq!(tail["eof"], true, "End must find EOF");
    let offset = tail["offset"].as_u64().unwrap() as usize;
    assert_eq!(tail["text"], &expected[offset..]);
    let mut offset = 0_u64;
    let mut actual = String::new();
    loop {
        let p = page(reader_id, Some(offset), budget, false);
        let text = p["text"].as_str().unwrap();
        assert_eq!(p["offset"], offset);
        assert!(text.len() <= budget);
        actual.push_str(text);
        let next = p["nextOffset"].as_u64().unwrap();
        assert_eq!(next - offset, text.len() as u64);
        offset = next;
        if p["eof"] == true {
            break;
        }
        assert!(!text.is_empty(), "A byte cursor must always advance");
    }
    assert_eq!(actual, expected);
    let mut start = actual.len() as u64;
    let mut pages = Vec::new();
    while start != 0 {
        let p = page(reader_id, Some(start), budget, true);
        let normalized = p["offset"].as_u64().unwrap();
        let text = p["text"].as_str().unwrap();
        assert_eq!(p["nextOffset"], start);
        assert_eq!(start - normalized, text.len() as u64);
        assert!(start > normalized && text.len() <= budget);
        start = normalized;
        pages.push(text.to_owned());
    }
    assert_eq!(pages.iter().rev().cloned().collect::<String>(), expected);
}

fn read_conversation(resource: &Value, conflict: Option<String>) -> crate::db::Result<Value> {
    tauri::async_runtime::block_on(crate::commands::session_messages(
        resource["resourceId"].as_str().unwrap().to_owned(),
        conflict,
        None,
        Some(1),
    ))
}

#[test]
fn conversation_transcript_prefix_preserves_lineage_and_authenticates_all_segments() {
    let f = Fixture::new();
    let (resource, _) = paginated_chain(&f);
    store_resource(&f, &resource);
    read_conversation(&resource, None).unwrap();
    let scope = db::CacheScope::current().unwrap();
    let hash = crate::commands::session_snapshot_hash(&resource);
    assert!(
        crate::commands::cached_transcript_prefix(&scope, &resource, None)
            .unwrap()
            .is_some()
    );
    assert!(
        crate::commands::cached_transcript_prefix(&scope, &resource, Some("other"))
            .unwrap()
            .is_none()
    );
    let mut changed = resource.clone();
    changed["files"][0]["size"] = json!(0);
    assert_eq!(crate::commands::session_snapshot_hash(&changed), hash);
    assert!(
        crate::commands::cached_transcript_prefix(&scope, &changed, None)
            .unwrap()
            .is_none()
    );
    let mut reordered = resource.clone();
    reordered["files"].as_array_mut().unwrap().reverse();
    assert_eq!(crate::commands::session_snapshot_hash(&reordered), hash);
    assert!(
        crate::commands::cached_transcript_prefix(&scope, &reordered, None)
            .unwrap()
            .is_none()
    );
    let mut changed = resource.clone();
    changed["source"] = json!("claude");
    assert!(
        crate::commands::cached_transcript_prefix(&scope, &changed, None)
            .unwrap()
            .is_none()
    );
    let opened = open(&resource, None);
    let id = opened["readerId"].as_str().unwrap();
    verify_parity(&resource, id, 37);
    close_transcript(id.into()).unwrap();

    let leaf = resource["files"]
        .as_array()
        .unwrap()
        .iter()
        .find(|f| f["path"] == "session.jsonl")
        .unwrap();
    let blob = db::blob_path(leaf["hash"].as_str().unwrap()).unwrap();
    let mut bytes = fs::read(&blob).unwrap();
    let last = bytes.len() - 2;
    bytes[last] ^= 1;
    fs::write(&blob, bytes).unwrap();
    let opened = open(&resource, None);
    let id = opened["readerId"].as_str().unwrap();
    let error =
        tauri::async_runtime::block_on(read_transcript(id.into(), Some(0), 32, None)).unwrap_err();
    assert_eq!(error, "Blob hash mismatch");
}

#[test]
fn warm_transcript_prefix_joins_a_four_byte_scalar_at_the_page_boundary() {
    let f = Fixture::new();
    let limit = 32 * 1024;
    let content = "z".repeat(limit - "## user\n\n".len() - 1) + "🧪🧪";
    let records = [json!({"type":"user","message":{"role":"user","content":content}})];
    let expected = native::transcript(&records);
    let resource = publish_fixture(&f, "claude", &native::encode(&records));
    read_conversation(&resource, None).unwrap();
    let opened = open(&resource, None);
    let id = opened["readerId"].as_str().unwrap();
    let first = page(id, Some(0), limit, false);
    assert_eq!(first["text"], &expected[..limit - 1]);
    assert_eq!(first["eof"], false);
    assert_eq!(page(id, Some((limit - 8) as u64), 4, false)["text"], "zzzz");
    let next = page(id, first["nextOffset"].as_u64(), 4, false);
    assert_eq!(next["text"], "🧪");
    assert_eq!(page(id, None, 6, false)["text"], "🧪\n\n");
    close_transcript(id.into()).unwrap();
}

#[test]
fn warm_transcript_retains_the_record_limit_including_the_unfinished_tail() {
    let f = Fixture::new();
    let mut bytes =
        native::encode(&[json!({"type":"user","message":{"content":"a small visible message"}})]);
    bytes.extend(std::iter::repeat_n(b'x', 16 * 1024 * 1024 + 1));
    let resource = publish_fixture(&f, "claude", &bytes);
    read_conversation(&resource, None).unwrap();
    let opened = open(&resource, None);
    let id = opened["readerId"].as_str().unwrap();
    let error =
        tauri::async_runtime::block_on(read_transcript(id.into(), Some(0), 32, None)).unwrap_err();
    assert_eq!(error, crate::transcript::PREVIEW_TOO_LARGE);
}

#[test]
fn transcript_ranges_preserve_codex_ancestry_and_exact_deduplication() {
    let fixture = Fixture::new();
    let (resource, _) = paginated_chain(&fixture);
    store_resource(&fixture, &resource);
    let opened = open(&resource, None);
    let reader = opened["readerId"].as_str().unwrap();
    assert_eq!(
        page(reader, None, 37, false)["eof"],
        true,
        "Cold End must find EOF without a previous page"
    );
    verify_parity(&resource, reader, 37);
    close_transcript(reader.into()).unwrap();
    assert!(tauri::async_runtime::block_on(read_transcript(
        reader.into(),
        Some(0),
        32 * 1024,
        None
    ))
    .is_err());
}

#[test]
fn transcript_ranges_follow_persisted_pi_branch() {
    let fixture = Fixture::new();
    let records = [
        json!({"type":"session","version":3,"id":uuid::Uuid::new_v4().to_string(),"cwd":fixture.root}),
        json!({"type":"message","id":"first","parentId":null,"message":{"role":"user","content":"Begin π 🧪"}}),
        json!({"type":"message","id":"other","parentId":"first","message":{"role":"assistant","content":"A different branch"}}),
        json!({"type":"message","id":"current","parentId":"first","message":{"role":"assistant","content":"Current branch 🐈"}}),
        json!({"type":"custom","id":"heading","parentId":"current"}),
    ];
    let resource = publish_fixture(&fixture, "pi", &native::encode(&records));
    read_conversation(&resource, None).unwrap();
    assert!(crate::commands::cached_transcript_prefix(
        &db::CacheScope::current().unwrap(),
        &resource,
        None
    )
    .unwrap()
    .is_none());
    let opened = open(&resource, None);
    let reader = opened["readerId"].as_str().unwrap();
    verify_parity(&resource, reader, 13);
    close_transcript(reader.into()).unwrap();
}

#[test]
fn transcript_ranges_bound_large_claude_tool_records_and_reject_changed_snapshot() {
    let fixture = Fixture::new();
    let records = [
        json!({"type":"user","message":{"role":"user","content":"Start 🌊"}}),
        json!({"type":"assistant","message":{"role":"assistant","content":[
            {"type":"text","text":"Visible ☀️"},
            {"type":"tool_use","id":"test","output":"🔎\r\n xyz".repeat(18_000)}
        ]}}),
    ];
    let mut bytes = native::encode(&records);
    bytes.extend_from_slice(b"{incomplete");
    let mut resource = publish_fixture(&fixture, "claude", &bytes);
    read_conversation(&resource, None).unwrap();
    let opened = open(&resource, None);
    let reader = opened["readerId"].as_str().unwrap();
    verify_parity(&resource, reader, 32 * 1024);
    let changed = native::encode(&records[..1]);
    resource["files"][0] =
        json!({"path":"session.jsonl","hash":db::blob(&changed).unwrap(),"size":changed.len()});
    store_resource(&fixture, &resource);
    let error =
        tauri::async_runtime::block_on(read_transcript(reader.into(), Some(0), 32 * 1024, None))
            .unwrap_err();
    assert_eq!(error, crate::transcript::SNAPSHOT_INVALIDATED);
}

#[test]
fn transcript_ranges_use_the_authorized_conflict_manifest_for_reading_and_download() {
    let fixture = Fixture::new();
    let resource = publish_fixture(
        &fixture,
        "claude",
        &native::encode(&[json!({"type":"user","message":{"role":"user","content":"Accepted"}})]),
    );
    let id = uuid::Uuid::new_v4().to_string();
    let bytes =
        native::encode(&[json!({"type":"user","message":{"role":"user","content":"Incoming 🧪"}})]);
    let mut candidate = resource.clone();
    candidate["files"][0] =
        json!({"path":"session.jsonl","hash":db::blob(&bytes).unwrap(),"size":bytes.len()});
    db::upsert(
        &fixture.db,
        "conflicts",
        &id,
        fixture.project["id"].as_str().unwrap(),
        &json!({"id":id,"resourceId":resource["resourceId"],"candidate":candidate}),
    )
    .unwrap();
    let opened = open(&resource, Some(id.clone()));
    assert_eq!(opened["sessionSnapshot"]["conflictId"], id);
    let reader = opened["readerId"].as_str().unwrap();
    verify_parity(&candidate, reader, 32 * 1024);
    let download = fixture.root.join("incoming-range-test.zip");
    crate::commands::export_bundle(
        resource["resourceId"].as_str().unwrap().into(),
        download.to_string_lossy().into(),
        Some(serde_json::from_value(opened["sessionSnapshot"].clone()).unwrap()),
    )
    .unwrap();
    assert!(download.is_file());
    close_transcript(reader.into()).unwrap();
}

#[test]
fn private_transcript_range_and_download_use_the_same_native_snapshot_without_blobs() {
    use crate::local_resources;

    let mut fixture = Fixture::new();
    local_resource_tests::prepare(&mut fixture);
    let catalog = local_resources::catalog(&fixture.db, &fixture.project, "session").unwrap();
    let id = catalog["resources"][0]["resourceId"].as_str().unwrap();
    let resource = local_resources::resource(&fixture.db, id).unwrap();
    assert_eq!(resource["nativeSession"], true);
    let path = PathBuf::from(resource["paths"][0].as_str().unwrap());
    // The native source can grow since the last catalog scan. Opening and
    // download must use the fresh redacted manifest in both cases.
    let original = fs::read(&path).unwrap();
    let mut bytes = original.clone();
    bytes.extend(native::encode(&[json!({"type":"event_msg","payload":{"type":"user_message","message":"A private turn after the catalog scan 🧪"}})]));
    fs::write(&path, bytes).unwrap();
    let live = crate::session_forks::reading_resource(&fixture.db, &resource).unwrap();
    assert!(live.is_live());
    assert_ne!(live.resource["files"], resource["files"]);
    let expected = native::transcript(&live.records().unwrap());
    assert!(expected.contains("A private turn after the catalog scan 🧪"));

    let opened = open(&resource, None);
    let reader = opened["readerId"].as_str().unwrap();
    assert_eq!(page(reader, Some(0), 16 * 1024, false)["text"], expected);
    assert_eq!(page(reader, None, 16 * 1024, false)["text"], expected);
    assert_eq!(
        opened["sessionSnapshot"]["snapshotHash"],
        crate::commands::session_snapshot_hash(&live.resource)
    );
    let download = fixture.root.join("private-transcript-range-test.zip");
    crate::commands::export_bundle(
        id.into(),
        download.to_string_lossy().into(),
        Some(serde_json::from_value(opened["sessionSnapshot"].clone()).unwrap()),
    )
    .unwrap();
    let mut zip = zip::ZipArchive::new(fs::File::open(download).unwrap()).unwrap();
    let mut archived = String::new();
    zip.by_name("transcript.md")
        .unwrap()
        .read_to_string(&mut archived)
        .unwrap();
    assert_eq!(archived, expected);
    for file in live.resource["files"].as_array().unwrap() {
        assert!(!db::blob_path(file["hash"].as_str().unwrap())
            .unwrap()
            .exists());
    }
    local_resources::catalog(&fixture.db, &fixture.project, "session").unwrap();
    let refreshed = local_resources::resource(&fixture.db, id).unwrap();
    assert_eq!(
        opened["sessionSnapshot"]["snapshotHash"],
        crate::commands::session_snapshot_hash(&refreshed)
    );
    assert_eq!(page(reader, Some(0), 16 * 1024, false)["text"], expected);

    // Rolling back to the first catalog manifest must invalidate the reader
    // once discovery has observed the live version that the user opened.
    fs::write(&path, original).unwrap();
    local_resources::catalog(&fixture.db, &fixture.project, "session").unwrap();
    let result = tauri::async_runtime::block_on(read_transcript(reader.into(), None, 32, None));
    assert_eq!(result.unwrap_err(), crate::transcript::SNAPSHOT_INVALIDATED);
}

#[test]
fn unchanged_private_codex_reads_a_redacted_prefix_and_pins_the_remaining_native_bytes() {
    let mut f = Fixture::new();
    local_resource_tests::prepare(&mut f);
    let sessions = native::codex_home().unwrap().join("sessions");
    let path = fs::read_dir(sessions)
        .unwrap()
        .next()
        .unwrap()
        .unwrap()
        .path();
    let mut records = native::complete_records(&fs::read(&path).unwrap()).unwrap();
    let secret = format!("ghp_{}", "1234567890".repeat(3));
    records.extend([
        json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":format!("{secret} {}", "🗓".repeat(24_000))}]}}),
        json!({"type":"event_msg","payload":{"type":"agent_message","message":"last exact turn"}}),
    ]);
    fs::write(&path, native::encode(&records)).unwrap();
    let catalog = crate::local_resources::catalog(&f.db, &f.project, "session").unwrap();
    let id = catalog["resources"][0]["resourceId"].as_str().unwrap();
    let resource = crate::local_resources::resource(&f.db, id).unwrap();
    let opened = open(&resource, None);
    let reader = opened["readerId"].as_str().unwrap();
    assert!(crate::transcript::has_captured_input(reader));
    assert_eq!(
        opened["sessionSnapshot"]["snapshotHash"],
        crate::commands::session_snapshot_hash(&resource)
    );

    let mut edited = records.clone();
    edited.last_mut().unwrap()["payload"]["message"] = json!("next exact turn");
    records
        .iter_mut()
        .for_each(crate::session_redaction::SessionRedactor::redact);
    let expected = native::transcript(&records);
    let zip_path = f.root.join("pinned-private.zip");
    let download = || {
        crate::commands::export_bundle(
            id.into(),
            zip_path.to_string_lossy().into(),
            Some(serde_json::from_value(opened["sessionSnapshot"].clone()).unwrap()),
        )
    };
    download().unwrap();
    let mut archive = zip::ZipArchive::new(fs::File::open(&zip_path).unwrap()).unwrap();
    let mut transcript = String::new();
    archive
        .by_name("transcript.md")
        .unwrap()
        .read_to_string(&mut transcript)
        .unwrap();
    assert_eq!(transcript, expected);

    // Even a same-length edit before the first page must leave the existing
    // reader immutable and force a fresh capture on the next open.
    let changed = native::encode(&edited);
    assert_eq!(changed.len() as u64, fs::metadata(&path).unwrap().len());
    fs::write(&path, changed).unwrap();
    assert_eq!(download().unwrap_err(), "session_snapshot_changed");
    let head = page(reader, Some(0), 16 * 1024, false);
    assert_eq!(
        head["text"],
        expected[..head["nextOffset"].as_u64().unwrap() as usize]
    );
    assert!(head["text"].as_str().unwrap().contains("[REDACTED]"));
    assert!(!head["text"].as_str().unwrap().contains(&secret));
    let mut next = head["nextOffset"].as_u64().unwrap();
    // Scrolling beyond the first 32 KiB should serve another exact page
    // while the unread tail is still unformatted.
    for _ in 0..2 {
        let forward = page(reader, Some(next), 16 * 1024, false);
        let offset = next as usize;
        next = forward["nextOffset"].as_u64().unwrap();
        assert_eq!(forward["text"], expected[offset..next as usize]);
    }
    assert!(crate::transcript::has_captured_input(reader));
    let end = page(reader, None, 16 * 1024, false);
    assert_eq!(
        end["text"],
        expected[end["offset"].as_u64().unwrap() as usize..]
    );
    assert!(!crate::transcript::has_captured_input(reader));
    close_transcript(reader.into()).unwrap();
    let fresh = open(&resource, None);
    assert_ne!(fresh["sessionSnapshot"], opened["sessionSnapshot"]);
    let fresh_reader = fresh["readerId"].as_str().unwrap();
    assert!(!crate::transcript::has_captured_input(fresh_reader));
    assert!(page(fresh_reader, None, 1024, false)["text"]
        .as_str()
        .unwrap()
        .contains("next exact turn"));
    close_transcript(fresh_reader.into()).unwrap();
}

#[test]
fn missing_or_mismatched_raw_hash_uses_the_full_private_snapshot() {
    let mut f = Fixture::new();
    local_resource_tests::prepare(&mut f);
    let catalog = crate::local_resources::catalog(&f.db, &f.project, "session").unwrap();
    let id = catalog["resources"][0]["resourceId"].as_str().unwrap();
    let resource = crate::local_resources::resource(&f.db, id).unwrap();
    for raw_hash in [Some("different bytes with the same stamps"), None] {
        // Simulate a coarse-timestamp filesystem or a cache from an earlier build.
        let changed = f.db.execute(
            "UPDATE meta SET value=json_set(value,'$.raw_hash',?1) WHERE key LIKE 'scanCache:%:session:%' AND json_extract(value,'$.files[0].hash')=?2",
            rusqlite::params![raw_hash,resource["files"][0]["hash"].as_str().unwrap()],
        ).unwrap();
        assert_eq!(changed, 1);
        let opened = open(&resource, None);
        let reader = opened["readerId"].as_str().unwrap();
        assert!(!crate::transcript::has_captured_input(reader));
        assert!(page(reader, Some(0), 16 * 1024, false)["text"]
            .as_str()
            .unwrap()
            .contains("Private conversation"));
        close_transcript(reader.into()).unwrap();
    }
}

#[test]
fn unchanged_private_claude_reads_exact_redacted_ranges_from_the_captured_file() {
    let mut f = Fixture::new();
    local_resource_tests::prepare(&mut f);
    let home = native::claude_home().unwrap().join("projects/test");
    fs::create_dir_all(&home).unwrap();
    let native_id = uuid::Uuid::new_v4().to_string();
    let path = home.join(format!("{native_id}.jsonl"));
    let mut records = vec![
        json!({"type":"user","sessionId":native_id,"cwd":f.root,"message":{"role":"user","content":"Private Claude message"}}),
        json!({"type":"assistant","sessionId":native_id,"message":{"role":"assistant","content":[{"type":"tool_use","input":{"api_key":"private-token","body":"本".repeat(18_000)}}]}}),
        json!({"type":"assistant","sessionId":native_id,"message":{"role":"assistant","content":"Claude end"}}),
    ];
    let mut bytes = native::encode(&records);
    bytes.extend(b"{partial writer record");
    fs::write(&path, bytes).unwrap();
    let catalog = crate::local_resources::catalog(&f.db, &f.project, "session").unwrap();
    let summary = catalog["resources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|row| row["source"] == "claude")
        .unwrap();
    let resource =
        crate::local_resources::resource(&f.db, summary["resourceId"].as_str().unwrap()).unwrap();
    let opened = open(&resource, None);
    let reader = opened["readerId"].as_str().unwrap();
    assert!(crate::transcript::has_captured_input(reader));
    records
        .iter_mut()
        .for_each(crate::session_redaction::SessionRedactor::redact);
    let expected = native::transcript(&records);
    assert!(expected.contains("[REDACTED]"));
    assert!(!expected.contains("private-token"));
    let mut result = String::new();
    loop {
        let page = page(reader, Some(result.len() as u64), 16 * 1024, false);
        result.push_str(page["text"].as_str().unwrap());
        if page["eof"] == true {
            break;
        }
    }
    assert_eq!(result, expected);
    assert!(!crate::transcript::has_captured_input(reader));
    close_transcript(reader.into()).unwrap();
}

#[test]
fn private_transcript_ranges_use_the_exact_cached_manifest_if_the_native_file_is_missing() {
    use crate::local_resources;

    let mut fixture = Fixture::new();
    local_resource_tests::prepare(&mut fixture);
    let entry = crate::indexer::discover(&fixture.db, &fixture.project, "session")
        .unwrap()
        .remove(0);
    let id = entry["resource"]["resourceId"].as_str().unwrap();
    let input = json!({"kind":"session","resourceId":id,"accountId":db::get(&fixture.db,"user").unwrap(),"serviceOrigin":"https://fixture.invalid"});
    let frozen =
        crate::selective_sharing::preview_from_local(&fixture.db, &fixture.project, &input, &entry)
            .unwrap();
    fs::remove_file(entry["paths"][0].as_str().unwrap()).unwrap();
    let resource = local_resources::resource(&fixture.db, id).unwrap();
    assert_eq!(resource["nativeSession"], true);
    assert_eq!(resource["files"], frozen["files"]);
    assert!(
        !crate::session_forks::reading_resource(&fixture.db, &resource)
            .unwrap()
            .is_live()
    );
    let opened = open(&resource, None);
    let reader = opened["readerId"].as_str().unwrap();
    assert_eq!(
        opened["sessionSnapshot"]["snapshotHash"],
        crate::commands::session_snapshot_hash(&resource)
    );
    verify_parity(&resource, reader, 13);
    close_transcript(reader.into()).unwrap();
}

#[test]
fn transcript_ranges_report_oversize_record_without_removing_the_snapshot_download() {
    let fixture = Fixture::new();
    let resource = publish_fixture(
        &fixture,
        "claude",
        &native::encode(&[
            json!({"type":"assistant","message":{"role":"assistant","content":"x".repeat(16 * 1024 * 1024)}}),
        ]),
    );
    let opened = open(&resource, None);
    let reader = opened["readerId"].as_str().unwrap();
    let error =
        tauri::async_runtime::block_on(read_transcript(reader.into(), Some(0), 32 * 1024, None))
            .unwrap_err();
    assert_eq!(error, crate::transcript::PREVIEW_TOO_LARGE);
    assert_eq!(
        opened["sessionSnapshot"]["snapshotHash"],
        crate::commands::session_snapshot_hash(&resource)
    );
}

#[test]
fn transcript_ranges_cancel_open_handles_on_service_switch() {
    let fixture = Fixture::new();
    let resource = publish_fixture(
        &fixture,
        "claude",
        &native::encode(&[
            json!({"type":"user","message":{"role":"user","content":"The previous service"}}),
        ]),
    );
    read_conversation(&resource, None).unwrap();
    let opened = open(&resource, None);
    let reader = opened["readerId"].as_str().unwrap();
    page(reader, Some(0), 64, false);
    db::set(
        &fixture.db,
        "config",
        &json!({"apiUrl":"https://other.invalid"}),
    )
    .unwrap();
    assert!(crate::commands::cached_transcript_prefix(
        &db::CacheScope::current().unwrap(),
        &resource,
        None
    )
    .unwrap()
    .is_none());
    let error =
        tauri::async_runtime::block_on(read_transcript(reader.into(), Some(0), 32 * 1024, None))
            .unwrap_err();
    assert_eq!(error, crate::transcript::SNAPSHOT_INVALIDATED);
}

#[test]
fn transcript_ranges_reuse_a_verified_head_for_initial_forward_lookahead() {
    let fixture = Fixture::new();
    let resource = publish_fixture(
        &fixture,
        "claude",
        &native::encode(&[
            json!({"type":"assistant","message":{"role":"assistant","content":"x".repeat(64 * 1024)}}),
        ]),
    );
    let opened = open(&resource, None);
    let reader = opened["readerId"].as_str().unwrap();
    let head = page(reader, Some(0), 16 * 1024, false);
    assert_eq!(head["eof"], false);
    let blob = db::blob_path(resource["files"][0]["hash"].as_str().unwrap()).unwrap();
    fs::remove_file(blob).unwrap();
    // The second 16 KiB was already verified by the bounded head harvest.
    // A full re-prepare would try to reopen the now-missing source file.
    let cached = page(reader, head["nextOffset"].as_u64(), 16 * 1024, false);
    assert_eq!(cached["nextOffset"], 32 * 1024);
    assert_eq!(cached["eof"], false);
    close_transcript(reader.into()).unwrap();
}

#[test]
fn oversized_unrendered_event_keeps_the_exact_small_transcript_downloadable() {
    let f = Fixture::new();
    let resource = publish_fixture(
        &f,
        "codex",
        &native::encode(&[
            json!({"type":"session_meta","payload":{"id":uuid::Uuid::new_v4(),"cwd":f.root}}),
            json!({"type":"event_msg","payload":{"type":"exec_command_end","aggregated_output":"x".repeat(16 * 1024 * 1024)}}),
            json!({"type":"event_msg","payload":{"type":"user_message","message":"Only visible text"}}),
        ]),
    );
    let id = resource["resourceId"].as_str().unwrap();
    let legacy = crate::commands::inspect_resource(
        id.into(),
        "session.jsonl".into(),
        None,
        Some(4 * 1024 * 1024),
    )
    .unwrap();
    assert_eq!(legacy["content"], "## user\n\nOnly visible text\n\n");
    let opened = open(&resource, None);
    let reader = opened["readerId"].as_str().unwrap();
    let result =
        tauri::async_runtime::block_on(read_transcript(reader.into(), Some(0), 16 * 1024, None));
    assert_eq!(result.unwrap_err(), crate::transcript::PREVIEW_TOO_LARGE);
    let download = f.root.join("oversized-event.zip");
    crate::commands::export_bundle(
        id.into(),
        download.to_string_lossy().into(),
        Some(serde_json::from_value(opened["sessionSnapshot"].clone()).unwrap()),
    )
    .unwrap();
    let mut zip = zip::ZipArchive::new(fs::File::open(download).unwrap()).unwrap();
    let mut text = String::new();
    zip.by_name("transcript.md")
        .unwrap()
        .read_to_string(&mut text)
        .unwrap();
    assert_eq!(text, legacy["content"]);
}

#[test]
fn deleting_a_session_invalidates_its_open_reader_despite_matching_files() {
    let f = Fixture::new();
    let mut resource = publish_fixture(
        &f,
        "claude",
        &native::encode(&[json!({"type":"user","message":{"role":"user","content":"Delete me"}})]),
    );
    let opened = open(&resource, None);
    let reader = opened["readerId"].as_str().unwrap();
    page(reader, Some(0), 32, false);
    resource["deleted"] = true.into();
    store_resource(&f, &resource);
    let result = tauri::async_runtime::block_on(read_transcript(reader.into(), None, 32, None));
    assert_eq!(result.unwrap_err(), crate::transcript::SNAPSHOT_INVALIDATED);
}

#[test]
fn corrupt_stored_source_cannot_return_even_a_prepared_prefix() {
    let f = Fixture::new();
    let mut bytes = native::encode(&[
        json!({"type":"user","message":{"role":"user","content":"a".repeat(40 * 1024)}}),
    ]);
    let resource = publish_fixture(&f, "claude", &bytes);
    let opened = open(&resource, None);
    let reader = opened["readerId"].as_str().unwrap();
    read_conversation(&resource, None).unwrap();
    let slot = bytes.iter().rposition(|byte| *byte == b'a').unwrap();
    bytes[slot] = b'z';
    let blob = db::blob_path(resource["files"][0]["hash"].as_str().unwrap()).unwrap();
    fs::write(blob, &bytes).unwrap();
    let result = tauri::async_runtime::block_on(read_transcript(reader.into(), Some(0), 32, None));
    assert_eq!(result.unwrap_err(), "Blob hash mismatch");

    bytes.extend_from_slice(b"{bad json}\n");
    let resource = publish_fixture(&f, "claude", &bytes);
    assert!(read_conversation(&resource, None).is_err());
    let opened = open(&resource, None);
    let reader = opened["readerId"].as_str().unwrap();
    let result = tauri::async_runtime::block_on(read_transcript(reader.into(), Some(0), 32, None));
    assert!(result.unwrap_err().contains("corrupt native transcript"));
}

#[test]
fn live_format_limit_keeps_the_exact_snapshot_download_and_rejects_a_later_edit() {
    use crate::local_resources;
    let mut f = Fixture::new();
    local_resource_tests::prepare(&mut f);
    let catalog = local_resources::catalog(&f.db, &f.project, "session").unwrap();
    let id = catalog["resources"][0]["resourceId"].as_str().unwrap();
    let resource = local_resources::resource(&f.db, id).unwrap();
    let live = crate::session_forks::reading_resource(&f.db, &resource).unwrap();
    let expected = native::transcript(&live.records().unwrap());
    let opened =
        serde_json::to_value(crate::transcript::open_oversized_live_fixture(id.into()).unwrap())
            .unwrap();
    assert_eq!(
        opened["sessionSnapshot"]["snapshotHash"],
        crate::commands::session_snapshot_hash(&live.resource)
    );
    let reader = opened["readerId"].as_str().unwrap();
    let result = tauri::async_runtime::block_on(read_transcript(reader.into(), Some(0), 32, None));
    assert_eq!(result.unwrap_err(), crate::transcript::PREVIEW_TOO_LARGE);

    let path = f.root.join("large-live.zip");
    let download = || {
        crate::commands::export_bundle(
            id.into(),
            path.to_string_lossy().into(),
            Some(serde_json::from_value(opened["sessionSnapshot"].clone()).unwrap()),
        )
    };
    download().unwrap();
    let mut zip = zip::ZipArchive::new(fs::File::open(&path).unwrap()).unwrap();
    let mut text = String::new();
    zip.by_name("transcript.md")
        .unwrap()
        .read_to_string(&mut text)
        .unwrap();
    assert_eq!(text, expected);

    let native_path = Path::new(resource["paths"][0].as_str().unwrap());
    let mut bytes = fs::read(native_path).unwrap();
    bytes.extend(native::encode(&[
        json!({"type":"event_msg","payload":{"type":"user_message","message":"Later native edit"}}),
    ]));
    fs::write(native_path, bytes).unwrap();
    assert_eq!(download().unwrap_err(), "session_snapshot_changed");

    let unopened_page =
        serde_json::to_value(crate::transcript::open_oversized_live_fixture(id.into()).unwrap())
            .unwrap();
    let reader = unopened_page["readerId"].as_str().unwrap();
    f.db.execute(
        "DELETE FROM projects WHERE id=?",
        [f.project["id"].as_str().unwrap()],
    )
    .unwrap();
    let result = tauri::async_runtime::block_on(read_transcript(reader.into(), Some(0), 32, None));
    assert_eq!(result.unwrap_err(), crate::transcript::SNAPSHOT_INVALIDATED);
}
