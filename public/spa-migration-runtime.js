/**
 * Auto-Cuan SPA Migration Runtime
 * Handles partial loading, event delegation, and theme sync
 */

(function() {
  'use strict';

  if (window.__AUTOCUAN_SPA_MIGRATION__) return;
  window.__AUTOCUAN_SPA_MIGRATION__ = true;

  console.log('[SPA Migration] Initializing...');

  // ===== PARTIAL LOADING SYSTEM =====
  // §4 Step 3: Inject partial via fetch + innerHTML, not iframe

  const partialCache = new Map();

  /**
   * Load a partial into target element
   * @param {string} tabId - Tab identifier
   * @param {string} url - Partial URL
   * @param {HTMLElement} targetEl - Target container element
   */
  async function loadTabPartial(tabId, url, targetEl) {
    // Cache check - don't re-fetch if already loaded
    if (targetEl.dataset.loaded === tabId) {
      console.log(`[SPA Migration] Partial ${tabId} already loaded, skipping fetch`);
      return;
    }

    try {
      console.log(`[SPA Migration] Loading partial: ${url}`);
      const response = await fetch(url);
      
      if (!response.ok) {
        throw new Error(`Failed to load partial: ${response.status} ${response.statusText}`);
      }

      const html = await response.text();
      
      // Inject content
      targetEl.innerHTML = html;
      targetEl.dataset.loaded = tabId;
      
      console.log(`[SPA Migration] Partial ${tabId} loaded successfully`);
      
      // Re-attach event listeners after innerHTML injection
      initTabScripts(tabId);
      
      // Apply theme (since partial is now in same document)
      applyThemeToPartial(targetEl);
      
    } catch (error) {
      console.error(`[SPA Migration] Error loading partial ${tabId}:`, error);
      targetEl.innerHTML = `
        <div class="dashboard-card p-4">
          <h3 class="text-lg font-bold text-white mb-2">Error Loading Content</h3>
          <p class="text-sm text-gray-400">Gagal memuat konten untuk tab ini. Silakan refresh halaman.</p>
          <p class="text-xs text-gray-500 mt-2">${error.message}</p>
        </div>
      `;
    }
  }

  /**
   * Initialize scripts for loaded tab
   * §4 Step 4: Scope event listeners with delegation
   */
  function initTabScripts(tabId) {
    console.log(`[SPA Migration] Initializing scripts for tab: ${tabId}`);
    
    // Convert direct event listeners to delegation pattern
    // This prevents listeners from breaking when content is re-injected
    setupEventDelegation(tabId);
  }

  /**
   * Setup event delegation for tab content
   * §4 Step 4: Event delegation at container level, not individual elements
   */
  function setupEventDelegation(tabId) {
    const appContent = document.getElementById('appContent');
    if (!appContent) return;

    // Remove old delegation listeners to avoid duplicates
    const oldHandler = appContent.__delegationHandler;
    if (oldHandler) {
      appContent.removeEventListener('click', oldHandler);
    }

    // Create new delegation handler
    const delegationHandler = function(e) {
      // Analisis Saham specific handlers
      const target = e.target.closest('#btnJalankanAnalisis');
      if (target) {
        e.preventDefault();
        if (typeof window.jalankanAnalisis === 'function') {
          window.jalankanAnalisis();
        }
        return;
      }

      // Tab switching
      const tabButton = e.target.closest('.analisis-tab');
      if (tabButton && tabButton.dataset.tab) {
        e.preventDefault();
        if (typeof window.switchAnalisisTab === 'function') {
          window.switchAnalisisTab(tabButton.dataset.tab);
        }
        return;
      }

      // Ticker input
      const tickerInput = e.target.closest('#tickerInput');
      if (tickerInput) {
        // Handle ticker input if needed
        return;
      }

      // API Key modal
      const apiKeyBtn = e.target.closest('[onclick*="openAiApiKeyModal"]');
      if (apiKeyBtn) {
        e.preventDefault();
        if (typeof window.openAiApiKeyModal === 'function') {
          window.openAiApiKeyModal();
        }
        return;
      }
    };

    appContent.addEventListener('click', delegationHandler);
    appContent.__delegationHandler = delegationHandler;

    console.log(`[SPA Migration] Event delegation setup complete for tab: ${tabId}`);
  }

  /**
   * Apply current theme to partial content
   * §4 Step 5: Sync theme - partial now lives in same document, automatic
   */
  function applyThemeToPartial(container) {
    // Since partial is now in same document, CSS variables apply automatically
    // No additional code needed - theme is controlled by data-theme on <html>
    console.log('[SPA Migration] Theme applied to partial (CSS variables inherited)');
  }

  // ===== THEME SYNC =====
  // §4 Step 5: Remove duplicate theme logic from partials

  /**
   * Theme is now controlled entirely by index.html data-theme on <html>
   * No additional theme sync needed - CSS variables cascade automatically
   */
  function syncTheme() {
    // Theme is already synced via CSS custom properties on :root
    // Partial content automatically inherits due to being in same document
  }

  // ===== EXPORTED API =====
  window.loadTabPartial = loadTabPartial;
  window.initTabScripts = initTabScripts;
  window.setupEventDelegation = setupEventDelegation;
  window.syncTheme = syncTheme;

  // Auto-initialize when DOM is ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', () => {
      console.log('[SPA Migration] Runtime initialized');
    });
  } else {
    console.log('[SPA Migration] Runtime initialized (DOM already ready)');
  }

})();
