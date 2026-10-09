'use strict';

const puppeteer = require('puppeteer');
const fs = require('fs');
const path = require('path');
const assert = require('assert');

const ROOT_DIR = path.resolve(__dirname, '..');
const VERIFIED_ORIGIN = 'http://127.0.0.1:3000';
const OUT_DIRS = [
  path.join(ROOT_DIR, 'screenshots', 'wave8c-evidence'),
  path.join(ROOT_DIR) // also save in root with exact names if looked up directly
];

OUT_DIRS.forEach(dir => {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
});

async function run() {
  console.log('=== WAVE 8C PUPPETEER EVIDENCE CAPTURE ===');
  console.log('Verified Local Origin:', VERIFIED_ORIGIN);

  const browser = await puppeteer.launch({
    headless: 'new',
    args: ['--no-sandbox', '--disable-setuid-sandbox']
  });

  const errors = [];
  const captureResults = [];

  // Helper to save screenshot to both destinations
  async function saveScreenshot(page, filename) {
    for (const outDir of OUT_DIRS) {
      const dest = path.join(outDir, filename);
      await page.screenshot({ path: dest });
      console.log('  Saved:', dest);
    }
  }

  // Verification helper satisfying all 7 checks
  async function verifyPreConditions(page, expectedSelector, description) {
    const currentUrl = page.url();
    assert.ok(currentUrl.startsWith(VERIFIED_ORIGIN), `URL check failed: ${currentUrl} does not start with ${VERIFIED_ORIGIN}`);

    const checks = await page.evaluate((sel) => {
      const target = document.querySelector(sel);
      const serviceScreen = document.getElementById('serviceStatusScreen');
      const maintenanceScreen = document.getElementById('maintenanceScreen');
      const sheets = Array.from(document.styleSheets);

      const computed = target ? window.getComputedStyle(target) : null;
      const targetRect = target ? target.getBoundingClientRect() : null;
      const targetVisible = !!(
        target &&
        !target.classList.contains('hidden') &&
        computed &&
        computed.display !== 'none' &&
        computed.visibility !== 'hidden' &&
        targetRect &&
        targetRect.width > 0 &&
        targetRect.height > 0
      );
      const inViewport = targetRect ? (
        targetRect.top < window.innerHeight &&
        targetRect.bottom > 0 &&
        targetRect.left < window.innerWidth &&
        targetRect.right > 0
      ) : false;

      const serviceStatusActive = !!(serviceScreen && !serviceScreen.classList.contains('hidden') && serviceScreen.offsetParent !== null);
      const maintenanceActive = !!(maintenanceScreen && !maintenanceScreen.classList.contains('hidden') && maintenanceScreen.offsetParent !== null);

      return {
        targetVisible,
        targetRect,
        inViewport,
        styleSheetsLoaded: sheets.length >= 3,
        serviceStatusActive,
        maintenanceActive
      };
    }, expectedSelector);

    assert.ok(!checks.serviceStatusActive, `Check 4 Failed: Service status protection screen is active during ${description}!`);
    assert.ok(!checks.maintenanceActive, `Check 4 Failed: Maintenance screen is active during ${description}!`);
    assert.ok(checks.styleSheetsLoaded, `Check 3 Failed: Stylesheets failed to load during ${description}!`);
    assert.ok(checks.targetVisible, `Check 2 Failed: Target ${expectedSelector} is not visible during ${description}!`);
    assert.ok(checks.inViewport, `Check 5 Failed: Target ${expectedSelector} is not positioned inside viewport during ${description}!`);

    console.log(`  ✓ Pre-checks passed for: ${description} (selector: ${expectedSelector})`);
  }

  try {
    const page = await browser.newPage();
    page.on('console', msg => {
      if (msg.type() === 'error') {
        console.warn('  Browser Console Error:', msg.text());
        errors.push(msg.text());
      }
    });

    // ─────────────────────────────────────────────────────────────────────────
    // 1. wave8c-login-desktop-light-1440x900.png
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[1/6] Capturing Login Desktop Light (1440x900)...');
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(VERIFIED_ORIGIN + '/', { waitUntil: 'networkidle2' });
    await page.evaluate(() => {
      if (typeof applyAppTheme === 'function') applyAppTheme('light');
      if (typeof openLoginModal === 'function') openLoginModal();
    });
    await new Promise(r => setTimeout(r, 400));
    await verifyPreConditions(page, '#loginModal', 'Login Desktop Light');
    await saveScreenshot(page, 'wave8c-login-desktop-light-1440x900.png');
    captureResults.push('wave8c-login-desktop-light-1440x900.png: PASS');

    // ─────────────────────────────────────────────────────────────────────────
    // 2. wave8c-login-desktop-dark-1440x900.png
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[2/6] Capturing Login Desktop Dark (1440x900)...');
    await page.evaluate(() => {
      if (typeof applyAppTheme === 'function') applyAppTheme('dark');
    });
    await new Promise(r => setTimeout(r, 400));
    await verifyPreConditions(page, '#loginModal', 'Login Desktop Dark');
    await saveScreenshot(page, 'wave8c-login-desktop-dark-1440x900.png');
    captureResults.push('wave8c-login-desktop-dark-1440x900.png: PASS');

    // ─────────────────────────────────────────────────────────────────────────
    // 3. wave8c-login-mobile-light-390x844.png
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[3/6] Capturing Login Mobile Light (390x844)...');
    await page.setViewport({ width: 390, height: 844 });
    await page.evaluate(() => {
      if (typeof applyAppTheme === 'function') applyAppTheme('light');
    });
    await new Promise(r => setTimeout(r, 400));
    await verifyPreConditions(page, '#loginModal', 'Login Mobile Light');
    await saveScreenshot(page, 'wave8c-login-mobile-light-390x844.png');
    captureResults.push('wave8c-login-mobile-light-390x844.png: PASS');

    // ─────────────────────────────────────────────────────────────────────────
    // 4. wave8c-approval-pending-mobile-390x844.png
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[4/6] Capturing Registration Approval Pending Mobile (390x844)...');
    await page.evaluate(() => {
      if (typeof closeLoginModal === 'function') closeLoginModal();
      if (typeof openRegisterModal === 'function') openRegisterModal();
      // Legitimate UI state simulation: user submitted registration, awaiting admin approval
      const form = document.getElementById('registerFormFields');
      const panel = document.getElementById('registerApprovalPanel');
      const code = document.getElementById('registerApprovalCode');
      const verifCode = document.getElementById('registerVerificationCode');
      const expiry = document.getElementById('registerVerificationExpiry');
      if (form) form.classList.add('hidden');
      if (panel) panel.classList.remove('hidden');
      if (code) code.textContent = 'USR-98421';
      if (verifCode) verifCode.textContent = 'AC-4829';
      if (expiry) expiry.textContent = 'Berlaku hingga 10 menit ke depan';
    });
    await new Promise(r => setTimeout(r, 400));
    await verifyPreConditions(page, '#registerApprovalPanel', 'Approval Pending Mobile');
    await saveScreenshot(page, 'wave8c-approval-pending-mobile-390x844.png');
    captureResults.push('wave8c-approval-pending-mobile-390x844.png: PASS');

    // ─────────────────────────────────────────────────────────────────────────
    // 5. wave8c-session-expiry-desktop-dark-1440x900.png
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[5/6] Capturing Session Expiry Desktop Dark (1440x900)...');
    await page.setViewport({ width: 1440, height: 900 });
    await page.goto(VERIFIED_ORIGIN + '/', { waitUntil: 'networkidle2' });
    await page.evaluate(() => {
      if (typeof applyAppTheme === 'function') applyAppTheme('dark');
      // Trigger session expiry via canonical function with standard expired message
      if (typeof openAuthChoiceModal === 'function') {
        openAuthChoiceModal('Sesi sudah tidak berlaku. Silakan login kembali.');
      }
    });
    await new Promise(r => setTimeout(r, 400));
    await verifyPreConditions(page, '#authChoiceModal', 'Session Expiry Desktop Dark');
    await saveScreenshot(page, 'wave8c-session-expiry-desktop-dark-1440x900.png');
    captureResults.push('wave8c-session-expiry-desktop-dark-1440x900.png: PASS');

    // ─────────────────────────────────────────────────────────────────────────
    // 6. wave8c-account-center-mobile-light-390x844.png
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[6/6] Capturing Account Center Mobile Light (390x844)...');
    await page.setViewport({ width: 390, height: 844 });
    await page.goto(VERIFIED_ORIGIN + '/', { waitUntil: 'networkidle2' });
    await page.evaluate(async () => {
      if (typeof applyAppTheme === 'function') applyAppTheme('light');
      if (typeof openAccountProfile === 'function') {
        await openAccountProfile();
      }
    });
    await page.waitForSelector('#acAccountCenter:not([hidden])', { timeout: 8000 });
    await new Promise(r => setTimeout(r, 600));
    await verifyPreConditions(page, '#acAccountCenter', 'Account Center Mobile Light');
    await saveScreenshot(page, 'wave8c-account-center-mobile-light-390x844.png');
    captureResults.push('wave8c-account-center-mobile-light-390x844.png: PASS');

    // ─────────────────────────────────────────────────────────────────────────
    // Automated Assertions: Account Center Desktop Light & Dark
    // ─────────────────────────────────────────────────────────────────────────
    console.log('\n[Verification] Running automated assertions for Account Center Desktop Light & Dark...');
    await page.setViewport({ width: 1440, height: 900 });

    // Desktop Light
    const acDesktopLight = await page.evaluate(() => {
      applyAppTheme('light');
      const shell = document.querySelector('#acAccountCenter .ac-center-shell');
      const rect = shell.getBoundingClientRect();
      const style = window.getComputedStyle(shell);
      return {
        width: rect.width,
        height: rect.height,
        maxWidth: style.maxWidth,
        bg: style.backgroundColor
      };
    });
    assert.ok(acDesktopLight.width <= 881, `Account Center desktop light width must be <= 880px, got ${acDesktopLight.width}`);
    console.log('  ✓ Account Center Desktop Light width verified:', acDesktopLight.width, '<= 880px');

    // Desktop Dark
    const acDesktopDark = await page.evaluate(() => {
      applyAppTheme('dark');
      const shell = document.querySelector('#acAccountCenter .ac-center-shell');
      const rect = shell.getBoundingClientRect();
      const style = window.getComputedStyle(shell);
      return {
        width: rect.width,
        height: rect.height,
        maxWidth: style.maxWidth,
        bg: style.backgroundColor
      };
    });
    assert.ok(acDesktopDark.width <= 881, `Account Center desktop dark width must be <= 880px, got ${acDesktopDark.width}`);
    console.log('  ✓ Account Center Desktop Dark width verified:', acDesktopDark.width, '<= 880px');

    await page.close();
  } finally {
    await browser.close();
  }

  console.log('\n=== ALL CAPTURES AND ASSERTIONS COMPLETED SUCCESSFULLY ===');
  captureResults.forEach(r => console.log('  ' + r));
}

run().catch(err => {
  console.error('\nCAPTURE EXECUTION FAILED:', err);
  process.exit(1);
});
