const fs = require('fs');

const indexHtml = fs.readFileSync('public/index.html', 'utf8');
const lines = indexHtml.split('\n');

console.log('--- Matching lines in public/index.html ---');
lines.forEach((line, i) => {
  if (/money|keuangan|tabMoney/i.test(line)) {
    console.log(`Line ${i + 1}: ${line.trim()}`);
  }
});
