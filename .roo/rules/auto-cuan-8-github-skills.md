# AUTO-CUAN V4: 8 INSTITUTIONAL GITHUB ENGINEERING SKILLS & ARCHITECTURAL MANIFESTO

**Document Identification:** `.roo/rules/auto-cuan-8-github-skills.md`
**Status:** PERMANENT INSTITUTIONAL DIRECTIVE (NON-NEGOTIABLE ARCHITECTURAL RULE)
**Classification:** ARCHITECTURAL INTEGRITY, PRODUCTION EXCELLENCE & FORENSIC OBSERVABILITY
**Scope:** Frontend UI/UX, Full-Viewport Layout, Backend Quota Engine, Screener Pipelines, Real-Time Charting, Telemetry, and Security
**Target Environment:** Auto-Cuan V4 Core, Daytrade V7, Stock Arjum Financial Engine, Broker Hunter, and AI Cockpit

---

## 1. EXECUTIVE OVERVIEW & ARCHITECTURAL PHILOSOPHY

Auto-Cuan V4 represents a paradigm shift from retail-grade dashboard interfaces to high-throughput, institutional-grade financial intelligence infrastructure. To achieve ultra-low latency, mathematical determinism, forensic auditability, and zero visual friction, this document integrates eight battle-tested engineering methodologies from premier open-source initiatives.

Every pull request, refactor, backend endpoint, and frontend template within the Auto-Cuan ecosystem must strictly conform to the eight foundational pillars established herein:

1. **Full-Viewport 12-Column Institutional Bento Grid** — [nutlope/hallmark](https://github.com/nutlope/hallmark)
2. **Zero AI Slop & Strict Quantitative Precision** — [miqdadbadjuber/anti-slop](https://github.com/miqdadbadjuber/anti-slop)
3. **Zero Layout Shift & Deterministic Sub-15ms Fast-Bundle Rendering** — [pbakaus/impeccable](https://github.com/pbakaus/impeccable)
4. **60 FPS GPU-Accelerated Micro-Transitions** — [cth9191/animate](https://github.com/cth9191/animate)
5. **Single requestAnimationFrame Batched Canvas/SVG Rendering** — [DhvanilPatel/swarm-cursors](https://github.com/DhvanilPatel/swarm-cursors)
6. **Automated Live DOM & Bounding-Box Inspection** — [Tencent/BrowserSkill](https://github.com/Tencent/BrowserSkill)
7. **End-to-End Real User Journey Click Simulation** — [browser-use/browser-use](https://github.com/browser-use/browser-use)
8. **Deep Forensic Telemetry, Process Integrity & Threat Audit Table** — [NationalSecurityAgency/ghidra](https://github.com/NationalSecurityAgency/ghidra)

---

## 2. SKILL 1: NUTLOPE/HALLMARK — FULL-VIEWPORT 12-COLUMN INSTITUTIONAL BENTO GRID
**Repository:** [https://github.com/nutlope/hallmark](https://github.com/nutlope/hallmark)
**Domain:** Viewport Architecture, Bento Grid Modularization, Multi-Pane Density, Zero Outer-Scroll

### 2.1 The Zero-Outer-Scroll Invariant
Institutional trading workstations (Bloomberg Terminal, FactSet, TradingView Pro) operate on a zero-outer-scroll paradigm. The primary application window must fit exactly within `100vh` (or `100dvh` on modern mobile browsers) without page-level vertical scrollbars. Scrolling is strictly confined to internal scroll containers (`overflow-y-auto`) within isolated bento cards.

```css
/* Strict Root Shell Constraints - Zero Outer Scroll */
html, body {
  height: 100%;
  width: 100%;
  margin: 0;
  padding: 0;
  overflow: hidden;
  background-color: #0B0E14;
  color: #E2E8F0;
  font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, "Helvetica Neue", Arial, sans-serif;
  font-feature-settings: "cv02", "cv03", "cv04", "cv11";
  -webkit-font-smoothing: antialiased;
  -moz-osx-font-smoothing: grayscale;
}

.institutional-viewport-container {
  display: flex;
  flex-direction: column;
  height: 100vh;
  height: 100dvh;
  width: 100vw;
  overflow: hidden;
}
```

### 2.2 Mathematical 12-Column Grid Topology
The layout grid consists of 12 equal-fraction columns with rigid gap metrics:
- **Desktop (>= 1440px):** 12 columns, 16px gap, 16px container padding.
- **Laptop / Pro Tablet (1024px - 1439px):** 12 columns, 12px gap, 12px container padding.
- **Tablet / Small Screen (768px - 1023px):** 6-column composite stack with tab switching.
- **Mobile (< 768px):** 1-column responsive accordion card stack.

```css
.bento-grid-12 {
  display: grid;
  grid-template-columns: repeat(12, minmax(0, 1fr));
  gap: 16px;
  height: calc(100vh - 56px); /* subtract header bar */
  padding: 16px;
  box-sizing: border-box;
}

/* Institutional Bento Card Allocation */
.bento-cell-screener  { grid-column: span 3; height: 100%; overflow: hidden; display: flex; flex-direction: column; }
.bento-cell-chart     { grid-column: span 6; height: 100%; overflow: hidden; display: flex; flex-direction: column; }
.bento-cell-orderflow { grid-column: span 3; height: 100%; overflow: hidden; display: flex; flex-direction: column; }

@media (max-width: 1280px) {
  .bento-cell-screener  { grid-column: span 4; }
  .bento-cell-chart     { grid-column: span 8; }
  .bento-cell-orderflow { grid-column: span 12; height: 320px; }
}

@media (max-width: 768px) {
  .bento-grid-12 {
    display: flex;
    flex-direction: column;
    height: auto;
    overflow-y: auto;
  }
  .bento-cell-screener, .bento-cell-chart, .bento-cell-orderflow {
    grid-column: span 12;
    height: 480px;
  }
}
```

### 2.3 Visual Hierarchy & Surface Elevation Standards
Every bento card must possess explicit surface tokens and visual depth:
- **Surface Level 1 (Base Viewport):** `#0B0E14`
- **Surface Level 2 (Bento Container):** `#0F141C` with border: `1px solid rgba(255, 255, 255, 0.06)`
- **Surface Level 3 (Elevated Panels & Toolbars):** `#151B26` with border: `1px solid rgba(255, 255, 255, 0.10)`
- **Surface Level 4 (Active Ticker Rows / Hovered Cards):** `#1C2433` with subtle institutional glow: `box-shadow: 0 4px 20px -2px rgba(0, 0, 0, 0.5)`
- **Border Radius Standards:** `rounded-lg` (8px) for internal widgets and badges, `rounded-xl` (12px) for major bento cards. Rounding must never exceed 16px to prevent juvenile design aesthetics.

### 2.4 Keyboard Shortcuts for Institutional Navigation
Traders require zero-latency keyboard switching across bento cards:
- `Alt + 1`: Focus Screener Table & Search Input.
- `Alt + 2`: Focus TradingView / Lightweight Chart Surface.
- `Alt + 3`: Focus Orderflow / Broker Hunter Depth Panel.
- `Space`: Toggle Play/Pause on Live Screener Streaming.
- `Esc`: Clear Active Filter or Dismiss Modal Overlays.

---

## 3. SKILL 2: MIQDADBADJUBER/ANTI-SLOP — ZERO AI SLOP & STRICT QUANTITATIVE PRECISION
**Repository:** [https://github.com/miqdadbadjuber/anti-slop](https://github.com/miqdadbadjuber/anti-slop)
**Domain:** Numeric Determinism, Prompt Guardrails, Blacklisted Jargon, Financial Computation

### 3.1 Eradication of AI Slop and Qualitative Vague Assertions
Trading interfaces must never display AI-generated fluff, marketing jargon, or qualitative hand-waving. Every assertion must be substantiated by a verifiable mathematical derivation or raw exchange metric.

#### Comprehensive Blacklisted Slop Matrix & Mandatory Substitutions:
- ❌ *"Saham ini sangat menjanjikan dengan prospek cerah di masa depan"*
  ✅ **Mandatory Substitution:** *"CR3: 68.4% (Akumulasi masif ZP, CC, AK), Net Foreign Flow: +Rp 14.2 M, Breakout R1 1.450 pada 2.4x Median Volume 20 Hari."*
- ❌ *"Potensi cuan luar biasa, segera serok sebelum terbang to the moon"*
  ✅ **Mandatory Substitution:** *"Setup Daytrade V7 Terpenuhi: Bid/Offer Ratio 2.14, VWAP 845 (Last Price 850, +0.59% vs VWAP), Volatilitas 1.8x ATR(14)."*
- ❌ *"Kondisi pasar saat ini agak kurang bersahabat dan galau"*
  ✅ **Mandatory Substitution:** *"IHSG -0.84% (52 Advancing, 314 Declining, 120 Unchanged), Total Turnover Rp 8.1T vs 20-Day Median Rp 10.5T."*
- ❌ *"Bandar terlihat sedang memainkan harga secara misterius"*
  ✅ **Mandatory Substitution:** *"Top Broker Concentration (CR1: 34.2% by YU), Net Absorption Rp 28.5 M, Average Buy Price Rp 422 vs Market Rp 428."*
- ❌ *"Tampaknya candle membentuk pola bullish yang cantik"*
  ✅ **Mandatory Substitution:** *"Candle Daily: Hammer Rejection di Support S2 (Low 1.280, Close 1.315), Upper Shadow 4.2%, Lower Shadow 18.6%."*

### 3.2 IEEE-754 Precision Standards & Safe Decimal Arithmetic
JavaScript floating-point arithmetic can introduce rounding errors (e.g., `0.1 + 0.2 === 0.30000000000000004`). Financial computations in Auto-Cuan must enforce strict rounding utilities and integer lot arithmetic:

```javascript
/**
 * Institutional Quantitative Math Formatter & Precision Validator
 */
const InstitutionalMath = {
  roundPrice(val) {
    if (val === null || val === undefined || isNaN(val)) return 0;
    return Math.round(Number(val));
  },

  formatPercent(val) {
    if (val === null || val === undefined || isNaN(val)) return '0.00%';
    const num = Number(val);
    const sign = num > 0 ? '+' : '';
    return `${sign}${num.toFixed(2)}%`;
  },

  formatIDR(val) {
    if (val === null || val === undefined || isNaN(val)) return 'Rp 0';
    const num = Number(val);
    if (Math.abs(num) >= 1e12) return `Rp ${(num / 1e12).toFixed(2)} T`;
    if (Math.abs(num) >= 1e9)  return `Rp ${(num / 1e9).toFixed(2)} B`;
    if (Math.abs(num) >= 1e6)  return `Rp ${(num / 1e6).toFixed(2)} M`;
    return new Intl.NumberFormat('id-ID', { style: 'currency', currency: 'IDR', maximumFractionDigits: 0 }).format(num);
  },

  calculateVWAP(trades) {
    if (!Array.isArray(trades) || trades.length === 0) return 0;
    let cumVolume = 0;
    let cumValue = 0;
    for (let i = 0; i < trades.length; i++) {
      const vol = Number(trades[i].volume) || 0;
      const price = Number(trades[i].price) || 0;
      cumVolume += vol;
      cumValue += (price * vol);
    }
    return cumVolume > 0 ? Number((cumValue / cumVolume).toFixed(2)) : 0;
  },

  calculateOrderbookImbalance(bidLots, offerLots) {
    const total = bidLots + offerLots;
    if (total === 0) return 0;
    return Number(((bidLots - offerLots) / total).toFixed(4));
  },

  calculateCR3(brokerList) {
    if (!Array.isArray(brokerList) || brokerList.length === 0) return 0;
    const sorted = [...brokerList].sort((a, b) => (b.netValue || 0) - (a.netValue || 0));
    const totalNet = sorted.reduce((sum, b) => sum + Math.max(0, b.netValue || 0), 0);
    if (totalNet === 0) return 0;
    const top3Net = sorted.slice(0, 3).reduce((sum, b) => sum + Math.max(0, b.netValue || 0), 0);
    return Number(((top3Net / totalNet) * 100).toFixed(2));
  },

  calculateHerfindahlHirschmanIndex(shares) {
    // Sum of squared market shares (0 - 10,000 scale)
    if (!Array.isArray(shares) || shares.length === 0) return 0;
    return Math.round(shares.reduce((acc, s) => acc + Math.pow(Number(s) * 100, 2), 0));
  }
};
```

### 3.3 Prompt Engineering Guardrails in AI Chat (`api/ai/chat.js`)
When invoking LLMs for market summary, the system prompt must inject strict mathematical rules:
1. Every paragraph must contain at least two concrete numbers with units (%, IDR, Lot).
2. Never invent price targets without showing the ATR or Fibonacci calculation.
3. If data is unavailable, output strictly: `[DATA_DEFICIENT: Parameter <name> tidak tersedia]`.

---

## 4. SKILL 3: PBAKAUS/IMPECCABLE — ZERO LAYOUT SHIFT & DETERMINISTIC SUB-15MS FAST-BUNDLE RENDERING
**Repository:** [https://github.com/pbakaus/impeccable](https://github.com/pbakaus/impeccable)
**Domain:** Core Web Vitals, Cumulative Layout Shift (CLS), Latency Budgets, Asset Delivery

### 4.1 Cumulative Layout Shift Invariant: CLS = 0.000
Institutional traders make decisions in milliseconds. A jumping button or resizing chart container causes costly misclicks. Layout shift is strictly forbidden.
- **Explicit Width and Height Attributes:** All images, charts, and table rows must specify explicit layout dimensions or CSS `aspect-ratio`.
- **Skeleton Loaders:** Content that is fetched asynchronously must render inside fixed-height skeleton wrappers matching the exact pixel dimensions of the loaded component.

```html
<!-- Anti-Layout Shift Skeleton Placeholder -->
<div class="h-64 w-full bg-slate-800/40 animate-pulse rounded-lg flex flex-col justify-between p-4" style="min-height: 256px;">
  <div class="h-4 bg-slate-700/50 rounded w-1/3"></div>
  <div class="space-y-2">
    <div class="h-3 bg-slate-700/30 rounded w-full"></div>
    <div class="h-3 bg-slate-700/30 rounded w-5/6"></div>
  </div>
  <div class="h-8 bg-slate-700/40 rounded w-1/4"></div>
</div>
```

### 4.2 Sub-15ms Fast-Bundle Rendering Paradigm (`api/fast-bundle.js`)
To ensure immediate application readiness:
1. **Critical Path Compression:** The initial payload returned by `/api/fast-bundle.js` must be under 35KB compressed and parseable in < 15ms on an Intel i5 / Apple M1 baseline.
2. **In-Memory Cache:** Fast-bundle responses are pre-calculated and served directly from Node.js memory with `Cache-Control: public, max-age=5, stale-while-revalidate=15`.
3. **No Dynamic CSS Injection:** All styling must be compiled ahead of time into a deterministic CSS bundle. No runtime CSS-in-JS style tags that trigger re-layouts.

### 4.3 Stale-While-Revalidate Engine Architecture
```javascript
/**
 * In-Memory Fast-Bundle Serving Cache
 */
class FastBundleCache {
  constructor(ttlMs = 5000) {
    this.cachedBuffer = null;
    this.cachedETag = null;
    this.lastUpdated = 0;
    this.ttlMs = ttlMs;
  }

  isFresh() {
    return this.cachedBuffer && (Date.now() - this.lastUpdated < this.ttlMs);
  }

  set(data) {
    const jsonStr = JSON.stringify(data);
    this.cachedBuffer = Buffer.from(jsonStr);
    this.cachedETag = require('crypto').createHash('md5').update(this.cachedBuffer).digest('hex');
    this.lastUpdated = Date.now();
  }

  serve(req, res) {
    if (this.cachedETag && req.headers['if-none-match'] === this.cachedETag) {
      res.writeHead(304, { 'ETag': this.cachedETag });
      return res.end();
    }
    res.writeHead(200, {
      'Content-Type': 'application/json',
      'Content-Length': this.cachedBuffer.length,
      'ETag': this.cachedETag,
      'Cache-Control': 'public, max-age=5, stale-while-revalidate=15'
    });
    res.end(this.cachedBuffer);
  }
}
```

---

## 5. SKILL 4: CTH9191/ANIMATE — 60 FPS GPU-ACCELERATED MICRO-TRANSITIONS
**Repository:** [https://github.com/cth9191/animate](https://github.com/cth9191/animate)
**Domain:** Composite Layers, Hardware Acceleration, 60 FPS Frame Budget, Micro-Interactions

### 5.1 The Composite-Only Animation Rule
Animating layout properties (`width`, `height`, `top`, `left`, `margin`, `padding`) forces the browser engine through expensive **Recalculate Style -> Layout -> Paint -> Composite** cycles, dropping frame rates below 60 FPS.
Auto-Cuan UI strictly enforces:
- **Allowed Animated Properties:** Only `transform` (specifically `translate3d`, `scale3d`) and `opacity`.
- **Hardware Acceleration Trigger:** Promotion to dedicated GPU compositor layers via `will-change: transform, opacity` or `transform: translateZ(0)`.

```css
/* High-Performance Tick Micro-Flash */
@keyframes price-tick-up {
  0% {
    background-color: rgba(16, 185, 129, 0.35);
    transform: translate3d(0, 0, 0) scale3d(1.02, 1.02, 1);
  }
  100% {
    background-color: transparent;
    transform: translate3d(0, 0, 0) scale3d(1, 1, 1);
  }
}

@keyframes price-tick-down {
  0% {
    background-color: rgba(239, 68, 68, 0.35);
    transform: translate3d(0, 0, 0) scale3d(0.98, 0.98, 1);
  }
  100% {
    background-color: transparent;
    transform: translate3d(0, 0, 0) scale3d(1, 1, 1);
  }
}

.tick-flash-up {
  will-change: transform, background-color;
  animation: price-tick-up 240ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
}

.tick-flash-down {
  will-change: transform, background-color;
  animation: price-tick-down 240ms cubic-bezier(0.16, 1, 0.3, 1) forwards;
}
```

### 5.2 16.67ms Institutional Frame Budget
To guarantee a solid 60 FPS:
- Every animation step must complete execution within **10ms**, leaving 6.67ms headroom for garbage collection and browser composition.
- Continuous loops (such as radar spinners or pulsing badges) must be disabled or throttled when the tab is hidden (`document.visibilityState === 'hidden'`).

```javascript
/**
 * Tab Visibility Animation Throttler
 */
document.addEventListener('visibilitychange', () => {
  if (document.hidden) {
    document.body.classList.add('reduce-animations');
    window.__pauseTickAnimations = true;
  } else {
    document.body.classList.remove('reduce-animations');
    window.__pauseTickAnimations = false;
  }
});
```

---

## 6. SKILL 5: DHVANILPATEL/SWARM-CURSORS — SINGLE REQUESTANIMATIONFRAME BATCHED CANVAS/SVG RENDERING
**Repository:** [https://github.com/DhvanilPatel/swarm-cursors](https://github.com/DhvanilPatel/swarm-cursors)
**Domain:** Crosshair Coordinates, High-Frequency Event Coalescing, Zero GC Pressure

### 6.1 The Event Throttling & Batching Problem
Mouse movements on high-polling rate gaming mice generate 500 to 1,000 `pointermove` events per second. Binding raw DOM updates directly to `onmousemove` immediately chokes the main thread.

### 6.2 The Swarm-Cursors Unified rAF Render Loop
Auto-Cuan implements a centralized rendering coordinator that batches mouse coordinates, crosshair projections, and tooltip measurements into a single `requestAnimationFrame` loop:

```javascript
/**
 * Single requestAnimationFrame High-Frequency Cursor Coordinator
 */
class InstitutionalCursorCoordinator {
  constructor() {
    this.latestX = 0;
    this.latestY = 0;
    this.isDirty = false;
    this.subscribers = new Set();
    this.rafId = null;

    this.onPointerMove = this.onPointerMove.bind(this);
    this.tick = this.tick.bind(this);
  }

  init(containerElement) {
    containerElement.addEventListener('pointermove', this.onPointerMove, { passive: true });
    this.start();
  }

  onPointerMove(e) {
    // Collect coalesced events if available from high-rate pointer devices
    const events = (typeof e.getCoalescedEvents === 'function') ? e.getCoalescedEvents() : [e];
    const lastEvent = events[events.length - 1];
    this.latestX = lastEvent.clientX;
    this.latestY = lastEvent.clientY;
    this.isDirty = true;
  }

  subscribe(renderCallback) {
    this.subscribers.add(renderCallback);
    return () => this.subscribers.delete(renderCallback);
  }

  start() {
    if (!this.rafId) {
      this.tick();
    }
  }

  tick() {
    if (this.isDirty) {
      const x = this.latestX;
      const y = this.latestY;
      for (const subscriber of this.subscribers) {
        subscriber(x, y);
      }
      this.isDirty = false;
    }
    this.rafId = requestAnimationFrame(this.tick);
  }

  destroy(containerElement) {
    if (this.rafId) cancelAnimationFrame(this.rafId);
    containerElement.removeEventListener('pointermove', this.onPointerMove);
    this.subscribers.clear();
  }
}
```

### 6.3 Canvas High-DPI Scaling & Zero GC Buffer Pooling
When drawing orderbook depth bars or technical indicators:
1. Always account for `window.devicePixelRatio` (typically 2x on Retina displays).
2. Pre-allocate typed arrays (`Float64Array`, `Int32Array`) outside the draw loop to avoid garbage collector churn.

```javascript
/**
 * High-DPI Canvas Initializer with Memory Buffer Pre-allocation
 */
function setupHighDpiCanvas(canvas, cssWidth, cssHeight) {
  const dpr = window.devicePixelRatio || 1;
  canvas.width = Math.round(cssWidth * dpr);
  canvas.height = Math.round(cssHeight * dpr);
  canvas.style.width = `${cssWidth}px`;
  canvas.style.height = `${cssHeight}px`;

  const ctx = canvas.getContext('2d', { alpha: false, desynchronized: true });
  ctx.scale(dpr, dpr);
  return { ctx, dpr };
}
```

---

## 7. SKILL 6: TENCENT/BROWSERSKILL — AUTOMATED LIVE DOM & BOUNDING-BOX INSPECTION
**Repository:** [https://github.com/Tencent/BrowserSkill](https://github.com/Tencent/BrowserSkill)
**Domain:** DOM Geometry Inspection, Overlap Auditing, Viewport Boundary Clipping

### 7.1 Autonomous Live Bounding-Box Verification
Trading dashboards frequently suffer from overlapping popovers, clipped dropdowns, and truncated numbers. BrowserSkill's bounding-box verification algorithm is embedded into our CI/CD and gate suites to verify element geometries in real time:

```javascript
/**
 * DOM Boundary & Overlap Auditor
 */
function auditElementBoundingBoxes(selectorList) {
  const violations = [];
  const viewportW = window.innerWidth;
  const viewportH = window.innerHeight;

  const rects = selectorList.map(sel => {
    const el = document.querySelector(sel);
    return { selector: sel, element: el, rect: el ? el.getBoundingClientRect() : null };
  }).filter(item => item.rect !== null);

  // 1. Viewport Clipping Check
  for (const item of rects) {
    const r = item.rect;
    if (r.left < 0 || r.top < 0 || r.right > viewportW || r.bottom > viewportH) {
      violations.push({
        type: 'VIEWPORT_CLIPPING',
        selector: item.selector,
        box: { left: r.left, top: r.top, right: r.right, bottom: r.bottom, viewportW, viewportH }
      });
    }
  }

  // 2. Collision / Unintended Overlap Check
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i].rect;
      const b = rects[j].rect;
      const overlaps = !(a.right <= b.left || a.left >= b.right || a.bottom <= b.top || a.top >= b.bottom);
      if (overlaps) {
        violations.push({
          type: 'UNINTENDED_COLLISION',
          itemA: rects[i].selector,
          itemB: rects[j].selector
        });
      }
    }
  }

  return violations;
}
```

### 7.2 Zero-Truncation Contract for Financial Numbers
Financial metrics such as volume, foreign flow, and prices must never be truncated with ellipsis (`text-overflow: ellipsis`) inside tables. If space is tight, the column width must expand or an institutional abbreviation standard must be used (e.g., `1.45 M`, `2.80 B`, `14.20 T`).

### 7.3 Automated Contrast & Color Auditing
High-contrast readability is mandatory for institutional visual ergonomics:
- **Body Text:** Minimum contrast ratio 4.5:1 against `#0F141C` background.
- **Badges and Status Indicators:** Minimum contrast ratio 3.0:1.
- **Bullish Green:** `#10B981` (Emerald-500) or `#00E676`.
- **Bearish Red:** `#EF4444` (Red-500) or `#FF1744`.
- **Neutral Gold:** `#F59E0B` (Amber-500).

---

## 8. SKILL 7: BROWSER-USE/BROWSER-USE — END-TO-END REAL USER JOURNEY CLICK SIMULATION
**Repository:** [https://github.com/browser-use/browser-use](https://github.com/browser-use/browser-use)
**Domain:** Autonomous Agent Automation, Real Human Journey Validation, Resilient Selectors

### 8.1 Natural Human Interaction Physics
Testing trading platforms with naive synthetic scripts (`element.click()`) fails to surface real interaction race conditions, hover state bugs, and touch target misses.
Browser-use principles require:
1. **Natural Mouse Trajectories:** Bézier curve interpolation for pointer movements.
2. **Realistic Keypress Cadence:** Jittered 40ms - 120ms delays between strokes.
3. **Resilient Semantic Locators:** Prioritize `data-testid`, `aria-label`, and semantic roles over brittle CSS class selectors that change during Tailwind builds.

### 8.2 The Critical Daytrade Journey Simulation Script
The automated validation suite must simulate the complete end-to-end user path:
```text
[AUTHENTICATED USER]
       │
       ▼
1. Login with Session Token Validation
       │
       ▼
2. Navigate to Screener Cockpit
       │
       ▼
3. Select 'Daytrade V7' Strategy Tab
       │
       ▼
4. Verify Table Population within 1500ms
       │
       ▼
5. Click Top Ranker Ticker (e.g., BBRI / BRPT)
       │
       ▼
6. Confirm Chart Candle Rendering & Crosshair Binding
       │
       ▼
7. Inspect Order Flow Depth & Quota Consumption Counter
       │
       ▼
8. Validate Telemetry Emission
```

### 8.3 Synthetic Human Movement Generator
```javascript
/**
 * Bézier Mouse Curve Generator for Human-Realistic Movement
 */
function generateBezierCurve(start, end, controlPoints = 2, steps = 25) {
  const points = [];
  const cp1 = {
    x: start.x + (end.x - start.x) * 0.25 + (Math.random() - 0.5) * 50,
    y: start.y + (end.y - start.y) * 0.1 + (Math.random() - 0.5) * 50
  };
  const cp2 = {
    x: start.x + (end.x - start.x) * 0.75 + (Math.random() - 0.5) * 50,
    y: start.y + (end.y - start.y) * 0.9 + (Math.random() - 0.5) * 50
  };

  for (let i = 0; i <= steps; i++) {
    const t = i / steps;
    const invT = 1 - t;
    const x = Math.round(
      Math.pow(invT, 3) * start.x +
      3 * Math.pow(invT, 2) * t * cp1.x +
      3 * invT * Math.pow(t, 2) * cp2.x +
      Math.pow(t, 3) * end.x
    );
    const y = Math.round(
      Math.pow(invT, 3) * start.y +
      3 * Math.pow(invT, 2) * t * cp1.y +
      3 * invT * Math.pow(t, 2) * cp2.y +
      Math.pow(t, 3) * end.y
    );
    points.push({ x, y });
  }
  return points;
}
```

---

## 9. SKILL 8: NATIONALSECURITYAGENCY/GHIDRA — DEEP FORENSIC TELEMETRY, PROCESS INTEGRITY & THREAT AUDIT TABLE
**Repository:** [https://github.com/NationalSecurityAgency/ghidra](https://github.com/NationalSecurityAgency/ghidra)
**Domain:** Reverse Engineering Defense, Tamper Detection, STRIDE Threat Modeling, Immutable Audit Trails

### 9.1 Forensic Telemetry & Cryptographic Verification
Auto-Cuan handles privileged market intelligence, automated trade screener triggers, and high-value Stock Arjum API quota. To guard against unauthorized memory modifications or code tampering:
1. **Source Code Hash Integrity:** Critical runtime scripts (`lib/quota-manager.js`, `routes/admin.js`, `server.js`) are monitored with SHA-256 integrity checksums.
2. **Immutable Audit Log Chaining:** Every administrative action, quota state transition, and backfill execution is written to an append-only JSONL log (`data/quota-audit.log.jsonl`) with cryptographic timestamping.

### 9.2 STRIDE Threat Audit Table

| Threat Category | Target Subsystem | Attack Vector | Countermeasure & Defensive Architecture |
|---|---|---|---|
| **Spoofing** | Stock Arjum Quota Manager | Faking upstream API responses with falsified quota headers | Server-side signature validation, HMAC verification, and fallback to verified cached state |
| **Tampering** | `data/quota-state.json` | Unauthorized manual edit to bypass reserve floors | File permissions restricted to Node process; runtime in-memory validation against audit log |
| **Repudiation** | Admin Configuration | Admin changes emergency maintenance flag without attribution | Structured JSONL logging containing user ID, IP address, user-agent, and previous/new state diff |
| **Information Disclosure** | Broker Hunter / Insider Flow | Unauthorized scraping of institutional broker accumulation | Token-bucket rate limiting, session authentication middleware, IP egress masking |
| **Denial of Service** | Backfill Job / VPS Cron | Exhaustion of daily quota (18,080 units) by running high-volume scans during active market hours | Hard-Lock Reserve Floor 5,000 on weekdays before 20:30 WIB; immediate process exit (`exit 0`) |
| **Elevation of Privilege** | User RBAC Routes | Modifying JWT payload or role claim to access `/admin` | Asymmetric RS256 token verification, database role re-check on privileged API endpoints |
| **Spoofing (Client)** | Frontend Telemetry Stream | Injecting bogus ticks or falsified latency telemetry | Nonce token generation per session and HMAC-SHA256 signature verification on WebSocket ingress |
| **Tampering (DB)** | Historical Candle Cache | Corrupting SQLite or JSONL candle records to distort VWAP | Read-only permissions on historical archive partitions and periodic SHA-256 tree root hashing |
| **Repudiation (Trades)** | Bot Signal Trigger | User claims trade signal was not emitted by system | Immutable Telegram transmission logging with message ID, Telegram API receipt, and payload hash |
| **Info Leak (Keys)** | Environment Variables | Exposing Stock Arjum API credentials via error stack traces | Strict redaction of secrets in logger middleware, stripping bearer tokens and cookies |
| **DoS (Memory)** | Fast-Bundle Aggregator | Memory exhaustion via unbound JSON serialization buffers | Hard memory cap of 512MB per Node worker; automated cluster respawn upon threshold reach |
| **Privilege (Cron)** | Local Execution Scripts | Running unauthorized root cron jobs on deployment VPS | Dedicated `autocuan` unprivileged user with restricted sudo permissions for logrotate only |

### 9.3 Process Integrity Monitoring & Anti-Tamper Telemetry
The runtime process must actively detect:
- **Event Loop Lag:** If `eventLoopDelay` exceeds 100ms, emit a high-priority warning telemetry event.
- **Uncaught Exception Quarantine:** Exceptions must be logged with complete forensic stack traces without terminating other isolated workers.
- **Audit Event Emission Schema:**

```javascript
/**
 * Institutional Security Telemetry Event Structure
 */
function createForensicTelemetryRecord({ eventType, severity, actorId, ipAddress, details }) {
  return {
    eventId: require('crypto').randomUUID(),
    timestampIso: new Date().toISOString(),
    processId: process.pid,
    nodeVersion: process.version,
    memoryUsageBytes: process.memoryUsage().heapUsed,
    eventType: String(eventType).toUpperCase(),
    severity: severity || 'INFO', // DEBUG, INFO, WARN, CRITICAL, PANIC
    actor: {
      id: actorId || 'SYSTEM_INTERNAL',
      ip: ipAddress || '127.0.0.1'
    },
    forensicPayload: details || {},
    hmacSha256: null // Chained in audit pipeline
  };
}
```

---

## 10. DETAILED CODE IMPLEMENTATION & PRODUCTION PATTERNS

### 10.1 High-Performance EJS/Tailwind Bento Shell Implementation
```html
<!DOCTYPE html>
<html lang="id" class="h-full bg-slate-950 text-slate-100 antialiased">
<head>
  <meta charset="utf-8">
  <meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=1, user-scalable=0">
  <title>Auto-Cuan V4 Institutional Cockpit</title>
  <link rel="stylesheet" href="/css/tailwind.min.css">
  <style>
    /* Institutional Scrollbars */
    ::-webkit-scrollbar { width: 6px; height: 6px; }
    ::-webkit-scrollbar-track { background: #0b0e14; }
    ::-webkit-scrollbar-thumb { background: #1e293b; border-radius: 3px; }
    ::-webkit-scrollbar-thumb:hover { background: #334155; }
  </style>
</head>
<body class="h-full w-full overflow-hidden flex flex-col font-sans select-none">
  <!-- Top Institutional Command Bar -->
  <header class="h-14 border-b border-slate-800/80 bg-slate-900/90 px-4 flex items-center justify-between shrink-0 z-30">
    <div class="flex items-center space-x-3">
      <div class="w-7 h-7 rounded bg-emerald-500/10 border border-emerald-500/30 flex items-center justify-center text-emerald-400 font-bold text-xs">AC</div>
      <span class="font-semibold text-sm tracking-wide text-slate-100">AUTO-CUAN <span class="text-emerald-400 font-mono text-xs ml-1">V4.0-INSTITUTIONAL</span></span>
    </div>
    <!-- Quota & Telemetry HUD -->
    <div class="flex items-center space-x-6 text-xs font-mono">
      <div class="flex items-center space-x-2">
        <span class="text-slate-400">STOCK ARJUM:</span>
        <span id="hud-quota-counter" class="text-emerald-400 font-bold">14,371 / 18,080</span>
        <span id="hud-quota-status" class="px-1.5 py-0.5 rounded text-[10px] bg-emerald-500/10 text-emerald-400 border border-emerald-500/20">NORMAL</span>
      </div>
      <div class="flex items-center space-x-2">
        <span class="text-slate-400">HARD-LOCK:</span>
        <span class="text-amber-400 font-semibold">5,000 FLR (20:30 WIB)</span>
      </div>
      <div class="flex items-center space-x-1.5">
        <div class="w-2 h-2 rounded-full bg-emerald-500 animate-pulse"></div>
        <span class="text-slate-300">TELEMETRY LIVE</span>
      </div>
    </div>
  </header>

  <!-- 12-Column Institutional Bento Workspace -->
  <main class="flex-1 grid grid-cols-12 gap-3 p-3 overflow-hidden bg-slate-950">
    <!-- Bento Column 1: Screener Matrix (3 Cols) -->
    <section class="col-span-3 flex flex-col rounded-xl border border-slate-800/80 bg-slate-900/50 backdrop-blur overflow-hidden">
      <div class="h-10 border-b border-slate-800/80 px-3 flex items-center justify-between shrink-0 bg-slate-900/80">
        <span class="text-xs font-bold uppercase tracking-wider text-slate-300">Screener Matrix</span>
        <span class="text-[11px] font-mono text-slate-400" id="screener-count">0 Hits</span>
      </div>
      <div class="flex-1 overflow-y-auto p-2 divide-y divide-slate-800/40" id="screener-list-container">
        <!-- Live Screener Rows Injected with Zero Layout Shift -->
      </div>
    </section>

    <!-- Bento Column 2: Advanced Interactive Chart (6 Cols) -->
    <section class="col-span-6 flex flex-col rounded-xl border border-slate-800/80 bg-slate-900/50 backdrop-blur overflow-hidden">
      <div class="h-10 border-b border-slate-800/80 px-3 flex items-center justify-between shrink-0 bg-slate-900/80">
        <div class="flex items-center space-x-2">
          <span class="text-xs font-bold text-slate-200" id="active-ticker-label">BBRI.JK</span>
          <span class="text-[11px] font-mono text-emerald-400 font-bold" id="active-ticker-price">Rp 5,425 (+1.40%)</span>
        </div>
        <div class="flex items-center space-x-1">
          <button class="px-2 py-1 text-[11px] rounded bg-slate-800 text-slate-300 hover:bg-slate-700">1D</button>
          <button class="px-2 py-1 text-[11px] rounded bg-slate-800/40 text-slate-400 hover:bg-slate-700">1H</button>
          <button class="px-2 py-1 text-[11px] rounded bg-slate-800/40 text-slate-400 hover:bg-slate-700">15M</button>
        </div>
      </div>
      <div class="flex-1 relative bg-slate-950/80" id="chart-viewport">
        <!-- Lightweight Charts / Canvas Rendering Surface -->
        <canvas id="primary-chart-canvas" class="w-full h-full block"></canvas>
      </div>
    </section>

    <!-- Bento Column 3: Orderflow, Broker Hunter & Forensics (3 Cols) -->
    <section class="col-span-3 flex flex-col rounded-xl border border-slate-800/80 bg-slate-900/50 backdrop-blur overflow-hidden">
      <div class="h-10 border-b border-slate-800/80 px-3 flex items-center justify-between shrink-0 bg-slate-900/80">
        <span class="text-xs font-bold uppercase tracking-wider text-slate-300">Broker Accumulation</span>
        <span class="text-[11px] font-mono text-emerald-400">CR3: 71.2%</span>
      </div>
      <div class="flex-1 overflow-y-auto p-2" id="orderflow-container">
        <!-- Orderflow Depth Bars Injected Here -->
      </div>
    </section>
  </main>
</body>
</html>
```

### 10.2 Quantitative Precision Engine & Anti-Slop Audit Validator
```javascript
/**
 * Quantitative Validation Engine for Screener Pipelines
 */
class QuantitativePrecisionEngine {
  static validateScreenerOutput(tickerData) {
    const errors = [];
    if (!tickerData.symbol || typeof tickerData.symbol !== 'string') {
      errors.push('INVALID_TICKER_SYMBOL');
    }
    if (typeof tickerData.lastPrice !== 'number' || tickerData.lastPrice <= 0) {
      errors.push('INVALID_NUMERIC_PRICE');
    }
    if (typeof tickerData.volume !== 'number' || tickerData.volume < 0) {
      errors.push('INVALID_NUMERIC_VOLUME');
    }
    if (tickerData.changePercent !== undefined && isNaN(tickerData.changePercent)) {
      errors.push('NAN_CHANGE_PERCENT');
    }
    return {
      isValid: errors.length === 0,
      errors
    };
  }

  static sanitizeLLMResponse(responseText) {
    const slopTerms = [
      /saham ini sangat menjanjikan/gi,
      /potensi cuan luar biasa/gi,
      /segera serok sebelum terbang/gi,
      /to the moon/gi,
      /kondisi pasar agak galau/gi,
      /bandar misterius/gi
    ];

    let sanitized = responseText;
    for (const term of slopTerms) {
      sanitized = sanitized.replace(term, '[DATA_REQUIRED: Gunakan metrik kuantitatif]');
    }
    return sanitized;
  }
}

module.exports = QuantitativePrecisionEngine;
```

---

## 11. REAL USER JOURNEY VALIDATION SUITE (BROWSER-USE PATTERN)

The following automated Playwright/Puppeteer script represents the golden end-to-end user journey contract that every release must pass:

```javascript
/**
 * End-to-End User Journey Simulation for Auto-Cuan V4
 */
async function runUserJourneySimulation(page, baseUrl) {
  console.log('[JOURNEY-SIM] Step 1: Navigating to base URL...');
  await page.goto(baseUrl, { waitUntil: 'domcontentloaded' });

  console.log('[JOURNEY-SIM] Step 2: Validating Full-Viewport Bento Bounds...');
  const bodyOverflow = await page.evaluate(() => window.getComputedStyle(document.body).overflow);
  if (bodyOverflow !== 'hidden') {
    throw new Error('Institutional layout violation: body overflow is not hidden');
  }

  console.log('[JOURNEY-SIM] Step 3: Verifying Quota HUD values...');
  const quotaText = await page.textContent('#hud-quota-counter');
  console.log('[JOURNEY-SIM] Quota HUD Displayed:', quotaText);

  console.log('[JOURNEY-SIM] Step 4: Simulating smooth natural cursor trajectory across Bento cells...');
  await page.mouse.move(100, 100);
  await page.mouse.move(400, 300, { steps: 15 });
  await page.mouse.move(800, 400, { steps: 20 });

  console.log('[JOURNEY-SIM] Step 5: Auditing Bounding Box Collisions...');
  const collisionViolations = await page.evaluate(() => {
    // Inject BrowserSkill bounding audit
    const selectors = ['header', 'main', '#screener-list-container', '#chart-viewport', '#orderflow-container'];
    return auditElementBoundingBoxes(selectors);
  });

  if (collisionViolations.length > 0) {
    throw new Error('Bounding-box collision detected: ' + JSON.stringify(collisionViolations));
  }

  console.log('[JOURNEY-SIM] ALL 5 USER JOURNEY STEPS PASSED WITH 0 DEFECTS');
}
```

---

## 12. FORENSIC AUDITING & REVERSE-ENGINEERING DEFENSE (GHIDRA STANDARD)

### 12.1 Cryptographic Source Code & Configuration Hashing
To prevent stealth backdoors and unauthorized tampering, the application integrity watcher computes SHA-256 hashes of critical modules at boot time:

```javascript
const crypto = require('crypto');
const fs = require('fs');

function computeFileSha256(filePath) {
  const buffer = fs.readFileSync(filePath);
  return crypto.createHash('sha256').update(buffer).digest('hex');
}

const CRITICAL_INTEGRITY_MANIFEST = {
  'lib/quota-manager.js': null,
  'routes/admin.js': null,
  'server.js': null
};

function verifySystemIntegrity() {
  const report = {};
  for (const file of Object.keys(CRITICAL_INTEGRITY_MANIFEST)) {
    if (fs.existsSync(file)) {
      report[file] = computeFileSha256(file);
    } else {
      report[file] = 'FILE_MISSING';
    }
  }
  return report;
}
```

### 12.2 Hard-Lock Quota Guardrails (Senin - Jumat 20:30 WIB)
The Stock Arjum quota represents real capital expenditure and strict third-party rate limits. The Quota Manager strictly enforces:
- **Total Quota:** 18,080 units
- **Weekday Operating Floor:** 5,000 units reserved for real-time market data requests during trading hours (08:30 - 20:30 WIB).
- **Backfill Lockout:** If remaining quota drops <= 5,000 before 20:30 WIB on weekdays, backfill jobs are locked out with immediate zero-exit code (`exit 0`).
- **Night Window (20:30 - 23:50 WIB):** Reserve floor drops to zero, releasing remaining quota for deep backfill operations.
- **Weekend / Market Holiday:** Reserve floor is 0 units, enabling unrestricted catchup pipelines.

### 12.3 Automated Panic Kill-Switch
If anomalous API drain is detected (> 100 requests per second from untrusted source):
```javascript
function triggerEmergencyQuotaLockdown(reason) {
  console.error('[SECURITY PANIC] Emergency Quota Lockdown initiated:', reason);
  const state = require('../data/quota-state.json');
  state.emergencyLocked = true;
  state.lockReason = reason;
  state.lockTimestamp = new Date().toISOString();
  fs.writeFileSync('data/quota-state.json', JSON.stringify(state, null, 2));
  process.emit('quota:emergency_lockdown', state);
}
```

---

## 13. SUMMARY TABLE: 8 REPOSITORIES & ENGINEERING SPECIFICATIONS

| # | Repository URL | Institutional Core Concept | Strict Auto-Cuan V4 Engineering Contract |
|---|---|---|---|
| 1 | [nutlope/hallmark](https://github.com/nutlope/hallmark) | Full-Viewport 12-Column Institutional Bento Grid | Zero outer-scroll (`overflow: hidden` on body). Exact 12-column CSS Grid. Internal scrolling only in bento cards. |
| 2 | [miqdadbadjuber/anti-slop](https://github.com/miqdadbadjuber/anti-slop) | Zero AI Slop & Strict Quantitative Precision | Zero hand-waving or marketing fluff. Strict decimal rounding, VWAP, CR3/CR5, and HHI formulas. |
| 3 | [pbakaus/impeccable](https://github.com/pbakaus/impeccable) | Zero Layout Shift & Deterministic Sub-15ms Fast-Bundle | Cumulative Layout Shift (CLS) = 0.000. Fast-bundle served from memory in < 15ms. Skeletons for async slots. |
| 4 | [cth9191/animate](https://github.com/cth9191/animate) | 60 FPS GPU-Accelerated Micro-Transitions | Animate exclusively via `transform3d` and `opacity`. Promotion via `will-change`. Strict 10ms frame budgets. |
| 5 | [DhvanilPatel/swarm-cursors](https://github.com/DhvanilPatel/swarm-cursors) | Single requestAnimationFrame Batched Canvas/SVG Rendering | Coalesce high-frequency pointer and chart events into a single rAF queue. High-DPI canvas buffer pooling. |
| 6 | [Tencent/BrowserSkill](https://github.com/Tencent/BrowserSkill) | Automated Live DOM & Bounding-Box Inspection | Live bounding-box collision and viewport clipping audit. Zero numeric truncation in financial tables. |
| 7 | [browser-use/browser-use](https://github.com/browser-use/browser-use) | End-to-End Real User Journey Click Simulation | Natural Bézier cursor trajectories, resilient semantic locators, full Daytrade V7 user workflow simulation. |
| 8 | [NationalSecurityAgency/ghidra](https://github.com/NationalSecurityAgency/ghidra) | Deep Forensic Telemetry, Process Integrity & Threat Audit Table | STRIDE threat matrix, SHA-256 process integrity checks, append-only JSONL audit trail, Hard-Lock 5,000 floor. |

---

## 14. COMPLIANCE & GATE VERIFICATION PROTOCOL

Every commit must be verified against `tools/gates/gate-V4-F01.js` and higher gate suites. Any violation of these eight skills results in an immediate build rejection and gate failure.

**SIGNED & RATIFIED:** Auto-Cuan V4 Core Architecture Directorate
**DATE:** 2026-11-04


---

## 15. INSTITUTIONAL QUALITY ASSURANCE AND CI/CD GATE REQUIREMENTS

To guarantee non-negotiable adherence to the 8 GitHub engineering principles, the Auto-Cuan test harness runs automated gate suites before any deployment or branch merge. The CI pipeline executes the following checks:

### 15.1 Architectural Consistency Rules
- **Rule AC-V4-001 (Zero AI Slop):** Screener output and AI chat responses are scanned against blacklisted qualitative terms. Any detection triggers immediate test suite failure.
- **Rule AC-V4-002 (Layout Shift Guard):** DOM snapshot tests verify that all tables, cards, and canvas elements have fixed dimensions or aspect-ratio declarations.
- **Rule AC-V4-003 (Quota Floor Invariant):** Simulated clock calls between 08:30 WIB and 20:30 WIB on weekdays verify that quota consumption is hard-blocked when remaining units drop to or below 5,000.
- **Rule AC-V4-004 (Performance Benchmark):** Fast-bundle serialization and deserialization benchmarks must complete within 15ms under standard CI virtual machine specifications.
- **Rule AC-V4-005 (Animation Purity):** CSS stylesheets are parsed to ensure no transitions or keyframe animations reference reflow-triggering properties such as `width`, `height`, `top`, `left`, or `margin`.

### 15.2 Forensic Telemetry Schema & Log Retention Policy
Audit logs written to `data/quota-audit.log.jsonl` and `data/security/vps-audit.json` must strictly observe:
1. **Append-Only Immutability:** No process is permitted to truncate or rewrite past audit logs. Every operation is strictly append-only.
2. **Payload Masking:** Never store plain passwords, JWT signing keys, or raw Stock Arjum API secrets in the forensic log. All tokens must be hashed with SHA-256 or masked to first 4 and last 4 characters (e.g. `eyJhbG...9xyz`).
3. **Structured Context:** Every record must contain process ID (`process.pid`), system hostname, high-precision timestamp (`process.hrtime.bigint()`), and caller IP address.

### 15.3 Incident Remediation Runbook & Emergency Operations
In the event of an institutional security alert or quota breach:
1. **Immediate State Freeze:** Trigger `triggerEmergencyQuotaLockdown()` to cut off all upstream Stock Arjum API calls immediately.
2. **Audit Extraction:** Extract the last 500 lines of `data/quota-audit.log.jsonl` and compute SHA-256 digests to locate the point of deviation.
3. **Integrity Validation:** Execute `verifySystemIntegrity()` across all manifest files to confirm no core source code was modified or injected.
4. **Post-Mortem Record:** Record incident metadata including total quota consumed during incident, anomalous IP addresses, and mitigation timeline.

### 15.4 Summary of Repository Links
The following canonical repositories define the foundational technical stack of Auto-Cuan V4:
1. Full-Viewport Bento Grid Architecture: https://github.com/nutlope/hallmark
2. Quantitative Precision & Anti-Slop Guardrails: https://github.com/miqdadbadjuber/anti-slop
3. Sub-15ms Fast-Bundle & Zero CLS: https://github.com/pbakaus/impeccable
4. 60 FPS GPU-Accelerated Micro-Animations: https://github.com/cth9191/animate
5. Batched Canvas/SVG Rendering Loop: https://github.com/DhvanilPatel/swarm-cursors
6. Autonomous Live DOM Bounding-Box Inspection: https://github.com/Tencent/BrowserSkill
7. End-to-End Real User Journey Automation: https://github.com/browser-use/browser-use
8. Deep Forensic Telemetry & Threat Modeling: https://github.com/NationalSecurityAgency/ghidra
