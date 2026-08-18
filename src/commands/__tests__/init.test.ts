import { afterEach, describe, expect, it } from "bun:test"
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises"
import { tmpdir } from "node:os"
import { join, resolve } from "node:path"
import { execPath } from "node:process"
import { parse } from "jsonc-parser"
import type { Lockfile } from "#lib/workspace/lockfile.ts"

const temporaryPaths: string[] = []
const cliPath = resolve(import.meta.dir, "../../index.ts")
const packrefAgentsStartMarker = "<!-- PACKREF:START -->"
const packrefAgentsEndMarker = "<!-- PACKREF:END -->"

const makeTempDirectory = async () => {
  const path = await mkdtemp(join(tmpdir(), "packref-test-"))
  temporaryPaths.push(path)
  return path
}

// SAFETY: Each caller supplies the expected shape for test data that the test itself creates.
const readJson = async <A>(path: string) => JSON.parse(await readFile(path, "utf8")) as A

// SAFETY: Each caller supplies the expected shape for test data that the test itself creates.
const readJsonc = async <A>(path: string) => parse(await readFile(path, "utf8")) as A

const readText = (path: string) => readFile(path, "utf8")

const exists = (path: string) =>
  access(path)
    .then(() => true)
    .catch(() => false)

const countOccurrences = (source: string, target: string) => source.split(target).length - 1

interface InitPromptInputs {
  readonly agents?: string
  readonly args?: readonly string[]
  readonly ignore?: string
}

const runInitCommand = async (
  projectPath: string,
  homePath: string,
  inputs: InitPromptInputs = {}
) => {
  let stdout = ""
  const stderr = ""
  let answeredIgnorePrompt = false
  let answeredAgentsPrompt = false
  const ignoreInput = inputs.ignore ?? "\r"
  const agentsInput = inputs.agents ?? "\r"
  const process = Bun.spawn({
    cmd: [execPath, cliPath, "init", ...(inputs.args ?? [])],
    cwd: projectPath,
    env: {
      ...Bun.env,
      HOME: homePath,
    },
    terminal: {
      cols: 80,
      data: (_terminal, data) => {
        const text = Buffer.from(data).toString("utf8")
        stdout += text

        if (!answeredIgnorePrompt && stdout.includes("Ignore generated Packref references")) {
          answeredIgnorePrompt = true
          process.terminal?.write(ignoreInput)
        }

        if (!answeredAgentsPrompt && stdout.includes("AGENTS.md")) {
          answeredAgentsPrompt = true
          process.terminal?.write(agentsInput)
        }
      },
      rows: 24,
    },
  })

  const exitCode = await process.exited

  return {
    exitCode,
    stderr,
    stdout,
  }
}

afterEach(async () => {
  await Promise.all(
    temporaryPaths.splice(0).map((path) => rm(path, { force: true, recursive: true }))
  )
})

describe("init", () => {
  describe("non-interactive setup", () => {
    it("initializes without optional integrations when setup flags are omitted", async () => {
      const projectPath = await makeTempDirectory()
      const homePath = await makeTempDirectory()

      const result = await runInitCommand(projectPath, homePath, {
        args: ["--non-interactive"],
      })

      expect(result.exitCode).toBe(0)
      expect(result.stdout).not.toContain("Ignore generated Packref references")
      expect(await exists(join(projectPath, ".packref", "packref-lock.json"))).toBe(true)
      expect(await exists(join(projectPath, ".gitignore"))).toBe(false)
      expect(await exists(join(projectPath, "AGENTS.md"))).toBe(false)
    })

    it("applies every requested integration without prompts", async () => {
      const projectPath = await makeTempDirectory()
      const homePath = await makeTempDirectory()

      await writeFile(join(projectPath, "tsconfig.json"), "{}\n")

      const result = await runInitCommand(projectPath, homePath, {
        args: ["--non-interactive", "--ignore", "--agents"],
      })

      expect(result.exitCode).toBe(0)
      expect(result.stdout).not.toContain("Ignore generated Packref references")
      expect(await readText(join(projectPath, ".gitignore"))).toContain(".packref/packages/")
      expect(await readText(join(projectPath, "AGENTS.md"))).toContain(packrefAgentsStartMarker)
      expect(await readJson<{ exclude: string[] }>(join(projectPath, "tsconfig.json"))).toEqual({
        exclude: [".packref"],
      })
    })

    it("fails when a requested tsconfig integration cannot be completed", async () => {
      const projectPath = await makeTempDirectory()
      const homePath = await makeTempDirectory()

      await writeFile(join(projectPath, "tsconfig.json"), "{")

      const result = await runInitCommand(projectPath, homePath, {
        args: ["--non-interactive", "--ignore"],
      })

      expect(result.exitCode).toBe(1)
      expect(result.stdout).toContain("Could not update tsconfig.json because it is malformed")
      expect(await readText(join(projectPath, "tsconfig.json"))).toBe("{")
    })

    it("fails when a requested agents integration cannot be completed", async () => {
      const projectPath = await makeTempDirectory()
      const homePath = await makeTempDirectory()
      const existingAgents = "# Existing Instructions\n\n<!-- PACKREF:START -->\nmanual content\n"

      await writeFile(join(projectPath, "AGENTS.md"), existingAgents)

      const result = await runInitCommand(projectPath, homePath, {
        args: ["--non-interactive", "--agents"],
      })

      expect(result.exitCode).toBe(1)
      expect(result.stdout).toContain(
        "Could not update AGENTS.md because Packref markers are incomplete"
      )
      expect(await readText(join(projectPath, "AGENTS.md"))).toBe(existingAgents)
    })

    it("rejects setup flags without non-interactive mode", async () => {
      const projectPath = await makeTempDirectory()
      const homePath = await makeTempDirectory()

      const result = await runInitCommand(projectPath, homePath, { args: ["--agents"] })

      expect(result.exitCode).toBe(1)
      expect(result.stdout).toContain("Setup flags require --non-interactive")
      expect(await exists(join(projectPath, ".packref"))).toBe(false)
    })
  })

  describe("project registration", () => {
    it("creates a project lockfile and registers the project", async () => {
      const projectPath = await makeTempDirectory()
      const homePath = await makeTempDirectory()
      const canonicalProjectPath = await realpath(projectPath)

      const result = await runInitCommand(projectPath, homePath)

      const lockfile = await readJson(join(projectPath, ".packref", "packref-lock.json"))
      const config = await readJson(join(homePath, ".agents", "packref", "config.json"))

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain(`Initialized packref in ${canonicalProjectPath}`)
      expect(lockfile).toEqual({
        packages: [],
      })
      expect(config).toEqual({
        projects: [canonicalProjectPath],
      })
      expect(await readText(join(projectPath, ".gitignore"))).toBe(
        ".packref/packages/\n.packref/.packref-lock-*.tmp\n"
      )
    })

    it("does not duplicate project registrations", async () => {
      const projectPath = await makeTempDirectory()
      const homePath = await makeTempDirectory()
      const canonicalProjectPath = await realpath(projectPath)

      const firstResult = await runInitCommand(projectPath, homePath)
      const secondResult = await runInitCommand(projectPath, homePath)

      const config = await readJson(join(homePath, ".agents", "packref", "config.json"))

      expect(firstResult.exitCode).toBe(0)
      expect(secondResult.exitCode).toBe(0)
      expect(config).toEqual({
        projects: [canonicalProjectPath],
      })
      expect(await readText(join(projectPath, ".gitignore"))).toBe(
        ".packref/packages/\n.packref/.packref-lock-*.tmp\n"
      )
    })

    it("does not duplicate project registrations through symlinked paths", async () => {
      const projectPath = await makeTempDirectory()
      const homePath = await makeTempDirectory()
      const symlinkParentPath = await makeTempDirectory()
      const symlinkProjectPath = join(symlinkParentPath, "project-link")
      const canonicalProjectPath = await realpath(projectPath)

      await symlink(projectPath, symlinkProjectPath, "dir")

      const firstResult = await runInitCommand(projectPath, homePath)
      const secondResult = await runInitCommand(symlinkProjectPath, homePath)

      const config = await readJson(join(homePath, ".agents", "packref", "config.json"))

      expect(firstResult.exitCode).toBe(0)
      expect(secondResult.exitCode).toBe(0)
      expect(secondResult.stdout).toContain(`Initialized packref in ${canonicalProjectPath}`)
      expect(config).toEqual({
        projects: [canonicalProjectPath],
      })
    })
  })

  describe("gitignore", () => {
    it("appends packref to an existing gitignore without merging lines", async () => {
      const projectPath = await makeTempDirectory()
      const homePath = await makeTempDirectory()

      await writeFile(join(projectPath, ".gitignore"), "dist")

      const result = await runInitCommand(projectPath, homePath)

      expect(result.exitCode).toBe(0)
      expect(await readText(join(projectPath, ".gitignore"))).toBe(
        "dist\n.packref/packages/\n.packref/.packref-lock-*.tmp"
      )
    })

    it("migrates an exact legacy gitignore folder entry", async () => {
      const projectPath = await makeTempDirectory()
      const homePath = await makeTempDirectory()

      await writeFile(join(projectPath, ".gitignore"), "dist\n.packref/\n")

      const result = await runInitCommand(projectPath, homePath)

      expect(result.exitCode).toBe(0)
      expect(await readText(join(projectPath, ".gitignore"))).toBe(
        "dist\n.packref/packages/\n.packref/.packref-lock-*.tmp\n"
      )
    })

    it("migrates a legacy gitignore entry with trailing whitespace", async () => {
      const projectPath = await makeTempDirectory()
      const homePath = await makeTempDirectory()

      await writeFile(join(projectPath, ".gitignore"), "dist\n.packref \n")

      const result = await runInitCommand(projectPath, homePath)

      expect(result.exitCode).toBe(0)
      expect(await readText(join(projectPath, ".gitignore"))).toBe(
        "dist\n.packref/packages/\n.packref/.packref-lock-*.tmp\n"
      )
    })

    it("does not duplicate existing narrow gitignore entries", async () => {
      const projectPath = await makeTempDirectory()
      const homePath = await makeTempDirectory()
      const existing = "dist\n.packref/packages/\n.packref/.packref-lock-*.tmp\n"

      await writeFile(join(projectPath, ".gitignore"), existing)

      const result = await runInitCommand(projectPath, homePath)

      expect(result.exitCode).toBe(0)
      expect(await readText(join(projectPath, ".gitignore"))).toBe(existing)
    })

    it("preserves CRLF, comments, unrelated rules, and a missing final newline", async () => {
      const projectPath = await makeTempDirectory()
      const homePath = await makeTempDirectory()
      const existing = "# generated\r\ndist\r\n.packref\r\n.env"

      await writeFile(join(projectPath, ".gitignore"), existing)

      const result = await runInitCommand(projectPath, homePath)

      expect(result.exitCode).toBe(0)
      expect(await readText(join(projectPath, ".gitignore"))).toBe(
        "# generated\r\ndist\r\n.packref/packages/\r\n.packref/.packref-lock-*.tmp\r\n.env"
      )
    })

    it("leaves ignore files unchanged when declined", async () => {
      const projectPath = await makeTempDirectory()
      const homePath = await makeTempDirectory()
      const canonicalProjectPath = await realpath(projectPath)
      const existingGitignore = "dist\n"
      const existingTsconfig = `${JSON.stringify({ exclude: ["node_modules"] }, null, 2)}\n`

      await writeFile(join(projectPath, ".gitignore"), existingGitignore)
      await writeFile(join(projectPath, "tsconfig.json"), existingTsconfig)

      const result = await runInitCommand(projectPath, homePath, { ignore: "\n\r" })

      const lockfile = await readJson(join(projectPath, ".packref", "packref-lock.json"))
      const config = await readJson(join(homePath, ".agents", "packref", "config.json"))
      const agents = await readText(join(projectPath, "AGENTS.md"))

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain(`Initialized packref in ${canonicalProjectPath}`)
      expect(lockfile).toEqual({ packages: [] })
      expect(config).toEqual({ projects: [canonicalProjectPath] })
      expect(await readText(join(projectPath, ".gitignore"))).toBe(existingGitignore)
      expect(await readText(join(projectPath, "tsconfig.json"))).toBe(existingTsconfig)
      expect(agents).toContain(packrefAgentsStartMarker)
    })

    it("does not create gitignore when ignore files are declined", async () => {
      const projectPath = await makeTempDirectory()
      const homePath = await makeTempDirectory()

      const result = await runInitCommand(projectPath, homePath, { ignore: "\n\r" })

      expect(result.exitCode).toBe(0)
      expect(await exists(join(projectPath, ".gitignore"))).toBe(false)
    })

    it("gracefully handles ignore files prompt cancellation", async () => {
      const projectPath = await makeTempDirectory()
      const homePath = await makeTempDirectory()

      const result = await runInitCommand(projectPath, homePath, { ignore: "\u0003" })

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("You've cancelled the initialization process.")
      expect(result.stdout).not.toContain("Operation cancelled")
      expect(result.stdout).not.toContain("Ensuring project directory exists")
      expect(result.stdout).not.toContain("You're ready to start using Packref")
      expect(await exists(join(projectPath, ".packref", "packref-lock.json"))).toBe(false)
      expect(await exists(join(projectPath, "AGENTS.md"))).toBe(false)
    })
  })

  describe("tsconfig", () => {
    it("adds a tsconfig exclude list when tsconfig has none", async () => {
      const projectPath = await makeTempDirectory()
      const homePath = await makeTempDirectory()

      await writeFile(
        join(projectPath, "tsconfig.json"),
        `${JSON.stringify(
          {
            compilerOptions: {
              noEmit: true,
            },
            include: ["src"],
          },
          null,
          2
        )}\n`
      )

      const result = await runInitCommand(projectPath, homePath)
      const tsconfig = await readJson<{
        compilerOptions: { noEmit: boolean }
        exclude: string[]
        include: string[]
      }>(join(projectPath, "tsconfig.json"))

      expect(result.exitCode).toBe(0)
      expect(tsconfig).toEqual({
        compilerOptions: {
          noEmit: true,
        },
        exclude: [".packref"],
        include: ["src"],
      })
    })

    it("adds packref to an existing tsconfig exclude list", async () => {
      const projectPath = await makeTempDirectory()
      const homePath = await makeTempDirectory()

      await writeFile(
        join(projectPath, "tsconfig.json"),
        `${JSON.stringify(
          {
            compilerOptions: {
              noEmit: true,
            },
            exclude: ["node_modules"],
          },
          null,
          2
        )}\n`
      )

      const result = await runInitCommand(projectPath, homePath)
      const tsconfig = await readJson<{ exclude: string[] }>(join(projectPath, "tsconfig.json"))

      expect(result.exitCode).toBe(0)
      expect(tsconfig.exclude).toEqual(["node_modules", ".packref"])
    })

    it("adds packref to a JSONC tsconfig with comments and trailing commas", async () => {
      const projectPath = await makeTempDirectory()
      const homePath = await makeTempDirectory()

      await writeFile(
        join(projectPath, "tsconfig.json"),
        `{
  // TypeScript accepts comments in tsconfig.json.
  "compilerOptions": {
    "noEmit": true,
  },
  "exclude": [
    "node_modules",
  ],
}
`
      )

      const result = await runInitCommand(projectPath, homePath)
      const tsconfig = await readJsonc<{
        compilerOptions: { noEmit: boolean }
        exclude: string[]
      }>(join(projectPath, "tsconfig.json"))
      const content = await readText(join(projectPath, "tsconfig.json"))

      expect(result.exitCode).toBe(0)
      expect(result.stdout).not.toContain("Could not update tsconfig.json because it is malformed")
      expect(tsconfig.compilerOptions.noEmit).toBe(true)
      expect(tsconfig.exclude).toEqual(["node_modules", ".packref"])
      expect(content).toContain("// TypeScript accepts comments in tsconfig.json.")
    })

    it("does not duplicate existing tsconfig exclude entries", async () => {
      const projectPath = await makeTempDirectory()
      const homePath = await makeTempDirectory()

      await writeFile(
        join(projectPath, "tsconfig.json"),
        `${JSON.stringify(
          {
            exclude: ["node_modules", ".packref"],
          },
          null,
          2
        )}\n`
      )

      const firstResult = await runInitCommand(projectPath, homePath)
      const secondResult = await runInitCommand(projectPath, homePath)
      const tsconfig = await readJson<{ exclude: string[] }>(join(projectPath, "tsconfig.json"))

      expect(firstResult.exitCode).toBe(0)
      expect(secondResult.exitCode).toBe(0)
      expect(tsconfig.exclude).toEqual(["node_modules", ".packref"])
    })

    it("does not duplicate existing tsconfig folder exclude entries", async () => {
      const projectPath = await makeTempDirectory()
      const homePath = await makeTempDirectory()

      await writeFile(
        join(projectPath, "tsconfig.json"),
        `${JSON.stringify(
          {
            exclude: ["node_modules", ".packref/"],
          },
          null,
          2
        )}\n`
      )

      const result = await runInitCommand(projectPath, homePath)
      const tsconfig = await readJson<{ exclude: string[] }>(join(projectPath, "tsconfig.json"))

      expect(result.exitCode).toBe(0)
      expect(tsconfig.exclude).toEqual(["node_modules", ".packref/"])
    })

    it("skips missing tsconfig files", async () => {
      const projectPath = await makeTempDirectory()
      const homePath = await makeTempDirectory()

      const result = await runInitCommand(projectPath, homePath)

      expect(result.exitCode).toBe(0)
      expect(await exists(join(projectPath, "tsconfig.json"))).toBe(false)
    })

    it("warns and succeeds for malformed tsconfig files", async () => {
      const projectPath = await makeTempDirectory()
      const homePath = await makeTempDirectory()

      await writeFile(join(projectPath, "tsconfig.json"), "{")

      const result = await runInitCommand(projectPath, homePath)

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("Could not update tsconfig.json because it is malformed")
      expect(await readText(join(projectPath, "tsconfig.json"))).toBe("{")
    })
  })

  describe("agents", () => {
    it("adds packref guidance to AGENTS.md when confirmed", async () => {
      const projectPath = await makeTempDirectory()
      const homePath = await makeTempDirectory()

      const result = await runInitCommand(projectPath, homePath)
      const agents = await readText(join(projectPath, "AGENTS.md"))

      expect(result.exitCode).toBe(0)
      expect(agents).toContain(packrefAgentsStartMarker)
      expect(agents).toContain("## Packref")
      expect(agents).toContain(
        ".packref/packages/<registry>/<package>/<version>/` for unscoped packages"
      )
      expect(agents).toContain(
        ".packref/packages/<registry>/<scope>/<package>/<version>/` for scoped packages"
      )
      expect(agents).toContain("packref add [package]")
      expect(agents).toContain("packref remove [package]")
      expect(agents).toContain(".packref/packref-lock.json` is shared and should be committed")
      expect(agents).toContain("packref install")
      expect(agents).toContain("install restores locked references exactly")
      expect(agents).toContain(packrefAgentsEndMarker)
      expect(agents.endsWith("\n")).toBe(true)
    })

    it("appends packref guidance to an existing AGENTS.md without markers", async () => {
      const projectPath = await makeTempDirectory()
      const homePath = await makeTempDirectory()
      const existingAgents = "# Existing Instructions\n\nKeep project guidance here.\n"

      await writeFile(join(projectPath, "AGENTS.md"), existingAgents)

      const result = await runInitCommand(projectPath, homePath)
      const agents = await readText(join(projectPath, "AGENTS.md"))

      expect(result.exitCode).toBe(0)
      expect(agents.startsWith(`${existingAgents}\n${packrefAgentsStartMarker}\n`)).toBe(true)
      expect(agents).toContain("## Packref")
      expect(agents).toContain(packrefAgentsEndMarker)
    })

    it("replaces existing packref guidance without duplicating markers", async () => {
      const projectPath = await makeTempDirectory()
      const homePath = await makeTempDirectory()

      await writeFile(
        join(projectPath, "AGENTS.md"),
        "# Existing Instructions\n\n<!-- PACKREF:START -->\nold content\n<!-- PACKREF:END -->\n"
      )

      const result = await runInitCommand(projectPath, homePath)
      const agents = await readText(join(projectPath, "AGENTS.md"))

      expect(result.exitCode).toBe(0)
      expect(agents).toContain("# Existing Instructions")
      expect(agents).toContain("## Packref")
      expect(agents).toContain("packref sync")
      expect(agents).not.toContain("old content")
      expect(countOccurrences(agents, packrefAgentsStartMarker)).toBe(1)
      expect(countOccurrences(agents, packrefAgentsEndMarker)).toBe(1)
    })

    it("leaves AGENTS.md unchanged when packref start marker is missing its end marker", async () => {
      const projectPath = await makeTempDirectory()
      const homePath = await makeTempDirectory()
      const existingAgents = "# Existing Instructions\n\n<!-- PACKREF:START -->\nmanual content\n"

      await writeFile(join(projectPath, "AGENTS.md"), existingAgents)

      const result = await runInitCommand(projectPath, homePath)

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain(
        "Could not update AGENTS.md because Packref markers are incomplete"
      )
      expect(await readText(join(projectPath, "AGENTS.md"))).toBe(existingAgents)
    })

    it("leaves AGENTS.md unchanged when packref end marker is missing its start marker", async () => {
      const projectPath = await makeTempDirectory()
      const homePath = await makeTempDirectory()
      const existingAgents = "# Existing Instructions\n\nmanual content\n<!-- PACKREF:END -->\n"

      await writeFile(join(projectPath, "AGENTS.md"), existingAgents)

      const result = await runInitCommand(projectPath, homePath)

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain(
        "Could not update AGENTS.md because Packref markers are incomplete"
      )
      expect(await readText(join(projectPath, "AGENTS.md"))).toBe(existingAgents)
    })

    it("leaves AGENTS.md unchanged when guidance is declined", async () => {
      const projectPath = await makeTempDirectory()
      const homePath = await makeTempDirectory()
      const existingAgents = "# Existing Instructions\n"

      await writeFile(join(projectPath, "AGENTS.md"), existingAgents)

      const result = await runInitCommand(projectPath, homePath, { agents: "\n\r" })

      expect(result.exitCode).toBe(0)
      expect(await readText(join(projectPath, "AGENTS.md"))).toBe(existingAgents)
    })

    it("gracefully handles AGENTS.md prompt cancellation", async () => {
      const projectPath = await makeTempDirectory()
      const homePath = await makeTempDirectory()

      const result = await runInitCommand(projectPath, homePath, { agents: "\u0003" })

      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("You've cancelled the initialization process.")
      expect(result.stdout).not.toContain("Operation cancelled")
      expect(result.stdout).not.toContain("You're ready to start using Packref")
      expect(await exists(join(projectPath, "AGENTS.md"))).toBe(false)
    })
  })

  describe("lockfile", () => {
    it("preserves existing lockfile package entries", async () => {
      const projectPath = await makeTempDirectory()
      const existingLockfile = {
        packages: [
          {
            name: "react",
            registry: "npm",
            source: {
              host: "github",
              type: "repository",
              url: "https://github.com/facebook/react",
            },
            tracking: "manual",
            version: "19.0.0",
          },
        ],
      } satisfies Lockfile

      await mkdir(join(projectPath, ".packref"), { recursive: true })
      await writeFile(
        join(projectPath, ".packref", "packref-lock.json"),
        `${JSON.stringify(existingLockfile, null, 2)}\n`
      )

      const homePath = await makeTempDirectory()
      const result = await runInitCommand(projectPath, homePath)

      const lockfile = await readJson(join(projectPath, ".packref", "packref-lock.json"))

      expect(result.exitCode).toBe(0)
      expect(lockfile).toEqual(existingLockfile)
      expect(result.stdout).toContain("Run `packref install` to materialize missing source trees")
    })

    it("fails for malformed lockfiles", async () => {
      const projectPath = await makeTempDirectory()
      const homePath = await makeTempDirectory()

      await mkdir(join(projectPath, ".packref"), { recursive: true })
      await writeFile(join(projectPath, ".packref", "packref-lock.json"), "{")

      const result = await runInitCommand(projectPath, homePath)

      expect(result.exitCode).toBe(1)
      expect(result.stdout).toContain("Failed to parse Packref lockfile")
      expect(result.stdout).toContain("Failed to create the packref-lock.json")
    })
  })

  describe("global config", () => {
    it("fails for malformed global config", async () => {
      const projectPath = await makeTempDirectory()
      const homePath = await makeTempDirectory()
      const globalPath = join(homePath, ".agents", "packref")

      await mkdir(globalPath, { recursive: true })
      await writeFile(join(globalPath, "config.json"), "{")

      const result = await runInitCommand(projectPath, homePath)

      expect(result.exitCode).toBe(1)
      expect(result.stdout).toContain("Failed to parse Packref config")
      expect(result.stdout).toContain("Failed to register project in global store")
    })
  })
})
