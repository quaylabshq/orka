"""Exercise the first Claude turn through the released T3 server and CLI."""

import argparse
import hashlib
import http.server
import json
import mmap
import os
import shlex
from pathlib import Path
import shutil
import socket
import sqlite3
import subprocess
import tempfile
import threading
import time
import uuid


MODEL = "claude-sonnet-4-6"
PROMPT = "Inspect the quartz routing marker in this checkout."
MEMORY_MARKER = "ORKA_T3_SHARED_QUARTZ_786"
USER_MARKER = "USER_LOCAL_CONTEXT_FIXTURE_534"
REPLY = "T3 first prompt fixture reply."
REPO_ROOT = Path(__file__).resolve().parents[1]


class AnthropicFixture(http.server.BaseHTTPRequestHandler):
    def log_message(self, *_args):
        pass

    def send(self, body, content_type="application/json"):
        payload = (
            json.dumps(body).encode() if content_type == "application/json" else body
        )
        self.send_response(200)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(payload)))
        self.end_headers()
        self.wfile.write(payload)

    def do_GET(self):
        self.send(
            {
                "data": [
                    {
                        "type": "model",
                        "id": MODEL,
                        "display_name": "Claude Sonnet 4.6",
                        "created_at": "2026-01-01T00:00:00Z",
                    }
                ],
                "has_more": False,
                "first_id": MODEL,
                "last_id": MODEL,
            }
        )

    def do_POST(self):
        request = self.rfile.read(int(self.headers.get("Content-Length", 0)))
        if self.path.split("?", 1)[0] != "/v1/messages":
            self.send({"input_tokens": 11})
            return
        if PROMPT.encode() in request:
            self.server.turns.append(
                (request.count(MEMORY_MARKER.encode()), USER_MARKER.encode() in request)
            )
        decoded = json.loads(request)
        message = {
            "id": "msg_t3_fixture",
            "type": "message",
            "role": "assistant",
            "model": decoded.get("model", MODEL),
            "content": [],
            "stop_reason": None,
            "stop_sequence": None,
            "usage": {"input_tokens": 11, "output_tokens": 1},
        }
        if not decoded.get("stream"):
            message.update(
                content=[{"type": "text", "text": REPLY}], stop_reason="end_turn"
            )
            self.send(message)
            return
        events = [
            ("message_start", {"message": message}),
            (
                "content_block_start",
                {"index": 0, "content_block": {"type": "text", "text": ""}},
            ),
            (
                "content_block_delta",
                {"index": 0, "delta": {"type": "text_delta", "text": REPLY}},
            ),
            ("content_block_stop", {"index": 0}),
            (
                "message_delta",
                {
                    "delta": {"stop_reason": "end_turn", "stop_sequence": None},
                    "usage": {"output_tokens": 6},
                },
            ),
            ("message_stop", {}),
        ]
        payload = "".join(
            f"event: {name}\ndata: {json.dumps(dict(fields, type=name))}\n\n"
            for name, fields in events
        ).encode()
        self.send(payload, "text/event-stream")


def run(command, env, *, cwd=None, input_text=None, timeout=30):
    process = subprocess.run(
        command,
        cwd=cwd,
        env=env,
        input=input_text,
        capture_output=True,
        text=True,
        timeout=timeout,
    )
    assert process.returncode == 0, (
        f"{command[0]} {command[1]} exited {process.returncode}\n"
        f"{process.stdout[-2000:]}\n{process.stderr[-2000:]}"
    )
    return process.stdout.strip()


def orka_test(binary, env, action, **values):
    result = json.loads(
        run(
            [binary, "--profile", "default", "--orka-test"],
            env,
            input_text=json.dumps({"action": action, **values}),
        )
    )
    assert "error" not in result, result
    return result


def seed_cached_projects(binary, env, sources, origin):
    root = Path(orka_test(binary, env, "profile-info")["root"])
    assert root == Path(env["ORKA_TEST_HOME"]) / "orka", root
    user = str(uuid.uuid4())
    # The first prompt uses Orka's cached resources. Seed that cache without creating a Keychain session.
    (root / "account").write_text(user)
    orka_test(binary, env, "snapshot")
    service_root = root / "services" / hashlib.sha256(origin.encode()).hexdigest()
    account_root = service_root / user
    assert (account_root / "sync.sqlite").is_file(), account_root

    memory = (
        f"Use the quartz routing marker {MEMORY_MARKER} for this checkout.\n".encode()
    )
    digest = hashlib.sha256(memory).hexdigest()
    legacy_service = root / "legacy-service.json"
    use_legacy_blobs = (
        legacy_service.is_file() and json.loads(legacy_service.read_text()) == origin
    )
    blobs = (root if use_legacy_blobs else service_root) / "blobs"
    blobs.mkdir(parents=True, exist_ok=True)
    (blobs / digest).write_bytes(memory)
    with sqlite3.connect(account_root / "sync.sqlite") as db:
        db.execute("INSERT INTO meta VALUES (?, ?)", ("user", json.dumps(user)))
        for source in sources:
            project = {
                "id": str(uuid.uuid4()),
                "name": "Fixture source",
                "path": str(source),
                "role": "owner",
                "sharing": {"memory": True},
            }
            resource = {
                "resourceId": str(uuid.uuid4()),
                "kind": "memory",
                "source": "claude",
                "logicalPath": "claude/quartz.md",
                "title": "Quartz routing marker",
                "files": [{"path": "content.md", "hash": digest, "size": len(memory)}],
                "revision": 1,
                "deleted": False,
            }
            db.execute(
                "INSERT INTO projects VALUES (?, ?)",
                (project["id"], json.dumps(project)),
            )
            db.execute(
                "INSERT INTO resources VALUES (?, ?, ?)",
                (resource["resourceId"], project["id"], json.dumps(resource)),
            )


def init_project(path, env, existing_orka_binary=None, *, disable_hooks=False):
    config = path / ".claude/settings.local.json"
    config.parent.mkdir(parents=True)
    # Keep the fixture's user settings in Git so T3 checks them out before Claude starts.
    payload = json.dumps(
        {
            "hookSpecificOutput": {
                "hookEventName": "UserPromptSubmit",
                "additionalContext": USER_MARKER,
            }
        }
    )
    hooks = [{"type": "command", "command": f"printf '%s\\n' {shlex.quote(payload)}"}]
    if existing_orka_binary is not None:
        # Simulate a previously installed worktree file hook running alongside the launch plugin.
        existing_command = shlex.join(
            [existing_orka_binary, "--profile", "default", "--orka-hook", "claude"]
        )
        hooks.append({"type": "command", "command": existing_command})
    user_settings = {"hooks": {"UserPromptSubmit": [{"hooks": hooks}]}}
    if disable_hooks:
        user_settings["disableAllHooks"] = True
    original = json.dumps(user_settings, indent=2).encode() + b"\n"
    config.write_bytes(original)
    run(["git", "init", "-b", "main"], env, cwd=path)
    run(["git", "add", "--", ".claude/settings.local.json"], env, cwd=path)
    run(["git", "commit", "-m", "Fixture user settings"], env, cwd=path)
    return original


def test_thread(
    binary,
    t3_home,
    env,
    fixture,
    source,
    branch,
    original,
    expected_context,
    *,
    expect_user_hook=True,
):
    run([binary, "project", "add", "--base-dir", str(t3_home), str(source)], env)
    previous_turns = len(fixture.turns)
    launched = json.loads(
        run(
            [
                binary,
                "thread",
                "start",
                "--base-dir",
                str(t3_home),
                "--provider",
                "claudeAgent",
                "--model",
                MODEL,
                "--worktree",
                "HEAD",
                "--branch",
                branch,
                "--wait",
                "--json",
                str(source),
                PROMPT,
            ],
            env,
            timeout=45,
        )
    )
    assert launched.get("status") == "completed" and REPLY in launched.get(
        "reply", ""
    ), launched
    assert len(fixture.turns) == previous_turns + 1, fixture.turns
    assert fixture.turns[-1] == (expected_context, expect_user_hook), fixture.turns
    worktrees = run(["git", "worktree", "list", "--porcelain"], env, cwd=source).split(
        "\n\n"
    )
    (actual_worktree,) = [
        Path(record.splitlines()[0].removeprefix("worktree "))
        for record in worktrees
        if f"branch refs/heads/{branch}" in record.splitlines()
    ]
    assert actual_worktree.is_relative_to(t3_home / "worktrees"), actual_worktree
    for checkout in (source, actual_worktree):
        assert (
            checkout / ".claude/settings.local.json"
        ).read_bytes() == original, checkout
    assert run(["git", "status", "--porcelain"], env, cwd=actual_worktree) == ""


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument(
        "--t3",
        default=os.environ.get("ORKA_T3_BIN"),
        help="extracted T3 Code 0.1.11 release executable; use ORKA_T3_BIN to set a default",
    )
    parser.add_argument(
        "--claude", default=shutil.which("claude"), help="Claude Code executable"
    )
    parser.add_argument(
        "--binary",
        default=REPO_ROOT / "apps/mac/src-tauri/target/debug/portable-workspace-mac",
        help="Orka debug executable",
    )
    args = parser.parse_args()
    for name in ("t3", "claude", "binary"):
        value = getattr(args, name)
        path = Path(value).resolve() if value else None
        if path is None or not path.is_file() or not os.access(path, os.X_OK):
            parser.error(f"--{name} must point to an executable")
        setattr(args, name, str(path))
    with open(args.t3, "rb") as binary:
        # The npm launcher downloads its runtime into a fresh T3 home. This fixture uses the release executable.
        if binary.read(2) == b"#!":
            parser.error(
                "--t3 must point to the extracted release executable, not the npm launcher"
            )
    with open(args.binary, "rb") as binary, mmap.mmap(
        binary.fileno(), 0, access=mmap.ACCESS_READ
    ) as binary_bytes:
        if binary_bytes.find(b"--orka-test") < 0:
            parser.error("--binary must point to an Orka debug executable")

    # A space in the fixture path also checks the launch argument's quoting.
    with tempfile.TemporaryDirectory(
        prefix="orka t3 worktree "
    ) as directory, http.server.ThreadingHTTPServer(
        ("127.0.0.1", 0), AnthropicFixture
    ) as fixture:
        fixture.turns = []
        fixture_thread = threading.Thread(target=fixture.serve_forever, daemon=True)
        fixture_thread.start()
        root = Path(directory).resolve()
        home = root / "home"
        claude_home = home / ".claude"
        claude_home.mkdir(parents=True)
        t3_home = root / "t3"
        settings = t3_home / "userdata/settings.json"
        settings.parent.mkdir(parents=True)
        origin = f"http://127.0.0.1:{fixture.server_port}"
        env = {
            "HOME": str(home),
            "ORKA_TEST_HOME": str(home),
            "CLAUDE_CONFIG_DIR": str(claude_home),
            "CODEX_HOME": str(home / ".codex"),
            "T3CODE_HOME": str(t3_home),
            "T3CODE_TELEMETRY_ENABLED": "false",
            "ANTHROPIC_BASE_URL": origin,
            "ANTHROPIC_API_KEY": "synthetic-test-key",
            "CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC": "1",
            "DISABLE_AUTOUPDATER": "1",
            "DISABLE_TELEMETRY": "1",
            "GIT_CONFIG_NOSYSTEM": "1",
            "GIT_CONFIG_GLOBAL": "/dev/null",
            "GIT_AUTHOR_NAME": "Orka Fixture",
            "GIT_AUTHOR_EMAIL": "fixture@example.invalid",
            "GIT_COMMITTER_NAME": "Orka Fixture",
            "GIT_COMMITTER_EMAIL": "fixture@example.invalid",
            "PATH": "/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin",
        }
        child = None
        try:
            assert run([args.t3, "--version"], env) == "t3 v0.1.11"
            connected = root / "connected"
            existing_hook = root / "existing-hook"
            disabled = root / "disabled-hooks"
            unrelated = root / "unrelated"
            connected_settings = init_project(connected, env)
            existing_hook_settings = init_project(existing_hook, env, args.binary)
            disabled_settings = init_project(disabled, env, disable_hooks=True)
            unrelated_settings = init_project(unrelated, env)

            orka_test(
                args.binary,
                env,
                "configure",
                config={"apiUrl": origin, "mode": "self-hosted", "syncMinutes": 5},
            )
            seed_cached_projects(
                args.binary, env, [connected, existing_hook, disabled], origin
            )
            plugin = Path(
                run(
                    [
                        args.binary,
                        "--profile",
                        "default",
                        "--orka-claude-worktree-plugin",
                    ],
                    env,
                )
            )
            assert (
                plugin.is_absolute()
                and (plugin / ".claude-plugin/plugin.json").is_file()
            ), plugin
            settings.write_text(
                json.dumps(
                    {
                        "providerInstances": {
                            "claudeAgent": {
                                "driver": "claudeAgent",
                                "enabled": True,
                                "config": {
                                    "binaryPath": args.claude,
                                    "launchArgs": f"--plugin-dir {json.dumps(str(plugin))}",
                                },
                            },
                            "codex": {"driver": "codex", "enabled": False},
                        }
                    }
                )
            )
            with socket.socket() as available:
                available.bind(("127.0.0.1", 0))
                t3_port = available.getsockname()[1]
            with (root / "server.log").open("w+") as log:
                child = subprocess.Popen(
                    [
                        args.t3,
                        "serve",
                        "--base-dir",
                        str(t3_home),
                        "--host",
                        "127.0.0.1",
                        "--port",
                        str(t3_port),
                    ],
                    cwd=connected,
                    env=env,
                    stdin=subprocess.DEVNULL,
                    stdout=log,
                    stderr=log,
                )
                try:
                    for _ in range(150):
                        if (t3_home / "userdata/server-runtime.json").is_file():
                            break
                        assert child.poll() is None, "T3 exited before readiness"
                        time.sleep(0.1)
                    else:
                        raise RuntimeError("T3 did not start")
                    test_thread(
                        args.t3,
                        t3_home,
                        env,
                        fixture,
                        connected,
                        "connected-fixture",
                        connected_settings,
                        expected_context=1,
                    )
                    test_thread(
                        args.t3,
                        t3_home,
                        env,
                        fixture,
                        existing_hook,
                        "overlap-fixture",
                        existing_hook_settings,
                        expected_context=1,
                    )
                    test_thread(
                        args.t3,
                        t3_home,
                        env,
                        fixture,
                        disabled,
                        "disabled-fixture",
                        disabled_settings,
                        expected_context=0,
                        expect_user_hook=False,
                    )
                    test_thread(
                        args.t3,
                        t3_home,
                        env,
                        fixture,
                        unrelated,
                        "unrelated-fixture",
                        unrelated_settings,
                        expected_context=0,
                    )
                except Exception:
                    log.seek(0)
                    print(log.read()[-3000:])
                    raise
            print(
                "T3 first-prompt context passed for connected, overlapping hook, disabled hooks, and unrelated worktrees."
            )
        finally:
            if child is not None:
                child.terminate()
                try:
                    child.wait(timeout=8)
                except subprocess.TimeoutExpired:
                    child.kill()
                    child.wait()
            fixture.shutdown()
            fixture_thread.join()


if __name__ == "__main__":
    main()
