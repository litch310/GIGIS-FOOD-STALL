'use strict';
// Web server for Render: serves the frontend and sends api.php requests to
// the Node.js API. Only the files listed below are served, so the PHP
// sources, SQL scripts and .env files in this repository stay private.
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const api = require('./api/index.js');
const { close } = require('./lib/db');
const { ensureSchema } = require('./lib/schema');

const ROOT = __dirname;
const PORT = Number(process.env.PORT || 3000);

const PAGES = {
  '/': 'index.html',
  '/index.html': 'index.html',
  '/index.php': 'index.html',
  '/app.js': 'app.js',
  '/style.css': 'style.css'
};
const MENU_IMAGE = /^\/IMAGES\/menu\/[A-Za-z0-9._-]+\.(jpg|png|webp|svg)$/;
const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.jpg': 'image/jpeg',
  '.png': 'image/png',
  '.webp': 'image/webp',
  '.svg': 'image/svg+xml'
};

function securityHeaders(res) {
  res.setHeader('X-Content-Type-Options', 'nosniff');
  res.setHeader('Referrer-Policy', 'same-origin');
  res.setHeader('X-Frame-Options', 'DENY');
}

function notFound(res) {
  res.statusCode = 404;
  res.setHeader('Content-Type', 'text/plain; charset=utf-8');
  res.end('Not found');
}

function serveFile(req, res, relative) {
  const file = path.join(ROOT, relative);
  fs.stat(file, (error, stat) => {
    if (error || !stat.isFile()) return notFound(res);
    res.statusCode = 200;
    res.setHeader('Content-Type', TYPES[path.extname(file)] || 'application/octet-stream');
    res.setHeader('Content-Length', stat.size);
    // Pages and scripts change with each deploy; menu photos rarely do
    res.setHeader('Cache-Control', relative.startsWith('IMAGES/') ? 'public, max-age=86400' : 'no-cache');
    if (req.method === 'HEAD') return res.end();
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
}

const server = http.createServer((req, res) => {
  securityHeaders(res);
  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, 'http://localhost').pathname);
  } catch {
    return notFound(res);
  }

  if (pathname === '/api.php') {
    return api(req, res).catch(error => {
      console.error('Unhandled API error:', error);
      if (!res.headersSent) res.statusCode = 500;
      res.end();
    });
  }
  if (pathname === '/healthz') {
    res.setHeader('Content-Type', 'text/plain; charset=utf-8');
    return res.end('ok');
  }
  if (req.method !== 'GET' && req.method !== 'HEAD') {
    res.statusCode = 405;
    return res.end();
  }
  if (PAGES[pathname]) return serveFile(req, res, PAGES[pathname]);
  if (MENU_IMAGE.test(pathname)) return serveFile(req, res, pathname.slice(1));
  return notFound(res);
});

ensureSchema()
  .then(created => {
    if (created) console.log('Empty database: created the tables and seed menu from schema.sql.');
    server.listen(PORT, () => console.log(`Gigi's Food House listening on port ${PORT}`));
  })
  .catch(error => {
    console.error('Could not prepare the database. Check DATABASE_URL.', error.message);
    process.exit(1);
  });

function shutdown() {
  server.close(() => close().finally(() => process.exit(0)));
  setTimeout(() => process.exit(0), 10000).unref();
}
process.on('SIGTERM', shutdown);
process.on('SIGINT', shutdown);
