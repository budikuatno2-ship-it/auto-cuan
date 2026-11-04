const fs = require('fs');

const indexHtml = fs.readFileSync('public/index.html', 'utf8');
const startTag = '<section id="page-money-management"';
const endTag = '</section>\n\n<!-- ===== PAGE: ADMIN CONSOLE ===== -->';
const startIdx = indexHtml.indexOf(startTag);
const endIdx = indexHtml.indexOf(endTag) + '</section>'.length;

const mmContent = indexHtml.slice(startIdx, endIdx);

fs.writeFileSync('public/partials/money-management.partial.html', mmContent, 'utf8');
fs.writeFileSync('partials/money-management.partial.html', mmContent, 'utf8');

console.log('Partials updated successfully!');
