#!/usr/bin/env node
'use strict';

/**
 * Hybrid Failover Checker — Vercel Primer + VPS Fallback
 * =======================================================
 * Mengecek kesehatan webhook Telegram Verification Bot dan otomatis
 * failover antara Vercel (primer) dan VPS (fallback).
 *
 * - Vercel primer: https://autocuan.web.id/api/reset-password?action=telegram-verify-webhook-v3
 *   (menangani webhook & web registration, hemat RAM VPS <100MB)
 * - VPS fallback: http://127.0.0.1:3000/api/reset-password?action=telegram-verify-webhook-v3
 *   via cloudflared tunnel atau Nginx reverse proxy
 *
 * Logika:
 * 1. Cek getWebhookInfo → url, pending_update_count, last_error_message
 * 2. Cek kesehatan Vercel (GET Vercel URL, expect 200/405, bukan 402)
 * 3. Cek kesehatan VPS lokal (POST localhost:3000 dengan secret, expect 200)
 * 4. Jika Vercel 402/5xx/timeout + VPS sehat → setWebhook ke VPS URL
 * 5. Jika Vercel sehat → setWebhook ke Vercel URL (kembalikan primer)
 * 6. Jika keduanya down → biarkan webhook tetap, log warning
 *
 * Usage:
 *   node tools/check-webhook-health.js --dry-run   # hanya cek, tidak ubah webhook
 *   node tools/check-webhook-health.js --execute   # cek + failover jika perlu
 *   node tools/check-webhook-health.js --json      # output JSON
 *
 * Env:
 *   TELEGRAM_VERIFY_BOT_TOKEN (required)
 *   TELEGRAM_VERIFY_WEBHOOK_SECRET (required for VPS health check)
 *   VERCEL_WEBHOOK_URL (default: https://autocuan.web.id/api/reset-password?action=telegram-verify-webhook-v3)
 *   VPS_WEBHOOK_URL (default: https://autocuan.web.id/api/telegram-verify-webhook via VPS, atau cloudflared URL)
 *   VPS_LOCAL_URL (default: http://127.0.0.1:3000/api/reset-password?action=telegram-verify-webhook-v3)
 */

const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');

function loadEnvFiles(env, cwd) {
  const files = [
    '.env',
    '.env.intraday-runtime',
    '.env.local',
    '.env.bot',
    '.env.ai-eval-once',
    path.join('/home/ubuntu/auto-cuan-runner/telegram-webhook-v3-secret.env'),
    path.join('/home/ubuntu/auto-cuan-runner/telegram-lifecycle.env'),
    path.join('/home/ubuntu/auto-cuan/.env.intraday-runtime'),
    path.join('/home/ubuntu/auto-cuan/.env.bot'),
    path.join('/home/ubuntu/auto-cuan/.env.local'),
  ];
  for (const file of files) {
    const filePath = path.isAbsolute(file) ? file : path.join(cwd || ROOT, file);
    if (!fs.existsSync(filePath)) continue;
    try {
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
    } catch (_) {}
  }
  return env;
}

function parseArgs(argv) {
  const opts = { dryRun: true, execute: false, json: false, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = argv[i];
    if (a === '--dry-run') { opts.dryRun = true; opts.execute = false; }
    else if (a === '--execute') { opts.execute = true; opts.dryRun = false; }
    else if (a === '--json') opts.json = true;
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

const DEFAULT_VERCEL_URL = 'https://autocuan.web.id/api/reset-password?action=telegram-verify-webhook-v3';
const DEFAULT_VPS_LOCAL_URL = 'http://127.0.0.1:3000/api/reset-password?action=telegram-verify-webhook-v3';
// VPS public URL via cloudflared tunnel or Nginx — will be resolved dynamically
// For now, use a placeholder that will be replaced by actual tunnel URL if available
const DEFAULT_VPS_PUBLIC_URL = process.env.VPS_WEBHOOK_URL || 'https://autocuan.web.id/api/reset-password?action=telegram-verify-webhook-v3';

async function fetchWithTimeout(url, options = {}, timeoutMs = 8000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { ...options, signal: controller.signal });
    const text = await res.text();
    let json = null;
    try { json = text ? JSON.parse(text) : null; } catch (_) {}
    return { ok: res.ok, status: res.status, text, json, headers: Object.fromEntries(res.headers.entries()) };
  } catch (e) {
    return { ok: false, status: 0, error: e.message, timeout: e.name === 'AbortError' };
  } finally {
    clearTimeout(timer);
  }
}

async function getWebhookInfo(token) {
  const url = `https://api.telegram.org/bot${token}/getWebhookInfo`;
  const res = await fetchWithTimeout(url, {}, 8000);
  if (!res.ok || !res.json || !res.json.ok) {
    return { ok: false, error: res.error || (res.json && res.json.description) || `HTTP ${res.status}`, raw: res };
  }
  return { ok: true, info: res.json.result, raw: res };
}

async function setWebhook(token, url, secret) {
  const apiUrl = `https://api.telegram.org/bot${token}/setWebhook`;
  const payload = {
    url: url,
    secret_token: secret || undefined,
    allowed_updates: ['message', 'callback_query', 'chat_join_request'],
    max_connections: 40,
  };
  // Remove undefined
  Object.keys(payload).forEach(k => payload[k] === undefined && delete payload[k]);
  const res = await fetchWithTimeout(apiUrl, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  }, 10000);
  if (!res.ok || !res.json || !res.json.ok) {
    return { ok: false, error: res.error || (res.json && res.json.description) || `HTTP ${res.status}`, raw: res };
  }
  return { ok: true, result: res.json.result, raw: res };
}

async function checkVercelHealth(vercelUrl) {
  // Vercel webhook endpoint returns 405 for GET without secret, 402 if DEPLOYMENT_DISABLED
  // We check the base domain health first, then the webhook endpoint
  const baseUrl = 'https://autocuan.web.id/';
  const baseRes = await fetchWithTimeout(baseUrl, { method: 'GET' }, 8000);
  const webhookRes = await fetchWithTimeout(vercelUrl, { method: 'GET' }, 8000);

  const isVercelDown = (
    (baseRes.status === 402 && baseRes.text && baseRes.text.includes('DEPLOYMENT_DISABLED')) ||
    (webhookRes.status === 402 && webhookRes.text && webhookRes.text.includes('DEPLOYMENT_DISABLED')) ||
    baseRes.status === 0 || webhookRes.status === 0 ||
    (baseRes.status >= 500) || (webhookRes.status >= 500)
  );

  return {
    base: { status: baseRes.status, ok: baseRes.ok, text: baseRes.text ? baseRes.text.slice(0, 200) : '', error: baseRes.error },
    webhook: { status: webhookRes.status, ok: webhookRes.ok, text: webhookRes.text ? webhookRes.text.slice(0, 200) : '', error: webhookRes.error },
    isDown: isVercelDown,
    isHealthy: !isVercelDown && (baseRes.ok || baseRes.status === 200 || baseRes.status === 405) && webhookRes.status !== 402,
  };
}

async function checkVpsHealth(vpsLocalUrl, secret) {
  // VPS local should handle POST with secret and return 200 ok:true (even if db null, it returns 200)
  // We test with a minimal valid update
  const testPayload = {
    update_id: 999999,
    message: {
      message_id: 1,
      from: { id: 123456, is_bot: false, first_name: 'Test' },
      chat: { id: 123456, type: 'private' },
      date: Math.floor(Date.now() / 1000),
      text: '/start',
    },
  };
  const res = await fetchWithTimeout(vpsLocalUrl, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'x-telegram-bot-api-secret-token': secret || '',
    },
    body: JSON.stringify(testPayload),
  }, 8000);

  // VPS is healthy if it returns 200 (even with ok:false for invalid update, it should be 200)
  // Actually handleVerifyWebhook returns 200 for most cases, 401 for bad secret, 405 for GET
  // So we check if status is 200 and not 5xx
  const isHealthy = res.status === 200 && !res.error;
  return {
    status: res.status,
    ok: res.ok,
    text: res.text ? res.text.slice(0, 500) : '',
    json: res.json,
    error: res.error,
    isHealthy,
  };
}

async function getVpsPublicUrl() {
  // Try to get VPS public webhook URL from various sources
  // 1. Env VPS_WEBHOOK_URL wins.
  if (process.env.VPS_WEBHOOK_URL) return process.env.VPS_WEBHOOK_URL;

  const runnerDir = process.env.AUTO_CUAN_RUNNER_DIR || '/home/ubuntu/auto-cuan-runner';

  // 2. Full webhook URL written by deploy/vps/run-cloudflared-webhook.sh.
  // This is the canonical hand-off file: the tunnel script writes the complete
  // webhook URL, so it is returned verbatim.
  const fullUrlFiles = [
    path.join(runnerDir, 'cloudflared-webhook-full-url.txt'),
    '/tmp/cloudflared-webhook-full-url.txt',
  ];
  for (const f of fullUrlFiles) {
    if (fs.existsSync(f)) {
      try {
        const url = fs.readFileSync(f, 'utf8').trim();
        if (url && url.startsWith('https://')) return url;
      } catch (_) {}
    }
  }

  // 3. Bare tunnel origin; append the webhook path.
  const tunnelFiles = [
    path.join(runnerDir, 'cloudflared-webhook-url.txt'),
    path.join(runnerDir, 'cloudflared-url.txt'),
    '/tmp/cloudflared-tunnel-url.txt',
    '/home/ubuntu/.cloudflared/tunnel-url.txt',
  ];
  for (const f of tunnelFiles) {
    if (fs.existsSync(f)) {
      try {
        let url = fs.readFileSync(f, 'utf8').trim();
        if (url && url.startsWith('https://')) {
          url = url.replace(/\/+$/, '');
          if (!url.includes('/api/')) {
            url += '/api/reset-password?action=telegram-verify-webhook-v3';
          }
          return url;
        }
      } catch (_) {}
    }
  }

  // 4. Last resort: scrape the running cloudflared log for the quick-tunnel host.
  const logFiles = [
    path.join(runnerDir, 'logs', 'cloudflared-webhook.log'),
  ];
  for (const f of logFiles) {
    if (fs.existsSync(f)) {
      try {
        const text = fs.readFileSync(f, 'utf8');
        const match = text.match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
        if (match) {
          return match[0] + '/api/reset-password?action=telegram-verify-webhook-v3';
        }
      } catch (_) {}
    }
  }

  // No public VPS origin known → do not failover (webhook stays put).
  return null;
}

async function main(argv, deps) {
  const opts = parseArgs(argv || process.argv);
  if (opts.help) {
    console.log([
      'Usage: node tools/check-webhook-health.js [--dry-run|--execute] [--json]',
      '',
      'Hybrid failover checker: Vercel primer + VPS fallback',
      '  --dry-run  Hanya cek kesehatan, tidak ubah webhook (default)',
      '  --execute  Cek + failover jika perlu (setWebhook)',
      '  --json     Output JSON',
      '',
      'Env:',
      '  TELEGRAM_VERIFY_BOT_TOKEN (required)',
      '  TELEGRAM_VERIFY_WEBHOOK_SECRET (required)',
      '  VERCEL_WEBHOOK_URL (default: https://autocuan.web.id/api/reset-password?action=telegram-verify-webhook-v3)',
      '  VPS_WEBHOOK_URL (optional, cloudflared tunnel URL)',
      '  VPS_LOCAL_URL (default: http://127.0.0.1:3000/api/reset-password?action=telegram-verify-webhook-v3)',
    ].join('\n'));
    return { exitCode: 0 };
  }

  const env = (deps && deps.env) || loadEnvFiles({ ...process.env }, ROOT);
  const token = env.TELEGRAM_VERIFY_BOT_TOKEN;
  const secret = env.TELEGRAM_VERIFY_WEBHOOK_SECRET;
  const vercelUrl = env.VERCEL_WEBHOOK_URL || DEFAULT_VERCEL_URL;
  const vpsLocalUrl = env.VPS_LOCAL_URL || DEFAULT_VPS_LOCAL_URL;
  let vpsPublicUrl = env.VPS_WEBHOOK_URL || await getVpsPublicUrl();

  if (!token) {
    const msg = 'TELEGRAM_VERIFY_BOT_TOKEN missing';
    if (opts.json) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
    else console.error(msg);
    return { exitCode: 1, error: msg };
  }

  const log = (deps && deps.log) || console.log;
  const errorLog = (deps && deps.errorLog) || console.error;

  // 1. Get current webhook info
  const webhookInfo = await getWebhookInfo(token);
  const currentUrl = webhookInfo.ok ? webhookInfo.info.url : null;
  const pending = webhookInfo.ok ? webhookInfo.info.pending_update_count : null;
  const lastError = webhookInfo.ok ? webhookInfo.info.last_error_message : null;
  const lastErrorDate = webhookInfo.ok ? webhookInfo.info.last_error_date : null;

  // 2. Check Vercel health
  const vercelHealth = await checkVercelHealth(vercelUrl);

  // 3. Check VPS health
  const vpsHealth = await checkVpsHealth(vpsLocalUrl, secret);

  // 4. Decide failover
  let decision = 'no_action';
  let targetUrl = null;
  let reason = '';

  const isVercelDown = vercelHealth.isDown;
  const isVpsHealthy = vpsHealth.isHealthy;
  const hasPendingAndError = pending != null && pending > 5 && lastError && (lastError.includes('402') || lastError.includes('DEPLOYMENT_DISABLED') || lastError.includes('Payment Required'));

  if (isVercelDown && isVpsHealthy) {
    // Vercel down, VPS healthy → failover to VPS
    if (vpsPublicUrl) {
      decision = 'failover_to_vps';
      targetUrl = vpsPublicUrl;
      reason = `Vercel down (402 DEPLOYMENT_DISABLED, pending=${pending}, last_error=${lastError}) + VPS healthy → failover to VPS`;
    } else {
      // No VPS public URL available, try to use VPS local via cloudflared quick tunnel
      // For now, we cannot failover without public URL, so we log and keep current
      decision = 'vps_no_public_url';
      reason = `Vercel down but VPS has no public URL (VPS_WEBHOOK_URL not set, no tunnel file). VPS local is healthy but not publicly reachable. Need to set VPS_WEBHOOK_URL or create cloudflared tunnel.`;
    }
  } else if (!isVercelDown && currentUrl && currentUrl !== vercelUrl && vercelHealth.isHealthy) {
    // Vercel recovered, currently on VPS → failback to Vercel
    decision = 'failback_to_vercel';
    targetUrl = vercelUrl;
    reason = `Vercel recovered (healthy) and current webhook is on VPS (${currentUrl}) → failback to Vercel primer`;
  } else if (!isVercelDown && vercelHealth.isHealthy) {
    decision = 'stay_on_vercel';
    reason = `Vercel healthy (base ${vercelHealth.base.status}, webhook ${vercelHealth.webhook.status}), pending=${pending} → stay on Vercel primer`;
  } else if (isVercelDown && !isVpsHealthy) {
    decision = 'both_down';
    reason = `Both Vercel down and VPS unhealthy (VPS status ${vpsHealth.status}, error ${vpsHealth.error}) → no failover, need manual intervention`;
  } else if (hasPendingAndError) {
    decision = 'pending_error_detected';
    reason = `Pending ${pending} + last_error ${lastError} → potential webhook issue, Vercel down=${isVercelDown}, VPS healthy=${isVpsHealthy}`;
    if (isVpsHealthy && vpsPublicUrl) {
      decision = 'failover_to_vps';
      targetUrl = vpsPublicUrl;
      reason += ' → failover to VPS';
    }
  }

  const report = {
    timestamp: new Date().toISOString(),
    wib: new Date(Date.now() + 7 * 60 * 60 * 1000).toISOString().slice(0, 19).replace('T', ' ') + ' WIB',
    current_webhook: currentUrl,
    pending_update_count: pending,
    last_error_message: lastError,
    last_error_date: lastErrorDate ? new Date(lastErrorDate * 1000).toISOString() : null,
    vercel: vercelHealth,
    vps_local: vpsHealth,
    vps_public_url: vpsPublicUrl,
    decision,
    target_url: targetUrl,
    reason,
    dry_run: !opts.execute,
  };

  if (opts.json) {
    log(JSON.stringify(report, null, 2));
  } else {
    log(`[${report.wib}] Webhook Health Check`);
    log(`Current: ${currentUrl || 'none'} | Pending: ${pending} | LastError: ${lastError || 'none'}`);
    log(`Vercel: ${vercelHealth.isDown ? 'DOWN' : 'HEALTHY'} (base ${vercelHealth.base.status}, webhook ${vercelHealth.webhook.status})`);
    log(`VPS Local: ${vpsHealth.isHealthy ? 'HEALTHY' : 'DOWN'} (status ${vpsHealth.status})`);
    log(`VPS Public URL: ${vpsPublicUrl || 'not set'}`);
    log(`Decision: ${decision}`);
    log(`Reason: ${reason}`);
    if (targetUrl) log(`Target: ${targetUrl}`);
    log(`Mode: ${opts.execute ? 'EXECUTE' : 'DRY-RUN'}`);
  }

  // 5. Execute failover if needed and --execute
  if (opts.execute && targetUrl && (decision === 'failover_to_vps' || decision === 'failback_to_vercel')) {
    if (!secret) {
      const msg = 'TELEGRAM_VERIFY_WEBHOOK_SECRET missing, cannot setWebhook with secret';
      errorLog(msg);
      report.setWebhook = { ok: false, error: msg };
      if (opts.json) log(JSON.stringify(report, null, 2));
      return { exitCode: 1, report };
    }
    log(`Executing setWebhook → ${targetUrl} ...`);
    const setResult = await setWebhook(token, targetUrl, secret);
    report.setWebhook = setResult;
    if (setResult.ok) {
      log(`setWebhook OK → ${targetUrl}`);
      // Verify
      const verify = await getWebhookInfo(token);
      report.verify = verify;
      if (verify.ok) log(`Verified webhook now: ${verify.info.url} pending=${verify.info.pending_update_count}`);
    } else {
      errorLog(`setWebhook FAILED: ${setResult.error}`);
      if (setResult.raw) errorLog(`Raw: ${JSON.stringify(setResult.raw).slice(0, 500)}`);
    }
    if (opts.json) log(JSON.stringify(report, null, 2));
    return { exitCode: setResult.ok ? 0 : 1, report };
  }

  return { exitCode: 0, report };
}

if (require.main === module) {
  main().then(out => { process.exitCode = out.exitCode; }).catch(err => {
    console.error('check-webhook-health error:', err && err.message ? err.message : err);
    process.exitCode = 1;
  });
}

module.exports = {
  loadEnvFiles,
  parseArgs,
  getWebhookInfo,
  setWebhook,
  checkVercelHealth,
  checkVpsHealth,
  getVpsPublicUrl,
  main,
};
