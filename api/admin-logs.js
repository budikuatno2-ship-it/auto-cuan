const SUPABASE_URL = process.env.SUPABASE_URL;
const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

export default async function handler(req, res) {
  if (req.method !== 'GET') return res.status(405).json({ error: 'Method not allowed' });

  if (!SUPABASE_URL || !SUPABASE_KEY) {
    return res.status(200).json({ configured: false, message: 'Database logging belum dikonfigurasi.' });
  }

  try {
    const limit = 20;

    const [loginRes, searchRes, analysisRes, usageRes] = await Promise.all([
      fetch(`${SUPABASE_URL}/rest/v1/login_logs?order=created_at.desc&limit=${limit}`, {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
      }),
      fetch(`${SUPABASE_URL}/rest/v1/search_logs?order=created_at.desc&limit=${limit}`, {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
      }),
      fetch(`${SUPABASE_URL}/rest/v1/ai_analysis_logs?order=created_at.desc&limit=${limit}`, {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
      }),
      fetch(`${SUPABASE_URL}/rest/v1/ai_usage_logs?order=created_at.desc&limit=${limit}`, {
        headers: { 'apikey': SUPABASE_KEY, 'Authorization': `Bearer ${SUPABASE_KEY}` }
      })
    ]);

    const logins = loginRes.ok ? await loginRes.json() : [];
    const searches = searchRes.ok ? await searchRes.json() : [];
    const analyses = analysisRes.ok ? await analysisRes.json() : [];
    const usages = usageRes.ok ? await usageRes.json() : [];

    return res.status(200).json({
      configured: true,
      logins,
      searches,
      analyses,
      usages
    });
  } catch (e) {
    return res.status(200).json({ configured: false, message: e.message });
  }
}
