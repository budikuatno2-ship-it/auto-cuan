/**
 * Auto-Cuan Landing Page Scroll Reveal
 * §6.3 - Fix dead space + scroll reveal
 * Uses GSAP ScrollTrigger for staggered reveal animations
 */

(function() {
  'use strict';

  if (window.__LANDING_REVEAL__) return;
  window.__LANDING_REVEAL__ = true;

  console.log('[Landing Reveal] Initializing...');

  // Load GSAP if not already loaded
  function loadGSAP() {
    return new Promise((resolve, reject) => {
      if (window.gsap && window.ScrollTrigger) {
        resolve();
        return;
      }

      // Load GSAP
      const gsapScript = document.createElement('script');
      gsapScript.src = 'https://cdn.jsdelivr.net/npm/gsap@3/dist/gsap.min.js';
      gsapScript.onload = () => {
        // Load ScrollTrigger
        const stScript = document.createElement('script');
        stScript.src = 'https://cdn.jsdelivr.net/npm/gsap@3/dist/ScrollTrigger.min.js';
        stScript.onload = resolve;
        stScript.onerror = reject;
        document.head.appendChild(stScript);
      };
      gsapScript.onerror = reject;
      document.head.appendChild(gsapScript);
    });
  }

  // Setup scroll reveal for landing sections
  function setupLandingReveal() {
    if (typeof window.gsap === 'undefined' || typeof window.ScrollTrigger === 'undefined') {
      console.warn('[Landing Reveal] GSAP not available, skipping reveal animations');
      return;
    }

    const gsap = window.gsap;
    gsap.registerPlugin(window.ScrollTrigger);

    // Reveal variant from §6.3
    const revealVariant = {
      hidden: { opacity: 0, y: 24 },
      visible: {
        opacity: 1,
        y: 0,
        duration: 0.42,
        ease: "power3.out" // Matches --ease-emphasized
      }
    };

    // Landing sections to animate
    const landingSections = [
      '.hero-section',
      '.feature-section',
      '.pricing-section',
      '.testimonials-section',
      '.cta-section'
    ];

    landingSections.forEach(selector => {
      const section = document.querySelector(selector);
      if (section) {
        gsap.from(section, {
          opacity: 0,
          y: 24,
          duration: 0.42,
          ease: "power3.out",
          scrollTrigger: {
            trigger: section,
            start: "top 85%",
            once: true
          }
        });
        console.log(`[Landing Reveal] Setup reveal for ${selector}`);
      }
    });

    // Staggered card reveal for feature grid
    const featureCards = document.querySelectorAll('.feature-card, .pricing-card, .benefit-card');
    if (featureCards.length > 0) {
      gsap.from(featureCards, {
        opacity: 0,
        y: 24,
        duration: 0.42,
        stagger: 0.08, // §6.3 stagger 60-80ms
        ease: "power3.out",
        scrollTrigger: {
          trigger: featureCards[0].parentElement,
          start: "top 80%",
          once: true
        }
      });
      console.log(`[Landing Reveal] Setup staggered reveal for ${featureCards.length} cards`);
    }

    console.log('[Landing Reveal] All reveal animations setup complete');
  }

  // Initialize when DOM is ready
  async function init() {
    try {
      await loadGSAP();
      setupLandingReveal();
    } catch (error) {
      console.error('[Landing Reveal] Error:', error);
    }
  }

  // Run on DOM ready
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }

  // Export for manual trigger if needed
  window.setupLandingReveal = setupLandingReveal;

})();
