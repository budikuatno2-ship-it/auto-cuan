# SYSTEM ARCHITECTURE & LIFECYCLE — Auto-Cuan

**Audit type:** read-only forensic audit (no production code changed)
**Audit date:** 2026-09-14 (Asia/Jakarta)
**Reference revision audited:** working tree `feat/daytrade-screener-v1`, HEAD commit `559c310`
**Deployed build audited:** `https://auto-cuan.vercel.app` (production)
**Data endpoint used for cross-checks:** VPS HTTP bridge `https://wishing-challenged-deeper-crown.trycloudflare.com` (read-only GET)

All findings reference real files and line numbers. Probes used are read-only GETs and local `node` invocations; raw probe output is preserved in [`tmp_investigasi/`](tmp_investigasi:1).

---

# BAGIAN 1 — FORENSIC ROOT CAUSE OF THE 3 UI ANOMALIES

## Summary table

| # | UI symptom | Root cause | Status |
| --- | --- | --- | --- |
| 1 | "Pilih Tanggal" dropdown renders 1 option `2026-09-14 (Terbaru)` | `available_dates` is a raw `fs.readdirSync` listing of `data/arjum-data/broker-summary/<TICKER>/`, and the deployed BBCA directory contains exactly **1** file while other tickers contain 172. The client renders all it receives. The refill path that should have filled the gap cannot work in production because it hard-codes the Windows binary `curl.exe`. Separately, requesting an absent `date=` silently returns the newest snapshot under the requested label. See the Bagian 1 addendum. | PROVEN (runtime) |
| 2 | Market Scanner prices look stale (CUAN 630, PSAB 422, TKIM 5975, PTRO 4080) | Production serves a committed **static index snapshot** (write time `2026-09-12T16:57:26Z`) built from **abandoned OHLCV candles** (last candle `2026-07-17`). Live bridge VWAP for the same tickers is 914 / 572 / 7739 / 5212, i.e. the UI price is 31–37% wrong. | PROVEN (runtime) |
| 3 | Different ranges/tabs show the same stocks | Ticker-dependent. Where the deployed directory holds one dated file (BBCA), multi-day "aggregation" degenerates to a **single-day snapshot × integer multiplier** (`7d = ×5`, `30d = ×22`, `60d = ×44`) instead of a re-computation. Where history exists (CUAN), aggregation is real but its window runs past available data. Independently, `14d` and `30d` are byte-identical in the committed intel indexes, and `5d` is `7d` scaled by 5/7. | PROVEN (runtime) |

---

## Temuan #1 — Dropdown "Pilih Tanggal" only ever shows one option

### Prior audit claim vs. reality
The previous audit declared this "not a bug" because the backend returns ~30 dates. That claim is **true only for a local machine with disk cache**. On production the backend returns exactly **one** date. Both statements are reproducible:

```
# LOCAL (repo checkout, data/arjum-data present)
listDiskDates(BBCA) count = 60
getAvailableDates(BBCA) count = 60
getBandarmologiData 1d -> available_dates count= 60

# PRODUCTION (https://auto-cuan.vercel.app)
GET /api/sector-hot?action=available-dates&ticker=BBCA
-> {"success":true,"ticker":"BBCA","dates":["2026-09-14"]}      # length 1
```

### The client is NOT truncating the array
The dropdown renderer iterates the whole array with no slicing:

- [`public/bandarmologi-runtime.js:141`](public/bandarmologi-runtime.js:141) — `for (var ad = 0; ad < dates.length; ad++)` builds one `<option>` per date.
- [`public/bandarmologi-runtime.js:174`](public/bandarmologi-runtime.js:174) — the DOM `initBrokerDateSelect` path does the same.
- [`public/bandarmologi-runtime.js:144`](public/bandarmologi-runtime.js:144) — `' (Terbaru)'` is appended only to `ad === 0`, i.e. exactly what the screenshot shows once the array has length 1.

Date-source priority is defined in [`public/bandarmologi-runtime.js:29`](public/bandarmologi-runtime.js:29) and populated at [`public/bandarmologi-runtime.js:39`](public/bandarmologi-runtime.js:39) (`available_dates` first) and [`public/bandarmologi-runtime.js:124`](public/bandarmologi-runtime.js:124). Since the API supplies `available_dates` of length 1, the client has nothing else to render.

### Root cause in the backend — the date list is genuinely 1, for this ticker

The decisive test is not "does the API return dates" but "does `available-dates` agree with what `listDiskDates` can see". Both entry points read the *same* function, so they must agree:

- `action=available-dates` → `getAvailableDates()` → `listDiskDates('broker-summary', ticker)` first, VPS only as a fallback — [`api/sector-hot.js:97`](api/sector-hot.js:97), [`lib/bandarmologi-service.js:2145`](lib/bandarmologi-service.js:2145)`-2147`.
- `action=bandarmologi` → `getBandarmologiData()` → `const availableDates = listDiskDates('broker-summary', ticker)` as its **first** statement — [`lib/bandarmologi-service.js:1756`](lib/bandarmologi-service.js:1756).

Production, same deployment, same ticker set:

```
PRODUCTION available-dates count per ticker
BBCA: count=1    ["2026-09-14"]
CUAN: count=172  ["2026-09-14","2026-09-11",...]
PTRO: count=172
PSAB: count=172
TKIM: count=172
TLKM: count=172
ASII: count=172
```

For **CUAN** the two endpoints agree (172 dates) and the response for that ticker carries the full list:

```
bandarmologi 1d CUAN -> available_dates len = 172   top_buyers = 32
bandarmologi 1d BBCA -> available_dates len = 1     top_buyers = 29
```

So the first draft's "Defect 1b: `available_dates` is overwritten with a 1-element fallback" is **falsified**: the array is only replaced when `availableDates.length === 0` ([`lib/bandarmologi-service.js:2090`](lib/bandarmologi-service.js:2090)), and it is not zero for the tickers the screenshot showed. The dropdown renders 1 option because **the deployed instance really only has 1 dated file for BBCA** — the other 172 dates belong to other tickers.

### Root cause: the date list is a raw filesystem listing of environment-specific files
`listDiskDates` is nothing but a directory listing — [`lib/bandarmologi-service.js:145`](lib/bandarmologi-service.js:145)`-154`:

```js
const dateFiles = fs.readdirSync(targetDir)
  .filter(f => f.endsWith('.json') && f !== 'latest.json')
  .map(f => f.replace(/\.json$/, ''))
```

`targetDir` is `data/arjum-data/broker-summary/<TICKER>/`, so the dropdown's option count equals **the number of files that happen to exist in the deployed directory for that ticker**. For BBCA that is one file; for CUAN it is 172. Nothing computes or validates an expected history depth, so uneven per-ticker coverage is indistinguishable from correctness.

### Compounding defect — the VPS bridge is unreachable from the deployed runtime
Both bridge call sites shell out to a **Windows-only binary name**:

```js
// lib/vps-data-fetcher.js:96  (fetchAvailableDatesFromVpsSync)
// lib/vps-data-fetcher.js:166 (fetchBrokerSummaryFromVpsSync)
const curlOut = execFileSync('curl.exe', ['-s', '--max-time', '5', `${VPS_DATA_API_BASE}/api/...`], ...);
```

On the Linux serverless runtime `curl.exe` does not exist, so `execFileSync` throws and the surrounding `catch (_) {}` swallows it — [`:96`](lib/vps-data-fetcher.js:96)`-112` and [`:166`](lib/vps-data-fetcher.js:166)`-180`. The bridge itself is proven healthy (HTTP 200; 173 dates and 71 brokers for BBCA from a normal machine), so the failure is purely the hard-coded `curl.exe`. Consequence: in production **every** bridge call returns null, so a missing date can never be backfilled and the per-ticker directory listing is frozen at whatever was uploaded. The SSH fallbacks do not save it: they come after the curl attempt and require a private key that is not deployed ([`lib/vps-data-fetcher.js:184`](lib/vps-data-fetcher.js:184)).

### Consequence chain (proven by production probe)
```
available-dates BBCA          -> 1 date       ["2026-09-14"]        (1 file on disk)
available-dates CUAN          -> 172 dates                          (172 files on disk)
bandarmologi 1d BBCA          -> available_dates len 1,   top_buyers 29
bandarmologi 1d CUAN          -> available_dates len 172, top_buyers 32
explicit date=2026-09-11 BBCA -> 200 OK, labelled "2026-09-11", buyers 29  (RELABELLED, see addendum)
explicit date=2026-09-14 CUAN -> 200 OK, buyers 0, net_flow 0              (empty, no error)
dropdown                      -> 1 <option>, tag "(Terbaru)"
```

Two distinct failure modes, both silent:
- **Relabelled data (BBCA):** the requested date is absent from the 1-element list, so the fallback at [`:1843`](lib/bandarmologi-service.js:1843) substitutes `availableDates[0]` and the payload is returned under the requested label.
- **Empty 200 (CUAN):** the requested date *is* present, the read still yields nothing usable, `normalizeBrokerSummary` returns null, and the handler answers success with an empty broker list ([`:1849`](lib/bandarmologi-service.js:1849)`-1865`) — the UI renders a blank table instead of an error.

### Classification
**REAL BUG, still open on production.** Prior audit's "not a bug" verdict was based on a local checkout holding 60 files for that ticker and is invalid for the deployed environment, where the date list reflects an environment-specific upload and `curl.exe` guarantees it can never self-heal.

---

## Temuan #2 — Market Scanner displays non-real / stale prices

### Provenance of `current_price`
Field is produced by `detectPriceBelowBandarCost` → `getCachedClosePrice`, resolution order:

1. OHLCV candle cache, `data/daytrade-ohlcv-cache/<TICKER>.json` — [`lib/bandarmologi-intel-service.js:340`](lib/bandarmologi-intel-service.js:340)
2. Same candle rejected if stale (candle date < newest broker-summary date) — [`lib/bandarmologi-intel-service.js:364`](lib/bandarmologi-intel-service.js:364)
3. `KNOWN_TICKER_PRICES` baseline — [`lib/bandarmologi-intel-service.js:388`](lib/bandarmologi-intel-service.js:388), table at [`lib/bandarmologi-service.js:242`](lib/bandarmologi-service.js:242)
4. VWAP across brokers of the newest broker-summary day — [`lib/bandarmologi-intel-service.js:392`](lib/bandarmologi-intel-service.js:392) → [`lib/bandarmologi-intel-service.js:301`](lib/bandarmologi-intel-service.js:301)
5. `getReferencePrice` fallback — [`lib/bandarmologi-intel-service.js:415`](lib/bandarmologi-intel-service.js:415)

Path (1) is the active one *when the cache file exists*, and the cache files are abandoned:

```
data/daytrade-ohlcv-cache/CUAN.json  updated_at=2026-07-17T08:52:46Z  last candle date=2026-07-17 close=630
data/daytrade-ohlcv-cache/PTRO.json  updated_at=2026-07-17T08:52:49Z  last candle date=2026-07-17 close=4080
data/daytrade-ohlcv-cache/PSAB.json  updated_at=2026-07-17T08:52:49Z  last candle date=2026-07-17 close=422
data/daytrade-ohlcv-cache/TKIM.json  updated_at=2026-07-17T08:52:50Z  last candle date=2026-07-17 close=5975
```
(only 6 tickers exist at all: `BBCA, BMRI, CUAN, GOTO, ICBP, PTRO` — plus `PSAB/TKIM` pulled on demand from VPS during the probe, which returned the *same* July snapshot.)

### Where the UI number actually comes from: the committed static index
[`public/bandarmologi-runtime.js:4794`](public/bandarmologi-runtime.js:4794) renders Market Scanner rows straight out of `bandarIntelScannerData.indexes[category]`, and `bandarIntelScannerData` comes from the API or, on failure, the committed static file [`public/bandarmologi-runtime.js:4317`](public/bandarmologi-runtime.js:4317) (`/data/bandarmologi-intel-indexes/latest_<range>.json`).

The committed index is the actual payload production serves:

```
data/bandarmologi-intel-indexes/latest_7d.json
  updated_at = 2026-09-12T16:57:26.353Z        (write time, not a trading date)
  CUAN current_price=630  bandar_avg_buy=916
  PSAB current_price=422  bandar_avg_buy=603
  TKIM current_price=5975 bandar_avg_buy=8136
  PTRO current_price=4080 bandar_avg_buy=5346
```
Identical to the screenshot → the numbers on screen are **copied verbatim from this committed JSON**, with the stale July candle as price and the 2026-09-14 broker-summary VWAP as "modal".

### The numbers are wrong, quantified against the live source
```
TICKER  UI current_price   BRIDGE VWAP 2026-09-14   ERROR
CUAN    630                914                      -31.1%
PSAB    422                572                      -26.2%
TKIM    5975               7739                     -22.8%
PTRO    4080               5212                     -21.7%
```
(`bridge /api/broker-summary?ticker=X&date=latest` → `broker_start_date=2026-09-14`, VWAP = Σbval/Σbvol.)

Note the "31.22% discount" claim for CUAN in the UI is an artifact: the *modal* (916) is a 2026-09-14 figure while the *price* (630) is a 2026-07-17 figure. The comparison mixes two different market dates.

### Why the deploy never refreshes
Three independent reasons, each verified:

1. **The deployed filesystem is read-only.** Writes are redirected to `/tmp` on failure — [`lib/bandarmologi-intel-service.js:90`](lib/bandarmologi-intel-service.js:90)`-101`. Any recompute lands in an ephemeral directory that dies with the instance.
2. **Runtime recompute is explicitly disabled on Vercel** — `if (options.forceRefresh && !process.env.VERCEL)` at [`lib/bandarmologi-intel-service.js:1558`](lib/bandarmologi-intel-service.js:1558)`-1561`.
3. **A cache miss returns an error, never a rebuild.** `getBandarmologiIntel` returns "Intel index belum tersedia…" instead of computing, precisely because evaluating the universe inside a serverless request would time out — [`lib/bandarmologi-intel-service.js:1539`](lib/bandarmologi-intel-service.js:1539)`-1556`.

The indices *are* committed on purpose — [`.gitignore:108`](.gitignore:108)`-109` force-un-ignores `data/bandarmologi-intel-indexes/**` (and `data/broker-hunter-indexes/**` at [`:106`](.gitignore:106)`-107`), which is what makes a frozen artefact available to the deployed bundle at all. The consequence is structural: the only writable-and-persistent producer of these files is the VPS EOD job ([`tools/run-daily-broker-update.js:336`](tools/run-daily-broker-update.js:336) → [`lib/bandarmologi-intel-service.js:1511`](lib/bandarmologi-intel-service.js:1511)), and that job's output only reaches production when a commit ships it.

Evidence of the freeze: the production response's `updated_at = 2026-09-12T16:57:26.353Z` is byte-identical to the committed file, and the raw `data/` folder is not publicly served (every `/data/...` probe returned the 404 HTML page, 5794 bytes), so the index is reachable only through the API handler reading it from the function bundle.

### Classification
**REAL BUG.** Two independent defects: (a) intel index is a frozen committed snapshot, (b) its `current_price` falls back to abandoned July OHLCV.

---

## Temuan #3 — Ranges and tabs yield the same stocks

### 3a. Multi-day ranges are single-day data multiplied by an integer
[`lib/bandarmologi-service.js:1640`](lib/bandarmologi-service.js:1640):

```js
const mult = numDays === 60 ? 44 : (numDays === 30 ? 22 : (numDays === 14 ? 10 : (numDays === 7 ? 5 : (numDays === 5 ? 5 : ...))));
summary.net_flow = (summary.net_flow || 0) * mult;
summary.total_buy_val = Math.round(summary.total_buy_val * mult);
```

Production proof — every range returns the *same* single-day denominator scaled by an exact integer:

```
BBCA total_buy_val
1d  = 1,396,352,157,500
7d  = 6,981,760,787,500   ratio 7d/1d  = 5.000  (day count is 1)
30d = 30,719,747,465,000  ratio 30d/1d = 22.000 (day count is 1)
60d = 61,439,494,930,000  ratio 60d/1d = 44.000 (day count is 1)

headers ("date_headers") per range = 1 entry, labelled "(N Hari Agregat)"
```

Aggregation itself is implemented correctly at [`lib/bandarmologi-service.js:1321`](lib/bandarmologi-service.js:1321) and would iterate real disk dates at [`lib/bandarmologi-service.js:1464`](lib/bandarmologi-service.js:1464) — it is simply never reached for these tickers, because their deployed directory holds one dated file, so [`lib/bandarmologi-service.js:1802`](lib/bandarmologi-service.js:1802)`-1821` takes the `availableDates.length === 1` branch and applies the multiplier. That is the "kalkulasi dinamis" branch in the code that never fires for them (case **b** from the brief: synthetic, not computed).

**Counter-evidence that isolates the cause:** for a ticker that *does* ship history (CUAN, 172 files), the same code path performs a genuine aggregation — headers appear and the multipliers vanish:

```
CUAN 1d  -> bs.date = "2026-09-14"                     total_buy_val = 401,468,235,000   headers = 0
CUAN 5d  -> bs.date = "2026-09-09 s/d 2026-09-15"      total_buy_val = 3,535,357,142,834  headers = 0
CUAN 7d  -> bs.date = "2026-09-07 s/d 2026-09-15"      total_buy_val = 4,949,500,000,000  headers = 0
CUAN 30d -> bs.date = "2026-08-05 s/d 2026-09-15"      total_buy_val = 21,777,800,000,000 headers = 30
```

Note the ranges do **not** satisfy `total = 1d × mult` (7d would be 2,007,341,175,000 if multiplied; it is 4,949,500,000,000), and the 30d window ends `2026-09-15` — a date that is not a trading day and is in the future relative to the shipped broker-summary files, so the aggregate spans dates the ticker cannot actually have. Aggregation is therefore real *and* its window arithmetic is untrustworthy.

### 3b. Requested dates are ignored; one snapshot serves all dates
11 different `date=` values return 1 unique payload:

```
requested dates = 11  unique payload signatures = 1
2026-09-06? no -> 2026-09-14 through 2026-06-19 ALL return:
  total_buy_val=1396352157500 net_flow=117770132500 top3=YU:2568219627500|BK:195288795000|AK:209844072500
```
This contradicts the intent documented in [`lib/bandarmologi-service.js:99`](lib/bandarmologi-service.js:99) ("MUST return null, do NOT fallback to latest"). The bridge returns real per-date data (2026-09-11 and 2026-09-10 have a different sum_bval), so the drift is in what production caches, not in the vendor.

### 3c. Tab filters are distinct in code but degenerate in data
The five scanner tabs map to five independent detectors — [`public/bandarmologi-runtime.js:4773`](public/bandarmologi-runtime.js:4773) … [`public/bandarmologi-runtime.js:4778`](public/bandarmologi-runtime.js:4778), backed by `detectPriceBelowBandarCost` ([`lib/bandarmologi-intel-service.js:457`](lib/bandarmologi-intel-service.js:457)), `detectSilentForeignAccumulation` ([`lib/bandarmologi-intel-service.js:692`](lib/bandarmologi-intel-service.js:692)), `detectRetailCutlossVsBandar` ([`lib/bandarmologi-intel-service.js:914`](lib/bandarmologi-intel-service.js:914)), `computeConcentrationRatios`, and the distribution branch. Their thresholds differ (e.g. RR/score gates), so the tab logic itself is sound.

But at the *data* layer, different ranges collapse:
```
range 1d  S1=31  S3=["BREN","CUAN","PTBA","RAJA"] S4=["EMTK","MAPI","UNVR"] S5=0
range 7d  S1=31  S3=["TOBA"]                     S4=["DEWA"]             S5=0
range 5d  S1=7   S3=["BBCA","BMRI"]              S4=["BUMI"]             S5=5
range 14d S1=8   S3=["BBCA","BMRI"]              S4=["BUMI"]             S5=3
range 30d S1=8   S3=["BBCA","BMRI"]              S4=["BUMI"]             S5=4
range 60d S1=14  S3=["BBCA","BMRI"]              S4=["BUMI"]             S5=8

S1 14d == S1 30d ? true        (identical 8-ticker set)
14d/30d intersection = 8 of 8 union
```
`14d` and `30d` are the *same* payload — visible in the write timestamps of the committed files (`catalog_14d.json`, `catalog_30d.json`), and in the fact that both were generated without a range argument. Root cause is in the range→base-file mapping of the generator's source data: [`lib/bandarmologi-intel-service.js:137`](lib/bandarmologi-intel-service.js:137)`-171` (14d scales the 7d hunter set by 14/7; 30d uses the 30d base set), combined with the fixed `×2` scaling for 60d at [`lib/bandarmologi-intel-service.js:167`](lib/bandarmologi-intel-service.js:167).

Additionally, the "5d" dataset is synthesised by *proportional scaling of the 7d file* ([`lib/bandarmologi-intel-service.js:151`](lib/bandarmologi-intel-service.js:151), `scale = 5/7`), i.e. it is not an independent aggregation either.

### 3d. Cache interaction: "Emiten Aktif" vs "Market Scanner"
- **Market Scanner** (`bandarIntelViewMode === 'scanner'`) → served from the committed per-range index by `loadCachedIntel` ([`lib/bandarmologi-intel-service.js:104`](lib/bandarmologi-intel-service.js:104), candidate paths at [`lib/bandarmologi-intel-service.js:107`](lib/bandarmologi-intel-service.js:107)`-120`), and the frontend forces a static fetch only on failure ([`public/bandarmologi-runtime.js:4315`](public/bandarmologi-runtime.js:4315)).
- **Emiten Aktif** (`ticker`) → bypasses the index entirely and recomputes per ticker (`getBandarmologiIntel` early-returns `safeEvaluateBandarmologiIntelForTicker`, [`lib/bandarmologi-intel-service.js:1529`](lib/bandarmologi-intel-service.js:1529)).
- The two views therefore disagree for the same ticker and range:

```
range=7d ticket=CUAN  (Emiten Aktif) -> current_price=null  bandar_avg_buy=7900  discount_pct=null
range=7d scanner CUAN (Market Scanner) -> current_price=630 bandar_avg_buy=916   discount_pct=31.22
SAME TICKER, SAME RANGE, DIFFERENT VIEW -> price equal = false
range=7d PTRO  ticker=null  vs scanner=4080
```
This is a *confirmation* that the scanner is serving a stale artefact: the live path cannot produce a price at all in production, so it returns `NO_CURRENT_PRICE` ([`lib/bandarmologi-intel-service.js:625`](lib/bandarmologi-intel-service.js:625)), while the scanner happily shows the July number baked months earlier.

### Classification
**REAL BUG for 3a, 3b, 3c, and 3d** — synthetic scaling presented as aggregation for tickers with one file, real aggregation with an over-extended window for tickers with history, `14d ≡ 30d` in the committed indexes, and two views of the same ticker/range disagreeing on price.
**NOT a bug for the tab labels themselves** — the 5 tabs are genuinely distinct filters with distinct thresholds (see 3c); they only *look* interchangeable because the datasets feeding them collapse. The brief's option (a) "dynamic recompute per range" is real in code and fires only when per-ticker history exists; option (b) "static pre-baked JSON" describes the Market Scanner index; option (c) "cache key ignoring range" was fixed in earlier commits and is **not** the current cause — the frontend now sends `range` ([`public/bandarmologi-runtime.js:4300`](public/bandarmologi-runtime.js:4300)) and the browser cache key includes it ([`public/bandarmologi-runtime.js:1701`](public/bandarmologi-runtime.js:1701)).

---

## Addendum to Bagian 1 — date-relabeling mechanism, and what the deployed filesystem actually contains

### The relabeling defect (proven, `date=` path)
Requesting eleven different explicit dates for BBCA returned **one identical payload** with only the label changing:

| Probe (`ticker=BBCA&range=1d&date=…`) | Result |
| --- | --- |
| 2026-09-14, 09-11, 09-10, 09-09, 09-08, 09-07, 09-04, 08-31, 08-03, 07-31, 06-19 | All eleven: `total_buy_val=1396352157500`, `net_flow=117770132500`, top-3 `YU,BK,AK`, `buyers=29`. 1 unique signature. |
| Same dates from the VPS bridge | genuinely distinct per date (2026-06-19 → `sum_bval=1517511957500`, 20 brokers; 2026-09-11 → `1273531305000`) |

Mechanism, line by line — it is the **fallback branch** at [`lib/bandarmologi-service.js:1842`](lib/bandarmologi-service.js:1842)`-1847`:

1. `readDiskCache('broker-summary', 'BBCA', '2026-09-11')` returns **null**, because that dated file does not exist — [`lib/bandarmologi-service.js:86`](lib/bandarmologi-service.js:86)`-101`.
2. `const fallbackDate = availableDates.includes(targetDate) ? targetDate : availableDates[0]` — BBCA's list is `["2026-09-14"]`, so the requested date is **not** in it and the code substitutes `availableDates[0]` — [`:1843`](lib/bandarmologi-service.js:1843).
3. That file is read at [`:1844`](lib/bandarmologi-service.js:1844) and normalized with the **requested** date as its label: `normalizeBrokerSummary(diskSummary, diskSummary.date || targetDate, ticker)` — [`:1847`](lib/bandarmologi-service.js:1847). The on-disk payload carries `broker_start_date` and no `date`, so the label becomes whatever was asked for.

This is the same code path that produces the identical current price and "modal" across every range, and it is how a single stored snapshot can masquerade as any historical date.

### `available_dates` is a raw directory listing, and coverage is uneven per ticker
Both API entry points read the same function, so they cannot disagree — `available-dates` at [`lib/bandarmologi-service.js:2145`](lib/bandarmologi-service.js:2145), and `getBandarmologiData` starts from the identical call at [`:1756`](lib/bandarmologi-service.js:1756). Production agrees ticker-by-ticker:

```
BBCA: available-dates = 1    -> bandarmologi available_dates len = 1
CUAN: available-dates = 172  -> bandarmologi available_dates len = 172
PTRO / PSAB / TKIM / TLKM / ASII: 172 each
```

`listDiskDates` is only `fs.readdirSync(dir).filter(f => f.endsWith('.json') && f !== 'latest.json')` — [`:145`](lib/bandarmologi-service.js:145)`-154` — so those numbers are **filenames on the deployed filesystem**, and BBCA genuinely ships one dated file while CUAN ships 172.

### Explicit-date reads can also return an empty 200
For CUAN, four explicit dates each returned `200`, `top_buyers=0`, `net_flow=0` — no error, just an empty table. Here the requested date **is** in the 172-element list, so step 2 above does not substitute and the read still yields nothing usable; `normalizeBrokerSummary` returns null and the handler answers with the `NO_DATA` envelope at [`lib/bandarmologi-service.js:1849`](lib/bandarmologi-service.js:1849)`-1865`. Users see a blank panel rather than a failure.

### What this implies about the deployment input (proven, narrow)
The deployed filesystem contains `data/arjum-data/broker-summary/<TICKER>/<date>.json` files, yet the repository tracks **none** of them: `data/arjum-data/` is gitignored ([`.gitignore:104`](.gitignore:104)) and `git rev-list --all --objects` finds no `data/arjum-data/broker-summary/BBCA` path in any commit. Filenames alone cannot be invented by `listDiskDates`, so the deployment input must have included untracked local data files alongside the tracked source. That is the mechanism by which environment-specific, stale, and per-ticker-inconsistent data reaches production.

Deliberately **not** claimed: *which* operator/machine produced that upload, and why BBCA has one file while others have 172 — establishing that needs Vercel build logs or access to the deployed instance, neither available to this read-only audit.

### Consequence
- **Temuan #1** — the dropdown shows one option because the deployed BBCA directory holds one dated file. The client is correct; the backend is serving a filesystem listing of environment-specific data.
- **Temuan #3** — with one date available for the ticker, the multi-day path cannot aggregate and multiplies a single day instead ([`lib/bandarmologi-service.js:1645`](lib/bandarmologi-service.js:1645)).

---

# BAGIAN 2 — ARCHITECTURE & LIFECYCLE

## 2.1 Lifecycle timeline & execution schedule

### 2.1.1 Exchange clock configuration
There is no single exchange-calendar module with pre-opening/pre-closing phases; sessions are hard-coded in three places that must stay in agreement:

| Purpose | Function / location | Session map |
| --- | --- | --- |
| Screener run mode | [`lib/daytrade-screener-engine.js:110`](lib/daytrade-screener-engine.js:110) (`getRunMode`) | 09:00–10:30 `MORNING_SCOUT`; 10:30–13:30 `MIDDAY_CHECK`; 13:30–16:00 `AFTERNOON_EXIT`; else `OUTSIDE_MARKET` |
| Volume-pace windows (Mon–Thu) | [`lib/intraday-volume-pace.js:48`](lib/intraday-volume-pace.js:48) | `540–720`, `810–960` (total 330 min) |
| Volume-pace windows (Fri) | [`lib/intraday-volume-pace.js:38`](lib/intraday-volume-pace.js:38) | `540–690`, `840–960` (total 270 min) |
| EOD readiness | [`lib/arjum-client.js:216`](lib/arjum-client.js:216) (`isEodReadyWib`) | ready after 16:15 WIB on the same trading date |
| Market-hours guard | [`lib/arjum-client.js:210`](lib/arjum-client.js:210) (`isMarketHoursWib`) | `hour >= 9 && hour < 16`, weekend excluded |
| Trading-day / holiday | [`lib/idx-trading-calendar.js:34`](lib/idx-trading-calendar.js:34) | weekend guard + `idx_trading_calendar` holiday set (empty until manually seeded; see [`lib/idx-trading-calendar.js:9`](lib/idx-trading-calendar.js:9)) |
| Effective data date | [`lib/bandarmologi-service.js:193`](lib/bandarmologi-service.js:193) | before 18:00 WIB → previous trading day; else today; else latest on disk |

**Consequence:** the intraday IDX break (12:00–13:00 Mon–Thu, 11:30–14:00 Fri) is only respected by the volume-pace / Day Trade worker layer ([`docs/DAYTRADE_VPS_OBSERVE_WORKER.md:77`](docs/DAYTRADE_VPS_OBSERVE_WORKER.md:77)). [`lib/daytrade-screener-engine.js:128`](lib/daytrade-screener-engine.js:128) treats 10:30–13:30 as one continuous `MIDDAY_CHECK` window, so a run at 12:15 WIB is classified as an active session even though the exchange is closed. There is no pre-opening or pre-closing phase anywhere in code.

### 2.1.2 Execution triggers (who runs what, when)

| Trigger | Schedule | Entry point | Notes |
| --- | --- | --- | --- |
| Vercel cron | `0 1 * * 1-5` (08:00 WIB) | [`vercel.json:556`](vercel.json:556) → `/api/sector-hot?action=telegram-daily-picks` | The only versioned Vercel cron. Handler [`api/sector-hot.js:6202`](api/sector-hot.js:6202), `CRON_SECRET`-gated. |
| VPS broker update | 20:00/20:30/21:00/21:30 + `--final` 22:00 WIB | [`deploy/vps/run-daily-broker-update.sh:14`](deploy/vps/run-daily-broker-update.sh:14) → `tools/run-daily-broker-update.js` | Idempotent, completion marker; runs intel pre-calc at [`tools/run-daily-broker-update.js:336`](tools/run-daily-broker-update.js:336). |
| VPS market context | 16:15 WIB Mon–Fri (documented, not installed) | [`deploy/vps/run-daily-market-context-collector.sh:7`](deploy/vps/run-daily-market-context-collector.sh:7) | 20-min bounded job. |
| VPS afternoon recap | 16:15 WIB Mon–Fri | [`deploy/vps/run-daily-afternoon-recap.sh:5`](deploy/vps/run-daily-afternoon-recap.sh:5) | `--send` required. |
| Day Trade worker (observe) | 12-min loop during market, break-aware | [`docs/DAYTRADE_VPS_OBSERVE_WORKER.md:72`](docs/DAYTRADE_VPS_OBSERVE_WORKER.md:72) → [`tools/daytrade-vps-worker-observe.js:1`](tools/daytrade-vps-worker-observe.js:1) | Observe-only: no Supabase write, no Telegram. |
| Fast Watcher (guarded live) | every 3 min during session | [`docs/INTRADAY_FAST_WATCHER.md:8`](docs/INTRADAY_FAST_WATCHER.md:8), orchestrator [`lib/intraday-fast-watcher-guarded-live.js:18`](lib/intraday-fast-watcher-guarded-live.js:18) | Scheduling deliberately not installed; gated by env. |
| Swing Konglo refresh | none versioned | [`api/sector-hot.js:205`](api/sector-hot.js:205) `action=refresh-screener` | Manual / orchestrator (documented in [`docs/SCREENER_SCHEDULE_AUDIT.md:8`](docs/SCREENER_SCHEDULE_AUDIT.md:8)). |
| Swing Non-Konglo | schedule commented out | [`.github/workflows/non-konglo-screener.yml:9`](.github/workflows/non-konglo-screener.yml:9) | Manual-first policy. |
| Daily picks monitor | manual only | [`.github/workflows/monitor-picks.yml:1`](.github/workflows/monitor-picks.yml:1) | `workflow_dispatch`. |
| Foreign flow sync | 16:30 WIB weekdays (documented in script header) | [`scripts/idx-sync/sync_foreign_flow.py:28`](scripts/idx-sync/sync_foreign_flow.py:28) → Supabase `idx_foreign_flow_daily` | GitHub workflow version of this is debug-only ([`.github/workflows/sync-foreign-flow.yml:3`](.github/workflows/sync-foreign-flow.yml:3)). |
| AI eval supervisor | systemd service | [`deploy/systemd/auto-cuan-ai-eval-once.service:16`](deploy/systemd/auto-cuan-ai-eval-once.service:16) | One-time run, not periodic. |

Runner convention: everything on the VPS goes through `/home/ubuntu/auto-cuan-runner/` for state/locks/logs, forced `TZ=Asia/Jakarta`, and non-blocking `flock` ([`deploy/vps/run-daily-broker-update.sh:35`](deploy/vps/run-daily-broker-update.sh:35), [`:55`](deploy/vps/run-daily-broker-update.sh:55)).

### 2.1.3 Polling / refresh intervals

| Layer | Interval | Reference |
| --- | --- | --- |
| Day Trade web UI live refresh | 20 s (visible tab, daytrade screener only) | [`public/fast-watcher-live-refresh.js:7`](public/fast-watcher-live-refresh.js:7), guard at [`:19`](public/fast-watcher-live-refresh.js:19) |
| Fast Watcher live collection | 3 min, concurrency 4, timeout 12 s, max 20 tickers (hard cap 50) | [`docs/INTRADAY_FAST_WATCHER.md:8`](docs/INTRADAY_FAST_WATCHER.md:8), [`lib/intraday-fast-watcher-live.js:6`](lib/intraday-fast-watcher-live.js:6) |
| Day Trade VPS worker | 12 min loop; one heartbeat scan inside break windows | [`docs/DAYTRADE_VPS_OBSERVE_WORKER.md:72`](docs/DAYTRADE_VPS_OBSERVE_WORKER.md:72) |
| Bandarmologi memory cache | 5 min TTL, max 300 keys | [`lib/bandarmologi-service.js:13`](lib/bandarmologi-service.js:13), [`:61`](lib/bandarmologi-service.js:61) |
| Intel hunter index memory cache | unbounded per-process Map | [`lib/bandarmologi-intel-service.js:135`](lib/bandarmologi-intel-service.js:135) |
| VPS date/broker memory cache (server) | unbounded per-process Map | [`lib/vps-data-fetcher.js:18`](lib/vps-data-fetcher.js:18)`-19` |
| VPS cache (browser) | per-ticker Map, range-scoped key | [`public/bandarmologi-runtime.js:1641`](public/bandarmologi-runtime.js:1641)`-1642`, key at [`:1701`](public/bandarmologi-runtime.js:1701) |
| Yahoo candle cache (TTL) | 15 min during market | [`lib/daytrade-ohlcv-cache.js:31`](lib/daytrade-ohlcv-cache.js:31), effective TTL at [`:286`](lib/daytrade-ohlcv-cache.js:286) |

---

## 2.2 Day Trade Engine

### 2.2.1 Ingestion

| Source | Mechanism | Reference |
| --- | --- | --- |
| Candle OHLCV | Yahoo `query2.finance.yahoo.com/v8/finance/chart/<TICKER>.JK?range=90d&interval=1d` | [`lib/daytrade-screener-engine.js:158`](lib/daytrade-screener-engine.js:158) |
| Candle cache | 90D per-ticker JSON in `data/daytrade-ohlcv-cache/<TICKER>.json`, 15-min TTL, stale-fallback on Yahoo error | [`lib/daytrade-ohlcv-cache.js:30`](lib/daytrade-ohlcv-cache.js:30)`-31` |
| Universe | `stock_boards` full-eligible universe (UTAMA / PENGEMBANGAN), plus `foreign_watchlist_daily` history source | [`api/sector-hot.js:656`](api/sector-hot.js:656)`-657` |
| Broker summary (daily) | Arjum API / disk cache / VPS HTTP bridge / VPS SSH — four-tier resolution | [`lib/bandarmologi-service.js:1756`](lib/bandarmologi-service.js:1756)`-1793` |
| Intraday volume pace | `lib/intraday-volume-pace.js` uses real session windows + completed candles | [`lib/intraday-volume-pace.js:34`](lib/intraday-volume-pace.js:34) |

Minimum candle requirement is 20 bars: `return candles.length >= 20 ? candles : null` — [`lib/daytrade-screener-engine.js:194`](lib/daytrade-screener-engine.js:194); a batch item with fewer than 20 bars is recorded as `insufficient_candles_*` at [`:1742`](lib/daytrade-screener-engine.js:1742).

### 2.2.2 Calculation pipeline

```
candles -> analyzeDayTrade()          lib/daytrade-screener-engine.js:201   (metrics extraction)
        -> calculateLevels()          lib/daytrade-screener-engine.js:610   (entry/SL/TP, ATR-aware)
        -> idxTick.normalizeLevelsToIdxTicks()  lib/daytrade-screener-engine.js:1147
        -> scoreLiquidity()           lib/daytrade-screener-engine.js:331
        -> scorePreSpike()            lib/daytrade-screener-engine.js:388
        -> scoreMomentum()            lib/daytrade-screener-engine.js:437
        -> scoreRiskReward()          lib/daytrade-screener-engine.js:475 (levels)
        -> scoreTrend()               lib/daytrade-screener-engine.js:494
        -> candle-pattern scoring      lib/daytrade-screener-engine.js:1195-1199 (negative downgrades)
        -> calculatePenalty()         lib/daytrade-screener-engine.js:523   (floor -40, at :601)
        -> scoreDayTrade()            lib/daytrade-screener-engine.js:1141  (composite)
        -> classifyStatus()           lib/daytrade-screener-engine.js:783   (state machine)
```

Composite score arithmetic: `total = base + volSurge + orderFlow + tech` with `BASE_SCORE = 25` — [`lib/daytrade-screener-engine.js:2889`](lib/daytrade-screener-engine.js:2889), [`lib/daytrade-screener-engine.js:2946`](lib/daytrade-screener-engine.js:2946). Hard ceiling: if volume ratio < 1.0 or the volume-surge component is 0, `total` is clamped to 64 — [`lib/daytrade-screener-engine.js:2947`](lib/daytrade-screener-engine.js:2947). Max score 100; persist threshold 50; tradeable threshold 65 — [`lib/daytrade-screener-constants.js:26`](lib/daytrade-screener-constants.js:26)`-27`.

Technical sub-score caps are volume-gated: `tech = min(24, tech)` when volume is weak, `min(30, tech)` otherwise — [`lib/daytrade-screener-engine.js:2940`](lib/daytrade-screener-engine.js:2940)`-2944`. Volume/frequency weighting lives in `scoreLiquidity` (value-today and 7-day average value floors of 1B / 500M IDR, ratio floors of 0.3) — [`lib/daytrade-screener-engine.js:343`](lib/daytrade-screener-engine.js:343)`-359`.

### 2.2.3 Emiten state machine (complete)

Thresholds from [`lib/daytrade-screener-constants.js:5`](lib/daytrade-screener-constants.js:5)`-23`, branches from [`lib/daytrade-screener-engine.js:783`](lib/daytrade-screener-engine.js:783)`-1009`.

| State | Condition | Reference |
| --- | --- | --- |
| `AVOID` (liquidity) | `liqResult.pass === false` — checked before any score | [`lib/daytrade-screener-engine.js:795`](lib/daytrade-screener-engine.js:795) |
| `AVOID` (score) | `score < 40`, or `< 50 && volume_ratio < 0.5 && change_pct < 0`, or `< 50 && risk distance > 8%` | [`:845`](lib/daytrade-screener-engine.js:845), [`:848`](lib/daytrade-screener-engine.js:848), [`:852`](lib/daytrade-screener-engine.js:852) |
| `A_PLUS_SETUP` | `score >= 88`, zero hard-fails, not afternoon, price above open, `volume_ratio >= 1.5`, `range_position >= 60` | [`:860`](lib/daytrade-screener-engine.js:860) |
| `TRADE_CANDIDATE` | `score >= 78`, zero hard-fails, not afternoon | [`:863`](lib/daytrade-screener-engine.js:863) |
| `READY_BREAKOUT` | `score >= 75`, zero hard-fails, `R/R >= 1.5`, risk distance `<= 5%` | [`:866`](lib/daytrade-screener-engine.js:866) |
| `PRE_SPIKE_WATCH` | `score >= 70`, zero hard-fails, not afternoon, volume confirmed | [`:905`](lib/daytrade-screener-engine.js:905) |
| `MOMENTUM_CONTINUATION` | Gap/overheat path **with** `> 1.5x` volume and price above open | [`:897`](lib/daytrade-screener-engine.js:897) |
| `WAIT_PULLBACK` | Gap/overheat **without** volume confirmation; also all afternoon `PRE_SPIKE`-grade setups | [`:901`](lib/daytrade-screener-engine.js:901), [`:931`](lib/daytrade-screener-engine.js:931), [`:937`](lib/daytrade-screener-engine.js:937) |
| `EARLY_RADAR` | `score >= 62`, near breakout, blocked only by low volume, not afternoon | [`:920`](lib/daytrade-screener-engine.js:920) |
| `SPECULATIVE` | Low-volume non-near-breakout (`>= 70`); or Papan Akselerasi cap; or `score >= 50` residual | [`:924`](lib/daytrade-screener-engine.js:924), [`:1003`](lib/daytrade-screener-engine.js:1003), [`:991`](lib/daytrade-screener-engine.js:991) |

Papan Akselerasi is a hard cap: any `A_PLUS_SETUP` / `TRADE_CANDIDATE` / `READY_BREAKOUT` / `PRE_SPIKE_WATCH` / `MOMENTUM_CONTINUATION` on that board is downgraded to `SPECULATIVE` — [`lib/daytrade-screener-engine.js:1003`](lib/daytrade-screener-engine.js:1003)`-1007`.

The **intraday** state machine is separate and lives in the Fast Watcher pool: `WATCHING → READY_PENDING → READY_CONFIRMED` with 3-of-5 confirmations required (window size 5, `REQUIRED_CONFIRMATIONS = 3`) — [`lib/intraday-fast-watcher-pool.js:12`](lib/intraday-fast-watcher-pool.js:12)`-13`, transition at [`:356`](lib/intraday-fast-watcher-pool.js:356). Terminal / informational states: `SPIKE_RADAR` (informational, resets confirmation window, [`:362`](lib/intraday-fast-watcher-pool.js:362)), `BLOCKED_CHASE`, `INVALIDATED`, `STALE`, `INVALID_DATA` ([`:347`](lib/intraday-fast-watcher-pool.js:347)), and `DROPPED_FROM_WATCH_POOL` ([`:419`](lib/intraday-fast-watcher-pool.js:419)). `PENDING_VELOCITY` appears only as an accepted label in the radar publisher — [`lib/intraday-fast-watcher-radar-publisher.js:117`](lib/intraday-fast-watcher-radar-publisher.js:117).

### 2.2.4 State / output storage

| Artefact | Location | Written by |
| --- | --- | --- |
| Day Trade results | Supabase `daytrade_screener_latest` + `daytrade_screener_meta` | [`api/sector-hot.js:11932`](api/sector-hot.js:11932) (`handleDayTradeScreenerRun`) |
| Fast Watcher state | `data/intraday-fast-watcher-state/<date>.json` | [`lib/intraday-fast-watcher.js:11`](lib/intraday-fast-watcher.js:11) |
| Fast Watcher events | `data/intraday-fast-watcher-events/` | [`lib/intraday-fast-watcher.js:12`](lib/intraday-fast-watcher.js:12) |
| Guarded-live state / events / published ledger | `data/intraday-fast-watcher-live-state/`, `-live-events/`, `intraday-fast-watcher-published/` | [`lib/intraday-fast-watcher-guarded-live.js:12`](lib/intraday-fast-watcher-guarded-live.js:12)`-14` |
| Broker-summary disk cache | `data/arjum-data/broker-summary/<TICKER>/<date>.json` (+ `latest.json`) | [`lib/bandarmologi-service.js:172`](lib/bandarmologi-service.js:172) |
| Intel index (git-tracked) | `data/bandarmologi-intel-indexes/latest_<range>.json` | [`lib/bandarmologi-intel-service.js:1511`](lib/bandarmologi-intel-service.js:1511) |
| Broker-hunter index (git-tracked) | `data/broker-hunter-indexes/<BROKER>_<range>.json` | [`lib/broker-hunter-service.js:14`](lib/broker-hunter-service.js:14) |

---

## 2.3 Fast Watcher (Radar, Early Watch, Spike)

### 2.3.1 Loop frequency
3-minute cadence, concurrency 4 (hard max 4), 12 s per-fetch timeout, 20 tickers per pass (hard cap 50) — [`docs/INTRADAY_FAST_WATCHER.md:8`](docs/INTRADAY_FAST_WATCHER.md:8), [`lib/intraday-fast-watcher-live.js:6`](lib/intraday-fast-watcher-live.js:6)`-8`, [`lib/intraday-fast-watcher.js:7`](lib/intraday-fast-watcher.js:7)`-8`. The pool caps active tracking at 30 tickers — [`lib/intraday-fast-watcher-pool.js:15`](lib/intraday-fast-watcher-pool.js:15).

### 2.3.2 What distinguishes Early Watch vs Radar vs Spike

| Layer | Entry condition | Reference |
| --- | --- | --- |
| **Early Watch** | Status is exactly `WATCHING` or `READY_PENDING` — i.e. *pre-confirmation only*. `READY_CONFIRMED` is explicitly excluded (the confirmed publisher owns it) | [`lib/intraday-fast-watcher-early-watch-publisher.js:72`](lib/intraday-fast-watcher-early-watch-publisher.js:72) |
| **Radar** | `internal_status ∈ {READY_PENDING, PENDING_VELOCITY, WAIT_PULLBACK, WATCHING, SPIKE_RADAR}` **and** `watch_score >= 55` (floor waived only for `SPIKE_RADAR`) **and** R/R ≥ 1.0x **and** not in a blocking reason set | [`lib/intraday-fast-watcher-radar-publisher.js:117`](lib/intraday-fast-watcher-radar-publisher.js:117), [`:121`](lib/intraday-fast-watcher-radar-publisher.js:121)`-123`, `MIN_RADAR_WATCH_SCORE = 55` at [`:9`](lib/intraday-fast-watcher-radar-publisher.js:9) |
| **Spike** | `SPIKE_RADAR`: advance exceeds the adaptive tolerance `clamp(max(2.5, volatility*1.5), 2.5, 6)` or price above the adaptive entry tolerance — informational only, never entry-eligible | [`lib/intraday-fast-watcher-momentum.js:482`](lib/intraday-fast-watcher-momentum.js:482)`-483`, [`:487`](lib/intraday-fast-watcher-momentum.js:487), status set at [`:466`](lib/intraday-fast-watcher-momentum.js:466) |

### 2.3.3 Gate stack before any Telegram blast

1. Kill switches: `FAST_WATCHER_LIVE_ENABLED == '1'` — [`lib/intraday-fast-watcher-guarded-live.js:16`](lib/intraday-fast-watcher-guarded-live.js:16).
2. Confirmed publisher additionally needs `FAST_WATCHER_PUBLISH_ENABLED == '1'` — [`lib/intraday-fast-watcher-publisher.js:310`](lib/intraday-fast-watcher-publisher.js:310)`-312`.
3. Production eligibility (data quality only, never derived from `execution_grade`) — [`lib/intraday-production-eligibility.js:19`](lib/intraday-production-eligibility.js:19), applied at [`lib/intraday-fast-watcher-pool.js:329`](lib/intraday-fast-watcher-pool.js:329).
4. Score floor 55 for non-Spike radar items — [`lib/intraday-fast-watcher-radar-publisher.js:121`](lib/intraday-fast-watcher-radar-publisher.js:121).
5. R/R below `minimum_risk_reward` (default **1**, from plan `minimum_rr_to_tp1`) blocks readiness — [`lib/intraday-fast-watcher-momentum.js:256`](lib/intraday-fast-watcher-momentum.js:256), [`:491`](lib/intraday-fast-watcher-momentum.js:491).
6. **`POOR_RR` gate**: Early Watch blocks the canonical engine `POOR_RR` / "RR kurang menarik" source status — [`lib/intraday-fast-watcher-early-watch-publisher.js:83`](lib/intraday-fast-watcher-early-watch-publisher.js:83)`-84`. `POOR_RR` itself is produced by the tick-normalization layer when the RR label is "RR kurang menarik" — [`lib/idx-tick-normalization.js:171`](lib/idx-tick-normalization.js:171).
7. Always-blocking reasons after publication: `engine_hard_reject`, `tp1_already_reached`, `invalid_tp1`, `stale`, `stop_touched`, `missing_stop_loss`, … — [`lib/intraday-fast-watcher-radar-publisher.js:10`](lib/intraday-fast-watcher-radar-publisher.js:10)`-23`; chase reasons at [`:24`](lib/intraday-fast-watcher-radar-publisher.js:24)`-27`.
8. Hard broadcast caps: 3 confirmed items per pass — [`lib/intraday-fast-watcher-publisher.js:10`](lib/intraday-fast-watcher-publisher.js:10); 3 radar items — [`lib/intraday-fast-watcher-radar-publisher.js:8`](lib/intraday-fast-watcher-radar-publisher.js:8).

**Cooldown/antispam:** there is **no time-based cooldown**. Deduplication is identity-based, not time-based — `setup_id` (hash of date, ticker, canonical metrics) is the ledger key, so the same setup re-observed does not re-send, and only state changes are appended to the event log ([`lib/intraday-fast-watcher-pool.js:48`](lib/intraday-fast-watcher-pool.js:48), [`docs/INTRADAY_FAST_WATCHER.md:12`](docs/INTRADAY_FAST_WATCHER.md:12)). Early Watch is explicitly once-per-ticker-per-date.

### 2.3.4 Telegram destinations

| Signal type | Chat resolution | Reference |
| --- | --- | --- |
| Confirmed Day Trade | `FAST_WATCHER_TELEGRAM_CHAT_ID` → fallback `TELEGRAM_CHAT_ID` | [`lib/intraday-fast-watcher-publisher.js:426`](lib/intraday-fast-watcher-publisher.js:426) |
| Radar | same two vars | [`lib/intraday-fast-watcher-radar-publisher.js:270`](lib/intraday-fast-watcher-radar-publisher.js:270) |
| Early Watch | same two vars | [`lib/intraday-fast-watcher-early-watch-publisher.js:293`](lib/intraday-fast-watcher-early-watch-publisher.js:293) |
| Top 5 / daily picks (Vercel cron) | `TELEGRAM_CHAT_ID` via [`lib/telegram-notifier.js:91`](lib/telegram-notifier.js:91) | [`api/sector-hot.js:6202`](api/sector-hot.js:6202) |
| Admin / approval alerts | dedicated `TELEGRAM_APPROVAL_CHAT_ID` / `TELEGRAM_VERIFY_ADMIN_CHAT_ID`; must never fall back to the public chat | [`lib/admin-users-handler.js:40`](lib/admin-users-handler.js:40)`-42`, [`lib/daytrade-experimental-admin-alert.js:150`](lib/daytrade-experimental-admin-alert.js:150) |

There is **no per-signal-type chat separation**: confirmed, radar, and early-watch all resolve to the same public chat. Only admin/approval traffic is segregated.

---

## 2.4 Swing Trader / Sector Hot

### 2.4.1 Execution schedule
- Intraday preview / refresh: no versioned schedule. `action=refresh-screener` (Konglo) — [`api/sector-hot.js:205`](api/sector-hot.js:205); `action=nk-screener-run` (Non-Konglo) — [`:212`](api/sector-hot.js:212). Both `CRON_SECRET`-gated and documented as manual/orchestrator-managed — [`docs/SCREENER_SCHEDULE_AUDIT.md:8`](docs/SCREENER_SCHEDULE_AUDIT.md:8).
- GitHub Actions Non-Konglo: schedule block commented out, manual-first — [`.github/workflows/non-konglo-screener.yml:9`](.github/workflows/non-konglo-screener.yml:9).
- Sector-hot group refresh (Yahoo quotes → `sector_hot_members_latest` / `sector_hot_latest`): `action=refresh` — [`api/sector-hot.js:247`](api/sector-hot.js:247), logic at [`:1363`](api/sector-hot.js:1363). Manual CLI equivalent: [`scripts/refresh-sector-hot.js:1`](scripts/refresh-sector-hot.js:1).
- EOD snapshot: VPS afternoon recap at 16:15 WIB — [`deploy/vps/run-daily-afternoon-recap.sh:5`](deploy/vps/run-daily-afternoon-recap.sh:5).
- Foreign sync: documented cron 16:30 WIB weekdays in the script header — [`scripts/idx-sync/sync_foreign_flow.py:28`](scripts/idx-sync/sync_foreign_flow.py:28); destination table `idx_foreign_flow_daily` (not a Supabase table referenced from `api/`, which reads `foreign_watchlist_daily`).

### 2.4.2 Multi-day aggregation (1D → 60D)
`rangeDaysMap = { '1d':1, '5d':5, '7d':7, '14d':14, '30d':30, '60d':60 }` — [`lib/bandarmologi-service.js:1696`](lib/bandarmologi-service.js:1696).

- Window selection: `filterCalendarWindowDates()` sorts dates descending, caps the lookback at `ceil(days * 2.5)` calendar days, and **breaks** on a gap larger than ~5 calendar days so a data hole cannot silently jump weeks — [`lib/bandarmologi-service.js:1289`](lib/bandarmologi-service.js:1289)`-1319`.
- Aggregation: `aggregateBrokerSummaries()` merges per-broker buy/sell sums across those dates and rebuilds `date_headers` — [`lib/bandarmologi-service.js:1321`](lib/bandarmologi-service.js:1321), header construction at [`:1410`](lib/bandarmologi-service.js:1410)`-1415`, totals at [`:1599`](lib/bandarmologi-service.js:1599)`-1603`.
- **Synthetic scaling fallback:** when fewer than `reqDays` dates exist on disk, the code does not aggregate — it multiplies one day by a fixed constant: `60d → ×44`, `30d → ×22`, `14d → ×10`, `7d → ×5`, `5d → ×5` — [`lib/bandarmologi-service.js:1645`](lib/bandarmologi-service.js:1645). Confirmed at runtime: prod `total_buy_val` ratios vs 1D were exactly `5.000 / 22.000 / 44.000` for 7D/30D/60D.
- CR3/CR5: `computeConcentrationRatios()` prefers real aggregation when `numDays > 1` and >1 date exists; otherwise it reads a single snapshot — [`lib/bandarmologi-intel-service.js:1038`](lib/bandarmologi-intel-service.js:1038)`-1042`. Classification: `>= 60%` massive, `>= 40%` concentrated, triggered at `>= 40%` — [`:1132`](lib/bandarmologi-intel-service.js:1132)`-1141`.
- Net broker: gross vs net split happens in `normalizeBrokerSummary()` — gross lists at [`lib/bandarmologi-service.js:598`](lib/bandarmologi-service.js:598)`-604`, net lists at [`:606`](lib/bandarmologi-service.js:606)`-612`.

### 2.4.3 Bandar average cost ("modal") and freshness
- Definition: volume-weighted average buy price of the **top-3 net accumulators**, `avgBuyTop3 = normalizeVwapPrice(totalBuyVal / totalBuyVol, refPrice)` — [`lib/bandarmologi-intel-service.js:609`](lib/bandarmologi-intel-service.js:609)`-610`.
- Broker sourcing cascade: `options.brokerSummary` → newest broker-summary on disk (aggregated for multi-day) → broker-hunter indexes — [`lib/bandarmologi-intel-service.js:463`](lib/bandarmologi-intel-service.js:463)`-519`.
- Trigger semantics: `triggered = discount_pct >= 1.0`; sweet spot `1.5%–5.0%`; at-par when `|discount| < 1.0%` — [`lib/bandarmologi-intel-service.js:655`](lib/bandarmologi-intel-service.js:655)`-658`.
- Freshness: the index carries `updated_at`, `effective_date`, and `date` where `marketDate = getEffectiveTradingDate()` — [`lib/bandarmologi-intel-service.js:1480`](lib/bandarmologi-intel-service.js:1480), [`:1486`](lib/bandarmologi-intel-service.js:1486)`-1488`. Note the two mean different things: `updated_at` is a *write/build* timestamp (prod 7d = `2026-09-12T16:57:26Z`), `effective_date` is the trading date the build considered current.
- **Recompute is blocked in production by design**: `if (options.forceRefresh && !process.env.VERCEL)` — [`lib/bandarmologi-intel-service.js:1558`](lib/bandarmologi-intel-service.js:1558). Serverless reads the baked JSON and can never refresh it.

---

## 2.5 Data architecture (ASCII)

```
 VENDOR / SOURCE LAYER
 +-------------------------------+   +------------------------------------+
 | Arjum API (broker summary,    |   | Yahoo Finance chart API            |
 | accumulation, insiders)       |   | range=90d interval=1d              |
 | ARJUM_API_KEY, quota CB       |   |                                    |
 +---------------+---------------+   +----------------+-------------------+
                 |                                    |
                 | (on-demand, key-gated)             | (batched, TTL 15m)
                 v                                    v
 +-------------------------------+   +------------------------------------+
 | VPS HTTP BRIDGE (port 3001)   |   | daytrade-ohlcv-cache/<T>.json      |
 | /api/broker-summary           |   | data/daytrade-ohlcv-cache/         |
 | /api/available-dates          |   | (gitignored, 90D candles)          |
 | /api/insider-*                |   +----------------+-------------------+
 | trycloudflare tunnel          |                    |
 +---------------+---------------+                    |
                 |  (curl/curl.exe + ssh fallback)    |
                 v                                    |
 +-------------------------------+                    |
 | DISK CACHE (server)           |                    |
 | data/arjum-data/broker-summary|                    |
 |   /<TICKER>/<YYYY-MM-DD>.json |                    |
 |   + latest.json               |                    |
 | ARJUM_DATA_DIR override       |                    |
 +---------------+---------------+                    |
                 |                                    |
                 +----------------+-------------------+
                                  |
                                  v
 +-----------------------------------------------------------------------+
 | ENGINE & SCORING                                                      |
 |                                                                       |
 |  A. Day Trade Engine  lib/daytrade-screener-engine.js                 |
 |     analyzeDayTrade -> levels -> liquidity/prespike/momentum/rr/trend |
 |     -> penalty -> scoreDayTrade(base25 + vol + flow + tech, cap 64)   |
 |     -> classifyStatus() -> Supabase daytrade_screener_latest          |
 |                                                                       |
 |  B. Bandarmologi Service  lib/bandarmologi-service.js                 |
 |     getBandarmologiData(ticker,{range,date,flow})                     |
 |     readDiskCache/normalizeBrokerSummary/filterCalendarWindowDates    |
 |     aggregateBrokerSummaries  (else applyMultiDayScaling x5/x22/x44)  |
 |                                                                       |
 |  C. Intel Service  lib/bandarmologi-intel-service.js                  |
 |     getCachedClosePrice -> detectPriceBelowBandarCost (VWAP top3)     |
 |     detectSilentForeignAccumulation                                   |
 |     detectRetailCutlossVsBandar                                       |
 |     computeConcentrationRatios (CR3/CR5, gate >=40/60)                |
 |     computeAndSaveIntel -> data/bandarmologi-intel-indexes/*.json     |
 |                                                                       |
 |  D. Fast Watcher  lib/intraday-fast-watcher-*.js                      |
 |     buildShortlist(<=20) -> runDayTradeBatch -> momentum.evaluate     |
 |     -> pool: WATCHING/READY_PENDING/READY_CONFIRMED/SPIKE_RADAR       |
 |     -> guarded-live -> confirmed | radar | early-watch publishers     |
 |                                                                       |
 |  E. Swing / Sector Hot  lib/swing-screener-engine.js +               |
 |     api/sector-hot.js handleRefresh -> Supabase sector_hot_*          |
 +----------------+------------------------------------+-----------------+
                  |                                    |
                  v                                    v
 +--------------------------------+   +------------------------------------+
 | STORAGE                        |   | DELIVERY                           |
 | - Supabase: daytrade_screener_*|   | - Telegram: FAST_WATCHER_*_CHAT_ID |
 |   sector_hot_*, foreign_*,     |   |   -> TELEGRAM_CHAT_ID (public)     |
 |   idx_foreign_flow_daily,      |   |   admin: TELEGRAM_APPROVAL_CHAT_ID |
 |   stock_daily_history/features |   |   / TELEGRAM_VERIFY_ADMIN_CHAT_ID  |
 | - Disk JSON: arjum-data,       |   | - Vercel cron 0 1 * * 1-5 ->       |
 |   broker-hunter-indexes*,      |   |   action=telegram-daily-picks      |
 |   bandarmologi-intel-indexes*, |   +------------------------------------+
 |   intraday-fast-watcher-*      |                    |
 | - In-memory: MEMORY_CACHE 5m   |                    v
 +--------------------------------+   +------------------------------------+
                  |                    | DASHBOARD UI (browser)             |
                  +------------------> | /api/sector-hot?action=...         |
                                       | - bandarmologi-runtime.js          |
                                       | - daytrade-runtime.js              |
                                       | - fast-watcher-live-refresh (20s)  |
                                       +------------------------------------+

  (*) broker-hunter-indexes and bandarmologi-intel-indexes are the only
      data/ subtrees force-included in git (.gitignore:106-109) so that the
      serverless deployment has a baked, non-writable artifact to serve.
      data/arjum-data is NOT tracked -> deployed instances have no per-date
      broker-summary history.
```

---

# BAGIAN 3 — CONSOLIDATED DEFECT REGISTER

| # | Defect | Severity | Evidence | Fix locus |
| --- | --- | --- | --- | --- |
| D1 | Explicit `date=` request for an absent file silently returns the newest snapshot under the requested label | High | 11 distinct dates → 1 payload signature; `bs.date` echoes the request ([`lib/bandarmologi-service.js:1843`](lib/bandarmologi-service.js:1843)`-1847`) | return `NO_DATA` (or genuinely fetch that date) instead of substituting `availableDates[0]`, and never label data with an unverified date |
| D2 | Multi-day ranges are multiplied single days, not aggregations, whenever disk history is short | High | BBCA ratios exactly ×5/×22/×44 ([`lib/bandarmologi-service.js:1645`](lib/bandarmologi-service.js:1645)) | fail closed (`is_empty` / `INSUFFICIENT_HISTORY`) rather than synthesise |
| D2b | Real aggregation windows extend beyond available/settled data (CUAN 30d ends `2026-09-15`, a future non-trading date) | High | CUAN range probe in Temuan #3a ([`lib/bandarmologi-service.js:1321`](lib/bandarmologi-service.js:1321)) | clamp the window to dates that actually have files, using the trading calendar |
| D3 | VPS bridge refill is dead on Linux because it hard-codes `curl.exe`; missing dates can never self-heal | High | `execFileSync('curl.exe')` at [`:96`](lib/vps-data-fetcher.js:96) and [`:166`](lib/vps-data-fetcher.js:166); bridge verified healthy at HTTP 200 | resolve the curl binary per-platform (`curl`/`curl.exe`) or drop the shell-out for `fetch` |
| D3b | `available_dates` exposes raw filesystem coverage; per-ticker depth is inconsistent and unvalidated | High | prod BBCA=1 vs CUAN/PTRO/PSAB/TKIM/TLKM/ASII=172 ([`lib/bandarmologi-service.js:145`](lib/bandarmologi-service.js:145)`-154`) | advertise only a validated, complete history window, not a directory listing |
| D4 | Intel `current_price` falls back to an abandoned July OHLCV candle | High | CUAN 630 vs live VWAP 914 ([`lib/bandarmologi-intel-service.js:353`](lib/bandarmologi-intel-service.js:353)`-381`) | treat OHLCV older than the newest broker-summary date as unusable, not merely "outlier-checked" |
| D5 | Fallback OHLCV fetch writes into a gitignored dir, so a local dev run cannot fix production | Medium | `data/daytrade-ohlcv-cache/` at [`.gitignore:46`](.gitignore:46) | keep prices out of a non-deployable path, or resolve at request time |
| D6 | `14d` and `30d` produce identical membership | Medium | prod S1 sets equal (8 tickers) | regenerate distinct per-range indices |
| D7 | No exchange-break awareness in `getRunMode` (12:00–13:00 Mon–Thu classified as active) | Low | [`:128`](lib/daytrade-screener-engine.js:128) vs [`lib/intraday-volume-pace.js:48`](lib/intraday-volume-pace.js:48) | reuse the volume-pace schedule |
| D8 | Radar/Early-Watch/Confirmed all deliver to the same public chat (no per-signal channel) | Low | [`lib/intraday-fast-watcher-radar-publisher.js:270`](lib/intraday-fast-watcher-radar-publisher.js:270) | add per-type chat env vars if product requires separation |
| D9 | `loadUniverseTickers` references an undefined `db` symbol | Low (dead path) | [`lib/bandarmologi-intel-service.js:442`](lib/bandarmologi-intel-service.js:442) — `db` is never imported in that module | remove or wire the fallback |
| D10 | "updated_at" is a build timestamp rendered as if it were a trading date | Low | [`lib/bandarmologi-intel-service.js:1480`](lib/bandarmologi-intel-service.js:1480), UI guard at [`public/bandarmologi-runtime.js:4802`](public/bandarmologi-runtime.js:4802) | keep precedence `effective_date > date > updated_at` (already partly done) |

---

# BAGIAN 4 — VERIFICATION BASIS

Everything above was produced without modifying production code. Probe scripts are committed under [`tmp_investigasi/`](tmp_investigasi:1) and were executed read-only:

| Probe | Purpose | Raw output |
| --- | --- | --- |
| `tmp_investigasi/probe-dates.js` | local API truth (disk cache present) | inline stdout |
| `tmp_investigasi/probe-nodeploy.js` | simulated serverless (`ARJUM_DATA_DIR` → empty temp dir, no SSH key) | inline stdout |
| `tmp_investigasi/probe-vps-bridge.js` | ground truth per-date data from the VPS bridge | inline stdout |
| `tmp_investigasi/probe-prod.js` | deployed endpoint flags across ranges | inline stdout |
| `tmp_investigasi/probe-prod2.js` | deployed payload provenance | `tmp_investigasi/prod2.txt` |
| `tmp_investigasi/probe-prod3.js` | per-ticker date counts, explicit-date matrix | `tmp_investigasi/prod3.txt` |
| `tmp_investigasi/probe-prod4.js` | per-date payload fingerprints + ticker-view vs scanner-view | `tmp_investigasi/prod4.txt` |
| `tmp_investigasi/probe-forensic2.js` | price provenance + range identity | `tmp_investigasi/forensic2.txt` |
| `tmp_investigasi/probe-final.js` | scaling ratios + per-range scanner sets | `tmp_investigasi/final.txt` |
| `tmp_investigasi/probe-fake.js` | proof that per-date snapshots are identical | `tmp_investigasi/fake.txt` |
| `tmp_investigasi/probe-drift.js` | deployed frontend vs HEAD parity | `tmp_investigasi/drift.txt` |
| `tmp_investigasi/probe-static.js` | is `data/` publicly reachable (all 404) | `tmp_investigasi/static.txt` |
| `tmp_investigasi/probe-dates-source.js` | per-ticker date counts vs explicit-date payloads (CUAN/PTRO/TLKM/ASII had 172 dates but empty payloads) | `tmp_investigasi/dates-source.txt` |
| `tmp_investigasi/probe-nosnapshot.js` | response shape with vs without a shipped snapshot (BBCA len 1 / CUAN len 172) | `tmp_investigasi/nosnapshot.txt` |
| `tmp_investigasi/probe-cuan-dates.js` | CUAN explicit dates + multi-day labels (`2026-09-09 s/d 2026-09-15`) | `tmp_investigasi/cuan-dates.txt` |

Deployment-drift check (rules out "the UI is just stale JS"): the production `bandarmologi-runtime.js` is **305,351 bytes, byte-length identical to the working tree**, and contains the PR2/PR3 fix markers. The frontend and the backend being audited here are therefore the same revision, and the anomalies are genuine logic/data defects, not a stale bundle.

Claims deliberately **not** made, because the evidence did not support them:
- Which operator or machine uploaded the untracked `data/arjum-data/broker-summary/**` files into the deployment (requires Vercel build logs).
- Why BBCA's deployed directory holds one dated file while six other sampled tickers hold 172 — consistent with per-ticker partial uploads, but not directly observable from outside.
- Whether the identical per-date payload reflects a single copied file or a build-time cache reuse — both produce the observed signature; distinguishing them needs filesystem access to the deployed instance.

Corrections applied during this audit, recorded for transparency:
- The first draft of Temuan #1 claimed `available_dates` was *overwritten* by a `[vpsRaw.date]` fallback. That was **wrong**: the fallback only triggers when the list is empty ([`lib/bandarmologi-service.js:2090`](lib/bandarmologi-service.js:2090)), and `action=available-dates` independently returns the same small list, proving the list itself is short. Temuan #1 now rests on the verified cause — a raw per-ticker directory listing plus a broken Linux refill path.
- The first draft attributed the identical per-date payload to the VPS-tunnel branch. The payload instead comes from the local-disk fallback at [`:1842`](lib/bandarmologi-service.js:1842)`-1847`.
