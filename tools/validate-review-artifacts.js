#!/usr/bin/env node
'use strict';
/**
 * M-P2a validator — every PAYLOAD artifact with a .csv/.json extension must
 * actually parse as that format (RFC-4180 for CSV with declared column-count
 * consistency; JSON.parse for .json). Fails loudly (non-zero exit) on any
 * violation. .gz CSVs are gunzipped then validated as CSV.
 *
 * Usage:
 *   node tools/validate-review-artifacts.js <staged-payload-root>
 *   node tools/validate-review-artifacts.js <run-dir> --logs   (also validate LOGS dir)
 *
 * Output: human-readable log on stdout; exits 1 if any artifact fails.
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

// ── RFC-4180 parser (quotes, escaped quotes, CRLF, embedded newlines) ──────
function parseRfc4180(text) {
  const rows = [];
  let row = [];
  let field = '';
  let inQuotes = false;
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i += 2; continue; }
        inQuotes = false; i += 1; continue;
      }
      field += c; i += 1; continue;
    }
    if (c === '"') { inQuotes = true; i += 1; continue; }
    if (c === ',') { row.push(field); field = ''; i += 1; continue; }
    if (c === '\r') { i += 1; continue; }
    if (c === '\n') { row.push(field); rows.push(row); row = []; field = ''; i += 1; continue; }
    field += c; i += 1;
  }
  if (field !== '' || row.length) { row.push(field); rows.push(row); }
  return rows;
}

// Markdown pointer / prose sniff: header line starting with '#' or blank.
function looksLikeProse(text) {
  const head = text.slice(0, 512);
  return /^\s*#/.test(head) && !/^"?\s*#/.test('');
}

function validateCsv(relPath, bytes) {
  const errors = [];
  let text;
  try {
    text = bytes.toString('utf8');
  } catch (e) {
    return [`UTF-8 decode failed: ${e.message}`];
  }
  if (/\u0000/.test(text.slice(0, 4096))) {
    errors.push('contains NUL bytes (likely UTF-16 or binary mislabeled as CSV)');
    return errors;
  }
  const rows = parseRfc4180(text);
  if (rows.length === 0) { errors.push('empty CSV'); return errors; }
  if (looksLikeProse(text) && rows.length > 0 && rows[0].length === 1 && rows[0][0].startsWith('#')) {
    errors.push('content looks like Markdown/prose, not CSV');
    return errors;
  }
  const hdrCols = rows[0].length;
  const dist = {};
  for (const r of rows) dist[r.length] = (dist[r.length] || 0) + 1;
  const mismatch = Object.keys(dist).filter((k) => Number(k) !== hdrCols);
  if (mismatch.length > 0) {
    const offenders = mismatch.map((k) => `${k} cols x${dist[k]}`).join(', ');
    errors.push(`inconsistent column counts (header=${hdrCols}): ${offenders}`);
  }
  return errors;
}

function validateJson(relPath, bytes) {
  const errors = [];
  const text = bytes.toString('utf8');
  if (/^\s*(bash|sh|zsh)\b/.test(text)) {
    errors.push('content is shell output/error log, not JSON');
    return errors;
  }
  try {
    JSON.parse(text);
  } catch (e) {
    errors.push(`JSON.parse failed: ${e.message}`);
  }
  return errors;
}

function walk(dir, base, out) {
  if (!fs.existsSync(dir)) return out;
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, e.name);
    const rel = base ? base + '/' + e.name : e.name;
    if (e.isDirectory()) walk(full, rel, out);
    else if (e.isFile()) out.push({ rel, full });
  }
  return out;
}

function main() {
  const args = process.argv.slice(2).filter((a) => !a.startsWith('--'));
  const includeLogs = process.argv.includes('--logs');
  if (args.length === 0) {
    console.error('Usage: node tools/validate-review-artifacts.js <staged-payload-root> [--logs]');
    process.exit(2);
  }
  const root = path.resolve(args[0]);
  if (!fs.existsSync(root)) {
    console.error(`FATAL: root not found: ${root}`);
    process.exit(2);
  }

  const targets = walk(root, '', []);
  // The ZIP payload may nest under PAYLOAD/; artifact scan covers the whole run tree,
  // but LOGS/ only when --logs is passed.
  const scoped = targets.filter((t) => includeLogs || !t.rel.includes('/LOGS/') || t.rel.startsWith('PAYLOAD'));

  let checked = 0;
  let failed = 0;
  const lines = [];
  lines.push(`V6 ARTIFACT FORMAT VERIFICATION`);
  lines.push(`root: ${root}`);
  lines.push(`logs_scoped: ${includeLogs ? 'included' : 'excluded (except PAYLOAD)'}`);
  lines.push(`files_scanned: ${scoped.length}`);
  lines.push('');

  for (const t of scoped.sort((a, b) => a.rel.localeCompare(b.rel))) {
    const name = path.basename(t.rel);
    let bytes;
    let kind = null; // 'csv' | 'json'
    if (name.toLowerCase().endsWith('.csv.gz') || (name.toLowerCase().endsWith('.gz') && name.toLowerCase().includes('csv'))) {
      kind = 'csv';
      try { bytes = zlib.gunzipSync(fs.readFileSync(t.full)); }
      catch (e) { lines.push(`[FAIL] ${t.rel}: gunzip failed: ${e.message}`); failed += 1; continue; }
    } else if (name.toLowerCase().endsWith('.csv')) {
      kind = 'csv';
      bytes = fs.readFileSync(t.full);
    } else if (name.toLowerCase().endsWith('.json')) {
      kind = 'json';
      bytes = fs.readFileSync(t.full);
    } else {
      continue; // not a .csv/.json payload artifact
    }
    checked += 1;
    const errors = kind === 'csv' ? validateCsv(t.rel, bytes) : validateJson(t.rel, bytes);
    if (errors.length) {
      failed += 1;
      lines.push(`[FAIL] ${t.rel}`);
      for (const e of errors) lines.push(`       -> ${e}`);
    } else {
      const note = kind === 'csv'
        ? `ok (RFC-4180, uniform cols)`
        : `ok (JSON.parse)`;
      lines.push(`[PASS] ${t.rel}: ${note}`);
    }
  }

  lines.push('');
  lines.push(`SUMMARY: checked=${checked} failed=${failed}`);
  lines.push(`VERDICT: ${failed === 0 ? 'PASS' : 'FAIL'}`);
  const out = lines.join('\n');
  console.log(out);
  process.exit(failed === 0 ? 0 : 1);
}

main();
