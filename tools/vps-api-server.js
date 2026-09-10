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
  const cleanTicker = ticker ? String(ticker).trim().toUpperCase() : '';

  // Endpoint: /api/broker-summary?ticker=BBCA&date=2026-09-09
  if (pathname === '/api/broker-summary' && cleanTicker) {
    const targetDate = date ? String(date).trim() : 'latest';
    const filePath = path.join(DATA_DIR, 'broker-summary', cleanTicker, targetDate + '.json');
    if (fs.existsSync(filePath)) {
      return res.end(fs.readFileSync(filePath, 'utf8'));
    }
    const dirPath = path.join(DATA_DIR, 'broker-summary', cleanTicker);
    if (fs.existsSync(dirPath)) {
      const files = fs.readdirSync(dirPath).filter(f => f.endsWith('.json')).sort().reverse();
      if (files.length > 0) {
        return res.end(fs.readFileSync(path.join(dirPath, files[0]), 'utf8'));
      }
    }
    res.writeHead(404);
    return res.end(JSON.stringify({ error: 'Data not found', ticker: cleanTicker, date: targetDate }));
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

server.listen(PORT, '0.0.0.0', () => {
  console.log('VPS Data Bridge running on port ' + PORT);
});
