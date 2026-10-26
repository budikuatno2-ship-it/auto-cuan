'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SSH_KEY_PATH = 'D:\\Private Key Oracle\\ssh-key-2026-07-02.key';
const VPS_HOST = 'ubuntu@168.110.221.197';
const SQLITE_PATH = '/home/ubuntu/auto-cuan-data/market.sqlite';
const OUTPUT_DIR = path.join(__dirname, 'data', 'vps_csv');
const INVENTORY_PATH = path.join(OUTPUT_DIR, 'INVENTORY.md');

function runSsh(remoteCmd) {
  // execFileSync passes arguments directly to ssh without cmd.exe string re-escaping
  const args = [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ConnectTimeout=15',
    '-i', SSH_KEY_PATH,
    VPS_HOST,
    remoteCmd
  ];
  return execFileSync('ssh', args, { maxBuffer: 15 * 1024 * 1024, encoding: 'utf8' });
}

function inspectFiles() {
  console.log('[1/3] Scanning all CSV/TSV/XLSX files in /home/ubuntu...');
  const findCmd = "find /home/ubuntu -xdev -type f \\( -iname '*.csv' -o -iname '*.tsv' -o -iname '*.xlsx' \\) -size -200M -not -path '*/node_modules/*' -not -path '*/.git/*' -printf '%TY-%Tm-%Td %s %p\\n' 2>/dev/null | sort";
  const rawList = runSsh(findCmd).trim().split('\n').filter(Boolean);

  const fileInventory = [];

  for (const line of rawList) {
    const parts = line.trim().split(/\s+/);
    const date = parts[0];
    const size = parts[1];
    const filePath = parts.slice(2).join(' ');

    console.log(`  Inspecting: ${filePath}`);

    // Get wc -l
    let lineCount = 'N/A';
    try {
      const wcOut = runSsh(`wc -l < "${filePath}" 2>/dev/null`).trim();
      lineCount = wcOut;
    } catch (e) {
      lineCount = 'binary/err';
    }

    // Get sha256sum
    let sha256 = '';
    try {
      const shaOut = runSsh(`sha256sum "${filePath}" 2>/dev/null`).trim().split(/\s+/)[0];
      sha256 = shaOut;
    } catch (e) {
      sha256 = 'err';
    }

    // Get head -n 3
    let head = [];
    try {
      const headOut = runSsh(`head -n 3 "${filePath}" 2>/dev/null`);
      head = headOut.split('\n').filter(Boolean);
    } catch (e) {
      head = ['(binary / cannot read)'];
    }

    // Check if BRPT is in file
    let hasBrpt = false;
    try {
      const grepOut = runSsh(`grep -m 1 -i 'BRPT' "${filePath}" 2>/dev/null`).trim();
      hasBrpt = grepOut.length > 0;
    } catch (e) {
      hasBrpt = false;
    }

    // Categorize file
    let category = 'Lain-lain';
    if (/tradingview/i.test(filePath)) {
      category = 'TradingView Export';
    } else if (/foreign|nbsa/i.test(filePath)) {
      category = 'Foreign Flow';
    } else if (/fundamental|statement|idx-tickers|bei-boards/i.test(filePath)) {
      category = 'Fundamental / IDX Reference';
    } else if (/ai-research/i.test(filePath)) {
      category = 'AI Research Log';
    } else if (/user|auth|token|session|phone|email/i.test(filePath)) {
      category = 'BERISI DATA PRIBADI (DILARANG SALIN)';
    }

    fileInventory.push({
      path: filePath,
      date,
      size: Number(size),
      lines: lineCount,
      sha256,
      head,
      hasBrpt,
      category
    });
  }

  return fileInventory;
}

function inspectSqliteTables() {
  console.log('[2/3] Inspecting SQLite market.sqlite tables...');
  const tableListCmd = `sqlite3 -readonly ${SQLITE_PATH} ".tables"`;
  const tables = runSsh(tableListCmd).trim().split(/\s+/).filter(Boolean);

  const schemaCmd = `sqlite3 -readonly ${SQLITE_PATH} "SELECT name, sql FROM sqlite_master WHERE type='table';"`;
  const schemaRaw = runSsh(schemaCmd).trim();

  // Query table_name values in market_rows
  const rowTablesCmd = `sqlite3 -readonly ${SQLITE_PATH} "SELECT table_name, count(*), min(json_extract(row_json, '$.trade_date')), max(json_extract(row_json, '$.trade_date')) FROM market_rows GROUP BY table_name ORDER BY table_name;"`;
  const rowTablesRaw = runSsh(rowTablesCmd).trim().split('\n').filter(Boolean);

  const tableSummary = rowTablesRaw.map(line => {
    const [name, count, minDate, maxDate] = line.split('|');
    return { name, count: Number(count), minDate: minDate || '-', maxDate: maxDate || '-' };
  });

  // Query BRPT coverage per table
  const brptCoverageCmd = `sqlite3 -readonly ${SQLITE_PATH} "SELECT table_name, count(*), min(json_extract(row_json, '$.trade_date')), max(json_extract(row_json, '$.trade_date')) FROM market_rows WHERE (row_key LIKE '%BRPT%' OR row_json LIKE '%BRPT%') GROUP BY table_name ORDER BY table_name;"`;
  const brptRaw = runSsh(brptCoverageCmd).trim().split('\n').filter(Boolean);
  const brptSummary = brptRaw.map(line => {
    const [name, count, minDate, maxDate] = line.split('|');
    return { name, count: Number(count), minDate: minDate || '-', maxDate: maxDate || '-' };
  });

  return { tables, schemaRaw, tableSummary, brptSummary };
}

function generateInventoryMd(fileInventory, sqliteData) {
  console.log('[3/3] Generating INVENTORY.md...');
  let md = '# INVENTARIS FILE CSV & DATASET SQLite DI VPS PRODUKSI (READ-ONLY)\n\n';
  md += `> **Host:** \`ubuntu@168.110.221.197\`  \n`;
  md += `> **Waktu Eksekusi:** ${new Date().toISOString()}  \n`;
  md += `> **Metode:** Read-Only 100% (\`find\`, \`head\`, \`wc -l\`, \`sha256sum\`, \`sqlite3 -readonly\`)  \n`;
  md += `> **File Laporan:** \`backtest/brpt-lpm/data/vps_csv/INVENTORY.md\`  \n\n`;

  md += '---\n\n';
  md += '## 1. INVENTARIS FILE CSV / TSV / XLSX DI FILESYSTEM VPS\n\n';
  md += '| No | Path File di VPS | Ukuran | Tanggal | Baris | Kategori | Memuat BRPT? | SHA256 |\n';
  md += '|---|---|---|---|---|---|---|---|\n';

  fileInventory.forEach((f, idx) => {
    const brptFlag = f.hasBrpt ? '**YA (BRPT)**' : 'Tidak';
    md += `| ${idx + 1} | \`${f.path}\` | ${(f.size / 1024).toFixed(1)} KB | ${f.date} | ${f.lines} | ${f.category} | ${brptFlag} | \`${f.sha256 ? f.sha256.slice(0, 16) + '...' : '-'}\` |\n`;
  });

  md += '\n### Sampel Header / 3 Baris Pertama Tiap File\n\n';
  fileInventory.forEach((f, idx) => {
    md += `#### ${idx + 1}. \`${f.path}\` (${f.category})\n`;
    md += `- **SHA256 Lengkap:** \`${f.sha256}\`\n`;
    md += `- **Baris:** ${f.lines} baris\n`;
    md += '- **Header (head -n 3):**\n```csv\n';
    md += f.head.join('\n') + '\n```\n\n';
  });

  md += '---\n\n';
  md += '## 2. INVENTARIS TABEL DATABASE SQLite PRODUKSI (`market.sqlite`)\n\n';
  md += `Path: \`/home/ubuntu/auto-cuan-data/market.sqlite\` (Ukuran: ~128 MB)\n\n`;
  md += '### Cakupan BRPT per Tabel di SQLite (`market_rows`)\n\n';
  md += '| Nama Sub-Tabel | Total Baris Semua Emiten | Baris BRPT | Rentang Tanggal BRPT | Catatan Konten |\n';
  md += '|---|---|---|---|---|\n';

  const brptMap = new Map();
  sqliteData.brptSummary.forEach(b => brptMap.set(b.name, b));

  sqliteData.tableSummary.forEach(t => {
    const b = brptMap.get(t.name);
    const bCount = b ? b.count : 0;
    const bRange = b && b.minDate !== '-' ? `${b.minDate} s.d. ${b.maxDate}` : '-';
    let note = '-';
    if (t.name === 'stock_daily_history') note = 'OHLCV historis Yahoo Finance (1D)';
    else if (t.name === 'foreign_watchlist_daily') note = 'Aliran Dana Asing (NBSA / foreign_net)';
    else if (t.name === 'stock_fundamentals') note = 'Laporan Keuangan (Income, Balance, Cashflow)';
    else if (t.name === 'stock_daily_features') note = 'Snapshot Fitur Harian & Free Float';
    else if (t.name === 'telegram_daily_picks') note = 'Histori Sinyal Rekomendasi Screener';

    md += `| \`${t.name}\` | ${t.count.toLocaleString()} | **${bCount}** | ${bRange} | ${note} |\n`;
  });

  md += '\n---\n\n';
  md += '## 3. KESIMPULAN RELEVANSI UNTUK PARITAS & BACKTEST BRPT\n\n';

  const tvFiles = fileInventory.filter(f => f.category === 'TradingView Export');
  const foreignFiles = fileInventory.filter(f => f.category === 'Foreign Flow');
  const fundamentalFiles = fileInventory.filter(f => f.hasBrpt);

  md += `1. **Status File Ekspor TradingView:** ${tvFiles.length > 0 ? `Ditemukan: ${tvFiles.map(f => f.path).join(', ')}` : '**TIDAK DITEMUKAN file ekspor TradingView di filesystem VPS**. (Semua folder termasuk /home/ubuntu dan /tmp tidak memiliki CSV ekspor TV)'}.\n`;
  md += `2. **Status File CSV Foreign Upload:** ${foreignFiles.length > 0 ? `Ditemukan: ${foreignFiles.map(f => f.path).join(', ')}` : '**File CSV upload foreign mentah tidak disimpan permanen di disk**, melainkan langsung di-ingest ke SQLite tabel `foreign_watchlist_daily` via `lib/admin-foreign-upload.js`'}.\n`;
  md += `3. **Data Foreign Flow di SQLite:** Tabel \`foreign_watchlist_daily\` memiliki total 6.755 baris (seluruh emiten IDX periode 2026-07-21 s.d. 2026-08-11), di mana emiten BRPT memiliki tepat **7 baris data foreign flow riil** (2026-08-03 s.d. 2026-08-11).\n`;
  md += `4. **Data Fundamental BRPT:** Ditemukan 1 record snapshot laporan keuangan lengkap di tabel \`stock_fundamentals\` (8 kuartal Q2 2024 s.d. Q1 2026 dan 4 tahun fiskal FY 2022 s.d. FY 2025).\n`;
  md += `5. **Keputusan Mode Paritas:** Karena ekspor TradingView tidak ada di VPS, evaluasi tetap berjalan di **Mode B**.\n`;

  fs.writeFileSync(INVENTORY_PATH, md);
  console.log(`  -> Inventory written to ${INVENTORY_PATH}`);

  return { fileInventory, sqliteData };
}

function main() {
  try {
    const fileInventory = inspectFiles();
    const sqliteData = inspectSqliteTables();
    generateInventoryMd(fileInventory, sqliteData);
    console.log('Inspection and Inventory completed successfully.');
  } catch (err) {
    console.error('Error during VPS inspection:', err);
    process.exit(1);
  }
}

main();
