// Collects the approved feeds and market data, filters them and writes site/data/feed.json.
import { mkdirSync, writeFileSync } from 'node:fs';
import {
  parseRss, selectItems, dropDuplicates, parseFredCsv, parseEcbUsd, summarize,
} from './feed-lib.mjs';

const OFFICIAL = 'Official';
const NEWSROOM = 'Newsroom';

// Official sources come first so duplicate headlines keep the official version.
// To add a source: confirm its dates are reliable and its terms allow this use.
const SOURCES = [
  { id: 'un', name: 'UN News', kind: OFFICIAL, section: 'world', domain: 'un.org', home: 'https://news.un.org/', maxAgeHours: 96, maxItems: 8,
    feed: 'https://news.un.org/feed/subscribe/en/news/all/rss.xml', note: "The UN's own news service." },
  { id: 'fed', name: 'Federal Reserve', kind: OFFICIAL, section: 'finance', domain: 'federalreserve.gov', home: 'https://www.federalreserve.gov/', maxAgeHours: 336, maxItems: 5,
    feed: 'https://www.federalreserve.gov/feeds/press_all.xml', note: 'US central bank press releases.' },
  { id: 'ecb', name: 'European Central Bank', kind: OFFICIAL, section: 'finance', domain: 'ecb.europa.eu', home: 'https://www.ecb.europa.eu/', maxAgeHours: 168, maxItems: 5,
    feed: 'https://www.ecb.europa.eu/rss/press.html', note: 'Euro area central bank releases and speeches.' },
  { id: 'npr-world', name: 'NPR World', kind: NEWSROOM, section: 'world', domain: 'npr.org', home: 'https://www.npr.org/sections/world/', maxAgeHours: 72, maxItems: 8,
    feed: 'https://feeds.npr.org/1004/rss.xml', note: 'US public radio.' },
  { id: 'pbs-world', name: 'PBS NewsHour', kind: NEWSROOM, section: 'world', domain: 'pbs.org', home: 'https://www.pbs.org/newshour/world', maxAgeHours: 72, maxItems: 8,
    feed: 'https://www.pbs.org/newshour/feeds/rss/world', note: 'US public television; often carries AP reports.' },
  { id: 'aljazeera', name: 'Al Jazeera', kind: NEWSROOM, section: 'world', domain: 'aljazeera.com', home: 'https://www.aljazeera.com/', maxAgeHours: 48, maxItems: 5,
    feed: 'https://www.aljazeera.com/xml/rss/all.xml', note: 'Funded by the government of Qatar, which is involved in US-Iran mediation.' },
  { id: 'cnbc', name: 'CNBC Economy', kind: NEWSROOM, section: 'finance', domain: 'cnbc.com', home: 'https://www.cnbc.com/economy/', maxAgeHours: 72, maxItems: 8,
    feed: 'https://www.cnbc.com/id/20910258/device/rss/rss.html', note: 'US business news network.' },
  { id: 'npr-business', name: 'NPR Business', kind: NEWSROOM, section: 'finance', domain: 'npr.org', home: 'https://www.npr.org/sections/business/', maxAgeHours: 96, maxItems: 6,
    feed: 'https://feeds.npr.org/1006/rss.xml', note: 'US public radio.' },
  { id: 'pbs-economy', name: 'PBS NewsHour Economy', kind: NEWSROOM, section: 'finance', domain: 'pbs.org', home: 'https://www.pbs.org/newshour/economy', maxAgeHours: 96, maxItems: 6,
    feed: 'https://www.pbs.org/newshour/feeds/rss/economy', note: 'US public television.' },
];

const fredUrl = (series, now) => {
  const start = new Date(now - 130 * 86400_000).toISOString().slice(0, 10);
  return `https://fred.stlouisfed.org/graph/fredgraph.csv?id=${series}&cosd=${start}`;
};
const fred = (series) => ({ url: (now) => fredUrl(series, now), parse: parseFredCsv, home: `https://fred.stlouisfed.org/series/${series}` });

// Stock indexes are deliberately absent: FRED marks S&P and Nasdaq data "Pre-Approval Required".
const MARKETS = [
  { id: 'ust10', name: 'US 10-year yield', note: 'Long-term government borrowing cost', unit: '%', digits: 2, inPoints: true, credit: 'Federal Reserve via FRED', ...fred('DGS10') },
  { id: 'ust2', name: 'US 2-year yield', note: 'Short-term rate expectations', unit: '%', digits: 2, inPoints: true, credit: 'Federal Reserve via FRED', ...fred('DGS2') },
  { id: 'fedfunds', name: 'Fed funds rate', note: 'Overnight rate banks actually pay', unit: '%', digits: 2, inPoints: true, credit: 'Federal Reserve via FRED', ...fred('DFF') },
  { id: 'vix', name: 'VIX', note: 'Expected US stock market swings', unit: '', digits: 2, inPoints: true, credit: 'CBOE via FRED', ...fred('VIXCLS') },
  { id: 'brent', name: 'Brent crude', note: 'Spot price, dollars a barrel. Futures quotes can differ', unit: '$', digits: 2, inPoints: false, credit: 'US EIA via FRED', ...fred('DCOILBRENTEU') },
  { id: 'eurusd', name: 'Euro', note: 'ECB reference rate, dollars per euro', unit: '', digits: 4, inPoints: false, credit: 'European Central Bank',
    url: () => 'https://www.ecb.europa.eu/stats/eurofxref/eurofxref-hist-90d.xml', parse: parseEcbUsd,
    home: 'https://www.ecb.europa.eu/stats/policy_and_exchange_rates/euro_reference_exchange_rates/html/index.en.html' },
];

async function fetchText(url) {
  const response = await fetch(url, {
    headers: { 'user-agent': 'WorldMarketsBrief/1.0' },
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`HTTP ${response.status}`);
  return response.text();
}

// The last published file lets one failed source keep its previous items instead of vanishing.
async function loadPrevious() {
  const url = process.env.PREVIOUS_FEED_URL;
  if (!url) return { items: [], sources: [], markets: [] };
  try {
    const previous = JSON.parse(await fetchText(url));
    return { items: previous.items ?? [], sources: previous.sources ?? [], markets: previous.markets ?? [] };
  } catch (error) {
    console.warn(`No previous feed: ${error.message}`);
    return { items: [], sources: [], markets: [] };
  }
}

async function collectSource(source, now, previous, removed) {
  const prior = previous.sources.find((entry) => entry.id === source.id);
  const info = { id: source.id, name: source.name, kind: source.kind, note: source.note, home: source.home };
  try {
    const items = selectItems(parseRss(await fetchText(source.feed)), source, now, removed);
    return { items, status: { ...info, ok: true, lastSuccess: new Date(now).toISOString() } };
  } catch (error) {
    console.warn(`${source.id} failed: ${error.message}`);
    const oldest = now - source.maxAgeHours * 3600_000;
    const items = previous.items.filter((item) => item.source === source.id && Date.parse(item.published) >= oldest);
    return { items, status: { ...info, ok: false, lastSuccess: prior?.lastSuccess ?? null } };
  }
}

async function collectMarket(market, now, previous) {
  const { id, name, note, unit, digits, credit, home } = market;
  try {
    const summary = summarize(market.parse(await fetchText(market.url(now))), market.inPoints);
    if (!summary) throw new Error('no rows');
    return { id, name, note, unit, digits, credit, home, changeUnit: market.inPoints ? 'pts' : '%', ...summary };
  } catch (error) {
    console.warn(`${id} failed: ${error.message}`);
    return previous.markets.find((entry) => entry.id === id) ?? null;
  }
}

const now = Date.now();
const previous = await loadPrevious();
const removed = {};
const collected = await Promise.all(SOURCES.map((source) => collectSource(source, now, previous, removed)));
const statuses = collected.map((entry) => entry.status);
const working = statuses.filter((status) => status.ok).length;

// Failing here keeps the last good version of the site online instead of publishing a mostly empty one.
if (working < SOURCES.length / 2) {
  console.error(`Only ${working} of ${SOURCES.length} sources responded; not publishing.`);
  process.exit(1);
}

const combined = collected.flatMap((entry) => entry.items);
const unique = dropDuplicates(combined);
removed.duplicate = combined.length - unique.length;
const items = unique.sort((a, b) => b.published.localeCompare(a.published));
const markets = (await Promise.all(MARKETS.map((market) => collectMarket(market, now, previous)))).filter(Boolean);

mkdirSync(new URL('../site/data/', import.meta.url), { recursive: true });
writeFileSync(new URL('../site/data/feed.json', import.meta.url), JSON.stringify({
  generatedAt: new Date(now).toISOString(), items, sources: statuses, markets, removed,
}));
console.log(`Wrote ${items.length} items from ${working}/${SOURCES.length} sources, ${markets.length} markets. Removed:`, removed);
