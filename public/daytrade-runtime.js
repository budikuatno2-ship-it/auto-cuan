// Auto-Cuan Day Trade UI/runtime kept separate from cacheable market/chart bundle.
// ============================================================
// DAY TRADE SCREENER — JavaScript Functions
// ============================================================
var _dtScreenerCache = null;
var _dtScreenerFilter = 'all';
var _dtPollInterval = null;
var DAYTRADE_LATEST_EMPTY_TEXT = 'Snapshot Day Trade belum tersedia / latest table kosong. Coba refresh saat scan selesai.';
var DAYTRADE_WATCH_STATUSES = ['WATCH_PULLBACK', 'WAIT_PULLBACK', 'RECLAIM_CANDIDATE', 'MOMENTUM_CONTINUATION', 'SPECULATIVE'];
function isDayTradeWatchStatus(status) { return DAYTRADE_WATCH_STATUSES.indexOf(status) >= 0; }
function getDayTradeEmptyMessage(data) { return data && data.latest_rows_empty ? DAYTRADE_LATEST_EMPTY_TEXT : DAYTRADE_EMPTY_TEXT; }

async function loadDayTradeScreener() {
    if (_dtScreenerInFlight) return _dtScreenerInFlight;
    var tbody = document.getElementById('dtScreenerTableBody');
    if (!tbody) return;

    // Perceived-speed fix: dtCardGrid is the visible UI, not the table tbody. Render cached
    // cards immediately (with a subtle refreshing banner) so the grid never looks blank/stuck.
    // If no cache exists yet, show skeleton cards instead of nothing. Day Trade in particular
    // was reported as feeling slow/blank because this scan can take longer than the other two.
    var dtCardEl = document.getElementById('dtCardGrid');
    if (dtCardEl) {
        if (_dtScreenerCache && _dtScreenerCache.results && _dtScreenerCache.results.length) {
            renderDtCardGrid(_dtScreenerCache.results, _dtScreenerCache);
            dtCardEl.insertAdjacentHTML('afterbegin', screenerRefreshingBannerHtml());
        } else {
            dtCardEl.innerHTML = screenerSkeletonCardHtml(4);
        }
    }
    // Table tbody loading stays as secondary/fallback (table view is hidden by default).
    tbody.innerHTML = typeof screenerSkeletonTableRowsHtml === 'function' ? screenerSkeletonTableRowsHtml(22, 5) : '<tr><td colspan="22" class="text-center py-8 text-gray-400">Memuat radar day trade...</td></tr>';

    _dtScreenerInFlight = (async function() {
    try {
        var response = await fetch('/api/sector-hot?action=daytrade-screener');
        var data = await response.json();

        if (!data.success) {
            tbody.innerHTML = screenerEmptyRowHtml(22, DASHBOARD_ERROR_TEXT, 'error', 'loadDayTradeScreener()');
            var dtCardElEmptyErr = document.getElementById('dtCardGrid');
            if (dtCardElEmptyErr) {
                if (_dtScreenerCache && _dtScreenerCache.results && _dtScreenerCache.results.length) {
                    renderDtCardGrid(_dtScreenerCache.results, _dtScreenerCache);
                } else {
                    dtCardElEmptyErr.innerHTML = screenerEmptyCardHtml(DASHBOARD_ERROR_TEXT);
                }
            }
            return;
        }

        _dtScreenerCache = data;

        // Update meta
        var meta = data.meta || {};
        var badge = document.getElementById('dtMetaBadge');
        if (badge) {
            var ts = meta.calculated_at ? new Date(meta.calculated_at).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' }) : '—';
            badge.textContent = ((meta.source === 'latest_completed_snapshot' || meta.status === 'latest_completed_snapshot') ? 'Latest Completed Snapshot' : (meta.freshness_label || meta.snapshot_label || meta.status || 'pending')) + ' · ' + ts;
            // V2 Freshness label: warn if Day Trade data is not from today
            if (meta.calculated_at && meta.status !== 'scanning') {
                var dtCalcDate = new Date(meta.calculated_at);
                var dtNowWib = new Date(Date.now() + 7 * 60 * 60 * 1000);
                var dtCalcDateStr = dtCalcDate.toISOString().slice(0, 10);
                var dtTodayStr = dtNowWib.toISOString().slice(0, 10);
                var dtYesterdayStr = new Date(dtNowWib.getTime() - 86400000).toISOString().slice(0, 10);
                if (dtCalcDateStr !== dtTodayStr && dtCalcDateStr !== dtYesterdayStr) {
                    badge.textContent = '\u26A0 STALE \u00b7 Data day trade sudah lama (' + dtCalcDateStr + '). Refresh wajib sebelum entry. \u00b7 ' + ts;
                    badge.style.color = '#f59e0b';
                }
            }
        }

        var statU = document.getElementById('dtStatUniverse');
        var statS = document.getElementById('dtStatScanned');
        var statP = document.getElementById('dtStatPublished');
        var statM = document.getElementById('dtStatRunMode');
        if (statU) statU.textContent = meta.universe_count || '—';
        if (statS) statS.textContent = meta.scanned_count || '—';
        if (statP) statP.textContent = meta.published_count || (data.results ? data.results.length : '—');
        if (statM) statM.textContent = meta.run_mode || '—';

        // Handle scanning state — show progress and start polling
        if (meta.status === 'scanning') {
            showDtProgress(meta);
            startDtPolling();
        } else {
            hideDtProgress();
            stopDtPolling();
        }

        renderDtTable(data.results || [], data);
        renderDtCardGrid(data.results || [], data);
    } catch (e) {
        tbody.innerHTML = screenerEmptyRowHtml(22, DASHBOARD_ERROR_TEXT, 'error', 'loadDayTradeScreener()');
        // Card grid: keep showing cached cards on a failed background refresh (just drop the
        // banner); only replace with an error state if there is no cache to fall back to.
        var dtCardElErr = document.getElementById('dtCardGrid');
        if (dtCardElErr) {
            if (_dtScreenerCache && _dtScreenerCache.results && _dtScreenerCache.results.length) {
                renderDtCardGrid(_dtScreenerCache.results);
            } else {
                dtCardElErr.innerHTML = screenerEmptyCardHtml(DASHBOARD_ERROR_TEXT);
            }
        }
    } finally { _dtScreenerInFlight = null; }
    })();
    return _dtScreenerInFlight;
}

function showDtProgress(meta) {
    var wrap = document.getElementById('dtProgressWrap');
    if (wrap) wrap.classList.remove('hidden');

    var universe = meta.universe_count || 0;
    var scanned = meta.scanned_count || 0;
    var pct = universe > 0 ? Math.round(scanned / universe * 100) : 0;

    var bar = document.getElementById('dtProgressBar');
    var label = document.getElementById('dtProgressLabel');
    var msg = document.getElementById('dtProgressMsg');
    var batch = document.getElementById('dtProgressBatch');
    var passed = document.getElementById('dtProgressPassed');
    var failed = document.getElementById('dtProgressFailed');

    if (bar) bar.style.width = pct + '%';
    if (label) label.textContent = scanned + ' / ' + universe + ' (' + pct + '%)';
    if (msg) msg.textContent = meta.message || 'Scanning…';
    if (batch) batch.textContent = '';
    if (passed) passed.textContent = meta.passed_count || 0;
    if (failed) failed.textContent = meta.failed_count || 0;
}

function hideDtProgress() {
    var wrap = document.getElementById('dtProgressWrap');
    if (wrap) wrap.classList.add('hidden');
}

function startDtPolling() {
    stopDtPolling();
    _dtPollInterval = setInterval(async function() {
        if (document.hidden) return;
        if (_currentScreenerType !== 'daytrade') { stopDtPolling(); return; }
        try {
            var response = await fetch('/api/sector-hot?action=daytrade-screener');
            var data = await response.json();
            if (!data.success) return;

            var meta = data.meta || {};

            // Update progress
            if (meta.status === 'scanning') {
                showDtProgress(meta);
                // Update stats
                var statS = document.getElementById('dtStatScanned');
                if (statS) statS.textContent = meta.scanned_count || '—';
            } else {
                // Scanning done — stop polling, reload full data
                hideDtProgress();
                stopDtPolling();
                _dtScreenerCache = data;
                updateDtMetaUI(meta);
                renderDtTable(data.results || [], data);
                renderDtCardGrid(data.results || [], data);
            }
        } catch (e) { /* silent retry next interval */ }
    }, 3000);
}

function stopDtPolling() {
    if (_dtPollInterval) { clearInterval(_dtPollInterval); _dtPollInterval = null; }
}

function updateDtMetaUI(meta) {
    var badge = document.getElementById('dtMetaBadge');
    if (badge) {
        var ts = meta.calculated_at ? new Date(meta.calculated_at).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' }) : '—';
        badge.textContent = ((meta.source === 'latest_completed_snapshot' || meta.status === 'latest_completed_snapshot') ? 'Latest Completed Snapshot' : (meta.freshness_label || meta.snapshot_label || meta.status || 'pending')) + ' · ' + ts;
    }
    var statU = document.getElementById('dtStatUniverse');
    var statS = document.getElementById('dtStatScanned');
    var statP = document.getElementById('dtStatPublished');
    var statM = document.getElementById('dtStatRunMode');
    if (statU) statU.textContent = meta.universe_count || '—';
    if (statS) statS.textContent = meta.scanned_count || '—';
    if (statP) statP.textContent = meta.published_count || '—';
    if (statM) statM.textContent = meta.run_mode || '—';
}

function renderDtTable(results, data) {
    var tbody = document.getElementById('dtScreenerTableBody');
    if (!tbody) return;

    // Apply filter
    var filtered = applyScreenerUiFilters('daytrade', results || []);
    if (_dtScreenerFilter && _dtScreenerFilter !== 'all') {
        if (_dtScreenerFilter === 'WATCH') {
            filtered = filtered.filter(function(r) {
                return isDayTradeWatchStatus(r.status);
            });
        } else {
            filtered = filtered.filter(function(r) { return r.status === _dtScreenerFilter; });
        }
    }

    if (filtered.length === 0) {
        tbody.innerHTML = screenerEmptyRowHtml(22, getDayTradeEmptyMessage(data));
        return;
    }

    var html = '';
    for (var i = 0; i < filtered.length; i++) {
        var r = filtered[i];
        var statusClass = getDtStatusClass(r.status);
        var chgClass = r.change_pct >= 0 ? 'text-emerald-400' : 'text-red-400';
        var volRatioStr = r.volume_ratio_20d != null ? r.volume_ratio_20d.toFixed(1) + 'x' : '—';
        var txStr = r.value_today ? formatTxValue(r.value_today) : '—';
        var entryStr = r.entry_low && r.entry_high ? r.entry_low.toLocaleString('id-ID') + '–' + r.entry_high.toLocaleString('id-ID') : '—';
        var rrStr = r.risk_reward != null ? r.risk_reward.toFixed(2) : '—';
        // V3: Confidence/Timing/Direction labels (from API or derive client-side)
        var confLabel = r.confidence || '-';
        var timingLabel = r.entry_timing || '-';
        var dirLabel = r.direction || '-';
        var confColor = confLabel === 'A+' ? 'text-emerald-300 font-bold' : (confLabel === 'A' ? 'text-emerald-400' : (confLabel === 'B' ? 'text-blue-400' : (confLabel === 'C' ? 'text-gray-400' : 'text-red-400')));
        var dirColor = dirLabel.indexOf('naik kuat') >= 0 ? 'text-emerald-400' : (dirLabel.indexOf('naik moderat') >= 0 ? 'text-blue-400' : (dirLabel.indexOf('radar') >= 0 ? 'text-violet-400' : (dirLabel.indexOf('Rawan') >= 0 ? 'text-orange-400' : 'text-red-400')));

        html += '<tr class="border-b border-dark-600/20 hover:bg-dark-700/30 transition">';
        html += '<td class="px-2 py-2 text-center text-gray-500 sticky-col-1 sticky left-0 bg-dark-800/95 z-10 w-[36px] min-w-[36px]">' + (i + 1) + '</td>';
        html += '<td class="px-2 py-2 font-medium text-white sticky-col-2 sticky left-[36px] bg-dark-800/95 z-10 min-w-[80px] border-r border-dark-600/30">' + r.ticker + '<div class="mt-0.5">' + freshnessChipHtml(r) + '</div></td>';
        html += '<td class="px-2 py-2 text-gray-400 text-[10px]">' + (r.board || '—') + '</td>';
        html += '<td class="px-2 py-2 text-center"><span class="px-1.5 py-0.5 rounded text-[10px] font-semibold ' + statusClass + '">' + escapeHtml(getStatusLabel(r, formatDtStatus(r.status))) + '</span></td>';
        html += '<td class="px-2 py-2 text-center font-bold ' + getDtScoreClass(r.daytrade_score) + '">' + r.daytrade_score + '</td>';
        html += '<td class="px-2 py-2 text-center ' + confColor + ' text-[10px]" title="' + escapeHtml((r.confidence_label || '') + ' — ' + (r.confidence_notes || '')) + '">' + confLabel + '</td>';
        html += '<td class="px-2 py-2 text-gray-300 text-[10px] max-w-[100px] truncate" title="' + (r.setup || '') + '">' + (r.setup || '—') + '</td>';
        html += '<td class="px-2 py-2 text-right text-gray-200">' + (r.last_price ? r.last_price.toLocaleString('id-ID') : '—') + '</td>';
        html += '<td class="px-2 py-2 text-right ' + chgClass + '">' + (r.change_pct != null ? r.change_pct.toFixed(2) + '%' : '—') + '</td>';
        html += '<td class="px-2 py-2 text-right text-gray-300">' + volRatioStr + '</td>';
        html += '<td class="px-2 py-2 text-right text-gray-300">' + txStr + '</td>';
        html += '<td class="px-2 py-2 text-right text-cyan-400">' + (r.prespike_score || 0) + '</td>';
        html += '<td class="px-2 py-2 text-right text-violet-400">' + (r.momentum_score || 0) + '</td>';
        html += '<td class="px-2 py-2 text-right text-gray-200 text-[10px]">' + entryStr + '</td>';
        html += '<td class="px-2 py-2 text-right text-red-400">' + (r.stop_loss ? r.stop_loss.toLocaleString('id-ID') : '—') + '</td>';
        html += '<td class="px-2 py-2 text-right text-emerald-400">' + (r.tp1 ? r.tp1.toLocaleString('id-ID') : '—') + '</td>';
        html += '<td class="px-2 py-2 text-right text-emerald-300">' + (r.tp2 ? r.tp2.toLocaleString('id-ID') : '—') + '</td>';
        html += '<td class="px-2 py-2 text-right font-medium ' + (r.risk_reward >= 2.0 ? 'text-emerald-400' : r.risk_reward >= 1.5 ? 'text-yellow-400' : 'text-red-400') + '">' + rrStr + '</td>';
        html += '<td class="px-2 py-2 text-gray-400 text-[10px] whitespace-nowrap" title="ENTRY WINDOW: ' + escapeHtml((r.entry_window_notes || '') + ' Liq: ' + (r.liquidity_label || '-') + '. ' + (r.liquidity_notes || '') + ' ' + (r.stale_notes || '')) + '">' + escapeHtml((r.entry_window_label || timingLabel || '-')) + '</td>';
        html += '<td class="px-2 py-2 ' + dirColor + ' text-[10px] whitespace-nowrap">' + dirLabel + '</td>';
        html += '<td class="px-2 py-2 text-gray-400 text-[10px] max-w-[120px] truncate" title="' + (r.time_plan || '') + '">' + (r.time_plan || '—') + '</td>';
        var _dtReason = getSignalReason(r);
        html += '<td class="px-2 py-2 text-gray-400 text-[10px] max-w-[120px] truncate" title="' + escapeHtml(_dtReason) + '">' + escapeHtml(_dtReason || '—') + '</td>';
        html += '</tr>';
    }
    tbody.innerHTML = html;
}

function filterDtScreener(filter) {
    _dtScreenerFilter = filter;
    document.querySelectorAll('.dt-screener-tab').forEach(function(btn) {
        if (btn.getAttribute('data-filter') === filter) {
            btn.className = 'dt-screener-tab active px-3 py-1.5 rounded-lg text-xs font-medium transition';
        } else {
            btn.className = 'dt-screener-tab px-3 py-1.5 rounded-lg text-xs font-medium transition';
        }
    });
    if (_dtScreenerCache && _dtScreenerCache.results) {
        renderDtTable(_dtScreenerCache.results, _dtScreenerCache);
        renderDtCardGrid(_dtScreenerCache.results, _dtScreenerCache);
    }
}

function getDtStatusClass(status) {
    switch (status) {
        case 'A_PLUS_SETUP': return 'bg-emerald-500/30 text-emerald-300 border border-emerald-400/40';
        case 'TRADE_CANDIDATE': return 'bg-emerald-500/20 text-emerald-400 border border-emerald-500/30';
        case 'READY_BREAKOUT': return 'bg-emerald-500/15 text-emerald-400 border border-emerald-500/25';
        case 'EARLY_RADAR': return 'bg-violet-500/20 text-violet-400 border border-violet-500/30';
        case 'PRE_SPIKE_WATCH': return 'bg-cyan-500/20 text-cyan-400 border border-cyan-500/30';
        case 'WAIT_PULLBACK': return 'bg-yellow-500/20 text-yellow-400 border border-yellow-500/30';
        case 'RECLAIM_CANDIDATE': return 'bg-blue-500/20 text-blue-400 border border-blue-500/30';
        case 'MOMENTUM_CONTINUATION': return 'bg-violet-500/20 text-violet-400 border border-violet-500/30';
        case 'SPECULATIVE': return 'bg-orange-500/20 text-orange-400 border border-orange-500/30';
        case 'AVOID': return 'bg-red-500/20 text-red-400 border border-red-500/30';
        default: return 'bg-gray-500/20 text-gray-400 border border-gray-500/30';
    }
}

function formatDtStatus(status) {
    switch (status) {
        case 'A_PLUS_SETUP': return 'A+ SETUP';
        case 'TRADE_CANDIDATE': return 'TRADE';
        case 'READY_BREAKOUT': return 'READY';
        case 'EARLY_RADAR': return 'RADAR';
        case 'PRE_SPIKE_WATCH': return 'PRE-SPIKE';
        case 'WAIT_PULLBACK': return 'WAIT';
        case 'RECLAIM_CANDIDATE': return 'RECLAIM';
        case 'MOMENTUM_CONTINUATION': return 'MOMENTUM';
        case 'SPECULATIVE': return 'SPEC';
        case 'AVOID': return 'AVOID';
        default: return status;
    }
}

function getDtScoreClass(score) {
    if (score >= 85) return 'text-emerald-400';
    if (score >= 75) return 'text-cyan-400';
    if (score >= 65) return 'text-yellow-400';
    return 'text-gray-400';
}

function formatTxValue(val) {
    if (!val || val === 0) return '—';
    if (val >= 1e12) return (val / 1e12).toFixed(1) + 'T';
    if (val >= 1e9) return (val / 1e9).toFixed(1) + 'B';
    if (val >= 1e6) return (val / 1e6).toFixed(0) + 'M';
    return val.toLocaleString('id-ID');
}

// ===== DAY TRADE SCREENER PDF (jsPDF autoTable) =====
function exportDayTradePDF() {
    var tbody = document.getElementById('dtScreenerTableBody');
    if (!tbody || !tbody.querySelector('tr td:not([colspan])')) {
        showToast('Belum ada data Day Trade untuk di-export.', 'warning');
        return;
    }
    _ensureJsPdf(function() {
        var jsPDF = window.jspdf.jsPDF;
        var doc = new jsPDF({ orientation: 'landscape', unit: 'mm', format: 'a4' });
        var startY = _pdfAddHeader(doc, 'Auto-Cuan Day Trade Screener', 'landscape');

        // Meta line
        var metaBadge = (document.getElementById('dtMetaBadge') || {}).textContent || '';
        doc.setFontSize(7);
        doc.setTextColor(80, 80, 80);
        var metaText = metaBadge ? metaBadge : '';
        if (_dtScreenerFilter && _dtScreenerFilter !== 'all') metaText += (metaText ? '  |  ' : '') + 'Filter: ' + _dtScreenerFilter;
        if (metaText) { doc.text(metaText, 5, startY); startY += 4; }

        // Extract table data from DOM
        var heads = [['#', 'Ticker', 'Board', 'Status', 'Setup Score', 'Setup', 'Last', 'Chg%', 'Vol/Avg', 'Tx', 'PreSpk', 'Mom', 'Entry', 'SL', 'TP1', 'TP2', 'RR', 'Time Plan', 'Catatan']];
        var body = [];
        var rows = document.querySelectorAll('#dtScreenerTableBody tr');
        rows.forEach(function(row) {
            var cells = row.querySelectorAll('td');
            if (cells.length < 17) return;
            var rowData = [];
            for (var ci = 0; ci < cells.length; ci++) {
                rowData.push((cells[ci].textContent || '').trim());
            }
            body.push(rowData);
        });

        doc.autoTable({
            startY: startY,
            head: heads,
            body: body,
            theme: 'grid',
            margin: { left: 3, right: 3 },
            styles: { fontSize: 5, cellPadding: 0.8, lineColor: [40, 50, 60], lineWidth: 0.1, textColor: [50, 50, 50], overflow: 'linebreak' },
            headStyles: { fillColor: [20, 30, 40], textColor: [180, 200, 210], fontSize: 5.5, fontStyle: 'bold', cellPadding: 1 },
            columnStyles: { 0: { cellWidth: 5 }, 5: { cellWidth: 22 }, 17: { cellWidth: 25 }, 18: { cellWidth: 25 } },
            didParseCell: function(data) {
                if (data.column.index === 3 && data.section === 'body') {
                    var val = (data.cell.raw || '').toUpperCase();
                    if (val.indexOf('READY') >= 0) data.cell.styles.textColor = [16, 185, 129];
                    else if (val.indexOf('PRE') >= 0 || val.indexOf('SPIKE') >= 0) data.cell.styles.textColor = [6, 182, 212];
                    else if (val.indexOf('WAIT') >= 0 || val.indexOf('MOMENTUM') >= 0) data.cell.styles.textColor = [245, 158, 11];
                    else if (val.indexOf('AVOID') >= 0) data.cell.styles.textColor = [239, 68, 68];
                    else data.cell.styles.textColor = [107, 114, 128];
                }
            }
        });

        _pdfAddFooter(doc, 'landscape');
        doc.save('Auto-Cuan-Day-Trade-Screener.pdf');
        showToast('PDF berhasil diunduh.', 'success');
    });
}
