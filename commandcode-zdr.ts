/**
 * Command Code ZDR policy and retry
 *
 * /commandcode:zdr opens a settings editor for the `x-cmd-zdr` header that
 * pi-commandcode-provider sends. The upstream extension only reads CMD_ZDR=1
 * from the environment at registration time, so ZDR is either always on or
 * always off for the whole process. This owns the header per request instead.
 *
 * The decision is published to the provider transport (src/zdr-state.ts), which
 * is the only path every request takes. That includes the worker agent loops
 * that other extensions drive directly and that never run pi's
 * `before_provider_headers` hook, so those honor the same policy.
 *
 * Settings live under the `commandcode-zdr` key of pi's settings.json, the
 * same place pi reads its own configuration:
 *   - global:  <agent-dir>/settings.json
 *   - project: <cwd>/.pi/settings.json, read only when the project is trusted,
 *     and overriding the global namespace field by field
 *
 * Three settings:
 *   - enforcement: on / off
 *   - exclusions:  model ids that never receive the header
 *   - on 422:      ask / fallback / block
 *
 * The provider rejects with HTTP 422 `cmd_zdr_no_providers` when no upstream
 * honours zero data retention for the requested model.
 *
 * How retry works: pi already retries failed requests in its own loop, and the
 * transport re-runs the decider on each attempt. What it will not do is retry
 * these two errors, because its retryable-error check is a private regex that
 * matches neither. A `message_end` handler can replace a finalized message in
 * place, and pi reads the replacement when it decides whether to retry. So this
 * appends "try your request again" (a phrase that regex does match) to the
 * error text, and pi retries with its usual backoff and its `retry.maxRetries`
 * budget. `after_provider_response` cannot do this job: the HTTP client throws
 * on non-2xx before that hook fires.
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
import { dirname, join } from "node:path"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { getAgentDir, getSettingsListTheme } from "@earendil-works/pi-coding-agent"
import { Container, type SettingItem, SettingsList } from "@earendil-works/pi-tui"
import { setCommandCodeZdrDecider } from "./src/zdr-state.ts"

const PROVIDER = "commandcode"
/** Namespace inside settings.json: `"commandcode-zdr": { ... }`. */
const SETTINGS_KEY = "commandcode-zdr"
/** Pre-settings.json config location, read once to migrate an existing config. */
const LEGACY_CONFIG_FILE = "commandcode-zdr.json"
const CACHE_PATH = join(getAgentDir(), "commandcode-models.json")

const ZDR_REJECTION = /cmd_zdr_no_providers|no zero-data-retention upstream/i
const EMPTY_RESPONSE = /empty response/i
/** Matches pi's retryable-error pattern ("try your request again"); see the header comment. */
const RETRY_HINT = " (try your request again)"

/** What to do when the provider refuses a request for lacking ZDR routing. */
type Policy = "ask" | "fallback" | "block"

/** Which file the settings editor writes. */
type ZdrScope = "global" | "project"

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

/** A config file as written: every field optional so scopes can merge. */
interface ZdrConfigFile {
  enabled?: boolean
  exclusions?: string[]
  onUnsupported?: Policy
  rejected?: string[]
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

/** Only present, valid fields are kept so a project scope can override a subset. */
function parseConfigObject(value: unknown): ZdrConfigFile | null {
  if (typeof value !== "object" || value === null) return null
  const candidate = value as Partial<ZdrConfigFile>
  const file: ZdrConfigFile = {}
  if (typeof candidate.enabled === "boolean") file.enabled = candidate.enabled
  if (isPolicy(candidate.onUnsupported)) file.onUnsupported = candidate.onUnsupported
  if (candidate.exclusions !== undefined) file.exclusions = stringList(candidate.exclusions)
  if (candidate.rejected !== undefined) file.rejected = stringList(candidate.rejected)
  return file
}

/** Global scope is pi's agent-directory settings.json. */
function globalSettingsPath(): string {
  return join(getAgentDir(), "settings.json")
}

/** Project scope is pi's working-directory .pi/settings.json. */
function projectSettingsPath(cwd: string): string {
  return join(cwd, ".pi", "settings.json")
}

function readSettingsObject(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, "utf8").replace(/^\uFEFF/, "")
    const parsed = JSON.parse(raw)
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** Read the `commandcode-zdr` namespace from a settings.json, if present. */
function readNamespaced(path: string): ZdrConfigFile | null {
  const settings = readSettingsObject(path)
  if (!settings) return null
  return parseConfigObject(settings[SETTINGS_KEY])
}

/**
 * Write the namespace back into a settings.json, preserving every other key pi
 * stores there. pi's own writer spreads the current file before applying its
 * changes, so the namespace survives later pi settings writes too. Returns
 * false instead of overwriting a settings file that exists but cannot be
 * parsed, which would discard pi's configuration.
 */
function writeNamespaced(path: string, config: ZdrConfig): boolean {
  const existing = readSettingsObject(path)
  if (existing === null && existsSync(path)) return false
  const settings = existing ?? {}
  settings[SETTINGS_KEY] = config
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8")
    return true
  } catch {
    return false
  }
}

/** Pre-settings.json location, read once to migrate an existing config. */
function readLegacyConfig(): ZdrConfigFile | null {
  const path = join(getAgentDir(), LEGACY_CONFIG_FILE)
  if (!existsSync(path)) return null
  try {
    return parseConfigObject(JSON.parse(readFileSync(path, "utf8")))
  } catch {
    return null
  }
}

function mergeConfigFiles(
  global: ZdrConfigFile | null,
  project: ZdrConfigFile | null,
): ZdrConfig | null {
  if (!global && !project) return null
  return {
    enabled: project?.enabled ?? global?.enabled ?? DEFAULT_CONFIG.enabled,
    exclusions: project?.exclusions ?? global?.exclusions ?? [],
    onUnsupported: project?.onUnsupported ?? global?.onUnsupported ?? DEFAULT_CONFIG.onUnsupported,
    rejected: [...new Set([...(global?.rejected ?? []), ...(project?.rejected ?? [])])],
  }
}

export default function commandCodeZdr(pi: ExtensionAPI) {
  /** Effective config for the current session; null until settings carry the namespace. */
  let config: ZdrConfig | null = null
  /** Hydrated from the effective config so learned rejections survive a restart. */
  const rejected = new Set<string>()
  /** Models the user released for this session only. Never written to disk. */
  const sessionAllow = new Set<string>()
  /** Models released for exactly the next request. Consumed by the header decider. */
  const onceAllow = new Set<string>()
  /** Project root for project-scoped reads and writes. */
  let cwd = process.cwd()
  let projectTrusted = false
  /** Where the editor writes; defaults to the project scope when it is set. */
  let scope: ZdrScope = "global"

  /**
   * Resolve the effective config for a session.
   *
   * Both scopes come from settings.json: the agent-directory file and the
   * working directory's .pi file. The project scope only participates when the
   * project is trusted, the same gate pi applies. A project field overrides the
   * global one; learned rejections are the union of both.
   */
  function resolveConfig(ctx: ExtensionContext): void {
    cwd = ctx.cwd
    projectTrusted = ctx.isProjectTrusted()
    let global = readNamespaced(globalSettingsPath())
    const project = projectTrusted ? readNamespaced(projectSettingsPath(cwd)) : null
    // One-time move of the old dedicated file, so existing settings are not lost.
    if (!global) {
      const legacy = readLegacyConfig()
      const migrated = legacy ? mergeConfigFiles(legacy, null) : null
      if (migrated && writeNamespaced(globalSettingsPath(), migrated)) global = legacy
    }
    config = mergeConfigFiles(global, project)
    rejected.clear()
    for (const modelId of config?.rejected ?? []) rejected.add(modelId)
    scope = project ? "project" : "global"
    // The provider transport is the only path every request takes, including
    // worker agent loops that never run pi's header hook. Publish the decision
    // there. A missing namespace leaves it to the CMD_ZDR environment.
    setCommandCodeZdrDecider(config ? (modelId) => sendZdrFor(modelId) : undefined)
  }

  function scopePath(target: ZdrScope): string {
    return target === "project" ? projectSettingsPath(cwd) : globalSettingsPath()
  }

  function saveConfig(next: ZdrConfig, target: ZdrScope = scope): void {
    // The in-memory set is the source of truth for rejections, so a settings
    // edit mid-session cannot write back a stale copy.
    const merged: ZdrConfig = { ...next, rejected: [...rejected] }
    writeNamespaced(scopePath(target), merged)
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

  pi.on("session_start", async (_event, ctx) => {
    resolveConfig(ctx)
  })

  pi.on("session_shutdown", async () => {
    setCommandCodeZdrDecider(undefined)
  })

  pi.on("message_end", async (event, ctx) => {
    const message = event.message
    if (message.role !== "assistant") return

    if (message.provider !== PROVIDER || message.stopReason !== "error" || !message.errorMessage)
      return

    const error = message.errorMessage
    const retryable = { message: { ...message, errorMessage: `${error}${RETRY_HINT}` } }

    if (EMPTY_RESPONSE.test(error)) return retryable

    // The transport owns the header decision, so a rejection is any error from
    // an enabled policy. The model id comes from the message that failed.
    const modelId = (message as { model?: string }).model ?? ctx.model?.id
    if (!config || !modelId || !ZDR_REJECTION.test(error)) return
    return (await resolveRejection(ctx, config, modelId)) ? retryable : undefined
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

      // Re-resolve so the editor reflects the session's cwd and trust even if
      // session_start never ran for this context.
      resolveConfig(ctx)

      // Opening the editor is the opt-in that takes header ownership over.
      let current = config ?? { ...DEFAULT_CONFIG }

      const apply = (next: ZdrConfig) => {
        current = next
        saveConfig(next)
      }

      await ctx.ui.custom((tui, theme, _keybindings, done) => {
        const scopeItem: SettingItem = {
          id: "scope",
          label: "Save settings to",
          description: projectTrusted
            ? "global: every project. project: this repo only, in .pi/settings.json. Switching writes the current values to that scope."
            : "global: every project. Project scope is unavailable until this project is trusted.",
          currentValue: scope === "project" ? "project" : "global",
          values: projectTrusted ? ["global", "project"] : ["global"],
        }

        const items: SettingItem[] = [
          scopeItem,
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
            if (id === "scope") {
              if (newValue !== "global" && newValue !== "project") return
              if (newValue === "project" && !projectTrusted) return
              scope = newValue
              // Persist the current values into the new scope so it now owns them.
              saveConfig(current, scope)
              return
            }
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
        current.enabled
          ? `ZDR on for ${scope}, ${current.exclusions.length} model(s) excluded`
          : `ZDR off for ${scope}`,
        "info",
      )
    },
  })
}
