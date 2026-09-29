/* Editable worksheet. Stable cell DOM; no polling, framework, or financial eval. */
(function (root) {
  'use strict';
  if (root.AutoCuanMoneySheet) return;
  const Model = root.AutoCuanMoneySheetModel;
  const doc = root.document;
  const $ = id => doc.getElementById(id);
  const money = value => value == null ? '\u2014' : 'Rp ' + value.toLocaleString('id-ID');
  const format = value => value.toLocaleString('id-ID');
  let sheet = null, month = Model.currentMonth(), notes = '', revision = null, userId = '';
  let lastSaveError = false;
  let saved = '', loading = false, saving = false, bound = false, generation = 0, totalsFrame = 0;
  let undo = [], redo = [], editBefore = null, nextId = 0, portfolioQueued = false, portfolioAt = 0;
  const invalid = new Map(), rowNodes = new Map(), requests = new Set();
  const encode = () => JSON.stringify({ sheet, notes });
  const dirty = () => !!sheet && (encode() !== saved || invalid.size > 0);
  const visible = () => $('page-money-management') && !$('page-money-management').classList.contains('hidden');
  const id = () => root.crypto && root.crypto.randomUUID ? root.crypto.randomUUID() : 'row-' + Date.now() + '-' + (++nextId);
  const sessionId = () => { try { return root.localStorage.getItem('autocuan_user_id') || ''; } catch (_) { return ''; } };

  function notice(message, tone) {
    const el = $('mmSheetNotice');
    el.textContent = message || ''; el.hidden = !message; el.dataset.tone = tone || 'info';
  }
  function stateLabel(label, state) { const el = $('mmSheetSaveState'); el.textContent = label; el.dataset.state = state || ''; }
  function controls() {
    const ready = !!sheet && !loading;
    $('mmAddRow').disabled = !ready || sheet.rows.length >= Model.MAX_ROWS;
    $('mmUndo').disabled = !ready || (!undo.length && !editBefore);
    $('mmRedo').disabled = !ready || !redo.length;
    $('mmExport').disabled = !ready;
    $('mmBtnSaveCashflow').disabled = !ready || saving || !dirty() || invalid.size > 0;
    $('mmBtnSaveCashflow').textContent = saving ? 'Menyimpan...' : 'Simpan';
    $('mmSheetMonth').disabled = loading || saving;
    $('mmReload').disabled = loading || saving;
    $('mmCashflowNotes').disabled = !ready;
    if (ready && !saving && !lastSaveError) stateLabel(dirty() ? 'Belum disimpan' : revision == null ? 'Bulan baru' : 'Tersimpan', dirty() ? 'dirty' : 'saved');
  }
  async function request(url, options) {
    const controller = new AbortController(); requests.add(controller);
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const response = await root.fetch(url, Object.assign({ credentials: 'same-origin', cache: 'no-store' }, options || {}, { signal: controller.signal }));
      const data = await response.json();
      if (!response.ok || data.success !== true || data.offline === true) {
        const error = new Error(data.error || 'Permintaan gagal. Data belum disimpan.');
        error.status = response.status; error.code = data.code; throw error;
      }
      return data;
    } finally { clearTimeout(timer); requests.delete(controller); }
  }
  function updateTotals() {
    totalsFrame = 0;
    if (!sheet || loading) return;
    const t = Model.totals(sheet);
    $('mmTotalIncomeDisplay').textContent = money(t.income);
    $('mmTotalLivingExpenseDisplay').textContent = money(t.expense);
    $('mmSheetAllocation').textContent = money(t.saving + t.transfer);
    $('mmRemainingBudgetDisplay').textContent = money(t.remaining);
    $('mmRemainingBudgetDisplay').classList.toggle('ms-negative', t.remaining < 0);
    $('mmBudgetSafetyStatus').textContent = t.remaining < 0 ? 'Alokasi melebihi pemasukan bulan ini' : 'Pemasukan dikurangi semua alokasi';
    controls();
  }
  function changed() {
    if (!totalsFrame) totalsFrame = root.requestAnimationFrame(updateTotals);
    controls();
  }
  function remember(snapshot) {
    if (snapshot === encode()) return;
    if (undo[undo.length - 1] !== snapshot) undo.push(snapshot);
    if (undo.length > 30) undo.shift();
    redo = [];
  }
  function commitEdit() { if (editBefore !== null) { remember(editBefore); editBefore = null; } }
  function focusCell(rowId, col) {
    const node = rowNodes.get(rowId);
    const input = node && node.querySelector('[data-col="' + col + '"]');
    if (input) { input.focus({ preventScroll: true }); input.scrollIntoView({ block: 'nearest', inline: 'nearest' }); }
  }
  function makeRow(row) {
    const tr = doc.createElement('tr'); tr.dataset.rowId = row.id;
    const number = doc.createElement('td'); number.className = 'ms-row-number'; tr.appendChild(number);
    Model.FIELDS.forEach((field, col) => {
      const td = doc.createElement('td');
      const input = doc.createElement(field === 'type' ? 'select' : 'input');
      input.dataset.field = field; input.dataset.col = String(col);
      if (field === 'type') Model.TYPES.forEach(type => { const option = doc.createElement('option'); option.value = type; option.textContent = Model.TYPE_LABELS[type]; input.appendChild(option); });
      else {
        input.type = 'text'; input.autocomplete = 'off'; input.spellcheck = false;
        input.maxLength = field === 'note' ? 500 : field === 'label' ? 160 : field === 'category' ? 80 : 24;
        if (field === 'amount') input.inputMode = 'numeric';
      }
      td.appendChild(input); tr.appendChild(td);
    });
    const actions = doc.createElement('td'); const remove = doc.createElement('button');
    remove.type = 'button'; remove.className = 'ms-delete'; remove.dataset.remove = row.id;
    remove.textContent = '\u00d7'; remove.title = 'Hapus baris (bisa diurungkan)'; actions.appendChild(remove); tr.appendChild(actions);
    return tr;
  }
  function visibleRows() {
    const filter = $('mmSheetSearch').value.trim().toLocaleLowerCase('id-ID');
    let rows = sheet.rows.filter(r => !filter || [r.category, r.label, r.note, Model.TYPE_LABELS[r.type]].join(' ').toLocaleLowerCase('id-ID').includes(filter));
    const sort = $('mmSheetSort').value;
    if (sort === 'amount') rows.sort((a,b) => b.amount-a.amount);
    if (sort === 'label') rows.sort((a,b) => a.label.localeCompare(b.label, 'id'));
    return rows;
  }
  function renderRows(focus, force) {
    if (!sheet || loading) return;
    const rows = visibleRows(), fragment = doc.createDocumentFragment();
    const keep = new Set(sheet.rows.map(r => r.id));
    for (const key of rowNodes.keys()) if (!keep.has(key)) rowNodes.delete(key);
    rows.forEach((row, index) => {
      let tr = rowNodes.get(row.id);
      if (!tr) { tr = makeRow(row); rowNodes.set(row.id, tr); }
      tr.firstChild.textContent = String(index + 1);
      Model.FIELDS.forEach((field, col) => {
        const input = tr.querySelector('[data-col="' + col + '"]');
        input.setAttribute('aria-label', (field === 'amount' ? 'Nominal rupiah' : ['Jenis','Kategori','Nama pos','Nominal','Catatan'][col]) + ', baris ' + (index + 1));
        const errorState = invalid.get(row.id + ':' + field);
        if (errorState) input.value = errorState.raw;
        else if (force || input !== doc.activeElement) input.value = field === 'amount' ? format(row.amount) : row[field];
        input.setAttribute('aria-invalid', invalid.has(row.id + ':' + field) ? 'true' : 'false');
      });
      tr.querySelector('[data-remove]').setAttribute('aria-label', 'Hapus baris ' + (index + 1));
      fragment.appendChild(tr);
    });
    $('mmCashflowSpreadsheetBody').replaceChildren(fragment);
    $('mmSheetRowCount').textContent = rows.length + ' dari ' + sheet.rows.length + ' baris';
    if (!rows.length) notice(sheet.rows.length ? 'Tidak ada pos yang cocok dengan pencarian.' : 'Lembar masih kosong. Tambahkan baris untuk mulai menyusun anggaran.');
    else if (!invalid.size) notice('');
    if (focus) focusCell(focus.id, focus.col);
    updateTotals();
  }
  function transact(change, focus) {
    if (!sheet || loading) return;
    if (invalid.size) return notice('Perbaiki sel yang ditandai sebelum mengubah struktur lembar kerja.', 'error');
    commitEdit();
    const before = encode();
    try { change(); sheet = Model.normalize(sheet); remember(before); renderRows(focus, true); }
    catch (error) { const old = JSON.parse(before); sheet = old.sheet; notes = old.notes; notice(error.message, 'error'); }
  }
  function restore(direction) {
    commitEdit();
    const from = direction === 'undo' ? undo : redo, to = direction === 'undo' ? redo : undo;
    if (!from.length) return;
    const active = doc.activeElement, tr = active && active.closest('[data-row-id]');
    const focus = tr ? { id: tr.dataset.rowId, col: Number(active.dataset.col || 0) } : null;
    to.push(encode()); const old = JSON.parse(from.pop()); sheet = old.sheet; notes = old.notes;
    invalid.clear(); $('mmCashflowNotes').value = notes; renderRows(focus, true);
  }
  function blankOverview() {
    ['mmTotalIncomeDisplay','mmTotalLivingExpenseDisplay','mmSheetAllocation','mmRemainingBudgetDisplay'].forEach(key => { $(key).textContent = '\u2014'; });
    $('mmBudgetSafetyStatus').textContent = 'Menunggu data anggaran';
  }
  async function load(nextMonth, force) {
    if (saving || loading) return;
    commitEdit();
    if (dirty() && !force && !root.confirm('Perubahan belum disimpan. Tinggalkan perubahan dan muat bulan ini?')) { $('mmSheetMonth').value = month; return; }
    const gen = ++generation; month = nextMonth; loading = true;
    $('mmSheetMonth').value = month; $('mmSheetViewport').hidden = true;
    blankOverview(); notice('Memuat lembar kerja...'); stateLabel('Memuat'); controls();
    try {
      const data = await request('/api/money-management?action=get-sheet&month=' + encodeURIComponent(month));
      if (gen !== generation) return;
      if (!data.user_id || !data.data || data.data.month !== month || (data.data.revision !== null && (!Number.isInteger(data.data.revision) || data.data.revision < 0))) throw new Error('Respons data tidak sesuai. Lembar kerja tidak diganti.');
      const normalized = Model.normalize(data.data.sheet);
      userId = String(data.user_id); sheet = normalized; notes = String(data.data.notes || ''); revision = data.data.revision;
      lastSaveError = false; saved = encode(); undo = []; redo = []; invalid.clear(); rowNodes.clear(); editBefore = null;
      $('mmCashflowNotes').value = notes; loading = false; $('mmSheetViewport').hidden = false;
      renderRows(null, true); refreshPortfolio(true);
    } catch (error) {
      if (gen !== generation) return;
      sheet = null; loading = false;
      notice(error.name === 'AbortError' ? 'Koneksi terlalu lama. Tekan Muat ulang; tidak ada data yang diganti.' : error.message, 'error');
      stateLabel('Gagal dimuat', 'error'); controls();
    }
  }
  async function save() {
    commitEdit(); if (!sheet || loading || saving || invalid.size || !dirty()) return;
    const gen = generation, submitted = encode(), savingMonth = month;
    const snapshot = JSON.parse(submitted); lastSaveError = false; saving = true;
    stateLabel('Menyimpan...'); controls();
    try {
      const result = await request('/api/money-management', { method:'POST', headers:{ 'Content-Type':'application/json' }, body:JSON.stringify({ action:'save-sheet', month:savingMonth, sheet:snapshot.sheet, notes:snapshot.notes, expected_revision:revision }) });
      if (gen !== generation) return;
      if (String(result.user_id) !== userId) { reset(); throw new Error('Sesi berubah. Muat ulang dengan akun yang benar.'); }
      if (!result.data || !Number.isInteger(result.data.revision) || result.data.revision < 1) throw new Error('Konfirmasi revisi tidak valid. Data belum ditandai tersimpan.');
      revision = result.data.revision; saved = submitted;
      notice(encode() === saved ? '' : 'Versi yang dikirim sudah disimpan. Perubahan berikutnya masih belum disimpan.');
      if (root.AutoCuanKeepAlive && typeof root.AutoCuanKeepAlive.invalidate === 'function') root.AutoCuanKeepAlive.invalidate('/api/money-management');
    } catch (error) {
      if (gen !== generation) return;
      notice(error.name === 'AbortError' ? 'Konfirmasi simpan belum diterima. Ekspor salinan, lalu muat ulang untuk memeriksa versi cloud sebelum mencoba lagi.' : error.message, 'error');
      lastSaveError = true; stateLabel('Belum tersimpan', 'error');
    } finally { if (gen === generation) { saving = false; controls(); } }
  }
  function localPortfolio() {
    const P = root.AutoCuanPortfolioCommandModel;
    if (!userId || !P) return undefined;
    try {
      const raw = root.localStorage.getItem('autocuan_portfolio_plans_' + userId);
      if (raw == null) return undefined;
      const plans = JSON.parse(raw), prices = JSON.parse(root.localStorage.getItem('autocuan_portfolio_prices_' + userId) || '{}');
      if (!Array.isArray(plans) || !prices || typeof prices !== 'object' || Array.isArray(prices)) return null;
      return Object.assign(P.summarize(plans, prices), { source:'local', price_updated_at:Number(root.localStorage.getItem('autocuan_portfolio_price_updated_v1_' + userId)) || null });
    } catch (_) { return null; }
  }
  function showPortfolio(summary, label) {
    $('mmPortfolioExposure').textContent = money(summary ? summary.totalExposureIdr : null);
    $('mmPortfolioPnl').textContent = money(summary ? summary.totalPnlIdr : null);
    $('mmPortfolioPnl').classList.toggle('ms-negative', !!summary && summary.totalPnlIdr < 0);
    $('mmPortfolioPnl').classList.toggle('ms-positive', !!summary && summary.totalPnlIdr > 0);
    let status = label || (summary ? (summary.source === 'local' ? 'Perangkat ini' : 'Cloud') + ' \u00b7 ' + summary.planCount + ' rencana' : 'Belum ada data Portofolio tersimpan');
    if (summary && summary.missingPriceCount) status += ' \u00b7 ' + summary.missingPriceCount + ' harga belum tersedia';
    if (summary && summary.price_updated_at) status += ' \u00b7 harga ' + new Date(summary.price_updated_at).toLocaleString('id-ID', { day:'2-digit', month:'short', hour:'2-digit', minute:'2-digit' });
    $('mmPortfolioStatus').textContent = status;
  }
  async function refreshPortfolio(force) {
    if (!userId) return;
    const local = localPortfolio();
    if (local !== undefined) { showPortfolio(local, local === null ? 'Data perangkat ini tidak dapat dibaca; buka Portofolio untuk memeriksa.' : ''); return; }
    if (!force && Date.now() - portfolioAt < 10000) return;
    portfolioAt = Date.now(); const uid = userId, gen = generation;
    $('mmPortfolioStatus').textContent = 'Memuat ringkasan Portofolio...';
    try {
      const result = await request('/api/money-management?action=portfolio-summary');
      if (uid !== userId || gen !== generation) return;
      if (String(result.user_id) !== userId) return showPortfolio(null, 'Sesi Portofolio berubah; muat ulang.');
      const newerLocal = localPortfolio(); showPortfolio(newerLocal === undefined ? result.data : newerLocal);
    } catch (_) { if (uid === userId && gen === generation) showPortfolio(null, 'Portofolio belum terhubung. Buka Portofolio atau coba Muat ulang.'); }
  }
  function queuePortfolio() {
    if (portfolioQueued || !userId) return;
    portfolioQueued = true;
    queueMicrotask(() => { portfolioQueued = false; if (userId) refreshPortfolio(false); });
  }
  function exportCSV() {
    if (!sheet) return;
    const blob = new Blob([Model.csv(sheet)], { type:'text/csv;charset=utf-8' });
    const url = URL.createObjectURL(blob), link = doc.createElement('a');
    link.href = url; link.download = 'anggaran-' + month + '.csv'; link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  }
  function onInput(event) {
    const input = event.target;
    if (input.id === 'mmCashflowNotes') { notes = input.value; changed(); return; }
    const tr = input.closest('[data-row-id]'); if (!tr || !input.dataset.field || !sheet) return;
    const row = sheet.rows.find(r => r.id === tr.dataset.rowId); if (!row) return;
    const key = row.id + ':' + input.dataset.field;
    try {
      row[input.dataset.field] = input.dataset.field === 'amount' ? Model.amount(input.value) : input.value;
      invalid.delete(key); input.setAttribute('aria-invalid','false');
      if (!invalid.size) notice('');
    } catch (error) { invalid.set(key, { message: error.message, raw: input.value }); input.setAttribute('aria-invalid','true'); notice(error.message,'error'); }
    changed();
  }
  function onKey(event) {
    if (!visible() || !sheet || loading) return;
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && event.key.toLowerCase() === 's') { event.preventDefault(); save(); return; }
    if (modifier && event.key.toLowerCase() === 'z') { event.preventDefault(); restore(event.shiftKey ? 'redo' : 'undo'); return; }
    if (modifier && event.key.toLowerCase() === 'y') { event.preventDefault(); restore('redo'); return; }
    const input = event.target, tr = input.closest && input.closest('[data-row-id]');
    if (!tr || !input.dataset.field || event.isComposing || modifier || event.altKey) return;
    const rows = visibleRows(), index = rows.findIndex(r => r.id === tr.dataset.rowId), col = Number(input.dataset.col);
    let rowIndex = index, column = col;
    if (event.key === 'Enter') rowIndex += event.shiftKey ? -1 : 1;
    else if (input.tagName !== 'SELECT' && event.key === 'ArrowDown') rowIndex++;
    else if (input.tagName !== 'SELECT' && event.key === 'ArrowUp') rowIndex--;
    else if (input.tagName !== 'SELECT' && event.key === 'ArrowLeft' && input.selectionStart === 0 && input.selectionEnd === 0) column--;
    else if (input.tagName !== 'SELECT' && event.key === 'ArrowRight' && input.selectionStart === input.value.length) column++;
    else if (event.key === 'Tab') { column += event.shiftKey ? -1 : 1; if (column > 4) { column = 0; rowIndex++; } if (column < 0) { column = 4; rowIndex--; } }
    else return;
    if (rowIndex >= 0 && rowIndex < rows.length && column >= 0 && column < 5) { event.preventDefault(); focusCell(rows[rowIndex].id, column); }
    else if (event.key === 'Enter') event.preventDefault();
  }
  function bind() {
    if (bound) return; bound = true;
    const page = $('page-money-management');
    $('mmSheetMonth').value = month;
    $('mmSheetMonth').addEventListener('change', event => { if (Model.validMonth(event.target.value)) load(event.target.value); else event.target.value = month; });
    $('mmReload').addEventListener('click', () => load(month));
    $('mmBtnSaveCashflow').addEventListener('click', save);
    $('mmAddRow').addEventListener('click', () => { const row = Model.newRow(id()); transact(() => sheet.rows.push(row), {id:row.id,col:2}); });
    $('mmUndo').addEventListener('click', () => restore('undo'));
    $('mmRedo').addEventListener('click', () => restore('redo'));
    $('mmExport').addEventListener('click', exportCSV);
    $('mmSheetSearch').addEventListener('input', () => { commitEdit(); renderRows(); });
    $('mmSheetSort').addEventListener('change', () => { commitEdit(); renderRows(); });
    $('mmOpenPortfolio').addEventListener('click', () => { if (typeof root.navigateTo === 'function') root.navigateTo('portofolio'); });
    page.addEventListener('input', onInput);
    page.addEventListener('focusin', event => {
      if (event.target.dataset.field || event.target.id === 'mmCashflowNotes') { editBefore = encode(); controls(); }
      const tr = event.target.closest('[data-row-id]');
      if (tr && event.target.dataset.col) { const index = visibleRows().findIndex(r => r.id === tr.dataset.rowId); $('mmCellAddress').textContent = String.fromCharCode(65 + Number(event.target.dataset.col)) + (index + 1); }
    });
    page.addEventListener('focusout', event => {
      if (event.target.dataset.field || event.target.id === 'mmCashflowNotes') commitEdit();
      if (event.target.dataset.field === 'amount' && event.target.getAttribute('aria-invalid') !== 'true') event.target.value = format(Model.amount(event.target.value));
      controls();
    });
    page.addEventListener('click', event => {
      const button = event.target.closest('[data-remove]');
      if (button) { const index = sheet.rows.findIndex(r => r.id === button.dataset.remove); const adjacent = sheet.rows[index + 1] || sheet.rows[index - 1]; transact(() => { sheet.rows = sheet.rows.filter(r => r.id !== button.dataset.remove); }, adjacent ? {id:adjacent.id,col:2} : null); }
    });
    page.addEventListener('paste', event => {
      const input = event.target, tr = input.closest('[data-row-id]');
      if (!tr || !input.dataset.field || !event.clipboardData) return;
      const raw = event.clipboardData.getData('text/plain');
      if (!/[\t\r\n]/.test(raw)) return;
      event.preventDefault();
      if ($('mmSheetSearch').value || $('mmSheetSort').value !== 'original') return notice('Hapus pencarian dan pilih Urutan asli sebelum menempel banyak sel.','error');
      const index = sheet.rows.findIndex(r => r.id === tr.dataset.rowId), col = Number(input.dataset.col);
      transact(() => { sheet = Model.paste(sheet, index, col, raw, id); }, {id:tr.dataset.rowId,col});
    });
    doc.addEventListener('keydown', onKey);
    root.addEventListener('beforeunload', event => { if (dirty() || saving) { event.preventDefault(); event.returnValue = ''; } });
    root.addEventListener('autocuan:portfolio-changed', event => { if (!event.detail || event.detail.userId === userId) queuePortfolio(); });
    root.addEventListener('storage', event => { if (event.key === 'autocuan_user_id' && event.newValue !== userId) reset(); else if (userId && event.key && event.key.startsWith('autocuan_portfolio_') && event.key.includes(userId)) queuePortfolio(); });
    root.addEventListener('focus', () => { if (visible() && userId) { if (sessionId() !== userId) reset(); else refreshPortfolio(false); } });
  }
  function reset() {
    generation++; requests.forEach(c => c.abort()); requests.clear();
    if (totalsFrame) root.cancelAnimationFrame(totalsFrame); totalsFrame = 0;
    lastSaveError = false; sheet = null; userId = ''; notes = ''; revision = null; saved = ''; loading = false; saving = false;
    undo = []; redo = []; editBefore = null; invalid.clear(); rowNodes.clear();
    if (!$('mmSheetViewport')) return;
    $('mmCashflowSpreadsheetBody').replaceChildren(); $('mmCashflowNotes').value = '';
    $('mmSheetViewport').hidden = true; blankOverview(); showPortfolio(null, 'Belum dimuat'); controls();
    notice('Muat lembar kerja dengan sesi akun Anda.'); stateLabel('Belum dimuat');
  }
  function init() {
    if (!$('page-money-management') || !Model) return;
    bind();
    if (userId && sessionId() !== userId) reset();
    if (!sheet && !loading) return load(month, true);
    if (sheet) refreshPortfolio(true);
  }
  root.initMoneyManagement = init;
  root.AutoCuanMoneySheet = { init, reset, hasUnsaved: dirty, refreshPortfolio, save };
})(window);
