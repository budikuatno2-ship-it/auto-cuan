# Keyboard and VPS performance follow-up

## Scope and release state

Continues PR #787 on `fix/precision-workspace-finance`, baseline `6bf44f8`.
Portfolio arithmetic, its seven tabs, journal records and entitlement rules
are preserved. A confirmed-access visibility bug is corrected without changing
the authentication decision or relaxing access checks. Vercel is not this owner's
deployment target; its checks are not used to assess VPS readiness. No merge,
SSH, Nginx reload, PM2 restart or VPS deployment was performed in this follow-up.

## Supabase: applied and verified, not merely prepared

The owner connected Supabase and authorized automatic application. The active
Auto-Cuan project was matched to the repository's deployment reference.
Read-only preflight confirmed the UUID account primary key, absence of the
cashflow table, and absence of the two trigger functions. The existing staging
project was inactive and was not resumed by this work.

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
For index.html, the measured body is 945,954 bytes raw / 207,381 bytes Brotli
(78.1% smaller). The CSS body is 148,601 / 36,292 bytes (75.6% smaller).
The measurement report, not hardcoded percentages, is the source for later runs.

## Confirmed-access visibility regression

A cold-start full-app test reproduced a real pending-to-approved transition bug:
`applyPremiumAccessUi` hid the selected finance page while access was pending,
but never removed that hidden class after the existing server check approved the
user. The fix reveals only the currently selected page after confirmed access.
Pending/unavailable responses remain inert/hidden; definitive denial still clears
rendered data and routes away. Top-level account/maintenance gates are unchanged.
Four dedicated tests cover the transition and denied/pending states.

## Test synchronization

Controlled WebKit runs showed that a fixed 70 ms fixture sleep sometimes read
old published viewport/layout state. The fixture now awaits the owner's actual
geometry (mapping offsetTop/offsetLeft to top/left), its keyboard class, and two
render frames. This changes test scheduling, not application CSS or assertions:
keyboard bounds, IME, pinch zoom, focus and restoration checks remain enforced.
The deterministic fixture also passes locally on Chromium.

## Tests and release boundary

The final inspected source was committed as `37a8658524c38cbf8f1ac6736d3d4ae81051d3bd`
only after run `36554738217` passed syntax/scoped CSS checks, 274 focused tests,
the 75-file smoke build and all 569 registered regression files. No file was
skipped to produce that passing full-suite result.

Its artifact `11028020704` was downloaded, checksum-verified and inspected:
SHA-256 `f180fbc82117620d66deded7023f00fe87a6887773ad5d2013ab5006158e2479`.
The actual reports show 35 component, 44 whole-SPA, 105 landing/auth/sidebar,
66 NumberFlow/grid/detail, 39 Chromium-keyboard and 39 WebKit-keyboard checks
passing, with no uncaught page errors. These counts overlap in what they cover;
they are not advertised as that many unique production user journeys.
The 300-row, 15-input case recorded zero selection-class/ARIA mutations in both
engines. This is not zero total work or a production speed guarantee.

The permanent regression workflow now includes the new keyboard/static/access
checks and a separate WebKit job. Temporary source/diagnostic transfer workflows
are removed. The follow-up documentation/CI cleanup changes no production
runtime beyond the verified source commit; check the latest PR checks before
release as well as the source-validation run above.

Physical Android/iPhone keyboards, authenticated production saving and real VPS
LCP/INP/latency remain unverified. Desktop WebKit with a synthetic VisualViewport
is not a physical iPhone. No whole master-checklist or zero-bug sign-off is
claimed. Database setup succeeded independently of deployment; the new UI and
static-serving path must still be released through the normal PR/VPS process.
Inspect the actual PM2 entrypoint and Nginx configuration before deployment.
