# Architecture

The public desktop has three boundaries:

1. `apps/mac/src` renders the React interface and invokes the Tauri bridge.
2. `apps/mac/src-tauri/src` implements native indexing, local SQLite state, Keychain authentication, imports/exports, and background synchronization. The UI does not start a second sync loop.
3. The checksummed `@portable/protocol` package in `vendor/` supplies shared schemas, validation, merge contracts, and signing fixtures. Its provenance is recorded in `vendor/manifest.json`.

The API is a separate service. The public `server/` tree includes its shared implementation, authorization, migrations, Docker Compose deployment tooling and integration suites. It has a separate npm workspace and is not a desktop build dependency. Both Cloud and self-hosted services use the same desktop binary and wire contracts. `server/source-manifest.json` records the canonical backend commit and file hashes; maintainers import reviewed changes without private Git history. See [server source updates](../server/README.md#source-updates).

## Data flow

The user connects a local project and explicitly chooses categories to share. The daemon indexes those categories, persists an outbox, uploads changes, pulls accepted revisions, and applies permitted changes locally. Retry identities and project cursors make interrupted operations resumable. Repository code is transferred with Git.

The desktop library also reads a separate private local catalog for sessions,
memories, and plans, independent of automatic sharing. Discovery runs through a
native asynchronous command when a collection opens or refreshes, rather than
rescanning histories during every workspace snapshot. Local content is not added
to the published resource table or outbox merely to make it readable. The UI merges
local and authorized shared identities. Owner, agent, and repository filters
apply independently of each other.

The native `local_resources` SQLite table persists the local index independently of
the UI's in-memory catalogs. Collections restore those entries in a read transaction
before running discovery, so a restart does not wait for a filesystem scan or the
background sync lock. Cached reads do not scan files or write provenance. Discovery
still serializes with sync and project changes; a busy workspace returns the saved
catalog and the visible collection retries automatically after five seconds, without
reporting contention as a discovery failure. The UI reuses completed and pending
reads across navigation to avoid extra discovery. Catalog freshness and visible-view refreshes follow
the configured sync interval, including changes to that setting. Explicit refresh
remains immediate, and revalidation preserves loaded rows and counts. This timing
also applies when automatic sharing is off; browsing does not queue publication.

Add skills orders global skills by the number of local Codex and Claude chats in
which Orka detected each skill. It reads `global-skill-usage.json` in the active
profile's account and service cache before refreshing the counts from local
history. The JSON file contains skill IDs and counts, plus whether the scan was
partial. The per-transcript SQLite cache avoids re-reading unchanged history.

Memories, plans, and text skill files use three-way merges. Binary files and executable flags use whole-value acceptance. Sessions preserve complete native snapshots and use explicit conflict handling; they are never line-merged. Active native sessions are protected from incoming replacement or deletion.

ENV support remains in the native implementation for compatibility, but is currently disabled in the desktop UI. See the [security model](security-model.md).

The desktop derives project attention from current requests, queued operations,
local review state, and conflicts, grouping overlapping states by resource identity.
Binding snapshots retain their own resource and project identities even before a
base revision is installed. Completed decisions and superseded local draft
snapshots remain history; reconciliation preserves their stored content and does
not resolve differing files or pending operations. Existing instruction files
that exactly match an authorized revision can acquire a baseline without a file
write.

After a successful pull, the desktop clears a stale plan upload when every
submitted field matches the accepted revision. An upload with differing content
keeps its local version. For skills, the installed revision and file manifests
give the desktop a common base for comparing local mirrors with the shared
version. On a governed project with skill sharing enabled and resource-level
publish access, the desktop can queue one unopposed edit to an existing
non-executable Markdown file. Concurrent edits can queue when they only append
distinct HTTPS link definitions to the same standalone References table. The
desktop rechecks both mirrors and the shared revision, then freezes the request
and waits for the exact accepted package before installing it. Other clean
merges become private drafts for review. Skill and plan conflicts remain visible
in Sync while other items continue at the normal cadence.

## Project lifecycle

Project lifecycle, account membership and attachment to this Mac are separate
states. Archive and recoverable deletion pause synchronization without discarding
local folders or queued work. The project selector lists active projects.
Settings → Projects provides access to project settings, re-adds projects
removed from this Mac, and offers owner-only recovery of archived and recently
deleted projects. Local copies of inactive projects can still be exported or
removed from their details. Leaving a project removes account membership on
every device. Removing a project from one Mac clears that Mac's attachment
and cached project state.

The desktop explicitly requests the versioned lifecycle catalog with
`includeArchived=true&projectLifecycle=1`. Owners receive complete deleted project
entries, members receive reduced entries with their role and lifecycle revision,
and purged projects arrive as tombstones. Every catalog consumer uses the same
request and merge path. Local source bindings survive the restore window; stale
revisions cannot overwrite newer state, and a purged project cannot be revived by
a stale active catalog.

Recoverable deletion and permanent purge require the server's `softDelete: 1`
capability. Older services remain usable, with those destructive actions disabled.
The API's configured restore duration and mutation receipts supply the displayed
policy and deletion markers; the desktop does not invent a recovery deadline.
The public server snapshot and protocol package must be updated through their
normal reviewed release/export process before shipping the feature for that
snapshot. Capability fallback also protects self-hosted services upgraded later.

While a deleted project can still be restored (`deletedAt` with a
`purgeAfter`, which only soft-delete services publish), its queue job keeps
scanning local files into the outbox with no request to the service, on a
timer four times slower than an active project's. The window ends when the
catalog delivers a purge tombstone or drops the project, not by this Mac's
clock. Governed edits become drafts whose automatic sharing waits for a
restore. Each captured row is marked as never sent by a
`heldCapture:<request id>` entry in local metadata rather than in the request,
so older clients send it unchanged; the marker is cleared just before the row
is first uploaded. Successive edits replace a never-sent capture in place using a fresh request ID
and the original base revision. Distinct edits to the Codex and Claude skill
mirrors keep separate requests. When an earlier request must stay intact, the
scan saves newer bytes as a local draft and leaves the native edit eligible for
a later active scan. A restore sends the held requests as ordinary changes.
Archived-only, revoked, hidden, detached and purged projects, and catalogs
without `purgeAfter`, capture nothing.

Claude and Codex hooks keep recording the session and its sources for such a
project, but inject no shared context until it is restored. The sidebar banner
and the removal warning count the rows still waiting on this Mac. Export scans
a restorable deleted project when it can take the workspace lock immediately.
A busy workspace still exports the saved snapshot and reports that recent edits
may be missing. Compression reads the scoped cache after the lock is released.

## Native modules

During sync and selected sharing, the desktop registers the public device name as “Mac”. Services that advertise `privateDeviceNames: 1` additionally receive the computer name in `privateName` for the device owner's account.

A new account store derives its sync device identity from this Mac's hardware UUID, the account and the profile, so clearing local data or reinstalling returns to the same Devices row instead of registering another Mac. Only the derived value is sent. Stores created before this change keep their saved identity, and named development profiles remain separate devices. Encrypted ENV device keys are a separate identity and are unaffected.

`indexer.rs`, `plans.rs`, and session readers discover scoped native content. `sync.rs` handles exchange and local materialization. `codex_import.rs` and `claude_import.rs` preserve native identities. `env/` owns dotenv parsing, encryption, device approval, and guarded file writes. `db.rs` and `auth.rs` isolate local persistence and credentials.

Keep `com.orka.v1`, the existing Tauri bundle identifier, Keychain service names, and protocol versions stable unless a reviewed migration accompanies a change. Desktop account caches and credentials are bound to the selected service. Authentication secrets and administrative server credentials never belong in the React interface or desktop build.
