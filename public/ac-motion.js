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
    portofolio: 'Portfolio', trackrecord: 'Track Record', 'money-management': 'Kelola Keuangan', 'kelola-keuangan': 'Kelola Keuangan'
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

/* ===== C9 motion upgrade (Fase C9: Landing/Auth/App/Si Mata, INP<200ms) =====
   Vanilla, tanpa library. Prinsip: satu pointermove + satu rAF; hanya transform/opacity/
   variabel CSS; berhenti saat prefers-reduced-motion:reduce atau document.hidden.
   Bahasa Indonesia. Tanpa janji untung. */
(function () {
  if (window.__acC9) return; window.__acC9 = 'c9-v1';
  var RMQ = window.matchMedia ? window.matchMedia('(prefers-reduced-motion: reduce)') : null;
  function rm() { return !!(RMQ && RMQ.matches); }
  function hidden() { return !!document.hidden; }
  /* ---------- Landing: parallax halus hero (transform:translate3d) ---------- */
  var pxEls = [], ticking = false;
  function c9Parallax() {
    if (rm() || hidden()) return;
    var y = window.scrollY || 0;
    for (var i = 0; i < pxEls.length; i++) {
      var el = pxEls[i], sp = parseFloat(el.getAttribute('data-c9-speed') || '0.12');
      el.style.setProperty('--c9-px', (-y * sp).toFixed(1) + 'px');
    }
    ticking = false;
  }
  function initParallax() {
    pxEls = [].slice.call(document.querySelectorAll('[data-c9-parallax]'));
    if (!pxEls.length) return;
    pxEls.forEach(function (el) { el.classList.add('c9-parallax'); });
    window.addEventListener('scroll', function () {
      if (ticking || rm() || hidden()) return; ticking = true;
      requestAnimationFrame(c9Parallax);
    }, { passive: true });
    c9Parallax();
  }
  /* ---------- Landing: spotlight candle hemat CPU (kursor, hero saja) ---------- */
  var spotEl = null, spotRaf = 0, sx = 0, sy = 0;
  function spotFrame() {
    spotRaf = 0;
    if (!spotEl || rm() || hidden()) return;
    spotEl.style.setProperty('--c9-sx', sx.toFixed(1) + 'px');
    spotEl.style.setProperty('--c9-sy', sy.toFixed(1) + 'px');
  }
  function initSpot() {
    spotEl = document.querySelector('[data-c9-spot]');
    if (!spotEl) return;
    spotEl.classList.add('c9-spot');
    var hero = spotEl.closest('.hero, .L, main, body') || document.body;
    hero.addEventListener('pointermove', function (e) {
      if (rm() || hidden() || e.pointerType === 'touch') return;
      var r = spotEl.getBoundingClientRect();
      sx = (e.clientX - r.left - r.width / 2) * 0.06;
      sy = (e.clientY - r.top - r.height / 2) * 0.06;
      if (!spotRaf) spotRaf = requestAnimationFrame(spotFrame);
    }, { passive: true });
  }
  /* ---------- Landing: staggered scroll reveal section 01-07 via IO ---------- */
  function initReveal() {
    var els = document.querySelectorAll('[data-c9-reveal]');
    if (!els.length || !('IntersectionObserver' in window)) {
      [].forEach.call(els, function (el) { el.classList.add('c9-reveal', 'in'); });
      return;
    }
    var io = new IntersectionObserver(function (ents) {
      ents.forEach(function (en) {
        if (!en.isIntersecting) return;
        io.unobserve(en.target);
        if (rm()) { en.target.classList.add('c9-reveal', 'in'); return; }
        en.target.classList.add('c9-reveal');
        requestAnimationFrame(function () { en.target.classList.add('in'); });
      });
    }, { threshold: 0.12 });
    [].forEach.call(els, function (el, i) {
      el.style.transitionDelay = Math.min(i * 60, 360) + 'ms';
      io.observe(el);
    });
  }
  /* ---------- Landing: count-up angka saat masuk viewport ---------- */
  function fmtId(n) { return Math.round(n).toString().replace(/\B(?=(\d{3})+(?!\d))/g, '.'); }
  function initCount() {
    var els = document.querySelectorAll('[data-c9-count]');
    if (!els.length) return;
    function run(el) {
      var to = parseFloat(el.getAttribute('data-c9-count'));
      if (!isFinite(to)) return;
      if (rm()) { el.textContent = fmtId(to); return; }
      var t0 = performance.now(), dur = 1300;
      function step(t) {
        if (hidden()) { el.textContent = fmtId(to); return; }
        var f = Math.min(1, (t - t0) / dur), e = 1 - Math.pow(1 - f, 4);
        el.textContent = fmtId(to * e);
        if (f < 1) requestAnimationFrame(step);
      }
      requestAnimationFrame(step);
    }
    if (!('IntersectionObserver' in window)) { [].forEach.call(els, run); return; }
    var io = new IntersectionObserver(function (ents) {
      ents.forEach(function (en) { if (en.isIntersecting) { io.unobserve(en.target); run(en.target); } });
    }, { threshold: 0.4 });
    [].forEach.call(els, function (el) { io.observe(el); });
  }
  /* ---------- Landing: transisi tab preview + slider kalkulator; marquee 45px/detik ---------- */
  function initPreviewTabs() {
    var btns = document.querySelectorAll('[data-c9-ptab]');
    if (!btns.length) return;
    btns.forEach(function (b) {
      b.addEventListener('click', function () {
        if (rm()) return;
        var pane = document.querySelector(b.getAttribute('data-c9-pane') || '.win');
        if (pane && pane.animate) pane.animate(
          [{ opacity: 0, transform: 'translateY(6px)' }, { opacity: 1, transform: 'none' }],
          { duration: 180, easing: 'cubic-bezier(0.22,1,0.36,1)' });
      });
    });
    document.querySelectorAll('input[type=range][data-c9-slider]').forEach(function (r) {
      r.addEventListener('input', function () {
        var out = document.querySelector(r.getAttribute('data-c9-out') || '');
        if (out && !rm() && out.animate) out.animate(
          [{ opacity: 0.4, transform: 'translateY(3px)' }, { opacity: 1, transform: 'none' }],
          { duration: 150, easing: 'cubic-bezier(0.22,1,0.36,1)' });
      });
    });
  }
  function initMarquee() {
    document.querySelectorAll('[data-c9-marquee]').forEach(function (el) {
      var inner = el.querySelector('.c9-marquee') || el;
      requestAnimationFrame(function () {
        var w = inner.scrollWidth / 2;
        inner.style.setProperty('--c9-dur', Math.max(20, Math.round(w / 45)) + 's');
      });
    });
  }
  /* ---------- Auth/Maintenance: spring dialog, field ring, slide langkah, shake 300ms, loading ---------- */
  function initAuth() {
    document.querySelectorAll('.dialog.dlg, .card.dlg').forEach(function (d) { d.classList.add('c9-dlg'); });
    document.querySelectorAll('.ov.scrim, .ov').forEach(function (o) { o.classList.add('c9-scrim'); });
    document.querySelectorAll('.inp, .fld').forEach(function (f) { f.classList.add('c9-field'); });
    document.querySelectorAll('.swap').forEach(function (s) { s.classList.add('c9-step'); });
    document.addEventListener('animationend', function (e) {
      if (e.target && e.target.classList && e.target.classList.contains('c9-shake')) e.target.classList.remove('c9-shake');
    }, true);
    window.acC9Shake = function (el) {
      if (!el || rm()) return;
      el.classList.remove('c9-shake'); void el.offsetWidth; el.classList.add('c9-shake');
    };
    document.addEventListener('click', function (e) {
      var b = e.target && e.target.closest ? e.target.closest('.btn.p') : null;
      if (!b || !b.closest('.dialog, .card')) return;
      if (rm()) return;
      b.classList.add('c9-btn-loading');
      setTimeout(function () { b.classList.remove('c9-btn-loading'); }, 1600);
    }, true);
    var badge = document.querySelector('.chip.w');
    if (badge && /pemeliharaan/i.test(document.title + ' ' + document.body.textContent.slice(0, 500))) badge.classList.add('c9-pulse');
  }
  /* ---------- App: panel 150-200ms, stagger baris maks 15ms, tick 600ms, drawer/toast ---------- */
  function initApp() {
    if (!document.querySelector('.app .side')) return;
    document.querySelectorAll('.page, .sheet').forEach(function (p) { p.classList.add('c9-panel'); });
    document.querySelectorAll('.segx .ind, .utabs .on').forEach(function (p) { p.classList.add('c9-pill'); });
    var rows = document.querySelectorAll('.tbl tbody tr, .rk, .ca');
    var n = 0;
    rows.forEach(function (r) {
      if (n >= 15) return;
      r.classList.add('c9-row');
      r.style.transitionDelay = Math.min(n * 15, 210) + 'ms';
      n++;
    });
    if ('IntersectionObserver' in window && rows.length) {
      var io = new IntersectionObserver(function (ents) {
        ents.forEach(function (en) { if (en.isIntersecting) { io.unobserve(en.target); en.target.classList.add('in'); } });
      }, { threshold: 0.05 });
      rows.forEach(function (r) { if (r.classList.contains('c9-row')) io.observe(r); });
    } else rows.forEach(function (r) { r.classList.add('in'); });
    document.querySelectorAll('.drawer, .lpanel').forEach(function (d) { d.classList.add('c9-drawer'); });
    document.querySelectorAll('.toast').forEach(function (t) { t.classList.add('c9-toast'); });
    if ('MutationObserver' in window) {
      var budget = 0, last = 0;
      new MutationObserver(function (muts) {
        if (rm() || hidden()) return;
        var now = performance.now();
        if (now - last > 250) { budget = 24; last = now; }
        for (var i = 0; i < muts.length && budget > 0; i++) {
          var m = muts[i];
          if (m.type !== 'characterData') continue;
          var host = m.target.parentElement;
          if (!host || host.closest('svg')) continue;
          var t = host.closest('.num, .big');
          if (!t) continue;
          budget--;
          t.classList.remove('c9-tick-up', 'c9-tick-dn');
          (function (el) {
            requestAnimationFrame(function () {
              el.classList.add('c9-tick-up');
              setTimeout(function () { el.classList.remove('c9-tick-up', 'c9-tick-dn'); }, 600);
            });
          })(t);
        }
      }).observe(document.body, { subtree: true, characterData: true, characterDataOldValue: true });
    }
  }
  /* ---------- Si Mata C9: pupil rAF tunggal, kedip 3-7 detik, mood IHSG, bubble edukatif,
     bisa dimatikan dari Pusat Akun, display:none di 4 Auth + Satu layar, berhenti saat
     hidden/reduced-motion ---------- */
  var mm = null, pupils = null, bub = null, eyeBtn = null, eyeRect = null;
  var c9px = -9999, c9py = -9999, c9raf = 0, c9tgt = null, lastTr = '', lastNear = null, blinkT = 0;
  var MSGS = {
    'Auto-Cuan': ['Selamat datang! Jelajahi fitur lewat menu di bawah. Angka di sini contoh, bukan rekomendasi.', 'Geser ke bawah, tiap bagian muncul halus. Arahkan kursor ke kartu hero, cahayanya ikut.'],
    'Dashboard': ['Baca kondisi pasar dulu, baru pilih saham. Angka contoh, bukan rekomendasi.', 'Kotak karantina itu sengaja dipisah. Jangan buru-buru.'],
    'Masuk': ['Masuk dengan Gmail terdaftar. Password salah? Coba pulihkan lewat Telegram.'],
    'Daftar akun': ['Daftar butuh Gmail aktif. Kode verifikasi dikirim ke bot Telegram.'],
    'Pemulihan password': ['Ikuti langkah 1-2-3. Kode 6 digit dikirim ke Telegram yang tertaut.'],
    'Lengkapi identitas akun': ['Tautkan Gmail sekali. Data watchlist dan portofolio tetap utuh.'],
    'Pemeliharaan': ['Sistem sedang diperbarui. Watchlist dan portofolio tersimpan utuh.']
  };
  var COMMON = ['Aku mengawasi data, bukan dompetmu.', 'Stop loss itu sabuk pengaman, bukan tanda kalah.', 'Aku bukan penasihat investasi. Aku cuma mata.'];
  function pageKey() { return (document.title || ''); }
  function pick() {
    var pool = (MSGS[pageKey()] || ['Halo! Aku ikut lihat halaman ini.']).concat(COMMON);
    return pool[Math.floor(Math.random() * pool.length)];
  }
  function say(t) {
    if (!bub || !mm || mm.classList.contains('off') || mm.hidden) return;
    bub.textContent = t;
    bub.classList.remove('on');
    requestAnimationFrame(function () { bub.classList.add('on'); });
    clearTimeout(say.t);
    say.t = setTimeout(function () { bub.classList.remove('on'); }, Math.max(4200, t.length * 70));
  }
  function isAuthPage() {
    var t = pageKey();
    return t === 'Masuk' || t === 'Daftar akun' || t === 'Pemulihan password' || t === 'Lengkapi identitas akun';
  }
  function isChartSingle() {
    return !!document.querySelector('.cw.full') || !!document.querySelector('[data-chart-single="1"]') || document.body.classList.contains('chart-focus');
  }
  function syncMata() {
    if (!mm) return;
    var hide = isAuthPage() || isChartSingle();
    mm.style.display = hide ? 'none' : '';
    mm.hidden = hide;
  }
  function blinkLoop() {
    if (!mm || rm() || hidden() || mm.hidden || mm.classList.contains('off')) { scheduleBlink(); return; }
    var lids = mm.querySelectorAll('.mm-lid, .mata .lid, .lid');
    lids.forEach(function (l) {
      if (l.animate) l.animate([{ transform: 'scaleY(0)' }, { transform: 'scaleY(1)', offset: 0.5 }, { transform: 'scaleY(0)' }], { duration: 220, easing: 'ease-in-out' });
    });
    scheduleBlink();
  }
  function scheduleBlink() {
    clearTimeout(blinkT);
    blinkT = setTimeout(blinkLoop, 3000 + Math.random() * 4000);
  }
  function frame() {
    c9raf = 0;
    if (rm() || hidden() || !mm || mm.hidden || mm.classList.contains('off')) return;
    if (!eyeRect && eyeBtn) eyeRect = eyeBtn.getBoundingClientRect();
    if (eyeRect && pupils) {
      var cx = eyeRect.left + eyeRect.width / 2, cy = eyeRect.top + eyeRect.height * 0.47;
      var dx = c9px - cx, dy = c9py - cy, d = Math.hypot(dx, dy) || 1, k = Math.min(1, d / 260);
      var tr = 'translate(' + (dx / d * 6.5 * k).toFixed(1) + ' ' + (dy / d * 6 * k).toFixed(1) + ')';
      if (tr !== lastTr) { lastTr = tr; pupils.forEach(function (p) { p.setAttribute('transform', tr); }); }
      var nr = d < 70;
      if (nr !== lastNear) { lastNear = nr; mm.classList.toggle('near', nr); }
    }
  }
  function initMata() {
    mm = document.querySelector('.mm');
    if (!mm) {
      var wrap = document.querySelector('.mata-wrap');
      if (wrap) {
        mm = document.createElement('div');
        mm.className = 'mm';
        mm.innerHTML = '<div class="mm-bub" role="status" aria-live="polite"></div>';
        document.body.appendChild(mm);
      } else return;
    }
    pupils = mm.querySelectorAll('.mm-pupil, .mata .pupil, .pupil');
    bub = mm.querySelector('.mm-bub, .bub');
    eyeBtn = mm.querySelector('.mm-eye, .mata');
    try { if (localStorage.getItem('ac-mata-off') === '1') mm.classList.add('off'); } catch (e) {}
    if (eyeBtn) eyeBtn.addEventListener('click', function () { say(pick()); });
    var chg = document.querySelector('[data-ihsg-chg]');
    if (chg && bub) {
      var v = parseFloat(chg.getAttribute('data-ihsg-chg'));
      if (isFinite(v)) mm.setAttribute('data-mood', v >= 1.5 ? 'up2' : v >= 0.3 ? 'up' : v > -0.3 ? 'flat' : v > -1.5 ? 'down' : 'down2');
    }
    syncMata();
    scheduleBlink();
    document.addEventListener('pointermove', function (e) {
      if (e.pointerType === 'touch' || rm() || hidden()) return;
      c9px = e.clientX; c9py = e.clientY; c9tgt = e.target;
      if (!c9raf) c9raf = requestAnimationFrame(frame);
    }, { passive: true });
    document.addEventListener('visibilitychange', function () {
      if (!document.hidden && !rm()) { eyeRect = null; if (!c9raf) c9raf = requestAnimationFrame(frame); }
    });
    if (RMQ && RMQ.addEventListener) RMQ.addEventListener('change', function () { eyeRect = null; });
    window.addEventListener('resize', function () { eyeRect = null; }, { passive: true });
    new MutationObserver(syncMata).observe(document.body, { subtree: true, attributes: true, attributeFilter: ['class'] });
  }
  function start() {
    if (rm()) {
      document.querySelectorAll('[data-c9-reveal]').forEach(function (el) { el.classList.add('c9-reveal', 'in'); });
      return;
    }
    initParallax(); initSpot(); initReveal(); initCount(); initPreviewTabs(); initMarquee(); initAuth(); initApp(); initMata();
  }
  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', start);
  else start();
})();
