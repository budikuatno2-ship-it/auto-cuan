# Keyboard and VPS performance follow-up

## Scope and release state

Continues PR #787 on `fix/precision-workspace-finance`, baseline `6bf44f8`.
Portfolio arithmetic, its seven tabs, journal records, entitlement and account
logic are unchanged. Vercel is not this owner's deployment target; its checks
are not used to assess VPS readiness. No merge, SSH, Nginx reload, PM2 restart
or VPS deployment has been performed in this follow-up.

## Supabase: applied and verified, not merely prepared

The owner connected Supabase and authorized automatic application. The active
Auto-Cuan project was matched to the repository's deployment reference.
Read-only preflight confirmed the UUID account primary key, absence of the
cashflow table, and absence of the two trigger functions. The existing staging
project was inactive and was not resumed or billed by this work.

`autocuan_money_sheet_setup`, version `20260929091801`, was successfully applied
through the migration connector to the active MAIN project on 2026-09-29.
Post-verification confirmed the 15 columns, primary key, account foreign key,
unique user/month constraint, both enabled triggers and fixed function search
paths. RLS is enabled. `anon` and `authenticated` have no direct table CRUD
privileges; `service_role` has the backend CRUD privileges required by the
existing authorized handler. No account/Portfolio data was modified; the new
table was empty. No production test account or fake transaction was inserted.

The repository's setup and additive SQL now include the same fixed search path
as the applied revision guard. The remote migration is recorded in Supabase's
migration history. Do not execute the setup again simply because this PR is
not merged. Do not disable RLS or place a service-role credential in a browser.
A database backup/restore exercise was NOT performed or claimed. This operation
created absent cashflow objects within a bounded transaction; it did not rewrite
existing user records. End-to-end saving through the live website is still a
separate verification after the matching application code is deployed.

## Keyboard and editing changes

One `AutoCuanViewport` owner coalesces resize/scroll notifications per frame and
shares geometry with the old mobile/chart runtime. It does not overwrite normal
document height or disable pinch zoom. Focused editable controls plus substantial
unzoomed viewport loss activate keyboard-only dialog/worksheet layout. Dialogs
account for the visual viewport's panning offset; focused controls are revealed
inside their real scroll containers instead of centering the document repeatedly.

Composition lifecycle and legacy Android keyCode 229 guard login, modal Escape,
formula bar and grid navigation. Notes preserve multiline Enter, caret movement
and plain multiline paste. All four main HTML entrypoints load the same runtime.
The old chart owner skips dimension-identical resizes and avoids reconnecting
its shell observer on every retry. Existing motion tokens remain in place;
keyboard sizing is immediate, not a competing animation system. NumberFlow
formatters are reused and its easing reads the existing shared tokens.

## Performance changes and evidence

Grid selection updates only cells whose selection actually changes. Repeated
numeric formatting, computed-cell assignment and save-state labels are avoided.
A 300-row / 15-input Chromium fixture recorded **zero selection class/ARIA
attribute mutations** during typing. This does not mean zero total DOM updates
or a measured production INP; it establishes avoided selection work only.

The actual fallback Node web server now uses an asynchronous static responder,
bounded 16 MiB / 128-entry cache and shared in-flight reads/compression. Large
files stream with backpressure. Mutable public assets support ETag/304 rather
than one-week forced immutable caching. HTML, JSON, data and errors remain
non-publicly-cacheable; API/auth handling is outside the responder. Traversal,
hidden paths and escaping symlinks are rejected.

Nginx's API prefix cannot be captured by the asset-extension regex. Its template
respects the origin cache policy rather than publicly caching mutable files or
errors. The actual VPS Nginx/Cloudflare configuration remains uninspected.
Existing production compression may already be enabled: local response-size
measurements are NOT evidence of the same percentage live-VPS speed improvement.

`node tools/benchmark-static-assets.js` verifies decompressed byte equality,
ETag responses and repeated compression reuse on a loopback-only server.
For index.html, the measured body is 945,609 bytes raw / 207,230 bytes Brotli
(78.1% smaller). The CSS body is 148,601 / 36,292 bytes (75.6% smaller).
The measurement report, not hardcoded percentages, is the source for later runs.

## Tests and limits

At the recovered final implementation locally: 244 existing focused Node tests
and 16 new viewport/static tests passed. Existing component/landing/detail
Chromium suites passed 35 / 105 / 66 checks. The new simulated-keyboard fixture
passed 39 checks, zero uncaught errors. Added tests are registered in the full
568-file list; the original 75-file smoke selection is not expanded past its cap.

The new fixture runs on Chromium and can run on WebKit via `BROWSER_ENGINE`.
Check the actual final CI result before claiming WebKit/full-app/full-suite
success. Earlier pre-reset test results are not substituted for final-source
validation. Simulated VisualViewport, IME events and desktop browser engines are
NOT physical Android/iPhone keyboards. API/auth are mocked. No live VPS
LCP/INP/latency, physical-device testing or whole master-checklist sign-off is
claimed. Review the last source SHA's CI before merge, then deploy through the
existing VPS preflight workflow and verify real authenticated saves.
