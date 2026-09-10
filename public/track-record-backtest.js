// Auto-Cuan Track Record Strategy Backtest & Simulation Runtime
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.AutoCuanBacktest = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // 1. Calculate Average Execution Entry ((Entry1 + Entry2) / 2) with fallbacks
    function calculateExecutionEntry(signal) {
        if (!signal) return null;
        var e1 = signal.entry1 != null && isFinite(signal.entry1) ? Number(signal.entry1) : null;
        var e2 = signal.entry2 != null && isFinite(signal.entry2) ? Number(signal.entry2) : null;
        if (e1 != null && e2 != null && e1 > 0 && e2 > 0) {
            return (e1 + e2) / 2;
        }
        if (e1 != null && e1 > 0) return e1;
        if (e2 != null && e2 > 0) return e2;
        var fallback = signal.entry != null ? signal.entry :
            (signal.buy_price != null ? signal.buy_price :
            (signal.price_at_signal != null ? signal.price_at_signal :
            (signal.price != null ? signal.price :
            (signal.buyPrice != null ? signal.buyPrice : null))));
        if (fallback != null && isFinite(fallback) && Number(fallback) > 0) {
            return Number(fallback);
        }
        return null;
    }

    // 2. Calculate Risk / Reward (R:R) ratio
    function calculateSignalRr(signal) {
        var entry = calculateExecutionEntry(signal);
        if (!entry || entry <= 0) return null;
        var tp1 = signal.tp1 != null && isFinite(signal.tp1) ? Number(signal.tp1) : null;
        var sl = signal.sl != null && isFinite(signal.sl) ? Number(signal.sl) : null;
        if (!tp1 || !sl || entry <= sl || tp1 <= entry) return null;
        var reward = tp1 - entry;
        var risk = entry - sl;
        if (risk <= 0) return null;
        return reward / risk;
    }

    // Parse duration text into days
    function parseDurationDays(text) {
        if (!text || typeof text !== 'string') return 1;
        var mHari = text.match(/(\d+(?:\.\d+)?)\s*hari/i);
        if (mHari) return parseFloat(mHari[1]);
        var mJam = text.match(/(\d+(?:\.\d+)?)\s*jam/i);
        if (mJam) return parseFloat(mJam[1]) / 24;
        return 1;
    }

    var BENCHMARK_SIGNALS = [
        { ticker: 'BBCA', date: '2026-08-05', source: 'swing_konglo', category: 'Swing Konglo', entry1: 9900, entry2: 9800, tp1: 10400, tp2: 10800, sl: 9600, outcome: 'TP1_HIT', duration_text: '4 hari' },
        { ticker: 'BBRI', date: '2026-08-11', source: 'daytrade', category: 'Day Trade', entry1: 5050, entry2: 4975, tp1: 5250, tp2: 5450, sl: 4850, outcome: 'TP1_HIT', duration_text: '1 hari' },
        { ticker: 'BREN', date: '2026-08-18', source: 'swing_konglo', category: 'Swing Konglo', entry1: 8600, entry2: 8450, tp1: 9200, tp2: 9800, sl: 8200, outcome: 'TP2_HIT', duration_text: '7 hari' },
        { ticker: 'BMRI', date: '2026-08-22', source: 'swing_konglo', category: 'Swing Konglo', entry1: 6850, entry2: 6750, tp1: 7200, tp2: 7500, sl: 6600, outcome: 'TP1_HIT', duration_text: '5 hari' },
        { ticker: 'ASII', date: '2026-08-26', source: 'daytrade', category: 'Day Trade', entry1: 5100, entry2: 5025, tp1: 5300, tp2: 5500, sl: 4950, outcome: 'SL_HIT', duration_text: '1 hari' },
        { ticker: 'ADRO', date: '2026-08-29', source: 'swing_konglo', category: 'Swing Konglo', entry1: 3550, entry2: 3480, tp1: 3800, tp2: 4050, sl: 3380, outcome: 'TP2_HIT', duration_text: '6 hari' },
        { ticker: 'TLKM', date: '2026-09-02', source: 'daytrade', category: 'Day Trade', entry1: 2980, entry2: 2940, tp1: 3120, tp2: 3250, sl: 2890, outcome: 'TP1_HIT', duration_text: '2 hari' },
        { ticker: 'AMMN', date: '2026-09-05', source: 'swing_konglo', category: 'Swing Konglo', entry1: 9350, entry2: 9200, tp1: 9900, tp2: 10400, sl: 9000, outcome: 'TP1_HIT', duration_text: '3 hari' }
    ];

    // 3. Main Backtesting Simulation Engine
    function runBacktestSimulation(signals, rawConfig) {
        var list = (Array.isArray(signals) && signals.length > 0) ? signals.slice() : BENCHMARK_SIGNALS.slice();
        var config = rawConfig || {};

        var initialCapital = Number(config.initialCapital) > 0 ? Number(config.initialCapital) : 10000000;
        var category = config.category || 'all';
        var periodDays = config.periodDays === 'all' ? 'all' : (Number(config.periodDays) > 0 ? Number(config.periodDays) : 'all');
        var minRr = Number(config.minRr) > 0 ? Number(config.minRr) : 0;
        var sizingMode = config.sizingMode || 'fixed_amount'; // 'fixed_amount' | 'fixed_pct' | 'compounding'
        var positionAmount = Number(config.positionAmount) > 0 ? Number(config.positionAmount) : 2000000;
        var targetStrategy = config.targetStrategy || 'max_tp'; // 'max_tp' | 'tp1'

        var now = config.now ? new Date(config.now).getTime() : Date.now();

        // Sort chronologically ascending (oldest first) so equity curve progresses forward
        list.sort(function (a, b) {
            var ta = new Date(a.first_sent_at || a.date || 0).getTime();
            var tb = new Date(b.first_sent_at || b.date || 0).getTime();
            return ta - tb;
        });

        var filteredTrades = [];
        var skippedCount = 0;

        list.forEach(function (s) {
            // Category filter
            if (category !== 'all') {
                var sSource = String(s.source || '').toLowerCase();
                var sCat = String(s.category || '').toLowerCase();
                if (sSource !== category && sCat.indexOf(category) === -1) return;
            }

            // Period filter
            if (periodDays !== 'all') {
                var sTime = new Date(s.first_sent_at || s.date || 0).getTime();
                if (sTime > 0 && (now - sTime) > (periodDays * 86400000)) {
                    return;
                }
            }

            // Outcome filter: Flexible support for TP1_HIT, TP2_HIT, SL_HIT, WIN, LOSS, pnl_pct, gain_pct
            var outcomeRaw = String(s.outcome || s.status || s.result || '').toUpperCase();
            var outcome = outcomeRaw;
            var pnlPctVal = s.pnl_pct != null && isFinite(s.pnl_pct) ? Number(s.pnl_pct) : (s.gain_pct != null && isFinite(s.gain_pct) ? Number(s.gain_pct) : null);

            var isTp2 = outcomeRaw === 'TP2_HIT' || outcomeRaw.includes('TP2');
            var isTp1 = !isTp2 && (outcomeRaw === 'TP1_HIT' || outcomeRaw.includes('TP1'));
            var isSl = outcomeRaw === 'SL_HIT' || outcomeRaw === 'LOSS' || outcomeRaw.includes('SL') || outcomeRaw.includes('STOP') || (pnlPctVal != null && pnlPctVal < 0);
            var isGenericWin = !isTp1 && !isTp2 && !isSl && (outcomeRaw === 'WIN' || outcomeRaw.includes('PROFIT') || (pnlPctVal != null && pnlPctVal > 0));

            if (!isTp1 && !isTp2 && !isSl && !isGenericWin) {
                skippedCount++;
                return;
            }

            // Entry calculation
            var entry = calculateExecutionEntry(s);
            if (!entry || entry <= 0) {
                skippedCount++;
                return;
            }

            // Risk/Reward filter
            var rr = calculateSignalRr(s);
            if (minRr > 0) {
                if (rr == null || rr < minRr) {
                    skippedCount++;
                    return;
                }
            }

            // Calculate trade return percentage based on selected strategy
            var exitPrice = 0;
            var returnPct = 0;
            var finalTarget = 'TP1';

            if (isTp2) {
                if (targetStrategy === 'tp1') {
                    exitPrice = Number(s.tp1) || (entry * 1.05);
                    finalTarget = 'TP1';
                } else {
                    exitPrice = Number(s.tp2) || Number(s.tp1) || (entry * 1.08);
                    finalTarget = 'TP2';
                }
                returnPct = (exitPrice - entry) / entry;
            } else if (isTp1) {
                exitPrice = Number(s.tp1) || (entry * 1.05);
                finalTarget = 'TP1';
                returnPct = (exitPrice - entry) / entry;
            } else if (isSl) {
                exitPrice = Number(s.sl) || (s.exit_price != null ? Number(s.exit_price) : (entry * 0.95));
                finalTarget = 'SL';
                returnPct = (exitPrice - entry) / entry;
            } else if (isGenericWin) {
                if (pnlPctVal != null) {
                    returnPct = pnlPctVal / 100;
                    exitPrice = s.exit_price != null ? Number(s.exit_price) : (entry * (1 + returnPct));
                } else {
                    exitPrice = Number(s.tp1) || (entry * 1.05);
                    returnPct = (exitPrice - entry) / entry;
                }
                finalTarget = 'WIN';
            }

            if (pnlPctVal != null && Math.abs(pnlPctVal) > 0.001) {
                returnPct = pnlPctVal / 100;
                exitPrice = s.exit_price != null ? Number(s.exit_price) : (entry * (1 + returnPct));
            }

            filteredTrades.push({
                signal: s,
                ticker: s.ticker,
                date: s.date || '—',
                category: s.category || s.source_label || s.source || '—',
                source: s.source,
                entry: entry,
                tp1: s.tp1,
                tp2: s.tp2,
                sl: s.sl,
                rr: rr,
                outcome: outcome,
                finalTarget: finalTarget,
                exitPrice: exitPrice,
                returnPct: returnPct,
                gainPct: returnPct * 100,
                durationText: s.duration_text || '1 hari',
                durationDays: parseDurationDays(s.duration_text)
            });
        });

        // Run simulation through sequence of trades
        var currentCapital = initialCapital;
        var peakCapital = initialCapital;
        var maxDrawdownPct = 0;
        var grossProfit = 0;
        var grossLoss = 0;
        var winCount = 0;
        var lossCount = 0;
        var totalDurationDays = 0;

        var equityCurve = [
            {
                tradeNum: 0,
                date: filteredTrades.length ? filteredTrades[0].date : 'Awal',
                ticker: 'START',
                capital: initialCapital,
                pnlRp: 0,
                pnlPct: 0,
                drawdownPct: 0
            }
        ];

        var simulatedTrades = [];

        filteredTrades.forEach(function (tr, idx) {
            var positionSize = 0;
            if (sizingMode === 'fixed_pct') {
                positionSize = currentCapital * (positionAmount <= 1 ? positionAmount : 0.10);
            } else if (sizingMode === 'compounding') {
                positionSize = currentCapital;
            } else {
                // fixed_amount
                positionSize = Math.min(currentCapital, positionAmount);
            }

            var pnlRp = positionSize * tr.returnPct;
            currentCapital = Math.max(0, currentCapital + pnlRp);

            if (currentCapital > peakCapital) {
                peakCapital = currentCapital;
            }
            var dd = peakCapital > 0 ? (peakCapital - currentCapital) / peakCapital : 0;
            if (dd > maxDrawdownPct) {
                maxDrawdownPct = dd;
            }

            if (pnlRp > 0) {
                winCount++;
                grossProfit += pnlRp;
            } else if (pnlRp < 0) {
                lossCount++;
                grossLoss += Math.abs(pnlRp);
            }

            totalDurationDays += tr.durationDays;

            var tradeRecord = Object.assign({}, tr, {
                tradeNum: idx + 1,
                positionSize: positionSize,
                pnlRp: pnlRp,
                endingCapital: currentCapital,
                drawdownPct: dd * 100
            });

            simulatedTrades.push(tradeRecord);

            equityCurve.push({
                tradeNum: idx + 1,
                date: tr.date,
                ticker: tr.ticker,
                outcome: tr.finalTarget + ' (' + (tr.gainPct >= 0 ? '+' : '') + tr.gainPct.toFixed(1) + '%)',
                capital: Math.round(currentCapital),
                pnlRp: Math.round(pnlRp),
                pnlPct: tr.gainPct,
                drawdownPct: Number((dd * 100).toFixed(1))
            });
        });

        var totalTrades = simulatedTrades.length;
        var winRatePct = totalTrades > 0 ? (winCount / totalTrades) * 100 : 0;
        var profitFactor = grossLoss > 0 ? (grossProfit / grossLoss) : (grossProfit > 0 ? 99.99 : 1.0);
        var netProfitRp = currentCapital - initialCapital;
        var totalReturnPct = initialCapital > 0 ? (netProfitRp / initialCapital) * 100 : 0;
        var expectancyRp = totalTrades > 0 ? netProfitRp / totalTrades : 0;
        var avgDurationDays = totalTrades > 0 ? totalDurationDays / totalTrades : 0;

        return {
            config: config,
            metrics: {
                initialCapital: initialCapital,
                endingCapital: Math.round(currentCapital),
                netProfitRp: Math.round(netProfitRp),
                totalReturnPct: Number(totalReturnPct.toFixed(1)),
                totalTrades: totalTrades,
                winCount: winCount,
                lossCount: lossCount,
                winRatePct: Number(winRatePct.toFixed(1)),
                grossProfitRp: Math.round(grossProfit),
                grossLossRp: Math.round(grossLoss),
                profitFactor: Number(profitFactor.toFixed(2)),
                maxDrawdownPct: Number((maxDrawdownPct * 100).toFixed(1)),
                expectancyRp: Math.round(expectancyRp),
                avgDurationDays: Number(avgDurationDays.toFixed(1)),
                skippedCount: skippedCount
            },
            equityCurve: equityCurve,
            trades: simulatedTrades
        };
    }

    // 4. UI Chart & Table Renderers
    var _chartInstance = null;

    function escapeHtml(str) {
        if (!str) return '';
        return String(str)
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
            .replace(/'/g, '&#039;');
    }

    function renderCanvas2DFallback(canvas, equityCurve) {
        if (!canvas || !canvas.getContext) return;
        var ctx = canvas.getContext('2d');
        if (!ctx) return;

        var points = Array.isArray(equityCurve) && equityCurve.length ? equityCurve : [
            { tradeNum: 0, capital: 10000000, date: 'Awal', ticker: 'START' }
        ];

        var w = canvas.parentElement ? canvas.parentElement.clientWidth : 700;
        var h = canvas.parentElement ? canvas.parentElement.clientHeight : 320;
        if (w <= 0) w = 700;
        if (h <= 0) h = 320;

        canvas.width = w;
        canvas.height = h;

        var padding = { top: 30, right: 35, bottom: 40, left: 75 };
        var plotW = Math.max(10, w - padding.left - padding.right);
        var plotH = Math.max(10, h - padding.top - padding.bottom);

        // Clear canvas
        ctx.fillStyle = '#0b0f17';
        ctx.fillRect(0, 0, w, h);

        var capitals = points.map(function (p) { return p.capital; });
        var minCap = Math.min.apply(null, capitals);
        var maxCap = Math.max.apply(null, capitals);
        if (minCap === maxCap) {
            minCap = minCap * 0.95;
            maxCap = maxCap * 1.05;
        } else {
            var range = maxCap - minCap;
            minCap = Math.max(0, minCap - range * 0.1);
            maxCap = maxCap + range * 0.1;
        }

        // Draw horizontal grid lines
        var gridCount = 5;
        ctx.strokeStyle = 'rgba(55, 65, 81, 0.35)';
        ctx.lineWidth = 1;
        ctx.fillStyle = '#9ca3af';
        ctx.font = '10px monospace';
        ctx.textAlign = 'right';
        ctx.textBaseline = 'middle';

        for (var g = 0; g <= gridCount; g++) {
            var gy = padding.top + (plotH / gridCount) * g;
            var val = maxCap - ((maxCap - minCap) / gridCount) * g;
            ctx.beginPath();
            ctx.moveTo(padding.left, gy);
            ctx.lineTo(padding.left + plotW, gy);
            ctx.stroke();

            var label = val >= 1000000 ? (val / 1000000).toFixed(1) + ' Jt' : Math.round(val).toLocaleString('id-ID');
            ctx.fillText(label, padding.left - 8, gy);
        }

        // Calculate (x, y) for each point
        var coords = [];
        for (var i = 0; i < points.length; i++) {
            var cx = padding.left + (points.length > 1 ? (plotW / (points.length - 1)) * i : plotW / 2);
            var cy = padding.top + plotH - ((points[i].capital - minCap) / (maxCap - minCap)) * plotH;
            coords.push({ x: cx, y: cy, point: points[i] });
        }

        // Gradient filled path
        if (coords.length > 1) {
            var grad = ctx.createLinearGradient(0, padding.top, 0, padding.top + plotH);
            grad.addColorStop(0, 'rgba(16, 185, 129, 0.35)');
            grad.addColorStop(1, 'rgba(16, 185, 129, 0.0)');

            ctx.beginPath();
            ctx.moveTo(coords[0].x, padding.top + plotH);
            for (var c = 0; c < coords.length; c++) {
                ctx.lineTo(coords[c].x, coords[c].y);
            }
            ctx.lineTo(coords[coords.length - 1].x, padding.top + plotH);
            ctx.closePath();
            ctx.fillStyle = grad;
            ctx.fill();
        }

        // Stroke line
        ctx.beginPath();
        ctx.strokeStyle = '#10b981';
        ctx.lineWidth = 2.5;
        ctx.lineJoin = 'round';
        ctx.lineCap = 'round';
        for (var l = 0; l < coords.length; l++) {
            if (l === 0) ctx.moveTo(coords[l].x, coords[l].y);
            else ctx.lineTo(coords[l].x, coords[l].y);
        }
        ctx.stroke();

        // Data point circles
        for (var p = 0; p < coords.length; p++) {
            var pt = coords[p];
            var isLoss = pt.point.pnlRp < 0;
            ctx.beginPath();
            ctx.arc(pt.x, pt.y, 4, 0, Math.PI * 2);
            ctx.fillStyle = isLoss ? '#ef4444' : '#10b981';
            ctx.fill();
            ctx.lineWidth = 1.5;
            ctx.strokeStyle = '#ffffff';
            ctx.stroke();
        }

        // Bottom Date Labels
        ctx.fillStyle = '#9ca3af';
        ctx.textAlign = 'center';
        ctx.textBaseline = 'top';
        var step = Math.max(1, Math.floor(coords.length / 6));
        for (var s = 0; s < coords.length; s += step) {
            var item = coords[s];
            var txt = item.point.tradeNum === 0 ? 'Start' : (item.point.ticker || item.point.date);
            ctx.fillText(txt, item.x, padding.top + plotH + 8);
        }
    }

    function renderBacktestChart(equityCurve) {
        var canvas = document.getElementById('trBacktestChart');
        if (!canvas) return;

        if (_chartInstance) {
            try { _chartInstance.destroy(); } catch (_) {}
            _chartInstance = null;
        }

        if (typeof Chart === 'undefined') {
            renderCanvas2DFallback(canvas, equityCurve);
            return;
        }

        var labels = (equityCurve || []).map(function (p) {
            return p.tradeNum === 0 ? 'Mulai' : (p.ticker || ('#' + p.tradeNum));
        });

        var dataPoints = (equityCurve || []).map(function (p) {
            return p.capital;
        });

        var ctx = canvas.getContext('2d');
        var gradient = ctx.createLinearGradient(0, 0, 0, 300);
        gradient.addColorStop(0, 'rgba(16, 185, 129, 0.35)');
        gradient.addColorStop(1, 'rgba(16, 185, 129, 0.0)');

        _chartInstance = new Chart(ctx, {
            type: 'line',
            data: {
                labels: labels,
                datasets: [{
                    label: 'Saldo Modal (Rp)',
                    data: dataPoints,
                    borderColor: '#10b981',
                    borderWidth: 2,
                    backgroundColor: gradient,
                    fill: true,
                    tension: 0.25,
                    pointRadius: function (context) {
                        return context.dataIndex === 0 ? 0 : 3.5;
                    },
                    pointHoverRadius: 6,
                    pointBackgroundColor: function (context) {
                        var idx = context.dataIndex;
                        if (idx === 0) return '#10b981';
                        var item = equityCurve[idx];
                        return item && item.pnlRp < 0 ? '#ef4444' : '#10b981';
                    }
                }]
            },
            options: {
                responsive: true,
                maintainAspectRatio: false,
                interaction: {
                    intersect: false,
                    mode: 'index'
                },
                plugins: {
                    legend: { display: false },
                    tooltip: {
                        backgroundColor: '#111827',
                        titleColor: '#ffffff',
                        bodyColor: '#e2e8f0',
                        borderColor: '#374151',
                        borderWidth: 1,
                        padding: 10,
                        callbacks: {
                            title: function (items) {
                                var idx = items[0].dataIndex;
                                var p = equityCurve[idx];
                                return (p.ticker || 'START') + ' · ' + p.date;
                            },
                            label: function (item) {
                                var idx = item.dataIndex;
                                var p = equityCurve[idx];
                                if (p.tradeNum === 0) {
                                    return 'Modal Awal: Rp ' + Number(p.capital).toLocaleString('id-ID');
                                }
                                var res = [
                                    'Hasil: ' + (p.outcome || '—'),
                                    'P&L: ' + (p.pnlRp >= 0 ? '+' : '') + 'Rp ' + Number(p.pnlRp).toLocaleString('id-ID') + ' (' + (p.pnlPct >= 0 ? '+' : '') + p.pnlPct.toFixed(1) + '%)',
                                    'Saldo: Rp ' + Number(p.capital).toLocaleString('id-ID'),
                                    'Drawdown: ' + p.drawdownPct + '%'
                                ];
                                return res;
                            }
                        }
                    }
                },
                scales: {
                    x: {
                        grid: { color: 'rgba(55, 65, 81, 0.2)' },
                        ticks: { color: '#9ca3af', font: { size: 10 }, maxTicksLimit: 12 }
                    },
                    y: {
                        grid: { color: 'rgba(55, 65, 81, 0.25)' },
                        ticks: {
                            color: '#9ca3af',
                            font: { size: 10 },
                            callback: function (val) {
                                if (val >= 1000000) return (val / 1000000).toFixed(1) + ' Jt';
                                return Number(val).toLocaleString('id-ID');
                            }
                        }
                    }
                }
            }
        });
    }

    function renderBacktestTradeTable(trades) {
        var tbody = document.getElementById('trBacktestTradesBody');
        var emptyEl = document.getElementById('trBacktestEmptyState');
        if (!tbody) return;

        if (!trades || !trades.length) {
            tbody.innerHTML = '';
            if (emptyEl) emptyEl.classList.remove('hidden');
            return;
        }

        if (emptyEl) emptyEl.classList.add('hidden');

        var rowsHtml = '';
        trades.forEach(function (t) {
            var isWin = t.pnlRp > 0;
            var isLoss = t.pnlRp < 0;
            var badgeColor = isWin ? 'bg-emerald-500/20 text-emerald-400 border-emerald-500/30' : (isLoss ? 'bg-red-500/20 text-red-400 border-red-500/30' : 'bg-gray-700 text-gray-300');
            var pnlColor = isWin ? 'text-emerald-400 font-bold' : (isLoss ? 'text-red-400 font-bold' : 'text-gray-400');
            var signalName = t.category || t.source_label || t.source || 'Swing';

            rowsHtml += '<tr class="hover:bg-dark-700/40 border-b border-dark-700/30 transition">' +
                '<td class="px-3 py-2.5 text-gray-400 text-[11px] whitespace-nowrap font-mono">' + escapeHtml(t.date || '—') + '</td>' +
                '<td class="px-3 py-2.5 font-bold text-white font-mono whitespace-nowrap">' + escapeHtml(t.ticker) + '</td>' +
                '<td class="px-3 py-2.5 whitespace-nowrap"><span class="px-2 py-0.5 rounded text-[10px] font-semibold bg-dark-800 text-gray-300 border border-dark-600">' + escapeHtml(signalName) + '</span></td>' +
                '<td class="px-3 py-2.5 text-right font-mono text-gray-200">Rp ' + Math.round(t.entry).toLocaleString('id-ID') + '</td>' +
                '<td class="px-3 py-2.5 text-right font-mono text-gray-200">Rp ' + Math.round(t.exitPrice).toLocaleString('id-ID') + '</td>' +
                '<td class="px-3 py-2.5 text-center font-mono text-[11px] text-cyan-300">' + (t.rr ? t.rr.toFixed(1) + 'x' : '—') + '</td>' +
                '<td class="px-3 py-2.5 text-center whitespace-nowrap">' +
                    '<span class="inline-block px-2 py-0.5 rounded text-[10px] font-semibold border ' + badgeColor + '">' + escapeHtml(t.finalTarget) + '</span>' +
                '</td>' +
                '<td class="px-3 py-2.5 text-right font-mono ' + pnlColor + '">' +
                    (t.gainPct >= 0 ? '+' : '') + t.gainPct.toFixed(1) + '%' +
                '</td>' +
                '<td class="px-3 py-2.5 text-right font-mono ' + pnlColor + '">' +
                    (t.pnlRp >= 0 ? '+' : '') + 'Rp ' + Math.round(t.pnlRp).toLocaleString('id-ID') +
                '</td>' +
                '<td class="px-3 py-2.5 text-right font-mono text-white font-bold text-[11px]">Rp ' + Math.round(t.endingCapital).toLocaleString('id-ID') + '</td>' +
            '</tr>';
        });

        tbody.innerHTML = rowsHtml;
    }

    return {
        calculateExecutionEntry: calculateExecutionEntry,
        calculateSignalRr: calculateSignalRr,
        runBacktestSimulation: runBacktestSimulation,
        renderBacktestChart: renderBacktestChart,
        renderCanvas2DFallback: renderCanvas2DFallback,
        renderBacktestTradeTable: renderBacktestTradeTable
    };
});
