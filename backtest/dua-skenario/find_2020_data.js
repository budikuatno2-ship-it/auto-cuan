'use strict';

const fs = require('fs');
const path = require('path');
const { execFileSync } = require('child_process');

const SSH_KEY_PATH = 'D:\\Private Key Oracle\\ssh-key-2026-07-02.key';
const VPS_HOST = 'ubuntu@168.110.221.197';

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

function searchLocalRepo() {
  console.log('[1/2] Searching local repo for pre-2021/2020 daily OHLCV files...');
  const found = [];

  function walk(dir) {
    try {
      const list = fs.readdirSync(dir);
      for (const f of list) {
        if (f === 'node_modules' || f === '.git' || f === 'backtest') continue;
        const full = path.join(dir, f);
        const stat = fs.statSync(full);
        if (stat.isDirectory()) {
          walk(full);
        } else if (/\.(json|csv|sqlite|db)$/i.test(f)) {
          // Check file content
          try {
            const buf = fs.readFileSync(full);
            // Search for dates 2020-xx-xx or 2019 or 2018
            const str = buf.slice(0, 1000000).toString('utf8');
            if (str.includes('2020-0') || str.includes('2020-1') || str.includes('2019-') || str.includes('2018-')) {
              found.push({ file: full, size: stat.size });
            }
          } catch (e) {}
        }
      }
    } catch (e) {}
  }

  walk('.');
  return found;
}

function searchVpsDatabases() {
  console.log('[2/2] Searching VPS for all *.sqlite, *.db, and large *.json files...');
  // Find all sqlite/db files
  const dbFindCmd = "find /home/ubuntu -xdev -type f \\( -name '*.sqlite*' -o -name '*.db' \\) -not -path '*/.git/*' -not -path '*/node_modules/*' -printf '%TY-%Tm-%Td %s %p\\n' 2>/dev/null";
  const dbList = runSsh(dbFindCmd).trim().split('\n').filter(Boolean);

  const dbReports = [];
  for (const line of dbList) {
    const parts = line.trim().split(/\s+/);
    const date = parts[0];
    const size = parts[1];
    const dbPath = parts.slice(2).join(' ');

    if (!dbPath.endsWith('.sqlite') && !dbPath.endsWith('.db')) continue; // skip shm/wal

    console.log(`  Inspecting DB: ${dbPath}`);
    try {
      const tableCmd = `sqlite3 -readonly "${dbPath}" ".tables" 2>/dev/null`;
      const tables = runSsh(tableCmd).trim().split(/\s+/).filter(Boolean);

      for (const t of tables) {
        try {
          // Check if table has date / trade_date
          const countCmd = `sqlite3 -readonly "${dbPath}" "SELECT count(*) FROM \\"${t}\\";" 2>/dev/null`;
          const count = runSsh(countCmd).trim();

          // Try to find min and max date
          let dateInfo = null;
          try {
            const dCmd = `sqlite3 -readonly "${dbPath}" "SELECT min(trade_date), max(trade_date), count(DISTINCT ticker) FROM \\"${t}\\";" 2>/dev/null`;
            const dOut = runSsh(dCmd).trim();
            if (dOut && dOut.includes('|')) dateInfo = dOut;
          } catch(e) {}

          if (!dateInfo) {
            try {
              const dCmd2 = `sqlite3 -readonly "${dbPath}" "SELECT min(date), max(date), count(DISTINCT ticker) FROM \\"${t}\\";" 2>/dev/null`;
              const dOut2 = runSsh(dCmd2).trim();
              if (dOut2 && dOut2.includes('|')) dateInfo = dOut2;
            } catch(e) {}
          }

          if (!dateInfo && t === 'market_rows') {
            try {
              const dCmd3 = `sqlite3 -readonly "${dbPath}" "SELECT min(json_extract(row_json, '$.trade_date')), max(json_extract(row_json, '$.trade_date')), count(DISTINCT json_extract(row_json, '$.ticker')) FROM market_rows WHERE table_name='stock_daily_history';" 2>/dev/null`;
              const dOut3 = runSsh(dCmd3).trim();
              if (dOut3 && dOut3.includes('|')) dateInfo = 'stock_daily_history: ' + dOut3;
            } catch(e) {}
          }

          dbReports.push({ dbPath, size, table: t, count, dateInfo });
        } catch(e) {}
      }
    } catch(e) {}
  }

  // Also check large JSON files on VPS
  console.log('  Searching large JSON files on VPS...');
  const jsonFindCmd = "find /home/ubuntu -xdev -type f -name '*.json' -size +5M -not -path '*/.git/*' -not -path '*/node_modules/*' -printf '%TY-%Tm-%Td %s %p\\n' 2>/dev/null";
  const jsonList = runSsh(jsonFindCmd).trim().split('\n').filter(Boolean);

  return { dbReports, jsonList };
}

function main() {
  const localFound = searchLocalRepo();
  console.log('Local repo files containing 2020:');
  console.log(localFound);

  const vpsFound = searchVpsDatabases();
  console.log('\nVPS Database Reports:');
  console.log(JSON.stringify(vpsFound.dbReports, null, 2));
  console.log('\nVPS Large JSON Files:');
  console.log(vpsFound.jsonList);
}

main();
