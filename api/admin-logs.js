const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const { adminName } = req.body || {};

    if (!adminName || adminName.trim().toLowerCase() !== 'budi') {
      return res.status(403).json({ success: false, error: 'Unauthorized. Admin only.' });
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(200).json({ success: false, error: 'Database logging belum dikonfigurasi.' });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false },
      realtime: { autoConnect: false }
    });

    // Fetch all 4 tables
    const [loginRes, searchRes, analysisRes, usageRes] = await Promise.all([
      supabase.from('login_logs').select('*').order('created_at', { ascending: false }).limit(50),
      supabase.from('search_logs').select('*').order('created_at', { ascending: false }).limit(100),
      supabase.from('ai_analysis_logs').select('id, username, ticker, mode, result_summary, created_at').order('created_at', { ascending: false }).limit(50),
      supabase.from('ai_usage_logs').select('*').order('created_at', { ascending: false }).limit(100)
    ]);

    if (loginRes.error || searchRes.error || analysisRes.error || usageRes.error) {
      const err = loginRes.error || searchRes.error || analysisRes.error || usageRes.error;
      console.error('admin-logs fetch error:', err);
      return res.status(200).json({ success: false, error: 'Database query failed: ' + err.message });
    }

    const loginLogs = loginRes.data || [];
    const searchLogs = searchRes.data || [];
    const aiAnalysisLogs = analysisRes.data || [];
    const aiUsageLogs = usageRes.data || [];

    // Build summary
    const totalLogins = loginLogs.length;
    const totalSearches = searchLogs.length;
    const totalAIAnalyses = aiAnalysisLogs.length;

    // Most searched ticker
    const tickerCounts = {};
    searchLogs.forEach(function(row) {
      if (row.ticker) {
        tickerCounts[row.ticker] = (tickerCounts[row.ticker] || 0) + 1;
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
      summary: {
        totalLogins,
        totalSearches,
        totalAIAnalyses,
        mostSearchedTicker
      }
    });
  } catch (e) {
    console.error('admin-logs exception:', e);
    return res.status(200).json({ success: false, error: 'Database logging belum dikonfigurasi.' });
  }
};
