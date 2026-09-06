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

  var currentBandarTicker = 'BBCA';
  var currentBandarDate = '';
  var lastBandarData = null;
  var brokerSummaryMode = 'gross'; // 'gross' or 'net'
  var brokerSummaryView = 'bubble'; // 'bubble' (default) or 'table'
  var brokerSummaryRange = '1d'; // '1d' (default), '7d', '30d'
  var selectedBrokerCode = '';
  var bubbleFilterSide = 'all'; // 'all', 'buy', 'sell'
  var lastBrokerItems = [];

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

      var bval = item.bval != null ? item.bval : (isBuyerList ? (item.buy_val || item.net_val || 0) : 0);
      var sval = item.sval != null ? item.sval : (!isBuyerList ? (item.sell_val || Math.abs(item.net_val || 0)) : 0);
      var bvol = item.bvol != null ? item.bvol : (isBuyerList ? (item.buy_vol || item.net_vol || 0) : 0);
      var svol = item.svol != null ? item.svol : (!isBuyerList ? (item.sell_vol || Math.abs(item.net_vol || 0)) : 0);

      if (bval > target.bval) target.bval = bval;
      if (sval > target.sval) target.sval = sval;
      if (bvol > target.bvol) target.bvol = bvol;
      if (svol > target.svol) target.svol = svol;

      if (item.bfrq && item.bfrq > target.bfrq) target.bfrq = item.bfrq;
      if (item.sfrq && item.sfrq > target.sfrq) target.sfrq = item.sfrq;

      if (isBuyerList && item.avg_price) target.avgBuy = item.avg_price;
      if (!isBuyerList && item.avg_price) target.avgSell = item.avg_price;

      if (item.nval != null) target.explicitNetVal = item.nval;
      else if (item.net_val != null) target.explicitNetVal = item.net_val;

      if (item.nvol != null) target.explicitNetVol = item.nvol;
      else if (item.net_vol != null) target.explicitNetVol = item.net_vol;
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
      var netVal = it.explicitNetVal != null ? it.explicitNetVal : (it.bval - it.sval);
      var netVol = it.explicitNetVol != null ? it.explicitNetVol : (it.bvol - it.svol);
      var isNetBuyer = netVal >= 0;

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
    html += '    <div class="flex flex-wrap items-center justify-between text-[10px] text-gray-400 font-mono mt-2 pt-1 border-t border-dark-600/20">';
    html += '      <span>Total Transaksi Gross: <strong class="text-gray-200">' + formatIDR(totalGross) + '</strong></span>';
    html += '      <span>Net Flow: <strong class="' + (broker.netVal >= 0 ? 'text-emerald-400' : 'text-rose-400') + '">' + (broker.netVal >= 0 ? '+' : '-') + formatIDR(Math.abs(broker.netVal)) + '</strong></span>';
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
      if (filterSide === 'buy') return b.isNetBuyer;
      if (filterSide === 'sell') return !b.isNetBuyer;
      return true;
    });

    var buyerCount = brokers.filter(function (b) { return b.isNetBuyer; }).length;
    var sellerCount = brokers.filter(function (b) { return !b.isNetBuyer; }).length;

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

  function setBrokerSummaryRange(range) {
    brokerSummaryRange = range || '1d';
    loadBandarmologiTab(currentBandarTicker, brokerSummaryRange === '1d' ? currentBandarDate : null, brokerSummaryRange);
  }

  async function loadBandarmologiTab(ticker, date, range) {
    var clean = String(ticker || currentBandarTicker || 'BBCA').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!clean) clean = 'BBCA';
    currentBandarTicker = clean;
    if (date !== undefined && date !== null) currentBandarDate = date;
    if (range) brokerSummaryRange = range;

    var container = byId('bandarmologiContent');
    if (!container) return;

    var badgeTicker = byId('bandarActiveTickerTag');
    if (badgeTicker) badgeTicker.textContent = clean;

    container.innerHTML = '<div class="flex flex-col items-center justify-center py-12"><div class="spinner"></div><p class="text-xs text-gray-400 mt-3">Mengambil data Bandarmologi &amp; Insider ' + escapeHtml(clean) + '...</p></div>';

    try {
      var url = '/api/sector-hot?action=bandarmologi&ticker=' + encodeURIComponent(clean);
      if (brokerSummaryRange && brokerSummaryRange !== '1d') {
        url += '&range=' + encodeURIComponent(brokerSummaryRange);
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

    var isDemoBadge = data.is_demo
      ? '<span class="text-[10px] px-2 py-0.5 rounded bg-amber-500/10 border border-amber-500/30 text-amber-300 font-mono">DEMO PREVIEW</span>'
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
    html += '      <div class="flex items-center gap-1 bg-dark-800 p-0.5 rounded-lg border border-dark-600/50 text-[11px]">';
    html += '        <span class="text-[10px] text-gray-400 font-medium px-1.5 uppercase tracking-wider">Rentang:</span>';
    html += '        <button type="button" id="toggleRange1d" onclick="BandarmologiRuntime.setBrokerSummaryRange(\'1d\')" class="px-2.5 py-1 rounded-md transition ' + r1Class + '">1 Hari</button>';
    html += '        <button type="button" id="toggleRange7d" onclick="BandarmologiRuntime.setBrokerSummaryRange(\'7d\')" class="px-2.5 py-1 rounded-md transition ' + r7Class + '">7 Hari</button>';
    html += '        <button type="button" id="toggleRange30d" onclick="BandarmologiRuntime.setBrokerSummaryRange(\'30d\')" class="px-2.5 py-1 rounded-md transition ' + r30Class + '">30 Hari</button>';
    html += '      </div>';

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
    html += '        <button type="button" id="toggleBandarGross" onclick="BandarmologiRuntime.setBrokerSummaryMode(\'gross\')" class="px-2.5 py-1 rounded-md transition ' + grossClass + '">Full / Gross</button>';
    html += '        <button type="button" id="toggleBandarNet" onclick="BandarmologiRuntime.setBrokerSummaryMode(\'net\')" class="px-2.5 py-1 rounded-md transition ' + netClass + '">Net</button>';
    html += '      </div>';
    html += '    </div>';
    html += '  </div>';

    var buyers = isGross
      ? (bSum.gross_buyers || bSum.top_buyers || [])
      : (bSum.net_buyers || bSum.top_buyers || []);
    var sellers = isGross
      ? (bSum.gross_sellers || bSum.top_sellers || [])
      : (bSum.net_sellers || bSum.top_sellers || []);

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
          var buyVal = item.bval != null ? item.bval : (item.buy_val || item.net_val || 0);
          var sellVal = item.sval != null ? item.sval : (item.sell_val || 0);
          var buyVol = item.bvol != null ? item.bvol : (item.buy_vol || 0);
          var sellVol = item.svol != null ? item.svol : (item.sell_vol || 0);
          var netVal = item.nval != null ? item.nval : (item.net_val != null ? item.net_val : (buyVal - sellVal));
          var netVol = item.nvol != null ? item.nvol : (item.net_vol != null ? item.net_vol : (buyVol - sellVol));

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
          var sSellVal = sItem.sval != null ? sItem.sval : (sItem.sell_val || Math.abs(sItem.net_val || 0));
          var sBuyVol = sItem.bvol != null ? sItem.bvol : (sItem.buy_vol || 0);
          var sSellVol = sItem.svol != null ? sItem.svol : (sItem.sell_vol || 0);
          var sNetVal = sItem.nval != null ? sItem.nval : (sItem.net_val != null ? sItem.net_val : (sBuyVal - sSellVal));
          var sNetVol = sItem.nvol != null ? sItem.nvol : (sItem.net_vol != null ? sItem.net_vol : (sBuyVol - sSellVol));

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

    // 2. DAILY BROKER SUMMARY BREAKDOWN TABLE (PER HARI)
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

    // 4. INSIDER TRANSACTIONS SECTION
    html += '<div class="bg-dark-700/40 border border-dark-600/30 rounded-xl p-3.5">';
    html += '  <div class="flex items-center justify-between mb-3">';
    html += '    <h3 class="text-xs font-bold text-gray-200 flex items-center gap-1.5"><span class="text-sm">👥</span> Transaksi Insider (Orang Dalam)</h3>';
    html += '    <span class="text-[11px] text-gray-400">' + insiders.length + ' transaksi tercatat</span>';
    html += '  </div>';

    if (insiders.length === 0) {
      html += '  <div class="text-gray-500 text-center py-6 text-xs">Tidak ada riwayat transaksi insider untuk ticker ini.</div>';
    } else {
      html += '  <div class="overflow-x-auto">';
      html += '    <table class="w-full text-left text-xs">';
      html += '      <thead>';
      html += '        <tr class="text-[11px] text-gray-400 border-b border-dark-600/40">';
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
        html += '          <td class="py-2.5 px-2 font-mono text-right text-gray-200">' + formatNumber(row.shares || row.volume || 0) + '</td>';
        html += '          <td class="py-2.5 px-2 font-mono text-right ' + (isBuy ? 'text-emerald-400' : 'text-rose-400') + '">' + escapeHtml(row.pct_change || '—') + '</td>';
        html += '        </tr>';
      }
      html += '      </tbody>';
      html += '    </table>';
      html += '  </div>';
    }
    html += '</div>';

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
    selectBrokerBubble: selectBrokerBubble,
    setBubbleFilterSide: setBubbleFilterSide,
    getBubbleFilterSide: function () { return bubbleFilterSide; },
    BROKER_NAMES: BROKER_NAMES,
    getBrokerSecurityName: getBrokerSecurityName,
    buildBrokerBubbleItems: buildBrokerBubbleItems,
    renderBrokerBubbleClusterHtml: renderBrokerBubbleClusterHtml,
    renderBrokerDetailCardHtml: renderBrokerDetailCardHtml
  };

  root.loadBandarmologiTab = loadBandarmologiTab;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      BROKER_NAMES: BROKER_NAMES,
      getBrokerSecurityName: getBrokerSecurityName,
      buildBrokerBubbleItems: buildBrokerBubbleItems,
      renderBrokerBubbleClusterHtml: renderBrokerBubbleClusterHtml,
      renderBrokerDetailCardHtml: renderBrokerDetailCardHtml,
      setBrokerSummaryMode: setBrokerSummaryMode,
      setBrokerSummaryView: setBrokerSummaryView,
      setBrokerSummaryRange: setBrokerSummaryRange
    };
  }

})(typeof window !== 'undefined' ? window : this);
