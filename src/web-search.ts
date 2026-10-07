/**
 * Command Code web search.
 *
 * `web_search` posts a query to Command Code's search route and returns ranked
 * title/url/snippet results. The route caps a single call at ten results and
 * takes either an allow list or a block list, not both. Two inputs are repaired
 * instead of rejected:
 *
 *  - `numResults` above ten is split across calls and merged by URL.
 *  - `allowed_domains` and `blocked_domains` together keep the intersection:
 *    the allowed set is applied upstream, the blocked set is removed locally.
 *
 * Both repairs are surfaced as `Note:` lines in the result, following the
 * harness repair style: repair where possible, extend semantics where not, and
 * tell the model what was chosen.
 */

import { COMMAND_CODE_CLI_VERSION } from "./core.ts"

/** Search route on the Command Code host, next to `/alpha/whoami` and the quota endpoints. */
export const WEB_SEARCH_PATH = "/alpha/web-search"
/** The service ranks at most this many results per call. */
export const MAX_RESULTS_PER_CALL = 10
export const DEFAULT_RESULTS = 5
export const MIN_QUERY_CHARS = 2
/** Upper bound on the calls a single tool invocation may fan out into. */
export const MAX_CALLS = 3
export const WEB_SEARCH_TIMEOUT_MS = 60_000

export interface WebSearchResult {
  title: string
  url: string
  snippet: string
}

export interface WebSearchPlan {
  /** Requested result count after normalization. */
  target: number
  /** Results requested per call, at most {@link MAX_RESULTS_PER_CALL}. */
  perCall: number
  /** Calls this request may use. */
  calls: number
  /** Domains applied by the service. */
  serverAllowed: string[]
  serverBlocked: string[]
  /** Domains applied locally after the response. */
  allowed: string[]
  blocked: string[]
  /** Human-readable repair notes for the model. */
  notes: string[]
}

export interface WebSearchInput {
  numResults?: unknown
  allowedDomains?: unknown
  blockedDomains?: unknown
}

export interface WebSearchDependencies {
  apiKey: string | undefined
  baseUrl: string
  fetchImpl?: typeof fetch
  headers?: Record<string, string>
  signal?: AbortSignal
  timeoutMs?: number
}

export type WebSearchOutcome =
  | { ok: true; results: WebSearchResult[]; text: string; plan: WebSearchPlan }
  | { ok: false; message: string }

function normalizeNumResults(value: unknown): number {
  if (typeof value !== "number" || !Number.isFinite(value)) return DEFAULT_RESULTS
  const rounded = Math.round(value)
  return rounded < 1 ? DEFAULT_RESULTS : rounded
}

function normalizeDomain(value: string): string {
  let domain = value.trim().toLowerCase()
  const scheme = domain.match(/^[a-z][a-z0-9+.-]*:\/\//)
  if (scheme) domain = domain.slice(scheme[0].length)
  domain = domain.replace(/[/?#].*$/, "").replace(/\.$/, "")
  return domain
}

/** Trim, lowercase, strip scheme/path, and dedupe a domain list. */
export function normalizeDomainList(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const domains = new Set<string>()
  for (const item of value) {
    if (typeof item !== "string") continue
    const domain = normalizeDomain(item)
    if (domain.length > 0) domains.add(domain)
  }
  return [...domains]
}

/**
 * Decide how many calls to make and which filters travel upstream.
 *
 * A request for more than ten results is fanned out until the target or
 * {@link MAX_CALLS} is reached. When both domain filters are present, only the
 * allow list is sent, and the block list is applied to the response.
 */
export function planWebSearch(input: WebSearchInput): WebSearchPlan {
  const target = normalizeNumResults(input.numResults)
  const perCall = Math.min(MAX_RESULTS_PER_CALL, target)
  const calls = Math.max(1, Math.min(Math.ceil(target / MAX_RESULTS_PER_CALL), MAX_CALLS))

  const allowed = normalizeDomainList(input.allowedDomains)
  const blocked = normalizeDomainList(input.blockedDomains)
  const bothFilters = allowed.length > 0 && blocked.length > 0

  const notes: string[] = []
  if (target > MAX_RESULTS_PER_CALL) {
    const reachable = Math.min(target, perCall * calls)
    notes.push(
      `numResults ${target} exceeds the ${MAX_RESULTS_PER_CALL}-result maximum per call, so results were merged from ${calls} call${calls === 1 ? "" : "s"} (up to ${reachable}).`,
    )
  }
  if (bothFilters) {
    notes.push(
      "allowed_domains and blocked_domains were both set; results were restricted to allowed_domains and then blocked_domains were removed.",
    )
  }

  return {
    target,
    perCall,
    calls,
    serverAllowed: allowed,
    serverBlocked: bothFilters ? [] : blocked,
    allowed,
    blocked,
    notes,
  }
}

function hostnameMatchesDomain(hostname: string, domain: string): boolean {
  const host = hostname.toLowerCase().replace(/^www\./, "")
  return host === domain || host.endsWith(`.${domain}`)
}

/** Whether a result URL matches any domain, subdomain-aware. */
export function urlMatchesAnyDomain(url: string, domains: readonly string[]): boolean {
  let hostname: string
  try {
    hostname = new URL(url).hostname
  } catch {
    return false
  }
  return domains.some((domain) => hostnameMatchesDomain(hostname, domain))
}

function matchesPlanFilters(url: string, plan: WebSearchPlan): boolean {
  if (plan.allowed.length > 0 && !urlMatchesAnyDomain(url, plan.allowed)) return false
  if (plan.blocked.length > 0 && urlMatchesAnyDomain(url, plan.blocked)) return false
  return true
}

/** Merge result runs, dedupe by URL, apply domain filters, and cap at the target. */
export function mergeWebSearchResults(
  runs: readonly (readonly WebSearchResult[])[],
  plan: WebSearchPlan,
): WebSearchResult[] {
  const seen = new Set<string>()
  const merged: WebSearchResult[] = []
  for (const run of runs) {
    for (const result of run) {
      if (!result.url || seen.has(result.url)) continue
      if (!matchesPlanFilters(result.url, plan)) continue
      seen.add(result.url)
      merged.push(result)
      if (merged.length >= plan.target) return merged
    }
  }
  return merged
}

export function formatWebSearchResults(query: string, results: readonly WebSearchResult[]): string {
  const lines = results.map(
    (result, index) => `${index + 1}. **${result.title}**\n   ${result.url}\n   ${result.snippet}`,
  )
  return [
    `Search results for: ${query}`,
    "",
    lines.join("\n\n"),
    "",
    'Cite the results you use: end your response with a "Sources:" section of [Title](URL) markdown links.',
  ].join("\n")
}

export function noResultsMessage(query: string, filtered: boolean): string {
  const advice = filtered
    ? "Try loosening or removing the domain filters, or broadening the query."
    : "Try a broader or differently-worded query."
  return `No results found for: ${query}\n\n${advice}`
}

function requestSignal(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
  const timeout = AbortSignal.timeout(timeoutMs)
  return signal ? AbortSignal.any([signal, timeout]) : timeout
}

function readHttpError(status: number, body: string): string {
  let detail = body.trim()
  try {
    const parsed: unknown = JSON.parse(detail)
    if (parsed && typeof parsed === "object" && "error" in parsed) {
      const error = (parsed as { error?: unknown }).error
      if (
        error &&
        typeof error === "object" &&
        typeof (error as { message?: unknown }).message === "string"
      ) {
        detail = (error as { message: string }).message
      }
    }
  } catch {
    // Non-JSON body; keep the raw text.
  }

  if (status === 401 || status === 403) {
    return "Command Code rejected the search request. Re-run /login for Command Code."
  }
  if (status === 429) {
    return "Command Code rate-limited the search request. Try again shortly."
  }
  if (status === 502 || status === 504) {
    return `${status} upstream error while searching the web.`
  }
  return detail.length > 0
    ? `${status} error while searching: ${detail}`
    : `${status} error while searching.`
}

interface SearchRun {
  results: WebSearchResult[]
  formatted?: string
}

async function runWebSearch(
  body: Record<string, unknown>,
  deps: WebSearchDependencies,
): Promise<{ ok: true; run: SearchRun } | { ok: false; message: string }> {
  const fetchImpl = deps.fetchImpl ?? fetch
  const headers = {
    "content-type": "application/json",
    accept: "application/json",
    authorization: `Bearer ${deps.apiKey}`,
    "user-agent": "cli",
    "x-command-code-version": COMMAND_CODE_CLI_VERSION,
    "x-cli-environment": "production",
    ...deps.headers,
  }

  let response: Response
  try {
    response = await fetchImpl(`${deps.baseUrl}${WEB_SEARCH_PATH}`, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
      signal: requestSignal(deps.signal, deps.timeoutMs ?? WEB_SEARCH_TIMEOUT_MS),
    })
  } catch (error) {
    if (error instanceof Error && error.name === "AbortError" && deps.signal?.aborted) throw error
    const message = error instanceof Error ? error.message : String(error)
    return { ok: false, message: `Error searching the web: ${message}` }
  }

  if (!response.ok) {
    const bodyText = await response.text().catch(() => "")
    return { ok: false, message: readHttpError(response.status, bodyText) }
  }

  const payload: unknown = await response.json().catch(() => undefined)
  const record = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {}
  const results = Array.isArray(record.results) ? record.results.filter(isWebSearchResult) : []
  const formatted = typeof record.formatted === "string" ? record.formatted : undefined
  return { ok: true, run: { results, formatted } }
}

function isWebSearchResult(value: unknown): value is WebSearchResult {
  if (!value || typeof value !== "object") return false
  const record = value as Record<string, unknown>
  return typeof record.url === "string"
}

/**
 * Search the web through Command Code's search route, applying the limit and
 * domain-filter repairs described at the top of this module.
 */
export async function searchCommandCodeWeb(
  input: { query: unknown } & WebSearchInput,
  deps: WebSearchDependencies,
): Promise<WebSearchOutcome> {
  const query = typeof input.query === "string" ? input.query.trim() : ""
  if (query.length < MIN_QUERY_CHARS) {
    return {
      ok: false,
      message: `web_search needs a query of at least ${MIN_QUERY_CHARS} characters.`,
    }
  }
  if (!deps.apiKey) {
    return {
      ok: false,
      message:
        "web_search needs a logged-in Command Code account. Run /login and choose Command Code, or set COMMAND_CODE_API_KEY.",
    }
  }

  const plan = planWebSearch(input)
  const collected: WebSearchResult[] = []
  const seen = new Set<string>()
  let formatted: string | undefined

  for (let call = 0; call < plan.calls; call += 1) {
    const body: Record<string, unknown> = { query, numResults: plan.perCall }
    if (plan.serverAllowed.length > 0) body.allowedDomains = plan.serverAllowed
    if (plan.serverBlocked.length > 0) body.blockedDomains = plan.serverBlocked

    const outcome = await runWebSearch(body, deps)
    if (!outcome.ok) return outcome
    formatted ??= outcome.run.formatted

    for (const result of outcome.run.results) {
      if (seen.has(result.url)) continue
      if (!matchesPlanFilters(result.url, plan)) continue
      seen.add(result.url)
      collected.push(result)
      if (collected.length >= plan.target) break
    }
    if (collected.length >= plan.target) break
  }

  const notes = plan.notes.map((note) => `Note: ${note}`)
  if (collected.length === 0) {
    const text =
      formatted ?? noResultsMessage(query, plan.allowed.length > 0 || plan.blocked.length > 0)
    return { ok: true, results: [], text: [...notes, text].join("\n\n"), plan }
  }

  return {
    ok: true,
    results: collected,
    text: [...notes, formatWebSearchResults(query, collected)].join("\n\n"),
    plan,
  }
}
