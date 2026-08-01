/**
 * Source fetchers. Every one returns RawItem[] and every one is fail-soft:
 * network errors, schema drift, and rate limits log a warning and yield [].
 * A single dead source must never fail an aggregation run.
 *
 * RawItem:
 *   { id, title, url, source, sourceKind, publishedAt, snippet, score?, discussionUrl? }
 *
 * `id` must be stable across runs for the same underlying thing — it's what
 * dedupe and the app's read-state keying rely on.
 */
import { parseFeed, stripHtml } from './rss.mjs';

const UA = 'ai-trend-aggregator/1.0 (+https://github.com/btran2026/ai-trend-content)';
// huggingface.co and reddit.com sit behind bot protection that 403s any
// non-browser User-Agent — verified 403 both locally and from an Actions
// runner. Those two get a browser UA; everything else keeps the honest one,
// because arXiv and GitHub ask for a contactable identifier and don't block us.
const BROWSER_UA =
  'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36';
// Hosts observed to 403 the honest UA. Substack is here for Import AI's feed.
const BROWSER_UA_HOSTS = [/(^|\.)huggingface\.co$/i, /(^|\.)reddit\.com$/i, /(^|\.)substack\.com$/i];
const FETCH_TIMEOUT_MS = 20000;

/** Which UA a host gets. Keeps the choice in one place instead of per call site. */
function uaFor(url) {
  try {
    return BROWSER_UA_HOSTS.some(re => re.test(new URL(url).hostname)) ? BROWSER_UA : UA;
  } catch {
    return UA;
  }
}

function warn(source, err) {
  console.warn(`  ! ${source}: ${err?.message || err}`);
}

export async function fetchPageImage(url) {
  try {
    const html = await get(url, { ua: BROWSER_UA, timeoutMs: 8000 });
    const tags = [...html.matchAll(/<meta\b[^>]*>/gi)].map(match => match[0]);
    for (const key of ['og:image', 'twitter:image']) {
      const meta = tags.find(tag =>
        new RegExp(`(?:property|name)\\s*=\\s*["']${key.replace(':', '\\:')}["']`, 'i').test(tag));
      const raw = meta?.match(/content\s*=\s*["']([^"']+)["']/i)?.[1]
        ?.replace(/&amp;/g, '&');
      if (!raw) continue;
      const resolved = new URL(raw, url);
      if (resolved.protocol === 'http:' || resolved.protocol === 'https:') return resolved.href;
    }
  } catch {
    // Article pages frequently block bots; RSS images remain the preferred path.
  }
  return null;
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

/** Worth a second try: rate limits, upstream hiccups, and our own timeout. */
function isTransient(err, { retry403 = false } = {}) {
  if (retry403 && /HTTP 403/.test(err?.message || '')) return true;
  return /HTTP (429|500|502|503|504)|aborted/i.test(err?.message || '');
}

/**
 * fetch with a timeout, a UA, and optional retries — some hosts 403 an absent
 * or non-browser User-Agent, and arXiv 429s cloud egress on the first ask but
 * usually answers a beat later.
 */
async function get(url, {
  headers = {},
  json = false,
  ua = uaFor(url),
  attempts = 1,
  backoffMs = 3000,
  timeoutMs = FETCH_TIMEOUT_MS,
  retry403 = false,
} = {}) {
  let lastErr;
  for (let attempt = 0; attempt < attempts; attempt++) {
    if (attempt) await sleep(backoffMs * attempt);
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        headers: { 'User-Agent': ua, Accept: json ? 'application/json' : '*/*', ...headers },
        signal: ctrl.signal,
      });
      if (!res.ok) throw new Error(`HTTP ${res.status}`);
      return json ? await res.json() : await res.text();
    } catch (err) {
      lastErr = err;
      if (!isTransient(err, { retry403 })) break;
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastErr;
}

const iso = ms => new Date(ms).toISOString();

/** Case-insensitive keyword match over title + snippet. */
function matchesKeywords(item, keywords) {
  if (!keywords?.length) return true;
  const hay = `${item.title} ${item.snippet || ''}`.toLowerCase();
  return keywords.some(k => hay.includes(k.toLowerCase()));
}

// ---------------------------------------------------------------------------
// Hacker News — Algolia search API. No key, generous limits.
// ---------------------------------------------------------------------------
export async function fetchHackerNews(cfg, sinceMs) {
  if (!cfg?.enabled) return [];
  const out = [];
  const minPoints = cfg.minPoints ?? 40;
  const sinceSec = Math.floor(sinceMs / 1000);

  for (const query of cfg.queries ?? []) {
    try {
      const url =
        'https://hn.algolia.com/api/v1/search?' +
        new URLSearchParams({
          query,
          tags: 'story',
          numericFilters: `created_at_i>${sinceSec},points>${minPoints}`,
          hitsPerPage: '20',
        });
      const data = await get(url, { json: true });
      for (const hit of data?.hits ?? []) {
        if (!hit.title) continue;
        const storyUrl = hit.url || `https://news.ycombinator.com/item?id=${hit.objectID}`;
        out.push({
          id: `hn-${hit.objectID}`,
          title: hit.title,
          url: storyUrl,
          source: 'Hacker News',
          sourceKind: 'discussion',
          publishedAt: hit.created_at || iso(hit.created_at_i * 1000),
          snippet: stripHtml(hit.story_text || hit._highlightResult?.title?.value || '', 400),
          score: hit.points ?? 0,
          discussionUrl: `https://news.ycombinator.com/item?id=${hit.objectID}`,
        });
      }
    } catch (err) {
      warn(`Hacker News "${query}"`, err);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// arXiv — daily announcement RSS per category, query API as a fallback.
// ---------------------------------------------------------------------------
export async function fetchArxiv(cfg, sinceMs) {
  if (!cfg?.enabled) return [];
  const cats = cfg.categories ?? [];
  if (!cats.length) return [];
  const out = [];

  const perCat = cfg.maxPerCategory ?? 12;
  const seen = new Set();

  const push = (entry, cat) => {
    // arXiv ids look like https://arxiv.org/abs/2607.01234v1
    const idMatch = entry.url.match(/abs\/([^v]+?)(?:v\d+)?$/);
    const id = `arxiv-${idMatch ? idMatch[1] : entry.url.slice(-16)}`;
    if (seen.has(id)) return; // cross-listed papers appear in several categories
    seen.add(id);
    // Label with the paper's own category when the feed gives us one, so the
    // app keeps showing "arXiv cs.AI" and not a flat "arXiv".
    const own = (entry.categories ?? []).find(c => cats.includes(c));
    out.push({
      id,
      title: entry.title.replace(/\s+/g, ' '),
      url: entry.url,
      source: `arXiv ${own || cat}`.trim(),
      sourceKind: 'paper',
      publishedAt: entry.publishedAt,
      // The RSS abstracts open with "arXiv:2607.01234v1 Announce Type: new
      // Abstract: …" — boilerplate we'd otherwise pay curation tokens for.
      snippet: (entry.snippet || '').replace(/^arXiv:\S+\s*Announce Type:\s*\S+\s*Abstract:\s*/i, ''),
    });
  };

  // Preferred path: the announcement RSS feeds on rss.arxiv.org. The query API
  // on export.arxiv.org throttles shared cloud egress so hard that the runner
  // harvested zero papers on every run — 429 per category, and 429 again when
  // collapsed to one combined request. rss.arxiv.org is a separate CDN-fronted
  // host serving the same daily submissions and doesn't throttle us.
  for (const cat of cats) {
    try {
      const xml = await get(`https://rss.arxiv.org/rss/${cat}`, { attempts: 2, backoffMs: 2000 });
      let kept = 0;
      for (const entry of parseFeed(xml)) {
        if (kept >= perCat) break;
        const when = entry.publishedAt ? Date.parse(entry.publishedAt) : Date.now();
        if (when < sinceMs) continue;
        push(entry, cat);
        kept++;
      }
    } catch (err) {
      warn(`arXiv rss ${cat}`, err);
    }
  }
  if (out.length) return out;

  // Fallback: one combined `cat:A OR cat:B` query against the API. Kept for the
  // case where the RSS host is down — never split this back out per category.
  warn('arXiv rss', 'no papers from rss.arxiv.org — falling back to the query API');
  try {
    const url =
      'https://export.arxiv.org/api/query?' +
      new URLSearchParams({
        search_query: cats.map(c => `cat:${c}`).join(' OR '),
        sortBy: 'submittedDate',
        sortOrder: 'descending',
        max_results: String(Math.min(perCat * cats.length, 100)),
      });
    const xml = await get(url, { attempts: 3, backoffMs: 4000, timeoutMs: 30000 });
    for (const entry of parseFeed(xml)) {
      const when = entry.publishedAt ? Date.parse(entry.publishedAt) : Date.now();
      if (when < sinceMs) continue;
      push(entry, '');
    }
  } catch (err) {
    warn(`arXiv (${cats.join(', ')})`, err);
  }
  return out;
}

// ---------------------------------------------------------------------------
// Hugging Face — daily papers + trending text-generation models.
// ---------------------------------------------------------------------------
export async function fetchHuggingFace(cfg, sinceMs) {
  if (!cfg?.enabled) return [];
  const out = [];

  if (cfg.dailyPapers) {
    try {
      const data = await get('https://huggingface.co/api/daily_papers', { json: true, attempts: 2 });
      for (const row of Array.isArray(data) ? data : []) {
        const p = row.paper ?? row;
        const id = p.id || row.id;
        if (!id || !(p.title || row.title)) continue;
        const publishedAt = row.publishedAt || p.publishedAt || null;
        if (publishedAt && Date.parse(publishedAt) < sinceMs) continue;
        out.push({
          id: `hf-paper-${id}`,
          title: (p.title || row.title).replace(/\s+/g, ' ').trim(),
          url: `https://huggingface.co/papers/${id}`,
          source: 'HF Daily Papers',
          sourceKind: 'paper',
          publishedAt,
          snippet: stripHtml(p.summary || row.summary || '', 500),
          score: p.upvotes ?? row.upvotes ?? 0,
        });
      }
    } catch (err) {
      warn('HF daily papers', err);
    }
  }

  if (cfg.trendingModels) {
    try {
      const url =
        'https://huggingface.co/api/models?' +
        new URLSearchParams({
          sort: 'createdAt',
          direction: '-1',
          limit: String(cfg.maxModels ?? 15),
          filter: 'text-generation',
        });
      const data = await get(url, { json: true, attempts: 2 });
      for (const m of Array.isArray(data) ? data : []) {
        if (!m.id) continue;
        const createdAt = m.createdAt || null;
        if (createdAt && Date.parse(createdAt) < sinceMs) continue;
        // Skip the long tail of personal finetunes — no downloads, no signal.
        if ((m.downloads ?? 0) < 50 && (m.likes ?? 0) < 5) continue;
        out.push({
          id: `hf-model-${m.id.replace(/\//g, '--')}`,
          title: `${m.id} (model weights published)`,
          url: `https://huggingface.co/${m.id}`,
          source: 'Hugging Face',
          sourceKind: 'model',
          publishedAt: createdAt,
          snippet: `Pipeline: ${m.pipeline_tag ?? 'text-generation'}. Downloads: ${m.downloads ?? 0}. Likes: ${m.likes ?? 0}. Tags: ${(m.tags ?? []).slice(0, 8).join(', ')}`,
          score: m.likes ?? 0,
        });
      }
    } catch (err) {
      warn('HF models', err);
    }
  }

  return out;
}

// ---------------------------------------------------------------------------
// GitHub — repo search. Authenticated in CI via GITHUB_TOKEN (5000 req/h vs 60).
// ---------------------------------------------------------------------------
export async function fetchGitHub(cfg, sinceMs) {
  if (!cfg?.enabled) return [];
  const out = [];
  const token = process.env.GITHUB_TOKEN;
  const headers = {
    Accept: 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  };
  // Filter on `created:`, not `pushed:` — "pushed recently" matches every
  // long-established mega-repo (ollama, dify, langroid) and they dominate on
  // star count every single run. We want projects that are actually new, which
  // is why minStars is modest: a 3-week-old repo can't have 10k stars.
  const createdSince = new Date(
    Date.now() - (cfg.createdWithinDays ?? 45) * 86_400_000,
  )
    .toISOString()
    .slice(0, 10);

  for (const query of cfg.queries ?? []) {
    try {
      const url =
        'https://api.github.com/search/repositories?' +
        new URLSearchParams({
          q: `${query} stars:>${cfg.minStars ?? 120} created:>${createdSince}`,
          sort: 'stars',
          order: 'desc',
          per_page: String(cfg.maxPerQuery ?? 8),
        });
      const data = await get(url, { json: true, headers });
      for (const repo of data?.items ?? []) {
        if (!repo.full_name) continue;
        out.push({
          id: `gh-${repo.id}`,
          title: `${repo.full_name} — ${repo.description || 'no description'}`.slice(0, 240),
          url: repo.html_url,
          source: 'GitHub',
          sourceKind: 'repo',
          publishedAt: repo.created_at,
          snippet: `${repo.description || ''} · ${repo.stargazers_count} stars · ${repo.language || 'n/a'} · created ${repo.created_at?.slice(0, 10)} · last push ${repo.pushed_at?.slice(0, 10)}`,
          score: repo.stargazers_count ?? 0,
        });
      }
    } catch (err) {
      warn(`GitHub "${query}"`, err);
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Reddit — public .json endpoints. Bot-protected: the honest UA gets a flat 403
// from every IP we've tried, and even with a browser UA one endpoint shape can
// be blocked while another answers. So we try three shapes per subreddit and
// take the first that returns items. Still a bonus source, never a dependency.
// ---------------------------------------------------------------------------
export async function fetchReddit(cfg, sinceMs) {
  if (!cfg?.enabled) return [];
  const out = [];
  const limit = cfg.maxPerSub ?? 12;
  const minScore = cfg.minScore ?? 80;

  const subs = cfg.subreddits ?? [];
  for (const [i, sub] of subs.entries()) {
    // Reddit throttles per IP, not per subreddit: on the runner the first sub
    // answered and the next two 403'd on every shape. Space them out.
    if (i) await sleep(2500);

    const attempts = [
      { kind: 'json', url: `https://www.reddit.com/r/${sub}/top.json?t=day&limit=${limit}&raw_json=1` },
      { kind: 'json', url: `https://old.reddit.com/r/${sub}/top.json?t=day&limit=${limit}&raw_json=1` },
      { kind: 'rss', url: `https://www.reddit.com/r/${sub}/top/.rss?t=day&limit=${limit}` },
    ];

    let got = 0;
    const errors = [];
    for (const attempt of attempts) {
      try {
        if (attempt.kind === 'json') {
          const data = await get(attempt.url, {
            json: true,
            attempts: 3,
            backoffMs: 4000,
            retry403: true, // a 403 here is throttling, not a permanent refusal
          });
          for (const child of data?.data?.children ?? []) {
            const p = child?.data;
            if (!p?.title || p.stickied) continue;
            if ((p.score ?? 0) < minScore) continue;
            const createdMs = (p.created_utc ?? 0) * 1000;
            if (createdMs < sinceMs) continue;
            out.push({
              id: `reddit-${p.id}`,
              title: p.title,
              // Link posts point outward; self posts point at the thread.
              url: p.is_self ? `https://www.reddit.com${p.permalink}` : p.url_overridden_by_dest || p.url,
              source: `r/${sub}`,
              sourceKind: 'discussion',
              publishedAt: iso(createdMs),
              snippet: stripHtml(p.selftext || '', 400),
              score: p.score ?? 0,
              discussionUrl: `https://www.reddit.com${p.permalink}`,
            });
            got++;
          }
        } else {
          // The .rss shape carries no score, so minScore can't be applied here.
          // These land with score 0 and have to earn their place on recency and
          // keyword hits in preRank — which is the right outcome for a fallback.
          const entries = parseFeed(
            await get(attempt.url, { attempts: 3, backoffMs: 4000, retry403: true }),
          );
          for (const e of entries) {
            if (e.publishedAt && Date.parse(e.publishedAt) < sinceMs) continue;
            out.push({
              id: `reddit-rss-${e.url.replace(/[^a-z0-9]+/gi, '').slice(-24)}`,
              title: e.title,
              url: e.url,
              source: `r/${sub}`,
              sourceKind: 'discussion',
              publishedAt: e.publishedAt,
              snippet: e.snippet,
              score: 0,
              discussionUrl: e.url,
            });
            got++;
          }
        }
        if (got) break;
      } catch (err) {
        errors.push(`${new URL(attempt.url).host}${attempt.kind === 'rss' ? ' (rss)' : ''}: ${err?.message || err}`);
      }
    }
    // Only complain once per subreddit, and only if every shape failed.
    if (!got && errors.length) warn(`r/${sub}`, errors.join(' | '));
  }
  return out;
}

// ---------------------------------------------------------------------------
// RSS / Atom — lab blogs and newsletters. Keyword-filtered, since a lab blog
// also posts hiring and policy pieces we don't want in an AI-trend digest.
// ---------------------------------------------------------------------------
export async function fetchRss(feeds, sinceMs, keywords) {
  if (!feeds?.length) return [];
  const results = await Promise.all(
    feeds.map(async feed => {
      try {
        const xml = await get(feed.url);
        const entries = parseFeed(xml);
        if (entries.length === 0) {
          warn(feed.name, 'parsed 0 entries (feed shape changed?)');
          return [];
        }
        const picked = entries
          .filter(e => {
            // No date means we can't window it. Keep it — first-party lab posts
            // without dates are rare and usually worth seeing.
            if (!e.publishedAt) return true;
            return Date.parse(e.publishedAt) >= sinceMs;
          })
          // `alwaysKeep` bypasses the keyword gate. Needed for the feeds we
          // added for technique coverage: a Claude Code changelog entry reads
          // "Fixed /resume on Windows" and matches none of our model-shaped
          // keywords, so keyword filtering silently emptied exactly the feeds
          // that carry the most actionable content.
          .filter(e => (feed.kind === 'lab' || feed.alwaysKeep ? true : matchesKeywords(e, keywords)));

        // Per-feed cap for chatty feeds (a commits.atom fires on every merge).
        // Entries are newest-first, so slicing keeps the freshest.
        return (feed.maxItems ? picked.slice(0, feed.maxItems) : picked)
          .map(e => ({
            // Feed URLs are stable identifiers; hash-free slug keeps it readable.
            id: `rss-${feed.name.toLowerCase().replace(/[^a-z0-9]+/g, '-')}-${e.url.replace(/[^a-z0-9]+/gi, '').slice(-24)}`,
            title: e.title,
            url: e.url,
            source: feed.name,
            sourceKind: feed.kind || 'news',
            publishedAt: e.publishedAt,
            snippet: e.snippet,
            ...(e.imageUrl ? { imageUrl: e.imageUrl } : {}),
          }));
      } catch (err) {
        warn(feed.name, err);
        return [];
      }
    }),
  );
  return results.flat();
}

// ---------------------------------------------------------------------------
// Orchestration
// ---------------------------------------------------------------------------

/**
 * Normalise a URL for dedupe: drop tracking params, trailing slash, scheme.
 * Exported for reuse by the news pipeline (scripts/lib/news-sources.mjs),
 * which needs the exact same canonicalisation for its own exact-URL dedupe.
 */
export function dedupeKey(url) {
  try {
    const u = new URL(url);
    for (const p of [...u.searchParams.keys()]) {
      if (/^(utm_|ref|source|fbclid|gclid)/i.test(p)) u.searchParams.delete(p);
    }
    return `${u.host.replace(/^www\./, '')}${u.pathname.replace(/\/$/, '')}${u.search}`.toLowerCase();
  } catch {
    return String(url).toLowerCase();
  }
}

/** Normalise a title for near-duplicate detection across sources. */
export function titleKey(title) {
  return String(title)
    .toLowerCase()
    .replace(/[^a-z0-9 ]/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 70);
}

/**
 * Fetch every enabled source in parallel, then dedupe.
 *
 * The same story routinely arrives via HN, Reddit, and a newsletter. We keep the
 * richest copy (highest score, preferring first-party `lab`/`model` kinds) and
 * fold the others' discussion links into it, so the AI pays for one item, not three.
 */
export async function fetchAll(config, sinceMs) {
  const keywords = config.keywords ?? [];
  console.log('Fetching sources…');

  const batches = await Promise.all([
    fetchHackerNews(config.hackerNews, sinceMs),
    fetchArxiv(config.arxiv, sinceMs),
    fetchHuggingFace(config.huggingFace, sinceMs),
    fetchGitHub(config.github, sinceMs),
    fetchReddit(config.reddit, sinceMs),
    fetchRss(config.rss, sinceMs, keywords),
  ]);

  const labels = ['Hacker News', 'arXiv', 'Hugging Face', 'GitHub', 'Reddit', 'RSS'];
  batches.forEach((b, i) => console.log(`  ${labels[i]}: ${b.length}`));

  const raw = batches.flat();

  // First-party announcements outrank aggregators when they collide.
  // `release` and `tooling` were missing here: an unranked kind scores 0 and
  // always loses a dedupe collision to any other copy. `release` outranks `lab`
  // because a changelog entry is the most precise account of what changed.
  const kindRank = {
    release: 6, lab: 5, model: 4, repo: 3, paper: 3, tooling: 3, news: 2, discussion: 1, other: 0,
  };
  const byUrl = new Map();
  const byTitle = new Map();

  for (const item of raw) {
    const uKey = dedupeKey(item.url);
    const tKey = titleKey(item.title);
    const existing = byUrl.get(uKey) ?? byTitle.get(tKey);

    if (!existing) {
      byUrl.set(uKey, item);
      byTitle.set(tKey, item);
      continue;
    }

    // Keep whichever copy carries more signal; preserve the loser's discussion link.
    const incomingRank = kindRank[item.sourceKind] ?? 0;
    const existingRank = kindRank[existing.sourceKind] ?? 0;
    const better =
      incomingRank > existingRank ||
      (incomingRank === existingRank && (item.score ?? 0) > (existing.score ?? 0));

    if (better) {
      item.discussionUrl = item.discussionUrl || existing.discussionUrl;
      item.score = Math.max(item.score ?? 0, existing.score ?? 0);
      byUrl.set(uKey, item);
      byTitle.set(tKey, item);
      // Re-point the loser's URL key at the winner so a third copy also folds in.
      byUrl.set(dedupeKey(existing.url), item);
    } else {
      existing.discussionUrl = existing.discussionUrl || item.discussionUrl;
      existing.score = Math.max(existing.score ?? 0, item.score ?? 0);
      byUrl.set(uKey, existing);
      byTitle.set(tKey, existing);
    }
  }

  const deduped = [...new Set(byUrl.values())];
  console.log(`  → ${raw.length} raw, ${deduped.length} after dedupe`);
  return deduped;
}

/**
 * How much of the candidate set any one kind may occupy.
 *
 * Without this, GitHub wins everything. A repo's `score` is its star count, so
 * the engagement term saturates at 40 for anything over ~150 stars, while a
 * changelog entry or a blog post has no score at all and starts from 0. Measured
 * on a real run: 58 of the top 70 were GitHub repos and not one release-feed or
 * newsletter item survived — the feeds carrying the actual techniques were
 * fetched and then discarded. Kinds absent here are uncapped, because they're
 * the scarce ones we're protecting.
 */
const KIND_QUOTA = { repo: 0.3, discussion: 0.25, paper: 0.05 };

/**
 * Heuristic pre-rank so we only pay AI tokens for plausible candidates.
 * Cheap signals only: engagement score, first-party-ness, recency, keyword hits.
 *
 * Ranking is by score, but selection is quota'd per kind so one high-volume,
 * high-score source can't crowd out every other kind. Leftover slots are
 * backfilled by score, so a quiet day still returns a full set.
 */
export function preRank(items, keywords, limit) {
  const now = Date.now();
  // Mirrors kindRank's ordering. `release` leads and `paper` is demoted below
  // `news`: a changelog entry names a flag you can set tonight, a preprint
  // almost never does. `tooling` was absent entirely, which scored the Ollama
  // feed at 0 and kept it out of every run's top 70.
  const kindBoost = {
    release: 34, lab: 30, model: 20, tooling: 16, repo: 12, news: 8, paper: 5, discussion: 4, other: 0,
  };

  const scored = items.map(item => {
    let s = 0;
    s += Math.min(40, Math.log10((item.score ?? 0) + 1) * 18);
    s += kindBoost[item.sourceKind] ?? 0;
    const ageHours = item.publishedAt ? (now - Date.parse(item.publishedAt)) / 3600000 : 48;
    s += Math.max(0, 24 - ageHours / 2);
    const hay = `${item.title} ${item.snippet ?? ''}`.toLowerCase();
    s += keywords.filter(k => hay.includes(k.toLowerCase())).length * 3;
    return { item, s };
  });

  scored.sort((a, b) => b.s - a.s);

  const caps = new Map(
    Object.entries(KIND_QUOTA).map(([kind, share]) => [kind, Math.max(1, Math.floor(limit * share))]),
  );
  const used = new Map();
  const picked = [];
  const deferred = [];

  for (const entry of scored) {
    if (picked.length >= limit) break;
    const kind = entry.item.sourceKind;
    const cap = caps.get(kind);
    const n = used.get(kind) ?? 0;
    if (cap !== undefined && n >= cap) {
      deferred.push(entry);
      continue;
    }
    used.set(kind, n + 1);
    picked.push(entry);
  }

  // Backfill in score order — an under-supplied day should still fill the set.
  for (const entry of deferred) {
    if (picked.length >= limit) break;
    picked.push(entry);
  }

  return picked.map(x => x.item);
}
