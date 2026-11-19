package server

import (
	"context"
	"log"
	"time"
)

const projectPurgeBatch = 32
const projectTombstoneExpiryBatch = 1000
const projectTombstoneTTL = 90 * 24 * time.Hour

// ProjectPurger hard-deletes projects whose restore window has passed. Each run
// claims a bounded batch with SKIP LOCKED, so several server instances can run
// it at once without waiting on or double-purging each other, and a restore
// that already holds a project's row lock wins over the purge.
type ProjectPurger struct {
	Store        *Store
	Batch        int
	TombstoneTTL time.Duration
}

type ProjectPurgeStats struct {
	Projects          int64 `json:"projects"`
	Tombstones        int64 `json:"tombstones"`
	ExpiredTombstones int64 `json:"expiredTombstones"`
}

func (p ProjectPurger) withDefaults() ProjectPurger {
	if p.Batch <= 0 {
		p.Batch = projectPurgeBatch
	}
	if p.TombstoneTTL <= 0 {
		p.TombstoneTTL = projectTombstoneTTL
	}
	return p
}

// Run purges one batch of due projects and expired tombstones in a single
// transaction, then removes the purged projects' files. Re-running it after a
// failure is safe: catalog rows are gone or still due, and queued file cleanup
// is retried by cleanupBlobs.
func (p ProjectPurger) Run(ctx context.Context) (ProjectPurgeStats, error) {
	p = p.withDefaults()
	result, err := p.Store.transaction(ctx, func(q *Queries) any {
		stats := ProjectPurgeStats{}
		stats.ExpiredTombstones = q.Exec(`delete from orka.project_tombstones t using (
			select user_id,project_id from orka.project_tombstones where expires_at<=now()
			order by expires_at limit $1 for update skip locked
		) e where t.user_id=e.user_id and t.project_id=e.project_id`, projectTombstoneExpiryBatch)
		ids := []string{}
		for _, row := range q.Rows(`select id from orka.projects where purge_after<now()
			order by purge_after limit $1 for update skip locked`, p.Batch) {
			ids = append(ids, text(row["id"]))
		}
		stats.Projects, stats.Tombstones = p.Store.purgeProjects(q, ids, p.TombstoneTTL)
		return stats
	})
	if err != nil {
		return ProjectPurgeStats{}, err
	}
	stats := result.(ProjectPurgeStats)
	if stats.Projects > 0 {
		p.Store.cleanupBlobs(ctx)
	}
	return stats, nil
}

// Tick is the minute-loop entry point. A failed run is retried next minute.
func (p ProjectPurger) Tick(ctx context.Context) {
	stats, err := p.Run(ctx)
	if err != nil {
		log.Print("project_purge_pending")
	} else if stats != (ProjectPurgeStats{}) {
		log.Printf("project_purge projects=%d tombstones=%d expired_tombstones=%d", stats.Projects, stats.Tombstones, stats.ExpiredTombstones)
	}
}

// purgeProjects writes a tombstone for every member, queues file cleanup and
// deletes the project rows; their resources, blobs catalog and logs cascade.
// Callers must hold the projects' row locks.
func (s *Store) purgeProjects(q *Queries, ids []string, ttl time.Duration) (projects, tombstones int64) {
	if len(ids) == 0 {
		return 0, 0
	}
	tombstones = q.Exec(`insert into orka.project_tombstones(user_id,project_id,deleted_at,expires_at)
		select m.user_id,p.id,coalesce(p.deleted_at,now()),now()+make_interval(secs=>$2)
		from orka.projects p join orka.members m on m.project_id=p.id where p.id=any($1::uuid[])
		on conflict(user_id,project_id) do update set deleted_at=excluded.deleted_at,expires_at=excluded.expires_at`, ids, ttl.Seconds())
	q.Exec("insert into orka.project_blob_cleanup select unnest($1::uuid[]) on conflict do nothing", ids)
	return q.Exec("delete from orka.projects where id=any($1::uuid[])", ids), tombstones
}
