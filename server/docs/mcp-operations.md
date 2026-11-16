# Desktop connector tool operations

The plugin exposes accepted shared resources to desktop-connected agents using the
same project permissions and review services as Orka. Private local files,
credentials and encrypted ENV sets are excluded from shared tools.

## Desktop approval and compatibility

The desktop is the sole account and approval owner. The local plugin gateway
forwards shared calls to native-authenticated `POST /v2/connector/tools` with
`{name, arguments}`. `GET` on that path returns the shared schemas and scopes.
The helper never receives native credentials. The desktop checks each approved
scope before forwarding, while the API always checks the actual account's
project membership, source restrictions and current resource permissions.

| Desktop scope | Shared tools |
| --- | --- |
| `orka.read` | Context/session tools, `search_resources`, `get_resource_history`, `compare_revisions`, `list_skills`, `get_permissions`, `list_requests` |
| `orka.write` | `create_memory`, `update_plan`, `resolve_conflict` |
| `orka.manage` | `update_permissions`, `review_request` |

Inspection through `resolve_conflict` or `review_request` still requires that
tool's write/manage approval even when that individual call does not mutate.
Approval does not override session ownership, current permissions or review.
Both server editions share the same handlers and operation receipts from shipped
migration `004_mcp_operations.sql`. No new migration is required.

Remote MCP/OAuth grants are retired; their routes return HTTP 410. Reconnect the
updated local plugin in Orka desktop. Old remote tokens cannot call this endpoint
or acquire desktop approval. See [authentication](authentication.md#desktop-connector-authentication).

## Discover and inspect

`search_resources` and shared `list_skills` accept an optional project/repository
source, query, limit and cursor. A source filter requires its project ID. Search
matches titles and readable content; instruction resources are classified as
`instructions`, while curated memories use `memory`. Follow `nextCursor` even on
an empty page: permission filtering can remove all matches from a scan page.
Results describe accepted shared snapshots, not live agent activity.

History uses `beforeRevision`/`nextBeforeRevision`. Revision comparisons return
changed file manifests, changed metadata and bounded before/after text for the
selected file. Continue with `nextOffset` and the same revision pair. Session
comparisons use the readable conversation representation and omit setup,
analysis and tool records. Every history read checks current access and the
historical resource's source dependencies.

Skill discovery includes complete file manifests, executable flags, revision and
`snapshotHash`. Installations use the separate local `install_skill` tool; the desktop must be running to install onto its Mac. The native authenticated
`installation` governance action checks the exact current accepted skill revision
before returning its resource and access, and existing blob routes enforce access
on every download. Complete packages retain the normal 200-file, 4 MB total and
1 MB per-file limits.

## Writes and retries

Use one fresh `requestId` for an intended memory, plan update, permission change or
conflict resolution. Retry the identical arguments with the same ID after an
uncertain response. Reusing an ID with different content is rejected. Receipts
are transactional and current authorization is checked again on retry.

`create_memory` saves a curated knowledge entry with optional source, relative
folder scope and context sources. `update_plan` retains the accepted plan's
identity and requires its current `expectedRevision`. A stale plan is rejected
before changes are applied. Both tools return `published` or `approval_required`;
a pending proposal is not published content.

`get_permissions` reports effective category or resource access. Only an owner
can inspect another member's effective permissions. `update_permissions` uses
Orka's current policy, resource-access and member-role workflows, with a current
`expectedPolicyRevision`. It cannot delegate sharing or silently migrate a project
to role policies; review that migration in Orka Settings first. Non-owner callers
cannot change sharing permissions.

`list_requests` returns authorized access/change requests, excluding ENV requests.
Inspect with `review_request` before deciding. Proposed text/skill file bytes are
included for exact review. Session proposals use paginated readable conversations,
without raw native files. Continue a session proposal with its `nextOffset` and
`previewHash`. Decisions require the exact preview hash and current policy
revision; stale requests follow Orka's existing stale-review behavior.

Inspect session conflicts with `resolve_conflict` and `action: inspect`. Current
and candidate conversations include their authors, revisions, bounded text and
`nextOffset`. Continue using the current accepted revision as `expectedRevision`;
restart inspection after a revision change. `accept` or `copy` applies the selected
current/candidate version through the existing resolver, preserving session
ownership, copy provenance and permissions. Identical retries return the saved
result even after the conflict has been resolved.

This API does not operate a machine's outbox or install skills directly. Local
`get_sync_status`, `retry_sync`, `repair_sync` and `install_skill` are implemented by
the desktop plugin against that machine's connected account and service.
