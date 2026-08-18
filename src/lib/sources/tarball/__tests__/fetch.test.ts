import { afterEach, describe, expect, it } from "bun:test"
import type * as FileSystem from "effect/FileSystem"
import type * as Path from "effect/Path"
import { access, mkdtemp, readFile, readdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as HttpClient from "effect/unstable/http/HttpClient"
import * as HttpClientResponse from "effect/unstable/http/HttpClientResponse"
import { createTarGzip } from "nanotar"
import { TarballFetchError } from "#lib/core/errors.ts"
import { fetchTarballSnapshot } from "#lib/sources/tarball/fetch.ts"
import { PackrefHome } from "#lib/workspace/home.ts"

const temporaryPaths: string[] = []

const makeTempDirectory = async () => {
  const directoryPath = await mkdtemp(join(tmpdir(), "packref-tarball-fetch-test-"))
  temporaryPaths.push(directoryPath)
  return directoryPath
}

const identity = {
  name: "example",
  registry: "npm",
  version: "1.0.0",
}

const tarballUrl = "https://registry.npmjs.org/example/-/example-1.0.0.tgz"

const exists = (path: string) =>
  access(path)
    .then(() => true)
    .catch(() => false)

const run = <A, E>(
  effect: Effect.Effect<A, E, FileSystem.FileSystem | HttpClient.HttpClient | Path.Path>,
  home: string,
  download: () => Effect.Effect<Uint8Array>,
  getStatus: () => number = () => 200
) =>
  Effect.runPromise(
    effect.pipe(
      Effect.provide(
        Layer.mergeAll(
          NodeServices.layer,
          PackrefHome.at(home),
          Layer.succeed(
            HttpClient.HttpClient,
            HttpClient.make((request) =>
              download().pipe(
                Effect.map((archive) =>
                  HttpClientResponse.fromWeb(
                    request,
                    new Response(archive, {
                      status: getStatus(),
                    })
                  )
                )
              )
            )
          )
        )
      )
    )
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

describe("fetchTarballSnapshot", () => {
  it("extracts package contents without the package/ prefix", async () => {
    const home = await makeTempDirectory()
    const archive = await createTarGzip([
      {
        name: "package/",
      },
      {
        data: "export const answer = 42",
        name: "package/src/index.ts",
      },
    ])
    const result = await run(fetchTarballSnapshot(identity, tarballUrl), home, () =>
      Effect.succeed(archive)
    )

    expect(result.reused).toBe(false)
    expect(await readFile(join(result.path, "src", "index.ts"), "utf8")).toBe(
      "export const answer = 42"
    )
    expect(await exists(join(result.path, "package"))).toBe(false)
  })

  it("strips a crate-style top-level archive directory", async () => {
    const home = await makeTempDirectory()
    const archive = await createTarGzip([
      {
        data: '[package]\nname = "example"',
        name: "example-1.0.0/Cargo.toml",
      },
    ])
    const result = await run(fetchTarballSnapshot(identity, tarballUrl), home, () =>
      Effect.succeed(archive)
    )

    expect(await readFile(join(result.path, "Cargo.toml"), "utf8")).toBe(
      '[package]\nname = "example"'
    )
    expect(await exists(join(result.path, "example-1.0.0"))).toBe(false)
  })

  it("strips an sdist-style top-level archive directory", async () => {
    const home = await makeTempDirectory()
    const archive = await createTarGzip([
      {
        data: '[project]\nname = "example"',
        name: "Example-1.0.0/pyproject.toml",
      },
    ])
    const result = await run(fetchTarballSnapshot(identity, tarballUrl), home, () =>
      Effect.succeed(archive)
    )

    expect(await readFile(join(result.path, "pyproject.toml"), "utf8")).toBe(
      '[project]\nname = "example"'
    )
    expect(await exists(join(result.path, "Example-1.0.0"))).toBe(false)
  })

  it("rejects archives with multiple top-level directories", async () => {
    const home = await makeTempDirectory()
    const archive = await createTarGzip([
      {
        data: "{}",
        name: "package/package.json",
      },
      {
        data: "unexpected",
        name: "other/file.txt",
      },
    ])

    const extraction = run(fetchTarballSnapshot(identity, tarballUrl), home, () =>
      Effect.succeed(archive)
    )

    expect(extraction).rejects.toMatchObject({
      cause: "Package archive must contain exactly one top-level directory",
    })
  })

  it("reuses an existing tarball store entry", async () => {
    const home = await makeTempDirectory()
    const archive = await createTarGzip([
      {
        data: "{}",
        name: "package/package.json",
      },
    ])
    let downloadCount = 0
    const download = () => {
      downloadCount += 1
      return Effect.succeed(archive)
    }

    const first = await run(fetchTarballSnapshot(identity, tarballUrl), home, download)
    const second = await run(fetchTarballSnapshot(identity, tarballUrl), home, download)

    expect(first.reused).toBe(false)
    expect(second.reused).toBe(true)
    expect(downloadCount).toBe(1)
  })

  it("fails safely and removes temporary data for invalid archives", async () => {
    const home = await makeTempDirectory()

    expect(
      run(fetchTarballSnapshot(identity, tarballUrl), home, () =>
        Effect.succeed(new Uint8Array([1, 2, 3]))
      )
    ).rejects.toBeInstanceOf(TarballFetchError)

    const packageParent = join(home, ".agents", "packref", "store", "packages", "npm", "example")
    expect(await exists(join(packageParent, "1.0.0"))).toBe(false)
    expect(await readdir(packageParent)).toEqual([])
  })

  it("retries transient tarball responses before it succeeds", async () => {
    const home = await makeTempDirectory()
    const archive = await createTarGzip([
      {
        data: "{}",
        name: "package/package.json",
      },
    ])
    let requestCount = 0

    const result = await run(
      fetchTarballSnapshot(identity, tarballUrl),
      home,
      () => Effect.succeed(archive),
      () => {
        requestCount += 1
        return requestCount < 3 ? 503 : 200
      }
    )

    expect(result.reused).toBe(false)
    expect(requestCount).toBe(3)
  })

  it("does not retry a 404 tarball response", async () => {
    const home = await makeTempDirectory()
    let requestCount = 0
    const download = run(
      fetchTarballSnapshot(identity, tarballUrl),
      home,
      () => Effect.succeed(new Uint8Array()),
      () => {
        requestCount += 1
        return 404
      }
    )

    expect(download).rejects.toBeInstanceOf(TarballFetchError)
    expect(requestCount).toBe(1)
  })

  it("rejects non-successful tarball responses after bounded retries", async () => {
    const home = await makeTempDirectory()
    let requestCount = 0

    const download = run(
      fetchTarballSnapshot(identity, tarballUrl),
      home,
      () => Effect.succeed(new Uint8Array()),
      () => {
        requestCount += 1
        return 503
      }
    )

    expect(download).rejects.toBeInstanceOf(TarballFetchError)
    expect(requestCount).toBe(3)
  })
})
