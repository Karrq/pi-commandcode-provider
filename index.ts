/**
 * Command Code provider for pi.
 *
 * Uses Command Code's documented Provider API:
 * https://api.commandcode.ai/provider/v1
 */

import { AssistantMessageEventStream } from "@earendil-works/pi-ai"
import * as piAiCompat from "@earendil-works/pi-ai/compat"
import { streamSimple as streamNativeProvider } from "@earendil-works/pi-ai/compat"
import {
  getAgentDir,
  type ExtensionAPI,
  type ExtensionCommandContext,
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
import { alphaApiBase, commandCodeEnvHeaders } from "./src/quota-env.ts"
import { formatQuota } from "./src/quota-format.ts"
import type { CommandCodeQuota } from "./src/quota-types.ts"
import { createCommandCodeRuntime } from "./src/runtime.ts"
import { createCommandCodeUsageProvider, type UsageProvider } from "./src/usage.ts"
import { transcriptReadersFrom, withTranscriptPromptAndTools } from "./src/transcript.ts"
import { createCommandCodeTransportRouter } from "./src/transport.ts"

const COMMAND_CODE_API = "commandcode-custom"
const COMPAT_SOURCE_ID = "pi-commandcode-provider"

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
    headers,
    // Same alpha endpoints and credentials as the /commandcode:quota command.
    usage: createCommandCodeUsageProvider({
      apiBase: alphaApiBase(apiBase),
      headers,
    }),
    oauth: {
      name: "Command Code",
      login,
      refreshToken,
      getApiKey: getOAuthApiKey,
    },
    models: models.map((model) => ({
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
      headers,
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
    })),
  }
}

export default async function (pi: ExtensionAPI) {
  // Hosts may select their built-in Command Code model before loading extensions.
  // Rebind that stale selection to our registered transport before the first turn.
  pi.on("session_start", async (_event, ctx) => {
    if (ctx.model?.provider !== "commandcode") return
    const registered = ctx.modelRegistry.find("commandcode", ctx.model.id)
    if (registered?.api === COMMAND_CODE_API && ctx.model.api !== COMMAND_CODE_API) {
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
        resolveStreamOptions(options),
      ),
    streamGenerate: (model, context, options) =>
      streamGenerate(
        model,
        withTranscriptPromptAndTools(context, transcriptReaders),
        resolveStreamOptions(options),
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
    createProviderConfig: (models) => createProviderConfig(models, apiBase, transport.stream),
    getTransport: transport.getTransport,
  })

  pi.on("session_shutdown", () => {
    runtime.dispose()
  })

  await runtime.initialize()
}
