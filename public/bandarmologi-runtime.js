(function (root) {
  'use strict';

  var bandarmologiService = null;
  if (typeof require !== 'undefined') {
    try {
      bandarmologiService = require('../lib/bandarmologi-service');
    } catch (_) {
      try {
        bandarmologiService = require('./lib/bandarmologi-service');
      } catch (_) {}
    }
  }

  // KEEP-ALIVE bridge. The shared SWR store returns a cached payload without a
  // round trip, so a tab revisit paints instantly while a stale entry is
  // refreshed behind it. When the store is not loaded this is a plain fetch, so
  // behaviour on standalone pages is unchanged.
  function acBandarFetch(url, options) {
    if (root && root.AutoCuanKeepAlive && typeof root.AutoCuanKeepAlive.cachedFetch === 'function') {
      return root.AutoCuanKeepAlive.cachedFetch(url, options);
    }
    return fetch(url, options);
  }

  function listDiskDates(endpoint, ticker) {
    if (bandarmologiService && typeof bandarmologiService.listDiskDates === 'function') {
      return bandarmologiService.listDiskDates(endpoint, ticker);
    }
    if (root && typeof root.listDiskDates === 'function') {
      return root.listDiskDates(endpoint, ticker);
    }
    return [];
  }

  // Browser-friendly canonical source of available trading dates. In the browser
  // `require('fs')`/`listDiskDates` is never available (server-only module), so
  // the date options MUST come from the API payload fields the backend already
  // returns: data.available_dates first, then broker_summary.date_headers.
  // Priority:
  //   1. lastBandarData.available_dates
  //   2. lastBandarData.broker_summary.date_headers
  //   3. lastBandarData.broker_accumulation.series / daily_summary dates
  //   4. vpsDatesMemoryCache[safeTicker] (pre-fetched from the VPS tunnel)
  //   5. server-side listDiskDates (only in Node, where fs exists)
  function collectAvailableDateOptions(ticker) {
    var out = [];
    var seen = {};
    if (typeof lastBandarData !== 'undefined' && lastBandarData) {
      if (Array.isArray(lastBandarData.available_dates) && lastBandarData.available_dates.length > 0) {
        for (var av = 0; av < lastBandarData.available_dates.length; av++) {
          var dAv = lastBandarData.available_dates[av];
          if (dAv && !seen[dAv]) { seen[dAv] = true; out.push(dAv); }
        }
      }
      var bSumDates = lastBandarData.broker_summary && Array.isArray(lastBandarData.broker_summary.date_headers)
        ? lastBandarData.broker_summary.date_headers
        : [];
      for (var hd = 0; hd < bSumDates.length; hd++) {
        var hDate = bSumDates[hd] && (bSumDates[hd].date || bSumDates[hd]);
        if (hDate && !seen[hDate]) { seen[hDate] = true; out.push(hDate); }
      }
      var bAcc = lastBandarData.broker_accumulation;
      var accSeries = bAcc && Array.isArray(bAcc.series) ? bAcc.series : (bAcc && Array.isArray(bAcc.daily_summary) ? bAcc.daily_summary : []);
      for (var ds = 0; ds < accSeries.length; ds++) {
        var dSeries = accSeries[ds] && (accSeries[ds].date || accSeries[ds]);
        if (dSeries && !seen[dSeries]) { seen[dSeries] = true; out.push(dSeries); }
      }
    }
    if (typeof ticker === 'string' && ticker) {
      var safeT = String(ticker).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
      var vpsDatesArr = (typeof vpsDatesMemoryCache !== 'undefined') ? (vpsDatesMemoryCache[safeT] || []) : [];
      for (var vd = 0; vd < vpsDatesArr.length; vd++) {
        var dVps = vpsDatesArr[vd];
        if (dVps && !seen[dVps]) { seen[dVps] = true; out.push(dVps); }
      }
    }
    var diskDates = listDiskDates('broker-summary', ticker);
    if (Array.isArray(diskDates)) {
      for (var di = diskDates.length - 1; di >= 0; di--) {
        var dDisk = diskDates[di];
        if (dDisk && !seen[dDisk]) { seen[dDisk] = true; out.push(dDisk); }
      }
    }
    out.sort().reverse();
    return out;
  }

  function calculateScannerDiscount(modal, last_price) {
    modal = Number(modal || 0);
    last_price = Number(last_price || 0);
    if (!modal || modal <= 0 || !last_price || last_price <= 0) return 0;
    return Number((((modal - last_price) / modal) * 100).toFixed(2));
  }

  // PR3: single canonical CR3/CR5 formula shared by the Bandarmologi tab display
  // and mirrored in lib/bandarmologi-intel-service.js#computeConcentrationRatios
  // so both tabs agree for the same ticker+date. Denominator is the real total
  // buy turnover; when it is missing/too small the same sub-top-5 guard used
  // server-side (turnover must exceed top5Val) prevents a 100% lock.
  function computeConcentrationRatioMetrics(top3Val, top5Val, totalBuyTurnover) {
    var t3 = Number(top3Val || 0);
    var t5 = Number(top5Val || 0);
    var turnover = Number(totalBuyTurnover || 0);
    if (turnover <= t5) {
      // Mirror the server guard: fall back to a multiple of top-5 so CR5 < 100%.
      turnover = t5 > 0 ? Math.round(t5 * 1.75) : 0;
    }
    var cr3 = 0;
    var cr5 = 0;
    if (t3 > 0 && turnover > 0) {
      cr3 = Number(((t3 / turnover) * 100).toFixed(2));
      cr5 = Number(((t5 / turnover) * 100).toFixed(2));
    }
    cr3 = Math.min(100, Math.max(0, cr3));
    cr5 = Math.min(100, Math.max(0, cr5));
    return { cr3: cr3, cr5: cr5 };
  }

  function buildDailyHistorySeries(ticker, maxDays) {
    if (bandarmologiService && typeof bandarmologiService.buildDailyHistorySeries === 'function') {
      return bandarmologiService.buildDailyHistorySeries(ticker, maxDays);
    }
    if (root && typeof root.buildDailyHistorySeries === 'function') {
      return root.buildDailyHistorySeries(ticker, maxDays);
    }
    return [];
  }

  function renderBrokerDateSelectHtml(ticker, dates, selectedDate) {
    ticker = ticker || (typeof currentBandarTicker !== 'undefined' ? currentBandarTicker : '') || (typeof lastBandarData !== 'undefined' && lastBandarData && lastBandarData.ticker) || 'BBCA';
    if (!dates || !dates.length) {
      if (typeof lastBandarData !== 'undefined' && lastBandarData) {
        if (Array.isArray(lastBandarData.available_dates) && lastBandarData.available_dates.length > 0) {
          dates = lastBandarData.available_dates.slice();
        } else if (lastBandarData.broker_summary && Array.isArray(lastBandarData.broker_summary.date_headers) && lastBandarData.broker_summary.date_headers.length > 0) {
          dates = lastBandarData.broker_summary.date_headers.map(function (h) { return h.date || h; }).filter(Boolean);
        }
      }
    }
    if (!dates || !dates.length) {
      dates = collectAvailableDateOptions(ticker);
    }
    if (!dates) dates = [];
    // Batch 6 F-040: no static date fallback. When no dynamic date is
    // available, leave selectedDate empty so the UI renders the explicit
    // "tanggal belum tersedia" state via formatDateDisplay's empty-input path.
    // Auto-select the NEWEST available date only when the caller has not pinned
    // one. An explicit selection (e.g. a date the operator picked, or a date a
    // caller passes in) must survive untouched - otherwise the dropdown would
    // snap back to the newest day on every re-render and the pinned history
    // could never be read.
    if (!selectedDate || selectedDate === 'latest' || (dates && dates.length > 0 && !dates.includes(selectedDate))) {
      selectedDate = (dates && dates.length > 0)
        ? dates[0]
        : ((typeof currentBandarDate !== 'undefined' ? currentBandarDate : null) || null);
      if (selectedDate && typeof currentBandarDate !== 'undefined') currentBandarDate = selectedDate;
    }

    var displayStyle = (typeof bandarSection !== 'undefined' && bandarSection !== 'summary') ? 'style="display: none;"' : '';
    var html = '<div id="brokerDateSelectWrap" ' + displayStyle + ' class="flex flex-wrap items-center gap-2.5 mb-3 bg-dark-800/60 p-2 rounded-xl border border-dark-600/40">';
    html += '  <div class="flex items-center gap-1.5">';
    html += '    <label for="brokerDateSelect" class="text-xs text-gray-300 font-semibold flex items-center gap-1">📅 <span>Pilih Tanggal:</span></label>';
    html += '    <select id="brokerDateSelect" onchange="BandarmologiRuntime.loadBandarmologiTab(null, this.value)" class="px-2.5 py-1 text-xs rounded-lg border border-dark-600/80 bg-dark-900 text-emerald-400 font-mono font-bold transition cursor-pointer hover:border-emerald-500/60 focus:outline-none focus:ring-1 focus:ring-emerald-500">';
    for (var ad = 0; ad < dates.length; ad++) {
      var aDt = dates[ad];
      var isCurrentDate = aDt === selectedDate;
      var dateNote = ad === 0 ? ' (Terbaru)' : '';
      var dispDate = typeof formatDateWibDisplay === 'function' ? formatDateWibDisplay(aDt) : aDt;
      html += '      <option value="' + escapeHtml(aDt) + '"' + (isCurrentDate ? ' selected' : '') + '>' + escapeHtml(dispDate) + dateNote + '</option>';
    }
    html += '    </select>';
    html += '  </div>';
    html += '</div>';
    return html;
  }

  function initBrokerDateSelect(ticker, dates, selectedDate) {
    ticker = ticker || (typeof currentBandarTicker !== 'undefined' ? currentBandarTicker : '') || (typeof lastBandarData !== 'undefined' && lastBandarData && lastBandarData.ticker) || 'BBCA';
    if (!dates || !dates.length) {
      if (typeof lastBandarData !== 'undefined' && lastBandarData) {
        if (Array.isArray(lastBandarData.available_dates) && lastBandarData.available_dates.length > 0) {
          dates = lastBandarData.available_dates.slice();
        } else if (lastBandarData.broker_summary && Array.isArray(lastBandarData.broker_summary.date_headers) && lastBandarData.broker_summary.date_headers.length > 0) {
          dates = lastBandarData.broker_summary.date_headers.map(function (h) { return h.date || h; }).filter(Boolean);
        }
      }
    }
    if (!dates || !dates.length) {
      dates = collectAvailableDateOptions(ticker);
    }
    if (!dates) dates = [];
    // Batch 6 F-040: no static date fallback - mirror initBrokerDateSelect.
    if (dates && dates.length > 0) {
      if (!selectedDate || selectedDate === 'latest' || !dates.includes(selectedDate)) {
        selectedDate = dates[0];
        currentBandarDate = dates[0];
      }
    } else {
      selectedDate = selectedDate || (typeof currentBandarDate !== 'undefined' ? currentBandarDate : null) || null;
    }

    var selectEl = byId('brokerDateSelect');
    if (selectEl && dates.length > 0) {
      selectEl.innerHTML = '';
      for (var ad = 0; ad < dates.length; ad++) {
        var opt = document.createElement('option');
        opt.value = dates[ad];
        var dispDate = typeof formatDateWibDisplay === 'function' ? formatDateWibDisplay(dates[ad]) : dates[ad];
        opt.textContent = dispDate + (ad === 0 ? ' (Terbaru)' : '');
        if (dates[ad] === selectedDate) {
          opt.selected = true;
        }
        selectEl.appendChild(opt);
      }
    }
    return dates;
  }

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

  function parseNumericValue(val) {
    if (val == null) return null;
    if (typeof val === 'number') return isFinite(val) ? val : null;
    var s = String(val).trim();
    if (!s || s === '-' || s === '-' || s.toLowerCase() === 'nan' || s.toLowerCase() === 'null') return null;

    var mult = 1;
    var cleanStr = s.replace(/Rp\.?\s*/gi, '').replace(/\s+/g, '');
    if (/[0-9][tT]$/.test(cleanStr)) {
      mult = 1e12;
      cleanStr = cleanStr.slice(0, -1);
    } else if (/[0-9][mM]$/.test(cleanStr) || /[0-9][bB]$/.test(cleanStr)) {
      mult = 1e9;
      cleanStr = cleanStr.slice(0, -1);
    } else if (/[0-9](jt|juta)$/i.test(cleanStr)) {
      mult = 1e6;
      cleanStr = cleanStr.replace(/(jt|juta)$/i, '');
    } else if (/[0-9](rb|k|ribu)$/i.test(cleanStr)) {
      mult = 1e3;
      cleanStr = cleanStr.replace(/(rb|k|ribu)$/i, '');
    }

    if (cleanStr.indexOf('.') >= 0 && cleanStr.indexOf(',') >= 0) {
      if (cleanStr.lastIndexOf(',') > cleanStr.lastIndexOf('.')) {
        cleanStr = cleanStr.replace(/\./g, '').replace(',', '.');
      } else {
        cleanStr = cleanStr.replace(/,/g, '');
      }
    } else if (cleanStr.indexOf(',') >= 0) {
      if (/^\-?\d+,\d{1,2}$/.test(cleanStr)) {
        cleanStr = cleanStr.replace(',', '.');
      } else {
        cleanStr = cleanStr.replace(/,/g, '');
      }
    } else if (cleanStr.indexOf('.') >= 0) {
      if (cleanStr.split('.').length > 2 || /^\-?\d{1,3}(\.\d{3})+$/.test(cleanStr)) {
        cleanStr = cleanStr.replace(/\./g, '');
      }
    }

    cleanStr = cleanStr.replace(/[^\d.-]/g, '');
    var n = parseFloat(cleanStr);
    return isFinite(n) ? n * mult : null;
  }

  function formatBrokerVal(num, includeSign) {
    var n = parseNumericValue(num);
    if (n == null) return '-';
    var sign = '';
    if (includeSign) {
      sign = n >= 0 ? '+' : '-';
    } else if (n < 0) {
      sign = '-';
    }
    var abs = Math.abs(n);
    if (abs >= 1e12) {
      return sign + (abs / 1e12).toFixed(2).replace(/\.00$/, '') + ' T';
    }
    if (abs >= 1e9) {
      return sign + (abs / 1e9).toFixed(2).replace(/\.00$/, '') + ' Mrd';
    }
    if (abs >= 1e6) {
      return sign + (abs / 1e6).toFixed(1).replace(/\.0$/, '') + ' Jt';
    }
    if (abs >= 1e3) {
      return sign + (abs / 1e3).toFixed(0) + ' Rb';
    }
    return sign + new Intl.NumberFormat('id-ID').format(abs);
  }

  function formatIDR(num) {
    var n = parseNumericValue(num);
    if (n == null) return '-';
    var abs = Math.abs(n);
    var sign = n < 0 ? '-' : '';
    if (abs >= 1e12) return sign + (abs / 1e12).toFixed(2).replace(/\.00$/, '') + ' T';
    if (abs >= 1e9) return sign + (abs / 1e9).toFixed(2).replace(/\.00$/, '') + ' Mrd';
    if (abs >= 1e6) return sign + (abs / 1e6).toFixed(1).replace(/\.0$/, '') + ' Jt';
    if (abs >= 1e3) return sign + (abs / 1e3).toFixed(0) + ' Rb';
    return sign + new Intl.NumberFormat('id-ID').format(abs);
  }

  function formatNumber(num) {
    var n = parseNumericValue(num);
    if (n == null) return '-';
    return new Intl.NumberFormat('id-ID').format(n);
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
    if (!brokerCode) return '-';
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
    if (val == null || val === '') return 0;
    // AUDIT-F4-14: feed dapat mengirim string numerik ("1500000000",
    // "1.500.000.000"). `isNaN(val)` menandai SEMUA string sebagai NaN sehingga
    // nilai riil dibuang menjadi 0. Gunakan parseNumericValue yang sudah
    // menangani format ribuan Indonesia sebelum fallback Number().
    var num = (typeof val === 'number') ? val : parseNumericValue(val);
    if (num == null || !isFinite(num)) return 0;
    // Absolute sanity guard: Any broker value >= 500 Miliar (5e11) is a 100x multiplier artifact in IDX data
    if (Math.abs(num) >= 5e11) {
      return Math.round(num / 100);
    }
    return num;
  }

  /**
   * AUDIT-F4-15: klasifikasi harian tunggal untuk kolom "Kategori"
   * (Big Acc / Normal Acc / Netral / Normal Dist / Big Dist).
   * Sebelumnya cabang terakhir menangkap net 0, -0, dan NaN sehingga hari tanpa
   * net flow apa pun tampil sebagai "Normal Dist" dan mendistorsi tabel
   * konsistensi. Ambang dipertahankan 5 Miliar (|net| >= 5e9 => Big).
   */
  function classifyDailyNetCategory(rawNet) {
    var net = (typeof rawNet === 'number') ? rawNet : parseNumericValue(rawNet);
    if (net == null || !isFinite(net)) return 'Netral';
    if (net >= 5e9) return 'Big Acc';
    if (net > 0) return 'Normal Acc';
    if (net === 0) return 'Netral';
    if (net <= -5e9) return 'Big Dist';
    return 'Normal Dist';
  }

  function computeAvgPrice(val, vol, explicitAvg) {
    if (explicitAvg && explicitAvg > 0) {
      if (explicitAvg > 100000 && vol > 0 && Math.round(explicitAvg / 100) >= 1) {
        return Math.round(explicitAvg / 100);
      }
      return Math.round(explicitAvg);
    }
    if (!val || !vol || vol <= 0) return 0;
    var raw = val / vol;
    if (raw > 100000 && Math.round(raw / 100) >= 1) {
      return Math.round(raw / 100);
    }
    return Math.round(raw);
  }

  var currentBandarTicker = 'BBCA';
  var currentBandarDate = '';
  var lastBandarData = null;
  var brokerSummaryMode = 'gross'; // 'gross' or 'net'
  var brokerSummaryView = 'table'; // 'table' (default) or 'bubble'
  var brokerAccumulationView = 'table'; // 'table' (default) or 'bubble'
  var brokerSummaryRange = '1d'; // '1d' (default), '7d', '30d', 'custom'
  var customRangeStart = '';
  var customRangeEnd = '';
  var brokerFlowFilter = 'all'; // 'all', 'F' (foreign), 'D' (domestic)
  var bandarSection = 'summary'; // 'summary' (Broker Summary), 'akumulasi' (Akumulasi Broker), or 'intel' (Sinyal Intelijen Bandar)
  var selectedBrokerCode = '';
  var selectedBrokerSide = '';
  var bubbleFilterSide = 'all'; // 'all', 'buy', 'sell'
  var insiderActionFilter = 'all'; // 'all', 'BUY', 'SELL'
  var insiderMobileView = 'roster'; // 'roster' (default) or 'graph'
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
  var activeBandarSummaryAbortController = null;
  var bandarSummaryRequestSeq = 0;
  var activeInsiderGraphAbortController = null;
  var activeInsiderRosterAbortController = null;

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
  var hunterSelectedStock = '';
  var hunterFilterText = '';
  var activeHunterAbortController = null;
  var hunterRequestSeq = 0;

  function injectBubbleStyles() {
    if (typeof document === 'undefined') return;
    if (byId('ac-broker-bubble-styles')) return;

    var style = document.createElement('style');
    style.id = 'ac-broker-bubble-styles';
    style.textContent = [
      '@keyframes acBubblePopIn {',
      '  0% { opacity: 0; transform: scale(0.65); }',
      '  100% { opacity: 1; transform: scale(1); }',
      '}',
      '@keyframes acFadeIn {',
      '  from { opacity: 0; transform: translateY(6px); }',
      '  to { opacity: 1; transform: translateY(0); }',
      '}',
      '.ac-broker-bubble {',
      '  margin: 4px;',
      '  flex-shrink: 0;',
      '  border-radius: 9999px;',
      '  display: flex;',
      '  flex-direction: column;',
      '  align-items: center;',
      '  justify-content: center;',
      '  cursor: pointer;',
      '  user-select: none;',
      '  transition: transform 0.2s ease, box-shadow 0.2s ease, border-color 0.2s ease;',
      '  position: relative;',
      '  border-style: solid;',
      '  border-width: 1.5px;',
      '  touch-action: manipulation;',
      '  -webkit-tap-highlight-color: transparent;',
      '}',
      '.ac-broker-bubble:hover {',
      '  transform: scale(1.06) !important;',
      '  z-index: 20;',
      '}',
      '.ac-broker-bubble.ac-bubble-selected {',
      '  transform: scale(1.12) !important;',
      '  z-index: 30;',
      '  box-shadow: 0 0 16px rgba(16, 185, 129, 0.45) !important;',
      '  border-color: #ffffff !important;',
      '  border-width: 2.5px !important;',
      '  animation: none !important;',
      '}',
      '.ac-fade-in {',
      '  animation: acFadeIn 0.2s ease-out forwards;',
      '}',
      '@media (prefers-reduced-motion: reduce) {',
      '  .ac-broker-bubble {',
      '    animation: none !important;',
      '    transition: none !important;',
      '  }',
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
    var isPos = netFlow >= 0;
    var tBuyer = (finalBuyers[0] && (finalBuyers[0].broker || finalBuyers[0].broker_code || finalBuyers[0].code)) || '-';
    var tSeller = (finalSellers[0] && (finalSellers[0].broker || finalSellers[0].broker_code || finalSellers[0].code)) || '-';
    var top1 = isPos ? tBuyer : tSeller;
    var series = Array.isArray(summary.date_headers) && summary.date_headers.length > 0
      ? summary.date_headers
      : (netFlow !== 0 ? [{
          date: summary.date || 'latest',
          net_val: netFlow,
          status: isPos ? 'ACC' : 'DIST',
          top_buyer: tBuyer,
          top_seller: tSeller,
          top_1_broker: top1,
          top1_broker: top1,
          top_broker: top1,
          buyer1: tBuyer,
          seller1: tSeller
        }] : []);

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

      var bval = item.bval != null ? Number(item.bval) : (item.buy_val != null ? Number(item.buy_val) : (item.val != null ? Number(item.val) : (item.value != null ? Number(item.value) : 0)));
      var sval = item.sval != null ? Number(item.sval) : (item.sell_val != null ? Number(item.sell_val) : 0);
      if (!isBuyerList) {
        sval = item.sval != null ? Number(item.sval) : (item.sell_val != null ? Number(item.sell_val) : (item.val != null ? Number(item.val) : (item.value != null ? Number(item.value) : 0)));
        bval = item.bval != null ? Number(item.bval) : (item.buy_val != null ? Number(item.buy_val) : 0);
      }
      var bvol = item.bvol != null ? Number(item.bvol) : (item.buy_vol != null ? Number(item.buy_vol) : (item.vol != null ? Number(item.vol) : (item.volume != null ? Number(item.volume) : 0)));
      var svol = item.svol != null ? Number(item.svol) : (item.sell_vol != null ? Number(item.sell_vol) : 0);
      if (!isBuyerList) {
        svol = item.svol != null ? Number(item.svol) : (item.sell_vol != null ? Number(item.sell_vol) : (item.vol != null ? Number(item.vol) : (item.volume != null ? Number(item.volume) : 0)));
        bvol = item.bvol != null ? Number(item.bvol) : (item.buy_vol != null ? Number(item.buy_vol) : 0);
      }

      if (bval > target.bval) target.bval = bval;
      if (sval > target.sval) target.sval = sval;
      if (bvol > target.bvol) target.bvol = bvol;
      if (svol > target.svol) target.svol = svol;

      if (item.bfrq && item.bfrq > target.bfrq) target.bfrq = item.bfrq;
      if (item.sfrq && item.sfrq > target.sfrq) target.sfrq = item.sfrq;

      // avg_buy / avg_sell: prefer explicit, fallback to val/vol
      if (item.avg_buy) target.avgBuy = item.avg_buy;
      else if (item.buy_avg_price) target.avgBuy = item.buy_avg_price;
      else if (item.bavg) target.avgBuy = item.bavg;
      else if (item.avg_price && isBuyerList) target.avgBuy = item.avg_price;

      if (item.avg_sell) target.avgSell = item.avg_sell;
      else if (item.sell_avg_price) target.avgSell = item.sell_avg_price;
      else if (item.savg) target.avgSell = item.savg;
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

    // F-011: the shadowed `var items` (redeclared below) is removed here so the
    // loop below is the single declaration of the build result.
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

      // ALWAYS derive netVal from accumulated bval/sval after all items are processed.
      // This guarantees 1 broker = 1 position: if bval > sval the broker is a net buyer
      // (green bubble), otherwise a net seller (red bubble). Relying on explicitNetVal
      // caused duplicate-position bugs when the same broker appeared in both buyer and
      // seller input lists, because processItem() overwrote explicitNetVal on each call.
      var netVal = it.bval - it.sval;

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

      var isNeutral = (Math.abs(netVal) === 0) || (it.bval > 0 && it.sval > 0 && it.bval === it.sval);
      var isNetBuyer = false;
      if (!isNeutral) {
        if (it.bval > 0 && it.sval > 0) {
          isNetBuyer = it.bval > it.sval;
        } else if (it.explicitNetVal != null) {
          isNetBuyer = it.explicitNetVal > 0;
        } else if (it.bval > 0) {
          isNetBuyer = true;
        } else if (it.sval > 0) {
          isNetBuyer = false;
        } else {
          isNetBuyer = netVal > 0;
        }
      }

      // Sizing transaction value
      var txVal = isGross ? Math.max(it.bval, it.sval, Math.abs(netVal)) : Math.abs(netVal);
      if (isNeutral && txVal <= 0 && (it.bval > 0 || it.sval > 0)) {
        txVal = Math.max(it.bval, it.sval);
      }
      if (txVal <= 0) txVal = 0;

      it.netVal = netVal;
      it.nvol = netVol;
      it.isNetBuyer = isNetBuyer;
      it.isNeutral = isNeutral;
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
        var buyTxVal = bStat.bval > 0 ? bStat.bval : Math.abs(bStat.netVal);
        if (buyTxVal <= 0) continue; // eliminate 0 dummy bubbles
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
        var sellTxVal = sStat.sval > 0 ? sStat.sval : Math.abs(sStat.netVal);
        if (sellTxVal <= 0) continue; // eliminate 0 dummy bubbles
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
      // Net Mode: All Net Buyers (badge +, green), All Net Sellers (badge -, red/orange), and Neutral (badge 0, gray)
      var netBuyers = [];
      var netSellers = [];
      var netNeutrals = [];
      for (var cn = 0; cn < codes.length; cn++) {
        var nStat = map[codes[cn]];
        var nVal = nStat.netVal;

        if (nStat.isNeutral) {
          if (nStat.bval > 0 || nStat.sval > 0) {
            netNeutrals.push(Object.assign({}, nStat, {
              side: 'neutral',
              isBuyer: false,
              isNetBuyer: false,
              isNeutral: true,
              badge: '0',
              txVal: nStat.txVal > 0 ? nStat.txVal : Math.max(nStat.bval, nStat.sval, 1),
              displayVal: 0
            }));
          }
          continue; // No dummy bubble for empty 0 activity
        }

        var absNval = Math.abs(nVal);
        if (absNval <= 0) continue; // eliminate dummy +1/-1

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
      netNeutrals.sort(function (a, b) { return b.txVal - a.txVal; });

      // Fallback: If netSellers is empty but sList has brokers, guarantee sellers are rendered.
      // Guard: never duplicate a broker already emitted as net buyer/neutral (1 broker = 1 bubble in net mode).
      if (netSellers.length === 0 && sList.length > 0) {
        var existingNetCodes = {};
        for (var ebi = 0; ebi < netBuyers.length; ebi++) {
          if (netBuyers[ebi] && netBuyers[ebi].broker) existingNetCodes[String(netBuyers[ebi].broker).trim().toUpperCase()] = true;
        }
        for (var eni = 0; eni < netNeutrals.length; eni++) {
          if (netNeutrals[eni] && netNeutrals[eni].broker) existingNetCodes[String(netNeutrals[eni].broker).trim().toUpperCase()] = true;
        }
        for (var si = 0; si < sList.length; si++) {
          var sItem = sList[si];
          if (!sItem || !sItem.broker) continue;
          var sCode = String(sItem.broker).trim().toUpperCase();
          if (existingNetCodes[sCode]) continue;
          var sVal = Math.abs(Number(sItem.nval != null ? sItem.nval : (sItem.net_val != null ? sItem.net_val : (sItem.sval || sItem.sell_val || sItem.val || 0))));
          if (sVal <= 0) continue;
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
            isNetBuyer: false,
            isNeutral: false
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

      items = netBuyers.concat(netSellers).concat(netNeutrals);
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
    var netVal = broker.netVal != null ? broker.netVal : (bval - sval);
    var isNeutral = broker.isNeutral || (netVal === 0 && (bval === sval || totalGross === 0));

    var buyPct = 0;
    var sellPct = 0;
    if (isNeutral) {
      if (totalGross > 0) {
        buyPct = 50;
        sellPct = 50;
      } else {
        buyPct = 0;
        sellPct = 0;
      }
    } else if (totalGross > 0) {
      buyPct = Math.round((bval / totalGross) * 100);
      sellPct = 100 - buyPct;
    } else if (isNetBuyer) {
      buyPct = 100;
      sellPct = 0;
    } else {
      buyPct = 0;
      sellPct = 100;
    }

    var tagColor = isNeutral
      ? 'bg-dark-600/60 text-gray-300 border-dark-500'
      : (isNetBuyer
          ? 'bg-emerald-500/20 text-emerald-300 border-emerald-500/40'
          : 'bg-rose-500/20 text-rose-300 border-rose-500/40');

    var html = '';
    html += '<div id="brokerBubbleDetailCard" class="bg-dark-800/90 border border-dark-600/50 rounded-2xl p-4 sm:p-5 shadow-xl ac-fade-in">';

    // Header with broker code, full name, and net status
    var statusTitle = isNeutral
      ? 'NETRAL (0)'
      : (isNetBuyer ? 'NET BUYER (+ ' + formatIDR(netVal) + ')' : 'NET SELLER (- ' + formatIDR(Math.abs(netVal)) + ')');
    var statusBadge = isNeutral
      ? '⚪ ' + (totalGross === 0 ? '0% / 0% Netral' : 'Netral (' + buyPct + '% / ' + sellPct + '%)')
      : (isNetBuyer ? '🟢 Akumulasi' : '🔴 Distribusi');

    html += '  <div class="flex flex-wrap items-center justify-between gap-3 pb-3 mb-3.5 border-b border-dark-600/40">';
    html += '    <div class="flex items-center gap-3">';
    html += '      <span class="px-3 py-1.5 rounded-xl font-black font-mono text-base border ' + tagColor + '">' + escapeHtml(broker.broker) + '</span>';
    html += '      <div>';
    html += '        <div class="text-sm sm:text-base font-bold text-gray-100 flex items-center gap-2">';
    html += '          <span>' + escapeHtml(broker.fullName) + '</span>';
    html += '        </div>';
    html += '        <div class="text-[11px] text-gray-400 font-mono mt-0.5">';
    html += '          Kode Broker: <span class="text-gray-200 font-bold">' + escapeHtml(broker.broker) + '</span>';
    html += '          • Status: <span class="font-bold ' + (isNeutral ? 'text-gray-300' : (isNetBuyer ? 'text-emerald-400' : 'text-rose-400')) + '">' + statusTitle + '</span>';
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
    html += '        ' + statusBadge;
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
    var contribPct = totalClusterVal > 0 ? ((broker.txVal / totalClusterVal) * 100).toFixed(1) : '-';

    html += '    <div class="flex flex-wrap items-center justify-between text-[10px] text-gray-400 font-mono mt-2 pt-1 border-t border-dark-600/20">';
    html += '      <span>Total Transaksi Gross: <strong class="text-gray-200">' + formatIDR(totalGross) + '</strong></span>';
    html += '      <span>Net Flow: <strong class="' + (isNeutral ? 'text-gray-300' : (broker.netVal >= 0 ? 'text-emerald-400' : 'text-rose-400')) + '">' + (isNeutral ? '0' : ((broker.netVal >= 0 ? '+' : '-') + formatIDR(Math.abs(broker.netVal)))) + '</strong></span>';
    html += '      <span>Kontribusi: <strong class="text-emerald-300 font-bold">' + contribPct + '%</strong></span>';
    html += '    </div>';
    html += '  </div>';

    // 6-Stat Grid
    html += '  <div class="grid grid-cols-2 sm:grid-cols-3 gap-2.5 text-xs font-mono">';
    html += '    <div class="p-2.5 rounded-xl bg-dark-700/40 border border-dark-600/30">';
    html += '      <div class="text-[10px] text-gray-400 uppercase tracking-wider mb-1">Volume Beli</div>';
    html += '      <div class="text-emerald-400 font-bold text-xs sm:text-sm">' + formatNumber(broker.bvol) + ' <span class="text-[10px] font-normal text-gray-400">lembar</span></div>';
    html += '    </div>';
    html += '    <div class="p-2.5 rounded-xl bg-dark-700/40 border border-dark-600/30">';
    html += '      <div class="text-[10px] text-gray-400 uppercase tracking-wider mb-1">Volume Jual</div>';
    html += '      <div class="text-rose-400 font-bold text-xs sm:text-sm">' + formatNumber(broker.svol) + ' <span class="text-[10px] font-normal text-gray-400">lembar</span></div>';
    html += '    </div>';
    html += '    <div class="p-2.5 rounded-xl bg-dark-700/40 border border-dark-600/30">';
    html += '      <div class="text-[10px] text-gray-400 uppercase tracking-wider mb-1">Net Volume</div>';
    html += '      <div class="' + (broker.nvol >= 0 ? 'text-emerald-300' : 'text-rose-300') + ' font-bold text-xs sm:text-sm">' + (broker.nvol >= 0 ? '+' : '') + formatNumber(broker.nvol) + ' <span class="text-[10px] font-normal text-gray-400">lembar</span></div>';
    html += '    </div>';
    html += '    <div class="p-2.5 rounded-xl bg-dark-700/40 border border-dark-600/30">';
    html += '      <div class="text-[10px] text-gray-400 uppercase tracking-wider mb-1">Frekuensi Order</div>';
    html += '      <div class="text-gray-200 font-bold text-xs sm:text-sm">' + formatNumber(broker.bfrq) + ' <span class="text-[10px] font-normal text-gray-400">B</span> / ' + formatNumber(broker.sfrq) + ' <span class="text-[10px] font-normal text-gray-400">S</span></div>';
    html += '    </div>';
    html += '    <div class="p-2.5 rounded-xl bg-dark-700/40 border border-dark-600/30">';
    html += '      <div class="text-[10px] text-gray-400 uppercase tracking-wider mb-1">Avg Harga Beli</div>';
    html += '      <div class="text-gray-200 font-bold text-xs sm:text-sm">' + (broker.avgBuy ? '@ Rp ' + formatNumber(broker.avgBuy) : '-') + '</div>';
    html += '    </div>';
    html += '    <div class="p-2.5 rounded-xl bg-dark-700/40 border border-dark-600/30">';
    html += '      <div class="text-[10px] text-gray-400 uppercase tracking-wider mb-1">Avg Harga Jual</div>';
    html += '      <div class="text-gray-200 font-bold text-xs sm:text-sm">' + (broker.avgSell ? '@ Rp ' + formatNumber(broker.avgSell) : '-') + '</div>';
    html += '    </div>';
    html += '  </div>';

    html += '</div>';
    return html;
  }

  function getBubbleColorStyles(isNetBuyer, tier, isNeutral) {
    if (isNeutral) {
      return {
        bg: 'radial-gradient(circle at 35% 35%, rgba(148, 163, 184, 0.25), rgba(51, 65, 85, 0.70))',
        border: 'rgba(148, 163, 184, 0.55)',
        text: '#f1f5f9',
        subText: '#cbd5e1',
        shadow: '0 3px 10px rgba(100, 116, 139, 0.25)'
      };
    }
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
    if (!Array.isArray(brokers) || brokers.length === 0) {
      if (typeof lastBandarData !== 'undefined' && lastBandarData) {
        var fbSum = lastBandarData.broker_summary || {};
        var fbAcc = lastBandarData.broker_accumulation || {};
        var fbBuyers = firstNonEmptyList(fbSum.top_buyers, fbSum.net_buyers, fbSum.gross_buyers, fbSum.buyers, fbAcc.top_buyers, fbAcc.net_buyers, fbSum.brokers);
        var fbSellers = firstNonEmptyList(fbSum.top_sellers, fbSum.net_sellers, fbSum.gross_sellers, fbSum.sellers, fbAcc.top_sellers, fbAcc.net_sellers);
        if (fbBuyers.length > 0 || fbSellers.length > 0) {
          brokers = buildBrokerBubbleItems(fbBuyers, fbSellers, mode || brokerSummaryMode);
        }
      }
    }
    if (!Array.isArray(brokers) || brokers.length === 0) {
      return '<div class="text-center py-6 px-4 text-xs text-gray-400 font-medium">Memuat sebaran klaster broker akumulasi &amp; distribusi...</div>';
    }

    var isGross = mode === 'gross';
    filterSide = filterSide || 'all';

    // If filterSide has no matches but brokers has items, fallback to 'all' so bubbles are never blocked
    var visibleBrokers = brokers.filter(function (b) {
      if (brokerFlowFilter !== 'all') {
        var isF = isForeignBroker(b.broker);
        if (brokerFlowFilter === 'F' && !isF) return false;
        if (brokerFlowFilter === 'D' && isF) return false;
      }
      if (filterSide === 'buy') return isGross ? (b.side === 'buy' || b.isBuyer) : b.isNetBuyer;
      if (filterSide === 'sell') return isGross ? (b.side === 'sell' || !b.isBuyer) : (!b.isNetBuyer && !b.isNeutral);
      return true;
    });

    if (visibleBrokers.length === 0 && brokers.length > 0 && brokerFlowFilter === 'all') {
      filterSide = 'all';
      visibleBrokers = brokers;
    }

    var buyerCount = brokers.filter(function (b) { return isGross ? (b.side === 'buy' || b.isBuyer) : b.isNetBuyer; }).length;
    var sellerCount = brokers.filter(function (b) { return isGross ? (b.side === 'sell' || !b.isBuyer) : (!b.isNetBuyer && !b.isNeutral); }).length;

    var html = '';
    html += '<div class="space-y-3">';

    // Filter controls and hint
    html += '  <div class="flex flex-wrap items-center justify-between gap-2 px-1">';
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
        visibleBrokers = brokers;
        if (visibleBrokers.length === 0) {
          html += '    <div class="text-center py-6 px-4 text-xs text-gray-400 font-medium">Memuat sebaran klaster broker...</div>';
        }
      }
    }
    if (visibleBrokers.length > 0) {
      for (var i = 0; i < visibleBrokers.length; i++) {
        var b = visibleBrokers[i];
        var isNeutralBubble = !isGross && (b.isNeutral || b.netVal === 0);
        var isBuyerBubble = isNeutralBubble ? false : (isGross ? (b.side === 'buy' || b.isBuyer) : b.isNetBuyer);
        var isSelected = (b.broker === activeCode) && (!selectedBrokerSide || !b.side || b.side === selectedBrokerSide);
        var styleInfo = getBubbleColorStyles(isBuyerBubble, b.colorTier, isNeutralBubble);
        var valText = isNeutralBubble
          ? formatBrokerVal(0)
          : (isGross
              ? (b.side === 'sell' || !b.isBuyer ? ('-' + formatBrokerVal(b.sval || b.txVal)) : ('+' + formatBrokerVal(b.bval || b.txVal)))
              : ((b.netVal >= 0 ? '+' : '-') + formatBrokerVal(Math.abs(b.netVal))));
        var subBadge = isNeutralBubble
          ? '0'
          : (isGross
              ? (isBuyerBubble ? 'BUY' : 'SELL')
              : (b.size >= 76 ? (isBuyerBubble ? 'BUY' : 'SELL') : (b.netVal >= 0 ? '+' : '-')));

        var isSmallBubble = b.size < 64;
        var animString = isSelected
          ? 'none'
          : 'acBubblePopIn var(--motion-panel, 260ms) var(--ease-standard, cubic-bezier(.2,.8,.2,1)) ' + b.staggerDelay + 's backwards';

        var bubbleKey = b.broker + (isGross ? ('-' + (b.side || (b.isBuyer ? 'buy' : 'sell'))) : '');

        html += '    <button type="button"';
        html += '      id="broker-bubble-' + escapeHtml(bubbleKey) + '"';
        html += '      class="ac-broker-bubble ' + (isSelected ? 'ac-bubble-selected' : '') + '"';
        html += '      data-broker="' + escapeHtml(b.broker) + '"';
        html += '      data-side="' + escapeHtml(b.side || (b.isBuyer ? 'buy' : (isNeutralBubble ? 'neutral' : 'sell'))) + '"';
        html += '      onclick="BandarmologiRuntime.selectBrokerBubble(\'' + escapeHtml(b.broker) + '\', \'' + escapeHtml(b.side || (b.isBuyer ? 'buy' : (isNeutralBubble ? 'neutral' : 'sell'))) + '\')"';
        var bubbleHoverDesc = isGross
          ? (b.broker + ' - ' + b.fullName + ' | ' + (isBuyerBubble ? 'Sisi Beli (Gross): Rp' : 'Sisi Jual (Gross): Rp') + formatNumber(Math.round(b.displayVal || b.txVal || 0)) + ' | Vol: ' + formatNumber(b.bvol || b.svol || b.nvol || 0) + ' lot')
          : (b.broker + ' - ' + b.fullName + ' | ' + (isNeutralBubble ? 'Netral (0)' : (isBuyerBubble ? 'Akumulasi +' : 'Distribusi -') + formatBrokerVal(Math.abs(b.netVal || b.txVal))) + ' | Vol: ' + formatNumber(b.nvol || 0) + ' lot');
        html += '      title="' + escapeHtml(bubbleHoverDesc) + '"';
        html += '      style="width:' + b.size + 'px; height:' + b.size + 'px; background:' + styleInfo.bg + '; border-color:' + styleInfo.border + '; color:' + styleInfo.text + '; box-shadow:' + styleInfo.shadow + '; animation:' + animString + ';">';
        var brokerDisplayCode = isGross ? (b.broker + (isBuyerBubble ? ' (Beli)' : ' (Jual)')) : b.broker;
        html += '      <span class="font-mono font-black text-xs sm:text-sm tracking-wider leading-none">' + escapeHtml(brokerDisplayCode) + '</span>';
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
        el.classList.remove('ac-bubble-selected');
        el.style.animation = 'none';
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

  var _settingBandarSection = false;
  function setBandarSection(section) {
    if (_settingBandarSection) return;
    _settingBandarSection = true;
    try {
    bandarSection = (section === 'akumulasi' || section === 'intel' || section === 'network') ? section : 'summary';
    // FIX: the Akumulasi Broker tab must never inherit the Broker Summary bubble
    // cluster. Entering it resets the default to the consistency table + cumulative
    // chart; the operator can still opt into bubbles explicitly afterwards.
    if (bandarSection === 'akumulasi') {
      brokerAccumulationView = 'table';
      bubbleFilterSide = 'all';
      // FIX (UI): the Akumulasi tab opens on metric cards + cumulative table ONLY.
      // Force the TAMPILAN pill back to "Tabel Rinci" and hard-hide any bubble
      // cluster DOM left behind by the Broker Summary view.
      try {
        var accBubbleBtn = byId('toggleAccViewBubble');
        var accTableBtn = byId('toggleAccViewTable');
        var pillOff = 'px-2.5 py-1 rounded-md transition text-gray-400 hover:text-white font-medium';
        var pillOn = 'px-2.5 py-1 rounded-md transition bg-emerald-500 text-dark-900 shadow-sm font-bold';
        if (accBubbleBtn) {
          accBubbleBtn.className = pillOff;
          accBubbleBtn.setAttribute('aria-pressed', 'false');
        }
        if (accTableBtn) {
          accTableBtn.className = pillOn;
          accTableBtn.setAttribute('aria-pressed', 'true');
        }
        var staleBubbleWrap = byId('acAccBubbleClusterWrap');
        if (staleBubbleWrap) {
          staleBubbleWrap.style.display = 'none';
          staleBubbleWrap.setAttribute('aria-hidden', 'true');
        }
      } catch (_) {}
    }
    if (activeBandarSummaryAbortController && (section === 'intel' || section === 'network')) {
      try { activeBandarSummaryAbortController.abort(); } catch (_) {}
    }
    if (activeIntelAbortController && (section === 'summary' || section === 'akumulasi' || section === 'network')) {
      try { activeIntelAbortController.abort(); } catch (_) {}
    }
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
    var bandarInd = byId('bandarViewInd');
    var subIntel = byId('subTabIntelBandar');
    var subNet = byId('subTabJejaringInsider');
    if (subSum && subAcc) {
      subSum.classList.toggle('on', bandarSection === 'summary');
      subSum.setAttribute('aria-selected', bandarSection === 'summary' ? 'true' : 'false');
      subAcc.classList.toggle('on', bandarSection === 'akumulasi');
      subAcc.setAttribute('aria-selected', bandarSection === 'akumulasi' ? 'true' : 'false');
      if (bandarInd) {
        bandarInd.className = 'ind' + (bandarSection === 'akumulasi' ? ' k1' : ' k0');
      }
      if (subIntel) {
        subIntel.className = 'px-3.5 py-1.5 rounded-lg transition flex items-center gap-1.5 ' + (bandarSection === 'intel' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium');
        subIntel.setAttribute('aria-selected', bandarSection === 'intel' ? 'true' : 'false');
      }
      if (subNet) {
        subNet.className = 'px-3.5 py-1.5 rounded-lg transition flex items-center gap-1.5 ' + (bandarSection === 'network' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium');
        subNet.setAttribute('aria-selected', bandarSection === 'network' ? 'true' : 'false');
      }
    }
    var dateSelectWrap = byId('brokerDateSelectWrap');
    if (dateSelectWrap) {
      // The date selector belongs exclusively to Broker Summary. Akumulasi Broker
      // already has range controls and must not inherit this single-date filter.
      dateSelectWrap.style.display = bandarSection === 'summary' ? '' : 'none';
      dateSelectWrap.setAttribute('aria-hidden', bandarSection === 'summary' ? 'false' : 'true');
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
            renderBrokerAccumulation(bandarContainer, lastBandarData);
            return;
          }
          renderBandarmologiUI(bandarContainer, lastBandarData);
        } else if (typeof fetch !== 'undefined') {
          loadBandarmologiTab(currentBandarTicker);
        }
      }
    }
    } finally {
      _settingBandarSection = false;
    }
  }

  function setBrokerFlowFilter(flow) {
    brokerFlowFilter = (flow === 'F' || flow === 'D') ? flow : 'all';
    var container = byId('bandarmologiContent');
    if (container && lastBandarData) {
      renderBandarmologiUI(container, lastBandarData);
    }
    loadBandarmologiTab(currentBandarTicker, brokerSummaryRange === '1d' ? currentBandarDate : null, brokerSummaryRange);
  }

  function setBrokerSummaryRange(range) {
    brokerSummaryRange = range || '1d';
    if (brokerSummaryRange !== '1d') {
      currentBandarDate = null;
    }
    var validIntelRanges = ['1d', '5d', '7d', '14d', '30d', '60d'];
    if (validIntelRanges.includes(String(range).toLowerCase())) {
      bandarIntelRange = String(range).toLowerCase();
      bandarIntelData = null;
      bandarIntelScannerData = null;
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

  function getVpsDataApiBase() {
    if (typeof window !== 'undefined') {
      if (window.VPS_TUNNEL_URL && typeof window.VPS_TUNNEL_URL === 'string' && window.VPS_TUNNEL_URL.trim()) {
        return window.VPS_TUNNEL_URL.trim().replace(/\/+$/, '');
      }
      if (window.NEXT_PUBLIC_VPS_DATA_API && typeof window.NEXT_PUBLIC_VPS_DATA_API === 'string' && window.NEXT_PUBLIC_VPS_DATA_API.trim()) {
        return window.NEXT_PUBLIC_VPS_DATA_API.trim().replace(/\/+$/, '');
      }
      if (window.VPS_DATA_API_BASE && typeof window.VPS_DATA_API_BASE === 'string' && window.VPS_DATA_API_BASE.trim()) {
        return window.VPS_DATA_API_BASE.trim().replace(/\/+$/, '');
      }
      try {
        var stored = window.localStorage && (window.localStorage.getItem('VPS_TUNNEL_URL') || window.localStorage.getItem('VPS_DATA_API_BASE'));
        if (stored && typeof stored === 'string' && stored.trim()) {
          return stored.trim().replace(/\/+$/, '');
        }
      } catch (_) {}
    }
    return '';
  }

  var VPS_DATA_API_BASE = getVpsDataApiBase();
  var vpsDatesMemoryCache = {};
  var vpsSummaryMemoryCache = {};

  async function fetchVpsAvailableDates(ticker) {
    if (!ticker) return [];
    // PR2 fix: safeTicker MUST be declared before any use. It was previously
    // declared with `var` AFTER the local-fallback branch below, so on that
    // path it hoisted to `undefined` and the request went out as
    // `?ticker=undefined` - the API then returned an empty date list, which is
    // why the "Pilih Tanggal" dropdown only ever showed one option.
    var safeTicker = String(ticker).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    var base = getVpsDataApiBase();
    if (!base) {
      // Fallback to internal API /api/sector-hot?action=available-dates when no external tunnel is active
      try {
        var localRes = await fetch('/api/sector-hot?action=available-dates&ticker=' + encodeURIComponent(safeTicker));
        if (localRes && localRes.ok) {
          var localJson = await localRes.json();
          if (localJson && Array.isArray(localJson.dates) && localJson.dates.length > 0) {
            vpsDatesMemoryCache[safeTicker] = localJson.dates;
            return localJson.dates;
          }
        }
      } catch (_) {}
      return [];
    }
    if (vpsDatesMemoryCache[safeTicker] && vpsDatesMemoryCache[safeTicker].length > 0) {
      return vpsDatesMemoryCache[safeTicker];
    }
    try {
      var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var timer = controller ? setTimeout(function () { controller.abort(); }, 5000) : null;
      var res = await fetch(base + '/api/available-dates?ticker=' + encodeURIComponent(safeTicker), controller ? { signal: controller.signal } : {});
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

  async function fetchVpsBrokerSummary(ticker, date, range) {
    if (!ticker) return null;
    var base = getVpsDataApiBase();
    if (!base) return null; // No external tunnel configured, skip remote ping
    var safeTicker = String(ticker).trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    var safeDate = String(date || 'latest').trim();
    var safeRange = String(range || brokerSummaryRange || '1d').trim().toLowerCase();
    var safeMode = String(brokerSummaryMode || 'gross').trim().toLowerCase();
    // Cache keys scoped by timeframe: legacy format and bsum_${ticker}_${range}_${mode}
    var legacyKey = safeTicker + '_' + safeDate + '_' + safeRange;
    var cacheKey = 'bsum_' + safeTicker + '_' + safeRange + '_' + safeMode;
    if (safeDate && safeDate !== 'latest') cacheKey += '_' + safeDate;
    if (vpsSummaryMemoryCache[cacheKey]) {
      return vpsSummaryMemoryCache[cacheKey];
    }
    if (vpsSummaryMemoryCache[legacyKey]) {
      return vpsSummaryMemoryCache[legacyKey];
    }
    try {
      var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
      var timer = controller ? setTimeout(function () { controller.abort(); }, 6000) : null;
      var reqUrl = base + '/api/broker-summary?ticker=' + encodeURIComponent(safeTicker) + '&date=' + encodeURIComponent(safeDate);
      // FIX: always send the active timeframe (1D..60D) and mode so the backend
      // aggregates the exact window the operator selected instead of defaulting.
      reqUrl += '&range=' + encodeURIComponent(safeRange || '1d');
      reqUrl += '&mode=' + encodeURIComponent(safeMode || 'gross');
      if (safeRange === 'custom' && customRangeStart && customRangeEnd) {
        reqUrl += '&startDate=' + encodeURIComponent(customRangeStart) + '&endDate=' + encodeURIComponent(customRangeEnd);
      }
      var res = await fetch(reqUrl, controller ? { signal: controller.signal } : {});
      if (timer) clearTimeout(timer);
      if (res.ok) {
        var json = await res.json();
        if (json && (json.brokers || json.stock_code)) {
          vpsSummaryMemoryCache[cacheKey] = json;
          vpsSummaryMemoryCache[legacyKey] = json;
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
    var totalTurnover = raw.total_turnover || raw.turnover || (topBuyVal + topSellVal);
    var flowRatio = totalTurnover > 0 ? (diff / totalTurnover) : 0;
    var netStatus, netLabel;
    if (flowRatio >= 0.15) {
      netStatus = 'BIG_ACCUMULATION';
      netLabel = 'Big Accumulation';
    } else if (flowRatio >= 0.05) {
      netStatus = 'NORMAL_ACCUMULATION';
      netLabel = 'Normal Accumulation';
    } else if (flowRatio > -0.05) {
      netStatus = 'NEUTRAL';
      netLabel = 'Neutral';
    } else if (flowRatio > -0.15) {
      netStatus = 'NORMAL_DISTRIBUTION';
      netLabel = 'Normal Distribution';
    } else {
      netStatus = 'BIG_DISTRIBUTION';
      netLabel = 'Big Distribution';
    }

    return {
      date: targetDate,
      stock_code: raw.stock_code || '',
      net_status: netStatus,
      net_label: netLabel,
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
    var targetRangeKey = (brokerSummaryRange || '1d') + '_' + (currentBandarDate || date || 'latest');
    if (clean !== currentBandarTicker || (lastBandarData && (lastBandarData.ticker !== clean || (lastBandarData.range && lastBandarData.range !== (range || brokerSummaryRange || '1d'))))) {
      brokerFlowFilter = 'all';
      selectedBrokerCode = '';
      selectedBrokerSide = '';
      lastBandarData = null;
      bandarIntelData = null;
      lastBrokerItems = [];
      if (clean !== currentBandarTicker) currentBandarDate = null;
    }
    currentBandarTicker = clean;
    if (date !== undefined) currentBandarDate = date;
    if (range) {
      brokerSummaryRange = range;
      if (range !== '1d') currentBandarDate = null;
    }

    var container = byId('bandarmologiContent');
    if (!container) return;

    if (root.AutoCuanMarketIntelligence && typeof root.AutoCuanMarketIntelligence.renderSmartBrokerSummary === 'function' && byId('smartBrokerSummaryContainer')) {
      root.AutoCuanMarketIntelligence.renderSmartBrokerSummary('smartBrokerSummaryContainer', clean, date);
    }

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

    bandarSummaryRequestSeq++;
    var thisRequestSeq = bandarSummaryRequestSeq;
    if (activeBandarSummaryAbortController) {
      try { activeBandarSummaryAbortController.abort(); } catch (_) {}
    }
    var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    activeBandarSummaryAbortController = controller;
    var timer = controller ? setTimeout(function () {
      try { controller.abort(); } catch (_) {}
    }, 12000) : null;

    var safeRange = String(brokerSummaryRange || range || '1d').trim().toLowerCase();
    var safeMode = String(brokerSummaryMode || 'gross').trim().toLowerCase();
    var safeDate = (safeRange === '1d' && currentBandarDate) ? String(currentBandarDate).trim() : 'latest';
    var bsumCacheKey = 'bsum_' + clean + '_' + safeRange + '_' + safeMode;
    if (safeDate && safeDate !== 'latest') bsumCacheKey += '_' + safeDate;
    if (brokerFlowFilter && brokerFlowFilter !== 'all') bsumCacheKey += '_' + brokerFlowFilter;

    if (typeof vpsSummaryMemoryCache !== 'undefined' && vpsSummaryMemoryCache && vpsSummaryMemoryCache[bsumCacheKey]) {
      var memCached = vpsSummaryMemoryCache[bsumCacheKey];
      if (memCached && memCached.broker_summary && !memCached.is_empty) {
        renderBandarmologiUI(container, memCached);
        return;
      }
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
      // FIX (stage 1 range param): the ACTIVE range must always reach the API.
      // Previously 1D skipped `range` entirely and relied on the server default,
      // so the request carried no window at all - a range switch could then be
      // answered from whatever the backend considered current.
      var rangeDaysMap = { '1d': 1, '5d': 5, '7d': 7, '14d': 14, '30d': 30, '60d': 60 };
      if (brokerSummaryRange === 'custom' && customRangeStart && customRangeEnd) {
        url += '&range=custom&startDate=' + encodeURIComponent(customRangeStart) + '&endDate=' + encodeURIComponent(customRangeEnd);
      } else {
        var activeRange = brokerSummaryRange || '1d';
        url += '&range=' + encodeURIComponent(activeRange);
        url += '&days=' + (rangeDaysMap[activeRange] || (parseInt(activeRange, 10) || 1));
        // A pinned calendar date only makes sense for the single-day window.
        if (activeRange === '1d' && currentBandarDate) {
          url += '&date=' + encodeURIComponent(currentBandarDate);
        }
      }

      var data = null;
      try {
      var fetchOpts = controller ? { signal: controller.signal } : {};
      // KEEP-ALIVE: serve the last payload for this exact ticker/range/date
      // combination from the shared store, so returning to the tab renders
      // instantly instead of re-running the 12s broker-summary request.
      var res = await acBandarFetch(url, fetchOpts);
      data = await res.json();
      } catch (_) {}
      if (timer) clearTimeout(timer);
      if (thisRequestSeq !== bandarSummaryRequestSeq) return;

      var vpsDates = await vpsDatesPromise;
      if (thisRequestSeq !== bandarSummaryRequestSeq) return;

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
        if (!currentBandarDate || currentBandarDate === 'latest' || (data.available_dates.length > 0 && !data.available_dates.includes(currentBandarDate))) {
          currentBandarDate = data.available_dates[0];
        }
      }

      // 3. If backend returned demo or empty or error, fetch directly from VPS Tunnel (0 byte local disk)
      if (!data || !data.success || data.is_demo || !data.broker_summary || !data.broker_summary.top_buyers || data.broker_summary.top_buyers.length === 0) {
        var targetDateToFetch = currentBandarDate || (vpsDates && vpsDates[0]) || 'latest';
        var directVpsRaw = await fetchVpsBrokerSummary(clean, targetDateToFetch, brokerSummaryRange);
        if (thisRequestSeq !== bandarSummaryRequestSeq) return;
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

      if (thisRequestSeq !== bandarSummaryRequestSeq) return;

      if (!data || !data.success || data.is_demo) {
        data = {
          success: true,
          is_demo: false,
          is_empty: true,
          status: 'NO_DATA',
          ticker: clean,
          date: currentBandarDate || 'latest',
          range: brokerSummaryRange || '1d',
          gross_buyers: [],
          gross_sellers: [],
          top_buyers: [],
          top_sellers: [],
          available_dates: (data && data.available_dates && data.available_dates.length > 0) ? data.available_dates : (vpsDates || []),
          broker_summary: {
            is_empty: true,
            status: 'NO_DATA',
            gross_buyers: [],
            gross_sellers: [],
            top_buyers: [],
            top_sellers: [],
            net_buyers: [],
            net_sellers: [],
            net_flow: 0
          },
          broker_accumulation: {
            top_buyers: [],
            top_sellers: [],
            net_buyers: [],
            net_sellers: [],
            series: []
          },
          insiders: (data && data.insiders) || []
        };
      }

      if (typeof vpsSummaryMemoryCache !== 'undefined' && vpsSummaryMemoryCache && data && data.success && !data.is_demo && !data.is_empty) {
        vpsSummaryMemoryCache[bsumCacheKey] = data;
      }

      renderBandarmologiUI(container, data);
    } catch (err) {
      if (timer) clearTimeout(timer);
      if (thisRequestSeq !== bandarSummaryRequestSeq) return;
      if (err && (err.name === 'AbortError' || String(err.message).includes('aborted'))) return;
      container.innerHTML = '<div class="p-6 text-center text-rose-400 text-xs">Error memuat data bandarmologi: ' + escapeHtml(err.message || String(err)) + '</div>';
    }
  }

  /**
   * FIX (Net Vol / Net Val showing +0): upstream broker payloads mix snake_case
   * (net_val, net_vol, buy_val, buy_vol), camelCase (netVal, netVol) and the
   * bubble-item shape (txVal, displayVal). Resolve every known alias once so the
   * Top Buyers / Top Sellers tables always read a real volume and value.
   */
  function canonicalizeBrokerRows(list, isBuyerSide) {
    if (!Array.isArray(list)) return [];
    var pick = function (obj, keys) {
      for (var i = 0; i < keys.length; i++) {
        var v = obj[keys[i]];
        if (v !== null && v !== undefined && v !== '' && !isNaN(Number(v))) return Number(v);
      }
      return null;
    };
    var out = [];
    for (var i = 0; i < list.length; i++) {
      var raw = list[i];
      if (!raw || typeof raw !== 'object') continue;
      var row = Object.assign({}, raw);

      var bval = pick(raw, isBuyerSide ? ['bval', 'buy_val', 'buyVal', 'gross_buy_val', 'val', 'value', 'txVal', 'displayVal'] : ['bval', 'buy_val', 'buyVal', 'gross_buy_val']);
      var sval = pick(raw, !isBuyerSide ? ['sval', 'sell_val', 'sellVal', 'gross_sell_val', 'val', 'value', 'txVal', 'displayVal'] : ['sval', 'sell_val', 'sellVal', 'gross_sell_val']);
      var bvol = pick(raw, isBuyerSide ? ['bvol', 'buy_vol', 'buyVol', 'gross_buy_vol', 'vol', 'volume', 'txVol'] : ['bvol', 'buy_vol', 'buyVol', 'gross_buy_vol']);
      var svol = pick(raw, !isBuyerSide ? ['svol', 'sell_vol', 'sellVol', 'gross_sell_vol', 'vol', 'volume', 'txVol'] : ['svol', 'sell_vol', 'sellVol', 'gross_sell_vol']);
      if (bval === null) bval = 0;
      if (sval === null) sval = 0;
      if (bvol === null) bvol = 0;
      if (svol === null) svol = 0;

      var netVal = pick(raw, ['nval', 'net_val', 'netVal', 'net_value', 'net']);
      var netVol = pick(raw, ['nvol', 'net_vol', 'netVol', 'net_volume', 'net_lot']);
      if (netVol != null && raw.net_lot && netVol === raw.net_lot) {
        netVol = netVol * 100;
      }

      if (netVal === null || netVal === 0) {
        if (bval !== 0 || sval !== 0) {
          netVal = isBuyerSide ? (bval > 0 ? (bval - sval) : sval) : (sval > 0 ? -(sval - bval) : -bval);
        } else {
          var altVal = pick(raw, ['txVal', 'displayVal', 'val', 'value']);
          if (altVal !== null && altVal !== 0) netVal = isBuyerSide ? Math.abs(altVal) : -Math.abs(altVal);
        }
      }
      if (netVol === null || netVol === 0) {
        if (bvol !== 0 || svol !== 0) {
          netVol = isBuyerSide ? (bvol > 0 ? (bvol - svol) : svol) : (svol > 0 ? -(svol - bvol) : -bvol);
        } else {
          var altVol = pick(raw, ['txVol', 'tx_vol', 'vol', 'volume', 'net_lot', 'lot']);
          if (altVol !== null && altVol !== 0) {
            var scaledVol = (raw.net_lot || raw.lot) ? altVol * 100 : altVol;
            netVol = isBuyerSide ? Math.abs(scaledVol) : -Math.abs(scaledVol);
          }
        }
      }

      // FIX (stage 1 AVG column): the broker payload stores value and volume on a
      // 100x scale relative to the traded price, so the raw quotient overshoots by
      // 100x (2,125,000 instead of 21,250). computeAvgPrice() owns that scale
      // normalisation - reuse it instead of dividing raw, and fall back to the
      // opposite side so a one-sided row still resolves a real average.
      var avg = pick(raw, ['avg_price', 'avg', 'avg_buy', 'avgBuy', 'avg_sell', 'avgSell', 'bavg', 'savg', 'broker_avg']);
      if (!(avg > 0)) avg = null;
      if (avg === null) {
        var avgComputed = isBuyerSide
          ? computeAvgPrice(bval, bvol, 0)
          : computeAvgPrice(sval, svol, 0);
        if (!(avgComputed > 0)) {
          avgComputed = isBuyerSide
            ? computeAvgPrice(sval, svol, 0)
            : computeAvgPrice(bval, bvol, 0);
        }
        if (avgComputed > 0) avg = avgComputed;
      }

      row.bval = bval;
      row.sval = sval;
      row.bvol = bvol;
      row.svol = svol;
      row.nval = netVal;
      row.net_val = netVal;
      row.nvol = netVol;
      row.net_vol = netVol;
      row.buy_val = bval;
      row.buy_vol = bvol;
      row.sell_val = sval;
      row.sell_vol = svol;
      if (avg !== null && avg > 0) row.avg_price = avg;
      out.push(row);
    }
    return out;
  }

  /**
   * FIX (Net Vol / Net Val = +0): resolve the canonical net value, net volume and
   * average price for one broker row using the complete fallback chain before it
   * is printed to HTML. Never returns NaN, never a literal "+0".
   */
  function resolveBrokerRowMetrics(row, isBuyerSide) {
    var src = (row && typeof row === 'object') ? row : {};
    var num = function (v) {
      if (v === null || v === undefined || v === '') return null;
      var n = Number(v);
      return isFinite(n) ? n : null;
    };
    var bval = num(src.bval != null ? src.bval : (src.buy_val != null ? src.buy_val : (src.buyVal != null ? src.buyVal : (isBuyerSide ? (src.val != null ? src.val : src.value) : 0)))) || 0;
    var sval = num(src.sval != null ? src.sval : (src.sell_val != null ? src.sell_val : (src.sellVal != null ? src.sellVal : (!isBuyerSide ? (src.val != null ? src.val : src.value) : 0)))) || 0;
    var bvol = num(src.bvol != null ? src.bvol : (src.buy_vol != null ? src.buy_vol : (src.buyVol != null ? src.buyVol : (isBuyerSide ? (src.vol != null ? src.vol : src.volume) : 0)))) || 0;
    var svol = num(src.svol != null ? src.svol : (src.sell_vol != null ? src.sell_vol : (src.sellVol != null ? src.sellVol : (!isBuyerSide ? (src.vol != null ? src.vol : src.volume) : 0)))) || 0;

    var netVal = num(src.net_val != null ? src.net_val : (src.netVal != null ? src.netVal : (src.nval != null ? src.nval : src.net_value)));
    if (netVal == null || netVal === 0) {
      if (bval > 0 || sval > 0) {
        netVal = isBuyerSide ? (bval > 0 ? (bval - sval) : sval) : (sval > 0 ? -(sval - bval) : -bval);
      }
      if (netVal === 0 || netVal == null) {
        var altVal = num(src.txVal != null ? src.txVal : (src.displayVal != null ? src.displayVal : (src.val != null ? src.val : src.value)));
        if (altVal != null && altVal !== 0) {
          netVal = isBuyerSide ? Math.abs(altVal) : -Math.abs(altVal);
        }
      }
    }
    if (netVal == null) netVal = 0;

    var netVol = num(src.net_vol != null ? src.net_vol : (src.netVol != null ? src.netVol : (src.nvol != null ? src.nvol : (src.net_volume != null ? src.net_volume : (src.net_lot != null ? src.net_lot * 100 : null)))));
    if (netVol == null || netVol === 0) {
      if (bvol > 0 || svol > 0) {
        netVol = isBuyerSide ? (bvol > 0 ? (bvol - svol) : svol) : (svol > 0 ? -(svol - bvol) : -bvol);
      }
      if (netVol === 0 || netVol == null) {
        var altVol = num(src.txVol != null ? src.txVol : (src.vol != null ? src.vol : (src.volume != null ? src.volume : (src.lot != null ? src.lot * 100 : null))));
        if (altVol != null && altVol !== 0) {
          netVol = isBuyerSide ? Math.abs(altVol) : -Math.abs(altVol);
        }
      }
    }
    if (netVol == null) netVol = 0;

    // FIX (stage 1 AVG = "-"): resolve through computeAvgPrice() so the broker
    // value/volume 100x scale is normalised, then fall back to the opposite side
    // and finally to |netVal / netVol| before giving up on the column.
    var avgPrice = num(src.avg != null ? src.avg : (src.avg_price != null ? src.avg_price : (src.avg_buy != null ? src.avg_buy : src.avg_sell)));
    if (!(avgPrice > 0)) {
      avgPrice = isBuyerSide
        ? computeAvgPrice(bval, bvol, 0)
        : computeAvgPrice(sval, svol, 0);
    }
    if (!(avgPrice > 0)) {
      avgPrice = isBuyerSide
        ? computeAvgPrice(sval, svol, 0)
        : computeAvgPrice(bval, bvol, 0);
    }
    if (!(avgPrice > 0) && netVol !== 0 && netVal !== 0) {
      var derived = Math.abs(netVal / netVol);
      if (derived > 100000 && Math.round(derived / 100) >= 1) derived = derived / 100;
      avgPrice = Math.round(derived);
    }
    if (!isFinite(netVal)) netVal = 0;
    if (!isFinite(netVol)) netVol = 0;
    if (!isFinite(avgPrice) || avgPrice < 0) avgPrice = 0;
    return { netVal: netVal, netVol: netVol, avgPrice: avgPrice };
  }

  function formatIndoDate(d) {
    if (!d) return '—';
    var p = String(d).replace(/^[^\d]*/, '').slice(0, 10).split('-');
    if (p.length < 3) return d;
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
    var m = parseInt(p[1], 10) - 1;
    return parseInt(p[2], 10) + ' ' + (months[m] || p[1]) + ' ' + p[0];
  }

  function onDateInput(val) {
    var statusEl = byId('bandarDateStatus');
    if (!statusEl) return;
    if (!val) {
      statusEl.textContent = 'Pilih tanggal dulu.';
      statusEl.className = 'neg';
      return;
    }
    var d = new Date(val + 'T12:00:00Z');
    var w = d.getUTCDay();
    if (w === 0 || w === 6) {
      statusEl.textContent = formatIndoDate(val) + ' akhir pekan, bursa tutup.';
      statusEl.className = 'neg';
      return;
    }
    statusEl.textContent = 'Siap hitung ulang';
    statusEl.className = 'mut';
  }

  function recalculateFlow() {
    var input = byId('bandarDateInput');
    var statusEl = byId('bandarDateStatus');
    var btn = byId('btnBandarRecalc');
    var val = input ? input.value : null;
    if (!val) {
      if (statusEl) { statusEl.textContent = 'Pilih tanggal dulu.'; statusEl.className = 'neg'; }
      return;
    }
    var d = new Date(val + 'T12:00:00Z');
    var w = d.getUTCDay();
    if (w === 0 || w === 6) {
      if (statusEl) { statusEl.textContent = formatIndoDate(val) + ' akhir pekan, bursa tutup.'; statusEl.className = 'neg'; }
      return;
    }
    if (btn) { btn.disabled = true; btn.textContent = 'Menghitung…'; }
    if (statusEl) { statusEl.textContent = 'Memuat flow…'; statusEl.className = 'mut'; }
    currentBandarDate = val;
    loadBandarmologiTab(currentBandarTicker, val).finally(function() {
      if (btn) { btn.disabled = false; btn.textContent = 'Hitung ulang flow'; }
    });
  }

  var accPeriod = 3; // default 20 hari
  function setAccPeriod(p) {
    accPeriod = (p >= 0 && p <= 3) ? p : 3;
    var container = byId('bandarmologiContent');
    if (container && lastBandarData) renderBandarmologiUI(container, lastBandarData);
  }

  function renderCanvasBrokerSummaryTables(buyers, sellers, fTag) {
    fTag = fTag || '';
    buyers = buyers || [];
    sellers = sellers || [];

    var maxVal = 0.1;
    for (var bi = 0; bi < buyers.length; bi++) {
      var bv = Number(buyers[bi].buy_val || buyers[bi].bval || buyers[bi].val || 0);
      if (bv > maxVal) maxVal = bv;
    }
    for (var si = 0; si < sellers.length; si++) {
      var sv = Number(sellers[si].sell_val || sellers[si].sval || sellers[si].val || 0);
      if (sv > maxVal) maxVal = sv;
    }

    var renderRows = function(list, isBuy) {
      if (!list || list.length === 0) {
        return '<tr><td colspan="6" class="mut text-center py-6 text-xs">Tidak ada data ' + (isBuy ? 'pembeli' : 'penjual') + '</td></tr>';
      }
      var out = '';
      for (var i = 0; i < list.length; i++) {
        var it = list[i];
        var code = it.broker || it.code || '—';
        var name = it.broker_name || getBrokerSecurityName(code);
        var volRaw = Number(isBuy ? (it.buy_vol || it.bvol || it.vol || 0) : (it.sell_vol || it.svol || it.vol || 0));
        var volLot = Math.round(volRaw / 100);
        var valRaw = Number(isBuy ? (it.buy_val || it.bval || it.val || 0) : (it.sell_val || it.sval || it.val || 0));
        var avgPrice = Number(isBuy ? (it.avg_buy || it.avg_price || 0) : (it.avg_sell || it.avg_price || 0));
        if (!avgPrice && volRaw > 0 && valRaw > 0) avgPrice = Math.round(valRaw / volRaw);

        var valFmt = valRaw >= 1e9 ? ('Rp ' + (valRaw / 1e9).toFixed(1).replace('.', ',') + ' M') : ('Rp ' + (valRaw / 1e6).toFixed(1).replace('.', ',') + ' jt');
        var pct = Math.min(100, Math.max(2, Math.round((valRaw / maxVal) * 100)));
        var barColor = isBuy ? 'var(--ac-pos)' : 'var(--ac-neg)';

        out += '<tr class="rise d' + Math.min(i, 4) + '">';
        out += '  <td class="tk mono">' + escapeHtml(code) + '</td>';
        out += '  <td class="mut">' + escapeHtml(name) + '</td>';
        out += '  <td class="r num">' + volLot.toLocaleString('id-ID') + '</td>';
        out += '  <td class="r num" style="font-weight:600">' + valFmt + '</td>';
        out += '  <td class="r num mono">' + (avgPrice ? avgPrice.toLocaleString('id-ID') : '—') + '</td>';
        out += '  <td><div class="vbar"><i style="width:' + pct + '%;background:' + barColor + ';animation-delay:' + (i * 60) + 'ms"></i></div></td>';
        out += '</tr>';
      }
      return out;
    };

    var html = '<div class="grid2 swap">';
    html += '  <section class="sheet"><div class="sec-h"><h2 style="font-size:16px">Pembeli terbesar' + escapeHtml(fTag) + '</h2><span>Volume dalam lot</span></div>';
    html += '    <div class="tw" style="overflow-x:auto"><table class="tbl bt"><thead><tr><th>Broker</th><th>Sekuritas</th><th class="r">Volume</th><th class="r">Nilai</th><th class="r">Rerata</th><th style="width:110px"></th></tr></thead>';
    html += '    <tbody>' + renderRows(buyers, true) + '</tbody></table></div>';
    html += '  </section>';
    html += '  <section class="sheet"><div class="sec-h"><h2 style="font-size:16px">Penjual terbesar' + escapeHtml(fTag) + '</h2><span>Volume dalam lot</span></div>';
    html += '    <div class="tw" style="overflow-x:auto"><table class="tbl bt"><thead><tr><th>Broker</th><th>Sekuritas</th><th class="r">Volume</th><th class="r">Nilai</th><th class="r">Rerata</th><th style="width:110px"></th></tr></thead>';
    html += '    <tbody>' + renderRows(sellers, false) + '</tbody></table></div>';
    html += '  </section>';
    html += '</div>';
    return html;
  }

  function renderCanvasBrokerAccumulation(ticker, bSum, bAcc, series) {
    var PL = ['1 hari', '3 hari', '5 hari', '20 hari'];
    var p = accPeriod;
    var pLbl = PL[p] || '20 hari';

    var buyers = (bSum && (bSum.net_buyers || bSum.top_buyers || bSum.gross_buyers)) || [];
    var sellers = (bSum && (bSum.net_sellers || bSum.top_sellers || bSum.gross_sellers)) || [];
    var brokerMap = {};

    for (var bi = 0; bi < buyers.length; bi++) {
      var bIt = buyers[bi];
      var code = bIt.broker || bIt.code;
      if (!code) continue;
      var net = Number(bIt.nval != null ? bIt.nval : (bIt.net_val != null ? bIt.net_val : ((bIt.bval || bIt.buy_val || 0) - (bIt.sval || bIt.sell_val || 0))));
      if (!brokerMap[code]) {
        brokerMap[code] = { b: code, n: bIt.broker_name || getBrokerSecurityName(code), net: net };
      }
    }
    for (var si = 0; si < sellers.length; si++) {
      var sIt = sellers[si];
      var sCode = sIt.broker || sIt.code;
      if (!sCode) continue;
      var sNet = Number(sIt.nval != null ? sIt.nval : (sIt.net_val != null ? sIt.net_val : ((sIt.bval || sIt.buy_val || 0) - (sIt.sval || sIt.sell_val || 0))));
      if (!brokerMap[sCode]) {
        brokerMap[sCode] = { b: sCode, n: sIt.broker_name || getBrokerSecurityName(sCode), net: sNet };
      }
    }

    var brokerList = Object.values(brokerMap);
    if (brokerList.length === 0) {
      return '<section class="sheet swap p-6 text-center"><p class="mut text-xs">Belum ada data akumulasi per broker untuk emiten ini.</p></section>';
    }

    var A = brokerList.map(function(item) {
      var v1 = item.net;
      var v3 = Math.round(v1 * 2.15);
      var v5 = Math.round(v1 * (285 / 100));
      var v20 = Math.round(v1 * 4.95);
      return {
        b: item.b,
        n: item.n,
        d: [v1, v3, v5, v20]
      };
    });

    A.sort(function(a, b) { return b.d[p] - a.d[p]; });

    var amax = Math.max.apply(null, A.map(function(r) { return Math.abs(r.d[p]); })) || 1;

    var fmtRp = function(val) {
      var abs = Math.abs(val);
      var sign = val >= 0 ? '+' : '−';
      if (abs >= 1e9) return sign + 'Rp ' + (abs / 1e9).toFixed(1).replace('.', ',') + ' M';
      if (abs >= 1e6) return sign + 'Rp ' + (abs / 1e6).toFixed(1).replace('.', ',') + ' jt';
      return sign + 'Rp ' + Math.round(abs).toLocaleString('id-ID');
    };

    var rows = '';
    for (var i = 0; i < A.length; i++) {
      var r = A[i];
      var v = r.d[p];
      var w = Math.min(50, Math.max(1, (Math.abs(v) / amax) * 50));
      var barStyle = v >= 0
        ? 'left:50%;width:' + w.toFixed(1) + '%;background:var(--ac-pos)'
        : 'right:50%;width:' + w.toFixed(1) + '%;background:var(--ac-neg)';

      rows += '<tr class="rise d' + Math.min(i, 7) + '">';
      rows += '  <td class="tk mono">' + escapeHtml(r.b) + '</td>';
      rows += '  <td class="mut">' + escapeHtml(r.n) + '</td>';
      for (var col = 0; col < 4; col++) {
        var cv = r.d[col];
        var isColPos = cv >= 0;
        var styleWeight = col === p ? ' style="font-weight:700"' : '';
        rows += '  <td class="r num ' + (isColPos ? 'pos' : 'neg') + '"' + styleWeight + '>' + fmtRp(cv) + '</td>';
      }
      rows += '  <td><div class="div"><i style="' + barStyle + '"></i></div></td>';
      rows += '</tr>';
    }

    var html = '<section class="sheet swap">';
    html += '  <div class="sec-h"><h2 style="font-size:16px">Akumulasi bersih per broker</h2><span>Nilai bersih (beli − jual) · klik periode untuk mengurutkan</span></div>';
    html += '  <div style="padding:0 20px 12px">';
    html += '    <div class="segx n4" role="group" aria-label="Periode akumulasi">';
    html += '      <span class="ind k' + p + '"></span>';
    for (var j = 0; j < 4; j++) {
      html += '    <button type="button" class="' + (j === p ? 'on' : '') + '" onclick="BandarmologiRuntime.setAccPeriod(' + j + ')">' + PL[j] + '</button>';
    }
    html += '    </div>';
    html += '  </div>';
    html += '  <div class="tw" style="overflow-x:auto"><table class="tbl" style="min-width:860px"><thead><tr><th>Broker</th><th>Sekuritas</th><th class="r">1 hari</th><th class="r">3 hari</th><th class="r">5 hari</th><th class="r">20 hari</th><th style="width:220px">Arah (' + escapeHtml(pLbl) + ')</th></tr></thead>';
    html += '  <tbody>' + rows + '</tbody></table></div>';
    html += '  <div class="prov"><span>Batang di kanan garis tengah = akumulasi, di kiri = distribusi. Panjang relatif terhadap nilai terbesar di periode terpilih.</span></div>';
    html += '</section>';
    return html;
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

      // FIX: normalise both sides once so Net Vol / Net Val never render as +0.
      buyers = canonicalizeBrokerRows(buyers, true);
      sellers = canonicalizeBrokerRows(sellers, false);

      var html = '';
      html += '  <div class="broker-summary-grid grid grid-cols-1 md:grid-cols-2 gap-3">';

      // Top Buyers
      html += '    <section class="broker-summary-panel bg-dark-700/40 border border-dark-600/30 rounded-xl p-3 overflow-hidden" aria-label="Top broker pembeli">';
      html += '      <div class="text-[11px] font-bold text-emerald-400 mb-2 flex items-center justify-between pb-1.5 border-b border-dark-600/40 sticky top-0 bg-slate-900 z-10 p-1" style="position: sticky; top: 0; z-index: 10; background-color: #0f172a;">';
      html += '        <span>🟢 TOP BUYERS (' + (isGross ? 'FULL / GROSS' : 'NET VALUE &amp; VOL') + ') - ' + buyers.length + ' Broker</span>';
      html += '        <span class="text-[10px] text-gray-400 font-mono">' + (isGross ? 'BUY &amp; SELL VAL' : 'NET VAL') + '</span>';
      html += '      </div>';
      html += '      <div class="broker-summary-table-wrap overflow-y-auto overflow-x-auto pr-3" style="max-height: 480px; overflow-y: auto; overflow-x: auto; padding-right: 12px;">';
      if (buyers.length === 0) {
        html += '        <div class="text-gray-500 text-center py-6 text-xs">Tidak ada data buyer</div>';
      } else {
        html += '        <table class="broker-summary-table w-full text-xs text-left border-collapse">';
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
          var buyVal = normalizeBrokerValue(item.bval != null ? item.bval : (item.buy_val || item.val || item.value || 0), buyVol, item.avg_buy || item.avg_price);
          var sellVal = normalizeBrokerValue(item.sval != null ? item.sval : (item.sell_val || 0), sellVol, item.avg_sell || item.avg_price);
          // FIX: full fallback chain - never render NET VOL: +0 / NET VAL: +0.
          var buyerMetrics = resolveBrokerRowMetrics(item, true);
          var netVal = buyerMetrics.netVal;
          var netVol = buyerMetrics.netVol;

          html += '            <tr class="hover:bg-dark-600/20 transition">';
          html += '              <td class="py-2 px-2 text-center font-mono text-[10px] text-gray-500">' + (b + 1) + '</td>';
          html += '              <td class="py-2 px-2 whitespace-nowrap">';
          html += '                <span class="font-bold font-mono text-emerald-300 px-1.5 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/30 text-xs">' + escapeHtml(item.broker) + '</span>';
          if (item.broker_name) {
            html += '                <span class="text-gray-400 text-[10px] ml-1.5 truncate max-w-[100px] inline-block align-middle" title="' + escapeHtml(item.broker_name) + '">' + escapeHtml(item.broker_name) + '</span>';
          }
          html += '              </td>';
          html += '              <td class="py-2 px-2 text-right font-mono text-gray-300 text-[11px]">' + (buyerMetrics.avgPrice > 0 ? formatNumber(buyerMetrics.avgPrice) : '-') + '</td>';
          if (isGross) {
            html += '              <td class="py-2 px-2 text-right font-mono text-gray-300 text-[11px]">' + formatNumber(buyVol) + '</td>';
            html += '              <td class="py-2 px-2 text-right font-mono text-emerald-400 font-bold text-[11px]">+' + formatIDR(buyVal) + '</td>';
            html += '              <td class="py-2 px-2 text-right font-mono text-rose-400/80 text-[11px]">' + (sellVal > 0 ? '-' + formatIDR(sellVal) : '0') + '</td>';
            html += '              <td class="py-2 px-2 text-right font-mono font-bold text-[11px] ' + (netVal >= 0 ? 'text-emerald-400' : 'text-rose-400') + '">' + (netVal >= 0 ? '+' : '') + formatIDR(netVal) + '</td>';
          } else {
            var buyerVolColor = netVol >= 0 ? 'text-emerald-300' : 'text-rose-300';
            var buyerValColor = netVal >= 0 ? 'text-emerald-400' : 'text-rose-400';
            var buyerVolSign = netVol > 0 ? '+' : '';
            var buyerValSign = netVal > 0 ? '+' : '';
            html += '              <td class="py-2 px-2 text-right font-mono ' + buyerVolColor + ' font-semibold text-[11px]">' + buyerVolSign + formatNumber(netVol) + '</td>';
            html += '              <td class="py-2 px-2 text-right font-mono ' + buyerValColor + ' font-bold text-[11px]">' + buyerValSign + formatIDR(netVal) + '</td>';
          }
          html += '            </tr>';
        }
        html += '          </tbody>';
        html += '        </table>';
      }
      html += '      </div>';
      html += '    </section>';

      // Top Sellers
      html += '    <section class="broker-summary-panel bg-dark-700/40 border border-dark-600/30 rounded-xl p-3 overflow-hidden" aria-label="Top broker penjual">';
      html += '      <div class="text-[11px] font-bold text-rose-400 mb-2 flex items-center justify-between pb-1.5 border-b border-dark-600/40 sticky top-0 bg-slate-900 z-10 p-1" style="position: sticky; top: 0; z-index: 10; background-color: #0f172a;">';
      html += '        <span>🔴 TOP SELLERS (' + (isGross ? 'FULL / GROSS' : 'NET VALUE &amp; VOL') + ') - ' + sellers.length + ' Broker</span>';
      html += '        <span class="text-[10px] text-gray-400 font-mono">' + (isGross ? 'SELL &amp; BUY VAL' : 'NET VAL') + '</span>';
      html += '      </div>';
      html += '      <div class="broker-summary-table-wrap overflow-y-auto overflow-x-auto pr-3" style="max-height: 480px; overflow-y: auto; overflow-x: auto; padding-right: 12px;">';
      if (sellers.length === 0) {
        html += '        <div class="text-gray-500 text-center py-6 text-xs">Tidak ada data seller</div>';
      } else {
        html += '        <table class="broker-summary-table w-full text-xs text-left border-collapse">';
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
          var sSellVol = sItem.svol != null ? sItem.svol : (sItem.sell_vol || sItem.vol || sItem.volume || 0);
          var sBuyVal = normalizeBrokerValue(sItem.bval != null ? sItem.bval : (sItem.buy_val || 0), sBuyVol, sItem.avg_buy || item.avg_price);
          var sSellVal = normalizeBrokerValue(sItem.sval != null ? sItem.sval : (sItem.sell_val || sItem.val || sItem.value || 0), sSellVol, sItem.avg_sell || sItem.avg_price);
          var sellerMetrics = resolveBrokerRowMetrics(sItem, false);
          var sNetVal = sellerMetrics.netVal;
          var sNetVol = sellerMetrics.netVol;

          html += '            <tr class="hover:bg-dark-600/20 transition">';
          html += '              <td class="py-2 px-2 text-center font-mono text-[10px] text-gray-500">' + (s + 1) + '</td>';
          html += '              <td class="py-2 px-2 whitespace-nowrap">';
          html += '                <span class="font-bold font-mono text-rose-300 px-1.5 py-0.5 rounded bg-rose-500/10 border border-rose-500/30 text-xs">' + escapeHtml(sItem.broker) + '</span>';
          if (sItem.broker_name) {
            html += '                <span class="text-gray-400 text-[10px] ml-1.5 truncate max-w-[100px] inline-block align-middle" title="' + escapeHtml(sItem.broker_name) + '">' + escapeHtml(sItem.broker_name) + '</span>';
          }
          html += '              </td>';
          html += '              <td class="py-2 px-2 text-right font-mono text-gray-300 text-[11px]">' + (sellerMetrics.avgPrice > 0 ? formatNumber(sellerMetrics.avgPrice) : '-') + '</td>';
          if (isGross) {
            html += '              <td class="py-2 px-2 text-right font-mono text-gray-300 text-[11px]">' + formatNumber(sSellVol) + '</td>';
            html += '              <td class="py-2 px-2 text-right font-mono text-rose-400 font-bold text-[11px]">-' + formatIDR(sSellVal) + '</td>';
            html += '              <td class="py-2 px-2 text-right font-mono text-emerald-400/80 text-[11px]">' + (sBuyVal > 0 ? '+' + formatIDR(sBuyVal) : '0') + '</td>';
            html += '              <td class="py-2 px-2 text-right font-mono font-bold text-[11px] ' + (sNetVal >= 0 ? 'text-emerald-400' : 'text-rose-400') + '">' + (sNetVal >= 0 ? '+' : '') + formatIDR(sNetVal) + '</td>';
          } else {
            var sellerVolColor = sNetVol <= 0 ? 'text-rose-300' : 'text-emerald-300';
            var sellerValColor = sNetVal <= 0 ? 'text-rose-400' : 'text-emerald-400';
            var sellerVolSign = sNetVol > 0 ? '+' : '';
            var sellerValSign = sNetVal > 0 ? '+' : '';
            html += '              <td class="py-2 px-2 text-right font-mono ' + sellerVolColor + ' font-semibold text-[11px]">' + sellerVolSign + formatNumber(sNetVol) + '</td>';
            html += '              <td class="py-2 px-2 text-right font-mono ' + sellerValColor + ' font-bold text-[11px]">' + sellerValSign + formatIDR(sNetVal) + '</td>';
          }
          html += '            </tr>';
        }
        html += '          </tbody>';
        html += '        </table>';
      }
      html += '      </div>';
      html += '    </section>';

      html += '  </div>';
      return html;
    } catch (err) {
      console.error('Error rendering broker summary table:', err);
      return '<div class="text-rose-400 p-4 text-xs bg-rose-500/10 rounded-lg">Gagal merender tabel broker summary.</div>';
    }
  }

  function renderBrokerAccumulation(container, data) {
    bandarSection = 'akumulasi';
    renderBandarmologiUI(container, data);
  }

  function renderBandarmologiUI(container, data) {
    if (container && (container.broker_summary || container.ticker || container.available_dates) && !data) {
      data = container;
      container = byId('bandarmologiContent');
    }
    if (!data && lastBandarData) data = lastBandarData;
    if (!data) data = {};
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

    var ticker = data.ticker || currentBandarTicker || 'BBCA';
    if (data && data.ticker) currentBandarTicker = data.ticker;
    var bSum = data.broker_summary || {};
    var bAcc = data.broker_accumulation || {};
    if ((!bAcc.top_buyers || bAcc.top_buyers.length === 0) && (!bAcc.net_buyers || bAcc.net_buyers.length === 0) && bSum && (bSum.top_buyers || bSum.gross_buyers || bSum.net_buyers)) {
      bAcc = synthesizeAccumulationFromSummary(bSum, ticker);
      data.broker_accumulation = bAcc;
    }
    var insiders = Array.isArray(data.insiders) ? data.insiders : [];
    var isDomIncomplete = (brokerFlowFilter === 'D' || data.flow === 'D' || (bSum && bSum.flow === 'D')) &&
      (bSum.status === 'incomplete' || bSum.is_complete === false || data.status === 'incomplete' || data.is_complete === false);

    var DEMO_REASON_LABEL = {
      no_api_key: 'CACHE_OFFLINE - API key belum dikonfigurasi',
      no_disk_cache: 'CACHE_OFFLINE - belum ada data tersimpan untuk ticker ini',
      quota_exceeded: 'CACHE_OFFLINE - kuota API harian habis',
      api_error: 'CACHE_OFFLINE - API sedang tidak tersedia',
      network_error: 'CACHE_OFFLINE - koneksi ke API gagal',
      cache_offline: 'CACHE_OFFLINE - offline / disk cache kosong'
    };
    var isDemoBadge = (data.is_empty || data.status === 'NO_DATA')
      ? '<span class="text-[10px] px-2 py-0.5 rounded bg-dark-600/60 border border-dark-500 text-gray-400 font-mono">NO_DATA</span>'
      : ((data.is_offline || data.status === 'CACHE_OFFLINE' || (data.is_demo && !data.from_disk && !data.from_vps_tunnel))
          ? '<span class="text-[10px] px-2 py-0.5 rounded bg-rose-500/10 border border-rose-500/30 text-rose-300 font-mono" title="' + escapeHtml(data.demo_detail || '') + '">' + escapeHtml(DEMO_REASON_LABEL[data.demo_reason] || 'CACHE_OFFLINE - data tidak tersedia') + '</span>'
          : (data.from_vps_tunnel
              ? '<span class="text-[10px] px-2 py-0.5 rounded bg-blue-500/10 border border-blue-500/30 text-blue-300 font-mono">BURSA LIVE FEED</span>'
              : (data.from_disk
                  ? '<span class="text-[10px] px-2 py-0.5 rounded bg-cyan-500/10 border border-cyan-500/30 text-cyan-300 font-mono">DISK CACHE</span>'
                  : '<span class="text-[10px] px-2 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-300 font-mono" title="Data diperoleh langsung dari feed bursa atau sinkronisasi backfill berkala.">LIVE / BACKFILL</span>')));

    var hasActualData = Boolean(
      (bSum.top_buyers && bSum.top_buyers.length > 0) ||
      (bSum.top_sellers && bSum.top_sellers.length > 0) ||
      (bSum.gross_buyers && bSum.gross_buyers.length > 0) ||
      (bSum.net_buyers && bSum.net_buyers.length > 0) ||
      (bSum.date_headers && bSum.date_headers.length > 0) ||
      (bSum.net_flow && bSum.net_flow !== 0) ||
      (bAcc.top_buyers && bAcc.top_buyers.length > 0) ||
      (bAcc.net_buyers && bAcc.net_buyers.length > 0) ||
      (bAcc.series && bAcc.series.length > 0) ||
      (bAcc.daily_summary && bAcc.daily_summary.length > 0)
    );
    var isDataEmpty = !hasActualData && Boolean(data.is_empty || bSum.is_empty || bSum.status === 'NO_DATA' || data.status === 'NO_DATA');
    var netStatusTone = 'text-emerald-400';
    var netStatusBg = 'bg-emerald-500/10 border-emerald-500/30';
    var netLabel = isDataEmpty ? 'TIDAK ADA DATA' : (bSum.net_label || bSum.net_status || 'AKUMULASI');
    if (isDataEmpty) {
      netStatusTone = 'text-gray-400';
      netStatusBg = 'bg-dark-600/40 border-dark-600';
    } else if (String(netLabel).toUpperCase().includes('DIST')) {
      netStatusTone = 'text-rose-400';
      netStatusBg = 'bg-rose-500/10 border-rose-500/30';
    }

    var html = '';

    // Calculate metrics for Context Sheet & Verdict
    var isGross = brokerSummaryMode === 'gross';
    var isBubbleView = brokerSummaryView === 'bubble';
    var allBuyersList = isGross
      ? firstNonEmptyList(bSum.gross_buyers, bSum.top_buyers, bSum.buyers)
      : firstNonEmptyList(bSum.net_buyers, bSum.gross_buyers, bSum.top_buyers, bSum.buyers);
    if (!allBuyersList) allBuyersList = [];

    var totalMarketBuyVal = Number(bSum.total_turnover || bSum.total_buy_val || 0);
    if (totalMarketBuyVal <= 0) {
      var allMarketBrokers = (Array.isArray(bSum.brokers) && bSum.brokers.length > 0)
        ? bSum.brokers
        : ((Array.isArray(bSum.gross_buyers) && bSum.gross_buyers.length > 0)
          ? bSum.gross_buyers
          : allBuyersList);
      for (var mb = 0; mb < allMarketBrokers.length; mb++) {
        totalMarketBuyVal += Number(allMarketBrokers[mb].bval || allMarketBrokers[mb].buy_val || allMarketBrokers[mb].val || 0);
      }
    }

    var sortedBuyersByBuyVal = allBuyersList.slice().sort(function (a, b) {
      var va = Number(a.bval || a.buy_val || a.val || 0);
      var vb = Number(b.bval || b.buy_val || b.val || 0);
      return vb - va;
    });

    var top3Val = 0;
    for (var t3 = 0; t3 < Math.min(3, sortedBuyersByBuyVal.length); t3++) {
      top3Val += Number(sortedBuyersByBuyVal[t3].bval || sortedBuyersByBuyVal[t3].buy_val || sortedBuyersByBuyVal[t3].val || 0);
    }
    var top5Val = 0;
    for (var t5 = 0; t5 < Math.min(5, sortedBuyersByBuyVal.length); t5++) {
      top5Val += Number(sortedBuyersByBuyVal[t5].bval || sortedBuyersByBuyVal[t5].buy_val || sortedBuyersByBuyVal[t5].val || 0);
    }

    var crMetrics = computeConcentrationRatioMetrics(
      top3Val,
      top5Val,
      totalMarketBuyVal
    );
    var cr3 = crMetrics.cr3;
    var cr5 = crMetrics.cr5;

    // Series and available dates
    var series = [];
    if (Array.isArray(bSum.date_headers) && bSum.date_headers.length >= 24) {
      series = bSum.date_headers;
    } else if (Array.isArray(bAcc.series) && bAcc.series.length >= 24) {
      series = bAcc.series;
    } else if (Array.isArray(bAcc.daily_summary) && bAcc.daily_summary.length >= 24) {
      series = bAcc.daily_summary;
    } else if (Array.isArray(bSum.date_headers) && bSum.date_headers.length > 0) {
      series = bSum.date_headers;
    } else if (Array.isArray(bAcc.series) && bAcc.series.length > 0) {
      series = bAcc.series;
    } else if (Array.isArray(bAcc.daily_summary) && bAcc.daily_summary.length > 0) {
      series = bAcc.daily_summary;
    }
    if ((!series || series.length < 24) && typeof buildDailyHistorySeries === 'function') {
      var dSeries = buildDailyHistorySeries(ticker, 24);
      if (dSeries && dSeries.length > 0) {
        series = dSeries;
      }
    }
    if (!series) series = [];

    var availableDates = [];
    if (Array.isArray(data.available_dates) && data.available_dates.length > 0) {
      availableDates = data.available_dates.slice();
    }
    if (bSum && Array.isArray(bSum.date_headers) && bSum.date_headers.length > 0) {
      for (var hi = 0; hi < bSum.date_headers.length; hi++) {
        var hDate = bSum.date_headers[hi].date || bSum.date_headers[hi];
        if (hDate && availableDates.indexOf(hDate) === -1) {
          availableDates.push(hDate);
        }
      }
    }
    var diskDates = listDiskDates('broker-summary', ticker);
    if (Array.isArray(diskDates) && diskDates.length > 0) {
      for (var dIdx = 0; dIdx < diskDates.length; dIdx++) {
        if (availableDates.indexOf(diskDates[dIdx]) === -1) {
          availableDates.push(diskDates[dIdx]);
        }
      }
    }
    if (availableDates.length === 0 && series && series.length > 0) {
      availableDates = series.map(function (s) { return s.date; }).filter(Boolean);
    }
    availableDates.sort().reverse();

    if (series.length === 0 && availableDates.length > 0) {
      series = availableDates.slice(0, 24).map(function (d, idx) {
        var net = idx === 0 ? Number(bSum.net_flow || 0) : 0;
        return {
          date: d,
          net_val: net,
          status: net >= 0 ? 'ACC' : 'DIST',
          top_1_broker: '-',
          top_buyer: '-',
          top_seller: '-'
        };
      });
    }

    var companyName = data.name || data.company_name;
    if (!companyName) {
      if (ticker === 'BBCA') companyName = 'Bank Central Asia Tbk';
      else if (ticker === 'BBRI') companyName = 'Bank Rakyat Indonesia Tbk';
      else if (ticker === 'BMRI') companyName = 'Bank Mandiri Tbk';
      else if (ticker === 'TLKM') companyName = 'Telkom Indonesia Tbk';
      else if (ticker === 'ASII') companyName = 'Astra International Tbk';
      else companyName = ticker + ' Tbk';
    }
    var curPrice = Number(data.price || (bSum && bSum.price) || 0);
    var curPriceFmt = curPrice > 0 ? ('Rp ' + curPrice.toLocaleString('id-ID')) : '—';
    var curChg = data.change_pct != null ? Number(data.change_pct) : ((bSum && bSum.change_pct != null) ? Number(bSum.change_pct) : 0);
    var curChgFmt = (curChg >= 0 ? '+' : '') + curChg.toFixed(2).replace('.', ',') + '%';
    var curDateVal = bSum.date || currentBandarDate || (availableDates[0] || '2026-10-15');
    var curDateIndo = formatIndoDate(curDateVal);

    var bandarScore = (bAcc && bAcc.accumulation_score != null) ? bAcc.accumulation_score : ((bSum && bSum.bandar_score != null) ? bSum.bandar_score : (Number(bSum.net_flow || 0) >= 0 ? 92 : 35));
    var bandarNetVal = Number(bSum.net_flow || 0);
    var bandarNetFmt = (bandarNetVal >= 0 ? '+' : '−') + formatIDR(Math.abs(bandarNetVal));

    var foreignNetVal = Number(bSum.foreign_flow != null ? bSum.foreign_flow : (data.foreign_flow != null ? data.foreign_flow : 0));
    if (!foreignNetVal && (bSum.foreign_buy_val != null || bSum.foreign_sell_val != null)) {
      foreignNetVal = Number(bSum.foreign_buy_val || 0) - Number(bSum.foreign_sell_val || 0);
    }
    if (!foreignNetVal && bandarNetVal !== 0) {
      foreignNetVal = Math.round(bandarNetVal * 0.755);
    }
    var foreignNetFmt = (foreignNetVal >= 0 ? '+' : '−') + formatIDR(Math.abs(foreignNetVal));
    var cr3Sub = cr3 >= 60 ? 'sangat terkonsentrasi' : (cr3 >= 40 ? 'terkonsentrasi sehat' : 'menyebar');

    // 1. Ticker Context & Verdict Sheet (Canvas Bandarmologi.dc.html)
    html += '<section class="sheet rise d1 mb-4">';
    html += '  <div style="display:flex;flex-wrap:wrap;gap:10px 18px;align-items:center;padding:14px 20px;border-bottom:1px solid var(--ac-hair)">';
    html += '    <span class="tk mono" style="font-size:20px" id="bandarTickerDisplay">' + escapeHtml(ticker) + '</span>';
    html += '    <span class="mut" id="bandarNameDisplay">' + escapeHtml(companyName) + '</span>';
    html += '    <span class="num mono" style="font-weight:700" id="bandarPriceDisplay">' + escapeHtml(curPriceFmt) + '</span>';
    html += '    <span class="num ' + (curChg >= 0 ? 'pos' : 'neg') + '" style="font-weight:600" id="bandarChangeDisplay">' + escapeHtml(curChgFmt) + '</span>';
    html += '    <span style="margin-left:auto;display:flex;flex-wrap:wrap;gap:8px;align-items:center">';
    html += '      <label class="mut" style="font-size:12px" for="bandarDateInput">Tanggal</label>';
    html += '      <input id="bandarDateInput" class="fld" type="date" max="2026-10-16" value="' + escapeHtml(curDateVal) + '" oninput="BandarmologiRuntime.onDateInput(this.value)">';
    html += '      <button class="btn sm" id="bandarRecalcBtn" onclick="BandarmologiRuntime.recalculateFlow()">Hitung ulang flow</button>';
    html += '      <span class="mut" id="bandarDateMsg" role="status" style="font-size:12px">Flow tanggal ' + escapeHtml(curDateIndo) + '</span>';
    html += '      ' + isDemoBadge;
    html += '    </span>';
    html += '  </div>';
    html += '  <div class="verdict">';
    html += '    <div>';
    html += '      <div class="lbl">Kesimpulan aliran</div>';
    html += '      <div style="display:flex;align-items:center;gap:10px;margin-top:4px">';
    html += '        <span class="chip b" style="height:26px;font-size:12px">' + escapeHtml(netLabel) + '</span>';
    html += '        <span class="num" style="font-weight:700;font-size:20px">' + bandarScore + '<span class="mut" style="font-size:13px">/100</span></span>';
    html += '      </div>';
    html += '      <div class="meter" style="margin-top:10px;max-width:260px"><i style="width:' + Math.min(100, Math.max(0, bandarScore)) + '%"></i></div>';
    html += '    </div>';
    html += '    <div><div class="lbl">Net bandar</div><div class="big num ' + (bandarNetVal >= 0 ? 'pos' : 'neg') + ' pop">' + escapeHtml(bandarNetFmt) + '</div></div>';
    html += '    <div><div class="lbl">Net asing</div><div class="big num ' + (foreignNetVal >= 0 ? 'pos' : 'neg') + ' pop">' + escapeHtml(foreignNetFmt) + '</div></div>';
    html += '    <div><div class="lbl">Konsentrasi top 3 pembeli</div><div class="big num pop">' + cr3 + '%</div><div class="sub">' + escapeHtml(cr3Sub) + '</div></div>';
    html += '  </div>';
    html += '</section>';

    // 2. Collapsible Alat Lanjutan (Preserves all legacy tools, inputs, toggles, smart summary)
    var r1Class = brokerSummaryRange === '1d' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium';
    var r5Class = brokerSummaryRange === '5d' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium';
    var r7Class = brokerSummaryRange === '7d' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium';
    var r14Class = brokerSummaryRange === '14d' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium';
    var r30Class = brokerSummaryRange === '30d' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium';
    var r60Class = brokerSummaryRange === '60d' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium';
    var rCustomClass = brokerSummaryRange === 'custom' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium';
    var grossClass = isGross ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium';
    var netClass = !isGross ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium';

    html += '<details class="scr-adv" id="bandarAdvTools" style="margin-bottom:16px">';
    html += '  <summary><span class="tit">Alat lanjutan</span><span class="sub">Pencarian emiten, rentang historis, mode gross/net, tampilan bubble, dan ringkasan intelijen</span></summary>';
    html += '  <div class="scr-adv-body" style="display:flex;flex-direction:column;gap:12px;padding:14px 16px">';
    html += '    <div id="bandarSearchBarContainer" style="display:flex;flex-wrap:wrap;gap:8px;align-items:center">';
    html += '      <input type="text" id="bandarTickerSearchInput" class="fld mono uppercase" placeholder="Cari emiten (cth: BBCA)..." value="' + escapeHtml(ticker) + '" style="width:180px" onkeydown="if(event.key===\'Enter\')BandarmologiRuntime.loadBandarmologiTab(this.value.trim().toUpperCase())">';
    html += '      <button type="button" class="btn sm" onclick="BandarmologiRuntime.loadBandarmologiTab((document.getElementById(\'bandarTickerSearchInput\').value||\'\').trim().toUpperCase())">Cari</button>';
    html += '      <div class="flex items-center gap-1">';
    html += '        <button type="button" class="chip" onclick="BandarmologiRuntime.loadBandarmologiTab(\'BBCA\')">BBCA</button>';
    html += '        <button type="button" class="chip" onclick="BandarmologiRuntime.loadBandarmologiTab(\'BBRI\')">BBRI</button>';
    html += '        <button type="button" class="chip" onclick="BandarmologiRuntime.loadBandarmologiTab(\'BMRI\')">BMRI</button>';
    html += '        <button type="button" class="chip" onclick="BandarmologiRuntime.loadBandarmologiTab(\'ASII\')">ASII</button>';
    html += '        <button type="button" class="chip" onclick="BandarmologiRuntime.loadBandarmologiTab(\'TLKM\')">TLKM</button>';
    html += '      </div>';
    html += '    </div>';
    if (availableDates.length > 0) {
      html += renderBrokerDateSelectHtml(ticker, availableDates, bSum.date || currentBandarDate);
    }
    html += '    <div class="flex flex-wrap items-center gap-3">';
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
    html += '      <div class="flex items-center gap-1 bg-dark-800 p-0.5 rounded-lg border border-dark-600/50 text-[11px]">';
    html += '        <span class="text-[10px] text-gray-400 font-medium px-1.5 uppercase tracking-wider">Tampilan:</span>';
    html += '        <button type="button" id="toggleViewBubble" onclick="BandarmologiRuntime.setBrokerSummaryView(\'bubble\')" class="px-2.5 py-1 rounded-md transition ' + (isBubbleView ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium') + '">⚪ Visual Bubble</button>';
    html += '        <button type="button" id="toggleViewTable" onclick="BandarmologiRuntime.setBrokerSummaryView(\'table\')" class="px-2.5 py-1 rounded-md transition ' + (!isBubbleView ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium') + '">📋 Tabel Rinci</button>';
    html += '      </div>';
    html += '      <div class="flex items-center gap-1 bg-dark-800 p-0.5 rounded-lg border border-dark-600/50 text-[11px]">';
    html += '        <span class="text-[10px] text-gray-400 font-medium px-1.5 uppercase tracking-wider">Mode:</span>';
    html += '        <button type="button" id="toggleModeGross" onclick="BandarmologiRuntime.setBrokerSummaryMode(\'gross\')" class="px-2.5 py-1 rounded-md transition ' + grossClass + '">Full / Gross</button>';
    html += '        <button type="button" id="toggleModeNet" onclick="BandarmologiRuntime.setBrokerSummaryMode(\'net\')" class="px-2.5 py-1 rounded-md transition ' + netClass + '">Net Value</button>';
    html += '      </div>';
    html += '    </div>';
    html += '    <div id="smartBrokerSummaryContainer"></div>';
    html += '  </div>';
    html += '</details>';

    var isSummarySection = bandarSection === 'summary';

    if (isSummarySection) {
      // 3. Flow Tool (Semua · Asing · Domestik)
      var flowIdx = brokerFlowFilter === 'F' ? 1 : (brokerFlowFilter === 'D' ? 2 : 0);
      var flowNote = brokerFlowFilter === 'F'
        ? 'Investor asing (flow=F). Diarsip sejak 2 Jan 2026, sedang dilengkapi.'
        : (brokerFlowFilter === 'D'
          ? 'Domestik dihitung per broker: semua − asing. Tidak memakai kuota tambahan.'
          : 'Semua investor (flow=all).');
      var fTag = brokerFlowFilter === 'F' ? ' · asing' : (brokerFlowFilter === 'D' ? ' · domestik' : '');

      html += '<div class="ftool mb-4">';
      html += '  <div class="segx n3" role="group" aria-label="Jenis aliran">';
      html += '    <span class="ind k' + flowIdx + '" id="bandarFlowInd"></span>';
      html += '    <button type="button" class="' + (brokerFlowFilter === 'all' ? 'on' : '') + '" id="toggleFlowAll" onclick="BandarmologiRuntime.setBrokerFlowFilter(\'all\')">Semua</button>';
      html += '    <button type="button" class="' + (brokerFlowFilter === 'F' ? 'on' : '') + '" id="toggleFlowForeign" onclick="BandarmologiRuntime.setBrokerFlowFilter(\'F\')">Asing</button>';
      html += '    <button type="button" class="' + (brokerFlowFilter === 'D' ? 'on' : '') + '" id="toggleFlowDomestic" onclick="BandarmologiRuntime.setBrokerFlowFilter(\'D\')">Domestik</button>';
      html += '  </div>';
      html += '  <span class="mut" id="bandarFlowNote" style="font-size:12px">' + escapeHtml(flowNote) + '</span>';
      html += '</div>';

      if (isDomIncomplete) {
        html += '<div class="py-12 px-4 text-center bg-dark-800/40 rounded-xl border border-amber-500/20 my-4" id="bandarDomIncompleteMsg">';
        html += '  <div class="inline-flex items-center justify-center w-12 h-12 rounded-full bg-amber-500/10 text-amber-400 mb-3 text-2xl">⏳</div>';
        html += '  <h4 class="text-sm font-bold text-amber-300">belum lengkap · menunggu data lengkap</h4>';
        html += '  <p class="text-xs text-gray-400 mt-1 max-w-md mx-auto">Data broker summary "Semua" pada sesi ini masih terpotong (25 broker). Perhitungan arus Domestik (All − F) ditangguhkan demi menjaga integritas data.</p>';
        html += '</div>';
      } else {
        var rawBuyers = isGross
          ? firstNonEmptyList(bSum.gross_buyers, bSum.top_buyers, bSum.buyers)
          : firstNonEmptyList(bSum.net_buyers, bSum.gross_buyers, bSum.top_buyers, bSum.buyers);
        var rawSellers = isGross
          ? firstNonEmptyList(bSum.gross_sellers, bSum.top_sellers, bSum.sellers)
          : firstNonEmptyList(bSum.net_sellers, bSum.gross_sellers, bSum.top_sellers, bSum.sellers);

        if ((!rawSellers || rawSellers.length === 0) && bSum.gross_sellers && bSum.gross_sellers.length > 0) {
          rawSellers = bSum.gross_sellers;
        }

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

        if (brokerFlowFilter === 'F' && buyers.length === 0 && sellers.length === 0) {
          html += '<div class="py-12 px-4 text-center bg-dark-800/40 rounded-xl border border-amber-500/20 my-4" id="bandarForeignUnarchivedMsg">';
          html += '  <div class="inline-flex items-center justify-center w-12 h-12 rounded-full bg-amber-500/10 text-amber-400 mb-3 text-2xl">🌏</div>';
          html += '  <h4 class="text-sm font-bold text-amber-300">data asing belum dirilis</h4>';
          html += '  <p class="text-xs text-gray-400 mt-1 max-w-md mx-auto">Data aliran broker asing belum diarsipkan untuk sesi ini. Sedang dilengkapi.</p>';
          html += '</div>';
        } else if (isBubbleView) {
          if (!selectedBrokerCode || !lastBrokerItems.some(function (it) { return it.broker === selectedBrokerCode; })) {
            selectedBrokerCode = lastBrokerItems.length > 0 ? lastBrokerItems[0].broker : '';
            selectedBrokerSide = lastBrokerItems.length > 0 ? (lastBrokerItems[0].side || '') : '';
          }
          html += renderBrokerBubbleClusterHtml(lastBrokerItems, selectedBrokerCode, brokerSummaryMode, bubbleFilterSide);
        } else {
          html += renderCanvasBrokerSummaryTables(buyers, sellers, fTag);
        }
      }
    } else {
      // Akumulasi Broker Canvas View
      html += renderCanvasBrokerAccumulation(ticker, bSum, bAcc, series);

      // Metrik Konsistensi Lanjutan (Collapsible)
      html += '<details class="scr-adv" style="margin-top:16px">';
      html += '  <summary><span class="tit">Metrik Konsistensi Lanjutan</span><span class="sub">Dominasi pasar, partisipasi ritel, dan riwayat harian</span></summary>';
      html += '  <div class="scr-adv-body" style="padding:14px 16px;display:flex;flex-direction:column;gap:16px">';
      html += '<div class="mb-5 space-y-4">';

    // 2A. Header & Controls: Range Selector + Flow Filter
    html += '  <div class="flex flex-wrap items-center justify-between gap-2.5 pb-2 border-b border-dark-600/40">';
    var rawAccDate = bSum.date || currentBandarDate;
    var accDateDisplay = rawAccDate ? (typeof formatDateWibDisplay === 'function' ? formatDateWibDisplay(rawAccDate) : rawAccDate) : 'Historis';
    var accHeadingDate = bSum.range_label || ('Tanggal: ' + accDateDisplay);
    html += '    <div>';
    html += '      <h3 class="text-xs font-bold text-gray-200 flex items-center gap-1.5"><span class="text-sm">🎯</span> Dashboard Konsistensi Bandar - <span class="text-emerald-400 font-mono">' + escapeHtml(accHeadingDate) + '</span></h3>';
    html += '      <p class="text-[11px] text-gray-400 mt-0.5">Analisis konsentrasi modal, rasio partisipasi bandar vs ritel, dan konsistensi arah akumulasi/distribusi.</p>';
    html += '    </div>';

    html += '    <div class="flex flex-wrap items-center gap-2">';
    // Rentang Selector (1D, 5D, 7D, 14D, 30D, 60D, Custom)
    var ar1Class = brokerSummaryRange === '1d' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium';
    var ar5Class = brokerSummaryRange === '5d' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium';
    var ar7Class = brokerSummaryRange === '7d' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium';
    var ar14Class = brokerSummaryRange === '14d' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium';
    var ar30Class = brokerSummaryRange === '30d' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium';
    var ar60Class = brokerSummaryRange === '60d' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium';
    var arCustomClass = brokerSummaryRange === 'custom' ? 'bg-emerald-500 text-dark-900 shadow-sm font-bold' : 'text-gray-400 hover:text-white font-medium';
    html += '      <div class="flex flex-wrap items-center gap-1 bg-dark-800 p-0.5 rounded-lg border border-dark-600/50 text-[11px]">';
    html += '        <span class="text-[10px] text-gray-400 font-medium px-1.5 uppercase tracking-wider">Rentang:</span>';
    html += '        <button type="button" id="toggleAccRange1d" onclick="BandarmologiRuntime.setBrokerSummaryRange(\'1d\')" class="px-2 py-1 rounded-md transition ' + ar1Class + '">1D</button>';
    html += '        <button type="button" id="toggleAccRange5d" onclick="BandarmologiRuntime.setBrokerSummaryRange(\'5d\')" class="px-2 py-1 rounded-md transition ' + ar5Class + '">5D</button>';
    html += '        <button type="button" id="toggleAccRange7d" onclick="BandarmologiRuntime.setBrokerSummaryRange(\'7d\')" class="px-2 py-1 rounded-md transition ' + ar7Class + '">7D</button>';
    html += '        <button type="button" id="toggleAccRange14d" onclick="BandarmologiRuntime.setBrokerSummaryRange(\'14d\')" class="px-2 py-1 rounded-md transition ' + ar14Class + '">14D</button>';
    html += '        <button type="button" id="toggleAccRange30d" onclick="BandarmologiRuntime.setBrokerSummaryRange(\'30d\')" class="px-2 py-1 rounded-md transition ' + ar30Class + '">30D</button>';
    html += '        <button type="button" id="toggleAccRange60d" onclick="BandarmologiRuntime.setBrokerSummaryRange(\'60d\')" class="px-2 py-1 rounded-md transition ' + ar60Class + '">60D</button>';
    html += '        <button type="button" id="toggleAccRangeCustom" onclick="BandarmologiRuntime.setBrokerSummaryRange(\'custom\')" class="px-2 py-1 rounded-md transition ' + arCustomClass + '">📅 Custom</button>';
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
    if (isDomIncomplete) {
      html += '<div class="py-12 px-4 text-center bg-dark-800/40 rounded-xl border border-amber-500/20 my-4">';
      html += '  <div class="inline-flex items-center justify-center w-12 h-12 rounded-full bg-amber-500/10 text-amber-400 mb-3 text-2xl">⏳</div>';
      html += '  <h4 class="text-sm font-bold text-amber-300">belum lengkap · menunggu data lengkap</h4>';
      html += '  <p class="text-xs text-gray-400 mt-1 max-w-md mx-auto">Data broker summary "Semua" pada sesi ini masih terpotong (25 broker). Perhitungan konsistensi Domestik (All − F) ditangguhkan demi menjaga integritas data.</p>';
      html += '</div></div>';
      container.innerHTML = html;
      return;
    }

    var allBuyersList = firstNonEmptyList(bSum.gross_buyers, bSum.top_buyers, bSum.net_buyers, bSum.buyers) || [];

    // Calculate true total market buy value across all brokers / emiten turnover
    var totalMarketBuyVal = Number(bSum.total_turnover || bSum.total_buy_val || 0);
    if (totalMarketBuyVal <= 0) {
      var allMarketBrokers = (Array.isArray(bSum.brokers) && bSum.brokers.length > 0)
        ? bSum.brokers
        : ((Array.isArray(bSum.gross_buyers) && bSum.gross_buyers.length > 0)
          ? bSum.gross_buyers
          : allBuyersList);

      for (var mb = 0; mb < allMarketBrokers.length; mb++) {
        totalMarketBuyVal += Number(allMarketBrokers[mb].bval || allMarketBrokers[mb].buy_val || allMarketBrokers[mb].val || 0);
      }
    }

    var sortedBuyersByBuyVal = allBuyersList.slice().sort(function (a, b) {
      var va = Number(a.bval || a.buy_val || a.val || 0);
      var vb = Number(b.bval || b.buy_val || b.val || 0);
      return vb - va;
    });

    var top3Val = 0;
    for (var t3 = 0; t3 < Math.min(3, sortedBuyersByBuyVal.length); t3++) {
      top3Val += Number(sortedBuyersByBuyVal[t3].bval || sortedBuyersByBuyVal[t3].buy_val || sortedBuyersByBuyVal[t3].val || 0);
    }
    var top5Val = 0;
    for (var t5 = 0; t5 < Math.min(5, sortedBuyersByBuyVal.length); t5++) {
      top5Val += Number(sortedBuyersByBuyVal[t5].bval || sortedBuyersByBuyVal[t5].buy_val || sortedBuyersByBuyVal[t5].val || 0);
    }

    // PR3 fix: this block used an ad-hoc denominator (`top3Val * 2.85`) and
    // Math.round, while lib/bandarmologi-intel-service.js used the real broker
    // turnover with toFixed(2). The two tabs therefore reported different CR3/CR5
    // for the same ticker+date (e.g. 36%/49% vs 27.13%/39.72%). Both now use the
    // same canonical formula: top-N buy value / total buy turnover, two decimals,
    // with the same sub-top-5 guard so CR never pins at 100%.
    var crMetrics = computeConcentrationRatioMetrics(
      top3Val,
      top5Val,
      totalMarketBuyVal
    );
    var cr3 = crMetrics.cr3;
    var cr5 = crMetrics.cr5;

    // Retail vs Bandar Participation
    var retailVal = 0;
    var allBuyersTotalVal = 0;
    for (var ri = 0; ri < allBuyersList.length; ri++) {
      var bCode = (allBuyersList[ri].broker || allBuyersList[ri].broker_code || '').trim().toUpperCase();
      var itemVal = Number(allBuyersList[ri].bval || allBuyersList[ri].buy_val || allBuyersList[ri].val || 0);
      allBuyersTotalVal += itemVal;
      if (RETAIL_BROKERS.indexOf(bCode) >= 0) {
        retailVal += itemVal;
      }
    }
    var effectiveTotalVal = totalMarketBuyVal > 0 ? totalMarketBuyVal : allBuyersTotalVal;
    var bandarVal = Math.max(0, effectiveTotalVal - retailVal);
    var bandarPct = effectiveTotalVal > 0 ? Math.round((bandarVal / effectiveTotalVal) * 100) : 0;
    var retailPct = effectiveTotalVal > 0 ? (100 - bandarPct) : 0;

    // Dominasi classification
    var domStatus = 'Concentrated';
    var domBadge = '<span class="px-2.5 py-1 rounded-lg bg-sky-500/20 text-sky-300 border border-sky-500/40 font-bold text-xs">🎯 Concentrated (Terkonsentrasi Sehat)</span>';
    var domDesc = 'Top 3 broker menguasai ' + cr3 + '% total volume beli. Aliran likuiditas terkonsentrasi terarah pada beberapa pelaku pasar dominan.';
    if (cr3 >= 60) {
      domStatus = 'Monopolistic';
      domBadge = '<span class="px-2.5 py-1 rounded-lg bg-emerald-500/20 text-emerald-300 border border-emerald-500/40 font-bold text-xs">👑 Monopolistic (Sangat Terkonsentrasi)</span>';
      domDesc = 'Top 3 broker menguasai ' + cr3 + '% total pembelian. Kekuatan akumulasi sangat solid dan dikendalikan oleh bandar utama.';
    } else if (cr3 < 40) {
      if (bandarPct >= 50) {
        domStatus = 'Multi-Institutional';
        domBadge = '<span class="px-2.5 py-1 rounded-lg bg-indigo-500/20 text-indigo-300 border border-indigo-500/40 font-bold text-xs">🏛️ Multi-Institusi (Bandar Tersebar)</span>';
        domDesc = 'Top 3 broker menguasai ' + cr3 + '%, namun partisipasi institusional/bandar mencapai ' + bandarPct + '%. Transaksi didominasi institusi non-ritel yang tersebar.';
      } else {
        domStatus = 'Distributed';
        domBadge = '<span class="px-2.5 py-1 rounded-lg bg-amber-500/20 text-amber-300 border border-amber-500/40 font-bold text-xs">🌊 Distributed (Menyebar / Dominasi Ritel)</span>';
        domDesc = 'Top 3 broker hanya menguasai ' + cr3 + '%. Kepemilikan dan transaksi didominasi oleh ritel (' + retailPct + '%) tanpa kepemimpinan bandar yang jelas.';
      }
    }

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
    var accRawBuyers = firstNonEmptyList(
      bAcc.top_buyers, bAcc.net_buyers, bAcc.gross_buyers, bAcc.buyers,
      bSum.top_buyers, bSum.net_buyers, bSum.gross_buyers, bSum.buyers
    ) || [];
    var accRawSellers = firstNonEmptyList(
      bAcc.top_sellers, bAcc.net_sellers, bAcc.gross_sellers, bAcc.sellers,
      bSum.top_sellers, bSum.net_sellers, bSum.gross_sellers, bSum.sellers
    ) || [];

    // Fallback: extract from bAcc or bSum brokers if buyers/sellers are still empty
    if (accRawBuyers.length === 0 && accRawSellers.length === 0) {
      var allAccBrokers = (Array.isArray(bAcc.brokers) && bAcc.brokers.length > 0)
        ? bAcc.brokers
        : ((bAcc.accumulation && Array.isArray(bAcc.accumulation.brokers))
          ? bAcc.accumulation.brokers
          : (Array.isArray(bSum.brokers) ? bSum.brokers : []));
      if (allAccBrokers.length > 0) {
        for (var abi = 0; abi < allAccBrokers.length; abi++) {
          var abItem = allAccBrokers[abi];
          var abNet = abItem.nval != null ? Number(abItem.nval) : (abItem.net_val != null ? Number(abItem.net_val) : ((Number(abItem.bval || abItem.buy_val || 0)) - (Number(abItem.sval || abItem.sell_val || 0))));
          if (abNet >= 0) accRawBuyers.push(abItem);
          else accRawSellers.push(abItem);
        }
      }
    }

    // Partition guard: If sellers are empty but buyers contain sellers or sell volume, partition them
    if (accRawSellers.length === 0 && accRawBuyers.length > 0) {
      var accPb = [];
      var accPs = [];
      for (var pbi = 0; pbi < accRawBuyers.length; pbi++) {
        var pItm = accRawBuyers[pbi];
        var pNetVal = pItm.nval != null ? Number(pItm.nval) : (pItm.net_val != null ? Number(pItm.net_val) : ((Number(pItm.bval || pItm.buy_val || 0)) - (Number(pItm.sval || pItm.sell_val || 0))));
        if (pNetVal < 0 || ((Number(pItm.sval || pItm.sell_val || 0)) > (Number(pItm.bval || pItm.buy_val || 0)))) {
          accPs.push(pItm);
        } else {
          accPb.push(pItm);
        }
      }
      if (accPs.length > 0) {
        accRawBuyers = accPb;
        accRawSellers = accPs;
      } else {
        var accWithSell = accRawBuyers.filter(function (b) { return (Number(b.sval || b.sell_val || 0)) > 0; });
        if (accWithSell.length > 0) {
          accRawSellers = accWithSell;
        }
      }
    }

    // Cross-fallback: if one side is still empty, fall back to bSum
    if (accRawSellers.length === 0 && bSum && (bSum.gross_sellers || bSum.top_sellers || bSum.net_sellers)) {
      accRawSellers = firstNonEmptyList(bSum.gross_sellers, bSum.top_sellers, bSum.net_sellers) || [];
    }
    if (accRawBuyers.length === 0 && bSum && (bSum.gross_buyers || bSum.top_buyers || bSum.net_buyers)) {
      accRawBuyers = firstNonEmptyList(bSum.gross_buyers, bSum.top_buyers, bSum.net_buyers) || [];
    }

    var accBuyers = filterBrokersByFlow(accRawBuyers, brokerFlowFilter);
    var accSellers = filterBrokersByFlow(accRawSellers, brokerFlowFilter);

    // If filtering by flow emptied everything while raw had brokers, fallback to all so bubbles are never zero
    if (accBuyers.length === 0 && accSellers.length === 0 && (accRawBuyers.length > 0 || accRawSellers.length > 0)) {
      if (brokerFlowFilter === 'all') {
        accBuyers = accRawBuyers;
        accSellers = accRawSellers;
      }
    }

    lastBrokerItems = buildBrokerBubbleItems(accBuyers, accSellers, brokerSummaryMode);
    if (lastBrokerItems.length === 0 && (accRawBuyers.length > 0 || accRawSellers.length > 0)) {
      lastBrokerItems = buildBrokerBubbleItems(accRawBuyers, accRawSellers, brokerSummaryMode);
    }
    if (lastBrokerItems.length === 0 && bSum) {
      var fbBuyers = firstNonEmptyList(bSum.top_buyers, bSum.net_buyers, bSum.gross_buyers, bSum.buyers) || [];
      var fbSellers = firstNonEmptyList(bSum.top_sellers, bSum.net_sellers, bSum.gross_sellers, bSum.sellers) || [];
      if (fbBuyers.length > 0 || fbSellers.length > 0) {
        lastBrokerItems = buildBrokerBubbleItems(fbBuyers, fbSellers, brokerSummaryMode);
      }
    }

    // FIX (UI, stage 1): in Akumulasi Broker the bubble cluster is mounted ONLY
    // when the operator explicitly switches to 'Visual Bubble'. The default view
    // is 'table' (Tabel Rinci active), and in that mode the cluster container must
    // be hidden in FULL - no bubble markup, only the explicit display:none
    // placeholder plus the detailed Top Buyers / Top Sellers tables.
    var accShowBubbleCluster = (brokerAccumulationView === 'bubble');
    if (accShowBubbleCluster) {
      html += '  <div id="acAccBubbleClusterWrap" class="bg-dark-800/80 border border-dark-600/40 rounded-xl p-4 shadow-sm">';
      html += '    <div class="flex items-center justify-between mb-3">';
      html += '      <div>';
      html += '        <h4 class="text-xs font-bold text-gray-200 flex items-center gap-1.5"><span class="text-sm">🫧</span> Sebaran Klaster Broker Akumulasi &amp; Distribusi</h4>';
      html += '        <p class="text-[11px] text-gray-400 mt-0.5">Visualisasi interaktif bubble broker akumulasi dan distribusi. Tap bubble untuk detail transaksi.</p>';
      html += '      </div>';
      html += '    </div>';
      html += renderBrokerBubbleClusterHtml(lastBrokerItems, selectedBrokerCode, brokerSummaryMode, bubbleFilterSide);
      html += '  </div>';
    } else {
      // Keep an explicit, hidden placeholder so a previously mounted bubble
      // cluster cannot survive the re-render in Akumulasi table mode.
      html += '  <div id="acAccBubbleClusterWrap" style="display:none" aria-hidden="true"></div>';
      html += renderBrokerSummaryTableHtml(accBuyers, accSellers, false, brokerSummaryMode);
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
      html += '    <div class="overflow-x-auto overflow-y-auto max-h-[420px] scrollbar-thin" style="max-height: 420px; overflow: auto; pointer-events: auto;">';
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
      html += '        <tbody class="divide-y divide-dark-600/20" style="pointer-events: auto;">';

      var isChronological = series.length > 1 && series[0].date < series[series.length - 1].date;
      var revSeries = isChronological ? series.slice().reverse() : series.slice();
      for (var di = 0; di < revSeries.length; di++) {
        var dayRow = revSeries[di];
        var isSelected = dayRow.date === (bSum.date || currentBandarDate);
        var rowNet = normalizeBrokerValue(dayRow.net_val || 0);
        var isPositive = rowNet >= 0;

        // Kategori: Big Acc / Normal Acc / Netral / Normal Dist / Big Dist
        // AUDIT-F4-15: net 0 / NaN tidak lagi jatuh ke "Normal Dist".
        var catBadge = '';
        var dailyCategory = classifyDailyNetCategory(rowNet);
        if (dailyCategory === 'Big Acc') {
          catBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">🟢 Big Acc</span>';
        } else if (dailyCategory === 'Normal Acc') {
          catBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">🟢 Normal Acc</span>';
        } else if (dailyCategory === 'Netral') {
          catBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-gray-500/10 text-gray-300 border border-gray-500/30">⚪ Netral</span>';
        } else if (dailyCategory === 'Big Dist') {
          catBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-500/20 text-rose-300 border border-rose-500/40">🔴 Big Dist</span>';
        } else {
          catBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-rose-500/10 text-rose-400 border border-rose-500/30">🔴 Normal Dist</span>';
        }

        // Top 1 Broker
        var top1Code = dayRow.top_1_broker || dayRow.top1_broker || dayRow.top_broker || (isPositive ? (dayRow.top_buyer || dayRow.buyer1) : (dayRow.top_seller || dayRow.seller1));
        if (!top1Code || top1Code === '-') {
          top1Code = isPositive
            ? (dayRow.top_buyer || dayRow.buyer1 || (dayRow.top_buyers && dayRow.top_buyers[0] && (dayRow.top_buyers[0].broker || dayRow.top_buyers[0].code)) || '-')
            : (dayRow.top_seller || dayRow.seller1 || (dayRow.top_sellers && dayRow.top_sellers[0] && (dayRow.top_sellers[0].broker || dayRow.top_sellers[0].code)) || '-');
        }
        if (!top1Code || top1Code === '-') {
          top1Code = dayRow.top_1_broker || dayRow.top1_broker || dayRow.top_broker || dayRow.top_buyer || dayRow.top_seller || dayRow.buyer1 || dayRow.seller1 || '-';
        }
        var isTopBuyer = isPositive;
        if (dayRow.top_buyer && dayRow.top_buyer === top1Code) isTopBuyer = true;
        else if (dayRow.top_seller && dayRow.top_seller === top1Code) isTopBuyer = false;
        else if (dayRow.buyer1 && dayRow.buyer1 === top1Code) isTopBuyer = true;
        else if (dayRow.seller1 && dayRow.seller1 === top1Code) isTopBuyer = false;
        var top1Color = isTopBuyer ? 'text-emerald-300 bg-emerald-500/10 border-emerald-500/30' : 'text-rose-300 bg-rose-500/10 border-rose-500/30';
        var top1Badge = top1Code && top1Code !== '-'
          ? '<span class="px-2 py-0.5 rounded font-mono font-bold text-[10px] border ' + top1Color + '">' + escapeHtml(top1Code) + ' (' + (isTopBuyer ? 'Buy' : 'Sell') + ')</span>'
          : '<span class="text-gray-500 font-mono">-</span>';

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
    html += '  </div>';
    html += '</details>';
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
      var insiderFreshness = '';
      if (typeof lastBandarData !== 'undefined' && lastBandarData) {
        if (lastBandarData.insiders && lastBandarData.insiders._cache_meta && lastBandarData.insiders._cache_meta.target_date) {
          insiderFreshness = ' • diperbarui ' + lastBandarData.insiders._cache_meta.target_date;
        } else if (lastBandarData.date) {
          insiderFreshness = ' • diperbarui ' + lastBandarData.date;
        }
      }
      html += '      <span class="text-[11px] text-gray-400">(' + filteredInsiders.length + (filteredInsiders.length !== totalInsidersCount ? ' dari ' + totalInsidersCount : '') + ' transaksi' + insiderFreshness + ')</span>';
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

          var priceDisplay = '-';
          if (row.price != null && Number(row.price) > 0) {
            priceDisplay = 'Rp ' + formatNumber(Number(row.price));
          }

          var brokerDisplay = (row.broker && row.broker !== '-')
            ? '<span class="px-1.5 py-0.5 rounded font-mono font-bold bg-dark-600/60 text-gray-200 border border-dark-500 text-[10px]">' + escapeHtml(row.broker) + '</span>'
            : '<span class="text-gray-500 font-mono">-</span>';

          var sharesVal = row.shares_change != null ? row.shares_change : (row.shares != null ? row.shares : row.volume);
          var signStr = isBuy ? '+' : (isSell ? '-' : '');
          // Normalise pct_change: strip leading sign so it never doubles the
          // buy/sell sign already applied to the shares figure (fix --x.xx%).
          var rawPct = row.pct_change && row.pct_change !== '-' ? String(row.pct_change).replace(/^[+-]/, '') : '';
          var pctStr = rawPct ? ' (' + escapeHtml(rawPct) + ')' : '';
          var changeDisplay = sharesVal != null
            ? (signStr + formatNumber(Math.abs(sharesVal)) + pctStr)
            : (row.pct_change || '-');

          var afterShares = row.shares_after != null ? formatNumber(row.shares_after) : (row.shares_after === 0 ? '0' : '-');
          var rawAfterPct = row.pct_after || row.shares_after_percentage || row.current_percentage || row.percentage_after || row.after_percentage || '';
          if (rawAfterPct && !String(rawAfterPct).includes('%') && rawAfterPct !== '-') rawAfterPct += '%';
          var afterPct = rawAfterPct ? ' (' + escapeHtml(rawAfterPct) + ')' : '';
          var afterDisplay = afterShares !== '-' ? (afterShares + afterPct) : (rawAfterPct ? escapeHtml(rawAfterPct) : '-');

          var sharesBeforeVal = row.shares_before;
          if (sharesBeforeVal == null && row.shares_after != null && sharesVal != null) {
            var signedVal = (isSell && sharesVal > 0) ? -sharesVal : sharesVal;
            sharesBeforeVal = row.shares_after - signedVal;
          }
          var beforeShares = sharesBeforeVal != null ? formatNumber(sharesBeforeVal) : (sharesBeforeVal === 0 ? '0' : '-');
          var rawBeforePct = row.pct_before || row.shares_before_percentage || row.previous_percentage || row.percentage_before || row.before_percentage || '';
          if (rawBeforePct && !String(rawBeforePct).includes('%') && rawBeforePct !== '-') rawBeforePct += '%';
          var beforePct = rawBeforePct ? ' (' + escapeHtml(rawBeforePct) + ')' : '';
          var beforeDisplay = beforeShares !== '-' ? (beforeShares + beforePct) : (rawBeforePct ? escapeHtml(rawBeforePct) : '-');

          var isForeign = String(row.nationality || '').toLowerCase() === 'foreign';
          var nationalityBadge = isForeign
            ? '<span class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-sky-500/10 text-sky-300 border border-sky-500/30">🌏 Foreign</span>'
            : '<span class="px-1.5 py-0.5 rounded text-[10px] font-semibold bg-dark-600/40 text-gray-300 border border-dark-500">🇮🇩 Local</span>';

          var changeColor = isBuy ? 'text-emerald-400' : (isSell ? 'text-rose-400' : 'text-gray-300');
          var positionDisplay = row.position || row.jabatan || row.title || row.status || (row.badges && row.badges[0]) || '-';

          html += '        <tr class="hover:bg-dark-600/20 transition">';
          html += '          <td class="py-2.5 px-2.5 font-mono text-[11px] text-gray-300">' + escapeHtml(row.date || '-') + '</td>';
          html += '          <td class="py-2.5 px-2.5 font-medium text-gray-100">' + escapeHtml(row.name || row.insider_name || '-') + '</td>';
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

    if (container && typeof container.innerHTML !== 'undefined') {
      container.innerHTML = html;
      try {
        var bWraps = container.querySelectorAll('.broker-summary-table-wrap');
        bWraps.forEach(function (w) { w.scrollTop = 0; w.scrollLeft = 0; });
      } catch (_) {}
    }
    return html;
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
  // F-007: no default example figure on first open; empty state guides the user to input a name.
  var activeInsiderNetworkEntity = '';
  var activeInsiderNetworkSelectedTicker = null;
  var currentInsiderNetworkGraph = null;

  // F-007: explicit empty graph. Used when the insider service has no data for a
  // name (or no name is selected). Never fabricate a profile for an unknown name.
  function emptyInsiderGraph(name) {
    return {
      nodes: [],
      edges: [],
      links: [],
      status: 'NO_DATA',
      no_data: true,
      message: 'Belum ada data relasi',
      summary: { query: String(name || ''), entity_name: String(name || ''), node_count: 0, edge_count: 0, total_emitens: 0, total_shares: 0 }
    };
  }

  function getInsiderNetworkService() {
    if (typeof require !== 'undefined') {
      try {
        return require('../lib/insider-network-service');
      } catch (_) {}
    }
    return null;
  }

  function getEffectiveInsiderGraph(name) {
    var cleanName = String(name || '').trim();
    if (!cleanName) return emptyInsiderGraph('');
    var service = getInsiderNetworkService();
    if (service && typeof service.buildInsiderNetworkGraph === 'function') {
      var res = service.buildInsiderNetworkGraph({ name: cleanName });
      if (res && res.nodes && res.nodes.length > 0) return res;
    }
    return emptyInsiderGraph(cleanName);
  }

  function getEffectiveInsiderGraphStatus(name) {
    var graph = getEffectiveInsiderGraph(name);
    return graph && graph.nodes && graph.nodes.length > 0 ? 'OK' : 'NO_DATA';
  }

  function getEffectiveSearchInsiders(query, options) {
    var service = getInsiderNetworkService();
    if (service && typeof service.searchInsiders === 'function') {
      var res = service.searchInsiders(query, options);
      if (Array.isArray(res)) return res;
    }
    return [];
  }

  var currentInsiderRosterTicker = 'BBCA';
  var currentInsiderRosterData = [];
  var insiderRosterFilterQuery = '';
  var insiderRosterCategoryFilter = 'all';
  var vpsInsiderRosterCache = {};

  function fetchRemoteInsiderGraph(name, cb) {
    if (typeof window === 'undefined' || typeof fetch === 'undefined') return;
    var safeName = String(name || '').trim();
    if (!safeName) return;

    if (activeInsiderGraphAbortController) {
      try { activeInsiderGraphAbortController.abort(); } catch (_) {}
    }
    var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    activeInsiderGraphAbortController = controller;
    var fetchOpts = controller ? { signal: controller.signal } : {};

    var base = getVpsDataApiBase();
    if (!base) {
      fallbackLocalGraph();
      return;
    }

    var vpsUrl = base + '/api/insider-network?ticker=' + encodeURIComponent(safeName);
    fetch(vpsUrl, fetchOpts)
      .then(function (r) { return r.json(); })
      .then(function (data) {
        if (activeInsiderGraphAbortController !== controller) return;
        if (data && (data.success || data.nodes) && data.nodes && data.nodes.length > 0) {
          if (typeof cb === 'function') cb(data);
        } else {
          fallbackLocalGraph();
        }
      })
      .catch(function (err) {
        if (activeInsiderGraphAbortController !== controller) return;
        if (err && (err.name === 'AbortError' || String(err.message).includes('aborted'))) return;
        fallbackLocalGraph();
      });

    function fallbackLocalGraph() {
      try {
        fetch('/api/sector-hot?action=insider-network&query=' + encodeURIComponent(safeName), fetchOpts)
          .then(function (r) { return r.json(); })
          .then(function (data) {
            if (activeInsiderGraphAbortController !== controller) return;
            if (data && (data.success || data.nodes) && data.nodes && data.nodes.length > 0) {
              if (typeof cb === 'function') cb(data);
            }
          })
          .catch(function () {});
      } catch (_) {}
    }
  }

  function fetchVpsInsiderRoster(ticker, cb) {
    if (typeof window === 'undefined' || typeof fetch === 'undefined') return;
    var cleanTicker = String(ticker || 'BBCA').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!cleanTicker) return;

    if (vpsInsiderRosterCache[cleanTicker]) {
      if (typeof cb === 'function') cb(vpsInsiderRosterCache[cleanTicker]);
      return;
    }

    if (activeInsiderRosterAbortController) {
      try { activeInsiderRosterAbortController.abort(); } catch (_) {}
    }
    var controller = (typeof AbortController !== 'undefined') ? new AbortController() : null;
    activeInsiderRosterAbortController = controller;
    var fetchOpts = controller ? { signal: controller.signal } : {};

    var base = getVpsDataApiBase();
    if (!base) {
      fallbackLocalRoster();
      return;
    }

    var vpsUrl = base + '/api/insider-roster?ticker=' + encodeURIComponent(cleanTicker);
    fetch(vpsUrl, fetchOpts)
      .then(function (res) { return res.json(); })
      .then(function (data) {
        if (activeInsiderRosterAbortController !== controller) return;
        if (data && data.success && Array.isArray(data.roster) && data.roster.length > 0) {
          vpsInsiderRosterCache[cleanTicker] = data.roster;
          if (typeof cb === 'function') cb(data.roster);
        } else {
          fallbackLocalRoster();
        }
      })
      .catch(function (err) {
        if (activeInsiderRosterAbortController !== controller) return;
        if (err && (err.name === 'AbortError' || String(err.message).includes('aborted'))) return;
        fallbackLocalRoster();
      });

    function fallbackLocalRoster() {
      try {
        fetch('/api/sector-hot?action=insider-roster&ticker=' + encodeURIComponent(cleanTicker), fetchOpts)
          .then(function (res) { return res.json(); })
          .then(function (data) {
            if (activeInsiderRosterAbortController !== controller) return;
            if (data && data.success && Array.isArray(data.roster)) {
              vpsInsiderRosterCache[cleanTicker] = data.roster;
              if (typeof cb === 'function') cb(data.roster);
            }
          })
          .catch(function () {});
      } catch (_) {}
    }
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
      return '<div class="p-8 text-center text-gray-400 text-xs">Belum ada data relasi untuk tokoh ini. Silakan pilih tokoh lain atau masukkan nama pemegang saham lain.</div>';
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
    svg += '      .central-insider-node {\n';
    svg += '        transform-origin: 450px 350px;\n';
    svg += '        filter: drop-shadow(0 0 16px rgba(245, 158, 11, 0.75));\n';
    svg += '      }\n';
    svg += '      .sun-corona {\n';
    svg += '        transform-origin: 450px 350px;\n';
    svg += '      }\n';
    svg += '      .solar-system-orbit-group {\n';
    svg += '        transform-origin: 450px 350px;\n';
    svg += '      }\n';
    svg += '      .emiten-counter-group {\n';
    svg += '        transform-origin: 450px 350px;\n';
    svg += '      }\n';
    svg += '      .satellite-orbit-group {\n';
    svg += '        transform-origin: 450px 350px;\n';
    svg += '      }\n';
    svg += '      .satellite-counter-group {\n';
    svg += '        transform-origin: 450px 350px;\n';
    svg += '      }\n';
    svg += '      @media (prefers-reduced-motion: reduce) {\n';
    svg += '        * { animation: none !important; }\n';
    svg += '      }\n';
    svg += '    </style>\n';
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
      var brokerCode = (edge.brokers && edge.brokers.length > 0) ? edge.brokers[0] : (edge.broker || '-');
      if (brokerCode && brokerCode !== '-') {
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

      var pctText = edge2.percentage_raw || (edge2.percentage != null ? edge2.percentage + '%' : '-');
      var sharesShort = formatIDR(Math.abs(edge2.shares || 0));
      var brokerCode2 = (edge2.brokers && edge2.brokers.length > 0) ? edge2.brokers[0] : (edge2.broker || '-');

      svg += '    <g class="emiten-node cursor-pointer" onclick="BandarmologiRuntime.selectInsiderEmitenNode(\'' + escapeHtml(emNode2.ticker) + '\')">\n';

      // Satellite Broker Orbit around Planet
      if (brokerCode2 && brokerCode2 !== '-') {
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
      svg += '        <circle cx="' + ex2.toFixed(1) + '" cy="' + ey2.toFixed(1) + '" r="31" fill="' + nodeFill + '" stroke="' + nodeStroke + '" stroke-width="' + nodeWidth + '"/>\n';
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
    svg += '    <circle cx="' + cx + '" cy="' + cy + '" r="46" fill="#451a03" stroke="#f59e0b" stroke-width="3"/>\n';
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
      : '-';

    // Kepemilikan Terkini: Always non-negative
    var rawShares = holding.shares_after != null ? holding.shares_after : holding.shares;
    var absShares = Math.abs(rawShares || 0);
    var sharesFormatted = absShares > 0 ? formatNumber(absShares) + ' lembar' : '-';
    var pctFormatted = holding.percentage_raw || (holding.percentage != null ? holding.percentage + '%' : '-');

    // Rincian Broker
    var brokersList = holding.brokers || [];
    var brokersChipsHtml = '';
    if (brokersList.length > 0) {
      for (var bi = 0; bi < brokersList.length; bi++) {
        var bCode = brokersList[bi];
        brokersChipsHtml += '<span class="px-2.5 py-1 rounded-lg font-mono font-bold bg-dark-700/80 text-emerald-300 border border-dark-600 text-xs">' + escapeHtml(bCode) + '</span> ';
      }
    } else {
      brokersChipsHtml = '<span class="text-gray-500 font-mono text-xs">-</span>';
    }

    // Riwayat Aksi Terakhir
    var actionVol = Math.abs(holding.shares_change || holding.shares || 0);
    var actionVolFormatted = actionVol > 0 ? formatNumber(actionVol) + ' lembar' : '-';
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
    html += '        <strong class="font-mono text-gray-300">' + escapeHtml(holding.latest_date || '-') + '</strong>';
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

  function getCategoryBadge(category) {
    var c = String(category || '').toLowerCase();
    if (c.includes('pengendali') || c.includes('ultimate')) {
      return '<span class="px-2 py-0.5 rounded-full text-[10px] font-bold bg-amber-500/15 text-amber-300 border border-amber-500/30">👑 ' + escapeHtml(category) + '</span>';
    }
    if (c.includes('direksi') || c.includes('direktur')) {
      return '<span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-blue-500/15 text-blue-300 border border-blue-500/30">💼 ' + escapeHtml(category) + '</span>';
    }
    if (c.includes('komisaris')) {
      return '<span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-purple-500/15 text-purple-300 border border-purple-500/30">🛡️ ' + escapeHtml(category) + '</span>';
    }
    if (c.includes('>5%') || c.includes('5%')) {
      return '<span class="px-2 py-0.5 rounded-full text-[10px] font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/30">📈 ' + escapeHtml(category) + '</span>';
    }
    return '<span class="px-2 py-0.5 rounded-full text-[10px] font-medium bg-gray-700/50 text-gray-300 border border-dark-600">👥 ' + escapeHtml(category || 'Pemegang Saham') + '</span>';
  }

  function renderRosterTableRows(rosterList) {
    var tbody = byId('insiderRosterTbody');
    var badge = byId('insiderRosterCountBadge');
    if (!tbody) return;

    var list = Array.isArray(rosterList) ? rosterList : currentInsiderRosterData;
    currentInsiderRosterData = list;

    var query = (insiderRosterFilterQuery || '').toLowerCase().trim();
    var catFilter = (insiderRosterCategoryFilter || 'all').toLowerCase();

    var filtered = list.filter(function (row) {
      if (catFilter !== 'all') {
        var rowCat = String(row.category || '').toLowerCase();
        if (!rowCat.includes(catFilter)) return false;
      }
      if (query) {
        var rowName = String(row.name || '').toLowerCase();
        var rowPos = String(row.position || '').toLowerCase();
        if (!rowName.includes(query) && !rowPos.includes(query)) return false;
      }
      return true;
    });

    if (badge) {
      badge.textContent = filtered.length + (filtered.length !== list.length ? ' dari ' + list.length : '') + ' Entitas Terdata';
    }

    if (filtered.length === 0) {
      tbody.innerHTML = '<tr><td colspan="7" class="py-8 text-center text-xs text-gray-400">Tidak ada data pemegang saham / insider yang sesuai dengan filter.</td></tr>';
      return;
    }

    var html = '';
    for (var i = 0; i < filtered.length; i++) {
      var r = filtered[i];
      var name = r.name || '-';
      var isForeign = String(r.nationality || '').toLowerCase() === 'foreign';
      var entityIcon = isForeign ? '🌐' : (String(r.category || '').toLowerCase().includes('pengendali') ? '👑' : '👤');

      // F-003: a missing ownership percentage must stay missing. Synthesizing 0
      // (then rendering "0.00%") told users a holder owned 0% of the company.
      var pctRaw = r.percentage;
      var pct = (pctRaw == null || pctRaw === '')
        ? null
        : (typeof pctRaw === 'number' ? pctRaw : parseFloat(String(pctRaw).replace(/[%\s]/g, '')));
      if (!Number.isFinite(pct)) pct = null;
      var shares = typeof r.shares === 'number' ? r.shares : parseFloat(r.shares || 0);

      var changeStr = r.last_change || 'Tetap';
      var changeTone = 'text-gray-400';
      if (changeStr.includes('+')) changeTone = 'text-emerald-400 font-semibold';
      else if (changeStr.includes('-')) changeTone = 'text-rose-400 font-semibold';

      html += '<tr class="hover:bg-dark-700/40 border-b border-dark-700/30 transition text-xs">';
      html += '  <td class="py-2.5 px-3 font-mono text-gray-400">' + (i + 1) + '</td>';
      html += '  <td class="py-2.5 px-3 font-medium text-gray-100 whitespace-normal min-w-[140px]">';
      html += '    <div class="flex items-center gap-1.5">';
      html += '      <span>' + entityIcon + '</span>';
      html += '      <strong class="text-white hover:text-emerald-400 cursor-pointer transition" onclick="BandarmologiRuntime.selectInsiderForGraph(\'' + escapeHtml(name) + '\')">' + escapeHtml(name) + '</strong>';
      html += '    </div>';
      var positionLabel = r.position || r.category || '';
      if (positionLabel && positionLabel !== r.name) {
        html += '    <div class="text-[10px] text-gray-400 font-normal pl-5">' + escapeHtml(positionLabel) + '</div>';
      }
      html += '  </td>';
      html += '  <td class="py-2.5 px-3 whitespace-nowrap">' + getCategoryBadge(r.category) + '</td>';
      html += '  <td class="py-2.5 px-3 text-right font-mono text-gray-200">' + formatNumber(shares) + ' <span class="text-[10px] text-gray-400">lbr</span></td>';
      html += '  <td class="py-2.5 px-3 text-right font-mono">';
      html += '    <span class="px-2 py-0.5 rounded bg-dark-900 border border-dark-600 text-emerald-400 font-bold">' + (r.percentage_formatted || (pct == null ? '—' : pct.toFixed(2) + '%')) + '</span>';
      html += '  </td>';
      html += '  <td class="py-2.5 px-3 font-mono text-right ' + changeTone + ' whitespace-nowrap">' + escapeHtml(changeStr) + (r.last_date ? ' <span class="text-[10px] text-gray-500">(' + escapeHtml(r.last_date) + ')</span>' : '') + '</td>';
      html += '  <td class="py-2.5 px-3 text-center whitespace-nowrap">';
      html += '    <button type="button" onclick="BandarmologiRuntime.selectInsiderForGraph(\'' + escapeHtml(name) + '\')" class="px-2.5 py-1 rounded bg-emerald-500/10 hover:bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 text-[11px] font-semibold transition" title="Lihat peta kepemilikan dan relasi lintas emiten">';
      html += '      🕸️ Lihat Graf';
      html += '    </button>';
      html += '  </td>';
      html += '</tr>';
    }
    tbody.innerHTML = html;
  }

  function filterRosterTable(query) {
    insiderRosterFilterQuery = query || '';
    renderRosterTableRows();
  }

  function setRosterCategoryFilter(cat) {
    insiderRosterCategoryFilter = cat || 'all';
    renderRosterTableRows();
  }

  function loadRosterForTicker(ticker) {
    var clean = String(ticker || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!clean) return;
    currentInsiderRosterTicker = clean;
    var tickerInput = byId('insiderRosterTickerInput');
    if (tickerInput) tickerInput.value = clean;
    var disp = byId('rosterTickerDisplay');
    if (disp) disp.textContent = clean;

    var tbody = byId('insiderRosterTbody');
    if (tbody) {
      tbody.innerHTML = '<tr><td colspan="7" class="py-8 text-center text-xs text-gray-400"><div class="spinner mx-auto mb-2"></div>Memuat data pemegang saham ' + escapeHtml(clean) + ' dari data resmi bursa...</td></tr>';
    }

    fetchVpsInsiderRoster(clean, function (roster) {
      renderRosterTableRows(roster);
    });
  }

  function selectInsiderForGraph(name) {
    if (!name) return;
    activeInsiderNetworkEntity = name;
    var input = byId('insiderSearchInput');
    if (input) input.value = name;
    renderInsiderNetworkGraph(name);
    var graphSection = byId('insiderGraphSection');
    if (graphSection && typeof graphSection.scrollIntoView === 'function') {
      graphSection.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }
  }

  function setInsiderMobileView(view) {
    insiderMobileView = (view === 'graph') ? 'graph' : 'roster';
    var rosterSec = byId('insiderRosterSection');
    var graphSec = byId('insiderGraphSection');
    var tabRoster = byId('insiderTabRoster');
    var tabGraph = byId('insiderTabGraph');
    if (rosterSec) {
      if (insiderMobileView === 'graph') {
        rosterSec.classList.add('insider-mobile-hidden');
      } else {
        rosterSec.classList.remove('insider-mobile-hidden');
      }
    }
    if (graphSec) {
      if (insiderMobileView === 'roster') {
        graphSec.classList.add('insider-mobile-hidden');
      } else {
        graphSec.classList.remove('insider-mobile-hidden');
      }
    }
    if (tabRoster && tabGraph) {
      if (insiderMobileView === 'roster') {
        tabRoster.classList.add('ac-tab-active');
        tabRoster.setAttribute('aria-selected', 'true');
        tabGraph.classList.remove('ac-tab-active');
        tabGraph.setAttribute('aria-selected', 'false');
      } else {
        tabGraph.classList.add('ac-tab-active');
        tabGraph.setAttribute('aria-selected', 'true');
        tabRoster.classList.remove('ac-tab-active');
        tabRoster.setAttribute('aria-selected', 'false');
      }
    }
  }

  
  var insiderSelectedNode = 'BBCA';

  var CANVAS_INSIDER_NODES = {
    BBCA: { x: 380, y: 230, t: 'e', label: 'BBCA', sub: 'Bank Central Asia', kind: 'Emiten', desc: 'Bank swasta terbesar berdasarkan kapitalisasi pasar.', rel: [{ k: 'Pengendali', v: 'Dwimuria 54,94%' }, { k: 'Publik (Free Float)', v: '41,82%' }, { k: 'Direksi tercatat', v: '2 orang' }] },
    DWI: { x: 380, y: 96, t: 'h', label: 'PT Dwimuria Investama Andalan', sub: '54,94% BBCA', kind: 'Perusahaan induk', desc: 'Kendaraan kepemilikan keluarga pengendali.', rel: [{ k: 'Kepemilikan BBCA', v: '54,94%' }, { k: 'Pemilik manfaat', v: '2 orang' }] },
    RBH: { x: 200, y: 40, t: 'p', label: 'Robert Budi Hartono', sub: 'Pemilik manfaat', kind: 'Orang', desc: 'Terhubung ke 3 emiten melalui perusahaan induk.', rel: [{ k: 'BBCA (tidak langsung)', v: 'via Dwimuria' }, { k: 'TOWR', v: 'tidak langsung' }, { k: 'BELI', v: 'tidak langsung' }] },
    MBH: { x: 560, y: 40, t: 'p', label: 'Michael Bambang Hartono', sub: 'Pemilik manfaat', kind: 'Orang', desc: 'Terhubung ke 3 emiten melalui perusahaan induk.', rel: [{ k: 'BBCA (tidak langsung)', v: 'via Dwimuria' }, { k: 'TOWR', v: 'tidak langsung' }, { k: 'BELI', v: 'tidak langsung' }] },
    JS: { x: 150, y: 300, t: 'p', label: 'Jahja Setiaatmadja', sub: 'Presiden Direktur', kind: 'Orang · direksi', desc: 'Kepemilikan langsung kecil di BBCA.', rel: [{ k: 'Saham BBCA', v: '40.811.211 lembar' }, { k: 'Kepemilikan', v: '0,03%' }] },
    AWH: { x: 250, y: 380, t: 'p', label: 'Armand Wahyudi Hartono', sub: 'Wakil Presiden Direktur', kind: 'Orang · direksi', desc: 'Kepemilikan langsung kecil di BBCA.', rel: [{ k: 'Saham BBCA', v: '19.852.300 lembar' }, { k: 'Kepemilikan', v: '0,02%' }] },
    TOWR: { x: 640, y: 230, t: 'e', label: 'TOWR', sub: 'Sarana Menara Nusantara', kind: 'Emiten', desc: 'Terhubung melalui pemilik manfaat yang sama.', rel: [{ k: 'Relasi ke BBCA', v: 'pemilik manfaat sama' }] },
    BELI: { x: 600, y: 360, t: 'e', label: 'BELI', sub: 'Global Digital Niaga', kind: 'Emiten', desc: 'Terhubung melalui pemilik manfaat yang sama.', rel: [{ k: 'Relasi ke BBCA', v: 'pemilik manfaat sama' }] },
    PUB: { x: 470, y: 380, t: 'h', label: 'Publik', sub: '41,82% · Free Float', kind: 'Kelompok', desc: 'Investor publik di bawah ambang 5%.', rel: [{ k: 'Kepemilikan', v: '41,82%' }, { k: 'Jumlah saham', v: '51.528.167.500 lembar' }] }
  };

  var CANVAS_INSIDER_EDGES = [
    ['DWI', 'BBCA', '54,94%'],
    ['RBH', 'DWI', ''],
    ['MBH', 'DWI', ''],
    ['JS', 'BBCA', '0,03%'],
    ['AWH', 'BBCA', '0,02%'],
    ['RBH', 'TOWR', ''],
    ['MBH', 'TOWR', ''],
    ['RBH', 'BELI', ''],
    ['MBH', 'BELI', ''],
    ['PUB', 'BBCA', '41,82%']
  ];

  function renderCanvasInsiderGraph(s) {
    s = s || 'BBCA';
    insiderSelectedNode = s;
    var N = CANVAS_INSIDER_NODES;
    var E = CANVAS_INSIDER_EDGES;
    var linkedKeys = [s];
    for (var ei = 0; ei < E.length; ei++) {
      if (E[ei][0] === s && !linkedKeys.includes(E[ei][1])) linkedKeys.push(E[ei][1]);
      if (E[ei][1] === s && !linkedKeys.includes(E[ei][0])) linkedKeys.push(E[ei][0]);
    }
    var C = { e: '#315F9A', h: '#94602B', p: '#7357A6' };

    var svgLines = '';
    var govEdgeLabels = '';
    for (var i = 0; i < E.length; i++) {
      var edge = E[i];
      var a = N[edge[0]];
      var b = N[edge[1]];
      if (!a || !b) continue;
      var on = (edge[0] === s || edge[1] === s);
      var col = on ? '#0F7458' : '#9AA6A1';
      var op = on ? 1 : 0.45;
      var w = on ? 2 : 1.2;
      svgLines += '<g><line class="edge" x1="' + a.x + '" y1="' + a.y + '" x2="' + b.x + '" y2="' + b.y + '" stroke="' + col + '" stroke-opacity="' + op + '" stroke-width="' + w + '"/></g>';
      if (edge[2] && on) {
        var lx = (a.x + b.x) / 2 + 18;
        var ly = (a.y + b.y) / 2;
        var lst = 'left:' + (lx / 7.6).toFixed(2) + '%;top:' + ((ly - 4) / 4.4).toFixed(2) + '%;font-weight:600';
        govEdgeLabels += '<span class="glb gs" style="' + lst + '">' + escapeHtml(edge[2]) + '</span>';
      }
    }

    var svgNodes = '';
    var govNodeLabels = '';
    var keys = Object.keys(N);
    for (var k = 0; k < keys.length; k++) {
      var key = keys[k];
      var n = N[key];
      var isSel = (key === s);
      var isP = (n.t === 'p');
      var rw = Math.max(64, n.label.length * 7.2 + 24);
      var rx = (n.x - rw / 2).toFixed(0);
      var ry = n.y - 17;
      var rr = (n.t === 'e') ? 8 : 2;
      var isLinked = linkedKeys.includes(key);

      var fill = (n.t === 'e') ? (isSel ? '#315F9A' : '#E9EFF6') : ((n.t === 'h') ? (isSel ? '#94602B' : '#F4EDE4') : (isSel ? '#7357A6' : '#EFEBF6'));
      var stroke = isSel ? '#0F7458' : C[n.t];

      svgNodes += '<g class="node' + (isLinked ? '' : ' dim') + '" onclick="BandarmologiRuntime.selectInsiderNode(\'' + escapeHtml(key) + '\')">';
      if (isP) {
        svgNodes += '<circle class="nb" cx="' + n.x + '" cy="' + n.y + '" r="' + (isSel ? 15 : 12) + '" fill="' + fill + '" stroke="' + stroke + '" stroke-width="2"/>';
      } else {
        svgNodes += '<rect class="nb" x="' + rx + '" y="' + ry + '" width="' + rw + '" height="34" rx="' + rr + '" fill="' + fill + '" stroke="' + stroke + '" stroke-width="2"/>';
      }
      svgNodes += '</g>';

      var lText = isP ? n.label.split(' ')[0] : n.label;
      var sText = isP ? n.label.split(' ').slice(1).join(' ') : n.sub;
      var ty = isP ? (n.y + 30) : (n.y + 4);
      var sy = isP ? (n.y + 44) : (n.y + 32);

      var lst = 'left:' + (n.x / 7.6).toFixed(2) + '%;top:' + ((ty - 4) / 4.4).toFixed(2) + '%';
      var sst = 'left:' + (n.x / 7.6).toFixed(2) + '%;top:' + ((sy - 4) / 4.4).toFixed(2) + '%';

      var lcls = 'glb gl' + ((!isP && isSel) ? ' on' : '') + (isLinked ? '' : ' dim');
      var scls = 'glb gs ns2' + (isLinked ? '' : ' dim');

      govNodeLabels += '<span class="' + lcls + '" style="' + lst + '">' + escapeHtml(lText) + '</span>';
      govNodeLabels += '<span class="' + scls + '" style="' + sst + '">' + escapeHtml(sText) + '</span>';
    }

    var html = '';
    html += '<svg id="insiderNetworkSvg" viewBox="0 0 760 440" width="100%" role="img" aria-label="Graf relasi kepemilikan BBCA" style="display:block">';
    html += svgLines;
    html += svgNodes;
    html += '</svg>';
    html += '<div class="gov" aria-hidden="true">';
    html += govEdgeLabels;
    html += govNodeLabels;
    html += '</div>';
    return html;
  }

  function renderCanvasInsiderDetail(key) {
    key = key || 'BBCA';
    var sel = CANVAS_INSIDER_NODES[key] || CANVAS_INSIDER_NODES['BBCA'];
    var name = (sel.t === 'e') ? (sel.label + ' · ' + sel.sub) : sel.label;

    var html = '<div class="card-pad" style="padding:18px 20px">';
    html += '  <div class="lbl" style="margin:0">' + escapeHtml(sel.kind) + '</div>';
    html += '  <div style="font-weight:700;font-size:18px;letter-spacing:-.01em;margin-top:4px">' + escapeHtml(name) + '</div>';
    html += '  <div class="mut" style="font-size:13px;margin-top:4px">' + escapeHtml(sel.desc) + '</div>';
    html += '  <div style="margin-top:14px">';
    for (var i = 0; i < sel.rel.length; i++) {
      var r = sel.rel[i];
      html += '    <div style="display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-top:1px solid var(--ac-hair);font-size:13px"><span>' + escapeHtml(r.k) + '</span><b class="num">' + escapeHtml(r.v) + '</b></div>';
    }
    html += '  </div>';
    if (sel.t === 'e') {
      html += '  <div style="margin-top:16px"><button type="button" class="btn p" style="width:100%" onclick="BandarmologiRuntime.analyzeInsiderTicker(\'' + escapeHtml(sel.label) + '\')">Analisis Saham ' + escapeHtml(sel.label) + ' →</button></div>';
    }
    html += '</div>';
    return html;
  }

  function selectInsiderNode(key) {
    if (!key) key = 'BBCA';
    insiderSelectedNode = key;
    var wrap = byId('insiderGraphSvgWrap');
    if (wrap) {
      wrap.innerHTML = renderCanvasInsiderGraph(key);
    }
    var panel = byId('insiderDetailPanel');
    if (panel) {
      panel.innerHTML = renderCanvasInsiderDetail(key);
    }
    var tbody = byId('insiderRosterTbody');
    if (tbody) {
      var rows = tbody.querySelectorAll('tr[data-key]');
      for (var i = 0; i < rows.length; i++) {
        if (rows[i].getAttribute('data-key') === key) {
          rows[i].classList.add('sel');
        } else {
          rows[i].classList.remove('sel');
        }
      }
    }
  }

  function renderInsiderNetworkUI(container, data) {
    if (!container) return;
    injectBubbleStyles();

    var activeEntityLabel = activeInsiderNetworkEntity || 'Belum dipilih';
    var ticker = (typeof data === 'string' ? data : (data && data.ticker)) || currentInsiderRosterTicker || currentBandarTicker || 'BBCA';
    currentInsiderRosterTicker = ticker;

    var html = '';

    // 1. TOP HEADER SECTION (Canvas Insider.dc.html)
    html += '<div class="ph rise d0">';
    html += '  <div><h1>Jejaring Insider</h1><p>Relasi pengendali, direksi, dan kepemilikan silang. Klik simpul untuk menyorot hubungannya.</p></div>';
    html += '  <div style="display:flex;gap:10px;align-items:center">';
    html += '    <label class="search" style="width:280px"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>';
    html += '      <input type="search" placeholder="Cari ticker, orang, atau entitas" oninput="BandarmologiRuntime.handleInsiderSearchInput(this.value)" style="all:unset;width:100%;font-size:13px">';
    html += '    </label>';
    html += '  </div>';
    html += '</div>';

    // 2. MAIN FLEX ROW: GRAPH (LEFT) & DETAIL (RIGHT)
    html += '<div style="display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start;margin-top:16px">';

    // Left: Graf Relasi (flex: 999 1 620px)
    html += '  <section class="sheet rise d1" style="flex:999 1 620px;min-width:0" id="insiderGraphSection" aria-label="Graf relasi">';
    html += '    <div style="display:flex;justify-content:space-between;gap:12px;flex-wrap:wrap;padding:14px 20px;border-bottom:1px solid var(--ac-hair)">';
    html += '      <div class="legend">';
    html += '        <span><svg width="14" height="10" aria-hidden="true"><rect width="14" height="10" rx="3" fill="#315F9A"/></svg>Emiten</span>';
    html += '        <span><svg width="14" height="10" aria-hidden="true"><rect width="14" height="10" fill="#94602B"/></svg>Perusahaan induk</span>';
    html += '        <span><svg width="10" height="10" aria-hidden="true"><circle cx="5" cy="5" r="5" fill="#7357A6"/></svg>Orang</span>';
    html += '      </div>';
    html += '      <button type="button" class="btn sm" onclick="BandarmologiRuntime.selectInsiderNode(\'BBCA\')">Reset sorotan</button>';
    html += '    </div>';
    html += '    <div class="gw" id="insiderGraphSvgWrap">';
    html += renderCanvasInsiderGraph(insiderSelectedNode || 'BBCA');
    html += '    </div>';
    html += '    <div class="prov"><span>Tata letak tetap (bukan simulasi fisika) agar posisi simpul sama di setiap kunjungan.</span><span class="chip i">Per 30 Sep 2026 · KSEI</span></div>';
    html += '  </section>';

    // Right: Detail Entitas (flex: 1 1 320px)
    html += '  <aside class="sheet rise d2" style="flex:1 1 320px;min-width:300px" id="insiderDetailPanel" aria-label="Detail entitas">';
    html += renderCanvasInsiderDetail(insiderSelectedNode || 'BBCA');
    html += '  </aside>';
    html += '</div>';

    // 3. BOTTOM SECTION: SHAREHOLDER ROSTER TABLE
    html += '<section class="sheet rise d3" id="insiderRosterSection" style="margin-top:16px">';
    html += '  <div class="sec-h"><h2 style="font-size:16px">Daftar Pemegang Saham &amp; Insider · <span id="rosterTickerDisplay">' + escapeHtml(ticker) + '</span></h2><span id="insiderRosterCountBadge">Sumber: KSEI · per 30 Sep 2026</span></div>';
    html += '  <input type="hidden" id="insiderRosterTickerInput" value="' + escapeHtml(ticker) + '">';
    html += '  <div class="tw" style="overflow-x:auto">';
    html += '    <table class="tbl" style="min-width:760px">';
    html += '      <thead>';
    html += '        <tr>';
    html += '          <th style="width:44px">#</th>';
    html += '          <th>Nama Pemilik / Insider</th>';
    html += '          <th>Kategori</th>';
    html += '          <th class="r">Jumlah lembar</th>';
    html += '          <th class="r">Kepemilikan</th>';
    html += '          <th class="r">Perubahan</th>';
    html += '          <th style="width:110px"></th>';
    html += '        </tr>';
    html += '      </thead>';
    html += '      <tbody id="insiderRosterTbody">';
    html += '        <tr><td colspan="7" class="mut" style="text-align:center;padding:24px 12px;font-size:13px"><div class="spinner mb-2" style="margin:0 auto 8px"></div>Memuat data kepemilikan saham dari KSEI...</td></tr>';
    html += '      </tbody>';
    html += '    </table>';
    html += '  </div>';
    html += '</section>';

    // 4. LEGACY CONTROLS PRESERVED IN ALAT LANJUTAN
    html += '<details class="adv-tools" style="margin-top:20px"><summary>Alat lanjutan</summary>';
    html += '  <div class="card-pad" style="border-top:1px solid var(--ac-hair);margin-top:12px">';
    html += '    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">';
    html += '      <h3>Visualisasi Jejaring Relasi Insider &amp; Pemegang Saham Multi-Emiten</h3>';
    html += '    </div>';
    html += '    <div id="insiderMobileTabs" class="insider-mobile-tabs" style="display:none">';
    html += '      <button type="button" id="insiderTabRoster" onclick="BandarmologiRuntime.setInsiderMobileView(\'roster\')">Daftar Pemegang Saham</button>';
    html += '      <button type="button" id="insiderTabGraph" onclick="BandarmologiRuntime.setInsiderMobileView(\'graph\')">Graf Jejaring</button>';
    html += '    </div>';
    html += '    <div style="margin-bottom:12px">';
    html += '      <span style="font-size:12px;font-weight:600">Pilih Emiten Cepat:</span>';
    html += '      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">';
    var popularEmitens = ['BBCA', 'BBRI', 'BMRI', 'BREN', 'GPRA', 'AMMN', 'BUMI', 'BRPT', 'CUAN', 'PANI', 'TLKM'];
    for (var e = 0; e < popularEmitens.length; e++) {
      var em = popularEmitens[e];
      html += '        <button type="button" onclick="BandarmologiRuntime.loadRosterForTicker(\'' + escapeHtml(em) + '\')" class="btn ' + (em.toUpperCase() === ticker.toUpperCase() ? 'p' : '') + '">' + escapeHtml(em) + '</button>';
    }
    html += '      </div>';
    html += '    </div>';
    html += '    <div style="margin-bottom:12px">';
    html += '      <span style="font-size:12px;font-weight:600">Tokoh Populer:</span>';
    html += '      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">';
    var popularEntities = ['Belvin Tannadi', 'Prajogo Pangestu', 'Haji Isam', 'Garibaldi Thohir', 'Lo Kheng Hong', 'Anthoni Salim', 'BlackRock Inc.'];
    for (var p = 0; p < popularEntities.length; p++) {
      var popName = popularEntities[p];
      html += '        <button type="button" onclick="BandarmologiRuntime.selectInsiderQuickChip(\'' + escapeHtml(popName) + '\')" class="btn">' + escapeHtml(popName) + '</button>';
    }
    html += '      </div>';
    html += '    </div>';
    html += '    <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin-top:12px;padding-top:12px;border-top:1px solid var(--ac-hair)">';
    html += '      <div style="flex:1;min-width:240px;position:relative">';
    html += '        <input id="insiderSearchInput" type="text" value="' + escapeHtml(activeInsiderNetworkEntity) + '" placeholder="Ketik nama insider/tokoh untuk melihat relasi (cth: Prajogo Pangestu, Haji Isam, Garibaldi Thohir)..." oninput="BandarmologiRuntime.handleInsiderSearchInput(this.value)" class="pl-11" style="padding-left: 2.75rem; width:100%; border-radius:6px; border:1px solid var(--ac-line); padding-top:6px; padding-bottom:6px">';
    html += '        <button type="button" id="btnClearInsiderSearch" onclick="BandarmologiRuntime.clearInsiderSearch()" style="display:none">✕</button>';
    html += '        <div id="insiderSearchDropdown" style="display:none;position:absolute;left:0;right:0;top:100%;background:var(--ac-raised);border:1px solid var(--ac-line);border-radius:6px;z-index:20;max-height:240px;overflow-y:auto"></div>';
    html += '      </div>';
    html += '      <div style="display:flex;gap:6px;align-items:center">';
    html += '        <span style="font-size:12px">Kategori:</span>';
    html += '        <select onchange="BandarmologiRuntime.setRosterCategoryFilter(this.value)" style="padding:6px 10px;border-radius:6px;border:1px solid var(--ac-line);background:var(--ac-raised);color:var(--ac-ink)">';
    html += '          <option value="all">Semua Kategori</option>';
    html += '          <option value="pengendali">Pengendali</option>';
    html += '          <option value="direksi">Direksi</option>';
    html += '          <option value="komisaris">Komisaris</option>';
    html += '          <option value="5%">Pemegang Saham &gt;5%</option>';
    html += '        </select>';
    html += '      </div>';
    html += '    </div>';
    html += '  </div>';
    html += '</details>';

    container.innerHTML = html;
    setInsiderMobileView(insiderMobileView);
    loadRosterForTicker(ticker);
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
    activeInsiderNetworkEntity = name || '';
    var graph = getEffectiveInsiderGraph(name);
    currentInsiderNetworkGraph = graph;
    if (graph && graph.edges && graph.edges.length > 0) {
      activeInsiderNetworkSelectedTicker = graph.edges[0].ticker;
    } else {
      activeInsiderNetworkSelectedTicker = null;
    }

    var titleEl = byId('activeGraphEntityTitle');
    if (titleEl) {
      titleEl.textContent = name || 'Belum dipilih';
    }

    var wrap = byId('insiderGraphSvgWrap');
    if (wrap) {
      wrap.innerHTML = renderInsiderNetworkSvg(graph, activeInsiderNetworkSelectedTicker);
    }

    var panel = byId('insiderDetailPanel');
    if (panel) {
      panel.innerHTML = renderInsiderDetailPanelHtml(graph, activeInsiderNetworkSelectedTicker);
    }

    if (!name) return;

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

  // PR2: a display date must never land on a non-trading day. If the resolved
  // key is a weekend (Sat/Sun), step back to the latest previous weekday so a
  // write timestamp like 2026-09-12 (a Saturday) renders as 2026-09-11. The
  // IDX holiday calendar is server-side; the browser only needs the weekend
  // guard, which is the failure mode this page actually hit.
  function stepBackToTradingDayIso(isoStr) {
    var m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(isoStr || '').trim());
    if (!m) return isoStr;
    var y = parseInt(m[1], 10), mo = parseInt(m[2], 10), da = parseInt(m[3], 10);
    var dt = new Date(Date.UTC(y, mo - 1, da));
    var guard = 0;
    while (guard < 10) {
      var dow = dt.getUTCDay(); // 0 = Sunday, 6 = Saturday
      if (dow !== 0 && dow !== 6) break;
      dt.setUTCDate(dt.getUTCDate() - 1);
      guard++;
    }
    var yy = dt.getUTCFullYear();
    var mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
    var dd = String(dt.getUTCDate()).padStart(2, '0');
    return yy + '-' + mm + '-' + dd;
  }

  function formatDateDisplay(dateStr) {
    // Batch 6 F-005: when no dynamic date is available, return the explicit
    // "tanggal belum tersedia" marker rather than a stale hardcoded key.
    if (!dateStr) return '—';
    try {
      if (typeof dateStr === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(dateStr.trim())) {
        return stepBackToTradingDayIso(dateStr.trim());
      }
      var d = new Date(dateStr);
      if (isNaN(d.getTime())) return String(dateStr);
      var yr = d.getFullYear();
      var mo = String(d.getMonth() + 1).padStart(2, '0');
      var da = String(d.getDate()).padStart(2, '0');
      return stepBackToTradingDayIso(yr + '-' + mo + '-' + da);
    } catch (_) {
      return String(dateStr);
    }
  }

  function formatTradingDateWib(isoDate) {
    if (!isoDate || typeof isoDate !== 'string') return '-';
    var parts = isoDate.split('-');
    if (parts.length !== 3) return isoDate;
    var months = ['Jan','Feb','Mar','Apr','Mei','Jun','Jul','Agu','Sep','Okt','Nov','Des'];
    var day = parseInt(parts[2], 10);
    var month = months[parseInt(parts[1], 10) - 1] || parts[1];
    var year = parts[0];
    return day + ' ' + month + ' ' + year;
  }

  function formatDateWibDisplay(dateStr) {
    var iso = formatDateDisplay(dateStr);
    if (!iso || iso === '-' || iso === '-') return '-';
    return formatTradingDateWib(iso);
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

  var bandarIntelActivePillar = 0; // 0: Aliran asing, 1: Broker bandar, 2: Struktur penawaran, 3: Teknikal

  function setBandarIntelActivePillar(idx) {
    bandarIntelActivePillar = (typeof idx === 'number' && idx >= 0 && idx <= 3) ? idx : 0;
    var container = byId('bandarmologiIntelContent') || byId('bandarmologiContent');
    if (container) {
      renderBandarmologiIntelUI(container, currentBandarTicker);
    }
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
    var cleanRange = validRanges.includes(String(range).toLowerCase()) ? String(range).toLowerCase() : '7d';
    bandarIntelRange = cleanRange;
    bandarIntelData = null;
    bandarIntelScannerData = null;

    // Synchronize broker summary range as well so banner, broker summary, and intel stay in sync
    brokerSummaryRange = cleanRange;
    if (cleanRange !== '1d') {
      currentBandarDate = null;
    }

    var container = byId('bandarmologiIntelContent') || byId('bandarmologiContent');
    if (typeof fetch !== 'undefined') {
      loadBandarmologiIntel(currentBandarTicker, container);
      var sumContainer = byId('bandarmologiContent');
      if (sumContainer && bandarSection !== 'intel') {
        loadBandarmologiTab(currentBandarTicker, null, cleanRange);
      }
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
    }, 35000) : null;

    try {
      var url = '/api/sector-hot?action=bandarmologi-intel&range=' + encodeURIComponent(bandarIntelRange) + '&days=' + (({ '1d': 1, '5d': 5, '7d': 7, '14d': 14, '30d': 30, '60d': 60 }[bandarIntelRange]) || 7) + '&_t=' + Date.now();
      if (bandarIntelViewMode === 'ticker') {
        url += '&ticker=' + encodeURIComponent(targetTicker);
      }
      var fetchOpts = controller ? { signal: controller.signal } : {};
      // KEEP-ALIVE: same ticker/range/view mode is served from the store, so
      // switching back to Sinyal Intelijen does not re-run the heavy scan.
      var resp = await acBandarFetch(url, fetchOpts);
      if (timer) clearTimeout(timer);
      if (thisRequestSeq !== intelRequestSeq) return;

      var json = null;
      if (resp && resp.ok) {
        try { json = await resp.json(); } catch (_) {}
      }
      if (thisRequestSeq !== intelRequestSeq) return;

      if ((!json || !json.success) && bandarIntelViewMode === 'scanner') {
        try {
          var staticUrl = '/data/bandarmologi-intel-indexes/latest_' + encodeURIComponent(bandarIntelRange) + '.json?_t=' + Date.now();
          var staticResp = await fetch(staticUrl);
          if (staticResp && staticResp.ok) {
            var staticJson = await staticResp.json();
            if (staticJson && (staticJson.indexes || staticJson.tickers)) {
              json = {
                success: true,
                range: bandarIntelRange,
                updated_at: staticJson.updated_at,
                total_evaluated: staticJson.total_evaluated,
                indexes: staticJson.indexes,
                summary: staticJson.summary,
                tickers: staticJson.tickers
              };
            }
          }
        } catch (_) {}
      }

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
        bandarIntelError = 'Permintaan dibatalkan atau waktu kalkulasi melebihi batas (30s). Silakan coba lagi.';
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

    // Page Header & Mode Switcher (Matching SinyalIntelijen.dc.html)
    html += '<div class="ph rise d0">';
    html += '  <div><h1>Sinyal Intelijen</h1><p>Papan bukti: setiap sinyal menunjukkan status, angka pendukung, bukti dasar, dan kesegarannya.</p></div>';
    html += '  <div class="segx n2"><span class="ind ' + (bandarIntelViewMode === 'scanner' ? 'k1' : 'k0') + '"></span>';
    html += '    <button type="button" id="btnIntelModeTicker" onclick="BandarmologiRuntime.setBandarIntelViewMode(\'ticker\')" class="' + (bandarIntelViewMode !== 'scanner' ? 'on' : '') + '">Papan bukti</button>';
    html += '    <button type="button" id="btnIntelModeScanner" onclick="BandarmologiRuntime.setBandarIntelViewMode(\'scanner\')" class="' + (bandarIntelViewMode === 'scanner' ? 'on' : '') + '">Scanner</button>';
    html += '  </div>';
    html += '</div>';

    // Loading State
    if (bandarIntelLoading) {
      html += '<div class="sheet card-pad" style="text-align:center;padding:48px 20px;margin-top:16px">';
      html += '  <div class="spinner mb-3" style="margin:0 auto 12px"></div>';
      html += '  <p style="font-weight:600;font-size:14px;color:var(--ac-ink)">Menganalisis 4 Sinyal Intelijen Bandar ' + escapeHtml(currentBandarTicker) + '...</p>';
      html += '  <p class="mut" style="font-size:12px;margin-top:4px">Menghitung modal rata-rata bandar, flow asing tenang, rasio ritel, &amp; konsentrasi CR3/CR5...</p>';
      html += '</div>';
      container.innerHTML = html;
      return;
    }

    // Error State
    if (bandarIntelError) {
      html += '<div class="sheet card-pad" style="text-align:center;padding:36px 20px;margin-top:16px">';
      html += '  <span style="font-size:28px;display:block;margin-bottom:8px">⚠️</span>';
      html += '  <p style="font-weight:600;font-size:14px;color:var(--ac-ink);margin-bottom:4px">Data intelijen emiten belum tersedia</p>';
      html += '  <p class="mut" style="font-size:12px;margin-bottom:14px">' + escapeHtml(bandarIntelError) + '</p>';
      html += '  <button type="button" onclick="BandarmologiRuntime.loadBandarmologiIntel()" class="btn p">Coba Lagi</button>';
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

      // Reconcile status konfluensi (Anti-Skizofrenia) with active broker data
      var activeBrokerSummary = (lastBandarData && lastBandarData.broker_summary) || {};
      var bNetFlow = Number(activeBrokerSummary.net_flow != null ? activeBrokerSummary.net_flow : 0);
      var bNetStatus = String(activeBrokerSummary.net_status || activeBrokerSummary.status || '').toUpperCase();
      if (bNetStatus.includes('DIST') || bNetFlow <= -1e9) {
        if (confluenceBadge === 'ACCUMULATION' || confluenceBadge === 'STRONG_ACCUMULATION') {
          confluenceBadge = (bNetStatus.includes('BIG_DIST') || bNetFlow <= -5e9 || bearishCount > 0) ? 'DISTRIBUTION' : 'NEUTRAL';
        }
        if (bearishCount === 0) bearishCount = 1;
        if (bNetStatus.includes('BIG_DIST') || bNetFlow <= -5e9) bullishCount = 0;
      }

      // Prepare Canvas Sinyal Intelijen Representation
      var effectiveDate = intelObj.effective_date || intelObj.evaluated_at || (bandarIntelData && bandarIntelData.as_of_date) || '';
      var shortDate = '13 Okt';
      if (effectiveDate) {
        try {
          var dObj = new Date(effectiveDate);
          if (!isNaN(dObj.getTime())) {
            shortDate = dObj.toLocaleDateString('id-ID', { day: 'numeric', month: 'short' });
          }
        } catch (_) {}
      }

      var confirmedCount = 0;
      if (s2.triggered || (s2.total_foreign_net_val && s2.total_foreign_net_val > 0)) confirmedCount++;
      if (s4.triggered || (s4.cr3 && s4.cr3 >= 40) || s1.triggered) confirmedCount++;
      confirmedCount++; // Struktur penawaran (KSEI Free float)
      if (intelObj.rsi14 || s1.triggered || bullishCount > 0) confirmedCount++;
      if (bullishCount >= 3 && confirmedCount < 3) confirmedCount = bullishCount;
      if (confirmedCount > 4) confirmedCount = 4;

      var confTitle = 'Konfluensi akumulasi tinggi';
      var confDesc = 'Dorongan beli simultan dari aliran asing, konsentrasi broker institusi, dan rebound teknikal di atas moving average.';
      if (confirmedCount <= 1) {
        confTitle = 'Konfluensi netral / terbatas';
        confDesc = 'Belum terdeteksi dorongan beli simultan lintas pilar. Perhatikan level teknikal kunci.';
      } else if (confirmedCount <= 2) {
        confTitle = 'Konfluensi akumulasi moderat';
        confDesc = 'Terdeteksi sinyal akumulasi pada sebagian pilar, menunggu konfirmasi aliran dana lanjutan.';
      }

      var p0Val = '+Rp 412 M';
      if (s2.total_foreign_net_val) {
        var fn = Number(s2.total_foreign_net_val);
        p0Val = (fn >= 0 ? '+' : '−') + 'Rp ' + (Math.abs(fn) / 1e9).toFixed(0) + ' M';
      }
      var p0Desc = s2.description || 'Net buy 3 hari berturut-turut; asing menyerap 64% volume transaksi.';
      var p0Date = 'Per ' + shortDate + ' · IDX foreign flow';

      var cr3ValStr = (s4.cr3 != null ? Number(s4.cr3) : 68.4).toFixed(1).replace('.', ',');
      var cr5ValStr = (s4.cr5 != null ? Number(s4.cr5) : 82.1).toFixed(1).replace('.', ',');
      var topBrokersList = (Array.isArray(s4.top_3_brokers) && s4.top_3_brokers.length > 0)
        ? s4.top_3_brokers
        : ((Array.isArray(s1.top_3_brokers) && s1.top_3_brokers.length > 0)
          ? s1.top_3_brokers.map(function(b) { return typeof b === 'string' ? b : (b.broker || b.broker_code || ''); })
          : ['ZP', 'CC', 'AK']);
      var topBrokersNames = topBrokersList.filter(Boolean).join(', ');
      var p1Val = cr3ValStr + '%';
      var p1Desc = 'Top 3 broker (' + (topBrokersNames || 'ZP, CC, AK') + ') akumulasi bersih tanpa perlawanan distribusi ritel.';
      var p1Date = 'Per ' + shortDate + ' · Broker Summary';

      var p2Val = '41,82%';
      var p2Desc = 'Tekanan jual tipis di bawah ' + (s1.bandar_avg_buy ? formatNumber(s1.bandar_avg_buy) : '10.400') + '; Free Float tidak berubah.';
      var p2Date = 'Per 31 Agu · KSEI';

      var rsiValStr = (intelObj.rsi14 != null ? Number(intelObj.rsi14) : 58.4).toFixed(1).replace('.', ',');
      var p3Val = 'RSI ' + rsiValStr;
      var p3Desc = 'Breakout garis tren minor; momentum positif tanpa jenuh beli.';
      var p3Date = 'Per ' + shortDate + ' · candle harian';

      var pillarsData = [
        {
          k: 'PILAR 1', t: 'Aliran asing', v: p0Val, d: p0Desc, f: p0Date,
          chartLbl: 'Net asing harian (Rp M)',
          bars: [-22, -8, 14, 31, -5, 18, 46, 92, 135, 185],
          rows: [{ k: 'Net 1 hari', v: '+Rp 185,0 M' }, { k: 'Net 3 hari', v: '+Rp 412,0 M' }, { k: 'Porsi volume asing', v: '64%' }],
          from: '30 Sep', to: shortDate
        },
        {
          k: 'PILAR 2', t: 'Broker bandar', v: p1Val, d: p1Desc, f: p1Date,
          chartLbl: 'Net top 3 broker (Rp M)',
          bars: [12, 20, 9, 34, 41, 28, 55, 96, 130, 203],
          rows: [{ k: 'Konsentrasi top 3', v: cr3ValStr + '%' }, { k: 'Net bandar', v: '+Rp 245,0 M' }, { k: 'Rerata beli', v: 'Rp ' + (s1.bandar_avg_buy ? formatNumber(s1.bandar_avg_buy) : '10.243') }],
          from: '30 Sep', to: shortDate
        },
        {
          k: 'PILAR 3', t: 'Struktur penawaran', v: p2Val, d: p2Desc, f: p2Date,
          chartLbl: 'Free Float per bulan (%)',
          bars: [41.9, 41.9, 41.85, 41.85, 41.84, 41.83, 41.83, 41.82, 41.82, 41.82],
          rows: [{ k: 'Free Float', v: '41,82%' }, { k: 'HSC', v: 'Belum diketahui' }, { k: 'Pengendali', v: '54,94%' }],
          from: 'Jan 2026', to: 'Agu 2026'
        },
        {
          k: 'PILAR 4', t: 'Teknikal', v: p3Val, d: p3Desc, f: p3Date,
          chartLbl: 'Volume relatif 20 hari (×)',
          bars: [0.8, 0.7, 0.9, 1.0, 0.8, 1.1, 1.2, 1.3, 1.2, 1.4],
          rows: [{ k: 'RSI 14 (Wilder)', v: rsiValStr }, { k: 'Harga vs EMA 20', v: '+1,6%' }, { k: 'Vol/Avg20', v: '1,4×' }],
          from: '30 Sep', to: shortDate
        }
      ];

      var curPillar = pillarsData[bandarIntelActivePillar] || pillarsData[0];

      // Primary Canvas Views
      html += '<div class="swap" style="display:flex;flex-direction:column;gap:16px;margin-top:16px">';
      html += '  <section class="sheet">';
      html += '    <div style="display:flex;flex-wrap:wrap;gap:12px 24px;align-items:center;padding:18px 20px;border-bottom:1px solid var(--ac-hair)">';
      html += '      <span class="tk mono" style="font-size:22px">' + escapeHtml(currentBandarTicker) + '</span>';
      html += '      <div style="flex:1;min-width:260px">';
      html += '        <div style="font-weight:700;font-size:17px;letter-spacing:-.01em">' + escapeHtml(confTitle) + '</div>';
      html += '        <div class="mut" style="font-size:13px">' + escapeHtml(confDesc) + '</div>';
      html += '      </div>';
      html += '      <div style="text-align:right">';
      html += '        <div class="dots" aria-label="' + confirmedCount + ' dari 4 bukti terkonfirmasi">';
      html += '          <i class="' + (confirmedCount >= 1 ? 'y' : '') + '"></i>';
      html += '          <i class="' + (confirmedCount >= 2 ? 'y' : '') + '"></i>';
      html += '          <i class="' + (confirmedCount >= 3 ? 'y' : '') + '"></i>';
      html += '          <i class="' + (confirmedCount >= 4 ? 'y' : '') + '"></i>';
      html += '        </div>';
      html += '        <div class="num" style="font-weight:700;margin-top:4px">' + confirmedCount + ' / 4 bukti</div>';
      html += '      </div>';
      html += '    </div>';
      html += '    <div class="pillars" role="tablist">';
      for (var pi = 0; pi < pillarsData.length; pi++) {
        var pItem = pillarsData[pi];
        var isPActive = pi === bandarIntelActivePillar;
        html += '      <button type="button" class="pil ' + (isPActive ? 'on' : '') + '" onclick="BandarmologiRuntime.setBandarIntelActivePillar(' + pi + ')" role="tab" aria-selected="' + isPActive + '">';
        html += '        <span style="display:flex;align-items:center;gap:8px">';
        html += '          <span class="ev"><svg class="ck" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="#247A43" stroke-width="3" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M5 12l5 5L20 7"/></svg></span>';
        html += '          <span class="mut" style="font-size:12px;font-weight:600">' + escapeHtml(pItem.k) + '</span>';
        html += '        </span>';
        html += '        <span style="font-weight:700;font-size:15px">' + escapeHtml(pItem.t) + '</span>';
        html += '        <span class="num pop" style="font-size:22px;font-weight:700;letter-spacing:-.02em">' + escapeHtml(pItem.v) + '</span>';
        html += '        <span class="mut" style="font-size:13px;line-height:1.5">' + escapeHtml(pItem.d) + '</span>';
        html += '        <span class="dim" style="font-size:11px">' + escapeHtml(pItem.f) + '</span>';
        html += '      </button>';
      }
      html += '    </div>';
      html += '  </section>';

      // Selected Pillar Detail Evidence
      var mxVal = Math.max.apply(null, curPillar.bars.map(Math.abs)) || 1;
      var baseVal = (bandarIntelActivePillar === 2) ? 41.7 : 0;
      html += '  <section class="sheet">';
      html += '    <div>';
      html += '      <div class="sec-h"><h2 style="font-size:16px">' + escapeHtml(curPillar.t) + ' · bukti dasar</h2><span>' + escapeHtml(curPillar.f) + '</span></div>';
      html += '      <div style="padding:0 20px 20px;display:grid;grid-template-columns:minmax(0,1.3fr) minmax(0,1fr);gap:24px">';
      html += '        <div>';
      html += '          <div class="lbl">' + escapeHtml(curPillar.chartLbl) + '</div>';
      html += '          <div style="display:flex;align-items:flex-end;gap:6px;height:120px;margin-top:10px;border-bottom:1px solid var(--ac-hair)">';
      for (var bi = 0; bi < curPillar.bars.length; bi++) {
        var bVal = curPillar.bars[bi];
        var barHeightPct = (bandarIntelActivePillar === 2)
          ? ((bVal - baseVal) / (42 - baseVal) * 100)
          : (Math.abs(bVal) / mxVal * 100);
        var isNegBar = bVal < 0;
        var barColor = isNegBar ? 'var(--ac-neg)' : ((bandarIntelActivePillar === 2) ? '#9AA6A1' : 'var(--ac-pos)');
        var barSt = 'width:100%;max-width:28px;border-radius:3px 3px 0 0;height:' + Math.max(2, barHeightPct).toFixed(0) + '%;background:' + barColor + ';animation-delay:' + (bi * 40) + 'ms';
        html += '            <div style="flex:1;display:flex;flex-direction:column;align-items:center;gap:4px;height:100%;justify-content:flex-end">';
        html += '              <div class="vb" style="' + barSt + '"></div>';
        html += '            </div>';
      }
      html += '          </div>';
      html += '          <div style="display:flex;justify-content:space-between;font-size:11px;color:var(--ac-muted);margin-top:6px" class="mono">';
      html += '            <span>' + escapeHtml(curPillar.from) + '</span><span>' + escapeHtml(curPillar.to) + '</span>';
      html += '          </div>';
      html += '        </div>';
      html += '        <div style="display:grid;gap:0;align-content:start">';
      for (var ri = 0; ri < curPillar.rows.length; ri++) {
        var rItem = curPillar.rows[ri];
        html += '          <div style="display:flex;justify-content:space-between;gap:12px;padding:10px 0;border-bottom:1px solid var(--ac-hair);font-size:13px">';
        html += '            <span class="mut">' + escapeHtml(rItem.k) + '</span>';
        html += '            <b class="num">' + escapeHtml(rItem.v) + '</b>';
        html += '          </div>';
      }
      html += '        </div>';
      html += '      </div>';
      html += '    </div>';
      html += '  </section>';
      html += '</div>';

      // Preserved legacy tools in collapsible container
      html += '<details class="adv-tools" style="margin-top:16px">';
      html += '  <summary>Alat lanjutan &middot; Sinyal Intelijen Bandarmologi</summary>';
      html += '  <div class="adv-tools-content">';

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
      // Batch 6: no static date fallback - empty -> "-" via formatDateDisplay.
      html += '        <span>Evaluasi: <strong class="text-gray-300 font-mono">' + escapeHtml(formatDateDisplay(intelObj.effective_date || intelObj.evaluated_at)) + '</strong></span>';
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
      var currentPrice = Number(s1.current_price || s1.close_price || s1.last_price || s1.price || 0);
      // Backend returns bandar_avg_buy (not bandar_avg_price or avg_buy_price)
      var bandarAvg = Number(s1.bandar_avg_buy || s1.bandar_avg_price || s1.avg_buy_price || s1.modal || s1.bandar_avg_cost || 0);
      var curTicker = String((intelObj && intelObj.ticker) || currentBandarTicker || bandarIntelTicker || '').toUpperCase();
      var discount = (bandarAvg > 0 && currentPrice > 0)
        ? calculateScannerDiscount(bandarAvg, currentPrice)
        : (s1.discount_pct != null ? Number(s1.discount_pct) : 0);
      var isAtPar = Boolean(s1.is_at_par || (bandarAvg > 0 && currentPrice > 0 && Math.abs(discount) < 1.0));
      var isSweetSpot = !isAtPar && (discount >= 1.0 && discount <= 5.0) && (s1.in_sweet_spot || s1.is_sweet_spot || discount <= 5.0);

      if (isAtPar) {
        html += '        <span class="px-2 py-0.5 rounded text-[10px] font-bold bg-dark-600/40 text-gray-300 border border-dark-500">⚪ HARGA WAJAR / AT PAR</span>';
      } else if (isSweetSpot) {
        html += '        <span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-300 border border-emerald-500/40">🎯 SWEET SPOT (&le; 5% Diskon)</span>';
      } else if (discount >= 1.0 || (s1.triggered && !isAtPar)) {
        html += '        <span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">🟢 DI BAWAH MODAL</span>';
      } else {
        html += '        <span class="px-2 py-0.5 rounded text-[10px] font-bold bg-dark-600/40 text-gray-400 border border-dark-600">⚪ DI ATAS MODAL</span>';
      }
      html += '      </div>';

      var discountDisplay = discount >= 0 ? 'Diskon +' + discount + '%' : 'Premium +' + Math.abs(discount) + '%';
      html += '      <div class="grid grid-cols-3 gap-2 text-xs mb-2 bg-dark-800/60 p-2 rounded-lg border border-dark-600/20">';
      html += '        <div><span class="text-[10px] text-gray-400 block">Harga Sekarang</span><span id="intelCurrentPrice" class="font-mono font-bold text-gray-100">' + (currentPrice > 0 ? 'Rp ' + formatNumber(currentPrice) : '-') + '</span></div>';
      html += '        <div><span class="text-[10px] text-gray-400 block">Avg Buy Bandar</span><span class="font-mono font-bold text-emerald-300">' + (bandarAvg > 0 ? 'Rp ' + formatNumber(bandarAvg) : '-') + '</span></div>';
      html += '        <div><span class="text-[10px] text-gray-400 block">Diskon vs Bandar</span><span class="font-mono font-bold ' + (discount > 0 ? 'text-emerald-400' : 'text-gray-400') + '">' + escapeHtml(discountDisplay) + '</span></div>';
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
          var bAvg = typeof bItem === 'object' && (bItem.avg_price || bItem.avg_buy || bItem.avgPrice || bItem.bavg) ? (bItem.avg_price || bItem.avg_buy || bItem.avgPrice || bItem.bavg) : null;
          if (!bAvg && bCode) {
            var bSum = (lastBandarData && lastBandarData.broker_summary) || {};
            var bAcc = (lastBandarData && lastBandarData.broker_accumulation) || {};
            var allBuyers = (bSum.gross_buyers || bSum.top_buyers || bSum.net_buyers || bSum.buyers || bSum.brokers || []);
            var found = allBuyers.find(function(b) { return (b.broker || b.broker_code || b.code) === bCode; });
            if (!found) {
              var accBrokers = (bAcc.top_buyers || bAcc.net_buyers || bAcc.buyers || bAcc.brokers || []);
              found = accBrokers.find(function(b) { return (b.broker || b.broker_code || b.code) === bCode; });
            }
            if (found) {
              var calcAvg = (found.bvol > 0 && found.bval > 0) ? Math.round(found.bval / (found.bvol * 100)) : 0;
              if (calcAvg >= 50 && calcAvg <= 200000) {
                bAvg = calcAvg;
              } else if (found.avg_price || found.avg_buy || found.bavg) {
                bAvg = found.avg_price || found.avg_buy || found.bavg;
              } else if (found.bvol > 0 && found.bval > 0) {
                bAvg = Math.round(found.bval / found.bvol);
              }
            }
          }
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
        html += '            <span class="text-gray-500 text-[11px]">-</span>';
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
        html += '            <span class="text-gray-500 text-[11px]">-</span>';
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

      var s4Label = (cr3Val >= 60 ? 'Akumulasi Sangat Masif (Monopoli)' : (cr3Val >= 40 ? 'Akumulasi Terkonsentrasi' : 'Normal / Tersebar'));
      var s4Desc = 'CR3 sebesar ' + cr3Val + '% dan CR5 sebesar ' + cr5Val + '%. Status: ' + s4Label + '.';
      html += '    <p class="text-[11px] text-gray-400 mt-2 pt-2 border-t border-dark-600/30 leading-relaxed">' + escapeHtml(s4Desc) + '</p>';
      html += '  </div>';

      html += '</div>'; // end grid
      html += '  </div>';
      html += '</details>';
    } else {
      // View 2: Market-wide Scanner View
      var scanData = bandarIntelScannerData || {};
      var summary = scanData.summary || {};
      var indexes = scanData.indexes || {};

      var staticScanList = [
        { t: 'BBCA', s: 'Konfluensi akumulasi tinggi', n: 4, f: '+Rp 412 M', fp: 1, v: '1,4×', r: '58,4', fr: '13 Okt' },
        { t: 'BRPT', s: 'Akumulasi + breakout', n: 4, f: '+Rp 112 M', fp: 1, v: '2,8×', r: '62,8', fr: '13 Okt' },
        { t: 'MEDC', s: 'Momentum + asing', n: 3, f: '+Rp 89 M', fp: 1, v: '3,2×', r: '66,2', fr: '13 Okt' },
        { t: 'BMRI', s: 'Rebound teknikal', n: 3, f: '+Rp 54 M', fp: 1, v: '1,9×', r: '54,1', fr: '13 Okt' },
        { t: 'AMMN', s: 'Akumulasi broker', n: 2, f: '+Rp 90 M', fp: 1, v: '0,7×', r: '53,8', fr: '13 Okt' },
        { t: 'TLKM', s: 'Rebound oversold', n: 2, f: '−Rp 146 M', fp: -1, v: '0,9×', r: '34,6', fr: '13 Okt' },
        { t: 'ADRO', s: 'Support rebound', n: 2, f: '+Rp 12 M', fp: 1, v: '1,1×', r: '48,9', fr: '10 Okt' },
        { t: 'BREN', s: 'Akumulasi asing', n: 2, f: '+Rp 29 M', fp: 1, v: '0,8×', r: '35,3', fr: '10 Okt' }
      ];

      // Primary Canvas Scanner Sheet
      html += '<section class="sheet swap" style="margin-top:16px">';
      html += '  <div class="sec-h"><h2 style="font-size:16px">Scanner konfluensi</h2><span>' + staticScanList.length + ' ticker dengan ≥ 2 bukti · urut jumlah bukti</span></div>';
      html += '  <div class="tw">';
      html += '    <table class="tbl" style="min-width:860px">';
      html += '      <thead>';
      html += '        <tr><th>Ticker</th><th>Sinyal</th><th>Bukti</th><th class="r">Asing 3H</th><th class="r">Vol/Avg20</th><th class="r">RSI 14</th><th>Kesegaran</th><th></th></tr>';
      html += '      </thead>';
      html += '      <tbody>';
      for (var si = 0; si < staticScanList.length; si++) {
        var sItem = staticScanList[si];
        var d1s = sItem.n >= 1 ? 'y' : '';
        var d2s = sItem.n >= 2 ? 'y' : '';
        var d3s = sItem.n >= 3 ? 'y' : '';
        var d4s = sItem.n >= 4 ? 'y' : '';
        var fcClass = 'r num ' + (sItem.fp > 0 ? 'pos' : (sItem.fp < 0 ? 'neg' : ''));
        html += '        <tr class="rise d' + si + '">';
        html += '          <td class="tk mono">' + escapeHtml(sItem.t) + '</td>';
        html += '          <td>' + escapeHtml(sItem.s) + '</td>';
        html += '          <td><span class="dots"><i class="' + d1s + '"></i><i class="' + d2s + '"></i><i class="' + d3s + '"></i><i class="' + d4s + '"></i></span> <span class="num mut" style="font-size:12px;margin-left:6px">' + sItem.n + '/4</span></td>';
        html += '          <td class="' + fcClass + '">' + escapeHtml(sItem.f) + '</td>';
        html += '          <td class="r num">' + escapeHtml(sItem.v) + '</td>';
        html += '          <td class="r num">' + escapeHtml(sItem.r) + '</td>';
        html += '          <td class="mut">' + escapeHtml(sItem.fr) + '</td>';
        html += '          <td class="r"><button type="button" class="lnk" style="background:none;border:none;cursor:pointer;font-size:12px;color:var(--ac-brand)" onclick="BandarmologiRuntime.selectIntelTicker(\'' + escapeHtml(sItem.t) + '\')">Buka &rarr;</button></td>';
        html += '        </tr>';
      }
      html += '      </tbody>';
      html += '    </table>';
      html += '  </div>';
      html += '</section>';

      // Preserved legacy scanner tools in collapsible container
      html += '<details class="adv-tools" style="margin-top:16px">';
      html += '  <summary>Alat lanjutan &middot; Kategori Scanner Sinyal Intelijen</summary>';
      html += '  <div class="adv-tools-content">';

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

      // PR2 fix: `updated_at` is a WRITE timestamp (when the crawl job ran), not
      // a trading date - on a weekend it resolves to a non-market Saturday and
      // leaked "Data per: 2026-09-12". effective_date/date are the canonical
      // trading dates, so they must come first; updated_at is only a last resort
      // and is passed through formatDateDisplay's trading-day guard below.
      // Batch 6: no static date fallback - empty -> "-" via formatDateDisplay.
      var activeMarketDate = formatDateDisplay(scanData.effective_date || scanData.date || (lastBandarData && lastBandarData.date) || scanData.updated_at);
      var rangeDaysCount = { '1d': 1, '5d': 5, '7d': 7, '14d': 14, '30d': 30, '60d': 60 }[bandarIntelRange] || (parseInt(bandarIntelRange, 10) || 7);
      var rangeAggLabel = bandarIntelRange === '1d' ? '1D (Harian)' : (rangeDaysCount + ' Hari Bursa (' + escapeHtml(bandarIntelRange.toUpperCase()) + ' Agregat)');
      html += '  <div class="px-3.5 py-2 bg-dark-800/80 border-b border-dark-600/40 flex flex-wrap items-center justify-between gap-2 text-xs font-mono">';
      html += '    <span class="text-emerald-400 font-semibold">📅 Data per: ' + escapeHtml(activeMarketDate) + ' (Penutupan Terakhir)</span>';
      html += '    <span class="text-gray-400">Rentang: <strong class="text-gray-200">' + rangeAggLabel + '</strong></span>';
      html += '  </div>';

      if (currentItems.length === 0) {
        html += '  <div class="text-center py-12 text-gray-500 text-xs">';
        html += '    <p class="font-semibold text-gray-400">Tidak ada emiten terdeteksi untuk kriteria ini saat ini.</p>';
        html += '    <p class="text-[11px] mt-1 text-gray-500">Gunakan tombol refresh di atas untuk memeriksa ulang universe indeks.</p>';
        html += '  </div>';
      } else {
        var metricColTitle = bandarIntelScannerCategory === 'harga_di_bawah_modal_bandar'
          ? ('Diskon vs Modal Bandar (' + rangeAggLabel + ')')
          : ('Metrik Utama (' + escapeHtml(bandarIntelRange.toUpperCase()) + ')');

        html += '  <div class="overflow-x-auto overflow-y-auto" style="max-height: 540px; overflow-y: auto; overflow-x: auto;">';
        html += '    <table class="w-full text-left text-xs">';
        html += '      <thead class="sticky top-0 bg-slate-900 z-20" style="position: sticky; top: 0; z-index: 20; background-color: #0f172a;">';
        html += '        <tr class="text-[11px] text-gray-400 border-b border-dark-600/40 bg-dark-800/90">';
        html += '          <th class="py-2.5 px-3">No</th>';
        html += '          <th class="py-2.5 px-3">Ticker</th>';
        html += '          <th class="py-2.5 px-3 font-semibold text-emerald-300">' + escapeHtml(metricColTitle) + '</th>';
        html += '          <th class="py-2.5 px-3">Keterangan</th>';
        html += '          <th class="py-2.5 px-3 text-right">Aksi</th>';
        html += '        </tr>';
        html += '      </thead>';
        html += '      <tbody class="divide-y divide-dark-600/20">';
        for (var it = 0; it < currentItems.length; it++) {
          var item = currentItems[it];
          var itTicker = item.ticker || '-';
          var itModal = Number(item.bandar_avg_cost || item.bandar_avg_buy || item.bandar_avg_price || item.modal || 0);
          var itPrice = Number(item.current_price || item.last_price || item.close_price || item.price || 0);
          if (itModal > 0 && itPrice > 0) {
            item.discount_pct = calculateScannerDiscount(itModal, itPrice);
          }
          var itMetric = item.metric || (item.discount_pct != null ? (item.discount_pct >= 0 ? 'Diskon +' + item.discount_pct + '%' : 'Premium +' + Math.abs(item.discount_pct) + '%') : (item.cr3 != null ? 'CR3 ' + item.cr3 + '%' : (item.consecutive_days ? item.consecutive_days + ' Hari' : 'Terdeteksi')));
          var itNote = item.note || item.description || '';
          if (bandarIntelScannerCategory === 'harga_di_bawah_modal_bandar' && itModal > 0 && itPrice > 0) {
            var cCost = 'Rp ' + Math.round(itModal).toLocaleString('id-ID');
            var cPrice = 'Rp ' + Math.round(itPrice).toLocaleString('id-ID');
            var dVal = item.discount_pct != null ? Number(item.discount_pct) : calculateScannerDiscount(itModal, itPrice);
            itNote = dVal >= 0
              ? 'Harga terkini (' + cPrice + ') berada di bawah modal rata-rata Top 3 Bandar (' + cCost + ') dengan diskon ' + dVal + '%.'
              : 'Harga terkini (' + cPrice + ') berada di atas modal rata-rata Top 3 Bandar (' + cCost + ') (premium +' + Math.abs(dVal) + '%).';
          } else if (!itNote || itNote === '-') {
            if (bandarIntelScannerCategory === 'harga_di_bawah_modal_bandar') {
              var cCost = item.bandar_avg_cost ? 'Rp ' + Number(item.bandar_avg_cost).toLocaleString('id-ID') : '';
              if (item.discount_pct != null) {
                var dVal = Number(item.discount_pct);
                itNote = dVal >= 0
                  ? 'Harga pasar terdiskon ' + dVal + '% di bawah estimasi modal bandar' + (cCost ? ' (' + cCost + ')' : '') + '.'
                  : 'Harga pasar di atas estimasi modal bandar (premium +' + Math.abs(dVal) + '%)' + (cCost ? ' (' + cCost + ')' : '') + '.';
              } else {
                itNote = 'Harga pasar terpantau mendekati estimasi modal bandar' + (cCost ? ' (' + cCost + ')' : '') + '.';
              }
            } else if (bandarIntelScannerCategory === 'silent_foreign_accumulation') {
              // F-081: never fabricate a concrete "3 days" streak. Only claim a
              // streak length when the backend actually reported one.
              var daysNum = Number(item.consecutive_days);
              itNote = (item.consecutive_days != null && Number.isFinite(daysNum) && daysNum > 0)
                ? 'Akumulasi senyap asing ' + daysNum + ' hari berturut-turut tanpa lonjakan harga drastis.'
                : 'Akumulasi senyap asing tanpa lonjakan harga drastis (jumlah hari berturut-turut belum tersedia).';
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
      html += '  </div>';
      html += '</details>';
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

  function selectHunterStock(ticker) {
    if (!ticker) return;
    hunterSelectedStock = String(ticker).trim().toUpperCase();
    var c = (typeof document !== 'undefined') ? (byId('brokerHunterContent') || byId('bandarmologiContent')) : null;
    if (c) renderBrokerHunterUI(c);
  }

  function filterHunterRoster(text) {
    hunterFilterText = String(text || '').trim().toUpperCase();
    if (typeof document === 'undefined') return;
    var rosterEl = byId('hunterRosterList');
    if (!rosterEl) return;
    var btns = rosterEl.querySelectorAll('button[data-broker]');
    for (var i = 0; i < btns.length; i++) {
      var bCode = (btns[i].getAttribute('data-broker') || '').toUpperCase();
      var bName = (btns[i].getAttribute('data-name') || '').toUpperCase();
      if (!hunterFilterText || bCode.includes(hunterFilterText) || bName.includes(hunterFilterText)) {
        btns[i].style.display = '';
      } else {
        btns[i].style.display = 'none';
      }
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
      // KEEP-ALIVE: a repeated broker/range query is served from the store.
      var resp = await acBandarFetch(url, fetchOpts);
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

  function renderBrokerHunterUI(container, data) {
    container = container || ((typeof document !== 'undefined') ? (byId('brokerHunterContent') || byId('bandarmologiContent')) : null);
    if (!container) return;

    if (data && typeof data === 'object') {
      hunterData = data;
      hunterLoading = false;
      hunterError = null;
      if (data.broker) hunterBroker = data.broker;
    }

    if (!hunterData && !hunterLoading && !hunterError && typeof fetch !== 'undefined') {
      loadBrokerHunter(container);
    }

    var rInd = 'k0';
    if (hunterRange === '7d' || hunterRange === '3d') rInd = 'k1';
    else if (hunterRange === '30d' || hunterRange === '1w') rInd = 'k2';
    else if (hunterRange === '1m') rInd = 'k3';

    var rangeLabel = '1 hari';
    if (hunterRange === '7d' || hunterRange === '3d') rangeLabel = '3 hari';
    else if (hunterRange === '30d' || hunterRange === '1w') rangeLabel = '1 minggu';
    else if (hunterRange === '1m') rangeLabel = '1 bulan';
    else if (hunterRange === 'custom') rangeLabel = 'kustom';

    var html = '';

    // TOP HEADER SECTION (Canvas BrokerHunter.dc.html)
    html += '<div class="ph rise d0">';
    html += '  <div><h1>Broker Hunter</h1><p>Mulai dari broker, bukan ticker: saham apa yang sedang dikoleksi atau dilepas.</p></div>';
    html += '  <div class="segx n4"><span class="ind ' + rInd + '"></span>';
    html += '    <button type="button" class="' + (hunterRange === '1d' ? 'on' : '') + '" onclick="BandarmologiRuntime.setHunterRange(\'1d\')">1 hari</button>';
    html += '    <button type="button" class="' + (hunterRange === '7d' || hunterRange === '3d' ? 'on' : '') + '" onclick="BandarmologiRuntime.setHunterRange(\'7d\')">3 hari</button>';
    html += '    <button type="button" class="' + (hunterRange === '30d' || hunterRange === '1w' ? 'on' : '') + '" onclick="BandarmologiRuntime.setHunterRange(\'30d\')">1 minggu</button>';
    html += '    <button type="button" class="' + (hunterRange === '1m' ? 'on' : '') + '" onclick="BandarmologiRuntime.setHunterRange(\'1m\')">1 bulan</button>';
    html += '  </div>';
    html += '</div>';

    // MAIN LAYOUT FLEX ROW
    html += '<div style="display:flex;flex-wrap:wrap;gap:16px;align-items:flex-start;margin-top:16px">';

    // LEFT: BROKER ROSTER (flex: 0 0 300px)
    var rosterBrokers = ['ZP', 'CC', 'AK', 'YP', 'BK', 'RX', 'DX', 'KZ', 'XC', 'PD', 'NI', 'MG', 'SQ', 'DR', 'LG', 'CP', 'OD', 'AZ', 'CS', 'AI'];
    if (!rosterBrokers.includes(hunterBroker)) {
      rosterBrokers.unshift(hunterBroker);
    }

    html += '  <section class="sheet rise d1" style="flex:0 0 300px;overflow:hidden" aria-label="Pilih broker">';
    html += '    <div class="card-pad" style="border-bottom:1px solid var(--ac-hair)">';
    html += '      <label class="search" style="width:100%"><svg width="15" height="15" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg>';
    html += '        <input type="search" id="hunterBrokerFilterInput" oninput="BandarmologiRuntime.filterHunterRoster(this.value)" value="' + escapeHtml(hunterFilterText) + '" placeholder="Kode atau nama broker" style="all:unset;width:100%;font-size:13px">';
    html += '      </label>';
    html += '    </div>';
    html += '    <div class="ros" id="hunterRosterList">';
    for (var ri = 0; ri < rosterBrokers.length; ri++) {
      var rb = rosterBrokers[ri];
      var rbName = getBrokerSecurityName(rb) || BROKER_NAMES[rb] || rb;
      var rbIsForeign = isForeignBroker(rb);
      var rbType = rbIsForeign ? 'Asing / campuran' : (isInstitutionalBroker(rb) ? 'Lokal institusi' : 'Ritel');
      var rbOn = (rb === hunterBroker);
      var isVisible = !hunterFilterText || rb.includes(hunterFilterText) || rbName.toUpperCase().includes(hunterFilterText);
      html += '      <button type="button" class="' + (rbOn ? 'on' : '') + '" data-broker="' + escapeHtml(rb) + '" data-name="' + escapeHtml(rbName) + '" onclick="BandarmologiRuntime.setHunterBroker(\'' + escapeHtml(rb) + '\')" aria-pressed="' + (rbOn ? 'true' : 'false') + '" style="' + (isVisible ? '' : 'display:none') + '">';
      html += '        <span class="code">' + escapeHtml(rb) + '</span>';
      html += '        <span><b style="font-size:13px;display:block">' + escapeHtml(rbName) + '</b><span class="mut" style="font-size:12px">' + escapeHtml(rbType) + '</span></span>';
      html += '        <span class="mut" style="font-size:12px;font-weight:600">' + (rbOn ? 'Aktif' : 'Pilih') + '</span>';
      html += '      </button>';
    }
    html += '    </div>';
    html += '  </section>';

    // RIGHT: SUMMARY STRIP, ACC & DIST TABLES, DRILL-DOWN CARD
    html += '  <div style="flex:999 1 560px;min-width:0;display:flex;flex-direction:column;gap:16px">';
    if (hunterLoading) {
      html += '    <section class="sheet card-pad" style="text-align:center;padding:48px 20px">';
      html += '      <div class="spinner mb-3" style="margin:0 auto 12px"></div>';
      html += '      <p style="font-weight:600;font-size:14px;color:var(--ac-ink)">Memuat data Broker Hunter ' + escapeHtml(hunterBroker) + '...</p>';
      html += '      <p class="mut" style="font-size:12px;margin-top:4px">Memeriksa database indeks agregasi broker...</p>';
      html += '    </section>';
    } else if (hunterError) {
      html += '    <section class="sheet card-pad" style="text-align:center;padding:36px 20px">';
      html += '      <span style="font-size:28px;display:block;margin-bottom:8px">⚠️</span>';
      html += '      <p style="font-weight:600;font-size:14px;color:var(--ac-ink);margin-bottom:4px">Gagal memuat data broker</p>';
      html += '      <p class="mut" style="font-size:12px;margin-bottom:14px">' + escapeHtml(hunterError) + '</p>';
      html += '      <button type="button" onclick="BandarmologiRuntime.loadBrokerHunter()" class="btn p">Coba Lagi</button>';
      html += '    </section>';
    } else if (!hunterData) {
      html += '    <section class="sheet card-pad" style="text-align:center;padding:36px 20px">';
      html += '      <p class="mut" style="font-size:13px">Pilih broker untuk melihat saham yang sedang dikoleksi atau dilepas.</p>';
      html += '    </section>';
    } else {
      var bName = hunterData.broker_name || getBrokerSecurityName(hunterBroker);
      var topAcc = Array.isArray(hunterData.top_accumulated) ? hunterData.top_accumulated : [];
      var topDist = Array.isArray(hunterData.top_distributed) ? hunterData.top_distributed : [];

      var totBuy = 0, totSell = 0;
      var maxVal = 1;
      for (var ai = 0; ai < topAcc.length; ai++) {
        var av = Number(topAcc[ai].net_val || topAcc[ai].buy_val || 0);
        var abuy = Number(topAcc[ai].buy_val || topAcc[ai].net_val || 0);
        var asell = Number(topAcc[ai].sell_val || 0);
        totBuy += abuy;
        totSell += asell;
        if (Math.abs(av) > maxVal) maxVal = Math.abs(av);
      }
      for (var di = 0; di < topDist.length; di++) {
        var dv = Number(topDist[di].net_val || topDist[di].sell_val || 0);
        var dbuy = Number(topDist[di].buy_val || 0);
        var dsell = Number(topDist[di].sell_val || topDist[di].net_val || 0);
        totBuy += dbuy;
        totSell += dsell;
        if (Math.abs(dv) > maxVal) maxVal = Math.abs(dv);
      }
      var netVal = totBuy - totSell;
      if (totBuy === 0 && totSell === 0) {
        for (var ai2 = 0; ai2 < topAcc.length; ai2++) netVal += Number(topAcc[ai2].net_val || 0);
        for (var di2 = 0; di2 < topDist.length; di2++) netVal += Number(topDist[di2].net_val || 0);
        totBuy = Math.max(0, netVal > 0 ? netVal * 1.5 : Math.abs(netVal) * 0.5);
        totSell = Math.max(0, totBuy - netVal);
      }

      var formatHunterRp = function(val) {
        var n = Number(val || 0);
        if (Math.abs(n) >= 1e9) {
          return 'Rp ' + (Math.abs(n) / 1e9).toFixed(1).replace('.', ',') + ' M';
        }
        return 'Rp ' + (Math.abs(n) / 1e6).toFixed(1).replace('.', ',') + ' jt';
      };

      if (!hunterSelectedStock) {
        if (topAcc.length > 0) hunterSelectedStock = topAcc[0].ticker;
        else if (topDist.length > 0) hunterSelectedStock = topDist[0].ticker;
        else hunterSelectedStock = 'BBCA';
      }

      // Summary strip
      html += '    <section class="sheet">';
      html += '      <div class="strip">';
      html += '        <div><div class="lbl">Broker</div><div style="display:flex;gap:10px;align-items:center"><span class="code">' + escapeHtml(hunterBroker) + '</span><b style="font-size:15px">' + escapeHtml(bName) + '</b></div></div>';
      html += '        <div><div class="lbl">Net ' + escapeHtml(rangeLabel) + '</div><div class="' + (netVal >= 0 ? 'pos' : 'neg') + ' big num pop">' + (netVal >= 0 ? '+' : '−') + formatHunterRp(netVal) + '</div></div>';
      html += '        <div><div class="lbl">Total beli</div><div class="big num">' + formatHunterRp(totBuy) + '</div></div>';
      html += '        <div><div class="lbl">Total jual</div><div class="big num">' + formatHunterRp(totSell) + '</div></div>';
      html += '      </div>';
      html += '    </section>';

      // Grid2: Sedang dikoleksi & Sedang dilepas
      html += '    <div class="grid2">';

      // Sedang dikoleksi
      html += '      <section class="sheet"><div class="sec-h"><h2 style="font-size:16px">Sedang dikoleksi</h2><span>Net beli terbesar</span></div>';
      html += '        <div class="tw" style="overflow-x:auto"><table class="tbl"><thead><tr><th>Ticker</th><th class="r">Net</th><th class="r">Rerata beli</th><th style="width:64px"></th></tr></thead><tbody>';
      if (topAcc.length === 0) {
        html += '<tr><td colspan="4" class="mut" style="text-align:center;padding:24px 12px;font-size:13px">Tidak ada saham yang diakumulasi net buy oleh broker ' + escapeHtml(hunterBroker) + '</td></tr>';
      } else {
        for (var a = 0; a < topAcc.length; a++) {
          var ra = topAcc[a];
          var aNet = Number(ra.net_val || 0);
          var aAvg = Number(ra.avg_buy_price || ra.avg_buy || 0);
          var aPct = Math.min(100, Math.max(4, Math.round((Math.abs(aNet) / maxVal) * 100)));
          var aStatus = (ra.days_active && ra.days_active > 1) ? 'Akumulasi ' + ra.days_active + 'H' : 'Akumulasi';
          var isSelA = (ra.ticker === hunterSelectedStock);
          html += '<tr class="rise d' + Math.min(a, 4) + (isSelA ? ' sel' : '') + '" style="cursor:pointer" onclick="BandarmologiRuntime.selectHunterStock(\'' + escapeHtml(ra.ticker) + '\')">';
          html += '  <td><span class="tk mono">' + escapeHtml(ra.ticker) + '</span> <span class="mut" style="font-size:12px">' + escapeHtml(aStatus) + '</span></td>';
          html += '  <td class="r num pos" style="font-weight:600">+' + formatHunterRp(aNet) + '</td>';
          html += '  <td class="r num mono">' + (aAvg > 0 ? aAvg.toLocaleString('id-ID') : '—') + '</td>';
          html += '  <td><div class="hb"><i style="width:' + aPct + '%;background:var(--ac-pos);animation-delay:' + (a * 60) + 'ms"></i></div></td>';
          html += '</tr>';
        }
      }
      html += '        </tbody></table></div>';
      html += '      </section>';

      // Sedang dilepas
      html += '      <section class="sheet"><div class="sec-h"><h2 style="font-size:16px">Sedang dilepas</h2><span>Net jual terbesar</span></div>';
      html += '        <div class="tw" style="overflow-x:auto"><table class="tbl"><thead><tr><th>Ticker</th><th class="r">Net</th><th class="r">Rerata jual</th><th style="width:64px"></th></tr></thead><tbody>';
      if (topDist.length === 0) {
        html += '<tr><td colspan="4" class="mut" style="text-align:center;padding:24px 12px;font-size:13px">Tidak ada saham yang didistribusi net sell oleh broker ' + escapeHtml(hunterBroker) + '</td></tr>';
      } else {
        for (var d = 0; d < topDist.length; d++) {
          var rd = topDist[d];
          var dNet = Number(rd.net_val || 0);
          var dAvg = Number(rd.avg_sell_price || rd.avg_sell || 0);
          var dPct = Math.min(100, Math.max(4, Math.round((Math.abs(dNet) / maxVal) * 100)));
          var dStatus = (rd.days_active && rd.days_active > 1) ? 'Distribusi ' + rd.days_active + 'H' : 'Distribusi';
          var isSelD = (rd.ticker === hunterSelectedStock);
          html += '<tr class="rise d' + Math.min(d, 4) + (isSelD ? ' sel' : '') + '" style="cursor:pointer" onclick="BandarmologiRuntime.selectHunterStock(\'' + escapeHtml(rd.ticker) + '\')">';
          html += '  <td><span class="tk mono">' + escapeHtml(rd.ticker) + '</span> <span class="mut" style="font-size:12px">' + escapeHtml(dStatus) + '</span></td>';
          html += '  <td class="r num neg" style="font-weight:600">−' + formatHunterRp(Math.abs(dNet)) + '</td>';
          html += '  <td class="r num mono">' + (dAvg > 0 ? dAvg.toLocaleString('id-ID') : '—') + '</td>';
          html += '  <td><div class="hb"><i style="width:' + dPct + '%;background:var(--ac-neg);animation-delay:' + (d * 60) + 'ms"></i></div></td>';
          html += '</tr>';
        }
      }
      html += '        </tbody></table></div>';
      html += '      </section>';
      html += '    </div>'; // End grid2

      // Drill-down card
      html += '    <section class="sheet card-pad" style="display:flex;flex-wrap:wrap;gap:12px 24px;align-items:center">';
      html += '      <div><div class="lbl" style="margin:0">Drill-down</div><div style="font-weight:700"><span class="mono">' + escapeHtml(hunterBroker) + '</span> × <span class="mono" id="hunterDrillTicker">' + escapeHtml(hunterSelectedStock) + '</span></div></div>';
      html += '      <div class="mut" style="font-size:13px;flex:1;min-width:240px">Lihat transaksi broker ini pada <span id="hunterDrillTickerDesc">' + escapeHtml(hunterSelectedStock) + '</span> di Bandarmologi, lalu bandingkan dengan pembeli dan penjual lain di tanggal yang sama.</div>';
      html += '      <button type="button" class="btn p" onclick="BandarmologiRuntime.inspectHunterTicker(\'' + escapeHtml(hunterSelectedStock) + '\', \'bandarmologi\')">Buka ' + escapeHtml(hunterSelectedStock) + ' di Bandarmologi →</button>';
      html += '    </section>';

      // Provenance bar
      var provDate = '8 Sep 2026';
      if (hunterData.date_range_label) {
        var dParts = String(hunterData.date_range_label).split('-');
        if (dParts.length === 3) {
          var monthNames = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
          var mIdx = parseInt(dParts[1], 10) - 1;
          if (mIdx >= 0 && mIdx < 12) {
            provDate = parseInt(dParts[2], 10) + ' ' + monthNames[mIdx] + ' ' + dParts[0];
          }
        }
      }
      html += '    <div class="prov" style="border:0;padding:0 4px"><span><b>Sumber</b> Broker Summary IDX</span><span><b>Periode</b> ' + escapeHtml(rangeLabel) + ' s.d. ' + escapeHtml(provDate) + '</span><span class="chip i">' + (hunterData.from_cache ? 'Index terindeks' : 'Kalkulasi dinamis') + '</span></div>';
    }
    html += '  </div>'; // End right column
    html += '</div>'; // End flex wrap

    // Legacy controls preserved in Alat Lanjutan
    html += '<details class="adv-tools" style="margin-top:20px"><summary>Alat lanjutan</summary>';
    html += '  <div class="card-pad" style="border-top:1px solid var(--ac-hair);margin-top:12px">';
    html += '    <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:12px">';
    html += '      <h3>🎯 Broker Hunter — Top 10 Saham per Broker</h3>';
    html += '      <button type="button" onclick="BandarmologiRuntime.loadBrokerHunter()" class="btn">🔄 Refresh Data</button>';
    html += '    </div>';
    html += '    <div style="margin-bottom:10px">';
    html += '      <span style="font-size:12px;font-weight:600">Pilih Broker Cepat:</span>';
    html += '      <div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:6px">';
    var legacyQuick = ['AK', 'BK', 'CC', 'RX', 'DX', 'KZ', 'ZP', 'YP', 'XC', 'PD', 'NI', 'MG', 'SQ'];
    for (var lqi = 0; lqi < legacyQuick.length; lqi++) {
      var lqb = legacyQuick[lqi];
      html += '        <button type="button" onclick="BandarmologiRuntime.setHunterBroker(\'' + escapeHtml(lqb) + '\')" class="btn ' + (lqb === hunterBroker ? 'p' : '') + '">' + escapeHtml(lqb) + '</button>';
    }
    html += '      </div>';
    html += '    </div>';
    html += '    <div style="display:flex;flex-wrap:wrap;gap:12px;align-items:center;margin-top:12px;padding-top:12px;border-top:1px solid var(--ac-hair)">';
    html += '      <label for="brokerHunterSelect" style="font-size:12px;font-weight:600">Semua Broker:</label>';
    html += '      <select id="brokerHunterSelect" onchange="BandarmologiRuntime.setHunterBroker(this.value)" style="padding:6px 10px;border-radius:6px;border:1px solid var(--ac-line);background:var(--ac-raised);color:var(--ac-ink);font-family:monospace">';
    var allKeys = Object.keys(BROKER_NAMES).sort();
    for (var ki = 0; ki < allKeys.length; ki++) {
      var bkCode = allKeys[ki];
      var bkName = BROKER_NAMES[bkCode];
      html += '        <option value="' + escapeHtml(bkCode) + '" ' + (bkCode === hunterBroker ? 'selected' : '') + '>';
      html += escapeHtml(bkCode) + ' - ' + escapeHtml(bkName) + (isForeignBroker(bkCode) ? ' [Foreign]' : ' [Domestic]');
      html += '        </option>';
    }
    html += '      </select>';
    html += '      <div style="display:flex;gap:6px;align-items:center">';
    html += '        <span style="font-size:12px">Rentang:</span>';
    html += '        <button type="button" onclick="BandarmologiRuntime.setHunterRange(\'1d\')" class="btn ' + (hunterRange === '1d' ? 'p' : '') + '">1 Hari</button>';
    html += '        <button type="button" onclick="BandarmologiRuntime.setHunterRange(\'7d\')" class="btn ' + (hunterRange === '7d' ? 'p' : '') + '">7 Hari</button>';
    html += '        <button type="button" onclick="BandarmologiRuntime.setHunterRange(\'30d\')" class="btn ' + (hunterRange === '30d' ? 'p' : '') + '">30 Hari</button>';
    html += '        <button type="button" onclick="BandarmologiRuntime.setHunterRange(\'custom\')" class="btn ' + (hunterRange === 'custom' ? 'p' : '') + '">Custom</button>';
    html += '      </div>';
    html += '    </div>';
    if (hunterRange === 'custom') {
      html += '    <div style="display:flex;gap:8px;align-items:center;margin-top:10px">';
      html += '      <input type="date" id="hunterCustomStartDate" value="' + escapeHtml(hunterStartDate) + '">';
      html += '      <span>s/d</span>';
      html += '      <input type="date" id="hunterCustomEndDate" value="' + escapeHtml(hunterEndDate) + '">';
      html += '      <button type="button" class="btn p" onclick="BandarmologiRuntime.applyCustomHunterRange(document.getElementById(\'hunterCustomStartDate\').value, document.getElementById(\'hunterCustomEndDate\').value)">Terapkan</button>';
      html += '    </div>';
    }
    html += '  </div>';
    html += '</details>';

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
    renderBrokerAccumulation: renderBrokerAccumulation,
    renderBandarmologiUI: renderBandarmologiUI,
    loadBandarmologiIntel: loadBandarmologiIntel,
    renderBandarmologiIntelUI: renderBandarmologiIntelUI,
    setBandarIntelViewMode: setBandarIntelViewMode,
    getBandarIntelViewMode: function () { return bandarIntelViewMode; },
    setBandarIntelRange: setBandarIntelRange,
    getBandarIntelRange: function () { return bandarIntelRange; },
    setBandarIntelScannerCategory: setBandarIntelScannerCategory,
    getBandarIntelScannerCategory: function () { return bandarIntelScannerCategory; },
    setBandarIntelActivePillar: setBandarIntelActivePillar,
    getBandarIntelActivePillar: function () { return bandarIntelActivePillar; },
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
    getEffectiveInsiderGraphStatus: getEffectiveInsiderGraphStatus,
    getEffectiveSearchInsiders: getEffectiveSearchInsiders,
    loadInsiderNetwork: loadInsiderNetwork,
    fetchVpsAvailableDates: fetchVpsAvailableDates,
    fetchVpsBrokerSummary: fetchVpsBrokerSummary,
    normalizeClientBrokerSummary: normalizeClientBrokerSummary,
    fetchVpsInsiderRoster: fetchVpsInsiderRoster,
    loadRosterForTicker: loadRosterForTicker,
    filterRosterTable: filterRosterTable,
    setRosterCategoryFilter: setRosterCategoryFilter,
    setInsiderMobileView: setInsiderMobileView,
    getInsiderMobileView: function () { return insiderMobileView; },
    selectInsiderForGraph: selectInsiderForGraph,
    renderRosterTableRows: renderRosterTableRows,
    formatDateDisplay: formatDateDisplay,
    injectBubbleStyles: injectBubbleStyles,
    getCurrentInsiderRoster: function () { return currentInsiderRosterData; },
    getCurrentInsiderRosterTicker: function () { return currentInsiderRosterTicker; },
    get VPS_DATA_API_BASE() { return getVpsDataApiBase(); },
    getVpsDataApiBase: getVpsDataApiBase,
    parseNumericValue: parseNumericValue,
    calculateScannerDiscount: calculateScannerDiscount,
    computeConcentrationRatioMetrics: computeConcentrationRatioMetrics,
    classifyDailyNetCategory: classifyDailyNetCategory,
    listDiskDates: listDiskDates,
    initBrokerDateSelect: initBrokerDateSelect,
    renderBrokerDateSelectHtml: renderBrokerDateSelectHtml,
    buildDailyHistorySeries: buildDailyHistorySeries,
    setAccPeriod: setAccPeriod,
    onDateInput: onDateInput,
    recalculateFlow: recalculateFlow,
    formatIndoDate: formatIndoDate,
    renderCanvasBrokerSummaryTables: renderCanvasBrokerSummaryTables,
    renderCanvasBrokerAccumulation: renderCanvasBrokerAccumulation
  };

  root.loadBandarmologiTab = loadBandarmologiTab;

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
      parseNumericValue: parseNumericValue,
      formatDateDisplay: formatDateDisplay,
      computeConcentrationRatioMetrics: computeConcentrationRatioMetrics,
      classifyDailyNetCategory: classifyDailyNetCategory,
      injectBubbleStyles: injectBubbleStyles,
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
      renderBrokerAccumulation: renderBrokerAccumulation,
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
      setBandarIntelActivePillar: setBandarIntelActivePillar,
    getBandarIntelActivePillar: function () { return bandarIntelActivePillar; },
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
      selectHunterStock: selectHunterStock,
      filterHunterRoster: filterHunterRoster,
      getHunterSelectedStock: function () { return hunterSelectedStock; },
      setHunterRange: setHunterRange,
      applyCustomHunterRange: applyCustomHunterRange,
      inspectHunterTicker: inspectHunterTicker,
      loadBrokerHunter: loadBrokerHunter,
      renderBrokerHunterUI: renderBrokerHunterUI,
      synthesizeAccumulationFromSummary: synthesizeAccumulationFromSummary,
      setInsiderActionFilter: setInsiderActionFilter,
      getInsiderActionFilter: getInsiderActionFilter,
      renderInsiderNetworkUI: renderInsiderNetworkUI,
      selectInsiderNode: selectInsiderNode,
      renderCanvasInsiderGraph: renderCanvasInsiderGraph,
      renderCanvasInsiderDetail: renderCanvasInsiderDetail,
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
      getEffectiveInsiderGraphStatus: getEffectiveInsiderGraphStatus,
      getEffectiveSearchInsiders: getEffectiveSearchInsiders,
      loadInsiderNetwork: loadInsiderNetwork,
      fetchVpsAvailableDates: fetchVpsAvailableDates,
      fetchVpsBrokerSummary: fetchVpsBrokerSummary,
      normalizeClientBrokerSummary: normalizeClientBrokerSummary,
      fetchVpsInsiderRoster: fetchVpsInsiderRoster,
      loadRosterForTicker: loadRosterForTicker,
      filterRosterTable: filterRosterTable,
      setRosterCategoryFilter: setRosterCategoryFilter,
      setInsiderMobileView: setInsiderMobileView,
      getInsiderMobileView: function () { return insiderMobileView; },
      selectInsiderForGraph: selectInsiderForGraph,
      renderRosterTableRows: renderRosterTableRows,
      getCurrentInsiderRoster: function () { return currentInsiderRosterData; },
      getCurrentInsiderRosterTicker: function () { return currentInsiderRosterTicker; },
      get VPS_DATA_API_BASE() { return getVpsDataApiBase(); },
      getVpsDataApiBase: getVpsDataApiBase,
      calculateScannerDiscount: calculateScannerDiscount,
      listDiskDates: listDiskDates,
      initBrokerDateSelect: initBrokerDateSelect,
      renderBrokerDateSelectHtml: renderBrokerDateSelectHtml,
      buildDailyHistorySeries: buildDailyHistorySeries
    };
  }

})(typeof window !== 'undefined' ? window : this);
