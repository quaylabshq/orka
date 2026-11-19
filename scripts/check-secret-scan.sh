#!/usr/bin/env bash
# Proves .gitleaksignore hides only the known screenshot checksum finding.
# Commits a synthetic 64-hex credential in a non-image field of that same
# manifest under a temporary ref, scans all history in git mode, and expects
# exactly one finding: the synthetic one.
# Usage: scripts/check-secret-scan.sh path/to/gitleaks-8.30.1
set -euo pipefail
gitleaks=${1:?Pass the path to the Gitleaks 8.30.1 binary}
cd "$(git rev-parse --show-toplevel)"

ref="refs/orka-secret-scan/fixture-$$"
work=$(mktemp -d)
trap 'git update-ref -d "$ref" 2>/dev/null || true; rm -rf "$work"' EXIT

secret=$(openssl rand -hex 32)
manifest=pr-118/cf5ca64aa660d58ff2c62e487eae2d3bd71ab671/12264c70329c/capture.json
blob=$(printf '{"images":{},"api_key":"%s"}\n' "$secret" | git hash-object -w --stdin)
GIT_INDEX_FILE="$work/index" git update-index --add --cacheinfo "100644,$blob,$manifest"
tree=$(GIT_INDEX_FILE="$work/index" git write-tree)
commit=$(GIT_AUTHOR_NAME=fixture GIT_AUTHOR_EMAIL=fixture@invalid \
  GIT_COMMITTER_NAME=fixture GIT_COMMITTER_EMAIL=fixture@invalid \
  git commit-tree "$tree" -m "Secret scan fixture")
git update-ref "$ref" "$commit"

status=0
"$gitleaks" git . --log-opts="--all" --no-banner --max-archive-depth=2 \
  --report-format json --report-path "$work/report.json" >/dev/null 2>&1 || status=$?
if [ "$status" -ne 1 ]; then
  echo "Expected Gitleaks to report the synthetic credential (exit $status)" >&2
  exit 1
fi
python3 - "$work/report.json" "$commit" "$secret" <<'PY'
import json, sys
findings = json.load(open(sys.argv[1]))
summary = [(f["Commit"][:12], f["File"], f["RuleID"]) for f in findings]
if len(findings) != 1 or findings[0]["Commit"] != sys.argv[2] or findings[0]["Secret"] != sys.argv[3]:
    sys.exit(f"Expected only the synthetic credential, found: {summary}")
print(f"Secret scan fixture ok: synthetic credential reported, nothing else: {summary}")
PY
