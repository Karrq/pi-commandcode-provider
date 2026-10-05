/**
 * ZDR zones: paths whose content must never reach a model without
 * zero-data-retention.
 *
 * This module is pure (only `node:os` and `node:path`) so both the provider
 * transport and the `commandcode-zdr` extension can share one matching policy
 * without importing pi. Matching is intentionally textual and best-effort:
 * it catches direct references to a zone, not fragmented or indirect reads
 * (see `commandMentionsZone`).
 *
 * A zone may contain glob wildcards: `*` and `?` stay inside one path segment
 * and `**` crosses separators, so `~/Altius-*` covers every sibling directory
 * with that prefix. Glob zones are still matched textually; nothing is read
 * from disk.
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

/** Whether a zone contains glob wildcards, so it names a set of paths. */
function hasGlob(zone: string): boolean {
  return zone.includes("*") || zone.includes("?")
}

/** Zone text before the first wildcard: the literal prefix every match shares. */
function literalStem(zone: string): string {
  const index = zone.search(/[*?]/)
  return index === -1 ? zone : zone.slice(0, index)
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
}

/**
 * Anchored prefix regex for a glob zone. `*` and `?` stay inside one path
 * segment and `**` crosses separators. The trailing separator-or-end makes it a
 * directory prefix, so `/a/Altius-*` covers `/a/Altius-x` and everything under
 * it, but not `/a/AltiusX`.
 */
function globRegExp(zone: string): RegExp {
  const sepPattern = escapeRegExp(sep)
  const notSep = `[^${sepPattern}]`
  const pattern = zone
    .split(sep)
    .map((segment) => {
      let out = ""
      for (let i = 0; i < segment.length; i++) {
        const char = segment[i]
        if (char === "*") {
          if (segment[i + 1] === "*") {
            out += ".*"
            i++
          } else {
            out += `${notSep}*`
          }
        } else if (char === "?") {
          out += notSep
        } else {
          out += escapeRegExp(char)
        }
      }
      return out
    })
    .join(sepPattern)
  return new RegExp(`^${pattern}(?:${sepPattern}|$)`)
}

/** Textual spellings of a zone's literal part that a command might contain. */
function zoneForms(zone: string, cwd: string): string[] {
  const stem = literalStem(zone)
  const forms = [stem]

  const home = resolve(homedir())
  if (stem === home) forms.push("~")
  else if (stem.startsWith(home + sep)) forms.push(`~${stem.slice(home.length)}`)

  const base = resolve(cwd)
  if (stem.startsWith(base + sep)) forms.push(relative(base, stem))

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
    if (hasGlob(normalizedZone)) {
      if (globRegExp(normalizedZone).test(normalizedTarget)) return true
      continue
    }
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
 * and the first zone whose any form appears as a substring wins. A glob zone is
 * reduced to the literal text before its first wildcard, so `~/Altius-*` is
 * caught by any command naming `~/Altius-`. This catches direct references
 * only; fragmented (`$HOME/pri` + `vate`) or indirect reads (a script, symlink,
 * or subshell) are not detected.
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
