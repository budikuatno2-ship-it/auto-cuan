'use strict';

/**
 * AI Narration Prompts — Prompt templates for each notification type.
 *
 * AI role: copywriter/narrator only — generates SHORT contextual notes (1-3 sentences).
 * AI must NOT output full signal messages, numbers, or trading data.
 * The deterministic system template handles all data display.
 * AI only adds a "Catatan AI" section with context/guidance.
 */

const NOTE_SYSTEM_INSTRUCTION = [
  'Kamu adalah copywriter Telegram channel saham Indonesia.',
  'Tugasmu HANYA menulis catatan singkat (1-3 kalimat) untuk ditambahkan di akhir pesan notifikasi saham.',
  '',
  'ATURAN MUTLAK:',
  '1. JANGAN menulis ulang seluruh pesan — hanya catatan singkat saja.',
  '2. JANGAN menyebutkan angka harga, entry, TP, SL, RR, profit %, volume, atau data numerik apapun.',
  '3. JANGAN menyebutkan ticker/kode saham.',
  '4. JANGAN menambahkan saran beli/jual eksplisit.',
  '5. JANGAN membuat hype berlebihan atau drama.',
  '6. JANGAN menambahkan emoji.',
  '7. Tulis dalam Bahasa Indonesia yang ringkas, jelas, dan profesional.',
  '8. Maksimal 1-3 kalimat pendek.',
  '9. Fokus pada konteks: konfirmasi, manajemen risiko, kondisi market, disiplin plan.',
  '',
  'CONTOH OUTPUT YANG BENAR:',
  '- "Tunggu konfirmasi volume sebelum entry. Jangan chase jika sudah jauh dari area entry."',
  '- "Target pertama tercapai. Amankan sebagian profit, sisanya trailing sesuai plan."',
  '- "Stop loss tercapai. Disiplin cut loss, evaluasi ulang setup untuk peluang berikutnya."',
  '- "Harga masuk area entry. Pantau konfirmasi close dan volume sebelum eksekusi."',
  '',
  'CONTOH OUTPUT YANG SALAH (jangan lakukan):',
  '- "BBRI target Rp5.500 sangat menjanjikan!" ← menyebut ticker dan angka',
  '- "🚀 Siap terbang!" ← hype + emoji',
  '- "Beli sekarang sebelum terlambat" ← saran beli eksplisit',
  '',
  'FORMAT OUTPUT:',
  '- Langsung tulis catatan saja, tanpa label "Catatan:" atau prefix apapun.',
  '- Jangan bungkus dalam code block atau tanda kutip.',
  '- Langsung 1-3 kalimat catatan kontekstual.'
].join('\n');

/**
 * Build the user prompt for note-only mode.
 *
 * @param {string} type - Notification type
 * @param {object} data - Structured data for the notification
 * @returns {string}
 */
function buildNotePrompt(type, data) {
  // ponytail: normalize case and guard null data
  const t = String(type || '').toLowerCase();
  const d = data && typeof data === 'object' ? data : {};
  switch (t) {
    case 'new_signal':
    case 'watchlist':
      return buildNewSignalNotePrompt(d);
    case 'entry_hit':
    case 'in_entry_zone':
      return buildEntryHitNotePrompt(d);
    case 'tp1_hit':
      return buildTp1HitNotePrompt(d);
    case 'tp2_hit':
      return buildTp2HitNotePrompt(d);
    case 'sl_hit':
      return buildSlHitNotePrompt(d);
    case 'running':
      return buildRunningNotePrompt(d);
    case 'monitor_update':
      return buildMonitorUpdateNotePrompt(d);
    default:
      return buildGenericNotePrompt(t, d);
  }
}

function buildNewSignalNotePrompt(data) {
  var d = data || {};
  var category = (d.category || 'Swing').toUpperCase();
  var status = (d.status || 'Watchlist').toUpperCase();
  return [
    'Konteks: Sinyal baru ' + category + ' dengan status ' + status + '.',
    'Harga sedang di sekitar area entry.',
    '',
    'Tulis catatan singkat 1-3 kalimat untuk trader.',
    'Fokus: konfirmasi entry, jangan chase, tunggu volume/close confirmation, disiplin plan.',
    'JANGAN sebut angka, ticker, atau saran beli/jual.'
  ].join('\n');
}

function buildEntryHitNotePrompt(data) {
  return [
    'Konteks: Harga sudah masuk area entry (entry zone hit).',
    '',
    'Tulis catatan singkat 1-3 kalimat untuk trader.',
    'Fokus: konfirmasi entry valid, pantau TP/SL, manajemen risiko.',
    'JANGAN sebut angka, ticker, atau saran beli/jual.'
  ].join('\n');
}

function buildTp1HitNotePrompt(data) {
  return [
    'Konteks: Target profit pertama (TP1) sudah tercapai.',
    '',
    'Tulis catatan singkat 1-3 kalimat untuk trader.',
    'Fokus: amankan profit, trailing TP2, disiplin plan.',
    'JANGAN sebut angka, ticker, atau saran beli/jual.'
  ].join('\n');
}

function buildTp2HitNotePrompt(data) {
  return [
    'Konteks: Target profit kedua (TP2) sudah tercapai. Setup selesai.',
    '',
    'Tulis catatan singkat 1-3 kalimat untuk trader.',
    'Fokus: semua target tercapai, selesai dipantau, evaluasi positif.',
    'JANGAN sebut angka, ticker, atau saran beli/jual.'
  ].join('\n');
}

function buildSlHitNotePrompt(data) {
  return [
    'Konteks: Stop loss tercapai (SL hit). Setup gagal.',
    '',
    'Tulis catatan singkat 1-3 kalimat untuk trader.',
    'Fokus: disiplin cut loss, risk management, evaluasi ulang, jangan revenge trade.',
    'JANGAN sebut angka, ticker, atau saran beli/jual. JANGAN dramatisasi.'
  ].join('\n');
}

function buildRunningNotePrompt(data) {
  return [
    'Konteks: Posisi sedang berjalan (running). Harga bergerak sesuai arah.',
    '',
    'Tulis catatan singkat 1-3 kalimat untuk trader.',
    'Fokus: pantau TP/SL, trailing stop jika perlu, tetap disiplin plan.',
    'JANGAN sebut angka, ticker, atau saran beli/jual.'
  ].join('\n');
}

function buildMonitorUpdateNotePrompt(data) {
  var d = data || {};
  var note = d.note ? 'Catatan sistem: ' + d.note : '';
  return [
    'Konteks: Update monitoring posisi aktif.',
    note,
    '',
    'Tulis catatan singkat 1-3 kalimat untuk trader.',
    'Fokus: status terkini, pantau level penting, disiplin plan.',
    'JANGAN sebut angka, ticker, atau saran beli/jual.'
  ].filter(Boolean).join('\n');
}

function buildGenericNotePrompt(type, data) {
  var d = data || {};
  return [
    'Konteks: Notifikasi tipe "' + type + '" untuk saham.',
    '',
    'Tulis catatan singkat 1-3 kalimat untuk trader.',
    'Fokus: konteks yang relevan, disiplin plan, manajemen risiko.',
    'JANGAN sebut angka, ticker, atau saran beli/jual.'
  ].join('\n');
}

/**
 * Build the user prompt (delegates to note-only mode).
 * @param {string} type
 * @param {object} data
 * @returns {string}
 */
function buildUserPrompt(type, data) {
  return buildNotePrompt(type, data);
}

/**
 * Format a number for prompt display.
 * @param {*} val
 * @returns {string}
 */
function formatNum(val) {
  if (val == null || val === '') return '-';
  const num = parseFloat(val);
  if (!isFinite(num)) return String(val);
  if (num === Math.floor(num)) return String(Math.floor(num));
  return num.toString();
}

/**
 * Get the system instruction for Gemini (note-only mode).
 * @returns {string}
 */
function getSystemInstruction() {
  return NOTE_SYSTEM_INSTRUCTION;
}

module.exports = {
  getSystemInstruction,
  buildUserPrompt,
  buildNotePrompt,
  formatNum
};
