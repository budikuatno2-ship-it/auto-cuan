# Auto-Cuan DESIGN.md — FINAL v1.1

> **Status:** FINAL — frozen design and interaction contract for implementation planning  
> **Product:** Auto-Cuan  
> **Direction:** Financial Intelligence Workstation  
> **Primary theme:** Light-first  
> **Frontend architecture:** Existing vanilla HTML/CSS/JavaScript SPA  
> **Planning baseline audited:** `feat/daytrade-screener-v1` @ `d1375e3ed4ba02d2555265f753b96a629f10e7dc`  
> **v1.0 frozen:** 2026-10-04  
> **v1.1 candidate prepared:** 2026-10-04  
> **Authority:** Canonical source of truth for the Auto-Cuan redesign. When older visual documents or legacy CSS conflict with this document, this document governs the target visual/interaction system. Existing production behavior, security, data semantics, and API contracts remain authoritative until a deliberate migration is approved and regression-tested.  
> **Important:** This document does **not** authorize repository edits. Repository mutation still requires explicit user approval. Implementation begins only after explicit user approval and a fresh read-only baseline check.

---

## 1. Product Identity

Auto-Cuan is a calm, precise financial intelligence workstation for Indonesian equities.

It combines market discovery, screening, broker-flow research, market-structure evidence, financial context, AI-assisted interpretation, monitoring, portfolio planning, risk analysis, and historical signal auditing.

Auto-Cuan must feel like a serious research instrument. It must **not** feel like a crypto casino, a neon trading terminal, a generic AI dashboard, a generic SaaS admin panel, a collection of unrelated feature cards, or a marketing website wrapped around financial tables.

The product personality is:

1. Precise
2. Calm
3. Informed
4. Dense when the task requires density
5. Transparent about data state
6. Fast to scan
7. Deliberate rather than decorative

Working visual mix:

- 70% precision financial workstation
- 20% premium editorial finance
- 10% motion and personality

Primary reference principles:

- **Ramp** — financial clarity and disciplined surfaces
- **Superhuman** — rhythm and product storytelling
- **Public** — financial/editorial intelligence
- **Linear** — navigation precision and product hierarchy
- **Rows** — dense data presentation
- **Brex / Column** — financial credibility and provenance

References inform principles. Do not clone any reference product.

---

## 2. Core Design Principles

### 2.1 Data is the product

Visual styling must support the data, not compete with it. Prefer alignment, typography, spacing, hairline dividers, semantic values, and clear hierarchy before introducing cards, shadows, gradients, illustrations, or animation.

### 2.2 Continuous workspace over card wall

Prefer continuous work areas, data bands, tables, and master-detail surfaces over isolated floating cards.

A card is used only when an object genuinely needs a visual boundary.

Grouping priority:

**alignment → spacing → hairline divider → tonal surface change → card only when necessary**

### 2.3 Hairline before shadow

Borders and tonal differences establish most hierarchy. Shadow communicates actual elevation only for dialog, popover, floating detail surface, command palette, or exceptional raised control.

### 2.4 Brand color and financial meaning are separate

Emerald represents Auto-Cuan and interactive selection. Financial positive values use a separate semantic green. A positive stock movement must not be visually indistinguishable from a selected navigation item or primary CTA.

### 2.5 Trust is part of the interface

Critical data surfaces should make value, period, source, freshness, and completeness/availability discoverable. Do not hide provenance in legal footers.

### 2.6 Missing data is meaningful

Never silently transform:

- missing → zero
- unknown → negative
- pending → failed
- unavailable → bearish
- saved plan → executed broker position
- system signal → user investment return

### 2.7 Motion explains change

Motion exists to indicate state changes, preserve navigation continuity, communicate data updates, explain spatial relationships, or support landing-page storytelling. Motion does not exist simply to make the product look alive.

### 2.8 Real product over fake product

Do not invent fake live counters, fake customer logos, fake testimonials, fake performance claims, fake AI confidence, or fake real-time data.

---

## 3. Non-Goals & Hard Product Boundaries

The redesign must not rewrite business logic, screening formulas, scoring, ranking semantics, trade-entry logic, risk calculations, broker interpretations, HSC/Free Float semantics, authentication/security logic, subscription entitlement, data provenance, or missing-value semantics. It must not introduce a framework migration merely for UI components.

### 3.1 DeepScan

DeepScan is permanently removed from the target product UI. Historical references in documentation, data notes, tests, or migration logs are not proof that DeepScan should return.

### 3.2 Kelola Keuangan / Money Management

Kelola Keuangan is **not part of the target Auto-Cuan product experience**.

It must not appear in global navigation, mobile More, command search, landing, account, onboarding, or dashboard shortcuts.

Existing code, storage, tests, migration artifacts, or database schema may still exist and must be audited before removal. **Visual retirement of this feature must never delete user data or database schema automatically.**


### 3.3 Deprecated Route Invariant

Current deprecated/dormant routes must not be revived as a side effect of redesign.

In particular:

- `/subscription` remains non-primary/dormant until a separate product rollout explicitly enables it;
- `/kelola-keuangan` / Money Management must not be promoted back into active navigation;
- DeepScan must not return as a product destination;
- obsolete aliases must not be remapped to unrelated new features merely to avoid a 404.

Legitimate analysis aliases such as broker-summary / Bandarmologi compatibility routes may remain until deliberately migrated.

### 3.4 Implementation Classification

Every design requirement belongs to one of three implementation classes:

**A — Visual refactor (default)**  
Tokens, typography, density, spacing, borders, surface treatment, table styling, responsive presentation, copy hierarchy, and non-behavioral motion.

**B — Interaction migration (requires explicit implementation plan and regression coverage)**  
Examples: shared ticker context, replacement mobile bottom navigation, promoted Research destinations, detail-pane behavior, Account Center re-grouping, View Transition integration.

**C — Product enhancement (must not be smuggled into a styling wave)**  
Examples: a new command palette/global action search, new alert types, new financial datasets, new AI capabilities, new payment flow, or new monitoring logic.

A coding agent must not implement Class C merely because this document describes a desirable future interaction.

---

## 4. Foundations

### 4.1 Canonical Light Theme

Light mode is the canonical Auto-Cuan identity.

```css
:root {
  --ac-canvas: #F3F5F4;
  --ac-surface: #FFFFFF;
  --ac-surface-raised: #F8FAF9;
  --ac-surface-hover: #EEF2F0;

  --ac-ink: #17211E;
  --ac-text-secondary: #52605B;
  --ac-text-muted: #5F6C66;
  --ac-text-tertiary: var(--ac-text-muted);

  --ac-line-hairline: #E2E7E4;
  --ac-line-default: rgba(18, 35, 29, 0.14);
  --ac-line-strong: rgba(18, 35, 29, 0.20);
  --ac-control-border: #7D8683;
  --ac-control-border-hover: #65726C;

  --ac-brand: #0F7458;
  --ac-brand-hover: #0B6049;
  --ac-brand-soft: #E8F3EE;
  --ac-focus: #0F7458;

  --ac-positive: #247A43;
  --ac-positive-soft: rgba(36, 122, 67, 0.09);

  --ac-negative: #C13F4D;
  --ac-negative-soft: rgba(193, 63, 77, 0.09);

  --ac-warning: #A96D13;
  --ac-warning-text: #96610F;
  --ac-warning-soft: rgba(169, 109, 19, 0.09);

  --ac-info: #315F9A;
  --ac-info-soft: rgba(49, 95, 154, 0.09);

  /* System-state aliases keep financial semantics separate in code,
     even when the initial visual value is shared. */
  --ac-success: #247A43;
  --ac-danger: #C13F4D;
}
```

Color semantics:

- Brand emerald: primary action, active navigation, selected state, product identity
- Positive green: positive P/L, price movement, flow, genuine financial improvement
- Negative red: losses, negative movement, actual destructive/error state
- Amber: caution, freshness concern, risk attention, partial/incomplete state where appropriate
- Blue: informational context and provenance

Color reinforces meaning. Color is never the only carrier of meaning.

Contrast requirements for text and essential UI are not optional:

- normal text: target WCAG AA ≥ 4.5:1;
- large text: ≥ 3:1;
- focus indicators and essential non-text UI boundaries: ≥ 3:1 against adjacent colors.

The earlier tertiary/muted split was not visually meaningful enough and could fall below the normal-text target on selected/hover surfaces. The canonical small-supporting-text token is now `--ac-text-muted: #5F6C66`; `--ac-text-tertiary` is only a compatibility alias to that same token. Evidence metadata uses `--ac-text-secondary`, not muted.

`--ac-positive` is intentionally shifted to `#247A43` so financial-positive meaning is visibly distinct from brand/selection emerald `#0F7458`.

`--ac-warning` remains an accent/icon/border color; warning body text uses the darker `--ac-warning-text`. Decorative hairlines may be intentionally subtle, but essential interactive boundaries must use `--ac-control-border` (or a stronger semantic/focus boundary), not the low-contrast hairline token.

Focus indicators may use the brand hue, but they must remain visible on brand-filled controls through a physical gap (`outline-offset` / equivalent dual-ring spacing). A primary button must never visually merge with its own focus indicator.

### 4.2 Dark Mode

Light mode is the canonical redesign target. Existing dark-theme behavior must not be broken or silently removed during a visual-refactor wave. If dark mode remains supported, treat it as **Night Research Mode**, not the core brand identity. It must remain matte, restrained, low-glow, and data-first. No neon green, purple identity, cyan terminal aesthetics, excessive glow, background grids, or cyberpunk treatment.

Full visual parity for a redesigned dark theme is a separate scope decision; preserving existing theme access is the migration-safety default until explicit product approval says otherwise.

---

## 5. Typography

Typography has three functional roles.

### 5.1 Display

Used primarily for landing hero and major editorial statements. Character: confident, refined, slightly editorial, not ornamental.

- Desktop hero: 52–64px
- Mobile hero: 36–44px
- Large editorial section: 36–48px

### 5.2 Functional Sans

Primary UI typeface.

| Role | Size |
|---|---:|
| Page title | 28–32px |
| Section title | 20–24px |
| Component title | 16–18px |
| Body | 14–16px |
| Dense UI | 13–14px |
| Table | 12–13px |
| Evidence metadata | ≥12px |
| Auxiliary metadata | 11–12px |

Evidence metadata includes Source, As-of, Updated, data-quality, and other trust-bearing context. It must use at least `--ac-text-secondary`, not the weakest muted treatment.

Auxiliary metadata may use the muted token when it is not required to establish data trust.

Avoid oversized typography inside the authenticated workstation.

### 5.3 Technical / Mono

Use sparingly for verification codes, IDs, source codes, aligned timestamps, and technical metadata. Do not make the whole app monospace.

### 5.4 Font Dependency Policy

The existing Inter/system-sans implementation is the baseline. Do not introduce a new webfont merely to make the redesign look different. Landing personality should first come from size, weight, tracking, spacing, and composition. A new display font requires separate approval plus loading/performance and layout-regression review.

---

## 6. Financial Numerals

Financial values must support tabular alignment.

```css
font-variant-numeric: tabular-nums lining-nums;
```

Apply to prices, percentages, P/L, market cap, PBV, BVPS, flow values, portfolio exposure, risk amounts, entry/stop/targets, and numeric table columns.

Right-align numeric table columns where appropriate. Keep textual financial signs (`+`/`-`) so color is reinforcement, not the only cue.


### 6.1 Locale, Units & Formatting

User-facing formatting is Indonesian-first:

- currency: IDR / `Rp` using `id-ID` grouping;
- operational timezone: `Asia/Jakarta` / WIB when freshness or scheduling matters;
- compact dates may use `2 Okt 2026`;
- explanatory/legal dates may use `2 Oktober 2026`;
- percentages use Indonesian decimal punctuation (for example `41,82%`) and preserve sign where directional meaning matters;
- unknown numeric values render as `—` / explicit unavailable state, never fabricated zero;
- animated NumberFlow values and static values use the **same formatter and options** for the same component.

Canonical compact-unit language:

- `jt` = juta;
- `M` = miliar;
- `T` = triliun;
- `lot` = lot;
- `lembar` = shares/lembar saham.

`lot` and `lembar` are never interchangeable. A formatter must not abbreviate a share count as a lot count or vice versa.

Do not mix US decimal/grouping conventions, English month abbreviations, or ambiguous `M = million` semantics into the same Indonesian financial surface.

### 6.2 Freshness Vocabulary

Freshness labels derive from the actual data contract **and market-session context** of the surface.

Use terms such as:

- Live / real-time — only when the source contract explicitly supports it;
- Intraday — when the source is current-session but not guaranteed real-time;
- EOD / T-1 — for end-of-day snapshots;
- Diperbarui [waktu/tanggal] — safe default when exact freshness is known;
- Stale — only when the feature-specific freshness rule, market date, and market-session state say it is stale;
- Unavailable — when no valid data is available;
- Data contoh / Preview statis — when a landing/product preview is illustrative rather than current production data.

Market-session context is derived from one authoritative market calendar/session source, never independently hard-coded by individual UI components.

Canonical session states for presentation logic are conceptually:

`PRE_OPEN | SESSION_1 | BREAK | SESSION_2 | POST_CLOSE | CLOSED | HOLIDAY | UNKNOWN`

The UI may humanize them in Indonesian. A Friday EOD snapshot viewed on Saturday is not automatically stale solely because wall-clock hours have elapsed.

Never infer a universal stale threshold across all datasets.

---

## 7. Spacing

Base spacing unit: **4px**.

Canonical scale: `4 / 8 / 12 / 16 / 20 / 24 / 32 / 40 / 48 / 64 / 80 / 96 / 128`.

Dense does not mean cramped.

---

## 8. Shapes

| Token | Radius |
|---|---:|
| xs | 4px |
| sm | 6px |
| md | 8px |
| lg | 12px |
| xl | 16px |
| full | 999px |

Recommended use: buttons 6–8px, inputs 8px, sidebar items 6–8px, data panels 8–12px, cards 12px, modals 12–16px. Pills only when semantically appropriate.

---

## 9. Elevation

- **Level 0:** canvas, tables, ordinary research regions, metric strips — no shadow
- **Level 1:** primary surfaces — border/tone first, no or nearly imperceptible shadow
- **Level 2:** dialogs, popovers, floating detail, command palette, mobile sheets — controlled soft shadow

---

## 10. Application Shell

### 10.1 Desktop

At ≥1024px:

- viewport-stable full-height sidebar; prefer the existing in-flow sticky shell behavior on desktop rather than forcing `position: fixed`
- independently scrollable navigation region
- docked account/profile region
- main content scrolls separately
- low-noise topbar
- no duplicate global navigation inside page content

Sidebar target: **232–248px**. Collapsed rail if retained: **64–72px**. Topbar: **~52px**.

### 10.2 Sidebar IA

```text
OVERVIEW
Dashboard

DISCOVER
Screener
Sektor Hot

RESEARCH
Analisis & Chart
Bandarmologi
Sinyal Intelijen
Broker Hunter
Insider
Ranking
Financial
Struktur Pasar

MONITOR
Watchlist
Portfolio
Track Record
```

Pattern Radar is admin-only. Do not show inaccessible admin features as disabled noise. Do not restore research as one giant horizontal tab strip.

### 10.3 Active State

Use pale brand-soft background, deep ink text, emerald icon/small edge indicator, compact radius, no glow, no giant solid emerald rectangle, and no unnecessary shadow.

---

## 11. Global Search & Shared Ticker Context

Global search is a target workstation enhancement: **Cari ticker, halaman, atau aksi…**. `Ctrl/Cmd + K` may be used. Because a full command palette adds new behavior, treat it as **Class C** unless an implementation wave explicitly authorizes it. A simple existing ticker/page search may be visually upgraded without inventing unsupported actions.

Research should share ticker context across applicable destinations. Do not duplicate ticker search bars on every research page.

Exceptions: Broker Hunter uses broker as primary context; Insider may search person/entity/ticker; Ranking keeps local table filtering; News may use active ticker context.

---

## 12. Content Width

| Class | Width |
|---|---|
| Reading | ~720–840px |
| Medium | ~960–1120px |
| Dashboard | ~1200–1280px |
| Data Wide | available workspace width |
| App ceiling | ~1560px |

Charts, Screener, Ranking, Broker Summary, and Insider graph can be wide. AI prose and legal/settings content should be constrained.

---

## 13. Density Modes

- **Editorial:** Landing
- **Standard:** Dashboard, Account, Financial, Struktur Pasar
- **Dense:** Screener, Ranking, Broker Summary, Track Record, Portfolio positions

---

## 14. Data Tables

Tables are primary product surfaces.

Canonical behavior: sticky headers, compact row height, tabular figures, right-aligned numeric columns, restrained hover, strong row identity, stable scrollbars where useful, sticky ticker/first column when valuable, and selection states independent from market semantics.

Target sizes: dense header 34–36px, dense row 36–40px, comfort row 40–44px.

Do not fill entire positive rows green or entire negative rows red.


### 14.1 Mobile Table Strategy

There is no single mobile rule for every table.

**Decision-list tables** (Screener, Watchlist, many Portfolio/Track Record views) may become compact prioritized rows plus a detail sheet, provided no meaning is lost.

**Comparative/matrix tables** where cross-column comparison is essential should remain real tables with horizontal scrolling and sticky row identity rather than being fragmented into cards.

Never solve mobile density by blindly turning every row into a large card, and never preserve 20+ visible columns just to claim the layout is still a table.

---

## 15. Dashboard

Dashboard answers: **What is the market condition, what changed, and what deserves attention?** It is not a feature directory.

Target hierarchy:

1. page context
2. market-condition strip
3. Top 5 final radar
4. safety/excluded disclosure
5. Top 5 history

Respect the current Top-5-only runtime contract. Do not reintroduce Auto Monitor visually if the runtime intentionally hides it.

Use ranked decision rows. Keep safety/excluded items available but collapsed by default.

---

## 16. Screener

Screener is **table-first**.

Primary modes: Konglo, Non-Konglo, Day Trade.

Hierarchy: `mode → search → filters → sort/view → active filters → result count/freshness → results`.

Filters should not dominate the screen. Secondary data belongs in optional columns, presets, expanded row, or detail pane. Card view may exist as Plan View for a small shortlist only.

---

## 17. Sektor Hot / Group Hot

Keep the current product label **Sektor Hot** unless a separate naming decision changes it, but respect the actual group/konglomerat semantics of the underlying data. Do not pretend group data is an industry-sector market-cap heatmap if it is not.

Flow: **group overview → constituent list → ticker research**.

Freshness must be explicit (for example `Diperbarui`, `Data belum terbaru`, `Memperbarui x / y diperiksa`).

---

## 18. Research Workspace

Research follows: **One ticker, many lenses.**

Core destinations: Analisis & Chart, Bandarmologi, Sinyal Intelijen, Broker Hunter, Insider, Ranking, Financial, Struktur Pasar, and admin-only Pattern Radar.

Layout grammars:

- Ticker Research: ticker context → local controls → research → provenance/freshness
- Market-Wide Table: filters → results → optional detail
- Entity Explorer: entity selector → results/relationships → contextual detail
- Specialized Admin: Pattern Radar

### 18.1 Data Visualization Grammar

Charts and visual analytics answer a question; they are not decoration.

**Price / technical charts**

- price direction uses financial positive/negative semantics;
- brand emerald is reserved for selection, controls, or a deliberate primary series—not automatically every bullish series;
- gridlines and axes remain low-contrast but readable;
- tooltip/crosshair information is precise and uses tabular figures where useful;
- range/indicator changes may transition subtly;
- do not replay the entire historical series animation on every refresh;
- no glow, neon area fill, or casino-style pulsing candles.

**Flow maps / bubbles**

- size corresponds to a documented metric;
- motion is event-driven and settles;
- labels remain readable at rest;
- provide a table/list path when exact values matter.

**Relationship graphs**

- movement is tied to pan/zoom/focus/selection;
- deterministic or stable layout is preferred for repeat analysis;
- decorative continuous physics is prohibited.

---

## 19. Analisis & Chart

Analisis AI and Chart & AI Vision are internal modes of one conceptual research destination.

### 19.1 Compatibility Rule

The current standalone Chart page remains a compatibility surface until all existing callers, deep links, runtime dependencies, and regression tests are intentionally migrated. Conceptual IA consolidation does not authorize deleting `page-chart`.

AI mode: interpretation + supporting context/provenance. Chart mode: chart dominates, with compact controls and mobile secondary sheets for advanced controls.

---

## 20. News & Catalysts

News is a contextual research surface, not a primary global navigation destination unless later product usage justifies promotion.

Preserve the current guest-permitted News deep-link/session behavior unless an explicit security/product decision changes it. A styling refactor must not accidentally force an otherwise permitted News route through protected-app authentication.

Structure: `ticker context → relevant items → source → publication date/time → summary → external article`.

Rules: source/date visible; no “Live” without a valid freshness contract; factual news separate from generated interpretation; preserve URL safety validation; do not invent bullish/bearish scoring; state stale/unavailable news honestly.

---

## 21. Bandarmologi

Keep Broker Summary and Akumulasi Broker in one product family. Table is default. Bubble/Flow Map is secondary and may animate only on meaningful transitions, never continuously.

---

## 22. Sinyal Intelijen

Sinyal Intelijen behaves like an evidence board. Each signal must expose status, supporting number, underlying evidence, and freshness. Scanner mode is table-first.

---

## 23. Broker Hunter

Primary context is broker, not ticker. Structure: `broker selector → range → accumulation/distribution → ticker drill-down`.

---

## 24. Insider Network

Entity-exploration surface. Desktop may use roster + graph + contextual detail. Mobile uses Roster/Graph mode. Allowed graph motion: pan, zoom, focus, selection, relationship reveal. No decorative physics loop.

---

## 25. Ranking

Ranking is spreadsheet-like. No podium, medals, or giant rank cards. Use sticky headers, sortable columns, compact rows, search/filter, optional quick detail. Rank is a number, not a trophy.

---

## 26. Financial

Display only fields actually supported by the data contract. Missing values remain missing. Provenance is prominent. Do not fake income statement, balance sheet, cash flow, or historical financial visualizations when backend data is absent.

---

## 27. Struktur Pasar

Treat as evidence. Include Free Float, HSC, Risk Guard, dates, sources, reference threshold, compliance/evaluation state, and notes where supported. Missing Free Float does not mean low Free Float. Unavailable does not mean warning.

---

## 28. Watchlist

Watchlist represents intention/monitoring, not Portfolio. Default presentation is table-first. Primary information: ticker, price, change, monitoring reason/note, alert state. Do not invent unsupported alert types.

---

## 29. Portfolio

Portfolio represents planning and position context, not Track Record.

Target local IA: Overview, Planner, Positions, Risk Lab, Journal, AI.

Risk Lab groups guard/average-down math and what-if scenarios. Hidden Portfolio alert plumbing does not automatically become a product destination.

Empty Portfolio should not show meaningless KPI zero walls.

---

## 30. Risk Lab

Risk calculations are mathematical support. Prefer **Within mathematical guard** over **Safe to average down**. Technical/setup review remains required.

---

## 31. Journal

Journal represents user behavior and user-entered records, not system signal performance. Prefer timeline/table hybrid.

---

## 32. Track Record

Track Record audits Auto-Cuan signal outcomes, not user investment performance. Use performance-ledger language. Terminology must match backend denominators exactly. Do not call something “Win Rate” unless the calculation truly matches that definition.

---

## 33. AI Design Grammar

AI follows data: **source data → assembled context → generated interpretation**.

Avoid sparkle identity, AI Powered badges, fake confidence, fake certainty, and anthropomorphic theater.

Preferred answer structure: Summary, Evidence, Risks/uncertainty, What to monitor, Context used/freshness.

---

## 34. AI States

Possible states include authentication required, access restricted, credential required, validating credential, invalid credential, quota exceeded, rate limited, provider unavailable, generation in progress, successful result.

Do not reduce all to “AI error.” AI failure must not remove underlying research data. Do not fake internal progress stages.

---

## 35. Account Center

### 35.1 Current vs Target Structure

The current runtime exposes Profile / Subscription / Terms. The target grouping below is a presentation re-organization, not permission to invent new security capabilities. Reuse existing data/actions and split them into clearer sections only when an implementation wave explicitly includes that migration.

Target architecture: Profil, Keamanan & Koneksi, Preferensi Trading, Pengaturan AI, Langganan, Ketentuan. These remain one Account environment, not global app destinations.

`Preferensi Trading` is a grouping target for **existing supported preference fields only** (for example trading-capital and risk-per-trade settings that already exist in runtime/data contracts). It must not invent brokerage, execution, or additional trading-profile capabilities. Any new preference not already supported is Class C product enhancement.

### 35.2 AI Credential / BYOK

AI credentials are account-level settings.

State model:

`Not configured → Validating → Connected → Invalid → Replace/Remove`

Rules:

- never redisplay the complete stored credential;
- use future-proof wording such as **Gemini credential** rather than depending on one key prefix;
- validation failure is local to AI and must not hide market/research data;
- a missing credential is configuration state, not a generic system error;
- do not claim Google OAuth or account linking when the product only stores a Gemini credential.

## 36. Authentication

Auth surfaces are light-first and direct. No dark-tech modal by default, gradient CTA, glowing button, or giant rounded auth panel.

Gmail is an Auto-Cuan account identifier in the current system. Do not label the current flow “Continue with Google” unless real Google OAuth is implemented.

### 36.1 Registration & Approval

Registration, Telegram verification, and admin approval are distinct states. A redesigned flow may visually separate account creation from verification, but must preserve authoritative server behavior.

After registration, communicate independently:

- account created;
- Telegram verification state when required;
- verification-code expiry when provided;
- admin approval state;
- next allowed action.

`Pending approval` is not `registration failed`.

Legacy username fallback may remain as low-emphasis helper text while the migration contract still supports it; do not promote it as the primary login model.

### 36.2 Telegram Connection

Telegram is a security/connection capability, not decorative profile metadata. Surface its verified/connected state under Security & Connections when Account Center is reorganized. Do not imply Telegram is connected unless server state proves it.

---

## 37. Mandatory Gmail Onboarding

For eligible legacy accounts without Gmail, this is a blocking onboarding requirement. Explain why, no dismiss X, no backdrop close, allow logout, and remain usable above software keyboard. It is onboarding, not an error.

---

## 38. Account Recovery

Recovery is a security flow, not an ordinary settings modal. Preserve authoritative identity verification, device/Telegram requirements where applicable, password confirmation, keyboard accessibility, focus containment/restoration, and clear success/failure states.

---

## 39. Product Onboarding & Help

General onboarding is contextual and dismissible. Mandatory security/account requirements are separate. Avoid mandatory tours every login, long carousel walkthroughs, and decorative confetti. Prefer contextual help near the task.

---

## 40. Subscription & Paywalls

Subscription UI must be factual. No fake “Most Popular”, giant promotional pricing cards, aggressive scarcity, manipulative countdowns, or excessive gradients.

### 40.1 Dormant Subscription Comparison Page

The standalone subscription comparison page is currently dormant. A visual redesign must **not expose or activate a dormant commerce flow**.

Account Center remains the canonical user-facing place for current entitlement, trial, voucher, and plan state until explicit product rollout activates comparison/purchase.

---

## 41. System State Taxonomy

Canonical states: Loading, Empty, Partial, Stale, Error, Unavailable, Restricted, Blocked, Maintenance, Service Status Unverified, Offline, Sample/Preview.

Each state answers: What happened? What remains valid? Does the user need to act? What can they do next?

### 41.1 Offline

Offline means the client cannot reach the network. Preserve the last valid cached/readable data where current architecture safely supports it, label it with its actual timestamp, disable actions that require connectivity, and provide a clear retry/reconnect path. Offline is not the same as server maintenance or service-status unknown.

### 41.2 Sample / Preview Data

Sample/Preview is a provenance state, not an error. Illustrative landing/product-preview data must be labelled `Data contoh`, `Preview statis`, or an equally clear truthful label and must never be presented as live/current market data.

---

## 42. Maintenance

Maintenance is a known intentional operational state. Explain temporary condition, what remains safe, what user should do, and whether broker monitoring remains necessary. It is not automatically a red-danger screen.

---

## 43. Service Status Unverified

Different from maintenance. It means operational state cannot be confirmed. Do not claim “Server down” unless known.

---

## 44. Blocked State

Blocked account UI must represent authoritative server state. Do not reconstruct block logic using speculative client-side timers or arbitrary countdowns.

---

## 45. Navigation Correctness

Visual navigation changes must preserve browser Back, browser Forward, deep links, refresh on deep routes, active destination, permission gates, supported page state restoration, no duplicate mount, no stale hidden page visibility, and no ticker-context loss caused solely by presentation refactor.

A navigation redesign is incomplete until browser-history behavior passes regression testing.

---

## 46. Responsive System

| Mode | Width |
|---|---|
| Narrow | <480 |
| Compact | 480–767 |
| Tablet | 768–1023 |
| Desktop | 1024–1279 |
| Wide | ≥1280 |

Components may use container queries when behavior depends on local width.

---

## 47. Mobile Navigation Target

Preferred authorized layout:

`Dashboard | Screener | Cari | Watchlist | Lainnya`

The bottom navigation is **entitlement-aware**:

- if Screener is not authorized, omit it rather than exposing a dead destination;
- do not invent an unrelated replacement merely to keep five items;
- the layout may adapt to four items;
- `Cari` and `Lainnya` retain stable meaning;
- empty groups collapse.

The `Cari` slot is enabled only when an already-supported search behavior exists or a Class C command/global-search enhancement has been explicitly approved. Until then, preserve the current safe navigation/search behavior; never ship a dead `Cari` placeholder merely to match the target layout.

`More` contains grouped access to secondary destinations, including the Research destination list. Eight Research lenses must **not** be rendered as one horizontal segmented control on mobile.

Mobile Research navigation pattern:

`More → Research → destination list`

Inside a Research destination, segmented controls are reserved for small local mode sets (normally 2–4 options), such as `AI / Chart` or `Broker Summary / Akumulasi`.

When the software keyboard is open, bottom navigation must hide or move safely out of the interactive viewport so it cannot cover auth, search, or AI-composer controls.

Bottom navigation must respect safe areas, software keyboard, viewport height, content padding, focus, accessibility, and permissions.

The current floating mobile launcher exists to solve historical viewport/discoverability problems. Do not remove it until replacement bottom navigation passes equivalent regression cases including no dead band, safe-area, keyboard compatibility, focus restoration, permission-aware navigation, and reliable routing.

---

## 48. Mobile Transform Rules

Do not simply shrink desktop.

| Desktop | Mobile |
|---|---|
| table + detail pane | compact list/table + detail sheet |
| AI + right context | AI + context sheet |
| buyer/seller columns | buyers/sellers switch |
| Insider roster + graph | Roster / Graph mode |
| Portfolio local nav | current section + navigation sheet |
| filter panel | bottom sheet |
| Chart toolbar | compact toolbar + advanced sheet |

---

## 49. Touch & Keyboard

Primary mobile controls should provide an approximately 44×44 CSS-pixel hit area. Dense visible icons may be smaller only when the interactive hit target remains sufficiently large and non-overlapping. Mobile form fields use at least 16px effective text. Preserve `100dvh`, safe-area insets, VisualViewport-aware keyboard geometry, scroll margin, and focus restoration.

---

## 50. Motion Tokens

```css
:root {
  --motion-press: 90ms;
  --motion-hover: 140ms;
  --motion-state: 190ms;
  --motion-panel: 260ms;
  --motion-story: 420ms;
  --motion-hero-max: 560ms;

  --motion-stagger-tight: 28ms;
  --motion-stagger-story: 64ms;

  --ease-standard: cubic-bezier(.2,.8,.2,1);
  --ease-emphasized: cubic-bezier(.16,1,.3,1);
  --ease-exit: cubic-bezier(.4,0,1,1);
}
```

---

## 51. Motion Technology

Preferred hierarchy: CSS → WAAPI → Document View Transition API → NumberFlow → Anime.js for specialized signature SVG choreography → Motion only if native is insufficient → GSAP only as justified last resort.

Do not install animation libraries “just in case”.

---

## 52. View Transitions

Use as progressive enhancement only. Navigation must work perfectly without it. Persistent shell remains stable; main content may use subtle ~190ms opacity + 4px translation. No full-screen 100% slides.

---

## 53. NumberFlow

Use the existing self-hosted NumberFlow implementation. Do not introduce a second rolling-number library.

Appropriate for IHSG, summary prices, P/L, market cap, PBV, portfolio exposure, risk values, and important result counts. Usually inappropriate for years, ranks, static lots, timestamps, HSC text, and ordinary table cells.

Accessible exact value must remain available independently from visual animation.

---

## 54. Reduced Motion

`prefers-reduced-motion: reduce` is a hard requirement. Disable spatial slides, scale choreography, parallax, Signal Line drawing, decorative transforms, number rolling, long reorder travel, non-essential graph movement, and smooth-scrolling behavior that creates unnecessary spatial movement. Content must remain immediately visible; reduced-motion mode must never leave reveal content at `opacity:0`.

---

## 55. Landing Page

Story: **Market → Scan → Investigate → Validate → Ask AI → Monitor**.

Avoid generic Hero → logos → six cards → testimonials → pricing → FAQ unless justified by real content.

Use a factual hero and real product concepts. Auto-Cuan Signal Line is a restrained one-time SVG motif, never neon or looping.


Recommended story architecture:

1. Hero — product promise + real workspace preview
2. Market Pulse — market context / freshness
3. Scan — Screener workflow
4. Investigate — broker / insider / structure lenses
5. Validate — Financial + Struktur Pasar evidence
6. AI Research — interpretation after data, not before it
7. Monitor — Watchlist / Portfolio / Track Record roles
8. Data Trust — source, period, freshness, unavailable-state behavior
9. Closing CTA — return to workspace

Avoid fake social-proof/logo sections. Pricing is shown only if the actual commerce rollout is active.

---

## 56. Loading

Use shape-matched skeletons for tables/financial/structural data, truthful progress only for AI when known, and inline refresh while existing content remains visible. Do not shimmer indefinitely without explanatory state when a request is taking unusually long. Reduced motion uses static skeletons.

---

## 57. Empty States

Explain why no content exists and what action is available. Do not use cute decorative emptiness as the primary message.

---

## 58. Error & Partial Failure

Prefer local failure over whole-app failure. If stale data exists, show its timestamp and optionally allow using it. Do not claim stale data is current.

---

## 59. Copy & Trust Language

Copy is direct, factual, calm, and specific. Avoid hype, certainty inflation, manipulative urgency, investment guarantees, and anthropomorphic AI claims.


### 59.1 Product Language

User-facing language is Indonesian-first. English is retained only for established domain terms that are clearer or already canonical in the product (for example PBV, Watchlist, Broker Summary, Entry, Stop Loss, TP1/TP2 where appropriate).

Within one surface, do not alternate casually between Indonesian and English synonyms for the same concept. Choose one label and keep it stable.

---

## 60. Icons

Use one coherent outline icon family with consistent stroke and ~18–20px sizing. No emoji as primary interface icons.

---

## 61. Buttons

Canonical families: Primary (solid emerald), Secondary (neutral + border), Quiet (low-chrome/text), Danger (destructive only). No page-specific primary colors.

---

## 62. Forms

Inputs use ~8px radius, strong focus, clear labels, visible error text, and retain values after validation failure where safe. Do not rely on placeholder as label.


### 62.1 Overlay Grammar

- **Dialog:** focused decision/form; blocks interaction with background when modal.
- **Drawer/detail pane:** preserves parent context while exposing secondary information.
- **Bottom sheet:** mobile equivalent for filters, navigation, or contextual detail.
- **Popover:** small anchored choice/context; never used for long critical workflows.

Dismissible overlays restore focus to the trigger. Mandatory account/security gates may intentionally be non-dismissible.

### 62.2 Toasts & Inline Messages

Toasts are for transient confirmation or non-blocking notices. Required decisions, validation errors, security failures, or destructive consequences must remain visible inline/on-surface and must not exist only as a disappearing toast.

---

## 63. Detail Pane

Use only when preserving parent context improves workflow. Good candidates: Screener, Ranking, Watchlist, Broker Hunter, Portfolio positions. Desktop target ~320–380px; mobile becomes sheet/full-screen detail.

---

## 64. Admin Operational Surfaces

Admin interfaces prioritize explicit state, auditability, destructive-action confirmation, timestamps, actor/target clarity, security status, compact tables, logs, and predictable controls.

Admin surfaces need not mimic landing editorial styling.

Admin visual refresh is secondary to the user-facing workstation and must not broaden privileges, expose dormant commerce, or weaken existing confirmation/security boundaries.

Never expose passwords, session cookies, API credentials, device secrets, or privileged tokens. Destructive actions require explicit target confirmation where current security behavior requires it.

---

## 65. Do

Use real product structures, prioritize scanability, show source/freshness, preserve business semantics, use hairlines, maintain alignment, use warm-neutral space, use emerald intentionally, keep financial colors semantic, use tabular figures, keep internal motion fast, preserve cached information during refresh, explain stale/unavailable states, make mobile workflows task-specific, and maintain keyboard/reduced-motion behavior.

---

## 66. Don’t

Do not make every section a card, use generic bento layouts, giant KPI walls, pill everything, blue-purple gradient identity, neon, decorative background grids, ubiquitous glassmorphism, giant rounded modals, emoji feature icons, glowing active nav, fake LIVE indicators, fake AI confidence, fake social proof, endless marquees, autoplay carousels, floating broker bubbles, breathing graph nodes, per-row animation, pulsing losses, flashing polling tables, mobile card soup, duplicate ticker searches, hidden provenance, stale-as-fresh, missing-as-zero, system-signal-as-user-return, or multiple libraries for the same animation problem.

---

## 67. Accessibility

Minimum acceptance: visible keyboard focus, semantic labels, WCAG-AA text contrast targets defined in §4.1, ≥3:1 essential interactive boundaries/focus indicators, keyboard operability, primary mobile hit areas around 44px where practical, 16px mobile inputs, reduced-motion support, safe-area support, VisualViewport-aware keyboard behavior, no color-only state meaning, exact accessible number independent of NumberFlow animation, correctly labelled dialogs, appropriate background inertness, Escape/focus restoration for dismissible overlays, and intentional non-dismissible mandatory flows. Decorative hairlines are exempt from being used as the sole identifier of a control. Focus indication should be approximately 2px or otherwise provide equivalent visible area/contrast.

---

## 68. Performance

Prefer CSS, containment, `content-visibility` where appropriate, IntersectionObserver, efficient table updates, DOM preservation during editing, and progressive enhancement.

Avoid unbounded blur, animated large shadows, per-row animations, duplicate observers after routing, decorative RAF loops, needless polling, and full rerenders for tiny data changes.

On large data surfaces, performance and readability outrank decorative motion.

---

## 69. Implementation Boundaries

Class A visual refactoring must not alter API response semantics, request routing, authentication, session validation, Gmail migration behavior, Telegram verification, subscription entitlement, voucher validation, portfolio calculations, risk calculations, signal generation, scoring/ranking algorithms, Top 5 selection logic, broker calculations, Free Float interpretation, HSC interpretation, Track Record outcome formulas, data provenance, or freshness semantics.

An explicitly approved Class B interaction migration may change **client-side navigation/request orchestration** only when its migration plan and equivalent regression coverage are defined. It still may not silently change authoritative backend API/data/auth/security semantics. Class C capability changes remain separately approved product work.

Preserve IDs/contracts required by runtime until a deliberate migration replaces them safely.

---

## 70. Legacy Treatment

Existing styles are evidence, not automatic source of truth. Useful functional patterns may coexist with legacy aesthetics in `ui-theme.css`, `index-shell.css`, `premium-workstation*.css`, `spreadsheet-grade.css`, Portfolio standalone styles, and older landing/auth styles.

Classify each legacy rule as preserve behavior, preserve semantic meaning, preserve accessibility, migrate visual treatment, or remove after regression-safe replacement.

---

## 71. Migration Safety

The authoritative implementation order is **§82 Implementation Wave Map**. This section defines safety rules only and must not be interpreted as a second execution sequence.

Never remove old behavior before replacement passes equivalent tests.

Special cases:

- Mobile FAB: keep until new bottom nav passes historical viewport/safe-area/focus regressions.
- Old ticker search: keep until shared ticker context fully replaces it.
- Research tab logic: do not delete runtime assumptions until sidebar routing is equivalent.
- Standalone Chart: do not remove until all callers/tests migrate.
- Money Management: do not delete stored data/schema because product UI is retired.
- Current dark-theme access: do not silently remove it during a light-first styling wave; deprecation requires a separate decision.
- Guest News deep link: preserve current guest-permitted behavior during visual refactor.
- Dormant Subscription: remain unreachable until explicit product rollout.

---

## 72. QA Matrix

Minimum viewport checks:

- 320 × 568
- 360 × 800
- 390/393 × 844/852
- 768 × 1024
- 1024 × 768
- 1280 × 800
- 1440 × 900
- 1600 × 900
- 1920 × 1080

Also test mobile landscape, keyboard open, 200% zoom, reduced motion, long Indonesian labels, missing/stale/partial data, slow response, large Screener/Ranking datasets, empty Portfolio, logged-out/pending/mandatory-Gmail/recovery/blocked states, maintenance, service-status unknown, AI key missing, AI quota exhausted, browser Back/Forward, deep-link refresh, guest News route behavior, matrix-table horizontal scroll, decision-list mobile transformation, token contrast, admin surfaces, dormant subscription remaining unreachable, and deprecated Money Management/DeepScan routes not being revived.

Automated screenshots are not a substitute for real-device testing.

---

## 73. Acceptance Standard

A page is not complete merely because it looks modern. It is complete only when hierarchy is correct, data semantics remain correct, states are handled, mobile workflow works, keyboard/reduced-motion work, provenance remains understandable, layout survives real data density, performance remains acceptable, business behavior is unchanged, navigation history remains correct, and the page feels like part of one Auto-Cuan workstation.

---

## 74. The Auto-Cuan Test

Before accepting any design decision, ask:

1. Does this make the financial information easier to understand?
2. Does this clarify what the user should inspect next?
3. Does it preserve the meaning of the underlying data?
4. Is the visual treatment quieter than the data it contains?
5. Would this still make sense without animation?
6. Would this still make sense without color?
7. Does it work on a small phone?
8. Does it remain usable with dense real-world data?
9. Is it consistent with the rest of Auto-Cuan?
10. Is this actually useful, or merely fashionable?

If the answer to the last question is **merely fashionable**, remove it.

---

## 75. Final Product Character

Auto-Cuan should feel alive because navigation has continuity, market data changes clearly, selected research context persists, AI develops progressively from evidence, charts respond to inspection, monitoring surfaces reveal meaningful change, and system state is transparent.

It should **not** feel alive because every object moves.

The workstation itself remains calm.

**The market is what moves.**

---


## 76. Canonical Component Grammar

Auto-Cuan uses a small set of repeatable interface primitives. In the vanilla HTML/CSS/JavaScript codebase, “component” means a stable DOM/CSS/behavior pattern, not a requirement to adopt React or another framework.

### 76.1 Button

Canonical families:

| Variant | Use | Visual treatment |
|---|---|---|
| Primary | One main action in a local task | solid `--ac-brand`, compact radius |
| Secondary | Alternative action | white/neutral surface + `--ac-control-border` |
| Quiet | Low-priority action | minimal chrome |
| Danger | Destructive action only | semantic danger treatment |
| Icon | Toolbar / compact action | square hit area, tooltip/accessible label |

Rules:

- target height: 36–40px desktop, approximately 44px hit area on touch;
- primary actions use one brand color across the product;
- loading keeps button width stable and preserves its label context;
- disabled is visibly disabled without becoming unreadable;
- icon-only buttons require an accessible name;
- no scale-up hover, glow, gradient, or page-specific CTA color.

### 76.2 Field

Fields contain:

`label → control → helper/error`

Rules:

- label remains visible; placeholder is not the label;
- input radius ~8px;
- resting input/select/textarea boundaries use `--ac-control-border` or an equivalent ≥3:1 essential boundary on the canonical background; decorative hairlines are not sufficient for control identification;
- focus uses the canonical focus indicator and must remain visible independently of hover;
- mobile effective text size ≥16px;
- errors remain inline until resolved;
- loading/validation must not erase the user’s value;
- ticker inputs normalize visually to uppercase but do not silently fabricate a ticker.

### 76.3 Segmented Control

Use for small mutually exclusive local modes such as:

- Konglo / Non-Konglo / Day Trade;
- AI / Chart;
- Buyers / Sellers on constrained mobile;
- Roster / Graph.

Rules:

- 2–4 options preferred;
- not a replacement for global navigation;
- selected state uses brand-soft treatment, not a filled pill parade;
- each option remains keyboard reachable.

### 76.4 Filter Bar

Canonical order:

`Search → primary filters → sort → view/options → result/freshness status`

Advanced filters move into a popover/drawer/sheet.

Active filters may render as removable chips only after selection.

Do not render every possible filter as a permanent horizontal row.

### 76.5 Ticker Context

Ticker context is the research identity anchor.

It may contain:

- ticker;
- optional company name when available;
- last trustworthy price / freshness where relevant;
- compact route-local actions.

Rules:

- only one primary ticker context per page;
- child surfaces read from it where the current data architecture supports shared state;
- do not repeat full ticker input bars inside every research lens;
- Broker Hunter and entity-first surfaces may use a different primary identity.

### 76.6 Metric

A metric is:

`label + value + optional unit/context + optional freshness`

It is **not automatically a card**.

Use flat metrics inside strips, rows, or evidence sections unless the metric itself is a distinct object.

Large metric typography is reserved for genuinely decision-critical values.

### 76.7 Metric Strip

Use for 3–6 comparable summary values.

Examples:

- Dashboard market condition;
- Portfolio exposure / risk / P&L / positions;
- Track Record signal / resolved / active / TP1 / TP2 / SL.

Rules:

- one continuous surface or aligned row;
- no KPI-card wall;
- each value uses consistent alignment;
- semantic color applies to the value, not the whole container.

### 76.8 Status

A status is text first.

Preferred forms:

- inline label;
- compact bordered badge when boundary is useful;
- icon + text for system states.

Do not force every state into a pill.

Status copy must state the actual contract:

`Pending`, `Unavailable`, `Stale`, `HSC Aktif`, `Belum terverifikasi`, etc.

### 76.9 Data Table

A data table includes:

- table header;
- sortable header where supported;
- stable row identity;
- numeric alignment;
- hover;
- keyboard/focus behavior where row interaction exists;
- selected state independent from financial positive/negative meaning;
- selected interactive rows use brand-soft **plus** a non-color-only affordance such as a brand edge/indicator and `aria-selected`/equivalent state where appropriate.

Desktop dense row target: 36–40px.

For interactive rows, clicking the row opens contextual detail; embedded controls must not accidentally trigger row navigation.

### 76.10 Decision Row

Used when a row is closer to a ranked actionable summary than a matrix table.

Typical structure:

`ticker/identity | primary state | 2–4 decision metrics | compact plan | detail affordance`

Examples:

- Top 5;
- compact Screener mobile rows;
- Watchlist;
- selected Portfolio summaries.

Decision Row does not become a large card on mobile.

### 76.11 Provenance Row

Canonical provenance vocabulary:

`Per tanggal | Sumber | Diperbarui | Ketersediaan/kualitas`

Use plain aligned metadata.

Do not hide source/freshness behind hover-only tooltips.

### 76.12 Detail Pane Component

Desktop:

- 320–380px target where space allows;
- tied to one selected parent row;
- scrolls independently only when needed;
- preserves parent list/table state.

Mobile:

- bottom sheet for concise detail;
- full-screen detail for long research content.

Closing detail returns focus/selection to the originating row.

### 76.13 Dialog / Sheet / Popover

Use:

- **Dialog** for focused forms/decisions;
- **Sheet** for mobile filters, navigation, or contextual detail;
- **Popover** for short anchored choices only.

Do not place long research or legal content inside tiny popovers.

### 76.14 Feedback Surface

Canonical feedback patterns:

- skeleton for initial structural loading;
- inline refresh state when existing data remains valid;
- empty state when valid result set is empty;
- partial/stale banner when some valid data remains;
- local error when one subsystem fails;
- whole-screen operational state only for authentication/maintenance/service-level gates.

### 76.15 AI Result

AI result structure:

`Summary → Evidence → Risks/uncertainty → What to monitor → Context used`

It must distinguish model interpretation from source data.

Quick prompts are optional accelerators, not the main hierarchy.

### 76.16 Account Entry

There is one primary signed-in account entry in the workspace shell.

Target:

`avatar/initial + username + plan/role summary + chevron`

Clicking it opens Account Center.

Do **not** duplicate Profile, Subscription, and Logout as a second permanent control cluster in the topbar.

Logout remains available inside the account surface and may remain as one clear sidebar/account action during migration, but the final shell must not present two competing profile/navigation systems.

---

## 77. Canonical Component State Matrix

Every interactive component must define only the states it genuinely needs.

| State | Requirement |
|---|---|
| Rest | quiet, readable |
| Hover | small tonal/border change; no scale jump |
| Focus-visible | stronger than hover; accessible outline/ring |
| Active/pressed | immediate 90ms-class feedback |
| Selected | brand-soft / structural indication |
| Disabled | non-interactive, still legible |
| Loading | geometry remains stable |
| Error | semantic message near cause |
| Success | factual confirmation; no celebration theater |

Do not invent pulse/animation merely to represent “active”.

For rows and table cells:

- selection color is brand semantics;
- positive/negative color is financial semantics;
- warning color is risk/system semantics.

These must never be conflated.

---

## 78. Canonical Data Grammar

Every critical datum is conceptually represented by:

```text
value
unit / format
availability
basis / calculation_context
as_of
updated_at
source
quality / status
```

`basis / calculation_context` is required for derived values whose meaning depends on another value or scenario. Examples include R/R, stop distance, position sizing, plan return, and scenario outputs.

Not every field is shown at full prominence, but the interface must have a deterministic place for the fields that exist.

A display layer must not silently recompute a derived financial/trading value from a different basis than the authoritative source. Shared selectors/formatters should own display normalization for Entry, SL, TP1/TP2, R/R, and lot sizing.

### 78.1 Availability

Use:

- **Available** — valid value exists;
- **Partial** — some required fields are absent;
- **Unavailable** — no valid value exists;
- **Unknown / Not evaluated** — state has not been determined;
- **Stale** — valid data exists but violates the surface-specific freshness rule.

Never render unavailable as `0`.

### 78.2 Source & Freshness

Source names and timestamps are evidence, not decoration.

Prefer concise labels:

`IDX ownership · Per tanggal 31 Agu 2026`

rather than long repeated disclaimer cards.

### 78.3 Sorting

Sort only by a real field.

Rules:

- current sort is always visible;
- missing values sort last unless the feature explicitly defines otherwise;
- toggling sort does not reset unrelated filters;
- resorting may animate minimally but rows must not travel theatrically.

### 78.4 Search

Search filters the current dataset or invokes an existing supported server query.

Rules:

- preserve current filter/sort context where reasonable;
- no fabricated fuzzy actions;
- empty search result is distinct from data-load failure.

### 78.5 List → Detail Pattern

For universe-scale data, prefer:

`bounded list/snapshot → selection → lazy detail`

over:

`full heavyweight context for every row`.

This is a UX/performance contract, not permission to change financial/business semantics.

---

## 79. Surface Blueprints — Exact Contracts

### 79.1 Screener — Detailed Surface Contract

The Screener navigation item is a stable product destination governed by authoritative access state.

Navigation state:

- **Access resolving:** avoid final “missing feature” appearance; preserve stable shell geometry or a neutral loading state.
- **Allowed:** Screener appears in DISCOVER and is fully navigable.
- **Denied:** Screener is omitted/disabled according to existing entitlement rules; empty group headings must collapse.
- **Transient access failure:** do not permanently erase a previously confirmed destination solely because a refresh request failed.

The redesign must not bypass backend entitlement.

Default Screener surface:

```text
Screener
[Konglo] [Non-Konglo] [Day Trade]

Search | Filters | Sort | View
Active filters / result count / freshness

TABLE
Ticker | Setup/Tier | Score | Gate* | Aksi* | Exec | Price | Change | Vol/Avg | Entry | SL | TP1 | R/R | Freshness
```

`Gate*` and `Aksi*` are shown only when authoritative fields exist for the current mode. The gate denominator/count must come from the authoritative current gate model; never hard-code `n/5`, `n/3`, or another denominator in presentation code.

Raw internal enums such as `WAIT_PULLBACK`, `A_PLUS_SETUP`, `ENTRY_AREA`, or execution buckets must pass through one canonical user-facing label mapper before they enter normal user-facing DOM.

Day Trade may expose a different default column preset, while its complete current data remains available through columns/detail.

Entry, SL, TP1/TP2, R/R, and lot/size presentation must use the shared plan display selector/formatter rather than route-specific recomputation.

Desktop:

`table + optional selected-ticker detail pane`

Mobile:

`prioritized decision rows + detail sheet`

Do not make card view the default universe view.

### 79.2 Financial — Verified Snapshot Contract

Financial is a **verified snapshot**, not a decorative “Financial Canvas”.

Target hierarchy:

```text
Financial
Ticker context / search

Snapshot terverifikasi
PBV | BVPS | Market Cap | Saham Beredar

Periode | Sumber fundamental | Sumber market cap | Diperbarui
Optional explanation / provenance
```

Rules:

- no giant green hero card;
- no decorative orbit/rings;
- no oversized empty metric boxes;
- missing data stays `—`;
- if all key fundamental fields are unavailable, show one compact truthful unavailable state instead of four theatrical empty cards;
- reference price may be shown only where it actually explains PBV or market-cap derivation;
- do not invent revenue/profit/cash-flow data.

Performance contract:

- the initial Financial request should retrieve only the fields needed for the snapshot plus the minimal trustworthy price dependency required by supported calculations;
- do not require full technical/foreign/calendar context merely to render fundamental fields;
- cache the last valid snapshot and keep it visible during refresh;
- show provenance/freshness immediately when available.

### 79.3 Struktur Pasar — Universe List & Detail Contract

Struktur Pasar is **list-first**.

The default page must not be an empty “type one ticker and load” canvas when the database already contains universe-level structure data.

Target desktop:

```text
Struktur Pasar
Cari saham...

[Semua] [FF Rendah <15%] [HSC Aktif] [Data Belum Lengkap]
Urutkan: Free Float ↑ / Ticker / HSC

Ticker | Free Float | HSC | Status Struktur     | Per tanggal
BBCA   | 41,82%     | —   | HSC belum diketahui| 31 Agu 2026
...
                                      [Panel detail]
```

Default behavior:

- load a bounded universe snapshot;
- missing Free Float sorts after numeric values;
- the `<15%` filter is a reference-risk filter, **not** a regulatory compliance verdict;
- HSC `true`, `false`, and `unknown` remain distinct;
- selecting a row opens detail without destroying list position/filter/sort.

Detail pane contains only supported evidence:

- ticker;
- Free Float;
- Free Float source + as-of;
- HSC state;
- HSC source + as-of;
- Risk Guard / market-structure status;
- reference Low Free Float threshold;
- regulatory evaluation status;
- evidence note;
- updated timestamp when supported.

Mobile:

`compact stock list → tap row → detail sheet`

Performance contract:

- use a lightweight universe snapshot for the list;
- do not build heavyweight per-ticker daily market context for every row;
- detail may lazy-load additional supported evidence only after selection;
- list refresh keeps the current list visible;
- filters/search should be client-side when the already-loaded bounded dataset makes that reliable.

### 79.4 Account / Profile

Final shell has **one account identity surface**.

Target:

- sidebar/footer account row is primary;
- Account Center contains **Profil, Keamanan & Koneksi, Preferensi Trading, Pengaturan AI, Langganan, Ketentuan**;
- admin/plan state may appear as compact metadata inside the account row/center;
- topbar does not permanently duplicate `Profile + ADMIN + Subscription + Logout`.

Topbar is reserved for route/workspace utilities such as search, local page actions, freshness, or other high-value context.

### 79.5 Loading for Financial & Struktur Pasar

These data surfaces must feel lightweight even when the underlying data path is not instantaneous.

Rules:

- do not blank the whole page during refresh;
- do not use a full-page spinner;
- avoid skeleton flash for near-instant responses;
- initial Financial skeleton mirrors one summary strip + provenance rows;
- initial Struktur Pasar skeleton mirrors a small table header + 6–8 rows;
- once valid data exists, refresh is inline and the previous snapshot/list stays visible;
- after an unusually long wait, replace anonymous shimmer with truthful copy such as `Masih memuat data…`;
- request failure becomes a local retry state and must not collapse the entire Research workspace.

---

## 80. Loading, Cache & Refresh Contract

Canonical lifecycle:

```text
UNINITIALIZED
→ INITIAL_LOADING
→ READY
→ REFRESHING (previous valid data remains visible)
→ READY

or

INITIAL_LOADING → EMPTY
INITIAL_LOADING → ERROR
READY → PARTIAL/STALE
REFRESHING → REFRESH_ERROR (previous valid data remains visible)
```

Rules:

- a refresh error does not erase last-known valid data;
- route revisit should reuse current keep-alive/SWR behavior where already supported;
- skeleton is an initial-layout tool, not a recurring polling animation;
- the UI must distinguish `empty result` from `failed request`;
- no hidden background request may silently replace valid data with a less complete payload without exposing the new availability state.

### 80.1 Perceived-performance target

The design should avoid visual churn:

- very fast responses should not flash a skeleton unnecessarily;
- table/list geometry should be established early;
- detail content may progressively fill in;
- controls remain usable unless the specific action truly requires blocking.

This is a design target, not a fabricated network SLA.

---

## 81. Canonical CSS / Component Ownership

The redesign must **reduce global styling layers**, not add another competing global theme file.

### 81.1 Canonical owner

`public/ui-theme.css` should evolve into the canonical owner for:

- global `--ac-*` tokens;
- base typography;
- buttons/fields;
- shell primitives;
- common surfaces;
- table primitives;
- common responsive/accessibility component rules.

Do not create a second global token system beside it.

### 81.2 Migration layers

`public/final-uiux-polish.css`

- preserve useful motion/density ideas;
- migrate canonical values into `ui-theme.css`;
- remove duplicate/conflicting global token ownership when safe;
- eventually shrink to true page-specific polish or retire.

`public/index-shell.css`

- preserve `.hidden` safety behavior and shell/runtime-sensitive rules;
- migrate old dark visual skin progressively;
- do not casually rewrite show/hide mechanics.

`public/spreadsheet-grade.css`

- preserve sticky-table, tabular-number, overflow, and spreadsheet-density lessons;
- remove/retire legacy visual mesh/card treatments after equivalent canonical styles exist;
- remove Money Management-specific presentation only when that feature-retirement wave is explicitly authorized.

Complex feature CSS such as Portfolio/Account may remain modular, but must consume canonical tokens instead of declaring an independent product theme.

---

## 82. Implementation Wave Map — Planning Only

> **No wave below is authorized until the user explicitly says to edit the repository.**

### Wave 0 — Freeze & Regression Baseline

Read-only / test preparation:

- record final redesign baseline SHA;
- capture representative desktop/tablet/mobile screenshots;
- record current route/access/auth behavior;
- record key automated test baseline;
- verify current dataset states used for visual QA;
- capture reproducible performance baseline (LCP/CLS/INP where available, otherwise documented local proxies);
- verify whether historical findings are still open before carrying them forward, including quote-vs-candle price definition, R/R/SL/lot parity across surfaces, gate-count denominator, any misleading `LIVE` badge, preview-label visibility, and sidebar-footer clipping;
- classify each historical item as `OPEN`, `CLOSED`, or `NOT APPLICABLE` with evidence.

No visual change. Historical audit findings are not treated as current bugs until re-verified against the implementation baseline.

### Wave 1 — Foundations

Primary files:

- `public/ui-theme.css`
- `public/final-uiux-polish.css`
- `public/index-shell.css`
- `public/spreadsheet-grade.css`
- `public/number-flow.css`
- `public/number-flow-runtime.js`
- `public/viewport.css`

Goals:

- canonical tokens;
- typography;
- buttons/forms;
- table primitives;
- focus;
- semantic colors;
- motion tokens;
- establish route/surface-scoped v2 rollout mechanism before broad light-token adoption;
- map existing dark/light theme variables to canonical `--ac-*` tokens for surfaces being migrated;
- preserve viewport/keyboard/reduced-motion behavior.

Do not globally flip unfinished legacy routes into the new visual system. Migrated surfaces opt in through a deterministic route/surface scope (for example a version attribute/class owned by the shell) until parity is proven and the default can be flipped safely.

`viewport.css` behavior is protected; only deliberate compatibility-safe changes are allowed.

### Wave 2 — Shell, Navigation & Account Entry

Primary files:

- `public/index.html`
- `public/ui-theme.css`
- `public/mobile-nav.js`
- `public/account-center-v1.js`
- `public/account-center-v1.css`
- `public/subscription-access-gate-v1.js`

Goals:

- final sidebar hierarchy;
- single account entry;
- remove duplicated permanent profile/subscription/logout chrome;
- stabilize access-aware Screener/navigation visibility;
- prepare safe mobile-navigation replacement without removing the existing launcher until equivalent tests pass.

No entitlement weakening.

### Wave 3 — Data Primitives & Detail Pattern

Primary surfaces:

- shared table styles;
- filter bar;
- status/freshness/provenance;
- detail pane / sheet;
- loading/empty/partial/error grammar.

Goals:

- reusable list-detail behavior before feature-specific redesign;
- no card-first universe surfaces.

### Wave 4 — Financial & Struktur Pasar

Primary files:

- `public/partials/analisis-saham.partial.html`
- `public/analisis-saham-runtime.js`
- corresponding Research CSS currently styling these panels

Read-only-first backend/data-path inspection before any backend change:

- `api/quote.js`
- `lib/daily-market-context-builder.js`
- `lib/stock-daily-history-store.js`
- market-structure/fundamental data helpers

Goals:

- compact Financial verified snapshot;
- Struktur Pasar list-first universe;
- lightweight list/snapshot data path;
- lazy detail;
- preserve Free Float/HSC/fundamental semantics exactly.

A dedicated lightweight data action/endpoint may be introduced only after the current DB/API contract is verified; do not blindly mutate the existing full context builder.

### Wave 5 — Screener & Sektor Hot

Primary files:

- Screener markup/runtime currently owned largely by `public/index.html`
- `public/daytrade-runtime.js`
- relevant sector-hot markup/runtime/styles

Goals:

- table-first Screener;
- filter hierarchy;
- detail pane;
- compact mobile decision rows;
- Group Hot overview/detail grammar;
- preserve polling, cache, scoring, and tier semantics.

### Wave 6 — Dashboard & Research Lenses

Primary files:

- `public/dashboard-top5-only-ui.js`
- Dashboard markup/styles in `public/index.html`
- `public/analisis-saham-runtime.js`
- `public/bandarmologi-runtime.js`
- Pattern/Insider/Broker Hunter/Ranking supporting runtimes

Goals:

- market strip;
- ranked Top 5 decision rows;
- shared research grammar;
- no reintroduction of hidden Auto Monitor;
- table/evidence-first specialized research.

### Wave 7 — Monitoring

Primary files:

- `public/watchlist-runtime.js`
- `public/portfolio-command-center.js`
- `public/portfolio-command-center.css`
- Portfolio partial/model/scenario helpers
- `public/track-record-runtime.js`

Goals:

- Watchlist table-first;
- Portfolio Overview / Planner / Positions / Risk Lab / Journal / AI;
- Track Record as system-signal audit;
- migrate independent dark CSS toward canonical tokens while preserving calculations/persistence.

### Wave 8 — Auth, Account & System States

Primary files:

- `public/auth-v2.js`
- `public/legacy-gmail-runtime.js`
- `public/account-center-v1.js`
- `public/account-center-v1.css`
- maintenance/service-status markup and related runtime

Goals:

- light-first auth;
- mandatory Gmail clarity;
- recovery;
- Account Center final organization;
- maintenance / status unknown / blocked / restricted grammar;
- preserve focus/security/session behavior.

### Wave 9 — Landing

Primary files:

- landing markup/styles in `public/index.html`
- `public/landing-experience.js`

Goals:

- Market → Scan → Investigate → Validate → Ask AI → Monitor;
- real product preview;
- editorial light-first visual identity;
- Signal Line choreography only if it improves storytelling;
- preserve content visibility when JS/motion fails.

### Wave 10 — Motion Polish & Legacy Retirement

Goals:

- progressive View Transitions;
- NumberFlow auditing;
- selective signature Anime.js only if still justified;
- remove duplicate CSS only after visual/behavior parity;
- remove obsolete UI chrome;
- retire old card-first styling;
- keep deprecated data/schema untouched unless a separate cleanup decision authorizes removal.

For every wave, maintain one append-only redesign progress log that records:

- baseline/final SHA;
- scope;
- evidence-pack location;
- tests/screenshots;
- deviations;
- unresolved follow-ups.

This prevents handoff between sessions/agents from depending on chat memory.

---


## 83. Canonical Page Architecture

Every signed-in destination must fit one of a small number of page archetypes. A page should not invent a new structural language simply because its data is different.

### 83.1 Workstation Page

Used for Dashboard, Financial, Struktur Pasar, Watchlist, Track Record, and similar evidence-led surfaces.

Canonical composition:

```text
Page Header
→ optional Context / Freshness Bar
→ Primary Work Area
→ optional Secondary Evidence / Detail
```

The Page Header contains only:

- route title;
- one-sentence purpose/subtitle when useful;
- at most one compact route-level action cluster.

Do not place account controls, subscription controls, repeated ticker selectors, and unrelated utilities inside every page header.

### 83.2 Universe / Discovery Page

Used for Screener, Ranking, Sektor Hot, and other list-first market surfaces.

Canonical composition:

```text
Page Header
→ Mode / Scope
→ Search + Filter Bar
→ Result / Freshness Summary
→ Table or Decision List
→ optional Detail Pane
```

The result set is the visual priority. Filter chrome must remain smaller and quieter than the dataset.

### 83.3 Research Page

Used for Analisis & Chart, Bandarmologi, Sinyal Intelijen, Struktur Pasar detail, and ticker-based evidence surfaces.

Canonical composition:

```text
Page Header
→ Shared Ticker Context
→ Local Mode / Range Controls
→ Primary Research Surface
→ Evidence / Provenance
```

A route may omit a layer when it is unnecessary, but must not duplicate it elsewhere.

### 83.4 Entity Explorer

Used for Broker Hunter and Insider Network.

Canonical composition:

```text
Page Header
→ Entity Selector
→ Relationship / Result Surface
→ Selected Entity Detail
```

### 83.5 Settings / Account Page

Used for Account Center, Subscription state, AI credential settings, security connections, and preferences.

Canonical composition:

```text
Account Identity
→ Section Navigation
→ Settings Rows / Forms
→ Inline Status / Confirmation
```

Settings must not mimic market-data dashboards.

### 83.6 Operational Admin Page

Used for administrator-only management and logs.

Canonical composition prioritizes auditability, explicit state, timestamps, actor/target clarity, and destructive-action safety over editorial polish.

### 83.7 Canonical Route → Nav Group → Archetype Matrix

Navigation group and page archetype are separate dimensions.

| User-facing destination | Nav group | Primary archetype | Density | Mobile pattern |
|---|---|---|---|---|
| Dashboard | OVERVIEW | Workstation | Standard / compact data | single-column decision rows |
| Screener | DISCOVER | Universe / Discovery | Dense | prioritized decision rows + detail sheet |
| Sektor Hot | DISCOVER | Universe / Discovery | Dense / standard detail | compact group list + detail |
| Analisis & Chart | RESEARCH | Research | Standard | route + local `AI / Chart` mode |
| Bandarmologi | RESEARCH | Research | Dense | local Buyers/Sellers or summary/accumulation mode |
| Sinyal Intelijen | RESEARCH | Research / scanner | Dense | prioritized results + detail |
| Broker Hunter | RESEARCH | Entity Explorer | Dense | local mode switch + detail |
| Insider | RESEARCH | Entity Explorer | Standard + graph | `Roster / Graph` local mode |
| Ranking | RESEARCH | Universe / Discovery | Dense | horizontal/reduced matrix when comparison is essential |
| Financial | RESEARCH | Workstation / Research snapshot | Standard | vertical snapshot + provenance |
| Struktur Pasar | RESEARCH | Universe List + Research Detail | Dense list / Standard detail | compact list + detail sheet |
| Watchlist | MONITOR | Workstation / list-detail | Dense | decision rows + detail |
| Portfolio | MONITOR | Workstation | Standard / Dense subviews | section selector + task-specific layout |
| Track Record | MONITOR | Workstation / ledger | Dense | compact ledger rows + detail |
| Account | account context | Settings | Standard | section selector + full-width forms |
| Admin | permission-gated admin context | Operational Admin | Dense | task-specific operational layout |

This table is authoritative when a route appears to belong to more than one conceptual category. For example, Ranking remains in the RESEARCH nav group while using the Universe/Discovery structural archetype.

---

## 84. Canonical Page Header & Local Toolbar Grammar

### 84.1 Page Header

All authenticated destinations share a consistent page-header baseline:

- left aligned;
- compact vertical rhythm;
- title normally 28–32px desktop and 24–28px compact/mobile;
- subtitle only when it adds task context;
- no giant hero treatment inside the workstation;
- no page-specific gradient banner by default.

A page header is not a card.

### 84.2 Local Toolbar

Use a local toolbar only when controls affect the current surface.

Order:

`identity/context → modes/range → search/filter → route-local action → freshness`

Do not place persistent global Account/Profile/Subscription/Logout controls in local toolbars.

### 84.3 Topbar

The global topbar remains intentionally quiet.

Suitable content:

- global or current-route search;
- route breadcrumb/context where truly needed;
- compact freshness/system indicator;
- exceptional route-level action.

The final shell must not duplicate the sidebar account identity with a second permanent `Profile + Subscription + Logout` cluster.

---

## 85. Global vs Local Navigation Contract

Navigation has three distinct levels and they must not visually compete.

### Level 1 — Global Product Navigation

Sidebar on desktop; target bottom navigation + More on mobile.

It answers: **Where am I in Auto-Cuan?**

### Level 2 — Local Destination Modes

Segmented controls or compact local navigation such as:

- Konglo / Non-Konglo / Day Trade;
- AI / Chart;
- Broker Summary / Akumulasi;
- Guard / What-if.

It answers: **Which mode of this destination am I using?**

### Level 3 — Data Selection

Ticker, broker, insider entity, row selection, date/range, or filter state.

It answers: **What data am I inspecting?**

Rules:

- do not style all three levels as identical pills;
- local mode controls never replace global navigation;
- data selection should not look like another page route;
- browser Back/Forward behavior must follow real route/history semantics rather than every small local selection unless current product behavior explicitly does so.

---

## 86. Surface Hierarchy & Density Coherence

Auto-Cuan uses only four structural surface strengths.

| Level | Purpose | Treatment |
|---|---|---|
| Canvas | application ground | warm neutral, no border |
| Section | related content region | spacing / optional hairline |
| Bounded Surface | table/detail/settings region needing containment | white/raised tone + hairline |
| Floating Surface | dialog/popover/sheet | controlled shadow + strong boundary |

Rules:

- ordinary metrics do not automatically become bounded cards;
- a bounded surface inside another bounded surface should be rare;
- avoid card-inside-card-inside-card nesting;
- visual density is driven by the task, not the route name;
- dense market tables and calm settings pages still use the same color, radius, border, focus, and typography grammar.

### 86.1 Route Density Mapping

| Surface | Density |
|---|---|
| Landing | Editorial |
| Dashboard | Standard / compact data |
| Screener | Dense |
| Sektor Hot | Dense / standard detail |
| Ranking | Dense |
| Bandarmologi | Dense |
| Broker Hunter | Dense |
| Insider | Standard + graph |
| Financial | Standard |
| Struktur Pasar list | Dense |
| Struktur Pasar detail | Standard |
| Watchlist | Dense |
| Portfolio Overview | Standard |
| Portfolio Positions / Journal | Dense |
| Track Record | Dense |
| Account/Auth | Standard |
| Admin | Dense operational |

---

## 87. Cross-Surface Selection & Detail Contract

Selection behavior must feel identical across list-driven pages.

### 87.1 Desktop Selection Behavior

When a table/list supports detail:

1. selected row receives brand-soft treatment plus a persistent brand edge/indicator so selection is not communicated by fill color alone;
2. detail appears without replacing or resetting the parent dataset;
3. filters, sorting, scroll position, and search remain intact;
4. closing detail returns attention/focus to the selected row;
5. selecting another row replaces detail content without rebuilding the whole page.

### 87.2 Mobile Selection Behavior

Decision-list surfaces use:

`compact row → tap → sheet/full detail → close → same list position`

Matrix tables that require cross-column comparison remain horizontally scrollable tables.

### 87.3 Cross-Route Research Handoff

Opening a ticker from Screener, Watchlist, Ranking, Sektor Hot, Broker Hunter, or Struktur Pasar may hand the ticker into Research when the implementation wave explicitly supports shared ticker context.

This is an interaction migration, not permission to change data semantics or browser history casually.

---

## 88. Data Meaning Precedence

When several visual states apply to one value or row, meaning follows this precedence:

1. **Availability / validity** — is there a trustworthy value?
2. **System or risk state** — stale, partial, warning, blocked, error, restricted.
3. **Selection** — is this item currently selected?
4. **Financial direction** — positive, negative, neutral.
5. **Brand emphasis** — primary action or current destination.

Examples:

- a selected losing stock remains visibly selected while the loss value remains negative;
- stale positive data is still marked stale;
- unavailable Free Float does not receive positive/negative treatment;
- a selected navigation item uses brand semantics, not market-positive green semantics.

Never allow brand color to erase data meaning.

---

## 89. System-State Precedence & Scope

System states must appear at the smallest truthful scope.

### 89.1 Local Scope

Use local state when one widget/data source fails.

Examples:

- Broker data unavailable;
- Financial snapshot partial;
- one chart request failed.

The rest of the workspace remains usable.

### 89.2 Page Scope

Use page-level state when the destination itself cannot produce meaningful content.

Examples:

- initial Struktur Pasar dataset failed with no cached snapshot;
- Screener access is denied;
- required route context is invalid.

### 89.3 Application Scope

Reserve full-screen operational states for:

- unauthenticated gate where required;
- blocked account;
- known maintenance;
- service status cannot be verified when the product intentionally refuses to open;
- mandatory account-completion flow.

Do not escalate a feature failure into an application outage.

---

## 90. Loading & Refresh Coherence

Section 80 is the single source of truth for loading lifecycle. Feature sections may describe geometry, but must not invent another lifecycle.

Canonical behavior across Auto-Cuan:

- shell appears independently from feature data;
- initial loading preserves final geometry as much as practical;
- valid cached/previous data remains visible during refresh;
- refresh indication is quiet and local;
- refresh failure keeps last-known valid data and marks the failure;
- a valid empty result is not an error;
- long-running anonymous shimmer transitions to truthful text;
- controls unrelated to the pending request remain usable.

### 90.1 Heavy Surface Rule

Financial and Struktur Pasar are explicit examples of a general rule:

> A feature should request the smallest trustworthy dataset needed for its first meaningful paint.

Do not load unrelated technical, broker, calendar, foreign-flow, or AI context before showing a simple fundamental/structure snapshot when a lighter supported data path can be safely provided.

This remains an implementation-planning rule until the actual API/database contract is verified.

---

## 91. Responsive Coherence Matrix

| Surface | Desktop | Tablet | Mobile |
|---|---|---|---|
| Landing | editorial multi-column composition | simplified composition | narrative stack + focused product crop |
| Dashboard | full-width ranked rows/history | stacked modules | single-column decision rows |
| Screener | table + optional detail pane | table + overlay detail | prioritized decision rows + detail sheet |
| Ranking | matrix table | matrix table / reduced columns | horizontal matrix or prioritized list only if comparison meaning survives |
| Financial | snapshot strip + provenance | compact snapshot | vertical metrics + provenance |
| Struktur Pasar | list + detail pane | list + overlay detail | compact list + detail sheet |
| Bandarmologi | table / split buyers-sellers | table / tighter split | Buyers/Sellers mode + detail |
| Broker Hunter | split accumulation/distribution | one dominant panel + switch | local mode switch + detail |
| Insider | roster + graph | roster/graph adaptable | Roster / Graph modes |
| Watchlist | table + detail | compact table | decision rows + detail sheet |
| Portfolio | local sections + optional drawer | stacked sections | section selector/sheet, no seven-tab strip |
| Track Record | ledger table | reduced columns | compact ledger rows/detail |
| Account | settings shell with section nav | stacked/nav selector | section selector + full-width forms |
| Admin | dense tables/forms | horizontal scroll where needed | task-specific operational layout, not card soup |

Rule: tablet is not merely “large mobile”. Keep data density where space allows.

### 91.1 Tablet Shell Contract (`768–1023px`)

- preserve full research capability;
- use a compact sidebar rail or safe drawer pattern according to available width;
- do not show the desktop 232–248px sidebar if it leaves the work area cramped;
- detail panes become overlays/drawers when the remaining content column would become too narrow;
- dense matrix tables may retain horizontal scroll;
- global search remains reachable without forcing a desktop topbar clone;
- account identity remains singular;
- software keyboard / safe-area behavior remains protected.

---

## 92. Theme Coherence

### 92.1 Canonical Redesign Theme

Light-first tokens and surface hierarchy define the target redesign.

### 92.2 Existing Dark Access

Current dark-theme access is a migration dependency, not permission for individual features to maintain separate dark-only design systems.

During implementation:

- do not silently remove theme switching;
- do not let Portfolio, Account, or older Research CSS keep unrelated private color systems indefinitely;
- modular feature CSS should consume canonical semantic tokens;
- dark-theme parity, if retained, should be generated from the same component grammar rather than hand-designed independently page by page.

### 92.3 Theme Independence

Layout, hierarchy, semantics, and component behavior must remain valid without relying on a specific theme.

A page that only “works” visually in dark mode has not passed the redesign.

---

## 93. Copy & Terminology Coherence

One concept gets one preferred product label inside a surface.

Canonical product-language guidance:

- **Screener** remains Screener;
- **Sektor Hot** remains the current product label, while explanatory text clarifies group/konglomerat semantics;
- **Struktur Pasar** is the user-facing destination; Free Float & HSC are its evidence categories;
- **Financial** may remain the route label, but do not use “Financial Canvas” as a decorative sub-brand unless the product deliberately chooses that name later;
- **Track Record** refers to Auto-Cuan signal outcomes, never user realized return;
- **Portfolio** refers to user planning/positions/journal context;
- **Analisis AI** is generated interpretation, not source data;
- **Subscription** in Account Center means entitlement/plan state; dormant standalone commerce remains separate.

Avoid mixing equivalent labels such as `Struktur Pasar` and `Struktur Pasar` randomly within the same user-facing surface. Internal code names may differ.

### 93.1 Canonical User-Facing Label Matrix

| Internal / accepted alias | Canonical UI label | Rule |
|---|---|---|
| `market-structure`, Market Structure | **Struktur Pasar** | user-facing destination |
| `financial`, Financial Canvas | **Financial** | no decorative “Canvas” sub-brand |
| `intel`, Intel | **Sinyal Intelijen** | canonical user-facing destination label |
| `WAIT_PULLBACK` | **Tunggu pullback** / approved humanized equivalent | never render raw enum |
| `A_PLUS_SETUP` | approved humanized setup/tier label | never render raw enum |
| `ENTRY_AREA` | approved humanized action label | never render raw enum |
| execution bucket enums | approved `Exec` label/value | never render raw enum |
| Profile | **Profil** | Account Center label |
| Security & Connections | **Keamanan & Koneksi** | Account Center label |
| Trading Preferences | **Preferensi Trading** | existing supported preferences only |
| AI Settings | **Pengaturan AI** | Account Center label |
| Subscription | **Langganan** | Account Center label |
| Terms | **Ketentuan** | Account Center label |

### 93.2 Glossary Rules

- **HSC**: use the acronym consistently; provide explanatory help where first-time comprehension benefits.
- **Free Float**: retain the established market term.
- **Exec**: shorthand for execution quality/state only where table density requires it; detail view should use the full label.
- **Tier**: setup/classification tier, not subscription tier.
- **Gate**: quality/safety gate state derived from the authoritative gate model; never imply a denominator that is not authoritative.
- **lot**: trading lot.
- **lembar**: individual shares. Never substitute one for the other.

---

## 94. Known Baseline Mismatches to Resolve During Implementation

These are observed current-state mismatches against the target specification. They are **not authorized hotfixes in this design stage**; they become acceptance items for the corresponding implementation waves.

1. The current signed-in shell can expose duplicate account/profile/subscription/logout entry points. Final target: one primary account identity surface.
2. Screener visibility can appear inconsistent while access/entitlement state resolves. Final target: deterministic access-aware navigation without bypassing backend authorization.
3. Current Financial presentation is visually over-framed and can show a large canvas around unavailable fields. Final target: compact verified snapshot with truthful availability/provenance.
4. Current Struktur Pasar is ticker-input-first. Final target: universe list-first with Free Float/HSC/status and click-to-detail.
5. Current Financial and Struktur Pasar may rely on a heavier context path than their first-paint information hierarchy requires. Final target: inspect and, only when safe, introduce the smallest trustworthy snapshot/list path.
6. Current CSS contains multiple visual generations, including independent dark-heavy feature skins. Final target: canonical token/component ownership with progressive legacy retirement.

These items must be solved in their planned waves, not patched twice against the old visual system unless a separate production-critical fix becomes necessary.

### 94.1 Historical Findings — Re-verify, Do Not Assume

Older audit material has referenced issues such as:

- quote/candle price-definition mismatch;
- R/R, SL, or lot display disagreement across surfaces;
- incorrect gate-count denominator;
- misleading `LIVE`/preview labels;
- preview banner visibility;
- clipped sidebar footer.

These are **not declared current bugs by this DESIGN.md**. Wave 0 must verify them against the current implementation baseline and only carry forward the items still reproducible.

---

## 95. Cross-Route Coherence Acceptance Matrix

Before a route is considered redesigned, verify:

| Question | Requirement |
|---|---|
| Does it use the canonical Page Header? | Yes, unless Landing/operational full-screen state |
| Does it use correct global/local navigation levels? | Yes |
| Does it consume canonical tokens? | Yes |
| Does it use the correct density class? | Yes |
| Are data availability/source/freshness deterministic? | Yes where the data contract supplies them |
| Does initial loading follow §80/§90? | Yes |
| Does refresh preserve valid data? | Yes where caching/current behavior supports it |
| Does mobile transformation preserve task meaning? | Yes |
| Is selection distinct from financial direction? | Yes |
| Are errors scoped locally when possible? | Yes |
| Does browser Back/Forward/deep-link still work? | Yes |
| Is account chrome non-duplicated? | Yes in final shell |
| Does reduced motion preserve all information? | Yes |
| Is the page still usable without decorative motion? | Yes |

---
---

## 96. Authority & Change Control

This file is the frozen **Auto-Cuan DESIGN.md v1.1**. The former v1.0 remains an audit-history baseline only; v1.1 supersedes it for target redesign decisions.

### 96.1 Authority Order

When implementation guidance conflicts, use this order:

1. **Security, authentication, entitlement, financial/data semantics, and authoritative backend contracts** — must remain correct.
2. **This DESIGN.md** — governs the target visual system, information hierarchy, component grammar, responsive behavior, state treatment, and redesign interaction intent.
3. **Current regression tests and verified runtime behavior** — preserve behavior until a migration explicitly replaces it.
4. **Legacy design documents and CSS** — evidence only; they do not override this specification when they conflict with it.

### 96.2 Before the First Repository Edit

Before implementation begins:

- re-read the current branch HEAD;
- compare it with the planning baseline recorded at the top of this document;
- identify files changed since the planning baseline;
- re-audit only the affected design/runtime contracts when those changes are material;
- record the implementation baseline SHA;
- run the relevant regression baseline before changing visual code.

A moved HEAD does not automatically invalidate this design. It requires compatibility review, not a redesign from zero.

### 96.3 Change Classes

The implementation classification in §3.4 remains binding:

- **Class A — Visual refactor:** may be implemented within an approved visual wave.
- **Class B — Interaction migration:** requires an explicit migration plan and equivalent regression coverage.
- **Class C — Product enhancement:** requires separate product approval and must not be smuggled into styling work.

### 96.4 Design Deviation Rule

If implementation must deviate from this document because of a verified repository, accessibility, browser, performance, or data-contract constraint:

- document the affected section;
- state the verified constraint;
- choose the smallest safe deviation;
- preserve the underlying design principle;
- update DESIGN.md as a versioned revision if the deviation becomes canonical.

Do not silently create a new local design system inside one feature.

### 96.5 Versioning

- `v1.0` remains historical audit baseline material.
- `v1.1` is the frozen canonical redesign contract.
- Small future clarifications that do not change product behavior may become `v1.1.x`.
- Material information-architecture, component, token, rollout, or interaction changes become `v1.2+`.
- New product capability remains outside a design-only revision unless separately approved.

### 96.6 Final Acceptance Principle

The implementation succeeds when Auto-Cuan feels like **one calm, precise financial intelligence workstation** across Landing, Dashboard, Discovery, Research, Monitoring, Account, Admin, desktop, tablet, and mobile — while preserving trustworthy data semantics, security, accessibility, performance, and existing business behavior.

**The workstation remains calm. The market is what moves.**
---

## 97. Market Session, Freshness & Sample-Data Contract

Freshness is a three-part decision:

`dataset freshness contract + market-session context + source timestamp`

UI components must not independently hard-code exchange session hours.

Human-facing session labels may include:

- Pra-pembukaan
- Sesi 1
- Istirahat
- Sesi 2
- Pasca-penutupan
- Bursa tutup
- Libur bursa
- Status sesi belum diketahui

A signal surface must not visually imply a currently actionable market session when the authoritative session state says otherwise.

Landing/product-preview data that is not a current production snapshot must be labelled **Data contoh**, **Preview statis**, or another equally clear truthful label.

---

## 98. Derived-Value Basis & Shared Plan Display Contract

Derived financial/trading values are not self-explanatory.

For values such as:

- R/R;
- stop distance;
- target distance;
- lot/position size;
- scenario P/L;
- planner allocation;

the system must preserve or expose the calculation basis when that basis is necessary to understand the number.

Canonical principle:

```text
authoritative stored/calculated value
→ shared selector / normalization
→ shared formatter
→ all user-facing surfaces
```

Do not let Dashboard, Screener, modal/detail, Telegram preview, Portfolio, or AI context independently re-derive the same display value with different assumptions.

If multiple legitimate scenarios exist (for example current-price basis vs planned-entry basis), label the basis explicitly rather than silently switching formulas.

---

## 99. Scoped Visual Rollout & Theme Parity

The redesign is rolled out incrementally.

Preferred mechanism:

- one deterministic shell-owned version/scope marker;
- migrated routes/surfaces opt into v2 tokens/components;
- legacy routes keep their existing theme contract until migrated;
- once parity is complete and regression-tested, v2 becomes the default and temporary scope machinery may be retired.

The exact attribute/class name is an implementation detail. The requirement is **scoped migration**, not a specific selector.

Rollback must be possible without reconstructing legacy styling from memory.

Dark mode:

- remains accessible during migration;
- migrated primitives require dark parity before a route is considered fully migrated;
- if parity is intentionally deferred, that route remains on its safe legacy theme;
- a broken mixed light/dark route is not an acceptable intermediate state.

---

## 100. Wave Evidence Pack & Handoff Log

Every implementation wave must leave evidence that another engineer/agent can inspect without relying on conversation memory.

Minimum wave record:

```text
Wave:
Baseline SHA:
Final SHA:

Scope:
Files changed:

Tests:
- suites/files:
- passed:
- failed:

Visual evidence:
- desktop:
- tablet:
- mobile:

Interaction checks:
- keyboard/focus:
- reduced motion:
- routing/back/forward/deep-link:
- auth/access if relevant:

Design-system checks:
- new hard-coded visual colors:
- token deviations:
- raw-enum exposure:
- secret/token DOM scan:

Performance:
- baseline:
- after:
- material regression:

Known deviations:
Follow-ups:
```

One append-only redesign progress log should link these records across all waves.

---

## 101. Global Sensitive-DOM & Security Presentation Rule

Security-sensitive raw values must never be used as visible UI decoration, debugging copy, hidden DOM text, data attributes, or accessible labels.

Prohibited examples include:

- API credentials;
- session cookies/secrets;
- reset tokens;
- privileged bearer tokens;
- device secrets;
- raw admin authorization tokens;
- secret environment values.

Human-facing role/status labels are allowed when intentionally part of the product experience.

The frontend must not become a secret-transport mechanism merely because the value is hidden by CSS.

---

## 102. Feature Retirement & Existing User Data

Retiring a UI surface is not the same operation as deleting its stored data.

Before Kelola Keuangan / Money Management becomes inaccessible to existing users, implementation planning must explicitly decide the user-data path:

- legacy read-only access;
- export;
- migration into another supported surface;
- temporary compatibility route;
- retention without UI access with a documented reason;
- or deletion only under a separately approved data-retention/deletion policy.

The redesign must not silently make existing user-owned data appear lost.

This is a migration/product decision, not a CSS cleanup task.

---

## 103. Additional Visual-System Tokens

### 103.1 Categorical Chart Palette

Charts that show categories/series rather than positive/negative financial direction use a dedicated categorical palette.

Rules:

- do not reuse financial positive/negative colors merely to distinguish arbitrary series;
- ensure adjacent series remain distinguishable by hue and, where needed, line style/marker;
- legends and direct labels remain readable in both themes;
- accessibility must not depend on color alone.

Canonical categorical chart tokens:

```css
/* Light research surfaces */
--ac-chart-cat-1: #315F9A;
--ac-chart-cat-2: #7357A6;
--ac-chart-cat-3: #94602B;
--ac-chart-cat-4: #2F6F86;
--ac-chart-cat-5: #8C4F73;
--ac-chart-cat-6: #536A7C;

/* Dark research surfaces */
--ac-chart-cat-1-dark: #8BB2E8;
--ac-chart-cat-2-dark: #B9A0E3;
--ac-chart-cat-3-dark: #DFB277;
--ac-chart-cat-4-dark: #7FB7CF;
--ac-chart-cat-5-dark: #D995B7;
--ac-chart-cat-6-dark: #A9BDCF;
```

These tokens are scoped to categorical chart marks and must not be reused as general UI status colors. If more than six simultaneous series are required, add line style/marker differentiation before inventing more hues.

### 103.2 Z-Index Layers

Use semantic layers rather than arbitrary `9999` escalation:

```css
--ac-z-base: 0;
--ac-z-sticky: 20;
--ac-z-shell: 40;
--ac-z-popover: 60;
--ac-z-drawer: 80;
--ac-z-modal: 100;
--ac-z-toast: 120;
--ac-z-critical-gate: 140;
```

Legacy overlays may temporarily retain higher raw values until migrated and regression-tested, but all v2 surfaces use the semantic tokens above.

### 103.3 Sizing / Row Tokens

Canonical shared sizing tokens:

```css
--ac-row-dense: 38px;
--ac-row-comfort: 42px;
--ac-control-sm: 36px;
--ac-control-md: 42px;
--ac-touch-target: 44px;
--ac-topbar-height: 52px;
--ac-sidebar-width: 240px;
--ac-sidebar-rail: 68px;
```

`--ac-control-sm` is primarily a pointer/desktop visual size. On touch surfaces, its effective interactive hit area must still reach the 44px-class target without overlapping adjacent controls.

Feature CSS should consume shared size tokens rather than inventing near-duplicate dimensions.

---

## 104. Auto-Cuan Signal Line Specification

The **Auto-Cuan Signal Line** is a restrained brand motif, not a chart and not a fake market signal.

Allowed use:

- landing hero;
- one or two editorial transitions;
- optional closing motif;
- static brand-detail use where subtle.

Visual character:

- thin SVG/path line;
- deep ink and/or brand emerald;
- no glow;
- no neon;
- no continuous pulse;
- no implication that the path represents live price data unless it actually does.

Motion:

- one-time draw/reveal may use Anime.js only if native WAAPI/CSS is insufficient;
- hero choreography remains within the global motion ceiling;
- reduced-motion users receive the final static line immediately.

Do not repeat the Signal Line as a decorative background across every signed-in page.

---

## 105. Trust / Investment-Context Copy Placement

Auto-Cuan contains Entry, SL, TP, signal, risk, and AI interpretation surfaces. Trust copy must be discoverable without turning every row into a disclaimer wall.

Placement grammar:

- Landing: one clear trust/risk statement near product explanation or closing trust section;
- Registration/Terms: full applicable product terms;
- AI analysis: compact reminder that generated interpretation is decision support, not source data;
- signal/trade-plan detail: low-noise contextual wording where it materially prevents misinterpretation;
- Portfolio/Risk Lab: wording must distinguish mathematical planning/guard calculations from execution advice.

Exact legal/regulatory wording is **not invented by this design document**. It should be reviewed against applicable Indonesian/OJK requirements by an appropriate legal/compliance source before being treated as a legal compliance statement.

---
---

## 106. Final Freeze Declaration

This document has passed the v1.1 contradiction, authority, terminology, token, rollout, state, responsive, and implementation-boundary pass.

Canonical decisions are frozen as follows:

- §82 is the single authoritative implementation order;
- §96 defines authority and change control;
- user-facing destination terminology follows §93;
- financial/data semantics remain subordinate to authoritative backend contracts, never to visual convenience;
- historical audit findings are re-verified in Wave 0 before being treated as current bugs;
- scoped v2 rollout prevents half-migrated light/dark surfaces;
- implementation waves require evidence packs, not completion claims alone;
- repository mutation still requires explicit user authorization.

The design contract is complete enough to begin implementation planning without further visual exploration.

**The workstation remains calm. The market is what moves.**
