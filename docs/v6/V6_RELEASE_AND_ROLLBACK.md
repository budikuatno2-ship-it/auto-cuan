# AUTO-CUAN V6: RELEASE RUNBOOK & ROLLBACK PLAN (SQLite-Safe)

**Dokumen Identifikasi:** `docs/v6/V6_RELEASE_AND_ROLLBACK.md`
**Branch Sumber:** `feat/v6-recovery`
**Target Branch PR:** `feat/daytrade-screener-v1` (TIDAK langsung ke `main`)
**Target Lingkungan Deploy:** VPS Produksi `168.110.221.197` (Ubuntu 24.04 / Node.js 22.23.1)
**Status Otorisasi:** Menunggu persetujuan pengguna sebelum eksekusi write/deploy ke VPS.

> **REVISI SUBTASK L (validated in staging).** Runbook ini menggantikan prosedur
> lama berikut yang SALAH dan telah diverifikasi/dikoreksi:
> 1. `cp -r data` + `cp market.sqlite` → mengganti dengan `VACUUM INTO` snapshot
>    konsisten (membaca WAL tanpa membuang commit yang masih di WAL).
> 2. `PRAGMA wal_checkpoint(TRUNCATE)` pada koneksi **`-readonly`** → DIHAPUS:
>    checkpoint tidak valid pada koneksi read-only dan tidak diperlukan;
>    `VACUUM INTO` sudah membaca snapshot konsisten transaksional.
> 3. `node -e "...quota-manager.getStatus()"` → method `getStatus` **tidak ada**;
>    export yang benar adalah `getQuotaStatus()`.
> 4. `pm2 restart all` → diganti `pm2 reload`/`pm2 restart` **scoped** hanya
>    `auto-cuan-vps-api` + `autocuan-web` (bot & tunnel tidak disentuh).
>
> Validasi staging & bukti perintah nyata: [`V6_RELEASE_RUNBOOK_VALIDATED_STAGING.md`](V6_RELEASE_RUNBOOK_VALIDATED_STAGING.md:1),
> [`V6_ROLLBACK_FIXTURE_RESULTS.md`](V6_ROLLBACK_FIXTURE_RESULTS.md:1).

---

## 1. PREFLIGHT CHECKLIST (SEBELUM DEPLOY VPS)

1. **Branch Verification:**
   ```bash
   git branch --show-current   # harus feat/v6-recovery
   ```
2. **Local Regression Suite:**
   ```bash
   node --test test/v6-scheduler-collision-regression.test.js
   node --test test/v6-rollback-sqlite-safety.test.js
   node --test test/v6-release-runbook-validation.test.js
   node --test test/admin-session-auth.test.js
   ```
3. **Secret Leak Inspection:**
   ```bash
   git diff | grep -iE 'telegram_token|bot_token|supabase_service_role' || echo "Clean"
   ```
4. **SQLite runtime availability (local sanity):**
   ```bash
   node -e "console.log(typeof require('node:sqlite').DatabaseSync)"
   ```

---

## 2. TAHAPAN RILIS VPS (STEP-BY-STEP)

Semua langkah memerlukan izin eksplisit sesuai
[`V6_DEPLOY_APPROVAL_MATRIX.md`](V6_DEPLOY_APPROVAL_MATRIX.md:1). Urutan:
review ZIP → push/PR → review integrasi → (APPROVAL) deploy → backup →
deploy → verifikasi produksi → monitoring.

### Langkah 0: Identifikasi & Kunci Penulis DB
SQLite produksi berada di `/home/ubuntu/auto-cuan-data/market.sqlite` dengan
`data` repo berupa symlink ke `/home/ubuntu/auto-cuan-v4/data`. App penulis DB
di PM2: `auto-cuan-vps-api` dan `autocuan-web`.

### Langkah 1: Backup Snapshot SQLite yang KONSISTEN (bukan `cp`, tanpa readonly checkpoint)
```bash
ssh -i ~/.ssh/autocuan_vps ubuntu@168.110.221.197 "bash -c '
  set -euo pipefail
  DB=/home/ubuntu/auto-cuan-data/market.sqlite
  TS=\$(date +%Y%m%d_%H%M%S)
  BK=/home/ubuntu/backups/v6-preflight-\$TS
  mkdir -p \$BK

  # (a) VACUUM INTO snapshot atomik & konsisten. Membaca data yang masih di WAL
  #     tanpa perlu checkpoint manual. JANGAN memakai \"PRAGMA wal_checkpoint\"
  #     pada koneksi -readonly (tidak valid & tidak diperlukan).
  sqlite3 \$DB \"VACUUM INTO \x27\$BK/market.sqlite.bak\x27;\"

  # (b) hash + integrity_check pada snapshot, BUKAN pada file live.
  sha256sum \$BK/market.sqlite.bak | tee \$BK/market.sqlite.bak.sha256
  sqlite3 -readonly \$BK/market.sqlite.bak \"PRAGMA integrity_check;\"

  # (c) cadangkan data non-SQLite (bukan cp -r data live)
  cp /home/ubuntu/auto-cuan-v4/data/admin-schedule-config.json \$BK/ 2>/dev/null || true
  crontab -l > \$BK/crontab.bak
  pm2 save
  echo \"CONSISTENT_BACKUP_OK \$BK\"
'"
```

> **Kenapa bukan `cp`?** `VACUUM INTO` membaca snapshot konsisten transaksional
> (termasuk data yang masih di WAL) ke satu file baru yang utuh, sedangkan
> `cp market.sqlite` mengabaikan `-wal` dan bisa merekam state torsi.
> **Kenapa tanpa `wal_checkpoint`?** `PRAGMA wal_checkpoint` adalah operasi tulis
> yang tidak valid pada koneksi read-only; `VACUUM INTO` sudah mengandalkan
> mekanisme snapshot SQLite sehingga checkpoint manual tidak dibutuhkan.

### Langkah 2: Git Fetch & Cutover di VPS
```bash
ssh -i ~/.ssh/autocuan_vps ubuntu@168.110.221.197 "bash -c '
  cd /home/ubuntu/auto-cuan
  git fetch origin feat/v6-recovery
  git checkout feat/v6-recovery
  npm install --omit=dev
'"
```

### Langkah 3: Preflight Dry-Run
```bash
ssh -i ~/.ssh/autocuan_vps ubuntu@168.110.221.197 "bash -c '
  cd /home/ubuntu/auto-cuan
  node tools/screeners-preflight.js --dry-run
  node -e \"console.log(JSON.stringify(require(\x27./lib/quota-manager\x27).getQuotaStatus(), null, 2))\"
'"
```

> Nama export diverifikasi terhadap source: `lib/quota-manager.js` hanya
> mengekspor `getQuotaStatus` (alias `calculateQuotaState`); `getStatus` tidak ada.

### Langkah 4: Reload SCOPED (bukan restart all)
```bash
ssh -i ~/.ssh/autocuan_vps ubuntu@168.110.221.197 "bash -c '
  # Hanya app penulis DB + web origin; bot & tunnel tidak disentuh.
  pm2 reload auto-cuan-vps-api
  pm2 reload autocuan-web
  pm2 status
'"
```

### Langkah 5: Smoke Test Pasca-Deploy
```bash
ssh -i ~/.ssh/autocuan_vps ubuntu@168.110.221.197 "bash -c '
  curl -s -f http://127.0.0.1:3000/api/sector-hot | grep -o \"success.:true\" || echo \"API Check Failed\"
  curl -s -f http://127.0.0.1:3000/api/quote?ticker=BBCA | grep -o \"success.:true\" || echo \"Quote Check Failed\"
'"
```

---

## 3. RENCANA ROLLBACK DARURAT (SQLITE-SAFE)

### Langkah Rollback 1: Kembalikan Git ke Baseline Stabil + Reload SCOPED
```bash
ssh -i ~/.ssh/autocuan_vps ubuntu@168.110.221.197 "bash -c '
  cd /home/ubuntu/auto-cuan
  git checkout ae5d1892
  pm2 reload auto-cuan-vps-api
  pm2 reload autocuan-web
'"
```

### Langkah Rollback 2: Restore SQLite dari SNAPSHOT KONSISTEN (bukan cp)
```bash
ssh -i ~/.ssh/autocuan_vps ubuntu@168.110.221.197 "bash -c '
  set -euo pipefail
  LATEST=\$(ls -td /home/ubuntu/backups/v6-preflight-* | head -1)
  DB=/home/ubuntu/auto-cuan-data/market.sqlite
  echo \"Memulihkan dari \$LATEST\"

  # (a) verifikasi hash + integrity snapshot SEBELUM restore.
  cd \$LATEST
  sha256sum -c market.sqlite.bak.sha256
  sqlite3 -readonly market.sqlite.bak \"PRAGMA integrity_check;\"

  # (b) berhenti sementara penulis DB supaya restore atomik & tidak torsi.
  pm2 stop auto-cuan-vps-api
  pm2 stop autocuan-web

  # (c) pindahkan file live + WAL/SHM lama ke samping (bukan hapus).
  mv \$DB               \$DB.broken-\$(date +%Y%m%d_%H%M%S)
  mv \$DB-wal           \$DB.broken-\$(date +%Y%m%d_%H%M%S)-wal 2>/dev/null || true
  mv \$DB-shm           \$DB.broken-\$(date +%Y%m%d_%H%M%S)-shm 2>/dev/null || true

  # (d) salin snapshot konsisten sebagai DB aktif (WAL/SHM baru akan dibuat).
  cp market.sqlite.bak \$DB

  # (e) verifikasi pasca-restore (read-only integrity OK).
  sqlite3 -readonly \$DB \"PRAGMA integrity_check;\"

  # (f) restart SCOPED (hanya penulis DB), bukan restart all.
  pm2 restart auto-cuan-vps-api
  pm2 restart autocuan-web
  pm2 status
'"
```

### Langkah Rollback 3: Restore Crontab & Config Non-SQLite
```bash
ssh -i ~/.ssh/autocuan_vps ubuntu@168.110.221.197 "bash -c '
  LATEST=\$(ls -td /home/ubuntu/backups/v6-preflight-* | head -1)
  crontab \$LATEST/crontab.bak
'"
```

---

## 4. PRINSIP DATA-SAFETY (WAJIB)

1. **Konsistensi snapshot:** `VACUUM INTO` (membaca WAL). Jangan `cp market.sqlite`
   tanpa snapshot; `cp` membuang data di WAL.
2. **Tanpa `wal_checkpoint` read-only:** `PRAGMA wal_checkpoint` adalah operasi
   tulis dan TIDAK valid pada koneksi `-readonly`; snapshot ditangani `VACUUM INTO`.
3. **WAL/SHM handling:** saat restore, pindahkan `market.sqlite`, `-wal`, `-shm`
   bersama-sama lalu salin snapshot; SQLite membuat ulang `-wal`/`-shm`.
4. **Verifikasi hash + integrity sebelum/sesudah restore** (`sha256sum -c` +
   `PRAGMA integrity_check` pada COPY/snapshot).
5. **Scoped PM2 reload/restart:** hanya `auto-cuan-vps-api` + `autocuan-web`.
   JANGAN `pm2 restart all`.
6. **Symlink:** jangan menimpa symlink `data`/`logs`; tulis hanya ke target real.

Primitif pemrograman untuk semua ini ada di
[`lib/sqlite-rollback-safety.js`](../../lib/sqlite-rollback-safety.js:1) dan
fixture `tools/v6-rollback-fixture.js`, termasuk `consistentSnapshot()`,
`integrityCheck()`, `sha256File()`, `isSymlink()`,
`buildScopedRestartPlan()`.

---

## 5. CHECKLIST VERIFIKASI PASCA-DEPLOY

- [ ] HTTP 200 `/api/sector-hot`
- [ ] HTTP 200 `/api/quote?ticker=BBCA`
- [ ] Quota Stock Arjum di atas floor 5.000 selama jam bursa (`getQuotaStatus()`)
- [ ] `PRAGMA integrity_check` pada `market.sqlite` = `ok`
- [ ] Snapshot backup `VACUUM INTO` + SHA-256 + integrity terekam
- [ ] `pm2 status` — hanya app penulis DB yang di-reload/restart (bukan `all`)
- [ ] Log telemetri `data/security/vps-audit.json` bersih
- [ ] `node --test test/v6-release-runbook-validation.test.js` lulus (local/staging)

---

## 6. RUJUKAN

- [`V6_RELEASE_RUNBOOK_VALIDATED_STAGING.md`](V6_RELEASE_RUNBOOK_VALIDATED_STAGING.md:1) — hasil uji COMMAND di staging.
- [`V6_ROLLBACK_FIXTURE_RESULTS.md`](V6_ROLLBACK_FIXTURE_RESULTS.md:1) — bukti fixture seed→snapshot→mutate→restore.
- [`V6_DEPLOY_APPROVAL_MATRIX.md`](V6_DEPLOY_APPROVAL_MATRIX.md:1) — matriks izin per tahap.
- [`V6_SECURITY_AUTH_AUDIT.md`](V6_SECURITY_AUTH_AUDIT.md:1) — audit keamanan/auth.
- [`V6_ORACLE_MEASUREMENTS_READONLY.csv`](V6_ORACLE_MEASUREMENTS_READONLY.csv:1) — metrik Oracle read-only.
