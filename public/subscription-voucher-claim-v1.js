(function () {
  'use strict';
  if (window.__AUTOCUAN_VOUCHER_CLAIM_V1__) return;
  window.__AUTOCUAN_VOUCHER_CLAIM_V1__ = true;

  function notify(message, kind) {
    if (typeof window.showToast === 'function') {
      try { window.showToast(message, kind || 'info'); return; } catch (_) {}
    }
    try { window.alert(message); } catch (_) {}
  }

  async function refreshAccess() {
    try { window.dispatchEvent(new CustomEvent('autocuan:subscription-changed', { detail:{ source:'voucher' } })); } catch (_) {}
    if (typeof window.refreshSubscriptionStatus === 'function') {
      try { await window.refreshSubscriptionStatus(); } catch (_) {}
    }
    if (typeof window.openAccountSubscription === 'function') {
      try { setTimeout(function () { window.openAccountSubscription(); }, 200); } catch (_) {}
    }
  }

  async function redeem(code, button) {
    if (!window.crypto || typeof window.crypto.randomUUID !== 'function') {
      notify('Browser tidak mendukung aktivasi voucher aman.','error');
      return;
    }
    if (button) button.disabled = true;
    try {
      var response = await fetch('/api/subscription-voucher', {
        method:'POST', credentials:'same-origin', cache:'no-store',
        headers:{ 'Content-Type':'application/json', 'Cache-Control':'no-cache' },
        body:JSON.stringify({ voucher_code:code, idempotency_key:window.crypto.randomUUID() })
      });
      var data = await response.json().catch(function () { return {}; });
      if (!response.ok || data.success !== true) {
        notify(data.error || 'Voucher belum dapat diaktifkan.','error');
        return;
      }
      notify(data.admin_notified === false ? 'Voucher aktif. Notifikasi admin belum terkirim.' : 'Voucher berhasil diaktifkan.','success');
      await refreshAccess();
    } catch (_) {
      notify('Koneksi ke server sedang bermasalah.','error');
    } finally {
      if (button) button.disabled = false;
    }
  }

  document.addEventListener('click', function (event) {
    var target = event.target && event.target.closest ? event.target.closest('#acVoucherRedeem') : null;
    if (!target) return;
    var input = document.getElementById('acVoucherInput');
    var code = input ? String(input.value || '').trim().toUpperCase() : '';
    if (!code) return;
    // Capture this action before Account Center's legacy handler so the claim
    // goes through the notification-aware endpoint exactly once.
    event.preventDefault();
    event.stopImmediatePropagation();
    redeem(code, target);
  }, true);
})();
