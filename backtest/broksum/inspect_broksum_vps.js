'use strict';

const { execSync } = require('child_process');

const SSH_KEY_PATH = 'D:\\Private Key Oracle\\ssh-key-2026-07-02.key';
const VPS_HOST = 'ubuntu@168.110.221.197';

const remoteCode = `
const fs = require('fs');
const path = require('path');
const baseDir = '/home/ubuntu/auto-cuan/data/arjum-data/broker-summary';

if (!fs.existsSync(baseDir)) {
  console.log('Dir does not exist:', baseDir);
  process.exit(0);
}

const tickers = fs.readdirSync(baseDir).filter(f => fs.statSync(path.join(baseDir, f)).isDirectory());
console.log('Total tickers with broker-summary on VPS:', tickers.length);

// Check sample of tickers: BRPT, BBCA, MEDC, ADRO
const checkList = ['BRPT', 'BBCA', 'MEDC', 'ADRO'];
const details = {};

for (const tk of checkList) {
  const p = path.join(baseDir, tk);
  if (fs.existsSync(p)) {
    const files = fs.readdirSync(p).filter(f => f.endsWith('.json') && f !== 'latest.json').sort();
    const sample = files.length > 0 ? JSON.parse(fs.readFileSync(path.join(p, files[files.length - 1]), 'utf8')) : null;
    details[tk] = {
      totalFiles: files.length,
      earliest: files[0],
      latest: files[files.length - 1],
      sampleKeys: sample ? Object.keys(sample) : null,
      topBuyerSample: sample?.top_buyers?.[0] || sample?.buyers?.[0] || null,
      topSellerSample: sample?.top_sellers?.[0] || sample?.sellers?.[0] || null,
      sampleDataSlice: sample ? {
        stock_code: sample.stock_code || sample.code,
        date: sample.date,
        total_records: sample.total_records,
        has_top_buyers: Array.isArray(sample.top_buyers),
        has_top_sellers: Array.isArray(sample.top_sellers)
      } : null
    };
  } else {
    details[tk] = 'not found';
  }
}

console.log('__INVENTORY_START__');
console.log(JSON.stringify(details, null, 2));
console.log('__INVENTORY_END__');
`;

function main() {
  const out = execSync(`ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 -i "${SSH_KEY_PATH}" ${VPS_HOST} node`, {
    input: remoteCode,
    maxBuffer: 10 * 1024 * 1024,
    encoding: 'utf8'
  });
  console.log(out);
}

main();
