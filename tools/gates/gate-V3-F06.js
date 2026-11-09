'use strict';
// Gate V3-F06 — Tombol Uji kirim pesan Telegram Pusat Akun + Broadcast Signal Saham Bot (21:45 WIB).
// Verifikasi: handler frontend btn-test-telegram disabled+Mengirim... POST /api/user/telegram/test
// toast sukses/gagal deterministik + restore label; backend verifikasi sesi, chatId fallback
// 6396446903, baca TELEGRAM_BOT_TOKEN, kirim HTTPS nyata via telegram-notifier
// (skip_market_guard) teks "Auto-Cuan Test Alert ... username (ID: chatId)";
// 0 empty heartbeat Day Trade ke Telegram (log lokal saja);
// 0 hardcode 16:15 WIB di skrip broadcast malam + sinkron 21:45 WIB + Dynamic Preflight Gate.
// ATURAN BESI: no GH polling/sleep, no Vercel, Windows node -e, data riil, anti-gate-gaming.
const fs = require('fs');
const path = require('path');
const lib = require('./lib');

const ROOT = path.resolve(__dirname, '..', '..');
const OUT = path.join(ROOT, 'bukti-verifikasi-final', 'gates-v3', 'F06.json');

const result = lib.newResult('V3-F06', 'Uji Telegram Pusat Akun + blokir heartbeat + rekap malam 21:45 WIB');

function read(p) { try { return fs.readFileSync(path.join(ROOT, p), 'utf8'); } catch (_) { return null; } }
function exists(p) { try { return fs.existsSync(path.join(ROOT, p)); } catch (_) { return false; } }

// --- Kontrol negatif: validator chatId/test-response wajib MENOLAK korup ---
function testResponseValidator(sample) {
  if (!sample || typeof sample !== 'object') return false;
  if (sample.ok !== true) return false;
  if (typeof sample.chat_id !== 'string' || !/^\d{4,20}$/.test(sample.chat_id)) return false;
  if (sample.simulated === true) return false;
  return true;
}

async function main() {
  const ncSamples = [
    { ok: false, chat_id: '6396446903' },
    { ok: true, chat_id: '' },
    { ok: true, chat_id: 'abc' },
    { ok: true },
    { ok: true, chat_id: '6396446903', simulated: true },
    { ok: 'true', chat_id: '6396446903' },
    null,
    { ok: true, chat_id: '12' }
  ];
  const nc = lib.runNegativeControl(ncSamples, testResponseValidator);
  result.negativeControl = {
    description: 'Suntik ok:false/chat_id kosong/bukan-digit/hilang/simulasi/bukan-boolean; validator wajib menolak',
    injected: nc.injected, detected: nc.detected,
    pass: nc.injected >= 1 && nc.detected === nc.injected
  };

  // 1. Scope file ada.
  const scopeFiles = [
    'public/account-center-v1.js',
    'lib/user-telegram-test-handler.js',
    'api/reset-password.js',
    'tools/local-dev-server.js',
    'vercel.json',
    'lib/telegram-daily-recap.js',
    'tools/run-daily-afternoon-recap.js',
    'deploy/vps/run-daily-afternoon-recap.sh',
    'deploy/vps/final-schedule.cron',
    'api/sector-hot.js'
  ];
  const missingScope = scopeFiles.filter((f) => !exists(f));
  lib.addAssertion(result, 'scope V3-F06 selaras (frontend+backend+recap+cron+sector-hot)', missingScope.length === 0,
    '10/10 ada', missingScope.length ? ('hilang: ' + missingScope.join(',')) : '10/10 ada');

  // 2. Frontend: handler btn-test-telegram disabled+Mengirim... POST toast deterministik restore.
  let feOk = false;
  let feDetail = 'tidak terbaca';
  try {
    const s = read('public/account-center-v1.js') || '';
    const hasBtn = s.indexOf('id="btn-test-telegram"') >= 0 || s.indexOf("id='btn-test-telegram'") >= 0
      || s.indexOf('btn-test-telegram') >= 0;
    const hasHandler = s.indexOf('window.acTestTelegram') >= 0;
    const hasDisabled = s.indexOf('btn.disabled = true') >= 0 || s.indexOf('btn.disabled=true') >= 0;
    const hasSending = s.indexOf('Mengirim...') >= 0;
    const hasPost = s.indexOf('/api/user/telegram/test') >= 0;
    const hasToastOk = s.indexOf('Uji pesan Telegram berhasil dikirim') >= 0 && s.indexOf("'success'") >= 0;
    const hasToastFail = s.indexOf('Gagal mengirim uji pesan') >= 0 && s.indexOf("'error'") >= 0;
    const hasRestore = s.indexOf('Uji kirim pesan') >= 0 && s.indexOf('btn.disabled = false') >= 0;
    feOk = hasBtn && hasHandler && hasDisabled && hasSending && hasPost && hasToastOk && hasToastFail && hasRestore;
    feDetail = 'btn=' + hasBtn + ' handler=' + hasHandler + ' disabled=' + hasDisabled
      + ' sending=' + hasSending + ' post=' + hasPost + ' toastOk=' + hasToastOk
      + ' toastFail=' + hasToastFail + ' restore=' + hasRestore;
  } catch (e) { feDetail = 'error: ' + (e && e.message); }
  lib.addAssertion(result, 'frontend btn-test-telegram disabled+Mengirim... POST toast sukses/gagal restore', feOk === true,
    'btn+handler+disabled+post+2toast+restore', feDetail);

  // 3. Backend source: sesi + chatId fallback + token + HTTPS nyata + teks kontrak.
  let beSrcOk = false;
  let beSrcDetail = 'tidak terbaca';
  try {
    const h = read('lib/user-telegram-test-handler.js') || '';
    const hasSess = h.indexOf('requireAuthenticatedSession') >= 0 && h.indexOf('401') >= 0;
    const hasFallback = h.indexOf('6396446903') >= 0 && h.indexOf('req.user.telegram_id') >= 0;
    const hasToken = h.indexOf('TELEGRAM_BOT_TOKEN') >= 0;
    const hasSend = h.indexOf('sendTelegramMessage') >= 0 && h.indexOf('skip_market_guard') >= 0;
    const hasText = h.indexOf('Auto-Cuan Test Alert') >= 0 && h.indexOf('(ID:') >= 0;
    const hasApiHost = h.indexOf('api.telegram.org') >= 0 || read('lib/telegram-notifier.js').indexOf('api.telegram.org/bot') >= 0;
    const r = read('api/reset-password.js') || '';
    const hasRoute = r.indexOf('user-telegram-test') >= 0 && r.indexOf('user-telegram-test-handler') >= 0;
    const srv = read('tools/local-dev-server.js') || '';
    const hasAlias = srv.indexOf('user/telegram/test') >= 0 && srv.indexOf('reset-password') >= 0;
    const v = read('vercel.json') || '';
    const hasRewrite = v.indexOf('/api/user/telegram/test') >= 0;
    beSrcOk = hasSess && hasFallback && hasToken && hasSend && hasText && hasApiHost && hasRoute && hasAlias && hasRewrite;
    beSrcDetail = 'sess=' + hasSess + ' fallback=' + hasFallback + ' token=' + hasToken
      + ' send=' + hasSend + ' text=' + hasText + ' host=' + hasApiHost
      + ' route=' + hasRoute + ' alias=' + hasAlias + ' rewrite=' + hasRewrite;
  } catch (e) { beSrcDetail = 'error: ' + (e && e.message); }
  lib.addAssertion(result, 'backend sumber: sesi + chatId fallback + token + HTTPS nyata + teks kontrak + rute', beSrcOk === true,
    'sesi+fallback+token+send+teks+rute', beSrcDetail);

  // 4. Fungsional: POST handler => HTTP 200 {ok:true} + toast-sukses path (notifier stub, tanpa jaringan).
  let funcOk = false;
  let funcDetail = 'handler tidak termuat';
  try {
    process.env.SESSION_SECRET = process.env.SESSION_SECRET || 'gate-v3-f06-secret-1234567890';
    // Gate memakai token dummy non-placeholder + stub notifier: jalur HTTPS nyata
    // tetap diverifikasi via source assertion (api.telegram.org) tanpa jaringan.
    // Dummy sengaja TIDAK berbentuk <id>:<token> agar tidak memicu pemindai
    // kredensial telegram-bot-token (false positive) — tetap non-placeholder.
    const origBotToken = process.env.TELEGRAM_BOT_TOKEN;
    process.env.TELEGRAM_BOT_TOKEN = 'gate-v3-f06-dummy-token-local-assertion-only-not-a-real-secret';
    const adminSession = require(path.join(ROOT, 'lib', 'admin-session'));
    const token = adminSession.createSessionToken({ userId: 'gate-u1', username: 'budi', isAdmin: true });
    if (!token) {
      funcDetail = 'gagal membuat session token (SESSION_SECRET?)';
    } else {
      const notifierPath = path.join(ROOT, 'lib', 'telegram-notifier');
      const notifier = require(notifierPath);
      const origSend = notifier.sendTelegramMessage;
      let captured = null;
      notifier.sendTelegramMessage = async (text, options) => {
        captured = { text: String(text || ''), options: options || {} };
        return { sent: true, skipped: false, reason: null, status: 200 };
      };
      try {
        delete require.cache[path.join(ROOT, 'lib', 'user-telegram-test-handler.js')];
        const handler = require(path.join(ROOT, 'lib', 'user-telegram-test-handler'));
        const mkRes = () => {
          const r = { statusCode: 200, body: null };
          r.status = function (c) { r.statusCode = c; return r; };
          r.json = function (d) { r.body = d; return r; };
          r.setHeader = function () {};
          return r;
        };
        // 4a. Tanpa sesi => 401 {ok:false}.
        const res401 = mkRes();
        await handler({ method: 'POST', headers: {}, query: {}, body: {} }, res401);
        const unauthOk = res401.statusCode === 401 && res401.body && res401.body.ok === false;
        // 4b. Dengan sesi => 200 {ok:true}, chat 6396446903, teks kontrak.
        const res200 = mkRes();
        const reqOk = { method: 'POST', headers: { cookie: 'ac_sess=' + token }, query: {}, body: {} };
        await handler(reqOk, res200);
        const okStatus = res200.statusCode === 200 && res200.body && res200.body.ok === true;
        const okChat = res200.body && String(res200.body.chat_id) === '6396446903';
        const okText = captured && captured.text.indexOf('Auto-Cuan Test Alert') >= 0
          && captured.text.indexOf('budi') >= 0 && captured.text.indexOf('(ID: 6396446903)') >= 0;
        const okChatOpt = captured && String(captured.options.chat_id) === '6396446903';
        const okGuard = captured && captured.options.skip_market_guard === true;
        funcOk = unauthOk === true && okStatus === true && okChat === true && okText === true && okChatOpt === true && okGuard === true;
        funcDetail = '401=' + unauthOk + '(' + res401.statusCode + ') 200=' + okStatus + '(' + res200.statusCode + ')'
          + ' chat=' + okChat + ' text=' + okText + ' chatOpt=' + okChatOpt + ' guard=' + okGuard;
      } finally {
        notifier.sendTelegramMessage = origSend;
        if (origBotToken === undefined) { delete process.env.TELEGRAM_BOT_TOKEN; }
        else { process.env.TELEGRAM_BOT_TOKEN = origBotToken; }
      }
    }
  } catch (e) { funcDetail = 'error: ' + (e && e.message); }
  lib.addAssertion(result, 'POST /api/user/telegram/test => HTTP 200 {ok:true} + toast sukses (401 tanpa sesi)', funcOk === true,
    '401 lalu 200 ok:true chat:6396446903 teks kontrak', funcDetail);

  // 5. 0 empty heartbeat Day Trade ke Telegram (log lokal saja).
  let hbOk = false;
  let hbDetail = 'tidak terbaca';
  try {
    const s = read('api/sector-hot.js') || '';
    let heartbeatSends = 0;
    let idx = 0;
    while ((idx = s.indexOf('sendTelegramMessage', idx + 1)) > 0) {
      const ctx = s.slice(Math.max(0, idx - 160), idx + 160);
      if (/heartbeat|Heartbeat|HEARTBEAT/i.test(ctx)) heartbeatSends += 1;
    }
    const hasBlockLog = s.indexOf('V3-F06-HEARTBEAT-BLOCKED') >= 0;
    const hasDisabledReason = s.indexOf('empty_heartbeat_disabled') >= 0;
    const hasDeferredSilent = s.indexOf("reason: 'empty_heartbeat_disabled'") >= 0
      || s.indexOf('reason: "empty_heartbeat_disabled"') >= 0;
    hbOk = heartbeatSends === 0 && hasBlockLog && hasDisabledReason && hasDeferredSilent;
    hbDetail = 'heartbeatSends=' + heartbeatSends + ' blockLog=' + hasBlockLog
      + ' disabledReason=' + hasDisabledReason + ' silent=' + hasDeferredSilent;
  } catch (e) { hbDetail = 'error: ' + (e && e.message); }
  lib.addAssertion(result, '0 empty heartbeat Day Trade ke Telegram (log lokal saja)', hbOk === true,
    '0 sends + blocked-log + disabled', hbDetail);

  // 6. 0 hardcode 16:15 WIB di skrip broadcast malam + sinkron 21:45 WIB.
  let timeOk = false;
  let timeDetail = 'tidak terbaca';
  try {
    const files = [
      'lib/telegram-daily-recap.js',
      'tools/run-daily-afternoon-recap.js',
      'deploy/vps/run-daily-afternoon-recap.sh',
      'deploy/vps/final-schedule.cron'
    ];
    let hard = 0;
    const per = [];
    for (const f of files) {
      const c = read(f) || '';
      const n = (c.match(/16:15/g) || []).length;
      hard += n;
      per.push(f.split('/').pop() + ':' + n);
    }
    const recap = read('lib/telegram-daily-recap.js') || '';
    const has2145Default = recap.indexOf("options.timeStr || '21:45 WIB'") >= 0
      || recap.indexOf('21:45 WIB') >= 0;
    const runner = read('tools/run-daily-afternoon-recap.js') || '';
    const hasRunner2145 = runner.indexOf('21:45') >= 0;
    const sh = read('deploy/vps/run-daily-afternoon-recap.sh') || '';
    const hasSh2145 = sh.indexOf('45 21') >= 0 && sh.indexOf('21:45 WIB') >= 0;
    const cron = read('deploy/vps/final-schedule.cron') || '';
    const hasCron2145 = cron.indexOf('45 21 * * 1-5') >= 0 && cron.indexOf('afternoon-recap') >= 0;
    timeOk = hard === 0 && has2145Default && hasRunner2145 && hasSh2145 && hasCron2145;
    timeDetail = 'hard16:15=' + hard + ' [' + per.join(' ') + '] 2145=' + has2145Default
      + ' runner=' + hasRunner2145 + ' sh=' + hasSh2145 + ' cron=' + hasCron2145;
  } catch (e) { timeDetail = 'error: ' + (e && e.message); }
  lib.addAssertion(result, '0 hardcode 16:15 WIB + sinkron 21:45 WIB (lib+runner+sh+cron)', timeOk === true,
    '0x16:15 + 4x21:45', timeDetail);

  // 7. Dynamic Preflight Gate: rutin kirim meski foreign belum lengkap.
  let pfOk = false;
  let pfDetail = 'tidak terbaca';
  try {
    const runner = read('tools/run-daily-afternoon-recap.js') || '';
    const hasPreflight = runner.indexOf('preflight') >= 0
      && runner.indexOf('foreign') >= 0
      && runner.indexOf('tetap kirim') >= 0;
    const recapLib = read('lib/telegram-daily-recap.js') || '';
    const hasSkipGuard = recapLib.indexOf('skip_market_guard: true') >= 0
      || recapLib.indexOf('skip_market_guard:true') >= 0;
    const hasFallbackHonest = recapLib.indexOf('Tidak ada sinyal rekomendasi aktif') >= 0;
    pfOk = hasPreflight === true && hasSkipGuard === true && hasFallbackHonest === true;
    pfDetail = 'preflight=' + hasPreflight + ' skipGuard=' + hasSkipGuard + ' fallback=' + hasFallbackHonest;
  } catch (e) { pfDetail = 'error: ' + (e && e.message); }
  lib.addAssertion(result, 'Dynamic Preflight Gate rutin kirim meski foreign belum lengkap', pfOk === true,
    'preflight+skipGuard+fallback', pfDetail);

  // 8. Kontrol negatif lolos.
  lib.addAssertion(result, 'kontrol negatif lolos (injected>=1, detected==injected)',
    result.negativeControl.injected >= 1 && result.negativeControl.detected === result.negativeControl.injected,
    'detected==injected>=1', 'injected=' + result.negativeControl.injected + ' detected=' + result.negativeControl.detected);

  lib.finalizeGate(result, OUT);
}

main().catch((e) => {
  try {
    lib.addAssertion(result, 'gate V3-F06 tidak exception', false, 'no-exception', String((e && e.message) || e).slice(0, 200));
    lib.finalizeGate(result, OUT);
  } catch (_) { process.exit(1); }
});
