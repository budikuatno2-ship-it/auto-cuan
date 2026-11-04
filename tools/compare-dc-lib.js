// compare-dc-lib.js — diff logic for kanvas vs app comparison
"use strict";

function diffHalaman(kanvas, aplikasi) {
  const kJudul = (kanvas.judul || '').toLowerCase();
  const aJudul = (aplikasi.judul || '').toLowerCase();
  const elemen_hilang = [];
  const elemen_berlebih = [];

  // Compare tabs
  const kTabs = new Set((kanvas.tab || []).map(t => t.toLowerCase()));
  const aTabs = new Set((aplikasi.tab || []).map(t => t.toLowerCase()));
  const hanyaKanvas = [...kTabs].filter(t => !aTabs.has(t));
  const hanyaAplikasi = [...aTabs].filter(t => !kTabs.has(t));

  // Compare buttons
  const kBtn = new Set((kanvas.tombol || []).map(t => t.toLowerCase()));
  const aBtn = new Set((aplikasi.tombol || []).map(t => t.toLowerCase()));
  const missingBtns = [...kBtn].filter(t => !aBtn.has(t));
  const extraBtns = [...aBtn].filter(t => !kBtn.has(t));

  // Compare table columns
  const kCol = new Set((kanvas.kolom_tabel || []).map(t => t.toLowerCase()));
  const aCol = new Set((aplikasi.kolom_tabel || []).map(t => t.toLowerCase()));
  const missingCols = [...kCol].filter(t => !aCol.has(t));
  const extraCols = [...aCol].filter(t => !kCol.has(t));

  // Compare aria labels
  const kAria = new Set((kanvas.aria_labels || []).map(t => t.toLowerCase()));
  const aAria = new Set((aplikasi.aria_labels || []).map(t => t.toLowerCase()));
  const missingAria = [...kAria].filter(t => !aAria.has(t));
  const extraAria = [...aAria].filter(t => !kAria.has(t));

  // Komponen khusus
  const kKomp = new Set(kanvas.komponen_khusus || []);
  const aKomp = new Set(aplikasi.komponen_khusus || []);
  const missingKomp = [...kKomp].filter(t => !aKomp.has(t));
  const extraKomp = [...aKomp].filter(t => !kKomp.has(t));

  // Build elemen_hilang (what canvas expects but app doesn't have)
  if (missingBtns.length > 0) elemen_hilang.push('tombol: ' + missingBtns.join(', '));
  if (missingCols.length > 0) elemen_hilang.push('kolom_tabel: ' + missingCols.join(', '));
  if (missingAria.length > 0) elemen_hilang.push('aria_labels: ' + missingAria.length + ' items');
  if (missingKomp.length > 0) elemen_hilang.push('komponen: ' + missingKomp.join(', '));
  if (kJudul && aJudul && kJudul !== aJudul) elemen_hilang.push('judul: kanvas="' + kanvas.judul + '", app="' + aplikasi.judul + '"');

  // Build elemen_berlebih (what app has but canvas doesn't)
  if (extraBtns.length > 0) elemen_berlebih.push('tombol: ' + extraBtns.join(', '));
  if (extraCols.length > 0) elemen_berlebih.push('kolom_tabel: ' + extraCols.join(', '));
  if (extraAria.length > 0) elemen_berlebih.push('aria_labels: ' + extraAria.length + ' items');
  if (extraKomp.length > 0) elemen_berlebih.push('komponen: ' + extraKomp.join(', '));

  // Metric card difference
  const kMetrik = kanvas.kartu_metrik || 0;
  const aMetrik = aplikasi.kartu_metrik || 0;
  if (Math.abs(kMetrik - aMetrik) > 2) {
    if (kMetrik > aMetrik) elemen_hilang.push('kartu_metrik: kanvas=' + kMetrik + ', app=' + aMetrik + ' (selisih ' + (kMetrik - aMetrik) + ')');
    else elemen_berlebih.push('kartu_metrik: kanvas=' + kMetrik + ', app=' + aMetrik + ' (selisih ' + (aMetrik - kMetrik) + ')');
  }

  return {
    elemen_hilang,
    elemen_berlebih,
    selisih_tab: {
      kanvas: kanvas.tab || [],
      aplikasi: aplikasi.tab || []
    },
    ringkasan: {
      kanvas_tab: (kanvas.tab || []).length,
      aplikasi_tab: (aplikasi.tab || []).length,
      kanvas_tombol: (kanvas.tombol || []).length,
      aplikasi_tombol: (aplikasi.tombol || []).length,
      kanvas_kolom: (kanvas.kolom_tabel || []).length,
      aplikasi_kolom: (aplikasi.kolom_tabel || []).length,
      kanvas_metrik: kanvas.kartu_metrik || 0,
      aplikasi_metrik: aplikasi.kartu_metrik || 0,
      kanvas_aria: (kanvas.aria_labels || []).length,
      aplikasi_aria: (aplikasi.aria_labels || []).length
    }
  };
}

module.exports = { diffHalaman };