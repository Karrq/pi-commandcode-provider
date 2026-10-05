import type {
  CommandCodeCredits,
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
  const labelWidth = Math.max(0, ...limits.map((limit) => WINDOW_LABELS[limit.window].length))
  return limits.map((limit) => {
    const remaining = windowRemainingPercent(limit)
    const label = WINDOW_LABELS[limit.window].padEnd(labelWidth)
    const reset = limit.resetAt === null ? "" : ` (resets ${formatResetClock(limit.resetAt, now)})`
    return `${label} [${progressBar(remaining)}] ${String(remaining).padStart(3)}%${reset}`
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

function creditsDetail(credits: CommandCodeCredits | null): string | undefined {
  if (!credits) return undefined
  const parts = [
    `monthly $${credits.monthlyCredits.toFixed(2)}`,
    `purchased $${credits.purchasedCredits.toFixed(2)}`,
  ]
  if (credits.freeCredits > 0) parts.push(`free $${credits.freeCredits.toFixed(2)}`)
  return `Sources: ${parts.join(" / ")}`
}

function parsePeriodEnd(value: string): Date | null {
  const trimmed = value.trim()
  const timestamp = /^\d+$/.test(trimmed) ? Number(trimmed) : Date.parse(trimmed)
  if (!Number.isFinite(timestamp) || timestamp < 0) return null
  const milliseconds = timestamp >= 1e12 ? timestamp : timestamp * 1000
  const date = new Date(milliseconds)
  return Number.isNaN(date.getTime()) ? null : date
}

function subscriptionLine(
  subscription: CommandCodeSubscription,
  now: () => number = Date.now,
): string {
  const plan = (subscription.planId ?? "Unknown").replace(/[_-]+/g, " ").trim()
  const status = subscription.status ? ` (${subscription.status})` : ""
  let renewal = ""
  if (subscription.currentPeriodEnd) {
    const end = parsePeriodEnd(subscription.currentPeriodEnd)
    if (end) {
      const diffMs = end.getTime() - now()
      const days = Math.ceil(diffMs / 86_400_000)
      const dateStr = end.toLocaleDateString("en-US", {
        month: "short",
        day: "numeric",
        timeZone: "UTC",
      })
      if (days > 0) {
        renewal = ` · renews ${dateStr} (${days}d)`
      } else if (days === 0) {
        renewal = ` · renews ${dateStr} (today)`
      } else {
        renewal = ` · renewed ${dateStr}`
      }
    }
  }
  return `Plan: ${plan}${status}${renewal}`
}

function formatTokens(tokens: number): string {
  if (tokens >= 1_000_000_000) return `${(tokens / 1_000_000_000).toFixed(1)}B`
  if (tokens >= 1_000_000) return `${(tokens / 1_000_000).toFixed(1)}M`
  if (tokens >= 1_000) return `${(tokens / 1_000).toFixed(1)}k`
  return String(tokens)
}

export function formatQuota(quota: CommandCodeQuota, now: () => number = Date.now): string {
  const lines: string[] = []
  const remaining = quota.credits?.remainingCredits ?? 0
  const spent = quota.summary?.totalCost ?? 0
  const pool = remaining + spent

  if (quota.credits || quota.summary) {
    const left = percentRemaining(spent, pool)
    const bar = pool > 0 ? ` [${progressBar(left)}] ${String(left).padStart(3)}%` : ""
    lines.push(`Credits${bar}`)
    lines.push(`  Remaining: $${remaining.toFixed(2)} of $${pool.toFixed(2)}`)
    lines.push(`  Used: $${spent.toFixed(2)}`)
  }

  const detail = creditsDetail(quota.credits)
  if (detail) lines.push(detail)
  if (quota.subscription) lines.push(subscriptionLine(quota.subscription, now))

  if (quota.summary) {
    lines.push("")
    lines.push(quota.subscription?.currentPeriodStart ? "Usage (billing period)" : "Usage")
    lines.push(`  Cost: $${quota.summary.totalCost.toFixed(2)}`)
    lines.push(`  Requests: ${quota.summary.totalCount.toLocaleString("en-US")}`)
    if (quota.summary.totalTokens !== undefined) {
      lines.push(`  Tokens: ${formatTokens(quota.summary.totalTokens)}`)
    }
  }

  const limits = quota.credits?.windowLimits ?? []
  if (limits.length > 0) {
    lines.push("")
    lines.push("Usage windows (remaining)")
    lines.push(...formatWindowLimits(limits, now).map((line) => `  ${line}`))
  }

  if ((quota.unavailable?.length ?? 0) > 0) {
    lines.push("")
    lines.push(`Unavailable: ${quota.unavailable?.join(", ")}`)
  }

  lines.push("")
  lines.push("Full detail: https://commandcode.ai/usage")
  return lines.join("\n")
}
