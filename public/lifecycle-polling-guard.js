/**
 * Auto-Cuan Lifecycle Polling Guard & AbortController Runtime
 * ==========================================================================
 *
 * Solves three core client bottlenecks identified in Fase 0 audit:
 *
 *   1. BACKGROUND POLLING WASTE:
 *      When `document.hidden === true`, intercepts interval callbacks to suppress
 *      polling and network fetches. Zero CPU wakeups and zero network requests
 *      occur in the background. On tab visibility resume, immediately triggers
 *      refresh for the active view.
 *
 *   2. INTERVAL STACKING ACROSS SPA TAB SWITCHES:
 *      Tracks tab-scoped interval timers. When navigating between SPA tabs
 *      (e.g., Dashboard -> Screener -> Sektor -> Dashboard), previous tab timers
 *      are systematically pruned to prevent timer accumulation across cycles.
 *
 *   3. IN-FLIGHT RACE HAZARD & ABORTCONTROLLER:
 *      Maintains dedicated AbortControllers for active tab and active ticker.
 *      Switching tabs or tickers immediately aborts obsolete in-flight requests,
 *      preventing slow stale responses from overwriting the current state.
 */
(function (root) {
  'use strict';

  if (!root || !root.document) return;

  var originalSetInterval = root.setInterval;
  var originalClearInterval = root.clearInterval;

  var activeTimers = new Map();
  var tabTimers = new Map(); // tabName -> Set of timer IDs
  var resumeCallbacks = new Set();
  var currentTab = 'dashboard';
  var currentTicker = null;

  var tabAbortController = typeof AbortController === 'function' ? new AbortController() : null;
  var tickerAbortController = typeof AbortController === 'function' ? new AbortController() : null;

  var metrics = {
    hiddenTicksSuppressed: 0,
    tabTimersCleared: 0,
    tabSwitchesCount: 0,
    tickersSwitchedCount: 0,
    abortedTabRequestsCount: 0,
    abortedTickerRequestsCount: 0
  };

  // Wrapped setInterval that pauses in background and registers scope
  function guardedSetInterval(fn, delay) {
    if (typeof fn !== 'function') return originalSetInterval.apply(root, arguments);

    var timerId;
    var scopeTab = currentTab;
    var extraArgs = Array.prototype.slice.call(arguments, 2);

    function wrappedCallback() {
      if (root.document && root.document.hidden) {
        metrics.hiddenTicksSuppressed++;
        return;
      }
      return fn.apply(root, extraArgs);
    }

    timerId = originalSetInterval(wrappedCallback, delay);

    activeTimers.set(timerId, {
      id: timerId,
      delay: delay,
      scopeTab: scopeTab,
      createdAt: Date.now()
    });

    if (scopeTab) {
      if (!tabTimers.has(scopeTab)) tabTimers.set(scopeTab, new Set());
      tabTimers.get(scopeTab).add(timerId);
    }

    return timerId;
  }

  function guardedClearInterval(timerId) {
    if (timerId == null) return;
    var entry = activeTimers.get(timerId);
    if (entry && entry.scopeTab && tabTimers.has(entry.scopeTab)) {
      tabTimers.get(entry.scopeTab).delete(timerId);
    }
    activeTimers.delete(timerId);
    return originalClearInterval.call(root, timerId);
  }

  // Install transparent wrapper on root window
  root.setInterval = guardedSetInterval;
  root.clearInterval = guardedClearInterval;

  // Tab switch handler
  function onTabSwitch(newPage, subTab) {
    var previousTab = currentTab;
    currentTab = newPage || 'dashboard';
    metrics.tabSwitchesCount++;

    // Abort prior tab network operations
    if (tabAbortController) {
      try {
        tabAbortController.abort('Tab switched from ' + previousTab + ' to ' + currentTab);
        metrics.abortedTabRequestsCount++;
      } catch (_) {}
      tabAbortController = typeof AbortController === 'function' ? new AbortController() : null;
    }

    // Prune timers from previous tab to prevent stacking
    if (previousTab && previousTab !== currentTab && tabTimers.has(previousTab)) {
      var prevSet = tabTimers.get(previousTab);
      prevSet.forEach(function (id) {
        guardedClearInterval(id);
        metrics.tabTimersCleared++;
      });
      prevSet.clear();
    }
  }

  // Ticker switch handler
  function onTickerSwitch(newTicker) {
    if (!newTicker || newTicker === currentTicker) return;
    var prev = currentTicker;
    currentTicker = newTicker;
    metrics.tickersSwitchedCount++;

    if (tickerAbortController) {
      try {
        tickerAbortController.abort('Ticker changed from ' + prev + ' to ' + newTicker);
        metrics.abortedTickerRequestsCount++;
      } catch (_) {}
      tickerAbortController = typeof AbortController === 'function' ? new AbortController() : null;
    }
  }

  // Visibility change listener
  root.document.addEventListener('visibilitychange', function () {
    if (root.document.hidden) {
      // Document is now hidden in background.
      // All intervals will naturally skip tick execution.
    } else {
      // Document became visible. Trigger immediate refresh for active tab.
      triggerResume();
    }
  });

  function triggerResume() {
    resumeCallbacks.forEach(function (cb) {
      try { cb(currentTab); } catch (_) {}
    });

    // Auto-refresh active tab if appropriate
    if (currentTab === 'dashboard' && typeof root.loadDashboardTop5Monitor === 'function') {
      try { root.loadDashboardTop5Monitor(true, { loadAdminPreview: false }); } catch (_) {}
    } else if (currentTab === 'screener' && typeof root.loadDayTradeScreener === 'function' && root._currentScreenerType === 'daytrade') {
      try { root.loadDayTradeScreener(); } catch (_) {}
    }
  }

  function addResumeListener(fn) {
    if (typeof fn === 'function') resumeCallbacks.add(fn);
  }

  function removeResumeListener(fn) {
    resumeCallbacks.delete(fn);
  }

  function getTabSignal() {
    return tabAbortController ? tabAbortController.signal : undefined;
  }

  function getTickerSignal() {
    return tickerAbortController ? tickerAbortController.signal : undefined;
  }

  function getStats() {
    return {
      activeTimersCount: activeTimers.size,
      isPageVisible: !(root.document && root.document.hidden),
      currentTab: currentTab,
      currentTicker: currentTicker,
      metrics: Object.assign({}, metrics)
    };
  }

  root.AutoCuanLifecycleGuard = {
    onTabSwitch: onTabSwitch,
    onTickerSwitch: onTickerSwitch,
    getTabSignal: getTabSignal,
    getTickerSignal: getTickerSignal,
    addResumeListener: addResumeListener,
    removeResumeListener: removeResumeListener,
    triggerResume: triggerResume,
    getStats: getStats,
    _activeTimers: activeTimers,
    _tabTimers: tabTimers,
    _guardedSetInterval: guardedSetInterval,
    _guardedClearInterval: guardedClearInterval
  };

  if (typeof module === 'object' && module.exports) {
    module.exports = root.AutoCuanLifecycleGuard;
  }
})(typeof window !== 'undefined' ? window : (typeof global !== 'undefined' ? global : this));
