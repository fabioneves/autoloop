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
  # A second review engine is opt-in per invocation (`/autoloop:dev with codex`),
  # so its absence is a NOTE and never a FAIL: a plain run asked for nothing that
  # needs it. Reported anyway, because "with codex" failing typed at the first
  # review of a finished unit is a worse place to learn this.
  if command -v codex >/dev/null 2>&1; then
    echo "INFO  codex present ($(codex --version 2>/dev/null | head -1)) — \`/autoloop:dev with codex\` can run reviews off the writer's model"
  else
    echo 'NOTE  codex not installed — a plain run is unaffected; `/autoloop:dev with codex` would fail its first review dispatch typed'
  fi
fi

# 2. Clean checkout (loop precondition; dirty is fine for interactive work)
dirty=$(git status --porcelain=v1 --untracked-files=all 2>/dev/null | wc -l)
if [ "$dirty" -eq 0 ]; then
  echo 'PASS  clean checkout'
else
  echo "NOTE  checkout has $dirty uncommitted path(s) — fine interactively; the loop requires a clean tree UNLESS this is a provably loop-owned in-flight unit (dirty on a gh-<N> branch with its open draft PR + claim-commit HEAD + in-boundary paths → adoption checkpoints and resumes). Otherwise it is a human's WIP: never stash/discard — stop and report."
fi

# 3. Vendored-tool drift. tools/agentic/* is a COPY taken the last time setup ran,
# so a released fix reaches this repo only when setup runs again — and if the fix
# is in a tool setup itself depends on, it can strand: a 0.42.1 command-guard
# refused the audit battery of the 0.42.3 setup that would have replaced it.
# Silent on any host without the Claude plugin cache; version comparison goes
# through the release helper because `sort -V` is absent on stock macOS.
vendored_prime="$REPO_DIR/tools/agentic/prime.mjs"
plugin_cache="$HOME/.claude/plugins/cache/autoloop/autoloop"
release_helper="$REPO_DIR/tools/agentic/release-verify.mjs"
if [ -f "$vendored_prime" ] && [ -d "$plugin_cache" ] && [ -f "$release_helper" ]; then
  vendored_version=$(sed -n "s/^const AUTOLOOP_VERSION = '\(.*\)';$/\1/p" "$vendored_prime" | head -1)
  newest_installed=$(ls -1 "$plugin_cache" 2>/dev/null \
    | run_timed 10 node "$release_helper" --sort-versions 2>/dev/null | tail -1)
  if [ -n "$vendored_version" ] && [ -n "$newest_installed" ]; then
    if [ "$vendored_version" = "$newest_installed" ]; then
      echo "PASS  vendored tools match the installed plugin (v$vendored_version)"
    else
      echo "NOTE  vendored tools on this checkout are v$vendored_version but v$newest_installed is installed — either setup has not run since the release, or this is a unit branch that forked before the reconcile landed on the base. A tool-level fix in v$newest_installed is NOT in effect here."
    fi
  fi
fi

# 4. Checkout identity. The hooks load `$CLAUDE_PROJECT_DIR/tools/agentic/*`, which
# is the WORKING TREE's copy — so the guard, this preflight, and the label hooks
# are whatever version the current branch happens to carry, no matter what a
# session audits against. A parked unit branch therefore runs the tools it forked
# with: observed three times in one day, where a fix that had shipped, installed
# and reconciled onto the base was still inert because the checkout predated it.
configured_base=$(sed -n 's/.*"baseBranch"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
  "$REPO_DIR/docs/agentic/STATE.md" 2>/dev/null | head -1)
current_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
if [ -n "$configured_base" ] && [ -n "$current_branch" ]; then
  if [ "$current_branch" = "$configured_base" ]; then
    echo "PASS  checkout is on the configured base ($configured_base)"
  else
    echo "NOTE  checkout is on '$current_branch', not the configured base '$configured_base' — hooks run THIS branch's tools/agentic/ copies, so any tool fix released since it forked is NOT in effect here. Setup and Dev both switch to the base on a clean tree; a dirty tree is human work — stop and report, never stash."
  fi
fi

# 5. Every role dispatch spawns a fresh engine process; there is nothing here to select.
echo 'INFO  role dispatch is one call — tools/agentic/dispatch.mjs --role <role>'

exit 0
