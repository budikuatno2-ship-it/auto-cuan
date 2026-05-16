const { createClient } = require('@supabase/supabase-js');

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const { adminName, action, config } = req.body || {};

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(500).json({ success: false, error: 'Database belum dikonfigurasi.' });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    // === GET ===
    if (action === 'get') {
      const { data, error } = await supabase
        .from('app_settings')
        .select('value')
        .eq('key', 'maintenance_config')
        .maybeSingle();

      if (error) {
        if (error.code === '42P01' || (error.message && error.message.includes('does not exist'))) {
          return res.status(200).json({ success: false, error: 'Table app_settings belum dibuat di Supabase.' });
        }
        console.error('maintenance-settings get error:', error);
        return res.status(200).json({ success: false, error: 'Gagal memuat pengaturan: ' + error.message });
      }

      if (!data) {
        // Return default config
        return res.status(200).json({
          success: true,
          config: {
            maintenanceMode: false,
            message: 'Auto-Cuan sedang tidak dapat diakses sementara.',
            updatedBy: null,
            updatedAt: null
          }
        });
      }

      let configValue = data.value;
      if (typeof configValue === 'string') {
        try { configValue = JSON.parse(configValue); } catch(e) { configValue = {}; }
      }

      return res.status(200).json({ success: true, config: configValue });
    }

    // === SAVE ===
    if (action === 'save') {
      // Only budi can save
      if (!adminName || String(adminName).trim().toLowerCase() !== 'budi') {
        return res.status(403).json({ success: false, error: 'Unauthorized. Admin only.' });
      }

      if (!config || typeof config !== 'object') {
        return res.status(400).json({ success: false, error: 'Config tidak valid.' });
      }

      const configToSave = {
        maintenanceMode: Boolean(config.maintenanceMode),
        message: String(config.message || 'Auto-Cuan sedang tidak dapat diakses sementara.').slice(0, 500),
        updatedBy: 'budi',
        updatedAt: new Date().toISOString()
      };

      // Upsert: try update first, then insert if not exists
      const { data: existing } = await supabase
        .from('app_settings')
        .select('key')
        .eq('key', 'maintenance_config')
        .maybeSingle();

      let error;
      if (existing) {
        const result = await supabase
          .from('app_settings')
          .update({ value: configToSave })
          .eq('key', 'maintenance_config');
        error = result.error;
      } else {
        const result = await supabase
          .from('app_settings')
          .insert({ key: 'maintenance_config', value: configToSave });
        error = result.error;
      }

      if (error) {
        if (error.code === '42P01' || (error.message && error.message.includes('does not exist'))) {
          return res.status(200).json({ success: false, error: 'Table app_settings belum dibuat di Supabase.' });
        }
        console.error('maintenance-settings save error:', error);
        return res.status(500).json({ success: false, error: 'Gagal menyimpan pengaturan: ' + error.message });
      }

      return res.status(200).json({ success: true, config: configToSave });
    }

    return res.status(400).json({ success: false, error: 'Action tidak dikenal: ' + action });

  } catch (e) {
    console.error('maintenance-settings exception:', e);
    return res.status(500).json({ success: false, error: 'Server error: ' + e.message });
  }
};
