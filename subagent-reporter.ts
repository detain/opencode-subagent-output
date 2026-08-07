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
 * Observed process.argv (opencode 1.14.x):
 *   run mode : ["bun", ".../src/index.js", "run", "<message>", ...]
 *   TUI mode : ["bun", ".../src/cli/cmd/tui/worker.js"]   (loaded in a worker)
 *
 * Detection:
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

export default async function subagentStdoutReporter() {
  if (!isReportingEnabled()) {
    // Interactive TUI (or any non-`run` mode): register no hooks at all so we
    // never touch a terminal opencode is rendering. Zero overhead, zero risk.
    return {}
  }

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

  /**
   * Emit one report line. In "json" mode it writes a single self-contained
   * NDJSON event ({"type":"subagent",...}) so it interleaves cleanly with
   * opencode's own NDJSON stream; consumers that don't recognize the type
   * ignore it. In "default" mode it writes the original plain-text line.
   * `fields` are the structured payload; `plain` is the exact legacy text.
   */
  function emit(subEvent: string, fields: Record<string, unknown>, plain: string) {
    if (OUTPUT_MODE === "json") {
      process.stdout.write(JSON.stringify({ type: "subagent", event: subEvent, ...fields }) + "\n")
    } else {
      process.stdout.write(plain.endsWith("\n") ? plain : plain + "\n")
    }
  }

  const BOLD = "\u001b[1m"
  const RESET = "\u001b[0m"

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
      const parentID = sessions.get(cursor)?.parentID
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
      const parentID = sessions.get(cursor)?.parentID
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

    return (
      getField(input, ["description", "name", "filePath", "path", "pattern", "query", "url", "prompt", "command"]) ??
      undefined
    )
  }

  return {
    event: async ({ event }: { event: any }) => {
      if (event.type === "session.created") {
        const info = event.properties?.info
        if (!info?.id) {
          return
        }

        sessions.set(info.id, {
          parentID: info.parentID,
        })

        if (!rootSessionID && !info.parentID) {
          rootSessionID = info.id
          return
        }

        assignSubagentInfo(info.id)
        return
      }

      if (event.type === "message.updated") {
        const info = event.properties?.info
        if (!info?.sessionID || info.role !== "assistant") {
          return
        }

        const session = sessions.get(info.sessionID)
        if (!session) {
          sessions.set(info.sessionID, { agent: info.agent })
        } else if (!session.agent && info.agent) {
          session.agent = info.agent
        }

        assignSubagentInfo(info.sessionID)
        return
      }

      if (event.type !== "message.part.updated") {
        if (event.type === "session.status") {
          const statusSessionID = event.properties?.sessionID
          const statusType = event.properties?.status?.type
          if (
            statusSessionID &&
            statusType === "idle" &&
            subagents.has(statusSessionID) &&
            !finishedSessions.has(statusSessionID)
          ) {
            finishedSessions.add(statusSessionID)
            const info = subagents.get(statusSessionID)
            if (info) {
              emit(
                "finished",
                { agent: info.agentName, n: info.instanceNum },
                `**** [${info.agentName.toUpperCase()} FINISHED] ****`,
              )
            }
          }
        }
        return
      }

      const part = event.properties?.part
      const sessionID = part?.sessionID
      if (!sessionID || !isDescendantOfRoot(sessionID) || !subagents.has(sessionID)) {
        return
      }

      const prefix = prefixFor(sessionID)
      if (!prefix) {
        return
      }
      const info = subagents.get(sessionID)
      const agentName = info?.agentName ?? "Subagent"
      const instanceNum = info?.instanceNum ?? 1

      if (part.type === "tool") {
        const key = String(part.id)
        const nextStatus = String(part.state?.status ?? "")
        const prevStatus = toolStatus.get(key)

        if (nextStatus && nextStatus !== prevStatus && (nextStatus === "running" || nextStatus === "completed")) {
          toolStatus.set(key, nextStatus)
          const detail = summarizeToolInput(String(part.tool), part.state?.input)
          const signature = `${part.tool}|${detail ?? ""}`
          const prevSignature = lastToolSignatureBySession.get(sessionID)
          if (prevSignature !== signature) {
            const detailText = detail ? ` ${BOLD}${detail}${RESET}` : ""
            emit(
              "tool",
              { agent: agentName, n: instanceNum, tool: String(part.tool), detail: detail ?? "", status: nextStatus },
              `${prefix}-> ${part.tool}${detailText}`,
            )
            lastToolSignatureBySession.set(sessionID, signature)
          }
        }
        return
      }

      if (part.type === "text" && part.time?.end) {
        lastToolSignatureBySession.delete(sessionID)
        const text = String(part.text ?? "").trim()
        if (!text) {
          return
        }
        const key = `${part.id}:${part.time.end}`
        if (printedText.has(key)) {
          return
        }
        printedText.add(key)
        emit("text", { agent: agentName, n: instanceNum, text }, `${prefix}${text}`)
        return
      }

      if (part.type === "reasoning" && part.time?.end) {
        lastToolSignatureBySession.delete(sessionID)
        const text = String(part.text ?? "").trim()
        if (!text) {
          return
        }
        const key = `${part.id}:${part.time.end}`
        if (printedReasoning.has(key)) {
          return
        }
        printedReasoning.add(key)
        emit("reasoning", { agent: agentName, n: instanceNum, text }, `${prefix}Thinking: ${text}`)
      }
    },
  }
}
