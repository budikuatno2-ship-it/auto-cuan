#!/usr/bin/env node
'use strict';
const fs = require('fs');
const path = require('path');
const ROOT = path.resolve(__dirname, '..');
const html = fs.readFileSync(path.join(ROOT, 'public', 'index.html'), 'utf8');
const lines = html.split('\n');

// find the portfolio tab buttons that reference page-today / page-planner etc.
for (let i = 0; i < lines.length; i++) {
  if (/page-(today|planner|watch|risk|scenarios|journal|ai)\b/.test(lines[i]) &&
      /button|onclick|data-/.test(lines[i])) {
    console.log((i + 1) + ': ' + lines[i].trim().slice(0, 240));
  }
}

console.log('');
console.log('=== openPortfolioTab / switchPortfolio functions in public/*.js ===');
const PUB = path.join(ROOT, 'public');
for (const f of fs.readdirSync(PUB)) {
  if (!/\.js$/i.test(f)) continue;
  const src = fs.readFileSync(path.join(PUB, f), 'utf8');
  if (/page-today|openPortfolioTab|switchPortfolioTab|portfolioTab/.test(src)) {
    const l = src.split('\n');
    let hits = 0;
    l.forEach((s, i) => {
      if (/page-today|openPortfolioTab|switchPortfolioTab|data-tab/.test(s) && s.length < 220 && hits < 12) {
        console.log(f + ':' + (i + 1) + ': ' + s.trim().slice(0, 170));
        hits++;
      }
    });
    console.log('');
  }
}
