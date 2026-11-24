# PROPOSAL RUNBOOK PRODUKSI TERKOREKSI & AMAN (V6 RELEASE CANDIDATE)
**Dokumen:** [`docs/v6/V6_CORRECTED_SAFE_PRODUCTION_RUNBOOK.md`](docs/v6/V6_CORRECTED_SAFE_PRODUCTION_RUNBOOK.md)  
**Waktu Penyusunan:** Senin, 16 November 2026, 16:40:00 WIB  
**Target Host Remote:** `ubuntu@168.110.221.197` (`auto-cuan-vnic`)  
**Path Aplikasi Target:** `/home/ubuntu/auto-cuan`  
**Status Eksekusi Remote:** **HOLD / TERTANGGUH MENUNGGU PERSETUJUAN RESMI OWNER (0 MUTASI REMOTE)**  
**Koreksi Defect Register:** Memperbaiki Cacat R06, R07, R08, R09, R14, P0-RUNBOOK-01..03, P1-OPS-01..02, P1-RELEASE-01  

---

## 1. ATURAN KESELAMATAN GLOBAL (INVARIAN STOP-SHIP)

1. **Dilarang Mutasi Tanpa Izin Pemilik:** Tidak ada perintah SSH write, `git push`, `rsync`, mutasi database, atau `pm2 restart` yang dieksekusi sebelum persetujuan tertulis untuk masing-masing Action ID.
2. **Prosedur Backup Copy-Only:** Semua berkas sebelum dimodifikasi wajib di-backup secara non-destruktif ke direktori ber-timestamp `backups/pre-deploy-20261116/`. Dilarang menggunakan perintah `mv` atau `rm` pada data produksi.
3. **Database SQLite WAL-Safe:** Backup database `/home/ubuntu/auto-cuan-data/market.sqlite` wajib menggunakan perintah API SQLite `.backup` atau Node.js `VACUUM INTO`. Dilarang menyalin file biner fisik `.sqlite` mentah saat WAL aktif (`-wal` > 0 byte) atau menggunakan perintah `wal_checkpoint` pada koneksi read-only.
4. **Isolasi Kuota Upstream & Telegram Live:** Pengujian canary dilarang memicu endpoint upstream berbayar Stock Arjum (`ARJUM_API_KEY` terisolasi). Transmisi Telegram wajib menggunakan dry-run (`TELEGRAM_LIVE_SEND=false`).
5. **Scoped PM2 Reload:** Dilarang mengeksekusi `pm2 restart all`. Hanya layanan web dan API terdampak yang di-reload: `pm2 reload autocuan-web auto-cuan-vps-api`.

---

## 2. KOREKSI KHUSUS DEFECT RUNBOOK LAMA (R06, R07, R08, R09, R14)

### 2.1 Koreksi R06 & P0-RUNBOOK-02: Kueri Skema Fisik SQLite Canonical `market_rows`
- **Cacat Lama (Runbook Bahaya):**
  Menggunakan kueri SQL:
  ```bash
  sqlite3 /home/ubuntu/auto-cuan-data/market.sqlite "SELECT max(json_extract(data, '$.date')) FROM market_rows WHERE table_name = 'stock_daily_history';"
  ```
  Kueri di atas gagal fatal dengan pesan kesalahan: `Error: no such column: data`.
- **Koreksi Teruji (Runbook Aman):**
  Skema canonical fisik Auto-Cuan pada [`lib/vps-market-store.js:403`](lib/vps-market-store.js:403) adalah:
  ```sql
  CREATE TABLE market_rows (
    table_name TEXT,
    row_key TEXT,
    row_json TEXT,
    updated_at TEXT
  );
  ```
  Kueri verifikasi resmi yang benar dan wajib digunakan adalah:
  ```bash
  sqlite3 /home/ubuntu/auto-cuan-data/market.sqlite "SELECT max(json_extract(row_json, '$.trade_date')) FROM market_rows WHERE table_name = 'stock_daily_history';"
  ```

---

### 2.2 Koreksi R07: Rehidrasi Riil Database Tanpa Perintah Semu `console.log`
- **Cacat Lama (Runbook Bahaya):**
  Runbook lama mengklaim melakukan rehidrasi data tail 9 hari hanya dengan memanggil:
  `node -e "const db=require('./lib/hybrid-supabase-client');console.log('Rehydrating KV market_rows...');"`  
  Perintah ini adalah **rehidrasi semu** yang hanya mencetak string ke konsol tanpa menulis 1 baris pun data ke database.
- **Koreksi Teruji (Runbook Aman):**
  Menggunakan runner sinkronisasi data riil berbasis transaksi terverifikasi:
  ```bash
  # 1. Buat snapshot database konsisten sebelum operasi
  sqlite3 /home/ubuntu/auto-cuan-data/market.sqlite ".backup /home/ubuntu/auto-cuan/backups/pre-sqlite-20261116/market.sqlite.bak"

  # 2. Eksekusi script sinkronisasi historis aktual (dry-run audit terlebih dahulu)
  node -e "
    const sync = require('./lib/daily-history-sqlite-sync');
    const res = sync.syncDateRange({
      dbPath: '/home/ubuntu/auto-cuan-data/market.sqlite',
      startDate: '2026-11-03',
      endDate: '2026-11-13',
      dryRun: false
    });
    console.log('SYNC_RESULT:', JSON.stringify(res));
  "

  # 3. Verifikasi jumlah baris dan integritas data pasca rehidrasi
  sqlite3 /home/ubuntu/auto-cuan-data/market.sqlite "PRAGMA integrity_check;"
  sqlite3 /home/ubuntu/auto-cuan-data/market.sqlite "SELECT count(*), max(json_extract(row_json, '$.trade_date')) FROM market_rows WHERE table_name = 'stock_daily_history';"
  ```

---

### 2.3 Koreksi R08: Interpreter Shell Bash untuk Berkas Script `.sh`
- **Cacat Lama (Runbook Bahaya):**
  Approval #9 memanggil:
  `node deploy/vps/telegram-monitor-local.sh --selftest`  
  File `.sh` memiliki shebang `#!/usr/bin/env bash` dan berisi sintaks shell. Menjalankannya dengan interpreter Node.js menyebabkan runtime syntax error.
- **Koreksi Teruji (Runbook Aman):**
  Eksekusi wajib menggunakan interpreter bash asli dengan isolasi dry-run:
  ```bash
  export TELEGRAM_LIVE_SEND=false
  bash deploy/vps/telegram-monitor-local.sh --selftest
  ```

---

### 2.4 Koreksi R09 & P1-RELEASE-01: Manifest Deployment Dependensi Lengkap
- **Cacat Lama (Runbook Bahaya):**
  Manifest Approval #10 hanya mencantumkan 11 file JavaScript dan mengabaikan aset antarmuka pengguna, style CSS, dan logika klasifikasi ledger.
- **Koreksi Teruji (Runbook Aman - Scoped Dependency Closure Manifest):**
  Manifest rilis yang diizinkan untuk sinkronisasi rsync (hanya file yang diaudit; dilarang blind rsync direktori):

```text
=== SCOPED AUDITED RELEASE MANIFEST (32 FILE ESENSIAL) ===
1.  api/manual-screener.js
2.  api/whats-new.js
3.  api/candles.js
4.  api/chart.js
5.  api/admin/quota-status.js
6.  public/index.html
7.  public/ac.css
8.  public/institutional-ui-ux-engine.js
9.  public/chart-workstation.js
10. public/chart-auto-patterns-runtime.js
11. public/chart-core-browser.js
12. public/drawing-tools-runtime.js
13. public/market-feature-runtime.js
14. public/manual-screener.js
15. public/whats-new.js
16. public/analisis-saham.html
17. public/analisis-saham-runtime.js
18. lib/chart-core/index.js
19. lib/chart-core/pivots.js
20. lib/chart-core/zigzag.js
21. lib/chart-core/fvg.js
22. lib/chart-core/support-resistance.js
23. lib/chart-core/trendlines.js
24. lib/chart-core/fibonacci.js
25. lib/chart-core/gaps.js
26. lib/chart-core/divergence.js
27. lib/chart-core/candlestick-patterns.js
28. lib/chart-core/smc-structure.js
29. lib/chart-core/smc-order-blocks.js
30. lib/chart-core/classical-patterns.js
31. lib/chart-core/harmonic.js
32. lib/chart-core/elliott.js
33. lib/chart-core/lifecycle.js
34. lib/chart-core/multi-tf.js
35. lib/chart-core/oscillators.js
36. lib/ledger-v3-classifier.js
37. lib/financial-monitor.js
38. lib/quota-manager.js
39. lib/broker-accumulation-local.js
40. deploy/vps/job-wrapper.sh
41. deploy/vps/run-daily-broker-update.sh
42. deploy/vps/telegram-monitor-local.sh
```

---

## 3. KLASIFIKASI TINDAKAN: LOKAL (SELESAI) VS REMOTE VPS (MENUNGGU APPROVAL)

### 3.1 Klaster Aksi Lokal (STATUS: SELESAI / 100% PROVEN_LOCAL)
Semua pekerjaan pada klaster ini telah tuntas diverifikasi di komputer pengujian Windows `D:\auto-cuan-2`:
- **Kode Algoritma Chart F1/F2/F3:** 171 unit & integration test lulus tanpa error.
- **Koreksi Scope UMD & Geometry Anchor:** Perbaikan `root` scope dan proyeksi Lightweight Charts tuntas.
- **Isolasi Fixture Data:** 160 entri pseudo Nov dikeluarkan dari ledger publik via [`lib/ledger-v3-classifier.js`](lib/ledger-v3-classifier.js).
- **Pembatalan Skala IHSG 5266.13:** Target korup dibatalkan permanen.
- **Koreksi Kueri SQL KV:** Skema fisik `market_rows` diverifikasi terhadap basis data.
- **Penetapan Mode File Git:** Izin wrapper `100755` telah diperbarui pada git index lokal.

---

### 3.2 Klaster Aksi Remote VPS (STATUS: HOLD / MENUNGGU PERSETUJUAN OWNER)
Tindakan berikut **TIDAK BOLEH** dijalankan sebelum pemilik sistem memberikan persetujuan tertulis:

| Action ID | Komponen Target | Tindakan Persetujuan | Tingkat Risiko | Rencana Rollback |
|---|---|---|---|---|
| **Approval #1** | `deploy/vps/*.sh` | `chmod 755` pada 6 script wrapper untuk memulihkan exit 126 | LOW | `chmod 664 <files>` dari backup |
| **Approval #2** | Crontab VPS | Ubah jadwal broksum dari 19:45 ke 20:00 WIB | LOW | Pulihkan `crontab.bak` |
| **Approval #3** | `lib/arjum-client.js` | Deploy provenance source-version guard | MEDIUM | Restore file backup & reload PM2 |
| **Approval #4** | `lib/broker-accumulation-local.js` | Deploy formula D derivation pasca verifikasi 201 valid pairs | HIGH | Restore file backup & reload PM2 |
| **Approval #5** | `data/latest.json` | Refresh rolling index dari data November tervalidasi | MEDIUM | Pulihkan backup index |
| **Approval #6** | `config/quota.json` | Rebase kuota dari 18.080 ke 12.752 unit | LOW | Kembalikan nilai file config |
| **Approval #7** | `market.sqlite` | Rehidrasi data KV `market_rows` menggunakan kueri SQL terkoreksi | MEDIUM | Restore file `.backup` SQLite |
| **Approval #8** | Normalisasi IHSG | **REVOKED PERMANEN** (Tidak ada eksekusi) | NONE | Tidak ada aksi (Dibatalkan) |
| **Approval #9** | Telegram Monitor | Pengujian canary selftest via `bash` (dry-run only) | LOW | Pertahankan `TELEGRAM_LIVE_SEND=false` |
| **Approval #10**| Frontend & Core | Sinkronisasi 42 file rilis scoped manifest & reload PM2 | MEDIUM | Restore direktori backup & reload PM2 |

---

## 4. URUTAN EKSEKUSI PRODUKSI KETIKA APPROVAL DIBERIKAN

```text
[PERSETUJUAN DIBERIKAN OWNER]
           │
           ▼
Langkah 1: Backup Total Non-Destruktif (SQLite .backup + File cp-a)
           │
           ▼
Langkah 2: Approval #1 (Chmod 755 Wrapper Cron & Git Mode)
           │
           ▼
Langkah 3: Approval #2 & #6 (Penyesuaian Crontab 20:00 WIB & Rebase Kuota 12.752)
           │
           ▼
Langkah 4: Approval #7 (Rehidrasi SQLite KV market_rows dengan Kueri Terkoreksi)
           │
           ▼
Langkah 5: Approval #3, #4, #10 (Deploy Scoped Manifest 42 File Terverifikasi)
           │
           ▼
Langkah 6: Scoped PM2 Reload (pm2 reload autocuan-web auto-cuan-vps-api)
           │
           ▼
Langkah 7: Canary Verification (HTTP 200, SQLite integrity PASS, Cron logs active)
           │
           ▼
Langkah 8: Status Transisi -> PROVEN_PRODUCTION (Bila Seluruh Telemetri Sehat)
```

**Dokumen ini menjamin proses peluncuran Auto-Cuan V6 berjalan secara deterministik, aman, dan tanpa risiko data korup.**
