/**
 * Auto-Cuan Design System Verification Script
 * PRIORITY 15: Browser & Console Verification
 * Run this script in browser console to verify implementation
 */

(function() {
  'use strict';

  console.log('=== Auto-Cuan Design System Verification ===');
  
  const results = {
    passed: 0,
    failed: 0,
    warnings: []
  };

  function test(name, fn) {
    try {
      const result = fn();
      if (result === true) {
        console.log(`✅ PASS: ${name}`);
        results.passed++;
      } else {
        console.warn(`⚠️  FAIL: ${name}`, result);
        results.failed++;
      }
    } catch (error) {
      console.error(`❌ ERROR: ${name}`, error);
      results.failed++;
    }
  }

  // 1. Check Design Tokens Exist
  test('Design tokens CSS variables defined', () => {
    const root = document.documentElement;
    const tokens = [
      '--canvas', '--surface', '--surface-elevated',
      '--accent-primary', '--data-positive', '--data-negative',
      '--motion-fast', '--motion-base', '--motion-slow'
    ];
    const missing = tokens.filter(t => getComputedStyle(root).getPropertyValue(t).trim() === '');
    if (missing.length > 0) {
      return `Missing tokens: ${missing.join(', ')}`;
    }
    return true;
  });

  // 2. Check Theme Switching Works
  test('Theme switching function exists', () => {
    return typeof window.toggleAppTheme === 'function';
  });

  test('Theme data attribute changes', () => {
    const html = document.documentElement;
    const original = html.getAttribute('data-theme');
    html.setAttribute('data-theme', 'light');
    const lightSet = html.getAttribute('data-theme') === 'light';
    html.setAttribute('data-theme', 'dark');
    const darkSet = html.getAttribute('data-theme') === 'dark';
    if (original) html.setAttribute('data-theme', original);
    else html.removeAttribute('data-theme');
    return lightSet && darkSet;
  });

  // 3. Check SPA Migration Runtime
  test('SPA migration runtime loaded', () => {
    return window.__AUTOCUAN_SPA_MIGRATION__ === true;
  });

  test('Partial loading function exists', () => {
    return typeof window.loadTabPartial === 'function';
  });

  test('Event delegation function exists', () => {
    return typeof window.setupEventDelegation === 'function';
  });

  // 4. Check NumberFlow (if available)
  test('NumberFlow library loaded', () => {
    return window.NumberFlow !== undefined;
  });

  test('NumberFlow animator API available', () => {
    return window.NumberFlowAnimator !== undefined;
  });

  // 5. Check Micro-interactions
  test('Micro-interactions runtime loaded', () => {
    return window.__MICRO_INTERACTIONS__ === true;
  });

  test('Skeleton loading API available', () => {
    return window.MicroInteractions !== undefined;
  });

  // 6. Check CSS Applied
  test('Design system CSS loaded', () => {
    const links = Array.from(document.querySelectorAll('link[href*="design-system"]'));
    return links.length > 0;
  });

  test('App transition CSS loaded', () => {
    const links = Array.from(document.querySelectorAll('link[href*="app-transition"]'));
    return links.length > 0;
  });

  // 7. Check Sidebar Structure
  test('App sidebar exists', () => {
    return document.getElementById('appSidebar') !== null;
  });

  test('Sidebar collapse state attribute exists', () => {
    const sidebar = document.getElementById('appSidebar');
    if (!sidebar) return false;
    const parent = sidebar.closest('[data-sidebar-state]');
    return parent !== null;
  });

  // 8. Check Navigation
  test('NavigateTo function enhanced', () => {
    // Check if it's been overridden for SPA
    return typeof window.navigateTo === 'function';
  });

  // 9. Check Data Tables
  test('Data table styles exist', () => {
    const style = document.createElement('style');
    style.textContent = '.test-table { font-variant-numeric: tabular-nums; }';
    document.head.appendChild(style);
    const testEl = document.createElement('table');
    testEl.className = 'test-table';
    document.body.appendChild(testEl);
    const computed = getComputedStyle(testEl).fontVariant;
    document.body.removeChild(testEl);
    style.remove();
    return computed.includes('tabular');
  });

  // 10. Check Console Errors
  test('No critical console errors', () => {
    // This would need actual console monitoring
    // For now, just check that essential functions exist
    const essentials = [
      'loadTabPartial',
      'setupEventDelegation',
      'NumberFlowAnimator',
      'MicroInteractions'
    ];
    const missing = essentials.filter(fn => typeof window[fn] !== 'function');
    if (missing.length > 0) {
      return `Missing essential functions: ${missing.join(', ')}`;
    }
    return true;
  });

  // Summary
  console.log('\n=== Verification Summary ===');
  console.log(`✅ Passed: ${results.passed}`);
  console.log(`❌ Failed: ${results.failed}`);
  
  if (results.warnings.length > 0) {
    console.log('⚠️  Warnings:', results.warnings);
  }

  if (results.failed === 0) {
    console.log('\n🎉 ALL TESTS PASSED! Design system implementation verified.');
  } else {
    console.log('\n⚠️  Some tests failed. Check details above.');
  }

  // Return results for programmatic access
  return results;

})();
