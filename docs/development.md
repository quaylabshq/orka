# Local development

Run commands from the repository root. Install Node.js 24+, Rust, and Apple's Command Line Tools on macOS, then run `npm ci`. Desktop builds and fixture-based checks require no private repository, database, or server package.

## Start the desktop app

```sh
npm run dev:profile
```

The launcher derives a stable profile from this worktree's canonical path, chooses a free loopback frontend port, and builds into this worktree's own target directory. Each worktree gets independent app settings, service URLs, logins, device identities, SQLite caches, blobs, ENV keys, locks and sync agents. Profile names and controls are not shown in the window title, onboarding, or Settings. Profiles use the same app binary; no separate edition build is required.

Choose Orka Cloud or enter an existing compatible self-hosted service, then sign in with an account provisioned by its operator. A browser-only preview can be used to develop the UI without an account. New named profiles start with background sync off. Enable **Settings → Run at login and after the window closes** when testing sync; its LaunchAgent is specific to that profile. Disable it before removing a worktree. The existing `default` profile keeps its original app data, Keychain and background-service identity.

Double-clicking `Open Orka.command` starts the same worktree-aware launcher. Keep its Terminal window open while developing; Ctrl-C stops the development process. A browser-only preview (`npm run dev`) cannot exercise native commands. The raw `tauri dev` command still uses `default` unless `ORKA_PROFILE` is set.

## Multiple profiles and worktrees

Run `npm ci` and `npm run dev:profile` from each worktree to develop concurrently. Two folders with the same basename still get different profile IDs. The chosen port and profile are printed on launch; `--port 5200` pins a port and fails clearly if occupied. `--dry-run` prints the resolved launch configuration without opening the app.

To select a stable test identity explicitly:

```sh
npm run dev:profile -- --profile alice
# In another worktree / Terminal:
npm run dev:profile -- --profile bob
```

Use the development launcher or the command below to open an isolated window with its own session. A profile already running is focused instead of opening a second writer. Use the launcher in another worktree to test that worktree's code.

Installed builds also accept `--profile <name>` or `ORKA_PROFILE=<name>`; the explicit argument takes precedence. For example:

```sh
open -na /Applications/Orka.app --args --profile alice
open -na /Applications/Orka.app --args --profile bob
```

Names use 1–48 lowercase letters, digits or hyphens, starting with a letter. Named profile data lives under `~/Library/Application Support/com.orka.v1/profiles/<name>/`; `default` continues using the existing parent directory. A profile name selects local Orka state, not a separate server database: use separate service accounts or deployments to isolate remote data.

Use distinct worktree folders and synthetic content for manual tests. Profiles do not sandbox the filesystem or create separate Codex/Claude Desktop accounts; the external tools retain their configured homes and native session workflows. Avoid connecting the same physical folder to two profiles: they would edit the same files and replace that folder's Orka hooks. Installed hooks carry the profile argument so a worktree's events reach the right client.

GitHub and magic links include a validated profile name in the callback. A callback received by another Orka window is delivered to the originating profile, which alone can exchange its PKCE verifier. Upgrade the service with the current auth proxy and GoTrue allowlist before testing browser sign-in in named profiles; password login remains compatible with older services. Different profiles may sign in independently, but browser provider sessions still belong to the system browser.

## Tests

### Annotate the test app

[Agentation](https://www.agentation.com/install) is available in development through `pnpm dev:profile`. Click **Start feedback mode** in the bottom-right corner, click the UI element, write a note, and choose **Add**. Use **Copy feedback**, then paste the result into this chat. Choose **Exit** to use the app normally again. Global Agentation shortcuts are disabled so Orka keeps its keyboard behavior.

Annotations stay in this WebView's local storage. No MCP endpoint or webhook is configured; feedback is delivered by copy/paste. Orka currently uses one page URL, so include the Settings section and scenario in each note. The tool shares active confirmation dialogs' focus boundary.

For an explicitly local annotation bundle, build the frontend with `pnpm build -- --mode annotations` before bundling with a test Tauri config whose `beforeBuildCommand` is empty. The normal `pnpm build` and release builds exclude the annotation component and dependency. Annotation bundles are for internal testing only.

### Run checks

Settings recovery coverage lives in `tests/ui/settings-recovery.spec.ts`, alongside
the existing Settings suite. The state audit in `docs/settings-state-audit.md`
records the eight recovery fixes and four approved behavior decisions. Close and
quit requests use the same Save/Discard/Stay guard as in-app navigation; ordinary
drafts remain in memory rather than being stored across restarts. Browser reload
uses the platform's unsaved-changes warning.

Settings profile editing requires the API's `profile.conditionalSave: 1`
capability. The client reviews shared changes and saves against the confirmed
revision. Older services stay readable and require an update for editing.

Follow [CONTRIBUTING.md](../CONTRIBUTING.md). Unit and browser tests use synthetic fixtures. Native tests and `npm run test:profiles` exercise local desktop behavior without backend packages. Live authentication and sync need a running service; the public [server workspace](../server/README.md#direct-compose-and-development) includes backend integration suites and Compose instructions.

## Updating the shared protocol

The desktop uses the checksummed client protocol package recorded in `vendor/manifest.json`. Maintainers with access to backend release artifacts can run `npm run backend:update -- vX.Y.Z [release-directory]`. The updater verifies SHA-256 and npm integrity and imports only `@portable/protocol` into the desktop dependency graph. Server source and tooling live independently in `server/`; update that reviewed snapshot using the canonical export procedure in the [server source-update guide](../server/README.md#source-updates). Building either tree needs no private registry access.

## Plugin native acceptance

After building the debug executable, run `npm run test:plugin-native`. This uses separate native broker and thin stdio bridge processes, an in-memory test Keychain, a synthetic HTTP service and isolated agent homes. It exercises native approval/scopes/revocation, shared and local tools, account/service/sign-out roundtrips and old sessions, same-account app restart, and exact queued retries/complete skill installation. It uses no installed account or personal project. Pass `--binary` to `python3 -B scripts/plugin-native-acceptance.py` to select another debug executable. See the [plugin guide](../plugins/orka/README.md) for the one desktop login architecture.

Connector lifecycle coverage also starts concurrent helpers from one assistant and an independent parent with the same client label, checks shared consent and least scopes, rejects spoofed parent metadata, revokes all helpers together, and force-kills helpers before checking that active status and pending requests are cleared. Native process identities include their kernel start time, so PID reuse cannot revive a saved connection. Legacy approvals require an authenticated live helper before being displayed as connected.

## Native session storage benchmark

Run on macOS from the candidate checkout.

```sh
python3 -B scripts/benchmark-session-storage.py --base v0.3.25 --runs 3 \
  --output /tmp/orka-session-storage-results.json
```

The driver builds the same debug native harness against the pinned baseline and
candidate. It runs the desktop catalog, reader, exporter and selected-sharing
commands directly. Each repetition creates a fresh 96-session fixture, appends
12 turns to each of two long transcripts, and checks a Codex fork's ancestry.
A loopback service captures the selected request and blob bytes across a failed
attempt and process restart. A second loopback run checks how automatic sync
settles the latest edit after several offline scans. The upgrade fixture
benchmarks cleanup and verifies that the older binary can read its restored
pre-upgrade backup.

The JSON reports per-operation elapsed time, process disk-write counters, new
blob counts and bytes, and allocated bytes under the isolated profile. Peak RSS
is the process high-water mark, including work completed before each sample.
Cleanup time and peak RSS include the standalone command's startup. Filesystem
caches can stay warm across alternating runs of fresh profiles.
`--baseline-worktree` accepts
an owned, detached baseline checkout to reuse a warm Cargo build.
