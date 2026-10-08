/**
 * Command Code provider for pi.
 *
 * Uses Command Code's documented Provider API:
 * https://api.commandcode.ai/provider/v1
 */

import { AssistantMessageEventStream, type Provider } from "@earendil-works/pi-ai"
import * as piAiCompat from "@earendil-works/pi-ai/compat"
import { streamSimple as streamNativeProvider } from "@earendil-works/pi-ai/compat"
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
  type ExtensionContext,
  type ProviderConfig,
} from "@earendil-works/pi-coding-agent"
import { Text } from "@earendil-works/pi-tui"
import { join } from "node:path"

import { getConfiguredApiKey } from "./src/api-key.ts"
import { pickCommandCodeApiKey, withResolvedCommandCodeApiKey } from "./src/converters.ts"
import { createStreamCommandCode } from "./src/core.ts"
import { calculateCommandCodeCost, commandCodeCostRatesAt } from "./src/cost.ts"
import {
  apiForModelId,
  baseUrlForModel,
  DEFAULT_MODELS_URL,
  DEFAULT_PROVIDER_API_BASE,
  getModelsTimeoutMs,
  inputModalitiesForModel,
  loadCachedCommandCodeModels,
  loadCommandCodeModels,
  MODEL_EFFORTS,
  thinkingMetadataForModel,
  type CommandCodeModel,
} from "./src/models.ts"
import { getApiKey as getOAuthApiKey, login, refreshToken } from "./src/oauth.ts"
import { normalizeCommandCodeMessage } from "./src/overflow.ts"
import { MODEL_COSTS, ZERO_MODEL_COST } from "./src/pricing.ts"
import { registerCommandCodeQuota } from "./src/quota-command.ts"
import { createDiskQuotaAccountCache } from "./src/quota-account-cache.ts"
import { alphaApiBase, commandCodeEnvHeaders } from "./src/quota-env.ts"
import { formatQuota } from "./src/quota-format.ts"
import type { CommandCodeQuota, QuotaAccountCache } from "./src/quota-types.ts"
import { createCommandCodeRuntime } from "./src/runtime.ts"
import { createCommandCodeUsageProvider, type UsageProvider } from "./src/usage.ts"
import {
  COMMAND_CODE_PROVIDER,
  COMMAND_CODE_ZDR_PROVIDER,
  isCommandCodeProvider,
} from "./src/providers.ts"
import { transcriptReadersFrom, withTranscriptPromptAndTools } from "./src/transcript.ts"
import { createCommandCodeTransportRouter } from "./src/transport.ts"
import {
  commandCodeZdrBlockReason,
  commandCodeZdrExcluded,
  commandCodeZdrFor,
  resolveCommandCodeZdrKey,
  setCommandCodeZdrKeyResolver,
  setCommandCodeZdrRepublish,
} from "./src/zdr-state.ts"

const COMMAND_CODE_API = "commandcode-custom"
const COMPAT_SOURCE_ID = "pi-commandcode-provider"
const ZDR_PROVIDER_NAME = "Command Code (ZDR)"

type CompatStreamFunction = (
  model: Parameters<typeof streamNativeProvider>[0],
  context: Parameters<typeof streamNativeProvider>[1],
  options?: Parameters<typeof streamNativeProvider>[2],
) => AssistantMessageEventStream

/**
 * pi's compat entrypoint exposes `registerApiProvider`; Oh My Pi maps
 * `@earendil-works/pi-ai/compat` onto its own pi-ai, which lacks that export
 * and registers custom APIs itself inside `registerProvider`. Resolve the
 * function at runtime so the extension loads on both hosts.
 */
function compatApiProviderRegistrar(): ((...args: unknown[]) => unknown) | undefined {
  const register = (piAiCompat as { registerApiProvider?: unknown }).registerApiProvider
  return typeof register === "function" ? (register as (...args: unknown[]) => unknown) : undefined
}

function registerCompatApiProvider(stream: CompatStreamFunction): void {
  compatApiProviderRegistrar()?.(
    { api: COMMAND_CODE_API, stream, streamSimple: stream },
    COMPAT_SOURCE_ID,
  )
}

/**
 * The `apiKey` handed to `registerProvider` means different things per host.
 *
 * pi parses `$COMMAND_CODE_API_KEY` as an env template: unresolved means
 * "not configured", so `/login` credentials and `--api-key` take over, and
 * the entry keeps the API-key auth method registered next to OAuth. Without
 * it pi composes an OAuth-only provider and drops stored `api_key`
 * credentials and `--api-key`.
 *
 * Oh My Pi has no template notion: an unresolved value stays a literal config
 * override that shadows its `/login` credential store and is sent verbatim as
 * `Authorization: Bearer $COMMAND_CODE_API_KEY`. There, omit `apiKey` unless
 * a real key is configured; OMP then reads env keys and stored credentials
 * itself.
 *
 * Hosts are told apart by the same `registerApiProvider` probe used for the
 * compat registry: pi exports it, OMP does not.
 */
function providerApiKey(): string | undefined {
  const configured = pickCommandCodeApiKey(getConfiguredApiKey(), undefined)
  if (configured) return configured
  return compatApiProviderRegistrar() ? "$COMMAND_CODE_API_KEY" : undefined
}

/**
 * The registered config, plus Oh My Pi's extension-only usage hook.
 *
 * `usage` is not part of pi's `ProviderConfig`; pi ignores the extra field,
 * while OMP turns it into the account's usage report. Both use the same
 * registration call, so the field is attached unconditionally.
 */
type CommandCodeProviderConfig = ProviderConfig & { usage?: UsageProvider }

/**
 * Shared account-identity cache for the command and the OMP usage provider.
 * Sits beside the host's auth file in the agent dir, never inside it.
 */
let quotaAccountCache: QuotaAccountCache | undefined
function commandCodeQuotaAccountCache(): QuotaAccountCache {
  quotaAccountCache ??= createDiskQuotaAccountCache(join(getAgentDir(), "commandcode-account.json"))
  return quotaAccountCache
}

/** Map the Command Code catalog to pi model definitions, shared by both providers. */
function createProviderModels(models: readonly CommandCodeModel[], apiBase: string) {
  return models.map((model) => ({
    id: model.id,
    name: model.name,
    api: COMMAND_CODE_API,
    baseUrl: baseUrlForModel(apiBase, model.api),
    reasoning: model.reasoning,
    ...(thinkingMetadataForModel(model.id) ?? {}),
    input: [...inputModalitiesForModel(model.id)],
    cost: MODEL_COSTS[model.id] ?? ZERO_MODEL_COST,
    contextWindow: model.contextWindow,
    maxTokens: model.maxTokens,
    compat:
      model.api === "openai-completions"
        ? {
            supportsStore: false,
            supportsDeveloperRole: false,
            supportsReasoningEffort: MODEL_EFFORTS[model.id] !== undefined,
            maxTokensField: "max_tokens",
          }
        : {
            supportsEagerToolInputStreaming: false,
            supportsLongCacheRetention: false,
            supportsCacheControlOnTools: false,
            supportsToolReferences: false,
            ...(model.reasoning ? { forceAdaptiveThinking: true } : {}),
          },
  }))
}

function createProviderConfig(
  models: readonly CommandCodeModel[],
  apiBase: string,
  streamCommandCode: ProviderConfig["streamSimple"],
): CommandCodeProviderConfig {
  const headers = commandCodeEnvHeaders()
  return {
    name: "Command Code",
    baseUrl: apiBase,
    apiKey: providerApiKey(),
    api: COMMAND_CODE_API,
    streamSimple: streamCommandCode,
    // Same alpha endpoints and credentials as the /commandcode:quota command.
    // The ZDR header is not set here: the transport resolves it per request so
    // worker loops that bypass pi's header hook are covered too.
    usage: createCommandCodeUsageProvider({
      apiBase: alphaApiBase(apiBase),
      headers,
      accountCache: commandCodeQuotaAccountCache(),
    }),
    oauth: {
      name: "Command Code",
      login,
      refreshToken,
      getApiKey: getOAuthApiKey,
    },
    models: createProviderModels(models, apiBase),
  }
}

export default async function (pi: ExtensionAPI) {
  /** The live ZDR provider, so a republish can re-register the same object. */
  let zdrProvider: Provider | undefined
  /** Last session context, for (re)registering the ZDR provider. */
  let lastCtx: ExtensionContext | undefined
  /** Latest base catalog, used to build the ZDR catalog before a session exists. */
  let baseCatalog: readonly CommandCodeModel[] = []

  /** The base catalog as chat models; `readModels` tags them with the ZDR provider. */
  function zdrModelsFromCatalog(): ReturnType<Provider["getModels"]> {
    return createProviderModels(baseCatalog, apiBase) as unknown as ReturnType<
      Provider["getModels"]
    >
  }

  /**
   * Register the ZDR provider, mirroring the `commandcode` catalog with zero
   * data retention always on.
   *
   * pi restores a session's model before it emits `session_start`, so the
   * provider must exist as soon as the extension loads, or a session whose last
   * model was the ZDR provider falls back to another model with a warning. Before
   * the first context there is no registry to read, so the catalog comes from the
   * same definitions the base provider was registered with and the key is read
   * from the stored credential; `session_start` and every later catalog refresh
   * re-register from the live composed `commandcode` provider instead.
   *
   * The auth is ours: the ZDR provider has no credential of its own, so it
   * resolves through the `commandcode` credential, which pi refreshes when the
   * OAuth token expires. The catalog drops the models the ZDR policy excludes so
   * they cannot be selected under ZDR.
   */
  function registerZdrProvider(ctx?: ExtensionContext): void {
    if (ctx) lastCtx = ctx
    const registry = lastCtx?.modelRegistry
    const base = registry?.getProvider(COMMAND_CODE_PROVIDER)
    setCommandCodeZdrKeyResolver(
      registry
        ? () => registry.getApiKeyForProvider(COMMAND_CODE_PROVIDER)
        : async () => getConfiguredApiKey(),
    )
    const readModels = (): ReturnType<Provider["getModels"]> => {
      const live = registry?.getProvider(COMMAND_CODE_PROVIDER)
      const models = live ? live.getModels() : zdrModelsFromCatalog()
      return models
        .filter((model) => !commandCodeZdrExcluded(model.id))
        .map((model) => ({ ...model, provider: COMMAND_CODE_ZDR_PROVIDER }))
    }
    const streamSimple = (base?.streamSimple ?? transport.stream) as ProviderConfig["streamSimple"]
    const provider: Provider = {
      id: COMMAND_CODE_ZDR_PROVIDER,
      name: ZDR_PROVIDER_NAME,
      baseUrl: base?.baseUrl ?? apiBase,
      headers: base?.headers,
      auth: {
        apiKey: {
          name: "Command Code credential",
          resolve: async () => {
            const apiKey = await resolveCommandCodeZdrKey()
            return apiKey ? { auth: { apiKey }, source: "commandcode credential" } : undefined
          },
          check: async () => {
            const apiKey = await resolveCommandCodeZdrKey()
            return apiKey ? { type: "api_key", source: "commandcode credential" } : undefined
          },
        },
      },
      getModels: readModels,
      getAllModels: readModels,
      stream: (base?.stream ?? streamSimple) as Provider["stream"],
      streamSimple,
      // The catalog is read live, so this provider has nothing to refresh.
      refreshModels: async () => {},
    }
    zdrProvider = provider
    pi.registerProvider(provider)
  }

  /** Re-register the ZDR provider so its catalog picks up new exclusions. */
  setCommandCodeZdrRepublish(() => {
    if (zdrProvider) pi.registerProvider(zdrProvider)
    else registerZdrProvider(lastCtx)
  })

  // Hosts may select their built-in Command Code model before loading extensions.
  // Rebind that stale selection to our registered transport before the first turn.
  pi.on("session_start", async (_event, ctx) => {
    registerZdrProvider(ctx)
    const model = ctx.model
    if (!model || !isCommandCodeProvider(model.provider)) return
    const registered = ctx.modelRegistry.find(COMMAND_CODE_PROVIDER, model.id)
    if (registered?.api === COMMAND_CODE_API && model.api !== COMMAND_CODE_API) {
      await pi.setModel(registered)
    }
  })
  const apiBase = process.env.COMMANDCODE_API_BASE ?? DEFAULT_PROVIDER_API_BASE
  const modelsUrl = process.env.COMMANDCODE_MODELS_URL ?? DEFAULT_MODELS_URL
  const modelsTimeoutMs = getModelsTimeoutMs()
  const modelsCachePath =
    process.env.COMMANDCODE_MODELS_CACHE ?? join(getAgentDir(), "commandcode-models.json")
  const streamGenerate = createStreamCommandCode({
    createStream: () => new AssistantMessageEventStream(),
    calculateCost: calculateCommandCodeCost,
    apiBase: alphaApiBase(apiBase),
  })
  const resolveStreamOptions = (options?: Parameters<typeof streamNativeProvider>[2]) =>
    withResolvedCommandCodeApiKey(options, getConfiguredApiKey())
  // Resolve the ZDR header per request, not at registration. Every Command Code
  // request goes through the transport, including worker agent loops that do
  // not run pi's `before_provider_headers` hook, so this is the one place that
  // can make them honor the commandcode-zdr policy.
  const withZdrHeaders = (
    model: { id: string; provider?: string },
    options?: Parameters<typeof streamNativeProvider>[2],
  ) => {
    const headers = { ...(options?.headers ?? {}) }
    // The provider is the ZDR mode: the decider is asked with the provider and
    // owns every override (exclusions, releases, the environment force).
    const sendZdr = commandCodeZdrFor(model.id, model.provider)
    if (sendZdr) headers["x-cmd-zdr"] = "1"
    else delete headers["x-cmd-zdr"]
    // A blocked request must not leave at all, so this runs before the request
    // is built and throws instead of sending. It receives the header decision
    // above so the check does not consume a one-shot release a second time.
    // Throwing here is caught by the transport router and surfaced as an
    // assistant error message.
    const blocked = commandCodeZdrBlockReason(model.id, model.provider, sendZdr)
    if (blocked) throw new Error(blocked)
    return { ...options, headers }
  }
  // The provider transport delegates to pi-ai, which reads the transcript
  // itself. The generate transport builds its own request body and needs the
  // flat prompt and tool fields that pi 0.86+ no longer passes.
  const transcriptReaders = transcriptReadersFrom(piAiCompat)
  const transport = createCommandCodeTransportRouter({
    createStream: () => new AssistantMessageEventStream(),
    streamProvider: (model, context, options) =>
      streamNativeProvider(
        {
          ...model,
          api: apiForModelId(model.id),
          cost: commandCodeCostRatesAt(model.id, model.cost),
          compat: model.compatConfig ?? model.compat,
        },
        context,
        resolveStreamOptions(withZdrHeaders(model, options)),
      ),
    streamGenerate: (model, context, options) =>
      streamGenerate(
        model,
        withTranscriptPromptAndTools(context, transcriptReaders),
        resolveStreamOptions(withZdrHeaders(model, options)),
      ),
  })

  // pi dispatches the main chat through the registered provider, but sibling
  // extensions that call `streamSimple` from `@earendil-works/pi-ai/compat`
  // with a Command Code model resolve `model.api` through the compat
  // api-registry, which knows nothing about extension providers. Register the
  // custom api there so those calls reach the same transport. The registry
  // resolves no credentials for extension providers, so fall back to the
  // configured key when the caller passes none or a placeholder.
  const compatStream: CompatStreamFunction = (model, context, options) =>
    transport.stream(model, context, resolveStreamOptions(options)) as AssistantMessageEventStream
  registerCompatApiProvider(compatStream)

  pi.on("message_end", async (event, ctx) => {
    if (event.message.role !== "assistant") return
    const normalized = normalizeCommandCodeMessage(event.message, ctx.model?.provider)
    return normalized ? { message: normalized.message } : undefined
  })

  registerCommandCodeQuota(pi, {
    apiBase: alphaApiBase(apiBase),
    headers: commandCodeEnvHeaders(),
    accountCache: commandCodeQuotaAccountCache(),
  })

  // `/commandcode:quota` appends its report as a durable session entry, so it
  // stays in the transcript and never enters the model context. Render it with
  // the same text the command would have notified with.
  pi.registerEntryRenderer<CommandCodeQuota>("commandcode-quota", (entry, _options, _theme) =>
    entry.data === undefined ? undefined : new Text(formatQuota(entry.data), 1, 0),
  )

  const runtime = createCommandCodeRuntime<ProviderConfig, ExtensionCommandContext>(pi, {
    endpoint: modelsUrl,
    cachePath: modelsCachePath,
    loadModels: (signal) =>
      loadCommandCodeModels({
        url: modelsUrl,
        cachePath: modelsCachePath,
        timeoutMs: modelsTimeoutMs,
        signal,
      }),
    loadCachedModels: () => loadCachedCommandCodeModels(modelsCachePath),
    createProviderConfig: (models) => {
      baseCatalog = models
      const config = createProviderConfig(models, apiBase, transport.stream)
      // Keep the ZDR mirror in step with the base catalog, and register it
      // before pi restores a session model so a ZDR selection is never unknown
      // on startup.
      registerZdrProvider()
      return config
    },
    getTransport: transport.getTransport,
  })

  pi.on("session_shutdown", () => {
    runtime.dispose()
  })

  await runtime.initialize()
}
