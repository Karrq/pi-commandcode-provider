/**
 * Pure ZDR header decision.
 *
 * The provider is the mode: the `commandcode-zdr` catalog always sends
 * `x-cmd-zdr: 1`, and the plain `commandcode` catalog does not, except when the
 * upstream `CMD_ZDR` / `COMMANDCODE_ZDR` environment forces it on. Per-model
 * releases and exclusions turn the header back off, which is what makes the 422
 * fallback and the "retry without ZDR" choices work on the ZDR provider too.
 *
 * Kept separate from the extension so the decision can be tested without a host
 * runtime. The extension owns the mutable state (releases, rejections,
 * exclusions) and passes it in.
 */

import { COMMAND_CODE_ZDR_PROVIDER } from "./providers.ts"

export interface ZdrHeaderState {
  /** Model ids that never receive the header. */
  exclusions: readonly string[]
  /** Model ids released for the rest of the session. */
  sessionAllow: ReadonlySet<string>
  /** Model ids that rejected the header with 422 and are now sent without it. */
  rejected: ReadonlySet<string>
  /** Model ids released for exactly one request; consumed when read. */
  onceAllow: Set<string>
  /** Environment to read the upstream force from. Defaults to `process.env`. */
  env?: NodeJS.ProcessEnv
}

/**
 * Whether a request for this model carries `x-cmd-zdr: 1`.
 *
 * Exclusions and releases win over the provider default, so a model the user
 * released is sent without ZDR even on the ZDR provider. `CMD_ZDR=1` (or the
 * legacy `COMMANDCODE_ZDR=1`) forces the header on the plain provider too.
 */
export function zdrHeaderFor(
  modelId: string,
  provider: string | undefined,
  state: ZdrHeaderState,
): boolean {
  const env = state.env ?? process.env
  const forced = env.CMD_ZDR === "1" || env.COMMANDCODE_ZDR === "1"
  if (provider !== COMMAND_CODE_ZDR_PROVIDER && !forced) return false
  if (state.onceAllow.delete(modelId)) return false
  if (state.exclusions.includes(modelId)) return false
  if (state.sessionAllow.has(modelId)) return false
  if (state.rejected.has(modelId)) return false
  return true
}
