# Controlled dependency preparation

The dependency-preparation module creates a genuine npm v3 lockfile from a customer-supplied package.json. It is a preparation-stage helper only; it is not invoked by the production request path and does not install or execute customer packages.

## Required isolation

Run this stage only in a disposable, dedicated preparation worker with no application credentials, database credentials, bot tokens, or production network access. The worker must have a trusted outbound proxy configured with:

- `BOSS_NPM_EGRESS_PROXY`: proxy URL, without embedded credentials.
- `BOSS_NPM_EGRESS_POLICY=registry.npmjs.org-only`: explicit operator acknowledgement of the proxy policy.

The proxy itself MUST enforce CONNECT/HTTP destinations limited to `registry.npmjs.org:443`, resolve DNS on the proxy side, reject private/reserved destinations and IP-literal hosts, and re-check every redirect/new connection. The environment flag is only a guard; it does not create or prove a firewall rule. Do not run this module if the proxy policy has not been independently configured and tested.

## Preparation behavior

1. Validate package names/specifications and reject URL, git, file, workspace and lifecycle-script dependencies before network access.
2. Copy only package.json into a fresh temporary directory; do not copy customer source files or project .npmrc.
3. Run npm lockfile resolution with `--package-lock-only --ignore-scripts`, strict TLS, the official npm registry, and the required proxy.
4. Pass a deliberately minimal environment; application secrets are not inherited.
5. Validate the generated lockfile using the existing dependency preflight policy.
6. Atomically write only the validated package-lock.json to the requested artifact path and remove the temporary directory.

This stage does not install node_modules, execute customer code, enable network access in the runtime sandbox, deploy, or modify production configuration. A later separately reviewed stage must fetch verified package tarballs through the same controlled egress boundary, verify their integrity, and produce an immutable offline artifact before any runtime test is attempted.
