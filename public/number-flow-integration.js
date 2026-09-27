/**
 * Auto-Cuan NumberFlow Integration
 * §6.4 - Live number animation for prices and Net Flow
 * Animates individual numeric cells without affecting entire rows
 */

(function() {
  'use strict';

  if (window.__NUMBER_FLOW__) return;
  window.__NUMBER_FLOW__ = true;

  console.log('[NumberFlow] Initializing...');

  // Load NumberFlow library if not available
  function loadNumberFlow() {
    return new Promise((resolve, reject) => {
      if (window.NumberFlow) {
        resolve();
        return;
      }

      // Load NumberFlow from CDN
      const script = document.createElement('script');
      script.src = 'https://cdn.jsdelivr.net/npm/number-flow@0.3.0/dist/number-flow.umd.min.js';
      script.onload = resolve;
      script.onerror = reject;
      document.head.appendChild(script);
    });
  }

  // Initialize NumberFlow on numeric elements
  function initNumberFlow() {
    if (typeof window.NumberFlow === 'undefined') {
      console.warn('[NumberFlow] Library not available, skipping animations');
      return;
    }

    // Find all numeric cells that should animate
    const numericSelectors = [
      '.col-numeric[data-animate]',
      '[data-number-flow]',
      '.price-cell[data-animate]',
      '.net-flow-cell[data-animate]',
      '[data-live-price]',
      '[data-live-netflow]'
    ];

    numericSelectors.forEach(selector => {
      const elements = document.querySelectorAll(selector);
      elements.forEach(el => {
        initNumberFlowElement(el);
      });
    });

    console.log(`[NumberFlow] Initialized ${document.querySelectorAll('[data-number-flow]').length} elements`);
  }

  // Initialize NumberFlow on single element
  function initNumberFlowElement(el) {
    if (el.__numberFlow__) return; // Already initialized

    try {
      const nf = new NumberFlow(el, {
        // Animation timing from design tokens
        duration: 300, // Fast but visible
        locale: 'id-ID', // Indonesian number format
      });

      el.__numberFlow__ = nf;
      console.log(`[NumberFlow] Initialized on:`, el);
    } catch (error) {
      console.error('[NumberFlow] Error initializing:', error);
    }
  }

  // Update value with animation
  function updateAnimatedNumber(el, newValue) {
    if (el.__numberFlow__) {
      // Use NumberFlow for smooth animation
      el.textContent = newValue;
      el.__numberFlow__.update();
    } else {
      // Fallback: direct update
      el.textContent = newValue;
    }
  }

  // Apply semantic coloring based on value change
  function applyValueChangeColor(el, oldValue, newValue) {
    const oldNum = parseFloat(oldValue);
    const newNum = parseFloat(newValue);

    if (isNaN(oldNum) || isNaN(newNum)) return;

    // Remove existing color classes
    el.classList.remove('positive', 'negative', 'neutral');

    if (newNum > oldNum) {
      el.classList.add('positive');
      // Add highlight flash
      el.style.transition = 'background-color 0.3s ease';
      el.style.backgroundColor = 'rgba(34, 197, 94, 0.15)';
      setTimeout(() => {
        el.style.backgroundColor = '';
      }, 300);
    } else if (newNum < oldNum) {
      el.classList.add('negative');
      el.style.transition = 'background-color 0.3s ease';
      el.style.backgroundColor = 'rgba(239, 68, 68, 0.15)';
      setTimeout(() => {
        el.style.backgroundColor = '';
      }, 300);
    }
  }

  // Watch for data updates and animate
  function setupDataWatcher() {
    // Find elements that get updated with live data
    const liveDataSelectors = [
      '[id*="NetFlow"]',
      '[id*="netflow"]', 
      '[id*="Price"]',
      '[id*="price"]',
      '.broker-summary-value',
      '.insider-transaction-value'
    ];

    liveDataSelectors.forEach(selector => {
      const elements = document.querySelectorAll(selector);
      elements.forEach(el => {
        // Mark as animatable
        el.setAttribute('data-number-flow', 'true');
        el.setAttribute('data-animate', 'true');
        
        // Initialize NumberFlow
        initNumberFlowElement(el);
        
        // Setup mutation observer to detect changes
        const observer = new MutationObserver((mutations) => {
          mutations.forEach(mutation => {
            if (mutation.type === 'characterData' || mutation.type === 'childList') {
              const oldValue = mutation.oldValue || el.textContent;
              const newValue = el.textContent;
              
              // Animate the change
              updateAnimatedNumber(el, newValue);
              
              // Apply color change feedback
              if (oldValue !== newValue) {
                applyValueChangeColor(el, oldValue, newValue);
              }
            }
          });
        });

        observer.observe(el, { 
          characterData: true, 
          childList: true, 
          subtree: true,
          attributes: true,
          attributeFilter: ['data-value']
        });
      });
    });

    console.log('[NumberFlow] Data watcher setup complete');
  }

  // Initialize on DOM ready
  async function init() {
    try {
      await loadNumberFlow();
      initNumberFlow();
      setupDataWatcher();
    } catch (error) {
      console.error('[NumberFlow] Initialization failed:', error);
    }
  }

  // Run on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Export API for manual use
  window.NumberFlowAnimator = {
    update: updateAnimatedNumber,
    init: initNumberFlowElement,
    applyColor: applyValueChangeColor
  };

})();
