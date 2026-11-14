# Orka plugin 0.3.0

Search Orka context, inspect resource history, save memories and plans, review requests and permissions, install complete skills, and inspect local synchronization from your coding agent.

The package includes five workflow skills. Its remote MCP server exposes 18 tools through OAuth. The desktop package also connects to the installed Orka app for private local discovery, selected sharing, skill installation and sync recovery. Remote-only hosts and cloud agents can operate shared resources; operations on a Mac require its local desktop connection.

## New tools

| Tool | Availability | Behavior |
| --- | --- | --- |
| `search_resources` | Remote | Search accessible memories, instructions, plans, skills and session snapshots across projects and repositories. |
| `get_resource_history` | Remote | Inspect revisions with authors and timestamps. |
| `compare_revisions` | Remote | Compare two revisions of an accessible resource. |
| `list_skills` | Remote and desktop | Discover accepted shared skills; the desktop also discovers local skills. |
| `install_skill` | Desktop | Install a complete local, global or accepted shared skill package into a connected project or supported agent. |
| `create_memory` | Remote | Save knowledge to a selected project or repository through existing publish/review policy. |
| `update_plan` | Remote | Update an existing plan with revision protection. |
| `get_sync_status` | Desktop | Inspect this Mac's project progress, queue, conflicts and errors. |
| `get_connection_status` | Desktop | Inspect this Mac's account, service, and plugin link state without reading project content or requiring a connection proof. |
| `retry_sync` | Desktop | Schedule pending or failed work for retry while retaining request identities. |
| `repair_sync` | Desktop | Repair recoverable local sync state while preserving pending changes. |
| `get_permissions` | Remote | Inspect effective project, member or resource access. |
| `update_permissions` | Remote | Change permissions within the caller's existing authority. |
| `list_requests` | Remote | List accessible requests and proposals awaiting review. |
| `review_request` | Remote | Inspect and approve or reject a selected request through Orka's workflow. |
| `resolve_conflict` | Remote | Inspect a sync conflict and apply the selected revision-protected resolution. |

Existing project-context, teammate-session, handoff and selected-sharing tools remain available. Resource access, source audiences, authorship and owner-review requirements are enforced by Orka. ENV content is excluded.

## Consent and outcomes

`orka.read` permits reads. `orka.write` additionally permits memory/plan writes, conflict resolutions, selected local sharing, skill installation, and local sync retry/repair; `orka.manage` permits permission changes and request reviews. Mutation tools require read access plus their specific scope and the requesting user's project authority. The consent screen describes the requested scopes. Existing read-only grants stay read-only, including after refresh; reconnect and explicitly consent to enable new operations.

Use exact project/repository IDs and current resource or policy revisions. Retain an operation ID when retrying an uncertain write. A stale revision requires rereading and reconciling the newer state. Report the returned result accurately: queued, conflicted or awaiting approval does not mean published or completed.

## Local skills and sync

Connect the remote plugin through your assistant and choose **Use account in Orka**. The app shows its actual signed-in account, service, requesting client, and scopes. Explicitly approve that connection, then return to the browser to finish. No desktop session token is passed to the browser or assistant. Signing into an assistant account does not select an Orka account.

Before local content calls, remote `get_profile` must return `desktopLinked: true` and a current `connectionProof`. Pass that proof with the returned account ID, service origin, and selected project ID to every local content tool, including discovery and sync status. Orka verifies the proof against the live grant and this Mac's account, service, device, and connection generation; caller-supplied IDs alone never authorize local access. Local reads require `orka.read`; selected sharing, installation, retry, and repair also require `orka.write`.

If local tools require reconnection, use local `get_connection_status` for the actual account and service, then reconnect through the assistant and approve **Use account in Orka** again. Fetch a fresh remote `get_profile` afterward. Sign-out, account changes, and service changes invalidate previous local links even after switching back. A fresh explicitly approved connection works without restarting the local process. Orka does not switch accounts, merge accounts, or retarget an existing grant. Existing browser-only clients continue to use remote tools; they need desktop approval before local content access.

Skill discovery returns an origin (`local`, `global` or `shared`), `skillId`, and `snapshotHash`. Pass those exact values to `install_skill` with `target` set to `project`, `codex` or `claude`; shared skills additionally require their `expectedRevision`. Project installs populate both `.agents/skills` and `.claude/skills`; agent targets use their configured homes. Installation preserves the complete package and executable flags and refuses divergent destination files. Installing a skill does not execute its scripts or enable sharing.

Sync status describes the connected Mac, not every device in the project. Retry processes existing queued work without scanning new local edits. Account-wide permission refresh retains Orka’s normal revocation cleanup; it may update access state outside the selected project. Retry preserves queued payloads and operation IDs. Repair skips unsafe recovery and preserves pending writes and conflicts. Check status after a retry; scheduling work is not proof of completed synchronization. A cloud-only connection cannot inspect a Mac's private files or recover its local queue.

## Selected sharing

Each category's automatic-sharing preference remains unchanged. **Only when asked** keeps local items private until an explicit request publishes one frozen snapshot. Sharing once does not authorize later edits or conversation turns. Sessions default to this mode for newly connected projects; existing preferences are preserved. ENV sets retain their separate workflow and cannot be published by this plugin.

Use `list_local_resources`, `preview_share` and `share_selected` for an existing local item. Identify the actual item; recency alone cannot establish the current conversation. The preview freezes exact bytes. Publication returns `published`, `approval_required`, `queued` or `conflict`, and safe retries retain the same request ID.

## Build and connect

1. Update the API and apply its migrations, including MCP scope, operation-receipt, and desktop-connection storage. For the managed service, update the Dashboard consent implementation before enabling desktop account connections. The native handoff and proof verification use `/v2/plugin/connection` and `/v2/plugin/connection/verify`; remote `get_profile` supplies the proof only for a desktop-approved grant. Existing remote read-only clients continue to work. Selected sharing additionally requires `selectedSharing: 1` in `/v2/projects/capabilities`.
2. Build against the updated endpoint:

   ```sh
   node plugins/orka/scripts/package.mjs https://your-orka-service.example/mcp artifacts/orka-plugin-0.3.0.zip
   ```

   The packager validates the 18 required remote tools, their read/write annotations, required scopes and OAuth discovery. Desktop packaging also requires `pluginConnection: 1` in `/v2/instance`. It creates the portable ZIP and `orka-plugin-0.3.0-desktop.zip`. Use `--remote-only` to create just the portable ZIP for an older service that supports the remote tool contract. Discovery verification does not establish authenticated host or native connection acceptance.

3. Use the portable ZIP for remote integrations. Codex and Claude Code on a Mac use the desktop ZIP and an updated Orka app supporting native connection approval and `--orka-plugin`. The default executable is `/Applications/Orka.app/Contents/MacOS/portable-workspace-mac`; pass another absolute path as the fourth argument for a development build. The local process reads project content only after validating a proof for the approved native account.
4. Install through the host's local plugin support, then connect using browser consent. Choose **Use account in Orka** to link local operations to the account shown in the desktop approval. A browser-account connection remains remote-only. Agent-account login is separate from Orka login. Packages contain no account credentials; a `connectionProof` in an authenticated tool result is short-lived and scoped to native connection verification, never a desktop session token. Do not log, publish, or reuse it across accounts.

For Claude Code:

```sh
unzip artifacts/orka-plugin-0.3.0-desktop.zip -d artifacts/orka-plugin
claude plugin validate artifacts/orka-plugin/orka --strict
claude --plugin-dir artifacts/orka-plugin/orka plugin details orka
claude --plugin-dir artifacts/orka-plugin/orka
```

Use isolated accounts, project folders and agent homes to validate writes, review policy, stale revisions, permission removal, complete skill installation and pending-preserving sync recovery. Signed app distribution, plugin publication and service deployment are separate release steps.

## Handoffs

`prepare_claude_handoff` returns selected shared excerpts, source revisions and URLs, supplied current-chat context, decisions and next steps as Markdown plus a starter prompt. Saving or delivering it does not publish it through Orka. Local code changes, credentials, executable agent state and unseen conversation history are outside the transfer.
