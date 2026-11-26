(function () {
  'use strict';

  if (window.__AUTOCUAN_MANUAL_PAYMENT_V1__) return;
  window.__AUTOCUAN_MANUAL_PAYMENT_V1__ = true;

  var API = '/api/subscription-manual';
  var VOUCHER_API = '/api/subscription-voucher';
  var PENDING_KEY = 'autocuan_pending_manual_payment';
  var pollTimer = null;
  var installTimer = null;
  var lastToastKey = '';

  var PLAN_BY_NAME = {
    'Premium 1 Bulan':'PREMIUM_1_MONTH',
    'Premium 2 Bulan':'PREMIUM_2_MONTHS',
    'Premium 3 Bulan':'PREMIUM_3_MONTHS',
    'Lifetime':'LIFETIME'
  };

  var PLAN_LABEL = {
    PREMIUM_1_MONTH:'Premium 1 Bulan',
    PREMIUM_2_MONTHS:'Premium 2 Bulan',
    PREMIUM_3_MONTHS:'Premium 3 Bulan',
    LIFETIME:'Lifetime'
  };

  function esc(value) {
    return String(value == null ? '' : value).replace(/[&<>"']/g, function (c) {
      return ({ '&':'&amp;', '<':'&lt;', '>':'&gt;', '"':'&quot;', "'":'&#39;' })[c];
    });
  }

  function idr(value) {
    var n = Number(value);
    if (!Number.isFinite(n)) return '—';
    try { return new Intl.NumberFormat('id-ID', { style:'currency', currency:'IDR', maximumFractionDigits:0 }).format(n); }
    catch (_) { return 'Rp ' + Math.round(n).toLocaleString('id-ID'); }
  }

  function notify(message, kind) {
    var key = String(kind || '') + ':' + String(message || '');
    if (key === lastToastKey) return;
    lastToastKey = key;
    setTimeout(function () { if (lastToastKey === key) lastToastKey = ''; }, 1500);
    if (typeof window.showToast === 'function') {
      try { window.showToast(message, kind || 'info'); return; } catch (_) {}
    }
    try { window.alert(message); } catch (_) {}
  }

  async function request(body, timeoutMs) {
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { try { controller.abort(); } catch (_) {} }, timeoutMs || 9000) : null;
    try {
      var response = await fetch(API, {
        method:'POST',
        credentials:'same-origin',
        cache:'no-store',
        headers:{ 'Content-Type':'application/json', 'Cache-Control':'no-cache' },
        body:JSON.stringify(body || {}),
        signal:controller ? controller.signal : undefined
      });
      var data = await response.json().catch(function () { return {}; });
      return { ok:response.ok, status:response.status, data:data };
    } catch (_) {
      return { ok:false, status:0, data:{ error:'Koneksi ke server sedang bermasalah.' } };
    } finally { if (timer) clearTimeout(timer); }
  }

  async function requestVoucher(body, timeoutMs) {
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = controller ? setTimeout(function () { try { controller.abort(); } catch (_) {} }, timeoutMs || 9000) : null;
    try {
      var response = await fetch(VOUCHER_API, {
        method:'POST',
        credentials:'same-origin',
        cache:'no-store',
        headers:{ 'Content-Type':'application/json', 'Cache-Control':'no-cache' },
        body:JSON.stringify(body || {}),
        signal:controller ? controller.signal : undefined
      });
      var data = await response.json().catch(function () { return {}; });
      return { ok:response.ok, status:response.status, data:data };
    } catch (_) {
      return { ok:false, status:0, data:{ error:'Koneksi ke server sedang bermasalah.' } };
    } finally { if (timer) clearTimeout(timer); }
  }

  function ensureStyle() {
    if (document.getElementById('acManualPaymentStyle')) return;
    var style = document.createElement('style');
    style.id = 'acManualPaymentStyle';
    style.textContent = [
      '.ac-manual-buy{width:100%;margin-top:12px;border:0;border-radius:10px;min-height:40px;padding:10px 12px;background:var(--ac-brand,#13785D);color:var(--ac-on-brand,#FFFFFF);font-weight:800;cursor:pointer;transition:background-color .15s ease,transform .12s cubic-bezier(.22,1,.36,1)}',
      '.ac-manual-buy:hover{background:var(--ac-brand-hover,#0D634C)}',
      '.ac-manual-buy:active{transform:scale(.98)}',
      '.ac-pay-backdrop{position:fixed;inset:0;z-index:2147483000;background:var(--ac-backdrop,rgba(14,20,18,.78));backdrop-filter:blur(10px);-webkit-backdrop-filter:blur(10px);display:flex;align-items:center;justify-content:center;padding:18px}',
      '.ac-pay-shell{width:min(540px,100%);max-height:min(780px,92vh);overflow:auto;background:var(--ac-surface,#141C19);border:1px solid var(--ac-line-soft,rgba(148,163,184,.22));border-radius:18px;box-shadow:var(--ac-shadow-modal,0 25px 80px rgba(0,0,0,.45));padding:20px;color:var(--ac-ink,#E4EBE7)}',
      '.ac-pay-head{display:flex;align-items:flex-start;justify-content:space-between;gap:12px;margin-bottom:12px}',
      '.ac-pay-title{font-size:19px;font-weight:800;margin:0;color:var(--ac-ink,#E4EBE7)}.ac-pay-sub{font-size:12px;color:var(--ac-text-secondary,#9AA7A1);margin-top:4px}',
      '.ac-pay-close{border:1px solid var(--ac-line-hairline,rgba(148,163,184,.24));background:var(--ac-surface-raised,#19231F);color:var(--ac-ink,#E4EBE7);border-radius:10px;width:40px;height:40px;font-size:20px;cursor:pointer}',
      '.ac-pay-stepper{display:grid;grid-template-columns:repeat(3,1fr);gap:6px;margin-bottom:12px}',
      '.ac-pay-step{font-size:11px;font-weight:700;padding:6px 8px;border-radius:8px;background:var(--ac-surface-raised,#19231F);color:var(--ac-text-muted,#848D88);border:1px solid var(--ac-line-hairline,transparent);text-align:center}',
      '.ac-pay-step.is-on{background:var(--ac-brand-soft,rgba(72,199,151,.15));color:var(--ac-brand,#48C797);border-color:var(--ac-brand,#48C797)}',
      '.ac-pay-box{border:1px solid var(--ac-line-hairline,rgba(148,163,184,.18));border-radius:12px;padding:12px;background:var(--ac-surface-raised,#19231F);margin-top:10px}',
      '.ac-pay-row{display:flex;justify-content:space-between;gap:14px;padding:6px 0;font-size:13px}.ac-pay-row span:first-child{color:var(--ac-text-secondary,#9AA7A1)}.ac-pay-row strong{text-align:right;color:var(--ac-ink,#E4EBE7)}',
      '.ac-pay-label{display:block;font-size:12px;font-weight:700;color:var(--ac-text-secondary,#9AA7A1);margin:12px 0 5px}',
      '.ac-pay-input{width:100%;box-sizing:border-box;min-height:42px;border:1px solid var(--ac-control-border,rgba(148,163,184,.26));border-radius:10px;background:var(--ac-canvas,#0E1412);color:var(--ac-ink,#E4EBE7);padding:10px 12px;outline:none;font-size:14px}',
      '.ac-pay-input:focus{border-color:var(--ac-brand,#48C797);box-shadow:0 0 0 3px var(--ac-brand-soft,rgba(72,199,151,.18))}',
      '.ac-pay-actions{display:flex;gap:8px;margin-top:14px;flex-wrap:wrap}.ac-pay-btn{flex:1;min-width:120px;min-height:42px;border:1px solid var(--ac-control-border,rgba(148,163,184,.24));border-radius:10px;padding:10px 12px;background:var(--ac-surface-raised,#19231F);color:var(--ac-ink,#E4EBE7);font-weight:800;cursor:pointer}.ac-pay-btn.primary{background:var(--ac-brand,#13785D);color:var(--ac-on-brand,#FFFFFF);border-color:transparent}.ac-pay-btn.danger{background:var(--ac-negative-soft,#3a1418);border-color:var(--ac-negative,#AD3F52);color:var(--ac-negative,#fecaca)}',
      '.ac-pay-status{margin-top:12px;border-radius:10px;padding:10px 12px;background:var(--ac-surface-raised,#19231F);border:1px solid var(--ac-line-hairline,transparent);color:var(--ac-text-secondary,#cbd5e1);font-size:12px;line-height:1.5}',
      '.ac-pay-code{font-family:var(--ac-font-mono,ui-monospace,SFMono-Regular,Menlo,monospace);color:var(--ac-brand,#48C797);font-weight:800}',
      '@media(max-width:560px){.ac-pay-backdrop{padding:8px;align-items:flex-end}.ac-pay-shell{border-radius:18px 18px 0 0;max-height:94vh}.ac-pay-input{font-size:16px}}'
    ].join('');
    document.head.appendChild(style);
  }

  function closeModal() {
    var root = document.getElementById('acManualPaymentModal');
    if (root) root.remove();
  }

  function modal(title, subtitle, bodyHtml, activeStep) {
    ensureStyle();
    closeModal();
    var step = activeStep || 1;
    var stepper = '<div class="ac-pay-stepper" aria-label="Tahap pembayaran">' +
      '<div class="ac-pay-step ' + (step >= 1 ? 'is-on' : '') + '">1 · Paket &amp; Voucher</div>' +
      '<div class="ac-pay-step ' + (step >= 2 ? 'is-on' : '') + '">2 · Transfer &amp; Bukti</div>' +
      '<div class="ac-pay-step ' + (step >= 3 ? 'is-on' : '') + '">3 · Aktivasi Admin</div>' +
      '</div>';
    var root = document.createElement('div');
    root.id = 'acManualPaymentModal';
    root.className = 'ac-pay-backdrop';
    root.innerHTML = '<section class="ac-pay-shell" role="dialog" aria-modal="true">' +
      '<div class="ac-pay-head"><div><h2 class="ac-pay-title">' + esc(title) + '</h2><div class="ac-pay-sub">' + esc(subtitle || '') + '</div></div><button type="button" class="ac-pay-close" aria-label="Tutup">×</button></div>' +
      stepper +
      '<div id="acManualPaymentBody">' + bodyHtml + '</div></section>';
    document.body.appendChild(root);
    root.querySelector('.ac-pay-close').addEventListener('click', closeModal);
    root.addEventListener('click', function (event) { if (event.target === root) closeModal(); });
    return root;
  }

  function currentPending() {
    try { return localStorage.getItem(PENDING_KEY) || ''; } catch (_) { return ''; }
  }

  function savePending(reference) {
    try { if (reference) localStorage.setItem(PENDING_KEY, reference); else localStorage.removeItem(PENDING_KEY); } catch (_) {}
  }

  function randomUuid() {
    if (window.crypto && typeof window.crypto.randomUUID === 'function') return window.crypto.randomUUID();
    return null;
  }

  async function redeemDirectVoucher(planCode, voucherCode, button) {
    var termsCb = document.getElementById('acPayDirectTerms');
    if (!termsCb || !termsCb.checked) {
      notify('Centang persetujuan kebijakan aktivasi voucher sebelum melanjutkan.','warning');
      return;
    }
    var key = randomUuid();
    if (!key) { notify('Browser tidak mendukung aktivasi voucher aman.','error'); return; }
    if (button) button.disabled = true;
    var result = await requestVoucher({
      voucher_code:voucherCode,
      idempotency_key:key,
      termsAccepted:true,
      paymentTermsAccepted:true,
      termsVersion:'2026-08-16-v1'
    }, 10000);
    if (button) button.disabled = false;
    if (!result.ok || !result.data.success) {
      notify(result.data.error || 'Voucher belum dapat diaktifkan.','error');
      return;
    }
    await refreshAccess();
    closeModal();
    notify(result.data.admin_notified === false ? 'Voucher aktif. Notifikasi admin belum terkirim.' : 'Voucher berhasil diaktifkan. Akses Premium sudah diperbarui.','success');
    if (typeof window.openAccountSubscription === 'function') {
      try { setTimeout(function () { window.openAccountSubscription(); }, 250); } catch (_) {}
    }
  }

  function renderDirectVoucher(planCode, voucherCode) {
    var body = document.getElementById('acManualPaymentBody');
    if (!body) return;
    var hint = String(voucherCode || '').slice(-4);
    body.innerHTML = [
      '<div class="ac-pay-box">',
      '<div class="ac-pay-row"><span>Paket</span><strong>' + esc(PLAN_LABEL[planCode] || planCode) + '</strong></div>',
      '<div class="ac-pay-row"><span>Voucher</span><strong class="ac-pay-code">••••' + esc(hint) + '</strong></div>',
      '<div class="ac-pay-row"><span>Total</span><strong style="color:#6ee7b7;font-size:18px">Rp0</strong></div>',
      '</div>',
      '<div class="ac-pay-status">✅ Voucher ini memberikan aktivasi langsung. <b>Tidak perlu transfer</b> dan tidak perlu konfirmasi pembayaran admin.</div>',
      '<label style="display:flex;gap:8px;align-items:flex-start;margin:12px 0;font-size:11px;color:#cbd5e1;cursor:pointer"><input type="checkbox" id="acPayDirectTerms" style="margin-top:2px;accent-color:#10b981"><span>Saya memahami Kebijakan Pembayaran, Refund, dan Disclaimer Risiko Finansial</span></label>',
      '<div class="ac-pay-actions"><button type="button" id="acPayDirectVoucher" class="ac-pay-btn primary">Aktifkan voucher</button></div>'
    ].join('');
    var activate = document.getElementById('acPayDirectVoucher');
    if (activate) activate.addEventListener('click', function () {
      redeemDirectVoucher(planCode, voucherCode, activate);
    });
  }

  async function createPayment(planCode, voucherCode, button) {
    var key = randomUuid();
    if (!key) { notify('Browser tidak mendukung checkout aman.','error'); return; }
    if (button) button.disabled = true;
    var result = await request({ action:'create', plan_code:planCode, voucher_code:voucherCode || '', idempotency_key:key }, 10000);
    if (button) button.disabled = false;
    if (!result.ok || !result.data.success) {
      if (result.data && result.data.code === 'DIRECT_VOUCHER') {
        renderDirectVoucher(planCode, String(voucherCode || '').toUpperCase());
        return;
      }
      notify(result.data.error || 'Checkout belum dapat dibuat.','error');
      return;
    }
    renderTransfer(result.data.payment, result.data.bank);
  }

  function openCheckout(planCode) {
    var label = PLAN_LABEL[planCode] || planCode;
    var root = modal('Pembelian ' + label, 'Transfer manual · akses aktif setelah dikonfirmasi admin', [
      '<div class="ac-pay-box"><div class="ac-pay-row"><span>Paket</span><strong>' + esc(label) + '</strong></div></div>',
      '<label class="ac-pay-label" for="acPayVoucher">Voucher (opsional)</label>',
      '<input id="acPayVoucher" class="ac-pay-input" autocomplete="off" spellcheck="false" placeholder="AC-XXXXXXXXXXXX">',
      '<div class="ac-pay-status">Voucher 30%/50% akan mengurangi nominal transfer. Voucher 100% atau Lifetime akan berubah menjadi aktivasi Rp0 langsung di modal ini.</div>',
      '<div class="ac-pay-actions"><button type="button" id="acPayContinue" class="ac-pay-btn primary">Lanjut</button></div>'
    ].join(''));
    var button = root.querySelector('#acPayContinue');
    button.addEventListener('click', function () {
      var input = root.querySelector('#acPayVoucher');
      createPayment(planCode, input ? input.value.trim().toUpperCase() : '', button);
    });
  }

  function renderTransfer(payment, bank) {
    if (!payment || !bank) { notify('Detail pembayaran belum tersedia.','error'); return; }
    var body = document.getElementById('acManualPaymentBody');
    if (!body) return;
    body.innerHTML = [
      '<div class="ac-pay-box">',
      '<div class="ac-pay-row"><span>Referensi</span><strong class="ac-pay-code">' + esc(payment.payment_reference) + '</strong></div>',
      '<div class="ac-pay-row"><span>Paket</span><strong>' + esc(PLAN_LABEL[payment.plan_code] || payment.plan_code) + '</strong></div>',
      '<div class="ac-pay-row"><span>Harga paket</span><strong>' + esc(idr(payment.price_idr)) + '</strong></div>',
      payment.discount_percent ? '<div class="ac-pay-row"><span>Voucher</span><strong>' + esc(String(payment.discount_percent)) + '% · ••••' + esc(payment.voucher_code_hint || '') + '</strong></div>' : '',
      '<div class="ac-pay-row"><span>Total transfer</span><strong style="color:#6ee7b7;font-size:16px">' + esc(idr(payment.amount_due_idr)) + '</strong></div>',
      '</div>',
      '<div class="ac-pay-box">',
      '<div class="ac-pay-row"><span>Bank</span><strong>' + esc(bank.bank_name) + '</strong></div>',
      '<div class="ac-pay-row"><span>No. rekening</span><strong class="ac-pay-code" id="acPayAccount">' + esc(bank.account_number) + '</strong></div>',
      '<div class="ac-pay-row"><span>Atas nama</span><strong>' + esc(bank.account_holder) + '</strong></div>',
      '<div class="ac-pay-actions"><button type="button" id="acPayCopy" class="ac-pay-btn">Salin no. rekening</button></div>',
      '</div>',
      '<label class="ac-pay-label" for="acPaySender">Nama pengirim rekening</label>',
      '<input id="acPaySender" class="ac-pay-input" maxlength="100" autocomplete="name" placeholder="Nama pemilik rekening pengirim">',
      '<label class="ac-pay-label" for="acPayNote">Catatan transfer (opsional)</label>',
      '<input id="acPayNote" class="ac-pay-input" maxlength="500" placeholder="Contoh: transfer dari BCA / jam transfer">',
      '<div class="ac-pay-status">Transfer sesuai <b>total transfer</b> di atas. Subscription belum aktif sampai admin memeriksa transfer dan menekan konfirmasi.</div>',
      '<label style="display:flex;gap:8px;align-items:flex-start;margin:12px 0;font-size:11px;color:#cbd5e1;cursor:pointer"><input type="checkbox" id="acPayTerms" style="margin-top:2px;accent-color:#10b981"><span>Saya memahami Kebijakan Pembayaran, Refund, dan Disclaimer Risiko Finansial</span></label>',
      '<div class="ac-pay-actions"><button type="button" id="acPaySubmitted" class="ac-pay-btn primary">Saya sudah transfer</button></div>'
    ].join('');

    var copy = document.getElementById('acPayCopy');
    if (copy) copy.addEventListener('click', function () {
      var number = String(bank.account_number || '');
      if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(number).then(function () { notify('Nomor rekening disalin.','success'); }).catch(function () {});
      }
    });

    var submit = document.getElementById('acPaySubmitted');
    if (submit) submit.addEventListener('click', async function () {
      var termsCb = document.getElementById('acPayTerms');
      if (!termsCb || !termsCb.checked) {
        notify('Centang persetujuan kebijakan pembayaran sebelum mengirim konfirmasi transfer.','warning');
        return;
      }
      var senderName = (document.getElementById('acPaySender') || {}).value || '';
      var note = (document.getElementById('acPayNote') || {}).value || '';
      senderName = senderName.trim();
      if (senderName.length < 2) { notify('Isi nama pemilik rekening pengirim.','warning'); return; }
      submit.disabled = true;
      var result = await request({
        action:'submit',
        payment_reference:payment.payment_reference,
        transfer_sender_name:senderName,
        transfer_note:note.trim(),
        paymentTermsAccepted:true,
        termsAccepted:true,
        termsVersion:'2026-08-16-v1'
      }, 10000);
      submit.disabled = false;
      if (!result.ok || !result.data.success) { notify(result.data.error || 'Konfirmasi transfer belum terkirim.','error'); return; }
      savePending(payment.payment_reference);
      renderWaiting(result.data.payment || payment);
      startPolling();
      notify(result.data.admin_notified === false ? 'Transfer tercatat. Notifikasi admin belum terkirim; status tetap tersimpan.' : 'Transfer tercatat dan admin sudah diberi notifikasi.','success');
    });
  }

  function renderWaiting(payment) {
    var body = document.getElementById('acManualPaymentBody');
    if (!body) return;
    body.innerHTML = '<div class="ac-pay-box"><div class="ac-pay-row"><span>Referensi</span><strong class="ac-pay-code">' + esc(payment.payment_reference || '') + '</strong></div><div class="ac-pay-row"><span>Status</span><strong>Menunggu konfirmasi admin ⏳</strong></div></div><div class="ac-pay-status">Tidak perlu logout atau login ulang. Halaman ini akan mendeteksi approval dan membuka akses Premium otomatis.</div>';
  }

  async function refreshAccess() {
    try {
      window.dispatchEvent(new CustomEvent('autocuan:subscription-changed', { detail:{ source:'manual_payment' } }));
    } catch (_) {}
    if (typeof window.refreshSubscriptionStatus === 'function') {
      try { await window.refreshSubscriptionStatus(); } catch (_) {}
    }
  }

  async function pollOnce(reference) {
    if (!reference) return;
    var result = await request({ action:'status', payment_reference:reference }, 7000);
    if (!result.ok || !result.data.success || !result.data.payment) return;
    var p = result.data.payment;
    if (p.status === 'approved') {
      savePending('');
      stopPolling();
      await refreshAccess();
      closeModal();
      notify('✅ Pembayaran dikonfirmasi. Subscription aktif dan akses Premium sudah diperbarui.','success');
      if (typeof window.openAccountSubscription === 'function') {
        try { setTimeout(function () { window.openAccountSubscription(); }, 250); } catch (_) {}
      }
    } else if (p.status === 'rejected') {
      savePending('');
      stopPolling();
      closeModal();
      notify('Pembayaran belum disetujui admin. Periksa transfer atau hubungi admin.','error');
    }
  }

  function startPolling() {
    if (pollTimer) return;
    var reference = currentPending();
    if (!reference) return;
    pollOnce(reference);
    pollTimer = setInterval(function () {
      var ref = currentPending();
      if (!ref) { stopPolling(); return; }
      if (document.visibilityState === 'visible') pollOnce(ref);
    }, 5000);
  }

  function stopPolling() {
    if (pollTimer) clearInterval(pollTimer);
    pollTimer = null;
  }

  function cardPlanCode(card) {
    var name = card && card.querySelector('.ac-plan-name');
    return name ? PLAN_BY_NAME[String(name.textContent || '').trim()] || null : null;
  }

  function installBuyButtons() {
    var panels = document.querySelectorAll('#acPanelLangganan, #acPanelSubscription');
    if (!panels || !panels.length) return false;
    var count = 0;
    panels.forEach(function (panel) {
      var cards = panel.querySelectorAll('.ac-plan');
      cards.forEach(function (card) {
        count += 1;
        if (card.querySelector('[data-ac-manual-buy]')) return;
        var code = cardPlanCode(card);
        if (!code) return;
        var button = document.createElement('button');
        button.type = 'button';
        button.className = 'ac-manual-buy';
        button.setAttribute('data-ac-manual-buy', code);
        button.textContent = card.classList.contains('ac-plan-current') ? 'Perpanjang paket' : 'Beli paket';
        button.addEventListener('click', function () { openCheckout(code); });
        card.appendChild(button);
      });
    });
    return count > 0;
  }

  function watchAccountCenter() {
    if (installTimer) return;
    var attempts = 0;
    installTimer = setInterval(function () {
      attempts += 1;
      installBuyButtons();
      if (attempts > 180) { clearInterval(installTimer); installTimer = null; }
    }, 700);
  }

  async function adminReviewFromUrl(reference) {
    if (!PAYMENT_REF_RE.test(reference || '')) return;
    var result = await request({ action:'admin-detail', payment_reference:reference }, 8000);
    if (!result.ok || !result.data.success || !result.data.payment) {
      if (result.status === 401 || result.status === 403) notify('Login sebagai admin Budi dulu, lalu buka kembali notifikasi pembayaran.','warning');
      else notify(result.data.error || 'Detail pembayaran belum dapat dibuka.','error');
      return;
    }
    var p = result.data.payment;
    var root = modal('Review Pembayaran', 'Konfirmasi hanya setelah transfer benar-benar terlihat di rekening', [
      '<div class="ac-pay-box">',
      '<div class="ac-pay-row"><span>User</span><strong>' + esc(result.data.username || '—') + '</strong></div>',
      '<div class="ac-pay-row"><span>Paket</span><strong>' + esc(PLAN_LABEL[p.plan_code] || p.plan_code) + '</strong></div>',
      '<div class="ac-pay-row"><span>Nominal</span><strong>' + esc(idr(p.amount_due_idr)) + '</strong></div>',
      '<div class="ac-pay-row"><span>Pengirim</span><strong>' + esc(p.transfer_sender_name || '—') + '</strong></div>',
      '<div class="ac-pay-row"><span>Voucher</span><strong>' + esc(p.voucher_code_hint ? '••••' + p.voucher_code_hint + (p.discount_percent ? ' · ' + p.discount_percent + '%' : '') : 'Tidak ada') + '</strong></div>',
      '<div class="ac-pay-row"><span>Referensi</span><strong class="ac-pay-code">' + esc(p.payment_reference) + '</strong></div>',
      p.transfer_note ? '<div class="ac-pay-row"><span>Catatan</span><strong>' + esc(p.transfer_note) + '</strong></div>' : '',
      '</div>',
      p.status === 'submitted' ? '<div class="ac-pay-actions"><button type="button" id="acPayReject" class="ac-pay-btn danger">Tolak</button><button type="button" id="acPayApprove" class="ac-pay-btn primary">✅ Konfirmasi & Aktifkan</button></div>' : '<div class="ac-pay-status">Pembayaran ini sudah berstatus <b>' + esc(p.status) + '</b>.</div>'
    ].join(''));

    async function review(decision, button) {
      if (button) button.disabled = true;
      var reviewed = await request({ action:'admin-review', payment_reference:reference, decision:decision }, 12000);
      if (button) button.disabled = false;
      if (!reviewed.ok || !reviewed.data.success) { notify(reviewed.data.error || 'Review belum berhasil.','error'); return; }
      try {
        var url = new URL(window.location.href);
        url.searchParams.delete('paymentReview');
        history.replaceState({}, '', url.pathname + url.search + url.hash);
      } catch (_) {}
      closeModal();
      notify(decision === 'approve' ? 'Subscription user berhasil diaktifkan.' : 'Pembayaran ditolak.','success');
    }

    var approve = root.querySelector('#acPayApprove');
    var reject = root.querySelector('#acPayReject');
    if (approve) approve.addEventListener('click', function () {
      if (window.confirm('Pastikan transfer sudah masuk. Aktifkan subscription untuk user ini?')) review('approve', approve);
    });
    if (reject) reject.addEventListener('click', function () {
      if (window.confirm('Tolak konfirmasi pembayaran ini?')) review('reject', reject);
    });
  }

  var PAYMENT_REF_RE = /^PAY-[A-F0-9]{12}$/;

  async function handleDeepLinks() {
    var params;
    try { params = new URLSearchParams(window.location.search); } catch (_) { return; }
    var review = String(params.get('paymentReview') || '').toUpperCase();
    var buy = String(params.get('buy') || '').toUpperCase();
    if (review) {
      var ready = window.autocuanAuthReady;
      if (ready && typeof ready.then === 'function') {
        try { await ready; } catch (_) {}
      } else {
        await new Promise(function (resolve) { setTimeout(resolve, 600); });
      }
      await adminReviewFromUrl(review);
      return;
    }
    if (PLAN_LABEL[buy]) {
      var authReady = window.autocuanAuthReady;
      if (authReady && typeof authReady.then === 'function') {
        try { await authReady; } catch (_) {}
      }
      openCheckout(buy);
    }
  }

  function init() {
    ensureStyle();
    watchAccountCenter();
    startPolling();
    handleDeepLinks();
    window.addEventListener('focus', function () { var ref=currentPending(); if(ref) pollOnce(ref); });
    window.addEventListener('autocuan:account-center-opened', installBuyButtons);
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once:true });
  else init();
})();