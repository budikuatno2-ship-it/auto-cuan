'use strict';

const { createClient } = require('@supabase/supabase-js');
const { requireAuthenticatedSession, isSameOrigin } = require('./admin-session');

function clean(value, max) {
  return String(value == null ? '' : value)
    .replace(/\u0000/g, '')
    .trim()
    .slice(0, max || 20000);
}

function finite(value) {
  const number = Number(value);
  return Number.isFinite(number) ? number : null;
}

function tickerOf(value) {
  const ticker = clean(value, 10).toUpperCase().replace(/\.JK$/i, '');
  return /^[A-Z]{3,5}$/.test(ticker) ? ticker : '';
}

function sanitizeStockContext(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const ticker = tickerOf(input.ticker);
  const analysisText = clean(input.analysis_text || input.analysisText, 40000);
  if (!ticker || !analysisText) return null;
  return {
    ticker,
    analysis_text: analysisText,
    captured_at: clean(input.captured_at || input.capturedAt, 80) || new Date().toISOString(),
    data_origin: clean(input.data_origin, 40) || 'analysis_snapshot'
  };
}

function sanitizePlan(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const ticker = tickerOf(input.ticker);
  if (!ticker) return null;
  const result = {
    ticker,
    entryPriceIdr: finite(input.entryPriceIdr != null ? input.entryPriceIdr : input.entry),
    stopLossIdr: finite(input.stopLossIdr != null ? input.stopLossIdr : input.stop),
    tp1Idr: finite(input.tp1Idr != null ? input.tp1Idr : input.tp1),
    tp2Idr: finite(input.tp2Idr != null ? input.tp2Idr : input.tp2),
    lots: finite(input.lots),
    currentPriceIdr: finite(input.currentPriceIdr),
    estimatedMaxLossIdr: finite(input.estimatedMaxLossIdr != null ? input.estimatedMaxLossIdr : input.riskBudgetIdr),
    capitalIdr: finite(input.capitalIdr),
    source: clean(input.source, 50),
    positionStatus: clean(input.positionStatus, 40),
    createdAt: clean(input.createdAt, 80)
  };
  return result;
}

function sanitizePortfolioContext(raw) {
  const input = raw && typeof raw === 'object' ? raw : {};
  const plans = (Array.isArray(input.plans) ? input.plans : [])
    .slice(0, 50)
    .map(sanitizePlan)
    .filter(Boolean);
  const prices = {};
  const sourcePrices = input.prices && typeof input.prices === 'object' && !Array.isArray(input.prices)
    ? input.prices
    : {};
  Object.keys(sourcePrices).slice(0, 80).forEach((key) => {
    const ticker = tickerOf(key);
    const price = finite(sourcePrices[key]);
    if (ticker && price != null && price > 0) prices[ticker] = price;
  });
  const summaryInput = input.summary && typeof input.summary === 'object' ? input.summary : {};
  const summary = {};
  Object.keys(summaryInput).slice(0, 30).forEach((key) => {
    const value = summaryInput[key];
    if (typeof value === 'number' && Number.isFinite(value)) summary[clean(key, 60)] = value;
    else if (typeof value === 'string') summary[clean(key, 60)] = clean(value, 300);
  });
  const journal = (Array.isArray(input.journal) ? input.journal : []).slice(-50).map((row) => ({
    ticker: tickerOf(row && row.ticker),
    action: clean(row && row.action, 40),
    note: clean(row && row.note, 500),
    followedPlan: typeof (row && row.followedPlan) === 'boolean' ? row.followedPlan : null,
    at: clean(row && (row.at || row.createdAt), 80)
  })).filter((row) => row.ticker || row.action || row.note);
  const changes = (Array.isArray(input.changes) ? input.changes : []).slice(-60).map((row) => ({
    type: clean(row && row.type, 50),
    ticker: tickerOf(row && row.ticker),
    text: clean(row && row.text, 500),
    at: clean(row && row.at, 80)
  })).filter((row) => row.type || row.ticker || row.text);
  const alerts = (Array.isArray(input.alerts) ? input.alerts : []).slice(0, 50).map((row) => ({
    ticker: tickerOf(row && row.ticker),
    type: clean(row && row.type, 50),
    level: finite(row && row.level),
    note: clean(row && row.note, 300)
  })).filter((row) => row.ticker || row.type);
  const budget = input.budget && typeof input.budget === 'object' ? {
    capitalIdr: finite(input.budget.capitalIdr),
    reservePct: finite(input.budget.reservePct),
    maxPositions: finite(input.budget.maxPositions),
    riskProfile: clean(input.budget.riskProfile, 40)
  } : null;
  if (!plans.length && !journal.length && !changes.length && !budget) return null;
  return {
    plans,
    prices,
    summary,
    journal,
    changes,
    alerts,
    budget,
    captured_at: clean(input.captured_at || input.capturedAt, 80) || new Date().toISOString(),
    data_origin: clean(input.data_origin, 40) || 'portfolio_snapshot'
  };
}

function sanitizeContext(source, raw) {
  if (source === 'stock_analysis_followup') return sanitizeStockContext(raw);
  if (source === 'portfolio_chat') return sanitizePortfolioContext(raw);
  return null;
}

function contextKey(source, context) {
  return source === 'stock_analysis_followup' ? context.ticker : 'portfolio';
}

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function hydrateContext(req, source, incoming) {
  const sanitized = sanitizeContext(source, incoming);
  if (!isSameOrigin(req)) return sanitized || incoming || {};
  const auth = requireAuthenticatedSession(req);
  if (!auth.ok) return sanitized || incoming || {};
  const supabase = getSupabase();
  if (!supabase) return sanitized || incoming || {};
  const userId = String(auth.session.uid || '').trim();
  if (!userId) return sanitized || incoming || {};

  if (sanitized) {
    const row = {
      user_id: userId,
      source,
      context_key: contextKey(source, sanitized),
      payload: sanitized,
      captured_at: sanitized.captured_at || new Date().toISOString(),
      updated_at: new Date().toISOString()
    };
    const result = await supabase
      .from('ai_context_snapshots')
      .upsert(row, { onConflict: 'user_id,source,context_key' });
    if (result.error) console.warn('ai context snapshot upsert skipped', result.error.code || result.error.message);
    return sanitized;
  }

  const result = await supabase
    .from('ai_context_snapshots')
    .select('payload')
    .eq('user_id', userId)
    .eq('source', source)
    .order('updated_at', { ascending: false })
    .limit(1)
    .maybeSingle();
  if (result.error) {
    console.warn('ai context snapshot hydrate skipped', result.error.code || result.error.message);
    return incoming || {};
  }
  return sanitizeContext(source, result.data && result.data.payload) || incoming || {};
}

module.exports = {
  clean,
  tickerOf,
  sanitizeStockContext,
  sanitizePortfolioContext,
  sanitizeContext,
  hydrateContext
};
