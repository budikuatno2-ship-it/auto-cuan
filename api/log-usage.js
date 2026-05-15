const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  if (req.method !== 'POST') return res.status(405).json({ error: 'Method not allowed' });

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(200).json({ ok: true, logged: false, reason: 'not_configured' });
  }

  try {
    const { username, event, detail } = req.body || {};
    await fetch(`${SUPABASE_URL}/rest/v1/ai_usage_logs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        username: username || 'unknown',
        event: event || 'limit_reached',
        detail: detail || '',
        created_at: new Date().toISOString()
      })
    });
    return res.status(200).json({ ok: true, logged: true });
  } catch (e) {
    return res.status(200).json({ ok: true, logged: false, reason: e.message });
  }
}
