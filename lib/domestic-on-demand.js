'use strict';

/**
 * lib/domestic-on-demand.js
 * ============================================================================
 * V6 W4 — DOMESTIC ON-DEMAND + BOUNDED CACHE
 * ============================================================================
 * A single canonical accessor `getDomesticBroksum(ticker, date)` that:
 *   (a) checks a bounded LRU+TTL cache (default TTL 5 min, max 500 entries);
 *   (b) on miss computes via the CANONICAL `computeDomesticBroksum()` from the
 *       ALL and F originals;
 *   (c) validates inputs with `lib/broksum-provenance.js
 *       isActionableBrokerDataset()` — refuses to derive from stale / synthetic
 *       / no-trade inputs and returns a typed reason;
 *   (d) optionally persists to a versioned cache file
 *       `data/domestic-cache/<date>/<ticker>.json` with a source_version +
 *       input checksums;
 *   (e) NEVER deletes or overwrites the promoted archive files or the untouched
 *       snapshots. It only ever READS them.
 *
 * FEATURE FLAG
 * ------------
 * `config/domestic-cache.json` { enabled, ttl_seconds, max_entries, persist }
 * defaults to enabled=false so production behaviour is unchanged until
 * approved. When disabled, the accessor falls back to a direct compute (no
 * cache, no persist). Rollback = set enabled=false.
 * ============================================================================
 */

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const canonical = require('./broker-accumulation-local');
const provenance = require('./broksum-provenance');
const { InMemoryTtlCache } = require('./in-memory-ttl-cache');

const ROOT = path.resolve(__dirname, '..');
const CONFIG_PATH = process.env.DOMESTIC_CACHE_CONFIG_PATH ||
  path.join(ROOT, 'config', 'domestic-cache.json');
const CACHE_DIR = process.env.DOMESTIC_CACHE_DIR ||
  path.join(ROOT, 'data', 'domestic-cache');
const ARJUM_DIR = process.env.ARJUM_DATA_DIR ||
  path.join(ROOT, 'data', 'arjum-data');

const DEFAULT_CONFIG = Object.freeze({
  enabled: false,
  ttl_seconds: 300,
  max_entries: 500,
  persist: false
});

/** Typed refusal reasons surfaced by the accessor. */
const REFUSE = Object.freeze({
  INVALID_INPUT: 'INVALID_INPUT',
  ALL_MISSING: 'ALL_MISSING',
  FOREIGN_MISSING: 'FOREIGN_MISSING',
  ALL_NOT_ACTIONABLE: 'ALL_NOT_ACTIONABLE',
  FOREIGN_NOT_ACTIONABLE: 'FOREIGN_NOT_ACTIONABLE',
  NOT_RELEASED: 'NOT_RELEASED'
});

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

function loadConfig(configPath) {
  const p = configPath || CONFIG_PATH;
  try {
    if (!fs.existsSync(p)) return Object.assign({}, DEFAULT_CONFIG);
    const parsed = JSON.parse(fs.readFileSync(p, 'utf8'));
    return {
      enabled: parsed.enabled === true,
      ttl_seconds: Number.isFinite(Number(parsed.ttl_seconds)) ? Number(parsed.ttl_seconds) : DEFAULT_CONFIG.ttl_seconds,
      max_entries: Number.isFinite(Number(parsed.max_entries)) ? Number(parsed.max_entries) : DEFAULT_CONFIG.max_entries,
      persist: parsed.persist === true
    };
  } catch (_) {
    return Object.assign({}, DEFAULT_CONFIG);
  }
}

// ---------------------------------------------------------------------------
// Cache (bounded LRU + TTL)
// ---------------------------------------------------------------------------

let _cache = null;
let _cacheConfigKey = null;

function getCache(config) {
  const key = config.max_entries + ':' + config.ttl_seconds;
  if (!_cache || _cacheConfigKey !== key) {
    _cache = new InMemoryTtlCache({
      defaultTtlMs: config.ttl_seconds * 1000,
      maxEntries: config.max_entries
    });
    _cacheConfigKey = key;
  }
  return _cache;
}

/** Test hook: reset the module-level cache. */
function _resetCache() {
  _cache = null;
  _cacheConfigKey = null;
}

// ---------------------------------------------------------------------------
// Archive readers (READ-ONLY — never mutate the promoted files)
// ---------------------------------------------------------------------------

function safeDate(date) {
  const raw = date == null ? '' : String(date).trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(raw) ? raw : null;
}

function readJsonIfExists(filePath) {
  try {
    if (!fs.existsSync(filePath)) return null;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

function readArchive(ticker, date, flow) {
  const t = String(ticker || '').trim().toUpperCase();
  const d = safeDate(date);
  if (!t || !d) return null;
  const dirName = flow === 'F' ? 'broker-summary-F' : 'broker-summary';
  return readJsonIfExists(path.join(ARJUM_DIR, dirName, t, d + '.json'));
}

function checksumOf(obj) {
  try {
    return crypto.createHash('sha256').update(JSON.stringify(obj)).digest('hex');
  } catch (_) {
    return null;
  }
}

// ---------------------------------------------------------------------------
// Persistence (versioned cache file — additive, never touches the archive)
// ---------------------------------------------------------------------------

function persistResult(ticker, date, result, meta) {
  try {
    const t = String(ticker).trim().toUpperCase();
    const d = safeDate(date);
    if (!t || !d) return { ok: false, error: 'invalid key' };
    const dir = path.join(CACHE_DIR, d);
    fs.mkdirSync(dir, { recursive: true });
    const doc = {
      schemaVersion: 1,
      source_version: meta.source_version,
      ticker: t,
      date: d,
      input_checksums: meta.input_checksums,
      computed_at: new Date().toISOString(),
      result
    };
    const file = path.join(dir, t + '.json');
    const tmp = file + '.tmp-' + process.pid + '-' + Date.now();
    fs.writeFileSync(tmp, JSON.stringify(doc, null, 2), 'utf8');
    fs.renameSync(tmp, file);
    return { ok: true, path: file };
  } catch (e) {
    return { ok: false, error: e && e.message };
  }
}

// ---------------------------------------------------------------------------
// Core accessor
// ---------------------------------------------------------------------------

/**
 * Compute the domestic broksum for a ticker/date from the ALL and F originals,
 * gated by the provenance guard. Pure compute (no cache).
 *
 * @returns {{ok:boolean, reason?:string, detail?:string, result?:object, meta?:object}}
 */
function computeDirect(ticker, date) {
  const t = String(ticker || '').trim().toUpperCase();
  const d = safeDate(date);
  if (!t || !d) {
    return { ok: false, reason: REFUSE.INVALID_INPUT, detail: 'ticker and YYYY-MM-DD date required' };
  }

  const all = readArchive(t, d, 'ALL');
  if (!all) return { ok: false, reason: REFUSE.ALL_MISSING, detail: 'no ALL archive for ' + t + ' ' + d };

  const foreign = readArchive(t, d, 'F');
  if (!foreign) return { ok: false, reason: REFUSE.FOREIGN_MISSING, detail: 'no F archive for ' + t + ' ' + d };

  const allVerdict = provenance.isActionableBrokerDataset({ dataset: all, date: d, ticker: t, flow: 'ALL' });
  if (!allVerdict.actionable) {
    return { ok: false, reason: REFUSE.ALL_NOT_ACTIONABLE, detail: allVerdict.reason + ': ' + allVerdict.detail };
  }
  const fVerdict = provenance.isActionableBrokerDataset({ dataset: foreign, date: d, ticker: t, flow: 'F' });
  if (!fVerdict.actionable) {
    return { ok: false, reason: REFUSE.FOREIGN_NOT_ACTIONABLE, detail: fVerdict.reason + ': ' + fVerdict.detail };
  }

  const result = canonical.computeDomesticBroksum(all, foreign, d, t);
  if (!result || result.status !== 'RELEASED') {
    return { ok: false, reason: REFUSE.NOT_RELEASED, detail: (result && result.status) || 'unknown' };
  }

  return {
    ok: true,
    result,
    meta: {
      source_version: 'canonical-computeDomesticBroksum/v1',
      input_checksums: { all: checksumOf(all), foreign: checksumOf(foreign) }
    }
  };
}

/**
 * Canonical accessor. Honours the feature flag: when disabled it computes
 * directly (no cache, no persist); when enabled it uses the bounded LRU+TTL
 * cache and optionally persists a versioned cache file.
 *
 * @param {string} ticker
 * @param {string} date  YYYY-MM-DD
 * @param {object} [options] { config, now }
 * @returns {{ok:boolean, reason?:string, detail?:string, result?:object, cache?:string}}
 */
function getDomesticBroksum(ticker, date, options = {}) {
  const config = options.config || loadConfig();
  const t = String(ticker || '').trim().toUpperCase();
  const d = safeDate(date);

  // Flag disabled -> direct compute, production behaviour unchanged.
  if (!config.enabled) {
    const direct = computeDirect(t, d);
    return Object.assign({ cache: 'disabled' }, direct);
  }

  if (!t || !d) {
    return { ok: false, reason: REFUSE.INVALID_INPUT, detail: 'ticker and YYYY-MM-DD date required', cache: 'miss' };
  }

  const cache = getCache(config);
  const key = t + '|' + d;
  const hit = cache.get(key);
  if (hit) {
    return Object.assign({ cache: 'hit' }, hit);
  }

  const computed = computeDirect(t, d);
  if (!computed.ok) {
    return Object.assign({ cache: 'miss' }, computed);
  }

  const payload = { ok: true, result: computed.result, meta: computed.meta };
  cache.set(key, payload, config.ttl_seconds * 1000);

  if (config.persist) {
    persistResult(t, d, computed.result, computed.meta);
  }

  return Object.assign({ cache: 'miss' }, payload);
}

module.exports = {
  REFUSE,
  DEFAULT_CONFIG,
  CONFIG_PATH,
  CACHE_DIR,
  loadConfig,
  computeDirect,
  getDomesticBroksum,
  persistResult,
  _resetCache
};
