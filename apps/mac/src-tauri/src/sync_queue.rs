//! The background sync queue: at most one pending job per project, plus a `*`
//! job for the workspace-wide steps. One worker runs one job at a time and
//! holds the workspace lock only for that job, so foreground work can take the
//! lock between jobs instead of waiting for a whole cycle.
use crate::{
    db::{self, Result},
    sync_schedule::{jitter, Interval},
};
use rusqlite::{params, Connection, OptionalExtension};
use std::{collections::HashMap, time::Duration};

pub(crate) const WORKSPACE: &str = "*";

#[derive(Clone, Copy)]
pub(crate) enum Priority {
    Timer = 0,
    Local = 1,
    #[cfg_attr(
        not(test),
        expect(dead_code, reason = "Sync now, retry and governance request it next")
    )]
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

pub(crate) enum Outcome {
    Synced,
    /// Finished with item errors or deferred uploads; retried with backoff.
    Deferred,
    /// Stopped early for foreground work; queued again as it was.
    Yielded,
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
    /// priority and the earlier `not_before` win, so a request never delays a job.
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
            "INSERT INTO sync_queue VALUES(?1,?2,?3,?4,?5,?6) ON CONFLICT(project) DO UPDATE SET
             reason=CASE WHEN excluded.priority>priority THEN excluded.reason ELSE reason END,
             priority=max(priority,excluded.priority),
             requested_at=min(requested_at,excluded.requested_at),
             not_before=min(not_before,excluded.not_before),
             attempts=max(attempts,excluded.attempts)",
            params![
                job.project,
                job.priority,
                job.reason,
                job.requested_at,
                job.not_before,
                job.attempts
            ],
        )
        .map(|_| ())
        .map_err(|e| e.to_string())
    }

    fn targets(db: &Connection) -> Result<Vec<String>> {
        let sql = format!("SELECT id FROM projects WHERE {}", crate::projects::ACTIVE);
        let mut query = db.prepare(&sql).map_err(|e| e.to_string())?;
        let ids = query
            .query_map([], |row| row.get(0))
            .and_then(|rows| rows.collect::<rusqlite::Result<Vec<String>>>())
            .map_err(|e| e.to_string())?;
        Ok(std::iter::once(WORKSPACE.to_string()).chain(ids).collect())
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
        let every = interval.duration();
        for project in Self::targets(db)? {
            let base = self
                .synced
                .get(&project)
                .map_or(self.started, |at| at + millis(every));
            if now >= base + millis(jitter(&self.device, &project, every))
                && !Self::queued(db, &project)?
            {
                Self::enqueue(db, &project, Priority::Timer, "timer", now)?;
            }
        }
        Ok(())
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
             WHERE not_before<=? ORDER BY priority DESC, project<>'*', requested_at, project LIMIT 1",
            [now],
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

    fn claim(db: &Connection, now: i64) -> Result<Option<Job>> {
        let tx = db.unchecked_transaction().map_err(|e| e.to_string())?;
        let job = Self::next(&tx, now)?;
        if let Some(job) = &job {
            tx.execute("DELETE FROM sync_queue WHERE project=?", [&job.project])
                .map_err(|e| e.to_string())?;
        }
        tx.commit().map_err(|e| e.to_string())?;
        Ok(job)
    }

    /// Success restarts the project's timer, a failure backs only that project
    /// off with jitter, and a yielded job goes back unchanged. A request that
    /// arrived while the job ran stays queued.
    fn settle(
        &mut self,
        db: &Connection,
        job: Job,
        result: &Result<Outcome>,
        now: i64,
        interval: &Interval,
    ) -> Result<()> {
        match result {
            Ok(Outcome::Synced) => {
                self.synced.insert(job.project, now);
                Ok(())
            }
            Ok(Outcome::Yielded) => Self::merge(db, &job),
            Ok(Outcome::Deferred) | Err(_) => {
                let attempts = job.attempts + 1;
                let retry = interval.retry(attempts);
                let wait = retry + jitter(&self.device, &job.project, retry);
                let not_before = now + millis(wait);
                Self::merge(
                    db,
                    &Job {
                        attempts,
                        not_before,
                        ..job
                    },
                )
            }
        }
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
        let mut jobs = Vec::new();
        while let Some(job) = SyncQueue::claim(db, i64::MAX).unwrap() {
            jobs.push(job);
        }
        for job in &jobs {
            SyncQueue::merge(db, job).unwrap();
        }
        jobs
    }

    fn interval() -> Interval {
        Interval::from_config(&json!({"syncMinutes": 15}))
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
