'use strict';
/**
 * V3-F11 compress-broksum-archive — indeks + kompresi arsip lama di luar
 * jendela aktif (hemat hingga 80%) TANPA hapus histori.
 *
 * Strategi: untuk tiap data/broker-accumulation/<T>.json, pisahkan
 * history lama (> ACTIVE_WINDOW_DAYS, default 30 hari dari end_date)
 * ke data/broker-accumulation/archive/<T>.history.json.gz (gzip),
 * lalu tulis ulang berkas aktif hanya berisi jendela aktif + indeks arsip.
 * Berkas aktif tetap memuat latest + windows 1H-20H penuh (fitur tidak berubah).
 * Arsip .gz tetap di disk (tidak dihapus) + indeks archive-index.json.
 * Idempoten: dapat dijalankan ulang dengan aman.
 *
 * Windows-safe: node scripts/compress-broksum-archive.js [--window=30] [--dry-run]
 */
const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

const ROOT = path.resolve(__dirname, '..');
const BROK_DIR = path.join(ROOT, 'data', 'broker-accumulation');
const ARCHIVE_DIR = path.join(BROK_DIR, 'archive');

function parseArgs() {
  const out = { window: 30, dryRun: false };
  for (const a of process.argv.slice(2)) {
    if (a.startsWith('--window=')) out.window = Math.max(1, parseInt(a.slice(9), 10) || 30);
    if (a === '--dry-run') out.dryRun = true;
  }
  return out;
}

function dayDiff(a, b) {
  const da = new Date(a + 'T00:00:00Z').getTime();
  const db = new Date(b + 'T00:00:00Z').getTime();
  if (!Number.isFinite(da) || !Number.isFinite(db)) return 0;
  return Math.round((db - da) / 86400000);
}

function main() {
  const args = parseArgs();
  fs.mkdirSync(ARCHIVE_DIR, { recursive: true });
  const files = fs.readdirSync(BROK_DIR).filter((f) => f.endsWith('.json'));
  let scanned = 0;
  let archivedTickers = 0;
  let activeBytes = 0;
  let archiveBytes = 0;
  let savedBytes = 0;
  const perTicker = [];
  for (const fn of files) {
    const fp = path.join(BROK_DIR, fn);
    let j = null;
    try { j = JSON.parse(fs.readFileSync(fp, 'utf8')); } catch (_) { continue; }
    if (!j || typeof j !== 'object' || !j.history || typeof j.history !== 'object') continue;
    scanned += 1;
    const ticker = j.ticker || fn.replace(/\.json$/, '');
    const endDate = j.end_date || j.latest?.date || null;
    const dates = Object.keys(j.history).sort();
    if (!endDate || dates.length <= args.window) {
      // Tidak ada yang diarsipkan; tetap catat ukuran aktif.
      try { activeBytes += fs.statSync(fp).size; } catch (_) {}
      perTicker.push({ ticker, archived_days: 0, active_days: dates.length, note: 'within-window' });
      continue;
    }
    const oldDates = dates.filter((d) => dayDiff(d, endDate) > args.window);
    const keepDates = dates.filter((d) => dayDiff(d, endDate) <= args.window);
    if (!oldDates.length) {
      try { activeBytes += fs.statSync(fp).size; } catch (_) {}
      perTicker.push({ ticker, archived_days: 0, active_days: dates.length, note: 'within-window' });
      continue;
    }
    const archiveObj = { ticker, end_date: endDate, window_days: args.window, archived_at: new Date().toISOString(), history: {} };
    for (const d of oldDates) archiveObj.history[d] = j.history[d];
    const gz = zlib.gzipSync(Buffer.from(JSON.stringify(archiveObj), 'utf8'), { level: 9 });
    const gzName = ticker + '.history.json.gz';
    const idxEntry = {
      ticker, archived_days: oldDates.length, active_days: keepDates.length,
      archive_file: 'archive/' + gzName,
      archive_bytes: gz.length,
      window_days: args.window, end_date: endDate
    };
    if (!args.dryRun) {
      fs.writeFileSync(path.join(ARCHIVE_DIR, gzName), gz);
      const kept = {};
      for (const d of keepDates) kept[d] = j.history[d];
      const next = Object.assign({}, j, { history: kept });
      next.archive = {
        archived: true, archive_file: 'archive/' + gzName,
        archived_days: oldDates.length, active_days: keepDates.length,
        window_days: args.window, archived_at: archiveObj.archived_at
      };
      const before = (() => { try { return fs.statSync(fp).size; } catch (_) { return 0; } })();
      fs.writeFileSync(fp, JSON.stringify(next));
      const after = (() => { try { return fs.statSync(fp).size; } catch (_) { return 0; } })();
      activeBytes += after;
      archiveBytes += gz.length;
      savedBytes += Math.max(0, before - after);
    } else {
      try { activeBytes += fs.statSync(fp).size; } catch (_) {}
      archiveBytes += gz.length;
    }
    archivedTickers += 1;
    perTicker.push(idxEntry);
  }
  const totalBefore = activeBytes + savedBytes;
  const ratio = totalBefore > 0 ? Number((savedBytes / totalBefore).toFixed(4)) : 0;
  const report = {
    version: 'v3-f11-1',
    window_days: args.window,
    dry_run: args.dryRun,
    scanned_brok_files: scanned,
    archived_tickers: archivedTickers,
    active_bytes: activeBytes,
    archive_bytes: archiveBytes,
    saved_bytes: savedBytes,
    saved_ratio: ratio,
    saved_pct: Number((ratio * 100).toFixed(2)),
    history_preserved: true,
    deleted_history_files: 0,
    generated_at: new Date().toISOString(),
    tickers: perTicker
  };
  if (!args.dryRun) {
    fs.writeFileSync(path.join(BROK_DIR, 'archive-index.json'), JSON.stringify({
      version: 'v3-f11-1', window_days: args.window,
      archived_tickers: archivedTickers, generated_at: report.generated_at,
      tickers: perTicker
    }, null, 2));
    fs.writeFileSync(path.join(ARCHIVE_DIR, '_compress-report.json'), JSON.stringify(report, null, 2));
  }
  console.log(JSON.stringify({ scanned: report.scanned_brok_files, archived: archivedTickers, saved_pct: report.saved_pct, dry_run: args.dryRun }));
}

main();
