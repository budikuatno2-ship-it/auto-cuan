'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync, execSync } = require('child_process');
const crypto = require('crypto');

const SSH_KEY_PATH = 'D:\\Private Key Oracle\\ssh-key-2026-07-02.key';
const VPS_HOST = 'ubuntu@168.110.221.197';
const SQLITE_PATH = '/home/ubuntu/auto-cuan-data/market.sqlite';
const OUTPUT_DIR = path.join(__dirname, 'data', 'vps_csv');
const INVENTORY_PATH = path.join(OUTPUT_DIR, 'INVENTORY.md');

function runSsh(remoteCmd) {
  const args = [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ConnectTimeout=15',
    '-i', SSH_KEY_PATH,
    VPS_HOST,
    remoteCmd
  ];
  return execFileSync('ssh', args, { maxBuffer: 15 * 1024 * 1024, encoding: 'utf8' });
}

function runScp(remotePath, localName) {
  const localTarget = path.join(OUTPUT_DIR, localName);
  const args = [
    '-o', 'StrictHostKeyChecking=no',
    '-o', 'ConnectTimeout=15',
    '-i', SSH_KEY_PATH,
    `${VPS_HOST}:${remotePath}`,
    localTarget
  ];
  console.log(`  SCP: ${remotePath} -> ${localName}`);
  execFileSync('scp', args);
  return localTarget;
}

function getLocalSha256(filePath) {
  const data = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(data).digest('hex');
}

function main() {
  console.log('====================================================');
  console.log('STEP 2: Copy Relevant Files & Verify SHA256');
  console.log('====================================================\n');

  // 1. Copy idx-tickers.csv
  const tickersLocal = runScp('/home/ubuntu/auto-cuan/public/assets/idx-tickers.csv', 'idx-tickers.csv');
  const tickersShaLocal = getLocalSha256(tickersLocal);
  const tickersShaRemote = runSsh('sha256sum /home/ubuntu/auto-cuan/public/assets/idx-tickers.csv').trim().split(/\s+/)[0];

  console.log(`  -> idx-tickers.csv: Remote SHA: ${tickersShaRemote}`);
  console.log(`                     Local SHA:  ${tickersShaLocal}`);
  console.log(`                     Match:      ${tickersShaRemote === tickersShaLocal ? 'OK' : 'MISMATCH'}\n`);

  // 2. Copy summary-final.csv (AI Research log containing BRPT)
  const aiLocal = runScp('/home/ubuntu/auto-cuan/data/ai-research/2026-07-05/summary-final.csv', 'ai-research-summary-final.csv');
  const aiShaLocal = getLocalSha256(aiLocal);
  const aiShaRemote = runSsh('sha256sum /home/ubuntu/auto-cuan/data/ai-research/2026-07-05/summary-final.csv').trim().split(/\s+/)[0];

  console.log(`  -> ai-research-summary-final.csv: Remote SHA: ${aiShaRemote}`);
  console.log(`                                   Local SHA:  ${aiShaLocal}`);
  console.log(`                                   Match:      ${aiShaRemote === aiShaLocal ? 'OK' : 'MISMATCH'}\n`);

  // 3. Export foreign_watchlist_daily for BRPT directly from SQLite
  console.log('  Exporting foreign_watchlist_daily (BRPT) from SQLite to CSV...');
  const foreignExportCmd = `sqlite3 -readonly -csv -header ${SQLITE_PATH} "SELECT json_extract(row_json, '$.trade_date') as trade_date, json_extract(row_json, '$.ticker') as ticker, json_extract(row_json, '$.close') as close, json_extract(row_json, '$.volume') as volume, json_extract(row_json, '$.nbsa') as nbsa, json_extract(row_json, '$.foreign_net') as foreign_net, json_extract(row_json, '$.valuasi') as valuasi, json_extract(row_json, '$.freq') as freq FROM market_rows WHERE table_name = 'foreign_watchlist_daily' AND (row_key LIKE '%BRPT%' OR row_json LIKE '%BRPT%') ORDER BY json_extract(row_json, '$.trade_date') ASC;"`;
  const foreignCsv = runSsh(foreignExportCmd);
  const foreignLocalPath = path.join(OUTPUT_DIR, 'brpt_foreign_flow_vps.csv');
  fs.writeFileSync(foreignLocalPath, foreignCsv);
  const foreignShaLocal = getLocalSha256(foreignLocalPath);
  console.log(`  -> Saved ${foreignLocalPath} (${foreignCsv.trim().split('\n').length - 1} records). SHA256: ${foreignShaLocal}\n`);

  // 4. Export stock_daily_history for BRPT directly from SQLite
  console.log('  Exporting stock_daily_history (BRPT) from SQLite to CSV...');
  const historyExportCmd = `sqlite3 -readonly -csv -header ${SQLITE_PATH} "SELECT json_extract(row_json, '$.trade_date') as trade_date, json_extract(row_json, '$.ticker') as ticker, json_extract(row_json, '$.open') as open, json_extract(row_json, '$.high') as high, json_extract(row_json, '$.low') as low, json_extract(row_json, '$.close') as close, json_extract(row_json, '$.volume') as volume FROM market_rows WHERE table_name = 'stock_daily_history' AND row_key LIKE 'BRPT%' ORDER BY json_extract(row_json, '$.trade_date') ASC;"`;
  const historyCsv = runSsh(historyExportCmd);
  const historyLocalPath = path.join(OUTPUT_DIR, 'brpt_daily_history_vps.csv');
  fs.writeFileSync(historyLocalPath, historyCsv);
  const historyShaLocal = getLocalSha256(historyLocalPath);
  console.log(`  -> Saved ${historyLocalPath} (${historyCsv.trim().split('\n').length - 1} records). SHA256: ${historyShaLocal}\n`);

  // 5. Export stock_fundamentals for BRPT
  console.log('  Exporting stock_fundamentals (BRPT) from SQLite to JSON...');
  const fundExportCmd = `sqlite3 -readonly ${SQLITE_PATH} "SELECT row_json FROM market_rows WHERE table_name = 'stock_fundamentals' AND row_key LIKE '%BRPT%';"`;
  const fundJson = runSsh(fundExportCmd);
  const fundLocalPath = path.join(OUTPUT_DIR, 'brpt_fundamentals_vps.json');
  fs.writeFileSync(fundLocalPath, fundJson);
  const fundShaLocal = getLocalSha256(fundLocalPath);
  console.log(`  -> Saved ${fundLocalPath}. SHA256: ${fundShaLocal}\n`);

  // Append Verification Table to INVENTORY.md
  let appendMd = '\n---\n\n## 4. VERIFIKASI INTEGRITAS SHA256 FILE YANG DISALIN KE LOKAL\n\n';
  appendMd += '| Nama File Lokal | Sumber Path di VPS | SHA256 VPS (Remote) | SHA256 Lokal | Status Integritas |\n';
  appendMd += '|---|---|---|---|---|\n';
  appendMd += `| \`idx-tickers.csv\` | \`/home/ubuntu/auto-cuan/public/assets/idx-tickers.csv\` | \`${tickersShaRemote}\` | \`${tickersShaLocal}\` | **${tickersShaRemote === tickersShaLocal ? 'VALID (MATCH)' : 'MISMATCH'}** |\n`;
  appendMd += `| \`ai-research-summary-final.csv\` | \`/home/ubuntu/auto-cuan/data/ai-research/2026-07-05/summary-final.csv\` | \`${aiShaRemote}\` | \`${aiShaLocal}\` | **${aiShaRemote === aiShaLocal ? 'VALID (MATCH)' : 'MISMATCH'}** |\n`;
  appendMd += `| \`brpt_foreign_flow_vps.csv\` | Ekspor SQLite \`foreign_watchlist_daily\` (BRPT) | - | \`${foreignShaLocal}\` | **VALID (GENERATED)** |\n`;
  appendMd += `| \`brpt_daily_history_vps.csv\` | Ekspor SQLite \`stock_daily_history\` (BRPT) | - | \`${historyShaLocal}\` | **VALID (GENERATED)** |\n`;
  appendMd += `| \`brpt_fundamentals_vps.json\` | Ekspor SQLite \`stock_fundamentals\` (BRPT) | - | \`${fundShaLocal}\` | **VALID (GENERATED)** |\n`;

  fs.appendFileSync(INVENTORY_PATH, appendMd);
  console.log(`Updated ${INVENTORY_PATH} with verification records.`);
}

main();
