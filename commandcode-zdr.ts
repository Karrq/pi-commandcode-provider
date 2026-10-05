/**
 * Command Code ZDR policy and retry
 *
 * /commandcode:zdr opens a settings editor for the `x-cmd-zdr` header that
 * pi-commandcode-provider sends. The upstream extension only reads CMD_ZDR=1
 * from the environment at registration time, so ZDR is either always on or
 * always off for the whole process. This owns the header per request instead.
 *
 * Three settings:
 *   - enforcement: on / off
 *   - exclusions:  model ids that never receive the header
 *   - on 422:      ask / fallback / block
 *
 * The provider rejects with HTTP 422 `cmd_zdr_no_providers` when no upstream
 * honours zero data retention for the requested model.
 *
 * How retry works: pi already retries failed requests in its own loop, and
 * every attempt runs `before_provider_headers` again. What it will not do is
 * retry these two errors, because its retryable-error check is a private
 * regex that matches neither. A `message_end` handler can replace a finalized
 * message in place, and pi reads the replacement when it decides whether to
 * retry. So this appends "try your request again" (a phrase that regex does
 * match) to the error text, and pi retries with its usual backoff and its
 * `retry.maxRetries` budget. `after_provider_response` cannot do this job: the
 * HTTP client throws on non-2xx before that hook fires.
 *
 * Two errors are made retryable:
 *   - ZDR rejection, resolved by the policy above, then retried without the header
 *   - "Provider returned an empty response" from Command Code, retried as-is
 *
 * Until the settings are saved for the first time the ZDR header is left
 * alone, so the CMD_ZDR environment variable keeps working. Empty-response
 * retry does not depend on the settings.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import { dirname, join } from "node:path"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { getSettingsListTheme } from "@earendil-works/pi-coding-agent"
import { Container, type SettingItem, SettingsList } from "@earendil-works/pi-tui"

const PROVIDER = "commandcode"
const ZDR_HEADER = "x-cmd-zdr"
const CONFIG_PATH = join(homedir(), ".pi", "agent", "commandcode-zdr.json")
const CACHE_PATH = join(homedir(), ".pi", "agent", "commandcode-models.json")

const ZDR_REJECTION = /cmd_zdr_no_providers|no zero-data-retention upstream/i
const EMPTY_RESPONSE = /empty response/i
/** Matches pi's retryable-error pattern ("try your request again"); see the header comment. */
const RETRY_HINT = " (try your request again)"

/** What to do when the provider refuses a request for lacking ZDR routing. */
type Policy = "ask" | "fallback" | "block"

interface ZdrConfig {
  enabled: boolean
  exclusions: string[]
  onUnsupported: Policy
  /**
   * Models seen to reject the header. Persisted so a model that 422s once is
   * not re-asked in every future session, which matters most for the free
   * models that never route to a ZDR upstream. Only the fallback policy and
   * an explicit "ask" answer write here; block never does, since that would
   * silently downgrade the next request.
   */
  rejected: string[]
}

const POLICIES: Policy[] = ["ask", "fallback", "block"]

const DEFAULT_CONFIG: ZdrConfig = {
  enabled: true,
  exclusions: [],
  onUnsupported: "ask",
  rejected: [],
}

function isPolicy(value: unknown): value is Policy {
  return typeof value === "string" && (POLICIES as string[]).includes(value)
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((entry): entry is string => typeof entry === "string"))]
    : []
}

function parseConfig(raw: string): ZdrConfig | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null
  const candidate = parsed as Partial<ZdrConfig>
  return {
    enabled: typeof candidate.enabled === "boolean" ? candidate.enabled : DEFAULT_CONFIG.enabled,
    exclusions: stringList(candidate.exclusions),
    onUnsupported: isPolicy(candidate.onUnsupported)
      ? candidate.onUnsupported
      : DEFAULT_CONFIG.onUnsupported,
    rejected: stringList(candidate.rejected),
  }
}

export default function commandCodeZdr(pi: ExtensionAPI) {
  /** null until the user saves settings once; Command Code keeps owning the header until then. */
  let config: ZdrConfig | null = readConfig()
  /** Hydrated from the config file so learned rejections survive a restart. */
  const rejected = new Set<string>(config?.rejected ?? [])
  /** Models the user released for this session only. Never written to disk. */
  const sessionAllow = new Set<string>()
  /** Models released for exactly the next request. Consumed by the header hook. */
  const onceAllow = new Set<string>()
  /** Set between before_provider_headers and the message_end for the same request. */
  let inflight: { modelId: string; sentZdr: boolean } | null = null

  function readConfig(): ZdrConfig | null {
    if (!existsSync(CONFIG_PATH)) return null
    try {
      return parseConfig(readFileSync(CONFIG_PATH, "utf8"))
    } catch {
      return null
    }
  }

  function saveConfig(next: ZdrConfig): void {
    // The in-memory set is the source of truth for rejections, so a settings
    // edit mid-session cannot write back a stale copy.
    const merged: ZdrConfig = { ...next, rejected: [...rejected] }
    mkdirSync(dirname(CONFIG_PATH), { recursive: true })
    writeFileSync(CONFIG_PATH, `${JSON.stringify(merged, null, 2)}\n`, "utf8")
    config = merged
  }

  function commandCodeModels(ctx: ExtensionContext): { id: string; name: string }[] {
    const fromRegistry = ctx.modelRegistry
      .getModelsOfType("chat", PROVIDER)
      .map((model) => ({ id: model.id, name: model.name }))
    if (fromRegistry.length > 0) return fromRegistry
    // The registry can still be empty before the provider extension loads its catalog.
    if (!existsSync(CACHE_PATH)) return []
    try {
      const cached = JSON.parse(readFileSync(CACHE_PATH, "utf8")) as {
        models?: { id: string; name: string }[]
      }
      return cached.models ?? []
    } catch {
      return []
    }
  }

  /** Whether the next request for this model carries the header. Consumes a one-shot release. */
  function sendZdrFor(modelId: string): boolean {
    if (!config || !config.enabled) return false
    if (onceAllow.delete(modelId)) return false
    if (config.exclusions.includes(modelId)) return false
    if (sessionAllow.has(modelId)) return false
    if (rejected.has(modelId)) return false
    return true
  }

  /**
   * Decide what to do about a ZDR rejection. Returns true when the request
   * should be retried (without the header), false to leave the error as is.
   */
  async function resolveRejection(
    ctx: ExtensionContext,
    activeConfig: ZdrConfig,
    modelId: string,
  ): Promise<boolean> {
    const reason = `Command Code has no ZDR upstream for ${modelId} (422 cmd_zdr_no_providers).`

    if (activeConfig.onUnsupported === "block") {
      ctx.ui.notify(`${reason} Policy is block, so the request stays failed.`, "error")
      return false
    }

    if (activeConfig.onUnsupported === "fallback") {
      rejected.add(modelId)
      saveConfig(activeConfig)
      ctx.ui.notify(`${reason} Retrying without ZDR, and remembering this model.`, "warning")
      return true
    }

    // With no UI, select() resolves undefined, which lands on block: the safe
    // answer for a ZDR setting.
    const choice = await ctx.ui.select(`${reason} How should this proceed?`, [
      "Retry this request without ZDR",
      "Retry without ZDR for the rest of the session",
      "Add model to exclusions and retry",
      "Block",
    ])
    switch (choice) {
      case "Retry this request without ZDR":
        onceAllow.add(modelId)
        return true
      case "Retry without ZDR for the rest of the session":
        sessionAllow.add(modelId)
        return true
      case "Add model to exclusions and retry":
        saveConfig({ ...activeConfig, exclusions: [...activeConfig.exclusions, modelId] })
        return true
      default:
        return false
    }
  }

  pi.on("before_provider_headers", async (event, ctx) => {
    if (!config) return
    const model = ctx.model
    if (!model || model.provider !== PROVIDER) return

    const send = sendZdrFor(model.id)
    inflight = { modelId: model.id, sentZdr: send }
    // A null value deletes the header instead of sending an empty string.
    event.headers[ZDR_HEADER] = send ? "1" : null
  })

  pi.on("message_end", async (event, ctx) => {
    const message = event.message
    if (message.role !== "assistant") return

    const pending = inflight
    inflight = null
    if (message.provider !== PROVIDER || message.stopReason !== "error" || !message.errorMessage)
      return

    const error = message.errorMessage
    const retryable = { message: { ...message, errorMessage: `${error}${RETRY_HINT}` } }

    if (EMPTY_RESPONSE.test(error)) return retryable

    if (!config || !pending?.sentZdr || !ZDR_REJECTION.test(error)) return
    return (await resolveRejection(ctx, config, pending.modelId)) ? retryable : undefined
  })

  /** Modal model picker used by the "+ exclude a model" row. */
  async function pickModel(ctx: ExtensionContext, base: ZdrConfig): Promise<string | undefined> {
    const available = commandCodeModels(ctx).filter((model) => !base.exclusions.includes(model.id))
    if (available.length === 0) {
      ctx.ui.notify("No Command Code models left to exclude", "warning")
      return undefined
    }
    const picked = await ctx.ui.select(
      "Models that never receive x-cmd-zdr",
      available.map((model) => model.name),
    )
    if (!picked) return undefined
    return available.find((model) => model.name === picked)?.id
  }

  pi.registerCommand("commandcode:zdr", {
    description: "Command Code zero-data-retention policy",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/commandcode:zdr requires TUI mode", "error")
        return
      }

      // Opening the editor is the opt-in that takes header ownership over.
      let current = config ?? { ...DEFAULT_CONFIG }
      const apply = (next: ZdrConfig) => {
        current = next
        saveConfig(next)
      }

      await ctx.ui.custom((tui, theme, _keybindings, done) => {
        const items: SettingItem[] = [
          {
            id: "enabled",
            label: "ZDR enforcement",
            description: "on: send x-cmd-zdr: 1 on Command Code requests that are not excluded.",
            currentValue: current.enabled ? "on" : "off",
            values: ["on", "off"],
          },
          {
            id: "onUnsupported",
            label: "When provider returns 422",
            description:
              "block: leave the request failed. fallback: retry without ZDR and remember the model. ask: prompt, then retry or stop.",
            currentValue: current.onUnsupported,
            values: POLICIES,
          },
          {
            id: "add",
            label: "+ exclude a model",
            description:
              "Never sends x-cmd-zdr, even when enforcement is on. Close and reopen to see the new row.",
            currentValue: `${current.exclusions.length} excluded`,
            values: ["open…"],
          },
        ]

        for (const modelId of current.exclusions) {
          items.push({
            id: `exclusion:${modelId}`,
            label: modelId,
            description: "Switch to enforced to send ZDR for this model again.",
            currentValue: "excluded",
            values: ["excluded", "enforced"],
          })
        }

        for (const modelId of rejected) {
          if (current.exclusions.includes(modelId)) continue
          items.push({
            id: `rejected:${modelId}`,
            label: modelId,
            description:
              "Rejected x-cmd-zdr with 422, so it is sent without. Switch to forget to test it again.",
            currentValue: "no zdr",
            values: ["no zdr", "forget"],
          })
        }

        const settingsList = new SettingsList(
          items,
          Math.min(items.length + 2, 15),
          getSettingsListTheme(),
          (id, newValue) => {
            if (id === "enabled") {
              apply({ ...current, enabled: newValue === "on" })
              return
            }
            if (id === "onUnsupported") {
              if (isPolicy(newValue)) apply({ ...current, onUnsupported: newValue })
              return
            }
            if (id.startsWith("exclusion:")) {
              const modelId = id.slice("exclusion:".length)
              apply({
                ...current,
                exclusions:
                  newValue === "excluded"
                    ? [...current.exclusions, modelId]
                    : current.exclusions.filter((entry) => entry !== modelId),
              })
              return
            }
            if (id.startsWith("rejected:")) {
              const modelId = id.slice("rejected:".length)
              if (newValue === "forget") rejected.delete(modelId)
              else rejected.add(modelId)
              apply({ ...current })
              return
            }
            if (id === "add") {
              void (async () => {
                const base = current
                const modelId = await pickModel(ctx, base)
                if (!modelId) return
                apply({ ...base, exclusions: [...base.exclusions, modelId] })
                ctx.ui.notify(`Excluded ${modelId}. Reopen to see it in the list.`, "info")
              })()
            }
          },
          () => done(undefined),
        )

        const container = new Container()
        container.addChild(
          new (class {
            render(_width: number) {
              return [theme.fg("accent", theme.bold("Command Code ZDR")), ""]
            }
            invalidate() {}
          })(),
        )
        container.addChild(settingsList)

        return {
          render(width: number) {
            return container.render(width)
          },
          invalidate() {
            container.invalidate()
          },
          handleInput(data: string) {
            settingsList.handleInput?.(data)
            tui.requestRender()
          },
        }
      })

      ctx.ui.notify(
        current.enabled ? `ZDR on, ${current.exclusions.length} model(s) excluded` : "ZDR off",
        "info",
      )
    },
  })
}
