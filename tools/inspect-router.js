const fs = require('fs');

const indexHtml = fs.readFileSync('public/index.html', 'utf8');
const lines = indexHtml.split('\n');

console.log('--- Router functions in public/index.html ---');
lines.forEach((l, i) => {
  if (l.includes('parseTargetPageFromPath') || l.includes('checkInitialUrlTargetPage') || l.includes('getCanonicalRouteUrl')) {
    console.log(`Line ${i + 1}: ${l}`);
  }
});
