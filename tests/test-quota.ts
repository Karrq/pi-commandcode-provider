/**
 * Unit tests for the Command Code quota layer (src/quota.ts).
 *
 * These are hermetic: no pi runtime and no network. Fetching is exercised with
 * a mocked `fetchImpl`, while parsing and formatting are pure function checks.
 */

import assert from "node:assert/strict"
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { describe, it } from "node:test"

import { formatQuota, formatWindowLimits } from "../src/quota-format.ts"
import {
  DEFAULT_API_BASE,
  fetchCommandCodeQuota,
  redactValue,
  windowLimitsFromCredits,
} from "../src/quota.ts"
import { createDiskQuotaAccountCache } from "../src/quota-account-cache.ts"
import type {
  CommandCodeCredits,
  CommandCodeQuota,
  CommandCodeWindowLimit,
} from "../src/quota-types.ts"

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "content-type": "application/json" },
  })
}

function okFetch(handlers: Record<string, unknown>) {
  const urls: string[] = []
  const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
    const url = String(input)
    urls.push(url)
    for (const [needle, body] of Object.entries(handlers)) {
      if (url.includes(needle)) return jsonResponse(body)
    }
    throw new Error(`Unexpected URL: ${url}`)
  }
  return { fetchImpl, urls: () => urls }
}

describe("Command Code quota", () => {
  it("parses window limits from the credits windowLimits object", () => {
    const limits = windowLimitsFromCredits({
      limited: true,
      // resetAt as reported by the live API: milliseconds since epoch.
      fiveHour: { used: 8, cap: 14, resetAt: 1_700_000_000_000 },
      weekly: { used: 30, cap: 35, resetAt: 1_700_000_000_000 },
    })
    assert.deepEqual(limits, [
      { window: "fiveHour", used: 8, cap: 14, resetAt: 1_700_000_000 },
      { window: "weekly", used: 30, cap: 35, resetAt: 1_700_000_000 },
    ])
  })

  it("skips empty window limit entries", () => {
    const limits = windowLimitsFromCredits({
      limited: false,
      fiveHour: { used: 0, cap: 0, resetAt: null },
      weekly: { used: 0, cap: 0, resetAt: null },
    })
    assert.deepEqual(limits, [])
  })

  it("parses resetAt as numeric string or ISO timestamp string", () => {
    const limits = windowLimitsFromCredits({
      fiveHour: { used: 1, cap: 2, resetAt: "1700000000000" },
      weekly: { used: 1, cap: 2, resetAt: "2023-11-14T22:13:20.000Z" },
    })
    // numeric ms string -> epoch seconds; ISO string -> epoch seconds
    assert.equal(limits[0]?.resetAt, 1_700_000_000)
    assert.equal(limits[1]?.resetAt, 1_700_000_000)
  })

  it("renders a 30d window from reported credits without a billing-period section", () => {
    const quota: CommandCodeQuota = {
      account: { login: "alice", orgId: null },
      credits: {
        monthlyCredits: 0,
        purchasedCredits: 0,
        freeCredits: 0,
        remainingCredits: 0,
        windowLimits: [],
      },
      subscription: null,
      summary: { totalCost: 0, totalCount: 0 },
    }
    const output = formatQuota(quota, () => 1_700_000_000_000)
    assert.doesNotMatch(output, /billing period/)
    assert.doesNotMatch(output, /Requests:/)
    assert.match(output, /Usage windows \(remaining\)/)
    assert.match(output, /30d \[[█░]+\] +0% \$0\.00\/\$0\.00/)
  })

  it("formats window limits with percentage and reset clock", () => {
    const limits: CommandCodeWindowLimit[] = [
      { window: "fiveHour", used: 7, cap: 14, resetAt: 1_700_000_000 },
      { window: "weekly", used: 0, cap: 35, resetAt: null },
    ]
    const lines = formatWindowLimits(limits)
    assert.match(lines[0] ?? "", /^5h \[[█░]+\] +50% \(resets soon\)$/)
    assert.match(lines[1] ?? "", /^7d \[[█░]+\] +100%$/)
  })

  it("uses the injected clock for the reset countdown", () => {
    const limit: CommandCodeWindowLimit = {
      window: "fiveHour",
      used: 7,
      cap: 14,
      resetAt: 1_700_000_000, // seconds since epoch
    }
    // now() shortly before reset -> a short "in Nm" countdown
    const soon = formatWindowLimits([limit], () => 1_699_999_000 * 1000)[0]
    assert.match(soon ?? "", /\(resets in \d+m\)/)
    // already past reset -> "soon"
    const past = formatWindowLimits([limit], () => 1_700_100_000 * 1000)[0]
    assert.match(past ?? "", /\(resets soon\)/)
  })

  it("fetches and normalizes the full quota snapshot", async () => {
    const { fetchImpl, urls } = okFetch({
      whoami: { user: { userName: "alice" }, org: { id: "org_1", login: "alice-inc" } },
      credits: {
        credits: {
          monthlyCredits: 40,
          purchasedCredits: 10,
          freeCredits: 5,
          planId: "pro",
        },
        windowLimits: {
          fiveHour: { used: 8, cap: 16, resetAt: 1_700_000_000_000 },
          weekly: { used: 20, cap: 40, resetAt: null },
        },
      },
      subscriptions: {
        data: {
          planId: "pro",
          status: "active",
          currentPeriodStart: "2026-01-01T00:00:00Z",
          currentPeriodEnd: "2026-02-01T00:00:00Z",
        },
      },
      summary: { totalCost: 12.34, totalCount: 1500 },
    })

    const result = await fetchCommandCodeQuota({ apiKey: "cc_test_key", fetchImpl })
    assert.equal(result.ok, true)
    if (!result.ok) return

    assert.equal(result.quota.account.login, "alice-inc")
    assert.equal(result.quota.account.orgId, "org_1")
    assert.deepEqual(result.quota.credits?.remainingCredits, 55)
    assert.equal(result.quota.credits?.windowLimits.length, 2)
    assert.equal(result.quota.subscription?.planId, "pro")
    assert.equal(result.quota.summary?.totalCost, 12.34)

    // Regression: requested URLs must carry the base exactly once (no
    // double prefix), and all hit the alpha usage endpoints.
    const fetched = urls()
    assert.equal(fetched.length, 4)
    for (const url of fetched) {
      assert.ok(
        /^https:\/\/api\.commandcode\.ai\/alpha\//.test(url),
        `expected base-prefixed alpha URL, got: ${url}`,
      )
      assert.equal((url.match(/https:\/\//g) ?? []).length, 1)
      assert.equal(url.includes(`${DEFAULT_API_BASE}${DEFAULT_API_BASE}`), false)
    }
  })

  it("reuses the injected account cache and drops it after a failed request", async () => {
    const requests: string[] = []
    const stored = new Map<string, CommandCodeQuota["account"]>()
    const accountCache = {
      get: (apiKey: string) => stored.get(apiKey),
      set: (apiKey: string, account: CommandCodeQuota["account"]) => {
        stored.set(apiKey, account)
      },
      delete: (apiKey: string) => {
        stored.delete(apiKey)
      },
    }
    const okFetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input)
      requests.push(url)
      if (url.includes("whoami")) return jsonResponse({ user: { userName: "alice" }, org: null })
      if (url.includes("credits")) return jsonResponse({ credits: { monthlyCredits: 5 } })
      if (url.includes("subscriptions")) return jsonResponse({ data: { planId: "pro" } })
      if (url.includes("summary")) return jsonResponse({ totalCost: 1, totalCount: 1 })
      throw new Error(`Unexpected URL: ${url}`)
    }
    const whoamiCalls = () => requests.filter((url) => url.includes("whoami")).length

    await fetchCommandCodeQuota({ apiKey: "cc_cache_key", fetchImpl: okFetchImpl, accountCache })
    await fetchCommandCodeQuota({ apiKey: "cc_cache_key", fetchImpl: okFetchImpl, accountCache })
    assert.equal(whoamiCalls(), 1)

    // A different key never reuses another account's identity.
    await fetchCommandCodeQuota({ apiKey: "cc_other_key", fetchImpl: okFetchImpl, accountCache })
    assert.equal(whoamiCalls(), 2)

    // A blocked request drops the cached identity so the next fetch re-resolves it.
    const blockedFetch = async (input: RequestInfo | URL): Promise<Response> =>
      String(input).includes("credits") ? jsonResponse({ error: "nope" }, 403) : okFetchImpl(input)
    const blocked = await fetchCommandCodeQuota({
      apiKey: "cc_cache_key",
      fetchImpl: blockedFetch,
      accountCache,
    })
    assert.equal(blocked.ok, false)
    assert.equal(stored.has("cc_cache_key"), false)

    await fetchCommandCodeQuota({ apiKey: "cc_cache_key", fetchImpl: okFetchImpl, accountCache })
    assert.equal(whoamiCalls(), 3)
  })

  it("stores the account on disk keyed by a hash of the API key", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-quota-cache-"))
    try {
      const path = join(dir, "commandcode-account.json")
      const cache = createDiskQuotaAccountCache(path)
      const account = { login: "alice-inc", orgId: "org_1", keyName: "Pi Agent" }

      assert.equal(cache.get("cc_secret_key"), undefined)
      cache.set("cc_secret_key", account)
      assert.deepEqual(cache.get("cc_secret_key"), account)
      assert.equal(cache.get("cc_other_key"), undefined)
      // The credential itself never lands in the cache file.
      assert.doesNotMatch(readFileSync(path, "utf8"), /cc_secret_key/)

      cache.delete("cc_secret_key")
      assert.equal(cache.get("cc_secret_key"), undefined)
      assert.doesNotMatch(readFileSync(path, "utf8"), /alice-inc/)
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("ignores a corrupt account cache instead of failing", () => {
    const dir = mkdtempSync(join(tmpdir(), "cc-quota-cache-"))
    try {
      const path = join(dir, "commandcode-account.json")
      writeFileSync(path, "{ not json", "utf8")
      const cache = createDiskQuotaAccountCache(path)
      assert.equal(cache.get("cc_key"), undefined)
      cache.set("cc_key", { login: "alice", orgId: null })
      assert.deepEqual(cache.get("cc_key"), { login: "alice", orgId: null })
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  it("rejects unrecognized successful endpoint schemas instead of displaying zero usage", async () => {
    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input)
      if (url.includes("whoami")) return jsonResponse({ user: { userName: "alice" }, org: null })
      return jsonResponse({ changed: "schema" })
    }

    const result = await fetchCommandCodeQuota({ apiKey: "cc_test_key", fetchImpl })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.error.kind, "http")
    assert.match(result.error.message, /no recognized usage data/i)
  })

  it("degrades gracefully when individual billing endpoints fail", async () => {
    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input)
      if (url.includes("whoami")) return jsonResponse({ user: { userName: "alice" }, org: null })
      if (url.includes("summary")) return jsonResponse({ totalCost: 3.0, totalCount: 10 })
      if (url.includes("credits") || url.includes("subscriptions")) {
        return jsonResponse({ error: "boom" }, 500)
      }
      throw new Error(`Unexpected URL: ${url}`)
    }

    const result = await fetchCommandCodeQuota({ apiKey: "cc_test_key", fetchImpl })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.quota.credits, null)
    assert.equal(result.quota.summary?.totalCost, 3.0)
    assert.deepEqual(result.quota.unavailable, ["credits", "subscription"])
    assert.match(formatQuota(result.quota), /Unavailable: credits, subscription/)
    // Optional aggregate tokens are parsed when the summary reports them.
    assert.equal(result.quota.summary?.totalTokens, undefined)
  })

  it("degrades on thrown network failures from optional endpoints, not just HTTP 5xx", async () => {
    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input)
      if (url.includes("whoami")) return jsonResponse({ user: { userName: "alice" }, org: null })
      if (url.includes("summary")) return jsonResponse({ totalCost: 3.0, totalCount: 10 })
      if (url.includes("credits")) throw new Error("network down")
      if (url.includes("subscriptions")) return jsonResponse({ data: { planId: "pro" } })
      throw new Error(`Unexpected URL: ${url}`)
    }

    const result = await fetchCommandCodeQuota({ apiKey: "cc_test_key", fetchImpl })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.quota.credits, null)
    assert.equal(result.quota.subscription?.planId, "pro")
    assert.equal(result.quota.summary?.totalCost, 3.0)
    assert.deepEqual(result.quota.unavailable, ["credits"])
  })

  it("fails the command when the summary endpoint rejects auth/permission", async () => {
    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input)
      if (url.includes("whoami")) return jsonResponse({ user: { userName: "alice" }, org: null })
      if (url.includes("credits")) return jsonResponse({ credits: { monthlyCredits: 5 } })
      if (url.includes("subscriptions")) return jsonResponse({ data: { planId: "pro" } })
      if (url.includes("summary")) return jsonResponse({ error: "nope" }, 403)
      throw new Error(`Unexpected URL: ${url}`)
    }
    const result = await fetchCommandCodeQuota({ apiKey: "cc_test_key", fetchImpl })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.error.kind, "http")
    assert.match(result.error.message, /summary/)
  })

  it("does not treat 429 on billing endpoints as fatal", async () => {
    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      const url = String(input)
      if (url.includes("whoami")) return jsonResponse({ user: { userName: "alice" }, org: null })
      if (url.includes("summary")) return jsonResponse({ totalCost: 3.0, totalCount: 10 })
      if (url.includes("credits") || url.includes("subscriptions")) {
        return jsonResponse({ error: "rate limited" }, 429)
      }
      throw new Error(`Unexpected URL: ${url}`)
    }
    const result = await fetchCommandCodeQuota({ apiKey: "cc_test_key", fetchImpl })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.quota.credits, null)
    assert.equal(result.quota.summary?.totalCost, 3.0)
  })

  it("sends extra headers (ZDR) on quota requests", async () => {
    let sent: Headers | undefined
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      sent = (init?.headers as Headers) ?? undefined
      const url = String(input)
      if (url.includes("whoami")) return jsonResponse({ user: { userName: "alice" }, org: null })
      if (url.includes("credits")) return jsonResponse({ credits: { monthlyCredits: 5 } })
      if (url.includes("subscriptions")) return jsonResponse({ data: { planId: "pro" } })
      if (url.includes("summary")) return jsonResponse({ totalCost: 1, totalCount: 1 })
      throw new Error(`Unexpected URL: ${url}`)
    }
    const result = await fetchCommandCodeQuota({
      apiKey: "cc_test_key",
      fetchImpl,
      extraHeaders: { "x-cmd-zdr": "1" },
    })
    assert.equal(result.ok, true)
    const headers = new Headers(sent)
    assert.equal(headers.get("x-cmd-zdr"), "1")
  })

  it("parses optional token count and key name when present", async () => {
    const { fetchImpl } = okFetch({
      whoami: { user: { userName: "alice", keyName: "Pi Agent" }, org: null },
      credits: { credits: { monthlyCredits: 5, purchasedCredits: 0, freeCredits: 0 } },
      subscriptions: {
        data: {
          planId: "pro",
          status: "active",
          currentPeriodEnd: Date.parse("2026-02-01T00:00:00Z"),
        },
      },
      summary: { totalCost: 1.06, totalCount: 654, totalTokens: 74_200_000 },
    })
    const result = await fetchCommandCodeQuota({ apiKey: "cc_test_key", fetchImpl })
    assert.equal(result.ok, true)
    if (!result.ok) return
    assert.equal(result.quota.summary?.totalTokens, 74_200_000)
    assert.equal(result.quota.account.keyName, "Pi Agent")
    assert.equal(result.quota.subscription?.currentPeriodEnd, "1769904000000")
  })

  it("rejects missing API keys as a config error", async () => {
    const result = await fetchCommandCodeQuota({ apiKey: "" })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.error.kind, "config")
  })

  it("fails with a config-style error when the API key is rejected", async () => {
    const fetchImpl = async (input: RequestInfo | URL): Promise<Response> => {
      if (String(input).includes("whoami")) return jsonResponse({ error: "unauthorized" }, 401)
      throw new Error(`Unexpected URL: ${input}`)
    }
    const result = await fetchCommandCodeQuota({ apiKey: "cc_bad_key", fetchImpl })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.error.kind, "http")
    assert.match(result.error.message, /401/)
  })

  it("formats a complete quota snapshot into readable output", () => {
    const quota: CommandCodeQuota = {
      account: { login: "alice-inc", orgId: "org_1" },
      credits: {
        monthlyCredits: 40,
        purchasedCredits: 10,
        freeCredits: 5,
        remainingCredits: 55,
        windowLimits: [
          { window: "fiveHour", used: 8, cap: 16, resetAt: null },
          { window: "weekly", used: 20, cap: 40, resetAt: null },
        ],
      } satisfies CommandCodeCredits,
      subscription: {
        planId: "pro",
        status: "active",
        currentPeriodStart: "2026-01-01T00:00:00Z",
        currentPeriodEnd: "2026-02-01T00:00:00Z",
      },
      summary: { totalCost: 12.34, totalCount: 1500 },
    }

    const output = formatQuota(quota, () => Date.parse("2026-01-15T00:00:00Z"))
    assert.doesNotMatch(output, /Command Code quota —/)
    assert.doesNotMatch(output, /^Plan:/m)
    assert.match(output, /^Usage windows \(remaining\)/)
    assert.match(output, /30d \[[█░]+\] +82% \(resets in 17 days\) \$55\.00\/\$67\.34/)
    assert.match(output, /5h +\[[█░]+\] +50%/)
    assert.match(output, /7d +\[[█░]+\] +50%/)
    // The billing-period usage totals are intentionally not part of the report.
    assert.doesNotMatch(output, /Credits/)
    assert.doesNotMatch(output, /billing period/)
    assert.doesNotMatch(output, /Requests:/)
    assert.doesNotMatch(output, /Account/)
    assert.doesNotMatch(output, /alice-inc/)
    assert.doesNotMatch(output, /Sources:/)
    assert.doesNotMatch(output, /Full detail/)
    assert.doesNotMatch(output, /commandcode\.ai\/usage/)
  })

  it("renders the 30d reset from the subscription period end", () => {
    const formatReset = (currentPeriodEnd: string | null, now: string) =>
      formatQuota(
        {
          account: { login: "alice", orgId: null },
          credits: {
            monthlyCredits: 10,
            purchasedCredits: 0,
            freeCredits: 0,
            remainingCredits: 10,
            windowLimits: [],
          },
          subscription: {
            planId: "pro",
            status: "active",
            currentPeriodStart: null,
            currentPeriodEnd,
          },
          summary: { totalCost: 5, totalCount: 1 },
        },
        () => Date.parse(now),
      )

    const soon = formatReset("2026-02-01T00:00:00Z", "2026-01-31T12:00:00Z")
    assert.match(soon, /30d \[[█░]+\] +67% \(resets in 12h\) \$10\.00\/\$15\.00/)

    // Epoch-millisecond timestamps are accepted the same as ISO strings.
    const numeric = formatReset(String(Date.parse("2026-02-01T00:00:00Z")), "2026-01-31T12:00:00Z")
    assert.match(numeric, /\(resets in 12h\)/)

    // A period end already in the past renders as "soon".
    const past = formatReset("2026-01-30T00:00:00Z", "2026-01-31T12:00:00Z")
    assert.match(past, /\(resets soon\)/)

    for (const currentPeriodEnd of [null, "not-a-date"]) {
      assert.doesNotMatch(formatReset(currentPeriodEnd, "2026-01-31T12:00:00Z"), /resets/)
    }
  })

  it("redacts token-like values from error messages", () => {
    // 16+ char run after a credential key is redacted by the shared redactor.
    assert.equal(redactValue("api_key=abcdefghijklmnop123456"), "api_key=[redacted]")
    assert.equal(redactValue("Bearer user_12345678901234 failed"), "Bearer [redacted] failed")
  })

  it("redacts named credential fields and short tokens from error bodies", () => {
    // Credential key-value forms (with = or : separator) are redacted.
    assert.equal(redactValue("api_key=abc123"), "api_key=[redacted]")
    assert.equal(
      redactValue("authorization=Basic abc:def failed"),
      "authorization=[redacted] abc:def failed",
    )
    assert.equal(redactValue("user_123456789 failed"), "[redacted] failed")
    assert.equal(redactValue("cc_abcdefghijkl failed"), "[redacted] failed")
    assert.equal(
      redactValue("token=eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.secret"),
      "token=[redacted]",
    )
  })

  it("redacts JSON-quoted credential fields in error bodies", () => {
    assert.equal(
      redactValue('{"apiKey":"sk-abcdefghijklmnop123456","ok":true}'),
      '{"apiKey":"[redacted]","ok":true}',
    )
    assert.equal(
      redactValue('{"error":"bad","access_token":"opaque-internal-token-12345"}'),
      '{"error":"bad","access_token":"[redacted]"}',
    )
    assert.equal(
      redactValue('{"authorization":"Bearer user_1234"}'),
      '{"authorization":"[redacted]"}',
    )
  })

  it("redacts thrown network errors from the outer catch path", async () => {
    const fetchImpl = async (_input: RequestInfo | URL): Promise<Response> => {
      throw new Error("connection reset by proxy api_key=supersecretvalue123456")
    }
    const result = await fetchCommandCodeQuota({ apiKey: "cc_test_key", fetchImpl })
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.doesNotMatch(result.error.message, /supersecretvalue123456/)
    assert.match(result.error.kind, /network/)
  })

  it("honors the overall deadline once it has already fired (no phase starts after abort)", async () => {
    const start = Date.now()
    const fetchImpl = async (input: RequestInfo | URL, init?: RequestInit): Promise<Response> => {
      const url = String(input)
      if (url.includes("whoami")) {
        // Never resolve; let the per-request controller abort it at timeoutMs.
        return new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () =>
            reject(Object.assign(new Error("aborted"), { name: "AbortError" })),
          )
        })
      }
      throw new Error(`Unexpected URL: ${url}`)
    }

    const result = await fetchCommandCodeQuota({ apiKey: "cc_test_key", fetchImpl, timeoutMs: 30 })
    const elapsed = Date.now() - start
    assert.equal(result.ok, false)
    if (result.ok) return
    assert.equal(result.error.kind, "timeout")
    // The overall deadline governs the whole command; no phase may add ~30ms on top.
    assert.ok(elapsed < 200, `elapsed ${elapsed}ms exceeded overall deadline`)
  })
})
