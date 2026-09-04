#!/usr/bin/env node
/**
 * Seed state/published.json from the digests already on disk.
 *
 * The published-memory index went in after 20 dated digests had already shipped.
 * Without this, the first run with the filter on sees an empty memory and
 * happily re-serves everything those 20 digests already carried.
 *
 * Idempotent: recordPublished keys on the canonical URL, so running this twice
 * only bumps timesPublished. Safe to re-run after a manual edit.
 *
 * Usage:
 *   node scripts/backfill-published.mjs
 *   node scripts/backfill-published.mjs --dry-run
 */
import { readPublishedIndex, recordPublished, readDigest, listDigestFiles } from './lib/store.mjs';

const dryRun = process.argv.includes('--dry-run');

// Oldest first, so firstSeenIn points at the digest that actually broke a story
// rather than the most recent one to repeat it.
const ids = listDigestFiles()
  .map(f => f.replace(/\.json$/, ''))
  .reverse();

console.log(`Seeding published memory from ${ids.length} digest(s)\n`);

let totalItems = 0;
let totalNew = 0;

for (const id of ids) {
  const digest = readDigest(id);
  const items = digest?.items ?? [];
  if (items.length === 0) {
    console.log(`  ${id}: no items, skipped`);
    continue;
  }
  totalItems += items.length;

  if (dryRun) {
    console.log(`  ${id}: ${items.length} item(s) would be recorded`);
    continue;
  }

  // Each digest's own generatedAt, not now() — retention prunes on first-seen
  // date, and stamping everything with today would keep dead stories alive for
  // another 45 days.
  const added = recordPublished(items, id, digest.generatedAt);
  totalNew += added;
  console.log(`  ${id}: ${items.length} item(s), ${added} new`);
}

if (dryRun) {
  console.log(`\nDry run. ${totalItems} item(s) across ${ids.length} digest(s).`);
} else {
  const index = readPublishedIndex();
  console.log(`\n${totalItems} item(s) read, ${totalNew} unique recorded.`);
  console.log(`state/published.json now holds ${index.entries.length} entr(ies).`);
  console.log('\nCommit it. The next scheduled run will skip every one of them.');
}
