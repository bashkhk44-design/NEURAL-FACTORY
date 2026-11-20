# Release Approval and Handoff

This phase creates an immutable release candidate after the current approved specification,
approved design, and completed passing isolated acceptance-test run are verified.

## Approval sequence

1. The project owner receives a Telegram release report and explicitly approves or rejects it.
2. Only after customer approval may the manager approve or reject the same release candidate.
3. A release becomes \`approved\` only after both approvals. Rejections are terminal for that candidate.
4. Every decision stores the Telegram actor, role, decision, and database timestamp.

## Immutable release record

Each candidate has a monotonically increasing project-local version, a canonical JSON artifact,
a SHA-256 digest, the approved specification version, design source fingerprint, acceptance-test
summary, preflight checks, risks, and generated project files. The artifact is size-bounded and
is not updated after insertion. A new candidate creates a new version.

## Safety boundary

This is an approval and handoff contract only. It does not deploy, create hosting resources,
run workers, change Render settings, apply Neon production migrations, or alter secrets or
Telegram webhooks. Approval is not deployment. Deployment remains a separately authorized phase.

A successful test report proves the recorded tests ran and passed; it does not guarantee
production readiness or complete business coverage. Human review remains required.
