'use strict';

const fs = require('node:fs');
const fsp = require('node:fs/promises');
const path = require('node:path');

const ATTACH_FIELDS = [
  'intraday_score_adjustment_preview',
  'intraday_score_adjustment_reasons',
  'intraday_priority_label',
  'intraday_confirmation_label',
  'intraday_labels',
  'data_quality'
];

function normalizeTicker(value) {
  return String(value || '').trim().toUpperCase();
}

function finiteNumber(value) {
  if (value === null || value === undefined || value === '') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function normalizeStringArray(value) {
  if (Array.isArray(value)) return value.filter((v) => v !== null && v !== undefined && v !== '').map(String);
  if (value === null || value === undefined || value === '') return [];
  return [String(value)];
}

function normalizeIntradayAdjustmentRow(row) {
  if (!row || typeof row !== 'object') return null;
  const ticker = normalizeTicker(row.ticker || row.symbol || row.code);
  if (!ticker) return null;

  const adjustment = finiteNumber(row.intraday_score_adjustment_preview);
  const out = { ticker };
  if (adjustment !== null) out.intraday_score_adjustment_preview = adjustment;
  out.intraday_score_adjustment_reasons = normalizeStringArray(row.intraday_score_adjustment_reasons);
  if (row.intraday_priority_label !== undefined && row.intraday_priority_label !== null && row.intraday_priority_label !== '') out.intraday_priority_label = String(row.intraday_priority_label);
  if (row.intraday_confirmation_label !== undefined && row.intraday_confirmation_label !== null && row.intraday_confirmation_label !== '') out.intraday_confirmation_label = String(row.intraday_confirmation_label);
  out.intraday_labels = normalizeStringArray(row.intraday_labels);
  if (row.data_quality !== undefined && row.data_quality !== null && row.data_quality !== '') out.data_quality = String(row.data_quality);
  return out;
}

function extractRows(payload) {
  if (Array.isArray(payload)) return payload;
  if (!payload || typeof payload !== 'object') return [];
  if (Array.isArray(payload.rows)) return payload.rows;
  if (Array.isArray(payload.results)) return payload.results;
  if (Array.isArray(payload.candidates)) return payload.candidates;
  return [];
}

function buildIntradayAdjustmentMap(rows) {
  const map = new Map();
  for (const row of extractRows(rows)) {
    const normalized = normalizeIntradayAdjustmentRow(row);
    if (normalized && normalized.ticker) map.set(normalized.ticker, normalized);
  }
  return map;
}

function loadIntradayAdjustmentFile(filePath) {
  const raw = fs.readFileSync(filePath, 'utf8');
  const payload = JSON.parse(raw);
  return buildIntradayAdjustmentMap(payload);
}

async function findLatestIntradayObserveReport(outputDir) {
  const dir = outputDir || path.join(process.cwd(), 'data', 'reports');
  let entries;
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch (e) {
    if (e && e.code === 'ENOENT') return null;
    throw e;
  }
  const candidates = [];
  for (const entry of entries) {
    if (!entry.isFile()) continue;
    if (!/^daytrade-intraday-observe-.*\.json$/.test(entry.name)) continue;
    const full = path.join(dir, entry.name);
    const stat = await fsp.stat(full);
    candidates.push({ file: full, mtimeMs: stat.mtimeMs, name: entry.name });
  }
  candidates.sort((a, b) => b.mtimeMs - a.mtimeMs || b.name.localeCompare(a.name));
  return candidates.length ? candidates[0].file : null;
}

function attachIntradayAdjustmentFields(candidate, adjustmentMap) {
  if (!candidate || typeof candidate !== 'object' || !adjustmentMap) return candidate;
  const ticker = normalizeTicker(candidate.ticker || candidate.symbol || candidate.code);
  if (!ticker) return candidate;
  const row = adjustmentMap instanceof Map ? adjustmentMap.get(ticker) : adjustmentMap[ticker];
  if (!row) return candidate;
  const normalized = normalizeIntradayAdjustmentRow(row);
  if (!normalized) return candidate;
  const out = Object.assign({}, candidate);
  for (const field of ATTACH_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(normalized, field)) out[field] = Array.isArray(normalized[field]) ? normalized[field].slice() : normalized[field];
  }
  return out;
}

module.exports = {
  normalizeIntradayAdjustmentRow,
  buildIntradayAdjustmentMap,
  loadIntradayAdjustmentFile,
  findLatestIntradayObserveReport,
  attachIntradayAdjustmentFields,
  ATTACH_FIELDS
};
