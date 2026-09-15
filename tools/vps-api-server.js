const http = require('http');
const url = require('url');
const fs = require('fs');
const path = require('path');

const PORT = 3001;
const DATA_DIR = path.join(__dirname, '..', 'data', 'arjum-data');
const INSIDER_DIR = path.join(__dirname, '..', 'data', 'insider-network');

let cachedRoster = null;
let cachedNetwork = null;
let lastCacheLoad = 0;

function loadInsiderCaches() {
  const now = Date.now();
  if (cachedRoster && cachedNetwork && (now - lastCacheLoad < 300000)) {
    return;
  }
  try {
    const rFile = path.join(INSIDER_DIR, 'roster.json');
    if (fs.existsSync(rFile)) {
      cachedRoster = JSON.parse(fs.readFileSync(rFile, 'utf8'));
    }
    const nFile = path.join(INSIDER_DIR, 'network.json');
    if (fs.existsSync(nFile)) {
      cachedNetwork = JSON.parse(fs.readFileSync(nFile, 'utf8'));
    }
    lastCacheLoad = now;
  } catch (err) {
    console.error('Error loading insider cache:', err.message);
  }
}

// BATCH 5 Module 4 — VPS Daemon Resilience.
// Cache fallback data terakhir ketika bridge/feed terputus sementara: setiap
// response 2xx yang berhasil disimpan per endpoint+ticker, dan dikembalikan
// lagi ketika request berikutnya gagal (file hilang/sementara). Memori-wajar,
// berumur pendek, dan TIDAK pernah dianggap data segar (hanya cadangan jujur).
const lastResponseCache = new Map();

function cacheKey(route, ticker, id) {
  return [route, String(ticker || '').toUpperCase(), String(id || 'latest')].join('|');
}

function rememberResponse(route, ticker, id, body) {
  try {
    if (typeof body === 'string' && body.length > 0) {
      lastResponseCache.set(cacheKey(route, ticker, id), { body: body, at: Date.now() });
    }
  } catch (_) { /* best-effort */ }
}

function getLastCachedResponse(route, ticker, id) {
  const entry = lastResponseCache.get(cacheKey(route, ticker, id));
  return entry ? entry.body : null;
}

// BATCH 5 Module 4 — helper untuk membalas dari cache fallback (data terakhir)
// dengan header yang jujur: ini data cadangan, BUKAN data segar.
function serveFallback(res, route, ticker, id) {
  const cached = getLastCachedResponse(route, ticker, id);
  if (cached != null) {
    res.setHeader('X-Cache-Fallback', 'true');
    return res.end(cached);
  }
  return null;
}

const server = http.createServer((req, res) => {
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET, OPTIONS');
  res.setHeader('Content-Type', 'application/json');

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    return res.end();
  }

  const parsedUrl = url.parse(req.url, true);
  const pathname = parsedUrl.pathname;
  const { ticker, date } = parsedUrl.query;

  // Sanitasi ketat terhadap Path Traversal dan karakter ilegal
  if (ticker !== undefined && ticker !== null) {
    const rawTickerStr = String(ticker).trim();
    if (rawTickerStr.includes('..') || rawTickerStr.includes('/') || rawTickerStr.includes('\\')) {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: 'Invalid ticker: path traversal characters detected' }));
    }
    const baseTicker = path.basename(rawTickerStr).toUpperCase();
    if (baseTicker && !/^[A-Z0-9_-]+$/.test(baseTicker)) {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: 'Invalid ticker format' }));
    }
  }

  if (date !== undefined && date !== null) {
    const rawDateStr = String(date).trim();
    if (rawDateStr.includes('..') || rawDateStr.includes('/') || rawDateStr.includes('\\')) {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: 'Invalid date: path traversal characters detected' }));
    }
    const baseDate = path.basename(rawDateStr);
    if (baseDate && !/^[A-Z0-9_-]+$/i.test(baseDate)) {
      res.writeHead(400);
      return res.end(JSON.stringify({ error: 'Invalid date format' }));
    }
  }

  const cleanTicker = ticker ? path.basename(String(ticker).trim()).toUpperCase() : '';
  const targetDate = date ? path.basename(String(date).trim()) : 'latest';

  // Endpoint: /api/broker-summary?ticker=BBCA&date=2026-09-09
  if (pathname === '/api/broker-summary' && cleanTicker) {
    const filePath = path.join(DATA_DIR, 'broker-summary', cleanTicker, targetDate + '.json');
    if (fs.existsSync(filePath)) {
      const body = fs.readFileSync(filePath, 'utf8');
      rememberResponse(pathname, cleanTicker, targetDate, body);
      return res.end(body);
    }
    const dirPath = path.join(DATA_DIR, 'broker-summary', cleanTicker);
    if (targetDate === 'latest' && fs.existsSync(dirPath)) {
      const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json') && f !== 'latest.json').sort().reverse();
      if (files.length > 0) {
        const body = fs.readFileSync(path.join(dirPath, files[0]), 'utf8');
        rememberResponse(pathname, cleanTicker, targetDate, body);
        return res.end(body);
      }
    }
    // BATCH 5: bila file hilang sementara, kembalikan data terakhir yang pernah sukses.
    if (serveFallback(res, pathname, cleanTicker, targetDate)) return;
    res.writeHead(404);
    return res.end(JSON.stringify({ error: 'Data not found', ticker: cleanTicker, date: targetDate }));
  }

  // Endpoint: /api/bandarmologi-intel?range=7d  (Batch 2)
  // Serves a pre-aggregated intel index so a read-only deployment can quote
  // fresh scanner data without any local write. Read-only: never computes.
  if (pathname === '/api/bandarmologi-intel') {
    const rawRange = path.basename(String(parsedUrl.query.range || '7d').trim()).toLowerCase();
    const safeRange = /^[0-9]{1,3}d$/.test(rawRange) ? rawRange : '7d';
    const indexPath = path.join(DATA_DIR, '..', 'bandarmologi-intel-indexes', `latest_${safeRange}.json`);
    if (fs.existsSync(indexPath)) {
      const body = fs.readFileSync(indexPath, 'utf8');
      rememberResponse(pathname, '', safeRange, body);
      return res.end(body);
    }
    if (serveFallback(res, pathname, '', safeRange)) return;
    res.writeHead(404);
    return res.end(JSON.stringify({ error: 'Intel index not found', range: safeRange }));
  }

  // Endpoint: /api/available-dates?ticker=BBCA
  if (pathname === '/api/available-dates' && cleanTicker) {
    const dirPath = path.join(DATA_DIR, 'broker-summary', cleanTicker);
    if (fs.existsSync(dirPath)) {
      const files = fs.readdirSync(dirPath)
        .filter(f => f.endsWith('.json'))
        .map(f => f.replace('.json', ''))
        .sort().reverse();
      return res.end(JSON.stringify({ ticker: cleanTicker, dates: files }));
    }
    return res.end(JSON.stringify({ ticker: cleanTicker, dates: [] }));
  }

  // Endpoint: /api/insider-roster?ticker=BBCA
  if (pathname === '/api/insider-roster' && cleanTicker) {
    loadInsiderCaches();
    if (cachedRoster && cachedRoster.tickers && cachedRoster.tickers[cleanTicker]) {
      const rosterList = cachedRoster.tickers[cleanTicker];
      return res.end(JSON.stringify({
        success: true,
        ticker: cleanTicker,
        count: rosterList.length,
        updated_at: cachedRoster.updated_at,
        roster: rosterList
      }));
    }
    const rawP1Path = path.join(DATA_DIR, 'insiders', cleanTicker, 'p1.json');
    if (fs.existsSync(rawP1Path)) {
      try {
        const rawJson = JSON.parse(fs.readFileSync(rawP1Path, 'utf8'));
        const items = rawJson.items || [];
        return res.end(JSON.stringify({
          success: true,
          ticker: cleanTicker,
          count: items.length,
          roster: items
        }));
      } catch (_) {}
    }
    return res.end(JSON.stringify({ success: true, ticker: cleanTicker, count: 0, roster: [] }));
  }

  // Endpoint: /api/insider-network?ticker=BBCA
  if (pathname === '/api/insider-network' && cleanTicker) {
    loadInsiderCaches();
    if (cachedNetwork && cachedNetwork.networks_by_ticker && cachedNetwork.networks_by_ticker[cleanTicker]) {
      const net = cachedNetwork.networks_by_ticker[cleanTicker];
      return res.end(JSON.stringify({
        success: true,
        ticker: cleanTicker,
        updated_at: cachedNetwork.updated_at,
        nodes: net.nodes || [],
        edges: net.edges || [],
        summary: net.summary || {}
      }));
    }
    return res.end(JSON.stringify({
      success: true,
      ticker: cleanTicker,
      nodes: [{ id: 'ticker:' + cleanTicker, ticker: cleanTicker, type: 'ticker', label: cleanTicker, isTarget: true }],
      edges: [],
      summary: { total_shareholders: 0, multi_emiten_relations: 0, connected_tickers: 1 }
    }));
  }

  res.writeHead(404);
  res.end(JSON.stringify({ error: 'Endpoint not found' }));
});

// BATCH 5 Module 4 — Graceful shutdown + unhandled rejection auto-recovery.
let activeServer = null;

function startDaemon(port) {
  const listenPort = Number(port) || PORT;
  if (activeServer) return activeServer;
  activeServer = server.listen(listenPort, '0.0.0.0', () => {
    console.log('VPS Data Bridge running on port ' + listenPort);
  });
  installUnhandledRejectionRecovery();
  return activeServer;
}

function stopDaemon() {
  if (!activeServer) return Promise.resolve();
  const closing = new Promise((resolve) => {
    activeServer.close(() => resolve());
  });
  activeServer = null;
  return closing;
}

function installUnhandledRejectionRecovery() {
  // Auto-recovery: tangkap unhandled rejection agar daemon tidak crash
  // permanen. Log + pulihkan loop event; tidak pernah letakkan proses down.
  process.on('unhandledRejection', (reason) => {
    console.error('Unhandled rejection recovered by VPS daemon:', reason && reason.message ? reason.message : reason);
  });
  process.on('uncaughtException', (err) => {
    console.error('Uncaught exception recovered by VPS daemon:', err && err.message ? err.message : err);
  });
}

module.exports = {
  startDaemon,
  stopDaemon,
  installUnhandledRejectionRecovery,
  getLastCachedResponse,
  rememberResponse,
  cacheKey,
  _lastResponseCache: lastResponseCache
};

// Auto-start hanya bila dieksekusi langsung (bukan via require untuk test).
if (require.main === module) {
  startDaemon();
}
