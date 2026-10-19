#!/usr/bin/env node
//
// Install / uninstall the `--pipe-subagents` shell function for the
// subagent-reporter plugin. Modeled on opentmux's postinstall installer:
// detect the shell, then idempotently manage a marker-delimited block in the
// shell rc file.
//
// The block defines a `opencode()` shell FUNCTION (not an alias — an alias
// can't inspect its arguments). The function routes `opencode … --pipe-subagents`
// to the wrapper script and passes every other invocation straight through to
// the real binary via `command opencode`.
//
//   node install.js install   (default) — add/refresh the block
//   node install.js uninstall  — remove the block

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const MARKER_START = "# >>> opencode-subagent-output >>>";
const MARKER_END = "# <<< opencode-subagent-output <<<";
// Legacy markers from earlier installs, removed for migration.
const LEGACY = [
  "# >>> opencode-subagent-output >>>",
  "# <<< opencode-subagent-output <<<",
];

const mode = (process.argv[2] || "install").toLowerCase();

function detectShell() {
  const shell = process.env.SHELL || "";
  const home = os.homedir();
  if (process.platform === "win32") {
    const dir = path.join(home, "Documents", "PowerShell");
    return {
      name: "powershell",
      rcFile: path.join(dir, "Microsoft.PowerShell_profile.ps1"),
      dir,
    };
  }
  if (shell.includes("zsh")) {
    return { name: "zsh", rcFile: path.join(home, ".zshrc") };
  }
  if (shell.includes("bash")) {
    const bashProfile = path.join(home, ".bash_profile");
    const bashrc = path.join(home, ".bashrc");
    return {
      name: "bash",
      rcFile: fs.existsSync(bashProfile) ? bashProfile : bashrc,
    };
  }
  if (shell.includes("fish")) {
    return {
      name: "fish",
      rcFile: path.join(home, ".config", "fish", "config.fish"),
    };
  }
  return { name: "unknown", rcFile: path.join(home, ".profile") };
}

// Resolve the wrapper script that ships with this package.
function resolveWrapperScript() {
  const pkgJson = path.join(__dirname, "..", "package.json");
  if (!fs.existsSync(pkgJson)) {
    return null;
  }
  const script = path.join(__dirname, "opencode-pipe-subagents.sh");
  return fs.existsSync(script) ? script : null;
}

function functionBlock(shellName, scriptPath) {
  if (shellName === "powershell") {
    return `
${MARKER_START}
# opencode --pipe-subagents interceptor (subagent-reporter plugin)
function opencode {
  if ($args -contains "--pipe-subagents") {
    & bash "${scriptPath}" @args
  } else {
    & opencode @args
  }
}
${MARKER_END}
`;
  }

  // zsh / bash / fish / unknown — POSIX function. `command opencode` calls the
  // real binary and skips this function (no recursion).
  return `
${MARKER_START}
# opencode --pipe-subagents interceptor (subagent-reporter plugin)
# A FUNCTION, not an alias — an alias can't inspect its arguments.
# "command opencode" calls the real binary and skips this function (no recursion).
opencode() {
  local a
  for a in "$@"; do
    if [ "$a" = "--pipe-subagents" ]; then
      exec env OPENCODE_BIN="$(command -v opencode 2>/dev/null || echo "$HOME/.opencode/bin/opencode")" \\
        bash "${scriptPath}" "$@"
    fi
  done
  command opencode "$@"
}
${MARKER_END}
`;
}

function stripBlock(content) {
  const re = new RegExp(
    `${escapeRe(MARKER_START)}[\\s\\S]*?${escapeRe(MARKER_END)}\\n?`,
    "g",
  );
  return content.replace(re, "");
}
function escapeRe(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function install() {
  const shell = detectShell();
  const scriptPath = resolveWrapperScript();
  console.log("");
  console.log("🔧 Setting up `--pipe-subagents` for opencode…");
  console.log(`   Detected shell: ${shell.name}`);
  console.log(`   Config file:    ${shell.rcFile}`);
  if (!scriptPath) {
    console.warn("   ⚠️  Wrapper script not found next to this package; skipping.");
    return;
  }
  console.log(`   Wrapper script: ${scriptPath}`);

  if (shell.dir && !fs.existsSync(shell.dir)) {
    fs.mkdirSync(shell.dir, { recursive: true });
  }
  if (!fs.existsSync(shell.rcFile)) {
    fs.writeFileSync(shell.rcFile, "", "utf-8");
  }

  let content = fs.readFileSync(shell.rcFile, "utf-8");
  // Remove any existing (current or legacy) block first, so re-install is idempotent.
  for (const marker of [MARKER_START, ...LEGACY]) {
    if (content.includes(marker)) {
      content = stripBlock(content);
    }
  }
  content = content + functionBlock(shell.name, scriptPath);
  fs.writeFileSync(shell.rcFile, content, "utf-8");

  console.log("   ✓ Shell function installed.");
  console.log("");
  console.log("   To activate now:  source " + shell.rcFile);
  console.log("   (or restart your terminal)");
  console.log("");
  console.log('   Usage:  opencode run "your prompt" --pipe-subagents');
  console.log("   Any other `opencode` call passes straight through to the real binary.");
  console.log("");
}

function uninstall() {
  const shell = detectShell();
  console.log("");
  console.log("🧹 Removing `--pipe-subagents` shell function…");
  console.log(`   Config file: ${shell.rcFile}`);
  if (!fs.existsSync(shell.rcFile)) {
    console.log("   Nothing to remove (rc file not found).");
    return;
  }
  let content = fs.readFileSync(shell.rcFile, "utf-8");
  let changed = false;
  for (const marker of [MARKER_START, ...LEGACY]) {
    if (content.includes(marker)) {
      content = stripBlock(content);
      changed = true;
    }
  }
  if (changed) {
    fs.writeFileSync(shell.rcFile, content, "utf-8");
    console.log("   ✓ Removed. Run `source " + shell.rcFile + "` to apply.");
  } else {
    console.log("   No installed block found — nothing to remove.");
  }
  console.log("");
}

try {
  if (mode === "uninstall") uninstall();
  else install();
} catch (err) {
  // Non-fatal: a failed rc edit should not break `npm install`.
  console.error("");
  console.error("⚠️  Failed to configure shell function:", err.message);
  console.error("");
}
