import test from 'node:test';
import assert from 'node:assert/strict';
import {
  parseRss, safeLink, rejectionReason, dropDuplicates, selectItems, parseFredCsv, parseEcbUsd, summarize,
} from './feed-lib.mjs';

test('parseRss reads CDATA, entities, double escaping and tags', () => {
  const xml = `<rss><channel><title>Feed name</title>
    <item><title><![CDATA[Aid & <b>relief</b>]]></title><link>https://a.org/1</link><pubDate>Fri, 06 Nov 2026 10:00:00 GMT</pubDate></item>
    <item><title>Iran&amp;#39;s plan &#x2014; talks</title><guid>https://a.org/2</guid><dc:date>2026-11-06T10:00:00Z</dc:date></item>
  </channel></rss>`;
  assert.deepEqual(parseRss(xml), [
    { title: 'Aid & relief', link: 'https://a.org/1', date: 'Fri, 06 Nov 2026 10:00:00 GMT' },
    { title: "Iran's plan — talks", link: 'https://a.org/2', date: '2026-11-06T10:00:00Z' },
  ]);
});

test('parseRss cannot smuggle markup through escaped tags', () => {
  const [item] = parseRss('<item><title>&lt;script&gt;alert(1)&lt;/script&gt;News</title></item>');
  assert.equal(item.title.includes('<'), false);
});

test('safeLink keeps only links on the source domain and upgrades http', () => {
  assert.equal(safeLink('http://news.un.org/a', 'un.org'), 'https://news.un.org/a');
  assert.equal(safeLink('https://un.org/a', 'un.org'), 'https://un.org/a');
  assert.equal(safeLink('https://un.org.evil.com/a', 'un.org'), null);
  assert.equal(safeLink('https://notun.org/a', 'un.org'), null);
  assert.equal(safeLink('javascript:alert(1)', 'un.org'), null);
  assert.equal(safeLink('not a url', 'un.org'), null);
});

test('safeLink repairs the malformed links real feeds send', () => {
  assert.equal(safeLink('https://www.ecb.europa.eu//press/a.html', 'ecb.europa.eu'), 'https://www.ecb.europa.eu/press/a.html');
  assert.equal(safeLink('https://news.un.org/feed/view/en/story/1', 'un.org'), 'https://news.un.org/en/story/1');
});

test('rejectionReason removes opinion, tips, sport and non-articles but keeps news', () => {
  const site = 'https://x.org/news/1';
  assert.equal(rejectionReason('Peace talks resume', site), null);
  assert.equal(rejectionReason('Fed holds rates steady', 'https://x.org/2026/11/fed.html'), null);
  assert.equal(rejectionReason('Peace talks', 'https://x.org/opinions/1'), 'opinion');
  assert.equal(rejectionReason('Opinion: the talks will fail', site), 'opinion');
  assert.equal(rejectionReason('3 stocks to buy now', site), 'market tips');
  assert.equal(rejectionReason('Cramer says buy Nvidia', site), 'market tips');
  assert.equal(rejectionReason('Team wins', 'https://x.org/sports/1'), 'sport or entertainment');
  assert.equal(rejectionReason('Watch: leaders meet', site), 'not an article');
  assert.equal(rejectionReason('Watchdog faults agency', site), null);
  assert.equal(rejectionReason('Federal Reserve Board announces approval of application by a bank', site), 'routine notice');
  assert.equal(rejectionReason('Federal Reserve issues FOMC statement', site), null);
  assert.equal(rejectionReason('Experts on what investors should do next', site), 'market tips');
  assert.equal(rejectionReason('Analysis: markets will hate it', site), 'opinion');
  assert.equal(rejectionReason('Jobs report explained', 'https://www.pbs.org/newshour/show/jobs'), null);
  assert.equal(rejectionReason('Enforcement action ends', 'https://x.org/pressreleases/enforcement20261105a.htm'), 'routine notice');
});

test('dropDuplicates keeps the first of near-identical headlines only', () => {
  const items = [
    { title: 'Democrats win control of the US Senate' },
    { title: 'Democrats win control of US Senate' },
    { title: 'Oil prices rise as tanker hit in Hormuz' },
  ];
  assert.deepEqual(dropDuplicates(items).map((i) => i.title), [items[0].title, items[2].title]);
});

test('selectItems filters, sorts newest first, caps and counts removals', () => {
  const now = Date.parse('2026-11-07T12:00:00Z');
  const source = { id: 's', section: 'world', domain: 'x.org', maxAgeHours: 48, maxItems: 2 };
  const removed = {};
  const raw = [
    { title: 'Older', link: 'https://x.org/1', date: '2026-11-06T12:00:00Z' },
    { title: 'Newest', link: 'https://x.org/2', date: '2026-11-07T11:00:00Z' },
    { title: 'Middle', link: 'https://x.org/3', date: '2026-11-07T01:00:00Z' },
    { title: 'Stale', link: 'https://x.org/4', date: '2026-11-01T01:00:00Z' },
    { title: 'Off site', link: 'https://evil.com/5', date: '2026-11-07T01:00:00Z' },
    { title: 'No date', link: 'https://x.org/6', date: 'soon' },
    { title: 'Opinion: nope', link: 'https://x.org/7', date: '2026-11-07T01:00:00Z' },
  ];
  assert.deepEqual(selectItems(raw, source, now, removed).map((i) => i.title), ['Newest', 'Middle']);
  assert.deepEqual(removed, { 'too old': 1, incomplete: 2, opinion: 1 });
});

test('parseFredCsv skips holidays and bad rows', () => {
  assert.deepEqual(parseFredCsv('observation_date,X\r\n2026-11-02,10.5\r\n2026-11-03,\r\nbad,1\r\n2026-11-04,11\r\n'), [
    { date: '2026-11-02', value: 10.5 },
    { date: '2026-11-04', value: 11 },
  ]);
});

test('parseEcbUsd reads the USD rate per day, oldest first', () => {
  const xml = `<Cube><Cube time="2026-11-06"><Cube currency="JPY" rate="170"/><Cube currency="USD" rate="1.12"/></Cube>
    <Cube time="2026-11-05"><Cube currency="USD" rate="1.11"/></Cube></Cube>`;
  assert.deepEqual(parseEcbUsd(xml), [{ date: '2026-11-05', value: 1.11 }, { date: '2026-11-06', value: 1.12 }]);
});

test('summarize measures from at least 7 days back, in percent or points', () => {
  const rows = [
    { date: '2026-10-28', value: 100 },
    { date: '2026-10-30', value: 200 },
    { date: '2026-11-02', value: 190 },
    { date: '2026-11-06', value: 150 },
  ];
  assert.equal(summarize(rows, false).change, -25);
  assert.equal(summarize(rows, true).change, -50);
  assert.equal(summarize(rows, false).asOf, '2026-11-06');
  assert.equal(summarize(rows.slice(-1), false).change, null);
  assert.equal(summarize([], false), null);
});
