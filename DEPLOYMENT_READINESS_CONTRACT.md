# Deployment Readiness Contract

## Purpose

This module is a fail-closed, deterministic preflight contract. It evaluates whether a release may be presented for a final manual execution review. It is not a deployment executor and does not contact Render, Telegram, a hosting provider, a database, or a secrets store.

## Required gates

1. The immutable release candidate is approved and has a valid artifact SHA-256.
2. A separate deployment-authorization record exists for the same release.
3. The release report proves completed sandbox execution, all tests passed, no skipped/todo/cancelled tests, and all acceptance tests passed.
4. The target provider, service ID, environment, and artifact digest are explicit and confirmed.
5. A separate execution approval matches the exact release, artifact, provider, service ID, and environment. This approval is distinct from the stored deployment authorization.
6. Every required preflight check is present exactly once, passed, and accompanied by bounded evidence:
   - `artifact_integrity`
   - `target_configured`
   - `runtime_compatibility`
   - `secrets_available`
   - `rollback_plan`
   - `health_check`

Evidence must describe the check result; callers must never pass secret values or credentials into this module.

## Result semantics

- `readyForManualExecutionReview=true` means only that the supplied evidence satisfies this contract.
- `executionAllowed` is always `false`.
- `deployed` is always `false`.
- `readinessSha256` fingerprints the release status and artifact digest, test summary and acceptance-test identities, authorization identity and digest, exact target, execution-approval identity and digest, checks, and blockers.
- Test counters must be finite non-negative safe integers; the total must be positive and all tests must pass with no skipped, todo, failed, or cancelled tests.
- Missing, duplicated, mismatched, malformed, or failed evidence produces blockers.

## Explicit non-goals

- No provider API calls or deployment executor.
- No Render configuration, production environment variables, secrets, webhooks, workers, or Neon production changes.
- No automatic promotion from staging to production.
- No claim that a target is reachable merely because a check was supplied as passed; the caller must provide trustworthy evidence from a future isolated preflight implementation.
