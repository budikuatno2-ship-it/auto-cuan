'use strict';
// C10 backend wiring: ETag/304 + c10 file cache untuk endpoint populer.
// Idempoten, tanpa hardcode kuota, tanpa sampel, tanpa secret.
const fs = require('fs');
const path = require('path');

function patch(file, fn) {
  const p = path.join(__dirname, '..', file);
  let s = fs.readFileSync(p, 'utf8');
  const out = fn(s);
  if (out && out !== s) { fs.writeFileSync(p, out); console.log('patched', file); }
  else console.log('skip', file);
}

// 1) api/candles.js — ETag untuk cache hit + baca IHSG via c10 file cache (mtime+TTL).
patch('api/candles.js', (s) => {
  if (s.includes('c10-json-file-cache')) return null;
  s = s.replace(
    "var { createRateLimiter, clientAddress } = require('../lib/request-rate-limit');",
    "var { createRateLimiter, clientAddress } = require('../lib/request-rate-limit');\nvar c10FileCache = null;\ntry { c10FileCache = require('../lib/c10-json-file-cache'); } catch (_) { c10FileCache = null; }"
  );
  s = s.replace(
    'function setPrivateResponseHeaders(res) {',
    "function c10EtagFor(data) {\n  try {\n    var str = JSON.stringify(data);\n    var h = 0;\n    for (var i = 0; i < str.length; i++) { h = ((h << 5) - h + str.charCodeAt(i)) | 0; }\n    return 'W/\"c' + (str.length) + '-' + (h >>> 0).toString(16) + '\"';\n  } catch (_) { return null; }\n}\nfunction c10Maybe304(req, res, data) {\n  try {\n    var etag = c10EtagFor(data);\n    if (etag && res && typeof res.setHeader === 'function') res.setHeader('ETag', etag);\n    var inm = req && req.headers && (req.headers['if-none-match'] || req.headers['If-None-Match']);\n    if (inm && etag && String(inm).split(',').map(function (x) { return x.trim(); }).indexOf(etag) >= 0) {\n      if (res && typeof res.status === 'function') { res.status(304); res.end(); }\n      return true;\n    }\n  } catch (_) {}\n  return false;\n}\nfunction setPrivateResponseHeaders(res) {"
  );
  // cache hit -> ETag/304
  s = s.replace(
    "    if (cached && cached.data && cached.data.jakarta_today === requestJakartaToday && (Date.now() - cached.timestamp < CACHE_TTL)) {\n      return res.status(200).json(responseForRequest(cached.data, req));\n    }",
    "    if (cached && cached.data && cached.data.jakarta_today === requestJakartaToday && (Date.now() - cached.timestamp < CACHE_TTL)) {\n      var c10out = responseForRequest(cached.data, req);\n      if (c10Maybe304(req, res, c10out)) return;\n      return res.status(200).json(c10out);\n    }"
  );
  // IHSG disk read via c10 file cache (TTL 15 detik + mtime)
  s = s.replace(
    "      var ihsgDiskPath = path.join(process.cwd(), 'data', 'daily-candles', 'IHSG.json');\n      if (fs.existsSync(ihsgDiskPath)) {\n        try {\n          var rawDisk = JSON.parse(fs.readFileSync(ihsgDiskPath, 'utf8'));",
    "      var ihsgDiskPath = path.join(process.cwd(), 'data', 'daily-candles', 'IHSG.json');\n      if (fs.existsSync(ihsgDiskPath)) {\n        try {\n          var rawDisk = (c10FileCache ? c10FileCache.getJsonFile(ihsgDiskPath, 15000).data : JSON.parse(fs.readFileSync(ihsgDiskPath, 'utf8')));"
  );
  return s;
});

// 2) api/quote.js — ETag/304 untuk hotQuoteCache hit (tanpa baca ulang file).
patch('api/quote.js', (s) => {
  if (s.includes('c10-json-file-cache')) return null;
  s = s.replace(
    "var { hotQuoteCache } = require('../lib/in-memory-ttl-cache');",
    "var { hotQuoteCache } = require('../lib/in-memory-ttl-cache');\nvar c10FileCache = null;\ntry { c10FileCache = require('../lib/c10-json-file-cache'); } catch (_) { c10FileCache = null; }\nfunction c10EtagForPayload(payload) {\n  try {\n    var str = JSON.stringify(payload);\n    var h = 0;\n    for (var i = 0; i < str.length; i++) { h = ((h << 5) - h + str.charCodeAt(i)) | 0; }\n    return 'W/\"q' + (str.length) + '-' + (h >>> 0).toString(16) + '\"';\n  } catch (_) { return null; }\n}\nfunction c10Maybe304Quote(req, res, payload) {\n  try {\n    var etag = c10EtagForPayload(payload);\n    if (etag && res && typeof res.setHeader === 'function') res.setHeader('ETag', etag);\n    var inm = req && req.headers && (req.headers['if-none-match'] || req.headers['If-None-Match']);\n    if (inm && etag && String(inm).split(',').map(function (x) { return x.trim(); }).indexOf(etag) >= 0) {\n      if (res && typeof res.status === 'function') { res.status(304); res.end(); }\n      return true;\n    }\n  } catch (_) {}\n  return false;\n}"
  );
  // board local cache via c10 file cache (TTL 30 detik + mtime, sesuai spek 5-30 dtk)
  s = s.replace(
    "      var filePath = path.join(__dirname, '..', 'data', 'arjum-data', 'stock-boards.json');\n      if (fs.existsSync(filePath)) {\n        BOARD_LOCAL_CACHE = JSON.parse(fs.readFileSync(filePath, 'utf8'));",
    "      var filePath = path.join(__dirname, '..', 'data', 'arjum-data', 'stock-boards.json');\n      if (fs.existsSync(filePath)) {\n        BOARD_LOCAL_CACHE = (c10FileCache ? c10FileCache.getJsonFile(filePath, 30000).data : JSON.parse(fs.readFileSync(filePath, 'utf8')));"
  );
  // quote cache hit -> ETag/304 (4 lokasi: financial, daily-context, ranking-list, quote utama)
  s = s.split("setHeaderSafe(res, 'X-Cache', 'HIT');").join("setHeaderSafe(res, 'X-Cache', 'HIT');\n      try { var c10e = c10EtagForPayload(cached || cachedQuote); if (c10e) { setHeaderSafe(res, 'ETag', c10e); var c10inm = req && req.headers && (req.headers['if-none-match'] || req.headers['If-None-Match']); if (c10inm && String(c10inm).split(',').map(function (x) { return x.trim(); }).indexOf(c10e) >= 0) { if (canSendResponse(res)) { res.status(304); res.end(); } return; } } } catch (_) {}");
  return s;
});

// 3) api/sector-hot.js — ownership + overrides via c10 file cache (TTL 15-30 dtk + mtime + ETag).
patch('api/sector-hot.js', (s) => {
  if (s.includes('c10-json-file-cache')) return null;
  s = s.replace(
    "const { hotMarketStructureCache, hotSectorCache } = require('../lib/in-memory-ttl-cache');",
    "const { hotMarketStructureCache, hotSectorCache } = require('../lib/in-memory-ttl-cache');\nlet c10FileCache = null;\ntry { c10FileCache = require('../lib/c10-json-file-cache'); } catch (_) { c10FileCache = null; }"
  );
  s = s.replace(
    "      const raw = fs.readFileSync(p, 'utf8');\n      list = JSON.parse(raw) || [];",
    "      if (c10FileCache) { list = c10FileCache.getJsonFile(p, 15000).data || []; }\n      else { const raw = fs.readFileSync(p, 'utf8'); list = JSON.parse(raw) || []; }"
  );
  s = s.replace(
    "      const ov = JSON.parse(fs.readFileSync(ovPath, 'utf8'));",
    "      const ov = (c10FileCache ? (c10FileCache.getJsonFile(ovPath, 30000).data || { rows: [] }) : JSON.parse(fs.readFileSync(ovPath, 'utf8')));"
  );
  return s;
});

// 4) lib/quota-state.js — config + state via c10 file cache (TTL 5 dtk + mtime).
patch('lib/quota-state.js', (s) => {
  if (s.includes('c10-json-file-cache')) return null;
  s = s.replace(
    "'use strict';",
    "'use strict';\nlet c10FileCache = null;\ntry { c10FileCache = require('./c10-json-file-cache'); } catch (_) { c10FileCache = null; }"
  );
  s = s.replace(
    "function loadConfig() {\n  try {\n    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');",
    "function loadConfig() {\n  try {\n    if (c10FileCache) { const hit = c10FileCache.getJsonFile(CONFIG_PATH, 5000); if (hit && hit.data) { return Object.assign({}, DEFAULTS, hit.data || {}); } }\n    const raw = fs.readFileSync(CONFIG_PATH, 'utf8');"
  );
  return s;
});

console.log('backend wiring done');
