# Isolated Deployment Preflight

## Purpose

This module performs read-only, pre-deployment checks against an immutable release artifact. It does not deploy, contact a hosting provider, access production databases, or change secrets or webhooks.

## Checks

- Recomputes the canonical SHA-256 digest of the stored release artifact.
- Validates the bundle, manifest, and embedded-secret scan.
- Validates explicit target metadata without calling the provider API.
- Compares configured environment-variable names with required names. Secret values are never read or passed into Docker.
- Requires a prior approved release with a verified artifact digest as the rollback target.
- Starts the app's declared start script inside a pinned Docker image and probes its declared health path over container loopback only.
- Reads the actual Node.js version from the pinned image and checks it against package.json engines.node.

## Sandbox boundary

The container uses no network, a read-only root filesystem, read-only artifact and dependency mounts, a non-root UID, dropped Linux capabilities, no-new-privileges, and bounded memory, CPU, process count, and execution time. Required environment names receive non-secret placeholder values only. No actual credentials are copied into the container.

If the project declares dependencies, a verified offline node_modules tree is mandatory. If the manifest omits a healthCheck route, the runtime is incompatible, the health endpoint fails, or any required evidence is missing, the preflight fails closed.

## Result

The result includes the six evidence checks and the PR38 readiness evaluation. Even when every check passes, executionAllowed and deployed remain false. A separate human execution decision and a future provider-specific deployment implementation remain outside this module.
