/**
 * Admin Console Runtime - Auto-Cuan Redesign V2
 * Manages operational dashboard, online users (IP-free), account approval,
 * maintenance mode, vouchers, data health inspection, and audit logs.
 */
(function(root) {
  'use strict';

  var activeAdminTab = 0;
  var currentOnlineFilter = 'all';
  var onlineRefreshTimer = null;
  var pendingConfirmAction = null;
  var targetConfirmWord = 'KONFIRMASI';

  // Check Admin Authorization
  async function verifyAdminAuth() {
    try {
      var res = await fetch('/api/admin-users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'admin_console_stats' })
      });
      if (!res.ok) {
        showUnauthorized();
        return;
      }
      var data = await res.json().catch(function() { return {}; });
      if (!data || data.success !== true) {
        showUnauthorized();
        return;
      }

      // Authorized!
      var stateNote = document.getElementById('adminConsoleStateNote');
      if (stateNote) {
        stateNote.style.display = 'none';
        stateNote.textContent = '';
        stateNote.setAttribute('data-state', 'ready');
      }
      var unauth = document.getElementById('unauthorizedScreen');
      if (unauth) unauth.style.display = 'none';
      var mainContent = document.getElementById('adminMainContent');
      if (mainContent) mainContent.style.display = 'block';
      var badge = document.getElementById('adminUserBadge');
      if (badge) badge.textContent = 'Admin: ' + (data.admin || 'budi');

      applyStats(data);
      loadOnlineList();
      if (typeof root.loadThreeHorizonSettings === 'function') root.loadThreeHorizonSettings();
      startAutoRefresh();
    } catch (_) {
      showUnauthorized();
    }
  }

  function showUnauthorized() {
    var stateNote = document.getElementById('adminConsoleStateNote');
    if (stateNote) {
      stateNote.style.display = 'none';
      stateNote.textContent = '';
      stateNote.setAttribute('data-state', 'unauthorized');
    }
    var mainContent = document.getElementById('adminMainContent');
    if (mainContent) mainContent.style.display = 'none';
    var unauth = document.getElementById('unauthorizedScreen');
    if (unauth) unauth.style.display = 'grid';
  }

  // F1: label sensus riil — ganti teks statis "Sebagian Q1" dengan angka sensus
  // dari data/completeness/latest.json (N emiten Q2 2026 · M emiten Q1 2026).
  function renderFinancialCensus(datasets) {
    var q2Cell = document.getElementById('finCensusQ2Cell');
    var labelCell = document.getElementById('finCensusLabelCell');
    if (!q2Cell && !labelCell) return;
    var fin = null;
    if (datasets && Array.isArray(datasets)) {
      for (var i = 0; i < datasets.length; i++) {
        if (datasets[i] && datasets[i].name === 'Laporan keuangan emiten') { fin = datasets[i]; break; }
      }
    }
    if (!fin) return;
    var label = fin.status_label || '';
    if (q2Cell) q2Cell.textContent = 'Q2 2026';
    if (labelCell) {
      labelCell.textContent = label;
      labelCell.className = 'st ' + (fin.status === 'ok' ? 'g' : 'a');
    }
  }

  function fmtId(n) { try { return Number(n).toLocaleString('id-ID'); } catch (_) { return String(n); } }
    function formatAuditTimeWib(val) {
    if (!val) return '—';
    try {
      var d = (val instanceof Date) ? val : new Date(val);
      if (isNaN(d.getTime())) {
        var str = String(val).replace(/(\+00:00|\+07:00|Z)$/gi, '').trim();
        return str.endsWith('WIB') ? str : (str + ' WIB');
      }
      var pad = function(n) { return n < 10 ? '0' + n : String(n); };
      var utc = d.getTime() + (d.getTimezoneOffset() * 60000);
      var wib = new Date(utc + (7 * 3600000));
      var months = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];
      var day = pad(wib.getDate());
      var month = months[wib.getMonth()];
      var year = wib.getFullYear();
      var hours = pad(wib.getHours());
      var mins = pad(wib.getMinutes());
      var secs = pad(wib.getSeconds());
      return day + ' ' + month + ' ' + year + ', ' + hours + ':' + mins + ':' + secs + ' WIB';
    } catch (_) {
      var s = String(val).replace(/(\+00:00|\+07:00|Z)$/gi, '').trim();
      return s.endsWith('WIB') ? s : (s + ' WIB');
    }
  }
  root.formatAuditTimeWib = formatAuditTimeWib;
  if (typeof window !== 'undefined') window.formatAuditTimeWib = formatAuditTimeWib;
  function fmtWib(iso) { return formatAuditTimeWib(iso); }
  function applyStats(data) {
    if (data.quota) {
      var q = data.quota;
      var el = document.getElementById('statQuotaNum');
      var usedDisp = q.usageKnown === false || q.used == null ? '—' : fmtId(q.used);
      var limitDisp = q.limitKnown === false || q.limit == null ? '—' : fmtId(q.limit);
      if (el) el.innerHTML = usedDisp + '<span class="mut" style="font-size:14px;font-weight:600"> / ' + limitDisp + '</span>';
      var bar = document.getElementById('statQuotaBar');
      if (bar) bar.style.width = (q.pct || 0) + '%';
      var rem = document.getElementById('statQuotaRemain');
      // V6 (Subtask C): remaining unknown = UNKNOWN, never (limit||0)-(used||0).
      var remVal = q.remaining != null ? fmtId(q.remaining) : 'UNKNOWN';
      if (q.remaining == null && q.limitKnown === false) remVal = 'UNKNOWN (batas tidak terverifikasi)';
      if (rem) rem.textContent = 'Sisa hari ini: ' + remVal + ' · Reset ' + (q.reset || '00:00 WIB');
      var sync = document.getElementById('statQuotaSync');
      if (sync) sync.textContent = 'Sinkron upstream: ' + fmtWib(q.updatedAt) + (q.upstreamUsedToday != null ? ' · upstream ' + fmtId(q.upstreamUsedToday) : '');
      var plan = document.getElementById('statQuotaPlan');
      if (plan) {
        var days = (q.planDaysLeft != null) ? q.planDaysLeft : null;
        plan.textContent = 'Paket aktif: ' + (q.planName || '—') + (q.planExpiresAt ? ' · berakhir ' + fmtWib(q.planExpiresAt) : '') + (days != null ? ' (berakhir dalam ' + days + ' hari)' : '');
      }
      var drift = document.getElementById('quotaDriftWarn');
      if (drift) {
        var showDrift = q.driftDetected === true;
        // V6 AUDIT FIX: q.limit must be a valid known number > 0.
        // If q.limit is null, 0, or unknown, it must NOT trigger false "paket turun ke 0 req/hari"!
        var hasValidLimit = q.limit != null && Number.isFinite(Number(q.limit)) && Number(q.limit) > 0;
        var lowPkg = hasValidLimit && Number(q.limit) <= 1000;
        drift.style.display = (showDrift || lowPkg) ? 'block' : 'none';
        if (showDrift) drift.textContent = 'Peringatan drift: lokal ' + fmtId(q.localUsedToday) + ' vs upstream ' + fmtId(q.upstreamUsedToday) + ' — dipakai nilai konservatif.';
        else if (lowPkg) drift.textContent = 'Peringatan: paket turun ke ' + fmtId(q.limit) + ' req/hari — hemat kuota hingga perpanjangan.';
      }
      // Prefill editor kuota dari config aktif (placeholder netral tanpa literal paket; nilai dari config/quota.json)
      // V3-F02: kartu Kontrol Fleksibel — 4 input + slider + 4 toggle + saklar libur.
      try {
        var cfg = q.config || {};
        var setV = function(id, v) { var e = document.getElementById(id); if (e && (e.value === '' || e.value == null || e.value === 'cth batas')) e.value = (v == null ? '' : v); };
        setV('quotaDailyLimit', cfg.dailyLimitOverride);
        if (cfg.planExpiresAt) { var pe = document.getElementById('quotaPlanExpiry'); if (pe && !pe.value) pe.value = String(cfg.planExpiresAt).slice(0, 16); }
        setV('quotaFloorDay', cfg.reserveFloorWeekdayDaytime);
        setV('quotaFloorNight', cfg.reserveFloorWeekdayNight);
        setV('quotaFloorWeekend', cfg.reserveFloorWeekend);
        var setQF = function(id, v) { var e = document.getElementById(id); if (e) e.value = (v == null ? '' : v); };
        setQF('qf-maxQuota', cfg.maxQuota != null ? cfg.maxQuota : (q.maxQuota != null ? q.maxQuota : q.limit));
        setQF('qf-weekdayBackfill', cfg.weekdayBackfillLimit != null ? cfg.weekdayBackfillLimit : q.weekdayBackfillLimit);
        setQF('qf-weekendBackfill', cfg.weekendBackfillLimit != null ? cfg.weekendBackfillLimit : q.weekendBackfillLimit);
        setQF('qf-reserveFloor', cfg.reserveFloorWeekday != null ? cfg.reserveFloorWeekday : cfg.reserveFloorWeekdayDaytime);
        var hsMap = { '23:40': 0, '23:45': 1, '23:50': 2 };
        var hs = document.getElementById('qf-hardStop');
        if (hs && cfg.hardStopWIB && hsMap[cfg.hardStopWIB] != null) { hs.value = hsMap[cfg.hardStopWIB]; }
        var hsVal = document.getElementById('qf-hardStopVal');
        if (hsVal && cfg.hardStopWIB) hsVal.textContent = cfg.hardStopWIB;
        var staleMap = { 120: 1, 180: 2, 0: 0 };
        var st2 = document.getElementById('qf-staleThreshold');
        var stVal = document.getElementById('qf-staleVal');
        var thr = (q.staleThresholdMinutes != null ? q.staleThresholdMinutes : (cfg && cfg.staleThresholdMinutes != null ? cfg.staleThresholdMinutes : 120));
        if (st2 && staleMap[thr] != null) st2.value = staleMap[thr];
        if (stVal) stVal.textContent = (!thr || thr === 0 || thr === '0') ? 'mati (0)' : (thr + ' mnt');
        var setT = function(id, v) { var e = document.getElementById(id); if (e) e.checked = (v === true); };
        setT('qf-toggle-lowQuota', cfg.lowQuotaMode === true || q.lowQuotaMode === true);
        var tm = q.telegramMute || {};
        setT('qf-toggle-muteDaily', tm.daily === true || cfg.telegramMuteDaily === true);
        setT('qf-toggle-muteEmergency', tm.emergency === true || cfg.telegramMuteEmergency === true);
        setT('qf-toggle-muteNonCritical', tm.nonCritical === true || cfg.telegramMuteNonCritical === true);
        setT('qf-toggle-preflight', (q.dynamicPreflightGate !== false) && (cfg.dynamicPreflightGate !== false));
        setT('qf-toggle-backfillRemainder', cfg.holidayBackfillRemainder !== false);

        // Throughput & failure tolerance knobs
        setQF('qf-concurrency', cfg.concurrency != null ? cfg.concurrency : (q.concurrency != null ? q.concurrency : 2));
        setQF('qf-rateLimit', cfg.rateLimit != null ? cfg.rateLimit : (q.rateLimit != null ? q.rateLimit : 5));
        setQF('qf-retryCount', cfg.retryCount != null ? cfg.retryCount : (q.retryCount != null ? q.retryCount : 3));
        setQF('qf-backoffBaseMs', cfg.backoffBaseMs != null ? cfg.backoffBaseMs : (q.backoffBaseMs != null ? q.backoffBaseMs : 1000));
        var po = cfg.priorityOrder || q.priorityOrder;
        if (po) setQF('qf-priorityOrder', Array.isArray(po) ? po.join(', ') : po);

        // Emergency kill-switch and paused services
        setT('qf-killSwitch', cfg.killSwitch === true || q.killSwitch === true);
        var ps = cfg.pausedServices || q.pausedServices || {};
        setT('qf-pause-backfill', ps.backfill === true || ps.all === true);
        setT('qf-pause-broksum', ps.broksum === true || ps['broksum-ALL'] === true || ps.all === true);
        setT('qf-pause-foreign', ps.foreign === true || ps['broksum-Foreign'] === true || ps.all === true);
        setT('qf-pause-insider', ps.insider === true || ps['insider-tiered'] === true || ps.all === true);
        setT('qf-pause-candles', ps.candles === true || ps.all === true);
        setT('qf-pause-financial', ps.financial === true || ps.all === true);

        renderQfStatus(q);
        if (data.auditHistory) renderQuotaAuditHistory(data.auditHistory);
        else loadQuotaAuditHistory();
      } catch (_) {}
    }
    if (data.datasets) renderFinancialCensus(data.datasets);
    if (data.online_summary) {
      var s = data.online_summary;
      var usersActive = document.getElementById('statUsersActive');
      if (usersActive) usersActive.textContent = (s.active_7d != null ? s.active_7d : (s.today != null ? s.today : (s.idle_7d != null ? s.idle_7d : '—')));
      var nowEl = document.getElementById('statOnlineNow');
      if (nowEl) nowEl.textContent = (s.online_now != null ? s.online_now : '—');
      var onNowEl = document.getElementById('onSummaryNow');
      if (onNowEl) onNowEl.textContent = s.online_now;
      var on15m = document.getElementById('onSummary15m');
      if (on15m) on15m.textContent = s.active_15m;
      var onToday = document.getElementById('onSummaryToday');
      if (onToday) onToday.textContent = s.today;
      var onIdle = document.getElementById('onSummaryIdle7d');
      if (onIdle) onIdle.textContent = s.idle_7d;
      var tabOn = document.getElementById('tabOnlineCount');
      if (tabOn) tabOn.textContent = (s.online_now != null ? s.online_now : '0');
    } else {
      // V6: telemetry absent -> UNKNOWN, never fabricated counts.
      var usersActive = document.getElementById('statUsersActive');
      if (usersActive) usersActive.textContent = 'UNKNOWN';
      var nowEl = document.getElementById('statOnlineNow');
      if (nowEl) nowEl.textContent = '—';
    }
    // V6: service status + p95 latency from telemetry only, never hardcoded.
    var svc = document.getElementById('statServiceStatus');
    var svcLat = document.getElementById('statServiceLatency');
    if (data.operational && typeof data.operational === 'object') {
      var opOk = data.operational.ok === true;
      if (svc) {
        svc.className = 'st ' + (opOk ? 'g' : 'a');
        svc.textContent = opOk ? 'NORMAL' : 'DEGRADED';
      }
      if (svcLat) {
        var latency = data.operational.api_p95_ms != null ? data.operational.api_p95_ms : (data.operational.latency != null ? data.operational.latency : null);
        svcLat.textContent = latency != null ? ('API p95: ' + latency + ' ms') : 'API p95: —';
      }
    } else {
      if (svc) { svc.className = 'st a'; svc.textContent = 'UNKNOWN'; }
      if (svcLat) svcLat.textContent = 'API p95: —';
    }
    if (data.data_health) {
      renderDataHealth(data.data_health);
    }
  }

  // Tab Switching
  root.switchAdminTab = function(idx) {
    activeAdminTab = idx;
    var tabs = document.querySelectorAll('#adminNavTabs .tbtn');
    tabs.forEach(function(btn, i) {
      if (i === idx) { btn.classList.add('on'); btn.setAttribute('aria-selected', 'true'); }
      else { btn.classList.remove('on'); btn.setAttribute('aria-selected', 'false'); }
    });
    for (var i = 0; i <= 8; i++) {
      var panel = document.getElementById('panelTab' + i);
      if (panel) {
        if (i === idx) panel.style.display = 'block';
        else panel.style.display = 'none';
      }
    }
    if (idx === 1) loadOnlineList();
    if (idx === 3) loadUsersList();
    if (idx === 6) {
      root.refreshDataHealth();
      loadJobsPipeline();
      loadSchedulerBackfill();
      loadCompletenessMeta();
      root.refreshBackfillForecast();
      if (typeof root.loadThreeHorizonSettings === 'function') root.loadThreeHorizonSettings();
    }
    if (idx === 7) loadAuditLogs();
    if (idx === 8) root.refreshSecurityPanel();
  };

  // Data Health Inspector
  root.refreshDataHealth = async function() {
    var btn = document.getElementById('btnRefreshDataHealth');
    if (btn) {
      btn.disabled = true;
      btn.textContent = 'Memeriksa...';
    }
    try {
      var res = await fetch('/api/admin-users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'data_health_inspect' })
      });
      if (res.ok) {
        var data = await res.json().catch(function() { return {}; });
        if (data && data.success && data.data_health) {
          renderDataHealth(data.data_health);
        }
      }
    } catch (_) {}
    if (btn) {
      btn.disabled = false;
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round" style="margin-right:5px;vertical-align:-2px"><polyline points="23 4 23 10 17 10"></polyline><polyline points="1 20 1 14 7 14"></polyline><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"></path></svg>Periksa Ulang Status Data';
    }
  };

  function renderDataHealth(health) {
    if (!health) return;

    var badge = document.getElementById('healthOverallBadge');
    if (badge) {
      badge.className = 'st ' + (health.overall_status === 'ok' ? 'g' : (health.overall_status === 'warn' ? 'a' : 'r'));
      badge.textContent = health.overall_label;
    }

    var okEl = document.getElementById('statHealthOk');
    if (okEl) okEl.textContent = health.ok_count;
    var warnEl = document.getElementById('statHealthWarn');
    if (warnEl) warnEl.textContent = health.warn_count;

    var timeEl = document.getElementById('healthLastChecked');
    if (timeEl) timeEl.textContent = health.inspected_at_formatted || '—';

    var tbody = document.getElementById('dataHealthTbody');
    if (!tbody || !health.categories) return;

    tbody.innerHTML = health.categories.map(function(c) {
      var metricsHtml = '';
      var m = c.metrics || {};
      if (c.id === 'broker_summary_all') {
        metricsHtml = '<b class="num">' + m.complete_count + '</b> / ' + m.total_universe + ' emiten (' + m.coverage_pct + '%)<span class="mut" style="display:block;font-size:11px">' + escapeHtml(c.details) + '</span>';
      } else if (c.id === 'broker_summary_foreign') {
        metricsHtml = '<span class="mut">Ketercakupan:</span> <b class="num">' + (m.foreign_archive_count === '—' ? '—' : m.foreign_archive_count + ' / ' + m.total_universe) + '</b><span class="mut" style="display:block;font-size:11px">' + escapeHtml(c.details) + '</span>';
      } else if (c.id === 'broker_summary_domestic') {
        metricsHtml = '<span class="mono mut">Rumus: ' + escapeHtml(m.calculation_formula) + '</span> · <span class="mut">Menunggu:</span> <b class="num">' + m.waiting_foreign_count + '</b> emiten<span class="mut" style="display:block;font-size:11px">' + escapeHtml(c.details) + '</span>';
      } else if (c.id === 'candle_eod_volume') {
        metricsHtml = '<b class="num">' + m.active_candle_count + '</b> emiten aktif (' + m.total_candles + ' bar) · <span class="num mut">' + m.anomaly_bars_count + ' anomali/vol 0</span><span class="mut" style="display:block;font-size:11px">' + escapeHtml(m.ihsg_status) + '</span>';
      } else if (c.id === 'broker_accumulation_hunter') {
        metricsHtml = '<b class="num">' + m.hunter_indexes_count + '</b> berkas indeks hunter · <span class="mut">' + m.accumulation_horizons.join(', ') + '</span><span class="mut" style="display:block;font-size:11px">' + escapeHtml(c.details) + '</span>';
      } else if (c.id === 'insider_network_ksei') {
        metricsHtml = '<b class="num">' + Number(m.total_entities).toLocaleString('id-ID') + '</b> entitas · <b class="num">' + m.total_tickers + '</b> emiten<span class="mut" style="display:block;font-size:11px">' + escapeHtml(c.details) + '</span>';
      } else if (c.id === 'hot_sectors_intel_screener') {
        metricsHtml = '<b class="num">' + m.intel_catalogs_count + '</b> katalog aktif · <span class="mut">Snapshot ' + escapeHtml(m.snapshot_freshness) + '</span><span class="mut" style="display:block;font-size:11px">' + escapeHtml(c.details) + '</span>';
      } else {
        metricsHtml = '<span class="mut">' + escapeHtml(c.details) + '</span>';
      }

      var dateStr = '—';
      if (m.latest_trade_date) dateStr = m.latest_trade_date;
      else if (m.latest_foreign_date) dateStr = m.latest_foreign_date;
      else if (m.latest_candle_date) dateStr = m.latest_candle_date;
      else if (m.latest_compilation) dateStr = m.latest_compilation;
      else if (m.ksei_release_date) dateStr = m.ksei_release_date;
      else if (m.last_signal_scan) dateStr = m.last_signal_scan;

      return '<tr>' +
        '<td><b style="font-size:13.5px">' + escapeHtml(c.name) + '</b></td>' +
        '<td>' + metricsHtml + '</td>' +
        '<td class="num mut" style="font-size:12px">' + escapeHtml(dateStr) + '</td>' +
        '<td><span class="' + escapeHtml(c.badge_class) + '">' + escapeHtml(c.status_label) + '</span></td>' +
      '</tr>';
    }).join('');
  }

  // Online Tab & Heartbeat
  async function loadOnlineList() {
    try {
      var query = document.getElementById('onlineSearchInput') ? document.getElementById('onlineSearchInput').value : '';
      var res = await fetch('/api/admin-users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'online_list', filter: currentOnlineFilter, query: query })
      });
      var data = await res.json().catch(function() { return {}; });
      if (data && data.success && data.rows) {
        renderOnlineTable(data.rows);
        var updated = document.getElementById('onlineLastUpdated');
        if (updated) {
          var now = new Date();
          updated.textContent = now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0') + ' WIB';
        }
      }
    } catch (_) {}
  }

  function renderOnlineTable(rows) {
    var tbody = document.getElementById('onlineTableTbody');
    if (!tbody) return;
    if (rows.length === 0) {
      tbody.innerHTML = '<tr><td colspan="6" class="mut" style="text-align:center;padding:24px">Tidak ada pengguna pada filter ini.</td></tr>';
      return;
    }
    tbody.innerHTML = rows.map(function(u) {
      var dot = u.status_code === 'online' ? '<span class="live"></span>' : '<span class="live" style="background:#F59E0B;box-shadow:none"></span>';
      return '<tr>' +
        '<td><b>' + escapeHtml(u.username) + '</b><span class="mut" style="display:block;font-size:11px">' + escapeHtml(u.role) + '</span></td>' +
        '<td><span class="st ' + (u.status_code === 'online' ? 'g' : 'a') + '">' + dot + escapeHtml(u.status_label) + '</span></td>' +
        '<td class="mono mut" style="font-size:12px">' + escapeHtml(u.page) + '</td>' +
        '<td class="mut">' + escapeHtml(u.device) + '</td>' +
        '<td class="r num">' + escapeHtml(u.session_duration) + '</td>' +
        '<td class="num mut">' + escapeHtml(u.last_seen_formatted) + '</td>' +
      '</tr>';
    }).join('');
  }

  root.filterOnline = function(f, btn) {
    currentOnlineFilter = f;
    var btns = document.querySelectorAll('.ofc');
    btns.forEach(function(b) { b.classList.remove('on'); });
    if (btn) btn.classList.add('on');
    loadOnlineList();
  };

  root.onOnlineSearch = function() {
    loadOnlineList();
  };

  function startAutoRefresh() {
    if (onlineRefreshTimer) clearInterval(onlineRefreshTimer);
    onlineRefreshTimer = setInterval(function() {
      if (document.visibilityState === 'visible' && activeAdminTab === 1) {
        loadOnlineList();
      }
    }, 30000);
  }

  // Maintenance Toggle
  root.toggleMaintenanceMode = function() {
    var btn = document.getElementById('maintenanceSwitchBtn');
    if (!btn) return;
    var isChecked = btn.getAttribute('aria-checked') === 'true';
    var next = !isChecked;
    promptAction({
      title: next ? 'Aktifkan Mode Maintenance?' : 'Matikan Mode Maintenance?',
      body: next ? 'Pengguna non-admin akan dialihkan ke layar pemeliharaan secara instan.' : 'Aplikasi akan kembali dibuka untuk semua pengguna.',
      word: 'MAINTENANCE',
      action: function(reason) {
        btn.setAttribute('aria-checked', next ? 'true' : 'false');
        if (next) btn.classList.add('on');
        else btn.classList.remove('on');
        var banner = document.getElementById('mBanner');
        if (banner) banner.style.display = next ? 'flex' : 'none';
        recordAuditLog('budi', (next ? 'Aktifkan' : 'Nonaktifkan') + ' Mode Maintenance', reason);
      }
    });
  };

  root.saveMaintenanceSettings = function() {
    var msg = document.getElementById('mMessageInput') ? document.getElementById('mMessageInput').value : '';
    recordAuditLog('budi', 'Simpan Pengaturan Maintenance', 'Pesan: ' + msg.slice(0, 30));
    alert('Pengaturan pemeliharaan berhasil disimpan.');
  };

  // Voucher / Kupon Actions
  root.createVoucherAction = function() {
    var codeInput = document.getElementById('vCodeInput');
    var code = codeInput ? (codeInput.value || '').trim().toUpperCase() : '';
    var plan = document.getElementById('vPlanSelect') ? document.getElementById('vPlanSelect').value : 'pro_30';
    var quotaInput = document.getElementById('vQuotaInput');
    var quotaParsed = quotaInput ? parseInt(quotaInput.value, 10) : 1;
    var quota = (Number.isFinite(quotaParsed) && quotaParsed > 0) ? quotaParsed : 1;
    var expInput = document.getElementById('vExpiryInput');
    var exp = expInput ? (expInput.value || '').trim() : '';
    if (!code) { alert('Kode tidak boleh kosong'); return; }

    var planLabel = plan === 'lifetime' ? 'Pro Trader · Lifetime' : (plan === 'pro_90' ? 'Pro Trader · 90 hari' : 'Pro Trader · 30 hari');
    var tbody = document.getElementById('adminCouponsTableTbody') || document.getElementById('vouchersTableTbody');
    if (tbody) {
      var tr = document.createElement('tr');

      var tdCode = document.createElement('td');
      tdCode.className = 'mono';
      tdCode.style.fontWeight = '600';
      tdCode.textContent = code;

      var tdPlan = document.createElement('td');
      tdPlan.className = 'mut';
      tdPlan.textContent = planLabel;

      var tdQuota = document.createElement('td');
      tdQuota.className = 'r num';
      tdQuota.textContent = '0 / ' + quota;

      var tdExp = document.createElement('td');
      tdExp.className = 'num mut';
      tdExp.textContent = exp || '—';

      var tdAction = document.createElement('td');
      tdAction.className = 'r';
      var btn = document.createElement('button');
      btn.className = 'btn sm';
      btn.textContent = 'Nonaktifkan';
      btn.onclick = function() {
        (window.revokeKupon || window.revokeVoucher || root.revokeVoucher)(code);
      };
      tdAction.appendChild(btn);

      tr.appendChild(tdCode);
      tr.appendChild(tdPlan);
      tr.appendChild(tdQuota);
      tr.appendChild(tdExp);
      tr.appendChild(tdAction);

      if (tbody.firstChild) {
        tbody.insertBefore(tr, tbody.firstChild);
      } else {
        tbody.appendChild(tr);
      }
    }
    recordAuditLog('budi', 'Buat Kupon/Akses ' + code, 'Paket: ' + planLabel + ', Kuota: ' + quota);
    alert('Kode ' + code + ' berhasil diterbitkan.');
  };
  root.createKuponAction = root.createVoucherAction;

  root.revokeVoucher = function(code) {
    promptAction({
      title: 'Nonaktifkan Kode ' + code + '?',
      body: 'Pengguna baru tidak akan bisa menukarkan kode ini lagi.',
      word: 'REVOKE',
      action: function(reason) {
        recordAuditLog('budi', 'Nonaktifkan Kode ' + code, reason);
        alert('Kode ' + code + ' telah dinonaktifkan.');
      }
    });
  };
  root.revokeKupon = root.revokeVoucher;

  // P4: Forecast penyelesaian backfill — dibaca dari endpoint (berkas forecast.json), tanpa hardcode.
  function fmtNum(n) {
    try { return Number(n).toLocaleString('id-ID'); } catch (_) { return String(n); }
  }
  function fcRow(text) {
    return '<tr><td colspan="6" class="mut" style="text-align:center;padding:24px">' + escapeHtml(text) + '</td></tr>';
  }
  function setForecastUnavailable(reason) {
    var rem = document.getElementById('fcRemaining');
    var fin = document.getElementById('fcFinish');
    var exp = document.getElementById('fcExpiry');
    var st = document.getElementById('fcStatus');
    var cap = document.getElementById('fcCapacity');
    var tb = document.getElementById('forecastTbody');
    if (rem) rem.textContent = '—';
    if (fin) fin.textContent = '—';
    if (exp) exp.textContent = '—';
    if (st) { st.textContent = reason || 'Data tidak tersedia'; st.style.color = 'var(--ac-muted)'; }
    if (cap) cap.textContent = 'Kapasitas: data tidak tersedia.';
    if (tb) tb.innerHTML = fcRow(reason || 'Data tidak tersedia');
  }
  function renderBackfillForecast(fc) {
    var rem = document.getElementById('fcRemaining');
    var fin = document.getElementById('fcFinish');
    var exp = document.getElementById('fcExpiry');
    var st = document.getElementById('fcStatus');
    var cap = document.getElementById('fcCapacity');
    var tb = document.getElementById('forecastTbody');
    if (!fc || typeof fc !== 'object') { setForecastUnavailable('Data tidak tersedia'); return; }

    var remaining = Number(fc.remainingRequests);
    var hasQueue = Number.isFinite(remaining) && remaining > 0;
    var daily = Array.isArray(fc.dailyTable) ? fc.dailyTable : [];

    // Capacity is ALWAYS derived from the forecast payload — never hardcoded in UI.
    if (cap) {
      var cp = fc.capacityPerDay || {};
      var parts = [];
      if (Number.isFinite(Number(cp.weekday))) parts.push('hari kerja ' + fmtNum(cp.weekday) + ' req/hari');
      if (Number.isFinite(Number(cp.weekend))) parts.push('akhir pekan ' + fmtNum(cp.weekend) + ' req/hari');
      cap.textContent = parts.length ? ('Kapasitas: ' + parts.join(', ') + '.') : 'Kapasitas: data tidak tersedia.';
    }

    if (!hasQueue && daily.length === 0) {
      if (rem) rem.textContent = '0 request';
      if (fin) fin.textContent = '—';
      if (exp) exp.textContent = (fc.planExpiresAt || '').slice(0, 10) || '—';
      if (st) { st.textContent = 'Tidak ada antrean backfill'; st.style.color = 'var(--ac-brand)'; }
      if (tb) tb.innerHTML = fcRow('Tidak ada antrean backfill');
      return;
    }

    if (rem) rem.textContent = (Number.isFinite(remaining) ? fmtNum(remaining) : '—') + ' request';
    if (fin) fin.textContent = fc.finishDate || '—';
    if (exp) exp.textContent = (fc.planExpiresAt || '').slice(0, 10) || '—';
    if (st) {
      if (fc.finishesBeforeExpiry === true) { st.textContent = 'Selesai sebelum batas paket'; st.style.color = 'var(--ac-brand)'; }
      else if (fc.finishesBeforeExpiry === false) { st.textContent = 'Melewati batas paket'; st.style.color = 'var(--ac-warn)'; }
      else { st.textContent = 'Estimasi belum tersedia'; st.style.color = 'var(--ac-muted)'; }
    }
    if (tb) {
      if (!daily.length) tb.innerHTML = fcRow('Data tidak tersedia');
      else tb.innerHTML = daily.map(function(r) {
        return '<tr><td class="num">' + escapeHtml(r.date) + '</td><td class="mut">' + escapeHtml(r.weekday) + '</td><td class="r num">' + fmtNum(r.capacity) + '</td><td class="r num">' + fmtNum(r.burn) + '</td><td class="r num">' + fmtNum(r.remainingAfter) + '</td><td>' + (r.done ? '<span class="st g">Selesai</span>' : '<span class="st a">Berjalan</span>') + '</td></tr>';
      }).join('');
    }
  }
  root.refreshBackfillForecast = async function() {
    var tb = document.getElementById('forecastTbody');
    if (tb) tb.innerHTML = fcRow('Memuat forecast…');
    var controller = (typeof AbortController === 'function') ? new AbortController() : null;
    var timer = null;
    var settled = false;
    var finish = function() {
      if (settled) return;
      settled = true;
      if (timer != null) clearTimeout(timer);
    };
    if (controller && typeof setTimeout === 'function') {
      timer = setTimeout(function() { try { controller.abort(); } catch (_) {} }, 8000);
    }
    try {
      var res = await fetch('/api/admin-users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'backfill_forecast' }),
        signal: controller ? controller.signal : undefined
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json().catch(function() { return {}; });
      finish();
      if (data && data.success && data.forecast) renderBackfillForecast(data.forecast);
      else setForecastUnavailable('Data tidak tersedia');
    } catch (_) {
      finish();
      setForecastUnavailable('Data tidak tersedia');
    }
  };
  root.renderBackfillForecast = renderBackfillForecast;
  root.setForecastUnavailable = setForecastUnavailable;

  // Confirmation Dialog
  function promptAction(opts) {
    pendingConfirmAction = opts.action;
    targetConfirmWord = opts.word || 'KONFIRMASI';

    var dTitle = document.getElementById('dialogTitle');
    if (dTitle) dTitle.textContent = opts.title;
    var dBody = document.getElementById('dialogBody');
    if (dBody) dBody.textContent = opts.body;
    var dWord = document.getElementById('dialogWordTarget');
    if (dWord) dWord.textContent = targetConfirmWord;
    var dInput = document.getElementById('dialogConfirmInput');
    if (dInput) dInput.value = '';
    var dReason = document.getElementById('dialogReasonInput');
    if (dReason) dReason.value = '';
    var dSubmit = document.getElementById('dialogSubmitBtn');
    if (dSubmit) dSubmit.disabled = true;

    var overlay = document.getElementById('confirmDialogOverlay');
    if (overlay) {
      overlay.style.display = 'grid';
      if (dInput) dInput.focus();
    }
  }

  root.checkConfirmWord = function() {
    var dInput = document.getElementById('dialogConfirmInput');
    var typed = dInput ? (dInput.value || '').trim().toUpperCase() : '';
    var dReason = document.getElementById('dialogReasonInput');
    var reason = dReason ? (dReason.value || '').trim() : '';
    var btn = document.getElementById('dialogSubmitBtn');
    if (btn) {
      btn.disabled = !(typed === targetConfirmWord && reason.length >= 10);
    }
  };

  root.closeConfirmDialog = function() {
    var overlay = document.getElementById('confirmDialogOverlay');
    if (overlay) overlay.style.display = 'none';
    pendingConfirmAction = null;
  };

  root.executeConfirmedAction = function() {
    var dReason = document.getElementById('dialogReasonInput');
    var reason = dReason ? (dReason.value || '').trim() : '';
    if (pendingConfirmAction) {
      pendingConfirmAction(reason);
    }
    root.closeConfirmDialog();
  };

  function recordAuditLog(actor, action, target) {
    var tbody = document.getElementById('auditLogsTbody');
    if (!tbody) return;
    var now = new Date();
    var timeStr = formatAuditTimeWib(now);
    var tr = document.createElement('tr');

    var tdTime = document.createElement('td');
    tdTime.className = 'num mut';
    tdTime.textContent = timeStr;

    var tdActor = document.createElement('td');
    tdActor.style.fontWeight = '600';
    tdActor.textContent = String(actor || '');

    var tdAction = document.createElement('td');
    tdAction.textContent = String(action || '');

    var tdTarget = document.createElement('td');
    tdTarget.className = 'mono mut';
    tdTarget.textContent = String(target || '');

    tr.appendChild(tdTime);
    tr.appendChild(tdActor);
    tr.appendChild(tdAction);
    tr.appendChild(tdTarget);

    if (tbody.firstChild) {
      tbody.insertBefore(tr, tbody.firstChild);
    } else {
      tbody.appendChild(tr);
    }
  }

  function escapeHtml(str) {
    return String(str || '').replace(/[&<>"']/g, function(m) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
  }

  // Client Heartbeat (60 seconds, only when tab is visible)
  setInterval(function() {
    if (document.visibilityState === 'visible') {
      fetch('/api/admin-users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'heartbeat', page: location.pathname, device: 'Browser · Web' })
      }).catch(function() {});
    }
  }, 60000);

  function renderDatasetFreshness(datasets) {
    var tb = document.getElementById('datasetFreshnessTbody');
    if (!tb) return;
    if (!datasets || !datasets.length) { tb.innerHTML = '<tr><td colspan="4" class="mut" style="text-align:center;padding:24px">Belum ada heartbeat job — cron VPS belum menulis.</td></tr>'; return; }
    tb.innerHTML = datasets.map(function(d) {
      var cls = d.status === 'ok' ? 'g' : (d.status === 'warn' ? 'a' : 'r');
      return '<tr><td style="font-weight:600">' + escapeHtml(d.name) + '</td><td class="num mut">' + escapeHtml(d.last_success) + '</td><td class="mut">' + escapeHtml(d.schedule) + '</td><td><span class="st ' + cls + '">' + escapeHtml(d.status_label) + '</span></td></tr>';
    }).join('');
  }

  // ── V6 (Subtask D): Admin Schedule Editor ─────────────────────────────────
  // Fungsi renderJobsPipeline dijadikan editor jadwal fungsional (jam/hari/
  // enable), bukan tombol "Otomatis" disabled. Sumber kebenaran adalah
  // /api/admin/schedule-settings (GET/PUT) — bukan teks label cron statis.
  var scheduleState = { config: null, dirty: {} };

  var DAY_LABELS = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];

  /**
   * TASK 6 LOCAL: deterministic 24-hour WIB formatter for the JAM WIB column.
   * Accepts HH:MM, ISO timestamps, and legacy 12-hour strings.
   * Never emits locale-dependent 12-hour markers.
   */
  function formatWib24h(value) {
    if (value == null || value === '') return '—';
    var s = String(value).trim();
    var m = s.match(/^(\d{1,2}):(\d{2})(?::\d{2})?\s*(AM|PM)?$/i);
    if (m) {
      var h = Number(m[1]);
      var min = Number(m[2]);
      var mer = (m[3] || '').toUpperCase();
      if (mer === 'PM' && h < 12) h += 12;
      else if (mer === 'AM' && h === 12) h = 0;
      if (h >= 0 && h <= 23 && min >= 0 && min <= 59) {
        return String(h).padStart(2, '0') + ':' + String(min).padStart(2, '0');
      }
    }
    var iso = s.match(/T(\d{2}):(\d{2})(?::\d{2})?(?:Z|[+-]\d{2}:?\d{2})?$/);
    if (iso) {
      var ih = Number(iso[1]);
      var im = Number(iso[2]);
      if (ih >= 0 && ih <= 23 && im >= 0 && im <= 59) {
        return String(ih).padStart(2, '0') + ':' + String(im).padStart(2, '0');
      }
    }
    return '—';
  }
  root.formatWib24h = formatWib24h;

  function daySet(arr) {
    var s = {};
    (arr || []).forEach(function(d) { s[Number(d)] = true; });
    return s;
  }

  var WIB_DAY_LABELS = ['Min', 'Sen', 'Sel', 'Rab', 'Kam', 'Jum', 'Sab'];
  var WIB_MONTH_LABELS = ['Jan', 'Feb', 'Mar', 'Apr', 'Mei', 'Jun', 'Jul', 'Agu', 'Sep', 'Okt', 'Nov', 'Des'];

  /**
   * FIX 6: render an ISO WIB next-run as human text, e.g. "Sen 23 Nov, 20:40 WIB".
   * Input is engine.formatWibIso output: YYYY-MM-DDTHH:mm:00+07:00.
   * Never emits ISO and never emits an em dash for a populated run.
   */
  function formatNextRunWib(value) {
    var m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})/.exec(String(value || ''));
    if (!m) return String(value || '');
    var y = Number(m[1]), mo = Number(m[2]), d = Number(m[3]);
    var hh = Number(m[4]), mm = Number(m[5]);
    var dt = new Date(Date.UTC(y, mo - 1, d));
    var label = WIB_DAY_LABELS[dt.getUTCDay()] + ' ' + d + ' ' + WIB_MONTH_LABELS[mo - 1];
    return label + ', ' + String(hh).padStart(2, '0') + ':' + String(mm).padStart(2, '0') + ' WIB';
  }
  root.formatNextRunWib = formatNextRunWib;

  function nextRunsPreview(line, nextRuns, count, isEnabled) {
    if (isEnabled === false && (!nextRuns || !nextRuns.length)) {
      return '<span class="mut">Nonaktif (tidak dijadwalkan)</span>';
    }
    if (!nextRuns || !nextRuns.length) return '<span class="mut">Jadwal tidak tersedia</span>';
    var human = nextRuns.map(formatNextRunWib);
    return '<span class="mono" style="font-size:11px;white-space:normal;line-height:1.45" title="' + escapeHtml(human.join('\n')) + '">' +
      escapeHtml(human.slice(0, count || 5).join(' · ')) + '</span>';
  }

  function scheduleConflictTip(config, key) {
    const collisions = (config && config.collisions) || [];
    const badges = [];
    for (const c of collisions) {
      if (c.jobA === key) badges.push('⚠ bentrok dgn <b>' + escapeHtml(c.jobB) + '</b> (' + escapeHtml(c.bTime) + ')');
      if (c.jobB === key) badges.push('⚠ bentrok dgn <b>' + escapeHtml(c.jobA) + '</b> (' + escapeHtml(c.aTime) + ')');
    }
    return badges.join(' · ');
  }

  function renderJobsPipeline(cfg) {
    var tb = document.getElementById('jobsPipelineTbody');
    var ver = document.getElementById('schVersioneLabel');
    var nowLabel = document.getElementById('schNowWib');
    if (!tb) return;

    if (ver) ver.textContent = cfg ? ('v' + cfg.version + (cfg.updatedBy ? ' · ' + escapeHtml(cfg.updatedBy) : '')) : 'Memuat…';
    if (nowLabel) nowLabel.textContent = cfg ? ('WIB ' + escapeHtml(cfg.nowWIB || '')) : '';

    if (!cfg || !Array.isArray(cfg.jobs) || !cfg.jobs.length) {
      tb.innerHTML = '<tr><td colspan="7" class="mut" style="text-align:center;padding:24px">Jadwal scheduler belum tersedia (butuh sesi admin).</td></tr>';
      return;
    }

    var isLegacyRow = function(j) {
      return j.legacy_inactive === true || j.category === 'LEGACY' || j.key === 'coordinated-pipeline';
    };
    var activeJobs = cfg.jobs.filter(function(j) { return !isLegacyRow(j); });
    var legacyJobs = cfg.jobs.filter(isLegacyRow);
    var renderJobRow = function(j) {
      var editable = j.editable === true;
      var next = (cfg.nextRuns && cfg.nextRuns[j.key]) || [];
      var locked = j.lockedDefault === true;
      var time24 = formatWib24h(j.timeWIB);
      var descStyle = 'white-space:normal;overflow-wrap:anywhere;word-break:break-word;line-height:1.35';

      if (!editable) {
        var cls2 = j.enabled ? 'g' : 'a';
        return '<tr>' +
          '<td style="font-weight:600">' + escapeHtml(j.name) + '<span class="mut" style="display:block;font-size:11px">' + escapeHtml(j.category) + ' · ' + escapeHtml(j.costClass) + '</span></td>' +
          '<td class="mono mut" data-role="schedule-time-display">' + escapeHtml(time24) + ' WIB</td>' +
          '<td class="mut" style="font-size:11px">' + escapeHtml((j.days || []).length ? (j.days || []).map(function(d){return DAY_LABELS[Number(d)];}).join(',') : 'Setiap hari') + '</td>' +
          '<td>' + nextRunsPreview(null, next, 5, j.enabled) + '</td>' +
          '<td style="' + descStyle + '">' + escapeHtml(j.description || '') + '</td>' +
          '<td><span class="st ' + cls2 + '">' + (j.enabled ? 'Aktif' : 'Nonaktif') + '</span></td>' +
          '<td class="r"><button class="btn sm" disabled title="Job legacy/monitoring tidak diedit dari console.">Terkunci</button></td>' +
        '</tr>';
      }

      var daysChk = '<div style="display:flex;flex-wrap:wrap;gap:3px 6px;min-width:168px">' + [0,1,2,3,4,5,6].map(function(d) {
        var on = daySet(j.days)[d] === true;
        return '<label style="display:inline-flex;align-items:center;gap:3px;font-size:11px;white-space:nowrap" title="' + DAY_LABELS[d] + '">' +
          '<input type="checkbox" data-job="' + escapeHtml(j.key) + '" data-day="' + d + '"' + (on ? ' checked' : '') + ' onchange="onScheduleDayToggle(this)"> ' + DAY_LABELS[d] + '</label>';
      }).join('') + '</div>';

      return '<tr data-schedule-row="' + escapeHtml(j.key) + '">' +
        '<td style="font-weight:600">' + escapeHtml(j.name) +
          '<span class="mut" style="display:block;font-size:11px">' + escapeHtml(j.key) + (locked ? ' · default 20:40; override Admin dipertahankan' : '') + '</span></td>' +
        '<td><input type="text" inputmode="numeric" data-role="schedule-time" data-job="' + escapeHtml(j.key) + '" value="' + escapeHtml(time24) + '" pattern="^([01]\\d|2[0-3]):[0-5]\\d$" maxlength="5" placeholder="HH:MM" title="Jam WIB format 24 jam (HH:MM)" style="width:72px;font-family:monospace" onchange="onScheduleTimeChange(this)"></td>' +
        '<td style="min-width:168px">' + daysChk + '</td>' +
        '<td>' + nextRunsPreview(null, next, 5, j.enabled) + '</td>' +
        '<td style="max-width:260px;' + descStyle + '"><span class="mut" style="font-size:11px;' + descStyle + '">' + escapeHtml(j.description || '') + '</span>' +
          '<span style="display:block;font-size:11px;color:var(--ac-warn,#F59E0B);' + descStyle + '">' + scheduleConflictTip(cfg, j.key) + '</span></td>' +
        '<td>' +
          '<select data-job="' + escapeHtml(j.key) + '" style="width:76px" onchange="onScheduleEnableChange(this)">' +
            '<option value="1"' + (j.enabled ? ' selected' : '') + '>Aktif</option>' +
            '<option value="0"' + (!j.enabled ? ' selected' : '') + '>Nonaktif</option>' +
          '</select>' +
        '</td>' +
        '<td class="r"><button class="btn sm" data-save-job="' + escapeHtml(j.key) + '" onclick="saveScheduleJob(\'' + escapeHtml(j.key) + '\')">Simpan</button></td>' +
      '</tr>';
    };

    var html = activeJobs.map(renderJobRow).join('');
    if (legacyJobs.length) {
      html += '<tr class="schedule-legacy-group"><td colspan="7" style="padding:0;border:0">' +
        '<details style="margin:6px 0 0">' +
        '<summary style="cursor:pointer;font-size:11px;font-weight:600;color:var(--ac-2,#94a3b8);padding:6px 8px">' +
        'Job Legacy / Kompatibilitas (Nonaktif) — ' + legacyJobs.length + ' job</summary>' +
        '<table class="tbl" style="width:100%;margin-top:4px"><tbody>' +
        legacyJobs.map(renderJobRow).join('') +
        '</tbody></table></details></td></tr>';
    }
    tb.innerHTML = html;
  }

  function collectScheduleRow(jobKey) {
    var row = document.querySelector('[data-schedule-row="' + jobKey + '"]');
    if (!row) return null;
    var timeEl = row.querySelector('input[data-role="schedule-time"][data-job="' + jobKey + '"]');
    var days = [];
    row.querySelectorAll('input[type="checkbox"][data-job="' + jobKey + '"]').forEach(function(cb) {
      if (cb.checked) days.push(Number(cb.getAttribute('data-day')));
    });
    var sel = row.querySelector('select[data-job="' + jobKey + '"]');
    if (!timeEl || !sel) return null;
    var p = { timeWIB: timeEl.value, days: days, enabled: sel.value === '1' };
    if (!/^\d{2}:\d{2}$/.test(p.timeWIB)) return null;
    return p;
  }

  function stampScheduleStatus(text, ok) {
    var el = document.getElementById('scheduleSaveStatus');
    if (!el) return;
    el.textContent = text || '';
    el.style.color = ok === false ? 'var(--ac-warn,#F59E0B)' : 'var(--ac-brand,#10B981)';
  }

  root.onScheduleTimeChange = function(input) {
    if (!input || !input.getAttribute) return;
    var key = input.getAttribute('data-job');
    if (key) scheduleState.dirty[key] = true;
  };
  root.onScheduleDayToggle = function(cb) {
    if (!cb || !cb.getAttribute) return;
    var key = cb.getAttribute('data-job');
    if (key) scheduleState.dirty[key] = true;
  };
  root.onScheduleEnableChange = function(sel) {
    if (!sel || !sel.getAttribute) return;
    var key = sel.getAttribute('data-job');
    if (key) scheduleState.dirty[key] = true;
  };

  root.saveScheduleJob = async function(jobKey) {
    var patchData = collectScheduleRow(jobKey);
    if (!patchData) { stampScheduleStatus('Baris tidak ditemukan.', false); return; }
    var cfg = scheduleState.config;
    if (!cfg) { stampScheduleStatus('Konfigurasi belum termuat.', false); return; }
    var reason = 'Ubah jadwal ' + jobKey + ' via Admin Console';
    var isTest = Boolean(window.__AUTOCUAN_TEST__);
    if (!isTest && typeof window.prompt === 'function') {
      var typed = window.prompt('Ketik JADWAL untuk menyimpan perubahan jadwal ' + jobKey + ':');
      if ((typed || '').trim().toUpperCase() !== 'JADWAL') { stampScheduleStatus('Dibatalkan.', false); return; }
      var userReason = window.prompt('Alasan perubahan (wajib):');
      if (userReason && userReason.trim().length >= 3) reason = userReason.trim();
    }
    stampScheduleStatus('Menyimpan ' + jobKey + '…', true);
    try {
      var res = await fetch('/api/admin/schedule-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          patch: { jobs: (function(){ var o = {}; o[jobKey] = patchData; return o; })() },
          reason: reason,
          version: cfg.version
        })
      });
      var data = await res.json().catch(function() { return {}; });
      if (res.ok && data && (data.success || data.ok)) {
        scheduleState.dirty = {};
        stampScheduleStatus('Tersimpan (readback OK) · versi ' + data.version + '.', true);
        if (data.config) { scheduleState.config = data.config; renderJobsPipeline(data.config); }
        recordAuditLog((window.__AUTOCUAN_PREVIEW_USER__ && window.__AUTOCUAN_PREVIEW_USER__.username) || 'budi', 'Simpan Jadwal ' + jobKey, versionlessReason(reason));
      } else if (res.status === 409 && data && data.code === 'SCHEDULE_COLLISION') {
        stampScheduleStatus('DITOLAK bentrok jadwal: ' + ((data.collisions || []).map(function(c){ return c.jobA + ' vs ' + c.jobB; }).join('; ') || 'overlap'), false);
        if (data.config) { scheduleState.config = data.config; renderJobsPipeline(data.config); }
      } else if (res.status === 409 && data && data.code === 'LEGACY_DUPLICATE') {
        // V6 Subtask F: patch would duplicate an ACTIVE legacy executor (cron/PM2).
        stampScheduleStatus('DITOLAK duplikasi executor lama: ' + ((data.legacyDuplicates || []).map(function(d){ return d.job + ' @ ' + d.timeWIB + ' vs ' + d.executors.join(', '); }).join('; ') || 'legacy ACTIVE') + ' — cutover butuh approval.', false);
        if (data.config) { scheduleState.config = data.config; renderJobsPipeline(data.config); }
      } else if (res.status === 409) {
        stampScheduleStatus('Konflik versi — konfigurasi berubah di tempat lain. Muat ulang lalu simpan kembali.', false);
      } else if (res.status === 400) {
        stampScheduleStatus('Ditolak (validasi server): ' + ((data && data.error) || 'patch tidak valid'), false);
      } else if (res.status === 401 || res.status === 403) {
        stampScheduleStatus('Ditolak: ' + ((data && data.error) || 'butuh sesi admin / origin sama.'), false);
      } else {
        stampScheduleStatus('Gagal (HTTP ' + res.status + '): ' + ((data && data.error) || 'terjadi kesalahan.'), false);
      }
    } catch (_) { stampScheduleStatus('Gagal terhubung ke server (network).', false); }
  };

  function versionlessReason(r) { return String(r || '').replace(/^Ubah jadwal [a-z0-9_-]+ via Admin Console/i, 'Ubah jadwal').slice(0, 60); }

  async function loadJobsPipeline() {
    var tb = document.getElementById('jobsPipelineTbody');
    if (tb) tb.innerHTML = '<tr><td colspan="7" class="mut" style="text-align:center;padding:24px">Memuat status job & jadwal dari scheduler durable…</td></tr>';
    // V6 (Subtask D): jadwal dibaca dari endpoint terotorisasi (bukan label cron).
    try {
      var res = await fetch('/api/admin/schedule-settings', { method: 'GET', headers: { 'Content-Type': 'application/json' } });
      if (res.ok) {
        var data = await res.json().catch(function() { return {}; });
        if (data && data.success && data.config) {
          scheduleState.config = data.config;
          renderJobsPipeline(data.config);
        }
      } else {
        if (tb) tb.innerHTML = '<tr><td colspan="7" class="mut" style="text-align:center;padding:24px">Butuh sesi admin untuk mengedit jadwal scheduler.</td></tr>';
      }
    } catch (_) {
      if (tb) tb.innerHTML = '<tr><td colspan="7" class="mut" style="text-align:center;padding:24px">Gagal memuat jadwal scheduler.</td></tr>';
    }
  }
  root.renderJobsPipeline = renderJobsPipeline;

  // ── V6 (W5): Scheduler & Backfill EFFECTIVE readback panel ────────────────
  function sbBadgeClass(lastStatus) {
    if (lastStatus === 'IDLE') return 'g';
    if (lastStatus === 'RUNNING') return 'a';
    if (lastStatus === 'BLOCKED') return 'r';
    return 'a';
  }

  function sbRow(label, value) {
    return '<tr><td class="mut" style="width:220px">' + escapeHtml(label) + '</td><td class="mono">' + escapeHtml(value == null ? '—' : String(value)) + '</td></tr>';
  }

  function renderSchedulerBackfill(status) {
    var badge = document.getElementById('sbBadge');
    var reason = document.getElementById('sbReason');
    var tb = document.getElementById('sbDetailTbody');
    var src = document.getElementById('sbReadbackSource');
    if (!badge || !tb) return;
    if (!status) {
      badge.className = 'st a';
      badge.textContent = 'TIDAK TERSEDIA';
      if (reason) reason.textContent = 'Butuh sesi admin untuk membaca status scheduler efektif.';
      tb.innerHTML = '<tr><td colspan="2" class="mut" style="text-align:center;padding:20px">Status tidak tersedia.</td></tr>';
      return;
    }
    var bf = status.backfill || {};
    var lastStatus = bf.last_status || 'UNKNOWN';
    badge.className = 'st ' + sbBadgeClass(lastStatus);
    badge.textContent = lastStatus + (status.readback_ok ? '' : ' (readback belum OK)');
    if (reason) reason.textContent = bf.reason || '—';
    if (src) src.textContent = status.readback_source || '—';

    var ex = status.executor || {};
    var q = status.quota_observed || {};
    var queue = status.queue || {};
    var perMonth = queue.per_month_pending || {};
    var perMonthStr = Object.keys(perMonth).sort().map(function(k) { return k + ':' + perMonth[k]; }).join(', ') || '—';

    tb.innerHTML = [
      sbRow('Status backfill (mentah)', bf.status),
      sbRow('Alasan', bf.reason),
      sbRow('Request terkirim', bf.requests_sent),
      sbRow('Provider scan', bf.provider_scan ? 'YA' : 'TIDAK'),
      sbRow('Terakhir dicek', bf.last_checked_at),
      sbRow('Cek berikutnya', bf.next_check_at),
      sbRow('Aritmetika kuota', bf.arithmetic),
      sbRow('Executor owner', ex.owner),
      sbRow('Last attempt', ex.last_attempt),
      sbRow('Last success', ex.last_success),
      sbRow('Last error', ex.last_error),
      sbRow('Run ID', ex.run_id),
      sbRow('Requests used (ledger)', ex.requests_used),
      sbRow('Antrean terverifikasi', queue.verified_count),
      sbRow('Pending per bulan', perMonthStr),
      sbRow('Kuota sisa (observed)', q.remaining),
      sbRow('Kuota limit (observed)', q.limit),
      sbRow('Plan expiry', q.plan_expiry),
      sbRow('Readback OK', status.readback_ok ? 'YA' : 'TIDAK'),
      sbRow('Saved original (store)', (status.saved_original || {}).store_path)
    ].join('');
  }

  async function loadSchedulerBackfill() {
    var tb = document.getElementById('sbDetailTbody');
    if (tb) tb.innerHTML = '<tr><td colspan="2" class="mut" style="text-align:center;padding:20px">Memuat status scheduler efektif…</td></tr>';
    try {
      var res = await fetch('/api/admin/scheduler-status', { method: 'GET', headers: { 'Content-Type': 'application/json' } });
      if (res.ok) {
        var data = await res.json().catch(function() { return {}; });
        if (data && data.success && data.status) { renderSchedulerBackfill(data.status); return; }
      }
      renderSchedulerBackfill(null);
    } catch (_) { renderSchedulerBackfill(null); }
  }
  root.loadSchedulerBackfill = loadSchedulerBackfill;

  function sbStamp(text, ok) {
    var el = document.getElementById('sbActionStatus');
    if (!el) return;
    el.textContent = text || '';
    el.style.color = ok === false ? 'var(--ac-warn,#F59E0B)' : 'var(--ac-brand,#10B981)';
  }

  async function sbTriggerBackfill(paused, label) {
    sbStamp(label + '…', true);
    try {
      var res = await fetch('/api/admin/quota-backfill-trigger', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ reason: label, paused: paused })
      });
      var data = await res.json().catch(function() { return {}; });
      if (res.ok && data && data.success) {
        var st = (data.decision && data.decision.status) || data.status || 'OK';
        sbStamp(label + ' → ' + st + ' (request=' + (data.requestsSent != null ? data.requestsSent : 0) + ')', true);
        loadSchedulerBackfill();
      } else {
        sbStamp(label + ' gagal: ' + ((data && data.error) || ('HTTP ' + res.status)), false);
      }
    } catch (_) { sbStamp(label + ' gagal (network).', false); }
  }

  root.sbPauseBackfill = function() { return sbTriggerBackfill(true, 'Jeda Backfill'); };
  root.sbResumeBackfill = function() { return sbTriggerBackfill(false, 'Lanjutkan Backfill'); };
  root.sbRetryBackfill = function() { return sbTriggerBackfill(false, 'Retry Backfill'); };

  async function loadCompletenessMeta() {
    try {
      var res = await fetch('/api/admin-users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'backfill_forecast' }) });
      if (!res.ok) return;
      var data = await res.json().catch(function() { return {}; });
      var el = document.getElementById('completenessMeta');
      if (el && data && data.success && data.forecast) el.textContent = fmtNum(data.forecast.remainingRequests) + ' req sisa · selesai ' + (data.forecast.finishDate || '—');
    } catch (_) {}
  }
  async function loadUsersList() {
    var tb = document.getElementById('usersTableTbody');
    if (!tb) return;
    tb.innerHTML = '<tr><td colspan="6" class="mut" style="text-align:center;padding:24px">Memuat daftar pengguna…</td></tr>';
    try {
      var q = document.getElementById('usersSearchInput') ? document.getElementById('usersSearchInput').value : '';
      var res = await fetch('/api/admin-users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'list' }) });
      if (!res.ok) { tb.innerHTML = '<tr><td colspan="6" class="mut" style="text-align:center;padding:24px">Gagal memuat (butuh sesi admin).</td></tr>'; return; }
      var data = await res.json().catch(function() { return {}; });
      var users = (data && data.users) || [];
      if (q) users = users.filter(function(u) { return ((u.username || '') + ' ' + (u.email || '')).toLowerCase().indexOf(String(q).toLowerCase()) >= 0; });
      var lbl = document.getElementById('usersCountLabel');
      if (lbl) lbl.textContent = users.length + ' pengguna';
      if (!users.length) { tb.innerHTML = '<tr><td colspan="6" class="mut" style="text-align:center;padding:24px">Tidak ada pengguna.</td></tr>'; return; }
      tb.innerHTML = users.slice(0, 100).map(function(u) {
        var blocked = u.is_blocked === true;
        return '<tr><td><b>' + escapeHtml(u.username) + '</b></td><td class="mut">' + (u.is_admin ? 'Admin' : 'Pengguna') + '</td><td class="mut">' + escapeHtml(u.plan || '—') + '</td><td class="num mut">' + escapeHtml(u.last_login_at || '—') + '</td><td><span class="st ' + (blocked ? 'r' : 'g') + '">' + (blocked ? 'Diblokir' : 'Aktif') + '</span></td><td class="r"><button class="btn sm" onclick="toggleBlockUser(\'' + escapeHtml(u.username) + '\',' + (blocked ? '0' : '1') + ')">' + (blocked ? 'Buka blokir' : 'Blokir') + '</button></td></tr>';
      }).join('');
    } catch (_) { tb.innerHTML = '<tr><td colspan="6" class="mut" style="text-align:center;padding:24px">Gagal memuat.</td></tr>'; }
  }
  root.onUsersSearch = function() { loadUsersList(); };
  root.toggleBlockUser = function(username, block) {
    promptAction({
      title: (block ? 'Blokir ' : 'Buka blokir ') + username + '?',
      body: block ? 'Sesi pengguna ini akan ditolak sampai blokir dibuka. Tercatat di log audit.' : 'Pengguna kembali bisa masuk.',
      word: block ? 'BLOKIR' : 'BUKA',
      action: function(reason) { recordAuditLog('budi', (block ? 'Blokir ' : 'Buka blokir ') + username, reason); loadUsersList(); }
    });
  };
  async function loadAuditLogs() {
    try {
      var res = await fetch('/api/admin-logs', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({}) });
      if (!res.ok) return;
      var data = await res.json().catch(function() { return {}; });
      var tb = document.getElementById('auditLogsTbody');
      if (tb && data && data.success && Array.isArray(data.loginLogs)) {
        tb.innerHTML = data.loginLogs.slice(0, 30).map(function(l) {
          return '<tr><td class="num mut">' + escapeHtml(formatAuditTimeWib(l.created_at)) + '</td><td style="font-weight:600">' + escapeHtml(l.username || '') + '</td><td>' + escapeHtml(l.action || 'login') + '</td><td class="mono mut">' + escapeHtml(l.detail || '') + '</td></tr>';
        }).join('') || '<tr><td colspan="4" class="mut" style="text-align:center;padding:24px">Belum ada log.</td></tr>';
      }
      var sec = document.getElementById('securityEventsTbody');
      if (sec && data && Array.isArray(data.securityEvents)) {
        sec.innerHTML = data.securityEvents.slice(0, 20).map(function(e) {
          return '<tr><td class="num mut">' + escapeHtml(formatAuditTimeWib(e.created_at || e.at)) + '</td><td>' + escapeHtml(e.kind || e.key || 'peristiwa') + '</td><td class="mut">' + escapeHtml(e.detail || e.summary || '') + '</td></tr>';
        }).join('') || '<tr><td colspan="3" class="mut" style="text-align:center;padding:24px">Tidak ada peristiwa keamanan.</td></tr>';
      }
    } catch (_) {}
  }
  // V3-F02: render tabel status kartu Kontrol Fleksibel (token .tbl/.st, tanpa hardcode angka).
  function renderQfStatus(q) {
    try {
      var tb = document.getElementById('qf-status-tbody');
      if (!tb || !q) return;
      var cfg = q.config || {};
      var rows = [
        ['Batas Kuota Harian Maksimal', (q.maxQuota != null ? q.maxQuota : q.limit), (q.limit > 0 ? 'g' : 'r')],
        ['Batas Backfill Hari Kerja', q.weekdayBackfillLimit, 'i'],
        ['Batas Backfill Akhir Pekan', q.weekendBackfillLimit, 'i'],
        ['Cadangan Wajib Hari Kerja', (cfg.reserveFloorWeekday != null ? cfg.reserveFloorWeekday : ''), 'm'],
        ['Jam Hard Stop Malam', (cfg.hardStopWIB || '23:50 WIB'), 'm'],
        ['Ambang Batas Stale', (q.staleThresholdMinutes === 0 ? 'Mati (0)' : (q.staleThresholdMinutes + ' mnt')), 'm'],
        ['Mode Hemat Kuota', (q.lowQuotaMode ? 'AKTIF' : 'Mati'), (q.lowQuotaMode ? 'a' : 'g')],
        ['Status Libur Bursa BEI', (q.holiday ? q.holiday.label : 'Normal (Buka)'), (q.holiday && q.holiday.isHoliday ? 'r' : 'g')],
        ['Dynamic Preflight Gate', (q.dynamicPreflightGate ? 'Longgar (candle+ALL)' : 'Ketat (candle+ALL+Foreign)'), 'i']
      ];
      tb.innerHTML = rows.map(function(r) {
        return '<tr><td class="mono">' + escapeHtml(String(r[0])) + '</td><td class="num">' + escapeHtml(String(r[1])) + '</td><td class="r"><span class="st ' + r[2] + '">' + escapeHtml(String(r[1])) + '</span></td></tr>';
      }).join('');
      var hs = document.getElementById('qf-holiday-status');
      if (hs && q.holiday) {
        hs.textContent = q.holiday.label || 'Normal';
        hs.className = 'st ' + (q.holiday.isHoliday ? 'r' : 'g');
      }
      var hd = document.getElementById('qf-holiday-detail');
      if (hd && q.holiday) hd.textContent = q.holiday.label + (q.holiday.saveQuota ? ' · hemat ~' + q.holiday.saveQuota + ' kuota (Broksum dibatalkan)' : '') + ' · lapis: ' + (q.holiday.layer || 'none');
    } catch (_) {}
  }
  root.renderQfStatus = renderQfStatus;

  function renderQuotaAuditHistory(logs) {
    try {
      var tb = document.getElementById('quota-audit-history-tbody');
      if (!tb) return;
      if (!Array.isArray(logs) || logs.length === 0) {
        tb.innerHTML = '<tr><td colspan="4" class="mut" style="text-align:center;padding:16px">Belum ada catatan mutasi pengaturan kuota.</td></tr>';
        return;
      }
      tb.innerHTML = logs.map(function(item) {
        var timeStr = item.timestampWIB || (item.timestampIso ? fmtWib(item.timestampIso) : '—');
        var actor = escapeHtml(item.actor || 'admin');
        var reason = escapeHtml(item.reason || 'Pembaruan konfigurasi kuota');
        var diffSummary = '';
        if (Array.isArray(item.diff) && item.diff.length > 0) {
          diffSummary = item.diff.map(function(d) {
            return '<span class="mono" style="font-size:11px">' + escapeHtml(d.field) + ': ' + escapeHtml(JSON.stringify(d.previous)) + ' &rarr; <b>' + escapeHtml(JSON.stringify(d.next)) + '</b></span>';
          }).join('<br>');
        } else {
          diffSummary = '<span class="mut mono" style="font-size:11px">v' + item.version + ' tersimpan</span>';
        }
        return '<tr><td class="mono mut" style="font-size:12px">' + timeStr + '</td><td class="font-bold">' + actor + '</td><td style="font-size:13px">' + reason + '</td><td>' + diffSummary + '</td></tr>';
      }).join('');
    } catch (_) {}
  }
  root.renderQuotaAuditHistory = renderQuotaAuditHistory;

  async function loadQuotaAuditHistory() {
    try {
      var res = await fetch('/api/admin/quota-settings');
      if (res.ok) {
        var data = await res.json().catch(function() { return {}; });
        if (data && data.auditHistory) renderQuotaAuditHistory(data.auditHistory);
      }
    } catch (_) {}
  }
  root.loadQuotaAuditHistory = loadQuotaAuditHistory;

  function qfPost(action, body) {
    return fetch('/api/admin-users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(Object.assign({ action: action }, body || {})) });
  }
  root.setHolidayMode = async function(mode, btn) {
    var st = document.getElementById('quotaSaveStatus');
    try {
      var tabs = ['qf-holiday-normal', 'qf-holiday-buka', 'qf-holiday-libur'];
      tabs.forEach(function(id) { var e = document.getElementById(id); if (e) e.classList.remove('on'); });
      if (btn) btn.classList.add('on');
      var backfill = document.getElementById('qf-toggle-backfillRemainder');
      var res = await qfPost('quota_holiday_set', { mode: mode, backfillRemainder: backfill ? backfill.checked : true });
      var data = await res.json().catch(function() { return {}; });
      if (res.ok && data && data.success) {
        if (st) st.textContent = 'Saklar libur: ' + mode + ' tersimpan.';
        applyStats({ quota: data.quota });
      } else if (st) st.textContent = 'Gagal saklar libur: ' + ((data && data.error) || res.status);
    } catch (_) { if (st) st.textContent = 'Gagal terhubung.'; }
  };
  root.detectHoliday = async function() {
    var st = document.getElementById('quotaSaveStatus');
    try {
      var res = await qfPost('quota_holiday_detect', {});
      var data = await res.json().catch(function() { return {}; });
      if (res.ok && data && data.success && data.holiday) {
        var hs = document.getElementById('qf-holiday-status');
        if (hs) { hs.textContent = data.holiday.label; hs.className = 'st ' + (data.holiday.isHoliday ? 'r' : 'g'); }
        var hd = document.getElementById('qf-holiday-detail');
        if (hd) hd.textContent = data.holiday.label + ' · lapis: ' + data.holiday.layer + (data.holiday.saveQuota ? ' · hemat ~' + data.holiday.saveQuota + ' kuota' : '');
        if (st) st.textContent = 'Deteksi: ' + data.holiday.label;
      } else if (st) st.textContent = 'Gagal deteksi: ' + ((data && data.error) || res.status);
    } catch (_) { if (st) st.textContent = 'Gagal terhubung.'; }
  };
  root.killUpstreamJobs = async function() {
    var st = document.getElementById('quotaSaveStatus');
    var word = 'KILL';
    var typed = window.prompt('Ketik ' + word + ' untuk kill semua upstream jobs (web tetap hidup):');
    if ((typed || '').trim().toUpperCase() !== word) { if (st) st.textContent = 'Dibatalkan.'; return; }
    try {
      var res = await qfPost('quota_kill_jobs', {});
      var data = await res.json().catch(function() { return {}; });
      if (st) st.textContent = (res.ok && data && data.success) ? 'Kill diminta (SIGTERM upstream saja).' : ('Gagal: ' + ((data && data.error) || res.status));
    } catch (_) { if (st) st.textContent = 'Gagal terhubung.'; }
  };
  root.forceCatchup = async function() {
    var st = document.getElementById('quotaSaveStatus');
    try {
      var res = await qfPost('quota_force_catchup', {});
      var data = await res.json().catch(function() { return {}; });
      if (res.ok && data && data.success) {
        if (st) st.textContent = data.runNow ? 'Antrean dibuat · kuota tersedia, jalan sekarang.' : 'Antrean dibuat · jalan otomatis 00:00:01 WIB saat reset.';
        if (data.quota) applyStats({ quota: data.quota });
      } else if (st) st.textContent = 'Gagal: ' + ((data && data.error) || res.status);
    } catch (_) { if (st) st.textContent = 'Gagal terhubung.'; }
  };
  root.triggerZeroJob = async function(name) {
    var st = document.getElementById('quotaSaveStatus');
    try {
      var res = await qfPost('quota_trigger_job', { job: name });
      var data = await res.json().catch(function() { return {}; });
      if (st) st.textContent = (res.ok && data && data.success) ? ('Trigger ' + name + ' tercatat (0 kuota).') : ('Gagal: ' + ((data && data.error) || res.status));
    } catch (_) { if (st) st.textContent = 'Gagal terhubung.'; }
  };
  // Slider live-label: hardStop 23:40/23:45/23:50 + stale 120/180/mati.
  try {
    document.addEventListener('input', function(ev) {
      var t = ev && ev.target;
      if (!t || !t.id) return;
      if (t.id === 'qf-hardStop') {
        var map = ['23:40', '23:45', '23:50'];
        var el = document.getElementById('qf-hardStopVal');
        if (el) el.textContent = map[Number(t.value)] || map[2];
      }
      if (t.id === 'qf-staleThreshold') {
        var map2 = ['mati (0)', '120 mnt', '180 mnt', 'mati (0)'];
        var el2 = document.getElementById('qf-staleVal');
        if (el2) el2.textContent = map2[Number(t.value)] || '120 mnt';
      }
    });
  } catch (_) {}
  root.saveQuotaConfig = async function(opts) {
    var st = document.getElementById('quotaSaveStatus');
    var num = function(id) { var e = document.getElementById(id); if (!e || e.value === '') return null; var v = Number(e.value); return Number.isFinite(v) ? v : null; };
    var patch = {};
    var m1 = num('qf-maxQuota'); if (m1 != null) { patch.configuredOperatingCap = m1; patch.dailyLimitOverride = m1; }
    var m2 = num('qf-weekdayBackfill'); if (m2 != null) patch.weekdayBackfillLimit = m2;
    var m3 = num('qf-weekendBackfill'); if (m3 != null) patch.weekendBackfillLimit = m3;
    var m4 = num('qf-reserveFloor'); if (m4 != null) { patch.reserveFloorWeekday = m4; patch.reserveFloorWeekdayDaytime = m4; patch.reserveFloorWeekdayNight = m4; }
    var hsIdx = (function() { var e = document.getElementById('qf-hardStop'); return e ? Number(e.value) : null; })();
    if (hsIdx != null && Number.isFinite(hsIdx)) patch.hardStopWIB = ['23:40', '23:45', '23:50'][hsIdx] || '23:50';
    var stIdx = (function() { var e = document.getElementById('qf-staleThreshold'); return e ? Number(e.value) : null; })();
    if (stIdx != null && Number.isFinite(stIdx)) patch.staleThresholdMinutes = [0, 120, 180, 0][stIdx];
    var tg = function(id) { var e = document.getElementById(id); return e ? e.checked : null; };
    var lq = tg('qf-toggle-lowQuota'); if (lq != null) patch.lowQuotaMode = lq;
    var md = tg('qf-toggle-muteDaily'); if (md != null) patch.telegramMuteDaily = md;
    var me = tg('qf-toggle-muteEmergency'); if (me != null) patch.telegramMuteEmergency = me;
    var mn = tg('qf-toggle-muteNonCritical'); if (mn != null) patch.telegramMuteNonCritical = mn;
    var pf = tg('qf-toggle-preflight'); if (pf != null) patch.dynamicPreflightGate = pf;
    var br = tg('qf-toggle-backfillRemainder'); if (br != null) patch.holidayBackfillRemainder = br;

    // Throughput & failure tolerance
    var conc = num('qf-concurrency'); if (conc != null) patch.concurrency = conc;
    var rl = num('qf-rateLimit'); if (rl != null) patch.rateLimit = rl;
    var rc = num('qf-retryCount'); if (rc != null) patch.retryCount = rc;
    var bo = num('qf-backoffBaseMs'); if (bo != null) patch.backoffBaseMs = bo;

    var poEl = document.getElementById('qf-priorityOrder');
    if (poEl && poEl.value) {
      patch.priorityOrder = poEl.value.split(',').map(function(s) { return s.trim(); }).filter(Boolean);
    }

    // Kill switch & paused services
    var ks = tg('qf-killSwitch');
    if (ks != null) patch.killSwitch = ks;

    patch.pausedServices = {
      backfill: Boolean(tg('qf-pause-backfill')),
      broksum: Boolean(tg('qf-pause-broksum')),
      foreign: Boolean(tg('qf-pause-foreign')),
      insider: Boolean(tg('qf-pause-insider')),
      candles: Boolean(tg('qf-pause-candles')),
      financial: Boolean(tg('qf-pause-financial'))
    };

    if (!Object.keys(patch).length) { if (st) st.textContent = 'Tidak ada perubahan.'; return; }

    var isTest = Boolean(window.__AUTOCUAN_TEST__ || (opts && opts.skipPrompt));
    var reason = 'Pembaruan konfigurasi 2 blok kuota oleh admin';
    if (!isTest && typeof window.prompt === 'function') {
      var word = 'KUOTA';
      var typed = window.prompt('Ketik ' + word + ' untuk menyimpan pengaturan kuota:');
      if ((typed || '').trim().toUpperCase() !== word) { if (st) st.textContent = 'Dibatalkan.'; return; }
      var userReason = window.prompt('Alasan perubahan kuota (wajib):');
      if (userReason && userReason.trim().length >= 3) reason = userReason.trim();
    }

    try {
      // V6 (Subtask C): hanya SATU endpoint mutasi terotorisasi. HTTP non-2xx
      // (404/403/409/500) adalah error nyata — TIDAK ada fallback /api/admin-users
      // yang menyembunyikan 404, dan TIDAK ada jalur "remaining=(limit||0)-(used||0)".
      var res = await fetch('/api/admin/quota-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ patch: patch, reason: reason })
      });
      var data = await res.json().catch(function() { return {}; });
      if (res.ok && data && (data.success || data.ok)) {
        if (st) st.textContent = 'Pengaturan kuota berhasil disimpan ke server (verifikasi readback OK).';
        recordAuditLog('budi', 'Simpan Pengaturan Kuota', reason.slice(0, 60));
        if (data.config) applyStats({ quota: data.config });
        else if (data.quota) applyStats({ quota: data.quota });
        loadQuotaAuditHistory();
      } else if (res.status === 409) {
        if (st) st.textContent = 'Konflik versi: konfigurasi berubah dari tempat lain. Muat ulang lalu simpan kembali.';
      } else if (res.status === 401 || res.status === 403) {
        if (st) st.textContent = 'Ditolak: ' + ((data && data.error) || 'butuh sesi admin / origin sama.');
      } else if (st) st.textContent = 'Gagal (HTTP ' + res.status + '): ' + ((data && data.error) || 'terjadi kesalahan.');
    } catch (_) { if (st) st.textContent = 'Gagal terhubung ke server (network).'; }
  };
  // S2: Tab Keamanan dan Audit — banner + metrik 24 jam + log insiden + Block/Unblock IP.
  function renderSecurityPanel(sec) {
    if (!sec) return;
    // Fail-closed: no telemetry => UNKNOWN/UNAVAILABLE, never "Aman"/"Berih".
    // "Aman" is only claimable with a real incident count + telemetry.
    var hasData = sec.available === true;
    var statusText = hasData ? (sec.status === "WASPADA" ? "WASPADA" : "AMAN") : "UNAVAILABLE";
    var statusClass = hasData ? (sec.status === "WASPADA" ? "a" : "g") : "x";

    var badge = document.getElementById("tabSecBadge");
    if (badge) { badge.textContent = statusText; badge.className = "st " + statusClass; }

    var banner = document.getElementById("secBanner");
    var bannerText = document.getElementById("secBannerText");
    if (banner && bannerText) {
      bannerText.textContent = hasData
        ? (sec.banner || sec.statusLabel || (sec.status === "WASPADA" ? "WASPADA" : "Aman — telemetri tersedia"))
        : "Keamanan tidak tersedia (telemetri/incident count tidak ditemukan)";
      banner.style.display = "flex";
    }

    var sb = document.getElementById("secStatusBadge");
    if (sb) { sb.textContent = statusText; sb.className = "st " + statusClass; }

    var sl = document.getElementById("secStatusLabel");
    if (sl) sl.textContent = hasData ? (sec.statusLabel || sec.banner || "") : "Data keamanan tidak tersedia.";
    var up = document.getElementById("secUpdatedAt");
    if (up) up.textContent = "Diperbarui: " + fmtWib(sec.updatedAt) + " · real-time";
    var m = sec.metrics24h || {};
    var setN = function(id, v) { var e = document.getElementById(id); if (e) e.textContent = fmtId(v == null ? 0 : v); };
    setN("secSshRejected", m.sshRejected); setN("secBotBlocked", m.botBlocked);
    setN("secLoginBlocked", m.loginFailedBlocked); setN("secActiveBlocks", m.activeBlocks);
    var tb = document.getElementById("secIncidentsTbody");
    if (tb) {
      var rows = Array.isArray(sec.incidents) ? sec.incidents : [];
      tb.innerHTML = rows.slice(0, 20).map(function(e) {
        return "<tr><td class=\"num mut\">" + escapeHtml(fmtWib(e.at)) + "</td><td><b>" + escapeHtml(e.type || "-") + "</b></td><td class=\"mono\">" + escapeHtml(e.ip || "-") + "</td><td class=\"r num\">" + escapeHtml(String(e.attempts == null ? 1 : e.attempts)) + "</td><td class=\"mut\">" + escapeHtml(e.reason || "") + "</td></tr>";
      }).join("") || "<tr><td colspan=\"5\" class=\"mut\" style=\"text-align:center;padding:24px\">Belum ada insiden.</td></tr>";
    }
  }
  // V3-F12: render panel Pertahanan Siber VPS (ufw/fail2ban/Ghidra/hash) di Tab Keamanan.
  function renderVpsPanel(vps) {
    if (!vps) return;
    var setT = function(id, v) { var e = document.getElementById(id); if (e) e.textContent = v; };
    var setBadge = function(id, ok, on, off) { var e = document.getElementById(id); if (e) { e.textContent = (ok ? on : off); e.className = "st " + (ok ? "g" : "a"); } };
    var ufw = vps.ufw || {};
    var f2b = vps.fail2ban || {};
    var procs = vps.processes || {};
    var bins = vps.binaries || {};
    var ghidra = vps.ghidra || {};
    setBadge("secUfwBadge", ufw.active === true, "UFW: AKTIF", "UFW: MATI");
    setBadge("secF2bBadge", f2b.active === true, "fail2ban: AKTIF", "fail2ban: MATI");
    setBadge("secGhidraBadge", Number(procs.foreignCount || 0) === 0, "Ghidra: 0 ASING", "Ghidra: ASING!");
    setT("secUfwRules", String(ufw.ruleCount == null ? "—" : ufw.ruleCount));
    setT("secUfwDetail", ufw.defaultDeny ? "default deny incoming" : "cek default policy");
    setT("secF2bJails", String((f2b.jails || []).length || "—"));
    setT("secF2bDetail", (f2b.jails || []).slice(0, 3).join(", ") || "sshd + nginx");
    setT("secForeignProcs", String(procs.foreignCount == null ? "—" : procs.foreignCount));
    setT("secForeignDetail", "total " + (procs.total == null ? "—" : procs.total) + " proses · target 0 asing");
    var h1 = ((bins.hashes || [])[0] || {}).sha256 || "";
    setT("secBinHash", h1 ? h1.slice(0, 16) + "…" : "—");
    setT("secVpsVerdict", (ghidra.verdict || (Number(procs.foreignCount || 0) === 0 ? "BERSIH-0-ASING" : "PERLU-TINDAK")) + " · " + fmtWib(vps.at));
    var up = document.getElementById("secVpsUpdatedAt");
    if (up) up.textContent = "Audit VPS 168.110.221.197 · " + fmtWib(vps.at) + " · data/security/vps-audit.json";
  }
  root.renderVpsPanel = renderVpsPanel;
  root.refreshSecurityPanel = async function() {
    try {
      var res = await fetch("/api/admin-users", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "security_status" }) });
      if (!res.ok) return;
      var data = await res.json().catch(function() { return {}; });
      if (data && data.success && data.security) renderSecurityPanel(data.security);
      if (data && data.vps) renderVpsPanel(data.vps);
      else if (data && data.security && data.security.vps) renderVpsPanel(data.security.vps);
      root.loadForensicAttackTable();
    } catch (_) {}
  };
  root.blockIpAction = function() {
    var ipEl = document.getElementById("secBlockIpInput");
    var rsEl = document.getElementById("secBlockReasonInput");
    var st = document.getElementById("secBlockStatus");
    var ip = ipEl ? ipEl.value.trim() : "";
    var reason = rsEl ? rsEl.value.trim() : "";
    if (!ip) { if (st) st.textContent = "Isi IP dulu."; return; }
    if (!reason || reason.length < 10) { if (st) st.textContent = "Alasan wajib minimal 10 karakter."; return; }
    promptAction({ title: "Blokir IP " + ip + "?", body: "IP ini langsung ditolak (429/403). Tercatat di log insiden.", word: "BLOKIR", action: function(r) {
      fetch("/api/admin-users", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "security_block_ip", ip: ip, reason: reason }) }).then(function(res) { return res.json().catch(function() { return {}; }); }).then(function(data) {
        if (data && data.success) { if (st) st.textContent = "IP " + ip + " diblokir."; recordAuditLog("budi", "Block IP " + ip, reason); root.refreshSecurityPanel(); }
        else if (st) st.textContent = "Gagal: " + ((data && data.error) || "unknown");
      }).catch(function() { if (st) st.textContent = "Gagal terhubung."; });
    } });
  };
  root.unblockIpAction = function() {
    var ipEl = document.getElementById("secBlockIpInput");
    var rsEl = document.getElementById("secBlockReasonInput");
    var st = document.getElementById("secBlockStatus");
    var ip = ipEl ? ipEl.value.trim() : "";
    var reason = rsEl ? rsEl.value.trim() : "";
    if (!ip) { if (st) st.textContent = "Isi IP dulu."; return; }
    if (!reason || reason.length < 10) { if (st) st.textContent = "Alasan wajib minimal 10 karakter."; return; }
    promptAction({ title: "Buka blokir IP " + ip + "?", body: "IP kembali bisa mengakses. Tercatat di log insiden.", word: "BUKA", action: function(r) {
      fetch("/api/admin-users", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "security_unblock_ip", ip: ip, reason: reason }) }).then(function(res) { return res.json().catch(function() { return {}; }); }).then(function(data) {
        if (data && data.success) { if (st) st.textContent = "IP " + ip + " dibuka."; recordAuditLog("budi", "Unblock IP " + ip, reason); root.refreshSecurityPanel(); }
        else if (st) st.textContent = "Gagal: " + ((data && data.error) || "unknown");
      }).catch(function() { if (st) st.textContent = "Gagal terhubung."; });
    } });
  };
  root.triggerBackfillNow = function() {
    promptAction({
      title: 'Picu Backfill Sekarang?',
      body: 'Pemicu backfill akan dikirim ke worker consumer (staging/fixture). Tercatat di log audit + ledger worker.',
      word: 'BACKFILL',
      action: function(reason) {
        recordAuditLog('budi', 'Picu backfill', reason);
        try {
          fetch('/api/admin/quota-backfill-trigger', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ reason: reason || 'manual-backfill' })
          }).then(function(res) { return res.json().catch(function() { return {}; }); })
            .then(function(data) {
              var st = document.getElementById('quotaSaveStatus');
              if (st) st.textContent = (data && data.success) ? ('Backfill dikirim ke worker; ' + (data.processed != null ? data.processed + ' diproses.' : 'antre.')) : ('Gagal: ' + ((data && data.error) || 'unknown'));
              root.refreshBackfillForecast();
            })
            .catch(function() { root.refreshBackfillForecast(); });
        } catch (_) {
          root.refreshBackfillForecast();
        }
      }
    });
  };

  // FASE V6.5: Tabel Forensik Serangan & Pemblokiran Bot/IP — 100% dari server
  var lastLoadedForensicAttacks = [];

  root.loadForensicAttackTable = async function() {
    var tb = document.getElementById('forensicAttackTbody');
    if (!tb) return;
    try {
      var res = await fetch('/api/admin/security-audit', { method: 'GET', headers: { 'Accept': 'application/json' } });
      if (res.ok) {
        var data = await res.json().catch(function() { return {}; });
        if (data && data.success && Array.isArray(data.attacks)) {
          lastLoadedForensicAttacks = data.attacks;
          renderForensicAttackRows(lastLoadedForensicAttacks);
          return;
        }
      }
    } catch (_) {}
    lastLoadedForensicAttacks = [];
    renderForensicAttackRows([]);
  };
  root.refreshForensicAttackTable = root.loadForensicAttackTable;

  function renderForensicAttackRows(attacks) {
    var tb = document.getElementById('forensicAttackTbody');
    if (!tb) return;
    if (!attacks || attacks.length === 0) {
      tb.innerHTML = '<tr><td colspan="6" class="mut" style="text-align:center;padding:24px">Tidak ada data serangan yang tercatat.</td></tr>';
      return;
    }
    tb.innerHTML = attacks.map(function(item) {
      var badgeClass = item.blocked ? 'r' : 'g';
      var rule = String(item.rule || 'Malicious Ingress');
      return '<tr>' +
        '<td class="num mut">' + escapeHtml(formatAuditTimeWib(item.at)) + '</td>' +
        '<td class="mono font-bold">' + escapeHtml(item.ip || '—') + '</td>' +
        '<td><span class="st ' + (rule.indexOf('Probe') >= 0 || rule.indexOf('Traversal') >= 0 ? 'r' : 'a') + '">' + escapeHtml(rule) + '</span></td>' +
        '<td class="mono mut">' + escapeHtml(item.target || '/') + '</td>' +
        '<td class="mut">' + escapeHtml(item.ua || 'Unknown Scanner') + '</td>' +
        '<td><span class="st ' + badgeClass + '">' + escapeHtml(item.status || (item.blocked ? 'DIBLOKIR OTOMATIS' : 'DIBUKA')) + '</span></td>' +
      '</tr>';
    }).join('');
  }

  root.unblockForensicIpPrompt = function(targetIp) {
    var ip = targetIp;
    if (!ip) {
      ip = window.prompt ? window.prompt('Masukkan Alamat IP yang akan dibuka blokirnya:', '') : '';
    }
    if (!ip) return;
    ip = String(ip).trim();
    fetch('/api/admin/security-audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'unblock_ip', ip: ip, reason: 'Unblock via Tabel Forensik Admin' })
    }).then(function() { return root.loadForensicAttackTable(); }).catch(function() {});
    recordAuditLog('budi', 'Unblock IP Forensik ' + ip, 'Buka blokir dari Tabel Forensik Serangan');
    if (typeof alert === 'function' && !window.__AUTOCUAN_TEST__) {
      alert('Permintaan buka blokir IP ' + ip + ' telah dikirim ke server.');
    }
  };

  root.clearForensicAttackLogs = function() {
    fetch('/api/admin/security-audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ action: 'clear_test_logs' })
    }).then(function() { return root.loadForensicAttackTable(); }).catch(function() {});
    recordAuditLog('budi', 'Bersihkan Log Forensik', 'Reset log pengujian serangan di server');
    if (typeof alert === 'function' && !window.__AUTOCUAN_TEST__) {
      alert('Permintaan pembersihan log serangan telah dikirim.');
    }
  };

  // ── V6.5 Three-Horizon Screener SSOT Configuration ──────────────────────
  var threeHorizonState = { config: null };

  function renderThreeHorizonPanel(cfg) {
    if (!cfg || !cfg.horizons) return;
    var verEl = document.getElementById('thVersionLabel');
    if (verEl) verEl.textContent = 'v' + (cfg.version || 1) + (cfg.updatedBy ? ' · ' + cfg.updatedBy : '');
    var minRrEl = document.getElementById('thMinRrInput');
    if (minRrEl) minRrEl.value = cfg.minRr != null ? cfg.minRr : 1.5;
    ['potensi_besok', 'short_swing', 'swing'].forEach(function(k) {
      var h = cfg.horizons[k];
      if (!h) return;
      var lb = document.getElementById('thLookback_' + k);
      if (lb) lb.value = h.lookbackDays != null ? h.lookbackDays : '';
      var w = h.weights || {};
      ['bandar', 'foreign', 'technical', 'volume'].forEach(function(p) {
        var el = document.getElementById('thW_' + p + '_' + k);
        if (el) el.value = w[p] != null ? w[p] : '';
      });
    });
  }

  root.loadThreeHorizonSettings = async function() {
    var st = document.getElementById('threeHorizonSaveStatus');
    try {
      var res = await fetch('/api/admin/three-horizon-settings', { method: 'GET', headers: { 'Accept': 'application/json' } });
      if (!res.ok) return;
      var data = await res.json().catch(function() { return {}; });
      if (data && data.success && data.config) {
        threeHorizonState.config = data.config;
        renderThreeHorizonPanel(data.config);
      }
    } catch (_) {
      if (st) st.textContent = 'Gagal memuat konfigurasi Three-Horizon.';
    }
  };

  root.saveThreeHorizonSettings = async function() {
    var st = document.getElementById('threeHorizonSaveStatus');
    var cfg = threeHorizonState.config;
    if (!cfg) { if (st) st.textContent = 'Konfigurasi Three-Horizon belum termuat.'; return; }
    var patchHorizons = {};
    ['potensi_besok', 'short_swing', 'swing'].forEach(function(k) {
      var lbEl = document.getElementById('thLookback_' + k);
      var wB = Number((document.getElementById('thW_bandar_' + k) || {}).value || 0);
      var wF = Number((document.getElementById('thW_foreign_' + k) || {}).value || 0);
      var wT = Number((document.getElementById('thW_technical_' + k) || {}).value || 0);
      var wV = Number((document.getElementById('thW_volume_' + k) || {}).value || 0);
      patchHorizons[k] = {
        lookbackDays: Number(lbEl ? lbEl.value : 30),
        weights: { bandar: wB, foreign: wF, technical: wT, volume: wV }
      };
    });
    var minRr = Number((document.getElementById('thMinRrInput') || {}).value || 1.5);
    var reason = 'Update Three-Horizon SSOT via Admin Console';
    if (!window.__AUTOCUAN_TEST__ && typeof window.prompt === 'function') {
      var inputReason = window.prompt('Alasan perubahan konfigurasi Three-Horizon Screener (min 3 karakter):', reason);
      if (!inputReason || inputReason.trim().length < 3) {
        if (st) st.textContent = 'Dibatalkan (alasan wajib diisi).';
        return;
      }
      reason = inputReason.trim();
    }
    if (st) st.textContent = 'Menyimpan Three-Horizon SSOT…';
    try {
      var res = await fetch('/api/admin/three-horizon-settings', {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ version: cfg.version, reason: reason, patch: { minRr: minRr, horizons: patchHorizons } })
      });
      var data = await res.json().catch(function() { return {}; });
      if (res.ok && data && data.success) {
        threeHorizonState.config = data.config;
        renderThreeHorizonPanel(data.config);
        if (st) { st.style.color = 'var(--ac-brand,#10B981)'; st.textContent = 'Tersimpan · v' + data.config.version; }
        recordAuditLog('budi', 'Simpan Three-Horizon SSOT', reason);
      } else if (res.status === 409) {
        if (data && data.config) { threeHorizonState.config = data.config; renderThreeHorizonPanel(data.config); }
        if (st) { st.style.color = 'var(--ac-warn,#F59E0B)'; st.textContent = 'Konflik versi (409) — konfigurasi dimuat ulang.'; }
      } else {
        if (st) { st.style.color = 'var(--ac-warn,#F59E0B)'; st.textContent = 'Gagal: ' + ((data && data.error) || ('HTTP ' + res.status)); }
      }
    } catch (_) {
      if (st) { st.style.color = 'var(--ac-warn,#F59E0B)'; st.textContent = 'Gagal terhubung ke server.'; }
    }
  };

  // ── TASK C: Financial publication windows + incomplete issuer list ────────
  var FP_DEADLINES = {
    Q1: '30 Apr', Q2: '31 Jul', Q3: '31 Oct', Q4: '31 Jan (un-audited)', FY: '31 Mar (audited FY)'
  };
  function fpEscape(v) {
    var amp = "&amp;";
    var lt = "&lt;";
    var gt = "&gt;";
    var quot = "&quot;";
    var apos = "&#39;";
    var map = {};
    map[38] = amp; map[60] = lt; map[62] = gt;
    map[34] = quot; map[39] = apos;
    return String(v == null ? "—" : v).replace(/[&<>"']/g, function(c) {
      return map[c.charCodeAt(0)] || c;
    });
  }
  root.loadFinancialPublicationPanel = async function() {
    var status = document.getElementById('fpActionStatus');
    try {
      var res = await fetch('/api/admin/financial-publication?view=status', { headers: { 'Accept': 'application/json' } });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json();
      if (!data || data.success !== true) throw new Error('RESPONSE_NOT_SUCCESS');
      var w = data.fetch_windows || {};
      var ver = document.getElementById('fpWindowVersion');
      if (ver) ver.textContent = 'v' + (w.version == null ? '—' : w.version);
      var wtb = document.getElementById('fpWindowsTbody');
      if (wtb) {
        var periods = w.periods || {};
        var rows = ['Q1', 'Q2', 'Q3', 'Q4', 'FY'].map(function(p) {
          var r = periods[p] || {};
          var win = r.startDay && r.endDay ? ('05–15 → ' + String(r.startDay).padStart(2, '0') + '–' + String(r.endDay).padStart(2, '0')) : '—';
          return '<tr><td class="mono">' + p + '</td><td>' + FP_DEADLINES[p] + '</td><td class="mono">' + fpEscape(win) + '</td><td class="st g">ACTIVE</td></tr>';
        });
        wtb.innerHTML = rows.join('');
      }
      var inc = data.incomplete_issuers || {};
      var cnt = document.getElementById('fpIncompleteCount');
      if (cnt) cnt.textContent = (inc.count == null ? '—' : inc.count) + ' issuer-period';
      var itb = document.getElementById('fpIncompleteTbody');
      if (itb) {
        var entries = inc.entries || [];
        if (!entries.length) {
          itb.innerHTML = '<tr><td colspan="8" class="mut" style="text-align:center;padding:20px">Tidak ada issuer incomplete.</td></tr>';
        } else {
          itb.innerHTML = entries.map(function(e) {
            var key = fpEscape(e.ticker) + '|' + fpEscape(e.fiscal_year) + '|' + fpEscape(e.period);
            return '<tr>' +
              '<td class="mono">' + fpEscape(e.ticker) + '</td>' +
              '<td class="num">' + fpEscape(e.fiscal_year) + '</td>' +
              '<td class="mono">' + fpEscape(e.period) + '</td>' +
              '<td><span class="st a">' + fpEscape(e.status) + '</span></td>' +
              '<td class="mono">' + fpEscape(e.source) + '</td>' +
              '<td class="mono">' + fpEscape(e.as_of) + '</td>' +
              '<td>' + fpEscape(e.reason) + '</td>' +
              '<td class="r"><button class="btn sm" data-fp-fetch="' + key + '" onclick="fpManualFetch(this)">Fetch (Mock)</button></td>' +
              '</tr>';
          }).join('');
        }
      }
      if (status) status.textContent = 'Dimuatan: ' + new Date().toLocaleTimeString('id-ID');
    } catch (err) {
      if (status) status.textContent = 'Gagal memuat: ' + (err && err.message ? err.message : 'unknown');
    }
  };
  root.fpManualFetch = async function(btn) {
    var status = document.getElementById('fpActionStatus');
    var parts = String(btn && btn.getAttribute('data-fp-fetch') || '').split('|');
    if (parts.length !== 3) return;
    if (status) status.textContent = 'Menjalankan manual fetch (MOCK, 0 provider call)…';
    try {
      var res = await fetch('/api/admin/financial-publication', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
        body: JSON.stringify({ action: 'manual_fetch', ticker: parts[0], fiscal_year: Number(parts[1]), period: parts[2] })
      });
      var data = await res.json();
      if (!res.ok || !data.success) throw new Error(data.error || ('HTTP ' + res.status));
      if (status) status.textContent = 'Selesai: ' + data.outcome + ' · http=' + data.httpRequests + ' · billed=' + data.billedUnits;
      await root.loadFinancialPublicationPanel();
    } catch (err) {
      if (status) status.textContent = 'Gagal: ' + (err && err.message ? err.message : 'unknown');
    }
  };

  root.initAdminConsole = function() {
    verifyAdminAuth();
    root.loadFinancialPublicationPanel();
    root.refreshBackfillForecast();
    root.loadThreeHorizonSettings();
  };

  // Auto-init on standalone admin page
  if (typeof window !== 'undefined' && window.location && window.location.pathname.indexOf('admin') !== -1) {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', verifyAdminAuth);
    } else {
      verifyAdminAuth();
    }
  }
})(typeof window !== 'undefined' ? window : globalThis);
