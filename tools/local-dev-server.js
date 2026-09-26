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

// Batch 8 points the VPS runners (tools/run-all-screeners-vps.js,
// tools/run-after-market-top5-lock.js) at this daemon on 127.0.0.1:3000, so it
// must be able to reach Supabase; otherwise every heavy action answers
// "Database belum dikonfigurasi." The VPS runtime env is the same file the
// runner shell scripts source, and it is absent on a developer machine.
// Hybrid: Vercel primer + VPS fallback — load all env sources so webhook secret
// and Supabase are available even when .env contains placeholders.
loadEnvFile(path.join(ROOT_DIR, '.env'));
loadEnvFile(path.join(ROOT_DIR, '.env.intraday-runtime'));
loadEnvFile(path.join(ROOT_DIR, '.env.bot'));
loadEnvFile(path.join(ROOT_DIR, '.env.local'));
loadEnvFile(path.join(ROOT_DIR, '.env.preview.local'));
loadEnvFile(path.join(ROOT_DIR, '.env.production.local'));
// VPS runner secrets (owner-only, 600) — critical for telegram-verify-webhook-v3
loadEnvFile('/home/ubuntu/auto-cuan-runner/telegram-webhook-v3-secret.env');
loadEnvFile('/home/ubuntu/auto-cuan-runner/telegram-lifecycle.env');
loadEnvFile('/home/ubuntu/auto-cuan-runner/telegram-auth-recovery-secret.env');
loadEnvFile('/home/ubuntu/auto-cuan-runner/session-secret.env');
loadEnvFile(path.join(ROOT_DIR, '.env.ai-eval-once'));

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
  '/portfolio-planner': '/portfolio-command-center-v2.html',
  '/deepscan': '/index.html',
  '/kelola-keuangan': '/index.html',
  '/money-management': '/index.html',
  // Public BYOK registration form (mirrors the Vercel rewrite so the VPS
  // fallback serves the same URL shape).
  '/register': '/register.html',
  // FASE 2: broker-summary ("broksum") and chart viewers. Both are real views of
  // pages that already resolve their initial state from the query string, so
  // these short paths only need to map to the right page + default tab. The tab
  // selection stays the SPA's own contract (`?ticker=` / `?tab=` / `?page=`).
  '/broksum': '/analisis-saham.html',
  '/broker-summary': '/analisis-saham.html',
  '/bandarmologi': '/analisis-saham.html',
  '/chart': '/index.html'
};

// Default query params merged in at rewrite time for the short paths above.
// An explicit caller-supplied param always wins, so /broksum?tab=intel still
// opens the intel tab instead of the bandarmologi default.
const ROUTE_DEFAULT_QUERY = {
  '/broksum': { tab: 'bandarmologi' },
  '/broker-summary': { tab: 'bandarmologi' },
  '/bandarmologi': { tab: 'bandarmologi' },
  '/chart': { page: 'chart' }
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
  res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-Telegram-Bot-Api-Secret-Token');

  if (req.method === 'OPTIONS') {
    res.statusCode = 204;
    return res.end();
  }

  // 1. Handle API routes
  if (pathname.startsWith('/api/')) {
    let endpointName = pathname.slice('/api/'.length).replace(/\.js$/, '');

    // Alias: /api/track-record -> sector-hot?action=track-record.
    //
    // The Track Record tab used to call /api/sector-hot?action=track-record
    // directly. When this origin (or the Nginx edge in front of it) does not
    // recognise the request it answers with an HTML page, and the browser then
    // fails with: Unexpected token '<', "<!DOCTYPE "... is not valid JSON.
    // Resolving the alias here keeps the tab on a stable JSON URL and removes
    // the dependency on the caller passing the right action.
    if (endpointName === 'track-record') {
      parsedUrl.searchParams.set('action', 'track-record');
      endpointName = 'sector-hot';
      pathname = '/api/sector-hot';
    }

    const apiFile = path.join(API_DIR, endpointName + '.js');

    if (endpointName === 'money-management') {
      req.query = Object.fromEntries(parsedUrl.searchParams.entries());
      req.body = await parseBody(req);
      const mmHandler = require('../lib/money-management-handler');
      return await mmHandler(req, res);
    }

    // Bypass maintenance screen on local dev server
    if (endpointName === 'maintenance-settings') {
      const parsedBody = await parseBody(req);
      if (!parsedBody.action || parsedBody.action === 'get' || parsedBody.action === 'watch-admin-code') {
        return res.status(200).json({
          success: true,
          maintenance: false,
          operational: true,
          config: {
            maintenanceMode: false,
            message: ''
          },
          adminCode: { available: false, active: false, expiresAt: null }
        });
      }
    }

    if (fs.existsSync(apiFile)) {
      try {
        const handler = require(apiFile);
        req.query = Object.fromEntries(parsedUrl.searchParams.entries());
        req.body = await parseBody(req);

        // On-demand fetch broker summary from VPS when requested ticker is not on local disk
        if (endpointName === 'sector-hot' && req.query.action === 'bandarmologi' && req.query.ticker) {
          try {
            const vpsFetcher = require('../lib/vps-data-fetcher');
            await vpsFetcher.ensureBrokerSummary(req.query.ticker, req.query.date || '2026-09-08');
          } catch (fetchErr) {
            console.warn('[VPS-FETCHER] On-demand fetch warning:', fetchErr.message);
          }
        }

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
  //
  // The SPA reads its initial view from `window.location.search`, so a short path
  // like /broksum cannot simply be served as analisis-saham.html — the browser URL
  // must actually carry the tab. Redirecting (302) is therefore the correct
  // mechanism here, and it keeps the address bar shareable/reloadable.
  const defaultQuery = ROUTE_DEFAULT_QUERY[pathname];
  if (defaultQuery) {
    const target = ROUTE_REWRITES[pathname];
    const merged = new URLSearchParams(parsedUrl.searchParams);
    let added = false;
    for (const key of Object.keys(defaultQuery)) {
      // An explicit caller-supplied value always wins.
      if (!merged.has(key)) {
        merged.set(key, defaultQuery[key]);
        added = true;
      }
    }
    if (added) {
      const query = merged.toString();
      res.statusCode = 302;
      res.setHeader('Location', target + (query ? '?' + query : ''));
      return res.end();
    }
    pathname = target;
  } else if (ROUTE_REWRITES[pathname]) {
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
// Loopback by default: the public path is the cloudflared tunnel, which connects
// from inside the host. Setting HOST=0.0.0.0 is only needed when an operator has
// also opened the port in the cloud firewall (Oracle VCN) — the Oracle VCN
// security list blocks every port except 22/3001, so binding wider alone does
// NOT make this publicly reachable.
const HOST = process.env.HOST || '127.0.0.1';

server.listen(PORT, HOST, () => {
  console.log('=================================================');
  console.log(' AUTO-CUAN LOCAL DEVELOPMENT SERVER IS RUNNING');
  console.log(' URL: http://' + HOST + ':' + PORT);
  console.log(' Dashboard:       http://' + HOST + ':' + PORT + '/dashboard');
  console.log(' Analisis Saham:  http://' + HOST + ':' + PORT + '/analisis-saham');
  console.log(' Portfolio:       http://' + HOST + ':' + PORT + '/portfolio-planner');
  console.log('=================================================');
});
