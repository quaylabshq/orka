# Orka plugin 0.3.2

The plugin uses **one login: the account signed in to Orka desktop**. It has one stdio server and five workflow skills for shared context, teammate sessions, handoffs, selected sharing and resource operations.

```text
Assistant → local stdio bridge → running Orka desktop → Orka API
                                   ├─ signed-in account / Keychain
                                   ├─ connector approval and scopes
                                   └─ local files, skills and sync
```

The bridge forwards requests over a private, profile-local Unix socket. It does not open account databases, read credentials or execute tools independently. The desktop executes local tools and calls the API with its own session for shared tools. Desktop credentials never reach the assistant. There is no remote MCP server or browser plugin login. Ordinary Dashboard login remains available for the web product.

## Connect

1. Install an updated Orka desktop and sign in normally. The service must advertise `desktopConnector: 1` at `/v2/instance` for shared tools.
2. Install the plugin in Codex or Claude Code, or [connect Pi](#connect-pi).
3. When a verified assistant connects for the first time, Orka opens the approval dialog. Review the account and service, then approve the access you want to grant. Other setups can open **Settings → Connectors → Review request**.

Orka remembers the selected access for Codex, Claude Code, and Claude when macOS verifies the app's signing identity. Reopening a verified assistant restores those same permissions for the same Orka account and service. Other setups can still connect with approval for the running assistant. If a returning verified assistant needs attention, Orka shows a quiet toast with a link to **Connectors**. Existing process-only approvals stay valid for their original connection. Review one fresh request to save access across restarts.

**Settings → Connectors** shows pending requests, active sessions and saved access when an assistant is closed. Revoking access, signing out, or switching account or service invalidates the old grant and its sessions, even after switching back. To change approved access, revoke the grant, reconnect from the assistant, and review the new request with the desired scopes.

`get_connection_status` works before approval and reports if Orka is closed, without exposing project content. The connector retries registration when Orka opens.

When upgrading from plugin 0.2.0, update the installed plugin as well as Orka desktop. A local plugin marketplace must also contain the new 0.3.2 package; publishing a desktop release does not refresh a local marketplace. The new package has one stdio `orka` connector. A remaining remote `orka` plus local `orka_local` pair indicates the old package and can cause repeated OAuth startup errors against retired endpoints.

Closing the main window keeps Orka available through its menu bar. Explicit Quit stops the broker. Open Orka to use the connector after Quit.

## Connect Pi

Use Pi 1.6.0 or a later release with native `pi mcp` support. Sign in to Orka desktop first. Extract the Orka plugin ZIP to a folder you intend to keep. If you need a ZIP, see [Package locally](#package-locally). Then run:

```sh
pi install /absolute/path/to/extracted/orka
pi mcp add orka --exposure direct -- \
  /Applications/Orka.app/Contents/MacOS/portable-workspace-mac --orka-plugin
```

Use the `orka` directory inside the extracted ZIP for `pi install`. That installs the workflow skills, not a second connector. If you run a named Orka profile, append `--profile <name>` after `--orka-plugin`. For a different app location, replace the executable path.

If Pi is open, run `/reload`. Ask Pi to check the Orka connection, then open **Settings → Connectors → Review request** in Orka to approve the live session. Start with read access if you only need project context. Ask Pi to list your Orka projects to verify access. To revoke it, use **Settings → Connectors** in Orka. To remove the setup from Pi, run `pi mcp remove orka` and `pi remove /absolute/path/to/extracted/orka`.

Pi can fetch existing shared memories, skills, and sessions. It can load installed project and global skills from the `.agents/skills/` directories it reads. This setup does not discover, share, or resume Pi's own session files.

## Access and tools

The single server exposes 27 unique tools. Reads require `orka.read`. Mutations require `orka.write`; permission changes and request decisions require `orka.manage`, in addition to read access and existing project permissions. Approval cannot bypass service permissions, owner review, source restrictions or revision checks. ENV content is excluded.

| Area | Tools |
| --- | --- |
| Connection | `get_connection_status` |
| Shared context | `get_profile`, `list_projects`, `get_project_context`, `list_team_members`, `list_sessions`, `fetch_resource`, `prepare_claude_handoff`, `search_resources` |
| History and shared skills | `get_resource_history`, `compare_revisions`, `list_skills` |
| Shared writes and reviews | `create_memory`, `update_plan`, `resolve_conflict`, `get_permissions`, `update_permissions`, `list_requests`, `review_request` |
| Private local snapshots | `list_local_resources`, `preview_share`, `share_selected` |
| Local installation | `list_local_skills`, `install_skill` |
| This Mac's sync | `get_sync_status`, `retry_sync`, `repair_sync` |

`get_resource_history` and `compare_revisions` apply to memories, plans, and
skills. Sessions expose only their latest complete shared snapshot, including
the retained conversation and native lineage. Use `fetch_resource` to read that
snapshot with its current revision; restart pagination if the revision changes.
Session conflicts remain separately reviewable until resolved.

Supply exact project/repository IDs returned by tools. The desktop derives account and service internally. Do not pass account IDs, desktop tokens or connection proofs. Use `list_skills` for accepted shared skills and `list_local_skills` for local/global/shared install packages. Installation uses the returned `origin`, `skillId`, `snapshotHash` and shared `expectedRevision`; it preserves supporting files, executable flags and divergent destination files. Installing does not execute a skill or enable sharing.

Keep operation IDs when retrying uncertain writes. Reread stale revisions before reconciling. Report `queued`, `approval_required` and `conflict` accurately; scheduling work is not completed synchronization. Retry/repair preserve pending bytes and request identities.

## Selected sharing and handoffs

Only an explicit request authorizes publishing one selected frozen snapshot. Use `list_local_resources`, identify the actual item, `preview_share`, then `share_selected`. Pi sharing requires explicit consent to the complete saved tree, including abandoned branches and tool records or reasoning omitted from the reader. Recency alone does not identify the current conversation. Sharing once does not authorize future turns or enable automatic category sharing. Complete skills include their supporting files; arbitrary paths and ENV files cannot be shared.

`prepare_claude_handoff` returns selected shared excerpts, source revisions and URLs plus supplied current-chat context as Markdown and a starter prompt. It does not transfer unseen history, credentials, local changes or executable agent state, and does not publish a resource.

## Package locally

```sh
node plugins/orka/scripts/package.mjs artifacts/orka-plugin-0.3.2.zip
```

This creates one ZIP containing Codex and Claude manifests, a Pi skills package manifest, the shared desktop bridge configuration, skills, and assets. Packaging works offline and contains no account credentials. The default executable is `/Applications/Orka.app/Contents/MacOS/portable-workspace-mac`. For an isolated development app/profile:

```sh
node plugins/orka/scripts/package.mjs artifacts/orka-dev.zip /absolute/path/to/orka-desktop demo-profile
```

A profile only selects the desktop instance; it never supplies account authority. Legacy remote endpoint arguments and `--remote-only` are rejected. Remove the old HTTP connector and install/reconnect this package; legacy remote MCP/OAuth routes return HTTP 410 with desktop guidance. Older API services produce an explicit upgrade error for shared tools. There is no cloud-only alternative.

For Claude Code:

```sh
unzip artifacts/orka-plugin-0.3.2.zip -d artifacts/orka-plugin
claude plugin validate artifacts/orka-plugin/orka --strict
claude --plugin-dir artifacts/orka-plugin/orka
```

Run `npm run test:plugin-native` against a debug build for isolated broker/bridge/account-switch acceptance. Add `--pi /absolute/path/to/pi` when running `python3 -B scripts/plugin-native-acceptance.py` to verify that Pi loads the packaged skills and discovers the bridge tools without a model call. The native fixture separately verifies approval and revocation. Signed installation, plugin publication and production service deployment remain separate release steps.
