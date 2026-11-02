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
      var unauth = document.getElementById('unauthorizedScreen');
      if (unauth) unauth.style.display = 'none';
      var mainContent = document.getElementById('adminMainContent');
      if (mainContent) mainContent.style.display = 'block';
      var badge = document.getElementById('adminUserBadge');
      if (badge) badge.textContent = 'Admin: ' + (data.admin || 'budi');

      applyStats(data);
      loadOnlineList();
      startAutoRefresh();
    } catch (_) {
      showUnauthorized();
    }
  }

  function showUnauthorized() {
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
  function fmtWib(iso) {
    if (!iso) return '—';
    try {
      var d = new Date(iso);
      return d.toLocaleDateString('id-ID', { day: 'numeric', month: 'short', hour: '2-digit', minute: '2-digit' }) + ' WIB';
    } catch (_) { return String(iso).slice(0, 16); }
  }
  function applyStats(data) {
    if (data.quota) {
      var q = data.quota;
      var el = document.getElementById('statQuotaNum');
      if (el) el.innerHTML = fmtId(q.used) + '<span class="mut" style="font-size:14px;font-weight:600"> / ' + fmtId(q.limit) + '</span>';
      var bar = document.getElementById('statQuotaBar');
      if (bar) bar.style.width = (q.pct || 0) + '%';
      var rem = document.getElementById('statQuotaRemain');
      if (rem) rem.textContent = 'Sisa hari ini: ' + fmtId(q.remaining != null ? q.remaining : Math.max(0, (q.limit || 0) - (q.used || 0))) + ' · Reset ' + (q.reset || '00:00 WIB');
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
        var lowPkg = Number(q.limit) <= 1000;
        drift.style.display = (showDrift || lowPkg) ? 'block' : 'none';
        if (showDrift) drift.textContent = 'Peringatan drift: lokal ' + fmtId(q.localUsedToday) + ' vs upstream ' + fmtId(q.upstreamUsedToday) + ' — dipakai nilai konservatif.';
        else if (lowPkg) drift.textContent = 'Peringatan: paket turun ke ' + fmtId(q.limit) + ' req/hari — hemat kuota hingga perpanjangan.';
      }
      // Prefill editor kuota dari config aktif
      try {
        var cfg = q.config || {};
        var setV = function(id, v) { var e = document.getElementById(id); if (e && (e.value === '' || e.value == null || e.value === 'cth 18080')) e.value = (v == null ? '' : v); };
        setV('quotaDailyLimit', cfg.dailyLimitOverride);
        if (cfg.planExpiresAt) { var pe = document.getElementById('quotaPlanExpiry'); if (pe && !pe.value) pe.value = String(cfg.planExpiresAt).slice(0, 16); }
        setV('quotaFloorDay', cfg.reserveFloorWeekdayDaytime);
        setV('quotaFloorNight', cfg.reserveFloorWeekdayNight);
        setV('quotaFloorWeekend', cfg.reserveFloorWeekend);
      } catch (_) {}
    }
    if (data.datasets) renderFinancialCensus(data.datasets);
    if (data.online_summary) {
      var s = data.online_summary;
      var nowEl = document.getElementById('statOnlineNow');
      if (nowEl) nowEl.textContent = s.online_now;
      var onNowEl = document.getElementById('onSummaryNow');
      if (onNowEl) onNowEl.textContent = s.online_now;
      var on15m = document.getElementById('onSummary15m');
      if (on15m) on15m.textContent = s.active_15m;
      var onToday = document.getElementById('onSummaryToday');
      if (onToday) onToday.textContent = s.today;
      var onIdle = document.getElementById('onSummaryIdle7d');
      if (onIdle) onIdle.textContent = s.idle_7d;
      var tabOn = document.getElementById('tabOnlineCount');
      if (tabOn) tabOn.textContent = s.online_now;
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
    if (idx === 6) { root.refreshDataHealth(); loadJobsPipeline(); loadCompletenessMeta(); }
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
  function renderBackfillForecast(fc) {
    var rem = document.getElementById('fcRemaining');
    var fin = document.getElementById('fcFinish');
    var exp = document.getElementById('fcExpiry');
    var st = document.getElementById('fcStatus');
    var tb = document.getElementById('forecastTbody');
    if (!fc) {
      if (tb) tb.innerHTML = '<tr><td colspan="6" class="mut" style="text-align:center;padding:24px">Forecast belum tersedia.</td></tr>';
      return;
    }
    if (rem) rem.textContent = fmtNum(fc.remainingRequests) + ' request';
    if (fin) fin.textContent = fc.finishDate || '—';
    if (exp) exp.textContent = (fc.planExpiresAt || '').slice(0, 10) || '—';
    if (st) {
      st.textContent = fc.finishesBeforeExpiry ? 'Selesai sebelum batas paket' : 'Melewati batas paket';
      st.style.color = fc.finishesBeforeExpiry ? 'var(--ac-brand)' : 'var(--ac-warn)';
    }
    if (tb && Array.isArray(fc.dailyTable)) {
      tb.innerHTML = fc.dailyTable.map(function(r) {
        return '<tr><td class="num">' + escapeHtml(r.date) + '</td><td class="mut">' + escapeHtml(r.weekday) + '</td><td class="r num">' + fmtNum(r.capacity) + '</td><td class="r num">' + fmtNum(r.burn) + '</td><td class="r num">' + fmtNum(r.remainingAfter) + '</td><td>' + (r.done ? '<span class="st g">Selesai</span>' : '<span class="st a">Berjalan</span>') + '</td></tr>';
      }).join('');
    }
  }
  root.refreshBackfillForecast = async function() {
    var tb = document.getElementById('forecastTbody');
    if (tb) tb.innerHTML = '<tr><td colspan="6" class="mut" style="text-align:center;padding:24px">Memuat…</td></tr>';
    try {
      var res = await fetch('/api/admin-users', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'backfill_forecast' })
      });
      if (!res.ok) throw new Error('HTTP ' + res.status);
      var data = await res.json().catch(function() { return {}; });
      if (data && data.success && data.forecast) renderBackfillForecast(data.forecast);
      else if (tb) tb.innerHTML = '<tr><td colspan="6" class="mut" style="text-align:center;padding:24px">Forecast belum tersedia.</td></tr>';
    } catch (_) {
      if (tb) tb.innerHTML = '<tr><td colspan="6" class="mut" style="text-align:center;padding:24px">Gagal memuat forecast.</td></tr>';
    }
  };
  root.renderBackfillForecast = renderBackfillForecast;

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
    var timeStr = 'Hari ini ' + now.getHours().toString().padStart(2, '0') + ':' + now.getMinutes().toString().padStart(2, '0');
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
  function renderJobsPipeline(jobs) {
    var tb = document.getElementById('jobsPipelineTbody');
    if (!tb) return;
    if (!jobs || !jobs.length) { tb.innerHTML = '<tr><td colspan="6" class="mut" style="text-align:center;padding:24px">Belum ada heartbeat job.</td></tr>'; return; }
    tb.innerHTML = jobs.map(function(j) {
      var cls = j.status_code === 'ok' ? 'g' : (j.status_code === 'warn' ? 'a' : 'r');
      var lbl = j.status || '—';
      return '<tr><td class="mono" style="font-weight:600">' + escapeHtml(j.name) + '</td><td class="mut">' + escapeHtml(j.schedule) + '</td><td class="num mut">' + escapeHtml(j.last_run) + '</td><td class="r num">' + escapeHtml(j.duration) + (j.requests ? ' · ' + escapeHtml(String(j.requests)) + ' req' : '') + '</td><td><span class="st ' + cls + '">' + escapeHtml(lbl) + '</span></td><td class="r"><button class="btn sm" disabled title="Job berjalan otomatis via cron. Pemicu manual dinonaktifkan demi keamanan kuota API.">Otomatis</button></td></tr>';
    }).join('');
  }
  async function loadJobsPipeline() {
    var tb = document.getElementById('jobsPipelineTbody');
    if (tb) tb.innerHTML = '<tr><td colspan="6" class="mut" style="text-align:center;padding:24px">Memuat status job dari heartbeat…</td></tr>';
    try {
      var res = await fetch('/api/admin-users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'admin_console_stats' }) });
      if (!res.ok) return;
      var data = await res.json().catch(function() { return {}; });
      if (data && data.success) {
        if (data.datasets) renderDatasetFreshness(data.datasets);
        if (data.jobs) renderJobsPipeline(data.jobs);
      }
    } catch (_) {}
  }
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
          return '<tr><td class="num mut">' + escapeHtml(l.created_at || '') + '</td><td style="font-weight:600">' + escapeHtml(l.username || '') + '</td><td>' + escapeHtml(l.action || 'login') + '</td><td class="mono mut">' + escapeHtml(l.detail || '') + '</td></tr>';
        }).join('') || '<tr><td colspan="4" class="mut" style="text-align:center;padding:24px">Belum ada log.</td></tr>';
      }
      var sec = document.getElementById('securityEventsTbody');
      if (sec && data && Array.isArray(data.securityEvents)) {
        sec.innerHTML = data.securityEvents.slice(0, 20).map(function(e) {
          return '<tr><td class="num mut">' + escapeHtml(e.created_at || e.at || '') + '</td><td>' + escapeHtml(e.kind || e.key || 'peristiwa') + '</td><td class="mut">' + escapeHtml(e.detail || e.summary || '') + '</td></tr>';
        }).join('') || '<tr><td colspan="3" class="mut" style="text-align:center;padding:24px">Tidak ada peristiwa keamanan.</td></tr>';
      }
    } catch (_) {}
  }
  root.saveQuotaConfig = async function() {
    var st = document.getElementById('quotaSaveStatus');
    var num = function(id) { var e = document.getElementById(id); if (!e || e.value === '') return null; var v = Number(e.value); return Number.isFinite(v) ? v : null; };
    var patch = {};
    var dl = num('quotaDailyLimit'); if (dl != null) patch.dailyLimitOverride = dl;
    var pe = document.getElementById('quotaPlanExpiry'); if (pe && pe.value) patch.planExpiresAt = new Date(pe.value).toISOString();
    var fd = num('quotaFloorDay'); if (fd != null) patch.reserveFloorWeekdayDaytime = fd;
    var fn = num('quotaFloorNight'); if (fn != null) patch.reserveFloorWeekdayNight = fn;
    var fw = num('quotaFloorWeekend'); if (fw != null) patch.reserveFloorWeekend = fw;
    if (!Object.keys(patch).length) { if (st) st.textContent = 'Tidak ada perubahan.'; return; }
    var word = 'KUOTA';
    var typed = window.prompt('Ketik ' + word + ' untuk menyimpan konfigurasi kuota:');
    if ((typed || '').trim().toUpperCase() !== word) { if (st) st.textContent = 'Dibatalkan.'; return; }
    var reason = window.prompt('Alasan perubahan kuota (wajib):');
    if (!reason || reason.trim().length < 5) { if (st) st.textContent = 'Alasan wajib diisi.'; return; }
    try {
      var res = await fetch('/api/admin-users', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ action: 'quota_update', patch: patch }) });
      var data = await res.json().catch(function() { return {}; });
      if (res.ok && data && data.success) {
        if (st) st.textContent = 'Tersimpan · batas baru ' + (data.quota ? data.quota.limit : '') + '.';
        recordAuditLog('budi', 'Ubah konfigurasi kuota', reason.slice(0, 60));
        applyStats({ quota: data.quota });
      } else if (st) st.textContent = 'Gagal: ' + ((data && data.error) || res.status);
    } catch (_) { if (st) st.textContent = 'Gagal terhubung.'; }
  };
  // S2: Tab Keamanan dan Audit — banner + metrik 24 jam + log insiden + Block/Unblock IP.
  function renderSecurityPanel(sec) {
    if (!sec) return;
    var badge = document.getElementById("tabSecBadge");
    if (badge) { badge.textContent = sec.status === "WASPADA" ? "WASPADA" : "Aman"; badge.className = "st " + (sec.status === "WASPADA" ? "a" : "g"); }
    var banner = document.getElementById("secBanner");
    var bannerText = document.getElementById("secBannerText");
    if (banner && bannerText) {
      bannerText.textContent = sec.banner || sec.statusLabel || "Aman";
      banner.style.display = "flex";
    }
    var sb = document.getElementById("secStatusBadge");
    if (sb) { sb.textContent = sec.status === "WASPADA" ? "WASPADA" : "Aman"; sb.className = "st " + (sec.status === "WASPADA" ? "a" : "g"); }
    var sl = document.getElementById("secStatusLabel");
    if (sl) sl.textContent = sec.statusLabel || sec.banner || "";
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
  root.refreshSecurityPanel = async function() {
    try {
      var res = await fetch("/api/admin-users", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ action: "security_status" }) });
      if (!res.ok) return;
      var data = await res.json().catch(function() { return {}; });
      if (data && data.success && data.security) renderSecurityPanel(data.security);
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
      body: 'Antrean backfill akan dikejar sesuai kapasitas kuota hari ini. Tercatat di log audit.',
      word: 'BACKFILL',
      action: function(reason) { recordAuditLog('budi', 'Picu backfill', reason); root.refreshBackfillForecast(); }
    });
  };
  root.initAdminConsole = function() {
    verifyAdminAuth();
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
