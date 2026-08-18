import * as Array from "effect/Array"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Path from "effect/Path"
import * as Result from "effect/Result"
import type { ParsedPackageSpec } from "#lib/core/packages.ts"
import {
  PackageNotReferencedError,
  PackageReferenceFilesystemError,
  RemovePackageReferencesError,
} from "#lib/core/errors.ts"
import { getStorePackagePath } from "#lib/store/paths.ts"
import {
  findPackageEntries,
  listPackageEntries,
  readProjectLockfile,
  removePackageEntries,
  type PackageEntry,
} from "#lib/workspace/lockfile.ts"
import { getDirectoryPath } from "#lib/workspace/paths.ts"
import { requireInitializedProject } from "#lib/workspace/project.ts"

const REMOVE_CONCURRENCY = 8

export interface PackageReferenceOptions {
  readonly projectPath?: string
}

interface PackageReferenceIdentity {
  name: string
  registry: string
  version?: string
}

export const listPackageReferences = Effect.fn("listPackageReferences")(function* (
  options: PackageReferenceOptions = {}
) {
  const projectPath = yield* requireInitializedProject(options.projectPath)
  const lockfile = yield* readProjectLockfile(projectPath)

  return {
    entries: listPackageEntries(lockfile),
    projectPath,
  }
})

export const findPackageReferenceMatches = Effect.fn("findPackageReferenceMatches")(function* (
  spec: ParsedPackageSpec,
  options: PackageReferenceOptions = {}
) {
  const projectPath = yield* requireInitializedProject(options.projectPath)
  const lockfile = yield* readProjectLockfile(projectPath)
  const entries = findPackageEntries(lockfile, spec)

  if (entries.length === 0) {
    const identity: PackageReferenceIdentity = {
      name: spec.name,
      registry: spec.registry,
    }

    if (spec.specifier !== undefined) {
      identity.version = spec.specifier
    }

    return yield* new PackageNotReferencedError(identity)
  }

  return {
    entries,
    projectPath,
  }
})

type RemovalAttempt =
  | { readonly entry: PackageEntry; readonly type: "missing" | "removed" }
  | { readonly cause: unknown; readonly entry: PackageEntry; readonly type: "failure" }

export const removePackageReferences = Effect.fn("removePackageReferences")(function* (
  projectPath: string,
  entries: readonly PackageEntry[]
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const projectDirectoryPath = getDirectoryPath(path, projectPath)
  const attempts = yield* Effect.forEach(
    entries,
    (entry) =>
      Effect.gen(function* () {
        const referencePath = yield* getStorePackagePath(projectDirectoryPath, entry)
        const referenceExists = yield* fs.exists(referencePath).pipe(
          Effect.mapError(
            (cause) =>
              new PackageReferenceFilesystemError({
                cause,
                operation: "inspect",
                path: referencePath,
              })
          )
        )

        if (!referenceExists) {
          return { entry, type: "missing" } satisfies RemovalAttempt
        }

        yield* fs.remove(referencePath, { force: true, recursive: true }).pipe(
          Effect.mapError(
            (cause) =>
              new PackageReferenceFilesystemError({
                cause,
                operation: "remove",
                path: referencePath,
              })
          )
        )

        return { entry, type: "removed" } satisfies RemovalAttempt
      }).pipe(
        Effect.match({
          onFailure: (cause) => ({ cause, entry, type: "failure" }) satisfies RemovalAttempt,
          onSuccess: (attempt) => attempt,
        })
      ),
    { concurrency: REMOVE_CONCURRENCY }
  )
  const [failures, confirmedEntries] = Array.partition(attempts, (attempt) =>
    attempt.type === "failure"
      ? Result.fail({ cause: attempt.cause, identity: attempt.entry })
      : Result.succeed(attempt.entry)
  )

  if (confirmedEntries.length > 0) {
    yield* removePackageEntries(projectPath, confirmedEntries)
  }

  if (failures.length > 0) {
    return yield* new RemovePackageReferencesError({ failures })
  }

  return {
    missingEntries: attempts
      .filter((attempt) => attempt.type === "missing")
      .map((attempt) => attempt.entry),
    removedEntries: confirmedEntries,
  }
})
