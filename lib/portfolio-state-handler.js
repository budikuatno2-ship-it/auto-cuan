'use strict';

const { createClient } = require('@supabase/supabase-js');
const { isSameOrigin } = require('./admin-session');
const { requirePremiumEntitlement } = require('./subscription-auth');

const MAX_STATE_BYTES = 384 * 1024;
const MAX_PLANS = 200;
const MAX_JOURNAL = 200;
const MAX_CHANGES = 120;
const MAX_PRICE_KEYS = 250;

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

function isPlainObject(value) {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function jsonClone(value, fallback) {
  try { return JSON.parse(JSON.stringify(value)); }
  catch (_) { return fallback; }
}

function limitedObject(value, maxKeys) {
  if (!isPlainObject(value)) return {};
  const out = {};
  Object.keys(value).slice(0, maxKeys).forEach((key) => {
    const safeKey = String(key).slice(0, 80);
    out[safeKey] = jsonClone(value[key], null);
  });
  return out;
}

function normalizePortfolioState(input) {
  const raw = isPlainObject(input) ? input : {};
  const state = {
    version: 1,
    plans: Array.isArray(raw.plans) ? jsonClone(raw.plans.slice(0, MAX_PLANS), []) : [],
    prices: limitedObject(raw.prices, MAX_PRICE_KEYS),
    price_meta: limitedObject(raw.price_meta, MAX_PRICE_KEYS),
    journal: Array.isArray(raw.journal) ? jsonClone(raw.journal.slice(0, MAX_JOURNAL), []) : [],
    snapshot: raw.snapshot == null ? null : jsonClone(raw.snapshot, null),
    changes: Array.isArray(raw.changes) ? jsonClone(raw.changes.slice(0, MAX_CHANGES), []) : [],
    price_updated_at: Number.isFinite(Number(raw.price_updated_at)) && Number(raw.price_updated_at) > 0
      ? Math.round(Number(raw.price_updated_at))
      : null
  };

  const encoded = JSON.stringify(state);
  if (Buffer.byteLength(encoded, 'utf8') > MAX_STATE_BYTES) {
    const error = new Error('Data portofolio terlalu besar untuk disimpan.');
    error.status = 413;
    throw error;
  }
  return state;
}

function hasPortfolioData(state) {
  const value = normalizePortfolioState(state);
  return value.plans.length > 0
    || value.journal.length > 0
    || value.changes.length > 0
    || Object.keys(value.prices).length > 0
    || value.snapshot != null;
}

async function resolveAccount(req, res, supabase) {
  if (!isSameOrigin(req)) {
    res.status(403).json({ success: false, error: 'Permintaan ditolak.' });
    return null;
  }

  let access;
  try {
    access = await requirePremiumEntitlement(req, supabase);
  } catch (_) {
    res.status(503).json({ success: false, error: 'Status subscription belum tersedia.' });
    return null;
  }

  if (!access.ok) {
    res.status(access.status || 403).json({
      success: false,
      code: access.code || 'PREMIUM_ACCESS_DENIED',
      error: access.error || 'Akses premium diperlukan.',
      access_level: access.access_level || 'free'
    });
    return null;
  }

  return {
    id: String(access.account.id),
    username: String(access.account.username || '').trim().toLowerCase(),
    access_level: access.access_level || 'premium'
  };
}

async function loadState(req, res, supabase, account) {
  let result = await supabase
    .from('app_user_portfolio_state')
    .select('state, updated_at')
    .eq('user_id', account.id)
    .maybeSingle();

  if (result.error) {
    console.error('portfolio state load error:', result.error);
    return res.status(503).json({ success: false, error: 'Penyimpanan portofolio belum tersedia.' });
  }

  if (!result.data) {
    let bootstrap;
    try {
      bootstrap = normalizePortfolioState(req.body && req.body.bootstrap);
    } catch (error) {
      return res.status(error.status || 400).json({ success: false, error: error.message });
    }

    const inserted = await supabase
      .from('app_user_portfolio_state')
      .insert({ user_id: account.id, state: bootstrap, updated_at: new Date().toISOString() })
      .select('state, updated_at')
      .single();

    if (inserted.error) {
      // Two devices may perform the very first migration at the same time. The
      // primary key makes that harmless; re-read the winner instead of failing.
      if (inserted.error.code !== '23505') {
        console.error('portfolio state bootstrap error:', inserted.error);
        return res.status(503).json({ success: false, error: 'Penyimpanan portofolio belum tersedia.' });
      }
      result = await supabase
        .from('app_user_portfolio_state')
        .select('state, updated_at')
        .eq('user_id', account.id)
        .maybeSingle();
      if (result.error || !result.data) {
        return res.status(503).json({ success: false, error: 'Penyimpanan portofolio belum tersedia.' });
      }
    } else {
      result = inserted;
    }
  }

  let state;
  try { state = normalizePortfolioState(result.data && result.data.state); }
  catch (_) { state = normalizePortfolioState({}); }

  return res.status(200).json({
    success: true,
    storage: 'supabase',
    user_id: account.id,
    username: account.username,
    access_level: account.access_level,
    state,
    updated_at: result.data && result.data.updated_at || null
  });
}

async function saveState(req, res, supabase, account) {
  let state;
  try {
    state = normalizePortfolioState(req.body && req.body.portfolio_state);
  } catch (error) {
    return res.status(error.status || 400).json({ success: false, error: error.message });
  }

  const expectedUpdatedAt = String(req.body && req.body.expected_updated_at || '').trim();
  if (!expectedUpdatedAt) {
    return res.status(409).json({
      success: false,
      code: 'PORTFOLIO_STATE_CONFLICT',
      error: 'Versi portofolio cloud belum diketahui. Muat ulang sebelum menyimpan.'
    });
  }

  const updatedAt = new Date().toISOString();
  const result = await supabase
    .from('app_user_portfolio_state')
    .update({ state, updated_at: updatedAt })
    .eq('user_id', account.id)
    .eq('updated_at', expectedUpdatedAt)
    .select('updated_at')
    .maybeSingle();

  if (result.error) {
    console.error('portfolio state save error:', result.error);
    return res.status(503).json({ success: false, error: 'Portofolio belum berhasil disimpan ke cloud.' });
  }

  if (!result.data) {
    const latest = await supabase
      .from('app_user_portfolio_state')
      .select('updated_at')
      .eq('user_id', account.id)
      .maybeSingle();
    return res.status(409).json({
      success: false,
      code: 'PORTFOLIO_STATE_CONFLICT',
      error: 'Portofolio berubah di perangkat lain. Perubahan lokal tidak ditimpa.',
      current_updated_at: latest && latest.data ? latest.data.updated_at : null
    });
  }

  return res.status(200).json({
    success: true,
    storage: 'supabase',
    user_id: account.id,
    access_level: account.access_level,
    updated_at: result.data.updated_at || updatedAt
  });
}

async function portfolioStateHandler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store, no-cache, must-revalidate, max-age=0');
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  const action = String(req.body && req.body.action || '').trim();
  if (action !== 'portfolio-state-load' && action !== 'portfolio-state-save') {
    return res.status(400).json({ success: false, error: 'Aksi portofolio tidak dikenal.' });
  }

  const supabase = getSupabase();
  if (!supabase) {
    return res.status(503).json({ success: false, error: 'Database belum dikonfigurasi.' });
  }

  const account = await resolveAccount(req, res, supabase);
  if (!account) return;

  if (action === 'portfolio-state-load') return loadState(req, res, supabase, account);
  return saveState(req, res, supabase, account);
}

module.exports = portfolioStateHandler;
module.exports.__test = {
  MAX_STATE_BYTES,
  normalizePortfolioState,
  hasPortfolioData,
  isPlainObject
};