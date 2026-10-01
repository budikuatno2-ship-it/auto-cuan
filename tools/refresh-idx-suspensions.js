#!/usr/bin/env node
'use strict';

const fs = require('node:fs');
const path = require('node:path');
const manifest = require('../data/fca-transition-2026-09-28.json');
const guard = require('../lib/idx-suspension-guard');

const ENDPOINT = 'https://www.idx.co.id/primary/Home/GetSuspendData';
const REFERER = 'https://www.idx.co.id/id/berita/suspensi/';
const DEFAULT_TIMEOUT_MS = 15000;
const RESULT_COUNT = 1000;

function loadValidTickers(rootDir) {
  const valid = new Set();
  for (const ticker of (manifest.all_exit_tickers || [])) valid.add(guard.normalizeTicker(ticker));
  const file = path.join(rootDir || path.resolve(__dirname, '..'), 'data', 'daytrade-observe-tickers.txt');
  try {
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const ticker = guard.normalizeTicker(line);
      if (/^[A-Z0-9]{2,12}$/.test(ticker)) valid.add(ticker);
    }
  } catch (_) {}
  return valid;
}

function flattenText(value, out, depth) {
  out = out || [];
  depth = depth || 0;
  if (depth > 4 || value == null) return out;
  if (typeof value === 'string' || typeof value === 'number') {
    out.push(String(value));
    return out;
  }
  if (Array.isArray(value)) {
    value.forEach((item) => flattenText(item, out, depth + 1));
    return out;
  }
  if (typeof value === 'object') {
    Object.values(value).forEach((item) => flattenText(item, out, depth + 1));
  }
  return out;
}

function findEventRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  const preferred = ['data', 'Data', 'results', 'Results', 'rows', 'Rows', 'items', 'Items'];
  for (const key of preferred) {
    if (Array.isArray(payload[key])) return payload[key];
  }
  const arrays = Object.values(payload).filter(Array.isArray);
  if (arrays.length === 1) return arrays[0];
  return arrays.sort((a, b) => b.length - a.length)[0] || [];
}

function classifyStatus(row) {
  const text = flattenText(row).join(' ').toLowerCase();
  if (/pembukaan\s+suspensi|buka\s+kembali|dibuka\s+kembali|unsuspend|unsuspended|pencabutan\s+suspensi|revokasi\s+suspensi/.test(text)) {
    return 'ACTIVE';
  }
  if (/suspensi|suspend|suspended|penghentian\s+sementara|trading\s+halt/.test(text)) {
    return 'SUSPENDED';
  }
  return 'UNKNOWN';
}

function extractTickers(row, validTickers) {
  const valid = validTickers || new Set();
  const found = new Set();
  const tickerKeys = [
    'ticker', 'Ticker', 'code', 'Code', 'Kode', 'KodeEmiten', 'Kode_Emiten',
    'StockCode', 'stockCode', 'EmitenCode', 'emitenCode', 'Symbol', 'symbol'
  ];
  for (const key of tickerKeys) {
    if (!row || row[key] == null) continue;
    const direct = guard.normalizeTicker(row[key]);
    if (valid.has(direct)) found.add(direct);
  }

  for (const text of flattenText(row)) {
    const matches = String(text).toUpperCase().match(/\b[A-Z][A-Z0-9]{1,11}\b/g) || [];
    for (const candidate of matches) {
      const ticker = guard.normalizeTicker(candidate);
      if (valid.has(ticker)) found.add(ticker);
    }
  }
  return Array.from(found);
}

function parseEventTime(row) {
  const keys = [
    'event_at', 'EventAt', 'date', 'Date', 'Tanggal', 'tanggal', 'TglPengumuman',
    'CreatedDate', 'createdDate', 'SuspendDate', 'suspendDate', 'DateTime', 'datetime',
    'Time', 'time'
  ];
  for (const key of keys) {
    if (!row || row[key] == null || row[key] === '') continue;
    const value = row[key];
    const numeric = Number(value);
    if (Number.isFinite(numeric) && numeric > 1000000000) {
      const ms = numeric < 1000000000000 ? numeric * 1000 : numeric;
      const dt = new Date(ms);
      if (Number.isFinite(dt.getTime())) return dt.toISOString();
    }
    const ms = Date.parse(String(value));
    if (Number.isFinite(ms)) return new Date(ms).toISOString();
  }
  return null;
}

function seedState(previous) {
  const byTicker = {};
  const previousRows = previous && previous.by_ticker && typeof previous.by_ticker === 'object'
    ? previous.by_ticker
    : {};

  // Only carry forward verified SUSPENDED states. Carrying an old ACTIVE state
  // into a newly fetched snapshot would accidentally make that opening look
  // fresh again even when IDX did not re-confirm it in the current payload.
  for (const [ticker, row] of Object.entries(previousRows)) {
    if (guard.normalizeStatus(row && row.status) !== 'SUSPENDED') continue;
    const clean = guard.normalizeTicker(ticker || row.ticker);
    if (clean) byTicker[clean] = Object.assign({}, row, { ticker: clean, status: 'SUSPENDED' });
  }

  const seedDate = String(manifest.status_date || manifest.generated_at || '2026-09-25').slice(0, 10);
  for (const ticker of (manifest.suspended_as_of_status_date || [])) {
    const clean = guard.normalizeTicker(ticker);
    if (!byTicker[clean]) {
      byTicker[clean] = {
        ticker: clean,
        status: 'SUSPENDED',
        event_at: seedDate + 'T00:00:00+07:00',
        source: 'fca_transition_2026_seed',
        evidence: 'suspended_as_of_status_date'
      };
    }
  }
  return byTicker;
}

function applyEvents(previous, rows, options) {
  options = options || {};
  const fetchedAt = options.fetchedAt || new Date().toISOString();
  const validTickers = options.validTickers || new Set();
  const byTicker = seedState(previous);
  const parsedEvents = [];

  for (const row of (rows || [])) {
    const status = classifyStatus(row);
    if (status === 'UNKNOWN') continue;
    const tickers = extractTickers(row, validTickers);
    if (!tickers.length) continue;
    const eventAt = parseEventTime(row);
    for (const ticker of tickers) {
      parsedEvents.push({
        ticker,
        status,
        event_at: eventAt,
        raw: row
      });
    }
  }

  // Deterministic application: timestamped events oldest->newest. Untimestamped
  // events go last, but only a SUSPENDED event is allowed to mutate state
  // without a timestamp. An untimestamped opening can never re-enable trading.
  parsedEvents.sort((a, b) => {
    const am = Date.parse(a.event_at || '') || Number.MAX_SAFE_INTEGER;
    const bm = Date.parse(b.event_at || '') || Number.MAX_SAFE_INTEGER;
    return am - bm;
  });

  let applied = 0;
  let skippedUnsafeOpening = 0;
  for (const event of parsedEvents) {
    if (event.status === 'ACTIVE' && !event.event_at) {
      skippedUnsafeOpening++;
      continue;
    }

    const existing = byTicker[event.ticker];
    const existingMs = Date.parse(existing && existing.event_at || '') || 0;
    const eventMs = Date.parse(event.event_at || '') || Date.parse(fetchedAt);

    // Never let an older event overwrite a newer known state.
    if (existingMs && eventMs < existingMs) continue;

    byTicker[event.ticker] = {
      ticker: event.ticker,
      status: event.status,
      event_at: event.event_at || fetchedAt,
      observed_at: fetchedAt,
      source: 'idx_public_suspend_feed',
      evidence: event.status === 'SUSPENDED' ? 'official_suspend_event' : 'official_unsuspend_event'
    };
    applied++;
  }

  return { byTicker, parsedEvents, applied, skippedUnsafeOpening };
}

async function fetchSuspendPayload(fetchImpl, options) {
  options = options || {};
  const request = fetchImpl || fetch;
  const timeoutMs = Math.max(1000, Number(options.timeoutMs) || DEFAULT_TIMEOUT_MS);
  const baseHeaders = {
    Accept: 'application/json, text/plain, */*',
    'Accept-Language': 'id-ID,id;q=0.9,en;q=0.7',
    Referer: REFERER,
    'Upgrade-Insecure-Requests': '1',
    'User-Agent': 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/133.0.0.0 Safari/537.36',
    'X-Requested-With': 'XMLHttpRequest'
  };

  // Match the existing IDX diagnostic pattern in this repo: establish an IDX
  // web session first, then call /primary with the cookies. This is more robust
  // against IDX WAF/Cloudflare than a naked API request from the VPS.
  const sessionController = new AbortController();
  const sessionTimer = setTimeout(() => sessionController.abort(), timeoutMs);
  let cookie = '';
  try {
    const sessionResponse = await request('https://www.idx.co.id/id', {
      signal: sessionController.signal,
      headers: baseHeaders
    });
    if (!sessionResponse.ok) throw new Error('IDX session HTTP ' + sessionResponse.status);
    const cookies = typeof sessionResponse.headers.getSetCookie === 'function'
      ? sessionResponse.headers.getSetCookie()
      : [];
    cookie = cookies.length ? cookies.join('; ') : String(sessionResponse.headers.get('set-cookie') || '');
    // Consume the body so the connection is cleanly reusable.
    await sessionResponse.text();
  } finally {
    clearTimeout(sessionTimer);
  }

  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const url = new URL(ENDPOINT);
  url.searchParams.set('resultCount', String(options.resultCount || RESULT_COUNT));
  try {
    const headers = Object.assign({}, baseHeaders);
    if (cookie) headers.Cookie = cookie;
    const response = await request(url.toString(), {
      signal: controller.signal,
      headers
    });
    if (!response.ok) throw new Error('IDX suspend feed HTTP ' + response.status);

    const contentType = String(response.headers.get('content-type') || '').toLowerCase();
    const body = await response.text();
    if (!body.trim() || /text\/html/.test(contentType) || /^\s*</.test(body)) {
      throw new Error('IDX suspend feed returned non-JSON/HTML response');
    }
    try {
      return JSON.parse(body);
    } catch (_) {
      throw new Error('IDX suspend feed returned invalid JSON');
    }
  } finally {
    clearTimeout(timer);
  }
}

function atomicWrite(filePath, value) {
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  const temp = filePath + '.tmp-' + process.pid + '-' + Date.now();
  fs.writeFileSync(temp, JSON.stringify(value, null, 2) + '\n', 'utf8');
  fs.renameSync(temp, filePath);
}
function buildDegradedBootstrapSnapshot(error, options) {
  options = options || {};
  const seedDate = String(manifest.status_date || manifest.generated_at || '2026-09-25').slice(0, 10);
  const seedStamp = new Date(seedDate + 'T00:00:00+07:00').toISOString();
  const byTicker = seedState(null);
  const states = Object.values(byTicker);
  return {
    schema_version: 1,
    source: 'FCA_TRANSITION_SUSPENDED_SEED_DEGRADED',
    endpoint: ENDPOINT,
    degraded: true,
    fetched_at: seedStamp,
    last_attempt_at: (options.now || new Date()).toISOString(),
    latest_event_at: seedStamp,
    feed_row_count: 0,
    parsed_event_count: 0,
    applied_event_count: 0,
    skipped_unsafe_opening_count: 0,
    feed_error: String(error && error.message || error || 'IDX suspension feed unavailable'),
    suspended_count: states.length,
    active_count: 0,
    by_ticker: byTicker
  };
}

function handleFetchFailure(previous, filePath, error, options) {
  options = options || {};
  const dryRun = !!options.dryRun;
  const now = options.now || new Date();

  if (previous) {
    const rows = Object.values(previous.by_ticker || {});
    console.log(JSON.stringify({
      mode: dryRun ? 'DRY_RUN_DEGRADED_PRESERVE' : 'DEGRADED_PRESERVE',
      state_path: filePath,
      fetched_at: previous.fetched_at || null,
      last_attempt_at: now.toISOString(),
      fresh: guard.isSnapshotFresh(previous, { now }),
      feed_error: String(error && error.message || error),
      suspended: rows.filter((row) => guard.normalizeStatus(row && row.status) === 'SUSPENDED').length,
      active: rows.filter((row) => guard.normalizeStatus(row && row.status) === 'ACTIVE').length
    }, null, 2));
    return previous;
  }

  const bootstrap = buildDegradedBootstrapSnapshot(error, { now });
  if (!dryRun) {
    atomicWrite(filePath, bootstrap);
    guard.resetCache();
  }
  console.log(JSON.stringify({
    mode: dryRun ? 'DRY_RUN_DEGRADED_BOOTSTRAP' : 'DEGRADED_BOOTSTRAP',
    state_path: filePath,
    fetched_at: bootstrap.fetched_at,
    last_attempt_at: bootstrap.last_attempt_at,
    fresh: false,
    feed_error: bootstrap.feed_error,
    suspended: bootstrap.suspended_count,
    active: bootstrap.active_count
  }, null, 2));
  return bootstrap;
}


async function main(options) {
  options = options || {};
  const now = options.now || new Date();
  const fetchedAt = now.toISOString();
  const filePath = guard.statePath(options);
  const previous = guard.readSnapshot(options);
  const validTickers = options.validTickers || loadValidTickers(options.rootDir);

  let payload;
  try {
    payload = options.payload || await fetchSuspendPayload(options.fetch, options);
  } catch (error) {
    return handleFetchFailure(previous, filePath, error, {
      dryRun: options.dryRun,
      now
    });
  }

  const rows = findEventRows(payload);
  if (!rows.length) {
    return handleFetchFailure(
      previous,
      filePath,
      new Error('IDX suspension feed tidak memiliki event rows'),
      { dryRun: options.dryRun, now }
    );
  }

  const applied = applyEvents(previous, rows, { fetchedAt, validTickers });
  const states = Object.values(applied.byTicker);
  const latestEventAt = states.map((row) => row.event_at).filter(Boolean).sort().pop() || null;
  const snapshot = {
    schema_version: 1,
    source: 'IDX_PUBLIC_PRIMARY_HOME_GETSUSPENDDATA',
    endpoint: ENDPOINT,
    degraded: false,
    fetched_at: fetchedAt,
    last_attempt_at: fetchedAt,
    feed_error: null,
    latest_event_at: latestEventAt,
    feed_row_count: rows.length,
    parsed_event_count: applied.parsedEvents.length,
    applied_event_count: applied.applied,
    skipped_unsafe_opening_count: applied.skippedUnsafeOpening,
    suspended_count: states.filter((row) => row.status === 'SUSPENDED').length,
    active_count: states.filter((row) => row.status === 'ACTIVE').length,
    by_ticker: applied.byTicker
  };

  if (!options.dryRun) {
    atomicWrite(filePath, snapshot);
    guard.resetCache();
  }

  console.log(JSON.stringify({
    mode: options.dryRun ? 'DRY_RUN' : 'APPLY',
    state_path: filePath,
    fetched_at: snapshot.fetched_at,
    feed_rows: snapshot.feed_row_count,
    parsed_events: snapshot.parsed_event_count,
    applied_events: snapshot.applied_event_count,
    skipped_unsafe_openings: snapshot.skipped_unsafe_opening_count,
    suspended: snapshot.suspended_count,
    active: snapshot.active_count
  }, null, 2));

  return snapshot;
}

if (require.main === module) {
  main({ dryRun: process.argv.includes('--dry-run') }).catch((error) => {
    console.error('[refresh-idx-suspensions] ' + String(error && error.message || error));
    process.exitCode = 1;
  });
}

module.exports = {
  ENDPOINT,
  REFERER,
  DEFAULT_TIMEOUT_MS,
  RESULT_COUNT,
  loadValidTickers,
  flattenText,
  findEventRows,
  classifyStatus,
  extractTickers,
  parseEventTime,
  seedState,
  applyEvents,
  fetchSuspendPayload,
  atomicWrite,
  buildDegradedBootstrapSnapshot,
  handleFetchFailure,
  main
};
