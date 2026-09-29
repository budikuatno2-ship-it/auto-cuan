# Precision workspace: review and deployment notes

## Scope

Branch `fix/precision-workspace-finance`, based on `ba30c0b80e49e154d9b4d36be56ae60bbd643fe9`. PR target: `feat/daytrade-screener-v1`. No direct push to target, merge, production SQL, or VPS deployment is part of this change.

The workspace sidebar is fixed to the viewport, with independently scrollable navigation and a docked profile/theme area. Analysis destinations move into the Riset pasar group; their existing IDs, entitlement checks and panels remain. Portfolio retains its original seven tabs, appearance sources, financial model and records. Its CSS is compiled into a scoped SPA stylesheet instead of leaking standalone body/root/tab rules into every page. Its event handlers are also scoped and bound once. The shared application copyright footer is removed; contextual data warnings and landing-page disclosures remain.

Finance now provides an editable budgeting worksheet: add/delete rows, type/category/name/amount/notes, keyboard navigation, undo/redo, atomic multi-cell paste, search, sorting and CSV export. It deliberately is not an Excel formula engine, arbitrary workbook editor or broker ledger. Maximum 300 rows, integer rupiah up to 1 trillion per row. No new production dependency, polling timer, formula eval, or row animation. Editing updates existing cell nodes rather than replacing the table on every keystroke.

## Financial data contract

Monthly cashflow and Portfolio assets are different measures. The worksheet computes income minus expenses, savings and explicit trading transfers. Portfolio exposure and P/L are displayed separately; they are not silently added to income or subtracted from this month's budget. Portfolio uses saved plans, which are not proof of executed brokerage positions. The UI explicitly says **Eksposur rencana** and **P/L dari harga tersimpan**.

The link reads the currently verified user's same-device Portfolio storage with the existing shared model. It updates after Portfolio changes, cross-tab storage changes and focus. If that source is absent, a read-only server summary uses that user's existing `app_user_portfolio_state`. Missing data stays unavailable, not fictitious zero. This change does not introduce cross-device brokerage synchronization or delete the old trading journal table/API. Only the duplicate journal view in Finance is removed.

## Persistence and rollout prerequisite

1. Back up `user_personal_cashflow` and confirm the original money-management schema is installed in the intended database.
2. Review and apply `supabase/money-sheet-v1-migration.sql` to staging first. It adds nullable JSON worksheet data, an optimistic revision and a guard against old clients overwriting an established worksheet without advancing the revision. Existing RLS/service-role privileges remain.
3. Test a real authenticated account with existing monthly records, a new month, two browser tabs causing a revision conflict, logout/login, and existing Portfolio records. Verify amounts before and after. Local/CI tests use isolated or mocked data, not a production account.
4. After review, apply the additive migration to production before deploying the new code. Without it the Finance UI reports storage/migration unavailable rather than pretending a save succeeded.
5. Use the repository's existing preflight/atomic deploy procedure only after merge authorization. Verify branch SHA and PM2 application identity first. No SSH key or production secret is committed.

A save is acknowledged only after the server confirms the authenticated user and revision. Concurrent edits use user+month+revision compare-and-swap. Failure/conflict keeps edits in memory and permits export; reload/discard requires confirmation. This is not offline durable storage: unsaved changes can be lost if a browser is forcibly closed, despite the beforeunload warning. An old UI cannot edit an established worksheet after rollback unless a reviewed compatibility migration is performed. Do not drop the JSON columns or the guard as an automatic rollback.

## Verification ledger

Local checks completed before PR: 164 Node tests passing across new sheet model/handler and existing Portfolio, navigation and theme suites; all 968 JavaScript files plus 6 index inline scripts parsed; generated Portfolio CSS reproducibility checked. Offline Chromium integration executes real component markup/styles/runtime with mocked I/O: 31 checks for editing focus, invalid inputs, undo/redo, multi-cell paste, save conflict, edits during a save, linking, account clearing, light/dark, sidebar scroll/collapse and mobile layout; no uncaught page errors in that fixture. Screenshots use test amounts, never account data.

CI workflow `Precision workspace regression` adds actual whole-SPA navigation against the local preview server, isolated PostgreSQL migration/CAS/legacy-write/RLS checks and a normal build. Their status is the workflow result, not this document's assertion of success. Review the resulting artifacts and the PR checks before merging. Real broker connections, live AI responses, user Supabase data, low-end real devices and VPS deployment have not been validated by local component tests.

Motion uses the existing tokens. There is no animation on table row updates, no fake progress, no forced wait before cached content is shown. Full app navigation is epoch-guarded and partial loads are singleflight. Reduced-motion disables the workspace fade. Browser QA dependencies are listed separately in `tools/precision-test-requirements.txt` and are not deployed as application dependencies.
