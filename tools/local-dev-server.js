'use strict';

const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT_DIR = path.resolve(__dirname, '..');
const PUBLIC_DIR = path.join(ROOT_DIR, 'public');
const API_DIR = path.join(ROOT_DIR, 'api');
const DATA_DIR = path.join(ROOT_DIR, 'data');

function loadEnvFile(filePath) {
  if (!fs.existsSync(filePath)) return;
  try {
    const content = fs.readFileSync(filePath, 'utf8');
    const lines = content.split('\n');
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#')) continue;
      const eqIdx = trimmed.indexOf('=');
      if (eqIdx <= 0) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      let val = trimmed.slice(eqIdx + 1).trim();
      if ((val.startsWith('"') && val.endsWith('"')) || (val.startsWith("'") && val.endsWith("'"))) {
        val = val.slice(1, -1);
      }
      if (!process.env[key]) {
        process.env[key] = val;
      }
    }
  } catch (err) {
    console.warn('[env] Warning: failed to load', filePath, err.message);
  }
}

loadEnvFile(path.join(ROOT_DIR, '.env.local'));
loadEnvFile(path.join(ROOT_DIR, '.env.preview.local'));
loadEnvFile(path.join(ROOT_DIR, '.env.production.local'));

const MIME_TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'application/javascript; charset=utf-8',
  '.mjs': 'application/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.svg': 'image/svg+xml',
  '.ico': 'image/x-icon',
  '.webp': 'image/webp',
  '.txt': 'text/plain; charset=utf-8',
  '.xml': 'application/xml; charset=utf-8'
};

const ROUTE_REWRITES = {
  '/': '/index.html',
  '/dashboard': '/index.html',
  '/pattern': '/index.html',
  '/review': '/index.html',
  '/analisis-saham': '/analisis-saham.html',
  '/portfolio-planner': '/portfolio-command-center-v2.html'
};

async function parseBody(req) {
  const chunks = [];
  for await (const chunk of req) {
    chunks.push(chunk);
  }
  const raw = Buffer.concat(chunks);
  if (raw.length === 0) return {};
  const contentType = (req.headers['content-type'] || '').toLowerCase();
  if (contentType.includes('application/json')) {
    try {
      return JSON.parse(raw.toString('utf8'));
    } catch {
      return raw.toString('utf8');
    }
  }
  if (contentType.includes('application/x-www-form-urlencoded')) {
    const params = new URLSearchParams(raw.toString('utf8'));
    const result = {};
    for (const [k, v] of params.entries()) {
      result[k] = v;
    }
    return result;
  }
  return raw.toString('utf8');
}

function decorateResponse(res) {
  res.status = function(code) {
    res.statusCode = code;
    return res;
  };
  res.json = function(data) {
    if (!res.getHeader('Content-Type')) {
      res.setHeader('Content-Type', 'application/json; charset=utf-8');
    }
    res.end(JSON.stringify(data));
    return res;
  };
  res.send = function(data) {
    if (typeof data === 'object' && !Buffer.isBuffer(data)) {
      return res.json(data);
    }
    res.end(data);
    return res;
  };
}

const server = http.createServer(async (req, res) => {
  decorateResponse(res);
  const parsedUrl = new URL(req.url, 'http://' + (req.headers.host || 'localhost'));
  let pathname = parsedUrl.pathname;

  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  // 1. Handle API routes
  if (pathname.startsWith('/api/')) {
    const endpointName = pathname.slice('/api/'.length).replace(/\.js$/, '');
    const apiFile = path.join(API_DIR, endpointName + '.js');

    if (fs.existsSync(apiFile)) {
      try {
        const handler = require(apiFile);
        req.query = Object.fromEntries(parsedUrl.searchParams.entries());
        req.body = await parseBody(req);
        
        await handler(req, res);
        return;
      } catch (err) {
        console.error('[API ERROR] ' + pathname + ':', err);
        if (!res.headersSent) {
          res.status(500).json({ error: 'Internal Server Error', message: err.message });
        }
        return;
      }
    } else {
      res.status(404).json({ error: 'API endpoint not found', path: pathname });
      return;
    }
  }

  // 2. Route rewrites for SPA / HTML pages
  if (ROUTE_REWRITES[pathname]) {
    pathname = ROUTE_REWRITES[pathname];
  }

  // 3. Serve from data directory
  if (pathname.startsWith('/data/')) {
    const relativeDataPath = pathname.slice('/data/'.length);
    const fullDataPath = path.join(DATA_DIR, relativeDataPath);
    if (fs.existsSync(fullDataPath) && fs.statSync(fullDataPath).isFile()) {
      const ext = path.extname(fullDataPath).toLowerCase();
      res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
      return fs.createReadStream(fullDataPath).pipe(res);
    }
  }

  // 4. Serve from public directory
  let filePath = path.join(PUBLIC_DIR, pathname);
  if (!fs.existsSync(filePath) || fs.statSync(filePath).isDirectory()) {
    if (fs.existsSync(filePath + '.html')) {
      filePath = filePath + '.html';
    } else {
      const notFoundPath = path.join(PUBLIC_DIR, '404.html');
      if (fs.existsSync(notFoundPath)) {
        res.statusCode = 404;
        res.setHeader('Content-Type', 'text/html; charset=utf-8');
        return fs.createReadStream(notFoundPath).pipe(res);
      }
      res.statusCode = 404;
      return res.end('404 Not Found');
    }
  }

  const ext = path.extname(filePath).toLowerCase();
  res.setHeader('Content-Type', MIME_TYPES[ext] || 'application/octet-stream');
  fs.createReadStream(filePath).pipe(res);
});

const PORT = parseInt(process.env.PORT, 10) || 3000;
const HOST = '127.0.0.1';

server.listen(PORT, HOST, () => {
  console.log('=================================================');
  console.log(' AUTO-CUAN LOCAL DEVELOPMENT SERVER IS RUNNING');
  console.log(' URL: http://' + HOST + ':' + PORT);
  console.log(' Dashboard:       http://' + HOST + ':' + PORT + '/dashboard');
  console.log(' Analisis Saham:  http://' + HOST + ':' + PORT + '/analisis-saham');
  console.log(' Portfolio:       http://' + HOST + ':' + PORT + '/portfolio-planner');
  console.log('=================================================');
});
