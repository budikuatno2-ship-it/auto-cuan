#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const lines = html.split('\n');

function grep(re, label, max) {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    if (re.test(lines[i])) out.push((i + 1) + ': ' + lines[i].trim().slice(0, 200));
  }
  console.log('==== ' + label + ' (' + out.length + ') ====');
  console.log(out.slice(0, max || 40).join('\n'));
  console.log('');
}

grep(/onclick="[^"]*(Portfolio|portofolio)[^"]*"/i, 'portfolio click handlers', 25);
grep(/function\s+\w*(Portfolio|Portofolio)\w*\s*\(/, 'portfolio fns', 25);
grep(/data-account-tab|onclick="[^"]*AccountCenter|function\s+\w*AccountCenter\w*/i, 'account center', 25);
grep(/bandarViewInd|setBandarSection|data-bandar|summaryView|akumulasiView/i, 'bandar section', 30);
grep(/onclick="[^"]*(Financial|financial)[^"]*"/, 'financial handlers', 20);
grep(/function\s+\w*(Financial|financial)\w*\s*\(/, 'financial fns', 25);
grep(/adminNoteDrawer|openAdminNote|function\s+\w*NoteDrawer\w*/i, 'admin note drawer', 25);
grep(/function\s+\w*(Chart|chart)\w*(Ticker|Symbol|Preset|Mode)\w*\s*\(/, 'chart ticker fns', 25);
grep(/setActiveTicker|function\s+loadChart|chartTickerInput|chartTicker/, 'chart ticker wiring', 25);
grep(/switchFinancialTab|finTab|financialTab/, 'financial tab wiring', 25);
grep(/pattern.*radar|scanBtn|runPatternScan/i, 'pattern radar wiring', 15);

console.log('==== data-* tab attrs with onclick ====');
const btnRe = /<button[^>]*(?:data-subtab|data-tab|data-admin-tab|data-analysis-tab)[^>]*>/gi;
let m;
while ((m = btnRe.exec(html))) {
  const tag = m[0];
  if (/onclick=/.test(tag)) console.log('  ' + tag.replace(/\s+/g, ' ').slice(0, 190));
}
