'use strict';

/**
 * Unit & Integration Tests for VPS Monitor Local Runner & BEP Lock Evaluation
 *
 * Tests:
 * 1. Production approval gate (LOCAL_MONITOR_LIVE_APPROVED=YES)
 * 2. Active trading window logic (09:05 - 16:05 WIB, Monday-Friday)
 * 3. Graceful handling of empty active picks without crash
 * 4. Active picks processing and BEP lock evaluation (+2.0% profit triggers BEP_CLOSED)
 * 5. VPS bash runner wrapper contract (telegram-monitor-local.sh)
 */

const assert = require('node:assert/strict');
const { spawnSync } = require('node:child_process');
const fs = require('node:fs');
const Module = require('node:module');
const path = require('node:path');
const test = require('node:test');

const root = path.resolve(__dirname, '..');
const runnerPath = path.join(root, 'tools', 'run-telegram-monitor-local.js');
const wrapperPath = path.join(root, 'deploy', 'vps', 'telegram-monitor-local.sh');

// Helper to safely load runner module helpers
const {
  getJakartaDateParts,
  isMarketSessionWib,
  loadEnvFile
} = require(runnerPath);

// Stub @supabase/supabase-js for sector-hot require if not available
const origLoad = Module._load;
Module._load = function (request, parent, isMain) {
  if (request === '@supabase/supabase-js') {
    return { createClient: function () { return {}; } };
  }
  return origLoad.apply(this, arguments);
};

process.env.CRON_SECRET = process.env.CRON_SECRET || 'test-cron-secret-vps';

const sectorHot = require('../api/sector-hot.js');
const telegramNotifier = require('../lib/telegram-notifier');
const aiNarration = require('../lib/ai-narration');

// Restore loader
Module._load = origLoad;

const {
  handleTelegramMonitorPicks,
  evaluateMonitorStatus
} = sectorHot.__test;

// Mock Supabase helper
function makeMockSupabase(opts = {}) {
  const rows = opts.rows || [];
  const daytradePrices = opts.daytradePrices || {};
  const foreignPrices = opts.foreignPrices || {};
  const updateCalls = [];

  function from(table) {
    const ctx = { table, op: 'select', eqCol: null, eqVal: null, updateObj: null };
    const builder = {
      select: () => builder,
      in: () => builder,
      order: () => builder,
      eq: (col, val) => { ctx.eqCol = col; ctx.eqVal = val; return builder; },
      update: (obj) => { ctx.op = 'update'; ctx.updateObj = obj; return builder; },
      maybeSingle: () => {
        const data = daytradePrices[ctx.eqVal] || null;
        return Promise.resolve({ data, error: null });
      },
      limit: () => {
        const row = foreignPrices[ctx.eqVal];
        return Promise.resolve({ data: row ? [row] : [], error: null });
      },
      then: (resolve, reject) => {
        try {
          if (ctx.op === 'update') {
            updateCalls.push({ table, updateObj: ctx.updateObj, eqCol: ctx.eqCol, eqVal: ctx.eqVal });
            resolve({ data: null, error: null });
          } else {
            resolve({ data: rows.slice(), error: null });
          }
        } catch (e) { reject(e); }
      }
    };
    return builder;
  }

  return { from, updateCalls };
}

function makeRes() {
  return {
    statusCode: null,
    body: null,
    status: function (code) { this.statusCode = code; return this; },
    json: function (payload) { this.body = payload; return this; }
  };
}

// -----------------------------------------------------------------------------
// 1. APPROVAL GATE ENFORCEMENT
// -----------------------------------------------------------------------------
test('Approval Gate: --execute without LOCAL_MONITOR_LIVE_APPROVED=YES fails closed with LIVE_BLOCKED', () => {
  const res = spawnSync(
    process.execPath,
    [runnerPath, '--execute'],
    {
      cwd: root,
      env: {
        ...process.env,
        LOCAL_MONITOR_LIVE_APPROVED: 'NO',
        SUPABASE_URL: 'https://example.supabase.co',
        SUPABASE_SERVICE_ROLE_KEY: 'test-key',
        CRON_SECRET: 'test-cron'
      },
      encoding: 'utf8'
    }
  );

  assert.notEqual(res.status, 0, 'Must exit non-zero when unapproved');
  assert.match(res.stderr, /LIVE_BLOCKED/, 'Error output must state LIVE_BLOCKED');
});

// -----------------------------------------------------------------------------
// 2. TRADING WINDOW LOGIC (09:05 - 16:05 WIB Mon-Fri)
// -----------------------------------------------------------------------------
test('Trading Window: isMarketSessionWib correctly identifies market hours and weekends', () => {
  // Tuesday at 10:00 WIB (03:00 UTC)
  const tue10am = new Date('2026-09-08T03:00:00.000Z');
  const resTue10am = isMarketSessionWib(tue10am);
  assert.equal(resTue10am.active, true);
  assert.equal(resTue10am.reason, null);

  // Tuesday at 08:30 WIB (01:30 UTC) - pre-market
  const tue830am = new Date('2026-09-08T01:30:00.000Z');
  const resTue830am = isMarketSessionWib(tue830am);
  assert.equal(resTue830am.active, false);
  assert.equal(resTue830am.reason, 'outside_trading_hours');

  // Tuesday at 16:30 WIB (09:30 UTC) - after-market
  const tue430pm = new Date('2026-09-08T09:30:00.000Z');
  const resTue430pm = isMarketSessionWib(tue430pm);
  assert.equal(resTue430pm.active, false);
  assert.equal(resTue430pm.reason, 'outside_trading_hours');

  // Sunday at 10:00 WIB (03:00 UTC) - weekend
  const sun10am = new Date('2026-09-13T03:00:00.000Z');
  const resSun10am = isMarketSessionWib(sun10am);
  assert.equal(resSun10am.active, false);
  assert.equal(resSun10am.reason, 'weekend');
});

// -----------------------------------------------------------------------------
// 3. RUNNER DRY-RUN & BEP EVALUATION INTEGRATION
// -----------------------------------------------------------------------------
test('Monitor Evaluation: processes empty active picks table gracefully without crash', async () => {
  const supabase = makeMockSupabase({ rows: [] });
  const req = {
    method: 'GET',
    query: { dry_run: '1', force: '1' },
    headers: { authorization: 'Bearer test-cron-secret-vps' }
  };
  const res = makeRes();

  await handleTelegramMonitorPicks(req, res, supabase);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.skipped, true);
  assert.equal(res.body.reason, 'no_active_picks');
  assert.equal(res.body.checked_count, 0);
});

test('Monitor Evaluation: Day Trade pick triggers BEP lock (+2.0%) and resolves to BEP_CLOSED upon pullback', async () => {
  const nowIso = new Date().toISOString();
  const pick = {
    id: 101,
    ticker: 'BBRI',
    date: '2026-09-11',
    status: 'RUNNING',
    is_final: false,
    entry1: 100,
    entry2: 100,
    sl: 95,
    tp1: 106,
    tp2: 112,
    category: 'Day Trade',
    first_sent_at: nowIso,
    hit_entry_at: nowIso,
    high_since_entry: 102.5, // touched +2.5% profit
    bep_locked: false,
    raw_payload: { monitor_source: 'daytrade_signal' }
  };

  const supabase = makeMockSupabase({
    rows: [pick],
    daytradePrices: {
      BBRI: {
        ticker: 'BBRI',
        last_price: 100, // pulled back to entry
        open_price: 100,
        high_price: 102.5,
        low_price: 99.5,
        calculated_at: nowIso
      }
    }
  });

  const req = {
    method: 'GET',
    query: { dry_run: '1', force: '1' },
    headers: { authorization: 'Bearer test-cron-secret-vps' }
  };
  const res = makeRes();

  await handleTelegramMonitorPicks(req, res, supabase);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  assert.equal(res.body.checked_count, 1);

  // Check event output
  const event = (res.body.events || []).find(e => e.ticker === 'BBRI');
  assert.ok(event, 'BBRI event must be recorded');
  assert.equal(event.simulated_status, 'BEP_CLOSED');
});

test('Monitor Evaluation: Day Trade pick triggers TP1_HIT when target reached', async () => {
  const nowIso = new Date().toISOString();
  const pick = {
    id: 102,
    ticker: 'BMRI',
    date: '2026-09-11',
    status: 'RUNNING',
    is_final: false,
    entry1: 100,
    entry2: 100,
    sl: 95,
    tp1: 105,
    tp2: 110,
    category: 'Day Trade',
    first_sent_at: nowIso,
    hit_entry_at: nowIso,
    raw_payload: { monitor_source: 'daytrade_signal' }
  };

  const supabase = makeMockSupabase({
    rows: [pick],
    daytradePrices: {
      BMRI: {
        ticker: 'BMRI',
        last_price: 105.5,
        open_price: 100,
        high_price: 106,
        low_price: 103, // stays above entry + 1 tick, reaching TP1 without BEP exit
        calculated_at: nowIso
      }
    }
  });

  const req = {
    method: 'GET',
    query: { dry_run: '1', force: '1' },
    headers: { authorization: 'Bearer test-cron-secret-vps' }
  };
  const res = makeRes();

  await handleTelegramMonitorPicks(req, res, supabase);

  assert.equal(res.statusCode, 200);
  assert.equal(res.body.success, true);
  const event = (res.body.events || []).find(e => e.ticker === 'BMRI');
  assert.ok(event);
  assert.equal(event.simulated_status, 'TP1_HIT');
});

// -----------------------------------------------------------------------------
// 4. VPS BASH WRAPPER CONTRACT (telegram-monitor-local.sh)
// -----------------------------------------------------------------------------
test('VPS Bash Wrapper: contains non-blocking flock, timezone, node fallback, and approval support', () => {
  const wrapper = fs.readFileSync(wrapperPath, 'utf8');

  assert.match(wrapper, /flock -n "\$LOCK_FILE"/, 'Wrapper must use non-blocking flock');
  assert.match(wrapper, /export TZ=Asia\/Jakarta/, 'Wrapper must force Jakarta timezone');
  assert.match(wrapper, /tools\/run-telegram-monitor-local\.js/, 'Wrapper must execute Node runner');
  assert.match(wrapper, /LOCAL_MONITOR_LIVE_APPROVED/, 'Wrapper must support LOCAL_MONITOR_LIVE_APPROVED');
  assert.match(wrapper, /09:05 - 16:05 WIB/, 'Wrapper must document active trading hours schedule');
});
