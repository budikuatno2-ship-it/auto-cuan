var a=require('../lib/daytrade-screener-engine');
var t=require('../lib/trade-plan-v2');
var fs=require('fs');
var c=JSON.parse(fs.readFileSync('data/daily-candles/BBCA.json','utf8'));
var arr=Array.isArray(c)?c:(c.candles||c.data||[]);
var ana=a.analyzeDayTrade(arr,'BBCA');
var p=t.buildTradePlanV2({
  entry_low: ana.support+200, entry_high: ana.support+300,
  support: ana.support, resistance: ana.resistance,
  atr14: ana.atr14, current_price: ana.last_price,
  volume: ana.volume_today, ticker: 'BBCA', board: 'UTAMA',
  observations: ana
}, {screener_type:'DAY_TRADE', ticker:'BBCA', board:'UTAMA', generatedAt:new Date().toISOString()});
var ks=Object.keys(p||{});
console.log('keys:',ks);
ks.forEach(function(k){ console.log('  '+k+':',p[k]); });