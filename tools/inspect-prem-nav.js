const fs = require('fs');

const indexHtml = fs.readFileSync('public/index.html', 'utf8');
const lines = indexHtml.split('\n');
lines.forEach((l, i) => {
  if (l.includes('premium-nav')) {
    console.log(`Line ${i + 1}: ${l}`);
  }
});
