const fs=require('fs');
const c=JSON.parse(fs.readFileSync('data/daily-candles/BBCA.json','utf8'));
const arr=Array.isArray(c)?c:(c.candles||c.data||[]);
console.log('len',arr.length);
console.log('last',JSON.stringify(arr[arr.length-1]));
console.log('first',JSON.stringify(arr[0]));

const tp=require('./lib/trade-plan-v2');
try {
  const p=tp.buildTradePlanV2(arr,{screenerType:'DAY_TRADE',ticker:'BBCA',board:'UTAMA',generatedAt:new Date().toISOString()});
  console.log('plan keys',p?Object.keys(p):'NULL');
  console.log('el',p&&p.entryLow,'sl',p&&p.stopLoss,'tp1',p&&p.tp1);
} catch(e){ console.log('ERR',e.message); }