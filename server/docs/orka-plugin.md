# Orka plugin 0.3.0

## One desktop login

The installed Orka plugin talks to a local MCP helper, which forwards calls to the
running desktop broker. The desktop account is the only account. Login, connector
approval and session refresh stay in Orka; the helper never receives credentials.
The API reuses 18 shared tool handlers through native-authenticated
`GET`/`POST /v2/connector/tools`. Local discovery, selected sharing, skill
installation and sync recovery remain on the Mac. Shared `list_skills` and local
`list_local_skills` have distinct names. See [tool operations](mcp-operations.md).

The plugin source and workflow skills live under `plugins/orka/` in the desktop
repository. This repository owns native tool forwarding, source reading and
project authorization. The normal API advertises `selectedSharing:1` and accepts
explicit frozen snapshots at `POST /v2/sharing/selected`, preserving suggestion,
provenance, conflict and retry rules without changing automatic sharing.

## Implemented tools

| Tool                     | Behavior                                                                                                                         |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `get_profile`            | Identifies the connected account.                                                                                                |
| `list_projects`          | Lists active projects the account belongs to.                                                                                    |
| `get_project_context`    | Reads accepted memories, instructions and plans, with folder scope, query and pagination. Excludes readable superseded memories. |
| `list_team_members`      | Resolves member IDs and names inside an accessible project.                                                                      |
| `list_sessions`          | Lists accessible shared session snapshots by author, provider, title query or snapshot date. Newest shared revision first.       |
| `fetch_resource`         | Reads memory, plan or readable session text in bounded pages, guarded by source revision.                                        |
| `prepare_claude_handoff` | Returns Markdown, selected source excerpts, citations and a starter prompt for a new Claude Code conversation.                   |

The seven context and handoff tools above are read-only. The eleven additional discovery, history, write and administration tools are documented in [MCP operations](mcp-operations.md). Handoff preparation returns text and creates no shared resource. Skills instruct the host to save that text as a local or downloadable Markdown artifact when file tools are available. No tool launches Claude Code or starts a model turn.

## Authentication and permissions

Update the service first and require `/v2/instance.desktopConnector:1`. No
`MCP_ENABLED` setting or additional login/provider is needed. Configure the normal
service `PUBLIC_URL` for canonical source links. The desktop forwards each shared
tool with its current native bearer, enforcing locally approved read/write/manage
scopes first. The API authenticates that bearer and rechecks project membership,
source restrictions and current resource permissions through the existing
handlers. Account IDs in tool arguments cannot override the signed-in identity.
ENV secrets and private local content are excluded from shared tools.

The independent remote MCP/OAuth connection is retired. Its discovery,
registration, consent, token and tool routes return HTTP 410 desktop reconnect
guidance. Old access/refresh tokens cannot authenticate native `/v2` routes.
Existing OAuth rows and shipped migrations are retained for upgrades without
being used; the unreleased handoff/proof migration is removed. Ordinary desktop,
provider and Dashboard authentication continue unchanged. See
[authentication](authentication.md#desktop-connector-authentication).

## Transcript and handoff behavior

Sessions retain their latest complete snapshot rather than a browser of superseded revisions. Memory, plan and skill history remains available through the history tools. Unresolved conflict and pending-review versions are protected until resolved. Session reading supports Claude JSONL and Codex legacy/paginated JSONL. Paginated history resolves only the exact inherited file and byte/ordinal boundaries declared in the snapshot. Corrupt, missing, cyclic or unreferenced lineage fails visibly. Complete source blobs remain unchanged.

The readable conversation excludes setup, analysis, tool payloads and nontext blocks. Mirrored Codex message forms are deduplicated within turns, while repeated turns are retained. A session bundle must be at most 32 MB for plugin reading; larger bundles remain available through the desktop. Ordinary text sources are bounded by their existing 1 MB limit. Fetch results contain up to 40,000 UTF-16 code units per page. Continue with both `nextOffset` and `expectedRevision`; a changed source requires restarting the read.

Context and session lists scan bounded pages of 500 resources. Pass each returned `nextCursor` unchanged as the next request's `cursor` until it is null. Cursors include both revision and resource ID so sessions published under the same revision are not skipped. Earlier numeric revision cursors remain accepted. Context queries search titles and text; session queries search titles. Context returns up to 20 source excerpts per page. Folder-specific context requires a relative scope. Session authors and last-shared timestamps describe snapshots, not live presence or all work by a teammate.

Projects can contain multiple repository sources. `list_projects` returns their IDs and names; every returned source reference includes its repository `sourceId`, or `null` for unassigned project context. Context and session queries accept an exact `sourceId` filter. Folder guidance in projects with multiple repository sources requires that filter, preventing same-path guidance from another repository from being applied accidentally. A filtered query excludes unassigned context; query without the filter to read that project-wide material.

Handoffs accept up to five sessions and ten other sources. Each session contributes a clearly labeled excerpt from the end of its readable conversation, up to 16,000 characters; ordinary sources contribute up to 8,000 characters from the start. The assistant should read more context before preparing the handoff when omitted material could change the result. Current-chat context, decisions, next steps and repository details are caller supplied. Unseen ChatGPT history is never fetched automatically.

Source URLs open a public landing page that discloses no source content or title and links into Orka. The desktop requires sign-in and project access. Users must select the matching service for self-hosted sources.

The handoff is a new conversation. It transfers no local files, uncommitted changes, credentials or provider execution state. The returned artifact carries source references and instructions to retain their restrictions; manually delivered artifacts and the receiving session are not automatically registered as governed Orka derivatives in v0.1.

## Verification and connection

Run `npm run build`, `npm run typecheck`, `npm test`, `npm run test:go`,
`npm run contracts:check`, `npm run test:integration`, `npm run lint`,
`npm run licenses:check` and `npm run check:repository`. Disposable PostgreSQL
integration exercises native account switches, expired sessions, rejected old
OAuth credentials and spoofed identities, retired route guidance, project ACLs,
source restrictions, pagination, histories, exact writes, reviews, conflicts,
receipts and handoffs. Fixtures use synthetic identities.

Build both Docker targets and run `npm run test:images -- <edition> <image>`.
These disposable stacks use actual GoTrue desktop sessions for the shared tool
inventory, read/write tools, handoff, idempotency and retired-path checks alongside
ordinary authentication and coordinated backup/restore. This does not establish
production rollout, actual email delivery, host installation, native account
switches or physical Mac acceptance; those require their corresponding desktop
and configured-environment tests.
