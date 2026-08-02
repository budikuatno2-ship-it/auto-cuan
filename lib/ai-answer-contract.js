'use strict';

const CONTRACT_VERSION = 'autocuan-ai-answer-v1';

const BANNED_STYLE = Object.freeze([
  'bestie', 'cuan pasti', 'auto cuan', 'jamin untung', 'pasti naik', 'pasti turun',
  'langsung buy', 'langsung sell', 'gas full', 'all in'
]);

function clean(value, max) {
  return String(value == null ? '' : value)
    .replace(/\u0000/g, '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, max || 2000);
}

function finite(value) {
  if (value == null || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeConfidence(value) {
  const text = clean(value, 30).toLowerCase();
  if (['high', 'tinggi'].includes(text)) return 'TINGGI';
  if (['medium', 'sedang'].includes(text)) return 'SEDANG';
  if (['low', 'rendah'].includes(text)) return 'RENDAH';
  return 'TIDAK_DINILAI';
}

function normalizeSourceScope(value) {
  const text = clean(value || 'snapshot', 80).toLowerCase();
  return text.startsWith('snapshot') ? 'snapshot' : (text || 'snapshot');
}

function normalizeAnswer(input) {
  const row = input && typeof input === 'object' ? input : {};
  const levels = row.levels && typeof row.levels === 'object' ? row.levels : {};
  return {
    contract_version: CONTRACT_VERSION,
    direct_answer: clean(row.direct_answer || row.answer, 600),
    data_used: (Array.isArray(row.data_used) ? row.data_used : []).slice(0, 8).map((v) => clean(v, 160)).filter(Boolean),
    reasoning: clean(row.reasoning || row.analysis, 900),
    action: clean(row.action, 300),
    invalidation: clean(row.invalidation, 300),
    confidence: normalizeConfidence(row.confidence),
    levels: {
      last: finite(levels.last),
      entry_low: finite(levels.entry_low),
      entry_high: finite(levels.entry_high),
      stop_loss: finite(levels.stop_loss),
      tp1: finite(levels.tp1),
      tp2: finite(levels.tp2)
    },
    missing_data: (Array.isArray(row.missing_data) ? row.missing_data : []).slice(0, 6).map((v) => clean(v, 120)).filter(Boolean),
    warnings: (Array.isArray(row.warnings) ? row.warnings : []).slice(0, 5).map((v) => clean(v, 180)).filter(Boolean),
    source_scope: normalizeSourceScope(row.source_scope)
  };
}

function stripTemporalTokens(value) {
  return clean(value, 10000)
    .replace(/\b\d{4}-\d{1,2}-\d{1,2}(?:[T\s]\d{1,2}:\d{2}(?::\d{2})?(?:\.\d+)?(?:\s?(?:Z|UTC|WIB|WITA|WIT)|[+-]\d{2}:?\d{2})?)?\b/gi, ' ')
    .replace(/\b\d{1,2}[/-]\d{1,2}[/-]\d{2,4}\b/g, ' ')
    .replace(/\b\d{1,2}:\d{2}(?::\d{2})?\s*(?:WIB|WITA|WIT|UTC)?\b/gi, ' ');
}

function parseNumberToken(token) {
  let normalized = String(token || '');
  if (normalized.includes('.') && normalized.includes(',')) normalized = normalized.replace(/\./g, '').replace(',', '.');
  else if (normalized.includes(',')) normalized = normalized.replace(',', '.');
  else if (/^\d{1,3}(?:\.\d{3})+$/.test(normalized)) normalized = normalized.replace(/\./g, '');
  const number = Number(normalized);
  return Number.isFinite(number) ? number : null;
}

function numbersInText(value) {
  const matches = stripTemporalTokens(value).match(/\b\d[\d.,]*\b/g) || [];
  return matches.map(parseNumberToken).filter((number) => number != null);
}

const FINANCIAL_NUMBER_CONTEXT = /(?:\brp\b|\bidr\b|\bharga\b|\blast\b|\bclose\b|\bentry\b|\bstop\b|\bstop\s*loss\b|\bsl\b|\btp\d*\b|\btarget\b|\bsupport\b|\bresistance\b|\blevel\b|\bma\d*\b|\brsi\d*\b|\bfib(?:onacci)?\b|\bvolume\b|\bavg\b|\brisk\b|\brisiko\b|\br\/r\b|\breward\b|\blot\b|\bmodal\b|\bbudget\b|\balokasi\b|\bpersen\b|\bprofit\b|\bloss\b|\bpl\b|\bp\/l\b|\bdrawdown\b|\bdana\b|\bkapital\b|\bbreakout\b|\bbreakdown\b|\brebound\b|\baverage\b|\bcurrent\b|\bs\d+\b|\br\d+\b|%|\bx\b)/i;

function clauseAround(source, start, end) {
  const leftRaw = source.slice(0, start);
  const rightRaw = source.slice(end);
  const left = leftRaw.split(/[.!?;:\n]/).pop().slice(-40);
  const right = rightRaw.split(/[.!?;:\n]/)[0].slice(0, 40);
  return (left + ' ' + right).toLowerCase();
}

function financialNumbersInText(value) {
  const source = stripTemporalTokens(value);
  const result = [];
  const regex = /\b\d[\d.,]*\b/g;
  for (const match of source.matchAll(regex)) {
    const token = match[0];
    const number = parseNumberToken(token);
    if (number == null) continue;
    const start = match.index || 0;
    const end = start + token.length;
    const context = clauseAround(source, start, end);
    const hasFinancialContext = FINANCIAL_NUMBER_CONTEXT.test(context);
    const isPlainSmallCounter = Number.isInteger(number) && Math.abs(number) <= 20 && !/[.,]/.test(token) && !hasFinancialContext;
    if (!isPlainSmallCounter) result.push(number);
  }
  return result;
}

function nearlyEqual(a, b) {
  const scale = Math.max(1, Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= Math.max(0.01, scale * 0.0001);
}

function validateAnswer(input, options) {
  const answer = normalizeAnswer(input);
  const config = options && typeof options === 'object' ? options : {};
  const errors = [];
  const warnings = [];

  if (!answer.direct_answer) errors.push('direct_answer wajib diisi');
  if (!answer.action) warnings.push('action belum diisi');
  if (!answer.invalidation) warnings.push('invalidation belum diisi');
  if (answer.direct_answer.length > 600) errors.push('direct_answer terlalu panjang');

  const combined = [answer.direct_answer, answer.reasoning, answer.action, answer.invalidation]
    .concat(answer.data_used, answer.warnings)
    .join(' ')
    .toLowerCase();

  for (const phrase of BANNED_STYLE) {
    if (combined.includes(phrase)) errors.push('frasa terlarang: ' + phrase);
  }

  const allowedNumbers = (Array.isArray(config.allowed_numbers) ? config.allowed_numbers : [])
    .map(finite).filter((value) => value != null);
  if (allowedNumbers.length) {
    const found = financialNumbersInText(combined);
    for (const value of found) {
      if (!allowedNumbers.some((allowed) => nearlyEqual(value, allowed))) {
        errors.push('angka finansial tidak didukung sumber: ' + value);
      }
    }

    for (const [label, value] of Object.entries(answer.levels)) {
      if (value == null) continue;
      if (!allowedNumbers.some((allowed) => nearlyEqual(value, allowed))) {
        errors.push('level ' + label + ' tidak didukung sumber: ' + value);
      }
    }
  }

  if (config.require_snapshot_scope && answer.source_scope !== 'snapshot') {
    errors.push('source_scope harus snapshot');
  }

  if (config.require_missing_data_notice && answer.missing_data.length === 0) {
    errors.push('missing_data wajib disebutkan');
  }

  return { valid: errors.length === 0, errors, warnings, answer };
}

function renderPlainText(input) {
  const answer = normalizeAnswer(input);
  const rows = [answer.direct_answer];
  if (answer.reasoning) rows.push('Alasan: ' + answer.reasoning);
  if (answer.action) rows.push('Tindakan: ' + answer.action);
  if (answer.invalidation) rows.push('Invalidasi: ' + answer.invalidation);
  if (answer.missing_data.length) rows.push('Data yang belum ada: ' + answer.missing_data.join(', ') + '.');
  if (answer.warnings.length) rows.push('Catatan: ' + answer.warnings.join(' '));
  return rows.filter(Boolean).join('\n');
}

module.exports = {
  CONTRACT_VERSION,
  BANNED_STYLE,
  normalizeAnswer,
  validateAnswer,
  renderPlainText,
  stripTemporalTokens,
  parseNumberToken,
  numbersInText,
  financialNumbersInText,
  nearlyEqual,
  normalizeSourceScope
};
