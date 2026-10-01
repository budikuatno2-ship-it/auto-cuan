'use strict';

/**
 * switch-verify-webhook.js — explicit webhook placement switch for the
 * AutoCuan Verification Bot (Vercel primer ⇄ VPS fallback).
 *
 * The automatic decision maker is tools/check-webhook-health.js, driven by
 * deploy/vps/run-webhook-failover.sh on a ten-minute cron. This tool is the
 * manual override for operators: it pins the webhook to a known target so a
 * deploy or an incident can be handled deterministically.
 *
 * Usage:
 *   node tools/switch-verify-webhook.js --target=vercel          # pin to Vercel
 *   node tools/switch-verify-webhook.js --target=vps             # pin to VPS
 *   node tools/switch-verify-webhook.js --target=auto            # let the health checker decide
 *   node tools/switch-verify-webhook.js --status                 # print current placement
 *
 * Flags:
 *   --target=vercel|vps|auto   Required unless --status/--dry-run is used.
 *   --dry-run                  Resolve and print the target without setWebhook.
 *   --json                     Machine-readable output.
 *   --url=<https://...>        Explicit webhook URL override (advanced).
 *
 * Environment:
 *   TELEGRAM_VERIFY_BOT_TOKEN       (required) verification bot token.
 *   TELEGRAM_VERIFY_WEBHOOK_SECRET  (required) secret_token sent to Telegram.
 *   VERCEL_WEBHOOK_URL   (default https://autocuan.web.id/api/reset-password?action=telegram-verify-webhook-v3)
 *   VPS_WEBHOOK_URL      (optional explicit public VPS URL; otherwise the
 *                         cloudflared tunnel file written by
 *                         deploy/vps/run-cloudflared-webhook.sh is used)
 *   VPS_LOCAL_URL        (default http://127.0.0.1:3000/api/reset-password?action=telegram-verify-webhook-v3)
 *
 * The VPS fallback is only ever selected when a *publicly reachable* VPS origin
 * exists (explicit VPS_WEBHOOK_URL or a tunnel file). Without one the tool fails
 * closed and leaves the webhook where it is, because Telegram cannot reach
 * 127.0.0.1.
 *
 * No secret is ever printed. Only coarse status codes are surfaced.
 */

const fs = require('node:fs');
const path = require('node:path');

const {
  loadEnvFiles,
  getWebhookInfo,
  setWebhook,
  checkVercelHealth,
  checkVpsHealth,
  getVpsPublicUrl,
} = require('./check-webhook-health');

const WEBHOOK_PATH = '/api/reset-password?action=telegram-verify-webhook-v3';
const DEFAULT_VERCEL_URL = 'https://autocuan.web.id' + WEBHOOK_PATH;
const DEFAULT_VPS_LOCAL_URL = 'http://127.0.0.1:3000' + WEBHOOK_PATH;

const VALID_TARGETS = new Set(['vercel', 'vps', 'auto']);

function parseArgs(argv) {
  const opts = { target: null, dryRun: false, json: false, status: false, url: null, help: false };
  for (let i = 2; i < argv.length; i++) {
    const a = String(argv[i] || '');
    if (a.startsWith('--target=')) opts.target = a.slice('--target='.length).trim().toLowerCase();
    else if (a === '--target' && argv[i + 1]) opts.target = String(argv[++i]).trim().toLowerCase();
    else if (a.startsWith('--url=')) opts.url = a.slice('--url='.length).trim();
    else if (a === '--dry-run') opts.dryRun = true;
    else if (a === '--json') opts.json = true;
    else if (a === '--status') opts.status = true;
    else if (a === '--help' || a === '-h') opts.help = true;
  }
  return opts;
}

function usage() {
  return [
    'Usage: node tools/switch-verify-webhook.js --target=vercel|vps|auto [--dry-run] [--json]',
    '       node tools/switch-verify-webhook.js --status',
    '',
    '  --target=vercel  Pin the webhook to the Vercel primer endpoint',
    '  --target=vps     Pin the webhook to the public VPS fallback endpoint',
    '  --target=auto    Let tools/check-webhook-health.js decide (Vercel-first)',
    '  --status         Print the current webhook placement and exit',
    '  --dry-run        Resolve the target without calling setWebhook',
    '  --json           Machine-readable output',
    '',
    'Env: TELEGRAM_VERIFY_BOT_TOKEN, TELEGRAM_VERIFY_WEBHOOK_SECRET,',
    '     VERCEL_WEBHOOK_URL, VPS_WEBHOOK_URL, VPS_LOCAL_URL',
  ].join('\n');
}

// Telegram cannot reach 127.0.0.1: a public origin is mandatory for failover.
// Mirrors the resolution order in tools/check-webhook-health.js, whose
// getVpsPublicUrl() is async (it probes runner files and the tunnel log).
//
// `tunnelResolver` is injectable so tests can exercise the derivation branches
// deterministically (on a real VPS a live tunnel file always wins, which is the
// intended precedence).
async function resolveVpsPublicUrl(env, tunnelResolver) {
  const explicit = String(env.VPS_WEBHOOK_URL || '').trim();
  if (explicit) return explicit;

  const resolveTunnel = typeof tunnelResolver === 'function' ? tunnelResolver : getVpsPublicUrl;
  try {
    const fromFiles = await resolveTunnel();
    if (fromFiles) return fromFiles;
  } catch (_) { /* fall through to the derived origin */ }

  // Nginx-fronted VPS origin: derive it from an explicitly configured app base.
  const appBase = String(env.VPS_PUBLIC_BASE_URL || env.APP_BASE_URL || '').trim();
  if (appBase && /^https:\/\//.test(appBase)) {
    return appBase.replace(/\/+$/, '') + WEBHOOK_PATH;
  }
  return null;
}

function resolveVercelUrl(env) {
  const explicit = String(env.VERCEL_WEBHOOK_URL || '').trim();
  return explicit || DEFAULT_VERCEL_URL;
}

function resolveVpsLocalUrl(env) {
  return String(env.VPS_LOCAL_URL || '').trim() || DEFAULT_VPS_LOCAL_URL;
}

function isSameUrl(a, b) {
  if (!a || !b) return false;
  return String(a).replace(/\/+$/, '') === String(b).replace(/\/+$/, '');
}

async function main(argv, deps) {
  const opts = parseArgs(argv || process.argv);
  const log = (msg) => { if (!opts.json) console.log(msg); };

  if (opts.help) {
    console.log(usage());
    return { exitCode: 0 };
  }

  const env = deps && deps.env ? deps.env : loadEnvFiles(process.env);
  const token = String(env.TELEGRAM_VERIFY_BOT_TOKEN || '').trim();
  const secret = String(env.TELEGRAM_VERIFY_WEBHOOK_SECRET || '').trim();

  const vercelUrl = resolveVercelUrl(env);
  const vpsPublicUrl = await resolveVpsPublicUrl(env);
  const vpsLocalUrl = resolveVpsLocalUrl(env);

  if (!token) {
    const msg = 'TELEGRAM_VERIFY_BOT_TOKEN missing';
    if (opts.json) console.log(JSON.stringify({ ok: false, error: msg }, null, 2));
    else console.error(msg);
    return { exitCode: 2 };
  }

  // --- Status only ----------------------------------------------------------
  if (opts.status) {
    const info = await getWebhookInfo(token);
    const currentUrl = info.ok ? info.info.url : null;
    const report = {
      ok: info.ok,
      current_url: currentUrl,
      placement: isSameUrl(currentUrl, vercelUrl) ? 'vercel'
        : (vpsPublicUrl && isSameUrl(currentUrl, vpsPublicUrl)) ? 'vps'
          : (currentUrl ? 'unknown' : 'none'),
      pending_update_count: info.ok ? info.info.pending_update_count : null,
      last_error_message: info.ok ? (info.info.last_error_message || null) : null,
      vercel_url: vercelUrl,
      vps_public_url: vpsPublicUrl,
    };
    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else {
      log('Webhook placement: ' + report.placement);
      log('Current:  ' + (currentUrl || 'none'));
      log('Vercel:   ' + vercelUrl);
      log('VPS:      ' + (vpsPublicUrl || 'no public origin'));
      log('Pending:  ' + (report.pending_update_count == null ? 'n/a' : report.pending_update_count));
    }
    return { exitCode: info.ok ? 0 : 1, report };
  }

  if (!opts.target || !VALID_TARGETS.has(opts.target)) {
    console.error('--target must be one of: vercel | vps | auto');
    console.error(usage());
    return { exitCode: 2 };
  }

  // --- Resolve the target URL ----------------------------------------------
  let targetUrl = null;
  let decision = 'no_action';
  let reason = '';
  let vercelHealth = null;
  let vpsHealth = null;

  if (opts.url) {
    targetUrl = opts.url;
    decision = 'explicit_url';
    reason = 'Explicit --url override';
  } else if (opts.target === 'vercel') {
    targetUrl = vercelUrl;
    decision = 'pin_vercel';
    reason = 'Operator pinned the webhook to the Vercel primer';
  } else if (opts.target === 'vps') {
    if (!vpsPublicUrl) {
      decision = 'vps_no_public_url';
      reason = 'VPS has no publicly reachable origin (set VPS_WEBHOOK_URL or start the cloudflared tunnel). Refusing to point Telegram at a localhost URL.';
    } else {
      targetUrl = vpsPublicUrl;
      decision = 'pin_vps';
      reason = 'Operator pinned the webhook to the public VPS fallback';
    }
  } else {
    // auto — Vercel-first, fail over only when Vercel is down AND VPS is healthy.
    vercelHealth = await checkVercelHealth(vercelUrl);
    vpsHealth = await checkVpsHealth(vpsLocalUrl, secret);
    const info = await getWebhookInfo(token);
    const currentUrl = info.ok ? info.info.url : null;

    if (vercelHealth.isDown && vpsHealth.isHealthy && vpsPublicUrl) {
      targetUrl = vpsPublicUrl;
      decision = 'failover_to_vps';
      reason = 'Vercel down (base ' + vercelHealth.base.status + ', webhook ' + vercelHealth.webhook.status + ') + VPS healthy';
    } else if (!vercelHealth.isDown && vercelHealth.isHealthy) {
      targetUrl = vercelUrl;
      decision = 'stay_on_vercel';
      reason = 'Vercel healthy (base ' + vercelHealth.base.status + ', webhook ' + vercelHealth.webhook.status + ')';
    } else if (vercelHealth.isDown && !vpsHealth.isHealthy) {
      decision = 'both_down';
      reason = 'Both Vercel and the VPS fallback are unhealthy — no failover, manual intervention required';
    } else if (currentUrl) {
      decision = 'no_action';
      reason = 'Ambiguous health state; leaving the webhook untouched at ' + currentUrl;
    }
  }

  const report = {
    ok: false,
    target: opts.target,
    decision,
    reason,
    target_url: targetUrl,
    vercel_url: vercelUrl,
    vps_public_url: vpsPublicUrl,
    dry_run: opts.dryRun || decision === 'vps_no_public_url' || decision === 'both_down',
  };

  if (!opts.json) {
    log('Target:   ' + opts.target);
    log('Decision: ' + decision);
    log('Reason:   ' + reason);
    if (targetUrl) log('URL:      ' + targetUrl);
    log('Mode:     ' + (report.dry_run ? 'DRY-RUN' : 'EXECUTE'));
  }

  if (!targetUrl) {
    if (opts.json) console.log(JSON.stringify(report, null, 2));
    return { exitCode: decision === 'both_down' || decision === 'vps_no_public_url' ? 1 : 0, report };
  }

  // Idempotent: nothing to do when the webhook already points at the target.
  const info = await getWebhookInfo(token);
  const currentUrl = info.ok ? info.info.url : null;
  if (isSameUrl(currentUrl, targetUrl)) {
    report.ok = true;
    report.noop = true;
    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else log('Webhook already points at the target — nothing to do.');
    return { exitCode: 0, report };
  }

  if (opts.dryRun) {
    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else log('Dry run: would setWebhook to ' + targetUrl);
    return { exitCode: 0, report };
  }

  if (!secret) {
    const msg = 'TELEGRAM_VERIFY_WEBHOOK_SECRET missing, cannot setWebhook with secret';
    report.error = msg;
    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else console.error(msg);
    return { exitCode: 2, report };
  }

  const setResult = await setWebhook(token, targetUrl, secret);
  report.setWebhook = { ok: setResult.ok, error: setResult.ok ? undefined : setResult.error };
  if (!setResult.ok) {
    if (opts.json) console.log(JSON.stringify(report, null, 2));
    else console.error('setWebhook FAILED: ' + setResult.error);
    return { exitCode: 1, report };
  }

  const verify = await getWebhookInfo(token);
  report.ok = true;
  report.verified_url = verify.ok ? verify.info.url : null;
  if (opts.json) console.log(JSON.stringify(report, null, 2));
  else log('setWebhook OK → ' + (report.verified_url || targetUrl));
  return { exitCode: 0, report };
}

if (require.main === module) {
  main().then((out) => { process.exitCode = out.exitCode; }).catch((err) => {
    console.error('switch-verify-webhook error:', err && err.message ? err.message : err);
    process.exitCode = 1;
  });
}

module.exports = {
  parseArgs,
  usage,
  resolveVercelUrl,
  resolveVpsPublicUrl,
  resolveVpsLocalUrl,
  isSameUrl,
  main,
  WEBHOOK_PATH,
  DEFAULT_VERCEL_URL,
  DEFAULT_VPS_LOCAL_URL,
  VALID_TARGETS,
};
