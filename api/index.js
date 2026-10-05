'use strict';

const config = require('../lib/config');
const source = require('../lib/source');
const { proxy } = require('../lib/proxy');

const manifest = {
  id: 'org.abdulluh.soof55', version: '3.0.0', name: config.name,
  description: 'أفلام ومسلسلات شوف لايف مع اكتشاف السيرفرات والجودات تلقائياً.',
  resources: ['catalog', 'meta', 'stream'], types: ['movie', 'series'],
  idPrefixes: ['shoof_', 'tt'],
  catalogs: [
    { type: 'series', id: 'shoof-latest', name: 'شوف لايف • آخر الحلقات', extra: [{ name: 'search' }, { name: 'skip' }] },
    { type: 'series', id: 'shoof-series', name: 'شوف لايف • المسلسلات', extra: [{ name: 'search' }, { name: 'skip' }] },
    { type: 'movie', id: 'shoof-movies', name: 'شوف لايف • الأفلام', extra: [{ name: 'search' }, { name: 'skip' }] }
  ],
  behaviorHints: { configurable: false, configurationRequired: false }
};

function send(res, payload, code = 200, seconds = 0) {
  res.statusCode = code;
  res.setHeader('Content-Type', 'application/json; charset=utf-8');
  res.setHeader('Cache-Control', seconds ? `public, max-age=${seconds}` : 'no-store');
  res.end(JSON.stringify(payload));
}

function createHandler({ enableProxy = false } = {}) {
  return async function handler(req, res) {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Range, If-Range');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, Accept-Ranges');
    if (req.method === 'OPTIONS') { res.statusCode = 204; res.end(); return; }
    if (!['GET', 'HEAD'].includes(req.method)) { send(res, { error: 'Method not allowed' }, 405); return; }
    const url = new URL(req.url, 'http://localhost');
    // Vercel can replace req.url with the rewrite destination. Carry the
    // original route explicitly; direct VPS requests still use pathname.
    const routed = req.query?.route ?? url.searchParams.get('route');
    const originalRoute = Array.isArray(routed) ? routed[0] : routed;
    const path = typeof originalRoute === 'string' ? '/' + originalRoute.replace(/^\/+/, '') : url.pathname;
    if (path === '/' || path === '/manifest.json') return send(res, manifest, 200, 3600);
    if (path === '/health' || path === '/healthz') return send(res, { status: 'ok', version: manifest.version, tmdbEnabled: !!config.tmdbKey, proxyEnabled: enableProxy && config.proxySecret.length >= 32 });
    if (path === '/proxy/mp4') {
      if (!enableProxy) return send(res, { error: 'Video proxy requires a separate VPS endpoint' }, 404);
      return proxy(req, res, url.searchParams.get('token'));
    }
    const catalog = path.match(/^\/catalog\/(movie|series)\/([^/]+)(?:\/(.+))?\.json$/);
    const meta = path.match(/^\/meta\/(movie|series)\/([^/]+)\.json$/);
    const stream = path.match(/^\/stream\/(movie|series)\/([^/]+)\.json$/);
    try {
      if (catalog) {
        const [, type, id, extra = ''] = catalog;
        if (!manifest.catalogs.some(c => c.id === id && c.type === type)) return send(res, { metas: [] }, 404);
        const args = new URLSearchParams(extra);
        const skip = Number(args.get('skip') || 0);
        if (!Number.isSafeInteger(skip) || skip < 0) return send(res, { error: 'Invalid skip' }, 400);
        return send(res, { metas: await source.catalog(type, id, args.get('search') || '', skip) }, 200, 300);
      }
      if (meta) return send(res, { meta: await source.meta(meta[1], decodeURIComponent(meta[2])) }, 200, 300);
      // Signed source URLs can expire; do not cache stream JSON at shared edges.
      if (stream) return send(res, { streams: await source.streams(stream[1], decodeURIComponent(stream[2])) });
    } catch (error) {
      console.warn(`[${catalog ? 'catalog' : meta ? 'meta' : 'stream'}] ${error.response?.status || error.code || error.name}`);
      if (catalog) return send(res, { metas: [] });
      if (meta) return send(res, { meta: null });
      if (stream) return send(res, { streams: [] });
    }
    return send(res, { error: 'Not found' }, 404);
  };
}

module.exports = createHandler();
module.exports.createHandler = createHandler;
module.exports.manifest = manifest;
