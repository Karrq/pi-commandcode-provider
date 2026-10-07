/**
 * Shared ZDR decision point between the provider transport and the
 * `commandcode-zdr` extension.
 *
 * The provider transport is the only path every Command Code request takes,
 * including the agent loops that other extensions (observational memory,
 * subagents) drive directly. Those calls never run pi's
 * `before_provider_headers` hook, so the header has to be resolved where the
 * request is built.
 *
 * The `commandcode-zdr` extension publishes a decider here and owns the
 * per-model policy (exclusions, session releases, learned rejections). When
 * nothing publishes one, the environment fallback applies and the ZDR provider
 * still sends the header on its own, so the provider keeps working without the
 * extension.
 *
 * The same extension also publishes the excluded model ids and a "republish"
 * callback here. The provider entry uses the ids to hide those models from the
 * ZDR catalog, and only the extension knows when they change, so it calls back
 * to have the catalog refreshed.
 *
 * It also publishes how the ZDR provider resolves its API key. That provider
 * has no credential of its own, so it borrows the `commandcode` credential,
 * which pi refreshes when the OAuth token expires.
 *
 * The keys are on `globalThis` so both entry files share them even if pi loads
 * them as separate module instances.
 */

import { COMMAND_CODE_ZDR_PROVIDER } from "./providers.ts"

const DECIDER_KEY = Symbol.for("pi-commandcode-provider.zdr-decider")
const EXCLUDED_KEY = Symbol.for("pi-commandcode-provider.zdr-excluded")
const REPUBLISH_KEY = Symbol.for("pi-commandcode-provider.zdr-republish")
const KEY_RESOLVER_KEY = Symbol.for("pi-commandcode-provider.zdr-key-resolver")

type ZdrDecider = (modelId: string, provider?: string) => boolean
type ZdrKeyResolver = () => Promise<string | undefined>

/** Publish the per-model header decision, or clear it to fall back to the environment. */
export function setCommandCodeZdrDecider(decider: ZdrDecider | undefined): void {
  if (decider) (globalThis as Record<symbol, unknown>)[DECIDER_KEY] = decider
  else delete (globalThis as Record<symbol, unknown>)[DECIDER_KEY]
}

/**
 * Whether this model's request carries `x-cmd-zdr: 1`.
 *
 * The published decider is authoritative and receives the provider, since the
 * provider is the ZDR mode. With no decider the ZDR provider still sends the
 * header on its own, so the provider works when the policy extension is not
 * loaded; the environment flags force it on the plain provider.
 */
export function commandCodeZdrFor(
  modelId: string,
  provider?: string,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  const decider = (globalThis as Record<symbol, unknown>)[DECIDER_KEY]
  if (typeof decider === "function") return (decider as ZdrDecider)(modelId, provider)
  if (env.CMD_ZDR === "1" || env.COMMANDCODE_ZDR === "1") return true
  return provider === COMMAND_CODE_ZDR_PROVIDER
}

/** Publish the model ids the ZDR provider catalog must not offer. */
export function setCommandCodeZdrExcluded(modelIds: readonly string[] | undefined): void {
  const store = globalThis as Record<symbol, unknown>
  if (modelIds && modelIds.length > 0) store[EXCLUDED_KEY] = new Set(modelIds)
  else delete store[EXCLUDED_KEY]
}

/** Whether the ZDR provider catalog hides this model. */
export function commandCodeZdrExcluded(modelId: string): boolean {
  const excluded = (globalThis as Record<symbol, unknown>)[EXCLUDED_KEY]
  return excluded instanceof Set && excluded.has(modelId)
}

/** Register the provider entry's callback that re-publishes the ZDR catalog. */
export function setCommandCodeZdrRepublish(republish: (() => void) | undefined): void {
  const store = globalThis as Record<symbol, unknown>
  if (republish) store[REPUBLISH_KEY] = republish
  else delete store[REPUBLISH_KEY]
}

/** Ask the provider entry to re-publish the ZDR catalog. No-op when unregistered. */
export function republishCommandCodeZdr(): void {
  const republish = (globalThis as Record<symbol, unknown>)[REPUBLISH_KEY]
  if (typeof republish === "function") (republish as () => void)()
}

/**
 * Publish how the ZDR provider resolves its API key. It has no credential of
 * its own, so it borrows the `commandcode` credential, which is OAuth-backed
 * and refreshed by the host on every resolve.
 */
export function setCommandCodeZdrKeyResolver(resolver: ZdrKeyResolver | undefined): void {
  const store = globalThis as Record<symbol, unknown>
  if (resolver) store[KEY_RESOLVER_KEY] = resolver
  else delete store[KEY_RESOLVER_KEY]
}

/** Resolve the key the ZDR provider sends, via the published resolver. */
export async function resolveCommandCodeZdrKey(): Promise<string | undefined> {
  const resolver = (globalThis as Record<symbol, unknown>)[KEY_RESOLVER_KEY]
  if (typeof resolver !== "function") return undefined
  try {
    return await (resolver as ZdrKeyResolver)()
  } catch {
    return undefined
  }
}
