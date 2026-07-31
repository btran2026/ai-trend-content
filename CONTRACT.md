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
  "sources": { "url": "config/sources.json", "contentVersion": 1 }
}
```

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
  "cost": { "inputTokens": 41233, "outputTokens": 8112, "usd": 0.2456, "model": "claude-sonnet-5" }
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

What this digest cost to produce, server-side. Surfaced in the app's admin panel
as the whole point of the shared backend: one run, one bill, every install reads it.

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

## `config/sources.json`

The aggregator's input list, committed so it's reviewable and so the app can show
"where this comes from". See the file itself for the shape.

---

## Client sync rules (Phase 1)

1. `GET manifest.json` (cache-busted with `?t=<epoch>`).
2. If `manifestVersion` equals the stored one, stop — no further requests.
3. Otherwise fetch `latestDigestId` if new or its `contentVersion` grew, plus
   `radar.json` if its `contentVersion` grew.
4. Import, then store the new `manifestVersion`.
5. Any failure at any step is swallowed. A bad digest is skipped, never fatal.

Phase 2 will add a device-token registry and real push, which needs infra beyond
Pages. Until then the app polls on launch/foreground and fires a **local**
notification when a sync turns up something new.
