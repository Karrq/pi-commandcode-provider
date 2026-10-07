export interface CommandCodeWindowLimit {
  window: "fiveHour" | "weekly"
  used: number
  cap: number
  resetAt: number | null
}

export interface CommandCodeCredits {
  monthlyCredits: number
  purchasedCredits: number
  freeCredits: number
  remainingCredits: number
  windowLimits: CommandCodeWindowLimit[]
}

export interface CommandCodeSubscription {
  planId: string | null
  status: string | null
  currentPeriodStart: string | null
  currentPeriodEnd: string | null
}

export interface CommandCodeUsageSummary {
  totalCost: number
  totalCount: number
  totalTokens?: number
  /** Monthly credits spent this billing period, when the API reports it. */
  totalMonthlyCredits?: number
}

export type CommandCodeQuotaSection = "credits" | "subscription" | "usage"

export interface CommandCodeQuota {
  account: {
    login: string
    orgId: string | null
    keyName?: string
  }
  credits: CommandCodeCredits | null
  subscription: CommandCodeSubscription | null
  summary: CommandCodeUsageSummary | null
  unavailable?: readonly CommandCodeQuotaSection[]
}

/**
 * Reuses a resolved account identity instead of re-calling `whoami`.
 *
 * Keyed by API key so a rotated or refreshed credential misses by construction.
 * The quota layer never writes to the host's auth file; implementations decide
 * where the entry lives.
 */
export interface QuotaAccountCache {
  get(apiKey: string): CommandCodeQuota["account"] | undefined
  set(apiKey: string, account: CommandCodeQuota["account"]): void
  delete(apiKey: string): void
}

export type CommandCodeQuotaErrorKind = "config" | "http" | "network" | "timeout"

export type CommandCodeQuotaResult =
  | { ok: true; quota: CommandCodeQuota }
  | { ok: false; error: { message: string; kind: CommandCodeQuotaErrorKind } }
