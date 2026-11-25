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
    assert!(error.contains("16 MiB reader limit"), "{error}");
    assert!(error.contains("Download the session"), "{error}");
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
    let opened = open(&resource, None);
    let reader = opened["readerId"].as_str().unwrap();
    page(reader, Some(0), 64, false);
    db::set(
        &fixture.db,
        "config",
        &json!({"apiUrl":"https://other.invalid"}),
    )
    .unwrap();
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
