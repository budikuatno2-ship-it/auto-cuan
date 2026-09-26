/**
 * Auto-Cuan Tab Keep-Alive + SWR Client Cache
 * ==========================================================================
 *
 * Three problems this file solves, and the invariant each one protects:
 *
 *   1. TAB SWITCHES THAT RELOAD. Panels are never unmounted. `navigateTo`
 *      already toggles `hidden` on `.page-content`, so the DOM survives — but
 *      every re-entry re-ran the page loader, which wiped the rendered rows and
 *      painted a spinner. Keep-alive means: the DOM is the cache of last
 *      resort, and a fresh payload must not be allowed to replace it with
 *      skeletons.
 *
 *   2. REPEATED NETWORK WORK FOR THE SAME PAYLOAD. A single in-memory SWR
 *      store (TTL 10 minutes) serves the payload instantly, then revalidates
 *      in the background so the next visit is still correct. Freshness is
 *      measured per key, not globally, so a stale Bandarmologi payload never
 *      forces Sektor Hot to refetch.
 *
 *   3. WAITING FOR DATA THAT COULD HAVE BEEN FETCHED ON HOVER. Pointing at a
 *      sidebar item starts the fetch before the click lands. By the time the
 *      page is opened the store is already warm.
 *
 * Boundary rules (non-negotiable):
 *   - Reads only. A request with a method other than GET is NEVER cached and
 *     NEVER served from cache — money-management writes, watchlist toggles and
 *     every other mutation must reach the server exactly as before.
 *   - Same-origin `/api/` only. Anything else is passed straight through.
 *   - A failed request is never cached. The next call retries.
 *   - If the store throws for any reason, every call degrades to plain fetch.
 *
 * LOCAL / CLIENT ONLY. No auth, no access gates, no backend behaviour.
 */
(function (root) {
  'use strict';

  if (!root || !root.document) return;

  var TTL_MS = 10 * 60 * 1000;          // 10 minutes: the brief's TTL.
  var MAX_ENTRIES = 120;                // Bounded so a long session cannot grow without limit.
  var PREFETCH_DELAY_MS = 60;           // Let the hover settle before spending bandwidth.
  var STORE = new Map();                // key -> { at, data }
  var INFLIGHT = new Map();             // key -> Promise
  var PREFETCHED = new WeakSet();       // elements already warmed
  var PREFETCH_TIMERS = new WeakMap();
  var STATS = { hits: 0, misses: 0, revalidations: 0, prefetches: 0 };

  var PAGE_LOADERS = {
    'dashboard': function () {
      if (typeof root.loadDashboardTop5Monitor === 'function') {
        root.loadDashboardTop5Monitor(true, { loadAdminPreview: false });
      }
    },
    'sektor': function () {
      if (typeof root.loadSektorHot === 'function') root.loadSektorHot();
    },
    'screener': function () {
      if (typeof root.loadSwingScreener === 'function') root.loadSwingScreener(true);
    },
    'trackrecord': function () {
      if (typeof root.loadTrackRecord === 'function') root.loadTrackRecord(false);
    },
    'watchlist': function () {
      if (typeof root.loadUserWatchlist === 'function') root.loadUserWatchlist(false);
    },
    'deepscan': function () {
      if (typeof root.loadDeepScan === 'function') root.loadDeepScan(false);
    },
    'money-management': function () {
      if (typeof root.initMoneyManagement === 'function') root.initMoneyManagement();
    },
    'news': function () {
      if (typeof root.loadStockNewsPage === 'function') {
        var input = root.document.getElementById('newsTickerInput');
        root.loadStockNewsPage((input && input.value) || 'BBCA');
      }
    }
  };

  // Pages that live on their own document. There is no DOM to keep alive, so
  // the only useful thing to do on hover is ask the browser to fetch the
  // document early.
  var DOCUMENT_PREFETCH = {
    'analisis': '/analisis-saham',
    'portofolio': '/portfolio-planner',
    'chart': '/analisis-saham'
  };

  // ------------------------------------------------------------------------
  // Cache key normalisation
  // ------------------------------------------------------------------------

  /**
   * Volatile params (`t`, `_t`) exist only to defeat the browser cache. Keying
   * on them would make every call a miss, so they are dropped — the store owns
   * freshness instead.
   */
  function normaliseKey(url) {
    var parsed;
    try {
      parsed = new URL(url, root.location && root.location.origin ? root.location.origin : 'http://localhost');
    } catch (_) {
      return String(url);
    }
    var volatile = ['t', '_t', '_ts', 'cachebust'];
    for (var i = 0; i < volatile.length; i++) parsed.searchParams.delete(volatile[i]);
    parsed.hash = '';
    var params = parsed.searchParams.toString();
    var sorted = parsed.searchParams;
    // Stable ordering: two equivalent URLs must produce one key.
    var keys = [];
    sorted.forEach(function (value, name) { keys.push(name); });
    keys.sort();
    var parts = [];
    for (var k = 0; k < keys.length; k++) {
      parts.push(encodeURIComponent(keys[k]) + '=' + encodeURIComponent(sorted.get(keys[k])));
    }
    return parsed.origin + parsed.pathname + (parts.length ? '?' + parts.join('&') : '');
  }

  function isCacheable(url, options) {
    var method = (options && options.method ? String(options.method) : 'GET').toUpperCase();
    if (method !== 'GET') return false;                 // mutations always pass through
    if (options && options.body) return false;
    if (typeof url !== 'string') return false;
    if (url.indexOf('/api/') !== 0) return false;        // same-origin API reads only
    // A signal is allowed, and handled rather than refused: a cache hit is
    // returned without touching the network (the caller's abort timer then
    // aborts nothing, which is harmless), while a miss forwards the signal so
    // an aborted request still rejects and is never stored.
    return true;
  }

  function trimStore() {
    if (STORE.size <= MAX_ENTRIES) return;
    var entries = [];
    STORE.forEach(function (entry, key) { entries.push({ key: key, at: entry.at }); });
    entries.sort(function (a, b) { return a.at - b.at; });
    var excess = STORE.size - MAX_ENTRIES;
    for (var i = 0; i < excess && i < entries.length; i++) STORE.delete(entries[i].key);
  }

  function store(key, data) {
    STORE.set(key, { at: Date.now(), data: data });
    trimStore();
  }

  function peek(url) {
    try {
      var key = normaliseKey(url);
      var entry = STORE.get(key);
      if (!entry) return null;
      return {
        key: key,
        data: entry.data,
        ageMs: Date.now() - entry.at,
        fresh: (Date.now() - entry.at) < TTL_MS
      };
    } catch (_) {
      return null;
    }
  }

  /** Drop one key, or every key containing a substring. */
  function invalidate(match) {
    if (!match) { STORE.clear(); return; }
    var needle = String(match);
    var doomed = [];
    STORE.forEach(function (_entry, key) { if (key.indexOf(needle) >= 0) doomed.push(key); });
    for (var i = 0; i < doomed.length; i++) STORE.delete(doomed[i]);
  }

  // ------------------------------------------------------------------------
  // cachedFetch — the SWR read path
  // ------------------------------------------------------------------------

  function cachedFetch(url, options) {
    if (!isCacheable(url, options)) return root.fetch(url, options);

    var key;
    try {
      key = normaliseKey(url);
    } catch (_) {
      return root.fetch(url, options);
    }

    var entry = STORE.get(key);

    // Fresh: serve the stored payload, no network at all.
    if (entry && (Date.now() - entry.at) < TTL_MS) {
      STATS.hits++;
      return Promise.resolve(jsonResponse(entry.data));
    }

    // Stale: serve the stored payload now, refresh in the background. The
    // caller renders immediately and the next visit sees the new payload.
    if (entry) {
      STATS.revalidations++;
      revalidate(key, url, options);
      return Promise.resolve(jsonResponse(entry.data));
    }

    // Cold: single-flight so ten simultaneous callers make one request.
    STATS.misses++;
    if (INFLIGHT.has(key)) return INFLIGHT.get(key).then(jsonResponse);

    var promise = root.fetch(url, options).then(function (res) {
      return readJson(res).then(function (payload) {
        if (payload.ok) store(key, payload.data);
        INFLIGHT.delete(key);
        return payload;
      });
    }).catch(function (err) {
      INFLIGHT.delete(key);
      throw err;
    });

    INFLIGHT.set(key, promise);
    return promise.then(function (payload) {
      return jsonResponse(payload.data, payload.status, payload.ok);
    });
  }

  function revalidate(key, url, options) {
    if (INFLIGHT.has(key)) return;
    var promise = root.fetch(url, options).then(function (res) {
      return readJson(res).then(function (payload) {
        if (payload.ok) store(key, payload.data);
        INFLIGHT.delete(key);
        return payload;
      });
    }).catch(function () {
      // A failed background refresh must never surface: the caller already has
      // data, and the stale entry keeps the UI honest until the next attempt.
      INFLIGHT.delete(key);
      return { ok: false };
    });
    INFLIGHT.set(key, promise);
  }

  /** Read a response once, without consuming the caller's copy twice. */
  function readJson(res) {
    if (!res) return Promise.resolve({ ok: false, status: 0, data: null });
    if (!res.ok) {
      return Promise.resolve({ ok: false, status: res.status, data: null });
    }
    return res.text().then(function (text) {
      if (!text || text.trim().charAt(0) === '<') {
        // An HTML body means a proxy error page, not an API payload. Caching it
        // would freeze a 502 into the store for ten minutes.
        return { ok: false, status: res.status, data: null };
      }
      try {
        return { ok: true, status: res.status, data: JSON.parse(text) };
      } catch (_) {
        return { ok: false, status: res.status, data: null };
      }
    }).catch(function () {
      return { ok: false, status: res.status, data: null };
    });
  }

  /** Rebuild a Response-shaped object so existing `res.json()` callers work. */
  function jsonResponse(data, status, ok) {
    var body = data === undefined ? null : data;
    var text = body === null ? '' : JSON.stringify(body);
    var resolvedOk = ok === undefined ? body !== null : !!ok;
    return {
      ok: resolvedOk,
      status: status || (resolvedOk ? 200 : 502),
      json: function () { return Promise.resolve(body); },
      text: function () { return Promise.resolve(text); },
      headers: { get: function () { return 'application/json'; } },
      _fromKeepAliveCache: true
    };
  }

  // ------------------------------------------------------------------------
  // Prefetch
  // ------------------------------------------------------------------------

  function prefetchDocument(page) {
    var href = DOCUMENT_PREFETCH[page];
    if (!href || !root.document) return;
    var head = root.document.head;
    if (!head) return;
    var existing = head.querySelector('link[data-ac-prefetch="' + href + '"]');
    if (existing) return;
    var link = root.document.createElement('link');
    link.rel = 'prefetch';
    link.href = href;
    link.setAttribute('data-ac-prefetch', href);
    head.appendChild(link);
  }

  function prefetch(page) {
    if (!page) return false;
    if (DOCUMENT_PREFETCH[page]) { prefetchDocument(page); return true; }
    var loader = PAGE_LOADERS[page];
    if (!loader) return false;
    STATS.prefetches++;
    try {
      loader();
    } catch (_) {
      return false;
    }
    return true;
  }

  function schedulePrefetch(el, page) {
    if (PREFETCHED.has(el)) return;
    PREFETCHED.add(el);
    if (PREFETCH_TIMERS.has(el)) return;
    var timer = root.setTimeout(function () {
      PREFETCH_TIMERS.delete(el);
      prefetch(page);
    }, PREFETCH_DELAY_MS);
    PREFETCH_TIMERS.set(el, timer);
  }

  function pageForElement(el) {
    if (!el || !el.getAttribute) return null;
    return el.getAttribute('data-sidebar-page') || el.getAttribute('data-page') || null;
  }

  function wireHoverPrefetch() {
    var doc = root.document;
    if (!doc || doc.__acKeepAliveHoverWired) return;
    doc.__acKeepAliveHoverWired = true;

    function onIntent(event) {
      var target = event.target;
      if (!target || !target.closest) return;
      var el = target.closest('[data-sidebar-page], [data-page]');
      if (!el || el.classList.contains('hidden')) return;
      var page = pageForElement(el);
      if (page) schedulePrefetch(el, page);
    }

    // mouseover bubbles (mouseenter does not) and focusin covers the keyboard
    // path, so one handler serves both. pointerdown covers touch, where no
    // hover ever fires and the click is already imminent.
    doc.addEventListener('mouseover', onIntent, { passive: true });
    doc.addEventListener('focusin', onIntent, { passive: true });
    doc.addEventListener('pointerdown', onIntent, { passive: true });
  }

  // ------------------------------------------------------------------------
  // Keep-alive bookkeeping
  // ------------------------------------------------------------------------

  var VISITED = Object.create(null);

  function markVisited(page) {
    if (page) VISITED[page] = Date.now();
  }

  function hasVisited(page) {
    return Boolean(page && VISITED[page]);
  }

  // ------------------------------------------------------------------------
  // Scroll restoration — part of "no layout shift, no lost place"
  // ------------------------------------------------------------------------

  var SCROLL = Object.create(null);
  var currentPage = null;

  function rememberScroll() {
    if (!currentPage) return;
    SCROLL[currentPage] = root.scrollY || root.pageYOffset || 0;
  }

  function restoreScroll(page) {
    var y = SCROLL[page];
    if (typeof y !== 'number') return;
    // rAF keeps the restore in the same frame the panel became visible, so the
    // user never sees the page at 0 first.
    var apply = function () {
      try { root.scrollTo(0, y); } catch (_) {}
    };
    if (typeof root.requestAnimationFrame === 'function') root.requestAnimationFrame(apply);
    else apply();
  }

  function onNavigate(page) {
    if (currentPage && currentPage !== page) rememberScroll();
    currentPage = page;
    markVisited(page);
    restoreScroll(page);
  }

  function installScrollMemory() {
    root.addEventListener('scroll', function () {
      if (currentPage) SCROLL[currentPage] = root.scrollY || root.pageYOffset || 0;
    }, { passive: true });
  }

  // ------------------------------------------------------------------------
  // Public surface
  // ------------------------------------------------------------------------

  root.AutoCuanKeepAlive = {
    TTL_MS: TTL_MS,
    cachedFetch: cachedFetch,
    peek: peek,
    invalidate: invalidate,
    prefetch: prefetch,
    onNavigate: onNavigate,
    hasVisited: hasVisited,
    stats: function () {
      return {
        hits: STATS.hits,
        misses: STATS.misses,
        revalidations: STATS.revalidations,
        prefetches: STATS.prefetches,
        entries: STORE.size,
        inflight: INFLIGHT.size
      };
    },
    _normaliseKey: normaliseKey,
    _isCacheable: isCacheable
  };

  // ------------------------------------------------------------------------
  // Boot
  // ------------------------------------------------------------------------

  function boot() {
    wireHoverPrefetch();
    installScrollMemory();
  }

  if (root.document.readyState === 'loading') {
    root.document.addEventListener('DOMContentLoaded', boot);
  } else {
    boot();
  }

  // A page hidden in a background tab must not keep a stale payload warm
  // forever: on return, drop entries older than the TTL so the next read is
  // honest about its age.
  root.document.addEventListener('visibilitychange', function () {
    if (root.document.visibilityState !== 'visible') return;
    var now = Date.now();
    var expired = [];
    STORE.forEach(function (entry, key) {
      if (now - entry.at >= TTL_MS) expired.push(key);
    });
    for (var i = 0; i < expired.length; i++) STORE.delete(expired[i]);
  });
})(typeof window !== 'undefined' ? window : null);
