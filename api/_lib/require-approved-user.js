/**
 * Backend helper: Verify authenticated user and check approval status.
 * 
 * Usage in any API route:
 *   const { requireApprovedUser } = require('./_lib/require-approved-user');
 *   
 *   module.exports = async function handler(req, res) {
 *     const { user, profile, error } = await requireApprovedUser(req, res);
 *     if (error) return; // response already sent (401 or 403)
 *     // user is authenticated and approved — proceed
 *   };
 * 
 * Behavior:
 *   - No token / invalid token → 401 Unauthorized
 *   - Valid user but not approved → 403 Forbidden
 *   - Approved user → returns { user, profile }
 * 
 * Important:
 *   - Uses SUPABASE_URL and SUPABASE_SERVICE_ROLE_KEY (server-side only)
 *   - Reads Bearer token from Authorization header (Supabase Auth access_token)
 *   - Service role reads profiles table to check is_approved
 */

const { createClient } = require('@supabase/supabase-js');

/**
 * Verify the user's Supabase Auth token and check approval status.
 * @param {object} req - Vercel/Express request object
 * @param {object} res - Vercel/Express response object
 * @returns {object} { user, profile, error }
 *   - If error is true, the response has already been sent (401/403)
 *   - If error is false, user and profile are available
 */
async function requireApprovedUser(req, res) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    res.status(500).json({ success: false, error: 'Auth belum dikonfigurasi.' });
    return { user: null, profile: null, error: true };
  }

  // Extract Bearer token from Authorization header
  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

  if (!token) {
    res.status(401).json({ success: false, error: 'Token tidak ditemukan. Silakan login.' });
    return { user: null, profile: null, error: true };
  }

  // Create Supabase client with service_role to verify token and read profiles
  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  // Verify the access token and get user
  const { data: userData, error: userError } = await supabase.auth.getUser(token);

  if (userError || !userData || !userData.user) {
    res.status(401).json({ success: false, error: 'Token tidak valid atau sudah expired. Silakan login ulang.' });
    return { user: null, profile: null, error: true };
  }

  const user = userData.user;

  // Read profile to check approval status
  const { data: profile, error: profileError } = await supabase
    .from('profiles')
    .select('id, email, full_name, is_approved, role, created_at, updated_at')
    .eq('id', user.id)
    .maybeSingle();

  if (profileError) {
    console.error('requireApprovedUser profile error:', profileError);
    res.status(500).json({ success: false, error: 'Gagal memeriksa profil user.' });
    return { user: null, profile: null, error: true };
  }

  if (!profile) {
    res.status(403).json({ success: false, error: 'Profil belum dibuat. Hubungi admin.' });
    return { user: null, profile: null, error: true };
  }

  if (!profile.is_approved) {
    res.status(403).json({ success: false, error: 'Akun belum di-approve. Tunggu approval admin.' });
    return { user, profile, error: true };
  }

  // User is authenticated and approved
  return { user, profile, error: false };
}

/**
 * Lighter version: only verify auth (no approval check).
 * Use for endpoints that need auth but not approval.
 */
async function requireAuthUser(req, res) {
  const SUPABASE_URL = process.env.SUPABASE_URL;
  const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    res.status(500).json({ success: false, error: 'Auth belum dikonfigurasi.' });
    return { user: null, error: true };
  }

  const authHeader = req.headers.authorization || req.headers.Authorization || '';
  const token = authHeader.startsWith('Bearer ') ? authHeader.slice(7).trim() : '';

  if (!token) {
    res.status(401).json({ success: false, error: 'Token tidak ditemukan. Silakan login.' });
    return { user: null, error: true };
  }

  const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });

  const { data: userData, error: userError } = await supabase.auth.getUser(token);

  if (userError || !userData || !userData.user) {
    res.status(401).json({ success: false, error: 'Token tidak valid atau sudah expired.' });
    return { user: null, error: true };
  }

  return { user: userData.user, error: false };
}

module.exports = { requireApprovedUser, requireAuthUser };
