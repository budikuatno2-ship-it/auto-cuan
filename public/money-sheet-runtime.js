/* Editable worksheet. Stable cell DOM; no polling, framework, or financial eval. */
(function (root) {
  'use strict';
  if (root.AutoCuanMoneySheet) return;
  const Model = root.AutoCuanMoneySheetModel;
  const doc = root.document;
  const $ = id => doc.getElementById(id);
  const money = value => value == null ? '\u2014' : 'Rp ' + value.toLocaleString('id-ID');
  const format = value => value.toLocaleString('id-ID');
  const metric = (id,value) => root.AutoCuanNumeric ? root.AutoCuanNumeric.set($(id),value,{prefix:'Rp '}) : ($(id).textContent=money(value));
  let sheet = null, month = Model.currentMonth(), notes = '', revision = null, userId = '';
  let lastSaveError = false;
  let saved = '', loading = false, saving = false, bound = false, generation = 0, totalsFrame = 0;
  let undo = [], redo = [], editBefore = null, nextId = 0, portfolioQueued = false, portfolioAt = 0;
  let grid = null;
  const invalid = new Map(), rowNodes = new Map(), requests = new Set(), composingInputs = new WeakSet();
  const encode = () => JSON.stringify({ sheet, notes });
  const dirty = () => !!sheet && (encode() !== saved || invalid.size > 0);
  const visible = () => $('page-money-management') && !$('page-money-management').classList.contains('hidden');
  const id = () => root.crypto && root.crypto.randomUUID ? root.crypto.randomUUID() : 'row-' + Date.now() + '-' + (++nextId);
  const sessionId = () => { try { return root.localStorage.getItem('autocuan_user_id') || ''; } catch (_) { return ''; } };

  function notice(message, tone) {
    const el = $('mmSheetNotice');
    el.textContent = message || ''; el.hidden = !message; el.dataset.tone = tone || 'info';
  }
  function stateLabel(label, state) { const el = $('mmSheetSaveState'); if(el.textContent!==label)el.textContent=label;if(el.dataset.state!==(state||''))el.dataset.state=state||''; }
  function controls() {
    const ready = !!sheet && !loading, isDirty=ready && dirty();
    $('mmAddRow').disabled = !ready || sheet.rows.length >= Model.MAX_ROWS;
    $('mmUndo').disabled = !ready || (!undo.length && !editBefore);
    $('mmRedo').disabled = !ready || !redo.length;
    $('mmExport').disabled = !ready;
    $('mmBtnSaveCashflow').disabled = !ready || saving || !isDirty || invalid.size > 0;
    const saveLabel=saving?'Menyimpan...':'Simpan';if($('mmBtnSaveCashflow').textContent!==saveLabel)$('mmBtnSaveCashflow').textContent=saveLabel;
    $('mmSheetMonth').disabled = loading || saving;
    $('mmReload').disabled = loading || saving;
    $('mmCashflowNotes').disabled = !ready;
    if (ready && !saving && !lastSaveError) stateLabel(isDirty ? 'Belum disimpan' : revision == null ? 'Bulan baru' : 'Tersimpan', isDirty ? 'dirty' : 'saved');
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
    metric('mmTotalIncomeDisplay', t.income);
    metric('mmTotalLivingExpenseDisplay', t.expense);
    metric('mmSheetAllocation', t.saving + t.transfer);
    metric('mmRemainingBudgetDisplay', t.remaining);
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
    if (input) { input.focus({ preventScroll: true }); input.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' }); if(root.AutoCuanViewport)root.AutoCuanViewport.reveal(input); }
  }
  function makeRow(row) {
    const tr = doc.createElement('tr'); tr.dataset.rowId = row.id;
    const number = doc.createElement('th'); number.className = 'ms-row-number'; number.scope = 'row';
    const pick = doc.createElement('button'); pick.type = 'button'; pick.dataset.selectRow = row.id; number.appendChild(pick); tr.appendChild(number);
    Model.FIELDS.forEach((field, col) => {
      const td = doc.createElement('td'); td.setAttribute('role','gridcell');
      const input = doc.createElement(field === 'type' ? 'select' : field === 'note' ? 'textarea' : 'input');
      input.dataset.field = field; input.dataset.col = String(col); input.enterKeyHint=field==='note'?'enter':'next';
      if (field === 'type') Model.TYPES.forEach(type => { const option = doc.createElement('option'); option.value = type; option.textContent = Model.TYPE_LABELS[type]; input.appendChild(option); });
      else {
        if(field === 'note') input.rows=1; else input.type = 'text'; input.autocomplete = 'off'; input.spellcheck = false;
        input.maxLength = field === 'note' ? 500 : field === 'label' ? 160 : field === 'category' ? 80 : 240;
        if (field === 'amount') input.inputMode = 'text';
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
    const keep = new Set(sheet.rows.map(r => r.id)), positions = new Map(sheet.rows.map((r,i)=>[r.id,i+1]));
    for (const key of rowNodes.keys()) if (!keep.has(key)) rowNodes.delete(key);
    rows.forEach((row, index) => {
      let tr = rowNodes.get(row.id);
      if (!tr) { tr = makeRow(row); rowNodes.set(row.id, tr); }
      const physical = positions.get(row.id);
      tr.firstChild.firstChild.textContent = String(physical); tr.firstChild.firstChild.setAttribute('aria-label','Pilih baris '+physical);
      Model.FIELDS.forEach((field, col) => {
        const input = tr.querySelector('[data-col="' + col + '"]');
        input.setAttribute('aria-label', (field === 'amount' ? 'Nominal rupiah' : ['Jenis','Kategori','Nama pos','Nominal','Catatan'][col]) + ', baris ' + physical);
        const errorState = invalid.get(row.id + ':' + field);
        if (errorState) input.value = errorState.raw;
        else if (force || input !== doc.activeElement) input.value = field === 'amount' ? (input === doc.activeElement && row.formula ? row.formula : format(row.amount)) : row[field];
        if (field === 'amount') { input.dataset.formula = row.formula || ''; input.title = row.formula ? row.formula + ' = Rp ' + format(row.amount) : ''; }
        input.setAttribute('aria-invalid', invalid.has(row.id + ':' + field) ? 'true' : 'false');
      });
      tr.querySelector('[data-remove]').setAttribute('aria-label', 'Hapus baris ' + physical);
      fragment.appendChild(tr);
    });
    $('mmCashflowSpreadsheetBody').replaceChildren(fragment);
    $('mmSheetRowCount').textContent = rows.length + ' dari ' + sheet.rows.length + ' baris';
    if (!rows.length) notice(sheet.rows.length ? 'Tidak ada pos yang cocok dengan pencarian.' : 'Lembar masih kosong. Tambahkan baris untuk mulai menyusun anggaran.');
    else if (!invalid.size) notice('');
    if (focus) focusCell(focus.id, focus.col);
    updateTotals();
    if (grid) grid.refresh();
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
    ['mmTotalIncomeDisplay','mmTotalLivingExpenseDisplay','mmSheetAllocation','mmRemainingBudgetDisplay'].forEach(key => { metric(key,null); });
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
    metric('mmPortfolioExposure', summary ? summary.totalExposureIdr : null);
    metric('mmPortfolioPnl', summary ? summary.totalPnlIdr : null);
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
    if(event.isComposing||composingInputs.has(input))return;
    if (input.id === 'mmCashflowNotes') { notes = input.value; changed(); return; }
    const tr = input.closest('[data-row-id]'); if (!tr || !input.dataset.field || !sheet) return;
    const row = sheet.rows.find(r => r.id === tr.dataset.rowId); if (!row) return;
    const key = row.id + ':' + input.dataset.field;
    try {
      const candidate = JSON.parse(JSON.stringify(sheet));
      Model.setRaw(candidate.rows.find(r => r.id === row.id), input.dataset.field, input.value);
      sheet = Model.normalize(candidate);
      invalid.delete(key); input.setAttribute('aria-invalid','false');
      if (!invalid.size) notice('');
    } catch (error) { invalid.set(key, { message: error.message, raw: input.value }); input.setAttribute('aria-invalid','true'); notice(error.message,'error'); }
    syncComputedCells(); changed();
    if (grid) grid.paint();
  }
  function syncComputedCells() {
    if (!sheet) return;
    sheet.rows.forEach(row => { const node=rowNodes.get(row.id); const input=node && node.querySelector('[data-col="3"]');
      if (input && input!==doc.activeElement && !invalid.has(row.id+':amount')) {const value=format(row.amount);if(input.value!==value)input.value=value;}
      if (input) {const formula=row.formula||'',title=row.formula?row.formula+' = Rp '+format(row.amount):'';if(input.dataset.formula!==formula)input.dataset.formula=formula;if(input.title!==title)input.title=title;}
    });
  }
  function onKey(event) {
    if (event.defaultPrevented || event.isComposing || event.keyCode===229 || composingInputs.has(event.target) || !visible() || !sheet || loading) return;
    const modifier = event.ctrlKey || event.metaKey;
    if (modifier && event.key.toLowerCase() === 's') { event.preventDefault(); save(); return; }
    if (modifier && event.key.toLowerCase() === 'z') { event.preventDefault(); restore(event.shiftKey ? 'redo' : 'undo'); return; }
    if (modifier && event.key.toLowerCase() === 'y') { event.preventDefault(); restore('redo'); return; }
    const input = event.target, tr = input.closest && input.closest('[data-row-id]');
    if (!tr || !input.dataset.field || event.isComposing || modifier || event.altKey) return;
    const rows = visibleRows(), index = rows.findIndex(r => r.id === tr.dataset.rowId), col = Number(input.dataset.col);
    if(input.tagName==='TEXTAREA'&&event.key!=='Tab')return;
    if(event.shiftKey&&/^Arrow/.test(event.key))return;
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
    if (root.AutoCuanMoneySheetGrid) grid = root.AutoCuanMoneySheetGrid.create({
      sheet:()=>sheet, rows:()=>sheet&&!loading?visibleRows():[], focus:focusCell, notice,
      cell:(rowId,col,value)=>{ const node=rowNodes.get(rowId), input=node&&node.querySelector('[data-col="'+col+'"]'); if(!input)return; commitEdit(); editBefore=encode(); input.value=value; onInput({target:input}); commitEdit(); syncComputedCells(); },
      cells:changes=>transact(()=>{ const next=JSON.parse(JSON.stringify(sheet)); changes.forEach(p=>{const row=next.rows.find(r=>r.id===p.id); if(row)Model.setRaw(row,Model.FIELDS[p.col],p.value);}); sheet=Model.normalize(next); }),
      insert:rowId=>{const row=Model.newRow(id());transact(()=>{sheet=Model.insertRows(sheet,sheet.rows.findIndex(r=>r.id===rowId),[row]);},{id:row.id,col:2});},
      remove:ids=>transact(()=>{sheet=Model.removeRows(sheet,ids);})
    });
    page.addEventListener('compositionstart',event=>composingInputs.add(event.target));
    page.addEventListener('compositionend',event=>{composingInputs.delete(event.target);onInput(event);});
    page.addEventListener('input', onInput);
    page.addEventListener('focusin', event => {
      if (event.target.dataset.field || event.target.id === 'mmCashflowNotes') { editBefore = encode(); controls(); }
      const tr = event.target.closest('[data-row-id]');
      if (tr && event.target.dataset.field === 'amount' && !invalid.has(tr.dataset.rowId+':amount')) { const row=sheet.rows.find(r=>r.id===tr.dataset.rowId); if(row.formula) { event.target.value=row.formula; event.target.select(); } }
    });
    page.addEventListener('focusout', event => {
      if (event.target.dataset.field || event.target.id === 'mmCashflowNotes') commitEdit();
      if (event.target.dataset.field === 'amount' && event.target.getAttribute('aria-invalid') !== 'true') { const tr=event.target.closest('[data-row-id]'), row=sheet&&sheet.rows.find(r=>r.id===tr.dataset.rowId); if(row) event.target.value=format(row.amount); }
      controls();
    });
    page.addEventListener('click', event => {
      const button = event.target.closest('[data-remove]');
      if (button) { const index = sheet.rows.findIndex(r => r.id === button.dataset.remove); const adjacent = sheet.rows[index + 1] || sheet.rows[index - 1]; transact(() => { sheet = Model.removeRows(sheet,[button.dataset.remove]); }, adjacent ? {id:adjacent.id,col:2} : null); }
    });
    page.addEventListener('paste', event => {
      const input = event.target, tr = input.closest('[data-row-id]');
      if (!tr || !input.dataset.field || !event.clipboardData) return;
      const raw = event.clipboardData.getData('text/plain');
      if (!/[\t\r\n]/.test(raw)) return;
      if(input.tagName==='TEXTAREA'&&!raw.includes('\t')&&!raw.startsWith('"'))return;
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
    if (grid) grid.reset();
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
