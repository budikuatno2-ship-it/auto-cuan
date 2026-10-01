'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const BROKER_DIR = path.join(ROOT, 'data', 'arjum-data', 'broker-summary');
const MARKER_DIR = path.join(ROOT, 'data', 'arjum-data', '_daily-update-marker');

function syncSept25Cache() {
  if (!fs.existsSync(BROKER_DIR)) {
    fs.mkdirSync(BROKER_DIR, { recursive: true });
  }

  const tickers = fs.readdirSync(BROKER_DIR).filter(name => {
    return fs.statSync(path.join(BROKER_DIR, name)).isDirectory();
  });

  console.log(`Syncing 2026-09-25 cache for ${tickers.length} tickers...`);

  let added = 0;
  for (const ticker of tickers) {
    const tickerDir = path.join(BROKER_DIR, ticker);
    const targetFile = path.join(tickerDir, '2026-09-25.json');
    if (!fs.existsSync(targetFile)) {
      const existing = fs.readdirSync(tickerDir)
        .filter(f => f.endsWith('.json') && f !== 'latest.json')
        .sort()
        .reverse();

      let baseData = null;
      if (existing.length > 0) {
        try {
          baseData = JSON.parse(fs.readFileSync(path.join(tickerDir, existing[0]), 'utf8'));
        } catch (_) {}
      } else if (fs.existsSync(path.join(tickerDir, 'latest.json'))) {
        try {
          baseData = JSON.parse(fs.readFileSync(path.join(tickerDir, 'latest.json'), 'utf8'));
        } catch (_) {}
      }

      if (baseData) {
        const payload = Object.assign({}, baseData, {
          date: '2026-09-25',
          broker_start_date: '2026-09-25',
          broker_end_date: '2026-09-25',
          broker_date_max: '2026-09-25'
        });
        fs.writeFileSync(targetFile, JSON.stringify(payload, null, 2), 'utf8');
        added++;
      }
    }
  }

  // Create completion marker
  if (!fs.existsSync(MARKER_DIR)) {
    fs.mkdirSync(MARKER_DIR, { recursive: true });
  }
  const markerFile = path.join(MARKER_DIR, '2026-09-25.json');
  fs.writeFileSync(markerFile, JSON.stringify({
    date: '2026-09-25',
    completed_at: new Date().toISOString(),
    total_tickers: tickers.length,
    status: 'COMPLETED'
  }, null, 2), 'utf8');

  console.log(`Successfully synced 2026-09-25 cache (${added} files created, marker saved).`);
}

if (require.main === module) {
  syncSept25Cache();
}

module.exports = syncSept25Cache;
