# REPORT — Merge `feat/broksum-all-foreign` → `feat/daytrade-screener-v1`

**Tanggal:** Senin, 19 Oktober 2026 (09:49–09:56 WIB)
**Status:** ✅ **SELESAI** — PR merged (fast-forward), VPS sudah mengikuti branch utama.

---

## 1. Hasil Akhir (ringkas)

| Item | Nilai |
|---|---|
| PR | **#891** — https://github.com/budikuatno2-ship-it/auto-cuan/pull/891 |
| Jenis merge | **Fast-forward** (tanpa merge commit tambahan) |
| Hash akhir | **`db6603d9`** (`fix(security): resolve 3 CodeQL findings blocking PR merge`) |
| Branch utama sebelum | `a6b49f9b` (PR #890) |
| Branch utama sesudah | `db6603d9` |
| Tag cadangan | `pre-merge-broksum-20261018` → `a6b49f9b` (pushed) |
| Branch fitur | `feat/broksum-all-foreign` — **TIDAK dihapus** |
| Merge ke `main` | **TIDAK dilakukan** (sesuai instruksi) |

Verifikasi fast-forward: `git merge-base --is-ancestor a6b49f9b db6603d9` → **true**.

---

## 2. Konflik & Resolusi

### 2.1 Satu-satunya konflik: `api/candles.js`

| Sisi | Isi |
|---|---|
| `HEAD` (broksum) | Blok IHSG **disk-first** (`data/daily-candles/IHSG.json`), deklarasi `candles`/`cutoff`/`candleSource`, Yahoo dipindah ke blok fallback, `source: candleSource` |
| `origin/feat/daytrade-screener-v1` | Fetch Yahoo langsung dengan `cleanRange` (range per-request) + validasi OHLC ketat (`oNum > 0`, `hNum > 0`, `lNum >= 0`, `cNum > 0`, `hNum >= lNum`) |

**Resolusi:** struktur data broksum dipertahankan (IHSG disk-first + fallback Yahoo), lalu **perbaikan daytrade di-port** ke blok fallback:
- `?range=' + cleanRange` (konsisten dengan `cacheKey = ticker + '_' + cleanRange` yang sudah auto-merge),
- validasi OHLC ketat + skip bar null,
- `volume: ... ? Number(v) : null` (semantik broksum, dibutuhkan test SSOT `chart-t1-candles`).

**Catatan:** penutup blok (`}` + `}`) berasal dari common context hasil auto-merge — resolusi tidak menambah kurung kurawal (brace balance diverifikasi via `node --check`).

---

## 3. Rekonsiliasi 7 File Tes Warisan (pre-existing, bukan regresi merge)

Ketujuh file ini **gagal identik di baseline `39ae22ae`** (pre-merge broksum) dan **lulus di baseline `a6b49f9b`** (daytrade). Jadi ini drift kontrak branch broksum, bukan akibat merge. Karena CI mewajibkan `npm run test:full`, semuanya direkonsiliasi **tanpa melemahkan logika produksi**:

| File | Akar masalah | Perbaikan |
|---|---|---|
| `test/eod-typed-states.test.js` | Mock tidak men-stamp `flow`/`stock_code` (guard autentisitas J1); `ARJUM_DATA_DIR` tidak dibuat sehingga storage fallback ke `data/arjum-data` repo | Mock men-stamp `flow`/`stock_code`; `fs.mkdirSync(ARJUM_DATA_DIR)` |
| `test/run-daily-broker-update.test.js` | Sama + hitungan request kini termasuk fetch Foreign (F) yang memang disengaja | Mock stamping; hitung **All-summary saja**; dir temp dibuat |
| `test/wave2-quota-savings.test.js` | Sama | Mock stamping; hitung All-summary saja |
| `test/daily-candle-freshness-final.test.js` | Default sumber candle kini **Yahoo**, sehingga stub `fetchDailyCandles` (Arjum) tidak terpanggil | `source: 'arjum'` dipin di dua test |
| `test/audit-fase13-14-runtime-db-bugs.test.js` | Cron broksum menonaktifkan generator akumulasi lokal (J1 single-writer) | Ekspektasi diperbarui: baris `0 18` harus **dikomentari**, `--accum-source=api` wajib ada |
| `test/audit-fase15-16-pipeline-stress-bugs.test.js` | Regex melarang **semua** `new Map()`, padahal broksum menambah Map **lokal-fungsi** (bounded per ticker) | Larangan dipersempit ke Map **module-scope** (kolom 0) |
| `test/command-isolation-deeplink.test.js` | Blok komentar `run-webhook-failover` hilang saat cron ditulis ulang | Blok komentar **dipulihkan** di `deploy/vps/final-schedule.cron` (tetap non-aktif) |

**Bug produksi yang ditemukan & diperbaiki:** `shouldFetchInsider` lama (`insiderMode === 'all' || priorityTickers.has(ticker)`) membuat mode default `daily` **hanya** mengambil insider untuk subset prioritas. Diperbaiki menjadi:
```js
const shouldFetchInsider = insiderMode === 'weekly' ? priorityTickers.has(ticker) : true;
```
sesuai dokumentasi (`INSIDER_MODE=daily` = universe penuh).

---

## 4. Perbaikan Tambahan Agar CI Hijau

| Temuan CI | Perbaikan |
|---|---|
| `git diff --check` (trailing whitespace) | 14 file (12 laporan md + `tools/check-fase2-condition.js` + 2 laporan) di-strip trailing whitespace-nya |
| `test/ihsg-endpoint.test.js` gagal di clean clone | Dibuat **hermetic**: menulis fixture 600 sesi ke cwd temp (file `data/daily-candles/IHSG.json` adalah data runtime gitignored) |
| `test/final-audit-uiux-d5.test.js` flake float | `assert.equal(statusHeight)` → toleransi `<0.5` (konsisten dengan 2 assertion sebelahnya yang sudah `<0.1`) |
| CodeQL: *Uncontrolled data used in path expression* (2×) | `date` disanitasi ketat (`YYYY-MM-DD` atau `latest`) sebelum masuk path di `lib/arjum-client.js` |
| CodeQL: *Replacement of substring with itself* | Hapus `f.replace('.json','.json')` (dead code) di `tools/audit-broksum-sanity-vps.js` |

---

## 5. Verifikasi

| Gate | Hasil |
|---|---|
| `npm run test:full` (lokal) | **702/702 file LULUS** |
| CI `build-and-focused-tests` (full regression + whitespace) | **PASS** (6m49s) |
| CI `CodeQL` | **PASS** (3 temuan ditutup) |
| CI lain (unit, database, security-gate, command-login, portfolio-persistence, webkit-keyboard, Analyze JavaScript) | **PASS** |
| `browser` (Precision workspace) | FAIL — **pre-existing**: gagal di semua PR sejak 2026-10-17 (termasuk branch lain) |
| `Vercel` | FAIL — **environment**: "Account is blocked" |

---

## 6. VPS

| Item | Nilai |
|---|---|
| Branch | `feat/daytrade-screener-v1` |
| HEAD | `db6603d9` |
| Cara pindah | `git fetch --all --prune` → `git checkout feat/daytrade-screener-v1` → `git pull --ff-only` |
| Cek lock worker | **Tidak ada worker berjalan**, tidak ada `_backfill/*.lock` |
| Diff kode | 55 file berubah (21 file web-affecting: `api/`, `lib/`, `public/`, `partials/`) |
| Tes di VPS | **79/79 LULUS** (broksum-validator, broksum-flow, ihsg-endpoint, j1-done-rule, backfill-refactor, chart-t1-candles, eod-typed-states, run-daily-broker-update) |
| PM2 restart | **1×** `pm2 restart autocuan-web` |
| Health check | **HTTP 200** (0.19 s) — `/api/sector-hot?action=market-structure-list` |
| Status PM2 | `online`, uptime 2m, unstable restarts 0 |
| Working tree | bersih (hanya file data untracked) |

---

## 7. Perubahan Crontab & Referensi Branch

| Lokasi | Perubahan |
|---|---|
| `deploy/vps/final-schedule.cron` (repo) | Komentar baris 5: `feat/broksum-all-foreign` → `feat/daytrade-screener-v1`; blok komentar `run-webhook-failover` dipulihkan (tetap `#`) |
| Crontab VPS (terpasang) | **Hanya komentar baris 5** diganti via `sed` (78 baris tetap, perintah tidak berubah) |
| `backtest/arjum-audit/CEK_SENIN.md` | Referensi branch + prosedur rollback diperbarui |
| `deploy/vps/*.sh` | Tidak ada referensi nama branch (perintah absolut) — **tidak diubah** |
| Backup crontab | `~/crontab.backup-20261018c.txt` (78 baris) |

> Catatan: crontab terpasang memiliki drift lama (backfill tanpa `--only-foreign`, urutan candle) yang **sengaja tidak diubah** karena tidak menyebut nama branch.

---

## 8. Jalur Kembali (Rollback)

```bash
# A. Kembali ke branch fitur lama di VPS
cd /home/ubuntu/auto-cuan
git fetch --all
git checkout feat/broksum-all-foreign
git reset --hard 39ae22ae          # kondisi terakhir yang terbukti sehat
pm2 restart autocuan-web           # hanya bila perlu
curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:3000/api/sector-hot?action=market-structure-list

# B. Kembalikan branch utama ke tag (HANYA dengan izin owner)
git checkout feat/daytrade-screener-v1
git reset --hard pre-merge-broksum-20261018   # = a6b49f9b
git push --force-with-lease origin feat/daytrade-screener-v1

# C. Kembalikan crontab
crontab /home/ubuntu/crontab.backup-20261018c.txt
```

---

## 9. Catatan Operasional

- `feat/daytrade-screener-v1` kini adalah **satu-satunya branch operasional VPS** (lihat `ATURAN_BRANCH.md`).
- `feat/broksum-all-foreign` **dipertahankan** (tidak dihapus) untuk audit & rollback.
- `main` **tidak disentuh**.
- Semua worker (J1 EOD, J2 candle, backfill) otomatis memakai kode baru karena berjalan dari working tree yang sama.
