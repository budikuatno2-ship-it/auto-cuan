'use strict';

const { execFileSync } = require('child_process');

const SSH_KEY = 'D:/Private Key Oracle/ssh-key-2026-07-02.key';
const VPS_HOST = 'ubuntu@168.110.221.197';

function ssh(remoteCmd) {
  return execFileSync('ssh', [
    '-o', 'BatchMode=yes',
    '-o', 'ConnectTimeout=15',
    '-i', SSH_KEY,
    VPS_HOST,
    remoteCmd
  ], {
    encoding: 'utf8',
    maxBuffer: 20 * 1024 * 1024
  });
}

const script = `
const fs = require('fs');
const path = require('path');
const baseDir = '/home/ubuntu/auto-cuan/data/arjum-data/broker-accumulation';

const tickers = ['BBCA', 'BRPT', 'BBRI', 'MEDC', 'ADRO'];
const details = [];

for (const tk of tickers) {
  const dir = path.join(baseDir, tk);
  if (!fs.existsSync(dir)) {
    details.push({ ticker: tk, status: 'missing_dir' });
    continue;
  }
  const files = fs.readdirSync(dir);
  let sampleContent = null;
  const sampleFile = files.find(f => f.endsWith('.json'));
  if (sampleFile) {
    try {
      sampleContent = JSON.parse(fs.readFileSync(path.join(dir, sampleFile), 'utf8'));
    } catch (_) {}
  }
  details.push({
    ticker: tk,
    files,
    keys: sampleContent ? Object.keys(sampleContent) : [],
    startDate: sampleContent ? (sampleContent.start_date || sampleContent.date_from) : null,
    endDate: sampleContent ? (sampleContent.end_date || sampleContent.date_to) : null,
    seriesCount: sampleContent && Array.isArray(sampleContent.series) ? sampleContent.series.length : 0,
    sampleSeriesBroker: sampleContent && sampleContent.series && sampleContent.series[0] ? {
      broker_code: sampleContent.series[0].broker_code,
      broker_name: sampleContent.series[0].broker_name,
      pointsLength: Array.isArray(sampleContent.series[0].points) ? sampleContent.series[0].points.length : 0,
      samplePoint: sampleContent.series[0].points ? sampleContent.series[0].points[sampleContent.series[0].points.length - 1] : null
    } : null,
    topBuyers: sampleContent ? sampleContent.top_buyers : null,
    topSellers: sampleContent ? sampleContent.top_sellers : null
  });
}

console.log(JSON.stringify(details, null, 2));
`;

execFileSync('scp', [
  '-o', 'BatchMode=yes',
  '-o', 'ConnectTimeout=15',
  '-i', SSH_KEY,
  'tools/check-accum-schema.js',
  `${VPS_HOST}:/tmp/check-accum-schema-local.js`
]);

console.log(ssh('node -e "' + script.replace(/\n/g, ' ') + '"'));
