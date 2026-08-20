'use strict';

/**
 * AI Narration Validator — Note-only mode.
 *
 * In note-only mode, AI outputs a short contextual note (1-3 sentences).
 * The deterministic template already contains all numbers/ticker/status.
 *
 * Note-only validation rules:
 * - AI note must NOT be empty.
 * - AI note must NOT contain fabricated large numbers not in source data.
 * - AI note must NOT contain explicit buy/sell hype keywords.
 * - AI note SHOULD be short (max ~500 chars).
 * - Numeric fields are NOT required in AI note (they are in the system template).
 * - Ticker is NOT required in AI note (it is in the system template).
 * - Status is NOT required in AI note (it is in the system template).
 */

/**
 * Extract all numbers from a text string.
 * @param {string} text
 * @returns {string[]}
 */
function extractNumbers(text) {
  if (!text) return [];
  const matches = text.match(/[+-]?\d[\d.,]*\d|\d/g) || [];
  return matches.map(function(m) {
    return normalizeNumberString(m);
  }).filter(Boolean);
}

/**
 * Normalize a number string for comparison.
 * @param {string} numStr
 * @returns {string}
 */
function normalizeNumberString(numStr) {
  if (!numStr) return '';
  let clean = numStr.replace(/[+%]/g, '');
  if (/^\d{1,3}(\.\d{3})+$/.test(clean)) {
    clean = clean.replace(/\./g, '');
  } else if (/,\d{1,2}$/.test(clean) && !/,\d{3}/.test(clean)) {
    clean = clean.replace(/\./g, '').replace(',', '.');
  } else {
    clean = clean.replace(/,/g, '');
  }
  const num = parseFloat(clean);
  if (!isFinite(num)) return '';
  return num === Math.floor(num) ? String(Math.floor(num)) : num.toString();
}

/**
 * Format a number the way it might appear in Indonesian text.
 * @param {number} num
 * @returns {string[]}
 */
function getNumberVariants(num) {
  if (num == null || !isFinite(num)) return [];
  const variants = [];
  const abs = Math.abs(num);
  if (num === Math.floor(num)) {
    variants.push(String(Math.floor(num)));
    if (abs >= 1000) variants.push(formatIndonesianNumber(Math.floor(num)));
  } else {
    variants.push(num.toString());
    variants.push(num.toString().replace('.', ','));
    variants.push(num.toFixed(2));
    variants.push(num.toFixed(2).replace('.', ','));
  }
  return variants.filter(Boolean);
}

/**
 * Format number with Indonesian thousand separator.
 * @param {number} num
 * @returns {string}
 */
function formatIndonesianNumber(num) {
  const str = String(Math.abs(Math.floor(num)));
  let result = '';
  for (let i = str.length - 1, count = 0; i >= 0; i--, count++) {
    if (count > 0 && count % 3 === 0) result = '.' + result;
    result = str[i] + result;
  }
  return num < 0 ? '-' + result : result;
}

// Hype / buy-sell keywords (Indonesian + English)
const HYPE_KEYWORDS = [
  'beli sekarang', 'jual sekarang', 'buy now', 'sell now',
  'pasti naik', 'pasti turun', 'pasti profit', 'pasti cuan',
  'dijamin', 'guaranteed', 'terbang', 'moon', 'to the moon',
  'langsung beli', 'langsung jual', 'wajib beli', 'wajib masuk',
  'segera beli', 'buruan beli', 'jangan sampai ketinggalan',
  'auto cuan', 'auto profit', 'pasti untung'
];

/**
 * Validate AI note output (note-only mode).
 *
 * @param {string} aiNote - The AI-generated note text
 * @param {object} sourceData - The original data object (for fabricated number detection)
 * @param {object} [options] - Validation options
 * @returns {{ valid: boolean, reason?: string, fabricatedNumbers?: string[] }}
 */
function validateNote(aiNote, sourceData, options) {
  if (!aiNote || typeof aiNote !== 'string' || aiNote.trim() === '') {
    return { valid: false, reason: 'empty_output' };
  }

  var note = aiNote.trim();

  // 1. Length guard
  if (note.length > 500) {
    return { valid: false, reason: 'note_too_long' };
  }

  // 2. Hype keyword check
  var noteLower = note.toLowerCase();
  for (var i = 0; i < HYPE_KEYWORDS.length; i++) {
    if (noteLower.indexOf(HYPE_KEYWORDS[i]) >= 0) {
      return { valid: false, reason: 'contains_hype', hypeKeyword: HYPE_KEYWORDS[i] };
    }
  }

  // 3. Fabricated number check
  if (sourceData && typeof sourceData === 'object') {
    var aiNumbers = extractNumbers(note);
    var sourceNumbers = new Set();

    for (var key of Object.keys(sourceData)) {
      var val = sourceData[key];
      if (val == null) continue;
      if (typeof val === 'number' && isFinite(val)) {
        var variants = getNumberVariants(val);
        variants.forEach(function(v) {
          var normalized = normalizeNumberString(v);
          if (normalized) sourceNumbers.add(normalized);
        });
        sourceNumbers.add(normalizeNumberString(String(val)));
      } else if (typeof val === 'string') {
        var nums = extractNumbers(val);
        nums.forEach(function(n) { sourceNumbers.add(n); });
      }
    }

    var fabricatedNumbers = aiNumbers.filter(function(n) {
      if (sourceNumbers.has(n)) return false;
      var num = parseFloat(n);
      // Day-of-month and clock references. The extractor splits "09:30" and
      // "09.30" into values that land here, so this rule — not a wider band —
      // is what keeps a time reference from reading as an invented number.
      if (num >= 0 && num <= 31) return false;
      // Year references.
      if (num >= 2020 && num <= 2030) return false;
      // NOTE: an `num <= 2359` clause used to sit here, nominally to tolerate
      // HHMM clock values. It subsumed both rules above and exempted the whole
      // 0-2359 band — which is where most liquid IDX tickers trade, and where
      // every RR ratio and percentage sits. An invented entry, stop, or target
      // was therefore never checked. Clock values are covered by the 0-31 rule
      // above; see test/ai-narration-idx-price-band.test.js.
      return true;
    });

    if (fabricatedNumbers.length > 0) {
      return { valid: false, reason: 'fabricated_numbers', fabricatedNumbers: fabricatedNumbers };
    }
  }

  return { valid: true };
}

/**
 * Legacy validate function — delegates to validateNote in note-only mode.
 */
function validate(aiOutput, sourceData, options) {
  return validateNote(aiOutput, sourceData, options);
}

module.exports = {
  validate,
  validateNote,
  extractNumbers,
  normalizeNumberString,
  getNumberVariants,
  formatIndonesianNumber
};
