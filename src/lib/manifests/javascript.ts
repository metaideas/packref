import * as Context from "effect/Context"
import * as Effect from "effect/Effect"
import * as FileSystem from "effect/FileSystem"
import * as Filter from "effect/Filter"
import * as Layer from "effect/Layer"
import * as Match from "effect/Match"
import * as Option from "effect/Option"
import * as Path from "effect/Path"
import * as Predicate from "effect/Predicate"
import * as Result from "effect/Result"
import * as Schema from "effect/Schema"
import { detectPackageManager, type PackageManagerName } from "nypm"
import { valid } from "semver"
import { ManifestParseError, ManifestResolutionError } from "#lib/core/errors.ts"
import { defineManifest, type ManifestDependency } from "#lib/manifests/manifest.ts"

const DEPENDENCY_GROUPS = ["dependencies", "devDependencies", "peerDependencies"] as const

const NODE_MODULES_RESOLUTION_CONCURRENCY = 8

const DependencyRecordSchema = Schema.Record(Schema.String, Schema.String)

export const JavascriptPackageManifestSchema = Schema.StructWithRest(
  Schema.Struct({
    dependencies: Schema.optional(DependencyRecordSchema),
    devDependencies: Schema.optional(DependencyRecordSchema),
    peerDependencies: Schema.optional(DependencyRecordSchema),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)]
)

const InstalledPackageSchema = Schema.StructWithRest(
  Schema.Struct({
    version: Schema.String,
  }),
  [Schema.Record(Schema.String, Schema.Unknown)]
)

const NpmLockfileSchema = Schema.StructWithRest(
  Schema.Struct({
    dependencies: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
    packages: Schema.optional(Schema.Record(Schema.String, Schema.Unknown)),
  }),
  [Schema.Record(Schema.String, Schema.Unknown)]
)

const NpmLockfileEntrySchema = Schema.StructWithRest(
  Schema.Struct({
    version: Schema.String,
  }),
  [Schema.Record(Schema.String, Schema.Unknown)]
)

const decodeJavascriptManifest = Schema.decodeUnknownEffect(
  Schema.fromJsonString(JavascriptPackageManifestSchema)
)
const decodeInstalledPackage = Schema.decodeUnknownEffect(
  Schema.fromJsonString(InstalledPackageSchema)
)
const decodeNpmLockfile = Schema.decodeUnknownOption(Schema.fromJsonString(NpmLockfileSchema))
const decodeNpmLockfileEntry = Schema.decodeUnknownOption(NpmLockfileEntrySchema)

interface LockedVersionDependency {
  readonly name: string
  readonly specifier: string
}

interface LockfileResolutionRequest extends LockedVersionDependency {
  readonly projectRelativePath: string
}

interface Lockfile {
  readonly isText?: boolean
  readonly name: string
}

interface PackageManagerLockfileStrategy {
  readonly lockfiles: readonly Lockfile[]
  readonly resolve: (
    rawLockfile: string,
    request: LockfileResolutionRequest
  ) => Option.Option<string>
}

interface PackageManagerResolverService {
  readonly resolveLockedVersions: (
    projectPath: string,
    dependencies: readonly LockedVersionDependency[]
  ) => Effect.Effect<ReadonlyMap<string, string>, ManifestResolutionError>
}

const toManifestParseError = (path: string) =>
  Effect.mapError((cause: unknown) => new ManifestParseError({ cause, path }))

const toManifestResolutionError = (path: string) =>
  Effect.mapError((cause: unknown) => new ManifestResolutionError({ cause, path }))

const escapeRegularExpression = (value: string) =>
  value.replaceAll(/[.*+?^${}()|[\]\\]/gu, String.raw`\$&`)

const unquoteYamlValue = (value: string) => value.replaceAll(/^["']|["']$/gu, "")

export const resolveBunLockVersion = (rawLockfile: string, name: string) => {
  const escapedName = escapeRegularExpression(name)
  const match = Option.fromNullishOr(
    new RegExp(String.raw`^\s*"${escapedName}":\s*\[\s*"${escapedName}@([^"]+)"`, "mu").exec(
      rawLockfile
    )
  )

  return Option.flatMap(match, (result) => Option.fromNullishOr(result[1]))
}

export const resolveYarnLockVersion = (rawLockfile: string, name: string, specifier: string) => {
  const selectors = new Set([`${name}@${specifier}`, `${name}@npm:${specifier}`])

  for (const block of rawLockfile.split(/\n(?=\S)/u)) {
    const [header = ""] = block.split("\n")
    const headerSelectors = header
      .trim()
      .replace(/:\s*$/u, "")
      .split(",")
      .map((value) => unquoteYamlValue(value.trim()))

    if (!headerSelectors.some((selector) => selectors.has(selector))) {
      continue
    }

    const version = Option.fromNullishOr(
      /^\s+version:?\s+["']?([^"'\s]+)["']?\s*$/mu.exec(block)
    ).pipe(Option.flatMap((match) => Option.fromNullishOr(match[1])))

    if (Option.isSome(version)) {
      return version
    }
  }

  return Option.none<string>()
}

const getYamlMappingBlock = (source: string, key: string, indentation: number) => {
  const lines = source.split(/\r?\n/u)
  const keyPattern = new RegExp(
    String.raw`^\s{${indentation}}["']?${escapeRegularExpression(key)}["']?:\s*$`,
    "u"
  )
  const startIndex = lines.findIndex((line) => keyPattern.test(line))

  if (startIndex === -1) {
    return Option.none<string>()
  }

  let endIndex = lines.length

  for (let index = startIndex + 1; index < lines.length; index += 1) {
    const line = lines[index]

    if (line === undefined || line.trim().length === 0) {
      continue
    }

    const lineIndentation = line.match(/^\s*/u)?.[0].length ?? 0

    if (lineIndentation <= indentation) {
      endIndex = index
      break
    }
  }

  return Option.some(lines.slice(startIndex + 1, endIndex).join("\n"))
}

const normalizePnpmVersion = (value: string) => unquoteYamlValue(value).replace(/\(.+$/u, "").trim()

const resolvePnpmDependencyFromBlock = (source: string, name: string) => {
  const escapedName = escapeRegularExpression(name)
  const lines = source.split(/\r?\n/u)
  const dependencyPattern = new RegExp(
    String.raw`^(?<indentation>\s+)["']?${escapedName}["']?:\s*(?<value>.*?)\s*$`,
    "u"
  )

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]
    const match = line === undefined ? null : dependencyPattern.exec(line)

    if (match?.groups === undefined) {
      continue
    }

    const inlineValue = match.groups.value

    if (inlineValue !== undefined && inlineValue.length > 0) {
      const version = normalizePnpmVersion(inlineValue)

      if (valid(version) !== null) {
        return Option.some(version)
      }

      continue
    }

    const indentation = match.groups.indentation?.length ?? 0

    for (let nestedIndex = index + 1; nestedIndex < lines.length; nestedIndex += 1) {
      const nestedLine = lines[nestedIndex]

      if (nestedLine === undefined || nestedLine.trim().length === 0) {
        continue
      }

      const nestedIndentation = nestedLine.match(/^\s*/u)?.[0].length ?? 0

      if (nestedIndentation <= indentation) {
        break
      }

      const versionMatch = Option.fromNullishOr(/^\s+version:\s*(.+?)\s*$/u.exec(nestedLine)).pipe(
        Option.flatMap((match) => Option.fromNullishOr(match[1]))
      )

      if (Option.isSome(versionMatch)) {
        const version = normalizePnpmVersion(versionMatch.value)

        if (valid(version) !== null) {
          return Option.some(version)
        }
      }
    }
  }

  return Option.none<string>()
}

export const resolvePnpmLockVersion = (
  rawLockfile: string,
  name: string,
  projectRelativePath = "."
) =>
  Option.match(getYamlMappingBlock(rawLockfile, "importers", 0), {
    onNone: () => resolvePnpmDependencyFromBlock(rawLockfile, name),
    onSome: (importers) =>
      getYamlMappingBlock(importers, projectRelativePath, 2).pipe(
        Option.flatMap((importer) => resolvePnpmDependencyFromBlock(importer, name))
      ),
  })

export const resolveNpmLockVersion = (
  rawLockfile: string,
  name: string,
  projectRelativePath = "."
) =>
  decodeNpmLockfile(rawLockfile).pipe(
    Option.flatMap((lockfile) => {
      const workspacePackagePath =
        projectRelativePath === "." ? undefined : `${projectRelativePath}/node_modules/${name}`

      return Option.fromNullishOr(
        (workspacePackagePath === undefined
          ? undefined
          : lockfile.packages?.[workspacePackagePath]) ??
          lockfile.packages?.[`node_modules/${name}`] ??
          lockfile.dependencies?.[name]
      )
    }),
    Option.flatMap(decodeNpmLockfileEntry),
    Option.map((entry) => entry.version)
  )

const packageManagerLockfileStrategies = {
  bun: {
    lockfiles: [
      { name: "bun.lock" },
      // bun.lockb is binary, so fall through to node_modules instead of parsing it.
      { isText: false, name: "bun.lockb" },
    ],
    resolve: (rawLockfile, request) => resolveBunLockVersion(rawLockfile, request.name),
  },
  npm: {
    lockfiles: [{ name: "package-lock.json" }, { name: "npm-shrinkwrap.json" }],
    resolve: (rawLockfile, request) =>
      resolveNpmLockVersion(rawLockfile, request.name, request.projectRelativePath),
  },
  pnpm: {
    lockfiles: [{ name: "pnpm-lock.yaml" }],
    resolve: (rawLockfile, request) =>
      resolvePnpmLockVersion(rawLockfile, request.name, request.projectRelativePath),
  },
  yarn: {
    lockfiles: [{ name: "yarn.lock" }],
    resolve: (rawLockfile, request) =>
      resolveYarnLockVersion(rawLockfile, request.name, request.specifier),
  },
} satisfies Partial<Record<PackageManagerName, PackageManagerLockfileStrategy>>

const getPackageManagerLockfileStrategy = (
  managerName: PackageManagerName
): PackageManagerLockfileStrategy | undefined =>
  Match.value(managerName).pipe(
    Match.when("bun", () => packageManagerLockfileStrategies.bun),
    Match.when("npm", () => packageManagerLockfileStrategies.npm),
    Match.when("pnpm", () => packageManagerLockfileStrategies.pnpm),
    Match.when("yarn", () => packageManagerLockfileStrategies.yarn),
    Match.orElse(() => void 0)
  )

const getLockfiles = (
  managerName: PackageManagerName,
  detectedLockfile: string | readonly string[] | undefined
) => {
  const strategy = getPackageManagerLockfileStrategy(managerName)
  const lockfileNames = Match.value(detectedLockfile).pipe(
    Match.when(Predicate.isUndefined, () =>
      strategy === undefined ? [] : strategy.lockfiles.map((lockfile) => lockfile.name)
    ),
    Match.when(Match.string, (name) => [name]),
    Match.orElse((names) => [...names])
  )

  return lockfileNames.map(
    (name) => strategy?.lockfiles.find((lockfile) => lockfile.name === name) ?? { name }
  )
}

const ancestorDirectories = (path: Path.Path, startPath: string) => {
  const directories: string[] = []
  let directoryPath = startPath

  while (directoryPath.length > 0) {
    directories.push(directoryPath)

    const parentPath = path.dirname(directoryPath)

    if (parentPath === directoryPath) {
      break
    }

    directoryPath = parentPath
  }

  return directories
}

export class PackageManagerResolver extends Context.Service<
  PackageManagerResolver,
  PackageManagerResolverService
>()("PackageManagerResolver") {
  static readonly layer = Layer.effect(
    this,
    Effect.gen(function* () {
      const fs = yield* FileSystem.FileSystem
      const path = yield* Path.Path

      const findNearestLockfiles = Effect.fn("findNearestLockfiles")(function* (
        projectPath: string,
        lockfiles: readonly Lockfile[]
      ) {
        return yield* Effect.findFirstFilter(
          ancestorDirectories(path, projectPath),
          (directoryPath) =>
            Effect.gen(function* () {
              const matches: Array<Lockfile & { readonly path: string }> = []

              for (const lockfile of lockfiles) {
                const lockfilePath = path.join(directoryPath, lockfile.name)
                const exists = yield* fs
                  .exists(lockfilePath)
                  .pipe(toManifestResolutionError(lockfilePath))

                if (exists) {
                  matches.push({
                    ...lockfile,
                    path: lockfilePath,
                  })
                }
              }

              return matches.length > 0
                ? Result.succeed({
                    directoryPath,
                    lockfiles: matches,
                  })
                : Result.fail(void 0)
            })
        )
      })

      return {
        resolveLockedVersions: Effect.fn("PackageManagerResolver.resolveLockedVersions")(function* (
          projectPath: string,
          dependencies: readonly LockedVersionDependency[]
        ) {
          const manager = yield* Effect.tryPromise({
            catch: (cause) =>
              new ManifestResolutionError({
                cause,
                path: projectPath,
              }),
            try: () =>
              detectPackageManager(projectPath, {
                ignoreArgv: true,
                includeParentDirs: true,
              }),
          })

          if (manager === undefined) {
            return new Map<string, string>()
          }

          const strategy = getPackageManagerLockfileStrategy(manager.name)
          const locatedLockfiles = yield* findNearestLockfiles(
            projectPath,
            getLockfiles(manager.name, manager.lockFile)
          )

          if (strategy === undefined || Option.isNone(locatedLockfiles)) {
            return new Map<string, string>()
          }

          const located = locatedLockfiles.value
          const rawProjectRelativePath = path.relative(located.directoryPath, projectPath)
          const projectRelativePath =
            rawProjectRelativePath.length === 0
              ? "."
              : rawProjectRelativePath.split(path.sep).join("/")
          const unresolved = new Set(dependencies.map((dependency) => dependency.name))
          const versions = new Map<string, string>()

          for (const lockfile of located.lockfiles) {
            if (lockfile.isText === false) {
              continue
            }

            const rawLockfile = yield* fs
              .readFileString(lockfile.path)
              .pipe(toManifestResolutionError(lockfile.path))

            for (const dependency of dependencies) {
              if (!unresolved.has(dependency.name)) {
                continue
              }

              const resolvedVersion = strategy
                .resolve(rawLockfile, {
                  ...dependency,
                  projectRelativePath,
                })
                .pipe(Option.filter((version) => valid(version) !== null))

              if (Option.isSome(resolvedVersion)) {
                versions.set(dependency.name, resolvedVersion.value)
                unresolved.delete(dependency.name)
              }
            }

            if (unresolved.size === 0) {
              break
            }
          }

          return versions
        }),
      }
    })
  )
}

const readNodeModulesVersion = Effect.fn("readNodeModulesVersion")(function* (
  projectPath: string,
  packageName: string
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path

  return yield* Effect.findFirstFilter(ancestorDirectories(path, projectPath), (directoryPath) =>
    Effect.gen(function* () {
      const packageJsonPath = path.join(directoryPath, "node_modules", packageName, "package.json")
      const rawPackageJson = yield* fs.readFileString(packageJsonPath).pipe(
        Effect.catchFilter(Filter.reason("PlatformError", "NotFound"), () =>
          Effect.succeed(void 0)
        ),
        toManifestParseError(packageJsonPath)
      )

      if (rawPackageJson === undefined) {
        return Result.fail(void 0)
      }

      const manifest = yield* decodeInstalledPackage(rawPackageJson).pipe(
        toManifestParseError(packageJsonPath)
      )

      return valid(manifest.version) === null
        ? Result.fail(void 0)
        : Result.succeed(manifest.version)
    })
  )
})

export const readJavascriptManifest = Effect.fn("readJavascriptManifest")(function* (
  projectPath: string
) {
  const fs = yield* FileSystem.FileSystem
  const path = yield* Path.Path
  const packageManagerResolver = yield* PackageManagerResolver
  const manifestPath = path.join(projectPath, "package.json")
  const rawManifest = yield* fs
    .readFileString(manifestPath)
    .pipe(toManifestParseError(manifestPath))
  const manifest = yield* decodeJavascriptManifest(rawManifest).pipe(
    toManifestParseError(manifestPath)
  )
  const dependencies = new Map<string, Omit<ManifestDependency, "exactVersion">>()

  for (const group of DEPENDENCY_GROUPS) {
    const entries = manifest[group]

    if (entries === undefined) {
      continue
    }

    for (const [name, specifier] of Object.entries(entries)) {
      if (!dependencies.has(name)) {
        dependencies.set(name, {
          group,
          name,
          registry: "npm",
          specifier,
        })
      }
    }
  }

  const lockedVersions = yield* packageManagerResolver.resolveLockedVersions(projectPath, [
    ...dependencies.values(),
  ])

  return yield* Effect.forEach(
    dependencies.values(),
    (dependency) => {
      const lockedVersion = lockedVersions.get(dependency.name)
      const exactVersion =
        lockedVersion === undefined
          ? readNodeModulesVersion(projectPath, dependency.name)
          : Effect.succeedSome(lockedVersion)

      return Effect.map(
        exactVersion,
        Option.match({
          onNone: (): ManifestDependency => dependency,
          onSome: (exactVersion): ManifestDependency => ({
            ...dependency,
            exactVersion,
          }),
        })
      )
    },
    { concurrency: NODE_MODULES_RESOLUTION_CONCURRENCY }
  )
})

export default defineManifest({
  detect: Effect.fn("javascriptManifest.detect")(function* (projectPath) {
    const fs = yield* FileSystem.FileSystem
    const path = yield* Path.Path
    const manifestPath = path.join(projectPath, "package.json")

    return yield* fs.exists(manifestPath).pipe(toManifestParseError(manifestPath))
  }),
  name: "javascript",
  read: readJavascriptManifest,
})
