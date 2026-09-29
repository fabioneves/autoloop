#!/usr/bin/env bash
# SessionStart preflight for autoloop — mechanizes the checks the autoloop:dev
# skill's Prime step specifies as prose. Runs from the plugin (hooks/hooks.json).
#
# INFORMATIONAL: always exits 0. SessionStart hooks inject context, they don't gate —
# the autoloop:dev skill treats any FAIL line below as a preflight failure (stop and
# report). Every check is read-only and time-bounded so interactive sessions stay snappy.
#
# Plugin hooks fire in every repository: silent unless CLAUDE_PROJECT_DIR is a
# devendored autoloop repository (hook-root.mjs decides, for every hook alike).

TOOLS_DIR="$(cd "$(dirname "$0")" && pwd)"
PROJECT="${CLAUDE_PROJECT_DIR:-$(pwd)}"
REPO_DIR="$(git -C "$PROJECT" rev-parse --show-toplevel 2>/dev/null || printf %s "$PROJECT")"
cd "$REPO_DIR" || exit 0
if ! command -v node >/dev/null 2>&1; then
  if [ -e "$REPO_DIR/.autoloop/config.json" ]; then
    echo '## autoloop preflight'
    echo 'FAIL  node not installed — no autoloop tool can run'
  fi
  exit 0
fi
# Exit 1 is "not a guarded autoloop repository": stay silent. Anything else
# is the plugin failing, which an autoloop repository must hear about.
node "$TOOLS_DIR/command-guard.mjs" --guarded-root >/dev/null 2>&1
active=$?
if [ "$active" -ne 0 ]; then
  if [ "$active" -ne 1 ] && [ -e "$REPO_DIR/.autoloop/config.json" ]; then
    echo '## autoloop preflight'
    echo "FAIL  command-guard.mjs --guarded-root exited $active — the plugin cannot tell whether it guards this repository; reinstall it and restart the session"
  fi
  exit 0
fi

echo '## autoloop preflight'

# `timeout` is not universal (absent on stock macOS) — degrade to running untimed.
run_timed() { if command -v timeout >/dev/null 2>&1; then timeout "$@"; else shift; "$@"; fi; }

# 1. Toolchain: gh must exist and reach this repository; the config must validate.
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
node "$TOOLS_DIR/config-contract.mjs" --root "$REPO_DIR" 2>&1 || true
# The literal path every skill writes as <plugin-tools>: never a shell variable.
echo "INFO  plugin tools: $TOOLS_DIR"

# 2. Clean checkout (loop precondition; dirty is fine for interactive work)
dirty=$(git status --porcelain=v1 --untracked-files=all 2>/dev/null | wc -l)
if [ "$dirty" -eq 0 ]; then
  echo 'PASS  clean checkout'
else
  echo "NOTE  checkout has $dirty uncommitted path(s) — fine interactively; the loop requires a clean tree UNLESS this is a provably loop-owned in-flight unit (dirty on a gh-<N> branch with its open draft PR + claim-commit HEAD + in-boundary paths → adoption checkpoints and resumes). Otherwise it is a human's WIP: never stash/discard — stop and report."
fi

# 3. Hooks load at session start, so a plugin updated since then is not in
# effect until the session restarts. Silent outside the Claude plugin cache;
# version comparison goes through the release helper (`sort -V` is absent on
# stock macOS).
running_version=$(sed -n "s/^const AUTOLOOP_VERSION = '\(.*\)';$/\1/p" "$TOOLS_DIR/prime.mjs" | head -1)
plugin_cache="$HOME/.claude/plugins/cache/autoloop/autoloop"
if [ -n "$running_version" ] && [ -d "$plugin_cache" ]; then
  newest_installed=$(ls -1 "$plugin_cache" 2>/dev/null \
    | run_timed 10 node "$TOOLS_DIR/release-verify.mjs" --sort-versions 2>/dev/null | tail -1)
  if [ -n "$newest_installed" ] && [ "$newest_installed" != "$running_version" ]; then
    echo "NOTE  this session runs autoloop v$running_version but v$newest_installed is installed — restart the session to load it"
  fi
fi

# 3b. Proxied review recording sanity. A recording carrying `@<url>` is
# SELF-CONTAINED: dispatch.mjs reads that url and injects it as
# ANTHROPIC_BASE_URL into verdict dispatches itself, so how this session was
# launched is neither a prerequisite nor evidence. This check predated that
# (0.49.2) and kept reading the session environment, so it told every
# self-contained run that reviews would fail — and its remedy was worse than the
# non-problem: a session-wide ANTHROPIC_BASE_URL is inherited by EVERY dispatch
# child, including `implement` and `plan`, for which resolveDefaultBaseUrl
# deliberately returns null. Writers are never proxied; exporting it proxies
# them.
# 0.50.0: per-role routes supersede the review-engine recording whenever the
# routes file exists. dispatch injects each proxied route's own URL and strips a
# session-wide ANTHROPIC_BASE_URL from native routes, so the session variable is
# harmless there — but still worth naming, because non-dispatch tools inherit it.
routes_file="$(git rev-parse --git-path autoloop/routes 2>/dev/null)"
review_engine_file="$(git rev-parse --git-path autoloop/review-engine 2>/dev/null)"
if [ -n "$routes_file" ] && [ -f "$routes_file" ]; then
  echo "INFO  per-role routes ($routes_file) — review-engine is ignored while they exist:"
  sed -e '/^[[:space:]]*$/d' -e '/^#/d' -e 's/^/INFO    /' "$routes_file"
  if [ -n "${ANTHROPIC_BASE_URL:-}" ]; then
    echo "NOTE  ANTHROPIC_BASE_URL is set session-wide ($ANTHROPIC_BASE_URL); dispatch strips it from native routes and injects each proxied route's own URL"
  fi
elif [ -n "$review_engine_file" ] && [ -f "$review_engine_file" ]; then
  recorded="$(head -1 "$review_engine_file")"
  case "$recorded" in
    claude\ *)
      case "$recorded" in
        *@http://*|*@https://*)
          if [ -n "${ANTHROPIC_BASE_URL:-}" ]; then
            echo "NOTE  review-engine is self-contained ($recorded) AND ANTHROPIC_BASE_URL is set session-wide — every dispatch child inherits it, so writers are proxied too — right when that gateway passes Claude models through, otherwise unset it and let the recording route verdict roles alone"
          else
            echo "INFO  proxied reviews are self-contained: $recorded (dispatch injects the url; this session's environment is not used)"
          fi
          ;;
        *)
          if [ -z "${ANTHROPIC_BASE_URL:-}" ]; then
            echo "NOTE  review-engine records a proxied model ($recorded) with no @<url> and ANTHROPIC_BASE_URL is unset — nothing supplies the endpoint and reviews fail typed; append ' @<url>' to the recording to make it self-contained, or re-record 'claude'"
          else
            echo "NOTE  proxied reviews rely on this session's ANTHROPIC_BASE_URL ($ANTHROPIC_BASE_URL), which every dispatch child inherits — writers included; append ' @<url>' to the recording and unset it"
          fi
          ;;
      esac
      ;;
  esac
fi

# 4. Checkout identity: the loop starts from the configured base.
configured_base=$(sed -n 's/.*"baseBranch"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' \
  "$REPO_DIR/.autoloop/config.json" 2>/dev/null | head -1)
current_branch=$(git rev-parse --abbrev-ref HEAD 2>/dev/null)
if [ -n "$configured_base" ] && [ -n "$current_branch" ]; then
  if [ "$current_branch" = "$configured_base" ]; then
    echo "PASS  checkout is on the configured base ($configured_base)"
  else
    echo "NOTE  checkout is on '$current_branch', not the configured base '$configured_base' — Setup and Dev both switch to the base on a clean tree; a dirty tree is human work — stop and report, never stash."
  fi
fi

# 5. After a compaction a live run resumes from this card instead of re-reading
# its state (LFE, 2026-09-28: a 5-minute compaction mid step 10, then an 87 KB
# skill search to find its place). Silent unless this session's run is live.
run_timed 10 node "$TOOLS_DIR/step.mjs" --card-run 2>/dev/null || true

# 6. The repository's loop policy prose, injected every session.
for state in "$REPO_DIR/.autoloop/STATE.md" "$REPO_DIR/docs/agentic/STATE.md"; do
  if [ -f "$state" ]; then
    echo
    cat "$state"
    break
  fi
done

exit 0
