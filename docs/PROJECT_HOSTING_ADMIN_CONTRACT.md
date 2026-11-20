# Project Hosting and Admin Decision Contract

This contract turns the accepted platform policy (hybrid hosting, optional admin) into explicit per-project decisions.

## Platform policy versus project choice

- The platform policy is fixed: `hostingModel=hybrid`, `adminPanel=optional`.
- Each project must explicitly choose `factory`, `customer`, or `split` hosting placement.
- A split project maps each required component independently to factory or customer hosting.
- Each project must explicitly choose `none`, `telegram_only`, `dashboard`, or `both` for its admin surface. `undecided` is allowed during design but blocks deployment readiness.

## Required project architecture record

`project-architecture.js` normalizes and validates:

- `hostingPlacement`
- `componentHosts` for Telegram bot, website, admin dashboard, API, background worker, database, and file storage
- `accountOwner`, `dataOwner`, `secretsOwner`, `operationsOwner`, and `rollbackOwner`
- `adminSurface` and `adminReason`

The validator never guesses an owner or fills an unresolved choice with a default deployment target.

## Fail-closed readiness

`evaluateProjectArchitectureReadiness` returns blockers for unresolved hosting, missing component mappings, unresolved ownership and rollback responsibility, and missing admin-surface decisions or rationale. Callers must keep release/deployment readiness blocked while any blocker remains.

This module is a deterministic contract only. It does not provision infrastructure, expose secrets, contact providers, enable webhooks, execute customer code, or deploy projects.

## Integration sequence

The next integration step is to attach the normalized architecture record to the immutable design/release artifact, pass required components from the approved project specification, and include these blockers in deployment preflight evidence.
