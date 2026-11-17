# Latest session snapshots and storage cleanup

Orka keeps the latest complete shared snapshot of each session, including its
native conversation and inherited lineage files. Memory, skill, plan and ENV
history are unchanged. Session revision browsing/comparison is unavailable;
unresolved session conflicts and pending reviews retain the files needed for a
safe decision.

The API advertises `sessionLatestOnly: 1`. Update the server and desktop together
as described in [release compatibility](compatibility.md#latest-complete-session-snapshots)
before reclaiming old session files. An older/offline Mac must preserve its
cached continuation rather than replace it with a newer remote conversation.
Native conversation history and pagination inside the latest snapshot remain
complete.

## Preview and apply cleanup

Take and verify a coordinated database/blob backup before deploying this change
or applying it to an existing installation. Migration `007_session_retention.sql`
is additive: it creates upload timestamps, a known-session hash catalog and a
durable physical-cleanup queue. It does not delete files. Existing blobs receive
an upload timestamp at upgrade, granting them the full 24-hour grace period.
The migration remembers session hashes before their superseded snapshot rows
are removed. These metadata records neither retain the transcript nor grant
read access.

For an installation managed by the source/operator frontend:

```sh
sh ./orka-server prune-session-history
sh ./orka-server prune-session-history --apply
```

For an existing Compose deployment:

```sh
docker compose exec -T api orka-server prune-session-history
docker compose exec -T api orka-server prune-session-history --apply
```

For a source-built executable, provide the installation's private `DATABASE_URL`
and `BLOB_ROOT` through its normal environment, then run
`artifacts/bin/orka-server prune-session-history [--apply]`. The schema must
already have completed its ordinary migration step. The command does not read
or print configuration secrets.

The default is a dry run. It reports JSON with superseded snapshot count,
eligible blob count/bytes and pending physical removals. A dry run changes no
snapshot, catalog row, upload timestamp or file. `--apply` prunes and collects
in bounded passes: at most 1,000 superseded snapshot rows and 256 eligible files
per project per invocation. Repeat the command until no eligible work remains.
A project currently being uploaded or changed is skipped and can be retried.
Do not interpret `eligibleBlobs` as the number already removed; use
`catalogBlobsRemoved`, `filesRemoved`, `bytesRemoved` and `pendingFiles`.

## Automatic cleanup and retained references

The shared OSS/managed worker performs the same cleanup every minute, rotating
through at most 16 projects per cycle. It removes superseded session snapshot
rows and eventually collects known session files that have not been uploaded
for at least 24 hours and have no live references. Uploading an identical hash
refreshes its grace period under the project upload lock.

The live reference set protects:

- Every current resource manifest and all its lineage files.
- All non-session snapshots, sync events, receipts and review history.
- Every unresolved conflict and pending review.
- Non-session or opaque connector operation receipts.

Known superseded **session** event/receipt manifests, including session conflict
resolution receipts, do not pin obsolete transcript bytes. They retain operation
identity and outcome; sync replay resolves the current session state. Unknown
uploads and unclassified/non-session orphan files are outside this collector.

Catalog removal is committed with a durable cleanup entry before a file is
unlinked. Physical cleanup reacquires the same project lock and checks whether
an upload has recreated the hash. A recreated catalog entry wins, so the new
upload remains intact. Missing files are safe to retry; filesystem errors leave
the cleanup request queued. An interrupted cleanup is resumable and preserves
cataloged files needed by backup/restore. No filesystem-wide deletion is used.

The latest session snapshot is still stored as complete content. Compression
and chunk-based storage are separate improvements. Backup retention is also
separate: an older backup may continue to contain old session versions until its
normal recovery retention expires.
