# Subagent Reporter Plugin for OpenCode

A tiny OpenCode plugin that gives subagents a voice when run with `opencode run --format default`. Allows for better manual review when run attended or unattended. 

## What it does

- Streams subagent progress directly to stdout (instead of only showing that a subagent is running)
- Prefixes each line with agent name + instance number (example: `Explore 1:`)
- Shows tool activity with useful details (file path, command, skill name, etc.)
- Dedupes repeated identical tool calls in a row to reduce terminal noise
- Prints a clear finish marker when a subagent exits

## Why it helps

When prompts fan out into multiple subagents, default CLI output can feel opaque. This plugin makes subagent work visible and readable, so you can follow execution in real time without opening the TUI.

## Install

1. Put the plugin file at:

`~/.config/opencode/plugins/subagent-reporter.ts`

2. Make sure your global config exists at:

`~/.config/opencode/opencode.json`

3. Run normally:

`opencode run "your prompt" --format default`

That is it. No npm plugin entry is needed when loading from the local plugins directory.

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

