# Verified offline dependency artifacts

This module is a preparation-stage helper. It consumes an already validated package.json and package-lock.json, downloads each locked tarball from https://registry.npmjs.org/ through a separately configured trusted egress proxy, verifies the lockfile SRI digest, and assembles a read-only offline artifact directory.

## Mandatory network boundary

Set BOSS_NPM_EGRESS_PROXY to a trusted proxy URL without embedded credentials, and BOSS_NPM_EGRESS_POLICY=registry.npmjs.org-only. The proxy itself must enforce destinations limited to registry.npmjs.org:443, resolve DNS on the proxy side, reject private/reserved and IP-literal destinations, and re-check redirects and new connections. The environment variable is only a guard; it is not a firewall. Do not run this helper until the proxy has been independently configured and tested. npm CLI redirects must remain inside that proxy policy.

## Safety controls

- Validate the complete lockfile with the existing dependency preflight before downloading.
- Reject non-HTTPS or non-registry tarball URLs.
- Run npm pack with --ignore-scripts, strict TLS, the official registry, and the trusted proxy.
- Pass a minimal environment without application secrets and clear NO_PROXY.
- Verify each downloaded archive against the lockfile SRI digest before accepting it.
- Enforce per-package, total-size, and package-count limits.
- Write an artifact manifest containing the lockfile digest and each archive SHA-512 digest.
- Assemble into a fresh staging directory, refuse overwrite, and mark files/directories read-only.

Read-only filesystem permissions are a guard against accidental mutation, not cryptographic immutability. The artifact is not signed and this helper is not connected to the production request path, a worker, Render, or Neon. Tests mock npm download; they validate orchestration and integrity checks but do not prove the external proxy works or that real registry downloads succeed.

The next reviewed stage must consume the verified archive set without network access, safely unpack packages, and construct a reproducible offline runtime tree before any customer code is executed in the existing Docker sandbox.
