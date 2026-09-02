const { createClient } = require('@supabase/supabase-js');
const { requireAdminSession, isSameOrigin } = require('../lib/admin-session');
const { parseMaintenanceValue } = require('../lib/maintenance-state');

function firstRow(data) {
  if (Array.isArray(data)) return data[0] || null;
  return data || null;
}

async function readAdminCodeState(supabase, maintenanceEnabled) {
  if (!maintenanceEnabled) {
    return { available: true, active: false, expiresAt: null };
  }
  try {
    const result = await supabase.rpc('get_admin_maintenance_code_status');
    if (result.error) return { available: false, active: false, expiresAt: null };
    const row = firstRow(result.data) || {};
    return {
      available: true,
      active: row.active === true,
      expiresAt: row.expires_at || null
    };
  } catch (_) {
    return { available: false, active: false, expiresAt: null };
  }
}

async function readMaintenanceConfig(supabase) {
  const result = await supabase
    .from('app_settings')
    .select('value')
    .eq('key', 'maintenance_config')
    .maybeSingle();
  if (result.error) return { error: result.error, parsed: null };
  if (!result.data) {
    return {
      error: null,
      parsed: {
        enabled: false,
        config: {
          maintenanceMode: false,
          message: 'Auto-Cuan sedang tidak dapat diakses sementara.',
          updatedBy: null,
          updatedAt: null
        }
      }
    };
  }
  return { error: null, parsed: parseMaintenanceValue(result.data.value) };
}

async function readWatchSnapshot(supabase) {
  // The maintenance flag and active-code state are independent reads, so run
  // them in parallel. This removes one full database round-trip from the
  // browser's live-watch critical path while still failing closed if maintenance
  // is off or cannot be established.
  const results = await Promise.all([
    readMaintenanceConfig(supabase),
    readAdminCodeState(supabase, true)
  ]);
  const settings = results[0];
  const code = results[1];

  if (settings.error || !settings.parsed) {
    return { available: false, maintenanceMode: false, adminCode: { available: false, active: false, expiresAt: null } };
  }

  const maintenanceMode = settings.parsed.enabled === true;
  return {
    available: true,
    maintenanceMode,
    adminCode: {
      available: code.available === true,
      active: maintenanceMode && code.active === true,
      expiresAt: maintenanceMode && code.active === true ? code.expiresAt : null
    }
  };
}

module.exports = async function handler(req, res) {
  if (req.method !== 'POST') {
    return res.status(405).json({ success: false, error: 'Method not allowed' });
  }

  try {
    const { action, config } = req.body || {};

    const SUPABASE_URL = process.env.SUPABASE_URL;
    const SUPABASE_KEY = process.env.SUPABASE_SERVICE_ROLE_KEY;

    if (!SUPABASE_URL || !SUPABASE_KEY) {
      return res.status(500).json({ success: false, error: 'Database belum dikonfigurasi.' });
    }

    const supabase = createClient(SUPABASE_URL, SUPABASE_KEY, {
      auth: { persistSession: false, autoRefreshToken: false }
    });

    // Lightweight live-watch path used only by the already-visible maintenance
    // screen. It keeps the same endpoint as the canonical maintenance state but
    // parallelizes the two DB reads to reduce visible /akses latency.
    if (action === 'watch-admin-code') {
      res.setHeader('Cache-Control', 'private, no-store');
      const snapshot = await readWatchSnapshot(supabase);
      if (!snapshot.available) {
        return res.status(200).json({
          success: false,
          maintenanceMode: false,
          adminCode: { available: false, active: false, expiresAt: null }
        });
      }
      return res.status(200).json({
        success: true,
        maintenanceMode: snapshot.maintenanceMode,
        adminCode: snapshot.adminCode
      });
    }

    // === GET ===
    if (action === 'get') {
      const state = await readMaintenanceConfig(supabase);
      const error = state.error;

      if (error) {
        if (error.code === '42P01' || (error.message && error.message.includes('does not exist'))) {
          return res.status(200).json({ success: false, error: 'Table app_settings belum dibuat di Supabase.' });
        }
        console.error('maintenance-settings get error:', error);
        return res.status(200).json({ success: false, error: 'Gagal memuat pengaturan.' });
      }

      const parsed = state.parsed;
      const configValue = parsed.config || {};
      const adminCode = await readAdminCodeState(supabase, parsed.enabled);

      return res.status(200).json({ success: true, config: configValue, adminCode });
    }

    // === SAVE === (write op: server-signed admin session required; adminName ignored)
    if (action === 'save') {
      if (!isSameOrigin(req)) {
        return res.status(403).json({ success: false, error: 'Permintaan ditolak.' });
      }
      const auth = requireAdminSession(req);
      if (!auth.ok) {
        return res.status(auth.status).json({ success: false, error: auth.error });
      }

      if (!config || typeof config !== 'object') {
        return res.status(400).json({ success: false, error: 'Config tidak valid.' });
      }

      const configToSave = {
        maintenanceMode: Boolean(config.maintenanceMode),
        geminiAiEnabled: config.geminiAiEnabled !== false,
        message: String(config.message || 'Auto-Cuan sedang tidak dapat diakses sementara.').slice(0, 500),
        updatedBy: auth.session.un || 'admin',
        updatedAt: new Date().toISOString()
      };

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
        return res.status(500).json({ success: false, error: 'Gagal menyimpan pengaturan.' });
      }

      return res.status(200).json({ success: true, config: configToSave });
    }

    return res.status(400).json({ success: false, error: 'Action tidak dikenal: ' + action });

  } catch (e) {
    console.error('maintenance-settings exception:', e);
    return res.status(500).json({ success: false, error: 'Server error. Silakan coba lagi.' });
  }
};

module.exports.__test = { firstRow, readAdminCodeState, readMaintenanceConfig, readWatchSnapshot };
