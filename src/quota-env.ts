/**
 * Shared environment plumbing for the quota and usage surfaces.
 *
 * The provider registers against `<base>/provider/v1`, while the quota and
 * usage endpoints live at the host root (`/alpha/...`). Both `/commandcode:quota`
 * and the usage widget need the same stripped base and the same legacy
 * env-driven ZDR header, so they live here instead of being recomputed.
 */

import { DEFAULT_PROVIDER_API_BASE } from "./models.ts"

/** Strip the `/provider/v1` suffix so alpha endpoints resolve against the same host. */
export function alphaApiBase(providerApiBase: string): string {
  return providerApiBase.replace(/\/provider\/v1\/?$/, "")
}

/** Alpha API base for the quota and usage endpoints, honoring COMMANDCODE_API_BASE. */
export function commandCodeAlphaBase(env: NodeJS.ProcessEnv = process.env): string {
  return alphaApiBase(env.COMMANDCODE_API_BASE ?? DEFAULT_PROVIDER_API_BASE)
}

/**
 * Env-driven ZDR header for quota and usage requests.
 *
 * The `commandcode-zdr` extension owns `x-cmd-zdr` per request on the provider
 * transport, but quota and usage calls do not pass through that hook. They keep
 * the legacy CMD_ZDR behavior the provider registered with.
 */
export function commandCodeEnvHeaders(
  env: NodeJS.ProcessEnv = process.env,
): Record<string, string> | undefined {
  if (env.CMD_ZDR === "1" || env.COMMANDCODE_ZDR === "1") {
    return { "x-cmd-zdr": "1" }
  }
  return undefined
}
