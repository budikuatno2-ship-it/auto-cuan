# PROMPT: Cek cara hemat kuota: akumulasi dari broksum, candle dari Yahoo, dan cara ambil broksum lebih murah (Roo Code)

> Mode **Code**. Tempel seluruh isi di bawah garis.
> Tugas ini **hanya mengecek dan melapor**. Tidak ada perubahan kode produksi, crontab, atau env, dan tidak ada restart.
> File baru boleh: skrip uji di `tools/check-*.js`, hasil di `backtest/arjum-audit/`, dan staging di `data/arjum-data/_staging/`.

---

## Batas keras

1. **Arjum:**
   - Hanya GET.
   - Maksimal **10 request**, hanya untuk H3.
   - Pakai kuota hanya kalau sisa kuota di atas cadangan sore + 400.
   - Jangan cetak `.env`, kunci, IP VPS, atau lokasi kunci SSH.
2. **Yahoo:** maksimal 30 request, jeda minimal 1 detik.
3. Jangan ganggu worker backfill.
4. Tidak ada angka karangan. Kalau sesuatu tidak tercatat, tulis "tidak tercatat".

---

## H1 · Akumulasi broker dihitung dari broksum: cocok atau tidak?

Tujuan: kalau hasilnya cocok, J1 berhenti memanggil `/api/broker-accumulation` dan hemat sekitar **833 request per hari bursa**.

1. **Pahami dulu keluaran API akumulasi.** Dari file di `data/arjum-data/broker-accumulation/` dan dokumentasi di repo, tulis:
   - periode (berapa hari bursa ke belakang dan sampai tanggal apa);
   - field yang ada: net lot, net nilai, harga rata-rata, jumlah hari net buy, peringkat;
   - apakah semua broker ikut atau hanya top N;
   - apakah asing/domestik dipisah.
2. **Rumus lokal.** Tulis rumus `lib/broker-accumulation-local.js` dalam bahasa biasa. Contohnya:
   - net lot = jumlah (beli − jual) per broker selama periode;
   - harga rata-rata = total nilai beli ÷ total lot beli.
3. **Uji paritas, hanya pada data lengkap:** file all **tidak terpotong** (`all_data=true`) untuk **setiap hari** di periode itu.
   - Pilih minimal 10 saham, campuran likuid dan sedang, termasuk BBCA, BRPT, BBRI, MEDC, dan ADRO.
   - Pilih tanggal yang periodenya sudah lengkap.
   - Bandingkan untuk setiap broker:
     - net lot dan net nilai (harus sama persis, atau selisih ≤ 0,5% karena pembulatan);
     - harga rata-rata (selisih ≤ 1 fraksi harga);
     - urutan 10 broker teratas (harus sama).
4. **Kalau belum cocok, cari sebabnya.** Uji variasi, lalu tulis variasi mana yang membuat cocok:
   - periode ±1 hari;
   - tanggal akhir inklusif atau eksklusif;
   - lot vs lembar;
   - nilai beli saja vs nilai bersih;
   - broker asing/domestik digabung atau dipisah.
5. **Kalau data lengkap belum cukup** (kurang dari 10 saham × periode penuh):
   - tulis kapan cukup, berdasarkan urutan antrean backfill (saham likuid, tanggal terbaru dulu);
   - tulis perintah uji siap tempel untuk dijalankan nanti.
6. **Kesimpulan:**
   - persentase cocok per saham;
   - **lolos** kalau ≥ 99% semua saham, atau **belum lolos**;
   - perkiraan hemat request per minggu.

## H2 · Candle harian saham dari Yahoo: layak atau tidak?

Tujuan: kalau layak, J2 bisa hemat sekitar **962 request per hari bursa**.

1. Bandingkan candle Yahoo (`<KODE>.JK`) dengan candle Arjum yang sudah ada di disk.
   - **Saham:** 20 saham (10 likuid, 5 sedang, 5 sepi), plus 2 saham yang pernah stock split atau right issue tahun ini.
   - **Periode:** 60 hari bursa terakhir.
2. Untuk setiap saham, laporkan:
   - hari yang hilang di Yahoo;
   - selisih O/H/L/C (persen, dan berapa yang di atas 0,5%);
   - selisih volume;
   - satuan volume (lembar atau lot);
   - apakah harga Yahoo sudah disesuaikan aksi korporasi (adjusted).
3. **Waktu tersedia:** jam berapa bar hari ini lengkap di Yahoo setelah bursa tutup. Cek dari data 2–3 hari terakhir, atau dari waktu respons di log Sector Hot dan website.
4. **Risiko:**
   - Yahoo tidak resmi dan bisa memblokir IP VPS;
   - format bisa berubah;
   - batas request.

   Bagaimana kode sekarang menangani Yahoo yang gagal?
5. **Usulan (jangan diterapkan):**
   - Yahoo jadi sumber utama candle saham.
   - Cek silang harian: 20 saham acak lewat Arjum (20 request).
   - Kalau selisih di atas ambang, otomatis kembali ke Arjum untuk hari itu.
   - IHSG tetap dari Arjum (1 request).
   - Kapan sebaiknya diaktifkan: segera, atau saat kuota turun ke 1.000.
6. **Kesimpulan:** layak / layak dengan cek silang / tidak layak.

## H3 · Ambil broksum lebih murah dari Arjum? (maks. 10 request)

Tujuan: memastikan backfill tidak membayar dua kali untuk data yang sama.

1. **Satu request = semua broker?** Pastikan dengan `all_data=true` satu request mengembalikan **semua** broker, berapa pun jumlahnya: 25, 50, atau 90. Bandingkan jumlah broker dengan total nilai transaksi candle hari itu untuk BBCA.
2. **Asing ikut di respons "all"?** Apakah respons `flow=all` punya field per broker yang menandai asing/domestik, atau nilai asing per broker? Kalau ya, request `flow=F` terpisah tidak perlu, dan backfill hemat sekitar 173.000 request.
3. **Data banyak hari dalam satu request?** Apakah endpoint broksum menerima rentang tanggal (`from`/`to`, `days`, `period`) dan mengembalikan data **per hari** (bukan jumlah gabungan)? Kalau ya, berapa hari maksimal per request?
4. Cek juga dokumentasi Arjum di repo atau di halaman dokumentasi yang sudah dipakai kode untuk parameter lain yang relevan.
5. **Untuk setiap temuan "ya":** hitung ulang sisa request backfill dan tanggal selesainya.

## H4 · Ringkasan kuota setelah hemat

Buat tabel kuota per hari kerja dalam 4 kondisi:

| Kondisi | Request J1 + J2 per hari | Jatah backfill per hari | Perkiraan backfill selesai |
|---|---|---|---|
| Sekarang | | | |
| Akumulasi lokal (kalau H1 lolos) | | | |
| + candle Yahoo dengan cek silang (kalau H2 layak) | | | |
| + temuan H3 | | | |

Tambahkan juga kebutuhan minimum per hari **setelah backfill selesai**, untuk rencana kuota 1.000 per hari.

---

## Laporan

Tulis `backtest/arjum-audit/REPORT_HEMAT_KUOTA.md` dalam bahasa Indonesia. Tampilkan juga di chat:
1. H1: rumus API akumulasi yang ditemukan, persentase cocok per saham, lolos atau belum (atau kapan bisa diuji).
2. H2: kesimpulan Yahoo, plus selisih harga dan volume terbesar.
3. H3: jawaban "ya/tidak" untuk ketiga pertanyaan.
4. Tabel H4.
