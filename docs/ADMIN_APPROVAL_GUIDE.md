# Admin Manual Approval Guide

## Cara Approve User untuk Fitur Khusus Auto-Cuan

### Prasyarat
- Akses ke Supabase Dashboard project Auto-Cuan
- Role: Project owner atau admin di Supabase

---

### Langkah-langkah Approve User

1. **Buka Supabase Dashboard**
   - URL: https://supabase.com/dashboard
   - Login ke akun yang memiliki akses project Auto-Cuan

2. **Pilih Project Auto-Cuan**

3. **Buka Table Editor**
   - Klik menu **Table Editor** di sidebar kiri

4. **Pilih tabel `profiles`**
   - Di daftar tabel, klik **profiles**

5. **Cari user berdasarkan email**
   - Gunakan filter atau search untuk menemukan email user yang ingin di-approve

6. **Set `is_approved` = `true`**
   - Klik pada row user yang ditemukan
   - Ubah field `is_approved` dari `false` menjadi `true`
   - Klik **Save**

7. **Selesai**
   - User akan langsung mendapatkan akses fitur khusus
   - Tidak perlu restart atau deploy ulang
   - User cukup refresh halaman untuk melihat status "Approved"

---

### Cara Revoke/Cabut Approval

1. Buka Table Editor → profiles
2. Cari user berdasarkan email
3. Set `is_approved` = `false`
4. Save

User akan kehilangan akses fitur khusus secara instan.

---

### Catatan Penting

- **Jangan** ubah field `role` kecuali benar-benar diperlukan
- **Jangan** hapus row di tabel profiles (bisa menyebabkan error auth)
- **Jangan** approve user yang tidak dikenal
- Default semua user baru: `is_approved = false`, `role = 'user'`
- Approval bersifat manual — tidak ada auto-approve
- Tidak ada admin panel UI untuk ini di Phase 13A (manual via Supabase Dashboard)

---

### Verifikasi

Setelah approve, user akan melihat:
- Badge **"Approved"** (hijau) di header Auto-Cuan
- Tooltip: "Akun approved. Fitur khusus aktif."

Sebelum approve, user melihat:
- Badge **"Pending"** (kuning)
- Tooltip: "Akun kamu sudah login, tapi belum approved. Tunggu approval manual admin."

---

### Environment Variables yang Diperlukan

| Variable | Lokasi | Keterangan |
|----------|--------|------------|
| `SUPABASE_URL` | Vercel env | URL project Supabase (sudah ada) |
| `SUPABASE_SERVICE_ROLE_KEY` | Vercel env | Service role key (sudah ada, backend only) |
| `SUPABASE_ANON_KEY` | Vercel env | Public anon key (baru, untuk frontend auth) |

**PENTING:** `SUPABASE_ANON_KEY` harus ditambahkan di Vercel environment variables.
Ini adalah public key yang aman untuk di-expose ke frontend (bukan service_role).

Cara mendapatkan anon key:
1. Supabase Dashboard → Settings → API
2. Copy nilai **anon public** key
3. Tambahkan ke Vercel: Settings → Environment Variables → `SUPABASE_ANON_KEY`
