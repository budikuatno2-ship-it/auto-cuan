# AUTO-CUAN FULL REPO BUG FINDINGS - FASE 9 (Cron, Deploy, Daemons & Tools)
Dokumentasi temuan bug Fase 9. Seluruh temuan telah diverifikasi lewat unit test dan diperbaiki pada branch `fix/fase-9`.
Fokus audit: Sintaks cron & time zone drift, race condition concurrency di shell script (flock / pid lock), unhandled error exit code, env credential propagation, dan daemon process supervision.

---

### BUG-OPS-004: final-schedule.cron Memanggil Bare Node dan Mengabaikan Concurrency Lock
- **File:** `deploy/vps/final-schedule.cron`
- **Deskripsi:** Crontab memanggil tools node langsung alih-alih wrapper .sh yang memiliki proteksi flock -n, membuka celah race condition tumpang tindih proses.
- **Reproduksi:** `test/ops-fase9-batch1-bugs.test.js`
- **Status:** CLOSED / VERIFIED (Dialihkan ke deploy/vps/*.sh dengan proteksi flock dan penanganan lock aman)

### BUG-OPS-005: final-schedule.cron Kehilangan Direktif Header CRON_TZ
- **File:** `deploy/vps/final-schedule.cron`
- **Deskripsi:** Tidak adanya direktif CRON_TZ=Asia/Jakarta menyebabkan cron daemon pada server VPS berzona waktu UTC mengeksekusi pekerjaan pada waktu yang tidak sesuai.
- **Reproduksi:** `test/ops-fase9-batch1-bugs.test.js`
- **Status:** CLOSED / VERIFIED (Header direktif CRON_TZ=Asia/Jakarta telah ditetapkan)

### BUG-OPS-006: vps-api-server Terekspos Publik Tanpa Autentikasi Token
- **File:** `tools/vps-api-server.js`
- **Deskripsi:** Server mendengarkan pada 0.0.0.0 dengan CORS '*' dan melayani data broker summary, bandarmologi intel, serta insider roster tanpa proteksi API key / token header.
- **Reproduksi:** `test/ops-fase9-batch2-bugs.test.js`
- **Status:** CLOSED / VERIFIED (Mekanisme validasi Authorization Bearer / X-API-Key guard telah diaktifkan)

### BUG-OPS-007: Ketiadaan Graceful Shutdown Handler pada vps-api-server
- **File:** `tools/vps-api-server.js`
- **Deskripsi:** Server tidak menangkap sinyal SIGTERM atau SIGINT, menyebabkan socket tertahan dan port bentrok (EADDRINUSE) saat daemon di-restart oleh orchestrator VPS.
- **Reproduksi:** `test/ops-fase9-batch2-bugs.test.js`
- **Status:** CLOSED / VERIFIED (Handler sinyal SIGTERM dan SIGINT telah diintegrasikan dengan pemanggilan stopDaemon)

### BUG-OPS-008: refresh-sector-hot Menelan Error Upsert Member Secara Diam-diam
- **File:** `scripts/refresh-sector-hot.js`
- **Deskripsi:** Kegagalan mutasi memberRows hanya dicetak ke konsol tanpa menghentikan eksekusi atau mengembalikan exit code non-zero, membiarkan metadata berstatus sukses padahal data parsial hilang.
- **Reproduksi:** `test/ops-fase9-batch3-bugs.test.js`
- **Status:** CLOSED / VERIFIED (Kegagalan upsert member dan group memicu rethrow exception dan pembaruan metadata failed)

### BUG-OPS-009: updateMeta Di-hardcode Status 'ok' Tanpa Evaluasi Kegagalan Parsial
- **File:** `scripts/refresh-sector-hot.js`
- **Deskripsi:** Fungsi updateMeta selalu mencatat status 'ok' dan pesan sukses tanpa memeriksa apakah terjadi kesalahan upsert grup atau anggota.
- **Reproduksi:** `test/ops-fase9-batch3-bugs.test.js`
- **Status:** CLOSED / VERIFIED (Kalkulasi status mengevaluasi failedCount > 0 menghasilkan status partial secara deterministik)
