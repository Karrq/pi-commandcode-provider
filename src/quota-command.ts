import { getConfiguredApiKey } from "./api-key.ts"
import { pickCommandCodeApiKey } from "./converters.ts"
import { fetchCommandCodeQuota, redactValue } from "./quota.ts"
import { formatQuota } from "./quota-format.ts"
import type { CommandCodeQuota, QuotaAccountCache } from "./quota-types.ts"

export interface QuotaCommandContext {
  mode?: "tui" | "rpc" | "json" | "print"
  modelRegistry?: {
    getApiKeyForProvider?: (provider: string) => Promise<string | undefined>
  }
  ui: {
    notify(message: string, type?: "info" | "warning" | "error"): void
  }
}

interface QuotaCommandApi {
  registerCommand(
    name: string,
    options: {
      description: string
      handler: (args: string, ctx: QuotaCommandContext) => Promise<void>
    },
  ): void
  /** Persists the report as a session entry; absent only in structural test doubles. */
  appendEntry?<T = unknown>(customType: string, data?: T): void
}

interface RegisterQuotaCommandOptions {
  apiBase: string
  headers?: Record<string, string>
  getConfiguredKey?: () => string | undefined
  fetchQuota?: typeof fetchCommandCodeQuota
  /** Persists the resolved account identity so later fetches skip `whoami`. */
  accountCache?: QuotaAccountCache
}

/**
 * Register `/commandcode:quota`.
 *
 * The report is fetched and appended as a `commandcode-quota` session entry,
 * so it persists in the transcript instead of vanishing with a toast. A
 * renderer registered by the provider entry point draws the entry. Non-TUI
 * hosts have no transcript renderer, so they still get a notification.
 */
export function registerCommandCodeQuota(
  pi: QuotaCommandApi,
  options: RegisterQuotaCommandOptions,
): void {
  const getConfiguredKey = options.getConfiguredKey ?? getConfiguredApiKey
  const fetchQuota = options.fetchQuota ?? fetchCommandCodeQuota

  pi.registerCommand("commandcode:quota", {
    description: "Show Command Code account usage and quota",
    handler: async (_args, ctx) => {
      const registryKey = await ctx.modelRegistry?.getApiKeyForProvider?.("commandcode")
      const apiKey = pickCommandCodeApiKey(registryKey, getConfiguredKey())
      if (!apiKey) {
        ctx.ui.notify(
          "Command Code quota requires an API key. Run /login and select Command Code, or set COMMAND_CODE_API_KEY.",
          "warning",
        )
        return
      }

      const result = await fetchQuota({
        apiKey,
        baseUrl: options.apiBase,
        extraHeaders: options.headers,
        accountCache: options.accountCache,
      })
      if (!result.ok) {
        ctx.ui.notify(redactValue(result.error.message), "error")
        return
      }

      pi.appendEntry?.<CommandCodeQuota>("commandcode-quota", result.quota)
      if (ctx.mode !== "tui") {
        ctx.ui.notify(formatQuota(result.quota), "info")
      }
    },
  })
}
