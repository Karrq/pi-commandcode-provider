/**
 * Command Code web search tool.
 *
 * Registers `web_search` for any model pi runs, not only Command Code models.
 * The tool calls Command Code's search route with the credentials stored by
 * `/login`, so it works with any active provider as long as a Command Code
 * account is logged in. The route caps a call at ten results and takes either
 * an allow list or a block list; `src/web-search.ts` repairs both inputs and
 * surfaces what it chose.
 *
 * Load or disable this independently of the provider: it is a separate entry
 * in the package's `pi.extensions` list.
 */

import { Type } from "@earendil-works/pi-ai"
import { defineTool, type ExtensionAPI } from "@earendil-works/pi-coding-agent"

import { getConfiguredApiKey } from "./src/api-key.ts"
import { pickCommandCodeApiKey } from "./src/converters.ts"
import { commandCodeAlphaBase, commandCodeEnvHeaders } from "./src/quota-env.ts"
import { searchCommandCodeWeb } from "./src/web-search.ts"

const CURRENT_YEAR = new Date().getFullYear()

const DESCRIPTION = [
  "Search the web for current information and return ranked results with titles, URLs, and snippets.",
  "Use it for current events, documentation lookup, or anything that may have changed since your knowledge cutoff.",
  "",
  "Each result is a search-engine-style snippet. If you need a page's full contents, fetch its URL with a page-fetch tool afterwards.",
  "",
  "Usage notes:",
  "- `allowed_domains` restricts results to specific sites (subdomains match); `blocked_domains` excludes sites. Passing both is allowed: results are restricted to the allowed sites, then the blocked sites are removed.",
  "- `numResults` may exceed 10. The service ranks at most 10 per call, so larger requests are merged across calls and duplicates are dropped.",
  "- Keep queries specific. Prefer several focused searches over one broad one.",
  `- The current year is ${CURRENT_YEAR}. Include it in queries for recent information or current events.`,
  "",
  'Cite the results you use: end your response with a "Sources:" section of [Title](URL) markdown links.',
].join("\n")

const webSearchTool = defineTool({
  name: "web_search",
  label: "Web Search",
  description: DESCRIPTION,
  promptSnippet: "Search the web for current information",
  promptGuidelines: [
    "Use web_search when the answer depends on current information or a source outside the workspace.",
  ],
  annotations: { readOnlyHint: true, openWorldHint: true },
  parameters: Type.Object({
    query: Type.String({ description: "The search query (at least 2 characters)." }),
    numResults: Type.Optional(
      Type.Number({
        description:
          "How many results to aim for. Values above 10 are merged across calls. Defaults to 5.",
      }),
    ),
    allowed_domains: Type.Optional(
      Type.Array(Type.String(), {
        description:
          'Only include results from these domains. Subdomains match, e.g. "example.com" also matches "docs.example.com". May be combined with blocked_domains.',
      }),
    ),
    blocked_domains: Type.Optional(
      Type.Array(Type.String(), {
        description:
          "Never include results from these domains. May be combined with allowed_domains.",
      }),
    ),
  }),

  async execute(_toolCallId, params, signal, _onUpdate, ctx) {
    const registryKey = await ctx.modelRegistry.getApiKeyForProvider("commandcode")
    const apiKey = pickCommandCodeApiKey(registryKey, getConfiguredApiKey())

    const outcome = await searchCommandCodeWeb(
      {
        query: params.query,
        numResults: params.numResults,
        allowedDomains: params.allowed_domains,
        blockedDomains: params.blocked_domains,
      },
      {
        apiKey,
        baseUrl: commandCodeAlphaBase(),
        headers: commandCodeEnvHeaders(),
        signal,
      },
    )

    if (!outcome.ok) {
      return {
        content: [{ type: "text" as const, text: outcome.message }],
        details: undefined,
        isError: true,
      }
    }

    return {
      content: [{ type: "text" as const, text: outcome.text }],
      details: outcome.plan,
    }
  },
})

export default function commandCodeWebSearch(pi: ExtensionAPI) {
  pi.registerTool(webSearchTool)
}
