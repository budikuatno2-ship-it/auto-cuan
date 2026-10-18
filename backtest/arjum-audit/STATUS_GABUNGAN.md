# STATUS GABUNGAN · PROMPT GABUNGAN (FASE 1A, 1B, 1C, 2, 3)

**Tanggal Update Terakhir:** Minggu, 18 Oktober 2026 (21:47 WIB)  
**Branch:** `feat/broksum-all-foreign`  
**Commit Terakhir:** `75ff81bc` (Fase 1A)

---

## 1. Tabel Status Semua Fase

| Fase | Nama | Status | Commit | Jalur Kembali | Catatan |
|---|---|---|---|---|---|
| **1A** | Candle 962 saham dari Yahoo + cek silang | ✅ **SELESAI** | `75ff81bc` ✅ Deployed | Hapus crontab entry + set `CANDLE_SOURCE=arjum` + restart | Sudah terbukti hemat 942 req/hari |
| **1B** | Audit penyimpanan VPS & uji kompresi | ✅ **SELESAI** (read-only) | Tidak ada commit kode | Tidak perlu (tidak ada perubahan) | Format terbaik: `.json.gz` bulanan (92% hemat) |
| **1C** | Rencana kuota 962 saham penuh | ✅ **SELESAI** (perencanaan) | Tidak ada commit kode | Tidak perlu (tidak ada perubahan) | **Minimum: 3.000 req/hari** untuk 962 saham |
| **2** | Akumulasi broker dihitung lokal | ⏸ **DILEWATI** (belum lolos) | Tidak ada commit | Tidak perlu (tidak ada perubahan) | Match rate hanya 96-97% (syarat ≥99%). Uji ulang: **22 Okt 2026** |
| **3** | Simulasi aliran asing + LPM (riset) | ⏸ **DILEWATI** (syarat belum terpenuhi) | Tidak ada commit | Tidak perlu (tidak ada perubahan) | Cakupan F likuid = 13,79% (syarat ≥90%). Bisa jalan: **22 Okt 2026** |

---

## 2. Rincian Setiap Fase

### Fase 1A — ✅ SELESAI & DEPLOYED

**Ringkasan:** Candle 962 saham dari Yahoo Finance dengan cek silang Arjum 20 sampel. IHSG tetap dari Arjum. Sudah aktif di production.

**Commit:** [`75ff81bc`](lib/chart-engine/candle-fetcher.js:1) — `feat(j2): Yahoo candle source for 962 stocks with Arjum cross-check and fallback`

**File Berubah:**
- [`lib/chart-engine/candle-fetcher.js`](lib/chart-engine/candle-fetcher.js:210) — Tambah `fetchDailyCandlesYahoo()`
- [`tools/fetch-daily-candles.js`](tools/fetch-daily-candles.js:24) — Integrasi Yahoo + cek silang + fallback
- [`deploy/vps/final-schedule.cron`](deploy/vps/final-schedule.cron:28) — Entry 16:40 & 23:30 WIB
- [`test/yahoo-candle-j2.test.js`](test/yahoo-candle-j2.test.js:1) — Test baru (5 test)

**Deployed di VPS:**
- Pull ke `/home/ubuntu/auto-cuan` ✅
- Install cron entry (backup di `/home/ubuntu/crontab.backup-before-fase1a-20261018.txt`) ✅
- PM2 restart `autocuan-web` 1x (PID 4181629, online) ✅
- Unit test 5/5 pass di VPS ✅

**Penghematan:** 942 request/hari bursa (4.710/minggu).

**Jalur Kembali (Rollback):**
```bash
# 1. Kembalikan source ke Arjum
echo "CANDLE_SOURCE=arjum" >> /home/ubuntu/auto-cuan-runner/.env
echo "CANDLE_CROSSCHECK=false" >> /home/ubuntu/auto-cuan-runner/.env

# 2. Restart web server (SEKALI)
pm2 restart autocuan-web --update-env

# 3. Hapus 2 cron entry (opsional)
crontab -l | grep -v "run-daily-candles.sh" | crontab -
```

---

### Fase 1B — ✅ SELESAI (READ-ONLY, TIDAK MENGUBAH PRODUKSI)

**Ringkasan:** Audit kapasitas disk & inode VPS + uji 5 format kompresi. Rekomendasi `lib/broksum-store.js` disiapkan tetapi **belum diterapkan** (menunggu persetujuan pemilik).

**Temuan Kunci:**
- Disk: **79 GB tersisa** (19% terpakai) — aman
- Inode: **12,28 juta tersisa** (6% terpakai) — aman
- Disk akan penuh dalam **~6,3 tahun**, inode dalam **~16,8 tahun**
- Format terbaik: **Arsip bulanan `.json.gz`** — hemat 92%, baca 20 hari hanya 4,98 ms

**Laporan:** [`backtest/arjum-audit/REPORT_STORAGE.md`](backtest/arjum-audit/REPORT_STORAGE.md:1)

**Jalur Kembali:** Tidak ada (tidak ada perubahan produksi). Salinan uji `data/_staging/compress-test/` sudah dihapus.

---

### Fase 1C — ✅ SELESAI (PERENCANAAN)

**Ringkasan:** Cek endpoint insider massal (tidak ada) + tabel kuota minimum untuk 962 saham penuh.

**Temuan Kunci:**
- **Tidak ada endpoint insider massal.** Hanya `/api/insiders/{code}` per emiten (maks 15 item).
- **Kuota 1.000/hari TIDAK CUKUP** untuk 962 saham penuh tanpa mengurangi cakupan.
- **Kuota 2.000/hari TIDAK CUKUP** (kurang ~500).
- **Kuota 3.000/hari adalah MINIMUM REALISTIS** untuk 962 saham penuh + insider rolling 3 hari.
- **Kuota 7.020/hari** adalah rentang aman dengan insider penuh harian.

**Laporan:** [`backtest/arjum-audit/REPORT_KUOTA_962.md`](backtest/arjum-audit/REPORT_KUOTA_962.md:1)

**Penjaga Kode (Usulan):** Modul `lib/quota-guard.js` yang mengirim peringatan ke Admin Console + Telegram admin tanpa mengurangi cakupan otomatis. **Belum diterapkan — menunggu persetujuan.**

---

### Fase 2 — ⏸ DILEWATI (BELUM LOLOS UJI)

**Alasan Dilewati:** Uji paritas akumulasi lokal mencapai **96-97%** match rate, sedangkan syarat lolos ≥ **99%**.

**Pre-condition yang Terpenuhi:** ✅ 10 saham uji sudah memiliki 80 hari penuh unclipped all.

**Akar Penyebab Kegagalan (3 tanggal sistematis):**
1. **`2026-09-04` BBCA**: file `broker-summary/BBCA/2026-09-04.json` kosong (`brokers: []`, `broker_levels: []`) sedangkan 9 ticker lainnya normal.
2. **`2026-09-11`**: file hanya berisi 74 broker dengan ukuran 47.621 B (separuh dari ukuran normal 98.063 B). Nilai BK berbeda dari API autentik sebesar -314,6 M.
3. **`2026-09-25`**: file hanya berisi 60 broker dengan ukuran 39.939 B (separuh dari normal). Nilai BK berbeda -13,3 M.

**Estimasi Uji Ulang:** **Kamis, 22 Oktober 2026** (backfill akan melewati tanggal 11 dan 25 Sep untuk saham likuid).

**Laporan:** [`backtest/arjum-audit/REPORT_ACCUM_LOCAL.md`](backtest/arjum-audit/REPORT_ACCUM_LOCAL.md:1)

**Perintah Uji Ulang Siap Tempel:**
```bash
cd /home/ubuntu/auto-cuan
node tools/check-accum-parity.js
# Jika match rate ≥99%:
cp /home/ubuntu/auto-cuan-runner/.env /home/ubuntu/auto-cuan-runner/.env.before-accum-local
sed -i 's/^ACCUM_SOURCE=.*/ACCUM_SOURCE=local/' /home/ubuntu/auto-cuan-runner/.env
pm2 restart autocuan-web --update-env
```

**Jalur Kembali:**
```bash
cp /home/ubuntu/auto-cuan-runner/.env.before-accum-local /home/ubuntu/auto-cuan-runner/.env
pm2 restart autocuan-web --update-env
```

---

### Fase 3 — ⏸ DILEWATI (SYARAT BELUM TERPENUHI)

**Alasan Dilewati:** Cakupan F autentik + all unclipped untuk 502 saham likuid hanya **13,79%**, sedangkan syarat ≥ **90%**.

**Status Cakupan:**
- F asli: 13,80%
- All unclipped: 68,50%
- F + all lengkap: **13,79%**

**Saham dengan cakupan 100%:** top 20 likuid sudah lengkap (AADI, ADMR, ADRO, AMMN, AMRT, ANTM, ARCI, ASII, BACH, BBCA, BBNI, BBRI, BIPI, BKSL, BMRI, BNBR, BREN, BRMS, BRPT, BULL, dll.).
**Saham dengan cakupan 0%:** ticker huruf V-Z (VERN, VICI, VISI, VIVA, VTNY, WAPO, WBSA, WEGE, dll.).

**Estimasi Tanggal Bisa Jalan:**
| Kelompok | Perkiraan Tanggal |
|---|---|
| Top 100 likuid | Selasa, 20 Okt 2026 |
| **502 likuid ≥90%** | **Kamis, 22 Okt 2026** |
| 962 saham ≥90% | Minggu, 2 Nov 2026 |

**Laporan:** [`backtest/foreign-flow/REPORT_FOREIGN_LPM.md`](backtest/foreign-flow/REPORT_FOREIGN_LPM.md:1)

**Jalur Kembali:** Tidak ada (tidak ada perubahan produksi).

---

## 3. Ringkasan Perubahan Produksi

| Komponen | Perubahan | Backup |
|---|---|---|
| **Code** | `lib/chart-engine/candle-fetcher.js`, `tools/fetch-daily-candles.js` | Git (branch) |
| **Crontab** | 2 entry baru (16:40 & 23:30 WIB) | `/home/ubuntu/crontab.backup-before-fase1a-20261018.txt` |
| **Env** | Tidak ada perubahan (default `CANDLE_SOURCE=yahoo` di code) | — |
| **PM2** | `autocuan-web` restart 1x (PID 4181629) | — |
| **Data** | Tidak ada data dihapus | Salinan uji dihapus |

---

## 4. Jalur Kembali Menyeluruh (Full Rollback)

Jika perlu rollback semua perubahan Fase 1A:

```bash
# 1. Rollback code ke commit sebelum Fase 1A
cd /home/ubuntu/auto-cuan
git checkout 81ef681e -- lib/chart-engine/candle-fetcher.js tools/fetch-daily-candles.js

# 2. Restore crontab dari backup sebelum Fase 1A
crontab /home/ubuntu/crontab.backup-before-fase1a-20261018.txt

# 3. Restart web server
pm2 restart autocuan-web --update-env

# 4. Verifikasi
pm2 status
crontab -l | grep -c "run-daily-candles"  # harus 0
curl -s "http://127.0.0.1:3000/api/candles?ticker=IHSG" | head -c 100
```

---

## 5. Daftar Berkas Laporan Detail

| Laporan | Path |
|---|---|
| Fase 1A: Yahoo Candle | [`backtest/arjum-audit/REPORT_YAHOO_CANDLE.md`](backtest/arjum-audit/REPORT_YAHOO_CANDLE.md:1) |
| Fase 1B: Storage | [`backtest/arjum-audit/REPORT_STORAGE.md`](backtest/arjum-audit/REPORT_STORAGE.md:1) |
| Fase 1C: Kuota 962 | [`backtest/arjum-audit/REPORT_KUOTA_962.md`](backtest/arjum-audit/REPORT_KUOTA_962.md:1) |
| Fase 2: Akumulasi Lokal | [`backtest/arjum-audit/REPORT_ACCUM_LOCAL.md`](backtest/arjum-audit/REPORT_ACCUM_LOCAL.md:1) |
| Fase 3: Foreign + LPM | [`backtest/foreign-flow/REPORT_FOREIGN_LPM.md`](backtest/foreign-flow/REPORT_FOREIGN_LPM.md:1) |
| Analisis Hemat Kuota | [`backtest/arjum-audit/REPORT_HEMAT_KUOTA.md`](backtest/arjum-audit/REPORT_HEMAT_KUOTA.md:1) |

---

## 6. Perintah yang Perlu Dijalankan Nanti

| Tanggal | Aksi | Perintah |
|---|---|---|
| **22 Okt 2026** | Uji ulang Fase 2 | `node tools/check-accum-parity.js` |
| **22 Okt 2026** | Cek syarat Fase 3 | `node tools/check-fase3-condition.js` |
| **22 Okt 2026** | Jika Fase 3 jalan | Buat `backtest/foreign-flow/f0_data_definitions.js` dkk |
| **Setiap hari** | Cek log Yahoo | `tail -n 50 /home/ubuntu/auto-cuan-runner/logs/daily-candles.log` |

---

## 7. Catatan Jujur

1. **Fase 2 belum lolos** meski precondition terpenuhi. Ini karena 3 tanggal bermasalah (11 & 25 Sep file separuh ukuran, 4 Sep kosong). Bukan bug perhitungan, melainkan defek data lama. Backfill akan menutupi ini.
2. **Fase 3 belum bisa jalan** karena cakupan F likuid 13,79% (jauh dari syarat 90%).
3. **Fase 1B menyarankan kompresi `.json.gz` bulanan** tetapi **tidak dijalankan** karena menunggu persetujuan pemilik.
4. **Fase 1C menyarankan kuota minimum 3.000/hari** untuk operasional penuh 962 saham tanpa pengurangan cakupan.
5. **0 request Arjum terpakai** dalam audit ini (semua pembacaan dari disk lokal).
