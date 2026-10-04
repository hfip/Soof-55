'use strict';

const axios = require('axios');
const config = require('./config');

function headers(referer) {
  return {
    'User-Agent': config.userAgent,
    'Accept-Language': 'ar,en;q=0.9',
    ...(referer ? { Referer: referer } : {})
  };
}

async function text(url, referer = config.base + '/', timeout = 8000) {
  const response = await axios.get(url, {
    headers: headers(referer), timeout, maxRedirects: 4,
    maxContentLength: 4 * 1024 * 1024, responseType: 'text'
  });
  return response.data;
}

async function json(url) {
  const response = await axios.get(url, { timeout: 8000, maxContentLength: 2 * 1024 * 1024 });
  return response.data;
}

// Log only a stage, host and HTTP status, never signed URLs or API keys.
function warn(stage, url, error) {
  let host = '';
  try { host = new URL(url).hostname; } catch {}
  console.warn(`[${stage}] ${host}: ${error.response?.status || error.code || error.name || 'error'}`);
}

module.exports = { text, json, headers, warn };
