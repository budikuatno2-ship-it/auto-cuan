'use strict';
const fs = require('fs');
const path = require('path');

const D = '/home/ubuntu/auto-cuan/data/arjum-data';
const fBase = path.join(D, 'broker-summary-F');
const qBase = path.join(D, '_quarantine-F-20261018');
const backfillDir = path.join(D, '_backfill');
const statePath = path.join(backfillDir, 'state.json');
const stateBackupPath = path.join(backfillDir, 'state.backup-20261018.json');

console.log('=== B.2: BACKUP STATE.JSON ===');
if (fs.existsSync(statePath)) {
  fs.copyFileSync(statePath, stateBackupPath);
  console.log(`Backup berhasil: ${stateBackupPath}`);
} else {
  console.log(`Peringatan: ${statePath} tidak ditemukan!`);
}

let state = { completedTasks: {}, completedTickers: {}, totalSent: 0 };
if (fs.existsSync(statePath)) {
  try {
    state = JSON.parse(fs.readFileSync(statePath, 'utf8'));
  } catch (e) {
    console.error('Gagal membaca state.json:', e);
  }
}

console.log('=== B.1: PROSES KARANTINA FILE NON-F ===');
fs.mkdirSync(qBase, { recursive: true });

let keptCount = 0;
let quarantinedCount = 0;
let deletedStateTasks = 0;
let deletedStateTickers = 0;

const tickers = fs.readdirSync(fBase);

for (const ticker of tickers) {
  const tDir = path.join(fBase, ticker);
  let stat;
  try { stat = fs.statSync(tDir); } catch (_) { continue; }
  if (!stat.isDirectory()) continue;

  const files = fs.readdirSync(tDir).filter(f => f.endsWith('.json'));
  let tickerHadQuarantine = false;

  for (const f of files) {
    const p = path.join(tDir, f);
    const date = f.replace('.json', '');
    const taskKeyF = `${ticker}_${date}_F`;

    let shouldQuarantine = false;
    try {
      const content = fs.readFileSync(p, 'utf8');
      const parsed = JSON.parse(content);
      const codeInFile = String(parsed.stock_code || parsed.code || '').trim().toUpperCase();

      if (parsed.flow !== 'F' || (codeInFile && codeInFile !== ticker.toUpperCase())) {
        shouldQuarantine = true;
      }
    } catch (_) {
      shouldQuarantine = true;
    }

    if (shouldQuarantine) {
      quarantinedCount++;
      tickerHadQuarantine = true;
      const targetDir = path.join(qBase, ticker);
      if (!fs.existsSync(targetDir)) fs.mkdirSync(targetDir, { recursive: true });
      fs.renameSync(p, path.join(targetDir, f));

      if (state.completedTasks && state.completedTasks[taskKeyF]) {
        delete state.completedTasks[taskKeyF];
        deletedStateTasks++;
      }
    } else {
      keptCount++;
    }
  }

  // Bersihkan folder ticker jika kosong
  const remainingFiles = fs.readdirSync(tDir).filter(f => f.endsWith('.json'));
  if (remainingFiles.length === 0) {
    try { fs.rmdirSync(tDir); } catch (_) {}
  }

  if (tickerHadQuarantine && state.completedTickers && state.completedTickers[ticker]) {
    delete state.completedTickers[ticker];
    deletedStateTickers++;
  }
}

// Simpan state.json yang sudah dibersihkan
fs.writeFileSync(statePath, JSON.stringify(state, null, 2), 'utf8');

console.log('=== HASIL KARANTINA DAN UPDATE STATE ===');
console.log(JSON.stringify({
  keptFilesCount: keptCount,
  quarantinedFilesCount: quarantinedCount,
  deletedStateTasks,
  deletedStateTickers,
  remainingCompletedTasksInState: Object.keys(state.completedTasks || {}).length,
  remainingCompletedTickersInState: Object.keys(state.completedTickers || {}).length
}, null, 2));
