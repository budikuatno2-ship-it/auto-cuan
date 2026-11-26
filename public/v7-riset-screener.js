/* Auto-Cuan V7 Modul Riset & Screener Runtime (Sub-Kloter 4C)
   - Virtual Grids: @tanstack/virtual-core v3.19.13 (963 Struktur Pasar, 852+ Ranking, Screener)
   - Relationship Graphs: Cytoscape.js v3.35.0 lazy-loaded on Insider & Broker Hunter
   - Charts: Custom Tree-Shaken Apache ECharts v6.1.0 lazy-loaded on Dashboard Breadth, Sektor Hot, & Financial 8Q
   Maintains 100% V6.5.5 data truth: >= Rp 1 All-Price, 0 "Mrd", 0 arjum_insiders, 0 missing-as-0, Light + Night Dark. */
(function (root) {
  'use strict';

  var doc = root && root.document ? root.document : null;
  var activeCharts = {};
  var activeCy = {};
  var virtualCleanups = {};
  var themeBound = false;
  var lastDashboardBreadth = null;
  var lastSektorGroups = null;
  var lastFinancialPayload = null;
  var lastInsiderPayload = null;
  var lastBrokerPayload = null;

  function esc(val) {
    return String(val == null ? '' : val).replace(/[&<>"']/g, function (c) {
      return ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c];
    });
  }

  function sanitizePublicLabel(text) {
    if (text == null) return '';
    return String(text)
      .replace(/arjum_insiders/gi, 'Data Kustodian KSEI')
      .replace(/\bMrd\b/g, 'M')
      .replace(/\bmrd\b/g, 'M')
      .replace(/\b30 September 2026\b/g, '30 Okt 2026')
      .replace(/\b30 Sep 2026\b/g, '30 Okt 2026');
  }

  /* Pilot 3D Fix #1: Miliar IDR values (e.g. 24592.25 Miliar = 24,59 T) must divide by 1000 for T,
     never divide Miliar by 1e12 (which caused 0,00 T!). Raw IDR (>= 1e9) divides by 1e12/1e9. */
  function formatFinancialCompact(value, opts) {
    if (value == null || value === '' || !Number.isFinite(Number(value))) {
      return '—';
    }
    var n = Number(value);
    var abs = Math.abs(n);
    var sign = n < 0 ? '−' : '';
    var unit = opts && opts.unit ? String(opts.unit).toLowerCase() : 'auto';
    var decimals = opts && typeof opts.decimals === 'number' ? opts.decimals : 2;
    var prefix = opts && opts.withPrefix ? 'Rp ' : '';

    var numFmt = function (v, d) {
      return v.toFixed(d).replace('.', ',');
    };

    if (unit === 'raw' || unit === 'idr' || (unit === 'auto' && abs >= 1e9)) {
      if (abs >= 1e12) return sign + prefix + numFmt(abs / 1e12, decimals) + ' T';
      if (abs >= 1e9) return sign + prefix + numFmt(abs / 1e9, 1) + ' M';
      if (abs >= 1e6) return sign + prefix + numFmt(abs / 1e6, 1) + ' Jt';
      return sign + prefix + Math.round(abs).toLocaleString('id-ID');
    }

    // Standard IDX quarterly statement scale: Miliar IDR
    if (abs >= 1000) {
      return sign + prefix + numFmt(abs / 1000, decimals) + ' T';
    }
    if (abs >= 1) {
      return sign + prefix + numFmt(abs, abs >= 100 ? 0 : 1) + ' M';
    }
    if (abs === 0) return prefix + '0';
    return sign + prefix + numFmt(abs * 1000, 0) + ' Jt';
  }

  function isAllPriceEligible(row, minPrice) {
    var floor = typeof minPrice === 'number' ? minPrice : 1;
    if (!row || row.last_price == null || !Number.isFinite(Number(row.last_price))) return false;
    return Number(row.last_price) >= floor;
  }

  function computeBoundingOverlapCount(boxes) {
    if (!Array.isArray(boxes) || boxes.length < 2) return 0;
    var count = 0;
    for (var i = 0; i < boxes.length; i++) {
      var a = boxes[i];
      for (var j = i + 1; j < boxes.length; j++) {
        var b = boxes[j];
        var overlapX = Math.max(0, Math.min(a.x2, b.x2) - Math.max(a.x1, b.x1));
        var overlapY = Math.max(0, Math.min(a.y2, b.y2) - Math.max(a.y1, b.y1));
        if (overlapX > 2 && overlapY > 2) count += 1;
      }
    }
    return count;
  }

  function isNightTheme() {
    if (!doc || !doc.documentElement) return false;
    return doc.documentElement.getAttribute('data-theme') === 'dark' ||
      doc.documentElement.classList.contains('dark');
  }

  function isReducedMotion() {
    return Boolean(root && root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);
  }

  function readThemeTokens() {
    var night = isNightTheme();
    var defaults = night ? {
      dark: true,
      surface: '#0E1412',
      surfaceRaised: '#161E1B',
      ink: '#EDF2EE',
      textSecondary: '#B8C4BE',
      muted: '#85968D',
      hairline: '#24302C',
      brand: '#10B981',
      pos: '#34D399',
      neg: '#F87171',
      warn: '#FBBF24',
      info: '#60A5FA',
      neutral: '#64748B'
    } : {
      dark: false,
      surface: '#EFF1EC',
      surfaceRaised: '#F7F8F5',
      ink: '#17211E',
      textSecondary: '#3E4C46',
      muted: '#5A6962',
      hairline: '#D4DBD3',
      brand: '#065F46',
      pos: '#047857',
      neg: '#B91C1C',
      warn: '#B45309',
      info: '#1D4ED8',
      neutral: '#64748B'
    };

    if (!doc || !root || typeof root.getComputedStyle !== 'function') return defaults;
    try {
      var cs = root.getComputedStyle(doc.documentElement);
      var pick = function (name, fallback) {
        var v = cs.getPropertyValue(name);
        return v && v.trim() ? v.trim() : fallback;
      };
      return {
        dark: night,
        surface: pick('--ac-surface', defaults.surface),
        surfaceRaised: pick('--ac-surface-raised', defaults.surfaceRaised),
        ink: pick('--ac-ink', defaults.ink),
        textSecondary: pick('--ac-text-secondary', defaults.textSecondary),
        muted: pick('--ac-muted', defaults.muted),
        hairline: pick('--ac-line-hairline', defaults.hairline),
        brand: pick('--ac-brand', defaults.brand),
        pos: pick('--ac-pos', defaults.pos),
        neg: pick('--ac-neg', defaults.neg),
        warn: pick('--ac-warn', defaults.warn),
        info: pick('--ac-info', defaults.info),
        neutral: defaults.neutral
      };
    } catch (_) {
      return defaults;
    }
  }

  function isElementVisible(el) {
    if (!el || !doc) return false;
    var cur = el;
    while (cur && cur !== doc.body) {
      if (cur.classList && cur.classList.contains('hidden')) return false;
      if (cur.hidden) return false;
      if (cur.style && cur.style.display === 'none') return false;
      cur = cur.parentElement;
    }
    return true;
  }

  function getVendors() {
    return root && root.AutoCuanV7Vendors ? root.AutoCuanV7Vendors : null;
  }

  function buildBreadthEChartOption(breadthData, isMobile, theme) {
    var t = theme || readThemeTokens();
    var up = Number(breadthData && (breadthData.advancers != null ? breadthData.advancers : breadthData.up)) || 0;
    var flat = Number(breadthData && (breadthData.unchanged != null ? breadthData.unchanged : breadthData.flat)) || 0;
    var down = Number(breadthData && (breadthData.decliners != null ? breadthData.decliners : breadthData.down)) || 0;
    var total = up + flat + down;
    var sectors = Array.isArray(breadthData && breadthData.sectors) ? breadthData.sectors.slice(0, isMobile ? 5 : 8) : [];

    if (sectors.length > 0) {
      var names = sectors.map(function (s) {
        var nm = String(s.sector || s.name || '-');
        return isMobile && nm.length > 11 ? nm.slice(0, 10) + '…' : nm;
      });
      var upArr = sectors.map(function (s) { return Number(s.advancers != null ? s.advancers : s.up) || 0; });
      var flatArr = sectors.map(function (s) { return Number(s.unchanged != null ? s.unchanged : s.flat) || 0; });
      var downArr = sectors.map(function (s) { return Number(s.decliners != null ? s.decliners : s.down) || 0; });

      return {
        animation: !isReducedMotion(),
        animationDuration: 280,
        backgroundColor: 'transparent',
        tooltip: {
          trigger: 'axis',
          axisPointer: { type: 'shadow' },
          backgroundColor: t.surfaceRaised,
          borderColor: t.hairline,
          textStyle: { color: t.ink, fontSize: 12 }
        },
        legend: {
          top: 0,
          right: 8,
          itemWidth: 10,
          itemHeight: 10,
          textStyle: { color: t.textSecondary, fontSize: 11 }
        },
        grid: {
          left: isMobile ? 92 : 132,
          right: 16,
          top: 28,
          bottom: 22
        },
        xAxis: {
          type: 'value',
          splitLine: { lineStyle: { color: t.hairline, type: 'dashed' } },
          axisLabel: { color: t.muted, fontSize: 10 }
        },
        yAxis: {
          type: 'category',
          inverse: true,
          data: names,
          axisLine: { lineStyle: { color: t.hairline } },
          axisLabel: { color: t.ink, fontSize: isMobile ? 10.5 : 11.5 }
        },
        series: [
          { name: 'Naik', type: 'bar', stack: 'b', data: upArr, itemStyle: { color: t.pos } },
          { name: 'Stagnan', type: 'bar', stack: 'b', data: flatArr, itemStyle: { color: t.neutral } },
          { name: 'Turun', type: 'bar', stack: 'b', data: downArr, itemStyle: { color: t.neg } }
        ]
      };
    }

    return {
      animation: !isReducedMotion(),
      animationDuration: 280,
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        backgroundColor: t.surfaceRaised,
        borderColor: t.hairline,
        textStyle: { color: t.ink, fontSize: 12 }
      },
      grid: { left: 74, right: 24, top: 18, bottom: 22 },
      xAxis: {
        type: 'value',
        max: total > 0 ? total : undefined,
        splitLine: { lineStyle: { color: t.hairline, type: 'dashed' } },
        axisLabel: { color: t.muted, fontSize: 10 }
      },
      yAxis: {
        type: 'category',
        data: ['Naik', 'Stagnan', 'Turun'],
        inverse: true,
        axisLine: { lineStyle: { color: t.hairline } },
        axisLabel: { color: t.ink, fontSize: 11, fontWeight: 600 }
      },
      series: [{
        type: 'bar',
        barWidth: 16,
        data: [
          { value: up, itemStyle: { color: t.pos, borderRadius: [0, 4, 4, 0] } },
          { value: flat, itemStyle: { color: t.neutral, borderRadius: [0, 4, 4, 0] } },
          { value: down, itemStyle: { color: t.neg, borderRadius: [0, 4, 4, 0] } }
        ],
        label: {
          show: true,
          position: 'right',
          color: t.ink,
          fontSize: 11,
          formatter: '{c}'
        }
      }]
    };
  }

  function buildSektorEChartOption(groups, isMobile, theme) {
    var t = theme || readThemeTokens();
    var list = (Array.isArray(groups) ? groups : []).slice(0, isMobile ? 6 : 10);
    var labels = list.map(function (g) {
      var raw = String(g.group_name || g.group_code || '-').replace(/^Grup\s+/i, '');
      return isMobile && raw.length > 12 ? raw.slice(0, 11) + '…' : raw;
    });
    var values = list.map(function (g) {
      var avg = g.avg_change_pct != null ? Number(g.avg_change_pct) : 0;
      return {
        value: Number(avg.toFixed(2)),
        itemStyle: {
          color: avg >= 0 ? t.pos : t.neg,
          borderRadius: avg >= 0 ? [0, 4, 4, 0] : [4, 0, 0, 4]
        }
      };
    });

    return {
      animation: !isReducedMotion(),
      animationDuration: 300,
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        axisPointer: { type: 'shadow' },
        backgroundColor: t.surfaceRaised,
        borderColor: t.hairline,
        textStyle: { color: t.ink, fontSize: 12 },
        formatter: function (params) {
          var p = Array.isArray(params) ? params[0] : params;
          if (!p) return '';
          var g = list[p.dataIndex] || {};
          var v = Number(p.value || 0);
          var sign = v >= 0 ? '+' : '−';
          return '<b>' + esc(g.group_name || g.group_code || p.name) + '</b><br/>' +
            'Rerata: <b>' + sign + Math.abs(v).toFixed(2).replace('.', ',') + '%</b><br/>' +
            'Saham: ' + (g.ticker_count || 0) + ' · Top: ' + esc(g.top_ticker || '—');
        }
      },
      grid: {
        left: isMobile ? 96 : 148,
        right: 36,
        top: 16,
        bottom: 24
      },
      xAxis: {
        type: 'value',
        splitLine: { lineStyle: { color: t.hairline, type: 'dashed' } },
        axisLabel: {
          color: t.muted,
          fontSize: 10,
          formatter: function (v) { return (v > 0 ? '+' : '') + v + '%'; }
        }
      },
      yAxis: {
        type: 'category',
        inverse: true,
        data: labels,
        axisLine: { lineStyle: { color: t.hairline } },
        axisLabel: { color: t.ink, fontSize: isMobile ? 10.5 : 11.5 }
      },
      series: [{
        name: 'Rerata %',
        type: 'bar',
        barWidth: isMobile ? 14 : 18,
        data: values,
        label: {
          show: true,
          position: 'right',
          color: t.textSecondary,
          fontSize: 10.5,
          formatter: function (p) {
            var v = Number(p.value || 0);
            return (v >= 0 ? '+' : '−') + Math.abs(v).toFixed(2).replace('.', ',') + '%';
          }
        }
      }]
    };
  }

  function buildFinancial8QEChartOption(payload, rowObjOrLabel, per, fr, isMobile, theme) {
    var t = theme || readThemeTokens();
    var seriesLabels = [];
    var revVals = [];
    var netVals = [];
    var roeVals = [];
    var unitOpt = payload && payload.unit ? String(payload.unit).toLowerCase() : 'miliar';
    var rowLabel = typeof rowObjOrLabel === 'string'
      ? rowObjOrLabel
      : (rowObjOrLabel && (rowObjOrLabel.l || rowObjOrLabel.label || 'Pendapatan Usaha'));

    if (rowObjOrLabel && typeof rowObjOrLabel === 'object' && Array.isArray(rowObjOrLabel.vals) && Array.isArray(per) && per.length > 0) {
      var orderedPer = per.slice().reverse().slice(-8);
      var orderedVals = rowObjOrLabel.vals.slice().reverse().slice(-orderedPer.length);
      seriesLabels = orderedPer.map(function (c, i) {
        if (typeof c === 'string') return c;
        return (c && (c.lab || c.label || c.period || c.quarter)) || ('Q' + (i + 1));
      });
      revVals = orderedVals.map(function (v) { return v != null && Number.isFinite(Number(v)) ? Number(v) : null; });
      if (rowObjOrLabel.k === 'pct') unitOpt = 'pct';
      else if (rowObjOrLabel.k === 'eps') unitOpt = 'eps';
    } else if (Array.isArray(per) && per.length > 0 && Array.isArray(fr)) {
      var cols = per.slice(-8);
      seriesLabels = cols.map(function (c, i) {
        if (typeof c === 'string') return c;
        return (c && (c.lab || c.label || c.period || c.quarter)) || ('Q' + (i + 1));
      });
      var vals = Array.isArray(fr.v) ? fr.v.slice(-cols.length) : cols.map(function () { return null; });
      revVals = vals.map(function (v) { return v != null && Number.isFinite(Number(v)) ? Number(v) : null; });

      var extraRows = payload && Array.isArray(payload.rows) ? payload.rows : [];
      var roeRow = extraRows.find(function (r) {
        return /roe|margin/i.test(String(r.label || r.k || ''));
      });
      if (roeRow && Array.isArray(roeRow.v)) {
        roeVals = roeRow.v.slice(-cols.length).map(function (v) {
          return v != null && Number.isFinite(Number(v)) ? Number(v) : null;
        });
      }
    } else if (payload && Array.isArray(payload.quarters)) {
      var qs = payload.quarters.slice(-8);
      seriesLabels = qs.map(function (q) { return String(q.label || q.period || '-'); });
      revVals = qs.map(function (q) { return q.revenue_miliar != null ? Number(q.revenue_miliar) : (q.revenue != null ? Number(q.revenue) : null); });
      netVals = qs.map(function (q) { return q.net_income_miliar != null ? Number(q.net_income_miliar) : (q.net_income != null ? Number(q.net_income) : null); });
      roeVals = qs.map(function (q) { return q.roe_pct != null ? Number(q.roe_pct) : null; });
    }

    var primaryName = sanitizePublicLabel(rowLabel || (fr && fr.label) || 'Pendapatan Usaha');
    var optionSeries = [{
      name: primaryName,
      type: 'bar',
      barMaxWidth: 26,
      data: revVals.map(function (v) {
        return {
          value: v,
          itemStyle: {
            color: v != null && v < 0 ? t.neg : t.brand,
            borderRadius: [4, 4, 0, 0]
          }
        };
      })
    }];

    if (netVals.some(function (v) { return v != null; })) {
      optionSeries.push({
        name: 'Laba Bersih',
        type: 'bar',
        barMaxWidth: 22,
        data: netVals,
        itemStyle: { color: t.info, borderRadius: [4, 4, 0, 0] }
      });
    }

    if (roeVals.some(function (v) { return v != null; })) {
      optionSeries.push({
        name: 'ROE %',
        type: 'line',
        yAxisIndex: 1,
        smooth: 0.25,
        symbolSize: 6,
        data: roeVals,
        itemStyle: { color: t.warn },
        lineStyle: { width: 2, color: t.warn }
      });
    }

    var hasRightAxis = optionSeries.length > 1 && Boolean(optionSeries.find(function (s) { return s.yAxisIndex === 1; }));

    return {
      animation: !isReducedMotion(),
      animationDuration: 300,
      backgroundColor: 'transparent',
      tooltip: {
        trigger: 'axis',
        backgroundColor: t.surfaceRaised,
        borderColor: t.hairline,
        textStyle: { color: t.ink, fontSize: 12 },
        formatter: function (items) {
          if (!Array.isArray(items) || !items.length) return '';
          var out = '<b>' + esc(items[0].axisValue) + '</b>';
          items.forEach(function (it) {
            if (it.seriesName.indexOf('%') !== -1 || unitOpt === 'pct') {
              out += '<br/>' + esc(it.seriesName) + ': <b>' + (it.value == null ? '—' : Number(it.value).toFixed(2).replace('.', ',') + '%') + '</b>';
            } else if (unitOpt === 'eps') {
              out += '<br/>' + esc(it.seriesName) + ': <b>' + (it.value == null ? '—' : 'Rp ' + Number(it.value).toFixed(2).replace('.', ',')) + '</b>';
            } else {
              out += '<br/>' + esc(it.seriesName) + ': <b>' + formatFinancialCompact(it.value, { unit: unitOpt, withPrefix: true }) + '</b>';
            }
          });
          return sanitizePublicLabel(out);
        }
      },
      legend: {
        top: 0,
        left: 0,
        itemWidth: 10,
        itemHeight: 10,
        textStyle: { color: t.textSecondary, fontSize: 11 }
      },
      grid: {
        left: isMobile ? 54 : 68,
        right: hasRightAxis ? (isMobile ? 42 : 52) : 14,
        top: 30,
        bottom: isMobile ? 34 : 26
      },
      xAxis: {
        type: 'category',
        data: seriesLabels,
        axisLine: { lineStyle: { color: t.hairline } },
        axisLabel: {
          color: t.textSecondary,
          fontSize: isMobile ? 9.5 : 11,
          rotate: isMobile && seriesLabels.length > 5 ? 25 : 0
        }
      },
      yAxis: [
        {
          type: 'value',
          splitLine: { lineStyle: { color: t.hairline, type: 'dashed' } },
          axisLabel: {
            color: t.muted,
            fontSize: 10,
            formatter: function (v) {
              if (unitOpt === 'pct') return Number(v).toFixed(1).replace('.', ',') + '%';
              if (unitOpt === 'eps') return Math.round(v).toLocaleString('id-ID');
              return formatFinancialCompact(v, { unit: unitOpt, decimals: 1 });
            }
          }
        },
        {
          type: 'value',
          show: hasRightAxis,
          splitLine: { show: false },
          axisLabel: { color: t.muted, fontSize: 10, formatter: '{value}%' }
        }
      ],
      series: optionSeries
    };
  }

  function ensureChartInstance(key, hostEl) {
    if (!root || !root.echarts || !hostEl) return null;
    if (activeCharts[key] && activeCharts[key].getDom && activeCharts[key].getDom() === hostEl) {
      return activeCharts[key];
    }
    if (activeCharts[key] && typeof activeCharts[key].dispose === 'function') {
      try { activeCharts[key].dispose(); } catch (_) {}
    }
    var chart = root.echarts.init(hostEl, null, { renderer: 'canvas' });
    activeCharts[key] = chart;
    return chart;
  }

  function renderDashboardBreadthEChart(breadthData) {
    if (!doc) return Promise.resolve(null);
    lastDashboardBreadth = breadthData || lastDashboardBreadth;
    if (!lastDashboardBreadth) return Promise.resolve(null);
    var page = doc.getElementById('page-dashboard');
    if (!page || !isElementVisible(page)) return Promise.resolve(null);

    var sheet = doc.querySelector('#page-dashboard section.sheet[aria-labelledby="dashMarketTitle"]');
    if (!sheet) return Promise.resolve(null);
    var host = doc.getElementById('v7DashBreadthEChart');
    if (!host) {
      host = doc.createElement('div');
      host.id = 'v7DashBreadthEChart';
      host.className = 'v7-echart-host';
      host.setAttribute('role', 'img');
      host.setAttribute('aria-label', 'Grafik Market Breadth IDX');
      var moreDetails = sheet.querySelector('details.dash-more');
      if (moreDetails) sheet.insertBefore(host, moreDetails);
      else sheet.appendChild(host);
    }

    var vendors = getVendors();
    if (!vendors) return Promise.resolve(null);
    return vendors.loadEcharts().then(function () {
      if (!isElementVisible(page)) return null;
      var isMobile = root.innerWidth <= 640;
      var chart = ensureChartInstance('dashBreadth', host);
      if (!chart) return null;
      chart.setOption(buildBreadthEChartOption(lastDashboardBreadth, isMobile, readThemeTokens()), true);
      chart.resize();
      return chart;
    }).catch(function () { return null; });
  }

  function renderSektorHotEChart(groups) {
    if (!doc) return Promise.resolve(null);
    if (Array.isArray(groups)) lastSektorGroups = groups;
    if (!Array.isArray(lastSektorGroups) || !lastSektorGroups.length) return Promise.resolve(null);
    var page = doc.getElementById('page-sektor');
    if (!page || !isElementVisible(page)) return Promise.resolve(null);

    var sheet = doc.querySelector('#page-sektor #sektorListView section.sheet');
    if (!sheet) return Promise.resolve(null);
    var host = doc.getElementById('v7SektorHotEChart');
    if (!host) {
      host = doc.createElement('div');
      host.id = 'v7SektorHotEChart';
      host.className = 'v7-echart-host v7-echart-host--sektor';
      host.setAttribute('role', 'img');
      host.setAttribute('aria-label', 'Grafik Performa Grup Konglomerat IDX');
      var tblWrap = doc.getElementById('sektorTableWrap');
      if (tblWrap && tblWrap.parentNode === sheet) sheet.insertBefore(host, tblWrap);
      else sheet.appendChild(host);
    }

    var vendors = getVendors();
    if (!vendors) return Promise.resolve(null);
    return vendors.loadEcharts().then(function () {
      if (!isElementVisible(page)) return null;
      var isMobile = root.innerWidth <= 640;
      var chart = ensureChartInstance('sektorHot', host);
      if (!chart) return null;
      chart.setOption(buildSektorEChartOption(lastSektorGroups, isMobile, readThemeTokens()), true);
      chart.resize();
      return chart;
    }).catch(function () { return null; });
  }

  function renderFinancialEChart(rowLabel, per, fr, payload) {
    if (!doc) return Promise.resolve(null);
    if (rowLabel !== undefined || per !== undefined || fr !== undefined || payload !== undefined) {
      lastFinancialPayload = { rowLabel: rowLabel, per: per, fr: fr, payload: payload };
    }
    if (!lastFinancialPayload) return Promise.resolve(null);

    var panel = doc.getElementById('panel-tab-financial');
    var container = doc.getElementById('financialBarChartContainer');
    if (!container || !panel || !isElementVisible(panel)) return Promise.resolve(null);

    var host = doc.getElementById('v7Financial8QEChart');
    if (!host) {
      host = doc.createElement('div');
      host.id = 'v7Financial8QEChart';
      host.className = 'v7-echart-host v7-echart-host--financial';
      host.setAttribute('role', 'img');
      host.setAttribute('aria-label', 'Grafik Tren Kinerja 8 Kuartal');
      container.insertBefore(host, container.firstChild);
    }
    var legacySvg = doc.getElementById('financialBarSvg');
    var legacyLabels = doc.getElementById('financialHtmlLabelsGroup');
    if (legacySvg) legacySvg.style.display = 'none';
    if (legacyLabels) legacyLabels.style.display = 'none';

    var vendors = getVendors();
    if (!vendors) return Promise.resolve(null);
    return vendors.loadEcharts().then(function () {
      if (!isElementVisible(panel)) return null;
      var isMobile = root.innerWidth <= 640;
      var chart = ensureChartInstance('financial8q', host);
      if (!chart) return null;
      chart.setOption(
        buildFinancial8QEChartOption(
          lastFinancialPayload.payload,
          lastFinancialPayload.rowLabel,
          lastFinancialPayload.per,
          lastFinancialPayload.fr,
          isMobile,
          readThemeTokens()
        ),
        true
      );
      chart.resize();
      return chart;
    }).catch(function () { return null; });
  }

  function createVirtualTableController(opts) {
    var scrollEl = opts.scrollEl;
    var tbody = opts.tbody;
    var rows = Array.isArray(opts.rows) ? opts.rows : [];
    var rowHeight = opts.rowHeight || 42;
    var overscan = opts.overscan || 4;
    var colCount = opts.colCount || 6;
    var renderRowEl = opts.renderRowEl;
    var key = opts.key || 'vgrid';

    if (typeof virtualCleanups[key] === 'function') {
      try { virtualCleanups[key](); } catch (_) {}
      delete virtualCleanups[key];
    }

    if (!tbody || !scrollEl) return null;

    var TV = root && root.TanStackVirtualCore;
    if (!TV || typeof TV.Virtualizer !== 'function') {
      // Synchronous fallback window before TanStack finishes lazy loading (still capped <= 30 DOM rows)
      var initialSlice = rows.slice(0, Math.min(28, rows.length));
      tbody.innerHTML = '';
      var frag = doc.createDocumentFragment();
      initialSlice.forEach(function (r, idx) {
        frag.appendChild(renderRowEl(r, idx));
      });
      tbody.appendChild(frag);
      return { virtualized: false, count: rows.length };
    }

    scrollEl.classList.add('v7-vgrid-scroll');

    function renderWindow(vItems, totalHeight) {
      if (!rows.length) {
        tbody.innerHTML = '';
        return;
      }
      var first = vItems.length ? vItems[0] : null;
      var last = vItems.length ? vItems[vItems.length - 1] : null;
      var topPad = first ? Math.max(0, first.start) : 0;
      var bottomPad = last ? Math.max(0, totalHeight - last.end) : 0;

      var frag = doc.createDocumentFragment();
      if (topPad > 0) {
        var topSpacer = doc.createElement('tr');
        topSpacer.className = 'v7-vgrid-spacer';
        topSpacer.setAttribute('aria-hidden', 'true');
        topSpacer.innerHTML = '<td colspan="' + colCount + '" style="height:' + Math.round(topPad) + 'px;padding:0;border:0"></td>';
        frag.appendChild(topSpacer);
      }
      for (var i = 0; i < vItems.length; i++) {
        var item = vItems[i];
        var rowData = rows[item.index];
        if (!rowData) continue;
        var tr = renderRowEl(rowData, item.index);
        if (tr) {
          tr.setAttribute('data-index', String(item.index));
          tr.setAttribute('aria-rowindex', String(item.index + 1));
          frag.appendChild(tr);
        }
      }
      if (bottomPad > 0) {
        var botSpacer = doc.createElement('tr');
        botSpacer.className = 'v7-vgrid-spacer';
        botSpacer.setAttribute('aria-hidden', 'true');
        botSpacer.innerHTML = '<td colspan="' + colCount + '" style="height:' + Math.round(bottomPad) + 'px;padding:0;border:0"></td>';
        frag.appendChild(botSpacer);
      }
      tbody.innerHTML = '';
      tbody.appendChild(frag);
    }

    var virtualizer = new TV.Virtualizer({
      count: rows.length,
      getScrollElement: function () { return scrollEl; },
      estimateSize: function () { return rowHeight; },
      overscan: overscan,
      scrollToFn: TV.elementScroll,
      observeElementRect: TV.observeElementRect,
      observeElementOffset: TV.observeElementOffset,
      onChange: function (inst) {
        renderWindow(inst.getVirtualItems(), inst.getTotalSize());
      }
    });

    var unmount = virtualizer._didMount();
    virtualizer._willUpdate();
    renderWindow(virtualizer.getVirtualItems(), virtualizer.getTotalSize());
    if (root && root.AutoCuanV7Riset) {
      root.AutoCuanV7Riset._lastVirtualizer = virtualizer;
    }

    var onScroll = function () {
      if (virtualizer && typeof virtualizer.measure === 'function') {
        renderWindow(virtualizer.getVirtualItems(), virtualizer.getTotalSize());
      }
    };
    scrollEl.addEventListener('scroll', onScroll, { passive: true });
    virtualCleanups[key] = function () {
      scrollEl.removeEventListener('scroll', onScroll);
      if (typeof unmount === 'function') unmount();
    };
    return virtualizer;
  }

  function renderVirtualRankingGrid(wrap, rows, opts) {
    if (!doc || !wrap) return Promise.resolve(null);
    var safeRows = Array.isArray(rows) ? rows : [];
    var options = opts || {};
    var cols = Array.isArray(options.columns) ? options.columns : [];
    var sortKey = options.sortKey || 's';
    var dir = options.dir || -1;
    var sortArrow = dir < 0 ? '↓' : '↑';
    var selectedTicker = options.selectedTicker || null;
    var formatters = options.formatters || {};

    var tableHtml = '<div class="v7-vgrid-scroll" id="v7RankingVirtualScroll" style="max-height:540px;overflow:auto">' +
      '<table class="tbl rt tabular-nums lining-nums" role="grid" aria-rowcount="' + safeRows.length + '" style="min-width:1040px">' +
      '<thead class="sticky top-0 z-10"><tr><th style="width:48px">#</th>';

    cols.forEach(function (col) {
      var isActive = sortKey === col.k;
      var arr = isActive ? sortArrow : '';
      var cls = (col.r ? 'r' : '') + (isActive ? ' act' : '');
      var ariaSort = isActive ? (dir < 0 ? ' aria-sort="descending"' : ' aria-sort="ascending"') : ' aria-sort="none"';
      tableHtml += '<th class="' + cls + '"' + ariaSort + '><button type="button" onclick="setRankingSort(\'' + col.k + '\')" aria-label="Urutkan ' + esc(col.l) + '">' + esc(col.l) + ' <span>' + arr + '</span></button></th>';
    });
    tableHtml += '</tr></thead><tbody id="v7RankingVirtualTbody"></tbody></table></div>';
    wrap.innerHTML = tableHtml;

    var scrollEl = doc.getElementById('v7RankingVirtualScroll');
    var tbody = doc.getElementById('v7RankingVirtualTbody');

    function buildRowEl(row, idx) {
      var tr = doc.createElement('tr');
      var isSelected = selectedTicker && row.t === selectedTicker;
      tr.className = (isSelected ? 'sel' : '');
      tr.style.cursor = 'pointer';
      tr.setAttribute('data-ticker', row.t);
      tr.onclick = function () {
        if (typeof root.pinRankingRow === 'function') root.pinRankingRow(row.t);
      };

      var cColor = row.c == null ? 'mut' : (row.c >= 0 ? 'pos' : 'neg');
      var f1Color = row.f1 == null ? 'mut' : (row.f1 >= 0 ? 'pos' : 'neg');
      var f3Color = row.f3 == null ? 'mut' : (row.f3 >= 0 ? 'pos' : 'neg');
      var isOs = row.rsi != null && row.rsi < 30;
      var idFmtInt = formatters.idFmtInt || function (v) { return v == null ? '—' : Math.round(Number(v)).toLocaleString('id-ID'); };
      var idSignPct = formatters.idSignPct || function (v, d) {
        if (v == null) return '—';
        var n = Number(v);
        return (n >= 0 ? '+' : '−') + Math.abs(n).toFixed(d || 2).replace('.', ',') + '%';
      };
      var idDec = formatters.idDec || function (v, d) { return v == null ? '—' : Number(v).toFixed(d || 1).replace('.', ','); };
      var idMoneyBillion = formatters.idMoneyBillion || function (v) { return formatFinancialCompact(v, { unit: 'auto' }); };

      var scoreHtml = (row.s == null)
        ? '<td class="r num">—</td>'
        : '<td class="r"><span class="score"><i><b style="width:' + row.s + '%"></b></i><b class="num">' + row.s + '</b></span></td>';
      var tpSlStatus = String(row.tp_sl_status || 'AKTIF');
      var tpSlLabel = String(row.tp_sl_label || (tpSlStatus === 'AKTIF' ? 'AKTIF/PANTAU' : tpSlStatus));
      var tpSlColor = tpSlStatus === 'KENA SL' ? 'neg' : ((tpSlStatus === 'KENA TP1' || tpSlStatus === 'KENA TP2') ? 'pos' : 'mut');

      tr.innerHTML =
        '<td class="num mut">' + (idx + 1) + '</td>' +
        '<td><span class="tk mono">' + esc(row.t) + '</span></td>' +
        '<td class="r num mono">' + idFmtInt(row.p) + '</td>' +
        '<td class="r num ' + cColor + '" style="font-weight:600">' + idSignPct(row.c, 2) + '</td>' +
        '<td class="r num">' + (row.rsi == null ? '—' : idDec(row.rsi, 1)) + (isOs ? '<span class="os">OS</span>' : '') + '</td>' +
        '<td class="r num neg">' + (row.h == null ? '—' : idSignPct(row.h, 2)) + '</td>' +
        '<td class="r num">' + (row.v == null ? '—' : idDec(row.v, 2) + '×') + '</td>' +
        '<td class="r num ' + f1Color + '">' + sanitizePublicLabel(idMoneyBillion(row.f1)) + '</td>' +
        '<td class="r num ' + f3Color + '">' + sanitizePublicLabel(idMoneyBillion(row.f3)) + '</td>' +
        scoreHtml +
        '<td class="' + tpSlColor + '" data-tpsl-status="' + esc(tpSlStatus) + '">' + esc(tpSlLabel) + '</td>';
      return tr;
    }

    // Immediate non-bloated paint, then upgrade to TanStack Virtual
    createVirtualTableController({
      key: 'ranking',
      scrollEl: scrollEl,
      tbody: tbody,
      rows: safeRows,
      rowHeight: 42,
      overscan: 5,
      colCount: cols.length + 1,
      renderRowEl: buildRowEl
    });

    var vendors = getVendors();
    if (vendors && !root.TanStackVirtualCore) {
      return vendors.loadTanstackVirtual().then(function () {
        if (!doc.contains(tbody)) return null;
        return createVirtualTableController({
          key: 'ranking',
          scrollEl: scrollEl,
          tbody: tbody,
          rows: safeRows,
          rowHeight: 42,
          overscan: 5,
          colCount: cols.length + 1,
          renderRowEl: buildRowEl
        });
      }).catch(function () { return null; });
    }
    return Promise.resolve(null);
  }

  function renderVirtualMarketStructureGrid(opts) {
    if (!doc) return false;
    var rows = Array.isArray(opts && opts.rows) ? opts.rows : [];
    var tbody = opts && opts.tbody ? opts.tbody : doc.getElementById('marketStructureTableBody');
    var table = doc.getElementById('marketStructureTable');
    var scrollEl = table ? table.parentElement : null;
    if (!tbody || !scrollEl) return false;

    table.setAttribute('role', 'grid');
    table.setAttribute('aria-rowcount', String(rows.length));
    scrollEl.style.maxHeight = '540px';
    scrollEl.style.overflow = 'auto';

    var selfCtx = opts.controller;
    var selectedTicker = opts.selectedTicker || null;
    var formatHscStatus = opts.formatHscStatus || function (flag) {
      return flag === true ? 'HSC Aktif' : (flag === false ? 'Tidak HSC' : 'Terverifikasi');
    };
    var formatDate = opts.formatDate || function (d) { return sanitizePublicLabel(d || '—'); };

    function buildMsRowEl(row, idx) {
      var tr = doc.createElement('tr');
      tr.setAttribute('data-ticker', row.ticker);
      tr.setAttribute('tabindex', '0');
      tr.setAttribute('role', 'button');
      tr.setAttribute('aria-label', 'Pilih saham ' + row.ticker);
      var isSel = selectedTicker === row.ticker;
      tr.className = isSel ? 'sel is-selected' : '';
      tr.setAttribute('aria-selected', isSel ? 'true' : 'false');
      tr.setAttribute('aria-pressed', isSel ? 'true' : 'false');
      if (isSel && selfCtx) selfCtx.lastSelectedRowEl = tr;

      tr.onclick = function () {
        if (selfCtx && typeof selfCtx.selectRow === 'function') selfCtx.selectRow(row.ticker, true);
      };
      tr.onkeydown = function (e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          if (selfCtx && typeof selfCtx.selectRow === 'function') selfCtx.selectRow(row.ticker, true);
        }
      };

      var hasFf = row.free_float_pct != null && Number.isFinite(Number(row.free_float_pct));
      var ffVal = hasFf ? Number(row.free_float_pct) : null;
      var ffS = hasFf ? ffVal.toFixed(2).replace('.', ',') + '%' : '—';
      var ffC = 'r num tabular-nums' + (hasFf && ffVal < 15 ? ' warn' : '');
      var isHsc = row.hsc_flag === true;
      var isNoHsc = row.hsc_flag === false;
      var hS = isHsc ? 'HSC aktif' : (isNoHsc ? 'Tidak HSC' : (row.pengendali || row.controller_name || 'Terverifikasi'));
      var hD = 'dot ' + (isHsc ? 'a' : (isNoHsc ? 'g' : 'm'));
      var st = !hasFf ? 'Data belum lengkap' : (isHsc ? 'Konsentrasi tinggi' : (ffVal < 15 ? 'Free Float rendah' : (!row.hsc_flag ? 'HSC belum diketahui' : 'Normal')));
      var rawD = row.free_float_as_of || row.as_of_trade_date || '';
      var d = sanitizePublicLabel(formatDate(rawD) || '-');

      tr.innerHTML =
        '<td class="tk mono">' + esc(row.ticker) + '</td>' +
        '<td class="mut">' + esc(row.company_name || row.name || ('PT ' + row.ticker + ' Tbk')) + '</td>' +
        '<td class="' + ffC + '" style="font-weight:600">' + ffS + '</td>' +
        '<td><span class="pill-st" style="font-weight:500"><span class="' + hD + '"></span>' + esc(sanitizePublicLabel(hS)) + '</span></td>' +
        '<td>' + esc(st) + '</td>' +
        '<td class="mut num">' + esc(d) + '</td>';
      return tr;
    }

    createVirtualTableController({
      key: 'marketStructure',
      scrollEl: scrollEl,
      tbody: tbody,
      rows: rows,
      rowHeight: 41,
      overscan: 6,
      colCount: 6,
      renderRowEl: buildMsRowEl
    });

    var vendors = getVendors();
    if (vendors && !root.TanStackVirtualCore) {
      vendors.loadTanstackVirtual().then(function () {
        if (!doc.contains(tbody)) return;
        createVirtualTableController({
          key: 'marketStructure',
          scrollEl: scrollEl,
          tbody: tbody,
          rows: rows,
          rowHeight: 41,
          overscan: 6,
          colCount: 6,
          renderRowEl: buildMsRowEl
        });
      }).catch(function () {});
    }
    return true;
  }

  function enhanceScreenerVirtual(tbody) {
    if (!doc || !tbody) return;
    var vendors = getVendors();
    if (!vendors) return;
    vendors.loadTanstackVirtual().catch(function () {});
  }

  function buildInsiderCytoscapeElements(graphData) {
    var nodes = [];
    var edges = [];
    var seenNodes = {};
    var entities = (graphData && Array.isArray(graphData.nodes)) ? graphData.nodes : [];
    var links = (graphData && Array.isArray(graphData.edges)) ? graphData.edges : [];

    entities.forEach(function (n, idx) {
      var id = String(n.id || n.key || ('node-' + idx));
      if (seenNodes[id]) return;
      seenNodes[id] = true;
      var kind = String(n.type || n.t || n.kind || 'entity').toLowerCase();
      var cleanLabel = sanitizePublicLabel(n.label || n.name || id);
      if (cleanLabel.length > 18) cleanLabel = cleanLabel.slice(0, 16) + '…';
      nodes.push({
        data: {
          id: id,
          label: cleanLabel,
          fullName: sanitizePublicLabel(n.name || n.label || id),
          nodeType: kind === 'e' || kind === 'emiten' ? 'emiten' : (kind === 'c' || kind === 'corp' ? 'corp' : 'person'),
          weight: kind === 'e' || kind === 'emiten' ? 10 : (kind === 'c' || kind === 'corp' ? 6 : 3)
        }
      });
    });

    links.forEach(function (e, idx) {
      var src = String(e.source || e.from || '');
      var dst = String(e.target || e.to || '');
      if (!src || !dst || !seenNodes[src] || !seenNodes[dst]) return;
      var relText = sanitizePublicLabel(e.label || (e.pct != null ? Number(e.pct).toFixed(2).replace('.', ',') + '%' : ''));
      edges.push({
        data: {
          id: 'e-' + idx,
          source: src,
          target: dst,
          label: relText
        }
      });
    });

    return { nodes: nodes, edges: edges };
  }

  function mountCytoscapeInstance(hostKey, containerEl, elements, selectedId, onNodeTap) {
    if (!doc || !containerEl || !root.cytoscape) return null;
    var t = readThemeTokens();

    if (activeCy[hostKey] && typeof activeCy[hostKey].destroy === 'function') {
      try { activeCy[hostKey].destroy(); } catch (_) {}
      delete activeCy[hostKey];
    }

    containerEl.innerHTML = '';
    var toolbar = doc.createElement('div');
    toolbar.className = 'v7-cy-toolbar';
    toolbar.innerHTML =
      '<button type="button" class="v7-cy-btn" data-cy-action="zoom-in" aria-label="Perbesar graf">+</button>' +
      '<button type="button" class="v7-cy-btn" data-cy-action="zoom-out" aria-label="Perkecil graf">−</button>' +
      '<button type="button" class="v7-cy-btn" data-cy-action="fit" aria-label="Paskan graf">Fit</button>' +
      '<button type="button" class="v7-cy-btn" data-cy-action="reset" aria-label="Reset graf">Reset</button>';

    var canvas = doc.createElement('div');
    canvas.className = 'v7-cy-canvas';
    canvas.setAttribute('role', 'region');
    canvas.setAttribute('aria-label', 'Graf relasi interaktif Cytoscape');
    containerEl.appendChild(toolbar);
    containerEl.appendChild(canvas);

    var cy = root.cytoscape({
      container: canvas,
      elements: elements,
      wheelSensitivity: 0.2,
      minZoom: 0.45,
      maxZoom: 2.5,
      layout: {
        name: 'concentric',
        fit: true,
        padding: 44,
        minNodeSpacing: 115,
        avoidOverlap: true,
        concentric: function (node) { return node.data('weight') || 1; },
        levelWidth: function () { return 2; },
        animate: false
      },
      style: [
        {
          selector: 'node',
          style: {
            'label': 'data(label)',
            'color': t.ink,
            'text-valign': 'bottom',
            'text-margin-y': 7,
            'text-max-width': '96px',
            'text-wrap': 'ellipsis',
            'font-size': 10.5,
            'font-weight': 700,
            'text-background-color': t.surfaceRaised,
            'text-background-opacity': 0.88,
            'text-background-padding': '3px',
            'text-background-shape': 'roundrectangle',
            'background-color': t.info,
            'border-width': 2,
            'border-color': t.surface,
            'width': 36,
            'height': 36
          }
        },
        {
          selector: 'node[nodeType = "emiten"]',
          style: {
            'background-color': t.brand,
            'shape': 'round-rectangle',
            'width': 48,
            'height': 38
          }
        },
        {
          selector: 'node[nodeType = "corp"]',
          style: {
            'background-color': '#94602B',
            'shape': 'rectangle',
            'width': 40,
            'height': 34
          }
        },
        {
          selector: 'node[nodeType = "person"]',
          style: {
            'background-color': '#7357A6',
            'shape': 'ellipse',
            'width': 34,
            'height': 34
          }
        },
        {
          selector: 'node.v7-selected',
          style: {
            'border-width': 3.5,
            'border-color': t.warn
          }
        },
        {
          selector: 'edge',
          style: {
            'width': 1.8,
            'line-color': t.muted,
            'target-arrow-color': t.muted,
            'target-arrow-shape': 'triangle',
            'curve-style': 'bezier',
            'label': 'data(label)',
            'font-size': 9.5,
            'color': t.textSecondary,
            'text-background-color': t.surface,
            'text-background-opacity': 0.9,
            'text-background-padding': '2px'
          }
        }
      ]
    });

    if (selectedId) {
      var target = cy.getElementById(String(selectedId));
      if (target && target.length) target.addClass('v7-selected');
    }

    cy.on('tap', 'node', function (evt) {
      var id = evt.target && evt.target.id ? evt.target.id() : null;
      if (!id) return;
      cy.nodes().removeClass('v7-selected');
      evt.target.addClass('v7-selected');
      if (typeof onNodeTap === 'function') onNodeTap(id);
    });

    toolbar.addEventListener('click', function (e) {
      var btn = e.target.closest ? e.target.closest('[data-cy-action]') : null;
      if (!btn) return;
      var act = btn.getAttribute('data-cy-action');
      if (act === 'zoom-in') cy.zoom({ level: Math.min(2.5, cy.zoom() * 1.2), renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
      else if (act === 'zoom-out') cy.zoom({ level: Math.max(0.45, cy.zoom() / 1.2), renderedPosition: { x: cy.width() / 2, y: cy.height() / 2 } });
      else if (act === 'fit' || act === 'reset') cy.fit(undefined, 32);
    });

    activeCy[hostKey] = cy;
    return cy;
  }

  function mountInsiderCytoscape(wrapEl, graphData, selectedKey, onSelectNode) {
    if (!doc || !wrapEl) return Promise.resolve(null);
    lastInsiderPayload = { wrapEl: wrapEl, graphData: graphData, selectedKey: selectedKey, onSelectNode: onSelectNode };
    var insPanel = doc.getElementById('panel-tab-insider');
    if (insPanel && !isElementVisible(insPanel)) return Promise.resolve(null);

    var vendors = getVendors();
    if (!vendors) return Promise.resolve(null);

    return vendors.loadCytoscape().then(function () {
      if (!doc.contains(wrapEl)) return null;
      var els = buildInsiderCytoscapeElements(graphData);
      return mountCytoscapeInstance('insider', wrapEl, els, selectedKey, onSelectNode);
    }).catch(function () { return null; });
  }

  function mountBrokerHunterCytoscape(containerEl, hunterData, brokerCode, onSelectStock) {
    if (!doc || !containerEl || !hunterData) return Promise.resolve(null);
    lastBrokerPayload = { containerEl: containerEl, hunterData: hunterData, brokerCode: brokerCode, onSelectStock: onSelectStock };
    var huntPanel = doc.getElementById('panel-tab-hunter');
    if (huntPanel && !isElementVisible(huntPanel)) return Promise.resolve(null);

    var host = doc.getElementById('v7BrokerHunterGraphHost');
    if (!host) {
      host = doc.createElement('section');
      host.id = 'v7BrokerHunterGraphHost';
      host.className = 'sheet rise v7-cy-broker-sheet';
      host.setAttribute('aria-label', 'Graf Relasi Broker Hunter');
      host.innerHTML =
        '<div class="sec-h" style="padding:12px 18px"><h2 style="font-size:14px;font-weight:700;margin:0">Peta Relasi Broker · ' + esc(brokerCode || 'BK') + '</h2><span class="chip i" style="font-size:11px">Cytoscape Deterministik</span></div>' +
        '<div id="v7BrokerHunterCyWrap" class="gw v7-cy-wrap-compact"></div>';
      var rightCol = containerEl.querySelector('[style*="560px"]') || containerEl;
      rightCol.appendChild(host);
    }

    var wrap = doc.getElementById('v7BrokerHunterCyWrap');
    if (!wrap) return Promise.resolve(null);

    var nodes = [{ id: brokerCode || 'BK', label: brokerCode || 'BK', type: 'emiten' }];
    var edges = [];
    (hunterData.top_accumulated || []).slice(0, 4).forEach(function (r) {
      if (!r || !r.ticker) return;
      nodes.push({ id: r.ticker, label: r.ticker + ' (+)', type: 'corp' });
      edges.push({ source: brokerCode || 'BK', target: r.ticker, label: 'Akumulasi' });
    });
    (hunterData.top_distributed || []).slice(0, 4).forEach(function (r) {
      if (!r || !r.ticker) return;
      nodes.push({ id: r.ticker + '-D', label: r.ticker + ' (−)', type: 'person' });
      edges.push({ source: brokerCode || 'BK', target: r.ticker + '-D', label: 'Distribusi' });
    });

    var vendors = getVendors();
    if (!vendors) return Promise.resolve(null);
    return vendors.loadCytoscape().then(function () {
      if (!doc.contains(wrap)) return null;
      return mountCytoscapeInstance('brokerHunter', wrap, buildInsiderCytoscapeElements({ nodes: nodes, edges: edges }), brokerCode, function (id) {
        if (typeof onSelectStock === 'function') onSelectStock(String(id).replace(/-D$/, ''));
      });
    }).catch(function () { return null; });
  }

  function refreshAllForThemeOrResize() {
    Object.keys(activeCharts).forEach(function (k) {
      var ch = activeCharts[k];
      if (!ch) return;
      try { ch.resize(); } catch (_) {}
    });
    if (lastDashboardBreadth) renderDashboardBreadthEChart(lastDashboardBreadth);
    if (lastSektorGroups) renderSektorHotEChart(lastSektorGroups);
    if (lastFinancialPayload) renderFinancialEChart();
    if (lastInsiderPayload) {
      mountInsiderCytoscape(lastInsiderPayload.wrapEl, lastInsiderPayload.graphData, lastInsiderPayload.selectedKey, lastInsiderPayload.onSelectNode);
    }
    if (lastBrokerPayload) {
      mountBrokerHunterCytoscape(lastBrokerPayload.containerEl, lastBrokerPayload.hunterData, lastBrokerPayload.brokerCode, lastBrokerPayload.onSelectStock);
    }
  }

  function bindGlobalListeners() {
    if (themeBound || !root || !doc) return;
    themeBound = true;
    root.addEventListener('resize', function () {
      root.setTimeout(refreshAllForThemeOrResize, 60);
    }, { passive: true });
    if (typeof MutationObserver === 'function' && doc.documentElement) {
      var mo = new MutationObserver(function (mutations) {
        for (var i = 0; i < mutations.length; i++) {
          if (mutations[i].attributeName === 'data-theme' || mutations[i].attributeName === 'class') {
            refreshAllForThemeOrResize();
            break;
          }
        }
      });
      mo.observe(doc.documentElement, { attributes: true, attributeFilter: ['data-theme', 'class'] });
    }
  }

  if (doc) bindGlobalListeners();

  var api = {
    formatFinancialCompact: formatFinancialCompact,
    sanitizePublicLabel: sanitizePublicLabel,
    isAllPriceEligible: isAllPriceEligible,
    computeBoundingOverlapCount: computeBoundingOverlapCount,
    readThemeTokens: readThemeTokens,
    buildBreadthEChartOption: buildBreadthEChartOption,
    buildSektorEChartOption: buildSektorEChartOption,
    buildFinancial8QEChartOption: buildFinancial8QEChartOption,
    renderDashboardBreadthEChart: renderDashboardBreadthEChart,
    renderSektorHotEChart: renderSektorHotEChart,
    renderFinancialEChart: renderFinancialEChart,
    renderVirtualRankingGrid: renderVirtualRankingGrid,
    renderVirtualMarketStructureGrid: renderVirtualMarketStructureGrid,
    enhanceScreenerVirtual: enhanceScreenerVirtual,
    mountInsiderCytoscape: mountInsiderCytoscape,
    mountBrokerHunterCytoscape: mountBrokerHunterCytoscape,
    refreshTheme: refreshAllForThemeOrResize,
    getActiveCharts: function () { return activeCharts; },
    getActiveCytoscape: function () { return activeCy; }
  };

  if (root) {
    root.AutoCuanV7Riset = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : null);
