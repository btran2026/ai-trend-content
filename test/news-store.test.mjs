import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { publishNewsLanes } from '../scripts/lib/store.mjs';

/**
 * publishNewsLanes takes an injectable `io` seam precisely so these tests
 * never touch this repo's own committed manifest.json / news/*.json — see
 * defaultNewsIo() in scripts/lib/store.mjs.
 */
function fakeIo(initial = {}) {
  const state = {
    manifest: initial.manifest ?? {
      manifestVersion: 14,
      generatedAt: '2026-07-28T18:00:00.000Z',
      latestDigestId: '2026-07-28',
      digests: [{ id: '2026-07-28', url: 'digests/2026-07-28.json', kind: 'scheduled', generatedAt: '2026-07-28T18:00:00.000Z', itemCount: 24, headline: 'Existing headline', contentVersion: 3 }],
      radar: { url: 'models/radar.json', contentVersion: 5 },
      sources: { url: 'config/sources.json', contentVersion: 1 },
    },
    lanes: { ...(initial.lanes ?? {}) },
    frontPage: initial.frontPage ?? null,
    writes: { lanes: {}, frontPage: null, manifest: null },
  };
  return {
    state,
    readManifest: () => state.manifest,
    readLaneFeed: lane => state.lanes[lane] ?? null,
    readFrontPage: () => state.frontPage,
    writeLane: (lane, data) => {
      state.lanes[lane] = data;
      state.writes.lanes[lane] = data;
    },
    writeFrontPage: data => {
      state.frontPage = data;
      state.writes.frontPage = data;
    },
    writeManifest: data => {
      state.manifest = data;
      state.writes.manifest = data;
    },
  };
}

function story(overrides = {}) {
  return {
    id: 'crypto-abc123',
    slug: 'bitcoin-etf-inflows',
    lane: 'crypto',
    title: 'Bitcoin ETF sees record inflows',
    summary: 'Summary.',
    whyItMatters: 'Why it matters.',
    whatToWatch: ['Next filing deadline'],
    questions: ['Will inflows continue?'],
    sources: [{ title: 'Bitcoin ETF sees record inflows', url: 'https://wire.example/a', publisher: 'Example Wire', publishedAt: '2026-07-31T12:00:00.000Z' }],
    sourceCount: 1,
    publishedAt: '2026-07-31T12:00:00.000Z',
    updatedAt: '2026-07-31T18:00:00.000Z',
    trendScore: 72,
    confidence: 'medium',
    ...overrides,
  };
}

describe('publishNewsLanes — additive manifest publication', () => {
  test('never touches latestDigestId/digests/radar/sources', () => {
    const io = fakeIo();
    const before = JSON.parse(JSON.stringify(io.readManifest()));
    publishNewsLanes({ crypto: { lane: 'crypto', generatedAt: '2026-07-31T18:00:00.000Z', stories: [story()] } }, '2026-07-31T18:00:00.000Z', io);

    assert.deepEqual(io.state.manifest.latestDigestId, before.latestDigestId);
    assert.deepEqual(io.state.manifest.digests, before.digests);
    assert.deepEqual(io.state.manifest.radar, before.radar);
    assert.deepEqual(io.state.manifest.sources, before.sources);
  });

  test('adds a `news` block with frontPage + per-lane pointers', () => {
    const io = fakeIo();
    const generatedAt = '2026-07-31T18:00:00.000Z';
    const result = publishNewsLanes({ crypto: { lane: 'crypto', generatedAt, stories: [story()] } }, generatedAt, io);

    assert.equal(result.published, true);
    assert.ok(io.state.manifest.news);
    assert.equal(io.state.manifest.news.frontPage.url, 'news/frontpage.json');
    assert.equal(io.state.manifest.news.lanes.crypto.url, 'news/lanes/crypto.json');
    assert.equal(io.state.manifest.news.lanes.crypto.storyCount, 1);
    assert.equal(io.state.manifest.news.lanes.crypto.contentVersion, 1);
  });

  test('bumps manifestVersion on every publish', () => {
    const io = fakeIo();
    const before = io.readManifest().manifestVersion;
    publishNewsLanes({ tech: { lane: 'tech', generatedAt: '2026-07-31T18:00:00.000Z', stories: [story({ lane: 'tech', id: 'tech-1' })] } }, '2026-07-31T18:00:00.000Z', io);
    assert.equal(io.state.manifest.manifestVersion, before + 1);
  });

  test('writes a LaneFeed with lane/generatedAt/contentVersion/stories, nothing extra required by the app dropped', () => {
    const io = fakeIo();
    const generatedAt = '2026-07-31T18:00:00.000Z';
    publishNewsLanes({ ai: { lane: 'ai', generatedAt, stories: [story({ lane: 'ai', id: 'ai-1' })] } }, generatedAt, io);
    const written = io.state.writes.lanes.ai;
    assert.equal(written.lane, 'ai');
    assert.equal(written.generatedAt, generatedAt);
    assert.equal(written.contentVersion, 1);
    assert.equal(written.stories.length, 1);
  });
});

describe('publishNewsLanes — same-cycle reruns', () => {
  test('a rerun on the same lane increments contentVersion instead of resetting it', () => {
    const io = fakeIo();
    const gen1 = '2026-07-31T12:00:00.000Z';
    const gen2 = '2026-07-31T18:00:00.000Z';

    publishNewsLanes({ markets: { lane: 'markets', generatedAt: gen1, stories: [story({ lane: 'markets', id: 'markets-1' })] } }, gen1, io);
    assert.equal(io.state.lanes.markets.contentVersion, 1);

    publishNewsLanes({ markets: { lane: 'markets', generatedAt: gen2, stories: [story({ lane: 'markets', id: 'markets-1' }), story({ lane: 'markets', id: 'markets-2' })] } }, gen2, io);
    assert.equal(io.state.lanes.markets.contentVersion, 2);
    assert.equal(io.state.lanes.markets.stories.length, 2);
    assert.equal(io.state.manifest.news.lanes.markets.contentVersion, 2);
  });

  test('the front page contentVersion also increments on every publish', () => {
    const io = fakeIo();
    publishNewsLanes({ tech: { lane: 'tech', generatedAt: 't1', stories: [story({ lane: 'tech', id: 'tech-1' })] } }, 't1', io);
    const v1 = io.state.frontPage.contentVersion;
    publishNewsLanes({ tech: { lane: 'tech', generatedAt: 't2', stories: [story({ lane: 'tech', id: 'tech-1' })] } }, 't2', io);
    const v2 = io.state.frontPage.contentVersion;
    assert.equal(v2, v1 + 1);
  });
});

describe('publishNewsLanes — empty/failing lane', () => {
  test('a lane omitted from laneFeeds is left completely untouched on disk and in the manifest', () => {
    const io = fakeIo({
      lanes: { crypto: { lane: 'crypto', generatedAt: 'old', contentVersion: 3, stories: [story({ id: 'crypto-old' })] } },
      manifest: {
        manifestVersion: 20,
        generatedAt: 'old',
        latestDigestId: '2026-07-28',
        digests: [],
        radar: { url: 'models/radar.json', contentVersion: 5 },
        sources: { url: 'config/sources.json', contentVersion: 1 },
        news: {
          frontPage: { url: 'news/frontpage.json', contentVersion: 3, generatedAt: 'old' },
          lanes: { crypto: { url: 'news/lanes/crypto.json', contentVersion: 3, generatedAt: 'old', storyCount: 1 } },
        },
      },
      frontPage: { generatedAt: 'old', contentVersion: 3, lanes: { crypto: [story({ id: 'crypto-old' })], markets: [], ai: [], tech: [] } },
    });

    // This run: crypto failed entirely (fetch errors) and is omitted; only tech produced stories.
    const result = publishNewsLanes({ tech: { lane: 'tech', generatedAt: 'new', stories: [story({ lane: 'tech', id: 'tech-1' })] } }, 'new', io);

    assert.equal(result.published, true);
    // crypto's lane file, contentVersion and manifest pointer are byte-for-byte the same as before this run.
    assert.equal(io.state.lanes.crypto.contentVersion, 3);
    assert.equal(io.state.lanes.crypto.stories[0].id, 'crypto-old');
    assert.equal(io.state.manifest.news.lanes.crypto.contentVersion, 3);
    // tech is new.
    assert.equal(io.state.manifest.news.lanes.tech.contentVersion, 1);
    // The front page still carries crypto's last-known-good stories, not an empty array.
    assert.equal(io.state.frontPage.lanes.crypto[0].id, 'crypto-old');
    assert.equal(io.state.frontPage.lanes.tech[0].id, 'tech-1');
    // markets/ai were never configured/published — front page degrades to [], not an error.
    assert.deepEqual(io.state.frontPage.lanes.markets, []);
  });

  test('when every lane fails/produces nothing, nothing is published — manifest and lane files are untouched', () => {
    const io = fakeIo({
      lanes: { crypto: { lane: 'crypto', generatedAt: 'old', contentVersion: 2, stories: [story({ id: 'crypto-old' })] } },
    });
    const before = JSON.parse(JSON.stringify(io.state.manifest));

    const result = publishNewsLanes({}, 'new', io);

    assert.equal(result.published, false);
    assert.deepEqual(io.state.manifest, before);
    assert.equal(io.state.writes.frontPage, null);
    assert.deepEqual(io.state.writes.lanes, {});
  });

  test('a lane present but with zero stories is treated the same as an omitted lane', () => {
    const io = fakeIo({
      lanes: { markets: { lane: 'markets', generatedAt: 'old', contentVersion: 1, stories: [story({ lane: 'markets', id: 'markets-old' })] } },
    });
    const result = publishNewsLanes(
      {
        markets: { lane: 'markets', generatedAt: 'new', stories: [] }, // AI stage produced nothing this run
        crypto: { lane: 'crypto', generatedAt: 'new', stories: [story({ id: 'crypto-1' })] },
      },
      'new',
      io,
    );
    assert.equal(result.published, true);
    assert.equal(io.state.lanes.markets.contentVersion, 1); // untouched
    assert.ok(io.state.lanes.crypto);
  });
});
