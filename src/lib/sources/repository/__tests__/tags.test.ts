import { afterEach, describe, expect, it } from "bun:test"
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import * as NodeServices from "@effect/platform-node/NodeServices"
import * as Effect from "effect/Effect"
import * as Layer from "effect/Layer"
import * as Option from "effect/Option"
import * as PlatformError from "effect/PlatformError"
import type { PackageIdentity, RepositoryPackageSpec } from "#lib/core/packages.ts"
import type { NormalizedRepositorySource } from "#lib/core/source.ts"
import {
  GitExecutableNotFoundError,
  NetworkError,
  TagNotFoundError,
  UnsupportedRepositoryHostError,
} from "#lib/core/errors.ts"
import {
  resolveDirectRepositoryRef,
  resolveRepositoryRef,
} from "#lib/sources/repository/normalize.ts"
import {
  getTagCandidates,
  matchRepositoryTag,
  parseGitRemoteRefsOutput,
  parseGitRemoteTagsOutput,
  RemoteTagReader,
} from "#lib/sources/repository/tags.ts"

const temporaryPaths: string[] = []

const runWithRemoteTagCommand = <A, E>(
  effect: Effect.Effect<A, E, RemoteTagReader>,
  runCommand: Parameters<typeof RemoteTagReader.layerWithCommand>[0]
) => Effect.runPromise(effect.pipe(Effect.provide(RemoteTagReader.layerWithCommand(runCommand))))

const runWithLiveRemoteTagReader = <A, E>(effect: Effect.Effect<A, E, RemoteTagReader>) =>
  Effect.runPromise(
    effect.pipe(Effect.provide(RemoteTagReader.layer.pipe(Layer.provide(NodeServices.layer))))
  )

const makeTempDirectory = async () => {
  const directoryPath = await mkdtemp(join(tmpdir(), "packref-tags-test-"))
  temporaryPaths.push(directoryPath)
  return directoryPath
}

const originalPath = process.env.PATH

afterEach(async () => {
  process.env.PATH = originalPath
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true }))
  )
})

const reactIdentity = {
  name: "react",
  registry: "npm",
  version: "19.0.0",
} satisfies PackageIdentity

const repositorySource = {
  fetchSource: "github:facebook/react",
  host: "github.com",
  type: "repository",
  url: "https://github.com/facebook/react",
} satisfies NormalizedRepositorySource

describe("parseGitRemoteTagsOutput", () => {
  it("parses lightweight and annotated tags without duplicates", () => {
    const tags = parseGitRemoteTagsOutput(`
8f2b1f\trefs/tags/v19.0.0
8f2b1f\trefs/tags/v19.0.0^{}
95b3cd\trefs/tags/19.0.0
`)

    expect(tags).toEqual(["v19.0.0", "19.0.0"])
  })
})

describe("parseGitRemoteRefsOutput", () => {
  it("reads HEAD, branches, lightweight tags, and peeled annotated tags", () => {
    const refs = parseGitRemoteRefsOutput(`
1111111111111111111111111111111111111111\tHEAD
2222222222222222222222222222222222222222\trefs/heads/main
3333333333333333333333333333333333333333\trefs/tags/1.0
4444444444444444444444444444444444444444\trefs/tags/release/next
5555555555555555555555555555555555555555\trefs/tags/release/next^{}
`)

    expect(refs.head).toBe("1111111111111111111111111111111111111111")
    expect(refs.heads.get("main")).toBe("2222222222222222222222222222222222222222")
    expect(refs.tags.get("1.0")).toBe("3333333333333333333333333333333333333333")
    expect(refs.tags.get("release/next")).toBe("5555555555555555555555555555555555555555")
  })
})

describe("getTagCandidates", () => {
  it("returns tag candidates in priority order", () => {
    expect(getTagCandidates(reactIdentity)).toEqual(["v19.0.0", "19.0.0", "react@19.0.0"])
  })
})

describe("matchRepositoryTag", () => {
  it("matches tags in the documented priority order", () => {
    expect(
      Option.getOrThrow(matchRepositoryTag(reactIdentity, ["19.0.0", "react@19.0.0", "v19.0.0"]))
    ).toBe("v19.0.0")
  })

  it("supports scoped package names", () => {
    const identity = {
      name: "@effect/cli",
      registry: "npm",
      version: "0.29.0",
    } satisfies PackageIdentity

    expect(Option.getOrThrow(matchRepositoryTag(identity, ["@effect/cli@0.29.0"]))).toBe(
      "@effect/cli@0.29.0"
    )
  })

  it("returns None when no tag matches", () => {
    expect(Option.isNone(matchRepositoryTag(reactIdentity, ["v18.3.1"]))).toBe(true)
  })
})

describe("RemoteTagReader", () => {
  const listRemoteTags = Effect.fn("test.listRemoteTags")(function* () {
    const remoteTagReader = yield* RemoteTagReader

    return yield* remoteTagReader.list(repositorySource)
  })

  it("lists parsed remote tags from git ls-remote output", async () => {
    const tags = await runWithRemoteTagCommand(listRemoteTags(), () =>
      Effect.succeed({
        exitCode: 0,
        stderr: "",
        stdout: "8f2b1f\trefs/tags/v19.0.0\n95b3cd\trefs/tags/19.0.0\n",
      })
    )

    expect(tags).toEqual(["v19.0.0", "19.0.0"])
  })

  it("does not retry a permanent command failure", async () => {
    let commandCount = 0
    const error = await runWithRemoteTagCommand(Effect.flip(listRemoteTags()), () =>
      Effect.sync(() => {
        commandCount += 1
      }).pipe(
        Effect.andThen(
          Effect.succeed({
            exitCode: 128,
            stderr: "fatal: repository not found",
            stdout: "",
          })
        )
      )
    )

    expect(error).toBeInstanceOf(NetworkError)
    expect(commandCount).toBe(1)
  })

  it("retries a transient command failure with a bounded policy", async () => {
    let commandCount = 0
    const error = await runWithRemoteTagCommand(Effect.flip(listRemoteTags()), () =>
      Effect.sync(() => {
        commandCount += 1
      }).pipe(
        Effect.andThen(
          Effect.succeed({
            exitCode: 128,
            stderr: "fatal: unable to access repository: Could not resolve host",
            stdout: "",
          })
        )
      )
    )

    expect(error).toBeInstanceOf(NetworkError)
    expect(commandCount).toBe(3)
  })

  it("drains large stdout and stderr from the live command concurrently", async () => {
    const binPath = await makeTempDirectory()
    const gitPath = join(binPath, "git")
    await writeFile(
      gitPath,
      `#!/bin/sh
if [ "$LC_ALL" != "C" ]; then
  printf 'expected LC_ALL=C, received %s\n' "$LC_ALL" >&2
  exit 1
fi

i=0
while [ "$i" -lt 12000 ]; do
  printf '8f2b1f\\trefs/tags/v19.0.0\\n'
  printf 'remote diagnostic output that must be drained concurrently\\n' >&2
  i=$((i + 1))
done
`
    )
    await chmod(gitPath, 0o755)
    process.env.PATH = `${binPath}:${originalPath ?? ""}`

    const tags = await runWithLiveRemoteTagReader(listRemoteTags())

    expect(tags).toEqual(["v19.0.0"])
  }, 30_000)

  it("retries spawner failures with a bounded policy", async () => {
    let commandCount = 0
    const error = await runWithRemoteTagCommand(Effect.flip(listRemoteTags()), () =>
      Effect.sync(() => {
        commandCount += 1
      }).pipe(
        Effect.andThen(
          Effect.fail(
            PlatformError.systemError({
              _tag: "PermissionDenied",
              method: "spawn",
              module: "ChildProcess",
              pathOrDescriptor: "git ls-remote --tags",
            })
          )
        )
      )
    )

    expect(error).toBeInstanceOf(NetworkError)
    expect(commandCount).toBe(3)
  })

  it("reports an actionable error without retry when the git executable is missing", async () => {
    let commandCount = 0

    const error = await runWithRemoteTagCommand(Effect.flip(listRemoteTags()), () =>
      Effect.sync(() => {
        commandCount += 1
      }).pipe(
        Effect.andThen(
          Effect.fail(
            PlatformError.systemError({
              _tag: "NotFound",
              method: "spawn",
              module: "ChildProcess",
              pathOrDescriptor: "git ls-remote --tags",
            })
          )
        )
      )
    )

    expect(error).toBeInstanceOf(GitExecutableNotFoundError)
    expect(error).toHaveProperty("message", expect.stringMatching(/Install Git.*PATH/su))
    expect(commandCount).toBe(1)
  })
})

const resolveDirect = (specifier?: string) => {
  const spec: RepositoryPackageSpec = {
    _tag: "repository",
    name: "owner/repo",
    registry: "github",
    repository: { url: "github:owner/repo" },
  }

  if (specifier !== undefined) {
    Object.assign(spec, { specifier })
  }

  return resolveDirectRepositoryRef(spec)
}

describe("resolveDirectRepositoryRef", () => {
  const output = `
1111111111111111111111111111111111111111\tHEAD
2222222222222222222222222222222222222222\trefs/heads/main
3333333333333333333333333333333333333333\trefs/tags/1.0
4444444444444444444444444444444444444444\trefs/tags/v1.0
5555555555555555555555555555555555555555\trefs/tags/release/next
6666666666666666666666666666666666666666\trefs/tags/release/next^{}
`
  const command = () => Effect.succeed({ exitCode: 0, stderr: "", stdout: output })

  it.each([
    {
      expectedRef: "1111111111111111111111111111111111111111",
      expectedVersion: "1111111111111111111111111111111111111111",
      specifier: undefined,
    },
    {
      expectedRef: "3333333333333333333333333333333333333333",
      expectedVersion: "3333333333333333333333333333333333333333",
      specifier: "1.0",
    },
    {
      expectedRef: "4444444444444444444444444444444444444444",
      expectedVersion: "4444444444444444444444444444444444444444",
      specifier: "v1.0",
    },
    {
      expectedRef: "2222222222222222222222222222222222222222",
      expectedVersion: "2222222222222222222222222222222222222222",
      specifier: "main",
    },
    {
      expectedRef: "6666666666666666666666666666666666666666",
      expectedVersion: "6666666666666666666666666666666666666666",
      specifier: "release/next",
    },
    {
      expectedRef: "abcdef1234567890abcdef1234567890abcdef12",
      expectedVersion: "abcdef1234567890abcdef1234567890abcdef12",
      specifier: "ABCDEF1234567890ABCDEF1234567890ABCDEF12",
    },
  ])("pins $specifier as $expectedVersion", async ({ expectedRef, expectedVersion, specifier }) => {
    const resolved = await runWithRemoteTagCommand(resolveDirect(specifier), command)

    expect(resolved.identity.version).toBe(expectedVersion)
    expect(resolved.repository.ref).toBe(expectedRef)
  })

  it("rejects an abbreviated commit that does not name a remote tag or branch", () => {
    expect(runWithRemoteTagCommand(resolveDirect("abcdef1"), command)).rejects.toBeInstanceOf(
      TagNotFoundError
    )
  })
})

describe("resolveRepositoryRef", () => {
  it("resolves the matching remote tag for a normalized repository source candidate", async () => {
    const resolved = await runWithRemoteTagCommand(
      resolveRepositoryRef(reactIdentity, {
        url: "git+https://github.com/facebook/react.git",
      }),
      () =>
        Effect.succeed({
          exitCode: 0,
          stderr: "",
          stdout: "8f2b1f\trefs/tags/19.0.0\n95b3cd\trefs/tags/v19.0.0\n",
        })
    )

    expect(resolved).toEqual({
      ref: "v19.0.0",
      source: repositorySource,
    })
  })

  it("fails with TagNotFoundError when no matching tag exists", () => {
    const resolution = runWithRemoteTagCommand(
      resolveRepositoryRef(reactIdentity, {
        url: "github:facebook/react",
      }),
      () =>
        Effect.succeed({
          exitCode: 0,
          stderr: "",
          stdout: "8f2b1f\trefs/tags/v18.3.1\n",
        })
    )

    expect(resolution).rejects.toBeInstanceOf(TagNotFoundError)
  })

  it("skips tag discovery for unsupported repository hosts", () => {
    let commandWasRun = false
    const resolution = runWithRemoteTagCommand(
      resolveRepositoryRef(reactIdentity, {
        url: "https://code.example.com/acme/react.git",
      }),
      () => {
        commandWasRun = true

        return Effect.succeed({
          exitCode: 0,
          stderr: "",
          stdout: "",
        })
      }
    )

    expect(resolution).rejects.toBeInstanceOf(UnsupportedRepositoryHostError)
    expect(commandWasRun).toBe(false)
  })
})
