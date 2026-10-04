'use strict';

const crypto = require('node:crypto');
const dns = require('node:dns/promises');
const net = require('node:net');
const { pipeline } = require('node:stream/promises');
const axios = require('axios');
const config = require('./config');

function allowedHost(host) {
  return config.mediaHosts.some(domain => host === domain || host.endsWith('.' + domain));
}

function validateMediaUrl(value) {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.port || net.isIP(url.hostname) || !allowedHost(url.hostname)) {
    throw new Error('Media host is not allowed');
  }
  return url;
}

function signMedia(url, referer, now = Date.now()) {
  if (config.proxySecret.length < 32) throw new Error('PROXY_SECRET must contain at least 32 characters');
  validateMediaUrl(url);
  const payload = Buffer.from(JSON.stringify({ url, referer, expires: Math.floor(now / 1000) + 6 * 3600 })).toString('base64url');
  const signature = crypto.createHmac('sha256', config.proxySecret).update(payload).digest('base64url');
  return `${payload}.${signature}`;
}

function verifyMedia(token, now = Date.now()) {
  if (config.proxySecret.length < 32 || typeof token !== 'string' || token.length > 8192) throw new Error('Invalid proxy token');
  const [payload, signature, extra] = token.split('.');
  if (!payload || !signature || extra) throw new Error('Invalid proxy token');
  const expected = crypto.createHmac('sha256', config.proxySecret).update(payload).digest();
  const received = Buffer.from(signature, 'base64url');
  if (received.length !== expected.length || !crypto.timingSafeEqual(received, expected)) throw new Error('Invalid proxy signature');
  const data = JSON.parse(Buffer.from(payload, 'base64url').toString());
  if (!Number.isSafeInteger(data.expires) || data.expires <= Math.floor(now / 1000)) throw new Error('Expired proxy token');
  validateMediaUrl(data.url);
  const ref = new URL(data.referer);
  if (!/^https?:$/.test(ref.protocol) || /[\r\n]/.test(data.referer)) throw new Error('Invalid referer');
  return data;
}

const blocked = new net.BlockList();
for (const [ip, bits] of [['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8], ['169.254.0.0', 16],
  ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15], ['224.0.0.0', 4], ['240.0.0.0', 4]]) blocked.addSubnet(ip, bits);
for (const [ip, bits] of [['::', 128], ['::1', 128], ['fc00::', 7], ['fe80::', 10], ['ff00::', 8]]) blocked.addSubnet(ip, bits, 'ipv6');

function isPublicAddress(address) {
  if (address.startsWith('::ffff:')) address = address.slice(7);
  const family = net.isIP(address);
  return !!family && !blocked.check(address, family === 6 ? 'ipv6' : 'ipv4');
}

async function checkAddress(url) {
  const host = validateMediaUrl(url).hostname;
  const addresses = await dns.lookup(host, { all: true });
  if (!addresses.length || addresses.some(a => !isPublicAddress(a.address))) throw new Error('Non-public media address');
}

async function proxy(req, res, token) {
  let media;
  try { media = verifyMedia(token); } catch { res.writeHead(403); res.end('Invalid or expired proxy token'); return; }
  const controller = new AbortController();
  const cancel = () => controller.abort();
  req.once('aborted', cancel);
  res.once('close', cancel);
  let upstream;
  try {
    let url = media.url;
    for (let redirects = 0; redirects <= 3; redirects++) {
      await checkAddress(url);
      upstream = await axios({
        method: req.method === 'HEAD' ? 'HEAD' : 'GET', url,
        responseType: 'stream', maxRedirects: 0, signal: controller.signal,
        timeout: 15000, decompress: false, validateStatus: () => true,
        headers: { 'User-Agent': config.userAgent, 'Accept-Language': 'ar,en;q=0.9', Referer: media.referer, 'Accept-Encoding': 'identity',
          ...(req.headers.range ? { Range: req.headers.range } : {}),
          ...(req.headers['if-range'] ? { 'If-Range': req.headers['if-range'] } : {}) }
      });
      if ([301, 302, 303, 307, 308].includes(upstream.status) && upstream.headers.location) {
        upstream.data.destroy();
        if (redirects === 3) throw new Error('Too many redirects');
        url = new URL(upstream.headers.location, url).href;
        continue;
      }
      break;
    }
    for (const header of ['content-type', 'content-length', 'content-range', 'accept-ranges', 'etag', 'last-modified']) {
      if (upstream.headers[header] !== undefined) res.setHeader(header, upstream.headers[header]);
    }
    res.setHeader('Cache-Control', 'private, no-store');
    res.statusCode = upstream.status;
    if (req.method === 'HEAD') { upstream.data.destroy(); res.end(); }
    else await pipeline(upstream.data, res, { signal: controller.signal });
  } catch (error) {
    upstream?.data?.destroy();
    if (!controller.signal.aborted) {
      console.warn(`[proxy] ${error.code || error.name || 'error'}`);
      if (!res.headersSent) { res.writeHead(502); res.end('Upstream video unavailable'); }
      else res.destroy();
    }
  } finally {
    req.removeListener('aborted', cancel); res.removeListener('close', cancel);
  }
}

module.exports = { signMedia, verifyMedia, validateMediaUrl, isPublicAddress, proxy };
