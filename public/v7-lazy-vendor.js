/* Auto-Cuan V7 Lazy Vendor Loader (Sub-Kloter 4C)
   Strict lazy injection for Cytoscape.js (135.80 KB gz) and custom Apache ECharts (203.18 KB gz),
   plus TanStack Virtual Core (10.18 KB gz) on demand.
   ZERO eager loading of Cytoscape or ECharts on landing '/' boot. */
(function (root) {
  'use strict';

  var VENDOR_VERSION = 'v7-4c';
  var VENDORS = {
    tanstackVirtual: {
      src: '/vendor/tanstack-virtual.min.js?v=' + VENDOR_VERSION,
      globalKey: 'TanStackVirtualCore',
      label: '@tanstack/virtual-core v3.19.13'
    },
    cytoscape: {
      src: '/vendor/cytoscape.min.js?v=' + VENDOR_VERSION,
      globalKey: 'cytoscape',
      label: 'Cytoscape.js v3.35.0'
    },
    echarts: {
      src: '/vendor/echarts-custom.min.js?v=' + VENDOR_VERSION,
      globalKey: 'echarts',
      label: 'Apache ECharts v6.1.0 (custom tree-shaken)'
    }
  };

  var inflight = {};
  var loadHistory = [];

  function loadVendor(key) {
    var cfg = VENDORS[key];
    if (!cfg) {
      return Promise.reject(new Error('Unknown V7 vendor key: ' + String(key)));
    }
    if (!root || !root.document) {
      return Promise.reject(new Error('Browser document unavailable for vendor load'));
    }
    if (root[cfg.globalKey]) {
      return Promise.resolve(root[cfg.globalKey]);
    }
    if (inflight[key]) {
      return inflight[key];
    }

    var doc = root.document;
    var existingScript = doc.querySelector('script[data-v7-vendor="' + key + '"]');
    if (existingScript && root[cfg.globalKey]) {
      return Promise.resolve(root[cfg.globalKey]);
    }

    inflight[key] = new Promise(function (resolve, reject) {
      var script = existingScript || doc.createElement('script');
      if (!existingScript) {
        script.src = cfg.src;
        script.async = true;
        script.defer = true;
        script.setAttribute('data-v7-vendor', key);
      }

      var settled = false;
      function cleanup() {
        script.removeEventListener('load', onLoad);
        script.removeEventListener('error', onError);
      }
      function onLoad() {
        if (settled) return;
        settled = true;
        cleanup();
        if (root[cfg.globalKey]) {
          loadHistory.push({ key: key, loadedAt: Date.now(), src: cfg.src });
          resolve(root[cfg.globalKey]);
        } else {
          delete inflight[key];
          reject(new Error('Vendor global missing after load: ' + cfg.globalKey));
        }
      }
      function onError() {
        if (settled) return;
        settled = true;
        cleanup();
        delete inflight[key];
        reject(new Error('Failed to load vendor script: ' + cfg.src));
      }

      script.addEventListener('load', onLoad);
      script.addEventListener('error', onError);
      if (!existingScript) {
        (doc.head || doc.body || doc.documentElement).appendChild(script);
      }
    });

    return inflight[key];
  }

  var api = {
    VENDORS: VENDORS,
    loadTanstackVirtual: function () { return loadVendor('tanstackVirtual'); },
    loadCytoscape: function () { return loadVendor('cytoscape'); },
    loadEcharts: function () { return loadVendor('echarts'); },
    isLoaded: function (key) {
      var cfg = VENDORS[key];
      return Boolean(cfg && root && root[cfg.globalKey]);
    },
    getStatus: function () {
      return {
        tanstackVirtual: Boolean(root && root.TanStackVirtualCore),
        cytoscape: Boolean(root && root.cytoscape),
        echarts: Boolean(root && root.echarts),
        loads: loadHistory.slice()
      };
    }
  };

  if (root) {
    root.AutoCuanV7Vendors = api;
  }
  if (typeof module !== 'undefined' && module.exports) {
    module.exports = api;
  }
})(typeof window !== 'undefined' ? window : null);
