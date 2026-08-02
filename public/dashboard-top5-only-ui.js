// Dashboard cleanup: show only the already-computed final Top 5 result.
// Presentation only. This file does not rank candidates, read individual screeners,
// change APIs, or alter Top 5 calculation/locking/monitoring on the server.
(function (root) {
  'use strict';
  if (!root || !root.document || root.__AUTOCUAN_TOP5_ONLY_UI__) return;
  root.__AUTOCUAN_TOP5_ONLY_UI__ = '20260803-top5-only-ui-v1';

  var doc = root.document;
  var observer = null;

  function cleanNoteText(value) {
    var text = String(value || '');
    text = text.replace(/\s*Monitor update tiap 30 menit saat jam bursa\.?/gi, '');
    text = text.replace(/\s*Update tiap 30 menit saat jam bursa\.?/gi, '');
    text = text.replace(/\s+\./g, '.').replace(/\.\.+/g, '.').trim();
    return text;
  }

  function applyTop5OnlyLayout() {
    var monitorList = doc.getElementById('dashboardMonitorList');
    var monitorCard = monitorList ? monitorList.closest('aside') : null;
    if (monitorCard) {
      monitorCard.hidden = true;
      monitorCard.setAttribute('aria-hidden', 'true');
      monitorCard.style.display = 'none';
    }

    var monitorUpdated = doc.getElementById('dashboardMonitorUpdated');
    if (monitorUpdated) {
      monitorUpdated.hidden = true;
      monitorUpdated.setAttribute('aria-hidden', 'true');
    }

    var top5List = doc.getElementById('dashboardTop5List');
    var top5Card = top5List ? top5List.closest('section') : null;
    var grid = top5Card ? top5Card.parentElement : null;
    if (top5Card) {
      top5Card.style.gridColumn = '1 / -1';
      top5Card.classList.remove('lg:col-span-3');
      top5Card.classList.add('lg:col-span-5');
    }
    if (grid) {
      grid.style.gridTemplateColumns = 'minmax(0, 1fr)';
    }

    var note = doc.getElementById('dashboardTop5LockNote');
    if (note) {
      var cleaned = cleanNoteText(note.textContent);
      if (cleaned && cleaned !== note.textContent) note.textContent = cleaned;
    }
  }

  function installObserver() {
    var dashboard = doc.getElementById('page-dashboard') || doc.getElementById('dashboardScreen');
    if (!dashboard || typeof MutationObserver === 'undefined') return false;
    if (observer) observer.disconnect();
    observer = new MutationObserver(applyTop5OnlyLayout);
    observer.observe(dashboard, { childList: true, subtree: true, characterData: true });
    return true;
  }

  function start() {
    applyTop5OnlyLayout();
    installObserver();

    var attempts = 0;
    var timer = root.setInterval(function () {
      attempts += 1;
      applyTop5OnlyLayout();
      if (installObserver() || attempts > 120) root.clearInterval(timer);
    }, 100);
  }

  if (doc.readyState === 'loading') doc.addEventListener('DOMContentLoaded', start, { once: true });
  else start();
})(typeof window !== 'undefined' ? window : null);
