const fs = require('fs');
const path = require('path');

const indexHtmlPath = path.join(__dirname, '../public/index.html');
let indexHtml = fs.readFileSync(indexHtmlPath, 'utf8');

// 1. Group 1 Utama
indexHtml = indexHtml.replace(
  '<section class="sidebar-nav-group" aria-label="Dashboard">',
  '<section class="sidebar-nav-group" aria-label="Utama" data-group="Utama">'
);

// 2. Remove hidden from nav-screener
indexHtml = indexHtml.replace(
  '<button id="nav-screener" type="button" onclick="navigateTo(\'screener\')" class="sidebar-item hidden"',
  '<button id="nav-screener" type="button" onclick="navigateTo(\'screener\')" class="sidebar-item"'
);

// 3. Remove tabChartWorkstation from sidebar
const chartWorkstationRegex = /\s*<button id="tabChartWorkstation"[\s\S]*?<\/button>/;
if (chartWorkstationRegex.test(indexHtml)) {
  indexHtml = indexHtml.replace(chartWorkstationRegex, '');
  console.log('Removed tabChartWorkstation from sidebar in index.html');
}

// 4. Group 5 Admin: remove hidden from tabAnalisisPattern in index.html
indexHtml = indexHtml.replace(
  '<button id="tabAnalisisPattern" type="button" onclick="navigateTo(\'analisis\', \'pattern\')" class="sidebar-item hidden"',
  '<button id="tabAnalisisPattern" type="button" onclick="navigateTo(\'analisis\', \'pattern\')" class="sidebar-item"'
);

// 5. Add .ph to panel-tab-ranking in index.html
const rankingPh = `<div class="ph rise d0" style="margin-bottom:16px">
                <div>
                    <h1 class="page-title">Ranking Harian</h1>
                    <p>Klasemen kuantitatif berdasarkan volume, momentum harga, dan arus modal. Peringkat adalah angka, bukan piala.</p>
                </div>
            </div>`;

if (!indexHtml.includes('class="ph rise d0">\n                <div>\n                    <h1 class="page-title">Ranking Harian</h1>')) {
  indexHtml = indexHtml.replace(
    '<section id="panel-tab-ranking" class="analisis-tab-panel" style="display:none">\n            <div id="rankingCardOuterWrap"',
    `<section id="panel-tab-ranking" class="analisis-tab-panel" style="display:none">\n            ${rankingPh}\n            <div id="rankingCardOuterWrap"`
  );
  console.log('Added .ph header to panel-tab-ranking in index.html');
}

// 6. Add .ph to panel-tab-intel in index.html
const intelPh = `<div class="ph rise d0" style="margin-bottom:16px">
                <div>
                    <h1 class="page-title">Sinyal Intelijen</h1>
                    <p>Papan bukti: setiap sinyal menunjukkan status, angka pendukung, bukti dasar, dan kesegarannya.</p>
                </div>
            </div>`;

if (!indexHtml.includes('class="ph rise d0">\n                <div>\n                    <h1 class="page-title">Sinyal Intelijen</h1>')) {
  indexHtml = indexHtml.replace(
    '<section id="panel-tab-intel" class="analisis-tab-panel" style="display:none">\n            <div class="unified-card p-3.5 sm:p-4">',
    `<section id="panel-tab-intel" class="analisis-tab-panel" style="display:none">\n            ${intelPh}\n            <div class="unified-card p-3.5 sm:p-4">`
  );
  console.log('Added .ph header to panel-tab-intel in index.html');
}

// 7. Add .ph to panel-tab-hunter in index.html
const hunterPh = `<div class="ph rise d0" style="margin-bottom:16px">
                <div>
                    <h1 class="page-title">Broker Hunter</h1>
                    <p>Mulai dari broker, bukan ticker: saham apa yang sedang dikoleksi atau dilepas.</p>
                </div>
            </div>`;

if (!indexHtml.includes('class="ph rise d0">\n                <div>\n                    <h1 class="page-title">Broker Hunter</h1>')) {
  indexHtml = indexHtml.replace(
    '<section id="panel-tab-hunter" class="analisis-tab-panel" style="display:none">\n            <div class="unified-card p-3.5 sm:p-4">',
    `<section id="panel-tab-hunter" class="analisis-tab-panel" style="display:none">\n            ${hunterPh}\n            <div class="unified-card p-3.5 sm:p-4">`
  );
  console.log('Added .ph header to panel-tab-hunter in index.html');
}

// 8. Add .ph to panel-tab-insider in index.html
const insiderPh = `<div class="ph rise d0" style="margin-bottom:16px">
                <div>
                    <h1 class="page-title">Jejaring Insider</h1>
                    <p>Relasi pengendali, direksi, dan kepemilikan silang. Klik simpul untuk menyorot hubungannya.</p>
                </div>
            </div>`;

if (!indexHtml.includes('class="ph rise d0">\n                <div>\n                    <h1 class="page-title">Jejaring Insider</h1>')) {
  indexHtml = indexHtml.replace(
    '<section id="panel-tab-insider" class="analisis-tab-panel" style="display:none">\n            <div class="unified-card p-4 sm:p-5">',
    `<section id="panel-tab-insider" class="analisis-tab-panel" style="display:none">\n            ${insiderPh}\n            <div class="unified-card p-4 sm:p-5">`
  );
  console.log('Added .ph header to panel-tab-insider in index.html');
}

fs.writeFileSync(indexHtmlPath, indexHtml, 'utf8');
console.log('Successfully updated public/index.html');
