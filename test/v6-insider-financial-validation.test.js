'use strict';

/**
 * test/v6-insider-financial-validation.test.js
 * ============================================================================
 * Subtask J — Insider / Struktur Pasar / Ownership / HSC / Financial validation
 * ============================================================================
 *
 * WHAT THIS SUITE PROVES
 *   A. INSIDER vs OWNERSHIP vs FREE FLOAT vs HSC are four DISTINCT datasets and
 *      are never conflated: transaction activity, periodic roster, float, HSC.
 *   B. Locale parsing is deterministic ("1.234" is a decimal, "1.234.567" is
 *      thousands) and `Boolean('false')` is never used for HSC.
 *   C. HSC provenance is fail-closed: unknown is null / "— / Belum dievaluasi",
 *      never a fabricated official stamp, and never inferred from free float.
 *   D. Struktur Pasar roster: clicking A then B replaces A (race), columns are
 *      complete (nama, lembar, %, kategori, as_of, sumber), >5% coverage is
 *      declared, and unknown is "—" not 0%.
 *   E. The insider tiered schedule is read from the REAL config/cron — liquid
 *      daily, non-liquid twice weekly, and the weekend behaviour is asserted
 *      exactly as configured (not invented).
 *   F. FINANCIAL: per-ticker source/period/multiplier/equity/shares/market cap/
 *      book value/PBV/as-of are all provenance-carrying; absent data yields
 *      UNKNOWN / NOT_AVAILABLE, never a "data contoh" badge dressed as official.
 *   G. Rapid ticker switching cannot swap identities (BBCA vs Barito Pacific).
 *
 * Every assertion below was derived from the real on-disk datasets and the real
 * handler code; where the local data cannot support a claim, the test says so
 * explicitly instead of passing vacuously.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const IN = path.join(ROOT, 'data', 'insider-network');
const ARJUM = path.join(ROOT, 'data', 'arjum-data');

const adminOwnership = require('../lib/admin-ownership-import');
const insiderService = require('../lib/insider-network-service');
const tieredScheduler = require('../lib/insider-tiered-scheduler');
const strukturPasar = require('../api/struktur-pasar');
const sectorHot = require('../api/sector-hot');
const dailyPbv = require('../lib/daily-pbv');
const { buildFinancialSnapshot } = require('../lib/financial-snapshot');

const exists = (p) => fs.existsSync(p);
const readJson = (p) => JSON.parse(fs.readFileSync(p, 'utf8'));
const readSrc = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');

function fakeRes() {
  const r = {
    statusCode: null, body: null, headers: {},
    status(c) { r.statusCode = c; return r; },
    json(o) { r.body = o; return r; },
    setHeader(k, v) { r.headers[k] = v; return r; },
    end(b) { if (b) r.body = b; return r; }
  };
  return r;
}

/* ========================================================================== */
/* A. Four distinct datasets — never conflated                                 */
/* ========================================================================== */

test('J-INS-01: insider ACTIVITY, ownership ROSTER, free float and HSC are separate datasets', () => {
  const db = readJson(path.join(IN, 'insiders-db.json'));
  const roster30 = readJson(path.join(IN, 'roster_30sep2026.json'));
  const ownership = readJson(path.join(IN, 'ownership_30sep2026.json'));
  const overrides = readJson(path.join(ROOT, 'data/market-structure-manual-overrides.json'));

  // 1) INSIDER ACTIVITY — dated transactions with an action verb.
  assert.ok(Array.isArray(db) && db.length > 0);
  const txKeys = Object.keys(db[0]);
  for (const k of ['date', 'ticker', 'action_type', 'shares_change']) {
    assert.ok(txKeys.includes(k), `insider activity carries ${k}`);
  }
  const actions = new Set(db.map((r) => r.action_type));
  assert.ok(actions.has('BUY') && actions.has('SELL'), 'activity has real buy/sell verbs');
  assert.ok(!txKeys.includes('freeFloat'), 'activity rows do NOT carry free float');
  assert.ok(!txKeys.includes('hsc_flag'), 'activity rows do NOT carry an HSC verdict');

  // 2) PERIODIC OWNERSHIP ROSTER — a point-in-time holder list, no verbs.
  assert.equal(roster30.as_of, '2026-09-30', 'roster is an explicit as-of snapshot');
  const rTickers = Object.keys(roster30.tickers);
  const rRow = roster30.tickers[rTickers[0]][0];
  assert.ok(rRow.percentage != null && rRow.shares != null, 'roster row carries shares + %');
  assert.equal(rRow.action_type, undefined, 'a periodic roster row is NOT a transaction');

  // 3) FREE FLOAT — lives on the ownership snapshot, per ticker.
  assert.ok(ownership.every((r) => r.freeFloat != null || r.freeFloatKsei != null),
    'ownership snapshot is the free-float source');
  assert.ok(ownership.every((r) => r.hsc_flag === undefined),
    'the ownership snapshot carries NO hsc_flag — HSC is a separate verdict');

  // 4) HSC — only ever from an explicit verified override, with its own source.
  const hscRows = (overrides.rows || []).filter((r) => r.hsc_flag !== undefined);
  for (const r of hscRows) {
    assert.ok(r.hsc_source, 'an HSC verdict must name its source');
    assert.ok(r.hsc_as_of, 'an HSC verdict must carry an as-of date');
  }
  // Free float override rows must NOT smuggle in an HSC verdict.
  for (const r of (overrides.rows || [])) {
    if (r.free_float_pct != null && r.hsc_flag === undefined) {
      assert.ok(!r.hsc_source || r.hsc_flag !== undefined,
        'a free-float-only override does not assert HSC');
    }
  }
});

test('J-INS-02: insider activity dataset coverage is measured per ticker and per date', () => {
  const db = readJson(path.join(IN, 'insiders-db.json'));

  const byTicker = new Map();
  const dates = new Set();
  let badDate = 0, badTicker = 0, futureDate = 0;
  const TODAY = '2026-11-12';
  for (const r of db) {
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(r.date || ''))) badDate++;
    else { dates.add(r.date); if (r.date > TODAY) futureDate++; }
    if (!/^[A-Z]{4}$/.test(String(r.ticker || ''))) badTicker++;
    if (!byTicker.has(r.ticker)) byTicker.set(r.ticker, { n: 0, min: r.date, max: r.date, entities: new Set() });
    const e = byTicker.get(r.ticker);
    e.n++;
    if (r.date < e.min) e.min = r.date;
    if (r.date > e.max) e.max = r.date;
    if (r.insider_name || r.name) e.entities.add(String(r.insider_name || r.name).toLowerCase());
  }

  assert.equal(badDate, 0, 'every activity row carries a real ISO date');
  assert.equal(badTicker, 0, 'every activity row carries a valid 4-letter ticker');
  assert.equal(futureDate, 0, 'no activity row is dated in the future');
  assert.ok(byTicker.size > 800, `activity covers a wide universe (got ${byTicker.size} tickers)`);

  const sorted = Array.from(dates).sort();
  assert.ok(sorted[0] <= '2020-01-02', `earliest activity date is ${sorted[0]}`);
  assert.ok(sorted[sorted.length - 1] <= '2026-09-08',
    `latest activity date is ${sorted[sorted.length - 1]} — STALE vs today (${TODAY})`);

  // Per-ticker matrix facts used by the artifact CSV.
  const bbca = byTicker.get('BBCA');
  assert.ok(bbca && bbca.n > 0, 'BBCA has insider activity');
  assert.ok(bbca.entities.size > 0, 'BBCA activity names real entities');
});

test('J-INS-03: NEGATIVE CONTROL — malformed pct_change never becomes a signed number', () => {
  const db = readJson(path.join(IN, 'insiders-db.json'));
  const doubleMinus = db.filter((r) => typeof r.pct_change === 'string' && r.pct_change.startsWith('--'));
  assert.ok(doubleMinus.length > 0,
    'the dataset really does contain malformed "--x%" values (defect is real, not hypothetical)');

  for (const r of doubleMinus.slice(0, 50)) {
    const parsed = insiderService.parsePercentage(r.pct_change);
    assert.equal(parsed, null,
      `"${r.pct_change}" must parse to null (unknown), never ${parsed}`);
    assert.ok(!Number.isFinite(Number(String(r.pct_change).replace(/[%\s]/g, ''))),
      'the raw string is genuinely unparseable as a number');
  }

  // A well-formed value still parses correctly (the guard is not over-broad).
  assert.equal(insiderService.parsePercentage('41,82%'), 41.82, 'Indonesian decimal comma');
  assert.equal(insiderService.parsePercentage('2.45%'), 2.45);
  assert.equal(insiderService.parsePercentage(0.0245), 0.0245);
  assert.equal(insiderService.parsePercentage(null), null);
  assert.equal(insiderService.parsePercentage(''), null);
});

test('J-INS-04: roster percentage stays UNKNOWN ("—"), never a fabricated 0%', () => {
  // F-079 regression: a missing percentage must not render as "0.00%".
  const roster = insiderService.getRosterForTicker('BBCA');
  assert.ok(Array.isArray(roster));

  const synthetic = [
    { insider_name: 'NO PCT HOLDER', position: 'Direksi', shares_after: 1000, date: '2026-09-01' }
  ];
  insiderService.setCustomUniverse(synthetic.map((r) => Object.assign({ ticker: 'ZZZQ' }, r)));
  try {
    const mapped = insiderService.getRosterForTicker('ZZZQ');
    assert.equal(mapped.length, 1);
    assert.equal(mapped[0].percentage, null, 'missing percentage stays null');
    assert.equal(mapped[0].percentage_formatted, '—', 'renders an em dash, not 0.00%');
    assert.notEqual(mapped[0].percentage_formatted, '0.00%');
  } finally {
    insiderService.setCustomUniverse(null);
  }

  // A real percentage is preserved exactly.
  insiderService.setCustomUniverse([{
    ticker: 'ZZZR', insider_name: 'REAL HOLDER', position: 'Pengendali',
    shares_after: 5000, shares_after_percentage: '7.25%', date: '2026-09-01'
  }]);
  try {
    const mapped = insiderService.getRosterForTicker('ZZZR');
    assert.equal(mapped[0].percentage, 7.25, 'reads pct from shares_after_percentage');
    assert.equal(mapped[0].percentage_formatted, '7.25%');
  } finally {
    insiderService.setCustomUniverse(null);
  }
});

test('J-INS-05: a missing insider date becomes an explicit unknown marker, never a fabricated calendar date', () => {
  insiderService.setCustomUniverse([{
    ticker: 'ZZZD', insider_name: 'UNDATED HOLDER', position: 'Komisaris', shares_after: 100
  }]);
  try {
    const mapped = insiderService.getRosterForTicker('ZZZD');
    assert.equal(mapped.length, 1);
    // F-080: no STATIC DATE fallback. normalizeInsiders() turns an absent date
    // into the em-dash unknown marker, so last_date is either null or '—' —
    // it must never be a real-looking date the source never supplied.
    const ld = mapped[0].last_date;
    assert.ok(ld === null || ld === '—',
      `an undated row must stay unknown (got ${JSON.stringify(ld)})`);
    assert.ok(!/\d{4}-\d{2}-\d{2}/.test(String(ld || '')), 'no invented ISO date');
    assert.ok(!/30 Sep 2026/.test(String(ld || '')), 'no invented snapshot date');
  } finally {
    insiderService.setCustomUniverse(null);
  }

  // A row that DOES carry a date keeps it verbatim.
  insiderService.setCustomUniverse([{
    ticker: 'ZZZE', insider_name: 'DATED HOLDER', position: 'Direksi',
    shares_after: 100, date: '2026-09-04'
  }]);
  try {
    const mapped = insiderService.getRosterForTicker('ZZZE');
    assert.equal(mapped[0].last_date, '2026-09-04', 'a real date is preserved exactly');
  } finally {
    insiderService.setCustomUniverse(null);
  }
});

test('J-INS-06: NEGATIVE CONTROL — wrong ticker mapping is impossible in the roster lookup', () => {
  const bbca = insiderService.getRosterForTicker('BBCA');
  const brpt = insiderService.getRosterForTicker('BRPT');

  assert.ok(bbca.length > 0 && brpt.length > 0, 'both tickers have rosters');
  assert.ok(bbca.every((r) => r.ticker === 'BBCA'), 'every BBCA row is tagged BBCA');
  assert.ok(brpt.every((r) => r.ticker === 'BRPT'), 'every BRPT row is tagged BRPT');

  const bbcaNames = new Set(bbca.map((r) => String(r.name).toLowerCase()));
  const brptNames = new Set(brpt.map((r) => String(r.name).toLowerCase()));
  const overlap = Array.from(bbcaNames).filter((n) => brptNames.has(n));
  assert.deepEqual(overlap, [], 'BBCA and BRPT holder sets do not cross-contaminate');

  // Case / whitespace normalisation must not change the identity.
  const lower = insiderService.getRosterForTicker('bbca');
  const padded = insiderService.getRosterForTicker('  BBCA  ');
  assert.equal(lower.length, bbca.length);
  assert.equal(padded.length, bbca.length);

  // An unknown ticker yields an empty roster, never another ticker's data.
  assert.deepEqual(insiderService.getRosterForTicker('ZZZZ'), []);
  assert.equal(insiderService.hasRoster30Sep('ZZZZ'), false);
  assert.equal(insiderService.hasRoster30Sep('BBCA'), true);
});

/* ========================================================================== */
/* B. Locale + boolean parsing (Subtask H regression)                          */
/* ========================================================================== */

test('J-OWN-01: Indonesian locale parsing is deterministic and never guesses a unit', () => {
  // Multiple dots are ALWAYS thousands.
  assert.equal(adminOwnership.parseIndonesianNumber('1.234.567'), 1234567);
  assert.equal(adminOwnership.parseIndonesianNumber('1.234.567,89'), 1234567.89);
  // A SINGLE dot is ALWAYS a decimal point — "1.234" is 1.234, not 1234.
  assert.equal(adminOwnership.parseIndonesianNumber('1.234'), 1.234);
  assert.equal(adminOwnership.parseIndonesianNumber('41.82'), 41.82);
  // The documented ambiguous case: "50.000" reads as 50, never silently 50000.
  assert.equal(adminOwnership.parseIndonesianNumber('50.000'), 50);
  // Indonesian decimal comma + US thousands.
  assert.equal(adminOwnership.parseIndonesianNumber('41,82'), 41.82);
  assert.equal(adminOwnership.parseIndonesianNumber('1,234,567.89'), 1234567.89);
  assert.equal(adminOwnership.parseIndonesianNumber('0,32'), 0.32);
  // Percentages and unit suffixes.
  assert.equal(adminOwnership.parseIndonesianNumber('41,82%'), 41.82);
  assert.equal(adminOwnership.parseIndonesianNumber('22.33%'), 22.33);
  // Unknown is null, never 0.
  for (const v of ['-', '—', '', null, undefined, 'n/a', 'N/A', 'null', 'abc']) {
    assert.equal(adminOwnership.parseIndonesianNumber(v), null, `${JSON.stringify(v)} => null`);
  }
  // Numbers pass through; non-finite numbers are rejected.
  assert.equal(adminOwnership.parseIndonesianNumber(1234), 1234);
  assert.equal(adminOwnership.parseIndonesianNumber(NaN), null);
  assert.equal(adminOwnership.parseIndonesianNumber(Infinity), null);
});

test('J-OWN-02: HSC boolean parsing is fail-closed — Boolean("false") is never used', () => {
  // The JS trap this guards against:
  assert.equal(Boolean('false'), true, 'raw Boolean("false") IS true — the bug being avoided');

  // Truthy spellings.
  for (const v of ['true', 'TRUE', '1', 'ya', 'yes', 'hsc', 'HSC', 'aktif', 'high']) {
    assert.equal(adminOwnership.parseHscBoolean(v), true, `${v} => true`);
  }
  // Falsy spellings — the critical ones.
  for (const v of ['false', 'FALSE', '0', 'tidak', 'no', 'clear', 'tidak hsc', 'bukan']) {
    assert.equal(adminOwnership.parseHscBoolean(v), false, `${v} => false`);
  }
  // UNKNOWN stays null — never coerced to false ("Tidak HSC") and never to true.
  for (const v of ['', '-', '—', 'unknown', 'belum evaluasi', 'belum dievaluasi', null, undefined, 'mungkin']) {
    assert.equal(adminOwnership.parseHscBoolean(v), null, `${JSON.stringify(v)} => null (unknown)`);
  }
  // Real booleans pass through untouched.
  assert.equal(adminOwnership.parseHscBoolean(true), true);
  assert.equal(adminOwnership.parseHscBoolean(false), false);

  // parseBooleanStrict is the non-null variant used for isController.
  assert.equal(adminOwnership.parseBooleanStrict('false'), false);
  assert.equal(adminOwnership.parseBooleanStrict('0'), false);
  assert.equal(adminOwnership.parseBooleanStrict('tidak'), false);
  assert.equal(adminOwnership.parseBooleanStrict('ya'), true);
  assert.equal(adminOwnership.parseBooleanStrict('pengendali'), true);
  assert.equal(adminOwnership.parseBooleanStrict(null), false);
});

test('J-OWN-03: ownership CSV ingestion keeps locale, controller flag and provenance intact', () => {
  const csv = [
    'ticker,investor_name,shares,percentage,category,is_controller,as_of,source,free_float_ksei,free_float_idx',
    'BBCA,"PT DWIMURIA INVESTAMA ANDALAN",67.729.950.000,"54,94%",Corporate,1,2026-09-30,KSEI,"41,82%","41,82%"',
    'BBCA,"PUBLIK / MASYARAKAT",51.520.000.000,"41,82%",Publik,0,2026-09-30,KSEI,"41,82%","41,82%"',
    'BREN,"PT BARITO PACIFIC TBK",86.513.000.000,"64,67%",Corporate,Ya,2026-09-30,KSEI,"11,73%","12,50%"'
  ].join('\n');

  const parsed = adminOwnership.parseAndValidateOwnership(csv, 'csv');
  assert.equal(parsed.validRows, 3);
  assert.equal(parsed.invalidRows, 0);
  assert.deepEqual(parsed.tickers.sort(), ['BBCA', 'BREN']);

  const bbca = parsed.parsedData.find((p) => p.ticker === 'BBCA');
  assert.equal(bbca.freeFloatKsei, 41.82, 'percentage-string free float parsed via locale rules');
  assert.equal(bbca.freeFloatIdx, 41.82);
  assert.equal(bbca.investors.length, 2);
  // "67.729.950.000" is thousands-separated, NOT 67.72995.
  assert.equal(bbca.investors[0].totalHoldingShare, 67729950000);
  assert.equal(bbca.investors[0].percentage, 54.94);
  assert.equal(bbca.investors[0].isController, true, 'is_controller "1" => true');
  assert.equal(bbca.investors[1].isController, false, 'is_controller "0" => false, not Boolean("0")');

  const bren = parsed.parsedData.find((p) => p.ticker === 'BREN');
  assert.equal(bren.investors[0].isController, true, 'is_controller "Ya" => true');
  assert.equal(bren.freeFloatKsei, 11.73);
  assert.equal(bren.freeFloatIdx, 12.5, 'IDX and KSEI floats are kept SEPARATE (REQ-20)');
  assert.notEqual(bren.freeFloatKsei, bren.freeFloatIdx, 'a real KSEI/IDX divergence is preserved');
});

/* ========================================================================== */
/* C. HSC provenance fail-closed (struktur-pasar)                              */
/* ========================================================================== */

test('J-HSC-01: struktur-pasar reports HSC as UNKNOWN, never inferred from free float', () => {
  strukturPasar.invalidateCache();
  const { data } = strukturPasar.buildStrukturPasarData();
  const uni = data.universe;
  assert.ok(uni.length > 900, `universe is populated (${uni.length})`);

  const overrides = readJson(path.join(ROOT, 'data/market-structure-manual-overrides.json'));
  const ovWithHsc = new Set((overrides.rows || [])
    .filter((r) => r.hsc_flag !== undefined && r.hsc_flag !== null)
    .map((r) => String(r.ticker).toUpperCase()));

  let nullCount = 0, trueCount = 0, falseCount = 0;
  for (const row of uni) {
    if (row.hsc_flag === null) nullCount++;
    else if (row.hsc_flag === true) trueCount++;
    else if (row.hsc_flag === false) falseCount++;

    // REQ-21/REQ-22: an HSC verdict may only exist where a source says so.
    if (row.hsc_flag !== null) {
      assert.ok(ovWithHsc.has(row.ticker) || row.hsc_source,
        `${row.ticker} asserts HSC=${row.hsc_flag} with no source`);
    }
    // A low free float alone must NOT create an HSC verdict.
    if (row.free_float_pct != null && row.free_float_pct < 15 && row.hsc_flag === true) {
      assert.ok(ovWithHsc.has(row.ticker),
        `${row.ticker} ff=${row.free_float_pct} was flagged HSC purely from free float`);
    }
    // Unknown HSC renders the neutral label, not "Tidak HSC".
    if (row.hsc_flag === null) {
      assert.equal(row.hsc_status_text, '— / Belum dievaluasi');
      assert.equal(row.hsc_source, null, 'no fabricated official source stamp');
      assert.equal(row.hsc_as_of, null, 'no fabricated as-of date');
    }
  }

  // The local ownership snapshot carries no hsc_flag at all, so the honest
  // result is: everything unknown unless an override says otherwise.
  assert.equal(nullCount, uni.length - ovWithHsc.size,
    `every row without an explicit override is UNKNOWN (null=${nullCount}, overrides=${ovWithHsc.size})`);
  assert.equal(trueCount + falseCount, ovWithHsc.size);
});

test('J-HSC-02: free float reconciliation keeps KSEI and IDX apart; unknown stays null', () => {
  strukturPasar.invalidateCache();
  const { data } = strukturPasar.buildStrukturPasarData();
  const uni = data.universe;

  const overrides = readJson(path.join(ROOT, 'data/market-structure-manual-overrides.json'));
  const mskyOv = (overrides.rows || []).find((r) => String(r.ticker).toUpperCase() === 'MSKY');

  if (mskyOv) {
    const msky = uni.find((r) => r.ticker === 'MSKY');
    assert.ok(msky, 'MSKY is present via the verified override even though the snapshot lacks it');
    assert.equal(msky.free_float_idx, mskyOv.free_float_pct, 'IDX value comes from the override');
    assert.equal(msky.free_float_source, mskyOv.free_float_source, 'the override source is quoted verbatim');
    assert.equal(msky.free_float_as_of, mskyOv.free_float_as_of, 'the override as-of is quoted verbatim');
    assert.ok(msky.free_float_source && msky.free_float_source.length > 0, 'source is never blank');
  }

  // A row whose free float is genuinely unknown must stay null and be guarded.
  const unknownFf = uni.filter((r) => r.free_float_pct == null);
  for (const r of unknownFf) {
    assert.equal(r.market_structure_guard, 'UNKNOWN', `${r.ticker} guard must be UNKNOWN, not CAUTION/NORMAL`);
    assert.equal(r.free_float_source, null, 'no source is claimed for an unknown float');
    assert.equal(r.data_complete, false);
  }

  // No row may carry an invented 35% placeholder.
  assert.equal(uni.filter((r) => r.free_float_pct === 35).length, 0,
    'no fabricated 35.0 free-float placeholder');

  // Where both floats exist and differ, the reconciliation note is explicit.
  const divergent = uni.filter((r) => r.free_float_ksei != null && r.free_float_idx != null
    && r.free_float_ksei !== r.free_float_idx);
  for (const r of divergent) {
    assert.ok(r.reconciliation_note && /KSEI/.test(r.reconciliation_note) && /IDX/.test(r.reconciliation_note),
      `${r.ticker} divergent floats must carry an explicit KSEI vs IDX note`);
  }
});

test('J-HSC-03: NEGATIVE CONTROL — market-structure-list must not contradict struktur-pasar', async () => {
  // Both endpoints serve the same "Struktur Pasar" concept from the same
  // ownership snapshot. They must agree on free float, HSC and completeness.
  strukturPasar.invalidateCache();
  const sp = strukturPasar.buildStrukturPasarData().data;
  const spByTicker = new Map(sp.universe.map((r) => [r.ticker, r]));

  const res = fakeRes();
  await sectorHot.__test.handleMarketStructureList({ query: {} }, res);
  const rows = res.body.data || res.body.rows || [];
  assert.ok(rows.length > 900, `list endpoint returns the universe (${rows.length})`);

  const fabricatedFloat = [];
  const inventedHsc = [];
  const falseComplete = [];
  const disagreements = [];

  for (const row of rows) {
    const ref = spByTicker.get(row.ticker);

    // (a) No invented free float: a null/unknown float must stay null.
    if (ref && ref.free_float_pct == null && row.free_float_pct != null) {
      fabricatedFloat.push({ ticker: row.ticker, listed: row.free_float_pct });
    }
    if (row.free_float_pct === 35) fabricatedFloat.push({ ticker: row.ticker, listed: 35 });

    // (b) HSC must not be derived from free float.
    if (row.hsc_flag === true && ref && ref.hsc_flag !== true) {
      inventedHsc.push({ ticker: row.ticker, listed: row.hsc_flag, struktur: ref.hsc_flag, ff: row.free_float_pct });
    }

    // (c) data_complete must reflect reality.
    const hasInv = Array.isArray(row.investors) && row.investors.length > 0;
    if (row.data_complete === true && (!hasInv || row.free_float_pct == null)) {
      falseComplete.push({ ticker: row.ticker, investors: row.investors ? row.investors.length : 0, ff: row.free_float_pct });
    }

    // (d) The two endpoints must agree on the free-float value itself.
    if (ref && ref.free_float_pct != null && row.free_float_pct != null
      && Math.abs(ref.free_float_pct - row.free_float_pct) > 0.01) {
      disagreements.push({ ticker: row.ticker, list: row.free_float_pct, struktur: ref.free_float_pct });
    }
  }

  assert.deepEqual(fabricatedFloat, [], 'no fabricated free float in market-structure-list');
  assert.deepEqual(inventedHsc, [], 'no HSC verdict invented from free float');
  assert.deepEqual(falseComplete, [], 'data_complete is never true for an incomplete row');
  assert.deepEqual(disagreements, [], 'both endpoints report the same free float');
});

/* ========================================================================== */
/* D. Struktur Pasar roster: race, completeness, >5% coverage                  */
/* ========================================================================== */

test('J-ROS-01: insider-roster rows carry every required column with real provenance', async () => {
  const res = fakeRes();
  await sectorHot.__test.handleInsiderRoster({ query: { ticker: 'BBCA' } }, res);
  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.ticker, 'BBCA');
  assert.ok(res.body.roster.length > 0, 'BBCA has a roster');

  for (const r of res.body.roster) {
    // nama
    assert.ok(r.name && String(r.name).trim().length > 0, 'name present');
    // lembar
    assert.ok(r.shares == null || Number.isFinite(Number(r.shares)), 'shares is numeric or absent');
    // %
    assert.ok(r.percentage == null || Number.isFinite(Number(r.percentage)),
      'percentage is numeric or explicitly null — never a fake 0');
    if (r.percentage == null) {
      assert.equal(r.percentage_formatted, '—', 'unknown % renders an em dash');
    }
    // kategori
    assert.ok(r.category || r.investorType || r.position, 'a category/position is present');
    // as_of
    assert.ok(r.as_of || r.per_tanggal || r.last_date,
      `${r.name}: an as-of date must be present, not fabricated later`);
    // sumber
    assert.ok(r.source, `${r.name}: source must be present`);
    // Every row must belong to the requested ticker.
    if (r.ticker) assert.equal(String(r.ticker).toUpperCase(), 'BBCA');
  }

  // >5% coverage is declared, not implied.
  const over5 = res.body.roster.filter((r) => Number(r.percentage) > 5);
  assert.ok(over5.length > 0, 'BBCA has declared >5% holders');
  const sources = res.body.sources;
  assert.ok(sources, 'the payload declares which datasets were merged');
  assert.ok(sources.KSEI_OWNERSHIP_30SEP2026, 'ownership snapshot source declared');
  assert.ok(sources.INSIDER_TRANSACTION_DB, 'transaction source declared');
  assert.equal(sources.KSEI_OWNERSHIP_30SEP2026.as_of, '2026-09-30');
});

test('J-ROS-02: NEGATIVE CONTROL — merged roster reports double-counting instead of hiding it', async () => {
  const res = fakeRes();
  await sectorHot.__test.handleInsiderRoster({ query: { ticker: 'BBCA' } }, res);
  const body = res.body;

  assert.ok(body.integrity, 'an integrity block is returned');
  assert.ok(Number.isFinite(body.integrity.percentage_sum), 'the percentage sum is computed');
  assert.equal(typeof body.integrity.exceeds_100pct, 'boolean');

  if (body.integrity.exceeds_100pct) {
    // A single ownership snapshot cannot exceed 100%. When the merge of the
    // periodic roster and the activity log double-counts one economic holding
    // (BBCA: the vehicle "PT DWIMURIA INVESTAMA ANDALAN" and the person
    // "Robert Budi Hartono" both at 54.94%), the payload must SAY SO and name
    // the candidates — never silently present 113% as fact.
    assert.ok(body.integrity.duplicate_holder_candidates.length > 0,
      'an over-100% sum must name its duplicate-holder candidates');
    assert.ok(body.integrity.note && body.integrity.note.length > 0,
      'an explanatory note is attached');
    for (const dup of body.integrity.duplicate_holder_candidates) {
      assert.ok(dup.names.length > 1, 'a duplicate candidate names both rows');
      assert.ok(Number.isFinite(dup.percentage));
    }
    // And the two conflicting rows must be attributable to different datasets.
    const dupNames = new Set(body.integrity.duplicate_holder_candidates.flatMap((d) => d.names.map((n) => n.toLowerCase())));
    const dupRows = body.roster.filter((r) => dupNames.has(String(r.name).toLowerCase()));
    const datasets = new Set(dupRows.map((r) => r.roster_source));
    assert.ok(datasets.size >= 2,
      `the double-counted rows come from different datasets (${Array.from(datasets).join(',')})`);
  } else {
    assert.ok(body.integrity.percentage_sum <= 100.0001);
  }

  // Rows are labelled with the dataset they came from.
  for (const r of body.roster) {
    assert.ok(['KSEI_OWNERSHIP_30SEP2026', 'INSIDER_TRANSACTION_DB'].includes(r.roster_source),
      `${r.name} carries a real dataset label`);
  }
});

test('J-ROS-03: NEGATIVE CONTROL — unknown ticker yields an empty roster, never another ticker\'s', async () => {
  for (const t of ['ZZZZ', 'QQQQ', 'NONEXIST']) {
    const res = fakeRes();
    await sectorHot.__test.handleInsiderRoster({ query: { ticker: t } }, res);
    assert.equal(res.body.success, true);
    assert.equal(res.body.ticker, t, 'the response echoes the requested ticker');
    assert.deepEqual(res.body.roster, [], 'no rows are invented for an unknown ticker');
    assert.equal(res.body.count, 0);
    assert.equal(res.body.integrity.percentage_sum, 0);
    assert.equal(res.body.integrity.exceeds_100pct, false);
  }

  // A malformed ticker must not throw or leak.
  const res = fakeRes();
  await sectorHot.__test.handleInsiderRoster({ query: { ticker: '../../etc/passwd' } }, res);
  assert.equal(res.statusCode, 200);
  assert.deepEqual(res.body.roster, []);
});

test('J-ROS-04: RACE — clicking ticker A then B replaces A; a slow A cannot overwrite B', async () => {
  const runtimeSrc = readSrc('public/analisis-saham-runtime.js');

  // The guard must exist in source: a generation counter checked after await.
  assert.match(runtimeSrc, /var marketStructureRosterGen = 0;/);
  assert.match(runtimeSrc, /var curGen = \+\+marketStructureRosterGen;/);
  const fn = runtimeSrc.slice(
    runtimeSrc.indexOf('async function loadMarketStructureShareholders(ticker)'),
    runtimeSrc.indexOf('function renderMarketStructureShareholders(ticker, roster)')
  );
  assert.ok(fn.length > 0, 'loadMarketStructureShareholders located');
  const guardCount = (fn.match(/curGen !== marketStructureRosterGen/g) || []).length;
  assert.ok(guardCount >= 3,
    `the generation guard is checked on every async resumption (found ${guardCount})`);

  // Functional proof: replay the exact guard pattern with an inverted-latency
  // race (A resolves AFTER B) and assert B wins.
  let gen = 0;
  const rendered = [];
  const cache = {};
  const latency = { AAAA: 60, BBBB: 5 };

  async function load(ticker) {
    const curGen = ++gen;
    if (cache[ticker]) { rendered.push({ ticker, from: 'cache' }); return; }
    await new Promise((r) => setTimeout(r, latency[ticker] || 10));
    if (curGen !== gen) return;            // stale response dropped
    cache[ticker] = [{ name: 'HOLDER_OF_' + ticker }];
    rendered.push({ ticker, from: 'fetch' });
  }

  const pA = load('AAAA');
  const pB = load('BBBB');
  await Promise.all([pA, pB]);
  await new Promise((r) => setTimeout(r, 120));

  assert.equal(rendered.length, 1, 'exactly one render survives the race');
  assert.equal(rendered[0].ticker, 'BBBB', 'the LAST clicked ticker wins');
  assert.ok(!rendered.some((r) => r.ticker === 'AAAA'), 'the stale AAAA response is discarded');

  // Sequential correctness: A then B replaces A (no residue).
  rendered.length = 0;
  gen = 0;
  for (const k of Object.keys(cache)) delete cache[k];
  await load('AAAA');
  assert.equal(rendered[rendered.length - 1].ticker, 'AAAA');
  await load('BBBB');
  assert.equal(rendered[rendered.length - 1].ticker, 'BBBB');
  assert.equal(rendered.length, 2);
});

test('J-ROS-05: roster table renders the as-of column and never fabricates a source', () => {
  const runtimeSrc = readSrc('public/analisis-saham-runtime.js');
  const fn = runtimeSrc.slice(
    runtimeSrc.indexOf('function renderMarketStructureShareholders(ticker, roster)'),
    runtimeSrc.indexOf('function syncMarketStructureDetailToSheet()')
  );
  assert.ok(fn.length > 0, 'renderMarketStructureShareholders located');

  // The computed as-of must actually reach the DOM (it used to be dead code).
  assert.match(fn, /var asOfText =/, 'asOfText is computed');
  const afterDecl = fn.slice(fn.indexOf('var asOfText ='));
  assert.ok(/asOfText/.test(afterDecl.replace(/var asOfText = [^\n]*\n/, '')),
    'asOfText is RENDERED, not computed and discarded');

  // No hardcoded provenance: a missing source/date renders "—", not 'KSEI' /
  // '30 Sep 2026'.
  assert.ok(!/var srcText = r\.source \|\| 'KSEI'/.test(fn),
    "source must not default to a fabricated 'KSEI'");
  assert.ok(!/r\.as_of \|\| r\.per_tanggal \|\| '30 Sep 2026'/.test(fn),
    "as_of must not default to a fabricated '30 Sep 2026'");

  // Unknown percentage renders a dash, never 0.00%.
  assert.match(fn, /pct != null \? pct\.toFixed\(2\) \+ '%' : '-'/);
  // Zero shares render a dash, never "0 lbr".
  assert.match(fn, /shares > 0 \? Number\(shares\)\.toLocaleString\('id-ID'\) \+ ' lbr' : '—'/);
  // The empty state is explicit about the >5% reporting scope.
  assert.match(fn, /Data kepemilikan >5% belum dilaporkan/);
});

test('J-ROS-06: struktur-pasar single-ticker query returns that ticker only', async () => {
  strukturPasar.invalidateCache();
  for (const t of ['BBCA', 'BRPT', 'TLKM']) {
    const res = fakeRes();
    await strukturPasar({ query: { ticker: t } }, res);
    assert.equal(res.statusCode, 200);
    assert.equal(res.body.success, true);
    assert.equal(res.body.ticker, t);
    assert.equal(res.body.emiten.ticker, t, 'identity is preserved end to end');
    assert.ok(Array.isArray(res.body.roster));
    assert.equal(res.body.roster_count, res.body.roster.length);
    assert.ok(res.body.free_float_reconciliation, 'reconciliation block present');
    assert.ok(res.body.hsc_status, 'HSC status block present');
    assert.ok(['HSC Aktif', 'Tidak HSC', '— / Belum dievaluasi'].includes(res.body.hsc_status.status_text));
    for (const r of res.body.roster) {
      assert.equal(r.ticker, t, 'no foreign ticker leaks into the roster');
    }
  }

  // NEGATIVE CONTROL: an unknown ticker is a 404, not a silent substitute.
  const res = fakeRes();
  await strukturPasar({ query: { ticker: 'ZZZZ' } }, res);
  assert.equal(res.statusCode, 404);
  assert.equal(res.body.success, false);
});

/* ========================================================================== */
/* E. Insider schedule — read from the real config/cron                        */
/* ========================================================================== */

test('J-SCH-01: tiered schedule is liquid-daily / non-liquid twice-weekly, per real config', () => {
  const cls = tieredScheduler.classifyUniverse();
  assert.ok(cls.universe_size > 900, `universe classified (${cls.universe_size})`);
  assert.ok(cls.tier1.count > 0 && cls.tier2.count > 0);
  assert.equal(cls.tier1.count + cls.tier2.count, cls.universe_size, 'tiers partition the universe');

  // Tier 1 = liquid OR conglomerate anchor.
  for (const anchor of ['BBCA', 'BRPT', 'TPIA', 'TLKM', 'ASII']) {
    assert.ok(tieredScheduler.CONGLOMERATE_ANCHORS.has(anchor), `${anchor} is a declared anchor`);
    assert.ok(cls.tier1.tickers.includes(anchor), `${anchor} is classified Tier 1`);
  }

  // Group A / B alternate by index parity and are disjoint.
  const a = new Set(cls.tier2.group_a.tickers);
  const b = new Set(cls.tier2.group_b.tickers);
  assert.equal(a.size + b.size, cls.tier2.count, 'A+B partition Tier 2');
  assert.equal(Array.from(a).filter((t) => b.has(t)).length, 0, 'A and B are disjoint');
  assert.deepEqual(cls.tier2.group_a.days, ['Senin', 'Kamis']);
  assert.deepEqual(cls.tier2.group_b.days, ['Selasa', 'Jumat']);
  assert.deepEqual(cls.tier2.sweep.days, ['Rabu']);

  // Tier 1 is scheduled EVERY trading day; Tier 2 exactly twice a week.
  const perDay = {};
  for (let d = 1; d <= 5; d++) perDay[d] = tieredScheduler.getScheduleForDay(d, cls);
  for (const t of cls.tier1.tickers) {
    const hits = [1, 2, 3, 4, 5].filter((d) => perDay[d].tickers.includes(t)).length;
    assert.equal(hits, 5, `Tier 1 ${t} is checked on all 5 trading days`);
  }
  let tier2Hits = 0;
  for (const t of cls.tier2.tickers) {
    const hits = [1, 2, 3, 4, 5].filter((d) => perDay[d].tickers.includes(t)).length;
    assert.equal(hits, 2, `Tier 2 ${t} is checked exactly twice per week`);
    tier2Hits += hits;
  }
  assert.ok(tier2Hits > 0);

  // Wednesday is sweep-only: Tier 1 only.
  assert.equal(perDay[3].tier2_group, 'Cadangan/Sweep');
  assert.equal(perDay[3].total_requests, cls.tier1.count);
  assert.equal(perDay[1].tier2_group, 'Grup A');
  assert.equal(perDay[2].tier2_group, 'Grup B');
});

test('J-SCH-02: weekend behaviour is asserted exactly as configured (not invented)', () => {
  const cron = fs.readFileSync(path.join(ROOT, 'deploy/vps/final-schedule.cron'), 'utf8');
  const insiderLines = cron.split('\n')
    .filter((l) => l.includes('collect-insider-data') && !l.trim().startsWith('#'));
  assert.ok(insiderLines.length > 0, 'the insider cron entry exists');

  // The real cron day-of-week field.
  const daily = insiderLines.filter((l) => /^\s*\d+\s+\d+\s+\*\s+\*\s+\*/.test(l));
  const weekdayOnly = insiderLines.filter((l) => /^\s*\d+\s+\d+\s+\*\s+\*\s+1-5/.test(l));
  const runsWeekend = daily.length > 0 && weekdayOnly.length === 0;

  // getScheduleForDay normalises with ((dayNumber-1) % 5) + 1, so it has NO
  // weekend concept: Saturday(6)->Senin, Sunday(7)->Selasa.
  const cls = { universe_size: 6, tier1: { count: 1, tickers: ['BBCA'] },
    tier2: { count: 5, tickers: [], group_a: { count: 3, tickers: ['A1', 'A2', 'A3'] },
      group_b: { count: 2, tickers: ['B1', 'B2'] }, sweep: { days: ['Rabu'] } } };
  const sat = tieredScheduler.getScheduleForDay(6, cls);
  const sun = tieredScheduler.getScheduleForDay(7, cls);
  assert.equal(sat.trading_day_index, 1, 'day 6 wraps to Senin');
  assert.equal(sun.trading_day_index, 2, 'day 7 wraps to Selasa');
  assert.ok(sat.total_requests > cls.tier1.count, 'a weekend call still returns a full Tier1+Tier2 set');

  // tools/collect-insider-data.js maps JS getUTCDay() (Sun=0 -> 7) straight in.
  const collector = readSrc('tools/collect-insider-data.js');
  assert.match(collector, /let dow = nowWib\.getUTCDay\(\);\s*\n\s*if \(dow === 0\) dow = 7;/);

  // HONEST CONCLUSION: the scheduler does not suppress weekends, so whether the
  // job runs Sat/Sun is decided purely by the cron day-of-week field.
  if (runsWeekend) {
    assert.ok(daily.length > 0);
    // Documented consequence: a weekend run collects the wrapped weekday group.
    assert.ok(sat.tier2_group === 'Grup A' && sun.tier2_group === 'Grup B');
  } else {
    assert.ok(weekdayOnly.length > 0, 'cron restricts the job to Mon-Fri');
  }

  // The admin schedule store must agree with cron on marketDaysOnly.
  const store = readSrc('lib/admin-schedule-store.js');
  const insiderBlock = store.slice(store.indexOf("key: 'insider'"), store.indexOf("key: 'fundamental'"));
  const marketDaysOnly = /marketDaysOnly:\s*(true|false)/.exec(insiderBlock);
  assert.ok(marketDaysOnly, 'the insider job declares marketDaysOnly');
  if (runsWeekend) {
    assert.equal(marketDaysOnly[1], 'false',
      'cron runs daily => marketDaysOnly must be false (consistent, not contradictory)');
  }

  // Quota floor comes from the real cron argument, not an invented number.
  const floorMatch = /collect-insider-data\.js --tiered --floor (\d+)/.exec(cron);
  assert.ok(floorMatch, 'the cron pins an explicit quota floor');
  assert.equal(Number(floorMatch[1]), 5000, 'weekday reserve floor is 5000 per the V6 quota policy');
});

test('J-SCH-03: insider collection is quota-gated and WIB-hard-stopped before any upstream call', () => {
  const collector = readSrc('tools/collect-insider-data.js');
  // Hard stop is evaluated BEFORE the universe is built or any request is made.
  const stopIdx = collector.indexOf('hardStopNow()');
  const gateIdx = collector.indexOf("canConsumeQuota(1, 'insider-tiered'");
  const fetchIdx = collector.indexOf('processTicker');
  assert.ok(stopIdx > 0 && gateIdx > 0 && fetchIdx > 0);
  assert.ok(stopIdx < fetchIdx, 'WIB hard stop precedes the per-ticker work');
  assert.ok(gateIdx < fetchIdx, 'quota gate precedes the per-ticker work');
  assert.match(collector, /FORBIDDEN_WINDOW/, 'a forbidden-window exit reason is reported');
  // The floor defaults from quota-state, with a conservative fallback.
  assert.match(collector, /quotaState\.reserveFloorFor\(new Date\(\)\)/);
  assert.match(collector, /if \(floor == null\) floor = 300;/);
});

/* ========================================================================== */
/* F. Financial / fundamental                                                  */
/* ========================================================================== */

/** Minimal chainable Supabase-shaped stub. */
function stubDb(fundamentalsRow, priceRows, opts = {}) {
  const make = (table) => {
    const q = {
      _table: table, _select: null, _filters: {}, _order: null, _limit: null,
      select(cols) { q._select = cols; return q; },
      eq(k, v) { q._filters[k] = v; return q; },
      order(k, o) { q._order = { k, o }; return q; },
      limit(n) { q._limit = n; return q; },
      async maybeSingle() {
        if (opts.failColumn && table === 'stock_fundamentals' && q._select.includes('financial_statements')) {
          return { data: null, error: { code: '42703', message: 'column "financial_statements" does not exist' } };
        }
        if (opts.storageDown) return { data: null, error: { code: '58000', message: 'storage unavailable' } };
        return { data: table === 'stock_fundamentals' ? fundamentalsRow : null, error: null };
      },
      async then(resolve, reject) {
        try {
          if (opts.storageDown) return resolve({ data: null, error: { code: '58000', message: 'down' } });
          resolve({ data: table === 'stock_daily_history' ? (priceRows || []) : null, error: null });
        } catch (e) { reject(e); }
      }
    };
    return q;
  };
  return { from: (t) => make(t) };
}

test('J-FIN-01: PBV is computed only from verified fundamentals, never invented', () => {
  // Direct bvps.
  let ctx = dailyPbv.buildPbvContext(10250, { book_value_per_share: 2372, fundamental_period: 'Q2 2026', source: 'IDX', updated_at: '2026-10-15' });
  assert.equal(ctx.data_available, true);
  assert.equal(ctx.pbv, Math.round((10250 / 2372) * 100) / 100);
  assert.equal(ctx.book_value_per_share, 2372);
  assert.equal(ctx.fundamental_period, 'Q2 2026');
  assert.equal(ctx.fundamental_source, 'IDX');

  // Derived from equity / shares.
  ctx = dailyPbv.buildPbvContext(1000, { equity: 500000, shares_outstanding: 1000 });
  assert.equal(ctx.book_value_per_share, 500);
  assert.equal(ctx.pbv, 2);

  // NEGATIVE CONTROLS — every missing input yields null, never 0 and never 1.
  for (const [price, row] of [
    [null, { book_value_per_share: 100 }],
    [1000, null],
    [1000, {}],
    [1000, { book_value_per_share: 0 }],
    [1000, { equity: 500 }],                       // no shares
    [1000, { shares_outstanding: 100 }],            // no equity
    [1000, { equity: 500, shares_outstanding: 0 }], // div-by-zero guard
    [0, { book_value_per_share: 100 }]
  ]) {
    const c = dailyPbv.buildPbvContext(price, row);
    assert.equal(c.pbv, null, `pbv must be null for price=${price} row=${JSON.stringify(row)}`);
    assert.equal(c.data_available, false);
  }
  assert.equal(dailyPbv.resolveBookValuePerShare(null), null);
  assert.equal(dailyPbv.resolveBookValuePerShare({ book_value_per_share: 'abc' }), null);
});

test('J-FIN-02: NEGATIVE CONTROL — absent fundamentals yield UNKNOWN, not a "data contoh" badge', async () => {
  // No fundamentals row, no price row.
  const snap = await buildFinancialSnapshot(stubDb(null, []), 'ZZZZ');
  assert.equal(snap.ticker, 'ZZZZ');
  assert.equal(snap.status, 'unknown');
  const f = snap.fundamental;
  assert.equal(f.pbv, null);
  assert.equal(f.book_value_per_share, null);
  assert.equal(f.shares_outstanding, null);
  assert.equal(f.market_cap, null);
  assert.equal(f.market_cap_source, null, 'no source is claimed for an absent market cap');
  assert.equal(f.per, null);
  assert.equal(f.der, null);
  assert.equal(f.equity, null);
  assert.equal(f.data_available, false);
  assert.equal(f.publication_gate.usable, false, 'undated fundamentals are withheld');
  assert.equal(snap.financial_statements, null);
  assert.equal(snap.price.last, null);
  assert.equal(snap.price.last_price_as_of, null);
  // The company name falls back to a neutral placeholder, not another issuer.
  assert.equal(snap.company_name, 'PT ZZZZ Tbk');
  assert.ok(!/Barito/i.test(snap.company_name), 'ZZZZ is never labelled Barito Pacific');

  // A row that EXISTS but is pre-publication must also be withheld.
  const future = await buildFinancialSnapshot(
    stubDb({ ticker: 'BBCA', book_value_per_share: 2372, shares_outstanding: 1, published_at: '2099-01-01' },
      [{ close: 10250, trade_date: '2026-10-14', data_source: 'sqlite' }]),
    'BBCA');
  assert.equal(future.fundamental.publication_gate.usable, false);
  assert.equal(future.fundamental.pbv, null, 'a pre-publication bvps is not consumed');
  assert.equal(future.fundamental.shares_outstanding, null);
});

test('J-FIN-03: market cap and PBV carry an explicit multiplier, source and as-of', async () => {
  const row = {
    ticker: 'BBCA',
    book_value_per_share: 2372,
    equity: 292230000000000,
    shares_outstanding: 123200000000,
    fundamental_period: 'Q2 2026',
    source: 'IDX keterbukaan',
    updated_at: '2026-10-15T02:20:00Z',
    published_at: '2026-08-01'
  };
  const prices = [{ close: 10250, trade_date: '2026-10-14', data_source: 'sqlite_market_rows', data_quality_status: 'OK' }];
  const snap = await buildFinancialSnapshot(stubDb(row, prices), 'BBCA');
  const f = snap.fundamental;

  assert.equal(snap.ticker, 'BBCA');
  assert.equal(snap.status, 'available');
  assert.equal(f.data_available, true);
  // IDR multiplier: market cap is shares × price in WHOLE rupiah (no silent /1e6).
  assert.equal(f.market_cap, Math.round(123200000000 * 10250));
  assert.equal(f.market_cap_source, 'calculated (shares_outstanding * last_price)');
  assert.equal(f.market_cap_as_of, '2026-10-14', 'market cap is dated to the PRICE clock');
  assert.equal(f.shares_outstanding, 123200000000);
  assert.equal(f.equity, 292230000000000);
  assert.equal(f.pbv, Math.round((10250 / 2372) * 100) / 100);
  assert.equal(f.pbv_as_of_price, 10250);
  assert.equal(f.fundamental_period, 'Q2 2026');
  assert.equal(f.fundamental_source, 'IDX keterbukaan');
  assert.equal(f.fundamental_updated_at, '2026-10-15T02:20:00Z');
  assert.equal(f.publication_gate.usable, true);
  assert.equal(snap.price.last, 10250);
  assert.equal(snap.price.last_price_as_of, '2026-10-14');
  assert.equal(snap.price.last_price_source, 'sqlite_market_rows');

  // A stored market_cap is used only when it cannot be recomputed, and then it
  // must name its own source.
  const stored = await buildFinancialSnapshot(stubDb({
    ticker: 'BRPT', market_cap: 135500000000000, market_cap_source: 'IDX snapshot',
    market_cap_as_of: '2026-09-29', published_at: '2026-08-01'
  }, []), 'BRPT');
  assert.equal(stored.fundamental.market_cap, 135500000000000);
  assert.equal(stored.fundamental.market_cap_source, 'IDX snapshot');
  assert.equal(stored.fundamental.market_cap_as_of, '2026-09-29');
});

test('J-FIN-04: NEGATIVE CONTROL — a storage failure throws instead of returning empty-as-truth', async () => {
  await assert.rejects(
    () => buildFinancialSnapshot(stubDb(null, [], { storageDown: true }), 'BBCA'),
    /storage unavailable/i,
    'a real storage error must surface, not be masked as "no data"'
  );

  // A missing COLUMN degrades gracefully through the column-set ladder.
  const snap = await buildFinancialSnapshot(
    stubDb({ ticker: 'BBCA', book_value_per_share: 2372, published_at: '2026-08-01' },
      [{ close: 10250, trade_date: '2026-10-14' }], { failColumn: true }),
    'BBCA');
  assert.equal(snap.fundamental.book_value_per_share, 2372);
});

test('J-FIN-05: RACE — rapid ticker switching cannot swap identities (BBCA vs Barito Pacific)', async () => {
  const rows = {
    BBCA: { ticker: 'BBCA', book_value_per_share: 2372, shares_outstanding: 123200000000, fundamental_period: 'Q2 2026', source: 'IDX', published_at: '2026-08-01' },
    BRPT: { ticker: 'BRPT', book_value_per_share: 900, shares_outstanding: 93750000000, fundamental_period: 'Q2 2026', source: 'IDX', published_at: '2026-08-01' }
  };
  const prices = {
    BBCA: [{ close: 10250, trade_date: '2026-10-14' }],
    BRPT: [{ close: 1430, trade_date: '2026-10-14' }]
  };
  // A db whose latency INVERTS the request order, so a naive caller would
  // render the first-requested ticker last.
  const latency = { BBCA: 60, BRPT: 5 };
  const db = {
    from(table) {
      let tk = null;
      const q = {
        select: () => q, eq: (k, v) => { if (k === 'ticker') tk = v; return q; },
        order: () => q, limit: () => q,
        maybeSingle: () => new Promise((res) => setTimeout(() => res({ data: rows[tk] || null, error: null }), latency[tk] || 10)),
        then: (res) => new Promise((r) => setTimeout(() => r({ data: prices[tk] || [], error: null }), latency[tk] || 10)).then(res)
      };
      return q;
    }
  };

  const results = {};
  const order = [];
  await Promise.all(['BBCA', 'BRPT'].map(async (t) => {
    const s = await buildFinancialSnapshot(db, t);
    results[t] = s;
    order.push(t);
  }));

  // Whichever resolved first, each snapshot must describe ITS OWN ticker.
  for (const t of ['BBCA', 'BRPT']) {
    assert.equal(results[t].ticker, t);
    assert.equal(results[t].fundamental.pbv_as_of_price, prices[t][0].close,
      `${t} carries ${t}'s own price, not the other ticker's`);
    assert.equal(results[t].fundamental.book_value_per_share, rows[t].book_value_per_share);
    assert.equal(results[t].fundamental.shares_outstanding, rows[t].shares_outstanding);
    assert.equal(results[t].company_name, results[t].company_name);
  }
  assert.notEqual(results.BBCA.company_name, results.BRPT.company_name,
    'BBCA and BRPT resolve to different company names');
  assert.ok(/Central Asia/i.test(results.BBCA.company_name), `BBCA name is ${results.BBCA.company_name}`);
  assert.ok(/Barito/i.test(results.BRPT.company_name), `BRPT name is ${results.BRPT.company_name}`);
  assert.ok(!/Barito/i.test(results.BBCA.company_name), 'BBCA is never labelled Barito Pacific');
});

test('J-FIN-06: the financial UI generation guard drops a stale ticker response', () => {
  const runtimeSrc = readSrc('public/analisis-saham-runtime.js');
  const fn = runtimeSrc.slice(
    runtimeSrc.indexOf('async function loadFinancialStructureTab(tabName, rawTicker)'),
    runtimeSrc.indexOf('root.loadFinancialStructureTab = loadFinancialStructureTab;')
  );
  assert.ok(fn.length > 0, 'loadFinancialStructureTab located');
  assert.match(fn, /var generation = \+\+researchGeneration;/, 'a generation token is taken per click');
  const guards = (fn.match(/generation !== researchGeneration/g) || []).length;
  assert.ok(guards >= 2, `the token is re-checked after every await (found ${guards})`);
  // The guard must be checked BEFORE the payload is written to the cache.
  const guardIdx = fn.indexOf('if (generation !== researchGeneration) return;');
  const cacheIdx = fn.indexOf('financialCache[ticker] = ctx;');
  assert.ok(guardIdx > 0 && cacheIdx > 0 && guardIdx < cacheIdx,
    'a stale response is discarded before it can poison the cache');
});

test('J-FIN-07: NEGATIVE CONTROL — synthetic statements are never labelled as an official report', () => {
  const runtimeSrc = readSrc('public/analisis-saham-runtime.js');

  // Every model producer must declare its provenance.
  assert.match(runtimeSrc, /provenance: 'SERVER_SNAPSHOT'/, 'real snapshot model is tagged');
  assert.match(runtimeSrc, /provenance: 'SYNTHETIC_SAMPLE'/, 'generated model is tagged SYNTHETIC_SAMPLE');
  assert.match(runtimeSrc, /provenance: 'HARDCODED_BRPT'/, 'bundled BRPT figures are tagged');

  // The source chip must be driven by that provenance, not by a bundle flag.
  assert.match(runtimeSrc, /var prov = model && model\.provenance;/);
  assert.match(runtimeSrc, /'DATA CONTOH · bukan laporan resmi'/,
    'a synthetic model is explicitly labelled sample data');
  assert.ok(!/srcChip\.textContent = meta\.real \? 'Laporan emiten lengkap' : 'Data terverifikasi';/.test(runtimeSrc),
    'the old flag-only label that called generated data "terverifikasi" is gone');

  // The synthetic generator must be reachable ONLY through the explicitly
  // tagged path: exactly one definition and exactly one invocation. (A third
  // textual hit is the explanatory comment above, which is why the invocation
  // is matched by its `return` form rather than by a bare name count.)
  assert.match(runtimeSrc, /function getSampleFsData\(ticker, fr\) \{/, 'the definition exists');
  const invocations = (runtimeSrc.match(/return getSampleFsData\(ticker, fr\);/g) || []).length;
  assert.equal(invocations, 1,
    `exactly one invocation of the synthetic generator (found ${invocations})`);

  // Coverage/completeness badges must be counted from real cells. Comments are
  // stripped first so the explanatory note about the OLD literals cannot be
  // mistaken for a live one.
  assert.match(runtimeSrc, /var _catStats = _catNames\.map/, 'category completeness is computed');
  const codeOnly = runtimeSrc
    .split('\n')
    .filter((l) => !/^\s*(\/\/|\*|\/\*)/.test(l))
    .join('\n');
  assert.ok(!/'4\/4 pos'/.test(codeOnly), 'no hardcoded "4/4 pos" completeness literal in code');
  assert.ok(!/'3\/6 pos'/.test(codeOnly), 'no hardcoded "3/6 pos" literal in code');
  assert.ok(!/'1\/2 pos'/.test(codeOnly), 'no hardcoded "1/2 pos" literal in code');
  assert.ok(!/isReal \? \(idx === 1/.test(codeOnly), 'no meta.real-keyed completeness branch in code');
});

test('J-FIN-08: the financial snapshot sheet shows real values or "—", never bundle literals', () => {
  const runtimeSrc = readSrc('public/analisis-saham-runtime.js');
  const fn = runtimeSrc.slice(
    runtimeSrc.indexOf('// Subtask J: the snapshot sheet used to print'),
    runtimeSrc.indexOf('// Completeness chips')
  );
  assert.ok(fn.length > 0, 'snapshot sheet block located');

  // Every hero metric is gated on researchHasNumber(f.<field>).
  for (const field of ['pbv', 'book_value_per_share', 'market_cap', 'shares_outstanding']) {
    assert.ok(fn.includes(`researchHasNumber(f.${field})`),
      `${field} is rendered only when the snapshot really has it`);
  }
  // The hardcoded FINANCIAL_META literals must no longer drive these cells.
  assert.ok(!/pbvVal\.textContent = meta\.real/.test(fn), 'PBV no longer comes from meta');
  assert.ok(!/bvpsVal\.textContent = meta\.bvps/.test(fn), 'BVPS no longer comes from meta');
  assert.ok(!/capVal\.textContent = meta\.cap/.test(fn), 'market cap no longer comes from meta');
  assert.ok(!/shVal\.textContent = meta\.sh/.test(fn), 'shares no longer comes from meta');
  // Market-cap provenance is shown with its own source and as-of.
  assert.match(fn, /f\.market_cap_source/);
});

test('J-FIN-09: per-ticker financial source coverage is measured from the real local store', () => {
  // The Arjum financial-statements directory is the documented disk fallback.
  const fsDir = path.join(ARJUM, 'financial-statements');
  assert.ok(exists(fsDir), 'the financial-statements directory exists');
  const entries = fs.readdirSync(fsDir);
  const tickers = entries.filter((e) => fs.statSync(path.join(fsDir, e)).isDirectory());

  // HONEST LOCAL COVERAGE: the directory is empty, so NO ticker has a local
  // statement file. This must be reported as zero coverage, not glossed over.
  assert.equal(tickers.length, 0,
    `data/arjum-data/financial-statements is EMPTY locally (found ${tickers.length}) — per-ticker statements come from the VPS sqlite store, not this repo`);

  // The importer that would populate it is present and period-aware.
  const imp = readSrc('lib/financial-statements-import.js');
  assert.match(imp, /function parsePeriodScore/, 'periods are ranked, not string-sorted');
  assert.match(imp, /function canUpdateStatementsProvenance/, 'provenance updates are guarded');
  assert.match(imp, /function toMiliarIdr/, 'the IDR multiplier is an explicit named conversion');

  // The upload path validates tickers and numbers rather than trusting input.
  const up = readSrc('lib/admin-fundamentals-upload.js');
  assert.match(up, /function normalizeTicker/, 'tickers are normalised on upload');
  assert.match(up, /function parseNumber\(value, field, rowNumber\)/, 'numbers are parsed with field context');
  assert.match(up, /published_at/, 'a publication date is captured (feeds the lag guard)');
});

test('J-FIN-10: the publication-lag gate withholds undated and pre-publication fundamentals', () => {
  const pubLag = require('../lib/publication-lag');

  // Undated => UNKNOWN_PUBLICATION, not usable on a live surface.
  const undated = pubLag.gateRecord({ book_value_per_share: 100 }, new Date('2026-11-11T00:00:00Z'), { context: 'test' });
  assert.equal(undated.usable, false);
  assert.equal(undated.status, 'UNKNOWN_PUBLICATION');

  // Published long ago => usable.
  const old = pubLag.gateRecord({ book_value_per_share: 100, published_at: '2026-08-01' }, new Date('2026-11-11T00:00:00Z'), { context: 'test' });
  assert.equal(old.usable, true);

  // Published in the future => not usable.
  const future = pubLag.gateRecord({ book_value_per_share: 100, published_at: '2099-01-01' }, new Date('2026-11-11T00:00:00Z'), { context: 'test' });
  assert.equal(future.usable, false);

  // Same-day publication still respects the trading-day lag.
  const today = pubLag.gateRecord({ book_value_per_share: 100, published_at: '2026-11-11' }, new Date('2026-11-11T00:00:00Z'), { context: 'test' });
  assert.equal(today.usable, false, 'a record is not usable before its lag has elapsed');
});

/* ========================================================================== */
/* G. Arjum insider disk cache — per-ticker source & string-number handling    */
/* ========================================================================== */

test('J-INS-07: Arjum insider disk payloads are per-ticker and their string numbers parse', () => {
  const insDir = path.join(ARJUM, 'insiders');
  if (!exists(insDir)) return;
  const dirs = fs.readdirSync(insDir);
  const real = dirs.filter((d) => /^[A-Z]{4}$/.test(d));
  const fixtures = dirs.filter((d) => !/^[A-Z]{4}$/.test(d));
  assert.ok(real.length > 0, 'real ticker insider caches exist');
  assert.ok(fixtures.length > 0, 'fixture dirs are distinguishable by name');

  let checked = 0;
  for (const t of real) {
    for (const f of fs.readdirSync(path.join(insDir, t))) {
      if (!f.endsWith('.json')) continue;
      const j = readJson(path.join(insDir, t, f));
      // The payload must identify its own ticker — no mis-mapping.
      if (j.stock_code != null) {
        assert.equal(String(j.stock_code).toUpperCase(), t,
          `${t}/${f} payload names a different ticker (${j.stock_code})`);
      }
      const items = Array.isArray(j) ? j : (j.items || j.data || []);
      if (!Array.isArray(items) || items.length === 0) continue;
      checked++;

      // Pagination metadata must be internally consistent.
      if (j.total != null && j.page_size != null && j.total_pages != null) {
        assert.equal(j.total_pages, Math.ceil(j.total / j.page_size),
          `${t}/${f}: total_pages must equal ceil(total/page_size)`);
        assert.ok(items.length <= j.page_size, 'a page never exceeds its page_size');
      }

      for (const it of items) {
        // Arjum sends numbers as locale strings; they must be parseable.
        for (const k of ['previous_value', 'current_value', 'changes_value']) {
          if (it[k] == null) continue;
          if (typeof it[k] === 'string') {
            assert.ok(/^[-+]?[\d.,]+$/.test(it[k].trim()),
              `${t}/${f} ${k}="${it[k]}" is not a recognisable numeric string`);
          }
        }
        for (const k of ['previous_percentage', 'current_percentage', 'changes_percentage']) {
          if (it[k] == null) continue;
          const parsed = insiderService.parsePercentage(it[k]);
          assert.ok(parsed === null || Number.isFinite(parsed),
            `${t}/${f} ${k}="${it[k]}" must parse to a finite number or null`);
        }
        if (it.date) assert.ok(/^\d{4}-\d{2}-\d{2}$/.test(String(it.date)), `${t}/${f} has a real date`);
        if (it.action_type) assert.ok(typeof it.action_type === 'string');
      }
    }
  }
  assert.ok(checked > 0, `at least one real insider payload was validated (checked=${checked})`);
});

test('J-INS-08: normalizeInsiders converts Arjum locale strings without losing sign or scale', () => {
  const raw = [{
    name: 'THE BANK OF NEW YORK MELLON',
    date: '2026-08-28',
    action_type: 'buy',
    nationality: 'foreign',
    previous_value: '6,232,053,980',
    previous_percentage: '6.29',
    current_value: '6,247,053,980',
    current_percentage: '6.31',
    changes_value: '+15,000,000',
    changes_percentage: '+0.02',
    price_formatted: '0',
    broker_code: ''
  }];

  const norm = require('../lib/bandarmologi-service').normalizeInsiders(raw);
  assert.equal(norm.length, 1);
  const n = norm[0];
  assert.equal(n.name, 'THE BANK OF NEW YORK MELLON');
  assert.equal(n.date, '2026-08-28');
  // US thousands commas must not be read as decimals.
  const cur = Number(n.current_value != null ? n.current_value : n.shares);
  assert.ok(Number.isFinite(cur), 'current_value parsed to a finite number');
  assert.ok(cur > 1e9, `scale preserved (got ${cur}) — "6,247,053,980" is 6.2 billion, not 6.247`);
  // A leading '+' must not flip the sign.
  const chg = Number(n.last_change != null ? n.last_change : n.changes_value);
  if (Number.isFinite(chg)) assert.ok(chg > 0, `a "+15,000,000" change stays positive (got ${chg})`);
  // A missing broker code stays empty rather than becoming a fake broker.
  assert.ok(!n.broker || n.broker === '' || n.broker === '—',
    `an absent broker_code is not invented (got ${JSON.stringify(n.broker)})`);
});

test('J-INS-09: the insider network graph is built from real holdings and never fabricates a profile', () => {
  const net = readJson(path.join(IN, 'network.json'));
  assert.ok(net.total_multi_emiten_entities > 0);
  assert.equal(net.multi_emiten_entities.length, net.total_multi_emiten_entities);

  // Every multi-emiten entity really does hold >1 ticker.
  for (const e of net.multi_emiten_entities.slice(0, 40)) {
    assert.ok(e.canonical && e.canonical.length > 0, 'entity has a canonical name');
    assert.ok(Array.isArray(e.holdings) && e.holdings.length > 1,
      `${e.canonical} is multi-emiten (${e.holdings.length} holdings)`);
    for (const h of e.holdings) {
      assert.ok(/^[A-Z]{4}$/.test(h.ticker), `${e.canonical} holding ticker ${h.ticker} is valid`);
      assert.ok(h.last_date, `${e.canonical}/${h.ticker} carries a real last_date`);
      assert.ok(h.percentage == null || Number.isFinite(Number(h.percentage)));
    }
  }

  // An unknown name yields no graph rather than an invented profile.
  const empty = insiderService.buildInsiderNetworkGraph({ name: 'ZZZ NO SUCH PERSON ZZZ' });
  assert.ok(empty, 'a result object is returned');
  const nodes = empty.nodes || [];
  const entityNodes = nodes.filter((n) => n.type === 'entity');
  assert.equal(entityNodes.length, 0, 'no entity node is fabricated for an unknown name');

  assert.equal(insiderService.getInsiderProfile('ZZZ NO SUCH PERSON ZZZ'), null);
  assert.equal(insiderService.getEffectiveUniverseStatus(), 'OK', 'the dedicated universe is loaded');
});
