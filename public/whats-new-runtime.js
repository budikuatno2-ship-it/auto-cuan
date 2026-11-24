/**
 * public/whats-new-runtime.js
 * ============================================================================
 * V6 (W2a / Feature 13A) — "What's New" modal (server-truth, once per user)
 * ============================================================================
 * BEHAVIOUR
 *   - On load (and on the `ac-auth-changed` event) it calls GET /api/whats-new.
 *   - If the server reports a PUBLISHED release that THIS user has NOT
 *     acknowledged, the modal is shown.
 *   - Dismissing the modal POSTs /api/whats-new/ack. The server is the source
 *     of truth: after ack, GET returns acknowledged:true and the modal never
 *     re-shows for that release.
 *   - localStorage is used ONLY as a short-lived optimisation to avoid a
 *     redundant fetch; the server response always wins (a cached "seen" flag
 *     is re-validated against the server before suppressing the modal).
 *
 * SECURITY
 *   - All release text (title/summary/items) is HTML-escaped before insertion.
 *     A release containing "<script>" renders as inert text, never executes.
 * ============================================================================
 */
(function (root) {
  'use strict';

  var CACHE_KEY = 'autocuan_whats_new_seen';

  function escapeHtml(value) {
    if (value == null) return '';
    return String(value)
      .replace(/&/g, '\u0026amp;')
      .replace(/</g, '\u0026lt;')
      .replace(/>/g, '\u0026gt;')
      .replace(/"/g, '\u0026quot;')
      .replace(/'/g, '\u0026#39;');
  }

  /**
   * Build the modal inner HTML for a release. Pure + testable. Every dynamic
   * field is escaped; only the static wrapper markup is trusted.
   */
  function renderReleaseHtml(release) {
    if (!release) return '';
    var items = Array.isArray(release.items) ? release.items : [];
    var itemsHtml = items.map(function (it) {
      return '<li class="wn-item">' + escapeHtml(it) + '</li>';
    }).join('');

    return '' +
      '<div class="wn-backdrop" data-wn-backdrop="1">' +
      '  <div class="wn-modal" role="dialog" aria-modal="true" aria-labelledby="wnTitle">' +
      '    <div class="wn-head">' +
      '      <span class="wn-badge">What\'s New</span>' +
      '      <button type="button" class="wn-close" data-wn-close="1" aria-label="Tutup">&times;</button>' +
      '    </div>' +
      '    <h2 id="wnTitle" class="wn-title">' + escapeHtml(release.title) + '</h2>' +
      (release.summary ? '<p class="wn-summary">' + escapeHtml(release.summary) + '</p>' : '') +
      (itemsHtml ? '<ul class="wn-items">' + itemsHtml + '</ul>' : '') +
      '    <div class="wn-foot">' +
      '      <span class="wn-meta">' + escapeHtml(release.published_at_wib || '') + '</span>' +
      '      <button type="button" class="wn-ack" data-wn-ack="1">Mengerti</button>' +
      '    </div>' +
      '  </div>' +
      '</div>';
  }

  function injectStyles() {
    if (typeof document === 'undefined' || document.getElementById('wnStyles')) return;
    var css = '' +
      '.wn-backdrop{position:fixed;inset:0;z-index:9999;background:rgba(2,6,23,.72);backdrop-filter:blur(4px);display:flex;align-items:center;justify-content:center;padding:16px}' +
      '.wn-modal{width:100%;max-width:520px;background:#0f141c;border:1px solid rgba(255,255,255,.08);border-radius:14px;padding:20px;color:#e2e8f0;box-shadow:0 20px 60px -12px rgba(0,0,0,.7)}' +
      '.wn-head{display:flex;align-items:center;justify-content:space-between;margin-bottom:8px}' +
      '.wn-badge{font-size:11px;font-weight:700;letter-spacing:.04em;text-transform:uppercase;color:#34d399;background:rgba(16,185,129,.1);border:1px solid rgba(16,185,129,.3);padding:2px 8px;border-radius:999px}' +
      '.wn-close{background:none;border:none;color:#94a3b8;font-size:22px;line-height:1;cursor:pointer}' +
      '.wn-title{font-size:18px;font-weight:800;margin:4px 0 8px;color:#f8fafc}' +
      '.wn-summary{font-size:13px;color:#cbd5e1;margin:0 0 12px;line-height:1.5}' +
      '.wn-items{margin:0 0 16px;padding-left:18px;font-size:13px;color:#cbd5e1;line-height:1.6}' +
      '.wn-item{margin-bottom:4px}' +
      '.wn-foot{display:flex;align-items:center;justify-content:space-between;gap:12px}' +
      '.wn-meta{font-size:11px;color:#64748b;font-family:monospace}' +
      '.wn-ack{background:#10b981;color:#04120c;font-weight:700;font-size:13px;border:none;border-radius:8px;padding:8px 18px;cursor:pointer}' +
      '.wn-ack:hover{background:#34d399}';
    var style = document.createElement('style');
    style.id = 'wnStyles';
    style.textContent = css;
    document.head.appendChild(style);
  }

  function readCache() {
    try { return JSON.parse(localStorage.getItem(CACHE_KEY) || 'null'); } catch (_) { return null; }
  }
  function writeCache(releaseId) {
    try { localStorage.setItem(CACHE_KEY, JSON.stringify({ release_id: releaseId, at: Date.now() })); } catch (_) {}
  }

  function removeModal() {
    if (typeof document === 'undefined') return;
    var el = document.getElementById('whatsNewRoot');
    if (el && el.parentNode) el.parentNode.removeChild(el);
  }

  function showModal(release) {
    if (typeof document === 'undefined') return;
    injectStyles();
    removeModal();
    var host = document.createElement('div');
    host.id = 'whatsNewRoot';
    host.innerHTML = renderReleaseHtml(release);
    document.body.appendChild(host);

    function ack() {
      // Optimistic close; the server ack is authoritative.
      removeModal();
      writeCache(release.release_id);
      try {
        fetch('/api/whats-new/ack', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ release_id: release.release_id })
        }).catch(function () {});
      } catch (_) {}
    }

    var ackBtn = host.querySelector('[data-wn-ack]');
    var closeBtn = host.querySelector('[data-wn-close]');
    var backdrop = host.querySelector('[data-wn-backdrop]');
    if (ackBtn) ackBtn.addEventListener('click', ack);
    if (closeBtn) closeBtn.addEventListener('click', ack);
    if (backdrop) backdrop.addEventListener('click', function (e) { if (e.target === backdrop) ack(); });
  }

  function checkForRelease() {
    if (typeof fetch === 'undefined') return;
    fetch('/api/whats-new', { credentials: 'same-origin', headers: { 'Accept': 'application/json' } })
      .then(function (r) { return r.ok ? r.json() : null; })
      .then(function (data) {
        if (!data || !data.success || !data.release) return;
        // Server truth wins: only suppress when the SERVER says acknowledged.
        if (data.acknowledged === true) { writeCache(data.release.release_id); return; }
        showModal(data.release);
      })
      .catch(function () {});
  }

  function init() {
    if (typeof document === 'undefined') return;
    // Only attempt for an authenticated session; the endpoint rejects guests.
    var loggedIn = false;
    try {
      loggedIn = (typeof window !== 'undefined' && window.__AUTOCUAN_AUTHENTICATED_SESSION__ && window.__AUTOCUAN_AUTHENTICATED_SESSION__.userId)
        || (typeof localStorage !== 'undefined' && localStorage.getItem('autocuan_logged_in') === 'true');
    } catch (_) {}
    if (!loggedIn) return;
    checkForRelease();
  }

  if (typeof document !== 'undefined') {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', init);
    } else {
      init();
    }
    try { window.addEventListener('ac-auth-changed', init); } catch (_) {}
  }

  var api = {
    escapeHtml: escapeHtml,
    renderReleaseHtml: renderReleaseHtml,
    showModal: showModal,
    checkForRelease: checkForRelease,
    init: init
  };

  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
  if (root) {
    root.WhatsNewRuntime = api;
  }
})(typeof window !== 'undefined' ? window : (typeof globalThis !== 'undefined' ? globalThis : this));
