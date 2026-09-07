'use strict';

/**
 * Foreign Flow Top 10 Recap Service
 *
 * Computes:
 *  - Top 10 Foreign Accumulation (Net Buy)
 *  - Top 10 Foreign Distribution (Net Sell)
 *  - Total Net Foreign across all IDX stocks
 *
 * Uses cached broker-summary data from disk (957 tickers universe)
 * and formats a clean recap message for Telegram.
 */

const fs = require('node:fs');
const path = require('node:path');
const telegramNotifier = require('./telegram-notifier');

const ARJUM_BASE_DIR = process.env.ARJUM_DATA_DIR || path.join(__dirname, '..', 'data', 'arjum-data');

const FOREIGN_BROKERS = new Set([
  'AK', // UBS Sekuritas
  'BK', // J.P. Morgan Sekuritas
  'CS', // Credit Suisse
  'RX', // Macquarie Sekuritas
  'KZ', // CLSA Sekuritas
  'ZP', // Maybank Sekuritas
  'DB', // Deutsche Sekuritas
  'GW', // HSBC Sekuritas
  'DP', // DBS Vickers
  'MS', // Morgan Stanley
  'CG', // Citigroup Sekuritas
  'ML', // Merrill Lynch / BofA
  'BQ', // Korea Investment
  'FS', // Yuanta Sekuritas
  'YU'  // CGS International
]);

function isForeignBroker(code) {
  if (!code) return false;
  return FOREIGN_BROKERS.has(String(code).trim().toUpperCase());
}

function getTodayWibDateStr(now) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  });
  return fmt.format(now || new Date());
}

function formatWibHumanDate(dateStr) {
  if (!dateStr) return 'Hari Ini';
  try {
    const d = new Date(dateStr + 'T12:00:00+07:00');
    const dayNames = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
    const monthNames = [
      'Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni',
      'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'
    ];
    return `${dayNames[d.getDay()]}, ${d.getDate()} ${monthNames[d.getMonth()]} ${d.getFullYear()}`;
  } catch (_) {
    return dateStr;
  }
}

function formatIDR(num) {
  if (num == null || isNaN(num)) return '0';
  const abs = Math.abs(num);
  if (abs >= 1e12) return (num / 1e12).toFixed(2) + ' T';
  if (abs >= 1e9) return (num / 1e9).toFixed(2) + ' M';
  if (abs >= 1e6) return (num / 1e6).toFixed(1) + ' jt';
  return new Intl.NumberFormat('id-ID').format(num);
}

function loadUniverseTickers() {
  try {
    const txtPath = path.join(__dirname, '..', 'data', 'daytrade-observe-tickers.txt');
    if (fs.existsSync(txtPath)) {
      return fs.readFileSync(txtPath, 'utf8')
        .split(/\r?\n/)
        .map(t => t.trim().toUpperCase())
        .filter(t => Boolean(t) && /^[A-Z0-9.-]{2,10}$/.test(t));
    }
  } catch (_) {}
  return [];
}

function readSummaryFromDisk(ticker, date) {
  try {
    const p = path.join(ARJUM_BASE_DIR, 'broker-summary', ticker, `${date}.json`);
    if (fs.existsSync(p)) {
      return JSON.parse(fs.readFileSync(p, 'utf8'));
    }
  } catch (_) {}
  return null;
}

function computeForeignFlowRecap(options = {}) {
  const targetDate = options.date || getTodayWibDateStr();
  const tickers = (Array.isArray(options.tickers) && options.tickers.length > 0)
    ? options.tickers
    : loadUniverseTickers();

  const stockResults = [];
  let totalNetForeign = 0;
  let stocksWithDataCount = 0;

  for (const ticker of tickers) {
    const summary = readSummaryFromDisk(ticker, targetDate);
    if (!summary) continue;

    stocksWithDataCount++;

    const brokerMap = new Map();

    const buyers = summary.gross_buyers || summary.top_buyers || summary.buyers || [];
    for (const b of buyers) {
      const code = (b.broker || b.broker_code || '').trim().toUpperCase();
      if (!isForeignBroker(code)) continue;
      if (!brokerMap.has(code)) {
        brokerMap.set(code, { code, bval: 0, sval: 0, bvol: 0, svol: 0 });
      }
      const item = brokerMap.get(code);
      const bval = Number(b.bval != null ? b.bval : (b.buy_val || b.val || b.value || 0)) || 0;
      const bvol = Number(b.bvol != null ? b.bvol : (b.buy_vol || b.vol || b.volume || 0)) || 0;
      item.bval = Math.max(item.bval, bval);
      item.bvol = Math.max(item.bvol, bvol);
    }

    const sellers = summary.gross_sellers || summary.top_sellers || summary.sellers || [];
    for (const s of sellers) {
      const code = (s.broker || s.broker_code || '').trim().toUpperCase();
      if (!isForeignBroker(code)) continue;
      if (!brokerMap.has(code)) {
        brokerMap.set(code, { code, bval: 0, sval: 0, bvol: 0, svol: 0 });
      }
      const item = brokerMap.get(code);
      const sval = Number(s.sval != null ? s.sval : (s.sell_val || s.val || s.value || 0)) || 0;
      const svol = Number(s.svol != null ? s.svol : (s.sell_vol || s.vol || s.volume || 0)) || 0;
      item.sval = Math.max(item.sval, sval);
      item.svol = Math.max(item.svol, svol);
    }

    let foreignBuyVal = 0;
    let foreignSellVal = 0;
    let foreignBuyVol = 0;
    let foreignSellVol = 0;
    const topForeignBrokers = [];

    for (const item of brokerMap.values()) {
      foreignBuyVal += item.bval;
      foreignSellVal += item.sval;
      foreignBuyVol += item.bvol;
      foreignSellVol += item.svol;
      const net = item.bval - item.sval;
      topForeignBrokers.push({ code: item.code, net, bval: item.bval, sval: item.sval });
    }

    const netVal = foreignBuyVal - foreignSellVal;
    const netVol = foreignBuyVol - foreignSellVol;

    topForeignBrokers.sort((a, b) => Math.abs(b.net) - Math.abs(a.net));

    if (brokerMap.size > 0 || foreignBuyVal > 0 || foreignSellVal > 0) {
      totalNetForeign += netVal;
      stockResults.push({
        ticker,
        net_val: netVal,
        net_vol: netVol,
        buy_val: foreignBuyVal,
        sell_val: foreignSellVal,
        broker_count: brokerMap.size,
        top_foreign_brokers: topForeignBrokers.slice(0, 3).map(b => b.code)
      });
    }
  }

  // Top 10 Foreign Accumulation (Net Buy)
  const topAccumulated = stockResults
    .filter(s => s.net_val > 0)
    .sort((a, b) => b.net_val - a.net_val)
    .slice(0, 10);

  // Top 10 Foreign Distribution (Net Sell)
  const topDistributed = stockResults
    .filter(s => s.net_val < 0)
    .sort((a, b) => a.net_val - b.net_val) // Most negative first
    .slice(0, 10);

  return {
    date: targetDate,
    total_net_foreign: totalNetForeign,
    stocks_scanned: stocksWithDataCount,
    total_universe: tickers.length,
    top_accumulated: topAccumulated,
    top_distributed: topDistributed
  };
}

function formatForeignFlowRecapMessage(data) {
  const dateFormatted = formatWibHumanDate(data.date);
  const totalNet = data.total_net_foreign || 0;
  const isNetBuyTotal = totalNet >= 0;
  const totalSign = isNetBuyTotal ? '+' : '-';
  const totalTone = isNetBuyTotal ? '🟢 NET BUY' : '🔴 NET SELL';

  const lines = [
    '🌐 <b>REKAP TOP 10 FOREIGN FLOW HARIAN (IDX)</b>',
    `📅 <i>${dateFormatted} (Penutupan Bursa)</i>`,
    '━━━━━━━━━━━━━━━━━━━━',
    `🏛️ <b>Total Net Foreign IDX:</b> <code>${totalSign}Rp ${formatIDR(Math.abs(totalNet))}</code> (${totalTone})`,
    `📊 <i>Dipindai dari ${data.stocks_scanned || 0} emiten berdata di bursa.</i>`,
    ''
  ];

  // Top 10 Accumulation
  lines.push('🟢 <b>TOP 10 FOREIGN ACCUMULATION (NET BUY)</b>');
  if (data.top_accumulated && data.top_accumulated.length > 0) {
    data.top_accumulated.forEach((item, idx) => {
      const rank = idx + 1;
      const brokers = item.top_foreign_brokers && item.top_foreign_brokers.length > 0
        ? ` (${item.top_foreign_brokers.join(', ')})`
        : '';
      lines.push(`${rank}. <b>${item.ticker}</b>: <code>+Rp ${formatIDR(item.net_val)}</code>${brokers}`);
    });
  } else {
    lines.push('<i>Tidak ada akumulasi asing tercatat pada tanggal ini.</i>');
  }

  lines.push('');

  // Top 10 Distribution
  lines.push('🔴 <b>TOP 10 FOREIGN DISTRIBUTION (NET SELL)</b>');
  if (data.top_distributed && data.top_distributed.length > 0) {
    data.top_distributed.forEach((item, idx) => {
      const rank = idx + 1;
      const brokers = item.top_foreign_brokers && item.top_foreign_brokers.length > 0
        ? ` (${item.top_foreign_brokers.join(', ')})`
        : '';
      lines.push(`${rank}. <b>${item.ticker}</b>: <code>-Rp ${formatIDR(Math.abs(item.net_val))}</code>${brokers}`);
    });
  } else {
    lines.push('<i>Tidak ada distribusi asing tercatat pada tanggal ini.</i>');
  }

  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━');
  lines.push('💡 <i>Aliran dana asing (Smart Money) dihitung berdasarkan data broker resmi IDX (AK, BK, CS, RX, KZ, ZP, dll.). Bukan ajakan jual/beli.</i>');

  return lines.join('\n');
}

async function sendForeignFlowRecap(options = {}) {
  const dryRun = options.dryRun !== false && options.send !== true;
  const recap = computeForeignFlowRecap(options);
  const message = formatForeignFlowRecapMessage(recap);

  if (dryRun) {
    return {
      sent: false,
      dry_run: true,
      data: recap,
      message
    };
  }

  const result = await telegramNotifier.sendMessage(message, {
    parse_mode: 'HTML',
    chat_id: options.chatId || null
  });

  return {
    sent: result.sent === true,
    dry_run: false,
    status: result.status,
    reason: result.reason,
    data: recap,
    message
  };
}

module.exports = {
  FOREIGN_BROKERS,
  isForeignBroker,
  getTodayWibDateStr,
  formatWibHumanDate,
  formatIDR,
  computeForeignFlowRecap,
  formatForeignFlowRecapMessage,
  sendForeignFlowRecap
};
