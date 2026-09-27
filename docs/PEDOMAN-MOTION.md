# Auto-Cuan — Pedoman Motion

*(Wajib dibaca setiap kali menambah fitur/komponen baru yang punya animasi apapun)*

**Cara pakai dokumen ini:** ini bukan tutorial, ini rujukan cepat. Sebelum menulis animasi/transisi baru — sekecil apapun (hover, loading, reveal) — cek dulu apakah polanya sudah ada di sini. Kalau ada, pakai persis, jangan bikin variasi baru. Kalau belum ada polanya, selesaikan dulu, **lalu tambahkan ke dokumen ini juga** supaya tetap jadi satu sumber kebenaran — jangan biarkan dokumen ini basi sementara kode terus berubah. Untuk penjelasan lengkap & kode contoh, balik ke dokumen master: *"Auto-Cuan — Design System, Migrasi SPA & Motion"*, §6.

## 1. Token — satu-satunya sumber kebenaran

```css
:root {
  /* durasi */
  --motion-instant: 100ms;   /* checkbox, badge kecil */
  --motion-fast: 180ms;      /* sidebar collapse, tab switch, hover */
  --motion-base: 260ms;      /* modal/dropdown, page transition ringan */
  --motion-slow: 420ms;      /* scroll reveal landing page */

  /* easing */
  --ease-standard: cubic-bezier(0.4, 0, 0.2, 1);    /* default, hampir semua transisi UI */
  --ease-emphasized: cubic-bezier(0.16, 1, 0.3, 1); /* reveal scroll, terasa premium */
  --ease-exit: cubic-bezier(0.4, 0, 1, 1);          /* elemen yang menghilang */
}
```

## 2. Tabel Keputusan — "kalau bikin X, pakai Y"

| Kalau kamu sedang bikin... | Pakai token | Pakai tool | Jangan |
| --- | --- | --- | --- |
| Hover/press state tombol, input | `--motion-instant` / `--motion-fast` + `--ease-standard` | Amicro / interior.dev | Jangan pakai scale/bounce besar |
| Sidebar collapse, tab switch | `--motion-fast` + `--ease-standard` | CSS murni (sudah ada) | Jangan tambah library baru untuk ini |
| Modal, dropdown, tooltip muncul | `--motion-base` + `--ease-standard` (masuk) / `--ease-exit` (keluar) | Animate UI | Jangan animasi masuk & keluar pakai kurva yang sama |
| Scroll reveal (landing page, section baru) | `--motion-slow` + `--ease-emphasized`, stagger 60–80ms antar-child | Motion (utama) / GSAP ScrollTrigger (kalau perlu staggered kompleks) | Jangan reveal semua elemen bersamaan tanpa stagger |
| Angka harga/Net Flow yang live-update | — (animasi digit, bukan durasi tetap) | NumberFlow (default) *atau* Rolling Number — pilih satu, jangan dua | Jangan animasikan seluruh baris tabel |
| Baris tabel data (Insider, Kelola Keuangan) | Tidak ada animasi transisi, hanya `background`/`color` sekilas via `--motion-fast` | CSS `:hover` biasa | **Jangan** fade/slide baris saat refresh data |
| Empty state (belum ada data) | `--motion-base` | Lottie — **sangat terbatas**, hanya di sini | Jangan pakai Lottie di hero/landing, terlalu playful |
| Skeleton loading saat fetch | — | loading.dev | Jangan biarkan skeleton tampil >2 detik tanpa fallback pesan |

## 3. Aturan Anti-AI-Slop (motion)

1. Motion harus fungsional (menandai perubahan state, atau mengarahkan mata saat reveal) — kalau tidak, hapus.
2. Satu jenis transisi = satu kurva easing di semua tempat. Jangan campur `power3.out` GSAP dengan `--ease-emphasized` Motion untuk animasi yang secara konsep sama.
3. Tidak ada parallax berat, tidak ada bounce/elastic easing di aplikasi finansial — kesannya main-main, bukan profesional.
4. Tabel data finansial: performa dan keterbacaan angka di atas segalanya — motion di sini seminimal mungkin.

## 4. Daftar Tools (link cepat)

| Tool | Link | Kapan dipakai |
| --- | --- | --- |
| Motion | [https://motion.dev/](https://motion.dev/) | Default untuk 80% kasus: reveal, transition, micro-interaction |
| GSAP + ScrollTrigger | [https://gsap.com/](https://gsap.com/) | Reveal kompleks/staggered, animasi bubble map Bandarmologi |
| Animate UI | [https://animate-ui.com/](https://animate-ui.com/) | Komponen shadcn siap animasi (accordion, tabs, dialog) |
| NumberFlow | [https://number-flow.barvian.me/](https://number-flow.barvian.me/) | Digit angka harga/Net Flow (pilihan utama) |
| Rolling Number | [https://rolling.kitlangton.dev/](https://rolling.kitlangton.dev/) | Alternatif NumberFlow |
| Amicro | [https://amicro.vercel.app/](https://amicro.vercel.app/) | Micro-interaction tombol |
| interior.dev | [https://www.interior.dev/](https://www.interior.dev/) | Micro-interaction kartu/input |
| loading.dev | [https://loading.dev/](https://loading.dev/) | Skeleton loading |
| Easing Wizard | [https://easingwizard.com/](https://easingwizard.com/) | Referensi visual kurva easing (bukan library kode) |
| Lottie | [https://lottiefiles.com/](https://lottiefiles.com/) | Empty state saja, sangat terbatas |
| Transitions *(belum terverifikasi gratis)* | [https://transitions.dev/](https://transitions.dev/) | Cek pricing dulu sebelum pakai — default tetap Motion |

## 5. Checklist Sebelum Merge/Deploy

- [ ] Tidak ada angka durasi/easing hardcode di luar token `--motion-*`.
- [ ] Sudah dicek di Dark **dan** Light mode.
- [ ] Baris tabel data tidak animasi saat refresh — hanya sel angka.
- [ ] Tidak menambah library motion baru kalau yang sudah ada (Motion/GSAP) bisa menangani.
- [ ] Console browser nol error setelah perubahan.
- [ ] Kalau pola motion ini baru (belum ada di tabel §2 di atas) → sudah ditambahkan ke `docs/PEDOMAN-MOTION.md` juga.
