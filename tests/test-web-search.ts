/**
 * Unit tests for the Command Code web search tool helpers.
 * Hermetic: mocked fetch, no network, no pi runtime.
 */

import assert from "node:assert/strict"
import { describe, it } from "node:test"

import {
  DEFAULT_RESULTS,
  MAX_CALLS,
  MAX_RESULTS_PER_CALL,
  MIN_QUERY_CHARS,
  WEB_SEARCH_PATH,
  formatWebSearchResults,
  mergeWebSearchResults,
  noResultsMessage,
  normalizeDomainList,
  planWebSearch,
  searchCommandCodeWeb,
  urlMatchesAnyDomain,
  type WebSearchDependencies,
  type WebSearchResult,
} from "../src/web-search.ts"

function result(url: string, title = url, snippet = "snippet"): WebSearchResult {
  return { title, url, snippet }
}

interface RecordedCall {
  url: string
  body: Record<string, unknown>
}

function fakeFetch(
  responses: (body: Record<string, unknown>, callIndex: number) => unknown,
  calls: RecordedCall[],
): typeof fetch {
  return (async (input: string | URL | Request, init?: RequestInit) => {
    const body = JSON.parse(String(init?.body ?? "{}")) as Record<string, unknown>
    calls.push({ url: String(input), body })
    const payload = responses(body, calls.length - 1)
    const status = (payload as { __status?: number }).__status ?? 200
    const value = { ...(payload as object) }
    delete (value as { __status?: number }).__status
    return new Response(JSON.stringify(value), {
      status,
      headers: { "content-type": "application/json" },
    })
  }) as typeof fetch
}

const baseDeps: WebSearchDependencies = {
  apiKey: "test-key",
  baseUrl: "https://api.example",
}

describe("planWebSearch()", () => {
  it("defaults to a single call for a small request", () => {
    const plan = planWebSearch({})
    assert.equal(plan.target, DEFAULT_RESULTS)
    assert.equal(plan.perCall, DEFAULT_RESULTS)
    assert.equal(plan.calls, 1)
    assert.deepEqual(plan.notes, [])
  })

  it("splits a request above the per-call maximum and notes it", () => {
    const plan = planWebSearch({ numResults: 20 })
    assert.equal(plan.target, 20)
    assert.equal(plan.perCall, MAX_RESULTS_PER_CALL)
    assert.equal(plan.calls, 2)
    assert.equal(plan.notes.length, 1)
    assert.match(plan.notes[0], /merged from 2 calls/)
  })

  it("caps the fan-out at MAX_CALLS", () => {
    const plan = planWebSearch({ numResults: 500 })
    assert.equal(plan.calls, MAX_CALLS)
    assert.match(plan.notes[0], new RegExp(`merged from ${MAX_CALLS} calls`))
  })

  it("repairs non-positive and non-numeric result counts to the default", () => {
    assert.equal(planWebSearch({ numResults: 0 }).target, DEFAULT_RESULTS)
    assert.equal(planWebSearch({ numResults: -3 }).target, DEFAULT_RESULTS)
    assert.equal(planWebSearch({ numResults: "20" }).target, DEFAULT_RESULTS)
  })

  it("sends only the allow list when both filters are present", () => {
    const plan = planWebSearch({
      allowedDomains: ["docs.example.com"],
      blockedDomains: ["ads.example.com"],
    })
    assert.deepEqual(plan.serverAllowed, ["docs.example.com"])
    assert.deepEqual(plan.serverBlocked, [])
    assert.deepEqual(plan.allowed, ["docs.example.com"])
    assert.deepEqual(plan.blocked, ["ads.example.com"])
    assert.equal(plan.notes.length, 1)
    assert.match(plan.notes[0], /both set/)
  })

  it("sends the block list when it is the only filter", () => {
    const plan = planWebSearch({ blockedDomains: ["ads.example.com"] })
    assert.deepEqual(plan.serverAllowed, [])
    assert.deepEqual(plan.serverBlocked, ["ads.example.com"])
    assert.deepEqual(plan.notes, [])
  })
})

describe("normalizeDomainList()", () => {
  it("strips scheme and path, lowercases, and dedupes", () => {
    assert.deepEqual(
      normalizeDomainList([
        " HTTPS://Docs.Example.com/path ",
        "docs.example.com",
        "example.com/",
        "",
        42,
      ]),
      ["docs.example.com", "example.com"],
    )
  })

  it("returns an empty list for non-arrays", () => {
    assert.deepEqual(normalizeDomainList(undefined), [])
    assert.deepEqual(normalizeDomainList("example.com"), [])
  })
})

describe("urlMatchesAnyDomain()", () => {
  it("matches exact hosts, www variants, and subdomains", () => {
    assert.equal(urlMatchesAnyDomain("https://example.com/a", ["example.com"]), true)
    assert.equal(urlMatchesAnyDomain("https://www.example.com/a", ["example.com"]), true)
    assert.equal(urlMatchesAnyDomain("https://docs.example.com/a", ["example.com"]), true)
    assert.equal(urlMatchesAnyDomain("https://notexample.com/a", ["example.com"]), false)
    assert.equal(urlMatchesAnyDomain("not a url", ["example.com"]), false)
  })
})

describe("mergeWebSearchResults()", () => {
  it("dedupes by URL, applies filters, and caps at the target", () => {
    const plan = planWebSearch({ numResults: 3, blockedDomains: ["blocked.com"] })
    const merged = mergeWebSearchResults(
      [
        [result("https://a.com/1"), result("https://blocked.com/x"), result("https://b.com/2")],
        [result("https://a.com/1"), result("https://c.com/3"), result("https://d.com/4")],
      ],
      plan,
    )
    assert.deepEqual(
      merged.map((item) => item.url),
      ["https://a.com/1", "https://b.com/2", "https://c.com/3"],
    )
  })
})

describe("formatWebSearchResults()", () => {
  it("numbers results and asks for sources", () => {
    const text = formatWebSearchResults("rust", [result("https://a.com", "A")])
    assert.match(text, /Search results for: rust/)
    assert.match(text, /1\. \*\*A\*\*/)
    assert.match(text, /Sources:/)
  })
})

describe("searchCommandCodeWeb()", () => {
  it("requires a Command Code credential", async () => {
    const outcome = await searchCommandCodeWeb(
      { query: "hello world" },
      { ...baseDeps, apiKey: undefined },
    )
    assert.equal(outcome.ok, false)
    assert.match((outcome as { message: string }).message, /logged-in Command Code account/)
  })

  it("rejects a query below the minimum length", async () => {
    const outcome = await searchCommandCodeWeb({ query: "a" }, baseDeps)
    assert.equal(outcome.ok, false)
    assert.match((outcome as { message: string }).message, new RegExp(String(MIN_QUERY_CHARS)))
  })

  it("splits a large request and merges the calls", async () => {
    const calls: RecordedCall[] = []
    const fetchImpl = fakeFetch((_body, index) => {
      const run = index === 0 ? 1 : 2
      return {
        results: Array.from({ length: MAX_RESULTS_PER_CALL }, (_, i) =>
          result(`https://site${run}.com/${i}`, `Run ${run} ${i}`),
        ),
      }
    }, calls)

    const outcome = await searchCommandCodeWeb(
      { query: "twenty results", numResults: 20 },
      { ...baseDeps, fetchImpl },
    )

    assert.equal(outcome.ok, true)
    assert.equal(calls.length, 2)
    assert.equal(calls[0].url, `https://api.example${WEB_SEARCH_PATH}`)
    assert.equal(calls[0].body.numResults, MAX_RESULTS_PER_CALL)
    assert.equal((outcome as { results: unknown[] }).results.length, 20)
    assert.match((outcome as { text: string }).text, /^Note: numResults 20/)
  })

  it("sends only the allow list and removes blocked domains locally", async () => {
    const calls: RecordedCall[] = []
    const fetchImpl = fakeFetch(
      () => ({
        results: [result("https://docs.example.com/ok"), result("https://ads.example.com/nope")],
      }),
      calls,
    )

    const outcome = await searchCommandCodeWeb(
      {
        query: "both filters",
        allowedDomains: ["example.com"],
        blockedDomains: ["ads.example.com"],
      },
      { ...baseDeps, fetchImpl },
    )

    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0].body.allowedDomains, ["example.com"])
    assert.equal("blockedDomains" in calls[0].body, false)
    assert.equal(outcome.ok, true)
    assert.deepEqual(
      (outcome as { results: WebSearchResult[] }).results.map((item) => item.url),
      ["https://docs.example.com/ok"],
    )
    assert.match((outcome as { text: string }).text, /^Note: allowed_domains and blocked_domains/)
  })

  it("returns a readable message for an HTTP error", async () => {
    const calls: RecordedCall[] = []
    const fetchImpl = fakeFetch(
      () => ({
        __status: 401,
        error: { message: "unauthorized" },
      }),
      calls,
    )
    const outcome = await searchCommandCodeWeb({ query: "error case" }, { ...baseDeps, fetchImpl })
    assert.equal(outcome.ok, false)
    assert.match((outcome as { message: string }).message, /rejected the search request/)
  })

  it("reports no results with filter advice", async () => {
    const calls: RecordedCall[] = []
    const fetchImpl = fakeFetch(() => ({ results: [] }), calls)
    const outcome = await searchCommandCodeWeb(
      { query: "nothing here", allowedDomains: ["example.com"] },
      { ...baseDeps, fetchImpl },
    )
    assert.equal(outcome.ok, true)
    assert.equal((outcome as { results: unknown[] }).results.length, 0)
    assert.equal((outcome as { text: string }).text, noResultsMessage("nothing here", true))
  })
})
