/**
 * Command Code usage widget and settings.
 *
 * Shows remaining 5-hour and weekly usage below the editor while the
 * `commandcode` provider is active. Refreshes on session start, model change,
 * and turn settle, with a short throttle so idle sessions do not hammer the
 * billing endpoints.
 *
 * The snapshot comes from the same alpha endpoints `/commandcode:quota` reads,
 * through the shared quota layer.
 *
 * Toggle it with `/commandcode:settings`. The setting persists in
 * `<agent-dir>/commandcode-usage.json`.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import {
  getAgentDir,
  getSettingsListTheme,
  type ExtensionAPI,
  type ExtensionContext,
} from "@earendil-works/pi-coding-agent"
import { Container, type SettingItem, SettingsList, Text, type TUI } from "@earendil-works/pi-tui"

import { getConfiguredApiKey } from "./src/api-key.ts"
import { pickCommandCodeApiKey } from "./src/converters.ts"
import { createDiskQuotaAccountCache } from "./src/quota-account-cache.ts"
import { commandCodeAlphaBase, commandCodeEnvHeaders } from "./src/quota-env.ts"
import { fetchCommandCodeQuota } from "./src/quota.ts"
import type { QuotaAccountCache } from "./src/quota-types.ts"
import {
  DEFAULT_USAGE_SETTINGS,
  formatUsageWidget,
  parseUsageSettings,
  type UsageSettings,
  type UsageWidgetState,
} from "./src/usage-widget.ts"

const PROVIDER = "commandcode"
const WIDGET_KEY = "commandcode-usage"
const SETTINGS_FILE = "commandcode-usage.json"
const ACCOUNT_FILE = "commandcode-account.json"
/** Re-fetch at most this often; the 5h and weekly windows move slowly. */
const REFRESH_INTERVAL_MS = 30_000

function settingsPath(): string {
  return join(getAgentDir(), SETTINGS_FILE)
}

/**
 * Account identities live beside the other Command Code files, keyed by API key,
 * so a re-login or token refresh misses by construction.
 */
let accountCache: QuotaAccountCache | undefined
function quotaAccountCache(): QuotaAccountCache {
  accountCache ??= createDiskQuotaAccountCache(join(getAgentDir(), ACCOUNT_FILE))
  return accountCache
}

function readSettings(): UsageSettings {
  const path = settingsPath()
  if (!existsSync(path)) return { ...DEFAULT_USAGE_SETTINGS }
  try {
    return parseUsageSettings(readFileSync(path, "utf8")) ?? { ...DEFAULT_USAGE_SETTINGS }
  } catch {
    return { ...DEFAULT_USAGE_SETTINGS }
  }
}

function writeSettings(settings: UsageSettings): void {
  const path = settingsPath()
  mkdirSync(dirname(path), { recursive: true })
  writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8")
}

export default function commandCodeUsage(pi: ExtensionAPI) {
  let settings = readSettings()
  let providerActive = false
  let latest: UsageWidgetState | undefined
  let refreshing = false
  let lastFetchedAt = 0
  let mounted = false
  let widgetTui: TUI | undefined

  function shouldShow(): boolean {
    return settings.widget && providerActive
  }

  function applyWidget(ctx: ExtensionContext): void {
    if (!ctx.hasUI) return
    if (!shouldShow()) {
      if (mounted) {
        ctx.ui.setWidget(WIDGET_KEY, undefined)
        mounted = false
        widgetTui = undefined
      }
      return
    }

    if (mounted) {
      widgetTui?.requestRender()
      return
    }

    ctx.ui.setWidget(
      WIDGET_KEY,
      (tui, theme) => {
        widgetTui = tui
        return {
          invalidate() {},
          render: () =>
            formatUsageWidget(latest, Date.now(), (color, text) => theme.fg(color, text)),
        }
      },
      { placement: "belowEditor" },
    )
    mounted = true
  }

  async function refresh(ctx: ExtensionContext, force = false): Promise<void> {
    if (!ctx.hasUI) return
    if (!shouldShow()) {
      applyWidget(ctx)
      return
    }
    if (refreshing) return
    if (!force && Date.now() - lastFetchedAt < REFRESH_INTERVAL_MS) {
      applyWidget(ctx)
      return
    }

    // Mount with the loading line before the request so a toggle-on or a fresh
    // session does not look like nothing happened while the fetch is in flight.
    applyWidget(ctx)
    refreshing = true
    try {
      const registryKey = await ctx.modelRegistry.getApiKeyForProvider(PROVIDER)
      const apiKey = pickCommandCodeApiKey(registryKey, getConfiguredApiKey())
      if (!apiKey) {
        latest = { quota: null, error: "no API key" }
        return
      }
      const result = await fetchCommandCodeQuota({
        apiKey,
        baseUrl: commandCodeAlphaBase(),
        extraHeaders: commandCodeEnvHeaders(),
        accountCache: quotaAccountCache(),
      })
      latest = result.ok ? { quota: result.quota } : { quota: null, error: result.error.message }
    } catch (error) {
      latest = { quota: null, error: error instanceof Error ? error.message : String(error) }
    } finally {
      refreshing = false
      lastFetchedAt = Date.now()
      applyWidget(ctx)
    }
  }

  function setProvider(ctx: ExtensionContext): void {
    providerActive = ctx.model?.provider === PROVIDER
    if (!providerActive) latest = undefined
  }

  pi.on("session_start", async (_event, ctx) => {
    settings = readSettings()
    setProvider(ctx)
    latest = undefined
    applyWidget(ctx)
    void refresh(ctx, true)
  })

  pi.on("model_select", async (_event, ctx) => {
    setProvider(ctx)
    applyWidget(ctx)
    void refresh(ctx, true)
  })

  pi.on("agent_settled", async (_event, ctx) => {
    void refresh(ctx)
  })

  pi.on("session_shutdown", async (_event, ctx) => {
    if (ctx.hasUI && mounted) ctx.ui.setWidget(WIDGET_KEY, undefined)
    mounted = false
    widgetTui = undefined
    latest = undefined
  })

  pi.registerCommand("commandcode:settings", {
    description: "Configure the Command Code usage widget",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/commandcode:settings requires TUI mode", "error")
        return
      }

      let current = settings

      await ctx.ui.custom((tui, theme, _keybindings, done) => {
        const items: SettingItem[] = [
          {
            id: "widget",
            label: "Usage widget",
            description:
              "Show remaining 5-hour and weekly Command Code usage below the editor while the provider is active.",
            currentValue: current.widget ? "on" : "off",
            values: ["on", "off"],
          },
        ]

        const list = new SettingsList(
          items,
          items.length + 2,
          getSettingsListTheme(),
          (id, value) => {
            if (id !== "widget") return
            current = { ...current, widget: value === "on" }
            settings = current
            writeSettings(current)
            if (settings.widget) void refresh(ctx, true)
            else applyWidget(ctx)
          },
          () => done(undefined),
        )

        const container = new Container()
        container.addChild(new Text(theme.fg("accent", theme.bold("Command Code Settings")), 0, 0))
        container.addChild(list)

        return {
          render: (width: number) => container.render(width),
          invalidate: () => container.invalidate(),
          handleInput: (data: string) => {
            list.handleInput?.(data)
            tui.requestRender()
          },
        }
      })
    },
  })
}
