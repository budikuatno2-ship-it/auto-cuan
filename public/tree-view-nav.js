/**
 * Auto-Cuan Tree-View Navigation
 * Provides accordion-style collapsible navigation with sub-menus
 */

(function() {
  'use strict';

  /**
   * Toggle a tree-group open/closed
   * @param {HTMLElement} groupEl - The .tree-group element
   */
  function toggleTreeGroup(groupEl) {
    const wasOpen = groupEl.classList.contains('open');
    
    // Close all other groups (accordion behavior)
    document.querySelectorAll('.tree-group.open').forEach(group => {
      if (group !== groupEl) {
        group.classList.remove('open');
      }
    });
    
    // Toggle the clicked group
    groupEl.classList.toggle('open', !wasOpen);
    
    // Persist state in localStorage
    const pageName = groupEl.dataset.page || 'default';
    try {
      localStorage.setItem('tree_' + pageName, !wasOpen ? 'open' : 'closed');
    } catch (e) {
      // localStorage may be unavailable
    }
  }

  /**
   * Initialize tree-view navigation
   */
  function initTreeView() {
    const treeGroups = document.querySelectorAll('.tree-group');
    
    treeGroups.forEach(group => {
      const header = group.querySelector('.tree-item-header');
      if (!header) return;
      
      // Click handler
      header.addEventListener('click', function(e) {
        e.preventDefault();
        toggleTreeGroup(group);
      });
      
      // Keyboard support
      header.addEventListener('keydown', function(e) {
        if (e.key === 'Enter' || e.key === ' ') {
          e.preventDefault();
          toggleTreeGroup(group);
        } else if (e.key === 'ArrowRight') {
          // Open if closed
          if (!group.classList.contains('open')) {
            toggleTreeGroup(group);
          }
        } else if (e.key === 'ArrowLeft') {
          // Close if open
          if (group.classList.contains('open')) {
            toggleTreeGroup(group);
          }
        }
      });
      
      // Restore saved state
      const pageName = group.dataset.page || 'default';
      try {
        const saved = localStorage.getItem('tree_' + pageName);
        if (saved === 'open') {
          group.classList.add('open');
        }
      } catch (e) {
        // localStorage may be unavailable
      }
    });
    
    // Add keyboard navigation for sub-menu items
    document.querySelectorAll('.tree-submenu-item').forEach(item => {
      item.addEventListener('keydown', function(e) {
        if (e.key === 'Tab') {
          // When Tabbing out of a sub-menu item, close the parent
          const parentGroup = this.closest('.tree-group');
          if (parentGroup && e.shiftKey === false) {
            // Only close on forward Tab (not Shift+Tab)
            setTimeout(() => {
              if (!parentGroup.contains(document.activeElement)) {
                parentGroup.classList.remove('open');
              }
            }, 10);
          }
        }
      });
    });
  }

  /**
   * Convert a sidebar-item with sub-menu data into tree-view structure
   * This enables gradual migration from flat nav to tree-view
   */
  function upgradeToTreeView() {
    document.querySelectorAll('.sidebar-item[data-submenu]').forEach(item => {
      const submenuData = item.dataset.submenu;
      if (!submenuData) return;
      
      try {
        const submenuItems = JSON.parse(submenuData);
        if (!Array.isArray(submenuItems) || submenuItems.length === 0) return;
        
        // Create tree-group structure
        const parent = item.parentElement;
        const group = document.createElement('div');
        group.className = 'tree-group';
        group.dataset.page = item.dataset.sidebarPage || item.dataset.page || '';
        
        // Create header
        const header = document.createElement('button');
        header.type = 'button';
        header.className = 'tree-item-header';
        header.setAttribute('aria-expanded', 'false');
        header.innerHTML = `
          <span class="tree-chevron">
            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
              <path d="M9 18l6-6-6-6"/>
            </svg>
          </span>
          <span class="tree-icon">${item.querySelector('svg')?.outerHTML || ''}</span>
          <span class="tree-label">${item.querySelector('.sidebar-label')?.textContent || ''}</span>
        `;
        
        // Create sub-menu
        const submenu = document.createElement('div');
        submenu.className = 'tree-submenu';
        submenu.setAttribute('role', 'menu');
        
        submenuItems.forEach(subitem => {
          const btn = document.createElement('button');
          btn.type = 'button';
          btn.className = 'tree-submenu-item';
          btn.setAttribute('role', 'menuitem');
          if (subitem.onclick) {
            btn.setAttribute('data-action', subitem.onclick);
            btn.onclick = function() {
              const action = this.dataset.action;
              if (action && typeof window[action] === 'function') {
                window[action]();
              } else if (action) {
                eval(action);
              }
            };
          }
          if (subitem.href) {
            btn.onclick = function() {
              window.location.href = subitem.href;
            };
          }
          btn.textContent = subitem.label || subitem.text || '';
          submenu.appendChild(btn);
        });
        
        // Assemble
        group.appendChild(header);
        group.appendChild(submenu);
        
        // Replace original item
        parent.insertBefore(group, item);
        item.remove();
        
      } catch (e) {
        console.warn('Failed to upgrade sidebar-item to tree-view:', e);
      }
    });
  }

  /**
   * Initialize on DOM ready
   */
  function init() {
    if (document.readyState === 'loading') {
      document.addEventListener('DOMContentLoaded', initTreeView);
    } else {
      initTreeView();
    }
  }

  // Auto-init
  init();

  // Expose API for manual control
  window.TreeViewNav = {
    toggle: toggleTreeGroup,
    upgrade: upgradeToTreeView,
    init: initTreeView
  };

})();
