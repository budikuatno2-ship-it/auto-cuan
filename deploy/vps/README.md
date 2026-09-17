# VPS Deploy Runbook (PM2) — Auto-Cuan

Batch 18 — full VPS deploy with PM2. This replaces the manual `nohup`/background
processes that caused **Akar Masalah #1 (kode basi di RAM VPS)**: with PM2,
`git pull` + `pm2 reload` guarantees the code in RAM matches the code on disk.

## Assets

| File | Purpose |
|---|---|
| [`ecosystem.config.js`](../../ecosystem.config.js) | PM2 app definitions (`auto-cuan-vps-api`, `auto-cuan-ai-eval-supervisor`) — Batch 12 |
| [`tools/atomic-deploy.js`](../../tools/atomic-deploy.js) | Pull + test gate + zero-downtime reload — Batch 13 |
| [`tools/vps-deploy-preflight.js`](../../tools/vps-deploy-preflight.js) | Deploy preflight (PM2 present, Node version, ecosystem integrity) — Batch 18 |
| [`deploy/systemd/auto-cuan-ai-eval-once.service`](../systemd/auto-cuan-ai-eval-once.service) | Reference systemd unit (not the live process) |
| [`deploy/vps/final-schedule.cron`](final-schedule.cron) | EOD/nightly cron jobs (no intraday broadcast) |

## Prerequisites

- Node `22.x` (see `package.json` `engines.node`).
- PM2 installed globally: `npm i -g pm2`
- Repo checked out at `/home/ubuntu/auto-cuan` with branches available.

## Deploy sequence

```bash
cd /home/ubuntu/auto-cuan

# 1. Preflight — fail fast if the bundle is not deployable.
npm run validate:syntax          # parse-check every .js file
node tools/vps-deploy-preflight.js

# 2. First-time start (creates the PM2 apps).
pm2 start ecosystem.config.js

# 3. Persist across reboots.
pm2 save
pm2 startup                      # follow the printed command once

# 4. Subsequent deploys — atomic: pull + test gate + zero-downtime reload.
npm run deploy:atomic
```

## Verify

```bash
pm2 list                         # both apps should be `online`
pm2 logs --lines 100             # check for startup errors
curl -s localhost:3001/api/...   # vps-api bridge responding
```

## Rollback

`atomic-deploy.js` auto-rolls back (`git reset --hard PREV_SHA`) if the test gate
fails, and never reloads a failing revision. To manually revert:

```bash
git reset --hard <previous-sha>
pm2 reload ecosystem.config.js --update-env
```

## Guardrails

- **Test gate before reload:** a revision whose tests fail is never reloaded into
  RAM (`deriveDeployDecision` → `rollback`, no reload).
- **Up-to-date = no-op:** a revision already matching the remote does not trigger
  a needless restart.
- **Market hours:** intraday Telegram broadcasts are blocked outside IDX sessions
  by `lib/market-hours-guard.js` (Batches 2–4); this runbook's cron only covers
  EOD/nightly jobs.
