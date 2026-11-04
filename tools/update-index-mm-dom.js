const fs = require('fs');

let html = fs.readFileSync('public/index.html', 'utf8');

const targetNew = `<section id="page-money-management" class="page-content ac-page money-sheet hidden" data-premium-page="true" data-ac-ui="v2" aria-labelledby="moneySheetTitle">
  <div class="ph ms-page-heading rise d0">
    <div>
      <div class="kick ms-eyebrow">Keuangan pribadi</div>
      <h1 id="moneySheetTitle">Kelola Keuangan</h1>
      <p class="ms-description">Anggaran bulanan yang bisa Anda atur. Portofolio terhubung, tanpa pencatatan ganda.</p>
    </div>
    <label class="ms-month" style="display:flex;align-items:center;gap:10px;font-size:13px;font-weight:600">Bulan <select id="mmSheetMonth" class="fld" aria-label="Bulan"><option value="2026-10">Oktober 2026</option><option value="2026-09">September 2026</option><option value="2026-08">Agustus 2026</option></select></label>
  </div>
  <section class="sheet ms-overview rise d1" aria-label="Ringkasan anggaran">
    <div class="strip">
      <div class="ms-metric"><div class="lbl">Pemasukan</div><strong id="mmTotalIncomeDisplay" class="big num pos"><span class="nil" title="Tidak tersedia di sumber" aria-label="kosong">&mdash;</span></strong><div class="kpi-sub">Seluruh sumber penghasilan</div></div>
      <div class="ms-metric"><div class="lbl">Pengeluaran</div><strong id="mmTotalLivingExpenseDisplay" class="big num"><span class="nil" title="Tidak tersedia di sumber" aria-label="kosong">&mdash;</span></strong><div class="kpi-sub">Kebutuhan dan pengeluaran pilihan</div></div>
      <div class="ms-metric"><div class="lbl">Tabungan & transfer</div><strong id="mmSheetAllocation" class="big num"><span class="nil" title="Tidak tersedia di sumber" aria-label="kosong">&mdash;</span></strong><div class="kpi-sub">Alokasi bulan ini, bukan nilai aset</div></div>
      <div class="ms-metric ms-metric-balance"><div class="lbl">Sisa anggaran</div><strong id="mmRemainingBudgetDisplay" class="big num"><span class="nil" title="Tidak tersedia di sumber" aria-label="kosong">&mdash;</span></strong><div class="kpi-sub" id="mmBudgetSafetyStatus">Menunggu data anggaran</div></div>
    </div>
    <div class="bar ms-bar" id="mmCompositionBar" style="margin:0 20px 16px;height:6px" role="img" aria-label="Komposisi pengeluaran, tabungan, dan sisa" hidden><i data-part="expense" style="background:var(--ac-ctl)"></i><i data-part="saving" style="background:var(--ac-brand)"></i><i data-part="left" style="background:#CFE6DC"></i></div>
    <div class="ms-legend" id="mmCompositionLegend" style="display:flex;gap:18px;flex-wrap:wrap;padding:0 20px 14px;font-size:12px;color:var(--ac-2)" hidden><span class="tag"><span class="dot m" data-part="expense"></span>Pengeluaran</span><span class="tag"><span class="dot g" data-part="saving"></span>Tabungan & transfer</span><span class="tag"><span class="dot" style="background:#CFE6DC" data-part="left"></span>Sisa</span></div>
  </section>
  <section class="sheet ms-portfolio rise d2" aria-label="Portofolio terhubung" style="display:flex;flex-wrap:wrap;align-items:center;gap:16px 36px;padding:16px 20px">
    <div style="display:flex;align-items:center;gap:12px;min-width:220px">
      <span style="width:34px;height:34px;border-radius:8px;background:var(--ac-brand-soft);display:grid;place-items:center"><svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="#0F7458" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M4 8h16v11H4zM9 8V5h6v3"/></svg></span>
      <div><div style="font-weight:700">Portofolio terhubung</div><div class="mut" style="font-size:12px"><span class="dot g" style="margin-right:6px"></span><span id="mmPortfolioStatus" role="status">Tersinkron · 4 posisi</span></div></div>
    </div>
    <div><div class="lbl" style="margin:0">Eksposur rencana</div><strong id="mmPortfolioExposure" class="num" style="font-weight:700;font-size:18px">Rp 27.400.000</strong></div>
    <div><div class="lbl" style="margin:0">P/L dari harga tersimpan</div><strong id="mmPortfolioPnl" class="num pos" style="font-weight:700;font-size:18px">+Rp 1.845.000 <span style="font-size:13px">(+6,73%)</span></strong></div>
    <button type="button" id="mmOpenPortfolio" class="btn ms-button ms-button-quiet" style="margin-left:auto">Buka Portofolio</button>
    <p class="mut ms-portfolio-note" style="margin:0;flex-basis:100%;font-size:12px">Ringkasan mengikuti sumber data Portofolio. Nilai rencana dan P/L bukan arus kas bulan ini; tidak ditambahkan atau dikurangkan otomatis dari anggaran.</p>
  </section>
  <section class="sheet ms-workbook rise d3" aria-label="Lembar anggaran bulanan">
    <div class="sec-h ms-workbook-heading"><div><h2>Anggaran bulanan</h2><span>Klik sel untuk memilih &middot; ubah nominal langsung di tabel &middot; total diperbarui otomatis</span></div><div class="ms-heading-actions"><span class="tag"><span class="dot g"></span><span id="mmSheetSaveState" class="ms-save-state" role="status" aria-live="polite">Tersimpan</span></span></div></div>
    <div style="display:flex;flex-wrap:wrap;gap:8px;padding:0 20px 12px;align-items:center" class="ms-toolbar" role="toolbar" aria-label="Alat lembar kerja">
      <button type="button" class="btn p sm ms-button" id="mmAddRow">+ Tambah baris</button>
      <button type="button" id="mmDeleteRows" class="btn sm ms-button ms-button-quiet">Hapus baris</button>
      <label class="search ms-search" style="width:220px;height:30px;font-size:12px"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" aria-hidden="true"><circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/></svg><input id="mmSheetSearch" type="search" placeholder="Cari pos anggaran" aria-label="Cari pos anggaran" style="background:transparent;border:0;outline:0;font-size:12px;color:var(--ac-ink);width:100%"></label>
      <select id="mmSheetSort" class="fld ms-sort" style="height:30px;font-size:12px" aria-label="Urutkan baris"><option value="original">Urutkan baris…</option><option value="amount">Nominal terbesar</option><option value="label">Nama pos A&ndash;Z</option><option value="type">Kelompok jenis</option></select>
      <details class="ms-adv adv-tools" id="mmAdvTools">
        <summary class="btn sm ms-button ms-button-quiet ms-adv-sum">Alat lanjutan</summary>
        <div class="ms-adv-body">
          <div class="ms-adv-row">
            <div class="ms-history"><button type="button" class="ms-icon-button" id="mmUndo" title="Urungkan (Ctrl+Z)" aria-label="Urungkan perubahan" disabled>&#8630;</button><button type="button" class="ms-icon-button" id="mmRedo" title="Ulangi (Ctrl+Shift+Z)" aria-label="Ulangi perubahan" disabled>&#8631;</button></div>
            <button type="button" class="ms-button ms-button-quiet" id="mmReload">Muat ulang</button>
            <button type="button" id="mmExpandSheet" class="ms-button" aria-pressed="false">Fokus lembar</button>
          </div>
          <div class="ms-edit-toolbar" role="toolbar" aria-label="Edit rentang">
            <button type="button" id="mmCopyCells" class="ms-button ms-button-quiet" disabled>Salin</button>
            <button type="button" id="mmClearCells" class="ms-button ms-button-quiet" disabled>Kosongkan sel</button>
            <button type="button" id="mmFillDown" class="ms-button ms-button-quiet" title="Isi ke bawah (Ctrl+D)" disabled>Isi ke bawah</button>
            <button type="button" id="mmInsertRow" class="ms-button ms-button-quiet" disabled>Sisipkan baris</button>
          </div>
          <details class="ms-help"><summary>Pintasan & rumus</summary><p id="mmSheetHint">Shift + klik atau Shift + panah untuk memilih rentang. Ctrl/Cmd + C untuk salin, + V untuk tempel, + D untuk isi ke bawah, + S untuk simpan. F2 membuka editor sel. Klik judul kolom untuk memilih; seret batasnya untuk mengatur lebar.</p><p>Kolom D mendukung +, -, *, /, SUM, AVERAGE, MIN, MAX, COUNT, dan ROUND. Gunakan angka tanpa pemisah ribuan di dalam rumus. Hasil harus rupiah bulat. Nomor baris tetap sama saat disaring atau diurutkan. Rumus disimpan bersama lembar; bukan mesin Excel lengkap.</p></details>
        </div>
      </details>
      <span style="margin-left:auto;display:flex;gap:8px">
        <button type="button" class="btn sm ms-button ms-button-quiet" id="mmExport">Ekspor CSV</button>
        <button type="button" class="btn sm ms-button ms-button-primary" id="mmBtnSaveCashflow">Simpan</button>
      </span>
    </div>
    <div style="padding:0 20px 12px"><div class="fx ms-formula-bar"><b class="ms-cell-address" id="mmCellAddress">D1</b><i>fx</i><input id="mmFormulaInput" type="text" aria-label="Nilai atau rumus sel aktif" placeholder="Pilih sel. Nominal mendukung =SUM(D1:D3) atau =ROUND(D1*0.1)" autocomplete="off" spellcheck="false" maxlength="500" disabled style="background:transparent;border:0;outline:0;font-size:13px;width:100%;font-family:inherit;color:inherit"></div></div>
    <div id="mmSheetNotice" class="ms-notice" role="status" aria-live="polite">Memuat lembar kerja&hellip;</div>
    <div id="mmSheetViewport" class="ms-grid-viewport tw" tabindex="0" role="region" aria-label="Tabel anggaran, dapat digulir" style="border-top:1px solid var(--ac-hair)" hidden>
      <table id="mmCashflowSpreadsheetTable" class="grid ms-grid" role="grid" aria-multiselectable="true" aria-label="Anggaran bulanan">
        <colgroup><col style="width:44px"><col style="width:130px"><col style="width:170px"><col><col style="width:190px"><col style="width:240px"></colgroup>
        <thead><tr><th scope="col" class="ix ms-row-number">#</th><th scope="col" style="width:130px">A &middot; Jenis</th><th scope="col" style="width:170px">B &middot; Kategori</th><th scope="col">C &middot; Nama pos</th><th scope="col" class="ms-number" style="width:190px;text-align:right">D &middot; Nominal (Rp)</th><th scope="col" style="width:240px">E &middot; Catatan</th></tr></thead>
        <tbody id="mmCashflowSpreadsheetBody"></tbody>
      </table>
      <div id="mmEmptyState" style="display:none;padding:32px 20px;text-align:center">
        <b id="mmEmptyMonthTitle" style="display:block;font-size:15px">Belum ada anggaran untuk bulan ini</b>
        <p class="mut" style="margin:6px 0 14px;font-size:13px">Mulai dari pos bulan sebelumnya supaya tidak mengetik ulang, lalu ubah nominalnya.</p>
        <button type="button" class="btn p sm" id="mmCopyPrev">Salin pos dari Oktober 2026</button>
      </div>
    </div>
    <div class="ms-grid-status" style="display:flex;flex-wrap:wrap;gap:8px 24px;justify-content:space-between;padding:12px 20px;border-top:1px solid var(--ac-hair);font-size:12px;color:var(--ac-2)">
      <span class="num"><span id="mmSheetRowCount">0</span> baris &middot; total nominal <b id="mmSheetTotalAmount" style="color:var(--ac-ink)">Rp 0</b></span><span>Pilih sel untuk mengedit</span>
    </div>
    <div style="padding:14px 20px 20px;border-top:1px solid var(--ac-hair)">
      <label class="ms-month-notes" for="mmCashflowNotes" style="font-weight:600;font-size:13px;display:block;margin-bottom:6px">Catatan bulan ini</label>
      <textarea id="mmCashflowNotes" class="fld" style="width:100%;height:72px;padding:10px 12px;resize:vertical" rows="2" maxlength="500" placeholder="Refleksi keuangan bulan ini…" disabled></textarea>
    </div>
  </section>
  <div id="mmUndoToast" style="position:fixed;left:50%;bottom:28px;transform:translateX(-50%);z-index:120;display:none">
    <div class="toast" role="status">
      <span id="mmUndoToastText">Baris dihapus</span>
      <button type="button" id="mmUndoToastBtn" style="border:0;background:transparent;color:#6EE7B7;font-weight:600;cursor:pointer;margin-left:8px">Urungkan</button>
    </div>
  </div>
</section>`;

const startTag = '<section id="page-money-management"';
const endTag = '<!-- ===== PAGE: ADMIN CONSOLE ===== -->';

const startIdx = html.indexOf(startTag);
const endIdx = html.indexOf(endTag);

if (startIdx !== -1 && endIdx !== -1 && endIdx > startIdx) {
  html = html.slice(0, startIdx) + targetNew + '\n\n' + html.slice(endIdx);
  fs.writeFileSync('public/index.html', html, 'utf8');
  console.log('SUCCESS: public/index.html replaced perfectly!');
} else {
  console.log('FAIL: indices not found', { startIdx, endIdx });
}
