'use strict';

function parseMaintenanceValue(value) {
  let parsed = value;
  if (typeof parsed === 'string') {
    try { parsed = JSON.parse(parsed); } catch (_) { parsed = null; }
  }
  if (!parsed || typeof parsed !== 'object') return { enabled: false, config: null };
  return { enabled: parsed.maintenanceMode === true, config: parsed };
}

async function readMaintenanceState(db) {
  if (!db || typeof db.from !== 'function') return { available: false, enabled: false, config: null };
  try {
    const result = await db
      .from('app_settings')
      .select('value')
      .eq('key', 'maintenance_config')
      .maybeSingle();
    if (result && result.error) return { available: false, enabled: false, config: null };
    if (!result || !result.data) return { available: true, enabled: false, config: null };
    const parsed = parseMaintenanceValue(result.data.value);
    return { available: true, enabled: parsed.enabled, config: parsed.config };
  } catch (_) {
    return { available: false, enabled: false, config: null };
  }
}

module.exports = {
  parseMaintenanceValue,
  readMaintenanceState
};
