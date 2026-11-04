'use strict';
// C10 — Cache file JSON populer multi-user (LRU + TTL 5-30 detik + validasi mtime + ETag).
// Tujuan (LAMPIRAN_PERFORMA_MULTIUSER.md): ratusan pengguna bersamaan tidak boleh
// memicu baca ulang ribuan file sinkron yang memblokir event loop Node.
// Pola: statSync (murah) tiap request untuk validasi mtime+size; readFileSync+JSON.parse
// hanya saat miss / mtime berubah / TTL kedaluwarsa. ETag = sha1(mtimeMs:size) ringan
// tanpa hash isi file. Bahasa Indonesia, data riil 100% (tidak ada sampel).
const fs = require('fs');
const crypto = require('crypto');

const DEFAULT_TTL_MS = 15000;
const MAX_ENTRIES = 120;

const store = new Map(); // key(absPath) -> { at, ttlMs, mtimeMs, size, data, etag }
const stats = { hits: 0, misses: 0, sets: 0, evictions: 0, mtimeRevalidations: 0 };

function absKey(p) { return String(p); }

function buildEtag(mtimeMs, size) {
  try {
    return 'W/"' + crypto.createHash('sha1').update(String(mtimeMs) + ':' + String(size)).digest('hex').slice(0, 16) + '"';
  } catch (_) { return 'W/"' + String(mtimeMs) + '-' + String(size) + '"'; }
}

function trimStore() {
  if (store.size <= MAX_ENTRIES) return;
  const excess = store.size - MAX_ENTRIES;
  const keys = Array.from(store.keys());
  for (let i = 0; i < excess && i < keys.length; i++) {
    store.delete(keys[i]);
    stats.evictions++;
  }
}

// getJsonFile(absPath, ttlMs=15000): { data, etag, mtimeMs, size, fromCache, mtimeChanged }
function getJsonFile(absPath, ttlMs) {
  const key = absKey(absPath);
  const ttl = (typeof ttlMs === 'number' && ttlMs >= 5000 && ttlMs <= 30000) ? ttlMs : DEFAULT_TTL_MS;
  let st = null;
  try { st = fs.statSync(absPath); } catch (_) { return { data: null, etag: null, mtimeMs: 0, size: 0, fromCache: false, missing: true }; }
  const mtimeMs = Number(st.mtimeMs) || 0;
  const size = Number(st.size) || 0;
  const now = Date.now();
  const entry = store.get(key);
  if (entry && (now - entry.at) < (entry.ttlMs || ttl) && entry.mtimeMs === mtimeMs && entry.size === size) {
    stats.hits++;
    // Refresh LRU
    store.delete(key);
    store.set(key, entry);
    return { data: entry.data, etag: entry.etag, mtimeMs, size, fromCache: true, mtimeChanged: false };
  }
  if (entry && (entry.mtimeMs !== mtimeMs || entry.size !== size)) stats.mtimeRevalidations++;
  stats.misses++;
  let raw = null;
  try { raw = fs.readFileSync(absPath, 'utf8'); } catch (_) { return { data: null, etag: null, mtimeMs, size, fromCache: false, missing: false }; }
  let data = null;
  try { data = JSON.parse(raw); } catch (_) { return { data: null, etag: null, mtimeMs, size, fromCache: false, parseError: true }; }
  const etag = buildEtag(mtimeMs, size);
  const rec = { at: now, ttlMs: ttl, mtimeMs, size, data, etag };
  if (store.has(key)) store.delete(key);
  store.set(key, rec);
  stats.sets++;
  trimStore();
  return { data, etag, mtimeMs, size, fromCache: false, mtimeChanged: true };
}

// setEtagHeaders(res, etag, cacheControl): kembalikan true bila 304 sudah terkirim.
function setEtagHeaders(req, res, etag, cacheControl) {
  try {
    if (res && typeof res.setHeader === 'function' && etag) {
      res.setHeader('ETag', etag);
      if (cacheControl) res.setHeader('Cache-Control', cacheControl);
    }
    const inm = req && req.headers && (req.headers['if-none-match'] || req.headers['If-None-Match']);
    if (inm && etag && String(inm).split(',').map((s) => s.trim()).indexOf(etag) >= 0) {
      if (res && typeof res.status === 'function') { res.status(304); res.end(); }
      return true;
    }
  } catch (_) {}
  return false;
}

function getStats() { return Object.assign({}, stats, { size: store.size, maxEntries: MAX_ENTRIES, defaultTtlMs: DEFAULT_TTL_MS }); }
function clear() { const n = store.size; store.clear(); return n; }

module.exports = { getJsonFile, setEtagHeaders, buildEtag, getStats, clear, DEFAULT_TTL_MS, MAX_ENTRIES };
