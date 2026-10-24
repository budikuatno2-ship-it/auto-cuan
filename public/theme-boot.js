(function () {
  'use strict';
  try {
    var pref = 'auto';
    try { pref = localStorage.getItem('autocuan_theme') || 'auto'; } catch (_) {}
    if (pref !== 'light' && pref !== 'dark') pref = 'auto';
    var dark = pref === 'dark' || (pref === 'auto' && !!(window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches));
    var root = document.documentElement;
    root.classList.toggle('light', !dark);
    root.classList.toggle('dark', dark);
    root.classList.toggle('is-dark', dark);
    root.setAttribute('data-theme', dark ? 'dark' : 'light');
    root.setAttribute('data-theme-pref', pref);
  } catch (_) {}
})();
