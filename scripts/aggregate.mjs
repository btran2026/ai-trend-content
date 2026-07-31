#!/usr/bin/env node
/**
 * AI Trend — shared aggregator.
 *
 * Runs on GitHub Actions (cron, or admin-triggered from the app via
 * repository_dispatch), fetches every source, has AI curate and write the
 * brief, and commits the result. GitHub Pages serves it; every AI Trend install
 * polls the manifest and imports what's new.
 *
 * One run, one bill, every reader.
 *
 * Usage:
 *   node scripts/aggregate.mjs                                  # scheduled run
 *   node scripts/aggregate.mjs --mode on-demand --query "openclaw"
 *   node scripts/aggregate.mjs --window-hours 72 --max-items 80
 *   node scripts/aggregate.mjs --dry-run                         # fetch only, no AI, no writes
 *
 * Requires ANTHROPIC_API_KEY unless --dry-run. GITHUB_TOKEN is optional but
 * raises the GitHub search rate limit from 60/h to 5000/h.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { fetchAll, preRank } from './lib/sources.mjs';
import { curateItems, writeBrief, extractModelReleases, usage, estimateUsd } from './lib/ai.mjs';
import { publishDigest, mergeRadar, paths } from './lib/store.mjs';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback;
}
const flag = name => process.argv.includes(`--${name}`);

const mode = arg('mode', 'scheduled');
const query = arg('query');
const triggeredBy = arg('triggered-by', mode === 'on-demand' ? 'admin' : 'cron');
const dryRun = flag('dry-run');

// A scheduled run looks back far enough to survive one skipped tick; on-demand
// runs default wider because the admin is usually chasing something specific.
const windowHours = Number(arg('window-hours', mode === 'on-demand' ? '72' : '36'));
// Cap on how many items reach the AI. The pre-ranker decides which ones.
const maxItems = Number(arg('max-items', '70'));

function slug(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 40);
}

async function main() {
  // Every timestamp in the digest comes from this one value, so the whole run
  // is internally consistent even if it takes minutes.
  const startedAt = new Date();
  const generatedAt = startedAt.toISOString();

  const id =
    mode === 'on-demand'
      ? `ondemand-${Math.floor(startedAt.getTime() / 1000)}${query ? `-${slug(query)}` : ''}`
      : generatedAt.slice(0, 10);

  console.log(`AI Trend aggregator`);
  console.log(`  mode:     ${mode}${query ? ` (query: "${query}")` : ''}`);
  console.log(`  digest:   ${id}`);
  console.log(`  window:   ${windowHours}h`);
  console.log(
    `  model:    ${usage.model}${dryRun ? ' (dry run — no AI calls)' : ` via ${usage.backend}${usage.backend === 'cli' ? ' (your logged-in session, not an API key)' : ''}`}`,
  );
  console.log('');

  const config = JSON.parse(readFileSync(join(paths.ROOT, 'config', 'sources.json'), 'utf8'));
  const sinceMs = startedAt.getTime() - windowHours * 3600_000;

  // An on-demand run with a query folds it into the keyword set so the
  // pre-ranker surfaces relevant items even when engagement is low.
  const keywords = query ? [...(config.keywords ?? []), query] : config.keywords ?? [];

  const raw = await fetchAll({ ...config, keywords }, sinceMs);
  if (raw.length === 0) {
    console.log('\nNo items fetched. Nothing to publish.');
    return;
  }

  const candidates = preRank(raw, keywords, maxItems);
  if (candidates.length < raw.length) {
    // Be explicit about the cap — a silent truncation reads as "we covered
    // everything" when we didn't.
    console.log(`  pre-ranked to top ${candidates.length} of ${raw.length} for AI curation`);
  }

  if (dryRun) {
    console.log('\n--- dry run: top 20 candidates ---');
    for (const item of candidates.slice(0, 20)) {
      console.log(`  [${item.sourceKind}] ${item.source}: ${item.title.slice(0, 90)}`);
    }
    console.log(`\n${candidates.length} candidates would be sent to ${usage.model}.`);
    return;
  }

  console.log('');
  const items = await curateItems(candidates, { query });
  if (items.length === 0) {
    console.log('\nCuration kept nothing. Not publishing an empty digest.');
    return;
  }
  console.log(`  → kept ${items.length} items`);

  console.log('\nWriting brief…');
  const brief = await writeBrief(items, { query, windowHours });
  if (!brief) {
    console.log('Brief generation failed. Not publishing — a digest without a brief is useless.');
    return;
  }
  console.log(`  → "${brief.headline}"`);

  console.log('\nUpdating model radar…');
  const releases = await extractModelReleases(items);
  const touched = mergeRadar(releases, generatedAt);
  console.log(`  → ${releases.length} release(s) extracted, ${touched} radar entr(ies) updated`);

  const clusterIds = new Set((brief.clusters ?? []).flatMap(c => c.itemIds));
  const digest = {
    id,
    kind: mode === 'on-demand' ? 'on-demand' : 'scheduled',
    generatedAt,
    triggeredBy,
    query: query ?? null,
    windowHours,
    brief: {
      headline: brief.headline,
      summary: brief.summary,
      bullets: brief.bullets ?? [],
      signals: brief.signals ?? [],
    },
    items,
    clusters: brief.clusters ?? [],
    cost: {
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      usd: Number(estimateUsd().toFixed(4)),
      model: usage.model,
      calls: usage.calls,
      // `subscription` means usd is what this would have cost at API rates, not
      // what it charged — the run went through a logged-in CLI session.
      billing: usage.backend === 'cli' ? 'subscription' : 'api',
    },
  };

  const { contentVersion, isLatest } = publishDigest(digest);

  console.log('\n--- published ---');
  console.log(`  digests/${id}.json  (contentVersion ${contentVersion})`);
  console.log(`  items:     ${items.length}, in ${clusterIds.size ? `${brief.clusters.length} cluster(s)` : 'no clusters'}`);
  console.log(`  latest:    ${isLatest ? 'yes — this is what "Today" will show' : 'no (a newer digest exists)'}`);
  console.log(`  AI spend:  $${digest.cost.usd} over ${usage.calls} call(s)`);
  console.log(`             ${usage.inputTokens} in / ${usage.outputTokens} out tokens`);
  console.log('\nCommit and push to publish. Every install reads this one run.');
}

main().catch(err => {
  console.error(`\nAggregation failed: ${err?.stack || err}`);
  process.exit(1);
});
