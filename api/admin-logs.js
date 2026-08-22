'use strict';

const { createClient } = require('@supabase/supabase-js');
const { requireAdminSession, isSameOrigin } = require('../lib/admin-session');
const securityGuard = require('../lib/security-guard');

module.exports = async function handler(req, res) {
  res.setHeader('Cache-Control', 'private, no-store');

  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    // Authorization is derived from the server-signed session ONLY. Any `adminName`
    // supplied in the request body is intentionally ignored.
    if (!isSameOrigin(req)) {
      return res.status(403).json({ success: false, error: 'Permintaan ditolak.' });
    }
    const auth = requireAdminSession(req);
    if (!auth.ok) {
      return res.status(auth.status).json({ success: false, error: auth.error });
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(200).json({ success: false, error: 'Database logging belum dikonfigurasi.' });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    // Existing analytics remain authoritative. Security events are loaded
    // independently and degrade to an unavailable status until the additive
    // Security Phase 1 migration is applied.
    const [loginRes, searchRes, analysisRes, usageRes, security] = await Promise.all([
      supabase.from('login_logs').select('*').order('created_at', { ascending: false }).limit(50),
      supabase.from('search_logs').select('*').order('created_at', { ascending: false }).limit(100),
      supabase.from('ai_analysis_logs').select('id, username, ticker, mode, created_at').order('created_at', { ascending: false }).limit(50),
      supabase.from('ai_usage_logs').select('*').order('created_at', { ascending: false }).limit(100),
      securityGuard.loadSecurityDashboard(supabase)
    ]);

    if (loginRes.error || searchRes.error || analysisRes.error || usageRes.error) {
      const err = loginRes.error || searchRes.error || analysisRes.error || usageRes.error;
      console.error('admin-logs fetch error:', err);
      return res.status(200).json({ success: false, error: 'Database query failed.' });
    }

    const loginLogs = loginRes.data || [];
    const searchLogs = searchRes.data || [];
    const aiAnalysisLogs = analysisRes.data || [];
    const aiUsageLogs = usageRes.data || [];

    // Build summary
    const totalLogins = loginLogs.length;
    const totalSearches = searchLogs.length;
    const totalAIAnalyses = aiAnalysisLogs.length;

    // Most searched ticker (filter pseudo-symbols)
    const tickerCounts = {};
    const PSEUDO_SYMBOLS = ['CHART_UPLOAD', 'BROKER_SUMMARY', 'UNKNOWN', '', 'NULL', 'UNDEFINED'];
    searchLogs.forEach(function(row) {
      if (row.ticker) {
        var t = row.ticker.toUpperCase().trim();
        if (PSEUDO_SYMBOLS.indexOf(t) === -1 && t.length >= 3 && t.length <= 5 && /^[A-Z]+$/.test(t)) {
          tickerCounts[t] = (tickerCounts[t] || 0) + 1;
        }
      }
    });
    let mostSearchedTicker = '-';
    let maxCount = 0;
    Object.keys(tickerCounts).forEach(function(t) {
      if (tickerCounts[t] > maxCount) {
        maxCount = tickerCounts[t];
        mostSearchedTicker = t;
      }
    });

    return res.status(200).json({
      success: true,
      loginLogs,
      searchLogs,
      aiAnalysisLogs,
      aiUsageLogs,
      securityEvents: security.events,
      securitySummary: security.summary,
      securityStatus: Object.assign(
        securityGuard.getPublicStatus(),
        { available: security.available, reason: security.reason }
      ),
      summary: {
        totalLogins,
        totalSearches,
        totalAIAnalyses,
        mostSearchedTicker
      }
    });
  } catch (e) {
    console.error('admin-logs exception:', e);
    return res.status(200).json({ success: false, error: 'Gagal memuat data log.' });
  }
};
