#!/usr/bin/env bash
# autoloop — dispatch-stream.sh
#
# One background task that IS its own watcher. The host streams a background
# shell's stdout into its task view natively; dispatch.mjs streams engine events
# to a live FILE while its own stdout stays silent, so a bare dispatch renders
# as a sealed box. This wrapper starts the dispatch in the background of its own
# shell, tails the live file to its own stdout — which the host renders live —
# and exits with the dispatch's exit code. No second tail task, no `$!` on the
# hook-guarded command line (the shell internals below are a reviewed program
# file, which is the sanctioned shape).
#
# Usage:
#   dispatch-stream.sh <live-file> <output-file> <dispatch args...>
#
# Example (background this whole command; watch its task view):
#   bash tools/agentic/dispatch-stream.sh \
#     /tmp/s/live/78-code-review-r1.jsonl /tmp/s/code-review-1-result.json \
#     --role code-review --prompt-file /tmp/s/p.md
#
# The typed result lands in <output-file>; stdout here is human-watchable event
# flow only — collect from the file, never by parsing this stream.

set -u

if [ "$#" -lt 3 ]; then
  echo "usage: dispatch-stream.sh <live-file> <output-file> <dispatch args...>" >&2
  exit 2
fi

live="$1"; shift
out="$1"; shift

self_dir="$(cd "$(dirname "$0")" && pwd)"
mkdir -p "$(dirname "$live")"
: > "$live"

node "$self_dir/dispatch.mjs" "$@" --live-file "$live" --output-file "$out" --json \
  > /dev/null 2>&1 &
dispatch_pid=$!

# --pid ends the tail when the dispatch exits, so the task closes itself.
tail --pid "$dispatch_pid" -n +1 -F "$live" 2>/dev/null

wait "$dispatch_pid"
status=$?
echo "dispatch-stream: dispatch exited $status · result at $out"
exit "$status"
