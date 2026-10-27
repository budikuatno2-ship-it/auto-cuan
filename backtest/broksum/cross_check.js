'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');
const { execSync } = require('child_process');

const SSH_KEY_PATH = 'D:\\Private Key Oracle\\ssh-key-2026-07-02.key';
const VPS_HOST = 'ubuntu@168.110.221.197';

function getVpsBroksum() {
  const remoteCmd = `node -e "const fs = require('fs'); const d = JSON.parse(fs.readFileSync('/home/ubuntu/auto-cuan/data/arjum-data/broker-summary/BRPT/2026-09-08.json')); console.log(JSON.stringify(d));"`;
  const raw = execSync(`ssh -o StrictHostKeyChecking=no -o ConnectTimeout=15 -i "${SSH_KEY_PATH}" ${VPS_HOST} "${remoteCmd.replace(/"/g, '\\"')}"`, {
    encoding: 'utf8',
    maxBuffer: 15 * 1024 * 1024
  });
  return JSON.parse(raw);
}

function getLocalDoneDetails() {
  const gzPath = path.join(__dirname, '..', 'lpm-done', 'raw', '2026-09-08', 'BRPT.jsonl.gz');
  const buf = fs.readFileSync(gzPath);
  const text = zlib.gunzipSync(buf).toString('utf8');
  return text.trim().split('\n').filter(Boolean).map(l => JSON.parse(l));
}

function crossCheck() {
  console.log('Running cross-check between Broker Summary and Done Details (BRPT 2026-09-08)...');
  const broksum = getVpsBroksum();
  const doneDetails = getLocalDoneDetails();

  console.log('Broker Summary top keys:', Object.keys(broksum));
  console.log('Brokers array length:', broksum.brokers ? broksum.brokers.length : 0);
  console.log('Broker levels array length:', broksum.broker_levels ? broksum.broker_levels.length : 0);

  // Compute broker summary totals from broker_levels
  const bsBuyMap = new Map();
  const bsSellMap = new Map();

  let bsTotalBuyVal = 0;
  let bsTotalSellVal = 0;
  let bsTotalBuyVol = 0;
  let bsTotalSellVol = 0;

  if (Array.isArray(broksum.broker_levels)) {
    for (const lvl of broksum.broker_levels) {
      if (lvl.buy && lvl.buy.broker_code) {
        const b = lvl.buy.broker_code;
        const val = Number(lvl.buy.bval || 0);
        const vol = Number(lvl.buy.bvol || 0);
        bsBuyMap.set(b, { val, vol, avg: lvl.buy.bavg });
        bsTotalBuyVal += val;
        bsTotalBuyVol += vol;
      }
      if (lvl.sell && lvl.sell.broker_code) {
        const b = lvl.sell.broker_code;
        const val = Number(lvl.sell.sval || 0);
        const vol = Number(lvl.sell.svol || 0);
        bsSellMap.set(b, { val, vol, avg: lvl.sell.savg });
        bsTotalSellVal += val;
        bsTotalSellVol += vol;
      }
    }
  }

  // Compute totals from doneDetails (board RG only vs ALL)
  const ddRgBuyMap = new Map();
  const ddRgSellMap = new Map();
  let ddRgTotalVal = 0;
  let ddRgTotalVol = 0;

  const ddAllBuyMap = new Map();
  const ddAllSellMap = new Map();
  let ddAllTotalVal = 0;
  let ddAllTotalVol = 0;

  for (const r of doneDetails) {
    const val = Number(r.value_raw || 0);
    const vol = Number(r.qty_num || 0) * 100;
    const b = r.buyer;
    const s = r.seller;
    const board = r.market_board || 'RG';

    // ALL boards
    ddAllTotalVal += val;
    ddAllTotalVol += vol;
    if (b) {
      const cur = ddAllBuyMap.get(b) || { val: 0, vol: 0 };
      ddAllBuyMap.set(b, { val: cur.val + val, vol: cur.vol + vol });
    }
    if (s) {
      const cur = ddAllSellMap.get(s) || { val: 0, vol: 0 };
      ddAllSellMap.set(s, { val: cur.val + val, vol: cur.vol + vol });
    }

    // RG board only
    if (board === 'RG') {
      ddRgTotalVal += val;
      ddRgTotalVol += vol;
      if (b) {
        const cur = ddRgBuyMap.get(b) || { val: 0, vol: 0 };
        ddRgBuyMap.set(b, { val: cur.val + val, vol: cur.vol + vol });
      }
      if (s) {
        const cur = ddRgSellMap.get(s) || { val: 0, vol: 0 };
        ddRgSellMap.set(s, { val: cur.val + val, vol: cur.vol + vol });
      }
    }
  }

  console.log('\n--- TOTAL VALUES COMPARISON ---');
  console.log(`Broker Summary Total Buy Value:  Rp ${bsTotalBuyVal.toLocaleString('id-ID')}`);
  console.log(`Broker Summary Total Sell Value: Rp ${bsTotalSellVal.toLocaleString('id-ID')}`);
  console.log(`Done Details (Board RG) Value:   Rp ${ddRgTotalVal.toLocaleString('id-ID')}`);
  console.log(`Done Details (All Boards) Value: Rp ${ddAllTotalVal.toLocaleString('id-ID')}`);
  console.log(`Diff (Broksum Buy vs Done Details RG): Rp ${(bsTotalBuyVal - ddRgTotalVal).toLocaleString('id-ID')}`);

  console.log('\n--- BROKER-BY-BROKER SAMPLE CHECK (TOP BUYERS) ---');
  let topCheckCount = 0;
  for (const [broker, bObj] of bsBuyMap.entries()) {
    if (topCheckCount++ >= 8) break;
    const ddObj = ddRgBuyMap.get(broker) || { val: 0, vol: 0 };
    const diffVal = bObj.val - ddObj.val;
    const diffVol = bObj.vol - ddObj.vol;
    console.log(`Broker ${broker}: Broksum Buy Rp ${bObj.val.toLocaleString()} (${bObj.vol.toLocaleString()} sh) vs DoneDetails RG Rp ${ddObj.val.toLocaleString()} (${ddObj.vol.toLocaleString()} sh) | Diff: Rp ${diffVal.toLocaleString()}`);
  }

  console.log('\n--- BROKER-BY-BROKER SAMPLE CHECK (TOP SELLERS) ---');
  topCheckCount = 0;
  for (const [broker, sObj] of bsSellMap.entries()) {
    if (topCheckCount++ >= 8) break;
    const ddObj = ddRgSellMap.get(broker) || { val: 0, vol: 0 };
    const diffVal = sObj.val - ddObj.val;
    const diffVol = sObj.vol - ddObj.vol;
    console.log(`Broker ${broker}: Broksum Sell Rp ${sObj.val.toLocaleString()} (${sObj.vol.toLocaleString()} sh) vs DoneDetails RG Rp ${ddObj.val.toLocaleString()} (${ddObj.vol.toLocaleString()} sh) | Diff: Rp ${diffVal.toLocaleString()}`);
  }
}

crossCheck();
