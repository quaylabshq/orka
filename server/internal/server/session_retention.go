package server

import (
	"context"
	"encoding/json"
	"fmt"
	"log"
)

const sessionRetentionProjects = 16
const sessionRetentionFiles = 256
const sessionRetentionSnapshots = 1000

// Only known session hashes are candidates. Unknown uploads and non-session
// orphans are outside this change. All current files (including native lineage),
// non-session history and live review/conflict state remain roots.
const sessionRetentionCandidates = `with session_documents as (
 select payload from orka.resources where project_id=$1
 union all select payload from orka.snapshots where project_id=$1
 union all select payload from orka.events where project_id=$1
 union all select payload from orka.receipts where project_id=$1
 union all select payload from orka.conflicts where project_id=$1
 union all select content from orka.review_requests where project_id=$1
 union all select payload from orka.mcp_operations where project_id=$1
), candidate_hashes as (
 select hash from orka.session_blob_candidates where project_id=$1
 union select h #>> '{}' from session_documents cross join lateral jsonb_path_query(payload,'$.** ? (@.kind == "session").files[*].hash') h
), root_documents as (
 select payload from orka.resources where project_id=$1
 union all select payload from orka.snapshots where project_id=$1 and payload->>'kind' is distinct from 'session'
 union all select payload from orka.events where project_id=$1 and payload->'resource'->>'kind' is distinct from 'session'
 union all select payload from orka.receipts where project_id=$1 and payload->'event'->'resource'->>'kind' is distinct from 'session'
 union all select payload from orka.conflicts where project_id=$1 and not resolved
 union all select content from orka.review_requests where project_id=$1 and (payload->>'status'='pending' or content->'resource'->>'kind' is distinct from 'session')
 union all select payload from orka.mcp_operations where project_id=$1 and payload->'event'->'resource'->>'kind' is distinct from 'session' and payload->'receipt'->'event'->'resource'->>'kind' is distinct from 'session'
), live_hashes as (
 select distinct h #>> '{}' as hash from root_documents
 cross join lateral jsonb_path_query(payload,'$.**.files[*].hash') h
)
select b.hash,b.size from orka.blobs b join candidate_hashes s using(hash)
where b.project_id=$1 and b.created_at < now()-interval '24 hours'
and not exists(select 1 from live_hashes r where r.hash=b.hash)`

const supersededSessionSnapshots = `select s.project_id,s.resource_id,s.revision from orka.snapshots s
where s.project_id=$1 and s.payload->>'kind'='session'
and not exists(select 1 from orka.resources r where r.project_id=s.project_id and r.id=s.resource_id and r.revision=s.revision)`

type SessionRetentionStats struct {
	DryRun              bool   `json:"dryRun"`
	ProjectsInspected   int64  `json:"projectsInspected"`
	SkippedProjects     int64  `json:"skippedProjects"`
	SupersededSnapshots int64  `json:"supersededSnapshots"`
	PrunedSnapshots     int64  `json:"prunedSnapshots"`
	EligibleBlobs       int64  `json:"eligibleBlobs"`
	EligibleBytes       int64  `json:"eligibleBytes"`
	CatalogBlobsRemoved int64  `json:"catalogBlobsRemoved"`
	FilesRemoved        int64  `json:"filesRemoved"`
	BytesRemoved        int64  `json:"bytesRemoved"`
	PendingFiles        int64  `json:"pendingFiles"`
	LastProject         string `json:"-"`
}

func (result *SessionRetentionStats) add(next SessionRetentionStats) {
	result.ProjectsInspected += next.ProjectsInspected
	result.SkippedProjects += next.SkippedProjects
	result.SupersededSnapshots += next.SupersededSnapshots
	result.PrunedSnapshots += next.PrunedSnapshots
	result.EligibleBlobs += next.EligibleBlobs
	result.EligibleBytes += next.EligibleBytes
	result.CatalogBlobsRemoved += next.CatalogBlobsRemoved
	result.FilesRemoved += next.FilesRemoved
	result.BytesRemoved += next.BytesRemoved
	result.PendingFiles += next.PendingFiles
	result.LastProject = next.LastProject
}

// Each project is a separate transaction with bounded work, so interrupted
// operator runs can be resumed. Dry-run obtains the same locks but writes none
// of the snapshot, catalog, timestamp or filesystem state.
func (s *Store) PruneSessionHistory(ctx context.Context, apply bool) (SessionRetentionStats, error) {
	result := SessionRetentionStats{DryRun: !apply}
	for {
		batch, err := s.pruneSessionHistoryBatch(ctx, apply, result.LastProject)
		result.add(batch)
		if err != nil {
			return result, err
		}
		if batch.ProjectsInspected+batch.SkippedProjects < sessionRetentionProjects {
			return result, nil
		}
	}
}

func (s *Store) pruneSessionHistoryBatch(ctx context.Context, apply bool, after string) (SessionRetentionStats, error) {
	result := SessionRetentionStats{DryRun: !apply}
	q := &Queries{ctx: ctx, db: s.Pool}
	projects := q.Rows("select id from orka.projects where id::text>$1 order by id limit $2", after, sessionRetentionProjects)
	if q.err != nil {
		return result, q.err
	}
	for _, row := range projects {
		project := text(row["id"])
		part := SessionRetentionStats{DryRun: !apply, LastProject: project}
		_, err := s.transaction(ctx, func(q *Queries) any {
			// Upload takes FOR SHARE and publication takes FOR UPDATE on this row.
			if q.One("select id from orka.projects where id=$1 for update skip locked", project) == nil {
				part.SkippedProjects = 1
				return nil
			}
			part.ProjectsInspected = 1
			part.SupersededSnapshots = number(q.One("select count(*) as count from ("+supersededSessionSnapshots+") s", project)["count"])
			candidates := q.Rows("select hash,size,count(*) over() as total,sum(size) over()::bigint as bytes from ("+sessionRetentionCandidates+") b order by hash limit $2", project, sessionRetentionFiles)
			if len(candidates) > 0 {
				part.EligibleBlobs, part.EligibleBytes = number(candidates[0]["total"]), number(candidates[0]["bytes"])
			}
			if !apply {
				part.PendingFiles = number(q.One("select count(*) as count from orka.blob_file_cleanup where project_id=$1", project)["count"])
				return nil
			}
			// Remember hashes before the last old manifest disappears; the migration
			// trigger also captures rows pruned directly by session publication.
			part.PrunedSnapshots = q.Exec("delete from orka.snapshots s using ("+supersededSessionSnapshots+" order by s.resource_id,s.revision limit $2) old where s.project_id=old.project_id and s.resource_id=old.resource_id and s.revision=old.revision", project, sessionRetentionSnapshots)
			for _, file := range candidates {
				q.Exec("insert into orka.blob_file_cleanup(project_id,hash,size) values($1,$2,$3) on conflict do nothing", project, file["hash"], file["size"])
				q.Exec("delete from orka.blob_uploads where project_id=$1 and hash=$2", project, file["hash"])
				part.CatalogBlobsRemoved += q.Exec("delete from orka.blobs where project_id=$1 and hash=$2", project, file["hash"])
			}
			return nil
		})
		if err != nil {
			result.add(part)
			return result, err
		}
		if apply && part.ProjectsInspected > 0 {
			removed, bytes, pending, err := s.removeSessionFiles(ctx, project)
			part.FilesRemoved, part.BytesRemoved, part.PendingFiles = removed, bytes, pending
			if err != nil {
				result.add(part)
				return result, err
			}
		}
		result.add(part)
	}
	return result, nil
}

func (s *Store) removeSessionFiles(ctx context.Context, project string) (int64, int64, int64, error) {
	var removed, bytes, pending int64
	_, err := s.transaction(ctx, func(q *Queries) any {
		if q.One("select id from orka.projects where id=$1 for update skip locked", project) == nil {
			return nil
		}
		files := q.Rows("select hash,size from orka.blob_file_cleanup where project_id=$1 order by hash limit $2 for update skip locked", project, sessionRetentionFiles)
		for _, file := range files {
			hash := text(file["hash"])
			// A re-upload of an identical hash wins over an old cleanup request.
			if q.One("select 1 from orka.blobs where project_id=$1 and hash=$2", project, hash) == nil && q.err == nil {
				if err := s.Blobs.Remove(project, hash); err != nil {
					q.Check(fmt.Errorf("session file cleanup remains pending: %w", err))
					return nil
				}
				removed++
				bytes += number(file["size"])
			}
			q.Exec("delete from orka.blob_file_cleanup where project_id=$1 and hash=$2", project, hash)
		}
		pending = number(q.One("select count(*) as count from orka.blob_file_cleanup where project_id=$1", project)["count"])
		return nil
	})
	return removed, bytes, pending, err
}

func printSessionRetention(stats SessionRetentionStats) error {
	return json.NewEncoder(log.Writer()).Encode(stats)
}
