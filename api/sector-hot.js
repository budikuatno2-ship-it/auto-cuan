const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  if (req.method !== 'GET') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(200).json({ success: false, error: 'Database belum dikonfigurasi.' });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    const groupCode = req.query.group || null;

    // === DETAIL MODE: single group + members ===
    if (groupCode) {
      const code = String(groupCode).toUpperCase().trim();

      // Fetch group summary from cache
      const { data: groupData, error: groupErr } = await supabase
        .from('sector_hot_latest')
        .select('*')
        .eq('group_code', code)
        .maybeSingle();

      if (groupErr) {
        console.error('sector-hot group error:', groupErr);
        return res.status(200).json({ success: false, error: 'Gagal memuat data grup.' });
      }

      // Fetch members from cache, joined with mapping for sort_order
      const { data: membersData, error: membersErr } = await supabase
        .from('sector_hot_members_latest')
        .select('*')
        .eq('group_code', code)
        .order('calculated_at', { ascending: false });

      if (membersErr) {
        console.error('sector-hot members error:', membersErr);
        return res.status(200).json({ success: false, error: 'Gagal memuat data member.' });
      }

      // Get sort_order from mapping table for ordering
      const { data: mappingData } = await supabase
        .from('sector_hot_group_members')
        .select('ticker, sort_order')
        .eq('group_code', code)
        .eq('is_active', true)
        .order('sort_order', { ascending: true });

      // Build sort map
      const sortMap = {};
      if (mappingData) {
        mappingData.forEach(function(m) { sortMap[m.ticker] = m.sort_order; });
      }

      // Sort members by mapping sort_order
      const sortedMembers = (membersData || []).sort(function(a, b) {
        const sa = sortMap[a.ticker] != null ? sortMap[a.ticker] : 999;
        const sb = sortMap[b.ticker] != null ? sortMap[b.ticker] : 999;
        return sa - sb;
      });

      return res.status(200).json({
        success: true,
        group: groupData || null,
        members: sortedMembers
      });
    }

    // === LIST MODE: all groups summary + meta ===

    // Fetch meta
    const { data: metaData } = await supabase
      .from('sector_hot_meta')
      .select('*')
      .eq('id', 'latest')
      .maybeSingle();

    // Fetch all group summaries from cache
    const { data: groupsData, error: groupsErr } = await supabase
      .from('sector_hot_latest')
      .select('*')
      .order('avg_change_pct', { ascending: false });

    if (groupsErr) {
      console.error('sector-hot list error:', groupsErr);
      return res.status(200).json({
        success: false,
        error: 'Gagal memuat data sektor.'
      });
    }

    // Secondary sort: avg_volume_ratio desc, then group_name asc for ties
    const groups = (groupsData || []).sort(function(a, b) {
      const aChg = a.avg_change_pct != null ? a.avg_change_pct : -9999;
      const bChg = b.avg_change_pct != null ? b.avg_change_pct : -9999;
      if (bChg !== aChg) return bChg - aChg;
      const aVol = a.avg_volume_ratio != null ? a.avg_volume_ratio : 0;
      const bVol = b.avg_volume_ratio != null ? b.avg_volume_ratio : 0;
      if (bVol !== aVol) return bVol - aVol;
      return (a.group_name || '').localeCompare(b.group_name || '');
    });

    return res.status(200).json({
      success: true,
      meta: metaData || { calculated_at: null, status: 'pending', message: 'Awaiting first calculation.', scanned_count: 0, failed_count: 0 },
      groups: groups
    });

  } catch (e) {
    console.error('sector-hot exception:', e);
    return res.status(200).json({ success: false, error: 'Terjadi kesalahan: ' + e.message });
  }
};
