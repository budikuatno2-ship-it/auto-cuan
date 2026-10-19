# LAPORAN PERBAIKAN DARURAT — 19 Oktober 2026

Branch: `fix/daytrade-producer-20261019` (dari `feat/daytrade-screener-v1`)
PR: https://github.com/budikuatno2-ship-it/auto-cuan/pull/898
**Tidak ada merge ke `main`. Logika bisnis (score, gate, Top 5) tidak diubah.**

Sumber temuan: `backtest/arjum-audit/REPORT_CEK_SEMUA_CRON_20261019.md`.

---

## 1. Ringkasan Status

| # | Item | Status | Commit | Test |
|---|------|--------|--------|------|
| 1 | DayTrade producer mati 6 sesi | **FIXED** | `e84f1260` | 15/15 PASS |
| 2 | Backfill candle `universe: 0` | **FIXED** | `fd2fc658` | manual: 963 |
| 3 | Backfill broksum halt karena 1× 502 | **FIXED** | `3100bf3d` | 16/16 PASS |
| 4 | Swing Konglo/Non-Konglo `STALE_SNAPSHOT` | **DIAGNOSED + FIXED** | `5cdf4fb4` | 7/7 PASS |
| 5 | J2 candle tidak punya log | **FIXED** | `fd2fc658` | — |

`npm run test:full`: **705/705 file test PASS**.

---

## 2. #1 — DayTrade Producer Mati Sejak 13 Okt

### 2a. Investigasi asal `timeoutGuard`

```
git log -S timeoutGuard -- api/sector-hot.js
→ 6611c141  (12 Okt 2026, 20:33)
```

Commit `6611c141` memasang `setTimeout(..., 3500)` global yang menjawab
`{success:true,data:[],rows:[]}` untuk **semua** action. Tujuannya: menghentikan
dashboard yang menggantung (504) saat endpoint lambat. Masalah lama yang
diperbaiki: **dashboard 504 / request menggantung**.

### 2b. Rantai kegagalan

1. `daytrade-screener-run` butuh **>3.5 detik** (sapu universe penuh).
2. Guard menjawab 200 dengan `{success:true,data:[],rows:[]}` — **tanpa `status`**.
3. Producer membaca `last.status` → `''` → melempar
   `Unexpected DayTrade producer status: missing` → abort tiap 15 menit.
4. Materialiser malam menulis 0 baris menimpa snapshot sehat.

### 2c. Perbaikan

| Bagian | Perubahan |
|--------|-----------|
| Guard (`api/sector-hot.js`) | `isHeavyComputeAction()` + `HEAVY_COMPUTE_ACTIONS` (`daytrade-screener-run`, `nk-screener-run`, `refresh-screener`, `refresh`) **dikecualikan** dari guard. Fix 504 tetap berlaku untuk read normal. |
| Producer (`tools/run-daytrade-intraday-producer.js`) | `isTransientStatus()` — status `''`/`unknown`/`missing`/`null` = **transient**. Retry batch yang sama dengan backoff `[1000, 3000, 8000, 15000, 30000]` ms, dibatasi `maxBatches`. |
| Snapshot | `shouldRejectEmptySnapshot({ok:true,rows:0})` → `true` → snapshot lama **dipertahankan**, tidak ditimpa 0 baris. |
| Alarm (`lib/daytrade-snapshot-alarm.js`) | Bila snapshot DayTrade >2 jam saat jam bursa → **1** pesan Telegram ke admin. Sekali per insiden (cooldown 6 jam, state `data/daytrade-snapshot-alarm.json`). |

### 2d. Test

`test/daytrade-producer-timeout-guard.test.js` — **15/15 PASS**:
- heavy action dikenali & bebas guard
- heavy set dan read-only set tetap disjoint
- klasifikasi transient (termasuk `null`)
- backoff terbatas (tidak melebihi 30s)
- retry batch yang sama, bukan batch baru
- menyerah setelah batas, bukan hang
- tolak snapshot 0 baris
- alarm: senyap saat pasar tutup / snapshot segar / dalam cooldown
- alarm: menyala saat snapshot basi
- `send()` tidak pernah melempar

### 2e. Verifikasi produksi

Dijalankan setelah deploy (lihat §6).

---

## 3. #2 — Backfill Candle `universe: 0`

**Akar masalah:** cron memanggil skrip dengan path absolut **tanpa `cd`**, jadi
`process.cwd()` = `/home/ubuntu`. Resolusi path berbasis cwd menunjuk ke
`/home/ubuntu/data/...` yang tidak ada → universe kosong.

**Perbaikan:**

| File | Perubahan |
|------|-----------|
| `tools/backfill-historical-candles.js` | `findBrokerSummaryDir()` berjalan naik mencari `package.json`, mulai dari `process.argv[1] \|\| require.main?.filename \|\| __filename`. |
| `tools/fetch-daily-candles.js` | Path cache candle di-anchor ke `path.join(__dirname, '..', ...)`. |

**Verifikasi:** dijalankan dari cwd `/home/ubuntu` dengan `--dry-run` →
**`universe: 963`** (sebelumnya `universe: 0`).

**Crontab tidak diubah.**

---

## 4. #3 — Backfill Broksum Halt Karena Satu 502

**Akar masalah:** run 00:07 berhenti di 1828 request karena **satu** Cloudflare
502 ("origin overloaded"). Setiap respons tidak valid men-set
`quotaHalted = true` — satu respons buruk bukan masalah kuota.

**Perbaikan (`tools/backfill-broksum.js`):**

1. **Retry 3×** dengan backoff `[2000, 8000, 30000]` ms untuk 5xx/timeout/network.
2. Bila tetap gagal → **skip task** (masuk `providerSkipped[]`, dicoba lagi run
   berikutnya), lanjut ke task berikutnya.
3. **Halt total HANYA bila:**
   - kuota habis atau HTTP **429**
   - **circuit breaker** aktif
   - **5× 5xx berurutan** (`MAX_CONSECUTIVE_5XX`)
4. **Label terpisah:**
   - `HALTED_BY_BUDGET_OR_QUOTA`
   - `HALTED_BY_PROVIDER_ERROR`
   - `HALTED_BY_CIRCUIT_BREAKER`
   - `COMPLETED_OR_LIMITED`
5. Summary mencetak jumlah dan daftar task yang ditunda.

**Test:** `test/backfill-provider-retry.test.js` — **16/16 PASS**.

---

## 5. #5 — J2 Candle Tidak Punya Log

**Perbaikan (`deploy/vps/run-daily-candles.sh`):** wrapper sekarang menulis log
sendiri ke `autocuan-runner/logs/daily-candles.log` dengan penanda
`[J2-CANDLES]` untuk `START`, `SKIP` (lock busy), dan `END rc=<kode>`.
Lokasi konsisten dengan job lain di `autocuan-runner/logs/`.

---

## 6. #4 — Swing Konglo/Non-Konglo `STALE_SNAPSHOT` Sejak 5 Okt

### 6a. Gejala

```
STALE_SNAPSHOT: mode=swing-konglo snapshot=2026-09-30 expected=2026-10-05
                age_sessions=3 reason=STALE_SNAPSHOT
```

Snapshot `data/screener-latest.json` membawa `market_date: 2026-09-30` dan tidak
pernah berubah. Freshness gate membaca field itu lebih dulu → kirim dibatalkan.

### 6b. Generator mana yang berhenti

Rantai produksi:

```
cron 21:30 → run-screeners-preflight.sh
           → [coverage gate: candle hari-T ≥ 95%?]
           → tools/run-all-screeners-vps.js
           → Phase 8: tools/build-screener-snapshot.js → data/screener-latest.json
```

Yang berhenti adalah **Phase 8 (materialisasi snapshot)** — producer tidak pernah
sampai ke sana karena **coverage gate** menunda eksekusi.

### 6c. Sejak commit apa

| Tanggal | Commit | Dampak |
|---------|--------|--------|
| 3 Okt 01:48 | `0b1222a6` *align market history routing to VPS store* | Candle dibaca dari SQLite `stock_daily_history`. |
| 29 Sep | — | **`stock_daily_history` macet** (terdokumentasi di header `lib/daily-history-sqlite-sync.js`). |
| 30 Sep | — | Snapshot terakhir yang berhasil ditulis (`market_date: 2026-09-30`). |
| 13 Okt 09:17 | `acd873e6` *reschedule cron* | Producer digeser 19:00 → 21:30 + **coverage gate 95%** ditambahkan. Gate inilah yang menahan producer setiap malam. |

### 6d. Akar masalah (dua fault teknis bertumpuk)

**A. PATH (utama)** — `lib/daily-history-sqlite-sync.js`:

```js
// SEBELUM
function defaultCandleDir() {
  return process.env.CANDLE_CACHE_DIR || path.join(process.cwd(), 'data', 'daily-candles');
}
```

Cron memanggil koordinator dengan path absolut tanpa `cd`, jadi cwd =
`/home/ubuntu`. Sync mencari `/home/ubuntu/data/daily-candles` (tidak ada) →
`no_candles_found` → **`stock_daily_history` tetap macet di 2026-09-29** →
coverage gate melihat <95% → menunda 4× → menyerah → Phase 8 tidak pernah jalan.

**B. FRESHNESS** — snapshot lama masih membawa `market_date: 2026-09-30` dari
format pra-schema-v2. Builder sekarang **tidak pernah menulis** field itu
(hanya `updated_at` + `source_dates`), jadi nilainya beku selamanya, dan gate
membacanya lebih dulu sebelum `updated_at`.

### 6e. Perbaikan

| File | Perubahan |
|------|-----------|
| `lib/daily-history-sqlite-sync.js` | `defaultCandleDir()` memakai `path.join(__dirname, '..', 'data', 'daily-candles')` — repo-anchored, bukan cwd. |
| `tools/run-daily-market-update.js` | Mengirim `candleDir` eksplisit saat memanggil `syncRecentHistoryToSqlite()`. |
| `lib/snapshot-freshness.js` | `isSchemaV2()` baru; `extractSnapshotDate()` **mengabaikan** `DATE_FIELDS` legacy bila snapshot menyatakan schema v2 / punya `source_dates`. Tanggal per-mode di `source_dates` (dari `run-screener`) yang otoritatif. |

**Logika bisnis tidak disentuh:** formula skor, gate, dan Top 5 identik.

### 6f. Test

`test/swing-snapshot-stale-fix.test.js` — **7/7 PASS**:
- candle dir resolve dari repo walau cwd = tmp
- `CANDLE_CACHE_DIR` eksplisit tetap menang
- snapshot schema-v2 mengabaikan `market_date` legacy
- snapshot legacy (pra-v2) tetap menghormati `market_date`
- `source_dates` tanpa flag versi tetap dianggap v2
- `market_date` basi tidak lagi memaksa `STALE_SNAPSHOT` pada snapshot v2
- tanggal source yang benar-benar basi **tetap** diblokir

Suite existing `snapshot-freshness-gate` + `screener-runner` +
`build-screener-snapshot`: **39/39 PASS**.

---

## 7. Catatan Operasional

- **Vercel check gagal** dengan `Account is blocked` — masalah infra akun
  Vercel, **bukan** regresi kode. Sama seperti PR #891 sebelumnya.
- Crontab **tidak diubah** sama sekali.
- Tidak ada request Arjum tambahan selain trafik job normal.
- `.env`, key, IP VPS, dan lokasi SSH key tidak pernah dicetak.

---

## 8. Verifikasi Produksi

Diisi setelah deploy VPS dan run terjadwal berikutnya:

- [ ] Run DayTrade berikutnya: `status=published`, `snapshot: materialized`, `data/screener-latest.json` segar dengan rows > 0
- [ ] J2 16:40: jumlah saham dari Yahoo, hasil cross-check 20 saham, fallback Arjum, bar IHSG 19 Okt, `.done` 19 Okt
- [ ] Backfill broksum 19:30: status label dan jumlah task ditunda
- [ ] Swing: `source_dates['swing-konglo']` = tanggal hari bursa berjalan
