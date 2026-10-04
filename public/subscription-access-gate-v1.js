(function () {
  'use strict';

  if (window.__AUTOCUAN_SUBSCRIPTION_ACCESS_GATE_V1__) return;
  window.__AUTOCUAN_SUBSCRIPTION_ACCESS_GATE_V1__ = true;

  // NOTE: No preview-mode bypass here. Mock auth state is set exclusively by
  // the dev server's injected <script> tag (tools/local-dev-server.js) before
  // this file runs. This production file must remain auth-bypass-free.

  var requestInFlight = null;
  var cache = null;
  var CACHE_MS = 20000;
  var installAttempts = 0;

  function setState(next) {
    window.premiumAccessState = next;
    if (typeof window.applyPremiumAccessUi === 'function') {
      try { window.applyPremiumAccessUi(); } catch (_) {}
    }
    try {
      window.dispatchEvent(new CustomEvent('autocuan:premium-access', { detail: next }));
    } catch (_) {}
    return next;
  }

  function stateFromProfile(profile) {
    var p = profile && typeof profile === 'object' ? profile : {};
    var sub = p.subscription && typeof p.subscription === 'object' ? p.subscription : {};
    var ent = sub.entitlement && typeof sub.entitlement === 'object' ? sub.entitlement : null;
    var isAdmin = p.is_admin === true;
    var approved = p.is_approved === true;
    var premium = isAdmin || (approved && ent && ent.premium === true);
    var level = isAdmin ? 'admin' : (premium ? String(ent.access_level || 'premium') : 'free');
    var expiresAt = premium && ent && ent.expires_at ? ent.expires_at : null;

    return {
      state: 'ready',
      premium: premium === true,
      accessLevel: level,
      checkedAt: Date.now(),
      expiresAt: expiresAt,
      subscriptionRequired: approved && !premium,
      approved: approved,
      trialState: ent && ent.trial_state || 'not_started',
      currentPlan: ent && ent.current_plan || null
    };
  }

  async function fetchProfile() {
    var controller = typeof AbortController === 'function' ? new AbortController() : null;
    var timer = setTimeout(function () {
      try { if (controller) controller.abort(); } catch (_) {}
    }, 7000);

    try {
      var response = await fetch('/api/reset-password', {
        method: 'POST',
        credentials: 'same-origin',
        cache: 'no-store',
        headers: { 'Content-Type':'application/json', 'Cache-Control':'no-cache' },
        body: JSON.stringify({ action:'account-profile' }),
        signal: controller ? controller.signal : undefined
      });
      var data = await response.json().catch(function () { return {}; });
      return { response:response, data:data };
    } finally {
      clearTimeout(timer);
    }
  }

  var _subRetryAttempts = 0;
  var MAX_SUB_RETRIES = 3;
  var SUB_RETRY_DELAYS = [2000, 5000, 10000];
  var subRetryTimer = null;

  async function loadPremiumAccessFromSubscription(force) {
    var now = Date.now();
    if (!force && cache && now - cache.checkedAt < CACHE_MS) return setState(cache);
    if (requestInFlight) return requestInFlight;

    requestInFlight = (async function () {
      var isTimeout = false;
      var is5xx = false;
      try {
        var result = await fetchProfile();
        if (result.response.ok && result.data && result.data.success === true && result.data.profile) {
          _subRetryAttempts = 0;
          if (subRetryTimer) { clearTimeout(subRetryTimer); subRetryTimer = null; }
          cache = stateFromProfile(result.data.profile);
          return setState(cache);
        }

        if (result.response.status === 401 || result.response.status === 403) {
          _subRetryAttempts = 0;
          if (subRetryTimer) { clearTimeout(subRetryTimer); subRetryTimer = null; }
          cache = {
            state:'ready', premium:false, accessLevel:'free', checkedAt:Date.now(),
            expiresAt:null, subscriptionRequired:false, approved:false
          };
          return setState(cache);
        }

        if (result.response && result.response.status >= 500) is5xx = true;
        cache = null;
        var errType = isTimeout ? 'timeout' : (is5xx ? 'server_error' : 'network_error');
        var unavail = setState({
          state:'unavailable', premium:false, accessLevel:'free', checkedAt:Date.now(),
          expiresAt:null, subscriptionRequired:false, approved:false, errorType:errType
        });
        if (_subRetryAttempts < MAX_SUB_RETRIES) {
          var delay = SUB_RETRY_DELAYS[_subRetryAttempts] || 10000;
          _subRetryAttempts++;
          if (subRetryTimer) clearTimeout(subRetryTimer);
          subRetryTimer = setTimeout(function () {
            subRetryTimer = null;
            return loadPremiumAccessFromSubscription(true);
          }, delay);
        }
        return unavail;
      } catch (err) {
        if (err && err.name === 'AbortError') isTimeout = true;
        cache = null;
        var errType = isTimeout ? 'timeout' : (is5xx ? 'server_error' : 'network_error');
        var unavail = setState({
          state:'unavailable', premium:false, accessLevel:'free', checkedAt:Date.now(),
          expiresAt:null, subscriptionRequired:false, approved:false, errorType:errType
        });
        if (_subRetryAttempts < MAX_SUB_RETRIES) {
          var delay = SUB_RETRY_DELAYS[_subRetryAttempts] || 10000;
          _subRetryAttempts++;
          if (subRetryTimer) clearTimeout(subRetryTimer);
          subRetryTimer = setTimeout(function () {
            subRetryTimer = null;
            return loadPremiumAccessFromSubscription(true);
          }, delay);
        }
        return unavail;
      } finally {
        requestInFlight = null;
      }
    })();

    return requestInFlight;
  }

  function install() {
    installAttempts += 1;
    if (typeof window.loadPremiumAccess !== 'function' || typeof window.applyPremiumAccessUi !== 'function') {
      if (installAttempts < 20) setTimeout(install, 150);
      return;
    }

    // Replace the old approval-only browser resolver. The backend remains the
    // actual security boundary; this replacement keeps page/navigation UX in
    // sync with the signed server entitlement.
    window.loadPremiumAccess = loadPremiumAccessFromSubscription;
    window.retryPremiumAccess = function () {
      if (subRetryTimer) {
        clearTimeout(subRetryTimer);
        subRetryTimer = null;
      }
      _subRetryAttempts = 0;
      cache = null;
      return loadPremiumAccessFromSubscription(true);
    };
    window.refreshSubscriptionStatus = function () {
      cache = null;
      return loadPremiumAccessFromSubscription(true);
    };

    window.__subRetryInternal = {
      getAttempts: function () { return _subRetryAttempts; },
      hasTimer: function () { return !!subRetryTimer; },
      clearTimer: function () { if (subRetryTimer) { clearTimeout(subRetryTimer); subRetryTimer = null; } },
      resetAttempts: function () { _subRetryAttempts = 0; }
    };

    var ready = window.autocuanAuthReady;
    if (ready && typeof ready.then === 'function') {
      ready.then(function (result) {
        if (result && result.valid === false && !result.transient) {
          cache = null;
          setState({ state:'ready', premium:false, accessLevel:'free', checkedAt:Date.now(), expiresAt:null, subscriptionRequired:false, approved:false });
          return;
        }
        loadPremiumAccessFromSubscription(true);
      }).catch(function () {});
    } else {
      loadPremiumAccessFromSubscription(true);
    }
  }

  window.addEventListener('autocuan:subscription-changed', function () {
    cache = null;
    loadPremiumAccessFromSubscription(true);
  });

  if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', install, { once:true });
  else install();
})();