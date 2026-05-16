const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const body = req.body || {};
    const { action } = body;

    if (!action) {
      return res.status(400).json({ success: false, error: 'Missing action parameter' });
    }

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(200).json({ success: false, error: 'Database logging belum dikonfigurasi.' });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    let table, insertData;

    switch (action) {
      case 'login': {
        const { username, isGuest, isAdmin, userAgent } = body;
        table = 'login_logs';
        insertData = {
          username: username || 'unknown',
          is_guest: Boolean(isGuest),
          is_admin: Boolean(isAdmin),
          user_agent: userAgent || ''
        };
        break;
      }
      case 'search': {
        const { username, ticker, source } = body;
        table = 'search_logs';
        insertData = {
          username: username || 'unknown',
          ticker: (ticker || '').toUpperCase(),
          source: source || ''
        };
        break;
      }
      case 'analysis': {
        const { username, ticker, mode, resultSummary, fullResultHtml } = body;
        table = 'ai_analysis_logs';
        insertData = {
          username: username || 'unknown',
          ticker: (ticker || '').toUpperCase(),
          mode: mode || '',
          result_summary: resultSummary || '',
          full_result_html: fullResultHtml || ''
        };
        break;
      }
      case 'usage': {
        const { username, ticker, usageAction } = body;
        table = 'ai_usage_logs';
        insertData = {
          username: username || 'unknown',
          ticker: (ticker || '').toUpperCase(),
          action: usageAction || ''
        };
        break;
      }
      default:
        return res.status(400).json({ success: false, error: `Unknown action: ${action}` });
    }

    const { data, error } = await supabase
      .from(table)
      .insert(insertData)
      .select();

    if (error) {
      console.error(`log [${action}] insert error:`, error);
      return res.status(200).json({ success: false, error: error.message });
    }

    return res.status(200).json({ success: true, data });
  } catch (e) {
    console.error('log exception:', e);
    return res.status(200).json({ success: false, error: e.message });
  }
};
