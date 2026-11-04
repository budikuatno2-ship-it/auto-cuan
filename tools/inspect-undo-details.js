const fs = require('fs');

const r = fs.readFileSync('public/money-sheet-runtime.js', 'utf8').split('\n');
const h = fs.readFileSync('public/index.html', 'utf8').split('\n');

console.log('--- in money-sheet-runtime.js ---');
r.forEach((line, i) => {
  if (/salin|urung|undo|copy/i.test(line)) console.log(`Line ${i + 1}: ${line.trim()}`);
});

console.log('--- in public/index.html ---');
h.forEach((line, i) => {
  if (i > 2990 && i < 3070 && /salin|urung|undo|copy/i.test(line)) console.log(`Line ${i + 1}: ${line.trim()}`);
});
