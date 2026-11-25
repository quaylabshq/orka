//! An explicitly started live episode is a read-only presentation of one published session.
mod agent;
mod publisher;
mod reader;

use crate::{
    db::{self, Result},
    governance, indexer, local_resources, sources, sync,
};
use rusqlite::Connection;
use serde_json::{json, Value};
use std::collections::HashMap;
use std::sync::{Arc, LazyLock};
use tokio::sync::Mutex;
use uuid::Uuid;

const MAX_BYTES: usize = 16 * 1024 * 1024;
const MAX_APPEND: usize = 256 * 1024;
static MUTATIONS: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
type Cache = HashMap<String, Arc<reader::View>>;
static VIEWS: LazyLock<Mutex<Cache>> = LazyLock::new(|| Mutex::new(HashMap::new()));

fn denied(error: &str) -> bool {
    ["401:", "403:", "404:", "410:"]
        .iter()
        .any(|p| error.starts_with(p))
}
fn field<'a>(v: &'a Value, key: &str) -> Result<&'a str> {
    v[key]
        .as_str()
        .filter(|v| !v.is_empty())
        .ok_or_else(|| format!("Missing live session {key}"))
}
fn uuid(v: &Value, key: &str) -> Result<String> {
    Ok(Uuid::parse_str(field(v, key)?)
        .map_err(|_| format!("Invalid live session {key}"))?
        .to_string())
}
// Sync already retrieves service capabilities while registering this device.
// Store only the rollout flag in the account/service-specific database.
const CAP_KEY: &str = "live-session-service-capability";
pub(crate) fn remember_capabilities(db: &Connection, capabilities: &Value) {
    if capabilities.is_object() {
        let _ = db::set(
            db,
            CAP_KEY,
            &json!({"at":chrono::Utc::now().timestamp(),"enabled":capabilities["experimentalLiveSessions"]==1}),
        );
    }
}
fn cached_capability(db: &Connection) -> Result<Option<bool>> {
    let cached = db::get(db, CAP_KEY)?;
    let Some(at) = cached["at"].as_i64() else {
        return Ok(None);
    };
    Ok((0..300)
        .contains(&(chrono::Utc::now().timestamp() - at))
        .then(|| cached["enabled"].as_bool())
        .flatten())
}
#[derive(Clone)]
struct Session {
    id: String,
    project: String,
    user: String,
    origin: String,
    device: String,
    scope: String,
    resource: Value,
    source: Value,
    binding: Value,
}
impl Session {
    fn load(input: &Value) -> Result<Self> {
        let scope = db::CacheScope::current()?;
        let db = scope.open()?;
        let id = uuid(input, "id")?;
        let project = uuid(input, "projectId")?;
        let user = uuid(input, "userId")?;
        if db::get(&db, "user")? != user {
            return Err("The signed-in account changed".into());
        }
        let actual =
            governance::resource(&db, &id).or_else(|_| local_resources::resource(&db, &id))?;
        if actual["projectId"] != project
            || actual["kind"] != "session"
            || actual["deleted"] == true
        {
            return Err("Session unavailable in this project".into());
        }
        let p = governance::project(&db, &project)?;
        let source = sources::for_resource(&p, &actual).unwrap_or(Value::Null);
        let config = db::get(&db, "config")?;
        Ok(Self {
            project,
            user,
            origin: field(&config, "apiUrl")?.into(),
            device: db::device(&db)?,
            binding: indexer::binding(&db, &id)?,
            resource: actual,
            source,
            scope: scope.account_scope_digest().ok_or("Sign in required")?,
            id,
        })
    }
    fn checked_db(&self) -> Result<Connection> {
        let scope = db::CacheScope::current()?;
        if scope.account_scope_digest().as_deref() != Some(&self.scope) {
            return Err("The Orka account or service changed".into());
        }
        let db = scope.open()?;
        governance::project(&db, &self.project)?;
        if db::get(&db, "user")? != self.user {
            return Err("The signed-in account changed".into());
        }
        Ok(db)
    }
    fn checked_source(&self) -> Result<Connection> {
        let db = self.checked_db()?;
        let p = governance::project(&db, &self.project)?;
        let active =
            sources::for_resource(&p, &self.resource).ok_or("Session source disconnected")?;
        if active["path"] != self.source["path"]
            || active["folderIdentity"] != self.source["folderIdentity"]
        {
            return Err("Session source changed".into());
        }
        sources::validate(&active)?;
        Ok(db)
    }
    fn published(&self) -> bool {
        self.resource["revision"].as_u64().unwrap_or(0) > 0 && self.resource["localOnly"] != true
    }
    fn eligible(&self) -> bool {
        self.published()
            && self.source["path"].is_string()
            && self.resource["owner"] == self.user
            && matches!(self.resource["source"].as_str(), Some("claude" | "codex"))
            && self.binding["nativeId"].is_string()
            && self.binding["paths"][0].is_string()
    }
    fn input(&self) -> Value {
        json!({"id":self.id,"projectId":self.project,"userId":self.user})
    }
    fn view_key(&self) -> String {
        format!("{}:{}", self.scope, self.id)
    }
    fn intent_key(&self) -> String {
        format!("live-publish:{}", self.id)
    }
    async fn api(&self, method: &str, path: &str, body: Option<&Value>) -> Result<Value> {
        self.checked_db()?;
        static CLIENT: LazyLock<Result<reqwest::Client>> = LazyLock::new(|| {
            reqwest::Client::builder()
                .timeout(std::time::Duration::from_secs(20))
                .redirect(reqwest::redirect::Policy::none())
                .build()
                .map_err(|e| e.to_string())
        });
        let client = CLIENT.as_ref().map_err(Clone::clone)?;
        let mut req =
            sync::authenticated_request(client, &self.user, &self.origin, method, path).await?;
        if let Some(body) = body {
            req = req.json(body)
        }
        let mut response = req
            .send()
            .await
            .map_err(|_| "Cloud unavailable; live session could not reach the service")?;
        let status = response.status();
        if !status.is_success() {
            return Err(format!(
                "{}: Live session access or request failed",
                status.as_u16()
            ));
        }
        let mut bytes = Vec::new();
        while let Some(chunk) = response
            .chunk()
            .await
            .map_err(|_| "Incomplete live response")?
        {
            if bytes.len() + chunk.len() > 2 * MAX_BYTES + 4096 {
                return Err("Live server response exceeds the presentation limit".into());
            }
            bytes.extend_from_slice(&chunk);
        }
        let result = serde_json::from_slice(&bytes).map_err(|_| "Invalid live service response")?;
        self.checked_db()?;
        Ok(result)
    }
    async fn control(&self, action: &str, mut body: Value) -> Result<Value> {
        body["projectId"] = json!(self.project);
        body["resourceId"] = json!(self.id);
        self.api("POST", &format!("/v2/live-sessions/{action}"), Some(&body))
            .await
    }
    fn room(&self, episode: &str, route: &str) -> String {
        format!(
            "/v1/live/rooms/{}/{}/{}/{}",
            self.project, self.id, episode, route
        )
    }
    async fn status(&self) -> Result<Value> {
        static PROBE: LazyLock<Mutex<()>> = LazyLock::new(|| Mutex::new(()));
        let available = if matches!(self.resource["source"].as_str(), Some("claude" | "codex")) {
            let _guard = PROBE.lock().await;
            if let Some(flag) = cached_capability(&self.checked_db()?)? {
                flag
            } else {
                let caps = self.api("GET", "/v2/projects/capabilities", None).await?;
                remember_capabilities(&self.checked_db()?, &caps);
                caps["experimentalLiveSessions"] == 1
            }
        } else {
            false
        };
        let eligible = available && self.eligible();
        let remote = if available && self.published() {
            match self.control("status", json!({})).await {
                Ok(state) => state,
                Err(e) => {
                    VIEWS.lock().await.remove(&self.view_key());
                    if denied(&e) {
                        self.checked_db()?.execute("DELETE FROM meta WHERE key LIKE 'live-agent:%' AND json_extract(value,'$.id')=?", [&self.id]).map_err(|err|err.to_string())?;
                    }
                    return Err(e);
                }
            }
        } else {
            Value::Null
        };
        let episode = remote["episodeId"].as_str();
        let db = self.checked_db()?;
        let following = {
            let mut views = VIEWS.lock().await;
            let key = self.view_key();
            let matches = views
                .get(&key)
                .is_some_and(|v| Some(v.episode.as_str()) == episode);
            if !matches {
                views.remove(&key);
            }
            matches
        };
        db.execute("DELETE FROM meta WHERE key LIKE 'live-agent:%' AND json_extract(value,'$.id')=? AND json_extract(value,'$.episodeId') IS NOT ?",rusqlite::params![self.id,episode]).map_err(|e|e.to_string())?;
        let ag = episode.is_some_and(|ep| agent::has_target(&db, self, ep).unwrap_or(false));
        let reason = if !available {
            Some("Live sessions are unavailable on this service or provider.")
        } else if !self.published() {
            Some("Share this session snapshot before starting live sharing.")
        } else if self.resource["owner"] == self.user && !eligible {
            Some("Start live sharing on the Mac that owns the native session.")
        } else {
            None
        };
        let intent = db::get(&db, &self.intent_key())?;
        Ok(
            json!({"available":available,"eligible":eligible,"active":episode.is_some(),"episodeId":episode,
            "publishing":episode.is_some() && remote["deviceId"]==self.device && self.resource["owner"]==self.user,
            "following":following,"agentFollowing":ag,"reason":intent["error"].as_str().or(reason)}),
        )
    }
}

pub(crate) fn hook_context(project: &Value, tool: &str, id: &str, event: &str) -> Option<String> {
    agent::hook_context(project, tool, id, event)
}
#[tauri::command]
pub async fn live_session(action: String, input: Value) -> Result<Value> {
    let s = Session::load(&input)?;
    match action.as_str() {
        "status" => s.status().await,
        "start" | "stop" => {
            let _guard = MUTATIONS.lock().await;
            if action == "start" {
                publisher::start(&s).await?
            } else {
                publisher::stop(&s, &uuid(&input, "episodeId")?).await?
            }
            s.status().await
        }
        "follow" | "unfollow" | "read" | "wait" => reader::command(&s, &action, &input).await,
        "targets" | "agent_follow" | "agent_unfollow" => agent::command(&s, &action, &input).await,
        _ => Err("Unknown live session action".into()),
    }
}

// A worker belongs to its GUI process. Fence local work immediately, then
// close its durable episode while credentials are still available. A startup
// retries intents left by a crash or an offline quit without resuming capture.
fn fence_intents(db: &Connection, clear: bool) -> Result<Vec<Value>> {
    if clear {
        db.execute("DELETE FROM meta WHERE key LIKE 'live-agent:%'", [])
            .map_err(|e| e.to_string())?;
    }
    let rows=db::rows(db,"SELECT value FROM meta WHERE key LIKE 'live-publish:%' AND json_extract(value,'$.episodeId') IS NOT NULL",&[])?;
    let mut out=db::rows(db,"SELECT value FROM meta WHERE key LIKE 'live-stop:%' AND json_extract(value,'$.episodeId') IS NOT NULL",&[])?;
    for mut row in rows {
        let Some(id) = row["session"]["id"].as_str().map(str::to_owned) else {
            continue;
        };
        row["phase"] = json!("stopping");
        db::set(db, &format!("live-publish:{id}"), &row)?;
        out.push(row)
    }
    Ok(out)
}
pub(crate) fn close_owned(clear_follows: bool) {
    fn pending(clear: bool) -> Result<Vec<Value>> {
        let scope = db::CacheScope::current()?;
        if scope.account_scope_digest().is_none() {
            return Ok(vec![]);
        }
        let db = scope.open()?;
        fence_intents(&db, clear)
    }
    let rows = pending(clear_follows).unwrap_or_default();
    if clear_follows {
        if let Ok(mut views) = VIEWS.try_lock() {
            views.clear();
        }
    }
    if rows.is_empty() {
        return;
    }
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    std::thread::spawn(move || {
        if let Ok(rt) = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
        {
            rt.block_on(async {
                let _ = tokio::time::timeout(std::time::Duration::from_millis(1500), async {
                    let mut jobs = tokio::task::JoinSet::new();
                    for row in rows {
                        jobs.spawn(async move {
                            if let (Ok(s), Ok(ep)) =
                                (Session::load(&row["session"]), uuid(&row, "episodeId"))
                            {
                                publisher::schedule_stop(s.clone(), ep.clone());
                                let _ = publisher::stop(&s, &ep).await;
                            }
                        });
                    }
                    while jobs.join_next().await.is_some() {}
                })
                .await;
            });
        }
        let _ = tx.send(());
    });
    let _ = rx.recv_timeout(std::time::Duration::from_millis(1700));
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn restarting_or_quitting_fences_owned_episodes_and_signout_clears_follows() {
        let dir = tempfile::tempdir().unwrap();
        let db = db::open_at(dir.path()).unwrap();
        db::set(
            &db,
            "live-publish:session",
            &json!({"session":{"id":"session"},"episodeId":"ep","phase":"running"}),
        )
        .unwrap();
        db::set(
            &db,
            "live-stop:other:old",
            &json!({"session":{"id":"other"},"episodeId":"old"}),
        )
        .unwrap();
        db::set(&db, "live-agent:codex:target", &json!({"id":"session"})).unwrap();
        assert_eq!(fence_intents(&db, false).unwrap().len(), 2);
        assert_eq!(
            db::get(&db, "live-publish:session").unwrap()["phase"],
            "stopping"
        );
        assert!(db::get(&db, "live-agent:codex:target").unwrap().is_object());
        fence_intents(&db, true).unwrap();
        assert!(db::get(&db, "live-agent:codex:target").unwrap().is_null());
    }
}
