var fs=require('fs');
var e=require('../lib/daytrade-screener-engine');
var c=JSON.parse(fs.readFileSync('data/daily-candles/BBCA.json','utf8'));
var arr=Array.isArray(c)?c:(c.candles||c.data||c.ohlcv||[]);
console.log('candles:',arr.length);
var a=e.analyzeDayTrade(arr,'BBCA');
console.log('type:',typeof a,'null?',a===null);
console.log('keys:',a?Object.keys(a).slice(0,25):'N/A');
if(a){
  var t=require('../lib/trade-plan-v2');
  var p=t.buildTradePlanV2({
    entry_low: a.support + 200,
    entry_high: a.support + 300,
    support: a.support,
    resistance: a.resistance,
    atr14: a.atr14,
    current_price: a.last_price,
    volume: a.volume_today,
    ticker: 'BBCA',
    board: 'UTAMA',
    observations: a
  }, {screenerType:'DAY_TRADE',ticker:'BBCA',board:'UTAMA',generatedAt:new Date().toISOString()});
  console.log('plan:',p?'OK':'NULL');
  console.log('entryLow:',p&&p.entryLow,'stopLoss:',p&&p.stopLoss,'tp1:',p&&p.tp1,'tp2:',p&&p.tp2);
  console.log('support1:',p&&p.support1,'resistance1:',p&&p.resistance1);
}