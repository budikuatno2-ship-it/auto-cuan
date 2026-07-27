'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const p = require('../lib/second-chance-admin-pilot');

const fixture = path.join(__dirname, 'fixtures', 'second-chance', '2026-07-27', 'candidates.jsonl');
function o(time, override) { return { ticker: 'TEST', scheduled_time: time, current_price: 100, score: 23, relative_volume: 1.5, volume: time === '09:30' ? 200 : (time === '09:45' ? 300 : 100), entry_low: 100, entry_high: 106, tp1: 106, tp2: 110, sl: 94, data_quality_status: 'CORPORATE_ACTION_RISK', freshness: { is_stale: false }, ...override }; }
function series(overrides) { return [o('09:15', { score: 10, relative_volume: 1, volume: 100, ...overrides?.[0] }), o('09:30', overrides?.[1]), o('09:45', overrides?.[2])]; }
function definiteApiFailure() { return { sent: false, reason: 'api_error', chunks_sent: 0 }; }
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

test('strict finite-number validation rejects every coercive/malformed numeric type', () => {
  const invalid = ['23', ' ', true, false, [], [23], {}, NaN, Infinity, -Infinity, '0x17', '', null, undefined];
  for (const value of invalid) {
    assert.equal(p.number(value), null, `${typeof value}:${String(value)}`);
    const first = o('09:15', { score: 10, relative_volume: 1, volume: 100 });
    const previous = o('09:30', { volume: 200 });
    assert.ok(p.qualifyObservation(o('09:45', { volume: 300, score: value }), first, previous).reasons.includes('invalid_score'));
  }
  assert.equal(p.number(23), 23);
  assert.equal(p.number(0), 0);
});

test('calendar validation rejects impossible dates and accepts leap-year boundaries', () => {
  for (const date of ['2026-02-31', '2026-04-31', '2026-13-01', '2026-00-10', '2026-2-01', '', null, 20260727, 'not-a-date', '1900-02-29']) assert.equal(p.validDate(date), false, String(date));
  for (const date of ['2026-02-28', '2024-02-29', '2000-02-29', '2026-07-27']) assert.equal(p.validDate(date), true, date);
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
  assert.equal((await p.runPilot({ ...current, sendTelegram: async () => definiteApiFailure() })).status, 'failed'); assert.equal((await p.readState(path.join(stateDir, '2026-07-27.json'))).status, 'send_failed_retryable');
  let calls = 0; const sendTelegram = async () => { calls++; await new Promise(r => setTimeout(r, 30)); return { sent: true }; };
  const results = await Promise.all([p.runPilot({ ...current, sendTelegram }), p.runPilot({ ...current, sendTelegram })]); assert.equal(results.filter(x => x.status === 'sent').length, 1); assert.ok(results.some(x => ['lock_busy', 'already_sent'].includes(x.status))); assert.equal(calls, 1);
  assert.equal((await p.runPilot({ ...current, sendTelegram })).status, 'already_sent'); assert.equal(calls, 1);
});

test('retryable send retries only the same identity and persisted payload', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'second-chance-retry-same-')); let calls = 0, deliveredText = '';
  const env = { SECOND_CHANCE_ADMIN_PILOT_ENABLED: 'true', TELEGRAM_ENABLED: '1', TELEGRAM_BOT_TOKEN: 'test', TELEGRAM_VERIFY_ADMIN_CHAT_ID: '123456' };
  const options = { sourceFile: fixture, sampleDate: '2026-07-27', throughTime: '10:00', mode: 'send', now: new Date('2026-07-27T05:00:00Z'), env, stateDir };
  assert.equal((await p.runPilot({ ...options, sendTelegram: async () => definiteApiFailure() })).status, 'failed');
  const stateFile = path.join(stateDir, '2026-07-27.json'); const persisted = await p.readState(stateFile); persisted.selected.current_price = 174; await p.writeState(stateFile, persisted);
  const retried = await p.runPilot({ ...options, sendTelegram: async text => { calls++; deliveredText = text; return { sent: true }; } });
  assert.equal(retried.status, 'sent'); assert.equal(calls, 1); assert.match(deliveredText, /Current price: 174/); assert.equal(retried.selection_details.current_price, 174);
});

test('retry identity mismatch and shadow overwrite both fail closed', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'second-chance-retry-mismatch-')); let calls = 0;
  const env = { SECOND_CHANCE_ADMIN_PILOT_ENABLED: 'true', TELEGRAM_ENABLED: '1', TELEGRAM_BOT_TOKEN: 'test', TELEGRAM_VERIFY_ADMIN_CHAT_ID: '123456' };
  const base = { sourceFile: fixture, sampleDate: '2026-07-27', throughTime: '10:00', mode: 'send', now: new Date('2026-07-27T05:00:00Z'), env, stateDir };
  assert.equal((await p.runPilot({ ...base, sendTelegram: async () => definiteApiFailure() })).status, 'failed');
  const stateFile = path.join(stateDir, '2026-07-27.json'); const before = await fs.readFile(stateFile);
  const shadow = await p.runPilot({ ...base, mode: 'shadow', env: {}, sendTelegram: async () => { calls++; return { sent: true }; } });
  assert.equal(shadow.status, 'blocked_retry_requires_send'); assert.deepEqual(await fs.readFile(stateFile), before); assert.equal(calls, 0);
  const records = (await fs.readFile(fixture, 'utf8')).trim().split('\n').map(line => ({ ...JSON.parse(line), ticker: 'ZZZZ' })); const changed = await tempFixture(records);
  const mismatch = await p.runPilot({ ...base, sourceFile: changed.file, sendTelegram: async () => { calls++; return { sent: true }; } });
  assert.equal(mismatch.status, 'blocked_retry_identity_mismatch'); assert.equal(mismatch.telegram_block_reason, 'retry_identity_mismatch'); assert.deepEqual(await fs.readFile(stateFile), before); assert.equal(calls, 0);
  const changedThrough = await p.runPilot({ ...base, throughTime: '09:45', sendTelegram: async () => { calls++; return { sent: true }; } });
  assert.equal(changedThrough.status, 'blocked_retry_identity_mismatch'); assert.deepEqual(await fs.readFile(stateFile), before); assert.equal(calls, 0);
});

test('concurrent same-identity retry invokes Telegram at most once', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'second-chance-retry-concurrent-')); let calls = 0;
  const env = { SECOND_CHANCE_ADMIN_PILOT_ENABLED: 'true', TELEGRAM_ENABLED: '1', TELEGRAM_BOT_TOKEN: 'test', TELEGRAM_VERIFY_ADMIN_CHAT_ID: '123456' };
  const options = { sourceFile: fixture, sampleDate: '2026-07-27', throughTime: '10:00', mode: 'send', now: new Date('2026-07-27T05:00:00Z'), env, stateDir };
  await p.runPilot({ ...options, sendTelegram: async () => definiteApiFailure() });
  const sendTelegram = async () => { calls++; await new Promise(resolve => setTimeout(resolve, 30)); return { sent: true }; };
  const results = await Promise.all([p.runPilot({ ...options, sendTelegram }), p.runPilot({ ...options, sendTelegram })]);
  assert.equal(calls, 1); assert.equal(results.filter(result => result.status === 'sent').length, 1); assert.ok(results.some(result => ['lock_busy', 'already_sent'].includes(result.status)));
});

test('live locks stay, stale dead-owner locks recover, concurrent recovery has one winner', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'second-chance-lock-')); const lock = path.join(dir, 'date.lock'); const old = new Date(0).toISOString();
  await fs.writeFile(lock, JSON.stringify({ pid: process.pid, created_at: old })); assert.equal(await p.acquireLock(lock, { nowMs: Date.now(), staleMs: 1 }), null); assert.ok(await fs.stat(lock));
  await fs.writeFile(lock, JSON.stringify({ pid: 99999999, created_at: old })); const recovered = await p.acquireLock(lock, { nowMs: Date.now(), staleMs: 1 }); assert.equal(typeof recovered, 'function'); await recovered();
  await fs.writeFile(lock, JSON.stringify({ pid: 99999999, created_at: old })); const attempts = await Promise.all([p.acquireLock(lock, { nowMs: Date.now(), staleMs: 1 }), p.acquireLock(lock, { nowMs: Date.now(), staleMs: 1 })]); assert.equal(attempts.filter(Boolean).length, 1); await attempts.find(Boolean)();
});

test('thrown/uncertain Telegram result is durable and blocks automatic resend', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'second-chance-uncertain-')); let calls = 0;
  const env = { SECOND_CHANCE_ADMIN_PILOT_ENABLED: 'true', TELEGRAM_ENABLED: '1', TELEGRAM_BOT_TOKEN: 'test', TELEGRAM_VERIFY_ADMIN_CHAT_ID: '123456' };
  const options = { sourceFile: fixture, sampleDate: '2026-07-27', throughTime: '10:00', mode: 'send', now: new Date('2026-07-27T05:00:00Z'), env, stateDir, sendTelegram: async () => { calls++; throw new Error('connection lost after invocation'); } };
  const first = await p.runPilot(options); assert.equal(first.status, 'blocked_delivery_uncertain'); assert.equal((await p.readState(path.join(stateDir, '2026-07-27.json'))).status, 'delivery_uncertain');
  const second = await p.runPilot(options); assert.equal(second.status, 'blocked_delivery_uncertain'); assert.equal(calls, 1);
});

test('non-explicit Telegram response is uncertain', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'second-chance-response-'));
  const env = { SECOND_CHANCE_ADMIN_PILOT_ENABLED: 'true', TELEGRAM_ENABLED: '1', TELEGRAM_BOT_TOKEN: 'test', TELEGRAM_VERIFY_ADMIN_CHAT_ID: '123456' };
  const options = { sourceFile: fixture, sampleDate: '2026-07-27', throughTime: '10:00', mode: 'send', now: new Date('2026-07-27T05:00:00Z'), env, stateDir };
  assert.equal((await p.runPilot({ ...options, sendTelegram: async () => ({}) })).status, 'blocked_delivery_uncertain');
  assert.equal((await p.readState(path.join(stateDir, '2026-07-27.json'))).status, 'delivery_uncertain');
});

test('Telegram sent:false classification distinguishes definite rejection from uncertain transport', async () => {
  const cases = [
    [{ sent: false, reason: 'telegram_timeout', chunks_sent: 0 }, 'uncertain', 'delivery_uncertain'],
    [{ sent: false, reason: 'fetch_error', chunks_sent: 0 }, 'uncertain', 'delivery_uncertain'],
    [{ sent: false, reason: 'api_error', chunks_sent: 1 }, 'uncertain', 'delivery_uncertain'],
    [{ sent: false, reason: 'api_error', chunks_sent: 0 }, 'retryable', 'send_failed_retryable'],
    [{ sent: false }, 'uncertain', 'delivery_uncertain']
  ];
  const env = { SECOND_CHANCE_ADMIN_PILOT_ENABLED: 'true', TELEGRAM_ENABLED: '1', TELEGRAM_BOT_TOKEN: 'test', TELEGRAM_VERIFY_ADMIN_CHAT_ID: '123456' };
  for (const [adapterResult, classification, stateStatus] of cases) {
    assert.equal(p.classifyTelegramResult(adapterResult), classification);
    const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'second-chance-classify-'));
    const result = await p.runPilot({ sourceFile: fixture, sampleDate: '2026-07-27', throughTime: '10:00', mode: 'send', now: new Date('2026-07-27T05:00:00Z'), env, stateDir, sendTelegram: async () => adapterResult });
    assert.equal(result.status, classification === 'retryable' ? 'failed' : 'blocked_delivery_uncertain');
    assert.equal((await p.readState(path.join(stateDir, '2026-07-27.json'))).status, stateStatus);
  }
  for (const reason of ['telegram_disabled', 'missing_token', 'missing_chat_id', 'empty_message']) assert.equal(p.classifyTelegramResult({ sent: false, reason, chunks_sent: 0 }), 'retryable');
});

test('sent-state persistence failure leaves send_in_progress and blocks resend', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'second-chance-persist-')); let writes = 0, calls = 0;
  const env = { SECOND_CHANCE_ADMIN_PILOT_ENABLED: 'true', TELEGRAM_ENABLED: '1', TELEGRAM_BOT_TOKEN: 'test', TELEGRAM_VERIFY_ADMIN_CHAT_ID: '123456' };
  const writeState = async (file, state) => { writes++; if (writes === 2) throw new Error('disk failure'); return p.writeState(file, state); };
  const options = { sourceFile: fixture, sampleDate: '2026-07-27', throughTime: '10:00', mode: 'send', now: new Date('2026-07-27T05:00:00Z'), env, stateDir, writeState, sendTelegram: async () => { calls++; return { sent: true }; } };
  const first = await p.runPilot(options); assert.equal(first.status, 'blocked_delivery_uncertain'); assert.equal(first.error_code, 'sent_state_persistence_failed'); assert.equal((await p.readState(path.join(stateDir, '2026-07-27.json'))).status, 'send_in_progress');
  const second = await p.runPilot({ ...options, writeState: p.writeState }); assert.equal(second.status, 'blocked_delivery_uncertain'); assert.equal(calls, 1);
});

test('stale-lock recovery cannot bypass durable uncertain delivery state', async () => {
  const stateDir = await fs.mkdtemp(path.join(os.tmpdir(), 'second-chance-stale-state-')); const date = '2026-07-27';
  await p.writeState(path.join(stateDir, `${date}.json`), { status: 'send_in_progress', identity: `${date}|BAJA|10:00|${p.RULE_VERSION}` });
  await fs.writeFile(path.join(stateDir, `${date}.lock`), JSON.stringify({ pid: 99999999, created_at: new Date(0).toISOString() })); let calls = 0;
  const env = { SECOND_CHANCE_ADMIN_PILOT_ENABLED: 'true', TELEGRAM_ENABLED: '1', TELEGRAM_BOT_TOKEN: 'test', TELEGRAM_VERIFY_ADMIN_CHAT_ID: '123456' };
  const result = await p.runPilot({ sourceFile: fixture, sampleDate: date, throughTime: '10:00', mode: 'send', now: new Date('2026-07-27T05:00:00Z'), env, stateDir, lockStaleMs: 1, sendTelegram: async () => { calls++; return { sent: true }; } });
  assert.equal(result.status, 'blocked_delivery_uncertain'); assert.equal(calls, 0);
});

test('explicitly blocked send CLI statuses emit JSON and exit non-zero', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'second-chance-cli-')); const today = p.jakartaDate(); const historical = today === '2026-07-27' ? '2026-07-26' : '2026-07-27';
  for (const date of [today, historical]) { const dir = path.join(root, date); await fs.mkdir(dir, { recursive: true }); await fs.copyFile(fixture, path.join(dir, 'candidates.jsonl')); }
  const cli = path.join(__dirname, '..', 'tools', 'run-second-chance-admin-pilot.js');
  const run = (date, env, extra = ['--send']) => spawnSync(process.execPath, [cli, '--sample-root', root, '--sample-date', date, '--through-time', '10:00', ...extra, '--json'], { encoding: 'utf8', env: { PATH: process.env.PATH, ...env } });
  const cases = [
    [run(today, {}), 'blocked_feature_disabled'],
    [run(today, { SECOND_CHANCE_ADMIN_PILOT_ENABLED: 'true' }), 'blocked_missing_admin'],
    [run(historical, { SECOND_CHANCE_ADMIN_PILOT_ENABLED: 'true', TELEGRAM_VERIFY_ADMIN_CHAT_ID: '123456' }), 'blocked_historical_send'],
    [run(today, { SECOND_CHANCE_ADMIN_PILOT_MODE: 'invalid' }, []), 'blocked_invalid_mode']
  ];
  for (const [child, status] of cases) { assert.notEqual(child.status, 0, status); assert.equal(JSON.parse(child.stdout).status, status); }
});

test('source files remain byte-for-byte unchanged and malformed/duplicates reported', async () => {
  const before = await fs.readFile(fixture); await p.runPilot({ sourceFile: fixture, sampleDate: '2026-07-27', throughTime: '10:00', dryRun: true, env: {} }); assert.deepEqual(await fs.readFile(fixture), before);
  const dup = await tempFixture([o('09:15'), o('09:15')]); await fs.appendFile(dup.file, '{bad\n'); const result = await p.runPilot({ sourceFile: dup.file, sampleDate: '2026-07-27', dryRun: true, env: {} }); assert.equal(result.rejection_summary.duplicate_observation, 1); assert.equal(result.rejection_summary.malformed_json_line, 1);
});

test('message carries required label, fields, explanation, and disclaimers', () => { const text = p.message('2026-07-27', p.evaluateObservations(series()).selected); for (const phrase of ['EKSPERIMENTAL ADMIN ONLY — SECOND CHANCE', 'Ticker:', 'Qualification:', 'Entry zone:', 'TP1:', 'TP2:', 'Stop loss:', 'Score improvement:', 'Relative volume:', 'Risk-reward to TP1:', p.RULE_VERSION, 'Manual validation required', 'Not a public signal', 'Not an automatic order', 'Experimental admin-only pilot']) assert.ok(text.includes(phrase), phrase); });
