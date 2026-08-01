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

### The news lanes

A second, additive pipeline: `scripts/aggregate-news.mjs` fetches, dedupes,
clusters and ranks four lanes — crypto, markets, AI, tech — then has AI write
8-12 stories per lane. Same fail-soft posture as the digest, one level more
granular: a lane that fetches nothing or whose AI call fails is skipped for
that run, leaving its previously published feed untouched, while every other
lane still publishes.

```bash
# Fetch, dedupe, cluster and rank only. No AI calls, no API key needed, no writes.
npm run aggregate:news:dry

# A full run — writes news/frontpage.json and news/lanes/<lane>.json.
ANTHROPIC_API_KEY=sk-ant-… npm run aggregate:news

# Just one or two lanes (useful after touching config/news-sources.json):
node scripts/aggregate-news.mjs --lanes crypto,markets
```

| Flag | Default | Notes |
| --- | --- | --- |
| `--window-hours` | 48 | How far back to look, per lane. |
| `--max-per-lane` | 12 | Upper bound on stories kept per lane after ranking (never padded up to a floor). |
| `--lanes` | all four | Comma-separated subset of `crypto,markets,ai,tech`. |
| `--dry-run` | off | Fetch + dedupe + cluster + rank, print the top candidates per lane, exit. No AI, no writes. |
| `--triggered-by` | `cron` | Recorded for provenance in log output. |

Ranking (`trendScore`, `confidence`) is entirely deterministic — freshness,
distinct-publisher diversity, source authority, keyword relevance, and
engagement/velocity, fixed weights, no model in the loop — and reviewable
straight from the published `sources[]` (grouped by publisher; `sourceCount`
is distinct publishers, not raw article count — three copies of one outlet's
story count once). Before any of that, a per-lane, config-driven noise filter
(`excludeTitlePatterns` in `config/news-sources.json`) drops fetched items
whose title matches a lane-configured, case-insensitive regex — e.g. raw SEC
Form 3/4/5 filing headlines and routine officer/director stock-sale
boilerplate in `markets`, or generic no-discrete-event daily/weekly roundups
in `crypto` — so junk never occupies one of a lane's 8-12 slots in the first
place (selection happens before the AI editor ever sees a lane's candidates,
so a wasted slot can't be recovered downstream). See CONTRACT.md's "Noise
filtering" section for the full list and rationale. A story's `id`/`slug`
also survive reruns: a continuing story is matched against the lane's
currently-published feed by shared source URLs first, so a new outlet
picking the story up later never mints a new id. The AI stage only ever
writes prose about the clusters that ranking already picked, one story per
cluster; see CONTRACT.md's "News lanes" section for the exact
anti-fabrication guarantees (it cannot invent a source — the response schema
has no field for one — and a repeated clusterId in its response can't
produce two stories).

The scheduled workflow runs this right after the digest and commits both
together; a failure here is `continue-on-error` at the workflow level and
try/caught per lane inside the script, so it can never block the digest from
publishing. See `config/news-sources.json` for the per-lane source list.

### Publishing from your own machine

`npm run publish:local` runs the aggregation here and pushes the result, so a
digest doesn't have to wait for the next cron tick or burn an Actions run. It is
the same `aggregate.mjs` the workflow runs — the script only adds the rebase,
commit and push that otherwise live in `aggregate.yml`. It also runs
`aggregate-news.mjs` right after, same as the workflow.

**No API key needed locally.** With no `ANTHROPIC_API_KEY` set, the aggregator
calls `claude -p` and uses whatever session Claude Code is already logged into,
so a local run comes out of your subscription rather than API credits. Actions
always has the key, so the hosted path is unchanged.

| `AI_BACKEND` | When | Notes |
| --- | --- | --- |
| `api` | auto when `ANTHROPIC_API_KEY` is set | Real structured outputs, refusal fallback. What cron uses. |
| `cli` | auto when it isn't | Subscription-billed. No `json_schema` on the CLI, so the schema is embedded in the prompt and the reply is parsed defensively. |

Set `AI_BACKEND` explicitly to override, and `CLAUDE_BIN` if `claude` isn't on
your `PATH`.

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
| `scripts/lib/store.mjs` | Digest/manifest/radar writes, plus the additive news-lane publish path. |
| `scripts/lib/rss.mjs` | Minimal zero-dependency RSS/Atom parser. |
| `news/frontpage.json`, `news/lanes/<lane>.json` | The four news lanes' published output. |
| `config/news-sources.json` | Per-lane (crypto/markets/ai/tech) source list + noise-filter patterns for the news pipeline. |
| `scripts/aggregate-news.mjs` | News pipeline orchestrator. |
| `scripts/lib/news-sources.mjs` | Fetch + noise filter + dedupe + deterministic clustering/ranking for the news pipeline. |
| `scripts/lib/news-ai.mjs` | The news pipeline's single per-lane AI stage, with anti-fabrication guardrails. |

## Design notes

**Everything is fail-soft.** A dead feed logs a warning and contributes nothing;
a refused or truncated AI call skips that stage. The one thing that *does* stop a
run is an empty curation result or a failed brief — a digest with no brief is
useless, so we publish nothing rather than something broken. The news pipeline
applies the same rule per lane: a lane with nothing to say leaves its previous
publish alone instead of overwriting it with an empty one.

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
covered indirectly via newsletters; see the `notes` block in that file. For the
news lanes, the equivalent file is `config/news-sources.json` and the dry-run
is `npm run aggregate:news:dry`.

**News ranking is deterministic and reviewable, on purpose.** `trendScore` and
`confidence` are computed entirely from fetched data (freshness,
distinct-publisher count, source authority, keyword relevance, engagement) —
never from the AI stage's output — so a story's rank can be reconstructed by
hand from its published `sources[]` instead of trusting a model's say-so.
`sourceCount` is always distinct publishers, not raw article count, so one
outlet's story landing in two feeds can't inflate a story's diversity,
velocity or confidence. The AI stage's response schema has no field for a URL
or source at all, so it structurally cannot fabricate one; `sources[]` on
every published story is always rebuilt by code from the cluster's own
fetched items, and a cluster is published as at most one story even if the
model's response names it twice. A story's `id`/`slug` are similarly matched
against the lane's currently-published feed by shared source URLs, not
re-derived every run, so they survive a new outlet joining the story later.
See CONTRACT.md's "News lanes" section for the full shape and guarantees.

**Local 403s are expected.** `huggingface.co` and `reddit.com` return 403 behind
a TLS-inspecting corporate proxy, so local dry runs show them empty. They work
from Actions runners. Don't "fix" it by disabling them.
