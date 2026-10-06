/**
 * Provider ids for the two Command Code catalogs.
 *
 * `commandcode` carries the configured ZDR policy per request. `commandcode-zdr`
 * is the same catalog with zero data retention always on, for when a zone read
 * arms the session. They share one model list, so they are the same provider in
 * every check that only cares whether Command Code owns a model.
 */

export const COMMAND_CODE_PROVIDER = "commandcode"
export const COMMAND_CODE_ZDR_PROVIDER = "commandcode-zdr"

/** Whether a provider id is either Command Code catalog. */
export function isCommandCodeProvider(provider: string | undefined): boolean {
  return provider === COMMAND_CODE_PROVIDER || provider === COMMAND_CODE_ZDR_PROVIDER
}
