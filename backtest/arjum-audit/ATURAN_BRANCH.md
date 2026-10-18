# ATURAN BRANCH — Auto-Cuan

**Dibuat:** 2026-10-18 (setelah merge `feat/broksum-all-foreign` → `feat/daytrade-screener-v1`)
**Status:** BERLAKU sejak deploy 2026-10-18.

---

## 1. Aturan Pokok

1. **VPS SELALU menjalankan branch `feat/daytrade-screener-v1`.**
   Branch ini adalah "branch utama operasional" — satu-satunya branch yang
   boleh di-checkout di `/home/ubuntu/auto-cuan` (PM2 `autocuan-web` +
   seluruh worker cron).

2. **Kerja baru WAJIB di branch fitur terpisah.**
   Format: `feat/<topik>` atau `fix/<topik>` (contoh: `feat/broksum-all-foreign`).
   Jangan commit langsung ke `feat/daytrade-screener-v1` untuk perubahan besar.

3. **Alur wajib sebelum masuk produksi:**

   ```
   git checkout -b feat/<topik>            # 1. branch fitur
   ...kerja + test lokal...                # 2. jalankan tes (npm run test:full)
   git push -u origin feat/<topik>         # 3. push
   PR → feat/daytrade-screener-v1          # 4. Pull Request (review + CI hijau)
   merge (FF atau merge commit)            # 5. merge ke branch utama
   git push origin feat/daytrade-screener-v1
   # VPS:
   git fetch && git checkout feat/daytrade-screener-v1 && git pull --ff-only
   pm2 restart autocuan-web                # 6. HANYA jika ada perubahan kode web
   ```

4. **Tidak ada merge ke `main` tanpa perintah owner.**
   `main` bukan branch operasional VPS dan tidak dipakai produksi.

5. **Jangan hapus branch fitur setelah merge** tanpa perintah owner
   (berguna untuk audit dan jalur kembali).

---

## 2. Aturan Operasional VPS

- **Cek lock worker sebelum pindah branch.** Backfill worker memakai lock
  `data/arjum-data/_backfill/backfill.lock` (dan proses `backfill-broksum` di
  `ps aux`). Jangan checkout/pull saat worker berjalan.
- **`git pull --ff-only` saja di VPS.** Jangan merge di VPS; kalau tidak
  fast-forward, berarti ada commit lokal tak terduga — investigasi dulu.
- **Restart PM2 maksimum satu kali** per deploy, dan hanya bila kode web
  benar-benar berubah (`git diff --stat <hash-lama> HEAD` menunjukkan file
  yang dipakai web/`server.js`/`api/`/`lib/`/`public/`/`partials/`).
  Setelah restart, health check harus 200.
- **Crontab hanya diubah bila barisnya menyebut branch secara langsung.**
  Jadwal sekarang berisi perintah absolut (`/home/ubuntu/auto-cuan/...`) —
  tidak ada nama branch di crontab produksi.

---

## 3. Tag Cadangan & Jalur Kembali

- Sebelum merge besar, buat tag cadangan di HEAD branch utama:
  `git tag pre-merge-<topik>-<tanggal> && git push origin <tag>`.
- Jalur kembali (rollback) ke kondisi sebelum merge:

  ```bash
  # Di VPS — kembali ke branch fitur lama:
  git fetch --all
  git checkout feat/broksum-all-foreign
  git reset --hard 39ae22ae        # hash terakhir yang terbukti sehat
  pm2 restart autocuan-web         # jika kode berubah
  ```

  ```bash
  # Kembalikan branch utama ke tag (HANYA dengan izin owner):
  git checkout feat/daytrade-screener-v1
  git reset --hard pre-merge-broksum-20261018
  git push --force-with-lease origin feat/daytrade-screener-v1
  ```

- Tag yang tersedia: `pre-merge-broksum-20261018` (HEAD branch utama sebelum
  merge broksum, hash `a6b49f9b`).

---

## 4. Ringkas Alur Data

| Komponen | Branch | Catatan |
|---|---|---|
| PM2 `autocuan-web` | `feat/daytrade-screener-v1` | satu-satunya web writer |
| Cron J1 (`run-daily-market-update.sh`) | mengikuti checkout yang sama | single writer EOD broksum |
| Cron J2 (`run-daily-candles.sh`) | mengikuti checkout yang sama | Yahoo + cek silang Arjum |
| Backfill worker | mengikuti checkout yang sama | lock `_backfill/backfill.lock` |

Semua worker menjalankan kode dari working tree yang sama, sehingga
**checkout branch di VPS = mengganti kode semua worker sekaligus**.
Karena itu, pastikan tidak ada worker berjalan sebelum checkout.
