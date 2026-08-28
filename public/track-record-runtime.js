// Auto-Cuan Track Record / Outcome Report UI Runtime
var _trData = null;
var _trCategoryFilter = 'all';
var _trInFlight = false;

function formatRp(val) {
    if (val == null || !isFinite(val)) return '—';
    return Number(val).toLocaleString('id-ID');
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

        var entryText = s.entry1 ? formatRp(s.entry1) : '—';
        if (s.entry2 && s.entry2 !== s.entry1) entryText += '–' + formatRp(s.entry2);

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
            '<td class="px-3 py-2.5 text-gray-400 whitespace-nowrap font-mono text-[11px]">' + (s.date || '—') + '</td>' +
            '<td class="px-3 py-2.5 text-right font-mono text-gray-300">' + entryText + '</td>' +
            '<td class="px-3 py-2.5 text-right font-mono text-emerald-400 font-medium">' + formatRp(s.tp1) + '</td>' +
            '<td class="px-3 py-2.5 text-right font-mono text-emerald-300">' + formatRp(s.tp2) + '</td>' +
            '<td class="px-3 py-2.5 text-right font-mono text-red-400">' + formatRp(s.sl) + '</td>' +
            '<td class="px-3 py-2.5 text-center whitespace-nowrap">' +
                '<span class="inline-block px-2.5 py-0.5 rounded-full text-[10px] font-semibold tracking-wide" style="color:' + s.status_tone + ';background-color:' + s.status_bg + ';border:1px solid ' + s.status_border + '">' +
                    s.status_label +
                '</span>' +
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
    var entryVal = '—';
    if (s.entry1 != null) {
        entryVal = (s.entry2 != null && s.entry2 !== s.entry1) ? (s.entry1 + '-' + s.entry2) : String(s.entry1);
    }
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

if (typeof window !== 'undefined') {
    window.loadTrackRecord = loadTrackRecord;
    window.filterTrackRecordCategory = filterTrackRecordCategory;
    window.renderTrackRecordTable = renderTrackRecordTable;
    window.exportTrackRecordCsv = exportTrackRecordCsv;
    window.generateTrackRecordCsv = generateTrackRecordCsv;
    window.formatTrackRecordCsvRow = formatTrackRecordCsvRow;
}

if (typeof module !== 'undefined' && module.exports) {
    module.exports = {
        TRACK_RECORD_CSV_HEADERS: TRACK_RECORD_CSV_HEADERS,
        escapeCsvCell: escapeCsvCell,
        getTrackRecordCsvFilename: getTrackRecordCsvFilename,
        formatTrackRecordCsvRow: formatTrackRecordCsvRow,
        generateTrackRecordCsv: generateTrackRecordCsv,
        exportTrackRecordCsv: exportTrackRecordCsv
    };
}
