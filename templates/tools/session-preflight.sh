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
  echo 'FAIL  node not installed — the vendored guard hooks (command-guard, writeback-check) cannot run'
else
  config_contract="$REPO_DIR/tools/agentic/config-contract.mjs"
  if [ -f "$config_contract" ]; then
    node "$config_contract" "$REPO_DIR/docs/agentic/STATE.md" 2>&1 || true
  else
    echo 'FAIL  tools/agentic/config-contract.mjs missing — re-run autoloop:setup before the loop runs'
  fi
fi

# 2. Clean main checkout (loop precondition; dirty is fine for interactive work)
dirty=$(git status --porcelain=v1 --untracked-files=all 2>/dev/null | wc -l)
if [ "$dirty" -eq 0 ]; then
  echo 'PASS  clean checkout'
else
  echo "NOTE  checkout has $dirty uncommitted path(s) — fine interactively; the loop's preflight requires a clean tree (never stash/discard someone's work — stop and report)"
fi

# 3. Engine profile reminder. config-contract validates the declared static host matrix; the skill
# performs active-host membership and capability checks (native named subagents on Codex, or
# direct `codex exec` when Claude hosts a codex profile).
if grep -q '"profile": *"codex"' docs/agentic/STATE.md 2>/dev/null; then
  echo 'INFO  engine profile is codex — Prime must verify this host is declared and its Codex dispatch surface is available'
  # Nested-sandbox check. Codex 0.145+ runs a trusted project under workspace-write (an OS
  # sandbox). The OS-enforced reviewer (`codex exec --sandbox read-only`) then cannot initialize
  # its own nested sandbox and dies at launch — which the loop misreads as an "engine outage"
  # and silently degrades to same-model host-thread review. Detect it without an API call: a
  # sandboxed session cannot write outside its workspace roots (repo, /tmp, $TMPDIR), so a write
  # to $HOME is blocked iff the orchestrator is sandboxed. (Claude+codex orchestrators run
  # unsandboxed → write succeeds → PASS, correctly.)
  if command -v codex >/dev/null 2>&1; then
    probe="$HOME/.autoloop_sandbox_probe.$$"
    if touch "$probe" 2>/dev/null; then
      rm -f "$probe"
      echo 'PASS  orchestrator not OS-sandboxed — the codex exec read-only reviewer can initialize'
    else
      echo 'FAIL  orchestrator is OS-sandboxed (cannot write outside the workspace) — the `codex exec --sandbox read-only` reviewer cannot initialize its nested sandbox and dies at launch, degrading every review to same-model host threads (the loop misreports this as an "engine outage"). Relaunch codex with `--sandbox danger-full-access`, or set `default_permissions = ":danger-full-access"` in ~/.codex/config.toml, then restart. (codex 0.145 trusted-project default is workspace-write.)'
    fi
  fi
fi

exit 0
