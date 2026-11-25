use super::*;

#[derive(Default)]
pub(super) struct Feed {
    pub cursor: u64,
    pub records: String,
}
impl Feed {
    pub fn hash(&self) -> String {
        db::digest(self.records.as_bytes())
    }
    pub fn apply(&mut self, reply: &Value) -> Result<()> {
        let cursor = reply["cursor"].as_u64().ok_or("Invalid live cursor")?;
        let reset = reply["reset"].as_bool().ok_or("Invalid live response")?;
        let bytes = reply["records"].as_str().ok_or("Missing live records")?;
        let len = if reset { 0 } else { self.records.len() }.saturating_add(bytes.len());
        if len > MAX_BYTES || (!reset && cursor < self.cursor) {
            return Err("Invalid live transcript length or cursor".into());
        }
        validate(bytes)?;
        let mut updated = if reset {
            String::new()
        } else {
            self.records.clone()
        };
        updated.push_str(bytes);
        if reply["hash"] != db::digest(updated.as_bytes()) {
            return Err("Live transcript integrity check failed".into());
        }
        self.records = updated;
        self.cursor = cursor;
        Ok(())
    }
    pub async fn refresh(&mut self, s: &Session, episode: &str) -> Result<()> {
        let route = format!("content?cursor={}&hash={}", self.cursor, self.hash());
        let r = s.api("GET", &s.room(episode, &route), None).await?;
        self.apply(&r)
    }
}
pub(super) fn validate(records: &str) -> Result<()> {
    if !records.is_empty() && !records.ends_with('\n') {
        return Err("Incomplete live record".into());
    }
    for line in records.split_terminator('\n') {
        if line.len() + 1 > MAX_APPEND {
            return Err("A live turn is too large".into());
        }
        let v: Value = serde_json::from_str(line).map_err(|_| "Invalid live record")?;
        if v.as_object().map(|o| o.len()) != Some(2)
            || !matches!(v["role"].as_str(), Some("user" | "assistant"))
            || !v["text"].is_string()
        {
            return Err("Invalid live turn".into());
        }
    }
    Ok(())
}
pub(super) struct View {
    pub episode: String,
    feed: Mutex<Feed>,
}
impl View {
    fn result(&self, feed: &Feed) -> Result<Value> {
        let messages: Result<Vec<Value>> = feed
            .records
            .lines()
            .enumerate()
            .map(|(i, l)| {
                let mut v: Value = serde_json::from_str(l).map_err(|_| "Invalid live turn")?;
                v["index"] = json!(i);
                Ok(v)
            })
            .collect();
        Ok(
            json!({"episodeId":self.episode,"cursor":feed.cursor,"active":true,"messages":messages?}),
        )
    }
}
pub(super) async fn command(s: &Session, action: &str, input: &Value) -> Result<Value> {
    let episode = uuid(input, "episodeId")?;
    let key = s.view_key();
    if action == "follow" {
        let mut feed = Feed::default();
        feed.refresh(s, &episode).await?;
        VIEWS.lock().await.insert(
            key,
            Arc::new(View {
                episode,
                feed: Mutex::new(feed),
            }),
        );
        return s.status().await;
    }
    let view = VIEWS
        .lock()
        .await
        .get(&key)
        .cloned()
        .ok_or("Follow this live session to view its turns")?;
    if action == "unfollow" {
        // Remove before the outstanding network wait returns. Its result will be discarded.
        if view.episode != episode {
            return Err("Live episode changed".into());
        }
        let mut views = VIEWS.lock().await;
        if views.get(&key).is_some_and(|v| Arc::ptr_eq(v, &view)) {
            views.remove(&key);
        }
        drop(views);
        return s.status().await;
    }
    let result = {
        let mut feed = view.feed.lock().await;
        if view.episode != episode {
            return Err("Live episode changed".into());
        }
        let remote: Result<bool> = async {
            if action == "wait" && input["cursor"].as_u64() == Some(feed.cursor) {
                let notice = s
                    .api(
                        "GET",
                        &s.room(&episode, &format!("wait?cursor={}", feed.cursor)),
                        None,
                    )
                    .await?;
                if notice["cursor"].as_u64() == Some(feed.cursor) {
                    return Ok(false);
                }
            }
            feed.refresh(s, &episode).await?;
            Ok(true)
        }
        .await;
        match remote {
            Ok(true) => view.result(&feed),
            Ok(false) => {
                Ok(json!({"episodeId":episode,"cursor":feed.cursor,"active":true,"unchanged":true}))
            }
            Err(e) => {
                *feed = Feed::default();
                Err(e)
            }
        }
    };
    let mut views = VIEWS.lock().await;
    if !views.get(&key).is_some_and(|v| Arc::ptr_eq(v, &view)) {
        return Err("Live follow ended".into());
    }
    if result.is_err() {
        views.remove(&key);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    fn response(cursor: u64, reset: bool, body: &str, whole: &str) -> Value {
        json!({"cursor":cursor,"reset":reset,"records":body,"hash":db::digest(whole.as_bytes())})
    }
    #[test]
    fn append_checkpoint_and_recovery_are_hash_checked_before_state_changes() {
        let a = "{\"role\":\"user\",\"text\":\"first\"}\n";
        let b = "{\"role\":\"assistant\",\"text\":\"second\"}\n";
        let mut feed = Feed::default();
        feed.apply(&response(1, true, a, a)).unwrap();
        assert!(feed.apply(&response(2, false, b, b)).is_err());
        assert_eq!(feed.cursor, 1);
        assert_eq!(feed.records, a);
        let both = format!("{a}{b}");
        feed.apply(&response(2, false, b, &both)).unwrap();
        assert!(feed.apply(&response(1, false, "", &both)).is_err());
        feed.apply(&response(1, true, b, b)).unwrap();
        assert_eq!(feed.records, b);
    }
    #[test]
    fn rejects_incomplete_records_unrecognized_roles_and_extra_fields() {
        for bad in [
            "{}",
            "{}\n",
            "{\"role\":\"system\",\"text\":\"x\"}\n",
            "{\"role\":\"user\",\"text\":\"x\",\"metadata\":{}}\n",
        ] {
            assert!(validate(bad).is_err())
        }
    }
}
