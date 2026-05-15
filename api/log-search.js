export default async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const { ticker, currentPrice, username, timestamp } = req.body || {};

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(200).json({ ok: true, logged: false });
    }

    await fetch(`${SUPABASE_URL}/rest/v1/search_logs`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'apikey': SUPABASE_KEY,
        'Authorization': `Bearer ${SUPABASE_KEY}`,
        'Prefer': 'return=minimal'
      },
      body: JSON.stringify({
        ticker: ticker || '',
        current_price: currentPrice || 0,
        username: username || 'unknown',
        timestamp: timestamp || new Date().toISOString()
      })
    });

    return res.status(200).json({ ok: true, logged: true });
  } catch (e) {
    return res.status(200).json({ ok: true, logged: false });
  }
}
