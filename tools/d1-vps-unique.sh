#!/bin/bash
echo __UNIQUE_LOG__
git -C /home/ubuntu/auto-cuan log --oneline origin/feat/daytrade-screener-v1..HEAD | head -n 20
echo __UNIQUE_COUNT__
git -C /home/ubuntu/auto-cuan rev-list --count origin/feat/daytrade-screener-v1..HEAD
echo __BUNDLE_UNIQUE__
git -C /home/ubuntu/auto-cuan bundle create /tmp/vps-unique.bundle origin/feat/daytrade-screener-v1..HEAD 2>&1 | head -n 20
ls -lh /tmp/vps-unique.bundle
echo __SHOW_494__
git -C /home/ubuntu/auto-cuan show --stat --oneline 494c164fe8308fa649dd536b80e3f241fc95aa80 2>&1 | head -n 40
