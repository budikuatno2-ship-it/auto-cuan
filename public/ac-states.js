/* Auto-Cuan data states (redesign v2, HANDOFF §6).
   Every data page renders real empty, loading and error states with the
   canvas copy (motion.js `ST`): what happened, what to do next, and a retry.
   An error never invents numbers: it offers the last saved data with its
   real timestamp, or says nothing is saved.

   Copy changes from the canvas, on purpose:
   - Clock times that do not match the production schedule are removed
     (the canvas said "17.10 WIB"; the swing screener runs at 21.30 WIB and
     schedules still move), so the copy cannot go stale.
   - "Pilih BRPT" (sample ticker) became "Pilih emiten lain".
   - The error body names the last saved timestamp passed by the page, not
     the canvas sample date. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  if (root) root.AutoCuanStates = api;
})(typeof window !== 'undefined' ? window : null, function () {
  'use strict';

  // e: [title, cause, cta label, cta route]  l: loading line  f: error title
  var COPY = {
    'Dashboard': { e: ['Belum ada kandidat yang lolos gate hari ini', 'Sistem sudah memindai seluruh emiten dan tidak ada yang memenuhi semua syarat. Saat pasar lemah, ini wajar.', 'Buka Screener', 'screener'], l: 'Memuat kondisi pasar dan Top 5 Radar dari pindaian terakhir', f: 'Pindaian terakhir belum masuk' },
    'Screener': { e: ['Tidak ada kandidat di mode ini', 'Belum ada saham yang lolos gate Swing atau Day Trade untuk sesi ini. Coba mode lain atau cek lagi setelah pindaian berikutnya.', 'Lihat Watchlist', 'watchlist'], l: 'Memuat hasil pindaian tiga mode screener', f: 'Hasil screener gagal dimuat' },
    'Sektor Hot': { e: ['Belum ada data rotasi grup', 'Data rotasi dihitung dari pergerakan grup selama sesi bursa. Halaman ini terisi setelah hitungan pertama hari ini selesai.', 'Buka Dashboard', 'dashboard'], l: 'Memuat rotasi grup konglomerat', f: 'Data rotasi grup gagal dimuat' },
    'Analisis & Chart': { e: ['Candle untuk ticker ini belum tersedia', 'Emiten baru atau sedang disuspensi biasanya belum punya riwayat 20 sesi. Indikator tidak dihitung tanpa riwayat.', 'Pilih ticker lain di Screener', 'screener'], l: 'Memuat 500 sesi candle harian', f: 'Candle harian gagal dimuat' },
    'Bandarmologi': { e: ['Belum ada ringkasan broker untuk tanggal ini', 'Broker summary terbit setelah bursa tutup. Untuk hari libur bursa, datanya memang tidak ada.', 'Pilih tanggal kemarin', ''], l: 'Memuat ringkasan broker dan aliran asing', f: 'Ringkasan broker gagal dimuat' },
    'Sinyal Intelijen': { e: ['Belum ada sinyal baru', 'Sinyal muncul saat beberapa bukti mengarah ke hal yang sama. Hari ini belum ada yang memenuhi.', 'Buka Track Record', 'trackrecord'], l: 'Memuat papan bukti sinyal', f: 'Papan sinyal gagal dimuat' },
    'Broker Hunter': { e: ['Broker ini belum aktif hari ini', 'Tidak ada transaksi bersih yang tercatat untuk broker terpilih pada sesi ini.', 'Pilih broker lain', ''], l: 'Memuat posisi bersih broker', f: 'Data broker gagal dimuat' },
    'Insider': { e: ['Belum ada data kepemilikan', 'Laporan kepemilikan emiten ini belum tersedia di sumber. Relasi tidak digambar tanpa data.', 'Buka Struktur Pasar', 'market-structure'], l: 'Memuat jejaring pengendali dan insider', f: 'Data kepemilikan gagal dimuat' },
    'Ranking': { e: ['Tidak ada emiten yang cocok', 'Filter preset ini tidak menyisakan emiten. Ganti preset atau kosongkan pencarian.', 'Kembali ke Semua', ''], l: 'Memuat ranking harian seluruh emiten', f: 'Ranking harian gagal dimuat' },
    'Financial': { e: ['Laporan keuangan belum tersedia', 'Emiten ini belum punya laporan per periode di cakupan data. Pos tidak diisi angka nol.', 'Pilih emiten lain', ''], l: 'Memuat laporan keuangan per periode', f: 'Laporan keuangan gagal dimuat' },
    'Struktur Pasar': { e: ['Belum ada snapshot struktur pasar', 'Free Float dan HSC diperbarui dari snapshot IDX. Snapshot pertama belum masuk.', 'Buka Dashboard', 'dashboard'], l: 'Memuat snapshot Free Float dan HSC', f: 'Snapshot struktur pasar gagal dimuat' },
    'Pattern Radar': { e: ['Belum pernah dipindai', 'Jalankan pindaian pertama untuk mencari pola serupa di seluruh emiten.', 'Mulai pindai', ''], l: 'Memindai pola di seluruh emiten', f: 'Pindaian pola berhenti di tengah jalan' },
    'Watchlist': { e: ['Watchlist masih kosong', 'Tambahkan saham dari Screener atau Chart dengan tombol bintang. Alert Telegram ikut aktif.', 'Cari di Screener', 'screener'], l: 'Memuat watchlist dan harga terakhir', f: 'Watchlist gagal dimuat' },
    'Portfolio': { e: ['Belum ada posisi yang dicatat', 'Portofolio di sini catatan mandiri, bukan sambungan ke sekuritas. Mulai dari rencana posisi.', 'Buat rencana posisi', ''], l: 'Memuat posisi dan harga terakhir', f: 'Harga terakhir gagal diperbarui' },
    'Track Record': { e: ['Belum ada sinyal yang selesai', 'Track Record terisi setelah sinyal pertama kena TP atau SL.', 'Lihat sinyal aktif', ''], l: 'Memuat riwayat sinyal sistem', f: 'Riwayat sinyal gagal dimuat' },
    'Kelola Keuangan': { e: ['Belum ada anggaran bulan ini', 'Mulai dari pos bulan lalu supaya tidak mengetik ulang.', 'Pilih bulan', ''], l: 'Memuat lembar anggaran', f: 'Lembar anggaran gagal dimuat' },
    'Pusat Akun': { e: ['Profil belum lengkap', 'Hubungkan Telegram untuk verifikasi dan alert.', 'Buka Keamanan', ''], l: 'Memuat pengaturan akun', f: 'Pengaturan akun gagal dimuat' },
    'Admin Console': { e: ['Tidak ada permintaan akun yang menunggu', 'Semua pendaftaran sudah diputuskan.', 'Lihat log audit', ''], l: 'Memuat antrean persetujuan dan status job', f: 'Konsol admin gagal memuat status job' }
  };

  function esc(v) {
    return String(v == null ? '' : v).replace(/[&<>"']/g, function (c) {
      return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
    });
  }

  function icon(name) {
    var I = (typeof window !== 'undefined' && window.AutoCuanIcons) || null;
    if (I && I.has(name)) return I.svg(name, { size: 40, strokeWidth: 1.6 });
    return '';
  }

  // Formats an ISO timestamp as "16 Okt 2026, 16.05 WIB". Returns '' when
  // the value is missing or unparseable, so the caller never prints a guess.
  function formatWib(value) {
    if (!value) return '';
    var d = new Date(value);
    if (isNaN(d.getTime())) return '';
    try {
      var parts = new Intl.DateTimeFormat('id-ID', { timeZone: 'Asia/Jakarta', day: 'numeric', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit', hour12: false }).formatToParts(d);
      var get = function (t) { var p = parts.filter(function (x) { return x.type === t; })[0]; return p ? p.value : ''; };
      return get('day') + ' ' + get('month').replace('.', '') + ' ' + get('year') + ', ' + get('hour') + '.' + get('minute') + ' WIB';
    } catch (_) { return ''; }
  }

  // html(page, state, opts) -> markup string.
  //   state: 'empty' | 'loading' | 'error'
  //   opts.lastSavedAt: ISO time of the data still on screen (error state)
  //   opts.reason: override for the error cause sentence
  //   opts.skeletonRows / opts.skeletonHeight: keep the loading block as tall
  //   as the content it replaces, so nothing shifts when data lands
  function html(page, state, opts) {
    var c = COPY[page];
    if (!c) return '';
    var o = opts || {};
    if (state === 'empty') {
      var route = c.e[3];
      var cta = route
        ? '<button type="button" class="ac-btn-state" data-state-action="navigate" data-state-route="' + esc(route) + '">' + esc(c.e[2]) + '</button>'
        : (c.e[2] ? '<button type="button" class="ac-btn-state" data-state-action="primary">' + esc(c.e[2]) + '</button>' : '');
      return '<div class="ac-state ac-state-empty" role="status">' + icon('state-empty') + '<b>' + esc(c.e[0]) + '</b><p>' + esc(c.e[1]) + '</p>' + cta + '</div>';
    }
    if (state === 'loading') {
      var rows = Math.max(1, Math.min(12, Number(o.skeletonRows) || 6));
      var h = Number(o.skeletonHeight) > 0 ? ' style="min-height:' + Number(o.skeletonHeight) + 'px"' : '';
      var sk = '';
      for (var i = 0; i < rows; i++) sk += '<i></i>';
      return '<div class="ac-state-loading"' + h + '><div class="ac-state-load" role="status"><span class="ac-spin" aria-hidden="true"></span>' + esc(c.l) + '…</div><div class="ac-state-sk" aria-hidden="true">' + sk + '</div></div>';
    }
    if (state === 'error') {
      var saved = formatWib(o.lastSavedAt);
      var cause = o.reason ? esc(o.reason) : 'Koneksi ke server data terputus.';
      var tail = saved
        ? ' Data terakhir yang tersimpan (' + esc(saved) + ') tetap bisa dibuka. Tidak ada angka yang ditebak.'
        : ' Belum ada data tersimpan untuk ditampilkan. Tidak ada angka yang ditebak.';
      var buttons = '<button type="button" class="ac-btn-state" data-state-action="retry">Coba lagi</button>' +
        (saved ? '<button type="button" class="ac-btn-state ac-btn-state-quiet" data-state-action="last-saved">Buka data terakhir</button>' : '');
      return '<div class="ac-state ac-state-error" role="alert">' + icon('state-error') + '<b>' + esc(c.f) + '</b><p>' + cause + tail + '</p><div class="ac-state-actions">' + buttons + '</div></div>';
    }
    return '';
  }

  // render(container, page, state, opts) writes the state and wires its
  // buttons: opts.onRetry, opts.onLastSaved, opts.onPrimary, and routes via
  // window.navigateTo for empty-state links.
  function render(container, page, state, opts) {
    if (!container) return false;
    var o = opts || {};
    var markup = html(page, state, o);
    if (!markup) return false;
    container.innerHTML = markup;
    container.setAttribute('data-ac-state', state);
    if (state === 'loading') container.setAttribute('aria-busy', 'true');
    else container.removeAttribute('aria-busy');
    Array.prototype.forEach.call(container.querySelectorAll('[data-state-action]'), function (btn) {
      btn.addEventListener('click', function () {
        var action = btn.getAttribute('data-state-action');
        if (action === 'retry' && typeof o.onRetry === 'function') o.onRetry();
        else if (action === 'last-saved' && typeof o.onLastSaved === 'function') o.onLastSaved();
        else if (action === 'primary' && typeof o.onPrimary === 'function') o.onPrimary();
        else if (action === 'navigate' && typeof window !== 'undefined' && typeof window.navigateTo === 'function') window.navigateTo(btn.getAttribute('data-state-route'));
      });
    });
    return true;
  }

  return { COPY: COPY, html: html, render: render, formatWib: formatWib, pages: function () { return Object.keys(COPY); } };
});
