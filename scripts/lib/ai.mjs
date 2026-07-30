/**
 * The AI layer of the shared backend. This is the whole point of the
 * architecture: one run here, server-side, on one API key, and every AI Trend
 * install reads the result. The app's own BYOK key is reserved for things that
 * are personal (a deep dive, a "why this matters to me") or urgent (ad-hoc
 * research before the next cron tick).
 *
 * Three calls per aggregation run:
 *   1. curate  — batched. Per item: keep/drop, one-line TL;DR, why it matters,
 *                category, importance. This is where most tokens go.
 *   2. brief   — one call over the kept items. Headline, framing, clusters.
 *   3. radar   — one call. Extracts model releases for models/radar.json.
 *
 * Model: claude-opus-5. Override with AGGREGATOR_MODEL if you want to trade
 * quality for spend — see README.
 */
import Anthropic from '@anthropic-ai/sdk';

const MODEL = process.env.AGGREGATOR_MODEL || 'claude-opus-5';
const CURATION_BATCH_SIZE = 20;

/** Server-side refusal fallback. Opus 5's safety classifiers can decline a
 * request (HTTP 200, stop_reason "refusal") — AI-security stories are exactly
 * the kind of benign-adjacent content that occasionally trips them. "default"
 * routes by refusal category so we don't maintain a model list. */
const FALLBACK_BETA = 'server-side-fallback-2026-07-01';

const client = new Anthropic();

/** Accumulated across every call in a run; written into the digest's `cost`. */
export const usage = { inputTokens: 0, outputTokens: 0, calls: 0, model: MODEL };

const PRICING = {
  // USD per 1M tokens. Opus 5 rates; edit if AGGREGATOR_MODEL points elsewhere.
  'claude-opus-5': { in: 5, out: 25 },
  'claude-sonnet-5': { in: 3, out: 15 },
  'claude-haiku-4-5': { in: 1, out: 5 },
};

export function estimateUsd() {
  const p = PRICING[MODEL] ?? PRICING['claude-opus-5'];
  return (usage.inputTokens / 1e6) * p.in + (usage.outputTokens / 1e6) * p.out;
}

const CATEGORIES = [
  'open-models',
  'closed-models',
  'agentic',
  'adoption',
  'tooling',
  'research',
  'use-cases',
  'business',
];

/**
 * Who this digest is for. Written once, here, so every call shares it — and so
 * the editorial voice is reviewable in one place rather than smeared across
 * three prompts.
 */
const AUDIENCE = `The reader is a software development director and entrepreneur who ships production applications on top of multiple AI models — open-weight and closed, self-hosted and API. They care about:

- Open vs closed model releases: capability, license, context window, price, and whether it's actually usable in a product.
- Agentic orchestration: multi-agent topologies, handoffs, tool/MCP ecosystems, evals, cost and latency control, failure modes at scale.
- Adoption and real use cases: what teams are actually shipping and what broke.
- Discussion worth reading: substantive practitioner argument, not press-release chatter.

They are technical. Do not explain what an LLM is. Do not hedge. They read this once a day, on a phone, and need to know what changed and whether it affects what they are building.`;

/**
 * One shared JSON-schema helper. Structured outputs reject the numeric/string
 * constraint keywords (minimum, maxLength, …) and require additionalProperties
 * false plus a complete `required` list on every object — so build objects here
 * rather than hand-writing each schema and tripping over it.
 */
function obj(properties) {
  return {
    type: 'object',
    properties,
    required: Object.keys(properties),
    additionalProperties: false,
  };
}

const strArray = { type: 'array', items: { type: 'string' } };

const CURATION_SCHEMA = obj({
  items: {
    type: 'array',
    items: obj({
      id: { type: 'string' },
      keep: { type: 'boolean' },
      tldr: { type: 'string' },
      whyItMatters: { type: 'string' },
      category: { type: 'string', enum: CATEGORIES },
      tags: strArray,
      entities: strArray,
      models: strArray,
      importance: { type: 'integer', enum: [1, 2, 3, 4, 5] },
    }),
  },
});

const BRIEF_SCHEMA = obj({
  headline: { type: 'string' },
  summary: { type: 'string' },
  bullets: strArray,
  signals: {
    type: 'array',
    items: obj({
      label: { type: 'string' },
      direction: { type: 'string', enum: ['up', 'down', 'flat'] },
      note: { type: 'string' },
    }),
  },
  clusters: {
    type: 'array',
    items: obj({
      title: { type: 'string' },
      summary: { type: 'string' },
      itemIds: strArray,
    }),
  },
});

const RADAR_SCHEMA = obj({
  models: {
    type: 'array',
    items: obj({
      id: { type: 'string' },
      name: { type: 'string' },
      vendor: { type: 'string' },
      openness: { type: 'string', enum: ['open-weights', 'open-source', 'closed', 'unknown'] },
      license: { type: 'string' },
      // Strings, not integers: structured outputs can't express "integer or
      // null", and "unknown" is a real and common answer here.
      contextTokens: { type: 'string' },
      status: { type: 'string', enum: ['current', 'preview', 'deprecated', 'rumored'] },
      what: { type: 'string' },
      url: { type: 'string' },
    }),
  },
});

/**
 * One structured call. Returns the validated object, or null if the model
 * refused (after the server-side fallback also declined) — callers treat null
 * as "this stage produced nothing" and carry on.
 *
 * `effort` is a real quality knob, so it's set per call site rather than
 * globally: curation is bulk classification, the brief is the editorial work.
 */
async function callJson({ system, prompt, schema, maxTokens = 16000, effort = 'high' }) {
  const supportsFallback = MODEL === 'claude-opus-5';
  const res = await client.beta.messages.create({
    model: MODEL,
    max_tokens: maxTokens,
    ...(supportsFallback ? { betas: [FALLBACK_BETA], fallbacks: 'default' } : {}),
    system,
    output_config: { format: { type: 'json_schema', schema }, effort },
    messages: [{ role: 'user', content: prompt }],
  });

  usage.calls += 1;
  usage.inputTokens += res.usage?.input_tokens ?? 0;
  usage.outputTokens += res.usage?.output_tokens ?? 0;

  // Check stop_reason before touching content: on a refusal `content` is empty
  // (pre-output) or a partial we must discard, and indexing it would throw.
  if (res.stop_reason === 'refusal') {
    console.warn(`  ! model refused (${res.stop_details?.category ?? 'unknown'}) — skipping stage`);
    return null;
  }
  if (res.stop_reason === 'max_tokens') {
    console.warn('  ! hit max_tokens — output truncated, skipping stage');
    return null;
  }

  const text = res.content.find(b => b.type === 'text')?.text;
  if (!text) return null;
  try {
    return JSON.parse(text);
  } catch (err) {
    console.warn(`  ! unparseable JSON despite schema: ${err.message}`);
    return null;
  }
}

/** Trim a raw item down to what the model needs, to keep input tokens honest. */
function itemForPrompt(item) {
  return {
    id: item.id,
    title: item.title,
    source: item.source,
    kind: item.sourceKind,
    publishedAt: item.publishedAt,
    engagement: item.score ?? 0,
    snippet: (item.snippet || '').slice(0, 700),
  };
}

/**
 * Stage 1 — curate. Batched at CURATION_BATCH_SIZE so one bad batch costs one
 * batch, and so we stay well inside the context window on a heavy news day.
 * Batches run sequentially: this is a cron job, not an interactive request, and
 * serial keeps us clear of rate limits on a shared org key.
 */
export async function curateItems(items, { query = null } = {}) {
  const system = `You are the editor of a daily AI-trends digest.

${AUDIENCE}

For each item you are given, decide whether it belongs in the digest, then describe it.

Rules:
- keep: false for press releases with no substance, funding announcements with no product, listicles, SEO spam, duplicate coverage of something else in the batch, and anything that is not actually about AI models, AI adoption, or AI engineering. Be a harsh editor — most of a raw feed is noise. Dropping half the batch is a normal outcome.
- tldr: ONE sentence. What happened. No preamble, no "This article discusses". Present tense.
- whyItMatters: at most two sentences, aimed squarely at the reader described above. Say what it changes for someone building on these models. If it genuinely doesn't matter to them, set keep: false instead of writing filler.
- importance: 5 = drop what you're doing (a major model shipped, a license changed, something you depend on broke). 4 = read today. 3 = worth knowing. 2 = skim. 1 = marginal.
- models: only concrete model names actually involved ("Hermes 4", "Claude Opus 5"). Empty array if none.
- entities: organizations, labs, or projects. Empty array if none.
- tags: 2-4 lowercase keywords.
- Ground everything in the title and snippet you are given. Do not invent version numbers, benchmark figures, or dates that aren't there.
- Return every id you were given, including the ones you drop.`;

  const kept = [];
  const batches = [];
  for (let i = 0; i < items.length; i += CURATION_BATCH_SIZE) {
    batches.push(items.slice(i, i + CURATION_BATCH_SIZE));
  }

  console.log(`Curating ${items.length} items in ${batches.length} batch(es)…`);

  for (const [i, batch] of batches.entries()) {
    const focus = query
      ? `\n\nThis is an on-demand run focused on: "${query}". Weight importance toward items relevant to that focus, but do not keep irrelevant items just to fill space.`
      : '';
    const prompt = `Curate these ${batch.length} items.${focus}\n\n${JSON.stringify(batch.map(itemForPrompt), null, 1)}`;

    // Bulk classification against supplied text — medium effort is the right
    // depth here, and it keeps the per-run bill sane on the heaviest stage.
    const result = await callJson({
      system,
      prompt,
      schema: CURATION_SCHEMA,
      effort: 'medium',
    });
    if (!result?.items) {
      console.warn(`  ! batch ${i + 1}/${batches.length} produced nothing`);
      continue;
    }

    const byId = new Map(batch.map(it => [it.id, it]));
    let keptInBatch = 0;
    for (const verdict of result.items) {
      if (!verdict.keep) continue;
      const raw = byId.get(verdict.id);
      if (!raw) continue; // hallucinated id — drop it
      keptInBatch += 1;
      kept.push({
        id: raw.id,
        title: raw.title,
        url: raw.url,
        source: raw.source,
        sourceKind: raw.sourceKind,
        publishedAt: raw.publishedAt,
        tldr: verdict.tldr,
        whyItMatters: verdict.whyItMatters,
        category: verdict.category,
        tags: verdict.tags ?? [],
        entities: verdict.entities ?? [],
        models: verdict.models ?? [],
        importance: verdict.importance ?? 2,
        ...(raw.discussionUrl ? { discussionUrl: raw.discussionUrl } : {}),
        ...(raw.score ? { score: raw.score } : {}),
      });
    }
    console.log(`  batch ${i + 1}/${batches.length}: kept ${keptInBatch}/${batch.length}`);
  }

  kept.sort((a, b) => b.importance - a.importance || (b.score ?? 0) - (a.score ?? 0));
  return kept;
}

/**
 * Stage 2 — write the brief. The editorial call, and the thing the reader
 * actually opens the app for, so it runs at full effort.
 */
export async function writeBrief(items, { query = null, windowHours = 36 } = {}) {
  if (items.length === 0) return null;

  const system = `You write the daily brief at the top of an AI-trends app.

${AUDIENCE}

You are given the curated items for this cycle. Write the brief.

- headline: under 70 characters. The single most consequential thing that happened. A statement, not a topic label — "Hermes 4 ships with native tool-calling", not "Open model news".
- summary: two short paragraphs. What moved and what it means for someone shipping on these models. Connect items where there's a real thread; do not manufacture one. Plain language, no bullet-speak, no "In the world of AI".
- bullets: 3-6 lines, one per thing that actually moved. Each line stands alone and names the specific thing. No trailing periods.
- signals: 2-4 directional reads on where things are heading, each grounded in the items — not vibes. direction is up/down/flat for that trend's momentum.
- clusters: group items that are genuinely about the same development. itemIds must be ids from the input. Omit items that don't cluster — a cluster of one is not a cluster. Return an empty array if nothing clusters.
- Ground every claim in the supplied items. No outside knowledge, no invented numbers.${query ? `\n- This run was triggered on demand with the focus: "${query}". Lead with that.` : ''}`;

  const prompt = `These are the curated items from the last ${windowHours} hours, highest importance first.\n\n${JSON.stringify(
    items.map(i => ({
      id: i.id,
      title: i.title,
      source: i.source,
      category: i.category,
      importance: i.importance,
      tldr: i.tldr,
      whyItMatters: i.whyItMatters,
      models: i.models,
      entities: i.entities,
    })),
    null,
    1,
  )}`;

  const brief = await callJson({ system, prompt, schema: BRIEF_SCHEMA, maxTokens: 12000 });
  if (!brief) return null;

  // Drop cluster references the model invented, and single-item clusters.
  const validIds = new Set(items.map(i => i.id));
  brief.clusters = (brief.clusters ?? [])
    .map((c, i) => ({
      id: `c${i + 1}`,
      title: c.title,
      summary: c.summary,
      itemIds: (c.itemIds ?? []).filter(id => validIds.has(id)),
    }))
    .filter(c => c.itemIds.length > 1);

  return brief;
}

/**
 * Stage 3 — extract model releases for the radar. Only called when the digest
 * actually contains model-shaped items, so a quiet day costs nothing here.
 */
export async function extractModelReleases(items) {
  const candidates = items.filter(
    i =>
      i.sourceKind === 'model' ||
      i.category === 'open-models' ||
      i.category === 'closed-models' ||
      (i.models?.length ?? 0) > 0,
  );
  if (candidates.length === 0) return [];

  const system = `You maintain a tracker of AI models — open-weight and closed.

Given today's items, extract ONLY genuine model releases, version bumps, or material changes to an existing model (license change, price change, deprecation, context-window change).

- Do not emit an entry for a model merely mentioned in passing, benchmarked by someone else, or discussed without a release.
- id: lowercase kebab-case, stable across runs ("hermes-4", "claude-opus-5", "qwen-3-72b").
- license: the actual license name if stated, otherwise "unknown".
- contextTokens: the number as a plain string with no separators ("131072"), or "unknown".
- what: one sentence on what shipped or changed.
- url: the most authoritative URL among the supplied items for this model.
- Return an empty array if nothing shipped. That is the common case and a correct answer.
- Never guess a spec. "unknown" is always better than a plausible number.`;

  const prompt = `Today's model-related items:\n\n${JSON.stringify(
    candidates.map(i => ({
      id: i.id,
      title: i.title,
      url: i.url,
      source: i.source,
      tldr: i.tldr,
      models: i.models,
      entities: i.entities,
    })),
    null,
    1,
  )}`;

  const result = await callJson({ system, prompt, schema: RADAR_SCHEMA, maxTokens: 8000 });
  return result?.models ?? [];
}
