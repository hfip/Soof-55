'use strict';

const fs = require('node:fs/promises');
const axios = require('axios');
const source = require('../lib/source');
const config = require('../lib/config');

(async () => {
  const url = process.argv[2];
  if (!url) throw new Error('Usage: npm run probe -- https://your-shoof-domain/episode/...');
  const page = await source.content(url);
  if (!page.player) throw new Error('No Alba player found on this page');
  const streams = await source.resolvePlayer(page.player, page.url);
  const results = [];
  for (const stream of streams) {
    try {
      const response = await axios.get(stream.url, {
        headers: { ...stream.headers, ...(stream.format === 'MP4' ? { Range: 'bytes=0-65535' } : {}) },
        responseType: 'stream', timeout: 15000, maxRedirects: 3
      });
      const chunks = []; let size = 0;
      for await (const chunk of response.data) { chunks.push(chunk); size += chunk.length; if (size >= 65536) break; }
      const bytes = Buffer.concat(chunks);
      results.push({ server: stream.server, quality: stream.quality, format: stream.format, url: stream.url,
        status: response.status, contentType: response.headers['content-type'], contentRange: response.headers['content-range'],
        valid: stream.format === 'MP4' ? bytes.subarray(4, 8).toString() === 'ftyp' : bytes.toString().startsWith('#EXTM3U') });
    } catch (error) { results.push({ server: stream.server, quality: stream.quality, format: stream.format, valid: false, error: error.response?.status || error.code }); }
  }
  await fs.writeFile('probe-results.json', JSON.stringify({ name: page.name, player: page.player, results }, null, 2));
  console.table(results.map(({ server, quality, format, status, valid }) => ({ server, quality, format, status, valid })));
  console.log('Detailed results saved locally to probe-results.json (excluded from Git).');
  if (!results.some(r => r.valid)) process.exitCode = 1;
})().catch(error => { console.error(error.message.replace(config.tmdbKey || /$^/, '[redacted]')); process.exitCode = 1; });
