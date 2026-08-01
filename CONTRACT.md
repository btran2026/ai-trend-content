# Content contract

Everything in this repo is static JSON served over GitHub Pages at:

```
https://btran2026.github.io/ai-trend-content/
```

The AI Trend app is a **pull** client (Phase 1). It fetches `manifest.json`, compares
versions against what it has already imported, and downloads only what changed.
There is no server-side per-user state and no auth — this is a read-only CDN.

**Rule: never break a field the shipped app reads.** Add fields, don't rename or
remove them. Old binaries stay in the field for a long time. Bump
`manifestVersion` on every publish so clients know something moved.

---

## `manifest.json`

The single entry point. Small on purpose — the app fetches this on every sync, so
it must stay cheap.

```json
{
  "manifestVersion": 12,
  "generatedAt": "2026-07-28T18:00:00.000Z",
  "latestDigestId": "2026-07-28",
  "digests": [
    {
      "id": "2026-07-28",
      "url": "digests/2026-07-28.json",
      "kind": "scheduled",
      "generatedAt": "2026-07-28T18:00:00.000Z",
      "itemCount": 24,
      "headline": "Hermes 4 ships with native tool-calling",
      "contentVersion": 3
    }
  ],
  "radar": { "url": "models/radar.json", "contentVersion": 5 },
  "sources": { "url": "config/sources.json", "contentVersion": 1 },
  "news": {
    "frontPage": { "url": "news/frontpage.json", "contentVersion": 4, "generatedAt": "2026-07-31T18:00:00.000Z" },
    "lanes": {
      "crypto": { "url": "news/lanes/crypto.json", "contentVersion": 4, "generatedAt": "2026-07-31T18:00:00.000Z", "storyCount": 11 },
      "markets": { "url": "news/lanes/markets.json", "contentVersion": 3, "generatedAt": "2026-07-31T18:00:00.000Z", "storyCount": 10 },
      "ai": { "url": "news/lanes/ai.json", "contentVersion": 2, "generatedAt": "2026-07-31T12:00:00.000Z", "storyCount": 8 },
      "tech": { "url": "news/lanes/tech.json", "contentVersion": 2, "generatedAt": "2026-07-31T12:00:00.000Z", "storyCount": 9 }
    }
  }
}
```

`news` is additive (see "News lanes" below) — it never touches `latestDigestId`,
`digests`, `radar` or `sources`, and a lane's `contentVersion`/`generatedAt` can
be stale relative to the front page's if that lane's most recent run produced
nothing new (an empty or failing lane leaves its previous publish untouched
rather than overwriting it with an empty one — see that section for why).

| Field | Meaning |
| --- | --- |
| `manifestVersion` | Monotonic. Incremented on every publish. Clients skip the sync when unchanged. |
| `latestDigestId` | What "Today" shows. Points at the newest digest, scheduled or on-demand. |
| `digests[]` | Newest first, capped at `DIGEST_INDEX_LIMIT` (60). Older files stay on disk but leave the index. |
| `digests[].contentVersion` | Bumped when a digest is regenerated in place (same id, e.g. a second cron run on the same day). Drives re-import. |
| `digests[].headline` | Duplicated from the digest's brief so the app can render a feed row without downloading the full digest. |

## `digests/<id>.json`

One digest = one aggregation run. `id` is `YYYY-MM-DD` for scheduled runs, or
`ondemand-<epoch>-<slug>` for admin-triggered runs.

```json
{
  "id": "2026-07-28",
  "kind": "scheduled",
  "generatedAt": "2026-07-28T18:00:00.000Z",
  "triggeredBy": "cron",
  "query": null,
  "windowHours": 36,
  "brief": {
    "headline": "Hermes 4 ships with native tool-calling",
    "summary": "Two paragraphs of plain-language framing...",
    "bullets": ["One line per thing that actually moved"],
    "signals": [
      { "label": "Open-weight momentum", "direction": "up", "note": "Three releases in a week" }
    ]
  },
  "items": [
    {
      "id": "hn-41234567",
      "title": "Hermes 4 released",
      "url": "https://...",
      "source": "Hacker News",
      "sourceKind": "discussion",
      "publishedAt": "2026-07-28T09:12:00.000Z",
      "tldr": "One sentence, no hedging.",
      "whyItMatters": "Two sentences aimed at someone shipping on multiple models.",
      "category": "open-models",
      "tags": ["hermes", "tool-calling"],
      "entities": ["Nous Research"],
      "models": ["Hermes 4"],
      "importance": 4,
      "actionability": 5,
      "tryThis": "Set the router's background slot to a local Qwen",
      "hasFailureReport": false,
      "discussionUrl": "https://news.ycombinator.com/item?id=41234567",
      "score": 412
    }
  ],
  "clusters": [
    { "id": "c1", "title": "Open-weight tool-calling", "summary": "...", "itemIds": ["hn-41234567"] }
  ],
  "cost": {
    "inputTokens": 41233,
    "outputTokens": 8112,
    "usd": 0.2456,
    "model": "claude-sonnet-5",
    "calls": 6,
    "billing": "api"
  }
}
```

### `sourceKind`

Drives the app's source filter chips. Closed set — the app maps anything
unrecognised to `other`.

`lab` (first-party lab announcements) · `paper` · `discussion` · `repo` ·
`model` (a model card / weights drop) · `news` · `release` (a changelog or
release-notes entry) · `tooling` · `other`

`release` is new. Binaries shipped before it render it as `other`, which is the
intended degradation.

### `category`

Drives the app's category filter. Closed set, mapped to `other` if unknown.

`open-models` · `closed-models` · `agentic` · `adoption` · `tooling` ·
`research` · `use-cases` · `business` · `technique`

`technique` is new — an item that hands the reader something to run. Older
binaries map it to `other`.

### `importance`

1–5, AI-assigned. The app's feed defaults to `>= 2`; "Just the signal" filters to `>= 4`.

### `actionability`, `tryThis`, `hasFailureReport`

Added together, all optional for a reader, all additive for the app.

| Field | Meaning |
| --- | --- |
| `actionability` | 1–5. 5 = there is a command in here the reader can run tonight. **This, not `importance`, is what the digest is now sorted by.** |
| `tryThis` | Optional one-line imperative next step. Absent when the item is worth knowing but has no direct action. |
| `hasFailureReport` | True when the item reports something that broke in real use. Sorted upward on purpose. |

**Why `importance` still moves:** shipped binaries filter the feed on
`importance` alone and know nothing about `actionability`, so a 5-actionability
item scored 1 for importance would be invisible in the app this change exists to
fix. The aggregator therefore writes `importance = max(importance, actionability)`.
Once a release ships that reads `actionability` directly, drop that floor in
`scripts/lib/ai.mjs` and let the two fields mean independent things again.

### `cost`

What this digest cost to produce. Surfaced in the app's admin panel as the whole
point of the shared backend: one run, one bill, every install reads it.

`billing` is additive and tells you how to read `usd`:

| `billing` | Meaning |
| --- | --- |
| `api` | A real charge against `ANTHROPIC_API_KEY`. Cron and any keyed run. |
| `subscription` | The run went through a logged-in `claude -p` session. `usd` is what it *would* have cost at API rates, not what it charged. |

Absent on digests published before the CLI backend existed; treat missing as `api`.

## `models/radar.json`

Tracked open and closed models. The aggregator appends timeline entries when a
digest contains a release; it never rewrites history.

```json
{
  "contentVersion": 5,
  "generatedAt": "2026-07-28T18:00:00.000Z",
  "models": [
    {
      "id": "hermes-4",
      "name": "Hermes 4",
      "vendor": "Nous Research",
      "openness": "open-weights",
      "license": "Llama 3.1 Community",
      "contextTokens": 131072,
      "priceInPerMTok": null,
      "priceOutPerMTok": null,
      "status": "current",
      "firstSeenAt": "2026-07-28T09:12:00.000Z",
      "timeline": [
        { "at": "2026-07-28T09:12:00.000Z", "what": "Released with native tool-calling", "url": "https://..." }
      ]
    }
  ]
}
```

`openness`: `open-weights` · `open-source` · `closed` · `unknown`
`status`: `current` · `preview` · `deprecated` · `rumored`

---

## News lanes

An additive, second content type alongside the AI digest: a multi-lane news
feed with four fixed lanes — `crypto`, `markets`, `ai`, `tech` — each holding
8-12 AI-summarised, source-backed stories. Entirely separate storage from
`digests/`; nothing here ever touches `latestDigestId`, `digests`, `radar` or
`sources`. An app build that doesn't know about `news` simply never requests
these paths — the manifest addition is invisible to it.

### Shared types

```ts
type NewsLane = 'crypto' | 'markets' | 'ai' | 'tech';

interface StorySource {
  title: string;
  url: string;
  publisher: string;
  publishedAt: string | null;
}

interface NewsStory {
  id: string;                 // stable across reruns — see "Story identity"
  slug: string;                // stays stable together with `id` when a story continues
  lane: NewsLane;
  title: string;
  summary: string;
  whyItMatters: string;
  whatToWatch: string[];
  questions: string[];
  sources: StorySource[];      // every fetched article, reconstructed by code
                                // from fetched data — never from anything the
                                // AI stage writes. May include more than one
                                // article from the same publisher.
  sourceCount: number;         // DISTINCT contributing publishers behind this
                                // story — not `sources.length`. Two articles
                                // from one outlet count once; `sources[]`
                                // still lists both as receipts.
  publishedAt: string | null;  // earliest known report of the story
  updatedAt: string;           // when this run last touched the story
  imageUrl?: string;           // reserved; not populated by the aggregator yet
  badge?: string;              // optional short label, e.g. "Regulatory"
  trendScore: number;          // 0-100, deterministic — see "Ranking" below
  confidence: 'high' | 'medium' | 'low'; // deterministic — never AI-assigned
}

interface LaneFeed {
  lane: NewsLane;
  generatedAt: string;
  contentVersion: number;
  stories: NewsStory[];
}

interface FrontPage {
  generatedAt: string;
  contentVersion: number;
  lanes: Record<NewsLane, NewsStory[]>;
}
```

### Static paths

| Path | What |
| --- | --- |
| `news/frontpage.json` | A `FrontPage` — every lane's current stories in one file, for a "front page" view that shows all four lanes without four requests. |
| `news/lanes/<lane>.json` | A `LaneFeed` for one lane (`news/lanes/crypto.json`, `.../markets.json`, `.../ai.json`, `.../tech.json`). |

There is no separate per-story file in this MVP — a story route in the app
resolves by finding the matching `id`/`slug` inside the lane's `stories[]`
(from either `frontpage.json` or that lane's file, whichever is already local).

### Story identity across reruns (`id`, `slug`)

A story's `id` (and, when it's reused, its `slug`) must survive reruns so a
client's read-state/notification keying doesn't churn every time the
aggregator runs — including when a new, higher-authority outlet picks the
story up later. The aggregator does this by matching, not by re-deriving a
hash from whichever source happens to look "best" this run:

1. This run's cluster of related reporting is compared against the lane's
   currently-published stories by **canonical source URL overlap** — if any
   URL in the new cluster matches any URL already recorded in a published
   story's `sources[]`, that's the same story, and its `id`/`slug` are reused
   as-is. This is the primary and by far the most common path, and it is
   intentionally indifferent to *which* item in the cluster is highest
   authority or "representative" — a bigger outlet joining later never mints
   a new id.
2. Only if no URL overlaps at all (every one of that story's old sources has
   rolled outside the current fetch window) does it fall back to a
   conservative title/entity similarity match, at a bar well above what
   clustering itself uses — and it refuses to guess whenever more than one
   previously published story is a plausible match, rather than risk merging
   two different stories' identities.
3. A story with no match at all — genuinely new — gets a fresh `id`, derived
   from its **earliest-known** source, not its highest-authority one. Later
   reporting is later by definition, so the earliest item is the one anchor
   least likely to change as the story develops.

### Ranking (`trendScore`, `confidence`)

Both are computed by code, deterministically, from five inputs — **never**
from anything the AI stage writes, specifically so a model can't talk a
thinly-sourced rumor into a high score or "high confidence". All
source-counting inputs (diversity, velocity's multi-outlet-pickup proxy, and
`confidence` itself) are counted by **distinct publisher**, matching
`sourceCount` above — three articles from one outlet is one corroborating
source, not three:

| Input | What it measures | Weight |
| --- | --- | --- |
| Freshness | Recency of the most recent report in the story's cluster, linearly decayed across the fetch window | 30% |
| Diversity | How many distinct publishers are already reporting it (`sourceCount`, capped at 4) | 20% |
| Authority | The highest source-authority rating (1-5, set per feed in `config/news-sources.json`) among the story's sources | 20% |
| Relevance | Lane-keyword hits in the story's titles/snippets | 20% |
| Velocity | Engagement (HN/Reddit score where available) or multi-**publisher** pickup within the window, whichever is higher | 10% |

`trendScore` is that weighted sum, rounded to 0-100 — reconstructable by hand
from the published `sources[]` (grouping by `publisher` first), which is the
point: the ranking is reviewable, not a black box. `confidence` is `high`
only with both distinct-publisher count **and** authority; `medium` with
either; `low` otherwise (see
`scripts/lib/news-sources.mjs` for the exact thresholds).

### Noise filtering (`excludeTitlePatterns`)

Deterministic selection happens *before* the AI editor ever sees a lane's
candidates, so a top-8-to-12 slot wasted on boilerplate can't be recovered
downstream — the model only ever writes about clusters the pipeline already
chose. `filterNoise` (in `scripts/lib/news-sources.mjs`) drops fetched items
whose title matches a lane-configured, case-insensitive regex **before**
`dedupeExact`/`clusterItems`/`rankAndSelect` run, so filtered items never
occupy a cluster or a ranked slot in the first place.

Patterns live in `config/news-sources.json` under each lane's
`excludeTitlePatterns` — a plain array of regex source strings, not hardcoded
in code — so the noise list is reviewable and can be extended per lane
without a code change. This exists to drop items that are technically
on-topic but carry no discrete, reportable event, not to gate real coverage:

- **Markets** is seeded to drop raw SEC Form 3/4/5 filing headlines (e.g.
  `Form 4 IQVIA Inc`) and routine officer/director stock-sale boilerplate
  (e.g. `Iqvia EVP ... Sells 5,000 Shares of Stock`, `Insider Sells $1.2
  Million in Stock`). Real SEC/regulatory action (`SEC charges ... with
  fraud`), earnings coverage, and genuinely market-moving insider stories
  (e.g. a headline naming the company/context around a large sale, not just
  the boilerplate share-count template) are unaffected.
- **Crypto** is seeded to drop generic daily/weekly roundup headlines that
  carry no discrete event (`Here's what happened in crypto today`, `Crypto
  Daily Recap`, `Today in Crypto`, `This Week in Crypto`).

A lane with no `excludeTitlePatterns` configured (or an empty array) is
unaffected — the filter is opt-in per lane. An individual pattern that fails
to compile (a config typo) is skipped with a warning rather than crashing the
lane, the same fail-soft posture as a dead feed. Every run logs how many
items a lane's patterns filtered, so the effect is visible, not silent.

### Anti-fabrication

The AI editorial stage (one call per lane) writes `summary`, `whyItMatters`,
`whatToWatch` and `questions` for the clusters the deterministic pipeline above
already selected. It is structurally prevented from inventing a source:

- It is given a `clusterId` and the sources already fetched for that cluster —
  never asked to supply a URL, and the response schema has no field for one.
- A `clusterId` in the response that wasn't supplied is dropped outright.
- A `clusterId` the response returns more than once is only published the
  first time — each selected cluster becomes at most one story, never two
  stories sharing one `id`.
- `sources[]` on the published story always comes from the cluster's own
  fetched data, never from the model's response.
- A model-proposed `title` that shares almost no vocabulary with the cluster's
  best-sourced item falls back to that item's title instead.

### Empty/failing lanes

A lane that fetches nothing, or whose AI stage fails, is **skipped** for that
run: its file under `news/lanes/`, its manifest entry, and its slot in
`frontpage.json` all keep whatever was last published there. One dead lane
never blanks out, or blocks, the others — the same "publish nothing rather than
something broken" rule the digest uses, applied per lane.

## `config/sources.json`

The aggregator's input list, committed so it's reviewable and so the app can show
"where this comes from". See the file itself for the shape.

## `config/news-sources.json`

The news pipeline's per-lane input list — RSS feeds (each with an `authority`
1-5 rating), Hacker News queries, and an optional `excludeTitlePatterns` noise
filter (see "Noise filtering" above), one set per lane. Separate from
`config/sources.json` because that file is an AI-only corpus and does not cover
crypto, markets or general tech; the `ai` lane deliberately reuses many of the
same feeds. See the file itself for the shape.

---

## Client sync rules (Phase 1)

1. `GET manifest.json` (cache-busted with `?t=<epoch>`).
2. If `manifestVersion` equals the stored one, stop — no further requests.
3. Otherwise fetch `latestDigestId` if new or its `contentVersion` grew, plus
   `radar.json` if its `contentVersion` grew.
4. Import, then store the new `manifestVersion`.
5. Any failure at any step is swallowed. A bad digest is skipped, never fatal.

News lanes follow the same pattern, additively: if `news.frontPage.contentVersion`
or a given `news.lanes.<lane>.contentVersion` grew, fetch that file; if it
didn't, skip it. A build that predates `news` simply never reads `manifest.news`
at all, and nothing above changes for it.

Phase 2 will add a device-token registry and real push, which needs infra beyond
Pages. Until then the app polls on launch/foreground and fires a **local**
notification when a sync turns up something new.
