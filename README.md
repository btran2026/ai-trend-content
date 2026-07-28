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

## Triggering a refresh

Three ways in, all landing in the same place:

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
