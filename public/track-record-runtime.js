// Auto-Cuan Track Record / Outcome Report UI Runtime
var _trData = null;
var _trCategoryFilter = 'all';
var _trInFlight = false;

function formatRp(val) {
    if (val == null || !isFinite(val)) return '—';
    return Number(val).toLocaleString('id-ID');
}

// F-082: escape server/fetch error text before writing it to innerHTML.
function escapeHtml(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (ch) {
        return ({ '&': '&' + 'amp;', '<': '&' + 'lt;', '>': '&' + 'gt;', '"': '&' + 'quot;', "'": '&' + '#39;' })[ch];
    });
}

function escapeAttr(value) {
    return escapeHtml(value);
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
        var res = null;
        var rawText = '';
        var data = null;

        // KEEP-ALIVE: read through the shared SWR store when present so a tab
        // revisit renders the previous rows instead of the skeleton.
        var trFetch = (window.AutoCuanKeepAlive && typeof window.AutoCuanKeepAlive.cachedFetch === 'function')
            ? window.AutoCuanKeepAlive.cachedFetch.bind(window.AutoCuanKeepAlive)
            : fetch;

        // 1. Try dedicated route /api/track-record
        try {
            res = await trFetch('/api/track-record');
            if (res && res.ok) {
                rawText = await res.text();
                if (rawText && !rawText.trim().startsWith('<')) {
                    data = JSON.parse(rawText);
                }
            }
        } catch (_) {}

        // 2. Fallback to /api/sector-hot?action=track-record if needed
        if (!data || !data.success) {
            try {
                res = await trFetch('/api/sector-hot?action=track-record');
                rawText = await res.text();
                if (rawText && !rawText.trim().startsWith('<')) {
                    data = JSON.parse(rawText);
                } else if (rawText && rawText.trim().startsWith('<')) {
                    throw new Error('Respon server tidak valid (halaman HTML/502). Sedang menyinkronkan data.');
                }
            } catch (fbErr) {
                if (!data) throw fbErr;
            }
        }

        if (!data || !data.success) {
            tbody.innerHTML = '<tr><td colspan="10" class="text-center py-8 text-[var(--ac-loss,#dc2626)]">Gagal memuat track record: ' + escapeHtml((data && data.error) || 'Terjadi kesalahan.') + '</td></tr>';
            return;
        }

        _trData = data;
        renderTrackRecordUI(data);
    } catch (err) {
        tbody.innerHTML = '<tr><td colspan="10" class="text-center py-8 text-[var(--ac-loss,#dc2626)]">Gagal terhubung ke server: ' + escapeHtml(err.message || String(err)) + '</td></tr>';
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

    var elBestGain = document.getElementById('trBestGain');
    var elBestGainSub = document.getElementById('trBestGainSub');
    var bestGain = sum.best_gain || null;
    if (elBestGain) elBestGain.textContent = bestGain ? ('+' + bestGain.gain_pct + '%') : '—';
    if (elBestGainSub) elBestGainSub.textContent = bestGain ? (bestGain.ticker + ' · ' + bestGain.date) : 'Belum ada data';

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
            var m = meta[key] || { label: c.label || key, description: '' };
            var wrTp1Text = c.win_rate_tp1 != null ? c.win_rate_tp1 : (c.total ? ((c.tp1_hits / c.total) * 100).toFixed(1) + '%' : '—');
            var slRateText = c.sl_rate != null ? c.sl_rate : (c.total ? ((c.sl_hits / c.total) * 100).toFixed(1) + '%' : '—');
            html += '<div class="ac-surface-bounded p-3 flex flex-col justify-between hover:border-[var(--ac-primary,#10b981)] transition cursor-pointer" onclick="filterTrackRecordCategory(\'' + key + '\')">' +
                '<div>' +
                    '<div class="flex items-center justify-between gap-2 mb-1">' +
                        '<div class="flex items-center gap-1.5 font-bold text-xs text-[var(--text-primary,#ffffff)]">' +
                            '<span>' + escapeHtml(m.label) + '</span>' +
                        '</div>' +
                        '<span class="text-[10px] px-2 py-0.5 rounded-full font-mono font-semibold bg-emerald-500/15 text-emerald-400 border border-emerald-500/25 tabular-nums lining-nums">' + wrTp1Text + ' TP</span>' +
                    '</div>' +
                    '<p class="text-[11px] text-[var(--ac-text-secondary,#9ca3af)] line-clamp-1 mb-2">' + (m.description || '') + '</p>' +
                '</div>' +
                '<div class="grid grid-cols-3 gap-1 pt-2 border-t border-[var(--ac-line-hairline,#374151)] text-center text-[10px]">' +
                    '<div><span class="text-[var(--ac-text-muted,#6b7280)] block">Total</span><span class="font-bold text-[var(--text-primary,#e5e7eb)] text-xs font-mono tabular-nums lining-nums">' + c.total + '</span></div>' +
                    '<div><span class="text-[var(--ac-text-muted,#6b7280)] block">TP1/TP2</span><span class="font-bold text-emerald-400 text-xs font-mono tabular-nums lining-nums">' + c.tp1_hits + '</span></div>' +
                    '<div><span class="text-[var(--ac-text-muted,#6b7280)] block">SL Rate</span><span class="font-bold text-red-400 text-xs font-mono tabular-nums lining-nums">' + slRateText + '</span></div>' +
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
        if (btn.getAttribute('data-tr-cat') === _trCategoryFilter) {
            btn.className = 'screener-tab is-active px-3 py-1.5 rounded-lg text-xs font-medium transition';
        } else {
            btn.className = 'screener-tab px-3 py-1.5 rounded-lg text-xs font-medium transition';
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
        var sourceCat = s.source || s.category || '';
        if (_trCategoryFilter !== 'all' && sourceCat !== _trCategoryFilter && s.source_short !== _trCategoryFilter) return false;
        var outcome = s.outcome || s.status || '';
        if (statusFilter !== 'all') {
            if (statusFilter === 'TP1_HIT' && outcome !== 'TP1_HIT' && outcome !== 'TP2_HIT') return false;
            else if (statusFilter === 'TP2_HIT' && outcome !== 'TP2_HIT') return false;
            else if (statusFilter === 'SL_HIT' && outcome !== 'SL_HIT') return false;
            else if (statusFilter === 'RUNNING' && outcome !== 'RUNNING' && outcome !== 'ENTRY_HIT') return false;
            else if (statusFilter === 'WAITING' && outcome !== 'WAITING') return false;
            else if (statusFilter === 'EXPIRED' && outcome !== 'EXPIRED') return false;
        }
        if (search && String(s.ticker || '').toUpperCase().indexOf(search) === -1) return false;
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
        var gainVal = s.gain_pct != null ? s.gain_pct : (s.max_gain_pct != null ? s.max_gain_pct : null);
        var gainHtml = '—';
        if (gainVal != null && isFinite(gainVal)) {
            var numGain = Number(gainVal);
            var isPos = numGain > 0;
            var isNeg = numGain < 0;
            var colorClass = isPos ? 'text-emerald-400 font-bold' : (isNeg ? 'text-red-400 font-bold' : 'text-gray-400');
            gainHtml = '<span class="' + colorClass + ' font-mono tabular-nums">' + (isPos ? '+' : '') + numGain.toFixed(1) + '%</span>';
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

        var outcome = s.outcome || s.status || '';
        var isExpiredSignal = outcome === 'EXPIRED' || s.status_label === 'Sinyal Kedaluwarsa' || s.status_label === 'Expired';
        var statusTooltip = isExpiredSignal ? ' title="Harga tidak pernah masuk area beli (Entry 1 / Entry 2) dalam batas waktu pengamatan sinyal."' : '';
        var statusLabelText = isExpiredSignal ? 'Sinyal Kedaluwarsa' : (s.status_label || (
            outcome === 'TP1_HIT' ? 'TP1 Hit' :
            outcome === 'TP2_HIT' ? 'TP2 Hit' :
            outcome === 'SL_HIT' ? 'Stop Loss' :
            outcome === 'RUNNING' ? 'Berjalan' :
            outcome === 'WAITING' ? 'Menunggu Entry' :
            (outcome || '—')
        ));
        var infoIcon = isExpiredSignal ? '<svg class="w-3 h-3 ml-1 inline text-gray-400 opacity-80" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>' : '';

        var statusTone = s.status_tone || (outcome.indexOf('TP') !== -1 ? 'var(--ac-gain,#10b981)' : (outcome === 'SL_HIT' ? 'var(--ac-loss,#ef4444)' : (outcome === 'RUNNING' ? 'var(--ac-info,#3b82f6)' : (outcome === 'WAITING' ? 'var(--ac-amber,#d97706)' : 'var(--ac-text-secondary,#94a3b8)'))));
        var statusBg = s.status_bg || (outcome.indexOf('TP') !== -1 ? 'rgba(16,185,129,0.12)' : (outcome === 'SL_HIT' ? 'rgba(239,68,68,0.12)' : (outcome === 'RUNNING' ? 'rgba(59,130,246,0.12)' : (outcome === 'WAITING' ? 'rgba(217,119,6,0.12)' : 'var(--ac-surface-sunken,rgba(148,163,184,0.1))'))));
        var statusBorder = s.status_border || (outcome.indexOf('TP') !== -1 ? 'rgba(16,185,129,0.28)' : (outcome === 'SL_HIT' ? 'rgba(239,68,68,0.28)' : (outcome === 'RUNNING' ? 'rgba(59,130,246,0.28)' : (outcome === 'WAITING' ? 'rgba(217,119,6,0.28)' : 'var(--ac-line-hairline,rgba(148,163,184,0.2))'))));

        var hitSubtext = '';
        if (s.hit_time_wib && s.hit_time_wib !== '—') {
            hitSubtext = '<div class="text-[10px] text-gray-400 font-mono mt-0.5 flex items-center justify-center gap-1">' +
                '<span class="text-emerald-400/70">⚡</span><span>' + s.hit_time_wib + '</span>' +
                (s.price_at_hit ? '<span class="text-gray-600">·</span><span class="text-gray-300 font-medium">' + formatRp(s.price_at_hit) + '</span>' : '') +
                '</div>';
        }

        var sourceText = s.source_short || s.source || s.category || '—';
        var tickerBtn = '<button type="button" class="ticker-link font-bold text-[var(--text-primary,#ffffff)] hover:text-[var(--ac-primary,#10b981)] font-mono text-sm tracking-wide transition" onclick="if(typeof navigateTo===\'function\')navigateTo(\'analisis\',null,\'' + escapeAttr(s.ticker) + '\')" title="Buka Riset ' + escapeAttr(s.ticker) + '">' + escapeHtml(s.ticker) + '</button>';

        rowsHtml += '<tr class="hover:bg-[var(--ac-surface-hover,rgba(255,255,255,0.03))] transition">' +
            '<td class="px-3 py-2.5 font-bold text-[var(--text-primary,#ffffff)] sticky left-0 bg-[var(--ac-surface,#181d28)] z-10">' +
                '<div class="flex items-center gap-1.5">' +
                    tickerBtn +
                    (s.score ? '<span class="text-[10px] font-mono px-1.5 py-0.2 rounded bg-[var(--ac-surface-sunken,#111827)] text-[var(--ac-text-secondary,#9ca3af)] border border-[var(--ac-line-hairline,#374151)] tabular-nums lining-nums">' + s.score + '</span>' : '') +
                '</div>' +
            '</td>' +
            '<td class="px-3 py-2.5 text-[var(--ac-text-secondary,#9ca3af)] whitespace-nowrap">' +
                '<span class="text-[11px] px-2 py-0.5 rounded-md bg-[var(--ac-surface-sunken,#111827)] border border-[var(--ac-line-hairline,#374151)] font-medium">' + escapeHtml(sourceText) + '</span>' +
            '</td>' +
            '<td class="px-3 py-2.5 text-[var(--ac-text-secondary,#9ca3af)] whitespace-nowrap font-mono text-[11px] tabular-nums lining-nums">' +
                '<div class="font-medium text-[var(--text-primary,#e5e7eb)]">' + (s.date || '—') + '</div>' +
                signalSubtext +
            '</td>' +
            '<td class="px-3 py-2.5 text-right font-mono text-[var(--text-primary,#e5e7eb)] tabular-nums lining-nums">' + entryText + '</td>' +
            '<td class="px-3 py-2.5 text-right font-mono text-[var(--ac-gain,#10b981)] font-medium tabular-nums lining-nums">' + formatRp(s.tp1) + '</td>' +
            '<td class="px-3 py-2.5 text-right font-mono text-[var(--ac-gain,#10b981)]/90 tabular-nums lining-nums">' + formatRp(s.tp2) + '</td>' +
            '<td class="px-3 py-2.5 text-right font-mono text-[var(--ac-loss,#ef4444)] tabular-nums lining-nums">' + formatRp(s.sl) + '</td>' +
            '<td class="px-3 py-2 text-center whitespace-nowrap">' +
                '<span class="inline-flex items-center px-2.5 py-0.5 rounded-full text-[10.5px] font-semibold tracking-wide' + (isExpiredSignal ? ' cursor-help' : '') + '" style="color:' + statusTone + ';background-color:' + statusBg + ';border:1px solid ' + statusBorder + '"' + statusTooltip + '>' +
                    escapeHtml(statusLabelText) + infoIcon +
                '</span>' +
                hitSubtext +
            '</td>' +
            '<td class="px-3 py-2.5 text-right font-mono tabular-nums lining-nums">' + gainHtml + '</td>' +
            '<td class="px-3 py-2.5 text-right text-[var(--ac-text-secondary,#9ca3af)] whitespace-nowrap text-[11px]">' + (s.duration_text || '—') + '</td>' +
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
            tabTable.className = 'ac-btn ac-btn-secondary text-xs py-1.5 px-3 inline-flex items-center gap-1.5 font-semibold';
        } else {
            tabTable.className = 'ac-btn ac-btn-secondary is-active text-xs py-1.5 px-3 inline-flex items-center gap-1.5 font-semibold';
        }
    }

    if (tabBacktest) {
        if (isBacktest) {
            tabBacktest.className = 'ac-btn ac-btn-secondary is-active text-xs py-1.5 px-3 inline-flex items-center gap-1.5 font-semibold';
        } else {
            tabBacktest.className = 'ac-btn ac-btn-secondary text-xs py-1.5 px-3 inline-flex items-center gap-1.5 font-semibold';
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
        elPfSub.textContent = 'Gross: Rp ' + (m.grossProfitRp / 1000000).toFixed(1) + 'Jt / ' + (m.grossLossRp / 1000000).toFixed(1) + 'Jt';
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
