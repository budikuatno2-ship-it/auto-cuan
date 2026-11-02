'use strict';
const fs = require('fs');
const tickers = ['BBCA','BBRI','BMRI','BBNI','TLKM','ASII','BRPT','MEDC','ADRO','CASH'];
const d = '2026-10-16';
const base = '/home/ubuntu/auto-cuan/data/arjum-data';

const out = {};
for (const t of tickers) {
  const allPath = base + '/broker-summary/' + t + '/' + d + '.json';
  const fPath = base + '/broker-summary-F/' + t + '/' + d + '.json';
  const accPath = base + '/broker-accumulation/' + t + '/series.json';
  const insPath = base + '/insiders/' + t + '/p1.json';

  const allData = fs.existsSync(allPath) ? JSON.parse(fs.readFileSync(allPath, 'utf8')) : null;
  const fData = fs.existsSync(fPath) ? JSON.parse(fs.readFileSync(fPath, 'utf8')) : null;
  const accData = fs.existsSync(accPath) ? JSON.parse(fs.readFileSync(accPath, 'utf8')) : null;
  const insData = fs.existsSync(insPath) ? JSON.parse(fs.readFileSync(insPath, 'utf8')) : null;

  out[t] = {
    hasAll: !!allData,
    allBrokersCount: allData && allData.brokers ? allData.brokers.length : 0,
    hasForeign: !!fData,
    foreignBrokersCount: fData && fData.brokers ? fData.brokers.length : 0,
    hasAccum: !!accData,
    accumDays: accData && accData.daily_series ? accData.daily_series.length : 0,
    hasInsider: !!insData,
    insiderRows: insData && insData.items ? insData.items.length : 0
  };
}
console.log(JSON.stringify(out, null, 2));
