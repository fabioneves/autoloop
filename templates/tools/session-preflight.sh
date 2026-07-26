#!/usr/bin/env bash
# SessionStart preflight for autoloop — mechanizes the checks the autoloop:dev
# skill's Prime step specifies as prose. Vendored by autoloop:setup.
#
# INFORMATIONAL: always exits 0. SessionStart hooks inject context, they don't gate —
# the autoloop:dev skill treats any FAIL line below as a preflight failure (stop and
# report). Every check is read-only and time-bounded so interactive sessions stay snappy.

REPO_DIR="$(cd "$(dirname "$0")/../.." && pwd)"
cd "$REPO_DIR" || exit 0

echo '## autoloop preflight (tools/agentic/session-preflight.sh)'

# `timeout` is not universal (absent on stock macOS) — degrade to running untimed.
run_timed() { if command -v timeout >/dev/null 2>&1; then timeout "$@"; else shift; "$@"; fi; }

# 1. Toolchain: gh + node must EXIST before anything else is meaningful
if ! command -v gh >/dev/null 2>&1; then
  echo 'FAIL  gh CLI not installed — install it (https://cli.github.com) and run `gh auth login`; the loop must not run'
elif run_timed 10 gh auth status >/dev/null 2>&1; then
  echo 'PASS  gh installed + authenticated'
  # Auth is not access: private repos / SSO can pass auth yet fail on this repo.
  if run_timed 10 gh repo view --json nameWithOwner >/dev/null 2>&1; then
    echo 'PASS  gh repo access'
  else
    echo 'NOTE  gh cannot resolve this repo (no access, SSO not authorized, or offline) — the loop must not run until this resolves'
  fi
else
  echo 'FAIL  gh installed but not authenticated — run `gh auth login`; the loop must not run'
fi
if ! command -v node >/dev/null 2>&1; then
  echo 'FAIL  node not installed — the vendored runtime contracts cannot run'
else
  config_contract="$REPO_DIR/tools/agentic/config-contract.mjs"
  release_contract="$REPO_DIR/tools/agentic/release-verify.mjs"
  dispatch_tool="$REPO_DIR/tools/agentic/dispatch.mjs"
  if [ -f "$config_contract" ]; then
    node "$config_contract" "$REPO_DIR/docs/agentic/STATE.md" 2>&1 || true
  else
    echo 'FAIL  tools/agentic/config-contract.mjs missing — re-run autoloop:setup before the loop runs'
  fi
  if [ -f "$release_contract" ]; then
    release_result=$(node "$release_contract" --self-test 2>&1)
    release_status=$?
    echo "$release_result" | tail -1
    if [ "$release_status" -ne 0 ]; then
      echo 'FAIL  release verification helpers failed their self-test — re-run autoloop:setup'
    fi
  else
    echo 'FAIL  tools/agentic/release-verify.mjs missing — re-run autoloop:setup before the loop runs'
  fi
  if [ -f "$dispatch_tool" ]; then
    echo 'PASS  dispatch tool present — role dispatch is available'
  else
    echo 'FAIL  tools/agentic/dispatch.mjs missing — no role can be dispatched'
  fi
fi

# 2. Clean checkout (loop precondition; dirty is fine for interactive work)
dirty=$(git status --porcelain=v1 --untracked-files=all 2>/dev/null | wc -l)
if [ "$dirty" -eq 0 ]; then
  echo 'PASS  clean checkout'
else
  echo "NOTE  checkout has $dirty uncommitted path(s) — fine interactively; the loop requires a clean tree UNLESS this is a provably loop-owned in-flight unit (dirty on a gh-<N> branch with its open draft PR + claim-commit HEAD + in-boundary paths → adoption checkpoints and resumes). Otherwise it is a human's WIP: never stash/discard — stop and report."
fi

# 3. Every role dispatch spawns a fresh engine process; there is nothing here to select.
echo 'INFO  role dispatch is one call — tools/agentic/dispatch.mjs --role <role>'

exit 0
