'use strict';

const http = require('node:http');
const { createHandler } = require('./api');
const handler = createHandler({ enableProxy: true });
const server = http.createServer((req, res) => {
  handler(req, res).catch(error => {
    console.error(`[server] ${error.code || error.name}`);
    if (!res.headersSent) { res.writeHead(500, { 'Content-Type': 'application/json' }); res.end('{"error":"Internal server error"}'); }
    else res.destroy();
  });
});
server.listen(Number(process.env.PORT || 7040), '0.0.0.0', () => console.log(`Soof-55 listening on ${server.address().port}`));
