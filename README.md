# pi-commandcode-provider

[![CI](https://github.com/patlux/pi-commandcode-provider/actions/workflows/ci.yml/badge.svg)](https://github.com/patlux/pi-commandcode-provider/actions/workflows/ci.yml)
[![Memory benchmark](https://github.com/patlux/pi-commandcode-provider/actions/workflows/memory-benchmark.yml/badge.svg)](https://github.com/patlux/pi-commandcode-provider/actions/workflows/memory-benchmark.yml)

A custom provider for [pi](https://github.com/earendil-works/pi) that connects to the [Command Code](https://commandcode.ai) Provider API.

> **Disclaimer:** This is an unofficial, community-maintained integration. It is not affiliated with, endorsed by, or supported by Command Code. You need your own Command Code account, API key, and a plan with Provider API access. Command Code's terms, availability, and pricing apply.

## Install

```sh
pi install npm:pi-commandcode-provider
```

Start or reload pi, then authenticate:

```txt
/login
```

Select **Use a subscription**, then **Command Code**. Choose browser login or paste an API key, then select a model with `/model`.

## Oh My Pi

Install the same package in [Oh My Pi](https://github.com/can1357/oh-my-pi):

```sh
omp plugin install pi-commandcode-provider
```

Restart OMP or run `/reload`, then use `/login` and select **Use a subscription** followed by **Command Code**.

## Authentication

### Login dialog

Run `/login` in pi or OMP. Select **Use a subscription**, then **Command Code**. Press Enter for browser login, type `key` to open a paste prompt, or paste the API key directly. The selected credential is stored in the host's auth file.

<img width="1520" height="554" alt="Select Command Code in pi's login dialog" src="https://github.com/user-attachments/assets/071e929a-6f49-4803-bfec-7a31368fb12a" />

If automatic transfer from the browser fails, copy the API key shown by Command Code and paste it into the terminal prompt.

On Oh My Pi, `/login` stores those credentials in OMP's credential store and chat uses them directly. If chat still returns `401 Invalid 'Authorization' header`, restart OMP after `/login` and confirm `/commandcode:quota` shows your account.

### Environment variable

```sh
export COMMAND_CODE_API_KEY="user_..."
```

### Auth file

The provider also reads existing credentials from:

- `~/.commandcode/auth.json`
- `~/.pi/agent/auth.json`
- `~/.omp/agent/auth.json`

Supported examples:

```json
{
  "apiKey": "user_..."
}
```

```json
{
  "command-code": {
    "type": "api",
    "key": "user_..."
  }
}
```

```json
{
  "commandcode": "user_..."
}
```

## Usage

Open `/model` and select one of the models provided by Command Code. Model availability changes over time and is refreshed from the Provider API when the extension loads.

Other extensions that stream with the active Command Code model, such as background agents or memory workers, use the same connection and the same credentials as the chat, so their requests count against your Command Code usage.

### Reasoning support

Reasoning capability and selectable effort levels follow the official CLI catalog independently. Models can therefore be marked as reasoning-capable even when Command Code chooses their depth automatically. Models with explicit effort support register a model-specific `thinkingLevelMap`, so pi and OMP expose only valid levels. For a few reasoning models the CLI catalog ships no effort levels although the endpoint accepts `reasoning_effort`; `src/commandcode-catalog-overrides.ts` adds a manual level set for those (currently `meta/muse-spark-1.1`, `meta/muse-spark-1.2`, and `meta/muse-spark-1.2-contributor`) on top of the generated catalog. The catalog sync removes an override as soon as upstream publishes its own levels. Pi's native OpenAI- and Anthropic-compatible providers translate the selected level for Provider API accounts; the existing Command Code generate transport sends the matching `reasoning_effort` for Go accounts.

List Command Code models from the terminal:

```sh
pi --list-models commandcode
```

In OMP, use:

```sh
omp models
```

For non-interactive OMP requests, use a provider-qualified model ID shown by `omp models`. For example:

```sh
omp -p "hello" --model commandcode/deepseek/deepseek-v4-flash
```

## Model discovery and offline behavior

The provider fetches the current model catalog from:

```txt
https://api.commandcode.ai/provider/v1/models
```

The last successful catalog is cached at `<agent-dir>/commandcode-models.json`. For pi this is `~/.pi/agent/commandcode-models.json` by default. Compatible hosts such as OMP use their own agent directory.

When a valid cache exists, the provider registers the cached catalog immediately and refreshes it from the endpoint in the background, so startup does not wait for the network. The refreshed catalog replaces the cached one as soon as it arrives; `/commandcode:status` reports `source: cache` until then. If the endpoint is temporarily unavailable, the cached catalog stays active. On a first start without a cache, the provider waits for the live catalog; if that fails offline, pi still loads, but Command Code models remain unavailable until the connection is restored and `/commandcode:refresh` succeeds.

While pi is running, use these provider commands without restarting:

- `/commandcode:refresh` fetches and re-registers the current model catalog. Overlapping refreshes are coalesced, and a failed refresh keeps the last valid catalog active.
- `/commandcode:status` shows redacted discovery diagnostics, including the source, model count, timestamps, cache path, endpoint, and warning.
- `/commandcode:quota` shows your Command Code account usage and quota: the 30-day, 5-hour, and weekly windows as remaining-percentage bars with reset times, with the remaining monthly credits next to the 30-day bar. The report is appended as a session entry so it persists in the transcript and is not sent to the model.

The `/commandcode:quota` command reads from the Command Code alpha usage endpoints (the same ones the `cmd` CLI `/usage` command uses): `whoami`, `billing/credits`, `billing/subscriptions`, and `usage/summary`. It authenticates with the same API key the provider already uses. After `whoami` resolves the org, the three billing endpoints are fetched together; the command does not display the billing-period request or token totals. The resolved account identity is cached on disk beside the agent's other Command Code files, keyed by a SHA-256 of the API key, so repeated fetches skip `whoami`; the entry has no time-based expiry and is dropped after a failed request. The monthly window is derived, not reported: `billing/credits` carries the remaining balance but no cap, so the cap is the remaining balance plus the billing-period spend from `usage/summary`, and its reset is the subscription's period end. If the command cannot reach those endpoints or an endpoint schema changes, unavailable sections are reported explicitly instead of being displayed as zero usage. In TUI mode the report is rendered from the session entry; other hosts get a plain-text notification so it works across pi and compatible hosts such as OMP.

On Oh My Pi the provider also registers an OMP usage provider through the `usage` field of `pi.registerProvider`, reading the same endpoints with the same credentials. It supplies the account's 5-hour and weekly usage windows, credits remaining and used against the billing-period pool, and the current plan to the host's usage surfaces, and it follows the same rule for sections the API does not report. pi has no such field and ignores it.

Select a `Command Code (ZDR)` model to send Command Code's documented `x-cmd-zdr: 1` zero-data-retention header. The `commandcode-zdr` provider mirrors the `commandcode` catalog with ZDR always on, and the `/commandcode:zdr` policy (exclusions, 422 handling, zones) applies to it. Set `CMD_ZDR=1` to force the header on the plain provider too; the legacy `COMMANDCODE_ZDR=1` alias remains supported.

The following environment variables are intended for tests, local mocks, and compatible API endpoints:

- `COMMANDCODE_API_BASE`
- `COMMANDCODE_MODELS_URL`
- `COMMANDCODE_MODELS_CACHE`
- `COMMANDCODE_MODELS_TIMEOUT_MS` (defaults to 10 seconds; invalid or non-positive values use the default)

## Image input

The provider advertises image input only for models marked with the `image` input modality in the official Command Code CLI model catalog. The capability snapshot currently follows `command-code@1.72.4`; unknown models default to text-only until their upstream metadata is reviewed. A daily GitHub Actions job synchronizes the CLI version, image capabilities, reasoning flags, reasoning efforts, and model-specific output limits with the latest published CLI package, also dropping manual effort overrides that upstream has published itself, and opens or updates a reviewable pull request when they change. Pricing remains manually reviewed because temporary promotions and long-context tiers require explicit review.

For vision-capable models, Pi's native provider adapters forward image blocks from user messages and tool results using the documented OpenAI or Anthropic message schema. Unknown and text-only models remain marked text-only in Pi.

The legacy generate transport resolves image support from the host's `model.input` when the host supplies it, and falls back to the capability snapshot otherwise. Because the snapshot is generated from a single CLI release, a host that marks a model as `["text", "image"]` — for example through a `models.yml` or `models.json` model override — can send images on both transports before the catalog catches up. A host that narrows a catalogued vision model to text is likewise honored.

## Web search

The package includes a `web_search` tool as a separate extension entry (`commandcode-web-search.ts`), so it can be enabled or disabled independently of the provider. The tool calls Command Code's own search route with the credentials stored by `/login`, which means it works with any active model, not only Command Code models, but requires a logged-in Command Code account and counts against your Command Code usage.

Two inputs are repaired rather than rejected, and the chosen behavior is reported in the result as a `Note:` line:

- `numResults` above 10 is split across calls (up to three) and merged by URL, because the service ranks at most ten results per call.
- `allowed_domains` together with `blocked_domains` keeps the intersection: the allow list is applied by the service and the block list is removed locally, because the service accepts only one of the two.

The tool is read-only and marks itself `openWorldHint`. It is separate from pi's built-in tooling and from the official Command Code CLI.

## Pricing display

The Command Code Provider API does not currently include prices in its model catalog. This extension therefore keeps a static table for models with known prices so pi and OMP can display estimated request costs. DeepSeek V4 uses time-dependent rates: the extension applies the documented 2x peak rates on weekdays from 01:00-04:00 and 06:00-10:00 UTC, and off-peak rates at all other times, including the entire weekend. The same request-time selection is used by the native Provider API path and the legacy generate fallback.

Models missing from that table display zero cost in pi. This does **not** mean that Command Code will bill the request at zero. The Command Code Usage page remains authoritative for each request. Check the current [Command Code pricing](https://commandcode.ai/docs/resources/pricing-limits) before relying on the displayed value.

## Update and remove

Update installed pi packages:

```sh
pi update --extensions
```

Remove the provider:

```sh
pi remove npm:pi-commandcode-provider
```

For OMP:

```sh
# Update
omp plugin install pi-commandcode-provider --force

# Remove
omp plugin uninstall pi-commandcode-provider
```

## Development

Start an isolated pi instance with only the current checkout installed and no existing Command Code credentials:

```sh
npm run pi:isolated
```

Run `/login` inside pi. Temporary credentials, configuration, and sessions are deleted when pi exits.

Start the current checkout with your existing pi credentials and only Command Code models in the model picker:

```sh
npm run pi:authenticated
```

Both commands accept additional pi arguments after `--`, for example `npm run pi:authenticated -- --model claude-sonnet-4-6`.

### Live transport tests

Keep Go-, GOAT-, and optional Provider-plan test keys in separate secret-manager entries. Pass them through protected files so the keys do not enter shell history:

```sh
COMMANDCODE_E2E_GO_API_KEY_FILE=/path/to/go-key \
  npm run test:e2e:live:go

COMMANDCODE_E2E_GOAT_API_KEY_FILE=/path/to/goat-key \
  npm run test:e2e:live:goat

COMMANDCODE_E2E_PROVIDER_API_KEY_FILE=/path/to/provider-key \
  npm run test:e2e:live:provider

COMMANDCODE_E2E_GO_API_KEY_FILE=/path/to/go-key \
COMMANDCODE_E2E_GOAT_API_KEY_FILE=/path/to/goat-key \
  npm run test:e2e:live:all
```

Each profile runs with an isolated Pi agent directory and asserts transport selection, reasoning across turns, quota plan identity, abort handling, tool calls, and the packed npm artifact. Go must select `generate` and reject unsupported images; GOAT must select `provider` and complete a live vision request. The profile-specific `*_API_KEY` environment variables are also supported for CI secrets, but key files are preferred for local use.

The Go profile defaults to DeepSeek V4 Flash; GOAT defaults to Grok 4.6 because its Provider API stream exposes reasoning consistently across consecutive turns. Override them with `COMMANDCODE_E2E_GO_MODEL`, `COMMANDCODE_E2E_GOAT_MODEL`, or `COMMANDCODE_E2E_PROVIDER_MODEL`. The GOAT vision phase defaults to GPT-5.6 Luna and can be overridden with `COMMANDCODE_E2E_GOAT_VISION_MODEL`. A successful live Anthropic `/provider/v1/messages` test requires a paid account whose plan includes the selected Claude model.

See [CONTRIBUTING.md](CONTRIBUTING.md) for local setup and tests. See [RELEASE.md](RELEASE.md) for the release process.

## Maintainers

- [@patlux](https://github.com/patlux)
- [@pierreraby](https://github.com/pierreraby)
- [@karaaslanz](https://github.com/karaaslanz)

## License

MIT
