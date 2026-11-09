'use strict';

/**
 * test/v5-phase3/phase3-analytics.test.js
 * ============================================================================
 * V5 Phase 3 unit tests — N10 (publication lag), N11 (pivot confirmation),
 * N20 (strategy registry version gate).
 * Run: node test/v5-phase3/phase3-analytics.test.js
 * Exit 0 = all assertions hold; exit 1 = at least one failure.
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const os = require('os');

let passed = 0;
let failed = 0;
const failures = [];

function assert(cond, label) {
  if (cond) { passed += 1; console.log('  ok  ' + label); }
  else { failed += 1; failures.push(label); console.error('  FAIL ' + label); }
}

function section(name) { console.log('\n== ' + name + ' =='); }

/* -------------------------------------------------------------------------- */
/* N10 — publication lag                                                       */
/* -------------------------------------------------------------------------- */
const pubLag = require('../../lib/publication-lag');

section('N10 lib/publication-lag.isPublished');

{
  // Published 2026-11-02 (Monday) + 1 trading day lag → usable from 2026-11-03.
  const f = { published_at: '2026-11-02T16:00:00+07:00', eps: 100 };
  assert(pubLag.isPublished(f, '2026-11-02') === false, 'same-day consumption rejected');
  assert(pubLag.isPublished(f, '2026-11-03') === true, 'usable on publishDate + 1 trading day');
  assert(pubLag.isPublished(f, '2026-11-10') === true, 'well after lag usable');

  // Weekend skip: published Friday 2026-11-06 → +1 trading day = Monday 2026-11-09.
  const fri = { published_at: '2026-11-06T16:00:00+07:00' };
  assert(pubLag.isPublished(fri, '2026-11-07') === false, 'saturday rejected (fri publish +1td = monday)');
  assert(pubLag.isPublished(fri, '2026-11-08') === false, 'sunday rejected');
  assert(pubLag.isPublished(fri, '2026-11-09') === true, 'monday usable (lag skips weekend)');
}

{
  // Configurable lag.
  const f = { published_at: '2026-11-02T16:00:00+07:00' };
  assert(pubLag.isPublished(f, '2026-11-03', { publicationLagDays: 1 }) === true, 'lag=1: day+1 usable');
  assert(pubLag.isPublished(f, '2026-11-03', { publicationLagDays: 3 }) === false, 'lag=3: day+1 NOT usable');
  assert(pubLag.isPublished(f, '2026-11-05', { publicationLagDays: 3 }) === true, 'lag=3: day+3 usable');
  assert(pubLag.isPublished(f, '2026-11-03', { publicationLagDays: 0 }) === true, 'lag=0: same-day+1 usable');
}

{
  // UNKNOWN_PUBLICATION is not usable on live surfaces.
  const undated = { eps: 100 };
  const d = pubLag.gateRecord(undated, '2026-11-10', { context: 'unit-test' });
  assert(d.usable === false, 'undated record NOT usable');
  assert(d.status === 'UNKNOWN_PUBLICATION', 'undated record status UNKNOWN_PUBLICATION');
  assert(pubLag.isPublished(null, '2026-11-10') === false, 'null record NOT usable');
}

{
  // allowUnverified escape hatch logs and permits.
  const sink = [];
  pubLag.setAllowUnverifiedLogSink((e) => sink.push(e));
  const undated = { eps: 100 };
  const d = pubLag.gateRecord(undated, '2026-11-10', { allowUnverified: true, context: 'escape-hatch-test' });
  assert(d.usable === true, 'allowUnverified=true permits undated record');
  assert(sink.length === 1 && sink[0].context && sink[0].context.surface === 'escape-hatch-test', 'allowUnverified use is logged');
  pubLag.setAllowUnverifiedLogSink(null);
}

{
  // deriveRegulatoryDeadline: Q2 (90d), Q1 (30d), FY (90d).
  const q2 = pubLag.deriveRegulatoryDeadline('Q2', '2026');
  assert(q2.publishedAt && q2.publishedAt.toISOString().slice(0, 10) === '2026-09-28',
    'Q2 2026 deadline = 2026-06-30 + 90d = 2026-09-28 (got ' + (q2.publishedAt && q2.publishedAt.toISOString()) + ')');
  const q1 = pubLag.deriveRegulatoryDeadline('Q1', '2026');
  assert(q1.publishedAt && q1.publishedAt.toISOString().slice(0, 10) === '2026-04-30',
    'Q1 2026 deadline = 2026-03-31 + 30d = 2026-04-30');
  const fy = pubLag.deriveRegulatoryDeadline('FY', '2025');
  assert(fy.publishedAt && fy.publishedAt.toISOString().slice(0, 10) === '2026-03-31',
    'FY 2025 deadline = 2025-12-31 + 90d = 2026-03-31');
}

{
  // Stored fundamentals after backfill all carry published_at.
  const dir = path.join(__dirname, '..', '..', 'data', 'fundamental');
  let items = 0, undated = 0;
  function walk(d) {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      const full = path.join(d, e.name);
      if (e.isDirectory()) walk(full);
      else if (e.name.endsWith('.json')) {
        const doc = JSON.parse(fs.readFileSync(full, 'utf8'));
        for (const item of (doc && doc.data && doc.data.items) || []) {
          items += 1;
          if (!item || !item.published_at) undated += 1;
        }
      }
    }
  }
  if (fs.existsSync(dir)) {
    walk(dir);
    assert(items > 0 && undated === 0, 'all ' + items + ' stored fundamental items carry published_at (undated=' + undated + ')');
  } else {
    console.log('  (skip) data/fundamental absent');
  }
}

/* -------------------------------------------------------------------------- */
/* N11 — harmonic pivot confirmation                                           */
/* -------------------------------------------------------------------------- */
const W = require('../../public/chart-workstation.js');

section('N11 calculateV3F09XABCD pivot confirmation');

function sineSeries(n, phase) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const p = 100 + 20 * Math.sin((i / 4 + (phase || 0)) * Math.PI);
    out.push({
      time: 'd' + String(i).padStart(3, '0'),
      open: p, high: p + 2, low: p - 2, close: p, volume: 100
    });
  }
  return out;
}

{
  // 5-point pattern with D confirmed by >= 2 subsequent bars.
  const s = sineSeries(60);
  const xb = W.calculateV3F09XABCD(s);
  assert(xb.valid === true, 'detector returns valid');
  assert(xb.confirmation === 'CONFIRMED' || xb.confirmation === 'PROVISIONAL',
    'confirmation field present: ' + xb.confirmation);
  if (xb.confirmation === 'CONFIRMED') {
    assert(xb.barsAfterD >= 2, 'CONFIRMED implies barsAfterD >= 2 (got ' + xb.barsAfterD + ')');
    assert(!!xb.confirmedAt, 'CONFIRMED carries confirmedAt: ' + xb.confirmedAt);
  }
}

{
  // D on the LAST bar must never be CONFIRMED.
  // Construct: chop then sharp drop into the final bar (D low at last index).
  const candles = [];
  let p = 100;
  for (let i = 0; i < 30; i++) { p += (i % 2 === 0 ? 3 : -3); candles.push(mk(i, p)); }
  for (let i = 30; i < 36; i++) { p += 6; candles.push(mk(i, p)); } // rise into newest bar (D high at end)
  function mk(i, price) { return { time: 'd' + String(i).padStart(3, '0'), open: price - 1, high: price + 2, low: price - 3, close: price + 1, volume: 100 }; }
  const xb = W.calculateV3F09XABCD(candles);
  assert(Number(xb.d.index) < xb.lastIndex || xb.confirmation === 'PROVISIONAL',
    'D on newest window never CONFIRMED (dIndex=' + xb.d.index + ', lastIndex=' + xb.lastIndex + ', conf=' + xb.confirmation + ')');
}

{
  // Real candle regression: across local daily-candles, no pattern may have
  // D on the newest bar.
  const candlesDir = path.join(__dirname, '..', '..', 'data', 'daily-candles');
  if (fs.existsSync(candlesDir)) {
    const files = fs.readdirSync(candlesDir).filter((f) => f.endsWith('.json')).slice(0, 200);
    let patterns = 0, onLast = 0;
    for (const file of files) {
      let doc;
      try { doc = JSON.parse(fs.readFileSync(path.join(candlesDir, file), 'utf8')); } catch (_) { continue; }
      const candles = Array.isArray(doc) ? doc : (doc.candles || []);
      if (!Array.isArray(candles) || candles.length < 20) continue;
      const raw = candles.slice(-100).map((c) => ({
        time: String(c.date || c.time || '').slice(0, 10),
        open: c.open, high: c.high, low: c.low, close: c.close, volume: c.volume
      }));
      let xb;
      try { xb = W.calculateV3F09XABCD(raw); } catch (_) { continue; }
      if (!xb || xb.valid !== true || !xb.d) continue;
      patterns += 1;
      if (Number(xb.d.index) >= raw.length - 1) onLast += 1;
    }
    assert(patterns > 0 && onLast === 0,
      'real-candle regression: 0/' + patterns + ' patterns place D on the newest bar');
  }
}

{
  // Config variation: confirmBars=1 vs confirmBars=5 change the verdict.
  const s = sineSeries(24);
  const strict = W.calculateV3F09XABCD(s, { confirmBars: 5 });
  const lenient = W.calculateV3F09XABCD(s, { confirmBars: 1 });
  assert(strict.confirmation === 'CONFIRMED' || strict.confirmation === 'PROVISIONAL',
    'config confirmBars=5 accepted: ' + strict.confirmation);
  assert(lenient.confirmation === 'CONFIRMED' || lenient.confirmation === 'PROVISIONAL',
    'config confirmBars=1 accepted: ' + lenient.confirmation);
  if (strict.barsAfterD >= 1 && strict.barsAfterD < 5) {
    assert(strict.confirmation === 'PROVISIONAL' && lenient.confirmation === 'CONFIRMED',
      'config variation changes verdict for barsAfterD=' + strict.barsAfterD);
  }
}

{
  // minConfirmOffset epsilon: with a large offset requirement and no price
  // movement beyond the pivot, a pattern cannot claim CONFIRMED.
  const flat = [];
  for (let i = 0; i < 12; i++) flat.push({ time: 'f' + i, open: 100, high: 100.1, low: 99.9, close: 100, volume: 1 });
  const xb = W.calculateV3F09XABCD(flat, { confirmBars: 1, minConfirmOffset: 999 });
  assert(xb.confirmation === 'PROVISIONAL' || xb.barsAfterD < 1 || xb.empty === true,
    'minConfirmOffset epsilon respected (conf=' + xb.confirmation + ', barsAfterD=' + xb.barsAfterD + ')');
}

/* -------------------------------------------------------------------------- */
/* N20 — strategy registry                                                     */
/* -------------------------------------------------------------------------- */
const reg = require('../../lib/strategy-registry');

section('N20 lib/strategy-registry');

function tmpRegistry() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v5-strreg-'));
  return path.join(dir, 'strategy-registry.json');
}

{
  const rp = tmpRegistry();
  const before = reg.loadRegistry(rp);
  assert(before.status === 'EMPTY' && Object.keys(before.strategies).length === 0,
    'absent registry initializes EMPTY with empty strategies map');

  // Version change without approval → rejected.
  let threw = null;
  try { reg.setProductionStrategy('v7', '2.0', { reason: 'silent swap' }); }
  catch (e) { threw = e; }
  assert(threw && threw.code === 'APPROVAL_REQUIRED', 'setProductionStrategy without approval throws APPROVAL_REQUIRED');

  threw = null;
  try { reg.registerStrategy({ id: 'v7', version: '2.0', metrics: {} }); }
  catch (e) { threw = e; }
  assert(threw && threw.code === 'APPROVAL_REQUIRED', 'registerStrategy without approvedBy throws APPROVAL_REQUIRED');

  assert(reg.getApprovedStrategy('v7', { registryPath: rp }) === null,
    'getApprovedStrategy returns null (never a default) for unregistered id');
}

{
  const rp = tmpRegistry();
  // Register with approval.
  const r1 = reg.registerStrategy({
    id: 'daytrade-v7', version: '1.0.0',
    metrics: { sampleSize: 2179, expectancyR: -0.1, profitFactor: 0.76 },
    approvedBy: 'unit-test', evidence: 'unit'
  }, { registryPath: rp });
  assert(r1.ok === true, 'registerStrategy with approvedBy writes');

  // Promote with explicit approval.
  const p1 = reg.setProductionStrategy('daytrade-v7', '1.0.0', { approved: true, approvedBy: 'unit-test', reason: 'initial', registryPath: rp });
  assert(p1.ok === true, 'setProductionStrategy with approval applies');
  const g1 = reg.getApprovedStrategy('daytrade-v7', { registryPath: rp });
  assert(g1 && g1.version === '1.0.0', 'getApprovedStrategy returns approved version 1.0.0');

  // Register v2 and promote with approval — audit trail must exist.
  reg.registerStrategy({ id: 'daytrade-v7', version: '2.0.0', metrics: { sampleSize: 2200, expectancyR: 0.05, profitFactor: 1.6 }, approvedBy: 'unit-test' }, { registryPath: rp });
  const p2 = reg.setProductionStrategy('daytrade-v7', '2.0.0', { approved: true, approvedBy: 'unit-test', reason: 'better expectancy', registryPath: rp });
  assert(p2.ok === true && p2.previousVersion === '1.0.0', 'version change with approval: 1.0.0 -> 2.0.0');
  const after = reg.loadRegistry(rp);
  const promoteEvents = after.auditLog.filter((e) => e.event === 'SET_PRODUCTION_STRATEGY');
  assert(promoteEvents.length === 2 && promoteEvents[1].previousVersion === '1.0.0' && promoteEvents[1].approvedBy === 'unit-test',
    'promotion appended to audited record with actor + previous/new version');
}

{
  const rp = tmpRegistry();
  // Qualified vs unqualified.
  reg.registerStrategy({ id: 'good', version: '1', metrics: { sampleSize: 500, expectancyR: 0.2, profitFactor: 1.8 }, approvedBy: 't' }, { registryPath: rp });
  const q = reg.getQualifiedStrategy('good', { registryPath: rp });
  assert(q !== reg.NO_QUALIFIED_STRATEGY && q.version === '1', 'qualified strategy returned');

  reg.registerStrategy({ id: 'bad', version: '1', metrics: { sampleSize: 10, expectancyR: -0.3, profitFactor: 0.5 }, approvedBy: 't' }, { registryPath: rp });
  const nq = reg.getQualifiedStrategy('bad', { registryPath: rp });
  assert(nq === reg.NO_QUALIFIED_STRATEGY, 'unqualified strategy -> NO_QUALIFIED_STRATEGY (never a fallback default)');

  const missing = reg.getQualifiedStrategy('ghost', { registryPath: rp });
  assert(missing === reg.NO_QUALIFIED_STRATEGY, 'empty registry -> NO_QUALIFIED_STRATEGY, never a default');

  assert(Number(reg.MIN_RR_RATIO) === Number(require('../../lib/screener-config').MIN_RR_RATIO),
    'MIN_RR_RATIO threshold reused from lib/screener-config.js');
}

{
  // Params file approval envelope: verified when intact, fails after edit.
  const v = reg.verifyParamsApproval();
  assert(v.ok === true, 'config/v3-f03-winning-params.json approval envelope verifies (checksum match)');

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'v5-params-'));
  const tampered = path.join(dir, 'params.json');
  const original = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'config', 'v3-f03-winning-params.json'), 'utf8'));
  // Silent live swap: scoreMin 60 -> 65 without re-approval.
  original.konglo.scoreMin = 65;
  fs.writeFileSync(tampered, JSON.stringify(original, null, 2), 'utf8');
  const v2 = reg.verifyParamsApproval(tampered);
  assert(v2.ok === false && /checksum mismatch/.test(v2.reason), 'tampered params rejected (checksum mismatch)');

  // Re-serializing the approved file verbatim must still verify (whitespace
  // is not a parameter change; canonical payload is content-based).
  const untouched = path.join(dir, 'params-verbatim.json');
  fs.writeFileSync(untouched, JSON.stringify(JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'config', 'v3-f03-winning-params.json'), 'utf8')), null, 2), 'utf8');
  const v3 = reg.verifyParamsApproval(untouched);
  assert(v3.ok === true, 'verbatim re-serialization still verifies (content canonical)');
}

/* -------------------------------------------------------------------------- */
/* Summary                                                                     */
/* -------------------------------------------------------------------------- */
console.log('\n========================================');
console.log('PASSED: ' + passed + '   FAILED: ' + failed);
if (failed > 0) {
  console.log('Failures:');
  for (const f of failures) console.log('  - ' + f);
  process.exit(1);
}
process.exit(0);
