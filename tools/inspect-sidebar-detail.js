const fs = require('fs');
const html = fs.readFileSync('public/index.html', 'utf8');

// Let's find sidebar container. Look for class or id related to sidebar or aside.
const asideMatch = html.match(/<aside[\s\S]*?<\/aside>/i);
if (asideMatch) {
  console.log('=== ASIDE CONTENT ===');
  console.log(asideMatch[0]);
} else {
  console.log('No <aside> tag. Looking for sidebar class/id:');
  const matches = html.match(/<[^>]+(?:sidebar|nav-pane|app-nav|sb-)[^>]*>[\s\S]*?<\/(?:div|nav|aside)>/gi);
  if (matches) {
    console.log('Found matches:', matches.length);
    console.log(matches[0].slice(0, 1000));
  }
}
