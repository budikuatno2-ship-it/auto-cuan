const fs = require('fs');

const indexHtml = fs.readFileSync('public/index.html', 'utf8');

const regex = /<details([^>]*)>([\s\S]*?)<\/details>/gi;
let match;
let count = 0;
while ((match = regex.exec(indexHtml)) !== null) {
  count++;
  const attrs = match[1];
  const inner = match[2];
  const summaryMatch = inner.match(/<summary[^>]*>([\s\S]*?)<\/summary>/i);
  const summary = summaryMatch ? summaryMatch[1].replace(/<[^>]+>/g, '').trim() : 'No summary';
  
  // Find which page container this details is inside
  const before = indexHtml.slice(0, match.index);
  const pageMatch = [...before.matchAll(/<section[^>]*id="(page-[^"]+)"/g)].pop();
  const pageId = pageMatch ? pageMatch[1] : 'unknown';
  
  console.log(`[${count}] Page: ${pageId} | Class: ${attrs.match(/class="([^"]+)"/)?.[1] || 'none'} | Summary: ${summary}`);
}
console.log(`Total details elements in index.html: ${count}`);
