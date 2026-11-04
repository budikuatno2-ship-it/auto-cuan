const fs = require('fs');
const path = require('path');

const cssPath = path.join(__dirname, '../public/ac-v2.css');
let css = fs.readFileSync(cssPath, 'utf8');

// Replace lines 583-584
const oldCtx = `/* Konteks ticker */
html #appContent #page-analisis .ana-ctx { display: block; padding: 0 !important; margin: 0 !important; background: var(--ac-surface) !important; border: 1px solid var(--ac-hair) !important; border-radius: 12px !important; box-shadow: none !important; }`;

const newCtx = `/* Konteks ticker - HANYA terlihat di Analisis & Chart (.active-tab-analisis-chart) */
html #appContent #page-analisis.active-tab-analisis-chart .ana-ctx {
  display: block !important;
  padding: 0 !important;
  margin: 0 !important;
  background: var(--ac-surface) !important;
  border: 1px solid var(--ac-hair) !important;
  border-radius: 12px !important;
  box-shadow: none !important;
}
html #appContent #page-analisis:not(.active-tab-analisis-chart) .ana-ctx,
html #appContent #page-analisis .ana-ctx[style*="display: none"],
html #appContent #page-analisis .ana-ctx[style*="display:none"],
html #appContent #page-analisis #analisisChartHeader[style*="display: none"],
html #appContent #page-analisis #analisisChartHeader[style*="display:none"] {
  display: none !important;
}`;

if (css.includes(oldCtx)) {
  css = css.replace(oldCtx, newCtx);
  console.log('Updated .ana-ctx rules in ac-v2.css');
} else {
  console.log('oldCtx pattern not found verbatim, checking...');
}

// Replace line 607: html #appContent #page-analisis .ana-lenses { display: flex !important; ... }
const oldLenses = `html #appContent #page-analisis .ana-lenses { display: flex !important; gap: 4px; margin: 0 !important; padding: 0 12px !important; border: 0 !important; border-top: 1px solid var(--ac-hair) !important; border-radius: 0 !important; background: transparent !important; overflow-x: auto; }`;

const newLenses = `html #appContent #page-analisis .ana-lenses,
#analisisLensesNav,
.analisis-lens-bar {
  display: none !important;
}`;

if (css.includes(oldLenses)) {
  css = css.replace(oldLenses, newLenses);
  console.log('Updated .ana-lenses to display: none !important in ac-v2.css');
}

fs.writeFileSync(cssPath, css, 'utf8');
console.log('Saved ac-v2.css');
