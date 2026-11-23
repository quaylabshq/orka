//! The background sync queue: at most one pending job per project, plus a `*`
//! job for the workspace-wide steps. One worker runs one job at a time and
//! holds the workspace lock only for that job, so foreground work can take the
//! lock between jobs instead of waiting for a whole cycle.
use crate::{
    db::{self, Result},
    projects::CAPTURE_ONLY,
    sync_schedule::{jitter, Interval},
};
use rusqlite::{params, Connection, OptionalExtension};
use serde_json::{json, Value};
use std::{collections::HashMap, sync::LazyLock, time::Duration};

pub(crate) const WORKSPACE: &str = "*";
const OUTAGE: &str = "syncOutage";
const PROGRESS_CLAIM: &str = "syncProgressClaim";
static PROGRESS_OWNER: LazyLock<String> = LazyLock::new(|| uuid::Uuid::new_v4().to_string());

/// A cancel is written to the shared database, so it reaches whichever process
/// runs the job. Each claim has an identity independent of pending requests,
/// so a merge cannot hide an active job or cancel a later run.
fn cancel_key(project: &str) -> String {
    format!("syncCancel:{project}")
}

fn claim_key(project: &str) -> String {
    format!("syncClaim:{project}")
}

fn cancelled_at_key(project: &str) -> String {
    format!("syncCancelledAt:{project}")
}

/// The `not_before` of a job while it runs, so it is not picked again. A request
/// that arrives meanwhile merges in and lowers it, which tells the worker to
/// keep the row when the job finishes.
const RUNNING: i64 = i64::MAX;

/// How many sync intervals a deleted, restorable project waits between its
/// capture-only timer jobs. Local changes and user requests still run at once.
const CAPTURE_INTERVAL_FACTOR: u32 = 4;

#[derive(Clone, Copy)]
pub(crate) enum Priority {
    Timer = 0,
    Local = 1,
    User = 2,
}

#[derive(Clone, Debug, PartialEq)]
pub(crate) struct Job {
    pub(crate) project: String,
    priority: i64,
    reason: String,
    requested_at: i64,
    not_before: i64,
    attempts: u32,
}

#[derive(Debug)]
pub(crate) enum Outcome {
    Synced,
    /// No request was made because the project is no longer active.
    Skipped,
    /// Finished with item errors or deferred uploads; retried with backoff.
    Deferred,
    /// A deleted, restorable project scanned its local files into the outbox
    /// without any request. Its timer restarts, but no cloud sync is recorded.
    Captured,
    /// Stopped early for foreground work; queued again as it was.
    Yielded,
    /// The user cancelled it at a stage boundary: no backoff for the rest of
    /// the work. Its next automatic interval is separate from a successful sync.
    Cancelled,
}

/// The worker's schedule. The queue itself lives in SQLite; this keeps when
/// each project last synced, which sets its next timer job.
pub(crate) struct SyncQueue {
    device: String,
    started: i64,
    synced: HashMap<String, i64>,
}

fn millis(duration: Duration) -> i64 {
    duration.as_millis() as i64
}

/// A failure of the service rather than of one project: no connection, a
/// timeout or a server error. Every other job would fail the same way.
fn outage(error: &str) -> bool {
    let code = error
        .split_once(':')
        .and_then(|(code, _)| code.parse::<u16>().ok());
    matches!(
        error,
        "Cloud unavailable; local work stays queued"
            | "Blob upload failed; retry retained"
            | "Blob download failed"
    ) || matches!(code, Some(408 | 500..=599))
}

fn iso(at: i64) -> Option<String> {
    chrono::DateTime::from_timestamp_millis(at)
        .map(|time| time.to_rfc3339_opts(chrono::SecondsFormat::Millis, true))
}

fn sql(result: rusqlite::Result<usize>) -> Result<()> {
    result.map(|_| ()).map_err(|e| e.to_string())
}

impl SyncQueue {
    pub(crate) fn new(now: i64) -> Self {
        Self {
            device: String::new(),
            started: now,
            synced: HashMap::new(),
        }
    }

    pub(crate) fn now() -> i64 {
        chrono::Utc::now().timestamp_millis()
    }

    /// Adds a request, or merges it into the project's queued job. The higher
    /// priority and the earlier eligible `not_before` win. Automatic requests
    /// respect a service outage; capture-only jobs and explicit user requests
    /// may run during one.
    pub(crate) fn enqueue(
        db: &Connection,
        project: &str,
        priority: Priority,
        reason: &str,
        now: i64,
    ) -> Result<()> {
        Self::merge(
            db,
            &Job {
                project: project.into(),
                priority: priority as i64,
                reason: reason.into(),
                requested_at: now,
                not_before: now,
                attempts: 0,
            },
        )
    }

    fn merge(db: &Connection, job: &Job) -> Result<()> {
        db.execute(
            // Read the project state and service hold inside the UPSERT so a
            // concurrent catalog update or outage cannot leave a stale deadline.
            &format!(
                "WITH service_hold AS (
                    SELECT value FROM meta WHERE key=?7
                      AND NOT EXISTS(SELECT 1 FROM projects WHERE id=?1 AND {CAPTURE_ONLY})
                 )
                 INSERT INTO sync_queue VALUES(?1,?2,?3,?4,
                 CASE WHEN ?2<2 THEN max(?5,coalesce((SELECT json_extract(value,'$.notBefore') FROM service_hold),?5)) ELSE ?5 END,
                 max(?6,coalesce((SELECT json_extract(value,'$.attempts') FROM service_hold),0)))
                 ON CONFLICT(project) DO UPDATE SET
                 reason=CASE WHEN excluded.priority>priority THEN excluded.reason ELSE reason END,
                 priority=max(priority,excluded.priority),
                 requested_at=min(requested_at,excluded.requested_at),
                 not_before=min(not_before,excluded.not_before),
                 attempts=max(attempts,excluded.attempts)"
            ),
            params![
                job.project,
                job.priority,
                job.reason,
                job.requested_at,
                job.not_before,
                job.attempts,
                OUTAGE
            ],
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
    }

    /// The workspace, every active project, and every deleted project that can
    /// still be restored, whose job only captures local changes.
    fn targets(db: &Connection) -> Result<Vec<String>> {
        let sql = format!(
            "SELECT id FROM projects WHERE {}",
            *crate::projects::CAPTURABLE
        );
        let mut query = db.prepare(&sql).map_err(|e| e.to_string())?;
        let ids = query
            .query_map([], |row| row.get(0))
            .and_then(|rows| rows.collect::<rusqlite::Result<Vec<String>>>())
            .map_err(|e| e.to_string())?;
        Ok(std::iter::once(WORKSPACE.to_string()).chain(ids).collect())
    }

    fn capture_only(db: &Connection) -> Result<std::collections::HashSet<String>> {
        let sql = format!("SELECT id FROM projects WHERE {CAPTURE_ONLY}");
        let mut query = db.prepare(&sql).map_err(|e| e.to_string())?;
        let ids = query
            .query_map([], |row| row.get(0))
            .and_then(|rows| rows.collect::<rusqlite::Result<_>>())
            .map_err(|e| e.to_string())?;
        Ok(ids)
    }

    pub(crate) fn is_capture_only(db: &Connection, project: &str) -> Result<bool> {
        db.query_row(
            &format!("SELECT EXISTS(SELECT 1 FROM projects WHERE id=? AND {CAPTURE_ONLY})"),
            [project],
            |row| row.get(0),
        )
        .map_err(|error| error.to_string())
    }

    /// Queues the workspace steps and every active project.
    pub(crate) fn enqueue_all(
        db: &Connection,
        priority: Priority,
        reason: &str,
        now: i64,
    ) -> Result<()> {
        let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
        for project in Self::targets(&tx)? {
            Self::enqueue(&tx, &project, priority, reason, now)?;
        }
        tx.commit().map_err(|e| e.to_string())
    }

    /// Queues the workspace steps and every active project, now.
    pub(crate) fn request_all(db: &Connection, priority: Priority, reason: &str) -> Result<()> {
        Self::enqueue_all(db, priority, reason, Self::now())
    }

    /// Queues one project, or `WORKSPACE`, for a change that just happened.
    pub(crate) fn request(
        db: &Connection,
        project: &str,
        priority: Priority,
        reason: &str,
    ) -> Result<()> {
        Self::enqueue(db, project, priority, reason, Self::now())
    }

    /// Queues one project to start no earlier than `at` (milliseconds). An
    /// earlier request for the same project still runs first.
    pub(crate) fn request_at(
        db: &Connection,
        project: &str,
        priority: Priority,
        reason: &str,
        at: i64,
    ) -> Result<()> {
        let now = Self::now();
        Self::merge(
            db,
            &Job {
                project: project.into(),
                priority: priority as i64,
                reason: reason.into(),
                requested_at: now,
                not_before: at.max(now),
                attempts: 0,
            },
        )
    }

    /// A changed `syncRequest` still means "sync everything for local changes".
    pub(crate) fn accept_request(db: &Connection, now: i64) -> Result<bool> {
        let request = db::get(db, "syncRequest")?;
        if !request.is_string() || request == db::get(db, "syncHandledRequest")? {
            return Ok(false);
        }
        Self::enqueue_all(db, Priority::Local, "syncRequest", now)?;
        db::set(db, "syncHandledRequest", &request)?;
        Ok(true)
    }

    /// A job still marked running was cut off by a crash; it runs again now.
    /// Only the one worker claims jobs, and it calls this between jobs.
    pub(crate) fn recover(db: &Connection, now: i64) -> Result<()> {
        let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
        if !db::get(&tx, PROGRESS_CLAIM)?.is_null() {
            Self::clear_progress_scope(&tx)?;
        }
        // A cancelled run must not restart after a crash. A newer request has
        // lowered not_before and is retained independently of that old run.
        sql(tx.execute(
            "DELETE FROM sync_queue WHERE not_before=?1 AND EXISTS(
             SELECT 1 FROM meta claim JOIN meta cancel ON cancel.value=claim.value
             WHERE claim.key='syncClaim:'||project AND cancel.key='syncCancel:'||project)",
            [RUNNING],
        ))?;
        sql(tx.execute(
            "UPDATE sync_queue SET not_before=?1 WHERE not_before=?2",
            params![now, RUNNING],
        ))?;
        sql(tx.execute(
            "DELETE FROM meta WHERE key GLOB 'syncClaim:*' OR key GLOB 'syncCancel:*'",
            [],
        ))?;
        tx.commit().map_err(|e| e.to_string())
    }

    /// Queues, at timer priority, each project whose own interval has passed:
    /// its last success plus the interval plus its stable per-project offset.
    pub(crate) fn enqueue_due(
        &mut self,
        db: &Connection,
        now: i64,
        interval: &Interval,
    ) -> Result<()> {
        let device = db::device(db)?;
        if self.device != device {
            self.synced.clear();
            self.device = device;
        }
        let capture_only = Self::capture_only(db)?;
        for project in Self::targets(db)? {
            // A deleted project only scans its own files, so it checks less often.
            let every = if capture_only.contains(&project) {
                interval.duration() * CAPTURE_INTERVAL_FACTOR
            } else {
                interval.duration()
            };
            let mut base = self
                .synced
                .get(&project)
                .map_or(self.started, |at| at + millis(every));
            if let Some(at) = db::get(db, &cancelled_at_key(&project))?.as_i64() {
                // Cancel skips this timer occurrence without recording a sync
                // success. Fresh local changes and user requests still enqueue.
                base = base.max(at + millis(every));
            }
            if now >= base + millis(jitter(&self.device, &project, every))
                && !Self::queued(db, &project)?
            {
                Self::enqueue(db, &project, Priority::Timer, "timer", now)?;
            }
        }
        Ok(())
    }

    /// Whether the project's running job should stop at its next stage boundary.
    /// Only a cancel naming this exact claim applies, even if the clock changes.
    pub(crate) fn cancelled(db: &Connection, project: &str) -> Result<bool> {
        let claimed = db::get(db, &claim_key(project))?;
        Ok(claimed.is_string() && claimed == db::get(db, &cancel_key(project))?)
    }

    /// Drops the claim and any cancel that reached it: the job is over.
    fn clear(db: &Connection, project: &str) -> Result<()> {
        if db::get(db, PROGRESS_CLAIM)?["project"] == project {
            Self::clear_progress_scope(db)?;
        }
        sql(db.execute(
            "DELETE FROM meta WHERE key=?1 OR key=?2",
            params![claim_key(project), cancel_key(project)],
        ))
    }

    /// Progress belongs to an exact project job, not to whichever row the app
    /// happens to render next. Foreground/legacy cycles explicitly clear this
    /// context, and another process cannot use an abandoned worker's context.
    pub(crate) fn progress_project(db: &Connection) -> Result<Option<String>> {
        let context = db::get(db, PROGRESS_CLAIM)?;
        let Some(project) = context["project"].as_str().filter(|id| *id != WORKSPACE) else {
            return Ok(None);
        };
        Ok((context["owner"] == PROGRESS_OWNER.as_str()
            && context["claim"].is_string()
            && context["claim"] == db::get(db, &claim_key(project))?)
        .then(|| project.to_string()))
    }

    pub(crate) fn clear_progress_scope(db: &Connection) -> Result<()> {
        db::set(db, "syncProgress", &Value::Null)?;
        sql(db.execute("DELETE FROM meta WHERE key=?", [PROGRESS_CLAIM]))
    }

    /// Test hook: marks a project as cancelled when no job is running.
    #[cfg(test)]
    pub(crate) fn mark_cancelled(db: &Connection, project: &str) -> Result<()> {
        let claim = json!(uuid::Uuid::new_v4().to_string());
        db::set(db, &claim_key(project), &claim)?;
        db::set(db, &cancel_key(project), &claim)
    }

    /// Removes the project's queued job, or signals its running job, in
    /// whichever process runs it, to stop at the next stage boundary. The
    /// account-wide `*` steps cannot be cancelled.
    pub(crate) fn cancel(db: &Connection, project: &str) -> Result<()> {
        if project == WORKSPACE {
            return Err("The workspace sync cannot be cancelled".into());
        }
        let tx = rusqlite::Transaction::new_unchecked(db, rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let queued = Self::queued(&tx, project)?;
        // Only a job running now is signalled, so a request after the cancel
        // queues normally. The worker clears the marker when the job settles.
        if Self::running(&tx, project)? {
            db::set(
                &tx,
                &cancel_key(project),
                &db::get(&tx, &claim_key(project))?,
            )?;
            // Discard requests made before Cancel, but retain the active row
            // until its boundary. A later request can lower it again.
            sql(tx.execute(
                "UPDATE sync_queue SET not_before=?1 WHERE project=?2",
                params![RUNNING, project],
            ))?;
        } else {
            sql(tx.execute("DELETE FROM sync_queue WHERE project=?", [project]))?;
            sql(tx.execute("DELETE FROM meta WHERE key=?", [cancel_key(project)]))?;
        }
        if queued {
            db::set(&tx, &cancelled_at_key(project), &json!(Self::now()))?;
        }
        tx.commit().map_err(|e| e.to_string())
    }

    /// One entry per queued project for the app's queue panel, in the order the
    /// worker picks jobs. The account-wide `*` row is internal, so it is left
    /// out. `notBefore` is set while a failed job waits to retry or a newly
    /// connected folder waits for its first sync; a queued job has no time the
    /// user acts on.
    pub(crate) fn states(db: &Connection, now: i64) -> Result<Value> {
        let mut query = db
            // A deleted project's capture job is local bookkeeping, not a sync
            // the user can follow or cancel, so the panel leaves it out.
            .prepare(&format!(
                "SELECT project,reason,attempts,not_before,EXISTS(
                 SELECT 1 FROM meta WHERE key='syncClaim:'||project AND json_type(value)='text'),EXISTS(
                 SELECT 1 FROM meta claim JOIN meta cancel ON cancel.value=claim.value
                 WHERE claim.key='syncClaim:'||project AND cancel.key='syncCancel:'||project
                 AND json_type(claim.value)='text') FROM sync_queue
                 WHERE project<>?1 AND project NOT IN (SELECT id FROM projects WHERE {})
                 ORDER BY priority DESC,requested_at,project",
                crate::projects::CAPTURE_ONLY
            ))
            .map_err(|e| e.to_string())?;
        let jobs = query
            .query_map([WORKSPACE], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, u32>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, bool>(4)?,
                    row.get::<_, bool>(5)?,
                ))
            })
            .and_then(|rows| rows.collect::<rusqlite::Result<Vec<_>>>())
            .map_err(|e| e.to_string())?;
        let states = jobs
            .into_iter()
            .map(
                |(project, reason, attempts, not_before, running, cancel_requested)| {
                    let waiting = !running && attempts > 0 && not_before > now;
                    // A newly connected folder's first sync is held back on purpose.
                    let scheduled = !running && attempts == 0 && not_before > now;
                    let state = if running {
                        "running"
                    } else if waiting {
                        "waiting"
                    } else if scheduled {
                        "scheduled"
                    } else {
                        "queued"
                    };
                    let mut entry = json!({
                        "projectId":project, "state":state, "reason":reason, "attempts":attempts,
                        "notBefore": if waiting || scheduled { iso(not_before) } else { None },
                    });
                    if cancel_requested {
                        entry["cancelRequested"] = json!(true);
                    }
                    entry
                },
            )
            .collect();
        Ok(Value::Array(states))
    }

    fn running(db: &Connection, project: &str) -> Result<bool> {
        Ok(db::get(db, &claim_key(project))?.is_string())
    }

    fn queued(db: &Connection, project: &str) -> Result<bool> {
        db.query_row(
            "SELECT EXISTS(SELECT 1 FROM sync_queue WHERE project=?)",
            [project],
            |row| row.get(0),
        )
        .map_err(|e| e.to_string())
    }

    /// The most urgent job that may run now. The workspace steps go first
    /// among equal priorities, because they refresh the project catalog.
    pub(crate) fn next(db: &Connection, now: i64) -> Result<Option<Job>> {
        db.query_row(
            "SELECT project,priority,reason,requested_at,not_before,attempts FROM sync_queue
             WHERE not_before<=?1 AND not_before<?2
             ORDER BY priority DESC, project<>'*', requested_at, project LIMIT 1",
            params![now, RUNNING],
            |r| {
                Ok(Job {
                    project: r.get(0)?,
                    priority: r.get(1)?,
                    reason: r.get(2)?,
                    requested_at: r.get(3)?,
                    not_before: r.get(4)?,
                    attempts: r.get(5)?,
                })
            },
        )
        .optional()
        .map_err(|e| e.to_string())
    }

    /// Marks the most urgent ready job as running. Its row stays queued until
    /// the job finishes, so a crash leaves it to run again. Its unique claim
    /// identity remains active when a concurrent request lowers not_before.
    fn claim(db: &Connection, now: i64) -> Result<Option<Job>> {
        let tx = rusqlite::Transaction::new_unchecked(db, rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        let job = Self::next(&tx, now)?;
        if let Some(job) = &job {
            let claim = json!(uuid::Uuid::new_v4().to_string());
            sql(tx.execute(
                "UPDATE sync_queue SET not_before=?1 WHERE project=?2",
                params![RUNNING, job.project],
            ))?;
            db::set(&tx, &claim_key(&job.project), &claim)?;
            db::set(&tx, "syncProgress", &Value::Null)?;
            db::set(
                &tx,
                PROGRESS_CLAIM,
                &json!({"project":job.project,"claim":claim,"owner":PROGRESS_OWNER.as_str()}),
            )?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(job)
    }

    /// Success removes the job and restarts the project's timer, a cancel does
    /// the same without the timer, and a skip only removes the claimed job.
    /// A failure backs that project off with jitter, and a yielded job is ready
    /// again as it was. A request that arrived while the job ran stays queued
    /// with its own `not_before`. A service outage holds other network jobs
    /// until the same retry time so it costs one request per step.
    fn settle(
        &mut self,
        db: &Connection,
        job: Job,
        result: &Result<Outcome>,
        now: i64,
        interval: &Interval,
    ) -> Result<()> {
        let project = &job.project;
        let tx = rusqlite::Transaction::new_unchecked(db, rusqlite::TransactionBehavior::Immediate)
            .map_err(|e| e.to_string())?;
        // A cancel that lands after the job's last check still stops it, and it
        // stays recorded until the row is settled in this same transaction.
        let result = if Self::cancelled(&tx, project)? {
            &Ok(Outcome::Cancelled)
        } else {
            result
        };
        // The job is over, so its claim and any cancel for it must not reach a
        // later request.
        Self::clear(&tx, project)?;
        match result {
            Ok(Outcome::Skipped) => sql(tx.execute(
                "DELETE FROM sync_queue WHERE project=?1 AND not_before=?2",
                params![project, RUNNING],
            ))?,
            Ok(Outcome::Synced | Outcome::Cancelled | Outcome::Captured) => {
                sql(tx.execute(
                    "DELETE FROM sync_queue WHERE project=?1 AND not_before=?2",
                    params![project, RUNNING],
                ))?;
                sql(tx.execute(
                    "UPDATE sync_queue SET attempts=0 WHERE project=?",
                    [project],
                ))?;
                // Only the workspace job establishes service-wide recovery.
                if project == WORKSPACE {
                    sql(tx.execute("DELETE FROM meta WHERE key=?", [OUTAGE]))?;
                }
                if matches!(result, Ok(Outcome::Synced | Outcome::Captured)) {
                    sql(tx.execute("DELETE FROM meta WHERE key=?", [cancelled_at_key(project)]))?;
                }
            }
            Ok(Outcome::Yielded) => sql(tx.execute(
                "UPDATE sync_queue SET not_before=min(not_before,?2) WHERE project=?1",
                params![project, job.not_before],
            ))?,
            Ok(Outcome::Deferred) | Err(_) => {
                let attempts = job.attempts + 1;
                let retry = interval.retry(attempts);
                let not_before = now + millis(retry + jitter(&self.device, project, retry));
                sql(tx.execute(
                    "UPDATE sync_queue SET attempts=?2, not_before=min(not_before,?3) WHERE project=?1",
                    params![project, attempts, not_before],
                ))?;
                if result.as_ref().is_err_and(|error| outage(error))
                    && !Self::is_capture_only(&tx, project)?
                {
                    db::set(
                        &tx,
                        OUTAGE,
                        &json!({"notBefore":not_before,"attempts":attempts}),
                    )?;
                    sql(tx.execute(
                        &format!("UPDATE sync_queue SET attempts=max(attempts,?1), not_before=?2
                                  WHERE not_before<?2 AND NOT EXISTS(
                                     SELECT 1 FROM projects WHERE id=sync_queue.project AND {CAPTURE_ONLY}
                                  )"),
                        params![attempts, not_before],
                    ))?;
                }
            }
        }
        tx.commit().map_err(|e| e.to_string())?;
        if matches!(result, Ok(Outcome::Synced | Outcome::Captured)) {
            self.synced.insert(job.project.clone(), now);
        }
        Ok(())
    }

    /// Runs the most urgent ready job under the workspace lock and releases the
    /// lock before returning. Returns false when no job ran: nothing was ready,
    /// foreground work is waiting, or another operation holds the lock.
    pub(crate) async fn run_next(
        &mut self,
        interval: &Interval,
        run: impl AsyncFnOnce(&mut Connection, &Job) -> Result<Outcome>,
    ) -> Result<bool> {
        if crate::projects::foreground_waiting()? {
            return Ok(false);
        }
        let Some(_lock) = crate::projects::try_lock()? else {
            return Ok(false);
        };
        let mut db = db::open()?;
        let Some(job) = Self::claim(&db, Self::now())? else {
            return Ok(false);
        };
        let result = run(&mut db, &job).await;
        self.settle(&db, job, &result, Self::now(), interval)?;
        Ok(true)
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    const MINUTE: i64 = 60_000;

    fn queue_db(projects: &[&str]) -> (tempfile::TempDir, Connection) {
        let root = tempfile::tempdir().unwrap();
        let db = db::open_at(root.path()).unwrap();
        for id in projects {
            db.execute(
                "INSERT INTO projects VALUES(?,?)",
                params![id, json!({"id": id}).to_string()],
            )
            .unwrap();
        }
        (root, db)
    }

    fn rows(db: &Connection) -> Vec<Job> {
        let mut query = db
            .prepare("SELECT * FROM sync_queue ORDER BY project")
            .unwrap();
        query
            .query_map([], |r| {
                Ok(Job {
                    project: r.get(0)?,
                    priority: r.get(1)?,
                    reason: r.get(2)?,
                    requested_at: r.get(3)?,
                    not_before: r.get(4)?,
                    attempts: r.get(5)?,
                })
            })
            .unwrap()
            .collect::<rusqlite::Result<_>>()
            .unwrap()
    }

    fn interval() -> Interval {
        Interval::from_config(&json!({"syncMinutes": 15}))
    }

    #[test]
    fn a_scheduled_first_sync_waits_until_its_time_unless_requested_sooner() {
        let (_root, db) = queue_db(&["a"]);
        let now = SyncQueue::now();
        SyncQueue::request_at(&db, "a", Priority::User, "new folder", now + 3 * MINUTE).unwrap();
        assert!(SyncQueue::claim(&db, now).unwrap().is_none());
        assert_eq!(
            SyncQueue::states(&db, now).unwrap()[0]["state"],
            "scheduled"
        );
        assert!(SyncQueue::claim(&db, now + 3 * MINUTE).unwrap().is_some());

        // A sooner request for the project still runs at its own time.
        let (_root, db) = queue_db(&["a"]);
        SyncQueue::request_at(&db, "a", Priority::User, "new folder", now + 3 * MINUTE).unwrap();
        SyncQueue::enqueue(&db, "a", Priority::Local, "local", now).unwrap();
        assert_eq!(rows(&db)[0].not_before, now);
        // A time in the past never schedules into the past.
        let (_root, db) = queue_db(&["a"]);
        SyncQueue::request_at(&db, "a", Priority::User, "new folder", 0).unwrap();
        assert!(rows(&db)[0].not_before >= now);
    }

    fn save_restorable(db: &Connection, id: &str) {
        db::upsert(
            db,
            "projects",
            id,
            "",
            &json!({"id":id,"deletedAt":"2026-11-01T00:00:00Z","purgeAfter":"2026-12-01T00:00:00Z"}),
        )
        .unwrap();
    }

    #[test]
    fn a_skipped_job_preserves_history_and_requests_arriving_during_the_job() {
        for requested_again in [false, true] {
            let (_root, db) = queue_db(&["a"]);
            let mut queue = SyncQueue::new(0);
            queue.synced.insert("a".into(), 5);
            db::set(&db, &cancelled_at_key("a"), &json!(2)).unwrap();
            let outage = json!({"notBefore":MINUTE,"attempts":3});
            db::set(&db, OUTAGE, &outage).unwrap();
            SyncQueue::enqueue(&db, "a", Priority::User, "remove", 0).unwrap();
            let job = SyncQueue::claim(&db, 0).unwrap().unwrap();
            if requested_again {
                SyncQueue::enqueue(&db, "a", Priority::User, "sync now", 1).unwrap();
            }
            queue
                .settle(&db, job, &Ok(Outcome::Skipped), 10, &interval())
                .unwrap();

            let jobs = rows(&db);
            if requested_again {
                assert_eq!(jobs.len(), 1);
                assert_eq!((jobs[0].not_before, jobs[0].attempts), (1, 3));
            } else {
                assert!(jobs.is_empty());
            }
            assert_eq!(queue.synced.get("a"), Some(&5));
            assert_eq!(db::get(&db, &cancelled_at_key("a")).unwrap(), 2);
            assert_eq!(db::get(&db, OUTAGE).unwrap(), outage);
            assert!(db::get(&db, &claim_key("a")).unwrap().is_null());
            assert!(db::get(&db, &cancel_key("a")).unwrap().is_null());
            assert_eq!(SyncQueue::progress_project(&db).unwrap(), None);
        }
    }

    #[test]
    fn cancellation_pending_is_visible_until_the_claim_settles() {
        let (root, db) = queue_db(&["a"]);
        let app = db::open_at(root.path()).unwrap();
        let mut queue = SyncQueue::new(0);
        SyncQueue::enqueue(&db, "a", Priority::Timer, "timer", 0).unwrap();
        let job = SyncQueue::claim(&db, 0).unwrap().unwrap();
        assert!(SyncQueue::states(&app, 0).unwrap()[0]["cancelRequested"].is_null());
        // A merged request does not hide the claim, including across processes'
        // separate database connections while the current request finishes.
        SyncQueue::enqueue(&app, "a", Priority::Local, "indexer", 1).unwrap();
        SyncQueue::cancel(&app, "a").unwrap();
        let state = SyncQueue::states(&db, 2).unwrap();
        assert_eq!(state[0]["state"], "running");
        assert_eq!(state[0]["cancelRequested"], true);
        // Fresh work is retained, but it does not erase the old run's stopping
        // acknowledgement. It becomes queued only after that run settles.
        SyncQueue::enqueue(&app, "a", Priority::Local, "new change", 2).unwrap();
        assert_eq!(
            SyncQueue::states(&app, 2).unwrap()[0]["cancelRequested"],
            true
        );
        queue
            .settle(&db, job, &Ok(Outcome::Cancelled), 3, &interval())
            .unwrap();
        let state = SyncQueue::states(&app, 3).unwrap();
        assert_eq!(state[0]["state"], "queued");
        assert!(state[0]["cancelRequested"].is_null());
        SyncQueue::claim(&db, 3).unwrap().unwrap();
        assert!(SyncQueue::states(&app, 3).unwrap()[0]["cancelRequested"].is_null());
    }

    #[test]
    fn progress_follows_the_claimed_project_and_never_the_previous_job() {
        let (_root, db) = queue_db(&["a", "b"]);
        let mut queue = SyncQueue::new(0);
        crate::sync::progress(&db, "Foreground discovery", None, 0, None).unwrap();
        assert!(db::get(&db, "syncProgress").unwrap()["projectId"].is_null());
        SyncQueue::enqueue(&db, "a", Priority::Local, "local", 0).unwrap();
        SyncQueue::enqueue(&db, "b", Priority::Local, "local", 1).unwrap();
        for (now, project) in [(0, "a"), (2, "b")] {
            let job = SyncQueue::claim(&db, now).unwrap().unwrap();
            assert_eq!(job.project, project);
            assert!(db::get(&db, "syncProgress").unwrap().is_null());
            crate::sync::progress(&db, "Uploading changes", Some("file"), 2, Some(4)).unwrap();
            let progress = db::get(&db, "syncProgress").unwrap();
            assert_eq!(progress["projectId"], project);
            assert_eq!(progress["completed"], 2);
            queue
                .settle(&db, job, &Ok(Outcome::Synced), now + 1, &interval())
                .unwrap();
            assert!(db::get(&db, "syncProgress").unwrap().is_null());
            assert_eq!(SyncQueue::progress_project(&db).unwrap(), None);
        }
        SyncQueue::enqueue(&db, WORKSPACE, Priority::Local, "workspace", 4).unwrap();
        SyncQueue::claim(&db, 4).unwrap().unwrap();
        crate::sync::progress(&db, "Connecting to sync service", None, 0, None).unwrap();
        assert_eq!(
            db::get(&db, "syncProgress").unwrap(),
            json!({"label":"Connecting to sync service","detail":null,"completed":0,"total":null})
        );
    }

    #[test]
    fn recovery_clears_abandoned_progress_and_retains_post_cancel_requests() {
        let (root, db) = queue_db(&["a"]);
        SyncQueue::enqueue(&db, "a", Priority::Timer, "timer", 0).unwrap();
        SyncQueue::claim(&db, 0).unwrap().unwrap();
        crate::sync::progress(&db, "Uploading changes", None, 0, Some(2)).unwrap();
        let mut context = db::get(&db, PROGRESS_CLAIM).unwrap();
        context["owner"] = json!(uuid::Uuid::new_v4().to_string());
        db::set(&db, PROGRESS_CLAIM, &context).unwrap();
        // Another process's stale context can never tag foreground writes.
        assert_eq!(SyncQueue::progress_project(&db).unwrap(), None);
        SyncQueue::cancel(&db, "a").unwrap();
        SyncQueue::enqueue(&db, "a", Priority::Local, "new change", 1).unwrap();
        drop(db);

        let db = db::open_at(root.path()).unwrap();
        SyncQueue::recover(&db, 2).unwrap();
        assert!(db::get(&db, "syncProgress").unwrap().is_null());
        assert_eq!(SyncQueue::progress_project(&db).unwrap(), None);
        assert_eq!(SyncQueue::states(&db, 2).unwrap()[0]["state"], "queued");
        assert!(SyncQueue::states(&db, 2).unwrap()[0]["cancelRequested"].is_null());
        SyncQueue::claim(&db, 2).unwrap().unwrap();
        crate::sync::progress(&db, "Checking local files", None, 0, None).unwrap();
        assert_eq!(db::get(&db, "syncProgress").unwrap()["projectId"], "a");
    }

    #[tokio::test]
    async fn legacy_workspace_entry_does_not_inherit_an_abandoned_project_scope() {
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("ORKA_TEST_HOME", home.path());
        let db = db::open().unwrap();
        SyncQueue::enqueue(&db, "a", Priority::Timer, "timer", 0).unwrap();
        SyncQueue::claim(&db, 0).unwrap().unwrap();
        crate::sync::progress(&db, "Uploading changes", None, 0, None).unwrap();
        assert_eq!(db::get(&db, "syncProgress").unwrap()["projectId"], "a");
        // Simulate entering the legacy path after that worker died. No sign-in
        // is present: cleanup still happens before the legacy cycle validates it.
        assert_eq!(
            crate::sync::onboarding_once(None).await.unwrap_err(),
            "Sign in required"
        );
        assert!(db::get(&db, "syncProgress").unwrap().is_null());
        assert_eq!(SyncQueue::progress_project(&db).unwrap(), None);
        crate::sync::progress(&db, "Foreground discovery", None, 0, None).unwrap();
        assert!(db::get(&db, "syncProgress").unwrap()["projectId"].is_null());
    }

    #[tokio::test]
    async fn a_legacy_cycle_clears_an_abandoned_queue_progress_scope() {
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("ORKA_TEST_HOME", home.path());
        let db = db::open().unwrap();
        SyncQueue::enqueue(&db, "a", Priority::Local, "local", 0).unwrap();
        SyncQueue::claim(&db, 0).unwrap().unwrap();
        crate::sync::progress(&db, "Uploading changes", None, 0, Some(2)).unwrap();
        assert_eq!(
            SyncQueue::progress_project(&db).unwrap().as_deref(),
            Some("a")
        );
        // A prior worker left its SQLite markers behind. Legacy sync acquires
        // the workspace lock before clearing context, even when login is absent.
        assert_eq!(
            crate::sync::onboarding_once(None).await.unwrap_err(),
            "Sign in required"
        );
        assert_eq!(SyncQueue::progress_project(&db).unwrap(), None);
        assert!(db::get(&db, "syncProgress").unwrap().is_null());
        crate::sync::progress(&db, "Foreground discovery", None, 0, None).unwrap();
        assert!(db::get(&db, "syncProgress").unwrap()["projectId"].is_null());
    }

    #[test]
    fn a_second_request_merges_into_the_queued_job() {
        let (_root, db) = queue_db(&[]);
        let backoff = Job {
            project: "a".into(),
            priority: 0,
            reason: "timer".into(),
            requested_at: 10,
            not_before: 500,
            attempts: 2,
        };
        SyncQueue::merge(&db, &backoff).unwrap();
        SyncQueue::enqueue(&db, "a", Priority::Local, "local", 100).unwrap();
        SyncQueue::enqueue(&db, "a", Priority::Timer, "timer", 300).unwrap();
        let merged = Job {
            priority: 1,
            reason: "local".into(),
            not_before: 100,
            ..backoff
        };
        assert_eq!(rows(&db), [merged]);
    }

    #[test]
    fn jobs_run_by_priority_with_the_workspace_first_among_equals() {
        let (_root, db) = queue_db(&[]);
        SyncQueue::enqueue(&db, "timer", Priority::Timer, "timer", 1).unwrap();
        SyncQueue::enqueue(&db, "local", Priority::Local, "local", 2).unwrap();
        SyncQueue::enqueue(&db, WORKSPACE, Priority::Local, "local", 3).unwrap();
        SyncQueue::enqueue(&db, "user", Priority::User, "user", 4).unwrap();
        let order: Vec<_> = std::iter::from_fn(|| SyncQueue::claim(&db, 10).unwrap())
            .map(|job| job.project)
            .collect();
        assert_eq!(order, ["user", WORKSPACE, "local", "timer"]);
    }

    #[test]
    fn failures_back_off_one_project_with_jitter_until_not_before() {
        let (_root, db) = queue_db(&["a", "b"]);
        let mut queue = SyncQueue::new(0);
        let interval = interval();
        let mut waits = Vec::new();
        for attempt in 1..=2 {
            SyncQueue::enqueue(&db, "b", Priority::Timer, "timer", 0).unwrap();
            if attempt == 1 {
                SyncQueue::enqueue(&db, "a", Priority::Local, "local", 0).unwrap();
            }
            let job = SyncQueue::claim(&db, 0).unwrap().unwrap();
            assert_eq!((job.project.as_str(), job.attempts), ("a", attempt - 1));
            queue
                .settle(&db, job, &Err("offline".into()), 0, &interval)
                .unwrap();
            let failed = rows(&db).into_iter().find(|j| j.project == "a").unwrap();
            assert_eq!(failed.attempts, attempt);
            waits.push(failed.not_before);
            // The failing project waits; the other one still runs.
            let other = SyncQueue::claim(&db, failed.not_before - 1)
                .unwrap()
                .unwrap();
            assert_eq!(other.project, "b");
            queue
                .settle(&db, other, &Ok(Outcome::Synced), 0, &interval)
                .unwrap();
            assert_eq!(SyncQueue::claim(&db, failed.not_before - 1).unwrap(), None);
            let mut retried = SyncQueue::claim(&db, failed.not_before).unwrap().unwrap();
            retried.not_before = 0;
            SyncQueue::merge(&db, &retried).unwrap();
        }
        assert!((30_000..=36_000).contains(&waits[0]), "{waits:?}");
        assert!((60_000..=72_000).contains(&waits[1]), "{waits:?}");
        // A user request bypasses the backoff without resetting the attempts.
        let job = SyncQueue::claim(&db, 0).unwrap().unwrap();
        queue
            .settle(&db, job, &Ok(Outcome::Deferred), 0, &interval)
            .unwrap();
        SyncQueue::enqueue(&db, "a", Priority::User, "sync now", 1).unwrap();
        let job = SyncQueue::claim(&db, 1).unwrap().unwrap();
        assert_eq!((job.priority, job.attempts), (2, 3));
    }

    #[test]
    fn an_outage_holds_every_ready_job_to_the_same_backoff() {
        let (_root, db) = queue_db(&[]);
        let mut queue = SyncQueue::new(0);
        let interval = interval();
        for project in ["a", "b", "c"] {
            SyncQueue::enqueue(&db, project, Priority::Local, "local", 0).unwrap();
        }
        let later = Job {
            project: "d".into(),
            priority: 0,
            reason: "timer".into(),
            requested_at: 0,
            not_before: 10 * MINUTE,
            attempts: 0,
        };
        SyncQueue::merge(&db, &later).unwrap();
        let mut now = 0;
        for (step, error) in [
            (1, "Cloud unavailable; local work stays queued"),
            (2, "503: Service unavailable"),
        ] {
            let job = SyncQueue::claim(&db, now).unwrap().unwrap();
            assert_eq!(job.project, "a");
            queue
                .settle(&db, job, &Err(error.into()), now, &interval)
                .unwrap();
            let jobs = rows(&db);
            let held = &jobs[..3];
            assert!(
                held.iter()
                    .all(|j| j.not_before == held[0].not_before && j.attempts == step),
                "{jobs:?}"
            );
            assert_eq!(SyncQueue::next(&db, held[0].not_before - 1).unwrap(), None);
            // A job already due after the backoff keeps its own time.
            assert_eq!(jobs[3], later);
            now = held[0].not_before;
        }
        assert!((90_000..=108_000).contains(&now), "{now}");
        // A project's own 4xx backs off only that project.
        let job = SyncQueue::claim(&db, now).unwrap().unwrap();
        let forbidden = Err("403: Forbidden".into());
        queue.settle(&db, job, &forbidden, now, &interval).unwrap();
        assert_eq!(SyncQueue::next(&db, now).unwrap().unwrap().project, "b");
    }

    #[test]
    fn capture_can_run_at_each_workspace_outage_retry() {
        let (_root, db) = queue_db(&["active"]);
        save_restorable(&db, "held");
        let mut queue = SyncQueue::new(0);
        let interval = interval();
        let mut now = 0;
        SyncQueue::enqueue_all(&db, Priority::User, "sync now", now).unwrap();
        for attempt in 1..=2 {
            let workspace = SyncQueue::claim(&db, now).unwrap().unwrap();
            assert_eq!(workspace.project, WORKSPACE);
            queue
                .settle(
                    &db,
                    workspace,
                    &Err("503: Service unavailable".into()),
                    now,
                    &interval,
                )
                .unwrap();
            let capture = SyncQueue::claim(&db, now).unwrap().unwrap();
            assert_eq!((capture.project.as_str(), capture.attempts), ("held", 0));
            queue
                .settle(&db, capture, &Ok(Outcome::Captured), now, &interval)
                .unwrap();
            let outage = db::get(&db, OUTAGE).unwrap();
            let held_until = outage["notBefore"].as_i64().unwrap();
            assert_eq!(outage["attempts"], attempt);
            assert!(rows(&db)
                .iter()
                .all(|job| job.not_before == held_until && job.attempts == attempt));
            assert_eq!(SyncQueue::next(&db, held_until - 1).unwrap(), None);
            now = held_until;
            // New automatic work should already be runnable during the outage.
            SyncQueue::enqueue(&db, "held", Priority::Timer, "timer", now - 1).unwrap();
        }
        let workspace = SyncQueue::claim(&db, now).unwrap().unwrap();
        assert_eq!(workspace.project, WORKSPACE);
        queue
            .settle(&db, workspace, &Ok(Outcome::Synced), now, &interval)
            .unwrap();
        assert!(db::get(&db, OUTAGE).unwrap().is_null());
        assert_eq!(
            SyncQueue::next(&db, now).unwrap().unwrap().project,
            "active"
        );
    }

    #[test]
    fn local_capture_requests_ignore_a_service_hold_from_another_connection() {
        let (root, db) = queue_db(&["formerly-active"]);
        let mut queue = SyncQueue::new(0);
        SyncQueue::enqueue_all(&db, Priority::Local, "local", 0).unwrap();
        let workspace = SyncQueue::claim(&db, 0).unwrap().unwrap();
        queue
            .settle(
                &db,
                workspace,
                &Err("503: Service unavailable".into()),
                0,
                &interval(),
            )
            .unwrap();

        let other = db::open_at(root.path()).unwrap();
        save_restorable(&other, "formerly-active");
        save_restorable(&other, "new-capture");
        SyncQueue::enqueue(&other, "formerly-active", Priority::Local, "edit", 1).unwrap();
        SyncQueue::enqueue(&other, "new-capture", Priority::Timer, "timer", 1).unwrap();
        let jobs = rows(&db);
        assert_eq!(
            (jobs[1].project.as_str(), jobs[1].not_before),
            ("formerly-active", 1)
        );
        assert_eq!(
            (
                jobs[2].project.as_str(),
                jobs[2].not_before,
                jobs[2].attempts
            ),
            ("new-capture", 1, 0)
        );
        assert_eq!(
            SyncQueue::next(&db, 1).unwrap().unwrap().project,
            "formerly-active"
        );
    }

    #[test]
    fn capture_failure_retries_only_its_local_job() {
        let (_root, db) = queue_db(&["active"]);
        save_restorable(&db, "held");
        let mut queue = SyncQueue::new(0);
        SyncQueue::enqueue(&db, "held", Priority::User, "sync now", 0).unwrap();
        SyncQueue::enqueue(&db, "active", Priority::Local, "indexer", 0).unwrap();
        let capture = SyncQueue::claim(&db, 0).unwrap().unwrap();
        assert_eq!(capture.project, "held");
        // Even an error string matching the network classifier cannot affect
        // the service schedule when the job performs only local work.
        queue
            .settle(
                &db,
                capture,
                &Err("503: Service unavailable".into()),
                0,
                &interval(),
            )
            .unwrap();
        let jobs = rows(&db);
        assert!(jobs[1].not_before > 0);
        assert_eq!(jobs[1].attempts, 1);
        assert!(db::get(&db, OUTAGE).unwrap().is_null());
        assert_eq!(SyncQueue::next(&db, 0).unwrap().unwrap().project, "active");
    }

    #[test]
    fn outage_holds_new_and_merged_automatic_requests_from_another_connection() {
        let (root, db) = queue_db(&["a", "b"]);
        let mut queue = SyncQueue::new(0);
        let interval = interval();
        SyncQueue::enqueue(&db, "a", Priority::Local, "local", 0).unwrap();
        let job = SyncQueue::claim(&db, 0).unwrap().unwrap();
        queue
            .settle(
                &db,
                job,
                &Err("503: Service unavailable".into()),
                0,
                &interval,
            )
            .unwrap();
        let held_until = rows(&db)[0].not_before;
        let other = db::open_at(root.path()).unwrap();
        SyncQueue::enqueue(&other, "a", Priority::Local, "indexer", 1).unwrap();
        SyncQueue::enqueue(&other, "b", Priority::Local, "share", 2).unwrap();
        assert!(rows(&db)
            .iter()
            .all(|job| job.not_before == held_until && job.attempts == 1));
        assert_eq!(SyncQueue::next(&db, held_until - 1).unwrap(), None);

        // An explicit retry is immediate, but a failing probe advances the
        // shared outage backoff instead of starting over for this new project.
        SyncQueue::enqueue(&other, "b", Priority::User, "sync now", 3).unwrap();
        let job = SyncQueue::claim(&db, 3).unwrap().unwrap();
        assert_eq!((job.project.as_str(), job.attempts), ("b", 1));
        queue
            .settle(
                &db,
                job,
                &Err("503: Service unavailable".into()),
                3,
                &interval,
            )
            .unwrap();
        assert!(rows(&db)
            .iter()
            .all(|job| job.not_before >= 60_003 && job.attempts == 2));
    }

    #[test]
    fn blob_transport_failures_hold_existing_and_new_background_work() {
        for error in ["Blob upload failed; retry retained", "Blob download failed"] {
            let (_root, db) = queue_db(&[]);
            let mut queue = SyncQueue::new(0);
            let interval = interval();
            for project in ["a", "b"] {
                SyncQueue::enqueue(&db, project, Priority::Local, "local", 0).unwrap();
            }
            let job = SyncQueue::claim(&db, 0).unwrap().unwrap();
            queue
                .settle(&db, job, &Err(error.into()), 0, &interval)
                .unwrap();
            let held_until = rows(&db)[0].not_before;
            SyncQueue::enqueue(&db, "c", Priority::Local, "indexer", 1).unwrap();
            let jobs = rows(&db);
            assert_eq!(jobs.len(), 3);
            assert!(
                jobs.iter()
                    .all(|job| job.not_before == held_until && job.attempts == 1),
                "{error}: {jobs:?}"
            );
            assert_eq!(SyncQueue::next(&db, held_until - 1).unwrap(), None);
        }
    }

    #[test]
    fn authentication_and_rate_limit_failures_keep_per_project_backoff() {
        for error in ["401: Sign in required", "429: Rate limited"] {
            let (_root, db) = queue_db(&[]);
            let mut queue = SyncQueue::new(0);
            let interval = interval();
            for project in ["a", "b"] {
                SyncQueue::enqueue(&db, project, Priority::Local, "local", 0).unwrap();
            }
            let job = SyncQueue::claim(&db, 0).unwrap().unwrap();
            queue
                .settle(&db, job, &Err(error.into()), 0, &interval)
                .unwrap();
            SyncQueue::enqueue(&db, "c", Priority::Local, "indexer", 1).unwrap();
            assert!(db::get(&db, OUTAGE).unwrap().is_null(), "{error}");
            let jobs = rows(&db);
            assert!(jobs[0].not_before >= 30_000, "{error}: {jobs:?}");
            assert_eq!((jobs[1].not_before, jobs[2].not_before), (0, 1));
            assert_eq!(SyncQueue::next(&db, 0).unwrap().unwrap().project, "b");
        }
    }

    #[test]
    fn outage_holds_newly_due_timers_and_survives_a_worker_restart() {
        let (root, db) = queue_db(&["a", "b"]);
        let mut queue = SyncQueue::new(-20 * MINUTE);
        let interval = interval();
        SyncQueue::enqueue(&db, "a", Priority::Local, "local", 0).unwrap();
        let job = SyncQueue::claim(&db, 0).unwrap().unwrap();
        queue
            .settle(
                &db,
                job,
                &Err("Cloud unavailable; local work stays queued".into()),
                0,
                &interval,
            )
            .unwrap();
        let held_until = rows(&db)[0].not_before;
        queue.enqueue_due(&db, 1, &interval).unwrap();
        assert_eq!(rows(&db).len(), 3, "workspace and both projects are queued");
        assert_eq!(SyncQueue::next(&db, held_until - 1).unwrap(), None);
        drop(db);

        let db = db::open_at(root.path()).unwrap();
        SyncQueue::recover(&db, 2).unwrap();
        SyncQueue::enqueue(&db, "new-project", Priority::Local, "indexer", 2).unwrap();
        assert!(rows(&db)
            .iter()
            .all(|job| job.not_before == held_until && job.attempts == 1));
        assert_eq!(SyncQueue::next(&db, held_until - 1).unwrap(), None);
        assert!(SyncQueue::next(&db, held_until).unwrap().is_some());
    }

    #[test]
    fn a_successful_workspace_probe_clears_the_service_hold() {
        let (_root, db) = queue_db(&[]);
        let mut queue = SyncQueue::new(0);
        let interval = interval();
        SyncQueue::enqueue(&db, "a", Priority::Local, "local", 0).unwrap();
        let job = SyncQueue::claim(&db, 0).unwrap().unwrap();
        queue
            .settle(
                &db,
                job,
                &Err("503: Service unavailable".into()),
                0,
                &interval,
            )
            .unwrap();
        SyncQueue::enqueue(&db, WORKSPACE, Priority::User, "sync now", 1).unwrap();
        let job = SyncQueue::claim(&db, 1).unwrap().unwrap();
        queue
            .settle(&db, job, &Ok(Outcome::Synced), 2, &interval)
            .unwrap();
        assert!(db::get(&db, OUTAGE).unwrap().is_null());
        SyncQueue::enqueue(&db, "b", Priority::Local, "indexer", 3).unwrap();
        let job = SyncQueue::next(&db, 3).unwrap().unwrap();
        assert_eq!((job.project.as_str(), job.attempts), ("b", 0));
    }

    #[test]
    fn a_running_job_stays_queued_until_it_finishes() {
        let (_root, db) = queue_db(&[]);
        let mut queue = SyncQueue::new(0);
        let interval = interval();
        SyncQueue::enqueue(&db, "a", Priority::Timer, "timer", 0).unwrap();
        let job = SyncQueue::claim(&db, 0).unwrap().unwrap();
        // The worker crashes mid-job: the row is still there, then runs again.
        assert_eq!(rows(&db).len(), 1);
        assert_eq!(SyncQueue::next(&db, i64::MAX - 1).unwrap(), None);
        SyncQueue::recover(&db, 5).unwrap();
        let rerun = SyncQueue::claim(&db, 5).unwrap().unwrap();
        assert_eq!((rerun.project.as_str(), rerun.not_before), ("a", 5));
        queue
            .settle(&db, rerun, &Ok(Outcome::Synced), 6, &interval)
            .unwrap();
        assert!(rows(&db).is_empty());

        // A request that arrives while the job runs is kept, even if it fails.
        SyncQueue::merge(&db, &Job { attempts: 2, ..job }).unwrap();
        for result in [Ok(Outcome::Synced), Err("offline".into())] {
            let running = SyncQueue::claim(&db, 10).unwrap().unwrap();
            SyncQueue::enqueue(&db, "a", Priority::User, "sync now", 7).unwrap();
            queue.settle(&db, running, &result, 8, &interval).unwrap();
            let kept = rows(&db);
            assert_eq!(kept.len(), 1);
            assert_eq!((kept[0].priority, kept[0].not_before), (2, 7));
        }
        let attempts: Vec<_> = rows(&db).iter().map(|j| j.attempts).collect();
        assert_eq!(attempts, [1]);
    }

    #[test]
    fn timer_queues_each_project_after_its_own_interval_and_offset() {
        let (_root, db) = queue_db(&["a"]);
        let interval = interval();
        let device = db::device(&db).unwrap();
        let offset = |id| millis(jitter(&device, id, interval.duration()));
        let mut queue = SyncQueue::new(0);
        queue.enqueue_due(&db, offset("a") - 1, &interval).unwrap();
        assert!(rows(&db).iter().all(|job| job.project != "a"));
        queue.enqueue_due(&db, offset("a"), &interval).unwrap();
        let job = rows(&db)
            .into_iter()
            .find(|job| job.project == "a")
            .unwrap();
        assert_eq!(job.priority, 0);
        while SyncQueue::claim(&db, i64::MAX).unwrap().is_some() {}
        let done = 1_000;
        queue
            .settle(&db, job, &Ok(Outcome::Synced), done, &interval)
            .unwrap();
        let due = done + 15 * MINUTE + offset("a");
        queue.enqueue_due(&db, due - 1, &interval).unwrap();
        assert!(rows(&db).iter().all(|job| job.project != "a"));
        queue.enqueue_due(&db, due, &interval).unwrap();
        assert!(rows(&db).iter().any(|job| job.project == "a"));
    }

    #[test]
    fn a_deleted_restorable_project_captures_on_a_slower_timer() {
        let (_root, db) = queue_db(&["a"]);
        db.execute(
            "INSERT INTO projects VALUES('held',?)",
            [json!({"id":"held","deletedAt":"2026-11-01T00:00:00Z","purgeAfter":"2026-12-01T00:00:00Z"}).to_string()],
        )
        .unwrap();
        let interval = interval();
        let device = db::device(&db).unwrap();
        let slow = interval.duration() * CAPTURE_INTERVAL_FACTOR;
        let due = |id, every| millis(every) + millis(jitter(&device, id, every));
        let mut queue = SyncQueue::new(0);
        // The first timer pass binds the device, which resets the schedule.
        queue.enqueue_due(&db, -1, &interval).unwrap();
        for project in ["a", "held"] {
            let job = Job {
                project: project.into(),
                priority: 0,
                reason: "timer".into(),
                requested_at: 0,
                not_before: 0,
                attempts: 0,
            };
            queue
                .settle(&db, job, &Ok(Outcome::Synced), 0, &interval)
                .unwrap();
        }
        queue
            .enqueue_due(&db, due("a", interval.duration()), &interval)
            .unwrap();
        assert!(rows(&db).iter().any(|job| job.project == "a"));
        queue
            .enqueue_due(&db, due("held", slow) - 1, &interval)
            .unwrap();
        assert!(rows(&db).iter().all(|job| job.project != "held"));
        queue
            .enqueue_due(&db, due("held", slow), &interval)
            .unwrap();
        assert!(rows(&db).iter().any(|job| job.project == "held"));
    }

    #[test]
    fn a_project_request_queues_only_that_project() {
        let (_root, db) = queue_db(&["a", "b"]);
        SyncQueue::request(&db, "a", Priority::User, "sync now").unwrap();
        let jobs = rows(&db);
        assert_eq!(jobs.len(), 1);
        assert_eq!(
            (
                jobs[0].project.as_str(),
                jobs[0].priority,
                jobs[0].reason.as_str()
            ),
            ("a", 2, "sync now")
        );
        assert!(db::get(&db, "syncRequest").unwrap().is_null());
    }

    #[test]
    fn sync_now_queues_the_workspace_and_every_project_at_user_priority() {
        let (_root, db) = queue_db(&["a", "b"]);
        SyncQueue::request_all(&db, Priority::User, "sync now").unwrap();
        let jobs = rows(&db);
        let projects: Vec<_> = jobs.iter().map(|job| job.project.as_str()).collect();
        assert_eq!(projects, [WORKSPACE, "a", "b"]);
        assert!(jobs
            .iter()
            .all(|job| job.priority == 2 && job.reason == "sync now"));
        assert!(jobs.iter().all(|job| job.not_before == job.requested_at));
    }

    #[test]
    fn a_sync_request_queues_every_project_once() {
        let (_root, db) = queue_db(&["a", "b"]);
        db.execute(
            "INSERT INTO projects VALUES('gone',json('{\"archivedAt\":\"2026-01-01\"}'))",
            [],
        )
        .unwrap();
        assert!(!SyncQueue::accept_request(&db, 0).unwrap());
        db::set(&db, "syncRequest", &json!("first")).unwrap();
        assert!(SyncQueue::accept_request(&db, 5).unwrap());
        assert_eq!(db::get(&db, "syncHandledRequest").unwrap(), "first");
        assert!(!SyncQueue::accept_request(&db, 6).unwrap());
        let jobs = rows(&db);
        let projects: Vec<_> = jobs.iter().map(|job| job.project.as_str()).collect();
        assert_eq!(projects, [WORKSPACE, "a", "b"]);
        assert!(jobs
            .iter()
            .all(|job| job.priority == 1 && job.not_before == 5));
    }

    #[test]
    fn cancelling_a_queued_job_removes_it_and_a_later_request_queues() {
        let (_root, db) = queue_db(&["a", "b"]);
        SyncQueue::enqueue(&db, "a", Priority::Timer, "timer", 0).unwrap();
        SyncQueue::enqueue(&db, "b", Priority::Timer, "timer", 0).unwrap();
        SyncQueue::cancel(&db, "a").unwrap();
        let jobs = rows(&db);
        assert_eq!(jobs.len(), 1, "{jobs:?}");
        assert_eq!(jobs[0].project, "b");
        // A queued cancel leaves no marker behind for the next job.
        assert!(db::get(&db, &cancel_key("a")).unwrap().is_null());
        assert!(!SyncQueue::cancelled(&db, "a").unwrap());
        SyncQueue::request(&db, "a", Priority::User, "sync now").unwrap();
        let job = SyncQueue::claim(&db, i64::MAX - 1).unwrap().unwrap();
        assert_eq!((job.project.as_str(), job.attempts), ("a", 0));
    }

    #[tokio::test]
    async fn a_cancel_stops_the_running_job_without_backoff_or_a_sync_success() {
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("ORKA_TEST_HOME", home.path());
        let db = db::open().unwrap();
        db.execute(
            "INSERT INTO projects VALUES(?,?)",
            params!["a", json!({"id":"a"}).to_string()],
        )
        .unwrap();
        let mut queue = SyncQueue::new(0);
        let interval = interval();
        // A previous failure left attempts and a backoff on the project.
        let failed = Job {
            project: "a".into(),
            priority: 0,
            reason: "timer".into(),
            requested_at: 0,
            not_before: 0,
            attempts: 2,
        };
        SyncQueue::merge(&db, &failed).unwrap();
        let ran = queue
            .run_next(&interval, async |db, job| {
                assert_eq!((job.project.as_str(), job.attempts), ("a", 2));
                SyncQueue::cancel(db, "a").unwrap();
                // The next stage boundary stops it; the job was not resynced.
                assert!(SyncQueue::cancelled(db, "a").unwrap());
                Ok(Outcome::Cancelled)
            })
            .await;
        assert!(ran.unwrap());
        assert!(rows(&db).is_empty());
        // Settling drops the claim and the cancel for it.
        assert!(db::get(&db, &claim_key("a")).unwrap().is_null());
        assert!(!SyncQueue::cancelled(&db, "a").unwrap());
        // No backoff is waiting and no success was recorded. The cancelled
        // timer occurrence is skipped until the next automatic interval.
        assert_eq!(SyncQueue::next(&db, i64::MAX - 1).unwrap(), None);
        assert!(!queue.synced.contains_key("a"));
        let offset = millis(jitter(&db::device(&db).unwrap(), "a", interval.duration()));
        let at = db::get(&db, &cancelled_at_key("a"))
            .unwrap()
            .as_i64()
            .unwrap();
        let next = at + millis(interval.duration()) + offset;
        let due = |db: &Connection| rows(db).iter().any(|job| job.project == "a");
        queue.enqueue_due(&db, next - 1, &interval).unwrap();
        assert!(!due(&db));
        queue.enqueue_due(&db, next, &interval).unwrap();
        assert!(due(&db));
    }

    #[test]
    fn a_request_after_a_cancel_queues_normally() {
        let (_root, db) = queue_db(&["a"]);
        let mut queue = SyncQueue::new(0);
        let interval = interval();
        SyncQueue::enqueue(&db, "a", Priority::Timer, "timer", 0).unwrap();
        let job = SyncQueue::claim(&db, 0).unwrap().unwrap();
        SyncQueue::cancel(&db, "a").unwrap();
        queue
            .settle(&db, job, &Ok(Outcome::Cancelled), 10, &interval)
            .unwrap();
        assert!(!SyncQueue::cancelled(&db, "a").unwrap());
        SyncQueue::request(&db, "a", Priority::User, "sync now").unwrap();
        let queued = SyncQueue::claim(&db, i64::MAX - 1).unwrap().unwrap();
        assert_eq!((queued.project.as_str(), queued.attempts), ("a", 0));
        assert!(SyncQueue::next(&db, i64::MAX - 1).unwrap().is_none());
    }

    #[test]
    fn queue_state_reports_each_project_and_leaves_out_the_workspace() {
        let (_root, db) = queue_db(&["running", "queued", "waiting", "due"]);
        SyncQueue::enqueue(&db, "running", Priority::Timer, "timer", 0).unwrap();
        SyncQueue::claim(&db, 0).unwrap();
        SyncQueue::enqueue(&db, "queued", Priority::Local, "local", 1).unwrap();
        let failed = |project: &str, not_before, requested_at| Job {
            project: project.into(),
            priority: 0,
            reason: "timer".into(),
            requested_at,
            not_before,
            attempts: 2,
        };
        SyncQueue::merge(&db, &failed("waiting", 5_000, 2)).unwrap();
        // Past its backoff, so it is queued again rather than waiting.
        SyncQueue::merge(&db, &failed("due", 500, 3)).unwrap();
        SyncQueue::enqueue(&db, WORKSPACE, Priority::User, "sync now", 4).unwrap();
        assert_eq!(
            SyncQueue::states(&db, 1_000).unwrap(),
            json!([
                {"projectId":"queued","state":"queued","reason":"local","attempts":0,"notBefore":null},
                {"projectId":"running","state":"running","reason":"timer","attempts":0,"notBefore":null},
                {"projectId":"waiting","state":"waiting","reason":"timer","attempts":2,"notBefore":"1970-01-01T00:00:05.000Z"},
                {"projectId":"due","state":"queued","reason":"timer","attempts":2,"notBefore":null},
            ])
        );
    }

    #[test]
    fn a_merged_request_stays_visible_as_running_until_the_claim_settles() {
        let (_root, db) = queue_db(&["a"]);
        let mut queue = SyncQueue::new(0);
        SyncQueue::enqueue(&db, "a", Priority::Timer, "timer", 0).unwrap();
        let job = SyncQueue::claim(&db, 0).unwrap().unwrap();
        SyncQueue::enqueue(&db, "a", Priority::Local, "indexer", 1).unwrap();
        assert_eq!(SyncQueue::states(&db, 2).unwrap()[0]["state"], "running");
        SyncQueue::cancel(&db, "a").unwrap();
        SyncQueue::enqueue(&db, "a", Priority::Local, "new change", 3).unwrap();
        assert_eq!(SyncQueue::states(&db, 3).unwrap()[0]["state"], "running");
        queue
            .settle(&db, job, &Ok(Outcome::Cancelled), 4, &interval())
            .unwrap();
        assert_eq!(SyncQueue::states(&db, 4).unwrap()[0]["state"], "queued");
    }

    #[test]
    fn queue_state_keeps_a_merged_running_job_visible_until_its_boundary() {
        let (_root, db) = queue_db(&["a"]);
        SyncQueue::enqueue(&db, "a", Priority::Timer, "timer", 0).unwrap();
        SyncQueue::claim(&db, 0).unwrap().unwrap();
        SyncQueue::enqueue(&db, "a", Priority::Local, "indexer", 1).unwrap();
        assert_eq!(SyncQueue::states(&db, 2).unwrap()[0]["state"], "running");
        SyncQueue::cancel(&db, "a").unwrap();
        let state = SyncQueue::states(&db, 2).unwrap();
        assert_eq!(state[0]["state"], "running");
        assert!(state[0]["notBefore"].is_null());
    }

    #[test]
    fn the_workspace_job_cannot_be_cancelled() {
        let (_root, db) = queue_db(&["a"]);
        SyncQueue::request_all(&db, Priority::User, "sync now").unwrap();
        let error = SyncQueue::cancel(&db, WORKSPACE).unwrap_err();
        assert!(error.contains("cannot be cancelled"), "{error}");
        assert_eq!(rows(&db).len(), 2);
        assert!(!SyncQueue::cancelled(&db, WORKSPACE).unwrap());
    }

    #[tokio::test]
    async fn a_cancel_from_another_connection_stops_the_running_job() {
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("ORKA_TEST_HOME", home.path());
        let db = db::open().unwrap();
        db.execute(
            "INSERT INTO projects VALUES(?,?)",
            params!["a", json!({"id":"a"}).to_string()],
        )
        .unwrap();
        // The background agent holds this job; the app presses Cancel through
        // its own connection to the same database.
        let other = db::open().unwrap();
        let mut queue = SyncQueue::new(0);
        let interval = interval();
        let failed = Job {
            project: "a".into(),
            priority: 0,
            reason: "timer".into(),
            requested_at: 0,
            not_before: 0,
            attempts: 2,
        };
        SyncQueue::merge(&db, &failed).unwrap();
        let ran = queue
            .run_next(&interval, async |db, job| {
                assert_eq!(job.project, "a");
                SyncQueue::cancel(&other, "a").unwrap();
                assert!(SyncQueue::cancelled(db, "a").unwrap());
                Ok(Outcome::Cancelled)
            })
            .await;
        assert!(ran.unwrap());
        assert!(rows(&db).iter().all(|job| job.project != "a"));
        assert!(!SyncQueue::cancelled(&db, "a").unwrap());
    }

    #[test]
    fn a_cancel_for_another_claim_does_not_stop_a_later_job() {
        let (_root, db) = queue_db(&["a"]);
        // A marker left behind by an earlier job.
        db::set(&db, &cancel_key("a"), &json!("previous-claim")).unwrap();
        SyncQueue::enqueue(&db, "a", Priority::Timer, "timer", 0).unwrap();
        SyncQueue::claim(&db, 200).unwrap().unwrap();
        assert!(!SyncQueue::cancelled(&db, "a").unwrap());
        // Matching the current claim stops it without comparing wall clocks.
        db::set(
            &db,
            &cancel_key("a"),
            &db::get(&db, &claim_key("a")).unwrap(),
        )
        .unwrap();
        assert!(SyncQueue::cancelled(&db, "a").unwrap());
        SyncQueue::cancel(&db, "a").unwrap();
        assert!(SyncQueue::cancelled(&db, "a").unwrap());
    }

    #[test]
    fn a_merged_request_keeps_its_running_claim_and_can_be_cancelled() {
        let (root, db) = queue_db(&["a"]);
        let app = db::open_at(root.path()).unwrap();
        let mut queue = SyncQueue::new(0);
        SyncQueue::enqueue(&db, "a", Priority::Timer, "timer", 0).unwrap();
        let job = SyncQueue::claim(&db, 0).unwrap().unwrap();
        let claim = db::get(&db, &claim_key("a")).unwrap();
        SyncQueue::enqueue(&app, "a", Priority::Local, "indexer", 1).unwrap();
        assert!(SyncQueue::running(&db, "a").unwrap());
        assert_eq!(db::get(&db, &claim_key("a")).unwrap(), claim);
        SyncQueue::cancel(&app, "a").unwrap();
        assert!(SyncQueue::cancelled(&db, "a").unwrap());
        assert_eq!(SyncQueue::next(&db, i64::MAX - 1).unwrap(), None);
        queue
            .settle(&db, job, &Ok(Outcome::Cancelled), 2, &interval())
            .unwrap();
        assert!(rows(&db).is_empty());
    }

    #[test]
    fn a_request_after_cancel_survives_the_cancelled_running_job() {
        let (_root, db) = queue_db(&["a"]);
        let mut queue = SyncQueue::new(0);
        SyncQueue::enqueue(&db, "a", Priority::Timer, "timer", 0).unwrap();
        let job = SyncQueue::claim(&db, 0).unwrap().unwrap();
        SyncQueue::cancel(&db, "a").unwrap();
        SyncQueue::enqueue(&db, "a", Priority::Local, "new change", 1).unwrap();
        assert!(SyncQueue::cancelled(&db, "a").unwrap());
        queue
            .settle(&db, job, &Ok(Outcome::Cancelled), 2, &interval())
            .unwrap();
        let next = SyncQueue::claim(&db, 2).unwrap().unwrap();
        assert_eq!(next.project, "a");
        assert!(!SyncQueue::cancelled(&db, "a").unwrap());
    }

    #[test]
    fn cancelled_timers_stay_skipped_after_a_worker_restart() {
        let (_root, db) = queue_db(&["a"]);
        let now = SyncQueue::now();
        let interval = interval();
        SyncQueue::enqueue(&db, "a", Priority::Timer, "timer", now).unwrap();
        SyncQueue::cancel(&db, "a").unwrap();
        let at = db::get(&db, &cancelled_at_key("a"))
            .unwrap()
            .as_i64()
            .unwrap();
        let mut restarted = SyncQueue::new(now - 20 * MINUTE);
        restarted.enqueue_due(&db, at + 1, &interval).unwrap();
        assert!(!SyncQueue::queued(&db, "a").unwrap());
        assert!(!restarted.synced.contains_key("a"));
        let due = at
            + millis(interval.duration())
            + millis(jitter(&db::device(&db).unwrap(), "a", interval.duration()));
        restarted.enqueue_due(&db, due, &interval).unwrap();
        assert!(SyncQueue::queued(&db, "a").unwrap());
    }

    #[test]
    fn recovery_retains_new_requests_but_does_not_revive_a_cancelled_run() {
        let (_root, db) = queue_db(&["a", "b"]);
        for project in ["a", "b"] {
            SyncQueue::enqueue(&db, project, Priority::Timer, "timer", 0).unwrap();
            assert_eq!(SyncQueue::claim(&db, 0).unwrap().unwrap().project, project);
            SyncQueue::cancel(&db, project).unwrap();
        }
        SyncQueue::enqueue(&db, "b", Priority::Local, "new change", 1).unwrap();
        SyncQueue::recover(&db, 2).unwrap();
        assert!(!SyncQueue::queued(&db, "a").unwrap());
        assert_eq!(SyncQueue::next(&db, 2).unwrap().unwrap().project, "b");
        assert!(!SyncQueue::running(&db, "a").unwrap());
        assert!(!SyncQueue::running(&db, "b").unwrap());
        assert!(!SyncQueue::cancelled(&db, "b").unwrap());
    }

    #[tokio::test]
    async fn a_cancel_after_the_last_check_still_stops_the_job() {
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("ORKA_TEST_HOME", home.path());
        let db = db::open().unwrap();
        let mut queue = SyncQueue::new(0);
        let interval = interval();
        // The job found no cancel at its last check, so it returns its own
        // result; Cancel lands before the worker settles it.
        for result in [
            Ok(Outcome::Deferred),
            Ok(Outcome::Yielded),
            Err("Cloud unavailable; local work stays queued".to_string()),
        ] {
            SyncQueue::enqueue(&db, "a", Priority::Timer, "timer", 0).unwrap();
            let ran = queue
                .run_next(&interval, async |db, _| {
                    SyncQueue::cancel(db, "a").unwrap();
                    result
                })
                .await;
            assert!(ran.unwrap());
            assert!(rows(&db).is_empty());
            assert_eq!(SyncQueue::next(&db, i64::MAX - 1).unwrap(), None);
            assert!(db::get(&db, OUTAGE).unwrap().is_null());
        }
    }

    #[test]
    fn a_cancelled_job_stays_cancelled_when_settling_fails() {
        let (_root, db) = queue_db(&["a"]);
        let mut queue = SyncQueue::new(0);
        SyncQueue::enqueue(&db, "a", Priority::Timer, "timer", 0).unwrap();
        let job = SyncQueue::claim(&db, 0).unwrap().unwrap();
        SyncQueue::cancel(&db, "a").unwrap();
        // Removing the row fails, as if the process died before that write.
        db.execute_batch(
            "CREATE TEMP TRIGGER fail BEFORE DELETE ON sync_queue
             BEGIN SELECT RAISE(ABORT, 'disk I/O error'); END",
        )
        .unwrap();
        assert!(queue
            .settle(&db, job, &Ok(Outcome::Cancelled), 1, &interval())
            .is_err());
        db.execute_batch("DROP TRIGGER fail").unwrap();
        // The next start still finds the cancel, so the job does not run again.
        SyncQueue::recover(&db, 2).unwrap();
        assert!(rows(&db).is_empty());
        assert_eq!(SyncQueue::next(&db, 2).unwrap(), None);
    }

    #[tokio::test]
    async fn foreground_work_takes_the_lock_between_jobs() {
        let home = tempfile::tempdir().unwrap();
        std::env::set_var("ORKA_TEST_HOME", home.path());
        let db = db::open().unwrap();
        for project in ["a", "b"] {
            SyncQueue::enqueue(&db, project, Priority::Local, "local", 0).unwrap();
        }
        let mut queue = SyncQueue::new(0);
        let interval = interval();
        let held = crate::projects::try_lock().unwrap().unwrap();
        let busy = queue.run_next(&interval, async |_, _| unreachable!()).await;
        assert!(!busy.unwrap());
        drop(held);

        let (start, started) = std::sync::mpsc::channel::<()>();
        let (release, released) = std::sync::mpsc::channel::<()>();
        let foreground = std::thread::spawn(move || {
            started.recv().unwrap();
            let lock = crate::projects::wait_for_lock(Duration::from_secs(5));
            released.recv().unwrap();
            lock.map(drop)
        });
        let ran = queue
            .run_next(&interval, async |_, job| {
                assert_eq!(job.project, "a");
                assert!(crate::projects::try_lock().unwrap().is_none());
                start.send(()).unwrap();
                while !crate::projects::foreground_waiting().unwrap() {
                    std::thread::sleep(Duration::from_millis(5));
                }
                Ok(Outcome::Synced)
            })
            .await;
        assert!(ran.unwrap());
        // The foreground operation gets the lock before job "b" starts.
        let waiting = queue.run_next(&interval, async |_, _| unreachable!()).await;
        assert!(!waiting.unwrap());
        assert_eq!(
            SyncQueue::next(&db, i64::MAX).unwrap().unwrap().project,
            "b"
        );
        release.send(()).unwrap();
        foreground.join().unwrap().unwrap();
        let ran = queue
            .run_next(&interval, async |_, job| {
                assert_eq!(job.project, "b");
                Ok(Outcome::Synced)
            })
            .await;
        assert!(ran.unwrap());
        assert_eq!(SyncQueue::next(&db, i64::MAX).unwrap(), None);
    }
}
