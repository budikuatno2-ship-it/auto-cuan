const fs = require('fs');
const html = fs.readFileSync('public/index.html', 'utf8');
const idx = html.indexOf('var PROMOTED_ANALISIS_MAP =');
console.log(html.slice(idx, idx + 1000));
