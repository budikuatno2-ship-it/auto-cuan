'use strict';

/**
 * PM2 Ecosystem — Auto-Cuan VPS Process Manager (Batch 12 + VPS Migrasi)
 *
 * FASE 2 addition: `autocuan-web-tunnel` keeps a public HTTPS origin alive for
 * the VPS Express app while the Vercel deployment behind autocuan.web.id is
 * paused. See tools/cloudflared-web-supervisor.js.
 *
 * VPS Migrasi (2026-09-26): `autocuan-web` adalah origin utama di 127.0.0.1:3000
 * yang di-reverse-proxy oleh Nginx (80/443) dan dipublish via Cloudflare.
 * Jika .next/standalone/server.js ada (hasil `next build` dengan output:standalone),
 * PM2 menjalankan itu (ringan <100MB). Jika belum ada (migrasi bertahap dari
 * vanilla HTML), fallback ke tools/local-dev-server.js yang sudah melayani
 * public/ + /api/* di 127.0.0.1:3000.
 *
 * Single source of truth for the long-lived VPS daemons that previously ran
 * via bare nohup/background (Akar Masalah #1: stale code in RAM). With PM2,
 * `git pull` + `pm2 reload ecosystem.config.js` restarts the processes so the
 * on-disk code is always the code in memory.
 *
 * Usage on VPS:
 *   pm2 start ecosystem.config.js
 *   pm2 reload ecosystem.config.js --update-env   # zero-downtime restart after deploy
 *   pm2 save && pm2 startup                        # persist across reboots
 *
 * Both scripts auto-start on `require.main === module` and handle SIGTERM/SIGINT,
 * so PM2 can manage them directly without a wrapper.
 */

const fs = require('fs');
const path = require('path');

const ROOT = __dirname;

// VPS Web origin — standalone Next.js atau fallback Express-like server
const WEB_PORT = Number(process.env.PORT || process.env.WEB_PORT || 3000);
const WEB_HOST = process.env.HOSTNAME || process.env.HOST || '127.0.0.1';
const WEB_STANDALONE_ENTRY = path.join(ROOT, '.next', 'standalone', 'server.js');
const WEB_FALLBACK_ENTRY = path.join(ROOT, 'tools', 'local-dev-server.js');
let webScript = WEB_FALLBACK_ENTRY;
try {
  if (fs.existsSync(WEB_STANDALONE_ENTRY)) webScript = WEB_STANDALONE_ENTRY;
} catch (_) {}

module.exports = {
  apps: [
    {
      name: 'autocuan-web',
      script: webScript,
      cwd: ROOT,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      kill_timeout: 10000,
      time: true,
      merge_logs: true,
      max_memory_restart: '100M',
      env: {
        NODE_ENV: 'production',
        TZ: 'Asia/Jakarta',
        AUTO_CUAN_ROOT: ROOT,
        PORT: String(WEB_PORT),
        HOST: WEB_HOST,
        HOSTNAME: WEB_HOST
      }
    },
    {
      name: 'auto-cuan-vps-api',
      script: path.join(ROOT, 'tools', 'vps-api-server.js'),
      cwd: ROOT,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      kill_timeout: 10000,
      time: true,
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
        TZ: 'Asia/Jakarta',
        AUTO_CUAN_ROOT: ROOT
      }
    },
    {
      name: 'auto-cuan-ai-eval-supervisor',
      script: path.join(ROOT, 'tools', 'ai-eval-once-supervisor.js'),
      cwd: ROOT,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 10000,
      kill_timeout: 45000,
      time: true,
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
        TZ: 'Asia/Jakarta',
        AUTO_CUAN_ROOT: ROOT,
        AI_EVAL_ENV_FILE: process.env.AI_EVAL_ENV_FILE || path.join(ROOT, '.env.ai-eval-once')
      }
    },
    {
      name: 'autocuan-bot',
      script: path.join(ROOT, 'tools', 'telegram-interactive-bot.js'),
      cwd: ROOT,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      kill_timeout: 10000,
      time: true,
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
        TZ: 'Asia/Jakarta',
        AUTO_CUAN_ROOT: ROOT,
        BOT_GROUP_ZERO_BYOK: 'true'
      }
    },
    {
      // Public web origin for the VPS Express app (port 3000).
      //
      // Oracle Cloud's VCN security list blocks every inbound port except
      // 22/3001, so the app can never be exposed directly. cloudflared dials
      // OUT from the host instead — no inbound port and no firewall change.
      //
      // The supervisor republishes the (ephemeral) quick-tunnel hostname to
      // /home/ubuntu/auto-cuan-runner/cloudflared-web-url.txt, which
      // lib/public-web-base.js reads so the bots always link to a LIVE origin.
      name: 'autocuan-web-tunnel',
      script: path.join(ROOT, 'tools', 'cloudflared-web-supervisor.js'),
      cwd: ROOT,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 20,
      restart_delay: 5000,
      kill_timeout: 12000,
      time: true,
      merge_logs: true,
      max_memory_restart: '200M',
      env: {
        NODE_ENV: 'production',
        TZ: 'Asia/Jakarta',
        AUTO_CUAN_ROOT: ROOT,
        PUBLIC_WEB_TARGET_URL: 'http://127.0.0.1:3000',
        PUBLIC_WEB_HEALTH_PATH: '/register.html'
      }
    },
    {
      // Verification bot (@AutoCuanVerificationBot) — long polling, NO webhook.
      // Runs the exact same dispatch pipeline the Vercel/VPS webhook used, so the
      // bot no longer depends on Vercel (HTTP 402) or a trycloudflare tunnel.
      name: 'autocuan-verify-bot',
      script: path.join(ROOT, 'tools', 'telegram-verify-bot.js'),
      cwd: ROOT,
      instances: 1,
      exec_mode: 'fork',
      autorestart: true,
      max_restarts: 10,
      restart_delay: 5000,
      kill_timeout: 10000,
      time: true,
      merge_logs: true,
      max_memory_restart: '150M',
      env: {
        NODE_ENV: 'production',
        TZ: 'Asia/Jakarta',
        AUTO_CUAN_ROOT: ROOT
      }
    }
  ]
};
