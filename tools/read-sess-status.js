const fs = require('fs');

const f = fs.readFileSync('lib/reset-password-legacy-handler.js', 'utf8');
const lines = f.split('\n');
lines.forEach((l, i) => {
  if (l.includes('session-status')) {
    console.log(`Line ${i + 1}: ${l}`);
    console.log(lines.slice(i, i + 20).join('\n'));
  }
});
