import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Option from "effect/Option"
import * as Order from "effect/Order"
import * as Path from "effect/Path"
import * as Predicate from "effect/Predicate"

import type { ManifestDependency } from "#lib/manifests/manifest.ts"
import type { ResolvedPackageReference } from "#lib/registries/registry.ts"
import type { MaterializedStoreEntry } from "#lib/store/index.ts"
import {
  ProjectFilesystemError,
  RepositoryDirectoryConflictError,
  StoreSourceMismatchError,
} from "#lib/core/errors.ts"
import {
  packageCoordinatesEquivalence,
  packageIdentityEquivalence,
  type PackageIdentity,
  type ParsedPackageSpec,
  type RepositoryPackageSpec,
} from "#lib/core/packages.ts"
import { ProjectDependencyReader } from "#lib/manifests/index.ts"
import { resolvePackageReference } from "#lib/registries/index.ts"
import { fetchRepositorySnapshot } from "#lib/sources/repository/fetch.ts"
import {
  resolveDirectRepositoryRef,
  resolveRepositoryRef,
} from "#lib/sources/repository/normalize.ts"
import { fetchTarballSnapshot } from "#lib/sources/tarball/fetch.ts"
import { registerProject } from "#lib/workspace/config.ts"
import {
  initializeLockfile,
  listPackageEntries,
  readProjectLockfile,
  upsertPackageEntry,
  type PackageEntry,
} from "#lib/workspace/lockfile.ts"
import { createProjectReference, ensureDirectory } from "#lib/workspace/project.ts"

export interface AddPackageOptions {
  readonly projectPath?: string
}

export interface AddPackageResult {
  readonly entry: PackageEntry
  /**
   * Set when the package is a manifest dependency with no installed version (no lockfile entry or
   * `node_modules` copy), so its manifest range was resolved against the registry instead. Holds
   * the range specifier.
   */
  readonly manifestRange: string | undefined
  readonly projectPath: string
  readonly referencePath: string
  readonly reusedStoreEntry: boolean
  readonly storePath: string
}

export interface PackageCandidates {
  readonly dependencies: readonly ManifestDependency[]
  readonly projectPath: string
}

export interface ResolvedPackageCandidateReference {
  readonly manifestRange: string | undefined
  readonly resolvedPackage: ResolvedPackageReference
}

interface RepositoryDirectoryConflict {
  existingDirectory?: string
  name: string
  registry: string
  requestedDirectory?: string
  version: string
}

interface ProjectRepositorySource {
  directory?: string
  host: string
  requestedRef?: string
  type: "repository"
  url: string
}

const noManifestDependencies: readonly ManifestDependency[] = []
const useTarball = () => Effect.succeed(Option.none())

const toProjectFilesystemError =
  (operation: ProjectFilesystemError["operation"], path: string) => (cause: unknown) =>
    new ProjectFilesystemError({ cause, operation, path })

const readAvailableProjectDependencies = Effect.fn("readAvailableProjectDependencies")(function* (
  projectPath: string
) {
  const projectDependencyReader = yield* ProjectDependencyReader

  return Option.getOrElse(
    yield* projectDependencyReader.readProjectDependencies(projectPath),
    () => noManifestDependencies
  )
})

const getRegistrySpecifier = (specifier: string) =>
  specifier.startsWith("workspace:") ? specifier.slice("workspace:".length) || "*" : specifier

const initializeAddProject = Effect.fn("initializeAddProject")(function* (
  options: AddPackageOptions
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const requestedProjectPath = Predicate.isUndefined(options.projectPath)
    ? path.resolve()
    : path.resolve(options.projectPath)
  const projectPath = yield* fs
    .realPath(requestedProjectPath)
    .pipe(Effect.mapError(toProjectFilesystemError("resolve", requestedProjectPath)))

  yield* ensureDirectory(projectPath).pipe(
    Effect.mapError(toProjectFilesystemError("prepare", projectPath))
  )
  const lockfile = yield* initializeLockfile(projectPath)
  yield* registerProject(projectPath)

  return {
    lockfile,
    projectPath,
  }
})

export const findPackageCandidates = Effect.fn("findPackageCandidates")(function* (
  options: AddPackageOptions = {}
) {
  const { lockfile, projectPath } = yield* initializeAddProject(options)

  const referencedPackages = new Set(
    listPackageEntries(lockfile).map((entry) => `${entry.registry}:${entry.name}`)
  )
  const dependencies = (yield* readAvailableProjectDependencies(projectPath))
    .filter((dependency) => !referencedPackages.has(`${dependency.registry}:${dependency.name}`))
    .toSorted((left, right) => Order.String(left.name, right.name))

  return {
    dependencies,
    projectPath,
  } satisfies PackageCandidates
})

const recordStoreEntryReference = Effect.fn("recordStoreEntryReference")(function* (
  identity: PackageIdentity,
  storeEntry: MaterializedStoreEntry,
  projectPath: string,
  manifestRange: string | undefined,
  tracking: PackageEntry["tracking"],
  source: PackageEntry["source"] = storeEntry.source
) {
  const referencePath = yield* createProjectReference(
    projectPath,
    identity,
    storeEntry.path,
    source
  )
  const entry = {
    ...identity,
    source,
    tracking,
  } satisfies PackageEntry

  yield* upsertPackageEntry(projectPath, entry)

  return {
    entry,
    manifestRange,
    projectPath,
    referencePath,
    reusedStoreEntry: storeEntry.reused,
    storePath: storeEntry.path,
  } satisfies AddPackageResult
})

const fetchAndRecordResolvedPackage = Effect.fn("fetchAndRecordResolvedPackage")(function* (
  resolvedPackage: ResolvedPackageReference,
  projectPath: string,
  manifestRange: string | undefined,
  tracking: PackageEntry["tracking"]
) {
  const resolvedRepository = yield* Option.match(Option.fromNullishOr(resolvedPackage.repository), {
    onNone: useTarball,
    onSome: (repository) =>
      resolveRepositoryRef(resolvedPackage.identity, repository).pipe(
        Effect.map(Option.some),
        Effect.catchTags({
          InvalidRepositoryUrlError: useTarball,
          TagNotFoundError: useTarball,
          UnsupportedRepositoryHostError: useTarball,
        })
      ),
  })

  const storeEntry = yield* Option.match(resolvedRepository, {
    onNone: () => fetchTarballSnapshot(resolvedPackage.identity, resolvedPackage.tarballUrl),
    onSome: (repository) => fetchRepositorySnapshot(resolvedPackage.identity, repository),
  })

  return yield* recordStoreEntryReference(
    resolvedPackage.identity,
    storeEntry,
    projectPath,
    manifestRange,
    tracking
  )
})

const addRepositoryReference = Effect.fn("addRepositoryReference")(function* (
  inputSpec: RepositoryPackageSpec,
  projectPath: string
) {
  const resolved = yield* resolveDirectRepositoryRef(inputSpec)
  const lockfile = yield* readProjectLockfile(projectPath)
  const existingEntry = lockfile.packages.find((entry) =>
    packageIdentityEquivalence(entry, resolved.identity)
  )

  if (
    existingEntry?.source.type === "repository" &&
    existingEntry.source.directory !== resolved.repository.source.directory
  ) {
    const conflict: RepositoryDirectoryConflict = { ...resolved.identity }

    if (existingEntry.source.directory !== undefined) {
      conflict.existingDirectory = existingEntry.source.directory
    }
    if (resolved.repository.source.directory !== undefined) {
      conflict.requestedDirectory = resolved.repository.source.directory
    }

    return yield* new RepositoryDirectoryConflictError(conflict)
  }

  const storeEntry = yield* fetchRepositorySnapshot(resolved.identity, resolved.repository, {
    includeDirectory: false,
  })

  if (
    storeEntry.source.type !== "repository" ||
    storeEntry.source.host !== resolved.repository.source.host ||
    storeEntry.source.url !== resolved.repository.source.url
  ) {
    return yield* new StoreSourceMismatchError(resolved.identity)
  }

  const projectSource: ProjectRepositorySource = {
    host: storeEntry.source.host,
    type: "repository",
    url: storeEntry.source.url,
  }

  if (resolved.repository.source.directory !== undefined) {
    projectSource.directory = resolved.repository.source.directory
  }
  if (inputSpec.specifier !== undefined) {
    projectSource.requestedRef = inputSpec.specifier
  }

  return yield* recordStoreEntryReference(
    resolved.identity,
    storeEntry,
    projectPath,
    undefined,
    "manual",
    projectSource
  )
})

export const resolvePackageCandidateReference = Effect.fn("resolvePackageCandidateReference")(
  function* (dependency: ManifestDependency) {
    const manifestRange = Predicate.isUndefined(dependency.exactVersion)
      ? getRegistrySpecifier(dependency.specifier)
      : undefined
    const resolvedPackage = yield* resolvePackageReference({
      _tag: "registry",
      name: dependency.name,
      registry: dependency.registry,
      specifier: dependency.exactVersion ?? manifestRange,
    })

    return {
      manifestRange,
      resolvedPackage,
    } satisfies ResolvedPackageCandidateReference
  }
)

export const materializePackageCandidateReference = Effect.fn(
  "materializePackageCandidateReference"
)(function* (
  resolution: ResolvedPackageCandidateReference,
  projectPath: string,
  tracking: PackageEntry["tracking"] = "dependency"
) {
  return yield* fetchAndRecordResolvedPackage(
    resolution.resolvedPackage,
    projectPath,
    resolution.manifestRange,
    tracking
  )
})

export const addPackageReference = Effect.fn("addPackageReference")(function* (
  inputSpec: ParsedPackageSpec,
  options: AddPackageOptions = {}
) {
  const { projectPath } = yield* initializeAddProject(options)

  if (inputSpec._tag === "repository") {
    return yield* addRepositoryReference(inputSpec, projectPath)
  }

  const manifestDependency = Predicate.isUndefined(inputSpec.specifier)
    ? (yield* readAvailableProjectDependencies(projectPath)).find((dependency) =>
        packageCoordinatesEquivalence(dependency, inputSpec)
      )
    : undefined

  if (Predicate.isNotUndefined(manifestDependency)) {
    const resolution = yield* resolvePackageCandidateReference(manifestDependency)

    return yield* materializePackageCandidateReference(resolution, projectPath)
  }

  const resolvedPackage = yield* resolvePackageReference(inputSpec)

  return yield* fetchAndRecordResolvedPackage(resolvedPackage, projectPath, undefined, "manual")
})
