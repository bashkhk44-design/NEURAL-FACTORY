# Verified dependency artifact manifest

This stage accepts tarball bytes supplied by a separately isolated preparation worker. It does not perform network requests, install dependencies, extract archives, execute package code, or access production credentials.

The manifest builder:
- requires npm lockfile v2/v3 and package paths under `node_modules/`;
- permits HTTPS URLs only on `registry.npmjs.org`;
- verifies the strongest supported SRI digest (sha512, then sha384, then sha256) against every supplied tarball;
- rejects missing, extra, modified, linked, or unsafe package entries;
- enforces package-count, per-package, and aggregate byte limits;
- emits a stable, sorted manifest with verified integrity metadata and SHA-256 content digests.

This is an integrity-verification boundary, not a complete immutable runtime artifact. The next stage must implement the trusted downloader/proxy boundary, safe archive handling, immutable storage, and offline installation before any customer runtime tests. No production integration is enabled by this module.
