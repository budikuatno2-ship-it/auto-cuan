const fs = require('fs');

const risetDcFiles = [
  'Bandarmologi.dc.html',
  'BrokerHunter.dc.html',
  'Financial.dc.html',
  'Insider.dc.html',
  'Ranking.dc.html',
  'SinyalIntelijen.dc.html',
  'StrukturPasar.dc.html'
];

risetDcFiles.forEach(f => {
  const p = 'handoff-redesign/design/project/' + f;
  if (fs.existsSync(p)) {
    const html = fs.readFileSync(p, 'utf8');
    const phMatch = html.match(/<div class="ph[\s\S]*?<\/div>\s*<\/div>/i) || html.match(/<header class="ph[\s\S]*?<\/header>/i);
    console.log(`=== ${f} ===`);
    if (phMatch) {
      console.log(phMatch[0].slice(0, 400));
    } else {
      // search for any h1 or ph
      const h1Match = html.match(/<h1[\s\S]*?<\/h1>/i);
      console.log('No .ph, h1:', h1Match ? h1Match[0] : 'None');
    }
  }
});
