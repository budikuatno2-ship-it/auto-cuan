const { createClient } = require('@supabase/supabase-js');

// Bad name filter - do not store offensive usernames
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
    const { username, isGuest, isAdmin, userAgent } = req.body || {};

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(200).json({ success: false, error: 'Database logging belum dikonfigurasi.' });
    }

    // Sanitize username
    const cleanUsername = String(username || 'unknown').trim().slice(0, 30);

    // Block bad usernames from being stored
    if (isBadUsername(cleanUsername)) {
      const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);
      await supabase.from('login_logs').insert({
        username: 'username_blocked',
        is_guest: Boolean(isGuest),
        is_admin: false,
        user_agent: String(userAgent || '').slice(0, 500)
      });
      return res.status(200).json({ success: true });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    const { data, error } = await supabase
      .from('login_logs')
      .insert({
        username: cleanUsername,
        is_guest: Boolean(isGuest),
        is_admin: Boolean(isAdmin),
        user_agent: String(userAgent || '').slice(0, 500)
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
