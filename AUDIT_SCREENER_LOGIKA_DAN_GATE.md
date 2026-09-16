# Audit Screener — Logika, Formula, Gate, Pipa Data

Tanggal: 2026-09-15  
Mode: read-only source audit. Tidak ada source aplikasi yang diubah.

## Day Trade

Sumber: [`lib/daytrade-screener-engine.js`](lib/daytrade-screener-engine.js:255-267).

Rumus asli:

```text
value_today = last_price × volume_today
avg_volume_20d = calcMA(volumes, 20)
volume_ratio_20d = volume_today / avg_volume_20d
avg_value_7d = Σ(close_i × volume_i) / 7
```

Kode asli volume:

```js
var volume_today = Number(last.volume) || 0;
var value_today = round0(last_price * volume_today);
var vol20 = calcMA(volumes, 20);
var avg_volume_20d = (vol20 && Number.isFinite(vol20) && vol20 > 0) ? round0(vol20) : null;
var volume_ratio_20d = (avg_volume_20d != null && avg_volume_20d > 0 && Number.isFinite(volume_today / avg_volume_20d)) ? round2(volume_today / avg_volume_20d) : null;
```

Liquidity source [`scoreLiquidity()`](lib/daytrade-screener-engine.js:364-392): `MIN_VALUE_TODAY=1000000000`; `MIN_AVG_VALUE_7D=500000000`; drop bila `valToday < MIN_VALUE_TODAY && avgVal7d < MIN_AVG_VALUE_7D`; drop bila `volume_ratio_20d < 0.3`.

Pre-spike source [`scorePreSpike()`](lib/daytrade-screener-engine.js:421-440): change `0.5..3.0=+8`; `3.0..4.5=+7`; `4.5..7.0=+4`; `>7=+1`; RVOL `>=2.5=+7`; `>=2.0=+6`; `>=1.5=+5`; `>=1.2=+4`; `>=1.0=+3`.

Momentum source [`scoreMomentum()`](lib/daytrade-screener-engine.js:470-501): RSI `50..65=+7`; `45..50=+6`; `40..45=+5`; `65..72=+5`; `72..80=+2`; `30..40=+3`; above MA20 `+5`, within 2% below `+3`; above MA50 `+4`, within 3% below `+2`.

RR source [`scoreRiskReward()`](lib/daytrade-screener-engine.js:508-520): RR `>=3=+15`; `>=2.5=+13`; `>=2=+11`; `>=1.5=+8`; `>=1.2=+5`; `>=1=+2`; otherwise `0`.

Level formula source [`calculateLevels()`](lib/daytrade-screener-engine.js:643-762): `atrProxy=atr||(high-low)||(last×0.02)`; `risk=entryMid-stop_loss`; `reward=tp1-entryMid`; `RR=reward/risk`; SL distance guard `0.5×ATR..2.5×ATR`; final Day Trade SL distance cap 5%.

Order-flow source [`scoreOrderFlowVelocity()`](lib/daytrade-screener-engine.js:2952-2963): delta source priority `delta_turnover_15m`, `turnover_15m`, `delta_turnover`, `delta_turnover_5m`; bid source priority `bid_dominance`, `bid_ratio`, `orderbook_dominance`; values `>1..100` divide by 100; delta `>=1000000000` returns `15`; bid dominance `>0.58` returns `10`.

Composite source [`calculateDayTradeScore()`](lib/daytrade-screener-engine.js:2965-3001): `total=BASE_SCORE+volSurge+orderFlow+tech`; `BASE_SCORE=25`; tradeable threshold `65`; when RVOL `<1` or volume score `0`, total `>=65` is forced to `64`.

Session source [`lib/daytrade-screener-engine.js`](lib/daytrade-screener-engine.js:125-146): Mon-Thu `09:00-12:00` and `13:30-16:00`; Friday `09:00-11:30` and `14:00-16:00`; break/closed blocks signal computation.

## Swing

Source [`lib/swing-screener-engine.js`](lib/swing-screener-engine.js:24-26): `RR>=1.8`; score `>=75`; volume threshold `1.0`.

```js
const MIN_SWING_HIGH_CONVICTION_RR = 1.8;
const MIN_SWING_HIGH_CONVICTION_SCORE = 75;
const MIN_SWING_HIGH_CONVICTION_VOLUME = 1.0;
```

Source [`applySwingScoringPenalties()`](lib/swing-screener-engine.js:115-160): 5D bearish `-25`; red 1D `-15`; volume `<1.0` caps score at `70`; score `>=90` requires non-bearish 5D, non-red 1D, volume `>=1.2`, RR `>=1.8`.

Source [`verifySwingHighConviction()`](lib/swing-screener-engine.js:227-267): WAIT_PULLBACK is rejected; RR `<1.8` is rejected; corrected score `<75` is rejected.

No separate `swing-konglo-engine.js` or `swing-nonkonglo-engine.js` exists in `lib/`; a separate Konglo/Non-Konglo formula is not proven by the file inventory.

## Bandarmologi

Source [`calculateBandarmologiScore()`](lib/bandarmologi-screener-scoring.js:97-117):

```js
const sortedBuyers = validBrokers.slice().sort((a, b) => b.bval - a.bval);
const cr3Buy = sortedBuyers.slice(0, 3).reduce((sum, b) => sum + b.bval, 0);
const cr5Buy = sortedBuyers.slice(0, 5).reduce((sum, b) => sum + b.bval, 0);
const cr3 = totalBuyVal > 0 ? (cr3Buy / totalBuyVal) : 0;
const cr5 = totalBuyVal > 0 ? (cr5Buy / totalBuyVal) : 0;
if (cr3 > 0.60 && netFlow > 0) score += 25;
else if (cr5 > 0.70 && netFlow > 0) score += 15;
else if (cr3 > 0.50 && netFlow > 0) score += 10;
```

Formula: `CR3=Top3BuyValue/TotalBuyValue`; `CR5=Top5BuyValue/TotalBuyValue`; Top 1 is `sortedBuyers[0].bval`. There is no separate Top-1 score branch in this function.

Institutional/retail:

```js
const instRatio = totalInstRetailBuy > 0 ? (instBuyVal / totalInstRetailBuy) : (instBuyVal > 0 ? 1 : 0);
const retailNet = retailBuyVal - retailSellVal;
const instNet = instBuyVal - instSellVal;
if (instRatio >= 0.70 && instBuyVal > 0) score += 20;
else if (instRatio >= 0.50 && instBuyVal > 0) score += 10;
if (retailNet < 0 && (instNet > 0 || netFlow > 0)) score += 15;
```

Source: [`lib/bandarmologi-screener-scoring.js`](lib/bandarmologi-screener-scoring.js:120-142).

## Intelligence filters

Source [`detectPriceBelowBandarCost()`](lib/bandarmologi-intel-service.js:536-758): `avgBuyTop3 = totalBuyVal / totalBuyVol` normalized VWAP; `discountPct=((avgBuyTop3-currentPrice)/avgBuyTop3)*100`; trigger `discountPct>=1.0`; sweet spot `0<discountPct<=5.0`.

Source [`detectSilentForeignAccumulation()`](lib/bandarmologi-intel-service.js:771-984): foreign codes only; daily net uses `net_val` or `(buy_value-sell_value)`; positive daily flow is accumulated; price fluctuation must remain sideways; insufficient dates returns `triggered:false`.

Source [`detectRetailCutlossVsBandar()`](lib/bandarmologi-intel-service.js:1039-1042):

```js
const isBandarNampung = instBuyerCount >= 2 && retailSellerCount >= 2;
const isDistribusiKeRitel = retailBuyerCount >= 2 && instSellerCount >= 2;
```

## Pipa data real vs dummy

Pass-through broker cache:

```js
let brokerData = candidate.broker_summary || candidate._brokerData;
if (!brokerData && bandarmologiService && typeof bandarmologiService.readDiskCache === 'function') {
  brokerData = bandarmologiService.readDiskCache('broker-summary', ticker, 'latest');
}
const scoringResult = calculateBandarmologiScore(brokerData, {
  mode: options.mode || 'swing',
  insiderRoster: insiderRoster,
  volumeRatio20d: candidate.volume_ratio_avg20 || candidate.volume_ratio_20d || 0,
  multiDayNetPositive: Boolean(candidate.bandar_3d > 0 && candidate.bandar_5d > 0)
});
```

Source: [`enrichCandidateWithBandarmologi()`](lib/bandarmologi-screener-scoring.js:238-263).

Intel cache path:

```js
const raw = bandarmologiService.readDiskCache('broker-summary', ticker, d);
const norm = bandarmologiService.normalizeBrokerSummary(raw, d, ticker);
```

Source: [`detectSilentForeignAccumulation()`](lib/bandarmologi-intel-service.js:823-828).

Day Trade candle handoff:

```js
var candles = await fetchCandles(item.ticker, item);
var candleResult = candleEngine.detectPattern(candles.slice(-3), candleCtx);
var scored = scoreDayTrade(analysis, runMode, item.board, candleResult, options);
```

Source: [`runDayTradeBatch()`](lib/daytrade-screener-engine.js:1788-1828).

Fallback evidence: broker scoring has zero/empty-data defaults; intel safe wrapper returns `has_data:false`; this is a defensive fallback, not evidence of a real mock dataset. No hardcoded production ticker fixture was found in the inspected path.

## Candle architecture

Source [`detectPattern()`](lib/candle-pattern-engine.js:28-55): receives OHLCV array, but evaluates only the latest three candles; computes `volRatio=c0.volume/ctx.volumeAvg20`; then tries three-candle, two-candle, continuation, and single-candle patterns.

```js
var c0 = candles[len - 1];
var c1 = len >= 2 ? candles[len - 2] : null;
var c2 = len >= 3 ? candles[len - 3] : null;
var volRatio = (volAvg && volAvg > 0 && c0.volume > 0) ? c0.volume / volAvg : null;
if (c2 && c1) pat = detectThreeCandle(c2, c1, c0);
if (!pat && c1) pat = detectTwoCandle(c1, c0);
if (!pat && c1) pat = detectContinuation(c1, c0, ctx, volRatio);
if (!pat) pat = detectSingle(c0, ctx, c1);
```

Confirmation source [`calcConfirmation()`](lib/candle-pattern-engine.js:295-312): bullish breakout requires `Strong breakout candle`, or `Bullish Marubozu` with volume ratio `>=1.2`; rebound patterns require proximity to support/MA20; Three White Soldiers requires volume.

Important negative finding: `candle-pattern-engine.js` contains no Higher High/Higher Low detector, no EMA calculation, and no 120-candle swing-direction classifier. Those must be supplied by another upstream module if present; they are not implemented in this file.

## Gates not proven in inspected snippets

- Exact price spread gate: not found in the inspected Day Trade engine blocks.
- Exact tick-size table: delegated to `idxTick.normalizeLevelsToIdxTicks()` at [`scoreDayTrade()`](lib/daytrade-screener-engine.js:1179), table not reproduced here.
- Exact Telegram eligibility gate: alert cooldown exists in [`checkCooldown()`](lib/webhook-alert-engine.js:137), but publication caller and all channel-specific gates require separate full caller trace.
- Exact Konglo vs Non-Konglo scoring difference: no separate engine filenames exist under `lib/`; not proven by current file inventory.
