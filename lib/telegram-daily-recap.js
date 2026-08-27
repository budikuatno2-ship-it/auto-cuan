'use strict';

const reportHelpers = require('./report-helpers');
const trackRecordService = require('./track-record-service');
const telegramNotifier = require('./telegram-notifier');

const CATEGORY_NAMES = {
  daytrade: { label: 'Day Trade', icon: '⚡' },
  swing_konglo: { label: 'Swing Konglo', icon: '🏢' },
  swing_nk: { label: 'Swing Non-Konglo', icon: '🚀' },
  top5: { label: 'Top 5 Radar', icon: '🎯' }
};

function getTodayWibDateStr(dateObj) {
  const d = dateObj ? new Date(dateObj) : new Date();
  // Format in Asia/Jakarta timezone
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Jakarta',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).formatToParts(d);

  const y = parts.find(p => p.type === 'year').value;
  const m = parts.find(p => p.type === 'month').value;
  const day = parts.find(p => p.type === 'day').value;
  return `${y}-${m}-${day}`;
}

function formatWibHumanDate(dateStr) {
  if (!dateStr) return 'Hari Ini';
  try {
    const d = new Date(dateStr + 'T12:00:00+07:00');
    const dayNames = ['Minggu', 'Senin', 'Selasa', 'Rabu', 'Kamis', 'Jumat', 'Sabtu'];
    const monthNames = ['Januari', 'Februari', 'Maret', 'April', 'Mei', 'Juni', 'Juli', 'Agustus', 'September', 'Oktober', 'November', 'Desember'];
    const dayName = dayNames[d.getDay()];
    const dayNum = d.getDate();
    const monthName = monthNames[d.getMonth()];
    const year = d.getFullYear();
    return `${dayName}, ${dayNum} ${monthName} ${year}`;
  } catch (_) {
    return dateStr;
  }
}

function formatDailyAfternoonRecapMessage(picks = [], dateStr = null, options = {}) {
  const dateFormatted = formatWibHumanDate(dateStr || getTodayWibDateStr());
  const headerTime = options.timeStr || '16:15 WIB';

  // Filter out any archived / test rows
  const activePicks = (picks || []).filter(p => {
    if (!p || !p.ticker) return false;
    const raw = p.raw_payload || {};
    return !raw.history_archived_at && !p.history_archived_at && !p.archived_at;
  });

  // Fallback: If no picks found for today (e.g. market holiday, weekend, or safety gate zero picks)
  if (!activePicks.length) {
    const lines = [
      '📊 REKAP SORE PERFORMA SINYAL AUTO-CUAN',
      `📅 ${dateFormatted} (${headerTime})`,
      '━━━━━━━━━━━━━━━━━━━━',
      'ℹ️ Tidak ada sinyal rekomendasi aktif yang dirilis pada tanggal ini (Hari Libur Bursa / Safety Gate Menahan Sinyal).',
      '',
      '━━━━━━━━━━━━━━━━━━━━',
      '⚠️ Disclaimer:',
      'Evaluasi performa dihitung berdasarkan sistem rules & data riil bursa. Bukan ajakan beli/jual.'
    ];
    return lines.join('\n');
  }

  const trackData = trackRecordService.buildTrackRecordData(activePicks);
  const sum = trackData.summary;
  const byCat = trackData.by_category;
  const signals = trackData.signals;

  const lines = [
    '📊 REKAP SORE PERFORMA SINYAL AUTO-CUAN',
    `📅 ${dateFormatted} (${headerTime})`,
    '━━━━━━━━━━━━━━━━━━━━',
    '🎯 Ringkasan Hari Ini:',
    `• Total Sinyal: ${sum.total_signals} Saham`,
    `• Win Rate (TP1/TP2): ${sum.win_rate_tp1} (${sum.tp1_hits}/${sum.total_signals})`,
    `• Target Maks (TP2): ${sum.win_rate_tp2} (${sum.tp2_hits}/${sum.total_signals})`,
    `• Stop Loss Hit: ${sum.sl_rate} (${sum.sl_hits}/${sum.total_signals})`,
    `• Masih Berjalan / Floating: ${sum.running_signals + sum.waiting_signals} Saham`,
    '',
    '📌 Performa Per Kategori:'
  ];

  // Category Breakdown
  const catKeys = ['daytrade', 'swing_konglo', 'swing_nk', 'top5'];
  for (const k of catKeys) {
    const cat = byCat[k];
    if (!cat || cat.total === 0) continue;
    const meta = CATEGORY_NAMES[k] || { label: cat.label || k, icon: '📌' };
    lines.push(`${meta.icon} ${meta.label}: ${cat.total} Sinyal (Win Rate: ${cat.win_rate_tp1} | ${cat.tp1_hits} TP, ${cat.sl_hits} SL, ${cat.running + cat.waiting} Aktif)`);
  }

  // Lists of Outcomes
  const tpHits = signals.filter(s => s.outcome === 'TP1_HIT' || s.outcome === 'TP2_HIT');
  const slHits = signals.filter(s => s.outcome === 'SL_HIT');
  const activeFloating = signals.filter(s => s.outcome === 'RUNNING' || s.outcome === 'ENTRY_HIT' || s.outcome === 'WAITING');

  if (tpHits.length > 0) {
    lines.push('');
    lines.push('✅ TARGET TERCAPAI (TP1 / TP2):');
    tpHits.forEach(s => {
      const gainText = s.gain_pct != null ? ` (+${s.gain_pct.toFixed(1)}%)` : '';
      const durText = s.duration_text && s.duration_text !== '—' ? ` [${s.duration_text}]` : '';
      const badge = s.outcome === 'TP2_HIT' ? '🚀 TP2 Hit' : '🎯 TP1 Hit';
      lines.push(`• ${s.ticker} (${s.source_short}) ➔ ${badge}${gainText}${durText}`);
    });
  }

  if (slHits.length > 0) {
    lines.push('');
    lines.push('🛑 STOP LOSS HIT:');
    slHits.forEach(s => {
      const lossText = s.gain_pct != null ? ` (${s.gain_pct.toFixed(1)}%)` : '';
      const durText = s.duration_text && s.duration_text !== '—' ? ` [${s.duration_text}]` : '';
      lines.push(`• ${s.ticker} (${s.source_short}) ➔ SL Hit${lossText}${durText}`);
    });
  }

  if (activeFloating.length > 0) {
    lines.push('');
    lines.push('⏳ MASIH DALAM PANTAUAN / FLOATING:');
    activeFloating.forEach(s => {
      const statusText = s.outcome === 'WAITING' ? 'Menunggu Entry' : 'Running (Dalam Pantauan)';
      lines.push(`• ${s.ticker} (${s.source_short}) ➔ ${statusText}`);
    });
  }

  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━');
  lines.push('⚠️ Disclaimer:');
  lines.push('Rekap performa dihitung otomatis berdasarkan sinyal & pergerakan harga bursa. Bukan ajakan beli/jual. Selalu patuhi money management.');

  return lines.join('\n');
}

async function fetchPicksForRecap(supabase, targetDate) {
  const dateStr = targetDate || getTodayWibDateStr();
  const q = await supabase
    .from('telegram_daily_picks')
    .select('*')
    .eq('date', dateStr)
    .order('id', { ascending: true });

  if (q.error) {
    throw new Error('Supabase query error: ' + q.error.message);
  }

  return {
    date: dateStr,
    picks: q.data || []
  };
}

async function generateDailyAfternoonRecap(supabase, targetDate, options = {}) {
  const { date, picks } = await fetchPicksForRecap(supabase, targetDate);
  const message = formatDailyAfternoonRecapMessage(picks, date, options);
  const trackData = trackRecordService.buildTrackRecordData(picks);

  return {
    date,
    total_signals: (picks || []).length,
    summary: trackData.summary,
    by_category: trackData.by_category,
    message
  };
}

async function sendDailyAfternoonRecap(supabase, options = {}) {
  const recap = await generateDailyAfternoonRecap(supabase, options.date, options);
  if (options.dryRun) {
    return {
      sent: false,
      dry_run: true,
      date: recap.date,
      total_signals: recap.total_signals,
      message: recap.message
    };
  }

  const sendResult = await telegramNotifier.sendTelegramMessage(recap.message, {
    chat_id: options.chat_id
  });

  return {
    sent: sendResult.sent,
    skipped: sendResult.skipped,
    reason: sendResult.reason,
    date: recap.date,
    total_signals: recap.total_signals,
    message: recap.message
  };
}

module.exports = {
  CATEGORY_NAMES,
  getTodayWibDateStr,
  formatWibHumanDate,
  formatDailyAfternoonRecapMessage,
  fetchPicksForRecap,
  generateDailyAfternoonRecap,
  sendDailyAfternoonRecap
};
