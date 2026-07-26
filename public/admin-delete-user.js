(function () {
  'use strict';

  if (window.__AUTOCUAN_ADMIN_DELETE_USER__) return;
  window.__AUTOCUAN_ADMIN_DELETE_USER__ = true;

  function usernameFromRow(row) {
    if (!row) return '';
    var firstCell = row.querySelector('td');
    return String(firstCell && firstCell.textContent || '').trim().toLowerCase();
  }

  function addButtons() {
    document.querySelectorAll('tr').forEach(function (row) {
      if (row.dataset.deleteUserEnhanced === 'true') return;
      var text = String(row.textContent || '');
      if (!/Reset Devices|Reset PW|Block|Unblock/i.test(text)) return;

      var username = usernameFromRow(row);
      if (!username || username === 'budi' || username === 'review') return;

      var actionsCell = row.querySelector('td:last-child');
      if (!actionsCell) return;

      row.dataset.deleteUserEnhanced = 'true';
      var button = document.createElement('button');
      button.type = 'button';
      button.textContent = 'Hapus Akun';
      button.className = 'admin-delete-user-btn';
      button.style.cssText = 'margin-left:6px;padding:5px 8px;border-radius:6px;border:1px solid #7f1d1d;background:#2b1519;color:#fca5a5;font-size:11px;font-weight:700;cursor:pointer';
      button.addEventListener('click', async function () {
        var first = window.confirm('Hapus akun "' + username + '" beserta device ID dan data verifikasinya?');
        if (!first) return;
        var typed = window.prompt('Ketik username untuk konfirmasi:', '');
        if (String(typed || '').trim().toLowerCase() !== username) {
          window.alert('Konfirmasi username tidak cocok. Akun tidak dihapus.');
          return;
        }

        button.disabled = true;
        button.textContent = 'Menghapus…';
        try {
          var response = await fetch('/api/admin-users', {
            method: 'POST',
            credentials: 'same-origin',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ action: 'delete_user', username: username })
          });
          var data = await response.json().catch(function () { return {}; });
          if (!response.ok || !data.success) throw new Error(data.error || 'Akun gagal dihapus.');
          row.remove();
          window.alert(data.message || 'Akun berhasil dihapus.');
        } catch (error) {
          button.disabled = false;
          button.textContent = 'Hapus Akun';
          window.alert(error && error.message || 'Akun gagal dihapus.');
        }
      });
      actionsCell.appendChild(button);
    });
  }

  var scheduled = false;
  function schedule() {
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(function () {
      scheduled = false;
      addButtons();
    });
  }

  function init() {
    addButtons();
    [300, 800, 1600, 3000].forEach(function (delay) { setTimeout(addButtons, delay); });
    new MutationObserver(function (mutations) {
      var hasAddedElement = mutations.some(function (mutation) {
        return Array.prototype.some.call(mutation.addedNodes || [], function (node) {
          return node && node.nodeType === 1;
        });
      });
      if (hasAddedElement) schedule();
    }).observe(document.body, { childList: true, subtree: true });
  }

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', init, { once: true });
  else init();
})();
