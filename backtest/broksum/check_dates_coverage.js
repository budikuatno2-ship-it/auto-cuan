'use strict';

const { execSync } = require('child_process');

const SSH_KEY_PATH = 'D:\\Private Key Oracle\\ssh-key-2026-07-02.key';
const VPS_HOST = 'ubuntu@168.110.221.197';

const remoteCode = `
const fs = require('fs');
const path = require('path');
const baseDir = '/home/ubuntu/auto-cuan/data/arjum-data/broker-summary';

const tickers = fs.readdirSync(baseDir).filter(f => fs.statSync(path.join(baseDir, f)).isDirectory());

// Focus on June to October 2026 (2026-06-01 to 2026-10-16)
const dateSet = new Set();
const tickerCoverage = [];

for (const tk of tickers) {
  const p = path.join(baseDir, tk);
  const files = fs.readdirSync(p).filter(f => f.endsWith('.json') && f !== 'latest.json');
  const juneToOctFiles = files.filter(f => f >= '2026-06-01.json' && f <= '2026-10-16.json');
  juneToOctFiles.forEach(f => dateSet.add(f.replace('.json', '')));
  tickerCoverage.push({ ticker: tk, total: juneToOctFiles.length });
}

const allDates = Array.from(dateSet).sort();
console.log('Total trading days found between Jun-Oct 2026:', allDates.length);
console.log('Earliest date in range:', allDates[0]);
console.log('Latest date in range:', allDates[allDates.length - 1]);
console.log('Sample dates:', allDates.slice(0, 5), '...', allDates.slice(-5));

// Check missing days for BRPT, BBCA, MEDC, ADRO, TLKM, ASII
const checkTickers = ['BRPT', 'BBCA', 'MEDC', 'ADRO', 'TLKM', 'ASII', 'AKRA', 'ACES', 'ICBP', 'INDF'];
const missingReport = {};

for (const tk of checkTickers) {
  const p = path.join(baseDir, tk);
  const existingDates = new Set(fs.existsSync(p) ? fs.readdirSync(p).map(f => f.replace('.json', '')) : []);
  const missing = allDates.filter(d => !existingDates.has(d));
  missingReport[tk] = {
    totalExisting: allDates.length - missing.length,
    missingCount: missing.length,
    missingDates: missing
  };
}

console.log('__DATES_REPORT_START__');
console.log(JSON.stringify({
  totalTickersScanned: tickers.length,
  totalTradingDates: allDates.length,
  allDates,
  missingReport
}, null, 2));
console.log('__DATES_REPORT_END__');
`;

function main() {
  const out = execSync(`ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 -i "${SSH_KEY_PATH}" ${VPS_HOST} node`, {
    input: remoteCode,
    maxBuffer: 15 * 1024 * 1024,
    encoding: 'utf8'
  });

  const s = out.indexOf('__DATES_REPORT_START__');
  const e = out.indexOf('__DATES_REPORT_END__');
  if (s !== -1 && e !== -1) {
    const jsonStr = out.slice(s + '__DATES_REPORT_START__'.length, e).trim();
    console.log(jsonStr);
    const fs = require('fs');
    fs.writeFileSync(require('path').join(__dirname, 'dates_coverage_report.json'), jsonStr);
  } else {
    console.log(out);
  }
}

main();
