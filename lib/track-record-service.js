'use strict';

const reportHelpers = require('./report-helpers');

const CATEGORY_META = {
  daytrade: {
    key: 'daytrade',
    label: 'Day Trade',
    shortLabel: 'Day Trade',
    icon: '⚡',
    description: 'Sinyal scalping & intraday cepat (same-day exit)'
  },
  swing_konglo: {
    key: 'swing_konglo',
    label: 'Swing Konglo',
    shortLabel: 'Konglo',
    icon: '🏢',
    description: 'Sinyal swing 3–7 hari grup konglomerasi'
  },
  swing_nk: {
    key: 'swing_nk',
    label: 'Swing Non-Konglo',
    shortLabel: 'Non-Konglo',
    icon: '🚀',
    description: 'Sinyal swing 3–7 hari saham momentum non-konglomerasi'
  },
  top5: {
    key: 'top5',
    label: 'Top 5 Daily Picks',
    shortLabel: 'Top 5',
    icon: '🎯',
    description: 'Rekomendasi pilihan harian 08:00 WIB'
  }
};

function normalizeNumber(val) {
  if (val == null) return null;
  const n = Number(val);
  return Number.isFinite(n) ? n : null;
}

function formatDuration(startTime, endTime) {
  if (!startTime || !endTime) return '—';
  try {
    const t1 = new Date(startTime).getTime();
    const t2 = new Date(endTime).getTime();
    if (isNaN(t1) || isNaN(t2) || t2 < t1) return '—';
    const diffHours = (t2 - t1) / (1000 * 60 * 60);
    if (diffHours < 1) {
      const diffMins = Math.round(diffHours * 60);
      return Math.max(1, diffMins) + ' m';
    }
    if (diffHours < 24) {
      return (Math.round(diffHours * 10) / 10) + ' jam';
    }
    const diffDays = Math.round((diffHours / 24) * 10) / 10;
    return diffDays + ' hari';
  } catch (_) {
    return '—';
  }
}

function formatWibTime(timestamp) {
  if (!timestamp) return '—';
  try {
    const d = new Date(timestamp);
    if (isNaN(d.getTime())) return '—';
    return new Intl.DateTimeFormat('id-ID', {
      timeZone: 'Asia/Jakarta',
      hour: '2-digit',
      minute: '2-digit',
      hour12: false
    }).format(d).replace('.', ':') + ' WIB';
  } catch (_) {
    return '—';
  }
}

function calculateGainPct(row, outcome) {
  const entry = normalizeNumber(row.entry1) || normalizeNumber(row.entry2);
  if (!entry || entry <= 0) return null;
  let target = null;
  if (outcome === 'TP2_HIT') target = normalizeNumber(row.tp2);
  else if (outcome === 'TP1_HIT') target = normalizeNumber(row.tp1);
  else if (outcome === 'SL_HIT') target = normalizeNumber(row.sl);

  if (!target || target <= 0) return null;
  const pct = ((target - entry) / entry) * 100;
  return Math.round(pct * 10) / 10;
}

function buildTrackRecordData(rows = [], options = {}) {
  const categoryStats = {
    daytrade: { key: 'daytrade', label: 'Day Trade', total: 0, tp1_hits: 0, tp2_hits: 0, sl_hits: 0, running: 0, waiting: 0, expired: 0, never_entered: 0, win_rate_tp1: '0.0%', win_rate_tp2: '0.0%', sl_rate: '0.0%' },
    swing_konglo: { key: 'swing_konglo', label: 'Swing Konglo', total: 0, tp1_hits: 0, tp2_hits: 0, sl_hits: 0, running: 0, waiting: 0, expired: 0, never_entered: 0, win_rate_tp1: '0.0%', win_rate_tp2: '0.0%', sl_rate: '0.0%' },
    swing_nk: { key: 'swing_nk', label: 'Swing Non-Konglo', total: 0, tp1_hits: 0, tp2_hits: 0, sl_hits: 0, running: 0, waiting: 0, expired: 0, never_entered: 0, win_rate_tp1: '0.0%', win_rate_tp2: '0.0%', sl_rate: '0.0%' },
    top5: { key: 'top5', label: 'Top 5 Daily Picks', total: 0, tp1_hits: 0, tp2_hits: 0, sl_hits: 0, running: 0, waiting: 0, expired: 0, never_entered: 0, win_rate_tp1: '0.0%', win_rate_tp2: '0.0%', sl_rate: '0.0%' }
  };

  let totalSignals = 0;
  let totalTp1Hits = 0;
  let totalTp2Hits = 0;
  let totalSlHits = 0;
  let totalRunning = 0;
  let totalWaiting = 0;
  let totalExpired = 0;
  let totalNeverEntered = 0;

  const signals = [];

  for (const row of rows) {
    if (!row || !row.ticker) continue;

    const raw = row.raw_payload || {};
    if (raw.history_archived_at || row.history_archived_at || row.archived_at) continue;

    const outcome = reportHelpers.classifyOutcome(row);
    const sourceKey = reportHelpers.getMonitorSource(row) || 'top5';
    const catMeta = CATEGORY_META[sourceKey] || {
      key: sourceKey,
      label: sourceKey,
      shortLabel: sourceKey,
      icon: '📌',
      description: 'Rekomendasi trading'
    };

    totalSignals++;
    if (categoryStats[sourceKey]) {
      categoryStats[sourceKey].total++;
    }

    const isTp2 = outcome === 'TP2_HIT';
    const isTp1 = outcome === 'TP1_HIT' || isTp2;
    const isSl = outcome === 'SL_HIT';
    const isRunning = outcome === 'RUNNING' || outcome === 'ENTRY_HIT';
    const isWaiting = outcome === 'WAITING';
    const isExpired = outcome === 'EXPIRED';
    const isNeverEntered = outcome === 'NEVER_ENTERED';

    if (isTp1) {
      totalTp1Hits++;
      if (categoryStats[sourceKey]) categoryStats[sourceKey].tp1_hits++;
    }
    if (isTp2) {
      totalTp2Hits++;
      if (categoryStats[sourceKey]) categoryStats[sourceKey].tp2_hits++;
    }
    if (isSl) {
      totalSlHits++;
      if (categoryStats[sourceKey]) categoryStats[sourceKey].sl_hits++;
    }
    if (isRunning) {
      totalRunning++;
      if (categoryStats[sourceKey]) categoryStats[sourceKey].running++;
    }
    if (isWaiting) {
      totalWaiting++;
      if (categoryStats[sourceKey]) categoryStats[sourceKey].waiting++;
    }
    if (isExpired) {
      totalExpired++;
      if (categoryStats[sourceKey]) categoryStats[sourceKey].expired++;
    }
    if (isNeverEntered) {
      totalNeverEntered++;
      if (categoryStats[sourceKey]) categoryStats[sourceKey].never_entered++;
    }

    const startTime = row.first_sent_at || row.created_at || (row.date ? row.date + 'T01:00:00.000Z' : null);
    const hitTime = isTp2 ? row.hit_tp2_at : (isTp1 ? (row.hit_tp1_at || row.hit_tp2_at) : (isSl ? row.hit_sl_at : null));
    const durationText = formatDuration(startTime, hitTime || row.last_checked_at);
    const gainPct = calculateGainPct(row, outcome);

    let statusLabel = 'Menunggu';
    let statusTone = '#fbbf24';
    let statusBg = 'rgba(245, 158, 11, 0.12)';
    let statusBorder = 'rgba(245, 158, 11, 0.3)';

    if (isTp2) {
      statusLabel = 'TP2 Hit';
      statusTone = '#34d399';
      statusBg = 'rgba(16, 185, 129, 0.15)';
      statusBorder = 'rgba(16, 185, 129, 0.35)';
    } else if (isTp1) {
      statusLabel = 'TP1 Hit';
      statusTone = '#6ee7b7';
      statusBg = 'rgba(16, 185, 129, 0.12)';
      statusBorder = 'rgba(16, 185, 129, 0.25)';
    } else if (isSl) {
      statusLabel = 'SL Hit';
      statusTone = '#f87171';
      statusBg = 'rgba(239, 68, 68, 0.12)';
      statusBorder = 'rgba(239, 68, 68, 0.3)';
    } else if (isRunning) {
      statusLabel = 'Running';
      statusTone = '#60a5fa';
      statusBg = 'rgba(59, 130, 246, 0.12)';
      statusBorder = 'rgba(59, 130, 246, 0.3)';
    } else if (isExpired) {
      statusLabel = 'Sinyal Kedaluwarsa';
      statusTone = '#9ca3af';
      statusBg = 'rgba(156, 163, 175, 0.12)';
      statusBorder = 'rgba(156, 163, 175, 0.25)';
    } else if (isNeverEntered) {
      statusLabel = 'Tidak Masuk Area';
      statusTone = '#9ca3af';
      statusBg = 'rgba(156, 163, 175, 0.12)';
      statusBorder = 'rgba(156, 163, 175, 0.25)';
    }

    signals.push({
      id: row.id,
      date: row.date || (startTime ? startTime.slice(0, 10) : '—'),
      ticker: String(row.ticker).toUpperCase(),
      category: row.category || catMeta.label,
      source: sourceKey,
      source_label: catMeta.label,
      source_short: catMeta.shortLabel,
      entry1: normalizeNumber(row.entry1),
      entry2: normalizeNumber(row.entry2),
      tp1: normalizeNumber(row.tp1),
      tp2: normalizeNumber(row.tp2),
      sl: normalizeNumber(row.sl),
      score: raw.score || raw.daytrade_score || row.score || null,
      setup: raw.setup || raw.pattern || null,
      outcome,
      status_label: statusLabel,
      status_tone: statusTone,
      status_bg: statusBg,
      status_border: statusBorder,
      gain_pct: gainPct,
      duration_text: durationText,
      hit_at: hitTime,
      first_sent_at: startTime,
      signal_time_wib: formatWibTime(startTime),
      price_at_signal: normalizeNumber(row.price_at_signal || raw.price_at_signal || raw.last_price || raw.current_price || row.current_price || row.entry1),
      hit_time_wib: formatWibTime(hitTime),
      price_at_hit: normalizeNumber(row.hit_price || raw.hit_price || (isTp2 ? row.tp2 : (isTp1 ? row.tp1 : (isSl ? row.sl : null))))
    });
  }

  for (const key of Object.keys(categoryStats)) {
    const stat = categoryStats[key];
    stat.win_rate_tp1 = reportHelpers.calculateRate(stat.tp1_hits, stat.total) || '0.0%';
    stat.win_rate_tp2 = reportHelpers.calculateRate(stat.tp2_hits, stat.total) || '0.0%';
    stat.sl_rate = reportHelpers.calculateRate(stat.sl_hits, stat.total) || '0.0%';
    const resolvedCount = stat.tp1_hits + stat.sl_hits + stat.expired;
    stat.resolved_win_rate = reportHelpers.calculateRate(stat.tp1_hits, resolvedCount) || '0.0%';
  }

  const totalResolved = totalTp1Hits + totalSlHits + totalExpired;
  const overallWinRateTp1 = reportHelpers.calculateRate(totalTp1Hits, totalSignals) || '0.0%';
  const overallWinRateTp2 = reportHelpers.calculateRate(totalTp2Hits, totalSignals) || '0.0%';
  const overallSlRate = reportHelpers.calculateRate(totalSlHits, totalSignals) || '0.0%';
  const overallResolvedWinRate = reportHelpers.calculateRate(totalTp1Hits, totalResolved) || '0.0%';

  return {
    success: true,
    summary: {
      total_signals: totalSignals,
      tp1_hits: totalTp1Hits,
      tp2_hits: totalTp2Hits,
      sl_hits: totalSlHits,
      running_signals: totalRunning,
      waiting_signals: totalWaiting,
      expired_signals: totalExpired,
      never_entered_signals: totalNeverEntered,
      total_resolved: totalResolved,
      win_rate_tp1: overallWinRateTp1,
      win_rate_tp2: overallWinRateTp2,
      sl_rate: overallSlRate,
      resolved_win_rate: overallResolvedWinRate
    },
    by_category: categoryStats,
    category_meta: CATEGORY_META,
    signals
  };
}

module.exports = {
  CATEGORY_META,
  formatDuration,
  formatWibTime,
  calculateGainPct,
  buildTrackRecordData
};
