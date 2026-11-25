//! Local, snapshot-bound ranges for the Transcript tab.
use crate::commands::{inspection_candidate, session_snapshot_hash, SessionSnapshotDownload};
use crate::db::{CacheScope, Result};
use crate::session_translation::{self, Message};
use serde::Serialize;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::HashMap;
use std::fs::File;
use std::io::{BufWriter, Read, Seek, SeekFrom, Write};
use std::ops::Range;
use std::sync::{
    atomic::{AtomicBool, Ordering},
    Arc, LazyLock, Mutex,
};
use tokio::sync::Semaphore;

const PAGE_LIMIT: usize = 32 * 1024;
const TAPE_LIMIT: u64 = 512 * 1024 * 1024;
const MAX_READERS: usize = 4;
pub(crate) const SNAPSHOT_INVALIDATED: &str = "transcript_snapshot_invalidated";

struct Reader {
    scope: CacheScope,
    id: String,
    conflict_id: Option<String>,
    candidate_hash: String,
    resource: Value,
    cancelled: AtomicBool,
    tape: Mutex<Option<Tape>>,
}

type Readers = Vec<(String, Arc<Reader>)>;
static READERS: LazyLock<Mutex<Readers>> = LazyLock::new(|| Mutex::new(Vec::new()));
static PREPARE: Semaphore = Semaphore::const_new(1);

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptOpen {
    reader_id: String,
    session_snapshot: Option<SessionSnapshotDownload>,
    #[serde(skip_serializing_if = "std::ops::Not::not")]
    removed: bool,
}

#[derive(Debug, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TranscriptPage {
    offset: u64,
    text: String,
    next_offset: u64,
    eof: bool,
}

impl Reader {
    fn check_cancelled(&self) -> Result<()> {
        if self.cancelled.load(Ordering::Relaxed) {
            return Err(SNAPSHOT_INVALIDATED.into());
        }
        Ok(())
    }

    fn validate(&self) -> Result<()> {
        self.check_cancelled()?;
        if self.scope != CacheScope::current().map_err(|_| SNAPSHOT_INVALIDATED)? {
            return Err(SNAPSHOT_INVALIDATED.into());
        }
        let db = self.scope.open()?;
        let candidate = inspection_candidate(&db, &self.id, self.conflict_id.as_deref())
            .map_err(|_| SNAPSHOT_INVALIDATED)?;
        if candidate["kind"] != "session"
            || candidate["deleted"] == true
            || session_snapshot_hash(&candidate) != self.candidate_hash
        {
            return Err(SNAPSHOT_INVALIDATED.into());
        }
        Ok(())
    }
}

fn registry() -> Result<std::sync::MutexGuard<'static, Readers>> {
    READERS
        .lock()
        .map_err(|_| "Transcript readers are unavailable".into())
}

fn close_reader(id: &str) -> Result<()> {
    let mut readers = registry()?;
    if let Some(index) = readers.iter().position(|(key, _)| key == id) {
        let (_, reader) = readers.remove(index);
        reader.cancelled.store(true, Ordering::Relaxed);
    }
    Ok(())
}

pub(crate) fn close_all() {
    if let Ok(mut readers) = registry() {
        for (_, reader) in readers.drain(..) {
            reader.cancelled.store(true, Ordering::Relaxed);
        }
    }
}

fn open_in_scope(
    scope: CacheScope,
    id: String,
    conflict_id: Option<String>,
) -> Result<TranscriptOpen> {
    let db = scope.open()?;
    let candidate = inspection_candidate(&db, &id, conflict_id.as_deref())?;
    if candidate["kind"] != "session" {
        return Err("Not a session".into());
    }
    if candidate["deleted"] == true {
        return Ok(TranscriptOpen {
            reader_id: String::new(),
            session_snapshot: None,
            removed: true,
        });
    }
    let candidate_hash = session_snapshot_hash(&candidate);
    let (resource, tape) = {
        let snapshot = if conflict_id.is_some() {
            crate::history::SessionRead::stored(candidate)
        } else {
            crate::session_forks::reading_resource(&db, &candidate)?
        };
        // A live snapshot already owns the exact redacted data authorized by
        // the native reader. Format it on this worker without persisting it,
        // then release the native bytes before registering the open handle.
        let tape = if snapshot.is_live() {
            Some(prepare_live(&snapshot)?)
        } else {
            None
        };
        (snapshot.resource, tape)
    };
    let snapshot_hash = session_snapshot_hash(&resource);
    let reader = Arc::new(Reader {
        scope,
        id,
        conflict_id: conflict_id.clone(),
        candidate_hash,
        resource,
        cancelled: AtomicBool::new(false),
        tape: Mutex::new(tape),
    });
    reader.validate().map_err(|error| {
        if error == SNAPSHOT_INVALIDATED {
            "The session or its access changed. Reopen the transcript.".into()
        } else {
            error
        }
    })?;
    let reader_id = uuid::Uuid::new_v4().to_string();
    let mut readers = registry()?;
    if reader.scope != CacheScope::current()? {
        return Err("The Orka account or service changed. Reopen the transcript.".into());
    }
    readers.retain(|(_, existing)| {
        if existing.scope == reader.scope {
            true
        } else {
            existing.cancelled.store(true, Ordering::Relaxed);
            false
        }
    });
    if readers.len() >= MAX_READERS {
        let (_, oldest) = readers.remove(0);
        oldest.cancelled.store(true, Ordering::Relaxed);
    }
    readers.push((reader_id.clone(), reader));
    Ok(TranscriptOpen {
        reader_id,
        session_snapshot: Some(SessionSnapshotDownload {
            conflict_id,
            snapshot_hash,
        }),
        removed: false,
    })
}

#[tauri::command]
pub async fn open_transcript(id: String, conflict_id: Option<String>) -> Result<TranscriptOpen> {
    let scope = CacheScope::current()?;
    let permit = PREPARE.acquire().await.map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        open_in_scope(scope, id, conflict_id)
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub async fn read_transcript(
    reader_id: String,
    offset: Option<u64>,
    max_bytes: usize,
    before: Option<bool>,
) -> Result<TranscriptPage> {
    if !(4..=PAGE_LIMIT).contains(&max_bytes) {
        return Err("Transcript pages must be between 4 bytes and 32 KiB".into());
    }
    let reader = registry()?
        .iter()
        .find(|(key, _)| key == &reader_id)
        .map(|(_, reader)| reader.clone())
        .ok_or(SNAPSHOT_INVALIDATED)?;
    let permit = PREPARE.acquire().await.map_err(|error| error.to_string())?;
    tauri::async_runtime::spawn_blocking(move || {
        let _permit = permit;
        let run = || -> Result<TranscriptPage> {
            reader.validate()?;
            let mut tape = reader
                .tape
                .lock()
                .map_err(|_| "Transcript data is unavailable")?;
            let before = before.unwrap_or(false);
            let first = offset == Some(0) && !before;
            let within_prefix = !before
                && offset.is_some_and(|offset| {
                    offset.saturating_add(max_bytes as u64) <= PAGE_LIMIT as u64
                });
            if tape.is_none() || (!within_prefix && tape.as_ref().is_some_and(|tape| tape.partial))
            {
                *tape = None;
                *tape = Some(prepare(&reader, first)?);
            }
            let page = tape.as_mut().unwrap().page(offset, max_bytes, before)?;
            reader.validate()?;
            Ok(page)
        };
        // Invalid snapshots and cancelled readers must release their file
        // immediately. An invalid page offset can be retried by reopening.
        let result = run();
        if result.is_err() {
            close_reader(&reader_id)?;
        }
        result
    })
    .await
    .map_err(|error| error.to_string())?
}

#[tauri::command]
pub fn close_transcript(reader_id: String) -> Result<()> {
    close_reader(&reader_id)
}

type DuplicateKey = (&'static str, [u8; 32]);
struct Candidate {
    range: Range<u64>,
    key: Option<DuplicateKey>,
    tier: usize,
}

// The tape is anonymous and unlinked. Only byte ranges and duplicate keys
// remain in memory between records. Unselected higher-tier entries are
// never returned by a page.
struct TapeBuilder {
    output: BufWriter<File>,
    bytes: u64,
    prefix: Option<usize>,
    segment_bytes: u64,
    turn: Vec<Candidate>,
    occurrences: HashMap<DuplicateKey, ([usize; 3], [usize; 3])>,
    segment: Vec<Range<u64>>,
    segments: Vec<Vec<Range<u64>>>,
}

impl TapeBuilder {
    fn new(prefix: Option<usize>) -> Result<Self> {
        let file = tempfile::tempfile().map_err(|error| error.to_string())?;
        Ok(Self {
            output: BufWriter::with_capacity(64 * 1024, file),
            bytes: 0,
            prefix,
            segment_bytes: 0,
            turn: Vec::new(),
            occurrences: HashMap::new(),
            segment: Vec::new(),
            segments: Vec::new(),
        })
    }

    fn append(&mut self, message: &Message) -> Result<Range<u64>> {
        let start = self.bytes;
        let mut remaining = self.prefix.unwrap_or(usize::MAX);
        for part in ["## ", message.role, "\n\n", &message.full_text, "\n\n"] {
            let mut count = part.len().min(remaining);
            while !part.is_char_boundary(count) {
                count -= 1;
            }
            self.bytes += count as u64;
            if self.bytes > TAPE_LIMIT {
                return Err("The temporary transcript exceeds its size limit. Download the session to read it.".into());
            }
            self.output
                .write_all(&part.as_bytes()[..count])
                .map_err(|error| error.to_string())?;
            remaining -= count;
            if count < part.len() {
                break;
            }
        }
        Ok(start..self.bytes)
    }

    fn record(&mut self, record: Option<&Value>) -> Result<()> {
        let Some(record) = record else {
            self.flush_turn();
            self.segments.push(std::mem::take(&mut self.segment));
            self.segment_bytes = 0;
            return Ok(());
        };
        if session_translation::starts_turn(record) {
            self.flush_turn();
        }
        // A prefix read still scans and authenticates every segment. Once this
        // segment has a whole page, skip formatting and retaining later turns.
        if self
            .prefix
            .is_some_and(|limit| self.segment_bytes >= (limit - 3) as u64)
        {
            return Ok(());
        }
        if let Some((message, tier)) = session_translation::message(record) {
            let range = self.append(&message)?;
            let key = (!message.text.is_empty())
                .then(|| (message.role, Sha256::digest(message.text.as_bytes()).into()));
            if let Some(key) = key {
                self.occurrences.entry(key).or_default().0[tier] += 1;
            }
            // Base records and entries with no deduplication key cannot
            // be suppressed by a later record. Keep the stable prefix
            // immediately as long as no earlier candidate is undecided.
            if (tier == 0 || key.is_none()) && self.turn.is_empty() {
                self.segment_bytes += range.end - range.start;
                push_range(&mut self.segment, range);
            } else {
                self.turn.push(Candidate { range, key, tier });
            }
        }
        Ok(())
    }

    fn flush_turn(&mut self) {
        for candidate in self.turn.drain(..) {
            if let Some(key) = candidate.key {
                let (count, seen) = self.occurrences.get_mut(&key).unwrap();
                let tier = candidate.tier;
                seen[tier] += 1;
                if tier > 0 && count[..tier].iter().any(|n| *n >= seen[tier]) {
                    continue;
                }
            }
            self.segment_bytes += candidate.range.end - candidate.range.start;
            push_range(&mut self.segment, candidate.range);
        }
        self.occurrences.clear();
    }

    fn finish(self) -> Result<Tape> {
        let mut total = 0;
        // Stored Codex history is verified leaf first. Present oldest first.
        let ranges = self
            .segments
            .into_iter()
            .rev()
            .flatten()
            .map(|range| {
                let start = total;
                total += range.end - range.start;
                (start, range)
            })
            .collect();
        let file = self
            .output
            .into_inner()
            .map_err(|error| error.to_string())?;
        Ok(Tape {
            file,
            total,
            ranges,
            // A harvested prefix includes up to a full UTF-8 scalar beyond
            // the page limit. If it still fits in a page, it was the whole text.
            partial: self.prefix.is_some() && total > PAGE_LIMIT as u64,
        })
    }
}

fn push_range(ranges: &mut Vec<Range<u64>>, range: Range<u64>) {
    if let Some(previous) = ranges
        .last_mut()
        .filter(|previous| previous.end == range.start)
    {
        previous.end = range.end;
    } else {
        ranges.push(range);
    }
}

struct Tape {
    file: File,
    total: u64,
    partial: bool,
    // Logical output start and absolute backing-file range for each record.
    ranges: Vec<(u64, Range<u64>)>,
}

impl Tape {
    fn page(&mut self, offset: Option<u64>, budget: usize, before: bool) -> Result<TranscriptPage> {
        let position = offset.unwrap_or(self.total);
        if position > self.total {
            return Err("Transcript offset exceeds the snapshot".into());
        }
        let backwards = before || offset.is_none();
        let (start, end) = if backwards {
            (position.saturating_sub(budget as u64), position)
        } else {
            (position, (position + budget as u64).min(self.total))
        };
        let mut bytes = Vec::with_capacity((end - start) as usize);
        let index = self
            .ranges
            .partition_point(|(logical, range)| logical + (range.end - range.start) <= start);
        for (logical, range) in self.ranges[index..]
            .iter()
            .take_while(|(logical, _)| *logical < end)
        {
            let from = start.saturating_sub(*logical);
            let through = (end - logical).min(range.end - range.start);
            let length = (through - from) as usize;
            let initial = bytes.len();
            bytes.resize(initial + length, 0);
            self.file
                .seek(SeekFrom::Start(range.start + from))
                .and_then(|_| self.file.read_exact(&mut bytes[initial..]))
                .map_err(|error| error.to_string())?;
        }
        let skip = if backwards {
            bytes
                .iter()
                .take_while(|byte| *byte & 0b1100_0000 == 0b1000_0000)
                .count()
        } else {
            0
        };
        let text = match std::str::from_utf8(&bytes[skip..]) {
            Ok(text) => text,
            Err(error) if !backwards && error.error_len().is_none() => {
                std::str::from_utf8(&bytes[..error.valid_up_to()])
                    .map_err(|error| error.to_string())?
            }
            Err(_) => return Err("Transcript offset is not at a UTF-8 boundary".into()),
        };
        let offset = start + skip as u64;
        let next_offset = offset + text.len() as u64;
        Ok(TranscriptPage {
            offset,
            text: text.into(),
            next_offset,
            eof: next_offset == self.total,
        })
    }
}

fn visit_pi(reader: &Reader, builder: &mut TapeBuilder) -> Result<()> {
    // The last persisted Pi entry is the branch head. Only retain the
    // metadata used to validate/select that branch and message byte ranges.
    let mut entries = Vec::new();
    let mut ranges = HashMap::new();
    crate::history::visit_stored_transcript(
        &reader.scope,
        &reader.resource,
        || reader.check_cancelled(),
        |record| {
            let Some(record) = record else {
                return Ok(());
            };
            if entries.is_empty() {
                entries.push(record.clone());
                return Ok(());
            }
            let id = record["id"].as_str().ok_or("Missing Pi entry ID")?;
            let parent = record.get("parentId").ok_or("Invalid Pi entry parent")?;
            if record["type"] == "message" {
                if let Some((message, _)) = session_translation::message(record) {
                    ranges.insert(id.to_owned(), builder.append(&message)?);
                }
            }
            entries.push(serde_json::json!({"id":id,"parentId":parent,"type":record["type"]}));
            Ok(())
        },
    )?;
    crate::native::validate_session_import("pi", &entries)?;
    for entry in crate::pi_sessions::branch(&entries)? {
        let id = entry["id"].as_str().unwrap();
        if let Some(range) = ranges.remove(id) {
            push_range(&mut builder.segment, range);
        }
    }
    builder.record(None)
}

fn prepare_live(snapshot: &crate::history::SessionRead) -> Result<Tape> {
    let records = snapshot.records()?;
    let mut builder = TapeBuilder::new(None)?;
    if records
        .first()
        .is_some_and(|record| record["type"] == "session")
    {
        for record in crate::pi_sessions::branch(&records)? {
            if record["type"] == "message" {
                if let Some((message, _)) = session_translation::message(record) {
                    let range = builder.append(&message)?;
                    push_range(&mut builder.segment, range);
                }
            }
        }
    } else {
        for record in records.iter() {
            builder.record(Some(record))?;
        }
    }
    builder.record(None)?;
    builder.finish()
}

fn prepare(reader: &Reader, first: bool) -> Result<Tape> {
    // A UTF-8 scalar can require four bytes. Keep enough lookahead to tell a
    // full first page from EOF, without exposing any partial byte sequence.
    let prefix = (first && reader.resource["source"] != "pi").then_some(PAGE_LIMIT + 4);
    let mut builder = TapeBuilder::new(prefix)?;
    if reader.resource["source"] == "pi" {
        visit_pi(reader, &mut builder)?;
    } else {
        crate::history::visit_stored_transcript(
            &reader.scope,
            &reader.resource,
            || reader.check_cancelled(),
            |record| builder.record(record),
        )?;
    }
    builder.finish()
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    #[test]
    fn stable_claude_head_is_harvested_without_formatting_later_records() {
        let head = json!({"type":"user","message":{"role":"user","content":"🔎".repeat(9_000)}});
        let later = json!({"type":"assistant","message":{"role":"assistant","content":"large tool result".repeat(150_000)}});
        let mut builder = TapeBuilder::new(Some(PAGE_LIMIT + 4)).unwrap();
        builder.record(Some(&head)).unwrap();
        let head_bytes = builder.bytes;
        builder.record(Some(&later)).unwrap();
        assert_eq!(
            builder.bytes, head_bytes,
            "The later record should not be formatted"
        );
        builder.record(None).unwrap();
        let mut tape = builder.finish().unwrap();
        let page = tape.page(Some(0), PAGE_LIMIT, false).unwrap();
        let expected = crate::native::transcript(&[head, later]);
        assert_eq!(page.text, &expected[..page.next_offset as usize]);
        assert!(!page.eof);
    }

    #[test]
    fn early_base_outputs_still_count_when_deduplicating_later_records() {
        let visible = json!({"type":"message","role":"assistant","content":[{"type":"output_text","text":"repeat"}]});
        let records = [
            json!({"type":"response_item","payload":visible}),
            json!({"type":"event_msg","payload":{"type":"item_completed","item":visible}}),
            json!({"type":"event_msg","payload":{"type":"item_completed","item":visible}}),
            json!({"type":"response_item","payload":{"type":"function_call_output","output":"last"}}),
        ];
        let mut builder = TapeBuilder::new(None).unwrap();
        for record in &records {
            builder.record(Some(record)).unwrap();
        }
        builder.record(None).unwrap();
        let mut tape = builder.finish().unwrap();
        let page = tape.page(Some(0), PAGE_LIMIT, false).unwrap();
        assert_eq!(page.text, crate::native::transcript(&records));
        assert!(page.eof);
    }
}
