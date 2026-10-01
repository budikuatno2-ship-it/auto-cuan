# Screener schedule audit

Audited 2026-07-16. This document records repository configuration only; no
production job was invoked and no schedule was changed.

| Workflow | Command / endpoint | Schedule time | Target | Log path | Telegram behavior |
| --- | --- | --- | --- | --- | --- |
| Swing Konglo | `GET /api/sector-hot?action=refresh-screener` (cron-secret protected) | No Vercel cron or VPS crontab entry is versioned in this repository. Run manually/orchestrator-managed. | Vercel serverless endpoint when invoked. | No repository-managed persistent log path; outcome is stored in screener meta/database. | The refresh itself does not send a Telegram message. The separate Swing Konglo notification flow only sends approved, safety-gated final candidates; its no-saved-rows heartbeat is explicitly controlled in application code. |
| Swing Non-Konglo | `GET /api/sector-hot?action=nk-screener-run` (protected orchestration endpoint) | No Vercel cron or VPS crontab entry is versioned in this repository. Run manually/orchestrator-managed. | Vercel serverless endpoint when invoked. | No repository-managed persistent log path; job/staging/meta records provide status. | The separate final-notification flow sends only safety-gated candidates; it remains silent when there are no candidates. |
| Top 5 | `GET /api/sector-hot?action=telegram-daily-picks` | `0 1 * * 1-5` in `vercel.json` (01:00 UTC, 08:00 WIB, weekdays). | Vercel Cron / Vercel serverless endpoint. | Vercel function logs; locked picks are persisted in `telegram_daily_picks`. The optional local audit tool is `node tools/run-after-market-top5-lock.js` and defaults to dry-run. | Sends only from the scheduled protected flow. Dashboard reads locked rows only and never sends Telegram. |

The only documented VPS scheduler is the **Day Trade observe-only** worker in
`docs/DAYTRADE_VPS_OBSERVE_WORKER.md`; it is not a Swing or Top 5 producer and
is not a replacement for the Vercel Top 5 cron. No cron frequency changes are
included in this change.
