const { createClient } = require('@supabase/supabase-js');

const DEFAULT_CONFIG = {
  manualMaintenance: false,
  emergencyLock: false,
  message: "Auto-Cuan sedang tidak dapat diakses sementara.",
  updatedBy: "system",
  updatedAt: new Date().toISOString()
};

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const { adminName, action, config } = req.body || {};

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(200).json({
        success: false,
        error: "Database maintenance settings belum dikonfigurasi.",
        config: DEFAULT_CONFIG
      });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY);

    // === ACTION: GET ===
    if (action === 'get') {
      const { data, error } = await supabase
        .from('app_settings')
        .select('value')
        .eq('key', 'maintenance_config')
        .single();

      if (error || !data) {
        return res.status(200).json({ success: true, config: DEFAULT_CONFIG });
      }

      return res.status(200).json({ success: true, config: data.value || DEFAULT_CONFIG });
    }

    // === ACTION: SAVE ===
    if (action === 'save') {
      // Backend admin validation - only budi can save
      if (!adminName || adminName.trim().toLowerCase() !== 'budi') {
        return res.status(403).json({ success: false, error: 'Unauthorized' });
      }

      // Validate config object
      if (!config || typeof config !== 'object') {
        return res.status(400).json({ success: false, error: 'Config tidak valid.' });
      }

      // Sanitize config values
      const sanitizedConfig = {
        manualMaintenance: Boolean(config.manualMaintenance),
        emergencyLock: Boolean(config.emergencyLock),
        message: String(config.message || DEFAULT_CONFIG.message).slice(0, 500),
        updatedBy: 'budi',
        updatedAt: new Date().toISOString()
      };

      // Upsert into app_settings
      const { data, error } = await supabase
        .from('app_settings')
        .upsert({
          key: 'maintenance_config',
          value: sanitizedConfig,
          updated_at: new Date().toISOString()
        }, { onConflict: 'key' })
        .select();

      if (error) {
        console.error('maintenance-settings save error:', error);
        return res.status(200).json({ success: false, error: 'Gagal menyimpan: ' + error.message });
      }

      return res.status(200).json({ success: true, config: sanitizedConfig });
    }

    return res.status(400).json({ success: false, error: 'Action tidak valid. Gunakan "get" atau "save".' });

  } catch (e) {
    console.error('maintenance-settings exception:', e);
    return res.status(200).json({
      success: false,
      error: 'Server error: ' + e.message,
      config: DEFAULT_CONFIG
    });
  }
};
