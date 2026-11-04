const fs = require('fs');
const path = require('path');

function search(dir, regex) {
  try {
    const files = fs.readdirSync(dir);
    for (const f of files) {
      if (['node_modules', '.git', 'dist', 'backtest'].includes(f)) continue;
      const full = path.join(dir, f);
      const stat = fs.statSync(full);
      if (stat.isDirectory()) {
        search(full, regex);
      } else if (stat.isFile() && (f.endsWith('.html') || f.endsWith('.js') || f.endsWith('.css') || f.endsWith('.json'))) {
        const content = fs.readFileSync(full, 'utf8');
        if (regex.test(content)) {
          console.log(`MATCH: ${full}`);
        }
      }
    }
  } catch (err) {
    console.error(err);
  }
}

console.log('--- Searching for money-management / tabMoneyManagement / kelola-keuangan ---');
search('public', /money-management|tabMoneyManagement|kelola-keuangan/i);
search('partials', /money-management|tabMoneyManagement|kelola-keuangan/i);
search('tools', /money-management|tabMoneyManagement|kelola-keuangan/i);
