'use strict';

const fs = require('fs');
const path = require('path');
const { execSync } = require('child_process');
const { computeBroksumSeries, parseDailyBroksum } = require('./broksum-indicators');

const SSH_KEY_PATH = 'D:\\Private Key Oracle\\ssh-key-2026-07-02.key';
const VPS_HOST = 'ubuntu@168.110.221.197';

function getVpsFile(remotePath) {
  const raw = execSync(`ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 -i "${SSH_KEY_PATH}" ${VPS_HOST} "cat ${remotePath}"`, {
    encoding: 'utf8',
    maxBuffer: 10 * 1024 * 1024
  });
  return JSON.parse(raw);
}

function testSingleDay() {
  console.log('Fetching BRPT 2026-09-08 broker summary from VPS...');
  const bsJson = getVpsFile('/home/ubuntu/auto-cuan/data/arjum-data/broker-summary/BRPT/2026-09-08.json');

  const seriesItem = {
    date: '2026-09-08',
    broksum: bsJson,
    close: 1735,
    prevClose: 1770
  };

  const results = computeBroksumSeries([seriesItem]);
  const res = results[0];

  console.log('\n--- OUTPUT OF computeBroksumSeries ---');
  console.log(JSON.stringify(res, null, 2));

  // Manual expectations from merged broker_levels:
  // Top 3 buyers: YP (5632444000), XL (5244898000), AI (5213056000) -> sum = 16090398000
  // Top 3 sellers: LG (-12517453500), AK (-6951766500), CC (-5701945500) -> sum = 25171165500
  // Total T: 90674349000
  // tb: (16090398000 - 25171165500) / 90674349000 = -9080767500 / 90674349000 = -0.1001
  const expectedT = 90674349000;
  const expectedTop3Buy = 16090398000;
  const expectedTop3Sell = 25171165500;
  const expectedTb = -0.1001;

  console.log('\n--- UNIT TEST ASSERTIONS ---');
  console.log('T match:       ', res.T === expectedT, `got ${res.T} vs ${expectedT}`);
  console.log('top3Buy match: ', res.top3Buy === expectedTop3Buy, `got ${res.top3Buy} vs ${expectedTop3Buy}`);
  console.log('top3Sell match:', res.top3Sell === expectedTop3Sell, `got ${res.top3Sell} vs ${expectedTop3Sell}`);
  console.log('tb match:      ', res.tb === expectedTb, `got ${res.tb} vs ${expectedTb}`);
  console.log('locked is null:', res.locked === null, `got ${res.locked}`);
  console.log('foreignNet null:', res.foreignNet === null, `got ${res.foreignNet}`);
  console.log('top.buy 0 is YP:', res.top.buy[0].b === 'YP', `got ${res.top.buy[0].b}`);
  console.log('top.sell 0 is LG:', res.top.sell[0].b === 'LG', `got ${res.top.sell[0].b}`);

  const passed = res.T === expectedT &&
    res.top3Buy === expectedTop3Buy &&
    res.top3Sell === expectedTop3Sell &&
    res.tb === expectedTb &&
    res.locked === null &&
    res.foreignNet === null &&
    res.top.buy[0].b === 'YP' &&
    res.top.sell[0].b === 'LG';

  console.log('\nUNIT TEST RESULT (Single Day):', passed ? 'ALL PASS (100% MATCH)' : 'FAIL');
  if (!passed) process.exit(1);
}

function testZeroTurnoverFiltering() {
  console.log('\n--- TESTING ZERO-TURNOVER FILTERING (T=0) ---');
  const sampleBroksum = {
    broker_levels: [
      { buy: { broker_code: 'YP', bval: 1000000, bvol: 1000 }, sell: { broker_code: 'CC', sval: 200000, svol: 200 } },
      { buy: { broker_code: 'PD', bval: 500000, bvol: 500 }, sell: { broker_code: 'LG', sval: 800000, svol: 800 } }
    ]
  };

  const emptyBroksum = { broker_levels: [] };

  const series = [];
  // Build 25 days: days 5, 10, 15 have T=0 (holiday/empty)
  for (let i = 1; i <= 25; i++) {
    const isHoliday = (i === 5 || i === 10 || i === 15);
    series.push({
      date: `2026-01-${String(i).padStart(2, '0')}`,
      broksum: isHoliday ? emptyBroksum : sampleBroksum,
      close: 1000 + i * 10,
      prevClose: 1000 + (i - 1) * 10,
      volume: isHoliday ? 0 : 1500
    });
  }

  const results = computeBroksumSeries(series);

  console.log('Input series length:  ', series.length);
  console.log('Output series length: ', results.length);
  console.log('T=0 count in output:  ', results.filter(r => r.T === 0).length);

  const lengthPass = results.length === 22; // 25 - 3 holidays = 22
  const noZeroPass = results.every(r => r.T > 0);
  const ma20Pass = results[19].hab20 !== null; // At index 19 (the 20th active trading day), rolling 20-day metrics exist

  console.log('22 active days passed:', lengthPass);
  console.log('No T=0 in output passed:', noZeroPass);
  console.log('MA20 computed on 20th active day:', ma20Pass);

  const passed = lengthPass && noZeroPass && ma20Pass;
  console.log('\nUNIT TEST RESULT (Zero Turnover Filtering):', passed ? 'ALL PASS (100% MATCH)' : 'FAIL');
  if (!passed) process.exit(1);
}

testSingleDay();
testZeroTurnoverFiltering();
