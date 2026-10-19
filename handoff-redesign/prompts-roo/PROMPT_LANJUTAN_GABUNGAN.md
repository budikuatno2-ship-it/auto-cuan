# PROMPT GABUNGAN: Candle Yahoo, akumulasi lokal, penyimpanan VPS, rencana kuota semua 962 saham, simulasi asing + LPM (Roo Code)

> Mode **Code**. Tempel seluruh isi di bawah garis.
> Prompt ini menggantikan `PROMPT_STORAGE_DAN_KOMPRESI.md` dan `PROMPT_SIMULASI_FOREIGN_LPM.md`.
> Kerjakan **per fase sesuai syarat waktunya**. Fase yang syaratnya belum terpenuhi **jangan dikerjakan**. Tulis di laporan kapan fase itu bisa jalan, lalu lanjut ke fase berikutnya yang syaratnya sudah terpenuhi. Prompt ini boleh dijalankan ulang nanti. Fase yang sudah selesai dilewati, lihat `backtest/arjum-audit/STATUS_GABUNGAN.md`.

**Izin pemilik (Minggu 18 Okt 2026):**
- **Fase 1A** (candle 962 saham pindah ke Yahoo dengan cek silang): disetujui.
- **Fase 2** (akumulasi pindah ke hitung lokal, **hanya kalau uji paritas lolos**): disetujui.

Untuk dua fase itu boleh: commit di branch, perubahan crontab (sesudah backup), dan `pm2 restart autocuan-web` **satu kali per fase**.

Fase lain **read-only atau riset saja**.

---

## Batas keras (semua fase)

1. **Arjum:** hanya GET. Jangan cetak `.env`, kunci, IP VPS, atau lokasi kunci SSH. Jangan pakai `StrictHostKeyChecking=no`.
2. Jangan ganggu worker backfill.
3. **Data:** tidak ada file data yang dihapus. File yang salah dipindah ke karantina. Buat salinan sebelum mengubah `state.json`, `.env`, atau crontab.
4. **Git:**
   - Kerjakan di branch fitur (boleh `feat/broksum-all-foreign`), satu perubahan = satu commit, dengan test.
   - Setelah sebuah fase lolos uji: buat PR → merge ke **`feat/daytrade-screener-v1`** → di VPS `git pull --ff-only` di branch itu.
   - VPS selalu menjalankan `feat/daytrade-screener-v1`.
   - **Jangan merge ke `main`.**
5. Tidak ada angka karangan. Data kosong ditulis null, bukan 0.
6. **Jangan mengurangi jumlah saham** (962) di job harian mana pun tanpa persetujuan pemilik.
7. Setiap fase yang mengubah produksi wajib punya **jalur kembali** yang siap tempel.

---

## Fase 0 · Cek hasil perbaikan 19 Okt (paling dulu, read-only)

Dasar: `REPORT_PERBAIKAN_20261019.md` (PR #898).

1. **J2 Senin 16:40:**
   - jumlah saham dari Yahoo;
   - hasil cek silang 20 saham;
   - sempat fallback ke Arjum atau tidak;
   - bar IHSG 19 Okt ada;
   - `.done` 19 Okt tertulis, dan kalau ada, isi `anomali.json`.
2. **Backfill Senin 19:30 dan Selasa 00:07:**
   - jumlah request;
   - alasan berhenti (label baru);
   - task yang dilewati karena 5xx.
3. **Swing Phase 2 Senin 21:30:**
   - universe dan jumlah yang di-scan (harus > 0);
   - `source_dates['swing-konglo']` = 2026-10-19;
   - broadcast Telegram swing terkirim atau tidak.
4. **DayTrade Selasa pagi:** run 09:00–10:00 berstatus `published` dengan jumlah baris > 0, dan tidak ada alarm basi.
5. **Aksi lain yang mungkin kena guard 3,5 detik:** cari di log 7 hari terakhir semua respons `"Fallback: response completed via timeout guard"` per aksi. Untuk setiap aksi yang pernah kena, tentukan apakah hasil kosong itu merusak fitur. **Jangan perbaiki.** Laporkan sebagai usulan, karena perbaikan butuh persetujuan pemilik.

Kalau ada yang gagal di langkah 1–4, tandai **[DARURAT]** di chat dan tunggu pemilik sebelum lanjut ke fase lain.

## Fase 1A · Candle 962 saham dari Yahoo, dengan cek silang (sekarang)

Dasar: laporan `REPORT_HEMAT_KUOTA.md`. Hasilnya: 0 hari hilang, selisih OHLC 0,00%, dan bar final tersedia sekitar 16:20–16:30 WIB.

1. **Sumber dan jadwal:**
   - Job candle harian (J2) memakai Yahoo (`<KODE>.JK`, harga mentah/unadjusted) untuk 962 saham.
   - Jalan pukul **16:40 WIB** di hari bursa, diulang **23:30 WIB** untuk menangkap koreksi.
   - Gunakan **batch beberapa saham per request** kalau endpoint mendukung, ditambah jeda dan retry dengan backoff.
2. **IHSG tetap dari Arjum** (1 request per hari). IHSG menjadi patokan sumber resmi dan pembanding Yahoo.
3. **Cek silang harian:**
   - 20 saham acak (10 likuid, 10 lainnya) diambil juga dari Arjum. Biaya: 20 request.
   - Kalau ada selisih close di atas 0,5%, atau ada hari yang hilang, **hari itu otomatis kembali ke Arjum untuk semua saham**, lalu dicatat di log.
4. **Volume pasar negosiasi:** volume Yahoo mencakup pasar reguler + nego + tunai, sehingga di hari crossing besar bisa 1,02–1,18× volume Arjum.
   - Hitung dampaknya ke Volume Rotation, Intensity, dan CMF pada 20 kejadian crossing terbesar.
   - **Jangan ubah rumus indikator.** Laporkan saja, dan usulkan penanda "ada transaksi nego" kalau dampaknya besar.
5. **Fallback:** kalau Yahoo gagal (blokir, format berubah, data kosong), job otomatis memakai Arjum untuk hari itu, dan admin melihat peringatan di Admin Console.
6. **Bar hari ini selama jam bursa** (lihat HANDOFF §5a):
   - Satu proses server mengisi cache harga live semua saham setiap 1–2 menit, dengan batch dari Yahoo.
   - Endpoint chart mengembalikan bar "sementara" dari cache itu, dengan field `provisional:true` dan `updatedAt`.
   - Pengunjung **tidak** memanggil Yahoo langsung.
   - Screener Swing hanya membaca bar final.
7. **Uji:**
   - unit test parser Yahoo, fallback, dan cek silang;
   - dry-run untuk satu tanggal;
   - bandingkan file hasil Yahoo dengan file Arjum untuk 5 hari terakhir. Selisih close harus 0.
8. **Sesudah deploy:** pastikan penanda `.done` tetap ditulis dan backfill mendapat tambahan sekitar 942 request per hari.

## Fase 1B · Penyimpanan VPS dan uji kompresi (sekarang, read-only)

1. Jalankan `df -h` **dan** `df -i`.
2. Isi tabel ukuran per folder: ukuran, jumlah file, rata-rata ukuran file, dan pertumbuhan per hari. Folder yang dihitung:
   - broker-summary all, F, akumulasi, insider;
   - daily-candles;
   - semua `_quarantine-*`, `_staging`, `_backfill`;
   - log pm2 dan `autocuan-web-error.log`;
   - SQLite, `node_modules`, `.git`.
3. Hitung pemborosan blok 4 KB untuk file kecil.
4. **Proyeksi:** ukuran dan jumlah file saat backfill selesai, pertumbuhan per bulan, dan kapan disk atau inode penuh.
5. **Uji kompresi pada salinan** di `data/_staging/compress-test/`. Contoh data: 3 saham likuid + 3 saham sepi × 1 bulan × all dan F. Bandingkan:
   - JSON apa adanya;
   - gzip per file;
   - zstd/brotli per file;
   - **satu file per saham per bulan** (`.json.gz`);
   - **SQLite** satu tabel dengan indeks `(kode, tanggal)`.

   Ukur ukuran, waktu baca 1 hari dan 20 hari, dan jumlah file. Hapus salinan setelah diukur.
6. Daftar semua kode yang membaca broksum, akumulasi, dan insider (file:baris dan pola baca).
7. **Usulan (jangan dijalankan):**
   - data 60 hari terakhir tetap seperti sekarang, arsip lama dipadatkan;
   - satu modul baca `lib/broksum-store.js`;
   - rencana migrasi: tulis di samping format lama → verifikasi identik → pindahkan pemakai → arsipkan format lama;
   - karantina dibungkus `.tar.zst`;
   - rotasi log.

   Semua usulan ini menunggu persetujuan pemilik.

## Fase 1C · Rencana kuota setelah paket Supporter berakhir, **tetap 962 saham** (sekarang, hitung saja)

Rencana sebelumnya (420 saham untuk kuota 1.000) **ditolak** pemilik. Jumlah saham harus tetap semua.

1. **Insider massal:** cek dokumentasi Arjum di repo. Apakah ada endpoint insider **seluruh pasar** (daftar transaksi orang dalam terbaru untuk semua emiten dalam 1 request), selain endpoint per emiten? Kalau ada, berapa request per hari yang dibutuhkan?
2. Hitung kebutuhan **minimum per hari untuk 962 saham penuh** setelah backfill selesai:

   | Komponen | Request per hari |
   |---|---|
   | broksum all 962 | |
   | broksum asing (hanya hari ada transaksi) | |
   | IHSG | 1 |
   | cek silang Yahoo | 20 |
   | akumulasi | 0 kalau Fase 2 lolos |
   | insider (massal, rolling, atau mingguan) | |
   | cadangan website | |
   | cadangan retry 10% | |

3. Buat tabel **kuota yang dibutuhkan vs fitur yang tetap utuh** untuk 1.000 / 2.000 / 3.000 / 7.020 per hari.
4. Tambahkan penjaga di kode: kalau batas kuota terbaca di bawah kebutuhan minimum, **jangan diam-diam mengurangi saham**. Kirim peringatan ke Admin Console dan Telegram admin, lalu tunggu keputusan pemilik.

## Fase 1D · Data asing yang belum dirilis vendor (kapan saja, perbaikan bug)

Kasus: KOTA 16 Okt. File F kosong karena Arjum belum merilis datanya (`broker_date_max` = sehari sebelumnya). Validator sekarang menganggapnya **valid**, tapi tanpa ambil ulang file ini akan **kosong selamanya** dan terbaca seperti "asing tidak bertransaksi".

1. Setiap file dengan tanda `vendor_foreign_not_yet_published` (juga untuk flow all, kalau polanya sama) masuk antrean **ambil ulang besok** di slot backfill 00:07, maksimal 3 kali coba di hari yang berbeda.
2. Selama belum terisi:
   - file tidak dihitung "selesai";
   - Bandarmologi menampilkan "data asing belum dirilis", **bukan** 0.
3. Laporkan berapa kasus seperti ini dalam 10 hari terakhir.
4. Satu commit dengan test. Restart web paling banyak satu kali, digabung dengan fase lain kalau bisa.

## Fase 2 · Akumulasi broker dihitung lokal (mulai Kamis 22 Okt 2026)

**Syarat jalan:** backfill all lengkap (`all_data=true`) untuk 10 saham uji sudah menutup 80 hari bursa terakhir. Cek dulu. Kalau belum, tulis perkiraan tanggalnya dan lewati fase ini.

1. Jalankan `tools/check-accum-parity.js` untuk 10 saham ini: BBCA, BRPT, BBRI, MEDC, ADRO, BUMI, BMRI, TPIA, BBNI, TLKM. Tambahkan 5 saham sedang.
2. **Lolos kalau** di semua saham ≥ 99% hari cocok persis, dan selisih kumulatif 80 hari ≤ 0,5%.
3. **Kalau lolos:**
   - set `ACCUM_SOURCE=local` (salin `.env` dulu);
   - cocokkan tampilan Bandarmologi, Broker Hunter, dan screener untuk BBCA dan BRPT, sebelum dan sesudah;
   - restart sekali;
   - catat hematnya (sekitar 834 request per hari).
4. **Kalau belum lolos:** tetap `api`, lalu tulis tanggal-tanggal yang berbeda beserta sebabnya.

## Fase 3 · Simulasi aliran asing + LPM (riset)

**Syarat jalan:** cakupan file F asli + all lengkap untuk saham likuid (turnover ≥ Rp 1 miliar per hari) ≥ 90% sejak 2 Jan 2026. Perkiraan sekitar 22–25 Okt; seluruh saham sekitar 2 Nov. Kalau belum, tulis perkiraannya dan lewati.

Semua kode di `backtest/foreign-flow/`, 0 request Arjum, tanpa perubahan produksi.

**Hipotesis pemilik:**
- asing penggerak utama saham Indonesia;
- asing akumulasi lama sambil harga ditekan atau sideways;
- lalu harga naik.

**Catatan jujur:** uji sebelumnya, broker summary tidak memprediksi arah 10 hari. Hasil negatif tetap dilaporkan.

**Aturan uji:**
- Tidak ada look-ahead. Fitur pada hari t memakai data sampai close t.
- Return dihitung dari close t ke close t+h, setelah biaya (beli 0,15%, jual 0,25%).
- Pakai **excess return** terhadap IHSG.
- Pemisahan periode:
  - Jan–Jun 2026 untuk memilih ambang;
  - Jul–16 Okt 2026 untuk menguji;
  - ambang tidak boleh diubah setelah melihat hasil uji.
- Return tumpang tindih: pakai galat baku Newey-West.
- Buang sinyal yang jendela return-nya melewati 16 Okt.
- File `derived:"no-trade"` = asing 0.

**Langkah:**
1. **F0 · Cek definisi data:** satuan lot/lembar, nilai Rp. Cocokkan satu contoh dengan nilai transaksi candle.
2. **F1 · Fitur asing per saham per hari:**

   | Fitur | Rumus |
   |---|---|
   | NF | nilai beli asing − nilai jual asing |
   | NFn | NF ÷ nilai transaksi |
   | CumNF dan CumNFn | untuk 5, 20, 60 hari |
   | Partisipasi asing | (beli asing + jual asing) ÷ (2 × nilai transaksi) |
   | Harga rata-rata beli asing 60 hari | dan selisih harga terhadapnya (%) |
   | Beruntun | hari berturut-turut net buy asing |
   | **Fase akumulasi diam-diam** | return 20 hari ≤ +2% **dan** CumNFn(20) di atas ambang in-sample |
   | **Fase distribusi** | return 20 hari ≥ +5% **dan** CumNFn(20) < 0 |

3. **F2 · Uji:**
   - **H1:** rank IC CumNFn terhadap excess return +5/+10/+20/+40 hari, dan selisih desil teratas vs terbawah.
   - **H2 · event study akumulasi diam-diam:**
     - lama fase dan dalamnya penurunan selama fase;
     - hasil 5/10/20/40 hari setelah fase berakhir;
     - dibandingkan baseline: kondisi harga serupa **tanpa** akumulasi asing.
   - **H3:** apa yang terjadi setelah CumNF(20) berbalik turun dari puncaknya.
   - **H4:** sinyal S1 LPM sendirian vs S1 + konfirmasi asing vs S1 + asing distribusi. Bandingkan % menang setelah biaya, excess return median, dan MAE.
   - **H5:** per kelompok: LQ45/kapitalisasi besar vs lapis 2–3, dan per sektor.
   - **H6 · ketahanan:**
     - tanpa 10 hari paling ekstrem;
     - ambang ±50%;
     - k = 10 dan 40.
4. **F3 · Gambar** untuk BBCA, BRPT, dan satu saham lapis dua dengan efek terkuat. Disimpan sebagai PNG + JSON di `backtest/foreign-flow/fig/`. Isinya:
   - candle;
   - garis harga rata-rata asing 60 hari;
   - panel bar NF + garis CumNFn(20);
   - arsir fase akumulasi dan distribusi.
5. **F4 · Kesimpulan:**
   - status setiap hipotesis: didukung / lemah / tidak didukung, dengan angka out-of-sample;
   - **kalau didukung,** usulkan rumus "LPM + Asing" dan tampilannya (panel bar NF + kumulatif, garis harga rata-rata asing, lencana "Asing akumulasi N hari · rata-rata Rp X");
   - **kalau tidak didukung,** data asing tampil sebagai alat baca saja tanpa label sinyal;
   - tulis batasan sampel (sekitar 9,5 bulan, termasuk crash 16 Okt).

---

## Laporan

1. Perbarui `backtest/arjum-audit/STATUS_GABUNGAN.md`: status setiap fase (**selesai / dilewati, menunggu tanggal X / gagal**), commit, dan jalur kembali.
2. Laporan detail per fase:
   - `REPORT_YAHOO_CANDLE.md`
   - `REPORT_STORAGE.md`
   - `REPORT_KUOTA_962.md`
   - `REPORT_ACCUM_LOCAL.md`
   - `backtest/foreign-flow/REPORT_FOREIGN_LPM.md`

Tampilkan juga di chat:
1. Status semua fase.
2. Hasil cek silang Yahoo hari pertama, plus tambahan kuota untuk backfill.
3. Sisa disk dan inode, proyeksi kapan penuh, dan format kompresi yang disarankan.
4. Tabel kuota minimum untuk 962 saham penuh, plus ada atau tidaknya endpoint insider massal.
5. Kalau Fase 2 atau 3 sudah jalan: hasil utamanya.
