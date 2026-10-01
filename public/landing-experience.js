/* Landing interaction owner. Native APIs only; content remains visible if JS fails. */
(function (root) {
  'use strict';
  if (root.AutoCuanLandingExperience) return;
  var doc = root.document, landing = doc.getElementById('landingPage');
  if (!landing) return;
  var reduced = root.matchMedia('(prefers-reduced-motion: reduce)');
  var mobile = root.matchMedia('(max-width: 900px)');
  var menu = doc.getElementById('landingMenu'), trigger = doc.getElementById('landingMenuToggle');
  var running = new Set(), seen = new WeakSet(), observer;
  function token(name) { return root.getComputedStyle(doc.documentElement).getPropertyValue(name).trim(); }
  function milliseconds(name) {
    var value = token(name), number = parseFloat(value);
    return Number.isFinite(number) ? number * (/ms$/.test(value) ? 1 : 1000) : 0;
  }
  function motion(element, frames, options) {
    if (reduced.matches || !element.animate) return;
    try {
      var animation = element.animate(frames, options);
      running.add(animation);
      var done = function () { running.delete(animation); };
      animation.onfinish = done; animation.oncancel = done;
    } catch (_) { /* The underlying content is never hidden. */ }
  }
  function setMenu(open, restoreFocus) {
    if (!menu || !trigger) return;
    open = Boolean(open && mobile.matches);
    landing.classList.toggle('landing-menu-open', open);
    trigger.setAttribute('aria-expanded', String(open));
    trigger.setAttribute('aria-label', open ? 'Tutup menu navigasi' : 'Buka menu navigasi');
    if (restoreFocus) trigger.focus({ preventScroll: true });
  }
  if (trigger) trigger.addEventListener('click', function () { setMenu(trigger.getAttribute('aria-expanded') !== 'true'); });
  landing.addEventListener('click', function (event) {
    var target = event.target.closest('a,button');
    if (!target || target === trigger || trigger && trigger.contains(target)) return;
    if (menu && menu.contains(target)) setMenu(false);
    var href = target.getAttribute('href');
    if (href && /^#landing[A-Za-z]+$/.test(href)) {
      var section = doc.getElementById(href.slice(1));
      if (!section) return;
      event.preventDefault();
      section.setAttribute('tabindex', '-1'); section.focus({ preventScroll: true });
      section.scrollIntoView({ behavior: reduced.matches ? 'auto' : 'smooth', block: 'start' });
    }
  });
  doc.addEventListener('click', function (event) {
    if (menu && !event.target.closest('.landing-nav')) setMenu(false);
  });
  doc.addEventListener('keydown', function (event) {
    if (event.key === 'Escape' && trigger && trigger.getAttribute('aria-expanded') === 'true') {
      event.preventDefault(); setMenu(false, true);
    }
  });
  function menuBreakpoint() { setMenu(false); }
  mobile.addEventListener('change', menuBreakpoint);
  // Header and cards enter separately; offset is based on the real grid column.
  var targets = Array.from(landing.querySelectorAll('.landing-section > .landing-container > div:not(.grid), .feature-card, .faq-item, .landing-section .landing-card'));
  function reveal(element) {
    if (seen.has(element)) return;
    seen.add(element);
    element.classList.add('scroll-reveal', 'is-revealed');
    if (observer) observer.unobserve(element);
    // Never animate a focused field, nor hide the first paint of the hero.
    if (element.contains(doc.activeElement)) return;
    var siblings = Array.from(element.parentElement.children);
    var column = siblings.filter(function (other) {
      return other !== element && Math.abs(other.offsetTop - element.offsetTop) < 2 && other.offsetLeft < element.offsetLeft;
    }).length;
    motion(element, [{ opacity: 0, transform: 'translateY(20px)' }, { opacity: 1, transform: 'none' }], {
      duration: milliseconds('--motion-slow'), delay: Math.min(column, 3) * milliseconds('--motion-stagger'),
      easing: token('--ease-emphasized') || 'linear', fill: 'none'
    });
  }
  if ('IntersectionObserver' in root) {
    observer = new root.IntersectionObserver(function (entries) {
      entries.forEach(function (entry) { if (entry.isIntersecting) reveal(entry.target); });
    }, { threshold: 0.1 });
    targets.forEach(function (element) { observer.observe(element); });
  } else targets.forEach(function (element) { seen.add(element); });
  function reduceChanged() { if (reduced.matches) { running.forEach(function (a) { a.cancel(); }); running.clear(); } }
  reduced.addEventListener('change', reduceChanged);
  var heroMap = landing.querySelector ? landing.querySelector('.landing-product-map') : null;
  if (heroMap && !reduced.matches) {
    motion(heroMap, [
      { opacity: 0, transform: 'translate3d(16px,12px,0) scale(.985)' },
      { opacity: 1, transform: 'translate3d(0,0,0) scale(1)' }
    ], {
      duration: Math.max(milliseconds('--motion-slow'), 420),
      delay: 90,
      easing: token('--ease-emphasized') || 'cubic-bezier(.16,1,.3,1)',
      fill: 'none'
    });
    var heroModules = heroMap.querySelectorAll ? Array.from(heroMap.querySelectorAll('.landing-module-grid article')) : [];
    heroModules.forEach(function (element, index) {
      motion(element, [
        { opacity: 0, transform: 'translate3d(0,10px,0)' },
        { opacity: 1, transform: 'translate3d(0,0,0)' }
      ], {
        duration: Math.max(milliseconds('--motion-base'), 260),
        delay: 170 + Math.min(index, 4) * 55,
        easing: token('--ease-emphasized') || 'cubic-bezier(.16,1,.3,1)',
        fill: 'none'
      });
    });
  }

  // Two compositor-only light bands echo the visual reference without a
  // canvas particle engine. No animation work while the hero/tab is offscreen.
  var ambient = [], hero = landing.querySelector ? landing.querySelector('.landing-hero') : null, heroVisible = true;
  function updateAmbient() {
    var allowed = !reduced.matches && !mobile.matches && doc.visibilityState === 'visible' && heroVisible;
    ambient.forEach(function(a) { if (allowed) a.play(); else a.pause(); });
  }
  if (hero && hero.animate && !reduced.matches && !mobile.matches) {
    hero.querySelectorAll('.landing-beams span').forEach(function(el,i) {
      var a=el.animate([{transform:'rotate(-31deg) translateX(-8%)'},{transform:'rotate(-31deg) translateX(8%)'}],{duration:18000+i*4000,direction:'alternate',iterations:Infinity,easing:'ease-in-out'});
      ambient.push(a);
    });
    if ('IntersectionObserver' in root) {
      var heroObserver=new root.IntersectionObserver(function(entries){heroVisible=entries[0].isIntersecting;updateAmbient();});heroObserver.observe(hero);
    }
    doc.addEventListener('visibilitychange',updateAmbient);reduced.addEventListener('change',updateAmbient);mobile.addEventListener('change',updateAmbient);updateAmbient();
  }
  // Existing compatibility name, not the third-party NumberFlow library. Always
  // display the exact source value immediately; only the cell color may flash.
  var flashes = new WeakMap();
  function flash(element, up) {
    if (!element) return;
    var previous = flashes.get(element); if (previous) previous.cancel();
    element.classList.remove('flash-up', 'flash-down');
    if (reduced.matches || !element.animate) return;
    var value = token(up ? '--data-positive' : '--data-negative');
    var animation = element.animate([{ color: value }, { color: root.getComputedStyle(element).color }], { duration: milliseconds('--motion-base'), easing: token('--ease-standard') || 'linear' });
    flashes.set(element, animation); running.add(animation);
    animation.onfinish = animation.oncancel = function () { running.delete(animation); if (flashes.get(element) === animation) flashes.delete(element); };
  }
  root.AutoCuanNumberFlow = {
    animate: function (element, start, end, duration, formatter) {
      if (!element || typeof end !== 'number' || !Number.isFinite(end)) return;
      element.textContent = formatter ? formatter(end) : end.toLocaleString('id-ID');
      flash(element, end > start);
    }, flash: flash
  };
  root.AutoCuanLandingExperience = { closeMenu: function () { setMenu(false); } };
})(window);
