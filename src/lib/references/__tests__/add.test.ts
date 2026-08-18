import { afterEach, describe, expect, it } from "bun:test"
import { access, mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"

import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Predicate from "effect/Predicate"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { createTarGzip } from "nanotar"
import type { NpmPackageMetadata } from "#lib/registries/npm/metadata.ts"
import type { PackageEntry } from "#lib/workspace/lockfile.ts"
import { NetworkError, ReflinkError, SnapshotFetchError } from "#lib/core/errors.ts"
import { parsePackageSpec } from "#lib/core/packages.ts"
import { ProjectDependencyReader } from "#lib/manifests/index.ts"
import { PackageManagerResolver } from "#lib/manifests/javascript.ts"
import {
  addPackageReference,
  findPackageCandidates,
  materializePackageCandidateReference,
  resolvePackageCandidateReference,
} from "#lib/references/add.ts"
import { NpmRegistryClient } from "#lib/registries/npm/client.ts"
import { RepositoryDownloader } from "#lib/sources/repository/fetch.ts"
import { RemoteTagReader } from "#lib/sources/repository/tags.ts"
import { PackrefHome } from "#lib/workspace/home.ts"
import { Reflinker } from "#lib/workspace/reflinker.ts"

const temporaryPaths: string[] = []

const makeTempDirectory = async () => {
  const directoryPath = await mkdtemp(join(tmpdir(), "packref-add-test-"))
  temporaryPaths.push(directoryPath)
  return directoryPath
}

const exists = (path: string) =>
  access(path)
    .then(() => true)
    .catch(() => false)

type VersionMetadata = {
  -readonly [
    Key in keyof NpmPackageMetadata["versions"][string]
  ]: NpmPackageMetadata["versions"][string][Key]
}

const makeVersionMetadata = (name: string, version: string, repository?: string) => {
  const metadata: VersionMetadata = {
    dist: {
      tarball: `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`,
    },
    version,
  }

  if (repository !== undefined) {
    metadata.repository = repository
  }

  return metadata
}

const makeMetadata = (
  name: string,
  versions: readonly string[],
  repository: string | null = "github:example/example"
) =>
  ({
    "dist-tags": {
      latest: versions.at(-1),
    },
    name,
    versions: Object.fromEntries(
      versions.map((version) => [
        version,
        makeVersionMetadata(name, version, repository ?? undefined),
      ])
    ),
  }) satisfies NpmPackageMetadata

interface TestServices {
  readonly commandResult?: {
    readonly exitCode: number
    readonly stderr: string
    readonly stdout: string
  }
  readonly exactVersion?: string
  readonly metadata: NpmPackageMetadata
  readonly repositoryDownload?: RepositoryDownloader["Service"]["download"]
  readonly tarballDownload?: () => Effect.Effect<Uint8Array>
}

const makeTestLayer = (services: TestServices, home: string) => {
  const packageManagerLayer = Layer.succeed(PackageManagerResolver)({
    resolveLockedVersions: (_projectPath, dependencies) => {
      const exactVersion = services.exactVersion

      return Effect.succeed(
        exactVersion === undefined
          ? new Map<string, string>()
          : new Map(dependencies.map((dependency) => [dependency.name, exactVersion] as const))
      )
    },
  })
  const manifestLayer = Layer.provideMerge(
    ProjectDependencyReader.layer,
    Layer.mergeAll(NodeServices.layer, packageManagerLayer)
  )

  return Layer.mergeAll(
    NodeServices.layer,
    PackrefHome.at(home),
    manifestLayer,
    Reflinker.layer,
    Layer.succeed(NpmRegistryClient)({
      getPackageMetadata: () => Effect.succeed(services.metadata),
    }),
    RemoteTagReader.layerWithCommand(() =>
      Effect.succeed(
        services.commandResult ?? {
          exitCode: 0,
          stderr: "",
          stdout: Object.keys(services.metadata.versions)
            .map((version) => `abc123\trefs/tags/v${version}`)
            .join("\n"),
        }
      )
    ),
    Layer.succeed(RepositoryDownloader)({
      download:
        services.repositoryDownload ??
        ((_source, _ref, destination) =>
          Effect.promise(() => writeFile(join(destination, "SOURCE.md"), "repository source"))),
    }),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request) =>
        (
          services.tarballDownload ??
          (() =>
            Effect.tryPromise(() =>
              createTarGzip([
                {
                  data: "tarball source",
                  name: "package/SOURCE.md",
                },
              ])
            ))
        )().pipe(
          Effect.map((archive) => HttpClientResponse.fromWeb(request, new Response(archive)))
        )
      )
    )
  )
}

const runAdd = (packageSpec: string, projectPath: string, home: string, services: TestServices) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const spec = yield* parsePackageSpec(packageSpec)

      return yield* addPackageReference(spec, {
        projectPath,
      })
    }).pipe(Effect.provide(makeTestLayer(services, home)))
  )

const runCandidateAdd = (projectPath: string, home: string, services: TestServices) =>
  Effect.runPromise(
    Effect.gen(function* () {
      const candidates = yield* findPackageCandidates({ projectPath })
      const dependency = candidates.dependencies[0]

      if (Predicate.isUndefined(dependency)) {
        return yield* Effect.die("Expected an add candidate")
      }

      const resolution = yield* resolvePackageCandidateReference(dependency)

      return yield* materializePackageCandidateReference(resolution, candidates.projectPath)
    }).pipe(Effect.provide(makeTestLayer(services, home)))
  )

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((directoryPath) =>
      rm(directoryPath, {
        force: true,
        recursive: true,
      })
    )
  )
})

describe("addPackageReference", () => {
  it("adds and materializes a direct repository reference with an exact identity", async () => {
    const projectPath = await makeTempDirectory()
    const home = await makeTempDirectory()
    await writeFile(join(projectPath, "package.json"), JSON.stringify({}))
    const commitSha = "abcdef1234567890abcdef1234567890abcdef12"

    const result = await runAdd("github:owner/repo", projectPath, home, {
      commandResult: {
        exitCode: 0,
        stderr: "",
        stdout: `${commitSha}\tHEAD\n${commitSha}\trefs/heads/main\n`,
      },
      metadata: makeMetadata("example", ["1.0.0"]),
    })
    const lockfile = JSON.parse(
      await readFile(join(projectPath, ".packref", "packref-lock.json"), "utf8")
    )
    const expectedEntry = {
      name: "owner/repo",
      registry: "github",
      source: {
        host: "github.com",
        type: "repository",
        url: "https://github.com/owner/repo",
      },
      tracking: "manual",
      version: commitSha,
    } satisfies PackageEntry
    const expectedReferencePath = join(
      await realpath(projectPath),
      ".packref",
      "packages",
      "github",
      "owner",
      "repo",
      commitSha
    )

    expect(result.entry).toEqual(expectedEntry)
    expect(lockfile).toEqual({ packages: [expectedEntry] })
    expect(result.referencePath).toBe(expectedReferencePath)
    expect(await readFile(join(expectedReferencePath, "SOURCE.md"), "utf8")).toBe(
      "repository source"
    )
  })

  it("rejects a second project directory with a resolving conflict error", async () => {
    const projectPath = await makeTempDirectory()
    const home = await makeTempDirectory()
    await writeFile(join(projectPath, "package.json"), JSON.stringify({}))
    const commitSha = "abcdef1234567890abcdef1234567890abcdef12"
    const services = {
      commandResult: {
        exitCode: 0,
        stderr: "",
        stdout: `${commitSha}\tHEAD\n`,
      },
      metadata: makeMetadata("example", ["1.0.0"]),
    }

    await runAdd("github:owner/repo", projectPath, home, services)
    let failure: unknown

    try {
      await runAdd("github:owner/repo/packages/a", projectPath, home, services)
    } catch (error) {
      failure = error
    }

    expect(failure).toHaveProperty("_tag", "RepositoryDirectoryConflictError")
    expect(failure).not.toHaveProperty("existingDirectory")
    expect(failure).toHaveProperty("requestedDirectory", "packages/a")
    expect(failure).toHaveProperty(
      "message",
      expect.stringContaining("Remove the existing package source reference")
    )
  })

  it("reuses one snapshot for different directories in different projects", async () => {
    const firstProjectPath = await makeTempDirectory()
    const secondProjectPath = await makeTempDirectory()
    const home = await makeTempDirectory()
    await writeFile(join(firstProjectPath, "package.json"), JSON.stringify({}))
    await writeFile(join(secondProjectPath, "package.json"), JSON.stringify({}))
    const commitSha = "abcdef1234567890abcdef1234567890abcdef12"
    const services = {
      commandResult: {
        exitCode: 0,
        stderr: "",
        stdout: `${commitSha}\tHEAD\n`,
      },
      metadata: makeMetadata("example", ["1.0.0"]),
      repositoryDownload: (_source: string, _ref: string, destination: string) =>
        Effect.promise(async () => {
          await mkdir(join(destination, "packages", "a"), { recursive: true })
          await mkdir(join(destination, "packages", "b"), { recursive: true })
          await writeFile(join(destination, "packages", "a", "SOURCE.md"), "package a")
          await writeFile(join(destination, "packages", "b", "SOURCE.md"), "package b")
        }),
    }

    const first = await runAdd("github:owner/repo/packages/a", firstProjectPath, home, services)
    const second = await runAdd("github:owner/repo/packages/b", secondProjectPath, home, services)

    expect(first.entry.source).toMatchObject({ directory: "packages/a" })
    expect(second.entry.source).toMatchObject({ directory: "packages/b" })
    expect(first.reusedStoreEntry).toBe(false)
    expect(second.reusedStoreEntry).toBe(true)
    expect(await readFile(join(first.referencePath, "SOURCE.md"), "utf8")).toBe("package a")
    expect(await readFile(join(second.referencePath, "SOURCE.md"), "utf8")).toBe("package b")
  })

  it("keeps requested refs in each project when projects reuse one store entry", async () => {
    const firstProjectPath = await makeTempDirectory()
    const secondProjectPath = await makeTempDirectory()
    const home = await makeTempDirectory()
    await writeFile(join(firstProjectPath, "package.json"), JSON.stringify({}))
    await writeFile(join(secondProjectPath, "package.json"), JSON.stringify({}))
    const commitSha = "abcdef1234567890abcdef1234567890abcdef12"
    const services = {
      commandResult: {
        exitCode: 0,
        stderr: "",
        stdout: `${commitSha}\trefs/heads/main\n${commitSha}\trefs/tags/v1.0.0\n`,
      },
      metadata: makeMetadata("example", ["1.0.0"]),
    }

    const first = await runAdd("github:owner/repo@v1.0.0", firstProjectPath, home, services)
    const second = await runAdd("github:owner/repo@main", secondProjectPath, home, services)

    expect(first.entry.source).toMatchObject({ requestedRef: "v1.0.0" })
    expect(second.entry.source).toMatchObject({ requestedRef: "main" })
    expect(second.reusedStoreEntry).toBe(true)
    expect(
      JSON.parse(
        await readFile(
          join(
            home,
            ".agents",
            "packref",
            "store",
            ".metadata",
            "packages",
            "github",
            "owner",
            "repo",
            `${commitSha}.json`
          ),
          "utf8"
        )
      )
    ).toEqual({
      source: {
        host: "github.com",
        type: "repository",
        url: "https://github.com/owner/repo",
      },
    })
  })

  it("adds a selected candidate through the prepared project context", async () => {
    const projectPath = await makeTempDirectory()
    const home = await makeTempDirectory()
    await writeFile(
      join(projectPath, "package.json"),
      JSON.stringify({ dependencies: { example: "^1.0.0" } })
    )

    const result = await runCandidateAdd(projectPath, home, {
      exactVersion: "1.0.0",
      metadata: makeMetadata("example", ["1.0.0"]),
    })
    const lockfile = JSON.parse(
      await readFile(join(projectPath, ".packref", "packref-lock.json"), "utf8")
    )

    expect(result.entry).toMatchObject({
      name: "example",
      registry: "npm",
      tracking: "dependency",
      version: "1.0.0",
    })
    expect(lockfile.packages).toEqual([result.entry])
  })

  it("auto-initializes and tracks a versionless manifest dependency", async () => {
    const projectPath = await makeTempDirectory()
    const home = await makeTempDirectory()
    await writeFile(
      join(projectPath, "package.json"),
      JSON.stringify({
        dependencies: {
          example: "^1.0.0",
        },
      })
    )

    const result = await runAdd("example", projectPath, home, {
      exactVersion: "1.0.0",
      metadata: makeMetadata("example", ["1.0.0", "2.0.0"]),
    })
    const lockfile = JSON.parse(
      await readFile(join(projectPath, ".packref", "packref-lock.json"), "utf8")
    )
    const config = JSON.parse(
      await readFile(join(home, ".agents", "packref", "config.json"), "utf8")
    )

    expect(result.entry.version).toBe("1.0.0")
    expect(result.entry.tracking).toBe("dependency")
    expect(result.manifestRange).toBeUndefined()
    expect(lockfile.packages).toEqual([result.entry])
    expect(config.projects).toEqual([result.projectPath])
    expect(await readFile(join(result.referencePath, "SOURCE.md"), "utf8")).toBe(
      "repository source"
    )
  })

  it("resolves workspace range dependencies through the registry", async () => {
    const projectPath = await makeTempDirectory()
    const home = await makeTempDirectory()
    await writeFile(
      join(projectPath, "package.json"),
      JSON.stringify({
        dependencies: {
          example: "workspace:^1.0.0",
        },
      })
    )

    const result = await runAdd("example", projectPath, home, {
      metadata: makeMetadata("example", ["1.0.0", "2.0.0"], null),
    })

    expect(result.entry.version).toBe("1.0.0")
    expect(result.entry.tracking).toBe("dependency")
    expect(result.manifestRange).toBe("^1.0.0")
  })

  it("resolves bare workspace dependencies through the registry as any version", async () => {
    const projectPath = await makeTempDirectory()
    const home = await makeTempDirectory()
    await writeFile(
      join(projectPath, "package.json"),
      JSON.stringify({
        dependencies: {
          example: "workspace:*",
        },
      })
    )

    const result = await runAdd("example", projectPath, home, {
      metadata: makeMetadata("example", ["1.0.0", "2.0.0"], null),
    })

    expect(result.entry.version).toBe("2.0.0")
    expect(result.manifestRange).toBe("*")
  })

  it("tracks explicit versions and non-manifest latest versions as manual", async () => {
    const projectPath = await makeTempDirectory()
    const home = await makeTempDirectory()
    await writeFile(
      join(projectPath, "package.json"),
      JSON.stringify({
        dependencies: {
          example: "^1.0.0",
        },
      })
    )
    const services = {
      exactVersion: "1.0.0",
      metadata: makeMetadata("example", ["1.0.0", "2.0.0"]),
    }

    const explicit = await runAdd("example@2.0.0", projectPath, home, services)

    await writeFile(join(projectPath, "package.json"), JSON.stringify({ dependencies: {} }))
    const latest = await runAdd("example", projectPath, home, services)

    expect(explicit.entry).toMatchObject({
      tracking: "manual",
      version: "2.0.0",
    })
    expect(explicit.manifestRange).toBeUndefined()
    expect(latest.entry).toMatchObject({
      tracking: "manual",
      version: "2.0.0",
    })
    expect(latest.manifestRange).toBeUndefined()
  })

  it("is idempotent for one identity and permits multiple versions", async () => {
    const projectPath = await makeTempDirectory()
    const home = await makeTempDirectory()
    await writeFile(join(projectPath, "package.json"), JSON.stringify({}))
    let downloadCount = 0
    const services = {
      commandResult: {
        exitCode: 0,
        stderr: "",
        stdout: "abc123\trefs/tags/v1.0.0\ndef456\trefs/tags/v2.0.0\n",
      },
      metadata: makeMetadata("example", ["1.0.0", "2.0.0"]),
      repositoryDownload: (_source: string, _ref: string, destination: string) => {
        downloadCount += 1
        return Effect.promise(() => writeFile(join(destination, "SOURCE.md"), "source"))
      },
    }

    const first = await runAdd("example@1.0.0", projectPath, home, services)
    const repeated = await runAdd("example@1.0.0", projectPath, home, services)
    await runAdd("example@2.0.0", projectPath, home, services)
    const lockfile = JSON.parse(
      await readFile(join(projectPath, ".packref", "packref-lock.json"), "utf8")
    )

    expect(first.reusedStoreEntry).toBe(false)
    expect(repeated.reusedStoreEntry).toBe(true)
    expect(downloadCount).toBe(2)
    expect(lockfile).toEqual({
      packages: [
        expect.objectContaining({ version: "1.0.0" }),
        expect.objectContaining({ version: "2.0.0" }),
      ],
    })
  })

  it("reuses the stored source provenance when later resolution chooses another source", async () => {
    const firstProjectPath = await makeTempDirectory()
    const secondProjectPath = await makeTempDirectory()
    const home = await makeTempDirectory()
    await writeFile(join(firstProjectPath, "package.json"), JSON.stringify({}))
    await writeFile(join(secondProjectPath, "package.json"), JSON.stringify({}))

    const first = await runAdd("example@1.0.0", firstProjectPath, home, {
      metadata: makeMetadata("example", ["1.0.0"], null),
    })
    const repositoryMetadata = {
      ...makeMetadata("example", ["1.0.0"]),
      versions: {
        "1.0.0": {
          dist: {
            tarball: "https://registry.npmjs.org/example/-/example-1.0.0.tgz",
          },
          repository: {
            directory: "packages/example",
            type: "git",
            url: "github:example/example",
          },
          version: "1.0.0",
        },
      },
    } satisfies NpmPackageMetadata
    let repositoryDownloadCount = 0
    const second = await runAdd("example@1.0.0", secondProjectPath, home, {
      metadata: repositoryMetadata,
      repositoryDownload: (_source, _ref, destination) => {
        repositoryDownloadCount += 1
        return Effect.promise(() => writeFile(join(destination, "SOURCE.md"), "repository source"))
      },
    })
    const secondLockfile = JSON.parse(
      await readFile(join(secondProjectPath, ".packref", "packref-lock.json"), "utf8")
    )

    expect(first.entry.source.type).toBe("tarball")
    expect(second.reusedStoreEntry).toBe(true)
    expect(second.entry.source).toEqual(first.entry.source)
    expect(secondLockfile.packages[0]?.source).toEqual(first.entry.source)
    expect(repositoryDownloadCount).toBe(0)
    expect(await readFile(join(second.referencePath, "SOURCE.md"), "utf8")).toBe("tarball source")
  })

  it.each([
    {
      commandResult: undefined,
      label: "missing repository metadata",
      repository: null,
    },
    {
      commandResult: undefined,
      label: "invalid repository metadata",
      repository: "",
    },
    {
      commandResult: undefined,
      label: "an unsupported repository host",
      repository: "https://code.example.com/example/example.git",
    },
    {
      commandResult: {
        exitCode: 0,
        stderr: "",
        stdout: "abc123\trefs/tags/v0.9.0\n",
      },
      label: "a missing repository tag",
      repository: "github:example/example",
    },
  ])("falls back to the npm tarball for $label", async ({ commandResult, repository }) => {
    const projectPath = await makeTempDirectory()
    const home = await makeTempDirectory()
    await writeFile(join(projectPath, "package.json"), JSON.stringify({}))
    let tarballDownloadCount = 0
    const result = await runAdd("example@1.0.0", projectPath, home, {
      commandResult,
      metadata: makeMetadata("example", ["1.0.0"], repository),
      tarballDownload: () => {
        tarballDownloadCount += 1
        return Effect.tryPromise(() =>
          createTarGzip([
            {
              data: "fallback",
              name: "package/index.js",
            },
          ])
        )
      },
    })

    expect(result.entry.source).toEqual({
      type: "tarball",
      url: "https://registry.npmjs.org/example/-/example-1.0.0.tgz",
    })
    expect(tarballDownloadCount).toBe(1)
    expect(await readFile(join(result.referencePath, "index.js"), "utf8")).toBe("fallback")
  })

  it("does not fall back for network failures during tag discovery", async () => {
    const projectPath = await makeTempDirectory()
    const home = await makeTempDirectory()
    await writeFile(join(projectPath, "package.json"), JSON.stringify({}))
    let tarballDownloadCount = 0

    expect(
      runAdd("example@1.0.0", projectPath, home, {
        commandResult: {
          exitCode: 128,
          stderr: "authentication failed",
          stdout: "",
        },
        metadata: makeMetadata("example", ["1.0.0"]),
        tarballDownload: () => {
          tarballDownloadCount += 1
          return Effect.succeed(new Uint8Array())
        },
      })
    ).rejects.toBeInstanceOf(NetworkError)

    expect(tarballDownloadCount).toBe(0)
    const lockfile = JSON.parse(
      await readFile(join(projectPath, ".packref", "packref-lock.json"), "utf8")
    )
    expect(lockfile).toEqual({ packages: [] })
  })

  it("does not mutate the lockfile when snapshot fetching fails", async () => {
    const projectPath = await makeTempDirectory()
    const home = await makeTempDirectory()
    await writeFile(join(projectPath, "package.json"), JSON.stringify({}))

    expect(
      runAdd("example@1.0.0", projectPath, home, {
        metadata: makeMetadata("example", ["1.0.0"]),
        repositoryDownload: () =>
          Effect.fail(
            new SnapshotFetchError({
              cause: "failed",
              source: "github:example/example#v1.0.0",
            })
          ),
      })
    ).rejects.toBeInstanceOf(SnapshotFetchError)

    const lockfile = JSON.parse(
      await readFile(join(projectPath, ".packref", "packref-lock.json"), "utf8")
    )
    expect(lockfile).toEqual({ packages: [] })
  })

  it("keeps a fetched store entry but not a lockfile entry when project materialization fails", async () => {
    const projectPath = await makeTempDirectory()
    const home = await makeTempDirectory()
    await writeFile(join(projectPath, "package.json"), JSON.stringify({}))
    const baseMetadata = makeMetadata("example", ["1.0.0"])
    const metadata = {
      ...baseMetadata,
      versions: {
        "1.0.0": {
          dist: {
            tarball: "https://registry.npmjs.org/example/-/example-1.0.0.tgz",
          },
          repository: {
            directory: "packages/missing",
            type: "git",
            url: "github:example/example",
          },
          version: "1.0.0",
        },
      },
    } satisfies NpmPackageMetadata

    expect(
      runAdd("example@1.0.0", projectPath, home, {
        metadata,
      })
    ).rejects.toBeInstanceOf(ReflinkError)

    const lockfile = JSON.parse(
      await readFile(join(projectPath, ".packref", "packref-lock.json"), "utf8")
    )
    expect(lockfile).toEqual({ packages: [] })
    expect(
      await exists(join(home, ".agents", "packref", "store", "packages", "npm", "example", "1.0.0"))
    ).toBe(true)
  })
})
