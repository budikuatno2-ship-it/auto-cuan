const fs = require('fs');

function inspectPanels(path) {
  const html = fs.readFileSync(path, 'utf8');
  console.log(`=== Inspecting ${path} ===`);
  const panels = ['panel-tab-intel', 'panel-tab-hunter', 'panel-tab-insider', 'panel-tab-ranking'];
  panels.forEach(p => {
    const idx = html.indexOf(`id="${p}"`);
    if (idx !== -1) {
      console.log(`Panel ${p} found at ${idx}:`);
      console.log(html.slice(idx, idx + 200).replace(/\s+/g, ' '));
    }
  });
}

inspectPanels('public/index.html');
inspectPanels('public/partials/analisis-saham.partial.html');
