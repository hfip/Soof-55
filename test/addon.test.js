'use strict';

process.env.PROXY_SECRET = 'test-secret-only-not-for-deployment-123456789';
const test = require('node:test');
const assert = require('node:assert/strict');
const source = require('../lib/source');
const { Cache } = require('../lib/cache');
const proxy = require('../lib/proxy');
const handler = require('../api');

test('episode parsing preserves season and Arabic digits', () => {
  assert.deepEqual(source.coordinates('مسلسل تجربة الموسم ٢ الحلقة ١١ مترجمة'), { season: 2, episode: 11 });
  assert.deepEqual(source.coordinates('test-2026-s03e07'), { season: 3, episode: 7 });
  assert.deepEqual(source.coordinates('الموسم الثالث الحلقة 7'), { season: 3, episode: 7 });
});

test('content IDs cannot point to arbitrary URLs or routes', () => {
  const id = source.encodeId('https://shooflive.net/series/example/');
  assert.equal(source.decodeId(id), 'https://w8.shooflive.cyou/series/example/');
  assert.throws(() => source.encodeId('http://127.0.0.1/series/test/'));
  assert.throws(() => source.decodeId('shoof_' + Buffer.from('//127.0.0.1/').toString('base64url')));
  assert.throws(() => source.decodeId('shoof_' + Buffer.from('/series/../../health').toString('base64url')));
});

test('catalog extraction ignores unrelated links and placeholder images', () => {
  const rows = source.cards('<div class="block-post"><a href="/movies/example/" title="فيلم تجربة"><img data-src="/poster.jpg" src="data:image/gif;base64,aaa"></a></div><a href="/movies/ad/">advert</a>');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].type, 'movie');
  assert.equal(rows[0].poster, 'https://w8.shooflive.cyou/poster.jpg');
});

test('smart search cards use the current Shoof result layout', () => {
  const rows = source.cards('<section class="slv2-grid"><a class="slv2-card" href="/series/example/"><div class="slv2-poster"><img src="/poster.jpg"></div><div class="slv2-name">مسلسل تجربة</div></a></section>');
  assert.equal(rows.length, 1);
  assert.equal(rows[0].name, 'مسلسل تجربة');
  assert.equal(rows[0].type, 'series');
  assert.equal(rows[0].poster, 'https://w8.shooflive.cyou/poster.jpg');
});

test('archives paginate 100 items and deduplicate overlapping series pages before applying offsets', async () => {
  const http = require('../lib/http');
  const original = http.text;
  const requests = [];
  http.text = async url => {
    requests.push(url);
    const path = new URL(url).pathname;
    const match = path.match(/^\/(tvshows|movies)\/(?:page\/(\d+)\/)?$/);
    assert.ok(match, 'Catalog must use the dedicated archive, not the homepage');
    const folder = match[1], page = Number(match[2] || 1);
    const size = folder === 'tvshows' ? 40 : 50;
    const total = folder === 'tvshows' ? 140 : 135;
    const last = Math.ceil(total / size);
    // Reproduce overlapping series pages: page 3 repeats half of page 2,
    // and page 4 supplies enough later entries to fill the next batch.
    const start = folder === 'tvshows' && page === 3 ? 60 : folder === 'tvshows' && page === 4 ? 100 : (page - 1) * size;
    const html = Array.from({ length: Math.max(0, Math.min(size, total - start)) }, (_, i) =>
      `<div class="block-post"><a href="/${folder === 'tvshows' ? 'series' : 'movies'}/item-${start + i}/" title="Item ${start + i}"><img src="/poster.jpg"></a></div>`).join('');
    return html + `<a href="/${folder}/page/${last}/">Last</a>`;
  };
  try {
    for (const [type, id, total] of [['series', 'shoof-series', 140], ['movie', 'shoof-movies', 135]]) {
      const first = await source.catalog(type, id, '', 0);
      const next = await source.catalog(type, id, '', 100);
      assert.equal(first.length, 100);
      assert.equal(first[0].name, 'Item 0');
      assert.equal(first[99].name, 'Item 99');
      assert.equal(next.length, total - 100);
      assert.equal(next[0].name, 'Item 100');
      assert.equal(new Set([...first, ...next].map(row => row.id)).size, total);
      const partial = await source.catalog(type, id, '', 24);
      assert.equal(partial.length, 100);
      assert.equal(partial[0].name, 'Item 24');
      assert.equal((await source.catalog(type, id, '', 200)).length, 0);
    }
    assert.ok(requests.some(url => url.includes('/tvshows/page/3/')));
    assert.ok(requests.some(url => url.includes('/movies/page/2/')));
  } finally { http.text = original; }
});

test('latest episodes still use the homepage and keep their existing 24-item response', async () => {
  const http = require('../lib/http');
  const original = http.text;
  http.text = async url => {
    assert.equal(new URL(url).pathname, '/');
    return Array.from({ length: 48 }, (_, i) => `<div class="block-post"><a href="/episode/latest-${i}/" title="الحلقة ${i + 1}"><img src="/poster.jpg"></a></div>`).join('');
  };
  try {
    const rows = await source.catalog('series', 'shoof-latest');
    assert.equal(rows.length, 24);
    assert.equal(rows[0].name, 'الحلقة 1');
    assert.equal(rows[23].name, 'الحلقة 24');
  } finally { http.text = original; }
});

test('packed media is decoded without executing embedded functions', () => {
  const packed = "eval(function(p,a,c,k,e,d){throw new Error('must never execute')}('0:\"1://2/3.4\"',5,5,'file|https|cdn.example|video|m3u8'.split('|')))";
  const media = source.mediaFromHtml(packed);
  assert.equal(media[0].url, 'https://cdn.example/video.m3u8');
  assert.equal(media[0].format, 'HLS');
});

test('HLS qualities come from actual playlist resolutions and relative URLs', () => {
  const rows = source.variants('#EXTM3U\n#EXT-X-STREAM-INF:BANDWIDTH=2000000,RESOLUTION=1920x1080\nhigh/index.m3u8?token=abc\n#EXT-X-STREAM-INF:BANDWIDTH=800000,RESOLUTION=854x480\nlow/index.m3u8', 'https://cdn.example/path/master.m3u8');
  assert.deepEqual(rows.map(r => r.quality), ['1080p', '480p']);
  assert.equal(rows[0].url, 'https://cdn.example/path/high/index.m3u8?token=abc');
});

test('MP4 extractor retains quality labels and deduplicates URLs', () => {
  const rows = source.mediaFromHtml('sources:[{file:"https://cdn.example/a.mp4",label:"480p"},{file:"https://cdn.example/b.mp4",label:"320p"}]');
  assert.equal(rows.length, 2);
  assert.deepEqual(rows.map(r => r.quality), ['480p', '320p']);
});

test('signed proxy links reject tampering, expiry and private destinations', () => {
  const token = proxy.signMedia('https://media.cdnz.quest/v.mp4', 'https://mp4plus.cyou/', 1000000);
  assert.equal(proxy.verifyMedia(token, 1000000).url, 'https://media.cdnz.quest/v.mp4');
  assert.throws(() => proxy.verifyMedia(token + 'x', 1000000));
  assert.throws(() => proxy.verifyMedia(token, 1000000 + 7 * 3600 * 1000));
  assert.throws(() => proxy.signMedia('http://127.0.0.1/private', 'https://mp4plus.cyou/'));
  assert.throws(() => proxy.signMedia('https://cdnz.quest.evil.example/v.mp4', 'https://mp4plus.cyou/'));
  for (const ip of ['127.0.0.1', '10.1.2.3', '169.254.169.254', '::1', '::ffff:127.0.0.1', 'fc00::1']) assert.equal(proxy.isPublicAddress(ip), false);
  assert.equal(proxy.isPublicAddress('8.8.8.8'), true);
});

test('simultaneous cache requests share one loader; empty results are retried', async () => {
  const cache = new Cache(2); let count = 0;
  const load = async () => { count++; return ['result']; };
  const result = await Promise.all([cache.get('key', 1000, load), cache.get('key', 1000, load)]);
  assert.equal(count, 1); assert.deepEqual(result, [['result'], ['result']]);
  await cache.get('empty', 1000, async () => []);
  assert.deepEqual(await cache.get('empty', 1000, async () => ['recovered']), ['recovered']);
});

async function request(url, method = 'GET') {
  const res = { statusCode: 200, headers: {}, setHeader(key, value) { this.headers[key] = value; }, end(body) { this.body = body; } };
  await handler({ url, method }, res); return res;
}

test('manifest and CORS preflight work without external services', async () => {
  const response = await request('/manifest.json');
  const manifest = JSON.parse(response.body);
  assert.deepEqual(manifest.types, ['movie', 'series']); assert.equal(manifest.catalogs.length, 3);
  assert.equal((await request('/stream/series/test.json', 'OPTIONS')).statusCode, 204);
  assert.equal((await request('/manifest.json', 'POST')).statusCode, 405);
});

test('Vercel handler never exposes the video proxy', async () => {
  assert.equal((await request('/proxy/mp4?url=http://127.0.0.1/')).statusCode, 404);
  assert.equal(JSON.parse((await request('/health')).body).proxyEnabled, false);
});

test('invalid pagination is rejected before any network requests', async () => {
  assert.equal((await request('/catalog/series/shoof-series/skip=-1.json')).statusCode, 400);
  assert.equal((await request('/catalog/movie/shoof-series.json')).statusCode, 404);
});

test('Vercel rewrite preserves manifest and health routes', async () => {
  const manifest = await request('/api/index?route=manifest.json');
  assert.equal(manifest.statusCode, 200);
  assert.equal(JSON.parse(manifest.body).id, 'org.abdulluh.soof55');
  const health = await request('/api/index?route=health');
  assert.equal(JSON.parse(health.body).status, 'ok');
});

test('Vercel rewrite preserves catalog search, pagination and encoded values', async () => {
  const old = source.catalog;
  let captured;
  source.catalog = async (...args) => { captured = args; return []; };
  try {
    const path = 'catalog/series/shoof-series/search=' + encodeURIComponent('تجربة & ثانية') + '&skip=24.json';
    const response = await request('/api/index?route=' + encodeURIComponent(path));
    assert.equal(response.statusCode, 200);
    assert.deepEqual(captured, ['series', 'shoof-series', 'تجربة & ثانية', 24]);
  } finally { source.catalog = old; }
});
