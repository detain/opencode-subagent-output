#!/usr/bin/env bash
#
# opencode-pipe-subagents — makes `opencode run "..." --pipe-subagents` stream
# subagent progress to the terminal on OpenCode V2.
#
# Why a wrapper: on V2 `opencode run` is a thin client to a separate server
# process, and the subagent-reporter plugin loads in that server, whose stdout
# is /dev/null. Plugins cannot add new CLI flags (the flag set is static in the
# binary). So this wrapper:
#   1. strips `--pipe-subagents` from the args,
#   2. points the plugin at a temp file (SUBAGENT_REPORTER_OUT) — the one
#      transport that works from the server process in DEFAULT mode (no
#      --standalone, no --print-logs, no log noise),
#   3. tails that file onto stdout in parallel with the run's own transcript,
#   4. cleans up and propagates the exit code.
#
# Without `--pipe-subagents` it is a transparent pass-through to `opencode run`.
#
# Requires the subagent-reporter plugin to be installed (see README). The
# opencode binary is taken from $OPENCODE_BIN or `opencode` on PATH.

set -euo pipefail

OC="${OPENCODE_BIN:-opencode}"

pipe=0
args=()
for a in "$@"; do
  if [ "$a" = "--pipe-subagents" ]; then
    pipe=1
    continue
  fi
  args+=("$a")
done

# No flag: behave exactly like `opencode run`.
if [ "$pipe" -ne 1 ]; then
  exec "$OC" run "${args[@]}"
fi

OUT="$(mktemp "${TMPDIR:-/tmp}/subagent-reporter.XXXXXX")"
trap 'rm -f "$OUT"' EXIT

# Match the plugin's output format to the run's format. The server process
# cannot see the client's --format flag, so detect it here from the args.
fmt=default
for a in "${args[@]}"; do
  case "$a" in
    --format=json) fmt=json ;;
    --format) fmt="__next__" ;;
  esac
done
# If --format was the last token before a value, pick it up.
if [ "$fmt" = "__next__" ]; then
  prev=""
  for a in "${args[@]}"; do
    if [ "$prev" = "--format" ]; then fmt="$a"; fi
    prev="$a"
  done
fi
[ "$fmt" = "json" ] || fmt=default

# Stream the plugin's report lines to stdout as they are written.
tail -n +1 -f "$OUT" &
TAIL_PID=$!

set +e
SUBAGENT_REPORTER_ENABLED=1 \
SUBAGENT_REPORTER_OUT="$OUT" \
SUBAGENT_REPORTER_FORMAT="$fmt" \
  "$OC" run "${args[@]}"
RC=$?
set -e

kill "$TAIL_PID" 2>/dev/null || true
wait "$TAIL_PID" 2>/dev/null || true
exit "$RC"
