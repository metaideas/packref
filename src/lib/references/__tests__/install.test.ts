import { afterEach, describe, expect, it } from "bun:test"
import { mkdir, mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { createTarGzip } from "nanotar"
import type { PackageEntry } from "#lib/workspace/lockfile.ts"
import { exists, initializeProject } from "#commands/__tests__/helpers.ts"
import {
  InstallPackageReferencesError,
  StoreSourceMismatchError,
  TarballFetchError,
} from "#lib/core/errors.ts"
import { installPackageReferences } from "#lib/references/install.ts"
import { RepositoryDownloader } from "#lib/sources/repository/fetch.ts"
import { RemoteTagReader } from "#lib/sources/repository/tags.ts"
import { PackrefHome } from "#lib/workspace/home.ts"
import { Reflinker } from "#lib/workspace/reflinker.ts"

interface TestRepositorySource {
  directory?: string
  host: string
  requestedRef?: string
  type: "repository"
  url: string
}

const temporaryPaths: string[] = []

const makeTempDirectory = async () => {
  const directoryPath = await mkdtemp(join(tmpdir(), "packref-install-test-"))
  temporaryPaths.push(directoryPath)
  return directoryPath
}

const tarballEntry = (
  name: string,
  version: string,
  tracking: PackageEntry["tracking"] = "manual",
  url = `https://registry.npmjs.org/${name}/-/${name}-${version}.tgz`
) =>
  ({
    name,
    registry: "npm",
    source: { type: "tarball", url },
    tracking,
    version,
  }) satisfies PackageEntry

const repositoryEntry = (
  name: string,
  version: string,
  directory?: string,
  tracking: PackageEntry["tracking"] = "manual"
) => {
  const source: TestRepositorySource = {
    host: "github.com",
    type: "repository",
    url: `https://github.com/example/${name.replace("@scope/", "")}`,
  }

  if (directory !== undefined) {
    source.directory = directory
  }

  return {
    name,
    registry: "npm",
    source,
    tracking,
    version,
  } satisfies PackageEntry
}

const getIdentitySegments = (entry: PackageEntry) => [
  "packages",
  entry.registry,
  ...entry.name.split("/"),
  entry.version,
]

const getReferencePath = (projectPath: string, entry: PackageEntry) =>
  join(projectPath, ".packref", ...getIdentitySegments(entry))

const materializeStoredEntry = async (home: string, entry: PackageEntry) => {
  const segments = getIdentitySegments(entry)
  const entryPath = join(home, ".agents", "packref", "store", ...segments)
  const metadataPath = join(
    home,
    ".agents",
    "packref",
    "store",
    ".metadata",
    ...segments.slice(0, -1),
    `${entry.version}.json`
  )
  await mkdir(entryPath, { recursive: true })
  await mkdir(join(metadataPath, ".."), { recursive: true })
  await writeFile(join(entryPath, "SOURCE.md"), `${entry.name}@${entry.version}`)
  await writeFile(metadataPath, `${JSON.stringify({ source: entry.source }, null, 2)}\n`)
  return entryPath
}

interface TestControls {
  readonly failedTarballUrls?: readonly string[]
  readonly repositoryRefs?: string[]
  repositoryDownloads: number
  tarballDownloads: number
}

const makeTestLayer = (home: string, controls: TestControls) =>
  Layer.mergeAll(
    NodeServices.layer,
    PackrefHome.at(home),
    Reflinker.layer,
    RemoteTagReader.layerWithCommand(() =>
      Effect.succeed({
        exitCode: 0,
        stderr: "",
        stdout: "abc123\trefs/tags/v1.0.0\nabc456\trefs/tags/v2.0.0",
      })
    ),
    Layer.succeed(RepositoryDownloader)({
      download: (_source, ref, destination) => {
        controls.repositoryRefs?.push(ref)
        const nextDownloadCount = controls.repositoryDownloads + 1
        Object.assign(controls, { repositoryDownloads: nextDownloadCount })
        return Effect.promise(async () => {
          await mkdir(join(destination, "packages", "example"), { recursive: true })
          await writeFile(join(destination, "README.md"), "repository root")
          await writeFile(join(destination, "packages", "example", "index.ts"), "package source")
        })
      },
    }),
    Layer.succeed(
      HttpClient.HttpClient,
      HttpClient.make((request, url) => {
        const nextDownloadCount = controls.tarballDownloads + 1
        Object.assign(controls, { tarballDownloads: nextDownloadCount })

        if (controls.failedTarballUrls?.includes(url.href) === true) {
          return Effect.succeed(
            HttpClientResponse.fromWeb(request, new Response(null, { status: 500 }))
          )
        }

        return Effect.promise(() =>
          createTarGzip([
            {
              data: `source from ${request.url}`,
              name: "package/SOURCE.md",
            },
          ])
        ).pipe(
          Effect.map((archive) =>
            HttpClientResponse.fromWeb(request, new Response(archive, { status: 200 }))
          )
        )
      })
    )
  )

const runInstall = (projectPath: string, home: string, controls?: TestControls) => {
  const resolvedControls = controls ?? {
    repositoryDownloads: 0,
    tarballDownloads: 0,
  }

  return Effect.runPromise(
    installPackageReferences({ projectPath }).pipe(
      Effect.provide(makeTestLayer(home, resolvedControls))
    )
  )
}

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

describe("installPackageReferences", () => {
  it("treats an empty lockfile as a no-op and registers the canonical project", async () => {
    const projectPath = await makeTempDirectory()
    const home = await makeTempDirectory()
    await initializeProject(projectPath, [])
    const lockfilePath = join(projectPath, ".packref", "packref-lock.json")
    const before = await readFile(lockfilePath, "utf8")

    const result = await runInstall(projectPath, home)
    const config = JSON.parse(
      await readFile(join(home, ".agents", "packref", "config.json"), "utf8")
    )

    expect(result).toMatchObject({ alreadyInstalled: [], fetched: [], reused: [] })
    expect(result.projectPath).toBe(await realpath(projectPath))
    expect(config.projects).toEqual([await realpath(projectPath)])
    expect(await readFile(lockfilePath, "utf8")).toBe(before)
  })

  it("fetches and materializes a locked repository package directory", async () => {
    const projectPath = await makeTempDirectory()
    const home = await makeTempDirectory()
    const entry = repositoryEntry("example", "1.0.0", "packages/example")
    const controls = { repositoryDownloads: 0, tarballDownloads: 0 }
    await initializeProject(projectPath, [entry])
    const lockfilePath = join(projectPath, ".packref", "packref-lock.json")
    const before = await readFile(lockfilePath, "utf8")

    const result = await runInstall(projectPath, home, controls)
    const referencePath = getReferencePath(projectPath, entry)

    expect(result.fetched).toEqual([entry])
    expect(controls.repositoryDownloads).toBe(1)
    expect(await readFile(join(referencePath, "index.ts"), "utf8")).toBe("package source")
    expect(await exists(join(referencePath, "README.md"))).toBe(false)
    expect(await readFile(lockfilePath, "utf8")).toBe(before)
  })

  it.each([
    { requestedRef: undefined, version: "1.0.0" },
    {
      requestedRef: "v1.0.0",
      version: "abcdef1234567890abcdef1234567890abcdef12",
    },
  ])(
    "reinstalls a direct repository entry with exact pinned ref $version",
    async ({ requestedRef, version }) => {
      const projectPath = await makeTempDirectory()
      const home = await makeTempDirectory()
      const source: TestRepositorySource = {
        host: "github.com",
        type: "repository",
        url: "https://github.com/owner/repo",
      }

      if (requestedRef !== undefined) {
        source.requestedRef = requestedRef
      }

      const entry = {
        ...repositoryEntry("owner/repo", version),
        registry: "github",
        source,
      } satisfies PackageEntry
      const repositoryRefs: string[] = []
      const controls = { repositoryDownloads: 0, repositoryRefs, tarballDownloads: 0 }
      await initializeProject(projectPath, [entry])

      await runInstall(projectPath, home, controls)

      expect(repositoryRefs).toEqual([version])
    }
  )

  it("fetches and materializes a locked repository package at the repository root", async () => {
    const projectPath = await makeTempDirectory()
    const home = await makeTempDirectory()
    const entry = repositoryEntry("example", "1.0.0")
    const controls = { repositoryDownloads: 0, tarballDownloads: 0 }
    await initializeProject(projectPath, [entry])

    const result = await runInstall(projectPath, home, controls)
    const referencePath = getReferencePath(projectPath, entry)

    expect(result.fetched).toEqual([entry])
    expect(controls.repositoryDownloads).toBe(1)
    expect(await readFile(join(referencePath, "README.md"), "utf8")).toBe("repository root")
  })

  it("fetches and materializes a locked tarball", async () => {
    const projectPath = await makeTempDirectory()
    const home = await makeTempDirectory()
    const entry = tarballEntry("example", "1.0.0", "dependency")
    const controls = { repositoryDownloads: 0, tarballDownloads: 0 }
    await initializeProject(projectPath, [entry])

    const result = await runInstall(projectPath, home, controls)

    expect(result.fetched).toEqual([entry])
    expect(controls.tarballDownloads).toBe(1)
    expect(
      await readFile(join(getReferencePath(projectPath, entry), "SOURCE.md"), "utf8")
    ).toContain(entry.source.url)
  })

  it("reuses a compatible global entry without fetching", async () => {
    const projectPath = await makeTempDirectory()
    const home = await makeTempDirectory()
    const entry = tarballEntry("example", "1.0.0")
    const controls = { repositoryDownloads: 0, tarballDownloads: 0 }
    await initializeProject(projectPath, [entry])
    await materializeStoredEntry(home, entry)

    const result = await runInstall(projectPath, home, controls)

    expect(result.reused).toEqual([entry])
    expect(controls.tarballDownloads).toBe(0)
    expect(await exists(getReferencePath(projectPath, entry))).toBe(true)
  })

  it("skips an existing project reference without inspecting or fetching the store", async () => {
    const projectPath = await makeTempDirectory()
    const home = await makeTempDirectory()
    const entry = repositoryEntry("example", "1.0.0")
    await initializeProject(projectPath, [entry])
    const referencePath = getReferencePath(projectPath, entry)
    await mkdir(referencePath, { recursive: true })
    await writeFile(join(referencePath, "SOURCE.md"), "existing")

    const result = await runInstall(projectPath, home)

    expect(result.alreadyInstalled).toEqual([entry])
    expect(await readFile(join(referencePath, "SOURCE.md"), "utf8")).toBe("existing")
  })

  it("installs manual, dependency-tracked, scoped, and multiple-version entries", async () => {
    const projectPath = await makeTempDirectory()
    const home = await makeTempDirectory()
    const entries = [
      tarballEntry("@scope/pkg", "1.0.0", "manual"),
      tarballEntry("example", "1.0.0", "dependency"),
      tarballEntry("example", "2.0.0", "manual"),
    ]
    await initializeProject(projectPath, entries.toReversed())
    await Promise.all(entries.map((entry) => materializeStoredEntry(home, entry)))

    const result = await runInstall(projectPath, home)

    expect(result.reused).toEqual(entries)
    await Promise.all(
      entries.map(async (entry) => {
        expect(await exists(getReferencePath(projectPath, entry))).toBe(true)
      })
    )
  })

  it("rejects a global store entry whose source differs from the lockfile", async () => {
    const projectPath = await makeTempDirectory()
    const home = await makeTempDirectory()
    const lockedEntry = tarballEntry("example", "1.0.0")
    const storedEntry = tarballEntry(
      "example",
      "1.0.0",
      "manual",
      "https://registry.npmjs.org/example/-/different.tgz"
    )
    await initializeProject(projectPath, [lockedEntry])
    await materializeStoredEntry(home, storedEntry)

    let mismatch: unknown

    try {
      await runInstall(projectPath, home)
    } catch (error) {
      mismatch = error
    }

    expect(mismatch).toBeInstanceOf(InstallPackageReferencesError)
    expect(mismatch).toMatchObject({
      failures: [{ cause: expect.any(StoreSourceMismatchError), identity: lockedEntry }],
    })
    expect(await exists(getReferencePath(projectPath, lockedEntry))).toBe(false)
  })

  it("keeps completed references after failure and resumes without rewriting the lockfile", async () => {
    const projectPath = await makeTempDirectory()
    const home = await makeTempDirectory()
    const first = tarballEntry("first", "1.0.0")
    const second = tarballEntry("second", "1.0.0")
    await initializeProject(projectPath, [first, second])
    const lockfilePath = join(projectPath, ".packref", "packref-lock.json")
    const before = await readFile(lockfilePath, "utf8")
    const failingControls = {
      failedTarballUrls: [second.source.url],
      repositoryDownloads: 0,
      tarballDownloads: 0,
    }

    let failure: unknown

    try {
      await runInstall(projectPath, home, failingControls)
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(InstallPackageReferencesError)
    expect(failure).toMatchObject({
      failures: [{ cause: expect.any(TarballFetchError), identity: second }],
    })
    expect(await exists(getReferencePath(projectPath, first))).toBe(true)
    expect(await exists(getReferencePath(projectPath, second))).toBe(false)
    expect(await readFile(lockfilePath, "utf8")).toBe(before)

    const result = await runInstall(projectPath, home)

    expect(result.alreadyInstalled).toEqual([first])
    expect(result.fetched).toEqual([second])
    expect(await exists(getReferencePath(projectPath, second))).toBe(true)
    expect(await readFile(lockfilePath, "utf8")).toBe(before)
  })

  it("reports every failed package identity and preserves successful work", async () => {
    const projectPath = await makeTempDirectory()
    const home = await makeTempDirectory()
    const firstFailure = tarballEntry("first-failure", "1.0.0")
    const success = tarballEntry("success", "1.0.0")
    const secondFailure = tarballEntry("second-failure", "1.0.0")
    await initializeProject(projectPath, [firstFailure, success, secondFailure])

    let failure: unknown

    try {
      await runInstall(projectPath, home, {
        failedTarballUrls: [firstFailure.source.url, secondFailure.source.url],
        repositoryDownloads: 0,
        tarballDownloads: 0,
      })
    } catch (error) {
      failure = error
    }

    expect(failure).toBeInstanceOf(InstallPackageReferencesError)
    expect(failure).toMatchObject({
      failures: [
        { cause: expect.any(TarballFetchError), identity: firstFailure },
        { cause: expect.any(TarballFetchError), identity: secondFailure },
      ],
    })
    expect(await exists(getReferencePath(projectPath, success))).toBe(true)
    expect(await exists(getReferencePath(projectPath, firstFailure))).toBe(false)
    expect(await exists(getReferencePath(projectPath, secondFailure))).toBe(false)
  })

  it("rejects absent projects and malformed lockfiles", async () => {
    const projectPath = await makeTempDirectory()
    const home = await makeTempDirectory()

    let notInitialized: unknown

    try {
      await runInstall(projectPath, home)
    } catch (error) {
      notInitialized = error
    }

    expect(notInitialized).toMatchObject({ _tag: "NotInitializedError" })

    await mkdir(join(projectPath, ".packref"), { recursive: true })
    await writeFile(join(projectPath, ".packref", "packref-lock.json"), "{")

    let malformed: unknown

    try {
      await runInstall(projectPath, home)
    } catch (error) {
      malformed = error
    }

    expect(malformed).toMatchObject({ _tag: "LockfileParseError" })
  })

  it("rejects duplicate lockfile identities before materializing either source", async () => {
    const projectPath = await makeTempDirectory()
    const home = await makeTempDirectory()
    const first = tarballEntry("example", "1.0.0")
    const second = tarballEntry(
      "example",
      "1.0.0",
      "manual",
      "https://registry.npmjs.org/example/-/different.tgz"
    )
    const controls = { repositoryDownloads: 0, tarballDownloads: 0 }
    await initializeProject(projectPath, [first, second])

    let duplicate: unknown

    try {
      await runInstall(projectPath, home, controls)
    } catch (error) {
      duplicate = error
    }

    expect(duplicate).toMatchObject({
      _tag: "LockfileParseError",
      cause: expect.objectContaining({
        message: "Duplicate package identity: npm:example@1.0.0",
      }),
    })
    expect(controls.tarballDownloads).toBe(0)
    expect(await exists(getReferencePath(projectPath, first))).toBe(false)
    expect(await exists(join(home, ".agents", "packref", "config.json"))).toBe(false)
  })
})
