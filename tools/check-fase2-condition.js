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

console.log('=== KONDISI FASE 2: Cek 80 hari bursa terakhir untuk 10 saham uji ===');
const script = `
const fs = require('fs');
const path = require('path');
const baseDir = '/home/ubuntu/auto-cuan/data/arjum-data';
const accumDir = path.join(baseDir, 'broker-accumulation');
const broksumDir = path.join(baseDir, 'broker-summary');

const testTickers = ['BBCA', 'BRPT', 'BBRI', 'MEDC', 'ADRO', 'BUMI', 'BMRI', 'TPIA', 'BBNI', 'TLKM'];
const results = [];

for (const tk of testTickers) {
  const tkAccumFile = path.join(accumDir, tk, 'series.json');
  if (!fs.existsSync(tkAccumFile)) {
    results.push({ ticker: tk, status: 'no_series_json', daysCoverage: 0 });
    continue;
  }

  let authentic;
  try { authentic = JSON.parse(fs.readFileSync(tkAccumFile, 'utf8')); } catch (e) {
    results.push({ ticker: tk, status: 'corrupt', daysCoverage: 0 }); continue;
  }

  if (!authentic.series || authentic.series.length === 0 || !authentic.series[0].points) {
    results.push({ ticker: tk, status: 'empty_series', daysCoverage: 0 });
    continue;
  }

  const points = authentic.series[0].points;
  let unclippedDays = 0;
  let clippedDays = 0;
  let missingDays = 0;

  for (const pt of points) {
    const fPath = path.join(broksumDir, tk, pt.date + '.json');
    if (!fs.existsSync(fPath)) {
      missingDays++;
      continue;
    }
    try {
      const bData = JSON.parse(fs.readFileSync(fPath, 'utf8'));
      const isClipped = Array.isArray(bData.broker_levels) && bData.broker_levels.length === 25 && bData.all_data !== true;
      if (isClipped) clippedDays++;
      else unclippedDays++;
    } catch (_) {
      missingDays++;
    }
  }

  const totalDays = points.length;
  const isEligible = clippedDays === 0 && missingDays === 0 && unclippedDays === totalDays;
  const eligiblePct = ((unclippedDays / totalDays) * 100).toFixed(1);

  results.push({
    ticker: tk,
    totalDays,
    unclippedDays,
    clippedDays,
    missingDays,
    eligiblePct: eligiblePct + '%',
    isFullUnclipped: isEligible
  });
}

console.log(JSON.stringify(results, null, 2));
`;

console.log(ssh(`node -e "${script.replace(/\n/g, ' ')}"`));
