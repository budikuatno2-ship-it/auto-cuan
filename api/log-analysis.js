const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const { username, ticker, mode, resultSummary, fullResultHtml } = req.body || {};

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(200).json({ success: false, error: 'Database logging belum dikonfigurasi.' });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    const { data, error } = await supabase
      .from('ai_analysis_logs')
      .insert({
        username: username || 'unknown',
        ticker: (ticker || '').toUpperCase(),
        mode: mode || '',
        result_summary: resultSummary || '',
        full_result_html: fullResultHtml || ''
      })
      .select();

    if (error) {
      console.error('log-analysis insert error:', error);
      return res.status(200).json({ success: false, error: error.message });
    }

    return res.status(200).json({ success: true, data });
  } catch (e) {
    console.error('log-analysis exception:', e);
    return res.status(200).json({ success: false, error: e.message });
  }
};
