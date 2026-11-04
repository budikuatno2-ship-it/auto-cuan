const fs = require('fs');
const path = require('path');

function scanDir(dir) {
  const files = fs.readdirSync(dir);
  for (const f of files) {
    const full = path.join(dir, f);
    const stat = fs.statSync(full);
    if (stat.isDirectory()) {
      scanDir(full);
    } else if (f.endsWith('.html')) {
      const content = fs.readFileSync(full, 'utf8');
      const matches = [...content.matchAll(/<details([^>]*)>([\s\S]*?)<\/details>/gi)];
      if (matches.length > 0) {
        console.log(`\nFile: ${full} (${matches.length} details)`);
        matches.forEach((m, idx) => {
          const summaryMatch = m[2].match(/<summary[^>]*>([\s\S]*?)<\/summary>/i);
          const summary = summaryMatch ? summaryMatch[1].replace(/<[^>]+>/g, '').trim() : 'No summary';
          console.log(`  [${idx+1}] class="${m[1].match(/class="([^"]+)"/)?.[1] || ''}" -> summary: ${summary}`);
        });
      }
    }
  }
}

console.log('--- Scanning public and partials for <details> ---');
scanDir('public');
scanDir('partials');
