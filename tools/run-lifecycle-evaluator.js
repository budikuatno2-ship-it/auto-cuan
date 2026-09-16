'use strict';

/**
 * Lifecycle outcome evaluator for telegram_daily_picks (MUTATING).
 *
 * For every row still in status WAITING, fetch actual post-signal OHLC from
 * public.stock_daily_history (trade_date > signal date) and decide:
 *   High >= tp2                    -> TP2_HIT
 *   High >= tp1 (and < tp2)        -> TP1_HIT
 *   Low  <= sl                     -> SL_HIT
 * First qualifying trading day wins; within a day TP is checked before SL,
 * matching the user-specified precedence.
 *
 * Usage (from repo root):
 *   set -a; . ./.env.ai-eval-once; set +a
 *   node tools/run-lifecycle-evaluator.js            # dry-run (default)
 *   node tools/run-lifecycle-evaluator.js --apply    # write to Supabase
 */

const fs = require('fs');
const path = require('path');

function loadEnvFile() {
  const candidates = ['.env.ai-eval-once', '.env.local', '.env'].map(n => path.join(__dirname, '..', n));
  for (const file of candidates) {
    try {
      if (!fs.existsSync(file)) continue;
      for (const line of fs.readFileSync(file, 'utf8').split(/\r?\n/)) {
        const t = line.trim();
        if (!t || t.startsWith('#')) continue;
        const eq = t.indexOf('=');
        if (eq <= 0) continue;
        const k = t.slice(0, eq).trim();
        let v = t.slice(eq + 1).trim();
        if ((v.startsWith('"') && v.endsWith('"')) || (v.startsWith("'") && v.endsWith("'"))) v = v.slice(1, -1);
        if (!process.env[k]) process.env[k] = v;
      }
    } catch (_) {}
  }
}

function num(v) { const n = Number(v); return Number.isFinite(n) && n > 0 ? n : null; }

async function main() {
  loadEnvFile();
  const apply = process.argv.includes('--apply');
  const limit = Number((process.argv.find(a => a.startsWith('--limit=')) || '').split('=')[1]) || 2000;

  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) { console.error('ERROR: SUPABASE_URL / SUPABASE_SERVICE_ROLE_KEY tidak tersedia.'); process.exit(1); }

  const { createClient } = require('@supabase/supabase-js');
  const supabase = createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });

  const { data: rows, error } = await supabase
    .from('telegram_daily_picks')
    .select('id,date,ticker,category,entry1,tp1,tp2,sl,status,monitor_source')
    .eq('status', 'WAITING')
    .order('date', { ascending: true })
    .limit(limit);
  if (error) { console.error('Read error:', error.message); process.exit(1); }

  const stats = { scanned: rows.length, resolved: 0, TP1_HIT: 0, TP2_HIT: 0, SL_HIT: 0, skipped_no_levels: 0, skipped_no_history: 0, errors: 0 };
  const plan = [];

  for (const row of rows) {
    const tp1 = num(row.tp1), tp2 = num(row.tp2), sl = num(row.sl);
    if (!tp1 || !sl) { stats.skipped_no_levels++; continue; }
    try {
      const { data: hist, error: hErr } = await supabase
        .from('stock_daily_history')
        .select('trade_date,high,low')
        .eq('ticker', row.ticker)
        .gt('trade_date', row.date)
        .order('trade_date', { ascending: true })
        .limit(60);
      if (hErr) { stats.errors++; continue; }
      if (!hist || hist.length === 0) { stats.skipped_no_history++; continue; }

      let outcome = null;
      for (const d of hist) {
        const high = Number(d.high), low = Number(d.low);
        if (!Number.isFinite(high) || !Number.isFinite(low)) continue;
        if (tp2 && high >= tp2) { outcome = { status: 'TP2_HIT', at: d.trade_date, field: 'hit_tp2_at' }; break; }
        if (high >= tp1) { outcome = { status: 'TP1_HIT', at: d.trade_date, field: 'hit_tp1_at' }; break; }
        if (low <= sl) { outcome = { status: 'SL_HIT', at: d.trade_date, field: 'hit_sl_at' }; break; }
      }
      if (!outcome) continue;

      stats[outcome.status]++;
      stats.resolved++;
      plan.push({ id: row.id, ticker: row.ticker, date: row.date, ...outcome });
    } catch (_) {
      stats.errors++;
    }
  }

  console.log(JSON.stringify({ mode: apply ? 'APPLY' : 'DRY_RUN', stats }, null, 2));

  if (apply && plan.length) {
    let updated = 0;
    for (const p of plan) {
      const patch = { status: p.status, is_final: true, last_checked_at: new Date().toISOString(), updated_at: new Date().toISOString() };
      patch[p.field] = new Date(p.at + 'T00:00:00Z').toISOString();
      const { error: uErr } = await supabase.from('telegram_daily_picks').update(patch).eq('id', p.id);
      if (uErr) { console.error('Update error id=' + p.id + ': ' + uErr.message); continue; }
      updated++;
    }
    console.log('Rows updated: ' + updated + '/' + plan.length);
  } else if (!apply) {
    console.log('Dry-run only. Re-run with --apply to persist.');
  }
}

main().catch(err => { console.error('Fatal:', err && err.message); process.exit(1); });
