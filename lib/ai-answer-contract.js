'use strict';

const CONTRACT_VERSION = 'autocuan-ai-answer-v1';

const BANNED_STYLE = Object.freeze([
  'bestie', 'cuan pasti', 'auto cuan', 'jamin untung', 'pasti naik', 'pasti turun',
  'langsung buy', 'langsung sell', 'gas full', 'all in'
]);

const SCALE_MULTIPLIERS = Object.freeze({
  ribu: 1000,
  juta: 1000000,
  miliar: 1000000000,
  triliun: 1000000000000
});

const MONETARY_SCALE_CONTEXT = /(?:\bdana\b|\bmodal\b|\bbudget\b|\bkapital\b|\bprofit\b|\bkeuntungan\b|\bkerugian\b|\bloss\b|\brisiko\b|\brisk\b|\bbiaya\b|\bsisa\b|\bharga\b|\bnilai posisi\b|\balokasi\b)/i;

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

function numberTokenRegex() {
  return /\b(?:rp|idr)\s*\d(?:[\d.,]*\d)?(?:\s*(?:ribu|juta|miliar|triliun))?(?:\s*rupiah)?(?:\s*[x×%])?|(?<![A-Za-z0-9_])\d(?:[\d.,]*\d)?(?:\s*(?:ribu|juta|miliar|triliun))?(?:\s*rupiah)?(?:\s*[x×%])?(?![A-Za-z0-9_])/gi;
}

function clauseAround(source, start, end) {
  const leftRaw = source.slice(0, start);
  const rightRaw = source.slice(end);
  const left = leftRaw.split(/[.!?;:\n]/).pop().slice(-60);
  const right = rightRaw.split(/[.!?;:\n]/)[0].slice(0, 60);
  return (left + ' ' + right).toLowerCase();
}

function parseMatchedNumber(raw, context) {
  let text = clean(raw, 120).toLowerCase();
  const explicitRatio = /[x×%]\s*$/i.test(text);
  text = text.replace(/\s*[x×%]\s*$/i, '').trim();
  const explicitCurrency = /^(?:rp|idr)/i.test(text) || /\brupiah$/i.test(text);
  text = text.replace(/^(?:rp|idr)\s*/i, '').replace(/\s*rupiah$/i, '').trim();

  const scaleMatch = text.match(/\s*(ribu|juta|miliar|triliun)$/i);
  let scale = null;
  if (scaleMatch) {
    scale = SCALE_MULTIPLIERS[scaleMatch[1].toLowerCase()] || null;
    text = text.slice(0, scaleMatch.index).trim();
  }

  const base = parseNumberToken(text);
  if (base == null) return null;
  if (scale && (explicitCurrency || MONETARY_SCALE_CONTEXT.test(context || ''))) return base * scale;
  return base;
}

function isTemporalPeriodToken(source, start, end, raw) {
  if (/^(?:rp|idr)/i.test(raw) || /\b(?:ribu|juta|miliar|triliun|rupiah)\b/i.test(raw)) return false;
  const right = source.slice(end, end + 24);
  return /^\s*(?:hari|day|days|minggu|week|weeks|bulan|month|months|tahun|year|years|sesi|session|sessions)\b/i.test(right);
}

function isEnumerationCounter(source, start, end) {
  const left = source.slice(Math.max(0, start - 4), start);
  const right = source.slice(end, end + 4);
  return /\(\s*$/.test(left) && /^\s*\)/.test(right);
}

function numbersInText(value) {
  const source = stripTemporalTokens(value);
  const result = [];
  for (const match of source.matchAll(numberTokenRegex())) {
    const start = match.index || 0;
    const end = start + match[0].length;
    const number = parseMatchedNumber(match[0], clauseAround(source, start, end));
    if (number != null) result.push(number);
  }
  return result;
}

const FINANCIAL_NUMBER_CONTEXT = /(?:\brp\b|\bidr\b|\bharga\b|\blast\b|\bclose\b|\bentry\b|\bstop\b|\bstop\s*loss\b|\bsl\b|\btp\d*\b|\btarget\b|\bsupport\b|\bresistance\b|\blevel\b|\bma\d*\b|\brsi\d*\b|\bfib(?:onacci)?\b|\bvolume\b|\bavg\b|\brisk\b|\brisiko\b|\br\/r\b|\breward\b|\blot\b|\bmodal\b|\bbudget\b|\balokasi\b|\bpersen\b|\bprofit\b|\bloss\b|\bpl\b|\bp\/l\b|\bdrawdown\b|\bdana\b|\bkapital\b|\bbreakout\b|\bbreakdown\b|\brebound\b|\baverage\b|\bcurrent\b|\bs\d+\b|\br\d+\b|%|\bx\b)/i;

function financialNumbersInText(value) {
  const source = stripTemporalTokens(value);
  const result = [];

  for (const match of source.matchAll(numberTokenRegex())) {
    const token = match[0];
    const start = match.index || 0;
    const end = start + token.length;

    if (isTemporalPeriodToken(source, start, end, token)) continue;
    if (isEnumerationCounter(source, start, end)) continue;

    const context = clauseAround(source, start, end);
    const number = parseMatchedNumber(token, context);
    if (number == null) continue;

    const explicitCurrency = /^(?:rp|idr)/i.test(token) || /\brupiah(?:\s*[x×%])?$/i.test(token);
    const explicitRatio = /[x×%]\s*$/i.test(token);
    const followedByPercent = /^\s*%/.test(source.slice(end, end + 3));
    const hasFinancialContext = explicitCurrency || explicitRatio || followedByPercent || FINANCIAL_NUMBER_CONTEXT.test(context);
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
    const unsupported = [];
    for (const value of found) {
      if (allowedNumbers.some((allowed) => nearlyEqual(value, allowed))) continue;
      if (!unsupported.some((existing) => nearlyEqual(value, existing))) unsupported.push(value);
    }
    for (const value of unsupported) errors.push('angka finansial tidak didukung sumber: ' + value);

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
  parseMatchedNumber,
  numbersInText,
  financialNumbersInText,
  nearlyEqual,
  normalizeSourceScope,
  isTemporalPeriodToken,
  isEnumerationCounter
};