const fs = require('fs');
const html = fs.readFileSync('public/index.html', 'utf8');
const lines = html.split('\n');

console.log('Lines 850 to 1250:');
for (let i = 850; i < 1250; i++) {
  if (lines[i]) {
    console.log(`${i+1}: ${lines[i]}`);
  }
}
