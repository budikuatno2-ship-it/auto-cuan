const { createClient } = require('@supabase/supabase-js');

// Bad name filter - strong normalization
function normalizeNameForCheck(name) {
  return String(name || "").trim().toLowerCase().normalize("NFD").replace(/[\u0300-\u036f]/g, "")
    .replace(/[@]/g, "a").replace(/[4]/g, "a").replace(/[!1|]/g, "i").replace(/[0]/g, "o")
    .replace(/[3]/g, "e").replace(/[5]/g, "s").replace(/[7]/g, "t").replace(/\$/g, "s")
    .replace(/\s+/g, "").replace(/[^a-z0-9]/g, "");
}
const BAD_NAMES = ["anjing","anjir","anjay","asu","asw","babi","babik","bangsat","bangsad","bajingan","brengsek","kampret","keparat","laknat","sialan","goblok","goblog","tolol","kontol","kntl","memek","mmk","ngentot","ngntot","ngewe","perek","lonte","jancok","jancuk","mampus","modar","ajg","anjg","bgst","bgsd","gblk","bbi","bbai","babiq","babii","b4bi","kont0l","ngent0t"];
function isBadUsername(name) {
  if (!name) return false;
  var clean = normalizeNameForCheck(name);
  if (!clean || clean.length < 2) return false;
  return BAD_NAMES.some(function(word) { return clean.includes(normalizeNameForCheck(word)); });
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
