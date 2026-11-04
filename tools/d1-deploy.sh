#!/bin/bash
# D1 deploy VPS: backup crontab, fetch/checkout/pull-ff-only, crontab baru, pm2 reload+save.
# Tanpa print secret. Gagal di langkah mana pun -> exit non-zero (fail-closed).
set -e
REPO=/home/ubuntu/auto-cuan
TS=$(date +%Y%m%d-%H%M%S)
echo __BACKUP_CRONTAB__
crontab -l > /home/ubuntu/auto-cuan-runner/crontab-backup-D1-$TS.txt 2>/dev/null || echo BACKUP_EMPTY
ls -lh /home/ubuntu/auto-cuan-runner/crontab-backup-D1-$TS.txt
echo __FETCH__
git -C $REPO fetch origin --prune
echo __CHECKOUT__
git -C $REPO checkout feat/daytrade-screener-v1
echo __PULL_FF__
git -C $REPO pull --ff-only origin feat/daytrade-screener-v1
echo __HEAD_AFTER__
git -C $REPO rev-parse HEAD
git -C $REPO branch --show-current
echo __INSTALL_CRONTAB__
crontab $REPO/deploy/vps/final-schedule.cron
echo __CRONTAB_COUNT__
crontab -l | grep -v '^#' | grep -v '^[A-Z_]*=' | grep -v '^\s*$' | wc -l
echo __PM2_RELOAD__
pm2 reload all --update-env
echo __PM2_SAVE__
pm2 save
echo __PM2_SUMMARY__
pm2 jlist | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{try{const j=JSON.parse(s);for(const p of j){console.log(p.name+'|'+(p.pm2_env&&p.pm2_env.status))}}catch(e){console.log('PM2PARSE_ERR:'+e.message);process.exit(1)}})"
echo D1_DEPLOY_OK
