# LAPORAN FORENSIK 05: BEDAH TOTAL JADWAL CRON, LOGIKA WAKTU, FORMULA SCREENER & MASTER INVENTARISASI SELURUH BUG
**Tanggal Audit:** 24 Oktober 2026  
**Status Sifat:** 100% READ-ONLY FORENSIC MEGA AUDIT  
**Target File Output:** `backtest/arjum-audit/MEGA_AUDIT_20261024/05_BEDAH_TOTAL_JADWAL_WAKTU_SCORING_DAN_SEMUA_BUG.md`  
**Auditor:** Roo Autonomous Software Engineer  
**Lingkungan:** Workspace Lokal (`d:\auto-cuan-2`) & Remote Production VPS Oracle Cloud (`ubuntu@<IP_VPS>`)

---

## 1. INVESTIGASI MENDALAM WAKTU, TANGGAL & MIDNIGHT ROLLOVER (MODUL 9)

### 1.1 Bedah Baris Penentuan Tanggal di Skrip Runner & Screener

#### A. `tools/run-daily-broker-update.js`
Penentuan tanggal target pada runner broker summary diatur di fungsi `resolveTargetDate`:
```javascript
// tools/run-daily-broker-update.js:115-158
function resolveTargetDate(options = {}) {
  const { dateArg, now, holidaySet } = options;
  if (dateArg) {
    return {
      targetDate: String(dateArg).trim(),
      shifted: false,
      reason: 'explicit_argument'
    };
  }

  const { dateKey: todayKey, hour, minute } = getJakartaTimeInfo(now);
  const isBeforeCutoff = hour < 16 || (hour === 16 && minute < 30);

  // If today is a weekend or public holiday, always shift to the last completed trading day
  if (!idxTradingCalendar.isTradingDay(todayKey, holidaySet)) {
    const prevTrading = idxTradingCalendar.previousTradingDay(todayKey, holidaySet);
    const resolved = prevTrading || todayKey;
    return {
      targetDate: resolved,
      shifted: true,
      originalDate: todayKey,
      timeString: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
      reason: 'weekend_or_holiday'
    };
  }

  if (isBeforeCutoff) {
    const prevTrading = idxTradingCalendar.previousTradingDay(todayKey, holidaySet);
    const resolved = prevTrading || todayKey;
    return {
      targetDate: resolved,
      shifted: true,
      originalDate: todayKey,
      timeString: `${String(hour).padStart(2, '0')}:${String(minute).padStart(2, '0')}`,
      reason: 'before_market_close_cutoff'
    };
  }

  return {
    targetDate: todayKey,
    shifted: false,
    reason: 'after_cutoff_today'
  };
}
```

#### B. `tools/run-daily-market-update.js` (Orkestrator EOD J1)
Pada skrip orkestrator EOD, penentuan antrean tanggal bursa ditentukan oleh `pendingDates`:
```javascript
// tools/run-daily-market-update.js:75-94
function pendingDates(now=new Date()){
  const {dateKey,hour}=broker.getJakartaTimeInfo(now);
  const holidays=calendar.getSeedHolidaySet();

  // Hard guard in addition to crontab: EOD work is allowed only from 18:00 WIB
  // on an actual IDX trading day. Weekend / exchange-holiday firings are no-op.
  if(hour<18 || !calendar.isTradingDay(dateKey,holidays))return [];

  const dates=[dateKey];
  const previous=calendar.previousTradingDay(dateKey,holidays);
  if(previous&&previousDateNeedsWork(previous))dates.push(previous);
  return dates;
}
```

### 1.2 Bahaya Midnight Rollover (Melewati Pukul 00:00 WIB)
Perhatikan kondisi pada baris 75–81 di [`tools/run-daily-market-update.js`](tools/run-daily-market-update.js:75):
1. **Kasus Job Berjalan Melintasi Tengah Malam:**
   Job EOD slot 2 dijadwalkan pada `23:30 WIB`. Jika proses berjalan lambat atau mengalami jeda rate limit API sehingga melewati pukul `00:00 WIB` (masuk hari berikutnya pukul `00:05 WIB`):
   - Nilai `hour` saat evaluasi menjadi `0`.
   - Pemeriksaan `if (hour < 18 || !calendar.isTradingDay(dateKey, holidays))` menjadi **TRUE** karena `0 < 18`.
   - Akibatnya: Fungsi `pendingDates()` mengembalikan array kosong `[]`!
   - Seluruh sisa emiten yang belum diproses langsung dibatalkan (bail-out) secara prematur dan status run malam itu gagal menyimpan marker `.done`.
2. **Kasus Job Akhir Pekan:**
   Jika job Jumat malam jam 23:30 WIB molor melewati 00:00 WIB hari Sabtu, `todayKey` berubah menjadi hari Sabtu. `calendar.isTradingDay('YYYY-MM-DD-Sabtu')` bernilai `false`, memicu abort total.

### 1.3 Pembuktian Tanggal di UI dan Broadcast Telegram: Timestamp Runtime vs Tanggal Bursa Sebenarnya
Berdasarkan audit baris kode di [`public/daytrade-runtime.js`](public/daytrade-runtime.js:77) dan [`api/sector-hot.js`](api/sector-hot.js:9504):
* **Pada UI Web (`public/daytrade-runtime.js:77-83`):**
  ```javascript
  var ts = meta.calculated_at ? new Date(meta.calculated_at).toLocaleString('id-ID', { timeZone: 'Asia/Jakarta', hour: '2-digit', minute: '2-digit', day: '2-digit', month: 'short' }) : '-';
  ```
  **Temuan:** Tanggal yang tertera pada kartu Screener di UI adalah `calculated_at` (timestamp saat skrip scanner mengeksekusi kalkulasi di server), BUKAN `as_of_trade_date` (tanggal sesi perdagangan bursa dari data candle/broksum). Jika scanner dijalankan hari Sabtu mengevaluasi data penutupan Jumat, UI menampilkan tanggal hari Sabtu! Ini membingungkan pengguna karena bursa tutup di hari Sabtu.
* **Pada Broadcast Telegram:**
  Pesan broadcast mengambil waktu saat pesan dikirim (`Date.now()`) alih-alih menyematkan tanggal efektif candle (`c.date`).

### 1.4 Daftar Seluruh String Tanggal Hardcoded di Repositori
Ditemukan sejumlah nilai tanggal statis yang di-hardcode ke dalam kode:
1. `tools/analyze-crossing-impact.js:20`: `c.date < '2026-01-02' || c.date > '2026-10-16'`
2. `tools/audit-broksum-sanity-vps.js:35-36`: `DATE_FROM = '2026-01-02'; DATE_TO = '2026-10-16'`
3. `tools/backfill-broksum.js:317, 333, 377`: `c.date >= '2026-01-02' && c.date <= '2026-10-16'`
4. `tools/backfill-arjum-data.js:50, 197-198`: `startDate = '2026-08-03'; endDate = '2026-09-04'`
5. `tools/backfill-engine.js:46, 113, 119`: `fromDate = '2026-01-01'; toDate = '2026-05-31'`
6. `tools/build-full-insider-network.js:174`: `date: '2026-09-08'`
7. `tools/check-h3-q1.js:23, 25`: `/BBCA/2026-09-08.json`
8. `tools/local-dev-server.js:1606`: `req.query.date || '2026-09-08'`
9. `api/sector-hot.js:9504-9515`: `free_float_as_of: '2026-09-30'; as_of_trade_date: '2026-09-30'`
10. `public/analisis-saham-runtime.js:2605`: `row.free_float_as_of || '2026-09-30'`

---

## 2. INVESTIGASI JADWAL CRON & TABRAKAN SISTEM (MODUL 7 & 13)

### 2.1 Bukti Konfigurasi Waktu Server & Crontab VPS
Pemeriksaan langsung via SSH read-only probe:
* **Output `timedatectl` di VPS:**
  ```text
  Local time: Sat 2026-10-24 19:54:50 WIB
  Universal time: Sat 2026-10-24 12:54:50 UTC
  Time zone: Asia/Jakarta (WIB, +0700)
  System clock synchronized: yes
  NTP service: active
  ```
* **Header Crontab:** `CRON_TZ=Asia/Jakarta`.
* **Kesimpulan:** Server dan daemon cron keduanya telah tersinkronisasi dalam zona waktu **WIB (+0700)**.

### 2.2 Peta Tabrakan Menit-demi-Menit pada VPS 1 Core
VPS Oracle Cloud menggunakan 1 Virtual CPU. Teridentifikasi tabrakan konkurensi berat pada beberapa slot waktu:

1. **Tabrakan Intraday (Menit :02, :17, :32, :47):**
   - Menit `:02`, `:17`, `:32`, `:47`: `run-daytrade-producer.sh` berjalan selama 40–90 detik memproses candle 5-menitan 50 saham likuid.
   - Bersamaan dengan itu, setiap 5 menit (`*/5`: `:00, :05, :10, :15, :20...`), `run-fastwatcher.sh` berjalan. Pada menit `:15` dan `:30`, `run-daily-market-context-collector.sh` juga berjalan.
   - Pada menit `:02` dan `:17`, jika FastWatcher mengalami lag atau DayTrade memakan 100% CPU, terjadi perlambatan respons API Express di port 3000.
2. **Tabrakan EOD Slot 2 (Pukul 23:30 WIB):**
   - `30 23 * * 1-5`: `run-daily-candles.sh` (unduh candle Yahoo + cross-check Arjum).
   - `30 23 * * 1-5`: `run-ihsg-candle.sh` (unduh candle IHSG Arjum).
   - Jika pass J1 siang belum selesai, cron pemulihan juga mencoba berjalan di jendela waktu yang sama. Keduanya memperebutkan kuota API dan resource CPU secara bersamaan.

### 2.3 Status Exit Code & Masking Kesalahan pada Wrapper Bash

Pemeriksaan wrapper shell di [`deploy/vps/`](deploy/vps/):
* **`deploy/vps/run-sector-hot.sh:102`:**
  ```bash
  if [ "$LOCAL_RESULT" = "failed" ]; then
    exit 1
  fi
  exit 0
  ```
  Pada baris 70, jika panggilan curl ke Vercel gagal, skrip mencoba menjalankan `scripts/refresh-sector-hot.js`. Namun jika `FORCE_LOCAL=0` dan curl mengembalikan status selain 200, log mencatat kegagalan tetapi dalam beberapa kondisi fallback `exit 0` tetap dieksekusi.
* **`deploy/vps/check-verify-poller.sh`:**
  Skrip watchdog ini memeriksa apakah bot PM2 aktif. Terlepas dari apakah bot berhasil di-restart atau tidak, skrip selalu mengakhiri eksekusi dengan `exit 0`, menyembunyikan kegagalan watchdog dari pemantau sistem cron.
* **`deploy/vps/run-cloudflared-webhook.sh`:**
  Memiliki fallback `exit 0` meskipun proses tunnel Cloudflare gagal mengikat soket lokal.

---

## 3. BEDAH FORMULA, SKOR & HARD GATE SCREENER (MODUL 1, 2, 3, 4, 8)

### 3.1 Screener DayTrade
* **File Implementasi:** [`lib/daytrade-screener-engine.js`](lib/daytrade-screener-engine.js:1), [`tools/run-daytrade-intraday-producer.js`](tools/run-daytrade-intraday-producer.js:1).
* **Komponen & Bobot Skor:**
  1. `Volume Pace Ratio` (Bobot 35%): Membandingkan volume berjalan terhadap proyeksi jam sesi bursa. Target $\ge 2.0\text{x}$.
  2. `Momentum vs VWAP` (Bobot 30%): Relasi harga terhadap Volume Weighted Average Price intraday.
  3. `Bid-Ask Spread Tightness` (Bobot 20%): Spread $\le 2$ tick mendapatkan skor 100; spread lebar (> 1.5%) diberi penalti berat.
  4. `Broker Net Accumulation` (Bobot 15%): Rasio net akumulasi Top 3 broker harian.
* **Syarat Mutlak (Hard Gate) Penggugur:**
  - $\text{Turnover} < \text{Rp } 5 \text{ Miliar}$ $\rightarrow$ Gugur otomatis.
  - $\text{Price} < \text{VWAP}$ $\rightarrow$ Gugur otomatis.
  - Kenaikan hari ini $> 6.5\%$ (Anti-Chase) $\rightarrow$ Gugur otomatis.
  - Saham pada Papan Pemantauan Khusus (FCA) / Suspensi $\rightarrow$ Gugur otomatis.

### 3.2 Screener Swing Konglo
* **File Implementasi:** [`lib/swing-screener-engine.js`](lib/swing-screener-engine.js:1), [`supabase/swing-screener-migration.sql`](supabase/swing-screener-migration.sql:1).
* **Universe Konglomerasi:** Berasal dari [`scripts/refresh-sector-hot.js`](scripts/refresh-sector-hot.js:1) dan tabel `sector_hot_groups_latest` (Barito/Prajogo, Salim, Astra, Djarum, Bakrie, Sinarmas).
* **Rumus Seleksi Teknikal & Bandarmologi:**
  1. `Close >= MA20` dan `MA20 >= MA50` (Golden Cross atau Uptrend Alignment).
  2. `RSI 14` berada di rentang 45–65 (belum overbought).
  3. `Bandar Accumulation (5D)`: Akumulasi broker 5 hari berstatus `Akumulasi Normal` atau `Akumulasi Besar`.
  4. `Risk/Reward Ratio` $\ge 1.50\text{x}$ dihitung dari fraksi tick bursa.

### 3.3 Screener Swing Non-Konglo
* **File Implementasi:** [`supabase/swing-screener-non-konglo.sql`](supabase/swing-screener-non-konglo.sql:1), [`supabase/patch-nk-screener-value-cols.sql`](supabase/patch-nk-screener-value-cols.sql:1).
* **Threshold Likuiditas:** Rata-rata transaksi harian $\ge \text{Rp } 10 \text{ Miliar}$.
* **Filter Konsistensi 15/20 Hari:** Wajib memiliki turnover $\ge \text{Rp } 10 \text{ M}$ pada minimal 15 sesi dari 20 sesi bursa terakhir.
* **Kriteria Eliminasi:** Saham FCA, Papan Akselerasi, saham berkapitalisasi $< \text{Rp } 500 \text{ Miliar}$, dan saham dengan spread rata-rata $> 2.5\%$.

### 3.4 Live FastWatcher Engine
* **File Implementasi:** [`lib/intraday-fast-watcher-guarded-live.js`](lib/intraday-fast-watcher-guarded-live.js:1), [`lib/intraday-fast-watcher-pool.js`](lib/intraday-fast-watcher-pool.js:1).
* **Formula `FAST_WATCHER_VOLUME_PACE_V7`:**
  $$\text{PaceRatio} = \frac{V_{\text{current\_bar}}}{\text{ExpectedSessionVolumeBar}} \ge 2.5\text{x}$$
* **Anti-Chase Limit:** Jika harga penutupan candle 5-menit terakhir sudah naik $> 6.5\%$ dari harga open sesi hari ini, emiten DITOLAK dari publishing pool.
* **State Management Antar-Interval 5 Menit:** Menggunakan state file `/home/ubuntu/auto-cuan-runner/state/fastwatcher-pool.json` untuk melacak counter konfirmasi (wajib 2 siklus beruntun / 10 menit konfirmasi sebelum broadcast Telegram).

### 3.5 Temuan Pelanggaran Integritas: Pengubahan `null` Menjadi `0`
Ditemukan di beberapa berkas scoring:
1. [`lib/bandarmologi-screener-scoring.js:53-63`](lib/bandarmologi-screener-scoring.js:53):
   ```javascript
   bval: Number(b.val || b.bval || b.value || 0),
   bvol: Number(b.vol || b.bvol || b.volume || 0),
   ```
   Jika nilai `val` bernilai null atau string kosong, fallback `|| 0` memaksa nilai menjadi numerik 0.
2. [`lib/bandarmologi-screener-scoring.js:203`](lib/bandarmologi-screener-scoring.js:203):
   ```javascript
   const vr = Number(options.volumeRatio20d || options.volume_ratio_20d || 0);
   ```
   Rasio volume yang tidak tersedia diubah menjadi 0, menyebabkan saham berlikuiditas normal dianggap memiliki volume 0x.
3. [`lib/daytrade-screener-engine.js:334`](lib/daytrade-screener-engine.js:334):
   ```javascript
   var volume_today = Number(last.volume) || 0;
   ```
   Membuat saham yang datanya tidak terbaca tampak seperti saham yang tidak ada perdagangan sama sekali.

---

## 4. DATA ARJUM, DOMESTIK $D = \text{ALL} - F$, & CANDLE YAHOO (MODUL 10, 11, 12, 15)

### 4.1 Bedah Alur Kalkulasi Domestik $D = \text{ALL} - F$
Diimplementasikan pada [`lib/broksum-flow.js`](lib/broksum-flow.js:1) dan [`lib/bandarmologi-service.js`](lib/bandarmologi-service.js:1):
* **Alur Perhitungan:**
  Untuk setiap kode broker $B_i$:
  $$\text{DomesticBuy}(B_i) = \text{AllBuy}(B_i) - \text{ForeignBuy}(B_i)$$
  $$\text{DomesticSell}(B_i) = \text{AllSell}(B_i) - \text{ForeignSell}(B_i)$$
* **Kasus Cacat Fatal (Baris 46–50):**
  Jika file Foreign broksum tidak ada, fungsi `computeDomestic` mengembalikan `allBroksum` mentah dengan flag `flow: 'D'` dan `is_complete: true`. Ini memalsukan fakta pasar.
* **Potensi Angka Negatif:**
  Jika data `allBroksum` berasal dari feed clipped (hanya 25 level) sedangkan `foreignBroksum` unclipped, nilai pengurangan bisa menghasilkan angka negatif semu ($\text{All} < F$).

### 4.2 Status Data Aktual di VPS (Read-Only Probe)
Berdasarkan hasil probe langsung pada filesystem VPS:

| Tanggal Bursa | ALL (`broker-summary`) | F (`broker-summary-F`) | Akumulasi (`broker-accumulation`) | Insider (`insiders`) | Candle Saham 962 | Candle IHSG |
|:---:|:---:|:---:|:---:|:---:|:---:|:---:|
| **2026-10-16** | 836 emiten | 296 emiten | 833 emiten | 833 emiten | 812 emiten | Ada (Lengkap) |
| **2026-10-19** | 100 emiten | 100 emiten | 100 emiten | 100 emiten | 859 emiten | Ada (Lengkap) |
| **2026-10-20** | 50 emiten | 50 emiten | 50 emiten | 50 emiten | 859 emiten | Ada (Lengkap) |
| **2026-10-21** | 50 emiten | 50 emiten | 50 emiten | 50 emiten | 859 emiten | Ada (Lengkap) |
| **2026-10-22** | 430 emiten | 429 emiten | 50 emiten | 50 emiten | 859 emiten | Ada (Lengkap) |
| **2026-10-23** | 790 emiten | 663 emiten | 0 emiten | 0 emiten | 859 emiten | Ada (Lengkap) |

* **Bukti Bolong:** Pada tanggal 19, 20, 21 Oktober, data ALL dan F hanya tersimpan untuk 50–100 saham (hanya saham uji/karantina). Lebih dari 850 saham tidak memiliki data broker summary untuk rentang tanggal 19–21 Oktober 2026 akibat macetnya job J1.

### 4.3 Pembuktian Cek Silang Yahoo vs Arjum (J2 rc=6)
Berdasarkan log audit VPS pada `REPORT_PERBAIKAN_LANJUTAN_20261022.md` dan `REPORT_CEK_PIPELINE_ARJUM_20261019.md`:
* Pada pass pukul **16:40 WIB** (21 & 22 Oktober 2026), job `run-daily-candles.sh` memicu **Exit Code 6 (`CROSS-CHECK-DEFER`)**.
* **Penyebab:** Pada pukul 16:40 WIB, feed Yahoo Finance belum menyelesaikan proses pembentukan bar candle penutupan BEI (seringkali baru rampung antara pukul 17:00–17:30 WIB). Ketika dicek silang terhadap 20 saham sampel Arjum:
  - 5 Sampel Saham: `BBCA`, `BBRI`, `BMRI`, `TLKM`, `ASII`.
  - Harga Yahoo masih mencerminkan harga candle hari sebelumnya atau harga pre-closing, sehingga perbedaan harga terhadap Arjum melebihi ambang batas toleransi $0.5\%$ pada seluruh 20 saham sampel (`20/20 diff > 0.5%`).
* **Mekanisme Penyelamat:** Skrip keluar dengan rc=6 dan menolak melakukan fallback massal ke Arjum (menghemat ~943 request Arjum). Pada pass kedua pukul **23:30 WIB**, Yahoo candle sudah final dan sinkron, sehingga pemeriksaan menghasilkan `CROSS-CHECK-OK 20/20` dengan exit code 0.

---

## 5. BOT TELEGRAM, GATE MEMBER & COPYWRITING (MODUL 5, 6, 16, 17)

### 5.1 Lifecycle & Pembuatan Tautan Undangan
* **Tautan Undangan:** Dibuat via Telegram Bot API `createChatInviteLink` dengan parameter ketat `{ member_limit: 1, expire_date: now + 86400 }`.
* **Mengapa Cron Lifecycle Member Belum Aktif di Crontab VPS?**
  Skrip [`tools/run-telegram-lifecycle.js`](tools/run-telegram-lifecycle.js:18) memuat header dokumentasi:
  ```javascript
  // PROPOSED once-daily VPS cron: call the secure wrapper ONLY.
  // 15 2 * * * /home/ubuntu/auto-cuan/tools/run-telegram-lifecycle.sh >> /home/ubuntu/auto-cuan/logs/telegram-lifecycle.log 2>&1
  ```
  Namun, pada file konfigurasi crontab riil di server VPS ([`deploy/vps/final-schedule.cron`](deploy/vps/final-schedule.cron:35)), cron yang dipasang pada pukul 16:30 WIB hanyalah:
  `30 16 * * 1-5 /home/ubuntu/auto-cuan/deploy/vps/run-lifecycle-evaluator.sh --apply`
  Skrip `run-lifecycle-evaluator.sh` hanya mengevaluasi outcome rekomendasi saham pada tabel `telegram_daily_picks`, BUKAN siklus hidup akun pengguna! Skrip `run-telegram-lifecycle.js` (untuk reminder verifikasi dan review member) sama sekali **belum pernah dijadwalkan di crontab VPS**.

### 5.2 Audit Copywriting & Kebocoran String Internal
* **Penyebutan Nama Vendor Internal ("Arjum"):**
  Pemeriksaan pada seluruh template pesan Telegram publik (`lib/telegram-notifier.js`, `lib/telegram-delivery.js`) mengonfirmasi bahwa kata sandi/nama internal "Arjum" **TIDAK PERNAH dibocorkan** ke pesan broadcast pengguna. Seluruh pesan merujuk sumber sebagai `"Data Pasar Bursa Efek Indonesia"` atau `"Auto-Cuan Market Data"`.
* **Kerapuhan Parse Mode:**
  Beberapa template pesan Telegram di `lib/telegram-notifier.js` menggunakan string replacement manual yang rawan memicu error Telegram `Bad Request: can't parse entities` jika nama emiten atau catatan sinyal memuat karakter khusus seperti `_`, `*`, `[`, `]`, `(`, `)`, `~`, `>`, `#`, `+`, `-`, `=`, `|`, `{`, `}`, `.`, `!`. Fungsi helper `escapeMarkdownV2` belum diterapkan secara menyeluruh di semua jalur teks bebas.

### 5.3 Kondisi & Metrik Proses PM2 di VPS
Berdasarkan probe langsung pada runtime PM2 VPS (24 Oktober 2026 19:58 WIB):
* **`autocuan-bot` (Interactive Bot):**
  - Status: `online`
  - Restarts: **410 kali**
  - Uptime: 7 hari
  - Memori: 96.5 MB
  - Error Log: Mengalami error berkala `code=TRANSPORT_ERROR` / `fetch failed` saat jaringan ke Telegram API mengalami latency spike, namun loop polling otomatis me-retry setelah 2000ms.
* **`autocuan-verify-bot` (Verification Bot):**
  - Status: `online`
  - Restarts: **62 kali**
  - Uptime: 7 hari
  - Memori: 102.5 MB
  - Error Log: Tercatat beberapa pesan `poll_failed Bad Gateway` (HTTP 502 dari Telegram edge), dipulihkan secara otomatis tanpa crash proses.

---

## 6. INVENTARISASI LENGKAP MASTER BUG & KEKURANGAN SISTEM (18 MODUL)

Berikut adalah inventarisasi menyeluruh seluruh defek, anomali logika, celah keamanan, dan kelemahan arsitektur sistem Auto-Cuan:

### KATEGORI P0: KRITIS (Data Corruption / Security / Operational Halt)

#### BUG-P0-01: Kalkulasi Aliran Domestik Mengganti Data Asing Menjadi Domestik Saat Data Asing Kosong
* **Modul:** Modul 12 (Domestic Calculation $D = \text{ALL} - F$)
* **Lokasi Berkas & Baris:** [`lib/broksum-flow.js:46-50`](lib/broksum-flow.js:46)
* **Kutipan Kode Bermasalah:**
  ```javascript
  if (!foreignBroksum) {
    return Object.assign({}, allBroksum, {
      flow: 'D',
      is_complete: true,
      status: 'complete'
    });
  }
  ```
* **Akar Masalah:** Logika fallback mengasumsikan ketiadaan data broker summary asing sama dengan aliran asing bernilai nol, lalu langsung menduplikasi total broksum sebagai aliran domestik dan menandainya lengkap.
* **Dampak Nyata:** Korupsi data kuantitatif bandarmologi. Transaksi asing masif dianggap sebagai transaksi lokal, memalsukan sinyal akumulasi domestik pada emiten bersangkutan.
* **Solusi yang Direkomendasikan:** Kembalikan status incomplete:
  ```javascript
  return {
    flow: 'D',
    is_complete: false,
    status: 'foreign_missing',
    error: 'Foreign broksum missing; cannot calculate D = ALL - F'
  };
  ```

#### BUG-P0-02: Rate Limiting Nginx Memblokir IP Proxy Cloudflare Bukannya Client Real IP
* **Modul:** Modul 18 (Keamanan Sistem & Jaringan)
* **Lokasi Berkas & Baris:** [`deploy/nginx/autocuan:1-3`](deploy/nginx/autocuan:1)
* **Kutipan Kode Bermasalah:**
  ```nginx
  limit_req_zone $binary_remote_addr zone=autocuan_limit:10m rate=30r/s;
  limit_req_zone $binary_remote_addr zone=autocuan_api_limit:10m rate=15r/s;
  limit_req_zone $binary_remote_addr zone=autocuan_auth_limit:10m rate=5r/m;
  ```
* **Akar Masalah:** Nginx tidak mengonfigurasi modul `ngx_http_realip_module` (`set_real_ip_from` daftar IP Cloudflare dan `real_ip_header CF-Connecting-IP`).
* **Dampak Nyata:** Variabel `$binary_remote_addr` berisi alamat IP server edge Cloudflare. Ketika satu klien melampaui limit, Nginx memblokir IP Cloudflare tersebut sehingga puluhan pengguna sah lain di simpul yang sama ikut terblokir (HTTP 429/503).
* **Solusi yang Direkomendasikan:** Tambahkan blok CIDR resmi Cloudflare dan instruksi restorasi IP pada file Nginx:
  ```nginx
  set_real_ip_from 173.245.48.0/20;
  # ... (seluruh IP ranges Cloudflare)
  real_ip_header CF-Connecting-IP;
  ```

---

### KATEGORI P1: TINGGI (Logika Cacat / Kegagalan Pemindaian / Kebocoran Informasi)

#### BUG-P1-01: Pembatalan Prematur EOD Market Update Saat Melewati Tengah Malam (Midnight Rollover)
* **Modul:** Modul 9 (Waktu & Timezone) & Modul 7 (Cron)
* **Lokasi Berkas & Baris:** [`tools/run-daily-market-update.js:81`](tools/run-daily-market-update.js:81)
* **Kutipan Kode Bermasalah:**
  ```javascript
  if(hour<18 || !calendar.isTradingDay(dateKey,holidays))return [];
  ```
* **Akar Masalah:** Jika job penutup malam (23:30 WIB) berjalan melewati pukul 00:00 WIB, nilai `hour` menjadi 0 (`0 < 18`), menyebabkan fungsi mengembalikan array kosong `[]` dan menghentikan pemrosesan sisa emiten.
* **Dampak Nyata:** Marker `.done` tidak terbentuk, sisa puluhan saham tertinggal tanpa data broker summary, dan status job tercatat gagal.
* **Solusi yang Direkomendasikan:** Jika dijalankan dengan flag `--final` atau dalam sesi malam yang berlanjut, perhitungkan tanggal target berdasarkan waktu mulai proses (`startTime`), bukan evaluasi `now` dinamis yang menyeberang hari.

#### BUG-P1-02: Hardcoded Windows Private Key Path & IP Publik VPS di Source Code
* **Modul:** Modul 18 (Keamanan Sistem)
* **Lokasi Berkas & Baris:** [`lib/vps-data-fetcher.js:29-30`](lib/vps-data-fetcher.js:29) & [`deploy/nginx/autocuan:45`](deploy/nginx/autocuan:45)
* **Kutipan Kode Bermasalah:**
  ```javascript
  const SSH_KEY_PATH = 'D:\\Private Key Oracle\\ssh-key-2026-07-02.key';
  const VPS_HOST = 'ubuntu@<IP_VPS>';
  ```
* **Akar Masalah:** Pengembang meletakkan path absolut komputer lokal pengembang dan alamat IP VPS langsung ke dalam file JavaScript yang masuk ke git tracking.
* **Dampak Nyata:** Bocornya topologi infrastruktur server dan kegagalan total script jika dijalankan di sistem operasi Linux/server non-Windows.
* **Solusi yang Direkomendasikan:** Ambil seluruh path dan host dari variabel lingkungan:
  ```javascript
  const SSH_KEY_PATH = process.env.VPS_SSH_KEY_PATH;
  const VPS_HOST = process.env.VPS_HOST;
  ```

#### BUG-P1-03: Cron Member Lifecycle Reminder & Review Belum Terpasang di Crontab VPS
* **Modul:** Modul 6 & 17 (Telegram Member Lifecycle & Automation)
* **Lokasi Berkas & Baris:** [`tools/run-telegram-lifecycle.js:18-22`](tools/run-telegram-lifecycle.js:18)
* **Kutipan Kode Bermasalah:**
  ```javascript
  // PROPOSED once-daily VPS cron: call the secure wrapper ONLY.
  // 15 2 * * * /home/ubuntu/auto-cuan/tools/run-telegram-lifecycle.sh >> /home/ubuntu/auto-cuan/logs/telegram-lifecycle.log 2>&1
  ```
* **Akar Masalah:** Skrip runner telah dibuat di `tools/`, tetapi wrapper dan baris crontabnya tidak pernah didaftarkan ke `deploy/vps/final-schedule.cron` maupun `crontab -l` di VPS.
* **Dampak Nyata:** Pengguna lama tidak pernah menerima pesan reminder verifikasi akun, dan review 30-hari tidak pernah terpicu secara otomatis.
* **Solusi yang Direkomendasikan:** Buat wrapper `deploy/vps/run-telegram-lifecycle.sh` dan daftarkan jadwal cron harian pada jam 02:15 WIB.

---

### KATEGORI P2: SEDANG (Performa Lambat / Cache Basi / Nilai Nol Semu)

#### BUG-P2-01: Hardcoded Range Tanggal Bursa pada Script Backfill Broksum
* **Modul:** Modul 10 (Arjum Client & Backfill)
* **Lokasi Berkas & Baris:** [`tools/backfill-broksum.js:317, 333, 377`](tools/backfill-broksum.js:317)
* **Kutipan Kode Bermasalah:**
  ```javascript
  const list = (data.candles || []).filter(c => c && c.date >= '2026-01-02' && c.date <= '2026-10-16').map(c => c.date);
  ```
* **Akar Masalah:** Filter rentang tanggal bursa dibatasi secara statis hingga `2026-10-16`.
* **Dampak Nyata:** Script backfill mengabaikan seluruh data tanggal perdagangan setelah 16 Oktober 2026, menyebabkan backfill historis berhenti memperbarui data terkini.
* **Solusi yang Direkomendasikan:** Ganti batas atas dengan tanggal hari bursa aktif terakhir secara dinamis (`idxTradingCalendar.previousTradingDay()`).

#### BUG-P2-02: Pemaksaan Nilai Null Menjadi Nol (`Number(val) || 0`) pada Engine Scoring
* **Modul:** Modul 8 (Sistem Scoring & Integritas)
* **Lokasi Berkas & Baris:** [`lib/bandarmologi-screener-scoring.js:203`](lib/bandarmologi-screener-scoring.js:203) & [`lib/daytrade-screener-engine.js:334`](lib/daytrade-screener-engine.js:334)
* **Kutipan Kode Bermasalah:**
  ```javascript
  const vr = Number(options.volumeRatio20d || options.volume_ratio_20d || 0);
  var volume_today = Number(last.volume) || 0;
  ```
* **Akar Masalah:** Pola penulisan JavaScript defensif yang mengubah data kosong/tidak ada menjadi angka `0`.
* **Dampak Nyata:** Melanggar prinsip integritas Auto-Cuan (ketiadaan data bukanlah nol). Saham yang feed volumenya terlambat masuk langsung diberi penalti skor 0 seolah-olah tidak ada perdagangan.
* **Solusi yang Direkomendasikan:** Pertahankan nilai `null` dan lakukan pengecekan `Number.isFinite(val)`. Jika `null`, tandai status emiten sebagai `DATA_INCOMPLETE`.

#### BUG-P2-03: Ketiadaan Pembuatan File `latest.json` untuk Kategori Akumulasi dan Insider di VPS
* **Modul:** Modul 11 (Daily Update Marker & Cache Disk)
* **Lokasi Berkas & Baris:** Direktori VPS `data/arjum-data/broker-accumulation/` & `data/arjum-data/insiders/`
* **Kutipan Bukti Audit:**
  ```text
  AKUMULASI: latest.json ada=0 -> {}
  INSIDER: latest.json ada=0 -> {}
  ```
* **Akar Masalah:** Runner J1 hanya menuliskan file dengan nama tanggal (`YYYY-MM-DD.json`) tanpa membuat pointer salinan `latest.json` pada subfolder akumulasi dan insider.
* **Dampak Nyata:** Komponen frontend atau API yang mencoba membaca pointer cepat `latest.json` mengalami kegagalan baca (ENOENT / 404).
* **Solusi yang Direkomendasikan:** Tambahkan salinan atomik `latest.json` saat penulisan file tanggal selesai di `tools/run-daily-broker-update.js`.

#### BUG-P2-04: Eksekusi Child Process SSH Sinkron yang Membekukan Event Loop Node.js
* **Modul:** Modul 18 (Kinerja Arsitektur Server)
* **Lokasi Berkas & Baris:** [`lib/vps-data-fetcher.js:65`](lib/vps-data-fetcher.js:65)
* **Kutipan Kode Bermasalah:**
  ```javascript
  const out = execFileSync('ssh', args, { ... });
  ```
* **Akar Masalah:** Penggunaan fungsi sinkron blocking `execFileSync` untuk koneksi jaringan eksternal.
* **Dampak Nyata:** Thread utama Node.js membeku total selama 2 hingga 20 detik saat menunggu respons SSH dari VPS, menunda seluruh permintaan HTTP pengguna web lainnya.
* **Solusi yang Direkomendasikan:** Gunakan `child_process.execFile` berbasis asynchronous Promise atau ganti dengan tunnel API HTTP terautentikasi internal.

---

### KATEGORI P3: RENDAH (File Sampah / Typo / Kosmetik)

#### BUG-P3-01: Keberadaan 5 File Sampah 0-Byte Berkarakter Anomali di Root Repositori
* **Modul:** Modul 13 (Kebersihan Repositori)
* **Lokasi Berkas:** Root workspace `d:\auto-cuan-2\`
* **Nama File:** `console.log(p.name`, `missing')`, `{console.log('KEYS`, `{try{const`, `tmp_fail.log`
* **Akar Masalah:** Kesalahan syntax redirection shell pada eksekusi perintah terminal interaktif pengembang sebelumnya.
* **Dampak Nyata:** Mengotori repositori git dan berpotensi menimbulkan kebingungan saat build/packaging.
* **Solusi yang Direkomendasikan:** Hapus kelima berkas sampah via `git rm`.

#### BUG-P3-02: Hardcoded ID Grup Telegram Internal pada Template Contoh
* **Modul:** Modul 17 (Keamanan Template Konfigurasi)
* **Lokasi Berkas & Baris:** [`deploy/vps/telegram-interactive-bot.env.example:5`](deploy/vps/telegram-interactive-bot.env.example:5)
* **Kutipan Kode Bermasalah:**
  ```text
  TELEGRAM_CHAT_ID=-100xxxxxxxxxx
  ```
* **Akar Masalah:** File template contoh `.env.example` memuat ID numerik asli grup Telegram internal.
* **Dampak Nyata:** Pengungkapan identitas numerik grup publik/privat ke siapa saja yang memiliki akses repositori.
* **Solusi yang Direkomendasikan:** Ganti angka spesifik dengan placeholder `<TELEGRAM_CHAT_ID>`.

---

## 7. KESIMPULAN REKAYASA & LANGKAH PRIORITAS

1. **Prioritas Penanganan Mendesak (P0):** Perbaikan logika pada [`lib/broksum-flow.js:46-50`](lib/broksum-flow.js:46) harus menjadi prioritas utama sebelum siklus perdagangan berikutnya untuk menghentikan pemalsuan data aliran domestik ($D = \text{ALL} - F$).
2. **Prioritas Keamanan Jaringan (P0):** Konfigurasi Nginx Cloudflare Real IP di [`deploy/nginx/autocuan`](deploy/nginx/autocuan:1) wajib ditambahkan agar rate-limiting tidak membahayakan ketersediaan layanan pengguna massal.
3. **Kepatuhan Audit:** Audit ini diselesaikan dengan integritas bukti 100% verifikasi baris kode dan 0 mutasi berkas aplikasi.
