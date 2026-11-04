'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// 1. Patch public/screener-v2.js
const scrPath = path.join(ROOT, 'public', 'screener-v2.js');
let scrCode = fs.readFileSync(scrPath, 'utf8');

if (!scrCode.includes('chip-likuid')) {
  scrCode = scrCode.replace(
    "var t = esc(r.ticker);",
    `var t = esc(r.ticker);
    var liq = r.liquidity_profile || (r.liquidity ? r.liquidity : null);
    var liqHtml = '';
    if (liq) {
      var lcls = liq.tier === 'LIKUID' ? 'chip-likuid' : 'chip-nonlikuid';
      liqHtml = ' <span class="chip ' + lcls + '" title="' + esc(liq.tooltip || liq.reason || '') + '">' + esc(liq.label || (liq.tier === 'LIKUID' ? 'Likuid' : 'Non-Likuid')) + '</span>';
    }`
  );

  scrCode = scrCode.replace(
    "'<span class=\"tk mono\">' + t + '</span>'",
    "'<span class=\"tk mono\">' + t + '</span>' + liqHtml"
  );

  fs.writeFileSync(scrPath, scrCode, 'utf8');
  console.log('screener-v2.js patched successfully');
} else {
  console.log('screener-v2.js already has chip-likuid');
}
