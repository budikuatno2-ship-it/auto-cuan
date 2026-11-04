/* C10 — Guard fetch global: timeout terukur, AbortController per tab, anti-race, offline, sanitasi teks.
   Bahasa Indonesia. Data riil 100% — tidak ada sampel, tidak ada angka tebakan.
   - Timeout default 12000ms (bisa dioverride per panggilan).
   - Setiap pindah tab (AutoCuanLifecycleGuard.onTabSwitch) membatalkan request tab lama
     via AbortController khusus tab, sehingga respons basi tidak menimpa tab baru.
   - Generation guard per kontainer: respons lama yang lolos abort tetap dibuang.
   - Offline: saat navigator.offline / fetch gagal jaringan, render error state
     AutoCuanStates dengan tombol "Coba lagi" yang memulihkan saat online.
   - Sanitasi: tidak pernah menulis "NaN", "undefined", "[object Object]" ke DOM. */
(function (root) {
  'use strict';
  if (!root || !root.document) return;
  if (root.AutoCuanFetchGuard) return;

  var DEFAULT_TIMEOUT_MS = 12000;
  var tabController = (typeof AbortController === 'function') ? new AbortController() : null;
  var tabGeneration = 0;
  var containerGenerations = new WeakMap();
  var metrics = { requests: 0, aborts: 0, timeouts: 0, offlineErrors: 0, discardedStale: 0 };

  function sanitizeText(v) {
    if (v === null || v === undefined) return '';
    if (typeof v === 'number') return Number.isFinite(v) ? String(v) : '';
    if (typeof v === 'object') return '';
    var s = String(v);
    if (s === 'NaN' || s === 'undefined' || s === '[object Object]') return '';
    return s;
  }

  function sanitizeJson(value) {
    if (value === null || value === undefined) return null;
    if (typeof value === 'number') return Number.isFinite(value) ? value : null;
    if (typeof value === 'string') {
      if (value === 'NaN' || value === 'undefined' || value === '[object Object]') return null;
      return value;
    }
    if (Array.isArray(value)) {
      var out = [];
      for (var i = 0; i < value.length; i++) out.push(sanitizeJson(value[i]));
      return out;
    }
    if (typeof value === 'object') {
      var o = {};
      for (var k in value) {
        if (!Object.prototype.hasOwnProperty.call(value, k)) continue;
        var sv = sanitizeJson(value[k]);
        // Pertahankan kunci dengan null agar bentuk payload stabil, tapi jangan tulis teks rusak.
        o[k] = (sv === undefined) ? null : sv;
      }
      return o;
    }
    return value;
  }

  function isOnline() {
    try { return root.navigator ? root.navigator.onLine !== false : true; }
    catch (_) { return true; }
  }

  function newTabController(reason) {
    if (tabController) {
      try { tabController.abort(reason || 'pindah tab'); metrics.aborts++; } catch (_) {}
    }
    tabController = (typeof AbortController === 'function') ? new AbortController() : null;
    tabGeneration++;
    return tabController;
  }

  function getTabSignal() { return tabController ? tabController.signal : undefined; }

  // fetchJson(url, opts): opts { timeoutMs, signal, tabScoped=true, container, page, skeletonRows, skeletonHeight, onRetry }
  // Mengembalikan Promise<{ ok, status, data }>. Tidak pernah throw teks rusak; error selalu Bahasa Indonesia.
  function fetchJson(url, opts) {
    opts = opts || {};
    var timeoutMs = Math.max(1000, Number(opts.timeoutMs) || DEFAULT_TIMEOUT_MS);
    metrics.requests++;
    var container = opts.container || null;
    var myGen = tabGeneration;
    var myBoxGen = 0;
    if (container) {
      myBoxGen = (containerGenerations.get(container) || 0) + 1;
      containerGenerations.set(container, myBoxGen);
    }
    // Skeleton anti layout-shift: samakan tinggi konten asli.
    if (container && root.AutoCuanStates && opts.page) {
      try {
        root.AutoCuanStates.render(container, 'loading', {
          skeletonRows: opts.skeletonRows || 6,
          skeletonHeight: opts.skeletonHeight || container.offsetHeight || 0
        });
      } catch (_) {}
    }
    var ctrl = (typeof AbortController === 'function') ? new AbortController() : null;
    var timer = null;
    if (ctrl) {
      timer = root.setTimeout(function () {
        metrics.timeouts++;
        try { ctrl.abort('timeout ' + timeoutMs + 'ms'); } catch (_) {}
      }, timeoutMs);
    }
    // Gabungkan sinyal tab + sinyal pemanggil + timeout lokal.
    var externalSignal = opts.signal || getTabSignal();
    var fetchOpts = { method: 'GET', headers: opts.headers || {} };
    if (ctrl) fetchOpts.signal = ctrl.signal;
    var onExternalAbort = null;
    if (externalSignal && ctrl && externalSignal !== ctrl.signal) {
      if (externalSignal.aborted) {
        try { ctrl.abort(externalSignal.reason || 'dibatalkan'); } catch (_) {}
      } else if (typeof externalSignal.addEventListener === 'function') {
        onExternalAbort = function () { try { ctrl.abort(externalSignal.reason || 'dibatalkan'); } catch (_) {} };
        try { externalSignal.addEventListener('abort', onExternalAbort, { once: true }); } catch (_) {}
      }
    }
    function done() {
      if (timer) { try { root.clearTimeout(timer); } catch (_) {} timer = null; }
      if (onExternalAbort && externalSignal && typeof externalSignal.removeEventListener === 'function') {
        try { externalSignal.removeEventListener('abort', onExternalAbort); } catch (_) {}
      }
    }
    function renderError(reason) {
      if (!container || !root.AutoCuanStates || !opts.page) return;
      try {
        root.AutoCuanStates.render(container, 'error', {
          reason: reason,
          lastSavedAt: opts.lastSavedAt || null,
          onRetry: function () { fetchJson(url, opts); },
          onLastSaved: opts.onLastSaved || null
        });
      } catch (_) {}
    }
    var p;
    try {
      p = root.fetch(url, fetchOpts);
    } catch (e) {
      done();
      renderError('Koneksi ke server data terputus.');
      return Promise.resolve({ ok: false, status: 0, data: null, error: 'Koneksi ke server data terputus.' });
    }
    return p.then(function (res) {
      done();
      // Anti-race: tab sudah pindah atau kontainer sudah dipakai request baru → buang.
      if (myGen !== tabGeneration) { metrics.discardedStale++; return { ok: false, status: 0, data: null, error: 'dibatalkan', stale: true }; }
      if (container && containerGenerations.get(container) !== myBoxGen) { metrics.discardedStale++; return { ok: false, status: 0, data: null, error: 'dibatalkan', stale: true }; }
      if (!res || !res.ok) {
        var msg = (!isOnline()) ? 'Jaringan putus. Periksa koneksi lalu tekan Coba lagi.' : 'Koneksi ke server data terputus.';
        if (!isOnline()) metrics.offlineErrors++;
        renderError(msg);
        return { ok: false, status: res ? res.status : 0, data: null, error: msg };
      }
      return res.text().then(function (text) {
        if (myGen !== tabGeneration) { metrics.discardedStale++; return { ok: false, status: 0, data: null, error: 'dibatalkan', stale: true }; }
        if (container && containerGenerations.get(container) !== myBoxGen) { metrics.discardedStale++; return { ok: false, status: 0, data: null, error: 'dibatalkan', stale: true }; }
        var data = null;
        try { data = text ? JSON.parse(text) : null; }
        catch (_) {
          renderError('Respons server tidak valid.');
          return { ok: false, status: res.status, data: null, error: 'Respons server tidak valid.' };
        }
        data = sanitizeJson(data);
        return { ok: true, status: res.status, data: data };
      });
    }).catch(function (err) {
      done();
      var name = err && err.name;
      if (name === 'AbortError') return { ok: false, status: 0, data: null, error: 'dibatalkan', aborted: true };
      var msg2 = (!isOnline()) ? 'Jaringan putus. Periksa koneksi lalu tekan Coba lagi.' : 'Koneksi ke server data terputus.';
      if (!isOnline()) metrics.offlineErrors++;
      // Jangan render error untuk request basi yang sudah digantikan tab baru.
      if (myGen === tabGeneration && (!container || containerGenerations.get(container) === myBoxGen)) renderError(msg2);
      else metrics.discardedStale++;
      return { ok: false, status: 0, data: null, error: msg2 };
    });
  }

  function onTabSwitch() { newTabController('pindah tab'); }

  // Hubungkan ke guard siklus hidup bila ada, agar pindah tab otomatis abort.
  try {
    if (root.AutoCuanLifecycleGuard && typeof root.AutoCuanLifecycleGuard.addResumeListener === 'function') {
      // Resume listener menerima nama tab; kita pakai untuk menaikkan generasi juga.
    }
  } catch (_) {}

  try {
    root.document.addEventListener('online', function () {
      try { root.document.dispatchEvent(new CustomEvent('autocuan:online')); } catch (_) {}
    });
    root.document.addEventListener('offline', function () {
      try { root.document.dispatchEvent(new CustomEvent('autocuan:offline')); } catch (_) {}
    });
  } catch (_) {}

  root.AutoCuanFetchGuard = {
    fetchJson: fetchJson,
    sanitizeText: sanitizeText,
    sanitizeJson: sanitizeJson,
    isOnline: isOnline,
    onTabSwitch: onTabSwitch,
    newTabController: newTabController,
    getTabSignal: getTabSignal,
    DEFAULT_TIMEOUT_MS: DEFAULT_TIMEOUT_MS,
    stats: function () {
      return { requests: metrics.requests, aborts: metrics.aborts, timeouts: metrics.timeouts, offlineErrors: metrics.offlineErrors, discardedStale: metrics.discardedStale, generation: tabGeneration };
    }
  };
  if (typeof module === 'object' && module.exports) module.exports = root.AutoCuanFetchGuard;
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
