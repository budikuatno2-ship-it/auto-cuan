'use strict';

/**
 * AI Narration Prompts — Prompt templates for each notification type.
 *
 * AI role: copywriter/narrator only.
 * AI must NOT calculate, change, invent, or decide any trading data.
 * All numbers must come from the system data passed in.
 */

const SYSTEM_INSTRUCTION = [
  'Kamu adalah copywriter Telegram channel saham Indonesia.',
  'Tugasmu HANYA menulis ulang pesan notifikasi menjadi Bahasa Indonesia yang clean dan Telegram-friendly.',
  '',
  'ATURAN MUTLAK:',
  '1. JANGAN mengubah, menambah, atau menghilangkan angka apapun.',
  '2. JANGAN mengubah ticker, status, atau kategori.',
  '3. JANGAN menambahkan saran beli/jual diluar status yang diberikan.',
  '4. JANGAN menambahkan emoji berlebihan.',
  '5. JANGAN membuat hype berlebihan.',
  '6. SEMUA angka (harga, TP, SL, entry, profit %, RR) harus tetap ada persis seperti data.',
  '7. Tulis dalam Bahasa Indonesia yang ringkas, jelas, dan profesional.',
  '8. Format: status/judul di awal, data penting terlihat jelas, catatan singkat di akhir.',
  '9. Gunakan format Rp untuk harga (contoh: Rp2.900).',
  '10. Maksimal 1-2 emoji per pesan, hanya untuk header.',
  '',
  'FORMAT OUTPUT:',
  '- Langsung tulis pesan Telegram saja, tanpa penjelasan lain.',
  '- Jangan bungkus dalam code block atau tanda kutip.',
  '- Pesan harus siap kirim langsung ke Telegram channel.'
].join('\n');

/**
 * Build the user prompt for a specific notification type.
 *
 * @param {string} type - Notification type
 * @param {object} data - Structured data for the notification
 * @returns {string}
 */
function buildUserPrompt(type, data) {
  switch (type) {
    case 'new_signal':
    case 'watchlist':
      return buildNewSignalPrompt(data);
    case 'entry_hit':
    case 'in_entry_zone':
      return buildEntryHitPrompt(data);
    case 'tp1_hit':
      return buildTp1HitPrompt(data);
    case 'tp2_hit':
      return buildTp2HitPrompt(data);
    case 'sl_hit':
      return buildSlHitPrompt(data);
    case 'running':
      return buildRunningPrompt(data);
    case 'monitor_update':
      return buildMonitorUpdatePrompt(data);
    default:
      return buildGenericPrompt(type, data);
  }
}

function buildNewSignalPrompt(data) {
  return [
    'Tulis ulang notifikasi WATCHLIST / NEW SIGNAL berikut menjadi format Telegram yang bersih:',
    '',
    'DATA (semua angka wajib ada di output):',
    'Ticker: ' + data.ticker,
    'Status: ' + (data.status || 'Watchlist'),
    'Kategori: ' + (data.category || '-'),
    'Entry 1: ' + formatNum(data.entry1),
    'Entry 2: ' + formatNum(data.entry2),
    'Stop Loss: ' + formatNum(data.sl || data.stop_loss),
    'TP1: ' + formatNum(data.tp1),
    'TP2: ' + formatNum(data.tp2),
    'Harga sekarang: ' + formatNum(data.last_price || data.current_price),
    'RR: ' + formatNum(data.risk_reward),
    data.score ? 'Score: ' + data.score : '',
    data.grade ? 'Grade: ' + data.grade : '',
    '',
    'CONTOH FORMAT OUTPUT:',
    '',
    '\uD83D\uDCCC DAY TRADE WATCHLIST',
    '',
    'Saham: EXCL',
    'Status: Watchlist',
    'Area Entry: Rp2.900 / Rp2.870',
    'Target: Rp3.010 / Rp3.150',
    'Stop Loss: Rp2.750',
    'Harga sekarang: Rp2.880',
    '',
    'Catatan:',
    'Harga sedang mendekati area entry. Tunggu konfirmasi sesuai plan, jangan chase.',
    '',
    'Tulis pesan Telegram dengan data di atas. Catatan boleh disesuaikan sesuai konteks data.'
  ].filter(Boolean).join('\n');
}

function buildEntryHitPrompt(data) {
  return [
    'Tulis ulang notifikasi ENTRY HIT berikut menjadi format Telegram yang bersih:',
    '',
    'DATA (semua angka wajib ada di output):',
    'Ticker: ' + data.ticker,
    'Status: ' + (data.status || 'In Entry Zone'),
    'Entry 1: ' + formatNum(data.entry1),
    'Entry 2: ' + formatNum(data.entry2),
    'Stop Loss: ' + formatNum(data.sl || data.stop_loss),
    'TP1: ' + formatNum(data.tp1),
    'TP2: ' + formatNum(data.tp2),
    'Harga sekarang: ' + formatNum(data.last_price || data.current_price),
    'RR: ' + formatNum(data.risk_reward),
    '',
    'Tulis pesan Telegram: status entry hit, data harga, catatan singkat untuk monitor TP/SL.'
  ].join('\n');
}

function buildTp1HitPrompt(data) {
  return [
    'Tulis ulang notifikasi TP1 HIT berikut menjadi format Telegram yang bersih:',
    '',
    'DATA (semua angka wajib ada di output):',
    'Ticker: ' + data.ticker,
    'Status: TP1 HIT',
    'Entry 1: ' + formatNum(data.entry1),
    'TP1: ' + formatNum(data.tp1),
    'TP2: ' + formatNum(data.tp2),
    'Stop Loss: ' + formatNum(data.sl || data.stop_loss),
    'Harga sekarang: ' + formatNum(data.last_price || data.current_price),
    data.profit_pct ? 'Estimasi profit: ' + data.profit_pct + '%' : '',
    '',
    'CONTOH FORMAT OUTPUT:',
    '',
    '\uD83C\uDFC6 TARGET HIT',
    '',
    'Saham: EXCL',
    'Status: TP1 HIT',
    'Entry: Rp2.900',
    'TP1: Rp3.010',
    'Harga sekarang: Rp3.020',
    'Estimasi profit: +3,79%',
    '',
    'Catatan:',
    'Target pertama tercapai. Pantau TP2 atau amankan profit sesuai trading plan.',
    '',
    'Tulis pesan Telegram dengan data di atas. Catatan boleh disesuaikan.'
  ].filter(Boolean).join('\n');
}

function buildTp2HitPrompt(data) {
  return [
    'Tulis ulang notifikasi TP2 HIT berikut menjadi format Telegram yang bersih:',
    '',
    'DATA (semua angka wajib ada di output):',
    'Ticker: ' + data.ticker,
    'Status: TP2 HIT',
    'Entry 1: ' + formatNum(data.entry1),
    'TP1: ' + formatNum(data.tp1),
    'TP2: ' + formatNum(data.tp2),
    'Stop Loss: ' + formatNum(data.sl || data.stop_loss),
    'Harga sekarang: ' + formatNum(data.last_price || data.current_price),
    data.profit_pct ? 'Estimasi profit: ' + data.profit_pct + '%' : '',
    '',
    'Tulis pesan Telegram: status TP2 hit (target akhir), data harga, catatan bahwa semua target tercapai dan saham selesai dipantau.'
  ].filter(Boolean).join('\n');
}

function buildSlHitPrompt(data) {
  return [
    'Tulis ulang notifikasi SL HIT berikut menjadi format Telegram yang bersih:',
    '',
    'DATA (semua angka wajib ada di output):',
    'Ticker: ' + data.ticker,
    'Status: SL HIT',
    'Entry 1: ' + formatNum(data.entry1),
    'Stop Loss: ' + formatNum(data.sl || data.stop_loss),
    'Harga sekarang: ' + formatNum(data.last_price || data.current_price),
    data.loss_pct ? 'Estimasi loss: ' + data.loss_pct + '%' : '',
    '',
    'Tulis pesan Telegram: status SL hit, data harga, catatan risk management singkat tanpa hype/drama.'
  ].filter(Boolean).join('\n');
}

function buildRunningPrompt(data) {
  return [
    'Tulis ulang notifikasi RUNNING berikut menjadi format Telegram yang bersih:',
    '',
    'DATA (semua angka wajib ada di output):',
    'Ticker: ' + data.ticker,
    'Status: ' + (data.status || 'Running'),
    'Entry 1: ' + formatNum(data.entry1),
    'Stop Loss: ' + formatNum(data.sl || data.stop_loss),
    'TP1: ' + formatNum(data.tp1),
    'TP2: ' + formatNum(data.tp2),
    'Harga sekarang: ' + formatNum(data.last_price || data.current_price),
    '',
    'Tulis pesan Telegram: status running/aktif, data harga, catatan singkat monitor TP/SL.'
  ].join('\n');
}

function buildMonitorUpdatePrompt(data) {
  return [
    'Tulis ulang notifikasi MONITOR UPDATE berikut menjadi format Telegram yang bersih:',
    '',
    'DATA (semua angka wajib ada di output):',
    'Ticker: ' + data.ticker,
    'Status: ' + (data.status || 'Monitor'),
    'Entry 1: ' + formatNum(data.entry1),
    'Stop Loss: ' + formatNum(data.sl || data.stop_loss),
    'TP1: ' + formatNum(data.tp1),
    'TP2: ' + formatNum(data.tp2),
    'Harga sekarang: ' + formatNum(data.last_price || data.current_price),
    data.note ? 'Catatan sistem: ' + data.note : '',
    '',
    'Tulis pesan Telegram: status update, data harga, catatan sesuai konteks.'
  ].filter(Boolean).join('\n');
}

function buildGenericPrompt(type, data) {
  const lines = [
    'Tulis ulang notifikasi berikut menjadi format Telegram yang bersih:',
    '',
    'Tipe: ' + type,
    'DATA (semua angka wajib ada di output):'
  ];

  if (data.ticker) lines.push('Ticker: ' + data.ticker);
  if (data.status) lines.push('Status: ' + data.status);
  if (data.category) lines.push('Kategori: ' + data.category);
  if (data.entry1) lines.push('Entry 1: ' + formatNum(data.entry1));
  if (data.entry2) lines.push('Entry 2: ' + formatNum(data.entry2));
  if (data.sl || data.stop_loss) lines.push('Stop Loss: ' + formatNum(data.sl || data.stop_loss));
  if (data.tp1) lines.push('TP1: ' + formatNum(data.tp1));
  if (data.tp2) lines.push('TP2: ' + formatNum(data.tp2));
  if (data.last_price || data.current_price) lines.push('Harga sekarang: ' + formatNum(data.last_price || data.current_price));
  if (data.risk_reward) lines.push('RR: ' + formatNum(data.risk_reward));
  if (data.profit_pct) lines.push('Profit: ' + data.profit_pct + '%');

  lines.push('');
  lines.push('Tulis pesan Telegram dalam Bahasa Indonesia yang ringkas dan bersih.');

  return lines.join('\n');
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
 * Get the system instruction for Gemini.
 * @returns {string}
 */
function getSystemInstruction() {
  return SYSTEM_INSTRUCTION;
}

module.exports = {
  getSystemInstruction,
  buildUserPrompt,
  formatNum
};
