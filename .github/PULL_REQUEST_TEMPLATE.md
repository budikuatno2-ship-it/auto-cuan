## Change summary

<!-- What changed and why? Keep financial/runtime behavior explicit. -->

## Change class

- [ ] Visual / UX only
- [ ] Runtime / performance
- [ ] API / database
- [ ] Auth / subscription / admin
- [ ] Financial / market-data behavior
- [ ] Automation / Telegram / cron
- [ ] Documentation / public identity

## Protected financial boundaries

If this PR is not intentionally changing financial behavior, confirm all applicable items:

- [ ] Screener ranking/scoring semantics unchanged
- [ ] Entry / stop-loss / take-profit / target calculations unchanged
- [ ] Portfolio calculations/persistence semantics unchanged
- [ ] Market-data freshness/stale behavior unchanged
- [ ] Day-trade / swing / pattern decision semantics unchanged
- [ ] Telegram/automation trading-message semantics unchanged

If any item changed intentionally, explain the old contract, new contract, test evidence, and rollout/rollback plan.

## Cache / privacy boundary

- [ ] New or extracted static assets have an explicit cache policy
- [ ] API/application-private surfaces remain private/no-store where required
- [ ] No credentials, tokens, session material, HAR secrets, or private user data are committed

## UX / accessibility

For user-facing changes:

- [ ] Desktop wide state reviewed
- [ ] Tablet state reviewed
- [ ] Mobile ~390px state reviewed
- [ ] Long text / dense table state considered
- [ ] Loading / empty / error / maintenance states considered
- [ ] Keyboard focus remains visible
- [ ] Reduced-motion behavior remains safe
- [ ] Mobile touch targets / safe areas remain usable

## Validation

- [ ] Focused tests pass
- [ ] Production build contract passes
- [ ] Repository security gate passes
- [ ] CodeQL / static analysis checked when applicable
- [ ] `git diff --check` clean
- [ ] Deployment/preview inspected when the change is visual or runtime-facing

## Freshness / market-data review

Describe how this change treats stale or delayed market observations. If not applicable, write `N/A` rather than deleting this section.

## Rollback

Describe the smallest safe rollback unit (commit, asset, feature flag, or runtime boundary).

## Claims review

- [ ] Public copy does not invent performance guarantees, regulator approval, certifications, audits, or security guarantees that are not evidenced
- [ ] Demo/static market data is not presented as live data
