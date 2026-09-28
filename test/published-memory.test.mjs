/**
 * Published memory — the cross-digest repeat filter.
 *
 * The bug these cover: 443 items published across the first 20 dated digests,
 * only 190 of them unique. A 36h look-back on a daily cadence with no record of
 * what already shipped re-serves most of yesterday, every day.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { filterAlreadyPublished, capKindShare, dedupeKey, titleKey } from '../scripts/lib/sources.mjs';
import { recordPublished } from '../scripts/lib/store.mjs';

/** In-memory stand-in for state/published.json. */
function memoryIo(initial = { version: 1, updatedAt: null, entries: [] }) {
  let state = initial;
  return {
    read: () => state,
    write: data => {
      state = data;
    },
    get current() {
      return state;
    },
  };
}

const item = (id, url, title, sourceKind = 'repo') => ({ id, url, title, sourceKind });

test('an empty memory filters nothing', () => {
  const items = [item('a', 'https://example.com/one', 'One')];
  const { fresh, dropped } = filterAlreadyPublished(items, { entries: [] });
  assert.equal(fresh.length, 1);
  assert.equal(dropped.length, 0);
});

test('a published URL is dropped on the next run', () => {
  const io = memoryIo();
  recordPublished([item('a', 'https://example.com/one', 'One')], '2026-08-20', '2026-08-20T09:00:00Z', io);

  const { fresh, dropped } = filterAlreadyPublished(
    [item('a', 'https://example.com/one', 'One'), item('b', 'https://example.com/two', 'Two')],
    io.current,
  );
  assert.deepEqual(fresh.map(i => i.id), ['b']);
  assert.deepEqual(dropped.map(i => i.id), ['a']);
});

test('tracking parameters do not smuggle a repeat back in', () => {
  const io = memoryIo();
  recordPublished([item('a', 'https://example.com/one', 'One')], '2026-08-20', '2026-08-20T09:00:00Z', io);

  const { dropped } = filterAlreadyPublished(
    [item('a2', 'https://www.example.com/one/?utm_source=hn', 'One')],
    io.current,
  );
  assert.equal(dropped.length, 1, 'same canonical URL should match');
});

test('the same story under a different URL is caught by title', () => {
  const io = memoryIo();
  recordPublished(
    [item('a', 'https://news.ycombinator.com/item?id=1', 'Claude Code 2.1.237 fixes gateway caching')],
    '2026-08-20',
    '2026-08-20T09:00:00Z',
    io,
  );

  const { fresh, dropped } = filterAlreadyPublished(
    [item('b', 'https://reddit.com/r/ClaudeAI/comments/xyz', 'Claude Code 2.1.237 fixes gateway caching!')],
    io.current,
  );
  assert.equal(dropped.length, 1, 'punctuation must not defeat the title key');
  assert.equal(fresh.length, 0);
});

test('firstSeenIn stays put when an item is published twice', () => {
  const io = memoryIo();
  const one = [item('a', 'https://example.com/one', 'One')];
  recordPublished(one, '2026-08-20', '2026-08-20T09:00:00Z', io);
  const added = recordPublished(one, '2026-08-22', '2026-08-22T09:00:00Z', io);

  assert.equal(added, 0, 'a repeat is not a new entry');
  const entry = io.current.entries.find(e => e.key === dedupeKey('https://example.com/one'));
  assert.equal(entry.firstSeenIn, '2026-08-20');
  assert.equal(entry.lastSeenIn, '2026-08-22');
  assert.equal(entry.timesPublished, 2);
});

test('entries older than the retention window are pruned', () => {
  const io = memoryIo();
  recordPublished([item('old', 'https://example.com/old', 'Old')], '2026-06-01', '2026-06-01T09:00:00Z', io);
  recordPublished([item('new', 'https://example.com/new', 'New')], '2026-08-23', '2026-08-23T09:00:00Z', io);

  const keys = io.current.entries.map(e => e.key);
  assert.ok(!keys.includes(dedupeKey('https://example.com/old')), '83 days old, should be gone');
  assert.ok(keys.includes(dedupeKey('https://example.com/new')));
});

test('an item with no URL is ignored rather than crashing the run', () => {
  const io = memoryIo();
  const added = recordPublished([{ id: 'x', title: 'No URL' }], '2026-08-23', '2026-08-23T09:00:00Z', io);
  assert.equal(added, 0);
});

test('titleKey normalises case, punctuation and whitespace', () => {
  assert.equal(titleKey('  Hello,   World!  '), titleKey('hello world'));
});

// --- repo share cap -------------------------------------------------------

test('repo items over the share cap are cut from the bottom', () => {
  // 10 items, 8 of them repos. A 45% cap allows 4.
  const items = [
    ...Array.from({ length: 8 }, (_, i) => item(`r${i}`, `https://github.com/x/${i}`, `Repo ${i}`)),
    item('n1', 'https://example.com/a', 'News A', 'news'),
    item('n2', 'https://example.com/b', 'News B', 'news'),
  ];
  const { items: kept, dropped } = capKindShare(items, 'repo', 0.45, 6);

  assert.equal(dropped.length, 4);
  assert.deepEqual(dropped.map(i => i.id), ['r4', 'r5', 'r6', 'r7'], 'cuts the lowest-ranked repos');
  assert.equal(kept.filter(i => i.sourceKind === 'repo').length, 4);
  assert.equal(kept.filter(i => i.sourceKind === 'news').length, 2, 'non-repo items are untouched');
});

test('a digest already under the cap is left alone', () => {
  const items = [
    item('r0', 'https://github.com/x/0', 'Repo 0'),
    item('n1', 'https://example.com/a', 'News A', 'news'),
    item('n2', 'https://example.com/b', 'News B', 'news'),
  ];
  const { items: kept, dropped } = capKindShare(items, 'repo', 0.45);
  assert.equal(dropped.length, 0);
  assert.equal(kept.length, 3);
});

test('the cap yields rather than take a thin digest below the floor', () => {
  // 9 repos and nothing else. Enforcing 45% would leave 4 items.
  const items = Array.from({ length: 9 }, (_, i) => item(`r${i}`, `https://github.com/x/${i}`, `Repo ${i}`));
  const { items: kept, dropped } = capKindShare(items, 'repo', 0.45, 8);

  assert.equal(dropped.length, 0, 'a short digest beats a near-empty one');
  assert.equal(kept.length, 9);
});
