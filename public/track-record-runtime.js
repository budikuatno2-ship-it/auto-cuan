// Auto-Cuan Track Record / Outcome Report UI Runtime
var _trData = null;
var _trCategoryFilter = 'all';
var _trInFlight = false;

function formatRp(val) {
    if (val == null || !isFinite(val)) return '—';
    return Number(val).toLocaleString('id-ID');
}

// Entry bounds, always low-to-high.
//
// In `telegram_daily_picks`, entry1 is the UPPER bound and entry2 the LOWER one.
// All three writers agree on that: api/sector-hot.js:7136-7137, the
// dailyPickInsertRowFromCandidate path (getEntry1 -> entry_high), and
// lib/intraday-fast-watcher-publisher.js:211-212. The convention is stated at
// api/sector-hot.js:3519-3520 ("conservative representative").
//
// So rendering entry1 then entry2 with a dash printed the range backwards
// ("Rp 1.250–Rp 1.200"). The data is correct; only the display order was not.
// Sorting here rather than swapping the fields keeps this a display-only change
// and stays correct whichever way round a future row arrives.
function trEntryBounds(s) {
    var a = s && s.entry1 != null && isFinite(s.entry1) ? Number(s.entry1) : null;
    var b = s && s.entry2 != null && isFinite(s.entry2) ? Number(s.entry2) : null;
    if (a == null && b == null) return [];
    if (a == null) return [b];
    if (b == null) return [a];
    if (a === b) return [a];
    return a < b ? [a, b] : [b, a];
}

function trSkeletonHtml() {
    return '<tr><td colspan="10" class="text-center py-10 text-gray-500"><div class="spinner mx-auto mb-2"></div>Memuat data track record sinyal...</td></tr>';
}

async function loadTrackRecord(force) {
    if (_trInFlight) return;
    var tbody = document.getElementById('trTableBody');
    if (!tbody) return;

    if (!force && _trData) {
        renderTrackRecordUI(_trData);
        return;
    }

    tbody.innerHTML = trSkeletonHtml();
    _trInFlight = true;

    var refreshBtn = document.getElementById('trackRecordRefreshBtn');
    if (refreshBtn) refreshBtn.classList.add('opacity-50', 'pointer-events-none');

    try {
        var res = await fetch('/api/sector-hot?action=track-record');
        var data = await res.json();

        if (!data || !data.success) {
            tbody.innerHTML = '<tr><td colspan="10" class="text-center py-8 text-red-400">Gagal memuat track record: ' + ((data && data.error) || 'Terjadi kesalahan.') + '</td></tr>';
            return;
        }

        _trData = data;
        renderTrackRecordUI(data);
    } catch (err) {
        tbody.innerHTML = '<tr><td colspan="10" class="text-center py-8 text-red-400">Gagal terhubung ke server: ' + (err.message || String(err)) + '</td></tr>';
    } finally {
        _trInFlight = false;
        if (refreshBtn) refreshBtn.classList.remove('opacity-50', 'pointer-events-none');
    }
}

function renderTrackRecordUI(data) {
    if (!data) return;
    var sum = data.summary || {};

    // 1. Summary Cards
    var elTotal = document.getElementById('trTotalSignals');
    if (elTotal) elTotal.textContent = (sum.total_signals || 0) + ' Sinyal';

    var elTotalSub = document.getElementById('trTotalSignalsSub');
    if (elTotalSub) elTotalSub.textContent = (sum.total_resolved || 0) + ' selesai · ' + ((sum.running_signals || 0) + (sum.waiting_signals || 0)) + ' aktif';

    var elWr1 = document.getElementById('trWinRateTp1');
    if (elWr1) elWr1.textContent = sum.win_rate_tp1 || '0.0%';

    var elTp1Sub = document.getElementById('trTp1HitsSub');
    if (elTp1Sub) elTp1Sub.textContent = (sum.tp1_hits || 0) + ' dari ' + (sum.total_signals || 0) + ' capai TP1';

    var elWr2 = document.getElementById('trWinRateTp2');
    if (elWr2) elWr2.textContent = sum.win_rate_tp2 || '0.0%';

    var elTp2Sub = document.getElementById('trTp2HitsSub');
    if (elTp2Sub) elTp2Sub.textContent = (sum.tp2_hits || 0) + ' target maksimal';

    var elSl = document.getElementById('trSlRate');
    if (elSl) elSl.textContent = sum.sl_rate || '0.0%';

    var elSlSub = document.getElementById('trSlHitsSub');
    if (elSlSub) elSlSub.textContent = (sum.sl_hits || 0) + ' kena Stop Loss';

    // 2. Category Cards Breakdown
    var catGrid = document.getElementById('trCategoryGrid');
    if (catGrid && data.by_category) {
        var cats = data.by_category;
        var meta = data.category_meta || {};
        var html = '';

        var order = ['daytrade', 'swing_konglo', 'swing_nk', 'top5'];
        order.forEach(function(key) {
            var c = cats[key];
            if (!c) return;
            var m = meta[key] || { icon: '📌', label: c.label || key, description: '' };
            html += '<div class="bg-dark-800/50 border border-dark-600/25 rounded-xl p-3.5 flex flex-col justify-between hover:border-emerald-500/30 transition cursor-pointer" onclick="filterTrackRecordCategory(\'' + key + '\')">' +
                '<div>' +
                    '<div class="flex items-center justify-between gap-2 mb-1.5">' +
                        '<div class="flex items-center gap-1.5 font-bold text-xs text-white">' +
                            '<span>' + m.icon + '</span>' +
                            '<span>' + m.label + '</span>' +
                        '</div>' +
                        '<span class="text-[10px] px-2 py-0.5 rounded-full font-mono font-semibold bg-emerald-500/15 text-emerald-300 border border-emerald-500/25">' + c.win_rate_tp1 + ' TP</span>' +
                    '</div>' +
                    '<p class="text-[11px] text-gray-500 line-clamp-1 mb-2.5">' + (m.description || '') + '</p>' +
                '</div>' +
                '<div class="grid grid-cols-3 gap-1 pt-2 border-t border-dark-600/30 text-center text-[10px]">' +
                    '<div><span class="text-gray-500 block">Total</span><span class="font-bold text-gray-200 text-xs">' + c.total + '</span></div>' +
                    '<div><span class="text-gray-500 block">TP1/TP2</span><span class="font-bold text-emerald-400 text-xs">' + c.tp1_hits + '</span></div>' +
                    '<div><span class="text-gray-500 block">SL Rate</span><span class="font-bold text-red-400 text-xs">' + c.sl_rate + '</span></div>' +
                '</div>' +
            '</div>';
        });
        catGrid.innerHTML = html;
    }

    renderTrackRecordTable();
    if (typeof triggerBacktestSimulation === 'function') {
        try { triggerBacktestSimulation(); } catch (_) {}
    }
}

function filterTrackRecordCategory(cat) {
    _trCategoryFilter = cat || 'all';

    // Update Category Tabs Pill UI
    var tabs = document.querySelectorAll('#trCategoryTabs button');
    tabs.forEach(function(btn) {
        btn.classList.remove('active');
        if (btn.getAttribute('data-tr-cat') === _trCategoryFilter) {
            btn.classList.add('active');
        }
    });

    renderTrackRecordTable();
}

function renderTrackRecordTable() {
    if (!_trData) return;
    var tbody = document.getElementById('trTableBody');
    var emptyEl = document.getElementById('trEmptyState');
    if (!tbody) return;

    var signals = _trData.signals || [];
    var statusFilter = (document.getElementById('trStatusFilter') && document.getElementById('trStatusFilter').value) || 'all';
    var search = (document.getElementById('trSearchInput') && document.getElementById('trSearchInput').value.trim().toUpperCase()) || '';

    var filtered = signals.filter(function(s) {
        if (_trCategoryFilter !== 'all' && s.source !== _trCategoryFilter) return false;
        if (statusFilter !== 'all') {
            if (statusFilter === 'TP1_HIT' && s.outcome !== 'TP1_HIT' && s.outcome !== 'TP2_HIT') return false;
            else if (statusFilter === 'TP2_HIT' && s.outcome !== 'TP2_HIT') return false;
            else if (statusFilter === 'SL_HIT' && s.outcome !== 'SL_HIT') return false;
            else if (statusFilter === 'RUNNING' && s.outcome !== 'RUNNING' && s.outcome !== 'ENTRY_HIT') return false;
            else if (statusFilter === 'WAITING' && s.outcome !== 'WAITING') return false;
            else if (statusFilter === 'EXPIRED' && s.outcome !== 'EXPIRED') return false;
        }
        if (search && s.ticker.indexOf(search) === -1) return false;
        return true;
    });

    if (!filtered.length) {
        tbody.innerHTML = '';
        if (emptyEl) emptyEl.classList.remove('hidden');
        return;
    }

    if (emptyEl) emptyEl.classList.add('hidden');

    var rowsHtml = '';
    filtered.forEach(function(s) {
        var gainHtml = '—';
        if (s.gain_pct != null) {
            var isPos = s.gain_pct > 0;
            var isNeg = s.gain_pct < 0;
            var colorClass = isPos ? 'text-emerald-400 font-bold' : (isNeg ? 'text-red-400 font-bold' : 'text-gray-400');
            gainHtml = '<span class="' + colorClass + '">' + (isPos ? '+' : '') + s.gain_pct.toFixed(1) + '%</span>';
        }

        var entryBounds = trEntryBounds(s);
        var entryText = entryBounds.length ? entryBounds.map(formatRp).join('–') : '—';

        var signalSubtext = '';
        if (s.signal_time_wib && s.signal_time_wib !== '—') {
            signalSubtext = '<div class="text-[10px] text-gray-400 mt-0.5 flex items-center gap-1 font-mono">' +
                '<span class="text-gray-500">🕒</span><span>' + s.signal_time_wib + '</span>' +
                (s.price_at_signal ? '<span class="text-gray-600">·</span><span class="text-gray-300 font-medium">' + formatRp(s.price_at_signal) + '</span>' : '') +
                '</div>';
        }

        var isExpiredSignal = s.outcome === 'EXPIRED' || s.status_label === 'Sinyal Kedaluwarsa' || s.status_label === 'Expired';
        var statusTooltip = isExpiredSignal ? ' title="Harga tidak pernah masuk area beli (Entry 1 / Entry 2) dalam batas waktu pengamatan sinyal."' : '';
        var statusLabelText = isExpiredSignal ? 'Sinyal Kedaluwarsa' : s.status_label;
        var infoIcon = isExpiredSignal ? '<svg class="w-3 h-3 ml-1 inline text-gray-400 opacity-80" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>' : '';

        var hitSubtext = '';
        if (s.hit_time_wib && s.hit_time_wib !== '—') {
            hitSubtext = '<div class="text-[10px] text-gray-400 font-mono mt-0.5 flex items-center justify-center gap-1">' +
                '<span class="text-emerald-400/70">⚡</span><span>' + s.hit_time_wib + '</span>' +
                (s.price_at_hit ? '<span class="text-gray-600">·</span><span class="text-gray-300 font-medium">' + formatRp(s.price_at_hit) + '</span>' : '') +
                '</div>';
        }

        rowsHtml += '<tr class="hover:bg-dark-700/40 transition">' +
            '<td class="px-3 py-2.5 font-bold text-white sticky left-0 bg-dark-800/90 z-10">' +
                '<div class="flex items-center gap-1.5">' +
                    '<span>' + s.ticker + '</span>' +
                    (s.score ? '<span class="text-[10px] font-mono px-1.5 py-0.2 rounded bg-dark-600/60 text-gray-300 border border-dark-500/30">' + s.score + '</span>' : '') +
                '</div>' +
            '</td>' +
            '<td class="px-3 py-2.5 text-gray-400 whitespace-nowrap">' +
                '<span class="text-[11px] px-2 py-0.5 rounded-md bg-dark-700/60 border border-dark-600/40">' + s.source_short + '</span>' +
            '</td>' +
            '<td class="px-3 py-2.5 text-gray-400 whitespace-nowrap font-mono text-[11px]">' +
                '<div class="font-medium text-gray-200">' + (s.date || '—') + '</div>' +
                signalSubtext +
            '</td>' +
            '<td class="px-3 py-2.5 text-right font-mono text-gray-300">' + entryText + '</td>' +
            '<td class="px-3 py-2.5 text-right font-mono text-emerald-400 font-medium">' + formatRp(s.tp1) + '</td>' +
            '<td class="px-3 py-2.5 text-right font-mono text-emerald-300">' + formatRp(s.tp2) + '</td>' +
            '<td class="px-3 py-2.5 text-right font-mono text-red-400">' + formatRp(s.sl) + '</td>' +
            '<td class="px-3 py-2 text-center whitespace-nowrap">' +
                '<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-[10.5px] font-semibold tracking-wide' + (isExpiredSignal ? ' cursor-help' : '') + '" style="color:' + s.status_tone + ';background-color:' + s.status_bg + ';border:1px solid ' + s.status_border + '"' + statusTooltip + '>' +
                    statusLabelText + infoIcon +
                '</span>' +
                hitSubtext +
            '</td>' +
            '<td class="px-3 py-2.5 text-right font-mono">' + gainHtml + '</td>' +
            '<td class="px-3 py-2.5 text-right text-gray-400 whitespace-nowrap text-[11px]">' + (s.duration_text || '—') + '</td>' +
        '</tr>';
    });

    tbody.innerHTML = rowsHtml;
}

// ===== CSV EXPORT TOOL =====
var TRACK_RECORD_CSV_HEADERS = [
    'Tanggal',
    'Ticker',
    'Kategori',
    'Status',
    'Entry',
    'TP1',
    'TP2',
    'Stop Loss',
    'Max Gain %',
    'Status Hit',
    'Durasi (Hari)'
];

function escapeCsvCell(val) {
    if (val == null) return '';
    var str = String(val);
    if (str.search(/([",\n\r])/g) !== -1) {
        str = '"' + str.replace(/"/g, '""') + '"';
    }
    return str;
}

function getTrackRecordCsvFilename(d) {
    var dt = d || new Date();
    var yyyy = dt.getFullYear();
    var mm = String(dt.getMonth() + 1).padStart(2, '0');
    var dd = String(dt.getDate()).padStart(2, '0');
    return 'autocuan-track-record-' + yyyy + '-' + mm + '-' + dd + '.csv';
}

function formatTrackRecordCsvRow(s) {
    if (!s) return [];
    var csvBounds = trEntryBounds(s);
    var entryVal = csvBounds.length ? csvBounds.join('-') : '—';
    var gainVal = '—';
    if (s.gain_pct != null) {
        gainVal = (s.gain_pct > 0 ? '+' : '') + Number(s.gain_pct).toFixed(1) + '%';
    }
    return [
        s.date || '—',
        s.ticker || '',
        s.source_label || s.category || s.source_short || '—',
        s.status_label || '—',
        entryVal,
        s.tp1 != null ? String(s.tp1) : '—',
        s.tp2 != null ? String(s.tp2) : '—',
        s.sl != null ? String(s.sl) : '—',
        gainVal,
        s.outcome || s.status_label || '—',
        s.duration_text || '—'
    ];
}

function generateTrackRecordCsv(signals) {
    var rows = [TRACK_RECORD_CSV_HEADERS.map(escapeCsvCell).join(',')];
    (signals || []).forEach(function(s) {
        var rowData = formatTrackRecordCsvRow(s);
        rows.push(rowData.map(escapeCsvCell).join(','));
    });
    return rows.join('\r\n');
}

function exportTrackRecordCsv() {
    if (!_trData || !_trData.signals || !_trData.signals.length) {
        if (typeof showToast === 'function') showToast('Belum ada data track record untuk diunduh.', 'warning');
        return;
    }
    var csvContent = generateTrackRecordCsv(_trData.signals);
    var blob = new Blob([csvContent], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var filename = getTrackRecordCsvFilename();

    var link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', filename);
    link.style.display = 'none';
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    setTimeout(function() { URL.revokeObjectURL(url); }, 1000);
    if (typeof showToast === 'function') showToast('📥 File ' + filename + ' berhasil diunduh!', 'success');
}

// ===== BACKTESTING & SIMULASI STRATEGI CONTROLLER =====
var _trCurrentView = 'table'; // 'table' | 'backtest'
var _trDataInitialized = false;

function switchTrackRecordView(view) {
    _trCurrentView = view || 'table';
    var isBacktest = _trCurrentView === 'backtest';

    var tabTable = document.getElementById('trViewTabTable');
    var tabBacktest = document.getElementById('trViewTabBacktest');
    var panelTable = document.getElementById('trTableViewPanel');
    var panelBacktest = document.getElementById('trBacktestViewPanel');

    if (tabTable) {
        if (isBacktest) {
            tabTable.className = 'px-3.5 py-1.5 rounded-lg text-xs font-semibold text-gray-400 hover:text-gray-200 border border-transparent hover:bg-dark-700/50 transition flex items-center gap-1.5';
        } else {
            tabTable.className = 'px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 transition flex items-center gap-1.5';
        }
    }

    if (tabBacktest) {
        if (isBacktest) {
            tabBacktest.className = 'px-3.5 py-1.5 rounded-lg text-xs font-semibold bg-emerald-500/20 text-emerald-300 border border-emerald-500/30 transition flex items-center gap-1.5';
        } else {
            tabBacktest.className = 'px-3.5 py-1.5 rounded-lg text-xs font-semibold text-gray-400 hover:text-gray-200 border border-transparent hover:bg-dark-700/50 transition flex items-center gap-1.5';
        }
    }

    if (panelTable) {
        if (isBacktest) panelTable.classList.add('hidden');
        else panelTable.classList.remove('hidden');
    }

    if (panelBacktest) {
        if (isBacktest) {
            panelBacktest.classList.remove('hidden');
            triggerBacktestSimulation();
        } else {
            panelBacktest.classList.add('hidden');
        }
    }
}

function triggerBacktestSimulation() {
    if (typeof AutoCuanBacktest === 'undefined' || !AutoCuanBacktest.runBacktestSimulation) return;
    var signals = _trData && Array.isArray(_trData.signals) ? _trData.signals : [];

    var elCategory = document.getElementById('btCategoryFilter');
    var elPeriod = document.getElementById('btPeriodFilter');
    var elMinRr = document.getElementById('btMinRrFilter');
    var elCapital = document.getElementById('btInitialCapitalInput');
    var elSizing = document.getElementById('btSizingModeFilter');
    var elPosition = document.getElementById('btPositionAmountInput');
    var elTarget = document.getElementById('btTargetStrategyFilter');

    var config = {
        category: elCategory ? elCategory.value : 'all',
        periodDays: elPeriod ? (elPeriod.value === 'all' ? 'all' : Number(elPeriod.value)) : 'all',
        minRr: elMinRr ? parseFloat(elMinRr.value) || 0 : 0,
        initialCapital: elCapital ? parseFloat(elCapital.value) || 10000000 : 10000000,
        sizingMode: elSizing ? elSizing.value : 'fixed_amount',
        positionAmount: elPosition ? parseFloat(elPosition.value) || 2000000 : 2000000,
        targetStrategy: elTarget ? elTarget.value : 'max_tp'
    };

    var result = AutoCuanBacktest.runBacktestSimulation(signals, config);
    var m = result.metrics;

    // Update UI Metrics
    var elEnding = document.getElementById('btMetricEndingCapital');
    if (elEnding) {
        elEnding.textContent = 'Rp ' + Number(m.endingCapital).toLocaleString('id-ID');
    }

    var elReturn = document.getElementById('btMetricNetReturn');
    if (elReturn) {
        var isProfit = m.netProfitRp >= 0;
        elReturn.className = 'text-[11px] font-semibold mt-1 ' + (isProfit ? 'text-emerald-400' : 'text-red-400');
        elReturn.textContent = (isProfit ? '+' : '') + 'Rp ' + Number(m.netProfitRp).toLocaleString('id-ID') + ' (' + (isProfit ? '+' : '') + m.totalReturnPct + '%)';
    }

    var elWr = document.getElementById('btMetricWinRate');
    if (elWr) {
        elWr.textContent = m.winRatePct + '%';
    }

    var elWrSub = document.getElementById('btMetricWinLossSub');
    if (elWrSub) {
        elWrSub.textContent = m.winCount + ' Menang · ' + m.lossCount + ' Kalah (' + m.totalTrades + ' trade)';
    }

    var elPf = document.getElementById('btMetricProfitFactor');
    if (elPf) {
        elPf.textContent = m.profitFactor >= 90 ? '> 99' : m.profitFactor.toFixed(2);
    }

    var elPfSub = document.getElementById('btMetricProfitFactorSub');
    if (elPfSub) {
        elPfSub.textContent = 'Gross: Rp ' + (m.grossProfitRp / 1000000).toFixed(1) + 'M / ' + (m.grossLossRp / 1000000).toFixed(1) + 'M';
    }

    var elExp = document.getElementById('btMetricExpectancy');
    if (elExp) {
        var isExpPos = m.expectancyRp >= 0;
        elExp.className = 'text-xl sm:text-2xl font-black ' + (isExpPos ? 'text-emerald-300' : 'text-red-400');
        elExp.textContent = (isExpPos ? '+' : '') + 'Rp ' + Number(m.expectancyRp).toLocaleString('id-ID');
    }

    var elDd = document.getElementById('btMetricMaxDrawdown');
    if (elDd) {
        elDd.textContent = m.maxDrawdownPct + '%';
    }

    var elAvgDur = document.getElementById('btMetricAvgDuration');
    if (elAvgDur) {
        elAvgDur.textContent = m.avgDurationDays + ' Hari';
    }

    // Render Chart and Trade Table
    AutoCuanBacktest.renderBacktestChart(result.equityCurve);
    AutoCuanBacktest.renderBacktestTradeTable(result.trades);
}

if (typeof window !== 'undefined') {
    window.loadTrackRecord = loadTrackRecord;
    window.filterTrackRecordCategory = filterTrackRecordCategory;
    window.renderTrackRecordTable = renderTrackRecordTable;
    window.exportTrackRecordCsv = exportTrackRecordCsv;
    window.generateTrackRecordCsv = generateTrackRecordCsv;
    window.formatTrackRecordCsvRow = formatTrackRecordCsvRow;
    window.switchTrackRecordView = switchTrackRecordView;
    window.triggerBacktestSimulation = triggerBacktestSimulation;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        TRACK_RECORD_CSV_HEADERS: TRACK_RECORD_CSV_HEADERS,
        escapeCsvCell: escapeCsvCell,
        getTrackRecordCsvFilename: getTrackRecordCsvFilename,
        formatTrackRecordCsvRow: formatTrackRecordCsvRow,
        trEntryBounds: trEntryBounds,
        generateTrackRecordCsv: generateTrackRecordCsv,
        exportTrackRecordCsv: exportTrackRecordCsv
    };
}
