# Auto-Cuan — Due Diligence Overview

Last updated: 2026-08-18

This document is a compact technical/product orientation for reviewers. It describes current repository and product boundaries; it is not a financial, regulatory, or security certification.

## Product scope

Auto-Cuan is an IDX-focused stock-analysis workspace. Its user-facing surfaces include market/radar summaries, screeners, chart/analysis views, portfolio tooling, subscription/account surfaces, and operational monitoring integrations.

The product is intentionally positioned as an analysis and decision-support tool. It does not execute brokerage transactions and does not act as a custodian of user funds.

## Financial-safety boundary

Changes to presentation must not silently alter financial behavior. Treat the following as protected contracts:

- screener ranking/scoring semantics;
- entry, stop-loss, take-profit, and target calculations;
- day-trade/swing/pattern decision semantics;
- portfolio calculations and persistence semantics;
- market-data freshness/stale handling;
- Telegram/automation behavior that carries trading information.

Visual refactors should remain presentation-only unless a separate, explicitly reviewed financial-logic change is intended.

## Data freshness

Market-derived data can become stale or arrive late. UI and runtime code should preserve freshness metadata/warnings rather than presenting old observations as current. A successful render is not evidence that the underlying market observation is fresh.

## Delivery controls

The production branch is protected and repository rules require changes to flow through pull requests/status checks. Current CI includes, among other focused workflows:

- Repository Security Gate;
- CodeQL JavaScript analysis;
- Web hardening regression / production build contract;
- Admin command-login PostgreSQL harness;
- Portfolio-persistence PostgreSQL harness.

These controls reduce regression risk. They do not represent an external security audit or regulatory certification.

## Cache boundaries

Deployment configuration intentionally separates cacheable static assets from application/API surfaces. API routes and application HTML routes are configured with private/no-store behavior, while selected versioned static runtime/assets may use public caching.

When extracting runtime code or styles into new static assets, cache policy is part of the change and must be reviewed explicitly.

## Runtime decomposition

Large application-shell concerns are being decomposed conservatively to reduce HTML parse weight and improve cacheability without changing execution order or financial behavior. Already separated concerns include the shell stylesheet and selected market/day-trade runtime boundaries.

Externalization by itself is a parse/cacheability improvement; it should not be described as runtime execution savings unless the code is actually deferred or lazy-loaded.

## Security posture

The repository uses source/static-analysis and regression gates as engineering controls. Public-facing trust material must not claim certifications, regulator approval, penetration-test results, or guarantees that are not evidenced by an actual external assessment.

Do not commit credentials, session material, private user data, HAR files containing authorization headers, or secrets used by production services.

## Redesign principles

The premium workstation redesign is intended to improve usability, information hierarchy, mobile ergonomics, accessibility, product identity, and rendering efficiency while leaving trading/backend behavior unchanged.

Design direction:

- serious IDX workstation rather than generic SaaS/AI-template visuals;
- restrained graphite surfaces with emerald as the primary accent;
- dense but readable financial data;
- tabular numerals and strong table hierarchy;
- explicit loading, empty, stale, error, and maintenance states;
- visible focus states and reduced-motion support;
- mobile safe-area and touch-target safety;
- public product identity that remains factual and avoids unverifiable claims.

## Known review limitations

A green CI state is necessary but not sufficient for product acceptance. Before a high-impact visual/runtime merge, reviewers should still inspect the deployed preview on representative desktop and mobile widths, authenticated and unauthenticated states when fixtures/accounts are available, and failure/stale-data states where practical.

## Acquisition/readiness interpretation

Repository quality, documentation, test discipline, security boundaries, product clarity, and visual polish can improve diligence quality and reduce perceived execution risk. They do not by themselves determine a business valuation; commercial traction, IP ownership, data rights, regulatory posture, unit economics, team, contracts, and market position remain separate diligence areas.
