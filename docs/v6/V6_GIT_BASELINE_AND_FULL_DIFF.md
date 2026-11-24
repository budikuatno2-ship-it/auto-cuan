# V6 Git Baseline & Full Diff (Subtask M FINAL)

**Run ID:** RUN_20261112_193306_WIB
**Generated:** 2026-11-12 19:33:06 WIB (ISO 2026-11-12T12:33:06.218Z)
**Branch:** feat/v6-recovery
**Baseline SHA:** ae5d18924955217c7e74d1d7909b3ef12f471d00
**HEAD SHA:** ae5d18924955217c7e74d1d7909b3ef12f471d00

## Tracked-modified files (vs baseline)

Count: 48

```
api/admin-logs.js
api/admin-users.js
api/admin/quota-status.js
api/chart.js
api/sector-hot.js
api/struktur-pasar.js
api/top5-radar.js
api/track-record.js
data/market-structure-manual-overrides.json
data/screener-v3f04-daytrade.json
data/screener-v3f04-konglo.json
data/screener-v3f04-nonkonglo.json
deploy/vps/run-ihsg-candle.sh
docs/evidence/fase-6/TICKER_962_AUDIT.json
lib/admin-console-service.js
lib/broker-accumulation-local.js
lib/broker-hunter-service.js
lib/chart-engine/candle-fetcher.js
lib/daily-history-sqlite-sync.js
lib/daily-pbv.js
lib/local-market-subset-store.js
lib/quota-manager.js
lib/quota-state.js
lib/telegram-interactive-bot.js
public/admin-console-runtime.js
public/admin-console.html
public/admin-tools-runtime.js
public/analisis-saham-runtime.js
public/analisis-saham.html
public/analisis-v2.js
public/bandarmologi-runtime.js
public/chart-workstation.js
public/index.html
public/market-feature-runtime.js
public/portfolio-command-center.js
public/v4-f08-runtime.js
routes/admin.js
scripts/domestic-compile.js
scripts/fetch-yahoo-eod.js
scripts/run-screeners.js
scripts/top5-radar.js
test/redesign-v2-analisis-plan.test.js
tools/curated-build-tests.json
tools/fetch-daily-candles.js
tools/fetch-ihsg-candle.js
tools/local-dev-server.js
tools/run-daily-broker-update.js
tools/run-lifecycle-evaluator.js
```

## Untracked items (source snapshot captured separately)

Count: 1771. Full inventory in `V6_UNTRACKED_SOURCE_MANIFEST.csv`.

## Full diff stat

```
 api/admin-logs.js                           |  53 ++-
 api/admin-users.js                          | 136 ++++--
 api/admin/quota-status.js                   |  23 +-
 api/chart.js                                | 250 +++++++---
 api/sector-hot.js                           | 182 +++++++-
 api/struktur-pasar.js                       | 225 ++++++++-
 api/top5-radar.js                           | 101 +++-
 api/track-record.js                         |  30 +-
 data/market-structure-manual-overrides.json |   2 +-
 data/screener-v3f04-daytrade.json           | 312 +++++++------
 data/screener-v3f04-konglo.json             | 130 +++---
 data/screener-v3f04-nonkonglo.json          | 159 +------
 deploy/vps/run-ihsg-candle.sh               |   3 +-
 docs/evidence/fase-6/TICKER_962_AUDIT.json  | 548 +++++++++++-----------
 lib/admin-console-service.js                |  51 +-
 lib/broker-accumulation-local.js            |  90 +++-
 lib/broker-hunter-service.js                |  50 +-
 lib/chart-engine/candle-fetcher.js          |  19 +-
 lib/daily-history-sqlite-sync.js            | 180 +++++--
 lib/daily-pbv.js                            |   9 +
 lib/local-market-subset-store.js            |  44 +-
 lib/quota-manager.js                        | 347 +++++++++-----
 lib/quota-state.js                          |  36 +-
 lib/telegram-interactive-bot.js             |  35 +-
 public/admin-console-runtime.js             | 324 +++++++++++--
 public/admin-console.html                   |  30 +-
 public/admin-tools-runtime.js               |  18 +
 public/analisis-saham-runtime.js            | 192 ++++++--
 public/analisis-saham.html                  |  38 +-
 public/analisis-v2.js                       | 206 ++++++++-
 public/bandarmologi-runtime.js              |   9 +-
 public/chart-workstation.js                 |  16 +-
 public/index.html                           | 236 +++++++---
 public/market-feature-runtime.js            |  78 +++-
 public/portfolio-command-center.js          |   4 +-
 public/v4-f08-runtime.js                    |  51 +-
 routes/admin.js                             |  44 +-
 scripts/domestic-compile.js                 | 131 +++++-
 scripts/fetch-yahoo-eod.js                  |  37 +-
 scripts/run-screeners.js                    | 119 ++++-
 scripts/top5-radar.js                       | 695 +++++++++++++++-------------
 test/redesign-v2-analisis-plan.test.js      |  12 +-
 tools/curated-build-tests.json              |   5 +-
 tools/fetch-daily-candles.js                | 142 ++++--
 tools/fetch-ihsg-candle.js                  |  24 +-
 tools/local-dev-server.js                   |  21 +-
 tools/run-daily-broker-update.js            |  35 +-
 tools/run-lifecycle-evaluator.js            | 126 +++--
 48 files changed, 3871 insertions(+), 1737 deletions(-)

```

The complete unified diff is packaged as `v6-full.patch` (tracked changes)
plus `src/` (sanitized source snapshot of changed and untracked source files).
