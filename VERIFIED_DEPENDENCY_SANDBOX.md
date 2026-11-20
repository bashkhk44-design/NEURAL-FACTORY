# Verified dependency runtime in the Docker sandbox

The customer-project tester can now accept a prebuilt offline dependency artifact directory as an explicit input. When sandbox runtime tests are enabled and the customer's lockfile declares packages, the tester requires that artifact, verifies it against the exact package-lock file, and unpacks it with `offline-dependency-unpack.js` before invoking Docker.

The resulting `node_modules` directory is mounted read-only at `/workspace/node_modules`. Before Docker starts, the tester creates an empty, real `node_modules` mountpoint inside its temporary project copy; non-empty or symlinked project mountpoints are rejected. The project source remains a separate read-only mount. The container continues to use a digest-pinned image, `--network=none`, read-only root filesystem, bounded memory/CPU/PIDs, non-root UID, dropped capabilities, no-new-privileges, and a bounded timeout.

## Fail-closed behavior

- Missing verified artifacts for a project with locked packages prevents runtime tests from starting.
- Missing or malformed package-lock data for declared dependencies prevents runtime tests from starting.
- Artifact lockfile digest, package mapping, SHA-512 and SRI checks are enforced by the offline unpacker.
- A symlinked runtime node_modules root is rejected before Docker is invoked.
- No npm install, lifecycle script, shell installer, package download, or network access is performed during this stage.

## Scope and safety boundary

This is an explicit preparation-stage integration. The caller must supply an artifact directory produced by the separately controlled dependency-artifact preparation step; this change does not download packages or create artifacts. The new argument is not wired to production request orchestration, the worker, Render, or Neon. Sandbox execution remains opt-in via `BOSS_SANDBOX_ENABLED=YES`, and the image must remain pinned via `BOSS_SANDBOX_IMAGE`.

The tests verify argument construction, read-only mount configuration, fail-closed behavior, and the existing synthetic Docker smoke test. They do not claim that arbitrary customer projects have been executed successfully or that a real registry/proxy download was performed.
## Reproducible runtime tree and package executables

After verified archives are unpacked, `runtime-dependency-tree.js` validates the package identity against the lockfile, creates regular executable wrappers for declared `bin` entries, and computes a deterministic SHA-256 digest for the resulting `node_modules` tree. The digest includes each relative path, entry type, permission bits, file size, and file-content SHA-256; traversal order is stable, and permissions are canonicalized (directories 0755, ordinary files 0644, generated wrappers 0755) before hashing. File hashing is streamed to avoid loading large dependency files into memory.

Generated wrappers are ordinary files (not symlinks), have mode 0755, resolve only to an existing regular file inside the owning package, and support CommonJS and ESM entry points. Unsafe paths, symlink/hard-linked targets, unsupported filesystem entries, and duplicate executable names in the same nearest `node_modules/.bin` directory are rejected. The complete dependency tree is scanned before mounting; symlinks, hard-linked files, and special filesystem entries fail closed.

The Docker integration test now mounts a fixture dependency tree read-only, imports a package through normal Node module resolution, and executes its generated `.bin` wrapper inside the network-disabled container. Unit tests verify repeatable tree digests and that content changes alter the digest.

These tests use synthetic package fixtures. They do not prove that arbitrary customer applications or every npm package's lifecycle/build behavior works. The generated wrappers cover declared package `bin` entries, but package-specific native binaries or install-time compilation are not performed.
