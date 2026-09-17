'use strict';

/**
 * PM2 Ecosystem — Auto-Cuan VPS Process Manager (Batch 12)
 *
 * Single source of truth for the two long-lived VPS daemons that previously ran
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

const path = require('path');

const ROOT = __dirname;

module.exports = {
  apps: [
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
      // Matches systemd TimeoutStopSec=45: give the supervisor time to SIGTERM
      // its child worker before PM2 force-kills it.
      kill_timeout: 45000,
      time: true,
      merge_logs: true,
      env: {
        NODE_ENV: 'production',
        TZ: 'Asia/Jakarta',
        AUTO_CUAN_ROOT: ROOT,
        AI_EVAL_ENV_FILE: process.env.AI_EVAL_ENV_FILE || path.join(ROOT, '.env.ai-eval-once')
      }
    }
  ]
};
