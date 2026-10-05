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
  assert.deepEqual(manifest.types, ['movie', 'series']); assert.equal(manifest.catalogs.length, 15);
  assert.deepEqual(manifest.catalogs.slice(0, 3), [
    { type: 'series', id: 'shoof-latest', name: 'شوف لايف • آخر الحلقات', extra: [{ name: 'search' }, { name: 'skip' }] },
    { type: 'series', id: 'shoof-series', name: 'شوف لايف • المسلسلات', extra: [{ name: 'search' }, { name: 'skip' }] },
    { type: 'movie', id: 'shoof-movies', name: 'شوف لايف • الأفلام', extra: [{ name: 'search' }, { name: 'skip' }] }
  ]);
  assert.equal(new Set(manifest.catalogs.map(c => c.id)).size, 15);
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

test('category catalogs use their own pages, remove duplicates and keep search within the category', async () => {
  const http = require('../lib/http');
  const original = http.text;
  http.text = async url => {
    const path = new URL(url).pathname;
    if (path === '/dubbed-series/') return '';
    if (path === '/arabic-series/') return '<div class="block-post"><a href="/series/arabic-example/" title="مسلسل تجربة عربي"><img src="/poster.jpg"></a></div>';
    const match = path.match(/^\/turkish-series\/(?:page\/(\d+)\/)?$/);
    assert.ok(match);
    const page = Number(match[1] || 1);
    const start = page === 3 ? 60 : (page - 1) * 40;
    const count = page === 3 ? 80 : 40;
    return Array.from({ length: count }, (_, i) => `<div class="block-post"><a href="/series/turkish-${start + i}/" title="مسلسل تركي تجربة ${start + i}"><img src="/poster.jpg"></a></div>`).join('') +
      '<div class="pagination"><a href="/turkish-series/page/3/">Last</a></div>';
  };
  try {
    const first = await source.catalog('series', 'shoof-turkish-series', '', 0);
    const next = await source.catalog('series', 'shoof-turkish-series', '', 100);
    assert.equal(first.length, 100);
    assert.equal(next.length, 40);
    assert.equal(new Set([...first, ...next].map(r => r.id)).size, 140);
    assert.equal(next[0].name, 'مسلسل تركي تجربة 100');
    const arabic = await source.catalog('series', 'shoof-arabic-series', 'تجربة');
    assert.equal(arabic.length, 1);
    assert.equal(arabic[0].name, 'مسلسل تجربة عربي');
    assert.equal((await source.catalog('series', 'shoof-arabic-series', 'تركي')).length, 0);
    assert.equal((await source.catalog('series', 'shoof-turkish-series', 'عربي')).length, 0);
    assert.equal((await source.catalog('series', 'shoof-turkish-series', '', 200)).length, 0);
  } finally { http.text = original; }
});

test('short series stored as a full movie exposes one playable episode under series', async () => {
  const http = require('../lib/http');
  const original = http.text;
  http.text = async url => {
    if (url.endsWith('/short-series/')) return '<div class="block-post"><a href="/movies/short-example/" title="مسلسل قصير تجربة"><img src="/poster.jpg"></a></div>';
    if (url.endsWith('/movies/short-example/')) return '<h1>مسلسل قصير تجربة</h1><iframe src="https://player.example/albaplayer/short/"></iframe>';
    if (url === 'https://player.example/albaplayer/short/') return '<iframe src="https://embed.example/short"></iframe>';
    if (url === 'https://embed.example/short') return 'sources:[{file:"https://cdn.example/short.mp4",label:"720p"}]';
    throw new Error('Unexpected URL');
  };
  try {
    const rows = await source.catalog('series', 'shoof-short-series');
    assert.equal(rows.length, 1);
    assert.equal(rows[0].type, 'series');
    assert.ok(rows[0].id.startsWith('shoof_short_'));
    const id = rows[0].id;
    assert.equal(source.decodeId(id), 'https://w8.shooflive.cyou/movies/short-example/');
    const meta = await source.meta('series', id);
    assert.equal(meta.videos.length, 1);
    assert.equal(meta.videos[0].id, `${id}:1:1`);
    const streams = await source.streams('series', meta.videos[0].id);
    assert.equal(streams[0].url, 'https://cdn.example/short.mp4');
    assert.equal(await source.meta('movie', id), null);
    assert.deepEqual(await source.streams('series', `${id}:2:1`), []);
    assert.deepEqual(await source.streams('movie', id), []);
    assert.throws(() => source.decodeId('shoof_short_' + Buffer.from('/series/example/').toString('base64url')));
  } finally { http.text = original; }
});

test('VOE encoded JSON returns the real HLS and ignores its decoy video', () => {
  const url = 'https://cdn.example/real/master.m3u8?token=abc&expires=123';
  const json = JSON.stringify({ source: url });
  const reversed = Buffer.from(json).toString('base64').split('').reverse().join('');
  const shifted = [...reversed].map(c => String.fromCharCode(c.charCodeAt(0) + 3)).join('');
  const rot = Buffer.from(shifted, 'latin1').toString('base64').replace(/[a-zA-Z]/g,
    c => String.fromCharCode(c.charCodeAt(0) + (c.toLowerCase() <= 'm' ? 13 : -13)));
  const encoded = rot.match(/.{1,4}/g).join('!!');
  const html = `var source='https://ads.example/decoy.mp4';<script type="application/json">["${encoded}"]</script>`;
  assert.deepEqual(source.mediaFromHtml(html), [{ url, format: 'HLS', quality: null }]);
});

test('VK escaped video URLs retain qualities and signed query arguments', () => {
  const html = String.raw`var playerParams={"params":[{"url360":"https:\/\/cdn.example\/video.mp4?sig=abc\u0026x=1","url720":"https:\/\/cdn.example\/video720.mp4?sig=def"}]};`;
  assert.deepEqual(source.mediaFromHtml(html), [
    { url: 'https://cdn.example/video.mp4?sig=abc&x=1', format: 'MP4', quality: '360p' },
    { url: 'https://cdn.example/video720.mp4?sig=def', format: 'MP4', quality: '720p' }
  ]);
});

test('player discovers all five providers despite case changes and follows the VOE redirect', async () => {
  const http = require('../lib/http'), original = http.text, requests = [];
  const names = ['AnaFast', 'MP4Plus', 'VidSpeed', 'Vk', 'Voe'];
  const menu = names.map((name, i) => `<a class="aplr-link" href="https://player.example/albaplayer/ahla-naseeb-s01e05?serv=${i + 1}">${name}</a>`).join('');
  http.text = async url => {
    requests.push(url);
    const u = new URL(url);
    if (u.host === 'player.example') {
      const number = Number(u.searchParams.get('serv') || 1);
      return menu + `<iframe src="https://embed.example/${number}"></iframe>`;
    }
    if (u.pathname === '/5') return `<script>window.location.href='https://voe.example/e/test';</script>`;
    if (u.host === 'voe.example') return `file:'https://cdn.example/shared.mp4',label:'720p'`;
    // Intentionally identical media URLs across servers: all choices survive.
    return `file:'https://cdn.example/shared.mp4',label:'720p'`;
  };
  try {
    const media = await source.resolvePlayer('https://player.example/albaplayer/Ahla.Naseeb.S01E05', 'https://source.example/');
    assert.deepEqual(new Set(media.map(row => row.server)), new Set(names));
    assert.equal(media.length, 5);
    assert.ok(requests.includes('https://embed.example/4'));
    assert.ok(requests.includes('https://voe.example/e/test'));
    assert.equal(media.find(row => row.server === 'Voe').headers.Referer, 'https://voe.example/');
  } finally { http.text = original; }
});

test('dubbed edition has all 96 episodes, distinct seasons, and no recommended series contamination', async () => {
  const http = require('../lib/http'), original = http.text;
  const card = (season, ep) => `<article class="postEp"><div class="block-post"><a href="/episode/fixture-love-s${season}e${ep}/" title="مسلسل أنت من أحب الموسم ${season} الحلقة ${ep} مدبلجة"><img src="/ep.jpg"></a></div></article>`;
  const id = source.encodeId('/series/fixture-love-dubbed/');
  http.text = async url => {
    if (url.endsWith('/series/fixture-love-dubbed/')) return '<h1>مسلسل أنت من أحب مدبلج</h1>' +
      Array.from({ length: 75 }, (_, i) => card(1, i + 1)).join('') + Array.from({ length: 21 }, (_, i) => card(2, i + 1)).join('') +
      '<div class="block-post"><a href="/episode/unrelated-999/" title="مسلسل آخر الحلقة 999"></a></div>';
    if (url.endsWith('/episode/fixture-love-s2e21/')) return '<h1>مسلسل أنت من أحب الموسم 2 الحلقة 21 مدبلجة</h1><iframe src="https://player.example/albaplayer/season-two"></iframe>';
    if (url.includes('player.example')) return '<iframe src="https://embed.example/season-two"></iframe>';
    if (url.includes('embed.example')) return `file:'https://cdn.example/season-two.mp4',label:'720p'`;
    throw new Error('Unexpected episode selection');
  };
  try {
    const meta = await source.meta('series', id);
    assert.equal(meta.videos.length, 96);
    assert.equal(meta.videos.filter(row => row.season === 1).length, 75);
    assert.equal(meta.videos.filter(row => row.season === 2).length, 21);
    assert.equal((await source.streams('series', `${id}:2:21`))[0].url, 'https://cdn.example/season-two.mp4');
    assert.deepEqual(await source.streams('series', `${id}:2:22`), []);
  } finally { http.text = original; }
});

test('Turkish catalog offers matching dubbed editions as separate posters', async () => {
  const http = require('../lib/http'), original = http.text;
  delete require.cache[require.resolve('../lib/source')];
  const fresh = require('../lib/source');
  const card = (slug, title) => `<div class="block-post"><a href="/series/${slug}/" title="${title}"><img src="/poster.jpg"></a></div>`;
  http.text = async url => {
    if (url.endsWith('/turkish-series/')) return card('translated', 'مسلسل انت من احب');
    if (url.endsWith('/dubbed-series/')) return card('dubbed', 'مسلسل أنت من أحب مدبلج') + card('different', 'مسلسل مختلف مدبلج');
    throw new Error('Unexpected category request');
  };
  try {
    const rows = await fresh.catalog('series', 'shoof-turkish-series');
    assert.equal(rows.length, 2);
    assert.match(rows[0].name, /مترجم/);
    assert.match(rows[1].name, /مدبلج/);
    assert.notEqual(rows[0].id, rows[1].id);
    assert.equal((await fresh.catalog('series', 'shoof-dubbed-series')).length, 2);
  } finally { http.text = original; }
});

test('legacy VOE base64 sources are decoded as URLs only', () => {
  const url = 'https://cdn.example/legacy.m3u8?sig=abc';
  assert.equal(source.mediaFromHtml(`var sources={'hls':'${Buffer.from(url).toString('base64')}'};`)[0].url, url);
});

test('temporary dubbed archive failure does not break the Turkish catalog', async () => {
  const http = require('../lib/http'), original = http.text, oldWarn = http.warn;
  delete require.cache[require.resolve('../lib/source')];
  const fresh = require('../lib/source');
  http.warn = () => {};
  http.text = async url => {
    if (url.endsWith('/turkish-series/')) return '<div class="block-post"><a href="/series/still-available/" title="مسلسل متاح"></a></div>';
    throw new Error('Dubbed archive unavailable');
  };
  try { assert.equal((await fresh.catalog('series', 'shoof-turkish-series'))[0].name, 'مسلسل متاح'); }
  finally { http.text = original; http.warn = oldWarn; }
});

test('episode title takes precedence over an outdated numeric URL slug', async () => {
  const http = require('../lib/http'), original = http.text;
  const id = source.encodeId('/episode/fixture-title-الحلقة-1-2/');
  http.text = async url => {
    if (new URL(url).pathname.startsWith('/episode/')) return '<h1>مسلسل تجربة الحلقة 2 مدبلجة</h1><iframe src="https://player.example/albaplayer/title-priority"></iframe>';
    if (url.includes('player.example')) return '<iframe src="https://embed.example/title-priority"></iframe>';
    return `file:'https://cdn.example/correct-episode.mp4',label:'720p'`;
  };
  try {
    assert.equal((await source.meta('series', id)).videos[0].episode, 2);
    assert.equal((await source.streams('series', `${id}:1:2`))[0].url, 'https://cdn.example/correct-episode.mp4');
    assert.deepEqual(await source.streams('series', `${id}:1:1`), []);
  } finally { http.text = original; }
});
