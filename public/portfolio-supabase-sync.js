(function () {
  'use strict';

  if (window.__AUTOCUAN_PORTFOLIO_SUPABASE_SYNC__) return;
  window.__AUTOCUAN_PORTFOLIO_SUPABASE_SYNC__ = true;

  var ENDPOINT = '/api/reset-password';
  var REQUEST_TIMEOUT_MS = 8000;
  var CHECK_INTERVAL_MS = 700;
  var SAVE_DEBOUNCE_MS = 650;
  var REMOTE_REFRESH_COOLDOWN_MS = 2500;

  var uid = '';
  var hydrated = false;
  var applyingRemote = false;
  var dirty = false;
  var saving = false;
  var saveTimer = null;
  var checkTimer = null;
  var lastSerialized = '';
  var lastRemoteRefreshAt = 0;
  var retryTimer = null;

  function accessNow() {
    var access = window.__AUTOCUAN_PORTFOLIO_ACCESS__ || {};
    var userId = String(access.userId || localStorage.getItem('autocuan_user_id') || '').trim();
    if (!userId) return null;
    return {
      userId: userId,
      username: String(access.username || localStorage.getItem('autocuan_user') || '').trim()
    };
  }

  function keys(userId) {
    return {
      plans: 'autocuan_portfolio_plans_' + userId,
      prices: 'autocuan_portfolio_prices_' + userId,
      priceMeta: 'autocuan_portfolio_prices_' + userId + '_meta_v1',
      journal: 'autocuan_portfolio_journal_v1_' + userId,
      snapshot: 'autocuan_portfolio_command_snapshot_v1_' + userId,
      changes: 'autocuan_portfolio_command_changes_v1_' + userId,
      priceUpdatedAt: 'autocuan_portfolio_price_updated_v1_' + userId
    };
  }

  function readJson(key, fallback) {
    try {
      var raw = localStorage.getItem(key);
      return raw ? JSON.parse(raw) : fallback;
    } catch (_) { return fallback; }
  }

  function writeJson(key, value) {
    if (value == null) localStorage.removeItem(key);
    else localStorage.setItem(key, JSON.stringify(value));
  }

  function normalizeState(value) {
    var raw = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    var plans = Array.isArray(raw.plans) ? raw.plans : [];
    var prices = raw.prices && typeof raw.prices === 'object' && !Array.isArray(raw.prices) ? raw.prices : {};
    var priceMeta = raw.price_meta && typeof raw.price_meta === 'object' && !Array.isArray(raw.price_meta) ? raw.price_meta : {};
    var journal = Array.isArray(raw.journal) ? raw.journal : [];
    var changes = Array.isArray(raw.changes) ? raw.changes : [];
    var updatedAt = Number(raw.price_updated_at);
    return {
      version: 1,
      plans: plans,
      prices: prices,
      price_meta: priceMeta,
      journal: journal,
      snapshot: raw.snapshot == null ? null : raw.snapshot,
      changes: changes,
      price_updated_at: Number.isFinite(updatedAt) && updatedAt > 0 ? Math.round(updatedAt) : null
    };
  }

  function readLocalState(userId) {
    var k = keys(userId);
    return normalizeState({
      plans: readJson(k.plans, []),
      prices: readJson(k.prices, {}),
      price_meta: readJson(k.priceMeta, {}),
      journal: readJson(k.journal, []),
      snapshot: readJson(k.snapshot, null),
      changes: readJson(k.changes, []),
      price_updated_at: Number(localStorage.getItem(k.priceUpdatedAt) || 0) || null
    });
  }

  function applyRemoteState(userId, state) {
    var k = keys(userId);
    var normalized = normalizeState(state);
    applyingRemote = true;
    try {
      writeJson(k.plans, normalized.plans);
      writeJson(k.prices, normalized.prices);
      writeJson(k.priceMeta, normalized.price_meta);
      writeJson(k.journal, normalized.journal);
      writeJson(k.snapshot, normalized.snapshot);
      writeJson(k.changes, normalized.changes);
      if (normalized.price_updated_at) localStorage.setItem(k.priceUpdatedAt, String(normalized.price_updated_at));
      else localStorage.removeItem(k.priceUpdatedAt);
    } finally {
      applyingRemote = false;
    }
    lastSerialized = JSON.stringify(readLocalState(userId));
  }

  function fetchWithTimeout(url, options, timeoutMs) {
    var controller = new AbortController();
    var timer = setTimeout(function () { controller.abort(); }, timeoutMs);
    var opts = Object.assign({}, options || {}, { signal: controller.signal });
    return fetch(url, opts).finally(function () { clearTimeout(timer); });
  }

  async function post(action, payload) {
    var body = Object.assign({ action: action }, payload || {});
    var response = await fetchWithTimeout(ENDPOINT, {
      method: 'POST',
      credentials: 'same-origin',
      cache: 'no-store',
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-cache' },
      body: JSON.stringify(body)
    }, REQUEST_TIMEOUT_MS);
    var data = await response.json().catch(function () { return {}; });
    if (!response.ok || !data || data.success !== true) {
      var error = new Error(data && data.error || 'Sinkronisasi portofolio gagal.');
      error.status = response.status;
      throw error;
    }
    return data;
  }

  function notifyRuntime() {
    // Command Center already listens to focus and reloads its in-memory arrays
    // from localStorage. Reusing that path avoids a second state model here.
    try { window.dispatchEvent(new Event('focus')); } catch (_) {}
  }

  function setStatus(status, detail) {
    window.__AUTOCUAN_PORTFOLIO_SYNC_STATUS__ = {
      status: status,
      detail: detail || '',
      userId: uid || null,
      at: new Date().toISOString()
    };
  }

  async function hydrate() {
    var access = accessNow();
    if (!access) return false;
    uid = access.userId;
    var bootstrap = readLocalState(uid);
    setStatus('loading', 'Memuat portofolio dari Supabase');
    try {
      var data = await post('portfolio-state-load', { bootstrap: bootstrap });
      applyRemoteState(uid, data.state || {});
      hydrated = true;
      dirty = false;
      setStatus('synced', 'Portofolio tersimpan di Supabase');
      notifyRuntime();
      startChangeWatcher();
      return true;
    } catch (error) {
      setStatus('local-fallback', error && error.message || 'Supabase belum tersedia');
      scheduleHydrateRetry();
      return false;
    }
  }

  function scheduleHydrateRetry() {
    if (retryTimer || hydrated) return;
    retryTimer = setTimeout(function () {
      retryTimer = null;
      hydrate();
    }, 3500);
  }

  function startChangeWatcher() {
    if (checkTimer) return;
    lastSerialized = JSON.stringify(readLocalState(uid));
    checkTimer = setInterval(checkForLocalChanges, CHECK_INTERVAL_MS);
  }

  function checkForLocalChanges() {
    if (!hydrated || applyingRemote || saving || !uid) return;
    var serialized = JSON.stringify(readLocalState(uid));
    if (serialized === lastSerialized) return;
    lastSerialized = serialized;
    dirty = true;
    scheduleSave();
  }

  function scheduleSave() {
    if (!hydrated || !dirty) return;
    if (saveTimer) clearTimeout(saveTimer);
    saveTimer = setTimeout(function () {
      saveTimer = null;
      saveNow();
    }, SAVE_DEBOUNCE_MS);
  }

  async function saveNow() {
    if (!hydrated || !dirty || saving || !uid) return false;
    saving = true;
    var snapshot = readLocalState(uid);
    var serialized = JSON.stringify(snapshot);
    setStatus('saving', 'Menyimpan perubahan portofolio');
    try {
      await post('portfolio-state-save', { portfolio_state: snapshot });
      // Only clear dirty if no newer local write happened while the request was
      // in flight. Otherwise the watcher will schedule the next save.
      var current = JSON.stringify(readLocalState(uid));
      if (current === serialized) {
        dirty = false;
        lastSerialized = current;
      }
      setStatus('synced', 'Portofolio tersimpan di Supabase');
      return true;
    } catch (error) {
      dirty = true;
      setStatus('local-fallback', error && error.message || 'Belum tersimpan ke cloud');
      setTimeout(scheduleSave, 2500);
      return false;
    } finally {
      saving = false;
    }
  }

  async function refreshFromCloud() {
    if (!hydrated || dirty || saving || !uid) return;
    var now = Date.now();
    if (now - lastRemoteRefreshAt < REMOTE_REFRESH_COOLDOWN_MS) return;
    lastRemoteRefreshAt = now;
    try {
      var data = await post('portfolio-state-load', { bootstrap: readLocalState(uid) });
      var remote = normalizeState(data.state || {});
      var remoteSerialized = JSON.stringify(remote);
      var localSerialized = JSON.stringify(readLocalState(uid));
      if (remoteSerialized !== localSerialized) {
        applyRemoteState(uid, remote);
        setStatus('synced', 'Perubahan perangkat lain dimuat');
        notifyRuntime();
      }
    } catch (_) {}
  }

  function pagehideSave() {
    if (!hydrated || !dirty || !uid) return;
    try {
      fetch(ENDPOINT, {
        method: 'POST',
        credentials: 'same-origin',
        keepalive: true,
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ action: 'portfolio-state-save', portfolio_state: readLocalState(uid) })
      });
    } catch (_) {}
  }

  window.addEventListener('focus', function () { setTimeout(refreshFromCloud, 80); });
  document.addEventListener('visibilitychange', function () { if (!document.hidden) refreshFromCloud(); });
  window.addEventListener('pagehide', pagehideSave);

  var accessWaitStarted = Date.now();
  (function waitForAccess() {
    if (accessNow()) { hydrate(); return; }
    if (Date.now() - accessWaitStarted > 12000) {
      setStatus('waiting-access', 'Menunggu sesi portofolio');
      return;
    }
    setTimeout(waitForAccess, 100);
  })();
})();
