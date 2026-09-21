const assert = require('assert');

function setupEnvironment() {
  const storage = {};
  global.localStorage = {
    getItem(k) { return storage[k] || null; },
    setItem(k, v) { storage[k] = String(v); },
    removeItem(k) { delete storage[k]; }
  };
  global.document = {
    getElementById() { return null; },
    addEventListener() {}
  };
  global.window = global;
  require('../public/analisis-saham-runtime');
}

async function runTests() {
  console.log('--- Running public/analisis-saham-runtime.js Bug Reproduction Tests ---');
  setupEnvironment();

  // BUG-ASR-01: verifySubscriptionStatus completely bypasses server verification when localStorage username is 'budi'
  console.log('\nTesting BUG-ASR-01: Client-side paywall bypass via localStorage "budi"...');
  try {
    let serverCalled = false;
    global.fetch = async function(url) {
      if (url.includes('/api/reset-password')) {
        serverCalled = true;
        return { ok: true, json: async () => ({ success: false }) };
      }
      return { ok: false };
    };

    // Set fake username in localStorage
    global.localStorage.setItem('autocuan_user', 'budi');

    const result = await global.verifySubscriptionStatus();

    assert.strictEqual(
      serverCalled,
      true,
      `BUG-ASR-01 PROVEN: verifySubscriptionStatus bypassed server authentication entirely and returned ${result} because user was "budi" in localStorage`
    );
  } catch (err) {
    console.log('   [FAIL - BUG PROVEN]', err.message);
  }

  // BUG-ASR-02: switchAnalisisTab double-triggers switchAnalisisSubTab
  console.log('\nTesting BUG-ASR-02: switchAnalisisTab double-triggers sub-tab initialization...');
  try {
    let subTabSwitchCount = 0;
    const origSwitchSubTab = global.switchAnalisisSubTab;
    global.switchAnalisisSubTab = function(tab) {
      subTabSwitchCount++;
    };

    global.switchAnalisisTab('analisis-chart');
    global.switchAnalisisSubTab = origSwitchSubTab;

    assert.strictEqual(
      subTabSwitchCount,
      1,
      `BUG-ASR-02 PROVEN: switchAnalisisTab('analisis-chart') invoked switchAnalisisSubTab ${subTabSwitchCount} times instead of 1`
    );
  } catch (err) {
    console.log('   [FAIL - BUG PROVEN]', err.message);
  }

  // BUG-ASR-03: mktCtxFmtIDR omits 'Rp ' prefix for values >= 1e6 while including it for < 1e6
  console.log('\nTesting BUG-ASR-03: Currency prefix inconsistency in mktCtxFmtIDR...');
  try {
    const formattedBillion = global.mktCtxFmtIDR(5000000000); // 5 Miliar
    const formattedHundredThousand = global.mktCtxFmtIDR(500000); // 500 Ribu

    console.log('   mktCtxFmtIDR(5B):', formattedBillion);
    console.log('   mktCtxFmtIDR(500K):', formattedHundredThousand);

    // Consistency check: both must have the standard 'Rp' currency prefix
    const hasRpBillion = formattedBillion.includes('Rp');
    const hasRpHundredK = formattedHundredThousand.includes('Rp');

    assert.strictEqual(
      hasRpBillion && hasRpHundredK,
      true,
      `BUG-ASR-03 PROVEN: Inconsistent currency prefix in mktCtxFmtIDR (5B gives "${formattedBillion}" without "Rp", while 500K gives "${formattedHundredThousand}" with "Rp")`
    );
  } catch (err) {
    console.log('   [FAIL - BUG PROVEN]', err.message);
  }
}

runTests();
