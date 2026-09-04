'use strict';

const { createClient } = require('@supabase/supabase-js');
const { requireAuthenticatedSession } = require('./admin-session');
const { saveUserApiKey, deleteUserApiKey } = require('./user-ai-credentials');
const { getAnalysisStatus, runChartAnalysis } = require('./chart-analysis-service');

function getSupabase() {
  const url = process.env.SUPABASE_URL;
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

function parseJsonBody(req) {
  if (req.body && typeof req.body === 'object') return req.body;
  if (typeof req.body === 'string') {
    try { return JSON.parse(req.body); } catch (_) { return {}; }
  }
  return {};
}

module.exports = async function handleChartAnalysisEndpoint(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');
  res.setHeader('X-Content-Type-Options', 'nosniff');

  const auth = requireAuthenticatedSession(req);
  if (!auth.ok) {
    return res.status(auth.status || 401).json({
      success: false,
      code: 'UNAUTHORIZED',
      error: auth.error || 'Sesi login diperlukan.'
    });
  }

  const db = getSupabase();
  const action = String(req.query && req.query.action || '').trim().toLowerCase();

  // GET: status & quota info
  if (req.method === 'GET' || action === 'status') {
    const ticker = String(req.query && req.query.ticker || '').trim().toUpperCase();
    const statusResult = await getAnalysisStatus(req, db, ticker);
    return res.status(statusResult.status || 200).json(statusResult);
  }

  // Mutating requests must be POST
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method Not Allowed' });
  }

  const body = parseJsonBody(req);
  const userId = auth.session.uid;

  // POST: set user Gemini API key
  if (action === 'set-key') {
    const rawKey = body.apiKey;
    const saveRes = await saveUserApiKey(db, userId, rawKey, 'gemini');
    if (!saveRes.ok) {
      return res.status(saveRes.status || 400).json({
        success: false,
        error: saveRes.error
      });
    }
    return res.status(200).json({
      success: true,
      maskedKey: saveRes.maskedKey,
      message: 'API key Gemini berhasil disimpan secara aman.'
    });
  }

  // POST: delete user Gemini API key
  if (action === 'delete-key') {
    await deleteUserApiKey(db, userId, 'gemini');
    return res.status(200).json({
      success: true,
      message: 'API key Gemini berhasil dihapus.'
    });
  }

  // POST: trigger chart analysis
  if (action === 'analyze') {
    const ticker = String(body.ticker || req.query.ticker || '').trim().toUpperCase();
    const result = await runChartAnalysis(req, db, ticker, {
      forceFresh: body.forceFresh === true,
      planLevels: Array.isArray(body.planLevels) ? body.planLevels : []
    });

    if (!result.ok) {
      return res.status(result.status || 400).json({
        success: false,
        code: result.code || 'ANALYSIS_FAILED',
        error: result.error
      });
    }

    return res.status(200).json({
      success: true,
      cached: result.cached === true,
      data: result.data,
      quota: result.quota
    });
  }

  return res.status(400).json({
    success: false,
    error: 'Aksi tidak dikenal. Gunakan action=status, action=set-key, action=delete-key, atau action=analyze.'
  });
};
