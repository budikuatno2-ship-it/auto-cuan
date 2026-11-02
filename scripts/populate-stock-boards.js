// populate-stock-boards.js - run on VPS
var SUPABASE_URL = 'https://evyczgtnufypyidxxtqf.supabase.co';
var fs = require('fs');
var env = fs.readFileSync('/home/ubuntu/auto-cuan-runner/.env', 'utf8');
var m = env.match(/SUPABASE_SERVICE_ROLE_KEY=([^\n]+)/);
var SUPABASE_KEY = m ? m[1].trim() : null;
if (!SUPABASE_KEY) { console.log('NO_KEY'); process.exit(1); }
var url = SUPABASE_URL + '/rest/v1/stock_boards?select=ticker,board,company_name&is_active=eq.true&limit=2000';
fetch(url, { headers: { apikey: SUPABASE_KEY, Authorization: 'Bearer ' + SUPABASE_KEY } })
  .then(function(r) { return r.json(); })
  .then(function(rows) {
    var map = {};
    rows.forEach(function(r) { map[r.ticker] = { board: r.board || 'UNKNOWN', company_name: r.company_name || null }; });
    var dir = '/home/ubuntu/auto-cuan/data/arjum-data';
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(dir + '/stock-boards.json', JSON.stringify(map, null, 2));
    console.log('OK ' + Object.keys(map).length + ' tickers, ' + fs.statSync(dir + '/stock-boards.json').size + ' bytes');
  })
  .catch(function(e) { console.log('ERROR ' + e.message); });