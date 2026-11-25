'use strict';

/**
 * Lifecycle outcome evaluator for telegram_daily_picks & Saham Potensial (V6).
 *
 * For every row in status WAITING / WAITING_ENTRY / ENTERED, fetch actual post-signal
 * OHLC from stock_daily_history (trade_date > signal date) and decide:
 *   - ENTERED (if price touches entry range)
 *   - TP2_HIT
 *   - TP1_HIT
 *   - STOP_LOSS
 *   - INVALIDATED_BEFORE_ENTRY
 *   - EXPIRED_NO_ENTRY (after 2-5 trading days if no entry)
 *   - TIME_EXIT (after 2-5 trading days if entered but no TP/SL)
 *
 * Standardizes:
 * - Trade dates in strict 'YYYY-MM-DD'
 * - Fast-forwarding stale rows with clear year attribution
 *
 * Usage:
 *   node tools/run-lifecycle-evaluator.js            # dry-run (default)
 *   node tools/run-lifecycle-evaluator.js --apply    # persist updates
 */

const fs = require('fs');
const path = require('path');
const lifecycleEngine = require('../lib/saham-potensial-lifecycle');

const RUNNER_DIR = process.env.AUTO_CUAN_RUNNER_DIR || '/home/ubuntu/auto-cuan-runner';
const ROOT_DIR = path.resolve(__dirname, '..');

function loadEnvFile(file) {
  try {
    if (!fs.existsSync(file)) return;
    for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const eq = t.indexOf('=');
      if (eq <= 0) continue;
      const k = t.slice(0, eq).trim();
      let v = t.slice(eq + 1).trim();
      if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
      if (!Object.prototype.hasOwnProperty.call(process.env, k)) process.env[k] = v;
    }
  } catch (_) {}
}

function loadEnv() {
  loadEnvFile(path.join(RUNNER_DIR, '.env'));
  loadEnvFile(path.join(ROOT_DIR, '.env.local'));
  loadEnvFile(path.join(ROOT_DIR, '.env.intraday-runtime'));
  loadEnvFile(path.join(ROOT_DIR, '.env'));
  loadEnvFile(path.join(ROOT_DIR, '.env.ai-eval-once'));

  if (process.env.AUTO_CUAN_MARKET_DATA_VPS == null &&
      (fs.existsSync(path.join(RUNNER_DIR, '.env')) || process.env.NODE_ENV === 'production')) {
    process.env.AUTO_CUAN_MARKET_DATA_VPS = '1';
  }
}

function num(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; }

async function main(options = {}) {
  loadEnv();
  const apply = options.apply != null ? options.apply : process.argv.includes('--apply');
  const limit = options.limit != null ? options.limit : (Number((process.argv.find(a => a.startsWith('--limit=')) || '').split('=')[1]) || 2000);

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) {
    if (!options.client && !options.supabase) {
      console.error('ERROR: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY tidak tersedia.');
      if (process.env.NODE_ENV !== 'test') process.exit(1);
      return { success: false, error: 'SUPABASE_KEYS_MISSING' };
    }
  }

  const { createClient } = require('../lib/hybrid-supabase-client');
  const supabase = options.client || options.supabase || createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const storeType = supabase.__marketDataVpsEnabled ? 'VPS_SQLITE' : 'SUPABASE';
  console.log('LIFECYCLE_EVALUATOR_STORE=' + storeType);

  const { data: rows, error } = await supabase
    .from('telegram_daily_picks')
    .select('id,date,ticker,category,entry1,entry2,tp1,tp2,sl,status,monitor_source,raw_payload')
    .in('status', ['WAITING', 'WAITING_ENTRY', 'ENTERED', 'RUNNING'])
    .order('date', { ascending: true })
    .limit(limit);
  if (error) {
    console.error('Read error:', error.message);
    if (process.env.NODE_ENV !== 'test') process.exit(1);
    return { success: false, error: error.message };
  }

  const stats = {
    scanned: rows ? rows.length : 0,
    resolved: 0,
    TP1_HIT: 0,
    TP2_HIT: 0,
    STOP_LOSS: 0,
    SL_HIT: 0,
    ENTERED: 0,
    INVALIDATED_BEFORE_ENTRY: 0,
    EXPIRED_NO_ENTRY: 0,
    TIME_EXIT: 0,
    // Subtask K: same-bar TP+SL is terminal but NOT a win/loss claim.
    AMBIGUOUS_SAME_BAR: 0,
    skipped_no_levels: 0,
    skipped_no_history: 0,
    errors: 0
  };
  const plan = [];

  for (const row of (rows || [])) {
    const tp1 = num(row.tp1), tp2 = num(row.tp2), sl = num(row.sl);
    if (!tp1 || !sl) { stats.skipped_no_levels++; continue; }
    try {
      const { data: hist, error: hErr } = await supabase
        .from('stock_daily_history')
        .select('trade_date,open,high,low,close')
        .eq('ticker', row.ticker)
        .gt('trade_date', lifecycleEngine.normalizeDateYmd(row.date))
        .order('trade_date', { ascending: true })
        .limit(60);
      if (hErr) { stats.errors++; continue; }
      if (!hist || hist.length === 0) { stats.skipped_no_history++; continue; }

      // Standardize pick object (carrying horizon metadata so maxHoldingDays is 5/10/30 per horizon)
      const pickToEval = {
        id: row.id,
        date: lifecycleEngine.normalizeDateYmd(row.date),
        ticker: row.ticker,
        category: row.category,
        monitor_source: row.monitor_source,
        raw_payload: row.raw_payload,
        entry1: row.entry1,
        entry2: row.entry2,
        sl: row.sl,
        tp1: row.tp1,
        tp2: row.tp2,
        status: row.status
      };

      const maxHoldingDays = typeof lifecycleEngine.resolveMaxHoldingDays === 'function'
        ? lifecycleEngine.resolveMaxHoldingDays(pickToEval)
        : 5;
      const result = lifecycleEngine.evaluateLifecycleHistory(pickToEval, hist, { maxHoldingDays });
      if (result.currentState === row.status) continue;

      if (stats[result.currentState] !== undefined) {
        stats[result.currentState]++;
      }
      if (result.isTerminal) {
        stats.resolved++;
      }

      let hitField = null;
      if (result.currentState === 'TP2_HIT') hitField = 'hit_tp2_at';
      else if (result.currentState === 'TP1_HIT') hitField = 'hit_tp1_at';
      else if (result.currentState === 'STOP_LOSS' || result.currentState === 'SL_HIT') hitField = 'hit_sl_at';

      plan.push({
        id: row.id,
        ticker: row.ticker,
        date: pickToEval.date,
        horizon_key: (row.raw_payload && row.raw_payload.horizon_key) || '',
        maxHoldingDays,
        status: result.currentState,
        exitDate: result.exitDate,
        hitField,
        isTerminal: result.isTerminal,
        gainPct: result.gainPct
      });
    } catch (_) {
      stats.errors++;
    }
  }

  const resultSummary = { mode: apply ? 'APPLY' : 'DRY_RUN', store: storeType, stats, planCount: plan.length };
  console.log(JSON.stringify(resultSummary, null, 2));

  if (apply && plan.length) {
    let updated = 0;
    for (const p of plan) {
      const patch = {
        status: p.status,
        is_final: p.isTerminal,
        last_checked_at: new Date().toISOString(),
        updated_at: new Date().toISOString()
      };
      if (p.hitField && p.exitDate) {
        patch[p.hitField] = new Date(p.exitDate + 'T00:00:00Z').toISOString();
      }
      const { error: uErr } = await supabase.from('telegram_daily_picks').update(patch).eq('id', p.id);
      if (uErr) { console.error('Update error id=' + p.id + ': ' + uErr.message); continue; }
      updated++;
    }
    try {
      const ledgerPath = path.join(ROOT_DIR, 'data', 'live-signal-ledger.json');
      if (fs.existsSync(ledgerPath)) {
        const parsed = JSON.parse(fs.readFileSync(ledgerPath, 'utf8'));
        if (Array.isArray(parsed)) {
          const hzOf = (p) => String(p.horizonKey || p.horizon_key || '').trim().toLowerCase();
          const byId = new Map(plan.filter((p) => p.id != null).map((p) => [String(p.id), p]));
          const byKey = new Map(plan.map((p) => [`${p.ticker}:${p.date}:${hzOf(p)}`, p]));
          const byFallbackKey = new Map(plan.map((p) => [`${p.ticker}:${p.date}`, p]));
          let changed = false;
          for (const row of parsed) {
            const rHz = String(row.horizon_key || (row.raw_payload && row.raw_payload.horizon_key) || '').trim().toLowerCase();
            const td = lifecycleEngine.normalizeDateYmd(row.date);
            const tk = String(row.ticker || '').toUpperCase();
            const upd = (row.id != null && byId.get(String(row.id)))
              || byKey.get(`${tk}:${td}:${rHz}`)
              || byFallbackKey.get(`${tk}:${td}`);
            if (!upd) continue;
            row.status = upd.status;
            row.is_final = upd.isTerminal;
            row.last_checked_at = new Date().toISOString();
            row.updated_at = row.last_checked_at;
            if (upd.hitField && upd.exitDate) {
              row[upd.hitField] = new Date(upd.exitDate + 'T00:00:00Z').toISOString();
            }
            changed = true;
          }
          if (changed) {
            const tmp = ledgerPath + '.' + process.pid + '.tmp';
            fs.writeFileSync(tmp, JSON.stringify(parsed, null, 2) + '\n', 'utf8');
            fs.renameSync(tmp, ledgerPath);
          }
        }
      }
    } catch (_) {}
    console.log('Rows updated: ' + updated + '/' + plan.length);
  } else if (!apply) {
    console.log('Dry-run only. Re-run with --apply to persist.');
  }

  return resultSummary;
}

module.exports = { main, loadEnv, num };

if (require.main === module) {
  main().catch(err => { console.error('Fatal:', err && err.message); process.exit(1); });
}
