/**
 * Auto-Cuan All-in-One Money Management Runtime — Excel / Airtable Spreadsheet Grid
 * 1. Sub-tab Arus Kas Pribadi (Life Cashflow Spreadsheet)
 * 2. Sub-tab Jurnal Portofolio Trading (Trading Journal Grid, Win Rate, RDL, Inline Editing)
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

  // KEEP-ALIVE bridge. Reads go through the shared SWR store when it is present
  // so returning to this tab renders the stored cashflow/journal instantly.
  // Every write in this file uses plain fetch (non-GET is never cached), and
  // each write invalidates the affected key so the next read cannot be stale.
  function acMoneyFetch(url, options) {
    if (window.AutoCuanKeepAlive && typeof window.AutoCuanKeepAlive.cachedFetch === 'function') {
      return window.AutoCuanKeepAlive.cachedFetch(url, options);
    }
    return fetch(url, options);
  }

  /** Drop the cached reads this module owns after any successful write. */
  function invalidateMoneyCache() {
    if (window.AutoCuanKeepAlive && typeof window.AutoCuanKeepAlive.invalidate === 'function') {
      window.AutoCuanKeepAlive.invalidate('/api/money-management');
    }
  }

  function escapeHtml(str) {
    if (str == null) return '';
    return String(str).replace(/[&<>"']/g, function(m) {
      if (m === '&') return '&';
      if (m === '<') return '<';
      if (m === '>') return '>';
      if (m === '"') return '"';
      return String.fromCharCode(38) + '#39;';
    });
  }

  function formatRp(val) {
    if (val == null || !Number.isFinite(Number(val))) return 'Rp 0';
    return 'Rp ' + Number(val).toLocaleString('id-ID');
  }

  function formatNumber(val) {
    if (val == null || !Number.isFinite(Number(val))) return '0';
    return Number(val).toLocaleString('id-ID');
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
        renderCashflowSpreadsheet();
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
        statusEl.textContent = '💡 Masukkan rincian pos anggaran di spreadsheet untuk menghitung batas alokasi hidup aman dan modal trading.';
        statusEl.className = 'p-3.5 rounded-xl bg-dark-800/80 border border-dark-600/40 text-xs text-gray-400';
      } else if (remainingNonTrading < 0) {
        statusEl.textContent = '⚠️ Peringatan: Total pengeluaran + modal trading melebihi pemasukan bulanan! Kurangi pos modal trading atau pengeluaran gaya hidup.';
        statusEl.className = 'p-3.5 rounded-xl bg-rose-500/10 border border-rose-500/30 text-xs text-rose-400 font-semibold';
      } else {
        var pctTrading = totalIncome > 0 ? ((tradingCap / totalIncome) * 100).toFixed(1) : '0';
        statusEl.textContent = '✅ Anggaran Aman: ' + pctTrading + '% pemasukan dialokasikan sebagai dana dingin bursa. Sisa kas kebutuhan hidup di luar trading aman terjaga (' + formatRp(remainingNonTrading) + ').';
        statusEl.className = 'p-3.5 rounded-xl bg-emerald-500/10 border border-emerald-500/30 text-xs text-emerald-300 font-semibold';
      }
    }

    // Auto-update Trading Journal initial capital reference
    var jrCapRef = document.getElementById('mmJrTradingCapRef');
    if (jrCapRef) jrCapRef.textContent = formatRp(tradingCap);
    updateJournalSummaryTiles();
    renderCashflowSpreadsheetRows(totalIncome, necessities, wants, savings, tradingCap, remainingNonTrading);
  };

  function renderCashflowSpreadsheet() {
    recalculateCashflow();
  }

  function renderCashflowSpreadsheetRows(totalIncome, necessities, wants, savings, tradingCap, remainingNonTrading) {
    var tbody = document.getElementById('mmCashflowSpreadsheetBody');
    if (!tbody) return;

    var salary = getNumericValue('mmIncomeSalary');
    var side = getNumericValue('mmIncomeSide');
    var other = getNumericValue('mmIncomeOther');

    var pct = function(val) {
      if (!totalIncome || totalIncome <= 0 || !val) return '0.0%';
      return ((val / totalIncome) * 100).toFixed(1) + '%';
    };

    var items = [
      { id: 'mmIncomeSalary', cat: 'Pemasukan', name: 'Gaji Pokok / Uang Bulanan', type: 'INCOME', val: salary, note: 'Penghasilan rutin bulanan' },
      { id: 'mmIncomeSide', cat: 'Pemasukan', name: 'Freelance / Sampingan', type: 'INCOME', val: side, note: 'Pendapatan tidak tetap' },
      { id: 'mmIncomeOther', cat: 'Pemasukan', name: 'Pemasukan Lain-lain', type: 'INCOME', val: other, note: 'Dividen, bonus, dll' },
      { id: 'mmExpNecessities', cat: 'Kebutuhan', name: 'Kebutuhan Pokok (Makan, Kost, Listrik)', type: 'EXPENSE', val: necessities, note: 'Wajib dipenuhi setiap bulan' },
      { id: 'mmExpWants', cat: 'Gaya Hidup', name: 'Keinginan & Hiburan (Lifestyle)', type: 'EXPENSE', val: wants, note: 'Ngopi, belanja, hobi' },
      { id: 'mmSavings', cat: 'Tabungan', name: 'Dana Darurat / Tabungan Bank', type: 'SAVINGS', val: savings, note: 'Cadangan likuid 3–6 bulan' },
      { id: 'mmTradingCapital', cat: 'Investasi', name: 'Pos Modal Trading (Dana Dingin)', type: 'TRADING', val: tradingCap, note: 'Modal dialokasikan ke jurnal' }
    ];

    var html = '';
    items.forEach(function(row, idx) {
      var typeBadge = '';
      if (row.type === 'INCOME') typeBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-emerald-500/10 text-emerald-400 border border-emerald-500/30">INCOME</span>';
      else if (row.type === 'EXPENSE') typeBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-rose-500/10 text-rose-400 border border-rose-500/30">EXPENSE</span>';
      else if (row.type === 'SAVINGS') typeBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-cyan-500/10 text-cyan-400 border border-cyan-500/30">SAVINGS</span>';
      else typeBadge = '<span class="px-2 py-0.5 rounded text-[10px] font-bold bg-blue-500/10 text-blue-300 border border-blue-500/30">CAPITAL</span>';

      html += '<tr class="hover:bg-dark-700/50 border-b border-dark-600/40 transition">';
      html += '  <td class="px-3 py-2 text-center font-mono text-gray-500 border-r border-dark-600/40 text-[11px]">' + (idx + 1) + '</td>';
      html += '  <td class="px-3 py-2 text-gray-300 font-medium border-r border-dark-600/40 text-xs">' + escapeHtml(row.cat) + '</td>';
      html += '  <td class="px-3 py-2 text-white font-semibold border-r border-dark-600/40 text-xs">' + escapeHtml(row.name) + '</td>';
      html += '  <td class="px-3 py-2 text-center border-r border-dark-600/40">' + typeBadge + '</td>';
      html += '  <td class="px-3 py-1.5 text-right font-mono border-r border-dark-600/40">';
      html += '    <input type="number" value="' + (row.val || '') + '" placeholder="0" oninput="document.getElementById(\'' + row.id + '\').value=this.value; recalculateCashflow();" class="w-full text-right bg-dark-900/80 border border-dark-600/60 rounded px-2.5 py-1 text-xs text-white font-mono font-bold focus:border-emerald-500 outline-none">';
      html += '  </td>';
      html += '  <td class="px-3 py-2 text-right font-mono text-gray-300 border-r border-dark-600/40 text-xs">' + pct(row.val) + '</td>';
      html += '  <td class="px-3 py-2 text-gray-400 text-xs">' + escapeHtml(row.note) + '</td>';
      html += '</tr>';
    });

    tbody.innerHTML = html;

    // Update spreadsheet footer
    var ftIncome = document.getElementById('mmCfFootIncome');
    var ftExpense = document.getElementById('mmCfFootExpense');
    var ftTrading = document.getElementById('mmCfFootTrading');
    var ftRemaining = document.getElementById('mmCfFootRemaining');
    if (ftIncome) ftIncome.textContent = formatRp(totalIncome);
    if (ftExpense) ftExpense.textContent = formatRp(necessities + wants + savings);
    if (ftTrading) ftTrading.textContent = formatRp(tradingCap);
    if (ftRemaining) {
      ftRemaining.textContent = formatRp(remainingNonTrading);
      ftRemaining.className = remainingNonTrading >= 0 ? 'text-emerald-400 font-black' : 'text-rose-400 font-black';
    }
  }

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
      var res = await fetch('/api/money-management', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload)
      });
      var json = await res.json();
      if (json && json.success) {
        invalidateMoneyCache();
        if (typeof showToast === 'function') showToast('Arus kas bulanan berhasil disimpan ke server!', 'success');
      }
    } catch (e) {
      if (typeof showToast === 'function') showToast('Gagal menyimpan arus kas ke server.', 'warning');
    } finally {
      if (saveBtn) { saveBtn.disabled = false; saveBtn.textContent = 'Simpan Anggaran'; }
    }
  };

  window.loadCashflowData = async function() {
    var nowWib = new Date(Date.now() + 7 * 60 * 60 * 1000);
    var month = nowWib.toISOString().slice(0, 7);

    try {
      var res = await acMoneyFetch('/api/money-management?action=get-cashflow&month=' + encodeURIComponent(month));
      var json = await res.json();
      if (json && json.success && json.data) {
        cashflowData = json.data;
      }
    } catch (_) {}

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
  // TRADING JOURNAL SPREADSHEET GRID
  // ----------------------------------------------------
  function renderJournalTable() {
    var tbody = document.getElementById('mmJournalTableBody');
    if (!tbody) return;

    if (!journalData || journalData.length === 0) {
      tbody.innerHTML = '<tr><td colspan="12" class="text-center py-8 text-gray-500 text-xs">Belum ada transaksi di jurnal. Masukkan transaksi pertama Anda di baris spreadsheet atas.</td></tr>';
      updateJournalSummaryTiles();
      return;
    }

    var html = '';
    var totalLot = 0;
    var totalCapital = 0;
    var totalPlRp = 0;

    journalData.forEach(function(item, idx) {
      var entryPrice = Number(item.entry_price || 0);
      var lots = Number(item.lots || 1);
      var capitalUsed = Number(item.capital_used || (entryPrice * lots * 100));
      var exitPrice = item.exit_price != null && item.exit_price > 0 ? Number(item.exit_price) : null;
      var isClosed = item.status === 'CLOSED' || exitPrice != null;

      var plRp = 0;
      var plPct = 0;
      if (exitPrice) {
        if (item.position_type === 'BUY') {
          plRp = (exitPrice * lots * 100) - capitalUsed;
          plPct = Number((((exitPrice - entryPrice) / entryPrice) * 100).toFixed(2));
        } else {
          plRp = capitalUsed - (exitPrice * lots * 100);
          plPct = Number((((entryPrice - exitPrice) / entryPrice) * 100).toFixed(2));
        }
      } else {
        plRp = Number(item.realized_pl_rp || 0);
        plPct = Number(item.realized_pl_pct || 0);
      }

      totalLot += lots;
      totalCapital += capitalUsed;
      if (isClosed) totalPlRp += plRp;

      var plClass = plRp > 0 ? 'text-emerald-400 font-bold' : (plRp < 0 ? 'text-rose-400 font-bold' : 'text-gray-400');
      var safeTicker = escapeHtml(item.ticker);
      var safeDate = escapeHtml(item.trade_date || '—');
      var safeNotes = escapeHtml(item.notes || '');
      var safeType = escapeHtml(item.position_type);
      var safeId = escapeHtml(item.id || idx);

      html += '<tr class="hover:bg-dark-700/50 border-b border-dark-600/40 transition">';
      html += '  <td class="px-2.5 py-2 font-mono text-gray-500 text-center border-r border-dark-600/40 text-[11px]">' + (idx + 1) + '</td>';
      html += '  <td class="px-3 py-2 font-mono text-gray-300 text-center border-r border-dark-600/40 text-xs whitespace-nowrap">' + safeDate + '</td>';
      html += '  <td class="px-3 py-2 font-bold text-white tracking-wide border-r border-dark-600/40 text-xs cursor-pointer hover:text-emerald-400" onclick="window.location.assign(\'/analisis-saham?ticker=' + safeTicker + '\')">' + safeTicker + '</td>';
      html += '  <td class="px-2.5 py-2 text-center border-r border-dark-600/40"><span class="px-1.5 py-0.5 rounded text-[10px] font-bold ' + (item.position_type === 'BUY' ? 'text-emerald-400 bg-emerald-500/10 border border-emerald-500/30' : 'text-rose-400 bg-rose-500/10 border border-rose-500/30') + '">' + safeType + '</span></td>';
      html += '  <td class="px-3 py-2 text-right font-mono text-gray-200 border-r border-dark-600/40 text-xs">' + formatRp(entryPrice) + '</td>';
      html += '  <td class="px-3 py-2 text-right font-mono text-gray-200 border-r border-dark-600/40 text-xs">' + formatNumber(lots) + '</td>';
      html += '  <td class="px-3 py-2 text-right font-mono text-gray-300 border-r border-dark-600/40 text-xs font-semibold">' + formatRp(capitalUsed) + '</td>';
      
      // Inline editable Exit Price
      html += '  <td class="px-2 py-1 text-right font-mono border-r border-dark-600/40 text-xs">';
      html += '    <input type="number" value="' + (exitPrice || '') + '" placeholder="Open" onchange="updateJournalTradeExit(\'' + safeId + '\', this.value)" class="w-24 text-right bg-dark-900 border border-dark-600/60 rounded px-2 py-1 text-xs text-white font-mono focus:border-emerald-500 outline-none">';
      html += '  </td>';

      html += '  <td class="px-3 py-2 text-right font-mono ' + plClass + ' border-r border-dark-600/40 text-xs whitespace-nowrap">' + (isClosed ? ((plRp >= 0 ? '+' : '') + formatRp(plRp)) : '<span class="text-amber-400 text-[10px] font-semibold">RUNNING</span>') + '</td>';
      html += '  <td class="px-3 py-2 text-right font-mono ' + plClass + ' border-r border-dark-600/40 text-xs">' + (isClosed ? ((plPct >= 0 ? '+' : '') + plPct + '%') : '—') + '</td>';
      html += '  <td class="px-2.5 py-2 text-center border-r border-dark-600/40 text-[10px] font-bold">' + (isClosed ? '<span class="text-gray-400">CLOSED</span>' : '<span class="text-emerald-400">OPEN</span>') + '</td>';
      
      // Inline editable Notes
      html += '  <td class="px-2 py-1 border-r border-dark-600/40 text-xs">';
      html += '    <input type="text" value="' + safeNotes + '" placeholder="Catatan strategi..." onchange="updateJournalTradeNotes(\'' + safeId + '\', this.value)" class="w-full bg-transparent border-0 px-1 py-1 text-xs text-gray-300 focus:bg-dark-900 focus:border focus:border-dark-600 rounded outline-none">';
      html += '  </td>';

      html += '  <td class="px-2 py-2 text-center whitespace-nowrap">';
      html += '    <button onclick="deleteJournalTrade(\'' + safeId + '\')" class="p-1 text-gray-500 hover:text-rose-400 transition" title="Hapus transaksi">&times;</button>';
      html += '  </td>';
      html += '</tr>';
    });

    tbody.innerHTML = html;
    updateJournalSpreadsheetSummary(totalLot, totalCapital, totalPlRp);
    updateJournalSummaryTiles();
  }

  function updateJournalSpreadsheetSummary(totalLot, totalCapital, totalPlRp) {
    var ftLots = document.getElementById('mmJrFootLots');
    var ftCapital = document.getElementById('mmJrFootCapital');
    var ftPl = document.getElementById('mmJrFootPl');
    var ftWr = document.getElementById('mmJrFootWinRate');

    var closedTrades = journalData.filter(function(j) { return j.status === 'CLOSED' || (j.exit_price != null && j.exit_price > 0); });
    var winningTrades = closedTrades.filter(function(j) { return Number(j.realized_pl_rp) > 0; }).length;
    var winRate = closedTrades.length > 0 ? Number(((winningTrades / closedTrades.length) * 100).toFixed(1)) : 0;

    if (ftLots) ftLots.textContent = formatNumber(totalLot);
    if (ftCapital) ftCapital.textContent = formatRp(totalCapital);
    if (ftPl) {
      ftPl.textContent = (totalPlRp >= 0 ? '+' : '') + formatRp(totalPlRp);
      ftPl.className = 'px-3 py-2.5 text-right font-mono border-r border-dark-600/60 ' + (totalPlRp >= 0 ? 'text-emerald-400 font-bold' : 'text-rose-400 font-bold');
    }
    if (ftWr) ftWr.textContent = winRate + '% (' + winningTrades + '/' + closedTrades.length + ')';
  }

  function updateJournalSummaryTiles() {
    var tradingCap = getNumericValue('mmTradingCapital');
    var closedTrades = journalData.filter(function(j) { return j.status === 'CLOSED' || (j.exit_price != null && j.exit_price > 0); });
    var openTrades = journalData.filter(function(j) { return j.status === 'OPEN' || (!j.exit_price && j.exit_price !== 0); });

    var deployedCapital = openTrades.reduce(function(sum, j) { return sum + (Number(j.capital_used) || 0); }, 0);
    var totalRealizedPl = closedTrades.reduce(function(sum, j) { return sum + (Number(j.realized_pl_rp) || 0); }, 0);
    var winningTrades = closedTrades.filter(function(j) { return Number(j.realized_pl_rp) > 0; }).length;
    var winRate = closedTrades.length > 0 ? Number(((winningTrades / closedTrades.length) * 100).toFixed(1)) : 0;
    var idleCash = Math.max(0, tradingCap - deployedCapital + totalRealizedPl);

    var capEl = document.getElementById('mmJrTotalCap');
    var rdlEl = document.getElementById('mmJrIdleRdl');
    var plEl = document.getElementById('mmJrTotalPl');
    var wrEl = document.getElementById('mmJrWinRate');

    if (capEl) capEl.textContent = formatRp(tradingCap);
    if (rdlEl) rdlEl.textContent = formatRp(idleCash);
    if (plEl) {
      plEl.textContent = (totalRealizedPl >= 0 ? '+' : '') + formatRp(totalRealizedPl);
      plEl.className = totalRealizedPl >= 0 ? 'text-base sm:text-lg font-black text-emerald-400' : 'text-base sm:text-lg font-black text-rose-400';
    }
    if (wrEl) wrEl.textContent = winRate + '% (' + winningTrades + '/' + closedTrades.length + ')';
  }

  window.updateJournalTradeExit = async function(id, val) {
    var exitNum = parseFloat(String(val).replace(/[^0-9.-]+/g, ''));
    var item = journalData.find(function(j, idx) { return (j.id || idx) === id || String(idx) === String(id); });
    if (!item) return;

    if (Number.isFinite(exitNum) && exitNum > 0) {
      item.exit_price = exitNum;
      item.status = 'CLOSED';
      var entryPrice = Number(item.entry_price || 0);
      var lots = Number(item.lots || 1);
      var capitalUsed = entryPrice * lots * 100;
      var exitCap = exitNum * lots * 100;
      if (item.position_type === 'BUY') {
        item.realized_pl_rp = exitCap - capitalUsed;
        item.realized_pl_pct = Number((((exitNum - entryPrice) / entryPrice) * 100).toFixed(2));
      } else {
        item.realized_pl_rp = capitalUsed - exitCap;
        item.realized_pl_pct = Number((((entryPrice - exitNum) / entryPrice) * 100).toFixed(2));
      }
    } else {
      item.exit_price = null;
      item.status = 'OPEN';
      item.realized_pl_rp = 0;
      item.realized_pl_pct = 0;
    }

    renderJournalTable();
    try {
      await fetch('/api/money-management', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ action: 'save-journal' }, item))
      });
      invalidateMoneyCache();
      if (typeof showToast === 'function') showToast('Harga exit & P/L berhasil diperbarui.', 'success');
    } catch (_) {}
  };

  window.updateJournalTradeNotes = async function(id, text) {
    var item = journalData.find(function(j, idx) { return (j.id || idx) === id || String(idx) === String(id); });
    if (!item) return;
    item.notes = String(text || '');
    try {
      await fetch('/api/money-management', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ action: 'save-journal' }, item))
      });
    } catch (_) {}
  };

  window.addJournalTrade = async function() {
    var ticker = (document.getElementById('mmJrTicker') && document.getElementById('mmJrTicker').value || '').trim().toUpperCase();
    if (!ticker) {
      if (typeof showToast === 'function') showToast('Masukkan kode saham.', 'warning');
      return;
    }

    var position_type = (document.getElementById('mmJrType') && document.getElementById('mmJrType').value) || 'BUY';
    var entry_price = getNumericValue('mmJrEntryPrice');
    if (entry_price <= 0) {
      if (typeof showToast === 'function') showToast('Masukkan harga entry yang valid.', 'warning');
      return;
    }
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
      await fetch('/api/money-management', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(Object.assign({ action: 'save-journal' }, entry))
      });
      invalidateMoneyCache();
      if (typeof showToast === 'function') showToast('Transaksi berhasil dicatat di jurnal spreadsheet!', 'success');
    } catch (_) {}
  };

  window.deleteJournalTrade = async function(id) {
    journalData = journalData.filter(function(j, idx) { return (j.id || idx) !== id && String(idx) !== String(id); });
    renderJournalTable();
    try {
      await fetch('/api/money-management', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete-journal', id: id })
      });
      invalidateMoneyCache();
    } catch (_) {}
  };

  window.loadJournalData = async function() {
    try {
      var res = await acMoneyFetch('/api/money-management?action=get-journal');
      var json = await res.json();
      if (json && json.success && Array.isArray(json.data)) {
        journalData = json.data;
      }
    } catch (_) {}
    renderJournalTable();
  };

  window.invalidateMoneyManagementCache = invalidateMoneyCache;

  window.initMoneyManagement = function() {
    loadCashflowData();
    loadJournalData();
  };

})(window);
