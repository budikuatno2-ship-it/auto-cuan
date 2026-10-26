// check-snapshot.js - run on VPS
var d = require('./data/screener-latest.json');
console.log('source_dates', JSON.stringify(d.source_dates));
var keys = ['swing', 'swing_konglo', 'swing_non_konglo', 'daytrade', 'top5'];
keys.forEach(function(k) {
  var len = d[k] ? d[k].length : 0;
  var tickers = len > 0 ? d[k].slice(0, 5).map(function(r) { return r.ticker; }).join(',') : '';
  console.log(k + ': ' + len + (len > 0 ? ' rows - ' + tickers + (len > 5 ? '...' : '') : ' rows'));
});
if (d.top5 && d.top5.length > 0) console.log('top5 tickers: ' + d.top5.map(function(r) { return r.ticker; }).join(','));