/**
 * News lane editorial stage: given the clusters news-sources.mjs already
 * selected (deterministically), one AI call per lane writes the reader-facing
 * prose — summary, whyItMatters, whatToWatch, questions, and an optional
 * badge. Nothing about *which* clusters made the lane, or how they rank,
 * comes from this file; that already happened in news-sources.mjs.
 *
 * Anti-fabrication by construction, not by trust:
 *   - The model is given clusterIds and the read-only sources we already
 *     fetched. It is never asked to return a URL, a publisher, or a source.
 *   - NEWS_STORY_SCHEMA has no `sources`/`url` field at all, so there's
 *     nothing for a hallucinated URL to land in even if the model tries.
 *   - `sources` on the published NewsStory always comes from
 *     sourcesForCluster(cluster) — code reconstructing from our own fetched
 *     data — never from the model's response.
 *   - A returned clusterId not in the supplied set is dropped outright.
 *   - A returned clusterId that has *already* been consumed (the model
 *     returned the same valid clusterId twice) is dropped the second time —
 *     each selected cluster is published at most once, never as duplicate
 *     stories with identical ids.
 *   - A returned title that shares almost no vocabulary with the cluster's
 *     representative item falls back to that representative title, so the
 *     model can polish a headline but can't swap in an unrelated one.
 */
import { obj, strArray, callJson } from './ai.mjs';
import {
  representativeItem,
  sourcesForCluster,
  titleTokens,
  distinctPublisherCount,
  anchorItem,
  imageForCluster,
  matchPreviousStory,
} from './news-sources.mjs';

const NEWS_STORY_SCHEMA = obj({
  stories: {
    type: 'array',
    items: obj({
      clusterId: { type: 'string' },
      title: { type: 'string' },
      summary: { type: 'string' },
      whyItMatters: { type: 'string' },
      whatToWatch: strArray,
      questions: strArray,
      badge: { type: 'string' },
    }),
  },
});

/**
 * Grounding rules shared by every lane. Kept separate from the per-lane voice
 * below so the anti-fabrication instructions are reviewed once, in one place,
 * rather than copy-pasted (and drifting) per lane.
 */
const GROUNDING_RULES = `You have no web access and are not being asked to research anything. You are given, for each story, a clusterId and a list of sources we have already fetched and verified (title, publisher, publishedAt). Those are the only facts available to you.

Rules, no exceptions:
- Reference a story ONLY by the clusterId you were given. Never invent a clusterId.
- Do not write, imply, or reference any URL, or attribute anything to a publisher not present in that story's supplied sources.
- Do not invent facts, numbers, quotes, dates, or events beyond what the supplied titles/publishers state. If the supplied information is thin, write a brief, appropriately hedged story — never pad it with invented specifics.
- title may lightly sharpen the supplied representative title (fix awkward phrasing, drop a publisher's house style) but must describe the same event. Do not write a materially different headline.
- summary: 2-4 sentences, plain language, what happened and the immediate context.
- whyItMatters: 1-2 sentences on why a reader tracking this lane should care.
- whatToWatch: 1-4 short forward-looking bullets (what happens next, a date, a decision pending). Empty array if genuinely nothing to watch for.
- questions: 1-3 short open questions a sharp reader would still have. Empty array if none.
- badge: an optional single short label (e.g. "Regulatory", "Earnings", "Breaking", "Analysis") or an empty string if none fits.
- Return one entry per clusterId you were given, in any order.`;

/** Per-lane editorial voice. Kept short and specific — this is the reviewable
 * "prompt diff" between lanes, not a restatement of the grounding rules. */
const LANE_GUIDANCE = {
  crypto: `You write the crypto lane of a daily multi-lane news app, for a reader who tracks digital-asset markets and regulation and wants signal over hype. Favor concrete developments: price-moving regulatory action, exchange/protocol incidents, ETF flows, material technical changes. Treat speculative price commentary skeptically and don't amplify it.`,
  markets: `You write the markets lane of a daily multi-lane news app, for a reader who tracks macro and equity markets. Favor moves with a clear cause (a Fed decision, an earnings print, a data release, a rate move) over generic "stocks were mixed" recaps. Name the instrument, index, or rate when the sources do.`,
  ai: `You write the AI lane of a daily multi-lane news app, for a reader who tracks the AI industry broadly (not just what's runnable tonight — that's a different product). Favor genuine releases, policy/regulatory moves, and material shifts in the competitive landscape over spec-sheet trivia or research-paper hype.`,
  tech: `You write the general tech lane of a daily multi-lane news app, for a reader who wants to know what changed in the broader tech industry: products, platforms, antitrust, security incidents, big-company moves. Skip personal-gadget-review framing; favor industry consequence.`,
};

function sanitizeList(list, { max, maxLen = 200 } = { max: 4 }) {
  return (Array.isArray(list) ? list : [])
    .map(s => String(s ?? '').trim())
    .filter(Boolean)
    .slice(0, max)
    .map(s => (s.length > maxLen ? `${s.slice(0, maxLen - 1)}…` : s));
}

/** Loose "is this still about the same thing" check — not exact match, since
 * the model is allowed to sharpen a headline. Guards against a swapped topic. */
function titleStillOnTopic(aiTitle, cluster) {
  const anchor = titleTokens(representativeItem(cluster).title);
  const proposed = titleTokens(aiTitle);
  if (!anchor.size || !proposed.size) return false;
  let overlap = 0;
  for (const t of proposed) if (anchor.has(t)) overlap++;
  return overlap / Math.min(anchor.size, proposed.size) >= 0.2;
}

/** Deterministic "already used" guard: if `base` collides with something
 * already assigned this run, append the smallest integer suffix that clears
 * it. Returns `base` unchanged when there's no collision, so a normal id/slug
 * is never perturbed — this only ever fires on an actual collision. */
function withUniqueSuffix(base, used) {
  if (!used.has(base)) return base;
  let n = 2;
  while (used.has(`${base}-${n}`)) n++;
  return `${base}-${n}`;
}

/**
 * Write the editorial fields for one lane's ranked clusters, then assemble
 * full NewsStory objects. `ranked` is the output of rankAndSelect: [{cluster,
 * trendScore}]. Returns [] (never throws) if the AI stage produces nothing —
 * callers treat that as "leave the lane's previously published feed alone".
 *
 * `previousStories` is the lane's currently-published stories (or []) — used
 * only to give a continuing story the same id/slug it already has (see
 * matchPreviousStory in news-sources.mjs). A brand-new story gets a fresh id
 * anchored on its earliest-known source, never on whichever source happens to
 * have the highest authority this run (that anchor moves whenever a bigger
 * outlet picks the story up later, which broke id stability across reruns).
 *
 * Identity resolution (which cluster inherits which previous story's id/slug,
 * and what a brand-new cluster mints instead) is done in a separate,
 * deterministic pass, walked in this lane's own ranked order — never the
 * model's response order. This matters because a previously published story
 * can split: its sources spread across two of this run's clusters (a story
 * fragments into two angles, or dedupe/clustering draws the boundary
 * differently this run). Each previous story is claimed by at most one
 * current cluster; once claimed it's removed from the pool, so the second
 * cluster always mints a fresh id instead of colliding with the first. A
 * final uniqueness guard also catches the (vanishingly rare, but checked
 * anyway) case of a genuine id-hash or slug collision between two of this
 * run's own clusters, without ever perturbing an id/slug validly inherited
 * from the previous publish.
 *
 * `callJsonFn` defaults to the real backend-selecting callJson from ai.mjs but
 * is injectable so tests can exercise the guardrails below (hallucinated
 * clusterId, duplicate clusterId, off-topic title, fabricated fields the
 * schema doesn't even have room for) against a scripted model response, with
 * no network and no key.
 */
export async function writeLaneStories(lane, ranked, { generatedAt, slugify, stableId, previousStories = [], callJsonFn = callJson }) {
  if (ranked.length === 0) return [];

  const system = `${LANE_GUIDANCE[lane] ?? LANE_GUIDANCE.tech}\n\n${GROUNDING_RULES}`;
  const prompt = `Write ${ranked.length} stories for the ${lane} lane.\n\n${JSON.stringify(
    ranked.map(({ cluster, trendScore }) => ({
      clusterId: cluster.id,
      representativeTitle: representativeItem(cluster).title,
      trendScore,
      sources: sourcesForCluster(cluster).map(s => ({ title: s.title, publisher: s.publisher, publishedAt: s.publishedAt })),
    })),
    null,
    1,
  )}`;

  const result = await callJsonFn({ system, prompt, schema: NEWS_STORY_SCHEMA, maxTokens: 8000, effort: 'medium' });
  if (!result?.stories?.length) return [];

  const byClusterId = new Map(ranked.map(r => [r.cluster.id, r]));
  const rankedIndex = new Map(ranked.map((r, i) => [r.cluster.id, i]));
  const consumedClusterIds = new Set();
  const entries = [];

  for (const s of result.stories) {
    const entry = byClusterId.get(s.clusterId);
    if (!entry) continue; // hallucinated clusterId — drop it, never guess which real one was meant
    if (consumedClusterIds.has(s.clusterId)) continue; // duplicate valid clusterId — a cluster is published once
    consumedClusterIds.add(s.clusterId);

    const { cluster, trendScore, confidence } = entry;
    const rep = representativeItem(cluster);
    const proposedTitle = String(s.title ?? '').trim();
    const title = proposedTitle && titleStillOnTopic(proposedTitle, cluster) ? proposedTitle : rep.title;

    const sources = sourcesForCluster(cluster); // reconstructed from our own fetch, never from the model
    const publishedAt =
      sources.reduce((earliest, src) => {
        if (!src.publishedAt) return earliest;
        return !earliest || Date.parse(src.publishedAt) < Date.parse(earliest) ? src.publishedAt : earliest;
      }, null) ?? null;

    const badge = String(s.badge ?? '').trim().slice(0, 24);

    entries.push({ s, cluster, trendScore, confidence, title, sources, publishedAt, badge });
  }

  // Identity resolution — deterministic order (this lane's own ranking),
  // independent of the order `entries` happens to be in.
  const orderedForIdentity = [...entries].sort(
    (a, b) => rankedIndex.get(a.cluster.id) - rankedIndex.get(b.cluster.id),
  );

  const claimedPreviousIds = new Set();
  const usedIds = new Set();
  const usedSlugs = new Set();
  const identityByClusterId = new Map();

  for (const entry of orderedForIdentity) {
    const availablePrevious = previousStories.filter(p => p?.id && !claimedPreviousIds.has(p.id));
    const matched = matchPreviousStory(entry.cluster, availablePrevious);

    let id, slug;
    if (matched) {
      claimedPreviousIds.add(matched.id);
      id = matched.id;
      slug = matched.slug;
    } else {
      id = stableId(lane, anchorItem(entry.cluster).url);
      slug = slugify(entry.title);
    }

    id = withUniqueSuffix(id, usedIds);
    slug = withUniqueSuffix(slug, usedSlugs);
    usedIds.add(id);
    usedSlugs.add(slug);

    identityByClusterId.set(entry.cluster.id, { id, slug });
  }

  return entries.map(entry => {
    const { id, slug } = identityByClusterId.get(entry.cluster.id);
    return {
      id,
      slug,
      lane,
      title: entry.title,
      summary: String(entry.s.summary ?? '').trim(),
      whyItMatters: String(entry.s.whyItMatters ?? '').trim(),
      whatToWatch: sanitizeList(entry.s.whatToWatch, { max: 4 }),
      questions: sanitizeList(entry.s.questions, { max: 3 }),
      sources: entry.sources,
      sourceCount: distinctPublisherCount(entry.cluster),
      publishedAt: entry.publishedAt,
      updatedAt: generatedAt,
      ...(imageForCluster(entry.cluster) ? { imageUrl: imageForCluster(entry.cluster) } : {}),
      ...(entry.badge ? { badge: entry.badge } : {}),
      trendScore: entry.trendScore,
      confidence: entry.confidence,
    };
  });
}
