'use strict';

/**
 * Money Management Module Handler — Life Cashflow & Trading Journal
 * ================================================================
 * Endpoints:
 *   GET  /api/money-management?action=get-cashflow&month=YYYY-MM
 *   POST /api/money-management?action=save-cashflow
 *   GET  /api/money-management?action=get-journal
 *   POST /api/money-management?action=save-journal
 *   POST /api/money-management?action=delete-journal
 *   GET  /api/money-management?action=summary
 *
 * Data is strictly isolated per User ID with RLS and server-side authentication.
 */

const { createClient } = require('@supabase/supabase-js');
const { requireAuthenticatedSession } = require('./admin-session');
const { requirePremiumEntitlement } = require('./subscription-auth');

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function resolveUser(req, supabase) {
  // 1. Check signed session cookie (ac_sess)
  const auth = requireAuthenticatedSession(req);
  if (auth.ok && auth.session && auth.session.uid) {
    return { id: auth.session.uid, username: auth.session.un, role: auth.session.adm ? 'admin' : 'user' };
  }

  // 2. Check premium entitlement header / bearer / device token
  if (supabase) {
    try {
      const ent = await requirePremiumEntitlement(req, supabase);
      if (ent.ok && ent.account && ent.account.id) {
        return { id: String(ent.account.id), username: ent.account.username || 'user', role: 'user' };
      }
    } catch (_) {}
  }

  // 3. Fallback for testing / development headers
  const devUid = req.headers && (req.headers['x-user-id'] || req.headers['X-User-Id']) || (req.query && req.query.dev_user_id);
  if (process.env.NODE_ENV !== 'production' && devUid) {
    return { id: String(devUid), username: 'dev-user', role: 'user' };
  }

  return null;
}

module.exports = async function handler(req, res) {
  if (res && typeof res.setHeader === 'function') {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization, X-Requested-With, X-User-Id');
  }

  if (req.method === 'OPTIONS') {
    return res.status ? res.status(204).end() : res.end();
  }

  const action = (req.query && req.query.action) || (req.body && req.body.action) || 'summary';
  const supabase = getSupabase();

  const user = await resolveUser(req, supabase);
  if (!user) {
    return res.status(401).json({
      success: false,
      code: 'UNAUTHORIZED',
      error: 'Silakan login terlebih dahulu untuk mengakses modul Kelola Keuangan.'
    });
  }

  try {
    // ----------------------------------------------------
    // SUB-TAB 1: ARUS KAS PRIBADI (LIFE CASHFLOW)
    // ----------------------------------------------------
    if (action === 'get-cashflow') {
      const nowWib = new Date(Date.now() + 7 * 60 * 60 * 1000);
      const defaultMonth = nowWib.toISOString().slice(0, 7); // YYYY-MM
      const month = String((req.query && req.query.month) || defaultMonth).trim();

      if (!supabase) {
        return res.status(200).json({
          success: true,
          offline: true,
          data: {
            month,
            income_salary: 0,
            income_side: 0,
            income_other: 0,
            expense_necessities: 0,
            expense_wants: 0,
            savings_emergency: 0,
            trading_capital_allocation: 0,
            notes: ''
          }
        });
      }

      const { data, error } = await supabase
        .from('user_personal_cashflow')
        .select('*')
        .eq('user_id', user.id)
        .eq('month', month)
        .maybeSingle();

      if (error) throw error;

      return res.status(200).json({
        success: true,
        data: data || {
          month,
          income_salary: 0,
          income_side: 0,
          income_other: 0,
          expense_necessities: 0,
          expense_wants: 0,
          savings_emergency: 0,
          trading_capital_allocation: 0,
          notes: ''
        }
      });
    }

    if (action === 'save-cashflow') {
      const b = req.body || {};
      const nowWib = new Date(Date.now() + 7 * 60 * 60 * 1000);
      const month = String(b.month || nowWib.toISOString().slice(0, 7)).trim();

      const payload = {
        user_id: user.id,
        month,
        income_salary: Number(b.income_salary) || 0,
        income_side: Number(b.income_side) || 0,
        income_other: Number(b.income_other) || 0,
        expense_necessities: Number(b.expense_necessities) || 0,
        expense_wants: Number(b.expense_wants) || 0,
        savings_emergency: Number(b.savings_emergency) || 0,
        trading_capital_allocation: Number(b.trading_capital_allocation) || 0,
        notes: String(b.notes || '').slice(0, 500),
        updated_at: new Date().toISOString()
      };

      if (!supabase) {
        return res.status(200).json({ success: true, offline: true, data: payload });
      }

      const { data, error } = await supabase
        .from('user_personal_cashflow')
        .upsert(payload, { onConflict: 'user_id,month' })
        .select('*')
        .single();

      if (error) throw error;
      return res.status(200).json({ success: true, data });
    }

    // ----------------------------------------------------
    // SUB-TAB 2: JURNAL PORTOFOLIO TRADING
    // ----------------------------------------------------
    if (action === 'get-journal') {
      if (!supabase) {
        return res.status(200).json({ success: true, offline: true, data: [] });
      }

      const { data, error } = await supabase
        .from('user_trading_journal')
        .select('*')
        .eq('user_id', user.id)
        .order('trade_date', { ascending: false })
        .order('created_at', { ascending: false });

      if (error) throw error;
      return res.status(200).json({ success: true, data: data || [] });
    }

    if (action === 'save-journal') {
      const b = req.body || {};
      const ticker = String(b.ticker || '').trim().toUpperCase();
      if (!ticker) {
        return res.status(400).json({ success: false, error: 'Kode saham wajib diisi.' });
      }

      const position_type = String(b.position_type || 'BUY').toUpperCase();
      const entry_price = Math.max(1, Number(b.entry_price) || 0);
      const lots = Math.max(1, parseInt(b.lots, 10) || 1);
      const capital_used = entry_price * lots * 100;

      let exit_price = (b.exit_price != null && b.exit_price !== '') ? Number(b.exit_price) : null;
      let realized_pl_rp = 0;
      let realized_pl_pct = 0;
      let status = b.status || (exit_price ? 'CLOSED' : 'OPEN');

      if (exit_price != null && exit_price > 0) {
        const exitCapital = exit_price * lots * 100;
        if (position_type === 'BUY') {
          realized_pl_rp = exitCapital - capital_used;
          realized_pl_pct = Number((((exit_price - entry_price) / entry_price) * 100).toFixed(2));
        } else {
          realized_pl_rp = capital_used - exitCapital;
          realized_pl_pct = Number((((entry_price - exit_price) / entry_price) * 100).toFixed(2));
        }
      }

      const payload = {
        user_id: user.id,
        trade_date: b.trade_date || new Date().toISOString().slice(0, 10),
        ticker,
        position_type,
        entry_price,
        lots,
        capital_used,
        exit_price,
        realized_pl_rp,
        realized_pl_pct,
        notes: String(b.notes || '').slice(0, 500),
        status,
        updated_at: new Date().toISOString()
      };

      if (b.id) payload.id = b.id;

      if (!supabase) {
        return res.status(200).json({ success: true, offline: true, data: payload });
      }

      const { data, error } = await supabase
        .from('user_trading_journal')
        .upsert(payload)
        .select('*')
        .single();

      if (error) throw error;
      return res.status(200).json({ success: true, data });
    }

    if (action === 'delete-journal') {
      const id = req.body && req.body.id;
      if (!id) return res.status(400).json({ success: false, error: 'ID transaksi diperlukan.' });

      if (!supabase) {
        return res.status(200).json({ success: true, offline: true });
      }

      const { error } = await supabase
        .from('user_trading_journal')
        .delete()
        .eq('id', id)
        .eq('user_id', user.id);

      if (error) throw error;
      return res.status(200).json({ success: true });
    }

    // ----------------------------------------------------
    // RINGKASAN OTOMATIS (SUMMARY & WIN RATE)
    // ----------------------------------------------------
    if (action === 'summary') {
      const nowWib = new Date(Date.now() + 7 * 60 * 60 * 1000);
      const month = String((req.query && req.query.month) || nowWib.toISOString().slice(0, 7)).trim();

      let cashflow = null;
      let journal = [];

      if (supabase) {
        const [cfRes, jrRes] = await Promise.all([
          supabase.from('user_personal_cashflow').select('*').eq('user_id', user.id).eq('month', month).maybeSingle(),
          supabase.from('user_trading_journal').select('*').eq('user_id', user.id)
        ]);
        cashflow = cfRes.data;
        journal = jrRes.data || [];
      }

      const totalTradingCapital = cashflow ? Number(cashflow.trading_capital_allocation || 0) : 0;
      const closedTrades = journal.filter(j => j.status === 'CLOSED' || (j.exit_price != null && j.exit_price > 0));
      const openTrades = journal.filter(j => j.status === 'OPEN' || (!j.exit_price && j.exit_price !== 0));

      const deployedCapital = openTrades.reduce((sum, j) => sum + (Number(j.capital_used) || 0), 0);
      const totalRealizedPl = closedTrades.reduce((sum, j) => sum + (Number(j.realized_pl_rp) || 0), 0);
      const winningTrades = closedTrades.filter(j => Number(j.realized_pl_rp) > 0).length;
      const winRate = closedTrades.length > 0 ? Number(((winningTrades / closedTrades.length) * 100).toFixed(1)) : 0;

      // Sisa kas menganggur / RDL = Modal dialokasikan - modal di posisi terbuka + total keuntungan terealisasi
      const idleCashRdl = Math.max(0, totalTradingCapital - deployedCapital + totalRealizedPl);

      // Sisa anggaran kebutuhan hidup di luar trading
      const totalIncome = cashflow ? (Number(cashflow.income_salary || 0) + Number(cashflow.income_side || 0) + Number(cashflow.income_other || 0)) : 0;
      const totalLivingExpense = cashflow ? (Number(cashflow.expense_necessities || 0) + Number(cashflow.expense_wants || 0) + Number(cashflow.savings_emergency || 0)) : 0;
      const nonTradingBudgetBalance = totalIncome - totalLivingExpense - totalTradingCapital;

      return res.status(200).json({
        success: true,
        summary: {
          month,
          total_income: totalIncome,
          total_living_expense: totalLivingExpense,
          non_trading_budget_balance: nonTradingBudgetBalance,
          total_trading_capital: totalTradingCapital,
          deployed_capital: deployedCapital,
          idle_cash_rdl: idleCashRdl,
          total_realized_pl_rp: totalRealizedPl,
          total_trades: closedTrades.length,
          winning_trades: winningTrades,
          win_rate: winRate,
          open_positions_count: openTrades.length
        }
      });
    }

    return res.status(400).json({ success: false, error: 'Aksi tidak valid: ' + action });
  } catch (err) {
    console.error('[MONEY MANAGEMENT HANDLER ERROR]', err);
    return res.status(500).json({ success: false, error: err.message });
  }
};
