'use strict';

const fs = require('node:fs/promises');
const path = require('node:path');
const fullUniverse = require('./daytrade-full-eligible-universe');

const DEFAULT_CACHE_DIR = path.resolve(process.cwd(), 'data', 'daytrade-intraday-cache');
const DEFAULT_OUTPUT_DIR = path.resolve(process.cwd(), 'data', 'reports');
const DEFAULT_TTL_MINUTES = 2;
const DEFAULT_LIMIT = 30;
const CACHE_VERSION = 1;

function safeTicker(ticker) { return String(ticker || '').toUpperCase().replace(/\.JK$/, '').replace(/[^A-Z0-9_-]/g, ''); }
function numberOrNull(v) { if (v === null || v === undefined || v === '') return null; const n = Number(v); return Number.isFinite(n) ? n : null; }
function asArray(v) { if (Array.isArray(v)) return v; if (v && Array.isArray(v.data)) return v.data; if (v && Array.isArray(v.candidates)) return v.candidates; if (v && Array.isArray(v.results)) return v.results; if (v && Array.isArray(v.top_candidates)) return v.top_candidates; return []; }
function first(row, keys) { for (const k of keys) if (row && row[k] !== undefined && row[k] !== null && row[k] !== '') return row[k]; return null; }
function normalizeCandidate(row) {
  row = row || {};
  return {
    ticker: safeTicker(first(row, ['ticker', 'symbol', 'code'])),
    score: numberOrNull(first(row, ['daytrade_score', 'score', 'daily_score'])),
    last_price: numberOrNull(first(row, ['last_price', 'close', 'close_price'])),
    entry: numberOrNull(first(row, ['entry', 'entry1', 'entry_low', 'buy_price'])),
    entry2: numberOrNull(first(row, ['entry2', 'entry_high'])),
    avg_daily_volume: numberOrNull(first(row, ['avg_daily_volume', 'average_volume', 'volume_avg_20', 'avg_volume_20d', 'avg_volume'])),
    raw: row
  };
}
function normalizeCandidates(rows, limit) {
  return asArray(rows).map(normalizeCandidate).filter((r) => r.ticker).sort((a, b) => (b.score || 0) - (a.score || 0)).slice(0, Number(limit || DEFAULT_LIMIT));
}
function normalizeCandle(c) {
  if (!c) return null;
  const time = Number(c.time || c.timestamp || (c.date ? Date.parse(c.date) / 1000 : NaN));
  const open = Number(c.open); const high = Number(c.high); const low = Number(c.low); const close = Number(c.close); const volume = Number(c.volume || 0);
  if (![time, open, high, low, close, volume].every(Number.isFinite)) return null;
  return { time, date: c.date || new Date(time * 1000).toISOString(), open, high, low, close, volume };
}
function normalizeCandles(candles) { return (Array.isArray(candles) ? candles : []).map(normalizeCandle).filter(Boolean).sort((a, b) => a.time - b.time); }
function calculateVwap(candles) {
  const rows = normalizeCandles(candles); let pv = 0; let vol = 0;
  for (const c of rows) { const typical = (c.high + c.low + c.close) / 3; pv += typical * c.volume; vol += c.volume; }
  return vol > 0 ? pv / vol : null;
}
function openingRange(candles, minutes) {
  const rows = normalizeCandles(candles); if (!rows.length) return { high: null, low: null, candle_count: 0 };
  const start = rows[0].time; const cutoff = start + Number(minutes || 30) * 60;
  const firstRows = rows.filter((c) => c.time < cutoff);
  if (!firstRows.length) return { high: null, low: null, candle_count: 0 };
  return { high: Math.max(...firstRows.map((c) => c.high)), low: Math.min(...firstRows.map((c) => c.low)), candle_count: firstRows.length };
}
function distanceToEntryPct(lastPrice, entry) { lastPrice = numberOrNull(lastPrice); entry = numberOrNull(entry); return lastPrice && entry ? ((lastPrice - entry) / entry) * 100 : null; }
function isMarketSession(nowMs) {
  const wib = new Date(Number(nowMs || Date.now()) + 7 * 60 * 60 * 1000); const day = wib.getUTCDay(); const m = wib.getUTCHours() * 60 + wib.getUTCMinutes();
  return day >= 1 && day <= 5 && m >= 9 * 60 && m <= 15 * 60 + 30;
}
function effectiveTtlMs(ttlMinutes, nowMs) { return isMarketSession(nowMs) ? Number(ttlMinutes || DEFAULT_TTL_MINUTES) * 60000 : Math.max(Number(ttlMinutes || DEFAULT_TTL_MINUTES) * 60000, 12 * 60 * 60000); }
function validateCacheSchema(payload) {
  const errors = [];
  if (!payload || typeof payload !== 'object') errors.push('payload_not_object');
  else {
    if (payload.version !== CACHE_VERSION) errors.push('invalid_version');
    if (!safeTicker(payload.ticker)) errors.push('missing_ticker');
    if (payload.source !== 'yahoo') errors.push('invalid_source');
    if (payload.interval !== '15m') errors.push('invalid_interval');
    if (!payload.session_date) errors.push('missing_session_date');
    if (!payload.updated_at || !Number.isFinite(Date.parse(payload.updated_at))) errors.push('invalid_updated_at');
    if (!Array.isArray(payload.candles)) errors.push('missing_candles');
  }
  return { valid: errors.length === 0, errors };
}

function includesLabel(row, label) { return Array.isArray(row && row.intraday_labels) && row.intraday_labels.includes(label); }
function addLabel(labels, notes, label, note) { labels.push(label); if (note) notes.push(note); }
function deriveIntradayLabels(fields) {
  const labels = []; const notes = [];
  const lastPrice = numberOrNull(fields.last_price); const vwap = numberOrNull(fields.intraday_vwap); const orHigh = numberOrNull(fields.opening_range_high);
  const volumePace = numberOrNull(fields.volume_pace); const distancePct = numberOrNull(fields.distance_to_entry_pct);
  const quality = fields.data_quality || 'NO_INTRADAY_DATA';
  if (quality === 'NO_INTRADAY_DATA') notes.push('No intraday candles available for deterministic labels.');
  if (quality === 'STALE_CACHE') notes.push('Intraday labels use stale cached candles.');

  if (lastPrice !== null && vwap !== null) {
    if (lastPrice >= vwap) addLabel(labels, notes, 'VWAP_SUPPORT', 'Last price is at or above intraday VWAP.');
    else addLabel(labels, notes, 'BELOW_VWAP_RISK', 'Last price is below intraday VWAP.');
  }

  if (fields.opening_range_breakout === true) addLabel(labels, notes, 'OR_BREAKOUT', 'Last price is above opening range high.');

  const attemptedOrHigh = orHigh !== null && fields.opening_range_breakout !== true && Array.isArray(fields.candles) && fields.candles.some((c) => numberOrNull(c.high) !== null && numberOrNull(c.high) >= orHigh);
  if (fields.opening_range_breakdown === true || (attemptedOrHigh && lastPrice !== null && lastPrice < orHigh)) {
    addLabel(labels, notes, 'OR_REJECTED', fields.opening_range_breakdown === true ? 'Last price is below opening range low.' : 'Price tested opening range high but closed back below it.');
  }

  if (volumePace !== null) {
    if (volumePace >= 1.2) addLabel(labels, notes, 'VOLUME_ACCELERATING', 'Intraday volume pace is at least 1.2x average daily volume.');
    else if (volumePace < 0.8) addLabel(labels, notes, 'VOLUME_WEAK', 'Intraday volume pace is below 0.8x average daily volume.');
  }

  const chaseRisk = fields.chase_risk === true || (distancePct !== null && distancePct > 3);
  if (chaseRisk) addLabel(labels, notes, 'CHASE_RISK', 'Last price is more than 3% above entry or existing chase risk is true.');

  const has = (label) => labels.includes(label);
  let confirmation = 'INTRADAY_NEUTRAL';
  if (quality === 'NO_INTRADAY_DATA') confirmation = 'INTRADAY_UNKNOWN';
  else if (quality === 'OK' && has('VWAP_SUPPORT') && has('OR_BREAKOUT') && !has('CHASE_RISK') && !has('VOLUME_WEAK')) confirmation = 'INTRADAY_CONFIRM';
  else if (quality !== 'OK' || has('BELOW_VWAP_RISK') || has('VOLUME_WEAK') || has('CHASE_RISK')) confirmation = 'INTRADAY_CAUTION';

  if (confirmation === 'INTRADAY_CONFIRM') notes.push('Intraday setup is confirmed by VWAP support, opening range breakout, and acceptable chase/volume checks.');
  else if (confirmation === 'INTRADAY_CAUTION') notes.push('Intraday setup requires caution due to data quality, VWAP, volume, or chase risk checks.');
  else if (confirmation === 'INTRADAY_NEUTRAL') notes.push('Intraday setup is neutral because confirm/caution criteria were not fully met.');

  return { intraday_labels: labels, intraday_confirmation_label: confirmation, intraday_notes: notes };
}


function clampScoreAdjustment(value) { return Math.max(-10, Math.min(10, Number(value) || 0)); }
function calculateIntradayScorePreview(fields) {
  const labels = Array.isArray(fields && fields.intraday_labels) ? fields.intraday_labels : [];
  const dataQuality = fields && fields.data_quality || 'NO_INTRADAY_DATA';
  if (['NO_INTRADAY_DATA', 'INCOMPLETE_INTRADAY', 'STALE_CACHE'].includes(dataQuality)) {
    return {
      intraday_score_adjustment_preview: 0,
      intraday_score_adjustment_reasons: [dataQuality + ' DAILY_SCORE_ONLY 0'],
      intraday_priority_label: 'INTRADAY_UNKNOWN'
    };
  }
  const rules = [
    ['VWAP_SUPPORT', 3, 'VWAP_SUPPORT +3'],
    ['OR_BREAKOUT', 4, 'OR_BREAKOUT +4'],
    ['VOLUME_ACCELERATING', 3, 'VOLUME_ACCELERATING +3'],
    ['INTRADAY_CONFIRM', 4, 'INTRADAY_CONFIRM +4'],
    ['BELOW_VWAP_RISK', -4, 'BELOW_VWAP_RISK -4'],
    ['OR_REJECTED', -4, 'OR_REJECTED -4'],
    ['VOLUME_WEAK', -3, 'VOLUME_WEAK -3'],
    ['CHASE_RISK', -5, 'CHASE_RISK -5']
  ];
  let raw = 0;
  const reasons = [];
  const has = (label) => labels.includes(label) || fields && fields.intraday_confirmation_label === label;
  for (const [label, points, reason] of rules) {
    if (has(label)) { raw += points; reasons.push(reason); }
  }
  const adjustment = clampScoreAdjustment(raw);
  if (adjustment !== raw) reasons.push(`CAP ${adjustment}`);

  let priority = 'INTRADAY_WAIT';
  if (dataQuality === 'NO_INTRADAY_DATA') priority = 'INTRADAY_UNKNOWN';
  else if (has('CHASE_RISK') && has('BELOW_VWAP_RISK')) priority = 'INTRADAY_AVOID';
  else if (adjustment >= 7 && !has('CHASE_RISK')) priority = 'INTRADAY_STRONG';
  else if (adjustment >= 3 && adjustment <= 6) priority = 'INTRADAY_OK';
  else if (adjustment >= -2 && adjustment <= 2) priority = 'INTRADAY_WAIT';
  else if (adjustment <= -3) priority = 'INTRADAY_AVOID';

  return { intraday_score_adjustment_preview: adjustment, intraday_score_adjustment_reasons: reasons, intraday_priority_label: priority };
}

function classifyDataQuality(candles, cacheState, metrics) {
  const rows = normalizeCandles(candles);
  if (!rows.length) return 'NO_INTRADAY_DATA';

  const details = metrics || {};
  const vwap = details.intraday_vwap !== undefined ? numberOrNull(details.intraday_vwap) : numberOrNull(calculateVwap(rows));
  const volSum = details.intraday_volume_sum !== undefined ? numberOrNull(details.intraday_volume_sum) : rows.reduce((s, c) => s + c.volume, 0);
  const or = details.opening_range || openingRange(rows, 30);
  const orHigh = numberOrNull(details.opening_range_high !== undefined ? details.opening_range_high : or.high);
  const orLow = numberOrNull(details.opening_range_low !== undefined ? details.opening_range_low : or.low);
  const orCount = numberOrNull(details.opening_range_candle_count !== undefined ? details.opening_range_candle_count : or.candle_count);
  const lastPrice = numberOrNull(details.last_price !== undefined ? details.last_price : rows[rows.length - 1].close);

  if (cacheState && cacheState.stale) return 'INCOMPLETE_INTRADAY';
  if (rows.length < 2 || vwap === null || volSum === null || volSum <= 0 || orCount === null || orCount < 2 || orHigh === null || orLow === null || orLow <= 0 || lastPrice === null) return 'INCOMPLETE_INTRADAY';
  return 'OK';
}
function candleDiagnostics(rows, cacheState) {
  const payload = cacheState && cacheState.payload || {};
  const validOhlcCandles = rows.filter((c) => c.open > 0 && c.high > 0 && c.low > 0 && c.close > 0).length;
  const zeroOhlcCandles = rows.filter((c) => c.open === 0 || c.high === 0 || c.low === 0 || c.close === 0).length;
  const positiveVolumeCandles = rows.filter((c) => c.volume > 0).length;
  return {
    session_date: payload.session_date || null,
    updated_at: payload.updated_at || null,
    candle_count: rows.length,
    valid_ohlc_candles: validOhlcCandles,
    zero_ohlc_candles: zeroOhlcCandles,
    positive_volume_candles: positiveVolumeCandles,
    total_volume: rows.reduce((s, c) => s + c.volume, 0),
    source: payload.source || (cacheState && cacheState.source) || 'yahoo',
    interval: payload.interval || (cacheState && cacheState.interval) || '15m'
  };
}
function observeCandidate(candidate, candles, cacheState) {
  const rows = normalizeCandles(candles); const last = rows[rows.length - 1] || null; const vwap = calculateVwap(rows); const or = openingRange(rows, 30);
  const lastPrice = last ? last.close : candidate.last_price; const entry = candidate.entry || candidate.entry2; const dist = distanceToEntryPct(lastPrice, entry); const volSum = rows.reduce((s, c) => s + c.volume, 0);
  const diagnostics = candleDiagnostics(rows, cacheState);
  const row = {
    ticker: candidate.ticker, score: candidate.score, last_price: lastPrice || null, intraday_vwap: vwap, above_vwap: vwap !== null && lastPrice !== null ? lastPrice >= vwap : false, below_vwap: vwap !== null && lastPrice !== null ? lastPrice < vwap : false,
    opening_range_high: or.high, opening_range_low: or.low, opening_range_breakout: or.high !== null && lastPrice !== null ? lastPrice > or.high : false, opening_range_breakdown: or.low !== null && lastPrice !== null ? lastPrice < or.low : false,
    intraday_volume_sum: volSum, volume_pace: candidate.avg_daily_volume ? volSum / candidate.avg_daily_volume : null, distance_to_entry_pct: dist, chase_risk: dist !== null ? dist > 3 : false,
    data_quality: classifyDataQuality(rows, cacheState, { intraday_vwap: vwap, intraday_volume_sum: volSum, opening_range: or, last_price: lastPrice }), cache: cacheState || { hit: false, stale: false },
    intraday_data_diagnostics: diagnostics,
    intraday_fallback_action: null
  };
  if (row.data_quality === 'INCOMPLETE_INTRADAY' || row.data_quality === 'NO_INTRADAY_DATA' || row.data_quality === 'STALE_CACHE') row.intraday_fallback_action = 'DAILY_SCORE_ONLY';
  const labels = deriveIntradayLabels(Object.assign({ candles: rows }, row));
  return Object.assign(row, labels, calculateIntradayScorePreview(Object.assign({}, row, labels)));
}
function tickerCachePath(cacheDir, ticker) { return path.join(cacheDir, safeTicker(ticker) + '.json'); }
async function readIntradayCache(cacheDir, ticker, nowMs, ttlMinutes) {
  try { const payload = JSON.parse(await fs.readFile(tickerCachePath(cacheDir, ticker), 'utf8')); const candles = normalizeCandles(payload.candles); const updatedAtMs = Date.parse(payload.updated_at || ''); const stale = !Number.isFinite(updatedAtMs) || (Number(nowMs || Date.now()) - updatedAtMs) > effectiveTtlMs(ttlMinutes, nowMs); return { hit: true, stale, payload, candles, schema: validateCacheSchema(payload) }; }
  catch (e) { return { hit: false, stale: true, payload: null, candles: [], error: e.code === 'ENOENT' ? null : e.message }; }
}
async function writeIntradayCache(cacheDir, ticker, candles, meta) {
  await fs.mkdir(cacheDir, { recursive: true }); const now = new Date();
  const payload = { version: CACHE_VERSION, ticker: safeTicker(ticker), source: 'yahoo', range: (meta && meta.range) || '1d', interval: '15m', session_date: (meta && meta.sessionDate) || now.toISOString().slice(0, 10), updated_at: now.toISOString(), candles: normalizeCandles(candles), completeness: meta && meta.completeness || null, is_market_session: isMarketSession(now.getTime()) };
  await fs.writeFile(tickerCachePath(cacheDir, ticker), JSON.stringify(payload, null, 2) + '\n'); return payload;
}
async function fetchYahooIntradayCandles(ticker, opts) {
  opts = opts || {}; const symbol = safeTicker(ticker) + '.JK'; const url = 'https://query2.finance.yahoo.com/v8/finance/chart/' + encodeURIComponent(symbol) + '?range=1d&interval=15m&includePrePost=false';
  const ac = new AbortController(); const timer = setTimeout(() => ac.abort(), opts.timeoutMs || 12000);
  try { const r = await fetch(url, { signal: ac.signal, headers: { 'User-Agent': 'Mozilla/5.0' } }); if (!r.ok) throw new Error('Yahoo HTTP ' + r.status); const data = await r.json(); const result = data && data.chart && data.chart.result && data.chart.result[0]; const q = result && result.indicators && result.indicators.quote && result.indicators.quote[0]; const ts = result && result.timestamp || []; if (!q) return [];
    return normalizeCandles(ts.map((t, i) => ({ time: t, open: q.open[i], high: q.high[i], low: q.low[i], close: q.close[i], volume: q.volume[i] })));
  } finally { clearTimeout(timer); }
}
async function fetchWithCache(ticker, opts, stats) {
  const cached = await readIntradayCache(opts.cacheDir, ticker, opts.nowMs || Date.now(), opts.ttlMinutes); if (cached.hit && !cached.stale && cached.candles.length) { stats.cache_hit++; return { candles: cached.candles, cache: { hit: true, stale: false, payload: cached.payload, source: cached.payload && cached.payload.source, interval: cached.payload && cached.payload.interval } }; }
  if (opts.noFetch) { if (cached.hit && cached.candles.length) { stats.stale_fallback++; return { candles: cached.candles, cache: { hit: true, stale: true, payload: cached.payload, source: cached.payload && cached.payload.source, interval: cached.payload && cached.payload.interval } }; } stats.cache_miss++; return { candles: [], cache: { hit: false, stale: false } }; }
  try { const fresh = await (opts.fetchFn || fetchYahooIntradayCandles)(ticker, opts); if (fresh && fresh.length) { stats.fetch_success++; if (!cached.hit) stats.cache_miss++; await writeIntradayCache(opts.cacheDir, ticker, fresh, { sessionDate: opts.sessionDate }); return { candles: fresh, cache: { hit: cached.hit, stale: false, payload: { source: 'yahoo', interval: '15m', session_date: opts.sessionDate || new Date(opts.nowMs || Date.now()).toISOString().slice(0, 10), updated_at: new Date(opts.nowMs || Date.now()).toISOString() }, source: 'yahoo', interval: '15m' } }; } throw new Error('no_intraday_data'); }
  catch (e) { stats.fetch_fail++; if (cached.hit && cached.candles.length) { stats.stale_fallback++; return { candles: cached.candles, cache: { hit: true, stale: true, fetch_error: e.message, payload: cached.payload, source: cached.payload && cached.payload.source, interval: cached.payload && cached.payload.interval } }; } return { candles: [], cache: { hit: cached.hit, stale: false, fetch_error: e.message } }; }
}
async function loadCandidatesFromFile(file, limit) { return normalizeCandidates(JSON.parse(await fs.readFile(file, 'utf8')), limit); }
function redactSupabaseSecret(value) {
  const serviceKey = process.env.SUPABASE_SERVICE_ROLE_KEY;
  let message = String(value && value.message ? value.message : value || '');
  if (serviceKey) message = message.split(serviceKey).join('[REDACTED_SUPABASE_SERVICE_ROLE_KEY]');
  return message.replace(/Bearer\s+[^\s,}]+/gi, 'Bearer [REDACTED]').replace(/apikey[=:]\s*[^\s,}]+/gi, 'apikey=[REDACTED]');
}
function buildSupabaseCandidatesRestUrl(limit) {
  const base = process.env.SUPABASE_URL;
  if (!base) throw new Error('Missing SUPABASE_URL');
  const url = new URL('/rest/v1/daytrade_screener_latest', base.replace(/\/+$/, '') + '/');
  url.searchParams.set('select', '*');
  url.searchParams.set('order', 'daytrade_score.desc');
  url.searchParams.set('limit', String(Number(limit || DEFAULT_LIMIT)));
  return url.toString();
}
async function loadCandidatesFromSupabase(limit) {
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!key) throw new Error('Missing SUPABASE_SERVICE_ROLE_KEY');
  const url = buildSupabaseCandidatesRestUrl(limit);
  let response;
  try {
    response = await fetch(url, {
      method: 'GET',
      headers: { apikey: key, Authorization: 'Bearer ' + key, Accept: 'application/json' }
    });
  } catch (e) {
    throw new Error('Supabase REST fetch failed: ' + redactSupabaseSecret(e));
  }
  if (!response.ok) {
    let body = '';
    try { body = await response.text(); } catch (_) {}
    throw new Error('Supabase REST fetch failed with HTTP ' + response.status + ': ' + redactSupabaseSecret(body));
  }
  return normalizeCandidates(await response.json(), limit);
}
async function runObserve(opts) {
  opts = Object.assign({ limit: DEFAULT_LIMIT, cacheDir: DEFAULT_CACHE_DIR, outputDir: DEFAULT_OUTPUT_DIR, ttlMinutes: DEFAULT_TTL_MINUTES, fullUniverse: true }, opts || {});
  let candidates; let universe; let universeMeta = {};
  if (opts.candidatesFile || opts.fullUniverse === false) {
    candidates = opts.candidatesFile ? await loadCandidatesFromFile(opts.candidatesFile, opts.limit) : await loadCandidatesFromSupabase(opts.limit);
    universe = candidates;
  } else {
    const loaded = opts.fullUniverseRows ? fullUniverse.buildFullEligibleUniverse(opts.fullUniverseRows, opts.foreignRows) : await fullUniverse.loadFullEligibleUniverseFromSupabase(opts.fetchFn);
    universe = loaded.tickers.map(normalizeCandidate);
    const published = opts.candidateRows ? normalizeCandidates(opts.candidateRows, Number.MAX_SAFE_INTEGER) : await loadCandidatesFromSupabase(1000);
    universeMeta = { full_universe_loaded: true, universe_source: loaded.source, excluded_count: loaded.diagnostics.excluded_count, exclusion_reason_counts: loaded.diagnostics.excluded_by_reason, candidate_count: published.length };
  }
  const stats = { cache_hit: 0, cache_miss: 0, stale_fallback: 0, fetch_success: 0, fetch_fail: 0 }; const rows = [];
  for (const c of universe) { const res = await fetchWithCache(c.ticker, opts, stats); rows.push(observeCandidate(c, res.candles, res.cache)); }
  return buildReport(rows, stats, Object.assign({}, opts, universeMeta, { universeCount: universe.length, requestedLimit: universeMeta.full_universe_loaded ? universe.length : opts.limit }));
}
function countBy(rows, key) { return rows.reduce((m, r) => { const v = String(r[key]); m[v] = (m[v] || 0) + 1; return m; }, {}); }
function countLabels(rows) { return rows.reduce((m, r) => { for (const label of r.intraday_labels || []) m[label] = (m[label] || 0) + 1; return m; }, {}); }
function averageAdjustment(rows) { return rows.length ? rows.reduce((sum, r) => sum + (numberOrNull(r.intraday_score_adjustment_preview) || 0), 0) / rows.length : 0; }
function adjustmentBuckets(rows) { return { positive: rows.filter((r) => (numberOrNull(r.intraday_score_adjustment_preview) || 0) > 0).length, neutral: rows.filter((r) => (numberOrNull(r.intraday_score_adjustment_preview) || 0) === 0).length, negative: rows.filter((r) => (numberOrNull(r.intraday_score_adjustment_preview) || 0) < 0).length }; }
function buildReport(rows, stats, opts) { const date = opts.sessionDate || new Date(opts.nowMs || Date.now()).toISOString().slice(0, 10); return { date, generated_at: new Date(opts.nowMs || Date.now()).toISOString(), source: { candidates: opts.universe_source || (opts.candidatesFile ? 'file:' + opts.candidatesFile : 'supabase:daytrade_screener_latest'), intraday: 'yahoo_chart_15m', cache_dir: opts.cacheDir }, coverage: { requested_limit: Number(opts.requestedLimit ?? opts.limit ?? DEFAULT_LIMIT), universe_source: opts.universe_source || (opts.candidatesFile ? 'file:' + opts.candidatesFile : 'supabase:daytrade_screener_latest'), full_universe_loaded: opts.full_universe_loaded === true, universe_count: Number(opts.universeCount ?? rows.length), evaluated_universe_count: rows.length, provider_checked_count: rows.length, provider_matched_count: rows.filter((r) => r.data_quality !== 'NO_INTRADAY_DATA').length, provider_missing_count: rows.filter((r) => r.data_quality === 'NO_INTRADAY_DATA').length, sampled_evidence_tickers: rows.slice(0, 20).map((r) => r.ticker), excluded_count: Number(opts.excluded_count || 0), exclusion_reason_counts: opts.exclusion_reason_counts || {}, quarantined_count: 0, candidate_count: Number(opts.candidate_count ?? rows.length) }, cache_stats: stats, summary: { candidates: rows.length, data_quality: countBy(rows, 'data_quality'), intraday_labels: countLabels(rows), intraday_confirmation_label: countBy(rows, 'intraday_confirmation_label'), above_vwap: rows.filter((r) => r.above_vwap).length, below_vwap: rows.filter((r) => r.below_vwap).length, opening_range_breakout: rows.filter((r) => r.opening_range_breakout).length, opening_range_breakdown: rows.filter((r) => r.opening_range_breakdown).length, chase_risk: rows.filter((r) => r.chase_risk).length, intraday_score_adjustment_preview: Object.assign({ avg: averageAdjustment(rows) }, adjustmentBuckets(rows)), intraday_priority_label: countBy(rows, 'intraday_priority_label') }, rows } }
function warningLines(report) { const rows = report.rows || []; const threshold = Math.max(2, Math.ceil(rows.length * 0.4)); const warnings = rows.filter((r) => r.data_quality !== 'OK').map((r) => `${r.ticker}: ${r.data_quality}`); const below = rows.filter((r) => includesLabel(r, 'BELOW_VWAP_RISK')).length; const chase = rows.filter((r) => includesLabel(r, 'CHASE_RISK')).length; const data = rows.filter((r) => ['NO_INTRADAY_DATA', 'STALE_CACHE'].includes(r.data_quality)).length; const avoid = rows.filter((r) => r.intraday_priority_label === 'INTRADAY_AVOID').length; const unknown = rows.filter((r) => r.data_quality === 'NO_INTRADAY_DATA' && r.intraday_priority_label === 'INTRADAY_UNKNOWN').length; if (avoid >= threshold) warnings.push(`many INTRADAY_AVOID labels: ${avoid}/${rows.length}`); if (unknown >= threshold) warnings.push(`many INTRADAY_UNKNOWN rows due to missing intraday data: ${unknown}/${rows.length}`); if (below >= threshold) warnings.push(`many BELOW_VWAP_RISK labels: ${below}/${rows.length}`); if (chase >= threshold) warnings.push(`many CHASE_RISK labels: ${chase}/${rows.length}`); if (data >= threshold) warnings.push(`many NO_INTRADAY_DATA / STALE_CACHE rows: ${data}/${rows.length}`); return warnings; }
function markdownReport(report) { const lines = ['# Day Trade Intraday Observe — ' + report.date, '', '## Summary', '', '- candidates: ' + report.summary.candidates, '- universe_source: ' + report.coverage.universe_source, '- universe_count: ' + report.coverage.universe_count, '- evaluated_universe_count: ' + report.coverage.evaluated_universe_count, '- provider_checked_count: ' + report.coverage.provider_checked_count, '- provider_matched_count: ' + report.coverage.provider_matched_count, '- provider_missing_count: ' + report.coverage.provider_missing_count, '- excluded_count: ' + report.coverage.excluded_count, '- exclusion_reason_counts: `' + JSON.stringify(report.coverage.exclusion_reason_counts || {}) + '`', '- candidate_count: ' + report.coverage.candidate_count, '- data_quality: `' + JSON.stringify(report.summary.data_quality) + '`', '- intraday_labels: `' + JSON.stringify(report.summary.intraday_labels) + '`', '- intraday_confirmation_label: `' + JSON.stringify(report.summary.intraday_confirmation_label) + '`', '- intraday_score_adjustment_preview: `' + JSON.stringify(report.summary.intraday_score_adjustment_preview) + '`', '- intraday_priority_label: `' + JSON.stringify(report.summary.intraday_priority_label) + '`', '- cache hit/miss/stale/fetch fail: ' + [report.cache_stats.cache_hit, report.cache_stats.cache_miss, report.cache_stats.stale_fallback, report.cache_stats.fetch_fail].join('/'), '', '## Top Candidates', '', '| Ticker | Last | VWAP | Intraday Labels | Confirmation | Adj | Priority | Reasons | OR High | OR Low | Vol | Pace | Entry Dist % | Chase | Quality |', '|---|---:|---:|---|---|---:|---|---|---:|---:|---:|---:|---:|---|---|']; for (const r of report.rows) lines.push(`| ${r.ticker} | ${fmt(r.last_price)} | ${fmt(r.intraday_vwap)} | ${(r.intraday_labels || []).join(', ') || '-'} | ${r.intraday_confirmation_label || '-'} | ${r.intraday_score_adjustment_preview} | ${r.intraday_priority_label || '-'} | ${(r.intraday_score_adjustment_reasons || []).join('; ') || '-'} | ${fmt(r.opening_range_high)} | ${fmt(r.opening_range_low)} | ${r.intraday_volume_sum} | ${fmt(r.volume_pace)} | ${fmt(r.distance_to_entry_pct)} | ${r.chase_risk ? 'YES' : 'NO'} | ${r.data_quality} |`); const warnings = warningLines(report); lines.push('', '## Intraday Warnings', '', warnings.length ? warnings.map((w) => '- ' + w).join('\n') : '- none', ''); return lines.join('\n'); }
function fmt(n) { return n === null || n === undefined || !Number.isFinite(Number(n)) ? 'n/a' : Number(n).toFixed(2); }
async function writeReports(report, opts) { await fs.mkdir(opts.outputDir, { recursive: true }); const base = path.join(opts.outputDir, 'daytrade-intraday-observe-' + report.date); await fs.writeFile(base + '.md', markdownReport(report)); let json = null; if (opts.writeJson) { json = base + '.json'; await fs.writeFile(json, JSON.stringify(report, null, 2) + '\n'); } return { markdown: base + '.md', json }; }

module.exports = { DEFAULT_CACHE_DIR, DEFAULT_OUTPUT_DIR, DEFAULT_TTL_MINUTES, DEFAULT_LIMIT, CACHE_VERSION, safeTicker, normalizeCandidate, normalizeCandidates, normalizeCandles, calculateVwap, openingRange, distanceToEntryPct, isMarketSession, effectiveTtlMs, validateCacheSchema, classifyDataQuality, deriveIntradayLabels, calculateIntradayScorePreview, candleDiagnostics, observeCandidate, readIntradayCache, writeIntradayCache, fetchYahooIntradayCandles, fetchWithCache, loadCandidatesFromFile, loadCandidatesFromSupabase, runObserve, buildReport, markdownReport, writeReports, redactSupabaseSecret, buildSupabaseCandidatesRestUrl };
