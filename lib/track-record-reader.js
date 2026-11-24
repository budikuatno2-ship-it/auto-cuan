'use strict';

/**
 * lib/track-record-reader.js
 * ============================================================================
 * Resilient Track Record & Backtest Data Reader — Auto-Cuan V6
 * ============================================================================
 * Resolves backtest data paths dynamically across local, test, and VPS production
 * environments without fabricating fake numbers.
 *
 * Handles:
 * - Multi-candidate search paths
 * - Missing file (ENOENT)
 * - Permission errors (EACCES)
 * - Corrupted / invalid JSON
 * - Clean structured return without process termination
 * ============================================================================
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT_DIR = path.resolve(__dirname, '..');

function getCandidatePaths(customPath) {
  const list = [];
  if (customPath && typeof customPath === 'string') {
    list.push(path.resolve(customPath));
  }
  if (process.env.AUTO_CUAN_BACKTEST_FILE) {
    list.push(path.resolve(process.env.AUTO_CUAN_BACKTEST_FILE));
  }
  if (process.env.BACKTEST_FILE_PATH) {
    list.push(path.resolve(process.env.BACKTEST_FILE_PATH));
  }

  // Canonical paths
  list.push(path.join(ROOT_DIR, 'bukti-verifikasi-final', 'backtest-individual-964.json'));
  list.push(path.join(process.cwd(), 'bukti-verifikasi-final', 'backtest-individual-964.json'));
  list.push(path.join(ROOT_DIR, 'backtest', 'backtest-individual-964.json'));
  list.push(path.join(ROOT_DIR, 'data', 'backtest-individual-964.json'));

  const runnerDir = process.env.AUTO_CUAN_RUNNER_DIR || '/home/ubuntu/auto-cuan-runner';
  list.push(path.join(runnerDir, 'bukti-verifikasi-final', 'backtest-individual-964.json'));

  // Deduplicate preserving order
  return [...new Set(list)];
}

/**
 * Safely load backtest dataset.
 *
 * @param {string} [customPath]
 * @returns {{
 *   success: boolean,
 *   data: object|null,
 *   filePath: string|null,
 *   error: string|null,
 *   errorCode: string|null,
 *   searchedPaths: string[]
 * }}
 */
function loadBacktestData(customPath) {
  const searchedPaths = getCandidatePaths(customPath);
  let resolvedPath = null;

  for (const candidate of searchedPaths) {
    try {
      if (fs.existsSync(candidate)) {
        resolvedPath = candidate;
        break;
      }
    } catch (_) {}
  }

  if (!resolvedPath) {
    return {
      success: false,
      data: null,
      filePath: null,
      error: 'BACKTEST_FILE_NOT_FOUND',
      errorCode: 'ENOENT',
      searchedPaths
    };
  }

  try {
    const raw = fs.readFileSync(resolvedPath, 'utf8');
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object') {
      return {
        success: false,
        data: null,
        filePath: resolvedPath,
        error: 'BACKTEST_FILE_NOT_OBJECT',
        errorCode: 'INVALID_SHAPE',
        searchedPaths
      };
    }
    return {
      success: true,
      data: parsed,
      filePath: resolvedPath,
      error: null,
      errorCode: null,
      searchedPaths
    };
  } catch (err) {
    const isParseError = err instanceof SyntaxError;
    return {
      success: false,
      data: null,
      filePath: resolvedPath,
      error: isParseError ? 'BACKTEST_FILE_CORRUPTED' : 'BACKTEST_FILE_UNREADABLE',
      errorCode: isParseError ? 'JSON_SYNTAX_ERROR' : (err.code || 'READ_ERROR'),
      detail: String((err && err.message) || err),
      searchedPaths
    };
  }
}

/**
 * Find backtest record for a single ticker.
 *
 * @param {string} ticker
 * @param {object} [backtestDoc]
 * @returns {object|null}
 */
function getTickerBacktestRecord(ticker, backtestDoc) {
  if (!ticker || !backtestDoc || !Array.isArray(backtestDoc.tickers)) return null;
  const sym = String(ticker).trim().toUpperCase();
  const found = backtestDoc.tickers.find((t) => t && String(t.ticker || '').toUpperCase() === sym);
  return found || null;
}

module.exports = {
  getCandidatePaths,
  loadBacktestData,
  getTickerBacktestRecord
};
