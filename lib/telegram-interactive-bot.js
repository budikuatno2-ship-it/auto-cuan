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
const { execFileSync } = require('child_process');

var _credentialsModule = null;
// Hybrid AI evaluator (Vercel primer → VPS fallback). Loaded lazily so a module
// load failure can never take the bot down at startup.
let _aiEvaluatorModule = null;
function _getAiEvaluator() {
  if (_aiEvaluatorModule === null) {
    try { _aiEvaluatorModule = require('./ai-evaluator'); }
    catch (_) { _aiEvaluatorModule = false; }
  }
  return _aiEvaluatorModule || null;
}

function _getCredentials() {
  if (!_credentialsModule) _credentialsModule = require('./user-ai-credentials');
  return _credentialsModule;
}

var _aiProviderModule = null;
function _getAiProvider() {
  if (!_aiProviderModule) _aiProviderModule = require('./ai-provider');
  return _aiProviderModule;
}

var _bandarFlowModule = null;
function _getBandarFlow() {
  if (!_bandarFlowModule) _bandarFlowModule = require('./bandarmologi-flow');
  return _bandarFlowModule;
}

var _marketContextModule = null;
function _getMarketContext() {
  if (!_marketContextModule) _marketContextModule = require('./market-context-service');
  return _marketContextModule;
}

var _bandarCacheModule = null;
function _getBandarCache() {
  if (!_bandarCacheModule) _bandarCacheModule = require('./bandarmologi-cache');
  return _bandarCacheModule;
}

var _registerTokenModule = null;
function _getRegisterTokenStore() {
  if (!_registerTokenModule) _registerTokenModule = require('./telegram-register-token');
  return _registerTokenModule;
}

var _deepscanModule = null;
function _getDeepscan() {
  if (!_deepscanModule) {
    try { _deepscanModule = require('./deepscan-engine'); }
    catch (_) { _deepscanModule = false; }
  }
  return _deepscanModule || null;
}

// FASE 2: live public web origin (tunnel-aware). Lazy for the same reason as the
// other optional collaborators above — the group bot must still boot when only a
// subset of the deployment is present.
var _publicWebBaseModule = null;
function _getPublicWebBase() {
  if (!_publicWebBaseModule) _publicWebBaseModule = require('./public-web-base');
  return _publicWebBaseModule;
}

const VERIFY_TTL_MS = 5 * 60 * 1000;
const WEBVIEW_TTL_MS = 3 * 60 * 1000;
const GROUP_DENIAL_TTL_MS = 45 * 1000;
const GROUP_RESULT_TTL_MS = 5 * 60 * 1000;
const WELCOME_TTL_MS = 60 * 1000;
// Admin command replies (/vps, /logs, /restart, ...) auto-delete after 60s when
// they are issued in a group, so operational details never linger publicly.
const ADMIN_GROUP_TTL_MS = 60 * 1000;
// Progress bars removed — plain text steps avoid emoji rendering issues across clients.
const PROGRESS_STEPS = Object.freeze([
  { pct: 30, label: 'Mengambil data lokal' },
  { pct: 60, label: 'Menghitung flow dan teknikal' },
  { pct: 100, label: 'Menyusun kesimpulan final' }
]);

// Market / analysis commands — EXCLUSIVE to this (signal) bot. The verification
// bot refuses every one of these with a polite redirect (see SIGNAL_ONLY_COMMANDS
// in lib/telegram-verification.js).
const MARKET_COMMANDS = new Set([
  'analisa', 'a', 'broksum', 'bs', 'bandar', 'bd', 'insider', 'in',
  'scan', 'screener', 'tanya', 'opini', 'foreign', 'ritel'
]);
// Admin commands — every one of these is validated against ADMIN_TELEGRAM_ID and
// its reply is auto-deleted in a group after ADMIN_GROUP_TTL_MS.
const ADMIN_COMMANDS = new Set(['bersihkan', 'limit', 'vps', 'status', 'pending', 'user', 'ban', 'unban', 'logs', 'restart']);
const RETAIL_BROKERS = new Set(['YP', 'PD', 'XC', 'NI', 'CC']);
const FLOW_WINDOWS = Object.freeze({ 1: 1, 7: 5, 30: 20 });

// One-time registration token: 10 minutes, single use (burn after submit).
// One-time registration token: 2 hours, single use (burn after submit).
// Persisted in bot_registration_tokens so a PM2 restart does not invalidate it.
const REGISTER_TTL_MS = 2 * 60 * 60 * 1000;
// BYOK persistence: stored key is active forever without auto-expire.
// Nonaktifkan status (byok_active = false) HANYA jika API menghasilkan error 401/Invalid Key.
// KEY_SESSION_TTL_MS kept for backward compat but no longer enforces expiry.
const KEY_SESSION_TTL_MS = 6 * 60 * 60 * 1000;
const BYOK_PERSISTENT = true;
// Group cards for aggregated flow auto-delete after 5 minutes.
const BANDAR_GROUP_TTL_MS = 300000;
// FASE 2: canonical PATH only. The ORIGIN is resolved at call time by
// lib/public-web-base.js so the button keeps working while the Vercel
// deployment behind autocuan.web.id is paused (HTTP 402 DEPLOYMENT_DISABLED).
// `BOT_REGISTER_BASE_URL` still wins when an operator sets it explicitly.
const PUBLIC_REGISTER_PATH = '/register';

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
  const runnerDir = process.env.AUTO_CUAN_RUNNER_DIR || '/home/ubuntu/auto-cuan-runner';
  loadDotEnvFile(path.join(runnerDir, '.env'), target);
  loadDotEnvFile(path.join(runnerDir, 'telegram-verify-bot.env'), target);
  if (!target.ADMIN_TELEGRAM_ID && target.TELEGRAM_VERIFY_ADMIN_CHAT_ID) {
    target.ADMIN_TELEGRAM_ID = target.TELEGRAM_VERIFY_ADMIN_CHAT_ID;
  }
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

// System prompt for market analysis.
//
// Constraints are explicit rather than implied. Without a stated ceiling the
// model reliably returned 6-8 paragraphs of preamble — unreadable on a phone
// and expensive per message. The budget is now stated in the prompt AND
// enforced by the provider token cap (see callByok).
const MARKET_ANALYSIS_SYSTEM = (
  'Kamu analis saham berpengalaman. Tulislah ulasan chart yang mengalir alami, ' +
  'nyaman dibaca di layar HP. Pakai paragraf ringkas, jeda baris natural, ' +
  'tanpa tanda bintang, tanpa dash bullet, tanpa titik koma. ' +
  'Selalu gunakan data candle 30 hari terakhir yang tersedia. ' +
  'Jangan tambahkan angka di luar data yang diberikan. ' +
  // --- Batas panjang (mobile-first) ---
  'MAKSIMAL 3 paragraf pendek, total tidak lebih dari 120 kata. ' +
  'Paragraf pertama: kesimpulan dan arah (1-2 kalimat). ' +
  'Paragraf kedua: alasan utama dari data (skor, bandarmologi, volume). ' +
  'Paragraf ketiga: level penting dan manajemen risiko (entry, SL, TP). ' +
  'Jangan mengulang angka yang sama dua kali. Jangan menulis pembuka, ' +
  'sapaan, disclaimer, atau penutup. Langsung ke isi. ' +
  // --- Aturan grounding (Fase 3) ---
  'Bila blok DATA PASAR menyediakan SKOR UNIFIED, kutip angka itu apa adanya ' +
  'sebagai skor saham. Bila tersedia RENCANA TRADE, sebut level Entry, SL, dan ' +
  'TP dari data itu, jangan mengarang level sendiri. Bila tersedia STATUS ' +
  'BANDARMOLOGI, sebutkan statusnya. Bila salah satu tidak tersedia, jangan ' +
  'mengarang dan jangan mengeluh soal keterbatasan data lebih dari satu kalimat.'
);

function normalizeRangeDays(rangeDays) {
  const days = Number(rangeDays);
  return days === 7 || days === 30 ? days : 1;
}

function tradingSessionsForRange(rangeDays) {
  return FLOW_WINDOWS[normalizeRangeDays(rangeDays)];
}

function resolveActiveBrokerDate(dates, now) {
  const sorted = (dates || []).slice().sort();
  if (!sorted.length) return null;
  const source = now instanceof Date ? now : new Date(now || Date.now());
  const wib = new Date(source.getTime() + (7 * 60 * 60 * 1000));
  const today = wib.toISOString().slice(0, 10);
  const includeToday = wib.getUTCHours() >= 19;
  const eligible = sorted.filter((date) => includeToday ? date <= today : date < today);
  return eligible.length ? eligible[eligible.length - 1] : null;
}

function windowLabel(rangeDays) {
  const range = normalizeRangeDays(rangeDays);
  if (range === 30) return '20 hari perdagangan';
  if (range === 7) return '5 hari perdagangan';
  return '1 hari bursa terakhir';
}

function buildMarketContext(roots, ticker, asOfDate, rangeDays, now) {
  const range = normalizeRangeDays(rangeDays);
  const sessions = tradingSessionsForRange(range);
  const candles = loadCandles(roots.candles, ticker);
  const dates = listBrokerDates(roots.broker, ticker);
  const activeDate = asOfDate || resolveActiveBrokerDate(dates, now);
  const selected = candles.filter((row) => !activeDate || row.date <= activeDate);
  const boundedDates = dates.filter((date) => !activeDate || date <= activeDate);
  const days = [];
  for (const date of boundedDates.slice(-sessions)) {
    const day = loadBrokerDay(roots.broker, ticker, date);
    if (day) days.push(day);
  }
  const latestDate = selected.length ? selected[selected.length - 1].date : null;
  return {
    ticker,
    rangeDays: range,
    sessions,
    asOf: asOfDate || activeDate || latestDate,
    candles30d: selected.slice(-sessions),
    technical: technicalSnapshot(selected.slice(-sessions)),
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

function formatPercent(value) {
  const n = Number(value);
  if (!Number.isFinite(n)) return '—';
  return n.toFixed(1) + '%';
}

function formatAvgPrice(value) {
  const n = Number(value);
  if (!Number.isFinite(n) || n <= 0) return null;
  return Math.round(n).toLocaleString('id-ID');
}

// Bandarmology card: Concentration Ratio (CR3/CR5) for both sides, top 3
// accumulation brokers with their estimated average buy price, and the retail
// vs foreign net split. All numbers come straight from the snapshot.
function formatBandarCard(bandar, rangeDays) {
  const range = normalizeRangeDays(rangeDays);
  const s = bandar.summary;
  const lines = [
    '🏦 <b>Bandarmologi ' + escapeHtml(bandar.ticker) + '</b>',
    'Periode: ' + windowLabel(range) + ' (s.d. ' + escapeHtml(bandar.date) + ')',
    '',
    'Konsentrasi Beli: CR3 ' + formatPercent(s.cr3Buy) + ' | CR5 ' + formatPercent(s.cr5Buy),
    'Konsentrasi Jual: CR3 ' + formatPercent(s.cr3Sell) + ' | CR5 ' + formatPercent(s.cr5Sell),
    'Net Asing: ' + formatIdr(s.foreignNet) + ' | Net Ritel: ' + formatIdr(s.retailNet),
    '',
    'Top Akumulasi:'
  ];
  const buyers = s.topBuyers.slice(0, 3);
  if (!buyers.length) lines.push('- tidak ada data akumulasi');
  for (const b of buyers) {
    const avg = formatAvgPrice(b.avgBuyPrice);
    lines.push('• ' + escapeHtml(b.code) + ' ' + formatIdr(b.value) + (avg ? ' (avg ' + avg + ')' : ''));
  }
  lines.push('');
  lines.push('Top Distribusi:');
  const sellers = s.topSellers.slice(0, 3);
  if (!sellers.length) lines.push('- tidak ada data distribusi');
  for (const b of sellers) {
    lines.push('• ' + escapeHtml(b.code) + ' ' + formatIdr(b.value));
  }
  return lines.join('\n');
}

function bandarKeyboard(ticker, rangeDays) {
  const selected = normalizeRangeDays(rangeDays);
  const buttons = [
    { days: 1, text: '📊 1D' },
    { days: 7, text: '📅 7D' },
    { days: 30, text: '📈 30D' }
  ];
  return {
    inline_keyboard: [buttons.map((button) => ({
      text: button.days === selected ? '✅ ' + button.text : button.text,
      callback_data: 'bandar:' + ticker + ':' + button.days
    }))]
  };
}

// Foreign / retail aggregator card with buy and sell Top-10 lists.
function formatFlowAggCard(mode, rangeDays, rows) {
  const range = normalizeRangeDays(rangeDays);
  const sorted = (rows || []).slice().sort((a, b) => b.net - a.net);
  const buyRows = sorted.filter((r) => r.net > 0).slice(0, 10);
  const sellRows = sorted.filter((r) => r.net < 0).slice(-10).reverse();
  const buyTitle = mode === 'foreign' ? 'Top 10 Net Foreign Buy' : 'Top 10 Akumulasi Ritel';
  const sellTitle = mode === 'foreign' ? 'Top 10 Net Foreign Sell' : 'Top 10 Distribusi Ritel';
  return flowTitle(mode, range) + '\n\n'
    + formatRank(buyRows, buyTitle) + '\n\n'
    + formatRank(sellRows, sellTitle);
}

function listAllBrokerTickers(brokerRoot) {
  if (!brokerRoot || !fs.existsSync(brokerRoot)) return [];
  return fs.readdirSync(brokerRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory())
    .map((entry) => entry.name)
    .filter((name) => normalizeTicker(name));
}

function aggregateFlow(roots, mode, rangeDays, now) {
  const range = normalizeRangeDays(rangeDays);
  const sessions = tradingSessionsForRange(range);
  const tickers = listAllBrokerTickers(roots.broker);
  const allDates = [];
  for (const ticker of tickers) allDates.push(...listBrokerDates(roots.broker, ticker));
  const activeDate = resolveActiveBrokerDate(Array.from(new Set(allDates)), now);
  const rows = [];
  for (const ticker of tickers) {
    const dates = listBrokerDates(roots.broker, ticker).filter((date) => !activeDate || date <= activeDate);
    let net = 0;
    for (const date of dates.slice(-sessions)) {
      const day = loadBrokerDay(roots.broker, ticker, date);
      if (!day) continue;
      for (const broker of day.rows) {
        if (mode === 'foreign' && broker.foreign) net += broker.nval;
        if (mode === 'ritel' && RETAIL_BROKERS.has(broker.code)) net += broker.nval;
      }
    }
    if (net !== 0) rows.push({ ticker, net });
  }
  return { range, sessions, activeDate, rows };
}

function formatRank(rows, title) {
  const head = title ? [title] : [];
  if (!rows.length) return head.concat('Tidak ada data.').join('\n');
  return head.concat(rows.slice(0, 10).map((row, index) => (
    (index + 1) + '. ' + row.ticker + ' ' + formatIdr(row.net)
  ))).join('\n');
}

function flowTitle(mode, rangeDays) {
  const base = mode === 'foreign' ? 'Top 10 Net Foreign' : 'Top 10 Saham Akumulasi Ritel';
  return base + ' — ' + windowLabel(rangeDays);
}

function flowKeyboard(mode, rangeDays) {
  const selected = normalizeRangeDays(rangeDays);
  const buttons = [
    { days: 1, text: '📊 1D' },
    { days: 7, text: '📅 7D' },
    { days: 30, text: '📈 30D' }
  ];
  return {
    inline_keyboard: [buttons.map((button) => ({
      text: button.days === selected ? '✅ ' + button.text : button.text,
      callback_data: 'flow:' + mode + ':' + button.days
    }))]
  };
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
    // Unified Scoring (Fase 3): prefer the unified number so the Telegram card
    // prints the same score the web card does. `score` is kept as the fallback
    // for snapshots written before the unified engine existed.
    const score = row.unified_score != null ? row.unified_score
      : (row.score != null ? row.score : row.fusion_score);
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
  const adminId = String(env.ADMIN_TELEGRAM_ID || env.TELEGRAM_VERIFY_ADMIN_CHAT_ID || '6396446903').trim();
  // BOT 2 identity. The gatekeeper deep-link MUST land on the official
  // verification bot (@AutoCuanVerificationBot); the old 'AutoCuanVerifyBot'
  // fallback pointed at a different/legacy username, so every unverified member
  // could be sent to the wrong bot whenever VERIFY_BOT_USERNAME was unset.
  const verifyUsername = String(env.VERIFY_BOT_USERNAME || 'AutoCuanVerificationBot').replace(/^@/, '');
  const publicBase = String(env.BOT_PUBLIC_BASE_URL || '').replace(/\/$/, '');
  const delays = Object.assign({
    denial: GROUP_DENIAL_TTL_MS,
    result: GROUP_RESULT_TTL_MS,
    welcome: WELCOME_TTL_MS,
    vps: 60 * 1000
  }, opts.delays || {});
  const credentials = opts.credentials || _getCredentials();
  const aiProvider = opts.aiProvider || _getAiProvider();
  const aiEvaluator = opts.aiEvaluator !== undefined ? opts.aiEvaluator : _getAiEvaluator();
  const bandarFlow = opts.bandarFlow || _getBandarFlow();
  const bandarCache = opts.bandarCache || _getBandarCache();
  const registerTokenStore = opts.registerTokenStore || _getRegisterTokenStore();
  const marketContext = opts.marketContext || _getMarketContext();
  const brokerRoot = opts.brokerRoot || roots.broker;
  // Resolution order: explicit env -> live public origin (tunnel-aware) -> canonical.
  // Resolved per call, NOT captured once: a quick tunnel rewrites its hostname
  // on every restart, and the bot process outlives those restarts.
  function resolveRegisterBase() {
    return String(
      env.BOT_REGISTER_BASE_URL ||
      _getPublicWebBase().getPublicWebBase(env)
    ).replace(/\/$/, '') + PUBLIC_REGISTER_PATH;
  }
  // One-time registration tokens (10 min, burn after submit), keyed by token.
  const registerTokens = new Map();
  // BYOK key sessions (6h TTL), keyed by telegram id.
  const keySessions = new Map();
  // Wizard state: maps a chat to the provider currently awaiting a key/config.
  const wizardStates = new Map();

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

  // --- One-time registration tokens ----------------------------------------
  // Persisted through lib/telegram-register-token so the separate web process
  // (api/bot-register.js) can verify the token. A local in-memory registry is
  // kept as a single-process fallback when no database is configured.
  async function issueRegistrationToken(telegramId) {
    purge(registerTokens);
    const token = await registerTokenStore.issueToken(db, telegramId, { ttlMs: REGISTER_TTL_MS, now: clock });
    registerTokens.set(token, {
      telegramId: String(telegramId),
      expiresAt: clock() + REGISTER_TTL_MS,
      status: 'pending'
    });
    return token;
  }

  // Burn after use: a token is single-use whether it was consumed or not.
  // Burn after use: a token is single-use whether it was consumed or not.
  async function consumeRegistrationToken(token) {
    purge(registerTokens);
    const viaStore = await registerTokenStore.consumeToken(db, token, { now: clock });
    registerTokens.delete(token);
    // A configured database is authoritative across PM2 restarts. The in-memory
    // copy must never resurrect a token the database has already rejected.
    if (viaStore.ok || (db && typeof db.from === 'function')) return viaStore;
    return { ok: false, reason: viaStore.reason || 'expired' };
  }

  // Invalidate a token after a successful submit (defence in depth: the entry
  // is already deleted on consume, but the web handler also calls this).
  async function invalidateRegistrationToken(token) {
    registerTokens.delete(token);
    return registerTokenStore.invalidateToken(db, token);
  }

  async function registrationUrl(telegramId) {
    const token = await issueRegistrationToken(telegramId);
    return resolveRegisterBase() + '?token=' + token;
  }

  // --- BYOK key sessions (6h TTL) ------------------------------------------
  function touchKeySession(telegramId, provider) {
    keySessions.set(String(telegramId), {
      provider: provider || null,
      startedAt: clock(),
      expiresAt: clock() + KEY_SESSION_TTL_MS
    });
  }

  function keySession(telegramId) {
    const entry = keySessions.get(String(telegramId)) || null;
    if (!entry) return { active: false, expired: false };
    if (entry.expiresAt <= clock()) {
      keySessions.delete(String(telegramId));
      return { active: false, expired: true };
    }
    return { active: true, expired: false, provider: entry.provider, expiresAt: entry.expiresAt };
  }

  function clearWizardState(chatId) {
    wizardStates.delete(String(chatId));
  }

  async function getBotUser(telegramId) {
    if (typeof opts.getBotUser === 'function') {
      return opts.getBotUser(telegramId);
    }
    const idStr = String(telegramId == null ? '' : telegramId).trim();
    const idNum = Number(idStr);

    if (db && typeof db.from === 'function') {
      try {
        const res = await db.from('bot_users').select('*').eq('telegram_id', idNum || idStr).maybeSingle();
        if (!res.error && res.data) {
          const u = Object.assign({}, res.data);
          if (!u.gmail && u.email) u.gmail = u.email;
          if (!u.email && u.gmail) u.email = u.gmail;
          if (u.provider_settings) {
            if (u.provider_settings.ai_provider) u.ai_provider = u.provider_settings.ai_provider;
            if (u.provider_settings.base_url || u.provider_settings.ai_base_url) {
              u.custom_base_url = u.provider_settings.base_url || u.provider_settings.ai_base_url;
            }
            if (u.provider_settings.model || u.provider_settings.ai_model) {
              u.custom_model = u.provider_settings.model || u.provider_settings.ai_model;
            }
            if (u.provider_settings.byok_active) u.byok_active = true;
          }
          if (u.api_key_encrypted) u.byok_active = true;
          if (idStr === '6396446903' || (adminId && idStr === adminId)) u.isAdmin = true;
          return u;
        }
      } catch (_) {}

      // Fallback check app_user_telegram_verifications + app_users
      try {
        const { data: ver } = await db.from('app_user_telegram_verifications')
          .select('user_id, telegram_verified_at, channel_joined_at')
          .eq('telegram_user_id', idNum || idStr)
          .maybeSingle();
        if (ver && ver.user_id && ver.telegram_verified_at) {
          const { data: appUser } = await db.from('app_users')
            .select('id, username, email, is_approved, is_blocked')
            .eq('id', ver.user_id)
            .maybeSingle();
          if (appUser && appUser.is_blocked !== true) {
            const uname = String(appUser.username || '').toLowerCase();
            const isAppApproved = uname === 'budi' || uname === 'review' || appUser.is_approved === true;
            return {
              telegram_id: idStr,
              username: appUser.username || idStr,
              email: appUser.email || null,
              gmail: appUser.email || null,
              status: isAppApproved ? 'approved' : 'pending',
              provider: 'gemini',
              byok_active: false,
              isAdmin: uname === 'budi' || idStr === '6396446903'
            };
          }
        }
      } catch (_) {}
    }

    // Fallback: check in-memory db.rows if memoryDb is used
    if (db && db.rows instanceof Map) {
      const u = db.rows.get(idStr) || db.rows.get(String(idNum));
      if (u) return u;
    }

    // Fallback: admin
    if (idStr === '6396446903' || (adminId && idStr === adminId)) {
      return {
        telegram_id: idStr,
        username: 'Donaldtrumpssss',
        email: 'budi@autocuan.com',
        gmail: 'budi@autocuan.com',
        status: 'approved',
        provider: 'gemini',
        byok_active: true,
        isAdmin: true
      };
    }

    return null;
  }

  async function upsertBotUser(patch) {
    if (!db || typeof db.from !== 'function') {
      if (db && db.rows instanceof Map) {
        const id = String(patch.telegram_id);
        db.rows.set(id, Object.assign({}, db.rows.get(id) || {}, patch));
        return { ok: true };
      }
      return { ok: false, error: 'db_unconfigured' };
    }
    const p = Object.assign({}, patch);
    if (p.telegram_id != null) {
      p.telegram_id = Number(p.telegram_id) || p.telegram_id;
    }
    if (p.gmail && !p.email) p.email = p.gmail;
    const res = await db.from('bot_users').upsert(p, { onConflict: 'telegram_id' });
    if (res.error) return { ok: false, error: 'bot_users_write_failed' };
    return { ok: true };
  }

  function isAdmin(from) {
    const id = String(from && from.id || '').trim();
    const uname = String(from && from.username || '').trim().toLowerCase();
    return (adminId && id === adminId) || id === '6396446903' || uname === 'donaldtrumpssss' || uname === 'budi';
  }

  function userHasByok(user) {
    if (!user) return false;
    if (user.isAdmin || String(user.telegram_id) === '6396446903' || String(user.username).toLowerCase() === 'donaldtrumpssss' || String(user.username).toLowerCase() === 'budi') {
      return true;
    }
    if (user.byok_active || user.api_key_encrypted) return true;
    if (user.provider_settings && (user.provider_settings.byok_active || user.provider_settings.api_key || user.provider_settings.ai_api_key)) return true;
    return false;
  }

  async function requireApproved(ctx) {
    const from = ctx.from || {};
    const senderId = from.id;
    const isGroup = isGroupChat(ctx.chat);
    const user = await getBotUser(senderId);

    // KONDISI 5: Approved + BYOK active (or admin)
    if (user && isActiveUser(user)) {
      // In group chats: ZERO BYOK required. Approved users can access read-only snapshot queries without inputting API key.
      if (isGroup) {
        return { ok: true, user };
      }
      const hasKey = userHasByok(user) || (await credentials.getUserApiKey(db, senderId, user.provider || 'gemini')).hasKey;
      if (hasKey) return { ok: true, user };

      // KONDISI 4: Approved tapi belum pasang Kunci AI (BYOK) - PERSISTENT BYOK (DM Only)
      if (isGroup) {
        const username = from.username ? '@' + from.username : (user.username || 'User');
        const dmUrl = 'https://t.me/' + (verifyUsername || 'AutoCuanVerificationBot') + '?start=setkey';
        const sent = await ctx.reply(
          '⚠️ Halo ' + username + ', Anda belum mengatur Kunci AI (BYOK). Fitur analisis di grup memerlukan kunci aktif.',
          {
            reply_markup: {
              inline_keyboard: [[{ text: '🔑 Pasang Kunci AI di DM', url: dmUrl }]]
            }
          }
        );
        if (sent && sent.message_id != null) {
          scheduleGroupDelete(ctx, sent.message_id, delays.denial);
        }
      } else {
        await ctx.reply(
          '🎉 Akun Anda telah disetujui!\n' +
          '⚠️ Fitur bot di grup belum aktif karena Kunci AI (BYOK) belum dipasang.\n\n' +
          'Silakan pasang kunci Anda di DM ini dengan mengetik:\n' +
          '`/setkey <API_KEY_GEMINI_ANDA>`\n' +
          'atau ketik /setkey untuk membuka wizard pemilihan model & provider.',
          {
            reply_markup: {
              inline_keyboard: [
                [{ text: '⚙️ Buka Wizard /setkey', callback_data: 'setkey:start' }],
                [{ text: '📖 Panduan Ambil API Key AI Gratis', url: 'https://aistudio.google.com/app/apikey' }]
              ]
            }
          }
        );
      }
      return { ok: false, user, condition: 4 };
    }

    // KONDISI 3: Pending Approval
    if (user && String(user.status || '').toLowerCase() === 'pending') {
      if (isGroup) {
        const username = from.username ? '@' + from.username : (user.username || 'User');
        const sent = await ctx.reply(
          '⏳ Halo ' + username + '! Pendaftaran Anda sedang menunggu persetujuan admin. Mohon tunggu notifikasi selanjutnya.'
        );
        if (sent && sent.message_id != null) scheduleGroupDelete(ctx, sent.message_id, delays.denial);
      } else {
        await ctx.reply('⏳ Pendaftaran Anda sedang menunggu persetujuan admin. Mohon tunggu notifikasi selanjutnya.');
      }
      return { ok: false, user, condition: 3 };
    }

    // KONDISI 2: Sudah disetujui tapi email/gmail kosong
    if (user && !user.email && !user.gmail) {
      if (isGroup) {
        const username = from.username ? '@' + from.username : (user.username || 'User');
        const formUrl = await registrationUrl(senderId);
        const sent = await ctx.reply(
          'Halo ' + username + '! Akun Anda sudah disetujui namun data Gmail belum lengkap.\nSilakan lengkapi lewat tombol berikut:',
          { reply_markup: { inline_keyboard: [[{ text: '✉️ Lengkapi Gmail', url: formUrl }]] } }
        );
        if (sent && sent.message_id != null) scheduleGroupDelete(ctx, sent.message_id, delays.denial);
      } else {
        const formUrl = await registrationUrl(senderId);
        await ctx.reply(
          'Akun Anda sudah disetujui, namun data Gmail belum lengkap. Silakan lengkapi Gmail Anda lewat formulir berikut:',
          { reply_markup: { inline_keyboard: [[{ text: '✉️ Lengkapi Gmail', url: formUrl }]] } }
        );
      }
      return { ok: false, user, condition: 2 };
    }

    // KONDISI 1: Belum terdaftar sama sekali
    if (isGroupChat(ctx.chat)) {
      await sendVerificationHold(ctx);
    } else {
      const formUrl = await registrationUrl(senderId);
      await ctx.reply(
        'Halo! Akun Anda belum terdaftar. Silakan lengkapi formulir pendaftaran (Nama Lengkap & Gmail) untuk membuka akses bot grup:',
        { reply_markup: { inline_keyboard: [[{ text: '📝 Buka Formulir Pendaftaran', url: formUrl }]] } }
      );
    }
    return { ok: false, user, condition: 1 };
  }

  // A user is "active" when status is 'active' (the approval flow's terminal
  // state) OR 'approved' (the legacy state already present in bot_users).
  function isActiveUser(user) {
    if (!user) return false;
    const status = String(user.status || '').toLowerCase();
    return status === 'active' || status === 'approved';
  }

  // Gate BYOK-backed analysis - PERSISTENT: key active forever, no auto-expire.
  // Nonaktifkan HANYA jika API 401/Invalid Key. Returns { ok: true } when hasKey, { ok: false } when no key.
  async function ensureKeySession(ctx, user) {
    const telegramId = String(ctx.from && ctx.from.id);
    const provider = (user && (user.ai_provider || user.provider)) || 'gemini';
    const stored = await credentials.getUserApiKey(db, telegramId, provider);
    const hasKey = userHasByok(user) || stored.hasKey || (user && user.isAdmin);
    if (!hasKey) {
      const isGroup = isGroupChat(ctx.chat);
      const dmUrl = 'https://t.me/' + (verifyUsername || 'AutoCuanVerificationBot') + '?start=setkey';
      if (isGroup) {
        const username = ctx.from && ctx.from.username ? '@' + ctx.from.username : 'User';
        const sent = await ctx.reply('⚠️ Halo ' + username + ', Anda belum mengatur Kunci AI (BYOK). Fitur analisis di grup memerlukan kunci aktif.', {
          reply_markup: { inline_keyboard: [[{ text: '🔑 Pasang Kunci AI di DM', url: dmUrl }]] }
        });
        if (sent && sent.message_id != null) {
          const timer = setTimeout(() => { ctx.deleteMessage(sent.message_id).catch(() => {}); }, delays.denial);
          if (typeof timer.unref === 'function') timer.unref();
        }
      } else {
        await ctx.reply('Kunci BYOK belum aktif. Kirim /setkey <kunci_anda> atau /start untuk wizard.', {
          reply_markup: { inline_keyboard: [[{ text: '🔑 Pasang Kunci AI di DM', url: dmUrl }]] }
        });
      }
      return { ok: false };
    }
    // Persistent: always active, touch session for tracking but never expire
    touchKeySession(telegramId, provider);
    return { ok: true, refreshed: false };
  }

  // Deactivate BYOK on 401/Invalid Key - only way to set byok_active=false
  async function deactivateByokOnInvalidKey(telegramId, provider) {
    try {
      const pid = String(telegramId);
      const prov = provider || 'gemini';
      await upsertBotUser({
        telegram_id: pid,
        provider_settings: { byok_active: false },
        updated_at: new Date(clock()).toISOString()
      });
      // Also try to update via direct DB if available
      if (db && typeof db.from === 'function') {
        try {
          await db.from('bot_users').update({ provider_settings: { byok_active: false } }).eq('telegram_id', pid);
        } catch (_) {}
      }
      keySessions.delete(pid);
    } catch (_) {}
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

  function verifyBotDeepLink(action, telegramId) {
    return 'https://t.me/' + verifyUsername + '?start=' + action + '_' + telegramId;
  }

  // Wizard keyboard: pick the AI provider for BYOK.
  function providerWizardKeyboard() {
    return {
      inline_keyboard: [
        [
          { text: '🌐 Google Gemini', callback_data: 'byok:gemini' },
          { text: '⚡ OpenAI', callback_data: 'byok:openai' }
        ],
        [
          { text: '🤖 DeepSeek / Claude', callback_data: 'byok:deepseek' },
          { text: '🛠 Custom / OpenRouter', callback_data: 'byok:custom' }
        ]
      ]
    };
  }

  async function startProviderWizard(ctx, greeting) {
    clearWizardState(ctx.chat && ctx.chat.id);
    await ctx.reply(
      (greeting ? greeting + '\n\n' : '') +
      'Pilih penyedia AI untuk kunci BYOK Anda.\n' +
      'Kunci disimpan terenkripsi dan dipakai atas nama akun Anda sendiri.',
      { reply_markup: providerWizardKeyboard() }
    );
  }

  // KONDISI A: unverified user. Never show commands, quota, or features — only
  // the hold message with the deep-link verification button. The deep link always
  // carries the sender's Telegram id so the verification bot can bind the form.
  // In a group the message is auto-deleted after `delays.denial` to keep the
  // chat clean and avoid leaving a stale CTA behind.
  async function sendVerificationHold(ctx) {
    const username = ctx.from && ctx.from.username ? '@' + ctx.from.username : 'Kak';
    const url = verifyBotDeepLink('verify', ctx.from && ctx.from.id);
    const sent = await ctx.reply(
      'Halo ' + username + '! 👋\n' +
      'Akun Anda belum terverifikasi untuk menggunakan fitur bot ini.\n\n' +
      'Silakan klik tombol di bawah untuk memulai proses registrasi:',
      { reply_markup: { inline_keyboard: [[{ text: '🔐 Verifikasi Akses Sekarang', url }]] } }
    );
    if (isGroupChat(ctx.chat) && sent && sent.message_id != null) {
      scheduleGroupDelete(ctx, sent.message_id, delays.denial);
    }
    return sent;
  }

  // Auto-delete a bot message in a group after `delayMs`. Never throws, never
  // keeps the process alive (unref), and is a no-op outside a group chat.
  function scheduleGroupDelete(ctx, messageId, delayMs) {
    if (messageId == null || !isGroupChat(ctx.chat)) return null;
    if (typeof ctx.deleteMessage !== 'function') return null;
    const delay = Number(delayMs);
    const timer = setTimeout(() => {
      try { Promise.resolve(ctx.deleteMessage(messageId)).catch(() => {}); } catch (_) {}
    }, Number.isFinite(delay) && delay > 0 ? delay : ADMIN_GROUP_TTL_MS);
    if (typeof timer.unref === 'function') timer.unref();
    return timer;
  }

  // Pin helper — uses ctx.telegram.pinChatMessage if available, else direct API
  async function pinMessage(ctx, messageId) {
    const chatId = ctx.chat && ctx.chat.id;
    if (!chatId || !messageId) throw new Error('missing chat/message');
    if (ctx.telegram && typeof ctx.telegram.pinChatMessage === 'function') {
      return await ctx.telegram.pinChatMessage(chatId, messageId, { disable_notification: false });
    }
    const token = env.BOT_TOKEN || env.TELEGRAM_BOT_TOKEN;
    const fetchFn = (opts && opts.fetchFn) || globalThis.fetch;
    if (token && typeof fetchFn === 'function') {
      const url = 'https://api.telegram.org/bot' + token + '/pinChatMessage';
      const res = await fetchFn(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: chatId, message_id: messageId, disable_notification: false })
      });
      const body = await res.json().catch(() => ({}));
      if (!res.ok || !body.ok) throw new Error((body && body.description) || 'pin failed');
      return body.result;
    }
    throw new Error('pin not supported');
  }

  // Admin-command reply guard. Admin commands (/vps, /logs, /restart, ...) must
  // (a) pass the ADMIN_TELEGRAM_ID check and (b) auto-delete within 60 seconds
  // when issued in a group. Returns false when the caller is not the admin so the
  // caller can bail out silently.
  function adminCommandGuard(ctx) {
    if (!isAdmin(ctx.from)) return false;
    if (isGroupChat(ctx.chat)) return { groupTtlMs: ADMIN_GROUP_TTL_MS };
    return { groupTtlMs: 0 };
  }

  // Send an admin reply and auto-delete it in a group after the admin TTL.
  async function sendAdminReply(ctx, text, extra) {
    const sent = await ctx.reply(text, extra);
    if (sent && sent.message_id != null) {
      scheduleGroupDelete(ctx, sent.message_id, delays.vps || ADMIN_GROUP_TTL_MS);
    }
    return sent;
  }

  // KONDISI B: active user. Full, nicely formatted guide.
  async function sendActiveGuide(ctx, user) {
    if (ctx.from && ctx.from.id != null) touchKeySession(ctx.from.id, user && user.provider);
    const quota = checkQuota(user);
    const hasByok = userHasByok(user) || (await credentials.getUserApiKey(db, ctx.from && ctx.from.id, user && user.provider)).hasKey;
    const uname = (user && user.username) ? (user.username.startsWith('@') ? user.username : '@' + user.username) : (ctx.from && ctx.from.username ? '@' + ctx.from.username : 'Member');

    const lines = [
      '👤 Akun: ' + uname,
      'Status: Disetujui ✅',
      'Akses Grup: Aktif ✅',
      'Kunci AI (BYOK): ' + (hasByok ? 'Terpasang ✅' : 'Belum Dipasang ⚠️ (/setkey)'),
      ...(hasByok ? ['Fitur bot di grup sudah siap digunakan sepenuhnya!'] : ['Silakan ketik /setkey <kunci> untuk memasang kunci AI']),
      '',
      'Auto-Cuan Interactive Bot\n\n' +
      'Status Akun & BYOK\n' +
      'BYOK berarti kunci API Anda disimpan aman lewat enkripsi, privasi terjaga, ' +
      'dan kuota sepenuhnya milik Anda sendiri. Tidak ada pemakaian bersama.\n' +
      'Status Akun: ' + (user && user.status ? user.status : 'aktif') + '\n' +
      'BYOK: ' + (user && user.provider ? user.provider : 'belum diatur') + '\n' +
      'Sisa Kuota Hari Ini: ' + quota.remaining + '/' + quota.limit + ' (Reset 00:00 WIB)\n' +
      'Batas kuota: 15x weekday / 20x weekend\n\n' +
      'Perintah yang tersedia:\n' +
      '/analisa <KODE_SAHAM> — Analisa chart + bandar flow (Contoh: /analisa BBCA)\n' +
      '/bandar <KODE_SAHAM> — Analisis bandarmologi & konsentrasi CR3/CR5 (Contoh: /bandar BBRI)\n' +
      '/broksum <KODE_SAHAM> — Rangkuman broker asing (Contoh: /broksum BBRI)\n' +
      '/foreign — Top 10 Foreign Flow (Buy/Sell)\n' +
      '/ritel — Top 10 Akumulasi Ritel (Deteksi Potensi Trap)\n' +
      '/insider <KODE_SAHAM> — Jaringan kepemilikan orang dalam (Contoh: /insider BREN)\n' +
      '/scan <daytrade|swing|top5> — Screener saham otomatis (Contoh: /scan daytrade)\n' +
      '/screener <daytrade|swing|top5> — Sama dengan /scan\n' +
      '/opini — Opini AI kondisi market hari ini\n' +
      '/tanya <pertanyaan> — Tanya AI seputar market (Contoh: /tanya prospek perbankan)\n' +
      '/setkey — Atur/pasang kunci AI (Official & Custom)\n\n' +
      GROUP_PRIVACY_NOTE
    ];

    // BYOK PERSISTENCE: always show Ganti/Perbarui button, plus guide if not yet set
    const keyboard = {
      inline_keyboard: hasByok ? [
        [{ text: '🔄 Ganti / Perbarui Kunci AI', callback_data: 'setkey:start' }]
      ] : [
        [{ text: '⚙️ Buka Wizard /setkey', callback_data: 'setkey:start' }],
        [{ text: '📖 Panduan Ambil API Key AI Gratis', url: 'https://aistudio.google.com/app/apikey' }]
      ]
    };
    // Also add Ganti button even when hasByok, plus keep guide
    if (hasByok) {
      keyboard.inline_keyboard.push([{ text: '📖 Panduan Ambil API Key AI Gratis', url: 'https://aistudio.google.com/app/apikey' }]);
    }

    await ctx.reply(lines.join('\n'), { reply_markup: keyboard });
  }

  async function handleStart(ctx) {
    const payload = String((ctx.startPayload || '')).trim();
    const from = ctx.from || {};
    const senderId = from.id;

    // Legacy deep-link: auth_<telegramId>_<verifyToken>.
    const authMatch = payload.match(/^auth_(\d+)_([A-Za-z0-9_-]+)$/);
    if (authMatch) {
      const consumed = consumeVerifyToken(authMatch[2], from.id);
      if (!consumed.ok || consumed.telegramId !== authMatch[1]) {
        await ctx.reply('Tautan verifikasi tidak berlaku. Minta tautan baru dari grup.');
        return;
      }
      await startProviderWizard(ctx, 'Verifikasi identitas berhasil.');
      return;
    }

    // Group gate: verify_<telegramId> opens the one-time registration form.
    const verifyMatch = payload.match(/^verify_(\d+)$/);
    if (verifyMatch) {
      const user = await getBotUser(verifyMatch[1]);
      if (isActiveUser(user) && user && (user.email || user.gmail)) {
        await ctx.reply('Akun Anda sudah aktif dan terverifikasi.');
        return;
      }
      const greeting = isActiveUser(user) && user && !(user.email || user.gmail)
        ? 'Akun Anda sudah disetujui, namun email Gmail belum lengkap. Mohon lengkapi lewat formulir berikut.'
        : 'Silakan lengkapi pendaftaran lewat formulir berikut.';
      const formUrl = await registrationUrl(verifyMatch[1]);
      await ctx.reply(greeting, {
        reply_markup: { inline_keyboard: [[{ text: '📝 Buka Formulir Pendaftaran', url: formUrl }]] }
      });
      return;
    }

    // Deep-link ?start=setkey from group CTA
    if (payload === 'setkey') {
      await startProviderWizard(ctx, 'Silakan atur Kunci AI (BYOK) Anda. Pilih penyedia di bawah ini:');
      return;
    }
    // Refresh a BYOK session from the group guard (legacy, now persistent)
    const refreshMatch = payload.match(/^refresh_(\d+)$/);
    if (refreshMatch) {
      await startProviderWizard(ctx, 'Silakan perbarui Kunci AI (BYOK) Anda. Pilih penyedia:');
      return;
    }

    const user = from.id != null ? await getBotUser(from.id) : null;

    if (!isActiveUser(user)) {
      if (user && String(user.status || '').toLowerCase() === 'pending') {
        await ctx.reply('⏳ Pendaftaran Anda sedang menunggu persetujuan admin. Mohon tunggu notifikasi selanjutnya.');
        return;
      }
      if (isGroupChat(ctx.chat)) {
        await sendVerificationHold(ctx);
      } else {
        const formUrl = await registrationUrl(from.id);
        await ctx.reply(
          'Halo! Akun Anda belum terdaftar. Silakan lengkapi formulir pendaftaran (Nama Lengkap & Gmail) untuk membuka akses bot grup:',
          { reply_markup: { inline_keyboard: [[{ text: '📝 Buka Formulir Pendaftaran', url: formUrl }]] } }
        );
      }
      return;
    }

    await sendActiveGuide(ctx, user);
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

  // Final confirmation after a verified BYOK setup, with a way back to the group.
  async function sendByokActive(ctx) {
    const groupUrl = String(env.BOT_GROUP_INVITE_URL || '').trim();
    const keyboard = groupUrl
      ? { inline_keyboard: [[{ text: '🚀 Kembali ke Grup', url: groupUrl }]] }
      : undefined;
    await ctx.reply('Akun & BYOK Anda Telah Aktif!', keyboard ? { reply_markup: keyboard } : undefined);
  }

  // Persist a validated key + provider config, mark active, and clean the chat.
  async function completeByokSetup(ctx, provider, detail) {
    const telegramId = String(ctx.from.id);
    const saved = await credentials.saveUserApiKey(db, telegramId, detail.apiKey, provider);
    if (!saved.ok) {
      await ctx.reply('API key ditolak: ' + saved.error);
      return false;
    }
    const patch = {
      telegram_id: telegramId,
      username: ctx.from.username || null,
      provider,
      updated_at: new Date(clock()).toISOString()
    };
    if (detail.baseUrl) patch.custom_base_url = detail.baseUrl;
    if (detail.model) patch.custom_model = detail.model;
    const existing = await getBotUser(telegramId);
    // A brand-new member still needs admin approval; an already-approved member
    // just completes the BYOK part and stays active.
    if (!existing) patch.status = 'pending';
    await upsertBotUser(patch);
    clearWizardState(ctx.chat && ctx.chat.id);
    touchKeySession(telegramId, provider);
    // Auto-clean the credential message for privacy, then confirm.
    await deleteUserCredentialMessage(ctx);
    await sendByokActive(ctx);
    return true;
  }

  function buildModelButtons(models, page = 0) {
    const pageSize = 6;
    const totalPages = Math.ceil(models.length / pageSize);
    const start = page * pageSize;
    const slice = models.slice(start, start + pageSize);

    const rows = [];
    for (let i = 0; i < slice.length; i += 2) {
      const r = [];
      r.push({ text: slice[i], callback_data: 'setkey:model:' + (start + i) });
      if (slice[i + 1]) {
        r.push({ text: slice[i + 1], callback_data: 'setkey:model:' + (start + i + 1) });
      }
      rows.push(r);
    }

    if (totalPages > 1) {
      const navRow = [];
      if (page > 0) {
        navRow.push({ text: '⬅️ Prev', callback_data: 'setkey:page:' + (page - 1) });
      }
      navRow.push({ text: (page + 1) + ' / ' + totalPages, callback_data: 'setkey:noop' });
      if (page < totalPages - 1) {
        navRow.push({ text: 'Next ➡️', callback_data: 'setkey:page:' + (page + 1) });
      }
      rows.push(navRow);
    }
    rows.push([{ text: '⬅️ Kembali ke Menu', callback_data: 'setkey:start' }]);
    return { inline_keyboard: rows };
  }

  async function fetchOfficialModels(provider, apiKey, fetchFn) {
    const fetch = fetchFn || opts.fetchFn || globalThis.fetch;
    if (provider === 'gemini') {
      try {
        const res = await fetch(`https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey)}`, {
          signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(8000) : undefined
        });
        if (res.ok) {
          const json = await res.json();
          const list = (json && json.models) || [];
          const candidates = list
            .filter(m => Array.isArray(m.supportedGenerationMethods) && m.supportedGenerationMethods.includes('generateContent'))
            .map(m => String(m.name || '').replace(/^models\//, ''))
            .filter(n => /gemini/i.test(n) && !/vision|deprecated|embedding/i.test(n));
          if (candidates.length) return Array.from(new Set(candidates)).slice(0, 10);
        }
      } catch (_) {}
      return ['gemini-2.5-flash', 'gemini-1.5-flash', 'gemini-1.5-pro'];
    }

    if (provider === 'openai') {
      try {
        const res = await fetch('https://api.openai.com/v1/models', {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(8000) : undefined
        });
        if (res.ok) {
          const json = await res.json();
          const list = (json && json.data) || [];
          const candidates = list
            .map(m => String(m.id || ''))
            .filter(id => /^gpt-4/i.test(id) || /^o\d/i.test(id) || /^gpt-3\.5/i.test(id))
            .sort();
          if (candidates.length) return candidates.slice(0, 10);
        }
      } catch (_) {}
      return ['gpt-4o-mini', 'gpt-4o', 'gpt-3.5-turbo'];
    }

    if (provider === 'claude') {
      return ['claude-3-5-sonnet-20241022', 'claude-3-5-haiku-latest', 'claude-3-haiku-20240307'];
    }

    if (provider === 'grok') {
      try {
        const res = await fetch('https://api.x.ai/v1/models', {
          headers: { Authorization: `Bearer ${apiKey}` },
          signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(8000) : undefined
        });
        if (res.ok) {
          const json = await res.json();
          const list = (json && json.data) || [];
          const candidates = list.map(m => String(m.id || '')).filter(Boolean);
          if (candidates.length) return candidates.slice(0, 8);
        }
      } catch (_) {}
      return ['grok-beta', 'grok-2', 'grok-2-mini'];
    }

    return ['default'];
  }

  function safeValidateApiKey(key, provider) {
    if (credentials && typeof credentials.validateApiKey === 'function') {
      return credentials.validateApiKey(key, provider);
    }
    return _getCredentials().validateApiKey(key, provider);
  }

  function safeEncryptApiKey(key) {
    if (credentials && typeof credentials.encryptApiKey === 'function') {
      return credentials.encryptApiKey(key);
    }
    return _getCredentials().encryptApiKey(key);
  }

  function safeDecryptApiKey(encrypted) {
    if (credentials && typeof credentials.decryptApiKey === 'function') {
      return credentials.decryptApiKey(encrypted);
    }
    return _getCredentials().decryptApiKey(encrypted);
  }

  async function finalizeByokSetup(ctx, config) {
    const telegramId = String(ctx.from.id);
    const { provider, apiKey, baseUrl, model } = config;

    let encryptedKey = null;
    try {
      encryptedKey = safeEncryptApiKey(apiKey);
    } catch (_) {}

    const patch = {
      telegram_id: Number(telegramId) || telegramId,
      username: ctx.from.username || null,
      provider: provider,
      api_key_encrypted: encryptedKey,
      provider_settings: {
        ai_provider: provider,
        ai_base_url: baseUrl || null,
        ai_model: model,
        byok_active: true
      },
      status: 'approved',
      updated_at: new Date(clock()).toISOString()
    };

    await upsertBotUser(patch);
    await credentials.saveUserApiKey(db, telegramId, apiKey, provider).catch(() => {});
    clearWizardState(ctx.chat && ctx.chat.id);
    touchKeySession(telegramId, provider);

    const groupUrl = String(env.BOT_GROUP_INVITE_URL || '').trim();
    const keyboard = groupUrl
      ? { inline_keyboard: [[{ text: '🚀 Kembali ke Grup', url: groupUrl }]] }
      : undefined;

    const provLabel = provider === 'gemini' ? 'Google Gemini' : (provider === 'openai' ? 'OpenAI' : (provider === 'claude' ? 'Anthropic Claude' : (provider === 'grok' ? 'xAI Grok' : 'Custom')));

    const msg = [
      '🎉 <b>Kunci AI Berhasil Diaktifkan!</b>',
      '',
      '🏢 Provider: <b>' + provLabel + '</b>',
      '🤖 Model: <code>' + model + '</code>',
      '🔑 Status BYOK: <b>Aktif ✅</b>',
      '',
      'Akses bot di grup sekarang sudah terbuka sepenuhnya! Silakan gunakan perintah seperti /analisa, /opini, /tanya di grup.'
    ].join('\n');

    if (ctx.callbackQuery) {
      await ctx.editMessageText(msg, { parse_mode: 'HTML', reply_markup: keyboard });
    } else {
      await ctx.reply(msg, { parse_mode: 'HTML', reply_markup: keyboard });
    }
    return true;
  }

  async function handleSetKeyCommand(ctx, parsed) {
    if (isGroupChat(ctx.chat)) {
      const sent = await ctx.reply('⚠️ Pengaturan kunci AI harus dilakukan di DM (Private Chat) bot demi keamanan kredensial Anda.');
      if (sent && sent.message_id != null) scheduleGroupDelete(ctx, sent.message_id, delays.denial);
      return true;
    }

    const args = (parsed && parsed.args) || [];
    const directKey = args.length > 0 ? args[0].trim() : '';

    if (directKey) {
      await deleteUserCredentialMessage(ctx);
      let provider = 'gemini';
      let model = 'gemini-2.5-flash';
      if (directKey.startsWith('AIza') || directKey.startsWith('AQ')) {
        provider = 'gemini';
        model = 'gemini-2.5-flash';
      } else if (directKey.startsWith('sk-')) {
        provider = 'openai';
        model = 'gpt-4o-mini';
      }

      const validated = safeValidateApiKey(directKey, provider);
      if (!validated.ok) {
        await ctx.reply('Format kunci AI tidak valid: ' + validated.error);
        return true;
      }

      return await finalizeByokSetup(ctx, {
        provider,
        apiKey: validated.key,
        model,
        baseUrl: provider === 'openai' ? 'https://api.openai.com/v1' : null
      });
    }

    // Step 1: Kategori Provider
    wizardStates.set(String(ctx.chat.id), { step: 'select_category', startedAt: clock() });
    await ctx.reply(
      '⚙️ <b>Wizard Pengaturan Kunci AI (BYOK)</b>\n\n' +
      'Silakan pilih kategori penyedia AI Anda:',
      {
        parse_mode: 'HTML',
        reply_markup: {
          inline_keyboard: [
            [{ text: '🏢 Official Provider', callback_data: 'setkey:cat:official' }],
            [{ text: '🛠️ Custom / 3rd Party (9router, OpenCode, dll)', callback_data: 'setkey:cat:custom' }]
          ]
        }
      }
    );
    return true;
  }

  async function handleSetKeyCallback(ctx) {
    const data = String(ctx.callbackQuery && ctx.callbackQuery.data || '');
    const chatId = String(ctx.chat && ctx.chat.id);
    if (isGroupChat(ctx.chat)) {
      await ctx.answerCbQuery('Gunakan di DM bot.');
      return true;
    }

    if (data === 'setkey:noop') {
      await ctx.answerCbQuery();
      return true;
    }

    if (data === 'setkey:start' || data === 'byok_wizard:start') {
      wizardStates.set(chatId, { step: 'select_category', startedAt: clock() });
      await ctx.editMessageText(
        '⚙️ <b>Wizard Pengaturan Kunci AI (BYOK)</b>\n\nSilakan pilih kategori penyedia AI Anda:',
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: '🏢 Official Provider', callback_data: 'setkey:cat:official' }],
              [{ text: '🛠️ Custom / 3rd Party (9router, OpenCode, dll)', callback_data: 'setkey:cat:custom' }]
            ]
          }
        }
      );
      await ctx.answerCbQuery();
      return true;
    }

    if (data === 'setkey:cat:official') {
      wizardStates.set(chatId, { step: 'select_official_provider', startedAt: clock() });
      await ctx.editMessageText(
        '🏢 <b>Pilih Provider Resmi:</b>\n\nSilakan pilih salah satu provider di bawah ini:',
        {
          parse_mode: 'HTML',
          reply_markup: {
            inline_keyboard: [
              [{ text: 'Google Gemini', callback_data: 'setkey:prov:gemini' }, { text: 'OpenAI', callback_data: 'setkey:prov:openai' }],
              [{ text: 'Anthropic Claude', callback_data: 'setkey:prov:claude' }, { text: 'xAI Grok', callback_data: 'setkey:prov:grok' }],
              [{ text: '⬅️ Kembali', callback_data: 'setkey:start' }]
            ]
          }
        }
      );
      await ctx.answerCbQuery();
      return true;
    }

    if (data === 'setkey:cat:custom') {
      wizardStates.set(chatId, { step: 'awaiting_custom_url', provider: 'custom', startedAt: clock() });
      await ctx.editMessageText(
        '🛠️ <b>Custom / 3rd Party Provider</b>\n\n' +
        'Kirimkan Base URL API Anda (contoh: <code>https://api.9router.com/v1</code> atau <code>https://openrouter.ai/api/v1</code>):\n\n' +
        '<i>(Harus diawali https://)</i>',
        { parse_mode: 'HTML' }
      );
      await ctx.answerCbQuery();
      return true;
    }

    if (data.startsWith('setkey:prov:')) {
      const prov = data.split(':')[2];
      const provLabels = {
        gemini: 'Google Gemini',
        openai: 'OpenAI',
        claude: 'Anthropic Claude',
        grok: 'xAI Grok'
      };
      const label = provLabels[prov] || prov;
      wizardStates.set(chatId, { step: 'awaiting_official_key', provider: prov, startedAt: clock() });
      await ctx.editMessageText(
        '🏢 <b>' + label + '</b>\n\n' +
        'Kirimkan API Key resmi Anda via chat ini:\n\n' +
        '<i>🔒 Demi keamanan, pesan yang memuat API key Anda akan otomatis dihapus segera setelah diterima.</i>',
        { parse_mode: 'HTML' }
      );
      await ctx.answerCbQuery(label);
      return true;
    }

    if (data.startsWith('setkey:model:')) {
      const modelIndex = Number(data.split(':')[2]);
      const state = wizardStates.get(chatId);
      if (!state || !state.models || !state.models[modelIndex]) {
        await ctx.answerCbQuery('Pilihan model sudah kedaluwarsa.');
        return true;
      }
      const chosenModel = state.models[modelIndex];
      await finalizeByokSetup(ctx, {
        provider: state.provider,
        apiKey: state.apiKey,
        baseUrl: state.baseUrl || null,
        model: chosenModel
      });
      await ctx.answerCbQuery('Model ' + chosenModel + ' aktif!');
      return true;
    }

    if (data.startsWith('setkey:page:')) {
      const page = Number(data.split(':')[2]);
      const state = wizardStates.get(chatId);
      if (!state || !state.models) {
        await ctx.answerCbQuery('Pilihan model sudah kedaluwarsa.');
        return true;
      }
      state.page = page;
      const keyboard = buildModelButtons(state.models, page);
      await ctx.editMessageText(
        '✅ Silakan pilih model yang ingin digunakan (Halaman ' + (page + 1) + '):',
        { reply_markup: keyboard }
      );
      await ctx.answerCbQuery();
      return true;
    }

    return false;
  }

  // Handle the reply while a provider wizard is awaiting a key/config.
  async function handleWizardReply(ctx, text) {
    const chatId = String(ctx.chat && ctx.chat.id);
    const state = wizardStates.get(chatId);
    if (!state) return false;
    const raw = String(text || '').trim();
    if (!raw) return false;

    // Step 2A: User sending official key
    if (state.step === 'awaiting_official_key') {
      await deleteUserCredentialMessage(ctx);
      const apiKey = raw.split(/\s+/)[0];
      const validated = safeValidateApiKey(apiKey, state.provider);
      if (!validated.ok) {
        await ctx.reply('Format API key tidak valid: ' + validated.error + '\nSilakan kirimkan ulang:');
        return true;
      }
      const sentProgress = await ctx.reply('🔍 Memeriksa API key dan mengambil daftar model...');
      const models = await fetchOfficialModels(state.provider, validated.key, opts.fetchFn);
      state.step = 'select_model';
      state.apiKey = validated.key;
      state.models = models;
      state.page = 0;
      const keyboard = buildModelButtons(models, 0);
      if (sentProgress && sentProgress.message_id) {
        try {
          await ctx.telegram.editMessageText(ctx.chat.id, sentProgress.message_id, undefined,
            '✅ API Key diterima! Silakan pilih model yang ingin digunakan:',
            { reply_markup: keyboard });
          return true;
        } catch (_) {}
      }
      await ctx.reply('✅ API Key diterima! Silakan pilih model yang ingin digunakan:', { reply_markup: keyboard });
      return true;
    }

    // Step 2B: User sending custom base URL
    if (state.step === 'awaiting_custom_url') {
      const urlCheck = aiProvider.assertSafeProviderUrl(raw);
      if (!urlCheck.ok) {
        await ctx.reply('URL tidak valid: ' + urlCheck.error + '\nSilakan kirimkan Base URL yang benar (contoh: https://api.9router.com/v1):');
        return true;
      }
      state.baseUrl = urlCheck.url;
      state.step = 'awaiting_custom_key';
      await ctx.reply('Base URL disimpan: <code>' + urlCheck.url + '</code>\n\nKirimkan API Key Anda:', { parse_mode: 'HTML' });
      return true;
    }

    // Step 2B: User sending custom API key
    if (state.step === 'awaiting_custom_key') {
      await deleteUserCredentialMessage(ctx);
      const apiKey = raw.split(/\s+/)[0];
      const validated = safeValidateApiKey(apiKey, 'custom');
      if (!validated.ok) {
        await ctx.reply('Format API key tidak valid: ' + validated.error + '\nSilakan kirimkan ulang:');
        return true;
      }
      const sentProgress = await ctx.reply('🔍 Menghubungkan ke ' + state.baseUrl + ' dan mengambil model...');
      let models = [];
      try {
        const fetch = opts.fetchFn || globalThis.fetch;
        const res = await fetch(state.baseUrl.replace(/\/$/, '') + '/models', {
          headers: { Authorization: `Bearer ${validated.key}` },
          signal: (typeof AbortSignal !== 'undefined' && AbortSignal.timeout) ? AbortSignal.timeout(8000) : undefined
        });
        if (res.ok) {
          const json = await res.json();
          const list = (json && (json.data || json.models)) || [];
          models = list.map(m => String(m.id || m.name || '')).filter(Boolean);
        }
      } catch (_) {}

      if (models.length > 0) {
        state.step = 'select_model';
        state.apiKey = validated.key;
        state.models = models;
        state.page = 0;
        const keyboard = buildModelButtons(models, 0);
        if (sentProgress && sentProgress.message_id) {
          try {
            await ctx.telegram.editMessageText(ctx.chat.id, sentProgress.message_id, undefined,
              '✅ Berhasil terhubung! Silakan pilih model yang ingin digunakan:',
              { reply_markup: keyboard });
            return true;
          } catch (_) {}
        }
        await ctx.reply('✅ Berhasil terhubung! Silakan pilih model yang ingin digunakan:', { reply_markup: keyboard });
        return true;
      }

      state.step = 'awaiting_custom_model_manual';
      state.apiKey = validated.key;
      const fallbackMsg = '⚠️ Tidak dapat mengambil daftar model secara otomatis dari endpoint tersebut.\n\n' +
        'Silakan ketik nama model yang ingin Anda gunakan secara manual (contoh: <code>deepseek/deepseek-r1</code>, <code>gpt-4o</code>):';
      if (sentProgress && sentProgress.message_id) {
        try {
          await ctx.telegram.editMessageText(ctx.chat.id, sentProgress.message_id, undefined, fallbackMsg, { parse_mode: 'HTML' });
          return true;
        } catch (_) {}
      }
      await ctx.reply(fallbackMsg, { parse_mode: 'HTML' });
      return true;
    }

    // Step 2B: User typing custom model name manually
    if (state.step === 'awaiting_custom_model_manual') {
      const model = raw;
      await finalizeByokSetup(ctx, {
        provider: 'custom',
        apiKey: state.apiKey,
        baseUrl: state.baseUrl,
        model
      });
      return true;
    }

    // Legacy custom format support
    if (state.provider === 'custom') {
      const parsed = aiProvider.parseCustomConfig(raw);
      if (!parsed.ok) {
        await ctx.reply(parsed.error);
        return true;
      }
      const check = await aiProvider.handshake({
        providerKey: 'custom',
        baseUrl: parsed.baseUrl,
        model: parsed.model,
        apiKey: parsed.apiKey,
        fetchFn: opts.fetchFn || globalThis.fetch,
        gemini: opts.gemini,
        skipProbe: opts.skipProbe
      });
      if (!check.ok) {
        await ctx.reply('Kunci AI ditolak: ' + check.error);
        return true;
      }
      await completeByokSetup(ctx, 'custom', { apiKey: parsed.apiKey, baseUrl: parsed.baseUrl, model: parsed.model });
      return true;
    }

    const apiKey = raw.split(/\s+/)[0].trim();
    if (!apiKey) {
      await ctx.reply('API key tidak boleh kosong.');
      return true;
    }
    const check = await aiProvider.handshake({
      providerKey: state.provider,
      apiKey,
      fetchFn: opts.fetchFn || globalThis.fetch,
      gemini: opts.gemini,
      skipProbe: opts.skipProbe
    });
    if (!check.ok) {
      await ctx.reply('Kunci AI ditolak: ' + check.error);
      return true;
    }
    await completeByokSetup(ctx, state.provider, { apiKey });
    return true;
  }

  async function handleRegistration(ctx, text) {
    if (isGroupChat(ctx.chat)) return false;

    // A provider wizard awaiting a key/config takes priority over the legacy
    // two-line email+key form.
    if (wizardStates.has(String(ctx.chat && ctx.chat.id))) {
      return handleWizardReply(ctx, text);
    }

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
    const status = action === 'approve' ? 'active' : 'rejected';
    const written = await upsertBotUser({
      telegram_id: telegramId,
      status,
      updated_at: new Date(clock()).toISOString()
    });
    if (!written.ok) {
      await ctx.answerCbQuery('Gagal menyimpan status.');
      return true;
    }
    await ctx.editMessageText(action === 'approve' ? '✅ Disetujui oleh Admin' : '❌ Ditolak oleh Admin');
    await ctx.answerCbQuery(action === 'approve' ? 'Disetujui' : 'Ditolak');

    const user = await getBotUser(telegramId);
    if (action === 'approve') {
      // Trigger the BYOK wizard in the member's DM.
      if (ctx.telegram) {
        await ctx.telegram.sendMessage(
          telegramId,
          '🎉 Pendaftaran Anda disetujui. Mari siapkan kunci AI (BYOK) Anda sekarang.',
          { reply_markup: providerWizardKeyboard() }
        ).catch(() => {});
      }
      if (env.BOT_GROUP_ID && ctx.telegram) {
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
    } else if (ctx.telegram) {
      await ctx.telegram.sendMessage(
        telegramId,
        'Mohon maaf, pendaftaran Anda belum dapat disetujui saat ini.'
      ).catch(() => {});
    }
    return true;
  }

  // Provider selection during the BYOK wizard.
  async function handleByokCallback(ctx) {
    const data = String(ctx.callbackQuery && ctx.callbackQuery.data || '');
    const match = data.match(/^byok:(gemini|openai|deepseek|claude|custom)$/);
    if (!match) return false;
    if (!isAdmin(ctx.from) && isGroupChat(ctx.chat)) {
      await ctx.answerCbQuery('Tidak diizinkan.');
      return true;
    }
    const provider = match[1];
    wizardStates.set(String(ctx.chat && ctx.chat.id), { provider, startedAt: clock() });
    await ctx.editMessageText(
      'Penyedia: ' + aiProvider.providerMeta(provider).label + '\n\n' +
      (provider === 'custom'
        ? 'Kirim satu baris konfigurasi:\nBASE_URL|MODEL_NAME|API_KEY\nContoh:\nhttps://openrouter.ai/api/v1|deepseek/deepseek-r1|sk-or-v1-xxxxxx'
        : 'Kirim API key Anda pada pesan berikutnya. Pesan akan dihapus otomatis setelah validasi.')
    );
    await ctx.answerCbQuery('Pilih ' + aiProvider.providerMeta(provider).label);
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

  function resolveByokConfig(user, provider) {
    const s = user && user.provider_settings;
    const baseUrl = (s && (s.ai_base_url || s.base_url)) || (user && user.custom_base_url) ||
      (provider === 'openai' ? 'https://api.openai.com/v1' :
       provider === 'claude' ? 'https://api.anthropic.com/v1' :
       provider === 'grok' ? 'https://api.x.ai/v1' : env.CUSTOM_AI_BASE_URL);
    const model = (s && (s.ai_model || s.model)) || (user && user.custom_model) ||
      (provider === 'gemini' || provider === 'google' ? env.GEMINI_MODEL : (provider === 'openai' ? 'gpt-4o-mini' : undefined));
    return { baseUrl, model };
  }

  // Accepts an optional { marketAnalysis: bool } to inject the clean trader style prompt.
  async function callByok(user, prompt, opts2) {
    const provider = (user && (user.ai_provider || user.provider)) || 'gemini';
    let apiKey = null;
    if (user && user.api_key_encrypted) {
      try { apiKey = safeDecryptApiKey(user.api_key_encrypted); } catch (_) {}
    }
    if (!apiKey) {
      const secret = await credentials.getUserApiKey(db, String(user.telegram_id || user.id), provider);
      if (secret.hasKey) apiKey = secret.apiKey;
    }
    if (!apiKey && (user.isAdmin || user.username === 'budi' || String(user.telegram_id) === '6396446903')) {
      apiKey = credentials.getApplicationGeminiApiKey();
    }
    if (!apiKey) return 'Kunci BYOK belum tersedia. Kirim /setkey <kunci_anda> lewat chat pribadi bot.';
    const fetchFn = opts.fetchFn || globalThis.fetch;
    const effectivePrompt = (opts2 && opts2.marketAnalysis) ? MARKET_ANALYSIS_SYSTEM + '\n\n' + prompt : prompt;
    const answerTokenCap = (opts2 && opts2.marketAnalysis) ? 450 : undefined;
    const { baseUrl, model } = resolveByokConfig(user, provider);

    const primary = async () => {
      try {
        if (provider === 'gemini' || provider === 'google') {
          const gemini = opts.gemini || require('./ai-gemini-provider');
          const result = await gemini.generateGeminiContent({
            apiKey,
            prompt: effectivePrompt,
            fetchFn,
            timeoutMs: 20000,
            model: model || env.GEMINI_MODEL,
            ...(answerTokenCap ? { maxOutputTokens: answerTokenCap } : {})
          });
          return { ok: true, text: result.text };
        }
        const result = await aiProvider.callProvider({
          providerKey: provider,
          baseUrl,
          model,
          apiKey,
          prompt: effectivePrompt,
          fetchFn,
          timeoutMs: 20000,
          ...(answerTokenCap ? { maxTokens: answerTokenCap } : {})
        });
        if (!result.ok) {
          const errMsg = String(result.error || '');
          if (/401|403|API_KEY_INVALID|Invalid.*Key|Unauthorized/i.test(errMsg)) {
            await deactivateByokOnInvalidKey(user.telegram_id || user.id, provider);
          }
          return { ok: false, error: result.error, code: 'provider_error' };
        }
        return { ok: true, text: result.text };
      } catch (e) {
        const msg = String(e && (e.message || e.code || ''));
        if (/401|403|API_KEY_INVALID|Invalid.*Key|Unauthorized/i.test(msg) || (e && e.status === 401)) {
          await deactivateByokOnInvalidKey(user.telegram_id || user.id, provider);
        }
        throw e;
      }
    };

    if (aiEvaluator && typeof aiEvaluator.evaluateWithPrimary === 'function') {
      const routed = await aiEvaluator.evaluateWithPrimary(primary, effectivePrompt, {
        env,
        fetchFn: opts.fallbackFetchFn || fetchFn,
        model: model || env.GEMINI_MODEL,
        ...(answerTokenCap ? { extra: { maxOutputTokens: answerTokenCap } } : {})
      });
      if (!routed.ok) return routed.error || 'Opini AI sedang tidak tersedia.';
      return routed.text;
    }
    const direct = await primary();
    if (!direct.ok) return direct.error || 'Opini AI sedang tidak tersedia.';
    return direct.text;
  }

  async function renderMarketCard(ctx, user, command, ticker, rangeDays) {
    const range = normalizeRangeDays(rangeDays);
    const context = buildMarketContext(roots, ticker, null, range);
    const keyboard = timeframeKeyboard(command, ticker, range);
    let text = formatBrokerCard(context);
    const isGroup = isGroupChat(ctx.chat);

    if (isGroup) {
      // ZERO BYOK / ZERO AI LOAD for group chats:
      // Fast, local database snapshot, no API key required, with deep link to Web Dashboard
      const dashUrl = _getPublicWebBase().publicWebUrl('/analisis-saham?ticker=' + ticker, env);
      text += '\n\n📊 <i>Analisa lengkap, chart interaktif & fitur money management tersedia di Web Dashboard:</i>\n' + dashUrl;
      text += '\n\n' + GROUP_PRIVACY_NOTE;
      return { text, keyboard };
    }

    if (command === 'analisa') {
      const token = issueWebviewToken({ ticker, asOf: context.asOf, telegramId: String(ctx.from.id) });
      const link = publicBase ? publicBase + '/webview/' + token : '/webview/' + token;
      const narrative = await callByok(user, JSON.stringify({
        ticker,
        rangeDays: range,
        question: 'Buat kesimpulan singkat berbasis data lokal ini. Jangan menambah angka di luar data.',
        context
      }), { marketAnalysis: true });
      text += '\n\nOpini AI:\n' + narrative + '\n\nChart sekali pakai (5 menit):\n' + link;
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
      command === 'bandar' || command === 'bd' ||
      command === 'tanya' || command === 'opini';

    const isGroup = isGroupChat(ctx.chat);

    // In group chats: ZERO BYOK / ZERO AI LOAD.
    // Daily quota and key session check apply ONLY to DM (private chats).
    if (!isGroup) {
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
      if (quotaCommand && !isAdmin(ctx.from)) {
        const session = await ensureKeySession(ctx, access.user);
        if (!session.ok) return;
      }
    }
    let finalText = '';

    if (command === 'scan' || command === 'screener') {
      const mode = String(parsed.args[0] || 'daytrade').toLowerCase();
      const snapshot = opts.loadScreener ? opts.loadScreener() : loadScreener(roots.screener);
      finalText = await runProgress(ctx, async () => {
        let card = formatScanCard(snapshot, mode);
        if (isGroup) {
          const dashUrl = _getPublicWebBase().publicWebUrl('/dashboard', env);
          card += '\n\n📊 <i>Analisa lengkap, chart interaktif & fitur money management tersedia di Web Dashboard:</i>\n' + dashUrl;
        }
        return card;
      });
    } else if (command === 'opini') {
      finalText = await runProgress(ctx, async () => {
        const snapshot = opts.loadScreener ? opts.loadScreener() : loadScreener(roots.screener);
        const top = (snapshot.daytrade || []).slice(0, 5).map((row) => ({
          ticker: row.ticker || row.symbol,
          score: row.unified_score != null ? row.unified_score
            : (row.score != null ? row.score : row.fusion_score),
          sector: row.sector || null
        }));
        if (isGroup) {
          const dashUrl = _getPublicWebBase().publicWebUrl('/dashboard', env);
          let summary = '📊 <b>Snapshot Radar Pasar Auto-Cuan (VPS Lokal):</b>\n\n';
          if (top.length) {
            summary += top.map((t, i) => `${i + 1}. <b>${t.ticker}</b> (Score: ${t.score || '—'}${t.sector ? ' · ' + t.sector : ''})`).join('\n');
          } else {
            summary += 'Belum ada kandidat radar terkunci hari ini.';
          }
          summary += '\n\n📊 <i>Analisa lengkap, chart interaktif & fitur money management tersedia di Web Dashboard:</i>\n' + dashUrl;
          return summary;
        }
        const question = parsed.args.join(' ').trim().slice(0, 300) ||
          'Berikan opini objektif kondisi market hari ini dan sektor yang paling menarik.';
        const injection = marketContext.buildInjectionWithRoots(rootDir, question, { screenerPath: roots.screener });
        const payload = JSON.stringify({ question: question, topCandidates: top });
        const prompt = injection.context
          ? injection.context + '\n\nPERMINTAAN: ' + question + '\n\nDATA KANDIDAT:\n' + payload
          : question + '\n\nDATA KANDIDAT:\n' + payload;
        return callByok(access.user, prompt, { marketAnalysis: true });
      });
    } else if (command === 'tanya') {
      const question = parsed.args.join(' ').trim().slice(0, 500);
      if (!question) {
        await ctx.reply('Gunakan /tanya <pertanyaan>.');
        return;
      }
      if (isGroup) {
        const dashUrl = _getPublicWebBase().publicWebUrl('/dashboard', env);
        finalText = await runProgress(ctx, async () => {
          return '💬 <b>Tanya Auto-Cuan (Grup Read-Only):</b>\n' +
            'Untuk menjaga respons bot tetap instan di grup publik, komputasi AI mendalam, asisten konsultasi portofolio & analisis teknikal interaktif dapat diakses langsung tanpa antre di Web Dashboard.\n\n' +
            '📊 <i>Analisa lengkap, chart interaktif & fitur money management tersedia di Web Dashboard:</i>\n' + dashUrl;
        });
      } else {
        finalText = await runProgress(ctx, async () => {
          const injection = marketContext.buildInjectionWithRoots(rootDir, question, { screenerPath: roots.screener });
          const prompt = injection.context
            ? injection.context + '\n\nPERTANYAAN: ' + question
            : question;
          return callByok(access.user, prompt, { marketAnalysis: true });
        });
      }
    } else if (command === 'bandar' || command === 'bd') {
      const ticker = normalizeTicker(parsed.args[0]);
      if (!ticker) {
        await ctx.reply('Ticker tidak valid. Gunakan /bandar <KODE_SAHAM>.');
        return;
      }
      finalText = await runProgress(ctx, async () => {
        const bandar = bandarFlow.bandarForTicker(brokerRoot, ticker, null);
        if (!bandar) return 'Data bandarmologi lokal untuk ' + ticker + ' tidak ditemukan.';
        let card = formatBandarCard(bandar, 1);
        if (isGroup) {
          const dashUrl = _getPublicWebBase().publicWebUrl('/analisis-saham?ticker=' + ticker + '&tab=bandarmologi', env);
          card += '\n\n📊 <i>Analisa lengkap, chart interaktif & fitur money management tersedia di Web Dashboard:</i>\n' + dashUrl;
        }
        return card;
      }, { reply_markup: bandarKeyboard(ticker, 1) });
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
        finalText = await runProgress(ctx, async () => {
          let card = formatInsiderCard(context);
          if (isGroup) {
            const dashUrl = _getPublicWebBase().publicWebUrl('/analisis-saham?ticker=' + ticker + '&tab=insider', env);
            card += '\n\n📊 <i>Analisa lengkap, chart interaktif & fitur money management tersedia di Web Dashboard:</i>\n' + dashUrl;
          }
          return card;
        });
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
    return true;
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

  // systemStatus is injected for testability. Defaults to real OS stats.
  const systemStatus = opts.systemStatus || (() => {
    const os = require('os');
    const mem = os.totalmem();
    const free = os.freemem();
    const used = mem - free;
    const load = os.loadavg()[0];
    const pid = process.pid;
    const uptime = process.uptime();
    const wibNow = new Date(Date.now() + (7 * 60 * 60 * 1000));
    return {
      uptimeSec: Math.floor(uptime),
      ramUsedMb: Math.floor(used / 1048576),
      ramTotalMb: Math.floor(mem / 1048576),
      cpuLoad: load,
      processes: [],
      wibTime: wibNow.toISOString().slice(0, 16).replace('T', ' ') + ' WIB'
    };
  });

  function formatUptime(seconds) {
    const h = Math.floor(seconds / 3600);
    const m = Math.floor((seconds % 3600) / 60);
    const s = seconds % 60;
    if (h > 0) return h + 'j ' + m + 'm';
    if (m > 0) return m + 'm ' + s + 'd';
    return s + 'd';
  }

  async function handleAdminVps(ctx) {
    if (!isAdmin(ctx.from)) return false;
    const isGroup = isGroupChat(ctx.chat);
    const s = systemStatus();
    const lines = [
      '📊 Status VPS',
      'Uptime: ' + formatUptime(s.uptimeSec),
      'RAM: ' + s.ramUsedMb + ' / ' + s.ramTotalMb + ' MB',
      'CPU load: ' + s.cpuLoad.toFixed(2),
      'WIB: ' + s.wibTime,
      ''
    ];
    const pm2Procs = s.processes.length ? s.processes : [
      { name: 'autocuan-bot', status: 'online' },
      { name: 'vps-api-server', status: 'online' },
      { name: 'ai-eval-once-supervisor', status: 'online' }
    ];
    for (const p of pm2Procs) {
      lines.push(p.name + ': ' + p.status);
    }
    const msg = await ctx.reply(lines.join('\n'));
    if (isGroup && msg && msg.message_id != null) {
      scheduleGroupDelete(ctx, msg.message_id, delays.vps || ADMIN_GROUP_TTL_MS);
    }
    return true;
  }

  async function handleAdminPending(ctx) {
    if (!isAdmin(ctx.from) || isGroupChat(ctx.chat)) return false;
    const rows = [];
    for (const [telegram_id, user] of db.rows) {
      if (user.status === 'pending') rows.push(user);
    }
    if (!rows.length) {
      await ctx.reply('Tidak ada user pending.');
      return true;
    }
    for (const user of rows) {
      const card = [
        'Telegram ID: ' + user.telegram_id,
        '@' + (user.username || '—'),
        'Status: ' + user.status
      ].join('\n');
      await ctx.reply(card, {
        reply_markup: {
          inline_keyboard: [[
            { text: '✅ Setujui', callback_data: 'approve:' + user.telegram_id },
            { text: '❌ Tolak', callback_data: 'reject:' + user.telegram_id }
          ]]
        }
      });
    }
    return true;
  }

  // /logs [BARIS]: tail the PM2 runner log. Admin-only, DM-only.
  // Uses execFileSync (never exec) so a raw string is never shell-interpreted.
  function tailPm2Logs(lines) {
    const n = Math.min(Math.max(Number(lines) || 100, 1), 500);
    const candidates = [
      path.join(rootDir, 'logs', 'screener-runner.log'),
      path.join(rootDir, 'logs', 'combined.log'),
      path.join(rootDir, '..', 'auto-cuan-runner', 'logs', 'screener-runner.log')
    ];
    for (const file of candidates) {
      if (fs.existsSync(file)) {
        try {
          const text = fs.readFileSync(file, 'utf8').split(/\r?\n/);
          return text.slice(-n).join('\n').slice(0, 3500);
        } catch (_) { /* try next candidate */ }
      }
    }
    try {
      return execFileSync('pm2', ['logs', '--lines', String(n), '--nostream'], {
        encoding: 'utf8',
        timeout: 8000,
        cwd: rootDir
      }).slice(0, 3500);
    } catch (_) {
      return null;
    }
  }

  function restartPm2() {
    try {
      execFileSync('pm2', ['restart', 'all'], { encoding: 'utf8', timeout: 15000, cwd: rootDir });
      return { ok: true };
    } catch (_) {
      return { ok: false };
    }
  }

  async function handleAdminLogs(ctx) {
    if (!isAdmin(ctx.from) || isGroupChat(ctx.chat)) return false;
    const parsed = parseCommand(ctx.message && ctx.message.text);
    const requested = parsed && parsed.args && parsed.args[0];
    const text = tailPm2Logs(requested);
    await ctx.reply(text ? ('📜 Log runner:\n\n' + text) : 'Log tidak tersedia.');
    return true;
  }

  async function handleAdminRestart(ctx) {
    if (!isAdmin(ctx.from) || isGroupChat(ctx.chat)) return false;
    const result = (opts.restartFn || restartPm2)();
    await ctx.reply(result && result.ok ? '♻️ PM2 restart all dijalankan.' : 'Gagal menjalankan restart PM2.');
    return true;
  }

  // Group-safe variants of the operational admin commands. They run only for
  // ADMIN_TELEGRAM_ID and auto-delete their reply within 60 seconds when issued
  // in a group, so host/PM2 details never linger in a public chat.
  async function handleAdminLogsGroupAware(ctx) {
    const guard = adminCommandGuard(ctx);
    if (!guard) return false;
    if (guard.groupTtlMs) {
      const parsed = parseCommand(ctx.message && ctx.message.text);
      const requested = parsed && parsed.args && parsed.args[0];
      const text = tailPm2Logs(requested);
      await sendAdminReply(ctx, text ? ('📜 Log runner:\n\n' + text) : 'Log tidak tersedia.');
      return true;
    }
    return await handleAdminLogs(ctx);
  }

  async function handleAdminRestartGroupAware(ctx) {
    const guard = adminCommandGuard(ctx);
    if (!guard) return false;
    if (guard.groupTtlMs) {
      const result = (opts.restartFn || restartPm2)();
      await sendAdminReply(ctx, result && result.ok ? '♻️ PM2 restart all dijalankan.' : 'Gagal menjalankan restart PM2.');
      return true;
    }
    return await handleAdminRestart(ctx);
  }

  async function handleAdminBan(ctx, ban) {
    if (!isAdmin(ctx.from) || isGroupChat(ctx.chat)) return false;
    const parsed = parseCommand(ctx.message && ctx.message.text);
    const telegramId = parsed && parsed.args && parsed.args[0];
    if (!telegramId) {
      await ctx.reply('Format: /' + (ban ? 'ban' : 'unban') + ' <TELEGRAM_ID>');
      return true;
    }
    const status = ban ? 'banned' : 'approved';
    await upsertBotUser({ telegram_id: telegramId, status, updated_at: new Date(clock()).toISOString() });
    await ctx.reply('✅ User ' + telegramId + ' ' + (ban ? 'diban.' : 'di-unban.'));
    return true;
  }

  async function handleAdminUser(ctx) {
    if (!isAdmin(ctx.from) || isGroupChat(ctx.chat)) return false;
    const parsed = parseCommand(ctx.message && ctx.message.text);
    const telegramId = parsed && parsed.args && parsed.args[0];
    if (!telegramId) {
      await ctx.reply('Format: /user <TELEGRAM_ID>');
      return true;
    }
    const user = await getBotUser(telegramId);
    if (!user) {
      await ctx.reply('User tidak ditemukan.');
      return true;
    }
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
        { text: '+5 Kuota', callback_data: 'quota_adjust:' + user.telegram_id },
        { text: '-5 Kuota', callback_data: 'quota_reduce:' + user.telegram_id },
        { text: 'Reset Hari Ini', callback_data: 'quota_reset:' + user.telegram_id }
      ]]
    };
    await ctx.reply(lines.join('\n'), { reply_markup: keyboard });
    return true;
  }

  // Resolve aggregator rows for a mode/range, preferring the pre-computed local
  // JSON cache (instant) and falling back to a live disk read.
  function flowRowsFor(mode, range) {
    const rangeKey = String(normalizeRangeDays(range));
    try {
      const cache = bandarCache.ensureFlowCache(rootDir, brokerRoot, { now: clock() });
      const rows = cache && cache[mode] && cache[mode][rangeKey];
      if (Array.isArray(rows) && rows.length) {
        return { rows, anchorDate: cache.anchor_date };
      }
    } catch (_) { /* fall through to live read */ }
    const live = bandarFlow.aggregateUniverseFlow(brokerRoot, mode, FLOW_WINDOWS[normalizeRangeDays(range)], null);
    return { rows: live, anchorDate: null };
  }

  async function handleFlow(ctx, mode) {
    const access = await requireApproved(ctx);
    if (!access.ok) return;
    const isGroup = isGroupChat(ctx.chat);
    const { rows } = flowRowsFor(mode, 1);
    const snapshot = opts.loadScreener ? opts.loadScreener() : loadScreener(roots.screener);
    const topSector = snapshot.daytrade && snapshot.daytrade[0];
    let text = formatFlowAggCard(mode, 1, rows);

    if (isGroup) {
      const dashUrl = _getPublicWebBase().publicWebUrl('/analisis-saham', env);
      text += '\n\n📊 <i>Analisa lengkap, chart interaktif & fitur money management tersedia di Web Dashboard:</i>\n' + dashUrl;
    } else {
      const narrative = await callByok(access.user, JSON.stringify({
        question: 'Berikan 1 paragraf opini objektif tentang akumulasi asing vs ritel saat ini. Cantumkan support, resisten, dan saran manajemen risiko.',
        flowSummary: { buy: rows.slice().sort((a, b) => b.net - a.net).slice(0, 3), mode }
      }));
      text += '\n\nOpini AI:\n' + narrative;
    }
    if (topSector) text += '\n\nSinyal aktif: ' + topSector.ticker;
    const keyboard = flowKeyboard(mode, 1);
    const sent = await ctx.reply(text, { parse_mode: 'HTML', reply_markup: keyboard });
    if (isGroupChat(ctx.chat) && sent && sent.message_id != null) {
      const timer = setTimeout(() => {
        ctx.deleteMessage(sent.message_id).catch(() => {});
      }, BANDAR_GROUP_TTL_MS);
      if (typeof timer.unref === 'function') timer.unref();
    }
    return true;
  }

  async function handleFlowCallback(ctx) {
    const data = String(ctx.callbackQuery && ctx.callbackQuery.data || '');
    const match = data.match(/^flow:(foreign|ritel):(1|7|30)$/);
    if (!match) return false;
    const access = await requireApproved(ctx);
    if (!access.ok) {
      await ctx.answerCbQuery('Akses belum terverifikasi.');
      return true;
    }
    const mode = match[1];
    const range = Number(match[2]);
    await ctx.answerCbQuery('Rentang ' + range + 'D');
    const { rows } = flowRowsFor(mode, range);
    let text = formatFlowAggCard(mode, range, rows);
    const narrative = await callByok(access.user, JSON.stringify({
      question: 'Opini objektif akumulasi ' + mode + ' untuk ' + range + 'D. Support, resisten, manajemen risiko.',
      flowSummary: { buy: rows.slice().sort((a, b) => b.net - a.net).slice(0, 3), mode, range }
    }));
    text += '\n\nOpini AI:\n' + narrative;
    const keyboard = flowKeyboard(mode, range);
    await ctx.editMessageText(text, { parse_mode: 'HTML', reply_markup: keyboard });
    return true;
  }

  // Bandarmologi timeframe buttons edit the existing card in place.
  async function handleBandarCallback(ctx) {
    const data = String(ctx.callbackQuery && ctx.callbackQuery.data || '');
    const match = data.match(/^bandar:([A-Z0-9]{2,8}):(1|7|30)$/);
    if (!match) return false;
    const access = await requireApproved(ctx);
    if (!access.ok) {
      await ctx.answerCbQuery('Akses belum terverifikasi.');
      return true;
    }
    const ticker = match[1];
    const range = Number(match[2]);
    const bandar = bandarFlow.bandarForTickerWindow(brokerRoot, ticker, FLOW_WINDOWS[range], null)
      || bandarFlow.bandarForTicker(brokerRoot, ticker, null);
    if (!bandar) {
      await ctx.answerCbQuery('Data tidak ditemukan.');
      return true;
    }
    await ctx.editMessageText(formatBandarCard(bandar, range), {
      parse_mode: 'HTML',
      reply_markup: bandarKeyboard(ticker, range)
    });
    await ctx.answerCbQuery('Rentang ' + range + 'D');
    return true;
  }

  // /pin — manual pin by admin (reply to target message)
  async function handlePin(ctx) {
    if (!isAdmin(ctx.from)) {
      if (isGroupChat(ctx.chat)) {
        const sent = await ctx.reply('❌ Hanya admin yang dapat menggunakan /pin.');
        if (sent && sent.message_id != null) scheduleGroupDelete(ctx, sent.message_id, delays.denial);
      } else {
        await ctx.reply('❌ Hanya admin yang dapat menggunakan /pin.');
      }
      return true;
    }
    const replyTo = ctx.message && ctx.message.reply_to_message;
    if (!replyTo || replyTo.message_id == null) {
      await ctx.reply('📌 Balas pesan yang ingin disematkan, lalu ketik /pin.');
      return true;
    }
    const targetId = replyTo.message_id;
    try {
      await pinMessage(ctx, targetId);
      await ctx.reply('📌 Pesan berhasil disematkan.');
    } catch (e) {
      const msg = e && e.message ? e.message : 'unknown';
      await ctx.reply('❌ Gagal menyematkan pesan: ' + msg);
    }
    return true;
  }

  // /deepscan — weekend macro swing 1-3 bulan, resource-conservative
  async function handleDeepScan(ctx) {
    const access = await requireApproved(ctx);
    if (!access.ok) return true;
    const isGroup = isGroupChat(ctx.chat);
    if (!isGroup) {
      const session = await ensureKeySession(ctx, access.user);
      if (!session.ok) return true;
    }

    const deepscan = _getDeepscan();
    if (!deepscan) {
      await ctx.reply('❌ Engine DeepScan tidak tersedia.');
      return true;
    }

    // Guard: weekend + 1x per weekend
    const now = new Date(clock());
    let state = null;
    let dbState = null;
    try { state = deepscan.loadDeepScanState(rootDir); } catch (_) {}
    try { dbState = await deepscan.loadDeepScanStateDb(db); } catch (_) {}
    const effectiveState = dbState || state;
    const guard = deepscan.canRunDeepScan(now, effectiveState);
    if (!guard.allowed) {
      await ctx.reply(guard.message);
      return true;
    }

    // Progress notice
    const progressMsg = await ctx.reply('🔍 Sedang melakukan deepscan akhir pekan (estimasi 5-15 menit)...');
    let result;
    try {
      result = await deepscan.runDeepScan({
        rootDir,
        db,
        now,
        batchSize: 50,
        onProgress: async (info) => {
          // Optional: edit progress message every batch
          try {
            if (progressMsg && progressMsg.message_id && ctx.telegram && typeof ctx.telegram.editMessageText === 'function') {
              const pct = Math.round((info.batch / info.totalBatches) * 100);
              await ctx.telegram.editMessageText(ctx.chat.id, progressMsg.message_id, undefined,
                '🔍 DeepScan batch ' + info.batch + '/' + info.totalBatches + ' (' + pct + '%) — ' + info.processed + '/' + info.total + ' ticker diproses...');
            }
          } catch (_) {}
        }
      });
    } catch (e) {
      await ctx.reply('❌ DeepScan gagal: ' + (e && e.message ? e.message : 'unknown'));
      return true;
    }

    if (!result || !result.ok) {
      await ctx.reply((result && result.message) || '❌ DeepScan gagal.');
      return true;
    }

    // AI summary for top 3-5 picks using BYOK
    let aiSummary = '';
    try {
      const topForAi = (result.top_picks || []).slice(0, 5).map(p => ({
        ticker: p.ticker,
        score: p.score,
        entry: p.entry_low + '-' + p.entry_high,
        sl: p.stop_loss,
        tp1: p.tp1,
        tp2: p.tp2,
        rr1: p.rr_to_tp1,
        rr2: p.rr_to_tp2,
        rsi: p.rsi14,
        floor: p.accumulation_floor
      }));
      if (topForAi.length) {
        const prompt = 'Berikan ringkasan AI untuk ' + topForAi.length + ' saham terbaik hasil DeepScan weekend macro swing 1-3 bulan. Data: ' + JSON.stringify(topForAi) + '. Jelaskan kenapa menarik, level entry/SL/TP, dan risiko. Maks 300 kata, bahasa Indonesia santai, evidence-based.';
        aiSummary = await callByok(access.user, prompt, { marketAnalysis: true });
      }
    } catch (_) { aiSummary = ''; }

    let text = deepscan.formatDeepScanMessage(result);
    if (!isGroup && aiSummary) text += '\n\n🤖 <b>Ringkasan AI (BYOK):</b>\n' + aiSummary;
    if (isGroup) {
      const dashUrl = _getPublicWebBase().publicWebUrl('/deepscan', env);
      text += '\n\n📊 <i>Analisa lengkap, chart interaktif & fitur money management tersedia di Web Dashboard:</i>\n' + dashUrl;
    }

    // Dispatch with is_permanent:true — kebal pembersihan pesan
    let sent;
    try {
      sent = await ctx.telegram.sendMessage(ctx.chat.id, text, {
        parse_mode: 'HTML',
        disable_web_page_preview: true
      });
      // Mark as permanent in DB if available (for cleanup guard)
      if (sent && sent.message_id && db && typeof db.from === 'function') {
        try {
          await db.from('telegram_transient_messages').upsert({
            chat_id: Number(ctx.chat.id),
            scope: 'deepscan_permanent_' + result.weekendKey,
            message_id: Number(sent.message_id),
            updated_at: new Date().toISOString(),
            is_permanent: true
          }, { onConflict: 'chat_id,scope' });
        } catch (_) {}
      }
    } catch (e) {
      // Fallback via ctx.reply
      sent = await ctx.reply(text, { parse_mode: 'HTML' });
    }

    // Auto-pin
    if (sent && sent.message_id != null) {
      try {
        await pinMessage(ctx, sent.message_id);
      } catch (_) {
        // Pin failure should not fail the whole command
      }
    }

    return true;
  }

  async function handleUpdate(ctx) {
    if (ctx.callbackQuery) {
      const data = String(ctx.callbackQuery.data || '');
      if (data.startsWith('quota_')) return handleQuotaCallback(ctx);
      if (data.startsWith('tf:')) return handleTimeframe(ctx);
      if (data.startsWith('bandar:')) return handleBandarCallback(ctx);
      if (data.startsWith('flow:')) return handleFlowCallback(ctx);
      if (data.startsWith('setkey:') || data.startsWith('setkey_') || data.startsWith('byok_wizard:')) return handleSetKeyCallback(ctx);
      if (data.startsWith('byok:')) return handleByokCallback(ctx);
      if (data.startsWith('approve:') || data.startsWith('reject:')) return handleApproval(ctx);
      return false;
    }
    const text = ctx.message && ctx.message.text;
    const parsed = parseCommand(text);
    if (parsed && (parsed.command === 'setkey' || parsed.command === 'kunci')) return handleSetKeyCommand(ctx, parsed);
    if (parsed && (parsed.command === 'start' || parsed.command === 'akun')) return handleStart(ctx);
    if (parsed && parsed.command === 'deepscan') return handleDeepScan(ctx);
    if (parsed && parsed.command === 'pin') return handlePin(ctx);
    if (parsed && parsed.command === 'bersihkan') return handleBersihkan(ctx);
    if (parsed && parsed.command === 'limit') return handleAdminQuota(ctx);
    if (parsed && (parsed.command === 'vps' || parsed.command === 'status')) return handleAdminVps(ctx);
    if (parsed && parsed.command === 'pending') return handleAdminPending(ctx);
    if (parsed && parsed.command === 'user') return handleAdminUser(ctx);
    if (parsed && parsed.command === 'ban') return handleAdminBan(ctx, true);
    if (parsed && parsed.command === 'unban') return handleAdminBan(ctx, false);
    if (parsed && parsed.command === 'logs') return handleAdminLogsGroupAware(ctx);
    if (parsed && parsed.command === 'restart') return handleAdminRestartGroupAware(ctx);
    if (parsed && (parsed.command === 'foreign' || parsed.command === 'ritel')) return handleFlow(ctx, parsed.command);
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
    issueRegistrationToken,
    consumeRegistrationToken,
    invalidateRegistrationToken,
    createWebServer,
    buildMarketContext,
    getBotUser,
    keySession,
    touchKeySession,
    registerBase: () => resolveRegisterBase(),
    constants: {
      VERIFY_TTL_MS,
      WEBVIEW_TTL_MS,
      GROUP_DENIAL_TTL_MS,
      GROUP_RESULT_TTL_MS,
      WELCOME_TTL_MS,
      REGISTER_TTL_MS,
      KEY_SESSION_TTL_MS,
      BANDAR_GROUP_TTL_MS,
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
