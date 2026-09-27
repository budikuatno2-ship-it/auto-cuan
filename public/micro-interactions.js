/**
 * Auto-Cuan Micro-interactions & Loading States
 * §6.2 - Subtle button interactions and skeleton loading
 * Integrates Amicro patterns and loading.dev principles
 */

(function() {
  'use strict';

  if (window.__MICRO_INTERACTIONS__) return;
  window.__MICRO_INTERACTIONS__ = true;

  console.log('[Micro-Interactions] Initializing...');

  // ===== BUTTON MICRO-INTERACTIONS =====
  // Amicro-style subtle feedback without heavy animations

  function initButtonInteractions() {
    // Find all interactive buttons
    const buttons = document.querySelectorAll('button, .btn, [role="button"]');
    
    buttons.forEach(button => {
      // Skip if already initialized
      if (button.__microInit__) return;
      button.__microInit__ = true;

      // Subtle press effect
      button.addEventListener('mousedown', function(e) {
        this.style.transform = 'scale(0.97)';
        this.style.transition = 'transform 100ms ease';
      });

      button.addEventListener('mouseup', function(e) {
        this.style.transform = '';
        this.style.transition = 'transform 180ms ease';
      });

      button.addEventListener('mouseleave', function(e) {
        this.style.transform = '';
        this.style.transition = 'transform 180ms ease';
      });

      // Subtle hover lift
      button.addEventListener('mouseenter', function(e) {
        if (!this.disabled) {
          this.style.transform = 'translateY(-1px)';
          this.style.boxShadow = '0 4px 12px rgba(0, 0, 0, 0.15)';
          this.style.transition = 'all 180ms ease';
        }
      });

      button.addEventListener('mouseleave', function(e) {
        this.style.transform = '';
        this.style.boxShadow = '';
        this.style.transition = 'all 180ms ease';
      });
    });

    console.log(`[Micro-Interactions] Initialized ${buttons.length} buttons`);
  }

  // ===== SKELETON LOADING STATES =====
  // loading.dev pattern - clean skeleton placeholders during data fetch

  function createSkeletonLoader(options = {}) {
    const {
      width = '100%',
      height = '20px',
      borderRadius = '8px',
      animationDuration = '1.5s'
    } = options;

    const skeleton = document.createElement('div');
    skeleton.className = 'skeleton-loader';
    skeleton.style.cssText = `
      width: ${width};
      height: ${height};
      border-radius: ${borderRadius};
      background: linear-gradient(
        90deg, 
        var(--surface, #10151F) 25%, 
        var(--surface-elevated, #161C29) 50%, 
        var(--surface, #10151F) 75%
      );
      background-size: 200% 100%;
      animation: skeleton-shimmer ${animationDuration} infinite;
    `;

    // Add shimmer animation if not exists
    if (!document.getElementById('skeleton-animation')) {
      const style = document.createElement('style');
      style.id = 'skeleton-animation';
      style.textContent = `
        @keyframes skeleton-shimmer {
          0% { background-position: 200% 0; }
          100% { background-position: -200% 0; }
        }
      `;
      document.head.appendChild(style);
    }

    return skeleton;
  }

  // Replace content with skeleton during fetch
  function showSkeletonLoading(container, options = {}) {
    const {
      rows = 5,
      columns = 3,
      showHeader = true
    } = options;

    // Clear container
    container.innerHTML = '';

    // Create skeleton table if it's a table
    if (container.tagName === 'TABLE' || container.classList.contains('data-table')) {
      const table = document.createElement('table');
      table.className = 'data-table';
      table.style.width = '100%';

      // Header skeleton
      if (showHeader) {
        const thead = document.createElement('thead');
        const headerRow = document.createElement('tr');
        for (let i = 0; i < columns; i++) {
          const th = document.createElement('th');
          th.appendChild(createSkeletonLoader({ width: '80%', height: '16px' }));
          headerRow.appendChild(th);
        }
        thead.appendChild(headerRow);
        table.appendChild(thead);
      }

      // Body skeletons
      const tbody = document.createElement('tbody');
      for (let r = 0; r < rows; r++) {
        const tr = document.createElement('tr');
        for (let c = 0; c < columns; c++) {
          const td = document.createElement('td');
          td.appendChild(createSkeletonLoader({ 
            width: c === 0 ? '60%' : '40%', 
            height: '18px' 
          }));
          tr.appendChild(td);
        }
        tbody.appendChild(tr);
      }
      table.appendChild(tbody);
      container.appendChild(table);
    } else {
      // Generic content skeleton
      for (let i = 0; i < rows; i++) {
        const skeletonRow = document.createElement('div');
        skeletonRow.className = 'skeleton-row';
        skeletonRow.style.cssText = `
          display: flex;
          gap: 12px;
          padding: 12px 0;
          border-bottom: 1px solid var(--border-hairline, rgba(255,255,255,0.08));
        `;
        
        skeletonRow.appendChild(createSkeletonLoader({ 
          width: '60px', 
          height: '60px',
          borderRadius: '12px'
        }));
        
        const content = document.createElement('div');
        content.style.flex = '1';
        content.appendChild(createSkeletonLoader({ 
          width: '70%', 
          height: '16px',
          marginBottom: '8px'
        }));
        content.appendChild(createSkeletonLoader({ 
          width: '50%', 
          height: '12px'
        }));
        skeletonRow.appendChild(content);
        
        container.appendChild(skeletonRow);
      }
    }

    console.log(`[Micro-Interactions] Skeleton loading shown: ${rows} rows, ${columns} columns`);
  }

  // Remove skeleton and show actual content
  function hideSkeletonLoading(container) {
    // Fade out skeleton
    const skeletons = container.querySelectorAll('.skeleton-loader');
    skeletons.forEach(skeleton => {
      skeleton.style.transition = 'opacity 260ms ease';
      skeleton.style.opacity = '0';
      setTimeout(() => skeleton.remove(), 260);
    });

    // Fade in actual content
    const content = container.querySelectorAll('tr, .skeleton-row');
    content.forEach(el => {
      el.style.transition = 'opacity 260ms ease';
      el.style.opacity = '1';
    });

    console.log('[Micro-Interactions] Skeleton loading hidden');
  }

  // ===== FETCH LOADING INTEGRATION =====
  // Automatically show skeleton during data fetches

  function setupFetchInterceptors() {
    const originalFetch = window.fetch;

    window.fetch = async function(...args) {
      const [resource, options] = args;
      const url = typeof resource === 'string' ? resource : resource.url;

      // Find appropriate container for this fetch
      const container = findContainerForUrl(url);

      if (container) {
        // Show skeleton before fetch
        showSkeletonLoading(container, {
          rows: 5,
          columns: 3,
          showHeader: true
        });
      }

      try {
        const response = await originalFetch.apply(this, args);
        
        // Hide skeleton after successful response
        if (container) {
          // Small delay to ensure data is processed
          setTimeout(() => {
            hideSkeletonLoading(container);
          }, 300);
        }

        return response;
      } catch (error) {
        // Hide skeleton on error
        if (container) {
          hideSkeletonLoading(container);
          
          // Show error state
          container.innerHTML = `
            <div style="text-align: center; padding: 24px; color: var(--text-muted, #626C7A);">
              <p style="margin: 0 0 8px; font-size: 14px;">Gagal memuat data</p>
              <p style="margin: 0; font-size: 12px;">${error.message}</p>
            </div>
          `;
        }
        throw error;
      }
    };

    console.log('[Micro-Interactions] Fetch interceptor setup complete');
  }

  // Find container that should show loading for this URL
  function findContainerForUrl(url) {
    // Map URLs to containers
    const urlPatterns = {
      'bandarmologi': '#bandarmologiData',
      'broker': '#brokerHunterData, #brokerSummaryTable',
      'insider': '#insiderTransactions',
      'price': '#priceData',
      'portfolio': '#portfolioContent'
    };

    for (const [pattern, selector] of Object.entries(urlPatterns)) {
      if (url.toLowerCase().includes(pattern)) {
        const container = document.querySelector(selector);
        if (container) return container;
      }
    }

    return null;
  }

  // ===== CARD HOVER EFFECTS =====
  // Subtle elevation changes on card hover

  function initCardInteractions() {
    const cards = document.querySelectorAll('.dashboard-card, .card, .panel');
    
    cards.forEach(card => {
      if (card.__cardInit__) return;
      card.__cardInit__ = true;

      card.addEventListener('mouseenter', function() {
        if (!this.classList.contains('no-hover')) {
          this.style.transform = 'translateY(-2px)';
          this.style.transition = 'transform 180ms ease';
        }
      });

      card.addEventListener('mouseleave', function() {
        this.style.transform = '';
        this.style.transition = 'transform 180ms ease';
      });
    });

    console.log(`[Micro-Interactions] Initialized ${cards.length} cards`);
  }

  // ===== TOGGLE SWITCHES =====
  // Smooth toggle animations

  function initToggleSwitches() {
    const toggles = document.querySelectorAll('[type="checkbox"], .toggle-switch');
    
    toggles.forEach(toggle => {
      if (toggle.__toggleInit__) return;
      toggle.__toggleInit__ = true;

      // Find or create toggle switch UI
      let toggleSwitch = toggle.closest('.toggle-switch');
      
      if (!toggleSwitch && toggle.type === 'checkbox') {
        // Create toggle switch wrapper
        toggleSwitch = document.createElement('label');
        toggleSwitch.className = 'toggle-switch';
        toggleSwitch.style.cssText = `
          position: relative;
          display: inline-block;
          width: 44px;
          height: 24px;
        `;
        
        toggle.parentNode.insertBefore(toggleSwitch, toggle);
        toggleSwitch.appendChild(toggle);
        
        // Add track
        const track = document.createElement('span');
        track.className = 'toggle-track';
        track.style.cssText = `
          position: absolute;
          cursor: pointer;
          top: 0;
          left: 0;
          right: 0;
          bottom: 0;
          background-color: var(--border-hairline-strong, rgba(255,255,255,0.14));
          border-radius: 24px;
          transition: background-color 180ms ease;
        `;
        toggleSwitch.appendChild(track);
        
        // Add thumb
        const thumb = document.createElement('span');
        thumb.className = 'toggle-thumb';
        thumb.style.cssText = `
          position: absolute;
          content: "";
          height: 18px;
          width: 18px;
          left: 3px;
          bottom: 3px;
          background-color: white;
          border-radius: 50%;
          transition: transform 180ms ease;
        `;
        toggleSwitch.appendChild(thumb);
      }

      // Update thumb position
      const thumb = toggleSwitch?.querySelector('.toggle-thumb');
      const track = toggleSwitch?.querySelector('.toggle-track');

      if (toggle.checked && thumb && track) {
        thumb.style.transform = 'translateX(20px)';
        track.style.backgroundColor = 'var(--accent-primary, #22C55E)';
      }

      toggle.addEventListener('change', function() {
        if (thumb && track) {
          if (this.checked) {
            thumb.style.transform = 'translateX(20px)';
            track.style.backgroundColor = 'var(--accent-primary, #22C55E)';
          } else {
            thumb.style.transform = '';
            track.style.backgroundColor = '';
          }
        }
      });
    });

    console.log(`[Micro-Interactions] Initialized ${toggles.length} toggles`);
  }

  // ===== INITIALIZATION =====
  function init() {
    initButtonInteractions();
    initCardInteractions();
    initToggleSwitches();
    setupFetchInterceptors();

    console.log('[Micro-Interactions] All systems initialized');
  }

  // Run on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Export API
  window.MicroInteractions = {
    showSkeleton: showSkeletonLoading,
    hideSkeleton: hideSkeletonLoading,
    createSkeleton: createSkeletonLoader
  };

})();
