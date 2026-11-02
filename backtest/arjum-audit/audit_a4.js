'use strict';
const fs = require('fs');

const logPath = '/home/ubuntu/auto-cuan-runner/logs/daily-market-update.log';
const lines = fs.readFileSync(logPath, 'utf8').split('\n');

const dates = ['2026-10-08', '2026-10-09', '2026-10-12', '2026-10-13', '2026-10-14', '2026-10-15', '2026-10-16'];

const runs = {};
for (const d of dates) runs[d] = [];

let curDate = null;
let curBlock = [];

for (let i = 0; i < lines.length; i++) {
  const line = lines[i];
  const m = /Target Date \(WIB\):\s*(\d{4}-\d{2}-\d{2})/.exec(line);
  if (m) {
    if (curDate && dates.includes(curDate)) {
      runs[curDate].push(curBlock.join('\n'));
    }
    curDate = m[1];
    curBlock = [line];
  } else if (curDate) {
    curBlock.push(line);
  }
}
if (curDate && dates.includes(curDate)) runs[curDate].push(curBlock.join('\n'));

const stats = [];
for (const d of dates) {
  const blocks = runs[d] || [];
  let maxReq = 0;
  let maxBrok = 0;
  let maxAcc = 0;
  let maxIns = 0;
  let retryCount = 0;

  for (const b of blocks) {
    const mTotal = /Total Permintaan Terkirim \(run ini\):\s*(\d+)/.exec(b);
    const mBrok = /broker-summary:\s*(\d+)/.exec(b);
    const mAcc = /accumulation:\s*(\d+)/.exec(b);
    const mIns = /insiders:\s*(\d+)/.exec(b);
    const mRetry = /Retryable \(bounded window\):\s*(\d+)/.exec(b);

    if (mTotal) {
      const tot = Number(mTotal[1]);
      if (tot > maxReq) maxReq = tot;
    }
    if (mBrok && Number(mBrok[1]) > maxBrok) maxBrok = Number(mBrok[1]);
    if (mAcc && Number(mAcc[1]) > maxAcc) maxAcc = Number(mAcc[1]);
    if (mIns && Number(mIns[1]) > maxIns) maxIns = Number(mIns[1]);
    if (mRetry && Number(mRetry[1]) > retryCount) retryCount = Number(mRetry[1]);
  }

  // Also candle is 962
  stats.push({
    date: d,
    runsCount: blocks.length,
    maxBrokerSummary: maxBrok,
    maxAccumulation: maxAcc,
    maxInsiders: maxIns,
    maxJ1Total: maxReq,
    candles: 962,
    totalEodPeak: maxReq + 962,
    maxRetries: retryCount
  });
}
console.log(JSON.stringify(stats, null, 2));
