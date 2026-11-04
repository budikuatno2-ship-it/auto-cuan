const fs = require('fs');
const path = require('path');

const partialPath = path.join(__dirname, '../public/partials/analisis-saham.partial.html');
let partialHtml = fs.readFileSync(partialPath, 'utf8');

// 1. Add .ph to panel-tab-ranking in partial
const rankingPh = `<div class="ph rise d0" style="margin-bottom:16px">
                <div>
                    <h1 class="page-title">Ranking Harian</h1>
                    <p>Klasemen kuantitatif berdasarkan volume, momentum harga, dan arus modal. Peringkat adalah angka, bukan piala.</p>
                </div>
            </div>`;

if (!partialHtml.includes('class="ph rise d0">\n                <div>\n                    <h1 class="page-title">Ranking Harian</h1>')) {
  partialHtml = partialHtml.replace(
    '<section id="panel-tab-ranking" class="analisis-tab-panel" style="display:none">\n            <div id="rankingCardOuterWrap"',
    `<section id="panel-tab-ranking" class="analisis-tab-panel" style="display:none">\n            ${rankingPh}\n            <div id="rankingCardOuterWrap"`
  );
  console.log('Added .ph header to panel-tab-ranking in partial');
}

// 2. Add .ph to panel-tab-intel in partial
const intelPh = `<div class="ph rise d0" style="margin-bottom:16px">
                <div>
                    <h1 class="page-title">Sinyal Intelijen</h1>
                    <p>Papan bukti: setiap sinyal menunjukkan status, angka pendukung, bukti dasar, dan kesegarannya.</p>
                </div>
            </div>`;

if (!partialHtml.includes('class="ph rise d0">\n                <div>\n                    <h1 class="page-title">Sinyal Intelijen</h1>')) {
  partialHtml = partialHtml.replace(
    '<section id="panel-tab-intel" class="analisis-tab-panel" style="display:none">\n            <div class="unified-card p-3.5 sm:p-4">',
    `<section id="panel-tab-intel" class="analisis-tab-panel" style="display:none">\n            ${intelPh}\n            <div class="unified-card p-3.5 sm:p-4">`
  );
  console.log('Added .ph header to panel-tab-intel in partial');
}

// 3. Add .ph to panel-tab-hunter in partial
const hunterPh = `<div class="ph rise d0" style="margin-bottom:16px">
                <div>
                    <h1 class="page-title">Broker Hunter</h1>
                    <p>Mulai dari broker, bukan ticker: saham apa yang sedang dikoleksi atau dilepas.</p>
                </div>
            </div>`;

if (!partialHtml.includes('class="ph rise d0">\n                <div>\n                    <h1 class="page-title">Broker Hunter</h1>')) {
  partialHtml = partialHtml.replace(
    '<section id="panel-tab-hunter" class="analisis-tab-panel" style="display:none">\n            <div class="unified-card p-3.5 sm:p-4">',
    `<section id="panel-tab-hunter" class="analisis-tab-panel" style="display:none">\n            ${hunterPh}\n            <div class="unified-card p-3.5 sm:p-4">`
  );
  console.log('Added .ph header to panel-tab-hunter in partial');
}

// 4. Add .ph to panel-tab-insider in partial
const insiderPh = `<div class="ph rise d0" style="margin-bottom:16px">
                <div>
                    <h1 class="page-title">Jejaring Insider</h1>
                    <p>Relasi pengendali, direksi, dan kepemilikan silang. Klik simpul untuk menyorot hubungannya.</p>
                </div>
            </div>`;

if (!partialHtml.includes('class="ph rise d0">\n                <div>\n                    <h1 class="page-title">Jejaring Insider</h1>')) {
  partialHtml = partialHtml.replace(
    '<section id="panel-tab-insider" class="analisis-tab-panel" style="display:none">\n            <div class="unified-card p-4 sm:p-5">',
    `<section id="panel-tab-insider" class="analisis-tab-panel" style="display:none">\n            ${insiderPh}\n            <div class="unified-card p-4 sm:p-5">`
  );
  console.log('Added .ph header to panel-tab-insider in partial');
}

fs.writeFileSync(partialPath, partialHtml, 'utf8');
console.log('Successfully updated public/partials/analisis-saham.partial.html');
