# AUTO-CUAN FULL REPO BUG FINDINGS - FASE 4 (Bandarmologi / Broker / Insider)
Dokumentasi temuan bug Fase 4. Read-only kode produksi, dibuktikan lewat unit test fisik di test/bandarmologi-fase4-bugs.test.js.
Status: BELUM DIPERBAIKI (fase audit murni).

---

### BUG-F4-01: Truthy Array Kosong `gross_buyers` Mengabaikan `top_buyers` pada Broker Hunter
- **Lokasi**: `lib/broker-hunter-service.js:147 & 168`
- **Severity**: HIGH
- **Kutipan Kode**:
  ```javascript
  const buyers = summary.gross_buyers || summary.top_buyers || summary.buyers || [];
  ...
  const sellers = summary.gross_sellers || summary.top_sellers || summary.sellers || [];
  ```
- **Dampak ke User**: Respon API Arjum atau file ringkasan broker summary sering kali menyuplai properti `gross_buyers: []` (array kosong) dan mengisi data pada `top_buyers`. Karena array kosong `[]` bernilai *truthy* dalam evaluasi JavaScript (`[] || summary.top_buyers` bernilai `[]`), pembacaan berhenti pada `gross_buyers`. Akibatnya array `buyers` dan `sellers` kosong, dan fungsi mengembalikan transaksi `null`. Pengguna melihat broker hunter tidak memiliki aktivitas (kosong) padahal data transaksi tersedia di bursa.
- **Bukti Test Nyata**: `test/bandarmologi-fase4-bugs.test.js` - Case `BUG-F4-01`: Objek summary `{ gross_buyers: [], top_buyers: [{ broker: 'AK', bval: 5e9, bvol: 1000 }] }` mengembalikan `null`.
- **Usulan Perbaikan**: Gunakan helper array tidak kosong seperti `firstNonEmptyArray(summary.gross_buyers, summary.top_buyers, summary.buyers)` sebagaimana yang telah diterapkan pada `lib/bandarmologi-service.js`.

---

### BUG-F4-02: `calculateScannerDiscount` Mengembalikan Diskon 100% saat Harga Terakhir Bernilai `null` atau `0`
- **Lokasi**: `lib/bandarmologi-service.js:608-613`
- **Severity**: HIGH
- **Kutipan Kode**:
  ```javascript
  function calculateScannerDiscount(modal, last_price) {
    modal = Number(modal || 0);
    last_price = Number(last_price || 0);
    if (!modal || modal <= 0) return 0;
    return Number((((modal - last_price) / modal) * 100).toFixed(2));
  }
  ```
- **Dampak ke User**: Fungsi hanya memeriksa validitas modal (`if (!modal || modal <= 0)`), tetapi tidak memvalidasi `last_price`. Jika harga pasar terakhir belum terunduh (`null`, `undefined`, atau `0`), evaluasi menghasilkan `(((modal - 0) / modal) * 100) = 100%`. Saham yang datanya tidak lengkap langsung lolos radar sebagai saham berdiskon 100% di bawah modal bandar, memicu sinyal beli palsu pada saham tanpa kuotasi harga.
- **Bukti Test Nyata**: `test/bandarmologi-fase4-bugs.test.js` - Case `BUG-F4-02`: `calculateScannerDiscount(1000, null)` dan `calculateScannerDiscount(1000, 0)` mengembalikan angka `100`.
- **Usulan Perbaikan**: Tambahkan validasi harga terakhir: `if (!modal || modal <= 0 || !last_price || last_price <= 0) return 0;`.

---

### BUG-F4-03: `holding.net_shares_change` Membalik Aksi Jual (`SELL`) Menjadi Akumulasi Beli
- **Lokasi**: `lib/insider-network-service.js:226-231`
- **Severity**: CRITICAL
- **Kutipan Kode**:
  ```javascript
  const change = parseShares(item.shares_change || item.shares || 0);
  const action = String(item.action_type || '').toUpperCase().trim();
  if (action === 'SELL') {
    holding.total_sold += change;
    holding.net_shares_change -= change;
  } else if (action === 'BUY' || action === 'PURCHASE') {
  ```
- **Dampak ke User**: Pada data bursa, perubahan lembar saham untuk aksi penjualan sering kali sudah bernilai negatif (misal `shares_change = -500000`). Operasi `holding.net_shares_change -= change` mengevaluasi `- -500000` menjadi `+500000`, dan `holding.total_sold += change` menjadi `-500000`. Akibatnya aksi distribusi besar-besaran oleh insider tercatat sebagai akumulasi beli (`net_shares_change` bertambah positif), menyesatkan trader mengira investor pengendali sedang memborong saham padahal mereka sedang melepas kepemilikan.
- **Bukti Test Nyata**: `test/bandarmologi-fase4-bugs.test.js` - Case `BUG-F4-03`: Aksi `SELL` dengan `shares_change: -500000` menghasilkan `net_shares_change: 500000` dan `total_sold: -500000`.
- **Usulan Perbaikan**: Pastikan nilai perubahan selalu bernilai absolut (`const change = Math.abs(parseShares(...))`) sebelum melakukan penambahan/pengurangan saldo.

---

### BUG-F4-04: `parsePercentage` Menghapus Koma Desimal Indonesia ("5,25%" Menjadi 525%)
- **Lokasi**: `lib/insider-network-service.js:87`
- **Severity**: CRITICAL
- **Kutipan Kode**:
  ```javascript
  const clean = String(val).replace(/[%,\s]/g, '').trim();
  const num = parseFloat(clean);
  return isNaN(num) ? null : num;
  ```
- **Dampak ke User**: Karakter koma dihapus secara mentah tanpa dikonversi ke titik desimal. Laporan keterbukaan informasi BEI yang menggunakan notasi desimal Indonesia (`"5,25%"`) dibersihkan menjadi `"525"`, menghasilkan nilai float `525` (525%). Porsi kepemilikan saham insider membengkak secara mustahil melebihi 100%, merusak keabsahan data jejaring insider.
- **Bukti Test Nyata**: `test/bandarmologi-fase4-bugs.test.js` - Case `BUG-F4-04`: `parsePercentage('5,25%')` menghasilkan angka `525`.
- **Usulan Perbaikan**: Ganti tanda koma menjadi titik sebelum pembersihan: `const clean = String(val).replace(',', '.').replace(/[% \t]/g, '').trim();`.

---

### BUG-F4-05: `hasData` Intelijen Selalu Bernilai `true` Karena Perbedaan Properti `s3.sub_type` vs `s3.reason`
- **Lokasi**: `lib/bandarmologi-intel-service.js:1010-1015`
- **Severity**: HIGH
- **Kutipan Kode**:
  ```javascript
  const hasData = Boolean(
    (s1 && s1.reason !== 'NO_DATA') ||
    (s2 && s2.reason !== 'NO_DATA') ||
    (s3 && s3.reason !== 'NO_DATA') ||
    (s4 && s4.reason !== 'NO_DATA')
  );
  ```
- **Dampak ke User**: Fungsi `detectRetailCutlossVsBandar` (s3) mengembalikan `{ sub_type: 'NO_DATA' }` tanpa properti `reason`. Pada evaluasi `hasData`, ekspresi `s3.reason !== 'NO_DATA'` bernilai `true` karena `undefined !== 'NO_DATA'` adalah `true`. Akibatnya, `has_data` selalu dilaporkan `true` bahkan ketika seluruh sinyal intelijen bernilai `NO_DATA`. Antarmuka menampilkan ringkasan data valid kosong padahal emiten tidak memiliki data transaksi bursa.
- **Bukti Test Nyata**: `test/bandarmologi-fase4-bugs.test.js` - Case `BUG-F4-05`: Objek s3 dengan `sub_type: 'NO_DATA'` menghasilkan `s3.reason !== 'NO_DATA'` bernilai `true`.
- **Usulan Perbaikan**: Samakan pengecekan ke properti sub_type dan reason: `(s3 && s3.reason !== 'NO_DATA' && s3.sub_type !== 'NO_DATA')`.

---

### BUG-F4-06: `getHunterTickerMap` Membagi Volume Berbasis Lot Sehingga Harga Modal Melambung 100x
- **Lokasi**: `lib/bandarmologi-intel-service.js:191 & 224`
- **Severity**: HIGH
- **Kutipan Kode**:
  ```javascript
  const avgBuy = (bVal > 0 && bVol > 0) ? Math.round(bVal / bVol) : Number(acc.avg_buy_price || 0);
  ...
  const avgSell = (sVal > 0 && sVol > 0) ? Math.round(sVal / sVol) : Number(dist.avg_sell_price || 0);
  ```
- **Dampak ke User**: Pada berkas indeks broker hunter, `bVol` disimpan dalam satuan lot (1 lot = 100 lembar) sedangkan `acc.avg_buy_price` telah tersimpan dalam harga riil per lembar (misal Rp 500). Kode mengutamakan pembagian `bVal / bVol` yang menghasilkan harga Rupiah per lot (Rp 50.000) dan membuang `avg_buy_price`. Modal rata-rata broker menjadi 100x lipat lebih tinggi dari harga wajar saham, memicu sinyal palsu bahwa saham sedang terdiskon sangat masif di bawah modal bandar.
- **Bukti Test Nyata**: `test/bandarmologi-fase4-bugs.test.js` - Case `BUG-F4-06`: Pembagian `bVal: 100000000` dengan `bVol: 2000` (lot) menghasilkan rata-rata `50000` bukannya `500`.
- **Usulan Perbaikan**: Utamakan properti yang sudah dinormalisasi: `const avgBuy = Number(acc.avg_buy_price || 0) || (bVal > 0 && bVol > 0 ? Math.round(bVal / (bVol * 100)) : 0);`.

---

### BUG-F4-07: `detectRetailCutlossVsBandar` Mengabaikan Properti `broker_code`
- **Lokasi**: `lib/bandarmologi-intel-service.js:782-783`
- **Severity**: HIGH
- **Kutipan Kode**:
  ```javascript
  const top3Buyers = norm.top_buyers.slice(0, 3).map(b => b.broker);
  const top3Sellers = norm.top_sellers.slice(0, 3).map(s => s.broker);
  ```
- **Dampak ke User**: Data ringkasan transaksi broker bursa sering menggunakan penamaan properti `broker_code`. Karena pemetaan hanya membaca `b.broker`, array kode broker menghasilkan `[undefined, undefined, undefined]`. Pengecekan `INSTITUTIONAL_BROKERS.has(code)` gagal, menghitung jumlah buyer institusi = 0 dan seller ritel = 0. Pola "Bandar Nampung Ritel Cutloss" tidak pernah terdeteksi pada broker summary berskema `broker_code`.
- **Bukti Test Nyata**: `test/bandarmologi-fase4-bugs.test.js` - Case `BUG-F4-07`: Objek summary dengan `broker_code: 'AK'` menghasilkan `inst_buyer_count: 0` dan `is_bandar_nampung: false`.
- **Usulan Perbaikan**: Gunakan fallback standar: `b => String(b.broker || b.broker_code || '').trim().toUpperCase()`.

---

### BUG-F4-08: `parseNumericValue` Memotong Format Ribuan Bertitik Indonesia ("1.250.000" Menjadi 1.25)
- **Lokasi**: `public/bandarmologi-runtime.js:196-208`
- **Severity**: CRITICAL
- **Kutipan Kode**:
  ```javascript
  } else if (cleanStr.indexOf(',') >= 0) {
    if (/^\-?\d+,\d{1,2}$/.test(cleanStr)) {
      cleanStr = cleanStr.replace(',', '.');
    } else {
      cleanStr = cleanStr.replace(/,/g, '');
    }
  }
  cleanStr = cleanStr.replace(/[^\d.-]/g, '');
  var n = parseFloat(cleanStr);
  ```
- **Dampak ke User**: Fungsi hanya mendeteksi pemisah jika terdapat koma `,`. Pada angka Indonesia dengan pemisah ribuan bertitik tanpa koma (seperti nominal `"1.250.000"` atau `"50.000"`), tanda titik tidak dibersihkan. Pemanggilan `parseFloat("1.250.000")` menganggap titik pertama sebagai desimal dan memotong sisa angka, menghasilkan nilai `1.25` dan `50` (terpotong 1.000x hingga 1.000.000x lipat). Nilai transaksi broker di kartu antarmuka menjadi rusak total.
- **Bukti Test Nyata**: `test/bandarmologi-fase4-bugs.test.js` - Case `BUG-F4-08`: Parsing `"1.250.000"` menghasilkan `1.25`.
- **Usulan Perbaikan**: Tambahkan pengecekan pemisah ribuan bertitik: jika string memiliki lebih dari satu titik atau titik diikuti 3 digit angka tanpa koma, bersihkan semua titik sebelum parsing.

---

### BUG-F4-09: Kontradiksi Klasifikasi Broker `CC` dan Kerusakan Perhitungan Rasio Ritel vs Bandar
- **Lokasi**: `public/bandarmologi-runtime.js:1493 & 1499`
- **Severity**: HIGH
- **Kutipan Kode**:
  ```javascript
  var retailCodes = ['YP', 'XL', 'XC', 'PD', 'NI', 'SQ', 'CC'];
  ...
  var effectiveTotalVal = totalMarketBuyVal > 0 ? totalMarketBuyVal : (allBuyersList.length > 0 ? top3Val : 0);
  var bandarVal = Math.max(0, effectiveTotalVal - retailVal);
  ```
- **Dampak ke User**: Broker `CC` (Mandiri Sekuritas, BUMN/Institusi) dideklarasikan sebagai `INSTITUTIONAL_BROKERS` di baris 272, namun pada baris 1493 dimasukkan ke dalam `retailCodes`. Pembelian masif Mandiri Sekuritas dihitung sebagai transaksi ritel. Selain itu, bila `totalMarketBuyVal` tidak tersedia (0), `effectiveTotalVal` hanya diisi oleh `top3Val` sedangkan `retailVal` diakumulasikan dari seluruh daftar broker. Akibatnya `retailVal > top3Val` sehingga `bandarVal` dipaksa ke `0%`. Pengguna disajikan informasi palsu bahwa partisipasi bandar adalah 0% dan ritel 100% padahal 3 broker teratas adalah institusi besar (AK, BK, RX).
- **Bukti Test Nyata**: `test/bandarmologi-fase4-bugs.test.js` - Case `BUG-F4-09`: Pembelian Top 3 sebesar 300 Miliar dengan akumulasi ritel 350 Miliar menghasilkan `bandarVal = 0` dan `bandarPct = 0%`.
- **Usulan Perbaikan**: Hapus `CC` dan `SQ` dari `retailCodes`. Hitung `effectiveTotalVal` dari total akumulasi seluruh broker pembeli yang terdaftar agar sebanding dengan `retailVal`.
