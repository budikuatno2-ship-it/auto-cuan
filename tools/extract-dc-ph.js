const fs = require('fs');

['SinyalIntelijen.dc.html', 'BrokerHunter.dc.html', 'Insider.dc.html', 'Ranking.dc.html'].forEach(f => {
  const c = fs.readFileSync('handoff-redesign/design/project/' + f, 'utf8');
  const m = c.match(/<div class="ph rise d0"[\s\S]*?<\/div>\s*<\/div>/);
  console.log(`=== ${f} ===`);
  if (m) console.log(m[0]);
  else {
    const m2 = c.match(/<div class="ph[\s\S]*?<\/div>/);
    console.log(m2 ? m2[0] : 'not found');
  }
});
