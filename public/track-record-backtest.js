// Auto-Cuan Track Record Strategy Backtest & Simulation Runtime
(function (root, factory) {
    if (typeof module === 'object' && module.exports) {
        module.exports = factory();
    } else {
        root.AutoCuanBacktest = factory();
    }
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
    'use strict';

    // 1. Calculate Average Execution Entry ((Entry1 + Entry2) / 2)
    function calculateExecutionEntry(signal) {
        if (!signal) return null;
        var e1 = signal.entry1 != null && isFinite(signal.entry1) ? Number(signal.entry1) : null;
        var e2 = signal.entry2 != null && isFinite(signal.entry2) ? Number(signal.entry2) : null;
        if (e1 != null && e2 != null && e1 > 0 && e2 > 0) {
            return (e1 + e2) / 2;
        }
        if (e1 != null && e1 > 0) return e1;
        if (e2 != null && e2 > 0) return e2;
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

    // 3. Main Backtesting Simulation Engine
    function runBacktestSimulation(signals, rawConfig) {
        var list = Array.isArray(signals) ? signals.slice() : [];
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

            // Outcome filter: Only completed trades that hit TP or SL
            var outcome = String(s.outcome || '').toUpperCase();
            var isTp1 = outcome === 'TP1_HIT';
            var isTp2 = outcome === 'TP2_HIT';
            var isSl = outcome === 'SL_HIT';

            if (!isTp1 && !isTp2 && !isSl) {
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
                    exitPrice = Number(s.tp1) || entry;
                    finalTarget = 'TP1';
                } else {
                    exitPrice = Number(s.tp2) || Number(s.tp1) || entry;
                    finalTarget = 'TP2';
                }
                returnPct = (exitPrice - entry) / entry;
            } else if (isTp1) {
                exitPrice = Number(s.tp1) || entry;
                finalTarget = 'TP1';
                returnPct = (exitPrice - entry) / entry;
            } else if (isSl) {
                exitPrice = Number(s.sl) || entry;
                finalTarget = 'SL';
                returnPct = (exitPrice - entry) / entry;
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

    function renderBacktestChart(equityCurve) {
        var canvas = document.getElementById('trBacktestChart');
        if (!canvas) return;

        if (_chartInstance) {
            try { _chartInstance.destroy(); } catch (_) {}
            _chartInstance = null;
        }

        if (typeof Chart === 'undefined') return;

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

            rowsHtml += '<tr class="hover:bg-dark-700/40 transition">' +
                '<td class="px-3 py-2 text-gray-500 font-mono text-[11px]">' + t.tradeNum + '</td>' +
                '<td class="px-3 py-2 font-bold text-white whitespace-nowrap">' + t.ticker + '</td>' +
                '<td class="px-3 py-2 text-gray-400 text-[11px] whitespace-nowrap">' + t.date + '</td>' +
                '<td class="px-3 py-2 text-right font-mono text-gray-300">Rp ' + Math.round(t.entry).toLocaleString('id-ID') + '</td>' +
                '<td class="px-3 py-2 text-right font-mono text-gray-300">Rp ' + Math.round(t.exitPrice).toLocaleString('id-ID') + '</td>' +
                '<td class="px-3 py-2 text-center font-mono text-[11px] text-cyan-300">' + (t.rr ? t.rr.toFixed(1) + 'x' : '—') + '</td>' +
                '<td class="px-3 py-2 text-center whitespace-nowrap">' +
                    '<span class="inline-block px-2 py-0.5 rounded text-[10px] font-semibold border ' + badgeColor + '">' + t.finalTarget + '</span>' +
                '</td>' +
                '<td class="px-3 py-2 text-right font-mono ' + pnlColor + '">' +
                    (t.gainPct >= 0 ? '+' : '') + t.gainPct.toFixed(1) + '%' +
                    '<div class="text-[10px] opacity-80">' + (t.pnlRp >= 0 ? '+' : '') + 'Rp ' + Math.round(t.pnlRp).toLocaleString('id-ID') + '</div>' +
                '</td>' +
                '<td class="px-3 py-2 text-right font-mono text-white text-[11px]">Rp ' + Math.round(t.endingCapital).toLocaleString('id-ID') + '</td>' +
            '</tr>';
        });

        tbody.innerHTML = rowsHtml;
    }

    return {
        calculateExecutionEntry: calculateExecutionEntry,
        calculateSignalRr: calculateSignalRr,
        runBacktestSimulation: runBacktestSimulation,
        renderBacktestChart: renderBacktestChart,
        renderBacktestTradeTable: renderBacktestTradeTable
    };
});
