# Cara membuka desain di komputer

```
cd handoff-redesign/design/project
python3 -m http.server 8765
```

Buka http://localhost:8765/Main.dc.html (Dashboard). Halaman lain: Screener.dc.html, Analisis.dc.html, Landing.dc.html, dan seterusnya. `canvas.json` berisi daftar papan dan urutannya.

- `support.js` adalah runtime kanvas. Hanya untuk membuka file ini, **jangan** dipakai di repo.
- `ac.css` berisi token dan komponen bersama; `motion.js` berisi motion, Si Mata, tab bawah ponsel, dan salinan teks keadaan kosong/memuat/gagal (objek `ST`).
- Huruf dimuat dari Google Fonts, jadi perlu internet. Di repo, huruf harus di-self-host.
- Versi online (v86): https://claude.ai/artifact/KnvdLe1XveLK2Bcrx7h1QL
