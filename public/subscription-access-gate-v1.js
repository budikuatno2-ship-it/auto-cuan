(function () {
  'use strict';

  if (window.__AUTOCUAN_SUBSCRIPTION_ACCESS_GATE_V1__) return;
  window.__AUTOCUAN_SUBSCRIPTION_ACCESS_GATE_V1__ = true;

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

  async function loadPremiumAccessFromSubscription(force) {
    var now = Date.now();
    if (!force && cache && now - cache.checkedAt < CACHE_MS) return setState(cache);
    if (requestInFlight && !force) return requestInFlight;

    requestInFlight = (async function () {
      try {
        var result = await fetchProfile();
        if (result.response.ok && result.data && result.data.success === true && result.data.profile) {
          cache = stateFromProfile(result.data.profile);
          return setState(cache);
        }

        if (result.response.status === 401 || result.response.status === 403) {
          cache = {
            state:'ready', premium:false, accessLevel:'free', checkedAt:Date.now(),
            expiresAt:null, subscriptionRequired:false, approved:false
          };
          return setState(cache);
        }

        cache = null;
        return setState({
          state:'unavailable', premium:false, accessLevel:'free', checkedAt:Date.now(),
          expiresAt:null, subscriptionRequired:false, approved:false
        });
      } catch (_) {
        cache = null;
        return setState({
          state:'unavailable', premium:false, accessLevel:'free', checkedAt:Date.now(),
          expiresAt:null, subscriptionRequired:false, approved:false
        });
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
    window.refreshSubscriptionStatus = function () {
      cache = null;
      return loadPremiumAccessFromSubscription(true);
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