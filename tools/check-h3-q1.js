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

const out = ssh(`node -e "
const fs = require('fs');
const d = JSON.parse(fs.readFileSync('/home/ubuntu/auto-cuan/data/arjum-data/broker-summary/BBCA/2026-09-08.json', 'utf8'));
const cd = JSON.parse(fs.readFileSync('/home/ubuntu/auto-cuan/data/daily-candles/BBCA.json', 'utf8'));
const candle = cd.candles.find(c => c.date === '2026-09-08');

let totalBuyVal = 0;
let totalSellVal = 0;
let totalBuyVol = 0;
if (Array.isArray(d.brokers)) {
  d.brokers.forEach(b => {
    totalBuyVal += Number(b.bval || 0);
    totalSellVal += Number(b.sval || 0);
    totalBuyVol += Number(b.bvol || 0);
  });
}

console.log(JSON.stringify({
  stock_code: d.stock_code,
  date: d.broker_start_date,
  all_data_flag: d.all_data,
  brokersCount: d.brokers ? d.brokers.length : 0,
  levelsCount: d.broker_levels ? d.broker_levels.length : 0,
  totalBroksumBuyTurnover: totalBuyVal,
  totalBroksumSellTurnover: totalSellVal,
  candleClose: candle ? candle.close : null,
  candleVolume: candle ? candle.volume : null,
  candleTurnoverEst: candle ? (candle.volume * candle.close) : null,
  turnoverRatio: candle ? (totalBuyVal / (candle.volume * candle.close)).toFixed(4) : null
}, null, 2));
"`);

console.log(out);
