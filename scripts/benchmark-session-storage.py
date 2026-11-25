#!/usr/bin/env python3
"""Compare exact-release and candidate native session storage on macOS."""

import argparse
import collections
import contextlib
import hashlib
import http.server
import json
import os
import pathlib
import re
import shutil
import statistics
import subprocess
import sys
import tempfile
import threading
import time
import uuid


REPOSITORY = pathlib.Path(__file__).resolve().parents[1]
NATIVE = pathlib.Path("apps/mac/src-tauri")
BENCH_FILE = NATIVE / "src/session_storage_bench.rs"
TESTS_FILE = NATIVE / "src/tests.rs"
TEST_MODULE = (
    '#[cfg(target_os = "macos")]\n'
    '#[path = "session_storage_bench.rs"]\n'
    'mod session_storage_bench;\n'
)


def command(args, cwd=REPOSITORY, env=None, timeout=900):
    result = subprocess.run(
        args, cwd=cwd, env=env, text=True, capture_output=True, timeout=timeout
    )
    if result.returncode:
        if "--message-format=json" in args:
            for line in result.stdout.splitlines():
                item = json.loads(line)
                if item.get("reason") == "compiler-message":
                    sys.stderr.write(item["message"].get("rendered") or "")
        else:
            sys.stderr.write(result.stdout)
        sys.stderr.write(result.stderr)
        raise RuntimeError(f"{args[0]} exited with status {result.returncode}")
    return result


def git(*args, cwd=REPOSITORY):
    return command(["git", *args], cwd=cwd).stdout.strip()


@contextlib.contextmanager
def baseline_source(commit, owned_path):
    if owned_path is not None:
        if git("rev-parse", "HEAD", cwd=owned_path) != commit:
            raise RuntimeError("Benchmark baseline worktree has the wrong commit")
        yield owned_path
        return
    with tempfile.TemporaryDirectory(prefix="orka-storage-benchmark-source-") as parent:
        worktree = pathlib.Path(parent) / "base"
        git("worktree", "add", "--detach", str(worktree), commit)
        try:
            yield worktree
        finally:
            git("worktree", "remove", "--force", str(worktree))


def build(cargo, source, test):
    if not (source / "node_modules/@portable/protocol/fixtures/env-signature.json").is_file():
        command(["npm", "ci", "--prefer-offline"], cwd=source)
    args = [cargo, "test" if test else "build", "--locked", "--message-format=json"]
    if test:
        args.append("--no-run")
    built = command(args, cwd=source / NATIVE)
    results = []
    for line in built.stdout.splitlines():
        item = json.loads(line)
        if (
            item.get("reason") == "compiler-artifact"
            and item.get("target", {}).get("name") == "portable-workspace-mac"
            and item.get("executable")
        ):
            results.append(pathlib.Path(item["executable"]))
    if len(results) != 1:
        raise RuntimeError("Could not resolve the native benchmark executable")
    return results[0]


@contextlib.contextmanager
def service(automatic_root=None, automatic_result=None):
    """Match the native fixture HTTP/auth contract and record exact selected bytes."""
    selected = []
    uploaded = []
    failures = []
    pushes = []
    revisions = collections.Counter()
    blobs = {}
    if automatic_root is not None:
        project_id = str(uuid.UUID(int=4243))
        owner_id = str(uuid.UUID(int=4242))
        project = {"id": project_id, "name": "Session benchmark", "role": "owner",
                   "path": str(automatic_root), "policyRevision": 0, "lifecycleRevision": 0}

    class Handler(http.server.BaseHTTPRequestHandler):
        def log_message(self, *_):
            pass

        def respond(self, value, status=200):
            body = json.dumps(value, separators=(",", ":")).encode()
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def respond_blob(self, body):
            self.send_response(200)
            self.send_header("Content-Type", "application/octet-stream")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def automatic(self, body):
            if self.command == "POST" and self.path in ("/v2/devices", "/v2/devices/register"):
                self.respond({})
            elif self.command == "GET" and self.path == "/v2/devices":
                self.respond([])
            elif self.command == "GET" and self.path.startswith("/v2/projects/capabilities"):
                self.respond({"deviceHardware": 0, "selectedSharing": 1})
            elif self.command == "GET" and self.path.startswith("/v2/projects?"):
                self.respond([project])
            elif self.command == "GET" and self.path.startswith("/v2/sync/pull?"):
                self.respond({"events": [], "cursor": 1, "hasMore": False, "reset": False,
                              "policyRevision": 0, "requests": [], "presence": []})
            elif self.path.startswith("/v2/blobs/"):
                digest = self.path.rsplit("/", 1)[1]
                if self.command == "PUT":
                    assert digest == hashlib.sha256(body).hexdigest()
                    blobs[digest] = body
                    self.respond({})
                else:
                    self.respond_blob(blobs[digest])
            elif self.command == "POST" and self.path == "/v2/sync/push":
                push = json.loads(body)
                resource = push["resource"]
                assert push["projectId"] == project_id and resource["kind"] == "session"
                revisions[resource["resourceId"]] += 1
                pushes.append(blobs[resource["files"][0]["hash"]])
                resource = dict(resource, projectId=project_id, owner=owner_id,
                                revision=revisions[resource["resourceId"]],
                                updatedAt="2026-10-02T00:00:00Z")
                self.respond({"conflict": False, "event": {"resource": resource, "conflicts": []}})
            else:
                raise AssertionError(f"Unexpected automatic fixture route {self.command}")

        def reply(self):
            try:
                assert self.headers.get("Authorization") == "Bearer session-bench-fixture"
                body = self.rfile.read(int(self.headers.get("Content-Length", 0)))
                if automatic_root is not None:
                    self.automatic(body)
                elif self.command == "GET" and self.path == "/v2/projects/capabilities":
                    self.respond({"deviceHardware": 0, "selectedSharing": 1})
                elif self.command == "POST" and self.path == "/v2/devices":
                    self.respond({})
                elif self.command == "PUT" and self.path.startswith("/v2/blobs/"):
                    digest = hashlib.sha256(body).hexdigest()
                    assert self.path.rsplit("/", 1)[1] == digest
                    assert b"Approved fixture" in body
                    assert b"Synthetic append after the approved preview" not in body
                    uploaded.append(body)
                    self.respond({})
                elif self.command == "POST" and self.path == "/v2/sharing/selected":
                    selected.append(body)
                    change = json.loads(body)
                    expected = change["resource"]["files"]
                    assert len(expected) == 1 and expected[0]["hash"] == self.last_hash()
                    if len(selected) == 1:
                        self.respond({"error": "Synthetic transient service outage"}, 503)
                    else:
                        resource = dict(
                            change["resource"], projectId=change["projectId"], revision=1
                        )
                        self.respond({"status": "published", "receipt": {"event": {
                            "resource": resource, "conflicts": []
                        }}})
                else:
                    raise AssertionError("Unexpected native fixture route")
            except (AssertionError, KeyError, ValueError) as error:
                failures.append(error)
                self.respond({"error": "Unexpected native fixture request"}, 400)

        def last_hash(self):
            return hashlib.sha256(uploaded[-1]).hexdigest()

        do_GET = do_POST = do_PUT = reply

    with http.server.ThreadingHTTPServer(("127.0.0.1", 0), Handler) as server:
        worker = threading.Thread(target=server.serve_forever, daemon=True)
        worker.start()
        try:
            yield f"http://127.0.0.1:{server.server_port}"
        finally:
            server.shutdown()
            worker.join()
    assert not failures, failures
    if automatic_root is not None:
        assert pushes and b"Automatic fixture final unsent append" in pushes[-1]
        automatic_result["serverPushes"] = len(pushes)
    else:
        assert len(selected) == len(uploaded) == 2
        assert selected[0] == selected[1], "Selected requests changed across restart"
        assert uploaded[0] == uploaded[1], "Approved snapshot bytes changed across restart"


def test(binary, phase, home=None, origin=None):
    environment = dict(os.environ)
    if home is not None:
        environment.update(ORKA_SESSION_BENCH_HOME=str(home), ORKA_SESSION_BENCH_ORIGIN=origin)
    output = command([
        str(binary), f"tests::session_storage_bench::{phase}",
        "--exact", "--ignored", "--nocapture", "--test-threads=1",
    ], env=environment, timeout=180).stdout
    assert "1 passed; 0 failed" in output, output
    samples = []
    fixture = None
    for line in output.splitlines():
        if "ORKA_FIXTURE " in line:
            fixture = json.loads(line.split("ORKA_FIXTURE ", 1)[1])
        elif "ORKA_BENCH " in line:
            samples.append(json.loads(line.split("ORKA_BENCH ", 1)[1]))
    return fixture, samples


def execute(binary, run, runs, label):
    print(f"{label} fixture {run}/{runs}", file=sys.stderr, flush=True)
    fixture, browse = test(binary, "browse")
    with tempfile.TemporaryDirectory(prefix="orka-storage-benchmark-share-") as home, service() as origin:
        _, initial = test(binary, "share_first", home, origin)
        _, retry = test(binary, "share_retry", home, origin)
    automatic_result = {}
    with tempfile.TemporaryDirectory(prefix="orka-storage-benchmark-sync-") as home:
        root = pathlib.Path(home, "project").resolve()
        with service(automatic_root=root, automatic_result=automatic_result) as origin:
            automatic_fixture, automatic = test(binary, "automatic_sync", home, origin)
    automatic_fixture.update(automatic_result)
    return {"fixture": fixture, "browse": browse, "share": initial + retry,
            "automaticFixture": automatic_fixture, "automatic": automatic}


def allocated(root):
    return sum(path.stat().st_blocks * 512 for path in root.rglob("*") if path.is_file())


def cleanup(binary, home, apply):
    switches = ["--apply"] if apply else []
    root = home / "orka"
    before = allocated(root)
    env = dict(os.environ, ORKA_TEST_HOME=str(home))
    # The utility is a separate process. /usr/bin/time reports macOS peak RSS in bytes.
    start = time.monotonic()
    result = command([
        "/usr/bin/time", "-l", str(binary), "--profile", "default",
        "--orka-clean-session-blobs", *switches,
    ], env=env, timeout=120)
    elapsed = (time.monotonic() - start) * 1_000
    peak = re.search(r"(?m)^\s*(\d+)\s+maximum resident set size", result.stderr)
    assert peak, result.stderr
    data = json.loads(result.stdout)
    return {"report": data, "elapsedMs": elapsed, "processPeakRssBytes": int(peak[1]),
            "allocatedBeforeBytes": before, "allocatedAfterBytes": allocated(root)}


def run_upgrade(base, candidate, utility):
    with tempfile.TemporaryDirectory(prefix="orka-storage-benchmark-upgrade-") as folder:
        parent = pathlib.Path(folder)
        home = parent / "home"
        home.mkdir()
        origin = "http://127.0.0.1:1"
        test(base, "upgrade_fixture", home, origin)
        backup = parent / "pre-upgrade-backup"
        shutil.copytree(home, backup)
        _, migrated = test(candidate, "upgraded_read", home, origin)
        assert all(sample["newBlobCount"] == 0 for sample in migrated)
        dry_run = cleanup(utility, home, apply=False)
        dry_scopes = dry_run["report"]["scopes"]
        eligible = sum(scope["eligibleCount"] for scope in dry_scopes)
        assert eligible > 0, dry_run
        assert dry_run["allocatedBeforeBytes"] == dry_run["allocatedAfterBytes"], dry_run
        apply = cleanup(utility, home, apply=True)
        assert sum(scope["removedCount"] for scope in apply["report"]["scopes"]) == eligible, apply
        second = cleanup(utility, home, apply=True)
        assert sum(scope["eligibleCount"] + scope["removedCount"] for scope in second["report"]["scopes"]) == 0, second
        _, upgraded = test(candidate, "upgraded_read", home, origin)
        # An older data epoch is only compatible with its full pre-upgrade data.
        # Restore to the same path so the saved native transcript locators hold.
        home.rename(parent / "upgraded-home")
        backup.rename(home)
        _, restored = test(base, "upgraded_read", home, origin)
        return {"dryRun": dry_run, "apply": apply, "secondApply": second,
                "candidateUpgradeRead": migrated, "candidateReadAfterCleanup": upgraded,
                "preUpgradeBackupRestoreRead": restored}


def summary(runs):
    phases = collections.defaultdict(list)
    for run in runs:
        for sample in run["browse"] + run["share"] + run["automatic"]:
            phases[sample["phase"]].append(sample)
    def stats(key, samples):
        values = [sample[key] for sample in samples]
        return {"median": statistics.median(values), "min": min(values), "max": max(values)}
    return {
        phase: {"samples": len(samples), **{
            key: stats(key, samples) for key in
            ["elapsedMs", "processPeakRssBytes", "processDiskWritesBytes", "newBlobCount",
             "newBlobBytes", "allocatedDeltaBytes", "allocatedBytes"]
        }} for phase, samples in phases.items()
    }


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--base", default="v0.3.25")
    parser.add_argument("--baseline-worktree", type=pathlib.Path,
                        help="Existing disposable baseline worktree for cached builds")
    parser.add_argument("--runs", type=int, default=3)
    parser.add_argument("--baseline-only", action="store_true")
    parser.add_argument("--skip-cleanup", action="store_true")
    parser.add_argument("--output", type=pathlib.Path)
    options = parser.parse_args()
    if sys.platform != "darwin" or options.runs < 1:
        parser.error("Run on macOS with a positive repeat count")
    cargo = shutil.which("cargo") or str(pathlib.Path.home() / ".cargo/bin/cargo")
    base = git("rev-parse", f"{options.base}^{{commit}}")
    candidate = git("rev-parse", "HEAD")
    with baseline_source(base, options.baseline_worktree) as source:
        if source.resolve() == REPOSITORY:
            parser.error("The baseline must use a separate disposable checkout")
        # Copy the test-only driver into the requested source. Compare all other
        # tracked baseline files with the pinned commit before building.
        changed = set(git("diff", "--name-only", "HEAD", "--", cwd=source).splitlines())
        untracked = set(git("ls-files", "--others", "--exclude-standard", cwd=source).splitlines())
        if untracked - {str(BENCH_FILE)}:
            parser.error("The baseline worktree contains unrelated untracked files")
        if changed - {str(TESTS_FILE)}:
            parser.error("The baseline worktree contains changes beyond the benchmark hook")
        pinned = git("show", f"{base}:{TESTS_FILE}") + "\n"
        current = (source / TESTS_FILE).read_text()
        if current.replace(TEST_MODULE, "", 1) != pinned:
            parser.error("The baseline worktree's test wiring differs beyond the benchmark hook")
        hook_point = '#[path = "sync_request_tests.rs"]'
        assert hook_point in pinned
        (source / TESTS_FILE).write_text(pinned.replace(hook_point, TEST_MODULE + hook_point, 1))
        shutil.copyfile(REPOSITORY / BENCH_FILE, source / BENCH_FILE)
        print(f"Building {base} native benchmark", file=sys.stderr, flush=True)
        baseline = build(cargo, source, test=True)
        head = utility = None
        candidate_dirty = bool(git("status", "--porcelain"))
        if not options.baseline_only:
            print(f"Building {candidate} native benchmark", file=sys.stderr, flush=True)
            head = build(cargo, REPOSITORY, test=True)
            if not options.skip_cleanup:
                utility = build(cargo, REPOSITORY, test=False)
        baselines, candidates = [], []
        for run in range(1, options.runs + 1):
            order = [(baseline, "baseline", baselines)]
            if head is not None:
                order.append((head, "candidate", candidates))
            if run % 2 == 0:
                order.reverse()
            for binary, label, samples in order:
                samples.append(execute(binary, run, options.runs, label))
        report = {"base": base, "build": "native debug test executable, unoptimized",
                  "machine": command(["sysctl", "-n", "machdep.cpu.brand_string"]).stdout.strip(),
                  "ramBytes": int(command(["sysctl", "-n", "hw.memsize"]).stdout),
                  "os": command(["sw_vers"]).stdout.strip(),
                  "cargo": command([cargo, "--version"]).stdout.strip(),
                  "warmup": "Fresh profiles, OS file cache may be warm, sequential alternating trials",
                  "baselineRuns": baselines, "baselineSummary": summary(baselines)}
        if head is not None:
            for run in candidates:
                assert all(sample["newBlobCount"] == 0 for sample in run["browse"]), run
                assert run["automaticFixture"] == {"queuedLatestUnsent": True, "serverPushes": 1}, run["automaticFixture"]
            report.update(candidate=candidate, candidateDirty=candidate_dirty,
                          candidateRuns=candidates, candidateSummary=summary(candidates))
            if utility is not None:
                report["cleanup"] = [run_upgrade(baseline, head, utility) for _ in range(options.runs)]
    serialized = json.dumps(report, indent=2) + "\n"
    if options.output:
        with options.output.open("x") as destination:
            destination.write(serialized)
    else:
        print(serialized, end="")


if __name__ == "__main__":
    main()
