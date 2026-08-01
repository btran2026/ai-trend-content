import { test, describe } from 'node:test';
import assert from 'node:assert/strict';
import { writeLaneStories } from '../scripts/lib/news-ai.mjs';
import { titleTokens, extractEntities } from '../scripts/lib/news-sources.mjs';

function slugify(text) {
  return String(text).toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '');
}
function stableId(lane, url) {
  return `${lane}-${Buffer.from(url).toString('hex').slice(0, 10)}`;
}

function makeCluster(id, { title, url = `https://wire.example/${id}`, publisher = 'Example Wire', publishedAt = '2026-07-31T12:00:00.000Z', authority = 4 } = {}) {
  return {
    id,
    items: [{ id, title, url, source: publisher, sourceKind: 'news', publishedAt, snippet: '', score: 10, authority }],
    titleTokens: titleTokens(title),
    entities: extractEntities(title),
  };
}

/** A cluster with several source items (possibly repeating one publisher) —
 * for exercising sourceCount/distinct-publisher and id-continuity behavior
 * that a single-item cluster can't cover. */
function makeMultiItemCluster(id, title, items) {
  const built = items.map((it, i) => ({
    id: `${id}-${i}`,
    title,
    sourceKind: 'news',
    snippet: '',
    score: 10,
    authority: 4,
    publishedAt: '2026-07-31T12:00:00.000Z',
    url: `https://wire.example/${id}-${i}`,
    source: 'Example Wire',
    ...it,
  }));
  return {
    id,
    items: built,
    titleTokens: titleTokens(title),
    entities: extractEntities(title),
  };
}

function ranked(clusters) {
  return clusters.map(cluster => ({ cluster, trendScore: 50, confidence: 'medium' }));
}

describe('writeLaneStories — anti-fabrication guardrails', () => {
  test('drops a story whose clusterId was not supplied (hallucinated reference)', async () => {
    const clusters = ranked([makeCluster('cl-1', { title: 'Fed holds interest rates steady' })]);
    const callJsonFn = async () => ({
      stories: [
        { clusterId: 'cl-1', title: 'Fed holds interest rates steady', summary: 'S', whyItMatters: 'W', whatToWatch: [], questions: [], badge: '' },
        { clusterId: 'cl-does-not-exist', title: 'Invented story', summary: 'S', whyItMatters: 'W', whatToWatch: [], questions: [], badge: '' },
      ],
    });
    const stories = await writeLaneStories('markets', clusters, { generatedAt: 'now', slugify, stableId, callJsonFn });
    assert.equal(stories.length, 1);
    assert.equal(stories[0].title, 'Fed holds interest rates steady');
  });

  test('sources are always reconstructed from the cluster, never from the model response', async () => {
    const clusters = ranked([makeCluster('cl-1', { title: 'Bitcoin ETF sees record inflows', url: 'https://real-wire.example/etf', publisher: 'Real Wire' })]);
    const callJsonFn = async () => ({
      stories: [
        {
          clusterId: 'cl-1',
          title: 'Bitcoin ETF sees record inflows',
          summary: 'S',
          whyItMatters: 'W',
          whatToWatch: [],
          questions: [],
          badge: '',
          // A well-behaved model never sends these (the schema has no field for
          // them), but if a model tried to smuggle a fabricated source in via
          // an unexpected key, it must be ignored entirely.
          sources: [{ url: 'https://fabricated.example/not-real', publisher: 'Not Real News', title: 'Made up' }],
        },
      ],
    });
    const [published] = await writeLaneStories('crypto', clusters, { generatedAt: 'now', slugify, stableId, callJsonFn });
    assert.equal(published.sources.length, 1);
    assert.equal(published.sources[0].url, 'https://real-wire.example/etf');
    assert.equal(published.sources[0].publisher, 'Real Wire');
  });

  test('falls back to the representative title when the proposed title is off-topic', async () => {
    const clusters = ranked([makeCluster('cl-1', { title: 'Fed holds interest rates steady' })]);
    const callJsonFn = async () => ({
      stories: [
        { clusterId: 'cl-1', title: 'Completely unrelated headline about giraffes', summary: 'S', whyItMatters: 'W', whatToWatch: [], questions: [], badge: '' },
      ],
    });
    const [published] = await writeLaneStories('markets', clusters, { generatedAt: 'now', slugify, stableId, callJsonFn });
    assert.equal(published.title, 'Fed holds interest rates steady');
  });

  test('accepts a lightly sharpened on-topic title', async () => {
    const clusters = ranked([makeCluster('cl-1', { title: 'Fed holds interest rates steady' })]);
    const callJsonFn = async () => ({
      stories: [
        { clusterId: 'cl-1', title: 'Fed holds rates steady, signals patience', summary: 'S', whyItMatters: 'W', whatToWatch: [], questions: [], badge: '' },
      ],
    });
    const [published] = await writeLaneStories('markets', clusters, { generatedAt: 'now', slugify, stableId, callJsonFn });
    assert.equal(published.title, 'Fed holds rates steady, signals patience');
  });

  test('confidence and trendScore always come from the deterministic ranker, never the model', async () => {
    const clusters = ranked([makeCluster('cl-1', { title: 'Fed holds interest rates steady' })]);
    const callJsonFn = async () => ({
      stories: [{ clusterId: 'cl-1', title: 'Fed holds interest rates steady', summary: 'S', whyItMatters: 'W', whatToWatch: [], questions: [], badge: '' }],
    });
    const [published] = await writeLaneStories('markets', clusters, { generatedAt: 'now', slugify, stableId, callJsonFn });
    assert.equal(published.trendScore, 50);
    assert.equal(published.confidence, 'medium');
  });

  test('whatToWatch/questions are sanitized: capped length, blanks dropped', async () => {
    const clusters = ranked([makeCluster('cl-1', { title: 'Fed holds interest rates steady' })]);
    const callJsonFn = async () => ({
      stories: [
        {
          clusterId: 'cl-1',
          title: 'Fed holds interest rates steady',
          summary: 'S',
          whyItMatters: 'W',
          whatToWatch: ['', '  Next meeting date  ', 'a', 'b', 'c', 'd', 'e'],
          questions: ['', 'Will this continue?'],
          badge: '',
        },
      ],
    });
    const [published] = await writeLaneStories('markets', clusters, { generatedAt: 'now', slugify, stableId, callJsonFn });
    assert.ok(published.whatToWatch.length <= 4);
    assert.equal(published.whatToWatch[0], 'Next meeting date');
    assert.deepEqual(published.questions, ['Will this continue?']);
  });

  test('returns [] without throwing when the AI stage yields nothing (refusal/timeout)', async () => {
    const clusters = ranked([makeCluster('cl-1', { title: 'Fed holds interest rates steady' })]);
    const callJsonFn = async () => null;
    const stories = await writeLaneStories('markets', clusters, { generatedAt: 'now', slugify, stableId, callJsonFn });
    assert.deepEqual(stories, []);
  });

  test('returns [] immediately when there are no ranked clusters, without calling the model', async () => {
    let called = false;
    const callJsonFn = async () => {
      called = true;
      return { stories: [] };
    };
    const stories = await writeLaneStories('markets', [], { generatedAt: 'now', slugify, stableId, callJsonFn });
    assert.deepEqual(stories, []);
    assert.equal(called, false);
  });

  test('regression: a duplicate valid clusterId in the model response is only published once', async () => {
    const clusters = ranked([makeCluster('cl-1', { title: 'Fed holds interest rates steady' })]);
    const callJsonFn = async () => ({
      stories: [
        { clusterId: 'cl-1', title: 'Fed holds interest rates steady', summary: 'First', whyItMatters: 'W', whatToWatch: [], questions: [], badge: '' },
        // Same valid clusterId returned again — must not become a second, duplicate-id story.
        { clusterId: 'cl-1', title: 'Fed holds interest rates steady, again', summary: 'Second', whyItMatters: 'W', whatToWatch: [], questions: [], badge: '' },
      ],
    });
    const stories = await writeLaneStories('markets', clusters, { generatedAt: 'now', slugify, stableId, callJsonFn });
    assert.equal(stories.length, 1);
    assert.equal(stories[0].summary, 'First'); // first occurrence wins, second is dropped
  });

  test('regression: sourceCount reflects distinct publishers, while every article is still kept as a receipt', async () => {
    const cluster = makeMultiItemCluster('cl-1', 'Fed holds interest rates steady', [
      { source: 'Wire A' },
      { source: 'Wire A' }, // same outlet twice (e.g. RSS entry + HN link to it)
      { source: 'Wire B' },
    ]);
    const clusters = ranked([cluster]);
    const callJsonFn = async () => ({
      stories: [{ clusterId: 'cl-1', title: 'Fed holds interest rates steady', summary: 'S', whyItMatters: 'W', whatToWatch: [], questions: [], badge: '' }],
    });
    const [published] = await writeLaneStories('markets', clusters, { generatedAt: 'now', slugify, stableId, callJsonFn });
    assert.equal(published.sources.length, 3); // every fetched item kept as a receipt
    assert.equal(published.sourceCount, 2); // but only 2 distinct publishers behind it
  });

  describe('id continuity across reruns', () => {
    test('reuses the previous id/slug when a new, higher-authority source joins the same story', async () => {
      const previousStories = [
        {
          id: 'crypto-abc123',
          slug: 'bitcoin-etf-inflows',
          title: 'Bitcoin ETF sees record inflows',
          sources: [{ title: 'Bitcoin ETF sees record inflows', url: 'https://wire-a.example/etf', publisher: 'Wire A', publishedAt: '2026-07-30T12:00:00.000Z' }],
        },
      ];
      // This run: the original source is still in the cluster, plus a new,
      // higher-authority source that would otherwise become "the"
      // representative item and (under the old bug) anchor a brand new id.
      const cluster = makeMultiItemCluster('cl-1', 'Bitcoin ETF sees record inflows', [
        { url: 'https://wire-a.example/etf', source: 'Wire A', authority: 2, publishedAt: '2026-07-30T12:00:00.000Z' },
        { url: 'https://wire-b.example/etf-2', source: 'Wire B', authority: 5, publishedAt: '2026-07-31T12:00:00.000Z' },
      ]);
      const clusters = ranked([cluster]);
      const callJsonFn = async () => ({
        stories: [{ clusterId: 'cl-1', title: 'Bitcoin ETF sees record inflows', summary: 'S', whyItMatters: 'W', whatToWatch: [], questions: [], badge: '' }],
      });
      const [published] = await writeLaneStories('crypto', clusters, { generatedAt: 'now', slugify, stableId, previousStories, callJsonFn });
      assert.equal(published.id, 'crypto-abc123');
      assert.equal(published.slug, 'bitcoin-etf-inflows'); // route slug stays stable too
    });

    test('an unrelated story never inherits a previously published id', async () => {
      const previousStories = [
        {
          id: 'crypto-abc123',
          slug: 'bitcoin-etf-inflows',
          title: 'Bitcoin ETF sees record inflows',
          sources: [{ title: 'Bitcoin ETF sees record inflows', url: 'https://wire-a.example/etf', publisher: 'Wire A', publishedAt: '2026-07-30T12:00:00.000Z' }],
        },
      ];
      const cluster = makeCluster('cl-2', { title: 'Ethereum network upgrade goes live', url: 'https://wire-z.example/eth-upgrade', publisher: 'Wire Z' });
      const clusters = ranked([cluster]);
      const callJsonFn = async () => ({
        stories: [{ clusterId: 'cl-2', title: 'Ethereum network upgrade goes live', summary: 'S', whyItMatters: 'W', whatToWatch: [], questions: [], badge: '' }],
      });
      const [published] = await writeLaneStories('crypto', clusters, { generatedAt: 'now', slugify, stableId, previousStories, callJsonFn });
      assert.notEqual(published.id, 'crypto-abc123');
      assert.equal(published.id, stableId('crypto', 'https://wire-z.example/eth-upgrade'));
    });

    test('a brand-new story (no previous feed at all) still gets a stable id anchored on its earliest source', async () => {
      const cluster = makeMultiItemCluster('cl-1', 'Fed holds interest rates steady', [
        { url: 'https://wire-early.example/fed', source: 'Wire Early', authority: 2, publishedAt: '2026-07-30T09:00:00.000Z' },
        { url: 'https://wire-late.example/fed', source: 'Wire Late', authority: 5, publishedAt: '2026-07-31T09:00:00.000Z' },
      ]);
      const clusters = ranked([cluster]);
      const callJsonFn = async () => ({
        stories: [{ clusterId: 'cl-1', title: 'Fed holds interest rates steady', summary: 'S', whyItMatters: 'W', whatToWatch: [], questions: [], badge: '' }],
      });
      const [published] = await writeLaneStories('markets', clusters, { generatedAt: 'now', slugify, stableId, previousStories: [], callJsonFn });
      // Anchored on the earliest item (Wire Early), not the highest-authority one (Wire Late).
      assert.equal(published.id, stableId('markets', 'https://wire-early.example/fed'));
    });

    test('regression: a previous two-source story splitting into two current clusters — only one inherits the id', async () => {
      const previousStories = [
        {
          id: 'crypto-abc123',
          slug: 'exchange-outage-story',
          title: 'Major exchange reports temporary outage',
          sources: [
            { title: 'Major exchange reports temporary outage', url: 'https://wire-a.example/outage', publisher: 'Wire A', publishedAt: '2026-07-30T10:00:00.000Z' },
            { title: 'Major exchange reports temporary outage', url: 'https://wire-b.example/outage', publisher: 'Wire B', publishedAt: '2026-07-30T11:00:00.000Z' },
          ],
        },
      ];

      // This run the story has split into two distinct clusters — each one
      // carries exactly one of the two originally published sources, so each
      // would *independently* match the previous story by URL overlap if
      // matched in isolation. Only one may actually inherit the id.
      const clusterA = makeMultiItemCluster('cl-a', 'Major exchange reports temporary outage', [
        { url: 'https://wire-a.example/outage', source: 'Wire A', authority: 3, publishedAt: '2026-07-30T10:00:00.000Z' },
        { url: 'https://wire-c.example/outage-continues', source: 'Wire C', authority: 3, publishedAt: '2026-07-31T09:00:00.000Z' },
      ]);
      const clusterB = makeMultiItemCluster('cl-b', 'Major exchange outage causes withdrawal delays', [
        { url: 'https://wire-b.example/outage', source: 'Wire B', authority: 3, publishedAt: '2026-07-30T11:00:00.000Z' },
        { url: 'https://wire-d.example/withdrawal-delays', source: 'Wire D', authority: 3, publishedAt: '2026-07-31T10:00:00.000Z' },
      ]);

      // clusterA deliberately ranked ahead of clusterB, so the test is
      // unambiguous about which one is expected to win the inherited id.
      const clusters = [
        { cluster: clusterA, trendScore: 80, confidence: 'high' },
        { cluster: clusterB, trendScore: 60, confidence: 'medium' },
      ];

      const callJsonFn = async () => ({
        stories: [
          { clusterId: 'cl-a', title: 'Major exchange reports temporary outage', summary: 'S1', whyItMatters: 'W', whatToWatch: [], questions: [], badge: '' },
          { clusterId: 'cl-b', title: 'Major exchange outage causes withdrawal delays', summary: 'S2', whyItMatters: 'W', whatToWatch: [], questions: [], badge: '' },
        ],
      });

      const stories = await writeLaneStories('crypto', clusters, { generatedAt: 'now', slugify, stableId, previousStories, callJsonFn });
      assert.equal(stories.length, 2);

      const storyA = stories.find(s => s.summary === 'S1');
      const storyB = stories.find(s => s.summary === 'S2');

      // Exactly one of the two split clusters inherits the previous id — never both, never neither.
      const inheritedCount = [storyA, storyB].filter(s => s.id === 'crypto-abc123').length;
      assert.equal(inheritedCount, 1);

      // The higher-ranked cluster wins the inherited id/slug.
      assert.equal(storyA.id, 'crypto-abc123');
      assert.equal(storyA.slug, 'exchange-outage-story');

      // The other cluster mints its own fresh, distinct id — never the same one.
      assert.notEqual(storyB.id, 'crypto-abc123');
      assert.equal(storyB.id, stableId('crypto', 'https://wire-b.example/outage')); // its own earliest source
      assert.notEqual(storyB.id, storyA.id);
    });
  });

  describe('final id/slug uniqueness guard', () => {
    test('a genuine slug collision between two unrelated clusters is disambiguated, never silently duplicated', async () => {
      // Two different, unrelated stories that happen to get the exact same
      // headline text — nothing stops two different real events from being
      // titled identically.
      const clusterA = makeCluster('cl-1', { title: 'Exchange reports record trading volume', url: 'https://wire-a.example/story-a' });
      const clusterB = makeCluster('cl-2', { title: 'Exchange reports record trading volume', url: 'https://wire-b.example/story-b' });
      const clusters = [
        { cluster: clusterA, trendScore: 70, confidence: 'medium' },
        { cluster: clusterB, trendScore: 60, confidence: 'medium' },
      ];
      const callJsonFn = async () => ({
        stories: [
          { clusterId: 'cl-1', title: 'Exchange reports record trading volume', summary: 'S1', whyItMatters: 'W', whatToWatch: [], questions: [], badge: '' },
          { clusterId: 'cl-2', title: 'Exchange reports record trading volume', summary: 'S2', whyItMatters: 'W', whatToWatch: [], questions: [], badge: '' },
        ],
      });
      const stories = await writeLaneStories('markets', clusters, { generatedAt: 'now', slugify, stableId, callJsonFn });
      assert.equal(stories.length, 2);
      const slugs = stories.map(s => s.slug);
      assert.equal(new Set(slugs).size, 2); // never publish two stories under the same slug
      assert.equal(slugs[0], 'exchange-reports-record-trading-volume'); // higher-ranked keeps the plain slug
      assert.equal(slugs[1], 'exchange-reports-record-trading-volume-2'); // the other is disambiguated
      assert.notEqual(stories[0].id, stories[1].id); // distinct urls still give distinct ids here
    });

    test('a genuine id-hash collision between two unrelated clusters is disambiguated, never silently duplicated', async () => {
      const clusterA = makeCluster('cl-1', { title: 'Central bank raises benchmark rate', url: 'https://wire-a.example/rate-hike' });
      const clusterB = makeCluster('cl-2', { title: 'Regional bank reports a data breach', url: 'https://wire-b.example/breach' });
      const clusters = [
        { cluster: clusterA, trendScore: 70, confidence: 'medium' },
        { cluster: clusterB, trendScore: 60, confidence: 'medium' },
      ];
      // Simulates a genuine hash collision: two entirely different source
      // URLs that happen to stableId to the same value.
      const collidingStableId = () => 'markets-samehash';
      const callJsonFn = async () => ({
        stories: [
          { clusterId: 'cl-1', title: 'Central bank raises benchmark rate', summary: 'S1', whyItMatters: 'W', whatToWatch: [], questions: [], badge: '' },
          { clusterId: 'cl-2', title: 'Regional bank reports a data breach', summary: 'S2', whyItMatters: 'W', whatToWatch: [], questions: [], badge: '' },
        ],
      });
      const stories = await writeLaneStories('markets', clusters, { generatedAt: 'now', slugify, stableId: collidingStableId, callJsonFn });
      assert.equal(stories.length, 2);
      const ids = stories.map(s => s.id);
      assert.equal(new Set(ids).size, 2); // never publish two stories under the same id
      assert.equal(ids[0], 'markets-samehash');
      assert.equal(ids[1], 'markets-samehash-2');
    });

    test('a collision guard never perturbs an id/slug validly inherited from the previous publish', async () => {
      const previousStories = [
        {
          id: 'crypto-abc123',
          slug: 'bitcoin-etf-inflows',
          title: 'Bitcoin ETF sees record inflows',
          sources: [{ title: 'Bitcoin ETF sees record inflows', url: 'https://wire-a.example/etf', publisher: 'Wire A', publishedAt: '2026-07-30T12:00:00.000Z' }],
        },
      ];
      const clusterA = makeCluster('cl-1', { title: 'Bitcoin ETF sees record inflows', url: 'https://wire-a.example/etf', publisher: 'Wire A' });
      // A second, unrelated cluster that mints a fresh id/slug this run —
      // engineered to collide with clusterA's *inherited* id/slug, to prove
      // the inherited one is left untouched and the newcomer is the one
      // disambiguated.
      const clusterB = makeCluster('cl-2', { title: 'Ethereum layer-2 rollup launches mainnet', url: 'https://wire-z.example/rollup' });
      const clusters = [
        { cluster: clusterA, trendScore: 70, confidence: 'medium' },
        { cluster: clusterB, trendScore: 60, confidence: 'medium' },
      ];
      const collidingStableId = () => 'crypto-abc123'; // forces clusterB's fresh mint to collide with clusterA's inherited id
      const collidingSlugify = () => 'bitcoin-etf-inflows'; // forces clusterB's fresh slug to collide too
      const callJsonFn = async () => ({
        stories: [
          { clusterId: 'cl-1', title: 'Bitcoin ETF sees record inflows', summary: 'S1', whyItMatters: 'W', whatToWatch: [], questions: [], badge: '' },
          { clusterId: 'cl-2', title: 'Ethereum layer-2 rollup launches mainnet', summary: 'S2', whyItMatters: 'W', whatToWatch: [], questions: [], badge: '' },
        ],
      });
      const stories = await writeLaneStories('crypto', clusters, { generatedAt: 'now', slugify: collidingSlugify, stableId: collidingStableId, previousStories, callJsonFn });
      const storyA = stories.find(s => s.summary === 'S1');
      const storyB = stories.find(s => s.summary === 'S2');
      // The inherited id/slug stays exactly as published before.
      assert.equal(storyA.id, 'crypto-abc123');
      assert.equal(storyA.slug, 'bitcoin-etf-inflows');
      // The newcomer is disambiguated instead of silently duplicating it.
      assert.equal(storyB.id, 'crypto-abc123-2');
      assert.equal(storyB.slug, 'bitcoin-etf-inflows-2');
    });
  });
});
