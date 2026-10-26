'use strict';

const fs = require('fs');
const path = require('path');
const zlib = require('zlib');

function crossCheckForeign() {
  console.log('Cross-checking Arjum broker-summary flow=F vs done-details (BRPT 2026-09-08)...');

  // 1. Arjum flow=F
  const bsF = JSON.parse(fs.readFileSync(path.join(__dirname, 'brpt_20260908_flow_F.json'), 'utf8'));

  let bsFBuyVal = 0, bsFSellVal = 0, bsFBuyVol = 0, bsFSellVol = 0;
  const bsBrokerBuy = new Map();
  const bsBrokerSell = new Map();

  if (Array.isArray(bsF.brokers)) {
    for (const b of bsF.brokers) {
      bsFBuyVal += Number(b.bval || 0);
      bsFSellVal += Number(b.sval || 0);
      bsFBuyVol += Number(b.bvol || 0);
      bsFSellVol += Number(b.svol || 0);
      if (b.bval > 0) bsBrokerBuy.set(b.broker_code, { val: b.bval, vol: b.bvol });
      if (b.sval > 0) bsBrokerSell.set(b.broker_code, { val: b.sval, vol: b.svol });
    }
  }

  // 2. Done Details (raw/2026-09-08/BRPT.jsonl.gz)
  const ddGzPath = path.join(__dirname, '..', 'lpm-done', 'raw', '2026-09-08', 'BRPT.jsonl.gz');
  const buf = fs.readFileSync(ddGzPath);
  const rows = zlib.gunzipSync(buf).toString('utf8').trim().split('\n').filter(Boolean).map(l => JSON.parse(l));

  // Compute for Board RG only and All boards
  let ddRgBuyVal = 0, ddRgSellVal = 0, ddRgBuyVol = 0, ddRgSellVol = 0;
  let ddAllBuyVal = 0, ddAllSellVal = 0, ddAllBuyVol = 0, ddAllSellVol = 0;
  const ddBrokerBuy = new Map();
  const ddBrokerSell = new Map();

  for (const r of rows) {
    const val = Number(r.value_raw || 0);
    const vol = Number(r.qty_num || 0) * 100;
    const bType = r.buyer_type;
    const sType = r.seller_type;
    const bCode = r.buyer;
    const sCode = r.seller;
    const board = r.market_board || 'RG';

    if (bType === 'F') {
      ddAllBuyVal += val;
      ddAllBuyVol += vol;
      if (board === 'RG') {
        ddRgBuyVal += val;
        ddRgBuyVol += vol;
        const cur = ddBrokerBuy.get(bCode) || { val: 0, vol: 0 };
        ddBrokerBuy.set(bCode, { val: cur.val + val, vol: cur.vol + vol });
      }
    }
    if (sType === 'F') {
      ddAllSellVal += val;
      ddAllSellVol += vol;
      if (board === 'RG') {
        ddRgSellVal += val;
        ddRgSellVol += vol;
        const cur = ddBrokerSell.get(sCode) || { val: 0, vol: 0 };
        ddBrokerSell.set(sCode, { val: cur.val + val, vol: cur.vol + vol });
      }
    }
  }

  console.log('\n--- TOTAL VALUES COMPARISON ---');
  console.log(`Arjum Broksum (flow=F) Buy Value:  Rp ${bsFBuyVal.toLocaleString('id-ID')}`);
  console.log(`Arjum Broksum (flow=F) Sell Value: Rp ${bsFSellVal.toLocaleString('id-ID')}`);
  console.log(`Arjum Broksum Net Foreign Value:   Rp ${(bsFBuyVal - bsFSellVal).toLocaleString('id-ID')}`);
  console.log(`Arjum Broksum Net Foreign Volume:  ${(bsFBuyVol - bsFSellVol).toLocaleString('id-ID')} shares`);

  console.log('\nDone Details (Board RG) Foreign:');
  console.log(`  Buy Value:  Rp ${ddRgBuyVal.toLocaleString('id-ID')}`);
  console.log(`  Sell Value: Rp ${ddRgSellVal.toLocaleString('id-ID')}`);
  console.log(`  Net Value:  Rp ${(ddRgBuyVal - ddRgSellVal).toLocaleString('id-ID')}`);
  console.log(`  Net Volume: ${(ddRgBuyVol - ddRgSellVol).toLocaleString('id-ID')} shares`);

  console.log('\nDone Details (All Boards, RG + NG) Foreign:');
  console.log(`  Buy Value:  Rp ${ddAllBuyVal.toLocaleString('id-ID')}`);
  console.log(`  Sell Value: Rp ${ddAllSellVal.toLocaleString('id-ID')}`);
  console.log(`  Net Value:  Rp ${(ddAllBuyVal - ddAllSellVal).toLocaleString('id-ID')}`);

  console.log('\n--- BROKER LEVEL MATCHING ---');
  console.log('Arjum flow=F buyers count:', bsBrokerBuy.size, 'DoneDetails RG foreign buyers:', ddBrokerBuy.size);
  console.log('Arjum flow=F sellers count:', bsBrokerSell.size, 'DoneDetails RG foreign sellers:', ddBrokerSell.size);

  console.log('\nBrokers in Arjum flow=F (Buy):');
  for (const [code, obj] of bsBrokerBuy.entries()) {
    const ddObj = ddBrokerBuy.get(code) || { val: 0, vol: 0 };
    console.log(`  ${code}: Broksum Buy Rp ${obj.val.toLocaleString()} vs DoneDetails RG Rp ${ddObj.val.toLocaleString()} (diff: Rp ${(obj.val - ddObj.val).toLocaleString()})`);
  }

  console.log('\nBrokers in Arjum flow=F (Sell):');
  for (const [code, obj] of bsBrokerSell.entries()) {
    const ddObj = ddBrokerSell.get(code) || { val: 0, vol: 0 };
    console.log(`  ${code}: Broksum Sell Rp ${obj.val.toLocaleString()} vs DoneDetails RG Rp ${ddObj.val.toLocaleString()} (diff: Rp ${(obj.val - ddObj.val).toLocaleString()})`);
  }
}

crossCheckForeign();
