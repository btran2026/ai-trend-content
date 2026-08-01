import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { join, dirname } from 'node:path';
import {
  dedupeExact,
  clusterItems,
  representativeItem,
  representativeTitle,
  sourcesForCluster,
  trendScoreFor,
  confidenceFor,
  rankAndSelect,
  distinctPublisherCount,
  anchorItem,
  clusterUrlKeys,
  matchPreviousStory,
  filterNoise,
} from '../scripts/lib/news-sources.mjs';

const HOUR = 3600_000;
const now = Date.parse('2026-08-01T00:00:00.000Z');
const iso = ms => new Date(now - ms).toISOString();

function item(overrides = {}) {
  return {
    id: overrides.id ?? 'x',
    title: 'Fed holds interest rates steady',
    url: 'https://example.com/fed-holds-rates',
    source: 'Example Wire',
    sourceKind: 'news',
    publishedAt: iso(HOUR),
    snippet: '',
    score: 0,
    authority: 3,
    ...overrides,
  };
}

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
function laneSourcesConfig() {
  return JSON.parse(readFileSync(join(REPO_ROOT, 'config', 'news-sources.json'), 'utf8'));
}


describe('dedupeExact', () => {
  test('folds exact/canonical URL duplicates into the richer copy', () => {
    const a = item({ id: 'a', url: 'https://example.com/story?utm_source=x', authority: 3, score: 10 });
    const b = item({ id: 'b', url: 'https://www.example.com/story/', authority: 5, score: 2 });
    const out = dedupeExact([a, b]);
    assert.equal(out.length, 1);
    assert.equal(out[0].id, 'b'); // higher authority wins
  });

  test('keeps distinct URLs distinct', () => {
    const a = item({ id: 'a', url: 'https://example.com/one' });
    const b = item({ id: 'b', url: 'https://example.com/two' });
    assert.equal(dedupeExact([a, b]).length, 2);
  });

  test('is deterministic regardless of input order', () => {
    const a = item({ id: 'a', url: 'https://example.com/story', authority: 3, score: 10 });
    const b = item({ id: 'b', url: 'https://example.com/story', authority: 3, score: 20 });
    const first = dedupeExact([a, b]);
    const second = dedupeExact([b, a]);
    assert.equal(first[0].id, 'b');
    assert.equal(second[0].id, 'b');
  });
});

describe('clusterItems', () => {
  test('clusters near-identical titles about the same entity from different publishers', () => {
    const items = [
      item({ id: 'a', url: 'https://wire-a.com/bitcoin-etf', title: 'Bitcoin ETF sees record inflows this week', source: 'Wire A' }),
      item({ id: 'b', url: 'https://wire-b.com/bitcoin-etf', title: 'Bitcoin ETF sees record inflows amid rally', source: 'Wire B' }),
    ];
    const clusters = clusterItems(items);
    assert.equal(clusters.length, 1);
    assert.equal(clusters[0].items.length, 2);
  });

  test('keeps unrelated stories in separate clusters', () => {
    const items = [
      item({ id: 'a', url: 'https://wire-a.com/fed-rates', title: 'Fed holds interest rates steady', source: 'Wire A' }),
      item({ id: 'b', url: 'https://wire-b.com/bitcoin-etf', title: 'Bitcoin ETF sees record inflows', source: 'Wire B' }),
    ];
    const clusters = clusterItems(items);
    assert.equal(clusters.length, 2);
  });

  test('is deterministic regardless of fetch/array order', () => {
    const items = [
      item({ id: 'a', url: 'https://wire-a.com/bitcoin-etf', title: 'Bitcoin ETF sees record inflows this week', source: 'Wire A' }),
      item({ id: 'b', url: 'https://wire-b.com/bitcoin-etf', title: 'Bitcoin ETF sees record inflows amid rally', source: 'Wire B' }),
      item({ id: 'c', url: 'https://wire-c.com/fed-rates', title: 'Fed holds interest rates steady', source: 'Wire C' }),
    ];
    const first = clusterItems(items).map(c => c.items.length).sort();
    const second = clusterItems([...items].reverse()).map(c => c.items.length).sort();
    assert.deepEqual(first, second);
    assert.deepEqual(first, [1, 2]);
  });

  test('representativeItem picks the highest-authority, most-recent item', () => {
    const a = item({ id: 'a', url: 'https://wire-a.com/x', authority: 3, publishedAt: iso(2 * HOUR) });
    const b = item({ id: 'b', url: 'https://wire-b.com/x', authority: 5, publishedAt: iso(5 * HOUR) });
    const cluster = { items: [a, b] };
    assert.equal(representativeItem(cluster).id, 'b');
    assert.equal(representativeTitle(cluster), b.title);
  });

  test('sourcesForCluster reconstructs receipts straight from fetched items, newest first', () => {
    const a = item({ id: 'a', url: 'https://wire-a.com/x', publishedAt: iso(5 * HOUR), source: 'Wire A' });
    const b = item({ id: 'b', url: 'https://wire-b.com/x', publishedAt: iso(1 * HOUR), source: 'Wire B' });
    const sources = sourcesForCluster({ items: [a, b] });
    assert.deepEqual(
      sources.map(s => s.publisher),
      ['Wire B', 'Wire A'],
    );
    for (const s of sources) {
      assert.ok('title' in s && 'url' in s && 'publisher' in s && 'publishedAt' in s);
    }
  });
});

describe('deterministic ranking', () => {
  test('trendScoreFor rewards freshness, diversity, authority, relevance and velocity', () => {
    const stale = { items: [item({ publishedAt: iso(47 * HOUR), authority: 1, score: 0 })] };
    const fresh = { items: [item({ publishedAt: iso(HOUR), authority: 5, score: 500 })] };
    const windowMs = 48 * HOUR;
    const staleScore = trendScoreFor(stale, { now, windowMs, keywords: [] });
    const freshScore = trendScoreFor(fresh, { now, windowMs, keywords: [] });
    assert.ok(freshScore > staleScore, `expected fresh (${freshScore}) > stale (${staleScore})`);
  });

  test('trendScoreFor is a pure function of its inputs (same in, same out)', () => {
    const cluster = { items: [item({ publishedAt: iso(3 * HOUR), authority: 4, score: 80 })] };
    const opts = { now, windowMs: 48 * HOUR, keywords: ['fed', 'rates'] };
    const a = trendScoreFor(cluster, opts);
    const b = trendScoreFor(cluster, opts);
    assert.equal(a, b);
  });

  test('confidenceFor requires both source diversity and authority for "high"', () => {
    const single = { items: [item({ authority: 5 })] };
    const manyLowAuthority = {
      items: [
        item({ authority: 2, source: 'Wire A' }),
        item({ authority: 2, source: 'Wire B' }),
        item({ authority: 2, source: 'Wire C' }),
      ],
    };
    const manyHighAuthority = {
      items: [
        item({ authority: 4, source: 'Wire A' }),
        item({ authority: 4, source: 'Wire B' }),
        item({ authority: 5, source: 'Wire C' }),
      ],
    };
    assert.equal(confidenceFor(single), 'medium'); // authority alone: medium
    assert.equal(confidenceFor(manyLowAuthority), 'medium'); // count alone: medium
    assert.equal(confidenceFor(manyHighAuthority), 'high');
  });

  test('confidenceFor floors at "low" for a single thin source', () => {
    assert.equal(confidenceFor({ items: [item({ authority: 1 })] }), 'low');
  });

  test('regression: repeat coverage from ONE outlet must not count as multiple corroborating sources', () => {
    // Same publisher, e.g. three copies of one wire story picked up by an RSS
    // feed and again via Hacker News — this must stay "low"/"medium" exactly
    // like a single-item cluster, never "high", because there is still only
    // one independent outlet behind it.
    const sameOutletThrice = {
      items: [
        item({ authority: 2, source: 'Wire A' }),
        item({ authority: 2, source: 'Wire A' }),
        item({ authority: 2, source: 'wire a' }), // casing-only "different" source, still the same outlet
      ],
    };
    assert.equal(confidenceFor(sameOutletThrice), 'low');

    const sameOutletHighAuthority = {
      items: [
        item({ authority: 5, source: 'Wire A' }),
        item({ authority: 5, source: 'Wire A' }),
        item({ authority: 5, source: 'Wire A' }),
      ],
    };
    // High authority alone still only reaches "medium" — "high" additionally
    // requires >= 3 *distinct* publishers, which repeats of one outlet never satisfy.
    assert.equal(confidenceFor(sameOutletHighAuthority), 'medium');
  });

  test('rankAndSelect orders by trendScore desc, deterministically, and caps at max', () => {
    const clusters = [
      { id: 'cl-1', items: [item({ id: '1', publishedAt: iso(40 * HOUR), authority: 1, score: 0 })] },
      { id: 'cl-2', items: [item({ id: '2', publishedAt: iso(HOUR), authority: 5, score: 900 })] },
      { id: 'cl-3', items: [item({ id: '3', publishedAt: iso(2 * HOUR), authority: 4, score: 400 })] },
    ];
    const ranked = rankAndSelect(clusters, { keywords: [], now, windowMs: 48 * HOUR, max: 2 });
    assert.equal(ranked.length, 2);
    assert.equal(ranked[0].cluster.id, 'cl-2');
    assert.equal(ranked[1].cluster.id, 'cl-3');
  });

  test('rankAndSelect never invents a floor — returns fewer than max on a quiet lane', () => {
    const clusters = [{ id: 'cl-1', items: [item()] }];
    const ranked = rankAndSelect(clusters, { keywords: [], now, windowMs: 48 * HOUR, max: 12 });
    assert.equal(ranked.length, 1);
  });

  test('regression: trendScoreFor diversity/velocity are driven by distinct publishers, not raw item count', () => {
    const threeCopiesOneOutlet = {
      items: [
        item({ source: 'Wire A', score: 0, publishedAt: iso(HOUR) }),
        item({ source: 'Wire A', score: 0, publishedAt: iso(HOUR) }),
        item({ source: 'Wire A', score: 0, publishedAt: iso(HOUR) }),
      ],
    };
    const oneCopyOneOutlet = { items: [item({ source: 'Wire A', score: 0, publishedAt: iso(HOUR) })] };
    const threeDistinctOutlets = {
      items: [
        item({ source: 'Wire A', score: 0, publishedAt: iso(HOUR) }),
        item({ source: 'Wire B', score: 0, publishedAt: iso(HOUR) }),
        item({ source: 'Wire C', score: 0, publishedAt: iso(HOUR) }),
      ],
    };
    const opts = { now, windowMs: 48 * HOUR, keywords: [] };

    // Three same-outlet repeats must score identically to one copy — the
    // repeats bring zero additional corroboration signal.
    assert.equal(trendScoreFor(threeCopiesOneOutlet, opts), trendScoreFor(oneCopyOneOutlet, opts));
    // Three genuinely distinct outlets must outscore the repeats.
    assert.ok(
      trendScoreFor(threeDistinctOutlets, opts) > trendScoreFor(threeCopiesOneOutlet, opts),
      'three distinct publishers should score above three copies of one publisher',
    );
  });
});

describe('distinctPublisherCount', () => {
  test('counts unique, case-insensitively-normalized publishers, not raw items', () => {
    const cluster = {
      items: [
        item({ source: 'Wire A' }),
        item({ source: 'Wire A' }),
        item({ source: 'wire a' }), // same outlet, different casing
        item({ source: 'Wire B' }),
      ],
    };
    assert.equal(distinctPublisherCount(cluster), 2);
  });

  test('a single-item cluster has exactly one publisher', () => {
    assert.equal(distinctPublisherCount({ items: [item()] }), 1);
  });
});

describe('anchorItem', () => {
  test('picks the earliest-published item, not the highest-authority one', () => {
    const early = item({ id: 'early', authority: 1, publishedAt: iso(10 * HOUR), url: 'https://wire-a.com/x' });
    const laterHighAuthority = item({ id: 'later', authority: 5, publishedAt: iso(HOUR), url: 'https://wire-b.com/x' });
    const cluster = { items: [laterHighAuthority, early] };
    assert.equal(anchorItem(cluster).id, 'early');
  });

  test('ties on publishedAt break on canonical URL, deterministically', () => {
    const a = item({ id: 'a', publishedAt: iso(HOUR), url: 'https://z-wire.com/x' });
    const b = item({ id: 'b', publishedAt: iso(HOUR), url: 'https://a-wire.com/x' });
    assert.equal(anchorItem({ items: [a, b] }).id, 'b');
    assert.equal(anchorItem({ items: [b, a] }).id, 'b');
  });
});

describe('matchPreviousStory — id continuity across reruns', () => {
  function publishedStory(overrides = {}) {
    return {
      id: 'crypto-abc123',
      slug: 'bitcoin-etf-inflows',
      title: 'Bitcoin ETF sees record inflows',
      sources: [{ title: 'Bitcoin ETF sees record inflows', url: 'https://wire-a.com/bitcoin-etf', publisher: 'Wire A', publishedAt: iso(5 * HOUR) }],
      ...overrides,
    };
  }

  test('a source joining later still matches by the URLs already published, keeping the same id', () => {
    const previous = [publishedStory()];
    // This run's cluster: the original Wire A item is still present, PLUS a
    // brand-new, higher-authority Wire B item just picked the story up. Under
    // the old (buggy) design, the "representative" item — now Wire B, because
    // it has higher authority — would anchor a *new* stableId, breaking
    // continuity. matchPreviousStory must not care which item is highest
    // authority; any shared URL is enough.
    const cluster = clusterItems([
      item({ id: 'a', url: 'https://wire-a.com/bitcoin-etf', title: 'Bitcoin ETF sees record inflows', source: 'Wire A', authority: 2, publishedAt: iso(5 * HOUR) }),
      item({ id: 'b', url: 'https://wire-b.com/bitcoin-etf-2', title: 'Bitcoin ETF sees record inflows amid rally', source: 'Wire B', authority: 5, publishedAt: iso(HOUR) }),
    ])[0];

    const match = matchPreviousStory(cluster, previous);
    assert.ok(match);
    assert.equal(match.id, 'crypto-abc123');
    assert.equal(match.slug, 'bitcoin-etf-inflows');
  });

  test('an unrelated story never inherits a previous id', () => {
    const previous = [publishedStory()];
    const cluster = clusterItems([
      item({ id: 'c', url: 'https://wire-c.com/fed-rates', title: 'Fed holds interest rates steady', source: 'Wire C', authority: 3, publishedAt: iso(HOUR) }),
    ])[0];

    assert.equal(matchPreviousStory(cluster, previous), null);
  });

  test('falls back to a conservative title/entity match only when no URL overlaps', () => {
    const previous = [publishedStory({ sources: [{ title: 'Bitcoin ETF sees record inflows', url: 'https://wire-a.com/rolled-out-of-window', publisher: 'Wire A', publishedAt: iso(72 * HOUR) }] })];
    // No URL in common (the old source rolled out of the fetch window), but
    // the title/entity profile is a near-exact match.
    const cluster = clusterItems([
      item({ id: 'a', url: 'https://wire-d.com/bitcoin-etf-new', title: 'Bitcoin ETF sees record inflows again', source: 'Wire D', authority: 3, publishedAt: iso(HOUR) }),
    ])[0];

    const match = matchPreviousStory(cluster, previous);
    assert.ok(match);
    assert.equal(match.id, 'crypto-abc123');
  });

  test('refuses to guess when more than one previous story is a plausible title match', () => {
    const previous = [
      publishedStory({ id: 'crypto-1', slug: 's1', sources: [{ url: 'https://old-a.com/gone', publisher: 'Old A', title: 'x', publishedAt: null }], title: 'Bitcoin ETF sees record inflows' }),
      publishedStory({ id: 'crypto-2', slug: 's2', sources: [{ url: 'https://old-b.com/gone', publisher: 'Old B', title: 'x', publishedAt: null }], title: 'Bitcoin ETF sees record inflows today' }),
    ];
    const cluster = clusterItems([
      item({ id: 'a', url: 'https://wire-new.com/bitcoin-etf', title: 'Bitcoin ETF sees record inflows', source: 'Wire New', authority: 3, publishedAt: iso(HOUR) }),
    ])[0];

    assert.equal(matchPreviousStory(cluster, previous), null);
  });

  test('returns null when there is no previous story at all', () => {
    const cluster = clusterItems([item({ id: 'a', url: 'https://wire-a.com/x' })])[0];
    assert.equal(matchPreviousStory(cluster, []), null);
    assert.equal(matchPreviousStory(cluster, undefined), null);
  });
});

describe('clusterUrlKeys', () => {
  test('returns canonical URL keys, deduped, matching dedupeExact/dedupeKey semantics', () => {
    const cluster = clusterItems([
      item({ id: 'a', url: 'https://example.com/story?utm_source=x' }),
      item({ id: 'b', url: 'https://www.example.com/story/' }),
    ])[0];
    // Both items canonicalize to the same key, so clusterUrlKeys has exactly one entry.
    assert.equal(clusterUrlKeys(cluster).size, 1);
  });
});

describe('filterNoise — per-lane title noise filter, applied before clustering/ranking', () => {
  const quietLog = { log() {}, warn() {} }; // keep test output clean; behavior asserted on the return value

  test('is a no-op when a lane has no excludeTitlePatterns configured', () => {
    const items = [item({ id: 'a' }), item({ id: 'b', title: 'Something else entirely' })];
    assert.deepEqual(filterNoise(items, undefined, { lane: 'markets', log: quietLog }), items);
    assert.deepEqual(filterNoise(items, [], { lane: 'markets', log: quietLog }), items);
  });

  test('drops only titles matching a configured pattern, case-insensitively', () => {
    const items = [
      item({ id: 'a', title: 'Form 4 Acme Corp' }),
      item({ id: 'b', title: 'FORM 4: acme corp insider filing' }),
      item({ id: 'c', title: 'Fed holds interest rates steady' }),
    ];
    const kept = filterNoise(items, ['\\bform\\s+4\\b'], { lane: 'markets', log: quietLog });
    assert.deepEqual(kept.map(i => i.id), ['c']);
  });

  test('an invalid pattern (config typo) is skipped with a warning, never throws or drops the whole lane', () => {
    const items = [item({ id: 'a' })];
    let warned = false;
    const log = { log() {}, warn: () => { warned = true; } };
    const kept = filterNoise(items, ['(unclosed', 'never-matches-anything-xyz'], { lane: 'markets', log });
    assert.equal(warned, true);
    assert.deepEqual(kept, items); // the one bad pattern is skipped; the good one still runs and matches nothing here
  });

  test('logs the filtered count exactly once per call when something is dropped, and stays silent when nothing is', () => {
    const items = [item({ id: 'a', title: 'Form 4 Acme Corp' }), item({ id: 'b', title: 'Fed holds interest rates steady' })];
    let logCount = 0;
    const log = { log: () => { logCount++; }, warn() {} };
    filterNoise(items, ['\\bform\\s+4\\b'], { lane: 'markets', log });
    assert.equal(logCount, 1);

    logCount = 0;
    filterNoise([item({ id: 'c', title: 'Fed holds interest rates steady' })], ['\\bform\\s+4\\b'], { lane: 'markets', log });
    assert.equal(logCount, 0); // nothing matched, nothing to report
  });

  describe('seeded markets patterns (config/news-sources.json)', () => {
    const patterns = laneSourcesConfig().lanes.markets.excludeTitlePatterns;

    test('drops raw Form 3/4/5 filing headlines and routine officer/director stock-sale boilerplate', () => {
      const noise = [
        item({ id: 'n1', title: 'Form 4 IQVIA Inc' }),
        item({ id: 'n2', title: 'IQVIA Holdings Inc Form 4 Filing' }),
        item({ id: 'n3', title: 'Iqvia EVP Ronald Bruehlman Sells 5,000 Shares of Stock' }),
        item({ id: 'n4', title: 'Insider Sells $1.2 Million in Stock' }),
        item({ id: 'n5', title: 'Chief Financial Officer Sells 12,345 Shares of Company Stock' }),
        // Regression: abbreviated dollar amounts ("$1.25m") observed in a
        // live dry run must be caught too, not just the spelled-out unit.
        item({ id: 'n6', title: 'Iqvia EVP, general counsel Eric Sherbet sells $1.25m in stock' }),
      ];
      const kept = filterNoise(noise, patterns, { lane: 'markets', log: quietLog });
      assert.deepEqual(kept, []);
    });

    test('keeps real SEC/regulatory action, earnings, and genuinely market-moving insider stories', () => {
      const legit = [
        item({ id: 'l1', title: 'Fed holds interest rates steady' }),
        item({ id: 'l2', title: 'SEC charges major bank with securities fraud' }),
        item({ id: 'l3', title: 'Enterprise Products Partners L.P. Q2 2026 Earnings Call Summary' }),
        item({ id: 'l4', title: 'Elon Musk sells $5 billion in Tesla stock amid tax controversy' }),
        item({ id: 'l5', title: 'Nasdaq falls 2% as inflation data surprises markets' }),
      ];
      const kept = filterNoise(legit, patterns, { lane: 'markets', log: quietLog });
      assert.deepEqual(kept.map(i => i.id), legit.map(i => i.id));
    });
  });

  describe('seeded crypto patterns (config/news-sources.json)', () => {
    const patterns = laneSourcesConfig().lanes.crypto.excludeTitlePatterns;

    test('drops generic daily/weekly roundup headlines that carry no discrete event', () => {
      const noise = [
        item({ id: 'n1', title: 'Here\u2019s what happened in crypto today' }),
        item({ id: 'n2', title: 'Crypto Daily Recap: Bitcoin, Ethereum and more' }),
        item({ id: 'n3', title: 'Today in Crypto: ETF flows and stablecoin news' }),
        item({ id: 'n4', title: 'This Week in Crypto: A roundup' }),
      ];
      const kept = filterNoise(noise, patterns, { lane: 'crypto', log: quietLog });
      assert.deepEqual(kept, []);
    });

    test('keeps discrete crypto stories with a real event', () => {
      const legit = [
        item({ id: 'l1', title: 'Bitcoin ETF sees record inflows' }),
        item({ id: 'l2', title: 'SEC approves spot Ethereum ETF' }),
        item({ id: 'l3', title: 'Major exchange reports temporary outage' }),
      ];
      const kept = filterNoise(legit, patterns, { lane: 'crypto', log: quietLog });
      assert.deepEqual(kept.map(i => i.id), legit.map(i => i.id));
    });
  });
});
