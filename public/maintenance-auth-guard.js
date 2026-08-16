(function () {
  'use strict';

  if (window.__AUTOCUAN_MAINTENANCE_AUTH_GUARD__) return;
  window.__AUTOCUAN_MAINTENANCE_AUTH_GUARD__ = true;

  function visible(id) {
    var el = document.getElementById(id);
    return !!(el && el.classList && !el.classList.contains('hidden'));
  }

  function maintenanceGateVisible() {
    return visible('maintenanceScreen') || visible('serviceStatusScreen');
  }

  var originalOpenAuthChoiceModal = window.openAuthChoiceModal;
  if (typeof originalOpenAuthChoiceModal === 'function') {
    window.openAuthChoiceModal = function () {
      if (maintenanceGateVisible()) {
        if (typeof window.closeAuthChoiceModal === 'function') {
          try { window.closeAuthChoiceModal(); } catch (_) {}
        }
        return;
      }
      return originalOpenAuthChoiceModal.apply(this, arguments);
    };
  }

  if (maintenanceGateVisible() && typeof window.closeAuthChoiceModal === 'function') {
    try { window.closeAuthChoiceModal(); } catch (_) {}
  }

  window.__AUTOCUAN_MAINTENANCE_AUTH_GUARD_API__ = {
    maintenanceGateVisible: maintenanceGateVisible
  };
})();
