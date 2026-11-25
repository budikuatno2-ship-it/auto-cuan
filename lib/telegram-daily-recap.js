'use strict';

const fs = require('node:fs');
const path = require('node:path');
const reportHelpers = require('./report-helpers');
const trackRecordService = require('./track-record-service');
const telegramNotifier = require('./telegram-notifier');

const THREE_HORIZON_SNAPSHOT_PATH = path.resolve(__dirname, '..', 'data', 'three-horizon-latest.json');

const CATEGORY_NAMES = {
  potensi_besok: { label: 'Potensi Besok (1–5H)', icon: '🔥' },
  short_swing: { label: 'Short Swing (3–10H)', icon: '⚡' },
  swing: { label: 'Swing (7–30H)', icon: '🧭' },
  daytrade: { label: 'Potensi Besok', icon: '🔥' },
  swing_konglo: { label: 'Short Swing', icon: '⚡' },
  swing_nk: { label: 'Swing', icon: '🧭' },
  top5: { label: 'Top 5 Radar', icon: '🎯' }
};

function fmtRpId(val) {
  const n = Number(val);
  if (!Number.isFinite(n) || n <= 0) return '—';
  return 'Rp ' + Math.round(n).toLocaleString('id-ID');
}

function fmtRrId(val) {
  const n = Number(val);
  if (!Number.isFinite(n) || n <= 0) return '—';
  return '1:' + n.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

function fmtPctId(val) {
  const n = Number(val);
  if (!Number.isFinite(n)) return '—';
  return (n > 0 ? '+' : '') + n.toLocaleString('id-ID', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + '%';
}

function loadThreeHorizonSnapshot(customPath) {
  const fp = customPath || THREE_HORIZON_SNAPSHOT_PATH;
  try {
    if (!fs.existsSync(fp)) return null;
    const doc = JSON.parse(fs.readFileSync(fp, 'utf8'));
    if (doc && doc.horizons && typeof doc.horizons === 'object') return doc;
  } catch (_) {}
  return null;
}

function formatThreeHorizonRecapMessage(threeDoc, options = {}) {
  const doc = threeDoc && threeDoc.horizons ? threeDoc : null;
  const dateStr = (options.date || (doc && doc.trade_date) || getTodayWibDateStr());
  const dateFormatted = formatWibHumanDate(dateStr);
  const headerTime = options.timeStr || '21:20 WIB';
  const maxPerHorizon = Math.max(1, Math.min(5, Number(options.maxPerHorizon || 3)));

  if (!doc) {
    return [
      '📊 REKAP & RADAR THREE-HORIZON AUTO-CUAN',
      `📅 ${dateFormatted} (${headerTime})`,
      '━━━━━━━━━━━━━━━━━━━━',
      'ℹ️ Snapshot Three-Horizon belum tersedia untuk tanggal ini (Hari Libur Bursa / Safety Gate Menahan Sinyal).',
      '',
      '━━━━━━━━━━━━━━━━━━━━',
      '⚠️ Disclaimer:',
      'Bukan ajakan beli/jual. Konfirmasi manual wajib & patuhi manajemen risiko.'
    ].join('\n');
  }

  const lines = [
    '📊 REKAP & RADAR THREE-HORIZON AUTO-CUAN',
    `📅 Data EOD ${dateFormatted} (${headerTime})`,
    '━━━━━━━━━━━━━━━━━━━━'
  ];

  const order = [
    { key: 'potensi_besok', title: '🔥 POTENSI BESOK (1–5H)' },
    { key: 'short_swing', title: '⚡ SHORT SWING (3–10H)' },
    { key: 'swing', title: '🧭 SWING (7–30H)' }
  ];

  let totalShown = 0;
  for (const h of order) {
    const bucket = doc.horizons[h.key];
    const rawList = Array.isArray(bucket && bucket.top20) ? bucket.top20 : (Array.isArray(bucket && bucket.picks) ? bucket.picks : []);
    const minRr = h.key === 'swing' ? 1.8 : 1.5;
    const clean = rawList.filter((r) => {
      const px = Number(r && (r.last_price != null ? r.last_price : r.close));
      const rr = Number(r && (r.risk_reward != null ? r.risk_reward : r.rr));
      return Number.isFinite(px) && px >= 1 && (!Number.isFinite(rr) || rr >= minRr);
    }).slice(0, maxPerHorizon);

    lines.push('');
    lines.push(`${h.title} · Top ${clean.length}`);
    if (!clean.length) {
      lines.push(`• Tidak ada kandidat lolos syarat R/R ≥ ${minRr.toFixed(2).replace('.', ',')} & harga ≥ Rp 1.`);
      continue;
    }
    clean.forEach((r, idx) => {
      totalShown++;
      const namePart = r.company_name || r.emiten ? ` (${r.company_name || r.emiten})` : '';
      const ageTag = r.signal_age_label ? ` [${r.signal_age_label}]` : '';
      const scoreNum = Number(r.score || 0);
      const scoreStr = Number.isFinite(scoreNum) && scoreNum > 0 ? scoreNum.toFixed(1).replace('.', ',') : '—';
      const eLow = r.entry_low != null ? r.entry_low : (r.entry2 != null ? r.entry2 : r.last_price);
      const eHigh = r.entry_high != null ? r.entry_high : (r.entry1 != null ? r.entry1 : r.last_price);
      const entryRange = (eLow && eHigh && eLow !== eHigh)
        ? `${Math.round(eLow).toLocaleString('id-ID')}–${Math.round(eHigh).toLocaleString('id-ID')}`
        : fmtRpId(eHigh || eLow).replace('Rp ', '');
      lines.push(`${idx + 1}. *${r.ticker}*${namePart}${ageTag} · Skor ${scoreStr} (${r.confidence || 'A'})`);
      lines.push(`   Harga ${fmtRpId(r.last_price)} (${fmtPctId(r.change_pct)}) · Entry ${entryRange} · TP1 ${Math.round(Number(r.tp1 || 0)).toLocaleString('id-ID')} · SL ${Math.round(Number(r.sl || r.stop_loss || 0)).toLocaleString('id-ID')} · R/R ${fmtRrId(r.risk_reward || r.rr)}`);
    });
  }

  lines.push('');
  lines.push('━━━━━━━━━━━━━━━━━━━━');
  lines.push(`Ringkas: ${totalShown} kandidat Three-Horizon dari data EOD ${dateStr} (fraksi IDX & R/R ≥ 1,50).`);
  lines.push('⚠️ Disclaimer: Bukan ajakan beli/jual. Konfirmasi manual wajib & patuhi manajemen risiko.');
  return lines.join('\n');
}

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
  // V3-F06 / V6.5.3: jadwal rekap malam sinkron 21:20 WIB.
  const headerTime = options.timeStr || '21:20 WIB';

  // Filter out any archived / test rows
  const activePicks = filterActivePicks(picks);

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

function filterActivePicks(picks) {
  return (picks || []).filter(p => {
    if (!p || !p.ticker) return false;
    const raw = p.raw_payload || {};
    return !raw.history_archived_at && !p.history_archived_at && !p.archived_at;
  });
}

async function generateDailyAfternoonRecap(supabase, targetDate, options = {}) {
  const threeDoc = options.threeHorizonDoc || loadThreeHorizonSnapshot(options.threeHorizonPath);
  if (threeDoc && options.forceLegacyPicks !== true) {
    const thDate = threeDoc.trade_date || targetDate || getTodayWibDateStr();
    const message = formatThreeHorizonRecapMessage(threeDoc, {
      date: thDate,
      timeStr: options.timeStr || '21:20 WIB',
      maxPerHorizon: options.maxPerHorizon || 3
    });
    const buckets = ['potensi_besok', 'short_swing', 'swing'];
    const totalSignals = buckets.reduce((acc, k) => acc + Math.min(3, ((threeDoc.horizons[k] && threeDoc.horizons[k].top20) || []).length), 0);
    return {
      date: thDate,
      mode: 'three_horizon',
      total_signals: totalSignals,
      summary: { mode: 'three_horizon', trade_date: thDate },
      by_category: {},
      message
    };
  }
  const { date, picks } = await fetchPicksForRecap(supabase, targetDate);
  const activePicks = filterActivePicks(picks);
  const message = formatDailyAfternoonRecapMessage(activePicks, date, options);
  const trackData = trackRecordService.buildTrackRecordData(activePicks);

  return {
    date,
    total_signals: activePicks.length,
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

  // The afternoon recap is deliberately delivered AFTER the exchange closes
  // (18:45 WIB). Without skip_market_guard the notifier blocks the broadcast
  // with [MARKET_GUARD_BLOCKED] market_closed — production evidence showed the
  // 18:45 recap skipped 20 times in a row for exactly this reason. The Swing EOD
  // modules already pass skip_market_guard: true; the recap must do the same.
  const sendResult = await telegramNotifier.sendTelegramMessage(recap.message, {
    chat_id: options.chat_id,
    skip_market_guard: true
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
  formatThreeHorizonRecapMessage,
  loadThreeHorizonSnapshot,
  formatDailyAfternoonRecapMessage,
  fetchPicksForRecap,
  generateDailyAfternoonRecap,
  sendDailyAfternoonRecap
};
