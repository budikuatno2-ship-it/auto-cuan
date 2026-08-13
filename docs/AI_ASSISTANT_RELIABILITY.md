# AI assistant reliability — Portfolio AI and Stock Analysis AI

Both user-facing AI surfaces share one request path:

```
browser
  public/portfolio-ai-runtime-v2.js   (source: portfolio_chat)
  public/stock-analysis-ai.js         (source: stock_analysis_followup)
    → POST /api/analyze
      → api/analyze.js               hydrate + ground the context, attach styleRules
        → lib/ai-context-snapshot-store.js   sanitise, persist/restore the snapshot
        → lib/ai-runtime-grounding-v2.js     derive calculation/affordability facts
      → lib/context-ai-router-v6.js  deterministic local fallback for stock follow-ups
        → lib/context-ai-router-v5.js  model-pool ordering from env
          → lib/context-ai-router-v4.js  auth, rate limit, cache, failover, provider call
```

`vercel.json` gives `api/analyze.js` a hard `maxDuration` of 60s. Everything
below is sized to finish inside that.

## Failure handling contract

| Situation | HTTP | `code` | What the user sees |
| --- | --- | --- | --- |
| A model answers | 200 | — | The model's answer |
| Primary model times out / 5xx / 429 / 4xx, a backup answers | 200 | — | The backup's answer |
| Provider rejects an optional parameter | 200 | — | Same model retried once without `max_tokens`/`temperature` |
| Every model fails | 503 | `AI_MODELS_FAILED_SAFE_STOP` | Labelled local summary (portfolio) / labelled snapshot summary (stock) |
| Every model times out | 503 | `AI_ALL_MODELS_TIMED_OUT` | Same, with a timeout wording |
| Same question repeated automatically within the negative-cache window | 503 | `AI_RECENT_FAILURE` | Labelled local summary; no provider spend |
| User presses **Coba lagi** | — | — | Bypasses the negative cache and calls the provider again |
| Invalid key / no balance / model access denied | 503 | `AI_KEY_OR_BALANCE_ERROR` | "Akses ke penyedia AI bermasalah di sisi server" |
| `PORTFOLIO_AI_API_KEY` unset | 503 | `AI_NOT_CONFIGURED` | "Hubungi admin" — no fallback |
| Session expired / account blocked / not approved | 401/403 | `AI_ACCESS_DENIED` | "Login lagi" / the account reason — no fallback |
| Per-user quota exhausted | 429 | `AI_RATE_LIMITED` | "Coba lagi sekitar N detik lagi" — no fallback |
| Stock follow-up with no rendered analysis | 400 | `AI_STOCK_SNAPSHOT_MISSING` | "Jalankan analisis tickernya dulu" |

Only a genuine provider or transport failure produces a local summary, and the
summary is always badged **"Ringkasan lokal — bukan jawaban AI"**. An actionable
failure is reported as itself; dressing it up as an outage hides the fix.

## Failover rules

- **Terminal**: only 401 / 402 / 403. Those are identical for every model behind
  the same API key, so trying more of them only wastes the budget.
- **Retriable**: everything else, including timeouts. A timeout is a property of
  one model on one call, not proof the pool is dead.
- **Bounded**: at most `attemptLimit()` models (default 3, floor 2, ceiling 6),
  plus at most one compatibility retry for the whole request.
- **Budget**: while backups remain, an attempt gets at most half the remaining
  time; the last attempt may use the remainder. The clock starts at the top of
  the handler, so auth, Supabase reads and the `/models` probe count against it.

## Environment variables

| Variable | Default | Bounds | Purpose |
| --- | --- | --- | --- |
| `PORTFOLIO_AI_API_KEY` | — | required | Provider key. Unset ⇒ `AI_NOT_CONFIGURED`. |
| `PORTFOLIO_AI_BASE_URL` | `https://weizerouter.web.id/v1` | — | OpenAI-compatible base URL. |
| `PORTFOLIO_AI_MODEL_TIMEOUT_MS` | 20000 | 1000–40000 | Ceiling for one attempt. |
| `PORTFOLIO_AI_TOTAL_TIMEOUT_MS` | 42000 | 10000–50000 | Whole-request budget, must stay under the 60s platform cap. |
| `PORTFOLIO_AI_MAX_ATTEMPTS` | catalog size | 2–catalog | Global attempt ceiling. |
| `PORTFOLIO_AI_HEAVY_MAX_ATTEMPTS` | 3 | 2–6 | Portfolio analysis attempts. |
| `PORTFOLIO_AI_EMPATHY_MAX_ATTEMPTS` | 3 | 2–6 | Portfolio empathy attempts. |
| `PORTFOLIO_AI_FAST_MAX_ATTEMPTS` | 3 | 2–6 | Portfolio short-answer attempts. |
| `STOCK_ANALYSIS_AI_MAX_ATTEMPTS` | 3 | 2–6 | Stock follow-up attempts. |
| `PORTFOLIO_AI_HEAVY_MODELS` / `_EMPATHY_MODELS` / `_FAST_MODELS` / `PORTFOLIO_AI_MODELS` | see v5 | — | Comma-separated pools, reordered by `context-ai-router-v5.js`. |
| `STOCK_ANALYSIS_AI_MODELS` | see v5 | — | Stock follow-up pool. |
| `PORTFOLIO_AI_CACHE_TTL_MS` | 600000 | 30000–3600000 | Positive response cache. |
| `PORTFOLIO_AI_FAILURE_CACHE_MS` | 30000 | 10000–300000 | Negative cache; bypassed by an explicit user retry. |
| `PORTFOLIO_AI_STALE_PRICE_MINUTES` | 30 | 5–1440 | Above this age a stored price is reported to the model as stale. |
| `STOCK_ANALYSIS_CONTEXT_CHARS` | 5000 | 2500–8000 | Snapshot budget before the middle is compacted. |

Raising `PORTFOLIO_AI_TOTAL_TIMEOUT_MS` towards 50000 leaves little headroom for
auth and hydration; do not raise it without also raising `maxDuration`.

## Data honesty

**Portfolio.** The model receives `price_freshness`, listing per position whether
a stored price exists, when it was captured, its age in minutes, and whether
`/api/quote` itself flagged it stale — plus the ticker lists for missing,
unknown-age and stale prices. The prompt binds the model to it: an unavailable or
stale price must be stated as such and must not be used to compute P/L. Prices are
stored readings, never claimed as real-time. Derived numbers come from
`calculation_facts` / `affordability_facts`, which are computed deterministically
upstream and carried through unchanged; anything dropped for size is named in
`omitted_for_size` rather than silently disappearing.

A missing number stays missing. `null`, `''`, whitespace, booleans, `[]` and
non-numeric strings all become `null`; a genuine `0` survives as `0`. Totals that
exclude missing values carry the count of what was excluded, so a partial sum is
never presented as a complete one.

**Stock analysis.** Setup-state markers are extracted from the snapshot *before*
`compactAnalysisText()` can truncate them away, and travel as `setup_states` plus
a binding `setup_state_policy`. `WATCHING`, `RADAR`, `EARLY_RADAR`, `EARLY_WATCH`,
`WAIT_PULLBACK`, `READY_PENDING`, `BLOCKED_CHASE`, `INVALIDATED`, `EXPIRED` and
`STALE` are all reported as *not confirmed*; only `READY_CONFIRMED` may be
described as meeting the confirmation contract, and only when the snapshot says
so. No screener rule, threshold, score or confirmation contract is evaluated
here — this layer only reads what the page already rendered.

## Regression coverage

- `test/ai-provider-failover.test.js` — end-to-end through `api/analyze.js`:
  failover, compatibility retry, retry semantics, auth, quota, grounding,
  freshness, setup states, budget arithmetic.
- `test/ai-ui-failure-states.test.js` — what each surface shows per failure class,
  deterministic local summaries, send lock / clear / retry wiring, render safety.
- `test/ai-context-fixtures-stress.test.js` — portfolio and stock fixtures
  (0/1/3/22 positions, missing and stale prices, large nominals, partial data,
  every setup state) asserting nothing is invented and no state is upgraded.

All three run in `npm run build` and in the web-hardening CI job.
