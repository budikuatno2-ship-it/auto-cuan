/**
 * Auto-Cuan All-in-One Money Management Runtime
 * 1. Sub-tab Arus Kas Pribadi (Life Cashflow & Budgeting)
 * 2. Sub-tab Jurnal Portofolio Trading (Spreadsheet Interaktif, Win Rate, RDL)
 * Terisolasi per User ID & 100% confidential.
 */
(function(window) {
  'use strict';

  var currentSubTab = 'cashflow'; // 'cashflow' | 'journal'
  var cashflowData = {
    month: new Date().toISOString().slice(0, 7),
    income_salary: 0,
    income_side: 0,
    income_other: 0,
    expense_necessities: 0,
    expense_wants: 0,
    savings_emergency: 0,
    trading_capital_allocation: 0,
    notes: ''
  };
  var journalData = [];

  function formatRp(val) {
    if (val == null || !Number.isFinite(Number(val))) return 'Rp 0';
    return 'Rp ' + Number(val).toLocaleString('id-ID');
  }

  function getNumericValue(id) {
    var el = document.getElementById(id);
    if (!el) return 0;
    var num = parseFloat(String(el.value).replace(/[^0-9.-]+/g, ''));
    return Number.isFinite(num) ? num : 0;
  }

  function setFieldValue(id, val) {
    var el = document.getElementById(id);
    if (el) el.value = (val == null || val === 0) ? '' : val;
  }

  window.switchMoneySubTab = function(tab) {
    currentSubTab = tab;
    var btnCf = document.getElementById('mmTabBtnCashflow');
    var btnJr = document.getElementById('mmTabBtnJournal');
    var panelCf = document.getElementById('mmPanelCashflow');
    var panelJr = document.getElementById('mmPanelJournal');

    if (btnCf && btnJr) {
      if (tab === 'cashflow') {
        btnCf.className = 'ac-segment is-active';
        btnJr.className = 'ac-segment';
        if (panelCf) panelCf.classList.remove('hidden');
        if (panelJr) panelJr.classList.add('hidden');
      } else {
        btnCf.className = 'ac-segment';
        btnJr.className = 'ac-segment is-active';
        if (panelCf) panelCf.classList.add('hidden');
        if (panelJr) panelJr.classList.remove('hidden');
        renderJournalTable();
      }
    }
  };

  // Recalculates cashflow balance and safe non-trading spending limits
  window.recalculateCashflow = function() {
    var salary = getNumericValue('mmIncomeSalary');
    var side = getNumericValue('mmIncomeSide');
    var other = getNumericValue('mmIncomeOther');
    var totalIncome = salary + side + other;

    var necessities = getNumericValue('mmExpNecessities');
    var wants = getNumericValue('mmExpWants');
    var savings = getNumericValue('mmSavings');
    var tradingCap = getNumericValue('mmTradingCapital');

    var totalLivingExpense = necessities + wants + savings;
    var remainingNonTrading = totalIncome - totalLivingExpense - tradingCap;

    var totalIncomeEl = document.getElementById('mmTotalIncomeDisplay');
    var totalExpenseEl = document.getElementById('mmTotalLivingExpenseDisplay');
    var tradingCapitalEl = document.getElementById('mmTradingCapDisplay');
    var remainingEl = document.getElementById('mmRemainingBudgetDisplay');
    var statusEl = document.getElementById('mmBudgetSafetyStatus');

    if (totalIncomeEl) totalIncomeEl.textContent = formatRp(totalIncome);
    if (totalExpenseEl) totalExpenseEl.textContent = formatRp(totalLivingExpense);
    if (tradingCapitalEl) tradingCapitalEl.textContent = formatRp(tradingCap);
    if (remainingEl) {
      remainingEl.textContent = formatRp(remainingNonTrading);
      remainingEl.className = remainingNonTrading >= 0 ? 'text-lg font-bold text-emerald-400' : 'text-lg font-bold text-rose-400';
    }

    if (statusEl) {
      if (totalIncome === 0) {
        statusEl.innerHTML = '<span class="text-gray-400">💡 Masukkan pemasukan bulanan Anda untuk menghitung alokasi hidup aman dan modal trading.</span>';
      } else if (remainingNonTrading < 0) {
        statusEl.innerHTML = '<span class="text-rose-400 font-semibold">⚠️ Peringatan: Total pengeluaran + modal trading melebihi pemasukan bulanan! Kurangi pos modal trading atau pengeluaran gaya hidup.</span>';
      } else {
        var pctTrading = totalIncome > 0 ? ((tradingCap / totalIncome) * 100).toFixed(1) : 0;
        statusEl.innerHTML = '<span class="text-emerald-400 font-semibold">✅ Anggaran Aman: ' + pctTrading + '% pemasukan dialokasikan sebagai dana dingin bursa. Sisa kas kebutuhan hidup di luar trading aman terjaga.</span>';
      }
    }

    // Auto-update Trading Journal initial capital reference
    var jrCapRef = document.getElementById('mmJrTradingCapRef');
    if (jrCapRef) jrCapRef.textContent = formatRp(tradingCap);
    updateJournalSummaryTiles();
  };

  window.saveCashflowData = async function() {
    var saveBtn = document.getElementById('mmSaveCashflowBtn');
    if (saveBtn) { saveBtn.disabled = true; saveBtn.textContent = 'Menyimpan...'; }

    var payload = {
      action: 'save-cashflow',
      month: cashflowData.month || new Date().toISOString().slice(0, 7),
      income_salary: getNumericValue('mmIncomeSalary'),
      income_side: getNumericValue('mmIncomeSide'),
      income_other: getNumericValue('mmIncomeOther'),
      expense_necessities: getNumericValue('mmExpNecessities'),
      expense_wants: getNumericValue('mmExpWants'),
      savings_emergency: getNumericValue('mmSavings'),
      trading_capital_allocation: getNumericValue('mmTradingCapital'),
      notes: (document.getElementById('mmCashflowNotes') && document.getElementById('mmCashflowNotes').value) || ''
    };

    try {
      localStorage.setItem('autocuan_cashflow_cache', JSON.stringify(payload));
      var res = await fetch('/api/money-management', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      var json = await res.json();
      if (json && json.success) {
        if (typeof showToast === 'function') showToast('Arus kas bulanan berhasil disimpan!', 'success');
      }
    } catch (e) {
      if (typeof showToast === 'function') showToast('Tersimpan di cache lokal.', 'info');
    } finally {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Simpan Anggaran'; }
    }
  };

  window.loadCashflowData = async function() {
    var nowWib = new Date(Date.now() + 7 * 60 * 60 * 1000);
    var month = nowWib.toISOString().slice(0, 7);

    try {
      var res = await fetch('/api/money-management?action=get-cashflow&month=' + month);
      var json = await res.json();
      if (json && json.success && json.data) {
        cashflowData = json.data;
      } else {
        var local = localStorage.getItem('autocuan_cashflow_cache');
        if (local) cashflowData = JSON.parse(local);
      }
    } catch (_) {
      var local2 = localStorage.getItem('autocuan_cashflow_cache');
      if (local2) cashflowData = JSON.parse(local2);
    }

    setFieldValue('mmIncomeSalary', cashflowData.income_salary);
    setFieldValue('mmIncomeSide', cashflowData.income_side);
    setFieldValue('mmIncomeOther', cashflowData.income_other);
    setFieldValue('mmExpNecessities', cashflowData.expense_necessities);
    setFieldValue('mmExpWants', cashflowData.expense_wants);
    setFieldValue('mmSavings', cashflowData.savings_emergency);
    setFieldValue('mmTradingCapital', cashflowData.trading_capital_allocation);
    var notesEl = document.getElementById('mmCashflowNotes');
    if (notesEl) notesEl.value = cashflowData.notes || '';

    recalculateCashflow();
  };

  // ----------------------------------------------------
  // TRADING JOURNAL
  // ----------------------------------------------------
  function renderJournalTable() {
    var tbody = document.getElementById('mmJournalTableBody');
    if (!tbody) return;

    if (!journalData || journalData.length === 0) {
      tbody.innerHTML = '<tr><td colspan="10" class="text-center py-8 text-gray-500 text-xs">Belum ada transaksi di jurnal. Masukkan transaksi pertama Anda di atas.</td></tr>';
      updateJournalSummaryTiles();
      return;
    }

    var html = '';
    journalData.forEach(function(item, idx) {
      var plRp = Number(item.realized_pl_rp || 0);
      var plPct = Number(item.realized_pl_pct || 0);
      var isClosed = item.status === 'CLOSED' || (item.exit_price != null && item.exit_price > 0);
      var plClass = plRp > 0 ? 'text-emerald-400 font-bold' : (plRp < 0 ? 'text-rose-400 font-bold' : 'text-gray-400');
      var statusBadge = isClosed ? '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-dark-600 text-gray-300">CLOSED</span>' : '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/20 text-emerald-300">OPEN</span>';

      html += '<tr class="hover:bg-dark-700/40 border-b border-dark-700/50 transition">';
      html += '  <td class="px-3 py-2.5 font-mono text-gray-400 text-center">' + (item.trade_date || '—') + '</td>';
      html += '  <td class="px-3 py-2.5 font-bold text-white tracking-wide cursor-pointer hover:text-emerald-400" onclick="window.location.assign(\'/analisis-saham?ticker=' + item.ticker + '\')">' + item.ticker + '</td>';
      html += '  <td class="px-3 py-2.5 text-center"><span class="px-1.5 py-0.5 rounded text-[10px] font-bold ' + (item.position_type === 'BUY' ? 'text-emerald-400 bg-emerald-500/10' : 'text-rose-400 bg-rose-500/10') + '">' + item.position_type + '</span></td>';
      html += '  <td class="px-3 py-2.5 text-right font-mono text-gray-200">' + formatRp(item.entry_price) + '</td>';
      html += '  <td class="px-3 py-2.5 text-center font-mono text-gray-200">' + item.lots + '</td>';
      html += '  <td class="px-3 py-2.5 text-right font-mono text-gray-300">' + formatRp(item.capital_used) + '</td>';
      html += '  <td class="px-3 py-2.5 text-right font-mono ' + (item.exit_price ? 'text-white font-semibold' : 'text-gray-500') + '">' + (item.exit_price ? formatRp(item.exit_price) : '—') + '</td>';
      html += '  <td class="px-3 py-2.5 text-right font-mono ' + plClass + '">' + (isClosed ? ((plRp >= 0 ? '+' : '') + formatRp(plRp) + ' (' + (plPct >= 0 ? '+' : '') + plPct + '%)') : 'Running') + '</td>';
      html += '  <td class="px-3 py-2.5 text-xs text-gray-400 truncate max-w-[150px]" title="' + (item.notes || '') + '">' + (item.notes || '—') + '</td>';
      html += '  <td class="px-3 py-2.5 text-center">';
      html += '    <button onclick="deleteJournalTrade(\'' + (item.id || idx) + '\')" class="p-1 text-gray-500 hover:text-rose-400 transition" title="Hapus transaksi">&times;</button>';
      html += '  </td>';
      html += '</tr>';
    });

    tbody.innerHTML = html;
    updateJournalSummaryTiles();
  }

  function updateJournalSummaryTiles() {
    var tradingCap = getNumericValue('mmTradingCapital');
    var closedTrades = journalData.filter(function(j) { return j.status === 'CLOSED' || (j.exit_price != null && j.exit_price > 0); });
    var openTrades = journalData.filter(function(j) { return j.status === 'OPEN' || (!j.exit_price && j.exit_price !== 0); });

    var deployedCapital = openTrades.reduce(function(sum, j) { return sum + (Number(j.capital_used) || 0); }, 0);
    var totalRealizedPl = closedTrades.reduce(function(sum, j) { return sum + (Number(j.realized_pl_rp) || 0); }, 0);
    var winningTrades = closedTrades.filter(function(j) { return Number(j.realized_pl_rp) > 0; }).length;
    var winRate = closedTrades.length > 0 ? ((winningTrades / closedTrades.length) * 100).toFixed(1) : 0;
    var idleCash = Math.max(0, tradingCap - deployedCapital + totalRealizedPl);

    var capEl = document.getElementById('mmJrTotalCap');
    var rdlEl = document.getElementById('mmJrIdleRdl');
    var plEl = document.getElementById('mmJrTotalPl');
    var wrEl = document.getElementById('mmJrWinRate');

    if (capEl) capEl.textContent = formatRp(tradingCap);
    if (rdlEl) rdlEl.textContent = formatRp(idleCash);
    if (plEl) {
      plEl.textContent = (totalRealizedPl >= 0 ? '+' : '') + formatRp(totalRealizedPl);
      plEl.className = totalRealizedPl >= 0 ? 'text-lg font-black text-emerald-400' : 'text-lg font-black text-rose-400';
    }
    if (wrEl) wrEl.textContent = winRate + '% (' + winningTrades + '/' + closedTrades.length + ')';
  }

  window.addJournalTrade = async function() {
    var ticker = (document.getElementById('mmJrTicker') && document.getElementById('mmJrTicker').value || '').trim().toUpperCase();
    if (!ticker) {
      if (typeof showToast === 'function') showToast('Masukkan kode saham.', 'warning');
      return;
    }

    var position_type = (document.getElementById('mmJrType') && document.getElementById('mmJrType').value) || 'BUY';
    var entry_price = getNumericValue('mmJrEntryPrice');
    var lots = Math.max(1, parseInt(document.getElementById('mmJrLots').value, 10) || 1);
    var exit_price = getNumericValue('mmJrExitPrice') || null;
    var notes = (document.getElementById('mmJrNotes') && document.getElementById('mmJrNotes').value) || '';
    var trade_date = (document.getElementById('mmJrDate') && document.getElementById('mmJrDate').value) || new Date().toISOString().slice(0, 10);

    var capital_used = entry_price * lots * 100;
    var realized_pl_rp = 0;
    var realized_pl_pct = 0;
    var status = exit_price ? 'CLOSED' : 'OPEN';

    if (exit_price) {
      var exitCap = exit_price * lots * 100;
      if (position_type === 'BUY') {
        realized_pl_rp = exitCap - capital_used;
        realized_pl_pct = Number((((exit_price - entry_price) / entry_price) * 100).toFixed(2));
      } else {
        realized_pl_rp = capital_used - exitCap;
        realized_pl_pct = Number((((entry_price - exit_price) / entry_price) * 100).toFixed(2));
      }
    }

    var entry = {
      id: 'local_' + Date.now(),
      ticker: ticker,
      position_type: position_type,
      entry_price: entry_price,
      lots: lots,
      capital_used: capital_used,
      exit_price: exit_price,
      realized_pl_rp: realized_pl_rp,
      realized_pl_pct: realized_pl_pct,
      notes: notes,
      status: status,
      trade_date: trade_date
    };

    journalData.unshift(entry);
    renderJournalTable();

    // Clear inputs
    if (document.getElementById('mmJrTicker')) document.getElementById('mmJrTicker').value = '';
    if (document.getElementById('mmJrEntryPrice')) document.getElementById('mmJrEntryPrice').value = '';
    if (document.getElementById('mmJrLots')) document.getElementById('mmJrLots').value = '1';
    if (document.getElementById('mmJrExitPrice')) document.getElementById('mmJrExitPrice').value = '';
    if (document.getElementById('mmJrNotes')) document.getElementById('mmJrNotes').value = '';

    // Sync to backend
    try {
      localStorage.setItem('autocuan_journal_cache', JSON.stringify(journalData));
      await fetch('/api/money-management', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ action: 'save-journal' }, entry))
      });
      if (typeof showToast === 'function') showToast('Transaksi berhasil dicatat di jurnal!', 'success');
    } catch (_) {}
  };

  window.deleteJournalTrade = async function(id) {
    journalData = journalData.filter(function(j, idx) { return (j.id || idx) !== id && String(idx) !== String(id); });
    renderJournalTable();
    try {
      localStorage.setItem('autocuan_journal_cache', JSON.stringify(journalData));
      await fetch('/api/money-management', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete-journal', id: id })
      });
    } catch (_) {}
  };

  window.loadJournalData = async function() {
    try {
      var res = await fetch('/api/money-management?action=get-journal');
      var json = await res.json();
      if (json && json.success && Array.isArray(json.data)) {
        journalData = json.data;
      } else {
        var local = localStorage.getItem('autocuan_journal_cache');
        if (local) journalData = JSON.parse(local);
      }
    } catch (_) {
      var local2 = localStorage.getItem('autocuan_journal_cache');
      if (local2) journalData = JSON.parse(local2);
    }
    renderJournalTable();
  };

  window.initMoneyManagement = function() {
    loadCashflowData();
    loadJournalData();
  };

})(window);
