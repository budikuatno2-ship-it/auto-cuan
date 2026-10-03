'use strict';

/**
 * Auxiliary Data Provenance Scanner (Wave 2 / W2-01) — READ-ONLY.
 *
 * The pre-#835 daily worker could request the current-only endpoints
 *   /api/broker-accumulation/{code}   (no historical date parameter)
 *   /api/insiders/{code}              (no historical date parameter)
 * for a HISTORICAL target date and store the returned CURRENT snapshot under
 * a dated filename (e.g. data/arjum-data/broker-accumulation/BBCA/2026-09-28.json).
 * Those dated files claim to be that session's snapshot but actually contain a
 * later capture. PR #835 stopped NEW occurrences; this scanner audits OLD files.
 *
 * Classification (evidence-first; a later mtime ALONE is never proof):
 *
 *   VERIFIED_INVALID_PROVENANCE
 *     - accumulation: the payload itself carries a date range ending AFTER the
 *       logical date (end_date > logical date), proving the content covers a
 *       later session, AND at least one independent corroborating signal
 *       (file mtime after the logical date, or byte-identical content shared
 *       with a later-dated file).
 *     - insiders: file mtime strictly after the logical date AND byte-identical
 *       content shared with a later-dated file for the same ticker (the
 *       snapshot cannot be both dates' state and was demonstrably written
 *       after the date it claims).
 *
 *   STRONGLY_SUSPECT  — one strong signal only (payload date after logical, or
 *                       mtime after logical with no duplicate corroboration).
 *   AMBIGUOUS         — conflicting signals (e.g. mtime before logical date).
 *   VALID             — no signal of invalid provenance.
 *   UNKNOWN           — unreadable / unparseable / unrecognized shape.
 *
 * Only VERIFIED_INVALID_PROVENANCE files are eligible for quarantine; this
 * scanner never moves, writes, or deletes anything under the data root.
 *
 * Usage:
 *   node tools/scan-aux-provenance.js                       # human summary
 *   node tools/scan-aux-provenance.js --json                # JSON to stdout
 *   node tools/scan-aux-provenance.js --out manifest.json   # write manifest
 *   node tools/scan-aux-provenance.js --root <dir>          # data/arjum-data
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const CLASSIFICATIONS = Object.freeze({
  VERIFIED_INVALID: 'VERIFIED_INVALID_PROVENANCE',
  STRONGLY_SUSPECT: 'STRONGLY_SUSPECT',
  AMBIGUOUS: 'AMBIGUOUS',
  VALID: 'VALID',
  UNKNOWN: 'UNKNOWN'
});

const AUXILIARY_DATASETS = Object.freeze(['broker-accumulation', 'insiders']);

function defaultRoot() {
  return process.env.ARJUM_DATA_DIR || path.join(__dirname, '..', 'data', 'arjum-data');
}

function jakartaDateOf(dateObj) {
  try {
    return new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Jakarta', year: 'numeric', month: '2-digit', day: '2-digit'
    }).format(dateObj);
  } catch (_) {
    return null;
  }
}

function sha256File(filePath) {
  const hash = crypto.createHash('sha256');
  hash.update(fs.readFileSync(filePath));
  return hash.digest('hex');
}

function readJsonSafe(filePath) {
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (_) {
    return null;
  }
}

/**
 * Extract the payload's own date evidence for the accumulation dataset.
 * Returns the latest date the payload covers, or null when unavailable.
 */
function accumulationPayloadEndDate(payload) {
  if (!payload || typeof payload !== 'object') return null;
  const candidates = [payload.end_date, payload.endDate, payload.date];
  for (const value of candidates) {
    const key = String(value || '').slice(0, 10);
    if (/^\d{4}-\d{2}-\d{2}$/.test(key)) return key;
  }
  return null;
}

function classifyAccumulation(entry, duplicates, logEvidence) {
  const signals = [];
  const endDate = entry.payload_end_date;
  if (endDate && endDate > entry.logical_date) {
    signals.push(`payload_end_date_after_logical(${endDate}>${entry.logical_date})`);
  }
  if (entry.mtime_date && entry.mtime_date > entry.logical_date) {
    signals.push(`mtime_after_logical(${entry.mtime_date}>${entry.logical_date})`);
  }
  const newerDupes = duplicates.filter(d => d.logical_date > entry.logical_date);
  if (newerDupes.length > 0) {
    signals.push(`identical_to_later_dated_file(${newerDupes.map(d => d.logical_date).join(',')})`);
  }
  if (logEvidence) signals.push('execution_log_proves_historical_sweep');

  const payloadAfter = Boolean(endDate && endDate > entry.logical_date);
  const mtimeAfter = Boolean(entry.mtime_date && entry.mtime_date > entry.logical_date);
  const dupLater = newerDupes.length > 0;

  if (payloadAfter && (mtimeAfter || dupLater || logEvidence)) {
    return { classification: CLASSIFICATIONS.VERIFIED_INVALID, signals };
  }
  if (payloadAfter || (mtimeAfter && dupLater)) {
    return { classification: CLASSIFICATIONS.STRONGLY_SUSPECT, signals };
  }
  if (mtimeAfter) {
    return { classification: CLASSIFICATIONS.STRONGLY_SUSPECT, signals };
  }
  if (entry.mtime_date && entry.mtime_date < entry.logical_date) {
    return { classification: CLASSIFICATIONS.AMBIGUOUS, signals: signals.concat('mtime_before_logical') };
  }
  return { classification: CLASSIFICATIONS.VALID, signals };
}

function classifyInsiders(entry, duplicates, logEvidence) {
  const signals = [];
  const mtimeAfter = Boolean(entry.mtime_date && entry.mtime_date > entry.logical_date);
  const newerDupes = duplicates.filter(d => d.logical_date > entry.logical_date);
  const dupLater = newerDupes.length > 0;
  if (mtimeAfter) signals.push(`mtime_after_logical(${entry.mtime_date}>${entry.logical_date})`);
  if (dupLater) signals.push(`identical_to_later_dated_file(${newerDupes.map(d => d.logical_date).join(',')})`);
  if (logEvidence) signals.push('execution_log_proves_historical_sweep');

  if (mtimeAfter && (dupLater || logEvidence)) {
    return { classification: CLASSIFICATIONS.VERIFIED_INVALID, signals };
  }
  if (mtimeAfter || dupLater) {
    return { classification: CLASSIFICATIONS.STRONGLY_SUSPECT, signals };
  }
  if (entry.mtime_date && entry.mtime_date < entry.logical_date) {
    return { classification: CLASSIFICATIONS.AMBIGUOUS, signals: signals.concat('mtime_before_logical') };
  }
  return { classification: CLASSIFICATIONS.VALID, signals };
}

function classifyBrokerSummary(entry) {
  // broker-summary IS date-addressable (start_date/end_date params), so its
  // payload date must equal the logical date. A mismatch is suspicious but is
  // not part of the auxiliary contamination scope; it is never quarantine-
  // eligible from this scanner.
  const payloadDate = entry.payload_end_date;
  if (!payloadDate) return { classification: CLASSIFICATIONS.UNKNOWN, signals: [] };
  if (payloadDate === entry.logical_date) return { classification: CLASSIFICATIONS.VALID, signals: [] };
  return { classification: CLASSIFICATIONS.STRONGLY_SUSPECT, signals: [`payload_date_mismatch(${payloadDate}!=${entry.logical_date})`] };
}

/**
 * Read an execution log and extract the set of logical dates for which the
 * log PROVES a historical auxiliary sweep happened (the pre-#835 worker wrote
 * dated auxiliary files for dates it swept). A boolean flag can never stand in
 * for this — only a real log file that actually mentions the date counts.
 *
 * @param {string} logPath
 * @returns {Set<string>} dates with matching sweep evidence
 */
function extractSweepDatesFromLog(logPath) {
  const dates = new Set();
  if (!logPath) return dates;
  let content = '';
  try {
    content = fs.readFileSync(logPath, 'utf8');
  } catch (_) {
    return dates;
  }
  for (const line of content.split(/\r?\n/)) {
    // The pre-#835 worker logged "[HISTORICAL] TICKER YYYY-MM-DD disimpan ..."
    // when it wrote a dated auxiliary cache during a sweep.
    const m = /\[HISTORICAL\]\s+\S+\s+(\d{4}-\d{2}-\d{2})/.exec(line);
    if (m) dates.add(m[1]);
  }
  return dates;
}

/**
 * Scan the data root read-only and return the manifest object.
 *
 * @param {{root?: string, includeBrokerSummary?: boolean, logPath?: string}} options
 */
function scan(options = {}) {
  const root = options.root || defaultRoot();
  const includeBrokerSummary = options.includeBrokerSummary === true;
  const logDates = extractSweepDatesFromLog(options.logPath);
  const datasets = includeBrokerSummary
    ? AUXILIARY_DATASETS.concat(['broker-summary'])
    : AUXILIARY_DATASETS;

  const files = [];
  const totals = {
    scanned: 0,
    suspect_candidates: 0,
    verified_invalid: 0,
    strongly_suspect: 0,
    ambiguous: 0,
    valid: 0,
    unknown: 0
  };

  for (const dataset of datasets) {
    const datasetDir = path.join(root, dataset);
    if (!fs.existsSync(datasetDir)) continue;
    let tickerDirs = [];
    try {
      tickerDirs = fs.readdirSync(datasetDir, { withFileTypes: true }).filter(d => d.isDirectory()).map(d => d.name);
    } catch (_) { continue; }

    for (const ticker of tickerDirs) {
      const tickerDir = path.join(datasetDir, ticker);
      let names = [];
      try { names = fs.readdirSync(tickerDir); } catch (_) { continue; }

      const datedFiles = names.filter(n => /^\d{4}-\d{2}-\d{2}\.json$/.test(n));
      if (datedFiles.length === 0) continue;

      // First pass: hash + stat every dated file for this ticker/dataset so
      // duplicate evidence is available during classification.
      const entries = [];
      for (const name of datedFiles) {
        const fullPath = path.join(tickerDir, name);
        const logicalDate = name.slice(0, 10);
        let stat = null;
        try { stat = fs.statSync(fullPath); } catch (_) {}
        let hash = null;
        let payload = null;
        try {
          hash = sha256File(fullPath);
          payload = readJsonSafe(fullPath);
        } catch (_) {}
        entries.push({
          path: fullPath,
          logical_date: logicalDate,
          ticker,
          dataset,
          mtime: stat ? stat.mtime.toISOString() : null,
          mtime_date: stat ? jakartaDateOf(stat.mtime) : null,
          size: stat ? stat.size : null,
          sha256: hash,
          payload_end_date: dataset === 'broker-accumulation'
            ? accumulationPayloadEndDate(payload)
            : (dataset === 'broker-summary' ? accumulationPayloadEndDate(payload) : null),
          payload_parseable: payload != null
        });
      }

      for (const entry of entries) {
        totals.scanned++;
        if (!entry.payload_parseable && entry.sha256) {
          // A valid JSON object may legitimately be absent for insiders (the
          // payload is an array). Only flag as UNKNOWN when the file could not
          // be read/hashed at all.
        }
        let result;
        if (!entry.sha256) {
          result = { classification: CLASSIFICATIONS.UNKNOWN, signals: ['unreadable_file'] };
        } else if (!entry.payload_parseable && entry.dataset === 'broker-accumulation') {
          result = { classification: CLASSIFICATIONS.UNKNOWN, signals: ['unparseable_payload'] };
        } else if (entry.dataset === 'broker-accumulation') {
          const duplicates = entries.filter(o => o !== entry && o.sha256 && o.sha256 === entry.sha256);
          result = classifyAccumulation(entry, duplicates, logDates.has(entry.logical_date));
        } else if (entry.dataset === 'insiders') {
          const duplicates = entries.filter(o => o !== entry && o.sha256 && o.sha256 === entry.sha256);
          result = classifyInsiders(entry, duplicates, logDates.has(entry.logical_date));
        } else {
          result = classifyBrokerSummary(entry);
        }

        const duplicateEvidence = entries
          .filter(o => o !== entry && o.sha256 && o.sha256 === entry.sha256)
          .map(o => ({ path: o.path, logical_date: o.logical_date }));

        const record = {
          path: entry.path,
          logical_date: entry.logical_date,
          ticker: entry.ticker,
          dataset: entry.dataset,
          mtime: entry.mtime,
          mtime_date: entry.mtime_date,
          size: entry.size,
          sha256: entry.sha256,
          producer: 'tools/run-daily-broker-update.js (dated persistDatedCache)',
          endpoint_semantics: 'current_snapshot_only',
          historical_date_param: entry.dataset === 'broker-summary' ? 'YES' : 'NO',
          payload_end_date: entry.payload_end_date,
          duplicate_evidence: duplicateEvidence,
          classification: result.classification,
          reason: result.signals.join('; ') || 'no_invalidity_signal'
        };
        files.push(record);

        if (record.classification === CLASSIFICATIONS.VERIFIED_INVALID) totals.verified_invalid++;
        else if (record.classification === CLASSIFICATIONS.STRONGLY_SUSPECT) totals.strongly_suspect++;
        else if (record.classification === CLASSIFICATIONS.AMBIGUOUS) totals.ambiguous++;
        else if (record.classification === CLASSIFICATIONS.VALID) totals.valid++;
        else totals.unknown++;
        if ([CLASSIFICATIONS.VERIFIED_INVALID, CLASSIFICATIONS.STRONGLY_SUSPECT].includes(record.classification)) {
          totals.suspect_candidates++;
        }
      }
    }
  }

  return {
    tool: 'scan-aux-provenance',
    version: 1,
    generated_at: new Date().toISOString(),
    root,
    read_only: true,
    historical_estimate: 5100,
    totals,
    files
  };
}

function printSummary(manifest) {
  const t = manifest.totals;
  console.log('=== AUXILIARY DATA PROVENANCE SCAN (READ-ONLY) ===');
  console.log(`Root: ${manifest.root}`);
  console.log(`TOTAL_FILES_SCANNED:  ${t.scanned}`);
  console.log(`SUSPECT_CANDIDATES:   ${t.suspect_candidates}`);
  console.log(`VERIFIED_INVALID:     ${t.verified_invalid}`);
  console.log(`STRONGLY_SUSPECT:     ${t.strongly_suspect}`);
  console.log(`AMBIGUOUS:            ${t.ambiguous}`);
  console.log(`VALID:                ${t.valid}`);
  console.log(`UNKNOWN:              ${t.unknown}`);
  console.log(`Historical estimate (input): ${manifest.historical_estimate}`);
  console.log('No file was moved, modified, or deleted.');
}

function main(argv) {
  const args = argv || process.argv.slice(2);
  const rootIdx = args.indexOf('--root');
  const outIdx = args.indexOf('--out');
  const logIdx = args.indexOf('--log-path');
  const manifest = scan({
    root: rootIdx >= 0 ? args[rootIdx + 1] : undefined,
    includeBrokerSummary: args.includes('--include-broker-summary'),
    logPath: logIdx >= 0 ? args[logIdx + 1] : undefined
  });
  if (outIdx >= 0 && args[outIdx + 1]) {
    fs.writeFileSync(args[outIdx + 1], JSON.stringify(manifest, null, 2));
    console.log(`Manifest written: ${args[outIdx + 1]}`);
  }
  if (args.includes('--json')) {
    console.log(JSON.stringify(manifest, null, 2));
  } else {
    printSummary(manifest);
  }
  return manifest;
}

if (require.main === module) {
  try {
    main();
  } catch (err) {
    console.error('Scanner failed:', err && err.message ? err.message : err);
    process.exit(1);
  }
}

module.exports = { scan, main, CLASSIFICATIONS, AUXILIARY_DATASETS, accumulationPayloadEndDate, jakartaDateOf, extractSweepDatesFromLog };
