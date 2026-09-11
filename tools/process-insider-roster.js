'use strict';

/**
 * Server-Side Insider Roster & Cross-Ownership Network Pipeline
 * Extracts, normalizes, and aggregates full shareholder rosters and multi-emiten relations.
 */

const fs = require('fs');
const path = require('path');

const DATA_DIR = path.join(__dirname, '..', 'data');
const ARJUM_INSIDERS_DIR = path.join(DATA_DIR, 'arjum-data', 'insiders');
const INSIDER_DB_FILE = path.join(DATA_DIR, 'insider-network', 'insiders-db.json');
const OUTPUT_DIR = path.join(DATA_DIR, 'insider-network');

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function cleanNumber(val) {
  if (val == null) return 0;
  if (typeof val === 'number') return isNaN(val) ? 0 : val;
  var s = String(val).replace(/[,.\s]/g, '').trim();
  var n = parseFloat(s);
  return isNaN(n) ? 0 : n;
}

function parsePercentageNum(val) {
  if (val == null) return 0;
  if (typeof val === 'number') {
    if (isNaN(val) || val < 0 || val > 100) return 0;
    return val;
  }
  var s = String(val).replace(/%/g, '').trim();
  // Tangani format koma desimal Indonesia ("54,94%" -> "54.94")
  if (s.includes(',') && !s.includes('.')) {
    s = s.replace(/,/g, '.');
  } else if (s.includes(',') && s.includes('.')) {
    if (s.lastIndexOf(',') > s.lastIndexOf('.')) {
      s = s.replace(/\./g, '').replace(/,/g, '.');
    } else {
      s = s.replace(/,/g, '');
    }
  }
  s = s.replace(/[^\d.-]/g, '');
  var n = parseFloat(s);
  // Validasi batas persentase wajar (0 - 100%). Buang anomali integer overflow upstream.
  if (isNaN(n) || n < 0 || n > 100) return 0;
  return Number(n.toFixed(4));
}

function formatPercentage(num) {
  if (num == null || isNaN(num) || num < 0) return '0.00%';
  return Number(num).toFixed(2) + '%';
}

function categorizePosition(badges, positionStr, nameStr, pct) {
  var b = Array.isArray(badges) ? badges.join(' ').toUpperCase() : '';
  var p = String(positionStr || '').toUpperCase();
  var n = String(nameStr || '').toUpperCase();

  var validPct = (typeof pct === 'number' && !isNaN(pct) && pct >= 0 && pct <= 100) ? pct : 0;

  if (b.includes('PENGENDALI') || p.includes('PENGENDALI') || validPct >= 50) {
    return 'Pengendali';
  }
  if (b.includes('DIREKSI') || b.includes('DIREKTUR') || p.includes('DIREKSI') || p.includes('DIREKTUR')) {
    return 'Direksi';
  }
  if (b.includes('KOMISARIS') || p.includes('KOMISARIS')) {
    return 'Komisaris';
  }
  if (
    n.startsWith('PT ') || n.startsWith('PT.') || n.includes(' TBK') ||
    n.includes(' LTD') || n.includes(' INC') || n.includes(' CORP') ||
    n.includes(' HOLDING') || n.includes(' INVESTAMA') || n.includes(' CAPITAL') ||
    n.includes(' BANK') || n.includes(' SEKURITAS') || n.includes(' NEGARA REPUBLIK INDONESIA') ||
    p.includes('INSTITUSI') || p.includes('INVESTOR')
  ) {
    return 'Institusi';
  }
  return 'Investor Strategis';
}

function canonicalName(raw) {
  if (!raw) return '';
  return String(raw)
    .toUpperCase()
    .replace(/\b(DR|DRS|DRA|IR|PROF|H|HJ|HAJI|SH|SE|MM|MBA|PHD|PT|TBK|CV|LTD|INC|CORP)\b/g, '')
    .replace(/[.,\/#!$%\^&\*;:{}=\-_~()]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function runPipeline() {
  console.log('=== [INSIDER PIPELINE] Memulai Pemrosesan Data Pemegang Saham & Jejaring ===');
  ensureDir(OUTPUT_DIR);

  var rosterByTicker = {};
  var entityOwnershipMap = {}; // canonName -> { displayName, holdings: { TICKER: { shares, pct, category, last_date } } }

  // 1. Ingest historical DB if exists
  if (fs.existsSync(INSIDER_DB_FILE)) {
    console.log('[INSIDER PIPELINE] Membaca data historis dari insiders-db.json...');
    try {
      var dbRaw = JSON.parse(fs.readFileSync(INSIDER_DB_FILE, 'utf8'));
      if (Array.isArray(dbRaw)) {
        for (var i = 0; i < dbRaw.length; i++) {
          var item = dbRaw[i];
          var ticker = String(item.ticker || '').trim().toUpperCase();
          var name = String(item.name || item.insider_name || '').trim();
          if (!ticker || !name || name === '—') continue;

          if (!rosterByTicker[ticker]) rosterByTicker[ticker] = {};

          var canon = canonicalName(name);
          var shares = cleanNumber(item.shares_after || item.current_value || item.shares || item.shares_change);
          var pct = parsePercentageNum(item.shares_after_percentage || item.current_percentage);
          var category = categorizePosition(item.badges, item.position, name, pct);

          if (!rosterByTicker[ticker][canon] || (item.date && (!rosterByTicker[ticker][canon].last_date || item.date >= rosterByTicker[ticker][canon].last_date))) {
            rosterByTicker[ticker][canon] = {
              name: name,
              category: category,
              position: item.position || category,
              shares: shares,
              percentage: pct,
              percentage_formatted: formatPercentage(pct),
              action_type: String(item.action_type || 'HOLD').toUpperCase(),
              last_change: (item.pct_change ? String(item.pct_change) : (item.shares_change ? (item.shares_change > 0 ? '+' : '') + cleanNumber(item.shares_change).toLocaleString('id-ID') : 'Tetap')),
              last_date: item.date || '2026-09-01',
              nationality: item.nationality || 'local'
            };
          }
        }
      }
    } catch (dbErr) {
      console.warn('[INSIDER PIPELINE] Gagal parse insiders-db.json:', dbErr.message);
    }
  }

  // 2. Ingest fresh scraped per-ticker insiders from arjum-data/insiders/
  if (fs.existsSync(ARJUM_INSIDERS_DIR)) {
    var tickerDirs = fs.readdirSync(ARJUM_INSIDERS_DIR);
    console.log('[INSIDER PIPELINE] Memindai ' + tickerDirs.length + ' folder emiten di arjum-data/insiders...');

    for (var td = 0; td < tickerDirs.length; td++) {
      var tName = tickerDirs[td].toUpperCase();
      var tPath = path.join(ARJUM_INSIDERS_DIR, tickerDirs[td]);
      try {
        var stat = fs.statSync(tPath);
        if (!stat.isDirectory()) continue;

        var files = fs.readdirSync(tPath).filter(function (f) { return f.endsWith('.json'); });
        for (var fi = 0; fi < files.length; fi++) {
          var fContent = JSON.parse(fs.readFileSync(path.join(tPath, files[fi]), 'utf8'));
          var items = Array.isArray(fContent) ? fContent : (fContent.items || fContent.data || []);

          if (!rosterByTicker[tName]) rosterByTicker[tName] = {};

          for (var it = 0; it < items.length; it++) {
            var row = items[it];
            var rName = String(row.name || row.insider_name || '').trim();
            if (!rName || rName === '—') continue;

            var rCanon = canonicalName(rName);
            var rShares = cleanNumber(row.current_value || row.shares_after || row.previous_value || 0);
            var rPct = parsePercentageNum(row.current_percentage || row.shares_after_percentage || row.previous_percentage || 0);
            var rCat = categorizePosition(row.badges, row.position, rName, rPct);

            var existing = rosterByTicker[tName][rCanon];
            if (!existing || (row.date && (!existing.last_date || row.date >= existing.last_date))) {
              rosterByTicker[tName][rCanon] = {
                name: rName,
                category: rCat,
                position: (row.badges && row.badges.length) ? row.badges.join(', ') : (row.position || rCat),
                shares: rShares,
                percentage: rPct,
                percentage_formatted: formatPercentage(rPct),
                action_type: String(row.action_type || 'HOLD').toUpperCase(),
                last_change: (row.changes_percentage ? String(row.changes_percentage) + '%' : (row.changes_value ? String(row.changes_value) : 'Tetap')),
                last_date: row.date || '2026-09-09',
                nationality: row.nationality || 'local'
              };
            }
          }
        }
      } catch (_) {}
    }
  }

  // 3. Format final structured roster per ticker
  var finalRosters = {};
  var allTickers = Object.keys(rosterByTicker);

  for (var k = 0; k < allTickers.length; k++) {
    var tick = allTickers[k];
    var entitiesObj = rosterByTicker[tick];
    var list = Object.values(entitiesObj);

    // Sort descending by shares/percentage
    list.sort(function (a, b) {
      if (b.percentage !== a.percentage) return b.percentage - a.percentage;
      return b.shares - a.shares;
    });

    finalRosters[tick] = list.map(function (item, idx) {
      return Object.assign({ no: idx + 1, ticker: tick }, item);
    });

    // Populate entity ownership mapping for cross-ownership graph
    for (var li = 0; li < list.length; li++) {
      var oItem = list[li];
      var cName = canonicalName(oItem.name);
      if (!entityOwnershipMap[cName]) {
        entityOwnershipMap[cName] = {
          canonical: cName,
          displayName: oItem.name,
          category: oItem.category,
          nationality: oItem.nationality,
          holdings: []
        };
      }
      entityOwnershipMap[cName].holdings.push({
        ticker: tick,
        shares: oItem.shares,
        percentage: oItem.percentage,
        percentage_formatted: oItem.percentage_formatted,
        category: oItem.category,
        last_date: oItem.last_date
      });
    }
  }

  // 4. Build cross-ownership conglomerate relations
  var multiEmitenEntities = [];
  var networkByTicker = {};

  var allEntities = Object.values(entityOwnershipMap);
  for (var e = 0; e < allEntities.length; e++) {
    var ent = allEntities[e];
    if (ent.holdings.length >= 2) {
      multiEmitenEntities.push(ent);
    }
  }

  // Build per-ticker graph schema
  for (var ti = 0; ti < allTickers.length; ti++) {
    var curTick = allTickers[ti];
    var relatedEntities = [];
    var relatedTickers = new Set();
    relatedTickers.add(curTick);

    var curRoster = finalRosters[curTick] || [];
    for (var ri = 0; ri < curRoster.length; ri++) {
      var rEnt = curRoster[ri];
      var canon = canonicalName(rEnt.name);
      var entRecord = entityOwnershipMap[canon];
      if (entRecord && entRecord.holdings.length >= 2) {
        relatedEntities.push(entRecord);
        for (var h = 0; h < entRecord.holdings.length; h++) {
          relatedTickers.add(entRecord.holdings[h].ticker);
        }
      }
    }

    var nodes = [];
    var edges = [];

    // Ticker nodes
    relatedTickers.forEach(function (t) {
      nodes.push({
        id: 'ticker:' + t,
        ticker: t,
        type: 'ticker',
        label: t,
        isTarget: t === curTick
      });
    });

    // Entity nodes & links
    for (var rei = 0; rei < relatedEntities.length; rei++) {
      var rEntObj = relatedEntities[rei];
      var eId = 'entity:' + rEntObj.canonical;
      nodes.push({
        id: eId,
        name: rEntObj.displayName,
        type: 'entity',
        category: rEntObj.category,
        label: rEntObj.displayName
      });

      for (var hi = 0; hi < rEntObj.holdings.length; hi++) {
        var hObj = rEntObj.holdings[hi];
        edges.push({
          source: eId,
          target: 'ticker:' + hObj.ticker,
          ticker: hObj.ticker,
          percentage: hObj.percentage,
          percentage_formatted: hObj.percentage_formatted,
          shares: hObj.shares,
          category: hObj.category
        });
      }
    }

    networkByTicker[curTick] = {
      ticker: curTick,
      nodes: nodes,
      edges: edges,
      summary: {
        total_shareholders: curRoster.length,
        multi_emiten_relations: relatedEntities.length,
        connected_tickers: relatedTickers.size
      }
    };
  }

  // 5. Save mature cache JSON files
  var rosterOutputPath = path.join(OUTPUT_DIR, 'roster.json');
  var networkOutputPath = path.join(OUTPUT_DIR, 'network.json');

  var rosterPayload = {
    updated_at: new Date().toISOString(),
    total_tickers: allTickers.length,
    tickers: finalRosters
  };

  var networkPayload = {
    updated_at: new Date().toISOString(),
    total_multi_emiten_entities: multiEmitenEntities.length,
    multi_emiten_entities: multiEmitenEntities,
    networks_by_ticker: networkByTicker
  };

  fs.writeFileSync(rosterOutputPath, JSON.stringify(rosterPayload), 'utf8');
  fs.writeFileSync(networkOutputPath, JSON.stringify(networkPayload), 'utf8');

  console.log('[INSIDER PIPELINE] Selesai!');
  console.log(' - Total emiten terindeks: ' + allTickers.length);
  console.log(' - Tokoh/Entitas dengan kepemilikan multi-emiten: ' + multiEmitenEntities.length);
  console.log(' - Output roster tersimpan: ' + rosterOutputPath + ' (' + (fs.statSync(rosterOutputPath).size / 1024 / 1024).toFixed(2) + ' MB)');
  console.log(' - Output network tersimpan: ' + networkOutputPath + ' (' + (fs.statSync(networkOutputPath).size / 1024 / 1024).toFixed(2) + ' MB)');
}

if (require.main === module) {
  runPipeline();
}

module.exports = { runPipeline };
