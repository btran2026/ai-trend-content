/**
 * News lane collection: fetch → exact dedupe → deterministic clustering →
 * deterministic ranking. Everything in this file is pure/reviewable — no AI —
 * so the *ranking* of what makes a lane's top 8-12 is fully explainable
 * without reading a model's (hidden) reasoning. The AI stage in news-ai.mjs
 * only ever writes prose about a cluster this file already selected.
 *
 * Reuses scripts/lib/sources.mjs's fetchRss / fetchHackerNews / dedupeKey
 * rather than re-implementing fetch or URL canonicalisation — every fetcher
 * inherited from there is just as fail-soft: a dead feed logs and yields [].
 */
import { fetchRss, fetchHackerNews, fetchPageImage, dedupeKey } from './sources.mjs';

const STOPWORDS = new Set([
  'the', 'a', 'an', 'of', 'to', 'in', 'on', 'for', 'and', 'or', 'is', 'are',
  'with', 'at', 'by', 'as', 'after', 'amid', 'over', 'how', 'why', 'what',
  'its', 'his', 'her', 'their', 'this', 'that', 'from', 'into', 'than', 'new',
]);

/** Lowercase, alnum-only token set for a title. Used for near-duplicate detection. */
export function titleTokens(title) {
  return new Set(
    String(title)
      .toLowerCase()
      .replace(/[^a-z0-9 ]/g, ' ')
      .split(/\s+/)
      .filter(w => w.length > 2 && !STOPWORDS.has(w)),
  );
}

/**
 * Naive proper-noun extraction: runs of capitalised words in the *original*
 * (non-lowercased) title. Good enough to catch "Federal Reserve", "Bitcoin
 * ETF", "OpenAI" without a NER model or a dependency — this only needs to
 * nudge clustering toward the same entity, not identify entities precisely.
 */
export function extractEntities(title) {
  const matches = String(title).match(/\b[A-Z][a-zA-Z0-9]*(?:\s+[A-Z][a-zA-Z0-9]*)*\b/g) || [];
  return new Set(
    matches.map(s => s.trim()).filter(s => s.length > 2 && !STOPWORDS.has(s.toLowerCase())),
  );
}

function jaccard(a, b) {
  if (!a.size || !b.size) return 0;
  let inter = 0;
  for (const x of a) if (b.has(x)) inter++;
  return inter / (a.size + b.size - inter);
}

/**
 * Exact/canonical duplicate removal: the same article often arrives twice
 * (an RSS feed and an HN submission linking the same URL). Keyed on the same
 * canonical URL as the digest pipeline. The richer copy wins — highest
 * authority, then highest engagement score — so a wire report of a story
 * outranks a forum link to it, but neither is *lost*: this only folds one
 * literal copy into another, it never merges two different publishers'
 * distinct reporting (that's clusterItems' job).
 */
export function dedupeExact(items) {
  const byUrl = new Map();
  for (const item of items) {
    const key = dedupeKey(item.url);
    const existing = byUrl.get(key);
    if (
      !existing ||
      (item.authority ?? 1) > (existing.authority ?? 1) ||
      ((item.authority ?? 1) === (existing.authority ?? 1) && (item.score ?? 0) > (existing.score ?? 0))
    ) {
      byUrl.set(key, item);
    }
  }
  return [...byUrl.values()];
}

/**
 * Case-insensitive title noise filter, applied *before* clustering/ranking —
 * deterministic selection has no way to recover a wasted top-N slot once an
 * AI editor sees only what survived it, so junk has to be dropped upstream
 * of that, not patched after the fact for whatever happened to show up in
 * today's fetch.
 *
 * Patterns are plain regex source strings (compiled case-insensitively),
 * configured per lane in config/news-sources.json under
 * `excludeTitlePatterns` — deliberately not hardcoded in this file — so the
 * noise list is reviewable, lane-specific, and extendable without a code
 * change. Typical uses: raw SEC Form 3/4/5 filing headlines and routine
 * officer/director stock-sale boilerplate (markets), or generic
 * no-discrete-event daily/weekly roundup headlines (crypto). A pattern that
 * fails to compile (a config typo) is skipped with a warning rather than
 * crashing the lane — config errors must stay fail-soft, same posture as a
 * dead feed.
 *
 * Returns the surviving items and logs how many were dropped, so the effect
 * of a pattern is visible in every run's output, not silent.
 */
export function filterNoise(items, patterns, { lane, log = console } = {}) {
  if (!patterns?.length) return items;

  const compiled = [];
  for (const source of patterns) {
    try {
      compiled.push(new RegExp(source, 'i'));
    } catch (err) {
      log?.warn?.(`  ! ${lane ?? 'lane'}: invalid excludeTitlePatterns entry ${JSON.stringify(source)}: ${err.message}`);
    }
  }
  if (!compiled.length) return items;

  const kept = [];
  let filteredCount = 0;
  for (const item of items) {
    if (compiled.some(re => re.test(String(item.title)))) {
      filteredCount++;
    } else {
      kept.push(item);
    }
  }

  if (filteredCount > 0) {
    log?.log?.(`  ${lane ?? 'lane'}: filtered ${filteredCount} noise item(s) (excludeTitlePatterns)`);
  }

  return kept;
}

/** Weighted title/entity similarity threshold above which two items cluster. */
const CLUSTER_THRESHOLD = 0.42;

/**
 * Deterministic clustering of related reporting, before any AI sees the data.
 *
 * Items are sorted by canonical URL first so the result never depends on
 * fetch/network race timing — the same input set always produces the same
 * clusters in the same order, which is what "reviewable" ranking requires.
 *
 * Similarity is 60% title-token Jaccard + 40% entity-token Jaccard; a cluster
 * absorbs an item once its running (unioned) token/entity profile crosses
 * CLUSTER_THRESHOLD against that item. Greedy and O(n * clusters), which is
 * fine at the scale of one lane's fetch window (tens to low hundreds of items).
 */
export function clusterItems(items) {
  const sorted = [...items].sort(
    (a, b) => dedupeKey(a.url).localeCompare(dedupeKey(b.url)) || a.title.localeCompare(b.title),
  );

  const clusters = [];
  for (const item of sorted) {
    const tTok = titleTokens(item.title);
    const eSet = extractEntities(item.title);

    let best = null;
    let bestScore = 0;
    for (const c of clusters) {
      const score = jaccard(tTok, c.titleTokens) * 0.6 + jaccard(eSet, c.entities) * 0.4;
      if (score > bestScore) {
        bestScore = score;
        best = c;
      }
    }

    if (best && bestScore >= CLUSTER_THRESHOLD) {
      best.items.push(item);
      best.titleTokens = new Set([...best.titleTokens, ...tTok]);
      best.entities = new Set([...best.entities, ...eSet]);
    } else {
      clusters.push({
        id: `cl-${clusters.length + 1}-${dedupeKey(item.url).replace(/[^a-z0-9]+/gi, '').slice(0, 24)}`,
        items: [item],
        titleTokens: tTok,
        entities: eSet,
      });
    }
  }
  return clusters;
}

/**
 * The item that best represents a cluster: highest authority, then most
 * recent, then alphabetical by URL for full determinism on ties. Used both as
 * the pre-AI fallback title and as the anchor the AI's title is checked against.
 */
export function representativeItem(cluster) {
  return [...cluster.items].sort(
    (a, b) =>
      (b.authority ?? 1) - (a.authority ?? 1) ||
      (Date.parse(b.publishedAt || 0) || 0) - (Date.parse(a.publishedAt || 0) || 0) ||
      dedupeKey(a.url).localeCompare(dedupeKey(b.url)),
  )[0];
}

export function representativeTitle(cluster) {
  return representativeItem(cluster).title;
}

export function imageForCluster(cluster) {
  return [...cluster.items]
    .filter(item => /^https?:\/\//i.test(item.imageUrl || ''))
    .sort(
      (a, b) =>
        (b.authority ?? 1) - (a.authority ?? 1) ||
        (Date.parse(b.publishedAt || 0) || 0) - (Date.parse(a.publishedAt || 0) || 0) ||
        dedupeKey(a.url).localeCompare(dedupeKey(b.url)),
    )[0]?.imageUrl ?? null;
}

export async function hydrateRankedImages(ranked) {
  await Promise.all(ranked.map(async ({ cluster }) => {
    if (imageForCluster(cluster)) return;
    const representative = representativeItem(cluster);
    const imageUrl = await fetchPageImage(representative.url);
    if (imageUrl) representative.imageUrl = imageUrl;
  }));
  return ranked;
}

/**
 * The item that anchors a *brand-new* story's stable id — earliest known
 * report, tie-broken by canonical URL. Deliberately NOT representativeItem
 * (highest authority): a bigger outlet routinely picks up a story hours or
 * days after the first report, and anchoring id generation on authority means
 * that pickup silently mints a new id for what a reader already knows as the
 * same story. The earliest item is, by construction, essentially immune to
 * that — later reporting is later, full stop. (Continuity across reruns is
 * additionally, and primarily, handled by matchPreviousStory below; this
 * anchor only matters the first time a story is ever published.)
 */
export function anchorItem(cluster) {
  return [...cluster.items].sort(
    (a, b) =>
      (Date.parse(a.publishedAt || 0) || 0) - (Date.parse(b.publishedAt || 0) || 0) ||
      dedupeKey(a.url).localeCompare(dedupeKey(b.url)),
  )[0];
}

/** Normalized publisher identity for corroboration counting — trimmed/
 * lower-cased so trivial casing differences in config don't fragment a count. */
function publisherKey(item) {
  return String(item?.source ?? '').trim().toLowerCase();
}

/**
 * Distinct-publisher count for a cluster — the real corroboration signal.
 * Two articles from the same outlet (a wire republish, an RSS + HN link to
 * the same feed) must not count as two independent confirmations; they count
 * once. This is deliberately different from `cluster.items.length`, which
 * counts raw fetched items and can inflate diversity/velocity/confidence and
 * the published `sourceCount` when one outlet's article is merely present in
 * multiple feeds. `sources[]` (see sourcesForCluster) still lists every
 * fetched item as a receipt — only the *count* used for corroboration is
 * deduped by publisher.
 */
export function distinctPublisherCount(cluster) {
  return new Set(cluster.items.map(publisherKey)).size;
}

/** Canonical URL keys for every item in a cluster — used to match this run's
 * cluster against a previously published story by shared source receipts. */
export function clusterUrlKeys(cluster) {
  return new Set(cluster.items.map(i => dedupeKey(i.url)));
}

/** Stricter than CLUSTER_THRESHOLD on purpose: id inheritance is a much
 * riskier mistake than clustering two reports together (it would silently
 * merge two different stories' read/notification state on a client), so the
 * bar for the title/entity fallback below is deliberately higher. */
const ID_TITLE_MATCH_THRESHOLD = 0.6;

/**
 * Find the previously published story (if any) this cluster continues, so
 * its id/slug can be reused instead of minted fresh every run.
 *
 * Primary signal: any overlap between this cluster's canonical source URLs
 * and a previous story's published `sources[].url`s — the strongest possible
 * evidence it's the same story, since it means we fetched the very same
 * article both times. This is immune to the anchor-drift bug (a new,
 * higher-authority source joining a cluster) because it never depends on
 * *which* item is "the" anchor — any shared URL, from any item, is enough.
 * Multiple previous stories sharing a URL (a rare cross-story mixup) is
 * resolved by picking the one with the most overlapping URLs, then the
 * lowest id, so the result stays deterministic.
 *
 * Fallback: a conservative title/entity match against the cluster's whole
 * accumulated token/entity profile (not just one item), at a threshold well
 * above clustering's own 0.42. This only exists to survive the rare case
 * where every one of a previous story's sources has rolled out of this run's
 * fetch window, so there is no URL left to overlap. It refuses to guess
 * whenever more than one previous story clears the bar, so two unrelated
 * stories can never accidentally inherit the same id.
 */
export function matchPreviousStory(cluster, previousStories) {
  if (!previousStories?.length) return null;

  const urlKeys = clusterUrlKeys(cluster);
  const byOverlap = previousStories
    .map(story => {
      const prevKeys = new Set((story.sources ?? []).map(s => dedupeKey(s.url)));
      let overlap = 0;
      for (const k of urlKeys) if (prevKeys.has(k)) overlap++;
      return { story, overlap };
    })
    .filter(m => m.overlap > 0)
    .sort((a, b) => b.overlap - a.overlap || String(a.story.id).localeCompare(String(b.story.id)));

  if (byOverlap.length) return byOverlap[0].story;

  const candidates = previousStories
    .map(story => {
      const score =
        jaccard(cluster.titleTokens ?? new Set(), titleTokens(story.title)) * 0.6 +
        jaccard(cluster.entities ?? new Set(), extractEntities(story.title)) * 0.4;
      return { story, score };
    })
    .filter(m => m.score >= ID_TITLE_MATCH_THRESHOLD)
    .sort((a, b) => b.score - a.score || String(a.story.id).localeCompare(String(b.story.id)));

  if (candidates.length !== 1) return null; // ambiguous or no match — never guess
  return candidates[0].story;
}

/**
 * Source receipts for a cluster, reconstructed entirely from what we fetched —
 * never from anything an AI writes. Newest first. Every fetched item is kept
 * here as a receipt even when several share one publisher; see
 * distinctPublisherCount for the deduped corroboration count.
 */
export function sourcesForCluster(cluster) {
  return [...cluster.items]
    .sort((a, b) => (Date.parse(b.publishedAt || 0) || 0) - (Date.parse(a.publishedAt || 0) || 0))
    .map(i => ({
      title: i.title,
      url: i.url,
      publisher: i.source,
      publishedAt: i.publishedAt || null,
    }));
}

// ---------------------------------------------------------------------------
// Deterministic ranking. Five inputs, fixed weights, no hidden reasoning.
// ---------------------------------------------------------------------------

/** Relative weight of each ranking input. Sums to 1; tune here, not ad hoc. */
export const RANK_WEIGHTS = { freshness: 0.3, diversity: 0.2, authority: 0.2, relevance: 0.2, velocity: 0.1 };

function freshnessScore(mostRecentMs, now, windowMs) {
  const ageMs = Math.max(0, now - mostRecentMs);
  return Math.max(0, 1 - ageMs / windowMs);
}

/** More independent outlets reporting it = more diverse confirmation. Caps at 4.
 * `sourceCount` here must be a *distinct-publisher* count (see
 * distinctPublisherCount) — otherwise the same outlet's article landing in
 * two feeds (an RSS entry and an HN link to it) inflates diversity. */
function diversityScore(sourceCount) {
  return Math.min(1, sourceCount / 4);
}

function authorityScore(maxAuthority) {
  return Math.min(1, maxAuthority / 5);
}

function relevanceScore(cluster, keywords) {
  if (!keywords?.length) return 0.5; // no lane keywords configured: neutral, don't zero out every story
  const hay = cluster.items.map(i => `${i.title} ${i.snippet ?? ''}`).join(' ').toLowerCase();
  const hits = keywords.filter(k => hay.includes(k.toLowerCase())).length;
  return Math.min(1, hits / 4);
}

/**
 * Velocity/engagement: the strongest signal available without a time-series
 * (we don't track a cluster across runs in this MVP). Two proxies, whichever
 * is higher — a big HN/Reddit score, or several *independent outlets* already
 * picking up the same story within one window, which is itself a velocity
 * tell. The spread proxy is publisher-based on purpose: three articles from
 * one outlet (a live-blog re-post, a wire syndication) are not three outlets
 * picking up the story.
 */
function velocityScore(cluster) {
  const maxEngagement = Math.max(0, ...cluster.items.map(i => i.score ?? 0));
  const engagementNorm = Math.min(1, Math.log10(maxEngagement + 1) / 3);
  const spread = Math.min(1, (distinctPublisherCount(cluster) - 1) / 3);
  return Math.max(engagementNorm, spread);
}

/** 0-100, rounded. The whole point is that this number is reconstructable by hand. */
export function trendScoreFor(cluster, { now, windowMs, keywords }) {
  const mostRecentMs = Math.max(0, ...cluster.items.map(i => Date.parse(i.publishedAt || 0) || 0));
  const maxAuthority = Math.max(1, ...cluster.items.map(i => i.authority ?? 1));

  const f = freshnessScore(mostRecentMs || now, now, windowMs);
  const d = diversityScore(distinctPublisherCount(cluster));
  const a = authorityScore(maxAuthority);
  const r = relevanceScore(cluster, keywords);
  const v = velocityScore(cluster);

  const weighted =
    f * RANK_WEIGHTS.freshness +
    d * RANK_WEIGHTS.diversity +
    a * RANK_WEIGHTS.authority +
    r * RANK_WEIGHTS.relevance +
    v * RANK_WEIGHTS.velocity;

  return Math.round(weighted * 100);
}

/**
 * Confidence is a trust label, not a vibe — it's derived the same way for
 * every lane and never from anything the AI stage says, specifically so a
 * model can't talk a thinly-sourced rumor into "high confidence". Counted by
 * distinct publisher, same reasoning as diversityScore: three articles from
 * one outlet is one corroborating source, not three.
 */
export function confidenceFor(cluster) {
  const sourceCount = distinctPublisherCount(cluster);
  const maxAuthority = Math.max(1, ...cluster.items.map(i => i.authority ?? 1));
  if (sourceCount >= 3 && maxAuthority >= 4) return 'high';
  if (sourceCount >= 2 || maxAuthority >= 4) return 'medium';
  return 'low';
}

/**
 * Rank every cluster and keep the top `max` (never invents a floor of `min` —
 * a quiet lane publishes however many real stories it has, down to zero).
 * Ties break on most-recent-item, then cluster id, so the result is stable
 * given the same input set.
 */
export function rankAndSelect(clusters, { keywords = [], now = Date.now(), windowMs, max = 12 } = {}) {
  const scored = clusters.map(cluster => ({
    cluster,
    trendScore: trendScoreFor(cluster, { now, windowMs, keywords }),
    confidence: confidenceFor(cluster),
  }));
  scored.sort((a, b) => {
    if (b.trendScore !== a.trendScore) return b.trendScore - a.trendScore;
    const aRecent = Math.max(0, ...a.cluster.items.map(i => Date.parse(i.publishedAt || 0) || 0));
    const bRecent = Math.max(0, ...b.cluster.items.map(i => Date.parse(i.publishedAt || 0) || 0));
    if (bRecent !== aRecent) return bRecent - aRecent;
    return a.cluster.id.localeCompare(b.cluster.id);
  });
  return scored.slice(0, max);
}

// ---------------------------------------------------------------------------
// Per-lane collection
// ---------------------------------------------------------------------------

/**
 * Fetch every configured source for one lane, tag each item with its lane and
 * source authority, filter configured title noise, then dedupe and cluster.
 * Never throws: fetchRss/fetchHackerNews are already fail-soft per-feed, and
 * a lane with nothing to fetch (misconfigured or entirely down) just returns
 * [].
 */
export async function collectLane(lane, laneConfig, sinceMs, { log = console } = {}) {
  const raw = [];

  if (laneConfig?.rss?.length) {
    raw.push(...(await fetchRss(laneConfig.rss, sinceMs, laneConfig.keywords ?? [])));
  }
  if (laneConfig?.hackerNews?.enabled) {
    raw.push(...(await fetchHackerNews(laneConfig.hackerNews, sinceMs)));
  }

  const authorityByFeedName = new Map((laneConfig?.rss ?? []).map(f => [f.name, f.authority ?? 3]));
  const hnAuthority = laneConfig?.hackerNews?.authority ?? 2;

  for (const item of raw) {
    item.lane = lane;
    item.authority = item.sourceKind === 'discussion' ? hnAuthority : authorityByFeedName.get(item.source) ?? 3;
  }

  const noiseFiltered = filterNoise(raw, laneConfig?.excludeTitlePatterns, { lane, log });

  const deduped = dedupeExact(noiseFiltered);
  return clusterItems(deduped);
}
