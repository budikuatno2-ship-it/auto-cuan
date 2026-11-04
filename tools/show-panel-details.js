const fs = require('fs');

const html = fs.readFileSync('public/index.html', 'utf8');

function showPanel(id) {
  const idx = html.indexOf(`id="${id}"`);
  if (idx !== -1) {
    console.log(`=== ${id} ===`);
    console.log(html.slice(idx, idx + 800));
  }
}

showPanel('panel-tab-bandarmologi');
showPanel('panel-tab-intel');
showPanel('panel-tab-hunter');
showPanel('panel-tab-insider');
showPanel('panel-tab-ranking');
showPanel('panel-tab-financial');
showPanel('panel-tab-market-structure');
