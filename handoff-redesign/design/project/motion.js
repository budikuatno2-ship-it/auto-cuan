/* Auto-Cuan motion layer v1, vanilla, tanpa library.
   Prinsip: satu listener pointer + satu requestAnimationFrame; hanya transform/opacity/variabel CSS;
   tidak pernah mengubah teks yang dikelola React; mati total saat prefers-reduced-motion. */
(function () {
  if (window.__acMotion) return; window.__acMotion = true;
  /* ---------- tema: otomatis / terang / gelap ---------- */
  var TK = 'ac-theme';
  function sysDark() { return !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches); }
  function themePref() { try { return localStorage.getItem(TK) || 'auto'; } catch (e) { return 'auto'; } }
  function applyTheme(p) {
    var r = document.documentElement; if (p === 'light' || p === 'dark') r.setAttribute('data-theme', p); else r.removeAttribute('data-theme');
    var dark = p === 'dark' || (p !== 'light' && sysDark()); r.classList.toggle('is-dark', dark);
    [].forEach.call(document.querySelectorAll('.thm'), function (b) { b.setAttribute('aria-pressed', String(dark)); b.title = dark ? 'Ganti ke mode terang' : 'Ganti ke mode gelap'; b.setAttribute('aria-label', b.title); });
    try { window.dispatchEvent(new CustomEvent('ac-theme', { detail: { pref: p, dark: dark } })); } catch (e) {}
  }
  window.acTheme = {
    get: themePref, isDark: function () { return document.documentElement.classList.contains('is-dark'); },
    set: function (p) { try { if (p === 'auto') localStorage.removeItem(TK); else localStorage.setItem(TK, p); } catch (e) {} applyTheme(p); }
  };
  applyTheme(themePref());
  if (window.matchMedia) { var mq = window.matchMedia('(prefers-color-scheme: dark)'); var onMq = function () { if (themePref() === 'auto') applyTheme('auto'); }; if (mq.addEventListener) mq.addEventListener('change', onMq); else if (mq.addListener) mq.addListener(onMq); }
  window.addEventListener('storage', function (e) { if (e.key === TK) applyTheme(themePref()); });
  /* tombol .thm ada di markup halaman; klik ditangani lewat delegasi supaya tetap jalan setelah render ulang */
  document.addEventListener('click', function (e) { var b = e.target && e.target.closest ? e.target.closest('.thm') : null; if (!b) return; window.acTheme.set(window.acTheme.isDark() ? 'light' : 'dark'); });
  function mountThemeBtn() { applyTheme(themePref()); return document.querySelectorAll('.thm').length > 0; }
  var RM = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
  var px = -9999, py = -9999, raf = 0, hot = null, mag = null;
  var store = { get: function (k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set: function (k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };
  var sstore = { get: function (k) { try { return sessionStorage.getItem(k); } catch (e) { return null; } }, set: function (k, v) { try { sessionStorage.setItem(k, v); } catch (e) {} } };

  /* Ekspor tabel yang sedang tampil ke CSV. Pemisah titik koma karena Excel berbahasa Indonesia
     memakai koma sebagai desimal. Kolom yang disembunyikan tidak ikut. Mengembalikan jumlah baris data. */
  window.acCSV = function (table, name) {
    if (!table) return 0;
    var vis = function (c) { return getComputedStyle(c).display !== 'none'; };
    var lines = [].slice.call(table.rows).filter(vis).map(function (r) {
      return [].slice.call(r.cells).filter(vis).map(function (c) {
        var inp = c.querySelector('input,select'); var t = inp ? inp.value : c.innerText;
        return '"' + String(t).replace(/\s+/g, ' ').trim().replace(/"/g, '""') + '"';
      }).join(';');
    });
    var blob = new Blob(['﻿' + lines.join('\r\n')], { type: 'text/csv;charset=utf-8' });
    var a = document.createElement('a'); a.href = URL.createObjectURL(blob); a.download = name || 'auto-cuan.csv';
    document.body.appendChild(a); a.click(); setTimeout(function () { URL.revokeObjectURL(a.href); a.remove(); }, 0);
    return Math.max(0, lines.length - 1);
  };

  /* ---------- Si Mata mini ---------- */
  var LINES = {
    'Dashboard': ['Baca kondisi pasar dulu, baru pilih saham.', 'Kotak karantina itu sengaja dipisah. Jangan buru-buru.', 'Breadth jelek? Ukuran posisi dikecilkan saja.'],
    'Screener': ['Lolos gate belum berarti wajib beli.', 'Klik baris untuk lihat alasan lolosnya.', 'R/R di bawah 1,5? Aku sih skip.'],
    'Sektor Hot': ['Sektor panas bisa cepat dingin. Cek volume.', 'Heatmap bagus buat lihat rotasi, bukan buat FOMO.'],
    'Analisis & Chart': ['Rentang wajar itu lebar harga, bukan arah.', 'Data asing sedang dilengkapi sejak 2 Januari. Yang belum ada kutulis belum diarsip.', 'Hover candle, aku ikut lihat angkanya.'],
    'Bandarmologi': ['Broker besar beli belum tentu bandar. Lihat konsistensinya.', 'Cek beberapa hari, bukan satu hari saja.'],
    'Sinyal Intelijen': ['Sinyal basi itu bukan sinyal. Lihat cap waktunya.'],
    'Broker Hunter': ['Mulai dari broker, bukan dari ticker. Asyik, kan?'],
    'Insider': ['Garis relasi itu fakta kepemilikan, bukan gosip.'],
    'Ranking': ['Klik judul kolom buat urutkan. Aku suka yang rapi.'],
    'Financial': ['Pos kosong di sumber tetap kosong. Aku jujur.', 'Laba bersih berbalik negatif? Baca catatan laporannya.'],
    'Struktur Pasar': ['Free float kecil bikin harga gampang digoreng. Hati-hati.'],
    'Pattern Radar': ['Pola mirip bukan berarti hasil mirip. Sudah kuuji.'],
    'Watchlist': ['Watchlist itu niat, bukan posisi.', 'Alert sudah dipasang? Biar aku yang jaga.'],
    'Portfolio': ['Risiko 1% per trade. Tidur tetap nyenyak.', 'Jurnal itu guru paling jujur.'],
    'Track Record': ['Ini rekam jejak sinyal sistem, bukan hasil kamu.'],
    'Kelola Keuangan': ['Catat dulu, belanja kemudian.', 'Dana darurat dulu, baru saham.'],
    'Pusat Akun': ['Kunci API-mu kusimpan, tidak kupamerkan.'],
    'Admin Console': ['Mode admin. Aku pura-pura tidak lihat.', 'Konfirmasi dua kali sebelum maintenance, ya.'],
    'Dashboard Mobile': ['Tap baris untuk lihat detailnya.', 'Bukan rekomendasi beli. Cek dulu rencananya.'],
    'Screener Mobile': ['Geser mode di atas: Konglo, Non-Konglo, Day Trade.', 'R/R di bawah 1,5? Aku sih skip.']
  };
  var COMMON = ['Aku mengawasi data, bukan dompetmu.', 'Stop loss itu sabuk pengaman, bukan tanda kalah.', 'Aku bukan penasihat investasi. Aku cuma mata.', 'Bursa tutup 16.00 WIB. Istirahat juga strategi.'];
  var mm = null, pupil = null, bub = null, used = [], tBub = 0;

  function pick() {
    var t = (document.title || '').replace('&amp;', '&');
    var pool = (LINES[t] || []).concat(COMMON), idx = [];
    for (var i = 0; i < pool.length; i++) if (used.indexOf(pool[i]) < 0) idx.push(i);
    if (!idx.length) { used = []; idx = pool.map(function (x, i) { return i; }); }
    var s = pool[idx[Math.floor(Math.random() * idx.length)]]; used.push(s); return s;
  }
  var tTalk = 0;
  function say(text, ms) {
    if (!bub || mm.classList.contains('off')) return;
    bub.textContent = text; bub.classList.remove('on'); requestAnimationFrame(function () { bub.classList.add('on'); });
    mm.classList.add('talk'); clearTimeout(tTalk); tTalk = setTimeout(function () { mm.classList.remove('talk'); }, Math.min(2600, 500 + text.length * 28));
    clearTimeout(tBub); tBub = setTimeout(function () { bub.classList.remove('on'); }, ms || Math.max(4200, text.length * 70));
  }
  function userName() {
    var el = document.querySelector('.acct b'); var n = el ? el.textContent.trim() : '';
    if (!n) { var h = document.querySelector('h1'); var m = h && /^Halo,\s*(\S+)/.exec(h.textContent.trim()); if (m) n = m[1]; }
    if (!n) return 'Trader'; return n.charAt(0).toUpperCase() + n.slice(1);
  }
  function waktu() {
    var h; try { h = +new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', hour: '2-digit', hour12: false }).format(new Date()); } catch (e) { h = new Date().getHours(); }
    return h < 4 ? 'malam' : h < 11 ? 'pagi' : h < 15 ? 'siang' : h < 18 ? 'sore' : 'malam';
  }
  var GREET = {
    'Dashboard': ['Selamat {w}, {n}! Pasar sudah kubaca. Kandidat hari ini ada di Top 5 Radar.', 'Halo {n}, selamat {w}! Cek kondisi pasar dulu, baru pilih saham, ya.', 'Selamat {w}, {n}! Ingat, karantina itu tempat saham yang sengaja kujauhkan.'],
    'Screener': ['{n}, ini Screener. Klik baris untuk lihat alasan lolos gate.', 'Tiga mode siap, {n}. Konglo, Non-Konglo, atau Day Trade?'],
    'Sektor Hot': ['{n}, sektor mana yang lagi panas? Cek volumenya juga.'],
    'Analisis & Chart': ['Chart siap, {n}. Rentang wajar itu lebar harga, bukan arah.', '{n}, hover candle-nya, aku ikut lihat angkanya.'],
    'Bandarmologi': ['{n}, kita intip siapa yang beli dan siapa yang lepas.'],
    'Sinyal Intelijen': ['Papan bukti terbuka, {n}. Lihat cap waktu tiap sinyal.'],
    'Broker Hunter': ['Mulai dari broker, {n}. Mau buru yang mana?'],
    'Insider': ['{n}, ini peta relasi pengendali. Fakta, bukan gosip.'],
    'Ranking': ['{n}, klik judul kolom buat mengurutkan.'],
    'Financial': ['{n}, laporan keuangan terbuka. Pos kosong tetap kutulis kosong.'],
    'Struktur Pasar': ['{n}, free float kecil bikin harga gampang digoreng. Hati-hati.'],
    'Pattern Radar': ['Mode admin, {n}. Pola mirip belum tentu hasil mirip.'],
    'Watchlist': ['{n}, ini daftar pantauanmu. Niat, bukan posisi.'],
    'Portfolio': ['Portofolio {n} siap. Risiko 1% per trade, tidur tetap nyenyak.'],
    'Track Record': ['{n}, ini rekam jejak sinyal sistem, bukan hasilmu.'],
    'Kelola Keuangan': ['Halo {n}! Catat dulu, belanja kemudian.', '{n}, dana darurat dulu, baru saham.'],
    'Pusat Akun': ['{n}, kunci API-mu kusimpan, tidak kupamerkan.'],
    'Admin Console': ['Halo admin {n}. Konfirmasi dua kali sebelum maintenance, ya.'],
    'Dashboard Mobile': ['Selamat {w}, {n}! Top 5 Radar sudah siap di bawah.'],
    'Screener Mobile': ['{n}, ini Screener versi saku. Tap baris untuk detail.']
  };
  function fill(t) { return t.replace(/\{n\}/g, userName()).replace(/\{w\}/g, waktu()); }
  /* ---------- suasana Si Mata mengikuti perubahan IHSG hari ini ----------
     Halaman menandai angka IHSG dengan data-ihsg-chg (persen). Kalimat menyemangati atau menenangkan,
     tidak pernah menyuruh beli atau jual. */
  var MOOD = {
    up2: { a: 'gembira', v: 1.8, l: ['IHSG hijau {p} hari ini, {n}! Semangat, tapi tetap ikuti rencana. Jangan kejar harga.', 'Pasar lagi cerah, {p}. Senang boleh, buru-buru jangan, {n}.'] },
    up: { a: 'senang', v: 0.6, l: ['IHSG naik {p}. Suasana cerah. Cek kandidatmu dengan tenang, {n}.', 'Hijau tipis {p}, {n}. Pelan-pelan, yang penting sesuai rencana.'] },
    flat: { a: 'tenang', v: 0.1, l: ['IHSG datar hari ini ({p}), {n}. Pasar lagi mikir, kita ikut sabar.', 'Pasar adem {p}, {n}. Hari yang pas untuk merapikan watchlist.'] },
    down: { a: 'khawatir', v: -0.9, l: ['IHSG merah {p}. Tenang, {n}. Cek stop loss posisimu dulu.', 'Hari merah {p}, {n}. Tidak semua hari harus transaksi.'] },
    down2: { a: 'cemas', v: -3.2, l: ['IHSG turun dalam {p}. Tarik napas dulu, {n}. Keputusan tidak harus sekarang.', 'Hari berat, {n} ({p}). Pegang rencana, jangan ambil keputusan karena panik.'] }
  };
  function moodOf(c) { return c >= 1.5 ? 'up2' : c >= 0.3 ? 'up' : c > -0.3 ? 'flat' : c > -1.5 ? 'down' : 'down2'; }
  function ihsgChg() { var e = document.querySelector('[data-ihsg-chg]'); if (!e) return null; var v = parseFloat(e.getAttribute('data-ihsg-chg')); return isFinite(v) ? v : null; }
  function pctTxt(c) { return (c >= 0 ? '+' : '−') + Math.abs(c).toFixed(2).replace('.', ',') + '%'; }
  function setMood(m, c, talk) {
    if (!mm) return; mm.setAttribute('data-mood', m || ''); var eye = mm.querySelector('.mm-eye');
    if (eye) eye.setAttribute('aria-label', 'Si Mata' + (m ? ', suasana ' + MOOD[m].a : '') + ', klik untuk tips');
    if (m === 'up2' && eye && !RM) { eye.classList.remove('hop'); requestAnimationFrame(function () { eye.classList.add('hop'); }); setTimeout(function () { eye.classList.remove('hop'); }, 900); }
    if (talk && m) { var L = MOOD[m].l; say(fill(L[Math.floor(Math.random() * L.length)]).replace('{p}', pctTxt(c)), 7000); }
  }
  function greet() {
    var c = ihsgChg(); if (c !== null) { setMood(moodOf(c), c, true); return; }
    var t = (document.title || '').replace('&amp;', '&'), g = GREET[t] || ['Halo {n}! Aku ikut lihat halaman ini.'];
    say(fill(g[Math.floor(Math.random() * g.length)]), 6000);
  }
  /* ngomong saat pindah tab di dalam halaman */
  var TAB = [
    [/akumulasi/i, 'Akumulasi broker: lihat yang konsisten, bukan yang paling besar sehari.'],
    [/^Online/i, 'Siapa yang sedang online. Hanya admin yang bisa lihat ini.'],
    [/broker summary/i, 'Ringkasan broker: pembeli dan penjual terbesar hari itu.'],
    [/laba rugi/i, 'Laba rugi: lihat tren laba bersih, bukan satu kuartal saja.'],
    [/neraca/i, 'Neraca: aset, kewajiban, dan ekuitas. Ekuitas kosong = PBV tidak kuhitung.'],
    [/arus kas/i, 'Arus kas operasi positif itu tanda bisnisnya benar-benar menghasilkan uang.'],
    [/rasio/i, 'Rasio kuartalan tidak kusetahunkan. Bandingkan kuartal ke kuartal.'],
    [/kuartalan/i, 'Kuartalan: tiap kolom nilai 3 bulan, bukan kumulatif.'],
    [/tahunan/i, 'Tahunan: periode 12 bulan yang sudah diaudit.'],
    [/non-?konglo/i, 'Non-Konglo: saham di luar grup besar. Likuiditasnya cek dulu.'],
    [/konglo/i, 'Konglo: grup besar, geraknya sering barengan. Jangan dobel posisi.'],
    [/day trade/i, 'Day Trade: cepat masuk, cepat keluar. Stop loss wajib.'],
    [/analisis ai/i, 'Analisis AI: interpretasi, bukan data sumber. Tetap cek angkanya.'],
    [/chart workstation/i, 'Kembali ke chart. Aku pegang crosshair-nya.'],
    [/aktif dipantau/i, 'Sinyal yang masih jalan. Aku jaga sampai TP atau SL.'],
    [/riwayat/i, 'Riwayat: yang sudah selesai, kena TP atau tidak.'],
    [/^(1D|1W)$/i, 'Timeframe diganti. Indikator kuhitung ulang.'],
    [/^(3B|6B|1T|Semua)$/i, 'Rentang chart diganti.'],
    [/^(Simpel|Scalping|Swing|Investor|Pro)$/i, 'Mode {l}: layer chart kusesuaikan.']
  ];
  var GEN = ['Oke, pindah ke {l}.', '{l}? Siap, aku ikut lihat.', 'Sip, {l} terbuka.'];
  var tTab = 0;
  function tabTalk(e) {
    var b = e.target && e.target.closest ? e.target.closest('.segx button, .utabs button, .utabs a, .ptab, .tchip, .rng, .mbtn') : null;
    if (!b || !mm || mm.classList.contains('off')) return;
    var l = (b.textContent || '').replace(/\s+/g, ' ').trim(); if (!l || l.length > 40) return;
    var line = null;
    if (b.classList.contains('tchip') && /^[A-Z]{4}$/.test(l)) line = l + ' dibuka. Sumber data selalu kutulis di bawah angkanya.';
    for (var i = 0; !line && i < TAB.length; i++) if (TAB[i][0].test(l)) line = TAB[i][1].replace('{l}', l);
    if (!line) line = GEN[Math.floor(Math.random() * GEN.length)].replace('{l}', l);
    clearTimeout(tTab); tTab = setTimeout(function () { say(line); }, 260);
  }
  function buildMascot() {
    if (mm || !document.querySelector('.app .side, .bn')) return !!mm;
    mm = document.createElement('div'); mm.className = 'mm';
    if (store.get('ac-mata-off') === '1') mm.classList.add('off');
    mm.innerHTML =
      '<div class="mm-bub" role="status" aria-live="polite"></div>' +
      '<button class="mm-eye" aria-label="Si Mata, klik untuk tips"><svg viewBox="0 0 120 120" aria-hidden="true"><g class="mm-body"><path d="M60 12c29 0 50 21 50 50 0 27-21 46-50 46S10 89 10 62 31 12 60 12z" fill="#0E1714"/><path d="M44 16l8-9 7 6 9-10" fill="none" stroke="#34D399" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><ellipse cx="41" cy="56" rx="15" ry="17" fill="#F6F7F5"/><ellipse cx="79" cy="56" rx="15" ry="17" fill="#F6F7F5"/><g class="mm-pupil"><circle cx="41" cy="57" r="8" fill="#13785D"/><circle cx="41" cy="57" r="4" fill="#0E1714"/><circle cx="44" cy="53.5" r="2.2" fill="#fff"/></g><g class="mm-pupil"><circle cx="79" cy="57" r="8" fill="#13785D"/><circle cx="79" cy="57" r="4" fill="#0E1714"/><circle cx="82" cy="53.5" r="2.2" fill="#fff"/></g><g class="mm-lid"><path d="M26 56c0-10 7-17 15-17s15 7 15 17c0 0-7 17-15 17S26 56 26 56z" fill="#0E1714"/><path d="M64 56c0-10 7-17 15-17s15 7 15 17c0 0-7 17-15 17S64 56 64 56z" fill="#0E1714"/></g><ellipse cx="27" cy="80" rx="7" ry="4" fill="#34D399" opacity=".28"/><ellipse cx="93" cy="80" rx="7" ry="4" fill="#34D399" opacity=".28"/><g class="mm-brow"><path class="b-up" d="M29 34q11-7 22 0M69 34q11-7 22 0"/><path class="b-wo" d="M30 38L51 31M69 31L90 38"/></g><path class="m-big" d="M47 81q13 15 26 0z"/><path class="m-flat" d="M52 87h16"/><path class="m-frown" d="M51 91q9-8 18 0"/><path class="m-sweat" d="M98 29q7 10 0 16q-7-6 0-16z"/><path class="mm-smile" d="M51 84q9 8 18 0" fill="none" stroke="#34D399" stroke-width="3.5" stroke-linecap="round"/><ellipse class="mm-mouth" cx="60" cy="86" rx="6" ry="4.5" fill="#34D399"/></g></svg></button>' +
      '<button class="mm-x" aria-label="Sembunyikan Si Mata">×</button>' +
      '<button class="mm-mini" aria-label="Panggil Si Mata">Si Mata</button>';
    document.body.appendChild(mm);
    pupil = mm.querySelectorAll('.mm-pupil'); bub = mm.querySelector('.mm-bub');
    mm.querySelector('.mm-eye').addEventListener('click', function () {
      var e = mm.querySelector('.mm-eye'); e.classList.remove('boop'); void e.offsetWidth; e.classList.add('boop'); say(pick());
    });
    mm.querySelector('.mm-x').addEventListener('click', function () { mm.classList.add('off'); bub.classList.remove('on'); store.set('ac-mata-off', '1'); });
    mm.querySelector('.mm-mini').addEventListener('click', function () { mm.classList.remove('off'); store.set('ac-mata-off', '0'); say('Aku kembali. Rindu, ya?'); });
    setTimeout(greet, 1100);
    return true;
  }

  /* ---------- frame: spotlight kartu, magnet tombol utama, pupil ---------- */
  /* Semua pembacaan posisi dilakukan dulu, baru penulisan; posisi mata maskot di-cache (fixed),
     jadi tidak ada layout paksa di setiap frame. Efek sorotan kartu dihapus: ia memaksa hitung ulang
     gaya seluruh isi kartu (termasuk chart) di setiap gerakan mouse. */
  var eyeR = null, tgt = null;
  window.addEventListener('resize', function () { eyeR = null; }, { passive: true });
  function frame() {
    raf = 0;
    var b = tgt && tgt.closest ? tgt.closest('.btn.p, [data-mag]') : null, q = b ? b.getBoundingClientRect() : null;
    var eyeOn = pupil && mm && !mm.classList.contains('off'), e = null;
    if (eyeOn) { if (!eyeR) { var el = mm.querySelector('.mm-eye'); eyeR = el ? el.getBoundingClientRect() : null; } e = eyeR; }
    if (mag && mag !== b) { mag.style.translate = ''; }
    if (b && q) { b.style.translate = ((px - q.left - q.width / 2) * 0.18).toFixed(1) + 'px ' + ((py - q.top - q.height / 2) * 0.28).toFixed(1) + 'px'; }
    mag = b;
    if (e) {
      var cx = e.left + e.width / 2, cy = e.top + e.height * 0.47, dx = px - cx, dy = py - cy, d = Math.hypot(dx, dy) || 1, k = Math.min(1, d / 260);
      var tr = 'translate(' + (dx / d * 6.5 * k).toFixed(1) + ' ' + (dy / d * 6 * k).toFixed(1) + ')';
      if (tr !== frame.last) { frame.last = tr; pupil.forEach(function (p) { p.setAttribute('transform', tr); }); }
      var nr = d < 70; if (nr !== frame.near) { frame.near = nr; mm.classList.toggle('near', nr); }
    }
  }

  /* ---------- angka berubah: kedip hijau/merah (hanya membaca, tidak menulis teks) ---------- */
  function parseNum(s) { var m = String(s || '').replace(/[^\d,.\-−]/g, '').replace(/\./g, '').replace(',', '.').replace('−', '-'); var n = parseFloat(m); return isFinite(n) ? n : null; }
  function watchNumbers() {
    if (!('MutationObserver' in window)) return;
    var budget = 0, last = 0;
    new MutationObserver(function (muts) {
      var now = performance.now(); if (now - last > 250) { budget = 24; last = now; }
      for (var i = 0; i < muts.length && budget > 0; i++) {
        var m = muts[i]; if (m.type !== 'characterData') continue;
        var host = m.target.parentElement; if (!host || host.closest('svg') || !host.closest('.num, .big')) continue;
        var a = parseNum(m.oldValue), z = parseNum(m.target.data); if (a === null || z === null || a === z) continue;
        var t = host.closest('.num, .big'); budget--;
        if (t.animate) t.animate([{ color: z > a ? 'var(--ac-pos)' : 'var(--ac-neg)', offset: 0 }], { duration: 700, easing: 'ease-out' });
      }
    }).observe(document.body, { subtree: true, characterData: true, characterDataOldValue: true });
  }

  /* ---------- ripple saat tombol ditekan ---------- */
  function ripple(e) {
    var b = e.target && e.target.closest ? e.target.closest('.btn, .segx button, .tchip, .ptab, .rng, .qp, .mbtn') : null; if (!b) return;
    var r = b.getBoundingClientRect(); b.style.setProperty('--rx', (e.clientX - r.left) + 'px'); b.style.setProperty('--ry', (e.clientY - r.top) + 'px');
    b.removeAttribute('data-rip'); requestAnimationFrame(function () { b.setAttribute('data-rip', ''); clearTimeout(b.__rt); b.__rt = setTimeout(function () { b.removeAttribute('data-rip'); }, 650); });
  }

  /* ---------- pratinjau status data (alat review desain) ----------
     Setiap halaman data punya tiga keadaan selain normal: kosong, memuat, gagal.
     Panel ini menimpa area konten dengan posisi fixed, jadi DOM milik React tidak disentuh. */
  var ST = {
    'Dashboard': { e: ['Belum ada kandidat yang lolos gate hari ini', 'Sistem sudah memindai seluruh emiten dan tidak ada yang memenuhi semua syarat. Saat pasar lemah, ini wajar.', 'Buka Screener', 'Screener.dc.html'], l: 'Memuat kondisi pasar dan Top 5 Radar dari pindaian terakhir', f: 'Pindaian 17.10 WIB belum masuk' },
    'Screener': { e: ['Tidak ada kandidat di mode ini', 'Belum ada saham yang lolos gate Swing atau Day Trade untuk sesi ini. Coba mode lain atau cek lagi setelah 17.10 WIB.', 'Lihat Watchlist', 'Watchlist.dc.html'], l: 'Memuat hasil pindaian tiga mode screener', f: 'Hasil screener gagal dimuat' },
    'Sektor Hot': { e: ['Belum ada data rotasi grup', 'Data rotasi dihitung setelah bursa tutup. Halaman ini terisi mulai 17.00 WIB.', 'Buka Dashboard', 'Main.dc.html'], l: 'Memuat rotasi grup konglomerat', f: 'Data rotasi grup gagal dimuat' },
    'Analisis & Chart': { e: ['Candle untuk ticker ini belum tersedia', 'Emiten baru atau sedang disuspensi biasanya belum punya riwayat 20 sesi. Indikator tidak dihitung tanpa riwayat.', 'Pilih ticker lain di Screener', 'Screener.dc.html'], l: 'Memuat 500 sesi candle harian', f: 'Candle harian gagal dimuat' },
    'Bandarmologi': { e: ['Belum ada ringkasan broker untuk tanggal ini', 'Broker summary terbit setelah 17.00 WIB. Untuk hari libur bursa, datanya memang tidak ada.', 'Pilih tanggal kemarin', ''], l: 'Memuat ringkasan broker dan aliran asing', f: 'Ringkasan broker gagal dimuat' },
    'Sinyal Intelijen': { e: ['Belum ada sinyal baru', 'Sinyal muncul saat beberapa bukti mengarah ke hal yang sama. Hari ini belum ada yang memenuhi.', 'Buka Track Record', 'TrackRecord.dc.html'], l: 'Memuat papan bukti sinyal', f: 'Papan sinyal gagal dimuat' },
    'Broker Hunter': { e: ['Broker ini belum aktif hari ini', 'Tidak ada transaksi bersih yang tercatat untuk broker terpilih pada sesi ini.', 'Pilih broker lain', ''], l: 'Memuat posisi bersih broker', f: 'Data broker gagal dimuat' },
    'Insider': { e: ['Belum ada data kepemilikan', 'Laporan kepemilikan emiten ini belum tersedia di sumber. Relasi tidak digambar tanpa data.', 'Buka Struktur Pasar', 'StrukturPasar.dc.html'], l: 'Memuat jejaring pengendali dan insider', f: 'Data kepemilikan gagal dimuat' },
    'Ranking': { e: ['Tidak ada emiten yang cocok', 'Filter preset ini tidak menyisakan emiten. Ganti preset atau kosongkan pencarian.', 'Kembali ke Semua', ''], l: 'Memuat ranking harian seluruh emiten', f: 'Ranking harian gagal dimuat' },
    'Financial': { e: ['Laporan keuangan belum tersedia', 'Emiten ini belum punya laporan per periode di cakupan data. Pos tidak diisi angka nol.', 'Pilih BRPT', 'Financial.dc.html'], l: 'Memuat laporan keuangan per periode', f: 'Laporan keuangan gagal dimuat' },
    'Struktur Pasar': { e: ['Belum ada snapshot struktur pasar', 'Free Float dan HSC diperbarui dari snapshot IDX. Snapshot pertama belum masuk.', 'Buka Dashboard', 'Main.dc.html'], l: 'Memuat snapshot Free Float dan HSC', f: 'Snapshot struktur pasar gagal dimuat' },
    'Pattern Radar': { e: ['Belum pernah dipindai', 'Jalankan pindaian pertama untuk mencari pola serupa di seluruh emiten.', 'Mulai pindai', ''], l: 'Memindai pola di seluruh emiten', f: 'Pindaian pola berhenti di tengah jalan' },
    'Watchlist': { e: ['Watchlist masih kosong', 'Tambahkan saham dari Screener atau Chart dengan tombol bintang. Alert Telegram ikut aktif.', 'Cari di Screener', 'Screener.dc.html'], l: 'Memuat watchlist dan harga terakhir', f: 'Watchlist gagal dimuat' },
    'Portfolio': { e: ['Belum ada posisi yang dicatat', 'Portofolio di sini catatan mandiri, bukan sambungan ke sekuritas. Mulai dari rencana posisi.', 'Buat rencana posisi', ''], l: 'Memuat posisi dan harga terakhir', f: 'Harga terakhir gagal diperbarui' },
    'Track Record': { e: ['Belum ada sinyal yang selesai', 'Track Record terisi setelah sinyal pertama kena TP atau SL.', 'Lihat sinyal aktif', ''], l: 'Memuat riwayat sinyal sistem', f: 'Riwayat sinyal gagal dimuat' },
    'Kelola Keuangan': { e: ['Belum ada anggaran bulan ini', 'Mulai dari pos bulan lalu supaya tidak mengetik ulang.', 'Pilih bulan', ''], l: 'Memuat lembar anggaran', f: 'Lembar anggaran gagal dimuat' },
    'Pusat Akun': { e: ['Profil belum lengkap', 'Hubungkan Telegram untuk verifikasi dan alert.', 'Buka Keamanan', ''], l: 'Memuat pengaturan akun', f: 'Pengaturan akun gagal dimuat' },
    'Admin Console': { e: ['Tidak ada permintaan akun yang menunggu', 'Semua pendaftaran sudah diputuskan.', 'Lihat log audit', ''], l: 'Memuat antrean persetujuan dan status job', f: 'Konsol admin gagal memuat status job' }
  };
  var stBar = null, stPane = null, stMode = 'n';
  function stPlace() {
    if (!stPane) return; var m = document.querySelector('.main'), t = document.querySelector('.main .top'); if (!m) return;
    var r = m.getBoundingClientRect(), top = t ? t.getBoundingClientRect().bottom : r.top;
    stBar.style.left = (r.left + r.width / 2) + 'px';
    stPane.style.left = r.left + 'px'; stPane.style.width = r.width + 'px'; stPane.style.top = Math.max(0, top) + 'px';
  }
  function stSet(mode) {
    stMode = mode; var t = (document.title || '').replace('&amp;', '&'), c = ST[t]; if (!c) return;
    [].forEach.call(stBar.querySelectorAll('button'), function (b) { b.setAttribute('aria-pressed', b.dataset.m === mode ? 'true' : 'false'); });
    if (mode === 'n') { stPane.hidden = true; return; }
    var h = '';
    if (mode === 'e') h = '<div class="stp-box"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M4 7h16M4 12h10M4 17h6"/></svg><b>' + c.e[0] + '</b><p>' + c.e[1] + '</p>' + (c.e[3] ? '<a class="btn p sm" href="' + c.e[3] + '">' + c.e[2] + '</a>' : '<button class="btn p sm" data-st="n">' + c.e[2] + '</button>') + '</div>';
    if (mode === 'l') h = '<div class="stp-load" role="status"><span class="spin2" aria-hidden="true"></span>' + c.l + '…</div><div class="stp-sk" aria-hidden="true"><i></i><i></i><i></i><i></i><i></i><i></i></div>';
    if (mode === 'f') h = '<div class="stp-box err" role="alert"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 8v5M12 16.5v.5M10.3 3.9L2.4 18a2 2 0 001.7 3h15.8a2 2 0 001.7-3L13.7 3.9a2 2 0 00-3.4 0z"/></svg><b>' + c.f + '</b><p>Koneksi ke server data terputus. Data terakhir yang tersimpan (16 Okt 2026, 16.05 WIB) tetap bisa dibuka. Tidak ada angka yang ditebak.</p><div style="display:flex;gap:8px;justify-content:center"><button class="btn p sm" data-st="retry">Coba lagi</button><button class="btn sm" data-st="n">Buka data terakhir</button></div></div>';
    stPane.innerHTML = h; stPane.hidden = false; stPlace();
    say(mode === 'e' ? 'Kosong itu bukan error. Memang belum ada datanya.' : mode === 'l' ? 'Sebentar, datanya lagi kuambil.' : 'Server data lagi bermasalah. Aku nggak akan menebak angka.');
  }
  function buildStates() {
    var t = (document.title || '').replace('&amp;', '&'); if (stBar || !ST[t]) return;
    stBar = document.createElement('div'); stBar.className = 'stp-bar'; stBar.setAttribute('role', 'group'); stBar.setAttribute('aria-label', 'Pratinjau status data (alat review desain)');
    stBar.innerHTML = '<span>Pratinjau status</span><button data-m="n" aria-pressed="true">Normal</button><button data-m="e" aria-pressed="false">Kosong</button><button data-m="l" aria-pressed="false">Memuat</button><button data-m="f" aria-pressed="false">Gagal</button>' +
      (ihsgChg() !== null ? '<i class="stp-sep" aria-hidden="true"></i><span>Si Mata · IHSG</span>' + [['up2', 'Naik kuat'], ['up', 'Naik'], ['flat', 'Datar'], ['down', 'Turun'], ['down2', 'Anjlok']].map(function (x) { return '<button data-mood="' + x[0] + '" aria-pressed="false">' + x[1] + '</button>'; }).join('') : '');
    stPane = document.createElement('div'); stPane.className = 'stp'; stPane.hidden = true;
    document.body.appendChild(stPane); document.body.appendChild(stBar);
    stBar.addEventListener('click', function (e) { var b = e.target.closest('button'); if (!b) return;
      if (b.dataset.mood) { var m = b.dataset.mood; [].forEach.call(stBar.querySelectorAll('[data-mood]'), function (x) { x.setAttribute('aria-pressed', String(x === b)); }); if (mm && mm.classList.contains('off')) { mm.classList.remove('off'); } setMood(m, MOOD[m].v, true); return; }
      stSet(b.dataset.m); });
    stPane.addEventListener('click', function (e) {
      var b = e.target.closest('[data-st]'); if (!b) return;
      if (b.dataset.st === 'retry') { stSet('l'); setTimeout(function () { if (stMode === 'l') stSet('n'); }, 1400); } else stSet('n');
    });
    document.addEventListener('keydown', function (e) { if (e.key === 'Escape' && stMode !== 'n') stSet('n'); });
    window.addEventListener('resize', stPlace); stPlace(); setTimeout(stPlace, 400); setTimeout(stPlace, 1500);
    if ('ResizeObserver' in window) { var mEl = document.querySelector('.main'); if (mEl) new ResizeObserver(stPlace).observe(mEl); }
  }

  /* ---------- tab bawah untuk layar ponsel (<= 760px) (sama dengan desain Mobile) ---------- */
  function buildTabbar() {
    var side = document.querySelector('.app .side'); if (!side || document.querySelector('.mtab')) return;
    [].forEach.call(side.querySelectorAll('.nav'), function (n) { if (!n.title) n.title = n.textContent.replace(/\d+$/, '').trim(); });
    var on = side.querySelector('.nav.on'), cur = on ? on.getAttribute('href') : '';
    var I = { d: '<path d="M3 3h7v7H3zM14 3h7v4h-7zM14 11h7v10h-7zM3 14h7v7H3z"/>', s: '<path d="M3 5h18l-7 8v6l-4 2v-8z"/>', w: '<path d="M12 3l2.7 5.6 6.1.9-4.4 4.3 1 6.1L12 17l-5.4 2.9 1-6.1L3.2 9.5l6.1-.9z"/>', m: '<path d="M4 7h16M4 12h16M4 17h16"/>' };
    var items = [['Main.dc.html', 'Dashboard', I.d], ['Screener.dc.html', 'Screener', I.s], ['Watchlist.dc.html', 'Watchlist', I.w]];
    var known = items.some(function (x) { return x[0] === cur; });
    var t = document.createElement('nav'); t.className = 'mtab'; t.setAttribute('aria-label', 'Navigasi bawah');
    t.innerHTML = items.map(function (x) { return '<a href="' + x[0] + '"' + (x[0] === cur ? ' class="on" aria-current="page"' : '') + '><svg viewBox="0 0 24 24" aria-hidden="true">' + x[2] + '</svg>' + x[1] + '</a>'; }).join('') +
      '<label for="sbx" tabindex="0" role="button"' + (known ? '' : ' class="on"') + '><svg viewBox="0 0 24 24" aria-hidden="true">' + I.m + '</svg>Lainnya</label>';
    document.body.appendChild(t);
    function sbx() { return document.getElementById('sbx'); }
    t.querySelector('label').addEventListener('keydown', function (e) { var x = sbx(); if ((e.key === 'Enter' || e.key === ' ') && x) { e.preventDefault(); x.checked = !x.checked; } });
    document.addEventListener('keydown', function (e) { var x = sbx(); if (e.key === 'Escape' && x && x.checked && innerWidth < 761) x.checked = false; });
    /* menu tertutup setelah memilih halaman */
    document.addEventListener('click', function (e) { var x = sbx(); if (x && x.checked && innerWidth < 761 && e.target.closest && e.target.closest('.side .nav, .side .acct')) x.checked = false; });
  }

  function start() {
    var tries = 0;
    buildTabbar();
    (function waitT(n) { if (!mountThemeBtn() && n < 40) setTimeout(function () { waitT(n + 1); }, 150); })(0);
    (function wait() { if (!buildMascot() && tries++ < 50) setTimeout(wait, 200); else buildStates(); })();
    document.addEventListener('click', function (e) { if (RM) tabTalk(e); }, true);
    if (RM) return;
    document.addEventListener('pointermove', function (e) { if (e.pointerType === 'touch') return; px = e.clientX; py = e.clientY; tgt = e.target; if (!raf) raf = requestAnimationFrame(frame); }, { passive: true });
    document.addEventListener('pointerleave', function () { px = py = -9999; tgt = null; if (!raf) raf = requestAnimationFrame(frame); });
    document.addEventListener('pointerdown', ripple, { passive: true });
    /* prefetch halaman tujuan saat kursor mendekati tautan menu, supaya pindah halaman terasa instan */
    var pf = {};
    document.addEventListener('pointerover', function (e) { var a = e.target && e.target.closest ? e.target.closest('a[href$=".dc.html"]') : null; if (!a) return; var h = a.getAttribute('href'); if (pf[h]) return; pf[h] = 1;
      var l = document.createElement('link'); l.rel = 'prefetch'; l.href = h; document.head.appendChild(l); }, { passive: true });
    document.addEventListener('click', tabTalk, true);
    watchNumbers();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start); else start();
})();
