#!/usr/bin/env node
'use strict';

/**
 * Cloudflared Web Supervisor — persistent public origin for the VPS Express app
 *
 * WHY THIS EXISTS
 * ---------------
 * `autocuan.web.id` is served by Vercel. When that deployment is paused the
 * domain answers HTTP 402 `DEPLOYMENT_DISABLED`, so every public link the bots
 * emit (register form, broker-summary viewer, chart viewer) is dead for members.
 *
 * The Express app on the VPS (auto-cuan-local-app, 127.0.0.1:3000) already serves
 * the same pages. Oracle Cloud's VCN security list blocks every inbound port
 * except 22/3001, so the app can never be reached directly. A Cloudflare tunnel
 * solves this by dialling OUT from the host — no inbound port, no firewall change.
 *
 * WHAT THIS PROCESS GUARANTEES
 * ----------------------------
 *   1. Exactly one `cloudflared tunnel --url http://127.0.0.1:3000` is running.
 *   2. Its current public hostname is always published to the URL file that
 *      lib/public-web-base.js reads, so the bots follow tunnel restarts.
 *   3. If the tunnel dies OR the public URL stops answering 200, it is torn down
 *      and replaced, and the URL file is rewritten with the new hostname.
 *
 * A quick tunnel hostname is ephemeral by design (it changes on every restart).
 * That is acceptable here because the URL is DISCOVERED, never hard-coded — the
 * bots re-read the file on every message (memoised for 30s).
 *
 * Exit codes: 0 clean shutdown, 1 unrecoverable startup error.
 */

const { spawn } = require('node:child_process');
const fs = require('node:fs');
const path = require('node:path');
const http = require('node:http');
const https = require('node:https');

const VERSION = 'CLOUDFLARED_WEB_SUPERVISOR_V1';

const ROOT = path.resolve(__dirname, '..');
const RUNNER_DIR = process.env.AUTO_CUAN_RUNNER_DIR || '/home/ubuntu/auto-cuan-runner';
const LOG_DIR = path.join(RUNNER_DIR, 'logs');
const STATE_DIR = path.join(RUNNER_DIR, 'state');

// Written by this process, read by lib/public-web-base.js. This is the handshake
// that makes the bot's links follow the live tunnel.
const URL_FILE = process.env.PUBLIC_WEB_URL_FILE || path.join(RUNNER_DIR, 'cloudflared-web-url.txt');
const PID_FILE = path.join(STATE_DIR, 'cloudflared-web-supervisor.pid');
const SUPERVISOR_LOG = path.join(LOG_DIR, 'cloudflared-web-supervisor.log');
const TUNNEL_LOG = path.join(LOG_DIR, 'cloudflared-web-tunnel.log');

// The Express app under supervision.
const TARGET_URL = process.env.PUBLIC_WEB_TARGET_URL || 'http://127.0.0.1:3000';

// Path used to prove the tunnel actually reaches the app (not just Cloudflare's
// edge). `/register.html` is the page the bots link to, so it is the most
// meaningful probe.
const HEALTH_PATH = process.env.PUBLIC_WEB_HEALTH_PATH || '/register.html';
const HEALTH_INTERVAL_MS = numberFromEnv('PUBLIC_WEB_HEALTH_INTERVAL_MS', 60000);
const HEALTH_TIMEOUT_MS = numberFromEnv('PUBLIC_WEB_HEALTH_TIMEOUT_MS', 15000);
// Consecutive failures before the tunnel is replaced. >1 avoids churning on a
// single transient blip while still recovering within ~2 minutes.
const HEALTH_FAILURE_THRESHOLD = numberFromEnv('PUBLIC_WEB_HEALTH_FAILURES', 2);
// A newly started tunnel is given this long to produce a hostname.
const URL_DISCOVERY_TIMEOUT_MS = numberFromEnv('PUBLIC_WEB_URL_DISCOVERY_MS', 45000);
const RESTART_BACKOFF_MS = numberFromEnv('PUBLIC_WEB_RESTART_BACKOFF_MS', 5000);

const CLOUDFLARED_BIN = process.env.CLOUDFLARED_BIN || 'cloudflared';

let child = null;
let shuttingDown = false;
let currentUrl = null;
let consecutiveFailures = 0;
let healthTimer = null;
let restartTimer = null;

function numberFromEnv(name, fallback) {
  const raw = process.env[name];
  if (raw == null || raw === '') return fallback;
  const n = Number(raw);
  return Number.isFinite(n) && n > 0 ? n : fallback;
}

function ensureDirs() {
  for (const dir of [RUNNER_DIR, LOG_DIR, STATE_DIR]) {
    try { fs.mkdirSync(dir, { recursive: true }); } catch (_) {}
  }
}

function stamp() {
  return new Date().toISOString();
}

function log(level, message) {
  const line = '[' + stamp() + '] ' + level + ' ' + message;
  console.log(line);
  try {
    fs.appendFileSync(SUPERVISOR_LOG, line + '\n');
  } catch (_) {}
}

function appendTunnelLog(chunk) {
  try {
    fs.appendFileSync(TUNNEL_LOG, chunk);
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// URL file publishing
// ---------------------------------------------------------------------------

function publishUrl(url) {
  currentUrl = url;
  try {
    fs.writeFileSync(URL_FILE, url + '\n', { mode: 0o644 });
    log('INFO', 'published public url -> ' + url);
  } catch (err) {
    log('ERROR', 'failed to write url file ' + URL_FILE + ': ' + (err && err.message));
  }
}

function clearUrl() {
  currentUrl = null;
  try {
    if (fs.existsSync(URL_FILE)) fs.unlinkSync(URL_FILE);
    log('WARN', 'cleared public url file (tunnel not serving)');
  } catch (_) {}
}

// ---------------------------------------------------------------------------
// Tunnel lifecycle
// ---------------------------------------------------------------------------

function extractTunnelUrl(text) {
  const match = String(text || '').match(/https:\/\/[a-z0-9-]+\.trycloudflare\.com/i);
  return match ? match[0] : null;
}

function startTunnel() {
  if (shuttingDown) return;

  log('INFO', 'starting tunnel: ' + CLOUDFLARED_BIN + ' tunnel --url ' + TARGET_URL);

  child = spawn(CLOUDFLARED_BIN, ['tunnel', '--url', TARGET_URL, '--no-autoupdate'], {
    stdio: ['ignore', 'pipe', 'pipe'],
    env: Object.assign({}, process.env, { TZ: 'Asia/Jakarta' })
  });

  let discovered = false;
  let discoveryTimer = setTimeout(() => {
    if (!discovered) {
      log('ERROR', 'no public url after ' + URL_DISCOVERY_TIMEOUT_MS + 'ms — restarting tunnel');
      stopTunnel('url_discovery_timeout');
    }
  }, URL_DISCOVERY_TIMEOUT_MS);

  function consume(chunk) {
    const text = chunk.toString('utf8');
    appendTunnelLog(text);
    if (discovered) return;
    const url = extractTunnelUrl(text);
    if (url) {
      discovered = true;
      clearTimeout(discoveryTimer);
      discoveryTimer = null;
      publishUrl(url);
      consecutiveFailures = 0;
    }
  }

  child.stdout.on('data', consume);
  child.stderr.on('data', consume);

  child.on('error', (err) => {
    log('ERROR', 'spawn failed: ' + (err && err.message) + ' (is cloudflared installed?)');
  });

  child.on('exit', (code, signal) => {
    if (discoveryTimer) { clearTimeout(discoveryTimer); discoveryTimer = null; }
    child = null;
    clearUrl();
    if (shuttingDown) {
      log('INFO', 'tunnel exited during shutdown (code=' + code + ' signal=' + signal + ')');
      return;
    }
    log('WARN', 'tunnel exited (code=' + code + ' signal=' + signal + ') — restarting in ' + RESTART_BACKOFF_MS + 'ms');
    scheduleRestart();
  });
}

function stopTunnel(reason) {
  log('WARN', 'stopping tunnel: ' + reason);
  clearUrl();
  if (!child) return;
  try {
    child.removeAllListeners('exit');
    child.kill('SIGTERM');
    const doomed = child;
    setTimeout(() => {
      try { if (doomed && !doomed.killed) doomed.kill('SIGKILL'); } catch (_) {}
    }, 8000).unref();
  } catch (_) {}
  child = null;
}

function scheduleRestart() {
  if (shuttingDown || restartTimer) return;
  restartTimer = setTimeout(() => {
    restartTimer = null;
    if (!shuttingDown) startTunnel();
  }, RESTART_BACKOFF_MS);
}

// ---------------------------------------------------------------------------
// Health checking — proves the PUBLIC url reaches the LOCAL app
// ---------------------------------------------------------------------------

function probeOnce(url) {
  return new Promise((resolve) => {
    let settled = false;
    const done = (ok, detail) => {
      if (settled) return;
      settled = true;
      resolve({ ok, detail });
    };

    let target;
    try {
      target = new URL(HEALTH_PATH, url);
    } catch (_) {
      return done(false, 'bad_url');
    }

    const req = https.get(target, { timeout: HEALTH_TIMEOUT_MS }, (res) => {
      const code = res.statusCode;
      // Drain so the socket can be reused/closed.
      res.resume();
      // 2xx and 3xx both prove the tunnel reached the app (a short path like
      // /chart legitimately answers 302). 4xx from the APP is also proof the
      // tunnel works, so only 5xx and edge errors count as tunnel failures.
      if (code >= 200 && code < 500) return done(true, 'http_' + code);
      done(false, 'http_' + code);
    });

    req.on('timeout', () => { try { req.destroy(); } catch (_) {} done(false, 'timeout'); });
    req.on('error', (err) => done(false, 'error:' + (err && err.code ? err.code : (err && err.message))));
  });
}

function startHealthLoop() {
  if (healthTimer) clearInterval(healthTimer);
  healthTimer = setInterval(async () => {
    if (shuttingDown) return;
    if (!currentUrl) {
      log('WARN', 'health check skipped: no published url yet');
      return;
    }
    const url = currentUrl;
    const result = await probeOnce(url);
    if (result.ok) {
      if (consecutiveFailures > 0) log('INFO', 'health recovered: ' + result.detail);
      consecutiveFailures = 0;
      return;
    }
    consecutiveFailures++;
    log('WARN', 'health check failed (' + consecutiveFailures + '/' + HEALTH_FAILURE_THRESHOLD + '): ' + result.detail + ' url=' + url);
    if (consecutiveFailures >= HEALTH_FAILURE_THRESHOLD) {
      consecutiveFailures = 0;
      stopTunnel('health_check_failed:' + result.detail);
      scheduleRestart();
    }
  }, HEALTH_INTERVAL_MS);
  healthTimer.unref();
}

// ---------------------------------------------------------------------------
// Shutdown
// ---------------------------------------------------------------------------

function shutdown(signal) {
  if (shuttingDown) return;
  shuttingDown = true;
  log('INFO', 'received ' + signal + ' — shutting down');
  if (healthTimer) { clearInterval(healthTimer); healthTimer = null; }
  if (restartTimer) { clearTimeout(restartTimer); restartTimer = null; }
  clearUrl();
  if (child) {
    try { child.kill('SIGTERM'); } catch (_) {}
  }
  setTimeout(() => process.exit(0), 3000).unref();
}

function main() {
  ensureDirs();
  try { fs.writeFileSync(PID_FILE, String(process.pid) + '\n'); } catch (_) {}

  log('INFO', VERSION + ' starting (target=' + TARGET_URL + ', url_file=' + URL_FILE + ')');

  process.on('SIGTERM', () => shutdown('SIGTERM'));
  process.on('SIGINT', () => shutdown('SIGINT'));
  process.on('uncaughtException', (err) => {
    log('ERROR', 'uncaughtException: ' + (err && err.stack ? err.stack : err));
  });
  process.on('unhandledRejection', (err) => {
    log('ERROR', 'unhandledRejection: ' + (err && err.stack ? err.stack : err));
  });

  startTunnel();
  startHealthLoop();
}

if (require.main === module) {
  main();
}

module.exports = {
  VERSION,
  extractTunnelUrl,
  probeOnce,
  URL_FILE,
  TARGET_URL,
  HEALTH_PATH
};
