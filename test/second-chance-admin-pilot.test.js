'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const p = require('../lib/second-chance-admin-pilot');

const fixture = path.join(__dirname, 'fixtures', 'second-chance', '2026-07-27', 'candidates.jsonl');
function o(time, override) { return { ticker: 'TEST', scheduled_time: time, current_price: 100, score: 23, relative_volume: 1.5, volume: time === '09:30' ? 200 : (time === '09:45' ? 300 : 100), entry_low: 100, entry_high: 106, tp1: 106, tp2: 110, sl: 94, data_quality_status: 'CORPORATE_ACTION_RISK', freshness: { is_stale: false }, ...override }; }
function series(overrides) { return [o('09:15', { score: 10, relative_volume: 1, volume: 100, ...overrides?.[0] }), o('09:30', overrides?.[1]), o('09:45', overrides?.[2])]; }
async function tempFixture(records) { const root = await fs.mkdtemp(path.join(os.tmpdir(), 'second-chance-')); const file = path.join(root, 'candidates.jsonl'); await fs.writeFile(file, records.map(x => JSON.stringify(x)).join('\n') + '\n'); return { root, file }; }

test('BAJA: pending at 09:45 and selected exactly at 10:00', async () => {
  const early = await p.runPilot({ sourceFile: fixture, sampleDate: '2026-07-27', throughTime: '09:45', dryRun: true, env: {} });
  assert.equal(early.status, 'no_qualifying_alert'); assert.equal(early.ticker_details.BAJA.reason, 'only_one_consecutive_qualifying_snapshot');
  const full = await p.runPilot({ sourceFile: fixture, sampleDate: '2026-07-27', throughTime: '10:00', dryRun: true, env: {} });
  assert.equal(full.status, 'selected_dry_run'); assert.deepEqual([full.selected_ticker, full.selected_scheduled_time, full.selection_details.current_price, full.selection_details.score, full.selection_details.relative_volume, full.rule_version], ['BAJA', '10:00', 175, 23, 1.83, 'BALANCED_CONFIRM_2_ANTI_CHASE_V1']);
});

test('dry-run deterministic/no state/no Telegram; shadow idempotent/no Telegram', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'second-chance-state-')); let calls = 0;
  const options = { sourceFile: fixture, sampleDate: '2026-07-27', throughTime: '10:00', stateDir, env: {}, sendTelegram: async () => { calls++; return { sent: true }; } };
  const a = await p.runPilot({ ...options, dryRun: true }); const b = await p.runPilot({ ...options, dryRun: true }); assert.deepEqual(a, b); assert.deepEqual(await fs.readdir(stateDir), []); assert.equal(calls, 0);
  assert.equal((await p.runPilot(options)).status, 'selected_shadow_recorded'); assert.equal((await p.runPilot(options)).status, 'already_recorded'); assert.equal(calls, 0); assert.equal((await fs.readdir(stateDir)).filter(x => x.endsWith('.json')).length, 1);
});

test('single-observation qualification boundaries and rejection cases', () => {
  const first = o('09:15', { score: 10, relative_volume: 1, volume: 100 }); const previous = o('09:30', { volume: 200 });
  const pass = override => p.qualifyObservation(o('09:45', { volume: 300, ...override }), first, previous);
  assert.equal(pass({ relative_volume: 1.5 }).qualifies, true);
  assert.equal(pass({ current_price: 100, entry_low: 100 }).qualifies, true);
  assert.equal(pass({ current_price: 106, entry_high: 106, tp1: 112, tp2: 118, sl: 100 }).qualifies, true);
  assert.equal(pass({ tp1: 106, sl: 94 }).metrics.rr_to_tp1, 1);
  assert.equal(pass({ scheduled_time: '13:45' }).qualifies, true);
  const cases = [
    [{ score: 22 }, 'score_below_23'], [{ score: 19 }, 'score_improvement_below_10'], [{ relative_volume: 1.49 }, 'relative_volume_below_1_50'],
    [{ volume: 200 }, 'volume_not_growing'], [{ current_price: 99 }, 'price_falling'], [{ current_price: 99, entry_low: 100 }, 'below_entry_zone'],
    [{ current_price: 107 }, 'above_entry_zone'], [{ freshness: { is_stale: true } }, 'stale'], [{ sl: 100 }, 'stop_not_below_price'],
    [{ tp1: 100 }, 'tp1_not_above_price'], [{ tp2: 106 }, 'tp2_not_above_tp1'], [{ tp1: 105, sl: 94 }, 'rr_to_tp1_below_1'],
    [{ score: NaN }, 'invalid_score'], [{ volume: Infinity }, 'invalid_volume'], [{ current_price: 'bad' }, 'invalid_current_price'], [{ scheduled_time: '14:00' }, 'after_cutoff']
  ];
  for (const [override, reason] of cases) assert.ok(pass(override).reasons.includes(reason), reason);
});

test('confirmation requires two adjacent complete observations, never partial/non-consecutive', () => {
  assert.equal(p.evaluateObservations(series().slice(0, 2)).selected, null);
  assert.equal(p.evaluateObservations(series({ 1: { relative_volume: 1 }, 2: {} })).selected, null);
  assert.equal(p.evaluateObservations(series({ 1: { score: 22 }, 2: { relative_volume: 1 } })).selected, null);
  assert.equal(p.evaluateObservations(series()).selected.scheduled_time, '09:45');
});

test('anti-chase boundaries, first-price and first-TP1 guards', () => {
  const exactly = series({ 0: { current_price: 100, tp1: 120 }, 1: { current_price: 106, entry_high: 106, tp1: 112, tp2: 118, sl: 100 }, 2: { current_price: 106, entry_high: 106, tp1: 112, tp2: 118, sl: 100 } });
  assert.equal(p.evaluateObservations(exactly).selected.current_price, 106);
  assert.equal(p.evaluateObservations(exactly.map((x, i) => i ? { ...x, current_price: 106.01, entry_high: 107, tp1: 113, tp2: 119, sl: 100 } : x)).selected, null);
  assert.equal(p.evaluateObservations(series({ 0: { current_price: null } })).selected, null);
  assert.equal(p.evaluateObservations(series({ 0: { tp1: null } })).selected, null);
  assert.equal(p.evaluateObservations(series({ 0: { tp1: 100 } })).selected, null);
});

test('daily selection ordering is earliest, score, relative volume, ticker', () => {
  const make = (symbol, time, score, rv) => [o('09:15', { ticker: symbol, score: 10, volume: 100 }), o(time === '09:45' ? '09:30' : '09:45', { ticker: symbol, score, relative_volume: rv, volume: 200 }), o(time, { ticker: symbol, score, relative_volume: rv, volume: 300 })];
  let r = p.evaluateObservations([...make('LATE', '10:00', 99, 9), ...make('EARLY', '09:45', 23, 1.5)]); assert.equal(r.selected.ticker, 'EARLY');
  r = p.evaluateObservations([...make('LOW', '09:45', 23, 5), ...make('HIGH', '09:45', 24, 1.5)]); assert.equal(r.selected.ticker, 'HIGH');
  r = p.evaluateObservations([...make('LOWRV', '09:45', 23, 1.5), ...make('HIGHRV', '09:45', 23, 1.6)]); assert.equal(r.selected.ticker, 'HIGHRV');
  r = p.evaluateObservations([...make('ZZZ', '09:45', 23, 1.5), ...make('AAA', '09:45', 23, 1.5)]); assert.equal(r.selected.ticker, 'AAA');
});

test('modes default safely and sends fail closed', async () => {
  assert.equal(p.DEFAULT_MODE, 'shadow'); assert.equal(p.enabled(undefined), false); const now = new Date('2026-07-27T05:00:00Z');
  const base = { sourceFile: fixture, sampleDate: '2026-07-27', throughTime: '10:00', mode: 'send', now };
  assert.equal((await p.runPilot({ ...base, env: {} })).status, 'blocked_feature_disabled');
  assert.equal((await p.runPilot({ ...base, env: { SECOND_CHANCE_ADMIN_PILOT_ENABLED: 'true' } })).status, 'blocked_missing_admin');
  assert.equal((await p.runPilot({ ...base, sampleDate: '2026-07-26', env: { SECOND_CHANCE_ADMIN_PILOT_ENABLED: 'true' } })).status, 'blocked_historical_send');
  assert.equal((await p.runPilot({ ...base, mode: 'wat' })).status, 'blocked_invalid_mode');
  assert.equal(p.approvedAdmin({ TELEGRAM_VERIFY_ADMIN_CHAT_ID: '123456', TELEGRAM_CHAT_ID: '123456' }), null);
});

test('historical send blocked; failure is not sent; success is concurrent/idempotent', async () => {
  // Reuse the canonical file: date guard is independent of its directory.
  const env = { SECOND_CHANCE_ADMIN_PILOT_ENABLED: 'true', TELEGRAM_ENABLED: '1', TELEGRAM_BOT_TOKEN: 'test', TELEGRAM_VERIFY_ADMIN_CHAT_ID: '123456' };
  assert.equal((await p.runPilot({ sourceFile: fixture, sampleDate: '2026-07-27', throughTime: '10:00', mode: 'send', now: new Date('2026-07-28T05:00:00Z'), env })).status, 'blocked_historical_send');
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'second-chance-send-')); const current = { sourceFile: fixture, sampleDate: '2026-07-27', throughTime: '10:00', mode: 'send', now: new Date('2026-07-27T05:00:00Z'), env, stateDir };
  assert.equal((await p.runPilot({ ...current, sendTelegram: async () => ({ sent: false }) })).status, 'failed'); assert.deepEqual((await fs.readdir(stateDir)).filter(x => x.endsWith('.json')), []);
  let calls = 0; const sendTelegram = async () => { calls++; await new Promise(r => setTimeout(r, 30)); return { sent: true }; };
  const results = await Promise.all([p.runPilot({ ...current, sendTelegram }), p.runPilot({ ...current, sendTelegram })]); assert.equal(results.filter(x => x.status === 'sent').length, 1); assert.ok(results.some(x => ['lock_busy', 'already_sent'].includes(x.status))); assert.equal(calls, 1);
  assert.equal((await p.runPilot({ ...current, sendTelegram })).status, 'already_sent'); assert.equal(calls, 1);
});

test('source files remain byte-for-byte unchanged and malformed/duplicates reported', async () => {
  const before = await fs.readFile(fixture); await p.runPilot({ sourceFile: fixture, sampleDate: '2026-07-27', throughTime: '10:00', dryRun: true, env: {} }); assert.deepEqual(await fs.readFile(fixture), before);
  const dup = await tempFixture([o('09:15'), o('09:15')]); await fs.appendFile(dup.file, '{bad\n'); const result = await p.runPilot({ sourceFile: dup.file, sampleDate: '2026-07-27', dryRun: true, env: {} }); assert.equal(result.rejection_summary.duplicate_observation, 1); assert.equal(result.rejection_summary.malformed_json_line, 1);
});

test('message carries required label, fields, explanation, and disclaimers', () => { const text = p.message('2026-07-27', p.evaluateObservations(series()).selected); for (const phrase of ['EKSPERIMENTAL ADMIN ONLY — SECOND CHANCE', 'Ticker:', 'Qualification:', 'Entry zone:', 'TP1:', 'TP2:', 'Stop loss:', 'Score improvement:', 'Relative volume:', 'Risk-reward to TP1:', p.RULE_VERSION, 'Manual validation required', 'Not a public signal', 'Not an automatic order', 'Experimental admin-only pilot']) assert.ok(text.includes(phrase), phrase); });
