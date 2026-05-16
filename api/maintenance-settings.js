const { createClient } = require('@supabase/supabase-js');

const DEFAULT_CONFIG = {
  maintenanceMode: false,
  message: "Auto-Cuan sedang tidak dapat diakses sementara.",
  updatedBy: "system",
  updatedAt: new Date().toISOString()
};

// Backward compatibility: convert old format to new
function normalizeConfig(raw) {
  if (!raw || typeof raw !== 'object') return DEFAULT_CONFIG;
  // If old format with manualMaintenance/emergencyLock
  if ('manualMaintenance' in raw || 'emergencyLock' in raw) {
    return {
      maintenanceMode: Boolean(raw.manualMaintenance) || Boolean(raw.emergencyLock),
      message: raw.message || DEFAULT_CONFIG.message,
      updatedBy: raw.updatedBy || 'system',
      updatedAt: raw.updatedAt || new Date().toISOString()
    };
  }
  // New format
  return {
    maintenanceMode: Boolean(raw.maintenanceMode),
    message: raw.message || DEFAULT_CONFIG.message,
    updatedBy: raw.updatedBy || 'system',
    updatedAt: raw.updatedAt || new Date().toISOString()
  };
}

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

      return res.status(200).json({ success: true, config: normalizeConfig(data.value) });
    }

    // === ACTION: SAVE ===
    if (action === 'save') {
      if (!adminName || adminName.trim().toLowerCase() !== 'budi') {
        return res.status(403).json({ success: false, error: 'Unauthorized' });
      }

      if (!config || typeof config !== 'object') {
        return res.status(400).json({ success: false, error: 'Config tidak valid.' });
      }

      const sanitizedConfig = {
        maintenanceMode: Boolean(config.maintenanceMode),
        message: String(config.message || DEFAULT_CONFIG.message).slice(0, 500),
        updatedBy: 'budi',
        updatedAt: new Date().toISOString()
      };

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
