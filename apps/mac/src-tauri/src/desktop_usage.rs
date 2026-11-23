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

#[derive(Clone, Copy, Deserialize, Serialize)]
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
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
enum UsageSupport {
    Disabled,
    Standard,
    Expanded,
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
            .is_some_and(|set| set >= 2)
        {
            Self::Expanded
        } else {
            Self::Standard
        }
    }

    fn accepts(self, event: UsageEvent) -> bool {
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
            Self::Expanded => true,
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
    events.retain(|event| support.accepts(*event));
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
            "{}/v2/analytics/desktop",
            service_origin.trim_end_matches('/')
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
        submit_usage(events, account_id, service_origin).await;
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
    let sent = runtime.block_on(submit_usage(events, account.to_owned(), origin.to_owned()));
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
            .into_iter()
            .filter(|event| UsageSupport::Standard.accepts(*event))
            .collect();
        assert_eq!(json!(legacy), json!(["screen:settings", "screen:members"]));
        assert!(batch
            .into_iter()
            .all(|event| UsageSupport::Expanded.accepts(event)));
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
        assert!(!valid_batch(&[UsageEvent::Projects; BATCH_LIMIT + 1]));
        for input in [
            json!(["screen:workspace-specific-title"]),
            json!(["feature:refresh"]),
            json!([{"screen":"projects","title":"user information"}]),
        ] {
            assert!(serde_json::from_value::<Vec<UsageEvent>>(input).is_err());
        }
    }
}
