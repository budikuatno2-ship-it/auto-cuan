(function (root) {
  'use strict';

  function byId(id) {
    return document.getElementById(id);
  }

  function escapeHtml(str) {
    if (!str) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#039;');
  }

  function formatIDR(num) {
    if (num == null || isNaN(num)) return '—';
    var abs = Math.abs(num);
    if (abs >= 1e12) return (num / 1e12).toFixed(2) + ' T';
    if (abs >= 1e9) return (num / 1e9).toFixed(2) + ' M';
    if (abs >= 1e6) return (num / 1e6).toFixed(1) + ' jt';
    return new Intl.NumberFormat('id-ID').format(num);
  }

  function formatNumber(num) {
    if (num == null || isNaN(num)) return '—';
    return new Intl.NumberFormat('id-ID').format(num);
  }

  // IDX Broker Code to Full Security Name Dictionary
  var BROKER_NAMES = {
    'YP': 'Mirae Asset Sekuritas Indonesia',
    'CC': 'Mandiri Sekuritas',
    'PD': 'Indo Premier Sekuritas',
    'NI': 'BNI Sekuritas',
    'BK': 'J.P. Morgan Sekuritas Indonesia',
    'AK': 'UBS Sekuritas Indonesia',
    'CS': 'Credit Suisse Sekuritas Indonesia',
    'RX': 'Macquarie Sekuritas Indonesia',
    'DX': 'Bahana Sekuritas',
    'ZP': 'Maybank Sekuritas Indonesia',
    'XC': 'Ajaib Sekuritas Asia',
    'CP': 'KB Valbury Sekuritas',
    'GR': 'Panin Sekuritas',
    'MG': 'Semesta Indovest Sekuritas',
    'OD': 'BRI Danareksa Sekuritas',
    'SQ': 'BCA Sekuritas',
    'KZ': 'CLSA Sekuritas Indonesia',
    'LG': 'Trimegah Sekuritas Indonesia',
    'AZ': 'Sucor Sekuritas',
    'EP': 'MNC Sekuritas',
    'KI': 'Ciptadana Sekuritas Asia',
    'XL': 'Stockbit Sekuritas',
    'IF': 'Samuel Sekuritas Indonesia',
    'AI': 'UOB Kay Hian Sekuritas',
    'KK': 'Phillip Sekuritas Indonesia',
    'HD': 'KGI Sekuritas Indonesia',
    'DR': 'RHB Sekuritas Indonesia',
    'YU': 'CGS International Sekuritas Indonesia',
    'DB': 'Deutsche Sekuritas Indonesia',
    'GW': 'HSBC Sekuritas Indonesia',
    'CD': 'Mega Capital Sekuritas',
    'HP': 'Henan Putihrai Sekuritas',
    'AT': 'Phintraco Sekuritas',
    'FS': 'Yuanta Sekuritas Indonesia',
    'AN': 'Wanteg Sekuritas',
    'AO': 'Erdikha Elit Sekuritas',
    'AP': 'Pacific Sekuritas Indonesia',
    'AR': 'Binaartha Sekuritas',
    'BQ': 'Korea Investment & Sekuritas Indonesia',
    'DP': 'DBS Vickers Sekuritas Indonesia',
    'DS': 'Danpac Sekuritas',
    'GA': 'IIF Sekuritas',
    'IN': 'Investindo Nusantara Sekuritas',
    'IP': 'Sinarmas Sekuritas',
    'MI': 'Victoria Sekuritas Indonesia',
    'PG': 'Panca Global Sekuritas',
    'RB': 'Reliance Sekuritas Indonesia',
    'RG': 'Profindo Sekuritas Indonesia',
    'RO': 'NISP Sekuritas',
    'SF': 'Surya Fajar Sekuritas',
    'SH': 'Artha Sekuritas Indonesia',
    'SS': 'Shinhan Sekuritas Indonesia',
    'TF': 'Universal Broker Indonesia',
    'TP': 'OCBC Sekuritas Indonesia',
    'XA': 'NH Korindo Sekuritas Indonesia',
    'YJ': 'Lotus Andalan Sekuritas'
  };

  function getBrokerSecurityName(brokerCode, fallbackName) {
    if (!brokerCode) return '—';
    var code = String(brokerCode).trim().toUpperCase();
    if (BROKER_NAMES[code]) {
      return BROKER_NAMES[code];
    }
    if (fallbackName && String(fallbackName).trim()) {
      return String(fallbackName).trim();
    }
    return 'Broker ' + code;
  }

  // Authoritative Indonesian Foreign Broker Master List
  var FOREIGN_BROKERS = [
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
  ];

  function isForeignBroker(code) {
    if (!code) return false;
    var c = String(code).trim().toUpperCase();
    return FOREIGN_BROKERS.indexOf(c) >= 0;
  }

  function filterBrokersByFlow(list, flow) {
    if (!Array.isArray(list)) return [];
    if (flow === 'F') {
      return list.filter(function (b) { return isForeignBroker(b && (b.broker || b.broker_code)); });
    }
    if (flow === 'D') {
      return list.filter(function (b) { return !isForeignBroker(b && (b.broker || b.broker_code)); });
    }
    return list;
  }

  function normalizeBrokerValue(val, vol, avgPrice) {
    if (!val || isNaN(val)) return 0;
    var num = Number(val);
    if (vol && avgPrice && vol > 0 && avgPrice > 0) {
      var expected = vol * avgPrice;
      if (expected > 0 && Math.abs(num / expected - 100) < 20) {
        return Math.round(num / 100);
      }
    }
    // Anomaly guard: if single-day broker value exceeds 1 Triliun IDR with 100x multiplier artifact
    if (Math.abs(num) >= 1e12 && vol && avgPrice && vol > 0 && avgPrice > 0) {
      var exp = vol * avgPrice;
      if (exp > 0 && Math.abs(num / exp - 100) < 30) {
        return Math.round(num / 100);
      }
    }
    return num;
  }

  function computeAvgPrice(val, vol, explicitAvg) {
    if (explicitAvg && explicitAvg > 0) {
      if (explicitAvg > 100000 && vol > 0 && Math.round(explicitAvg / 100) >= 50) {
        return Math.round(explicitAvg / 100);
      }
      return Math.round(explicitAvg);
    }
    if (!val || !vol || vol <= 0) return 0;
    var avg = val / vol;
    if (avg > 100000 && Math.round(avg / 100) >= 50) {
      return Math.round(avg / 100);
    }
    return Math.round(avg);
  }

  var currentBandarTicker = 'BBCA';
  var currentBandarDate = '';
  var lastBandarData = null;
  var brokerSummaryMode = 'gross'; // 'gross' or 'net'
  var brokerSummaryView = 'bubble'; // 'bubble' (default) or 'table'
  var brokerAccumulationView = 'bubble'; // 'bubble' (default) or 'table'
  var brokerSummaryRange = '1d'; // '1d' (default), '7d', '30d', 'custom'
  var customRangeStart = '';
  var customRangeEnd = '';
  var brokerFlowFilter = 'all'; // 'all', 'F' (foreign), 'D' (domestic)
  var bandarSection = 'summary'; // 'summary' (Broker Summary) or 'akumulasi' (Akumulasi Broker)
  var selectedBrokerCode = '';
  var bubbleFilterSide = 'all'; // 'all', 'buy', 'sell'
  var lastBrokerItems = [];

  // Broker Hunter state
  var hunterBroker = 'AK';
  var hunterRange = '1d';
  var hunterStartDate = '';
  var hunterEndDate = '';
  var hunterData = null;
  var hunterLoading = false;
  var hunterError = null;

  function injectBubbleStyles() {
    if (typeof document === 'undefined') return;
    if (byId('ac-broker-bubble-styles')) return;

    var style = document.createElement('style');
    style.id = 'ac-broker-bubble-styles';
    style.textContent = [
      '@keyframes acBubblePopIn {',
      '  0% { opacity: 0; transform: scale(0.25); }',
      '  70% { transform: scale(1.08); }',
      '  100% { opacity: 1; transform: scale(1); }',
      '}',
      '@keyframes acBubbleFloat1 {',
      '  0%, 100% { transform: translateY(0px) rotate(0deg); }',
      '  50% { transform: translateY(-7px) rotate(1deg); }',
      '}',
      '@keyframes acBubbleFloat2 {',
      '  0%, 100% { transform: translateY(0px) rotate(0deg); }',
      '  50% { transform: translateY(7px) rotate(-1deg); }',
      '}',
      '@keyframes acBubbleFloat3 {',
      '  0%, 100% { transform: translate(0px, 0px); }',
      '  33% { transform: translate(4px, -5px); }',
      '  66% { transform: translate(-3px, 4px); }',
      '}',
      '@keyframes acBubbleFloat4 {',
      '  0%, 100% { transform: translate(0px, 0px); }',
      '  50% { transform: translate(-4px, -6px); }',
      '}',
      '@keyframes acFadeIn {',
      '  from { opacity: 0; transform: translateY(6px); }',
      '  to { opacity: 1; transform: translateY(0); }',
      '}',
      '.ac-broker-bubble {',
      '  border-radius: 9999px;',
      '  display: flex;',
      '  flex-direction: column;',
      '  align-items: center;',
      '  justify-content: center;',
      '  cursor: pointer;',
      '  user-select: none;',
      '  transition: transform 0.35s cubic-bezier(0.34, 1.56, 0.64, 1), box-shadow 0.25s ease, border-color 0.2s ease;',
      '  position: relative;',
      '  will-change: transform;',
      '  border-style: solid;',
      '  border-width: 1.5px;',
      '  touch-action: manipulation;',
      '  -webkit-tap-highlight-color: transparent;',
      '}',
      '.ac-broker-bubble:hover {',
      '  transform: scale(1.1) !important;',
      '  z-index: 20;',
      '}',
      '.ac-broker-bubble.ac-bubble-selected {',
      '  transform: scale(1.18) !important;',
      '  z-index: 30;',
      '  box-shadow: 0 0 24px rgba(255, 255, 255, 0.5), inset 0 0 14px rgba(255, 255, 255, 0.3) !important;',
      '  border-color: #ffffff !important;',
      '  border-width: 2.5px !important;',
      '  animation: none !important;',
      '}',
      '.ac-fade-in {',
      '  animation: acFadeIn 0.25s ease-out forwards;',
      '}'
    ].join('\n');
    document.head.appendChild(style);
  }

  // Returns the first argument that is a non-empty array; falls through
  // subsequent candidates otherwise, ending at []. Unlike `a || b || []`,
  // this correctly treats an empty array as "no data here, try the next
  // one" instead of stopping on it (`[]` is truthy, so `||` never falls
  // through past it).
  function firstNonEmptyList() {
    for (var i = 0; i < arguments.length; i++) {
      if (Array.isArray(arguments[i]) && arguments[i].length > 0) return arguments[i];
    }
    return [];
  }

  function buildBrokerBubbleItems(buyers, sellers, mode) {
    var isGross = mode === 'gross';
    var map = {};

    function processItem(item, isBuyerList) {
      if (!item || !item.broker) return;
      var code = String(item.broker).trim().toUpperCase();
      if (!map[code]) {
        map[code] = {
          broker: code,
          rawName: item.broker_name || '',
          fullName: getBrokerSecurityName(code, item.broker_name),
          bval: 0,
          sval: 0,
          bvol: 0,
          svol: 0,
          bfrq: 0,
          sfrq: 0,
          avgBuy: 0,
          avgSell: 0,
          explicitNetVal: null,
          explicitNetVol: null
        };
      }

      var target = map[code];
      if (item.broker_name && !target.rawName) {
        target.rawName = item.broker_name;
        target.fullName = getBrokerSecurityName(code, item.broker_name);
      }

      var bval = item.bval != null ? Number(item.bval) : (item.buy_val != null ? Number(item.buy_val) : (isBuyerList ? Number(item.net_val || item.val || item.value || 0) : 0));
      var sval = item.sval != null ? Number(item.sval) : (item.sell_val != null ? Number(item.sell_val) : (!isBuyerList ? Math.abs(Number(item.net_val || item.val || item.value || 0)) : 0));
      var bvol = item.bvol != null ? Number(item.bvol) : (item.buy_vol != null ? Number(item.buy_vol) : (isBuyerList ? Number(item.net_vol || item.vol || item.volume || 0) : 0));
      var svol = item.svol != null ? Number(item.svol) : (item.sell_vol != null ? Number(item.sell_vol) : (!isBuyerList ? Math.abs(Number(item.net_vol || item.vol || item.volume || 0)) : 0));

      if (bval > target.bval) target.bval = bval;
      if (sval > target.sval) target.sval = sval;
      if (bvol > target.bvol) target.bvol = bvol;
      if (svol > target.svol) target.svol = svol;

      if (item.bfrq && item.bfrq > target.bfrq) target.bfrq = item.bfrq;
      if (item.sfrq && item.sfrq > target.sfrq) target.sfrq = item.sfrq;

      // avg_buy / avg_sell: prefer explicit, fallback to val/vol
      if (item.avg_buy && isBuyerList) target.avgBuy = item.avg_buy;
      else if (item.avg_price && isBuyerList) target.avgBuy = item.avg_price;
      if (item.avg_sell && !isBuyerList) target.avgSell = item.avg_sell;
      else if (item.avg_price && !isBuyerList) target.avgSell = item.avg_price;

      // nval: prefer explicit field, works for both buyer and seller items
      var itemNval = item.nval != null ? Number(item.nval) : (item.net_val != null ? Number(item.net_val) : null);
      if (itemNval != null) {
        if (!isBuyerList) {
          // Only mark negative if no previous net value was set or if sell value actually dominates
          if (target.explicitNetVal == null || target.bval < target.sval) {
            target.explicitNetVal = -Math.abs(itemNval);
          }
        } else {
          target.explicitNetVal = itemNval >= 0 ? Math.abs(itemNval) : itemNval;
        }
      }

      var itemNvol = item.nvol != null ? Number(item.nvol) : (item.net_vol != null ? Number(item.net_vol) : null);
      if (itemNvol != null) {
        if (!isBuyerList) {
          if (target.explicitNetVol == null || target.bvol < target.svol) {
            target.explicitNetVol = -Math.abs(itemNvol);
          }
        } else {
          target.explicitNetVol = itemNvol >= 0 ? Math.abs(itemNvol) : itemNvol;
        }
      }
    }

    var bList = Array.isArray(buyers) ? buyers : [];
    var sList = Array.isArray(sellers) ? sellers : [];

    for (var i = 0; i < bList.length; i++) {
      processItem(bList[i], true);
    }
    for (var j = 0; j < sList.length; j++) {
      processItem(sList[j], false);
    }

    var items = [];
    var maxTxVal = 1;
    var maxAbsNet = 1;

    var codes = Object.keys(map);
    for (var c = 0; c < codes.length; c++) {
      var it = map[codes[c]];

      // Fix avgSell & avgBuy: ensure price per share (@ Rp)
      it.avgSell = computeAvgPrice(it.sval, it.svol, it.avgSell);
      it.avgBuy = computeAvgPrice(it.bval, it.bvol, it.avgBuy);

      // Normalize values if 100x over-multiplication happened
      var normBval = normalizeBrokerValue(it.bval, it.bvol, it.avgBuy);
      var normSval = normalizeBrokerValue(it.sval, it.svol, it.avgSell);
      if (normBval !== it.bval) it.bval = normBval;
      if (normSval !== it.sval) it.sval = normSval;

      var netVal;
      if (it.bval > 0 && it.sval > 0) {
        netVal = it.bval - it.sval;
      } else if (it.explicitNetVal != null) {
        netVal = it.explicitNetVal;
      } else {
        netVal = it.bval - it.sval;
      }

      var netVol;
      if (it.bvol > 0 && it.svol > 0) {
        netVol = it.bvol - it.svol;
      } else if (it.explicitNetVol != null) {
        netVol = it.explicitNetVol;
      } else {
        netVol = it.bvol - it.svol;
      }

      // Anomaly correction on netVal if over-inflated into trillions
      if (Math.abs(netVal) >= 1e12 && (it.bvol > 0 || it.svol > 0)) {
        var refPrice = it.avgBuy || it.avgSell || 0;
        var refVol = Math.max(it.bvol, it.svol);
        if (refPrice > 0 && refVol > 0) {
          var approxNet = normalizeBrokerValue(netVal, refVol, refPrice);
          if (approxNet !== netVal) netVal = approxNet;
        } else if (Math.abs(netVal) >= 1e12) {
          netVal = Math.round(netVal / 100);
        }
      }

      var isNetBuyer;
      if (it.bval > 0 && it.sval > 0) {
        isNetBuyer = it.bval >= it.sval;
      } else if (it.explicitNetVal != null) {
        isNetBuyer = it.explicitNetVal >= 0;
      } else if (it.bval > 0) {
        isNetBuyer = true;
      } else if (it.sval > 0) {
        isNetBuyer = false;
      } else {
        isNetBuyer = netVal >= 0;
      }

      // Sizing transaction value
      var txVal = isGross ? Math.max(it.bval, it.sval, Math.abs(netVal)) : Math.abs(netVal);
      if (txVal <= 0) txVal = 1;

      it.netVal = netVal;
      it.nvol = netVol;
      it.isNetBuyer = isNetBuyer;
      it.txVal = txVal;

      if (txVal > maxTxVal) maxTxVal = txVal;
      if (Math.abs(netVal) > maxAbsNet) maxAbsNet = Math.abs(netVal);

      items.push(it);
    }

    // Sort descending by transaction magnitude
    items.sort(function (a, b) {
      return b.txVal - a.txVal;
    });

    // Assign sizes, 3-tier colors, and animation presets
    for (var k = 0; k < items.length; k++) {
      var item = items[k];
      var sizeRatio = Math.sqrt(item.txVal / maxTxVal);
      // Diameter clamped between 56px and 104px
      var size = Math.round(56 + sizeRatio * 48);
      item.size = size;

      var netRatio = maxAbsNet > 0 ? (Math.abs(item.netVal) / maxAbsNet) : 0;
      var tier = 1;
      if (netRatio >= 0.55) {
        tier = 3;
      } else if (netRatio >= 0.22) {
        tier = 2;
      }
      item.colorTier = tier;

      // Continuous float animation parameters
      item.floatId = (k % 4) + 1;
      item.floatDuration = (3.2 + (k % 5) * 0.4).toFixed(1);
      item.staggerDelay = (k * 0.05).toFixed(2);
    }

    return items;
  }

  function renderBrokerDetailCardHtml(broker, mode) {
    if (!broker) {
      return '<div class="p-6 text-center text-gray-400 text-xs bg-dark-800/70 rounded-2xl border border-dark-600/40">Pilih salah satu bubble broker di atas untuk melihat detail lengkap.</div>';
    }

    var isGross = mode === 'gross';
    var isNetBuyer = broker.isNetBuyer;
    var bval = broker.bval || 0;
    var sval = broker.sval || 0;
    var totalGross = bval + sval;

    var buyPct = 50;
    var sellPct = 50;
    if (totalGross > 0) {
      buyPct = Math.round((bval / totalGross) * 100);
      sellPct = 100 - buyPct;
    } else if (isNetBuyer) {
      buyPct = 100;
      sellPct = 0;
    } else {
      buyPct = 0;
      sellPct = 100;
    }

    var tagColor = isNetBuyer
      ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
      : 'bg-rose-500/20 text-rose-300 border-rose-500/40';

    var html = '';
    html += '<div id="brokerBubbleDetailCard" class="bg-dark-800/90 border border-dark-600/50 rounded-2xl p-4 sm:p-5 shadow-xl ac-fade-in">';

    // Header with broker code, full name, and net status
    html += '  <div class="flex flex-wrap items-center justify-between gap-3 pb-3 mb-3.5 border-b border-dark-600/40">';
    html += '    <div class="flex items-center gap-3">';
    html += '      <span class="px-3 py-1.5 rounded-xl font-black font-mono text-base border ' + tagColor + '">' + escapeHtml(broker.broker) + '</span>';
    html += '      <div>';
    html += '        <div class="text-sm sm:text-base font-bold text-gray-100 flex items-center gap-2">';
    html += '          <span>' + escapeHtml(broker.fullName) + '</span>';
    html += '        </div>';
    html += '        <div class="text-[11px] text-gray-400 font-mono mt-0.5">';
    html += '          Kode Broker: <span class="text-gray-200 font-bold">' + escapeHtml(broker.broker) + '</span>';
    html += '          • Status: <span class="font-bold ' + (isNetBuyer ? 'text-emerald-400' : 'text-rose-400') + '">' + (isNetBuyer ? 'NET BUYER (+ ' + formatIDR(broker.netVal) + ')' : 'NET SELLER (- ' + formatIDR(Math.abs(broker.netVal)) + ')') + '</span>';
    html += '        </div>';
    html += '      </div>';
    html += '    </div>';
    html += '    <div class="flex items-center gap-2">';
    var rangeBadgeText = brokerSummaryRange === '30d' ? '30 Hari' : (brokerSummaryRange === '7d' ? '7 Hari' : '1 Hari');
    if (lastBandarData && lastBandarData.broker_summary && lastBandarData.broker_summary.range_label) {
      rangeBadgeText = lastBandarData.broker_summary.range_label;
    }
    html += '      <span class="text-[10px] uppercase font-bold tracking-wider px-2 py-1 rounded-md bg-dark-700 border border-dark-600/60 text-gray-300 font-mono">📅 ' + escapeHtml(rangeBadgeText) + '</span>';
    html += '      <span class="text-[10px] uppercase font-bold tracking-wider px-2.5 py-1 rounded-md ' + tagColor + '">';
    html += '        ' + (isNetBuyer ? '🟢 Akumulasi' : '🔴 Distribusi');
    html += '      </span>';
    html += '    </div>';
    html += '  </div>';

    // Mini Visual Buy vs Sell Bar
    html += '  <div class="mb-4 bg-dark-700/50 border border-dark-600/30 rounded-xl p-3">';
    html += '    <div class="flex items-center justify-between text-xs font-mono mb-1.5">';
    html += '      <div class="flex items-center gap-1.5 text-emerald-400 font-bold">';
    html += '        <span>🟢 Beli:</span>';
    html += '        <span>' + formatIDR(bval) + '</span>';
    html += '        <span class="text-[10px] text-gray-400 font-normal">(' + buyPct + '%)</span>';
    html += '      </div>';
    html += '      <div class="flex items-center gap-1.5 text-rose-400 font-bold">';
    html += '        <span class="text-[10px] text-gray-400 font-normal">(' + sellPct + '%)</span>';
    html += '        <span>' + formatIDR(sval) + '</span>';
    html += '        <span>: Jual 🔴</span>';
    html += '      </div>';
    html += '    </div>';
    html += '    <div class="w-full h-3 rounded-full bg-dark-900/80 overflow-hidden flex p-0.5 border border-dark-600/40">';
    html += '      <div class="h-full rounded-l-full bg-emerald-500 transition-all duration-300" style="width:' + buyPct + '%"></div>';
    html += '      <div class="h-full rounded-r-full bg-rose-500 transition-all duration-300" style="width:' + sellPct + '%"></div>';
    html += '    </div>';
    var totalClusterVal = lastBrokerItems.reduce(function (sum, it) { return sum + (it.txVal || 0); }, 0);
    var contribPct = totalClusterVal > 0 ? ((broker.txVal / totalClusterVal) * 100).toFixed(1) : '—';

    html += '    <div class="flex flex-wrap items-center justify-between text-[10px] text-gray-400 font-mono mt-2 pt-1 border-t border-dark-600/20">';
    html += '      <span>Total Transaksi Gross: <strong class="text-gray-200">' + formatIDR(totalGross) + '</strong></span>';
    html += '      <span>Net Flow: <strong class="' + (broker.netVal >= 0 ? 'text-emerald-400' : 'text-rose-400') + '">' + (broker.netVal >= 0 ? '+' : '-') + formatIDR(Math.abs(broker.netVal)) + '</strong></span>';
    html += '      <span>Kontribusi: <strong class="text-emerald-300 font-bold">' + contribPct + '%</strong></span>';
    html += '    </div>';
    html += '  </div>';

    // 6-Stat Grid
    html += '  <div class="grid grid-cols-2 sm:grid-cols-3 gap-2.5 text-xs font-mono">';
    html += '    <div class="p-2.5 rounded-xl bg-dark-700/40 border border-dark-600/30">';
    html += '      <div class="text-[10px] text-gray-400 uppercase tracking-wider mb-1">Volume Beli</div>';
    html += '      <div class="text-emerald-400 font-bold text-xs sm:text-sm">' + formatNumber(broker.bvol) + ' <span class="text-[10px] font-normal text-gray-400">lot</span></div>';
    html += '    </div>';
    html += '    <div class="p-2.5 rounded-xl bg-dark-700/40 border border-dark-600/30">';
    html += '      <div class="text-[10px] text-gray-400 uppercase tracking-wider mb-1">Volume Jual</div>';
    html += '      <div class="text-rose-400 font-bold text-xs sm:text-sm">' + formatNumber(broker.svol) + ' <span class="text-[10px] font-normal text-gray-400">lot</span></div>';
    html += '    </div>';
    html += '    <div class="p-2.5 rounded-xl bg-dark-700/40 border border-dark-600/30">';
    html += '      <div class="text-[10px] text-gray-400 uppercase tracking-wider mb-1">Net Volume</div>';
    html += '      <div class="' + (broker.nvol >= 0 ? 'text-emerald-300' : 'text-rose-300') + ' font-bold text-xs sm:text-sm">' + (broker.nvol >= 0 ? '+' : '') + formatNumber(broker.nvol) + ' <span class="text-[10px] font-normal text-gray-400">lot</span></div>';
    html += '    </div>';
    html += '    <div class="p-2.5 rounded-xl bg-dark-700/40 border border-dark-600/30">';
    html += '      <div class="text-[10px] text-gray-400 uppercase tracking-wider mb-1">Frekuensi Order</div>';
    html += '      <div class="text-gray-200 font-bold text-xs sm:text-sm">' + formatNumber(broker.bfrq) + ' <span class="text-[10px] font-normal text-gray-400">B</span> / ' + formatNumber(broker.sfrq) + ' <span class="text-[10px] font-normal text-gray-400">S</span></div>';
    html += '    </div>';
    html += '    <div class="p-2.5 rounded-xl bg-dark-700/40 border border-dark-600/30">';
    html += '      <div class="text-[10px] text-gray-400 uppercase tracking-wider mb-1">Avg Harga Beli</div>';
    html += '      <div class="text-gray-200 font-bold text-xs sm:text-sm">' + (broker.avgBuy ? '@ Rp ' + formatNumber(broker.avgBuy) : '—') + '</div>';
    html += '    </div>';
    html += '    <div class="p-2.5 rounded-xl bg-dark-700/40 border border-dark-600/30">';
    html += '      <div class="text-[10px] text-gray-400 uppercase tracking-wider mb-1">Avg Harga Jual</div>';
    html += '      <div class="text-gray-200 font-bold text-xs sm:text-sm">' + (broker.avgSell ? '@ Rp ' + formatNumber(broker.avgSell) : '—') + '</div>';
    html += '    </div>';
    html += '  </div>';

    html += '</div>';
    return html;
  }

  function getBubbleColorStyles(isNetBuyer, tier) {
    if (isNetBuyer) {
      if (tier === 3) {
        return {
          bg: 'radial-gradient(circle at 35% 35%, rgba(16, 185, 129, 0.42), rgba(6, 78, 59, 0.88))',
          border: '#10b981',
          text: '#ecfdf5',
          subText: '#a7f3d0',
          shadow: '0 6px 18px rgba(16, 185, 129, 0.4), inset 0 0 10px rgba(16, 185, 129, 0.25)'
        };
      } else if (tier === 2) {
        return {
          bg: 'radial-gradient(circle at 35% 35%, rgba(16, 185, 129, 0.28), rgba(6, 78, 59, 0.65))',
          border: 'rgba(16, 185, 129, 0.7)',
          text: '#a7f3d0',
          subText: '#6ee7b7',
          shadow: '0 4px 12px rgba(16, 185, 129, 0.25)'
        };
      } else {
        return {
          bg: 'radial-gradient(circle at 35% 35%, rgba(16, 185, 129, 0.16), rgba(6, 78, 59, 0.42))',
          border: 'rgba(16, 185, 129, 0.45)',
          text: '#6ee7b7',
          subText: '#a7f3d0',
          shadow: '0 2px 8px rgba(16, 185, 129, 0.15)'
        };
      }
    } else {
      if (tier === 3) {
        return {
          bg: 'radial-gradient(circle at 35% 35%, rgba(244, 63, 94, 0.42), rgba(136, 19, 55, 0.88))',
          border: '#f43f5e',
          text: '#fff1f2',
          subText: '#fecdd3',
          shadow: '0 6px 18px rgba(244, 63, 94, 0.4), inset 0 0 10px rgba(244, 63, 94, 0.25)'
        };
      } else if (tier === 2) {
        return {
          bg: 'radial-gradient(circle at 35% 35%, rgba(249, 115, 22, 0.32), rgba(154, 52, 18, 0.68))',
          border: 'rgba(249, 115, 22, 0.75)',
          text: '#fed7aa',
          subText: '#fdba74',
          shadow: '0 4px 12px rgba(249, 115, 22, 0.25)'
        };
      } else {
        return {
          bg: 'radial-gradient(circle at 35% 35%, rgba(245, 158, 11, 0.18), rgba(146, 64, 14, 0.42))',
          border: 'rgba(245, 158, 11, 0.45)',
          text: '#fde68a',
          subText: '#fef08a',
          shadow: '0 2px 8px rgba(245, 158, 11, 0.15)'
        };
      }
    }
  }

  function renderBrokerBubbleClusterHtml(brokers, activeCode, mode, filterSide) {
    var isGross = mode === 'gross';
    var visibleBrokers = brokers.filter(function (b) {
      if (filterSide === 'buy') return isGross ? (b.bval > 0) : b.isNetBuyer;
      if (filterSide === 'sell') return isGross ? (b.sval > 0) : !b.isNetBuyer;
      return true;
    });

    var buyerCount = isGross
      ? brokers.filter(function (b) { return b.bval > 0; }).length
      : brokers.filter(function (b) { return b.isNetBuyer; }).length;
    var sellerCount = isGross
      ? brokers.filter(function (b) { return b.sval > 0; }).length
      : brokers.filter(function (b) { return !b.isNetBuyer; }).length;

    var html = '';
    html += '<div class="space-y-3">';

    // Subheader controls: Helper tip and Filter side pills
    html += '  <div class="flex flex-wrap items-center justify-between gap-2 px-1 text-xs">';
    html += '    <div class="flex items-center gap-1.5 text-gray-400 text-[11px]">';
    html += '      <span>💡</span>';
    html += '      <span>Tap bubble broker untuk rincian &amp; statistik transaksi.</span>';
    html += '    </div>';
    html += '    <div class="flex items-center gap-1 bg-dark-800 p-0.5 rounded-lg border border-dark-600/40 text-[11px] font-mono">';
    html += '      <button type="button" onclick="BandarmologiRuntime.setBubbleFilterSide(\'all\')" class="px-2 py-0.5 rounded transition ' + (filterSide === 'all' ? 'bg-dark-600 text-white font-bold' : 'text-gray-400 hover:text-white') + '">Semua (' + brokers.length + ')</button>';
    html += '      <button type="button" onclick="BandarmologiRuntime.setBubbleFilterSide(\'buy\')" class="px-2 py-0.5 rounded transition ' + (filterSide === 'buy' ? 'bg-emerald-500/20 text-emerald-300 font-bold border border-emerald-500/30' : 'text-gray-400 hover:text-emerald-300') + '">🟢 Buyers (' + buyerCount + ')</button>';
    html += '      <button type="button" onclick="BandarmologiRuntime.setBubbleFilterSide(\'sell\')" class="px-2 py-0.5 rounded transition ' + (filterSide === 'sell' ? 'bg-rose-500/20 text-rose-300 font-bold border border-rose-500/30' : 'text-gray-400 hover:text-rose-300') + '">🔴 Sellers (' + sellerCount + ')</button>';
    html += '    </div>';
    html += '  </div>';

    // Bubble cluster container
    html += '  <div id="brokerBubbleClusterContainer" class="p-4 sm:p-6 bg-dark-900/60 rounded-2xl border border-dark-600/40 min-h-[240px] flex flex-wrap items-center justify-center gap-3 sm:gap-4 relative overflow-hidden">';
    if (visibleBrokers.length === 0) {
      html += '    <div class="text-gray-500 text-xs py-8">Tidak ada broker pada filter ini.</div>';
    } else {
      for (var i = 0; i < visibleBrokers.length; i++) {
        var b = visibleBrokers[i];
        var isSelected = b.broker === activeCode;
        var styleInfo = getBubbleColorStyles(b.isNetBuyer, b.colorTier);
        var valText = isGross ? formatIDR(b.txVal) : ((b.netVal >= 0 ? '+' : '-') + formatIDR(Math.abs(b.netVal)));
        var subBadge = b.size >= 82 ? (b.isNetBuyer ? 'BUY' : 'SELL') : '';

        var animString = isSelected
          ? 'none'
          : 'acBubbleFloat' + b.floatId + ' ' + b.floatDuration + 's ease-in-out infinite alternate, acBubblePopIn 0.45s cubic-bezier(0.34, 1.56, 0.64, 1) ' + b.staggerDelay + 's backwards';

        html += '    <button type="button"';
        html += '      id="broker-bubble-' + escapeHtml(b.broker) + '"';
        html += '      class="ac-broker-bubble ' + (isSelected ? 'ac-bubble-selected' : '') + '"';
        html += '      data-broker="' + escapeHtml(b.broker) + '"';
        html += '      onclick="BandarmologiRuntime.selectBrokerBubble(\'' + escapeHtml(b.broker) + '\')"';
        html += '      title="' + escapeHtml(b.broker + ' - ' + b.fullName) + '"';
        html += '      style="width:' + b.size + 'px; height:' + b.size + 'px; background:' + styleInfo.bg + '; border-color:' + styleInfo.border + '; color:' + styleInfo.text + '; box-shadow:' + styleInfo.shadow + '; animation:' + animString + ';">';
        html += '      <span class="font-mono font-black text-xs sm:text-sm tracking-wider leading-none">' + escapeHtml(b.broker) + '</span>';
        html += '      <span class="text-[9px] sm:text-[10px] font-mono font-bold leading-tight mt-1" style="color:' + styleInfo.subText + '">' + escapeHtml(valText) + '</span>';
        if (subBadge) {
          html += '      <span class="text-[8px] font-mono tracking-widest opacity-75 mt-0.5 uppercase">' + subBadge + '</span>';
        }
        html += '    </button>';
      }
    }
    html += '  </div>';

    // Detail card placeholder
    var activeBroker = brokers.find(function (b) { return b.broker === activeCode; }) || brokers[0] || null;
    html += '  <div id="brokerDetailCardSlot">';
    html += renderBrokerDetailCardHtml(activeBroker, mode);
    html += '  </div>';

    html += '</div>';
    return html;
  }

  function setBrokerSummaryMode(mode) {
    brokerSummaryMode = (mode === 'net') ? 'net' : 'gross';
    var container = byId('bandarmologiContent');
    if (container && lastBandarData) {
      renderBandarmologiUI(container, lastBandarData);
    }
  }

  function setBrokerSummaryView(view) {
    brokerSummaryView = (view === 'table') ? 'table' : 'bubble';
    var container = byId('bandarmologiContent');
    if (container && lastBandarData) {
      renderBandarmologiUI(container, lastBandarData);
    }
  }

  function setBrokerAccumulationView(view) {
    brokerAccumulationView = (view === 'table') ? 'table' : 'bubble';
    var container = byId('bandarmologiContent');
    if (container && lastBandarData) {
      renderBandarmologiUI(container, lastBandarData);
    }
  }

  function setBubbleFilterSide(side) {
    bubbleFilterSide = side || 'all';
    var container = byId('bandarmologiContent');
    if (container && lastBandarData) {
      renderBandarmologiUI(container, lastBandarData);
    }
  }

  function selectBrokerBubble(brokerCode) {
    selectedBrokerCode = String(brokerCode || '').trim().toUpperCase();

    // Fast inline DOM update to preserve bubble float animations
    var bubbles = document.querySelectorAll('.ac-broker-bubble');
    for (var i = 0; i < bubbles.length; i++) {
      var el = bubbles[i];
      var code = el.getAttribute('data-broker');
      if (code === selectedBrokerCode) {
        el.classList.add('ac-bubble-selected');
        el.style.animation = 'none';
      } else {
        el.classList.remove('ac-bubble-selected');
        // Restore float animation
        var match = lastBrokerItems.find(function (it) { return it.broker === code; });
        if (match) {
          el.style.animation = 'acBubbleFloat' + match.floatId + ' ' + match.floatDuration + 's ease-in-out infinite alternate';
        }
      }
    }

    var cardSlot = byId('brokerDetailCardSlot');
    if (cardSlot) {
      var broker = lastBrokerItems.find(function (b) { return b.broker === selectedBrokerCode; }) || null;
      cardSlot.innerHTML = renderBrokerDetailCardHtml(broker, brokerSummaryMode);
    } else {
      var container = byId('bandarmologiContent');
      if (container && lastBandarData) {
        renderBandarmologiUI(container, lastBandarData);
      }
    }
  }

  function setBandarSection(section) {
    bandarSection = (section === 'akumulasi' || section === 'hunter') ? section : 'summary';
    var tabBandar = byId('tabBandarmologi');
    var tabAkumulasi = byId('tabAkumulasiBroker');
    var tabHunter = byId('tabBrokerHunter');
    if (tabBandar && tabAkumulasi) {
      tabBandar.classList.toggle('active', bandarSection === 'summary');
      tabBandar.setAttribute('aria-selected', bandarSection === 'summary' ? 'true' : 'false');
      tabAkumulasi.classList.toggle('active', bandarSection === 'akumulasi');
      tabAkumulasi.setAttribute('aria-selected', bandarSection === 'akumulasi' ? 'true' : 'false');
      if (tabHunter) {
        tabHunter.classList.toggle('active', bandarSection === 'hunter');
        tabHunter.setAttribute('aria-selected', bandarSection === 'hunter' ? 'true' : 'false');
      }
    }
    var subSum = byId('subTabBrokerSummary');
    var subAcc = byId('subTabAkumulasiBroker');
    if (subSum && subAcc) {
      subSum.className = 'px-3.5 py-1.5 rounded-lg transition flex items-center gap-1.5 ' + (bandarSection === 'summary' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium');
      subSum.setAttribute('aria-selected', bandarSection === 'summary' ? 'true' : 'false');
      subAcc.className = 'px-3.5 py-1.5 rounded-lg transition flex items-center gap-1.5 ' + (bandarSection === 'akumulasi' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium');
      subAcc.setAttribute('aria-selected', bandarSection === 'akumulasi' ? 'true' : 'false');
    }
    var titleEl = byId('bandarPanelTitle');
    if (titleEl) {
      if (bandarSection === 'hunter') {
        titleEl.textContent = 'Broker Hunter — Top 10 Saham per Broker';
      } else if (bandarSection === 'akumulasi') {
        titleEl.textContent = 'Akumulasi Broker & Deteksi Smart Money';
      } else {
        titleEl.textContent = 'Analisis Bandarmologi & Kepemilikan Insider';
      }
    }
    try {
      if (typeof window !== 'undefined' && window.location) {
        var currentUrl = new URL(window.location.href);
        currentUrl.searchParams.set('tab', bandarSection);
        window.history.replaceState({}, '', currentUrl.pathname + currentUrl.search + currentUrl.hash);
      }
    } catch (_) {}
    var hunterContainer = byId('brokerHunterContent') || byId('bandarmologiContent');
    var bandarContainer = byId('bandarmologiContent');
    if (bandarSection === 'hunter' && hunterContainer) {
      renderBrokerHunterUI(hunterContainer);
    } else if (bandarContainer && lastBandarData) {
      renderBandarmologiUI(bandarContainer, lastBandarData);
    }
  }

  function setBrokerFlowFilter(flow) {
    brokerFlowFilter = (flow === 'F' || flow === 'D') ? flow : 'all';
    var container = byId('bandarmologiContent');
    if (container && lastBandarData) {
      renderBandarmologiUI(container, lastBandarData);
    } else {
      loadBandarmologiTab(currentBandarTicker, brokerSummaryRange === '1d' ? currentBandarDate : null, brokerSummaryRange);
    }
  }

  function setBrokerSummaryRange(range) {
    brokerSummaryRange = range || '1d';
    if (brokerSummaryRange !== '1d') {
      currentBandarDate = null;
    }
    if (brokerSummaryRange === 'custom') {
      // Just switch the UI to show the date pickers; wait for explicit "Terapkan".
      var container = byId('bandarmologiContent');
      if (container && lastBandarData) renderBandarmologiUI(container, lastBandarData);
      return;
    }
    loadBandarmologiTab(currentBandarTicker, null, brokerSummaryRange);
  }

  function applyCustomBrokerSummaryRange(startDate, endDate) {
    if (!startDate || !endDate) return;
    customRangeStart = startDate;
    customRangeEnd = endDate;
    brokerSummaryRange = 'custom';
    currentBandarDate = null;
    loadBandarmologiTab(currentBandarTicker, null, 'custom');
  }

  async function loadBandarmologiTab(ticker, date, range) {
    var clean = String(ticker || currentBandarTicker || 'BBCA').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!clean) clean = 'BBCA';
    currentBandarTicker = clean;
    if (date !== undefined) currentBandarDate = date;
    if (range) {
      brokerSummaryRange = range;
      if (range !== '1d') currentBandarDate = null;
    }

    var container = byId('bandarmologiContent');
    if (!container) return;

    var badgeTicker = byId('bandarActiveTickerTag');
    if (badgeTicker) badgeTicker.textContent = clean;

    var inpBandar = byId('bandarTickerSearchInput');
    if (inpBandar && inpBandar.value !== clean) inpBandar.value = clean;
    var inpAkumulasi = byId('akumulasiTickerSearchInput');
    if (inpAkumulasi && inpAkumulasi.value !== clean) inpAkumulasi.value = clean;
    var inpSummary = byId('bandarSummarySearchInput');
    if (inpSummary && inpSummary.value !== clean) inpSummary.value = clean;

    container.innerHTML = '<div class="flex flex-col items-center justify-center py-12"><div class="spinner"></div><p class="text-xs text-gray-400 mt-3">Mengambil data Bandarmologi &amp; Insider ' + escapeHtml(clean) + '...</p></div>';

    try {
      var url = '/api/sector-hot?action=bandarmologi&ticker=' + encodeURIComponent(clean);
      if (brokerFlowFilter === 'F' || brokerFlowFilter === 'D') {
        url += '&flow=' + encodeURIComponent(brokerFlowFilter);
      }
      if (brokerSummaryRange === 'custom' && customRangeStart && customRangeEnd) {
        url += '&range=custom&startDate=' + encodeURIComponent(customRangeStart) + '&endDate=' + encodeURIComponent(customRangeEnd);
      } else if (brokerSummaryRange && brokerSummaryRange !== '1d') {
        url += '&range=' + encodeURIComponent(brokerSummaryRange);
        var numDays = brokerSummaryRange === '30d' ? 30 : (brokerSummaryRange === '7d' ? 7 : 1);
        url += '&days=' + numDays;
      } else if (currentBandarDate) {
        url += '&date=' + encodeURIComponent(currentBandarDate);
      }
      var res = await fetch(url);
      var data = await res.json();

      if (!data || !data.success) {
        container.innerHTML = '<div class="p-6 text-center text-rose-400 text-xs">Gagal memuat data bandarmologi: ' + escapeHtml((data && data.error) || 'Terjadi kesalahan.') + '</div>';
        return;
      }

      renderBandarmologiUI(container, data);
    } catch (err) {
      container.innerHTML = '<div class="p-6 text-center text-rose-400 text-xs">Error memuat data bandarmologi: ' + escapeHtml(err.message || String(err)) + '</div>';
    }
  }

  function renderBandarmologiUI(container, data) {
    lastBandarData = data;
    injectBubbleStyles();

    var ticker = data.ticker || currentBandarTicker;
    var bSum = data.broker_summary || {};
    var bAcc = data.broker_accumulation || {};
    var insiders = Array.isArray(data.insiders) ? data.insiders : [];

    var DEMO_REASON_LABEL = {
      no_api_key: 'Data Demo — API key belum dikonfigurasi',
      no_disk_cache: 'Data Demo — belum ada data tersimpan untuk ticker ini',
      quota_exceeded: 'Data Demo — kuota API harian habis',
      api_error: 'Data Demo — API sedang tidak tersedia',
      network_error: 'Data Demo — koneksi ke API gagal'
    };
    var isDemoBadge = data.is_demo
      ? '<span class="text-[10px] px-2 py-0.5 rounded bg-amber-500/10 border border-amber-500/30 text-amber-300 font-mono" title="' + escapeHtml(data.demo_detail || '') + '">' + escapeHtml(DEMO_REASON_LABEL[data.demo_reason] || 'DEMO PREVIEW — data bukan dari sumber live') + '</span>'
      : '<span class="text-[10px] px-2 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 font-mono">LIVE / BACKFILL</span>';

    var netStatusTone = 'text-emerald-400';
    var netStatusBg = 'bg-emerald-500/10 border-emerald-500/30';
    var netLabel = bSum.net_label || bSum.net_status || 'AKUMULASI';
    if (String(netLabel).toUpperCase().includes('DIST')) {
      netStatusTone = 'text-rose-400';
      netStatusBg = 'bg-rose-500/10 border-rose-500/30';
    }

    var html = '';

    // Header info bar
    html += '<div class="flex flex-wrap items-center justify-between gap-3 p-3.5 bg-dark-700/60 border border-dark-600/40 rounded-2xl mb-4">';
    html += '  <div class="flex items-center gap-2">';
    html += '    <span class="text-sm font-bold text-gray-100 font-mono">' + escapeHtml(ticker) + '</span>';
    html += '    <span class="text-xs px-2.5 py-0.5 rounded-full border font-semibold ' + netStatusTone + ' ' + netStatusBg + '">' + escapeHtml(netLabel) + '</span>';
    html += '    ' + isDemoBadge;
    html += '  </div>';
    html += '  <div class="flex items-center gap-3 text-xs font-mono">';
    html += '    <span class="text-gray-400">Net Flow: <strong class="' + (bSum.net_flow >= 0 ? 'text-emerald-400' : 'text-rose-400') + '">' + (bSum.net_flow >= 0 ? '+' : '') + formatIDR(bSum.net_flow) + '</strong></span>';
    html += '    <span class="text-gray-400">Tanggal: <strong class="text-gray-200">' + escapeHtml(bSum.date || currentBandarDate || 'Terbaru') + '</strong></span>';
    html += '  </div>';
    html += '</div>';

    var series = bAcc.series || [];
    var availableDates = Array.isArray(data.available_dates) && data.available_dates.length > 0
      ? data.available_dates
      : series.map(function (s) { return s.date; }).filter(Boolean).reverse();

    // Quick date pills in header if available
    var quickDates = availableDates.slice(0, 5);
    if (quickDates.length > 0) {
      html += '<div class="flex flex-wrap items-center gap-1.5 mb-3">';
      html += '  <span class="text-[11px] text-gray-400 mr-1">Pilih Cepat Tanggal:</span>';
      for (var qd = 0; qd < quickDates.length; qd++) {
        var dt = quickDates[qd];
        var isCurrent = dt === (bSum.date || currentBandarDate);
        var pillStyle = isCurrent
          ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40 font-bold'
          : 'bg-dark-700 text-gray-300 border-dark-600/60 hover:bg-dark-600 hover:text-white';
        html += '  <button type="button" onclick="BandarmologiRuntime.loadBandarmologiTab(null, \'' + escapeHtml(dt) + '\')" class="px-2 py-0.5 text-[11px] rounded-md border font-mono transition ' + pillStyle + '">' + escapeHtml(dt) + '</button>';
      }
      html += '</div>';
    }

    // SECTION TABS: Only render inline switcher if external subTabBrokerSummary is absent
    var isSummarySection = bandarSection === 'summary';
    if (!byId('subTabBrokerSummary')) {
      html += '<div class="flex items-center gap-1 bg-dark-800 p-0.5 rounded-lg border border-dark-600/50 text-xs mb-4 w-fit">';
      html += '  <button type="button" onclick="BandarmologiRuntime.setBandarSection(\'summary\')" class="px-3 py-1.5 rounded-md transition ' + (bandarSection === 'summary' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium') + '">📊 Broker Summary</button>';
      html += '  <button type="button" onclick="BandarmologiRuntime.setBandarSection(\'akumulasi\')" class="px-3 py-1.5 rounded-md transition ' + (bandarSection === 'akumulasi' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium') + '">📈 Akumulasi Broker</button>';
      html += '</div>';
    }

    if (isSummarySection) {
    // 1. BROKER SUMMARY (BANDARMOLOGI) SECTION - INTERACTIVE BUBBLE OR DETAILED TABLE
    var isGross = brokerSummaryMode === 'gross';
    var isBubbleView = brokerSummaryView === 'bubble';

    html += '<div class="mb-5">';
    html += '  <div class="flex flex-wrap items-center justify-between gap-2.5 mb-3">';
    var summaryHeadingDate = bSum.range_label || (bSum.date ? 'Tanggal: ' + bSum.date : (currentBandarDate ? 'Tanggal: ' + currentBandarDate : 'Terbaru'));
    html += '    <h3 class="text-xs font-bold text-gray-200 flex items-center gap-1.5"><span class="text-sm">📊</span> Broker Summary Detail — <span class="text-emerald-400 font-mono">' + escapeHtml(summaryHeadingDate) + '</span></h3>';

    html += '    <div class="flex flex-wrap items-center gap-2">';
    // Rentang Selector (1 Hari, 7 Hari, 30 Hari)
    var r1Class = brokerSummaryRange === '1d' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium';
    var r7Class = brokerSummaryRange === '7d' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium';
    var r30Class = brokerSummaryRange === '30d' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium';
    var rCustomClass = brokerSummaryRange === 'custom' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium';
    html += '      <div class="flex items-center gap-1 bg-dark-800 p-0.5 rounded-lg border border-dark-600/50 text-[11px]">';
    html += '        <span class="text-[10px] text-gray-400 font-medium px-1.5 uppercase tracking-wider">Rentang:</span>';
    html += '        <button type="button" id="toggleRange1d" onclick="BandarmologiRuntime.setBrokerSummaryRange(\'1d\')" class="px-2.5 py-1 rounded-md transition ' + r1Class + '">1 Hari</button>';
    html += '        <button type="button" id="toggleRange7d" onclick="BandarmologiRuntime.setBrokerSummaryRange(\'7d\')" class="px-2.5 py-1 rounded-md transition ' + r7Class + '">7 Hari</button>';
    html += '        <button type="button" id="toggleRange30d" onclick="BandarmologiRuntime.setBrokerSummaryRange(\'30d\')" class="px-2.5 py-1 rounded-md transition ' + r30Class + '">30 Hari</button>';
    html += '        <button type="button" id="toggleRangeCustom" onclick="BandarmologiRuntime.setBrokerSummaryRange(\'custom\')" class="px-2.5 py-1 rounded-md transition ' + rCustomClass + '">📅 Custom</button>';
    html += '      </div>';

    if (brokerSummaryRange === 'custom') {
      html += '      <div class="flex items-center gap-1.5 bg-dark-800 p-1 rounded-lg border border-dark-600/50 text-[11px]">';
      html += '        <input type="date" id="bandarCustomStartDate" value="' + escapeHtml(customRangeStart) + '" class="bg-dark-700 border border-dark-600/60 rounded px-1.5 py-0.5 text-gray-200 text-[11px]">';
      html += '        <span class="text-gray-500">s/d</span>';
      html += '        <input type="date" id="bandarCustomEndDate" value="' + escapeHtml(customRangeEnd) + '" class="bg-dark-700 border border-dark-600/60 rounded px-1.5 py-0.5 text-gray-200 text-[11px]">';
      html += '        <button type="button" onclick="BandarmologiRuntime.applyCustomBrokerSummaryRange(document.getElementById(\'bandarCustomStartDate\').value, document.getElementById(\'bandarCustomEndDate\').value)" class="px-2.5 py-1 rounded-md bg-emerald-500 text-dark-900 font-bold transition hover:bg-emerald-400">Terapkan</button>';
      html += '      </div>';
    }

    // View Switcher (Bubble View vs Tabel Rinci)
    html += '      <div class="flex items-center gap-1 bg-dark-800 p-0.5 rounded-lg border border-dark-600/50 text-[11px]">';
    html += '        <span class="text-[10px] text-gray-400 font-medium px-1.5 uppercase tracking-wider">Tampilan:</span>';
    html += '        <button type="button" id="toggleViewBubble" onclick="BandarmologiRuntime.setBrokerSummaryView(\'bubble\')" class="px-2.5 py-1 rounded-md transition ' + (isBubbleView ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium') + '">⚪ Visual Bubble</button>';
    html += '        <button type="button" id="toggleViewTable" onclick="BandarmologiRuntime.setBrokerSummaryView(\'table\')" class="px-2.5 py-1 rounded-md transition ' + (!isBubbleView ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium') + '">📋 Tabel Rinci</button>';
    html += '      </div>';

    // Mode Switcher (Full/Gross vs Net)
    var grossClass = isGross ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium';
    var netClass = !isGross ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium';
    html += '      <div class="flex items-center gap-1 bg-dark-800 p-0.5 rounded-lg border border-dark-600/50 text-[11px]">';
    html += '        <span class="text-[10px] text-gray-400 font-medium px-1.5 uppercase tracking-wider">Mode:</span>';
    html += '        <button type="button" id="toggleModeGross" onclick="BandarmologiRuntime.setBrokerSummaryMode(\'gross\')" class="px-2.5 py-1 rounded-md transition ' + grossClass + '">Full / Gross</button>';
    html += '        <button type="button" id="toggleModeNet" onclick="BandarmologiRuntime.setBrokerSummaryMode(\'net\')" class="px-2.5 py-1 rounded-md transition ' + netClass + '">Net Value</button>';
    html += '      </div>';

    // Flow Filter (Foreign / Domestic / All)
    var flowAllClass = brokerFlowFilter === 'all' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium';
    var flowFClass = brokerFlowFilter === 'F' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium';
    var flowDClass = brokerFlowFilter === 'D' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium';
    html += '      <div class="flex items-center gap-1 bg-dark-800 p-0.5 rounded-lg border border-dark-600/50 text-[11px]">';
    html += '        <span class="text-[10px] text-gray-400 font-medium px-1.5 uppercase tracking-wider">Flow:</span>';
    html += '        <button type="button" id="toggleFlowAll" onclick="BandarmologiRuntime.setBrokerFlowFilter(\'all\')" class="px-2.5 py-1 rounded-md transition ' + flowAllClass + '">Semua</button>';
    html += '        <button type="button" id="toggleFlowForeign" onclick="BandarmologiRuntime.setBrokerFlowFilter(\'F\')" class="px-2.5 py-1 rounded-md transition ' + flowFClass + '">🌏 Foreign</button>';
    html += '        <button type="button" id="toggleFlowDomestic" onclick="BandarmologiRuntime.setBrokerFlowFilter(\'D\')" class="px-2.5 py-1 rounded-md transition ' + flowDClass + '">🏠 Domestic</button>';
    html += '      </div>';
    html += '    </div>';
    html += '  </div>';

    var rawBuyers = isGross
      ? firstNonEmptyList(bSum.gross_buyers, bSum.top_buyers)
      : firstNonEmptyList(bSum.net_buyers, bSum.top_buyers);
    var rawSellers = isGross
      ? firstNonEmptyList(bSum.gross_sellers, bSum.top_sellers)
      : firstNonEmptyList(bSum.net_sellers, bSum.top_sellers);

    var buyers = filterBrokersByFlow(rawBuyers, brokerFlowFilter);
    var sellers = filterBrokersByFlow(rawSellers, brokerFlowFilter);

    lastBrokerItems = buildBrokerBubbleItems(buyers, sellers, brokerSummaryMode);

    if (isBubbleView) {
      // Ensure selectedBrokerCode is valid
      if (!selectedBrokerCode || !lastBrokerItems.some(function (it) { return it.broker === selectedBrokerCode; })) {
        selectedBrokerCode = lastBrokerItems.length > 0 ? lastBrokerItems[0].broker : '';
      }
      html += renderBrokerBubbleClusterHtml(lastBrokerItems, selectedBrokerCode, brokerSummaryMode, bubbleFilterSide);
    } else {
      // TABLE VIEW (PRESERVED)
      html += '  <div class="grid grid-cols-1 md:grid-cols-2 gap-3">';

      // Top Buyers
      html += '    <div class="bg-dark-700/40 border border-dark-600/30 rounded-xl p-3">';
      html += '      <div class="text-[11px] font-bold text-emerald-400 mb-2 flex items-center justify-between pb-1.5 border-b border-dark-600/40">';
      html += '        <span>🟢 TOP BUYERS (' + (isGross ? 'FULL / GROSS' : 'NET VALUE &amp; VOL') + ')</span>';
      html += '        <span class="text-[10px] text-gray-400 font-mono">' + (isGross ? 'BUY &amp; SELL VAL' : 'NET VAL') + '</span>';
      html += '      </div>';
      html += '      <div class="space-y-2 text-xs">';
      if (buyers.length === 0) {
        html += '      <div class="text-gray-500 text-center py-4 text-xs">Tidak ada data buyer</div>';
      } else {
        for (var b = 0; b < buyers.length; b++) {
          var item = buyers[b];
          var buyVal = item.bval != null ? item.bval : (item.buy_val || item.net_val || item.val || item.value || 0);
          var sellVal = item.sval != null ? item.sval : (item.sell_val || 0);
          var buyVol = item.bvol != null ? item.bvol : (item.buy_vol || item.vol || item.volume || 0);
          var sellVol = item.svol != null ? item.svol : (item.sell_vol || 0);
          var netVal = item.nval != null ? item.nval : (item.net_val != null ? item.net_val : (buyVal - sellVal));
          if (netVal < 0 && (buyVal > sellVal || sellVal === 0)) {
            netVal = Math.abs(netVal);
          }
          var netVol = item.nvol != null ? item.nvol : (item.net_vol != null ? item.net_vol : (buyVol - sellVol));
          if (netVol < 0 && (buyVol > sellVol || sellVol === 0)) {
            netVol = Math.abs(netVol);
          }

          html += '      <div class="py-2 px-2.5 rounded-lg bg-dark-800/40 border border-dark-600/30 hover:border-emerald-500/30 transition">';
          html += '        <div class="flex items-center justify-between">';
          html += '          <div class="flex items-center gap-2">';
          html += '            <span class="w-4 text-gray-500 font-mono text-[10px] font-bold">' + (b + 1) + '</span>';
          html += '            <span class="font-bold font-mono text-emerald-300 px-1.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/30 text-xs">' + escapeHtml(item.broker) + '</span>';
          if (item.broker_name) {
            html += '            <span class="text-gray-300 text-[11px] truncate max-w-[120px]" title="' + escapeHtml(item.broker_name) + '">' + escapeHtml(item.broker_name) + '</span>';
          }
          if (item.avg_price) {
            html += '            <span class="text-gray-400 text-[10px]">@ ' + formatNumber(item.avg_price) + '</span>';
          }
          html += '          </div>';
          if (isGross) {
            html += '          <div class="text-right font-mono">';
            html += '            <span class="font-bold text-emerald-400 text-xs">+' + formatIDR(buyVal) + '</span>';
            if (sellVal > 0) {
              html += '            <span class="text-rose-400/80 text-[10px] ml-1.5">-' + formatIDR(sellVal) + '</span>';
            }
            html += '          </div>';
          } else {
            html += '          <div class="text-right font-mono">';
            html += '            <span class="font-bold text-emerald-400 text-xs">+' + formatIDR(netVal) + '</span>';
            html += '          </div>';
          }
          html += '        </div>';

          if (isGross) {
            html += '        <div class="flex flex-wrap items-center justify-between text-[10px] font-mono text-gray-400 mt-1.5 pt-1.5 border-t border-dark-600/20">';
            html += '          <div class="flex items-center gap-2.5">';
            html += '            <span>B.Vol: <strong class="text-gray-200">' + formatNumber(buyVol) + '</strong></span>';
            if (sellVol > 0) {
              html += '            <span>S.Vol: <strong class="text-gray-300">' + formatNumber(sellVol) + '</strong></span>';
            }
            if (item.bfrq || item.sfrq) {
              html += '            <span>Freq: <strong class="text-gray-300">' + formatNumber(item.bfrq || 0) + '/' + formatNumber(item.sfrq || 0) + '</strong></span>';
            }
            html += '          </div>';
            html += '          <div>';
            html += '            <span class="' + (netVal >= 0 ? 'text-emerald-300' : 'text-rose-300') + ' font-semibold">Net: ' + (netVal >= 0 ? '+' : '') + formatIDR(netVal) + '</span>';
            html += '          </div>';
            html += '        </div>';
          } else {
            html += '        <div class="flex items-center justify-between text-[10px] font-mono text-gray-400 mt-1.5 pt-1.5 border-t border-dark-600/20">';
            html += '          <span>Net Vol: <strong class="text-emerald-300 font-semibold">+' + formatNumber(netVol) + '</strong></span>';
            if (item.avg_price) {
              html += '          <span>Avg: <strong class="text-gray-200">' + formatNumber(item.avg_price) + '</strong></span>';
            }
            html += '        </div>';
          }
          html += '      </div>';
        }
      }
      html += '      </div>';
      html += '    </div>';

      // Top Sellers
      html += '    <div class="bg-dark-700/40 border border-dark-600/30 rounded-xl p-3">';
      html += '      <div class="text-[11px] font-bold text-rose-400 mb-2 flex items-center justify-between pb-1.5 border-b border-dark-600/40">';
      html += '        <span>🔴 TOP SELLERS (' + (isGross ? 'FULL / GROSS' : 'NET VALUE &amp; VOL') + ')</span>';
      html += '        <span class="text-[10px] text-gray-400 font-mono">' + (isGross ? 'SELL &amp; BUY VAL' : 'NET VAL') + '</span>';
      html += '      </div>';
      html += '      <div class="space-y-2 text-xs">';
      if (sellers.length === 0) {
        html += '      <div class="text-gray-500 text-center py-4 text-xs">Tidak ada data seller</div>';
      } else {
        for (var s = 0; s < sellers.length; s++) {
          var sItem = sellers[s];
          var sBuyVal = sItem.bval != null ? sItem.bval : (sItem.buy_val || 0);
          var sSellVal = sItem.sval != null ? sItem.sval : (sItem.sell_val || Math.abs(sItem.net_val || sItem.val || sItem.value || 0));
          var sBuyVol = sItem.bvol != null ? sItem.bvol : (sItem.buy_vol || 0);
          var sSellVol = sItem.svol != null ? sItem.svol : (sItem.sell_vol || Math.abs(sItem.net_vol || sItem.vol || sItem.volume || 0));
          var sNetVal = sItem.nval != null ? sItem.nval : (sItem.net_val != null ? sItem.net_val : (sBuyVal - sSellVal));
          if (sNetVal > 0 && (sSellVal > sBuyVal || sBuyVal === 0)) {
            sNetVal = -Math.abs(sNetVal);
          }
          var sNetVol = sItem.nvol != null ? sItem.nvol : (sItem.net_vol != null ? sItem.net_vol : (sBuyVol - sSellVol));
          if (sNetVol > 0 && (sSellVol > sBuyVol || sBuyVol === 0)) {
            sNetVol = -Math.abs(sNetVol);
          }

          html += '      <div class="py-2 px-2.5 rounded-lg bg-dark-800/40 border border-dark-600/30 hover:border-rose-500/30 transition">';
          html += '        <div class="flex items-center justify-between">';
          html += '          <div class="flex items-center gap-2">';
          html += '            <span class="w-4 text-gray-500 font-mono text-[10px] font-bold">' + (s + 1) + '</span>';
          html += '            <span class="font-bold font-mono text-rose-300 px-1.5 py-0.5 rounded bg-rose-500/10 border border-rose-500/30 text-xs">' + escapeHtml(sItem.broker) + '</span>';
          if (sItem.broker_name) {
            html += '            <span class="text-gray-300 text-[11px] truncate max-w-[120px]" title="' + escapeHtml(sItem.broker_name) + '">' + escapeHtml(sItem.broker_name) + '</span>';
          }
          if (sItem.avg_price) {
            html += '            <span class="text-gray-400 text-[10px]">@ ' + formatNumber(sItem.avg_price) + '</span>';
          }
          html += '          </div>';
          if (isGross) {
            html += '          <div class="text-right font-mono">';
            html += '            <span class="font-bold text-rose-400 text-xs">-' + formatIDR(sSellVal) + '</span>';
            if (sBuyVal > 0) {
              html += '            <span class="text-emerald-400/80 text-[10px] ml-1.5">+' + formatIDR(sBuyVal) + '</span>';
            }
            html += '          </div>';
          } else {
            html += '          <div class="text-right font-mono">';
            html += '            <span class="font-bold text-rose-400 text-xs">-' + formatIDR(Math.abs(sNetVal)) + '</span>';
            html += '          </div>';
          }
          html += '        </div>';

          if (isGross) {
            html += '        <div class="flex flex-wrap items-center justify-between text-[10px] font-mono text-gray-400 mt-1.5 pt-1.5 border-t border-dark-600/20">';
            html += '          <div class="flex items-center gap-2.5">';
            html += '            <span>S.Vol: <strong class="text-gray-200">' + formatNumber(sSellVol) + '</strong></span>';
            if (sBuyVol > 0) {
              html += '            <span>B.Vol: <strong class="text-gray-300">' + formatNumber(sBuyVol) + '</strong></span>';
            }
            if (sItem.bfrq || sItem.sfrq) {
              html += '            <span>Freq: <strong class="text-gray-300">' + formatNumber(sItem.sfrq || 0) + '/' + formatNumber(sItem.bfrq || 0) + '</strong></span>';
            }
            html += '          </div>';
            html += '          <div>';
            html += '            <span class="' + (sNetVal >= 0 ? 'text-emerald-300' : 'text-rose-300') + ' font-semibold">Net: ' + (sNetVal >= 0 ? '+' : '') + formatIDR(sNetVal) + '</span>';
            html += '          </div>';
            html += '        </div>';
          } else {
            html += '        <div class="flex items-center justify-between text-[10px] font-mono text-gray-400 mt-1.5 pt-1.5 border-t border-dark-600/20">';
            html += '          <span>Net Vol: <strong class="text-rose-300 font-semibold">-' + formatNumber(Math.abs(sNetVol)) + '</strong></span>';
            if (sItem.avg_price) {
              html += '          <span>Avg: <strong class="text-gray-200">' + formatNumber(sItem.avg_price) + '</strong></span>';
            }
            html += '        </div>';
          }
          html += '      </div>';
        }
      }
      html += '      </div>';
      html += '    </div>';
      html += '  </div>';
    }
    html += '</div>';
    } else {

    // 2. AKUMULASI BROKER SECTION - INTERACTIVE BUBBLE OR DETAILED TABLE & CHART
    var isAccBubbleView = brokerAccumulationView === 'bubble';

    html += '<div class="mb-5">';
    html += '  <div class="flex flex-wrap items-center justify-between gap-2.5 mb-3">';
    var accHeadingDate = bSum.range_label || (bSum.date ? 'Rentang: ' + bSum.date : (currentBandarDate ? 'Tanggal: ' + currentBandarDate : 'Historis'));
    html += '    <h3 class="text-xs font-bold text-gray-200 flex items-center gap-1.5"><span class="text-sm">📈</span> Akumulasi Broker Detail — <span class="text-emerald-400 font-mono">' + escapeHtml(accHeadingDate) + '</span></h3>';

    html += '    <div class="flex flex-wrap items-center gap-2">';
    // Rentang Selector (1 Hari, 7 Hari, 30 Hari, Custom)
    var ar1Class = brokerSummaryRange === '1d' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium';
    var ar7Class = brokerSummaryRange === '7d' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium';
    var ar30Class = brokerSummaryRange === '30d' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium';
    var arCustomClass = brokerSummaryRange === 'custom' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium';
    html += '      <div class="flex items-center gap-1 bg-dark-800 p-0.5 rounded-lg border border-dark-600/50 text-[11px]">';
    html += '        <span class="text-[10px] text-gray-400 font-medium px-1.5 uppercase tracking-wider">Rentang:</span>';
    html += '        <button type="button" id="toggleAccRange1d" onclick="BandarmologiRuntime.setBrokerSummaryRange(\'1d\')" class="px-2.5 py-1 rounded-md transition ' + ar1Class + '">1 Hari</button>';
    html += '        <button type="button" id="toggleAccRange7d" onclick="BandarmologiRuntime.setBrokerSummaryRange(\'7d\')" class="px-2.5 py-1 rounded-md transition ' + ar7Class + '">7 Hari</button>';
    html += '        <button type="button" id="toggleAccRange30d" onclick="BandarmologiRuntime.setBrokerSummaryRange(\'30d\')" class="px-2.5 py-1 rounded-md transition ' + ar30Class + '">30 Hari</button>';
    html += '        <button type="button" id="toggleAccRangeCustom" onclick="BandarmologiRuntime.setBrokerSummaryRange(\'custom\')" class="px-2.5 py-1 rounded-md transition ' + arCustomClass + '">📅 Custom</button>';
    html += '      </div>';

    if (brokerSummaryRange === 'custom') {
      html += '      <div class="flex items-center gap-1.5 bg-dark-800 p-1 rounded-lg border border-dark-600/50 text-[11px]">';
      html += '        <input type="date" id="bandarAccCustomStartDate" value="' + escapeHtml(customRangeStart) + '" class="bg-dark-700 border border-dark-600/60 rounded px-1.5 py-0.5 text-gray-200 text-[11px]">';
      html += '        <span class="text-gray-500">s/d</span>';
      html += '        <input type="date" id="bandarAccCustomEndDate" value="' + escapeHtml(customRangeEnd) + '" class="bg-dark-700 border border-dark-600/60 rounded px-1.5 py-0.5 text-gray-200 text-[11px]">';
      html += '        <button type="button" onclick="BandarmologiRuntime.applyCustomBrokerSummaryRange(document.getElementById(\'bandarAccCustomStartDate\').value, document.getElementById(\'bandarAccCustomEndDate\').value)" class="px-2.5 py-1 rounded-md bg-emerald-500 text-dark-900 font-bold transition hover:bg-emerald-400">Terapkan</button>';
      html += '      </div>';
    }

    // View Switcher (Visual Bubble vs Tabel Rinci)
    html += '      <div class="flex items-center gap-1 bg-dark-800 p-0.5 rounded-lg border border-dark-600/50 text-[11px]">';
    html += '        <span class="text-[10px] text-gray-400 font-medium px-1.5 uppercase tracking-wider">Tampilan:</span>';
    html += '        <button type="button" id="toggleAccViewBubble" onclick="BandarmologiRuntime.setBrokerAccumulationView(\'bubble\')" class="px-2.5 py-1 rounded-md transition ' + (isAccBubbleView ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium') + '">⚪ Visual Bubble</button>';
    html += '        <button type="button" id="toggleAccViewTable" onclick="BandarmologiRuntime.setBrokerAccumulationView(\'table\')" class="px-2.5 py-1 rounded-md transition ' + (!isAccBubbleView ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium') + '">📋 Tabel Rinci</button>';
    html += '      </div>';

    // Flow Filter (Foreign / Domestic / All)
    var flowAllClass = brokerFlowFilter === 'all' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium';
    var flowFClass = brokerFlowFilter === 'F' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium';
    var flowDClass = brokerFlowFilter === 'D' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium';
    html += '      <div class="flex items-center gap-1 bg-dark-800 p-0.5 rounded-lg border border-dark-600/50 text-[11px]">';
    html += '        <span class="text-[10px] text-gray-400 font-medium px-1.5 uppercase tracking-wider">Flow:</span>';
    html += '        <button type="button" id="toggleAccFlowAll" onclick="BandarmologiRuntime.setBrokerFlowFilter(\'all\')" class="px-2.5 py-1 rounded-md transition ' + flowAllClass + '">Semua</button>';
    html += '        <button type="button" id="toggleAccFlowForeign" onclick="BandarmologiRuntime.setBrokerFlowFilter(\'F\')" class="px-2.5 py-1 rounded-md transition ' + flowFClass + '">🌏 Foreign</button>';
    html += '        <button type="button" id="toggleAccFlowDomestic" onclick="BandarmologiRuntime.setBrokerFlowFilter(\'D\')" class="px-2.5 py-1 rounded-md transition ' + flowDClass + '">🏠 Domestic</button>';
    html += '      </div>';

    html += '    </div>';
    html += '  </div>';

    if (isAccBubbleView) {
      // 2A. BUBBLE VIEW UNTUK AKUMULASI BROKER
      var rawAccBuyers = firstNonEmptyList(bAcc.net_buyers, bAcc.top_buyers, bSum.net_buyers, bSum.top_buyers, bSum.gross_buyers);
      var rawAccSellers = firstNonEmptyList(bAcc.net_sellers, bAcc.top_sellers, bSum.net_sellers, bSum.top_sellers, bSum.gross_sellers);

      // Partition guard: if sellers list is empty or buyers contains negative net values
      var allAcc = [].concat(rawAccBuyers || []);
      if (!rawAccSellers || rawAccSellers.length === 0 || allAcc.some(function (b) {
        var v = b.nval != null ? b.nval : (b.net_val != null ? b.net_val : ((b.bval || b.buy_val || 0) - (b.sval || b.sell_val || 0)));
        return v < 0;
      })) {
        var pBuyers = [];
        var pSellers = [].concat(rawAccSellers || []);
        for (var ai = 0; ai < allAcc.length; ai++) {
          var itm = allAcc[ai];
          var nCheck = itm.nval != null ? itm.nval : (itm.net_val != null ? itm.net_val : ((itm.bval || itm.buy_val || 0) - (itm.sval || itm.sell_val || 0)));
          if (nCheck < 0) {
            pSellers.push(itm);
          } else {
            pBuyers.push(itm);
          }
        }
        rawAccBuyers = pBuyers;
        rawAccSellers = pSellers;
      }

      var accBuyers = filterBrokersByFlow(rawAccBuyers, brokerFlowFilter);
      var accSellers = filterBrokersByFlow(rawAccSellers, brokerFlowFilter);

      lastBrokerItems = buildBrokerBubbleItems(accBuyers, accSellers, 'net');

      if (!selectedBrokerCode || !lastBrokerItems.some(function (it) { return it.broker === selectedBrokerCode; })) {
        selectedBrokerCode = lastBrokerItems.length > 0 ? lastBrokerItems[0].broker : '';
      }
      html += renderBrokerBubbleClusterHtml(lastBrokerItems, selectedBrokerCode, 'net', bubbleFilterSide);
    } else {
      // 2B. TABEL RINCI (Riwayat Harian Breakdown & Grafik Tren Akumulasi)
      html += '<div class="mb-5 bg-dark-700/40 border border-dark-600/30 rounded-xl p-3.5">';
      html += '  <div class="flex items-center justify-between mb-3">';
      html += '    <h3 class="text-xs font-bold text-gray-200 flex items-center gap-1.5"><span class="text-sm">📅</span> Riwayat Harian Broker Summary (Breakdown Per Hari)</h3>';
      html += '    <span class="text-[11px] text-gray-400">Setiap tanggal memiliki data tersendiri</span>';
      html += '  </div>';

      if (series.length === 0) {
        html += '  <div class="text-gray-500 text-center py-4 text-xs">Belum ada riwayat harian untuk emiten ini.</div>';
      } else {
        html += '  <div class="overflow-x-auto max-h-72 overflow-y-auto">';
        html += '    <table class="w-full text-left text-xs">';
        html += '      <thead>';
        html += '        <tr class="text-[11px] text-gray-400 border-b border-dark-600/40 sticky top-0 bg-dark-800/90 backdrop-blur z-10">';
        html += '          <th class="py-2 px-2.5">Tanggal</th>';
        html += '          <th class="py-2 px-2 text-center">Status Bandar</th>';
        html += '          <th class="py-2 px-2 text-right">Net Flow (IDR)</th>';
        html += '          <th class="py-2 px-2 text-center">Top Buyer</th>';
        html += '          <th class="py-2 px-2 text-center">Top Seller</th>';
        html += '          <th class="py-2 px-2 text-center">Aksi</th>';
        html += '        </tr>';
        html += '      </thead>';
        html += '      <tbody class="divide-y divide-dark-600/20">';

        var revSeries = series.slice().reverse();
        for (var di = 0; di < revSeries.length; di++) {
          var dayRow = revSeries[di];
          var isSelected = dayRow.date === (bSum.date || currentBandarDate);
          var isPositive = (dayRow.net_val || 0) >= 0;
          var statusBadge = isPositive
            ? '<span class="px-2 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 font-semibold text-[10px]">AKUMULASI</span>'
            : '<span class="px-2 py-0.5 rounded bg-rose-500/10 border border-rose-500/30 text-rose-300 font-semibold text-[10px]">DISTRIBUSI</span>';

          var rowBg = isSelected
            ? 'bg-emerald-500/10 border-l-2 border-emerald-500 font-medium'
            : 'hover:bg-dark-600/20 transition';

          html += '        <tr class="' + rowBg + '">';
          html += '          <td class="py-2 px-2.5 font-mono text-[11px] text-gray-200">';
          html += '            ' + escapeHtml(dayRow.date);
          if (isSelected) {
            html += '          <span class="ml-1.5 text-[9px] px-1.5 py-0.2 rounded bg-emerald-500 text-dark-900 font-bold">DILIHAT</span>';
          }
          html += '          </td>';
          html += '          <td class="py-2 px-2 text-center">' + statusBadge + '</td>';
          html += '          <td class="py-2 px-2 font-mono text-right font-semibold ' + (isPositive ? 'text-emerald-400' : 'text-rose-400') + '">' + (isPositive ? '+' : '-') + formatIDR(Math.abs(dayRow.net_val || 0)) + '</td>';
          html += '          <td class="py-2 px-2 text-center font-mono font-bold text-emerald-300">' + escapeHtml(dayRow.top_buyer || '—') + '</td>';
          html += '          <td class="py-2 px-2 text-center font-mono font-bold text-rose-300">' + escapeHtml(dayRow.top_seller || '—') + '</td>';
          html += '          <td class="py-2 px-2 text-center">';
          html += '            <button type="button" onclick="BandarmologiRuntime.loadBandarmologiTab(null, \'' + escapeHtml(dayRow.date) + '\')" class="px-2 py-1 text-[10px] rounded bg-dark-600 hover:bg-emerald-600 hover:text-white text-gray-300 transition">Lihat Top 5</button>';
          html += '          </td>';
          html += '        </tr>';
        }
        html += '      </tbody>';
        html += '    </table>';
        html += '  </div>';
      }
      html += '</div>';

      // 3. HISTORICAL BROKER ACCUMULATION (BAR CHART)
      html += '<div class="mb-5 bg-dark-700/40 border border-dark-600/30 rounded-xl p-3.5">';
      html += '  <div class="flex items-center justify-between mb-3">';
      html += '    <h3 class="text-xs font-bold text-gray-200 flex items-center gap-1.5"><span class="text-sm">📈</span> Grafik Tren Akumulasi vs Distribusi Historis</h3>';
      if (bAcc.accumulation_score != null) {
        html += '    <span class="text-[11px] font-mono px-2 py-0.5 rounded bg-dark-600 text-emerald-400 border border-emerald-500/20">Acc Score: ' + bAcc.accumulation_score + '/100</span>';
      }
      html += '  </div>';

      if (series.length === 0) {
        html += '  <div class="text-gray-500 text-center py-4 text-xs">Belum ada data series akumulasi</div>';
      } else {
        html += '  <div class="space-y-2">';
        var maxAbs = 1;
        for (var k = 0; k < series.length; k++) {
          var val = Math.abs(series[k].net_val || 0);
          if (val > maxAbs) maxAbs = val;
        }
        for (var si = 0; si < series.length; si++) {
          var day = series[si];
          var isPositive = (day.net_val || 0) >= 0;
          var barWidth = Math.max(8, Math.min(100, Math.round((Math.abs(day.net_val || 0) / maxAbs) * 100)));
          var barColor = isPositive ? 'bg-emerald-500' : 'bg-rose-500';

          html += '    <div class="flex items-center gap-3 text-xs">';
          html += '      <span class="w-20 text-[11px] font-mono text-gray-400 shrink-0">' + escapeHtml(day.date) + '</span>';
          html += '      <div class="flex-1 bg-dark-800/80 rounded-full h-3 overflow-hidden flex items-center px-0.5">';
          html += '        <div class="h-2 rounded-full ' + barColor + ' transition-all" style="width:' + barWidth + '%"></div>';
          html += '      </div>';
          html += '      <span class="w-24 text-right font-mono font-semibold text-[11px] ' + (isPositive ? 'text-emerald-400' : 'text-rose-400') + ' shrink-0">' + (isPositive ? '+' : '-') + formatIDR(Math.abs(day.net_val || 0)) + '</span>';
          html += '    </div>';
        }
        html += '  </div>';
      }
      html += '</div>';
    }
    html += '</div>';
    }

    // 4. INSIDER TRANSACTIONS SECTION (Exclusively for Bandarmologi & Insider tab)
    if (isSummarySection) {
      html += '<div class="bg-dark-700/40 border border-dark-600/30 rounded-xl p-3.5">';
      html += '  <div class="flex items-center justify-between mb-3">';
      html += '    <h3 class="text-xs font-bold text-gray-200 flex items-center gap-1.5"><span class="text-sm">👥</span> Transaksi Insider (Orang Dalam)</h3>';
      html += '    <span class="text-[11px] text-gray-400">' + insiders.length + ' transaksi tercatat</span>';
      html += '  </div>';

      if (insiders.length === 0) {
        html += '  <div class="text-gray-500 text-center py-6 text-xs">Tidak ada riwayat transaksi insider untuk ticker ini.</div>';
      } else {
        html += '  <div class="overflow-x-auto overflow-y-auto max-h-72 scrollbar-thin">';
        html += '    <table class="w-full text-left text-xs">';
        html += '      <thead>';
        html += '        <tr class="text-[11px] text-gray-400 border-b border-dark-600/40 sticky top-0 bg-dark-800/95 backdrop-blur z-10">';
        html += '          <th class="py-2 px-2">Tanggal</th>';
        html += '          <th class="py-2 px-2">Nama Insider</th>';
        html += '          <th class="py-2 px-2">Jabatan</th>';
        html += '          <th class="py-2 px-2 text-center">Aksi</th>';
        html += '          <th class="py-2 px-2 text-right">Lembar Saham</th>';
        html += '          <th class="py-2 px-2 text-right">Perubahan %</th>';
        html += '        </tr>';
        html += '      </thead>';
        html += '      <tbody class="divide-y divide-dark-600/20">';
        for (var ins = 0; ins < insiders.length; ins++) {
          var row = insiders[ins];
          var isBuy = String(row.action_type || row.type || 'BUY').toUpperCase().includes('BUY');
          var actionTag = isBuy
            ? '<span class="px-2 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 font-bold text-[10px]">BELI</span>'
            : '<span class="px-2 py-0.5 rounded bg-rose-500/10 border border-rose-500/30 text-rose-300 font-bold text-[10px]">JUAL</span>';

          html += '        <tr class="hover:bg-dark-600/20 transition">';
          html += '          <td class="py-2.5 px-2 font-mono text-[11px] text-gray-300">' + escapeHtml(row.date || '—') + '</td>';
          html += '          <td class="py-2.5 px-2 font-medium text-gray-100">' + escapeHtml(row.name || '—') + '</td>';
          html += '          <td class="py-2.5 px-2 text-gray-400 text-[11px]">' + escapeHtml(row.position || '—') + '</td>';
          html += '          <td class="py-2.5 px-2 text-center">' + actionTag + '</td>';
          html += '          <td class="py-2.5 px-2 font-mono text-right text-gray-200">' + formatNumber(row.shares != null ? row.shares : (row.volume != null ? row.volume : null)) + '</td>';
          html += '          <td class="py-2.5 px-2 font-mono text-right ' + (isBuy ? 'text-emerald-400' : 'text-rose-400') + '">' + escapeHtml(row.pct_change || '—') + '</td>';
          html += '        </tr>';
        }
        html += '      </tbody>';
        html += '    </table>';
        html += '  </div>';
      }
      html += '</div>';
    }

    container.innerHTML = html;
  }

  function setHunterBroker(code) {
    if (!code) return;
    hunterBroker = String(code).trim().toUpperCase();
    loadBrokerHunter();
  }

  function setHunterRange(range) {
    hunterRange = range || '1d';
    if (hunterRange === 'custom') {
      var container = byId('bandarmologiContent');
      if (container && bandarSection === 'hunter') {
        renderBrokerHunterUI(container);
      }
      return;
    }
    loadBrokerHunter();
  }

  function applyCustomHunterRange(startDate, endDate) {
    if (!startDate || !endDate) return;
    hunterStartDate = startDate;
    hunterEndDate = endDate;
    hunterRange = 'custom';
    loadBrokerHunter();
  }

  function inspectHunterTicker(ticker, tab) {
    if (!ticker) return;
    var clean = String(ticker).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!clean) return;
    if (root.UnifiedCockpit && typeof root.UnifiedCockpit.syncActiveTicker === 'function') {
      root.UnifiedCockpit.syncActiveTicker(clean, {
        loadChart: true,
        forceChartReload: false,
        preserveTab: false,
        runAnalysis: tab === 'analisis'
      });
    }
    if (typeof root.switchAnalisisTab === 'function') {
      root.switchAnalisisTab(tab || 'bandarmologi');
    }
  }

  async function loadBrokerHunter(targetContainer) {
    hunterLoading = true;
    hunterError = null;
    var container = targetContainer || ((typeof document !== 'undefined') ? (byId('brokerHunterContent') || byId('bandarmologiContent')) : null);
    if (container) {
      renderBrokerHunterUI(container);
    }
    if (typeof fetch === 'undefined') {
      hunterLoading = false;
      return;
    }
    try {
      var url = '/api/sector-hot?action=broker-hunter&broker=' + encodeURIComponent(hunterBroker) + '&range=' + encodeURIComponent(hunterRange);
      if (hunterRange === 'custom' && hunterStartDate && hunterEndDate) {
        url += '&startDate=' + encodeURIComponent(hunterStartDate) + '&endDate=' + encodeURIComponent(hunterEndDate);
      }
      var resp = await fetch(url);
      var json = await resp.json();
      if (json && json.success) {
        hunterData = json;
      } else {
        hunterError = (json && json.error) || 'Gagal memuat data Broker Hunter.';
      }
    } catch (err) {
      hunterError = err.message || String(err);
    } finally {
      hunterLoading = false;
      if (container) {
        renderBrokerHunterUI(container);
      }
    }
  }

  function renderBrokerHunterUI(container) {
    container = container || ((typeof document !== 'undefined') ? (byId('brokerHunterContent') || byId('bandarmologiContent')) : null);
    if (!container) return;

    if (!hunterData && !hunterLoading && !hunterError && typeof fetch !== 'undefined') {
      loadBrokerHunter(container);
    }

    var html = '';

    // HEADER CONTROLS CARD
    html += '<div class="bg-dark-800/80 border border-dark-600/40 rounded-xl p-4 mb-5 shadow-lg backdrop-blur">';
    html += '  <div class="flex flex-wrap items-center justify-between gap-3 mb-4">';
    html += '    <div>';
    html += '      <h3 class="text-sm font-bold text-gray-100 flex items-center gap-2">';
    html += '        <span class="text-base">🎯</span> Broker Hunter — Top 10 Saham per Broker';
    html += '      </h3>';
    html += '      <p class="text-xs text-gray-400 mt-0.5">Lacak 10 saham paling banyak diakumulasi &amp; didistribusi oleh broker tertentu dari seluruh emiten IHSG.</p>';
    html += '    </div>';
    html += '    <button type="button" onclick="BandarmologiRuntime.loadBrokerHunter()" class="px-3 py-1.5 rounded-lg bg-dark-700 hover:bg-dark-600 text-gray-200 border border-dark-600 text-xs font-semibold flex items-center gap-1.5 transition">';
    html += '      <span>🔄 Refresh Data</span>';
    html += '    </button>';
    html += '  </div>';

    // Quick Broker Chips
    var quickBrokers = ['AK', 'BK', 'CC', 'RX', 'KZ', 'ZP', 'YP', 'XC', 'PD', 'NI', 'MG', 'SQ'];
    html += '  <div class="flex flex-wrap items-center gap-2 mb-3">';
    html += '    <span class="text-xs text-gray-300 font-medium">Pilih Broker Cepat:</span>';
    html += '    <div class="flex flex-wrap items-center gap-1.5">';
    for (var bi = 0; bi < quickBrokers.length; bi++) {
      var qb = quickBrokers[bi];
      var isQSelected = qb === hunterBroker;
      var qbForeign = isForeignBroker(qb);
      var qbClass = isQSelected
        ? 'bg-emerald-500 text-dark-900 border-emerald-400 font-bold shadow-sm'
        : (qbForeign
            ? 'bg-dark-700/80 text-sky-300 border-sky-500/30 hover:bg-sky-500/20'
            : 'bg-dark-700/80 text-gray-300 border-dark-600 hover:bg-dark-600 hover:text-white');
      html += '      <button type="button" onclick="BandarmologiRuntime.setHunterBroker(\'' + escapeHtml(qb) + '\')" class="px-2.5 py-1 text-xs rounded-md border font-mono transition ' + qbClass + '">' + escapeHtml(qb) + '</button>';
    }
    html += '    </div>';
    html += '  </div>';

    // Dropdown + Range Selector Row
    html += '  <div class="flex flex-wrap items-center justify-between gap-3 pt-2 border-t border-dark-700/50">';
    html += '    <div class="flex items-center gap-2">';
    html += '      <label for="brokerHunterSelect" class="text-xs text-gray-300 font-medium">Semua Broker:</label>';
    html += '      <select id="brokerHunterSelect" onchange="BandarmologiRuntime.setHunterBroker(this.value)" class="bg-dark-900 text-gray-200 border border-dark-600 rounded-lg px-2.5 py-1.5 text-xs font-mono focus:outline-none focus:border-emerald-500">';
    var allBrokerKeys = Object.keys(BROKER_NAMES).sort();
    for (var k = 0; k < allBrokerKeys.length; k++) {
      var bCode = allBrokerKeys[k];
      var bName = BROKER_NAMES[bCode];
      var bForeign = isForeignBroker(bCode);
      var isSel = bCode === hunterBroker;
      html += '        <option value="' + escapeHtml(bCode) + '" ' + (isSel ? 'selected' : '') + '>';
      html += escapeHtml(bCode) + ' - ' + escapeHtml(bName) + (bForeign ? ' [Foreign]' : ' [Domestic]');
      html += '        </option>';
    }
    html += '      </select>';
    html += '    </div>';

    // Range Filter (1d, 7d, 30d, custom)
    var r1Class = hunterRange === '1d' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium';
    var r7Class = hunterRange === '7d' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium';
    var r30Class = hunterRange === '30d' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium';
    var rCustomClass = hunterRange === 'custom' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium';
    html += '    <div class="flex items-center gap-1 bg-dark-900 p-0.5 rounded-lg border border-dark-600/50 text-[11px]">';
    html += '      <span class="text-[10px] text-gray-400 font-medium px-1.5 uppercase tracking-wider">Rentang:</span>';
    html += '      <button type="button" onclick="BandarmologiRuntime.setHunterRange(\'1d\')" class="px-2.5 py-1 rounded-md transition ' + r1Class + '">1 Hari</button>';
    html += '      <button type="button" onclick="BandarmologiRuntime.setHunterRange(\'7d\')" class="px-2.5 py-1 rounded-md transition ' + r7Class + '">7 Hari</button>';
    html += '      <button type="button" onclick="BandarmologiRuntime.setHunterRange(\'30d\')" class="px-2.5 py-1 rounded-md transition ' + r30Class + '">30 Hari</button>';
    html += '      <button type="button" onclick="BandarmologiRuntime.setHunterRange(\'custom\')" class="px-2.5 py-1 rounded-md transition ' + rCustomClass + '">Custom</button>';
    html += '    </div>';
    html += '  </div>';

    // Custom date inputs if custom range is selected
    if (hunterRange === 'custom') {
      html += '  <div class="flex flex-wrap items-center gap-2 mt-3 pt-3 border-t border-dark-700/50">';
      html += '    <span class="text-xs text-gray-300 font-medium">Periode Custom:</span>';
      html += '    <input type="date" id="hunterCustomStartDate" value="' + escapeHtml(hunterStartDate) + '" class="bg-dark-900 text-gray-200 border border-dark-600 rounded px-2 py-1 text-xs">';
      html += '    <span class="text-xs text-gray-400">s/d</span>';
      html += '    <input type="date" id="hunterCustomEndDate" value="' + escapeHtml(hunterEndDate) + '" class="bg-dark-900 text-gray-200 border border-dark-600 rounded px-2 py-1 text-xs">';
      html += '    <button type="button" onclick="BandarmologiRuntime.applyCustomHunterRange(document.getElementById(\'hunterCustomStartDate\').value, document.getElementById(\'hunterCustomEndDate\').value)" class="px-3 py-1 rounded bg-emerald-500 hover:bg-emerald-600 text-dark-900 font-bold text-xs transition">Terapkan</button>';
      html += '  </div>';
    }
    html += '</div>';

    // 3. LOADING / ERROR / CONTENT STATE
    if (hunterLoading) {
      html += '<div class="flex flex-col items-center justify-center py-16 bg-dark-800/40 rounded-xl border border-dark-700/30">';
      html += '  <div class="spinner mb-3"></div>';
      html += '  <p class="text-xs text-gray-300 font-medium">Mengambil data Broker Hunter ' + escapeHtml(hunterBroker) + '...</p>';
      html += '  <p class="text-[11px] text-gray-500 mt-1">Memeriksa database indeks agregasi broker...</p>';
      html += '</div>';
      container.innerHTML = html;
      return;
    }

    if (hunterError) {
      html += '<div class="bg-rose-500/10 border border-rose-500/30 rounded-xl p-4 text-center my-4">';
      html += '  <p class="text-xs text-rose-300 font-medium mb-2">⚠️ ' + escapeHtml(hunterError) + '</p>';
      html += '  <button type="button" onclick="BandarmologiRuntime.loadBrokerHunter()" class="px-3 py-1.5 rounded-lg bg-rose-500/20 text-rose-200 border border-rose-500/30 text-xs font-semibold hover:bg-rose-500/30 transition">Coba Lagi</button>';
      html += '</div>';
      container.innerHTML = html;
      return;
    }

    if (!hunterData) {
      container.innerHTML = html;
      return;
    }

    // 4. ACTIVE BROKER SUMMARY BANNER
    var bName = hunterData.broker_name || getBrokerSecurityName(hunterBroker);
    var bIsForeign = isForeignBroker(hunterBroker);
    var topAcc = Array.isArray(hunterData.top_accumulated) ? hunterData.top_accumulated : [];
    var topDist = Array.isArray(hunterData.top_distributed) ? hunterData.top_distributed : [];

    html += '<div class="bg-dark-700/40 border border-dark-600/30 rounded-xl p-3.5 mb-5 flex flex-wrap items-center justify-between gap-3">';
    html += '  <div class="flex items-center gap-3">';
    html += '    <div class="w-10 h-10 rounded-xl flex items-center justify-center font-mono font-bold text-sm ' + (bIsForeign ? 'bg-sky-500/20 text-sky-300 border border-sky-500/40' : 'bg-emerald-500/20 text-emerald-300 border border-emerald-500/40') + '">' + escapeHtml(hunterBroker) + '</div>';
    html += '    <div>';
    html += '      <div class="flex items-center gap-2">';
    html += '        <h4 class="text-sm font-bold text-gray-100">' + escapeHtml(bName) + '</h4>';
    html += '        <span class="text-[10px] px-2 py-0.5 rounded font-semibold ' + (bIsForeign ? 'bg-sky-500/10 text-sky-400 border border-sky-500/30' : 'bg-emerald-500/10 text-emerald-400 border border-emerald-500/30') + '">' + (bIsForeign ? '🌐 Asing / Foreign' : '🇮🇩 Domestik') + '</span>';
    html += '      </div>';
    html += '      <div class="text-[11px] text-gray-400 mt-0.5">';
    html += '        <span>Periode: <strong class="text-gray-200">' + escapeHtml(hunterData.date_range_label || hunterRange) + '</strong></span> &bull; ';
    html += '        <span>Saham Aktif: <strong class="text-gray-200">' + formatNumber(hunterData.total_stocks_active || (topAcc.length + topDist.length)) + '</strong></span>';
    html += '      </div>';
    html += '    </div>';
    html += '  </div>';
    html += '  <div class="flex items-center gap-2">';
    if (hunterData.from_cache) {
      html += '    <span class="text-[11px] px-2.5 py-1 rounded-md bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 font-mono">⚡ Index Cepat Terindeks</span>';
    } else {
      html += '    <span class="text-[11px] px-2.5 py-1 rounded-md bg-dark-700 border border-dark-600 text-gray-300 font-mono">🔍 Query Dinamis</span>';
    }
    html += '  </div>';
    html += '</div>';

    // 5. TOP 10 AKUMULASI (NET BUY) & TOP 10 DISTRIBUSI (NET SELL) TABLES
    html += '<div class="grid grid-cols-1 lg:grid-cols-2 gap-5">';

    // --- LEFT COLUMN: TOP 10 AKUMULASI ---
    html += '<div class="bg-dark-700/40 border border-emerald-500/20 rounded-xl p-4">';
    html += '  <div class="flex items-center justify-between mb-3">';
    html += '    <h3 class="text-xs font-bold text-emerald-300 flex items-center gap-1.5"><span class="text-sm">🟢</span> Top 10 Akumulasi (Net Buy)</h3>';
    html += '    <span class="text-[10px] text-gray-400">' + topAcc.length + ' saham</span>';
    html += '  </div>';

    if (topAcc.length === 0) {
      html += '  <div class="text-center py-8 text-xs text-gray-500">Tidak ada saham yang diakumulasi net buy oleh broker ' + escapeHtml(hunterBroker) + ' pada periode ini.</div>';
    } else {
      html += '  <div class="overflow-x-auto">';
      html += '    <table class="w-full text-left text-xs">';
      html += '      <thead>';
      html += '        <tr class="text-[10px] text-gray-400 border-b border-dark-600/40 uppercase tracking-wider">';
      html += '          <th class="py-2 px-2">#</th>';
      html += '          <th class="py-2 px-2">Ticker</th>';
      html += '          <th class="py-2 px-2 text-right">Net Value</th>';
      html += '          <th class="py-2 px-2 text-right">Net Lot</th>';
      html += '          <th class="py-2 px-2 text-right">Avg Beli</th>';
      html += '          <th class="py-2 px-2 text-center">Aksi</th>';
      html += '        </tr>';
      html += '      </thead>';
      html += '      <tbody class="divide-y divide-dark-600/20">';
      for (var a = 0; a < topAcc.length; a++) {
        var rowA = topAcc[a];
        var netValA = rowA.net_val || 0;
        var netLotA = rowA.net_lot != null ? rowA.net_lot : Math.round((rowA.net_vol || 0) / 100);
        var avgBuyA = rowA.avg_buy_price || rowA.avg_buy || 0;

        html += '        <tr class="hover:bg-dark-600/20 transition">';
        html += '          <td class="py-2.5 px-2 font-mono text-gray-400 text-[11px]">' + (a + 1) + '</td>';
        html += '          <td class="py-2.5 px-2">';
        html += '            <button type="button" onclick="BandarmologiRuntime.inspectHunterTicker(\'' + escapeHtml(rowA.ticker) + '\', \'bandarmologi\')" class="font-bold text-emerald-400 hover:text-emerald-300 font-mono hover:underline">' + escapeHtml(rowA.ticker) + '</button>';
        html += '          </td>';
        html += '          <td class="py-2.5 px-2 text-right font-mono font-semibold text-emerald-400">+' + formatIDR(netValA) + '</td>';
        html += '          <td class="py-2.5 px-2 text-right font-mono text-gray-200">+' + formatNumber(netLotA) + '</td>';
        html += '          <td class="py-2.5 px-2 text-right font-mono text-gray-300">' + (avgBuyA > 0 ? 'Rp ' + formatNumber(avgBuyA) : '—') + '</td>';
        html += '          <td class="py-2.5 px-2 text-center">';
        html += '            <div class="flex items-center justify-center gap-1">';
        html += '              <button type="button" onclick="BandarmologiRuntime.inspectHunterTicker(\'' + escapeHtml(rowA.ticker) + '\', \'bandarmologi\')" title="Buka Bandarmologi" class="px-2 py-0.5 rounded bg-emerald-500/10 hover:bg-emerald-500/20 border border-emerald-500/30 text-emerald-300 text-[10px] font-semibold transition">Bandar</button>';
        html += '              <button type="button" onclick="BandarmologiRuntime.inspectHunterTicker(\'' + escapeHtml(rowA.ticker) + '\', \'analisis\')" title="Analisis Saham" class="px-2 py-0.5 rounded bg-sky-500/10 hover:bg-sky-500/20 border border-sky-500/30 text-sky-300 text-[10px] font-semibold transition">AI</button>';
        html += '            </div>';
        html += '          </td>';
        html += '        </tr>';
      }
      html += '      </tbody>';
      html += '    </table>';
      html += '  </div>';
    }
    html += '</div>';

    // --- RIGHT COLUMN: TOP 10 DISTRIBUSI ---
    html += '<div class="bg-dark-700/40 border border-rose-500/20 rounded-xl p-4">';
    html += '  <div class="flex items-center justify-between mb-3">';
    html += '    <h3 class="text-xs font-bold text-rose-300 flex items-center gap-1.5"><span class="text-sm">🔴</span> Top 10 Distribusi (Net Sell)</h3>';
    html += '    <span class="text-[10px] text-gray-400">' + topDist.length + ' saham</span>';
    html += '  </div>';

    if (topDist.length === 0) {
      html += '  <div class="text-center py-8 text-xs text-gray-500">Tidak ada saham yang didistribusi net sell oleh broker ' + escapeHtml(hunterBroker) + ' pada periode ini.</div>';
    } else {
      html += '  <div class="overflow-x-auto">';
      html += '    <table class="w-full text-left text-xs">';
      html += '      <thead>';
      html += '        <tr class="text-[10px] text-gray-400 border-b border-dark-600/40 uppercase tracking-wider">';
      html += '          <th class="py-2 px-2">#</th>';
      html += '          <th class="py-2 px-2">Ticker</th>';
      html += '          <th class="py-2 px-2 text-right">Net Value</th>';
      html += '          <th class="py-2 px-2 text-right">Net Lot</th>';
      html += '          <th class="py-2 px-2 text-right">Avg Jual</th>';
      html += '          <th class="py-2 px-2 text-center">Aksi</th>';
      html += '        </tr>';
      html += '      </thead>';
      html += '      <tbody class="divide-y divide-dark-600/20">';
      for (var d = 0; d < topDist.length; d++) {
        var rowD = topDist[d];
        var netValD = rowD.net_val || 0;
        var netLotD = rowD.net_lot != null ? rowD.net_lot : Math.round((rowD.net_vol || 0) / 100);
        var avgSellD = rowD.avg_sell_price || rowD.avg_sell || 0;

        html += '        <tr class="hover:bg-dark-600/20 transition">';
        html += '          <td class="py-2.5 px-2 font-mono text-gray-400 text-[11px]">' + (d + 1) + '</td>';
        html += '          <td class="py-2.5 px-2">';
        html += '            <button type="button" onclick="BandarmologiRuntime.inspectHunterTicker(\'' + escapeHtml(rowD.ticker) + '\', \'bandarmologi\')" class="font-bold text-rose-400 hover:text-rose-300 font-mono hover:underline">' + escapeHtml(rowD.ticker) + '</button>';
        html += '          </td>';
        html += '          <td class="py-2.5 px-2 text-right font-mono font-semibold text-rose-400">' + formatIDR(netValD) + '</td>';
        html += '          <td class="py-2.5 px-2 text-right font-mono text-gray-200">' + formatNumber(netLotD) + '</td>';
        html += '          <td class="py-2.5 px-2 text-right font-mono text-gray-300">' + (avgSellD > 0 ? 'Rp ' + formatNumber(avgSellD) : '—') + '</td>';
        html += '          <td class="py-2.5 px-2 text-center">';
        html += '            <div class="flex items-center justify-center gap-1">';
        html += '              <button type="button" onclick="BandarmologiRuntime.inspectHunterTicker(\'' + escapeHtml(rowD.ticker) + '\', \'bandarmologi\')" title="Buka Bandarmologi" class="px-2 py-0.5 rounded bg-rose-500/10 hover:bg-rose-500/20 border border-rose-500/30 text-rose-300 text-[10px] font-semibold transition">Bandar</button>';
        html += '              <button type="button" onclick="BandarmologiRuntime.inspectHunterTicker(\'' + escapeHtml(rowD.ticker) + '\', \'analisis\')" title="Analisis Saham" class="px-2 py-0.5 rounded bg-sky-500/10 hover:bg-sky-500/20 border border-sky-500/30 text-sky-300 text-[10px] font-semibold transition">AI</button>';
        html += '            </div>';
        html += '          </td>';
        html += '        </tr>';
      }
      html += '      </tbody>';
      html += '    </table>';
      html += '  </div>';
    }
    html += '</div>';

    html += '</div>'; // End grid

    container.innerHTML = html;
  }

  root.BandarmologiRuntime = {
    loadBandarmologiTab: loadBandarmologiTab,
    setBrokerSummaryMode: setBrokerSummaryMode,
    getBrokerSummaryMode: function () { return brokerSummaryMode; },
    setBrokerSummaryView: setBrokerSummaryView,
    getBrokerSummaryView: function () { return brokerSummaryView; },
    setBrokerSummaryRange: setBrokerSummaryRange,
    getBrokerSummaryRange: function () { return brokerSummaryRange; },
    applyCustomBrokerSummaryRange: applyCustomBrokerSummaryRange,
    getCustomBrokerSummaryRange: function () { return { start: customRangeStart, end: customRangeEnd }; },
    setBrokerFlowFilter: setBrokerFlowFilter,
    getBrokerFlowFilter: function () { return brokerFlowFilter; },
    setBandarSection: setBandarSection,
    getBandarSection: function () { return bandarSection; },
    selectBrokerBubble: selectBrokerBubble,
    setBubbleFilterSide: setBubbleFilterSide,
    getBubbleFilterSide: function () { return bubbleFilterSide; },
    setBrokerAccumulationView: setBrokerAccumulationView,
    getBrokerAccumulationView: function () { return brokerAccumulationView; },
    BROKER_NAMES: BROKER_NAMES,
    FOREIGN_BROKERS: FOREIGN_BROKERS,
    isForeignBroker: isForeignBroker,
    filterBrokersByFlow: filterBrokersByFlow,
    getBrokerSecurityName: getBrokerSecurityName,
    buildBrokerBubbleItems: buildBrokerBubbleItems,
    renderBrokerBubbleClusterHtml: renderBrokerBubbleClusterHtml,
    renderBrokerDetailCardHtml: renderBrokerDetailCardHtml,
    renderBandarmologiUI: renderBandarmologiUI,
    setHunterBroker: setHunterBroker,
    getHunterBroker: function () { return hunterBroker; },
    setHunterRange: setHunterRange,
    getHunterRange: function () { return hunterRange; },
    applyCustomHunterRange: applyCustomHunterRange,
    getCustomHunterRange: function () { return { start: hunterStartDate, end: hunterEndDate }; },
    inspectHunterTicker: inspectHunterTicker,
    loadBrokerHunter: loadBrokerHunter,
    renderBrokerHunterUI: renderBrokerHunterUI
  };

  root.loadBandarmologiTab = loadBandarmologiTab;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      BROKER_NAMES: BROKER_NAMES,
      FOREIGN_BROKERS: FOREIGN_BROKERS,
      isForeignBroker: isForeignBroker,
      filterBrokersByFlow: filterBrokersByFlow,
      getBrokerSecurityName: getBrokerSecurityName,
      buildBrokerBubbleItems: buildBrokerBubbleItems,
      renderBrokerBubbleClusterHtml: renderBrokerBubbleClusterHtml,
      renderBrokerDetailCardHtml: renderBrokerDetailCardHtml,
      renderBandarmologiUI: renderBandarmologiUI,
      setBrokerSummaryMode: setBrokerSummaryMode,
      setBrokerSummaryView: setBrokerSummaryView,
      setBrokerAccumulationView: setBrokerAccumulationView,
      setBrokerSummaryRange: setBrokerSummaryRange,
      firstNonEmptyList: firstNonEmptyList,
      setHunterBroker: setHunterBroker,
      setHunterRange: setHunterRange,
      applyCustomHunterRange: applyCustomHunterRange,
      inspectHunterTicker: inspectHunterTicker,
      loadBrokerHunter: loadBrokerHunter,
      renderBrokerHunterUI: renderBrokerHunterUI
    };
  }

})(typeof window !== 'undefined' ? window : this);
