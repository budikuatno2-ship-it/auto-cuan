# Auto-Cuan — Workstation Design System

Last updated: 2026-08-18

This document records the visual and interaction contracts behind the premium workstation layer. It is intentionally implementation-oriented so future UI work does not regress into inconsistent card-heavy styling.

## Design intent

Auto-Cuan should read as a serious financial workstation: restrained, information-dense, fast to scan, and explicit about system state. The visual system should support decision-making rather than compete with the data.

Avoid generic AI/SaaS aesthetics: excessive gradients, oversized rounded cards, decorative glass effects, gratuitous glow, novelty animation, and visual hierarchy driven mainly by marketing chrome.

## Core palette

Primary canvas: graphite/near-black.

Primary accent: emerald, reserved for active/positive/product-action emphasis rather than used as ambient decoration everywhere.

Financial semantic colors remain distinct from the brand accent:

- bullish/positive: restrained green;
- bearish/negative: restrained red;
- warning/risk/freshness concern: amber;
- informational states: muted blue.

Do not use brand color to override the semantic meaning of market states.

## Surfaces

Prefer continuous work areas and data bands over many isolated floating cards.

Use borders and spacing before shadows. Shadows should communicate elevation only where elevation has meaning (modal, overlay, exceptional floating surface).

Corner radii should remain compact. Large pill/rounded-card treatment is reserved for controls where the shape improves interaction clarity.

## Typography and numbers

Financial numbers should use tabular numerals where available.

Hierarchy should come from size, weight, spacing, and alignment—not from many competing colors.

Section labels may use small uppercase tracking to create terminal-like orientation, but body copy must remain readable and natural.

## Tables

Tables are primary product surfaces, not secondary components.

Expected behaviors:

- sticky headers where the data region scrolls;
- sticky ticker/first column on primary financial tables when horizontal scrolling would otherwise lose row identity;
- restrained row hover;
- compact header typography;
- preserved semantic coloring;
- stable scrollbar space where useful;
- mobile horizontal scrolling rather than destructive column compression when data cannot fit safely.

## Navigation

Desktop navigation should feel like a compact command bar rather than a set of large marketing buttons.

Mobile navigation must preserve touch safety and safe-area spacing. Active destination should be identifiable without relying on color alone where practical.

## Dashboard

The dashboard is a command center.

- greeting/context header establishes workspace state;
- market condition belongs in a continuous instrument strip;
- Top 5 and Auto Monitor read as a radar workspace;
- history is subordinate but easy to scan;
- status/freshness metadata should not be visually hidden behind decorative elements.

## Screener

Controls should behave like a compact dock. Results should receive more visual weight than filter chrome.

Do not change ranking or financial semantics as part of a visual redesign.

## Analysis / AI surfaces

Analysis input should behave like a command surface. Long-form AI/analysis output prioritizes reading rhythm, clear headings, restrained code styling, and stable follow-up controls.

AI presentation must not imply certainty beyond the underlying data/model result.

## Landing page

The public landing page should feel editorial/fintech rather than generic SaaS.

Use real product vocabulary and factual product boundaries. Static mock data must remain recognizable as preview/demo data and must not be represented as live market data.

Prefer product explanation, operating boundaries, and decision workflow over unverified performance claims.

## Loading, empty, error, maintenance

These states are part of the product, not afterthoughts.

Each state should answer:

1. What is happening?
2. Is user action required?
3. Is existing data safe/unchanged?
4. What can the user do next?

Avoid alarming animation unless the state is genuinely urgent.

## Accessibility

Minimum expectations:

- visible keyboard focus;
- semantic labels on key navigation/data groups;
- readable contrast;
- reduced-motion mode;
- `prefers-contrast` improvements where supported;
- 44px-class mobile form targets where practical;
- iOS input sizing that avoids focus zoom;
- safe-area handling on mobile overlays/navigation.

## Performance

Visual polish must not become a reason for heavy runtime JavaScript.

Prefer CSS for presentation. Lower marketing sections may use `content-visibility`/containment where safe. Avoid expensive continuous animation, large unbounded blur layers, or observers/timers added solely for decoration.

## Review checklist

Before accepting a visual change:

- compare 390px, tablet, and wide desktop layouts;
- inspect dense tables, not only empty/demo states;
- check keyboard focus;
- check reduced motion;
- check long text and long ticker/company labels;
- check loading/error/maintenance surfaces;
- confirm trading/auth/API behavior was not changed accidentally;
- run repository regression/build gates.
