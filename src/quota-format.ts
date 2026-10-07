import type {
  CommandCodeQuota,
  CommandCodeSubscription,
  CommandCodeWindowLimit,
} from "./quota-types.ts"

/** Cells in the report progress bar. Mirrors the pi-usage report width. */
export const BAR_WIDTH = 10

const WINDOW_LABELS: Record<CommandCodeWindowLimit["window"], string> = {
  fiveHour: "5h",
  weekly: "7d",
}

/**
 * Percent of the budget still available, clamped to 0..100.
 *
 * A zero or missing cap counts as fully used: the API reports such windows as
 * unusable, and dividing by zero would render NaN.
 */
export function percentRemaining(used: number, cap: number): number {
  if (!(cap > 0)) return 0
  return Math.min(100, Math.max(0, Math.round((1 - used / cap) * 100)))
}

export function windowRemainingPercent(limit: CommandCodeWindowLimit): number {
  return percentRemaining(limit.used, limit.cap)
}

/** A `[████░░░░░░]` bar for a 0..100 percentage. Uncolored so callers can style it. */
export function progressBar(percent: number, width: number = BAR_WIDTH): string {
  const clamped = Math.min(100, Math.max(0, percent))
  const filled = Math.round((clamped / 100) * width)
  return `${"█".repeat(filled)}${"░".repeat(width - filled)}`
}

/**
 * One `5h  [████░░░░░░]  50% (resets in 2h 14m)` line per window.
 *
 * The percentage is budget remaining, not used, so the bar and the number
 * always shrink together as the window fills.
 */
export function formatWindowLimits(
  limits: readonly CommandCodeWindowLimit[],
  now: () => number = Date.now,
): string[] {
  return formatWindowRows(
    limits.map((limit) => ({
      label: WINDOW_LABELS[limit.window],
      used: limit.used,
      cap: limit.cap,
      resetAt: limit.resetAt,
    })),
    now,
  )
}

interface WindowRow {
  label: string
  /** Omit both `used` and `cap` to render a row without a meter. */
  used?: number
  cap?: number
  resetAt: number | null
  detail?: string
}

/**
 * One `label [bar] NN% (resets ...) detail` line per row, label column padded
 * to the widest label so the bars line up.
 */
function formatWindowRows(rows: readonly WindowRow[], now: () => number): string[] {
  const labelWidth = Math.max(0, ...rows.map((row) => row.label.length))
  return rows.map((row) => {
    const label = row.label.padEnd(labelWidth)
    const meter =
      row.used === undefined || row.cap === undefined
        ? ""
        : (() => {
            const remaining = percentRemaining(row.used, row.cap)
            return `[${progressBar(remaining)}] ${String(remaining).padStart(3)}%`
          })()
    const reset = row.resetAt === null ? "" : `(resets ${formatResetClock(row.resetAt, now)})`
    return [label, meter, reset, row.detail ?? ""].filter((part) => part.length > 0).join(" ")
  })
}

export function formatResetClock(resetAtSeconds: number, now: () => number): string {
  const date = new Date(resetAtSeconds * 1000)
  if (Number.isNaN(date.getTime())) return "unknown"
  const diffMs = date.getTime() - now()
  if (diffMs <= 0) return "soon"
  const minutes = Math.ceil(diffMs / 60_000)
  if (minutes < 60) return `in ${minutes}m`
  const hours = Math.floor(minutes / 60)
  const remainingMinutes = minutes % 60
  if (hours < 24) {
    return remainingMinutes > 0 ? `in ${hours}h ${remainingMinutes}m` : `in ${hours}h`
  }
  const days = Math.floor(hours / 24)
  return days === 1 ? "in 1 day" : `in ${days} days`
}

function parsePeriodEnd(value: string): Date | null {
  const trimmed = value.trim()
  const timestamp = /^\d+$/.test(trimmed) ? Number(trimmed) : Date.parse(trimmed)
  if (!Number.isFinite(timestamp) || timestamp < 0) return null
  const milliseconds = timestamp >= 1e12 ? timestamp : timestamp * 1000
  const date = new Date(milliseconds)
  return Number.isNaN(date.getTime()) ? null : date
}

function periodEndSeconds(subscription: CommandCodeSubscription | null): number | null {
  if (!subscription?.currentPeriodEnd) return null
  const end = parsePeriodEnd(subscription.currentPeriodEnd)
  return end === null ? null : Math.round(end.getTime() / 1000)
}

/**
 * Render the report: every remaining-usage window as a bar.
 *
 * The 30d row is derived, not reported: the credits endpoint carries the
 * remaining balance but no cap, so the cap is the remaining balance plus the
 * billing-period spend from `usage/summary`. Its reset is the subscription's
 * period end.
 */
export function formatQuota(quota: CommandCodeQuota, now: () => number = Date.now): string {
  const lines: string[] = []

  const rows: WindowRow[] = []
  const credits = quota.credits
  if (credits) {
    const used = quota.summary?.totalMonthlyCredits ?? quota.summary?.totalCost
    const resetAt = periodEndSeconds(quota.subscription)
    if (used === undefined) {
      rows.push({
        label: "30d",
        resetAt,
        detail: `$${credits.remainingCredits.toFixed(2)}`,
      })
    } else {
      const cap = credits.remainingCredits + used
      rows.push({
        label: "30d",
        used,
        cap,
        resetAt,
        detail: `$${credits.remainingCredits.toFixed(2)}/$${cap.toFixed(2)}`,
      })
    }
  }
  for (const limit of credits?.windowLimits ?? []) {
    rows.push({
      label: WINDOW_LABELS[limit.window],
      used: limit.used,
      cap: limit.cap,
      resetAt: limit.resetAt,
    })
  }

  if (rows.length > 0) {
    lines.push("Usage windows (remaining)")
    lines.push(...formatWindowRows(rows, now).map((line) => `  ${line}`))
  }

  if ((quota.unavailable?.length ?? 0) > 0) {
    if (lines.length > 0) lines.push("")
    lines.push(`Unavailable: ${quota.unavailable?.join(", ")}`)
  }

  return lines.join("\n")
}
