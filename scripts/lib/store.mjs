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

/** How many digests stay in the manifest index. Files older than this remain on
 * disk (permalinks keep working) but drop out of the index so the manifest —
 * fetched on every app launch — stays small. */
const DIGEST_INDEX_LIMIT = 60;

export const paths = { ROOT, MANIFEST_PATH, DIGEST_DIR, RADAR_PATH };

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
