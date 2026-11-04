const fs = require('fs');
const html = fs.readFileSync('public/index.html', 'utf8');

const startIdx = html.indexOf('<aside id="appSidebar"');
const endIdx = html.indexOf('</aside>', startIdx);

if (startIdx !== -1 && endIdx !== -1) {
  const sidebarHtml = html.slice(startIdx, endIdx + 8);
  console.log('Sidebar length:', sidebarHtml.length);
  console.log(sidebarHtml);
} else {
  console.log('appSidebar not found or closed properly');
}
