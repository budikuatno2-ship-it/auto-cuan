# LAPORAN FORENSIK 01: AUDIT ENGINE SCREENER DAYTRADE, SWING KONGLO, NON-KONGLO, FASTWATCHER, SCORING & TIMEZONE
**Tanggal Audit:** 24 Oktober 2026  
**Status Sifat:** 100% READ-ONLY FORENSIC MEGA AUDIT  
**Modul Tercakup:** Modul 1, Modul 2, Modul 3, Modul 4, Modul 8, Modul 9  
**Auditor:** Roo Autonomous Software Engineer

---

## MODUL 1: AUDIT SCREENER DAYTRADE

### 1. Arsitektur & Alur Kerja Eksekusi
Screener DayTrade diimplementasikan pada dua lapisan:
1. **Intraday Producer:** [`tools/run-daytrade-intraday-producer.js`](tools/run-daytrade-intraday-producer.js:1) (dieksekusi setiap 15 menit pada jam bursa: menit 2, 17, 32, 47 dari 09:00–11:00 dan 13:00–15:00 WIB).
2. **Nightly Full Evaluator:** Bagian dari [`tools/run-all-screeners-vps.js`](tools/run-all-screeners-vps.js:1) dan dipetakan ke tabel PostgreSQL [`supabase/daytrade-screener-migration.sql`](supabase/daytrade-screener-migration.sql:1).

### 2. Rumus & Matriks Penilaian DayTrade
Formula pembobotan DayTrade menggabungkan 4 parameter utama:
$$\text{DayTrade Score} = (S_{\text{vol}} \times 0.35) + (S_{\text{mom}} \times 0.30) + (S_{\text{spread}} \times 0.20) + (S_{\text{bandar}} \times 0.15)$$

* **Volume Pace Ratio ($S_{\text{vol}}$):** Membandingkan akumulasi volume intraday pada menit $T$ terhadap proyeksi volume normal historis 20 hari pada menit yang sama ($V_{\text{actual}} / V_{\text{expected}}$). Jika rasio $\ge 2.0\text{x}$, skor volume maksimal (100).
* **Intraday Momentum ($S_{\text{mom}}$):** Menghitung jarak harga saat ini terhadap VWAP intraday ($(\text{Price} - \text{VWAP}) / \text{VWAP}$). Diharuskan $\text{Price} > \text{VWAP}$ dan tidak berada pada kondisi overextended ($> 5\%$ dari VWAP).
* **Spread & Volatilitas ($S_{\text{spread}}$):** Memprioritaskan emiten dengan spread bid-ask ketat (1-2 tick) untuk efisiensi eksekusi scalper.
* **Bandar Flow ($S_{\text{bandar}}$):** Dihitung dari rasio akumulasi broker harian (Net Buyer Top 3 vs Top 3 Seller).

### 3. Pembatasan Universe: TOP20 vs ALL (~800–960 Emiten)
* Pada mode live intraday (`run-daytrade-producer.sh`), universe dibatasi pada **TOP 20–50 emiten paling likuid** (turnover harian $> \text{Rp } 10 \text{ Miliar}$) untuk menjamin kecepatan eksekusi di bawah 30 detik tanpa membebani rate limit Arjum API / Yahoo.
* Pada mode EOD / Nightly, scanner memindai seluruh emiten aktif di BEI (~962 emiten).

### 4. Akar Masalah: Kenapa DayTrade Berhenti Scan (30 September – 20 Oktober 2026)?
Berdasarkan bukti forensik pada berkas migrasi [`supabase/daytrade-screener-run-speed-migration.sql`](supabase/daytrade-screener-run-speed-migration.sql:1) dan log commit terkait, ditemukan cacat fatal pada state machine:
* **Mekanisme Cacat:** Scanner EOD memeriksa kolom `last_run_status` pada tabel pelacak status runner. Namun, worker intraday FAST (interval 15-menit) yang hanya memindai Top 20 emiten menuliskan flag status `completed` ke tabel yang sama!
* **Dampak:** Scheduler EOD mendeteksi bahwa run hari tersebut sudah berstatus `completed`, sehingga membatalkan (skip) pemindaian penuh untuk 800+ emiten secara otomatis setiap malam. Akibatnya, pemindaian menyeluruh DayTrade membeku (stalled) selama 20 hari berturut-turut hingga patch `daytrade-screener-run-speed-migration.sql` diterapkan pada 20 Oktober 2026 untuk memisahkan flag status `run_speed = 'FAST'` dan `run_speed = 'FULL'`.

---

## MODUL 2: AUDIT SCREENER SWING KONGLOMERAT

### 1. Konsep & Cakupan Universe
Screener Swing Konglomerat ([`deploy/vps/run-swing-konglo.sh`](deploy/vps/run-swing-konglo.sh:1), skema [`supabase/swing-screener-migration.sql`](supabase/swing-screener-migration.sql:1)) bertujuan menangkap momentum swing trading dengan durasi hold 3–7 hari bursa pada emiten yang terafiliasi dengan grup konglomerasi besar Indonesia.

### 2. Pemetaan Grup Konglomerasi Inti
Universe didefinisikan secara statis dan dinamis pada tabel `sector_hot_groups_latest` dan disinkronkan oleh [`scripts/refresh-sector-hot.js`](scripts/refresh-sector-hot.js:1):
* **Prajogo Pangestu / Barito:** `BREN`, `BRPT`, `TPIA`, `CUAN`, `PTRO`
* **Salim Group:** `ICBP`, `INDF`, `AMMN`, `MEDC`, `META`
* **Astra Group:** `ASII`, `UNTR`, `AUTO`, `AALI`
* **Djarum / BCA:** `BBCA`, `TOWR`, `BELI`
* **Bakrie Group:** `BUMI`, `BRMS`, `ENRG`, `DEWA`
* **Sinarmas Group:** `INKP`, `TKIM`, `BSDE`, `SMMA`

### 3. Konfluensi Teknikal & Bandarmologi
Emiten dinyatakan lolos kualifikasi Swing Konglo jika memenuhi seluruh filter berikut:
1. **Trend Guard:** Harga penutupan berada di atas MA20 atau MA50 ($\text{Close} \ge \text{MA20}$).
2. **Bandar Accumulation Confluence:** Terjadi akumulasi bersih oleh Top 3 Broker dalam rentang 3–5 hari terakhir ($\text{CR3} \ge 40\%$ atau status akumulasi `Akumulasi Besar / Normal`).
3. **Foreign Flow Participation:** Untuk grup yang sensitif terhadap aliran modal asing (BCA, Barito, Salim), net foreign buy harus bernilai positif selama 3 sesi beruntun.
4. **Risk-to-Reward Gate:** Rasio target profit terhadap cut loss wajib memenuhi $R/R \ge 1.50\text{x}$.

---

## MODUL 3: AUDIT SCREENER SWING NON-KONGLOMERAT

### 1. Karakteristik & Filter Likuiditas
Screener Non-Konglo ([`supabase/swing-screener-non-konglo.sql`](supabase/swing-screener-non-konglo.sql:1), [`supabase/patch-nk-screener-value-cols.sql`](supabase/patch-nk-screener-value-cols.sql:1)) mencakup seluruh saham di luar grup konglomerat dengan filter likuiditas ketat:
* **Threshold Nilai Transaksi:** Rata-rata omzet harian ($\text{Turnover}$) minimal **Rp 10 Miliar/hari**.
* **Konsistensi Likuiditas:** Wajib aktif diperdagangkan dengan omzet $\ge \text{Rp } 10 \text{ M}$ selama minimal **15 dari 20 hari bursa terakhir**. Filter ini menyaring saham illiquid/gorengan yang hanya melonjak satu hari akibat manipulasi sesaat.
* **Papan Perdagangan (Board Gate):** Emiten pada Papan Pemantauan Khusus (FCA) dan Papan Akselerasi otomatis dieliminasi dari seleksi utama untuk melindungi modal pengguna dari suspensi atau fraksi harga abnormal.

### 2. Skema Nilai Kolom & Persistence Trade Plan V2
Berdasarkan audit [`supabase/patch-swing-nk-trade-plan-v2-persistence.sql`](supabase/patch-swing-nk-trade-plan-v2-persistence.sql:1):
* Database menyimpan struktur level perdagangan terencana secara atomik: `entry_price`, `stop_loss`, `target_1`, `target_2`, `risk_reward_ratio`, dan `plan_version = 2`.
* **Integritas Nilai Kolom:** Nilai numerik rupiah dibulatkan sesuai fraksi resmi bursa BEI (`idx_tick_normalization.js`) tanpa angka desimal semu.

---

## MODUL 4: AUDIT LIVE FASTWATCHER ENGINE

### 1. Pipeline Arsitektur & Real-Time Monitoring
FastWatcher ([`lib/intraday-fast-watcher-guarded-live.js`](lib/intraday-fast-watcher-guarded-live.js:1), [`lib/intraday-fast-watcher-pool.js`](lib/intraday-fast-watcher-pool.js:1)) memonitor dinamika harga dan volume secara live sepanjang jam bursa:
* **Frekuensi Siklus:** Dijalankan setiap 5 menit via crontab VPS (`deploy/vps/run-fastwatcher.sh`).
* **Sistem Konfirmasi Multi-Pool:**
  - `Observation Pool`: Kandidat awal yang menunjukkan anomali volume tick.
  - `Confirmation Pool`: Kandidat yang mempertahankan laju volume $\ge 2$ siklus (10 menit).
  - `Publishing Pool`: Kandidat yang lolos seluruh guard keselamatan dan siap disiarkan ke channel Telegram FastWatcher.

### 2. Algoritma Volume Pace V7 (`FAST_WATCHER_VOLUME_PACE_V7`)
Algoritma V7 membagi jam perdagangan ke dalam interval 15 menit dan menghitung kecepatan akumulasi volume:
$$\text{PaceRatio} = \frac{V_{\text{intraday}}}{\text{ExpectedCumulativeVol}(t)}$$
* Jika $\text{PaceRatio} \ge 2.5\text{x}$ disertai kenaikan harga $+1.5\%$ hingga $+4.0\%$, sinyal diklasifikasikan sebagai **Volume Spike Accumulation**.

### 3. Anti-Chase Guard & Opening Velocity Limits
Untuk mencegah pengguna "membeli di pucuk" (FOMO), FastWatcher menerapkan pembatas ketat:
* **Anti-Chase Filter:** Saham yang sudah naik $> 6.5\%$ dari harga open dilarang dipublikasikan sebagai alert DayTrade/FastWatcher.
* **Opening Velocity Guard (09:00–09:15 WIB):** Membatasi sinyal pada 15 menit pertama pembukaan pasar untuk mencegah lonjakan semu pre-opening auction.
* **Frequency Throttle:** Satu emiten yang sama tidak boleh dipublikasikan lebih dari 1 kali dalam jendela 90 menit kecuali terjadi breakout level resistance baru dengan volume $2\text{x}$ lebih besar.

---

## MODUL 8: AUDIT SISTEM SCORING & COMPOSITE TOP 5

### 1. Unified Score Engine & Bobot Komposit
Logika penilaian unifikasi terpusat pada [`lib/unified-score.js`](lib/unified-score.js:1) dan [`lib/top5-fusion-engine.js`](lib/top5-fusion-engine.js:1). Skor komposit berkisar antara 0–100 dengan alokasi komponen:

| Komponen | Bobot | Metrik Pengukuran |
|---|---:|---|
| **Trend & Moving Average** | 25% | Posisi harga terhadap MA20, MA50, MA100, MA200 |
| **Momentum & RSI** | 20% | RSI 14 (Zona optimal: 55–68, penalti jika > 75) |
| **Volume Confirmation** | 20% | Rasio volume terhadap rata-rata 20 hari ($V / V_{\text{avg20}}$) |
| **Bandarmologi / Broksum** | 20% | Konsentrasi broker Top 3/Top 5 ($\text{CR3}/\text{CR5}$) & status LPM |
| **Katalis & Sektor** | 15% | Momentum sektor hot BEI & pemberitaan resmi emiten |

### 2. Top 5 Fusion Engine
Algoritma pemilihan 5 saham terbaik harian (`dashboard-top5-only-ui.js`):
1. Mengambil seluruh kandidat dari Screener DayTrade, Swing Konglo, dan Swing Non-Konglo.
2. Melakukan deduplikasi dan kalkulasi **Composite Rank Score**.
3. Memastikan diversifikasi: Maksimal 2 emiten dari sektor yang sama dalam Top 5.
4. Memvalidasi bahwa setiap saham Top 5 memiliki $R/R \ge 1.50\text{x}$ dan tidak memiliki status FCA / suspensi.

---

## MODUL 9: AUDIT WAKTU, TIMEZONE & KALENDER BURSA

### 1. Konsistensi Timezone (WIB vs UTC)
* Seluruh server VPS berjalan dengan konfigurasi crontab eksplisit `CRON_TZ=Asia/Jakarta`.
* Seluruh string tanggal internal menggunakan format ISO-8601 berbasis zona waktu WIB (`UTC+7`).
* Fungsi pembantu [`lib/idx-trading-calendar.js`](lib/idx-trading-calendar.js:1) secara konsisten mengonversi waktu UTC sistem ke WIB sebelum menentukan sesi perdagangan.

### 2. Penjaga Jam Sesi Bursa (`lib/market-hours-guard.js`)
* **Sesi 1:** Senin–Jumat, 09:00:00 – 12:00:00 WIB (Jumat: 09:00:00 – 11:30:00 WIB).
* **Jeda Siang:** Dilarang memproses kuotasi live (pasar tutup).
* **Sesi 2:** Senin–Kamis, 13:30:00 – 15:45:00/16:00:00 WIB (Jumat: 14:00:00 – 15:45:00/16:00:00 WIB).
* **Guard Integrity:** Jika script intraday dijalankan di luar jam bursa atau pada akhir pekan (Sabtu/Minggu), worker langsung berhenti (`exit 0`) tanpa membuang kuota API Arjum.

### 3. Kalender Libur Bursa BEI 2026
* Tabel database `idx_trading_calendar` telah di-seed dengan seluruh hari libur resmi BEI tahun 2026 via [`scripts/seed-idx-holidays-2026.js`](scripts/seed-idx-holidays-2026.js:1) dan [`supabase/idx-holidays-2026-seed.sql`](supabase/idx-holidays-2026-seed.sql:1).
* **Cacat Ditemukan:** Pada beberapa file tools legacy (misal [`tools/backfill-broksum.js`](tools/backfill-broksum.js:247)), daftar tanggal perdagangan di-hardcode dari tanggal `2026-01-02` hingga `2026-10-16` alih-alih melakukan query dinamis ke tabel `idx_trading_calendar`. Hal ini menyebabkan proses backfill tidak dapat beradaptasi otomatis setelah 16 Oktober 2026 tanpa intervensi manual.
