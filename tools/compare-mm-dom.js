const fs = require('fs');

const dc = fs.readFileSync('handoff-redesign/design/project/KelolaKeuangan.dc.html', 'utf8');
const indexHtml = fs.readFileSync('public/index.html', 'utf8');

const mmStart = indexHtml.indexOf('<section id="page-money-management"');
const mmEnd = indexHtml.indexOf('</section>', mmStart) + '</section>'.length;
const currentMM = indexHtml.slice(mmStart, mmEnd);

console.log('--- DC CANVAS ELEMENTS ---');
console.log('Bulan select in DC:');
console.log(dc.match(/<select[^>]*aria-label="Bulan"[^>]*>[\s\S]*?<\/select>/)?.[0]);

console.log('\n--- CURRENT INDEX.HTML MM SECTION ---');
console.log(currentMM.slice(0, 800));
