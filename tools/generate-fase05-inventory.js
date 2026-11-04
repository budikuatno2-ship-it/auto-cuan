'use strict';
const fs = require('fs');
const path = require('path');

const baseDir = fs.existsSync('/home/ubuntu/auto-cuan') 
  ? '/home/ubuntu/auto-cuan' 
  : path.resolve(__dirname, '..');

const allDir = path.join(baseDir, 'data', 'arjum-data', 'broker-summary');
const fDir = path.join(baseDir, 'data', 'arjum-data', 'broker-summary-F');

const allTickers = fs.existsSync(allDir) 
  ? fs.readdirSync(allDir).filter(t => {
      try { return fs.statSync(path.join(allDir, t)).isDirectory(); } catch { return false; }
    }).sort()
  : [];

const fTickers = fs.existsSync(fDir)
  ? fs.readdirSync(fDir).filter(t => {
      try { return fs.statSync(path.join(fDir, t)).isDirectory(); } catch { return false; }
    }).sort()
  : [];

const allTickersSet = new Set(allTickers);
const fTickersSet = new Set(fTickers);
const unionTickers = Array.from(new Set([...allTickers, ...fTickers])).sort();

const inventory = {
  meta: {
    scanned_at: new Date().toISOString(),
    base_dir: baseDir,
    quota_used: 0,
    zero_upstream_quota: true,
    total_union_tickers: unionTickers.length,
    all_dir_tickers_count: allTickers.length,
    f_dir_tickers_count: fTickers.length
  },
  global_date_range: {
    min_date: null,
    max_date: null,
    total_distinct_dates: 0
  },
  summary: {
    tickers_with_all: 0,
    tickers_with_f: 0,
    tickers_with_both: 0,
    tickers_with_all_only: 0,
    tickers_with_f_only: 0,
    total_all_files: 0,
    total_f_files: 0,
    total_matching_date_pairs: 0,
    total_missing_f_dates: 0
  },
  tickers: {}
};

const globalDatesSet = new Set();

for (const ticker of unionTickers) {
  const tAllPath = path.join(allDir, ticker);
  const tFPath = path.join(fDir, ticker);

  const allDates = fs.existsSync(tAllPath)
    ? fs.readdirSync(tAllPath).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f => f.slice(0, 10)).sort()
    : [];

  const fDates = fs.existsSync(tFPath)
    ? fs.readdirSync(tFPath).filter(f => /^\d{4}-\d{2}-\d{2}\.json$/.test(f)).map(f => f.slice(0, 10)).sort()
    : [];

  allDates.forEach(d => globalDatesSet.add(d));
  fDates.forEach(d => globalDatesSet.add(d));

  const fDateSet = new Set(fDates);
  let matchingCount = 0;
  let missingFCount = 0;

  for (const d of allDates) {
    if (fDateSet.has(d)) {
      matchingCount++;
    } else {
      missingFCount++;
    }
  }

  const hasAll = allDates.length > 0;
  const hasF = fDates.length > 0;

  if (hasAll) inventory.summary.tickers_with_all++;
  if (hasF) inventory.summary.tickers_with_f++;
  if (hasAll && hasF) inventory.summary.tickers_with_both++;
  if (hasAll && !hasF) inventory.summary.tickers_with_all_only++;
  if (!hasAll && hasF) inventory.summary.tickers_with_f_only++;

  inventory.summary.total_all_files += allDates.length;
  inventory.summary.total_f_files += fDates.length;
  inventory.summary.total_matching_date_pairs += matchingCount;
  inventory.summary.total_missing_f_dates += missingFCount;

  inventory.tickers[ticker] = {
    has_all: hasAll,
    has_f: hasF,
    all_count: allDates.length,
    f_count: fDates.length,
    matching_pairs: matchingCount,
    missing_f_count: missingFCount,
    all_min_date: allDates[0] || null,
    all_max_date: allDates[allDates.length - 1] || null,
    f_min_date: fDates[0] || null,
    f_max_date: fDates[fDates.length - 1] || null
  };
}

const sortedGlobalDates = Array.from(globalDatesSet).sort();
inventory.global_date_range.min_date = sortedGlobalDates[0] || null;
inventory.global_date_range.max_date = sortedGlobalDates[sortedGlobalDates.length - 1] || null;
inventory.global_date_range.total_distinct_dates = sortedGlobalDates.length;

console.log(JSON.stringify({
  meta: inventory.meta,
  global_date_range: inventory.global_date_range,
  summary: inventory.summary
}, null, 2));

// Save output
const outPath = path.join(baseDir, 'bukti-verifikasi-final', 'fase05', 'inventaris-arsip.json');
fs.mkdirSync(path.dirname(outPath), { recursive: true });
fs.writeFileSync(outPath, JSON.stringify(inventory, null, 2), 'utf8');
console.log('Saved inventory to:', outPath);
