# ai-trend-content

The shared backend for the **AI Trend** mobile app.

A GitHub Actions cron job runs an AI aggregator over ~20 sources, writes a
curated digest, and commits it here. GitHub Pages serves the result, and every
AI Trend install polls it.

**Run once, share with everyone.** The scheduled sweep costs one API bill on one
key regardless of how many installs read it. The app's own BYOK key is reserved
for what's personal (a deep dive, a "why this matters to me") or urgent (ad-hoc
research before the next cron tick).

```
GitHub Actions (cron: every 6h)          Admin Mode in the app
  ANTHROPIC_API_KEY in repo secrets        │  "Refresh now"
        │                                  ▼
        │                          repository_dispatch
        ▼                                  │
  scripts/aggregate.mjs  ◀─────────────────┘
    fetch ~20 sources → dedupe → pre-rank → AI curate → AI brief → AI radar
        │
        ▼  git commit
  manifest.json + digests/<id>.json + models/radar.json
        │
        ▼  GitHub Pages
  btran2026.github.io/ai-trend-content/  ──▶  every AI Trend install
```

## Setup (one time)

1. **Add the API key.** Settings → Secrets and variables → Actions → New secret:
   `ANTHROPIC_API_KEY`. This is the only required secret — `GITHUB_TOKEN` is
   provided automatically and just lifts the GitHub search rate limit.
2. **Enable Pages.** Settings → Pages → Source: *Deploy from a branch* →
   branch `main`, folder `/ (root)`. The `.nojekyll` file is already committed so
   Pages serves the JSON as-is.
3. **Optional:** set an Actions *variable* `AGGREGATOR_MODEL` to override the
   default `claude-opus-5` (e.g. `claude-sonnet-5` to cut the per-run bill).

## Running it

```bash
npm ci

# Fetch and rank only. No AI calls, no API key needed, no writes.
npm run aggregate:dry

# A full scheduled run (writes digests/YYYY-MM-DD.json).
ANTHROPIC_API_KEY=sk-ant-… npm run aggregate

# An on-demand run focused on one topic (writes its own digest).
ANTHROPIC_API_KEY=sk-ant-… node scripts/aggregate.mjs \
  --mode on-demand --query "agentic orchestration" --window-hours 72
```

| Flag | Default | Notes |
| --- | --- | --- |
| `--mode` | `scheduled` | `scheduled` → `YYYY-MM-DD` id. `on-demand` → its own `ondemand-…` id. |
| `--query` | none | Focuses an on-demand run. Added to the keyword set and to both prompts. |
| `--window-hours` | 36 / 72 | How far back to look. On-demand defaults wider. |
| `--max-items` | 70 | Cap on items sent to the AI. The pre-ranker picks which. |
| `--dry-run` | off | Fetch + rank, print the top 20, exit. No AI, no writes. |
| `--triggered-by` | `cron`/`admin` | Recorded in the digest for provenance. |

`--dry-run` is the right first move after touching a fetcher: it exercises every
source and needs no key.

### Publishing from your own machine

`npm run publish:local` runs the aggregation here and pushes the result, so a
digest doesn't have to wait for the next cron tick or burn an Actions run. It is
the same `aggregate.mjs` the workflow runs — the script only adds the rebase,
commit and push that otherwise live in `aggregate.yml`.

**No API key needed locally.** With no `ANTHROPIC_API_KEY` set, the aggregator
calls `claude -p` and uses whatever session Claude Code is already logged into,
so a local run comes out of your subscription rather than API credits. Actions
always has the key, so the hosted path is unchanged.

| `AI_BACKEND` | When | Notes |
| --- | --- | --- |
| `api` | auto when `ANTHROPIC_API_KEY` is set | Real structured outputs, refusal fallback. What cron uses. |
| `cli` | auto when it isn't | `claude -p`, subscription-billed. No `json_schema` on the CLI, so the schema is embedded in the prompt and the reply is parsed defensively. |
| `copilot` | explicit only | `copilot -p` on your GitHub Copilot subscription. Opens up the GPT-5.6 / Gemini tiers, e.g. `AI_BACKEND=copilot AGGREGATOR_MODEL=gpt-5.6-sol`. |

Set `AI_BACKEND` explicitly to override, and `CLAUDE_BIN` / `COPILOT_BIN` if the
binaries aren't on your `PATH`.

The Copilot path differs in three ways worth knowing. It **writes its JSON to a
file** rather than stdout, because Copilot narrates and that narration is not
reliably separable from the payload. It runs `--allow-tool write --deny-tool
shell` — the only legitimate side effect of a text transform is creating one
file, and an unattended run must not be able to execute anything. And it
**retries 3×**: `Model "…" is not available` turns out to be transient, and the
same slug that fails one call answers the next.

Measured availability on this account (the CLI has no list command, so this was
probed): `gpt-5.6-sol`, `gpt-5.6-terra`, `gpt-5.6-luna`, `gpt-5.5`, `gpt-5.4`,
`gpt-5.3-codex`, `gpt-5.4-mini`, `gpt-5-mini`, `gemini-3.5-flash`,
`claude-sonnet-4.5`, `auto` all work. `gemini-3.1-pro` and `mai-code-1-flash`
are **not** available.

The CLI path runs with `--system-prompt` (replacing Claude Code's coding-agent
prompt), `--allowed-tools ""` and `--strict-mcp-config` — it's a text transform
and must not touch the repo or depend on your MCP setup.

Optionally set a key in a gitignored `.env` to use the API path locally instead:

```bash
printf 'ANTHROPIC_API_KEY=sk-ant-…\nAGGREGATOR_MODEL=claude-sonnet-5\n' > .env
```

```bash
npm run publish:local:dry                        # fetch + rank, no AI, no commit
npm run publish:local                            # full run, commits and pushes
npm run publish:local -- --mode on-demand --query "agent harnesses"
NO_PUSH=1 npm run publish:local                  # commit, inspect, push yourself
```

Run it **on `main`** — Pages serves `main`, so a digest published from a feature
branch never reaches the app. The script warns when you're somewhere else.

It refuses to start without a key unless dry-running, pulls with `--rebase`
first (the aggregator reads `manifest.json` to compute version numbers, so a
stale checkout produces a manifest built against the wrong base), and skips the
commit entirely when nothing changed.

**On cost:** on the `cli` backend the run consumes your Claude subscription, not
API credits — the digest still records a `usd` figure, but it's what the run
*would* have cost at API rates, flagged with `"billing": "subscription"`. On the
`api` backend it's a real charge. Either way the model is the lever: set
`AGGREGATOR_MODEL=claude-sonnet-5`. The Actions *variable* of the same name is
still unset, so every hosted run bills `claude-opus-5` at $5/$25 per Mtok, four
times a day.

## Triggering a refresh

Four ways in, all landing in the same place:

- **Your laptop** — `npm run publish:local`. Same script, same commit, same
  published result as the hosted run; it just does the work here and pushes.
- **Cron** — every 6 hours, `00/06/12/18` UTC.
- **Actions tab** — *Aggregate AI news* → *Run workflow*, with inputs for mode,
  query, window, and dry-run.
- **The app's Admin Mode** — fires a `repository_dispatch` of type
  `refresh-digest`. The admin's own fine-grained PAT (Contents: read/write on
  this repo) lives in the device keychain; no credential ships in the binary.
  Same trust model as BYOK.

```bash
# What the app's "Refresh now" button sends:
curl -X POST https://api.github.com/repos/btran2026/ai-trend-content/dispatches \
  -H "Authorization: Bearer $GH_PAT" \
  -H "Accept: application/vnd.github+json" \
  -d '{"event_type":"refresh-digest","client_payload":{"query":"openclaw","window_hours":"72"}}'
```

An admin refresh takes ~1–3 minutes end to end (workflow queue + fetch + AI).
That latency is the accepted cost of running on Actions instead of a live
server — see the Phase 2 note in the app repo's `BACKLOG.md`.

## Layout

| Path | What |
| --- | --- |
| `CONTRACT.md` | **Read this before changing any JSON shape.** The app/backend contract. |
| `manifest.json` | Entry point. Version + pointer to the newest digest. |
| `digests/<id>.json` | One aggregation run: brief, items, clusters, cost. |
| `models/radar.json` | Tracked open + closed models, append-only timeline. |
| `config/sources.json` | The source list. Add a feed here, no code change. |
| `scripts/aggregate.mjs` | Orchestrator. |
| `scripts/lib/sources.mjs` | Fetchers (HN, arXiv, HF, GitHub, Reddit, RSS) + dedupe + pre-rank. |
| `scripts/lib/ai.mjs` | The three AI stages: curate → brief → radar. |
| `scripts/lib/store.mjs` | Digest/manifest/radar writes. |
| `scripts/lib/rss.mjs` | Minimal zero-dependency RSS/Atom parser. |

## Design notes

**Everything is fail-soft.** A dead feed logs a warning and contributes nothing;
a refused or truncated AI call skips that stage. The one thing that *does* stop a
run is an empty curation result or a failed brief — a digest with no brief is
useless, so we publish nothing rather than something broken.

**The AI is a harsh editor by design.** Most of a raw AI feed is press releases,
funding announcements, and SEO repos. The curation prompt says dropping half the
batch is a normal outcome, and it does.

**Cost is recorded in every digest.** `digest.cost` carries the real token counts
and dollar estimate for the run, which the app surfaces in Admin Mode. That
number is the whole argument for the shared backend: it does not scale with
install count.

**Adding a source:** append to `config/sources.json` → `rss`, then
`npm run aggregate:dry` to confirm it parses. Probe the URL first — several
obvious feeds (Anthropic, Meta AI, Nous Research, vLLM) return 404 and are
covered indirectly via newsletters; see the `notes` block in that file.

**Local 403s are expected.** `huggingface.co` and `reddit.com` return 403 behind
a TLS-inspecting corporate proxy, so local dry runs show them empty. They work
from Actions runners. Don't "fix" it by disabling them.
