(function () {
  'use strict';

  if (window.__AUTOCUAN_ADMIN_DELETE_ENHANCEMENT__) return;
  window.__AUTOCUAN_ADMIN_DELETE_ENHANCEMENT__ = true;

  function isAdminBrowser() {
    return String(localStorage.getItem('autocuan_user') || '').toLowerCase() === 'budi' &&
      localStorage.getItem('autocuan_is_admin') === 'true';
  }

  function notify(message, type) {
    if (typeof window.showToast === 'function') {
      window.showToast(message, type || 'info');
      return;
    }
    window.alert(message);
  }

  function rowUsername(row) {
    var first = row && row.querySelector('td');
    return first ? String(first.textContent || '').trim().toLowerCase() : '';
  }

  async function removeAccount(username, button) {
    var confirmation = window.prompt(
      'Ini menghapus akun, device ID, dan data verifikasi terkait.\n\nKetik username berikut untuk konfirmasi:\n' + username
    );
    if (String(confirmation || '').trim().toLowerCase() !== username) {
      notify('Penghapusan dibatalkan karena username tidak cocok.', 'warning');
      return;
    }

    var original = button.textContent;
    button.disabled = true;
    button.textContent = 'Menghapus…';
    try {
      var response = await fetch('/api/admin-users', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'delete_user', username: username })
      });
      var data = await response.json().catch(function () { return {}; });
      if (!response.ok || data.success !== true) {
        throw new Error(data.error || 'Akun belum berhasil dihapus.');
      }
      notify(data.message || ('Akun ' + username + ' berhasil dihapus.'), 'success');
      if (typeof window.loadAdminUsers === 'function') window.loadAdminUsers();
      else if (button.closest('tr')) button.closest('tr').remove();
    } catch (error) {
      notify(error && error.message || 'Akun belum berhasil dihapus.', 'error');
      button.disabled = false;
      button.textContent = original;
    }
  }

  function decorateRow(row) {
    if (!row || row.dataset.deleteAccountReady === 'true') return;
    var text = String(row.textContent || '');
    if (!/Reset Devices|Reset PW|Block|Unblock/i.test(text)) return;

    var username = rowUsername(row);
    if (!username || username === 'budi' || username === 'review') {
      row.dataset.deleteAccountReady = 'true';
      return;
    }

    var actionCell = row.querySelector('td:last-child');
    if (!actionCell) return;

    var button = document.createElement('button');
    button.type = 'button';
    button.className = 'ml-1 px-2 py-1 rounded text-xs border border-red-500/50 text-red-300 hover:bg-red-500/10 transition';
    button.textContent = 'Hapus Akun';
    button.setAttribute('aria-label', 'Hapus akun ' + username);
    button.addEventListener('click', function () { removeAccount(username, button); });
    actionCell.appendChild(button);
    row.dataset.deleteAccountReady = 'true';
  }

  function scan() {
    if (!isAdminBrowser()) return;
    var container = document.getElementById('adminLogsContainer');
    if (!container) return;
    container.querySelectorAll('tbody tr').forEach(decorateRow);
  }

  var scheduled = false;
  function scheduleScan() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(function () {
      scheduled = false;
      scan();
    });
  }

  function init() {
    scan();
    var container = document.getElementById('adminLogsContainer');
    if (container && typeof MutationObserver !== 'undefined') {
      new MutationObserver(scheduleScan).observe(container, { childList: true, subtree: true });
    }
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
