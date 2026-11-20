# Safe offline dependency unpacking

`offline-dependency-unpack.js` consumes the read-only artifact produced by `dependency-artifact.js` and a byte-for-byte matching npm package-lock file. It creates a fresh runtime tree containing `node_modules/` without contacting a network service.

## Contract

Call `unpackVerifiedDependencies({ artifactDir, lockfilePath, outputDir, limits })` with absolute paths. The artifact directory and lockfile must already exist; the output parent must exist; the output directory must not exist. The output is private until the function returns successfully. On any failure the partially extracted output is recursively removed. Do not expose the output to another process until the function returns successfully.

## Verification and extraction controls

- Reject symlinked artifact roots, lockfiles, manifest files, package directories, and archive files.
- Match the manifest's SHA-256 lockfile digest and exact package count/version mapping to package-lock.
- Require unique, bounded archive filenames and verify both manifest SHA-512 and lockfile SRI before decompression.
- Enforce archive byte, decompressed byte, total expanded byte, package count, path length, and entry-count limits.
- Parse gzip/tar data without invoking a shell or external extraction program.
- Verify tar header checksums and bounds; reject absolute paths, traversal, backslashes, drive-like path components, duplicate entries, unsupported entry types, symbolic links, hard links, sparse files, and global PAX metadata.
- Support ordinary ustar paths, GNU long names, and local PAX `path` metadata only. Other PAX fields are rejected.
- Extract only regular files and directories beneath the `package/` archive root. File permissions are normalized; archive ownership and executable bits are ignored.
- Verify each extracted `package/package.json` name and version against its package-lock entry.
- Return `networkUsed: false`; no npm install, lifecycle scripts, package code, or network access is executed.

The implementation is intentionally a preparation-stage library and is not connected to the production request path, worker, Render, Neon, or the Docker customer-code execution path. The unpacked runtime tree is not signed or cryptographically immutable. The next integration stage must mount the completed tree read-only in the existing network-disabled Docker sandbox and add a reproducibility check before any customer code is run.

## Test

Run `node --test test/offline-dependency-unpack.test.js` or the repository's full `npm test` suite. Fixtures use locally generated tar archives; they do not download packages from npm.
