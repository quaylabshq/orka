## Project deletion catalog and access errors

`projectTombstones: 1` in `/v2/projects/capabilities` advertises the versioned
catalog selected by
`GET /v2/projects?includeArchived=true&projectLifecycle=1`. During the restore
window, the owner sees the whole deleted project entry. Other members receive
only `id`, `name`, `role`, `lifecycleRevision`, `deletedAt` and `purgeAfter`.
The caller's role and monotonic lifecycle revision let clients apply membership
changes and reject stale responses without receiving sources or policies.
Access to the project stays refused with `project_deleted`; only the owner can
restore or purge it.

After a purge the same opted-in catalog returns one
`{ id, deletedAt, purged: true }` entry per unexpired tombstone belonging to the
signed-in user. Clients detach it and stop syncing; the tombstone remains
terminal if an older catalog response arrives later. Tombstones disappear 90
days after purge and are never listed to unrelated accounts.

Existing desktops already request `includeArchived=true`, so that query alone
continues returning complete, familiar project rows. Deleted member projects
retain `archivedAt`, `role`, `sources` and `lifecycleRevision`, preserving the
archive gate and connected-folder mappings in desktop 0.3.13. It returns no
sparse entries or tombstones. An unrecognised `projectLifecycle` version also
gets this compatible response. The active catalog and MCP `list_projects` remain
unchanged. Update and validate the complete API deletion stack before shipping
new desktops; clients must opt into the versioned catalog and require
`softDelete: 1` before using recoverable deletion.

Access refusals keep their existing 403 status and `Project access denied`
message, and now also carry a `code`: `project_archived`, `project_deleted` or
`not_member`. Deletion is reported before archiving because a deleted project is
also archived, and `not_member` covers an unknown project as well as one the
caller does not belong to. A client that ignores `code` behaves exactly as
before; a newer client combines the code with its opted-in tombstone catalog to
distinguish a purge from lost membership. Both
editions share this implementation, and the versioned protocol package exports
the tombstone entry as `projectTombstone`.

## Recoverable project deletion

`softDelete: 1` in `/v2/projects/capabilities` identifies recoverable project
deletion. Updated desktops must require it before offering Delete project: older
services use the same `delete` action for permanent deletion. The capability's
`projectRestoreWindowDays` is the instance's positive
`orka.project_restore_window_days` setting, defaulting to 7. Use that duration in
the confirmation; an active project has no deletion deadline yet.

Lifecycle mutation receipts contain the authoritative `archivedAt`, `deletedAt`
and `purgeAfter` markers, including null markers after restoration. Clients apply
the receipt immediately instead of waiting for a background catalog refresh.
Retries return the original receipt and markers, even after a later operation
changes the project again. Purge receipts have no remaining lifecycle markers.

## Latest complete session snapshots

`sessionLatestOnly: 1` in `/v2/projects/capabilities` advertises latest-only
session storage and exact cached-session copying. Each session keeps its current
complete native transcript and lineage, while superseded session snapshots are
removed. Memory, plan, skill and encrypted ENV revision histories are unchanged.
Unresolved session conflicts and pending reviews retain their candidate files.
Session requests to `get_resource_history` and `compare_revisions` return an
explicit latest-only error after normal authorization; use `fetch_resource` to
read the current conversation.

Revision numbers remain monotonic concurrency identifiers. Stale session pushes
still produce conflicts rather than overwriting newer work, without loading the
old transcript. Pull feeds materialize current session resources, related
resources and unresolved conflicts while preserving event cursors and activity
notices. Old event/receipt manifests are small operational metadata and do not
pin superseded session files. Mutation retries keep their original acknowledgement
and outcome, so a desktop never rebases its native binding to bytes it has not
written. Non-session feed/history behavior is unchanged.

The optional `sourceSnapshot` on `POST /v2/sessions/copy` is the exact cached
`resourceInput` manifest; it excludes server fields such as owner, revision,
project ID and access. Upload its files with the signed-in account before copying.
The server validates source identity, current read/addition permissions, the
observed source revision and every file before creating the new owned session.
It does not substitute a newer remote conversation. An older copy request without
`sourceSnapshot` remains valid when its `expectedRevision` is current; a stale
request receives 409 `Cached session revision unavailable` without a receipt.
Committed legacy requests retain their original retry identity.

`sessionUploadReconcile: 1` advertises `POST /v2/sessions/reconcile` with
`{projectId, deviceId, id}`, where `id` is the original queued session request.
It accepts no snapshot content. An accepted request returns
`{status: "accepted", receipt}` with its original acknowledgement and current
read authorization, even when the session has since advanced. A request that has
not committed returns `{status: "cancelled"}` after durably fencing its old ID
under the publication lock. Repeating reconciliation is safe; a delayed original
request receives HTTP 409 instead of committing after cancellation. A client can
then rebuild the queued snapshot under a fresh request ID without duplicating a
copy. Reconciliation is scoped to the signed-in author and requires current
project membership and a registered device. It does not rewrite old server
snapshots or erase previously exposed credentials.

Deploy this capability before desktops that rebuild pre-redaction session
uploads. Without it, clients must retain affected queued requests and require a
server update rather than changing the content of an uncertain retry. Both
server editions use the same handler and existing receipt storage; no migration,
provider setting or protocol package update is required.

Update the API before updated desktops. Desktops detect this capability and
freeze the cached source into their durable request before first submission.
Requests already submitted to older services keep their original body and ID;
a known-failed stale copy can be replaced with a new request ID and its frozen
cached manifest. Existing clients may continue reading and publishing sessions,
but must update to promote a superseded cached session after its files have been
collected. Local native history, paginated Codex lineage, resume, handoff and
exports remain complete. Follow the [session retention operator guide](session-retention.md)
for the grace period, dry-run, backup and rollout steps before upgrading an
existing installation. A source change does not itself run production cleanup.

# Release compatibility

Email invitation candidates add migration 003 and optional `invites.email` /
invite-creation `email` fields. Existing protocol packages and joining-link
requests are unchanged. Email delivery and verified-recipient enforcement are
shared by OSS and managed Go servers. See [project email invitations](authentication.md#project-email-invitations)
for configuration, signup policy and coordinated rollout.

The governance catalog adds `pendingInvites` with `email` and `expiresAt` for
active email invitations. Owners and Admins on role-policy projects can read the
list; other members receive an empty array. Joining links and invitation tokens
are never included. Repeated invitations for one address appear once with the
latest expiry, and known current member addresses are excluded. Expired and
consumed invitations disappear on the next catalog read. Both server editions
share this behavior. Older clients ignore the extra field; updated clients must
also tolerate its absence on older services. No migration or protocol package
update is required.

## Go runtime contract checks

The Go runtime retains the TypeScript protocol package as its contract source.
After changing protocol or MCP schemas, run `npm run build` followed by
`npm run contracts:check`. The latter checks generated schema/transport drift
and replays parser inputs through both the installed Zod/MCP SDK schemas and
the Go validators, comparing acceptance and normalized output. Cases cover
required and unknown fields, defaults, trimming, Unicode length boundaries,
safe integers, nested resource refinements and MCP request envelopes.

Go regression tests cover shared tool schemas, native authentication and canonical
service origins. Remote MCP transport is no longer served. PostgreSQL integration
starts the production executable and
verifies that SIGTERM drains an authenticated request before closing the pool
and exiting. These checks supplement the HTTP, authorization, migration,
encrypted ENV, sync and final-image suites; credential-dependent provider and
native multi-Mac acceptance still require their configured environments.

## GitHub repository connections

Release 0.6.0 adds optional repository bindings, native clone support and
user-scoped GitHub access requests. It builds on the initial schema baseline,
adding migration `002_github_repositories.sql`. Older services retain local-folder
setup. Both editions share the implementation; see [configuration and the
single-app migration guide](github-repositories.md). Publishing this release does
not provision an operator's GitHub App, credentials or webhook configuration.

## Initial schema baseline

The server starts from `001_initial.sql`, containing the complete baseline
Orka schema, then applies the incremental migrations shipped after it. A fresh
database records each completed migration in `orka.schema_migrations`; repeated
startup does not replay historical upgrades.
GoTrue maintains its own authentication schema and migration ledger separately.

A database that completed the previous eleven Orka migrations can preserve its
data while replacing only that ledger. Take and verify a coordinated backup,
then run the new image's migration command in the existing Compose deployment:

```sh
docker compose stop api auth
docker compose run --rm --no-deps --entrypoint orka-server api migrate --reset-ledger
```

The source-built helper combines backup, verification, ledger adoption and restart
as `sh ./orka-server upgrade --reset-ledger`. Adoption is explicit, transactional,
and accepts only the complete known historical ledger. Partial, missing or unknown
histories are rejected without deleting data or ledger entries. Finish an older
upgrade with its matching server version first, or use a fresh database.
This operation never resets GoTrue accounts, projects, resources or blobs.
Keep historical API instances stopped during adoption. Afterwards, use
baseline-based server images only; rollback to an older lineage requires restoring
the verified pre-adoption backup, not just switching the image.

Release notes below describe the historical migration names; those SQL upgrade
files are no longer shipped. Baseline-era backups restore through the normal
recovery procedure. Historical backups need the matching older server or the
explicit ledger-adoption step before a baseline-based server can start.

## One desktop connector account

The plugin now uses only the running desktop account. Update the API before the
desktop/plugin: `/v2/instance` must advertise `desktopConnector:1` and authenticated
`GET`/`POST /v2/connector/tools` must be available. Shared tools keep their existing
schemas, authorization, review, revision and receipt semantics. Desktop approval
owns read/write/manage scopes; no browser OAuth account or remote MCP credential
is created. See [authentication](authentication.md#desktop-connector-authentication).

This intentionally retires remote-only plugins and old independent OAuth sessions.
Their tool, consent, token and discovery routes return HTTP 410 desktop reconnect
guidance. Old opaque tokens are rejected by native authentication. Reconnect the
updated plugin in Orka desktop; an old remote refresh token cannot upgrade it.
Desktop account/service switches invalidate local approval. The old
`MCP_ENABLED` environment setting has no effect. Source-opening links and ordinary
desktop/provider/Dashboard authentication remain supported.

No new migration is required. Shipped migrations 001–006 and stored OAuth rows
remain unchanged; the unmerged handoff/proof migration 007 is removed rather than
shipping unnecessary state. Operation receipts introduced by migration 004 remain
in use by the shared handlers.

## Selected sharing

`selectedSharing: 1` in `/v2/projects/capabilities` advertises authenticated `POST /v2/sharing/selected`. The endpoint accepts the existing v2 change schema and returns `published` with its normal mutation receipt, `conflict` with its normal conflict receipt, or `approval_required` with an immutable review request. Exact retries retain their identity. Deletions and secret-file payloads are rejected. Existing membership, source audience, publication, suggestion, and ownership checks apply.

Automatic category sharing is a local desktop preference. The native plugin
bridge can submit one explicitly selected frozen snapshot without changing that
preference. Publication and shared-resource tools use the desktop's native
session and the existing project permissions. OSS and managed editions share the
implementation. Selected publication requires no new protocol or migration; the
shared operation receipts continue to use migration `004_mcp_operations.sql`.


## Reviewed resource deletion

`resourceDeletion: 1` in `/v2/projects/capabilities` advertises exact-revision
deletion for shared memories, skills and plans through the existing
`POST /v2/sync/push` change contract. A tombstone must name the resource's current
`baseRevision`; a stale deletion returns 409 without changing the resource,
project revision or mutation receipt. The comparison runs under the same project
lock as publication, after membership, source and write authorization. Exact
retries retain their original receipt and request identity.

Both Cloud and self-hosted editions use this shared implementation. There is no
wire/schema, database migration or configuration change. Desktop reviewed
deletion requires this capability where older services did not check a
tombstone's exact revision. Ordinary content merge rules remain unchanged, and
sessions keep their existing stale-change conflict and explicit resolution
behavior. A deletion is not a source-preserving unshare or a change to a Mac's
automatic-sharing preferences; local removal still follows native installation,
dirty-file and active-session safeguards. Releasing the service and updating
clients are separate rollout steps.

Backend 0.5.3 adds nullable `email` to the existing governance
catalog member rows in both editions. Migration 011 adds one column to the
existing identity table; the normal authenticated GoTrue `/user` lookup refreshes
it from the account email, never user-editable metadata or profile input. Project
membership still gates the entire catalog. Managed deployment backfills existing
project members from GoTrue using the operator-only SQL in `deploy/ec2/` after
migration 011; authenticated requests continue refreshing those identities.
Self-hosted operators can run the same backfill or allow identities to populate
on their next authenticated request. Missing account emails remain null. No per-member network
calls, new endpoint, client state, or protocol package update is needed. Older
desktops ignore the extra field. Deployment status is recorded in the release workflow.

The release advertises `profile.conditionalSave: 1` and returns
an opaque `revision` with profile reads/writes. A Settings profile save supplies
`expectedRevision`; the shared core compares it under the profile row lock and
returns 409 without writing when it is stale. All values remain parameterized.
Existing onboarding and older clients can still write without that optional field.
The new desktop requires this capability for Settings profile edits, displaying
older services as read-only until updated. No database migration or protocol
package change is required.

The release adds role-policy contracts, Admin membership,
idempotent policy operations, and optional device hardware metadata through the
shared core and migration 010. Existing projects keep their rules until the Owner
confirms migration; both server editions use the same authorization and migration.
Retained restriction catalogs expose all records to the Owner and only a person's
own records to other roles. The desktop consumes canonical policy definitions
from a checksummed protocol candidate; its manifest records working-tree
provenance separately from a published release. Older services keep their current
rules and make the new Permissions controls read-only. Earlier desktops cannot
configure role policies and require an update to manage the new Settings model;
server authorization continues to enforce access. Production rollout and final-image
upgrade/restore acceptance remain separate release work.

The onboarding candidate retains projects created before migration 008 through
explicit desktop selection. Owners can fill an unset remote key after connecting;
members retain source-mapping access without permission to set that hint. Renamed
local checkouts keep the existing source ID, and multi-repository projects require
an explicit repository choice when the folder cannot be matched. These corrections
require no additional migration or protocol package update.

An unmatched remote can be connected explicitly to any authorized project,
including a project already keyed to another repository. Desktop remote identity
preserves non-default ports and private-host path case. Dismissed offline setup
retains its reviewed connection receipts for recovery through ordinary sync
without restarting the app. Native acceptance covers these cases against this
API; server migrations and wire schemas are unchanged.

Both SMTP and Resend onboarding mail use sign-in links without code-entry
instructions. Final-image acceptance signs in both fixture accounts through
scanner-safe confirmation and PKCE, while retaining replay, interception, refresh,
membership, blob and backup/restore checks.

Backend 0.5.1 adds owner-only shared project renaming through the existing
`/v2/projects/action` route and advertises `rename: 1` in project capabilities.
Renames use lifecycle revisions and durable receipts, preserving archive/delete
concurrency checks. Both editions use the same core; no schema migration or
protocol format change is needed. The updated desktop keeps optional personal
names in its account/service-specific local cache. Shared names still refresh
from the catalog, while personal names remain on that Mac until reset. Earlier
compatible servers support personal names; shared renaming reports an explicit
upgrade requirement. Production acceptance is recorded in the deployment receipt.

The 0.5.0 source-folder model adds shared source descriptors and repository-scoped
resource identity, signed ENV source identity, and native folder mapping. Existing
projects require the explicit server and per-Mac cache migrations documented in
[project sources](project-sources.md). Coordinate desktop and API upgrades; older
clients are outside this model's support contract. Both editions share schema 006,
the source API, and scoped authorization. Local candidate packages are distinct
from a published or deployed release.

New governed projects default to member editing and publication of instructions,
memories, skills, plans and sessions. The existing ENV read/suggest rule, owner-only
sharing management and creator-only session mutation are preserved. Both editions
use the canonical protocol defaults through the shared store. No wire change,
database migration or desktop update is required; the behavior takes effect when
the updated backend is released and deployed. Existing saved policies are retained.

Backend 0.4.3 adds an optional `url` to `/v2/invites` when `PUBLIC_URL`
is configured. The existing `token` and authenticated `/v2/join` contract are
unchanged. Both editions serve the scanner-safe `/join/<token>` preview from
the shared core; upgraded desktops preserve the invite and service through
sign-in and validate the selected service natively. Older servers retain
desktop-only links. No migration or shared protocol schema change is required.
The complete handoff requires the updated desktop. Existing desktop 0.4.2
candidate packages remain compatible; no client package update is required
to consume the optional invite URL from a deployed 0.4.3 server.

The 0.4.2 candidate adds paginated, permission-filtered management logs and owner-only
sharing management. Migration 005 imports existing request outcomes as historical
records and clears sharing delegation while preserving file access modes. Earlier
clients may still read these modes, but attempts to delegate sharing are rejected.
The current desktop removes file ACL editing and uses category access with one
additions checkbox. Both OSS and managed entry points consume the same migration
and core. No deployment settings or ENV encryption formats change.

The 0.4.1 candidate adds account display names to the existing member catalog and
category access requests. Collection requests require 0.4.1 on the server; prior
file requests remain supported. Owners review category requests using the same
revision and exact-preview checks. Existing file exceptions, creation permissions,
and sharing delegation remain unchanged. No database migration is needed.

The 0.4.0 candidate adds resource policy, immutable review requests, memory
provenance and permission-aware sync. Migration 004 is additive. Existing projects
remain legacy until an owner activates governance; new upgraded clients create
governed projects. Governed operations require `X-Orka-Governance: 1` and pull's
`governance=1` declaration, with server authorization on every operation. Earlier
clients receive an upgrade requirement. Capability declarations are compatibility
checks, never proof of permission. Both images use the same core and protocol.
See [governed sharing](governed-sharing.md) for activation and rollback boundaries.

Candidate verification covers 28 backend unit tests and six HTTP/PostgreSQL
integration tests. Native/client verification uses locally pinned packages from
the source commit; published images and signed applications remain coordinated
release acceptance work.

The 0.3.0 candidate adds JEV memory consolidation and optional `event.memoryResolutions` metadata while preserving v2 request/resource formats. No migration is required. Earlier clients ignore additive event fields and already retry HTTP 503 without dropping their queued edit. Operators must configure `JEV_API_KEY` for replacements or explicitly defer them with `MEMORY_JEV_ENABLED=false`. Both editions share the implementation; see [memory consolidation](memory-consolidation.md).

Backend 0.2.0 extracts the previous Orka server without changing `/v2` resource, sync, encrypted ENV or native command formats. Both images use the same protocol 0.2.0, migration files and GoTrue v2.196.0.

| Consumer                                  | Backend                        | Validation                                                                                                    |
| ----------------------------------------- | ------------------------------ | ------------------------------------------------------------------------------------------------------------- |
| Current `orka` onboarding branch          | OSS and managed 0.2.0          | Native stack test for email/code/PKCE, cache isolation, password, sync/conflicts, retries, daemon and restore |
| Current `orka`                            | Packaged core/protocol 0.2.0   | PostgreSQL integration and three-native-client encrypted ENV/UI tests                                         |
| Earlier password/default-callback clients | 0.2.0                          | Original route contracts retained; direct verify remains available, password is on by default                 |
| Current `orka`                            | Previous password-only service | Capability fallback and existing native auth tests                                                            |

Compatibility rows about retained contracts are not a claim of testing every historical signed app. Actual signed-app browser handoff, external GitHub consent, delivery to a real mailbox and physical two-Mac native sidebar checks remain staging/release acceptance gates.

The desktop consumes immutable npm tarballs stored under `vendor/`, with the source commit, SHA-256 and npm integrity in `manifest.json` and the lockfile. This works for private repos without shipping registry credentials. Source ownership stays here; the tarballs are generated release artifacts, not another editable server. To update, run `npm run backend:update -- vX.Y.Z` in `orka` with GitHub repository read access, then its compatibility checks. Local pre-release validation accepts an explicit release-directory argument. Never use an unversioned sibling-path dependency.

Rust verifies the canonical signing fixture from the installed protocol package. Both repositories retain contract tests to verify their respective package/source boundary. Client tests import backend test helpers and core rather than maintaining backend source. Production uses released Go images; local development builds the checked-in source with `sh ./orka-server setup --local --email you@example.com`.

Before upgrades, take and verify a coordinated database/blob backup. Baseline-era startup is idempotent; adopt a completed historical ledger explicitly as described above. Rollback after a destructive migration needs a tested restore; changing an image tag alone is not a database rollback plan.


The historical MCP operations update added migration `004_mcp_operations.sql`
and shared operation receipts. Those receipts and the eleven tool handlers are
retained behind the desktop connector API; independent OAuth grants and remote
transport are retired. See [desktop tool operations](mcp-operations.md).

## Experimental live session relay

This public export applies `017_live_sessions.sql` directly after `009_project_tombstones.sql`. The usual upgrade command applies pending migrations and preserves existing rows. The live table uses the same migration name and schema as the canonical API.

Both editions can opt in with `ORKA_EXPERIMENTAL_LIVE_SESSIONS=1` and a server-only `ORKA_LIVE_SESSION_RELAY_SECRET` of at least 32 characters. Apply migration `017_live_sessions.sql` and install the companion relay before enabling the feature. Route `/v1/live/rooms/*` on the existing Orka origin to the relay. Give the relay the core service address and matching secret through private configuration. Keep `/internal/live-sessions/authorize` on the private API network. The core enforces the relay secret as well as the user's existing bearer. The desktop sends its bearer only to its current Orka origin.

When enabled, the authenticated project capabilities response includes `experimentalLiveSessions: 1`. Existing clients continue normal snapshot sync. With the default flag value of `0`, the capability is absent and the live routes return 404. Turning the flag off blocks subsequent authorization requests immediately on the newly configured processes. Already delivered content remains on recipients' machines. This preview uses the same current project, resource and derived-source access rules in both editions.

Lifecycle routes take JSON and the user's ordinary bearer. Published Codex and Claude sessions have at most one active episode. Only the original author with direct publish rights and a registered device may start one. The request at `POST /v2/live-sessions/start` supplies `projectId`, `resourceId`, `deviceId`, a fresh UUID `episodeId`, positive `expectedRevision` and an array of all current `contextSources`. An exact retry returns the active episode. Concurrent different starts, stale versions and attempts to reuse a stopped or expired ID return 409. `POST /v2/live-sessions/status` accepts the two scope IDs and returns `{episodeId:null}` when inactive, or `{episodeId,deviceId,revision}` after verifying both reader and publisher access. Start returns the same active shape. Revision describes the current canonical session.

The owner may stop a particular episode from a registered device using `POST /v2/live-sessions/stop` with `projectId`, `resourceId`, `deviceId` and `episodeId`. A stop that reaches the server before an uncertain start prevents its later publication. A delayed stop for an earlier episode leaves its successor running. Unresolved session versions prevent a new episode. Canonical deletion or an incoming conflict ends an existing episode. Episodes expire 24 hours after initial admission. The API keeps small stop records with the session so a retry cannot reopen old relay contents. The relay retains responsibility for its short-lived payload storage.

The relay uses `POST /internal/live-sessions/authorize` with `X-Orka-Live-Relay-Secret` and the current user's bearer for every content read or write. The validated scope is `{projectId,resourceId,episodeId,action}`. A write also requires the initiating `deviceId` and the current `contextSources` array. Reads recheck the reader's access, the writer's publish rights and active source. An otherwise eligible write declaring any new dependency beyond the canonical session's published provenance closes the episode with 409 and `live_context_changed`. The author must publish the new dependencies through ordinary sharing before starting another episode. No transcript bytes pass through these authorization or lifecycle routes.
