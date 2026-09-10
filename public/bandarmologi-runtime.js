(function (root) {
  'use strict';

  function byId(id) {
    if (typeof document === 'undefined') return null;
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

  // IDX Broker Code to Full Security Name Dictionary (Audited September 2026)
  var BROKER_NAMES = {
    // Major Foreign Institutional
    'AK': 'UBS Sekuritas Indonesia',
    'BK': 'J.P. Morgan Sekuritas Indonesia',
    'CS': 'Credit Suisse Sekuritas Indonesia',
    'RX': 'Macquarie Sekuritas Indonesia',
    'KZ': 'CLSA Sekuritas Indonesia',
    'ZP': 'Maybank Sekuritas Indonesia',
    'DB': 'Deutsche Sekuritas Indonesia',
    'GW': 'HSBC Sekuritas Indonesia',
    'DP': 'DBS Vickers Sekuritas Indonesia',
    'MS': 'Morgan Stanley Sekuritas Indonesia',
    'BQ': 'Korea Investment & Sekuritas Indonesia',
    'FS': 'Yuanta Sekuritas Indonesia',
    'YU': 'CGS International Sekuritas Indonesia',
    'AI': 'UOB Kay Hian Sekuritas',
    'DR': 'RHB Sekuritas Indonesia',

    // Major Domestic Institutional & BUMN
    'CC': 'Mandiri Sekuritas',
    'NI': 'BNI Sekuritas',
    'OD': 'BRI Danareksa Sekuritas',
    'DX': 'Bahana Sekuritas',
    'SQ': 'BCA Sekuritas',
    'LG': 'Trimegah Sekuritas Indonesia',
    'KI': 'Ciptadana Sekuritas Asia',
    'PP': 'Aldiracita Sekuritas Indonesia',
    'PO': 'Pilarmas Investindo Sekuritas',

    // Major Retail & Online
    'YP': 'Mirae Asset Sekuritas Indonesia',
    'PD': 'Indo Premier Sekuritas',
    'XC': 'Ajaib Sekuritas Asia',
    'XL': 'Stockbit Sekuritas',
    'CP': 'KB Valbury Sekuritas',
    'GR': 'Panin Sekuritas',
    'MG': 'Semesta Indovest Sekuritas',
    'AZ': 'Sucor Sekuritas',
    'EP': 'MNC Sekuritas',
    'KK': 'Phillip Sekuritas Indonesia',
    'HD': 'KGI Sekuritas Indonesia',
    'DH': 'Sinarmas Sekuritas',
    'IP': 'Sinarmas Sekuritas',
    'AN': 'Wanteg Sekuritas',
    'RG': 'Profindo Sekuritas Indonesia',
    'IF': 'Samuel Sekuritas Indonesia',
    'CD': 'Mega Capital Sekuritas',
    'HP': 'Henan Putihrai Sekuritas',
    'AT': 'Phintraco Sekuritas',
    'AO': 'Erdikha Elit Sekuritas',
    'AP': 'Pacific Sekuritas Indonesia',
    'AR': 'Binaartha Sekuritas',
    'DS': 'Danpac Sekuritas',
    'GA': 'IIF Sekuritas',
    'IN': 'Investindo Nusantara Sekuritas',
    'MI': 'Victoria Sekuritas Indonesia',
    'PG': 'Panca Global Sekuritas',
    'RB': 'Reliance Sekuritas Indonesia',
    'RO': 'NISP Sekuritas',
    'SF': 'Surya Fajar Sekuritas',
    'SH': 'Artha Sekuritas Indonesia',
    'SS': 'Shinhan Sekuritas Indonesia',
    'TF': 'Universal Broker Indonesia',
    'TP': 'OCBC Sekuritas Indonesia',
    'XA': 'NH Korindo Sekuritas Indonesia',
    'YJ': 'Lotus Andalan Sekuritas',
    'AG': 'Kiwoom Sekuritas Indonesia',
    'AH': 'Shinhan Sekuritas Indonesia',
    'BR': 'Trust Sekuritas',
    'PC': 'FAC Sekuritas Indonesia',
    'FZ': 'Waterfront Sekuritas Indonesia',
    'IH': 'Pacific Capital Sekuritas',
    'II': 'Danatama Makmur Sekuritas',
    'IU': 'Indo Capital Sekuritas',
    'JB': 'Victoria Sekuritas',
    'KS': 'Kresna Sekuritas',
    'NO': 'BNC Sekuritas Indonesia',
    'PE': 'Waterfront Sekuritas',
    'PF': 'Danasakti Sekuritas',
    'PS': 'Paramitra Alfa Sekuritas',
    'RF': 'Buana Capital Sekuritas',
    'RS': 'Yulie Sekuritas Indonesia',
    'TX': 'Dhanawibawa Sekuritas'
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
    // Absolute sanity guard: Any broker value >= 500 Miliar (5e11) is a 100x multiplier artifact in IDX data
    if (Math.abs(num) >= 5e11) {
      return Math.round(num / 100);
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
    return Math.round(val / vol);
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
  var bandarSection = 'summary'; // 'summary' (Broker Summary), 'akumulasi' (Akumulasi Broker), or 'intel' (Sinyal Intelijen Bandar)
  var selectedBrokerCode = '';
  var selectedBrokerSide = '';
  var bubbleFilterSide = 'all'; // 'all', 'buy', 'sell'
  var insiderActionFilter = 'all'; // 'all', 'BUY', 'SELL'
  var lastBrokerItems = [];

  // Bandarmologi Intelligence State
  var bandarIntelTicker = 'BBCA';
  var bandarIntelRange = '7d'; // '7d' or '30d'
  var bandarIntelViewMode = 'ticker'; // 'ticker' or 'scanner'
  var bandarIntelScannerCategory = 'harga_di_bawah_modal_bandar';
  var bandarIntelData = null;
  var bandarIntelScannerData = null;
  var bandarIntelLoading = false;
  var bandarIntelError = null;
  var activeIntelAbortController = null;
  var intelRequestSeq = 0;

  var RETAIL_BROKERS = ['YP', 'PD', 'XC', 'XL', 'NI'];
  var INSTITUTIONAL_BROKERS = ['AK', 'BK', 'RX', 'CC', 'KZ', 'ZP', 'CS', 'DB'];

  function isRetailBroker(code) {
    if (!code) return false;
    return RETAIL_BROKERS.indexOf(String(code).trim().toUpperCase()) >= 0;
  }

  function isInstitutionalBroker(code) {
    if (!code) return false;
    return INSTITUTIONAL_BROKERS.indexOf(String(code).trim().toUpperCase()) >= 0;
  }

  // Broker Hunter state
  var hunterBroker = 'AK';
  var hunterRange = '1d';
  var hunterStartDate = '';
  var hunterEndDate = '';
  var hunterData = null;
  var hunterLoading = false;
  var hunterError = null;
  var activeHunterAbortController = null;
  var hunterRequestSeq = 0;

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

  function synthesizeAccumulationFromSummary(summary, ticker) {
    if (!summary) {
      return { ticker: ticker || '', series: [], daily_summary: [], top_buyers: [], top_sellers: [], net_buyers: [], net_sellers: [] };
    }
    var buyers = firstNonEmptyList(summary.net_buyers, summary.gross_buyers, summary.top_buyers, summary.buyers);
    var sellers = firstNonEmptyList(summary.net_sellers, summary.gross_sellers, summary.top_sellers, summary.sellers);

    var finalBuyers = [];
    var finalSellers = [];
    var seen = {};

    for (var bi = 0; bi < buyers.length; bi++) {
      var b = buyers[bi];
      var code = b && (b.broker || b.broker_code || b.code || '');
      if (!code || seen[code]) continue;
      seen[code] = true;
      b.broker = code;
      b.broker_code = code;
      var nval = b.nval != null ? Number(b.nval) : (b.net_val != null ? Number(b.net_val) : ((Number(b.bval || b.buy_val || 0)) - (Number(b.sval || b.sell_val || 0))));
      if (nval < 0) {
        finalSellers.push(b);
      } else {
        finalBuyers.push(b);
      }
    }

    for (var si = 0; si < sellers.length; si++) {
      var s = sellers[si];
      var sCode = s && (s.broker || s.broker_code || s.code || '');
      if (!sCode || seen[sCode]) continue;
      seen[sCode] = true;
      s.broker = sCode;
      s.broker_code = sCode;
      finalSellers.push(s);
    }

    if (finalSellers.length === 0 && finalBuyers.length > 0) {
      var pb = [];
      var ps = [];
      for (var p = 0; p < finalBuyers.length; p++) {
        var itm = finalBuyers[p];
        var nCheck = itm.nval != null ? Number(itm.nval) : (itm.net_val != null ? Number(itm.net_val) : ((Number(itm.bval || itm.buy_val || 0)) - (Number(itm.sval || itm.sell_val || 0))));
        if (nCheck < 0 || ((Number(itm.sval || itm.sell_val || 0)) > (Number(itm.bval || itm.buy_val || 0)))) {
          ps.push(itm);
        } else {
          pb.push(itm);
        }
      }
      if (ps.length > 0) {
        finalBuyers = pb;
        finalSellers = ps;
      } else {
        var withSell = finalBuyers.filter(function (b) { return (Number(b.sval || b.sell_val || 0)) > 0; });
        if (withSell.length > 0) {
          finalSellers = withSell;
        }
      }
    }

    var netFlow = summary.net_flow || 0;
    var series = Array.isArray(summary.date_headers) && summary.date_headers.length > 0
      ? summary.date_headers
      : (netFlow !== 0 ? [{ date: summary.date || 'latest', net_val: netFlow, status: netFlow >= 0 ? 'ACC' : 'DIST' }] : []);

    return {
      ticker: ticker || '',
      accumulation_score: netFlow >= 0 ? 70 : 30,
      status: netFlow >= 0 ? 'ACCUMULATION' : 'DISTRIBUTION',
      series: series,
      daily_summary: series,
      top_buyers: finalBuyers,
      top_sellers: finalSellers,
      net_buyers: finalBuyers,
      net_sellers: finalSellers
    };
  }

  function buildBrokerBubbleItems(buyers, sellers, mode) {
    var isGross = mode === 'gross';
    var map = {};

    function processItem(item, isBuyerList) {
      if (!item) return;
      var code = String(item.broker || item.broker_code || item.code || '').trim().toUpperCase();
      if (!code) return;
      item.broker = code;
      item.broker_code = code;
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
          if (target.bval > target.sval) {
            target.explicitNetVal = target.bval - target.sval;
          } else {
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

    // If sList is empty, check if bList contains sellers or sell values
    if (sList.length === 0 && bList.length > 0) {
      var pb = [];
      var ps = [];
      for (var p = 0; p < bList.length; p++) {
        var itm = bList[p];
        var nCheck = itm.nval != null ? itm.nval : (itm.net_val != null ? itm.net_val : ((itm.bval || itm.buy_val || 0) - (itm.sval || itm.sell_val || 0)));
        if (nCheck < 0 || ((itm.sval || itm.sell_val || 0) > (itm.bval || itm.buy_val || 0))) {
          ps.push(itm);
        } else {
          pb.push(itm);
        }
      }
      if (ps.length > 0) {
        bList = pb;
        sList = ps;
      } else {
        var withSell = bList.filter(function (b) { return (b.sval || b.sell_val || 0) > 0; });
        if (withSell.length > 0) {
          sList = withSell;
        }
      }
    }

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
      if (it.explicitNetVal != null) {
        netVal = it.explicitNetVal;
      } else if (it.bval > 0 && it.sval > 0) {
        netVal = it.bval - it.sval;
      } else if (it.bval > 0) {
        netVal = it.bval;
      } else if (it.sval > 0) {
        netVal = -it.sval;
      } else {
        netVal = it.bval - it.sval;
      }

      var netVol;
      if (it.explicitNetVol != null) {
        netVol = it.explicitNetVol;
      } else if (it.bvol > 0 && it.svol > 0) {
        netVol = it.bvol - it.svol;
      } else if (it.bvol > 0) {
        netVol = it.bvol;
      } else if (it.svol > 0) {
        netVol = -it.svol;
      } else {
        netVol = it.bvol - it.svol;
      }

      // Anomaly correction on netVal if over-inflated into trillions
      netVal = normalizeBrokerValue(netVal, Math.max(it.bvol, it.svol), it.avgBuy || it.avgSell);

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
    }

    var items = [];
    if (isGross) {
      // Gross Buyers: render all active buyers without artificial cap
      var buyerBrokers = [];
      var seenBuyers = {};
      for (var bi = 0; bi < bList.length; bi++) {
        var bItm = bList[bi];
        if (!bItm || !bItm.broker) continue;
        var bCode = String(bItm.broker).trim().toUpperCase();
        if (seenBuyers[bCode]) continue;
        seenBuyers[bCode] = true;
        var bStat = map[bCode];
        if (!bStat) continue;
        var buyTxVal = bStat.bval > 0 ? bStat.bval : Math.max(1, Math.abs(bStat.netVal));
        buyerBrokers.push(Object.assign({}, bStat, {
          side: 'buy',
          isBuyer: true,
          badge: 'BUY',
          txVal: buyTxVal,
          displayVal: bStat.bval
        }));
      }
      buyerBrokers.sort(function (a, b) { return b.txVal - a.txVal; });

      // Gross Sellers: all brokers in sList
      var sellerBrokers = [];
      var seenSellers = {};
      for (var si = 0; si < sList.length; si++) {
        var sItm = sList[si];
        if (!sItm || !sItm.broker) continue;
        var sCode = String(sItm.broker).trim().toUpperCase();
        if (seenSellers[sCode]) continue;
        seenSellers[sCode] = true;
        var sStat = map[sCode];
        if (!sStat) continue;
        var sellTxVal = sStat.sval > 0 ? sStat.sval : Math.max(1, Math.abs(sStat.netVal));
        sellerBrokers.push(Object.assign({}, sStat, {
          side: 'sell',
          isBuyer: false,
          badge: 'SELL',
          txVal: sellTxVal,
          displayVal: sStat.sval
        }));
      }
      sellerBrokers.sort(function (a, b) { return b.txVal - a.txVal; });

      items = buyerBrokers.concat(sellerBrokers);
    } else {
      // Net Mode: All Net Buyers (badge +, green) and All Net Sellers (badge -, red/orange) without artificial slicing
      var netBuyers = [];
      var netSellers = [];
      for (var cn = 0; cn < codes.length; cn++) {
        var nStat = map[codes[cn]];
        var nVal = nStat.netVal;
        var absNval = Math.max(1, Math.abs(nVal));
        if (nStat.isNetBuyer) {
          netBuyers.push(Object.assign({}, nStat, {
            side: 'buy',
            isBuyer: true,
            badge: '+',
            txVal: absNval,
            displayVal: Math.abs(nVal)
          }));
        } else {
          netSellers.push(Object.assign({}, nStat, {
            side: 'sell',
            isBuyer: false,
            badge: '-',
            txVal: absNval,
            displayVal: -Math.abs(nVal)
          }));
        }
      }
      netBuyers.sort(function (a, b) { return b.txVal - a.txVal; });
      netSellers.sort(function (a, b) { return b.txVal - a.txVal; });

      // Fallback: If netSellers is empty but sList has brokers, guarantee sellers are rendered
      if (netSellers.length === 0 && sList.length > 0) {
        for (var si = 0; si < sList.length; si++) {
          var sItem = sList[si];
          if (!sItem || !sItem.broker) continue;
          var sCode = String(sItem.broker).trim().toUpperCase();
          var sVal = Math.abs(Number(sItem.nval != null ? sItem.nval : (sItem.net_val != null ? sItem.net_val : (sItem.sval || sItem.sell_val || sItem.val || 1))));
          var sStat = map[sCode] || {
            broker: sCode,
            fullName: getBrokerSecurityName(sCode, sItem.broker_name),
            bval: 0,
            sval: sVal,
            bvol: 0,
            svol: sItem.svol || sItem.sell_vol || 0,
            avgBuy: 0,
            avgSell: sItem.avg_price || 0,
            netVal: -sVal,
            txVal: sVal,
            isNetBuyer: false
          };
          sStat.netVal = -Math.abs(sStat.netVal || sVal);
          sStat.isNetBuyer = false;
          netSellers.push(Object.assign({}, sStat, {
            side: 'sell',
            isBuyer: false,
            badge: '-',
            txVal: Math.max(1, sVal),
            displayVal: -Math.abs(sVal)
          }));
        }
        netSellers.sort(function (a, b) { return b.txVal - a.txVal; });
      }

      items = netBuyers.concat(netSellers);
    }

    // Sort descending by transaction magnitude
    items.sort(function (a, b) {
      return b.txVal - a.txVal;
    });

    for (var m = 0; m < items.length; m++) {
      if (items[m].txVal > maxTxVal) maxTxVal = items[m].txVal;
      if (Math.abs(items[m].netVal) > maxAbsNet) maxAbsNet = Math.abs(items[m].netVal);
    }

    // Assign sizes, 3-tier colors, and animation presets with responsive density scaling
    for (var k = 0; k < items.length; k++) {
      var item = items[k];
      var sizeRatio = maxTxVal > 0 ? Math.sqrt(item.txVal / maxTxVal) : 0.5;
      // Proportional responsive scaling clamped between 44px-52px and 84px-98px
      var count = items.length;
      var minPx = count > 40 ? 44 : (count > 24 ? 48 : 52);
      var maxPx = count > 40 ? 84 : (count > 24 ? 92 : 98);
      var size = Math.round(minPx + sizeRatio * (maxPx - minPx));
      item.size = size;

      var ratio = isGross ? (maxTxVal > 0 ? (item.txVal / maxTxVal) : 0) : (maxAbsNet > 0 ? (Math.abs(item.netVal) / maxAbsNet) : 0);
      var tier = 1;
      if (ratio >= 0.55) {
        tier = 3;
      } else if (ratio >= 0.22) {
        tier = 2;
      }
      item.colorTier = tier;

      // Continuous float animation parameters
      item.floatId = (k % 4) + 1;
      item.floatDuration = (3.2 + (k % 5) * 0.4).toFixed(1);
      item.staggerDelay = (k * 0.03).toFixed(2);
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
      if (filterSide === 'buy') return isGross ? (b.side === 'buy' || b.isBuyer) : b.isNetBuyer;
      if (filterSide === 'sell') return isGross ? (b.side === 'sell' || !b.isBuyer) : !b.isNetBuyer;
      return true;
    });

    // If filterSide has no matches but brokers has items, fallback to 'all' so bubbles are never blocked
    if (visibleBrokers.length === 0 && brokers.length > 0 && filterSide !== 'all') {
      visibleBrokers = brokers;
      filterSide = 'all';
    }

    var buyerCount = brokers.filter(function (b) {
      return isGross ? (b.side === 'buy' || b.isBuyer) : b.isNetBuyer;
    }).length;
    var sellerCount = brokers.filter(function (b) {
      return isGross ? (b.side === 'sell' || !b.isBuyer) : !b.isNetBuyer;
    }).length;

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
    html += '  <div id="brokerBubbleClusterContainer" class="p-3 sm:p-4 bg-dark-900/60 rounded-xl border border-dark-600/40 min-h-[190px] flex flex-wrap items-center justify-center gap-2.5 sm:gap-3 relative overflow-hidden">';
    if (visibleBrokers.length === 0) {
      if (brokerFlowFilter !== 'all') {
        var flowLabel = brokerFlowFilter === 'F' ? 'Asing (Foreign)' : 'Domestik';
        var oppLabel = brokerFlowFilter === 'F' ? 'Domestik' : 'Asing';
        html += '    <div class="text-center py-8 px-4 text-xs">';
        html += '      <p class="font-semibold text-amber-300">Tidak ada broker ' + flowLabel + ' pada filter ini.</p>';
        html += '      <p class="text-[11px] text-gray-400 mt-1">Seluruh transaksi pada periode ini dicatatkan oleh broker ' + oppLabel + '.</p>';
        html += '      <button type="button" onclick="BandarmologiRuntime.setBrokerFlowFilter(\'all\')" class="mt-3 px-3 py-1.5 rounded-lg bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/40 text-xs font-semibold transition">Tampilkan Semua Broker</button>';
        html += '    </div>';
      } else {
        html += '    <div class="text-gray-500 text-xs py-8">Tidak ada broker pada filter ini.</div>';
      }
    } else {
      for (var i = 0; i < visibleBrokers.length; i++) {
        var b = visibleBrokers[i];
        var isBuyerBubble = isGross ? (b.side === 'buy' || b.isBuyer) : b.isNetBuyer;
        var isSelected = (b.broker === activeCode) && (!selectedBrokerSide || !b.side || b.side === selectedBrokerSide);
        var styleInfo = getBubbleColorStyles(isBuyerBubble, b.colorTier);
        var valText = isGross
          ? (b.side === 'sell' || !b.isBuyer ? ('-' + formatIDR(b.sval || b.txVal)) : ('+' + formatIDR(b.bval || b.txVal)))
          : ((b.netVal >= 0 ? '+' : '-') + formatIDR(Math.abs(b.netVal)));
        var subBadge = isGross
          ? (isBuyerBubble ? 'BUY' : 'SELL')
          : (b.size >= 76 ? (isBuyerBubble ? 'BUY' : 'SELL') : (b.netVal >= 0 ? '+' : '-'));

        var animString = isSelected
          ? 'none'
          : 'acBubbleFloat' + b.floatId + ' ' + b.floatDuration + 's ease-in-out infinite alternate, acBubblePopIn 0.45s cubic-bezier(0.34, 1.56, 0.64, 1) ' + b.staggerDelay + 's backwards';

        var bubbleKey = b.broker + (isGross ? ('-' + (b.side || (b.isBuyer ? 'buy' : 'sell'))) : '');

        html += '    <button type="button"';
        html += '      id="broker-bubble-' + escapeHtml(bubbleKey) + '"';
        html += '      class="ac-broker-bubble ' + (isSelected ? 'ac-bubble-selected' : '') + '"';
        html += '      data-broker="' + escapeHtml(b.broker) + '"';
        html += '      data-side="' + escapeHtml(b.side || (b.isBuyer ? 'buy' : 'sell')) + '"';
        html += '      onclick="BandarmologiRuntime.selectBrokerBubble(\'' + escapeHtml(b.broker) + '\', \'' + escapeHtml(b.side || (b.isBuyer ? 'buy' : 'sell')) + '\')"';
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
    var activeBroker = visibleBrokers.find(function (b) {
      return b.broker === activeCode && (!selectedBrokerSide || !b.side || b.side === selectedBrokerSide);
    }) || visibleBrokers.find(function (b) { return b.broker === activeCode; }) || visibleBrokers[0] || brokers[0] || null;
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

  function selectBrokerBubble(brokerCode, side) {
    selectedBrokerCode = String(brokerCode || '').trim().toUpperCase();
    selectedBrokerSide = String(side || '').trim().toLowerCase();

    // Fast inline DOM update to preserve bubble float animations
    var bubbles = document.querySelectorAll('.ac-broker-bubble');
    for (var i = 0; i < bubbles.length; i++) {
      var el = bubbles[i];
      var code = el.getAttribute('data-broker');
      var bSide = el.getAttribute('data-side') || '';
      var isMatch = (code === selectedBrokerCode) && (!selectedBrokerSide || !bSide || bSide === selectedBrokerSide);
      if (isMatch) {
        el.classList.add('ac-bubble-selected');
        el.style.animation = 'none';
      } else {
        el.classList.remove('ac-bubble-selected');
        // Restore float animation
        var match = lastBrokerItems.find(function (it) {
          return it.broker === code && (!bSide || !it.side || it.side === bSide);
        }) || lastBrokerItems.find(function (it) { return it.broker === code; });
        if (match) {
          el.style.animation = 'acBubbleFloat' + match.floatId + ' ' + match.floatDuration + 's ease-in-out infinite alternate';
        }
      }
    }

    var cardSlot = byId('brokerDetailCardSlot');
    if (cardSlot) {
      var broker = lastBrokerItems.find(function (b) {
        return b.broker === selectedBrokerCode && (!selectedBrokerSide || !b.side || b.side === selectedBrokerSide);
      }) || lastBrokerItems.find(function (b) { return b.broker === selectedBrokerCode; }) || null;
      cardSlot.innerHTML = renderBrokerDetailCardHtml(broker, brokerSummaryMode);
    } else {
      var container = byId('bandarmologiContent');
      if (container && lastBandarData) {
        renderBandarmologiUI(container, lastBandarData);
      }
    }
  }

  function setBandarSection(section) {
    bandarSection = (section === 'akumulasi' || section === 'intel' || section === 'network') ? section : 'summary';
    if (section === 'network') {
      if (typeof root.switchAnalisisTab === 'function') {
        var pInsider = byId('panel-tab-insider');
        if (!pInsider || pInsider.style.display !== 'block') {
          root.switchAnalisisTab('insider');
          return;
        }
      }
    }
    if (section === 'intel') {
      if (typeof root.switchAnalisisTab === 'function') {
        var pIntel = byId('panel-tab-intel');
        if (!pIntel || pIntel.style.display !== 'block') {
          root.switchAnalisisTab('intel');
          return;
        }
      }
    }
    var tabBandar = byId('tabBandarmologi');
    var tabIntel = byId('tabSinyalIntelijen');
    var tabAkumulasi = byId('tabAkumulasiBroker');
    if (tabBandar && tabIntel) {
      tabBandar.classList.toggle('active', bandarSection === 'summary' || bandarSection === 'akumulasi');
      tabBandar.setAttribute('aria-selected', (bandarSection === 'summary' || bandarSection === 'akumulasi') ? 'true' : 'false');
      tabIntel.classList.toggle('active', bandarSection === 'intel');
      tabIntel.setAttribute('aria-selected', bandarSection === 'intel' ? 'true' : 'false');
    } else if (tabBandar && tabAkumulasi) {
      tabBandar.classList.toggle('active', bandarSection === 'summary');
      tabBandar.setAttribute('aria-selected', bandarSection === 'summary' ? 'true' : 'false');
      tabAkumulasi.classList.toggle('active', bandarSection === 'akumulasi');
      tabAkumulasi.setAttribute('aria-selected', bandarSection === 'akumulasi' ? 'true' : 'false');
    }
    var subSum = byId('subTabBrokerSummary');
    var subAcc = byId('subTabAkumulasiBroker');
    var subIntel = byId('subTabIntelBandar');
    var subNet = byId('subTabJejaringInsider');
    if (subSum && subAcc) {
      subSum.className = 'px-3.5 py-1.5 rounded-lg transition flex items-center gap-1.5 ' + (bandarSection === 'summary' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium');
      subSum.setAttribute('aria-selected', bandarSection === 'summary' ? 'true' : 'false');
      subAcc.className = 'px-3.5 py-1.5 rounded-lg transition flex items-center gap-1.5 ' + (bandarSection === 'akumulasi' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium');
      subAcc.setAttribute('aria-selected', bandarSection === 'akumulasi' ? 'true' : 'false');
      if (subIntel) {
        subIntel.className = 'px-3.5 py-1.5 rounded-lg transition flex items-center gap-1.5 ' + (bandarSection === 'intel' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium');
        subIntel.setAttribute('aria-selected', bandarSection === 'intel' ? 'true' : 'false');
      }
      if (subNet) {
        subNet.className = 'px-3.5 py-1.5 rounded-lg transition flex items-center gap-1.5 ' + (bandarSection === 'network' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium');
        subNet.setAttribute('aria-selected', bandarSection === 'network' ? 'true' : 'false');
      }
    }
    var titleEl = byId('bandarPanelTitle');
    if (titleEl) {
      if (bandarSection === 'intel') {
        titleEl.textContent = 'Sinyal Intelijen Bandarmologi (4 Sinyal Strategis)';
      } else if (bandarSection === 'akumulasi') {
        titleEl.textContent = 'Akumulasi Broker & Deteksi Smart Money';
      } else if (bandarSection === 'network') {
        titleEl.textContent = 'Jejaring Relasi Insider & Pemegang Saham Multi-Emiten';
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

    if (bandarSection === 'intel') {
      var intelContainer = byId('bandarmologiIntelContent') || byId('bandarmologiContent');
      if (intelContainer) renderBandarmologiIntelUI(intelContainer, currentBandarTicker);
    } else if (bandarSection === 'network') {
      var netContainer = byId('insiderNetworkDedicatedContent') || byId('bandarmologiContent');
      if (netContainer) renderInsiderNetworkUI(netContainer, currentBandarTicker);
    } else {
      var bandarContainer = byId('bandarmologiContent');
      if (bandarContainer) {
        if (lastBandarData) {
          if (bandarSection === 'akumulasi') {
            var accObj = lastBandarData.broker_accumulation;
            if ((!accObj || ((!accObj.top_buyers || accObj.top_buyers.length === 0) && (!accObj.net_buyers || accObj.net_buyers.length === 0))) && lastBandarData.broker_summary) {
              lastBandarData.broker_accumulation = synthesizeAccumulationFromSummary(lastBandarData.broker_summary, currentBandarTicker);
            }
          }
          renderBandarmologiUI(bandarContainer, lastBandarData);
        } else if (typeof fetch !== 'undefined') {
          loadBandarmologiTab(currentBandarTicker);
        }
      }
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

  var VPS_DATA_API_BASE = (typeof window !== 'undefined' && (window.NEXT_PUBLIC_VPS_DATA_API || window.VPS_DATA_API_BASE)) || 'https://wishing-challenged-deeper-crown.trycloudflare.com';
  var vpsDatesMemoryCache = {};
  var vpsSummaryMemoryCache = {};

  async function fetchVpsAvailableDates(ticker) {
    if (!ticker) return [];
    var safeTicker = String(ticker).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (vpsDatesMemoryCache[safeTicker] && vpsDatesMemoryCache[safeTicker].length > 0) {
      return vpsDatesMemoryCache[safeTicker];
    }
    try {
      var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var timer = controller ? setTimeout(function () { controller.abort(); }, 5000) : null;
      var res = await fetch(VPS_DATA_API_BASE + '/api/available-dates?ticker=' + encodeURIComponent(safeTicker), controller ? { signal: controller.signal } : {});
      if (timer) clearTimeout(timer);
      if (res.ok) {
        var json = await res.json();
        if (json && Array.isArray(json.dates)) {
          var cleanDates = json.dates.filter(function (d) { return d && d !== 'latest'; });
          if (cleanDates.length > 0) {
            vpsDatesMemoryCache[safeTicker] = cleanDates;
            return cleanDates;
          }
        }
      }
    } catch (_) {}
    return [];
  }

  async function fetchVpsBrokerSummary(ticker, date) {
    if (!ticker) return null;
    var safeTicker = String(ticker).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    var safeDate = String(date || 'latest').trim();
    var cacheKey = safeTicker + '_' + safeDate;
    if (vpsSummaryMemoryCache[cacheKey]) {
      return vpsSummaryMemoryCache[cacheKey];
    }
    try {
      var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var timer = controller ? setTimeout(function () { controller.abort(); }, 6000) : null;
      var res = await fetch(VPS_DATA_API_BASE + '/api/broker-summary?ticker=' + encodeURIComponent(safeTicker) + '&date=' + encodeURIComponent(safeDate), controller ? { signal: controller.signal } : {});
      if (timer) clearTimeout(timer);
      if (res.ok) {
        var json = await res.json();
        if (json && (json.brokers || json.stock_code)) {
          vpsSummaryMemoryCache[cacheKey] = json;
          return json;
        }
      }
    } catch (_) {}
    return null;
  }

  function normalizeClientBrokerSummary(raw, date) {
    if (!raw) return null;
    if (Array.isArray(raw.top_buyers) && Array.isArray(raw.top_sellers)) {
      return raw;
    }
    var targetDate = raw.broker_start_date || raw.date || date || '';
    var brokersMap = {};
    if (Array.isArray(raw.brokers)) {
      for (var i = 0; i < raw.brokers.length; i++) {
        var b = raw.brokers[i];
        if (b && b.broker_code) {
          var bval = Number(b.bval || 0);
          var sval = Number(b.sval || 0);
          var bvol = Number(b.bvol || 0);
          var svol = Number(b.svol || 0);
          var nval = b.nval != null ? Number(b.nval) : (bval - sval);
          var nvol = b.nvol != null ? Number(b.nvol) : (bvol - svol);
          var bfrq = Number(b.bfrq || 0);
          var sfrq = Number(b.sfrq || 0);
          var avgPrice = 0;
          if (bval > 0 && bvol > 0) {
            avgPrice = Math.round(bval / bvol);
          } else if (sval > 0 && svol > 0) {
            avgPrice = Math.round(sval / svol);
          }
          if (avgPrice > 50000) avgPrice = Math.round(avgPrice / 100);

          brokersMap[b.broker_code] = {
            broker: b.broker_code,
            broker_name: b.broker_name || BROKER_NAMES[b.broker_code] || b.broker_code,
            bval: bval,
            sval: sval,
            bvol: bvol,
            svol: svol,
            bfrq: bfrq,
            sfrq: sfrq,
            nval: nval,
            nvol: nvol,
            avg_price: avgPrice,
            buy_val: bval,
            buy_vol: bvol,
            sell_val: sval,
            sell_vol: svol,
            net_val: nval,
            net_vol: nvol
          };
        }
      }
    }
    var all = Object.values(brokersMap);
    var grossBuyers = all.slice().sort(function (a, b) { return (b.bval || 0) - (a.bval || 0); });
    var grossSellers = all.slice().sort(function (a, b) { return (b.sval || 0) - (a.sval || 0); });
    var netBuyers = all.filter(function (x) { return (x.nval || 0) > 0; }).sort(function (a, b) { return b.nval - a.nval; });
    var netSellers = all.filter(function (x) { return (x.nval || 0) < 0; }).sort(function (a, b) { return Math.abs(b.nval) - Math.abs(a.nval); });

    var topBuyVal = netBuyers.slice(0, 5).reduce(function (sum, x) { return sum + (x.nval || 0); }, 0);
    var topSellVal = netSellers.slice(0, 5).reduce(function (sum, x) { return sum + Math.abs(x.nval || 0); }, 0);
    var diff = topBuyVal - topSellVal;
    var isAccumulation = diff >= 0;

    return {
      date: targetDate,
      stock_code: raw.stock_code || '',
      net_status: isAccumulation ? 'BIG_ACCUMULATION' : 'BIG_DISTRIBUTION',
      net_label: isAccumulation ? 'Big Accumulation' : 'Big Distribution',
      net_flow: diff,
      top_buyers: grossBuyers,
      top_sellers: grossSellers,
      gross_buyers: grossBuyers,
      gross_sellers: grossSellers,
      net_buyers: netBuyers,
      net_sellers: netSellers
    };
  }

  async function loadBandarmologiTab(ticker, date, range) {
    var clean = String(ticker || currentBandarTicker || 'BBCA').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!clean) clean = 'BBCA';
    if (clean !== currentBandarTicker) {
      brokerFlowFilter = 'all';
    }
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

    if (bandarSection === 'intel' || bandarSection === 'network') {
      bandarSection = 'summary';
    }

    container.innerHTML = '<div class="flex flex-col items-center justify-center py-12"><div class="spinner"></div><p class="text-xs text-gray-400 mt-3">Mengambil data Bandarmologi &amp; Insider ' + escapeHtml(clean) + '...</p></div>';

    try {
      // 1. Fetch available dates from VPS Tunnel in background
      var vpsDatesPromise = fetchVpsAvailableDates(clean);

      // 2. Fetch from backend API
      var url = '/api/sector-hot?action=bandarmologi&ticker=' + encodeURIComponent(clean);
      if (brokerFlowFilter === 'F' || brokerFlowFilter === 'D') {
        url += '&flow=' + encodeURIComponent(brokerFlowFilter);
      }
      if (brokerSummaryRange === 'custom' && customRangeStart && customRangeEnd) {
        url += '&range=custom&startDate=' + encodeURIComponent(customRangeStart) + '&endDate=' + encodeURIComponent(customRangeEnd);
      } else if (brokerSummaryRange && brokerSummaryRange !== '1d') {
        url += '&range=' + encodeURIComponent(brokerSummaryRange);
        var rangeDaysMap = { '1d': 1, '5d': 5, '7d': 7, '14d': 14, '30d': 30, '60d': 60 };
        var numDays = rangeDaysMap[brokerSummaryRange] || (parseInt(brokerSummaryRange, 10) || 1);
        url += '&days=' + numDays;
      } else if (currentBandarDate) {
        url += '&date=' + encodeURIComponent(currentBandarDate);
      }

      var data = null;
      try {
        var res = await fetch(url);
        data = await res.json();
      } catch (_) {}

      var vpsDates = await vpsDatesPromise;
      if (vpsDates && vpsDates.length > 0) {
        if (!data || !Array.isArray(data.available_dates) || data.available_dates.length === 0) {
          if (!data) data = { success: true, ticker: clean };
          data.available_dates = vpsDates;
        } else {
          var seenDates = {};
          var combinedDates = [];
          for (var di = 0; di < data.available_dates.length; di++) {
            var d1 = data.available_dates[di];
            if (!seenDates[d1]) { seenDates[d1] = true; combinedDates.push(d1); }
          }
          for (var dj = 0; dj < vpsDates.length; dj++) {
            var d2 = vpsDates[dj];
            if (!seenDates[d2]) { seenDates[d2] = true; combinedDates.push(d2); }
          }
          data.available_dates = combinedDates.sort().reverse();
        }
      }

      // 3. If backend returned demo or empty or error, fetch directly from VPS Tunnel (0 byte local disk)
      if (!data || !data.success || data.is_demo || !data.broker_summary || !data.broker_summary.top_buyers || data.broker_summary.top_buyers.length === 0) {
        var targetDateToFetch = currentBandarDate || (vpsDates && vpsDates[0]) || 'latest';
        var directVpsRaw = await fetchVpsBrokerSummary(clean, targetDateToFetch);
        if (directVpsRaw) {
          var clientNormSummary = normalizeClientBrokerSummary(directVpsRaw, targetDateToFetch);
          if (clientNormSummary) {
            var clientAcc = {
              top_buyers: clientNormSummary.net_buyers || clientNormSummary.top_buyers,
              top_sellers: clientNormSummary.net_sellers || clientNormSummary.top_sellers,
              series: []
            };
            data = {
              success: true,
              is_demo: false,
              from_vps_tunnel: true,
              ticker: clean,
              date: clientNormSummary.date || targetDateToFetch,
              range: brokerSummaryRange || '1d',
              available_dates: (data && data.available_dates && data.available_dates.length > 0) ? data.available_dates : vpsDates,
              broker_summary: clientNormSummary,
              broker_accumulation: clientAcc,
              insiders: (data && data.insiders) || []
            };
          }
        }
      }

      if (!data || !data.success) {
        container.innerHTML = '<div class="p-6 text-center text-rose-400 text-xs">Gagal memuat data bandarmologi: ' + escapeHtml((data && data.error) || 'Koneksi ke data bursa terputus.') + '</div>';
        return;
      }

      renderBandarmologiUI(container, data);
    } catch (err) {
      container.innerHTML = '<div class="p-6 text-center text-rose-400 text-xs">Error memuat data bandarmologi: ' + escapeHtml(err.message || String(err)) + '</div>';
    }
  }

  function renderBrokerSummaryTableHtml(buyersOrData, sellersOrIsGross, isGrossArg, modeArg) {
    try {
      var buyers = [];
      var sellers = [];
      var isGross = false;
      var mode = 'net';

      if (buyersOrData && typeof buyersOrData === 'object' && !Array.isArray(buyersOrData)) {
        buyers = Array.isArray(buyersOrData.buyers) ? buyersOrData.buyers : (Array.isArray(buyersOrData.top_buyers) ? buyersOrData.top_buyers : (Array.isArray(buyersOrData.net_buyers) ? buyersOrData.net_buyers : []));
        sellers = Array.isArray(buyersOrData.sellers) ? buyersOrData.sellers : (Array.isArray(buyersOrData.top_sellers) ? buyersOrData.top_sellers : (Array.isArray(buyersOrData.net_sellers) ? buyersOrData.net_sellers : []));
        isGross = Boolean(sellersOrIsGross !== undefined ? sellersOrIsGross : (buyersOrData.isGross || buyersOrData.mode === 'gross'));
        mode = modeArg || buyersOrData.mode || (isGross ? 'gross' : 'net');
      } else {
        buyers = Array.isArray(buyersOrData) ? buyersOrData : [];
        if (Array.isArray(sellersOrIsGross)) {
          sellers = sellersOrIsGross;
          isGross = Boolean(isGrossArg);
          mode = modeArg || (isGross ? 'gross' : 'net');
        } else {
          sellers = [];
          isGross = Boolean(sellersOrIsGross);
          mode = isGrossArg || (isGross ? 'gross' : 'net');
        }
      }

      var html = '';
      html += '  <div class="grid grid-cols-1 md:grid-cols-2 gap-3">';

      // Top Buyers
      html += '    <div class="bg-dark-700/40 border border-dark-600/30 rounded-xl p-3 overflow-hidden">';
      html += '      <div class="text-[11px] font-bold text-emerald-400 mb-2 flex items-center justify-between pb-1.5 border-b border-dark-600/40 sticky top-0 bg-slate-900 z-10 p-1" style="position: sticky; top: 0; z-index: 10; background-color: #0f172a;">';
      html += '        <span>🟢 TOP BUYERS (' + (isGross ? 'FULL / GROSS' : 'NET VALUE &amp; VOL') + ') — ' + buyers.length + ' Broker</span>';
      html += '        <span class="text-[10px] text-gray-400 font-mono">' + (isGross ? 'BUY &amp; SELL VAL' : 'NET VAL') + '</span>';
      html += '      </div>';
      html += '      <div class="overflow-y-auto overflow-x-auto pr-1" style="max-height: 480px; overflow-y: auto; overflow-x: auto;">';
      if (buyers.length === 0) {
        html += '        <div class="text-gray-500 text-center py-6 text-xs">Tidak ada data buyer</div>';
      } else {
        html += '        <table class="w-full text-xs text-left border-collapse">';
        html += '          <thead class="sticky top-0 bg-slate-900 z-10 text-[10px] text-gray-400 font-mono border-b border-dark-600/40" style="position: sticky; top: 0; z-index: 10; background-color: #0f172a;">';
        html += '            <tr>';
        html += '              <th class="py-2 px-2 text-center w-7">#</th>';
        html += '              <th class="py-2 px-2">Broker</th>';
        html += '              <th class="py-2 px-2 text-right">Avg</th>';
        if (isGross) {
          html += '              <th class="py-2 px-2 text-right">B.Vol</th>';
          html += '              <th class="py-2 px-2 text-right">B.Val</th>';
          html += '              <th class="py-2 px-2 text-right">S.Val</th>';
          html += '              <th class="py-2 px-2 text-right">Net</th>';
        } else {
          html += '              <th class="py-2 px-2 text-right">Net Vol</th>';
          html += '              <th class="py-2 px-2 text-right">Net Val</th>';
        }
        html += '            </tr>';
        html += '          </thead>';
        html += '          <tbody class="divide-y divide-dark-600/20">';
        for (var b = 0; b < buyers.length; b++) {
          var item = buyers[b];
          var buyVol = item.bvol != null ? item.bvol : (item.buy_vol || item.vol || item.volume || 0);
          var sellVol = item.svol != null ? item.svol : (item.sell_vol || 0);
          var buyVal = normalizeBrokerValue(item.bval != null ? item.bval : (item.buy_val || item.net_val || item.val || item.value || 0), buyVol, item.avg_price);
          var sellVal = normalizeBrokerValue(item.sval != null ? item.sval : (item.sell_val || 0), sellVol, item.avg_price);
          var netVal = normalizeBrokerValue(item.nval != null ? item.nval : (item.net_val != null ? item.net_val : (buyVal - sellVal)));
          if (netVal < 0 && (buyVal > sellVol || sellVol === 0)) {
            netVal = Math.abs(netVal);
          }
          var netVol = item.nvol != null ? item.nvol : (item.net_vol != null ? item.net_vol : (buyVol - sellVol));
          if (netVol < 0 && (buyVol > sellVol || sellVol === 0)) {
            netVol = Math.abs(netVol);
          }

          html += '            <tr class="hover:bg-dark-600/20 transition">';
          html += '              <td class="py-2 px-2 text-center font-mono text-[10px] text-gray-500">' + (b + 1) + '</td>';
          html += '              <td class="py-2 px-2 whitespace-nowrap">';
          html += '                <span class="font-bold font-mono text-emerald-300 px-1.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/30 text-xs">' + escapeHtml(item.broker) + '</span>';
          if (item.broker_name) {
            html += '                <span class="text-gray-400 text-[10px] ml-1.5 truncate max-w-[100px] inline-block align-middle" title="' + escapeHtml(item.broker_name) + '">' + escapeHtml(item.broker_name) + '</span>';
          }
          html += '              </td>';
          html += '              <td class="py-2 px-2 text-right font-mono text-gray-300 text-[11px]">' + (item.avg_price ? formatNumber(item.avg_price) : '—') + '</td>';
          if (isGross) {
            html += '              <td class="py-2 px-2 text-right font-mono text-gray-300 text-[11px]">' + formatNumber(buyVol) + '</td>';
            html += '              <td class="py-2 px-2 text-right font-mono text-emerald-400 font-bold text-[11px]">+' + formatIDR(buyVal) + '</td>';
            html += '              <td class="py-2 px-2 text-right font-mono text-rose-400/80 text-[11px]">' + (sellVal > 0 ? '-' + formatIDR(sellVal) : '0') + '</td>';
            html += '              <td class="py-2 px-2 text-right font-mono font-bold text-[11px] ' + (netVal >= 0 ? 'text-emerald-400' : 'text-rose-400') + '">' + (netVal >= 0 ? '+' : '') + formatIDR(netVal) + '</td>';
          } else {
            html += '              <td class="py-2 px-2 text-right font-mono text-emerald-300 font-semibold text-[11px]">+' + formatNumber(netVol) + '</td>';
            html += '              <td class="py-2 px-2 text-right font-mono text-emerald-400 font-bold text-[11px]">+' + formatIDR(netVal) + '</td>';
          }
          html += '            </tr>';
        }
        html += '          </tbody>';
        html += '        </table>';
      }
      html += '      </div>';
      html += '    </div>';

      // Top Sellers
      html += '    <div class="bg-dark-700/40 border border-dark-600/30 rounded-xl p-3 overflow-hidden">';
      html += '      <div class="text-[11px] font-bold text-rose-400 mb-2 flex items-center justify-between pb-1.5 border-b border-dark-600/40 sticky top-0 bg-slate-900 z-10 p-1" style="position: sticky; top: 0; z-index: 10; background-color: #0f172a;">';
      html += '        <span>🔴 TOP SELLERS (' + (isGross ? 'FULL / GROSS' : 'NET VALUE &amp; VOL') + ') — ' + sellers.length + ' Broker</span>';
      html += '        <span class="text-[10px] text-gray-400 font-mono">' + (isGross ? 'SELL &amp; BUY VAL' : 'NET VAL') + '</span>';
      html += '      </div>';
      html += '      <div class="overflow-y-auto overflow-x-auto pr-1" style="max-height: 480px; overflow-y: auto; overflow-x: auto;">';
      if (sellers.length === 0) {
        html += '        <div class="text-gray-500 text-center py-6 text-xs">Tidak ada data seller</div>';
      } else {
        html += '        <table class="w-full text-xs text-left border-collapse">';
        html += '          <thead class="sticky top-0 bg-slate-900 z-10 text-[10px] text-gray-400 font-mono border-b border-dark-600/40" style="position: sticky; top: 0; z-index: 10; background-color: #0f172a;">';
        html += '            <tr>';
        html += '              <th class="py-2 px-2 text-center w-7">#</th>';
        html += '              <th class="py-2 px-2">Broker</th>';
        html += '              <th class="py-2 px-2 text-right">Avg</th>';
        if (isGross) {
          html += '              <th class="py-2 px-2 text-right">S.Vol</th>';
          html += '              <th class="py-2 px-2 text-right">S.Val</th>';
          html += '              <th class="py-2 px-2 text-right">B.Val</th>';
          html += '              <th class="py-2 px-2 text-right">Net</th>';
        } else {
          html += '              <th class="py-2 px-2 text-right">Net Vol</th>';
          html += '              <th class="py-2 px-2 text-right">Net Val</th>';
        }
        html += '            </tr>';
        html += '          </thead>';
        html += '          <tbody class="divide-y divide-dark-600/20">';
        for (var s = 0; s < sellers.length; s++) {
          var sItem = sellers[s];
          var sBuyVol = sItem.bvol != null ? sItem.bvol : (sItem.buy_vol || 0);
          var sSellVol = sItem.svol != null ? sItem.svol : (sItem.sell_vol || Math.abs(sItem.net_vol || sItem.vol || sItem.volume || 0));
          var sBuyVal = normalizeBrokerValue(sItem.bval != null ? sItem.bval : (sItem.buy_val || 0), sBuyVol, sItem.avg_price);
          var sSellVal = normalizeBrokerValue(sItem.sval != null ? sItem.sval : (sItem.sell_val || Math.abs(sItem.net_val || sItem.val || sItem.value || 0)), sSellVol, sItem.avg_price);
          var sNetVal = normalizeBrokerValue(sItem.nval != null ? sItem.nval : (sItem.net_val != null ? sItem.net_val : (sBuyVal - sSellVal)));
          if (sNetVal > 0 && (sSellVal > sBuyVal || sBuyVal === 0)) {
            sNetVal = -Math.abs(sNetVal);
          }
          var sNetVol = sItem.nvol != null ? sItem.nvol : (sItem.net_vol != null ? sItem.net_vol : (sBuyVol - sSellVol));
          if (sNetVol > 0 && (sSellVal > sBuyVol || sBuyVal === 0)) {
            sNetVol = -Math.abs(sNetVol);
          }

          html += '            <tr class="hover:bg-dark-600/20 transition">';
          html += '              <td class="py-2 px-2 text-center font-mono text-[10px] text-gray-500">' + (s + 1) + '</td>';
          html += '              <td class="py-2 px-2 whitespace-nowrap">';
          html += '                <span class="font-bold font-mono text-rose-300 px-1.5 py-0.5 rounded bg-rose-500/10 border border-rose-500/30 text-xs">' + escapeHtml(sItem.broker) + '</span>';
          if (sItem.broker_name) {
            html += '                <span class="text-gray-400 text-[10px] ml-1.5 truncate max-w-[100px] inline-block align-middle" title="' + escapeHtml(sItem.broker_name) + '">' + escapeHtml(sItem.broker_name) + '</span>';
          }
          html += '              </td>';
          html += '              <td class="py-2 px-2 text-right font-mono text-gray-300 text-[11px]">' + (sItem.avg_price ? formatNumber(sItem.avg_price) : '—') + '</td>';
          if (isGross) {
            html += '              <td class="py-2 px-2 text-right font-mono text-gray-300 text-[11px]">' + formatNumber(sSellVol) + '</td>';
            html += '              <td class="py-2 px-2 text-right font-mono text-rose-400 font-bold text-[11px]">-' + formatIDR(sSellVal) + '</td>';
            html += '              <td class="py-2 px-2 text-right font-mono text-emerald-400/80 text-[11px]">' + (sBuyVal > 0 ? '+' + formatIDR(sBuyVal) : '0') + '</td>';
            html += '              <td class="py-2 px-2 text-right font-mono font-bold text-[11px] ' + (sNetVal >= 0 ? 'text-emerald-400' : 'text-rose-400') + '">' + (sNetVal >= 0 ? '+' : '') + formatIDR(sNetVal) + '</td>';
          } else {
            html += '              <td class="py-2 px-2 text-right font-mono text-rose-300 font-semibold text-[11px]">-' + formatNumber(Math.abs(sNetVol)) + '</td>';
            html += '              <td class="py-2 px-2 text-right font-mono text-rose-400 font-bold text-[11px]">-' + formatIDR(Math.abs(sNetVal)) + '</td>';
          }
          html += '            </tr>';
        }
        html += '          </tbody>';
        html += '        </table>';
      }
      html += '      </div>';
      html += '    </div>';

      html += '  </div>';
      return html;
    } catch (err) {
      console.error('Error rendering broker summary table:', err);
      return '<div class="text-rose-400 p-4 text-xs bg-rose-500/10 rounded-lg">Gagal merender tabel broker summary.</div>';
    }
  }

  function renderBandarmologiUI(container, data) {
    lastBandarData = data;
    if (bandarSection === 'network') {
      renderInsiderNetworkUI(container, data);
      return;
    }
    if (bandarSection === 'intel') {
      renderBandarmologiIntelUI(container, data);
      return;
    }
    injectBubbleStyles();

    var ticker = data.ticker || currentBandarTicker;
    if (data && data.ticker) currentBandarTicker = data.ticker;
    var bSum = data.broker_summary || {};
    var bAcc = data.broker_accumulation || {};
    if ((!bAcc.top_buyers || bAcc.top_buyers.length === 0) && (!bAcc.net_buyers || bAcc.net_buyers.length === 0) && bSum && (bSum.top_buyers || bSum.gross_buyers || bSum.net_buyers)) {
      bAcc = synthesizeAccumulationFromSummary(bSum, ticker);
      data.broker_accumulation = bAcc;
    }
    var insiders = Array.isArray(data.insiders) ? data.insiders : [];

    var DEMO_REASON_LABEL = {
      no_api_key: 'Data Demo — API key belum dikonfigurasi',
      no_disk_cache: 'Data Demo — belum ada data tersimpan untuk ticker ini',
      quota_exceeded: 'Data Demo — kuota API harian habis',
      api_error: 'Data Demo — API sedang tidak tersedia',
      network_error: 'Data Demo — koneksi ke API gagal'
    };
    var isDemoBadge = (data.is_demo && !data.from_disk && !data.from_vps_tunnel)
      ? '<span class="text-[10px] px-2 py-0.5 rounded bg-amber-500/10 border border-amber-500/30 text-amber-300 font-mono" title="' + escapeHtml(data.demo_detail || '') + '">' + escapeHtml(DEMO_REASON_LABEL[data.demo_reason] || 'DEMO PREVIEW — data bukan dari sumber live') + '</span>'
      : (data.from_vps_tunnel
          ? '<span class="text-[10px] px-2 py-0.5 rounded bg-blue-500/10 border border-blue-500/30 text-blue-300 font-mono">VPS TUNNEL LIVE</span>'
          : '<span class="text-[10px] px-2 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 font-mono">LIVE / BACKFILL</span>');

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

    // For multi-day ranges (7D/30D/custom), prefer per-day date_headers from broker_summary
    // so the "Riwayat Harian" table and bar chart display distinct data per trading day.
    var series;
    if (Array.isArray(bSum.date_headers) && bSum.date_headers.length > 0) {
      series = bSum.date_headers;
    } else {
      series = bAcc.series || [];
    }
    var availableDates = Array.isArray(data.available_dates) && data.available_dates.length > 0
      ? data.available_dates
      : series.map(function (s) { return s.date; }).filter(Boolean).reverse();

    // Quick date pills and full date dropdown in header if available
    var quickDates = availableDates.slice(0, 8);
    if (quickDates.length > 0) {
      html += '<div class="flex flex-wrap items-center gap-1.5 mb-3">';
      html += '  <span class="text-[11px] text-gray-400 mr-1">Pilih Tanggal:</span>';
      for (var qd = 0; qd < quickDates.length; qd++) {
        var dt = quickDates[qd];
        var isCurrent = dt === (bSum.date || currentBandarDate);
        var pillStyle = isCurrent
          ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40 font-bold'
          : 'bg-dark-700 text-gray-300 border-dark-600/60 hover:bg-dark-600 hover:text-white';
        html += '  <button type="button" onclick="BandarmologiRuntime.loadBandarmologiTab(null, \'' + escapeHtml(dt) + '\')" class="px-2 py-0.5 text-[11px] rounded-md border font-mono transition ' + pillStyle + '">' + escapeHtml(dt) + '</button>';
      }
      if (availableDates.length > 8) {
        html += '  <select onchange="BandarmologiRuntime.loadBandarmologiTab(null, this.value)" class="px-2 py-0.5 text-[11px] rounded-md border border-dark-600/60 bg-dark-700 text-gray-200 font-mono transition cursor-pointer hover:bg-dark-600">';
        html += '    <option value="" disabled' + (!currentBandarDate || quickDates.indexOf(currentBandarDate) >= 0 ? ' selected' : '') + '>Semua Tanggal (' + availableDates.length + ')...</option>';
        for (var ad = 0; ad < availableDates.length; ad++) {
          var aDt = availableDates[ad];
          html += '    <option value="' + escapeHtml(aDt) + '"' + (aDt === (bSum.date || currentBandarDate) ? ' selected' : '') + '>' + escapeHtml(aDt) + '</option>';
        }
        html += '  </select>';
      }
      html += '</div>';
    }

    // SECTION TABS: Only render inline switcher if external subTabBrokerSummary is absent
    var isSummarySection = bandarSection === 'summary';
    if (!byId('subTabBrokerSummary')) {
      html += '<div class="flex items-center gap-1 bg-dark-800 p-0.5 rounded-lg border border-dark-600/50 text-xs mb-4 w-fit">';
      html += '  <button type="button" onclick="BandarmologiRuntime.setBandarSection(\'summary\')" class="px-3 py-1.5 rounded-md transition ' + (bandarSection === 'summary' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium') + '">📊 Broker Summary</button>';
      html += '  <button type="button" onclick="BandarmologiRuntime.setBandarSection(\'akumulasi\')" class="px-3 py-1.5 rounded-md transition ' + (bandarSection === 'akumulasi' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium') + '">📈 Akumulasi Broker</button>';
      html += '  <button type="button" onclick="BandarmologiRuntime.setBandarSection(\'intel\')" class="px-3 py-1.5 rounded-md transition ' + (bandarSection === 'intel' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium') + '">🎯 Sinyal Intelijen</button>';
      html += '  <button type="button" onclick="BandarmologiRuntime.setBandarSection(\'network\')" class="px-3 py-1.5 rounded-md transition ' + (bandarSection === 'network' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium') + '">🕸️ Jejaring Insider</button>';
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
    // Rentang Selector (1D, 5D, 7D, 14D, 30D, 60D, Custom)
    var r1Class = brokerSummaryRange === '1d' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium';
    var r5Class = brokerSummaryRange === '5d' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium';
    var r7Class = brokerSummaryRange === '7d' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium';
    var r14Class = brokerSummaryRange === '14d' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium';
    var r30Class = brokerSummaryRange === '30d' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium';
    var r60Class = brokerSummaryRange === '60d' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium';
    var rCustomClass = brokerSummaryRange === 'custom' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium';
    html += '      <div class="flex flex-wrap items-center gap-1 bg-dark-800 p-0.5 rounded-lg border border-dark-600/50 text-[11px]">';
    html += '        <span class="text-[10px] text-gray-400 font-medium px-1.5 uppercase tracking-wider">Rentang:</span>';
    html += '        <button type="button" id="toggleRange1d" onclick="BandarmologiRuntime.setBrokerSummaryRange(\'1d\')" class="px-2 py-1 rounded-md transition ' + r1Class + '">1D</button>';
    html += '        <button type="button" id="toggleRange5d" onclick="BandarmologiRuntime.setBrokerSummaryRange(\'5d\')" class="px-2 py-1 rounded-md transition ' + r5Class + '">5D</button>';
    html += '        <button type="button" id="toggleRange7d" onclick="BandarmologiRuntime.setBrokerSummaryRange(\'7d\')" class="px-2 py-1 rounded-md transition ' + r7Class + '">7D</button>';
    html += '        <button type="button" id="toggleRange14d" onclick="BandarmologiRuntime.setBrokerSummaryRange(\'14d\')" class="px-2 py-1 rounded-md transition ' + r14Class + '">14D</button>';
    html += '        <button type="button" id="toggleRange30d" onclick="BandarmologiRuntime.setBrokerSummaryRange(\'30d\')" class="px-2 py-1 rounded-md transition ' + r30Class + '">30D</button>';
    html += '        <button type="button" id="toggleRange60d" onclick="BandarmologiRuntime.setBrokerSummaryRange(\'60d\')" class="px-2 py-1 rounded-md transition ' + r60Class + '">60D</button>';
    html += '        <button type="button" id="toggleRangeCustom" onclick="BandarmologiRuntime.setBrokerSummaryRange(\'custom\')" class="px-2 py-1 rounded-md transition ' + rCustomClass + '">📅 Custom</button>';
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
      ? firstNonEmptyList(bSum.gross_buyers, bSum.top_buyers, bSum.buyers)
      : firstNonEmptyList(bSum.net_buyers, bSum.gross_buyers, bSum.top_buyers, bSum.buyers);
    var rawSellers = isGross
      ? firstNonEmptyList(bSum.gross_sellers, bSum.top_sellers, bSum.sellers)
      : firstNonEmptyList(bSum.net_sellers, bSum.gross_sellers, bSum.top_sellers, bSum.sellers);

    // Fallback: if rawSellers is still empty, ensure it falls back to bSum.gross_sellers
    if ((!rawSellers || rawSellers.length === 0) && bSum.gross_sellers && bSum.gross_sellers.length > 0) {
      rawSellers = bSum.gross_sellers;
    }

    // Partition guard: if rawSellers is empty or rawBuyers has seller items
    if ((!rawSellers || rawSellers.length === 0) && rawBuyers && rawBuyers.length > 0) {
      var pbList = [];
      var psList = [];
      for (var pbi = 0; pbi < rawBuyers.length; pbi++) {
        var pIt = rawBuyers[pbi];
        var pNet = pIt.nval != null ? pIt.nval : (pIt.net_val != null ? pIt.net_val : ((pIt.bval || pIt.buy_val || 0) - (pIt.sval || pIt.sell_val || 0)));
        if (pNet < 0 || ((pIt.sval || pIt.sell_val || 0) > (pIt.bval || pIt.buy_val || 0))) {
          psList.push(pIt);
        } else {
          pbList.push(pIt);
        }
      }
      if (psList.length > 0) {
        rawBuyers = pbList;
        rawSellers = psList;
      } else {
        var withSell = rawBuyers.filter(function (b) { return (b.sval || b.sell_val || 0) > 0; });
        if (withSell.length > 0) {
          rawSellers = withSell;
        }
      }
    }

    var buyers = filterBrokersByFlow(rawBuyers, brokerFlowFilter);
    var sellers = filterBrokersByFlow(rawSellers, brokerFlowFilter);

    lastBrokerItems = buildBrokerBubbleItems(buyers, sellers, brokerSummaryMode);

    if (isBubbleView) {
      // Ensure selectedBrokerCode is valid
      if (!selectedBrokerCode || !lastBrokerItems.some(function (it) { return it.broker === selectedBrokerCode; })) {
        selectedBrokerCode = lastBrokerItems.length > 0 ? lastBrokerItems[0].broker : '';
        selectedBrokerSide = lastBrokerItems.length > 0 ? (lastBrokerItems[0].side || '') : '';
      }
      html += renderBrokerBubbleClusterHtml(lastBrokerItems, selectedBrokerCode, brokerSummaryMode, bubbleFilterSide);
    } else {
      // TABLE VIEW
      html += renderBrokerSummaryTableHtml(buyers, sellers, isGross, brokerSummaryMode);
    }
    html += '</div>';
    } else {
    // 2. DASHBOARD KONSISTENSI BANDAR (Restructured Sub-Tab Akumulasi Broker)
    html += '<div class="mb-5 space-y-4">';

    // 2A. Header & Controls: Range Selector + Flow Filter
    html += '  <div class="flex flex-wrap items-center justify-between gap-2.5 pb-2 border-b border-dark-600/40">';
    var accHeadingDate = bSum.range_label || (bSum.date ? 'Rentang: ' + bSum.date : (currentBandarDate ? 'Tanggal: ' + currentBandarDate : 'Historis'));
    html += '    <div>';
    html += '      <h3 class="text-xs font-bold text-gray-200 flex items-center gap-1.5"><span class="text-sm">🎯</span> Dashboard Konsistensi Bandar — <span class="text-emerald-400 font-mono">' + escapeHtml(accHeadingDate) + '</span></h3>';
    html += '      <p class="text-[11px] text-gray-400 mt-0.5">Analisis konsentrasi modal, rasio partisipasi bandar vs ritel, dan konsistensi arah akumulasi/distribusi.</p>';
    html += '    </div>';

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

    // Toggle Tampilan (Visual Bubble / Tabel Rinci)
    var accBubbleClass = brokerAccumulationView === 'bubble' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium';
    var accTableClass = brokerAccumulationView === 'table' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium';
    html += '      <div class="flex items-center gap-1 bg-dark-800 p-0.5 rounded-lg border border-dark-600/50 text-[11px]">';
    html += '        <span class="text-[10px] text-gray-400 font-medium px-1.5 uppercase tracking-wider">Tampilan:</span>';
    html += '        <button type="button" id="toggleAccViewBubble" onclick="BandarmologiRuntime.setBrokerAccumulationView(\'bubble\')" class="px-2.5 py-1 rounded-md transition ' + accBubbleClass + '">Visual Bubble</button>';
    html += '        <button type="button" id="toggleAccViewTable" onclick="BandarmologiRuntime.setBrokerAccumulationView(\'table\')" class="px-2.5 py-1 rounded-md transition ' + accTableClass + '">Tabel Rinci</button>';
    html += '      </div>';
    html += '    </div>';
    html += '  </div>';

    // 2B. Card Indikator Dominasi (CR3, CR5, Status Dominasi, Rasio Partisipasi Bandar vs Ritel)
    var allBuyersList = firstNonEmptyList(bSum.net_buyers, bSum.gross_buyers, bSum.top_buyers, bSum.buyers) || [];
    var totalBuyerVal = 0;
    for (var bi = 0; bi < allBuyersList.length; bi++) {
      totalBuyerVal += Number(allBuyersList[bi].bval || allBuyersList[bi].buy_val || allBuyersList[bi].val || (allBuyersList[bi].nval > 0 ? allBuyersList[bi].nval : 0) || 0);
    }
    var top3Val = 0;
    for (var t3 = 0; t3 < Math.min(3, allBuyersList.length); t3++) {
      top3Val += Number(allBuyersList[t3].bval || allBuyersList[t3].buy_val || allBuyersList[t3].val || (allBuyersList[t3].nval > 0 ? allBuyersList[t3].nval : 0) || 0);
    }
    var top5Val = 0;
    for (var t5 = 0; t5 < Math.min(5, allBuyersList.length); t5++) {
      top5Val += Number(allBuyersList[t5].bval || allBuyersList[t5].buy_val || allBuyersList[t5].val || (allBuyersList[t5].nval > 0 ? allBuyersList[t5].nval : 0) || 0);
    }

    var cr3 = totalBuyerVal > 0 ? Math.min(100, Math.round((top3Val / totalBuyerVal) * 100)) : (allBuyersList.length > 0 ? 55 : 0);
    var cr5 = totalBuyerVal > 0 ? Math.min(100, Math.round((top5Val / totalBuyerVal) * 100)) : (allBuyersList.length > 0 ? 72 : 0);

    // Dominasi classification
    var domStatus = 'Concentrated';
    var domBadge = '<span class="px-2.5 py-1 rounded-lg bg-sky-500/20 text-sky-300 border border-sky-500/40 font-bold text-xs">🎯 Concentrated (Terkonsentrasi Sehat)</span>';
    var domDesc = 'Top 3 broker menguasai ' + cr3 + '% total volume beli. Aliran likuiditas terkonsentrasi terarah pada beberapa pelaku pasar dominan.';
    if (cr3 >= 60) {
      domStatus = 'Monopolistic';
      domBadge = '<span class="px-2.5 py-1 rounded-lg bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-bold text-xs">👑 Monopolistic (Sangat Terkonsentrasi)</span>';
      domDesc = 'Top 3 broker menguasai ' + cr3 + '% total pembelian. Kekuatan akumulasi sangat solid dan dikendalikan oleh bandar utama.';
    } else if (cr3 < 40) {
      domStatus = 'Distributed';
      domBadge = '<span class="px-2.5 py-1 rounded-lg bg-amber-500/20 text-amber-300 border border-amber-500/40 font-bold text-xs">🌊 Distributed (Menyebar / Dominasi Ritel)</span>';
      domDesc = 'Top 3 broker hanya menguasai ' + cr3 + '%. Kepemilikan dan transaksi menyebar ke banyak broker ritel tanpa kepemimpinan bandar yang jelas.';
    }

    // Retail vs Bandar Participation
    var retailCodes = ['YP', 'XL', 'XC', 'PD', 'NI', 'SQ', 'CC'];
    var retailVal = 0;
    for (var ri = 0; ri < allBuyersList.length; ri++) {
      var bCode = allBuyersList[ri].broker || allBuyersList[ri].broker_code || '';
      if (retailCodes.includes(bCode)) {
        retailVal += Number(allBuyersList[ri].bval || allBuyersList[ri].buy_val || allBuyersList[ri].val || 0);
      }
    }
    var bandarVal = Math.max(0, totalBuyerVal - retailVal);
    var bandarPct = totalBuyerVal > 0 ? Math.round((bandarVal / totalBuyerVal) * 100) : 65;
    var retailPct = 100 - bandarPct;

    html += '  <div class="grid grid-cols-1 md:grid-cols-3 gap-2.5">';
    // Card 1: Concentration Ratios
    html += '    <div class="bg-dark-800/80 border border-dark-600/40 rounded-xl p-3 flex flex-col justify-between shadow-sm">';
    html += '      <div class="flex items-center justify-between mb-1.5">';
    html += '        <span class="text-xs font-bold text-gray-200">Concentration Ratio (CR)</span>';
    html += '        <span class="text-[10px] text-gray-400 font-mono">Berdasarkan Volume/Nilai Beli</span>';
    html += '      </div>';
    html += '      <div class="grid grid-cols-2 gap-2 my-1.5">';
    html += '        <div class="bg-dark-900/60 p-2 rounded-lg border border-dark-600/30 text-center">';
    html += '          <span class="text-[10px] text-gray-400 block uppercase font-semibold">CR3 (Top 3)</span>';
    html += '          <span class="text-xl font-bold font-mono text-emerald-400">' + cr3 + '%</span>';
    html += '        </div>';
    html += '        <div class="bg-dark-900/60 p-2 rounded-lg border border-dark-600/30 text-center">';
    html += '          <span class="text-[10px] text-gray-400 block uppercase font-semibold">CR5 (Top 5)</span>';
    html += '          <span class="text-xl font-bold font-mono text-sky-400">' + cr5 + '%</span>';
    html += '        </div>';
    html += '      </div>';
    html += '      <p class="text-[10px] text-gray-400 leading-tight">Semakin tinggi CR3 & CR5, semakin terkonsentrasi kontrol akumulasi saham di tangan segelintir broker.</p>';
    html += '    </div>';

    // Card 2: Status Dominasi Bandar
    html += '    <div class="bg-dark-800/80 border border-dark-600/40 rounded-xl p-3 flex flex-col justify-between shadow-sm">';
    html += '      <div class="flex items-center justify-between mb-1.5">';
    html += '        <span class="text-xs font-bold text-gray-200">Status Dominasi Pasar</span>';
    html += '        <span class="text-[10px] text-emerald-400 font-mono">Real-Time Metric</span>';
    html += '      </div>';
    html += '      <div class="my-1.5">' + domBadge + '</div>';
    html += '      <p class="text-[11px] text-gray-300 leading-relaxed mt-1">' + domDesc + '</p>';
    html += '    </div>';

    // Card 3: Rasio Partisipasi Bandar vs Ritel
    html += '    <div class="bg-dark-800/80 border border-dark-600/40 rounded-xl p-3 flex flex-col justify-between shadow-sm">';
    html += '      <div class="flex items-center justify-between mb-2">';
    html += '        <span class="text-xs font-bold text-gray-200">Partisipasi Bandar vs Ritel</span>';
    html += '        <span class="text-[10px] font-mono ' + (bandarPct >= 50 ? 'text-emerald-400' : 'text-amber-400') + '">' + (bandarPct >= 50 ? 'Bandar Dominan' : 'Ritel Aktif') + '</span>';
    html += '      </div>';
    html += '      <div class="my-2">';
    html += '        <div class="flex items-center justify-between text-xs font-mono font-bold mb-1.5">';
    html += '          <span class="text-emerald-400">Bandar/Institusi: ' + bandarPct + '%</span>';
    html += '          <span class="text-amber-400">Ritel: ' + retailPct + '%</span>';
    html += '        </div>';
    html += '        <div class="w-full h-3 rounded-full bg-dark-900 overflow-hidden flex">';
    html += '          <div class="h-full bg-emerald-500 transition-all" style="width:' + bandarPct + '%"></div>';
    html += '          <div class="h-full bg-amber-500 transition-all" style="width:' + retailPct + '%"></div>';
    html += '        </div>';
    html += '      </div>';
    html += '      <p class="text-[10px] text-gray-400 leading-tight">Estimasi perbandingan volume broker institusi/asing terhadap broker ritel populer (YP, XL, XC, PD).</p>';
    html += '    </div>';
    html += '  </div>';

    // 2C-1. Sebaran & Klaster Broker Akumulasi (Interactive Bubble Cluster)
    var accRawBuyers = firstNonEmptyList(bAcc.top_buyers, bAcc.net_buyers, bSum.net_buyers, bSum.gross_buyers, bSum.top_buyers, bSum.buyers) || [];
    var accRawSellers = firstNonEmptyList(bAcc.top_sellers, bAcc.net_sellers, bSum.net_sellers, bSum.gross_sellers, bSum.top_sellers, bSum.sellers) || [];
    if (accRawBuyers.length === 0 && accRawSellers.length === 0 && bSum) {
      accRawBuyers = firstNonEmptyList(bSum.net_buyers, bSum.gross_buyers, bSum.top_buyers, bSum.buyers) || [];
      accRawSellers = firstNonEmptyList(bSum.net_sellers, bSum.gross_sellers, bSum.top_sellers, bSum.sellers) || [];
    }
    var accBuyers = filterBrokersByFlow(accRawBuyers, brokerFlowFilter);
    var accSellers = filterBrokersByFlow(accRawSellers, brokerFlowFilter);
    if (accBuyers.length === 0 && accSellers.length === 0 && brokerFlowFilter === 'all' && (accRawBuyers.length > 0 || accRawSellers.length > 0)) {
      accBuyers = accRawBuyers;
      accSellers = accRawSellers;
    }
    lastBrokerItems = buildBrokerBubbleItems(accBuyers, accSellers, brokerSummaryMode);
    if (lastBrokerItems.length === 0 && (accRawBuyers.length > 0 || accRawSellers.length > 0)) {
      lastBrokerItems = buildBrokerBubbleItems(accRawBuyers, accRawSellers, brokerSummaryMode);
    }

    if (brokerAccumulationView === 'bubble') {
      html += '  <div class="bg-dark-800/80 border border-dark-600/40 rounded-xl p-4 shadow-sm">';
      html += '    <div class="flex items-center justify-between mb-3">';
      html += '      <div>';
      html += '        <h4 class="text-xs font-bold text-gray-200 flex items-center gap-1.5"><span class="text-sm">🫧</span> Sebaran Klaster Broker Akumulasi &amp; Distribusi</h4>';
      html += '        <p class="text-[11px] text-gray-400 mt-0.5">Visualisasi interaktif bubble broker akumulasi dan distribusi. Tap bubble untuk detail transaksi.</p>';
      html += '      </div>';
      html += '    </div>';
      html += renderBrokerBubbleClusterHtml(lastBrokerItems, selectedBrokerCode, brokerSummaryMode, bubbleFilterSide);
      html += '  </div>';
    }

    // 2C. Tabel Riwayat Harian Bandarmologi (Daily Tracking Table)
    html += '  <div class="bg-dark-800/80 border border-dark-600/40 rounded-xl p-4 shadow-sm">';
    html += '    <div class="flex items-center justify-between mb-3">';
    html += '      <div>';
    html += '        <h4 class="text-xs font-bold text-gray-200 flex items-center gap-1.5"><span class="text-sm">📅</span> Riwayat Harian Broker Summary (Breakdown Per Hari) &amp; Konsistensi</h4>';
    html += '        <p class="text-[11px] text-gray-400 mt-0.5">Pantau konsistensi arah modal (Akumulasi vs Distribusi) dan broker penggerak utama setiap hari bursa.</p>';
    html += '      </div>';
    html += '      <span class="text-[11px] text-gray-400 font-mono">' + series.length + ' Hari Tersedia</span>';
    html += '    </div>';

    if (series.length === 0) {
      html += '    <div class="text-gray-500 text-center py-6 text-xs">Belum ada riwayat harian untuk emiten ini.</div>';
    } else {
      html += '    <div class="overflow-x-auto overflow-y-auto max-h-[420px] scrollbar-thin" style="max-height: 420px; overflow-y: auto;">';
      html += '      <table class="w-full text-left text-xs whitespace-nowrap">';
      html += '        <thead class="sticky top-0 bg-slate-900 z-10" style="position: sticky; top: 0; z-index: 10; background-color: #0f172a;">';
      html += '          <tr class="text-[11px] text-gray-400 border-b border-dark-600/40 bg-slate-900">';
      html += '            <th class="py-2.5 px-3">Tanggal</th>';
      html += '            <th class="py-2.5 px-3 text-center">Kategori</th>';
      html += '            <th class="py-2.5 px-3 text-center">Top 1 Broker</th>';
      html += '            <th class="py-2.5 px-3 text-right">Top 3 Net Flow</th>';
      html += '            <th class="py-2.5 px-3 text-center">Status Dominasi</th>';
      html += '            <th class="py-2.5 px-2.5 text-center">Aksi</th>';
      html += '          </tr>';
      html += '        </thead>';
      html += '        <tbody class="divide-y divide-dark-600/20">';

      var revSeries = series.slice().reverse();
      for (var di = 0; di < revSeries.length; di++) {
        var dayRow = revSeries[di];
        var isSelected = dayRow.date === (bSum.date || currentBandarDate);
        var rowNet = normalizeBrokerValue(dayRow.net_val || 0);
        var isPositive = rowNet >= 0;

        // Kategori: Big Acc / Normal Acc / Dist / Big Dist
        var catBadge = '';
        if (rowNet >= 5e9) {
          catBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">🟢 Big Acc</span>';
        } else if (rowNet > 0) {
          catBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">🟢 Normal Acc</span>';
        } else if (rowNet <= -5e9) {
          catBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-500/20 text-rose-300 border border-rose-500/40">🔴 Big Dist</span>';
        } else {
          catBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-rose-500/10 text-rose-400 border border-rose-500/30">🔴 Normal Dist</span>';
        }

        // Top 1 Broker
        var top1Code = isPositive ? (dayRow.top_buyer || '—') : (dayRow.top_seller || '—');
        var top1Color = isPositive ? 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' : 'text-rose-300 bg-rose-500/10 border-rose-500/30';
        var top1Badge = top1Code !== '—'
          ? '<span class="px-2 py-0.5 rounded font-mono font-bold text-[10px] border ' + top1Color + '">' + escapeHtml(top1Code) + ' (' + (isPositive ? 'Buy' : 'Sell') + ')</span>'
          : '<span class="text-gray-500 font-mono">—</span>';

        // Daily Dominance status
        var dayDomBadge = Math.abs(rowNet) >= 1e10
          ? '<span class="text-[10px] font-semibold text-emerald-400">Monopolistic</span>'
          : (Math.abs(rowNet) >= 2e9 ? '<span class="text-[10px] font-semibold text-sky-400">Concentrated</span>' : '<span class="text-[10px] text-gray-400">Distributed</span>');

        var rowBg = isSelected
          ? 'bg-emerald-500/10 border-l-2 border-emerald-500 font-medium'
          : 'hover:bg-dark-600/20 transition';

        html += '          <tr class="' + rowBg + '">';
        html += '            <td class="py-2 px-3 font-mono text-[11px] text-gray-200">';
        html += '              ' + escapeHtml(dayRow.date);
        if (isSelected) {
          html += '            <span class="ml-1.5 text-[9px] px-1.5 py-0.2 rounded bg-emerald-500 text-dark-900 font-bold">DILIHAT</span>';
        }
        html += '            </td>';
        html += '            <td class="py-2 px-3 text-center">' + catBadge + '</td>';
        html += '            <td class="py-2 px-3 text-center">' + top1Badge + '</td>';
        html += '            <td class="py-2 px-3 font-mono text-right font-semibold ' + (isPositive ? 'text-emerald-400' : 'text-rose-400') + '">' + (isPositive ? '+' : '-') + formatIDR(Math.abs(rowNet)) + '</td>';
        html += '            <td class="py-2 px-3 text-center">' + dayDomBadge + '</td>';
        html += '            <td class="py-2 px-2.5 text-center">';
        html += '              <button type="button" onclick="BandarmologiRuntime.loadBandarmologiTab(null, \'' + escapeHtml(dayRow.date) + '\')" class="px-2 py-1 text-[10px] rounded bg-dark-600 hover:bg-emerald-600 hover:text-white text-gray-300 transition">Lihat Broksum</button>';
        html += '            </td>';
        html += '          </tr>';
      }
      html += '        </tbody>';
      html += '      </table>';
      html += '    </div>';
    }
    html += '  </div>';

    // 2D. Historical Broker Accumulation Visual Bar Chart
    html += '  <div class="bg-dark-800/80 border border-dark-600/40 rounded-xl p-4 shadow-sm">';
    html += '    <div class="flex items-center justify-between mb-3">';
    html += '      <h4 class="text-xs font-bold text-gray-200 flex items-center gap-1.5"><span class="text-sm">📊</span> Grafik Tren Akumulasi vs Distribusi Historis</h4>';
    if (bAcc.accumulation_score != null) {
      html += '      <span class="text-[11px] font-mono px-2 py-0.5 rounded bg-dark-700 text-emerald-400 border border-emerald-500/20">Acc Score: ' + bAcc.accumulation_score + '/100</span>';
    }
    html += '    </div>';

    if (series.length === 0) {
      html += '    <div class="text-gray-500 text-center py-4 text-xs">Belum ada data visualisasi akumulasi</div>';
    } else {
      html += '    <div class="space-y-2">';
      var maxAbs = 1;
      for (var k = 0; k < series.length; k++) {
        var val = Math.abs(normalizeBrokerValue(series[k].net_val || 0));
        if (val > maxAbs) maxAbs = val;
      }
      for (var si = 0; si < series.length; si++) {
        var day = series[si];
        var dayNet = normalizeBrokerValue(day.net_val || 0);
        var isPositive = dayNet >= 0;
        var barWidth = Math.max(8, Math.min(100, Math.round((Math.abs(dayNet) / maxAbs) * 100)));
        var barColor = isPositive ? 'bg-emerald-500' : 'bg-rose-500';

        html += '      <div class="flex items-center gap-3 text-xs">';
        html += '        <span class="w-20 text-[11px] font-mono text-gray-400 shrink-0">' + escapeHtml(day.date) + '</span>';
        html += '        <div class="flex-1 bg-dark-900 rounded-full h-3 overflow-hidden flex items-center px-0.5">';
        html += '          <div class="h-2 rounded-full ' + barColor + ' transition-all" style="width:' + barWidth + '%"></div>';
        html += '        </div>';
        html += '        <span class="w-24 text-right font-mono font-semibold text-[11px] ' + (isPositive ? 'text-emerald-400' : 'text-rose-400') + ' shrink-0">' + (isPositive ? '+' : '-') + formatIDR(Math.abs(dayNet)) + '</span>';
        html += '      </div>';
      }
      html += '    </div>';
    }
    html += '  </div>';

    html += '</div>';
    }

    // 4. INSIDER TRANSACTIONS SECTION (Exclusively for Bandarmologi & Insider tab)
    if (isSummarySection) {
      var totalInsidersCount = insiders.length;
      var buyInsidersCount = insiders.filter(function (r) {
        var a = String(r.action_type || r.type || 'BUY').toUpperCase();
        return a.includes('BUY') || a.includes('BELI');
      }).length;
      var sellInsidersCount = insiders.filter(function (r) {
        var a = String(r.action_type || r.type || 'BUY').toUpperCase();
        return a.includes('SELL') || a.includes('JUAL');
      }).length;

      var filteredInsiders = insiders.filter(function (r) {
        if (insiderActionFilter === 'all') return true;
        var a = String(r.action_type || r.type || 'BUY').toUpperCase();
        if (insiderActionFilter === 'BUY') return a.includes('BUY') || a.includes('BELI');
        if (insiderActionFilter === 'SELL') return a.includes('SELL') || a.includes('JUAL');
        return a.includes(insiderActionFilter);
      });

      html += '<div class="bg-dark-700/40 border border-dark-600/30 rounded-xl p-3.5">';
      html += '  <div class="flex flex-wrap items-center justify-between gap-3 mb-3">';
      html += '    <div class="flex items-center gap-2">';
      html += '      <h3 class="text-xs font-bold text-gray-200 flex items-center gap-1.5"><span class="text-sm">👥</span> Transaksi Insider (Orang Dalam)</h3>';
      html += '      <span class="text-[11px] text-gray-400">(' + filteredInsiders.length + (filteredInsiders.length !== totalInsidersCount ? ' dari ' + totalInsidersCount : '') + ' transaksi)</span>';
      html += '    </div>';
      html += '    <div class="flex items-center gap-2">';
      html += '      <span class="text-[11px] text-gray-400 font-medium">Filter Aksi:</span>';
      html += '      <select id="insiderActionFilterSelect" onchange="BandarmologiRuntime.setInsiderActionFilter(this.value)" class="bg-dark-800 border border-dark-600/60 rounded-lg px-2.5 py-1 text-xs text-gray-200 font-mono focus:outline-none focus:border-emerald-500/50">';
      html += '        <option value="all"' + (insiderActionFilter === 'all' ? ' selected' : '') + '>Semua Aksi (' + totalInsidersCount + ')</option>';
      html += '        <option value="BUY"' + (insiderActionFilter === 'BUY' ? ' selected' : '') + '>🟢 Beli (' + buyInsidersCount + ')</option>';
      html += '        <option value="SELL"' + (insiderActionFilter === 'SELL' ? ' selected' : '') + '>🔴 Jual (' + sellInsidersCount + ')</option>';
      html += '      </select>';
      html += '    </div>';
      html += '  </div>';

      if (filteredInsiders.length === 0) {
        html += '  <div class="text-gray-500 text-center py-6 text-xs">' + (totalInsidersCount === 0 ? 'Tidak ada riwayat transaksi insider untuk ticker ini.' : 'Tidak ada transaksi dengan filter aksi yang dipilih.') + '</div>';
      } else {
        html += '  <div class="overflow-x-auto overflow-y-auto max-h-[420px] scrollbar-thin" style="max-height: 420px; overflow-y: auto;">';
        html += '    <table class="w-full text-left text-xs whitespace-nowrap">';
        html += '      <thead class="sticky top-0 bg-slate-900 z-10" style="position: sticky; top: 0; z-index: 10; background-color: #0f172a;">';
        html += '        <tr class="text-[11px] text-gray-400 border-b border-dark-600/40 bg-slate-900">';
        html += '          <th class="py-2 px-2.5">Tanggal</th>';
        html += '          <th class="py-2 px-2.5">Nama Insider</th>';
        html += '          <th class="py-2 px-2.5">Jabatan</th>';
        html += '          <th class="py-2 px-2 text-center">Aksi</th>';
        html += '          <th class="py-2 px-2.5 text-right">Harga</th>';
        html += '          <th class="py-2 px-2 text-center">Broker</th>';
        html += '          <th class="py-2 px-2.5 text-right">Perubahan (%)</th>';
        html += '          <th class="py-2 px-2.5 text-right">Kepemilikan Saat Ini (%)</th>';
        html += '          <th class="py-2 px-2.5 text-right">Kepemilikan Sebelumnya (%)</th>';
        html += '          <th class="py-2 px-2 text-center">Nasionalitas</th>';
        html += '        </tr>';
        html += '      </thead>';
        html += '      <tbody class="divide-y divide-dark-600/20">';
        for (var ins = 0; ins < filteredInsiders.length; ins++) {
          var row = filteredInsiders[ins];
          var actRaw = String(row.action_type || row.type || 'BUY').toUpperCase();
          var isBuy = actRaw.includes('BUY') || actRaw.includes('BELI');
          var isSell = actRaw.includes('SELL') || actRaw.includes('JUAL');
          var isTransfer = actRaw.includes('TRANS') || actRaw.includes('ALIH') || actRaw.includes('HIBAH');

          var actionTag = '';
          if (isBuy) {
            actionTag = '<span class="px-2 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 font-bold text-[10px]">BELI</span>';
          } else if (isSell) {
            actionTag = '<span class="px-2 py-0.5 rounded bg-rose-500/10 border border-rose-500/30 text-rose-300 font-bold text-[10px]">JUAL</span>';
          } else if (isTransfer) {
            actionTag = '<span class="px-2 py-0.5 rounded bg-sky-500/10 border border-sky-500/30 text-sky-300 font-bold text-[10px]">TRANSFER</span>';
          } else {
            actionTag = '<span class="px-2 py-0.5 rounded bg-dark-600/40 text-gray-300 font-bold text-[10px]">' + escapeHtml(actRaw) + '</span>';
          }

          var priceDisplay = '—';
          if (row.price != null && Number(row.price) > 0) {
            priceDisplay = 'Rp ' + formatIDR(Number(row.price));
          }

          var brokerDisplay = (row.broker && row.broker !== '—')
            ? '<span class="px-1.5 py-0.5 rounded font-mono font-bold bg-dark-600/60 text-gray-200 border border-dark-500 text-[10px]">' + escapeHtml(row.broker) + '</span>'
            : '<span class="text-gray-500 font-mono">—</span>';

          var sharesVal = row.shares_change != null ? row.shares_change : (row.shares != null ? row.shares : row.volume);
          var signStr = isBuy ? '+' : (isSell ? '-' : '');
          var pctStr = row.pct_change && row.pct_change !== '—' ? ' (' + escapeHtml(row.pct_change) + ')' : '';
          var changeDisplay = sharesVal != null
            ? (signStr + formatNumber(Math.abs(sharesVal)) + pctStr)
            : (row.pct_change || '—');

          var afterShares = row.shares_after != null ? formatNumber(row.shares_after) : (row.shares_after === 0 ? '0' : '—');
          var rawAfterPct = row.pct_after || row.shares_after_percentage || row.current_percentage || row.percentage_after || row.after_percentage || '';
          if (rawAfterPct && !String(rawAfterPct).includes('%') && rawAfterPct !== '—') rawAfterPct += '%';
          var afterPct = rawAfterPct ? ' (' + escapeHtml(rawAfterPct) + ')' : '';
          var afterDisplay = afterShares !== '—' ? (afterShares + afterPct) : (rawAfterPct ? escapeHtml(rawAfterPct) : '—');

          var sharesBeforeVal = row.shares_before;
          if (sharesBeforeVal == null && row.shares_after != null && sharesVal != null) {
            var signedVal = (isSell && sharesVal > 0) ? -sharesVal : sharesVal;
            sharesBeforeVal = row.shares_after - signedVal;
          }
          var beforeShares = sharesBeforeVal != null ? formatNumber(sharesBeforeVal) : (sharesBeforeVal === 0 ? '0' : '—');
          var rawBeforePct = row.pct_before || row.shares_before_percentage || row.previous_percentage || row.percentage_before || row.before_percentage || '';
          if (rawBeforePct && !String(rawBeforePct).includes('%') && rawBeforePct !== '—') rawBeforePct += '%';
          var beforePct = rawBeforePct ? ' (' + escapeHtml(rawBeforePct) + ')' : '';
          var beforeDisplay = beforeShares !== '—' ? (beforeShares + beforePct) : (rawBeforePct ? escapeHtml(rawBeforePct) : '—');

          var isForeign = String(row.nationality || '').toLowerCase() === 'foreign';
          var nationalityBadge = isForeign
            ? '<span class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-sky-500/10 text-sky-300 border border-sky-500/30">🌏 Foreign</span>'
            : '<span class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-dark-600/40 text-gray-300 border border-dark-500">🇮🇩 Local</span>';

          var changeColor = isBuy ? 'text-emerald-400' : (isSell ? 'text-rose-400' : 'text-gray-300');
          var positionDisplay = row.position || row.jabatan || row.title || row.status || (row.badges && row.badges[0]) || '—';

          html += '        <tr class="hover:bg-dark-600/20 transition">';
          html += '          <td class="py-2.5 px-2.5 font-mono text-[11px] text-gray-300">' + escapeHtml(row.date || '—') + '</td>';
          html += '          <td class="py-2.5 px-2.5 font-medium text-gray-100">' + escapeHtml(row.name || row.insider_name || '—') + '</td>';
          html += '          <td class="py-2.5 px-2.5 text-gray-400 text-[11px]">' + escapeHtml(positionDisplay) + '</td>';
          html += '          <td class="py-2.5 px-2 text-center">' + actionTag + '</td>';
          html += '          <td class="py-2.5 px-2.5 font-mono text-right text-gray-200">' + priceDisplay + '</td>';
          html += '          <td class="py-2.5 px-2 text-center">' + brokerDisplay + '</td>';
          html += '          <td class="py-2.5 px-2.5 font-mono text-right ' + changeColor + '">' + changeDisplay + '</td>';
          html += '          <td class="py-2.5 px-2.5 font-mono text-right text-gray-200">' + afterDisplay + '</td>';
          html += '          <td class="py-2.5 px-2.5 font-mono text-right text-gray-400">' + beforeDisplay + '</td>';
          html += '          <td class="py-2.5 px-2 text-center">' + nationalityBadge + '</td>';
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

  function setInsiderActionFilter(action) {
    insiderActionFilter = action || 'all';
    var container = byId('bandarmologiContent');
    if (container && lastBandarData) {
      renderBandarmologiUI(container, lastBandarData);
    }
  }

  function getInsiderActionFilter() {
    return insiderActionFilter;
  }

  // ============================================================================
  // JEJARING INSIDER & MULTI-EMITEN NETWORK GRAPH RUNTIME
  // ============================================================================
  var activeInsiderNetworkEntity = 'Belvin Tannadi';
  var activeInsiderNetworkSelectedTicker = null;
  var currentInsiderNetworkGraph = null;

  var FALLBACK_INSIDER_DATA = {
    'belvin tannadi': {
      summary: { entity_name: 'Belvin Tannadi', total_emitens: 3 },
      nodes: [
        { id: 'insider:belvin_tannadi', label: 'Belvin Tannadi', type: 'insider', is_central: true, total_emitens: 3, nationality: 'local' },
        { id: 'ticker:BUMI', label: 'BUMI', ticker: 'BUMI', type: 'ticker' },
        { id: 'ticker:BRMS', label: 'BRMS', ticker: 'BRMS', type: 'ticker' },
        { id: 'ticker:DEWA', label: 'DEWA', ticker: 'DEWA', type: 'ticker' }
      ],
      edges: [
        { source: 'insider:belvin_tannadi', target: 'ticker:BUMI', ticker: 'BUMI', shares: 850000000, percentage: 2.45, percentage_raw: '2.45%', broker: 'YP', brokers: ['YP'], latest_action: 'BUY', latest_price: 142, latest_date: '2026-09-05' },
        { source: 'insider:belvin_tannadi', target: 'ticker:BRMS', ticker: 'BRMS', shares: 420000000, percentage: 1.80, percentage_raw: '1.80%', broker: 'XL', brokers: ['XL'], latest_action: 'BUY', latest_price: 195, latest_date: '2026-08-28' },
        { source: 'insider:belvin_tannadi', target: 'ticker:DEWA', ticker: 'DEWA', shares: 180000000, percentage: 1.15, percentage_raw: '1.15%', broker: 'YP', brokers: ['YP'], latest_action: 'BUY', latest_price: 78, latest_date: '2026-08-15' }
      ]
    },
    'prajogo pangestu': {
      summary: { entity_name: 'Prajogo Pangestu', total_emitens: 4 },
      nodes: [
        { id: 'insider:prajogo_pangestu', label: 'Prajogo Pangestu', type: 'insider', is_central: true, total_emitens: 4, nationality: 'local' },
        { id: 'ticker:BREN', label: 'BREN', ticker: 'BREN', type: 'ticker' },
        { id: 'ticker:BRPT', label: 'BRPT', ticker: 'BRPT', type: 'ticker' },
        { id: 'ticker:TPIA', label: 'TPIA', ticker: 'TPIA', type: 'ticker' },
        { id: 'ticker:PTRO', label: 'PTRO', ticker: 'PTRO', type: 'ticker' }
      ],
      edges: [
        { source: 'insider:prajogo_pangestu', target: 'ticker:BREN', ticker: 'BREN', shares: 5800000000, percentage: 43.20, percentage_raw: '43.20%', broker: 'CC', brokers: ['CC'], latest_action: 'BUY', latest_price: 8900, latest_date: '2026-09-02' },
        { source: 'insider:prajogo_pangestu', target: 'ticker:BRPT', ticker: 'BRPT', shares: 66500000000, percentage: 71.18, percentage_raw: '71.18%', broker: 'CC', brokers: ['CC'], latest_action: 'BUY', latest_price: 1150, latest_date: '2026-08-20' },
        { source: 'insider:prajogo_pangestu', target: 'ticker:TPIA', ticker: 'TPIA', shares: 3280000000, percentage: 37.95, percentage_raw: '37.95%', broker: 'CC', brokers: ['CC'], latest_action: 'BUY', latest_price: 8750, latest_date: '2026-08-10' },
        { source: 'insider:prajogo_pangestu', target: 'ticker:PTRO', ticker: 'PTRO', shares: 340000000, percentage: 34.00, percentage_raw: '34.00%', broker: 'CC', brokers: ['CC'], latest_action: 'BUY', latest_price: 14200, latest_date: '2026-07-25' }
      ]
    },
    'lo kheng hong': {
      summary: { entity_name: 'Lo Kheng Hong', total_emitens: 3 },
      nodes: [
        { id: 'insider:lo_kheng_hong', label: 'Lo Kheng Hong', type: 'insider', is_central: true, total_emitens: 3, nationality: 'local' },
        { id: 'ticker:BMTR', label: 'BMTR', ticker: 'BMTR', type: 'ticker' },
        { id: 'ticker:DILD', label: 'DILD', ticker: 'DILD', type: 'ticker' },
        { id: 'ticker:ABMM', label: 'ABMM', ticker: 'ABMM', type: 'ticker' }
      ],
      edges: [
        { source: 'insider:lo_kheng_hong', target: 'ticker:BMTR', ticker: 'BMTR', shares: 1060000000, percentage: 6.45, percentage_raw: '6.45%', broker: 'PD', brokers: ['PD'], latest_action: 'BUY', latest_price: 240, latest_date: '2026-08-18' },
        { source: 'insider:lo_kheng_hong', target: 'ticker:DILD', ticker: 'DILD', shares: 650000000, percentage: 6.28, percentage_raw: '6.28%', broker: 'PD', brokers: ['PD'], latest_action: 'BUY', latest_price: 185, latest_date: '2026-08-05' },
        { source: 'insider:lo_kheng_hong', target: 'ticker:ABMM', ticker: 'ABMM', shares: 138000000, percentage: 5.01, percentage_raw: '5.01%', broker: 'PD', brokers: ['PD'], latest_action: 'BUY', latest_price: 3950, latest_date: '2026-07-30' }
      ]
    },
    'anthoni salim': {
      summary: { entity_name: 'Anthoni Salim', total_emitens: 2 },
      nodes: [
        { id: 'insider:anthoni_salim', label: 'Anthoni Salim', type: 'insider', is_central: true, total_emitens: 2, nationality: 'local' },
        { id: 'ticker:INDF', label: 'INDF', ticker: 'INDF', type: 'ticker' },
        { id: 'ticker:AMMN', label: 'AMMN', ticker: 'AMMN', type: 'ticker' }
      ],
      edges: [
        { source: 'insider:anthoni_salim', target: 'ticker:INDF', ticker: 'INDF', shares: 4390000000, percentage: 50.07, percentage_raw: '50.07%', broker: 'CS', brokers: ['CS'], latest_action: 'BUY', latest_price: 6800, latest_date: '2026-08-22' },
        { source: 'insider:anthoni_salim', target: 'ticker:AMMN', ticker: 'AMMN', shares: 5200000000, percentage: 7.15, percentage_raw: '7.15%', broker: 'AK', brokers: ['AK'], latest_action: 'BUY', latest_price: 10400, latest_date: '2026-08-14' }
      ]
    },
    'garibaldi thohir': {
      summary: { entity_name: 'Garibaldi Thohir', total_emitens: 3 },
      nodes: [
        { id: 'insider:garibaldi_thohir', label: 'Garibaldi Thohir', type: 'insider', is_central: true, total_emitens: 3, nationality: 'local' },
        { id: 'ticker:ADRO', label: 'ADRO', ticker: 'ADRO', type: 'ticker' },
        { id: 'ticker:MDKA', label: 'MDKA', ticker: 'MDKA', type: 'ticker' },
        { id: 'ticker:ESSA', label: 'ESSA', ticker: 'ESSA', type: 'ticker' }
      ],
      edges: [
        { source: 'insider:garibaldi_thohir', target: 'ticker:ADRO', ticker: 'ADRO', shares: 1980000000, percentage: 6.18, percentage_raw: '6.18%', broker: 'LG', brokers: ['LG'], latest_action: 'BUY', latest_price: 3680, latest_date: '2026-09-03' },
        { source: 'insider:garibaldi_thohir', target: 'ticker:MDKA', ticker: 'MDKA', shares: 1850000000, percentage: 7.65, percentage_raw: '7.65%', broker: 'LG', brokers: ['LG'], latest_action: 'BUY', latest_price: 2360, latest_date: '2026-08-26' },
        { source: 'insider:garibaldi_thohir', target: 'ticker:ESSA', ticker: 'ESSA', shares: 920000000, percentage: 5.40, percentage_raw: '5.40%', broker: 'LG', brokers: ['LG'], latest_action: 'BUY', latest_price: 940, latest_date: '2026-08-19' }
      ]
    },
    'blackrock inc.': {
      summary: { entity_name: 'BlackRock Inc.', total_emitens: 3 },
      nodes: [
        { id: 'insider:blackrock_inc', label: 'BlackRock Inc.', type: 'insider', is_central: true, total_emitens: 3, nationality: 'foreign' },
        { id: 'ticker:BBCA', label: 'BBCA', ticker: 'BBCA', type: 'ticker' },
        { id: 'ticker:BBRI', label: 'BBRI', ticker: 'BBRI', type: 'ticker' },
        { id: 'ticker:TLKM', label: 'TLKM', ticker: 'TLKM', type: 'ticker' }
      ],
      edges: [
        { source: 'insider:blackrock_inc', target: 'ticker:BBCA', ticker: 'BBCA', shares: 3100000000, percentage: 2.52, percentage_raw: '2.52%', broker: 'AK', brokers: ['AK'], latest_action: 'BUY', latest_price: 9850, latest_date: '2026-09-01' },
        { source: 'insider:blackrock_inc', target: 'ticker:BBRI', ticker: 'BBRI', shares: 3800000000, percentage: 2.51, percentage_raw: '2.51%', broker: 'AK', brokers: ['AK'], latest_action: 'BUY', latest_price: 4950, latest_date: '2026-08-29' },
        { source: 'insider:blackrock_inc', target: 'ticker:TLKM', ticker: 'TLKM', shares: 2450000000, percentage: 2.47, percentage_raw: '2.47%', broker: 'AK', brokers: ['AK'], latest_action: 'SELL', latest_price: 2950, latest_date: '2026-08-25' }
      ]
    },
    'haji isam': {
      summary: { entity_name: 'Haji Samsudin Andi Arsyad (Haji Isam)', total_emitens: 2 },
      nodes: [
        { id: 'insider:haji_isam', label: 'Haji Isam', type: 'insider', is_central: true, total_emitens: 2, nationality: 'local' },
        { id: 'ticker:JARR', label: 'JARR', ticker: 'JARR', type: 'ticker' },
        { id: 'ticker:PGUN', label: 'PGUN', ticker: 'PGUN', type: 'ticker' }
      ],
      edges: [
        { source: 'insider:haji_isam', target: 'ticker:JARR', ticker: 'JARR', shares: 6850000000, percentage: 85.00, percentage_raw: '85.00%', broker: 'YP', brokers: ['YP'], latest_action: 'BUY', latest_price: 360, latest_date: '2026-09-02' },
        { source: 'insider:haji_isam', target: 'ticker:PGUN', ticker: 'PGUN', shares: 4120000000, percentage: 49.80, percentage_raw: '49.80%', broker: 'YP', brokers: ['YP'], latest_action: 'BUY', latest_price: 480, latest_date: '2026-08-25' }
      ]
    },
    'haji samsudin andi arsyad': {
      summary: { entity_name: 'Haji Samsudin Andi Arsyad (Haji Isam)', total_emitens: 2 },
      nodes: [
        { id: 'insider:haji_isam', label: 'Haji Isam', type: 'insider', is_central: true, total_emitens: 2, nationality: 'local' },
        { id: 'ticker:JARR', label: 'JARR', ticker: 'JARR', type: 'ticker' },
        { id: 'ticker:PGUN', label: 'PGUN', ticker: 'PGUN', type: 'ticker' }
      ],
      edges: [
        { source: 'insider:haji_isam', target: 'ticker:JARR', ticker: 'JARR', shares: 6850000000, percentage: 85.00, percentage_raw: '85.00%', broker: 'YP', brokers: ['YP'], latest_action: 'BUY', latest_price: 360, latest_date: '2026-09-02' },
        { source: 'insider:haji_isam', target: 'ticker:PGUN', ticker: 'PGUN', shares: 4120000000, percentage: 49.80, percentage_raw: '49.80%', broker: 'YP', brokers: ['YP'], latest_action: 'BUY', latest_price: 480, latest_date: '2026-08-25' }
      ]
    }
  };

  function getInsiderNetworkService() {
    if (typeof require !== 'undefined') {
      try {
        return require('../lib/insider-network-service');
      } catch (_) {}
    }
    return null;
  }

  function getEffectiveInsiderGraph(name) {
    var service = getInsiderNetworkService();
    if (service && typeof service.buildInsiderNetworkGraph === 'function') {
      var res = service.buildInsiderNetworkGraph({ name: name });
      if (res && res.nodes && res.nodes.length > 0) return res;
    }
    var key = String(name || '').toLowerCase().trim();
    if (FALLBACK_INSIDER_DATA[key]) return FALLBACK_INSIDER_DATA[key];
    for (var k in FALLBACK_INSIDER_DATA) {
      if (k.includes(key) || key.includes(k)) return FALLBACK_INSIDER_DATA[k];
    }
    return FALLBACK_INSIDER_DATA['belvin tannadi'] || null;
  }

  function getEffectiveSearchInsiders(query, options) {
    var service = getInsiderNetworkService();
    if (service && typeof service.searchInsiders === 'function') {
      var res = service.searchInsiders(query, options);
      if (Array.isArray(res) && res.length > 0) return res;
    }
    var cleanQ = String(query || '').toLowerCase().trim();
    var results = [];
    for (var k in FALLBACK_INSIDER_DATA) {
      var d = FALLBACK_INSIDER_DATA[k];
      var entityName = d.summary.entity_name;
      var tickers = (d.edges || []).map(function(e) { return e.ticker; });
      if (!cleanQ || k.includes(cleanQ) || entityName.toLowerCase().includes(cleanQ) || tickers.some(function(t) { return t.toLowerCase().includes(cleanQ); })) {
        results.push({
          id: d.nodes[0].id,
          name: entityName,
          tickers: tickers,
          total_emitens: d.summary.total_emitens
        });
      }
    }
    return results;
  }

  function fetchRemoteInsiderGraph(name, cb) {
    if (typeof window === 'undefined' || typeof fetch === 'undefined') return;
    try {
      fetch('/api/sector-hot?action=insider-network&query=' + encodeURIComponent(name))
        .then(function (r) { return r.json(); })
        .then(function (data) {
          if (data && (data.success || data.nodes) && data.nodes && data.nodes.length > 0) {
            FALLBACK_INSIDER_DATA[String(name).toLowerCase().trim()] = data;
            if (typeof cb === 'function') cb(data);
          }
        })
        .catch(function () {});
    } catch (_) {}
  }

  function loadInsiderNetwork(container) {
    var target = container || byId('insiderNetworkDedicatedContent') || byId('bandarmologiContent');
    if (!target) return;
    renderInsiderNetworkUI(target);
  }

  function formatEntityDisplayName(name) {
    if (!name) return '';
    var str = String(name).trim();
    var cleanLower = str.toLowerCase();
    if (cleanLower.includes('belvin')) return 'Belvin Tannadi';
    if (cleanLower.includes('prajogo')) return 'Prajogo Pangestu';
    if (cleanLower.includes('garibaldi') || cleanLower.includes('boy thohir')) return 'Garibaldi Thohir';
    if (cleanLower.includes('kheng hong')) return 'Lo Kheng Hong';
    if (cleanLower.includes('anthoni salim') || cleanLower.includes('anthony salim')) return 'Anthoni Salim';
    if (cleanLower.includes('samsudin') || cleanLower.includes('isam')) return 'Haji Samsudin Andi Arsyad (Haji Isam)';
    if (cleanLower.includes('budi hartono')) return 'Robert Budi Hartono';

    if (str === str.toUpperCase() && str.length > 3) {
      return str.split(' ').map(function(w) {
        if (!w) return '';
        return w.charAt(0).toUpperCase() + w.slice(1).toLowerCase();
      }).join(' ');
    }
    return str;
  }

  function renderInsiderNetworkSvg(graph, selectedTicker) {
    if (!graph || !graph.nodes || graph.nodes.length === 0) {
      return '<div class="p-8 text-center text-gray-400 text-xs">Data jejaring relasi tidak ditemukan.</div>';
    }

    var centralNode = graph.nodes.find(function (n) { return n.is_central || n.type === 'insider'; }) || graph.nodes[0];
    var edges = graph.edges || graph.links || [];
    var emitenNodes = graph.nodes.filter(function (n) { return n.type === 'ticker'; });

    var cx = 450;
    var cy = 350;
    var radius = 185;
    var numEmitens = emitenNodes.length;

    var svg = '';
    svg += '<svg id="insiderNetworkSvg" viewBox="0 0 900 700" class="w-full h-auto max-h-[640px] select-none rounded-xl" xmlns="http://www.w3.org/2000/svg">\n';
    svg += '  <defs>\n';
    svg += '    <style>\n';
    svg += '      @keyframes sunPulse {\n';
    svg += '        0%, 100% { transform: scale(1); filter: drop-shadow(0 0 14px rgba(245, 158, 11, 0.7)); }\n';
    svg += '        50% { transform: scale(1.05); filter: drop-shadow(0 0 26px rgba(251, 191, 36, 0.95)); }\n';
    svg += '      }\n';
    svg += '      @keyframes sunCoronaRotate {\n';
    svg += '        from { transform: rotate(0deg); }\n';
    svg += '        to { transform: rotate(360deg); }\n';
    svg += '      }\n';
    svg += '      @keyframes solarOrbit {\n';
    svg += '        from { transform: rotate(0deg); }\n';
    svg += '        to { transform: rotate(360deg); }\n';
    svg += '      }\n';
    svg += '      @keyframes counterOrbit {\n';
    svg += '        from { transform: rotate(0deg); }\n';
    svg += '        to { transform: rotate(-360deg); }\n';
    svg += '      }\n';
    svg += '      @keyframes satelliteOrbit {\n';
    svg += '        from { transform: rotate(0deg); }\n';
    svg += '        to { transform: rotate(360deg); }\n';
    svg += '      }\n';
    svg += '      @keyframes satelliteCounter {\n';
    svg += '        from { transform: rotate(0deg); }\n';
    svg += '        to { transform: rotate(-360deg); }\n';
    svg += '      }\n';
    svg += '      .central-insider-node {\n';
    svg += '        transform-origin: 450px 350px;\n';
    svg += '        animation: sunPulse 3.2s ease-in-out infinite;\n';
    svg += '      }\n';
    svg += '      .sun-corona {\n';
    svg += '        transform-origin: 450px 350px;\n';
    svg += '        animation: sunCoronaRotate 40s linear infinite;\n';
    svg += '      }\n';
    svg += '      .solar-system-orbit-group {\n';
    svg += '        transform-origin: 450px 350px;\n';
    svg += '        animation: solarOrbit 120s linear infinite;\n';
    svg += '      }\n';
    svg += '      .solar-system-orbit-group:hover,\n';
    svg += '      #insiderNetworkSvg:hover .solar-system-orbit-group,\n';
    svg += '      #insiderNetworkSvg:hover .satellite-orbit-group {\n';
    svg += '        animation-play-state: paused;\n';
    svg += '      }\n';
    svg += '      .emiten-counter-group {\n';
    svg += '        animation: counterOrbit 120s linear infinite;\n';
    svg += '      }\n';
    svg += '      .solar-system-orbit-group:hover .emiten-counter-group {\n';
    svg += '        animation-play-state: paused;\n';
    svg += '      }\n';
    svg += '      .satellite-orbit-group {\n';
    svg += '        animation: satelliteOrbit 16s linear infinite;\n';
    svg += '      }\n';
    svg += '      .satellite-counter-group {\n';
    svg += '        animation: satelliteCounter 16s linear infinite;\n';
    svg += '      }\n';
    svg += '    </style>\n';
    svg += '    <filter id="glowCentral" x="-30%" y="-30%" width="160%" height="160%">\n';
    svg += '      <feGaussianBlur stdDeviation="7" result="blur" />\n';
    svg += '      <feMerge>\n';
    svg += '        <feMergeNode in="blur" />\n';
    svg += '        <feMergeNode in="SourceGraphic" />\n';
    svg += '      </feMerge>\n';
    svg += '    </filter>\n';
    svg += '    <filter id="glowNode" x="-25%" y="-25%" width="150%" height="150%">\n';
    svg += '      <feGaussianBlur stdDeviation="4" result="blur" />\n';
    svg += '      <feMerge>\n';
    svg += '        <feMergeNode in="blur" />\n';
    svg += '        <feMergeNode in="SourceGraphic" />\n';
    svg += '      </feMerge>\n';
    svg += '    </filter>\n';
    svg += '    <linearGradient id="edgeCurvedGrad" x1="0%" y1="0%" x2="100%" y2="100%">\n';
    svg += '      <stop offset="0%" stop-color="#f59e0b" stop-opacity="0.9" />\n';
    svg += '      <stop offset="50%" stop-color="#38bdf8" stop-opacity="0.75" />\n';
    svg += '      <stop offset="100%" stop-color="#10b981" stop-opacity="0.95" />\n';
    svg += '    </linearGradient>\n';
    svg += '  </defs>\n';

    // Top Legend Bar
    svg += '  <g class="network-legend" transform="translate(30, 16)">\n';
    svg += '    <rect x="0" y="0" width="840" height="34" rx="8" fill="#0f172a" stroke="#334155" stroke-width="1" opacity="0.9"/>\n';
    svg += '    <circle cx="20" cy="17" r="6" fill="#78350f" stroke="#f59e0b" stroke-width="2"/>\n';
    svg += '    <text x="32" y="21" fill="#fbbf24" font-size="11" font-weight="bold" font-family="sans-serif">👑 Tokoh / Konglomerat</text>\n';
    svg += '    <circle cx="195" cy="17" r="6" fill="#4c1d95" stroke="#a855f7" stroke-width="2"/>\n';
    svg += '    <text x="207" y="21" fill="#c084fc" font-size="11" font-weight="bold" font-family="sans-serif">🏢 Perusahaan Induk / Holding</text>\n';
    svg += '    <circle cx="410" cy="17" r="6" fill="#064e3b" stroke="#10b981" stroke-width="2"/>\n';
    svg += '    <text x="422" y="21" fill="#34d399" font-size="11" font-weight="bold" font-family="sans-serif">📈 Emiten / Saham</text>\n';
    svg += '    <circle cx="560" cy="17" r="6" fill="#0c4a6e" stroke="#0284c7" stroke-width="2"/>\n';
    svg += '    <text x="572" y="21" fill="#38bdf8" font-size="11" font-weight="bold" font-family="sans-serif">💼 Broker Langganan</text>\n';
    svg += '    <text x="825" y="21" fill="#64748b" font-size="10" font-family="sans-serif" text-anchor="end">Tap node emiten untuk aksi</text>\n';
    svg += '  </g>\n';

    // Concentric Dashed Orbit Rings (Solar System Tracks)
    svg += '  <circle cx="' + cx + '" cy="' + cy + '" r="72" fill="none" stroke="#f59e0b" stroke-dasharray="3 5" stroke-width="1.2" opacity="0.45" class="sun-corona"/>\n';
    svg += '  <circle cx="' + cx + '" cy="' + cy + '" r="120" fill="none" stroke="#334155" stroke-dasharray="4 4" stroke-width="1" opacity="0.4"/>\n';
    svg += '  <circle cx="' + cx + '" cy="' + cy + '" r="' + radius + '" fill="none" stroke="#0284c7" stroke-dasharray="6 6" stroke-width="1.5" opacity="0.6"/>\n';
    svg += '  <circle cx="' + cx + '" cy="' + cy + '" r="255" fill="none" stroke="#1e293b" stroke-dasharray="4 6" stroke-width="1" opacity="0.4"/>\n';
    svg += '  <circle cx="' + cx + '" cy="' + cy + '" r="310" fill="none" stroke="#0f172a" stroke-dasharray="2 6" stroke-width="0.8" opacity="0.3"/>\n';

    // Revolving Solar System Orbit Group (Revolving Planets & Edges)
    svg += '  <g class="solar-system-orbit-group">\n';

    // Render Edges & Midpoint Broker Chips with smooth curves
    for (var i = 0; i < numEmitens; i++) {
      var emNode = emitenNodes[i];
      var angle = -Math.PI / 2 + (2 * Math.PI * i) / (numEmitens || 1);
      var ex = cx + radius * Math.cos(angle);
      var ey = cy + radius * Math.sin(angle);
      var edge = edges.find(function (e) { return e.ticker === emNode.ticker || e.target === emNode.id; }) || {};

      var isSelected = emNode.ticker === selectedTicker;
      var strokeColor = isSelected ? '#10b981' : '#38bdf8';
      var strokeWidth = isSelected ? '3.5' : '2';

      // Curved Bezier Control Point
      var curvature = 0.18;
      var midX = (cx + ex) / 2;
      var midY = (cy + ey) / 2;
      var normX = -(ey - cy);
      var normY = (ex - cx);
      var cpx = midX + normX * curvature;
      var cpy = midY + normY * curvature;

      // Both curved path and backward-compatible line
      svg += '    <path d="M ' + cx + ' ' + cy + ' Q ' + cpx.toFixed(1) + ' ' + cpy.toFixed(1) + ' ' + ex.toFixed(1) + ' ' + ey.toFixed(1) + '" fill="none" stroke="' + strokeColor + '" stroke-width="' + strokeWidth + '" stroke-linecap="round" opacity="' + (isSelected ? '1' : '0.7') + '" class="network-edge"/>\n';

      // Midpoint Broker Chip
      var mx = cpx;
      var my = cpy;
      var brokerCode = (edge.brokers && edge.brokers.length > 0) ? edge.brokers[0] : (edge.broker || '—');
      if (brokerCode && brokerCode !== '—') {
        svg += '    <g class="broker-chip cursor-pointer" onclick="BandarmologiRuntime.selectInsiderEmitenNode(\'' + escapeHtml(emNode.ticker) + '\')">\n';
        svg += '      <g class="emiten-counter-group" style="transform-origin: ' + mx.toFixed(1) + 'px ' + my.toFixed(1) + 'px;">\n';
        svg += '        <rect x="' + (mx - 18).toFixed(1) + '" y="' + (my - 11).toFixed(1) + '" width="36" height="22" rx="6" fill="#082f49" stroke="#0284c7" stroke-width="1.4"/>\n';
        svg += '        <text x="' + mx.toFixed(1) + '" y="' + (my + 4).toFixed(1) + '" fill="#38bdf8" font-size="10" font-family="monospace" font-weight="bold" text-anchor="middle">' + escapeHtml(brokerCode) + '</text>\n';
        svg += '      </g>\n';
        svg += '    </g>\n';
      }
    }

    // Render Emiten Nodes (Emerald / Green Planets) + Satellite Broker Moons
    for (var j = 0; j < numEmitens; j++) {
      var emNode2 = emitenNodes[j];
      var angle2 = -Math.PI / 2 + (2 * Math.PI * j) / (numEmitens || 1);
      var ex2 = cx + radius * Math.cos(angle2);
      var ey2 = cy + radius * Math.sin(angle2);
      var edge2 = edges.find(function (e) { return e.ticker === emNode2.ticker || e.target === emNode2.id; }) || {};

      var isSelected2 = emNode2.ticker === selectedTicker;
      var nodeFill = isSelected2 ? '#064e3b' : '#022c22';
      var nodeStroke = isSelected2 ? '#34d399' : '#10b981';
      var nodeWidth = isSelected2 ? '3.5' : '2.2';

      var pctText = edge2.percentage_raw || (edge2.percentage != null ? edge2.percentage + '%' : '—');
      var sharesShort = formatIDR(Math.abs(edge2.shares || 0));
      var brokerCode2 = (edge2.brokers && edge2.brokers.length > 0) ? edge2.brokers[0] : (edge2.broker || '—');

      svg += '    <g class="emiten-node cursor-pointer" onclick="BandarmologiRuntime.selectInsiderEmitenNode(\'' + escapeHtml(emNode2.ticker) + '\')">\n';

      // Satellite Broker Orbit around Planet
      if (brokerCode2 && brokerCode2 !== '—') {
        svg += '      <g class="satellite-orbit-group" style="transform-origin: ' + ex2.toFixed(1) + 'px ' + ey2.toFixed(1) + 'px;">\n';
        svg += '        <circle cx="' + ex2.toFixed(1) + '" cy="' + ey2.toFixed(1) + '" r="44" fill="none" stroke="#0284c7" stroke-width="0.9" stroke-dasharray="2 3" opacity="0.45"/>\n';
        svg += '        <g class="satellite-counter-group" style="transform-origin: ' + (ex2 + 44).toFixed(1) + 'px ' + ey2.toFixed(1) + 'px;">\n';
        svg += '          <circle cx="' + (ex2 + 44).toFixed(1) + '" cy="' + ey2.toFixed(1) + '" r="9.5" fill="#082f49" stroke="#38bdf8" stroke-width="1.2"/>\n';
        svg += '          <text x="' + (ex2 + 44).toFixed(1) + '" y="' + (ey2 + 3).toFixed(1) + '" fill="#38bdf8" font-size="7.5" font-family="monospace" font-weight="bold" text-anchor="middle">' + escapeHtml(brokerCode2) + '</text>\n';
        svg += '        </g>\n';
        svg += '      </g>\n';
      }

      // Counter-rotating Planet Body (keeps text readable while orbiting)
      svg += '      <g class="emiten-counter-group" style="transform-origin: ' + ex2.toFixed(1) + 'px ' + ey2.toFixed(1) + 'px;">\n';
      svg += '        <circle cx="' + ex2.toFixed(1) + '" cy="' + ey2.toFixed(1) + '" r="31" fill="' + nodeFill + '" stroke="' + nodeStroke + '" stroke-width="' + nodeWidth + '" filter="url(#glowNode)"/>\n';
      svg += '        <text x="' + ex2.toFixed(1) + '" y="' + (ey2 - 6).toFixed(1) + '" fill="#f8fafc" font-size="11" font-family="monospace" font-weight="bold" text-anchor="middle">' + escapeHtml(emNode2.ticker) + '</text>\n';
      svg += '        <text x="' + ex2.toFixed(1) + '" y="' + (ey2 + 7).toFixed(1) + '" fill="#34d399" font-size="9.5" font-family="monospace" font-weight="semibold" text-anchor="middle">' + escapeHtml(pctText) + '</text>\n';
      svg += '        <text x="' + ex2.toFixed(1) + '" y="' + (ey2 + 18).toFixed(1) + '" fill="#94a3b8" font-size="8" font-family="sans-serif" text-anchor="middle">' + escapeHtml(sharesShort) + '</text>\n';
      svg += '      </g>\n';

      svg += '    </g>\n';
    }

    svg += '  </g>\n';

    // Render Central Insider Node (Sun: Glowing Amber / Gold)
    var isForeign = String(centralNode.nationality || '').toLowerCase() === 'foreign';
    var natBadge = isForeign ? '🌐' : '🇮🇩';
    var labelName = escapeHtml(formatEntityDisplayName(centralNode.label || centralNode.name || 'Insider'));
    var emitensCount = centralNode.total_emitens != null ? centralNode.total_emitens : numEmitens;

    svg += '  <g class="central-insider-node cursor-pointer">\n';
    svg += '    <circle cx="' + cx + '" cy="' + cy + '" r="46" fill="#451a03" stroke="#f59e0b" stroke-width="3" filter="url(#glowCentral)"/>\n';
    svg += '    <circle cx="' + cx + '" cy="' + cy + '" r="39" fill="#1c1202" stroke="#b45309" stroke-width="1"/>\n';
    svg += '    <text x="' + cx + '" y="' + (cy - 11) + '" fill="#f59e0b" font-size="18" text-anchor="middle">👑</text>\n';
    svg += '    <text x="' + cx + '" y="' + (cy + 6) + '" fill="#fbbf24" font-size="11" font-weight="bold" font-family="sans-serif" text-anchor="middle">' + labelName + '</text>\n';
    svg += '    <text x="' + cx + '" y="' + (cy + 21) + '" fill="#fde68a" font-size="9" font-family="sans-serif" text-anchor="middle">' + natBadge + ' ' + emitensCount + ' Emiten</text>\n';
    svg += '  </g>\n';

    svg += '</svg>\n';
    return svg;
  }

  function renderInsiderDetailPanelHtml(graph, ticker) {
    if (!graph) return '<div class="p-4 text-center text-gray-400 text-xs">Pilih tokoh untuk melihat graf</div>';
    var edges = graph.edges || graph.links || [];
    var holding = edges.find(function (e) { return e.ticker === ticker; }) || edges[0];
    if (!holding) {
      return '<div class="p-4 text-center text-gray-400 text-xs">Pilih salah satu node emiten di kanvas.</div>';
    }

    var isBuy = String(holding.latest_action || 'BUY').toUpperCase().includes('BUY');
    var isSell = String(holding.latest_action || 'BUY').toUpperCase().includes('SELL');
    var actionBadge = isBuy
      ? '<span class="px-2.5 py-1 rounded-lg bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 font-bold text-xs flex items-center gap-1">🟢 <span>BELI</span></span>'
      : (isSell
        ? '<span class="px-2.5 py-1 rounded-lg bg-rose-500/10 border border-rose-500/30 text-rose-300 font-bold text-xs flex items-center gap-1">🔴 <span>JUAL</span></span>'
        : '<span class="px-2.5 py-1 rounded-lg bg-sky-500/10 border border-sky-500/30 text-sky-300 font-bold text-xs flex items-center gap-1">🔵 <span>TRANSFER</span></span>');

    var priceFormatted = (holding.latest_price != null && Number(holding.latest_price) > 0)
      ? 'Rp ' + formatIDR(Number(holding.latest_price))
      : '—';

    // Kepemilikan Terkini: Always non-negative
    var rawShares = holding.shares_after != null ? holding.shares_after : holding.shares;
    var absShares = Math.abs(rawShares || 0);
    var sharesFormatted = absShares > 0 ? formatNumber(absShares) + ' lembar' : '—';
    var pctFormatted = holding.percentage_raw || (holding.percentage != null ? holding.percentage + '%' : '—');

    // Rincian Broker
    var brokersList = holding.brokers || [];
    var brokersChipsHtml = '';
    if (brokersList.length > 0) {
      for (var bi = 0; bi < brokersList.length; bi++) {
        var bCode = brokersList[bi];
        brokersChipsHtml += '<span class="px-2.5 py-1 rounded-lg font-mono font-bold bg-dark-700/80 text-emerald-300 border border-dark-600 text-xs">' + escapeHtml(bCode) + '</span> ';
      }
    } else {
      brokersChipsHtml = '<span class="text-gray-500 font-mono text-xs">—</span>';
    }

    // Riwayat Aksi Terakhir
    var actionVol = Math.abs(holding.shares_change || holding.shares || 0);
    var actionVolFormatted = actionVol > 0 ? formatNumber(actionVol) + ' lembar' : '—';
    var actionTitle = isBuy ? 'Akumulasi Beli' : (isSell ? 'Distribusi Jual' : 'Aksi Transaksi');
    var actionColor = isBuy ? 'text-emerald-400' : (isSell ? 'text-rose-400' : 'text-gray-200');

    var html = '';
    html += '<div class="space-y-3.5">';

    // Card Header: Ticker + Badge + Afiliasi
    html += '  <div class="border-b border-dark-600/50 pb-3">';
    html += '    <div class="flex items-center justify-between">';
    html += '      <div class="flex items-center gap-2">';
    html += '        <span class="text-2xl font-bold font-mono text-gray-100">' + escapeHtml(holding.ticker) + '</span>';
    html += '        ' + actionBadge;
    html += '      </div>';
    html += '      <span class="text-xs font-mono font-bold text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-2.5 py-1 rounded-lg">' + escapeHtml(pctFormatted) + '</span>';
    html += '    </div>';
    html += '    <p class="text-[11px] text-gray-400 mt-1.5 flex items-center gap-1.5">';
    html += '      <span>👑</span> Tokoh: <strong class="text-gray-200">' + escapeHtml(graph.summary && graph.summary.entity_name || 'Tokoh Insider') + '</strong>';
    html += '    </p>';
    html += '  </div>';

    // 1. Executive Summary: Kepemilikan Terkini
    html += '  <div class="bg-dark-900/60 border border-dark-600/40 rounded-xl p-3.5 shadow-sm">';
    html += '    <span class="text-[10px] text-gray-400 uppercase tracking-wider font-bold block mb-2">📊 Kepemilikan Terkini</span>';
    html += '    <div class="grid grid-cols-2 gap-2.5 text-xs">';
    html += '      <div>';
    html += '        <span class="text-[10px] text-gray-400 block">Total Saham:</span>';
    html += '        <strong class="font-mono text-gray-100 text-xs">' + escapeHtml(sharesFormatted) + '</strong>';
    html += '      </div>';
    html += '      <div>';
    html += '        <span class="text-[10px] text-gray-400 block">Porsi Saham:</span>';
    html += '        <strong class="font-mono text-emerald-400 text-xs">' + escapeHtml(pctFormatted) + '</strong>';
    html += '      </div>';
    html += '    </div>';
    html += '  </div>';

    // 2. Executive Summary: Rincian Broker Terlibat
    html += '  <div class="bg-dark-900/60 border border-dark-600/40 rounded-xl p-3.5 shadow-sm">';
    html += '    <span class="text-[10px] text-gray-400 uppercase tracking-wider font-bold block mb-2">💼 Rincian Broker Terlibat</span>';
    html += '    <div class="flex flex-wrap items-center gap-1.5">';
    html += '      ' + brokersChipsHtml;
    html += '    </div>';
    html += '  </div>';

    // 3. Executive Summary: Riwayat Aksi Terakhir
    html += '  <div class="bg-dark-900/60 border border-dark-600/40 rounded-xl p-3.5 shadow-sm">';
    html += '    <span class="text-[10px] text-gray-400 uppercase tracking-wider font-bold block mb-2">⚡ Riwayat Aksi Terakhir</span>';
    html += '    <div class="space-y-1.5 text-xs">';
    html += '      <div class="flex items-center justify-between">';
    html += '        <span class="text-gray-400">Aksi &amp; Volume:</span>';
    html += '        <span class="font-mono font-bold ' + actionColor + '">' + actionTitle + ' (' + escapeHtml(actionVolFormatted) + ')</span>';
    html += '      </div>';
    html += '      <div class="flex items-center justify-between">';
    html += '        <span class="text-gray-400">Harga Pelaksanaan:</span>';
    html += '        <strong class="font-mono text-gray-200">' + escapeHtml(priceFormatted) + '</strong>';
    html += '      </div>';
    html += '      <div class="flex items-center justify-between">';
    html += '        <span class="text-gray-400">Tanggal Transaksi:</span>';
    html += '        <strong class="font-mono text-gray-300">' + escapeHtml(holding.latest_date || '—') + '</strong>';
    html += '      </div>';
    html += '    </div>';
    html += '  </div>';

    // Action Button
    html += '  <div class="pt-2">';
    html += '    <button type="button" onclick="BandarmologiRuntime.analyzeInsiderTicker(\'' + escapeHtml(holding.ticker) + '\')" class="w-full py-2.5 px-4 rounded-xl bg-emerald-500 hover:bg-emerald-400 text-dark-900 font-bold text-xs flex items-center justify-center gap-2 shadow-lg shadow-emerald-500/20 transition">';
    html += '      <span>🔍</span><span>Analisis Saham ' + escapeHtml(holding.ticker) + '</span>';
    html += '    </button>';
    html += '  </div>';

    html += '</div>';
    return html;
  }

  function renderInsiderNetworkUI(container, data) {
    if (!container) return;
    injectBubbleStyles();

    if (!activeInsiderNetworkEntity) {
      activeInsiderNetworkEntity = 'Belvin Tannadi';
    }

    var html = '';

    // 1. Header & Deskripsi
    html += '<div class="bg-dark-800/80 border border-dark-600/40 rounded-xl p-4 mb-4 shadow-lg backdrop-blur">';
    html += '  <div class="flex flex-wrap items-center justify-between gap-3">';
    html += '    <div>';
    html += '      <h3 class="text-sm font-bold text-gray-100 flex items-center gap-2">';
    html += '        <span class="text-base">🕸️</span> Visualisasi Jejaring Relasi Insider &amp; Pemegang Saham Multi-Emiten';
    html += '      </h3>';
    html += '      <p class="text-xs text-gray-400 mt-0.5">Eksplorasi kepemilikan saham lintas emiten para investor besar, tokoh pasar modal, dan institusi terkemuka.</p>';
    html += '    </div>';
    html += '    <div class="flex items-center gap-2">';
    html += '      <span class="text-[11px] text-emerald-400 bg-emerald-500/10 border border-emerald-500/30 px-2.5 py-1 rounded-full font-semibold">⚡ Interactive Radial Graph</span>';
    html += '    </div>';
    html += '  </div>';
    html += '</div>';

    // 2. Search Bar + Autocomplete & Quick Chips
    html += '<div class="bg-dark-800/90 border border-dark-600/50 rounded-xl p-4 mb-4 shadow-md">';
    html += '  <div class="relative w-full max-w-2xl mb-2">';
    html += '    <div class="relative flex items-center">';
    html += '      <span class="absolute left-3.5 text-gray-400 text-sm">🔍</span>';
    html += '      <input id="insiderSearchInput" type="text" value="' + escapeHtml(activeInsiderNetworkEntity) + '" placeholder="Cari nama insider/tokoh (cth: Belvin Tannadi, Prajogo Pangestu, Haji Isam, Garibaldi Thohir)..." oninput="BandarmologiRuntime.handleInsiderSearchInput(this.value)" class="w-full bg-dark-900 border border-dark-600 rounded-xl pl-11 pr-10 py-2.5 text-xs text-gray-100 placeholder-gray-500 focus:outline-none focus:border-emerald-500 focus:ring-1 focus:ring-emerald-500 transition" style="padding-left: 2.75rem;">';
    html += '      <button type="button" id="btnClearInsiderSearch" onclick="BandarmologiRuntime.clearInsiderSearch()" class="absolute right-3 text-gray-400 hover:text-gray-200 text-xs px-1" style="display: none;">✕</button>';
    html += '    </div>';
    html += '    <div id="insiderSearchDropdown" class="w-full mt-2 mb-2 bg-dark-900 border border-dark-600/80 rounded-xl shadow-xl overflow-hidden" style="display: none; max-height: 280px; overflow-y: auto;"></div>';
    html += '  </div>';

    // Quick Chips Tokoh Populer
    html += '  <div class="flex flex-wrap items-center gap-2 pt-1">';
    html += '    <span class="text-[11px] text-gray-400 font-medium">Tokoh Populer:</span>';
    var popularEntities = ['Belvin Tannadi', 'Prajogo Pangestu', 'Haji Isam', 'Garibaldi Thohir', 'Lo Kheng Hong', 'Anthoni Salim', 'BlackRock Inc.'];
    for (var p = 0; p < popularEntities.length; p++) {
      var popName = popularEntities[p];
      var isCur = popName.toLowerCase() === activeInsiderNetworkEntity.toLowerCase();
      var chipClass = isCur
        ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40 font-bold'
        : 'bg-dark-700/70 text-gray-300 border-dark-600/60 hover:text-emerald-300 hover:border-emerald-500/40 hover:bg-emerald-500/10';
      html += '    <button type="button" onclick="BandarmologiRuntime.selectInsiderQuickChip(\'' + escapeHtml(popName) + '\')" class="px-3 py-1 rounded-full text-xs font-medium border transition ' + chipClass + '">' + escapeHtml(popName) + '</button>';
    }
    html += '  </div>';
    html += '</div>';

    // 3. Grid Canvas (Left 8 cols) & Detail (Right 4 cols)
    html += '<div class="grid grid-cols-1 lg:grid-cols-12 gap-4">';
    html += '  <div class="lg:col-span-8 bg-dark-900/80 border border-dark-600/40 rounded-xl p-4 flex flex-col items-center justify-center relative min-h-[640px] overflow-hidden">';
    html += '    <div class="w-full flex items-center justify-between text-[11px] text-gray-400 mb-2 px-2">';
    html += '      <span class="flex items-center gap-1.5 font-mono"><span class="w-2 h-2 rounded-full bg-emerald-400 animate-pulse"></span>Kanvas Relasi Aktif: <strong id="activeGraphEntityTitle" class="text-gray-200">' + escapeHtml(activeInsiderNetworkEntity) + '</strong></span>';
    html += '      <span class="text-[10px] text-gray-500">Klik node emiten untuk rincian</span>';
    html += '    </div>';
    html += '    <div id="insiderGraphSvgWrap" class="w-full h-full flex items-center justify-center">';

    // Initial graph generation
    var graph = getEffectiveInsiderGraph(activeInsiderNetworkEntity);
    currentInsiderNetworkGraph = graph;
    if (!activeInsiderNetworkSelectedTicker && graph && graph.edges && graph.edges.length > 0) {
      activeInsiderNetworkSelectedTicker = graph.edges[0].ticker;
    }
    html += renderInsiderNetworkSvg(graph, activeInsiderNetworkSelectedTicker);

    html += '    </div>';
    html += '  </div>';

    // Detail Panel
    html += '  <div class="lg:col-span-4 bg-dark-800/90 border border-dark-600/50 rounded-xl p-4 flex flex-col justify-between">';
    html += '    <div id="insiderDetailPanel">';
    html += renderInsiderDetailPanelHtml(graph, activeInsiderNetworkSelectedTicker);
    html += '    </div>';
    html += '  </div>';
    html += '</div>';

    container.innerHTML = html;

    fetchRemoteInsiderGraph(activeInsiderNetworkEntity, function (remoteGraph) {
      if (remoteGraph && remoteGraph.nodes && remoteGraph.nodes.length > 0) {
        currentInsiderNetworkGraph = remoteGraph;
        if (!activeInsiderNetworkSelectedTicker && remoteGraph.edges && remoteGraph.edges.length > 0) {
          activeInsiderNetworkSelectedTicker = remoteGraph.edges[0].ticker;
        }
        var w = byId('insiderGraphSvgWrap');
        if (w) {
          w.innerHTML = renderInsiderNetworkSvg(remoteGraph, activeInsiderNetworkSelectedTicker);
        }
        var p = byId('insiderDetailPanel');
        if (p) {
          p.innerHTML = renderInsiderDetailPanelHtml(remoteGraph, activeInsiderNetworkSelectedTicker);
        }
      }
    });
  }

  function handleInsiderSearchInput(query) {
    var dd = byId('insiderSearchDropdown');
    var btnClear = byId('btnClearInsiderSearch');
    if (!query || String(query).trim().length < 2) {
      if (dd) dd.style.display = 'none';
      if (btnClear) btnClear.style.display = 'none';
      return;
    }
    if (btnClear) btnClear.style.display = 'block';

    var results = getEffectiveSearchInsiders(query, { limit: 5 });
    if (!dd) return;

    if (!results || results.length === 0) {
      dd.innerHTML = '<div class="p-3 text-center text-xs text-gray-400">Tidak ditemukan tokoh dengan nama "' + escapeHtml(query) + '"</div>';
      dd.style.display = 'block';
      return;
    }

    var html = '';
    for (var r = 0; r < results.length; r++) {
      var item = results[r];
      var displayName = formatEntityDisplayName(item.name);
      var isForeign = String(item.nationality || '').toLowerCase() === 'foreign';
      var natBadge = isForeign ? '🌐 Foreign' : '🇮🇩 Local';
      var tickersHtml = (item.tickers || []).map(function (t) {
        return '<span class="text-[10px] font-mono px-1.5 py-0.5 rounded bg-dark-900 border border-dark-600 text-emerald-400">' + escapeHtml(t) + '</span>';
      }).join(' ');

      html += '<div class="p-2.5 hover:bg-dark-700/60 cursor-pointer border-b border-dark-700/40 last:border-b-0 transition flex items-center justify-between" data-insider-name="' + escapeHtml(displayName) + '" onclick="BandarmologiRuntime.selectInsiderSearchResult(this.getAttribute(\'data-insider-name\'))">';
      html += '  <div>';
      html += '    <div class="flex items-center gap-2">';
      html += '      <span class="text-xs font-bold text-gray-100">' + escapeHtml(displayName) + '</span>';
      html += '      <span class="text-[10px] text-gray-400">' + natBadge + '</span>';
      html += '    </div>';
      html += '    <div class="flex items-center gap-1 mt-1">' + tickersHtml + '</div>';
      html += '  </div>';
      html += '  <span class="text-[11px] font-mono font-semibold text-emerald-400 bg-emerald-500/10 px-2 py-0.5 rounded border border-emerald-500/20">' + item.total_emitens + ' Emiten</span>';
      html += '</div>';
    }

    dd.innerHTML = html;
    dd.style.display = 'block';
  }

  function selectInsiderSearchResult(name) {
    activeInsiderNetworkEntity = name;
    var input = byId('insiderSearchInput');
    if (input) input.value = name;
    var dd = byId('insiderSearchDropdown');
    if (dd) dd.style.display = 'none';
    renderInsiderNetworkGraph(name);
  }

  function selectInsiderQuickChip(name) {
    activeInsiderNetworkEntity = name;
    var input = byId('insiderSearchInput');
    if (input) input.value = name;
    var dd = byId('insiderSearchDropdown');
    if (dd) dd.style.display = 'none';
    renderInsiderNetworkGraph(name);
  }

  function clearInsiderSearch() {
    var input = byId('insiderSearchInput');
    if (input) input.value = '';
    var dd = byId('insiderSearchDropdown');
    if (dd) dd.style.display = 'none';
    var btnClear = byId('btnClearInsiderSearch');
    if (btnClear) btnClear.style.display = 'none';
  }

  function renderInsiderNetworkGraph(name) {
    activeInsiderNetworkEntity = name;
    var graph = getEffectiveInsiderGraph(name);
    currentInsiderNetworkGraph = graph;
    if (graph && graph.edges && graph.edges.length > 0) {
      activeInsiderNetworkSelectedTicker = graph.edges[0].ticker;
    } else {
      activeInsiderNetworkSelectedTicker = null;
    }

    var titleEl = byId('activeGraphEntityTitle');
    if (titleEl) {
      titleEl.textContent = name;
    }

    var wrap = byId('insiderGraphSvgWrap');
    if (wrap) {
      wrap.innerHTML = renderInsiderNetworkSvg(graph, activeInsiderNetworkSelectedTicker);
    }

    var panel = byId('insiderDetailPanel');
    if (panel) {
      panel.innerHTML = renderInsiderDetailPanelHtml(graph, activeInsiderNetworkSelectedTicker);
    }

    fetchRemoteInsiderGraph(name, function (remoteGraph) {
      if (remoteGraph && remoteGraph.nodes && remoteGraph.nodes.length > 0 && String(activeInsiderNetworkEntity).toLowerCase() === String(name).toLowerCase()) {
        currentInsiderNetworkGraph = remoteGraph;
        if (!activeInsiderNetworkSelectedTicker && remoteGraph.edges && remoteGraph.edges.length > 0) {
          activeInsiderNetworkSelectedTicker = remoteGraph.edges[0].ticker;
        }
        var w = byId('insiderGraphSvgWrap');
        if (w) {
          w.innerHTML = renderInsiderNetworkSvg(remoteGraph, activeInsiderNetworkSelectedTicker);
        }
        var p = byId('insiderDetailPanel');
        if (p) {
          p.innerHTML = renderInsiderDetailPanelHtml(remoteGraph, activeInsiderNetworkSelectedTicker);
        }
      }
    });
  }

  function selectInsiderEmitenNode(ticker) {
    activeInsiderNetworkSelectedTicker = ticker;
    var wrap = byId('insiderGraphSvgWrap');
    if (wrap && currentInsiderNetworkGraph) {
      wrap.innerHTML = renderInsiderNetworkSvg(currentInsiderNetworkGraph, activeInsiderNetworkSelectedTicker);
    }
    var panel = byId('insiderDetailPanel');
    if (panel && currentInsiderNetworkGraph) {
      panel.innerHTML = renderInsiderDetailPanelHtml(currentInsiderNetworkGraph, activeInsiderNetworkSelectedTicker);
    }
  }

  function analyzeInsiderTicker(ticker) {
    if (!ticker) return;
    var clean = String(ticker).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!clean) return;
    setBandarSection('summary');
    var input = byId('bandarTickerInput') || byId('activeTickerInput');
    if (input) input.value = clean;
    if (root.UnifiedCockpit && typeof root.UnifiedCockpit.syncActiveTicker === 'function') {
      root.UnifiedCockpit.syncActiveTicker(clean, {
        loadChart: true,
        forceChartReload: false,
        preserveTab: false,
        runAnalysis: true
      });
    }
    if (root && typeof root.loadBandarmologiTab === 'function') {
      root.loadBandarmologiTab(clean);
    } else if (typeof loadBandarmologiTab === 'function') {
      loadBandarmologiTab(clean);
    }
  }

  function formatDateDisplay(dateStr) {
    if (!dateStr) return 'Terbaru';
    try {
      var d = new Date(dateStr);
      if (isNaN(d.getTime())) return String(dateStr);
      return d.toLocaleDateString('id-ID', { day: '2-digit', month: 'short', year: 'numeric' });
    } catch (_) {
      return String(dateStr);
    }
  }

  function renderConfluenceBadgeHtml(badge) {
    var b = String(badge || 'NEUTRAL').toUpperCase();
    if (b === 'STRONG_ACCUMULATION') {
      return '<span class="px-2.5 py-0.5 rounded-lg bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-bold text-xs">🔥 SANGAT KUAT (BULLISH CONFLUENCE)</span>';
    }
    if (b === 'ACCUMULATION') {
      return '<span class="px-2.5 py-0.5 rounded-lg bg-emerald-500/10 text-emerald-400 border border-emerald-500/30 font-bold text-xs">🟢 AKUMULASI (BULLISH)</span>';
    }
    if (b === 'DISTRIBUTION') {
      return '<span class="px-2.5 py-0.5 rounded-lg bg-rose-500/10 text-rose-400 border border-rose-500/30 font-bold text-xs">🔴 DISTRIBUSI (BEARISH)</span>';
    }
    return '<span class="px-2.5 py-0.5 rounded-lg bg-dark-600/40 text-gray-300 border border-dark-500 font-bold text-xs">⚪ NETRAL / TERSEBAR</span>';
  }

  function updateIntelSearchBarVisibility() {
    if (typeof document === 'undefined') return;
    var searchContainer = byId('intelSearchBarContainer');
    if (searchContainer) {
      searchContainer.style.display = (bandarIntelViewMode === 'scanner') ? 'none' : '';
    }
  }

  function setBandarIntelViewMode(mode) {
    bandarIntelViewMode = (mode === 'scanner') ? 'scanner' : 'ticker';
    updateIntelSearchBarVisibility();
    var container = byId('bandarmologiIntelContent') || byId('bandarmologiContent');
    if (bandarIntelViewMode === 'scanner' && !bandarIntelScannerData && !bandarIntelLoading && typeof fetch !== 'undefined') {
      loadBandarmologiIntel(currentBandarTicker, container);
    } else if (container) {
      renderBandarmologiIntelUI(container, currentBandarTicker);
    }
  }

  function setBandarIntelRange(range) {
    var validRanges = ['1d', '5d', '7d', '14d', '30d', '60d'];
    bandarIntelRange = validRanges.includes(String(range).toLowerCase()) ? String(range).toLowerCase() : '7d';
    bandarIntelData = null;
    bandarIntelScannerData = null;
    var container = byId('bandarmologiIntelContent') || byId('bandarmologiContent');
    if (typeof fetch !== 'undefined') {
      loadBandarmologiIntel(currentBandarTicker, container);
    } else if (container) {
      renderBandarmologiIntelUI(container, currentBandarTicker);
    }
  }

  function setBandarIntelScannerCategory(cat) {
    bandarIntelScannerCategory = cat || 'harga_di_bawah_modal_bandar';
    var container = byId('bandarmologiIntelContent') || byId('bandarmologiContent');
    if (container) {
      renderBandarmologiIntelUI(container, currentBandarTicker);
    }
  }

  function selectIntelTicker(ticker) {
    if (!ticker) return;
    var clean = String(ticker).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!clean) return;
    brokerFlowFilter = 'all';
    currentBandarTicker = clean;
    bandarIntelTicker = clean;
    bandarIntelViewMode = 'ticker';
    bandarIntelData = null;

    if (root.UnifiedCockpit && typeof root.UnifiedCockpit.syncActiveTicker === 'function') {
      root.UnifiedCockpit.syncActiveTicker(clean, {
        loadChart: true,
        forceChartReload: false,
        preserveTab: true,
        runAnalysis: false
      });
    }

    var badgeTicker = byId('bandarActiveTickerTag');
    if (badgeTicker) badgeTicker.textContent = clean;
    var inpBandar = byId('bandarTickerSearchInput');
    if (inpBandar) inpBandar.value = clean;

    var container = byId('bandarmologiIntelContent') || byId('bandarmologiContent');
    if (typeof fetch !== 'undefined') {
      loadBandarmologiIntel(clean, container);
    } else if (container) {
      renderBandarmologiIntelUI(container, clean);
    }
  }

  async function loadBandarmologiIntel(ticker, targetContainer) {
    if (activeIntelAbortController) {
      try { activeIntelAbortController.abort(); } catch (_) {}
      activeIntelAbortController = null;
    }

    var thisRequestSeq = ++intelRequestSeq;
    bandarIntelLoading = true;
    bandarIntelError = null;
    var targetTicker = String(ticker || currentBandarTicker || 'BBCA').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!targetTicker) targetTicker = 'BBCA';
    currentBandarTicker = targetTicker;
    bandarIntelTicker = targetTicker;

    var container = targetContainer || ((typeof document !== 'undefined') ? (byId('bandarmologiIntelContent') || byId('bandarmologiContent')) : null);
    if (container) {
      renderBandarmologiIntelUI(container, targetTicker);
    }

    if (typeof fetch === 'undefined') {
      bandarIntelLoading = false;
      return;
    }

    var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    activeIntelAbortController = controller;
    var timer = controller ? setTimeout(function () {
      try { controller.abort(); } catch (_) {}
    }, 10000) : null;

    try {
      var url = '/api/sector-hot?action=bandarmologi-intel&range=' + encodeURIComponent(bandarIntelRange);
      if (bandarIntelViewMode === 'ticker') {
        url += '&ticker=' + encodeURIComponent(targetTicker);
      }
      var fetchOpts = controller ? { signal: controller.signal } : {};
      var resp = await fetch(url, fetchOpts);
      if (timer) clearTimeout(timer);
      if (thisRequestSeq !== intelRequestSeq) return;

      var json = await resp.json();
      if (thisRequestSeq !== intelRequestSeq) return;

      if (json && json.success) {
        if (bandarIntelViewMode === 'ticker') {
          bandarIntelData = json;
        } else {
          bandarIntelScannerData = json;
        }
      } else if (bandarIntelViewMode === 'scanner') {
        // Scanner cache-miss: store the response so UI shows empty categories instead of spinning
        bandarIntelScannerData = json || {};
      } else {
        bandarIntelError = (json && json.error) || 'Gagal memuat data Sinyal Intelijen Bandar.';
      }
    } catch (err) {
      if (timer) clearTimeout(timer);
      if (thisRequestSeq !== intelRequestSeq) return;
      if (err && (err.name === 'AbortError' || String(err.message).includes('aborted'))) {
        bandarIntelError = 'Permintaan dibatalkan atau waktu kalkulasi melebihi batas (10s). Silakan coba lagi.';
      } else {
        bandarIntelError = err.message || String(err);
      }
    } finally {
      if (timer) clearTimeout(timer);
      bandarIntelLoading = false;
      activeIntelAbortController = null;
      if (thisRequestSeq === intelRequestSeq && container) {
        renderBandarmologiIntelUI(container, targetTicker);
      }
    }
  }

  function renderBandarmologiIntelUI(container, dataOrTicker) {
    container = container || ((typeof document !== 'undefined') ? (byId('bandarmologiIntelContent') || byId('bandarmologiContent')) : null);
    if (!container) return;

    if (dataOrTicker && typeof dataOrTicker === 'object') {
      var objTicker = dataOrTicker.ticker || (dataOrTicker.result && dataOrTicker.result.ticker);
      if (objTicker) {
        currentBandarTicker = String(objTicker).trim().toUpperCase();
        bandarIntelTicker = currentBandarTicker;
      }
      if (dataOrTicker.signals || (dataOrTicker.result && dataOrTicker.result.signals)) {
        bandarIntelData = dataOrTicker;
        bandarIntelViewMode = 'ticker';
        bandarIntelLoading = false;
        bandarIntelError = null;
      } else if (dataOrTicker.summary || dataOrTicker.indexes) {
        bandarIntelScannerData = dataOrTicker;
        bandarIntelViewMode = 'scanner';
        bandarIntelLoading = false;
        bandarIntelError = null;
      }
    } else if (typeof dataOrTicker === 'string' && dataOrTicker) {
      currentBandarTicker = String(dataOrTicker).trim().toUpperCase();
      bandarIntelTicker = currentBandarTicker;
    }

    updateIntelSearchBarVisibility();

    if (bandarIntelViewMode === 'ticker') {
      var cachedObj = (bandarIntelData && bandarIntelData.result) || bandarIntelData || {};
      var cachedTicker = (bandarIntelData && bandarIntelData.ticker) || cachedObj.ticker;
      if (cachedTicker && cachedTicker !== currentBandarTicker) {
        bandarIntelData = null;
      }
    }

    var hasTargetData = (bandarIntelViewMode === 'scanner') ? Boolean(bandarIntelScannerData) : Boolean(bandarIntelData);
    if (!hasTargetData && !bandarIntelLoading && !bandarIntelError && typeof fetch !== 'undefined') {
      loadBandarmologiIntel(currentBandarTicker, container);
    }

    var html = '';

    // SECTION TABS: Only render inline switcher if external subTabBrokerSummary is absent
    if (!byId('subTabBrokerSummary')) {
      html += '<div class="flex items-center gap-1 bg-dark-800 p-0.5 rounded-lg border border-dark-600/50 text-xs mb-4 w-fit">';
      html += '  <button type="button" onclick="BandarmologiRuntime.setBandarSection(\'summary\')" class="px-3 py-1.5 rounded-md transition ' + (bandarSection === 'summary' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium') + '">📊 Broker Summary</button>';
      html += '  <button type="button" onclick="BandarmologiRuntime.setBandarSection(\'akumulasi\')" class="px-3 py-1.5 rounded-md transition ' + (bandarSection === 'akumulasi' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium') + '">📈 Akumulasi Broker</button>';
      html += '  <button type="button" onclick="BandarmologiRuntime.setBandarSection(\'intel\')" class="px-3 py-1.5 rounded-md transition ' + (bandarSection === 'intel' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium') + '">🎯 Sinyal Intelijen</button>';
      html += '</div>';
    }

    // Subheader Controls Card
    html += '<div class="bg-dark-800/80 border border-dark-600/40 rounded-xl p-4 mb-4 shadow-lg backdrop-blur">';
    html += '  <div class="flex flex-wrap items-center justify-between gap-3">';
    html += '    <div>';
    html += '      <h3 class="text-sm font-bold text-gray-100 flex items-center gap-2">';
    html += '        <span class="text-base">🎯</span> Sinyal Intelijen Bandarmologi — <span class="text-emerald-400 font-mono">' + escapeHtml(currentBandarTicker) + '</span>';
    html += '      </h3>';
    html += '      <p class="text-xs text-gray-400 mt-0.5">Deteksi 4 pola strategis: modal bandar, akumulasi diam-diam asing, pertukaran ritel &amp; bandar, dan rasio konsentrasi (CR3/CR5).</p>';
    html += '    </div>';
    html += '    <div class="flex flex-wrap items-center gap-2">';
    // View Switcher (Ticker vs Scanner)
    html += '      <div class="flex items-center gap-1 bg-dark-900 p-0.5 rounded-lg border border-dark-600/50 text-[11px]">';
    html += '        <button type="button" id="btnIntelModeTicker" onclick="BandarmologiRuntime.setBandarIntelViewMode(\'ticker\')" class="px-2.5 py-1 rounded-md transition ' + (bandarIntelViewMode === 'ticker' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium') + '">🎯 Emiten Aktif</button>';
    html += '        <button type="button" id="btnIntelModeScanner" onclick="BandarmologiRuntime.setBandarIntelViewMode(\'scanner\')" class="px-2.5 py-1 rounded-md transition ' + (bandarIntelViewMode === 'scanner' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium') + '">🌐 Market Scanner</button>';
    html += '      </div>';
    // Range Switcher (1d, 5d, 7d, 14d, 30d, 60d)
    html += '      <div class="flex items-center gap-1 bg-dark-900 p-0.5 rounded-lg border border-dark-600/50 text-[11px]">';
    html += '        <span class="text-[10px] text-gray-400 font-medium px-1.5 uppercase tracking-wider">Rentang:</span>';
    var intelRangeList = [
      { key: '1d', label: '1D', id: 'btnIntelRange1d' },
      { key: '5d', label: '5D', id: 'btnIntelRange5d' },
      { key: '7d', label: '7D', id: 'btnIntelRange7d' },
      { key: '14d', label: '14D', id: 'btnIntelRange14d' },
      { key: '30d', label: '30D', id: 'btnIntelRange30d' },
      { key: '60d', label: '60D', id: 'btnIntelRange60d' }
    ];
    for (var ir = 0; ir < intelRangeList.length; ir++) {
      var rg = intelRangeList[ir];
      var isRgActive = bandarIntelRange === rg.key;
      html += '        <button type="button" id="' + rg.id + '" onclick="BandarmologiRuntime.setBandarIntelRange(\'' + rg.key + '\')" class="px-2 py-1 rounded-md transition ' + (isRgActive ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium') + '">' + rg.label + '</button>';
    }
    html += '      </div>';
    // Refresh Button
    html += '      <button type="button" onclick="BandarmologiRuntime.loadBandarmologiIntel()" class="px-3 py-1.5 rounded-lg bg-dark-700 hover:bg-dark-600 text-gray-200 border border-dark-600 text-xs font-semibold flex items-center gap-1.5 transition" title="Refresh sinyal intelijen">';
    html += '        <span>🔄 Refresh</span>';
    html += '      </button>';
    html += '    </div>';
    html += '  </div>';
    html += '</div>';

    // Loading State
    if (bandarIntelLoading) {
      html += '<div class="flex flex-col items-center justify-center py-16 bg-dark-800/40 rounded-xl border border-dark-700/30">';
      html += '  <div class="spinner mb-3"></div>';
      html += '  <p class="text-xs text-gray-300 font-medium">Menganalisis 4 Sinyal Intelijen Bandar ' + escapeHtml(currentBandarTicker) + '...</p>';
      html += '  <p class="text-[11px] text-gray-500 mt-1">Menghitung modal rata-rata bandar, flow asing tenang, rasio ritel, &amp; konsentrasi CR3/CR5...</p>';
      html += '</div>';
      container.innerHTML = html;
      return;
    }

    // Error State
    if (bandarIntelError) {
      html += '<div class="bg-dark-800/60 border border-dark-600/30 rounded-xl p-6 text-center my-4">';
      html += '  <span class="text-2xl mb-1 block">⚠️</span>';
      html += '  <p class="text-sm text-gray-200 font-semibold mb-1">Data intelijen emiten belum tersedia</p>';
      html += '  <p class="text-xs text-gray-400 mb-3">' + escapeHtml(bandarIntelError) + '</p>';
      html += '  <button type="button" onclick="BandarmologiRuntime.loadBandarmologiIntel()" class="px-3.5 py-1.5 rounded-lg bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 text-xs font-semibold hover:bg-emerald-500/30 transition">Coba Lagi</button>';
      html += '</div>';
      container.innerHTML = html;
      return;
    }

    // View 1: Active Ticker View
    if (bandarIntelViewMode === 'ticker') {
      var intelObj = (bandarIntelData && bandarIntelData.result) || bandarIntelData || {};
      var signals = intelObj.signals || {};
      var s1 = signals.harga_di_bawah_modal_bandar || {};
      var s2 = signals.silent_foreign_accumulation || {};
      var s3 = signals.ritel_cutloss_vs_bandar || {};
      var s4 = signals.concentration_ratio || {};

      var s1HasData = s1 && s1.reason !== 'NO_DATA';
      var s2HasData = s2 && s2.reason !== 'NO_DATA';
      var s3HasData = s3 && s3.reason !== 'NO_DATA';
      var s4HasData = s4 && s4.reason !== 'NO_DATA';
      var hasAnySignalData = intelObj.has_data !== false && (s1HasData || s2HasData || s3HasData || s4HasData);

      if (!hasAnySignalData && (intelObj.has_data === false || (!s1.signal_key && !s2.signal_key))) {
        html += '<div class="bg-dark-800/40 border border-dark-600/30 rounded-xl p-8 text-center my-4">';
        html += '  <span class="text-3xl mb-2 block">🎯</span>';
        html += '  <h4 class="text-sm font-bold text-gray-200 mb-1">Data intelijen emiten belum tersedia</h4>';
        html += '  <p class="text-xs text-gray-400 max-w-md mx-auto">Data transaksi broker summary dan kalkulasi sinyal intelijen untuk emiten <strong class="text-emerald-400 font-mono">' + escapeHtml(currentBandarTicker) + '</strong> belum tercatat di bursa atau sedang dalam proses sinkronisasi.</p>';
        html += '</div>';
        container.innerHTML = html;
        return;
      }

      var confluenceBadge = intelObj.confluence_badge || 'NEUTRAL';
      var bullishCount = intelObj.bullish_signals_count || 0;
      var bearishCount = intelObj.bearish_signals_count || 0;

      // Top Confluence Summary Banner
      html += '<div class="bg-dark-700/40 border border-dark-600/30 rounded-xl p-3.5 mb-4 flex flex-wrap items-center justify-between gap-3">';
      html += '  <div class="flex items-center gap-3">';
      html += '    <div class="w-11 h-11 rounded-xl flex items-center justify-center font-mono font-bold text-base bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">';
      html += escapeHtml(intelObj.ticker || currentBandarTicker);
      html += '    </div>';
      html += '    <div>';
      html += '      <div class="flex items-center gap-2">';
      html += '        <h4 class="text-sm font-bold text-gray-100">Status Konfluensi Bandar</h4>';
      html += '        ' + renderConfluenceBadgeHtml(confluenceBadge);
      html += '      </div>';
      html += '      <div class="text-[11px] text-gray-400 mt-0.5">';
      html += '        <span>Rentang: <strong class="text-gray-200">' + escapeHtml(bandarIntelRange.toUpperCase()) + '</strong></span> &bull; ';
      html += '        <span>Evaluasi: <strong class="text-gray-300 font-mono">' + escapeHtml(formatDateDisplay(intelObj.evaluated_at)) + '</strong></span>';
      html += '      </div>';
      html += '    </div>';
      html += '  </div>';
      html += '  <div class="flex items-center gap-2">';
      html += '    <span class="px-2.5 py-1 rounded-lg bg-emerald-500/10 text-emerald-300 border border-emerald-500/30 text-xs font-semibold flex items-center gap-1">';
      html += '      <span>🟢</span> <span>' + bullishCount + ' Bullish</span>';
      html += '    </span>';
      html += '    <span class="px-2.5 py-1 rounded-lg bg-rose-500/10 text-rose-300 border border-rose-500/30 text-xs font-semibold flex items-center gap-1">';
      html += '      <span>🔴</span> <span>' + bearishCount + ' Bearish</span>';
      html += '    </span>';
      html += '  </div>';
      html += '</div>';

      // 4 Signal Cards Grid
      html += '<div class="grid grid-cols-1 md:grid-cols-2 gap-3 mb-3.5">';

      // Card 1: Harga di Bawah Modal Bandar
      html += '  <div id="intelCardHargaModal" class="bg-dark-700/40 border border-dark-600/30 rounded-xl p-3.5 flex flex-col justify-between shadow-sm">';
      html += '    <div>';
      html += '      <div class="flex items-center justify-between gap-2 mb-2 pb-1.5 border-b border-dark-600/30">';
      html += '        <h4 class="text-xs font-bold text-gray-200 flex items-center gap-1.5"><span class="text-sm">🏷️</span> Harga di Bawah Modal Bandar</h4>';
      var currentPrice = s1.current_price || s1.close_price || 0;
      // Backend returns bandar_avg_buy (not bandar_avg_price or avg_buy_price)
      var bandarAvg = s1.bandar_avg_buy || s1.bandar_avg_price || s1.avg_buy_price || 0;
      var discount = s1.discount_pct != null ? s1.discount_pct : (bandarAvg > 0 && currentPrice > 0 ? Number((((bandarAvg - currentPrice) / bandarAvg) * 100).toFixed(2)) : 0);
      var isSweetSpot = (discount > 0.0 && discount <= 5.0) && (s1.in_sweet_spot || s1.is_sweet_spot);

      if (isSweetSpot) {
        html += '        <span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">🎯 SWEET SPOT (&le; 5% Diskon)</span>';
      } else if (discount > 5.0 || s1.triggered) {
        html += '        <span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">🟢 DI BAWAH MODAL</span>';
      } else {
        html += '        <span class="px-2 py-0.5 rounded text-[10px] font-bold bg-dark-600/40 text-gray-400 border border-dark-600">⚪ DI ATAS MODAL</span>';
      }
      html += '      </div>';

      html += '      <div class="grid grid-cols-3 gap-2 text-xs mb-2 bg-dark-800/60 p-2 rounded-lg border border-dark-600/20">';
      html += '        <div><span class="text-[10px] text-gray-400 block">Harga Sekarang</span><span class="font-mono font-bold text-gray-100">' + (currentPrice > 0 ? 'Rp ' + formatNumber(currentPrice) : '—') + '</span></div>';
      html += '        <div><span class="text-[10px] text-gray-400 block">Avg Buy Bandar</span><span class="font-mono font-bold text-emerald-300">' + (bandarAvg > 0 ? 'Rp ' + formatNumber(bandarAvg) : '—') + '</span></div>';
      html += '        <div><span class="text-[10px] text-gray-400 block">Diskon vs Bandar</span><span class="font-mono font-bold ' + (discount > 0 ? 'text-emerald-400' : 'text-gray-400') + '">' + (discount > 0 ? '+' : '') + discount + '%</span></div>';
      html += '      </div>';

      // Backend returns top_3_brokers (not top_broker_details or top_brokers)
      var topBrokers = s1.top_3_brokers || s1.top_broker_details || s1.top_brokers || [];

      if (topBrokers.length > 0) {
        html += '      <div class="mb-2">';
        html += '        <span class="text-[10px] text-gray-400 uppercase tracking-wider block mb-1">Top 3 Broker Akumulator:</span>';
        html += '        <div class="flex flex-wrap items-center gap-1.5">';
        for (var bIdx = 0; bIdx < topBrokers.length; bIdx++) {
          var bItem = topBrokers[bIdx];
          var bCode = typeof bItem === 'string' ? bItem : (bItem.broker || bItem.broker_code || '');
          var bAvg = typeof bItem === 'object' && bItem.avg_price ? bItem.avg_price : null;
          var bForeign = isForeignBroker(bCode);
          html += '        <span class="px-2 py-0.5 rounded text-[11px] font-mono font-semibold ' + (bForeign ? 'bg-sky-500/10 text-sky-300 border border-sky-500/30' : 'bg-dark-600/60 text-gray-200 border border-dark-500') + '">' + escapeHtml(bCode) + (bAvg ? ' @ ' + formatNumber(bAvg) : '') + '</span>';
        }
        html += '        </div>';
        html += '      </div>';
      }
      html += '    </div>';

      var s1Desc = s1.description || (s1.triggered ? 'Harga saat ini lebih murah dari modal akumulasi broker institusi/bandar. Peluang entry dengan risiko terukur.' : 'Harga saat ini berada di atas atau setara rerata harga beli top 3 broker.');
      html += '    <p class="text-[11px] text-gray-400 mt-1.5 pt-1.5 border-t border-dark-600/30 leading-relaxed">' + escapeHtml(s1Desc) + '</p>';
      html += '  </div>';

      // Card 2: Silent Foreign Accumulation
      html += '  <div id="intelCardSilentForeign" class="bg-dark-700/40 border border-dark-600/30 rounded-xl p-3.5 flex flex-col justify-between shadow-sm">';
      html += '    <div>';
      html += '      <div class="flex items-center justify-between gap-2 mb-2 pb-1.5 border-b border-dark-600/30">';
      html += '        <h4 class="text-xs font-bold text-gray-200 flex items-center gap-1.5"><span class="text-sm">🤫</span> Silent Foreign Accumulation</h4>';
      if (s2.triggered) {
        html += '        <span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">🟢 ASING AKUMULASI DIAM-DIAM</span>';
      } else {
        html += '        <span class="px-2 py-0.5 rounded text-[10px] font-bold bg-dark-600/40 text-gray-400 border border-dark-600">⚪ TIDAK TERDETEKSI</span>';
      }
      html += '      </div>';

      var s2Days = s2.consecutive_days || 0;
      var s2Chg = s2.price_change_pct != null ? s2.price_change_pct : 0;
      var s2NetVal = s2.total_foreign_net_val || s2.total_foreign_net || 0;

      html += '      <div class="grid grid-cols-3 gap-2 text-xs mb-2 bg-dark-800/60 p-2 rounded-lg border border-dark-600/20">';
      html += '        <div><span class="text-[10px] text-gray-400 block">Net Buy Beruntun</span><span class="font-mono font-bold ' + (s2Days >= 3 ? 'text-emerald-300' : 'text-gray-300') + '">' + s2Days + ' Hari</span></div>';
      html += '        <div><span class="text-[10px] text-gray-400 block">Fluktuasi Harga</span><span class="font-mono font-bold text-gray-200">' + (s2Chg > 0 ? '+' : '') + s2Chg + '% ' + (s2.is_sideways ? '<span class="text-emerald-400 text-[10px]">(Tenang)</span>' : '') + '</span></div>';
      html += '        <div><span class="text-[10px] text-gray-400 block">Total Net Asing</span><span class="font-mono font-bold ' + (s2NetVal >= 0 ? 'text-emerald-400' : 'text-rose-400') + '">' + (s2NetVal >= 0 ? '+' : '') + formatIDR(s2NetVal) + '</span></div>';
      html += '      </div>';
      html += '    </div>';

      var s2Desc = s2.description || (s2.triggered ? 'Investor asing melakukan net buy positif berturut-turut saat rentang pergerakan harga relatif sideways (kurang dari 2%).' : 'Aliran dana investor asing belum membentuk akumulasi diam-diam konsisten.');
      html += '    <p class="text-[11px] text-gray-400 mt-1.5 pt-1.5 border-t border-dark-600/30 leading-relaxed">' + escapeHtml(s2Desc) + '</p>';
      html += '  </div>';

      // Card 3: Ritel Cutloss vs Bandar Nampung
      html += '  <div id="intelCardRitelCutloss" class="bg-dark-700/40 border border-dark-600/30 rounded-xl p-3.5 flex flex-col justify-between shadow-sm">';
      html += '    <div>';
      html += '      <div class="flex items-center justify-between gap-2 mb-2 pb-1.5 border-b border-dark-600/30">';
      html += '        <h4 class="text-xs font-bold text-gray-200 flex items-center gap-1.5"><span class="text-sm">🔄</span> Ritel Cutloss vs Bandar Nampung</h4>';
      if (s3.is_bandar_nampung || s3.sub_type === 'BANDAR_NAMPUNG_RITEL_CUTLOSS') {
        html += '        <span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">🟢 BANDAR NAMPUNG</span>';
      } else if (s3.is_distribusi_ke_ritel || s3.sub_type === 'DISTRIBUSI_KE_RITEL') {
        html += '        <span class="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-500/20 text-rose-300 border border-rose-500/40">🔴 DISTRIBUSI KE RITEL</span>';
      } else {
        html += '        <span class="px-2 py-0.5 rounded text-[10px] font-bold bg-dark-600/40 text-gray-400 border border-dark-600">⚪ NETRAL / SEIMBANG</span>';
      }
      html += '      </div>';

      var buyersList = s3.top_buyers || [];
      var sellersList = s3.top_sellers || [];

      html += '      <div class="space-y-1.5 mb-2">';
      html += '        <div class="flex items-center justify-between text-xs bg-dark-800/60 p-1.5 rounded-lg border border-dark-600/20">';
      html += '          <span class="text-[10px] text-gray-400 font-semibold w-24">TOP BUYERS:</span>';
      html += '          <div class="flex items-center gap-1.5 flex-wrap justify-end">';
      if (buyersList.length === 0) {
        html += '            <span class="text-gray-500 text-[11px]">—</span>';
      } else {
        for (var bi = 0; bi < buyersList.length; bi++) {
          var bCode = buyersList[bi];
          var isInst = isInstitutionalBroker(bCode);
          var isRet = isRetailBroker(bCode);
          var bTag = isInst ? '<span class="text-[9px] text-emerald-400"> [Inst]</span>' : (isRet ? '<span class="text-[9px] text-rose-400"> [Ritel]</span>' : '');
          html += '          <span class="px-1.5 py-0.5 rounded font-mono text-[11px] font-bold bg-dark-700 border border-dark-600 text-gray-200">' + escapeHtml(bCode) + bTag + '</span>';
        }
      }
      html += '          </div>';
      html += '        </div>';

      html += '        <div class="flex items-center justify-between text-xs bg-dark-800/60 p-1.5 rounded-lg border border-dark-600/20">';
      html += '          <span class="text-[10px] text-gray-400 font-semibold w-24">TOP SELLERS:</span>';
      html += '          <div class="flex items-center gap-1.5 flex-wrap justify-end">';
      if (sellersList.length === 0) {
        html += '            <span class="text-gray-500 text-[11px]">—</span>';
      } else {
        for (var si = 0; si < sellersList.length; si++) {
          var sCode = sellersList[si];
          var sInst = isInstitutionalBroker(sCode);
          var sRet = isRetailBroker(sCode);
          var sTag = sInst ? '<span class="text-[9px] text-emerald-400"> [Inst]</span>' : (sRet ? '<span class="text-[9px] text-rose-400"> [Ritel]</span>' : '');
          html += '          <span class="px-1.5 py-0.5 rounded font-mono text-[11px] font-bold bg-dark-700 border border-dark-600 text-gray-200">' + escapeHtml(sCode) + sTag + '</span>';
        }
      }
      html += '          </div>';
      html += '        </div>';
      html += '      </div>';
      html += '    </div>';

      var s3Desc = s3.description || (s3.is_bandar_nampung ? 'Top buyer didominasi institusi/bandar sementara ritel cutloss menjual ke pasar.' : (s3.is_distribusi_ke_ritel ? 'Top buyer didominasi broker ritel sementara bandar/institusi keluar.' : 'Aliran transaksi ritel dan institusi relatif seimbang.'));
      html += '    <p class="text-[11px] text-gray-400 mt-1.5 pt-1.5 border-t border-dark-600/30 leading-relaxed">' + escapeHtml(s3Desc) + '</p>';
      html += '  </div>';

      // Card 4: Concentration Ratio CR3 & CR5
      html += '  <div id="intelCardConcentrationRatio" class="bg-dark-700/40 border border-dark-600/30 rounded-xl p-3.5 flex flex-col justify-between shadow-sm">';
      html += '    <div>';
      html += '      <div class="flex items-center justify-between gap-2 mb-2 pb-1.5 border-b border-dark-600/30">';
      html += '        <h4 class="text-xs font-bold text-gray-200 flex items-center gap-1.5"><span class="text-sm">📊</span> Rasio Konsentrasi (CR3 &amp; CR5)</h4>';
      if (s4.is_massive || s4.status === 'AKUMULASI_MASIF') {
        html += '        <span class="px-2 py-0.5 rounded text-[10px] font-bold bg-amber-500/20 text-amber-300 border border-amber-500/40">🔥 AKUMULASI SANGAT MASIF (&ge; 60%)</span>';
      } else if (s4.triggered || s4.status === 'AKUMULASI_TERKONSENTRASI') {
        html += '        <span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">⚡ AKUMULASI TERKONSENTRASI (&ge; 40%)</span>';
      } else {
        html += '        <span class="px-2 py-0.5 rounded text-[10px] font-bold bg-dark-600/40 text-gray-400 border border-dark-600">⚪ NORMAL / TERSEBAR</span>';
      }
      html += '      </div>';

      var cr3Val = s4.cr3 != null ? s4.cr3 : 0;
      var cr5Val = s4.cr5 != null ? s4.cr5 : 0;

      html += '      <div class="space-y-2 mb-2 bg-dark-800/60 p-2.5 rounded-lg border border-dark-600/20">';
      var cr3Color = cr3Val >= 60 ? 'bg-amber-400' : (cr3Val >= 40 ? 'bg-emerald-400' : 'bg-dark-500');
      html += '        <div>';
      html += '          <div class="flex items-center justify-between text-xs mb-1">';
      html += '            <span class="text-[11px] text-gray-300 font-medium">CR3 (Top 3 Broker Dominance):</span>';
      html += '            <span class="font-mono font-bold ' + (cr3Val >= 60 ? 'text-amber-300' : (cr3Val >= 40 ? 'text-emerald-400' : 'text-gray-300')) + '">' + cr3Val + '%</span>';
      html += '          </div>';
      html += '          <div class="w-full bg-dark-900 rounded-full h-2 overflow-hidden">';
      html += '            <div class="h-2 rounded-full ' + cr3Color + ' transition-all" style="width:' + Math.min(100, Math.max(0, cr3Val)) + '%"></div>';
      html += '          </div>';
      html += '        </div>';

      var cr5Color = cr5Val >= 75 ? 'bg-emerald-400' : 'bg-dark-500';
      html += '        <div>';
      html += '          <div class="flex items-center justify-between text-xs mb-1">';
      html += '            <span class="text-[11px] text-gray-300 font-medium">CR5 (Top 5 Broker Dominance):</span>';
      html += '            <span class="font-mono font-bold ' + (cr5Val >= 75 ? 'text-emerald-400' : 'text-gray-300') + '">' + cr5Val + '%</span>';
      html += '          </div>';
      html += '          <div class="w-full bg-dark-900 rounded-full h-2 overflow-hidden">';
      html += '            <div class="h-2 rounded-full ' + cr5Color + ' transition-all" style="width:' + Math.min(100, Math.max(0, cr5Val)) + '%"></div>';
      html += '          </div>';
      html += '        </div>';

      if (Array.isArray(s4.top_3_brokers) && s4.top_3_brokers.length > 0) {
        html += '        <div class="text-[10px] text-gray-400 pt-1">';
        html += '          <span>Top 3 Akumulator: <strong class="text-gray-200 font-mono">' + escapeHtml(s4.top_3_brokers.join(', ')) + '</strong></span>';
        html += '        </div>';
      }
      html += '      </div>';
      html += '    </div>';

      var s4Desc = s4.description || ('CR3 mengukur persentase volume yang dikuasai top 3 broker pembeli. CR3 >= 60% menunjukkan monopoli akumulasi oleh segelintir bandar.');
      html += '    <p class="text-[11px] text-gray-400 mt-2 pt-2 border-t border-dark-600/30 leading-relaxed">' + escapeHtml(s4Desc) + '</p>';
      html += '  </div>';

      html += '</div>'; // end grid
    } else {
      // View 2: Market-wide Scanner View
      var scanData = bandarIntelScannerData || {};
      var summary = scanData.summary || {};
      var indexes = scanData.indexes || {};

      var catKeys = [
        { key: 'harga_di_bawah_modal_bandar', label: '🏷️ Di Bawah Modal', count: summary.harga_di_bawah_modal_bandar_count || 0 },
        { key: 'silent_foreign_accumulation', label: '🤫 Akumulasi Asing', count: summary.silent_foreign_accumulation_count || 0 },
        { key: 'ritel_cutloss_bandar_nampung', label: '🟢 Ritel Cutloss', count: summary.ritel_cutloss_bandar_nampung_count || 0 },
        { key: 'distribusi_ke_ritel', label: '🔴 Distribusi ke Ritel', count: summary.distribusi_ke_ritel_count || 0 },
        { key: 'cr3_massive', label: '🔥 CR3 Masif (≥60%)', count: summary.cr3_massive_count || 0 }
      ];

      html += '<div class="flex flex-wrap items-center gap-1.5 mb-4">';
      for (var c = 0; c < catKeys.length; c++) {
        var cat = catKeys[c];
        var isCatSel = cat.key === bandarIntelScannerCategory;
        var catClass = isCatSel
          ? 'bg-emerald-500 text-dark-900 font-bold shadow-sm'
          : 'bg-dark-700/80 text-gray-300 hover:text-white border border-dark-600/50';
        html += '<button type="button" onclick="BandarmologiRuntime.setBandarIntelScannerCategory(\'' + escapeHtml(cat.key) + '\')" class="px-3 py-1.5 rounded-lg text-xs transition ' + catClass + '">';
        html += escapeHtml(cat.label) + ' <span class="font-mono text-[11px] opacity-80">(' + cat.count + ')</span>';
        html += '</button>';
      }
      html += '</div>';

      var currentItems = Array.isArray(indexes[bandarIntelScannerCategory]) ? indexes[bandarIntelScannerCategory] : [];
      html += '<div id="panel-intel-scanner" class="bg-dark-700/40 border border-dark-600/30 rounded-xl overflow-hidden">';
      if (currentItems.length === 0) {
        html += '  <div class="text-center py-12 text-gray-500 text-xs">';
        html += '    <p class="font-semibold text-gray-400">Tidak ada emiten terdeteksi untuk kriteria ini saat ini.</p>';
        html += '    <p class="text-[11px] mt-1 text-gray-500">Gunakan tombol refresh di atas untuk memeriksa ulang universe indeks.</p>';
        html += '  </div>';
      } else {
        html += '  <div class="overflow-x-auto overflow-y-auto" style="max-height: 540px; overflow-y: auto; overflow-x: auto;">';
        html += '    <table class="w-full text-left text-xs">';
        html += '      <thead class="sticky top-0 bg-slate-900 z-20" style="position: sticky; top: 0; z-index: 20; background-color: #0f172a;">';
        html += '        <tr class="text-[11px] text-gray-400 border-b border-dark-600/40 bg-dark-800/90">';
        html += '          <th class="py-2.5 px-3">No</th>';
        html += '          <th class="py-2.5 px-3">Ticker</th>';
        html += '          <th class="py-2.5 px-3">Metrik Utama</th>';
        html += '          <th class="py-2.5 px-3">Keterangan</th>';
        html += '          <th class="py-2.5 px-3 text-right">Aksi</th>';
        html += '        </tr>';
        html += '      </thead>';
        html += '      <tbody class="divide-y divide-dark-600/20">';
        for (var it = 0; it < currentItems.length; it++) {
          var item = currentItems[it];
          var itTicker = item.ticker || '—';
          var itMetric = item.metric || (item.discount_pct != null ? 'Diskon +' + item.discount_pct + '%' : (item.cr3 != null ? 'CR3 ' + item.cr3 + '%' : (item.consecutive_days ? item.consecutive_days + ' Hari' : 'Terdeteksi')));
          var itNote = item.note || item.description || '';
          if (!itNote || itNote === '—') {
            if (bandarIntelScannerCategory === 'harga_di_bawah_modal_bandar') {
              var disc = item.discount_pct != null ? item.discount_pct : '—';
              var cCost = item.bandar_avg_cost ? 'Rp ' + Number(item.bandar_avg_cost).toLocaleString('id-ID') : '';
              itNote = 'Harga pasar terdiskon ' + disc + '% di bawah estimasi modal bandar' + (cCost ? ' (' + cCost + ')' : '') + '.';
            } else if (bandarIntelScannerCategory === 'silent_foreign_accumulation') {
              var days = item.consecutive_days || 3;
              itNote = 'Akumulasi senyap asing ' + days + ' hari berturut-turut tanpa lonjakan harga drastis.';
            } else if (bandarIntelScannerCategory === 'ritel_cutloss_bandar_nampung') {
              itNote = 'Broker ritel mendominasi net sell (cutloss), ditampung masif oleh broker institusi/bandar.';
            } else if (bandarIntelScannerCategory === 'distribusi_ke_ritel') {
              itNote = 'Broker bandar/institusi distribusi net sell ke partisipasi ritel di harga tinggi.';
            } else if (bandarIntelScannerCategory === 'cr3_massive') {
              var crVal = item.cr3 != null ? item.cr3 : '60+';
              itNote = 'Konsentrasi volume top 3 broker pembeli mencapai ' + crVal + '%, kontrol bandar sangat ketat.';
            } else {
              itNote = 'Sinyal terdeteksi dalam screening bandarmologi.';
            }
          }

          html += '        <tr class="hover:bg-dark-600/20 transition">';
          html += '          <td class="py-2.5 px-3 font-mono text-[11px] text-gray-500">' + (it + 1) + '</td>';
          html += '          <td class="py-2.5 px-3"><span class="px-2 py-0.5 rounded font-mono font-bold text-xs bg-emerald-500/10 text-emerald-300 border border-emerald-500/30">' + escapeHtml(itTicker) + '</span></td>';
          html += '          <td class="py-2.5 px-3 font-mono font-semibold text-gray-200">' + escapeHtml(itMetric) + '</td>';
          html += '          <td class="py-2.5 px-3 text-gray-300 text-[11px] max-w-sm whitespace-normal leading-relaxed" title="' + escapeHtml(itNote) + '">' + escapeHtml(itNote) + '</td>';
          html += '          <td class="py-2.5 px-3 text-right">';
          html += '            <button type="button" onclick="BandarmologiRuntime.selectIntelTicker(\'' + escapeHtml(itTicker) + '\')" class="px-2.5 py-1 rounded bg-emerald-500/20 hover:bg-emerald-500/30 text-emerald-300 border border-emerald-500/40 text-xs font-semibold transition">Analisis &rarr;</button>';
          html += '          </td>';
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
    hunterData = null;
    loadBrokerHunter();
  }

  function setHunterRange(range) {
    hunterRange = range || '1d';
    hunterData = null;
    if (hunterRange === 'custom') {
      var container = byId('brokerHunterContent') || byId('bandarmologiContent');
      if (container) {
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
    hunterData = null;
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
    if (activeHunterAbortController) {
      try { activeHunterAbortController.abort(); } catch (_) {}
      activeHunterAbortController = null;
    }

    var thisRequestSeq = ++hunterRequestSeq;
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

    var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    activeHunterAbortController = controller;
    var timer = controller ? setTimeout(function () {
      try { controller.abort(); } catch (_) {}
    }, 10000) : null;

    try {
      var url = '/api/sector-hot?action=broker-hunter&broker=' + encodeURIComponent(hunterBroker) + '&range=' + encodeURIComponent(hunterRange);
      if (hunterRange === 'custom' && hunterStartDate && hunterEndDate) {
        url += '&startDate=' + encodeURIComponent(hunterStartDate) + '&endDate=' + encodeURIComponent(hunterEndDate);
      }
      var fetchOpts = controller ? { signal: controller.signal } : {};
      var resp = await fetch(url, fetchOpts);
      if (timer) clearTimeout(timer);
      if (thisRequestSeq !== hunterRequestSeq) return;

      var json = await resp.json();
      if (thisRequestSeq !== hunterRequestSeq) return;

      if (json && json.success) {
        hunterData = json;
      } else {
        hunterError = (json && json.error) || 'Gagal memuat data Broker Hunter.';
      }
    } catch (err) {
      if (timer) clearTimeout(timer);
      if (thisRequestSeq !== hunterRequestSeq) return;
      if (err && (err.name === 'AbortError' || String(err.message).includes('aborted'))) {
        hunterError = 'Permintaan dibatalkan atau waktu tunggu habis.';
      } else {
        hunterError = err.message || String(err);
      }
    } finally {
      if (timer) clearTimeout(timer);
      if (thisRequestSeq === hunterRequestSeq) {
        hunterLoading = false;
        activeHunterAbortController = null;
        if (container) {
          renderBrokerHunterUI(container);
        }
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
    var quickBrokers = ['AK', 'BK', 'CC', 'RX', 'DX', 'KZ', 'ZP', 'YP', 'XC', 'PD', 'NI', 'MG', 'SQ'];
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
        html += '          <td class="py-2.5 px-2 text-right font-mono font-semibold text-rose-400">-' + formatIDR(Math.abs(netValD)) + '</td>';
        html += '          <td class="py-2.5 px-2 text-right font-mono text-gray-200">-' + formatNumber(Math.abs(netLotD)) + '</td>';
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
    RETAIL_BROKERS: RETAIL_BROKERS,
    INSTITUTIONAL_BROKERS: INSTITUTIONAL_BROKERS,
    isForeignBroker: isForeignBroker,
    isRetailBroker: isRetailBroker,
    isInstitutionalBroker: isInstitutionalBroker,
    filterBrokersByFlow: filterBrokersByFlow,
    getBrokerSecurityName: getBrokerSecurityName,
    normalizeBrokerValue: normalizeBrokerValue,
    buildBrokerBubbleItems: buildBrokerBubbleItems,
    renderBrokerBubbleClusterHtml: renderBrokerBubbleClusterHtml,
    renderBrokerDetailCardHtml: renderBrokerDetailCardHtml,
    renderBrokerSummaryTableHtml: renderBrokerSummaryTableHtml,
    renderBandarmologiUI: renderBandarmologiUI,
    loadBandarmologiIntel: loadBandarmologiIntel,
    renderBandarmologiIntelUI: renderBandarmologiIntelUI,
    setBandarIntelViewMode: setBandarIntelViewMode,
    getBandarIntelViewMode: function () { return bandarIntelViewMode; },
    setBandarIntelRange: setBandarIntelRange,
    getBandarIntelRange: function () { return bandarIntelRange; },
    setBandarIntelScannerCategory: setBandarIntelScannerCategory,
    getBandarIntelScannerCategory: function () { return bandarIntelScannerCategory; },
    selectIntelTicker: selectIntelTicker,
    setHunterBroker: setHunterBroker,
    getHunterBroker: function () { return hunterBroker; },
    setHunterRange: setHunterRange,
    getHunterRange: function () { return hunterRange; },
    applyCustomHunterRange: applyCustomHunterRange,
    getCustomHunterRange: function () { return { start: hunterStartDate, end: hunterEndDate }; },
    inspectHunterTicker: inspectHunterTicker,
    loadBrokerHunter: loadBrokerHunter,
    renderBrokerHunterUI: renderBrokerHunterUI,
    synthesizeAccumulationFromSummary: synthesizeAccumulationFromSummary,
    setInsiderActionFilter: setInsiderActionFilter,
    getInsiderActionFilter: getInsiderActionFilter,
    renderInsiderNetworkUI: renderInsiderNetworkUI,
    renderInsiderNetworkGraph: renderInsiderNetworkGraph,
    renderInsiderNetworkSvg: renderInsiderNetworkSvg,
    renderInsiderDetailPanelHtml: renderInsiderDetailPanelHtml,
    selectInsiderEmitenNode: selectInsiderEmitenNode,
    handleInsiderSearchInput: handleInsiderSearchInput,
    selectInsiderSearchResult: selectInsiderSearchResult,
    selectInsiderQuickChip: selectInsiderQuickChip,
    clearInsiderSearch: clearInsiderSearch,
    analyzeInsiderTicker: analyzeInsiderTicker,
    getInsiderNetworkEntity: function () { return activeInsiderNetworkEntity; },
    getInsiderNetworkSelectedTicker: function () { return activeInsiderNetworkSelectedTicker; },
    getEffectiveInsiderGraph: getEffectiveInsiderGraph,
    getEffectiveSearchInsiders: getEffectiveSearchInsiders,
    loadInsiderNetwork: loadInsiderNetwork,
    fetchVpsAvailableDates: fetchVpsAvailableDates,
    fetchVpsBrokerSummary: fetchVpsBrokerSummary,
    normalizeClientBrokerSummary: normalizeClientBrokerSummary,
    VPS_DATA_API_BASE: VPS_DATA_API_BASE
  };

  root.loadBandarmologiTab = loadBandarmologiTab;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      BROKER_NAMES: BROKER_NAMES,
      FOREIGN_BROKERS: FOREIGN_BROKERS,
      RETAIL_BROKERS: RETAIL_BROKERS,
      INSTITUTIONAL_BROKERS: INSTITUTIONAL_BROKERS,
      isForeignBroker: isForeignBroker,
      isRetailBroker: isRetailBroker,
      isInstitutionalBroker: isInstitutionalBroker,
      filterBrokersByFlow: filterBrokersByFlow,
      getBrokerSecurityName: getBrokerSecurityName,
      normalizeBrokerValue: normalizeBrokerValue,
      buildBrokerBubbleItems: buildBrokerBubbleItems,
      renderBrokerBubbleClusterHtml: renderBrokerBubbleClusterHtml,
      renderBrokerDetailCardHtml: renderBrokerDetailCardHtml,
      renderBrokerSummaryTableHtml: renderBrokerSummaryTableHtml,
      renderBandarmologiUI: renderBandarmologiUI,
      loadBandarmologiIntel: loadBandarmologiIntel,
      renderBandarmologiIntelUI: renderBandarmologiIntelUI,
      setBandarIntelViewMode: setBandarIntelViewMode,
      getBandarIntelViewMode: function () { return bandarIntelViewMode; },
      setBandarIntelRange: setBandarIntelRange,
      getBandarIntelRange: function () { return bandarIntelRange; },
      setBandarIntelScannerCategory: setBandarIntelScannerCategory,
      getBandarIntelScannerCategory: function () { return bandarIntelScannerCategory; },
      updateIntelSearchBarVisibility: updateIntelSearchBarVisibility,
      selectIntelTicker: selectIntelTicker,
      setBrokerSummaryMode: setBrokerSummaryMode,
      setBrokerSummaryView: setBrokerSummaryView,
      setBrokerAccumulationView: setBrokerAccumulationView,
      setBrokerSummaryRange: setBrokerSummaryRange,
      setBandarSection: setBandarSection,
      getBandarSection: function () { return bandarSection; },
      selectBrokerBubble: selectBrokerBubble,
      setBubbleFilterSide: setBubbleFilterSide,
      getBubbleFilterSide: function () { return bubbleFilterSide; },
      firstNonEmptyList: firstNonEmptyList,
      setHunterBroker: setHunterBroker,
      setHunterRange: setHunterRange,
      applyCustomHunterRange: applyCustomHunterRange,
      inspectHunterTicker: inspectHunterTicker,
      loadBrokerHunter: loadBrokerHunter,
      renderBrokerHunterUI: renderBrokerHunterUI,
      synthesizeAccumulationFromSummary: synthesizeAccumulationFromSummary,
      setInsiderActionFilter: setInsiderActionFilter,
      getInsiderActionFilter: getInsiderActionFilter,
      renderInsiderNetworkUI: renderInsiderNetworkUI,
      renderInsiderNetworkGraph: renderInsiderNetworkGraph,
      renderInsiderNetworkSvg: renderInsiderNetworkSvg,
      renderInsiderDetailPanelHtml: renderInsiderDetailPanelHtml,
      selectInsiderEmitenNode: selectInsiderEmitenNode,
      handleInsiderSearchInput: handleInsiderSearchInput,
      selectInsiderSearchResult: selectInsiderSearchResult,
      selectInsiderQuickChip: selectInsiderQuickChip,
      clearInsiderSearch: clearInsiderSearch,
      analyzeInsiderTicker: analyzeInsiderTicker,
      getInsiderNetworkEntity: function () { return activeInsiderNetworkEntity; },
      getInsiderNetworkSelectedTicker: function () { return activeInsiderNetworkSelectedTicker; },
      getEffectiveInsiderGraph: getEffectiveInsiderGraph,
      getEffectiveSearchInsiders: getEffectiveSearchInsiders,
      loadInsiderNetwork: loadInsiderNetwork,
      fetchVpsAvailableDates: fetchVpsAvailableDates,
      fetchVpsBrokerSummary: fetchVpsBrokerSummary,
      normalizeClientBrokerSummary: normalizeClientBrokerSummary,
      VPS_DATA_API_BASE: VPS_DATA_API_BASE
    };
  }

})(typeof window !== 'undefined' ? window : this);
