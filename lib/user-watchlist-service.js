'use strict';

const VALID_ALERT_CONDITIONS = ['PRICE_ABOVE', 'PRICE_BELOW', 'ENTRY_ZONE', 'TP_HIT', 'SL_HIT'];

function normalizeTicker(ticker) {
  if (!ticker || typeof ticker !== 'string') return null;
  const clean = ticker.trim().toUpperCase();
  if (/^[A-Z0-9]{4,6}$/.test(clean)) return clean;
  return null;
}

function normalizeNumber(val) {
  if (val == null || val === '') return null;
  const n = Number(val);
  return Number.isFinite(n) && n > 0 ? n : null;
}

async function getUserWatchlist(supabase, userId) {
  if (!supabase || !userId) {
    return { success: false, error: 'Database atau User ID tidak valid.', watchlist: [] };
  }

  try {
    // 1. Fetch watchlist rows
    const wlQuery = await supabase
      .from('app_user_watchlists')
      .select('id, ticker, notes, created_at, updated_at')
      .eq('user_id', userId)
      .order('created_at', { ascending: false });

    if (wlQuery.error) {
      return { success: false, error: wlQuery.error.message, watchlist: [] };
    }

    const items = wlQuery.data || [];
    if (!items.length) {
      return { success: true, watchlist: [] };
    }

    const tickers = items.map(it => it.ticker);

    // 2. Fetch active alerts for this user
    const alertsQuery = await supabase
      .from('app_user_alerts')
      .select('id, watchlist_id, ticker, condition_type, target_price, is_active, is_triggered, triggered_at, created_at')
      .eq('user_id', userId)
      .eq('is_active', true);

    const alerts = alertsQuery.data || [];
    const alertsByTicker = {};
    for (const a of alerts) {
      const t = a.ticker;
      if (!alertsByTicker[t]) alertsByTicker[t] = [];
      alertsByTicker[t].push(a);
    }

    // 3. Batch fetch latest prices from daytrade_screener_latest
    let pricesByTicker = {};
    try {
      const priceQuery = await supabase
        .from('daytrade_screener_latest')
        .select('ticker, last_price, change_pct, calculated_at')
        .in('ticker', tickers);

      if (priceQuery.data) {
        for (const p of priceQuery.data) {
          pricesByTicker[p.ticker] = p;
        }
      }
    } catch (_) {
      // Best-effort price attachment
    }

    const enriched = items.map(item => {
      const px = pricesByTicker[item.ticker] || {};
      return {
        id: item.id,
        ticker: item.ticker,
        notes: item.notes || null,
        last_price: px.last_price != null ? Number(px.last_price) : null,
        change_pct: px.change_pct != null ? Number(px.change_pct) : null,
        price_updated_at: px.calculated_at || null,
        alerts: alertsByTicker[item.ticker] || [],
        created_at: item.created_at,
        updated_at: item.updated_at
      };
    });

    return { success: true, watchlist: enriched };
  } catch (err) {
    return { success: false, error: err.message || String(err), watchlist: [] };
  }
}

async function addToWatchlist(supabase, userId, ticker, notes = null) {
  if (!supabase || !userId) {
    return { success: false, error: 'Database atau User ID tidak valid.' };
  }
  const cleanTicker = normalizeTicker(ticker);
  if (!cleanTicker) {
    return { success: false, error: 'Ticker tidak valid (harus 4-6 karakter alfanumerik).' };
  }

  try {
    const payload = {
      user_id: userId,
      ticker: cleanTicker,
      notes: typeof notes === 'string' ? notes.trim().slice(0, 500) : null,
      updated_at: new Date().toISOString()
    };

    const q = await supabase
      .from('app_user_watchlists')
      .upsert(payload, { onConflict: 'user_id,ticker' })
      .select('id, user_id, ticker, notes, created_at, updated_at')
      .maybeSingle();

    if (q.error) {
      return { success: false, error: q.error.message };
    }

    return { success: true, item: q.data };
  } catch (err) {
    return { success: false, error: err.message || String(err) };
  }
}

async function removeFromWatchlist(supabase, userId, ticker) {
  if (!supabase || !userId) {
    return { success: false, error: 'Database atau User ID tidak valid.' };
  }
  const cleanTicker = normalizeTicker(ticker);
  if (!cleanTicker) {
    return { success: false, error: 'Ticker tidak valid.' };
  }

  try {
    const delWl = await supabase
      .from('app_user_watchlists')
      .delete()
      .eq('user_id', userId)
      .eq('ticker', cleanTicker);

    if (delWl.error) {
      return { success: false, error: delWl.error.message };
    }

    // Also deactivate/delete associated alerts
    try {
      await supabase
        .from('app_user_alerts')
        .delete()
        .eq('user_id', userId)
        .eq('ticker', cleanTicker);
    } catch (_) {}

    return { success: true, ticker: cleanTicker };
  } catch (err) {
    return { success: false, error: err.message || String(err) };
  }
}

async function createAlert(supabase, userId, payload = {}) {
  if (!supabase || !userId) {
    return { success: false, error: 'Database atau User ID tidak valid.' };
  }

  const cleanTicker = normalizeTicker(payload.ticker);
  if (!cleanTicker) {
    return { success: false, error: 'Ticker tidak valid.' };
  }

  const conditionType = String(payload.condition_type || '').toUpperCase();
  if (VALID_ALERT_CONDITIONS.indexOf(conditionType) === -1) {
    return { success: false, error: `condition_type tidak valid. Pilihan: ${VALID_ALERT_CONDITIONS.join(', ')}` };
  }

  const targetPrice = normalizeNumber(payload.target_price);
  if ((conditionType === 'PRICE_ABOVE' || conditionType === 'PRICE_BELOW') && !targetPrice) {
    return { success: false, error: 'target_price harus berupa angka positif untuk kondisi batas harga.' };
  }

  try {
    // Optional: look up telegram_private_chat_id if not supplied
    let chatId = payload.notification_chat_id ? Number(payload.notification_chat_id) : null;
    if (!chatId) {
      const tg = await supabase
        .from('app_user_telegram_verifications')
        .select('telegram_private_chat_id')
        .eq('user_id', userId)
        .maybeSingle();

      if (tg.data && tg.data.telegram_private_chat_id) {
        chatId = Number(tg.data.telegram_private_chat_id);
      }
    }

    const alertRecord = {
      user_id: userId,
      watchlist_id: payload.watchlist_id || null,
      ticker: cleanTicker,
      condition_type: conditionType,
      target_price: targetPrice,
      is_active: true,
      is_triggered: false,
      notification_chat_id: chatId || null,
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString()
    };

    const q = await supabase
      .from('app_user_alerts')
      .insert(alertRecord)
      .select('id, user_id, ticker, condition_type, target_price, is_active, is_triggered, notification_chat_id, created_at')
      .maybeSingle();

    if (q.error) {
      return { success: false, error: q.error.message };
    }

    return { success: true, alert: q.data };
  } catch (err) {
    return { success: false, error: err.message || String(err) };
  }
}

async function deleteAlert(supabase, userId, alertId) {
  if (!supabase || !userId || !alertId) {
    return { success: false, error: 'Database, User ID, atau Alert ID tidak valid.' };
  }

  try {
    const q = await supabase
      .from('app_user_alerts')
      .delete()
      .eq('id', alertId)
      .eq('user_id', userId);

    if (q.error) {
      return { success: false, error: q.error.message };
    }

    return { success: true, alert_id: alertId };
  } catch (err) {
    return { success: false, error: err.message || String(err) };
  }
}

function formatUserAlertMessage(alert, px, options) {
  const ticker = String(alert && alert.ticker || '').toUpperCase();
  const cond = alert && alert.condition_type;
  const target = alert && alert.target_price != null ? Number(alert.target_price).toLocaleString('id-ID') : '-';
  const last = px && px.last_price != null ? Number(px.last_price).toLocaleString('id-ID') : '-';
  const chg = px && px.change_pct != null ? (Number(px.change_pct) >= 0 ? '+' : '') + Number(px.change_pct).toFixed(1) + '%' : '';

  let condLabel = 'Trigger Alert';
  let emoji = '🔔';
  if (cond === 'PRICE_ABOVE') {
    condLabel = 'Naik Menembus Level Target';
    emoji = '🚀';
  } else if (cond === 'PRICE_BELOW') {
    condLabel = 'Turun Menyentuh Level Target';
    emoji = '⚠️';
  } else if (cond === 'ENTRY_ZONE') {
    condLabel = 'Masuk Area Entry Ideal';
    emoji = '🎯';
  } else if (cond === 'TP_HIT') {
    condLabel = 'Target Profit (TP) Tercapai';
    emoji = '💰';
  } else if (cond === 'SL_HIT') {
    condLabel = 'Stop Loss (SL) Tersentuh';
    emoji = '🛑';
  }

  const lines = [
    `${emoji} ALERT HARGA PRIBADI: ${ticker}`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `📌 Status: ${condLabel}`,
    `• Level Target: Rp${target}`,
    `• Harga Terkini: Rp${last}${chg ? ` (${chg})` : ''}`,
    `• Waktu Pantau: ${new Date().toLocaleTimeString('id-ID', { timeZone: 'Asia/Jakarta', hour12: false })} WIB`,
    `━━━━━━━━━━━━━━━━━━━━`,
    `⚠️ Catatan: Alert ini dipasang dari Watchlist Pribadi Anda. Selalu konfirmasi chart & volume sebelum mengambil keputusan transaksi.`
  ];

  return lines.join('\n');
}

async function evaluateActiveUserAlerts(supabase, options = {}) {
  if (!supabase) {
    return { success: false, error: 'Database client tidak valid.', evaluated: 0, triggered: 0, sent: 0 };
  }

  const isDryRun = !!options.dryRun;
  const telegramNotifier = options.telegramNotifier || require('./telegram-notifier');

  try {
    // 1. Fetch active, untriggered alerts
    const { data: activeAlerts, error } = await supabase
      .from('app_user_alerts')
      .select('id, user_id, ticker, condition_type, target_price, notification_chat_id, created_at')
      .eq('is_active', true)
      .eq('is_triggered', false);

    if (error) {
      return { success: false, error: error.message, evaluated: 0, triggered: 0, sent: 0 };
    }

    if (!activeAlerts || !activeAlerts.length) {
      return { success: true, evaluated: 0, triggered: 0, sent: 0, previews: [] };
    }

    const tickers = Array.from(new Set(activeAlerts.map(a => a.ticker)));

    // 2. Batch fetch prices from daytrade_screener_latest
    let pricesByTicker = {};
    try {
      const priceQuery = await supabase
        .from('daytrade_screener_latest')
        .select('ticker, last_price, high_price, low_price, change_pct, calculated_at')
        .in('ticker', tickers);

      if (priceQuery.data) {
        for (const p of priceQuery.data) {
          pricesByTicker[p.ticker] = p;
        }
      }
    } catch (_) {}

    let triggeredCount = 0;
    let sentCount = 0;
    const previews = [];
    const nowIso = new Date().toISOString();

    for (const alert of activeAlerts) {
      const px = pricesByTicker[alert.ticker];
      if (!px || px.last_price == null) continue;

      const lastPrice = Number(px.last_price);
      const targetPrice = alert.target_price != null ? Number(alert.target_price) : null;
      let isHit = false;

      if (alert.condition_type === 'PRICE_ABOVE' && targetPrice != null) {
        if (lastPrice >= targetPrice) isHit = true;
      } else if (alert.condition_type === 'PRICE_BELOW' && targetPrice != null) {
        if (lastPrice <= targetPrice) isHit = true;
      } else if (alert.condition_type === 'ENTRY_ZONE' && targetPrice != null) {
        if (Math.abs(lastPrice - targetPrice) / targetPrice <= 0.015) isHit = true;
      } else if (alert.condition_type === 'TP_HIT' && targetPrice != null) {
        if (lastPrice >= targetPrice) isHit = true;
      } else if (alert.condition_type === 'SL_HIT' && targetPrice != null) {
        if (lastPrice <= targetPrice) isHit = true;
      }

      if (isHit) {
        triggeredCount++;
        const msg = formatUserAlertMessage(alert, px, options);

        if (alert.notification_chat_id) {
          if (isDryRun) {
            previews.push({
              alert_id: alert.id,
              ticker: alert.ticker,
              chat_id: alert.notification_chat_id,
              message: msg
            });
          } else {
            try {
              const sendRes = await telegramNotifier.sendTelegramMessage(msg, {
                chat_id: alert.notification_chat_id,
                timeout_ms: 3000
              });
              if (sendRes && sendRes.sent) sentCount++;
            } catch (_) {}
          }
        }

        if (!isDryRun) {
          try {
            await supabase
              .from('app_user_alerts')
              .update({
                is_triggered: true,
                triggered_at: nowIso,
                last_notified_at: nowIso,
                updated_at: nowIso
              })
              .eq('id', alert.id);
          } catch (_) {}
        }
      }
    }

    return {
      success: true,
      evaluated: activeAlerts.length,
      triggered: triggeredCount,
      sent: sentCount,
      previews: previews
    };
  } catch (err) {
    return { success: false, error: err.message || String(err), evaluated: 0, triggered: 0, sent: 0 };
  }
}

module.exports = {
  VALID_ALERT_CONDITIONS,
  normalizeTicker,
  normalizeNumber,
  getUserWatchlist,
  addToWatchlist,
  removeFromWatchlist,
  createAlert,
  deleteAlert,
  formatUserAlertMessage,
  evaluateActiveUserAlerts
};