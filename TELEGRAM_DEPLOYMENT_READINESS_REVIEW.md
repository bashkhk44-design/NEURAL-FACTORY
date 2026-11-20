# Telegram Deployment Readiness Review

This phase connects the existing immutable release and deployment-readiness contracts
to the manager bot as a read-only review action.

## Manager flow

1. Customer approval and manager approval remain required before a release is approved.
2. The manager issues the separate deployment authorization.
3. The manager may open a Telegram readiness review for that exact release.
4. The bot recomputes the immutable artifact SHA-256 and deployment-authorization digest.
5. The bot evaluates the readiness contract with no deployment target, no execution approval,
   and no claimed sandbox checks. It lists every remaining blocker.

## Safety boundary

The Telegram review is deliberately read-only. It does not invoke Docker, contact Render or
another hosting provider, inspect secret values, alter target configuration, approve execution,
start workers, or deploy. It always reports `executionAllowed: false` and `deployed: false`.

The isolated Docker preflight still requires a dedicated execution environment with the pinned
sandbox image and a confirmed target. It must not be run inside the Telegram web process merely
because the manager pressed a button. A later phase can add a dedicated, auditable preflight
runner and a separate execution-approval flow.
