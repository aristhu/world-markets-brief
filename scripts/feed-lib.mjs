// Pure functions for reading and filtering feeds. No network here, so all of it is testable.

const NAMED = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decodeEntities(text) {
  return text.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (whole, body) => {
    if (body[0] !== '#') return NAMED[body.toLowerCase()] ?? whole;
    const code = body[1].toLowerCase() === 'x' ? parseInt(body.slice(2), 16) : Number(body.slice(1));
    return code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
  });
}

function cleanText(raw) {
  const cdata = raw.replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, '$1');
  // Decoding twice handles feeds that escape their entities twice (&amp;#39;).
  const decoded = decodeEntities(decodeEntities(cdata));
  return decoded.replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function tag(block, name) {
  const match = block.match(new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, 'i'));
  return match ? cleanText(match[1]) : '';
}

// shortcut: handles RSS 2.0 only, which every current source uses. Add Atom if a new source needs it.
export function parseRss(xml) {
  const items = xml.match(/<item\b[\s\S]*?<\/item>/gi) ?? [];
  return items.map((block) => ({
    title: tag(block, 'title'),
    link: tag(block, 'link') || tag(block, 'guid'),
    date: tag(block, 'pubDate') || tag(block, 'dc:date'),
  }));
}

// Feed content is untrusted: a link must be on the source's own site, and only https reaches the page.
export function safeLink(link, domain) {
  let url;
  try {
    url = new URL(link);
  } catch {
    return null;
  }
  if (url.protocol !== 'https:' && url.protocol !== 'http:') return null;
  if (url.hostname !== domain && !url.hostname.endsWith(`.${domain}`)) return null;
  url.protocol = 'https:';
  // The ECB's feed doubles slashes, and UN News links through a feed path that only redirects.
  url.pathname = url.pathname.replace(/\/{2,}/g, '/').replace(/^\/feed\/view\//, '/');
  return url.href;
}

const BLOCKED_PATHS = [
  { reason: 'opinion', pattern: /\/(opinion|opinions|commentary|perspectives?)\//i },
  { reason: 'sport or entertainment', pattern: /\/(sport|sports|entertainment|arts|lifestyle|culture|style|travel)\//i },
  { reason: 'not an article', pattern: /\/(video|videos|podcast|podcasts|program|programs|gallery|galleries|audio|quiz|quizzes)\//i },
  { reason: 'shopping or paywalled', pattern: /\/(select|pro)\//i },
  { reason: 'routine notice', pattern: /\/enforcement\d/i },
];

const BLOCKED_TITLES = [
  { reason: 'opinion', pattern: /^(opinion|commentary|perspective|editorial|letters?|analysis)\b/i },
  { reason: 'market tips', pattern: /\b(stocks? to (buy|sell|watch)|should you (buy|sell)|price targets?|top picks?|analyst calls|upgrades?\b.*\bdowngrades?|cramer|buy the dip|best .{0,30} to buy|how to invest|what investors should do)\b/i },
  { reason: 'sport or entertainment', pattern: /\b(nfl|nba|mlb|nhl|premier league|world cup|olympics?|oscars?|grammys?|celebrity|horoscope|box office|movie review)\b/i },
  { reason: 'routine notice', pattern: /\bapproval of (application|proposal)\b/i },
  { reason: 'not an article', pattern: /^(watch|listen|full episode|quiz|photos?|in pictures)\b|\b(full episode|news wrap|podcast)\b/i },
];

export function rejectionReason(title, link) {
  const path = new URL(link).pathname;
  return BLOCKED_PATHS.find((rule) => rule.pattern.test(path))?.reason
    ?? BLOCKED_TITLES.find((rule) => rule.pattern.test(title))?.reason
    ?? null;
}

const STOP_WORDS = new Set('a an and are as at be by for from has have in is it its of on or says said that the to was were will with after over'.split(' '));

function titleWords(title) {
  const words = title.toLowerCase().replace(/[^\p{L}\p{N}\s]/gu, ' ').split(/\s+/);
  return new Set(words.filter((word) => word && !STOP_WORDS.has(word)));
}

function isSameStory(a, b) {
  const shared = [...a].filter((word) => b.has(word)).length;
  return shared / (a.size + b.size - shared) >= 0.7;
}

// Keeps the first of near-identical headlines, so pass official sources first to prefer them.
export function dropDuplicates(items) {
  const kept = [];
  for (const item of items) {
    const words = titleWords(item.title);
    if (!kept.some((other) => isSameStory(words, other.words))) kept.push({ item, words });
  }
  return kept.map((entry) => entry.item);
}

// Turns one source's raw feed entries into the items the page shows, counting what was removed and why.
export function selectItems(raw, source, now, removed = {}) {
  const count = (reason) => { removed[reason] = (removed[reason] ?? 0) + 1; };
  const oldest = now - source.maxAgeHours * 3600_000;
  const selected = [];
  for (const entry of raw) {
    const link = safeLink(entry.link, source.domain);
    const time = Date.parse(entry.date);
    if (!entry.title || !link || Number.isNaN(time)) { count('incomplete'); continue; }
    if (time < oldest || time > now + 3600_000) { count('too old'); continue; }
    const reason = rejectionReason(entry.title, link);
    if (reason) { count(reason); continue; }
    selected.push({
      title: entry.title,
      link,
      published: new Date(time).toISOString(),
      source: source.id,
      section: source.section,
    });
  }
  return selected.sort((a, b) => b.published.localeCompare(a.published)).slice(0, source.maxItems);
}

export function parseFredCsv(csv) {
  return csv.trim().split(/\r?\n/).slice(1).flatMap((line) => {
    const [date, raw] = line.split(',');
    const value = Number(raw);
    return /^\d{4}-\d{2}-\d{2}$/.test(date) && raw?.trim() && Number.isFinite(value) ? [{ date, value }] : [];
  });
}

export function parseEcbUsd(xml) {
  const days = xml.match(/<Cube time="\d{4}-\d{2}-\d{2}">[\s\S]*?<\/Cube>\s*(?=<Cube time|<\/Cube>)/g) ?? [];
  const rows = days.flatMap((day) => {
    const date = day.match(/time="([\d-]+)"/)[1];
    const rate = day.match(/currency=["']USD["']\s+rate=["']([\d.]+)["']/);
    return rate ? [{ date, value: Number(rate[1]) }] : [];
  });
  return rows.sort((a, b) => a.date.localeCompare(b.date));
}

// Latest value and its change from the last value at least 7 days earlier.
export function summarize(rows, inPoints) {
  if (!rows.length) return null;
  const last = rows[rows.length - 1];
  const cutoff = new Date(Date.parse(last.date) - 7 * 86400_000).toISOString().slice(0, 10);
  const prior = rows.filter((row) => row.date <= cutoff).pop();
  const start = new Date(Date.parse(last.date) - 90 * 86400_000).toISOString().slice(0, 10);
  return {
    latest: last.value,
    asOf: last.date,
    change: prior ? (inPoints ? last.value - prior.value : (last.value / prior.value - 1) * 100) : null,
    trend: rows.filter((row) => row.date >= start).map((row) => row.value),
  };
}
