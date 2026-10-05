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
 * policy (enabled, exclusions, learned rejections). When nothing publishes
 * one, the CMD_ZDR / COMMANDCODE_ZDR environment fallback applies, so the
 * provider keeps working without the extension.
 *
 * The key is on `globalThis` so both entry files share it even if pi loads
 * them as separate module instances.
 */

const DECIDER_KEY = Symbol.for("pi-commandcode-provider.zdr-decider")

type ZdrDecider = (modelId: string) => boolean

/** Publish the per-model header decision, or clear it to fall back to the environment. */
export function setCommandCodeZdrDecider(decider: ZdrDecider | undefined): void {
  if (decider) (globalThis as Record<symbol, unknown>)[DECIDER_KEY] = decider
  else delete (globalThis as Record<symbol, unknown>)[DECIDER_KEY]
}

/** Whether this model's request carries `x-cmd-zdr: 1`. */
export function commandCodeZdrFor(modelId: string, env: NodeJS.ProcessEnv = process.env): boolean {
  const decider = (globalThis as Record<symbol, unknown>)[DECIDER_KEY]
  if (typeof decider === "function") return (decider as ZdrDecider)(modelId)
  return env.CMD_ZDR === "1" || env.COMMANDCODE_ZDR === "1"
}
