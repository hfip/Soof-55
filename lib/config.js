'use strict';

const config = {
  base: (process.env.SHOOF_BASE || 'https://w8.shooflive.cyou').replace(/\/$/, ''),
  name: process.env.ADDON_NAME || 'Soof-55',
  tmdbKey: process.env.TMDB_API_KEY || '7e5f3995e909e9ea8353426c8e71bdca',
  proxyBase: (process.env.PROXY_BASE_URL || '').replace(/\/$/, ''),
  proxySecret: process.env.PROXY_SECRET || '',
  mediaHosts: (process.env.MEDIA_HOSTS || 'cdnz.quest').split(',').map(s => s.trim().toLowerCase()).filter(Boolean),
  userAgent: 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Mobile Safari/537.36'
};

module.exports = config;
