'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// =============================================================================
// FASE 13-14 — VPS Runtime / Cron Scheduler / PostgREST / DB Integrity
// Zero-trust: F13-01/F13-02 are the BEWIS-validated FAIL->PASS pair.
// Other checks are pass-kunci around pipeline invariants.
// =============================================================================

// ---------------------------------------------------------------------------
// F13-01 — getMarketSessionStatus 11:59 Mon adalah LIVE_MARKET (Stage-2 contract)
//          dan broadcast_allowed adalah false (2-min frozen order-book buffer).
//          Sebelum perbaikan filter/guard, runner keliru menganggap BREAK di
//          11:59; setelah perbaikan, guard membedakan run-mode vs broadcast.
//          F13-01/02 mengunci sifat dual ini sebagai BEWIS.
// ---------------------------------------------------------------------------
test('F13-01: 11:59 Mon-Thu STATUS=LIVE/SESSION_1 namun broadcast terblokir', () => {
  const mh = require('../lib/market-hours-guard');
  const at1159 = new Date('2026-09-21T11:59:00+07:00'); // Monday
  // Broadcast gate: CLOSED at 11:59 (order book frozen)
  assert.equal(mh.getMarketSession(at1159), 'CLOSED', 'broadcast session must be CLOSED at 11:59');
  assert.equal(mh.isMarketOpen(at1159), false, 'isMarketOpen must be false at 11:59');
  // Status FULL window: still LIVE_MARKET — diagnosis "Kenapa Tidak Scan?" stays truthful
  const status = mh.getMarketSessionStatus(at1159);
  assert.equal(status.isOpen, true, 'status.isOpen must be true at 11:59 (LIVE_MARKET)');
  assert.equal(status.session, 'SESSION_1', 'status.session must be SESSION_1 at 11:59');
  assert.equal(status.status, 'LIVE_MARKET', 'status must be LIVE_MARKET at 11:59');
  assert.equal(status.broadcast_allowed, false, 'broadcast_allowed must be false at 11:59 (buffer)');
  // But the two layers are intentionally different — isOpen vs broadcast_allowed
  assert.notEqual(status.isOpen, status.broadcast_allowed, 'isOpen vs broadcast_allowed must be intentionally split at 11:59');
});

test('F13-01b: isMarketOpen/broadcast true set equals getMarketSession non-CLOSED set', () => {
  const mh = require('../lib/market-hours-guard');
  for (let totalMin = 540; totalMin <= 960; totalMin++) {
    const h = Math.floor(totalMin / 60), m = totalMin % 60;
    const d = new Date(`2026-09-21T${String(h).padStart(2,'0')}:${String(m).padStart(2,'0')}:00+07:00`);
    const bySession = mh.getMarketSession(d) !== 'CLOSED';
    const byGuard = mh.isMarketOpen(d);
    const byBroadcast = mh.getMarketSessionStatus(d).broadcast_allowed;
    if (bySession !== byGuard) {
      assert.fail(`getMarketSession vs isMarketOpen disagreement at ${h}:${String(m).padStart(2,'0')}`);
    }
    if (byGuard !== byBroadcast) {
      assert.fail(`isMarketOpen vs broadcast_allowed disagreement at ${h}:${String(m).padStart(2,'0')}`);
    }
  }
});

test('F13-02: 11:29 Fri — STATUS=LIVE/SESSION_1 namun broadcast terblokir', () => {
  const mh = require('../lib/market-hours-guard');
  const at1129 = new Date('2026-09-25T11:29:00+07:00'); // Friday
  assert.equal(mh.getMarketSession(at1129), 'CLOSED', 'broadcast session CLOSED at 11:29 Fri');
  assert.equal(mh.isMarketOpen(at1129), false);
  const st = mh.getMarketSessionStatus(at1129);
  assert.equal(st.session, 'SESSION_1', 'status session SESSION_1 at 11:29 Fri');
  assert.equal(st.status, 'LIVE_MARKET');
  assert.equal(st.isOpen, true);
  assert.equal(st.broadcast_allowed, false, 'broadcast must be false at 11:29 Fri');
});

// ---------------------------------------------------------------------------
// F13-03 — run-daily-broker-update marker: crash leaves complete:false marker
// ---------------------------------------------------------------------------
test('F13-03: writeMarker/readMarker round-trip and incomplete marker does not equal complete', () => {
  const mod = require('../tools/run-daily-broker-update');
  const os = require('node:os');
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-f13-03-'));
  const prevDir = process.env.ARJUM_DATA_DIR;
  process.env.ARJUM_DATA_DIR = tmpDir;
  try {
    mod.writeMarker('2026-09-24', { date: '2026-09-24', complete: false, done: 10, pending: 5, total_tickers: 15 });
    const m1 = mod.readMarker('2026-09-24');
    assert.ok(m1, 'marker must be readable');
    assert.equal(m1.complete, false, 'incomplete marker must read as complete:false');
    mod.writeMarker('2026-09-24', { date: '2026-09-24', complete: true, completed_at: new Date().toISOString(), total_tickers: 15 });
    const m2 = mod.readMarker('2026-09-24');
    assert.equal(m2.complete, true, 'complete marker must read as complete:true');
  } finally {
    process.env.ARJUM_DATA_DIR = prevDir;
    fs.rmSync(tmpDir, { recursive: true, force: true });
    delete require.cache[require.resolve('../tools/run-daily-broker-update')];
  }
});

// ---------------------------------------------------------------------------
// F13-04 — arjum-client isMarketHoursWib / isEodReadyWib / getJakartaTime
// ---------------------------------------------------------------------------
test('F13-04: arjum getJakartaTime weekend detection for Sunday 01:00 WIB', () => {
  const arjum = require('../lib/arjum-client');
  const sundayWIB = new Date('2026-09-20T01:00:00+07:00');
  const info = arjum.getJakartaTime(sundayWIB);
  assert.equal(info.isWeekend, true, 'Sunday 01:00 WIB must be weekend');
  assert.equal(arjum.isMarketHoursWib(sundayWIB), false, 'market must be closed on Sunday');
});

test('F13-04b: isEodReadyWib same-day before vs after 16:15 WIB', () => {
  const arjum = require('../lib/arjum-client');
  const before = new Date('2026-09-22T16:14:00+07:00');
  const after = new Date('2026-09-22T16:15:00+07:00');
  assert.equal(arjum.isEodReadyWib('2026-09-22', before), false, '16:14 must not be EOD ready');
  assert.equal(arjum.isEodReadyWib('2026-09-22', after), true, '16:15 must be EOD ready');
});

// ---------------------------------------------------------------------------
// F13-05 — final-schedule.cron timezone & cadence contract
// ---------------------------------------------------------------------------
test('F13-05: final-schedule.cron declares CRON_TZ and each command uses node runner', () => {
  const cronPath = path.join(__dirname, '..', 'deploy/vps/final-schedule.cron');
  const raw = fs.readFileSync(cronPath, 'utf8');
  assert.match(raw, /CRON_TZ=Asia\/Jakarta/, 'CRON_TZ must be declared');
  const lines = raw.split('\n').filter(l => l.trim() && !l.trim().startsWith('#') && !l.includes('CRON_TZ'));
  for (const l of lines) {
    const m = l.match(/^\s*(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(\S+)\s+(.*)$/);
    assert.ok(m, 'cron line must parse: ' + l);
    assert.ok(m[6].includes('node') || m[6].includes('.sh'), 'command must be node or .sh wrapper: ' + l);
  }
});

// ---------------------------------------------------------------------------
// F13-06 — vps-data-fetcher stale-cache path labels truthfully
// ---------------------------------------------------------------------------
test('F13-06: vps-data-fetcher stale-cache path labels as vps_local_cache_stale', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib/vps-data-fetcher.js'), 'utf8');
  assert.match(src, /vps_local_cache_stale/, 'must have stale label');
});

// ---------------------------------------------------------------------------
// F13-07 — daily wrappers force TZ Asia/Jakarta
// ---------------------------------------------------------------------------
test('F13-07: daily-market-context-collector wrapper forces TZ Asia/Jakarta', () => {
  const shPath = path.join(__dirname, '..', 'deploy/vps/run-daily-market-context-collector.sh');
  const txt = fs.readFileSync(shPath, 'utf8');
  assert.match(txt, /TZ=Asia\/Jakarta/, '.sh must force TZ');
});

test('F13-07b: afternoon-recap wrapper forces TZ Asia/Jakarta', () => {
  const shPath = path.join(__dirname, '..', 'deploy/vps/run-daily-afternoon-recap.sh');
  const txt = fs.readFileSync(shPath, 'utf8');
  assert.match(txt, /TZ=Asia\/Jakarta/, '.sh must force TZ');
});

// ---------------------------------------------------------------------------
// F14-01 — PostgREST column-existence spot checks
// ---------------------------------------------------------------------------
test('F14-01: sector-hot migration defines columns selected in debug path', () => {
  const sectorSql = fs.readFileSync(path.join(__dirname, '..', 'supabase/sector-hot.sql'), 'utf8');
  assert.match(sectorSql, /last_price/, 'sector_hot_members_latest must define last_price');
  assert.match(sectorSql, /volume_ratio_30d/, 'must define volume_ratio_30d');
  const dailyCtxSql = fs.readFileSync(path.join(__dirname, '..', 'supabase/stock-daily-context-migration.sql'), 'utf8');
  assert.match(dailyCtxSql, /stock_daily_features/, 'stock_daily_features must exist');
  assert.match(dailyCtxSql, /as_of_trade_date/, 'must have as_of_trade_date');
});

test('F14-01b: foreign_watchlist_daily has required OHLC columns', () => {
  const foreignSql = fs.readFileSync(path.join(__dirname, '..', 'supabase/foreign-watchlist-daily-migration.sql'), 'utf8');
  for (const col of ['open', 'high', 'low', 'close', 'volume', 'nbsa']) {
    assert.match(foreignSql, new RegExp('\\b' + col + '\\b'), 'foreign_watchlist_daily must declare ' + col);
  }
});

// ---------------------------------------------------------------------------
// F14-02 — onConflict must match UNIQUE indexes exactly
// ---------------------------------------------------------------------------
test('F14-02: onConflict ticker matches PRIMARY KEY for daytrade tables', () => {
  const sectorSrc = fs.readFileSync(path.join(__dirname, '..', 'api/sector-hot.js'), 'utf8');
  const daytradeSql = fs.readFileSync(path.join(__dirname, '..', 'supabase/daytrade-screener-migration.sql'), 'utf8');
  assert.match(daytradeSql, /PRIMARY KEY\s*\(ticker\)/, 'daytrade_screener_latest PK must be ticker');
  const re = /from\('daytrade_screener_latest'\)\.upsert\([^,]+,\s*\{\s*onConflict:\s*'([^']+)'/g;
  let m;
  while ((m = re.exec(sectorSrc)) !== null) {
    assert.equal(m[1], 'ticker', 'daytrade_screener_latest onConflict must be ticker, got ' + m[1]);
  }
});

test('F14-02b: foreign_watchlist_daily onConflict trade_date,ticker', () => {
  const importSrc = fs.readFileSync(path.join(__dirname, '..', 'tools/import-foreign-watchlist.js'), 'utf8');
  assert.match(importSrc, /onConflict:\s*'trade_date,ticker'/, 'onConflict must be trade_date,ticker');
  const foreignSql = fs.readFileSync(path.join(__dirname, '..', 'supabase/foreign-watchlist-daily-migration.sql'), 'utf8');
  assert.match(foreignSql, /UNIQUE\s*\(trade_date,\s*ticker\)/, 'migration UNIQUE(trade_date,ticker)');
});

test('F14-02c: stock_daily_history onConflict ticker,trade_date', () => {
  const storeSql = fs.readFileSync(path.join(__dirname, '..', 'supabase/stock-daily-context-migration.sql'), 'utf8');
  assert.match(storeSql, /UNIQUE\s*\(ticker,\s*trade_date\)/, 'stock_daily_history UNIQUE(ticker,trade_date)');
  const storeSrc = fs.readFileSync(path.join(__dirname, '..', 'lib/stock-daily-history-store.js'), 'utf8');
  assert.match(storeSrc, /onConflict:\s*'ticker,trade_date'/, 'store onConflict ticker,trade_date');
});

// ---------------------------------------------------------------------------
// F14-03 — PostgREST error must not be silently swallowed
// ---------------------------------------------------------------------------
test('F14-03: stock-daily-history-store throws on PostgREST error (no silent swallow)', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib/stock-daily-history-store.js'), 'utf8');
  const errorChecks = (src.match(/\.error\)\s*throw/g) || []).length;
  assert.ok(errorChecks >= 5, 'must have >=5 error-throw sites, got ' + errorChecks);
});

test('F14-04: store uses sanitizeTradeDate + isValidCandle before upsert', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib/stock-daily-history-store.js'), 'utf8');
  assert.match(src, /sanitizeTradeDate/, 'must sanitize trade_date');
  assert.match(src, /isValidCandle/, 'must validate candle');
  assert.match(src, /Number\.isFinite/, 'must use Number.isFinite guard');
});

// ---------------------------------------------------------------------------
// F14-05 — arjum circuit breaker resets correctly
// ---------------------------------------------------------------------------
test('F14-05: arjum circuit breaker reset path exists and works', () => {
  const arjum = require('../lib/arjum-client');
  assert.equal(typeof arjum.resetCircuitBreaker, 'function');
  assert.equal(typeof arjum.isCircuitBreakerTripped, 'function');
  arjum.tripCircuitBreaker('test');
  arjum.resetCircuitBreaker();
  assert.equal(arjum.isCircuitBreakerTripped(), false, 'after reset must be untripped');
});

// ---------------------------------------------------------------------------
// F14-06 — bulk upsert batch safety
// ---------------------------------------------------------------------------
test('F14-06: store chunks history upserts into batches of 200', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib/stock-daily-history-store.js'), 'utf8');
  assert.match(src, /UPSERT_BATCH_SIZE\s*=\s*200/, 'UPSERT_BATCH_SIZE must be 200');
});

// ---------------------------------------------------------------------------
// F14-07 — foreign-flow-store throws on PostgREST error
// ---------------------------------------------------------------------------
test('F14-07: foreign-flow-store propagates PostgREST error via throw', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib/foreign-flow-store.js'), 'utf8');
  assert.match(src, /result\.error\) throw/, 'must throw on PostgREST error');
});

// ---------------------------------------------------------------------------
// F14-08 — lifecycle evaluator guards TP/SL with isFinite
// ---------------------------------------------------------------------------
test('F14-08: run-lifecycle-evaluator num() guard rejects non-finite TP/SL', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'tools/run-lifecycle-evaluator.js'), 'utf8');
  assert.match(src, /Number\.isFinite/, 'must guard levels with isFinite');
  assert.match(src, /skipped_no_levels/, 'must skip rows with missing TP/SL');
});

// ---------------------------------------------------------------------------
// F13-09 — candle-fetcher: normalizePayload coercion must not send NaN to DB
// ---------------------------------------------------------------------------
test('F13-09: chart-engine/candle-fetcher filter removes NaN/Infinity before persist', () => {
  const src = fs.readFileSync(path.join(__dirname, '..', 'lib/chart-engine/candle-fetcher.js'), 'utf8');
  assert.match(src, /Number\.isFinite\(c\.open\)/, 'must finite-check open');
  assert.match(src, /Number\.isFinite\(c\.close\)/, 'must finite-check close');
});

// ---------------------------------------------------------------------------
// F14-09 — daily-market-context builder: priceFreshness fail-closed
// ---------------------------------------------------------------------------
test('F14-09: daily-market-context-builder priceFreshness fail-closed on invalid date', () => {
  const builder = require('../lib/daily-market-context-builder');
  assert.equal(builder.priceFreshness(null), 'unknown', 'null date must be unknown');
  assert.equal(builder.priceFreshness(''), 'unknown', 'empty date must be unknown');
  assert.equal(builder.priceFreshness('not-a-date'), 'unknown', 'invalid date must be unknown');
});

// ---------------------------------------------------------------------------
// F13-10 — daily-history-collector isPartialSession boundary
// ---------------------------------------------------------------------------
test('F13-10: isPartialSession boundary 15:59 vs 16:00 vs 16:01 WIB', () => {
  const coll = require('../lib/daily-history-collector');
  const tradeDate = '2026-09-22';
  assert.equal(coll.isPartialSession(tradeDate, new Date('2026-09-22T15:59:00+07:00')), true, '15:59 same-day must be partial');
  assert.equal(coll.isPartialSession(tradeDate, new Date('2026-09-22T16:00:00+07:00')), false, '16:00 same-day must not be partial');
  assert.equal(coll.isPartialSession(tradeDate, new Date('2026-09-22T16:01:00+07:00')), false, '16:01 same-day must not be partial');
  assert.equal(coll.isPartialSession('2026-09-20', new Date('2026-09-22T10:00:00+07:00')), false, 'past date never partial');
});
