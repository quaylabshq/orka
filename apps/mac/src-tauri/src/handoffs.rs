//! Browser Handoffs: a redacted, size-capped copy of one session and selected
//! project memories that the Orka service serves at a private browser link.
//! Nothing here changes sharing, sync or governance state.
use crate::{
    db::{self, Result},
    governance, indexer, local_resources, native, projects, session_forks, session_presentation,
    session_redaction::SessionRedactor,
    session_translation, sync,
};
use rusqlite::Connection;
use serde::Serialize;
use serde_json::{json, Value};
use std::collections::{HashMap, HashSet};
use uuid::Uuid;

pub(crate) const TOOL_INPUT_LIMIT: usize = 4 * 1024;
pub(crate) const TOOL_OUTPUT_LIMIT: usize = 8 * 1024;
pub(crate) const TOOL_OUTPUT_REDUCED: usize = 2 * 1024;
pub(crate) const MEMORY_LIMIT: usize = 512 * 1024;
pub(crate) const PAYLOAD_LIMIT: usize = 3_500_000;
pub(crate) const TITLE_LIMIT: usize = 240;
pub(crate) const NOTE_LIMIT: usize = 500;
pub(crate) const OUTPUT_OMITTED: &str = "[Output omitted to fit the handoff size limit]";
const HEAD_PERCENT: usize = 65;
const REDACTED: &str = "[REDACTED]";
const ROOT_INSTRUCTIONS: [&str; 4] = [
    "CLAUDE.md",
    "AGENTS.md",
    "CLAUDE.local.md",
    "AGENTS.override.md",
];
pub(crate) const SCOPE_CHANGED: &str = "Account or service changed. Open the handoff again.";
pub(crate) const UNSUPPORTED: &str =
    "This Orka service doesn’t support browser handoffs yet. Update the service and try again.";
const UNREACHABLE: &str = "Couldn’t reach your Orka service. Reconnect and try again.";
/// Only for failures before the handoff itself was sent.
pub(crate) const NOT_SENT: &str =
    "Couldn’t reach your Orka service. Nothing was shared. Reconnect and try again.";
/// The handoff may have reached the service; retrying the same request ID
/// recovers its link without creating another.
pub(crate) const UNCONFIRMED: &str =
    "Your Orka service didn’t confirm this handoff. Try again to get its link.";
pub(crate) const TOO_LARGE: &str =
    "This handoff is too large for your Orka service. Turn off tool calls or attach fewer memories. Nothing was shared.";
/// The leading code of every error for a secret that blocked a handoff,
/// whether this Mac or the service found it.
pub(crate) const SECRET_CODE: &str = "HANDOFF_SECRET";
const MEMORY_UNAVAILABLE: &str =
    "A selected memory is no longer available. Refresh the handoff and try again.";
const SENT_LIMIT: usize = 4;

/// The account and service a request started with. Every service call is bound
/// to it, and the local database is rechecked around each call.
struct Scope {
    account: String,
    origin: String,
}

impl Scope {
    fn from_input(input: &Value) -> Result<Self> {
        let field = |key: &str| {
            input[key]
                .as_str()
                .filter(|value| !value.is_empty())
                .map(str::to_owned)
                .ok_or(SCOPE_CHANGED)
        };
        Ok(Self {
            account: field("accountId")?,
            origin: field("serviceOrigin")?,
        })
    }

    /// An explicit scope from the window, or the active one when none is given.
    fn current_or(account: Option<String>, origin: Option<String>) -> Result<Self> {
        let db = db::open()?;
        let scope = match (account, origin) {
            (Some(account), Some(origin)) => Self { account, origin },
            (None, None) => Self {
                account: db::get(&db, "user")?
                    .as_str()
                    .ok_or("Sign in required")?
                    .to_owned(),
                origin: db::get(&db, "config")?["apiUrl"]
                    .as_str()
                    .ok_or("Choose a service")?
                    .to_owned(),
            },
            _ => return Err(SCOPE_CHANGED.into()),
        };
        scope.check(&db)?;
        Ok(scope)
    }

    fn check(&self, db: &Connection) -> Result<()> {
        let user = db::get(db, "user")?;
        let config = db::get(db, "config")?;
        if user.as_str() != Some(self.account.as_str())
            || config["apiUrl"]
                .as_str()
                .map(|value| value.trim_end_matches('/'))
                != Some(self.origin.trim_end_matches('/'))
        {
            return Err(SCOPE_CHANGED.into());
        }
        Ok(())
    }

    fn recheck(&self) -> Result<()> {
        self.check(&db::open()?)
    }

    async fn api(&self, method: &str, path: &str, body: Option<&Value>) -> Result<Value> {
        self.recheck()?;
        let result = sync::api_at(&self.account, &self.origin, method, path, body).await;
        // Never act on, or report, a response after the window changed scope.
        self.recheck()?;
        match result {
            // A successful empty response cannot be read as JSON.
            Err(error) if error.starts_with("204:") => Ok(Value::Null),
            Err(error) if error == "Cloud unavailable; local work stays queued" => {
                Err(UNREACHABLE.into())
            }
            other => other,
        }
    }

    fn key(&self, request: &str) -> SentKey {
        (
            self.account.clone(),
            self.origin.trim_end_matches('/').to_owned(),
            request.to_owned(),
        )
    }

    /// The validated browser origin, or an error when handoffs are unavailable.
    async fn browser_origin(&self) -> Result<Option<reqwest::Url>> {
        let instance = match self.api("GET", "/v2/instance", None).await {
            Err(error) if error.starts_with("404:") => return Ok(None),
            other => other?,
        };
        if instance["browserHandoffs"] != 1 {
            return Ok(None);
        }
        browser_origin(&instance).map(Some)
    }
}

pub(crate) fn browser_origin(instance: &Value) -> Result<reqwest::Url> {
    let invalid = "The Orka service returned an invalid browser address for handoffs.";
    let raw = instance["auth"]["browserOrigin"].as_str().ok_or(invalid)?;
    let url = db::validate_url(raw).map_err(|_| invalid)?;
    if url.path() != "/" || url.host_str().is_none() {
        return Err(invalid.into());
    }
    Ok(url)
}

/// A link is only returned when it opens a handoff on the service's own browser
/// origin at exactly `/handoff/<token>`, the token the Dashboard accepts.
pub(crate) fn checked_link(raw: &str, browser: &reqwest::Url) -> Result<String> {
    let invalid = "The Orka service returned an unexpected handoff link. Nothing was opened.";
    let url = reqwest::Url::parse(raw).map_err(|_| invalid)?;
    let token = url.path().strip_prefix("/handoff/").unwrap_or("");
    if url.origin() != browser.origin()
        || url.scheme() != browser.scheme()
        || !url.username().is_empty()
        || url.password().is_some()
        || url.query().is_some()
        || url.fragment().is_some()
        || token.len() != 64
        || !token
            .bytes()
            .all(|byte| matches!(byte, b'0'..=b'9' | b'a'..=b'f'))
    {
        return Err(invalid.into());
    }
    Ok(url.to_string())
}

type SentKey = (String, String, String);

/// What one request ID sent: its exact bytes and the counts reported for them.
struct Sending {
    key: SentKey,
    selection: Value,
    body: Vec<u8>,
    summary: [usize; 4],
}

/// Recent unconfirmed handoffs. A retry after a timeout or lost acknowledgement
/// must repeat the exact snapshot, even after the session has grown, or the
/// service rejects the request ID as a different handoff.
static SENT: std::sync::Mutex<std::collections::VecDeque<Sending>> =
    std::sync::Mutex::new(std::collections::VecDeque::new());

static IN_FLIGHT: std::sync::LazyLock<
    std::sync::Mutex<HashMap<SentKey, std::sync::Weak<tokio::sync::Mutex<()>>>>,
> = std::sync::LazyLock::new(Default::default);

/// Serialize calls sharing one account, service and request ID so an
/// overlapping refused attempt cannot see a stale pre-flight cache and erase
/// an unconfirmed snapshot.
fn request_lock(key: &SentKey) -> std::sync::Arc<tokio::sync::Mutex<()>> {
    let mut map = IN_FLIGHT
        .lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner);
    map.retain(|_, lock| lock.strong_count() > 0);
    if let Some(lock) = map.get(key).and_then(std::sync::Weak::upgrade) {
        return lock;
    }
    let lock = std::sync::Arc::new(tokio::sync::Mutex::new(()));
    map.insert(key.clone(), std::sync::Arc::downgrade(&lock));
    lock
}

fn sent() -> std::sync::MutexGuard<'static, std::collections::VecDeque<Sending>> {
    SENT.lock()
        .unwrap_or_else(std::sync::PoisonError::into_inner)
}

fn forget(key: &SentKey) {
    sent().retain(|sending| sending.key != *key);
}

fn has_cached(key: &SentKey) -> bool {
    sent().iter().any(|sending| sending.key == *key)
}

fn remember(sending: Sending) {
    let mut sent = sent();
    sent.retain(|known| known.key != sending.key);
    if sent.len() >= SENT_LIMIT {
        sent.pop_front();
    }
    sent.push_back(sending);
}

/// The bytes already sent for this request ID with the same selection.
fn resend(key: &SentKey, selection: &Value) -> Option<(Vec<u8>, [usize; 4])> {
    let mut sent = sent();
    let at = sent.iter().position(|sending| sending.key == *key)?;
    if sent[at].selection != *selection {
        // A changed selection is a different handoff; the service decides.
        sent.remove(at);
        return None;
    }
    Some((sent[at].body.clone(), sent[at].summary))
}

/// Map a rejected create to user copy. A secret keeps its leading code.
fn create_error(status: u16, body: &Value) -> String {
    let message = body["error"].as_str().filter(|message| !message.is_empty());
    match status {
        422 if body["code"] == SECRET_CODE => format!(
            "{SECRET_CODE}: {}",
            message
                .unwrap_or("This handoff still contains a recognized secret. Nothing was shared.")
        ),
        413 => TOO_LARGE.to_owned(),
        404 => UNSUPPORTED.to_owned(),
        429 => message
            .unwrap_or("You reached the limit for new handoffs. Try again later.")
            .to_owned(),
        400..=499 => message
            .unwrap_or("The Orka service rejected this handoff.")
            .to_owned(),
        _ => UNCONFIRMED.to_owned(),
    }
}

/// Statuses after which the same request ID can never succeed with these bytes.
fn terminal(status: u16) -> bool {
    matches!(status, 400 | 404 | 409 | 413 | 422)
}

fn service_error(error: String) -> String {
    for status in [
        "400: ", "403: ", "404: ", "409: ", "413: ", "422: ", "429: ",
    ] {
        if let Some(message) = error.strip_prefix(status) {
            return message.to_owned();
        }
    }
    error
}

/// Count and scrub recognized secrets with the same rules as session uploads.
#[derive(Default)]
struct Redactor {
    count: usize,
}

impl Redactor {
    fn text(&mut self, text: &str) -> String {
        let redacted = SessionRedactor::text(text);
        // Stored transcripts can already be redacted; report what leaves scrubbed.
        self.count += redacted.matches(REDACTED).count();
        redacted
    }
}

/// Keep the head and tail of long text within `limit` bytes, marker included.
pub(crate) fn cap(text: &str, limit: usize, original: usize) -> (String, bool) {
    if text.len() <= limit {
        return (text.to_owned(), false);
    }
    let marker = format!("\n\n… [truncated; {original} bytes in the original] …\n\n");
    let budget = limit.saturating_sub(marker.len());
    let head = text.floor_char_boundary(budget * HEAD_PERCENT / 100);
    let tail = text.ceil_char_boundary(text.len() - (budget - head));
    (format!("{}{marker}{}", &text[..head], &text[tail..]), true)
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct Tool {
    pub(crate) name: String,
    pub(crate) input: String,
    pub(crate) output: String,
    #[serde(rename = "isError")]
    pub(crate) is_error: bool,
    pub(crate) truncated: bool,
    #[serde(skip)]
    output_size: usize,
}

#[derive(Clone, Debug, Serialize)]
pub(crate) struct Turn {
    pub(crate) role: &'static str,
    pub(crate) text: String,
    #[serde(skip_serializing_if = "Vec::is_empty")]
    pub(crate) tools: Vec<Tool>,
}

enum ToolEvent {
    Call {
        id: Option<String>,
        name: String,
        input: String,
    },
    Output {
        id: Option<String>,
        name: Option<String>,
        output: String,
        is_error: bool,
    },
}

fn rendered(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        other => serde_json::to_string_pretty(other).unwrap_or_default(),
    }
}

/// Codex arguments are JSON encoded as a string.
fn rendered_arguments(value: &Value) -> String {
    match value
        .as_str()
        .and_then(|raw| serde_json::from_str::<Value>(raw).ok())
    {
        Some(parsed) if parsed.is_object() || parsed.is_array() => rendered(&parsed),
        _ => rendered(value),
    }
}

fn output_text(value: &Value) -> String {
    match value {
        Value::Null => String::new(),
        Value::String(text) => text.clone(),
        Value::Array(parts) => parts
            .iter()
            .map(|part| match part["type"].as_str() {
                Some("text" | "input_text" | "output_text") if part["text"].is_string() => {
                    part["text"].as_str().unwrap_or_default().to_owned()
                }
                Some("image" | "input_image") => "[image]".to_owned(),
                _ if part.is_string() => part.as_str().unwrap_or_default().to_owned(),
                _ => part.to_string(),
            })
            .collect::<Vec<_>>()
            .join("\n"),
        Value::Object(object) if object.contains_key("content") => output_text(&value["content"]),
        Value::Object(object) if object.contains_key("output") => output_text(&value["output"]),
        other => rendered(other),
    }
}

fn id(value: &Value) -> Option<String> {
    value
        .as_str()
        .filter(|id| !id.is_empty())
        .map(str::to_owned)
}

fn tool_events(record: &Value) -> Vec<ToolEvent> {
    let mut events = Vec::new();
    match record["type"].as_str() {
        // Claude Code
        Some("assistant" | "user") => {
            for part in record["message"]["content"]
                .as_array()
                .into_iter()
                .flatten()
            {
                match part["type"].as_str() {
                    Some("tool_use" | "server_tool_use") => events.push(ToolEvent::Call {
                        id: id(&part["id"]),
                        name: part["name"].as_str().unwrap_or("Tool").to_owned(),
                        input: rendered(&part["input"]),
                    }),
                    Some("tool_result") => events.push(ToolEvent::Output {
                        id: id(&part["tool_use_id"]),
                        name: None,
                        output: output_text(&part["content"]),
                        is_error: part["is_error"] == true,
                    }),
                    _ => {}
                }
            }
        }
        // Codex rollout items
        Some("response_item") => {
            let item = &record["payload"];
            let call = id(&item["call_id"]).or_else(|| id(&item["id"]));
            match item["type"].as_str() {
                Some("function_call") => events.push(ToolEvent::Call {
                    id: call,
                    name: item["name"].as_str().unwrap_or("function").to_owned(),
                    input: rendered_arguments(&item["arguments"]),
                }),
                Some("custom_tool_call") => events.push(ToolEvent::Call {
                    id: call,
                    name: item["name"].as_str().unwrap_or("tool").to_owned(),
                    input: rendered(&item["input"]),
                }),
                Some("local_shell_call") => events.push(ToolEvent::Call {
                    id: call,
                    name: "shell".to_owned(),
                    input: rendered(&item["action"]),
                }),
                Some(
                    "function_call_output" | "custom_tool_call_output" | "local_shell_call_output",
                ) => events.push(ToolEvent::Output {
                    id: call,
                    name: None,
                    output: output_text(&item["output"]),
                    is_error: item["output"]["success"] == false,
                }),
                _ => {}
            }
        }
        // Codex app-server items; mirrors of rollout calls are removed by ID.
        Some("event_msg") if record["payload"]["type"] == "item_completed" => {
            let item = &record["payload"]["item"];
            if item["type"] == "commandExecution" {
                let call = id(&item["id"]);
                let command = match &item["command"] {
                    Value::Array(parts) => parts
                        .iter()
                        .filter_map(Value::as_str)
                        .collect::<Vec<_>>()
                        .join(" "),
                    other => rendered(other),
                };
                events.push(ToolEvent::Call {
                    id: call.clone(),
                    name: "commandExecution".to_owned(),
                    input: command,
                });
                events.push(ToolEvent::Output {
                    id: call,
                    name: None,
                    output: output_text(&item["aggregatedOutput"]),
                    is_error: item["exitCode"].as_i64().is_some_and(|code| code != 0)
                        || item["status"] == "failed",
                });
            }
        }
        // Pi
        Some("message") => {
            let message = &record["message"];
            if message["role"] == "toolResult" {
                events.push(ToolEvent::Output {
                    id: id(&message["toolCallId"]),
                    name: message["toolName"].as_str().map(str::to_owned),
                    output: output_text(&message["content"]),
                    is_error: message["isError"] == true,
                });
            } else if message["role"] == "assistant" {
                for part in message["content"].as_array().into_iter().flatten() {
                    if part["type"] == "toolCall" {
                        events.push(ToolEvent::Call {
                            id: id(&part["id"]),
                            name: part["name"].as_str().unwrap_or("tool").to_owned(),
                            input: rendered(&part["arguments"]),
                        });
                    }
                }
            }
        }
        _ => {}
    }
    events
}

fn assistant_turn(turns: &mut Vec<Turn>) -> usize {
    if turns.last().is_none_or(|turn| turn.role != "assistant") {
        turns.push(Turn {
            role: "assistant",
            text: String::new(),
            tools: Vec::new(),
        });
    }
    turns.len() - 1
}

/// Readable user and assistant turns, optionally with each assistant turn's
/// tool calls and outputs in transcript order. Text is not yet redacted.
pub(crate) fn transcript(records: &[Value], include_tools: bool) -> Result<Vec<Turn>> {
    if !include_tools {
        return Ok(session_presentation::conversation_messages(records)
            .into_iter()
            .map(|message| Turn {
                role: message.role,
                text: message.text,
                tools: Vec::new(),
            })
            .collect());
    }
    let pi = records
        .first()
        .is_some_and(|record| record["type"] == "session");
    let list: Vec<&Value> = if pi {
        crate::pi_sessions::branch(records)?
    } else {
        records.iter().collect()
    };
    let prose: Vec<(usize, session_translation::Message)> = if pi {
        list.iter()
            .enumerate()
            .filter(|(_, record)| record["type"] == "message")
            .filter_map(|(index, record)| {
                session_translation::message(record).map(|(message, _)| (index, message))
            })
            .collect()
    } else {
        session_translation::indexed_messages(records)
    };
    let mut prose = prose.into_iter().peekable();
    let mut turns = Vec::new();
    // Codex mirrors a call as a rollout item and an app-server item with the
    // same ID; both are merged into one tool so neither loses its details.
    let mut calls = HashMap::<String, (usize, usize)>::new();
    for (index, record) in list.into_iter().enumerate() {
        while let Some((_, message)) = prose.next_if(|(at, _)| *at == index) {
            if let Some((role, text)) = session_presentation::readable(message) {
                turns.push(Turn {
                    role,
                    text,
                    tools: Vec::new(),
                });
            }
        }
        for event in tool_events(record) {
            match event {
                ToolEvent::Call { id, name, input } => {
                    if let Some(&(turn, tool)) = id.as_ref().and_then(|id| calls.get(id)) {
                        let tool = &mut turns[turn].tools[tool];
                        if input.len() > tool.input.len() {
                            tool.input = input;
                        }
                        continue;
                    }
                    let turn = assistant_turn(&mut turns);
                    turns[turn].tools.push(Tool {
                        name,
                        input,
                        output: String::new(),
                        is_error: false,
                        truncated: false,
                        output_size: 0,
                    });
                    if let Some(id) = id {
                        calls.insert(id, (turn, turns[turn].tools.len() - 1));
                    }
                }
                ToolEvent::Output {
                    id,
                    name,
                    output,
                    is_error,
                } => {
                    if let Some(&(turn, tool)) = id.as_ref().and_then(|id| calls.get(id)) {
                        // Keep the fuller output; any failed mirror marks the call failed.
                        let tool = &mut turns[turn].tools[tool];
                        if output.len() > tool.output.len() {
                            tool.output = output;
                        }
                        tool.is_error |= is_error;
                        continue;
                    }
                    let turn = assistant_turn(&mut turns);
                    turns[turn].tools.push(Tool {
                        name: name.unwrap_or_else(|| "Tool result".to_owned()),
                        input: String::new(),
                        output,
                        is_error,
                        truncated: false,
                        output_size: 0,
                    });
                    if let Some(id) = id {
                        calls.insert(id, (turn, turns[turn].tools.len() - 1));
                    }
                }
            }
        }
    }
    Ok(turns)
}

fn json_len(text: &str) -> usize {
    serde_json::to_string(text).map_or(text.len(), |encoded| encoded.len())
}

/// Shorten the oldest tool outputs first until the payload fits. User and
/// assistant text and selected memories are never removed.
pub(crate) fn fit(body: &mut Value, turns: &mut [Turn]) -> Result<usize> {
    body["turns"] = json!(turns);
    let mut size = serde_json::to_vec(body).map_err(|e| e.to_string())?.len();
    for stage in [Some(TOOL_OUTPUT_REDUCED), None] {
        if size <= PAYLOAD_LIMIT {
            break;
        }
        'turns: for turn in turns.iter_mut() {
            for tool in &mut turn.tools {
                if size <= PAYLOAD_LIMIT {
                    break 'turns;
                }
                let (output, truncated) = match stage {
                    Some(limit) => cap(&tool.output, limit, tool.output_size),
                    None if tool.output.is_empty() || tool.output == OUTPUT_OMITTED => continue,
                    None => (OUTPUT_OMITTED.to_owned(), true),
                };
                if !truncated {
                    continue;
                }
                size = (size + json_len(&output)).saturating_sub(json_len(&tool.output));
                tool.output = output;
                tool.truncated = true;
            }
        }
        body["turns"] = json!(turns);
        size = serde_json::to_vec(body).map_err(|e| e.to_string())?.len();
    }
    if size > PAYLOAD_LIMIT {
        return Err(format!(
            "This handoff is too large to send ({:.1} MB of {:.1} MB). Turn off tool calls or attach fewer memories.",
            size as f64 / 1_000_000.0,
            PAYLOAD_LIMIT as f64 / 1_000_000.0
        ));
    }
    Ok(size)
}

struct Session {
    resource: Value,
    project: Value,
    source: &'static str,
    native_id: Option<String>,
    records: Vec<Value>,
}

fn session(db: &Connection, id: &str) -> Result<Session> {
    Uuid::parse_str(id).map_err(|_| "Invalid session")?;
    let resource = local_resources::resource(db, id)?;
    if resource["kind"] != "session"
        || resource["deleted"] == true
        || resource["access"]["mode"] == "hidden"
    {
        return Err("This session is no longer available.".into());
    }
    let source = match resource["source"].as_str() {
        Some("claude") => "claude",
        Some("codex") => "codex",
        Some("pi") => "pi",
        _ => return Err("Browser handoffs support Claude Code, Codex and Pi sessions.".into()),
    };
    let project =
        governance::project(db, resource["projectId"].as_str().ok_or("Missing project")?)?;
    let native_id = match resource["nativeId"].as_str() {
        Some(native) => Some(native.to_owned()),
        None => indexer::binding(db, id)?["nativeId"]
            .as_str()
            .map(str::to_owned),
    };
    // Local sessions read their current native file; synced ones their snapshot.
    let records = session_forks::reading_resource(db, &resource)?
        .records()?
        .into_owned();
    Ok(Session {
        resource,
        project,
        source,
        native_id,
        records,
    })
}

fn session_title(session: &Session) -> String {
    session.resource["title"]
        .as_str()
        .map(str::trim)
        .filter(|title| !title.is_empty())
        .map(str::to_owned)
        .or_else(|| session_presentation::title(&session.records))
        .unwrap_or_else(|| "Untitled session".to_owned())
}

fn clamp_chars(text: &str, limit: usize) -> String {
    let mut text = text.trim().to_owned();
    let mut budget = limit;
    while text.chars().count() > limit {
        let kept: String = text.chars().take(budget).collect();
        text = SessionRedactor::text(kept.trim_end());
        if budget == 0 {
            break;
        }
        budget = budget.saturating_sub(16);
    }
    text
}

fn clamp_title(text: &str) -> String {
    let clamped = clamp_chars(text, TITLE_LIMIT);
    if clamped.is_empty() {
        "Untitled session".to_owned()
    } else {
        clamped
    }
}

pub(crate) struct Memory {
    pub(crate) resource: Value,
    pub(crate) scope: &'static str,
    pub(crate) content: String,
    pub(crate) size: usize,
}

impl Memory {
    pub(crate) fn id(&self) -> &str {
        self.resource["resourceId"].as_str().unwrap_or_default()
    }

    fn name(&self) -> &str {
        self.resource["logicalPath"]
            .as_str()
            .and_then(|path| path.rsplit('/').next())
            .filter(|name| !name.is_empty())
            .unwrap_or("memory")
    }

    pub(crate) fn title(&self) -> String {
        self.resource["title"]
            .as_str()
            .filter(|title| !title.trim().is_empty())
            .unwrap_or(self.name())
            .to_owned()
    }

    /// A file-name slug built from the redacted name, so a credential-shaped
    /// file name never leaves this Mac in lowercase form.
    pub(crate) fn slug(&self) -> String {
        let name = SessionRedactor::text(self.name());
        let slug = slugify(name.strip_suffix(".md").unwrap_or(&name));
        // Lowercasing can itself form a recognized token; scrub it once more.
        let scrubbed = SessionRedactor::text(&slug);
        if scrubbed == slug {
            slug
        } else {
            slugify(&scrubbed)
        }
    }

    fn root_instruction(&self) -> bool {
        self.resource["logicalPath"]
            .as_str()
            .and_then(|path| path.strip_prefix("instructions/"))
            .is_some_and(|name| ROOT_INSTRUCTIONS.contains(&name))
    }
}

fn slugify(name: &str) -> String {
    let mut slug = String::new();
    for c in name.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() || c == '_' || c == '.' {
            slug.push(c);
        } else if !slug.ends_with('-') {
            slug.push('-');
        }
    }
    let slug: String = slug.trim_matches(['-', '.']).chars().take(80).collect();
    if slug.is_empty() {
        "memory".into()
    } else {
        slug
    }
}

/// Memory content within the service's limit, truncation marker included.
/// Redaction can lengthen text, so callers apply this after redacting.
pub(crate) fn memory_text(text: &str, original: usize) -> String {
    let marker = format!("\n\n… [truncated; {original} bytes in the original memory]\n");
    let mut text = text.to_owned();
    let mut budget = MEMORY_LIMIT.saturating_sub(marker.len());
    while text.len() > MEMORY_LIMIT {
        let end = text.floor_char_boundary(budget);
        // A cut can expose a shorter recognized pattern; scrub the kept text again.
        text = SessionRedactor::text(&format!("{}{marker}", &text[..end]));
        budget = budget.saturating_sub((text.len().saturating_sub(MEMORY_LIMIT)).max(64));
    }
    text
}

fn memory(resource: Value) -> Option<Memory> {
    if resource["kind"] != "memory"
        || resource["deleted"] == true
        || resource["access"]["mode"] == "hidden"
        || !resource["resourceId"].is_string()
    {
        return None;
    }
    let files = resource["files"].as_array()?;
    let file = files
        .iter()
        .find(|file| file["path"].as_str().is_some_and(|p| p.ends_with(".md")))
        .or(files.first())?;
    let bytes = db::blob_read(file["hash"].as_str()?).ok()?;
    let size = bytes.len();
    // Keep the whole memory: redaction must see a secret before any cut, and
    // `prepare` truncates only the redacted text.
    let content = String::from_utf8_lossy(&bytes).into_owned();
    if content.trim().is_empty() {
        return None;
    }
    let scope = if resource["revision"].as_u64().unwrap_or(0) > 0 && resource["local"] != true {
        "shared"
    } else {
        "local"
    };
    Some(Memory {
        resource,
        scope,
        content,
        size,
    })
}

/// Every readable memory in the project: this Mac's local catalog and any
/// accepted shared copies. Sharing and governance settings do not restrict it.
pub(crate) fn project_memories(db: &Connection, project: &Value) -> Result<Vec<Memory>> {
    // Refresh discovery only when no other workspace operation owns it.
    let catalog = match projects::try_lock()? {
        Some(_lock) => local_resources::catalog(db, project, "memory")?,
        None => local_resources::cached_catalog(db, project, "memory")?,
    };
    let project_id = project["id"].as_str().ok_or("Missing project")?;
    let shared = db::rows(
        db,
        "SELECT value FROM resources WHERE project=? AND json_extract(value,'$.kind')='memory' ORDER BY id",
        &[&project_id],
    )?;
    let mut seen = HashSet::new();
    let mut memories = Vec::new();
    for resource in catalog["resources"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .chain(shared)
    {
        let Some(id) = resource["resourceId"].as_str().map(str::to_owned) else {
            continue;
        };
        if seen.contains(&id) {
            continue;
        }
        if let Some(memory) = memory(resource) {
            seen.insert(id);
            memories.push(memory);
        }
    }
    Ok(memories)
}

fn tool_count(turns: &[Turn]) -> usize {
    turns.iter().map(|turn| turn.tools.len()).sum()
}

fn message_count(turns: &[Turn]) -> usize {
    turns.iter().filter(|turn| !turn.text.is_empty()).count()
}

pub(crate) fn candidates_with(db: &Connection, session_id: &str) -> Result<Value> {
    let session = session(db, session_id)?;
    let project_id = session.project["id"].as_str().ok_or("Missing project")?;
    let delivered = match &session.native_id {
        Some(native) => native::handoff_session_memories(db, project_id, native)?,
        None => Vec::new(),
    };
    let turns = transcript(&session.records, true)?;
    let mut memories = project_memories(db, &session.project)?
        .into_iter()
        .map(|memory| {
            let mut redactor = Redactor::default();
            let title = redactor.text(&memory.title());
            redactor.text(&memory.content);
            let preselected =
                memory.root_instruction() || delivered.iter().any(|id| id == memory.id());
            json!({"id":memory.id(),"slug":memory.slug(),"title":title,"scope":memory.scope,"preselected":preselected,"byteSize":memory.size,"redactionCount":redactor.count})
        })
        .collect::<Vec<_>>();
    memories.sort_by_key(|memory| memory["preselected"] != true);
    Ok(json!({
        "session":{
            "id":session.resource["resourceId"],
            "title":clamp_title(&SessionRedactor::text(&session_title(&session))),
            "source":session.source,
            "messageCount":message_count(&turns),
            "toolCallCount":tool_count(&turns),
        },
        "memories":memories,
    }))
}

fn clean_strings(value: &Value) -> bool {
    match value {
        Value::String(text) => SessionRedactor::text(text) == *text,
        Value::Array(values) => values.iter().all(clean_strings),
        Value::Object(values) => values.values().all(clean_strings),
        _ => true,
    }
}

pub(crate) struct Prepared {
    #[cfg(test)]
    pub(crate) body: Value,
    /// The exact checked bytes that are sent.
    pub(crate) bytes: Vec<u8>,
    pub(crate) redactions: usize,
    pub(crate) messages: usize,
    pub(crate) tools: usize,
    pub(crate) memories: usize,
}

struct Request {
    session: String,
    memories: Vec<String>,
    note: Option<String>,
    include_tools: bool,
    id: String,
}

fn request(input: &Value) -> Result<Request> {
    let session = input["sessionId"]
        .as_str()
        .ok_or("Choose a session to hand off")?
        .to_owned();
    let mut memories = Vec::new();
    for id in input["memoryIds"].as_array().into_iter().flatten() {
        let id = id.as_str().ok_or("Invalid memory selection")?;
        if !memories.iter().any(|known| known == id) {
            memories.push(id.to_owned());
        }
    }
    if !input["memoryIds"].is_null() && !input["memoryIds"].is_array() {
        return Err("Invalid memory selection".into());
    }
    let note = match &input["handoffNote"] {
        Value::Null => None,
        Value::String(note) => Some(note.trim().to_owned()).filter(|note| !note.is_empty()),
        _ => return Err("Invalid handoff note".into()),
    };
    if note
        .as_ref()
        .is_some_and(|note| note.chars().count() > NOTE_LIMIT)
    {
        return Err(format!(
            "Keep the handoff note to {NOTE_LIMIT} characters or fewer."
        ));
    }
    let include_tools = match &input["includeToolCalls"] {
        Value::Null => false,
        Value::Bool(value) => *value,
        _ => return Err("Invalid tool call option".into()),
    };
    let id = match &input["requestId"] {
        Value::Null => Uuid::new_v4().to_string(),
        Value::String(id) => Uuid::parse_str(id)
            .map_err(|_| "Invalid handoff request")?
            .to_string(),
        _ => return Err("Invalid handoff request".into()),
    };
    Ok(Request {
        session,
        memories,
        note,
        include_tools,
        id,
    })
}

fn prepare(db: &Connection, request: &Request) -> Result<Prepared> {
    let session = session(db, &request.session)?;
    let mut redactor = Redactor::default();
    let mut turns = transcript(&session.records, request.include_tools)?;
    if message_count(&turns) == 0 {
        return Err("This session has no readable conversation to hand off.".into());
    }
    for turn in &mut turns {
        turn.text = redactor.text(&turn.text);
        for tool in &mut turn.tools {
            let input = redactor.text(&tool.input);
            let (input, input_truncated) = cap(&input, TOOL_INPUT_LIMIT, input.len());
            let output = redactor.text(&tool.output);
            tool.output_size = output.len();
            let (output, output_truncated) = cap(&output, TOOL_OUTPUT_LIMIT, output.len());
            // A cut can expose a shorter recognized pattern; scrub the kept text again.
            tool.input = SessionRedactor::text(&input);
            tool.output = SessionRedactor::text(&output);
            tool.name = SessionRedactor::text(&tool.name);
            tool.truncated = input_truncated || output_truncated;
        }
    }
    let available = if request.memories.is_empty() {
        Vec::new()
    } else {
        project_memories(db, &session.project)?
    };
    let mut memories = Vec::new();
    for id in &request.memories {
        let memory = available
            .iter()
            .find(|memory| memory.id() == id)
            .ok_or(MEMORY_UNAVAILABLE)?;
        memories.push(json!({
            "slug":memory.slug(),
            "title":redactor.text(&memory.title()),
            "scope":memory.scope,
            "content":memory_text(&redactor.text(&memory.content), memory.size),
        }));
    }
    let mut body = json!({
        "requestId":request.id,
        "title":clamp_title(&redactor.text(&session_title(&session))),
        "source":session.source,
        "includeToolCalls":request.include_tools,
        "memories":memories,
    });
    if let Some(note) = &request.note {
        let clamped = clamp_chars(&redactor.text(note), NOTE_LIMIT);
        if !clamped.is_empty() {
            body["handoffNote"] = json!(clamped);
        }
    }
    fit(&mut body, &mut turns)?;
    let bytes = serde_json::to_vec(&body).map_err(|e| e.to_string())?;
    // Check the whole body and, like the service, every field on its own.
    if SessionRedactor::check_upload(&bytes).is_err() || !clean_strings(&body) {
        return Err(format!(
            "{SECRET_CODE}: Orka found a secret it couldn’t remove from this handoff, so nothing was sent."
        ));
    }
    Ok(Prepared {
        #[cfg(test)]
        body,
        bytes,
        redactions: redactor.count,
        messages: message_count(&turns),
        tools: tool_count(&turns),
        memories: request.memories.len(),
    })
}

#[cfg(test)]
pub(crate) fn prepare_with(db: &Connection, input: &Value) -> Result<Prepared> {
    prepare(db, &request(input)?)
}

/// Structured error returned by the `create_handoff` command so the UI never
/// guesses whether a secret blocked creation or the same request ID must be retried.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CreateHandoffError {
    pub message: String,
    pub kind: &'static str,
    pub preserve_request_id: bool,
}

impl CreateHandoffError {
    pub(crate) fn from_raw(raw: String, preserve_request_id: bool) -> Self {
        if let Some(detail) = raw.strip_prefix(&format!("{SECRET_CODE}:")) {
            let message = detail.trim();
            return Self {
                message: if message.is_empty() {
                    "Orka found a secret it couldn’t remove from this handoff, so nothing was sent."
                        .to_owned()
                } else {
                    message.to_owned()
                },
                kind: "secret",
                preserve_request_id: false,
            };
        }
        Self {
            message: raw,
            kind: "general",
            preserve_request_id,
        }
    }
}

pub(crate) async fn create(input: Value) -> Result<Value> {
    create_raw(input).await.map_err(|(error, _)| error)
}

pub(crate) async fn create_outcome(input: Value) -> std::result::Result<Value, CreateHandoffError> {
    create_raw(input)
        .await
        .map_err(|(raw, preserve)| CreateHandoffError::from_raw(raw, preserve))
}

async fn create_raw(input: Value) -> std::result::Result<Value, (String, bool)> {
    let scope = Scope::from_input(&input).map_err(|error| (error, false))?;
    let request = request(&input).map_err(|error| (error, false))?;
    let key = scope.key(&request.id);
    let lock = request_lock(&key);
    let _guard = lock.lock().await;
    let result = create_in(&scope, &request, &key).await;
    if result
        .as_ref()
        .is_err_and(|(error, _)| error == SCOPE_CHANGED)
    {
        forget(&key);
        return Err((SCOPE_CHANGED.to_owned(), false));
    }
    result
}

async fn create_in(
    scope: &Scope,
    request: &Request,
    key: &SentKey,
) -> std::result::Result<Value, (String, bool)> {
    if let Err(error) = scope.recheck() {
        let preserve = error != SCOPE_CHANGED && has_cached(key);
        return Err((error, preserve));
    }
    let selection = json!([
        request.session,
        request.memories,
        request.note,
        request.include_tools
    ]);
    // An earlier attempt's bytes may already be on the service, so a later
    // failure to reach it cannot say that nothing was shared.
    let cached = resend(key, &selection);
    let earlier = cached.is_some();
    let unsent = if earlier { UNCONFIRMED } else { NOT_SENT };
    let browser = match scope.browser_origin().await {
        Err(error) if error == UNREACHABLE => return Err((unsent.into(), earlier)),
        Err(error) => {
            let preserve = earlier && error != SCOPE_CHANGED;
            return Err((error, preserve));
        }
        Ok(None) => return Err((UNSUPPORTED.into(), earlier)),
        Ok(Some(origin)) => origin,
    };
    let (body, summary) = match cached {
        Some(sent) => sent,
        None => {
            let prepared = {
                let db = db::open().map_err(|error| (error, false))?;
                scope.check(&db).map_err(|error| (error, false))?;
                prepare(&db, request).map_err(|error| (error, false))?
            };
            let summary = [
                prepared.redactions,
                prepared.messages,
                prepared.tools,
                prepared.memories,
            ];
            remember(Sending {
                key: key.clone(),
                selection,
                body: prepared.bytes.clone(),
                summary,
            });
            (prepared.bytes, summary)
        }
    };
    if let Err(error) = scope.recheck() {
        if !earlier {
            forget(key);
        }
        let preserve = earlier && error != SCOPE_CHANGED;
        return Err((error, preserve));
    }
    // Send exact body bytes, so a retry repeats the original snapshot.
    let sent =
        sync::send_json_bytes_at(&scope.account, &scope.origin, "POST", "/v2/handoffs", body).await;
    if let Err(error) = scope.recheck() {
        if error == SCOPE_CHANGED {
            forget(key);
            return Err((error, false));
        }
        // Scope could not be determined after the POST ran. Keep the snapshot
        // and preserve the request ID unless we know nothing left this Mac or
        // the service terminally rejected it.
        let preserve = match &sent {
            sync::Sent::Unsent(_) => {
                if !earlier {
                    forget(key);
                }
                earlier
            }
            sync::Sent::Response(status, _) if terminal(*status) => {
                forget(key);
                false
            }
            _ => true,
        };
        return Err((error, preserve));
    }
    let receipt = match sent {
        sync::Sent::Unsent(error) => {
            if !earlier {
                // These bytes never left this Mac; a retry may rebuild them.
                forget(key);
            }
            let message = if error == "Cloud unavailable; local work stays queued" {
                unsent.into()
            } else {
                error
            };
            return Err((message, earlier));
        }
        sync::Sent::Unconfirmed => return Err((UNCONFIRMED.into(), true)),
        sync::Sent::Response(200 | 201, receipt) if receipt["id"].is_string() => receipt,
        // Created or not, a retry with these bytes recovers the link.
        sync::Sent::Response(200..=299, _) => return Err((UNCONFIRMED.into(), true)),
        sync::Sent::Response(status, body) => {
            let is_terminal = terminal(status);
            if is_terminal {
                forget(key);
            }
            return Err((create_error(status, &body), !is_terminal));
        }
    };
    let [redactions, messages, tools, memories] = summary;
    let id = receipt["id"]
        .as_str()
        .and_then(|id| Uuid::parse_str(id).ok())
        .ok_or_else(|| {
            (
                "The Orka service returned an unexpected handoff. Nothing was opened.".to_owned(),
                true,
            )
        })?;
    let raw_url = receipt["url"].as_str().ok_or_else(|| {
        (
            "The Orka service returned an unexpected handoff link. Nothing was opened.".to_owned(),
            true,
        )
    })?;
    let url = checked_link(raw_url, &browser).map_err(|error| (error, true))?;
    // Only a usable receipt releases the snapshot; until then a retry must
    // repeat these exact bytes to recover the link.
    forget(key);
    Ok(json!({
        "id":id.to_string(),
        "url":url,
        "createdAt":receipt["createdAt"],
        "expiresAt":receipt["expiresAt"],
        "requestId":request.id,
        "redactionCount":redactions,
        "messageCount":messages,
        "toolCallCount":tools,
        "memoryCount":memories,
    }))
}

fn active(handoff: &Value) -> bool {
    if !handoff["revokedAt"].is_null() || handoff["revoked"] == true {
        return false;
    }
    handoff["expiresAt"]
        .as_str()
        .and_then(|value| chrono::DateTime::parse_from_rfc3339(value).ok())
        .is_none_or(|expires| expires > chrono::Utc::now())
}

async fn list(scope: Scope) -> Result<Value> {
    let Some(browser) = scope.browser_origin().await? else {
        return Ok(json!({"supported":false,"handoffs":[]}));
    };
    let value = scope
        .api("GET", "/v2/handoffs", None)
        .await
        .map_err(service_error)?;
    let handoffs = value["items"]
        .as_array()
        .cloned()
        .unwrap_or_default()
        .into_iter()
        .filter(active)
        .filter_map(|handoff| {
            let id = Uuid::parse_str(handoff["id"].as_str()?).ok()?;
            let mut entry = json!({"id":id.to_string()});
            for key in [
                "title",
                "source",
                "createdAt",
                "expiresAt",
                "includeToolCalls",
                "messageCount",
                "toolCallCount",
                "memoryCount",
            ] {
                if !handoff[key].is_null() {
                    entry[key] = handoff[key].clone();
                }
            }
            entry["url"] = handoff["url"]
                .as_str()
                .and_then(|url| checked_link(url, &browser).ok())
                .map_or(Value::Null, Value::String);
            Some(entry)
        })
        .collect::<Vec<_>>();
    Ok(json!({"supported":true,"handoffs":handoffs}))
}

async fn revoke(scope: Scope, id: &str) -> Result<Value> {
    let id = Uuid::parse_str(id)
        .map_err(|_| "Invalid handoff")?
        .to_string();
    scope
        .api("DELETE", &format!("/v2/handoffs/{id}"), None)
        .await
        .map_err(service_error)?;
    Ok(json!({"id":id,"revoked":true}))
}

pub(crate) async fn list_with(account: Option<String>, origin: Option<String>) -> Result<Value> {
    list(Scope::current_or(account, origin)?).await
}

pub(crate) async fn revoke_with(
    id: String,
    account: Option<String>,
    origin: Option<String>,
) -> Result<Value> {
    revoke(Scope::current_or(account, origin)?, &id).await
}

pub(crate) fn candidates_command(
    session_id: &str,
    account: Option<String>,
    origin: Option<String>,
) -> Result<Value> {
    let scope = Scope::current_or(account, origin)?;
    let db = db::open()?;
    let result = candidates_with(&db, session_id)?;
    scope.check(&db)?;
    Ok(result)
}

async fn blocking<F, T>(work: F) -> Result<T>
where
    F: FnOnce() -> Result<T> + Send + 'static,
    T: Send + 'static,
{
    tauri::async_runtime::spawn_blocking(work)
        .await
        .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn handoff_candidates(
    session_id: String,
    account_id: Option<String>,
    service_origin: Option<String>,
) -> Result<Value> {
    blocking(move || candidates_command(&session_id, account_id, service_origin)).await
}

#[tauri::command]
pub async fn create_handoff(input: Value) -> std::result::Result<Value, CreateHandoffError> {
    tauri::async_runtime::spawn_blocking(move || {
        tauri::async_runtime::block_on(create_outcome(input))
    })
    .await
    .map_err(|error| CreateHandoffError::from_raw(error.to_string(), true))?
}

#[tauri::command]
pub async fn list_handoffs(
    account_id: Option<String>,
    service_origin: Option<String>,
) -> Result<Value> {
    blocking(move || tauri::async_runtime::block_on(list_with(account_id, service_origin))).await
}

#[tauri::command]
pub async fn revoke_handoff(
    id: String,
    account_id: Option<String>,
    service_origin: Option<String>,
) -> Result<Value> {
    blocking(move || tauri::async_runtime::block_on(revoke_with(id, account_id, service_origin)))
        .await
}
