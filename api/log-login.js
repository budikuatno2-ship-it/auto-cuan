const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const { username, isGuest, isAdmin, userAgent } = req.body || {};

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(200).json({ success: false, error: 'Database logging belum dikonfigurasi.' });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    const { data, error } = await supabase
      .from('login_logs')
      .insert({
        username: username || 'unknown',
        is_guest: Boolean(isGuest),
        is_admin: Boolean(isAdmin),
        user_agent: userAgent || ''
      })
      .select();

    if (error) {
      console.error('log-login insert error:', error);
      return res.status(200).json({ success: false, error: error.message });
    }

    return res.status(200).json({ success: true, data });
  } catch (e) {
    console.error('log-login exception:', e);
    return res.status(200).json({ success: false, error: e.message });
  }
};
