'use strict';

const fsp = require('node:fs/promises');
const path = require('node:path');
const { createClient } = require('@supabase/supabase-js');
const telegramNotifier = require('./telegram-notifier');

const DEFAULT_PUBLISHED_DIR = path.join(process.cwd(), 'data', 'intraday-fast-watcher-published');
const MAX_LIVE_PUBLISH = 3;

function numberOrNull(value) {
  if (value === null || value === undefined || value === '' || typeof value === 'boolean') return null;
  const n = Number(value);
  return Number.isFinite(n) ? n : null;
}

function safeText(value, maxLength) {
  return String(value == null ? '' : value).replace(/[\u0000-\u001f\u007f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, maxLength || 180);
}

async function readJson(file, fallback) {
  try { return JSON.parse(await fsp.readFile(file, 'utf8')); }
  catch (error) { if (error.code === 'ENOENT') return fallback; throw error; }
}

async function writeJsonAtomic(file, value) {
  await fsp.mkdir(path.dirname(file), { recursive: true });
  const temp = `${file}.${process.pid}.tmp`;
  await fsp.writeFile(temp, JSON.stringify(value, null, 2) + '\n', { mode: 0o600 });
  await fsp.rename(temp, file);
}

function buildDbRow(item, sampleDate, scheduledTime) {
  const obs = item.observation || {};
  const metrics = obs.metrics || {};
  const currentPrice = numberOrNull(obs.current_price ?? obs.last_price ?? metrics.current_price);
  const entryLow = numberOrNull(obs.entry_low ?? metrics.entry_low);
  const entryHigh = numberOrNull(obs.entry_high ?? metrics.entry_high);
  const stopLoss = numberOrNull(obs.stop_loss ?? obs.sl ?? metrics.stop_loss);
  const tp1 = numberOrNull(obs.tp1 ?? metrics.tp1);
  const tp2 = numberOrNull(obs.tp2);
  const watchScore = numberOrNull(item.watch_score);
  const publishScore = numberOrNull(item.publish_score);
  const engineScore = numberOrNull(obs.score ?? obs.daytrade_score);
  const flowScore = numberOrNull(metrics.momentum_flow_score);
  const flowLabel = safeText(metrics.momentum_flow_label || 'BELUM_TERSEDIA', 32);
  const flowConfidence = safeText(metrics.momentum_flow_confidence || 'LOW', 16);
  const finalScore = Math.max(50, Math.min(100, Math.round(publishScore ?? watchScore ?? engineScore ?? 70)));
  const row = {
    ticker: safeText(item.ticker, 5),
    stock_name: safeText(obs.stock_name || item.ticker, 120),
    board: safeText(obs.board || '', 20) || null,
    status: 'READY_BREAKOUT',
    setup: safeText(obs.candidate_type || obs.setup || 'FAST_WATCHER_MOMENTUM_FLOW', 120),
    daytrade_score: finalScore,
    liquidity_score: numberOrNull(obs.liquidity_component ?? obs.liquidity_score),
    prespike_score: numberOrNull(obs.pre_spike_component ?? obs.prespike_score),
    momentum_score: numberOrNull(obs.momentum_component ?? obs.momentum_score),
    risk_reward_score: numberOrNull(obs.risk_reward_component ?? obs.risk_reward_score),
    trend_score: numberOrNull(obs.trend_component ?? obs.trend_score),
    penalty_score: numberOrNull(obs.penalty_component ?? obs.penalty_score),
    last_price: currentPrice,
    change_pct: numberOrNull(obs.change_pct),
    open_price: numberOrNull(obs.open ?? obs.open_price),
    high_price: numberOrNull(obs.high ?? obs.high_price),
    low_price: numberOrNull(obs.low ?? obs.low_price),
    volume_today: numberOrNull(obs.volume ?? obs.volume_today),
    avg_volume_20d: numberOrNull(obs.average_volume ?? obs.avg_volume_20d),
    volume_ratio_20d: numberOrNull(obs.relative_volume ?? obs.volume_ratio_20d),
    entry_low: entryLow,
    entry_high: entryHigh,
    stop_loss: stopLoss,
    tp1,
    tp2,
    risk_reward: numberOrNull(obs.risk_reward),
    invalidation: stopLoss != null ? `Invalid jika harga <= ${stopLoss}` : null,
    time_plan: 'Fast Watcher guarded-live: dua konfirmasi harga-volume intraday.',
    notes: `FAST_WATCHER_CONFIRMED | flow=${flowScore ?? '-'}:${flowLabel}:${flowConfidence} | watch=${watchScore ?? '-'} | publish=${publishScore ?? '-'} | ${sampleDate} ${scheduledTime} WIB`,
    run_mode: 'FAST_WATCHER_LIVE',
    calculated_at: new Date().toISOString(),
    run_id: `fw-${sampleDate}-${String(scheduledTime || '').replace(':', '')}-${String(item.setup_id || '').slice(0, 12)}`,
    quality_grade: publishScore != null && publishScore >= 85 ? 'A' : 'B'
  };
  Object.keys(row).forEach(key => {
    if (row[key] === null || row[key] === undefined || row[key] === '') delete row[key];
  });
  return row;
}

function formatPrice(value) {
  const n = numberOrNull(value);
  return n == null ? '-' : new Intl.NumberFormat('id-ID', { maximumFractionDigits: 2 }).format(n);
}

function formatSigned(value, suffix) {
  const n = numberOrNull(value);
  if (n == null) return '-';
  return `${n >= 0 ? '+' : ''}${n.toFixed(2)}${suffix || ''}`;
}

function formatRatio(value) {
  const n = numberOrNull(value);
  return n == null ? '-' : `${n.toFixed(2)}x`;
}

function buildTelegramMessage(item, sampleDate, scheduledTime) {
  const obs = item.observation || {};
  const metrics = obs.metrics || {};
  const price = obs.current_price ?? obs.last_price ?? metrics.current_price;
  const entryLow = obs.entry_low ?? metrics.entry_low;
  const entryHigh = obs.entry_high ?? metrics.entry_high;
  const stop = obs.stop_loss ?? obs.sl ?? metrics.stop_loss;
  const tp1 = obs.tp1 ?? metrics.tp1;
  const priceChange = numberOrNull(metrics.price_change_pct);
  const relativeVolume = numberOrNull(obs.relative_volume ?? obs.volume_ratio_20d ?? metrics.relative_volume);
  const flowScore = numberOrNull(metrics.momentum_flow_score);
  const flowLabel = safeText(metrics.momentum_flow_label || 'BELUM_TERSEDIA', 32).replaceAll('_', ' ');
  const flowConfidence = safeText(metrics.momentum_flow_confidence || 'LOW', 16);
  const priceVelocity = numberOrNull(metrics.price_velocity_pct_per_min);
  const volumeAcceleration = numberOrNull(metrics.volume_acceleration);
  const volumeRateVsAverage = numberOrNull(metrics.volume_rate_vs_average);
  const rangePosition = numberOrNull(metrics.range_position);
  const lines = [
    '🚀 FAST WATCHER CONFIRMED',
    '',
    `Ticker: ${safeText(item.ticker, 5)}`,
    `Harga: ${formatPrice(price)}`,
    `Area entry: ${formatPrice(entryLow)}–${formatPrice(entryHigh)}`,
    `TP1: ${formatPrice(tp1)}`,
    `Stop loss: ${formatPrice(stop)}`,
    '',
    `Momentum Flow: ${flowScore == null ? '-' : `${flowScore.toFixed(0)}/100`} (${flowLabel})`,
    `Kepercayaan data: ${flowConfidence}`,
    `Kecepatan harga: ${formatSigned(priceVelocity, '%/menit')}`,
    `Akselerasi volume: ${formatSigned(volumeAcceleration == null ? null : volumeAcceleration * 100, '%')}`,
    `Laju volume vs rata-rata: ${formatRatio(volumeRateVsAverage)}`,
    `Posisi rentang intraday: ${rangePosition == null ? '-' : `${Math.round(rangePosition * 100)}%`}`,
    `Momentum harga snapshot: ${priceChange == null ? '-' : `${priceChange >= 0 ? '+' : ''}${priceChange.toFixed(2)}%`}`,
    `Relative volume: ${relativeVolume == null ? '-' : `${relativeVolume.toFixed(2)}x`}`,
    `Watch score: ${formatPrice(item.watch_score)}`,
    `Publish score: ${formatPrice(item.publish_score)}`,
    `Konfirmasi: ${item.ready_streak || 2}x berturut-turut`,
    `Waktu: ${sampleDate} ${scheduledTime} WIB`,
    '',
    'Catatan: Momentum Flow adalah proxy harga-volume, bukan pembacaan orderbook/HAKA/OFI. Entry tetap wajib dikonfirmasi manual; bukan auto-order.'
  ];
  return lines.join('\n');
}

function makeSupabaseClient(env) {
  const url = env.SUPABASE_URL;
  const key = env.SUPABASE_SERVICE_ROLE_KEY;
  if (!url || !key) return null;
  return createClient(url, key, { auth: { persistSession: false, autoRefreshToken: false } });
}

async function upsertSystemRows(client, rows) {
  if (!rows.length) return { ok: true, rows: [] };
  const result = await client.from('daytrade_screener_latest').upsert(rows, { onConflict: 'ticker' }).select('ticker');
  if (result.error) return { ok: false, error: result.error.message, rows: [] };
  return { ok: true, rows: result.data || rows.map(row => ({ ticker: row.ticker })) };
}

async function loadSupplementalShortlist(options) {
  const opts = options || {};
  const env = opts.env || process.env;
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY) return [];
  try {
    const client = opts.storeClient || makeSupabaseClient(env);
    if (!client) return [];
    const result = await client
      .from('daytrade_screener_latest')
      .select('ticker,board,status,daytrade_score')
      .order('daytrade_score', { ascending: false })
      .limit(40);
    if (result.error) return [];
    const accepted = new Set([
      'READY_BREAKOUT', 'A_PLUS_SETUP', 'TRADE_CANDIDATE', 'PRE_SPIKE_WATCH',
      'EARLY_RADAR', 'WAIT_PULLBACK', 'MOMENTUM_CONTINUATION', 'RECLAIM_CANDIDATE', 'WATCHING'
    ]);
    return (result.data || []).filter(row => accepted.has(String(row.status || '').toUpperCase()));
  } catch (_) {
    return [];
  }
}

async function publishConfirmed(options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const liveEnabled = String(env.FAST_WATCHER_LIVE_ENABLED || '') === '1';
  const publishEnabled = String(env.FAST_WATCHER_PUBLISH_ENABLED || '') === '1';
  if (!liveEnabled || !publishEnabled) {
    return { attempted: false, system_published: 0, telegram_sent: 0, reason: !liveEnabled ? 'live_kill_switch_off' : 'publish_kill_switch_off' };
  }

  const sampleDate = opts.sampleDate;
  const scheduledTime = opts.scheduledTime;
  const publishable = Array.isArray(opts.publishable) ? opts.publishable.slice(0, MAX_LIVE_PUBLISH) : [];
  if (!publishable.length) return { attempted: false, system_published: 0, telegram_sent: 0, reason: 'nothing_confirmed' };

  const publishedDir = opts.publishedDir || DEFAULT_PUBLISHED_DIR;
  const ledgerFile = path.join(publishedDir, `${sampleDate}.json`);
  const ledger = await readJson(ledgerFile, { date: sampleDate, setups: {} });
  const retryTelegram = [];
  const newItems = [];
  for (const item of publishable) {
    const setupId = String(item.setup_id || '');
    if (!setupId) continue;
    const prior = ledger.setups[setupId];
    if (prior && prior.system_published_at) {
      if (!prior.telegram_sent_at) retryTelegram.push(item);
      continue;
    }
    newItems.push(item);
  }

  let client = opts.storeClient || null;
  if (!client) client = makeSupabaseClient(env);
  if (!client && newItems.length) {
    return { attempted: true, system_published: 0, telegram_sent: 0, reason: 'supabase_not_configured', pending_count: newItems.length };
  }

  const rows = newItems.map(item => buildDbRow(item, sampleDate, scheduledTime));
  const dbResult = newItems.length ? await upsertSystemRows(client, rows) : { ok: true, rows: [] };
  if (!dbResult.ok) {
    return { attempted: true, system_published: 0, telegram_sent: 0, reason: 'system_publish_failed', error: safeText(dbResult.error, 180) };
  }

  const now = new Date().toISOString();
  for (const item of newItems) {
    const metrics = item && item.observation && item.observation.metrics || {};
    ledger.setups[item.setup_id] = {
      ticker: item.ticker,
      setup_id: item.setup_id,
      system_published_at: now,
      telegram_sent_at: null,
      scheduled_time: scheduledTime,
      publish_score: item.publish_score,
      momentum_flow_score: numberOrNull(metrics.momentum_flow_score),
      momentum_flow_label: safeText(metrics.momentum_flow_label || '', 32) || null
    };
  }
  await writeJsonAtomic(ledgerFile, ledger);

  const telegramEnabled = String(env.FAST_WATCHER_TELEGRAM_ENABLED || '') === '1';
  const telegramItems = [...newItems, ...retryTelegram].slice(0, MAX_LIVE_PUBLISH);
  let telegramSent = 0;
  const telegramFailures = [];
  if (telegramEnabled) {
    const send = opts.notifyFn || telegramNotifier.sendTelegramMessage;
    const chatId = env.FAST_WATCHER_TELEGRAM_CHAT_ID || env.TELEGRAM_CHAT_ID;
    const sendResults = await Promise.all(telegramItems.map(async item => {
      try {
        const result = await send(buildTelegramMessage(item, sampleDate, scheduledTime), {
          chat_id: chatId,
          disable_web_page_preview: true,
          timeout_ms: 5000
        });
        return { item, result };
      } catch (_) {
        return { item, result: { sent: false, reason: 'telegram_exception' } };
      }
    }));
    for (const entry of sendResults) {
      const item = entry.item;
      const result = entry.result;
      if (result && result.sent) {
        telegramSent += 1;
        if (ledger.setups[item.setup_id]) ledger.setups[item.setup_id].telegram_sent_at = new Date().toISOString();
      } else {
        telegramFailures.push({ ticker: item.ticker, reason: result && result.reason ? result.reason : 'telegram_failed' });
      }
    }
    await writeJsonAtomic(ledgerFile, ledger);
  }

  return {
    attempted: true,
    system_published: newItems.length,
    duplicate_system_skipped: publishable.length - newItems.length,
    telegram_attempted: telegramEnabled && telegramItems.length > 0,
    telegram_sent: telegramSent,
    telegram_failures: telegramFailures,
    ledger_file: ledgerFile
  };
}

module.exports = {
  DEFAULT_PUBLISHED_DIR,
  MAX_LIVE_PUBLISH,
  buildDbRow,
  buildTelegramMessage,
  loadSupplementalShortlist,
  publishConfirmed,
  readJson,
  writeJsonAtomic
};
