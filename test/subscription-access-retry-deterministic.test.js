'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.resolve(__dirname, '..');
const subGateCode = fs.readFileSync(path.join(ROOT, 'public', 'subscription-access-gate-v1.js'), 'utf8');

function createHarness(customFetch) {
  const timers = [];
  let nextTimerId = 1;

  const fakeSetTimeout = (fn, delay) => {
    const id = nextTimerId++;
    timers.push({ id, fn, delay, cleared: false });
    return id;
  };

  const fakeClearTimeout = (id) => {
    const t = timers.find(x => x.id === id);
    if (t) t.cleared = true;
  };

  let dispatchedEvents = [];

  const sandbox = {
    window: {
      loadPremiumAccess: () => {},
      applyPremiumAccessUi: () => {},
      retryPremiumAccess: null,
      refreshSubscriptionStatus: null,
      premiumAccessState: null,
      dispatchEvent: (e) => { dispatchedEvents.push(e); },
      addEventListener: () => {},
      removeEventListener: () => {},
      autocuanAuthReady: new Promise(() => {}),
      __AUTOCUAN_SUBSCRIPTION_ACCESS_GATE_V1__: undefined,
      __subRetryInternal: null
    },
    setTimeout: fakeSetTimeout,
    clearTimeout: fakeClearTimeout,
    fetch: customFetch,
    AbortController: class {
      constructor() {
        this.signal = {};
      }
      abort() {}
    },
    CustomEvent: class {
      constructor(type, init) {
        this.type = type;
        this.detail = init ? init.detail : undefined;
      }
    },
    document: {
      readyState: 'complete',
      addEventListener: () => {},
      removeEventListener: () => {}
    },
    console: console,
    Date: Date
  };
  sandbox.window.window = sandbox.window;
  sandbox.window.setTimeout = fakeSetTimeout;
  sandbox.window.clearTimeout = fakeClearTimeout;
  sandbox.window.CustomEvent = sandbox.CustomEvent;

  const context = vm.createContext(sandbox);
  vm.runInContext(subGateCode, context);

  return {
    context,
    timers,
    dispatchedEvents,
    getActiveTimers: () => timers.filter(t => !t.cleared),
    fireNextTimer: async () => {
      const active = timers.filter(t => !t.cleared);
      if (active.length === 0) return false;
      const next = active[0];
      next.cleared = true;
      await next.fn();
      return true;
    }
  };
}

test('Criterion A: Only one authoritative retry scheduler exists', async () => {
  let callCount = 0;
  const harness = createHarness(async () => {
    callCount++;
    return {
      ok: false,
      status: 500,
      json: async () => ({ error: 'internal error' })
    };
  });

  // Trigger transient failure
  await harness.context.window.loadPremiumAccess(true);

  // Exactly one timer should be active
  const active = harness.getActiveTimers();
  assert.equal(active.length, 1, 'Only one retry timer scheduled');
  assert.equal(harness.context.window.__subRetryInternal.hasTimer(), true, 'Internal scheduler reflects active timer');
  assert.equal(harness.context.window.__subRetryInternal.getAttempts(), 1, 'Single attempt registered');
});

test('Criterion B: One transient failure schedules one retry chain', async () => {
  let callCount = 0;
  const harness = createHarness(async () => {
    callCount++;
    return {
      ok: false,
      status: 503,
      json: async () => ({ error: 'service unavailable' })
    };
  });

  await harness.context.window.loadPremiumAccess(true);

  // Verify delay of first retry: SUB_RETRY_DELAYS[0] is 2000ms
  const active = harness.getActiveTimers();
  assert.equal(active.length, 1);
  assert.equal(active[0].delay, 2000, 'First retry scheduled at 2000ms delay');
  assert.equal(harness.context.window.premiumAccessState.state, 'unavailable');
  assert.equal(harness.context.window.premiumAccessState.premium, false);
});

test('Criterion C: Repeated manual Retry clicks cannot create parallel timer chains', async () => {
  let callCount = 0;
  const harness = createHarness(async () => {
    callCount++;
    return {
      ok: false,
      status: 502,
      json: async () => ({ error: 'bad gateway' })
    };
  });

  // Initial failure
  await harness.context.window.loadPremiumAccess(true);
  assert.equal(harness.getActiveTimers().length, 1);

  // User rapidly clicks manual retry 3 times concurrently
  const p1 = harness.context.window.retryPremiumAccess();
  const p2 = harness.context.window.retryPremiumAccess();
  const p3 = harness.context.window.retryPremiumAccess();
  await Promise.all([p1, p2, p3]);

  // There must still be at most 1 active timer chain, NEVER parallel chains
  const active = harness.getActiveTimers();
  assert.equal(active.length, 1, 'Never creates parallel timer chains on repeated manual retry');
  assert.equal(harness.context.window.__subRetryInternal.getAttempts(), 1, 'Attempts bounded to single in-flight retry');
});

test('Criterion D: Existing pending timer is cancelled/reused safely', async () => {
  let callCount = 0;
  const harness = createHarness(async () => {
    callCount++;
    return {
      ok: false,
      status: 500,
      json: async () => ({ error: 'transient 500' })
    };
  });

  await harness.context.window.loadPremiumAccess(true);
  const timer1 = harness.getActiveTimers()[0];
  assert.ok(timer1, 'Timer 1 active');

  // Triggering retryPremiumAccess explicitly cancels previous timer
  await harness.context.window.retryPremiumAccess();
  assert.equal(timer1.cleared, true, 'Timer 1 was cancelled safely');
  const active = harness.getActiveTimers();
  assert.equal(active.length, 1, 'New timer replaces old timer');
});

test('Criterion E: Retry counter stays bounded (max 3 retries)', async () => {
  let callCount = 0;
  const harness = createHarness(async () => {
    callCount++;
    return {
      ok: false,
      status: 500,
      json: async () => ({ error: 'persistent transient failure' })
    };
  });

  // Call 1: initial load (attempt 1 scheduled)
  await harness.context.window.loadPremiumAccess(true);
  assert.equal(harness.context.window.__subRetryInternal.getAttempts(), 1);
  assert.equal(harness.getActiveTimers().length, 1);

  // Call 2: timer 1 fires (attempt 2 scheduled)
  await harness.fireNextTimer();
  assert.equal(harness.context.window.__subRetryInternal.getAttempts(), 2);
  assert.equal(harness.getActiveTimers().length, 1);

  // Call 3: timer 2 fires (attempt 3 scheduled)
  await harness.fireNextTimer();
  assert.equal(harness.context.window.__subRetryInternal.getAttempts(), 3);
  assert.equal(harness.getActiveTimers().length, 1);

  // Call 4: timer 3 fires (max attempts reached, no further timers!)
  await harness.fireNextTimer();
  assert.equal(harness.context.window.__subRetryInternal.getAttempts(), 3, 'Attempts stay capped at MAX_SUB_RETRIES (3)');
  assert.equal(harness.getActiveTimers().length, 0, 'No more timers scheduled after limit');
  assert.equal(harness.context.window.__subRetryInternal.hasTimer(), false, 'Scheduler is completely idle');
});

test('Criterion F: 401 Unauthorized never retries', async () => {
  let callCount = 0;
  const harness = createHarness(async () => {
    callCount++;
    return {
      ok: false,
      status: 401,
      json: async () => ({ error: 'unauthorized' })
    };
  });

  await harness.context.window.loadPremiumAccess(true);

  assert.equal(harness.getActiveTimers().length, 0, '401 does not schedule retry timer');
  assert.equal(harness.context.window.__subRetryInternal.getAttempts(), 0, 'Attempts count is 0');
  assert.equal(harness.context.window.premiumAccessState.state, 'ready');
  assert.equal(harness.context.window.premiumAccessState.premium, false);
  assert.equal(harness.context.window.premiumAccessState.accessLevel, 'free');
});

test('Criterion G: 403 Forbidden never retries', async () => {
  let callCount = 0;
  const harness = createHarness(async () => {
    callCount++;
    return {
      ok: false,
      status: 403,
      json: async () => ({ error: 'forbidden' })
    };
  });

  await harness.context.window.loadPremiumAccess(true);

  assert.equal(harness.getActiveTimers().length, 0, '403 does not schedule retry timer');
  assert.equal(harness.context.window.__subRetryInternal.getAttempts(), 0, 'Attempts count is 0');
  assert.equal(harness.context.window.premiumAccessState.state, 'ready');
  assert.equal(harness.context.window.premiumAccessState.premium, false);
  assert.equal(harness.context.window.premiumAccessState.accessLevel, 'free');
});

test('Criterion H: Transient 5xx/network/timeout remain fail-closed', async () => {
  // 1. 500 error
  const h500 = createHarness(async () => ({
    ok: false, status: 500, json: async () => ({})
  }));
  await h500.context.window.loadPremiumAccess(true);
  assert.equal(h500.context.window.premiumAccessState.state, 'unavailable');
  assert.equal(h500.context.window.premiumAccessState.premium, false);
  assert.equal(h500.context.window.premiumAccessState.accessLevel, 'free');

  // 2. Network rejection
  const hNet = createHarness(async () => {
    throw new TypeError('Failed to fetch');
  });
  await hNet.context.window.loadPremiumAccess(true);
  assert.equal(hNet.context.window.premiumAccessState.state, 'unavailable');
  assert.equal(hNet.context.window.premiumAccessState.premium, false);
  assert.equal(hNet.context.window.premiumAccessState.accessLevel, 'free');

  // 3. Timeout (AbortError)
  const hTimeout = createHarness(async () => {
    const err = new Error('The user aborted a request.');
    err.name = 'AbortError';
    throw err;
  });
  await hTimeout.context.window.loadPremiumAccess(true);
  assert.equal(hTimeout.context.window.premiumAccessState.state, 'unavailable');
  assert.equal(hTimeout.context.window.premiumAccessState.premium, false);
  assert.equal(hTimeout.context.window.premiumAccessState.accessLevel, 'free');
});

test('Criterion I: Later confirmed success restores access without hard reload', async () => {
  let attempt = 0;
  const harness = createHarness(async () => {
    attempt++;
    if (attempt < 2) {
      return { ok: false, status: 503, json: async () => ({}) };
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        success: true,
        profile: {
          is_approved: true,
          subscription: {
            entitlement: {
              premium: true,
              access_level: 'premium',
              expires_at: Date.now() + 86400000,
              current_plan: 'pro'
            }
          }
        }
      })
    };
  });

  // First call fails transiently
  await harness.context.window.loadPremiumAccess(true);
  assert.equal(harness.context.window.premiumAccessState.state, 'unavailable');
  assert.equal(harness.context.window.premiumAccessState.premium, false);
  assert.equal(harness.getActiveTimers().length, 1);

  // Timer fires and executes second attempt, which succeeds
  await harness.fireNextTimer();

  // Access is immediately restored to premium without requiring page reload
  assert.equal(harness.context.window.premiumAccessState.state, 'ready');
  assert.equal(harness.context.window.premiumAccessState.premium, true);
  assert.equal(harness.context.window.premiumAccessState.accessLevel, 'premium');
  assert.equal(harness.context.window.__subRetryInternal.getAttempts(), 0, 'Attempts reset on recovery');
  assert.equal(harness.getActiveTimers().length, 0, 'All retry timers cleared');
});
