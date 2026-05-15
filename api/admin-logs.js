module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ error: 'Method not allowed' });
  }

  try {
    const type = req.query.type || 'login';

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(200).json({ logs: [], error: 'Database logging belum dikonfigurasi.' });
    }

    const tableMap = {
      login: 'login_logs',
      search: 'search_logs',
      analysis: 'ai_analysis_logs',
      usage: 'ai_usage_logs'
    };

    const table = tableMap[type] || 'login_logs';

    const response = await fetch(
      `${SUPABASE_URL}/rest/v1/${table}?order=timestamp.desc&limit=50`,
      {
        method: 'GET',
        headers: {
          'apikey': SUPABASE_KEY,
          'Authorization': `Bearer ${SUPABASE_KEY}`,
          'Content-Type': 'application/json'
        }
      }
    );

    if (!response.ok) {
      return res.status(200).json({ logs: [], error: 'Database query failed.' });
    }

    const data = await response.json();
    return res.status(200).json({ logs: data || [] });

  } catch (e) {
    return res.status(200).json({ logs: [], error: 'Database logging belum dikonfigurasi.' });
  }
}
