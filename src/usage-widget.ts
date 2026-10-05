/**
 * Pure parts of the Command Code usage widget.
 *
 * The widget itself lives in the `commandcode-usage` extension entry, which
 * owns the host UI, the lifecycle wiring, and the config file. This module
 * keeps the parsing and formatting host-agnostic so it can be unit tested
 * without a runtime or a theme.
 */

import { formatResetClock } from "./quota-format.ts"
import type { CommandCodeQuota, CommandCodeWindowLimit } from "./quota-types.ts"

export interface UsageSettings {
  /** Render the usage line below the editor while the provider is active. */
  widget: boolean
}

export const DEFAULT_USAGE_SETTINGS: UsageSettings = { widget: true }

export function parseUsageSettings(raw: string): UsageSettings | null {
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return null
  }
  if (typeof parsed !== "object" || parsed === null) return null
  const candidate = parsed as Partial<UsageSettings>
  return {
    widget:
      typeof candidate.widget === "boolean" ? candidate.widget : DEFAULT_USAGE_SETTINGS.widget,
  }
}

/** Latest snapshot the widget renders: a quota, an error, or neither while loading. */
export interface UsageWidgetState {
  quota: CommandCodeQuota | null
  error?: string
}

/** Theme foreground tokens the widget uses. A subset of the host `ThemeColor`. */
export type UsageColor = "accent" | "muted" | "dim" | "success" | "warning" | "error"

export type Colorize = (color: UsageColor, text: string) => string

const WINDOW_LABELS: Record<CommandCodeWindowLimit["window"], string> = {
  fiveHour: "5h",
  weekly: "7d",
}

/** Filled cells in the mini bar. */
const BAR_WIDTH = 5

export function remainingPercent(limit: CommandCodeWindowLimit): number {
  if (!(limit.cap > 0)) return 0
  return Math.min(100, Math.max(0, Math.round((1 - limit.used / limit.cap) * 100)))
}

function severity(remaining: number): UsageColor {
  if (remaining >= 50) return "success"
  if (remaining >= 20) return "warning"
  return "error"
}

function renderWindow(limit: CommandCodeWindowLimit, now: number, color: Colorize): string {
  const remaining = remainingPercent(limit)
  const filled = Math.round((remaining / 100) * BAR_WIDTH)
  const bar = `${"█".repeat(filled)}${"░".repeat(BAR_WIDTH - filled)}`
  const tone = severity(remaining)

  const reset =
    limit.resetAt === null
      ? ""
      : color("dim", ` ${formatResetClock(limit.resetAt, () => now).replace(/^in /, "↻")}`)

  return `${color("muted", WINDOW_LABELS[limit.window])} ${color(tone, bar)} ${color(tone, `${remaining}%`)}${reset}`
}

/**
 * One line for the widget. Loading, error, and "no windows reported" each
 * collapse to a single dim or error line so the widget never disappears
 * silently and never grows past one row.
 */
export function formatUsageWidget(
  state: UsageWidgetState | undefined,
  now: number,
  color: Colorize,
): string[] {
  if (!state) return [color("dim", "Command Code usage loading…")]
  if (state.error) return [color("error", `Command Code usage: ${state.error}`)]

  const windows = state.quota?.credits?.windowLimits ?? []
  if (windows.length === 0) {
    return [color("dim", "Command Code usage unavailable")]
  }

  const parts = windows.map((limit) => renderWindow(limit, now, color))
  return [`${color("accent", "CC")} ${parts.join(color("dim", " · "))}`]
}
