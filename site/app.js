'use strict';

const REFRESH_MS = 5 * 60_000;
const STALE_AFTER_MS = 2 * 3600_000; // The job runs about every 15 minutes, so 2 hours means it has paused.
const FRESH_MS = 3600_000;

const $ = (id) => document.getElementById(id);
const dayFormat = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' });
const clockFormat = new Intl.DateTimeFormat('en', { month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit' });

let feed = null;

function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}

// Feed text is untrusted: it only ever reaches the page through textContent and https links.
function link(href, text) {
  const url = safeHttps(href);
  if (!url) return element('span', '', text);
  const anchor = element('a', '', text);
  anchor.href = url;
  anchor.target = '_blank';
  anchor.rel = 'noopener noreferrer';
  return anchor;
}

function safeHttps(href) {
  try {
    const url = new URL(href);
    return url.protocol === 'https:' ? url.href : null;
  } catch {
    return null;
  }
}

function timeAgo(iso) {
  const minutes = Math.max(0, Math.round((Date.now() - Date.parse(iso)) / 60_000));
  if (minutes < 1) return 'just now';
  if (minutes < 60) return `${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `${hours} hr ago`;
  const days = Math.round(hours / 24);
  return `${days} day${days === 1 ? '' : 's'} ago`;
}

function sparkline(values, label) {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  const width = 200;
  const height = 36;
  svg.setAttribute('viewBox', `0 0 ${width} ${height}`);
  svg.setAttribute('preserveAspectRatio', 'none');
  svg.setAttribute('role', 'img');
  svg.setAttribute('aria-label', label);
  if (values.length < 2) return svg;
  const low = Math.min(...values);
  const span = Math.max(...values) - low || 1;
  const points = values.map((value, i) => {
    const x = (i / (values.length - 1)) * width;
    const y = height - 3 - ((value - low) / span) * (height - 6);
    return `${x.toFixed(1)},${y.toFixed(1)}`;
  });
  const path = document.createElementNS(NS, 'path');
  path.setAttribute('d', `M${points.join('L')}`);
  svg.append(path);
  return svg;
}

function formatValue(market) {
  const number = market.latest.toLocaleString('en', { minimumFractionDigits: market.digits, maximumFractionDigits: market.digits });
  if (market.unit === '$') return `$${number}`;
  return `${number}${market.unit}`;
}

function formatChange(market) {
  if (market.change === null || market.change === undefined) return 'No 7-day comparison';
  const digits = market.changeUnit === 'pts' ? 2 : 1;
  const size = Math.abs(market.change).toFixed(digits);
  if (Number(size) === 0) return `Unchanged over 7 days`;
  const sign = market.change < 0 ? '−' : '+';
  return `${sign}${size}${market.changeUnit === 'pts' ? ' pts' : '%'} over 7 days`;
}

function renderMarkets() {
  $('markets').replaceChildren(...feed.markets.map((market) => {
    const card = element('article', 'market');
    const source = element('p', 'market-source');
    source.append(`As of ${dayFormat.format(new Date(`${market.asOf}T00:00:00Z`))} · `, link(market.home, market.credit));
    card.append(
      element('h3', '', market.name),
      element('p', 'market-note', market.note),
      element('p', 'market-value', formatValue(market)),
      element('p', 'market-change', formatChange(market)),
      sparkline(market.trend, `${market.name}, last 90 days`),
      source,
    );
    return card;
  }));
}

function renderStories(section) {
  const names = new Map(feed.sources.map((source) => [source.id, source]));
  const items = feed.items.filter((item) => item.section === section);
  if (!items.length) {
    $(section).replaceChildren(element('li', 'empty', 'No stories passed the filter in this update.'));
    return;
  }
  $(section).replaceChildren(...items.map((item) => {
    const source = names.get(item.source);
    const row = element('li', 'story');
    const meta = element('div', 'meta');
    const when = element('time', Date.now() - Date.parse(item.published) < FRESH_MS ? 'is-fresh' : '', timeAgo(item.published));
    when.dateTime = item.published;
    when.title = clockFormat.format(new Date(item.published));
    meta.append(element('span', '', source?.name ?? item.source), when);
    if (source?.kind === 'Official') meta.append(element('span', 'chip', 'Official source'));
    row.append(link(item.link, item.title), meta);
    return row;
  }));
}

function renderSources() {
  $('sources').replaceChildren(...feed.sources.map((source) => {
    const row = element('tr');
    const name = element('td');
    name.append(link(source.home, source.name));
    const update = source.ok
      ? element('td', '', timeAgo(source.lastSuccess))
      : element('td', 'is-failed', source.lastSuccess ? `Not responding. Last worked ${timeAgo(source.lastSuccess)}` : 'Not responding');
    row.append(name, element('td', '', source.kind), element('td', '', source.note), update);
    return row;
  }));
}

function renderRemoved() {
  const parts = Object.entries(feed.removed).filter(([reason, count]) => count > 0 && reason !== 'too old' && reason !== 'incomplete');
  $('removed').textContent = parts.length
    ? `Removed in the latest update: ${parts.map(([reason, count]) => `${count} ${reason}`).join(', ')}.`
    : '';
}

function renderStatus(loadFailed) {
  const status = $('status');
  const age = Date.now() - Date.parse(feed.generatedAt);
  const stale = age > STALE_AFTER_MS;
  status.textContent = `Updated ${timeAgo(feed.generatedAt)}`;
  status.classList.toggle('is-stale', stale);
  const notice = $('notice');
  notice.hidden = !stale && !loadFailed;
  if (stale) notice.textContent = `Updates appear to have paused. These headlines are from ${timeAgo(feed.generatedAt)}.`;
  else if (loadFailed) notice.textContent = 'Could not check for new headlines. Showing the last ones loaded, and trying again shortly.';
}

function renderAll() {
  renderMarkets();
  renderStories('world');
  renderStories('finance');
  renderSources();
  renderRemoved();
  renderStatus(false);
}

async function load() {
  try {
    const response = await fetch(`data/feed.json?t=${Date.now()}`, { cache: 'no-store' });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    feed = await response.json();
    renderAll();
  } catch (error) {
    console.warn('Feed load failed:', error);
    if (feed) {
      renderStatus(true);
    } else {
      $('status').textContent = 'Not loaded';
      $('notice').textContent = 'Could not load the headlines. Check your connection and reload this page.';
      $('notice').hidden = false;
    }
  }
}

load();
setInterval(load, REFRESH_MS);
// Background tabs throttle timers, so catch up when the reader comes back.
document.addEventListener('visibilitychange', () => { if (!document.hidden) load(); });
