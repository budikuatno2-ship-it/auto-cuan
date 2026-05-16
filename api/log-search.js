const { createClient } = require('@supabase/supabase-js');

// Bad name filter
const BAD_NAMES = ['admin', 'root', 'hack', 'inject', 'script', 'drop', 'delete'];
function isBadUsername(name) {
  if (!name) return false;
  const lower = name.toLowerCase();
  return BAD_NAMES.some(bad => lower.includes(bad));
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const { username, ticker, source } = req.body || {};

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(200).json({ success: false, error: 'Database logging belum dikonfigurasi.' });
    }

    // Sanitize inputs
    const cleanUsername = String(username || 'unknown').trim().slice(0, 30);
    const cleanTicker = String(ticker || '').toUpperCase().replace(/[^A-Z0-9_]/g, '').slice(0, 10);
    const allowedSources = ['ticker', 'chart_upload', 'chart_page', 'portfolio', 'watchlist', 'ticker_mode'];
    const cleanSource = allowedSources.includes(source) ? source : '';

    // Block bad usernames
    if (isBadUsername(cleanUsername)) {
      return res.status(200).json({ success: true });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    const { data, error } = await supabase
      .from('search_logs')
      .insert({
        username: cleanUsername,
        ticker: cleanTicker,
        source: cleanSource
      })
      .select();

    if (error) {
      console.error('log-search insert error:', error);
      return res.status(200).json({ success: false, error: error.message });
    }

    return res.status(200).json({ success: true, data });
  } catch (e) {
    console.error('log-search exception:', e);
    return res.status(200).json({ success: false, error: e.message });
  }
};
