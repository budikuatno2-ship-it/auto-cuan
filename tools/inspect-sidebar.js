const fs = require('fs');

const html = fs.readFileSync('public/index.html', 'utf8');

// Search for sidebar elements
const sidebarMatches = html.match(/<aside[\s\S]*?<\/aside>/gi) || html.match(/<nav[\s\S]*?<\/nav>/gi) || [];
console.log('Sidebar/Nav matches found:', sidebarMatches.length);

// Let's search for "Sektor Hot" or "Bandarmologi" or "Broker Hunter"
const keywords = ['Dashboard', 'Screener', 'Sektor Hot', 'Catatan Admin', 'Analisis & Chart', 'Bandarmologi', 'Sinyal Intelijen', 'Broker Hunter', 'Insider', 'Ranking', 'Financial', 'Struktur Pasar', 'Watchlist', 'Portfolio', 'Track Record', 'Kelola Keuangan', 'Langganan VIP', 'Pattern Radar', 'Admin Console'];

keywords.forEach(kw => {
  const idx = html.indexOf(kw);
  console.log(`Keyword "${kw}": ${idx !== -1 ? 'Found at ' + idx : 'NOT FOUND'}`);
});
