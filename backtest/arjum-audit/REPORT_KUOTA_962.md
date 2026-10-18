# LAPORAN FASE 1C · RENCANA KUOTA 962 SAHAM PENUH (TETAP SEMUA SAHAM)

**Tanggal Audit:** Minggu, 18 Oktober 2026  
**Batas:** Read-only, tidak ada perubahan kode produksi, crontab, atau env.

---

## 1. Endpoint Insider Massal — Hasil Pengecekan

**Pertanyaan:** Apakah Arjum memiliki endpoint insider seluruh pasar (daftar transaksi orang dalam terbaru untuk semua emiten dalam 1 request)?

### Jawaban: **TIDAK ADA**.

Bukti dari pemeriksaan kode di [`lib/arjum-client.js`](lib/arjum-client.js:627):
```js
async function fetchInsiders(code, page = 1, limit = 15, options = {}) {
  ...
  const res = await fetchArjum(`/api/insiders/${ticker}?page=${p}&limit=${l}`, options);
```

Dokumentasi header pada file yang sama (line 8):
```
* - Insider Transactions (/api/insiders/{code})
```

**Kesimpulan:**
- Endpoint insider Arjum hanya menyediakan **per emiten** (`/api/insiders/{code}`).
- `limit` maksimum **15** (di-clamp oleh kode).
- Tidak ada endpoint `/api/insiders` (tanpa code) atau `/api/insider-transactions/all` di dokumentasi kode.
- Ini berarti **insider tetap memerlukan 1 request per emiten per hari** untuk cakupan penuh 962 saham.

### Strategi Menghemat Insider:
Karena tidak ada endpoint massal, satu-satunya cara menghemat adalah **rolling update**:
- Insider rawan tidak berubah setiap hari. Transaksi insider baru biasanya tertunda 1-2 hari bursa dari tanggal transaksi.
- Strategi: refresh insider pada subset saham per hari (misalnya 300 saham per hari, rotasi 3 hari tuntas 962). Kuota harian: **300 request** (bukan 962).
- Skenario lain: refresh insider hanya untuk saham watchlist likuid (200-300 saham/hari) + refresh penuh mingguan (Sabtu).

Untuk perhitungan minimum di bawah, disediakan **dua opsi insider**:
- **Opsi A (Penuh Harian):** 962 request/hari.
- **Opsi B (Rolling 3 Hari):** 321 request/hari.

---

## 2. Kebutuhan Minimum per Hari untuk 962 Saham Penuh (Setelah Backfill Selesai)

### Komponen Kuota Arjum (Setelah Fase 1A + Fase 2 lolos):

| Komponen | Opsi A (Insider Penuh) | Opsi B (Insider Rolling 3 Hari) | Catatan |
|---|---|---|---|
| **Candle 962 saham** | **0** | **0** | Fase 1A: Yahoo sumber utama |
| **Broksum all 962 saham** | **962** | **962** | Wajib — data broker summary `all_data=true` |
| **Broksum Foreign (hanya hari ada transaksi)** | **~900** | **~900** | Fase 1A: zero-trade skip otomatis untuk hari tanpa volume |
| **IHSG** | **1** | **1** | Canonical index benchmark, tidak bisa diganti |
| **Cek silang Yahoo (20 sampel)** | **20** | **20** | Fase 1A: cek silang harian untuk validasi Yahoo vs Arjum |
| **Akumulasi** | **0** | **0** | **Fase 2: dihitung lokal dari broksum** |
| **Insider** | **962** | **321** | Rolling: 30% universe/hari, full refresh mingguan |
| **Sub-total wajib** | **2.845** | **2.204** | — |
| **Cadangan website (live user)** | **100** | **100** | Estimasi 100 request/hari untuk live search & query pengguna |
| **Cadangan retry 10%** | **285** | **220** | Buffer untuk retry yang gagal karena timeout/5xx |
| **TOTAL KEBUTUHAN HARIAN** | **~3.230** | **~2.524** | — |

---

## 3. Tabel Kuota yang Dibutuhkan vs Fitur yang Tetap Utuh

| Kuota/Hari | Cakupan Saham | Candle | Broksum | Insider | Cek Silang | Fitur |
|---|---|---|---|---|---|---|
| **1.000** | ❌ 962 saham penuh: **TIDAK MUNGKIN** | ✅ Yahoo | ⚠️ Hanya 420 saham likuid (2.300 kurang) | ⚠️ Rolling 10 hari | ✅ 20 | ❌ Broksum untuk 542 saham tidak lengkap → Bandarmologi tidak ada untuk 56% pasar |
| **2.000** | ⚠️ 962 saham penuh: **TIDAK MUNGKIN** | ✅ Yahoo | ⚠️ Hanya 820 saham | ⚠️ Rolling 5 hari | ✅ 20 | ❌ Broksum 142 saham hilang |
| **3.000** | ✅ 962 saham penuh: **MUNGKIN (OPTIMAL)** | ✅ Yahoo | ✅ 962 saham penuh | ⚠️ Rolling 3 hari (Opsi B) | ✅ 20 | ✅ Semua fitur utuh + insider rolling |
| **7.020** | ✅ 962 saham penuh: **SANGAT AMAN** | ✅ Yahoo | ✅ 962 saham penuh | ✅ 962 saham penuh (Opsi A) | ✅ 20 | ✅ Semua fitur utuh + insider penuh harian + cadangan besar |

**Kesimpulan:**
- **Kuota 1.000/hari TIDAK CUKUP** untuk 962 saham penuh tanpa mengurangi jumlah saham.
- **Kuota 2.000/hari TIDAK CUKUP** (kurang ~500).
- **Kuota 3.000/hari** adalah **minimum realistis** untuk operasional penuh 962 saham dengan insider rolling.
- **Kuota 7.020/hari** (rencana Supporter sebelumnya) sangat aman dan juga menutup insider penuh harian.

### Catatan Penting:
Prompt pemilik menyebut harga plan Supporter berakhir dan ada opsi **7.020 request/hari**. Kuota saat ini **18.080** adalah selama paket tambahan +6.020 aktif. Setelah paket tambahan berakhir (dan jika Supporter 7.020 adalah paket dasar), kuota harian akan menjadi 7.020.

---

## 4. Penjaga Kode (Usulan — Belum Diterapkan)

Penjaga kode yang harus ditambahkan setelah persetujuan pemilik:

```js
// lib/quota-guard.js (usulan modul baru)
const MIN_DAILY_QUOTA_FOR_FULL_COVERAGE = 3000; // Opsi B: insider rolling

function guardFullCoverage() {
  const configured = getConfiguredDailyQuota();
  if (configured < MIN_DAILY_QUOTA_FOR_FULL_COVERAGE) {
    // 1. Kirim peringatan ke Admin Console
    console.warn(`[QUOTA-GUARD] Quota ${configured} < minimum ${MIN_DAILY_QUOTA_FOR_FULL_COVERAGE} untuk 962 saham penuh!`);
    console.warn(`[QUOTA-GUARD] JANGAN mengurangi jumlah saham otomatis. Tunggu keputusan pemilik.`);

    // 2. Kirim notifikasi Telegram admin
    sendTelegramAdminAlert({
      subject: 'KUOTA TIDAK CUKUP',
      message: `Kuota harian ${configured} di bawah minimum ${MIN_DAILY_QUOTA_FOR_FULL_COVERAGE}. Sistem tetap memproses 962 saham penuh. Silakan naikkan kuota atau berikan keputusan.`
    });

    // 3. TIDAK ada pengurangan otomatis: semua 962 saham tetap diproses
    return { reduceCoverage: false, warn: true };
  }
  return { reduceCoverage: false, warn: false };
}
```

**Prinsip:** Penjaga kuota **tidak boleh mengurangi jumlah saham otomatis**. Hanya memberi peringatan ke Admin Console dan Telegram, lalu tunggu keputusan pemilik.

---

## 5. Kapan Kuota 1.000/Hari Bisa Dipertimbangkan

Kuota 1.000/hari hanya realistis jika:
1. Backfill selesai lengkap (semua 962 saham × 188 hari).
2. Tidak ada penarikan broksum harian baru (perubahan arsitektur besar: broksum digantikan data lain).
3. Insider berhenti total atau jarang di-refresh.
4. Candle tetap dari Yahoo.

Untuk saat ini, **minimum realistis adalah 3.000/hari**.
