'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const publisher = require('../lib/intraday-fast-watcher-publisher');
const { hybridizeClient } = require('../lib/hybrid-supabase-client');
const { closeVpsMarketStore } = require('../lib/vps-market-store');

test('FastWatcher production client is hybridized for both read and publish', () => {
  const source = fs.readFileSync(require.resolve('../lib/intraday-fast-watcher-publisher'), 'utf8');
  assert.match(source, /hybridizeClient\(createClient\(url, key,/);
  assert.match(source, /\), env\)/);
  assert.match(source, /opts\.storeClient \|\| makeSupabaseClient\(env\)/);
});

test('FastWatcher market read/write routed to SQLite, no remote fallback', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-vps-route-'));
  const dbFile = path.join(root, 'market.sqlite');
  const touched = [];
  const remote = { from(table) {
    touched.push(table);
    return { select: async () => ({ data: [], error: null }) };
  } };
  const env = { AUTO_CUAN_MARKET_DATA_VPS: '1', AUTO_CUAN_MARKET_DB: dbFile };
  const hybrid = hybridizeClient(remote, env);
  try {
    assert.equal(hybrid.__marketDataVpsEnabled, true);
    const upsert = await hybrid.from('daytrade_screener_latest').upsert([{ticker:'TEST',status:'READY_BREAKOUT',daytrade_score:99}],{onConflict:'ticker'}).select('ticker');
    assert.equal(upsert.error, null);
    const got = await hybrid.from('daytrade_screener_latest').select('ticker,status,daytrade_score').eq('ticker','TEST');
    assert.equal(got.data[0].daytrade_score, 99);
    const reg = await hybrid.from('telegram_daily_picks').insert([{id:987123,date:'2026-10-09',ticker:'TEST',monitor_source:'daytrade_signal',status:'WAITING'}]);
    assert.equal(reg.error, null);
    const pick = await hybrid.from('telegram_daily_picks').select('ticker').eq('id',987123);
    assert.equal(pick.data[0].ticker,'TEST');
    assert.deepEqual(touched, []);
  } finally {
    closeVpsMarketStore();
    fs.rmSync(root,{recursive:true,force:true});
  }
});

test('FastWatcher remains read/write-compatible with injected test store without Supabase credentials', async () => {
  const store = { from(table) {
    assert.equal(table, 'daytrade_screener_latest');
    return { select() { return this; }, order() { return this; }, limit() { return Promise.resolve({data:[{ticker:'BBCA',board:'UTAMA',status:'READY_BREAKOUT',daytrade_score:90}],error:null}); } };
  } };
  const shortlist = await publisher.loadSupplementalShortlist({env:{},storeClient:store});
  assert.equal(shortlist.length, 1);
  assert.equal(shortlist[0].ticker,'BBCA');
});

test('FastWatcher copy accurately states the unchanged 3 of 5 confirmation requirement', () => {
  const msg = publisher.buildTelegramMessage({ticker:'TEST',ready_streak:3,observation:{metrics:{}}},'2026-10-09','09:15');
  assert.match(msg,/3 dari 5 snapshot/);
  assert.doesNotMatch(msg,/2 dari 3 snapshot/);
  assert.match(publisher.buildDbRow({ticker:'TEST',observation:{}},'2026-10-09','09:15').time_plan,/tiga konfirmasi dari lima/);
});
