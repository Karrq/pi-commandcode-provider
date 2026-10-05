/**
 * Unit tests for the usage widget's pure layer (src/usage-widget.ts).
 *
 * No host runtime and no network: config parsing, remaining-percent math, and
 * the single-line formatting are all pure.
 */

import assert from "node:assert/strict"
import { describe, it } from "node:test"

import type { CommandCodeQuota } from "../src/quota-types.ts"
import {
  DEFAULT_USAGE_SETTINGS,
  formatUsageWidget,
  parseUsageSettings,
  remainingPercent,
  type UsageColor,
  type UsageWidgetState,
} from "../src/usage-widget.ts"

/** Records the color tokens so tests can assert severity without ANSI parsing. */
function colorRecorder() {
  const tokens: string[] = []
  const color = (token: UsageColor, text: string): string => {
    tokens.push(token)
    return text
  }
  return { color, tokens }
}

const NOW = 1_700_000_000_000 // ms

function quotaWith(usedFiveHour: number, usedWeekly: number): CommandCodeQuota {
  return {
    account: { login: "alice", orgId: null },
    credits: {
      monthlyCredits: 0,
      purchasedCredits: 0,
      freeCredits: 0,
      remainingCredits: 0,
      windowLimits: [
        { window: "fiveHour", used: usedFiveHour, cap: 16, resetAt: 1_700_003_600 },
        { window: "weekly", used: usedWeekly, cap: 40, resetAt: null },
      ],
    },
    subscription: null,
    summary: null,
  }
}

describe("parseUsageSettings", () => {
  it("accepts a boolean widget flag", () => {
    assert.deepEqual(parseUsageSettings('{"widget":false}'), { widget: false })
  })

  it("falls back to the default for missing or malformed input", () => {
    assert.deepEqual(parseUsageSettings("{}"), DEFAULT_USAGE_SETTINGS)
    assert.deepEqual(parseUsageSettings("[]"), DEFAULT_USAGE_SETTINGS)
    assert.equal(parseUsageSettings("not json"), null)
  })
})

describe("remainingPercent", () => {
  it("computes the complement of usage", () => {
    assert.equal(remainingPercent({ window: "fiveHour", used: 4, cap: 16, resetAt: null }), 75)
    assert.equal(remainingPercent({ window: "weekly", used: 40, cap: 40, resetAt: null }), 0)
  })

  it("treats a zero cap as fully used instead of dividing by zero", () => {
    assert.equal(remainingPercent({ window: "fiveHour", used: 0, cap: 0, resetAt: null }), 0)
  })
})

describe("formatUsageWidget", () => {
  it("shows a loading line before the first snapshot", () => {
    const { color } = colorRecorder()
    assert.deepEqual(formatUsageWidget(undefined, NOW, color), ["Command Code usage loading…"])
  })

  it("shows the error inline", () => {
    const { color } = colorRecorder()
    const state: UsageWidgetState = { quota: null, error: "no API key" }
    assert.deepEqual(formatUsageWidget(state, NOW, color), ["Command Code usage: no API key"])
  })

  it("renders both windows with remaining percent and reset countdown", () => {
    const { color, tokens } = colorRecorder()
    const [line] = formatUsageWidget({ quota: quotaWith(8, 20) }, NOW, color)
    assert.ok(line)
    assert.match(line, /5h/)
    assert.match(line, /50%/)
    assert.match(line, /7d/)
    assert.match(line, /↻1h/)
    assert.ok(tokens.includes("success"))
  })

  it("escalates the color as the remaining budget shrinks", () => {
    const warning = colorRecorder()
    formatUsageWidget({ quota: quotaWith(12, 20) }, NOW, warning.color) // 25% and 50% left
    assert.ok(warning.tokens.includes("warning"))

    const error = colorRecorder()
    formatUsageWidget({ quota: quotaWith(15, 40) }, NOW, error.color) // 6% and 0% left
    assert.ok(error.tokens.includes("error"))
  })

  it("reports unavailable when the API sent no window limits", () => {
    const { color } = colorRecorder()
    const state: UsageWidgetState = {
      quota: { ...quotaWith(0, 0), credits: null },
    }
    assert.deepEqual(formatUsageWidget(state, NOW, color), ["Command Code usage unavailable"])
  })
})
