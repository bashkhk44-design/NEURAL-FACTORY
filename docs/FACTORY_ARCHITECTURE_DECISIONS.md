# NEURAL-FACTORY Architecture Decisions

Status: **Accepted**
Decision date: 2026-11-20
Applies to: all newly specified customer projects unless a project-specific approved decision narrows the options.

## 1. Hosting strategy: Hybrid

The factory supports three deployment placements under one hybrid policy:

- **Factory-hosted:** the factory operates the customer project using an approved factory-managed hosting target.
- **Customer-hosted:** the customer owns and operates the hosting account and deployment target; the factory prepares a release package and the required handoff.
- **Split placement:** components may be placed separately when the project needs it (for example, a customer-owned website with a factory-operated Telegram integration), provided data flows, ownership, secrets, and operational responsibilities are documented.

Hybrid is the platform policy, not permission to deploy to either party's infrastructure. Each project must record its selected placement, component map, data location, account owner, secret ownership, support boundary, and rollback owner before deployment readiness can be approved. If these are not explicit, deployment preflight must remain blocked.

No provider account, credentials, domain, webhook, or live service is provisioned by this decision. Provider-specific adapters and customer handoff flows remain separate implementation work.

## 2. Admin interface strategy: Optional

An independent admin dashboard is not mandatory for every customer project.

During requirements and design, the factory determines whether the project needs:
- a dedicated web admin dashboard;
- Telegram-based administration only; or
- both, when the workflow justifies both surfaces.

The decision must be based on required roles, permissions, reporting, bulk operations, data visibility, and expected operator experience. A dashboard must not be generated merely because the platform can generate one. If the project does not need a dashboard, the design must explicitly record that decision and describe the supported management surface.

## 3. Intake enforcement

The interactive intake layer attaches the accepted platform policy as trusted metadata:
`factoryArchitecture.hostingModel = "hybrid"`
`factoryArchitecture.adminPanel = "optional"`

These values are platform-owned constants. Model output and previously stored intake data cannot override them. They describe platform policy only; they do not select a customer's concrete hosting target or decide whether a particular project will receive a dashboard.

## 4. Required project-level decisions before release approval

For each project, its approved specification/design must resolve:

1. Hosting placement: factory, customer, or split.
2. Component-to-host mapping (bot, website, admin dashboard, API, background workers, database).
3. Ownership of hosting accounts, domains, data, and secrets.
4. Operational responsibility, monitoring, support, backup, and rollback.
5. Admin surface: dashboard, Telegram-only, or both, with the reason and required roles.
6. Customer and manager approvals for the immutable release artifact, followed by a separate deployment authorization.

Missing decisions are blockers, not implied consent.

## 5. Security and rollout boundaries

- Customer-generated code must never be loaded with unrestricted `require` or evaluated inside the main factory worker.
- Release artifacts remain immutable and digest-verified.
- Execution must use a separately isolated runtime with tenant boundaries, least privilege, bounded resources, and explicit network policy.
- A successful build, test, or deployment preflight is not a deployment authorization.
- This ADR does not enable Telegram webhooks, deploy Cloudflare Workers, provision provider resources, or publish customer projects.

## 6. Implementation sequence

1. Persist the accepted policy in intake metadata and test that AI output cannot override it.
2. Extend project specification/design contracts with project-specific hosting placement and admin-surface decisions.
3. Add deterministic release/preflight blockers for unresolved hosting ownership, component placement, admin-surface decision, and rollback responsibility.
4. Implement provider-specific hosting adapters and isolated customer runtime only after their contracts and security tests are reviewed.
5. Add customer handoff and factory-hosted operational controls, then perform staging validation before any production rollout.

This document records the accepted architecture. It does not claim that steps 2–5 are already implemented.
