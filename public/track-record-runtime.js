// Auto-Cuan Track Record / Outcome Report UI Runtime
var _trData = null;
var _trCategoryFilter = 'all';
var _trInFlight = false;
var _trLoadedAt = 0;
var _trDataUrl = '/api/track-record';

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
    return '<tr><td colspan="10" class="text-center py-10 tr-loading-cell"><div class="spinner mx-auto mb-2"></div>Memuat data track record sinyal...</td></tr>';
}

async function loadTrackRecord(force) {
    if (_trInFlight) return;
    var tbody = document.getElementById('trTableBody');
    if (!tbody) return;

    if (!force && _trData) {
        var cache = window.AutoCuanKeepAlive;
        var snapshot = cache && typeof cache.peek === 'function' ? cache.peek(_trDataUrl) : null;
        var fresh = cache && typeof cache.peek === 'function'
            ? snapshot && snapshot.fresh && snapshot.data && snapshot.data.success
            : Date.now() - _trLoadedAt < 10 * 60 * 1000;
        if (fresh) {
            if (snapshot) {
                _trData = snapshot.data;
                _trLoadedAt = Date.now() - snapshot.ageMs;
            }
            renderTrackRecordUI(_trData);
            return;
        }
    }

    if (!_trData) tbody.innerHTML = trSkeletonHtml();
    _trInFlight = true;

    var refreshBtn = document.getElementById('trackRecordRefreshBtn');
    var status = document.getElementById('trRefreshStatus');
    if (!status && refreshBtn) {
        status = document.createElement('div');
        status.id = 'trRefreshStatus';
        status.setAttribute('role', 'status');
        status.setAttribute('aria-live', 'polite');
        status.style.cssText = 'min-height:3em;font-size:12px;line-height:1.5;color:var(--ac-text-muted)';
        var page = document.getElementById('page-trackrecord');
        if (page) page.insertBefore(status, page.children[1] || null);
    }
    if (status) status.textContent = 'Memperbarui track record…';
    if (refreshBtn) {
        refreshBtn.disabled = true;
        refreshBtn.setAttribute('aria-busy', 'true');
    }

    try {
        var res = null;
        var rawText = '';
        var data = null;
        var loadedUrl = '/api/track-record';

        // KEEP-ALIVE: read through the shared SWR store when present so a tab
        // revisit renders the previous rows instead of the skeleton.
        var trFetch = (window.AutoCuanKeepAlive && typeof window.AutoCuanKeepAlive.cachedFetch === 'function')
            ? window.AutoCuanKeepAlive.cachedFetch.bind(window.AutoCuanKeepAlive)
            : fetch;

        // 1. Try dedicated route /api/track-record
        try {
            res = await trFetch('/api/track-record', force ? { cache: 'no-cache' } : undefined, { revalidate: !!force });
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
                loadedUrl = '/api/sector-hot?action=track-record';
                res = await trFetch(loadedUrl, force ? { cache: 'no-cache' } : undefined, { revalidate: !!force });
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
            if (status) status.textContent = _trData ? 'Gagal memperbarui. Data terakhir tetap ditampilkan.' : 'Gagal memuat track record.';
            if (!_trData) tbody.innerHTML = '<tr><td colspan="10" class="text-center py-8 tr-error-cell">Gagal memuat track record: ' + escapeHtml((data && data.error) || 'Terjadi kesalahan.') + '</td></tr>';
            return;
        }

        _trData = data;
        _trDataUrl = loadedUrl;
        _trLoadedAt = Date.now();
        renderTrackRecordUI(data);
        if (status) status.textContent = force ? 'Diperbarui. Track record terbaru ditampilkan.' : 'Data track record tersedia.';
    } catch (err) {
        if (status) status.textContent = _trData ? 'Gagal memperbarui. Data terakhir tetap ditampilkan.' : 'Gagal memuat track record.';
        if (!_trData) tbody.innerHTML = '<tr><td colspan="10" class="text-center py-8 tr-error-cell">Gagal terhubung ke server: ' + escapeHtml(err.message || String(err)) + '</td></tr>';
    } finally {
        _trInFlight = false;
        if (refreshBtn) {
            refreshBtn.disabled = false;
            refreshBtn.removeAttribute('aria-busy');
        }
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
            function formatSafeVal(v, suffix) {
                if (v == null || v === 'undefined' || v === 'null') return '—';
                var str = String(v).trim();
                if (!str || str === 'undefined' || str === 'null' || str === 'NaN') return '—';
                return suffix ? (str + suffix) : str;
            }
            var winRateStr = formatSafeVal(c.win_rate_tp1, ' TP');
            var totalStr = formatSafeVal(c.total);
            var tpHitsStr = formatSafeVal(c.tp1_hits);
            var slRateStr = formatSafeVal(c.sl_rate);

            html += '<div class="tr-cat-card" onclick="filterTrackRecordCategory(\'' + key + '\')">' +
                '<div>' +
                    '<div class="tr-cat-card-header">' +
                        '<div class="tr-cat-card-title">' +
                            '<span>' + escapeHtml(m.label || key) + '</span>' +
                        '</div>' +
                        '<span class="tr-cat-pill font-mono">' + escapeHtml(winRateStr) + '</span>' +
                    '</div>' +
                    (m.description ? ('<p class="tr-cat-desc">' + escapeHtml(m.description) + '</p>') : '') +
                '</div>' +
                '<div class="tr-cat-stats font-mono">' +
                    '<div class="tr-cat-stat"><span class="tr-stat-lbl">Total</span><span class="tr-stat-val">' + totalStr + '</span></div>' +
                    '<div class="tr-cat-stat"><span class="tr-stat-lbl">TP1/TP2</span><span class="tr-stat-val ac-num-positive">' + tpHitsStr + '</span></div>' +
                    '<div class="tr-cat-stat"><span class="tr-stat-lbl">SL Rate</span><span class="tr-stat-val ac-num-negative">' + slRateStr + '</span></div>' +
                '</div>' +
            '</div>';
        });
        catGrid.innerHTML = html;
    }

    var catDetails = document.getElementById('trCatDetails');
    if (catDetails) {
        if (window.innerWidth < 768) {
            catDetails.removeAttribute('open');
        } else {
            catDetails.setAttribute('open', '');
        }
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
        var active = btn.getAttribute('data-tr-cat') === _trCategoryFilter;
        btn.classList.toggle('active', active);
    });

    renderTrackRecordTable();
}

function getOutcomeClass(outcome) {
    if (outcome === 'TP2_HIT') return 'tr-status-tp2';
    if (outcome === 'TP1_HIT') return 'tr-status-tp1';
    if (outcome === 'SL_HIT') return 'tr-status-sl';
    if (outcome === 'RUNNING' || outcome === 'ENTRY_HIT') return 'tr-status-running';
    if (outcome === 'WAITING') return 'tr-status-waiting';
    if (outcome === 'EXPIRED') return 'tr-status-expired';
    return 'tr-status-default';
}

function formatOutcomeLabel(s) {
    if (!s) return 'Status belum dikenali';
    var isExpiredSignal = s.outcome === 'EXPIRED' || s.status === 'EXPIRED' || s.status_label === 'Sinyal Kedaluwarsa' || s.status_label === 'Expired';
    if (isExpiredSignal) return 'Sinyal Kedaluwarsa';

    var rawEnums = ['TP1_HIT', 'TP2_HIT', 'SL_HIT', 'RUNNING', 'ENTRY_HIT', 'WAITING', 'EXPIRED'];
    if (s.status_label && typeof s.status_label === 'string' && rawEnums.indexOf(s.status_label) === -1) {
        return s.status_label;
    }

    var raw = s.outcome || s.status || '';
    if (raw === 'TP2_HIT') return 'TP2 tercapai';
    if (raw === 'TP1_HIT') return 'TP1 tercapai';
    if (raw === 'SL_HIT') return 'Stop Loss terkena';
    if (raw === 'RUNNING') return 'Berjalan';
    if (raw === 'ENTRY_HIT') return 'Entry tercapai';
    if (raw === 'WAITING') return 'Menunggu';
    if (raw === 'EXPIRED') return 'Sinyal Kedaluwarsa';
    return 'Status belum dikenali';
}

function renderTrackRecordTable() {
    if (!_trData) return;
    var tbody = document.getElementById('trTableBody');
    var emptyEl = document.getElementById('trEmptyState');
    var mobileHost = document.getElementById('trMobileList');
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
        if (mobileHost) mobileHost.innerHTML = '';
        if (emptyEl) emptyEl.classList.remove('hidden');
        return;
    }

    if (emptyEl) emptyEl.classList.add('hidden');

    var rowsHtml = '';
    var mobileHtml = '';

    filtered.forEach(function(s) {
        var gainHtml = '—';
        var gainClass = 'ac-num-neutral';
        if (s.gain_pct != null) {
            var isPos = s.gain_pct > 0;
            var isNeg = s.gain_pct < 0;
            gainClass = isPos ? 'ac-num-positive font-bold' : (isNeg ? 'ac-num-negative font-bold' : 'ac-num-neutral');
            gainHtml = '<span class="' + gainClass + '">' + (isPos ? '+' : '') + s.gain_pct.toFixed(1) + '%</span>';
        }

        var entryBounds = trEntryBounds(s);
        var entryText = entryBounds.length ? entryBounds.map(formatRp).join('–') : '—';

        var signalSubtext = '';
        if (s.signal_time_wib && s.signal_time_wib !== '—') {
            signalSubtext = '<div class="tr-subtext-line font-mono">' +
                '<span class="tr-subtext-icon">🕒</span><span>' + escapeHtml(s.signal_time_wib) + '</span>' +
                (s.price_at_signal ? '<span class="tr-subtext-sep">·</span><span class="tr-subtext-val font-medium">' + formatRp(s.price_at_signal) + '</span>' : '') +
                '</div>';
        }

        var isExpiredSignal = s.outcome === 'EXPIRED' || s.status === 'EXPIRED' || s.status_label === 'Sinyal Kedaluwarsa' || s.status_label === 'Expired';
        var statusTooltip = isExpiredSignal ? ' title="Harga tidak pernah masuk area beli (Entry 1 / Entry 2) dalam batas waktu pengamatan sinyal."' : '';
        var statusLabelText = formatOutcomeLabel(s);
        var infoIcon = isExpiredSignal ? '<svg class="w-3 h-3 ml-1 inline opacity-80" fill="none" stroke="currentColor" viewBox="0 0 24 24"><path stroke-linecap="round" stroke-linejoin="round" stroke-width="2" d="M13 16h-1v-4h-1m1-4h.01M21 12a9 9 0 11-18 0 9 9 0 0118 0z"/></svg>' : '';
        var statusClass = getOutcomeClass(s.outcome || s.status);

        var hitSubtext = '';
        if (s.hit_time_wib && s.hit_time_wib !== '—') {
            hitSubtext = '<div class="tr-subtext-line font-mono tr-subtext-center">' +
                '<span class="tr-subtext-bolt">⚡</span><span>' + escapeHtml(s.hit_time_wib) + '</span>' +
                (s.price_at_hit ? '<span class="tr-subtext-sep">·</span><span class="tr-subtext-val font-medium">' + formatRp(s.price_at_hit) + '</span>' : '') +
                '</div>';
        }

        // 1. Desktop table row
        rowsHtml += '<tr class="tr-row">' +
            '<td class="tr-col-ticker font-bold">' +
                '<div class="tr-ticker-group">' +
                    '<span>' + escapeHtml(s.ticker) + '</span>' +
                    (s.score ? '<span class="tr-score-chip font-mono">' + escapeHtml(s.score) + '</span>' : '') +
                '</div>' +
            '</td>' +
            '<td class="tr-col-source whitespace-nowrap">' +
                '<span class="tr-source-chip">' + escapeHtml(s.source_short || s.source_label) + '</span>' +
            '</td>' +
            '<td class="tr-col-date whitespace-nowrap font-mono">' +
                '<div class="tr-date-main">' + escapeHtml(s.date || '—') + '</div>' +
                signalSubtext +
            '</td>' +
            '<td class="text-right font-mono tabular-nums">' + entryText + '</td>' +
            '<td class="text-right font-mono tabular-nums ac-num-positive font-medium">' + formatRp(s.tp1) + '</td>' +
            '<td class="text-right font-mono tabular-nums ac-num-positive">' + formatRp(s.tp2) + '</td>' +
            '<td class="text-right font-mono tabular-nums ac-num-negative">' + formatRp(s.sl) + '</td>' +
            '<td class="text-center whitespace-nowrap">' +
                '<span class="tr-status-pill ' + statusClass + (isExpiredSignal ? ' cursor-help' : '') + '"' + statusTooltip + '>' +
                    escapeHtml(statusLabelText) + infoIcon +
                '</span>' +
                hitSubtext +
            '</td>' +
            '<td class="text-right font-mono tabular-nums">' + gainHtml + '</td>' +
            '<td class="text-right font-mono tabular-nums tr-col-duration">' + escapeHtml(s.duration_text || '—') + '</td>' +
        '</tr>';

        // 2. Mobile card row
        mobileHtml += '<div class="tr-mobile-card">' +
            '<div class="tr-mobile-card-top">' +
                '<div class="tr-mobile-ticker-group">' +
                    '<span class="tr-mobile-ticker font-bold">' + escapeHtml(s.ticker) + '</span>' +
                    '<span class="tr-source-chip">' + escapeHtml(s.source_short || s.source_label) + '</span>' +
                    (s.score ? '<span class="tr-score-chip font-mono">' + escapeHtml(s.score) + '</span>' : '') +
                '</div>' +
                '<div class="tr-mobile-gain-group">' +
                    '<span class="tr-status-pill ' + statusClass + '">' + escapeHtml(statusLabelText) + '</span>' +
                '</div>' +
            '</div>' +
            '<div class="tr-mobile-grid font-mono tabular-nums">' +
                '<div class="tr-mobile-stat"><span class="tr-stat-lbl">Area Beli</span><span class="tr-stat-val">' + entryText + '</span></div>' +
                '<div class="tr-mobile-stat"><span class="tr-stat-lbl">Target (TP1/TP2)</span><span class="tr-stat-val ac-num-positive">' + formatRp(s.tp1) + ' / ' + formatRp(s.tp2) + '</span></div>' +
                '<div class="tr-mobile-stat"><span class="tr-stat-lbl">Stop Loss</span><span class="tr-stat-val ac-num-negative">' + formatRp(s.sl) + '</span></div>' +
                '<div class="tr-mobile-stat"><span class="tr-stat-lbl">Hasil Gain</span><span class="tr-stat-val font-bold ' + gainClass + '">' + (s.gain_pct != null ? ((s.gain_pct > 0 ? '+' : '') + s.gain_pct.toFixed(1) + '%') : '—') + '</span></div>' +
            '</div>' +
            '<div class="tr-mobile-footer">' +
                '<span>📅 ' + escapeHtml(s.date || '—') + (s.signal_time_wib ? ' ' + escapeHtml(s.signal_time_wib) : '') + '</span>' +
                '<span>⏱️ ' + escapeHtml(s.duration_text || '—') + '</span>' +
            '</div>' +
        '</div>';
    });

    tbody.innerHTML = rowsHtml;
    if (mobileHost) {
        mobileHost.innerHTML = mobileHtml;
    }
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
    var rows = [TRACK_RECORD_CSV_HEADERS.slice()];
    (signals || []).forEach(function(s) {
        rows.push(formatTrackRecordCsvRow(s));
    });
    return rows.map(function(r) {
        return r.map(escapeCsvCell).join(',');
    }).join('\r\n');
}

function exportTrackRecordCsv() {
    if (!_trData || !Array.isArray(_trData.signals) || !_trData.signals.length) {
        if (typeof showToast === 'function') {
            showToast('Tidak ada data track record untuk diunduh.', 'warning');
        }
        return;
    }

    var csvContent = generateTrackRecordCsv(_trData.signals);
    var blob = new Blob(['\uFEFF' + csvContent], { type: 'text/csv;charset=utf-8;' });
    var url = URL.createObjectURL(blob);
    var link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', getTrackRecordCsvFilename());
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    URL.revokeObjectURL(url);

    if (typeof showToast === 'function') {
        showToast('Track Record berhasil diunduh (CSV).', 'success');
    }
}

function switchTrackRecordView(viewName) {
    var isBacktest = viewName === 'backtest';
    var tabTable = document.getElementById('trViewTabTable');
    var tabBacktest = document.getElementById('trViewTabBacktest');
    var panelTable = document.getElementById('trTableViewPanel');
    var panelBacktest = document.getElementById('trBacktestViewPanel');

    if (tabTable) {
        tabTable.classList.toggle('active', !isBacktest);
    }

    if (tabBacktest) {
        tabBacktest.classList.toggle('active', isBacktest);
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
        elReturn.className = 'text-[11px] font-semibold mt-1 ' + (isProfit ? 'ac-num-positive' : 'ac-num-negative');
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
        elExp.className = 'text-xl sm:text-2xl font-black ' + (isExpPos ? 'ac-num-positive' : 'ac-num-negative');
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
