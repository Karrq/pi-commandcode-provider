/**
 * ZDR zones: paths whose content must never reach a model without
 * zero-data-retention.
 *
 * This module is pure (only `node:os` and `node:path`) so both the provider
 * transport and the `commandcode-zdr` extension can share one matching policy
 * without importing pi. Matching is intentionally textual and best-effort:
 * it catches direct references to a zone, not fragmented or indirect reads
 * (see `commandMentionsZone`).
 */

import { homedir } from "node:os"
import { isAbsolute, join, parse, relative, resolve, sep } from "node:path"

/** Session-entry `customType` that carries the persisted "armed" marker. */
export const ZDR_ARMED_ENTRY = "commandcode-zdr.armed"

/** Persisted record that a ZDR zone was touched during the session. */
export interface ArmedMarker {
  at: number
  source: string // e.g. "cwd" | "read" | "grep" | "find" | "ls" | "bash" | "jev" | "inherited"
  detail?: string
}

/** Strip trailing separators while keeping the filesystem root intact. */
function stripTrailingSep(value: string): string {
  const root = parse(value).root
  let result = value
  while (result.length > root.length && result.endsWith(sep)) {
    result = result.slice(0, -1)
  }
  return result
}

/** Expand a leading `~` / `~/` and make the path absolute, without trailing separators. */
export function normalizeZone(zone: string, cwd: string): string | undefined {
  const trimmed = zone.trim()
  if (!trimmed) return undefined

  let expanded = trimmed
  if (trimmed === "~") expanded = homedir()
  else if (trimmed.startsWith(`~${sep}`) || trimmed.startsWith("~/")) {
    expanded = join(homedir(), trimmed.slice(2))
  }

  const absolute = isAbsolute(expanded) ? expanded : resolve(cwd, expanded)
  return stripTrailingSep(resolve(absolute))
}

/** Textual spellings of a normalized zone that a command might contain. */
function zoneForms(zone: string, cwd: string): string[] {
  const forms = [zone]

  const home = resolve(homedir())
  if (zone === home) forms.push("~")
  else if (zone.startsWith(home + sep)) forms.push(`~${zone.slice(home.length)}`)

  const base = resolve(cwd)
  if (zone.startsWith(base + sep)) forms.push(relative(base, zone))

  return forms
}

/**
 * Whether `target` is inside any zone (or equals one). Prefix-boundary safe:
 * `/a/b` does not match the zone `/a/bc`. Empty or invalid targets return false.
 */
export function pathInZones(target: string, zones: readonly string[], cwd: string): boolean {
  const normalizedTarget = normalizeZone(target, cwd)
  if (!normalizedTarget) return false

  for (const zone of zones) {
    const normalizedZone = normalizeZone(zone, cwd)
    if (!normalizedZone) continue
    if (normalizedTarget === normalizedZone) return true
    const prefix = normalizedZone.endsWith(sep) ? normalizedZone : normalizedZone + sep
    if (normalizedTarget.startsWith(prefix)) return true
  }

  return false
}

/**
 * Heuristic check for a zone name mentioned in a shell command.
 *
 * Each zone is tried in its absolute, `~`-shortened, and cwd-relative forms,
 * and the first zone whose any form appears as a substring wins. This catches
 * direct references only; fragmented (`$HOME/pri` + `vate`) or indirect reads
 * (a script, symlink, or subshell) are not detected.
 */
export function commandMentionsZone(
  command: string,
  zones: readonly string[],
  cwd: string,
): string | undefined {
  for (const zone of zones) {
    const normalizedZone = normalizeZone(zone, cwd)
    if (!normalizedZone) continue
    for (const form of zoneForms(normalizedZone, cwd)) {
      if (form && command.includes(form)) return normalizedZone
    }
  }
  return undefined
}

/**
 * Read the most recent persisted "armed" marker from session entries.
 *
 * Entries are scanned in order and the last valid marker wins. A marker is any
 * object with a string `source`; a missing `at` defaults to 0. Malformed entries
 * and data are ignored without throwing.
 */
export function armedFromEntries(entries: readonly unknown[]): ArmedMarker | undefined {
  let found: ArmedMarker | undefined

  for (const entry of entries) {
    if (!entry || typeof entry !== "object") continue
    const record = entry as Record<string, unknown>
    if (record.type !== "custom" || record.customType !== ZDR_ARMED_ENTRY) continue

    const data = record.data
    if (!data || typeof data !== "object") continue

    const marker = data as Record<string, unknown>
    if (typeof marker.source !== "string") continue
    if (marker.at !== undefined && typeof marker.at !== "number") continue

    const parsed: ArmedMarker = {
      at: typeof marker.at === "number" ? marker.at : 0,
      source: marker.source,
    }
    if (typeof marker.detail === "string") parsed.detail = marker.detail
    found = parsed
  }

  return found
}

/** Render a zone list for status text, or `(none)` when empty. */
export function formatZoneList(zones: readonly string[]): string {
  return zones.length === 0 ? "(none)" : zones.join(", ")
}
