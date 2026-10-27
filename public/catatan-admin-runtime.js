'use strict';

// Catatan Admin Runtime (HANDOFF §5d & Canvas CatatanAdmin.dc.html)
(function () {
  var _catatanAdminCache = null;
  var _currentTab = 'active';
  var _currentStyle = 'all';
  var _drawerMode = 'new';
  var _editingNoteId = null;
  var _catatanPriceLines = [];
  var _activeNoteOnChart = null;

  function isUserAdmin() {
    try {
      if (typeof isAdmin === 'function' && isAdmin()) return true;
      if (window.__AUTOCUAN_PREVIEW_USER__ && window.__AUTOCUAN_PREVIEW_USER__.role === 'ADMIN') return true;
      if (window.premiumAccessState && window.premiumAccessState.accessLevel === 'admin') return true;
      if (localStorage.getItem('autocuan_is_admin') === 'true') return true;
      if (localStorage.getItem('autocuan_role') === 'ADMIN') return true;
    } catch (_) {}
    return false;
  }

  function formatRp(val) {
    if (val == null || isNaN(val)) return '—';
    return Number(val).toLocaleString('id-ID');
  }

  function formatPct(val) {
    if (val == null || isNaN(val)) return '—';
    var num = Number(val);
    var sign = num > 0 ? '+' : (num < 0 ? '−' : '');
    return sign + Math.abs(num).toFixed(2).replace('.', ',') + '%';
  }

  function formatDate(isoStr) {
    if (!isoStr) return '—';
    try {
      var d = new Date(isoStr);
      return d.toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short' });
    } catch (_) {
      return '—';
    }
  }

  function formatDateTime(isoStr) {
    if (!isoStr) return '—';
    try {
      var d = new Date(isoStr);
      var datePart = d.toLocaleDateString('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short' });
      var timePart = d.toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', hour12: false });
      return datePart + ', ' + timePart + ' WIB';
    } catch (_) {
      return '—';
    }
  }

  function getStatusClass(status) {
    switch (status) {
      case 'Di area pantau': return 'hit';
      case 'Kena target': return 'hit';
      case 'Kena batas risiko': return 'sl';
      case 'Ditutup admin': return 'cl';
      case 'Kedaluwarsa': return 'ex';
      default: return 'act';
    }
  }

  // Load Catatan Admin data from API
  async function loadCatatanAdmin(silent) {
    var activeGrid = document.getElementById('anActiveGrid');
    var histTableBody = document.getElementById('anHistoryTableBody');
    var btnNew = document.getElementById('btnNewAdminNote');

    if (btnNew) {
      btnNew.style.display = isUserAdmin() ? '' : 'none';
    }

    if (!silent && activeGrid && (!activeGrid.children || activeGrid.children.length === 0)) {
      activeGrid.innerHTML = '<div class="col-span-full py-12 text-center text-gray-500"><div class="spinner inline-block mr-2"></div> Memuat catatan admin...</div>';
    }

    try {
      var res = await fetch('/api/admin-notes?status=all');
      var data = await res.json();
      if (!data.success) return;
      _catatanAdminCache = data;

      // Update Summary Strip
      if (data.summary) {
        var elAct = document.getElementById('anSummaryActive');
        var elHit = document.getElementById('anSummaryHit');
        var elAvg = document.getElementById('anSummaryAvg');
        if (elAct) elAct.textContent = data.summary.total_active != null ? data.summary.total_active : '—';
        if (elHit) {
          elHit.innerHTML = (data.summary.target_hit != null ? data.summary.target_hit : '—') +
            ' <span class="mut" style="font-size:14px;font-weight:600">/ ' + (data.summary.total_evaluated != null ? data.summary.total_evaluated : '—') + ' catatan</span>';
        }
        if (elAvg) {
          var avgNum = Number(data.summary.avg_gain_pct || 0);
          elAvg.textContent = (avgNum >= 0 ? '+' : '−') + Math.abs(avgNum).toFixed(1).replace('.', ',') + '%';
          elAvg.className = 'big num pop ' + (avgNum >= 0 ? 'pos' : 'neg');
        }

        // Update counts in sidebar & tab
        var navBadge = document.getElementById('navCatatanAdminCount');
        if (navBadge) {
          navBadge.textContent = data.summary.total_active || '0';
          navBadge.style.display = data.summary.total_active > 0 ? '' : 'none';
        }
      }

      renderCatatanAdminView();
    } catch (err) {
      if (activeGrid) activeGrid.innerHTML = '<div class="col-span-full py-12 text-center text-red-400">Gagal memuat catatan admin.</div>';
    }
  }

  function renderCatatanAdminView() {
    if (!_catatanAdminCache || !Array.isArray(_catatanAdminCache.notes)) return;

    var notes = _catatanAdminCache.notes;
    var activeStatuses = ['Di area pantau', 'Menunggu harga turun ke area', 'Di bawah area pantau'];
    var activeNotes = notes.filter(n => activeStatuses.includes(n.status));
    var historyNotes = notes.filter(n => !activeStatuses.includes(n.status));

    // Update tab counters
    var actCountEl = document.getElementById('anActiveTabCount');
    var histCountEl = document.getElementById('anHistoryTabCount');
    if (actCountEl) actCountEl.textContent = '(' + activeNotes.length + ')';
    if (histCountEl) histCountEl.textContent = '(' + historyNotes.length + ')';

    // Filter by tab & style
    var currentList = _currentTab === 'active' ? activeNotes : historyNotes;
    if (_currentStyle === 'daytrade' || _currentStyle === 'swing') {
      currentList = currentList.filter(n => n.style === _currentStyle);
    }

    var activeContainer = document.getElementById('anActiveContainer');
    var historyContainer = document.getElementById('anHistoryContainer');
    var activeGrid = document.getElementById('anActiveGrid');
    var activeEmpty = document.getElementById('anActiveEmpty');
    var histTableBody = document.getElementById('anHistoryTableBody');
    var histEmpty = document.getElementById('anHistoryEmpty');

    if (_currentTab === 'active') {
      if (activeContainer) activeContainer.style.display = '';
      if (historyContainer) historyContainer.style.display = 'none';

      if (currentList.length === 0) {
        if (activeGrid) activeGrid.innerHTML = '';
        if (activeEmpty) activeEmpty.style.display = 'block';
        return;
      }
      if (activeEmpty) activeEmpty.style.display = 'none';

      var cardsHtml = '';
      currentList.forEach(function (n, idx) {
        var midPoint = (Number(n.zone_lo) + Number(n.zone_hi)) / 2;
        var currentP = n.current_price != null ? Number(n.current_price) : midPoint;
        var toTpPct = formatPct(((n.target - midPoint) / midPoint) * 100);
        var toSlPct = formatPct(((n.risk_limit - midPoint) / midPoint) * 100);
        var riskSpan = midPoint - n.risk_limit;
        var rewardSpan = n.target - midPoint;
        var ratio = riskSpan > 0 ? (rewardSpan / riskSpan).toFixed(1).replace('.', ',') : '—';

        // Position bar calculation
        var minP = Math.min(n.risk_limit, currentP) * 0.98;
        var maxP = Math.max(n.target, currentP) * 1.02;
        var span = maxP - minP;
        var calcPct = function (p) { return Math.max(0, Math.min(100, Math.round(((p - minP) / span) * 100))); };

        var zLo = calcPct(n.zone_lo);
        var zHi = calcPct(n.zone_hi);
        var zW = Math.max(4, zHi - zLo);
        var slX = calcPct(n.risk_limit);
        var tpX = calcPct(n.target);
        var nowX = calcPct(currentP);
        var zaX = Math.round(zLo + zW / 2);

        // Edits disclosure
        var editsHtml = '';
        if (Array.isArray(n.edits) && n.edits.length > 0) {
          var editItems = n.edits.map(function (e) {
            return '<div class="an-li"><b>' + formatDateTime(e.edited_at) + '</b><span>' + escapeHtml(e.edit_reason) + '</span></div>';
          }).join('');
          editsHtml = '<details class="an-log"><summary><span class="chev">›</span>Diedit ' + n.edits.length + '× · lihat perubahan</summary><div class="an-logb">' + editItems + '</div></details>';
        }

        cardsHtml += '<article class="sheet an rise d' + Math.min(idx, 11) + '">';
        cardsHtml += '  <div class="an-h">';
        cardsHtml += '    <div>';
        cardsHtml += '      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">';
        cardsHtml += '        <span class="an-t mono font-bold text-lg">' + escapeHtml(n.ticker) + '</span>';
        cardsHtml += '        <span class="chip ' + (n.style === 'daytrade' ? 'o' : 'b') + '">' + (n.style === 'daytrade' ? 'DayTrade' : 'Swing') + '</span>';
        cardsHtml += '        <span class="oc ' + getStatusClass(n.status) + '">' + escapeHtml(n.status) + '</span>';
        cardsHtml += '      </div>';
        cardsHtml += '      <div class="an-m">Tayang ' + formatDateTime(n.published_at) + ' · berlaku ' + n.valid_days + ' hari bursa · oleh ' + escapeHtml(n.author_id || 'Admin') + '</div>';
        cardsHtml += '    </div>';
        cardsHtml += '  </div>';
        cardsHtml += '  <p class="an-why">' + escapeHtml(n.reason) + '</p>';
        cardsHtml += '  <div class="rb" role="img" aria-label="Area ' + formatRp(n.zone_lo) + '–' + formatRp(n.zone_hi) + ', target ' + formatRp(n.target) + ', batas ' + formatRp(n.risk_limit) + '">';
        cardsHtml += '    <div class="trk"></div>';
        cardsHtml += '    <div class="zone" style="left:' + zLo + '%;width:' + zW + '%"></div>';
        cardsHtml += '    <div class="tk-sl" style="left:' + slX + '%"></div>';
        cardsHtml += '    <div class="tk-tp" style="left:' + tpX + '%"></div>';
        cardsHtml += '    <div class="now" style="left:' + nowX + '%"></div>';
        cardsHtml += '    <div class="nowl" style="left:' + nowX + '%">Kini ' + formatRp(currentP) + '</div>';
        cardsHtml += '  </div>';
        cardsHtml += '  <div class="rb-l">';
        cardsHtml += '    <span class="mut">Batas ' + formatRp(n.risk_limit) + '</span>';
        cardsHtml += '    <span class="za" style="left:' + zaX + '%">Area ' + formatRp(n.zone_lo) + '–' + formatRp(n.zone_hi) + '</span>';
        cardsHtml += '    <span class="mut">Target ' + formatRp(n.target) + '</span>';
        cardsHtml += '  </div>';
        cardsHtml += '  <div class="an-n">';
        cardsHtml += '    <div><span class="lbl">Tengah area</span><b class="num">' + formatRp(midPoint) + '</b></div>';
        cardsHtml += '    <div><span class="lbl">Target</span><b class="num pos">' + formatRp(n.target) + ' (' + toTpPct + ')</b></div>';
        cardsHtml += '    <div><span class="lbl">Batas risiko</span><b class="num neg">' + formatRp(n.risk_limit) + ' (' + toSlPct + ')</b></div>';
        cardsHtml += '    <div><span class="lbl">Rasio</span><b class="num">1 : ' + ratio + '</b></div>';
        cardsHtml += '  </div>';
        cardsHtml += editsHtml;
        cardsHtml += '  <div class="an-f">';
        cardsHtml += '    <a class="btn sm" href="#analisis" onclick="openNoteInChart(\'' + escapeHtml(n.ticker) + '\', \'' + escapeHtml(n.id) + '\'); return false;">';
        cardsHtml += '      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3v18h18M7 15l4-5 3 3 5-7"/></svg>';
        cardsHtml += '      Lihat di chart';
        cardsHtml += '    </a>';
        cardsHtml += '    <span class="mut" style="font-size:12px">area, target, dan batas langsung tergambar</span>';
        if (isUserAdmin()) {
          cardsHtml += '    <button type="button" class="btn sm" style="margin-left:auto" onclick="openEditNoteDrawer(\'' + escapeHtml(n.id) + '\')">Edit</button>';
        }
        cardsHtml += '  </div>';
        cardsHtml += '</article>';
      });
      if (activeGrid) activeGrid.innerHTML = cardsHtml;
    } else {
      // History Tab
      if (activeContainer) activeContainer.style.display = 'none';
      if (historyContainer) historyContainer.style.display = '';

      if (currentList.length === 0) {
        if (histTableBody) histTableBody.innerHTML = '';
        if (histEmpty) histEmpty.style.display = 'block';
        return;
      }
      if (histEmpty) histEmpty.style.display = 'none';

      var rowsHtml = '';
      currentList.forEach(function (h, idx) {
        var resPctStr = h.result_pct != null ? formatPct(h.result_pct) : '—';
        var resPctClass = h.result_pct > 0 ? 'pos' : (h.result_pct < 0 ? 'neg' : 'mut');
        var durStr = h.valid_days ? (h.valid_days + ' hari') : '—';
        if (h.published_at && h.closed_at) {
          var diffMs = new Date(h.closed_at) - new Date(h.published_at);
          var days = Math.max(1, Math.round(diffMs / (24 * 3600 * 1000)));
          durStr = days + ' hari';
        }

        rowsHtml += '<tr class="rise d' + Math.min(idx, 11) + ' border-b border-dark-600/20">';
        rowsHtml += '  <td class="num mut">' + formatDate(h.published_at) + '</td>';
        rowsHtml += '  <td><span class="tk mono font-semibold">' + escapeHtml(h.ticker) + '</span></td>';
        rowsHtml += '  <td><span class="chip ' + (h.style === 'daytrade' ? 'o' : 'b') + '">' + (h.style === 'daytrade' ? 'DayTrade' : 'Swing') + '</span></td>';
        rowsHtml += '  <td><span class="oc ' + getStatusClass(h.status) + '">' + escapeHtml(h.status) + '</span></td>';
        rowsHtml += '  <td class="r num ' + resPctClass + '" style="font-weight:600">' + resPctStr + '</td>';
        rowsHtml += '  <td class="num mut">' + durStr + '</td>';
        rowsHtml += '  <td class="mut" style="white-space:normal;max-width:340px">' + escapeHtml(h.close_reason || h.reason || '—') + '</td>';
        rowsHtml += '</tr>';
      });
      if (histTableBody) histTableBody.innerHTML = rowsHtml;
    }
  }

  function switchAdminNoteTab(tab) {
    _currentTab = tab;
    var btnAct = document.getElementById('anTabBtnActive');
    var btnHist = document.getElementById('anTabBtnHistory');
    var ind = document.getElementById('anTabInd');

    if (tab === 'active') {
      if (btnAct) { btnAct.classList.add('is-active', 'on'); btnAct.setAttribute('aria-pressed', 'true'); }
      if (btnHist) { btnHist.classList.remove('is-active', 'on'); btnHist.setAttribute('aria-pressed', 'false'); }
      if (ind) ind.className = 'ind k0';
    } else {
      if (btnAct) { btnAct.classList.remove('is-active', 'on'); btnAct.setAttribute('aria-pressed', 'false'); }
      if (btnHist) { btnHist.classList.add('is-active', 'on'); btnHist.setAttribute('aria-pressed', 'true'); }
      if (ind) ind.className = 'ind k1';
    }
    renderCatatanAdminView();
  }

  function filterAdminNotesStyle(style) {
    _currentStyle = style;
    ['anChipAll', 'anChipDaytrade', 'anChipSwing'].forEach(function (id) {
      var chip = document.getElementById(id);
      if (chip) chip.classList.remove('on');
    });
    if (style === 'daytrade') {
      var c = document.getElementById('anChipDaytrade');
      if (c) c.classList.add('on');
    } else if (style === 'swing') {
      var c = document.getElementById('anChipSwing');
      if (c) c.classList.add('on');
    } else {
      var c = document.getElementById('anChipAll');
      if (c) c.classList.add('on');
    }
    renderCatatanAdminView();
  }

  // Admin Drawer handling
  function openNewAdminNoteDrawer() {
    _drawerMode = 'new';
    _editingNoteId = null;
    var drawer = document.getElementById('adminNoteDrawer');
    var backdrop = document.getElementById('adminNoteDrawerBackdrop');
    var titleEl = document.getElementById('anDrawerTitle');
    var subEl = document.getElementById('anDrawerSub');
    var editWrap = document.getElementById('anEditReasonWrap');
    var btnClose = document.getElementById('anDrawerBtnCloseNote');
    var btnSave = document.getElementById('anDrawerBtnSave');
    var tInp = document.getElementById('anTickerInput');

    if (tInp) { tInp.disabled = false; tInp.value = ''; }
    if (titleEl) titleEl.textContent = 'Catatan baru';
    if (subEl) subEl.textContent = 'Tayang ke semua pengunjung';
    if (editWrap) editWrap.style.display = 'none';
    if (btnClose) btnClose.style.display = 'none';
    if (btnSave) btnSave.textContent = 'Tayangkan catatan';

    // Clear form inputs
    ['anReasonInput', 'anZoneLoInput', 'anZoneHiInput', 'anTargetInput', 'anRiskLimitInput', 'anEditReasonInput'].forEach(function (id) {
      var el = document.getElementById(id);
      if (el) el.value = '';
    });
    setAdminNoteDrawerStyle('daytrade');
    updateAdminNoteDrawerCalc();

    if (backdrop) backdrop.style.display = 'block';
    if (drawer) drawer.style.display = 'flex';
  }

  function openEditNoteDrawer(noteId) {
    if (!_catatanAdminCache || !Array.isArray(_catatanAdminCache.notes)) return;
    var note = _catatanAdminCache.notes.find(n => n.id === noteId);
    if (!note) return;

    _drawerMode = 'edit';
    _editingNoteId = noteId;

    var drawer = document.getElementById('adminNoteDrawer');
    var backdrop = document.getElementById('adminNoteDrawerBackdrop');
    var titleEl = document.getElementById('anDrawerTitle');
    var subEl = document.getElementById('anDrawerSub');
    var editWrap = document.getElementById('anEditReasonWrap');
    var btnClose = document.getElementById('anDrawerBtnCloseNote');
    var btnSave = document.getElementById('anDrawerBtnSave');
    var tInp = document.getElementById('anTickerInput');

    if (tInp) { tInp.value = note.ticker; tInp.disabled = true; }
    if (titleEl) titleEl.textContent = 'Edit catatan · ' + note.ticker;
    if (subEl) subEl.textContent = 'Perubahan dicatat di riwayat edit';
    if (editWrap) editWrap.style.display = 'block';
    if (btnClose) btnClose.style.display = '';
    if (btnSave) btnSave.textContent = 'Simpan perubahan';

    var rInp = document.getElementById('anReasonInput');
    var loInp = document.getElementById('anZoneLoInput');
    var hiInp = document.getElementById('anZoneHiInput');
    var tpInp = document.getElementById('anTargetInput');
    var slInp = document.getElementById('anRiskLimitInput');
    var dSel = document.getElementById('anValidDaysSelect');

    if (rInp) rInp.value = note.reason || '';
    if (loInp) loInp.value = note.zone_lo || '';
    if (hiInp) hiInp.value = note.zone_hi || '';
    if (tpInp) tpInp.value = note.target || '';
    if (slInp) slInp.value = note.risk_limit || '';
    if (dSel) dSel.value = String(note.valid_days || 2);

    setAdminNoteDrawerStyle(note.style || 'daytrade');
    updateAdminNoteDrawerCalc();

    if (backdrop) backdrop.style.display = 'block';
    if (drawer) drawer.style.display = 'flex';
  }

  function closeAdminNoteDrawer() {
    var drawer = document.getElementById('adminNoteDrawer');
    var backdrop = document.getElementById('adminNoteDrawerBackdrop');
    if (drawer) drawer.style.display = 'none';
    if (backdrop) backdrop.style.display = 'none';
  }

  var _drawerStyle = 'daytrade';
  function setAdminNoteDrawerStyle(style) {
    _drawerStyle = style;
    var btnDt = document.getElementById('anDrawerStyleDaytrade');
    var btnSw = document.getElementById('anDrawerStyleSwing');
    var daySelect = document.getElementById('anValidDaysSelect');

    if (style === 'daytrade') {
      if (btnDt) btnDt.classList.add('on');
      if (btnSw) btnSw.classList.remove('on');
      if (daySelect && !['1', '2', '3'].includes(daySelect.value)) daySelect.value = '2';
    } else {
      if (btnDt) btnDt.classList.remove('on');
      if (btnSw) btnSw.classList.add('on');
      if (daySelect && !['3', '5', '10', '20'].includes(daySelect.value)) daySelect.value = '5';
    }
    updateAdminNoteDrawerCalc();
  }

  function getTickSize(p) {
    if (p < 200) return 1;
    if (p < 500) return 2;
    if (p < 2000) return 5;
    if (p < 5000) return 10;
    return 25;
  }

  function validateTick(val) {
    var p = Number(val);
    if (!Number.isFinite(p) || p <= 0) return false;
    var step = getTickSize(p);
    return p % step === 0;
  }

  var FORBIDDEN_WORDS = ['pasti', 'dijamin', 'jaminan', 'wajib beli', 'harus beli', 'tanpa risiko', 'anti rugi', '100%', 'all in', 'hajar'];

  function updateAdminNoteDrawerCalc() {
    var ticker = (document.getElementById('anTickerInput') && document.getElementById('anTickerInput').value.trim().toUpperCase()) || '';
    var reason = (document.getElementById('anReasonInput') && document.getElementById('anReasonInput').value.trim()) || '';
    var lo = Number(document.getElementById('anZoneLoInput') && document.getElementById('anZoneLoInput').value);
    var hi = Number(document.getElementById('anZoneHiInput') && document.getElementById('anZoneHiInput').value);
    var tp = Number(document.getElementById('anTargetInput') && document.getElementById('anTargetInput').value);
    var sl = Number(document.getElementById('anRiskLimitInput') && document.getElementById('anRiskLimitInput').value);
    var editReason = (document.getElementById('anEditReasonInput') && document.getElementById('anEditReasonInput').value.trim()) || '';

    // Counter
    var counterEl = document.getElementById('anCharCounter');
    if (counterEl) counterEl.textContent = reason.length + '/280';

    // Forbidden check
    var warnEl = document.getElementById('anForbiddenWarning');
    var hasForbidden = false;
    var forbiddenWord = '';
    var rLower = reason.toLowerCase();
    for (var i = 0; i < FORBIDDEN_WORDS.length; i++) {
      if (rLower.includes(FORBIDDEN_WORDS[i])) {
        hasForbidden = true;
        forbiddenWord = FORBIDDEN_WORDS[i];
        break;
      }
    }
    if (warnEl) {
      warnEl.textContent = hasForbidden ? 'Ditolak: kata "' + forbiddenWord + '" tidak boleh digunakan.' : '';
    }

    var msgEl = document.getElementById('anDrawerValidationMsg');
    var btnSave = document.getElementById('anDrawerBtnSave');
    var isValid = true;
    var errorMsg = '';

    if (!/^[A-Z]{4}$/.test(ticker)) {
      isValid = false;
      errorMsg = 'Kode saham harus 4 huruf IDX.';
    } else if (reason.length < 20 || reason.length > 280) {
      isValid = false;
      errorMsg = 'Alasan minimal 20 karakter (' + reason.length + '/20).';
    } else if (hasForbidden) {
      isValid = false;
      errorMsg = 'Hapus kata janji hasil sebelum menyimpan.';
    } else if (!validateTick(lo)) {
      isValid = false;
      errorMsg = 'Zone low tidak sesuai fraksi harga BEI.';
    } else if (!validateTick(hi)) {
      isValid = false;
      errorMsg = 'Zone high tidak sesuai fraksi harga BEI.';
    } else if (!validateTick(tp)) {
      isValid = false;
      errorMsg = 'Target tidak sesuai fraksi harga BEI.';
    } else if (!validateTick(sl)) {
      isValid = false;
      errorMsg = 'Batas risiko tidak sesuai fraksi harga BEI.';
    } else if (lo > hi) {
      isValid = false;
      errorMsg = 'Zone low tidak boleh melebihi zone high.';
    } else if (tp <= hi) {
      isValid = false;
      errorMsg = 'Target harus di atas area pantau (' + hi + ').';
    } else if (sl >= lo) {
      isValid = false;
      errorMsg = 'Batas risiko harus di bawah area pantau (' + lo + ').';
    } else if (_drawerMode === 'edit' && editReason.length < 10) {
      isValid = false;
      errorMsg = 'Alasan perubahan minimal 10 karakter.';
    }

    if (msgEl) msgEl.textContent = errorMsg;
    if (btnSave) btnSave.disabled = !isValid;

    // Update Preview Box
    if (lo > 0 && hi >= lo && tp > hi && sl < lo) {
      var mid = (lo + hi) / 2;
      var cur = mid;
      var toTp = ((tp - mid) / mid) * 100;
      var toSl = ((sl - mid) / mid) * 100;
      var rSpan = mid - sl;
      var rewSpan = tp - mid;
      var ratioVal = rSpan > 0 ? (rewSpan / rSpan).toFixed(1).replace('.', ',') : '—';

      var minP = sl * 0.98;
      var maxP = tp * 1.02;
      var span = maxP - minP;
      var getP = function (p) { return Math.max(0, Math.min(100, Math.round(((p - minP) / span) * 100))); };

      var zLo = getP(lo);
      var zHi = getP(hi);
      var zW = Math.max(4, zHi - zLo);

      var pZone = document.getElementById('anPrevZone');
      var pSl = document.getElementById('anPrevSl');
      var pTp = document.getElementById('anPrevTp');
      var pNow = document.getElementById('anPrevNow');
      var pNowL = document.getElementById('anPrevNowL');
      var pToTp = document.getElementById('anPrevToTp');
      var pToSl = document.getElementById('anPrevToSl');
      var pRatio = document.getElementById('anPrevRatio');
      var pStatus = document.getElementById('anPrevInitialStatus');

      if (pZone) { pZone.style.left = zLo + '%'; pZone.style.width = zW + '%'; }
      if (pSl) pSl.style.left = getP(sl) + '%';
      if (pTp) pTp.style.left = getP(tp) + '%';
      if (pNow) pNow.style.left = getP(cur) + '%';
      if (pNowL) { pNowL.style.left = getP(cur) + '%'; pNowL.textContent = 'Kini ' + formatRp(cur); }
      if (pToTp) pToTp.textContent = formatPct(toTp);
      if (pToSl) pToSl.textContent = formatPct(toSl);
      if (pRatio) pRatio.textContent = '1 : ' + ratioVal;
      if (pStatus) pStatus.textContent = 'Status awal: Di area pantau';
    }
  }

  async function submitAdminNote() {
    var ticker = document.getElementById('anTickerInput').value.trim().toUpperCase();
    var style = _drawerStyle;
    var reason = document.getElementById('anReasonInput').value.trim();
    var lo = Number(document.getElementById('anZoneLoInput').value);
    var hi = Number(document.getElementById('anZoneHiInput').value);
    var tp = Number(document.getElementById('anTargetInput').value);
    var sl = Number(document.getElementById('anRiskLimitInput').value);
    var validDays = Number(document.getElementById('anValidDaysSelect').value);
    var editReason = document.getElementById('anEditReasonInput') ? document.getElementById('anEditReasonInput').value.trim() : '';

    var payload = {
      ticker: ticker,
      style: style,
      reason: reason,
      zone_lo: lo,
      zone_hi: hi,
      target: tp,
      risk_limit: sl,
      valid_days: validDays
    };

    var btnSave = document.getElementById('anDrawerBtnSave');
    if (btnSave) { btnSave.disabled = true; btnSave.textContent = 'Menyimpan...'; }

    try {
      var res, json;
      if (_drawerMode === 'edit') {
        payload.id = _editingNoteId;
        payload.edit_reason = editReason;
        res = await fetch('/api/admin-notes', {
          method: 'PATCH',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      } else {
        res = await fetch('/api/admin-notes', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify(payload)
        });
      }
      json = await res.json();
      if (!json.success) {
        alert(json.error || 'Gagal menyimpan catatan.');
        if (btnSave) { btnSave.disabled = false; btnSave.textContent = 'Simpan'; }
        return;
      }
      closeAdminNoteDrawer();
      await loadCatatanAdmin();
      if (typeof showToast === 'function') showToast('Catatan admin berhasil disimpan!', 'success');
    } catch (e) {
      alert('Terjadi kesalahan jaringan.');
      if (btnSave) { btnSave.disabled = false; btnSave.textContent = 'Simpan'; }
    }
  }

  async function submitCloseAdminNote() {
    if (!_editingNoteId) return;
    var editReason = document.getElementById('anEditReasonInput') ? document.getElementById('anEditReasonInput').value.trim() : '';
    if (editReason.length < 10) {
      alert('Wajib mengisi alasan penutupan catatan di kolom "Alasan perubahan" (minimal 10 karakter).');
      return;
    }

    if (!confirm('Pindahkan catatan ini ke riwayat dengan status "Ditutup admin"?')) return;

    try {
      var res = await fetch('/api/admin-notes', {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          id: _editingNoteId,
          action: 'close',
          status: 'Ditutup admin',
          edit_reason: editReason
        })
      });
      var json = await res.json();
      if (!json.success) {
        alert(json.error || 'Gagal menutup catatan.');
        return;
      }
      closeAdminNoteDrawer();
      await loadCatatanAdmin();
      if (typeof showToast === 'function') showToast('Catatan admin telah ditutup.', 'info');
    } catch (_) {
      alert('Terjadi kesalahan jaringan.');
    }
  }

  function onAdminNoteTickerInput() {
    var tInp = document.getElementById('anTickerInput');
    if (!tInp) return;
    tInp.value = tInp.value.toUpperCase();
    var hint = document.getElementById('anTickerName');
    if (hint) {
      var master = {
        'BBCA': 'Bank Central Asia Tbk',
        'BBRI': 'Bank Rakyat Indonesia Tbk',
        'BMRI': 'Bank Mandiri Tbk',
        'BREN': 'Barito Renewables Energy Tbk',
        'BRPT': 'Barito Pacific Tbk',
        'PTRO': 'Petrosea Tbk',
        'CUAN': 'Petrindo Jaya Kreasi Tbk',
        'MEDC': 'Medco Energi Internasional Tbk',
        'ADRO': 'Adaro Energy Indonesia Tbk',
        'TLKM': 'Telkom Indonesia Tbk'
      };
      hint.textContent = master[tInp.value] || 'Emiten IDX';
    }
    updateAdminNoteDrawerCalc();
  }

  // Dashboard section loader (§5d: max 3 active notes)
  async function loadDashboardCatatanAdmin() {
    var section = document.getElementById('adminNotesDashboardSection');
    var list = document.getElementById('dashAdminNotesList');
    if (!section || !list) return;

    try {
      var res = await fetch('/api/admin-notes?status=active');
      var data = await res.json();
      if (!data.success || !Array.isArray(data.notes) || data.notes.length === 0) {
        section.style.display = 'none';
        return;
      }

      var activeStatuses = ['Di area pantau', 'Menunggu harga turun ke area', 'Di bawah area pantau'];
      var activeNotes = data.notes.filter(n => activeStatuses.includes(n.status));
      if (activeNotes.length === 0) {
        section.style.display = 'none';
        return;
      }

      var maxNotes = window.innerWidth <= 640 ? 2 : 3;
      var topNotes = activeNotes.slice(0, maxNotes);
      var cardsHtml = '';

      topNotes.forEach(function (n, idx) {
        var midPoint = (Number(n.zone_lo) + Number(n.zone_hi)) / 2;
        var currentP = n.current_price != null ? Number(n.current_price) : midPoint;
        var toTpPct = formatPct(((n.target - midPoint) / midPoint) * 100);
        var toSlPct = formatPct(((n.risk_limit - midPoint) / midPoint) * 100);
        var rSpan = midPoint - n.risk_limit;
        var rewSpan = n.target - midPoint;
        var ratio = rSpan > 0 ? (rewSpan / rSpan).toFixed(1).replace('.', ',') : '—';

        var minP = Math.min(n.risk_limit, currentP) * 0.98;
        var maxP = Math.max(n.target, currentP) * 1.02;
        var span = maxP - minP;
        var calcPct = function (p) { return Math.max(0, Math.min(100, Math.round(((p - minP) / span) * 100))); };

        var zLo = calcPct(n.zone_lo);
        var zHi = calcPct(n.zone_hi);
        var zW = Math.max(4, zHi - zLo);
        var slX = calcPct(n.risk_limit);
        var tpX = calcPct(n.target);
        var nowX = calcPct(currentP);

        cardsHtml += '<div class="sheet an rise d' + Math.min(idx, 11) + '" style="margin:0">';
        cardsHtml += '  <div class="an-h">';
        cardsHtml += '    <div>';
        cardsHtml += '      <div style="display:flex;align-items:center;gap:8px;flex-wrap:wrap">';
        cardsHtml += '        <span class="an-t mono font-bold text-base">' + escapeHtml(n.ticker) + '</span>';
        cardsHtml += '        <span class="chip ' + (n.style === 'daytrade' ? 'o' : 'b') + '">' + (n.style === 'daytrade' ? 'DayTrade' : 'Swing') + '</span>';
        cardsHtml += '        <span class="oc ' + getStatusClass(n.status) + '">' + escapeHtml(n.status) + '</span>';
        cardsHtml += '      </div>';
        cardsHtml += '      <div class="an-m" style="font-size:11px">Berlaku ' + n.valid_days + ' hari bursa</div>';
        cardsHtml += '    </div>';
        cardsHtml += '  </div>';
        cardsHtml += '  <p class="an-why" style="font-size:13px;margin:8px 0">' + escapeHtml(n.reason) + '</p>';
        cardsHtml += '  <div class="rb" role="img" aria-label="Area ' + formatRp(n.zone_lo) + '–' + formatRp(n.zone_hi) + '">';
        cardsHtml += '    <div class="trk"></div>';
        cardsHtml += '    <div class="zone" style="left:' + zLo + '%;width:' + zW + '%"></div>';
        cardsHtml += '    <div class="tk-sl" style="left:' + slX + '%"></div>';
        cardsHtml += '    <div class="tk-tp" style="left:' + tpX + '%"></div>';
        cardsHtml += '    <div class="now" style="left:' + nowX + '%"></div>';
        cardsHtml += '  </div>';
        cardsHtml += '  <div class="an-n" style="padding:10px 0 8px;margin-top:8px">';
        cardsHtml += '    <div><span class="lbl">Area</span><b class="num text-xs">' + formatRp(n.zone_lo) + '–' + formatRp(n.zone_hi) + '</b></div>';
        cardsHtml += '    <div><span class="lbl">Target</span><b class="num pos text-xs">' + formatRp(n.target) + ' (' + toTpPct + ')</b></div>';
        cardsHtml += '    <div><span class="lbl">Batas</span><b class="num neg text-xs">' + formatRp(n.risk_limit) + ' (' + toSlPct + ')</b></div>';
        cardsHtml += '    <div><span class="lbl">Rasio</span><b class="num text-xs">1 : ' + ratio + '</b></div>';
        cardsHtml += '  </div>';
        cardsHtml += '  <div class="an-f" style="padding:8px 0 10px">';
        cardsHtml += '    <button type="button" class="btn sm" onclick="openNoteInChart(\'' + escapeHtml(n.ticker) + '\', \'' + escapeHtml(n.id) + '\')">';
        cardsHtml += '      <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3v18h18M7 15l4-5 3 3 5-7"/></svg>';
        cardsHtml += '      Chart';
        cardsHtml += '    </button>';
        cardsHtml += '  </div>';
        cardsHtml += '</div>';
      });

      list.innerHTML = cardsHtml;
      section.style.display = 'block';
    } catch (_) {
      section.style.display = 'none';
    }
  }

  // Chart Workstation Integration (§5d)
  function clearCatatanAdminPriceLines() {
    if (Array.isArray(_catatanPriceLines)) {
      _catatanPriceLines.forEach(function (line) {
        try {
          if (line && typeof line.remove === 'function') line.remove();
        } catch (_) {}
      });
    }
    _catatanPriceLines = [];
  }

  async function openNoteInChart(ticker, noteId) {
    if (typeof navigateTo === 'function') {
      navigateTo('analisis', 'chart', { ticker: ticker });
    }

    var note = null;
    if (_catatanAdminCache && Array.isArray(_catatanAdminCache.notes)) {
      note = _catatanAdminCache.notes.find(n => n.id === noteId || n.ticker === ticker);
    }
    if (!note) {
      try {
        var res = await fetch('/api/admin-notes?id=' + encodeURIComponent(noteId));
        var json = await res.json();
        if (json.success && json.note) note = json.note;
      } catch (_) {}
    }
    if (note) {
      setTimeout(function () {
        renderCatatanAdminOnChart(note);
      }, 250);
    }
  }

  function renderCatatanAdminOnChart(note) {
    _activeNoteOnChart = note;
    var banner = document.getElementById('catatanAdminChartBanner');
    var bStyle = document.getElementById('caBannerStyle');
    var bStatus = document.getElementById('caBannerStatus');
    var bLevels = document.getElementById('caBannerLevels');
    var bReason = document.getElementById('caBannerReason');
    var toggleBtn = document.getElementById('caBannerToggleLinesBtn');

    if (banner) {
      if (bStyle) bStyle.textContent = 'Catatan Admin · ' + (note.style || 'SWING').toUpperCase();
      if (bStatus) {
        bStatus.textContent = note.status || 'Di area pantau';
        bStatus.className = 'oc ' + getStatusClass(note.status);
      }
      if (bLevels) {
        bLevels.textContent = 'Area: ' + formatRp(note.zone_lo) + '–' + formatRp(note.zone_hi) + ' · TP: ' + formatRp(note.target) + ' · SL: ' + formatRp(note.risk_limit);
      }
      if (bReason) bReason.textContent = note.reason || '';
      if (toggleBtn) toggleBtn.textContent = 'Sembunyikan dari chart';
      banner.style.display = 'flex';
    }

    // Hide system plan sheet to prevent double plans
    var sysPlan = document.getElementById('anaPlanSheet');
    if (sysPlan) sysPlan.style.display = 'none';

    drawCatatanAdminPriceLines(note);

    // Smooth scroll to chart
    var prefersReduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches;
    var chartContainer = document.getElementById('panel-tab-chart') || document.getElementById('unifiedChartContainer');
    if (chartContainer) {
      chartContainer.scrollIntoView({ behavior: prefersReduced ? 'auto' : 'smooth', block: 'start' });
    }
  }

  function drawCatatanAdminPriceLines(note) {
    clearCatatanAdminPriceLines();
    if (!note) return;

    var series = window._unifiedCandleSeries || (window.UnifiedCockpit && typeof window.UnifiedCockpit.getCandleSeries === 'function' && window.UnifiedCockpit.getCandleSeries());
    if (series && typeof series.createPriceLine === 'function') {
      try {
        _catatanPriceLines.push(series.createPriceLine({
          price: Number(note.target),
          color: '#10b981',
          lineWidth: 2,
          lineStyle: 0,
          axisLabelVisible: true,
          title: 'Target ' + formatRp(note.target)
        }));
        _catatanPriceLines.push(series.createPriceLine({
          price: Number(note.risk_limit),
          color: '#ef4444',
          lineWidth: 2,
          lineStyle: 0,
          axisLabelVisible: true,
          title: 'Batas ' + formatRp(note.risk_limit)
        }));
        _catatanPriceLines.push(series.createPriceLine({
          price: Number(note.zone_hi),
          color: '#34d399',
          lineWidth: 1.5,
          lineStyle: 2,
          axisLabelVisible: true,
          title: 'Area atas ' + formatRp(note.zone_hi)
        }));
        _catatanPriceLines.push(series.createPriceLine({
          price: Number(note.zone_lo),
          color: '#34d399',
          lineWidth: 1.5,
          lineStyle: 2,
          axisLabelVisible: true,
          title: 'Area bawah ' + formatRp(note.zone_lo)
        }));
      } catch (_) {}
    }
  }

  function toggleCatatanAdminPriceLines() {
    var toggleBtn = document.getElementById('caBannerToggleLinesBtn');
    if (_catatanPriceLines.length > 0) {
      clearCatatanAdminPriceLines();
      if (toggleBtn) toggleBtn.textContent = 'Tampilkan di chart';
      // Restore system plan
      var sysPlan = document.getElementById('anaPlanSheet');
      if (sysPlan) sysPlan.style.display = '';
    } else if (_activeNoteOnChart) {
      drawCatatanAdminPriceLines(_activeNoteOnChart);
      if (toggleBtn) toggleBtn.textContent = 'Sembunyikan dari chart';
      var sysPlan = document.getElementById('anaPlanSheet');
      if (sysPlan) sysPlan.style.display = 'none';
    }
  }

  // Exports to window
  window.loadCatatanAdmin = loadCatatanAdmin;
  window.switchAdminNoteTab = switchAdminNoteTab;
  window.filterAdminNotesStyle = filterAdminNotesStyle;
  window.openNewAdminNoteDrawer = openNewAdminNoteDrawer;
  window.openEditNoteDrawer = openEditNoteDrawer;
  window.closeAdminNoteDrawer = closeAdminNoteDrawer;
  window.setAdminNoteDrawerStyle = setAdminNoteDrawerStyle;
  window.updateAdminNoteDrawerCalc = updateAdminNoteDrawerCalc;
  window.submitAdminNote = submitAdminNote;
  window.submitCloseAdminNote = submitCloseAdminNote;
  window.onAdminNoteTickerInput = onAdminNoteTickerInput;
  window.loadDashboardCatatanAdmin = loadDashboardCatatanAdmin;
  window.openNoteInChart = openNoteInChart;
  window.toggleCatatanAdminPriceLines = toggleCatatanAdminPriceLines;
  window.renderCatatanAdminOnChart = renderCatatanAdminOnChart;
})();
