/**
 * Market Maker Code Mapping
 * Secondary reference only — not guaranteed truth.
 * Codes detected from last 3-4 digits of bid/offer/lot/freq values.
 */

const MM_CODES = {
  '666': { meaning: 'Akhir dari mark up, potensi jual segera, risiko turun dalam.', bias: 'DISTRIBUTION', strength: 'HIGH' },
  '400': { meaning: 'Saham cenderung sideways / belum bergerak jelas.', bias: 'SIDEWAYS', strength: 'MEDIUM' },
  '999': { meaning: 'Harga diduga sudah di puncak, risiko distribusi / perubahan drastis.', bias: 'DISTRIBUTION', strength: 'HIGH' },
  '500': { meaning: 'Potensi menuju gap up atau gap down, butuh kode/konfirmasi lanjutan.', bias: 'UNKNOWN', strength: 'MEDIUM' },
  '777': { meaning: 'Referensi bullish / potensi harga naik tinggi.', bias: 'ACCUM', strength: 'HIGH' },
  '200': { meaning: 'Indikasi butuh saham untuk dibeli, tetapi jangan turunkan harga drastis.', bias: 'ACCUM', strength: 'MEDIUM' },
  '2100': { meaning: 'Let it run, tahan selama tren masih valid.', bias: 'ACCUM', strength: 'MEDIUM' },
  '555': { meaning: 'Gap up / beli sebelum naik / potensi fase akumulasi mingguan.', bias: 'ACCUM', strength: 'HIGH' },
  '888': { meaning: 'Sell on strength / jual saat harga diangkat.', bias: 'DISTRIBUTION', strength: 'HIGH' },
  '404': { meaning: 'Risiko turun dalam kondisi sideways, bisa muncul sebelum turun / ARB.', bias: 'WARNING', strength: 'HIGH' },
  '911': { meaning: 'Pending news / menunggu news keluar / harga ditahan menjelang news.', bias: 'WARNING', strength: 'MEDIUM' },
  '100': { meaning: 'Membutuhkan saham untuk dibeli.', bias: 'ACCUM', strength: 'MEDIUM' },
  '700': { meaning: 'Harga berpotensi naik, tetapi tetap butuh validasi.', bias: 'ACCUM', strength: 'MEDIUM' }
};

/**
 * Look up a market maker code
 * @param {string|number} code
 * @returns {object|null} { code, meaning, bias, strength } or null
 */
function lookupCode(code) {
  const key = String(code).trim();
  if (MM_CODES[key]) {
    return { code: key, ...MM_CODES[key] };
  }
  return null;
}

/**
 * Extract possible MM codes from a numeric value (last 3-4 digits)
 * @param {number|string} value - e.g. 10777, 5666, 2100
 * @returns {Array} Array of { code, meaning, bias, strength, matchType }
 */
function extractCodesFromValue(value) {
  const str = String(value).replace(/[^0-9]/g, '');
  if (!str || str.length < 3) return [];

  const results = [];

  // Check exact match first (for 4-digit codes like 2100)
  if (MM_CODES[str]) {
    results.push({ ...MM_CODES[str], code: str, matchType: 'exact' });
    return results;
  }

  // Check last 4 digits
  if (str.length >= 4) {
    const last4 = str.slice(-4);
    if (MM_CODES[last4]) {
      results.push({ ...MM_CODES[last4], code: last4, matchType: 'last4' });
    }
  }

  // Check last 3 digits
  const last3 = str.slice(-3);
  if (MM_CODES[last3] && !results.find(r => r.code === last3)) {
    results.push({ ...MM_CODES[last3], code: last3, matchType: 'last3' });
  }

  return results;
}

/**
 * Get all known codes for reference
 * @returns {object} The full mapping
 */
function getAllCodes() {
  return MM_CODES;
}

module.exports = { lookupCode, extractCodesFromValue, getAllCodes, MM_CODES };
