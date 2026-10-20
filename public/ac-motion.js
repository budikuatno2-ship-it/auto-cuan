/* Auto-Cuan motion layer and Si Mata (redesign v2, HANDOFF §7).
   Port of the canvas motion.js for the SPA. Rules kept from the canvas:
   one pointer listener and one requestAnimationFrame, only transform and
   opacity animate, everything stops under prefers-reduced-motion, and the
   mascot never promises gains or tells anyone to buy or sell.

   Differences from the canvas, on purpose:
   - Number flash tints with an overlay whose opacity animates, instead of
     animating `color` (budget: transform/opacity only).
   - Page changes keep the existing synchronous navigateTo plus the panel
     entrance from canonical-motion.js; a View Transition would make
     navigation asynchronous, and other runtimes read the page right after.
   - The canvas theme, CSV, tape and "Pratinjau status" bar are not here:
     theme lives in index.html, the tape needs a server endpoint, and the
     preview bar is a review tool (HANDOFF §6, §9).
   - Show/hide for Si Mata is stored in localStorage (try/catch); accounts
     have no preference storage yet. */
(function (root) {
  'use strict';
  if (!root || !root.document || root.__AUTOCUAN_AC_MOTION__) return;
  root.__AUTOCUAN_AC_MOTION__ = '20261020-v1';
  var doc = root.document;
  var RM = !!(root.matchMedia && root.matchMedia('(prefers-reduced-motion: reduce)').matches);

  var store = {
    get: function (k) { try { return root.localStorage.getItem(k); } catch (_) { return null; } },
    set: function (k, v) { try { root.localStorage.setItem(k, v); } catch (_) {} }
  };
  var sstore = {
    get: function (k) { try { return root.sessionStorage.getItem(k); } catch (_) { return null; } },
    set: function (k, v) { try { root.sessionStorage.setItem(k, v); } catch (_) {} }
  };

  /* ---------- Si Mata copy (canvas motion.js) ---------- */
  var LINES = {
    'Dashboard': ['Baca kondisi pasar dulu, baru pilih saham.', 'Kotak karantina itu sengaja dipisah. Jangan buru-buru.', 'Breadth jelek? Ukuran posisi dikecilkan saja.'],
    'Screener': ['Lolos gate belum berarti wajib beli.', 'Klik baris untuk lihat alasan lolosnya.', 'R/R di bawah 1,5? Aku sih skip.'],
    'Sektor Hot': ['Sektor panas bisa cepat dingin. Cek volume.', 'Heatmap bagus buat lihat rotasi, bukan buat FOMO.'],
    'Analisis & Chart': ['Rentang wajar itu lebar harga, bukan arah.', 'Data asing yang belum ada kutulis belum diarsip.', 'Hover candle, aku ikut lihat angkanya.'],
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
    'Admin Console': ['Mode admin. Aku pura-pura tidak lihat.', 'Konfirmasi dua kali sebelum maintenance, ya.']
  };
  var COMMON = ['Aku mengawasi data, bukan dompetmu.', 'Stop loss itu sabuk pengaman, bukan tanda kalah.', 'Aku bukan penasihat investasi. Aku cuma mata.', 'Bursa tutup 16.00 WIB. Istirahat juga strategi.'];
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
    'Admin Console': ['Halo admin {n}. Konfirmasi dua kali sebelum maintenance, ya.']
  };
  var MOOD = {
    up2: { a: 'gembira', l: ['IHSG hijau {p} hari ini, {n}! Semangat, tapi tetap ikuti rencana. Jangan kejar harga.', 'Pasar lagi cerah, {p}. Senang boleh, buru-buru jangan, {n}.'] },
    up: { a: 'senang', l: ['IHSG naik {p}. Suasana cerah. Cek kandidatmu dengan tenang, {n}.', 'Hijau tipis {p}, {n}. Pelan-pelan, yang penting sesuai rencana.'] },
    flat: { a: 'tenang', l: ['IHSG datar hari ini ({p}), {n}. Pasar lagi mikir, kita ikut sabar.', 'Pasar adem {p}, {n}. Hari yang pas untuk merapikan watchlist.'] },
    down: { a: 'khawatir', l: ['IHSG merah {p}. Tenang, {n}. Cek stop loss posisimu dulu.', 'Hari merah {p}, {n}. Tidak semua hari harus transaksi.'] },
    down2: { a: 'cemas', l: ['IHSG turun dalam {p}. Tarik napas dulu, {n}. Keputusan tidak harus sekarang.', 'Hari berat, {n} ({p}). Pegang rencana, jangan ambil keputusan karena panik.'] }
  };
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

  // App routes -> canvas page names (the canvas keyed copy by document.title).
  var PAGE_NAMES = {
    dashboard: 'Dashboard', screener: 'Screener', sektor: 'Sektor Hot', watchlist: 'Watchlist',
    portofolio: 'Portfolio', trackrecord: 'Track Record', 'kelola-keuangan': 'Kelola Keuangan'
  };
  var ANALISIS_NAMES = {
    'analisis-chart': 'Analisis & Chart', chart: 'Analisis & Chart', bandarmologi: 'Bandarmologi', intel: 'Sinyal Intelijen',
    hunter: 'Broker Hunter', insider: 'Insider', ranking: 'Ranking', financial: 'Financial',
    'market-structure': 'Struktur Pasar', pattern: 'Pattern Radar'
  };
  function pageName() {
    var page = root.currentPage || '';
    if (page === 'analisis') return ANALISIS_NAMES[root.__ACTIVE_ANALISIS_SUBTAB__ || 'analisis-chart'] || 'Analisis & Chart';
    return PAGE_NAMES[page] || '';
  }

  function moodOf(c) { return c >= 1.5 ? 'up2' : c >= 0.3 ? 'up' : c > -0.3 ? 'flat' : c > -1.5 ? 'down' : 'down2'; }
  function pctTxt(c) { return (c >= 0 ? '+' : '−') + Math.abs(c).toFixed(2).replace('.', ',') + '%'; }
  function waktu() {
    var h;
    try { h = +new Intl.DateTimeFormat('en-GB', { timeZone: 'Asia/Jakarta', hour: '2-digit', hour12: false }).format(new Date()); }
    catch (_) { h = new Date().getHours(); }
    return h < 4 ? 'malam' : h < 11 ? 'pagi' : h < 15 ? 'siang' : h < 18 ? 'sore' : 'malam';
  }
  function userName() {
    var el = doc.getElementById('sidebarUserName');
    var n = el ? String(el.textContent || '').trim() : '';
    if (!n || n.toLowerCase() === 'guest') return 'Trader';
    if (n.indexOf('@') > 0) n = n.split('@')[0];
    return n.charAt(0).toUpperCase() + n.slice(1);
  }
  function fill(t, extra) {
    var s = t.replace(/\{n\}/g, userName()).replace(/\{w\}/g, waktu());
    if (extra) Object.keys(extra).forEach(function (k) { s = s.split('{' + k + '}').join(extra[k]); });
    return s;
  }
  function ihsgChg() {
    var e = doc.querySelector('[data-ihsg-chg]');
    if (!e) return null;
    var v = parseFloat(e.getAttribute('data-ihsg-chg'));
    return isFinite(v) ? v : null;
  }

  /* ---------- Si Mata ---------- */
  var mm = null, pupils = null, bub = null, eye = null, used = [], tBub = 0, tTalk = 0, tTab = 0, eyeRect = null;
  var SVG = '<svg viewBox="0 0 120 120" aria-hidden="true" focusable="false"><g class="mm-body"><path d="M60 12c29 0 50 21 50 50 0 27-21 46-50 46S10 89 10 62 31 12 60 12z" fill="#0E1714"/><path d="M44 16l8-9 7 6 9-10" fill="none" stroke="#34D399" stroke-width="4" stroke-linecap="round" stroke-linejoin="round"/><ellipse cx="41" cy="56" rx="15" ry="17" fill="#F6F7F5"/><ellipse cx="79" cy="56" rx="15" ry="17" fill="#F6F7F5"/><g class="mm-pupil"><circle cx="41" cy="57" r="8" fill="#13785D"/><circle cx="41" cy="57" r="4" fill="#0E1714"/><circle cx="44" cy="53.5" r="2.2" fill="#fff"/></g><g class="mm-pupil"><circle cx="79" cy="57" r="8" fill="#13785D"/><circle cx="79" cy="57" r="4" fill="#0E1714"/><circle cx="82" cy="53.5" r="2.2" fill="#fff"/></g><g class="mm-lid"><path d="M26 56c0-10 7-17 15-17s15 7 15 17c0 0-7 17-15 17S26 56 26 56z" fill="#0E1714"/><path d="M64 56c0-10 7-17 15-17s15 7 15 17c0 0-7 17-15 17S64 56 64 56z" fill="#0E1714"/></g><ellipse cx="27" cy="80" rx="7" ry="4" fill="#34D399" opacity=".28"/><ellipse cx="93" cy="80" rx="7" ry="4" fill="#34D399" opacity=".28"/><g class="mm-brow"><path class="b-up" d="M29 34q11-7 22 0M69 34q11-7 22 0"/><path class="b-wo" d="M30 38L51 31M69 31L90 38"/></g><path class="m-big" d="M47 81q13 15 26 0z"/><path class="m-flat" d="M52 87h16"/><path class="m-frown" d="M51 91q9-8 18 0"/><path class="m-sweat" d="M98 29q7 10 0 16q-7-6 0-16z"/><path class="mm-smile" d="M51 84q9 8 18 0" fill="none" stroke="#34D399" stroke-width="3.5" stroke-linecap="round"/><ellipse class="mm-mouth" cx="60" cy="86" rx="6" ry="4.5" fill="#34D399"/></g></svg>';

  function isOff() { return !mm || mm.classList.contains('off'); }
  function say(text, ms) {
    if (!bub || isOff()) return;
    bub.textContent = text;
    bub.classList.remove('on');
    root.requestAnimationFrame(function () { bub.classList.add('on'); });
    mm.classList.add('talk');
    clearTimeout(tTalk);
    tTalk = setTimeout(function () { mm.classList.remove('talk'); }, Math.min(2600, 500 + text.length * 28));
    clearTimeout(tBub);
    tBub = setTimeout(function () { bub.classList.remove('on'); }, ms || Math.max(4200, text.length * 70));
  }
  function pick() {
    var pool = (LINES[pageName()] || []).concat(COMMON), idx = [];
    for (var i = 0; i < pool.length; i++) if (used.indexOf(pool[i]) < 0) idx.push(i);
    if (!idx.length) { used = []; idx = pool.map(function (x, i) { return i; }); }
    var s = pool[idx[Math.floor(Math.random() * idx.length)]];
    used.push(s);
    return s;
  }
  function setMood(m, c, talk) {
    if (!mm) return;
    mm.setAttribute('data-mood', m || '');
    if (eye) eye.setAttribute('aria-label', 'Si Mata' + (m ? ', suasana ' + MOOD[m].a : '') + ', klik untuk tips');
    if (m === 'up2' && eye && !RM) {
      eye.classList.remove('hop');
      root.requestAnimationFrame(function () { eye.classList.add('hop'); });
      setTimeout(function () { eye.classList.remove('hop'); }, 900);
    }
    if (talk && m) {
      var L = MOOD[m].l;
      say(fill(L[Math.floor(Math.random() * L.length)], { p: pctTxt(c) }), 7000);
    }
  }
  // One greeting per page per browser session, so moving around the app does
  // not turn the mascot into noise.
  function greet() {
    var name = pageName();
    if (!name || isOff()) return;
    var key = 'ac-mata-greeted:' + name;
    if (sstore.get(key) === '1') return;
    sstore.set(key, '1');
    var c = ihsgChg();
    if (c !== null && name === 'Dashboard') { setMood(moodOf(c), c, true); return; }
    var g = GREET[name] || ['Halo {n}! Aku ikut lihat halaman ini.'];
    say(fill(g[Math.floor(Math.random() * g.length)]), 6000);
  }
  function tabTalk(e) {
    if (isOff()) return;
    var b = e.target && e.target.closest ? e.target.closest('[role="tab"], .segx button, .utabs button, .utabs a, .analisis-subtab, .pcc-subtab') : null;
    if (!b) return;
    var l = String(b.textContent || '').replace(/\s+/g, ' ').trim();
    if (!l || l.length > 40) return;
    var line = null;
    for (var i = 0; !line && i < TAB.length; i++) if (TAB[i][0].test(l)) line = TAB[i][1].replace('{l}', l);
    if (!line) line = GEN[Math.floor(Math.random() * GEN.length)].replace('{l}', l);
    clearTimeout(tTab);
    tTab = setTimeout(function () { say(line); }, 260);
  }

  function shellVisible() {
    var screen = doc.getElementById('dashboardScreen');
    var side = doc.getElementById('appSidebar');
    return !!(screen && !screen.classList.contains('hidden') && side && !side.classList.contains('hidden'));
  }
  function buildMascot() {
    if (mm || !doc.body) return;
    mm = doc.createElement('div');
    mm.className = 'mm';
    mm.setAttribute('data-ac-ui', 'v2');
    if (store.get('ac-mata-off') === '1') mm.classList.add('off');
    mm.innerHTML =
      '<div class="mm-bub" role="status" aria-live="polite"></div>' +
      '<button type="button" class="mm-eye" aria-label="Si Mata, klik untuk tips">' + SVG + '</button>' +
      '<button type="button" class="mm-x" aria-label="Sembunyikan Si Mata">×</button>' +
      '<button type="button" class="mm-mini" aria-label="Panggil Si Mata">Si Mata</button>';
    doc.body.appendChild(mm);
    pupils = mm.querySelectorAll('.mm-pupil');
    bub = mm.querySelector('.mm-bub');
    eye = mm.querySelector('.mm-eye');
    eye.addEventListener('click', function () {
      if (eye.animate && !RM) eye.querySelector('.mm-body').animate(
        [{ transform: 'scale(1)' }, { transform: 'scale(.86,1.1)', offset: 0.35 }, { transform: 'scale(1.08,.94)', offset: 0.7 }, { transform: 'scale(1)' }],
        { duration: 520, easing: 'cubic-bezier(.34,1.45,.64,1)' });
      say(pick());
    });
    mm.querySelector('.mm-x').addEventListener('click', function () {
      mm.classList.add('off'); bub.classList.remove('on'); store.set('ac-mata-off', '1');
    });
    mm.querySelector('.mm-mini').addEventListener('click', function () {
      mm.classList.remove('off'); store.set('ac-mata-off', '0'); say('Aku kembali. Rindu, ya?');
    });
    syncVisibility();
  }
  function syncVisibility() {
    if (!mm) return;
    var show = shellVisible();
    mm.hidden = !show;
    if (show) setTimeout(greet, 1100);
  }

  /* ---------- pointer frame: magnet + pupils (read first, then write) ---------- */
  var px = -9999, py = -9999, raf = 0, tgt = null, mag = null, lastTr = '', lastNear = null;
  root.addEventListener('resize', function () { eyeRect = null; }, { passive: true });
  function frame() {
    raf = 0;
    var b = tgt && tgt.closest ? tgt.closest('[data-mag]') : null;
    var q = b ? b.getBoundingClientRect() : null;
    var eyeOn = pupils && mm && !mm.hidden && !mm.classList.contains('off');
    if (eyeOn && !eyeRect && eye) eyeRect = eye.getBoundingClientRect();
    if (mag && mag !== b) mag.style.translate = '';
    if (b && q) b.style.translate = ((px - q.left - q.width / 2) * 0.18).toFixed(1) + 'px ' + ((py - q.top - q.height / 2) * 0.28).toFixed(1) + 'px';
    mag = b;
    if (eyeOn && eyeRect) {
      var cx = eyeRect.left + eyeRect.width / 2, cy = eyeRect.top + eyeRect.height * 0.47;
      var dx = px - cx, dy = py - cy, d = Math.hypot(dx, dy) || 1, k = Math.min(1, d / 260);
      var tr = 'translate(' + (dx / d * 6.5 * k).toFixed(1) + ' ' + (dy / d * 6 * k).toFixed(1) + ')';
      if (tr !== lastTr) { lastTr = tr; Array.prototype.forEach.call(pupils, function (p) { p.setAttribute('transform', tr); }); }
      var near = d < 70;
      if (near !== lastNear) { lastNear = near; mm.classList.toggle('near', near); }
    }
  }

  /* ---------- ripple on press ---------- */
  function ripple(e) {
    var b = e.target && e.target.closest ? e.target.closest('[data-rip-host], .ac-btn, .ac-btn-state') : null;
    if (!b) return;
    var r = b.getBoundingClientRect();
    b.style.setProperty('--rx', (e.clientX - r.left) + 'px');
    b.style.setProperty('--ry', (e.clientY - r.top) + 'px');
    b.removeAttribute('data-rip');
    root.requestAnimationFrame(function () {
      b.setAttribute('data-rip', '');
      clearTimeout(b.__acRip);
      b.__acRip = setTimeout(function () { b.removeAttribute('data-rip'); }, 650);
    });
  }

  /* ---------- number flash (reads text only, never writes it) ---------- */
  function parseNum(s) {
    var m = String(s || '').replace(/[^\d,.\-−]/g, '').replace(/\./g, '').replace(',', '.').replace('−', '-');
    var n = parseFloat(m);
    return isFinite(n) ? n : null;
  }
  function watchNumbers() {
    if (!('MutationObserver' in root)) return;
    var budget = 0, last = 0;
    new root.MutationObserver(function (muts) {
      var now = root.performance ? root.performance.now() : Date.now();
      if (now - last > 250) { budget = 24; last = now; }
      for (var i = 0; i < muts.length && budget > 0; i++) {
        var m = muts[i];
        if (m.type !== 'characterData') continue;
        var host = m.target.parentElement;
        if (!host || host.closest('svg')) continue;
        var t = host.closest('[data-ac-flash]');
        if (!t) continue;
        var a = parseNum(m.oldValue), z = parseNum(m.target.data);
        if (a === null || z === null || a === z) continue;
        budget--;
        t.classList.remove('ac-flash-up', 'ac-flash-dn');
        root.requestAnimationFrame(function (el, up) { return function () { el.classList.add(up ? 'ac-flash-up' : 'ac-flash-dn'); setTimeout(function () { el.classList.remove('ac-flash-up', 'ac-flash-dn'); }, 900); }; }(t, z > a));
      }
    }).observe(doc.body, { subtree: true, characterData: true, characterDataOldValue: true });
  }

  /* ---------- start ---------- */
  function start() {
    buildMascot();
    // Follow navigation and the landing/app switch by wrapping the two
    // globals that drive them. The originals run first and synchronously, so
    // nothing that reads currentPage right after navigateTo() is affected.
    ['navigateTo', 'setTopLevelView'].forEach(function (name) {
      var original = root[name];
      if (typeof original !== 'function' || original.__acMotionWrapped) return;
      var wrapped = function () {
        var result = original.apply(this, arguments);
        try { syncVisibility(); } catch (_) {}
        return result;
      };
      wrapped.__acMotionWrapped = true;
      root[name] = wrapped;
    });
    doc.addEventListener('visibilitychange', function () {
      doc.documentElement.classList.toggle('ac-tab-hidden', doc.hidden);
    });
    doc.addEventListener('click', tabTalk, true);
    if (RM) return;
    doc.addEventListener('pointermove', function (e) {
      if (e.pointerType === 'touch') return;
      px = e.clientX; py = e.clientY; tgt = e.target;
      if (!raf) raf = root.requestAnimationFrame(frame);
    }, { passive: true });
    doc.addEventListener('pointerleave', function () { px = py = -9999; tgt = null; if (!raf) raf = root.requestAnimationFrame(frame); });
    doc.addEventListener('pointerdown', ripple, { passive: true });
    watchNumbers();
  }

  root.AutoCuanMata = {
    say: function (t) { say(String(t || '')); },
    setMood: function (c) { var v = Number(c); if (isFinite(v)) setMood(moodOf(v), v, true); },
    moodOf: moodOf,
    pageName: pageName,
    copy: { LINES: LINES, COMMON: COMMON, GREET: GREET, MOOD: MOOD, TAB: TAB }
  };

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start);
  else start();
})(typeof window !== 'undefined' ? window : this);
