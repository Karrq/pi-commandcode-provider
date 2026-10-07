/**
 * Command Code ZDR policy and retry
 *
 * /commandcode:zdr opens a settings editor for the `x-cmd-zdr` header that
 * pi-commandcode-provider sends. The upstream extension only reads CMD_ZDR=1
 * from the environment at registration time, so ZDR is either always on or
 * always off for the whole process. This owns the header per request instead.
 *
 * The decision is published to the provider transport (src/zdr-state.ts), which
 * is the only path every request takes. That includes the worker agent loops
 * that other extensions drive directly and that never run pi's
 * `before_provider_headers` hook, so those honor the same policy.
 *
 * Settings live under the `commandcode-zdr` key of pi's settings.json, the
 * same place pi reads its own configuration:
 *   - global:  <agent-dir>/settings.json
 *   - project: <cwd>/.pi/settings.json, read only when the project is trusted,
 *     and overriding the global namespace field by field
 *
 * Three settings:
 *   - enforcement: on / off
 *   - exclusions:  model ids that never receive the header
 *   - on 422:      ask / fallback / block
 * plus `zones` and its Jev settings; see below.
 *
 * ZDR zones: a zone is a folder whose content must never reach a model
 * without zero-data-retention. A zone may use `*`, `?` and `**` glob wildcards,
 * so `~/Altius-*` covers every sibling directory with that prefix. When a tool
 * touches one, the session becomes
 * "armed": every later request carries x-cmd-zdr: 1 no matter what enabled,
 * exclusions, or rejected say (armed wins). Arming is only active while the
 * session's provider is Command Code; on any other provider the header is never
 * sent and the provider is never switched, so zone touches do not mark the
 * session. Arming is written as a `commandcode-zdr.armed` session entry,
 * rendered in the transcript at the point it happened, and recomputed from the
 * current branch, so navigating to a branch that never touched a zone disarms.
 * While armed the session is moved to the `commandcode-zdr` provider, the same
 * catalog with zero data retention always on, so the footer and the worker
 * agent loops follow the decision; disarming moves it back.
 * `COMMANDCODE_ZDR_ARMED` is mirrored in the environment while armed so
 * spawned subagents inherit it. Shell commands the textual path check misses
 * are sent to the pi-jev classifier provider `local-jev`; a near-0.5 result
 * (low confidence) asks the user, and with no terminal arms instead. That
 * prompt can turn zone checks off for the rest of the session, for when the
 * classifier is unreachable and every command would otherwise ask. Every consult
 * is also written as a data-only `commandcode-zdr.jev` entry (command, cwd,
 * zones, probability, verdict), following the model router's decision entries;
 * `zonesJevRecord` turns that off. A ZDR
 * rejection while armed never falls back: resolveRejection refuses.
 *
 * The provider rejects with HTTP 422 `cmd_zdr_no_providers` when no upstream
 * honours zero data retention for the requested model.
 *
 * How retry works: pi already retries failed requests in its own loop, and the
 * transport re-runs the decider on each attempt. What it will not do is retry
 * these two errors, because its retryable-error check is a private regex that
 * matches neither. A `message_end` handler can replace a finalized message in
 * place, and pi reads the replacement when it decides whether to retry. So this
 * appends "try your request again" (a phrase that regex does match) to the
 * error text, and pi retries with its usual backoff and its `retry.maxRetries`
 * budget. `after_provider_response` cannot do this job: the HTTP client throws
 * on non-2xx before that hook fires.
 *
 * Two errors are made retryable:
 *   - ZDR rejection, resolved by the policy above, then retried without the header
 *   - "Provider returned an empty response" from Command Code, retried as-is
 *
 * Until the settings are saved for the first time the ZDR header is left
 * alone, so the CMD_ZDR environment variable keeps working. Empty-response
 * retry does not depend on the settings.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { dirname, join } from "node:path"
import type { ExtensionAPI, ExtensionContext } from "@earendil-works/pi-coding-agent"
import { getAgentDir, getSettingsListTheme } from "@earendil-works/pi-coding-agent"
import { Box, Container, type SettingItem, SettingsList, Text } from "@earendil-works/pi-tui"
import {
  COMMAND_CODE_PROVIDER,
  COMMAND_CODE_ZDR_PROVIDER,
  isCommandCodeProvider,
} from "./src/providers.ts"
import {
  republishCommandCodeZdr,
  setCommandCodeZdrDecider,
  setCommandCodeZdrExcluded,
} from "./src/zdr-state.ts"
import {
  ZDR_ARMED_ENTRY,
  type ArmedMarker,
  armedFromEntries,
  commandMentionsZone,
  describeArmedMarker,
  formatZoneList,
  normalizeZone,
  pathInZones,
} from "./src/zdr-zones.ts"

const PROVIDER = COMMAND_CODE_PROVIDER
const ZDR_PROVIDER = COMMAND_CODE_ZDR_PROVIDER
/** Namespace inside settings.json: `"commandcode-zdr": { ... }`. */
const SETTINGS_KEY = "commandcode-zdr"
/** Pre-settings.json config location, read once to migrate an existing config. */
const LEGACY_CONFIG_FILE = "commandcode-zdr.json"
const CACHE_PATH = join(getAgentDir(), "commandcode-models.json")
const ARMED_ENV = "COMMANDCODE_ZDR_ARMED"
const JEV_PROVIDER = "local-jev"
const JEV_CACHE_TTL_MS = 60_000
const DEFAULT_JEV_MIN_CONFIDENCE = 0.6
/** Session entry recording one Jev consult about a shell command. Data-only. */
const ZDR_JEV_ENTRY = "commandcode-zdr.jev"

/** Tool input field that carries a path, for the tools that read one directly. */
const READ_TOOL_PATH: Record<string, string> = {
  read: "path",
  grep: "path",
  find: "path",
  ls: "path",
}

const ZDR_REJECTION = /cmd_zdr_no_providers|no zero-data-retention upstream/i
const EMPTY_RESPONSE = /empty response/i
/** Matches pi's retryable-error pattern ("try your request again"); see the header comment. */
const RETRY_HINT = " (try your request again)"

/** What to do when the provider refuses a request for lacking ZDR routing. */
type Policy = "ask" | "fallback" | "block"

/** Which file the settings editor writes. */
type ZdrScope = "global" | "project"

/** How a Jev consult ended. */
type JevVerdict = "armed" | "skipped" | "blocked" | "guard-off"

/** Where a recorded probability came from. */
type JevSource = "classifier" | "cache" | "none"

/** One Jev consult about a shell command, as written to the session. */
interface JevRecord {
  command: string
  verdict: JevVerdict
  source: JevSource
  probability?: number
  confidence?: number
  detail?: string
  elapsedMs?: number
}

interface ZdrConfig {
  enabled: boolean
  exclusions: string[]
  onUnsupported: Policy
  /**
   * Models seen to reject the header. Persisted so a model that 422s once is
   * not re-asked in every future session, which matters most for the free
   * models that never route to a ZDR upstream. Only the fallback policy and
   * an explicit "ask" answer write here; block never does, since that would
   * silently downgrade the next request.
   */
  rejected: string[]
  /** Folders whose content must never reach a model without ZDR. */
  zones: string[]
  /** Whether to consult the local Jev classifier about shell commands. */
  zonesJev: boolean
  /** Below this confidence, a Jev answer is treated as unsure and asks the user. */
  zonesJevMinConfidence: number
  /** Append a data-only session entry for every Jev consult. */
  zonesJevRecord: boolean
}

/** A config file as written: every field optional so scopes can merge. */
interface ZdrConfigFile {
  enabled?: boolean
  exclusions?: string[]
  onUnsupported?: Policy
  rejected?: string[]
  zones?: string[]
  zonesJev?: boolean
  zonesJevMinConfidence?: number
  zonesJevRecord?: boolean
}

const POLICIES: Policy[] = ["ask", "fallback", "block"]

const DEFAULT_CONFIG: ZdrConfig = {
  enabled: true,
  exclusions: [],
  onUnsupported: "ask",
  rejected: [],
  zones: [],
  zonesJev: true,
  zonesJevMinConfidence: DEFAULT_JEV_MIN_CONFIDENCE,
  zonesJevRecord: true,
}

function isPolicy(value: unknown): value is Policy {
  return typeof value === "string" && (POLICIES as string[]).includes(value)
}

function stringList(value: unknown): string[] {
  return Array.isArray(value)
    ? [...new Set(value.filter((entry): entry is string => typeof entry === "string"))]
    : []
}

/** Only present, valid fields are kept so a project scope can override a subset. */
function parseConfigObject(value: unknown): ZdrConfigFile | null {
  if (typeof value !== "object" || value === null) return null
  const candidate = value as Partial<ZdrConfigFile>
  const file: ZdrConfigFile = {}
  if (typeof candidate.enabled === "boolean") file.enabled = candidate.enabled
  if (isPolicy(candidate.onUnsupported)) file.onUnsupported = candidate.onUnsupported
  if (candidate.exclusions !== undefined) file.exclusions = stringList(candidate.exclusions)
  if (candidate.rejected !== undefined) file.rejected = stringList(candidate.rejected)
  if (candidate.zones !== undefined) file.zones = stringList(candidate.zones)
  if (typeof candidate.zonesJev === "boolean") file.zonesJev = candidate.zonesJev
  if (
    typeof candidate.zonesJevMinConfidence === "number" &&
    Number.isFinite(candidate.zonesJevMinConfidence) &&
    candidate.zonesJevMinConfidence >= 0 &&
    candidate.zonesJevMinConfidence <= 1
  )
    file.zonesJevMinConfidence = candidate.zonesJevMinConfidence
  if (typeof candidate.zonesJevRecord === "boolean") file.zonesJevRecord = candidate.zonesJevRecord
  return file
}

/** Global scope is pi's agent-directory settings.json. */
function globalSettingsPath(): string {
  return join(getAgentDir(), "settings.json")
}

/** Project scope is pi's working-directory .pi/settings.json. */
function projectSettingsPath(cwd: string): string {
  return join(cwd, ".pi", "settings.json")
}

function readSettingsObject(path: string): Record<string, unknown> | null {
  if (!existsSync(path)) return null
  try {
    const raw = readFileSync(path, "utf8").replace(/^\uFEFF/, "")
    const parsed = JSON.parse(raw)
    return typeof parsed === "object" && parsed !== null
      ? (parsed as Record<string, unknown>)
      : null
  } catch {
    return null
  }
}

/** Read the `commandcode-zdr` namespace from a settings.json, if present. */
function readNamespaced(path: string): ZdrConfigFile | null {
  const settings = readSettingsObject(path)
  if (!settings) return null
  return parseConfigObject(settings[SETTINGS_KEY])
}

/**
 * Write the namespace back into a settings.json, preserving every other key pi
 * stores there. pi's own writer spreads the current file before applying its
 * changes, so the namespace survives later pi settings writes too. Returns
 * false instead of overwriting a settings file that exists but cannot be
 * parsed, which would discard pi's configuration.
 */
function writeNamespaced(path: string, config: ZdrConfig): boolean {
  const existing = readSettingsObject(path)
  if (existing === null && existsSync(path)) return false
  const settings = existing ?? {}
  settings[SETTINGS_KEY] = config
  try {
    mkdirSync(dirname(path), { recursive: true })
    writeFileSync(path, `${JSON.stringify(settings, null, 2)}\n`, "utf8")
    return true
  } catch {
    return false
  }
}

/** Pre-settings.json location, read once to migrate an existing config. */
function readLegacyConfig(): ZdrConfigFile | null {
  const path = join(getAgentDir(), LEGACY_CONFIG_FILE)
  if (!existsSync(path)) return null
  try {
    return parseConfigObject(JSON.parse(readFileSync(path, "utf8")))
  } catch {
    return null
  }
}

function mergeConfigFiles(
  global: ZdrConfigFile | null,
  project: ZdrConfigFile | null,
): ZdrConfig | null {
  if (!global && !project) return null
  return {
    enabled: project?.enabled ?? global?.enabled ?? DEFAULT_CONFIG.enabled,
    exclusions: project?.exclusions ?? global?.exclusions ?? [],
    onUnsupported: project?.onUnsupported ?? global?.onUnsupported ?? DEFAULT_CONFIG.onUnsupported,
    rejected: [...new Set([...(global?.rejected ?? []), ...(project?.rejected ?? [])])],
    // Safety is additive, unlike exclusions: a zone in either scope is a zone.
    zones: [...new Set([...(global?.zones ?? []), ...(project?.zones ?? [])])],
    zonesJev: project?.zonesJev ?? global?.zonesJev ?? DEFAULT_CONFIG.zonesJev,
    zonesJevMinConfidence:
      project?.zonesJevMinConfidence ??
      global?.zonesJevMinConfidence ??
      DEFAULT_CONFIG.zonesJevMinConfidence,
    zonesJevRecord:
      project?.zonesJevRecord ?? global?.zonesJevRecord ?? DEFAULT_CONFIG.zonesJevRecord,
  }
}

export default function commandCodeZdr(pi: ExtensionAPI) {
  /** Effective config for the current session; null until settings carry the namespace. */
  let config: ZdrConfig | null = null
  /** Hydrated from the effective config so learned rejections survive a restart. */
  const rejected = new Set<string>()
  /** Models the user released for this session only. Never written to disk. */
  const sessionAllow = new Set<string>()
  /** Models released for exactly the next request. Consumed by the header decider. */
  const onceAllow = new Set<string>()
  /** Project root for project-scoped reads and writes. */
  let cwd = process.cwd()
  let projectTrusted = false
  /** Where the editor writes; defaults to the project scope when it is set. */
  let scope: ZdrScope = "global"
  /** True once a tool has touched a zone; requests then require ZDR unconditionally. */
  let armed = false
  /** Why the session is armed, for the editor status row. */
  let armedSource: string | undefined
  /** Normalized zones for the current cwd. */
  let zones: string[] = []
  /** Recent Jev answers, keyed by command, so repeated calls do not re-classify. */
  const jevCache = new Map<string, { at: number; probability: number }>() /**
   * Session escape hatch chosen at the Jev prompt: zone reads no longer arm ZDR
   * for the rest of the session. In memory only; a reload starts guarded again.
   */
  let zoneGuardOff = false

  // The armed marker is a data-only entry, so without a renderer it is invisible
  // in the transcript. Render it in place so scrolling the branch shows exactly
  // where ZDR was armed and why.
  pi.registerEntryRenderer<ArmedMarker>(ZDR_ARMED_ENTRY, (entry, { expanded }, theme) => {
    const marker = entry.data
    if (!marker) return undefined
    const box = new Box(1, 1, (text) => theme.bg("customMessageBg", text))
    const when = marker.at ? theme.fg("dim", ` ${new Date(marker.at).toLocaleString()}`) : ""
    box.addChild(
      new Text(
        `${theme.fg("accent", "[zdr]")} ${theme.bold(describeArmedMarker(marker))}${when}`,
        0,
        0,
      ),
    )
    if (expanded) {
      box.addChild(
        new Text(
          theme.fg(
            "dim",
            "Protected data was touched, so requests on this branch require zero data retention.",
          ),
          0,
          0,
        ),
      )
    }
    return box
  })

  /**
   * Resolve the effective config for a session.
   *
   * Both scopes come from settings.json: the agent-directory file and the
   * working directory's .pi file. The project scope only participates when the
   * project is trusted, the same gate pi applies. A project field overrides the
   * global one; learned rejections are the union of both.
   */
  function resolveConfig(ctx: ExtensionContext): void {
    cwd = ctx.cwd
    projectTrusted = ctx.isProjectTrusted()
    let global = readNamespaced(globalSettingsPath())
    const project = projectTrusted ? readNamespaced(projectSettingsPath(cwd)) : null
    // One-time move of the old dedicated file, so existing settings are not lost.
    if (!global) {
      const legacy = readLegacyConfig()
      const migrated = legacy ? mergeConfigFiles(legacy, null) : null
      if (migrated && writeNamespaced(globalSettingsPath(), migrated)) global = legacy
    }
    config = mergeConfigFiles(global, project)
    rejected.clear()
    for (const modelId of config?.rejected ?? []) rejected.add(modelId)
    zones = (config?.zones ?? [])
      .map((zone) => normalizeZone(zone, cwd))
      .filter((zone): zone is string => zone !== undefined)
    scope = project ? "project" : "global"
    setCommandCodeZdrExcluded(config?.exclusions ?? [])
    publishDecider()
  }

  /**
   * Publish the header decision to the provider transport, the only path every
   * request takes (including worker agent loops that never run pi's header
   * hook). A missing namespace and no arming leaves it to the CMD_ZDR
   * environment. Arming keeps a decider alive even without saved settings.
   */
  function publishDecider(): void {
    setCommandCodeZdrDecider(config || armed ? (modelId) => sendZdrFor(modelId) : undefined)
  }

  /** Guard so a provider switch does not re-enter through its own model_select. */
  let switching = false

  /**
   * Move the session onto the provider that matches the armed state: the ZDR
   * provider while armed, the plain one otherwise, keeping the model id. Models
   * the ZDR policy excludes are absent from the ZDR catalog, so an armed session
   * stays on the plain provider for them.
   */
  async function applyProviderForArmed(ctx: ExtensionContext): Promise<void> {
    const model = ctx.model
    if (!model || switching) return
    const wanted = armed ? ZDR_PROVIDER : PROVIDER
    const current = armed ? PROVIDER : ZDR_PROVIDER
    if (model.provider !== current) return
    const target = ctx.modelRegistry.find(wanted, model.id)
    if (!target) return
    switching = true
    try {
      // setModel returns false until the host finishes its auth refresh for the
      // freshly registered ZDR provider, so retry briefly.
      for (let attempt = 0; attempt < 4; attempt++) {
        if (await pi.setModel(target)) return
        await new Promise((resolve) => setTimeout(resolve, 150))
      }
    } catch {
      // A failed switch is cosmetic: arming still forces the header in the transport.
    } finally {
      switching = false
    }
  }

  function scopePath(target: ZdrScope): string {
    return target === "project" ? projectSettingsPath(cwd) : globalSettingsPath()
  }

  function saveConfig(next: ZdrConfig, target: ZdrScope = scope): void {
    // The in-memory set is the source of truth for rejections, so a settings
    // edit mid-session cannot write back a stale copy.
    const merged: ZdrConfig = { ...next, rejected: [...rejected] }
    writeNamespaced(scopePath(target), merged)
    config = merged
    // The ZDR catalog hides excluded models, so re-publish it after a change.
    setCommandCodeZdrExcluded(merged.exclusions)
    republishCommandCodeZdr()
  }

  function commandCodeModels(ctx: ExtensionContext): { id: string; name: string }[] {
    const fromRegistry = ctx.modelRegistry
      .getModelsOfType("chat", PROVIDER)
      .map((model) => ({ id: model.id, name: model.name }))
    if (fromRegistry.length > 0) return fromRegistry
    // The registry can still be empty before the provider extension loads its catalog.
    if (!existsSync(CACHE_PATH)) return []
    try {
      const cached = JSON.parse(readFileSync(CACHE_PATH, "utf8")) as {
        models?: { id: string; name: string }[]
      }
      return cached.models ?? []
    } catch {
      return []
    }
  }

  /** Whether the next request for this model carries the header. Consumes a one-shot release. */
  function sendZdrFor(modelId: string): boolean {
    // Armed wins over enabled, exclusions, rejected, sessionAllow, and onceAllow.
    if (armed) return true
    if (!config || !config.enabled) return false
    if (onceAllow.delete(modelId)) return false
    if (config.exclusions.includes(modelId)) return false
    if (sessionAllow.has(modelId)) return false
    if (rejected.has(modelId)) return false
    return true
  }

  /**
   * ZDR governs only Command Code requests. On any other provider the header is
   * never sent and the provider is never switched, so arming has no effect.
   * Keep the zone machinery dormant there instead of marking the session.
   */
  function zdrActiveFor(ctx: ExtensionContext): boolean {
    return isCommandCodeProvider(ctx.model?.provider)
  }

  /** Persist arming on the branch, mirror it into the environment, and notify once. */
  function arm(ctx: ExtensionContext, source: string, detail?: string): void {
    // Nothing to arm on a provider ZDR does not govern.
    if (!zdrActiveFor(ctx)) return
    // One marker per branch is enough to arm it; repeated touches only add noise.
    if (armed) return
    const marker: ArmedMarker = { at: Date.now(), source, ...(detail ? { detail } : {}) }
    pi.appendEntry(ZDR_ARMED_ENTRY, marker)
    process.env[ARMED_ENV] = "1"
    armed = true
    armedSource = source
    publishDecider()
    void applyProviderForArmed(ctx)
    ctx.ui.notify(
      `${describeArmedMarker(marker)}. Protected data was touched, so requests now require zero data retention.`,
      "info",
    )
  }

  function disarm(): void {
    armed = false
    armedSource = undefined
    delete process.env[ARMED_ENV]
    publishDecider()
  }

  /**
   * Turn zone detection off (or back on) for this session only. Off means a
   * zone read no longer arms ZDR and the Jev prompt stops appearing. It never
   * clears arming that already happened: already-read content stays protected.
   */
  function setZoneGuardOff(ctx: ExtensionContext, off: boolean): void {
    if (zoneGuardOff === off) return
    zoneGuardOff = off
    ctx.ui.notify(
      off
        ? "ZDR zone checks are off for the rest of this session: reads inside a zone will not arm ZDR. /commandcode:zdr can turn them back on."
        : "ZDR zone checks are back on for this session.",
      off ? "warning" : "info",
    )
  }

  /**
   * Recompute arming from the current branch, the cwd, and the inherited env.
   * Navigating to a branch that never armed disarms; arming found there (or in
   * the cwd, or inherited from a parent) is persisted so it survives a reload.
   */
  function recomputeArmed(ctx: ExtensionContext): void {
    // ZDR does not govern other providers, so never arm or stay armed there.
    if (!zdrActiveFor(ctx)) {
      disarm()
      return
    }
    // Zone checks were turned off for this session; do not arm on branch changes.
    if (zoneGuardOff) return
    const inherited = process.env[ARMED_ENV] === "1"
    const marker = armedFromEntries(ctx.sessionManager.getBranch() as unknown[])
    const cwdZone = zones.find((zone) => pathInZones(cwd, [zone], cwd))
    const fromBranch = marker !== undefined
    armed = fromBranch || cwdZone !== undefined || inherited
    armedSource = marker?.source ?? (cwdZone ? "cwd" : inherited ? "inherited" : undefined)
    if (armed) {
      process.env[ARMED_ENV] = "1"
      // Persist cwd/inherited arming on the branch; a marker from a previous run is enough.
      if (!fromBranch)
        pi.appendEntry(ZDR_ARMED_ENTRY, {
          at: Date.now(),
          source: armedSource ?? "cwd",
          ...(cwdZone ? { detail: cwdZone } : {}),
        })
    } else {
      delete process.env[ARMED_ENV]
    }
    publishDecider()
    void applyProviderForArmed(ctx)
  }

  /**
   * Decide what to do about a ZDR rejection. Returns true when the request
   * should be retried (without the header), false to leave the error as is.
   */
  async function resolveRejection(
    ctx: ExtensionContext,
    activeConfig: ZdrConfig,
    modelId: string,
  ): Promise<boolean> {
    const reason = `Command Code has no ZDR upstream for ${modelId} (422 cmd_zdr_no_providers).`

    if (armed) {
      ctx.ui.notify(
        `${reason} ZDR is armed because protected data was read, and fallback is disabled while armed. Use /commandcode:zdr to turn enforcement off if that data is no longer in context.`,
        "error",
      )
      return false
    }

    if (activeConfig.onUnsupported === "block") {
      ctx.ui.notify(`${reason} Policy is block, so the request stays failed.`, "error")
      return false
    }

    if (activeConfig.onUnsupported === "fallback") {
      rejected.add(modelId)
      saveConfig(activeConfig)
      ctx.ui.notify(`${reason} Retrying without ZDR, and remembering this model.`, "warning")
      return true
    }

    // With no UI, select() resolves undefined, which lands on block: the safe
    // answer for a ZDR setting.
    const choice = await ctx.ui.select(`${reason} How should this proceed?`, [
      "Retry this request without ZDR",
      "Retry without ZDR for the rest of the session",
      "Add model to exclusions and retry",
      "Block",
    ])
    switch (choice) {
      case "Retry this request without ZDR":
        onceAllow.add(modelId)
        return true
      case "Retry without ZDR for the rest of the session":
        sessionAllow.add(modelId)
        return true
      case "Add model to exclusions and retry":
        saveConfig({ ...activeConfig, exclusions: [...activeConfig.exclusions, modelId] })
        return true
      default:
        return false
    }
  }

  pi.on("session_start", async (_event, ctx) => {
    resolveConfig(ctx)
    recomputeArmed(ctx)
  })

  pi.on("session_tree", async (_event, ctx) => {
    // The branch changed, so arming may have been added or left behind.
    recomputeArmed(ctx)
  })

  // Keep the provider aligned when the model changes, e.g. the user picks
  // another Command Code model while armed.
  pi.on("model_select", async (_event, ctx) => {
    await applyProviderForArmed(ctx)
  })

  pi.on("session_before_switch", async () => {
    disarm()
  })

  pi.on("session_shutdown", async () => {
    disarm()
    setCommandCodeZdrDecider(undefined)
  })

  pi.on("tool_call", async (event, ctx) => {
    // Zone detection only matters where ZDR can be enforced.
    if (!zdrActiveFor(ctx)) return
    // Nothing to detect without zones, with the session guard off, or when an
    // earlier read already armed the branch (the header is already on).
    if (zones.length === 0 || zoneGuardOff || armed) return
    const input = (event.input ?? {}) as Record<string, unknown>
    if (event.toolName === "bash") {
      const command = typeof input.command === "string" ? input.command : ""
      if (!command) return
      const mentioned = commandMentionsZone(command, zones, cwd)
      if (mentioned) {
        arm(ctx, "bash", mentioned)
        return
      }
      return consultJev(ctx, command)
    }
    const field = READ_TOOL_PATH[event.toolName]
    if (field) {
      const value = input[field]
      if (typeof value === "string" && pathInZones(value, zones, cwd))
        arm(ctx, event.toolName, value)
      return
    }
    // Any other tool: a string argument naming a zone is enough to arm. Over-arming is safe.
    for (const value of Object.values(input)) {
      if (typeof value === "string" && pathInZones(value, zones, cwd)) {
        arm(ctx, event.toolName, value)
        return
      }
    }
  })

  /**
   * Write one Jev consult to the session, mirroring the model router's decision
   * entries. A data-only custom entry is never sent to the model, so this costs
   * no context and the decision can be read back from the session file later.
   */
  function recordJev(ctx: ExtensionContext, record: JevRecord): void {
    if (config?.zonesJevRecord === false) return
    try {
      pi.appendEntry(ZDR_JEV_ENTRY, {
        at: new Date().toISOString(),
        cwd,
        zones,
        ...record,
        ...(record.probability !== undefined
          ? { probability: Math.round(record.probability * 1000) / 1000 }
          : {}),
        ...(record.confidence !== undefined
          ? { confidence: Math.round(record.confidence * 1000) / 1000 }
          : {}),
      })
    } catch {
      // Recording is a convenience; never let it fail a command.
    }
  }

  /**
   * Ask the local pi-jev classifier (`local-jev`) about a shell command the
   * textual match missed. Returns a block result only when the user refuses.
   */
  async function consultJev(
    ctx: ExtensionContext,
    command: string,
  ): Promise<{ block?: boolean; reason?: string } | undefined> {
    if (config?.zonesJev === false) return
    if (zoneGuardOff || armed) return
    const started = Date.now()
    const models = ctx.modelRegistry.getModelsOfType("classifier", JEV_PROVIDER)
    if (models.length === 0) {
      recordJev(ctx, {
        command,
        source: "none",
        verdict: "skipped",
        detail: `No ${JEV_PROVIDER} classifier is registered.`,
        elapsedMs: Date.now() - started,
      })
      return
    }

    const min = config?.zonesJevMinConfidence ?? DEFAULT_JEV_MIN_CONFIDENCE
    const cached = jevCache.get(command)
    let probability: number | undefined
    let source: JevSource = "classifier"
    if (cached && Date.now() - cached.at < JEV_CACHE_TTL_MS) {
      probability = cached.probability
      source = "cache"
    } else {
      try {
        const result = await ctx.modelRegistry.classify(models[0], {
          state: { cwd, command, zones },
          questions: {
            reads_zone: {
              type: "bool",
              instructions:
                "Could running this shell command read, print, copy, encode, or transmit the contents of a file inside one of the protected directories? Consider variables, concatenation, quoting, globs, subshells, interpreters, scripts, and symlinks.",
              criteria: {
                true: "It could reach protected content",
                false: "It cannot reach protected content",
              },
            },
          },
        })
        const answer = result.answers.reads_zone
        if (answer?.type === "bool") {
          probability = answer.probability
          jevCache.set(command, { at: Date.now(), probability })
        } else {
          source = "none"
        }
      } catch {
        probability = undefined
        source = "none"
      }
    }

    const confidence = probability === undefined ? undefined : Math.abs(probability - 0.5) * 2
    if (probability !== undefined) {
      if (probability >= 0.5) {
        arm(ctx, "jev", command)
        recordJev(ctx, {
          command,
          source,
          verdict: "armed",
          probability,
          elapsedMs: Date.now() - started,
        })
        return
      }
      if ((confidence ?? 0) >= min) {
        recordJev(ctx, {
          command,
          source,
          verdict: "skipped",
          probability,
          confidence,
          elapsedMs: Date.now() - started,
        })
        return
      }
    }

    const detail =
      probability === undefined
        ? "The local Jev classifier was unavailable."
        : `The local Jev classifier put the chance this reads a zone at ${Math.round(
            probability * 100,
          )}%, too close to call.`

    if (ctx.mode !== "tui") {
      arm(ctx, "jev", command)
      ctx.ui.notify(
        `ZDR: ${detail} There is no terminal to ask in, so enforcement is armed.`,
        "warning",
      )
      recordJev(ctx, {
        command,
        source,
        verdict: "armed",
        probability,
        confidence,
        detail: `${detail} No terminal to ask in.`,
        elapsedMs: Date.now() - started,
      })
      return
    }

    const choice = await ctx.ui.select(
      `This command may read a ZDR zone.\n${command}\n\n${detail}`,
      [
        "Arm ZDR for this session (recommended)",
        "Run it without arming",
        "Don't arm for the rest of this session",
        "Block the command",
      ],
    )
    const record = {
      command,
      source,
      probability,
      confidence,
      detail,
      elapsedMs: Date.now() - started,
    }
    if (choice === "Arm ZDR for this session (recommended)") {
      arm(ctx, "jev", command)
      recordJev(ctx, { ...record, verdict: "armed" })
      return
    }
    if (choice === "Don't arm for the rest of this session") {
      setZoneGuardOff(ctx, true)
      recordJev(ctx, { ...record, verdict: "guard-off" })
      return
    }
    if (choice === "Block the command") {
      recordJev(ctx, { ...record, verdict: "blocked" })
      return { block: true, reason: `ZDR: refused at the prompt.\n${command}` }
    }
    recordJev(ctx, { ...record, verdict: "skipped" })
    return
  }

  pi.on("message_end", async (event, ctx) => {
    const message = event.message
    if (message.role !== "assistant") return

    if (
      !isCommandCodeProvider(message.provider) ||
      message.stopReason !== "error" ||
      !message.errorMessage
    )
      return

    const error = message.errorMessage
    const retryable = { message: { ...message, errorMessage: `${error}${RETRY_HINT}` } }

    if (EMPTY_RESPONSE.test(error)) return retryable

    // The transport owns the header decision, so a rejection is any error from
    // an enabled policy. The model id comes from the message that failed.
    const modelId = (message as { model?: string }).model ?? ctx.model?.id
    if (!config || !modelId || !ZDR_REJECTION.test(error)) return
    return (await resolveRejection(ctx, config, modelId)) ? retryable : undefined
  })

  /** Modal model picker used by the "+ exclude a model" row. */
  async function pickModel(ctx: ExtensionContext, base: ZdrConfig): Promise<string | undefined> {
    const available = commandCodeModels(ctx).filter((model) => !base.exclusions.includes(model.id))
    if (available.length === 0) {
      ctx.ui.notify("No Command Code models left to exclude", "warning")
      return undefined
    }
    const picked = await ctx.ui.select(
      "Models that never receive x-cmd-zdr",
      available.map((model) => model.name),
    )
    if (!picked) return undefined
    return available.find((model) => model.name === picked)?.id
  }

  pi.registerCommand("commandcode:zdr", {
    description: "Command Code zero-data-retention policy",
    handler: async (_args, ctx) => {
      if (ctx.mode !== "tui") {
        ctx.ui.notify("/commandcode:zdr requires TUI mode", "error")
        return
      }

      // Re-resolve so the editor reflects the session's cwd and trust even if
      // session_start never ran for this context.
      resolveConfig(ctx)

      // Opening the editor is the opt-in that takes header ownership over.
      let current = config ?? { ...DEFAULT_CONFIG }

      const apply = (next: ZdrConfig) => {
        current = next
        saveConfig(next)
      }

      await ctx.ui.custom((tui, theme, _keybindings, done) => {
        const scopeItem: SettingItem = {
          id: "scope",
          label: "Save settings to",
          description: projectTrusted
            ? "global: every project. project: this repo only, in .pi/settings.json. Switching writes the current values to that scope."
            : "global: every project. Project scope is unavailable until this project is trusted.",
          currentValue: scope === "project" ? "project" : "global",
          values: projectTrusted ? ["global", "project"] : ["global"],
        }

        const items: SettingItem[] = [
          scopeItem,
          {
            id: "zones",
            label: "ZDR zones",
            description:
              zones.length > 0
                ? `Reading inside these folders arms ZDR for the session: ${formatZoneList(
                    zones,
                  )}. Edit the commandcode-zdr.zones array in settings.json to change them.`
                : "None. Add a commandcode-zdr.zones array of folders in settings.json.",
            currentValue: zones.length > 0 ? String(zones.length) : "none",
            values: [zones.length > 0 ? String(zones.length) : "none"],
          },
          {
            id: "zonesJev",
            label: "Zone check via Jev",
            description:
              "on: ask the local Jev classifier about commands the path check misses, and ask you when it is unsure. off: path matching only.",
            currentValue: current.zonesJev ? "on" : "off",
            values: ["on", "off"],
          },
          {
            id: "zoneGuard",
            label: "Zone checks (this session)",
            description: zoneGuardOff
              ? "off: a read inside a zone does not arm ZDR for the rest of this session. Switch to on to restore. Arming already in effect is kept."
              : "on: a read or command inside a zone arms ZDR for the session.",
            currentValue: zoneGuardOff ? "off" : "on",
            values: ["on", "off"],
          },
          {
            id: "zonesJevRecord",
            label: "Record Jev decisions",
            description:
              "on: append a commandcode-zdr.jev session entry per command with the classifier probability and the verdict. Data-only, never sent to the model.",
            currentValue: current.zonesJevRecord ? "on" : "off",
            values: ["on", "off"],
          },
          {
            id: "armed",
            label: "Zone enforcement",
            description: armed
              ? `Armed by ${armedSource ?? "a zone read"}; requests require zero data retention.`
              : "Not armed. No ZDR-zone data has been touched this session.",
            currentValue: armed ? "armed" : "idle",
            values: [armed ? "armed" : "idle"],
          },
          {
            id: "enabled",
            label: "ZDR enforcement",
            description: "on: send x-cmd-zdr: 1 on Command Code requests that are not excluded.",
            currentValue: current.enabled ? "on" : "off",
            values: ["on", "off"],
          },
          {
            id: "onUnsupported",
            label: "When provider returns 422",
            description:
              "block: leave the request failed. fallback: retry without ZDR and remember the model. ask: prompt, then retry or stop.",
            currentValue: current.onUnsupported,
            values: POLICIES,
          },
          {
            id: "add",
            label: "+ exclude a model",
            description:
              "Never sends x-cmd-zdr, even when enforcement is on. Close and reopen to see the new row.",
            currentValue: `${current.exclusions.length} excluded`,
            values: ["open…"],
          },
        ]

        for (const modelId of current.exclusions) {
          items.push({
            id: `exclusion:${modelId}`,
            label: modelId,
            description: "Switch to enforced to send ZDR for this model again.",
            currentValue: "excluded",
            values: ["excluded", "enforced"],
          })
        }

        for (const modelId of rejected) {
          if (current.exclusions.includes(modelId)) continue
          items.push({
            id: `rejected:${modelId}`,
            label: modelId,
            description:
              "Rejected x-cmd-zdr with 422, so it is sent without. Switch to forget to test it again.",
            currentValue: "no zdr",
            values: ["no zdr", "forget"],
          })
        }

        const settingsList = new SettingsList(
          items,
          Math.min(items.length + 2, 15),
          getSettingsListTheme(),
          (id, newValue) => {
            if (id === "scope") {
              if (newValue !== "global" && newValue !== "project") return
              if (newValue === "project" && !projectTrusted) return
              scope = newValue
              // Persist the current values into the new scope so it now owns them.
              saveConfig(current, scope)
              return
            }
            if (id === "zonesJev") {
              apply({ ...current, zonesJev: newValue === "on" })
              return
            }
            if (id === "zoneGuard") {
              setZoneGuardOff(ctx, newValue === "off")
              return
            }
            if (id === "zonesJevRecord") {
              apply({ ...current, zonesJevRecord: newValue === "on" })
              return
            }
            if (id === "enabled") {
              apply({ ...current, enabled: newValue === "on" })
              return
            }
            if (id === "onUnsupported") {
              if (isPolicy(newValue)) apply({ ...current, onUnsupported: newValue })
              return
            }
            if (id.startsWith("exclusion:")) {
              const modelId = id.slice("exclusion:".length)
              apply({
                ...current,
                exclusions:
                  newValue === "excluded"
                    ? [...current.exclusions, modelId]
                    : current.exclusions.filter((entry) => entry !== modelId),
              })
              return
            }
            if (id.startsWith("rejected:")) {
              const modelId = id.slice("rejected:".length)
              if (newValue === "forget") rejected.delete(modelId)
              else rejected.add(modelId)
              apply({ ...current })
              return
            }
            if (id === "add") {
              void (async () => {
                const base = current
                const modelId = await pickModel(ctx, base)
                if (!modelId) return
                apply({ ...base, exclusions: [...base.exclusions, modelId] })
                ctx.ui.notify(`Excluded ${modelId}. Reopen to see it in the list.`, "info")
              })()
            }
          },
          () => done(undefined),
        )

        const container = new Container()
        container.addChild(
          new (class {
            render(_width: number) {
              return [theme.fg("accent", theme.bold("Command Code ZDR")), ""]
            }
            invalidate() {}
          })(),
        )
        container.addChild(settingsList)

        return {
          render(width: number) {
            return container.render(width)
          },
          invalidate() {
            container.invalidate()
          },
          handleInput(data: string) {
            settingsList.handleInput?.(data)
            tui.requestRender()
          },
        }
      })

      ctx.ui.notify(
        current.enabled
          ? `ZDR on for ${scope}, ${current.exclusions.length} model(s) excluded, ${zones.length} zone(s)`
          : `ZDR off for ${scope}, ${zones.length} zone(s)`,
        "info",
      )
    },
  })
}
