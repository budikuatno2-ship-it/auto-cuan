# Landing and mobile follow-up - 2026-09-29

## Scope and source

Continue PR #787 on `fix/precision-workspace-finance`. Baseline remote commit:
`78c8efbaff1569da818d025b580aa5f2b79f63ca`. Read the provided Design System,
SPA & Motion guide and the actual landing, shell, theme, authentication,
Portfolio/finance surface and existing test code before changing them.

## Reproduced / corrected

1. Desktop landing menu hidden by the global hidden utility. A single menu now
   serves desktop and mobile, with disclosure, Escape and anchor focus handling.
2. Light landing inherited dark-only surfaces and unreadable heading contrast.
   Scoped token-based surfaces, text, cards and theme toggle now cover landing.
3. Registration card extended beyond a short viewport. Dialogs now use bounded
   dynamic viewport heights, internal scrolling, safe-area padding and 44px
   controls; mobile text fields are 16px. Desktop Portfolio tabs/layout unchanged.
4. Modal focus used competing timers and omitted dynamic reset/Terms dialogs.
   Extend the existing manager, retain authentication handlers, restore focus,
   lock background, support nested Terms, and keep Escape to the topmost dialog.
5. Landing fetch errors/body stalls left loading placeholders indefinitely.
   Singleflight requests with a 5-second overall deadline now expose retry and
   unavailable/stale state. Array order no longer fabricates Entry/Watch status.
6. Legacy section intrinsic-height placeholders made marketing layout unstable.
   Small static sections now use real height. Native reveal is fail-open, once,
   token-based, and immediately cancelled on reduced-motion changes.
7. Sidebar open is idempotent, restores its own previous inert state, and closes
   before profile navigation. Mobile sidebar and worksheet controls are larger.
8. Register the previously omitted precision-motion-cascade regression, add
   landing coverage, wire it to CI, and bump changed runtime cache keys.

## Verified locally

- 200 targeted Node tests passed (the full focused workspace suite plus new
  landing contracts); an additional accessibility-focused run passed 36 tests,
  with overlap. Do not sum overlapping runs as unique tests.
- 971 JavaScript files and 5 inline scripts parsed successfully.
- 35 existing offline Chromium worksheet/navigation component checks passed.
- 73 new offline Chromium landing/auth/sidebar checks passed. Real repository
  markup, CSS, handlers and auth-v2 reset runtime; API/auth environment mocked.
  Light and dark, widths 320/360/390/768/1024/1440, form heights 320/450/568/844,
  nested modal focus, stale/error/body-timeout/retry and reduced-motion coverage.
- No uncaught page errors in the two offline browser runs.

## Limits and release gates

Local full build was blocked by missing npm packages. Offline npm ci confirmed
an uncached package; this is NOT recorded as a successful build. Browser direct
navigation to the local preview server is disabled in this execution environment;
full-app tests must run on the existing isolated GitHub runner. Review CI at the
latest source SHA, not a previous snapshot.

No production SQL, merge, SSH, PM2, deployment or subscription/security changes.
No real-device Safari/Android keyboard or authenticated staging test was run.
No production latency/INP/LCP measurement or zero-bug guarantee. Native motion is
implemented, but full third-party NumberFlow digit rolling is not included.

The unchanged money-sheet migration still requires the existing
user_personal_cashflow table. Back up and test in staging before production.
