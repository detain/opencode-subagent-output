# Subagent Reporter Plugin for OpenCode

A tiny OpenCode plugin that gives subagents a voice when run with `opencode run --format default`. Allows for better manual review when run attended or unattended.

**Supports both OpenCode V1 and OpenCode V2 from a single file.** The plugin exports a V2 `Plugin.define({ id, setup })` definition plus a V1 `server()` method, so the same file loads on V2 (which reads `id`/`setup`) and on V1 `>= 1.18.29` (which calls `server()`). Each version's event stream is adapted to the shared reporting core, so output is identical on both.

## What it does

- Streams subagent progress directly to stdout (instead of only showing that a subagent is running)
- Prefixes each line with agent name + instance number (example: `Explore 1:`)
- Shows tool activity with useful details (file path, command, skill name, etc.)
- Dedupes repeated identical tool calls in a row to reduce terminal noise
- Prints a clear finish marker when a subagent exits

## Why it helps

When prompts fan out into multiple subagents, default CLI output can feel opaque. This plugin makes subagent work visible and readable, so you can follow execution in real time without opening the TUI.

## Install

**Option A — npm package (recommended):**

```sh
npm i -g opencode-subagent-output
```

This does two things automatically:

1. Installs the plugin so OpenCode can load it.
2. Runs a `postinstall` script that **detects your shell** (zsh / bash / fish /
   PowerShell) and installs a `opencode()` shell function into your rc file
   (`~/.zshrc`, `~/.bash_profile`, `~/.config/fish/config.fish`, or the
   PowerShell profile). The function is what makes `--pipe-subagents` work —
   see [How the shell function works](#how-the-shell-function-works).

Then register the plugin with OpenCode. Add it to the `plugins` array in
`~/.config/opencode/opencode.json` (V2) or `plugin` array (V1):

```json
{ "plugins": ["opencode-subagent-output"] }
```

Finally reload your shell:

```sh
source ~/.zshrc   # or restart your terminal
```

Now you can run:

```sh
opencode run "your prompt" --pipe-subagents
```

**Option B — local file (no npm):**

1. Put the plugin file at `~/.config/opencode/plugins/subagent-reporter.ts`
   (V2 discovers `plugins/`; V1 also reads `plugin/`).
2. Make sure `@opencode/plugin` is installed where the file can resolve it
   (e.g. `npm i @opencode/plugin` in that directory).
3. Manually add the shell function to your rc file (copy the block shown in
   [How the shell function works](#how-the-shell-function-works)), replacing
   `<package-dir>` with the directory that contains your copy of
   `scripts/opencode-pipe-subagents.sh`.

### Uninstall

```sh
npm rm -g opencode-subagent-output
```

The `preuninstall` hook removes the shell-function block from your rc file.
Then remove the plugin entry from `opencode.json` and reload your shell.

To remove just the shell function (keeping the package), run:

```sh
node <package-dir>/scripts/install.js uninstall
```

### How the shell function works

The `postinstall` script appends a marker-delimited block to your rc file:

```sh
# >>> opencode-subagent-output >>>
opencode() {
  local a
  for a in "$@"; do
    if [ "$a" = "--pipe-subagents" ]; then
      exec env OPENCODE_BIN="$(command -v opencode 2>/dev/null || echo "$HOME/.opencode/bin/opencode")" \
        bash "<package-dir>/scripts/opencode-pipe-subagents.sh" "$@"
    fi
  done
  command opencode "$@"
}
# <<< opencode-subagent-output <<<
```

It is a **function, not an alias** — an alias can't inspect its arguments. The
function scans the args; if `--pipe-subagents` is present it `exec`s the
wrapper script, otherwise it falls through to the real binary with
`command opencode` (the `command` builtin skips the function, so there's no
recursion). Re-running the installer is idempotent — it removes any existing
block (including legacy markers) before appending a fresh one, so updates never
duplicate it.

This is the same interception pattern the `opentmux` plugin uses, except the
arg-inspection lives in the shell function rather than a wrapper binary, so a
plain `opencode` call has zero overhead.

### Running on OpenCode V2

V2 changed the process model: `opencode run` is a thin **client** to a separate
**server** process, and the plugin loads in that server. The server's stdout is
`/dev/null`, so the plugin cannot write straight to your terminal the way it
could on V1. The `--pipe-subagents` wrapper solves this:

1. Strips `--pipe-subagents` from the args.
2. Runs with `--standalone` so the server is a **child** of the run and
   deterministically inherits `SUBAGENT_REPORTER_OUT` (the persistent
   background daemon would not).
3. Points the plugin at a temp file (`SUBAGENT_REPORTER_OUT`) — the one
   transport that works from the server process, with no `--print-logs` and no
   server log noise.
4. Tails that file onto stdout in parallel with the run's own transcript.
5. Cleans up and propagates the exit code.

It auto-detects `--format json` and emits NDJSON `{"type":"subagent",...}`
events. Without `--pipe-subagents` the wrapper is a transparent pass-through to
`opencode run`.

If `opencode` is not on the wrapper's PATH, set `OPENCODE_BIN=/path/to/opencode`.

#### Manual (no wrapper)

You can drive the plugin directly with environment variables:

```sh
# Plain text, via the server's stderr (needs --standalone --print-logs):
SUBAGENT_REPORTER_ENABLED=1 opencode run "your prompt" \
  --format default --standalone --print-logs 2>&1 | grep -vE '^timestamp='

# Or to a file (use --standalone so the server inherits the env var):
SUBAGENT_REPORTER_ENABLED=1 SUBAGENT_REPORTER_OUT=/tmp/subagents.txt \
  opencode run "your prompt" --format default --standalone
# then:  cat /tmp/subagents.txt
```

- `SUBAGENT_REPORTER_ENABLED=1` — required on V2. The server process is shared
  with the TUI and cannot tell `run` mode from TUI mode, so reporting is opt-in.
  (On V1 it is optional: `run` mode is auto-detected.)
- `SUBAGENT_REPORTER_OUT=<file>` — write report lines to a file. The cleanest
  V2 transport (no log noise). This is what the wrapper uses.
- Without a file, V2 writes to stderr, which only reaches the terminal under
  `--standalone --print-logs` (and that flag also dumps the server's own log
  lines — filter with `grep -vE '^timestamp='`).
- For `--format json`, set `SUBAGENT_REPORTER_FORMAT=json` — the server process
  cannot see the client's `--format` flag (the wrapper does this for you).

### Environment variables

- `SUBAGENT_REPORTER_FORMAT` — force `json` or `default` output. On V1 this is
  auto-detected from `--format json`; on V2 the server process cannot see the
  client flag, so set it explicitly for JSON output.
- `SUBAGENT_REPORTER_ENABLED` — force `1`/`true`/`on` to always report, or
  `0`/`false`/`off` to silence. On V1 it defaults to "report in `opencode run`
  mode only, silent in the TUI". On V2 it defaults to off (opt-in required).
- `SUBAGENT_REPORTER_OUT` — path to a file to append report lines to (V2).
  Takes priority over stdout/stderr. Used by the `--pipe-subagents` wrapper.

## Example output

```text
Explore 1: -> read /repo/src/agent/task.ts
Explore 1: -> grep message.part.updated
Explore 1: Found the relevant event handler in run.ts
Design 1: -> bash npm test
**** [DESIGN FINISHED] ****
Explore 1: Summarized findings and returned result
**** [EXPLORE FINISHED] ****
```

