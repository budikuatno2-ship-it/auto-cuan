'use strict';

/**
 * scripts/backfill-fundamental-publication-dates.js
 * ============================================================================
 * V5 Phase 3 (N10) — one-off offline migration.
 * ============================================================================
 * Stamps every fundamental item under data/fundamental/**.json with a
 * publication date so live surfaces can order consumption against it.
 *
 * The stamped value is the CONSERVATIVE regulatory filing deadline for the
 * period (see lib/publication-lag.js deriveRegulatoryDeadline): the latest
 * date the issuer was allowed to publish, never an invented earlier date.
 * Gating consumption on an upper bound can never expose the data before it
 * was really public — that is the point.
 *
 * Items already carrying a publication date key are left untouched.
 *
 * Run:  node scripts/backfill-fundamental-publication-dates.js
 * ============================================================================
 */

const fs = require('fs');
const path = require('path');
const { deriveRegulatoryDeadline } = require('../lib/publication-lag');

const ROOT = path.resolve(__dirname, '..');
const FUND_DIR = path.join(ROOT, 'data', 'fundamental');

function walk(dir, out) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, out);
    else if (entry.name.endsWith('.json')) out.push(full);
  }
  return out;
}

function rel(p) { return path.relative(ROOT, p); }

function main() {
  if (!fs.existsSync(FUND_DIR)) {
    console.log('[backfill] data/fundamental absent — nothing to do');
    process.exit(0);
  }
  const files = walk(FUND_DIR, []);
  let filesWritten = 0;
  let itemsStamped = 0;
  let itemsAlreadyDated = 0;
  let itemsUndatable = 0;

  for (const file of files) {
    let doc;
    try {
      doc = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch (err) {
      console.warn('[backfill] SKIP unreadable JSON: ' + rel(file) + ' — ' + err.message);
      continue;
    }
    const list = (doc && doc.data && doc.data.items) || [];
    let changed = false;
    for (const item of list) {
      if (!item || typeof item !== 'object') continue;
      const hasPublication = [
        'published_at', 'publication_date', 'publish_date',
        'announcement_date', 'announced_at', 'filing_date', 'effective_date'
      ].some((k) => k in item);
      if (hasPublication) { itemsAlreadyDated += 1; continue; }

      const derived = deriveRegulatoryDeadline(item.quarter || item.label, item.year);
      if (!derived.publishedAt) {
        itemsUndatable += 1;
        console.warn('[backfill] WARN no derivable period for item in ' + rel(file) +
          ' (quarter=' + item.quarter + ', year=' + item.year + ')');
        continue;
      }
      item.published_at = derived.publishedAt.toISOString();
      item.publication_basis = derived.basis;
      item.period_end = derived.periodEnd;
      itemsStamped += 1;
      changed = true;
    }
    if (changed) {
      fs.writeFileSync(file, JSON.stringify(doc, null, 2) + '\n', 'utf8');
      filesWritten += 1;
    }
  }

  console.log('[backfill] files examined   : ' + files.length);
  console.log('[backfill] files rewritten  : ' + filesWritten);
  console.log('[backfill] items stamped    : ' + itemsStamped);
  console.log('[backfill] items already dated: ' + itemsAlreadyDated);
  console.log('[backfill] items undatable  : ' + itemsUndatable);
}

main();
