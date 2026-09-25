'use strict';

/**
 * Telegram interactive bot core (BYOK + admin approval + one-time webview).
 *
 * The long-polling runner lives in tools/telegram-interactive-bot.js. This
 * module owns authorization, command handling, and the one-time chart token
 * so those paths can be tested without a live Telegram connection.
 *
 * Trust boundaries:
 *  - Group chats never receive emails, API keys, or approval cards.
 *  - Only ADMIN_TELEGRAM_ID may approve or reject, and only from a private chat.
 *  - Verification and webview tokens are random, single-use, and bound to the
 *    Telegram id that requested them.
 *  - BYOK keys are encrypted at rest via lib/user-ai-credentials.js and are
 *    never echoed back into a chat.
 */

const crypto = require('crypto');
const fs = require('fs');
const http = require('http');
const path = require('path');

var _credentialsModule = null;
function _getCredentials() {
  if (!_credentialsModule) _credentialsModule = require('./user-ai-credentials');
  return _credentialsModule;
}

const VERIFY_TTL_MS = 5 * 60 * 1000;
const WEBVIEW_TTL_MS = 3 * 60 * 1000;
const GROUP_DENIAL_TTL_MS = 45 * 1000;
const GROUP_RESULT_TTL_MS = 5 * 60 * 1000;
const WELCOME_TTL_MS = 60 * 1000;
// Progress bars removed — plain text steps avoid emoji rendering issues across clients.
const PROGRESS_STEPS = Object.freeze([
  { pct: 30, label: 'Mengambil data lokal' },
  { pct: 60, label: 'Menghitung flow dan teknikal' },
  { pct: 100, label: 'Menyusun kesimpulan final' }
]);

const MARKET_COMMANDS = new Set(['analisa', 'a', 'broksum', 'bs', 'insider', 'in', 'scan', 'tanya']);
const ADMIN_COMMANDS = new Set(['bersihkan', 'limit']);

// Quota constants: weekday limit 15, weekend limit 20
const QUOTA_WEEKDAY_LIMIT = 15;
const QUOTA_WEEKEND_LIMIT = 20;

// Cleanup window defaults: 6 hours back, max 100 messages per call.
const CLEANUP_DEFAULT_HOURS = 6;
const CLEANUP_MAX_MESSAGES = 100;

function nowMs() {
  return Date.now();
}

function randomToken() {
  return crypto.randomBytes(18).toString('base64url');
}

function isGroupChat(chat) {
  const type = chat && chat.type;
  return type === 'group' || type === 'supergroup';
}

function escapeHtml(value) {
  return String(value == null ? '' : value)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');
}

function normalizeTicker(raw) {
  const ticker = String(raw || '').trim().toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (!/^[A-Z]{2,6}[A-Z0-9]{0,4}$/.test(ticker) || ticker.length > 8) return null;
  return ticker;
}

function parseCommand(text) {
  const raw = String(text || '').trim();
  if (!raw.startsWith('/')) return null;
  const [head, ...rest] = raw.split(/\s+/);
  const command = head.slice(1).split('@')[0].toLowerCase();
  return { command, args: rest };
}

function loadDotEnvFile(filePath, env) {
  if (!filePath || !fs.existsSync(filePath)) return;
  const text = fs.readFileSync(filePath, 'utf8');
  for (const line of text.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (!trimmed || trimmed.startsWith('#')) continue;
    const eq = trimmed.indexOf('=');
    if (eq <= 0) continue;
    const key = trimmed.slice(0, eq).trim();
    let value = trimmed.slice(eq + 1).trim();
    if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1);
    }
    if (env[key] == null || env[key] === '') env[key] = value;
  }
}

function loadRuntimeEnv(rootDir, env) {
  const target = env || process.env;
  const root = rootDir || process.cwd();
  loadDotEnvFile(path.join(root, '.env'), target);
  loadDotEnvFile(path.join(root, '.env.intraday-runtime'), target);
  loadDotEnvFile(path.join(root, '.env.local'), target);
  loadDotEnvFile(path.join(root, '.env.bot'), target);
  return target;
}

function formatIdr(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  const sign = n < 0 ? '-' : '';
  const abs = Math.abs(n);
  if (abs >= 1e12) return sign + (abs / 1e12).toFixed(2) + ' T';
  if (abs >= 1e9) return sign + (abs / 1e9).toFixed(2) + ' M';
  if (abs >= 1e6) return sign + (abs / 1e6).toFixed(2) + ' jt';
  return sign + Math.round(abs).toLocaleString('id-ID');
}

function readJson(filePath) {
  return JSON.parse(fs.readFileSync(filePath, 'utf8'));
}

// Get today's date string in WIB (UTC+7), independent of the host timezone.
function getWibDate(now) {
  const source = now instanceof Date ? now : new Date();
  const shifted = new Date(source.getTime() + (7 * 60 * 60 * 1000));
  return shifted.toISOString().slice(0, 10);
}

// Check if today is weekend in WIB (Saturday=6, Sunday=0).
function isWeekend(now) {
  const source = now instanceof Date ? now : new Date();
  const shifted = new Date(source.getTime() + (7 * 60 * 60 * 1000));
  const day = shifted.getUTCDay();
  return day === 0 || day === 6;
}

// Get effective daily limit based on day of week
function getEffectiveLimit(user) {
  const userLimit = user && user.daily_limit != null ? user.daily_limit : QUOTA_WEEKDAY_LIMIT;
  if (isWeekend()) {
    return Math.max(userLimit, QUOTA_WEEKEND_LIMIT);
  }
  return userLimit;
}

// Check if user has remaining quota
function checkQuota(user) {
  const today = getWibDate();
  const effectiveLimit = getEffectiveLimit(user);

  // Reset usage if it's a new day
  if (!user || user.last_usage_date !== today) {
    return { allowed: true, usage: 0, limit: effectiveLimit, remaining: effectiveLimit };
  }

  const usage = user.daily_usage != null ? user.daily_usage : 0;
  const remaining = Math.max(0, effectiveLimit - usage);
  return { allowed: remaining > 0, usage, limit: effectiveLimit, remaining };
}

// Increment daily usage after successful command
async function incrementQuotaUsage(db, telegramId) {
  if (!db || typeof db.from !== 'function') return { ok: false };

  const today = getWibDate();
  const res = await db.from('bot_users').select('daily_usage, last_usage_date').eq('telegram_id', String(telegramId)).maybeSingle();

  if (res.error) return { ok: false, error: res.error };

  const user = res.data;
  if (!user) return { ok: false, error: 'user_not_found' };

  // Reset usage if new day
  const newUsage = (user.last_usage_date !== today) ? 1 : (user.daily_usage || 0) + 1;

  const updateRes = await db.from('bot_users').update({
    daily_usage: newUsage,
    last_usage_date: today
  }).eq('telegram_id', String(telegramId));

  if (updateRes.error) return { ok: false, error: updateRes.error };
  return { ok: true, usage: newUsage };
}

function listBrokerDates(brokerRoot, ticker) {
  const dir = path.join(brokerRoot, ticker);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter((name) => /^\d{4}-\d{2}-\d{2}\.json$/.test(name))
    .map((name) => name.slice(0, 10))
    .sort();
}

function loadBrokerDay(brokerRoot, ticker, date) {
  const filePath = path.join(brokerRoot, ticker, date + '.json');
  if (!fs.existsSync(filePath)) return null;
  const data = readJson(filePath);
  const brokers = Array.isArray(data.brokers) ? data.brokers : [];
  let net = 0;
  let foreignNet = 0;
  const rows = brokers.map((broker) => {
    const nval = Number(broker.nval) || 0;
    const investor = String(broker.investor_type || broker.broker_type || broker.type || '').toLowerCase();
    const foreign = investor === 'foreign' || investor === 'asing' || broker.foreign === true;
    net += nval;
    if (foreign) foreignNet += nval;
    return {
      code: String(broker.broker_code || '').toUpperCase(),
      name: broker.broker_name || broker.broker_code || '',
      nval,
      foreign
    };
  });
  return { date, net, foreignNet, rows };
}

function summarizeFrames(days, frames) {
  const ordered = days.slice().sort((a, b) => a.date < b.date ? -1 : 1);
  const out = {};
  for (const frame of frames) {
    const slice = ordered.slice(-frame);
    out[frame] = {
      sessions: slice.length,
      net: slice.reduce((sum, day) => sum + day.net, 0),
      foreignNet: slice.reduce((sum, day) => sum + day.foreignNet, 0),
      from: slice[0] ? slice[0].date : null,
      to: slice.length ? slice[slice.length - 1].date : null
    };
  }
  return { frames: out, latest: ordered[ordered.length - 1] || null };
}

function defaultDataRoots(rootDir) {
  const root = rootDir || process.cwd();
  return {
    candles: path.join(root, 'data', 'daily-candles'),
    broker: path.join(root, 'data', 'arjum-data', 'broker-summary'),
    insiderNetwork: path.join(root, 'data', 'insider-network', 'network.json'),
    insiderRoster: path.join(root, 'data', 'insider-network', 'roster.json'),
    screener: path.join(root, 'data', 'screener-latest.json')
  };
}

function loadCandles(candleDir, ticker) {
  const filePath = path.join(candleDir, ticker + '.json');
  if (!fs.existsSync(filePath)) return [];
  const data = readJson(filePath);
  const candles = Array.isArray(data) ? data : (data && data.candles) || [];
  return candles
    .filter((row) => row && row.date && Number.isFinite(Number(row.close)))
    .map((row) => ({
      date: String(row.date).slice(0, 10),
      open: Number(row.open),
      high: Number(row.high),
      low: Number(row.low),
      close: Number(row.close),
      volume: Number(row.volume) || 0
    }))
    .sort((a, b) => a.date < b.date ? -1 : 1);
}

function technicalSnapshot(candles) {
  if (!candles.length) return null;
  const last = candles[candles.length - 1];
  const prev = candles.length > 1 ? candles[candles.length - 2] : last;
  const window = candles.slice(-20);
  const ma20 = window.reduce((sum, row) => sum + row.close, 0) / window.length;
  const avgVol = window.reduce((sum, row) => sum + row.volume, 0) / window.length;
  const changePct = prev.close ? ((last.close - prev.close) / prev.close) * 100 : 0;
  return {
    date: last.date,
    close: last.close,
    changePct,
    ma20,
    volumeRatio: avgVol ? last.volume / avgVol : null,
    sessions: candles.length
  };
}

function loadInsider(roots, ticker) {
  const roster = fs.existsSync(roots.insiderRoster) ? readJson(roots.insiderRoster) : null;
  const network = fs.existsSync(roots.insiderNetwork) ? readJson(roots.insiderNetwork) : null;
  const holders = roster && roster.tickers && Array.isArray(roster.tickers[ticker])
    ? roster.tickers[ticker]
    : [];
  const links = network && network.networks_by_ticker && network.networks_by_ticker[ticker]
    ? network.networks_by_ticker[ticker]
    : null;
  return { holders: holders.slice(0, 8), links };
}

function loadScreener(filePath) {
  if (!filePath || !fs.existsSync(filePath)) {
    return { daytrade: [], swing: [], top5: [], updatedAt: null, missing: true };
  }
  const data = readJson(filePath);
  return {
    daytrade: data.daytrade || data.dayTrade || [],
    swing: data.swing || [],
    top5: data.top5 || data.fusion || [],
    updatedAt: data.updated_at || data.updatedAt || null,
    missing: false
  };
}

// System prompt for market analysis: natural flowing text, no bullets, asterisks, or semicolons.
const MARKET_ANALYSIS_SYSTEM = (
  'Kamu analis saham berpengalaman. Tulislah ulasan chart yang mengalir alami, ' +
  'nyaman dibaca di layar HP. Pakai paragraf ringkas, jeda baris natural, ' +
  'tanpa tanda bintang, tanpa dash bullet, tanpa titik koma. ' +
  'Selalu gunakan data candle 30 hari terakhir yang tersedia. ' +
  'Jangan tambahkan angka di luar data yang diberikan.'
);

function normalizeRangeDays(rangeDays) {
  const days = Number(rangeDays);
  return days === 7 || days === 30 ? days : 1;
}

function buildMarketContext(roots, ticker, asOfDate, rangeDays) {
  const range = normalizeRangeDays(rangeDays);
  const candles = loadCandles(roots.candles, ticker);
  const selected = asOfDate
    ? candles.filter((row) => row.date <= asOfDate)
    : candles;
  const dates = listBrokerDates(roots.broker, ticker)
    .filter((date) => !asOfDate || date <= asOfDate);
  const days = [];
  for (const date of dates.slice(-range)) {
    const day = loadBrokerDay(roots.broker, ticker, date);
    if (day) days.push(day);
  }
  const latestDate = selected.length ? selected[selected.length - 1].date : null;
  return {
    ticker,
    rangeDays: range,
    asOf: asOfDate || latestDate,
    candles30d: selected.slice(-range),
    technical: technicalSnapshot(selected.slice(-range)),
    broker: summarizeFrames(days, [range]),
    insider: loadInsider(roots, ticker)
  };
}

function formatBrokerCard(context) {
  const range = normalizeRangeDays(context.rangeDays);
  const frames = context.broker.frames;
  const lines = [
    '<b>' + escapeHtml(context.ticker) + '</b> broker summary',
    'Rentang: ' + range + 'D'
  ];
  const row = frames[range];
  if (row) {
    lines.push(
      range + 'D (' + row.sessions + ' sesi): net ' + formatIdr(row.net) +
      ' | asing ' + formatIdr(row.foreignNet)
    );
  }
  const latest = context.broker.latest;
  if (latest) {
    const ranked = latest.rows.slice().sort((a, b) => Math.abs(b.nval) - Math.abs(a.nval)).slice(0, 5);
    lines.push('');
    lines.push('Top broker ' + latest.date + ':');
    for (const row of ranked) {
      lines.push(row.code + ' ' + (row.nval >= 0 ? 'AKUM' : 'DIST') + ' ' + formatIdr(row.nval));
    }
  } else {
    lines.push('Data broker lokal tidak ditemukan.');
  }
  return lines.join('\n');
}

function formatInsiderCard(context) {
  const lines = ['<b>' + escapeHtml(context.ticker) + '</b> insider'];
  if (!context.insider.holders.length) {
    lines.push('Data kepemilikan lokal tidak ditemukan.');
    return lines.join('\n');
  }
  for (const holder of context.insider.holders.slice(0, 5)) {
    lines.push(
      escapeHtml(holder.name) + ' · ' + escapeHtml(holder.percentage_formatted || holder.percentage || '—') +
      ' · ' + escapeHtml(holder.category || holder.position || '')
    );
  }
  return lines.join('\n');
}

// Clean scan card: no bullet characters, no semicolons, natural paragraphs.
function formatScanCard(snapshot, mode) {
  const key = mode === 'swing' ? 'swing' : mode === 'top5' ? 'top5' : 'daytrade';
  const rows = Array.isArray(snapshot[key]) ? snapshot[key] : [];
  if (snapshot.missing) return 'Snapshot screener lokal belum tersedia.';
  if (!rows.length) return 'Tidak ada kandidat pada snapshot terakhir untuk mode ' + escapeHtml(key) + '.';
  const top = rows.slice(0, 5);
  const header = 'Scan ' + escapeHtml(key) + ' (' + top.length + ' teratas)';
  const body = top.map((row, index) => {
    const ticker = row.ticker || row.symbol || '—';
    const score = row.score != null ? row.score : row.fusion_score;
    return (index + 1) + '. ' + escapeHtml(ticker) + (score != null ? ' (score ' + escapeHtml(String(score)) + ')' : '');
  });
  return [header, '', body.join('\n')].join('\n');
}

// Progress steps: no bullet characters, no semicolons, plain natural paragraphs.
function progressText(step) {
  return step.pct + '% ' + step.label + '...';
}

function verificationKeyboard(url) {
  return { inline_keyboard: [[{ text: 'Verifikasi akses', url }]] };
}

function timeframeKeyboard(command, ticker, rangeDays) {
  const selected = normalizeRangeDays(rangeDays);
  const buttons = [
    { days: 1, text: '📊 1D (Hari Ini)' },
    { days: 7, text: '📅 7D' },
    { days: 30, text: '📈 30D' }
  ];
  return {
    inline_keyboard: [buttons.map((button) => ({
      text: button.days === selected ? '✅ ' + button.text : button.text,
      callback_data: 'tf:' + command + ':' + ticker + ':' + button.days
    }))]
  };
}

const GROUP_PRIVACY_NOTE = 'Hasil analisa di grup akan otomatis dihapus setelah 5 menit demi privasi.';

function approvalKeyboard(telegramId) {
  return {
    inline_keyboard: [[
      { text: '✅ Approve', callback_data: 'approve:' + telegramId },
      { text: '❌ Reject', callback_data: 'reject:' + telegramId }
    ]]
  };
}

function createSupabaseClient(env, createClient) {
  if (!env.SUPABASE_URL || !env.SUPABASE_SERVICE_ROLE_KEY || typeof createClient !== 'function') return null;
  return createClient(env.SUPABASE_URL, env.SUPABASE_SERVICE_ROLE_KEY, {
    auth: { persistSession: false, autoRefreshToken: false }
  });
}

function createInteractiveBot(options) {
  const opts = options || {};
  const env = opts.env || process.env;
  const rootDir = opts.rootDir || process.cwd();
  const roots = Object.assign(defaultDataRoots(rootDir), opts.dataRoots || {});
  const db = opts.db !== undefined ? opts.db : createSupabaseClient(env, opts.createClient);
  const clock = opts.now || nowMs;
  const verifyTokens = new Map();
  const webviewTokens = new Map();
  const adminId = String(env.ADMIN_TELEGRAM_ID || '').trim();
  const verifyUsername = String(env.VERIFY_BOT_USERNAME || 'AutoCuanVerifyBot').replace(/^@/, '');
  const publicBase = String(env.BOT_PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const delays = Object.assign({
    denial: GROUP_DENIAL_TTL_MS,
    result: GROUP_RESULT_TTL_MS,
    welcome: WELCOME_TTL_MS
  }, opts.delays || {});
  const credentials = opts.credentials || _getCredentials();

  function purge(map) {
    const now = clock();
    for (const [token, entry] of map) {
      if (entry.expiresAt <= now) map.delete(token);
    }
  }

  function issueVerifyToken(telegramId) {
    purge(verifyTokens);
    const token = randomToken();
    verifyTokens.set(token, {
      telegramId: String(telegramId),
      expiresAt: clock() + VERIFY_TTL_MS
    });
    return token;
  }

  function consumeVerifyToken(token, telegramId) {
    purge(verifyTokens);
    const entry = verifyTokens.get(token);
    if (!entry) return { ok: false, reason: 'expired' };
    verifyTokens.delete(token);
    if (String(entry.telegramId) !== String(telegramId)) return { ok: false, reason: 'mismatch' };
    if (entry.expiresAt <= clock()) return { ok: false, reason: 'expired' };
    return { ok: true, telegramId: String(telegramId) };
  }

  function issueWebviewToken(payload) {
    purge(webviewTokens);
    const token = randomToken();
    webviewTokens.set(token, {
      payload,
      expiresAt: clock() + WEBVIEW_TTL_MS,
      used: false
    });
    return token;
  }

  function consumeWebviewToken(token) {
    purge(webviewTokens);
    const entry = webviewTokens.get(token);
    if (!entry || entry.used || entry.expiresAt <= clock()) {
      webviewTokens.delete(token);
      return null;
    }
    entry.used = true;
    webviewTokens.delete(token);
    return entry.payload;
  }

  async function getBotUser(telegramId) {
    if (!db || typeof db.from !== 'function') return null;
    const res = await db.from('bot_users').select('*').eq('telegram_id', String(telegramId)).maybeSingle();
    if (res.error) throw new Error('bot_users_read_failed');
    return res.data || null;
  }

  async function upsertBotUser(patch) {
    if (!db || typeof db.from !== 'function') return { ok: false, error: 'db_unconfigured' };
    const res = await db.from('bot_users').upsert(patch, { onConflict: 'telegram_id' });
    if (res.error) return { ok: false, error: 'bot_users_write_failed' };
    return { ok: true };
  }

  function isAdmin(from) {
    return adminId && String(from && from.id) === adminId;
  }

  async function requireApproved(ctx) {
    const from = ctx.from || {};
    const user = await getBotUser(from.id);
    if (user && user.status === 'approved') return { ok: true, user };
    if (isGroupChat(ctx.chat)) {
      const token = issueVerifyToken(from.id);
      const url = 'https://t.me/' + verifyUsername + '?start=verify_' + from.id;
      const sent = await ctx.reply('Akses Belum Terverifikasi', {
        reply_markup: verificationKeyboard(url)
      });
      if (sent && sent.message_id != null && typeof ctx.deleteMessage === 'function') {
        const timer = setTimeout(() => {
          ctx.deleteMessage(sent.message_id).catch(() => {});
        }, delays.denial);
        if (typeof timer.unref === 'function') timer.unref();
      }
    } else {
      await ctx.reply('Akses Belum Terverifikasi. Buka chat ini lalu kirim /start untuk mendaftar.');
    }
    return { ok: false, user };
  }

// Admin quota control: /limit <telegram_id> <amount> or inline buttons
  async function handleAdminQuota(ctx) {
    if (!isAdmin(ctx.from) || isGroupChat(ctx.chat)) return false;

    const parsed = parseCommand(ctx.message && ctx.message.text);
    if (!parsed || parsed.command !== 'limit') return false;

    const args = parsed.args || [];
    if (args.length < 2) {
      await ctx.reply(
        'Format: /limit <TELEGRAM_ID> <JUMLAH_LIMIT>\n' +
        'Contoh: /limit 123456789 20\n' +
        '\n' +
        'Atau lihat daftar user dengan tombol di bawah.'
      );
      return true;
    }

    const telegramId = args[0];
    const amount = parseInt(args[1], 10);

    if (isNaN(amount) || amount < 1 || amount > 100) {
      await ctx.reply('Jumlah limit harus angka antara 1-100.');
      return true;
    }

    const updateRes = await upsertBotUser({
      telegram_id: telegramId,
      daily_limit: amount,
      updated_at: new Date(clock()).toISOString()
    });

    if (!updateRes.ok) {
      await ctx.reply('Gagal update limit user ' + telegramId + '.');
    } else {
      await ctx.reply('✅ Limit user ' + telegramId + ' di-set ke ' + amount + '.');
    }
    return true;
  }

  // Callback data handlers for admin quota controls
  async function handleQuotaCallback(ctx) {
    const data = String(ctx.callbackQuery && ctx.callbackQuery.data || '');
    const match = data.match(/^quota_(adjust|reduce|reset):(\d+)$/);
    if (!match) return false;

    if (!isAdmin(ctx.from) || isGroupChat(ctx.chat)) {
      await ctx.answerCbQuery('Tidak diizinkan.');
      return true;
    }

    const action = match[1];
    const telegramId = match[2];
    const today = getWibDate();

    let updateData = { updated_at: new Date(clock()).toISOString() };
    let message = '';

    if (action === 'reset') {
      updateData.daily_usage = 0;
      updateData.last_usage_date = today;
      message = '✅ Quota user ' + telegramId + ' di-reset untuk hari ini.';
    } else if (action === 'adjust' || action === 'reduce') {
      const user = await getBotUser(telegramId);
      const currentLimit = user && user.daily_limit ? user.daily_limit : QUOTA_WEEKDAY_LIMIT;
      const delta = action === 'reduce' ? -5 : 5;
      updateData.daily_limit = Math.max(1, Math.min(100, currentLimit + delta));
      message = '✅ Limit user ' + telegramId + ' diubah jadi ' + updateData.daily_limit + '.';
    }

    const updateRes = await upsertBotUser({
      telegram_id: telegramId,
      ...updateData
    });

    if (!updateRes.ok) {
      await ctx.answerCbQuery('Gagal update quota.');
    } else {
      await ctx.answerCbQuery('Berhasil!');
      await ctx.editMessageText(message);
    }
    return true;
  }

  // Format quota info card for admin display
  function formatQuotaCard(user) {
    const quota = checkQuota(user);
    const limit = getEffectiveLimit(user);
    const lines = [
      '📊 Quota User: ' + (user.username ? '@' + user.username : user.telegram_id),
      'Telegram ID: ' + user.telegram_id,
      'Status: ' + user.status,
      '',
      'Batas Harian: ' + limit + '/hari',
      'Pemakaian Hari Ini: ' + quota.usage + '/' + limit,
      'Sisa: ' + quota.remaining + '/' + limit
    ];

    const keyboard = {
      inline_keyboard: [[
        { text: '+5 Limit', callback_data: 'quota_adjust:' + user.telegram_id },
        { text: '-5 Limit', callback_data: 'quota_reduce:' + user.telegram_id },
        { text: 'Reset Hari Ini', callback_data: 'quota_reset:' + user.telegram_id }
      ]]
    };

    return { text: lines.join('\n'), keyboard };
  }

  async function handleStart(ctx) {
    const payload = String((ctx.startPayload || '')).trim();
    const match = payload.match(/^auth_(\d+)_([A-Za-z0-9_-]+)$/);
    if (match) {
      const consumed = consumeVerifyToken(match[2], ctx.from && ctx.from.id);
      if (!consumed.ok || consumed.telegramId !== match[1]) {
        await ctx.reply('Tautan verifikasi tidak berlaku. Minta tautan baru dari grup.');
        return;
      }
      // Clean BYOK setup guide — no bullet dashes, no semicolons.
      await ctx.reply(
        'Verifikasi identitas berhasil.\n\n' +
        'Balas dengan dua baris berikut:\n\n' +
        'Baris 1: email@gmail.com\n' +
        'Baris 2: GEMINI API_KEY_ANDA\n\n' +
        'Contoh:\n' +
        'nama@gmail.com\n' +
        'GEMINI AQxxxxxxxxxxxxxxxxxxxxx\n\n' +
        'GEMINI = Google Gemini (gratis, buat di aistudio.google.com/app/apikey)\n' +
        'CUSTOM = provider AI lain (wajib sertakan Base URL di baris kedua).'
      );
      return;
    }
    const user = ctx.from && ctx.from.id != null ? await getBotUser(ctx.from.id) : null;
    const status = user ? user.status : 'baru';
    const provider = user && user.provider ? user.provider : 'belum diatur';
    const quota = checkQuota(user);
    await ctx.reply(
      'Auto-Cuan Interactive Bot\n\n' +
      'Status Akun & BYOK\n' +
      'Status: ' + status + '\n' +
      'BYOK: ' + provider + '\n' +
      'Sisa Kuota Hari Ini: ' + quota.remaining + '/' + quota.limit + ' (Reset 00:00 WIB)\n\n' +
      'Perintah yang tersedia:\n' +
      '/analisa <KODE_SAHAM> — Analisa chart + bandar flow (Contoh: /analisa BBCA)\n' +
      '/broksum <KODE_SAHAM> — Rangkuman broker asing (Contoh: /broksum BBRI)\n' +
      '/insider <KODE_SAHAM> — Jaringan kepemilikan orang dalam (Contoh: /insider BREN)\n' +
      '/scan <daytrade|swing|top5> — Screener saham otomatis (Contoh: /scan daytrade)\n' +
      '/tanya <pertanyaan> — Tanya AI seputar market (Contoh: /tanya prospek IHSG)\n\n' +
      GROUP_PRIVACY_NOTE
    );
  }

  // Probe a Gemini API key with a minimal, low-cost generateContent call.
  // Returns { ok: true } on success, or { ok: false, error: string } on failure.
  async function probeGeminiKey(apiKey, fetchFn) {
    const probe = opts.gemini || require('./ai-gemini-provider');
    try {
      await probe.generateGeminiContent({
        apiKey,
        prompt: 'ok',
        fetchFn,
        timeoutMs: 15000,
        model: env.GEMINI_MODEL
      });
      return { ok: true };
    } catch (err) {
      const msg = err && (err.message || String(err));
      if (msg.includes('QUOTA_EXCEEDED') || msg.includes('429') || msg.includes('RESOURCE_EXHAUSTED')) {
        return { ok: false, error: 'Kuota Gemini tercapai. Periksa status kunci di aistudio.google.com/app/apikey.' };
      }
      if (msg.includes('API_KEY_INVALID') || msg.includes('400') || msg.includes('401')) {
        return { ok: false, error: 'API key tidak valid. Pastikan kunci yang dipakai sudah benar dan aktif di Google AI Studio.' };
      }
      return { ok: false, error: 'Koneksi ke Gemini gagal. Periksa again nanti.' };
    }
  }

  // Delete the user's message that contains raw credentials for privacy.
  // Silently ignores errors (no admin perms, message too old, etc.).
  async function deleteUserCredentialMessage(ctx) {
    const msgId = ctx.message && ctx.message.message_id;
    if (msgId == null) return;
    try {
      await ctx.deleteMessage(msgId);
    } catch (_) {
      // Not an admin in the group, or message is too old to delete.
    }
  }

  async function handleRegistration(ctx, text) {
    if (isGroupChat(ctx.chat)) return false;
    const lines = String(text || '').split(/\r?\n/).map((line) => line.trim()).filter(Boolean);
    if (lines.length < 2 || !/@gmail\.com$/i.test(lines[0])) return false;

    // Immediately delete the credential message for privacy.
    await deleteUserCredentialMessage(ctx);

    const email = lines[0].toLowerCase();
    const parts = lines[1].split(/\s+/);
    const provider = String(parts[0] || '').toLowerCase() === 'custom' ? 'custom' : 'gemini';
    const apiKey = parts.slice(1).join('').trim();

    // Health-check Gemini key before storing (skipped in test mode via skipProbe).
    if (provider === 'gemini' && !opts.skipProbe) {
      const probeResult = await probeGeminiKey(apiKey, opts.fetchFn || globalThis.fetch);
      if (!probeResult.ok) {
        await ctx.reply('Kunci AI ditolak: ' + probeResult.error);
        return true;
      }
    }

    const saved = await credentials.saveUserApiKey(db, String(ctx.from.id), apiKey, provider);
    if (!saved.ok) {
      await ctx.reply('API key ditolak: ' + saved.error);
      return true;
    }

    // Confirm deletion of original message.
    await ctx.reply('Kunci AI berhasil disimpan dan pesan kredensial telah dihapus demi keamanan.\nMenunggu persetujuan admin.');

    const savedUser = await upsertBotUser({
      telegram_id: String(ctx.from.id),
      username: ctx.from.username || null,
      gmail: email,
      provider,
      status: 'pending',
      updated_at: new Date(clock()).toISOString()
    });
    if (!savedUser.ok) {
      await credentials.deleteUserApiKey(db, String(ctx.from.id), provider);
      await ctx.reply('Pendaftaran gagal disimpan. API key tidak disimpan. Coba lagi nanti.');
      return true;
    }
    if (!adminId) return true;
    const card = [
      'Pendaftaran bot baru',
      'Username: @' + (ctx.from.username || '—'),
      'Telegram ID: ' + ctx.from.id,
      'Email: ' + email,
      'Provider: ' + provider
    ].join('\n');
    await ctx.telegram.sendMessage(adminId, card, {
      reply_markup: approvalKeyboard(ctx.from.id)
    });
    return true;
  }

  async function handleApproval(ctx) {
    const data = String(ctx.callbackQuery && ctx.callbackQuery.data || '');
    const match = data.match(/^(approve|reject):(\d+)$/);
    if (!match) return false;
    if (!isAdmin(ctx.from) || isGroupChat(ctx.chat)) {
      await ctx.answerCbQuery('Tidak diizinkan.');
      return true;
    }
    const action = match[1];
    const telegramId = match[2];
    const status = action === 'approve' ? 'approved' : 'rejected';
    const written = await upsertBotUser({
      telegram_id: telegramId,
      status,
      updated_at: new Date(clock()).toISOString()
    });
    if (!written.ok) {
      await ctx.answerCbQuery('Gagal menyimpan status.');
      return true;
    }
    await ctx.editMessageText(status === 'approved' ? '✅ Disetujui oleh Admin' : '❌ Ditolak oleh Admin');
    await ctx.answerCbQuery(status === 'approved' ? 'Disetujui' : 'Ditolak');
    if (status === 'approved' && env.BOT_GROUP_ID && ctx.telegram) {
      const user = await getBotUser(telegramId);
      const username = user && user.username ? '@' + user.username : telegramId;
      const sent = await ctx.telegram.sendMessage(
        env.BOT_GROUP_ID,
        'Selamat bergabung ' + username + ', akses bot kamu telah disetujui.'
      );
      if (sent && sent.message_id != null) {
        const timer = setTimeout(() => {
          ctx.telegram.deleteMessage(env.BOT_GROUP_ID, sent.message_id).catch(() => {});
        }, delays.welcome);
        if (typeof timer.unref === 'function') timer.unref();
      }
    }
    return true;
  }

  async function runProgress(ctx, producer, extra) {
    const sent = await ctx.reply(progressText(PROGRESS_STEPS[0]));
    const messageId = sent && sent.message_id;
    if (messageId != null && typeof ctx.telegram.editMessageText === 'function') {
      await ctx.telegram.editMessageText(ctx.chat.id, messageId, undefined, progressText(PROGRESS_STEPS[1]));
    }
    const text = await producer();
    if (messageId != null && typeof ctx.telegram.editMessageText === 'function') {
      await ctx.telegram.editMessageText(ctx.chat.id, messageId, undefined, progressText(PROGRESS_STEPS[2]));
      await ctx.telegram.editMessageText(ctx.chat.id, messageId, undefined, text, Object.assign({
        parse_mode: 'HTML'
      }, extra || {}));
    }
    if (isGroupChat(ctx.chat) && messageId != null) {
      const timer = setTimeout(() => {
        ctx.deleteMessage(messageId).catch(() => {});
      }, delays.result);
      if (typeof timer.unref === 'function') timer.unref();
    }
    return text;
  }

// Accepts an optional { marketAnalysis: bool } to inject the clean trader style prompt.
  async function callByok(user, prompt, opts2) {
    const provider = (user && user.provider) || 'gemini';
    const secret = await credentials.getUserApiKey(db, String(user.telegram_id || user.id), provider);
    if (!secret.hasKey) {
      return 'Kunci BYOK belum tersedia. Kirim ulang email dan API key lewat chat pribadi.';
    }
    const fetchFn = opts.fetchFn || globalThis.fetch;
    // Inject clean market-analysis style when requested.
    const effectivePrompt = (opts2 && opts2.marketAnalysis) ? MARKET_ANALYSIS_SYSTEM + '\n\n' + prompt : prompt;
    if (provider === 'gemini') {
      const gemini = opts.gemini || require('./ai-gemini-provider');
      const result = await gemini.generateGeminiContent({
        apiKey: secret.apiKey,
        prompt: effectivePrompt,
        fetchFn,
        timeoutMs: 20000,
        model: env.GEMINI_MODEL
      });
      return result.text;
    }
    const endpoint = env.CUSTOM_AI_BASE_URL;
    if (!endpoint) return 'Provider custom belum dikonfigurasi di server.';
    let parsed;
    try { parsed = new URL(endpoint); } catch (_) { return 'Provider custom tidak valid.'; }
    if (parsed.protocol !== 'https:' || parsed.username || parsed.password) {
      return 'Provider custom harus HTTPS tanpa kredensial di URL.';
    }
    const response = await fetchFn(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + secret.apiKey
      },
      body: JSON.stringify({ prompt: effectivePrompt })
    });
    if (!response.ok) return 'Provider custom menolak permintaan.';
    const body = await response.json();
    return String(body.text || body.answer || '').slice(0, 3500) || 'Provider custom tidak mengembalikan teks.';
  }

  async function renderMarketCard(ctx, user, command, ticker, rangeDays) {
    const range = normalizeRangeDays(rangeDays);
    const context = buildMarketContext(roots, ticker, null, range);
    const keyboard = timeframeKeyboard(command, ticker, range);
    let text = formatBrokerCard(context);
    if (command === 'analisa') {
      const token = issueWebviewToken({ ticker, asOf: context.asOf, telegramId: String(ctx.from.id) });
      const link = publicBase ? publicBase + '/webview/' + token : '/webview/' + token;
      const narrative = await callByok(user, JSON.stringify({
        ticker,
        rangeDays: range,
        question: 'Buat kesimpulan singkat berbasis data lokal ini. Jangan menambah angka di luar data.',
        context
      }), { marketAnalysis: true });
      text += '\n\n' + narrative + '\n\nChart sekali pakai (5 menit):\n' + link;
    }
    text += '\n\n' + GROUP_PRIVACY_NOTE;
    return { text, keyboard };
  }

  async function handleTimeframe(ctx) {
    const data = String(ctx.callbackQuery && ctx.callbackQuery.data || '');
    const match = data.match(/^tf:(analisa|broksum):([A-Z0-9]{2,8}):(1|7|30)$/);
    if (!match) return false;
    const access = await requireApproved(ctx);
    if (!access.ok) {
      await ctx.answerCbQuery('Akses belum terverifikasi.');
      return true;
    }
    const command = match[1];
    const ticker = match[2];
    const range = Number(match[3]);
    const card = await renderMarketCard(ctx, access.user, command, ticker, range);
    await ctx.editMessageText(card.text, {
      parse_mode: 'HTML',
      reply_markup: card.keyboard
    });
    await ctx.answerCbQuery('Rentang ' + range + 'D');
    return true;
  }

  async function handleMarket(ctx, parsed) {
    const access = await requireApproved(ctx);
    if (!access.ok) return;
    const command = parsed.command;
    const quotaCommand = command === 'analisa' || command === 'a' ||
      command === 'broksum' || command === 'bs' ||
      command === 'tanya';

    // Daily quota applies only to /analisa, /broksum, and /tanya. Admins are exempt.
    if (quotaCommand && !isAdmin(ctx.from)) {
      const quota = checkQuota(access.user);
      if (!quota.allowed) {
        await ctx.reply(
          'Jatah harian habis (' + quota.usage + '/' + quota.limit + ').\n' +
          'Kuota akan di-reset pukul 00:00 WIB.'
        );
        return;
      }
    }
    let finalText = '';

    if (command === 'scan') {
      const mode = String(parsed.args[0] || 'daytrade').toLowerCase();
      const snapshot = opts.loadScreener ? opts.loadScreener() : loadScreener(roots.screener);
      finalText = await runProgress(ctx, async () => formatScanCard(snapshot, mode));
    } else if (command === 'tanya') {
      const question = parsed.args.join(' ').trim().slice(0, 500);
      if (!question) {
        await ctx.reply('Gunakan /tanya <pertanyaan>.');
        return;
      }
      finalText = await runProgress(ctx, async () => callByok(access.user, question));
    } else {
      const ticker = normalizeTicker(parsed.args[0]);
      if (!ticker) {
        await ctx.reply('Ticker tidak valid. Gunakan /analisa <KODE_SAHAM>.');
        return;
      }
      const context = buildMarketContext(roots, ticker, null, 1);

      if (command === 'broksum' || command === 'bs') {
        const card = await renderMarketCard(ctx, access.user, 'broksum', ticker, 1);
        finalText = await runProgress(ctx, async () => card.text, { reply_markup: card.keyboard });
      } else if (command === 'insider' || command === 'in') {
        finalText = await runProgress(ctx, async () => formatInsiderCard(context));
      } else {
        const card = await renderMarketCard(ctx, access.user, 'analisa', ticker, 1);
        finalText = await runProgress(ctx, async () => card.text, { reply_markup: card.keyboard });
      }
    }

    // Increment quota usage and show remaining quota (skip for admins)
    if (quotaCommand && !isAdmin(ctx.from) && db) {
      const incResult = await incrementQuotaUsage(db, ctx.from.id);
      if (incResult.ok) {
        const updatedUser = { ...access.user, daily_usage: incResult.usage, last_usage_date: getWibDate() };
        const quota = checkQuota(updatedUser);
        if (finalText) {
          await ctx.reply(finalText + '\n\n📊 Sisa kuota hari ini: ' + quota.remaining + '/' + quota.limit);
        }
      }
    }
  }

  // Admin command /bersihkan: delete transient bot messages and user commands in the group.
  // Only ADMIN_TELEGRAM_ID may invoke this. Broadcasts and signal posts are preserved.
  async function handleBersihkan(ctx) {
    if (!isAdmin(ctx.from)) return; // Silently ignore non-admin calls.
    if (isGroupChat(ctx.chat)) {
      await ctx.reply('Perintah /bersihkan hanya bisa dari chat pribadi.').catch(() => {});
      return;
    }
    const parsed = parseCommand(ctx.message && ctx.message.text);
    const rawHours = parsed && parsed.args && parsed.args[0];
    const hours = Math.min(Math.max(parseInt(rawHours, 10) || CLEANUP_DEFAULT_HOURS, 1), 72);
    const cutoffTs = Math.floor(Date.now() / 1000) - hours * 3600;
    const groupId = env.BOT_GROUP_ID;
    if (!groupId) {
      await ctx.reply('BOT_GROUP_ID belum dikonfigurasi.').catch(() => {});
      return;
    }
    const sent = await ctx.reply('Membersihkan riwayat grup dalam '
      + hours + ' jam terakhir, mohon tunggu...').catch(() => null);
    let deletedCount = 0;
    let passCount = 0;
    const maxPasses = 10;
    for (passCount = 0; passCount < maxPasses; passCount++) {
      try {
        const updates = await ctx.telegram._api.call(ctx.telegram, 'getUpdates', {
          offset: 0,
          limit: 100,
          timeout: 0,
          allowed_updates: ['message']
        }, true);
        // Using raw getUpdates through the bot API token directly.
        // Fetch via raw HTTP to avoid framework overhead.
        const rawToken = env.BOT_TOKEN;
        const fetchFn = opts.fetchFn || globalThis.fetch;
        const resp = await fetchFn(
          'https://api.telegram.org/bot' + rawToken + '/getUpdates?limit=100&timeout=0&allowed_updates=message',
          { method: 'GET' }
        );
        const data = await resp.json();
        const messages = (data.result || []).filter((m) => {
          if (!m.message) return false;
          if (String(m.message.chat.id) !== String(groupId)) return false;
          if (m.message.date < cutoffTs) return false;
          const text = m.message.text || m.message.caption || '';
          // Never delete broadcast/signal/official posts.
          const isProtected = /^(📊|📈|📉|🔔|✅|🔴|🟢|Selamat|Top 5|Rangkuman|HOT SECTOR|Sector)/i.test(text);
          if (isProtected) return false;
          // Only delete bot commands and transient user interactions.
          const isBotCmd = /^\/(analisa|broksum|insider|scan|tanya|start|bersihkan)/i.test(text);
          if (isBotCmd) return true;
          // Delete bot's own transient responses (short length, no protected emoji).
          if (m.message.from && m.message.from.is_bot && text.length < 400) return true;
          return false;
        });
        if (!messages.length) break;
        for (const m of messages.slice(0, CLEANUP_MAX_MESSAGES)) {
          try {
            await ctx.telegram.deleteMessage(groupId, m.message.message_id);
            deletedCount++;
          } catch (_) {}
        }
        if (messages.length < CLEANUP_MAX_MESSAGES) break;
      } catch (e) {
        break;
      }
    }
    const confirm = 'Pembersihan selesai. '
      + deletedCount + ' pesan transient dihapus dari grup ('
      + hours + ' jam terakhir).';
    if (sent && sent.message_id != null) {
      await ctx.reply(confirm).catch(() => {});
      const confirmSent = sent; // use variable from outer scope
      setTimeout(() => {
        ctx.deleteMessage(confirmSent.message_id).catch(() => {});
      }, 10000).unref?.();
      setTimeout(() => {
        ctx.deleteMessage(sent.message_id).catch(() => {});
      }, 10000).unref?.();
    } else {
      await ctx.reply(confirm).catch(() => {});
    }
  }

  async function handleUpdate(ctx) {
    if (ctx.callbackQuery) {
      const data = String(ctx.callbackQuery.data || '');
      if (data.startsWith('quota_')) return handleQuotaCallback(ctx);
      if (data.startsWith('tf:')) return handleTimeframe(ctx);
      return handleApproval(ctx);
    }
    const text = ctx.message && ctx.message.text;
    const parsed = parseCommand(text);
    if (parsed && parsed.command === 'start') return handleStart(ctx);
    if (parsed && parsed.command === 'bersihkan') return handleBersihkan(ctx);
    if (parsed && parsed.command === 'limit') return handleAdminQuota(ctx);
    if (parsed && MARKET_COMMANDS.has(parsed.command)) return handleMarket(ctx, parsed);
    if (!parsed && text) return handleRegistration(ctx, text);
    return false;
  }

  function renderWebview(payload) {
    const ticker = escapeHtml(payload.ticker);
    const points = JSON.stringify(payload.candles || []);
    return '<!doctype html><meta charset="utf-8"><title>' + ticker + '</title>' +
      '<body style="font-family:sans-serif;background:#0f172a;color:#e2e8f0">' +
      '<h1>' + ticker + '</h1><p>Chart sekali pakai. Token sudah hangus.</p>' +
      '<svg id="c" width="640" height="240"></svg><script>const p=' + points +
      ';const s=document.getElementById("c");if(p.length){const w=640,h=240,min=Math.min(...p.map(x=>x.low)),max=Math.max(...p.map(x=>x.high));let d="";p.forEach((c,i)=>{const x=i*(w/Math.max(1,p.length-1));const y=h-((c.close-min)/Math.max(1,max-min))*h;d+=(i?"L":"M")+x+","+y});const path=document.createElementNS("http://www.w3.org/2000/svg","path");path.setAttribute("d",d);path.setAttribute("stroke","#38bdf8");path.setAttribute("fill","none");s.appendChild(path);}</script></body>';
  }

  function createWebServer() {
    return http.createServer((req, res) => {
      const match = String(req.url || '').match(/^\/webview\/([A-Za-z0-9_-]+)$/);
      if (!match) {
        res.writeHead(404, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Not found');
        return;
      }
      const payload = consumeWebviewToken(match[1]);
      if (!payload) {
        res.writeHead(410, { 'Content-Type': 'text/plain; charset=utf-8' });
        res.end('Tautan sudah hangus.');
        return;
      }
      const candles = loadCandles(roots.candles, payload.ticker).slice(-60);
      res.writeHead(200, {
        'Content-Type': 'text/html; charset=utf-8',
        'Cache-Control': 'no-store',
        'X-Content-Type-Options': 'nosniff',
        'Referrer-Policy': 'no-referrer'
      });
      res.end(renderWebview({ ticker: payload.ticker, candles }));
    });
  }

  return {
    handleUpdate,
    issueVerifyToken,
    consumeVerifyToken,
    issueWebviewToken,
    consumeWebviewToken,
    createWebServer,
    buildMarketContext,
    constants: {
      VERIFY_TTL_MS,
      WEBVIEW_TTL_MS,
      GROUP_DENIAL_TTL_MS,
      GROUP_RESULT_TTL_MS,
      WELCOME_TTL_MS,
      PROGRESS_STEPS
    }
  };
}

module.exports = {
  createInteractiveBot,
  loadRuntimeEnv,
  parseCommand,
  normalizeTicker,
  buildMarketContext,
  defaultDataRoots,
  PROGRESS_STEPS,
  getWibDate,
  isWeekend,
  getEffectiveLimit,
  checkQuota,
  incrementQuotaUsage
};
