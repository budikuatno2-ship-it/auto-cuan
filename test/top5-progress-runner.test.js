'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { loadEnvFiles, parseArgs, readState, writeState, readLatestRows, fetchSupabaseRows, shouldSendEvent, isAfterJakartaMarketClose, isActiveProgressRow, run } = require('../tools/run-top5-progress-monitor');

function runnerFetch(row, priceDate, calls) {
  return async (url) => {
    calls.push(url);
    if (String(url).includes('api.telegram.org')) return { ok: true, status: 200, json: async () => ({ ok: true }) };
    return { ok: true, json: async () => new URL(url).pathname.endsWith('/telegram_daily_picks') ? [row] : [{ ticker: row.ticker, latest_price: 104, price_date: priceDate }] };
  };
}
test('runner defaults to dry-run and only enables send explicitly', () => {
  assert.equal(parseArgs(['node', 'runner']).dryRun, true);
  assert.equal(parseArgs(['node', 'runner', '--send']).send, true);
});
test('VPS state file persists idempotency event keys without duplicate records', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'top5-progress-'));
  const file = path.join(dir, 'state.json');
  const state = await readState(file);
  state.events['top5_progress:ABCD:2026-07-15:TP1_HIT:tp1'] = { sent_at: '2026-07-16T10:00:00Z' };
  await writeState(file, state);
  const reread = await readState(file);
  assert.equal(Object.keys(reread.events).length, 1);
  await fs.rm(dir, { recursive: true, force: true });
});
test('duplicate, stale, and dry-run events cannot send', () => {
  const event = { event_key: 'top5_progress:ABCD:2026-07-15:TP1_HIT:tp1', actionable: true };
  assert.equal(shouldSendEvent({ send: false }, event, { events: {} }, { stale: false }), false);
  assert.equal(shouldSendEvent({ send: true }, event, { events: { [event.event_key]: {} } }, { stale: false }), false);
  assert.equal(shouldSendEvent({ send: true }, event, { events: {} }, { stale: true }), false);
});
test('old pick-date gain events remain visible in dry-run but are blocked from --send', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'top5-progress-old-pick-'));
  const file = path.join(dir, 'state.json');
  const row = { ticker: 'ABCD', locked_date: '2026-07-16', entry_high: 100, tp1: 110, tp2: 120, sl: 95 };
  const calls = [];
  const options = { send: false, limit: 1 };
  const deps = { env: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'key' }, fetch: runnerFetch(row, '2026-07-17', calls), stateFile: file, now: '2026-07-17T10:00:00Z' };
  const dryRun = await run(options, deps);
  assert.ok(dryRun.events.some((event) => event.event === 'GAIN_3_PCT' && event.sendable === false && event.send_block_reason === 'STALE_PICK_DATE'));
  assert.equal(dryRun.sent_count, 0);
  assert.equal(calls.filter((url) => String(url).includes('api.telegram.org')).length, 0);
  const sendRun = await run({ send: true, limit: 1 }, deps);
  assert.equal(sendRun.sent_count, 0);
  assert.equal((await readState(file)).events && Object.keys((await readState(file)).events).length, 0);
  await fs.rm(dir, { recursive: true, force: true });
});
test('today pick and today price date remain sendable, while an old price date is blocked', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'top5-progress-date-guard-'));
  const row = { ticker: 'ABCD', locked_date: '2026-07-17', entry_high: 100, tp1: 110, tp2: 120, sl: 95 };
  const deps = (priceDate, stateFile) => ({ env: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'key' }, fetch: runnerFetch(row, priceDate, []), stateFile, now: '2026-07-17T10:00:00Z' });
  const today = await run({ send: false, limit: 1 }, deps('2026-07-17', path.join(dir, 'today.json')));
  assert.ok(today.events.some((event) => event.event === 'GAIN_3_PCT' && event.sendable === true && event.send_block_reason === null));
  const stalePrice = await run({ send: true, limit: 1 }, deps('2026-07-16', path.join(dir, 'stale.json')));
  assert.ok(stalePrice.events.some((event) => event.event === 'GAIN_3_PCT' && event.sendable === false && event.send_block_reason === 'PRICE_DATE_NOT_TODAY'));
  assert.equal(stalePrice.sent_count, 0);
  await fs.rm(dir, { recursive: true, force: true });
});
test('only allowlisted active events can send when --send and Telegram are enabled', () => {
  const previous = process.env.TELEGRAM_ENABLED;
  process.env.TELEGRAM_ENABLED = '1';
  try {
    const state = { events: {} };
    ['TP1_HIT', 'TP2_HIT', 'SL_HIT', 'GAIN_3_PCT', 'GAIN_5_PCT', 'GAIN_10_PCT'].forEach((type) => {
      const event = { type, event_key: type, actionable: true };
      assert.equal(shouldSendEvent({ send: true }, event, state, { stale: false }), true);
    });
    ['BELOW_ENTRY', 'SL_NEAR', 'INVALID_PLAN', 'STALE_PRICE', 'MAX_AGE_EXPIRED'].forEach((type) => {
      assert.equal(shouldSendEvent({ send: true }, { type, event_key: type, actionable: true }, state, { stale: false }), false);
    });
  } finally {
    if (previous === undefined) delete process.env.TELEGRAM_ENABLED;
    else process.env.TELEGRAM_ENABLED = previous;
  }
});
test('SL_HIT is sendable once, then its idempotency key blocks repeats', () => {
  const previous = process.env.TELEGRAM_ENABLED;
  process.env.TELEGRAM_ENABLED = '1';
  try {
    const event = { type: 'SL_HIT', event_key: 'top5_progress:ABCD:2026-07-15:SL_HIT:sl', actionable: true };
    assert.equal(shouldSendEvent({ send: true }, event, { events: {} }, { stale: false }), true);
    assert.equal(shouldSendEvent({ send: true }, event, { events: { [event.event_key]: { sent_at: '2026-07-16T10:00:00Z' } } }, { stale: false }), false);
  } finally {
    if (previous === undefined) delete process.env.TELEGRAM_ENABLED;
    else process.env.TELEGRAM_ENABLED = previous;
  }
});
test('expired and already-terminal tracking rows suppress all runner events', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'top5-progress-terminal-'));
  const file = path.join(dir, 'state.json');
  const row = { ticker: 'ABCD', locked_date: '2026-07-01', entry_high: 100, tp1: 105, tp2: 110, sl: 95 };
  const fetchMock = async (url) => ({ ok: true, json: async () => new URL(url).pathname.endsWith('/telegram_daily_picks') ? [row] : [{ ticker: 'ABCD', latest_price: 111, price_date: '2026-07-16T10:00:00Z' }] });
  const expired = await run({ send: false, limit: 1 }, { env: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'key' }, fetch: fetchMock, stateFile: file });
  assert.equal(expired.events.length, 0);
  assert.equal((await readState(file)).tracking['ABCD:2026-07-01'].status, 'MAX_AGE_EXPIRED');
  await writeState(file, { events: {}, tracking: { 'ABCD:2026-07-01': { status: 'STOP_TRACKING' } } });
  const terminal = await run({ send: false, limit: 1 }, { env: { SUPABASE_URL: 'https://example.supabase.co', SUPABASE_SERVICE_ROLE_KEY: 'key' }, fetch: fetchMock, stateFile: file });
  assert.equal(terminal.events.length, 0);
  await fs.rm(dir, { recursive: true, force: true });
});
test('hourly runner only considers routine Swing reporting after Jakarta market close', () => {
  assert.equal(isAfterJakartaMarketClose(new Date('2026-07-16T08:00:00Z')), false);
  assert.equal(isAfterJakartaMarketClose(new Date('2026-07-16T09:15:00Z')), true);
});
test('active locked/final picks are scanned while archived and terminal picks are excluded', () => {
  assert.equal(isActiveProgressRow({ ticker: 'LOCK', is_final: true, status: 'WAITING' }), true);
  assert.equal(isActiveProgressRow({ ticker: 'ARCH', raw_payload: { history_archived_at: '2026-07-16T10:00:00Z' } }), false);
  assert.equal(isActiveProgressRow({ ticker: 'DONE', status: 'COMPLETE' }), false);
  assert.equal(isActiveProgressRow({ ticker: 'SL', status: 'SL_HIT' }), false);
});
test('runner loads local runtime env files without replacing existing environment values', async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), 'top5-progress-env-'));
  await fs.writeFile(path.join(dir, '.env.local'), 'SUPABASE_URL=https://local.supabase.co\nLOCAL_ONLY=1\n');
  await fs.writeFile(path.join(dir, '.env.intraday-runtime'), 'SUPABASE_URL=https://runtime.supabase.co\nRUNTIME_ONLY=1\n');
  await fs.writeFile(path.join(dir, '.env'), 'FALLBACK_ONLY=1\n');
  const env = { SUPABASE_URL: 'https://shell.supabase.co' };
  loadEnvFiles({ cwd: dir, env });
  assert.equal(env.SUPABASE_URL, 'https://shell.supabase.co');
  assert.equal(env.LOCAL_ONLY, '1');
  assert.equal(env.RUNTIME_ONLY, '1');
  assert.equal(env.FALLBACK_ONLY, '1');
  await fs.rm(dir, { recursive: true, force: true });
});
test('runner reads Supabase tables through REST fetch with required auth headers', async () => {
  const calls = [];
  const fetchMock = async (url, options) => {
    calls.push({ url: new URL(url), options });
    return { ok: true, json: async () => [{ ticker: 'ABCD', latest_price: 123 }] };
  };
  const rows = await readLatestRows(fetchMock, 'https://example.supabase.co/', 'service-key', ['ABCD']);
  assert.equal(calls.length, 4);
  assert.equal(calls[0].url.pathname, '/rest/v1/daytrade_screener_latest');
  assert.equal(calls[0].url.searchParams.get('ticker'), 'in.(ABCD)');
  assert.deepEqual(calls[0].options.headers, { apikey: 'service-key', Authorization: 'Bearer service-key' });
  assert.equal(rows.daytrade_screener_latest.ABCD.latest_price, 123);
});
test('runner reports Supabase REST failures without relying on a Supabase client', async () => {
  await assert.rejects(
    fetchSupabaseRows(async () => ({ ok: false, status: 401, text: async () => 'bad key' }), 'https://example.supabase.co', 'bad-key', 'telegram_daily_picks', { select: '*' }),
    /Supabase read failed for telegram_daily_picks: HTTP 401 bad key/
  );
});
