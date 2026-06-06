/**
 * GET /api/auth-config
 * Returns ONLY the public Supabase URL and anon key for frontend auth.
 * NEVER exposes SUPABASE_SERVICE_ROLE_KEY.
 */
module.exports = function handler(req, res) {
  // Allow GET and POST
  if (req.method !== 'GET' && req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  const url = process.env.SUPABASE_URL || '';
  const anonKey = process.env.SUPABASE_ANON_KEY || '';

  if (!url || !anonKey) {
    return res.status(200).json({ url: '', anonKey: '', configured: false });
  }

  return res.status(200).json({ url: url, anonKey: anonKey, configured: true });
};
