'use strict';

/**
 * AI Narration Validator — Ensures AI output preserves all required data.
 *
 * Rules:
 * - All numeric values from source data MUST appear in AI output.
 * - Ticker MUST appear in AI output.
 * - Status/category keywords MUST appear (case-insensitive).
 * - AI must not add new numbers not present in source data.
 * - If validation fails, caller falls back to original template.
 */

/**
 * Extract all numbers from a text string.
 * Handles: integers, decimals, percentages, formatted numbers (e.g., "2.900", "3,79%").
 * Returns normalized numeric strings for comparison.
 *
 * @param {string} text
 * @returns {string[]} - Array of normalized number strings
 */
function extractNumbers(text) {
  if (!text) return [];
  // Match numbers with optional thousand separators and decimals
  // Patterns: 2900, 2.900, 3.79, 3,79, +3.79%, -1.5%
  const matches = text.match(/[+-]?\d[\d.,]*\d|\d/g) || [];
  return matches.map(function(m) {
    return normalizeNumberString(m);
  }).filter(Boolean);
}

/**
 * Normalize a number string for comparison.
 * Handles Indonesian formatting (. as thousand sep, , as decimal).
 * Also handles international formatting (, as thousand sep, . as decimal).
 *
 * @param {string} numStr
 * @returns {string}
 */
function normalizeNumberString(numStr) {
  if (!numStr) return '';
  let clean = numStr.replace(/[+%]/g, '');

  // Detect Indonesian style: "2.900" (dot as thousand separator)
  // vs decimal: "3.79"
  // Heuristic: if has dot followed by exactly 3 digits at end, it's thousand separator
  // "2.900" -> 2900, but "3.79" -> 3.79
  if (/^\d{1,3}(\.\d{3})+$/.test(clean)) {
    // Indonesian thousand separator (e.g., "2.900" -> "2900")
    clean = clean.replace(/\./g, '');
  } else if (/,\d{1,2}$/.test(clean) && !/,\d{3}/.test(clean)) {
    // Comma as decimal separator (e.g., "3,79" -> "3.79")
    clean = clean.replace(/\./g, '').replace(',', '.');
  } else {
    // International thousand separator (e.g., "2,900" -> "2900")
    clean = clean.replace(/,/g, '');
  }

  // Parse and return canonical form
  const num = parseFloat(clean);
  if (!isFinite(num)) return '';
  // Return integer if whole number, otherwise fixed decimal
  return num === Math.floor(num) ? String(Math.floor(num)) : num.toString();
}

/**
 * Format a number the way it might appear in Indonesian text.
 * Returns multiple possible representations for matching.
 *
 * @param {number} num
 * @returns {string[]}
 */
function getNumberVariants(num) {
  if (num == null || !isFinite(num)) return [];
  const variants = [];
  const abs = Math.abs(num);

  // Integer form
  if (num === Math.floor(num)) {
    variants.push(String(Math.floor(num)));
    // Indonesian thousand separator form (e.g., 2900 -> "2.900")
    if (abs >= 1000) {
      variants.push(formatIndonesianNumber(Math.floor(num)));
    }
  } else {
    // Decimal form
    variants.push(num.toString());
    // Comma decimal form (Indonesian style: 3.79 -> "3,79")
    variants.push(num.toString().replace('.', ','));
    // Try with more decimal places
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

/**
 * Validate that AI narration output preserves all required data from source.
 *
 * @param {string} aiOutput - The AI-generated narration text
 * @param {object} sourceData - The original data object with required fields
 * @param {object} [options] - Validation options
 * @param {string[]} [options.requiredFields] - Field names that must have their values present
 * @returns {{ valid: boolean, reason?: string, missingFields?: string[] }}
 */
function validate(aiOutput, sourceData, options) {
  if (!aiOutput || typeof aiOutput !== 'string' || aiOutput.trim() === '') {
    return { valid: false, reason: 'empty_output' };
  }
  if (!sourceData || typeof sourceData !== 'object') {
    return { valid: false, reason: 'missing_source_data' };
  }

  options = options || {};
  const output = aiOutput;
  const outputUpper = output.toUpperCase();
  const missingFields = [];

  // 1. Ticker must be present
  if (sourceData.ticker) {
    const ticker = String(sourceData.ticker).toUpperCase();
    if (outputUpper.indexOf(ticker) < 0) {
      missingFields.push('ticker');
    }
  }

  // 2. Status must be present (case-insensitive, allow underscore/space variants and Indonesian synonyms)
  if (sourceData.status) {
    const status = String(sourceData.status).toUpperCase();
    const statusVariants = [
      status,
      status.replace(/_/g, ' '),
      status.replace(/_/g, '')
    ];
    // Add common Indonesian synonyms/translations for known statuses
    const synonymMap = {
      'WATCHLIST': ['PANTAUAN', 'WATCH LIST'],
      'SWING READY': ['SIAP SWING', 'SWING SIAP', 'WATCHLIST', 'PANTAUAN'],
      'DAY TRADE READY': ['SIAP DAY TRADE', 'DAYTRADE READY', 'WATCHLIST', 'PANTAUAN'],
      'IN ENTRY ZONE': ['MASUK AREA ENTRY', 'DI AREA ENTRY', 'ENTRY ZONE'],
      'RUNNING': ['BERJALAN', 'AKTIF'],
      'TP1 HIT': ['TARGET 1 TERCAPAI', 'TP1 TERCAPAI'],
      'TP2 HIT': ['TARGET 2 TERCAPAI', 'TP2 TERCAPAI'],
      'SL HIT': ['STOP LOSS TERCAPAI', 'SL TERCAPAI', 'STOP LOSS HIT']
    };
    const synonyms = synonymMap[status] || synonymMap[status.replace(/_/g, ' ')] || [];
    const allVariants = statusVariants.concat(synonyms);
    const statusFound = allVariants.some(function(v) {
      return outputUpper.indexOf(v) >= 0;
    });
    if (!statusFound) {
      missingFields.push('status');
    }
  }

  // 3. All numeric fields must have their values present in output
  const numericFields = options.requiredFields || [
    'entry1', 'entry2', 'sl', 'stop_loss', 'tp1', 'tp2',
    'last_price', 'current_price', 'risk_reward', 'profit_pct'
  ];

  for (const field of numericFields) {
    const value = sourceData[field];
    if (value == null || value === '' || value === 0) continue;

    const num = parseFloat(value);
    if (!isFinite(num)) continue;

    const variants = getNumberVariants(num);
    const found = variants.some(function(v) {
      return output.indexOf(v) >= 0;
    });

    if (!found) {
      missingFields.push(field);
    }
  }

  if (missingFields.length > 0) {
    return {
      valid: false,
      reason: 'missing_required_data',
      missingFields: missingFields
    };
  }

  // 4. Check AI didn't add fabricated large numbers not in source
  // Extract all numbers from AI output and source, compare
  const aiNumbers = extractNumbers(output);
  const sourceNumbers = new Set();

  // Collect all numbers from source data
  for (const key of Object.keys(sourceData)) {
    const val = sourceData[key];
    if (val == null) continue;
    if (typeof val === 'number' && isFinite(val)) {
      const variants = getNumberVariants(val);
      variants.forEach(function(v) {
        const normalized = normalizeNumberString(v);
        if (normalized) sourceNumbers.add(normalized);
      });
      // Also add the raw number
      sourceNumbers.add(normalizeNumberString(String(val)));
    } else if (typeof val === 'string') {
      const nums = extractNumbers(val);
      nums.forEach(function(n) { sourceNumbers.add(n); });
    }
  }

  // Allow small numbers (like ordinals, bullet points: 1, 2, 3...) and date-like numbers
  const fabricatedNumbers = aiNumbers.filter(function(n) {
    if (sourceNumbers.has(n)) return false;
    const num = parseFloat(n);
    // Allow small numbers (ordinals, list numbers, common formatting)
    if (num >= 0 && num <= 31) return false;
    // Allow year-like numbers
    if (num >= 2020 && num <= 2030) return false;
    // Allow time-like numbers (hours, minutes)
    if (num >= 0 && num <= 2359) return false;
    return true;
  });

  if (fabricatedNumbers.length > 0) {
    return {
      valid: false,
      reason: 'fabricated_numbers',
      fabricatedNumbers: fabricatedNumbers
    };
  }

  return { valid: true };
}

module.exports = {
  validate,
  extractNumbers,
  normalizeNumberString,
  getNumberVariants,
  formatIndonesianNumber
};
