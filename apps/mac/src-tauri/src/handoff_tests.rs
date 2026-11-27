use super::*;
use crate::handoffs::{self, OUTPUT_OMITTED, PAYLOAD_LIMIT, TOOL_INPUT_LIMIT, TOOL_OUTPUT_LIMIT};
use std::sync::Arc;
use tokio::io::{AsyncBufReadExt, AsyncReadExt, AsyncWriteExt, BufReader};

type Requests = Arc<Mutex<Vec<(String, Value, Vec<u8>)>>>;
/// A status of 0 closes the connection after reading the request, like a lost acknowledgement.
const DROP: u16 = 0;
type Hook = Box<dyn Fn(&str) + Send + Sync>;

/// A loopback Orka service that records each request before answering it.
/// Repeated routes answer in order; the last one keeps answering.
struct Service {
    url: String,
    requests: Requests,
    task: tokio::task::JoinHandle<()>,
}

impl Drop for Service {
    fn drop(&mut self) {
        self.task.abort();
    }
}

impl Service {
    async fn start(mut routes: Vec<(String, u16, Value)>, hook: Option<Hook>) -> Self {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let url = format!("http://{}", listener.local_addr().unwrap());
        let requests = Requests::default();
        let seen = requests.clone();
        let task = tokio::spawn(async move {
            while let Ok((stream, _)) = listener.accept().await {
                let mut stream = BufReader::new(stream);
                let mut line = String::new();
                if stream.read_line(&mut line).await.unwrap_or(0) == 0 {
                    continue;
                }
                let route = line.trim_end().trim_end_matches(" HTTP/1.1").to_owned();
                let mut length = 0;
                loop {
                    line.clear();
                    if stream.read_line(&mut line).await.unwrap_or(0) == 0 || line == "\r\n" {
                        break;
                    }
                    if let Some((name, value)) = line.split_once(':') {
                        if name.eq_ignore_ascii_case("content-length") {
                            length = value.trim().parse().unwrap();
                        }
                    }
                }
                let mut body = vec![0; length];
                stream.read_exact(&mut body).await.unwrap();
                seen.lock().unwrap().push((
                    route.clone(),
                    serde_json::from_slice(&body).unwrap_or_default(),
                    body,
                ));
                if let Some(hook) = &hook {
                    hook(&route);
                }
                let matching: Vec<_> = (0..routes.len())
                    .filter(|at| routes[*at].0 == route)
                    .collect();
                let (status, value) = match matching.first() {
                    None => (404, json!({"error":"Not found"})),
                    Some(&at) if matching.len() > 1 => {
                        let (_, status, value) = routes.remove(at);
                        (status, value)
                    }
                    Some(&at) => (routes[at].1, routes[at].2.clone()),
                };
                if status == DROP {
                    continue;
                }
                let payload = if status == 204 {
                    String::new()
                } else {
                    value.to_string()
                };
                let response = format!("HTTP/1.1 {status} Test\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{payload}", payload.len());
                let _ = stream.get_mut().write_all(response.as_bytes()).await;
                let _ = stream.get_mut().shutdown().await;
            }
        });
        Self {
            url,
            requests,
            task,
        }
    }

    fn routes(&self) -> Vec<String> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .map(|(route, ..)| route.clone())
            .collect()
    }

    fn raw_bodies(&self, route: &str) -> Vec<Vec<u8>> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .filter(|(known, ..)| known == route)
            .map(|(.., raw)| raw.clone())
            .collect()
    }

    fn body(&self, route: &str) -> Option<Value> {
        self.requests
            .lock()
            .unwrap()
            .iter()
            .find(|(known, ..)| known == route)
            .map(|(_, body, _)| body.clone())
    }
}

/// Bind the fixture to a service before any blob is written: blobs are scoped by service.
fn signed_in(f: &mut Fixture, url: &str) -> Value {
    db::set(&f.db, "config", &json!({"apiUrl":url})).unwrap();
    crate::env::test_support::install_memory_keychain();
    let owner = db::get(&f.db, "user").unwrap();
    crate::auth::test_session(&json!({
        "user":{"id":owner},"access_token":"handoff-test","refresh_token":"unused",
        "expires_at":chrono::Utc::now().timestamp() + 86400
    }))
    .unwrap();
    // Signing in moves the cache to this account's database.
    f.db = db::open().unwrap();
    db::set(&f.db, "user", &owner).unwrap();
    let project = f.project["id"].as_str().unwrap().to_owned();
    db::upsert(&f.db, "projects", &project, "", &f.project).unwrap();
    json!({"accountId":owner,"serviceOrigin":url})
}

fn save_project(f: &mut Fixture, governed: bool) {
    f.project["governed"] = json!(governed);
    f.project["role"] = json!("owner");
    f.project["sharing"] =
        json!({"memory":true,"skill":false,"plan":false,"session":true,"env":false});
    db::upsert(
        &f.db,
        "projects",
        f.project["id"].as_str().unwrap(),
        "",
        &f.project,
    )
    .unwrap();
}

/// A synced session snapshot owned by this account, with its native identity.
fn stored_session(f: &Fixture, source: &str, records: &[Value]) -> (String, String) {
    let native_id = match source {
        "codex" => records[0]["payload"]["id"].as_str(),
        "pi" => records[0]["id"].as_str(),
        _ => records[0]["sessionId"].as_str(),
    }
    .unwrap()
    .to_owned();
    let bytes = native::encode(records);
    let hash = db::blob(&bytes).unwrap();
    let id = uuid::Uuid::new_v4().to_string();
    let resource = json!({"resourceId":id,"projectId":f.project["id"],"kind":"session","source":source,"title":format!("{source} handoff session"),"logicalPath":format!("{source}/{id}"),"owner":db::get(&f.db,"user").unwrap(),"revision":1,"deleted":false,"files":[{"path":"session.jsonl","hash":hash,"size":bytes.len()}]});
    let project = f.project["id"].as_str().unwrap();
    db::upsert(&f.db, "resources", &id, project, &resource).unwrap();
    db::upsert(
        &f.db,
        "bindings",
        &id,
        project,
        &json!({"nativeId":native_id,"base":resource,"paths":[]}),
    )
    .unwrap();
    (id, native_id)
}

fn shared_memory(f: &Fixture, name: &str, content: &str) -> String {
    let id = uuid::Uuid::new_v4().to_string();
    let hash = db::blob(content.as_bytes()).unwrap();
    let resource = json!({"resourceId":id,"projectId":f.project["id"],"kind":"memory","source":"shared","logicalPath":format!("knowledge/{name}"),"title":name,"files":[{"path":"content.md","hash":hash,"size":content.len()}],"deleted":false,"revision":3,"owner":db::get(&f.db,"user").unwrap(),"updatedAt":db::now(),"access":{"mode":"publish"}});
    db::upsert(
        &f.db,
        "resources",
        &id,
        f.project["id"].as_str().unwrap(),
        &resource,
    )
    .unwrap();
    id
}

fn claude_records(turns: &[Value]) -> (String, Vec<Value>) {
    let native_id = uuid::Uuid::new_v4().to_string();
    let records = turns
        .iter()
        .map(|turn| {
            let mut record = turn.clone();
            record["sessionId"] = json!(native_id);
            record["cwd"] = json!("/tmp/handoff-project");
            record
        })
        .collect();
    (native_id, records)
}

fn user(content: Value) -> Value {
    json!({"type":"user","message":{"role":"user","content":content}})
}

fn assistant(content: Value) -> Value {
    json!({"type":"assistant","message":{"role":"assistant","content":content}})
}

fn prepare(session: &str, options: Value) -> handoffs::Prepared {
    let mut input = options;
    input["sessionId"] = json!(session);
    handoffs::prepare_with(&db::open().unwrap(), &input).unwrap()
}

fn turns_of(prepared: &handoffs::Prepared) -> Vec<Value> {
    prepared.body["turns"].as_array().unwrap().clone()
}

#[test]
fn hook_memories_are_local_capped_and_never_feed_sync_or_exports() {
    let mut f = Fixture::new();
    save_project(&mut f, false);
    let project = f.project["id"].as_str().unwrap().to_owned();
    let memory = shared_memory(
        &f,
        "quartz.md",
        "Quartz cache uses a read-through adapter.\n",
    );
    let sessions = native::codex_home().unwrap().join("sessions");
    fs::create_dir_all(&sessions).unwrap();
    fs::create_dir_all(native::claude_home().unwrap().join("projects")).unwrap();
    let native_id = uuid::Uuid::new_v4().to_string();
    fs::write(sessions.join(format!("rollout-{native_id}.jsonl")), native::encode(&[
        json!({"type":"session_meta","payload":{"id":native_id,"cwd":f.root,"cli_version":"0.159.2","source":"cli"}}),
        json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Quartz cache question"}]}}),
    ])).unwrap();
    // Older sessions fill the local index up to its limit.
    let key = |session: &str| format!("handoffSessionMemories:{project}:{session}");
    let stale: Vec<String> = (0..crate::native::HANDOFF_MEMORIES_LIMIT)
        .map(|n| key(&format!("older-{n}")))
        .collect();
    for entry in &stale {
        db::set(&f.db, entry, &json!(["older-memory"])).unwrap();
    }
    db::set(&f.db, "handoffSessionMemoriesIndex", &json!(stale)).unwrap();

    let response = native::hook(
        "codex",
        json!({"cwd":f.root,"hook_event_name":"UserPromptSubmit","prompt":"Quartz cache adapter","session_id":native_id}),
    )
    .unwrap();
    assert!(
        response["hookSpecificOutput"]["additionalContext"]
            .as_str()
            .is_some_and(|context| context.contains("read-through adapter")),
        "{response}"
    );
    assert_eq!(db::get(&f.db, &key(&native_id)).unwrap(), json!([memory]));
    let index = db::get(&f.db, "handoffSessionMemoriesIndex").unwrap();
    assert_eq!(index.as_array().unwrap().len(), 500);
    assert_eq!(
        index.as_array().unwrap().last(),
        Some(&json!(key(&native_id)))
    );
    assert!(db::get(&f.db, &stale[0]).unwrap().is_null());
    assert_eq!(db::get(&f.db, &stale[1]).unwrap(), json!(["older-memory"]));
    // A repeated delivery keeps the same record without rewriting the index.
    native::hook(
        "codex",
        json!({"cwd":f.root,"hook_event_name":"UserPromptSubmit","prompt":"Quartz cache adapter","session_id":native_id}),
    )
    .unwrap();
    assert_eq!(db::get(&f.db, &key(&native_id)).unwrap(), json!([memory]));
    assert_eq!(
        db::get(&f.db, "handoffSessionMemoriesIndex").unwrap(),
        index
    );

    // Governed provenance stays empty for a non-governed project.
    assert!(
        db::get(&f.db, &format!("sessionSources:{project}:{native_id}"))
            .unwrap()
            .is_null()
    );
    assert_eq!(
        native::session_sources(&f.db, &project, &native_id).unwrap(),
        json!([])
    );
    for active in db::rows(&f.db, "SELECT value FROM active", &[]).unwrap() {
        assert_eq!(active["contextSources"], json!([]));
    }
    assert_eq!(
        native::handoff_session_memories(&f.db, &project, &native_id).unwrap(),
        vec![memory.clone()]
    );

    indexer::scan(&f.db, &f.project).unwrap();
    let catalog = crate::local_resources::catalog(&f.db, &f.project, "session").unwrap();
    let session = catalog["resources"]
        .as_array()
        .unwrap()
        .iter()
        .find(|resource| resource["source"] == "codex")
        .expect("discovered Codex session")
        .clone();
    assert!(!session["contextSources"].to_string().contains(&memory));
    for entry in f.outbox() {
        assert!(
            !entry["resource"]["contextSources"]
                .to_string()
                .contains(&memory),
            "{entry}"
        );
    }
    let zip = f._home.path().join("session.zip");
    bundles::export(&f.db, session["resourceId"].as_str().unwrap(), &zip).unwrap();
    let mut archive = zip::ZipArchive::new(fs::File::open(&zip).unwrap()).unwrap();
    for index in 0..archive.len() {
        let mut file = archive.by_index(index).unwrap();
        let mut text = String::new();
        let _ = file.read_to_string(&mut text);
        assert!(
            !text.contains(&memory),
            "{}",
            file.name().unwrap_or_default()
        );
    }
}

#[test]
fn candidates_preselect_delivered_and_root_instruction_memories() {
    for governed in [false, true] {
        let mut f = Fixture::new();
        signed_in(&mut f, "https://handoffs.example");
        save_project(&mut f, governed);
        let project = f.project["id"].as_str().unwrap().to_owned();
        fs::write(f.root.join("AGENTS.md"), "Run the native checks.\n").unwrap();
        let delivered = shared_memory(&f, "orka-pr-workflow.md", "Open the full stack.\n");
        let other = shared_memory(&f, "release-notes.md", "Write release notes.\n");
        let secret = shared_memory(&f, "deploy.md", "DEPLOY_TOKEN=abc123\n");
        let empty = shared_memory(&f, "empty.md", "   \n");
        let hidden = shared_memory(&f, "hidden.md", "Hidden memory\n");
        let mut row = crate::governance::resource(&f.db, &hidden).unwrap();
        row["access"] = json!({"mode":"hidden"});
        db::upsert(&f.db, "resources", &hidden, &project, &row).unwrap();
        let (session, native_id) = stored_session(
            &f,
            "claude",
            &claude_records(&[
                user(json!("Ship the handoff")),
                assistant(
                    json!([{"type":"text","text":"Running"},{"type":"tool_use","id":"t1","name":"Bash","input":{"command":"ls"}}]),
                ),
                user(json!([{"type":"tool_result","tool_use_id":"t1","content":"ok"}])),
                assistant(json!([{"type":"text","text":"Done"}])),
            ])
            .1,
        );
        let key = if governed {
            format!("sessionSources:{project}:{native_id}")
        } else {
            format!("handoffSessionMemories:{project}:{native_id}")
        };
        db::set(&f.db, &key, &json!([delivered])).unwrap();
        let result = handoffs::candidates_with(&f.db, &session).unwrap();
        assert_eq!(result["session"]["id"], session);
        assert_eq!(result["session"]["source"], "claude");
        assert_eq!(result["session"]["title"], "claude handoff session");
        assert_eq!(result["session"]["messageCount"], 3);
        assert_eq!(result["session"]["toolCallCount"], 1);
        let memories = result["memories"].as_array().unwrap();
        let find = |test: &dyn Fn(&Value) -> bool| memories.iter().find(|m| test(m)).cloned();
        let instructions = find(&|m| m["title"] == "AGENTS.md").expect("root instructions");
        assert_eq!(instructions["preselected"], true, "governed={governed}");
        assert_eq!(instructions["slug"], "agents");
        let delivered = find(&|m| m["id"] == delivered).unwrap();
        assert_eq!(delivered["preselected"], true);
        assert_eq!(delivered["scope"], "shared");
        assert_eq!(delivered["slug"], "orka-pr-workflow");
        assert_eq!(find(&|m| m["id"] == other).unwrap()["preselected"], false);
        let secret = find(&|m| m["id"] == secret).unwrap();
        assert_eq!(secret["preselected"], false);
        assert_eq!(secret["redactionCount"], 1);
        assert_eq!(secret["byteSize"], 20);
        assert!(find(&|m| m["id"] == empty).is_none());
        assert!(find(&|m| m["id"] == hidden).is_none());
        // Preselected memories come first.
        assert!(memories[..2].iter().all(|m| m["preselected"] == true));
        assert!(!result.to_string().contains("abc123"));
    }
}

#[test]
fn messages_only_handoffs_strip_tools_and_setup_across_providers() {
    let mut f = Fixture::new();
    signed_in(&mut f, "https://handoffs.example");
    save_project(&mut f, false);
    let (_, claude) = claude_records(&[
        user(json!(
            "<system-reminder>Injected context</system-reminder>\nFix the login bug"
        )),
        assistant(
            json!([{"type":"text","text":"Checking the handler"},{"type":"tool_use","id":"c1","name":"Read","input":{"file_path":"auth.rs"}}]),
        ),
        user(json!([{"type":"tool_result","tool_use_id":"c1","content":"fn login() {}"}])),
        assistant(json!([{"type":"text","text":"Fixed the handler"}])),
    ]);
    let codex_id = uuid::Uuid::new_v4().to_string();
    let codex = vec![
        json!({"type":"session_meta","payload":{"id":codex_id,"cwd":"/tmp/handoff-project"}}),
        json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"<environment_context>cwd</environment_context>"}]}}),
        json!({"type":"event_msg","payload":{"type":"user_message","message":"Repair sync"}}),
        json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Repair sync"}]}}),
        json!({"type":"response_item","payload":{"type":"function_call","name":"shell","arguments":"{\"command\":[\"cargo\",\"test\"]}","call_id":"x1"}}),
        json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"x1","output":"test result: ok"}}),
        json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Sync repaired"}]}}),
        json!({"type":"event_msg","payload":{"type":"agent_message","message":"Sync repaired"}}),
    ];
    let pi_id = uuid::Uuid::new_v4().to_string();
    let pi = vec![
        json!({"type":"session","version":3,"id":pi_id,"cwd":"/tmp/handoff-project"}),
        json!({"type":"message","id":"a","parentId":null,"message":{"role":"user","content":"Tune the parser"}}),
        json!({"type":"message","id":"b","parentId":"a","message":{"role":"assistant","content":[{"type":"text","text":"Reading it"},{"type":"toolCall","id":"p1","name":"read","arguments":{"path":"parser.rs"}}]}}),
        json!({"type":"message","id":"c","parentId":"b","message":{"role":"toolResult","toolCallId":"p1","toolName":"read","content":[{"type":"text","text":"parser source"}],"isError":false}}),
        json!({"type":"message","id":"d","parentId":"c","message":{"role":"assistant","content":[{"type":"text","text":"Parser tuned"}]}}),
    ];
    for (source, records, expected) in [
        (
            "claude",
            claude,
            vec![
                ("user", "Fix the login bug"),
                ("assistant", "Checking the handler"),
                ("assistant", "Fixed the handler"),
            ],
        ),
        (
            "codex",
            codex,
            vec![("user", "Repair sync"), ("assistant", "Sync repaired")],
        ),
        (
            "pi",
            pi,
            vec![
                ("user", "Tune the parser"),
                ("assistant", "Reading it"),
                ("assistant", "Parser tuned"),
            ],
        ),
    ] {
        let (session, _) = stored_session(&f, source, &records);
        let prepared = prepare(&session, json!({}));
        let turns = turns_of(&prepared);
        assert_eq!(
            turns
                .iter()
                .map(|t| (t["role"].as_str().unwrap(), t["text"].as_str().unwrap()))
                .collect::<Vec<_>>(),
            expected,
            "{source}"
        );
        assert!(turns.iter().all(|turn| turn.get("tools").is_none()));
        assert_eq!(prepared.body["source"], source);
        assert_eq!(prepared.body["includeToolCalls"], false);
        assert_eq!(prepared.tools, 0);
        assert_eq!(prepared.messages, expected.len());
        let text = prepared.body.to_string();
        for hidden in [
            "Injected context",
            "environment_context",
            "fn login",
            "test result",
            "parser source",
        ] {
            assert!(!text.contains(hidden), "{source}: {hidden}");
        }
        // With tool calls, the same prose appears with each call and its output paired.
        let with_tools = prepare(&session, json!({"includeToolCalls":true}));
        let tool_turns = turns_of(&with_tools);
        let prose: Vec<_> = tool_turns
            .iter()
            .filter(|t| t["text"] != "")
            .map(|t| (t["role"].as_str().unwrap(), t["text"].as_str().unwrap()))
            .collect();
        assert_eq!(prose, expected, "{source}");
        assert_eq!(with_tools.tools, 1, "{source}");
        let tool = tool_turns
            .iter()
            .flat_map(|t| t["tools"].as_array().cloned().unwrap_or_default())
            .next()
            .unwrap();
        assert!(!tool["output"].as_str().unwrap().is_empty(), "{source}");
        assert_eq!(tool["isError"], false);
        assert_eq!(tool["truncated"], false);
    }
}

#[test]
fn tool_calls_stay_chronological_and_are_capped_head_and_tail() {
    let mut f = Fixture::new();
    signed_in(&mut f, "https://handoffs.example");
    save_project(&mut f, false);
    let long_input = format!("{}{}", "I".repeat(6000), "J".repeat(6000));
    let long_output = format!("{}{}", "H".repeat(15000), "T".repeat(15000));
    let (_, records) = claude_records(&[
        user(json!("Investigate the cache")),
        assistant(
            json!([{"type":"tool_use","id":"a","name":"Bash","input":{"command":long_input}}]),
        ),
        user(
            json!([{"type":"tool_result","tool_use_id":"a","content":long_output,"is_error":true}]),
        ),
        assistant(json!([{"type":"text","text":"First finding"}])),
        assistant(
            json!([{"type":"tool_use","id":"b","name":"Read","input":{"file_path":"cache.rs"}}]),
        ),
        user(
            json!([{"type":"tool_result","tool_use_id":"b","content":[{"type":"text","text":"cache source"}]}]),
        ),
        assistant(json!([{"type":"text","text":"Second finding"}])),
    ]);
    let (session, _) = stored_session(&f, "claude", &records);
    let prepared = prepare(&session, json!({"includeToolCalls":true}));
    let turns = turns_of(&prepared);
    let shape: Vec<_> = turns
        .iter()
        .map(|t| {
            (
                t["role"].as_str().unwrap().to_owned(),
                t["text"].as_str().unwrap().to_owned(),
                t["tools"]
                    .as_array()
                    .map(|tools| tools.iter().map(|tool| tool["name"].clone()).collect())
                    .unwrap_or_else(Vec::new),
            )
        })
        .collect();
    assert_eq!(
        shape,
        vec![
            ("user".into(), "Investigate the cache".into(), vec![]),
            ("assistant".into(), "".into(), vec![json!("Bash")]),
            (
                "assistant".into(),
                "First finding".into(),
                vec![json!("Read")]
            ),
            ("assistant".into(), "Second finding".into(), vec![]),
        ]
    );
    let first = &turns[1]["tools"][0];
    assert_eq!(first["isError"], true);
    assert_eq!(first["truncated"], true);
    let input = first["input"].as_str().unwrap();
    let output = first["output"].as_str().unwrap();
    assert!(input.len() <= TOOL_INPUT_LIMIT, "{}", input.len());
    assert!(input.contains("truncated"));
    assert!(output.len() <= TOOL_OUTPUT_LIMIT, "{}", output.len());
    let marker = format!(
        "\n\n… [truncated; {} bytes in the original] …\n\n",
        long_output.len()
    );
    let budget = TOOL_OUTPUT_LIMIT - marker.len();
    let head = budget * 65 / 100;
    assert_eq!(
        output,
        format!("{}{marker}{}", "H".repeat(head), "T".repeat(budget - head))
    );
    assert_eq!(turns[2]["tools"][0]["output"], "cache source");
    assert_eq!(turns[2]["tools"][0]["truncated"], false);

    // UTF-8 text is cut only on character boundaries.
    let (capped, truncated) = handoffs::cap(&"é".repeat(5000), 4096, 10000);
    assert!(truncated && capped.len() <= 4096);
}

fn tool_heavy(f: &Fixture, count: usize, request: &str) -> String {
    let mut turns = vec![user(json!(request))];
    for n in 0..count {
        turns.push(assistant(
            json!([{"type":"text","text":format!("Step {n}")},{"type":"tool_use","id":format!("t{n}"),"name":"Bash","input":{"command":format!("step {n}")}}]),
        ));
        turns.push(user(
            json!([{"type":"tool_result","tool_use_id":format!("t{n}"),"content":format!("{n}:{}", "o".repeat(9000))}]),
        ));
    }
    turns.push(assistant(json!([{"type":"text","text":"Final summary"}])));
    stored_session(f, "claude", &claude_records(&turns).1).0
}

fn outputs(prepared: &handoffs::Prepared) -> Vec<String> {
    turns_of(prepared)
        .iter()
        .flat_map(|t| t["tools"].as_array().cloned().unwrap_or_default())
        .map(|tool| tool["output"].as_str().unwrap().to_owned())
        .collect()
}

#[test]
fn oversized_handoffs_shorten_older_tool_outputs_and_keep_conversation_text() {
    let mut f = Fixture::new();
    signed_in(&mut f, "https://handoffs.example");
    save_project(&mut f, false);
    let request = format!("Keep this whole request {}", "r".repeat(100_000));
    let memory = shared_memory(&f, "conventions.md", &"m".repeat(20_000));

    // Shortening the oldest outputs to 2 KB is enough; recent ones keep 8 KB.
    let session = tool_heavy(&f, 500, &request);
    let prepared = prepare(
        &session,
        json!({"includeToolCalls":true,"memoryIds":[memory]}),
    );
    assert!(serde_json::to_vec(&prepared.body).unwrap().len() <= PAYLOAD_LIMIT);
    let turns = turns_of(&prepared);
    assert_eq!(turns[0]["text"], request.as_str());
    assert_eq!(turns.last().unwrap()["text"], "Final summary");
    assert_eq!(prepared.messages, 502);
    assert_eq!(prepared.tools, 500);
    assert_eq!(
        prepared.body["memories"][0]["content"],
        "m".repeat(20_000).as_str()
    );
    let kept = outputs(&prepared);
    assert!(kept[0].len() <= 2048 && kept[0].starts_with("0:ooo"));
    assert!(kept[499].len() > 2048 && kept[499].len() <= TOOL_OUTPUT_LIMIT);
    assert!(!kept.iter().any(|output| output == OUTPUT_OMITTED));

    // When 2 KB outputs still do not fit, the oldest are omitted.
    let session = tool_heavy(&f, 1800, &request);
    let prepared = prepare(
        &session,
        json!({"includeToolCalls":true,"memoryIds":[memory]}),
    );
    assert!(serde_json::to_vec(&prepared.body).unwrap().len() <= PAYLOAD_LIMIT);
    assert_eq!(turns_of(&prepared)[0]["text"], request.as_str());
    assert_eq!(prepared.messages, 1802);
    let kept = outputs(&prepared);
    assert_eq!(kept[0], OUTPUT_OMITTED);
    let last = kept.last().unwrap();
    assert!(last != OUTPUT_OMITTED && last.len() <= 2048 && last.starts_with("1799:"));
    assert!(turns_of(&prepared)
        .iter()
        .flat_map(|t| t["tools"].as_array().cloned().unwrap_or_default())
        .all(|tool| tool["truncated"] == true));

    // Conversation text that cannot fit is refused rather than dropped.
    let (_, huge) = claude_records(&[
        user(json!("x".repeat(PAYLOAD_LIMIT))),
        assistant(json!([{"type":"text","text":"ok"}])),
    ]);
    let (huge, _) = stored_session(&f, "claude", &huge);
    let error = handoffs::prepare_with(&f.db, &json!({"sessionId":huge}))
        .err()
        .unwrap();
    assert!(error.contains("too large"), "{error}");
}

#[test]
fn handoffs_redact_session_tool_and_memory_secrets() {
    let mut f = Fixture::new();
    signed_in(&mut f, "https://handoffs.example");
    save_project(&mut f, false);
    let openai = format!("sk-{}", "a".repeat(32));
    let github = format!("ghp_{}", "b".repeat(36));
    let (_, records) = claude_records(&[
        user(json!(format!("Use {openai} for the request"))),
        assistant(
            json!([{"type":"text","text":"Calling it"},{"type":"tool_use","id":"s","name":"Bash","input":{"command":"curl","password":"hunter2-secret"}}]),
        ),
        user(
            json!([{"type":"tool_result","tool_use_id":"s","content":"API_KEY=plain-output-secret\nok"}]),
        ),
        assistant(json!([{"type":"text","text":"Done"}])),
    ]);
    let (session, _) = stored_session(&f, "claude", &records);
    let memory = shared_memory(
        &f,
        "credentials.md",
        &format!("Deploy with {github}\nSTRIPE_SECRET=memory-secret\n"),
    );
    let prepared = prepare(
        &session,
        json!({"includeToolCalls":true,"memoryIds":[memory],"handoffNote":format!("  Note with {openai}  ")}),
    );
    let text = serde_json::to_string(&prepared.body).unwrap();
    for secret in [
        openai.as_str(),
        github.as_str(),
        "hunter2-secret",
        "plain-output-secret",
        "memory-secret",
    ] {
        assert!(!text.contains(secret), "{secret}");
    }
    assert!(prepared.redactions >= 6, "{}", prepared.redactions);
    assert_eq!(prepared.body["handoffNote"], "Note with [REDACTED]");
    assert_eq!(prepared.memories, 1);
    assert_eq!(prepared.body["memories"][0]["scope"], "shared");
    assert_eq!(prepared.body["memories"][0]["slug"], "credentials");
    crate::session_redaction::SessionRedactor::check_upload(text.as_bytes()).unwrap();

    let note = "n".repeat(501);
    let error = handoffs::prepare_with(&f.db, &json!({"sessionId":session,"handoffNote":note}))
        .err()
        .unwrap();
    assert!(error.contains("500 characters"), "{error}");
    let error = handoffs::prepare_with(
        &f.db,
        &json!({"sessionId":session,"memoryIds":[uuid::Uuid::new_v4().to_string()]}),
    )
    .err()
    .unwrap();
    assert!(error.contains("no longer available"), "{error}");
}

fn instance(browser: &str) -> (String, u16, Value) {
    (
        "GET /v2/instance".into(),
        200,
        json!({"version":1,"browserHandoffs":1,"auth":{"browserOrigin":browser}}),
    )
}

#[tokio::test]
async fn create_handoff_posts_the_reviewed_payload_and_validates_the_link() {
    let mut f = Fixture::new();
    let id = uuid::Uuid::new_v4().to_string();
    let browser = "http://localhost:3000";
    let created = |url: &str| json!({"id":id,"url":url,"createdAt":"2026-11-28T00:00:00Z","expiresAt":"2026-12-05T00:00:00Z"});
    let token = "a".repeat(64);
    let link = format!("{browser}/handoff/{token}");
    let service = Service::start(
        vec![
            instance(browser),
            ("POST /v2/handoffs".into(), 201, created(&link)),
        ],
        None,
    )
    .await;
    let mut input = signed_in(&mut f, &service.url);
    save_project(&mut f, false);
    let (_, records) = claude_records(&[
        user(json!("Continue the release")),
        assistant(json!([{"type":"text","text":"Release is ready"}])),
    ]);
    let (session, _) = stored_session(&f, "claude", &records);
    let memory = shared_memory(&f, "release.md", "Tag after checks.\n");
    let request = uuid::Uuid::new_v4().to_string();
    input["sessionId"] = json!(session);
    input["memoryIds"] = json!([memory]);
    input["requestId"] = json!(request);
    input["handoffNote"] = json!("Finish the tag");
    let result = handoffs::create(input.clone()).await.unwrap();
    assert_eq!(result["id"], id);
    assert_eq!(result["url"], link);
    assert_eq!(result["expiresAt"], "2026-12-05T00:00:00Z");
    assert_eq!(result["requestId"], request);
    assert_eq!(result["messageCount"], 2);
    assert_eq!(result["toolCallCount"], 0);
    assert_eq!(result["memoryCount"], 1);
    assert_eq!(result["redactionCount"], 0);
    assert_eq!(
        service.routes(),
        vec!["GET /v2/instance", "POST /v2/handoffs"]
    );
    let body = service.body("POST /v2/handoffs").unwrap();
    assert_eq!(body["requestId"], request);
    assert_eq!(body["title"], "claude handoff session");
    assert_eq!(body["handoffNote"], "Finish the tag");
    assert_eq!(body["memories"][0]["content"], "Tag after checks.\n");
    assert_eq!(body["turns"][1]["text"], "Release is ready");
    assert!(f.outbox().is_empty());
    drop(service);

    // A link to another origin, scheme or path is never returned, and the
    // path is exactly one Dashboard handoff token.
    for spoofed in [
        format!("https://localhost:3000/handoff/{token}"),
        format!("http://localhost:3001/handoff/{token}"),
        format!("http://evil.example/handoff/{token}"),
        "http://localhost:3000/login?next=/handoff/x".to_owned(),
        format!("http://user@localhost:3000/handoff/{token}"),
        "http://localhost:3000/handoff/".to_owned(),
        "http://localhost:3000/handoff/abc/def".to_owned(),
        format!("http://localhost:3000/handoff/{token}/def"),
        format!("http://localhost:3000/handoff/{token}?next=/login"),
        format!("http://localhost:3000/handoff/{token}#fragment"),
        format!("http://localhost:3000/handoff/{}", token.to_uppercase()),
        format!("http://localhost:3000/handoff/{}", &token[1..]),
        format!("http://localhost:3000/handoff/{}g", &token[1..]),
        "http://localhost:3000/handoff/secret-token".to_owned(),
    ] {
        let service = Service::start(
            vec![
                instance(browser),
                ("POST /v2/handoffs".into(), 201, created(&spoofed)),
            ],
            None,
        )
        .await;
        input["serviceOrigin"] = json!(service.url);
        signed_in(&mut f, &service.url);
        // Blobs are scoped to the service: store the session for this one.
        let (session, _) = stored_session(&f, "claude", &records);
        input["sessionId"] = json!(session);
        input["memoryIds"] = json!([]);
        let error = handoffs::create(input.clone()).await.unwrap_err();
        assert!(
            error.contains("unexpected handoff link"),
            "{spoofed}: {error}"
        );
    }
}

#[tokio::test]
async fn create_handoff_requires_service_support_and_a_stable_account() {
    let mut f = Fixture::new();
    for instance_route in [
        (
            "GET /v2/instance".to_owned(),
            200,
            json!({"version":1,"auth":{}}),
        ),
        (
            "GET /v2/instance".to_owned(),
            404,
            json!({"error":"Not found"}),
        ),
        (
            "GET /v2/instance".to_owned(),
            200,
            json!({"version":1,"browserHandoffs":1,"auth":{"browserOrigin":"javascript:alert(1)"}}),
        ),
    ] {
        let unsupported = instance_route.2["browserHandoffs"] != 1;
        let service = Service::start(vec![instance_route], None).await;
        let mut input = signed_in(&mut f, &service.url);
        save_project(&mut f, false);
        let (_, records) = claude_records(&[
            user(json!("Continue")),
            assistant(json!([{"type":"text","text":"Ok"}])),
        ]);
        input["sessionId"] = json!(stored_session(&f, "claude", &records).0);
        let error = handoffs::create(input).await.unwrap_err();
        if unsupported {
            assert_eq!(error, handoffs::UNSUPPORTED);
        } else {
            assert!(error.contains("invalid browser address"), "{error}");
        }
        assert_eq!(service.routes(), vec!["GET /v2/instance"]);
    }

    // The account changes while the service checks support: nothing is sent.
    let switched: Hook = Box::new(|route| {
        if route == "GET /v2/instance" {
            let db = db::open().unwrap();
            db::set(&db, "user", &json!(uuid::Uuid::new_v4().to_string())).unwrap();
        }
    });
    let service = Service::start(
        vec![
            instance("http://localhost:3000"),
            (
                "POST /v2/handoffs".into(),
                201,
                json!({"id":uuid::Uuid::new_v4().to_string(),"url":"http://localhost:3000/handoff/x"}),
            ),
        ],
        Some(switched),
    )
    .await;
    let mut input = signed_in(&mut f, &service.url);
    let (_, records) = claude_records(&[
        user(json!("Continue")),
        assistant(json!([{"type":"text","text":"Ok"}])),
    ]);
    input["sessionId"] = json!(stored_session(&f, "claude", &records).0);
    let error = handoffs::create(input.clone()).await.unwrap_err();
    assert_eq!(error, handoffs::SCOPE_CHANGED);
    assert_eq!(service.routes(), vec!["GET /v2/instance"]);
    // A request for another account or service never reaches the network.
    input["accountId"] = json!(uuid::Uuid::new_v4().to_string());
    assert_eq!(
        handoffs::create(input).await.unwrap_err(),
        handoffs::SCOPE_CHANGED
    );
    assert_eq!(service.routes(), vec!["GET /v2/instance"]);
}

#[tokio::test]
async fn list_and_revoke_handoffs_stay_scoped_and_tolerate_older_services() {
    let mut f = Fixture::new();
    let older = Service::start(
        vec![("GET /v2/instance".into(), 200, json!({"version":1}))],
        None,
    )
    .await;
    let scope = signed_in(&mut f, &older.url);
    let account = scope["accountId"].as_str().map(str::to_owned);
    let origin = Some(older.url.clone());
    assert_eq!(
        handoffs::list_with(account.clone(), origin.clone())
            .await
            .unwrap(),
        json!({"supported":false,"handoffs":[]})
    );
    assert_eq!(older.routes(), vec!["GET /v2/instance"]);
    drop(older);

    let browser = "http://localhost:3000";
    let token = "f".repeat(64);
    let active = uuid::Uuid::new_v4().to_string();
    let linked = uuid::Uuid::new_v4().to_string();
    let spoofed = uuid::Uuid::new_v4().to_string();
    let revoked = uuid::Uuid::new_v4().to_string();
    let expired = uuid::Uuid::new_v4().to_string();
    let service = Service::start(
        vec![
            instance(browser),
            (
                "GET /v2/handoffs".into(),
                200,
                // orka-api lists `{"items":[...]}` without links: tokens are not recoverable.
                json!({"items":[
                    {"id":active,"title":"Release","source":"claude","includeToolCalls":false,"createdAt":"2026-11-28T00:00:00Z","expiresAt":"2999-01-01T00:00:00Z","memoryCount":2,"messageCount":4,"toolCallCount":0,"payloadBytes":321,"token":"never-returned"},
                    {"id":linked,"title":"Linked","url":format!("{browser}/handoff/{token}"),"expiresAt":"2999-01-01T00:00:00Z"},
                    {"id":spoofed,"title":"Spoofed","url":format!("https://evil.example/handoff/{token}"),"expiresAt":"2999-01-01T00:00:00Z"},
                    {"id":revoked,"title":"Revoked","revokedAt":"2026-11-27T00:00:00Z"},
                    {"id":expired,"title":"Expired","expiresAt":"2020-01-01T00:00:00Z"},
                    {"id":"not-a-uuid","title":"Invalid"}
                ]}),
            ),
            (
                format!("DELETE /v2/handoffs/{active}"),
                204,
                Value::Null,
            ),
        ],
        None,
    )
    .await;
    let scope = signed_in(&mut f, &service.url);
    let account = scope["accountId"].as_str().map(str::to_owned);
    let origin = Some(service.url.clone());
    let listed = handoffs::list_with(account.clone(), origin.clone())
        .await
        .unwrap();
    assert_eq!(listed["supported"], true);
    let handoffs = listed["handoffs"].as_array().unwrap();
    assert_eq!(handoffs.len(), 3);
    assert_eq!(handoffs[0]["id"], active);
    assert!(handoffs[0]["url"].is_null());
    assert_eq!(handoffs[0]["memoryCount"], 2);
    assert_eq!(handoffs[0]["messageCount"], 4);
    assert_eq!(handoffs[0]["includeToolCalls"], false);
    assert!(handoffs[0].get("token").is_none());
    assert_eq!(handoffs[1]["id"], linked);
    assert_eq!(handoffs[1]["url"], format!("{browser}/handoff/{token}"));
    assert_eq!(handoffs[2]["id"], spoofed);
    assert!(handoffs[2]["url"].is_null());

    assert_eq!(
        handoffs::revoke_with("not-a-uuid".into(), account.clone(), origin.clone())
            .await
            .unwrap_err(),
        "Invalid handoff"
    );
    assert_eq!(
        handoffs::revoke_with(active.clone(), account.clone(), origin.clone())
            .await
            .unwrap(),
        json!({"id":active,"revoked":true})
    );
    // Revocation under another account never reaches the service.
    assert_eq!(
        handoffs::revoke_with(
            active.clone(),
            Some(uuid::Uuid::new_v4().to_string()),
            origin.clone()
        )
        .await
        .unwrap_err(),
        handoffs::SCOPE_CHANGED
    );
    assert_eq!(
        handoffs::list_with(account, Some("https://other.example".into()))
            .await
            .unwrap_err(),
        handoffs::SCOPE_CHANGED
    );
    assert_eq!(
        service.routes(),
        vec![
            "GET /v2/instance".to_owned(),
            "GET /v2/handoffs".to_owned(),
            format!("DELETE /v2/handoffs/{active}"),
        ]
    );
}

/// Replace a stored session's snapshot, as a sync after new local turns would.
fn replace_snapshot(f: &Fixture, session: &str, records: &[Value]) {
    let mut resource = crate::governance::resource(&f.db, session).unwrap();
    let bytes = native::encode(records);
    resource["files"] =
        json!([{"path":"session.jsonl","hash":db::blob(&bytes).unwrap(),"size":bytes.len()}]);
    db::upsert(
        &f.db,
        "resources",
        session,
        f.project["id"].as_str().unwrap(),
        &resource,
    )
    .unwrap();
}

#[tokio::test]
async fn retrying_a_request_id_resends_the_exact_snapshot_after_new_turns() {
    let mut f = Fixture::new();
    let browser = "http://localhost:3000";
    let id = uuid::Uuid::new_v4().to_string();
    let link = format!("{browser}/handoff/{}", "a".repeat(64));
    let receipt = json!({"id":id,"url":link,"createdAt":"2026-11-28T00:00:00Z","expiresAt":"2026-12-05T00:00:00Z"});
    let service = Service::start(
        vec![
            instance(browser),
            // The first acknowledgement is lost, then the service is briefly down.
            ("POST /v2/handoffs".into(), DROP, Value::Null),
            (
                "POST /v2/handoffs".into(),
                503,
                json!({"error":"Service unavailable"}),
            ),
            ("POST /v2/handoffs".into(), 200, receipt),
        ],
        None,
    )
    .await;
    let mut input = signed_in(&mut f, &service.url);
    save_project(&mut f, false);
    let (_, records) = claude_records(&[
        user(json!("Continue the release")),
        assistant(json!([{"type":"text","text":"Release is ready"}])),
    ]);
    let (session, _) = stored_session(&f, "claude", &records);
    input["sessionId"] = json!(session);
    input["requestId"] = json!(uuid::Uuid::new_v4().to_string());

    let error = handoffs::create(input.clone()).await.unwrap_err();
    assert_eq!(error, handoffs::UNCONFIRMED);
    assert!(!error.contains("Nothing was shared"), "{error}");

    // The session grows locally before the user retries.
    let mut newer = records.clone();
    let mut answer = assistant(json!([{"type":"text","text":"New turn since first try"}]));
    answer["sessionId"] = records[0]["sessionId"].clone();
    answer["cwd"] = records[0]["cwd"].clone();
    newer.push(answer);
    replace_snapshot(&f, &session, &newer);

    let error = handoffs::create(input.clone()).await.unwrap_err();
    assert_eq!(error, handoffs::UNCONFIRMED);
    let result = handoffs::create(input.clone()).await.unwrap();
    assert_eq!(result["id"], id);
    assert_eq!(result["url"], link);
    assert_eq!(result["messageCount"], 2);
    let sent = service.raw_bodies("POST /v2/handoffs");
    assert_eq!(sent.len(), 3);
    assert!(sent.iter().all(|body| *body == sent[0]), "bodies differ");
    assert!(!String::from_utf8_lossy(&sent[0]).contains("New turn since first try"));

    // A confirmed handoff releases its snapshot; the next send is rebuilt.
    handoffs::create(input).await.unwrap();
    let sent = service.raw_bodies("POST /v2/handoffs");
    assert!(String::from_utf8_lossy(&sent[3]).contains("New turn since first try"));
}

#[tokio::test]
async fn create_handoff_reports_service_rejections_and_unsent_failures() {
    let mut f = Fixture::new();
    let browser = "http://localhost:3000";
    let secret_message = "This handoff still contains a recognized secret. Nothing was shared.";
    for (status, body, expected) in [
        (
            422,
            json!({"error":secret_message,"code":"HANDOFF_SECRET"}),
            format!("{}: {secret_message}", handoffs::SECRET_CODE),
        ),
        (
            413,
            json!({"error":"Handoff exceeds payload size limit"}),
            handoffs::TOO_LARGE.to_owned(),
        ),
        (
            429,
            json!({"error":"You reached the hourly limit for new handoffs. Try again later."}),
            "You reached the hourly limit for new handoffs. Try again later.".to_owned(),
        ),
        (
            404,
            json!({"error":"Handoff unavailable"}),
            handoffs::UNSUPPORTED.to_owned(),
        ),
        (
            409,
            json!({"error":"This request ID was already used for a different handoff"}),
            "This request ID was already used for a different handoff".to_owned(),
        ),
        (DROP, Value::Null, handoffs::UNCONFIRMED.to_owned()),
        (
            500,
            json!({"error":"Service unavailable"}),
            handoffs::UNCONFIRMED.to_owned(),
        ),
        // A success without a receipt may still have been stored.
        (201, Value::Null, handoffs::UNCONFIRMED.to_owned()),
    ] {
        let service = Service::start(
            vec![
                instance(browser),
                ("POST /v2/handoffs".into(), status, body),
            ],
            None,
        )
        .await;
        let mut input = signed_in(&mut f, &service.url);
        save_project(&mut f, false);
        let (_, records) = claude_records(&[
            user(json!("Continue")),
            assistant(json!([{"type":"text","text":"Ok"}])),
        ]);
        input["sessionId"] = json!(stored_session(&f, "claude", &records).0);
        let error = handoffs::create(input).await.unwrap_err();
        assert_eq!(error, expected, "{status}");
        if !matches!(status, 413 | 422) {
            assert!(!error.contains("Nothing was shared"), "{status}: {error}");
        }
        assert_eq!(
            service.routes(),
            vec!["GET /v2/instance", "POST /v2/handoffs"]
        );
    }

    // Only a failure before anything is sent says that nothing was shared.
    let closed = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let url = format!("http://{}", closed.local_addr().unwrap());
    drop(closed);
    let mut input = signed_in(&mut f, &url);
    save_project(&mut f, false);
    let (_, records) = claude_records(&[
        user(json!("Continue")),
        assistant(json!([{"type":"text","text":"Ok"}])),
    ]);
    input["sessionId"] = json!(stored_session(&f, "claude", &records).0);
    assert_eq!(
        handoffs::create(input).await.unwrap_err(),
        handoffs::NOT_SENT
    );
}

#[test]
fn memory_file_names_never_carry_credentials_into_slugs() {
    let mut f = Fixture::new();
    signed_in(&mut f, "https://handoffs.example");
    save_project(&mut f, false);
    let (_, records) = claude_records(&[
        user(json!("Continue")),
        assistant(json!([{"type":"text","text":"Ok"}])),
    ]);
    let session = stored_session(&f, "claude", &records).0;
    let marker = format!("AKIA{}", "A".repeat(16));
    let memory = shared_memory(&f, &format!("{marker}.md"), "General notes");
    let prepared = prepare(&session, json!({"memoryIds":[memory]}));
    let payload = &prepared.body["memories"][0];
    assert_eq!(payload["title"], "[REDACTED].md");
    assert_eq!(payload["slug"], "redacted");
    let text = String::from_utf8(prepared.bytes.clone()).unwrap();
    assert!(!text
        .to_ascii_lowercase()
        .contains(&marker.to_ascii_lowercase()));
    let candidates = handoffs::candidates_with(&f.db, &session).unwrap();
    let listed = candidates["memories"]
        .as_array()
        .unwrap()
        .iter()
        .find(|m| m["id"] == memory)
        .unwrap();
    assert_eq!(listed["slug"], "redacted");
    assert!(!candidates
        .to_string()
        .to_ascii_lowercase()
        .contains(&marker.to_ascii_lowercase()));
}

#[test]
fn memories_fit_the_service_limit_after_truncation_and_redaction() {
    let mut f = Fixture::new();
    signed_in(&mut f, "https://handoffs.example");
    save_project(&mut f, false);
    let (_, records) = claude_records(&[
        user(json!("Continue")),
        assistant(json!([{"type":"text","text":"Ok"}])),
    ]);
    let session = stored_session(&f, "claude", &records).0;
    let limit = handoffs::MEMORY_LIMIT;
    assert_eq!(limit, 524_288);
    let oversized = shared_memory(&f, "large.md", &"a".repeat(524_289));
    // Exactly at the limit, but redaction makes the secret longer.
    let growing = shared_memory(
        &f,
        "growing.md",
        &format!("API_KEY=x\n{}", "b".repeat(limit - 10)),
    );
    let multibyte = shared_memory(&f, "multibyte.md", &"é".repeat(limit / 2 + 7));
    let prepared = prepare(
        &session,
        json!({"memoryIds":[oversized, growing, multibyte]}),
    );
    for memory in prepared.body["memories"].as_array().unwrap() {
        let content = memory["content"].as_str().unwrap();
        assert!(
            content.len() <= 524_288,
            "{}: {}",
            memory["slug"],
            content.len()
        );
        assert!(
            content.contains("bytes in the original memory]"),
            "{}",
            memory["slug"]
        );
    }
    let growing = prepared.body["memories"][1]["content"].as_str().unwrap();
    assert!(growing.starts_with("API_KEY=[REDACTED]\n"));
    assert!(prepared.body["memories"][0]["content"]
        .as_str()
        .unwrap()
        .ends_with("[truncated; 524289 bytes in the original memory]\n"));
}

#[test]
fn live_claude_forks_never_read_through_a_replaced_parent_directory() {
    let mut f = Fixture::new();
    signed_in(&mut f, "https://handoffs.example");
    save_project(&mut f, false);
    let (native_id, records) = claude_records(&[
        user(json!("Original fork text")),
        assistant(json!([{"type":"text","text":"Ok"}])),
    ]);
    let (session, _) = stored_session(&f, "claude", &records);
    let native_directory = native::claude_home().unwrap().join("projects").join("repo");
    let outside = f._home.path().join("unrelated");
    fs::create_dir_all(&native_directory).unwrap();
    fs::create_dir_all(&outside).unwrap();
    let path = native_directory.join(format!("{native_id}.jsonl"));
    let mut live = records.clone();
    live[0]["message"]["content"] = json!("Live fork text");
    fs::write(&path, native::encode(&live)).unwrap();
    let mut unrelated = records.clone();
    unrelated[0]["message"]["content"] = json!("Unrelated fixture text");
    fs::write(
        outside.join(path.file_name().unwrap()),
        native::encode(&unrelated),
    )
    .unwrap();
    db::set(
        &f.db,
        &format!("sessionFork:{session}"),
        &json!({"nativeId":native_id}),
    )
    .unwrap();
    let mut binding = indexer::binding(&f.db, &session).unwrap();
    binding["paths"] = json!([path]);
    db::upsert(
        &f.db,
        "bindings",
        &session,
        f.project["id"].as_str().unwrap(),
        &binding,
    )
    .unwrap();
    // A legitimate fork reads its current native file.
    assert_eq!(
        prepare(&session, json!({})).body["turns"][0]["text"],
        "Live fork text"
    );
    fs::rename(&native_directory, native_directory.with_extension("parked")).unwrap();
    std::os::unix::fs::symlink(&outside, &native_directory).unwrap();
    // The replaced parent resolves outside the Claude home: use the stored copy.
    assert_eq!(
        prepare(&session, json!({})).body["turns"][0]["text"],
        "Original fork text"
    );

    // Inside the Claude home, a file at the fork's path can still hold a
    // different session's transcript; never read that one live.
    fs::remove_file(&native_directory).unwrap();
    let other_directory = native::claude_home()
        .unwrap()
        .join("projects")
        .join("other");
    fs::create_dir_all(&other_directory).unwrap();
    let (_, other) = claude_records(&[
        user(json!("Another session's private text")),
        assistant(json!([{"type":"text","text":"Other answer"}])),
    ]);
    fs::write(
        other_directory.join(path.file_name().unwrap()),
        native::encode(&other),
    )
    .unwrap();
    std::os::unix::fs::symlink(&other_directory, &native_directory).unwrap();
    let prepared = prepare(&session, json!({}));
    assert_eq!(prepared.body["turns"][0]["text"], "Original fork text");
    let text = String::from_utf8(prepared.bytes).unwrap();
    assert!(!text.contains("Another session's private text"), "{text}");
    assert!(!text.contains("Other answer"), "{text}");
}

#[test]
fn corrupt_live_claude_fork_falls_back_to_stored_snapshot() {
    let mut f = Fixture::new();
    signed_in(&mut f, "https://handoffs.example");
    save_project(&mut f, false);
    let (native_id, records) = claude_records(&[
        user(json!("Original fork text")),
        assistant(json!([{"type":"text","text":"Ok"}])),
    ]);
    let (session, _) = stored_session(&f, "claude", &records);
    let native_directory = native::claude_home().unwrap().join("projects").join("repo");
    fs::create_dir_all(&native_directory).unwrap();
    let path = native_directory.join(format!("{native_id}.jsonl"));
    fs::write(&path, "not valid jsonl {\n").unwrap();
    db::set(
        &f.db,
        &format!("sessionFork:{session}"),
        &json!({"nativeId":native_id}),
    )
    .unwrap();
    let mut binding = indexer::binding(&f.db, &session).unwrap();
    binding["paths"] = json!([path]);
    db::upsert(
        &f.db,
        "bindings",
        &session,
        f.project["id"].as_str().unwrap(),
        &binding,
    )
    .unwrap();

    let prepared = prepare(&session, json!({}));
    assert_eq!(prepared.body["turns"][0]["text"], "Original fork text");
}

#[test]
fn codex_mirrored_tools_merge_failures_and_details_in_either_order() {
    let user_text = json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Check the command"}]}});
    let call = json!({"type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{}","call_id":"call-1"}});
    let output = json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"call-1","output":"Process exited with code 1\nOutput: check failed"}});
    let mirror = json!({"type":"event_msg","payload":{"type":"item_completed","item":{"type":"commandExecution","id":"call-1","command":["cargo","test","--locked"],"exitCode":1,"status":"failed","aggregatedOutput":"check failed"}}});
    let meta = json!({"type":"session_meta","payload":{"id":uuid::Uuid::new_v4()}});
    for (order, records) in [
        (
            "rollout first",
            vec![
                meta.clone(),
                user_text.clone(),
                call.clone(),
                output.clone(),
                mirror.clone(),
            ],
        ),
        (
            "app-server first",
            vec![
                meta.clone(),
                user_text.clone(),
                mirror.clone(),
                call.clone(),
                output.clone(),
            ],
        ),
    ] {
        let turns = handoffs::transcript(&records, true).unwrap();
        let tools: Vec<_> = turns.iter().flat_map(|turn| &turn.tools).collect();
        assert_eq!(tools.len(), 1, "{order}");
        assert!(tools[0].is_error, "{order}");
        assert_eq!(tools[0].input, "cargo test --locked", "{order}");
        assert_eq!(
            tools[0].output, "Process exited with code 1\nOutput: check failed",
            "{order}"
        );
    }
    // A later successful mirror never clears a failure.
    let mut ok = mirror.clone();
    ok["payload"]["item"]["exitCode"] = json!(0);
    ok["payload"]["item"]["status"] = json!("completed");
    let mut failed = output.clone();
    failed["payload"]["output"] = json!({"content":"boom","success":false});
    let turns = handoffs::transcript(&[meta, user_text, call, failed, ok], true).unwrap();
    assert!(turns
        .iter()
        .flat_map(|turn| &turn.tools)
        .all(|tool| tool.is_error));
}

#[test]
fn codex_legacy_user_events_after_their_response_are_not_repeated() {
    let records = [
        json!({"type":"session_meta","payload":{"id":uuid::Uuid::new_v4()}}),
        json!({"type":"event_msg","payload":{"type":"task_started"}}),
        json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Check the command"}]}}),
        json!({"type":"event_msg","payload":{"type":"user_message","message":"Check the command"}}),
        json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Checked"}]}}),
    ];
    for include_tools in [false, true] {
        let turns = handoffs::transcript(&records, include_tools).unwrap();
        let shape: Vec<_> = turns
            .iter()
            .map(|turn| (turn.role, turn.text.as_str()))
            .collect();
        assert_eq!(
            shape,
            vec![("user", "Check the command"), ("assistant", "Checked")],
            "tools={include_tools}"
        );
    }

    // Reasoning or tool records between the response and its legacy event do
    // not hide the mirror; a prompt repeated after a reply is a new turn.
    let prompt = json!({"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_text","text":"Check the command"}]}});
    let legacy =
        json!({"type":"event_msg","payload":{"type":"user_message","message":"Check the command"}});
    let reply = json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Checked"}]}});
    let records = [
        json!({"type":"session_meta","payload":{"id":uuid::Uuid::new_v4()}}),
        json!({"type":"event_msg","payload":{"type":"task_started"}}),
        prompt.clone(),
        json!({"type":"response_item","payload":{"type":"reasoning","summary":[{"type":"summary_text","text":"Planning the check"}],"content":null,"encrypted_content":"opaque"}}),
        json!({"type":"response_item","payload":{"type":"function_call","name":"exec_command","arguments":"{}","call_id":"call-1"}}),
        json!({"type":"response_item","payload":{"type":"function_call_output","call_id":"call-1","output":"ok"}}),
        legacy.clone(),
        reply.clone(),
        json!({"type":"event_msg","payload":{"type":"task_started"}}),
        prompt,
        json!({"type":"response_item","payload":{"type":"reasoning","summary":[],"content":null,"encrypted_content":"opaque"}}),
        legacy,
        reply,
    ];
    for include_tools in [false, true] {
        let turns = handoffs::transcript(&records, include_tools).unwrap();
        let shape: Vec<_> = turns
            .iter()
            .filter(|turn| !turn.text.is_empty())
            .map(|turn| (turn.role, turn.text.as_str()))
            .collect();
        assert_eq!(
            shape,
            vec![
                ("user", "Check the command"),
                ("assistant", "Checked"),
                ("user", "Check the command"),
                ("assistant", "Checked"),
            ],
            "tools={include_tools}"
        );
    }
}

#[test]
fn long_titles_and_post_redaction_notes_stay_within_api_char_limits() {
    let f = Fixture::new();
    let (_, records) = claude_records(&[user(json!("Check title and note limits"))]);
    let (session, _) = stored_session(&f, "claude", &records);
    let project = f.project["id"].as_str().unwrap();
    let mut resource = crate::local_resources::resource(&f.db, &session).unwrap();
    resource["title"] = json!("é".repeat(300));
    db::upsert(&f.db, "resources", &session, project, &resource).unwrap();

    let candidates = handoffs::candidates_with(&f.db, &session).unwrap();
    let listed_title = candidates["session"]["title"].as_str().unwrap();
    assert_eq!(listed_title.chars().count(), handoffs::TITLE_LIMIT);

    // 500 chars with a line-start secret expands past 500 when replaced with [REDACTED].
    let note = format!("password=x\n{}", "a".repeat(handoffs::NOTE_LIMIT - 11));
    assert_eq!(note.chars().count(), handoffs::NOTE_LIMIT);
    let prepared =
        handoffs::prepare_with(&f.db, &json!({"sessionId": session, "handoffNote": note})).unwrap();
    let sent_title = prepared.body["title"].as_str().unwrap();
    let sent_note = prepared.body["handoffNote"].as_str().unwrap();
    assert_eq!(sent_title.chars().count(), handoffs::TITLE_LIMIT);
    assert!(
        sent_note.chars().count() <= handoffs::NOTE_LIMIT,
        "len={}",
        sent_note.chars().count()
    );
    assert!(sent_note.contains("[REDACTED]"), "{sent_note}");
    assert!(!sent_note.contains("password=x"), "{sent_note}");
}

#[test]
fn oversized_memories_are_redacted_before_truncation() {
    let mut f = Fixture::new();
    signed_in(&mut f, "https://handoffs.example");
    save_project(&mut f, false);
    let (_, records) = claude_records(&[
        user(json!("Continue")),
        assistant(json!([{"type":"text","text":"Ok"}])),
    ]);
    let session = stored_session(&f, "claude", &records).0;
    let limit = handoffs::MEMORY_LIMIT;
    // A recognized secret that a cut at the limit would leave as a shorter,
    // unrecognized fragment.
    let straddling = |secret: &str| {
        let size = limit + 4096;
        let marker = format!("\n\n… [truncated; {size} bytes in the original memory]\n");
        let start = limit - marker.len() - 12;
        let mut content = format!("{} {secret} ", "a".repeat(start - 1));
        content.push_str(&"b".repeat(size - content.len()));
        assert_eq!(content.len(), size);
        content
    };
    let token = format!("sk-{}", "Q".repeat(64));
    let key = format!(
        "-----BEGIN RSA PRIVATE KEY-----\n{}\n-----END RSA PRIVATE KEY-----",
        "Kz".repeat(64)
    );
    let token_memory = shared_memory(&f, "token.md", &straddling(&token));
    let key_memory = shared_memory(&f, "key.md", &straddling(&key));
    let prepared = prepare(&session, json!({"memoryIds":[token_memory, key_memory]}));
    for memory in prepared.body["memories"].as_array().unwrap() {
        let content = memory["content"].as_str().unwrap();
        assert!(content.len() <= 524_288, "{}", content.len());
        assert!(content.contains("[REDACTED]"), "{}", memory["slug"]);
        assert!(content.contains("bytes in the original memory]"));
        for fragment in ["sk-", "QQQQ", "BEGIN", "PRIVATE KEY", "KzKz"] {
            assert!(
                !content.contains(fragment),
                "{}: {fragment}",
                memory["slug"]
            );
        }
    }
    let candidates = handoffs::candidates_with(&f.db, &session).unwrap();
    for id in [&token_memory, &key_memory] {
        let listed = candidates["memories"]
            .as_array()
            .unwrap()
            .iter()
            .find(|m| m["id"] == *id)
            .unwrap();
        assert_eq!(listed["redactionCount"], 1, "{id}");
    }
}

#[tokio::test]
async fn a_receipt_without_a_link_keeps_the_snapshot_for_the_retry() {
    let mut f = Fixture::new();
    let browser = "http://localhost:3000";
    let id = uuid::Uuid::new_v4().to_string();
    let link = format!("{browser}/handoff/{}", "c".repeat(64));
    let service = Service::start(
        vec![
            instance(browser),
            ("POST /v2/handoffs".into(), 201, json!({"id":id})),
            (
                "POST /v2/handoffs".into(),
                200,
                json!({"id":id,"url":link,"expiresAt":"2026-12-05T00:00:00Z"}),
            ),
        ],
        None,
    )
    .await;
    let mut input = signed_in(&mut f, &service.url);
    save_project(&mut f, false);
    let (_, records) = claude_records(&[
        user(json!("Continue the release")),
        assistant(json!([{"type":"text","text":"Release is ready"}])),
    ]);
    let (session, _) = stored_session(&f, "claude", &records);
    input["sessionId"] = json!(session);
    input["requestId"] = json!(uuid::Uuid::new_v4().to_string());
    let error = handoffs::create(input.clone()).await.unwrap_err();
    assert!(error.contains("unexpected handoff link"), "{error}");

    let mut newer = records.clone();
    let mut answer = assistant(json!([{"type":"text","text":"New turn since first try"}]));
    answer["sessionId"] = records[0]["sessionId"].clone();
    answer["cwd"] = records[0]["cwd"].clone();
    newer.push(answer);
    replace_snapshot(&f, &session, &newer);

    let result = handoffs::create(input).await.unwrap();
    assert_eq!(result["id"], id);
    assert_eq!(result["url"], link);
    let sent = service.raw_bodies("POST /v2/handoffs");
    assert_eq!(sent.len(), 2);
    assert_eq!(sent[0], sent[1], "bodies differ");
    assert!(!String::from_utf8_lossy(&sent[1]).contains("New turn since first try"));
}

#[tokio::test]
async fn an_unreachable_retry_after_an_unconfirmed_send_never_says_nothing_was_shared() {
    let mut f = Fixture::new();
    let browser = "http://localhost:3000";
    let id = uuid::Uuid::new_v4().to_string();
    let link = format!("{browser}/handoff/{}", "d".repeat(64));
    let service = Service::start(
        vec![
            instance(browser),
            ("POST /v2/handoffs".into(), DROP, Value::Null),
            ("GET /v2/instance".into(), DROP, Value::Null),
            instance(browser),
            ("POST /v2/handoffs".into(), 201, json!({"id":id,"url":link})),
        ],
        None,
    )
    .await;
    let mut input = signed_in(&mut f, &service.url);
    save_project(&mut f, false);
    let (_, records) = claude_records(&[
        user(json!("Continue")),
        assistant(json!([{"type":"text","text":"Ok"}])),
    ]);
    input["sessionId"] = json!(stored_session(&f, "claude", &records).0);
    input["requestId"] = json!(uuid::Uuid::new_v4().to_string());

    assert_eq!(
        handoffs::create(input.clone()).await.unwrap_err(),
        handoffs::UNCONFIRMED
    );
    // The first send may have arrived, so an unreachable service stays unconfirmed.
    let error = handoffs::create(input.clone()).await.unwrap_err();
    assert_eq!(error, handoffs::UNCONFIRMED);
    assert!(!error.contains("Nothing was shared"), "{error}");
    let result = handoffs::create(input).await.unwrap();
    assert_eq!(result["id"], id);
    let sent = service.raw_bodies("POST /v2/handoffs");
    assert_eq!(sent.len(), 2);
    assert_eq!(sent[0], sent[1], "bodies differ");
    assert_eq!(
        service.routes(),
        vec![
            "GET /v2/instance",
            "POST /v2/handoffs",
            "GET /v2/instance",
            "GET /v2/instance",
            "POST /v2/handoffs",
        ]
    );
}

#[tokio::test]
async fn overlapping_creates_for_the_same_request_id_keep_the_unconfirmed_snapshot() {
    async fn read_request(
        stream: tokio::net::TcpStream,
    ) -> (BufReader<tokio::net::TcpStream>, String, Vec<u8>) {
        let mut reader = BufReader::new(stream);
        let mut line = String::new();
        reader.read_line(&mut line).await.unwrap();
        let route = line.trim_end().trim_end_matches(" HTTP/1.1").to_owned();
        let mut length = 0;
        loop {
            line.clear();
            if reader.read_line(&mut line).await.unwrap_or(0) == 0 || line == "\r\n" {
                break;
            }
            if let Some((name, value)) = line.split_once(':') {
                if name.eq_ignore_ascii_case("content-length") {
                    length = value.trim().parse().unwrap();
                }
            }
        }
        let mut body = vec![0; length];
        reader.read_exact(&mut body).await.unwrap();
        (reader, route, body)
    }

    async fn respond(reader: &mut BufReader<tokio::net::TcpStream>, status: u16, body: Value) {
        let payload = body.to_string();
        let response = format!(
            "HTTP/1.1 {status} Test\r\ncontent-type: application/json\r\ncontent-length: {}\r\nconnection: close\r\n\r\n{payload}",
            payload.len()
        );
        reader
            .get_mut()
            .write_all(response.as_bytes())
            .await
            .unwrap();
        let _ = reader.get_mut().shutdown().await;
    }

    let mut f = Fixture::new();
    let browser = "http://localhost:3000";
    let id = uuid::Uuid::new_v4().to_string();
    let link = format!("{browser}/handoff/{}", "e".repeat(64));
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let url = format!("http://{addr}");

    let instance_started = Arc::new(tokio::sync::Notify::new());
    let release_first_instance = Arc::new(tokio::sync::Notify::new());
    let server_started = instance_started.clone();
    let server_release = release_first_instance.clone();
    let instance_body = json!({"version":1,"browserHandoffs":1,"auth":{"browserOrigin":browser}});
    let server = tokio::spawn(async move {
        // Call 1: hold GET /v2/instance before either call caches anything, so without
        // request_lock Call 2 would pass resend() concurrently with earlier=false.
        let (stream, _) = listener.accept().await.unwrap();
        let (mut reader, route, _) = read_request(stream).await;
        assert_eq!(route, "GET /v2/instance");
        server_started.notify_one();
        server_release.notified().await;
        respond(&mut reader, 200, instance_body.clone()).await;

        let (stream, _) = listener.accept().await.unwrap();
        let (reader, route, first_body) = read_request(stream).await;
        assert_eq!(route, "POST /v2/handoffs");
        drop(reader);

        // Call 2 (serialized behind Call 1): GET /v2/instance (200), then close listener so POST is refused.
        let (stream, _) = listener.accept().await.unwrap();
        let (mut reader, route, _) = read_request(stream).await;
        assert_eq!(route, "GET /v2/instance");
        respond(&mut reader, 200, instance_body).await;
        drop(reader);
        drop(listener);
        first_body
    });

    let mut input = signed_in(&mut f, &url);
    save_project(&mut f, false);
    let (_, records) = claude_records(&[
        user(json!("Continue")),
        assistant(json!([{"type":"text","text":"Ok"}])),
    ]);
    let (session, _) = stored_session(&f, "claude", &records);
    input["sessionId"] = json!(session);
    input["requestId"] = json!(uuid::Uuid::new_v4().to_string());

    let first = tokio::spawn(handoffs::create(input.clone()));
    instance_started.notified().await;
    // Start Call 2 while Call 1's GET /v2/instance is still pending; request_lock holds Call 2 until Call 1 settles.
    let second = tokio::spawn(handoffs::create(input.clone()));
    tokio::time::sleep(std::time::Duration::from_millis(25)).await;
    release_first_instance.notify_one();

    let (first_result, second_result, first_body) = tokio::join!(first, second, server);
    assert_eq!(first_result.unwrap().unwrap_err(), handoffs::UNCONFIRMED);
    let second_error = second_result.unwrap().unwrap_err();
    assert_eq!(second_error, handoffs::UNCONFIRMED);
    assert!(
        !second_error.contains("Nothing was shared"),
        "{second_error}"
    );
    let first_body = first_body.unwrap();

    // Grow the session locally, rebind on the same origin, and verify retry repeats the cached bytes.
    let mut newer = records.clone();
    let mut answer = assistant(json!([{"type":"text","text":"New turn after overlap"}]));
    answer["sessionId"] = records[0]["sessionId"].clone();
    answer["cwd"] = records[0]["cwd"].clone();
    newer.push(answer);
    replace_snapshot(&f, &session, &newer);

    let socket = tokio::net::TcpSocket::new_v4().unwrap();
    socket.set_reuseaddr(true).unwrap();
    socket.bind(addr).unwrap();
    let listener = socket.listen(16).unwrap();
    let retry_instance = json!({"version":1,"browserHandoffs":1,"auth":{"browserOrigin":browser}});
    let retry_receipt = json!({"id":id,"url":link,"expiresAt":"2026-12-05T00:00:00Z"});
    let retry_server = tokio::spawn(async move {
        let (stream, _) = listener.accept().await.unwrap();
        let (mut reader, route, _) = read_request(stream).await;
        assert_eq!(route, "GET /v2/instance");
        respond(&mut reader, 200, retry_instance).await;

        let (stream, _) = listener.accept().await.unwrap();
        let (mut reader, route, retry_body) = read_request(stream).await;
        assert_eq!(route, "POST /v2/handoffs");
        respond(&mut reader, 200, retry_receipt).await;
        retry_body
    });

    let result = handoffs::create(input).await.unwrap();
    assert_eq!(result["id"], id);
    assert_eq!(result["url"], link);
    let retry_body = retry_server.await.unwrap();
    assert_eq!(first_body, retry_body);
    assert!(!String::from_utf8_lossy(&retry_body).contains("New turn after overlap"));
}

#[tokio::test]
async fn create_handoff_command_reports_explicit_retry_disposition() {
    let mut f = Fixture::new();
    let browser = "http://localhost:3000";

    // Local secret failures fail terminally, strip SECRET_CODE, and classify kind="secret".
    assert_eq!(
        handoffs::CreateHandoffError::from_raw(
            format!(
                "{}: Orka found a secret it couldn’t remove from this handoff, so nothing was sent.",
                handoffs::SECRET_CODE
            ),
            true
        ),
        handoffs::CreateHandoffError {
            message:
                "Orka found a secret it couldn’t remove from this handoff, so nothing was sent."
                    .to_owned(),
            kind: "secret",
            preserve_request_id: false,
        }
    );

    // Terminal vs retryable/potentially-accepted HTTP & receipt outcomes.
    for (status, body, expected_kind, expected_preserve, expected_fragment) in [
        (
            422,
            json!({"error":"This handoff still contains a recognized secret. Nothing was shared.","code":"HANDOFF_SECRET"}),
            "secret",
            false,
            "recognized secret",
        ),
        (
            400,
            json!({"error":"Invalid request"}),
            "general",
            false,
            "Invalid request",
        ),
        (
            404,
            json!({"error":"Handoff unavailable"}),
            "general",
            false,
            "doesn’t support browser handoffs",
        ),
        (
            409,
            json!({"error":"This request ID was already used for a different handoff"}),
            "general",
            false,
            "already used for a different handoff",
        ),
        (
            409,
            json!({"error":"This handoff is no longer active. Use a new request ID."}),
            "general",
            false,
            "no longer active",
        ),
        (
            413,
            json!({"error":"Handoff exceeds payload size limit"}),
            "general",
            false,
            "too large for your Orka service",
        ),
        (
            429,
            json!({"error":"You reached the hourly limit for new handoffs. Try again later."}),
            "general",
            true,
            "hourly limit",
        ),
        (
            429,
            json!({"error":"You have 100 active handoffs. Revoke one before sharing another."}),
            "general",
            true,
            "100 active handoffs",
        ),
        (
            500,
            json!({"error":"Service unavailable"}),
            "general",
            true,
            handoffs::UNCONFIRMED,
        ),
        (DROP, Value::Null, "general", true, handoffs::UNCONFIRMED),
        (201, Value::Null, "general", true, handoffs::UNCONFIRMED),
        (
            201,
            json!({"id":"not-a-uuid","url":format!("{browser}/handoff/{}", "a".repeat(64))}),
            "general",
            true,
            "unexpected handoff",
        ),
        (
            201,
            json!({"id":uuid::Uuid::new_v4().to_string(),"url":"https://evil.example/handoff/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"}),
            "general",
            true,
            "unexpected handoff link",
        ),
    ] {
        let service = Service::start(
            vec![
                instance(browser),
                ("POST /v2/handoffs".into(), status, body),
            ],
            None,
        )
        .await;
        let mut input = signed_in(&mut f, &service.url);
        save_project(&mut f, false);
        let (_, records) = claude_records(&[
            user(json!("Continue")),
            assistant(json!([{"type":"text","text":"Ok"}])),
        ]);
        input["sessionId"] = json!(stored_session(&f, "claude", &records).0);
        input["requestId"] = json!(uuid::Uuid::new_v4().to_string());
        let error = handoffs::create_outcome(input).await.unwrap_err();
        assert_eq!(error.kind, expected_kind, "status={status}");
        assert_eq!(
            error.preserve_request_id, expected_preserve,
            "status={status}"
        );
        assert!(
            error.message.contains(expected_fragment),
            "status={status}: {}",
            error.message
        );
        assert!(
            !error.message.starts_with(handoffs::SECRET_CODE),
            "status={status}: {}",
            error.message
        );
    }

    // First-attempt unreachable before POST clears requestId; retry unreachable after earlier UNCONFIRMED preserves it.
    let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
    let addr = listener.local_addr().unwrap();
    let url = format!("http://{addr}");
    drop(listener);
    let mut offline_input = signed_in(&mut f, &url);
    save_project(&mut f, false);
    let (_, records) = claude_records(&[
        user(json!("Continue")),
        assistant(json!([{"type":"text","text":"Ok"}])),
    ]);
    offline_input["sessionId"] = json!(stored_session(&f, "claude", &records).0);
    offline_input["requestId"] = json!(uuid::Uuid::new_v4().to_string());
    assert_eq!(
        handoffs::create_outcome(offline_input).await.unwrap_err(),
        handoffs::CreateHandoffError {
            message: handoffs::NOT_SENT.to_owned(),
            kind: "general",
            preserve_request_id: false,
        }
    );

    let service = Service::start(
        vec![
            instance(browser),
            ("POST /v2/handoffs".into(), DROP, Value::Null),
            ("GET /v2/instance".into(), DROP, Value::Null),
        ],
        None,
    )
    .await;
    let mut retry_input = signed_in(&mut f, &service.url);
    save_project(&mut f, false);
    let (_, records) = claude_records(&[
        user(json!("Continue")),
        assistant(json!([{"type":"text","text":"Ok"}])),
    ]);
    retry_input["sessionId"] = json!(stored_session(&f, "claude", &records).0);
    retry_input["requestId"] = json!(uuid::Uuid::new_v4().to_string());
    let first = handoffs::create_outcome(retry_input.clone())
        .await
        .unwrap_err();
    assert!(first.preserve_request_id);
    assert_eq!(first.message, handoffs::UNCONFIRMED);
    let second = handoffs::create_outcome(retry_input).await.unwrap_err();
    assert_eq!(
        second,
        handoffs::CreateHandoffError {
            message: handoffs::UNCONFIRMED.to_owned(),
            kind: "general",
            preserve_request_id: true,
        }
    );
}

#[tokio::test]
async fn post_send_scope_read_failure_preserves_request_id_while_scope_change_clears_it() {
    use std::sync::atomic::{AtomicBool, Ordering};

    let mut f = Fixture::new();
    let browser = "http://localhost:3000";
    let id = uuid::Uuid::new_v4().to_string();
    let link = format!("{browser}/handoff/{}", "f".repeat(64));

    // Case 1: temporary local config-read error after POST 201 preserves requestId & cached snapshot.
    let injected = Arc::new(AtomicBool::new(false));
    let injected_hook = injected.clone();
    let corrupt_config: Hook = Box::new(move |route| {
        if route == "POST /v2/handoffs" && !injected_hook.swap(true, Ordering::SeqCst) {
            std::fs::write(db::root().unwrap().join("config.json"), "{broken").unwrap();
        }
    });
    let service = Service::start(
        vec![
            instance(browser),
            ("POST /v2/handoffs".into(), 201, json!({"id":id,"url":link})),
        ],
        Some(corrupt_config),
    )
    .await;
    let mut input = signed_in(&mut f, &service.url);
    save_project(&mut f, false);
    let (_, records) = claude_records(&[
        user(json!("Continue")),
        assistant(json!([{"type":"text","text":"Ok"}])),
    ]);
    let (session, _) = stored_session(&f, "claude", &records);
    input["sessionId"] = json!(session);
    input["requestId"] = json!(uuid::Uuid::new_v4().to_string());

    let post_send_error = handoffs::create_outcome(input.clone()).await.unwrap_err();
    assert_ne!(post_send_error.message, handoffs::SCOPE_CHANGED);
    assert_eq!(post_send_error.kind, "general");
    assert!(post_send_error.preserve_request_id);

    // Restore config and append a local turn; retrying the same requestId replays identical bytes.
    std::fs::write(
        db::root().unwrap().join("config.json"),
        serde_json::to_vec(&json!({"apiUrl": service.url})).unwrap(),
    )
    .unwrap();
    let mut newer = records.clone();
    let mut answer = assistant(json!([{"type":"text","text":"New turn after config glitch"}]));
    answer["sessionId"] = records[0]["sessionId"].clone();
    answer["cwd"] = records[0]["cwd"].clone();
    newer.push(answer);
    replace_snapshot(&f, &session, &newer);

    let receipt = handoffs::create_outcome(input).await.unwrap();
    assert_eq!(receipt["id"], id);
    assert_eq!(receipt["url"], link);
    let bodies = service.raw_bodies("POST /v2/handoffs");
    assert_eq!(bodies.len(), 2);
    assert_eq!(bodies[0], bodies[1]);
    assert!(!String::from_utf8_lossy(&bodies[1]).contains("New turn after config glitch"));
    drop(service);

    // Case 2: confirmed SCOPE_CHANGED after POST still clears snapshot and returns preserve_request_id=false.
    let switched: Hook = Box::new(|route| {
        if route == "POST /v2/handoffs" {
            let db = db::open().unwrap();
            db::set(&db, "user", &json!(uuid::Uuid::new_v4().to_string())).unwrap();
        }
    });
    let service = Service::start(
        vec![
            instance(browser),
            (
                "POST /v2/handoffs".into(),
                201,
                json!({"id":uuid::Uuid::new_v4().to_string(),"url":link}),
            ),
        ],
        Some(switched),
    )
    .await;
    let mut input = signed_in(&mut f, &service.url);
    save_project(&mut f, false);
    let (_, records) = claude_records(&[
        user(json!("Continue")),
        assistant(json!([{"type":"text","text":"Ok"}])),
    ]);
    input["sessionId"] = json!(stored_session(&f, "claude", &records).0);
    input["requestId"] = json!(uuid::Uuid::new_v4().to_string());
    let changed = handoffs::create_outcome(input).await.unwrap_err();
    assert_eq!(changed.message, handoffs::SCOPE_CHANGED);
    assert_eq!(changed.kind, "general");
    assert!(!changed.preserve_request_id);
}
