use super::*;

#[test]
fn scanned_session_queues_a_redacted_title() {
    let f = Fixture::new();
    let id = uuid::Uuid::new_v4();
    let path = native::claude_home()
        .unwrap()
        .join("projects/test")
        .join(format!("{id}.jsonl"));
    fs::create_dir_all(path.parent().unwrap()).unwrap();
    let prompt = format!("Check this key: sk-{}", "x".repeat(24));
    let original = native::encode(&[
        json!({"type":"user","sessionId":id,"cwd":f.root,"message":{"role":"user","content":prompt}}),
    ]);
    fs::write(&path, &original).unwrap();

    indexer::scan(&f.db, &f.project).unwrap();

    let queued = f.outbox();
    assert_eq!(queued[0]["resource"]["title"], "Check this key: [REDACTED]");
    assert_eq!(fs::read(path).unwrap(), original);
}

#[test]
fn previously_queued_raw_session_is_blocked_before_upload() {
    let f = Fixture::new();
    let project = f.project["id"].as_str().unwrap();
    let raw = b"{\"tool\":{\"password\":\"synthetic-fixture\"}}\n";
    let hash = db::blob(raw).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let request = json!({"id":id,"projectId":project,"resource":{"kind":"session","title":"Old session","files":[{"path":"session.jsonl","hash":hash,"size":raw.len()}]}});
    indexer::queue(&f.db, project, "/v2/sync/push", &request).unwrap();

    let queued = f.outbox().remove(0);
    let result = tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(crate::repair::upload("test", project, &queued["resource"]));
    assert_eq!(
        result.unwrap_err(),
        "422: Session upload blocked because the snapshot still contains a recognized secret"
    );
    assert_eq!(f.outbox(), vec![request]);
    assert_eq!(db::blob_read(&hash).unwrap(), raw);
}

#[test]
fn session_upload_guard_checks_the_exact_blob_including_an_unterminated_record() {
    let _f = Fixture::new();
    let raw = br#"{"password":"synthetic-fixture"}"#;
    let resource = json!({"kind":"session","files":[{"path":"session.jsonl","hash":db::blob(raw).unwrap(),"size":raw.len()}]});
    let result = tokio::runtime::Runtime::new()
        .unwrap()
        .block_on(crate::repair::upload("test", "test", &resource));
    assert_eq!(
        result.unwrap_err(),
        "422: Session upload blocked because the snapshot still contains a recognized secret"
    );
}

#[test]
fn clean_snapshot_keeps_its_original_bytes_and_hash() {
    let f = Fixture::new();
    let path = f.root.join("clean.jsonl");
    let clean =
        b"{\"message\":{\"content\":\"Check the build\",\"role\":\"user\"},\"type\":\"user\"}\n";
    fs::write(&path, clean).unwrap();
    let files = crate::history::session_files("claude", &path, None).unwrap();
    assert_eq!(files[0]["hash"], db::digest(clean));
    assert_eq!(
        db::blob_read(files[0]["hash"].as_str().unwrap()).unwrap(),
        clean
    );
}

fn redacted_session_records(f: &Fixture, tool: &str, records: &[Value]) -> Vec<Value> {
    let path = f.root.join(format!("{tool}-redaction.jsonl"));
    let original = native::encode(records);
    fs::write(&path, &original).unwrap();
    let files = crate::history::session_files(tool, &path, Some(&f.root)).unwrap();
    let bytes = db::blob_read(files[0]["hash"].as_str().unwrap()).unwrap();
    assert_eq!(fs::read(&path).unwrap(), original);
    fs::write(&path, &bytes).unwrap();
    assert_eq!(
        crate::history::session_files(tool, &path, Some(&f.root)).unwrap(),
        files
    );
    native::complete_records(&bytes).unwrap()
}

fn serialized_tool_records(f: &Fixture, tool: &str, payload: &str) -> Vec<Value> {
    if tool == "codex" {
        vec![
            json!({"type":"session_meta","payload":{"id":uuid::Uuid::new_v4(),"cwd":f.root,"history_mode":"legacy","cli_version":"0.159.2"}}),
            json!({"type":"response_item","payload":{"type":"function_call","call_id":"redaction-call","name":"request","arguments":payload}}),
            json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"redaction-call","output":payload}}),
        ]
    } else {
        vec![
            json!({"type":"assistant","message":{"role":"assistant","content":[{"type":"tool_use","id":"redaction-call","name":"request","input":{"body":payload}}]}}),
            json!({"type":"user","message":{"role":"user","content":[{"type":"tool_result","tool_use_id":"redaction-call","content":payload}]}}),
        ]
    }
}

#[test]
fn new_snapshots_redact_json_encoded_tool_payloads_without_editing_sources() {
    let cases = [
        (
            r#" { "password": "opaque-password", "count": 3 } "#,
            json!({"password":"[REDACTED]","count":3}),
        ),
        (
            r#"[{"nested":{"service_TOKEN":"opaque-token"}},{"enabled":true}]"#,
            json!([{"nested":{"service_TOKEN":"[REDACTED]"}},{"enabled":true}]),
        ),
        (
            r#"{"body":"{\"password\":\"opaque-password\"}"}"#,
            json!({"body":r#"{"password":"[REDACTED]"}"#}),
        ),
        (
            r#"{"text":"API_KEY=opaque-key\nPORT=3000"}"#,
            json!({"text":"API_KEY=[REDACTED]\nPORT=3000"}),
        ),
        (
            r#"{"password":"opaque-password","password":"[REDACTED]"}"#,
            json!({"password":"[REDACTED]"}),
        ),
        (
            r#"{"value":{"password":"opaque-password"},"value":null}"#,
            json!({"value":null}),
        ),
        (
            r#"{"p\u0061ssword":"opaque-password","text":["PASSWORD=opaque-password"]}"#,
            json!({"password":"[REDACTED]","text":["PASSWORD=[REDACTED]"]}),
        ),
    ];
    for tool in ["codex", "claude"] {
        let f = Fixture::new();
        for (payload, expected) in &cases {
            let records = serialized_tool_records(&f, tool, payload);
            let output = redacted_session_records(&f, tool, &records);
            let values = if tool == "codex" {
                [
                    &output[1]["payload"]["arguments"],
                    &output[2]["payload"]["output"],
                ]
            } else {
                [
                    &output[0]["message"]["content"][0]["input"]["body"],
                    &output[1]["message"]["content"][0]["content"],
                ]
            };
            for value in values {
                assert!(!value.as_str().unwrap().contains("opaque-"));
                let decoded: Value = serde_json::from_str(value.as_str().unwrap()).unwrap();
                assert_eq!(&decoded, expected, "{tool}: {payload}");
            }
        }
    }
}

#[test]
fn new_snapshots_preserve_unmatched_serialized_payloads_exactly() {
    for tool in ["codex", "claude"] {
        let f = Fixture::new();
        for payload in [
            " {\r\n  \"z\": \"\\u03b1\", \"a\": [1, true, null], \"tokenizer\": \"enabled\"\r\n} ",
            r#"[ { "text": "unchanged 🌊" }, 2 ]"#,
            r#"{ "password": "[REDACTED]" }"#,
            r#""plain JSON string""#,
            "plain tool output",
            "{ malformed JSON",
            r#"{ "number": 1e400 }"#,
        ] {
            let records = serialized_tool_records(&f, tool, payload);
            assert_eq!(redacted_session_records(&f, tool, &records), records);
        }
    }
}

#[test]
fn new_snapshots_redact_json_fields_without_normalizing_other_tokens() {
    for tool in ["codex", "claude"] {
        let f = Fixture::new();
        let payload = r#"{ "password": "opaque-password", "number": 1e400, "text": "\u03b1" }"#;
        let expected = r#"{ "password": "[REDACTED]", "number": 1e400, "text": "\u03b1" }"#;
        let records = serialized_tool_records(&f, tool, payload);
        let output = redacted_session_records(&f, tool, &records);
        let value = if tool == "codex" {
            &output[1]["payload"]["arguments"]
        } else {
            &output[1]["message"]["content"][0]["content"]
        };
        assert_eq!(value, expected);
    }
}

#[test]
fn new_snapshots_redact_complete_assignment_values_with_escaped_quotes() {
    let cases = [
        (
            r#"PASSWORD="prefix\"sensitive-suffix""#,
            "PASSWORD=[REDACTED]",
        ),
        (
            r"PASSWORD='prefix\'sensitive-suffix'",
            "PASSWORD=[REDACTED]",
        ),
        (
            r#"  export SERVICE_TOKEN = "prefix\\\"sensitive-suffix" # comment"#,
            "  export SERVICE_TOKEN = [REDACTED]",
        ),
        (r#"PASSWORD="prefix\\" # comment"#, "PASSWORD=[REDACTED]"),
        (
            "PASSWORD=\"prefix\\\"sensitive-suffix\"\r\nPORT=3000",
            "PASSWORD=[REDACTED]\r\nPORT=3000",
        ),
        (
            r#"PORT="prefix\"public-suffix""#,
            r#"PORT="prefix\"public-suffix""#,
        ),
    ];
    let f = Fixture::new();
    for (input, expected) in cases {
        let records = vec![json!({"type":"user","message":{"role":"user","content":input}})];
        let output = redacted_session_records(&f, "claude", &records);
        assert_eq!(output[0]["message"]["content"], expected);
    }
}

#[test]
fn new_snapshots_redact_conversations_and_nested_tools_without_editing_sources() {
    let f = Fixture::new();
    let secrets = [
        format!("sk-{}", "a".repeat(24)),
        format!("sk-ant-api03-{}", "a".repeat(24)),
        format!("ghp_{}", "a".repeat(36)),
        format!("gho_{}", "a".repeat(36)),
        format!("github_pat_{}", "a".repeat(30)),
        format!("AKIA{}", "A".repeat(16)),
        format!("AIza{}", "a".repeat(35)),
        format!("xoxb-{}", "1".repeat(24)),
        format!("sk_live_{}", "a".repeat(24)),
        format!("rk_live_{}", "a".repeat(24)),
    ]
    .into_iter()
    .map(|s| (s, "[REDACTED]"))
    .chain([
        ("Bearer opaque.token+/==".into(), "Bearer [REDACTED]"),
        (
            "-----BEGIN RSA PRIVATE KEY-----\nprivate material\n-----END RSA PRIVATE KEY-----"
                .into(),
            "[REDACTED]",
        ),
        ("API_KEY=arbitrary-value".into(), "API_KEY=[REDACTED]"),
        (
            "  export SERVICE_TOKEN = 'arbitrary-value'".into(),
            "  export SERVICE_TOKEN = [REDACTED]",
        ),
        ("PASSWORD: arbitrary-value".into(), "PASSWORD: [REDACTED]"),
    ]);
    for (secret, expected) in secrets {
        let record = json!({"user":secret,"assistant":secret,"tool":{"input":[{"text":secret}],"output":{"text":secret}}});
        let path = f.root.join("redaction.jsonl");
        let original = native::encode(&[record]);
        fs::write(&path, &original).unwrap();
        let files = crate::history::session_files("claude", &path, None).unwrap();
        let bytes = db::blob_read(files[0]["hash"].as_str().unwrap()).unwrap();
        let output = native::complete_records(&bytes).unwrap().remove(0);
        for value in [
            &output["user"],
            &output["assistant"],
            &output["tool"]["input"][0]["text"],
            &output["tool"]["output"]["text"],
        ] {
            assert_eq!(value, expected);
        }
        assert_eq!(fs::read(&path).unwrap(), original);
        fs::write(&path, &bytes).unwrap();
        assert_eq!(
            crate::history::session_files("claude", &path, None).unwrap(),
            files
        );
    }
    let record = json!({"API_KEY":"opaque", "service_TOKEN":"opaque", "Secret":"opaque", "password":"opaque", "PRIVATE_KEY":"opaque", "nested":[{"token":"opaque"}], "ordinary":"sk-short ghp_short AKIA123 AIza123 xoxo-123 sk_live_short\nPORT=3000\nTOKENIZER: enabled\nMONKEY=banana", "tokenizer":"unchanged", "secretary":"unchanged", "count":42});
    let path = f.root.join("fields.jsonl");
    fs::write(&path, native::encode(std::slice::from_ref(&record))).unwrap();
    let files = crate::history::session_files("claude", &path, None).unwrap();
    let output =
        native::complete_records(&db::blob_read(files[0]["hash"].as_str().unwrap()).unwrap())
            .unwrap()
            .remove(0);
    for key in [
        "API_KEY",
        "service_TOKEN",
        "Secret",
        "password",
        "PRIVATE_KEY",
    ] {
        assert_eq!(output[key], "[REDACTED]");
    }
    assert_eq!(output["nested"][0]["token"], "[REDACTED]");
    for key in ["ordinary", "tokenizer", "secretary", "count"] {
        assert_eq!(output[key], record[key]);
    }
}

#[test]
fn new_codex_snapshots_rebase_redacted_ancestors_and_preserve_native_files() {
    let f = Fixture::new();
    let (mut resource, paths) = paginated_chain(&f);
    let mut offset = 0;
    for (index, path) in paths.iter().enumerate() {
        let mut records = native::complete_records(&fs::read(path).unwrap()).unwrap();
        records[1]["payload"]["redaction_fixture"] =
            json!(format!("Bearer ancestor-credential-{index}"));
        if index > 0 {
            records[0]["payload"]["history_base"]["end_byte_offset"] = json!(offset);
        }
        let bytes = native::encode(&records);
        offset = bytes.len();
        fs::write(path, bytes).unwrap();
    }
    let originals: Vec<_> = paths.iter().map(|p| fs::read(p).unwrap()).collect();
    resource["files"] =
        json!(
            crate::history::session_files("codex", paths.last().unwrap(), Some(&f.root)).unwrap()
        );
    let snapshot = History::resource(&resource).unwrap();
    assert_eq!(snapshot.rollouts.len(), paths.len());
    for (index, rollout) in snapshot.rollouts.iter().enumerate() {
        assert_eq!(
            rollout.records[1]["payload"]["redaction_fixture"],
            "Bearer [REDACTED]"
        );
        assert_eq!(fs::read(&paths[index]).unwrap(), originals[index]);
    }
}
