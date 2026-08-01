#!/usr/bin/env node
/**
 * AI Trend — multi-lane news aggregator.
 *
 * Separate entry point from scripts/aggregate.mjs (the single AI-trend
 * digest) but wired into the same GitHub Actions run: a scheduled tick
 * produces the digest, then this, then both get committed together. See
 * .github/workflows/aggregate.yml.
 *
 * Per lane (crypto, markets, ai, tech):
 *   1. fetch every configured source (fail-soft, reused from sources.mjs)
 *   2. dedupe exact/canonical duplicates
 *   3. cluster related reporting by deterministic title/entity similarity
 *   4. rank clusters deterministically (freshness, diversity, authority,
 *      relevance, velocity) and keep the top 8-12
 *   5. one AI call writes summary/whyItMatters/whatToWatch/questions,
 *      grounded strictly in the clusters selected above
 *
 * A lane that fails or fetches nothing is skipped — its previously published
 * feed is left exactly as it was, and every other lane still publishes.
 *
 * Usage:
 *   node scripts/aggregate-news.mjs                 # full run, all lanes
 *   node scripts/aggregate-news.mjs --dry-run        # fetch+rank only, no AI, no writes
 *   node scripts/aggregate-news.mjs --window-hours 72
 *   node scripts/aggregate-news.mjs --lanes crypto,tech
 *
 * Requires ANTHROPIC_API_KEY unless --dry-run (same api/cli backend
 * auto-selection as aggregate.mjs — see scripts/lib/ai.mjs).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';
import {
  collectLane,
  rankAndSelect,
  representativeItem,
  distinctPublisherCount,
  hydrateRankedImages,
} from './lib/news-sources.mjs';
import { writeLaneStories } from './lib/news-ai.mjs';
import { usage, estimateUsd } from './lib/ai.mjs';
import { publishNewsLanes, NEWS_LANES, paths, readLaneFeed } from './lib/store.mjs';

function arg(name, fallback = null) {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] && !process.argv[i + 1].startsWith('--')
    ? process.argv[i + 1]
    : fallback;
}
const flag = name => process.argv.includes(`--${name}`);

const dryRun = flag('dry-run');
const windowHours = Number(arg('window-hours', '48'));
const maxPerLane = Number(arg('max-per-lane', '12'));
const triggeredBy = arg('triggered-by', 'cron');
const requestedLanes = (arg('lanes', '') || '')
  .split(',')
  .map(s => s.trim())
  .filter(Boolean);
const lanesToRun = requestedLanes.length ? requestedLanes.filter(l => NEWS_LANES.includes(l)) : NEWS_LANES;

function slugify(text) {
  return String(text)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 70);
}

/** Fresh-story id generator. Only ever called with a story's earliest-known
 * source URL (see anchorItem in news-sources.mjs) — never the current
 * highest-authority one, which would change (and mint a new id) whenever a
 * bigger outlet picked the story up later. A continuing story instead reuses
 * its previous id/slug via matchPreviousStory; this only mints an id the
 * first time a story is ever published. */
function stableId(lane, url) {
  const hash = createHash('sha1').update(String(url)).digest('hex').slice(0, 10);
  return `${lane}-${hash}`;
}

function tutorialStoriesFor(lane, generatedAt) {
  try {
    const config = JSON.parse(readFileSync(join(paths.ROOT, 'config', 'tutorials.json'), 'utf8'));
    return (config.tutorials ?? [])
      .filter(story => story.lane === lane)
      .map(story => ({ ...story, updatedAt: generatedAt }));
  } catch (err) {
    console.warn(`  ! tutorials: ${err?.message || err}`);
    return [];
  }
}

async function main() {
  const startedAt = new Date();
  const generatedAt = startedAt.toISOString();
  const sinceMs = startedAt.getTime() - windowHours * 3600_000;
  const windowMs = windowHours * 3600_000;

  const config = JSON.parse(readFileSync(join(paths.ROOT, 'config', 'news-sources.json'), 'utf8'));

  console.log('AI Trend news aggregator');
  console.log(`  lanes:    ${lanesToRun.join(', ')}`);
  console.log(`  window:   ${windowHours}h`);
  console.log(
    `  model:    ${usage.model}${dryRun ? ' (dry run — no AI calls)' : ` via ${usage.backend}${usage.backend === 'cli' ? ' (your logged-in session, not an API key)' : ''}`}`,
  );
  console.log('');

  const laneFeeds = {};

  for (const lane of lanesToRun) {
    const laneConfig = config.lanes?.[lane];
    if (!laneConfig) {
      console.log(`  ${lane}: not configured in config/news-sources.json, skipping`);
      continue;
    }

    try {
      const clusters = await collectLane(lane, laneConfig, sinceMs);
      console.log(`  ${lane}: ${clusters.length} cluster(s) after dedupe + clustering`);

      if (clusters.length === 0) {
        console.log(`  ${lane}: no candidates this window — leaving the published feed untouched`);
        continue;
      }

      const ranked = rankAndSelect(clusters, { keywords: laneConfig.keywords ?? [], now: startedAt.getTime(), windowMs, max: maxPerLane });

      if (dryRun) {
        console.log(`  --- ${lane}: top ${ranked.length} candidate(s) ---`);
        for (const { cluster, trendScore, confidence } of ranked) {
          const rep = representativeItem(cluster);
          console.log(`    [${trendScore}/${confidence}] (${distinctPublisherCount(cluster)} src) ${rep.title.slice(0, 90)}`);
        }
        continue;
      }

      await hydrateRankedImages(ranked);
      const previousStories = readLaneFeed(lane)?.stories ?? [];
      const generatedStories = await writeLaneStories(lane, ranked, { generatedAt, slugify, stableId, previousStories });
      const tutorials = tutorialStoriesFor(lane, generatedAt);
      const stories = [...tutorials, ...generatedStories]
        .filter((story, index, all) => all.findIndex(candidate => candidate.id === story.id) === index)
        .slice(0, Math.max(maxPerLane, tutorials.length));
      if (stories.length === 0) {
        console.log(`  ${lane}: AI stage produced nothing — leaving the published feed untouched`);
        continue;
      }

      laneFeeds[lane] = { lane, generatedAt, stories };
      console.log(`  ${lane}: ${stories.length} stor${stories.length === 1 ? 'y' : 'ies'} written`);
    } catch (err) {
      // One lane's exception must never take down the others or the digest
      // that already ran earlier in this same workflow step.
      console.warn(`  ! ${lane} failed entirely: ${err?.stack || err} — leaving the published feed untouched`);
    }
  }

  if (dryRun) {
    console.log('\nDry run — no AI calls, nothing written.');
    return;
  }

  if (Object.keys(laneFeeds).length === 0) {
    console.log('\nNo lane produced stories this run. Nothing to publish.');
    return;
  }

  const result = publishNewsLanes(laneFeeds, generatedAt);

  console.log('\n--- published ---');
  for (const [lane, entry] of Object.entries(result.lanes)) {
    console.log(`  news/lanes/${lane}.json  (contentVersion ${entry.contentVersion}, ${entry.storyCount} stories)`);
  }
  console.log(`  news/frontpage.json  (contentVersion ${result.frontPage.contentVersion})`);
  console.log(`  AI spend:  $${estimateUsd().toFixed(4)} over ${usage.calls} call(s), triggered by ${triggeredBy}`);
  console.log('\nCommit and push to publish. Every install reads this one run.');
}

main().catch(err => {
  console.error(`\nNews aggregation failed: ${err?.stack || err}`);
  process.exit(1);
});
