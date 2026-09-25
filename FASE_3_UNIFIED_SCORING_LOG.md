# FASE 3 — UNIFIED SCORING ENGINE (0-100)

**Tanggal:** 2026-09-25
**Status:** ✅ DEPLOYED & VERIFIED
**VPS:** ubuntu@168.110.221.197 · `/home/ubuntu/auto-cuan`

---

## Ringkasan

Satu mesin skor tunggal (0-100) menggantikan tiga derivasi skor terpisah, dengan
100% kompatibilitas backward terhadap 159 field kontrak frontend di
`public/index.html` yang terungkap pada audit Fase 1-2.

| Sebelum | Sesudah |
|---|---|
| DT card baca `daytrade_score`, KG/NK card baca `score`, Top5 baca `combined_score` — **bisa beda angka** | Semua alias diisi dari satu nilai `unified_score` |
| Telegram hitung sendiri via `computeTelegramConvictionScore` | Telegram baca `unified_score` langsung |
| Rasio volume 3 alias terpisah (Bug #1) → card lain tampil `-` | Ketiga alias diisi dari satu nilai hasil resolve |
| Bandarmologi = bonus aditif (`score + bandar_score_bonus`) | Bandarmologi = komponen 25 pt dari skor terpadu |

---

## LANGKAH 1 — `lib/unified-score.js` (BARU, 780 baris)

### Bobot (total = 100)

| Komponen | Bobot | Sumber Field |
|---|---|---|
| Likuiditas | **15 pt** | `value_today` / `tx_value_1d` / `avg_value_7d` |
| Volume & Arjum Pace | **20 pt** | `volume_ratio_20d` / `volume_ratio` / `volume_ratio_avg20` / `volume_pace` |
| Bandarmologi CR3/CR5 & Akumulasi | **25 pt** | `bandarmologi_metrics.cr3/cr5`, `bandar_label`, `bandar_consistent_windows` |
| Foreign Flow 1D/3D/7D | **15 pt** | `foreign_1d`, `foreign_3d`, `foreign_7d`, `foreign_label` |
| Price Action / MA20 / MA50 / Candle | **15 pt** | `last_price`, `ma20`, `ma50`, `rsi14`, `change_pct` |
| Risk / Reward Asymmetry | **10 pt** | `risk_reward` / `rr` / `rr_to_tp1` |

### Hard Penalty

| Kondisi | Penalti |
|---|---|
| Distribusi Bandar (`bandar_label === 'Distribution'` atau net flow negatif) | **-25** |
| Retail Trap (retail net buy saat institusi net sell, atau narasi "ritel serok") | **-20** |
| Overextended (chase > 5%, ARA hit, atau `execution_reality_status` NEAR_ARA/ARA_HIT) | **-15** |

### Prinsip Desain
- **Pure & deterministik** — tanpa I/O, tanpa jam, tanpa random.
- **Data hilang = netral, bukan hadiah.** Komponen tanpa input = 0 pt dan ditandai
  `available: false`; gangguan data tidak bisa menaikkan ticker jadi BUY.
- **Setiap poin dapat dilacak** ke nama rule di `breakdown`.
- Ambang likuiditas disamakan dengan gate server (DT 1 M, Konglo 5 M, NK 10 M).

---

## LANGKAH 2 — Layer Kompatibilitas Backward

`applyUnifiedScore(row)` menulis:

```js
// 1. Sinkronisasi field skor
stock.unified_score = score;
stock.score         = score;   // dibaca KG & NK card
stock.daytrade_score= score;   // dibaca DT card
stock.combined_score= score;   // dibaca Top 5

// 2. Solusi Bug #1 — rasio volume
stock.volume_ratio_20d   = volRatio;  // DT card
stock.volume_ratio       = volRatio;  // KG/NK card
stock.volume_ratio_avg20 = volRatio;  // tabel
```

**Jaminan:**
- **Tidak pernah menghapus key.** Field trading plan & bandarmologi dibaca, tidak
  ditulis ulang — `normalizeDisplayLevels()` dan badge bandar tetap bekerja.
- **Idempoten.** Dijalankan dua kali menghasilkan nilai sama.
- **Tidak mengarang data.** Rasio volume hanya ditulis bila berhasil di-resolve.
- `score_before_unified` menyimpan angka pra-unified sekali saja.

### ⚠️ Penanganan Khusus: Formula Bandar Aditif Lama

Card Konglo/NK mencetak `Score: 82 (Base: 78 + Bandar: +4)`. Karena bandarmologi
kini komponen 25 pt (bukan bonus), rumus itu **tidak lagi menjumlah dengan benar**
(78 + 4 ≠ 85) dan card akan menampilkan aritmetika yang salah.

**Solusi:** nilai lama diarsipkan, field yang dibaca frontend dinetralkan:
```js
row.legacy_score_before_bandarmologi = 78;   // arsip audit
row.legacy_bandar_score_bonus        = 4;    // arsip audit
row.score_before_bandarmologi        = null; // card menyembunyikan rumus
row.bandar_score_bonus               = 0;    // badge tabel sembunyi mulus
```
Bisa dinonaktifkan via `applyUnifiedScore(row, { archiveLegacyBandarBreakdown: false })`.

---

## LANGKAH 3 — Sinkronisasi Telegram

| Lokasi | Perubahan |
|---|---|
| `api/sector-hot.js` → `getTelegramScore()` | Baca `unified_score` lebih dulu |
| `api/sector-hot.js` → `computeTelegramConvictionScore()` | **Short-circuit**: `if (unified !== null) return unified;` — tanpa penyesuaian lanjutan, agar tidak muncul drift baru |
| `lib/telegram-interactive-bot.js` → `formatScanCard()` | `row.unified_score ?? row.score ?? row.fusion_score` |
| `lib/telegram-interactive-bot.js` → payload `/opini` | Precedence sama |
| `lib/telegram-templates.js` | `r.unified_score \|\| r.conviction_score \|\| ...` |

Fallback ke field lama dipertahankan untuk snapshot tersimpan yang dibuat sebelum
mesin unified ada.

---

## Titik Integrasi Pipeline

| Fungsi | Lokasi | Cakupan |
|---|---|---|
| `enrichConfluenceRows()` | `api/sector-hot.js:3160` | Swing Konglo + Non-Konglo + Day Trade |
| Top 5 row-assembly | `api/sector-hot.js:7901` | Dashboard Top 5 |

Keduanya memanggil `unifiedScore.applyUnifiedScore(r, { mode })` **setelah**
`enrichCandidateWithBandarmologi` (agar CR3/CR5 & verdict bandar tersedia sebagai
input). Dijaga oleh test `the unified score is applied after bandarmologi enrichment`.

---

## LANGKAH 4 — Verifikasi

### Test Suite

| Suite | Hasil |
|---|---|
| `test/unified-score.test.js` | **37 pass** — matematika, penalti, alias, arsip legacy, sweep 400 kombinasi rekonsiliasi |
| `test/unified-score-integration.test.js` | **19 pass** — wiring pipeline, paritas Telegram, preservasi kontrak frontend |
| **Total baru** | **56 pass / 0 fail** (lokal & VPS identik) |
| Full regression (552 file) | Hanya `pm2-ecosystem-config.test.js` gagal — **PRE-EXISTING**, lihat catatan di bawah |

### Verifikasi Live di VPS (17/17 PASS)

```
PASS  unified_score === score
PASS  unified_score === daytrade_score (DT card)
PASS  unified_score === combined_score (Top5)
PASS  volume_ratio_20d === volume_ratio
PASS  volume_ratio === volume_ratio_avg20 (table)
PASS  score in 0-100
PASS  plan entry_low / stop_loss / tp1 / tp2 / risk_reward intact
PASS  bandar_label intact
PASS  legacy base + bonus archived
PASS  legacy formula neutralised (card hides it)
PASS  breakdown present
PASS  raw arithmetic persisted
PASS  raw + penalties reconciles to score
```

Contoh keluaran nyata (BBCA):
```
score=69  grade=B  raw=68.90674972314507  penalties=0
  liquidity     15.00  Nilai Rp80.00 M vs gate Rp5.00 M (100%)
  volume         6.40  Volume 1.80x vs MA20
  volume         6.67  Pace volume 1.80x
  bandarmologi  10.00  CR3 65.0%
  bandarmologi   4.40  CR5 82.0%
  bandarmologi   8.00  Bandar akumulasi
```

### PM2 (setelah `pm2 restart all --update-env && pm2 save`)

| Proses | Memori | Status |
|---|---|---|
| auto-cuan-vps-api | 59.7mb | online |
| auto-cuan-ai-eval-supervisor | 67.7mb | online |
| auto-cuan-local-app | 61.1mb | online |
| autocuan-bot | 71.8mb | online |
| autocuan-verify-bot | 89.4mb | online |
| autocuan-web-tunnel | 60.9mb | online |

**6 proses ONLINE · total 410.7mb · max 89.4mb (semua < 100MB) · `pm2 save` sukses**

---

## File yang Diubah / Dibuat

| File | Aksi |
|---|---|
| `lib/unified-score.js` | **BARU** — mesin skor |
| `test/unified-score.test.js` | **BARU** — 37 test |
| `test/unified-score-integration.test.js` | **BARU** — 19 test |
| `api/sector-hot.js` | +require, +2 call site, `getTelegramScore` & `computeTelegramConvictionScore` baca unified |
| `lib/telegram-interactive-bot.js` | 2 lokasi prefer `unified_score` |
| `lib/telegram-templates.js` | prefer `unified_score` |
| `tools/curated-build-tests.json` | +2 entri (wajib, jika tidak build gagal) |
| `tools/build-smoke-tests.json` | +1 entri |

### Rollback
Backup lengkap: `/home/ubuntu/fase3-backup-20260925-191607` (dicatat di
`/home/ubuntu/fase3-last-backup.txt`).

---

## ⚠️ Catatan Penting

### 1. Kegagalan test PRE-EXISTING (bukan dari Fase 3)
`test/pm2-ecosystem-config.test.js` gagal dengan `5 !== 3`.
- `ecosystem.config.js` sekarang punya **5 app** (`+autocuan-web-tunnel`, `+autocuan-verify-bot`),
  test masih mengharapkan 3.
- File `ecosystem.config.js` dimodifikasi **2026-09-25T11:34:47Z**, sebelum sesi Fase 3 dimulai (11:47Z).
- Tidak ada referensi `unified` di file tersebut.
- **Perlu keputusan terpisah**: perbarui ekspektasi test jadi 5, atau kurangi app di ecosystem.

### 2. Perubahan FASE 2 di VPS tidak tersentuh
VPS punya pekerjaan FASE 2 yang belum di-commit (`lib/public-web-base.js`,
tunnel-aware register base, identitas `AutoCuanVerificationBot`). Diverifikasi
byte-identical dengan salinan lokal sebelum deploy, dan dikonfirmasi masih utuh
setelah deploy (3 marker terdeteksi).

### 3. Cache screener akan terisi `unified_score` pada run berikutnya
Data screener yang tersimpan saat ini belum memuat `unified_score` (wajar — engine
baru aktif setelah deploy). Field akan muncul otomatis pada refresh screener
terjadwal berikutnya. Fallback di Telegram membuat card lama tetap tampil normal.

### 4. `unified_score_raw` disimpan penuh presisi
Sengaja **tidak** dibulatkan 2 desimal seperti `raw_score` di objek hasil, karena
pembulatan bisa menggeser penjumlahan melewati batas .5 dan membuat
`raw + penalties` tidak rekonsiliasi dengan skor akhir. Dijaga oleh test sweep
400 kombinasi.
