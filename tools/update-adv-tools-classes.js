const fs = require('fs');

let html = fs.readFileSync('public/index.html', 'utf8');

html = html.replace('<details class="scr-adv" id="kgAdvTools">', '<details class="scr-adv adv-tools" id="kgAdvTools">');
html = html.replace('<details class="scr-adv" id="nkAdvTools">', '<details class="scr-adv adv-tools" id="nkAdvTools">');
html = html.replace('<details class="scr-adv" id="dtAdvTools">', '<details class="scr-adv adv-tools" id="dtAdvTools">');

fs.writeFileSync('public/index.html', html, 'utf8');
console.log('scr-adv updated with adv-tools class');
