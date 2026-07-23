'use strict';

// Server-only catalog input and event metadata boundary.  Browser values are
// deliberately treated as untrusted suggestions, never as authority.
const EVENT_FIELDS = {
  plan_price_version_published: ['plan_code', 'previous_price_version', 'new_price_version', 'previous_normal_price_idr', 'new_normal_price_idr', 'previous_promo_price_idr', 'new_promo_price_idr', 'previous_promo_enabled', 'new_promo_enabled', 'promo_starts_at', 'promo_ends_at', 'change_reason'],
  plan_promo_enabled: ['plan_code', 'previous_price_version', 'new_price_version', 'previous_promo_enabled', 'new_promo_enabled', 'promo_starts_at', 'promo_ends_at', 'change_reason'],
  plan_promo_disabled: ['plan_code', 'previous_price_version', 'new_price_version', 'previous_promo_enabled', 'new_promo_enabled', 'change_reason']
};
const TYPES = { plan_code: 'string', change_reason: 'string', promo_starts_at: 'string', promo_ends_at: 'string', previous_price_version: 'number', new_price_version: 'number', previous_normal_price_idr: 'number', new_normal_price_idr: 'number', previous_promo_price_idr: 'number', new_promo_price_idr: 'number', previous_promo_enabled: 'boolean', new_promo_enabled: 'boolean' };

function positiveInteger(value, name) {
  if (typeof value === 'number') value = String(value);
  if (typeof value !== 'string' || !/^[1-9][0-9]*$/.test(value)) throw new Error(name + ' harus bilangan bulat positif.');
  const n = Number(value);
  if (!Number.isSafeInteger(n)) throw new Error(name + ' tidak aman.');
  return n;
}
function iso(value, name, nullable) {
  if (value == null || value === '') { if (nullable) return null; throw new Error(name + ' diperlukan.'); }
  if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}T/.test(value) || !Number.isFinite(Date.parse(value))) throw new Error(name + ' tidak valid.');
  return new Date(value).toISOString();
}
function validatePriceInput(input) {
  input = input || {};
  const normal = positiveInteger(input.normal_price_idr, 'Harga normal');
  const enabled = input.promo_enabled === true;
  const promo = input.promo_price_idr == null || input.promo_price_idr === '' ? null : positiveInteger(input.promo_price_idr, 'Harga promo');
  const starts = iso(input.promo_starts_at, 'Mulai promo', !enabled);
  const ends = iso(input.promo_ends_at, 'Akhir promo', true);
  if (enabled && (promo == null || !starts)) throw new Error('Promo aktif memerlukan harga dan waktu mulai.');
  if (ends && (!starts || Date.parse(ends) <= Date.parse(starts))) throw new Error('Akhir promo harus setelah waktu mulai.');
  const reason = String(input.change_reason || '').trim().replace(/[\r\n\t]+/g, ' ').slice(0, 240);
  if (!reason) throw new Error('Alasan perubahan diperlukan.');
  return { normal_price_idr: normal, promo_price_idr: enabled ? promo : null, promo_enabled: enabled, promo_starts_at: enabled ? starts : null, promo_ends_at: enabled ? ends : null, change_reason: reason };
}
function sanitizeEventMetadata(type, metadata) {
  const allowed = EVENT_FIELDS[type]; if (!allowed) throw new Error('Jenis event katalog tidak valid.');
  const out = {};
  allowed.forEach(function (key) { const value = metadata && metadata[key]; if (value == null) return; if (TYPES[key] === 'number' && Number.isSafeInteger(value)) out[key] = value; else if (TYPES[key] === 'boolean' && typeof value === 'boolean') out[key] = value; else if (TYPES[key] === 'string' && typeof value === 'string') out[key] = value.slice(0, key === 'change_reason' ? 240 : 80); });
  return out;
}
function safePrice(row) { return { normal_price_idr: row.normal_price_idr, promo_price_idr: row.promo_price_idr, promo_enabled: row.promo_enabled === true, promo_starts_at: row.promo_starts_at || null, promo_ends_at: row.promo_ends_at || null, price_version: row.price_version, created_at: row.created_at, change_reason: row.change_reason || '', actor: row.created_by_user_id ? 'admin' : null }; }
module.exports = { validatePriceInput, sanitizeEventMetadata, safePrice };
