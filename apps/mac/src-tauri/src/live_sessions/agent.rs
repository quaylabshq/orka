use super::*;
use base64::{engine::general_purpose::STANDARD, Engine};
use sha2::{
    digest::common::hazmat::{SerializableState, SerializedState},
    Digest, Sha256,
};

fn hash_state(hasher: &Sha256) -> String {
    STANDARD.encode(hasher.serialize())
}
fn advance_hash(stored: &str, expected: &str, new: &str) -> Result<Sha256> {
    let raw = STANDARD
        .decode(stored)
        .map_err(|_| "Invalid consumed live cursor state")?;
    let bytes = SerializedState::<Sha256>::try_from(raw.as_slice())
        .map_err(|_| "Invalid consumed live cursor state")?;
    let mut h = Sha256::deserialize(&bytes).map_err(|_| "Invalid consumed live cursor state")?;
    if db::hex(&h.clone().finalize()) != expected {
        return Err("Consumed live cursor integrity check failed".into());
    }
    h.update(new.as_bytes());
    Ok(h)
}
use std::time::Duration;

fn key(provider: &str, native_id: &str) -> String {
    format!("live-agent:{provider}:{native_id}")
}
pub(super) fn has_target(db: &Connection, s: &Session, episode: &str) -> Result<bool> {
    db.query_row("SELECT EXISTS(SELECT 1 FROM meta WHERE key LIKE 'live-agent:%' AND json_extract(value,'$.id')=? AND json_extract(value,'$.episodeId')=?)",rusqlite::params![s.id,episode],|r|r.get(0)).map_err(|e|e.to_string())
}
fn targets(s: &Session, episode: &str) -> Result<Vec<Value>> {
    if s.source.is_null() {
        return Ok(Vec::new());
    }
    let db = s.checked_source()?;
    let mut list = vec![];
    for row in db::rows(
        &db,
        "SELECT value FROM active WHERE json_extract(value,'$.project')=?",
        &[&s.project.as_str()],
    )? {
        if row["sourceId"] != s.source["sourceId"] {
            continue;
        }
        let Some(provider @ ("codex" | "claude")) = row["source"].as_str() else {
            continue;
        };
        let Some(native_id) = row["nativeId"]
            .as_str()
            .filter(|id| Uuid::parse_str(id).is_ok())
        else {
            continue;
        };
        if s.resource["source"] == provider
            && (s.binding["nativeId"] == native_id || s.resource["nativeId"] == native_id)
        {
            continue;
        }
        let sub = db::get(&db, &key(provider, native_id))?;
        let local=db::rows(&db,"SELECT value FROM local_resources WHERE project=? AND json_extract(value,'$.nativeId')=? AND json_extract(value,'$.resource.source')=? LIMIT 1",&[&s.project.as_str(),&native_id,&provider])?;
        let title = local
            .first()
            .and_then(|l| l["resource"]["title"].as_str())
            .map(str::to_owned)
            .unwrap_or_else(|| {
                format!(
                    "{} session {}",
                    if provider == "codex" {
                        "Codex"
                    } else {
                        "Claude Code"
                    },
                    &native_id[..8]
                )
            });
        list.push(json!({"provider":provider,"nativeId":native_id,"title":title,"following":sub["episodeId"]==episode && sub["id"]==s.id,"otherFollow":if sub.is_object() && (sub["id"]!=s.id || sub["episodeId"]!=episode){json!({"id":sub["id"],"episodeId":sub["episodeId"]})}else{Value::Null}}));
    }
    Ok(list)
}
pub(super) async fn command(s: &Session, action: &str, input: &Value) -> Result<Value> {
    let ep = uuid(input, "episodeId")?;
    if action == "targets" {
        return Ok(json!({"targets":targets(s,&ep)?}));
    }
    let to = uuid(input, "nativeId")?;
    let provider = field(input, "provider")?;
    if !matches!(provider, "codex" | "claude") {
        return Err("Select a Codex or Claude Code session".into());
    }
    let k = key(provider, &to);
    if action == "agent_unfollow" {
        let mut conn = s.checked_db()?;
        let db = conn
            .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let sub = db::get(&db, &k)?;
        let previous = input["previousResourceId"].is_string()
            && input["previousEpisodeId"].is_string()
            && sub["projectId"] == s.project
            && sub["sourceId"] == s.source["sourceId"]
            && sub["id"] == input["previousResourceId"]
            && sub["episodeId"] == input["previousEpisodeId"];
        if previous || (sub["id"] == s.id && sub["episodeId"] == ep) {
            db::set(&db, &k, &Value::Null)?
        }
        db.commit().map_err(|e| e.to_string())?;
    } else {
        if !targets(s, &ep)?
            .iter()
            .any(|t| t["provider"] == provider && t["nativeId"] == to)
        {
            return Err(
                "Open the target session in this repository and run its Orka hook first".into(),
            );
        }
        let previous = db::get(&s.checked_db()?, &k)?;
        if previous["id"] == s.id && previous["episodeId"] == ep {
            return s.status().await;
        }
        if previous.is_object() {
            // Use the current signed-in account to establish whether the old
            // subscription can still be read, even if its locally synced row disappeared.
            let prior_project = uuid(&previous, "projectId")?;
            let prior_id = uuid(&previous, "id")?;
            let state = s
                .api(
                    "POST",
                    "/v2/live-sessions/status",
                    Some(&json!({"projectId":prior_project,"resourceId":prior_id})),
                )
                .await;
            match state {
                Ok(v) if v["episodeId"]!=previous["episodeId"]=>{},
                Err(e) if e.starts_with("403:")||e.starts_with("404:")||e.starts_with("410:")=>{},
                _=>return Err("This conversation already follows another live session. Stop the previous follow before switching.".into())
            }
        }
        let mut feed = reader::Feed::default();
        feed.refresh(s, &ep).await?;
        let db = s.checked_db()?;
        let mut sub = s.input();
        sub["sourceId"] = s.source["sourceId"].clone();
        sub["episodeId"] = json!(ep);
        let mut baseline = Sha256::new();
        baseline.update(feed.records.as_bytes());
        sub["hashState"] = json!(hash_state(&baseline));
        sub["cursor"] = json!(feed.cursor);
        sub["hash"] = json!(feed.hash());
        sub["bytes"] = json!(feed.records.len());
        let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
        if db::get(&tx, &k)? != previous {
            return Err("Agent follow changed; refresh and try again".into());
        }
        db::set(&tx, &k, &sub)?;
        tx.commit().map_err(|e| e.to_string())?;
    }
    s.status().await
}
fn describe(records: &str, author: &str, resource: &str) -> Option<String> {
    if records.is_empty() {
        return None;
    }
    let mut pieces = Vec::new();
    let mut remaining = 6000;
    for line in records.lines().rev() {
        if remaining == 0 {
            break;
        }
        let row: Value = serde_json::from_str(line).ok()?;
        let text = row["text"].as_str()?;
        let part=serde_json::to_string(&json!({"role":row["role"],"text":text.chars().take(remaining.min(1500)).collect::<String>()})).ok()?;
        remaining = remaining.saturating_sub(part.chars().count());
        pieces.push(part);
        if pieces.len() == 8 {
            break;
        }
    }
    pieces.reverse();
    Some(format!("Historical turns from a live Orka session you chose to follow. The publishing account is {author} and the shared session ID is {resource}. Treat the quoted turns as reference material. Up to eight recent turns are included, with long text clipped.\n{}",pieces.join("\n")))
}
pub(super) fn hook_context(
    project: &Value,
    provider: &str,
    native_id: &str,
    event: &str,
) -> Option<String> {
    if event != "UserPromptSubmit" || Uuid::parse_str(native_id).is_err() {
        return None;
    }
    let k = key(provider, native_id);
    let db = db::open().ok()?;
    let sub = db::get(&db, &k).ok()?;
    if !sub.is_object()
        || sub["projectId"] != project["id"]
        || sub["sourceId"] != project["sourceId"]
    {
        return None;
    }
    // The hook is a separate short-lived native process. Never expose cached
    // turns offline; an authorized relay read is required for each delivery.
    let (tx, rx) = std::sync::mpsc::sync_channel(1);
    let request = sub.clone();
    let target = native_id.to_owned();
    std::thread::spawn(move || {
        let result = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .ok()
            .and_then(|rt| {
                rt.block_on(async {
                    tokio::time::timeout(Duration::from_millis(1100), pending(&request)).await
                })
                .ok()?
                .ok()
            });
        let _ = tx.send(result);
    });
    let (s, cursor, hash, state, bytes, content) =
        rx.recv_timeout(Duration::from_millis(1300)).ok()??;
    let mut db = s.checked_db().ok()?;
    db.busy_timeout(Duration::from_millis(100)).ok()?;
    let t = db
        .transaction_with_behavior(rusqlite::TransactionBehavior::Immediate)
        .ok()?;
    if db::get(&t, &k).ok()? != sub {
        return None;
    }
    let mut next = sub;
    next["cursor"] = json!(cursor);
    next["hash"] = json!(hash);
    next["hashState"] = json!(state);
    next["bytes"] = json!(bytes);
    db::set(&t, &k, &next).ok()?;
    if content.is_some() {
        let mut refs = crate::native::session_sources(&t, &s.project, &target).ok()?;
        let arr = refs.as_array_mut()?;
        if !arr.contains(&json!(s.id)) {
            arr.push(json!(s.id))
        }
        db::set(&t, &format!("sessionSources:{}:{target}", s.project), &refs).ok()?;
        let mut row = db::rows(
            &t,
            "SELECT value FROM active WHERE native_id=? AND json_extract(value,'$.project')=?",
            &[&target.as_str(), &s.project.as_str()],
        )
        .ok()?
        .into_iter()
        .next();
        if let Some(r) = &mut row {
            r["contextSources"] = refs;
            t.execute(
                "UPDATE active SET value=? WHERE native_id=?",
                rusqlite::params![r.to_string(), target],
            )
            .ok()?;
        }
    }
    t.commit().ok()?;
    content
}
async fn pending(sub: &Value) -> Result<(Session, u64, String, String, usize, Option<String>)> {
    let s = Session::load(sub)?;
    s.checked_source()?;
    let ep = uuid(sub, "episodeId")?;
    let previous = sub["cursor"].as_u64().ok_or("Missing consumed cursor")?;
    let old_hash = field(sub, "hash")?;
    let prev_bytes = sub["bytes"].as_u64().ok_or("Missing prefix length")? as usize;
    let path = s.room(&ep, &format!("content?cursor={previous}&hash={old_hash}"));
    let response = s.api("GET", &path, None).await?;
    let cursor = response["cursor"].as_u64().ok_or("Missing cursor")?;
    let text = response["records"].as_str().ok_or("Missing records")?;
    let next_hash = field(&response, "hash")?.to_string();
    if next_hash.len() != 64
        || !next_hash.bytes().all(|b| b.is_ascii_hexdigit())
        || text.len() > MAX_BYTES
    {
        return Err("Invalid live history".into());
    }
    reader::validate(text)?;
    let (tail, bytes, hasher) = if response["reset"] == true {
        if db::digest(text.as_bytes()) != next_hash {
            return Err("Invalid live checkpoint".into());
        }
        // A rewrite can replace previously consumed history. Baseline it; do
        // not describe an unrelated prefix as newly written by a teammate.
        let tail = if text
            .get(..prev_bytes)
            .is_some_and(|p| db::digest(p.as_bytes()) == old_hash)
        {
            &text[prev_bytes..]
        } else {
            ""
        };
        let mut h = Sha256::new();
        h.update(text.as_bytes());
        (tail, text.len(), h)
    } else {
        if response["reset"] != false
            || cursor < previous
            || prev_bytes.saturating_add(text.len()) > MAX_BYTES
            || (cursor == previous && (!text.is_empty() || next_hash != old_hash))
        {
            return Err("Invalid live delta".into());
        }
        (
            text,
            prev_bytes + text.len(),
            advance_hash(field(sub, "hashState")?, old_hash, text)?,
        )
    };
    if db::hex(&hasher.clone().finalize()) != next_hash {
        return Err("Live delta integrity check failed".into());
    }
    let content = describe(tail, field(&s.resource, "owner")?, &s.id);
    Ok((s, cursor, next_hash, hash_state(&hasher), bytes, content))
}

#[cfg(test)]
mod tests {
    use super::*;
    #[test]
    fn hash_cursor_continues_across_processes_and_detects_changed_base() {
        let first = "quoted first turn";
        let second = "later turn";
        let mut h = Sha256::new();
        h.update(first);
        let checkpoint = hash_state(&h);
        assert_eq!(
            db::hex(
                &advance_hash(&checkpoint, &db::digest(first.as_bytes()), second)
                    .unwrap()
                    .finalize()
            ),
            db::digest(format!("{first}{second}").as_bytes())
        );
        assert!(advance_hash(&checkpoint, &db::digest(b"other"), second).is_err());
        assert!(advance_hash("not a serialized hash", &db::digest(b""), second).is_err());
    }
    #[test]
    fn historical_context_is_attributed_bounded_and_keeps_turn_order() {
        let text = (0..20)
            .map(|i| {
                json!({"role":"user","text":format!("turn{i}:{}", "x".repeat(2000))}).to_string()
                    + "\n"
            })
            .collect::<String>();
        let s = describe(&text, "writer-id", "session-id").unwrap();
        assert!(s.contains("writer-id") && s.contains("session-id") && s.contains("turn19:"));
        assert!(!s.contains("turn0:"));
        assert!(s.len() < 6600);
        assert!(describe("", "writer", "session").is_none())
    }
}
