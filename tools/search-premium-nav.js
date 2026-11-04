const fs = require('fs');
const path = require('path');

function search(dir, regex) {
  const files = fs.readdirSync(dir);
  for (const f of files) {
    const full = path.join(dir, f);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      search(full, regex);
    } else if (f.endsWith('.js') || f.endsWith('.css') || f.endsWith('.html')) {
      const content = fs.readFileSync(full, 'utf8');
      if (regex.test(content)) {
        console.log(`MATCH: ${full}`);
      }
    }
  }
}

search('public', /premium-nav/);
