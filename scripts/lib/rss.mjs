/**
 * Minimal RSS 2.0 + Atom parser. Deliberately zero-dependency: this runs in CI
 * on every cron tick and a dependency tree is a supply-chain surface plus an
 * install step we don't need for what amounts to pulling four fields out of XML.
 *
 * Not a general-purpose XML parser. It handles the shapes real feeds emit and
 * gives up gracefully on anything else (returns fewer entries, never throws).
 */

/** Strip CDATA wrappers, decode the handful of entities feeds actually use. */
function decode(text) {
  if (!text) return '';
  let out = String(text).replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  out = out
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'")
    .replace(/&nbsp;/g, ' ')
    // Numeric entities, decimal and hex.
    .replace(/&#(\d+);/g, (_, d) => String.fromCharCode(Number(d)))
    .replace(/&#x([0-9a-fA-F]+);/g, (_, h) => String.fromCharCode(parseInt(h, 16)))
    // &amp; last, so "&amp;lt;" doesn't become "<".
    .replace(/&amp;/g, '&');
  return out.trim();
}

/** Drop markup and collapse whitespace — feed descriptions are full of HTML. */
export function stripHtml(html, maxLen = 600) {
  const text = decode(String(html || '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<[^>]+>/g, ' '))
    .replace(/\s+/g, ' ')
    .trim();
  return text.length > maxLen ? `${text.slice(0, maxLen)}…` : text;
}

/** First matching tag's inner text. Handles attributes on the open tag. */
function tag(xml, name) {
  const m = xml.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return m ? decode(m[1]) : '';
}

/** Atom links: <link rel="alternate" href="..."/>. Prefer alternate, else first. */
function atomLink(xml) {
  const links = [...xml.matchAll(/<link\b([^>]*)\/?>/gi)].map(m => m[1]);
  const hrefOf = attrs => {
    const h = attrs.match(/href\s*=\s*["']([^"']+)["']/i);
    return h ? decode(h[1]) : '';
  };
  const alternate = links.find(a => /rel\s*=\s*["']alternate["']/i.test(a));
  if (alternate) return hrefOf(alternate);
  const plain = links.find(a => !/rel\s*=\s*["']/i.test(a) || /rel\s*=\s*["']self["']/i.test(a) === false);
  return plain ? hrefOf(plain) : '';
}

/**
 * Category terms. Atom puts them in an attribute (`<category term="cs.AI"/>`,
 * which is how arXiv tags papers); RSS uses element text.
 */
function categories(xml) {
  const out = [];
  for (const m of xml.matchAll(/<category\b([^>]*?)(?:\/>|>([\s\S]*?)<\/category>)/gi)) {
    const term = m[1]?.match(/term\s*=\s*["']([^"']+)["']/i);
    const value = decode(term ? term[1] : m[2] || '');
    if (value) out.push(value);
  }
  return out;
}

function parseDate(raw) {
  if (!raw) return null;
  const t = Date.parse(raw);
  return Number.isNaN(t) ? null : new Date(t).toISOString();
}

function imageUrl(xml) {
  const candidates = [];
  for (const match of xml.matchAll(/<(?:media:content|media:thumbnail|enclosure)\b([^>]*)\/?>/gi)) {
    const attrs = match[1] || '';
    if (/^enclosure$/i.test(match[0].match(/^<([^ >]+)/)?.[1] || '') &&
        !/type\s*=\s*["']image\//i.test(attrs)) continue;
    const url = attrs.match(/url\s*=\s*["']([^"']+)["']/i)?.[1];
    if (url) candidates.push(decode(url));
  }

  const description = tag(xml, 'description') || tag(xml, 'content:encoded') || tag(xml, 'content');
  const embedded = description.match(/<img\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/i)?.[1];
  if (embedded) candidates.push(decode(embedded));

  const nested = tag(tag(xml, 'image'), 'url');
  if (nested) candidates.push(nested);
  return candidates.find(url => /^https?:\/\//i.test(url)) || null;
}

/**
 * Parse a feed body into entries: { title, url, publishedAt, snippet, categories }.
 * Returns [] for anything unparseable rather than throwing — one broken feed
 * must not take down an aggregation run.
 */
export function parseFeed(xml) {
  if (!xml || typeof xml !== 'string') return [];

  const blocks = [
    ...xml.matchAll(/<item(?:\s[^>]*)?>([\s\S]*?)<\/item>/gi),
    ...xml.matchAll(/<entry(?:\s[^>]*)?>([\s\S]*?)<\/entry>/gi),
  ].map(m => m[1]);

  const entries = [];
  for (const block of blocks) {
    const title = stripHtml(tag(block, 'title'), 300);
    // RSS puts the URL in <link>text</link>; Atom uses <link href="..."/>.
    const url = tag(block, 'link') || atomLink(block) || tag(block, 'guid');
    if (!title || !url || !/^https?:\/\//i.test(url)) continue;

    const publishedAt =
      parseDate(tag(block, 'pubDate')) ||
      parseDate(tag(block, 'published')) ||
      parseDate(tag(block, 'updated')) ||
      parseDate(tag(block, 'dc:date'));

    const snippet = stripHtml(
      tag(block, 'description') ||
        tag(block, 'summary') ||
        tag(block, 'content:encoded') ||
        tag(block, 'content'),
    );

    entries.push({
      title,
      url,
      publishedAt,
      snippet,
      categories: categories(block),
      imageUrl: imageUrl(block),
    });
  }
  return entries;
}
