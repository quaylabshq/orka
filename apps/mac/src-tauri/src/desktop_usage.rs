use crate::{auth, db, sync};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};
use std::{
    sync::LazyLock,
    time::{Duration, Instant},
};
use tokio::sync::Mutex;

const BATCH_LIMIT: usize = 16;
const CAPABILITY_LIMIT: usize = 4096;
const REQUEST_TIMEOUT: Duration = Duration::from_secs(3);
const SUPPORTED_TTL: Duration = Duration::from_secs(120);
const UNAVAILABLE_TTL: Duration = Duration::from_secs(300);
const FAILURE_COOLDOWN: Duration = Duration::from_secs(45);

#[derive(Clone, Deserialize, Serialize)]
pub(crate) enum UsageEvent {
    #[serde(rename = "screen:projects")]
    Projects,
    #[serde(rename = "screen:sessions")]
    Sessions,
    #[serde(rename = "screen:memories")]
    Memories,
    #[serde(rename = "screen:plans")]
    Plans,
    #[serde(rename = "screen:skills")]
    Skills,
    #[serde(rename = "screen:reviews")]
    Reviews,
    #[serde(rename = "screen:members")]
    Members,
    #[serde(rename = "screen:settings")]
    Settings,
    #[serde(rename = "screen:envs")]
    Envs,
    #[serde(rename = "screen:logs")]
    Logs,
    #[serde(rename = "feature:session_resumed")]
    SessionResumed,
    #[serde(rename = "feature:skill_imported")]
    SkillImported,
    #[serde(rename = "feature:memory_shared")]
    MemoryShared,
    #[serde(rename = "feature:settings_saved")]
    SettingsSaved,
    #[serde(rename = "feature:skill_shared")]
    SkillShared,
    #[serde(rename = "feature:plan_shared")]
    PlanShared,
    #[serde(rename = "feature:session_shared")]
    SessionShared,
    #[serde(rename = "feature:source_connected")]
    SourceConnected,
    #[serde(rename = "feature:review_decided")]
    ReviewDecided,
    #[serde(rename = "feature:session_forked")]
    SessionForked,
    #[serde(untagged)]
    Catalogue(CatalogueSignal),
}

#[derive(Clone, Deserialize, Serialize)]
#[serde(try_from = "String")]
pub(crate) struct CatalogueSignal(String);

impl TryFrom<String> for CatalogueSignal {
    type Error = &'static str;
    fn try_from(wire: String) -> Result<Self, Self::Error> {
        if valid_signal("desktop", &wire) {
            Ok(Self(wire))
        } else {
            Err("Unknown desktop usage signal")
        }
    }
}

fn valid_signal(origin: &str, wire: &str) -> bool {
    if wire.len() > 128 {
        return false;
    }
    let mut parts = wire.split(':');
    let Some(name) = parts.next() else {
        return false;
    };
    for row in include_str!("product-events.txt").lines() {
        let mut fields = row.split_ascii_whitespace();
        if !fields
            .next()
            .is_some_and(|origins| origins.split(',').any(|value| value == origin))
            || fields.next() != Some(name)
        {
            continue;
        }
        return fields.all(|field| {
            let Some((_, choices)) = field.split_once('=') else {
                return false;
            };
            parts
                .next()
                .is_some_and(|value| choices.split(',').any(|choice| choice == value))
        }) && parts.next().is_none();
    }
    false
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UsageSupport {
    Disabled,
    Standard,
    Expanded,
    Catalogue,
}

impl UsageSupport {
    fn from_instance(value: &Value) -> Self {
        if value["version"] != 1
            || !value["auth"].is_object()
            || value["mode"] != "cloud"
            || value["desktopUsageAnalytics"] != 1
        {
            return Self::Disabled;
        }
        if value["desktopUsageEventSet"]
            .as_u64()
            .is_some_and(|set| set >= 3)
        {
            return Self::Catalogue;
        }
        if value["desktopUsageEventSet"]
            .as_u64()
            .is_some_and(|set| set >= 2)
        {
            Self::Expanded
        } else {
            Self::Standard
        }
    }

    fn accepts(self, event: &UsageEvent) -> bool {
        match self {
            Self::Disabled => false,
            Self::Standard => matches!(
                event,
                UsageEvent::Projects
                    | UsageEvent::Sessions
                    | UsageEvent::Memories
                    | UsageEvent::Plans
                    | UsageEvent::Skills
                    | UsageEvent::Reviews
                    | UsageEvent::Members
                    | UsageEvent::Settings
                    | UsageEvent::SessionResumed
                    | UsageEvent::SkillImported
                    | UsageEvent::MemoryShared
            ),
            Self::Expanded => !matches!(event, UsageEvent::Catalogue(_)),
            Self::Catalogue => true,
        }
    }
}

struct Capability {
    origin: String,
    until: Instant,
    support: UsageSupport,
}

#[derive(Default)]
struct UsageTransport {
    capability: Option<Capability>,
}

static TRANSPORT: Mutex<UsageTransport> = Mutex::const_new(UsageTransport { capability: None });
static CLIENT: LazyLock<Option<reqwest::Client>> = LazyLock::new(|| {
    reqwest::Client::builder()
        .timeout(REQUEST_TIMEOUT)
        .redirect(reqwest::redirect::Policy::none())
        .retry(reqwest::retry::never())
        .build()
        .ok()
});

async fn probe_usage(origin: &str) -> Option<UsageSupport> {
    let mut response = CLIENT
        .as_ref()?
        .get(format!("{}/v2/instance", origin.trim_end_matches('/')))
        .send()
        .await
        .ok()?;
    if matches!(response.status().as_u16(), 401 | 404) {
        return Some(UsageSupport::Disabled);
    }
    if !response.status().is_success()
        || response
            .content_length()
            .is_some_and(|size| size > CAPABILITY_LIMIT as u64)
    {
        return None;
    }
    let mut body = Vec::new();
    while let Some(chunk) = response.chunk().await.ok()? {
        if chunk.len() > CAPABILITY_LIMIT - body.len() {
            return None;
        }
        body.extend_from_slice(&chunk);
    }
    let capabilities = serde_json::from_slice(&body).ok()?;
    Some(UsageSupport::from_instance(&capabilities))
}

impl UsageTransport {
    fn remember(&mut self, origin: &str, support: UsageSupport, ttl: Duration) {
        self.capability = Some(Capability {
            origin: origin.to_owned(),
            until: Instant::now() + ttl,
            support,
        });
    }

    async fn support(&mut self, origin: &str) -> UsageSupport {
        if let Some(capability) = &self.capability {
            if capability.origin == origin && capability.until > Instant::now() {
                return capability.support;
            }
        }
        let (support, ttl) = match probe_usage(origin).await {
            Some(UsageSupport::Disabled) => (UsageSupport::Disabled, UNAVAILABLE_TTL),
            Some(support) => (support, SUPPORTED_TTL),
            None => (UsageSupport::Disabled, FAILURE_COOLDOWN),
        };
        self.remember(origin, support, ttl);
        support
    }
}

fn valid_batch(events: &[UsageEvent]) -> bool {
    (1..=BATCH_LIMIT).contains(&events.len())
}

async fn submit_usage(
    mut events: Vec<UsageEvent>,
    account_id: String,
    service_origin: String,
    connector: bool,
) -> bool {
    if !valid_batch(&events)
        || !db::matches_cloud_account(&account_id, &service_origin).unwrap_or(false)
        || db::validate_url(&service_origin).is_err()
    {
        return false;
    }

    // One batch in flight also coalesces capability probes. Busy telemetry has
    // no backlog and never holds a sync or project lock.
    let Ok(mut transport) = TRANSPORT.try_lock() else {
        return false;
    };
    let support = transport.support(&service_origin).await;
    // An older server rejects a whole batch if it sees an unsupported signal.
    if connector && support != UsageSupport::Catalogue {
        return false;
    }
    if matches!(support, UsageSupport::Standard | UsageSupport::Expanded) {
        events = events
            .into_iter()
            .filter_map(|event| {
                let UsageEvent::Catalogue(signal) = &event else {
                    return Some(event);
                };
                Some(match signal.0.as_str() {
                    "project_home_viewed" | "project_list_viewed" => UsageEvent::Projects,
                    "resource_list_viewed:session" => UsageEvent::Sessions,
                    "resource_list_viewed:memory" => UsageEvent::Memories,
                    "resource_list_viewed:plan" => UsageEvent::Plans,
                    "resource_list_viewed:skill" => UsageEvent::Skills,
                    "review_list_viewed" => UsageEvent::Reviews,
                    "settings_section_viewed:members" | "member_list_viewed" => UsageEvent::Members,
                    "settings_section_viewed:account" => UsageEvent::Settings,
                    "project_logs_viewed" => UsageEvent::Logs,
                    "env_list_viewed" => UsageEvent::Envs,
                    "review_approved" | "review_rejected" => UsageEvent::ReviewDecided,
                    value
                        if value.starts_with("settings_")
                            && (value.contains("_changed") || value.ends_with("_saved")) =>
                    {
                        UsageEvent::SettingsSaved
                    }
                    _ => return None,
                })
            })
            .collect();
    }
    events.retain(|event| support.accepts(event));
    if events.is_empty() {
        return false;
    }

    // Product requests own token refresh. Telemetry uses an already valid,
    // service-bound token and drops work made stale by an account switch.
    let Ok(Some(token)) = auth::fresh_token_for_service(&account_id, &service_origin) else {
        return false;
    };
    if !db::matches_cloud_account(&account_id, &service_origin).unwrap_or(false) {
        return false;
    }

    let Some(client) = CLIENT.as_ref() else {
        return false;
    };
    let sent = client
        .post(format!(
            "{}/v2/analytics/{}",
            service_origin.trim_end_matches('/'),
            if connector { "connector" } else { "desktop" }
        ))
        .header(sync::DESKTOP_VERSION_HEADER, env!("CARGO_PKG_VERSION"))
        .bearer_auth(token)
        .json(&json!({ "events": events }))
        .send()
        .await
        .is_ok_and(|response| response.status() == reqwest::StatusCode::NO_CONTENT);
    if !sent {
        transport.remember(&service_origin, UsageSupport::Disabled, FAILURE_COOLDOWN);
    }
    sent
}

pub(crate) fn lifecycle(config: &Value, event: &'static str) {
    if config["mode"] == "self-hosted" {
        return;
    }
    let Some(origin) = config["apiUrl"]
        .as_str()
        .filter(|s| db::validate_url(s).is_ok())
        .map(str::to_owned)
    else {
        return;
    };
    tauri::async_runtime::spawn(async move {
        let Ok(mut transport) = TRANSPORT.try_lock() else {
            return;
        };
        if transport.support(&origin).await != UsageSupport::Catalogue {
            return;
        }
        if let Some(client) = CLIENT.as_ref() {
            let _ = client
                .post(format!(
                    "{}/v2/analytics/lifecycle",
                    origin.trim_end_matches('/')
                ))
                .header(sync::DESKTOP_VERSION_HEADER, env!("CARGO_PKG_VERSION"))
                .json(&json!({"events":[event]}))
                .send()
                .await;
        }
    });
}
// A context command exits immediately after producing its result. Hold its one
// fixed outcome until the command has released all project and database locks.
static CLI_OUTCOME: std::sync::OnceLock<(String, String, &'static str)> =
    std::sync::OnceLock::new();

pub(crate) fn governance_event(account: &str, origin: &str, name: &'static str) {
    if std::env::args_os()
        .nth(1)
        .is_some_and(|arg| arg == "--orka-context")
    {
        let _ = CLI_OUTCOME.set((account.to_owned(), origin.to_owned(), name));
    } else {
        native_event(account, origin, name);
    }
}

pub(crate) async fn finish_context() {
    if let Some((account, origin, name)) = CLI_OUTCOME.get() {
        let event = UsageEvent::Catalogue(CatalogueSignal((*name).to_owned()));
        let _ = tokio::time::timeout(
            Duration::from_millis(750),
            submit_usage(vec![event], account.clone(), origin.clone(), false),
        )
        .await;
    }
}

pub(crate) fn native_event(account: &str, origin: &str, name: &'static str) {
    static SLOTS: tokio::sync::Semaphore = tokio::sync::Semaphore::const_new(4);
    if !valid_signal("desktop", name) {
        return;
    }
    let Ok(slot) = SLOTS.try_acquire() else {
        return;
    };
    let (account, origin) = (account.to_owned(), origin.to_owned());
    tauri::async_runtime::spawn(async move {
        let _slot = slot;
        submit_usage(
            vec![UsageEvent::Catalogue(CatalogueSignal(name.into()))],
            account,
            origin,
            false,
        )
        .await;
    });
}

/// Connector calls can repeat in agent loops. Coalesce the same tool/outcome
/// for five minutes and dispatch without holding the project operation lock.
pub(crate) fn connector_result(account: &str, origin: &str, tool: &str, success: bool) {
    use std::collections::HashMap;
    type Recent = HashMap<(String, String, String), Instant>;
    static RECENT: LazyLock<std::sync::Mutex<Recent>> = LazyLock::new(Default::default);
    let outcome = if success { "completed" } else { "failed" };
    let wire = format!("connector_tool_{outcome}:{tool}");
    if !valid_signal("connector", &wire) {
        return;
    }
    let Ok(mut recent) = RECENT.try_lock() else {
        return;
    };
    let now = Instant::now();
    recent.retain(|_, at| now.duration_since(*at) < Duration::from_secs(300));
    let key = (account.to_owned(), origin.to_owned(), wire.clone());
    if recent.len() >= 256 || recent.contains_key(&key) {
        return;
    }
    recent.insert(key, now);
    drop(recent);
    let (account, origin) = (account.to_owned(), origin.to_owned());
    tokio::spawn(async move {
        let semantic = match wire.as_str() {
            "connector_tool_completed:get_project_context" => Some("context_retrieved"),
            "connector_tool_completed:repair_sync" => Some("sync_repair_completed"),
            "connector_tool_failed:repair_sync" => Some("sync_repair_failed"),
            _ => None,
        };
        let mut events = vec![UsageEvent::Catalogue(CatalogueSignal(wire))];
        if let Some(event) = semantic {
            events.push(UsageEvent::Catalogue(CatalogueSignal(event.into())));
        }
        submit_usage(events, account, origin, true).await;
    });
}

#[tauri::command]
pub(crate) async fn record_desktop_usage(
    window: tauri::WebviewWindow,
    events: Vec<UsageEvent>,
    account_id: String,
    service_origin: String,
) {
    // The main renderer checks focus at the navigation/action. A successful
    // launch may bring another app to the foreground before its batch flushes.
    if window.label() == "main" {
        submit_usage(events, account_id, service_origin, false).await;
    }
}

#[cfg(debug_assertions)]
pub(crate) fn test_record(input: Value) -> db::Result<Value> {
    let origin = input["serviceOrigin"]
        .as_str()
        .ok_or("Service origin required")?;
    let url = db::validate_url(origin)?;
    if !matches!(url.host_str(), Some("127.0.0.1" | "localhost")) {
        return Err("A loopback analytics fixture is required".into());
    }
    let account = input["accountId"].as_str().ok_or("Account ID required")?;
    let events = serde_json::from_value::<Vec<UsageEvent>>(input["events"].clone())
        .map_err(|_| "Invalid desktop usage events")?;
    let runtime = tokio::runtime::Runtime::new().map_err(|error| error.to_string())?;
    let sent = runtime.block_on(submit_usage(
        events,
        account.to_owned(),
        origin.to_owned(),
        false,
    ));
    Ok(json!({ "sent": sent }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use tokio::io::{AsyncBufReadExt, AsyncWriteExt, BufReader};

    async fn instance_fixture(capability: Value) -> (String, tokio::task::JoinHandle<()>) {
        let listener = tokio::net::TcpListener::bind("127.0.0.1:0").await.unwrap();
        let origin = format!("http://{}", listener.local_addr().unwrap());
        let request = tokio::spawn(async move {
            let (socket, _) = listener.accept().await.unwrap();
            let mut stream = BufReader::new(socket);
            let mut line = String::new();
            stream.read_line(&mut line).await.unwrap();
            assert_eq!(line.trim_end(), "GET /v2/instance HTTP/1.1");
            loop {
                line.clear();
                stream.read_line(&mut line).await.unwrap();
                if line.trim().is_empty() {
                    break;
                }
                assert!(!line.to_ascii_lowercase().starts_with("authorization:"));
            }
            let body = capability.to_string();
            let response = format!(
                "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\nConnection: close\r\n\r\n{body}",
                body.len()
            );
            stream
                .get_mut()
                .write_all(response.as_bytes())
                .await
                .unwrap();
        });
        (origin, request)
    }

    #[test]
    fn desktop_usage_requires_the_cloud_capability_version() {
        let mut capability =
            json!({"version":1,"auth":{},"mode":"cloud","desktopUsageAnalytics":1});
        assert_eq!(
            UsageSupport::from_instance(&capability),
            UsageSupport::Standard
        );
        capability["desktopUsageEventSet"] = json!(2);
        assert_eq!(
            UsageSupport::from_instance(&capability),
            UsageSupport::Expanded
        );
        for capability in [
            json!({"version":1,"auth":{},"mode":"self-hosted","desktopUsageAnalytics":1}),
            json!({"version":1,"auth":{},"mode":"cloud","desktopUsageAnalytics":true}),
            json!({"version":1,"auth":{},"mode":"cloud","desktopUsageAnalytics":2}),
            json!({"version":1,"auth":{},"mode":"cloud"}),
            json!({"version":0,"auth":{},"mode":"cloud","desktopUsageAnalytics":1}),
            json!({"version":1,"mode":"cloud","desktopUsageAnalytics":1}),
            json!({"version":1,"auth":{},"mode":"cloud","desktopUsageEventSet":2}),
        ] {
            assert_eq!(
                UsageSupport::from_instance(&capability),
                UsageSupport::Disabled
            );
        }
    }

    #[test]
    fn desktop_usage_omits_only_expanded_signals_for_an_older_api() {
        let batch = [
            UsageEvent::Settings,
            UsageEvent::SettingsSaved,
            UsageEvent::Members,
            UsageEvent::Envs,
            UsageEvent::SessionForked,
        ];
        let legacy: Vec<_> = batch
            .iter()
            .filter(|event| UsageSupport::Standard.accepts(event))
            .collect();
        assert_eq!(json!(legacy), json!(["screen:settings", "screen:members"]));
        assert!(batch
            .into_iter()
            .all(|event| UsageSupport::Expanded.accepts(&event)));
    }

    #[tokio::test]
    async fn desktop_usage_probes_are_cached_for_the_selected_service() {
        let (managed, first_request) = instance_fixture(
            json!({"version":1,"auth":{},"mode":"cloud","desktopUsageAnalytics":1}),
        )
        .await;
        let mut transport = UsageTransport::default();
        assert_eq!(transport.support(&managed).await, UsageSupport::Standard);
        first_request.await.unwrap();
        // The one-shot service is gone. A fresh connection would now fail.
        assert_eq!(transport.support(&managed).await, UsageSupport::Standard);

        let (legacy, next_request) =
            instance_fixture(json!({"version":1,"auth":{},"mode":"cloud"})).await;
        assert_eq!(transport.support(&legacy).await, UsageSupport::Disabled);
        next_request.await.unwrap();
        let until = transport.capability.as_ref().unwrap().until;
        assert_eq!(transport.support(&legacy).await, UsageSupport::Disabled);
        assert_eq!(transport.capability.as_ref().unwrap().until, until);
    }

    #[tokio::test]
    async fn desktop_usage_rejects_an_oversized_capability_response() {
        let (origin, request) = instance_fixture(json!({
            "version": 1, "auth": {}, "mode": "cloud", "desktopUsageAnalytics": 1,
            "padding": " ".repeat(CAPABILITY_LIMIT),
        }))
        .await;
        assert_eq!(probe_usage(&origin).await, None);
        request.await.unwrap();
    }

    #[test]
    fn desktop_usage_accepts_only_a_bounded_allowlist() {
        let known = json!([
            "screen:projects",
            "screen:sessions",
            "screen:memories",
            "screen:plans",
            "screen:skills",
            "screen:reviews",
            "screen:members",
            "screen:settings",
            "screen:envs",
            "screen:logs",
            "feature:session_resumed",
            "feature:skill_imported",
            "feature:memory_shared",
            "feature:settings_saved",
            "feature:skill_shared",
            "feature:plan_shared",
            "feature:session_shared",
            "feature:source_connected",
            "feature:review_decided",
            "feature:session_forked"
        ]);
        let events: Vec<UsageEvent> = serde_json::from_value(known.clone()).unwrap();
        assert!(valid_batch(&events[..BATCH_LIMIT]));
        assert!(!valid_batch(&events));
        assert_eq!(serde_json::to_value(&events).unwrap(), known);
        assert!(!valid_batch(&[]));
        assert!(!valid_batch(&vec![UsageEvent::Projects; BATCH_LIMIT + 1]));
        for input in [
            json!(["screen:workspace-specific-title"]),
            json!(["feature:refresh"]),
            json!([{"screen":"projects","title":"user information"}]),
        ] {
            assert!(serde_json::from_value::<Vec<UsageEvent>>(input).is_err());
        }
    }
}
