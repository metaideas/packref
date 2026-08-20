---
name: packref
description: Inspect the exact dependency source referenced by a Packref project. Use when tracing package implementation, debugging exact-version behavior, comparing referenced versions, restoring missing source references, or working with Packref commands.
---

# Packref

Use Packref to inspect the exact dependency source that a project references. Do not substitute
documentation, another installed version, or an arbitrary repository revision. Packref materializes
package source references for inspection. It does not install runtime dependencies.

## Inspect a package

1. Find `.packref/packref-lock.json`. If it exists, run `npx packref list` to review the current
   references. If it does not exist, explain that the project is not initialized. Run
   `npx packref init` only when the user authorizes initialization.
2. Read the Packref lockfile and select the required package identity. Match the `registry`, package
   `name`, and exact `version`. Record its `tracking` mode and `source` metadata. If the lockfile has
   multiple versions, select the version required by the task.
3. Check whether the matching package source reference exists:
   - Unscoped package: `.packref/packages/<registry>/<package>/<version>/`
   - Scoped package: `.packref/packages/<registry>/<scope>/<package>/<version>/`

   Keep the leading `@` in `<scope>`.

4. If the lockfile contains the package identity but the reference is missing, run
   `npx packref install`. This command restores all locked references without changing the lockfile
   or installing runtime dependencies.
5. If the lockfile does not contain the package identity, run `npx packref add <package-spec>` only
   when the task includes obtaining that source. Add `@<version>` when the task requires an exact
   version. Otherwise, Packref can follow the project's resolved manifest dependency. Read the
   updated lockfile before inspection.
6. Search the package source reference with local tools such as `rg` and `rg --files`. Start at the
   named public API or package exports. Follow imports until you reach the implementation that
   answers the question.
7. Report the package identity and cite the relevant project-local paths. Separate facts verified
   in the source from inferences.

When `source.directory` is present, the package source reference already starts at that package's
subdirectory. Treat `source.directory` as repository provenance. Do not append it to the local path.

## Command boundaries

- `npx packref init` initializes a project. Run it only with user authorization. It is interactive
  and can update `.gitignore`, `tsconfig.json`, `AGENTS.md`, the Packref lockfile, and Packref's
  global project registration.
- `npx packref add [package-spec]` resolves and materializes a missing reference. Without a package
  spec, it opens an interactive dependency selector.
- `npx packref install` materializes every reference recorded in the committed Packref lockfile.
- `npx packref sync` reconciles dependency-tracked references after changes to the manifest or
  package-manager lockfile. It can update or remove references.
- `npx packref remove [package-spec]` removes references. Run it only when the user requests
  removal.
- `npx packref prune`, `npx packref clean`, and `npx packref clean --global` remove stored data.
  Run them only when the user explicitly requests the applicable scope.

## Examples

- For `@effect/platform@0.90.0`, match its lockfile entry, then inspect
  `.packref/packages/npm/@effect/platform/0.90.0/`.
- If `npm:react@19.1.0` is locked but its reference is missing, run `npx packref install`, then
  inspect `.packref/packages/npm/react/19.1.0/`.
- If `hono` is not in the lockfile, run `npx packref add hono` only when the task includes obtaining
  its source. Read the resulting package identity and source metadata from the updated lockfile.
- If both `npm:hono@4.2.0` and `npm:hono@4.3.0` are locked, inspect the version required by the task.
  Inspect both only for a version comparison.

## Failure and fallback

If a command fails, read the error first. Check project initialization, the package identity, the
lockfile entry, and network access. Use registry metadata or web research only when Packref cannot
materialize the exact source. State this limitation and identify which findings come from fallback
evidence.
