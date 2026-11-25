use super::*;
use crate::{
    history, native, scan_cache::FileStamp, session_presentation,
    session_redaction::SessionRedactor,
};
use std::path::{Path, PathBuf};
use tokio::time::{sleep, Duration};

fn sources(s: &Session) -> Result<Value> {
    let db = s.checked_db()?;
    let mut refs = s.resource["contextSources"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    let native = field(&s.binding, "nativeId")?;
    for src in native::session_sources(&db, &s.project, native)?
        .as_array()
        .into_iter()
        .flatten()
    {
        if !refs.contains(src) {
            refs.push(src.clone());
        }
    }
    Ok(json!(refs))
}
fn path(s: &Session) -> Result<PathBuf> {
    let native = field(&s.binding, "nativeId")?;
    let db = s.checked_source()?;
    let activity=db::rows(&db,"SELECT value FROM active WHERE native_id=? AND json_extract(value,'$.project')=? AND json_extract(value,'$.source')=?", &[&native,&s.project.as_str(),&field(&s.resource,"source")?])?;
    let path = activity
        .first()
        .and_then(|a| a["transcriptPath"].as_str())
        .or_else(|| s.binding["paths"][0].as_str())
        .ok_or("Native transcript unavailable")?;
    let path = Path::new(path)
        .canonicalize()
        .map_err(|_| "Native transcript unavailable")?;
    let home = if s.resource["source"] == "codex" {
        native::codex_home()?
    } else {
        native::claude_home()?
    };
    if !path.starts_with(home.canonicalize().map_err(|_| "Native home unavailable")?) {
        return Err("Native transcript moved outside its provider home".into());
    }
    Ok(path)
}
fn project_records(mut rows: Vec<Value>) -> Result<String> {
    rows.iter_mut().for_each(SessionRedactor::redact);
    let mut out = String::new();
    for msg in session_presentation::conversation_messages(&rows) {
        let line = serde_json::to_string(&json!({"role":msg.role,"text":msg.text}))
            .map_err(|e| e.to_string())?;
        if line.len() + 1 > MAX_APPEND || out.len() + line.len() + 1 > MAX_BYTES {
            return Err("Session exceeds the live presentation limit".into());
        }
        SessionRedactor::check_upload(line.as_bytes())?;
        out.push_str(&line);
        out.push('\n');
    }
    Ok(out)
}
fn current(s: &Session, path: &Path) -> Result<String> {
    let root = Path::new(field(&s.source, "path")?);
    let tool = field(&s.resource, "source")?;
    let records = if tool == "codex" {
        let h = history::History::local(path, Some(root))?;
        if h.rollouts.last().map(|r| r.id.as_str()) != Some(field(&s.binding, "nativeId")?) {
            return Err("Codex transcript identity changed".into());
        }
        h.records()
    } else {
        let r = native::complete_records(&history::read_session(path)?)?;
        let (id, cwd, _) = native::session_info(tool, &r)?;
        if id != field(&s.binding, "nativeId")? || !cwd.starts_with(root) {
            return Err("Claude transcript identity or source changed".into());
        }
        r
    };
    prepare(
        &mut s.checked_source()?,
        &s.project,
        field(&s.binding, "nativeId")?,
        s.source["governed"] == true,
        records,
    )
}
fn prepare(
    db: &mut Connection,
    project: &str,
    id: &str,
    governed: bool,
    records: Vec<Value>,
) -> Result<String> {
    if governed {
        let tx = db
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        native::bind_handoff(&tx, project, id, &records)?;
        tx.commit().map_err(|e| e.to_string())?;
    }
    project_records(records)
}
pub(super) async fn start(s: &Session) -> Result<()> {
    if !s.eligible() {
        return Err(
            "Share the current session snapshot from its owning Mac before starting live sharing"
                .into(),
        );
    }
    let caps = s.api("GET", "/v2/projects/capabilities", None).await?;
    if caps["experimentalLiveSessions"] != 1 {
        return Err("This service has live sessions disabled".into());
    }
    let previous = db::get(&s.checked_db()?, &s.intent_key())?;
    let remote = s.control("status", json!({})).await?;
    if remote["episodeId"].is_string()
        && (previous["episodeId"] != remote["episodeId"] || previous["deviceId"] != s.device)
    {
        return Err("A live episode is already active. Stop that episode first.".into());
    }
    let retry = previous["phase"] == "starting";
    if remote["episodeId"].is_string() && !retry {
        return Err("This session is already live".into());
    }
    let ep = if retry {
        uuid(&previous, "episodeId")?
    } else {
        Uuid::new_v4().to_string()
    };
    let p = path(s)?;
    let initial_session = s.clone();
    let initial = tokio::task::spawn_blocking(move || current(&initial_session, &p))
        .await
        .map_err(|e| e.to_string())??;
    let body = json!({"episodeId":ep,"deviceId":s.device,"expectedRevision":if retry{previous["expectedRevision"].clone()}else{s.resource["revision"].clone()},"contextSources":sources(s)?});
    let mut intent = body.clone();
    intent["session"] = s.input();
    intent["phase"] = json!("starting");
    db::set(&s.checked_db()?, &s.intent_key(), &intent)?;
    let result = s.control("start", body).await;
    if let Err(e) = &result {
        if e.starts_with("409:") {
            db::set(&s.checked_db()?, &s.intent_key(), &Value::Null)?
        }
    }
    if result?["episodeId"] != ep {
        return Err("Service returned a different live episode".into());
    }
    let mut feed = reader::Feed::default();
    let first = async {
        if retry {
            feed.refresh(s, &ep).await?
        }
        write(s, &ep, &mut feed, initial, true).await
    }
    .await;
    if let Err(e) = first {
        let _ = stop(s, &ep).await;
        return Err(e);
    }
    intent["phase"] = json!("running");
    db::set(&s.checked_db()?, &s.intent_key(), &intent)?;
    let session = s.clone();
    tauri::async_runtime::spawn(async move {
        let result = watch(&session, &ep, feed).await;
        if let Err(error) = result {
            if let Ok(db) = session.checked_db() {
                if db::get(&db, &session.intent_key())
                    .is_ok_and(|v| v["episodeId"] == ep && v["phase"] == "running")
                {
                    let _ = db::set(
                        &db,
                        &session.intent_key(),
                        &json!({"phase":"stopping","episodeId":ep,"deviceId":session.device,"session":session.input(),"error":error}),
                    );
                    drop(db);
                    let _ = stop(&session, &ep).await;
                }
            }
        }
    });
    Ok(())
}
fn prefix<'a>(old: &str, new: &'a str) -> Option<&'a str> {
    new.strip_prefix(old).filter(|x| x.len() <= MAX_APPEND)
}
async fn write(
    s: &Session,
    ep: &str,
    feed: &mut reader::Feed,
    records: String,
    checkpoint: bool,
) -> Result<()> {
    let tail = prefix(&feed.records, &records);
    let is_checkpoint = checkpoint || tail.is_none();
    let sent = if is_checkpoint {
        records.as_str()
    } else {
        tail.unwrap_or_default()
    };
    let hash = db::digest(records.as_bytes());
    let data = json!({"requestId":Uuid::new_v4().to_string(),"baseCursor":feed.cursor,"baseHash":feed.hash(),"hash":hash,"records":sent,"deviceId":s.device,"contextSources":sources(s)?});
    let (method, route) = if is_checkpoint {
        ("PUT", "checkpoint")
    } else {
        ("POST", "append")
    };
    let reply = match s.api(method, &s.room(ep, route), Some(&data)).await {
        Ok(v) => v,
        Err(e) if e.starts_with("Cloud unavailable") => {
            // The server may have committed before the connection failed. Retry exact bytes and key.
            s.api(method, &s.room(ep, route), Some(&data)).await?
        }
        Err(e) if e.starts_with("409:") && feed.cursor > 0 => {
            let mut actual = reader::Feed::default();
            actual.refresh(s, ep).await?;
            if actual.records == records {
                *feed = actual;
                return Ok(());
            }
            if actual.cursor != 0 || !actual.records.is_empty() {
                return Err("Live transcript diverged; stop and restart sharing".into());
            }
            // The isolated relay lost its ephemeral room. The durable owner
            // still authorizes this episode. Recreate only from a complete projection.
            let recovery = json!({"requestId":Uuid::new_v4().to_string(),"baseCursor":0,"baseHash":actual.hash(),"hash":hash,"records":records,"deviceId":s.device,"contextSources":sources(s)?});
            let receipt = s
                .api("PUT", &s.room(ep, "checkpoint"), Some(&recovery))
                .await?;
            *feed = actual;
            receipt
        }
        Err(e) => return Err(e),
    };
    let cursor = reply["cursor"]
        .as_u64()
        .ok_or("Invalid live write receipt")?;
    if reply["hash"] != hash || cursor <= feed.cursor {
        return Err("Invalid live write receipt".into());
    }
    feed.cursor = cursor;
    feed.records = records;
    Ok(())
}
async fn watch(s: &Session, ep: &str, mut feed: reader::Feed) -> Result<()> {
    use notify::Watcher;
    let mut prior = None;
    let (wake, mut events) = tokio::sync::mpsc::channel(1);
    let mut watcher = None;
    let mut watched = PathBuf::new();
    loop {
        if prior.is_some() {
            let interval = if watcher.is_some() {
                Duration::from_secs(2)
            } else {
                Duration::from_millis(250)
            };
            tokio::select! {
                _=sleep(interval)=>{},
                _=events.recv()=>{sleep(Duration::from_millis(100)).await;}
            }
        }
        let db = s.checked_db()?;
        let intent = db::get(&db, &s.intent_key())?;
        if intent["episodeId"] != ep || intent["phase"] != "running" {
            return Ok(());
        }
        let active = governance::resource(&db, &s.id)?;
        if active["deleted"] == true
            || active["owner"] != s.user
            || active["sourceId"] != s.resource["sourceId"]
        {
            return Err("Shared session changed".into());
        }
        drop(db);
        let p = path(s)?;
        if watched != p {
            let wake = wake.clone();
            let target = p.clone();
            watcher = notify::recommended_watcher(move |event: notify::Result<notify::Event>| {
                if event.is_err()
                    || event.is_ok_and(|e| e.need_rescan() || e.paths.iter().any(|f| f == &target))
                {
                    let _ = wake.try_send(());
                }
            })
            .ok()
            .and_then(|mut w| {
                w.watch(p.parent()?, notify::RecursiveMode::NonRecursive)
                    .ok()?;
                Some(w)
            });
            watched = p.clone();
        }
        let stamp = FileStamp::of(&p).ok_or("Native session is unavailable")?;
        let signature = (p.clone(), stamp, sources(s)?);
        if prior.as_ref() == Some(&signature) {
            continue;
        }
        let session = s.clone();
        let records = tokio::task::spawn_blocking(move || current(&session, &p))
            .await
            .map_err(|e| e.to_string())??;
        if records != feed.records
            || prior
                .as_ref()
                .is_some_and(|old: &(PathBuf, FileStamp, Value)| old.2 != signature.2)
        {
            write(s, ep, &mut feed, records, false).await?;
        }
        prior = Some(signature);
    }
}
fn stop_key(s: &Session, ep: &str) -> String {
    format!("live-stop:{}:{ep}", s.id)
}
async fn stop_remote(s: &Session, ep: &str) -> Result<()> {
    s.control("stop", json!({"episodeId":ep,"deviceId":s.device}))
        .await?;
    let db = s.checked_db()?;
    if db::get(&db, &s.intent_key())?["episodeId"] == ep {
        db::set(&db, &s.intent_key(), &Value::Null)?;
    }
    db::set(&db, &stop_key(s, ep), &Value::Null)
}
pub(super) async fn stop(s: &Session, ep: &str) -> Result<()> {
    if s.resource["owner"] != s.user {
        return Err("Only the session owner can stop live sharing".into());
    }
    let db = s.checked_db()?;
    let mut intent = db::get(&db, &s.intent_key())?;
    if intent["episodeId"] == ep {
        intent["phase"] = json!("stopping");
        db::set(&db, &s.intent_key(), &intent)?
    }
    db::set(
        &db,
        &stop_key(s, ep),
        &json!({"session":s.input(),"episodeId":ep}),
    )?;
    drop(db);
    let result = stop_remote(s, ep).await;
    if result.is_err() {
        schedule_stop(s.clone(), ep.to_owned());
    }
    result
}
pub(super) fn schedule_stop(s: Session, ep: String) {
    use std::collections::HashSet;
    static STOPPING: LazyLock<std::sync::Mutex<HashSet<String>>> = LazyLock::new(Default::default);
    let key = format!("{}:{ep}", s.view_key());
    if !STOPPING
        .lock()
        .is_ok_and(|mut active| active.insert(key.clone()))
    {
        return;
    }
    tauri::async_runtime::spawn(async move {
        let mut delay = 2;
        loop {
            sleep(Duration::from_secs(delay)).await;
            let Ok(db) = s.checked_db() else { break };
            if !db::get(&db, &stop_key(&s, &ep)).is_ok_and(|intent| intent["episodeId"] == ep) {
                break;
            }
            drop(db);
            match stop_remote(&s, &ep).await {
                Ok(()) => break,
                Err(e)
                    if e.starts_with("403:") || e.starts_with("404:") || e.starts_with("410:") =>
                {
                    if let Ok(db) = s.checked_db() {
                        let _ = db::set(&db, &stop_key(&s, &ep), &Value::Null);
                    }
                    break;
                }
                Err(_) => delay = (delay * 2).min(30),
            }
        }
        if let Ok(mut active) = STOPPING.lock() {
            active.remove(&key);
        }
    });
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn redacts_provider_history_and_skips_tool_setup_and_incomplete_tail() {
        let secret = format!("sk-{}", "s".repeat(24));
        let mut raw = native::encode(&[
            json!({"type":"user","message":{"role":"user","content":format!("Is {secret} saved?")}}),
            json!({"type":"assistant","message":{"role":"assistant","content":[{"type":"thinking","thinking":"private chain"},{"type":"tool_use","name":"Read","input":{"path":"hidden fixture"}},{"type":"text","text":"Saved"}]}}),
            json!({"type":"user","message":{"role":"user","content":[{"type":"tool_result","content":"tool secret"}]}}),
        ]);
        raw.extend_from_slice(b"{\"type\":\"user\",\"message\":");
        let projected = project_records(native::complete_records(&raw).unwrap()).unwrap();
        let lines: Vec<Value> = projected
            .lines()
            .map(|l| serde_json::from_str(l).unwrap())
            .collect();
        assert_eq!(
            lines,
            vec![
                json!({"role":"user","text":"Is [REDACTED] saved?"}),
                json!({"role":"assistant","text":"Saved"})
            ]
        );
        let codex = vec![
            json!({"type":"response_item","payload":{"type":"message","role":"developer","content":[{"type":"input_text","text":"private setup"}]}}),
            json!({"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"Finished"}]}}),
            json!({"type":"event_msg","payload":{"type":"agent_message","message":"Finished"}}),
        ];
        assert_eq!(project_records(codex).unwrap().lines().count(), 1);
    }

    #[test]
    fn append_requires_an_exact_bounded_prefix() {
        assert_eq!(prefix("first\n", "first\nsecond\n"), Some("second\n"));
        assert_eq!(prefix("first\n", "edited\n"), None);
        assert_eq!(prefix("", &"x".repeat(MAX_APPEND + 1)), None);
    }
}

#[cfg(test)]
mod provenance_tests {
    use super::*;
    #[test]
    fn binds_new_restricted_handoff_before_projecting_a_new_answer() {
        let dir = tempfile::tempdir().unwrap();
        let mut db = db::open_at(dir.path()).unwrap();
        db::set(
            &db,
            "handoff:project:fixture",
            &json!({"path":"/fixture/restricted.md","sources":["restricted-id"]}),
        )
        .unwrap();
        let data = vec![
            json!({"type":"user","message":{"role":"user","content":"Read /fixture/restricted.md"}}),
            json!({"type":"assistant","message":{"role":"assistant","content":"Sensitive derived conclusion"}}),
        ];
        assert!(prepare(&mut db, "project", "native", true, data)
            .unwrap()
            .contains("conclusion"));
        assert_eq!(
            native::session_sources(&db, "project", "native").unwrap(),
            json!(["restricted-id"])
        );
    }
}
