// Auto-Cuan Standalone Analisis Saham Runtime
(function (root) {
  'use strict';

  function byId(id) { return document.getElementById(id); }

  function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[ch];
    });
  }

  function htmlToCleanText(html) {
    var temp = document.createElement('div');
    temp.innerHTML = html;
    return (temp.textContent || temp.innerText || '').trim();
  }

  // Server prompts tell the model to output real HTML and never markdown
  // stars, but LLMs occasionally ignore that and leave literal **bold**
  // markers in otherwise-valid HTML. Converting any that slip through is a
  // no-op when the text is clean, so it's safe to always run.
  function convertStrayMarkdownBold(html) {
    return String(html || '').replace(/\*\*([^*<>\n]+)\*\*/g, '<strong>$1</strong>');
  }

  // ===== TOAST NOTIFICATIONS =====
  root.showToast = function (message, type) {
    var container = byId('toastContainer');
    if (!container || typeof document.createElement !== 'function') return;
    var toast = document.createElement('div');
    var bgClass = type === 'danger' ? 'bg-rose-500/90 text-white' :
                  type === 'warning' ? 'bg-amber-500/90 text-black font-medium' :
                  type === 'good' ? 'bg-emerald-500/90 text-black font-semibold' :
                  'bg-dark-700/95 text-gray-100 border border-dark-600/40';
    toast.className = 'px-4 py-2.5 rounded-xl shadow-lg text-xs flex items-center gap-2 transition-all duration-300 pointer-events-auto ' + bgClass;
    toast.textContent = message;
    container.appendChild(toast);
    setTimeout(function () {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(-6px)';
      setTimeout(function () { toast.remove(); }, 320);
    }, 3200);
  };

  // ===== FORMATTERS =====
  root.mktCtxFmtPrice = function (v) {
    if (!Number.isFinite(v)) return '-';
    return 'Rp ' + Math.round(v).toLocaleString('id-ID');
  };
  root.mktCtxFmtPct = function (v) {
    if (!Number.isFinite(v)) return '-';
    return (v >= 0 ? '+' : '') + v.toFixed(2) + '%';
  };
  root.mktCtxFmtRatio = function (v) {
    if (!Number.isFinite(v)) return '-';
    return v.toFixed(2) + 'x';
  };
  root.mktCtxFmtIDR = function (v) {
    if (!Number.isFinite(v)) return '-';
    if (v === 0 || Math.round(v) === 0) return 'Rp 0';
    var abs = Math.abs(v);
    var sign = v > 0 ? '+' : '-';
    if (abs >= 1e12) return sign + (abs / 1e12).toFixed(2) + ' T';
    if (abs >= 1e9) return sign + (abs / 1e9).toFixed(2) + ' M';
    if (abs >= 1e6) return sign + (abs / 1e6).toFixed(1) + ' jt';
    return sign + Math.round(abs).toLocaleString('id-ID');
  };

  // ===== RANKING TABLE STATE & LOGIC =====
  // Same column set as configureRankingColumns() in stock-analysis-ai.js (the
  // dedicated "Ranking" menu page) so the Ranking Harian tab shows the
  // identical, fuller table instead of a second, simpler one.
  var RANKING_COLUMNS = [
    { key: 'ticker', label: 'Ticker', align: 'left', sortable: true },
    { key: 'last_price', label: 'Harga', align: 'right', fmt: root.mktCtxFmtPrice },
    { key: 'rsi_14', label: 'RSI 14', align: 'right', fmt: function(v) { return Number(v).toFixed(1); } },
    { key: 'week52_high_dist_pct', label: 'Jarak 52W High', align: 'right', fmt: root.mktCtxFmtPct },
    { key: 'volume_ratio_vs_7d_avg', label: 'Vol vs 7D', align: 'right', fmt: root.mktCtxFmtRatio },
    { key: 'foreign_net_today', label: 'Foreign Terakhir', align: 'right', fmt: root.mktCtxFmtIDR, colorize: true },
    { key: 'foreign_net_3d', label: 'Foreign 3D', align: 'right', fmt: root.mktCtxFmtIDR, colorize: true },
    { key: 'foreign_net_7d', label: 'Foreign 7D', align: 'right', fmt: root.mktCtxFmtIDR, colorize: true }
  ];
  root.RANKING_COLUMNS = RANKING_COLUMNS;

  // ===== RANKING TABLE STATE & LOGIC (CANVAS REDESIGN V2) =====
  var RANKING_SAMPLE_FALLBACK = [
    {t:'BBCA',p:10250,c:0.98,rsi:58.4,h:-1.92,v:1.4,f1:185.0,f3:412.5,s:94,as_of:'13 Okt 2026'},
    {t:'MEDC',p:1380,c:4.15,rsi:66.2,h:-0.72,v:3.2,f1:42.1,f3:89.4,s:91,as_of:'13 Okt 2026'},
    {t:'BRPT',p:1045,c:3.45,rsi:62.8,h:-4.55,v:2.8,f1:64.8,f3:112.0,s:88,as_of:'13 Okt 2026'},
    {t:'BBNI',p:5450,c:2.35,rsi:54.1,h:-8.12,v:1.9,f1:28.5,f3:54.2,s:85,as_of:'13 Okt 2026'},
    {t:'ADRO',p:3720,c:1.64,rsi:48.9,h:-12.4,v:1.1,f1:12.2,f3:20.8,s:82,as_of:'13 Okt 2026'},
    {t:'TLKM',p:2940,c:-1.01,rsi:34.6,h:-38.1,v:0.9,f1:-15.7,f3:-145.9,s:61,as_of:'13 Okt 2026'},
    {t:'ASII',p:5150,c:0.49,rsi:null,h:-14.3,v:0.9,f1:8.4,f3:15.1,s:74,as_of:'13 Okt 2026'},
    {t:'BMRI',p:6850,c:0.74,rsi:41.4,h:-22.6,v:0.87,f1:-168.5,f3:-529.6,s:58,as_of:'13 Okt 2026'},
    {t:'AMMN',p:8900,c:1.20,rsi:53.8,h:-44.6,v:0.67,f1:67.2,f3:90.4,s:70,as_of:'13 Okt 2026'},
    {t:'PGAS',p:1610,c:0.62,rsi:50.2,h:-6.9,v:1.2,f1:5.1,f3:null,s:72,as_of:'13 Okt 2026'},
    {t:'BREN',p:6850,c:2.24,rsi:35.3,h:-71.8,v:0.8,f1:-15.1,f3:29.5,s:55,as_of:'13 Okt 2026'},
    {t:'GOTO',p:65,c:-1.52,rsi:38.4,h:-31.5,v:0.87,f1:-0.22,f3:-0.03,s:42,as_of:'13 Okt 2026'},
    {t:'BRMS',p:410,c:1.23,rsi:29.1,h:-65.4,v:1.09,f1:35.3,f3:108.7,s:63,as_of:'13 Okt 2026'},
    {t:'TPIA',p:7200,c:0.70,rsi:37.1,h:-78.7,v:1.19,f1:-171.9,f3:-248.9,s:40,as_of:'13 Okt 2026'}
  ];

  var rankingState = {
    rows: [],
    loading: false,
    loaded: false,
    error: null,
    searchQuery: '',
    preset: 0, // 0: Semua, 1: Top gainer, 2: Asing beli, 3: RSI rebound
    sortKey: 's', // s, t, p, c, rsi, h, v, f1, f3
    sortDirection: 'desc',
    selectedTicker: null,
    csvN: null
  };
  root.rankingState = rankingState;

  var RANKING_PRESETS = [
    { l: 'Semua', f: function() { return true; } },
    { l: 'Top gainer', f: function(d) { return d.c != null && d.c >= 1.5; } },
    { l: 'Asing beli', f: function(d) { return (d.f1 != null && d.f1 > 0) && (d.f3 != null && d.f3 > 0); } },
    { l: 'RSI rebound', f: function(d) { return d.rsi != null && d.rsi < 40; } }
  ];

  var RANKING_COLUMNS_V2 = [
    { k: 't', l: 'Ticker', r: false },
    { k: 'p', l: 'Harga', r: true },
    { k: 'c', l: 'Chg %', r: true },
    { k: 'rsi', l: 'RSI 14', r: true },
    { k: 'h', l: 'Jarak 52W tinggi', r: true },
    { k: 'v', l: 'Vol vs 7H', r: true },
    { k: 'f1', l: 'Asing terakhir', r: true },
    { k: 'f3', l: 'Asing 3H', r: true },
    { k: 's', l: 'Skor', r: true }
  ];
  root.RANKING_COLUMNS_V2 = RANKING_COLUMNS_V2;

  function idFmtInt(n) {
    if (n == null || !Number.isFinite(Number(n))) return '—';
    return Math.round(Number(n)).toLocaleString('id-ID');
  }
  function idDec(n, d) {
    if (n == null || !Number.isFinite(Number(n))) return '—';
    return Number(n).toFixed(d).replace('.', ',');
  }
  function idSignPct(n, d) {
    if (n == null || !Number.isFinite(Number(n))) return '—';
    var num = Number(n);
    return (num >= 0 ? '+' : '−') + Math.abs(num).toFixed(d).replace('.', ',') + '%';
  }
  function idMoneyBillion(v) {
    if (v == null || !Number.isFinite(Number(v))) return '—';
    var val = Number(v);
    var a = Math.abs(val);
    var sign = val >= 0 ? '+' : '−';
    if (a >= 1000) {
      return sign + 'Rp ' + (a / 1000).toFixed(2).replace('.', ',') + ' T';
    }
    return sign + 'Rp ' + a.toFixed(1).replace('.', ',') + ' M';
  }

  function normalizeRankingRow(row, idx) {
    var t = String(row.t || row.ticker || '').toUpperCase();
    var p = row.p != null ? Number(row.p) : (row.last_price != null ? Number(row.last_price) : null);
    var c = row.c != null ? Number(row.c) : (row.change_pct != null ? Number(row.change_pct) : null);
    var rsi = row.rsi != null ? Number(row.rsi) : (row.rsi_14 != null ? Number(row.rsi_14) : null);
    var h = row.h != null ? Number(row.h) : (row.week52_high_dist_pct != null ? Number(row.week52_high_dist_pct) : null);
    var v = row.v != null ? Number(row.v) : (row.volume_ratio_vs_7d_avg != null ? Number(row.volume_ratio_vs_7d_avg) : null);

    var rawF1 = row.f1 != null ? Number(row.f1) : (row.foreign_net_today != null ? Number(row.foreign_net_today) : null);
    var f1 = rawF1 == null ? null : (Math.abs(rawF1) > 1e6 ? rawF1 / 1e9 : rawF1);

    var rawF3 = row.f3 != null ? Number(row.f3) : (row.foreign_net_3d != null ? Number(row.foreign_net_3d) : null);
    var f3 = rawF3 == null ? null : (Math.abs(rawF3) > 1e6 ? rawF3 / 1e9 : rawF3);

    var s = row.s != null ? Number(row.s) : (row.score != null ? Number(row.score) : null);
    if (s == null) {
      var sVal = 50;
      if (v != null) sVal += Math.min(20, Math.max(-15, (v - 1) * 12));
      if (c != null) sVal += Math.min(20, Math.max(-20, c * 3));
      if (f3 != null) sVal += Math.min(15, Math.max(-15, f3 > 0 ? 10 : -10));
      if (h != null) sVal += Math.min(10, Math.max(-15, (h + 10) * 0.5));
      s = Math.min(99, Math.max(15, Math.round(sVal)));
    }

    return {
      t: t, ticker: t,
      p: p, last_price: p,
      c: c, change_pct: c,
      rsi: rsi, rsi_14: rsi,
      h: h, week52_high_dist_pct: h,
      v: v, volume_ratio_vs_7d_avg: v,
      f1: f1, foreign_net_today: f1,
      f3: f3, foreign_net_3d: f3,
      s: s, score: s,
      as_of: row.as_of_trade_date || row.as_of || null,
      raw: row
    };
  }
  root.normalizeRankingRow = normalizeRankingRow;

  function renderRankingTable() {
    var wrap = byId('rankingTableWrap');
    if (!wrap) return;

    if (rankingState.loading && !rankingState.rows.length) {
      if (window.AutoCuanStates && typeof window.AutoCuanStates.html === 'function') {
        wrap.innerHTML = window.AutoCuanStates.html('Ranking', 'loading');
      } else {
        wrap.innerHTML = '<div class="text-center py-8 text-gray-500 text-xs"><span class="spin"></span> Memuat ranking harian seluruh emiten...</div>';
      }
      return;
    }
    if (rankingState.error && !rankingState.rows.length) {
      if (window.AutoCuanStates && typeof window.AutoCuanStates.html === 'function') {
        wrap.innerHTML = window.AutoCuanStates.html('Ranking', 'error', { reason: rankingState.error });
      } else {
        wrap.innerHTML = '<div class="text-center py-8 text-gray-500 text-xs">' + escapeHtml(rankingState.error) + '</div>';
      }
      return;
    }

    var sourceData = (rankingState.rows && rankingState.rows.length) ? rankingState.rows : RANKING_SAMPLE_FALLBACK;
    var normRows = sourceData.map(normalizeRankingRow);

    // Filter by preset
    var presetIdx = Math.max(0, Math.min(3, rankingState.preset || 0));
    var presetFn = RANKING_PRESETS[presetIdx].f;
    var filtered = normRows.filter(presetFn);

    // Filter by search query
    var query = (rankingState.searchQuery || '').trim().toUpperCase();
    if (query) {
      filtered = filtered.filter(function (r) {
        return r.t.indexOf(query) !== -1;
      });
    }

    // Sort
    var sortKey = rankingState.sortKey || 's';
    // Key translation if legacy key used
    if (sortKey === 'week52_high_dist_pct') sortKey = 'h';
    else if (sortKey === 'last_price') sortKey = 'p';
    else if (sortKey === 'rsi_14') sortKey = 'rsi';
    else if (sortKey === 'ticker') sortKey = 't';
    else if (sortKey === 'change_pct') sortKey = 'c';
    else if (sortKey === 'volume_ratio_vs_7d_avg') sortKey = 'v';
    else if (sortKey === 'foreign_net_today') sortKey = 'f1';
    else if (sortKey === 'foreign_net_3d') sortKey = 'f3';
    else if (sortKey === 'score') sortKey = 's';

    var dir = rankingState.sortDirection === 'asc' ? 1 : -1;
    filtered.sort(function (a, b) {
      var x = a[sortKey], y = b[sortKey];
      if (x == null && y == null) return 0;
      if (x == null) return 1;
      if (y == null) return -1;
      if (typeof x === 'string') return dir * x.localeCompare(y);
      return dir * (Number(x) - Number(y));
    });

    rankingState._currentFilteredRows = filtered;

    // Update Counter label
    var countLabel = byId('rankingCountLabel');
    var activeCol = RANKING_COLUMNS_V2.find(function(c) { return c.k === sortKey; }) || RANKING_COLUMNS_V2[8];
    var sortArrow = dir < 0 ? '↓' : '↑';
    if (countLabel) {
      countLabel.textContent = filtered.length + ' emiten · urut ' + activeCol.l + ' ' + sortArrow;
    }

    // Update Provenance Date
    var provDate = byId('rankingDateVal');
    if (provDate) {
      var latestDate = (filtered[0] && filtered[0].as_of) || (sourceData[0] && (sourceData[0].as_of_trade_date || sourceData[0].as_of)) || '13 Okt 2026';
      provDate.textContent = latestDate;
    }

    if (!filtered.length) {
      if (window.AutoCuanStates && typeof window.AutoCuanStates.html === 'function') {
        wrap.innerHTML = window.AutoCuanStates.html('Ranking', 'empty');
      } else {
        wrap.innerHTML = '<div class="text-center py-8 text-gray-500 text-xs">Tidak ada emiten yang cocok dengan filter ini.</div>';
      }
      return;
    }

    var html = '<table class="tbl rt" style="min-width:1040px">';
    html += '<thead><tr>';
    html += '<th style="width:48px">#</th>';
    RANKING_COLUMNS_V2.forEach(function (col) {
      var isActive = sortKey === col.k;
      var arr = isActive ? sortArrow : '';
      var cls = (col.r ? 'r' : '') + (isActive ? ' act' : '');
      html += '<th class="' + cls + '"><button type="button" onclick="setRankingSort(\'' + col.k + '\')" aria-label="Urutkan ' + col.l + '">' +
        col.l + ' <span>' + arr + '</span></button></th>';
    });
    html += '</tr></thead><tbody>';

    filtered.forEach(function (row, idx) {
      var isSelected = rankingState.selectedTicker && row.t === rankingState.selectedTicker;
      var rowCls = 'rise d' + Math.min(idx, 11) + (isSelected ? ' sel' : '');
      var cColor = row.c == null ? 'mut' : (row.c >= 0 ? 'pos' : 'neg');
      var f1Color = row.f1 == null ? 'mut' : (row.f1 >= 0 ? 'pos' : 'neg');
      var f3Color = row.f3 == null ? 'mut' : (row.f3 >= 0 ? 'pos' : 'neg');
      var isOs = row.rsi != null && row.rsi < 30;

      html += '<tr class="' + rowCls + '" onclick="pinRankingRow(\'' + escapeHtml(row.t) + '\')" style="cursor:pointer">';
      html += '<td class="num mut">' + (idx + 1) + '</td>';
      html += '<td><span class="tk mono">' + escapeHtml(row.t) + '</span></td>';
      html += '<td class="r num mono">' + idFmtInt(row.p) + '</td>';
      html += '<td class="r num ' + cColor + '" style="font-weight:600">' + idSignPct(row.c, 2) + '</td>';
      html += '<td class="r num">' + (row.rsi == null ? '—' : idDec(row.rsi, 1)) + (isOs ? '<span class="os">OS</span>' : '') + '</td>';
      html += '<td class="r num neg">' + (row.h == null ? '—' : idSignPct(row.h, 2)) + '</td>';
      html += '<td class="r num">' + (row.v == null ? '—' : idDec(row.v, 2) + '×') + '</td>';
      html += '<td class="r num ' + f1Color + '">' + idMoneyBillion(row.f1) + '</td>';
      html += '<td class="r num ' + f3Color + '">' + idMoneyBillion(row.f3) + '</td>';
      html += '<td class="r"><span class="score"><i><b style="width:' + row.s + '%;animation-delay:' + (idx * 30) + 'ms"></b></i><b class="num">' + row.s + '</b></span></td>';
      html += '</tr>';
    });
    html += '</tbody></table>';
    wrap.innerHTML = html;

    // Render Pinned Detail Row
    var pinEl = byId('rankingPinnedRow');
    if (pinEl) {
      var pinItem = rankingState.selectedTicker ? filtered.find(function(r) { return r.t === rankingState.selectedTicker; }) : null;
      if (pinItem) {
        var pinCColor = pinItem.c == null ? '' : (pinItem.c >= 0 ? 'pos' : 'neg');
        var pinF3Color = pinItem.f3 == null ? '' : (pinItem.f3 >= 0 ? 'pos' : 'neg');
        pinEl.style.display = 'block';
        pinEl.innerHTML = [
          '<div style="display:flex;flex-wrap:wrap;gap:12px 28px;align-items:center;padding:14px 20px">',
          '  <span class="tk mono" style="font-size:18px">' + escapeHtml(pinItem.t) + '</span>',
          '  <span><span class="lbl" style="display:block;margin:0">Harga</span><b class="num mono">Rp ' + idFmtInt(pinItem.p) + '</b> <span class="num ' + pinCColor + '">' + idSignPct(pinItem.c, 2) + '</span></span>',
          '  <span><span class="lbl" style="display:block;margin:0">RSI 14</span><b class="num">' + (pinItem.rsi == null ? '—' : idDec(pinItem.rsi, 1)) + '</b></span>',
          '  <span><span class="lbl" style="display:block;margin:0">Asing 3H</span><b class="num ' + pinF3Color + '">' + idMoneyBillion(pinItem.f3) + '</b></span>',
          '  <span><span class="lbl" style="display:block;margin:0">Skor</span><b class="num">' + pinItem.s + '</b></span>',
          '  <span style="margin-left:auto;display:flex;gap:8px">',
          '    <button class="btn sm" type="button" onclick="unpinRankingRow()">Tutup</button>',
          '    <a class="btn p sm" href="/analisis-saham?ticker=' + escapeHtml(pinItem.t) + '" onclick="if(typeof navigateTo===\'function\'){navigateTo(\'analisis\',\'chart\',{ticker:\'' + escapeHtml(pinItem.t) + '\'});return false;}">Buka Chart Workstation</a>',
          '  </span>',
          '</div>'
        ].join('');
      } else {
        pinEl.style.display = 'none';
        pinEl.innerHTML = '';
      }
    }
  }
  root.renderRankingTable = renderRankingTable;

  root.setRankingPreset = function (idx) {
    rankingState.preset = idx;
    var ind = byId('rankingPresetInd');
    if (ind) ind.className = 'ind k' + idx;
    for (var i = 0; i < 4; i++) {
      var btn = byId('btnRankingPreset' + i);
      if (btn) {
        if (i === idx) btn.classList.add('on');
        else btn.classList.remove('on');
      }
    }
    renderRankingTable();
  };

  root.setRankingSort = function (key) {
    if (rankingState.sortKey === key) {
      rankingState.sortDirection = rankingState.sortDirection === 'asc' ? 'desc' : 'asc';
    } else {
      rankingState.sortKey = key;
      rankingState.sortDirection = (key === 't' || key === 'ticker') ? 'asc' : 'desc';
    }
    renderRankingTable();
  };

  root.pinRankingRow = function (ticker) {
    rankingState.selectedTicker = ticker;
    renderRankingTable();
  };

  root.unpinRankingRow = function () {
    rankingState.selectedTicker = null;
    var pinEl = byId('rankingPinnedRow');
    if (pinEl) pinEl.style.display = 'none';
    renderRankingTable();
  };

  root.exportRankingCsv = function () {
    var rows = rankingState._currentFilteredRows || [];
    if (!rows.length) return;
    var csvContent = 'Rank;Ticker;Harga;Chg %;RSI 14;Jarak 52W tinggi %;Vol vs 7H;Asing Terakhir;Asing 3H;Skor\r\n';
    rows.forEach(function (r, idx) {
      csvContent += [
        idx + 1,
        r.t,
        r.p != null ? r.p : '',
        r.c != null ? r.c.toFixed(2).replace('.', ',') : '',
        r.rsi != null ? r.rsi.toFixed(1).replace('.', ',') : '',
        r.h != null ? r.h.toFixed(2).replace('.', ',') : '',
        r.v != null ? r.v.toFixed(2).replace('.', ',') : '',
        r.f1 != null ? r.f1.toFixed(1).replace('.', ',') : '',
        r.f3 != null ? r.f3.toFixed(1).replace('.', ',') : '',
        r.s != null ? r.s : ''
      ].join(';') + '\r\n';
    });
    if (typeof window !== 'undefined' && typeof window.Blob === 'function') {
      var blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
      var url = URL.createObjectURL(blob);
      var link = document.createElement('a');
      var dateStr = (rows[0] && rows[0].as_of) || new Date().toISOString().slice(0, 10);
      link.setAttribute('href', url);
      link.setAttribute('download', 'ranking-harian-' + dateStr + '.csv');
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    }
    var btn = byId('btnRankingCsv');
    if (btn) {
      btn.textContent = 'Terunduh · ' + rows.length + ' baris';
      setTimeout(function () {
        if (btn) btn.textContent = 'Ekspor CSV';
      }, 2400);
    }
  };

  var _rankingSearchTimer = null;
  root.onRankingSearchInput = function (value) {
    if (_rankingSearchTimer) clearTimeout(_rankingSearchTimer);
    _rankingSearchTimer = setTimeout(function () {
      rankingState.searchQuery = value;
      renderRankingTable();
    }, 200);
  };

  // ===== SUB-TAB SWITCHER (POLA CONSOLIDATED TAB) =====
  var currentAnalisisSubTab = 'ai'; // 'ai' or 'chart'

  function switchAnalisisSubTab(subTab) {
    currentAnalisisSubTab = (subTab === 'chart') ? 'chart' : 'ai';
    var isChart = currentAnalisisSubTab === 'chart';

    var btnAI = byId('tabAnalisisText');
    var btnChart = byId('tabAnalisisVision');
    if (btnAI) {
      if (btnAI.classList && btnAI.classList.toggle) btnAI.classList.toggle('active', !isChart);
      if (typeof btnAI.setAttribute === 'function') btnAI.setAttribute('aria-selected', !isChart ? 'true' : 'false');
    }
    if (btnChart) {
      if (btnChart.classList && btnChart.classList.toggle) btnChart.classList.toggle('active', isChart);
      if (typeof btnChart.setAttribute === 'function') btnChart.setAttribute('aria-selected', isChart ? 'true' : 'false');
    }

    // FIX-22: the dedicated "Chart Workstation" lens (added to the analysis
    // partial) shares the same `chart` subtab state; keep its ARIA/active
    // styling in lockstep so both entry points stay visually consistent.
    var btnWorkstationLens = byId('tabChartWorkstationLens');
    if (btnWorkstationLens) {
      if (btnWorkstationLens.classList && btnWorkstationLens.classList.toggle) {
        btnWorkstationLens.classList.toggle('active', isChart);
      }
      if (typeof btnWorkstationLens.setAttribute === 'function') {
        btnWorkstationLens.setAttribute('aria-selected', isChart ? 'true' : 'false');
      }
    }

    var pAnalisis = byId('panel-tab-analisis');
    var pChart = byId('panel-tab-chart');

    if (pAnalisis) pAnalisis.style.display = isChart ? 'none' : 'block';
    if (pChart) pChart.style.display = isChart ? 'block' : 'none';

    if (isChart) {
      var ticker = (root.UnifiedCockpit && typeof root.UnifiedCockpit.getActiveTicker === 'function')
        ? root.UnifiedCockpit.getActiveTicker() : (root.activeTicker || 'BBCA');
      if (root.UnifiedCockpit && typeof root.UnifiedCockpit.loadUnifiedChart === 'function') {
        root.UnifiedCockpit.loadUnifiedChart(ticker);
      }
      if (typeof setTimeout === 'function') {
        setTimeout(function () {
          try { window.dispatchEvent(new Event('resize')); } catch (_) {}
        }, 50);
      }
    }
  }
  root.switchAnalisisSubTab = switchAnalisisSubTab;

  /**
   * FIX-22: single public entry point for "open the chart for this ticker".
   * Combines the navigation hop (analysis shell + chart lens) with the chart
   * workstation handoff (preset and/or plan levels) so callers - screener rows,
   * the command palette, deep links - never have to know the shell internals.
   * Values are forwarded as-is; the workstation itself fails closed when a
   * level is missing, so no number is ever invented here.
   */
  function openChartWorkstation(ticker, options) {
    var safeTicker = String(ticker || '').trim().toUpperCase();
    var opts = options && typeof options === 'object' ? options : {};

    try { switchAnalisisTab('chart'); } catch (_) {}
    try { switchAnalisisSubTab('chart'); } catch (_) {}

    if (!safeTicker) return null;

    var ws = root.AutoCuanChartWorkstation;
    if (ws && typeof ws.switchTicker === 'function') {
      var handoff = { source: opts.source || 'analysis-shell' };
      if (opts.preset) handoff.preset = opts.preset;
      if (opts.planLevels) handoff.planLevels = opts.planLevels;
      return ws.switchTicker('mainChart', safeTicker, handoff);
    }
    return null;
  }
  root.openChartWorkstation = openChartWorkstation;

  var _isSwitchingTab = false;
  function switchAnalisisTab(tabName) {
    if (_isSwitchingTab) return;
    _isSwitchingTab = true;
    try {
    var parentTab = tabName;
    if (tabName === 'analisis' || tabName === 'chart') {
      parentTab = 'analisis-chart';
    } else if (tabName === 'akumulasi') {
      parentTab = 'bandarmologi';
    } else if (tabName === 'intel' || tabName === 'bandarmologi-intel' || tabName === 'sinyal-intelijen') {
      parentTab = 'intel';
    } else if (tabName === 'insider' || tabName === 'network') {
      parentTab = 'insider';
    }

    var validParentTabs = ['analisis-chart', 'bandarmologi', 'intel', 'hunter', 'insider', 'ranking', 'financial', 'market-structure', 'pattern'];
    if (validParentTabs.indexOf(parentTab) < 0) parentTab = 'analisis-chart';
    root.__ACTIVE_ANALISIS_SUBTAB__ = parentTab;
    var workspace = byId('page-analisis');
    if (workspace && !workspace.classList.contains('hidden') && typeof root.syncWorkspaceSidebarActive === 'function') root.syncWorkspaceSidebarActive('analisis');
    var workspaceTitle = byId('analysisWorkspaceTitle');
    if (workspaceTitle) workspaceTitle.textContent = ({ 'analisis-chart':'Analisis Saham', bandarmologi:'Bandarmologi', intel:'Sinyal Intelijen', hunter:'Broker Hunter', insider:'Jejaring Insider', ranking:'Ranking Harian', financial:'Financial', 'market-structure':'Struktur Pasar', pattern:'Pattern Radar' })[parentTab];
    var subtitle = workspace && workspace.querySelector && workspace.querySelector('.page-subtitle');
    if (subtitle) {
      if (parentTab === 'bandarmologi') {
        subtitle.textContent = 'Analisis arus akumulasi dan distribusi broker, deteksi pergerakan smart money, serta struktur volume transaksi emiten.';
      } else if (parentTab === 'hunter') {
        subtitle.textContent = 'Lacak pergerakan broker institusi dan aktivitas akumulasi tersembunyi.';
      } else if (parentTab === 'intel') {
        subtitle.textContent = 'Peringatan anomali volume, transaksi tak wajar, dan sinyal deteksi dini.';
      } else if (parentTab === 'insider') {
        subtitle.textContent = 'Peta kepemilikan saham pengendali, direksi, dan transaksi orang dalam.';
      } else if (parentTab === 'financial') {
        subtitle.textContent = 'Data fundamental, valuasi, dan sumber laporan untuk saham yang dipilih.';
      } else if (parentTab === 'market-structure') {
        subtitle.textContent = 'Free float, status HSC, dan kelengkapan data struktur kepemilikan.';
      } else if (parentTab === 'ranking') {
        subtitle.textContent = 'Peringkat harian saham berdasarkan momentum, likuiditas, dan konteks pasar.';
      } else if (parentTab === 'pattern') {
        subtitle.textContent = 'Pemetaan pola teknikal, klaster formasi chart, dan deteksi probabilitas visual.';
      } else {
        subtitle.textContent = 'Chart interaktif, analisis teknikal komprehensif, dan pembacaan visual AI.';
      }
    }

    if (typeof document !== 'undefined' && document.querySelectorAll) {
      document.querySelectorAll('.analisis-lens-btn').forEach(function (btn) {
        var lens = btn.dataset ? btn.dataset.lens : (btn.getAttribute ? btn.getAttribute('data-lens') : null);
        var isActive = lens === parentTab;
        if (btn.classList && btn.classList.toggle) btn.classList.toggle('active', isActive);
        if (btn.setAttribute) btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
      });
      document.querySelectorAll('.analisis-tab').forEach(function (btn) {
        var btnTab = btn.dataset ? btn.dataset.tab : (btn.getAttribute ? btn.getAttribute('data-tab') : null);
        var isActive = btnTab === parentTab || (parentTab === 'analisis-chart' && (btnTab === 'analisis-chart' || btnTab === 'analisis'));
        if (btn.classList && btn.classList.toggle) btn.classList.toggle('active', isActive);
        if (btn.setAttribute) btn.setAttribute('aria-selected', isActive ? 'true' : 'false');
      });
    }

    var pHeader = byId('analisisChartHeader');
    var pSubtabWrap = byId('analisisChartSubtabWrap');
    if (pHeader) pHeader.style.display = (parentTab === 'market-structure' || parentTab === 'ranking' || parentTab === 'bandarmologi' || parentTab === 'financial') ? 'none' : 'block';
    if (pSubtabWrap) pSubtabWrap.style.display = (parentTab === 'analisis-chart') ? 'flex' : 'none';
    if ((parentTab === 'market-structure' || parentTab === 'ranking' || parentTab === 'bandarmologi' || parentTab === 'financial') && typeof window !== 'undefined' && typeof window.scrollTo === 'function') {
      window.scrollTo({ top: 0, behavior: 'instant' });
    }

    var pAnalisis = byId('panel-tab-analisis');
    var pChart = byId('panel-tab-chart');
    var pBandarmologi = byId('panel-tab-bandarmologi');
    var pIntel = byId('panel-tab-intel');
    var pHunter = byId('panel-tab-hunter');
    var pInsider = byId('panel-tab-insider');
    var pRanking = byId('panel-tab-ranking');
    var pFinancial = byId('panel-tab-financial');
    var pMarketStructure = byId('panel-tab-market-structure');
    var pPattern = byId('panel-tab-pattern');

    if (parentTab === 'analisis-chart') {
      if (pBandarmologi) pBandarmologi.style.display = 'none';
      if (pIntel) pIntel.style.display = 'none';
      if (pHunter) pHunter.style.display = 'none';
      if (pInsider) pInsider.style.display = 'none';
      if (pRanking) pRanking.style.display = 'none';
      if (pFinancial) pFinancial.style.display = 'none';
      if (pMarketStructure) pMarketStructure.style.display = 'none';
      if (pPattern) pPattern.style.display = 'none';

      if (tabName === 'chart') {
        if (pAnalisis) pAnalisis.style.display = 'none';
        if (pChart) pChart.style.display = 'block';
        switchAnalisisSubTab('chart');
      } else if (tabName === 'analisis') {
        if (pAnalisis) pAnalisis.style.display = 'block';
        if (pChart) pChart.style.display = 'none';
        switchAnalisisSubTab('ai');
      } else {
        if (currentAnalisisSubTab === 'chart') {
          if (pAnalisis) pAnalisis.style.display = 'none';
          if (pChart) pChart.style.display = 'block';
          switchAnalisisSubTab('chart');
        } else {
          if (pAnalisis) pAnalisis.style.display = 'block';
          if (pChart) pChart.style.display = 'none';
          switchAnalisisSubTab('ai');
        }
      }
    } else {
      if (pAnalisis) pAnalisis.style.display = 'none';
      if (pChart) pChart.style.display = 'none';
      if (pBandarmologi) pBandarmologi.style.display = (parentTab === 'bandarmologi' ? 'block' : 'none');
      if (pIntel) pIntel.style.display = (parentTab === 'intel' ? 'block' : 'none');
      if (pHunter) pHunter.style.display = (parentTab === 'hunter' ? 'block' : 'none');
      if (pInsider) pInsider.style.display = (parentTab === 'insider' ? 'block' : 'none');
      if (pRanking) pRanking.style.display = (parentTab === 'ranking' ? 'block' : 'none');
      if (pFinancial) pFinancial.style.display = (parentTab === 'financial' ? 'block' : 'none');
      if (pMarketStructure) pMarketStructure.style.display = (parentTab === 'market-structure' ? 'block' : 'none');
      if (pPattern) pPattern.style.display = (parentTab === 'pattern' ? 'block' : 'none');
    }
    if (root.AutoCuanFinalUiux) root.AutoCuanFinalUiux.enterPanel(byId('panel-tab-' + parentTab));

    // Sync tab param in URL
    try {
      if (typeof window !== 'undefined' && window.location) {
        var currentUrl = new URL(window.location.href);
        currentUrl.searchParams.set('tab', tabName);
        window.history.replaceState({}, '', currentUrl.pathname + currentUrl.search + currentUrl.hash);
      }
    } catch (_) {}

    if (parentTab === 'analisis-chart') {
      if (tabName === 'chart') {
        switchAnalisisSubTab('chart');
      } else if (tabName === 'analisis') {
        switchAnalisisSubTab('ai');
      } else {
        switchAnalisisSubTab(currentAnalisisSubTab);
      }
    } else if (parentTab === 'ranking') {
      if (!isSubscribedUser()) {
        updateRankingPaywallUi();
        return;
      }
      root.ensureRankingTableLoaded();
    } else if (parentTab === 'financial') {
      var activeResearchTicker = (root.UnifiedCockpit && typeof root.UnifiedCockpit.getActiveTicker === 'function')
        ? (root.UnifiedCockpit.getActiveTicker() || root.activeTicker || 'BBCA') : (root.activeTicker || 'BBCA');
      root.loadFinancialStructureTab('financial', activeResearchTicker);
    } else if (parentTab === 'market-structure') {
      if (typeof root.loadStrukturPasarUniverse === 'function') {
        root.loadStrukturPasarUniverse();
      }
    } else if (parentTab === 'bandarmologi') {
      var currentSection = (root.BandarmologiRuntime && typeof root.BandarmologiRuntime.getBandarSection === 'function')
        ? root.BandarmologiRuntime.getBandarSection() : 'summary';
      var bandarSection = (tabName === 'akumulasi' || currentSection === 'akumulasi') ? 'akumulasi' : 'summary';
      if (root.BandarmologiRuntime && typeof root.BandarmologiRuntime.setBandarSection === 'function') {
        root.BandarmologiRuntime.setBandarSection(bandarSection);
      }
      if (!isSubscribedUser()) {
        renderTabPaywall('bandarmologiContent', 'Bandarmologi Terkunci', 'Akses Broker Summary, Akumulasi Bandar harian, dan aliran modal bandar hanya tersedia untuk member berlangganan.');
        return;
      }
      if (typeof root.loadBandarmologiTab === 'function') {
        var bandarTicker = (root.UnifiedCockpit && typeof root.UnifiedCockpit.getActiveTicker === 'function')
          ? (root.UnifiedCockpit.getActiveTicker() || root.activeTicker || 'BBCA') : (root.activeTicker || 'BBCA');
        root.loadBandarmologiTab(bandarTicker);
      }
      if (root.AutoCuanMarketIntelligence && typeof root.AutoCuanMarketIntelligence.renderSmartBrokerSummary === 'function' && byId('smartBrokerSummaryContainer')) {
        var smartTicker = (root.UnifiedCockpit && typeof root.UnifiedCockpit.getActiveTicker === 'function')
          ? (root.UnifiedCockpit.getActiveTicker() || root.activeTicker || 'BBCA') : (root.activeTicker || 'BBCA');
        root.AutoCuanMarketIntelligence.renderSmartBrokerSummary('smartBrokerSummaryContainer', smartTicker);
      }
    } else if (parentTab === 'intel') {
      if (root.BandarmologiRuntime && typeof root.BandarmologiRuntime.setBandarSection === 'function') {
        root.BandarmologiRuntime.setBandarSection('intel');
      }
      if (!isSubscribedUser()) {
        var intelTarget = byId('bandarmologiIntelContent') || byId('bandarmologiContent');
        renderTabPaywall(intelTarget ? intelTarget.id : 'bandarmologiContent', 'Sinyal Intelijen Terkunci', 'Akses 4 Sinyal Strategis Intelijen Bandar (Akumulasi Senyap, Harga di Bawah Bandar, Ritel Cutloss vs Bandar, dan Screening Pasar) hanya tersedia untuk member berlangganan.');
        return;
      }
      if (root.BandarmologiRuntime && typeof root.BandarmologiRuntime.updateIntelSearchBarVisibility === 'function') {
        root.BandarmologiRuntime.updateIntelSearchBarVisibility();
      }
      var intelContainer = byId('bandarmologiIntelContent') || byId('bandarmologiContent');
      var activeIntelTicker = (root.UnifiedCockpit && typeof root.UnifiedCockpit.getActiveTicker === 'function')
        ? root.UnifiedCockpit.getActiveTicker() : (root.activeTicker || 'BBCA');
      if (root.BandarmologiRuntime && typeof root.BandarmologiRuntime.loadBandarmologiIntel === 'function') {
        root.BandarmologiRuntime.loadBandarmologiIntel(activeIntelTicker, intelContainer);
      } else if (root.BandarmologiRuntime && typeof root.BandarmologiRuntime.renderBandarmologiIntelUI === 'function') {
        root.BandarmologiRuntime.renderBandarmologiIntelUI(intelContainer, activeIntelTicker);
      }
    } else if (parentTab === 'hunter') {
      if (!isSubscribedUser()) {
        var hunterTarget = byId('brokerHunterContent') || byId('bandarmologiContent');
        renderTabPaywall(hunterTarget ? hunterTarget.id : 'bandarmologiContent', 'Broker Hunter Terkunci', 'Akses pelacak broker institusi, smart money tracker, dan deteksi pergerakan broker asing hanya tersedia untuk member berlangganan.');
        return;
      }
      var hunterContainer = byId('brokerHunterContent') || byId('bandarmologiContent');
      if (root.BandarmologiRuntime && typeof root.BandarmologiRuntime.loadBrokerHunter === 'function') {
        root.BandarmologiRuntime.loadBrokerHunter(hunterContainer);
      }
    } else if (parentTab === 'insider') {
      if (!isSubscribedUser()) {
        var insiderTarget = byId('insiderNetworkDedicatedContent') || byId('bandarmologiContent');
        renderTabPaywall(insiderTarget ? insiderTarget.id : 'bandarmologiContent', 'Jejaring Insider Terkunci', 'Daftar Pemegang Saham lengkap, transaksi kepemilikan orang dalam, dan graf jejaring lintas emiten hanya tersedia untuk member berlangganan.');
        return;
      }
      var insiderContainer = byId('insiderNetworkDedicatedContent') || byId('bandarmologiContent');
      if (root.BandarmologiRuntime && typeof root.BandarmologiRuntime.loadInsiderNetwork === 'function') {
        root.BandarmologiRuntime.loadInsiderNetwork(insiderContainer);
      }
    } else if (parentTab === 'pattern') {
      if (!isAdminUser()) {
        renderTabPaywall('panel-tab-pattern', 'Pattern Radar Khusus Administrator', 'Fitur Pattern Radar dengan deteksi pola teknikal multi-frame saat ini hanya tersedia secara eksklusif untuk Administrator.', true);
        return;
      }
      loadPatternRadarTab();
    }
    } finally {
      _isSwitchingTab = false;
    }
  }

  function researchTicker(raw) {
    return String(raw || '').trim().toUpperCase().replace(/\.JK$/i, '').replace(/[^A-Z0-9]/g, '').slice(0, 6);
  }

  function researchText(id, value) {
    var el = byId(id);
    if (el) el.textContent = value == null || value === '' ? '-' : String(value);
  }

  function researchNumber(value, decimals) {
    if (!researchHasNumber(value)) return '-';
    var n = Number(value);
    if (!Number.isFinite(n)) return '-';
    try {
      return new Intl.NumberFormat('id-ID', {
        maximumFractionDigits: decimals == null ? 2 : decimals
      }).format(n);
    } catch (_) {
      return String(n);
    }
  }

  function researchIdr(value) {
    if (!researchHasNumber(value)) return '-';
    var n = Number(value);
    if (!Number.isFinite(n)) return '-';
    try {
      return new Intl.NumberFormat('id-ID', {
        style: 'currency',
        currency: 'IDR',
        maximumFractionDigits: 0
      }).format(n);
    } catch (_) {
      return 'Rp ' + Math.round(n).toLocaleString('id-ID');
    }
  }

  function researchCompact(value) {
    if (!researchHasNumber(value)) return '-';
    var n = Number(value);
    if (!Number.isFinite(n)) return '-';
    try {
      return new Intl.NumberFormat('id-ID', {
        notation: 'compact',
        compactDisplay: 'short',
        maximumFractionDigits: 2
      }).format(n);
    } catch (_) {
      return researchNumber(n, 0);
    }
  }

  var MARKET_STRUCTURE_LOW_FF_REFERENCE_PCT = 15;
  root.MARKET_STRUCTURE_LOW_FF_REFERENCE_PCT = MARKET_STRUCTURE_LOW_FF_REFERENCE_PCT;

  var ENUM_PRESENTATION_MAP = {
    'NORMAL': 'Normal',
    'CAUTION': 'Perhatian',
    'UNKNOWN': 'Belum diketahui',
    'STRUCTURE_VERIFIED': 'Struktur terverifikasi',
    'LOW_FREE_FLOAT': 'Free Float rendah',
    'HIGH_SHAREHOLDING_CONCENTRATION': 'Konsentrasi kepemilikan tinggi',
    'FREE_FLOAT_VERIFIED_HSC_UNKNOWN': 'Free Float terverifikasi, HSC belum diketahui',
    'HSC_VERIFIED_FREE_FLOAT_UNKNOWN': 'HSC terverifikasi, Free Float belum diketahui',
    'DATA_INCOMPLETE': 'Data belum lengkap',
    'NOT_EVALUATED': 'Tidak dievaluasi'
  };

  function formatEnumPresentation(val) {
    if (!val) return '-';
    var k = String(val).trim().toUpperCase();
    if (Object.prototype.hasOwnProperty.call(ENUM_PRESENTATION_MAP, k)) {
      return ENUM_PRESENTATION_MAP[k];
    }
    return 'Status belum dikenali';
  }

  var wibZoneOptions = { timeZone: 'Asia/Jakarta' };

  function formatIndonesianDateWithWib(isoStr) {
    if (!isoStr) return '-';
    if (typeof isoStr !== 'string') return String(isoStr);
    var cleanStr = String(isoStr).replace(/\s*WIB$/i, '').trim();
    if (!cleanStr || cleanStr === '-' || cleanStr === '—') return '-';
    var months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
    if (/^\d{4}-\d{2}-\d{2}$/.test(cleanStr)) {
      var parts = cleanStr.split('-');
      return parseInt(parts[2], 10) + ' ' + months[parseInt(parts[1], 10) - 1] + ' ' + parts[0];
    }
    var d = new Date(cleanStr);
    if (isNaN(d.getTime())) return cleanStr;
    var wibTime = new Date(d.getTime() + 7 * 60 * 60 * 1000);
    var day = wibTime.getUTCDate();
    var month = months[wibTime.getUTCMonth()];
    var year = wibTime.getUTCFullYear();
    var hasTime = cleanStr.indexOf('T') !== -1 && !cleanStr.endsWith('T00:00:00.000Z') && !cleanStr.endsWith('T00:00:00Z');
    if (hasTime || cleanStr.indexOf(':') !== -1) {
      var hh = ('0' + wibTime.getUTCHours()).slice(-2);
      var mm = ('0' + wibTime.getUTCMinutes()).slice(-2);
      return day + ' ' + month + ' ' + year + ', ' + hh + '.' + mm + ' WIB';
    }
    return day + ' ' + month + ' ' + year;
  }

  function formatSourceLabel(source) {
    if (!source) return 'Belum tersedia';
    var s = String(source).trim();
    switch (s) {
      case 'arjum financial-statements':
        return 'Laporan Keuangan Resmi BEI';
      case 'sqlite_market_rows':
      case 'daily_candles_flat_file':
      case 'daily_candles':
      case 'stock_daily_history':
        return 'Data Harian Penutupan BEI';
      case 'IDX calculated':
        return 'Kalkulasi BEI';
      case 'calculated (shares_outstanding * last_price)':
        return 'Kalkulasi Otomatis (Saham x Harga Penutupan)';
      case 'stock_fundamentals':
        return 'Basis Data Fundamental BEI';
      case 'KSEI':
        return 'KSEI';
      default:
        return s;
    }
  }

  function formatIndonesianSharesCount(val) {
    if (!researchHasNumber(val)) return '-';
    var n = Number(val);
    if (n >= 1e12) {
      return (n / 1e12).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' T lembar';
    }
    if (n >= 1e9) {
      return (n / 1e9).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' Mrd lembar';
    }
    if (n >= 1e6) {
      return (n / 1e6).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' Jt lembar';
    }
    return n.toLocaleString('id-ID') + ' lembar';
  }

  function formatIndonesianMarketCap(val) {
    if (!researchHasNumber(val)) return '-';
    var n = Number(val);
    if (n >= 1e12) {
      return 'Rp ' + (n / 1e12).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' T';
    }
    if (n >= 1e9) {
      return 'Rp ' + (n / 1e9).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' Mrd';
    }
    if (n >= 1e6) {
      return 'Rp ' + (n / 1e6).toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' Jt';
    }
    return 'Rp ' + n.toLocaleString('id-ID');
  }

  function formatMarketStructureStatus(status) {
    switch (status) {
      case 'STRUCTURE_VERIFIED': return 'Struktur Terverifikasi';
      case 'HIGH_SHAREHOLDING_CONCENTRATION': return 'Konsentrasi Kepemilikan Tinggi';
      case 'LOW_FREE_FLOAT': return 'Free Float Rendah';
      case 'DATA_INCOMPLETE': return 'Data Belum Lengkap';
      case 'NORMAL': return 'Normal';
      case 'CAUTION': return 'Perhatian';
      case 'WATCHLIST': return 'Pantauan';
      case 'NOT_EVALUATED': return 'Belum Dievaluasi';
      default: return status ? String(status).replace(/_/g, ' ') : 'Belum Dievaluasi';
    }
  }

  function formatMarketStructureGuard(guard) {
    switch (guard) {
      case 'NORMAL': return 'Normal';
      case 'CAUTION': return 'Perhatian';
      case 'RESTRICTED': return 'Terbatas';
      case 'HIGH_RISK': return 'Risiko Tinggi';
      case 'UNKNOWN':
      case 'NOT_EVALUATED': return 'Belum Dievaluasi';
      default: return guard ? String(guard).replace(/_/g, ' ') : 'Belum Dievaluasi';
    }
  }

  function formatComplianceStatus(status) {
    switch (status) {
      case 'NOT_EVALUATED': return 'Belum Dievaluasi';
      case 'COMPLIANT': return 'Memenuhi Acuan';
      case 'NON_COMPLIANT': return 'Di Bawah Acuan';
      default: return status ? String(status).replace(/_/g, ' ') : 'Belum Dievaluasi';
    }
  }

  function formatHscStatus(flag, asOf) {
    if (!asOf) return 'Belum Terverifikasi';
    if (flag === true) return 'HSC Aktif';
    if (flag === false) return 'Tidak Terindikasi HSC';
    return 'Belum Terverifikasi';
  }

  function researchHasNumber(value) {
    return value != null && String(value).trim() !== '' && Number.isFinite(Number(value));
  }

  // ===== FINANCIAL STATEMENTS CONTROLLER (WAVE 4B, §79.2, §26) =====
  var AutoCuanFinancialStatements = {
    activeMode: 'income', // 'income' | 'balance' | 'cashflow' | 'ratios'
    activePeriod: 'quarterly', // 'quarterly' | 'annual'
    currentTicker: null,
    statementsData: null,

    setStatementMode: function (mode) {
      if (!mode) return;
      this.activeMode = mode;
      var group = byId('financialStatementModeGroup');
      if (group) {
        var btns = group.querySelectorAll('button[data-statement-mode]');
        btns.forEach(function (btn) {
          var isTarget = btn.getAttribute('data-statement-mode') === mode;
          if (isTarget) {
            btn.classList.add('is-active');
            btn.setAttribute('aria-selected', 'true');
            btn.setAttribute('tabindex', '0');
          } else {
            btn.classList.remove('is-active');
            btn.setAttribute('aria-selected', 'false');
            btn.setAttribute('tabindex', '-1');
          }
        });
      }
      this.renderTable();
    },

    setPeriodMode: function (period) {
      if (!period) return;
      this.activePeriod = period;
      var group = byId('financialPeriodModeGroup');
      if (group) {
        var btns = group.querySelectorAll('button[data-period-mode]');
        btns.forEach(function (btn) {
          var isTarget = btn.getAttribute('data-period-mode') === period;
          if (isTarget) {
            btn.classList.add('is-active');
            btn.setAttribute('aria-pressed', 'true');
          } else {
            btn.classList.remove('is-active');
            btn.setAttribute('aria-pressed', 'false');
          }
        });
      }
      this.renderTable();
    },

    loadStatements: function (ticker, context) {
      this.currentTicker = ticker;
      this.statementsData = this.normalizeStatements(context);
      this.renderTable();
    },

    normalizeStatements: function (context) {
      if (!context) return null;
      var raw = context.financial_statements || context.statements || (context.fundamental && context.fundamental.statements) || null;
      if (!raw) return null;

      return {
        quarterly: raw.quarterly || null,
        annual: raw.annual || null,
        source: raw.source || (context.fundamental && context.fundamental.fundamental_source) || 'IDX Financial Statement',
        updated_at: raw.updated_at || (context.fundamental && context.fundamental.fundamental_updated_at) || null
      };
    },

    renderTable: function () {
      var wrap = byId('financialStatementsTableWrap');
      var unavailable = byId('financialStatementUnavailable');
      var unavailTitle = byId('financialStatementUnavailableTitle');
      var unavailDesc = byId('financialStatementUnavailableDesc');
      var thead = byId('financialStatementsTableHead');
      var tbody = byId('financialStatementsTableBody');

      var catLabel = byId('financialStatementCategoryLabel');
      var freqLabel = byId('financialStatementFrequencyLabel');
      var unitLabel = byId('financialStatementUnitLabel');

      var mode = this.activeMode;
      var period = this.activePeriod;

      var modeName = mode === 'income' ? 'Laba Rugi' : (mode === 'balance' ? 'Neraca' : (mode === 'cashflow' ? 'Arus Kas' : 'Rasio'));
      var natureLabel = mode === 'balance' ? 'Posisi Akhir Periode' : (mode === 'ratios' ? 'Valuasi & Profitabilitas' : (period === 'quarterly' ? 'Kuartal Diskret / Kumulatif Berjalan' : 'Kumulatif 12 Bulan'));
      var periodName = period === 'quarterly' ? ('Kuartalan (' + natureLabel + ')') : ('Tahunan (' + natureLabel + ')');

      if (catLabel) catLabel.textContent = modeName;
      if (freqLabel) freqLabel.textContent = periodName;
      if (unitLabel) unitLabel.textContent = mode === 'ratios' ? 'Rasio & Kelipatan (x, %)' : 'Miliar IDR (kecuali rasio & EPS)';

      var periodData = this.statementsData ? this.statementsData[period] : null;
      var statementKey = mode === 'income' ? 'income_statement' : (mode === 'balance' ? 'balance_sheet' : (mode === 'cashflow' ? 'cash_flow' : 'ratios'));
      var statement = periodData ? (periodData[statementKey] || (mode === 'ratios' ? periodData.ratios : null)) : null;

      var hasData = statement && Array.isArray(statement.rows) && statement.rows.length > 0 && Array.isArray(statement.periods) && statement.periods.length > 0;

      if (!hasData) {
        if (wrap) wrap.hidden = true;
        if (unavailable) {
          unavailable.hidden = false;
          if (unavailTitle) unavailTitle.textContent = 'Data ' + modeName + ' rinci belum tersedia';
          if (unavailDesc) unavailDesc.textContent = 'Laporan keuangan kuartalan/tahunan belum dipublikasikan oleh emiten pada feed bursa resmi. Data valuasi dihitung dari harga pasar dan snapshot fundamental terkini.';
        }
        return;
      }

      if (unavailable) unavailable.hidden = true;
      if (wrap) wrap.hidden = false;

      // Render <thead>
      if (thead) {
        var headerHtml = '<tr><th scope="col" style="text-align: left;">Komponen</th>';
        statement.periods.forEach(function (p) {
          headerHtml += '<th scope="col" style="font-variant-numeric: tabular-nums;">' + escapeHtml(p) + '</th>';
        });
        headerHtml += '</tr>';
        thead.innerHTML = headerHtml;
      }

      // Render <tbody>
      if (tbody) {
        tbody.innerHTML = '';
        var frag = document.createDocumentFragment();

        statement.rows.forEach(function (row) {
          var tr = document.createElement('tr');
          if (row.type === 'group') {
            tr.className = 'ac-fin-row-group';
            var td = document.createElement('td');
            td.setAttribute('colspan', String(statement.periods.length + 1));
            var stickyDiv = document.createElement('div');
            stickyDiv.className = 'ac-fin-group-label-sticky';
            var span = document.createElement('span');
            span.className = 'ac-fin-group-title';
            span.textContent = (row.label && row.label.startsWith('▸') ? '' : '▸ ') + row.label;
            stickyDiv.appendChild(span);
            td.appendChild(stickyDiv);
            tr.appendChild(td);
          } else {
            tr.className = row.type === 'total' ? 'ac-fin-row-total' : 'ac-fin-row-child';
            var tdLabel = document.createElement('td');
            tdLabel.textContent = row.label;
            tr.appendChild(tdLabel);

            var values = Array.isArray(row.values) ? row.values : [];
            for (var i = 0; i < statement.periods.length; i++) {
              var val = values[i];
              var tdVal = document.createElement('td');
              tdVal.className = 'ac-num ac-fin-cell-num';
              tdVal.style.fontVariantNumeric = 'tabular-nums';

              var isMissing = val == null || val === '—' || val === '-' || val === '';
              var isFalseZeroEps = val === 0 && row.label && row.label.indexOf('EPS') !== -1;
              if (isMissing || isFalseZeroEps) {
                tdVal.textContent = '-';
                tdVal.style.color = 'var(--ac-text-muted)';
              } else if (typeof val === 'number') {
                var isNegative = val < 0;
                var formatted = '';
                if (row.unit === 'pct' || row.unit === '%') {
                  formatted = val.toFixed(2) + '%';
                } else if (row.unit === 'x') {
                  formatted = val.toFixed(2) + 'x';
                } else if (row.unit === 'idr' || row.unit === 'currency') {
                  formatted = (isNegative ? '(' : '') + Math.abs(val).toLocaleString('id-ID') + (isNegative ? ')' : '');
                } else {
                  formatted = (isNegative ? '(' : '') + Math.abs(val).toLocaleString('id-ID') + (isNegative ? ')' : '');
                }

                if (isNegative) {
                  tdVal.innerHTML = '<span class="ac-fin-negative">' + escapeHtml(formatted) + '</span>';
                } else {
                  // Normal positive ink - never globally forced green!
                  tdVal.textContent = formatted;
                }
              } else {
                var strVal = String(val);
                if (strVal.startsWith('-') || strVal.startsWith('(')) {
                  tdVal.innerHTML = '<span class="ac-fin-negative">' + escapeHtml(strVal) + '</span>';
                } else {
                  tdVal.textContent = strVal;
                }
              }

              tr.appendChild(tdVal);
            }
          }
          frag.appendChild(tr);
        });

        tbody.appendChild(frag);
      }

      var wrap = byId('financialStatementsTableWrap');
      var hint = byId('financialScrollHint');
      if (wrap && hint && typeof wrap.addEventListener === 'function' && !wrap._hasScrollHintListener) {
        wrap._hasScrollHintListener = true;
        wrap.addEventListener('scroll', function () {
          if (wrap.scrollLeft > 24) {
            hint.classList.add('is-scrolled');
          } else {
            hint.classList.remove('is-scrolled');
          }
        }, { passive: true });
      }
    }
  };
  root.AutoCuanFinancialStatements = AutoCuanFinancialStatements;

  if (typeof document !== 'undefined') {
    var initTablistNav = function () {
      var stmtGroup = byId('financialStatementModeGroup');
      if (stmtGroup && typeof stmtGroup.addEventListener === 'function' && !stmtGroup._hasKeyNav) {
        stmtGroup._hasKeyNav = true;
        stmtGroup.addEventListener('keydown', function (e) {
          if (!e || (e.key !== 'ArrowRight' && e.key !== 'ArrowLeft')) return;
          if (typeof stmtGroup.querySelectorAll !== 'function') return;
          var tabs = Array.from(stmtGroup.querySelectorAll('button[data-statement-mode]'));
          var activeTab = typeof stmtGroup.querySelector === 'function' ? stmtGroup.querySelector('button[data-statement-mode].is-active') : null;
          var idx = tabs.indexOf(activeTab);
          if (idx === -1) return;
          if (typeof e.preventDefault === 'function') e.preventDefault();
          var nextIdx = e.key === 'ArrowRight' ? (idx + 1) % tabs.length : (idx - 1 + tabs.length) % tabs.length;
          var nextTab = tabs[nextIdx];
          if (nextTab) {
            if (typeof nextTab.focus === 'function') nextTab.focus();
            var mode = nextTab.getAttribute('data-statement-mode');
            AutoCuanFinancialStatements.setStatementMode(mode);
          }
        });
      }
    };
    if (document.readyState === 'loading' && typeof document.addEventListener === 'function') {
      document.addEventListener('DOMContentLoaded', initTablistNav);
    } else {
      initTablistNav();
    }
  }

  var financialSnapshotCache = {};
  var researchGeneration = 0;
  var financialCache = {};
  var financialRenderedTicker = null;

  var marketStructureUniverse = [];
  var marketStructureFilter = 'all';
  var marketStructureSort = 'ticker_asc';
  var marketStructureSearchQuery = '';
  var marketStructureSelectedTicker = null;
  var marketStructureLoading = false;
  var marketStructureLastFocusedElement = null;
  var marketStructureUniverseLoaded = false;
  var marketStructureBoundEvents = false;
  var marketStructureDetailToken = 0;
  var marketStructureSectorFilter = 'all';
  var marketStructureSearchDebounce = null;

  function formatIndonesianNumber(num) {
    if (num == null) return '-';
    var n = Number(num);
    if (!Number.isFinite(n)) return '-';
    return n.toLocaleString('id-ID');
  }

  function formatSectorIndonesian(sector) {
    if (!sector) return '-';
    var s = String(sector).trim();
    var map = {
      'Finance': 'Keuangan',
      'Financials': 'Keuangan',
      'Energy': 'Energi',
      'Infrastructures': 'Infrastruktur',
      'Infrastructure': 'Infrastruktur',
      'Infrastrucures': 'Infrastruktur',
      'Basic Mat': 'Barang Baku',
      'Basic Materials': 'Barang Baku',
      'Technology': 'Teknologi',
      'Health': 'Kesehatan',
      'Healthcare': 'Kesehatan',
      'Property': 'Properti',
      'Properties & Real Estate': 'Properti',
      'Properties &amp; Real Estate': 'Properti',
      'Cyclical': 'Konsumer Siklikal',
      'Consumer Cyclicals': 'Konsumer Siklikal',
      'Non-Cyclical': 'Konsumer Non-Siklikal',
      'Consumer Non-Cyclicals': 'Konsumer Non-Siklikal',
      'Industrial': 'Perindustrian',
      'Industrials': 'Perindustrian',
      'Transport': 'Transportasi',
      'Transportation': 'Transportasi',
      'Transportation & Logistics': 'Transportasi',
      'Transportation &amp; Logistics': 'Transportasi'
    };
    return map[s] || s;
  }

  function formatInvestorCategoryIndonesian(type, origin) {
    var originStr = (origin === 'D') ? 'Domestik' : ((origin === 'F' || origin === 'A') ? 'Asing' : '');
    var baseType = String(type || 'Pemegang Saham').trim();
    if (/^Corporate$/i.test(baseType)) baseType = 'Korporasi';
    else if (/^Individual$/i.test(baseType)) baseType = 'Individu';
    else if (/^Private Equity$/i.test(baseType)) baseType = 'Private Equity';
    else if (/^Institusi$/i.test(baseType)) baseType = 'Institusi';
    else if (/^Pengendali$/i.test(baseType)) baseType = 'Pengendali';
    else if (/^Investor Strategis$/i.test(baseType)) baseType = 'Investor Strategis';
    else if (!baseType || baseType === 'null' || baseType === 'undefined') baseType = 'Pemegang Saham';

    if (originStr) {
      return baseType + ' (' + originStr + ')';
    }
    return baseType;
  }

  function matchesSectorFilter(itemSector, targetSector) {
    if (!targetSector || targetSector === 'all') return true;
    var sec = String(itemSector || '').trim().toLowerCase();
    var tgt = String(targetSector).trim().toLowerCase();
    if (sec === tgt) return true;
    if (tgt === 'basic materials' && (sec.includes('basic mat') || sec.includes('material'))) return true;
    if (tgt === 'consumer cyclicals' && (sec === 'cyclical' || (sec.includes('cyclical') && !sec.includes('non')))) return true;
    if (tgt === 'consumer non-cyclicals' && (sec === 'non-cyclical' || sec.includes('non-cyclical') || sec.includes('non cyclical'))) return true;
    if (tgt === 'energy' && sec.includes('energy')) return true;
    if (tgt === 'financials' && (sec === 'finance' || sec.includes('finan'))) return true;
    if (tgt === 'healthcare' && (sec === 'health' || sec.includes('health'))) return true;
    if (tgt === 'industrials' && (sec === 'industrial' || sec.includes('industr'))) return true;
    if (tgt === 'infrastructures' && (sec.includes('infrastruc') || sec.includes('infra'))) return true;
    if (tgt === 'properties & real estate' && (sec === 'property' || sec.includes('prop') || sec.includes('real estate'))) return true;
    if (tgt === 'technology' && sec.includes('tech')) return true;
    if (tgt === 'transportation & logistics' && (sec === 'transport' || sec.includes('transport') || sec.includes('logist'))) return true;
    return false;
  }

  function getFilteredMarketStructureItems() {
    var items = marketStructureUniverse.slice();

    // 1. Search Query filter (Ticker or Company Name)
    if (marketStructureSearchQuery) {
      var q = marketStructureSearchQuery.trim().toUpperCase();
      items = items.filter(function (it) {
        var tMatch = it.ticker && it.ticker.toUpperCase().includes(q);
        var nMatch = (it.name && String(it.name).toUpperCase().includes(q)) ||
          (it.company_name && String(it.company_name).toUpperCase().includes(q));
        return tMatch || nMatch;
      });
    }

    // 2. Sector Dropdown filter
    if (marketStructureSectorFilter && marketStructureSectorFilter !== 'all') {
      items = items.filter(function (it) {
        return matchesSectorFilter(it.sector, marketStructureSectorFilter);
      });
    }

    // 3. Category Chip filter
    if (marketStructureFilter === 'low-ff' || marketStructureFilter === 'low_ff') {
      // Strict < reference rule: only valid numbers where free_float_pct < MARKET_STRUCTURE_LOW_FF_REFERENCE_PCT.
      items = items.filter(function (it) {
        return researchHasNumber(it.free_float_pct) && Number(it.free_float_pct) < MARKET_STRUCTURE_LOW_FF_REFERENCE_PCT;
      });
    } else if (marketStructureFilter === 'hsc') {
      // Explicitly flagged HSC only
      items = items.filter(function (it) {
        return it.hsc_flag === true;
      });
    } else if (marketStructureFilter === 'incomplete') {
      // INCOMPLETE_RECORD_RULE
      items = items.filter(function (it) {
        return it.free_float_pct == null ||
          it.hsc_flag == null ||
          it.market_structure_status === 'DATA_INCOMPLETE' ||
          it.market_structure_guard === 'UNKNOWN';
      });
    }

    // 4. Sorting
    items.sort(function (a, b) {
      if (marketStructureSort === 'free_float_asc') {
        var aHas = researchHasNumber(a.free_float_pct);
        var bHas = researchHasNumber(b.free_float_pct);
        if (aHas && bHas) {
          var diff = Number(a.free_float_pct) - Number(b.free_float_pct);
          if (diff !== 0) return diff;
          return a.ticker.localeCompare(b.ticker);
        }
        // Missing free float values MUST sort LAST
        if (aHas && !bHas) return -1;
        if (!aHas && bHas) return 1;
        return a.ticker.localeCompare(b.ticker);
      } else if (marketStructureSort === 'free_float_desc') {
        var aHas2 = researchHasNumber(a.free_float_pct);
        var bHas2 = researchHasNumber(b.free_float_pct);
        if (aHas2 && bHas2) {
          var diff2 = Number(b.free_float_pct) - Number(a.free_float_pct);
          if (diff2 !== 0) return diff2;
          return a.ticker.localeCompare(b.ticker);
        }
        if (aHas2 && !bHas2) return -1;
        if (!aHas2 && bHas2) return 1;
        return a.ticker.localeCompare(b.ticker);
      } else if (marketStructureSort === 'ticker_asc') {
        return a.ticker.localeCompare(b.ticker);
      } else if (marketStructureSort === 'ticker_desc') {
        return b.ticker.localeCompare(a.ticker);
      } else if (marketStructureSort === 'investor_desc') {
        var aCount = a.investor_count != null ? Number(a.investor_count) : -1;
        var bCount = b.investor_count != null ? Number(b.investor_count) : -1;
        if (aCount !== bCount) return bCount - aCount;
        return a.ticker.localeCompare(b.ticker);
      } else if (marketStructureSort === 'investor_asc') {
        var aCount2 = a.investor_count != null ? Number(a.investor_count) : 999999;
        var bCount2 = b.investor_count != null ? Number(b.investor_count) : 999999;
        if (aCount2 !== bCount2) return aCount2 - bCount2;
        return a.ticker.localeCompare(b.ticker);
      } else if (marketStructureSort === 'hsc_first') {
        // Flagged (true) -> 0, Non-flagged (false) -> 1, Unknown (null/other) -> 2
        var aRank = a.hsc_flag === true ? 0 : (a.hsc_flag === false ? 1 : 2);
        var bRank = b.hsc_flag === true ? 0 : (b.hsc_flag === false ? 1 : 2);
        if (aRank !== bRank) return aRank - bRank;
        return a.ticker.localeCompare(b.ticker);
      }
      return 0;
    });

    return items;
  }

  async function loadAccordionRoster(ticker, contentEl, item) {
    if (!ticker || !contentEl) return;
    var clean = ticker.trim().toUpperCase();

    // 1. Direct render from embedded investors if available in dataset
    if (item && Array.isArray(item.investors) && item.investors.length > 0) {
      marketStructureRosterCache[clean] = item.investors;
      renderAccordionRosterTable(clean, item.investors, contentEl);
      return;
    }

    // 2. Check local memory cache
    var roster = marketStructureRosterCache[clean];
    if (roster) {
      renderAccordionRosterTable(clean, roster, contentEl);
      return;
    }

    contentEl.innerHTML = '<div class="py-3 text-center text-xs text-slate-400"><span class="spinner-sm"></span> Memuat rincian pemegang saham ' + escapeHtml(clean) + '…</div>';
    try {
      var res = await fetch('/api/sector-hot?action=insider-roster&ticker=' + encodeURIComponent(clean), {
        credentials: 'same-origin',
        cache: 'no-store'
      });
      if (!res.ok) {
        contentEl.innerHTML = '<div class="py-3 text-center text-xs text-rose-400">Gagal memuat rincian pemegang saham (HTTP ' + res.status + ')</div>';
        return;
      }
      var data = await res.json().catch(function () { return null; });
      if (!data || data.success !== true || !Array.isArray(data.roster)) {
        contentEl.innerHTML = '<div class="py-3 text-center text-xs text-slate-400">Data pemegang saham belum dilaporkan pada feed resmi bursa.</div>';
        return;
      }
      marketStructureRosterCache[clean] = data.roster;
      renderAccordionRosterTable(clean, data.roster, contentEl);
    } catch (err) {
      contentEl.innerHTML = '<div class="py-3 text-center text-xs text-rose-400">Koneksi bermasalah: ' + escapeHtml((err && err.message) || 'Error') + '</div>';
    }
  }

  function renderAccordionRosterTable(ticker, roster, contentEl) {
    if (!contentEl) return;
    if (!roster || roster.length === 0) {
      contentEl.innerHTML = '<div class="ac-accordion-empty py-3 text-center text-xs">Data pemegang saham belum dilaporkan pada feed resmi bursa.</div>';
      return;
    }

    var rowsHtml = roster.map(function (inv, idx) {
      var originVal = inv.origin || inv.localForeign || inv.local_foreign || 'D';
      var originBadge = (originVal === 'D')
        ? '<span class="ac-origin-badge ac-origin-d">D</span>'
        : '<span class="ac-origin-badge ac-origin-f">F</span>';

      var sharesNum = inv.totalHoldingShare != null ? inv.totalHoldingShare : (inv.shares || 0);
      var sharesStr = formatIndonesianNumber(sharesNum);
      var pctNum = inv.percentage != null ? Number(inv.percentage) : null;
      var pctStr = pctNum != null && Number.isFinite(pctNum) ? pctNum.toFixed(2) + '%' : (inv.percentage_formatted || '-');

      return '<tr class="ac-roster-row">' +
        '<td class="ac-roster-num">' + (idx + 1) + '</td>' +
        '<td class="ac-roster-name">' + escapeHtml(String(inv.investorName || inv.name || '-').toUpperCase()) + '</td>' +
        '<td class="ac-roster-type">' + escapeHtml(inv.investorType || inv.type || inv.category || '-') + '</td>' +
        '<td class="ac-roster-center">' + originBadge + '</td>' +
        '<td class="ac-roster-type">' + escapeHtml(inv.domicile || '-') + '</td>' +
        '<td class="ac-roster-shares">' + sharesStr + '</td>' +
        '<td class="ac-roster-pct">' + pctStr + '</td>' +
      '</tr>';
    }).join('');

    contentEl.innerHTML = '<div class="ac-roster-wrap">' +
      '<table class="ac-roster-table">' +
        '<thead>' +
          '<tr>' +
            '<th scope="col">#</th>' +
            '<th scope="col">Nama Investor</th>' +
            '<th scope="col">Tipe</th>' +
            '<th scope="col" class="ac-roster-center">Asal (D/F)</th>' +
            '<th scope="col">Domisili</th>' +
            '<th scope="col" class="ac-roster-shares">Lembar Saham</th>' +
            '<th scope="col" class="ac-roster-pct">Persentase (%)</th>' +
          '</tr>' +
        '</thead>' +
        '<tbody>' + rowsHtml + '</tbody>' +
      '</table>' +
    '</div>';
  }

  function renderMarketStructureAccordion(items) {
    var acc = byId('marketStructureAccordionContainer');
    if (!acc) return;
    acc.hidden = false;

    if (items.length === 0) {
      acc.innerHTML = '<div class="py-12 text-center text-xs text-slate-400">Tidak ada saham yang sesuai dengan filter atau pencarian.</div>';
      return;
    }

    var html = items.map(function (item) {
      var isExpanded = marketStructureSelectedTicker && marketStructureSelectedTicker.toUpperCase() === item.ticker.toUpperCase();
      var ffVal = item.freeFloat != null ? item.freeFloat : item.free_float_pct;
      var ffStr = (ffVal != null && Number.isFinite(Number(ffVal))) ? Number(ffVal).toFixed(2).replace('.', ',') + '%' : '—';
      var compName = item.name || item.company_name || ('PT ' + item.ticker + ' Tbk');
      var invCount = item.investorCount != null ? item.investorCount : (item.investor_count != null ? item.investor_count : (item.investors ? item.investors.length : '-'));
      var sectorStr = item.sector || '-';

      var hscBadge = '';
      if (item.hsc_flag === true) {
        hscBadge = '<span class="ac-badge ac-badge-warning text-[10px] font-bold px-1.5 py-0.5 rounded whitespace-nowrap">HSC Aktif</span>';
      } else if (item.hsc_flag === false) {
        hscBadge = '<span class="ac-badge ac-badge-neutral text-[10px] font-bold px-1.5 py-0.5 rounded whitespace-nowrap">Non-HSC</span>';
      } else if (item.hsc_flag != null || item.as_of_trade_date) {
        hscBadge = '<span class="ac-badge ac-badge-dim text-[10px] font-bold px-1.5 py-0.5 rounded whitespace-nowrap">Belum terverifikasi</span>';
      }

      return '<div class="ac-accordion-card' + (isExpanded ? ' is-expanded' : '') + '" data-ticker="' + escapeHtml(item.ticker) + '">' +
        '<div class="ac-accordion-header cursor-pointer" tabindex="0" role="button" aria-expanded="' + (isExpanded ? 'true' : 'false') + '" aria-label="Lihat pemegang saham ' + escapeHtml(item.ticker) + '">' +
          '<div class="flex items-center gap-2.5 min-w-0 flex-1">' +
            '<span class="px-2 py-0.5 rounded font-mono font-bold text-xs bg-emerald-500/20 text-emerald-400 border border-emerald-500/30 shrink-0">' + escapeHtml(item.ticker) + '</span>' +
            '<span class="font-bold text-slate-100 text-xs truncate">' + escapeHtml(compName) + '</span>' +
          '</div>' +
          '<div class="flex items-center gap-2 ml-auto shrink-0 flex-wrap">' +
            hscBadge +
            '<span class="text-[11px] font-mono px-2 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700/60 whitespace-nowrap">' + invCount + ' Investor</span>' +
            '<span class="text-[11px] font-mono px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/25 whitespace-nowrap">Free Float (' + ffStr + ')</span>' +
            '<span class="text-[11px] px-2 py-0.5 rounded bg-slate-800/80 text-slate-400 border border-slate-700/40 whitespace-nowrap">' + escapeHtml(sectorStr) + '</span>' +
            '<svg class="w-4 h-4 text-slate-400 ac-accordion-chevron transition-transform" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M19 9l-7 7-7-7"/></svg>' +
          '</div>' +
        '</div>' +
        '<div class="ac-accordion-content"' + (isExpanded ? '' : ' hidden') + '>' +
          '<div class="ac-accordion-placeholder py-3 text-center text-xs text-slate-400"><span class="spinner-sm"></span> Memuat…</div>' +
        '</div>' +
      '</div>';
    }).join('');

    acc.innerHTML = html;

    // Attach click and keydown listeners to each card header
    var cards = acc.querySelectorAll('.ac-accordion-card');
    cards.forEach(function (card) {
      var t = card.getAttribute('data-ticker');
      var header = card.querySelector('.ac-accordion-header');
      var content = card.querySelector('.ac-accordion-content');
      var item = items.find(function(it) { return it.ticker && it.ticker.toUpperCase() === t.toUpperCase(); });

      // The accordion is self-contained: expanding renders the holder table
      // inside the card and never opens the docked pane or the mobile sheet.
      // Those two surfaces belong to the retired table-first layout and are
      // suppressed in CSS so the list can use the full working width.
      function toggleCard() {
        var willExpand = content.hidden;
        if (willExpand) {
          content.hidden = false;
          card.classList.add('is-expanded');
          header.setAttribute('aria-expanded', 'true');
          marketStructureSelectedTicker = t;
          var pane = byId('marketStructureDetailPane');
          if (pane) { pane.hidden = true; pane.style.display = 'none'; }
          loadAccordionRoster(t, content, item);
        } else {
          content.hidden = true;
          card.classList.remove('is-expanded');
          header.setAttribute('aria-expanded', 'false');
        }
        // Keyboard users must keep their place in the list after toggling.
        try { header.focus({ preventScroll: true }); } catch (_) { header.focus(); }
      }

      header.addEventListener('click', toggleCard);
      header.addEventListener('keydown', function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggleCard();
        } else if (e.key === 'Escape') {
          if (!content.hidden) {
            e.preventDefault();
            content.hidden = true;
            card.classList.remove('is-expanded');
            header.setAttribute('aria-expanded', 'false');
          }
        }
      });

      if (card.classList.contains('is-expanded')) {
        loadAccordionRoster(t, content, item);
      }
    });
  }

  function renderMarketStructureTable() {
    var items = getFilteredMarketStructureItems();
    renderMarketStructureAccordion(items);
  }

  function populateMarketStructureDetail(item) {
    if (!item) return;

    var ffText = researchHasNumber(item.free_float_pct) ? researchNumber(item.free_float_pct, 2) + '%' : '-';
    var ffAsOfText = item.free_float_as_of ? 'As of ' + item.free_float_as_of : 'As of -';
    var hscText = item.hsc_flag === true ? 'HSC Aktif' : (item.hsc_flag === false ? 'Non-HSC' : 'Belum terverifikasi');
    var hscAsOfText = item.hsc_as_of ? 'As of ' + item.hsc_as_of : 'As of -';
    var guardText = formatEnumPresentation(item.market_structure_guard);
    var statusText = formatEnumPresentation(item.market_structure_status);
    var ffSourceText = item.free_float_source || 'Belum tersedia';
    var hscSourceText = item.hsc_source || 'Belum tersedia';
    var refPct = researchHasNumber(item.low_free_float_reference_pct) ? Number(item.low_free_float_reference_pct) : MARKET_STRUCTURE_LOW_FF_REFERENCE_PCT;
    var refText = refPct + '%';
    var complianceText = formatEnumPresentation(item.regulatory_compliance_status);
    var noteText = item.market_structure_note || 'Data struktur pasar belum lengkap.';

    // Desktop elements
    researchText('marketStructureDetailTickerBadge', item.ticker);
    researchText('marketStructureDetailTitle', 'Detail Struktur ' + item.ticker);
    researchText('marketStructureFreeFloat', ffText);
    researchText('marketStructureFreeFloatAsOf', ffAsOfText);
    researchText('marketStructureHsc', hscText);
    researchText('marketStructureHscAsOf', hscAsOfText);
    researchText('marketStructureGuard', guardText);
    researchText('marketStructureStatus', statusText);
    researchText('marketStructureFreeFloatSource', ffSourceText);
    researchText('marketStructureHscSource', hscSourceText);
    researchText('marketStructureReference', refText);
    researchText('marketStructureCompliance', complianceText);
    researchText('marketStructureNote', noteText);

    // Mobile sheet elements (Dedicated IDs to prevent duplicate IDs in DOM)
    researchText('marketStructureSheetTickerBadge', item.ticker);
    researchText('marketStructureSheetTitle', 'Detail Struktur Pasar - ' + item.ticker);
    researchText('marketStructureSheetFreeFloat', ffText);
    researchText('marketStructureSheetFreeFloatAsOf', ffAsOfText);
    researchText('marketStructureSheetHsc', hscText);
    researchText('marketStructureSheetHscAsOf', hscAsOfText);
    researchText('marketStructureSheetGuard', guardText);
    researchText('marketStructureSheetStatus', statusText);
    researchText('marketStructureSheetFreeFloatSource', ffSourceText);
    researchText('marketStructureSheetHscSource', hscSourceText);
    researchText('marketStructureSheetReference', refText);
    researchText('marketStructureSheetCompliance', complianceText);
    researchText('marketStructureSheetNote', noteText);

    var content = byId('marketStructureDataContent');
    if (content) content.hidden = false;
  }

  function openMarketStructureMobileSheet(ticker) {
    var sheet = byId('marketStructureDetailSheet');
    if (!sheet) return;
    sheet.hidden = false;
    sheet.classList.add('is-open');

    var mobSheet = byId('marketStructureMobileSheet');
    if (mobSheet) mobSheet.classList.add('is-open');

    var bgWrapper = byId('marketStructureBackgroundWrapper') || byId('marketStructureMainRegion');
    if (bgWrapper) {
      bgWrapper.setAttribute('aria-hidden', 'true');
      try { bgWrapper.inert = true; } catch (_) {}
    }

    var closeBtn = byId('marketStructureSheetClose') || byId('marketStructureSheetCloseBtn');
    if (closeBtn && typeof closeBtn.focus === 'function') {
      try { closeBtn.focus(); } catch (_) {}
    }
  }

  function closeMarketStructureMobileSheet() {
    var sheet = byId('marketStructureDetailSheet');
    if (!sheet) return;
    sheet.hidden = true;
    sheet.classList.remove('is-open');

    var mobSheet = byId('marketStructureMobileSheet');
    if (mobSheet) mobSheet.classList.remove('is-open');

    var bgWrapper = byId('marketStructureBackgroundWrapper') || byId('marketStructureMainRegion');
    if (bgWrapper) {
      bgWrapper.removeAttribute('aria-hidden');
      try { bgWrapper.inert = false; } catch (_) {}
    }
  }

  function selectMarketStructureRow(ticker, originElement, syncCockpit) {
    if (!ticker) return;
    ticker = ticker.trim().toUpperCase();
    marketStructureSelectedTicker = ticker;
    if (originElement) {
      marketStructureLastFocusedElement = originElement;
    }

    var tbody = byId('marketStructureTableBody');
    if (tbody) {
      var rows = tbody.querySelectorAll('tr[data-ticker]');
      rows.forEach(function (row) {
        var isThis = row.getAttribute('data-ticker') === ticker;
        if (isThis) {
          row.classList.add('is-selected');
          row.setAttribute('aria-pressed', 'true');
        } else {
          row.classList.remove('is-selected');
          row.setAttribute('aria-pressed', 'false');
        }
      });
    }

    var item = marketStructureUniverse.find(function (it) {
      return it.ticker && it.ticker.toUpperCase() === ticker;
    });

    if (item) {
      populateMarketStructureDetail(item);
    }

    var isMobile = (typeof window !== 'undefined' && window.innerWidth < 1024);
    var pane = byId('marketStructureDetailPane');
    var sheet = byId('marketStructureDetailSheet');

    if (isMobile) {
      if (pane) pane.hidden = true;
      openMarketStructureMobileSheet(ticker);
    } else {
      closeMarketStructureMobileSheet();
      if (pane) pane.hidden = false;
    }

    if (syncCockpit && root.activeTicker !== ticker) {
      root.activeTicker = ticker;
      if (root.UnifiedCockpit && typeof root.UnifiedCockpit.syncActiveTicker === 'function') {
        root.UnifiedCockpit.syncActiveTicker(ticker, { loadChart: false, preserveTab: true, runAnalysis: false });
      }
    }

    // Lazy load authoritative single-ticker context with race condition protection
    var currentDetailToken = ++marketStructureDetailToken;
    fetch('/api/quote?action=daily-market-context&ticker=' + encodeURIComponent(ticker), {
      credentials: 'same-origin',
      cache: 'no-store'
    }).then(function (res) {
      return res.json().catch(function () { return {}; });
    }).then(function (payload) {
      if (currentDetailToken !== marketStructureDetailToken) return; // Discard stale response
      if (marketStructureSelectedTicker !== ticker) return;
      if (!payload || !payload.success || !payload.context) return;

      var ms = payload.context.market_structure || {};
      if (researchHasNumber(ms.low_free_float_reference_pct)) {
        var refStr = researchNumber(ms.low_free_float_reference_pct, 0) + '%';
        researchText('marketStructureReference', refStr);
        researchText('marketStructureSheetReference', refStr);
      }
      if (ms.regulatory_compliance_status) {
        var compLabel = formatEnumPresentation(ms.regulatory_compliance_status);
        researchText('marketStructureCompliance', compLabel);
        researchText('marketStructureSheetCompliance', compLabel);
      }
      if (ms.market_structure_guard) {
        var guardLabel = formatEnumPresentation(ms.market_structure_guard);
        researchText('marketStructureGuard', guardLabel);
        researchText('marketStructureSheetGuard', guardLabel);
      }
      if (ms.market_structure_status) {
        var statLabel = formatEnumPresentation(ms.market_structure_status);
        researchText('marketStructureStatus', statLabel);
        researchText('marketStructureSheetStatus', statLabel);
      }
      if (ms.market_structure_note) {
        researchText('marketStructureNote', ms.market_structure_note);
        researchText('marketStructureSheetNote', ms.market_structure_note);
      }
    }).catch(function () {});
  }

  function closeMarketStructureDetail() {
    var closedTicker = marketStructureSelectedTicker;
    marketStructureSelectedTicker = null;
    var pane = byId('marketStructureDetailPane');
    if (pane) pane.hidden = true;
    closeMarketStructureMobileSheet();

    var tbody = byId('marketStructureTableBody');
    if (tbody) {
      var rows = tbody.querySelectorAll('tr[data-ticker]');
      rows.forEach(function (row) {
        row.classList.remove('is-selected');
        row.setAttribute('aria-pressed', 'false');
      });
    }

    var targetToFocus = marketStructureLastFocusedElement;
    if (tbody && (!targetToFocus || !tbody.contains(targetToFocus))) {
      var t = (targetToFocus && targetToFocus.getAttribute) ? targetToFocus.getAttribute('data-ticker') : null;
      if (!t) t = closedTicker;
      if (!t && root.activeTicker) t = root.activeTicker;
      if (t) {
        targetToFocus = tbody.querySelector('tr[data-ticker="' + t + '"]');
      }
    }

    if (targetToFocus && typeof targetToFocus.focus === 'function') {
      try { targetToFocus.focus(); } catch (_) {}
    }
  }
  root.closeMarketStructureDetail = closeMarketStructureDetail;

  var _lastBoundStructureInput = null;
  function bindMarketStructureEventsOnce() {
    var searchInput = byId('marketStructureSearchInput');
    if (_lastBoundStructureInput && _lastBoundStructureInput === searchInput && typeof document !== 'undefined' && document.body && document.body.contains(searchInput)) return;
    _lastBoundStructureInput = searchInput;

    // Search input (2-way search: ticker, company name, investor name)
    if (searchInput) {
      searchInput.addEventListener('input', function (e) {
        var val = (e && e.target && e.target.value != null ? e.target.value : (searchInput ? searchInput.value : '')) || '';
        AutoCuanMarketStructure.onSearchInput(val);
      });
    }

    // Sector select
    var sectorSelect = byId('marketStructureSectorSelect');
    if (sectorSelect) {
      sectorSelect.addEventListener('change', function (e) {
        var val = (e && e.target && e.target.value ? e.target.value : (sectorSelect ? sectorSelect.value : 'all')) || 'all';
        AutoCuanMarketStructure.setSector(val);
      });
    }

    // Filter Chips
    var filterBtns = [
      { id: 'marketStructureFilterAll', filter: 'all' },
      { id: 'marketStructureFilterLowFF', filter: 'low_ff' },
      { id: 'marketStructureFilterHsc', filter: 'hsc' },
      { id: 'marketStructureFilterIncomplete', filter: 'incomplete' }
    ];
    filterBtns.forEach(function (btnDef) {
      var el = byId(btnDef.id);
      if (el) {
        el.addEventListener('click', function () {
          AutoCuanMarketStructure.setFilter(btnDef.filter);
        });
      }
    });

    // Sort select
    var sortSelect = byId('marketStructureSortSelect');
    if (sortSelect) {
      sortSelect.addEventListener('change', function (e) {
        var val = (e && e.target && e.target.value ? e.target.value : (sortSelect ? sortSelect.value : 'free_float_asc')) || 'free_float_asc';
        AutoCuanMarketStructure.setSort(val);
      });
    }

    // Close buttons
    var detailCloseBtn = byId('marketStructureDetailClose');
    if (detailCloseBtn) {
      detailCloseBtn.addEventListener('click', function () { AutoCuanMarketStructure.closeDetail(); });
    }
    var sheetCloseBtn = byId('marketStructureSheetClose');
    if (sheetCloseBtn) {
      sheetCloseBtn.addEventListener('click', function () { AutoCuanMarketStructure.closeDetail(); });
    }
    var sheetCloseBtn2 = byId('marketStructureSheetCloseBtn');
    if (sheetCloseBtn2 && sheetCloseBtn2 !== sheetCloseBtn) {
      sheetCloseBtn2.addEventListener('click', function () { AutoCuanMarketStructure.closeDetail(); });
    }
    var sheetBackdrop = byId('marketStructureSheetBackdrop');
    if (sheetBackdrop) {
      sheetBackdrop.addEventListener('click', function () { AutoCuanMarketStructure.closeDetail(); });
    }

    // Sheet keyboard focus trap & Escape handling
    window.addEventListener('keydown', function (e) {
      if (e.key === 'Escape') {
        var openSheet = byId('marketStructureDetailSheet');
        var mobSheet = byId('marketStructureMobileSheet');
        if ((openSheet && !openSheet.hidden) || (mobSheet && mobSheet.classList.contains('is-open'))) {
          e.preventDefault();
          AutoCuanMarketStructure.closeDetail();
        }
      }
    });

    // Refresh button
    var refreshBtn = byId('marketStructureRefreshBtn');
    if (refreshBtn) {
      refreshBtn.addEventListener('click', function () {
        AutoCuanMarketStructure.loadUniverse(true);
      });
    }
  }

  async function loadStrukturPasarUniverse(selectTicker) {
    bindMarketStructureEventsOnce();
    return AutoCuanMarketStructure.loadUniverse(true).then(function () {
      var target = selectTicker || (root.UnifiedCockpit && root.UnifiedCockpit.getActiveTicker ? root.UnifiedCockpit.getActiveTicker() : root.activeTicker) || 'BBCA';
      if (target) {
        AutoCuanMarketStructure.selectRow(target, false);
      }
    });
  }
  root.loadStrukturPasarUniverse = loadStrukturPasarUniverse;
  root.refreshStrukturPasarUniverse = function () {
    return AutoCuanMarketStructure.loadUniverse(true);
  };

  // ===== FINANCIAL STATEMENTS & FUNDAMENTAL CONTROLLER (CANVAS REDESIGN V2) =====
  var FINANCIAL_META = {
    BRPT: {
      real: true, name: 'Barito Pacific Tbk', sector: 'Basic Materials', bvps: '—', cap: 'Rp 135,5 T', capNote: 'snapshot IDX · 29 Sep 2026', sh: '93,75 M',
      prov: [
        { k: 'Periode terbaru', v: 'Q1 2026' },
        { k: 'Sumber', v: 'Laporan keuangan emiten' },
        { k: 'Free float', v: '22,33% · kepemilikan IDX 30 Sep 2026' },
        { k: 'Diimpor', v: '13 Okt 2026, 10.36 WIB' }
      ],
      warn: 'Laporan Q2 2026 belum ada di server, periode terbaru masih Q1 2026. Beban Usaha, Laba Usaha, Liabilitas, Ekuitas, dan ROE kosong di sumber untuk semua periode, sehingga PBV, BVPS, dan PER tidak dihitung.'
    },
    BBCA: {
      name: 'Bank Central Asia Tbk', sector: 'Perbankan', bvps: 'Rp 2.372', cap: 'Rp 1.263,5 T', capNote: '#1 di IDX', sh: '123,2 M', px: 'Rp 10.250 · 13 Okt',
      prov: [
        { k: 'Periode', v: 'Q2 2026 (diaudit)' },
        { k: 'Sumber fundamental', v: 'Laporan keuangan · keterbukaan IDX' },
        { k: 'Sumber market cap', v: 'Harga penutupan Rp 10.250 · 13 Okt' },
        { k: 'Diverifikasi', v: '15 Okt 2026, 09.20 WIB' }
      ]
    },
    BBRI: {
      name: 'Bank Rakyat Indonesia Tbk', sector: 'Perbankan', bvps: 'Rp 2.242', cap: 'Rp 730,5 T', capNote: '', sh: '151,6 M', px: 'Rp 4.820 · 13 Okt',
      prov: [
        { k: 'Periode', v: 'Q2 2026 (diaudit)' },
        { k: 'Sumber fundamental', v: 'Laporan keuangan · keterbukaan IDX' },
        { k: 'Sumber market cap', v: 'Harga penutupan Rp 4.820 · 13 Okt' },
        { k: 'Diverifikasi', v: '15 Okt 2026, 09.20 WIB' }
      ]
    },
    BMRI: {
      name: 'Bank Mandiri Tbk', sector: 'Perbankan', bvps: 'Rp 4.824', cap: 'Rp 639,3 T', capNote: '', sh: '93,3 M', px: 'Rp 6.850 · 13 Okt',
      prov: [
        { k: 'Periode', v: 'Q2 2026 (diaudit)' },
        { k: 'Sumber fundamental', v: 'Laporan keuangan · keterbukaan IDX' },
        { k: 'Sumber market cap', v: 'Harga penutupan Rp 6.850 · 13 Okt' },
        { k: 'Diverifikasi', v: '15 Okt 2026, 09.20 WIB' }
      ]
    },
    GOTO: null
  };

  var financialState = {
    t: 'BRPT',
    q: '',
    busy: false,
    tab: 0, // 0: Laba Rugi, 1: Neraca, 2: Arus Kas, 3: Rasio
    fr: 0,  // 0: Kuartalan, 1: Tahunan
    yoy: false,
    nul: true, // true: show empty rows, false: hide empty rows
    sel: {},   // selected row id per tab
    toast: ''
  };
  root.financialState = financialState;

  function finDec(n, d) {
    if (n == null || !Number.isFinite(Number(n))) return '—';
    return Number(n).toFixed(d).replace('.', ',');
  }
  function finGrp(n) {
    if (n == null || !Number.isFinite(Number(n))) return '—';
    return Math.round(Number(n)).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.');
  }
  function finFmt(v, k) {
    if (v === null || v === undefined || !Number.isFinite(Number(v))) return '—';
    var num = Number(v);
    if (k === 'm') {
      var s = finGrp(Math.abs(num));
      return num < 0 ? '(' + s + ')' : s;
    }
    if (k === 'eps') {
      var sEps = finDec(Math.abs(num), 2).replace(/\B(?=(\d{3})+(?!\d))/g, '.');
      return num < 0 ? '(' + sEps + ')' : sEps;
    }
    if (k === 'pct') return finDec(num, 2) + '%';
    return finDec(num, 2) + '×';
  }

  function getBrptFsData() {
    return {
      quarterly: {
        periods: ["Q1 2026","Q4 2025","Q3 2025","Q2 2025","Q1 2025","Q4 2024","Q3 2024","Q2 2024"],
        income_statement: [
          { type: "group", label: "Pendapatan & Beban Usaha" },
          { type: "item", label: "Pendapatan Usaha", unit: "idr", values: [43676.21, 35256.39, 40398.01, 39568.43, 12834.95, 13191.01, 6352.17, 9228.85] },
          { type: "item", label: "Beban Usaha / Beban Pokok", unit: "idr", values: [null, null, null, null, null, null, null, null] },
          { type: "total", label: "Laba Usaha / Operasional", unit: "idr", values: [null, null, null, null, null, null, null, null] },
          { type: "group", label: "Laba Bersih & Pajak" },
          { type: "item", label: "Beban Pajak Penghasilan", unit: "idr", values: [-1094.84, -240.23, -256.02, -159.42, -443.45, -401, -446.23, -505.86] },
          { type: "total", label: "Laba Bersih Periode Berjalan", unit: "idr", values: [1537.46, -1490.25, 948.31, 8493.82, 268.06, 507.14, -160.7, 426.03] },
          { type: "item", label: "Laba per Saham (EPS) - IDR", unit: "number", values: [16.41, -15.85, 10.11, 90.65, 2.86, 5.36, -1.72, 4.55] }
        ],
        balance_sheet: [
          { type: "group", label: "Aset" },
          { type: "item", label: "Kas & Setara Kas", unit: "idr", values: [52944.35, 50278.08, 49544.08, 50486.04, 32715.32, 25960.42, 24024.82, 23750.79] },
          { type: "item", label: "Aset Lancar", unit: "idr", values: [112652.27, 104274.88, 107714.81, 107046.76, 63606, 56444.79, 47251.73, 49617.29] },
          { type: "total", label: "Total Aset", unit: "idr", values: [299509.38, 290145.69, 267274.72, 246549.23, 180447.74, 170174.64, 154322.48, 163673.55] },
          { type: "group", label: "Liabilitas" },
          { type: "item", label: "Liabilitas Jangka Pendek", unit: "idr", values: [null, null, null, null, null, null, null, null] },
          { type: "total", label: "Total Liabilitas", unit: "idr", values: [null, null, null, null, null, null, null, null] },
          { type: "group", label: "Ekuitas" },
          { type: "total", label: "Total Ekuitas", unit: "idr", values: [null, null, null, null, null, null, null, null] }
        ],
        cash_flow: [
          { type: "group", label: "Arus Kas Aktivitas" },
          { type: "item", label: "Arus Kas dari Aktivitas Operasi", unit: "idr", values: [-3606.93, 4404.96, 1621.05, 4430.93, -5250.38, 5456.7, -1733.23, 430.71] },
          { type: "item", label: "Arus Kas dari Aktivitas Investasi", unit: "idr", values: [443.18, -25869.77, -8919.3, -4818.21, -993.07, -2320.65, 100.33, 362.36] },
          { type: "item", label: "Arus Kas dari Aktivitas Pendanaan", unit: "idr", values: [4990.42, 22118.12, 4924.07, 18696.27, 12349.28, -2807.39, 3717.03, -466.06] },
          { type: "total", label: "Kenaikan (Penurunan) Kas Bersih", unit: "idr", values: [1826.66, 653.31, -2374.18, 18308.99, 6105.83, 328.65, 2084.14, 327.01] }
        ],
        ratios: [
          { type: "group", label: "Rasio Profitabilitas" },
          { type: "item", label: "Return on Equity (ROE)", unit: "pct", values: [null, null, null, null, null, null, null, null] },
          { type: "item", label: "Return on Assets (ROA)", unit: "pct", values: [0.51, -0.51, 0.35, 3.45, 0.15, 0.3, -0.1, 0.26] }
        ]
      },
      annual: {
        periods: ["FY 2025","FY 2024","FY 2023","FY 2022"],
        income_statement: [
          { type: "group", label: "Pendapatan & Beban Usaha" },
          { type: "item", label: "Pendapatan Usaha", unit: "idr", values: [128057.77, 38578.61, 42553.69, 46587.86] },
          { type: "item", label: "Beban Usaha / Beban Pokok", unit: "idr", values: [null, null, null, null] },
          { type: "total", label: "Laba Usaha / Operasional", unit: "idr", values: [null, null, null, null] },
          { type: "group", label: "Laba Bersih & Pajak" },
          { type: "item", label: "Beban Pajak Penghasilan", unit: "idr", values: [-212.23, -1774.59, -1902.98, -1938.26] },
          { type: "total", label: "Laba Bersih Periode Berjalan", unit: "idr", values: [8219.94, 912.89, 402.6, 27.67] },
          { type: "item", label: "Laba per Saham (EPS) - IDR", unit: "number", values: [87.77, 9.7, 4.31, 0.31] }
        ],
        balance_sheet: [
          { type: "group", label: "Aset" },
          { type: "item", label: "Kas & Setara Kas", unit: "idr", values: [50278.08, 25960.42, 27793.77, 25540.82] },
          { type: "item", label: "Aset Lancar", unit: "idr", values: [104274.88, 56444.79, 55964.04, 44875.68] },
          { type: "total", label: "Total Aset", unit: "idr", values: [290145.69, 170174.64, 156700.69, 144198.78] },
          { type: "group", label: "Liabilitas" },
          { type: "item", label: "Liabilitas Jangka Pendek", unit: "idr", values: [null, null, null, null] },
          { type: "total", label: "Total Liabilitas", unit: "idr", values: [null, null, null, null] },
          { type: "group", label: "Ekuitas" },
          { type: "total", label: "Total Ekuitas", unit: "idr", values: [null, null, null, null] }
        ],
        cash_flow: [
          { type: "group", label: "Arus Kas Aktivitas" },
          { type: "item", label: "Arus Kas dari Aktivitas Operasi", unit: "idr", values: [5195.84, -1780.75, 2166.01, -2090.05] },
          { type: "item", label: "Arus Kas dari Aktivitas Investasi", unit: "idr", values: [-40850.81, -4480.62, -7587.88, -15680.94] },
          { type: "item", label: "Arus Kas dari Aktivitas Pendanaan", unit: "idr", values: [59154.84, 3134.49, 7921.71, 14037.7] },
          { type: "total", label: "Kenaikan (Penurunan) Kas Bersih", unit: "idr", values: [23499.87, -3126.88, 2499.84, -3733.3] }
        ],
        ratios: [
          { type: "group", label: "Rasio Profitabilitas" },
          { type: "item", label: "Return on Equity (ROE)", unit: "pct", values: [null, null, null, null] },
          { type: "item", label: "Return on Assets (ROA)", unit: "pct", values: [2.83, 0.54, 0.26, 0.02] }
        ]
      }
    };
  }

  function getSampleFsData(ticker, fr) {
    var P = {
      BBCA: { R: 29800, ox: .42, g: .018, sh: 123.2, eq: 292230, as: 1482000, ln: 921000, dpk: 1151000, cash: 38400, sd: 0.4, hist: [3.9, 4.05, 4.2, 3.95, 4.1, 4.25, 4.18, 4.32] },
      BBRI: { R: 52100, ox: .58, g: .010, sh: 151.6, eq: 339890, as: 2052000, ln: 1398000, dpk: 1449000, cash: 30600, sd: 1.3, hist: [2.6, 2.48, 2.35, 2.2, 2.3, 2.18, 2.1, 2.15] },
      BMRI: { R: 46200, ox: .52, g: .020, sh: 93.3,  eq: 450080, as: 2451000, ln: 1652000, dpk: 1702000, cash: 40100, sd: 2.1, hist: [1.7, 1.65, 1.58, 1.5, 1.46, 1.44, 1.4, 1.42] }
    }[ticker] || { R: 25000, ox: .45, g: .015, sh: 100.0, eq: 250000, as: 1200000, ln: 800000, dpk: 950000, cash: 30000, sd: 1.0, hist: [2.0, 2.1, 2.2, 2.15, 2.2, 2.3, 2.25, 2.3] };

    var Q = fr === 0, N = Q ? 8 : 5, per = [], V = [];
    for (var k = 0; k < N; k++) {
      var lab, sub, b, fl;
      if (Q) {
        var n = 2026 * 4 + 1 - k, y = Math.floor(n / 4), q = n % 4 + 1;
        lab = 'Q' + q + ' ' + y;
        sub = ['Mar', 'Jun', 'Sep', 'Des'][q - 1] + ' ' + y;
        b = k; fl = 1;
      } else {
        var yAnn = 2025 - k;
        lab = 'FY ' + yAnn;
        sub = 'Des ' + yAnn + ' · tahunan';
        b = 2 + 4 * k;
        fl = 4 * Math.pow(1 + P.g, -1.5);
      }
      var gf = Math.pow(1 + P.g, -b), s = 1 + 0.025 * Math.sin(b * 1.7 + P.sd);
      var rev = P.R * gf * s * fl;
      var opx = -rev * (P.ox + 0.012 * Math.cos(b * 1.3 + P.sd));
      var op = rev + opx;
      var oth = rev * 0.015;
      var ebt = op + oth;
      var tax = -ebt * 0.19;
      var ni = ebt + tax;
      var eq = P.eq * Math.pow(1 + P.g * 1.18, -b);
      var as = P.as * gf;
      var ln = P.ln * gf * (1 + 0.022 * Math.sin(b * 1.1 + P.sd));
      var dpk = P.dpk * gf;
      var cash = P.cash * gf * (1 + 0.06 * Math.sin(b * 2.3));
      var li = as - eq;
      var cfo = ni * (1.15 + 0.22 * Math.sin(b * 2.1 + P.sd));
      var cfi = -ni * (0.35 + 0.08 * Math.cos(b + P.sd));
      var cff = -ni * (Q ? 0.18 : 0.72);
      var eps = ni / P.sh;
      var bvps = eq / P.sh;
      var pbv = P.hist[Math.min(P.hist.length - 1, k)];

      per.push({ lab: lab, sub: sub });
      V.push({
        rev: rev, opx: opx, op: op, oth: oth, ebt: ebt, tax: tax, ni: ni, eps: eps,
        as: as, cash: cash, ln: ln, li: li, dpk: dpk, eq: eq,
        cfo: cfo, cfi: cfi, cff: cff, net: cfo + cfi + cff,
        roe: (ni / eq) * 100, roa: (ni / as) * 100, npm: (ni / rev) * 100,
        der: li / eq, pbv: pbv
      });
    }

    var R = function(id, l, k, o) {
      return Object.assign({ id: id, l: l, k: k, vals: V.map(function(v) { return v[id]; }) }, o || {});
    };

    return {
      per: per,
      hist: P.hist,
      tabs: [
        {
          t: 'Laba Rugi', def: 'ni',
          rows: [
            { g: 'Pendapatan & Beban Usaha' },
            R('rev', 'Pendapatan Usaha', 'm'),
            R('opx', 'Beban Usaha / Beban Pokok', 'm'),
            R('op', 'Laba Usaha / Operasional', 'm', { tot: true }),
            { g: 'Laba Bersih & Pajak' },
            R('oth', 'Pendapatan (Beban) Lain-lain', 'm'),
            R('ebt', 'Laba Sebelum Pajak', 'm'),
            R('tax', 'Beban Pajak Penghasilan', 'm'),
            R('ni', 'Laba Bersih Periode Berjalan', 'm', { tot: true }),
            R('eps', 'Laba per Saham (EPS)', 'eps', { u: 'IDR' })
          ]
        },
        {
          t: 'Neraca', def: 'eq',
          rows: [
            { g: 'Aset' },
            R('cash', 'Kas & Setara Kas', 'm'),
            R('ln', 'Kredit yang Diberikan (neto)', 'm'),
            R('as', 'Total Aset', 'm', { tot: true }),
            { g: 'Liabilitas & Ekuitas' },
            R('dpk', 'Dana Pihak Ketiga', 'm'),
            R('li', 'Total Liabilitas', 'm', { tot: true }),
            R('eq', 'Total Ekuitas', 'm', { tot: true })
          ]
        },
        {
          t: 'Arus Kas', def: 'cfo',
          rows: [
            { g: 'Arus Kas Aktivitas' },
            R('cfo', 'Arus Kas dari Aktivitas Operasi', 'm'),
            R('cfi', 'Arus Kas dari Aktivitas Investasi', 'm'),
            R('cff', 'Arus Kas dari Aktivitas Pendanaan', 'm'),
            R('net', 'Kenaikan (Penurunan) Kas Bersih', 'm', { tot: true })
          ]
        },
        {
          t: 'Rasio', def: 'roe',
          rows: [
            { g: 'Rasio Profitabilitas' },
            R('roe', 'Return on Equity (ROE)', 'pct', { u: Q ? 'per kuartal' : '' }),
            R('roa', 'Return on Assets (ROA)', 'pct', { u: Q ? 'per kuartal' : '' }),
            R('npm', 'Margin Laba Bersih', 'pct'),
            { g: 'Struktur & Valuasi' },
            R('der', 'Liabilitas / Ekuitas', 'x'),
            R('pbv', 'PBV', 'x')
          ]
        }
      ]
    };
  }

  function getFinancialModel(ticker, fr) {
    if (ticker === 'BRPT') {
      var src = getBrptFsData()[fr === 0 ? 'quarterly' : 'annual'];
      var M = { Q1: 'Mar', Q2: 'Jun', Q3: 'Sep', Q4: 'Des' };
      var per = src.periods.map(function(p) {
        var a = p.split(' ');
        return { lab: p, sub: a[0] === 'FY' ? 'Des ' + a[1] + ' · tahunan' : M[a[0]] + ' ' + a[1] };
      });
      var conv = function(rows) {
        return rows.map(function(r) {
          if (r.type === 'group') return { g: r.label };
          var l = r.label, u = '';
          var m = l.match(/^(.*?)\s*-\s*IDR$/);
          if (m) { l = m[1]; u = 'IDR'; }
          if (r.unit === 'pct' && fr === 0) u = 'per kuartal';
          return {
            id: r.label,
            l: l,
            u: u,
            k: r.unit === 'idr' ? 'm' : (r.unit === 'number' ? 'eps' : 'pct'),
            tot: r.type === 'total',
            vals: r.values
          };
        });
      };
      return {
        per: per,
        tabs: [
          { t: 'Laba Rugi', def: 'Laba Bersih Periode Berjalan', rows: conv(src.income_statement) },
          { t: 'Neraca', def: 'Total Aset', rows: conv(src.balance_sheet) },
          { t: 'Arus Kas', def: 'Arus Kas dari Aktivitas Operasi', rows: conv(src.cash_flow) },
          { t: 'Rasio', def: 'Return on Assets (ROA)', rows: conv(src.ratios) }
        ]
      };
    }
    return getSampleFsData(ticker, fr);
  }

  function renderFinancialFundamentalLegacy(ticker, f, price, rootObj) {
    if (!f) return;
    financialSnapshotCache[ticker] = f;
    researchText('financialTickerBadge', ticker);
    var hasPbv = researchHasNumber(f.pbv);
    var hasBvps = researchHasNumber(f.book_value_per_share);
    var hasPer = researchHasNumber(f.per);
    var hasDer = researchHasNumber(f.der);
    var hasShares = researchHasNumber(f.shares_outstanding);
    var hasMarketCap = researchHasNumber(f.market_cap);
    var coverageCount = (hasPbv ? 1 : 0) + (hasBvps ? 1 : 0) + (hasPer ? 1 : 0) + (hasDer ? 1 : 0) + (hasShares ? 1 : 0) + (hasMarketCap ? 1 : 0);

    researchText('financialPbv', hasPbv ? researchNumber(f.pbv, 2) + 'x' : '—');
    researchText('financialBvps', hasBvps ? researchIdr(f.book_value_per_share) : '—');
    researchText('financialPer', hasPer ? researchNumber(f.per, 2) + 'x' : '—');
    researchText('financialDer', hasDer ? researchNumber(f.der, 2) + 'x' : '—');
    researchText('financialShares', hasShares ? formatIndonesianSharesCount(f.shares_outstanding) : '—');
    researchText('financialMarketCap', hasMarketCap ? formatIndonesianMarketCap(f.market_cap) : '—');

    if (coverageCount === 0) {
      var unavailable = byId('financialUnavailableState');
      if (unavailable) unavailable.hidden = false;
    }
  }

  function renderFinancialFundamental() {
    var ticker = (financialState.t || 'BRPT').toUpperCase();
    var meta = FINANCIAL_META[ticker];

    // Update Ticker chips
    ['BRPT', 'BBCA', 'BBRI', 'BMRI', 'GOTO'].forEach(function(code) {
      var btns = document.querySelectorAll('#financialPopularChips button');
      btns.forEach(function(b) {
        if (b.textContent.trim() === code) {
          if (code === ticker) b.classList.add('on');
          else b.classList.remove('on');
        }
      });
    });

    var snapshotSheet = byId('financialSnapshotSheet');
    var snapshotBody = byId('financialSnapshotBody');
    var snapshotEmpty = byId('financialSnapshotEmpty');
    var statementsSheet = byId('financialStatementsSheet');
    var peerSection = byId('financialPeerSection');
    var missMsg = byId('financialTickerMissMsg');

    if (!meta) {
      // Empty state for unknown / unlisted ticker (like GOTO or others)
      if (snapshotBody) snapshotBody.style.display = 'none';
      if (statementsSheet) statementsSheet.style.display = 'none';
      if (peerSection) peerSection.style.display = 'none';
      if (snapshotEmpty) {
        snapshotEmpty.style.display = 'flex';
        var tEl = byId('financialEmptyTitle');
        if (tEl) tEl.textContent = 'Data fundamental belum tersedia untuk ' + ticker;
      }
      var tBadge = byId('financialTickerBadge');
      if (tBadge) tBadge.textContent = ticker;
      var cName = byId('financialCompanyName');
      if (cName) cName.textContent = 'PT ' + ticker + ' Tbk';
      var cSec = byId('financialSectorName');
      if (cSec) cSec.textContent = '· Teknologi';
      var cCov = byId('financialCoverageBadge');
      if (cCov) { cCov.textContent = 'Tidak tersedia · 0/4'; cCov.className = 'chip'; }
      return;
    }

    if (snapshotBody) snapshotBody.style.display = 'block';
    if (snapshotEmpty) snapshotEmpty.style.display = 'none';
    if (statementsSheet) statementsSheet.style.display = 'block';
    if (missMsg) missMsg.style.display = 'none';

    // Populate Snapshot Sheet
    var tBadge = byId('financialTickerBadge');
    if (tBadge) tBadge.textContent = ticker;
    var cName = byId('financialCompanyName');
    if (cName) cName.textContent = meta.name;
    var cSec = byId('financialSectorName');
    if (cSec) cSec.textContent = '· ' + meta.sector;

    var pbvVal = byId('financialPbvVal');
    var pbvNote = byId('financialPbvNote');
    if (pbvVal) pbvVal.textContent = meta.real ? '—' : (ticker === 'BBCA' ? '4,32×' : (ticker === 'BBRI' ? '2,15×' : '1,42×'));
    if (pbvNote) pbvNote.textContent = meta.real ? 'butuh Total Ekuitas, kosong di sumber' : 'rerata 8 kuartal 4,12×';

    var bvpsVal = byId('financialBvpsVal');
    if (bvpsVal) bvpsVal.textContent = meta.bvps;
    var capVal = byId('financialCapVal');
    if (capVal) capVal.textContent = meta.cap;
    var capNote = byId('financialCapNote');
    if (capNote) capNote.textContent = meta.capNote || 'snapshot IDX';
    var shVal = byId('financialSharesVal');
    if (shVal) shVal.textContent = meta.sh;

    var covBadge = byId('financialCoverageBadge');
    if (covBadge) {
      if (meta.real) {
        covBadge.textContent = 'Data Sebagian · 2/4 kategori lengkap';
        covBadge.className = 'chip w';
      } else {
        covBadge.textContent = 'Data Lengkap · 4/4';
        covBadge.className = 'chip b';
      }
    }

    // Completeness chips
    var cmplContainer = byId('financialCategoryCompleteness');
    if (cmplContainer) {
      var catNames = ['Laba Rugi', 'Neraca', 'Arus Kas', 'Rasio'];
      var isReal = meta.real;
      cmplContainer.innerHTML = catNames.map(function(cName, idx) {
        var isPartial = isReal && (idx === 1 || idx === 3);
        var icon = isPartial ? '!' : '✓';
        var cls = isPartial ? 'p' : '';
        var n = isReal ? (idx === 1 ? '3/6 pos' : (idx === 3 ? '1/2 pos' : '4/4 pos')) : '4/4 pos';
        return '<span class="' + cls + '"><i aria-hidden="true">' + icon + '</i>' + cName + '<em>' + n + '</em></span>';
      }).join('');
    }

    // Provenance
    var pLatest = byId('financialLatestPeriodVal');
    if (pLatest) pLatest.textContent = meta.real ? 'Q1 2026' : 'Q2 2026';
    var warnBox = byId('financialSnapshotWarning');
    var warnTxt = byId('financialWarningText');
    if (warnBox && warnTxt) {
      if (meta.warn) {
        warnBox.style.display = 'flex';
        warnTxt.textContent = meta.warn;
      } else {
        warnBox.style.display = 'none';
      }
    }

    // Populate Statements Sheet
    var fr = financialState.fr || 0; // 0: quarterly, 1: annual
    var model = getFinancialModel(ticker, fr);
    var per = model.per;
    var tabIdx = financialState.tab || 0;
    var tab = model.tabs[tabIdx] || model.tabs[0];

    var subtitle = byId('financialStatementsSubtitle');
    if (subtitle) {
      subtitle.textContent = meta.name + ' · ' + (fr === 0 ? per.length + ' kuartal · ' + per[0].lab + ' s.d. ' + per[per.length - 1].lab : per.length + ' tahun buku · ' + per[0].lab + ' s.d. ' + per[per.length - 1].lab);
    }

    // Tabs indicators
    var catInd = byId('financialCategoryTabInd');
    if (catInd) catInd.className = 'ind k' + tabIdx;
    for (var i = 0; i < 4; i++) {
      var cBtn = byId('finCat' + i);
      if (cBtn) {
        if (i === tabIdx) cBtn.classList.add('on');
        else cBtn.classList.remove('on');
      }
    }

    var freqInd = byId('financialFreqTabInd');
    if (freqInd) freqInd.className = 'ind k' + fr;
    for (var j = 0; j < 2; j++) {
      var fBtn = byId('finFreq' + j);
      if (fBtn) {
        if (j === fr) fBtn.classList.add('on');
        else fBtn.classList.remove('on');
      }
    }

    // Filter empty rows if toggled
    var rows = tab.rows;
    var isNull = function(v) { return v === null || v === undefined || !Number.isFinite(Number(v)); };
    var isRowEmpty = function(r) { return !r.g && r.vals && r.vals.every(isNull); };
    var emptyCount = rows.filter(isRowEmpty).length;
    var emptyCountEl = byId('finEmptyRowsCount');
    if (emptyCountEl) emptyCountEl.textContent = emptyCount;

    var visRows = rows;
    if (!financialState.nul) {
      visRows = [];
      rows.forEach(function(r, idx) {
        if (r.g) {
          var hasNextNonEmpty = false;
          for (var k = idx + 1; k < rows.length && !rows[k].g; k++) {
            if (!isRowEmpty(rows[k])) { hasNextNonEmpty = true; break; }
          }
          if (hasNextNonEmpty) visRows.push(r);
        } else if (!isRowEmpty(r)) {
          visRows.push(r);
        }
      });
    }

    // Build Table Head
    var thead = byId('financialStatementsThead');
    if (thead) {
      var thHtml = '<tr><th>Pos</th>';
      per.forEach(function(p, pIdx) {
        var ltClass = pIdx === 0 ? ' class="lt"' : '';
        thHtml += '<th' + ltClass + '>' + escapeHtml(p.lab) + '<small>' + escapeHtml(p.sub) + '</small></th>';
      });
      thHtml += '</tr>';
      thead.innerHTML = thHtml;
    }

    // Build Table Body
    var tbody = byId('financialStatementsTbody');
    var selectedRowId = financialState.sel[tabIdx] || tab.def;
    var selectedRow = null;

    if (tbody) {
      var tbHtml = '';
      var lag = fr === 0 ? 4 : 1;

      visRows.forEach(function(row) {
        if (row.g) {
          tbHtml += '<tr class="g"><td colspan="' + (per.length + 1) + '">' + escapeHtml(row.g) + '</td></tr>';
          return;
        }

        var isSelected = (row.id === selectedRowId || row.l === selectedRowId);
        if (isSelected) selectedRow = row;

        var trCls = [];
        if (row.tot) trCls.push('t');
        if (isSelected) trCls.push('sel');
        if (isRowEmpty(row)) trCls.push('nul');

        tbHtml += '<tr class="' + trCls.join(' ') + '" onclick="selectFinTrendRow(\'' + escapeHtml(row.id || row.l) + '\')" style="cursor:pointer">';
        tbHtml += '<td>' + escapeHtml(row.l) + (row.u ? '<span class="un">' + escapeHtml(row.u) + '</span>' : '') + '</td>';

        row.vals.forEach(function(val, vIdx) {
          var isLatest = vIdx === 0;
          var tdCls = isLatest ? 'lt' : '';
          var prevVal = row.vals[vIdx + lag];
          var yoyHtml = '';

          if (financialState.yoy && !isNull(val) && !isNull(prevVal)) {
            var diff = val - prevVal;
            var pctDiff = prevVal !== 0 ? (diff / Math.abs(prevVal)) * 100 : null;
            if (pctDiff != null) {
              var isUp = pctDiff >= 0;
              var diffStr = (isUp ? '+' : '') + pctDiff.toFixed(1).replace('.', ',') + '%';
              yoyHtml = '<span class="yy ' + (isUp ? 'up' : 'dn') + '">' + diffStr + '</span>';
            }
          }

          var formatted = finFmt(val, row.k);
          tbHtml += '<td class="' + tdCls + '">' + formatted + yoyHtml + '</td>';
        });

        tbHtml += '</tr>';
      });

      tbody.innerHTML = tbHtml;
    }

    // Fallback if no selected row
    if (!selectedRow) {
      selectedRow = tab.rows.find(function(r) { return !r.g; }) || tab.rows[0];
    }

    // Populate Footnote bar
    var footCat = byId('finFootCat');
    if (footCat) footCat.textContent = tab.t;
    var footFreq = byId('finFootFreq');
    if (footFreq) footFreq.textContent = fr === 0 ? 'Kuartalan' : 'Tahunan';
    var srcChip = byId('finSrcChip');
    if (srcChip) {
      srcChip.textContent = meta.real ? 'Data server · impor 13 Okt 2026' : 'Data contoh';
      srcChip.className = 'chip ' + (meta.real ? 'b' : 'i');
    }

    // Render Trend Summary Cards & Bar Chart with HTML Overlay (§5c)
    renderFinancialTrend(selectedRow, per, fr);

    // Render Peer Section
    if (peerSection) {
      if (meta.real) {
        peerSection.style.display = 'none';
      } else {
        peerSection.style.display = 'block';
        var peerTbody = byId('financialPeerTbody');
        if (peerTbody) {
          var peers = [
            { t: 'BBCA', v: '4,32×', roe: '19,25%', bar: 'width:100%' },
            { t: 'BBRI', v: '2,15×', roe: '14,80%', bar: 'width:50%' },
            { t: 'BMRI', v: '1,42×', roe: '16,10%', bar: 'width:33%' },
            { t: 'BBNI', v: '1,18×', roe: '—', bar: 'width:27%' }
          ];
          peerTbody.innerHTML = peers.map(function(p, pIdx) {
            var isCur = p.t === ticker;
            return '<tr class="rise d' + pIdx + (isCur ? ' sel' : '') + '" onclick="selectFinancialTicker(\'' + p.t + '\')" style="cursor:pointer">' +
              '<td class="tk mono">' + p.t + '</td>' +
              '<td class="r num" style="font-weight:700">' + p.v + '</td>' +
              '<td class="r num">' + p.roe + '</td>' +
              '<td><div class="meter"><i style="' + p.bar + ';' + (isCur ? '' : 'background:#9AA6A1') + '"></i></div></td>' +
              '</tr>';
          }).join('');
        }
      }
    }
  }
  root.renderFinancialFundamental = renderFinancialFundamental;

  // §5c REQUIREMENT: SVG Bar Chart with HTML overlay labels with percentage positioning and cqi typography
  function renderFinancialTrend(row, per, fr) {
    if (!row || !row.vals) return;

    var trLabel = byId('financialTrendLabel');
    if (trLabel) trLabel.textContent = row.l;

    var trSubtitle = byId('financialTrendSubtitle');
    var isNull = function(v) { return v === null || v === undefined || !Number.isFinite(Number(v)); };
    var vals = row.vals.slice().reverse(); // reverse so oldest is on left, newest on right
    var labs = per.map(function(p) { return p.lab; }).slice().reverse();
    var ok = vals.filter(function(v) { return !isNull(v); });

    var unitTxt = row.k === 'm' ? 'Miliar IDR' : (row.k === 'eps' ? 'Rupiah per saham' : (row.k === 'pct' ? 'persen' : 'kali'));
    if (trSubtitle) {
      trSubtitle.textContent = !ok.length ? 'Pos ini tidak tersedia di sumber untuk semua periode'
        : unitTxt + ' · ' + vals.length + (fr === 0 ? ' kuartal' : ' tahun') + (ok.length < vals.length ? ' · ' + (vals.length - ok.length) + ' periode kosong, tidak dihitung' : '');
    }

    var lastV = row.vals[0];
    var lag = fr === 0 ? 4 : 1;
    var prevV = row.vals[lag];

    var trLatest = byId('financialTrendLatest');
    if (trLatest) trLatest.textContent = finFmt(lastV, row.k);

    var trDeltaVal = byId('financialTrendDeltaVal');
    var trDeltaLabel = byId('financialTrendDeltaLabel');
    if (trDeltaLabel) trDeltaLabel.textContent = fr === 0 ? 'Δ YoY (vs ' + (per[lag] ? per[lag].lab : '—') + ')' : 'Δ vs ' + (per[1] ? per[1].lab : '—');
    if (trDeltaVal) {
      if (!isNull(lastV) && !isNull(prevV)) {
        var diff = lastV - prevV;
        var isUp = diff >= 0;
        var diffTxt = (isUp ? '+' : '') + finFmt(diff, row.k);
        trDeltaVal.textContent = diffTxt;
        trDeltaVal.className = 'num ' + (isUp ? 'pos' : 'neg');
      } else {
        trDeltaVal.textContent = '—';
        trDeltaVal.className = 'num mut';
      }
    }

    var trAvg = byId('financialTrendAvg');
    if (trAvg) {
      var avg = ok.length ? ok.reduce(function(a, b) { return a + b; }, 0) / ok.length : null;
      trAvg.textContent = finFmt(avg, row.k);
    }

    var trRange = byId('financialTrendRange');
    if (trRange) {
      trRange.textContent = ok.length ? finFmt(Math.min.apply(null, ok), row.k) + ' – ' + finFmt(Math.max.apply(null, ok), row.k) : '—';
    }

    // Chart layout calculation
    var mx = Math.max.apply(null, [0].concat(ok));
    var mn = Math.min.apply(null, [0].concat(ok));
    var span = (mx - mn) || 1;
    var H = 140, top = 16;
    var zy = top + (mx / span) * H;
    var slot = 610 / vals.length;
    var bw = Math.min(46, slot * 0.56);

    var zeroLine = byId('financialZeroLine');
    if (zeroLine) {
      zeroLine.setAttribute('y1', zy.toFixed(1));
      zeroLine.setAttribute('y2', zy.toFixed(1));
    }

    var svgBarsGroup = byId('financialSvgBarsGroup');
    var htmlLabelsGroup = byId('financialHtmlLabelsGroup');

    var shortLabel = function(s) {
      return s.replace('FY ', '').replace(' 20', ' ’');
    };

    var barsSvg = '';
    var labelsHtml = '';

    vals.forEach(function(v, i) {
      var cx = 20 + slot * (i + 0.5);
      var qLab = shortLabel(labs[i]);
      var isLast = i === vals.length - 1;

      if (isNull(v)) {
        var xNull = (cx - bw / 2).toFixed(1);
        var yNull = (zy - 2).toFixed(1);
        barsSvg += '<rect class="bb" x="' + xNull + '" y="' + yNull + '" width="' + bw.toFixed(1) + '" height="2" fill="#C9D0C9">' +
          '<title>' + labs[i] + ': tidak dilaporkan</title></rect>';
        // §5c: HTML percentage overlay
        labelsHtml += '<span class="glb fq" style="left:' + (cx / 6.4).toFixed(2) + '%;top:94.74%">' + qLab + '</span>';
        labelsHtml += '<span class="glb fv" style="left:' + (cx / 6.4).toFixed(2) + '%;top:' + ((zy - 12) / 1.9).toFixed(2) + '%">—</span>';
        return;
      }

      var h = Math.max(2, Math.abs(v) / span * H);
      var y = v >= 0 ? zy - h : zy;
      var fill = v < 0 ? '#B9475A' : (isLast ? '#13785D' : '#8FB9A6');
      var barX = (cx - bw / 2).toFixed(1);
      var barY = y.toFixed(1);
      var barH = h.toFixed(1);
      var delay = i * 45;

      barsSvg += '<rect class="bb' + (v < 0 ? ' n' : '') + '" x="' + barX + '" y="' + barY + '" width="' + bw.toFixed(1) + '" height="' + barH + '" rx="3" fill="' + fill + '" style="animation-delay:' + delay + 'ms">' +
        '<title>' + labs[i] + ': ' + finFmt(v, row.k) + '</title></rect>';

      var labelY = v >= 0 ? y - 6 : y + h + 12;
      var valText = (isLast || i === 0) ? finFmt(v, row.k) : '';

      // §5c: Percentage-positioned HTML overlay labels with cqi typography
      labelsHtml += '<span class="glb fq" style="left:' + (cx / 6.4).toFixed(2) + '%;top:94.74%">' + qLab + '</span>';
      if (valText) {
        labelsHtml += '<span class="glb fv" style="left:' + (cx / 6.4).toFixed(2) + '%;top:' + ((labelY - 4) / 1.9).toFixed(2) + '%">' + valText + '</span>';
      }
    });

    if (svgBarsGroup) svgBarsGroup.innerHTML = barsSvg;
    if (htmlLabelsGroup) htmlLabelsGroup.innerHTML = labelsHtml;
  }

  root.selectFinancialTicker = function(ticker) {
    if (!ticker) return;
    var t = String(ticker).trim().toUpperCase();
    financialState.t = t;
    renderFinancialFundamental();
  };

  root.refreshFinancialData = function() {
    var spinner = byId('financialUpdatingSpinner');
    if (spinner) spinner.style.display = 'inline-flex';
    setTimeout(function() {
      if (spinner) spinner.style.display = 'none';
      renderFinancialFundamental();
    }, 1000);
  };

  root.setFinStatementCat = function(idx) {
    financialState.tab = idx;
    renderFinancialFundamental();
  };

  root.setFinStatementFreq = function(idx) {
    financialState.fr = idx;
    renderFinancialFundamental();
  };

  root.toggleFinEmptyRows = function() {
    financialState.nul = !financialState.nul;
    var btn = byId('btnToggleEmptyRows');
    if (btn) {
      btn.setAttribute('aria-pressed', financialState.nul ? 'true' : 'false');
      if (financialState.nul) btn.classList.add('on');
      else btn.classList.remove('on');
    }
    renderFinancialFundamental();
  };

  root.toggleFinYoy = function() {
    financialState.yoy = !financialState.yoy;
    var btn = byId('btnToggleYoy');
    if (btn) {
      btn.setAttribute('aria-pressed', financialState.yoy ? 'true' : 'false');
      if (financialState.yoy) btn.classList.add('on');
      else btn.classList.remove('on');
    }
    var table = byId('financialStatementsTable');
    if (table) {
      if (financialState.yoy) table.classList.add('y');
      else table.classList.remove('y');
    }
    renderFinancialFundamental();
  };

  root.selectFinTrendRow = function(rowId) {
    financialState.sel[financialState.tab || 0] = rowId;
    renderFinancialFundamental();
  };

  root.exportFinancialCsv = function() {
    var ticker = (financialState.t || 'BRPT').toUpperCase();
    var fr = financialState.fr || 0;
    var model = getFinancialModel(ticker, fr);
    var tab = model.tabs[financialState.tab || 0];
    var per = model.per;

    var csv = 'Pos;' + per.map(function(p) { return p.lab; }).join(';') + '\r\n';
    tab.rows.forEach(function(row) {
      if (row.g) {
        csv += '--- ' + row.g + ' ---\r\n';
        return;
      }
      var line = [row.l];
      row.vals.forEach(function(v) {
        line.push(v != null ? Number(v).toFixed(2).replace('.', ',') : '');
      });
      csv += line.join(';') + '\r\n';
    });

    if (typeof window !== 'undefined' && typeof window.Blob === 'function') {
      var blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
      var url = URL.createObjectURL(blob);
      var link = document.createElement('a');
      link.setAttribute('href', url);
      link.setAttribute('download', 'laporan-keuangan-' + ticker.toLowerCase() + '-' + (fr === 0 ? 'kuartalan' : 'tahunan') + '.csv');
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);
    }
  };

  async function loadFinancialStructureTab(tabName, rawTicker) {
    var ticker = researchTicker(rawTicker || (root.UnifiedCockpit && root.UnifiedCockpit.getActiveTicker ? root.UnifiedCockpit.getActiveTicker() : root.activeTicker) || 'BRPT');
    if (!ticker) return;

    var isFinancial = tabName === 'financial';
    if (!isFinancial) {
      return root.loadStrukturPasarUniverse(ticker);
    }

    if (isFinancial && financialSnapshotCache[ticker]) {
      // cached snapshot available
    }

    if (root.UnifiedCockpit && typeof root.UnifiedCockpit.syncActiveTicker === 'function') {
      root.UnifiedCockpit.syncActiveTicker(ticker, { loadChart: false, preserveTab: true, runAnalysis: false, skipFinancialSync: true });
    } else {
      root.activeTicker = ticker;
    }
    var financialInput = byId('financialTickerInput');
    if (financialInput) financialInput.value = ticker;

    financialState.t = ticker;
    renderFinancialFundamental();
  }
  root.loadFinancialStructureTab = loadFinancialStructureTab;


  var marketStructureRosterCache = {};
  var marketStructureRosterGen = 0;

  function renderMarketStructureShareholdersError(ticker, errorMsg) {
    var tbody = byId('marketStructureRosterTbody');
    var badge = byId('marketStructureRosterBadge');
    if (badge) {
      badge.textContent = 'Gagal memuat';
      badge.className = 'text-[10px] font-mono px-2 py-0.5 rounded bg-rose-500/10 text-rose-300 border border-rose-500/20';
    }
    if (tbody) {
      var msg = errorMsg ? escapeHtml(errorMsg) : 'Gagal memuat data pemegang saham.';
      tbody.innerHTML = '<tr><td colspan="4" class="py-4 text-center text-xs text-rose-400">Gagal memuat data pemegang saham: ' + msg + '</td></tr>';
    }
    syncMarketStructureDetailToSheet();
  }

  async function loadMarketStructureShareholders(ticker) {
    var curGen = ++marketStructureRosterGen;
    var clean = String(ticker || '').trim().toUpperCase();
    if (!clean) return;

    var tbody = byId('marketStructureRosterTbody');
    var badge = byId('marketStructureRosterBadge');
    if (badge) {
      badge.textContent = 'Memuat…';
      badge.className = 'text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/20';
    }
    if (tbody) {
      tbody.innerHTML = '<tr><td colspan="4" class="py-4 text-center text-xs text-gray-400"><span class="spinner-sm"></span> Memuat daftar pemegang saham ' + escapeHtml(clean) + '…</td></tr>';
    }

    if (marketStructureRosterCache[clean]) {
      renderMarketStructureShareholders(clean, marketStructureRosterCache[clean]);
      return;
    }

    try {
      var res = await fetch('/api/sector-hot?action=insider-roster&ticker=' + encodeURIComponent(clean), {
        credentials: 'same-origin',
        cache: 'no-store'
      });
      if (!res.ok) {
        if (curGen !== marketStructureRosterGen) return;
        renderMarketStructureShareholdersError(clean, 'HTTP ' + res.status);
        return;
      }
      var data = await res.json().catch(function () { return null; });
      if (curGen !== marketStructureRosterGen) return;

      if (!data || data.success !== true || !Array.isArray(data.roster)) {
        renderMarketStructureShareholdersError(clean, (data && data.error) || 'Format data tidak valid');
        return;
      }

      var roster = data.roster;
      // Only cache valid successful responses (whether empty array or populated)
      marketStructureRosterCache[clean] = roster;
      renderMarketStructureShareholders(clean, roster);
    } catch (err) {
      if (curGen !== marketStructureRosterGen) return;
      renderMarketStructureShareholdersError(clean, (err && err.message) || 'Koneksi bermasalah');
    }
  }

  function renderMarketStructureShareholders(ticker, roster) {
    var tbody = byId('marketStructureRosterTbody');
    var badge = byId('marketStructureRosterBadge');
    if (!tbody) return;

    if (!roster || roster.length === 0) {
      if (badge) {
        badge.textContent = 'Belum tersedia';
        badge.className = 'text-[10px] font-mono px-2 py-0.5 rounded bg-gray-700/40 text-gray-400 border border-gray-600/30';
      }
      tbody.innerHTML = '<tr><td colspan="4" class="py-4 text-center text-xs text-gray-400">Data kepemilikan >5% belum dilaporkan pada feed resmi bursa untuk emiten ini.</td></tr>';
      syncMarketStructureDetailToSheet();
      return;
    }

    if (badge) {
      badge.textContent = roster.length + ' Entitas';
      badge.className = 'text-[10px] font-mono px-2 py-0.5 rounded bg-emerald-500/10 text-emerald-300 border border-emerald-500/20';
    }

    var html = '';
    for (var i = 0; i < roster.length; i++) {
      var r = roster[i];
      var name = r.name || r.investorName || '-';
      var orig = r.localForeign || r.local_foreign || r.origin;
      var baseCat = r.category || r.position || r.investorType || 'Pemegang Saham';
      var cat = formatInvestorCategoryIndonesian(baseCat, orig);
      var shares = typeof r.shares === 'number' ? r.shares : parseFloat(r.shares || 0);
      var pctRaw = r.percentage;
      var pct = (pctRaw == null || pctRaw === '')
        ? null
        : (typeof pctRaw === 'number' ? pctRaw : parseFloat(String(pctRaw).replace(/[%\s]/g, '')));
      if (!Number.isFinite(pct)) pct = null;
      var pctStr = r.percentage_formatted || (pct != null ? pct.toFixed(2) + '%' : '-');
      if (pctStr === '—' || pctStr === '-') pctStr = '-';

      html += '<tr class="border-b border-slate-800/80 hover:bg-slate-800/40 transition">';
      html += '  <td colspan="4" class="p-2.5">';
      html += '    <div class="flex items-center justify-between gap-2">';
      html += '      <span class="font-semibold text-slate-100 text-xs truncate" title="' + escapeHtml(name) + '">' + escapeHtml(name) + '</span>';
      html += '      <span class="font-mono text-emerald-400 font-bold text-xs tabular-nums shrink-0">' + escapeHtml(pctStr) + '</span>';
      html += '    </div>';
      html += '    <div class="flex items-center justify-between gap-2 mt-1 text-[11px]">';
      html += '      <span class="text-slate-400 bg-slate-800 px-1.5 py-0.5 rounded text-[10px] border border-slate-700/50 truncate max-w-[65%]">' + escapeHtml(cat) + '</span>';
      html += '      <span class="font-mono text-slate-300 tabular-nums shrink-0 text-[11px]">' + (shares > 0 ? Number(shares).toLocaleString('id-ID') + ' lbr' : '-') + '</span>';
      html += '    </div>';
      html += '  </td>';
      html += '</tr>';
    }
    tbody.innerHTML = html;
    syncMarketStructureDetailToSheet();
  }

  function syncMarketStructureDetailToSheet() {
    var sheetBody = byId('marketStructureSheetBody');
    var deskBody = byId('marketStructureDetailBody');
    if (sheetBody && deskBody) {
      sheetBody.innerHTML = deskBody.innerHTML;
    }
  }

  // ===== AUTO-CUAN MARKET STRUCTURE CONTROLLER (WAVE 4, §79.3, LIST-FIRST) =====
  var AutoCuanMarketStructure = {
    universe: [],
    filteredUniverse: [],
    activeFilter: 'all',
    searchQuery: '',
    sectorFilter: 'all',
    sortKey: 'free_float_asc',
    selectedTicker: null,
    lastSelectedRowEl: null,
    isLoading: false,
    hasLoaded: false,
    currentPage: 1,
    pageSize: 50,

    updateFilterCounts: function () {
      var allCount = this.universe.length;
      var lowFfCount = 0;
      var hscCount = 0;
      var incCount = 0;

      for (var i = 0; i < this.universe.length; i++) {
        var r = this.universe[i];
        var ff = r.free_float_pct != null ? r.free_float_pct : r.freeFloat;
        var hasValidFf = ff != null && Number.isFinite(Number(ff));
        if (hasValidFf && Number(ff) < 15) {
          lowFfCount++;
        }
        if (r.hsc_flag === true) {
          hscCount++;
        }
        var isComp = hasValidFf && Array.isArray(r.investors) && r.investors.length > 0;
        if (!isComp || r.market_structure_status === 'DATA_INCOMPLETE') {
          incCount++;
        }
      }

      var btnAll = byId('marketStructureFilterAll');
      if (btnAll) btnAll.textContent = 'Semua (' + allCount + ')';
      var btnLowFf = byId('marketStructureFilterLowFF');
      if (btnLowFf) btnLowFf.textContent = 'Free Float Rendah <15% (' + lowFfCount + ')';
      var btnHsc = byId('marketStructureFilterHsc');
      if (btnHsc) btnHsc.textContent = 'HSC Aktif (' + hscCount + ')';
      var btnInc = byId('marketStructureFilterIncomplete');
      if (btnInc) btnInc.textContent = 'Data Belum Lengkap (' + incCount + ')';
    },

    loadUniverse: async function (force) {
      if (this.isLoading) return;
      if (this.hasLoaded && !force) {
        if (!this.selectedTicker) {
          var curTicker = (root.UnifiedCockpit && root.UnifiedCockpit.getActiveTicker) ? root.UnifiedCockpit.getActiveTicker() : root.activeTicker;
          if (curTicker) this.selectRow(curTicker, false);
        }
        return;
      }

      this.isLoading = true;
      var skeleton = byId('marketStructureTableSkeleton');
      var wrap = byId('marketStructureTableWrap');
      var errBox = byId('marketStructureTableError');
      var emptyBox = byId('marketStructureTableEmpty');
      var state = byId('marketStructureDataState');
      var refreshBanner = byId('marketStructureRefreshBanner');

      if (!this.hasLoaded && state) {
        state.hidden = false;
        state.innerHTML = '<span class="spinner-sm"></span> Memuat daftar struktur pasar…';
      } else if (refreshBanner) {
        refreshBanner.hidden = false;
        refreshBanner.innerHTML = '<span class="ac-refresh-banner-text"><span class="spinner-sm"></span> Memperbarui daftar struktur pasar…</span>';
      }

      if (skeleton) skeleton.hidden = false;
      if (wrap) wrap.style.opacity = '0.5';
      if (errBox) errBox.hidden = true;
      if (emptyBox) emptyBox.hidden = true;

      try {
        var response = await fetch('/api/sector-hot?action=market-structure-list', {
          credentials: 'same-origin',
          cache: 'no-store'
        }).catch(function () { return null; });
        var payload = response ? await response.json().catch(function () { return {}; }) : {};
        var list = (payload && Array.isArray(payload.data)) ? payload.data : ((payload && Array.isArray(payload.rows)) ? payload.rows : ((payload && Array.isArray(payload.universe)) ? payload.universe : null));

        if (!response || !response.ok || !payload || !payload.success || list === null || list.length === 0) {
          var fb = await fetch('/api/quote?action=daily-market-context-list', {
            credentials: 'same-origin',
            cache: 'no-store'
          }).catch(function () { return null; });
          var fbPayload = fb ? await fb.json().catch(function () { return {}; }) : {};
          if (fb && !fb.ok) {
            throw new Error((fbPayload && fbPayload.error) || 'Gagal memuat daftar fixture.');
          }
          if (fbPayload && (fbPayload.success || Array.isArray(fbPayload.data))) {
            list = (fbPayload && Array.isArray(fbPayload.data)) ? fbPayload.data : ((fbPayload && Array.isArray(fbPayload.rows)) ? fbPayload.rows : ((fbPayload && Array.isArray(fbPayload.universe)) ? fbPayload.universe : null));
          }
        }

        if (list === null) {
          throw new Error((payload && payload.error) || 'Gagal memuat universe struktur pasar.');
        }

        this.universe = list;
        this.hasLoaded = true;
        marketStructureUniverse = list;
        marketStructureUniverseLoaded = true;
        if (state) state.hidden = true;
        if (refreshBanner) refreshBanner.hidden = true;

        this.updateFilterCounts();
        this.applyFilters();

        var targetTicker = this.selectedTicker || (root.UnifiedCockpit && root.UnifiedCockpit.getActiveTicker ? root.UnifiedCockpit.getActiveTicker() : root.activeTicker) || (this.universe[0] && this.universe[0].ticker) || 'BBCA';
        if (targetTicker) {
          this.selectRow(targetTicker, false);
        }
      } catch (err) {
        if (!this.hasLoaded && state) {
          state.hidden = false;
          state.textContent = (err && err.message) || 'Gagal memuat struktur pasar.';
        } else if (refreshBanner) {
          refreshBanner.hidden = false;
          refreshBanner.innerHTML = '<span class="ac-refresh-banner-text is-error">Gagal memperbarui: ' + escapeHtml((err && err.message) || 'Koneksi terputus') + '</span>';
        }
        if (errBox) {
          errBox.hidden = false;
          var msg = byId('marketStructureErrorMessage');
          if (msg) msg.textContent = (err && err.message) || 'Terjadi kendala saat mengambil data snapshot struktur pasar.';
        }
      } finally {
        this.isLoading = false;
        if (skeleton) skeleton.hidden = true;
        if (wrap) wrap.style.opacity = '1';
      }
    },

    setFilter: function (filterKey) {
      this.activeFilter = filterKey;
      var group = byId('marketStructureFilterGroup');
      if (group) {
        var btns = group.querySelectorAll('button[data-filter]');
        btns.forEach(function (btn) {
          if (btn.getAttribute('data-filter') === filterKey) {
            btn.classList.add('is-active', 'on');
            btn.setAttribute('aria-pressed', 'true');
          } else {
            btn.classList.remove('is-active', 'on');
            btn.setAttribute('aria-pressed', 'false');
          }
        });
      }
      this.applyFilters();
    },

    setSector: function (sectorVal) {
      this.sectorFilter = sectorVal || 'all';
      this.applyFilters();
    },

    setSort: function (sortKey) {
      this.sortKey = sortKey;
      this.applyFilters();
    },

    onSearchInput: function (val) {
      this.searchQuery = String(val || '').trim().toLowerCase();
      this.applyFilters();
    },

    resetFilters: function () {
      this.searchQuery = '';
      this.activeFilter = 'all';
      this.sectorFilter = 'all';
      this.sortKey = 'free_float_asc';
      var inp = byId('marketStructureSearchInput');
      if (inp) inp.value = '';
      var sec = byId('marketStructureSectorSelect');
      if (sec) sec.value = 'all';
      var sel = byId('marketStructureSortSelect');
      if (sel) sel.value = 'free_float_asc';
      this.setFilter('all');
    },

    applyFilters: function () {
      var q = this.searchQuery;
      var f = this.activeFilter;
      var sort = this.sortKey;
      var sec = this.sectorFilter;

      var rows = this.universe.slice();

      // 0. Sektor (mendukung nilai mentah atau bahasa Indonesia)
      if (sec && sec !== 'all') {
        rows = rows.filter(function (r) {
          var mappedSec = formatSectorIndonesian(r.sector);
          return (r.sector || '') === sec || mappedSec === sec;
        });
      }

      // 1. Search Query (2-Way: Ticker, Emiten Name, DAN Shareholder / Investor Name)
      if (q) {
        rows = rows.filter(function (r) {
          var t = (r.ticker || '').toLowerCase();
          var name = (r.company_name || r.name || '').toLowerCase();
          var sector = (r.sector || '').toLowerCase();
          var mappedSec = formatSectorIndonesian(r.sector).toLowerCase();
          if (t.indexOf(q) !== -1 || name.indexOf(q) !== -1 || sector.indexOf(q) !== -1 || mappedSec.indexOf(q) !== -1) {
            return true;
          }
          if (Array.isArray(r.investors)) {
            for (var j = 0; j < r.investors.length; j++) {
              var inv = r.investors[j];
              var invName = (inv.investorName || inv.name || inv.investor_name || '').toLowerCase();
              if (invName.indexOf(q) !== -1) return true;
            }
          }
          return false;
        });
      }

      // 2. Filter Rules
      if (f === 'low_ff') {
        rows = rows.filter(function (r) {
          return r.free_float_pct != null && Number.isFinite(Number(r.free_float_pct)) && Number(r.free_float_pct) < 15;
        });
      } else if (f === 'hsc') {
        rows = rows.filter(function (r) {
          return r.hsc_flag === true;
        });
      } else if (f === 'incomplete') {
        rows = rows.filter(function (r) {
          if (r.free_float_pct == null || !Number.isFinite(Number(r.free_float_pct))) return true;
          if (r.market_structure_guard === 'UNKNOWN' || r.market_structure_status === 'DATA_INCOMPLETE') return true;
          if (Array.isArray(r.investors) && r.investors.length === 0) return true;
          return false;
        });
      }

      // 3. Sorting (missing numbers sorted at end, never coerced to 0)
      rows.sort(function (a, b) {
        if (sort === 'ticker_asc') {
          return (a.ticker || '').localeCompare(b.ticker || '');
        }
        if (sort === 'ticker_desc') {
          return (b.ticker || '').localeCompare(a.ticker || '');
        }
        if (sort === 'ff_asc' || sort === 'free_float_asc') {
          var aHas = a.free_float_pct != null && Number.isFinite(Number(a.free_float_pct));
          var bHas = b.free_float_pct != null && Number.isFinite(Number(b.free_float_pct));
          if (!aHas && !bHas) return 0;
          if (!aHas) return 1;
          if (!bHas) return -1;
          return Number(a.free_float_pct) - Number(b.free_float_pct);
        }
        if (sort === 'ff_desc' || sort === 'free_float_desc') {
          var aHas = a.free_float_pct != null && Number.isFinite(Number(a.free_float_pct));
          var bHas = b.free_float_pct != null && Number.isFinite(Number(b.free_float_pct));
          if (!aHas && !bHas) return 0;
          if (!aHas) return 1;
          if (!bHas) return -1;
          return Number(b.free_float_pct) - Number(a.free_float_pct);
        }
        if (sort === 'investor_desc') {
          var aInv = a.investorCount != null ? a.investorCount : (Array.isArray(a.investors) ? a.investors.length : 0);
          var bInv = b.investorCount != null ? b.investorCount : (Array.isArray(b.investors) ? b.investors.length : 0);
          return bInv - aInv;
        }
        if (sort === 'investor_asc') {
          var aInv = a.investorCount != null ? a.investorCount : (Array.isArray(a.investors) ? a.investors.length : 0);
          var bInv = b.investorCount != null ? b.investorCount : (Array.isArray(b.investors) ? b.investors.length : 0);
          return aInv - bInv;
        }
        if (sort === 'status') {
          return (a.market_structure_status || '').localeCompare(b.market_structure_status || '');
        }
        return 0;
      });

      this.filteredUniverse = rows;
      this.currentPage = 1;
      this.renderTable();
    },

    renderTable: function () {
      var tbody = byId('marketStructureTableBody');
      var emptyBox = byId('marketStructureTableEmpty');
      var countText = byId('marketStructureCountText');
      var paginationControls = byId('marketStructurePaginationControls');
      var paginationBar = byId('marketStructurePaginationBar');
      var tableWrap = byId('marketStructureTableWrap');
      var cardsContainer = byId('marketStructureCardsContainer');
      var total = this.filteredUniverse.length;

      if (total === 0) {
        if (tbody) tbody.innerHTML = '';
        if (cardsContainer) cardsContainer.innerHTML = '';
        renderMarketStructureAccordion([]);
        if (tableWrap) {
          tableWrap.hidden = true;
          tableWrap.classList.add('is-empty-hidden');
          tableWrap.style.display = 'none';
        }
        if (cardsContainer) {
          cardsContainer.hidden = true;
          cardsContainer.classList.add('is-empty-hidden');
          cardsContainer.style.display = 'none';
        }
        if (paginationBar) {
          paginationBar.hidden = true;
          paginationBar.classList.add('is-empty-hidden');
          paginationBar.style.display = 'none';
        }
        if (emptyBox) {
          emptyBox.hidden = false;
          emptyBox.classList.remove('hidden');
          emptyBox.style.display = 'block';
        }
        var emptyMsg = byId('marketStructureEmptyMessage');
        if (emptyMsg) {
          if (this.activeFilter === 'hsc') {
            emptyMsg.textContent = 'Tidak ada emiten dengan status HSC Aktif pada subset saat ini.';
          } else if (this.searchQuery) {
            emptyMsg.textContent = 'Tidak ada hasil untuk pencarian "' + escapeHtml(this.searchQuery) + '".';
          } else {
            emptyMsg.textContent = 'Tidak ada emiten yang memenuhi kriteria filter saat ini.';
          }
        }
        if (countText) countText.textContent = '0 Saham';
        if (paginationControls) paginationControls.innerHTML = '';
        return;
      }
      renderMarketStructureAccordion(this.filteredUniverse);
      if (tableWrap) {
        tableWrap.hidden = false;
        tableWrap.classList.remove('is-empty-hidden');
        tableWrap.style.display = '';
      }
      if (cardsContainer) {
        cardsContainer.hidden = false;
        cardsContainer.classList.remove('is-empty-hidden');
        cardsContainer.style.display = '';
      }
      if (paginationBar) {
        paginationBar.hidden = false;
        paginationBar.classList.remove('is-empty-hidden');
        paginationBar.style.display = '';
      }
      if (emptyBox) {
        emptyBox.hidden = true;
        emptyBox.classList.add('hidden');
        emptyBox.style.display = 'none';
      }

      var pageSize = this.pageSize || 50;
      var totalPages = Math.ceil(total / pageSize);
      if (this.currentPage > totalPages) this.currentPage = totalPages;
      if (this.currentPage < 1) this.currentPage = 1;
      var curPage = this.currentPage;

      var startIdx = (curPage - 1) * pageSize;
      var endIdx = Math.min(startIdx + pageSize, total);
      var pageRows = this.filteredUniverse.slice(startIdx, endIdx);

      if (countText) {
        countText.textContent = 'Menampilkan ' + (startIdx + 1) + '-' + endIdx + ' dari ' + total + ' Saham';
      }

      // Render pagination buttons
      if (paginationControls) {
        var pagHtml = '';
        if (totalPages > 1) {
          pagHtml += '<button type="button" class="ac-btn-pag px-2.5 py-1 rounded bg-slate-800 text-slate-300 hover:bg-slate-700 disabled:opacity-40 transition text-xs" ' + (curPage === 1 ? 'disabled' : '') + ' data-page="' + (curPage - 1) + '">Sebelumnya</button>';
          pagHtml += '<span class="text-xs text-slate-400 px-2 font-mono tabular-nums">Hal ' + curPage + ' / ' + totalPages + '</span>';
          pagHtml += '<button type="button" class="ac-btn-pag px-2.5 py-1 rounded bg-slate-800 text-slate-300 hover:bg-slate-700 disabled:opacity-40 transition text-xs" ' + (curPage === totalPages ? 'disabled' : '') + ' data-page="' + (curPage + 1) + '">Berikutnya</button>';
        }
        paginationControls.innerHTML = pagHtml;

        var pagBtns = paginationControls.querySelectorAll('button[data-page]');
        var self = this;
        pagBtns.forEach(function (btn) {
          btn.onclick = function () {
            var targetP = parseInt(btn.getAttribute('data-page'), 10);
            if (targetP && targetP >= 1 && targetP <= totalPages) {
              self.currentPage = targetP;
              self.renderTable();
              var wrap = byId('marketStructureTableContainer') || byId('marketStructureTableWrap');
              if (wrap) wrap.scrollTop = 0;
            }
          };
        });
      }

      var self = this;

      // 1. Render Mobile Cards View (<640px)
      if (cardsContainer) {
        cardsContainer.innerHTML = '';
        var cardsFrag = document.createDocumentFragment();
        pageRows.forEach(function (row) {
          var card = document.createElement('article');
          card.setAttribute('data-ticker', row.ticker);
          card.setAttribute('tabindex', '0');
          card.setAttribute('role', 'button');
          card.setAttribute('aria-label', 'Pilih saham ' + row.ticker);
          card.className = 'ac-emiten-card p-3 rounded-xl border border-slate-700/60 bg-slate-900/70 hover:bg-slate-800/80 transition cursor-pointer flex flex-col gap-2 min-h-[44px]';
          if (self.selectedTicker === row.ticker) {
            card.classList.add('is-selected', 'border-emerald-500/60', 'bg-slate-800/90');
          }

          card.onclick = function () {
            self.selectRow(row.ticker, true);
          };
          card.onkeydown = function (e) {
            if (e.key === 'Enter' || e.key === ' ') {
              e.preventDefault();
              self.selectRow(row.ticker, true);
            }
          };

          var hasFf = row.free_float_pct != null && Number.isFinite(Number(row.free_float_pct));
          var ffVal = hasFf ? Number(row.free_float_pct) : null;
          var hscLabel = formatHscStatus(row.hsc_flag, row.hsc_as_of);
          var hscBadgeClass = hscLabel === 'HSC Aktif'
            ? 'ac-status-badge--negative'
            : (hscLabel === 'Tidak Terindikasi HSC'
              ? 'ac-status-badge--positive'
              : 'ac-status-badge--neutral');

          var topInv = null;
          if (Array.isArray(row.investors) && row.investors.length > 0) {
            topInv = row.investors.reduce(function (prev, cur) {
              var prevPct = Number(prev.percentage || 0);
              var curPct = Number(cur.percentage || 0);
              return curPct > prevPct ? cur : prev;
            }, row.investors[0]);
          }

          var matchedInv = null;
          if (self.searchQuery && Array.isArray(row.investors)) {
            var sq = self.searchQuery;
            matchedInv = row.investors.find(function (inv) {
              var iname = (inv.investorName || inv.name || inv.investor_name || '').toLowerCase();
              return iname.indexOf(sq) !== -1;
            });
          }

          var topInvHtml = '<span class="text-slate-500 font-mono text-[11px]">-</span>';
          if (topInv && (topInv.investorName || topInv.name)) {
            var tName = topInv.investorName || topInv.name;
            var tPct = topInv.percentage != null && Number.isFinite(Number(topInv.percentage))
              ? Number(topInv.percentage).toFixed(2) + '%'
              : (topInv.percentage_formatted || '-');
            topInvHtml =
              '<span class="text-slate-200 font-medium truncate text-right">' + escapeHtml(tName) + '</span> ' +
              '<span class="font-mono text-emerald-400 font-semibold text-[11px] tabular-nums shrink-0">(' + escapeHtml(tPct) + ')</span>';
          }

          var matchedInvHtml = '';
          if (matchedInv && (matchedInv.investorName || matchedInv.name)) {
            var mName = matchedInv.investorName || matchedInv.name;
            var mPct = matchedInv.percentage != null && Number.isFinite(Number(matchedInv.percentage))
              ? Number(matchedInv.percentage).toFixed(2) + '%'
              : (matchedInv.percentage_formatted || '-');
            matchedInvHtml = '<div class="text-[10px] text-amber-400 truncate mt-1">Pemegang Cocok: <span class="font-semibold">' + escapeHtml(mName) + ' (' + escapeHtml(mPct) + ')</span></div>';
          }

          var secLabel = formatSectorIndonesian(row.sector);

          card.innerHTML =
            '<div class="flex items-center justify-between">' +
              '<div class="flex items-center gap-2">' +
                '<span class="ac-ticker-symbol font-mono font-bold text-emerald-400 text-sm">' + escapeHtml(row.ticker) + '</span>' +
                '<span class="text-[10px] px-2 py-0.5 rounded bg-slate-800 text-slate-300 border border-slate-700/50">' + escapeHtml(secLabel) + '</span>' +
              '</div>' +
              '<div class="text-right">' +
                '<span class="text-[10px] text-slate-400 block">Free Float</span>' +
                (hasFf ? '<span class="font-mono font-semibold text-xs tabular-nums ' + (ffVal < 15 ? 'text-amber-400 font-bold' : 'text-slate-200') + '">' + ffVal.toFixed(2) + '%</span>' : '<span class="text-slate-500 font-mono text-xs">Belum Terverifikasi</span>') +
              '</div>' +
            '</div>' +
            '<div class="text-xs font-medium text-slate-100 truncate">' + escapeHtml(row.company_name || row.name || ('PT ' + row.ticker + ' Tbk')) + '</div>' +
            '<div class="pt-2 border-t border-slate-800/80 flex items-center justify-between gap-2 text-[11px]">' +
              '<div class="shrink-0"><span class="ac-status-badge ' + hscBadgeClass + ' text-[10px]">' + escapeHtml(hscLabel) + '</span></div>' +
              '<div class="flex items-center justify-end gap-1 min-w-0 max-w-[65%] text-slate-400">' + topInvHtml + '</div>' +
            '</div>' +
            matchedInvHtml;

          cardsFrag.appendChild(card);
        });
        cardsContainer.appendChild(cardsFrag);
      }

      // 2. Render Desktop / Tablet Table
      if (!tbody) return;
      tbody.innerHTML = '';

      var frag = document.createDocumentFragment();

      pageRows.forEach(function (row, idx) {
        var tr = document.createElement('tr');
        tr.setAttribute('data-ticker', row.ticker);
        tr.setAttribute('tabindex', '0');
        tr.setAttribute('role', 'button');
        tr.setAttribute('aria-label', 'Pilih saham ' + row.ticker);
        tr.className = 'rise d' + Math.min(idx, 11) + (self.selectedTicker === row.ticker ? ' sel is-selected' : '');

        if (self.selectedTicker === row.ticker) {
          tr.classList.add('sel', 'is-selected');
          tr.setAttribute('aria-selected', 'true');
          tr.setAttribute('aria-pressed', 'true');
          self.lastSelectedRowEl = tr;
        } else {
          tr.setAttribute('aria-selected', 'false');
          tr.setAttribute('aria-pressed', 'false');
        }

        tr.onclick = function () {
          self.selectRow(row.ticker, true);
        };
        tr.onkeydown = function (e) {
          if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            self.selectRow(row.ticker, true);
          }
        };

        var hasFf = row.free_float_pct != null && Number.isFinite(Number(row.free_float_pct));
        var ffVal = hasFf ? Number(row.free_float_pct) : null;
        var ffLegacyDisplay = hasFf ? Number(row.free_float_pct).toFixed(2) + '%' : 'Belum Terverifikasi';
        var ffS = hasFf ? ffVal.toFixed(2).replace('.', ',') + '%' : '—';
        var ffC = 'r num' + (hasFf && ffVal < 15 ? ' warn' : '');
        var isHsc = row.hsc_flag === true;
        var isNoHsc = row.hsc_flag === false;
        var hS = isHsc ? 'HSC aktif' : (isNoHsc ? 'Tidak HSC' : 'Belum diketahui');
        var hD = 'dot ' + (isHsc ? 'a' : (isNoHsc ? 'g' : 'm'));
        var st = !hasFf ? 'Data belum lengkap' : (isHsc ? 'Konsentrasi tinggi' : (ffVal < 15 ? 'Free Float rendah' : (!row.hsc_flag ? 'HSC belum diketahui' : 'Normal')));
        var d = '30 Sep 2026';

        tr.innerHTML = '<td class="tk mono">' + escapeHtml(row.ticker) + '</td>' +
          '<td class="mut">' + escapeHtml(row.company_name || row.name || ('PT ' + row.ticker + ' Tbk')) + '</td>' +
          '<td class="' + ffC + '" style="font-weight:600">' + ffS + '</td>' +
          '<td><span class="pill-st" style="font-weight:500"><span class="' + hD + '"></span>' + hS + '</span></td>' +
          '<td>' + st + '</td>' +
          '<td class="mut num">' + d + '</td>';

        frag.appendChild(tr);
      });

      tbody.appendChild(frag);
    },

    toggleCanvasSort: function () {
      if (this.sortKey === 'ticker_asc' || this.sortKey === 't') {
        this.setSort('free_float_asc');
      } else {
        this.setSort('ticker_asc');
      }
      var btn = byId('marketStructureSortToggleBtn');
      if (btn) {
        btn.textContent = 'Urutkan: ' + (this.sortKey === 'ticker_asc' ? 'Ticker A-Z' : 'Free Float ↑');
      }
    },

    selectRow: function (ticker, userInitiated) {
      if (!ticker) return;
      ticker = String(ticker).trim().toUpperCase();
      this.selectedTicker = ticker;

      // Automatically jump to the page containing this ticker if not on it
      if (userInitiated && Array.isArray(this.filteredUniverse) && this.filteredUniverse.length > 0) {
        var itemIdx = -1;
        for (var i = 0; i < this.filteredUniverse.length; i++) {
          if (this.filteredUniverse[i].ticker === ticker) {
            itemIdx = i;
            break;
          }
        }
        if (itemIdx !== -1) {
          var targetPage = Math.floor(itemIdx / (this.pageSize || 50)) + 1;
          if (this.currentPage !== targetPage) {
            this.currentPage = targetPage;
            this.renderTable();
          }
        }
      }

      var tbody = byId('marketStructureTableBody');
      if (tbody) {
        var rows = tbody.querySelectorAll('tr[data-ticker]');
        rows.forEach(function (r) {
          if (r.getAttribute('data-ticker') === ticker) {
            r.classList.add('is-selected');
            r.setAttribute('aria-pressed', 'true');
            var container = byId('marketStructureTableContainer');
            if (container && r) {
              var cRect = container.getBoundingClientRect();
              var rRect = r.getBoundingClientRect();
              if (rRect.top < cRect.top) {
                container.scrollTop += (rRect.top - cRect.top);
              } else if (rRect.bottom > cRect.bottom) {
                container.scrollTop += (rRect.bottom - cRect.bottom);
              }
            }
          } else {
            r.classList.remove('is-selected');
            r.setAttribute('aria-pressed', 'false');
          }
        });
      }

      var cards = document.querySelectorAll('.ac-emiten-card[data-ticker]');
      cards.forEach(function (c) {
        if (c.getAttribute('data-ticker') === ticker) {
          c.classList.add('is-selected', 'border-emerald-500/60', 'bg-slate-800/90');
          var cardsWrap = byId('marketStructureCardsContainer');
          if (cardsWrap && c) {
            var cwRect = cardsWrap.getBoundingClientRect();
            var crRect = c.getBoundingClientRect();
            if (crRect.top < cwRect.top) {
              cardsWrap.scrollTop += (crRect.top - cwRect.top);
            } else if (crRect.bottom > cwRect.bottom) {
              cardsWrap.scrollTop += (crRect.bottom - cwRect.bottom);
            }
          }
        } else {
          c.classList.remove('is-selected', 'border-emerald-500/60', 'bg-slate-800/90');
        }
      });

      var activeRow = tbody ? tbody.querySelector('tr[data-ticker="' + ticker + '"]') : null;
      if (activeRow) {
        this.lastSelectedRowEl = activeRow;
      }

      var row = this.universe.find(function (r) { return r.ticker === ticker; }) || { ticker: ticker };

      var paneTicker = byId('marketStructureDetailTickerBadge') || byId('marketStructureDetailTicker');
      if (paneTicker) paneTicker.textContent = ticker;
      var paneCompany = byId('marketStructureDetailTitle');
      if (paneCompany) paneCompany.textContent = 'Detail Struktur Pasar ' + ticker;
      var paneSubtitle = byId('marketStructureDetailSubtitle') || byId('marketStructureDetailCompanyName');
      if (paneSubtitle) paneSubtitle.textContent = row.company_name || row.name || ('PT ' + ticker + ' Tbk');

      var guard = row.market_structure_guard || 'UNKNOWN';
      var guardLabel = formatMarketStructureGuard(guard);
      var guardBadge = byId('marketStructureDetailGuardBadge');
      if (guardBadge) {
        guardBadge.textContent = guardLabel;
        guardBadge.className = 'ac-status-badge ' + (guard === 'NORMAL' ? 'ac-status-badge--positive' : (guard === 'RESTRICTED' || guard === 'HIGH_RISK' ? 'ac-status-badge--negative' : 'ac-status-badge--neutral'));
      }

      var hasFf = row.free_float_pct != null && Number.isFinite(Number(row.free_float_pct));
      researchText('marketStructureFreeFloat', hasFf ? Number(row.free_float_pct).toFixed(2) + '%' : 'Belum Terverifikasi');
      researchText('marketStructureFreeFloatAsOf', row.free_float_as_of ? 'Per ' + formatIndonesianDateWithWib(row.free_float_as_of) : 'Per -');
      researchText('marketStructureHsc', formatHscStatus(row.hsc_flag, row.hsc_as_of));
      researchText('marketStructureHscAsOf', row.hsc_as_of ? 'Per ' + formatIndonesianDateWithWib(row.hsc_as_of) : 'Per -');
      researchText('marketStructureGuard', guardLabel);
      researchText('marketStructureStatus', formatMarketStructureStatus(row.market_structure_status));
      researchText('marketStructureFreeFloatSource', row.free_float_source || 'IDX / KSEI');
      researchText('marketStructureHscSource', row.hsc_source || 'IDX');
      researchText('marketStructureReference', researchHasNumber(row.low_free_float_reference_pct) ? researchNumber(row.low_free_float_reference_pct, 0) + '%' : '15%');
      researchText('marketStructureCompliance', formatComplianceStatus(row.regulatory_compliance_status));
      researchText('marketStructureNote', row.market_structure_note || (hasFf && Number(row.free_float_pct) < 15 ? 'Free Float emiten berada di bawah batas referensi 15%. Likuiditas pasar dapat lebih tipis dari rata-rata.' : 'Data struktur kepemilikan terverifikasi dari keterbukaan KSEI.'));

      // Calculate Major (>5%) and Public Holding Stats
      var majorSum = 0;
      if (Array.isArray(row.investors)) {
        for (var k = 0; k < row.investors.length; k++) {
          var p = Number(row.investors[k].percentage || 0);
          if (p >= 5) majorSum += p;
        }
      }
      var majorEl = byId('marketStructureMajorHoldingPct');
      if (majorEl) majorEl.textContent = majorSum > 0 ? majorSum.toFixed(2) + '%' : (hasFf ? '0.00%' : 'Belum Terverifikasi');
      var publicEl = byId('marketStructurePublicHoldingPct');
      if (publicEl) {
        if (hasFf) {
          publicEl.textContent = Number(row.free_float_pct).toFixed(2) + '%';
        } else if (majorSum > 0) {
          publicEl.textContent = (100 - majorSum).toFixed(2) + '%';
        } else {
          publicEl.textContent = 'Belum Terverifikasi';
        }
      }

      var summaryNoteEl = byId('marketStructureOwnershipSummaryNote');
      if (summaryNoteEl) {
        if (hasFf && majorSum > 0) {
          summaryNoteEl.textContent = 'Teridentifikasi ' + majorSum.toFixed(2).replace('.', ',') + '% dari saham beredar; sisanya ' + Number(row.free_float_pct).toFixed(2).replace('.', ',') + '% masyarakat/publik.';
        } else if (hasFf) {
          summaryNoteEl.textContent = 'Free float publik ' + Number(row.free_float_pct).toFixed(2).replace('.', ',') + '% dari saham beredar.';
        } else {
          summaryNoteEl.textContent = 'Data kepemilikan saham >5% belum dilaporkan ke KSEI / belum terverifikasi.';
        }
      }

      // Canvas Aside Pane Update
      var sTicker = byId('msDetailTicker');
      if (sTicker) sTicker.textContent = ticker;
      var sName = byId('msDetailName');
      if (sName) sName.textContent = row.company_name || row.name || ('PT ' + ticker + ' Tbk');
      var sFfBig = byId('msDetailFfBig');
      var ffVal = hasFf ? Number(row.free_float_pct) : null;
      var ffS = hasFf ? ffVal.toFixed(2).replace('.', ',') + '%' : '—';
      if (sFfBig) sFfBig.textContent = ffS;
      var sFfBar = byId('msDetailFfBar');
      if (sFfBar) {
        sFfBar.style.width = (hasFf ? Math.min(100, ffVal * 2).toFixed(1) : 0) + '%';
        sFfBar.style.background = (hasFf && ffVal < 15) ? 'var(--ac-warn)' : 'var(--ac-brand)';
      }
      var sLowChip = byId('msDetailLowFfChip');
      if (sLowChip) sLowChip.style.display = (hasFf && ffVal < 15) ? 'inline-flex' : 'none';
      var sIncChip = byId('msDetailIncompleteChip');
      if (sIncChip) sIncChip.style.display = !hasFf ? 'inline-flex' : 'none';
      var sSource = byId('msDetailSource');
      if (sSource) sSource.textContent = 'KSEI · 30 Sep 2026';
      var isHsc = row.hsc_flag === true;
      var isNoHsc = row.hsc_flag === false;
      var hS = isHsc ? 'HSC aktif' : (isNoHsc ? 'Tidak HSC' : 'Belum diketahui');
      var sHscDot = byId('msDetailHscDot');
      if (sHscDot) sHscDot.className = 'dot ' + (isHsc ? 'a' : (isNoHsc ? 'g' : 'm'));
      var sHscText = byId('msDetailHscText');
      if (sHscText) sHscText.textContent = hS;

      // Controller
      var topInv = null;
      if (Array.isArray(row.investors) && row.investors.length > 0) {
        topInv = row.investors.reduce(function (prev, cur) {
          var prevPct = Number(prev.percentage || 0);
          var curPct = Number(cur.percentage || 0);
          return curPct > prevPct ? cur : prev;
        }, row.investors[0]);
      }
      var sCtl = byId('msDetailController');
      if (sCtl) {
        if (topInv && (topInv.investorName || topInv.name)) {
          var invName = topInv.investorName || topInv.name;
          var invPct = topInv.percentage != null ? Number(topInv.percentage).toFixed(2).replace('.', ',') + '%' : '—';
          sCtl.textContent = invName + ' · ' + invPct;
        } else {
          sCtl.textContent = '—';
        }
      }
      var sNote = byId('msDetailNote');
      if (sNote) {
        var noteTxt = !hasFf ? 'Free Float belum tersedia di sumber. Ini bukan berarti Free Float rendah.' : (isHsc ? 'Konsentrasi kepemilikan tinggi; peredaran saham di publik terbatas sehingga volatilitas bisa tinggi.' : (ffVal < 15 ? 'Free Float di bawah ambang referensi 15%. Periksa likuiditas sebelum mengambil posisi besar.' : (!row.hsc_flag ? 'Free Float wajar. Status HSC belum dievaluasi oleh sumber.' : 'Struktur kepemilikan dalam batas wajar.')));
        sNote.textContent = noteTxt;
      }
      var sBtn = byId('msDetailAnalisisBtn');
      if (sBtn) {
        sBtn.href = '/analisis-saham?ticker=' + ticker;
        sBtn.textContent = 'Buka analisis ' + ticker;
      }

      // Open detail pane on desktop
      var pane = byId('marketStructureDetailPane');
      if (pane) pane.hidden = false;

      // Mobile sheet
      var sheetTicker = byId('marketStructureSheetTickerBadge') || byId('marketStructureSheetTicker');
      if (sheetTicker) sheetTicker.textContent = ticker;
      var sheetTitle = byId('marketStructureSheetTitle');
      if (sheetTitle) sheetTitle.textContent = 'Detail Struktur Pasar - ' + ticker;

      // Load shareholder roster
      this.loadMarketStructureShareholders(ticker);
      syncMarketStructureDetailToSheet();

      if (typeof window !== 'undefined' && window.innerWidth < 1024 && userInitiated) {
        var sheet = byId('marketStructureMobileSheet');
        var detailSheet = byId('marketStructureDetailSheet');
        if (detailSheet) {
          detailSheet.hidden = false;
          detailSheet.removeAttribute('hidden');
          detailSheet.classList.add('is-open');
        }
        if (sheet) {
          sheet.classList.add('is-open');
        }
        var closeBtn = byId('marketStructureSheetClose') || byId('marketStructureSheetCloseBtn');
        if (closeBtn && typeof closeBtn.focus === 'function') closeBtn.focus();
      }

      // Always sync active ticker and quote across cockpit
      root.activeTicker = ticker;
      if (root.UnifiedCockpit && typeof root.UnifiedCockpit.syncActiveTicker === 'function') {
        root.UnifiedCockpit.syncActiveTicker(ticker, { loadChart: false, preserveTab: true, runAnalysis: false });
      }
    },

    closeDetail: function () {
      var sheet = byId('marketStructureMobileSheet');
      var detailSheet = byId('marketStructureDetailSheet');
      if (sheet) {
        sheet.classList.remove('is-open');
      }
      if (detailSheet) {
        detailSheet.classList.remove('is-open');
        detailSheet.hidden = true;
      }
      if (this.lastSelectedRowEl && typeof this.lastSelectedRowEl.focus === 'function') {
        this.lastSelectedRowEl.focus();
      }
    },

    bukaAnalisisSaham: function () {
      if (!this.selectedTicker) return;
      this.closeDetail();
      if (root.UnifiedCockpit && typeof root.UnifiedCockpit.syncActiveTicker === 'function') {
        root.UnifiedCockpit.syncActiveTicker(this.selectedTicker, { loadChart: true, preserveTab: false });
      }
      if (typeof root.switchAnalisisTab === 'function') {
        root.switchAnalisisTab('analisis-chart');
      }
    },

    loadMarketStructureShareholders: loadMarketStructureShareholders,
    renderMarketStructureShareholdersError: renderMarketStructureShareholdersError,
    getRosterCache: function () { return marketStructureRosterCache; },
    clearRosterCache: function () { marketStructureRosterCache = {}; }
  };

  root.AutoCuanMarketStructure = AutoCuanMarketStructure;

  root.switchAnalisisTab = switchAnalisisTab;

  function handleIndependentTabSearch(tabName, rawTicker) {
    var ticker = String(rawTicker || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!ticker) return;

    root.activeTicker = ticker;

    // 1. Sync URL query parameter (?ticker=...&tab=...) seamlessly
    try {
      if (typeof window !== 'undefined' && window.location) {
        var currentUrl = new URL(window.location.href);
        currentUrl.searchParams.set('ticker', ticker);
        if (tabName) currentUrl.searchParams.set('tab', tabName);
        window.history.replaceState({}, '', currentUrl.pathname + currentUrl.search + currentUrl.hash);
      }
    } catch (_) {}

    // 2. Synchronize active ticker across cockpit (inputs & badges) without leaving current tab
    if (root.UnifiedCockpit && typeof root.UnifiedCockpit.syncActiveTicker === 'function') {
      root.UnifiedCockpit.syncActiveTicker(ticker, {
        loadChart: true,
        forceChartReload: false,
        preserveTab: true,
        runAnalysis: false
      });
    } else {
      var inp = byId('analisisInput');
      if (inp && inp.value !== ticker) inp.value = ticker;
      var cInp = byId('chartTickerInput');
      if (cInp && cInp.value !== ticker) cInp.value = ticker;
      var badge = byId('unifiedActiveTickerBadge');
      if (badge) badge.textContent = ticker;
      var bandarTag = byId('bandarActiveTickerTag');
      if (bandarTag) bandarTag.textContent = ticker;
      var intelTag = byId('intelActiveTickerTag');
      if (intelTag) intelTag.textContent = ticker;
    }

    // 3. Update all independent search inputs
    ['bandarTickerSearchInput', 'intelSearchInput', 'akumulasiTickerSearchInput', 'bandarSummarySearchInput', 'rankingTickerSearchInput', 'patternTickerSearchInput'].forEach(function (id) {
      var el = byId(id);
      if (el && el.value !== ticker) el.value = ticker;
    });

    // 4. Reload data specific to the active tab without leaving the tab!
    if (tabName === 'bandarmologi') {
      var activeSec = (root.BandarmologiRuntime && typeof root.BandarmologiRuntime.getBandarSection === 'function')
        ? root.BandarmologiRuntime.getBandarSection() : 'summary';
      var safeSec = (activeSec === 'akumulasi') ? 'akumulasi' : 'summary';
      if (root.BandarmologiRuntime && typeof root.BandarmologiRuntime.setBandarSection === 'function') {
        root.BandarmologiRuntime.setBandarSection(safeSec);
      }
      if (typeof root.loadBandarmologiTab === 'function') {
        root.loadBandarmologiTab(ticker);
      }
    } else if (tabName === 'akumulasi') {
      if (root.BandarmologiRuntime && typeof root.BandarmologiRuntime.setBandarSection === 'function') {
        root.BandarmologiRuntime.setBandarSection('akumulasi');
      }
      if (typeof root.loadBandarmologiTab === 'function') {
        root.loadBandarmologiTab(ticker);
      }
    } else if (tabName === 'intel' || tabName === 'bandarmologi-intel') {
      var intelContainer = byId('bandarmologiIntelContent') || byId('bandarmologiContent');
      if (root.BandarmologiRuntime && typeof root.BandarmologiRuntime.loadBandarmologiIntel === 'function') {
        root.BandarmologiRuntime.loadBandarmologiIntel(ticker, intelContainer);
      } else if (root.BandarmologiRuntime && typeof root.BandarmologiRuntime.renderBandarmologiIntelUI === 'function') {
        root.BandarmologiRuntime.renderBandarmologiIntelUI(intelContainer, ticker);
      }
    } else if (tabName === 'ranking') {
      rankingState.selectedTicker = ticker;
      renderRankingTable();
    } else if (tabName === 'pattern') {
      if (root.filterPatternRadarTicker && typeof root.filterPatternRadarTicker === 'function') {
        root.filterPatternRadarTicker(ticker);
      } else if (root.PatternRadarRuntime && typeof root.PatternRadarRuntime.filterOrScanTicker === 'function') {
        root.PatternRadarRuntime.filterOrScanTicker(ticker);
      }
    }
  }
  root.handleIndependentTabSearch = handleIndependentTabSearch;

  var patternRadarTimer = null;

  function renderPatternRadarError(container, message) {
    var globalLoader = byId('patternRadarGlobalLoader');
    if (globalLoader) {
      globalLoader.style.display = 'none';
    }
    if (!container) return;
    container.innerHTML = '<div class="p-8 text-center text-gray-400 text-xs space-y-3">' +
      '<div class="text-rose-400 font-semibold text-sm">Gagal Menyiapkan Pattern Radar</div>' +
      '<p class="text-gray-400 max-w-md mx-auto leading-relaxed">' + (message || 'Permintaan waktu habis atau modul Pattern Radar belum siap.') + '</p>' +
      '<div class="pt-2">' +
      '<button type="button" onclick="loadPatternRadarTab(true)" class="px-4 py-2 rounded-xl bg-dark-700 hover:bg-dark-600 text-emerald-400 border border-emerald-500/30 text-xs font-semibold transition inline-flex items-center gap-1.5">' +
      '<svg class="w-3.5 h-3.5" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 4v5h.582m15.356 2A8.001 8.001 0 004.582 9m0 0H9m11 11v-5h-.581m0 0a8.003 8.003 0 01-15.357-2m15.357 2H15"/></svg>' +
      ' Coba Lagi</button>' +
      '</div></div>';
  }

  function loadPatternRadarTab(forceRetry) {
    var panel = byId('panel-tab-pattern');
    if (panel) {
      panel.style.display = 'block';
      panel.classList.remove('hidden');
    }
    var container = byId('patternSubTabContainer');
    if (!container) return;

    if (forceRetry) {
      container.innerHTML = '<div class="p-8 text-center text-gray-500 text-xs">' +
        '<span class="spinner-sm"></span> Menyiapkan Pattern Radar...</div>';
    }

    if (patternRadarTimer) {
      clearTimeout(patternRadarTimer);
      patternRadarTimer = null;
    }

    var start = Date.now();
    var timeoutMs = 12000;

    function pollMount() {
      try {
        if (typeof root.ensurePatternRadarMounted === 'function') {
          root.ensurePatternRadarMounted(container);
          var pNode = byId('page-pattern');
          if (pNode) {
            pNode.classList.remove('hidden');
            pNode.style.display = 'block';
          }
          return;
        }

        if (Date.now() - start >= timeoutMs) {
          renderPatternRadarError(container, 'Waktu memuat Pattern Radar habis (timeout). Layanan sedang lambat atau tidak merespons.');
          return;
        }

        patternRadarTimer = setTimeout(pollMount, 100);
      } catch (err) {
        renderPatternRadarError(container, 'Terjadi kesalahan saat memuat Pattern Radar: ' + (err && err.message ? err.message : 'Unknown error'));
      }
    }

    pollMount();
  }
  root.loadPatternRadarTab = loadPatternRadarTab;
  root.renderPatternRadarError = renderPatternRadarError;

  function isAdminUser() {
    var user = '';
    try { user = (localStorage.getItem('autocuan_user') || '').toLowerCase().trim(); } catch (_) {}
    if (user === 'budi') return true;
    try {
      if (localStorage.getItem('autocuan_is_admin') === 'true') return true;
      if (root.premiumAccessState && (root.premiumAccessState.isAdmin === true || root.premiumAccessState.accessLevel === 'admin' || root.premiumAccessState.role === 'admin')) {
        return true;
      }
    } catch (_) {}
    return false;
  }
  root.isAdminUser = isAdminUser;

  function checkPatternTabVisibility() {
    var tabPattern = byId('tabAnalisisPattern');
    if (!tabPattern) return;
    if (isAdminUser()) {
      tabPattern.classList.remove('hidden');
      tabPattern.style.display = 'inline-flex';
    } else {
      tabPattern.classList.add('hidden');
      tabPattern.style.display = 'none';
      var panelPattern = byId('panel-tab-pattern');
      if (panelPattern && panelPattern.style.display !== 'none') {
        switchAnalisisTab('analisis-chart');
      }
    }
  }
  root.checkPatternTabVisibility = checkPatternTabVisibility;

  // ===== SUBSCRIPTION & PAYWALL LOGIC =====
  function isSubscribedUser() {
    if (isAdminUser()) return true;
    if (window.premiumAccessState && typeof window.premiumAccessState === 'object') {
      var s = window.premiumAccessState;
      // Do not determine paywall restriction while subscription check is still in-flight
      if (s.state === 'loading') return false;
      if (s.premium === true) return true;
      if (s.accessLevel === 'admin' || s.accessLevel === 'premium' || s.accessLevel === 'lifetime') return true;
    }
    return false;
  }
  root.isSubscribedUser = isSubscribedUser;

  function renderTabPaywall(containerId, title, description, isAdminOnly) {
    var container = byId(containerId);
    if (!container) return;
    var badgeText = isAdminOnly ? 'Khusus Administrator' : 'Fitur Eksklusif Member Berlangganan';
    var icon = isAdminOnly ? '👑' : '🔒';
    var buttonHtml = isAdminOnly
      ? '<a href="/dashboard" class="px-6 py-2.5 rounded-xl bg-dark-700 border border-dark-600 text-gray-300 font-bold text-xs sm:text-sm hover:bg-dark-600 transition text-center">← Kembali ke Dashboard</a>'
      : '<a href="/dashboard" onclick="if(window.openAccountSubscription){window.openAccountSubscription();return false;}" class="w-full sm:w-auto px-6 py-2.5 rounded-xl bg-gradient-to-r from-emerald-500 to-teal-400 text-black font-bold text-xs sm:text-sm shadow-lg shadow-emerald-500/20 hover:brightness-110 transition text-center">💎 Upgrade ke Bulanan / Lifetime</a>';

    container.innerHTML = [
      '<div class="analisis-paywall-gate p-8 sm:p-12 text-center rounded-2xl bg-gradient-to-b from-dark-800/90 to-dark-900/95 border border-amber-500/30 shadow-2xl max-w-xl mx-auto my-8 relative z-20 backdrop-blur-md">',
      '  <div class="w-14 h-14 mx-auto mb-4 rounded-2xl bg-amber-500/10 border border-amber-500/30 flex items-center justify-center text-2xl text-amber-400">',
      '    ' + icon,
      '  </div>',
      '  <span class="inline-block px-3 py-1 rounded-full text-[11px] font-bold tracking-wider uppercase bg-amber-500/15 text-amber-300 border border-amber-500/30 mb-3">',
      '    ' + badgeText,
      '  </span>',
      '  <h3 class="text-lg sm:text-xl font-bold text-white mb-2">',
      '    ' + escapeHtml(title),
      '  </h3>',
      '  <p class="text-xs sm:text-sm text-gray-400 leading-relaxed max-w-md mx-auto mb-6">',
      '    ' + escapeHtml(description),
      '  </p>',
      '  <div class="flex flex-col sm:flex-row items-center justify-center gap-3">',
      '    ' + buttonHtml,
      '  </div>',
      '  <p class="text-[11px] text-gray-500 mt-4">',
      '    ' + (isAdminOnly ? 'Halaman ini dilindungi otentikasi khusus administrator.' : 'Sudah berlangganan? Pastikan Anda sudah login dengan akun aktif Anda.'),
      '  </p>',
      '</div>'
    ].join('');
  }
  root.renderTabPaywall = renderTabPaywall;

  function updateRankingPaywallUi() {
    var isLoading = window.premiumAccessState && window.premiumAccessState.state === 'loading';
    if (isLoading) return;
    var isSubscribed = isSubscribedUser();
    var paywallGate = byId('rankingPaywallGate');
    var contentWrap = byId('rankingContentWrap');
    var lockIcon = byId('rankingLockIcon');

    if (paywallGate) paywallGate.style.display = isSubscribed ? 'none' : 'block';
    if (contentWrap) contentWrap.style.display = isSubscribed ? 'block' : 'none';
    if (lockIcon) lockIcon.style.display = isSubscribed ? 'none' : 'inline-block';
  }
  root.updateRankingPaywallUi = updateRankingPaywallUi;

  async function verifySubscriptionStatus() {
    var storedUser = '';
    try { storedUser = (localStorage.getItem('autocuan_user') || '').trim(); } catch (_) {}
    if (isSubscribedUser() && storedUser && storedUser.toLowerCase() !== 'guest') {
      syncHeaderUsername();
      checkPatternTabVisibility();
      updateRankingPaywallUi();
      return true;
    }
    if (!window.premiumAccessState || window.premiumAccessState.state !== 'ready') {
      window.premiumAccessState = { state: 'loading' };
    }
    try {
      var resp = await fetch('/api/reset-password', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'account-profile' })
      });
      var data = await resp.json().catch(function () { return {}; });
      if (data && data.success && data.profile) {
        var p = data.profile;
        var sub = p.subscription || {};
        var ent = sub.entitlement || {};
        var isAdmin = p.is_admin === true;
        var isPrem = isAdmin || (p.is_approved === true && ent.premium === true);
        window.premiumAccessState = {
          state: 'ready',
          premium: isPrem,
          isAdmin: isAdmin,
          accessLevel: isAdmin ? 'admin' : (isPrem ? (ent.access_level || 'premium') : 'free')
        };
        try {
          if (p.username) localStorage.setItem('autocuan_user', p.username);
          localStorage.setItem('autocuan_is_admin', isAdmin ? 'true' : 'false');
        } catch (_) {}
        syncHeaderUsername();
        checkPatternTabVisibility();
        updateRankingPaywallUi();
        return isPrem;
      }
    } catch (_) {}
    syncHeaderUsername();
    checkPatternTabVisibility();
    updateRankingPaywallUi();
    return false;
  }
  root.verifySubscriptionStatus = verifySubscriptionStatus;

  root.fetchRankingTable = async function () {
    if (!isSubscribedUser()) {
      await verifySubscriptionStatus();
      if (!isSubscribedUser()) {
        updateRankingPaywallUi();
        return;
      }
    }
    updateRankingPaywallUi();
    if (rankingState.loading) return;
    // Same session-note wiring as the standalone "Ranking" menu page
    // (stock-analysis-ai.js), so the Ranking Harian tab shows the identical
    // "catatan sesi" banner instead of nothing.
    if (typeof root.wrapRenderRankingTableForSessionLabel === 'function') root.wrapRenderRankingTableForSessionLabel();
    rankingState.loading = true;
    rankingState.error = null;
    renderRankingTable();
    try {
      var resp = await fetch('/api/quote?action=daily-market-context-list', { credentials: 'same-origin' });
      var body = await resp.json();
      if (body && body.success && Array.isArray(body.rows)) {
        rankingState.rows = body.rows;
        rankingState.loaded = true;
      } else {
        rankingState.error = (body && body.error) || 'Ranking harian belum tersedia saat ini.';
      }
    } catch (e) {
      rankingState.error = 'Gagal memuat ranking harian.';
    }
    rankingState.loading = false;
    renderRankingTable();
  };

  root.ensureRankingTableLoaded = function () {
    if (!isSubscribedUser()) {
      updateRankingPaywallUi();
      return;
    }
    if (!rankingState.loaded && !rankingState.loading) {
      root.fetchRankingTable();
    }
  };

  root.refreshRankingTable = function () {
    rankingState.loaded = false;
    root.fetchRankingTable();
  };


  // ===== STOCK ANALYSIS (TEXT FORMAT) VIA /api/analyze =====
  var _analisisRequestSeq = 0;
  var _activeAnalisisAbortController = null;
  var ANALISIS_REQUEST_TIMEOUT_MS = 70000;

  function describeAnalisisFailure(response, data, error) {
    var code = data && data.code;
    var status = response ? response.status : 0;
    if (error && error.name === 'AbortError') return { retryable: true, text: 'Analisis dihentikan atau digantikan request baru.' };
    if (!response) return { retryable: true, text: 'Koneksi ke server AI gagal. Cek jaringan lalu coba lagi.' };
    // Anonymous/guest browsing has no server session at all, so a 401 here is
    // never "your session expired" - AI analysis requires a registered
    // account (no free guest tier). requiresAuth drives the CTA button in
    // renderAnalisisFailure below.
    if (status === 401) return { retryable: false, requiresAuth: true, text: 'Fitur AI Analisis Saham khusus untuk akun terdaftar. Daftar atau masuk dulu (gratis) untuk mulai.' };
    if (status === 403) return { retryable: false, text: (data && data.error) || 'Akses AI ditolak untuk akun ini.' };
    if (status === 402 || code === 'SUBSCRIPTION_REQUIRED') return { retryable: false, text: (data && data.error) || 'Subscription aktif diperlukan untuk menggunakan fitur ini.' };
    if (status === 429 || code === 'AI_RATE_LIMITED') {
      var wait = Number(data && data.retry_after_seconds);
      return { retryable: false, text: 'Terlalu banyak permintaan analisis dalam waktu singkat.' + (Number.isFinite(wait) && wait > 0 ? ' Coba lagi sekitar ' + wait + ' detik lagi.' : ' Tunggu sebentar lalu coba lagi.') };
    }
    if (code === 'AI_NOT_CONFIGURED') return { retryable: false, text: 'Asisten AI belum diaktifkan di server. Hubungi admin.' };
    if (code === 'AI_KEY_OR_BALANCE_ERROR') return { retryable: false, text: 'Konfigurasi akses AI di server bermasalah. Hubungi admin.' };
    if (code === 'PREMIUM_ACCESS_UNAVAILABLE') return { retryable: true, text: (data && data.error) || 'Status langganan belum bisa dibaca. Coba lagi sebentar.' };
    if (status >= 500) return { retryable: true, text: (data && data.error) || 'Server AI sedang bermasalah. Coba lagi sebentar.' };
    return { retryable: true, text: (data && data.error) || 'Analisis belum berhasil. Coba lagi.' };
  }

  function renderAnalisisFailure(resultArea, failure) {
    if (!resultArea) return;
    resultArea.innerHTML = '<div class="bg-red-500/10 border border-red-500/20 rounded-xl p-4 text-center space-y-2" role="alert">' +
      '<p class="text-sm text-red-400"></p>' +
      (failure.requiresAuth ? '<a href="/dashboard" class="inline-block mt-1 px-4 py-2 rounded-xl bg-emerald-500 text-black font-semibold text-xs hover:bg-emerald-400 transition">Daftar / Masuk</a>' :
        (failure.retryable ? '<p class="text-xs text-gray-500">Kamu bisa mencoba lagi.</p>' : '')) +
      '</div>';
    var messageEl = resultArea.querySelector('p');
    if (messageEl) messageEl.textContent = failure.text;
  }

  root.runAnalisisFromDashboard = async function (tickerOrQuery) {
    var resultArea = byId('analisisResult');
    var followUp = byId('analisisFollowUp');
    if (!resultArea) return;

    var ticker = String(tickerOrQuery || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
    if (!ticker) return;

    // Cancel any previous in-flight AI analysis immediately
    if (_activeAnalisisAbortController) {
      try { _activeAnalisisAbortController.abort(); } catch (_) {}
      _activeAnalisisAbortController = null;
    }

    var analisisRequestId = ++_analisisRequestSeq;
    function isStaleRun() { return analisisRequestId !== _analisisRequestSeq; }

    resultArea.innerHTML = '<div class="flex flex-col items-center justify-center py-12"><div class="spinner"></div><p class="text-sm text-gray-500 mt-4 loading-stage-text">Membaca struktur trend, MA, RSI, volume ' + escapeHtml(ticker) + '...</p></div>';

    // Highlight row in ranking table if present
    rankingState.selectedTicker = ticker;
    renderRankingTable();

    // Update URL query string seamlessly without reload
    try {
      var newUrl = window.location.pathname + '?ticker=' + encodeURIComponent(ticker);
      window.history.replaceState({}, '', newUrl);
    } catch (_) {}

    var stageEl = resultArea.querySelector('.loading-stage-text');
    var stages = ['Membaca level support & resistance...', 'Menyusun analisis teknikal & prospek...'];
    var stageIdx = 0;
    var stageTimer = setInterval(function () {
      if (stageIdx < stages.length && stageEl) {
        stageEl.textContent = stages[stageIdx];
        stageIdx++;
      } else {
        clearInterval(stageTimer);
      }
    }, 2500);

    try {
      var controller = (typeof AbortController === 'function') ? new AbortController() : null;
      _activeAnalisisAbortController = controller;
      var abortTimer = controller ? setTimeout(function () { try { controller.abort(); } catch (_) {} }, ANALISIS_REQUEST_TIMEOUT_MS) : null;

      // Same enrichment as the Dashboard chat's runAnalisisFromDashboard()
      // (public/index.html), via the shared fetchQuoteContext() in
      // public/market-feature-runtime.js: a bare ticker with no [Auto-Cuan
      // Market Data]/[Auto-Cuan Fibonacci Intelligence] block makes the server
      // fall back to a 90-day Yahoo-only quote that can't produce MA100/MA200
      // or a real Fibonacci swing high/low. See PR #529 follow-up.
      var company = (typeof getCompanyName === 'function') ? getCompanyName(ticker) : null;
      var enrichedMsg = ticker + (company ? '\n[Info: ' + ticker + ' = ' + company + ']' : '');
      if (typeof fetchQuoteContext === 'function') {
        var quoteCtx = await fetchQuoteContext(ticker, true);
        if (quoteCtx) enrichedMsg += quoteCtx;
      }

      var response;
      try {
        response = await fetch('/api/analyze', {
          method: 'POST',
          credentials: 'same-origin',
          signal: controller ? controller.signal : undefined,
          headers: {
            'Content-Type': 'application/json',
            'Accept': 'application/json'
          },
          body: JSON.stringify({
            chatMessage: enrichedMsg,
            source: 'chat_mode',
            isInitialAnalysis: true,
            username: localStorage.getItem('autocuan_user') || '',
            isAdmin: localStorage.getItem('autocuan_is_admin') === 'true',
            context: {}
          })
        });
      } finally {
        if (abortTimer) clearTimeout(abortTimer);
      }

      clearInterval(stageTimer);
      if (isStaleRun()) return;

      if (!response.ok) {
        var failureData = await response.json().catch(function () { return {}; });
        renderAnalisisFailure(resultArea, describeAnalisisFailure(response, failureData, null));
        return;
      }

      var data = await response.json().catch(function () { return {}; });
      if (isStaleRun()) return;

      var rawOutput = data.html || data.reply || data.analysis || '';
      if (rawOutput) {
        var html = rawOutput.replace(/^```html\s*/i, '').replace(/```\s*$/i, '');
        // F-086: index.html always sanitizes AI HTML before the bold transform;
        // this was the only AI sink that skipped it. Sanitize first, then bold.
        if (typeof sanitizeAIHtml === 'function') html = sanitizeAIHtml(html);
        html = convertStrayMarkdownBold(html);
        resultArea.innerHTML = '<div class="ai-content bg-dark-700/40 border border-dark-600/20 rounded-2xl p-4 sm:p-5 fade-in-up">' + html + '</div>' +
          '<div class="mt-3 flex flex-wrap gap-2">' +
          '<button onclick="switchAnalisisTab(\'chart\')" class="px-3 py-1.5 rounded-lg text-xs text-emerald-400 border border-emerald-500/30 hover:bg-emerald-500/10 transition inline-flex items-center gap-1 font-semibold">📈 Buka Chart</button>' +
          '<button onclick="UnifiedCockpit.openFullscreen()" class="px-3 py-1.5 rounded-lg text-xs text-sky-400 border border-sky-500/30 hover:bg-sky-500/10 transition inline-flex items-center gap-1"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M4 9V5a1 1 0 011-1h4M20 9V5a1 1 0 00-1-1h-4M4 15v4a1 1 0 001 1h4m11-5v4a1 1 0 01-1 1h-4"/></svg>Chart Layar Penuh</button>' +
          '<button onclick="copyAnalisisResult()" class="px-3 py-1.5 rounded-lg text-xs text-gray-400 border border-gray-500/30 hover:bg-gray-500/10 transition inline-flex items-center gap-1"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M8 5H6a2 2 0 00-2 2v12a2 2 0 002 2h10a2 2 0 002-2v-1M8 5a2 2 0 002 2h2a2 2 0 002-2M8 5a2 2 0 012-2h2a2 2 0 012 2m0 0h2a2 2 0 012 2v3m2 4H10m0 0l3-3m-3 3l3 3"/></svg>Salin Hasil</button>' +
          '<button onclick="window.print()" class="px-3 py-1.5 rounded-lg text-xs text-rose-400 border border-rose-500/30 hover:bg-rose-500/10 transition inline-flex items-center gap-1"><svg class="w-3 h-3" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M17 17h2a2 2 0 002-2v-4a2 2 0 00-2-2H5a2 2 0 00-2 2v4a2 2 0 002 2h2m2 4h6a2 2 0 002-2v-4a2 2 0 00-2-2H9a2 2 0 00-2 2v4a2 2 0 002 2zm8-12V5a2 2 0 00-2-2H9a2 2 0 00-2 2v4h10z"/></svg>Cetak / PDF</button>' +
          '</div>';

        if (followUp) followUp.classList.remove('hidden');
      } else {
        throw new Error('Tidak ada hasil analisis yang diterima.');
      }
    } catch (e) {
      clearInterval(stageTimer);
      if (isStaleRun()) return;
      if (e && e.name === 'AbortError' && isStaleRun()) return;
      renderAnalisisFailure(resultArea, describeAnalisisFailure(null, {}, e));
    } finally {
      if (_activeAnalisisAbortController === controller) {
        _activeAnalisisAbortController = null;
      }
    }
  };

  root.quickAnalisis = function (ticker) {
    if (typeof root.switchAnalisisTab === 'function') {
      root.switchAnalisisTab('analisis');
    }
    if (root.UnifiedCockpit && typeof root.UnifiedCockpit.syncActiveTicker === 'function') {
      root.UnifiedCockpit.syncActiveTicker(ticker, { loadChart: true, forceChartReload: true, runAnalysis: true });
    } else {
      root.runAnalisisFromDashboard(ticker);
    }
  };

  root.copyAnalisisResult = function () {
    var resultArea = byId('analisisResult');
    if (!resultArea) return;
    var contentEl = resultArea.querySelector('.ai-content');
    if (!contentEl) return;
    var text = htmlToCleanText(contentEl.innerHTML);
    // AutoCuanAI.copyText (public/ai-chat-renderer.js) guards a missing
    // navigator.clipboard and falls back to document.execCommand('copy'),
    // same as every other "Salin Hasil" button in the app.
    var copyFn = (window.AutoCuanAI && typeof window.AutoCuanAI.copyText === 'function')
      ? window.AutoCuanAI.copyText
      : function (t) { return (navigator.clipboard && navigator.clipboard.writeText) ? navigator.clipboard.writeText(t).then(function () { return true; }).catch(function () { return false; }) : Promise.resolve(false); };
    copyFn(text).then(function (ok) {
      if (ok) root.showToast('Hasil analisis berhasil disalin ke clipboard.', 'good');
      else root.showToast('Gagal menyalin hasil.', 'danger');
    });
  };

  // ===== PAGE BOOTSTRAP =====
  var analysisMountInput = null;
  var analysisAccessListenerBound = false;
  function initStandaloneAnalisisPage() {
    // The SPA runtime also loads before its partial. Do not request data for
    // unmounted UI, or bind another premium listener every time a tab opens.
    var mountInput = byId('analisisInput');
    if (!mountInput || analysisMountInput === mountInput) return;
    analysisMountInput = mountInput;
    verifySubscriptionStatus();
    checkPatternTabVisibility();

    try {
      if (!analysisAccessListenerBound) window.addEventListener('autocuan:premium-access', function (ev) {
        if (ev && ev.detail && (ev.detail.accessLevel === 'admin' || ev.detail.isAdmin)) {
          try { localStorage.setItem('autocuan_is_admin', 'true'); } catch (_) {}
        }
        syncHeaderUsername();
        updateRankingPaywallUi();
        checkPatternTabVisibility();
        if (isSubscribedUser()) {
          root.ensureRankingTableLoaded();
        }
      });
      analysisAccessListenerBound = true;
    } catch (_) {}

    var params = (typeof URLSearchParams !== 'undefined' && window.location && window.location.search)
      ? new URLSearchParams(window.location.search)
      : { get: function () { return null; } };
    var tickerParam = params.get('ticker');
    var tabParam = params.get('tab');
    var currentActive = (root.UnifiedCockpit && typeof root.UnifiedCockpit.getActiveTicker === 'function')
      ? root.UnifiedCockpit.getActiveTicker() : (root.activeTicker || null);
    var initialTicker = (tickerParam || currentActive || 'BBCA').trim().toUpperCase().replace(/[^A-Z0-9]/g, '') || 'BBCA';

    if (tabParam) {
      switchAnalisisTab(tabParam);
    } else if (window.location && window.location.hash === '#pattern') {
      switchAnalisisTab('pattern');
    }

    if (root.UnifiedCockpit && typeof root.UnifiedCockpit.syncActiveTicker === 'function') {
      var shouldRunAnalysis = Boolean((tickerParam || currentActive) && (!tabParam || tabParam === 'analisis' || tabParam === 'analisis-chart'));
      root.UnifiedCockpit.syncActiveTicker(initialTicker, {
        loadChart: true,
        forceChartReload: true,
        preserveTab: Boolean(tabParam && tabParam !== 'analisis' && tabParam !== 'analisis-chart'),
        runAnalysis: shouldRunAnalysis
      });
    }

    ['bandarTickerSearchInput', 'akumulasiTickerSearchInput', 'bandarSummarySearchInput', 'rankingTickerSearchInput', 'financialTickerInput', 'marketStructureTickerInput', 'patternTickerSearchInput'].forEach(function (id) {
      var el = byId(id);
      if (el) el.value = initialTicker;
    });

    // Debounce (300ms) input pencarian ticker utama agar UI sinkron secara mulus tanpa lag
    var analisisInputEl = byId('analisisInput');
    if (analisisInputEl && !analisisInputEl.__boundDebounce && typeof analisisInputEl.addEventListener === 'function') {
      analisisInputEl.__boundDebounce = true;
      var _analisisInputDebounceTimer = null;
      analisisInputEl.addEventListener('input', function (e) {
        if (_analisisInputDebounceTimer) clearTimeout(_analisisInputDebounceTimer);
        var val = (e.target && e.target.value || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
        _analisisInputDebounceTimer = setTimeout(function () {
          var badge = byId('unifiedActiveTickerBadge');
          if (badge && val) badge.textContent = val;
        }, 300);
      });
    }

    if (isSubscribedUser()) {
      root.ensureRankingTableLoaded();
    }

    syncHeaderUsername();
  }

  if (!root.navigateTo) {
    root.navigateTo = function (name) {
      if (name === 'chart' || name === 'analisis' || name === 'analisis-chart') {
        switchAnalisisTab(name === 'chart' ? 'chart' : 'analisis-chart');
      } else if (name === 'pattern') {
        switchAnalisisTab('pattern');
      }
    };
  }

  async function handleAnalisisLogout() {
    try {
      await fetch('/api/login-user', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ action: 'logout' })
      });
    } catch (_) {}
    try {
      localStorage.setItem('autocuan_user', 'guest');
      localStorage.setItem('autocuan_is_admin', 'false');
      localStorage.removeItem('autocuan_logged_in');
      localStorage.removeItem('autocuan_login_time');
      localStorage.removeItem('autocuan_is_review');
      localStorage.removeItem('autocuan_user_id');
    } catch (_) {}
    window.location.href = '/';
  }
  root.handleAnalisisLogout = handleAnalisisLogout;
  if (!root.logout) root.logout = handleAnalisisLogout;

  function sanitizeUsername(val) {
    if (!val) return 'guest';
    if (typeof val === 'object') {
      var cand = val.username || val.user || val.name || val.email || 'guest';
      return typeof cand === 'string' ? sanitizeUsername(cand) : 'guest';
    }
    var str = String(val).trim();
    if (!str || str === 'null' || str === 'undefined') return 'guest';
    if (str.startsWith('{') && str.endsWith('}')) {
      try {
        var parsed = JSON.parse(str);
        if (parsed && typeof parsed === 'object') {
          if (parsed.role === 'ADMIN' || parsed.isAdmin === true) {
            try { localStorage.setItem('autocuan_is_admin', 'true'); } catch (_) {}
          }
          var extracted = parsed.username || parsed.user || parsed.name || parsed.email || 'guest';
          try { localStorage.setItem('autocuan_user', String(extracted).trim()); } catch (_) {}
          return String(extracted).trim();
        }
      } catch (_) {}
      return 'guest';
    }
    return str.replace(/[^\w\s@.-]/gi, '').slice(0, 50) || 'guest';
  }
  root.sanitizeUsername = sanitizeUsername;

  function syncHeaderUsername() {
    var u = 'guest';
    try {
      var raw = localStorage.getItem('autocuan_user') || '';
      u = sanitizeUsername(raw).trim();
    } catch (_) {}
    var isAdmin = false;
    try {
      isAdmin = localStorage.getItem('autocuan_is_admin') === 'true' ||
        Boolean(root.premiumAccessState && (root.premiumAccessState.isAdmin === true || root.premiumAccessState.accessLevel === 'admin'));
    } catch (_) {}
    var isBudi = (u && u.toLowerCase() === 'budi') || isAdmin;
    var isSubscribed = (typeof isSubscribedUser === 'function' ? isSubscribedUser() : false) ||
      (isAdmin || Boolean(root.premiumAccessState && (root.premiumAccessState.premium === true || root.premiumAccessState.accessLevel === 'admin' || root.premiumAccessState.accessLevel === 'premium' || root.premiumAccessState.accessLevel === 'lifetime')));

    var userEl = byId('headerUsername');
    var labelEl = byId('headerUserLabel');
    var tierBadgeEl = byId('headerTierBadge');
    var logoutEl = byId('logoutBtn');
    var accountSection = byId('headerAccountSection');
    if (accountSection) accountSection.style.display = 'inline-flex';

    var isGuest = !u || u.toLowerCase() === 'guest';

    if (isGuest) {
      if (userEl) userEl.textContent = 'Guest';
      if (logoutEl) {
        logoutEl.textContent = 'Login';
        logoutEl.onclick = function () { window.location.href = '/?login=1'; };
      }
      if (tierBadgeEl) {
        tierBadgeEl.className = 'text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-dark-600/60 border border-dark-600 text-gray-400 shrink-0 cursor-pointer hover:opacity-80 transition-all';
        tierBadgeEl.textContent = 'FREE';
        tierBadgeEl.classList.remove('hidden');
        tierBadgeEl.style.display = 'inline-block';
      }
    } else {
      if (userEl) userEl.textContent = u;
      if (logoutEl) {
        logoutEl.textContent = 'Logout';
        logoutEl.onclick = handleAnalisisLogout;
      }
      if (tierBadgeEl) {
        if (isBudi || isAdmin) {
          tierBadgeEl.className = 'text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-emerald-500/10 border border-emerald-500/30 text-emerald-400 shrink-0 cursor-pointer hover:opacity-80 transition-all';
          tierBadgeEl.textContent = '👑 ADMIN';
        } else if (isSubscribed) {
          tierBadgeEl.className = 'text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-amber-500/10 border border-amber-500/30 text-amber-300 shrink-0 cursor-pointer hover:opacity-80 transition-all';
          tierBadgeEl.textContent = '⭐ PRO';
        } else {
          tierBadgeEl.className = 'text-[10px] font-mono font-bold px-2 py-0.5 rounded bg-dark-600/60 border border-dark-600 text-gray-400 shrink-0 cursor-pointer hover:opacity-80 transition-all';
          tierBadgeEl.textContent = 'FREE';
        }
        tierBadgeEl.classList.remove('hidden');
        tierBadgeEl.style.display = 'inline-block';
      }
    }

    if (tierBadgeEl && !tierBadgeEl.__boundClick && typeof tierBadgeEl.addEventListener === 'function') {
      tierBadgeEl.__boundClick = true;
      tierBadgeEl.addEventListener('click', function () {
        if (labelEl && typeof labelEl.click === 'function') labelEl.click();
      });
    }
  }
  root.jalankanAnalisisSaham = function () {
    if (root.UnifiedCockpit && typeof root.UnifiedCockpit.handleUnifiedAnalisisSubmit === 'function') {
      root.UnifiedCockpit.handleUnifiedAnalisisSubmit();
    } else {
      var input = byId('analisisInput');
      var val = input ? input.value.trim() : '';
      if (val) root.runAnalisisFromDashboard(val);
    }
  };
  root.syncHeaderUsername = syncHeaderUsername;
  root.initStandaloneAnalisisPage = initStandaloneAnalisisPage;

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', initStandaloneAnalisisPage);
  } else {
    initStandaloneAnalisisPage();
  }
})(typeof window !== 'undefined' ? window : globalThis);
