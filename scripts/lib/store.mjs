/**
 * Reads and writes the published content: digests, the manifest, the radar.
 * Everything here is a plain file in the repo — the "database" is git, and the
 * CDN is GitHub Pages. See CONTRACT.md for the shapes.
 *
 * The one hard rule: never break a field a shipped app reads. Add, don't rename.
 */
import { readFileSync, writeFileSync, mkdirSync, existsSync, readdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
const MANIFEST_PATH = join(ROOT, 'manifest.json');
const DIGEST_DIR = join(ROOT, 'digests');
const RADAR_PATH = join(ROOT, 'models', 'radar.json');
const NEWS_DIR = join(ROOT, 'news');
const NEWS_LANES_DIR = join(NEWS_DIR, 'lanes');
const FRONTPAGE_PATH = join(NEWS_DIR, 'frontpage.json');

/** How many digests stay in the manifest index. Files older than this remain on
 * disk (permalinks keep working) but drop out of the index so the manifest —
 * fetched on every app launch — stays small. */
const DIGEST_INDEX_LIMIT = 60;

/** The closed set of news lanes. Fixed here so a typo'd lane name in config
 * can't silently create an untyped manifest entry. */
export const NEWS_LANES = ['crypto', 'markets', 'ai', 'tech'];

export const paths = { ROOT, MANIFEST_PATH, DIGEST_DIR, RADAR_PATH, NEWS_DIR, NEWS_LANES_DIR, FRONTPAGE_PATH };

function readJson(path, fallback) {
  if (!existsSync(path)) return fallback;
  try {
    return JSON.parse(readFileSync(path, 'utf8'));
  } catch (err) {
    console.warn(`  ! ${path} is unreadable (${err.message}), using fallback`);
    return fallback;
  }
}

function writeJson(path, data) {
  mkdirSync(dirname(path), { recursive: true });
  writeFileSync(path, `${JSON.stringify(data, null, 2)}\n`);
}

export function readManifest() {
  return readJson(MANIFEST_PATH, {
    manifestVersion: 0,
    generatedAt: null,
    latestDigestId: null,
    digests: [],
    radar: { url: 'models/radar.json', contentVersion: 0 },
    sources: { url: 'config/sources.json', contentVersion: 1 },
  });
}

export function readRadar() {
  return readJson(RADAR_PATH, { contentVersion: 0, generatedAt: null, models: [] });
}

export function readDigest(id) {
  return readJson(join(DIGEST_DIR, `${id}.json`), null);
}

export function listDigestFiles() {
  if (!existsSync(DIGEST_DIR)) return [];
  return readdirSync(DIGEST_DIR)
    .filter(f => f.endsWith('.json'))
    .sort()
    .reverse();
}

/**
 * Write a digest and update the manifest to point at it.
 *
 * Re-running on the same id (a second cron tick the same day) replaces the file
 * and bumps its contentVersion so clients re-import. `latestDigestId` only moves
 * forward — a backfill of an older date must not hijack what "Today" shows.
 */
export function publishDigest(digest) {
  const existing = readDigest(digest.id);
  const contentVersion = existing ? (existing.contentVersion ?? 1) + 1 : 1;
  const withVersion = { ...digest, contentVersion };

  writeJson(join(DIGEST_DIR, `${digest.id}.json`), withVersion);

  const manifest = readManifest();
  const entry = {
    id: digest.id,
    url: `digests/${digest.id}.json`,
    kind: digest.kind,
    generatedAt: digest.generatedAt,
    itemCount: digest.items.length,
    headline: digest.brief?.headline ?? null,
    contentVersion,
  };

  const others = (manifest.digests ?? []).filter(d => d.id !== digest.id);
  const digests = [entry, ...others]
    .sort((a, b) => String(b.generatedAt).localeCompare(String(a.generatedAt)))
    .slice(0, DIGEST_INDEX_LIMIT);

  // Newest by generatedAt wins, so a backfill never becomes "Today".
  const latest = digests[0]?.id ?? digest.id;

  writeJson(MANIFEST_PATH, {
    ...manifest,
    manifestVersion: (manifest.manifestVersion ?? 0) + 1,
    generatedAt: digest.generatedAt,
    latestDigestId: latest,
    digests,
    radar: manifest.radar ?? { url: 'models/radar.json', contentVersion: 0 },
    sources: manifest.sources ?? { url: 'config/sources.json', contentVersion: 1 },
  });

  return { contentVersion, isLatest: latest === digest.id };
}

/**
 * Merge newly-seen model releases into the radar.
 *
 * Append-only on the timeline: a model's history is never rewritten, because
 * the timeline is the interesting part. Scalar specs (license, context, status)
 * are filled in when we learn them but never overwritten with "unknown" — a
 * later article that omits the license must not erase a known one.
 *
 * Returns the number of models touched; 0 means the radar file is untouched and
 * its contentVersion does not move.
 */
export function mergeRadar(releases, generatedAt) {
  if (!releases?.length) return 0;

  const radar = readRadar();
  const byId = new Map((radar.models ?? []).map(m => [m.id, m]));
  let touched = 0;

  for (const r of releases) {
    if (!r.id || !r.name) continue;
    const contextTokens =
      r.contextTokens && /^\d+$/.test(r.contextTokens) ? Number(r.contextTokens) : null;
    const known = byId.get(r.id);

    if (!known) {
      byId.set(r.id, {
        id: r.id,
        name: r.name,
        vendor: r.vendor || 'unknown',
        openness: r.openness || 'unknown',
        license: r.license || 'unknown',
        contextTokens,
        priceInPerMTok: null,
        priceOutPerMTok: null,
        status: r.status || 'current',
        firstSeenAt: generatedAt,
        timeline: [{ at: generatedAt, what: r.what, url: r.url || null }],
      });
      touched += 1;
      continue;
    }

    // Skip an exact repeat — the same story resurfacing shouldn't append a
    // duplicate timeline row on every run.
    const isRepeat = known.timeline?.some(t => t.what === r.what);
    if (!isRepeat) {
      known.timeline = [...(known.timeline ?? []), { at: generatedAt, what: r.what, url: r.url || null }];
      touched += 1;
    }

    if (contextTokens && !known.contextTokens) known.contextTokens = contextTokens;
    if (r.license && r.license !== 'unknown' && known.license === 'unknown') known.license = r.license;
    if (r.openness && r.openness !== 'unknown' && known.openness === 'unknown') known.openness = r.openness;
    if (r.status && r.status !== known.status) known.status = r.status;
  }

  if (touched === 0) return 0;

  const models = [...byId.values()].sort((a, b) =>
    String(b.firstSeenAt).localeCompare(String(a.firstSeenAt)),
  );
  const contentVersion = (radar.contentVersion ?? 0) + 1;
  writeJson(RADAR_PATH, { contentVersion, generatedAt, models });

  const manifest = readManifest();
  writeJson(MANIFEST_PATH, {
    ...manifest,
    manifestVersion: (manifest.manifestVersion ?? 0) + 1,
    radar: { url: 'models/radar.json', contentVersion },
  });

  return touched;
}

// ---------------------------------------------------------------------------
// News lanes — additive. Never touches latestDigestId/digests/radar/sources.
// ---------------------------------------------------------------------------

export function readLaneFeed(lane) {
  return readJson(join(NEWS_LANES_DIR, `${lane}.json`), null);
}

export function readFrontPage() {
  return readJson(FRONTPAGE_PATH, null);
}

/** Real filesystem-backed I/O for publishNewsLanes. Exists as a seam so tests
 * can inject an in-memory equivalent instead of touching the repo's own
 * committed news/*.json and manifest.json. */
function defaultNewsIo() {
  return {
    readManifest,
    readLaneFeed,
    readFrontPage,
    writeLane: (lane, data) => writeJson(join(NEWS_LANES_DIR, `${lane}.json`), data),
    writeFrontPage: data => writeJson(FRONTPAGE_PATH, data),
    writeManifest: data => writeJson(MANIFEST_PATH, data),
  };
}

/**
 * Publish however many lanes produced stories this run, plus a stitched front
 * page, and extend the manifest additively under `news`.
 *
 * `laneFeeds` is a partial map: `{ [lane]: { lane, generatedAt, stories } }`.
 * A lane the caller omits (it failed, or fetched nothing this run) is left
 * completely untouched — its on-disk feed file, its manifest entry, and its
 * slot in the front page all keep whatever was last published there. That is
 * the same "publish nothing rather than something broken" posture the digest
 * uses, applied per lane instead of per run: one dead lane must never blank
 * out, or block, the others.
 *
 * Each lane's contentVersion increments independently on every publish. There
 * is no dated id to key on the way digests have one — the news feed is a
 * rolling window, not a dated edition — so a same-cycle rerun (or any rerun)
 * simply bumps the version, exactly like radar.json does.
 */
export function publishNewsLanes(laneFeeds, generatedAt, io = defaultNewsIo()) {
  const lanesWithStories = Object.entries(laneFeeds ?? {}).filter(([, feed]) => feed?.stories?.length);
  if (lanesWithStories.length === 0) return { published: false, lanes: {} };

  const manifest = io.readManifest();
  const newsManifest = manifest.news ?? { frontPage: null, lanes: {} };
  const lanesOut = { ...(newsManifest.lanes ?? {}) };

  for (const [lane, feed] of lanesWithStories) {
    const existing = io.readLaneFeed(lane);
    const contentVersion = existing ? (existing.contentVersion ?? 1) + 1 : 1;
    const withVersion = {
      lane,
      generatedAt: feed.generatedAt,
      contentVersion,
      stories: feed.stories,
    };
    io.writeLane(lane, withVersion);
    lanesOut[lane] = {
      url: `news/lanes/${lane}.json`,
      contentVersion,
      generatedAt: feed.generatedAt,
      storyCount: feed.stories.length,
    };
  }

  // Stitch every lane into the front page — including lanes untouched this
  // run, read back from disk, so a partial run never erases a healthy lane.
  const frontLanes = {};
  for (const lane of NEWS_LANES) {
    const updated = laneFeeds?.[lane];
    frontLanes[lane] = updated?.stories?.length ? updated.stories : io.readLaneFeed(lane)?.stories ?? [];
  }

  const existingFront = io.readFrontPage();
  const frontContentVersion = existingFront ? (existingFront.contentVersion ?? 1) + 1 : 1;
  const frontPage = { generatedAt, contentVersion: frontContentVersion, lanes: frontLanes };
  io.writeFrontPage(frontPage);

  io.writeManifest({
    ...manifest,
    manifestVersion: (manifest.manifestVersion ?? 0) + 1,
    news: {
      frontPage: { url: 'news/frontpage.json', contentVersion: frontContentVersion, generatedAt },
      lanes: lanesOut,
    },
  });

  return { published: true, lanes: lanesOut, frontPage: { contentVersion: frontContentVersion } };
}
