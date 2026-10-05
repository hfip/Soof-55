'use strict';

const cheerio = require('cheerio');
const config = require('./config');
const http = require('./http');
const { Cache, mapLimit } = require('./cache');
const { signMedia } = require('./proxy');
const categories = require('./categories');
const cache = new Cache(400);

const digits = value => String(value).replace(/[٠-٩]/g, c => String('٠١٢٣٤٥٦٧٨٩'.indexOf(c)))
  .replace(/[۰-۹]/g, c => String('۰۱۲۳۴۵۶۷۸۹'.indexOf(c)));

function normalize(value) {
  return digits(value).toLowerCase().replace(/[\u064b-\u065f\u0670]/g, '')
    .replace(/[أإآ]/g, 'ا').replace(/ى/g, 'ي')
    .replace(/(?:مسلسل|فيلم|مترجمة?|مدبلجة?|كامل|مشاهدة|تحميل)/g, ' ')
    .replace(/(?:الحلقة|الموسم)\s*\S+/g, ' ').replace(/\b(?:19|20)\d{2}\b/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').replace(/\s+/g, ' ').trim();
}

function coordinates(value) {
  const s = digits(value).replace(/[-_]/g, ' ');
  const english = s.match(/\bs(\d+)\s*e(\d+)\b/i);
  if (english) return { season: +english[1], episode: +english[2] };
  const ep = s.match(/(?:الحلقة|حلقة|episode)\s*(\d+)/i);
  let season = s.match(/(?:الموسم|موسم|season)\s*(\d+)/i)?.[1];
  if (!season) {
    const words = { 'الأول': 1, 'الاول': 1, 'الثاني': 2, 'الثالث': 3, 'الرابع': 4, 'الخامس': 5, 'السادس': 6, 'السابع': 7, 'الثامن': 8, 'التاسع': 9, 'العاشر': 10 };
    const word = s.match(/(?:الموسم|موسم)\s+(\S+)/)?.[1];
    season = words[word];
  }
  return { season: season ? +season : null, episode: ep ? +ep[1] : null };
}

function sourceUrl(href) {
  const u = new URL(href, config.base);
  const allowed = new Set([new URL(config.base).hostname, 'shooflive.net', 'w8.shooflive.cyou', 's3.shooflive.cyou']);
  if (!allowed.has(u.hostname) || !/^https?:$/.test(u.protocol) || u.username || u.password) throw new Error('Invalid source URL');
  // Follow this installation's configured domain, including old links in the site's slider.
  return new URL(u.pathname + u.search, config.base).href;
}

function encodeId(url) {
  const path = new URL(sourceUrl(url)).pathname;
  return 'shoof_' + Buffer.from(path).toString('base64url');
}

function decodeId(id) {
  if (!/^shoof_[A-Za-z0-9_-]{1,3000}$/.test(id)) throw new Error('Invalid content ID');
  const short = id.startsWith('shoof_short_');
  const path = Buffer.from(id.slice(short ? 12 : 6), 'base64url').toString();
  if (!/^\/(series|movies|episode)\/[^?#\s]+\/?$/.test(path)) throw new Error('Invalid content path');
  const u = new URL(path, config.base);
  if (!/^\/(series|movies|episode)\//.test(u.pathname)) throw new Error('Invalid content path');
  if (short && !u.pathname.startsWith('/movies/')) throw new Error('Invalid short-series path');
  return u.href;
}

function imageUrl(href, base) {
  if (!href) return undefined;
  try { const u = new URL(href, base); return /^https?:$/.test(u.protocol) ? u.href : undefined; } catch { return undefined; }
}

function cards(html, base = config.base) {
  const $ = cheerio.load(html);
  const found = new Map();
  $('.block-post > a[href], .slx-watch[href], .slv2-card[href]').each((_, element) => {
    const anchor = $(element);
    let url;
    try { url = sourceUrl(new URL(anchor.attr('href'), base).href); } catch { return; }
    const path = new URL(url).pathname;
    if (!/^\/(movies|series|episode)\//.test(path)) return;
    const img = anchor.find('img').first();
    const name = (anchor.attr('title') || anchor.find('.title,.slv2-name').text() || img.attr('alt') ||
      anchor.closest('article').find('h2,h3,.slx-title').first().text()).trim();
    if (!name || name === 'شاهد الآن') return;
    found.set(url, {
      id: encodeId(url), url, name,
      type: path.startsWith('/movies/') ? 'movie' : 'series',
      episodePage: path.startsWith('/episode/'),
      poster: imageUrl(img.attr('data-src') || img.attr('src'), base),
      ...coordinates(name + ' ' + decodeURIComponent(path))
    });
  });
  return [...found.values()];
}

async function catalog(type, catalogId, search = '', skip = 0) {
  const category = categories.find(item => item.id === catalogId && item.type === type);
  if (category) return categoryCatalog(category, search, skip);
  if (!search && catalogId !== 'shoof-latest') return archiveCatalog(type, skip);
  const page = Math.floor(skip / 24) + 1;
  if (page > 100 || search.length > 150) return [];
  const url = search ? `${config.base}/${page > 1 ? `page/${page}/` : ''}?s=${encodeURIComponent(search)}` :
    `${config.base}/${page > 1 ? `page/${page}/` : ''}`;
  return cache.get('catalog:' + url + ':' + type + ':' + catalogId, 5 * 60 * 1000, async () => {
    const all = cards(await http.text(url), url);
    return all.filter(row => row.type === type &&
      (catalogId === 'shoof-latest' ? !!search || row.episodePage : !row.episodePage)).slice(0, 24)
      .map(({ id, name, type, poster }) => ({ id, name, type, poster }));
  });
}

async function categoryIndex(category) {
  const base = `${config.base}/${category.path}/`;
  return cache.get('category-index:' + base, 15 * 60 * 1000, async () => {
    const parse = html => cards(html, base).filter(row => !row.episodePage &&
      row.type === (category.singleVideoSeries ? 'movie' : category.type));
    const html = await http.text(base);
    const $ = cheerio.load(html);
    let lastPage = 1;
    $('.pagination a[href]').each((_, el) => {
      try {
        const url = new URL($(el).attr('href'), base);
        if (url.origin !== new URL(base).origin) return;
        const match = url.pathname.match(new RegExp(`^/${category.path}/page/(\\d+)/?$`));
        if (match) lastPage = Math.max(lastPage, Number(match[1]));
      } catch {}
    });
    const rest = await mapLimit(Array.from({ length: lastPage - 1 }, (_, i) => i + 2), 4, async number =>
      parse(await http.text(`${base}page/${number}/`)));
    const rows = [...new Map([parse(html), ...rest].flat().map(row => [row.id, row])).values()];
    return rows.map(row => category.singleVideoSeries ? {
      ...row, type: 'series', id: row.id.replace(/^shoof_/, 'shoof_short_')
    } : row);
  });
}

async function categoryCatalog(category, search, skip) {
  if (search.length > 150 || !Number.isSafeInteger(skip) || skip < 0) return [];
  let index = await categoryIndex(category);
  // Dubbed and subtitled episodes have different numbering. Keep separate
  // posters, but make matching dubbed editions accessible from Turkish too.
  if (category.id === 'shoof-turkish-series') {
    let dubbed = [];
    try { dubbed = await categoryIndex(categories.find(row => row.id === 'shoof-dubbed-series')); }
    catch (error) { http.warn('dubbed-editions', config.base, error); }
    const existing = new Set(index.map(row => row.id));
    const byName = new Map();
    for (const row of dubbed) {
      const key = normalize(row.name);
      if (!existing.has(row.id)) byName.set(key, [...(byName.get(key) || []), row]);
    }
    index = index.flatMap(row => {
      const editions = byName.get(normalize(row.name)) || [];
      if (!editions.length) return [row];
      byName.delete(normalize(row.name));
      return [{ ...row, name: /مترجم|مدبلج/.test(row.name) ? row.name : row.name + ' • مترجم' }, ...editions];
    });
  }
  const query = normalize(search);
  const terms = query.split(' ').filter(Boolean);
  const matching = search && terms.length ? index.filter(row => {
    const name = normalize(row.name);
    return terms.every(term => name.includes(term));
  }) : index;
  return matching.slice(skip, skip + 100).map(({ id, name, type, poster }) => ({ id, name, type, poster }));
}

// Stremio offsets count items, not source pages. The site's series and movie
// archives currently use different page sizes, so derive the size from page 1.
async function archiveCatalog(type, skip) {
  // /series/ shuffles its results on every request. /tvshows/ is the site's
  // ordered "all series" listing and supports stable numbered pages.
  const folder = type === 'movie' ? 'movies' : 'tvshows';
  const base = `${config.base}/${folder}/`;
  const first = await cache.get('archive-info:' + base, 5 * 60 * 1000, async () => {
    const html = await http.text(base);
    const rows = cards(html, base).filter(row => row.type === type && !row.episodePage);
    const $ = cheerio.load(html);
    let lastPage = 1;
    $('a[href]').each((_, el) => {
      try {
        const u = new URL($(el).attr('href'), base);
        if (u.origin !== new URL(base).origin) return;
        const match = u.pathname.match(new RegExp(`^/${folder}/page/(\\d+)/?$`));
        if (match) lastPage = Math.max(lastPage, Number(match[1]));
      } catch {}
    });
    return { rows, pageSize: rows.length, lastPage };
  });
  if (!first.pageSize) return [];
  const limit = 100;
  if (type === 'series') {
    // Some source pages overlap. Build one deduplicated list before applying
    // offsets; slicing individual pages would repeat or skip series.
    const index = await cache.get('series-index:' + base, 15 * 60 * 1000, async () => {
      const numbers = Array.from({ length: first.lastPage - 1 }, (_, i) => i + 2);
      const rest = await mapLimit(numbers, 4, async number => {
        const url = `${base}page/${number}/`;
        return cards(await http.text(url), url).filter(row => row.type === type && !row.episodePage);
      });
      return [...new Map([first.rows, ...rest].flat().map(row => [row.id, row])).values()];
    });
    return index.slice(skip, skip + limit).map(({ id, name, type, poster }) => ({ id, name, type, poster }));
  }
  const start = Math.floor(skip / first.pageSize) + 1;
  if (start > first.lastPage) return [];
  const end = Math.min(first.lastPage, Math.floor((skip + limit - 1) / first.pageSize) + 1);
  const numbers = Array.from({ length: end - start + 1 }, (_, i) => start + i);
  const pages = await mapLimit(numbers, 3, async number => {
    if (number === 1) return first.rows;
    const url = `${base}page/${number}/`;
    return cache.get('archive-page:' + url, 5 * 60 * 1000, async () =>
      cards(await http.text(url), url).filter(row => row.type === type && !row.episodePage));
  });
  const rows = pages.flat().slice(skip % first.pageSize, skip % first.pageSize + limit);
  const seen = new Set();
  return rows.filter(row => {
    if (seen.has(row.id)) return false;
    seen.add(row.id); return true;
  }).map(({ id, name, type, poster }) => ({ id, name, type, poster }));
}

async function content(url) {
  url = sourceUrl(url);
  return cache.get('content:' + url, 5 * 60 * 1000, async () => {
    const html = await http.text(url);
    const $ = cheerio.load(html);
    const name = $('h1').first().text().trim() || $('title').text().replace(/\s*[-|]\s*شوف لايف.*$/, '').trim();
    const poster = imageUrl($('meta[property="og:image"]').attr('content') || $('.info').parent().find('img').first().attr('src') ||
      $('.imgSer,.imgBg').first().attr('data-src'), url);
    const description = $('meta[name="description"]').attr('content') || name;
    const parentSeason = coordinates(name).season;
    const episodeHtml = new URL(url).pathname.startsWith('/series/') && $('.postEp').length
      ? $('.postEp').toArray().map(el => $.html(el)).join('') : html;
    const episodes = cards(episodeHtml, url).filter(r => r.episodePage && r.episode)
      .map(r => ({ ...r, season: r.season || parentSeason || 1 }));
    const player = $('iframe[src]').toArray().map(el => $(el).attr('src')).find(src => /\/albaplayer\//i.test(src));
    return { url, html, name, poster, description, episodes, player: player ? new URL(player, url).href : null };
  });
}

async function meta(type, id) {
  const url = decodeId(id);
  if (id.startsWith('shoof_short_')) {
    if (type !== 'series') return null;
    const page = await content(url);
    return {
      id, type, name: page.name, poster: page.poster, description: page.description,
      videos: [{ id: `${id}:1:1`, title: page.name, season: 1, episode: 1, thumbnail: page.poster }]
    };
  }
  if ((new URL(url).pathname.startsWith('/movies/')) !== (type === 'movie')) return null;
  const page = await content(url);
  const result = { id, type, name: page.name, poster: page.poster, description: page.description };
  if (type === 'series') {
    let eps = page.episodes;
    if (new URL(url).pathname.startsWith('/episode/')) {
      const coords = coordinates(page.name + ' ' + decodeURIComponent(new URL(url).pathname));
      eps = [{ name: page.name, season: coords.season || 1, episode: coords.episode || 1, poster: page.poster }];
    }
    const seen = new Set();
    result.videos = eps.sort((a, b) => a.season - b.season || a.episode - b.episode).filter(ep => {
      const key = `${ep.season}:${ep.episode}`;
      if (seen.has(key)) return false;
      seen.add(key); return true;
    }).map(ep => ({ id: `${id}:${ep.season}:${ep.episode}`, title: ep.name, season: ep.season, episode: ep.episode, thumbnail: ep.poster }));
  }
  return result;
}

// VOE's current JSON transport: ROT13, separator removal, base64,
// character shift, reversal, then base64 JSON. Parse data only, never scripts.
function decodeVoe(html) {
  const $ = cheerio.load(html);
  for (const element of $('script[type="application/json"]').toArray()) {
    try {
      const payload = JSON.parse($(element).html());
      if (!Array.isArray(payload) || typeof payload[0] !== 'string' || payload[0].length > 1000000) continue;
      const rot = payload[0].replace(/[a-zA-Z]/g, c => String.fromCharCode(c.charCodeAt(0) + (c.toLowerCase() <= 'm' ? 13 : -13)));
      const first = Buffer.from(rot.replace(/@\$|\^\^|~@|%\?|\*~|!!|#&/g, ''), 'base64').toString('latin1');
      const reversed = [...first].map(c => String.fromCharCode(c.charCodeAt(0) - 3)).reverse().join('');
      const data = JSON.parse(Buffer.from(reversed, 'base64').toString('utf8'));
      // Ignore the plain-text decoy video and non-playback fields (images/ads).
      if (typeof data.source === 'string' && /^https?:\/\//.test(data.source)) {
        return JSON.stringify({ source: data.source });
      }
    } catch { /* Not a VOE payload, try the next JSON block. */ }
  }
  return null;
}

// Decode the packed string as data. Never execute scripts received from a provider.
function unpack(html) {
  const matches = html.matchAll(/eval\(function\(p,a,c,k,e,[rd]\)[\s\S]*?\}\('((?:[^'\\]|\\.)*)',\s*(\d+),\s*(\d+),\s*'((?:[^'\\]|\\.)*)'\.split\('\|'\)/g);
  const alphabet = '0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ';
  const output = [];
  for (const match of matches) {
    const radix = +match[2], count = +match[3];
    if (radix < 2 || radix > 62 || count > 20000) continue;
    const dictionary = match[4].split('|');
    const index = token => {
      let n = 0;
      for (const c of token) { const digit = alphabet.indexOf(c); if (digit < 0 || digit >= radix) return -1; n = n * radix + digit; if (n >= count) return -1; }
      return n;
    };
    output.push(match[1].replace(/\b\w+\b/g, token => dictionary[index(token)] || token).replace(/\\(['"\\/])/g, '$1'));
  }
  return output.join('\n');
}

function mediaFromHtml(html) {
  const decoded = decodeVoe(html);
  let text = (decoded || html + '\n' + unpack(html)).replace(/\\\//g, '/').replace(/\\u002[fF]/g, '/').replace(/\\u0026/g, '&');
  if (!decoded) {
    for (const match of text.matchAll(/(?:["'](?:hls|mp4)["']\s*:\s*|atob\(\s*)["']([A-Za-z0-9+/=]{20,})["']/g)) {
      const value = Buffer.from(match[1], 'base64').toString('utf8');
      if (/^https?:\/\//.test(value)) text += '\n' + value;
    }
  }
  const found = new Map();
  const clean = value => value.replace(/\\\//g, '/').replace(/&amp;/g, '&');
  for (const match of text.matchAll(/\bfile\s*:\s*["'](https?:[^"']+)["']\s*,\s*label\s*:\s*["']([^"']+)["']/g)) {
    const url = clean(match[1]);
    if (/\.mp4(?:[?]|$)/i.test(url)) found.set(url, { url, format: 'MP4', quality: match[2] });
  }
  for (const match of text.matchAll(/["']?(?:url|mp4_)(240|360|480|720|1080|1440|2160)["']?\s*:\s*["'](https?:[^"']+)["']/g)) {
    const url = clean(match[2]);
    found.set(url, { url, format: 'MP4', quality: match[1] + 'p' });
  }
  for (const match of text.matchAll(/https?:\/\/[^\s"'<>\\]+\.(m3u8|mp4)(?:\?[^\s"'<>\\]*)?/g)) {
    const url = clean(match[0]);
    if (!found.has(url)) found.set(url, { url, format: match[1].toLowerCase() === 'mp4' ? 'MP4' : 'HLS', quality: null });
  }
  return [...found.values()];
}

function variants(playlist, master) {
  const lines = playlist.split(/\r?\n/);
  const output = [];
  for (let i = 0; i < lines.length; i++) {
    if (!lines[i].startsWith('#EXT-X-STREAM-INF:')) continue;
    const height = lines[i].match(/RESOLUTION=\d+x(\d+)/)?.[1];
    const next = lines.slice(i + 1).find(s => s.trim() && !s.startsWith('#'));
    if (next) output.push({ url: new URL(next.trim(), master).href, format: 'HLS', quality: height ? height + 'p' : 'Auto' });
  }
  return output;
}

async function resolvePlayer(playerUrl, referer) {
  const deadline = Date.now() + 35000;
  const request = (url, from, timeout = 8000) => {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new Error('Provider resolution deadline');
    return http.text(url, from, Math.min(timeout, remaining));
  };
  // WordPress canonicalizes dots/underscores to hyphens in player slugs.
  const pathKey = value => new URL(value).pathname.replace(/\/$/, '').replace(/[._]/g, '-').toLowerCase();
  const first = await request(playerUrl, referer);
  const $ = cheerio.load(first);
  const servers = new Map();
  $('.aplr-link[href]').each((_, el) => {
    const url = new URL($(el).attr('href'), playerUrl);
    if (url.origin === new URL(playerUrl).origin && pathKey(url.href) === pathKey(playerUrl)) {
      servers.set(url.href, { url: url.href, name: $(el).text().trim() || 'Server' });
    }
  });
  if (!servers.size) servers.set(playerUrl, { url: playerUrl, name: 'Server' });
  const chosen = [...servers.values()].slice(0, 12);
  const results = await mapLimit(chosen, 4, async server => {
    try {
      const html = server.url === playerUrl ? first : await request(server.url, referer);
      const dom = cheerio.load(html);
      const src = dom('iframe[src]').first().attr('src');
      if (!src) return [];
      let embed = new URL(src.trim(), server.url).href;
      if (!/^https?:$/.test(new URL(embed).protocol)) return [];
      let embedHtml = await request(embed, server.url);
      const visited = new Set([embed]);
      for (let depth = 0; depth < 3 && !mediaFromHtml(embedHtml).length; depth++) {
        const redirect = embedHtml.match(/(?:window\.)?location\.href\s*=\s*["'](https?:[^"']+)["']/)?.[1];
        const nested = cheerio.load(embedHtml)('iframe[src]').first().attr('src');
        const target = redirect || nested;
        if (!target) break;
        const next = new URL(target.trim(), embed).href;
        if (!/^https?:$/.test(new URL(next).protocol) || visited.has(next)) break;
        visited.add(next);
        embedHtml = await request(next, embed);
        embed = next;
      }
      const media = mediaFromHtml(embedHtml);
      const headers = { ...http.headers(new URL('/', embed).href), Origin: new URL(embed).origin };
      const expanded = await mapLimit(media, 3, async item => {
        if (item.format !== 'HLS') return [item];
        try {
          const list = await request(item.url, headers.Referer, 5000);
          const items = variants(list, item.url);
          return items.length ? items : [item];
        } catch (error) { http.warn('hls-variants', item.url, error); return [item]; }
      });
      return expanded.flat().map(item => ({ ...item, headers, server: server.name }));
    } catch (error) { http.warn('server-' + server.name, error.config?.url || server.url, error); return []; }
  });
  const unique = new Map();
  for (const item of results.flat()) if (!unique.has(item.server + ':' + item.url)) unique.set(item.server + ':' + item.url, item);
  return [...unique.values()].sort((a, b) => (parseInt(b.quality) || 0) - (parseInt(a.quality) || 0));
}

async function findImdb(type, id) {
  if (!config.tmdbKey) return null;
  return cache.get('imdb:' + type + ':' + id, 24 * 3600 * 1000, async () => {
    const data = await http.json(`https://api.themoviedb.org/3/find/${id}?api_key=${encodeURIComponent(config.tmdbKey)}&external_source=imdb_id&language=ar-SA`);
    const hit = (type === 'movie' ? data.movie_results : data.tv_results)?.[0];
    if (!hit) return null;
    const names = [...new Set([hit.title || hit.name, hit.original_title || hit.original_name].filter(Boolean))];
    const year = (hit.release_date || hit.first_air_date || '').slice(0, 4);
    for (const name of names) {
      const url = `${config.base}/?s=${encodeURIComponent(name)}`;
      const candidates = cards(await http.text(url), url).filter(c => c.type === type && !c.episodePage);
      const ranked = candidates.map(row => {
        const a = normalize(row.name), b = normalize(name);
        const words = b.split(' ').filter(Boolean);
        const overlap = words.filter(w => a.split(' ').includes(w)).length / Math.max(words.length, 1);
        const score = a === b ? 1 : overlap;
        const candidateYear = row.name.match(/\b(?:19|20)\d{2}\b/)?.[0];
        return { row, score: candidateYear && year && candidateYear !== year ? 0 : score };
      }).sort((a, b) => b.score - a.score);
      if (ranked[0]?.score >= 0.8 && (!ranked[1] || ranked[0].score > ranked[1].score)) return ranked[0].row.url;
    }
    return null;
  });
}

async function streams(type, fullId) {
  return cache.get('streams:' + type + ':' + fullId, 60 * 1000, async () => {
    const [id, rawSeason, rawEpisode] = fullId.split(':');
    const shortSeries = id.startsWith('shoof_short_');
    const season = rawSeason === undefined ? 1 : Number(rawSeason);
    const episode = rawEpisode === undefined ? 1 : Number(rawEpisode);
    if (!Number.isSafeInteger(season) || season < 1 || !Number.isSafeInteger(episode) || episode < 1) return [];
    if (shortSeries && (type !== 'series' || season !== 1 || episode !== 1)) return [];
    let url = id.startsWith('shoof_') ? decodeId(id) : /^tt\d+$/.test(id) ? await findImdb(type, id) : null;
    if (!url) return [];
    if ((new URL(url).pathname.startsWith('/movies/')) !== (type === 'movie' || shortSeries)) return [];
    let page = await content(url);
    if (type === 'series' && !shortSeries && !new URL(url).pathname.startsWith('/episode/')) {
      const match = page.episodes.find(ep => ep.season === season && ep.episode === episode);
      if (!match) return [];
      page = await content(match.url);
    } else if (type === 'series' && !shortSeries) {
      const coords = coordinates(page.name + ' ' + decodeURIComponent(new URL(url).pathname));
      if ((coords.season || 1) !== season || (coords.episode || 1) !== episode) return [];
    }
    if (!page.player) return [];
    const resolved = await resolvePlayer(page.player, page.url);
    return resolved.map(item => {
      let signed = null;
      if (item.format === 'MP4' && config.proxyBase && config.proxySecret) {
        try { signed = signMedia(item.url, item.headers.Referer); }
        catch (error) { http.warn('proxy-sign', item.url, error); }
      }
      return {
        name: `${config.name} | ${item.server} | ${item.quality || 'Auto'}`,
        title: `${item.server} • ${item.format}\n${type === 'series' ? `S${season}E${episode}` : page.name}`,
        url: signed ? `${config.proxyBase}/proxy/mp4?token=${encodeURIComponent(signed)}` : item.url,
        behaviorHints: {
          notWebReady: !signed,
          bingeGroup: `shoof-${item.server}-${item.quality || 'auto'}`,
          ...(!signed ? { proxyHeaders: { request: item.headers } } : {})
        }
      };
    });
  });
}

module.exports = { normalize, coordinates, sourceUrl, encodeId, decodeId, cards, catalog, content, meta, unpack, mediaFromHtml, variants, resolvePlayer, streams };
