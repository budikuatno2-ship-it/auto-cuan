# Aligned Day Trade collection workflow

A finalized B0.3 initial record normally uses the calculation-completion timestamp. That timestamp can contain arbitrary seconds or milliseconds, while direct intraday OHLC providers expose fixed interval boundaries. A bar that begins before the initial timestamp contains pre-initial price movement and cannot prove post-initial entry or touch ordering.

For B0.5 collection, both boundaries must therefore be exact multiples of the selected provider interval:

- the initial record `observed_at`;
- the requested `horizon_end`.

The production-facing B0.5 CLI uses `daytrade-outcome-collector-guard`, which rejects an unaligned initial record or horizon before provider access or outcome creation. It never clips a provider bar, manufactures a partial bar, or treats pre-initial OHLC movement as post-initial evidence.

Create future B0.3 initial evidence with the manual aligned wrapper:

```text
node tools/run-daytrade-aligned-evaluation-canary.js \
  --execute \
  --market-day-confirmed \
  --activation-interval-ms 60000 \
  --sample-slot OPENING \
  --evaluation-root <external-root> \
  --tickers BBCA:UTAMA
```

After calculation completes, the wrapper waits until the next strict interval boundary and uses that exact boundary as `observed_at`. It refuses activation if waiting would cross the Jakarta market date or change the engine run mode. The wrapper remains manual-only and is not connected to cron, systemd, GitHub Actions, production APIs, databases, Telegram, Fast Watcher, Top 5, Swing, or publication code.

The later B0.5 outcome invocation must use the same interval and an aligned horizon end inside one caller-confirmed continuous trading segment. Missing, sparse, truncated, gapped, or interval-mismatched provider evidence remains `UNRESOLVED` under the B0.4 contract.
