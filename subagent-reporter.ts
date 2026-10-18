/**
 * Subagent Reporter — an OpenCode plugin that gives subagents a voice when run
 * with `opencode run ...`. It streams subagent progress to stdout, prefixes each
 * line with the agent name + instance number, shows tool activity with useful
 * details, dedupes repeated identical tool calls, and prints a finish marker.
 *
 * This file supports BOTH OpenCode V1 and OpenCode V2 from a single default
 * export:
 *   - V1 (>= 1.18.29) loads the `server()` method and uses the hooks it returns.
 *   - V2 reads the `id` + `setup(ctx)` (produced by `Plugin.define`) and ignores
 *     `server()`.
 * The two implementations share one state/reporting core (`makeState`); only the
 * event-shape adapters differ, because V2 renamed the event stream and moved the
 * payload from `event.properties` to `event.data`.
 */
import { Plugin } from "@opencode/plugin"

type SessionInfo = {
  parentID?: string
  agent?: string
}

type SubagentInfo = {
  depth: number
  instanceNum: number
  agentName: string
}

function toTitleCase(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase())
}

/**
 * Detect how opencode is rendering its output so we don't corrupt it:
 *   - "default": opencode prints human-readable text → we print plain lines.
 *   - "json":    opencode prints one NDJSON event per line → we MUST emit our
 *                own NDJSON events, or our plain lines break every consumer
 *                that JSON.parse()s each line.
 * Resolved from `--format json|--format=json` in argv, overridable via the
 * SUBAGENT_REPORTER_FORMAT env var ("json" | "default").
 */
function detectOutputMode(): "json" | "default" {
  const env = process.env?.SUBAGENT_REPORTER_FORMAT
  if (env === "json" || env === "default") {
    return env
  }
  const argv = Array.isArray(process.argv) ? process.argv : []
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--format=json") {
      return "json"
    }
    if (argv[i] === "--format" && argv[i + 1] === "json") {
      return "json"
    }
  }
  return "default"
}

/**
 * Decide whether it is safe to write our report lines to stdout.
 *
 * This reporter is only meaningful for the non-interactive `opencode run ...`
 * command, whose stdout IS the transcript. In the interactive TUI the very
 * same writes land in the raw terminal that opencode is actively drawing to
 * and shred the rendered UI — so there we must stay completely silent.
 *
 * Detection (works for both V1 and V2):
 *   - SUBAGENT_REPORTER_ENABLED overrides everything ("1"/"true"/"on" to force
 *     on, "0"/"false"/"off" to force off) for headless/serve setups that still
 *     want the stream, or to silence it entirely.
 *   - The TUI loads the plugin from a `.../tui/...` worker entry; never emit
 *     there.
 *   - Otherwise only enable when the `run` subcommand is present. Every other
 *     mode (tui/serve/web/acp/...) either renders its own UI or emits its own
 *     structured stream, so injecting plain lines would corrupt it.
 */
function isReportingEnabled(): boolean {
  const env = process.env?.SUBAGENT_REPORTER_ENABLED?.toLowerCase()
  if (env === "1" || env === "true" || env === "on") {
    return true
  }
  if (env === "0" || env === "false" || env === "off") {
    return false
  }

  const argv = Array.isArray(process.argv) ? process.argv : []

  const entry = typeof argv[1] === "string" ? argv[1] : ""
  if (entry.includes("/tui/")) {
    return false
  }

  return argv.includes("run")
}

/**
 * The shared reporting core. Both the V1 and V2 adapters normalize their
 * version-specific events into these plain callbacks, so all of the session
 * tree tracking, instance numbering, dedup, and stdout formatting lives here
 * exactly once.
 */
function makeState() {
  const OUTPUT_MODE = detectOutputMode()

  let rootSessionID: string | undefined

  const sessions = new Map<string, SessionInfo>()
  const subagents = new Map<string, SubagentInfo>()
  const instanceCounter = new Map<string, number>()

  const printedText = new Set<string>()
  const printedReasoning = new Set<string>()
  const toolStatus = new Map<string, string>()
  const lastToolSignatureBySession = new Map<string, string>()
  const finishedSessions = new Set<string>()

  const BOLD = "\u001b[1m"
  const RESET = "\u001b[0m"

  /**
   * Emit one report line. In "json" mode it writes a single self-contained
   * NDJSON event ({"type":"subagent",...}) so it interleaves cleanly with
   * opencode's own NDJSON stream; consumers that don't recognize the type
   * ignore it. In "default" mode it writes the original plain-text line.
   */
  function emit(subEvent: string, fields: Record<string, unknown>, plain: string) {
    if (OUTPUT_MODE === "json") {
      process.stdout.write(JSON.stringify({ type: "subagent", event: subEvent, ...fields }) + "\n")
    } else {
      process.stdout.write(plain.endsWith("\n") ? plain : plain + "\n")
    }
  }

  function isDescendantOfRoot(sessionID: string | undefined) {
    if (!sessionID || !rootSessionID) {
      return false
    }
    if (sessionID === rootSessionID) {
      return true
    }
    let cursor: string | undefined = sessionID
    const seen = new Set<string>()
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor)
      const parentID: string | undefined = sessions.get(cursor)?.parentID
      if (!parentID) {
        return false
      }
      if (parentID === rootSessionID) {
        return true
      }
      cursor = parentID
    }
    return false
  }

  function getDepth(sessionID: string) {
    let depth = 0
    let cursor: string | undefined = sessionID
    const seen = new Set<string>()
    while (cursor && !seen.has(cursor)) {
      seen.add(cursor)
      const parentID: string | undefined = sessions.get(cursor)?.parentID
      if (!parentID || parentID === rootSessionID) {
        return depth + 1
      }
      depth += 1
      cursor = parentID
    }
    return depth + 1
  }

  function assignSubagentInfo(sessionID: string) {
    if (!rootSessionID || sessionID === rootSessionID) {
      return
    }
    const session = sessions.get(sessionID)
    if (!session?.parentID || !isDescendantOfRoot(sessionID)) {
      return
    }

    const agentName = toTitleCase(session.agent ?? "Subagent")
    const parentKey = `${session.parentID}:${agentName}`

    if (subagents.has(sessionID)) {
      const info = subagents.get(sessionID)
      if (!info) {
        return
      }
      if (info.agentName !== agentName) {
        const nextCount = (instanceCounter.get(parentKey) ?? 0) + 1
        instanceCounter.set(parentKey, nextCount)
        info.agentName = agentName
        info.instanceNum = nextCount
      }
      return
    }

    const nextCount = (instanceCounter.get(parentKey) ?? 0) + 1
    instanceCounter.set(parentKey, nextCount)

    subagents.set(sessionID, {
      depth: getDepth(sessionID),
      instanceNum: nextCount,
      agentName,
    })
  }

  function prefixFor(sessionID: string) {
    const info = subagents.get(sessionID)
    if (!info) {
      return ""
    }
    return `${info.agentName} ${info.instanceNum}: `
  }

  function getField(input: Record<string, unknown>, keys: string[]) {
    for (const key of keys) {
      const value = input[key]
      if (typeof value === "string" && value.trim()) {
        return value.trim()
      }
    }
    return undefined
  }

  function summarizeToolInput(tool: string, rawInput: unknown) {
    const input = rawInput && typeof rawInput === "object" ? (rawInput as Record<string, unknown>) : {}

    if (tool === "read") {
      return getField(input, ["filePath", "path"])
    }
    if (tool === "bash") {
      return getField(input, ["description", "command"])
    }
    if (tool === "skill") {
      return getField(input, ["name"])
    }
    if (tool === "glob") {
      return getField(input, ["pattern", "path"])
    }
    if (tool === "grep") {
      return getField(input, ["pattern", "include", "path"])
    }
    if (tool === "task") {
      return getField(input, ["description", "subagent_type", "prompt"])
    }
    if (tool === "write" || tool === "edit") {
      return getField(input, ["filePath", "path"])
    }

    return getField(input, ["description", "name", "filePath", "path", "pattern", "query", "url", "prompt", "command"])
  }

  /** True when this session is a tracked subagent we should report on. */
  function isReportable(sessionID: string | undefined): sessionID is string {
    return !!sessionID && isDescendantOfRoot(sessionID) && subagents.has(sessionID)
  }

  function onSessionCreated(id: string, parentID: string | undefined) {
    if (!id) {
      return
    }
    sessions.set(id, { parentID })
    if (!rootSessionID && !parentID) {
      rootSessionID = id
      return
    }
    assignSubagentInfo(id)
  }

  function onAgentUpdated(sessionID: string | undefined, agent: string | undefined) {
    if (!sessionID) {
      return
    }
    const session = sessions.get(sessionID)
    if (!session) {
      sessions.set(sessionID, { agent })
    } else if (!session.agent && agent) {
      session.agent = agent
    }
    assignSubagentInfo(sessionID)
  }

  function onTool(sessionID: string | undefined, toolID: string, tool: string, input: unknown) {
    if (!isReportable(sessionID)) {
      return
    }
    const key = String(toolID)
    const nextStatus = "running"
    const prevStatus = toolStatus.get(key)
    if (nextStatus === prevStatus) {
      return
    }
    toolStatus.set(key, nextStatus)

    const prefix = prefixFor(sessionID)
    if (!prefix) {
      return
    }
    const info = subagents.get(sessionID)
    const agentName = info?.agentName ?? "Subagent"
    const instanceNum = info?.instanceNum ?? 1

    const detail = summarizeToolInput(String(tool), input)
    const signature = `${tool}|${detail ?? ""}`
    const prevSignature = lastToolSignatureBySession.get(sessionID)
    if (prevSignature === signature) {
      return
    }
    const detailText = detail ? ` ${BOLD}${detail}${RESET}` : ""
    emit(
      "tool",
      { agent: agentName, n: instanceNum, tool: String(tool), detail: detail ?? "", status: nextStatus },
      `${prefix}-> ${tool}${detailText}`,
    )
    lastToolSignatureBySession.set(sessionID, signature)
  }

  function onText(sessionID: string | undefined, partID: string, text: string) {
    if (!isReportable(sessionID)) {
      return
    }
    lastToolSignatureBySession.delete(sessionID)
    const trimmed = String(text ?? "").trim()
    if (!trimmed) {
      return
    }
    const key = `${partID}:${trimmed.length}`
    if (printedText.has(key)) {
      return
    }
    printedText.add(key)
    const prefix = prefixFor(sessionID)
    const info = subagents.get(sessionID)
    emit("text", { agent: info?.agentName, n: info?.instanceNum, text: trimmed }, `${prefix}${trimmed}`)
  }

  function onReasoning(sessionID: string | undefined, partID: string, text: string) {
    if (!isReportable(sessionID)) {
      return
    }
    lastToolSignatureBySession.delete(sessionID)
    const trimmed = String(text ?? "").trim()
    if (!trimmed) {
      return
    }
    const key = `${partID}:${trimmed.length}`
    if (printedReasoning.has(key)) {
      return
    }
    printedReasoning.add(key)
    const prefix = prefixFor(sessionID)
    const info = subagents.get(sessionID)
    emit("reasoning", { agent: info?.agentName, n: info?.instanceNum, text: trimmed }, `${prefix}Thinking: ${trimmed}`)
  }

  function onFinished(sessionID: string | undefined) {
    if (!sessionID || !subagents.has(sessionID) || finishedSessions.has(sessionID)) {
      return
    }
    finishedSessions.add(sessionID)
    const info = subagents.get(sessionID)
    if (info) {
      emit("finished", { agent: info.agentName, n: info.instanceNum }, `**** [${info.agentName.toUpperCase()} FINISHED] ****`)
    }
  }

  return { onSessionCreated, onAgentUpdated, onTool, onText, onReasoning, onFinished }
}

/**
 * V1 adapter: OpenCode V1's `event` hook delivers `{ type, properties }`.
 * Returns the V1 hooks object consumed by the `server()` entrypoint.
 */
function v1Hooks() {
  if (!isReportingEnabled()) {
    return {}
  }
  const state = makeState()

  return {
    event: async ({ event }: { event: any }) => {
      if (event.type === "session.created") {
        const info = event.properties?.info
        if (!info?.id) {
          return
        }
        state.onSessionCreated(info.id, info.parentID)
        return
      }

      if (event.type === "message.updated") {
        const info = event.properties?.info
        if (!info?.sessionID || info.role !== "assistant") {
          return
        }
        // V1 carries the agent name on assistant messages; register it so the
        // session tree (built from session.created) can label subagents.
        state.onAgentUpdated(info.sessionID, info.agent)
        return
      }

      if (event.type === "message.part.updated") {
        const part = event.properties?.part
        const sessionID = part?.sessionID
        if (!sessionID) {
          return
        }
        if (part?.type === "tool") {
          // V1 re-sends the part on every state change; the core dedupes by
          // (tool id, status) and by signature, so only the first "running"
          // and the first "completed" of a new call produce output.
          const nextStatus = String(part.state?.status ?? "")
          if (nextStatus === "running" || nextStatus === "completed") {
            state.onTool(sessionID, part.id, String(part.tool), part.state?.input)
          }
          return
        }
        if (part?.type === "text" && part.time?.end) {
          state.onText(sessionID, part.id, part.text)
          return
        }
        if (part?.type === "reasoning" && part.time?.end) {
          state.onReasoning(sessionID, part.id, part.text)
        }
        return
      }

      if (event.type === "session.status") {
        const statusSessionID = event.properties?.sessionID
        const statusType = event.properties?.status?.type
        if (statusType === "idle") {
          state.onFinished(statusSessionID)
        }
      }
    },
  }
}

/**
 * V2 adapter: OpenCode V2's `ctx.event.subscribe()` yields `{ type, data }`.
 * V2 renamed the event stream (no `message.*` events) and moved the payload
 * from `properties` to `data`. This maps those onto the shared core.
 */
function v2Setup(ctx: any) {
  if (!isReportingEnabled()) {
    // Interactive TUI (or any non-`run` mode): subscribe to nothing so we
    // never touch a terminal opencode is rendering.
    return () => {}
  }
  const state = makeState()
  // Tool names arrive on `session.tool.input.started` (data.name) and the tool
  // input arrives on `session.tool.called` (data.input); join them by tool id.
  const toolNameByID = new Map<string, string>()

  const controller = new AbortController()
  void (async () => {
    for await (const raw of ctx.event.subscribe({ signal: controller.signal })) {
      const event = raw as any
      const data = event?.data ?? {}
      switch (event?.type) {
        case "session.created":
          state.onSessionCreated(data.id, data.parentID)
          break
        case "session.step.started":
          state.onAgentUpdated(data.sessionID, data.agent)
          break
        case "session.tool.input.started":
          if (data.id) {
            toolNameByID.set(String(data.id), String(data.name ?? ""))
          }
          break
        case "session.tool.called":
          if (data.id && data.sessionID) {
            const name = toolNameByID.get(String(data.id)) ?? String(data.input?.name ?? "")
            state.onTool(data.sessionID, data.id, name, data.input)
          }
          break
        case "session.text.ended":
          state.onText(data.sessionID, data.assistantMessageID, data.text)
          break
        case "session.reasoning.ended":
          state.onReasoning(data.sessionID, data.assistantMessageID, data.text)
          break
        case "session.execution.succeeded":
        case "session.execution.failed":
        case "session.execution.interrupted":
          state.onFinished(data.sessionID)
          break
      }
    }
  })().catch(() => {
    /* stream closed; nothing to do */
  })

  return () => controller.abort()
}

// V2 default export: `id` + `setup` (from Plugin.define) plus the V1 `server()`
// method. V2 reads `id`/`setup` and ignores `server()`; V1 (>= 1.18.29) calls
// `server()` and ignores `setup`.
export default {
  ...Plugin.define({
    id: "subagent-reporter",
    setup: v2Setup,
  }),
  server: () => v1Hooks(),
}
