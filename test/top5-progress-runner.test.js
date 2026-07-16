'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { loadEnvFiles, parseArgs, readState, writeState, readLatestRows, fetchSupabaseRows, shouldSendEvent, isAfterJakartaMarketClose, isActiveProgressRow } = require('../tools/run-top5-progress-monitor');
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
