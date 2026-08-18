import * as Effect from "effect/Effect"
import * as Equivalence from "effect/Equivalence"
import * as Order from "effect/Order"
import * as Path from "effect/Path"
import {
  InvalidPackageIdentity,
  UnsupportedRegistryError,
  UnsupportedRepositoryHostError,
} from "#lib/core/errors.ts"
import { DEFAULT_REGISTRY, checkIsRegistry, type Registry } from "#lib/core/registry.ts"

export interface PackageCoordinates {
  readonly name: string
  readonly registry: string
}

export interface PackageIdentity extends PackageCoordinates {
  readonly version: string
}

export const packageCoordinatesEquivalence = Equivalence.Struct({
  name: Equivalence.String,
  registry: Equivalence.String,
})

export const packageCoordinatesOrder = Order.combineAll([
  Order.mapInput(Order.String, (coordinates: PackageCoordinates) => coordinates.registry),
  Order.mapInput(Order.String, (coordinates: PackageCoordinates) => coordinates.name),
])

export const packageIdentityEquivalence = Equivalence.combine(
  packageCoordinatesEquivalence,
  Equivalence.mapInput(Equivalence.String, (identity: PackageIdentity) => identity.version)
)

export const packageIdentityOrder = Order.combine(
  packageCoordinatesOrder,
  Order.mapInput(Order.String, (identity: PackageIdentity) => identity.version)
)

export const formatPackageIdentity = (identity: PackageIdentity) =>
  `${identity.registry}:${identity.name}@${identity.version}`

export interface RegistryPackageSpec {
  readonly _tag: "registry"
  readonly name: string
  readonly registry: Registry
  readonly specifier?: string
}

export const SUPPORTED_REPOSITORY_PROVIDERS = [
  "bitbucket",
  "github",
  "gitlab",
  "sourcehut",
] as const
export type RepositoryProvider = (typeof SUPPORTED_REPOSITORY_PROVIDERS)[number]

export interface RepositoryPackageSpec {
  readonly _tag: "repository"
  readonly name: string
  readonly registry: RepositoryProvider
  readonly repository: {
    readonly directory?: string
    readonly url: string
  }
  readonly specifier?: string
}

export type ParsedPackageSpec = RegistryPackageSpec | RepositoryPackageSpec

interface RegistryPackageSpecBuilder {
  _tag: "registry"
  name: string
  registry: Registry
  specifier?: string
}

interface RepositoryBuilder {
  directory?: string
  url: string
}

interface RepositoryPackageSpecBuilder {
  _tag: "repository"
  name: string
  registry: RepositoryProvider
  repository: RepositoryBuilder
  specifier?: string
}

export const PACKAGE_DIRECTORY_NAME = "packages"

type PackageIdentityField = "name" | "registry" | "version"

const validatePathSegment = Effect.fn("validatePathSegment")(function* (
  field: PackageIdentityField,
  value: string
): Effect.fn.Return<void, InvalidPackageIdentity> {
  if (value.length === 0) {
    return yield* new InvalidPackageIdentity({
      field,
      reason: "must not be empty",
      value,
    })
  }

  if (value === "." || value === "..") {
    return yield* new InvalidPackageIdentity({
      field,
      reason: "must not be a reserved path segment",
      value,
    })
  }

  if (value.includes("/") || value.includes("\\")) {
    return yield* new InvalidPackageIdentity({
      field,
      reason: "must not contain path separators",
      value,
    })
  }
})

export const REPOSITORY_PROVIDER_HOSTS = {
  bitbucket: "bitbucket.org",
  github: "github.com",
  gitlab: "gitlab.com",
  sourcehut: "git.sr.ht",
} satisfies Record<RepositoryProvider, string>

const HOST_REPOSITORY_PROVIDERS = new Map<string, RepositoryProvider>(
  SUPPORTED_REPOSITORY_PROVIDERS.map((provider) => [REPOSITORY_PROVIDER_HOSTS[provider], provider])
)

const checkIsRepositoryProvider = (value: string): value is RepositoryProvider =>
  SUPPORTED_REPOSITORY_PROVIDERS.some((provider) => provider === value)

const splitRepositoryRef = (value: string) => {
  const schemeIndex = value.indexOf("://")
  const scpPathIndex = schemeIndex === -1 ? value.indexOf(":") : -1
  const refSearchStart =
    schemeIndex === -1
      ? scpPathIndex === -1
        ? 0
        : scpPathIndex + 1
      : value.indexOf("/", schemeIndex + 3)
  const separatorIndex = value.indexOf("@", Math.max(0, refSearchStart))

  return separatorIndex === -1
    ? { locator: value }
    : { locator: value.slice(0, separatorIndex), specifier: value.slice(separatorIndex + 1) }
}

interface RepositoryIdentity {
  readonly directory: string
  readonly host: string
  readonly name: string
  readonly provider: RepositoryProvider | undefined
  readonly url: string
}

interface RepositoryLocatorPath {
  readonly directory: string
  readonly owner: string
  readonly repository: string
  readonly rootPath: string
}

const splitLocatorPath = (rawPath: string): RepositoryLocatorPath => {
  const segments = rawPath.replaceAll(/^\/+|\/+$/gu, "").split("/")

  return {
    directory: segments.slice(2).join("/"),
    owner: segments[0] ?? "",
    repository: segments[1] ?? "",
    rootPath: segments.slice(0, 2).join("/"),
  }
}

const formatRepositoryName = (path: RepositoryLocatorPath) =>
  `${path.owner.replace(/^~/u, "")}/${path.repository.replace(/\.git$/u, "")}`

const identityFromShorthand = (
  provider: RepositoryProvider,
  rawPath: string
): RepositoryIdentity => {
  const path = splitLocatorPath(rawPath)

  return {
    directory: path.directory,
    host: REPOSITORY_PROVIDER_HOSTS[provider],
    name: formatRepositoryName(path),
    provider,
    url: `${provider}:${path.owner}/${path.repository.replace(/\.git$/u, "")}`,
  }
}

const identityFromStandardUrl = (locator: string) =>
  Effect.try({
    catch: () =>
      new InvalidPackageIdentity({
        field: "name",
        reason: "must be a valid repository locator",
        value: locator,
      }),
    try: () => new URL(locator.replace(/^git\+/u, "")),
  }).pipe(
    Effect.map((parsedUrl): RepositoryIdentity => {
      const path = splitLocatorPath(parsedUrl.pathname)
      const host = parsedUrl.host.toLowerCase()
      const rootUrl = new URL(parsedUrl)
      rootUrl.pathname = `/${path.rootPath}`

      return {
        directory: path.directory,
        host,
        name: formatRepositoryName(path),
        provider: HOST_REPOSITORY_PROVIDERS.get(host),
        url: path.directory.length === 0 ? locator : rootUrl.toString().replace(/\/$/u, ""),
      }
    })
  )

const identityFromScpUrl = (
  locator: string,
  rawHost: string,
  rawPath: string
): RepositoryIdentity => {
  const path = splitLocatorPath(rawPath)
  const host = rawHost.toLowerCase()

  return {
    directory: path.directory,
    host,
    name: formatRepositoryName(path),
    provider: HOST_REPOSITORY_PROVIDERS.get(host),
    url:
      path.directory.length === 0
        ? locator
        : `${locator.slice(0, locator.indexOf(":") + 1)}${path.rootPath}`,
  }
}

const identityFromKnownHostPath = (host: string, rawPath: string): RepositoryIdentity => {
  const path = splitLocatorPath(rawPath)

  return {
    directory: path.directory,
    host,
    name: formatRepositoryName(path),
    provider: HOST_REPOSITORY_PROVIDERS.get(host),
    url: `https://${host}/${path.rootPath}`,
  }
}

const identityFromBarePath = (locator: string): RepositoryIdentity => {
  const firstSegment = locator.split("/")[0]?.toLowerCase() ?? ""
  const host = firstSegment.includes(".")
    ? firstSegment
    : locator.startsWith("~")
      ? "git.sr.ht"
      : "github.com"
  const provider = HOST_REPOSITORY_PROVIDERS.get(host)
  const path = splitLocatorPath(locator)

  return {
    directory: path.directory,
    host,
    name: formatRepositoryName(path),
    provider,
    url:
      locator.startsWith("~") && provider === "sourcehut"
        ? `sourcehut:~${formatRepositoryName(path)}`
        : path.directory.length === 0
          ? locator
          : formatRepositoryName(path),
  }
}

const parseRepositoryIdentity = Effect.fn("parseRepositoryIdentity")((locator: string) => {
  const providerSeparator = locator.indexOf(":")
  const shorthandProvider =
    providerSeparator === -1 ? undefined : locator.slice(0, providerSeparator)

  if (shorthandProvider !== undefined && checkIsRepositoryProvider(shorthandProvider)) {
    return Effect.succeed(
      identityFromShorthand(shorthandProvider, locator.slice(providerSeparator + 1))
    )
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(locator)) {
    return identityFromStandardUrl(locator)
  }

  const scpMatch = /^(?:[^@]+@)?(?<host>[^:]+):(?<repositoryPath>.+)$/u.exec(locator)

  if (scpMatch?.groups?.host !== undefined && scpMatch.groups.repositoryPath !== undefined) {
    return Effect.succeed(
      identityFromScpUrl(locator, scpMatch.groups.host, scpMatch.groups.repositoryPath)
    )
  }

  const pathHost = locator.split("/")[0]?.toLowerCase() ?? ""

  if (HOST_REPOSITORY_PROVIDERS.has(pathHost)) {
    return Effect.succeed(
      identityFromKnownHostPath(pathHost, locator.split("/").slice(1).join("/"))
    )
  }

  return Effect.succeed(identityFromBarePath(locator))
})

const checkIsRepositorySpec = (value: string) => {
  const prefixSeparatorIndex = value.indexOf(":")
  const prefix = prefixSeparatorIndex === -1 ? undefined : value.slice(0, prefixSeparatorIndex)
  const prefixWithoutUser = prefix?.slice(prefix.lastIndexOf("@") + 1)

  if (prefixWithoutUser !== undefined && checkIsRegistry(prefixWithoutUser)) {
    return false
  }

  return (
    (prefix !== undefined && checkIsRepositoryProvider(prefix)) ||
    /^[^@/:\s]+\/[^@/:\s]+(?:\/[^@\s]+)?(?:@[^@]*)?$/u.test(value) ||
    /^[a-z][a-z0-9+.-]*:\/\//iu.test(value) ||
    /^(?:[^@]+@)?[^:]+:.+$/u.test(value)
  )
}

const checkHasRegistryPrefix = (value: string) => {
  const prefixSeparatorIndex = value.indexOf(":")

  if (prefixSeparatorIndex === -1) {
    return false
  }

  const firstPathSeparatorIndex = value.indexOf("/")

  return firstPathSeparatorIndex === -1 || prefixSeparatorIndex < firstPathSeparatorIndex
}

export const getPackageIdentitySegments = Effect.fn("getPackageIdentitySegments")(function* ({
  registry,
  name,
  version,
}: PackageIdentity) {
  yield* validatePathSegment("registry", registry)
  yield* validatePathSegment("version", version)

  if (name.startsWith("@") || name.includes("/")) {
    const nameSegments = name.split("/")

    if (nameSegments.length !== 2) {
      return yield* new InvalidPackageIdentity({
        field: "name",
        reason: name.startsWith("@")
          ? "scoped package names must contain exactly one scope separator"
          : "repository names must contain exactly one owner separator",
        value: name,
      })
    }

    const [scope = "", packageName = ""] = nameSegments

    if (scope === "@") {
      return yield* new InvalidPackageIdentity({
        field: "name",
        reason: "scoped package names must include a non-empty scope",
        value: name,
      })
    }

    yield* validatePathSegment("name", scope)
    yield* validatePathSegment("name", packageName)

    return [PACKAGE_DIRECTORY_NAME, registry, scope, packageName, version]
  }

  yield* validatePathSegment("name", name)

  return [PACKAGE_DIRECTORY_NAME, registry, name, version]
})

export const getPackageIdentityPath = Effect.fn("getPackageIdentityPath")(function* (
  identity: PackageIdentity
) {
  const path = yield* Path.Path
  const segments = yield* getPackageIdentitySegments(identity)

  return path.join(...segments)
})

export const parsePackageSpec = Effect.fn("parsePackageSpec")(function* (input: string) {
  const rawSpec = input.trim()

  if (checkIsRepositorySpec(rawSpec)) {
    const { locator, specifier } = splitRepositoryRef(rawSpec)
    const identity = yield* parseRepositoryIdentity(locator)

    if (
      identity.provider !== undefined &&
      !identity.name.startsWith("/") &&
      !identity.name.endsWith("/")
    ) {
      const repository: RepositoryBuilder = { url: identity.url }

      if (identity.directory.length > 0) {
        repository.directory = identity.directory
      }

      const packageSpec: RepositoryPackageSpecBuilder = {
        _tag: "repository",
        name: identity.name,
        registry: identity.provider,
        repository,
      }

      if (specifier !== undefined && specifier.length > 0) {
        packageSpec.specifier = specifier
      }

      return packageSpec
    }

    if (identity.provider !== undefined) {
      return yield* new InvalidPackageIdentity({
        field: "name",
        reason: "repository locators must include both an owner and a repository name",
        value: locator,
      })
    }

    const firstLocatorSegment = locator.split("/")[0] ?? ""
    const isUnambiguousRepositoryLocator =
      /^[a-z][a-z0-9+.-]*:\/\//iu.test(locator) ||
      /^[^@/:]+@[^:]+:.+$/u.test(locator) ||
      (!locator.includes(":") && locator.includes("/") && firstLocatorSegment.includes("."))

    if (isUnambiguousRepositoryLocator) {
      return yield* new UnsupportedRepositoryHostError({ host: identity.host, url: locator })
    }
  }

  let spec = rawSpec
  let registry: Registry = DEFAULT_REGISTRY

  if (checkHasRegistryPrefix(rawSpec)) {
    const [rawRegistry = "", ...rest] = rawSpec.split(":")
    const packageSpec = rest.join(":").trim()

    if (!checkIsRegistry(rawRegistry)) {
      return yield* new UnsupportedRegistryError({ registry: rawRegistry })
    }

    registry = rawRegistry
    spec = packageSpec
  }

  if (spec.length === 0) {
    return yield* new InvalidPackageIdentity({
      field: "name",
      reason: "must not be empty",
      value: spec,
    })
  }

  if (spec.startsWith("@")) {
    const versionSeparatorIndex = spec.lastIndexOf("@")

    if (versionSeparatorIndex <= 0) {
      return {
        _tag: "registry",
        name: spec,
        registry,
      } satisfies RegistryPackageSpec
    }

    const specifier = spec.slice(versionSeparatorIndex + 1)

    const packageSpec: RegistryPackageSpecBuilder = {
      _tag: "registry",
      name: spec.slice(0, versionSeparatorIndex),
      registry,
    }

    if (specifier.length > 0) {
      packageSpec.specifier = specifier
    }

    return packageSpec
  }

  const versionSeparatorIndex = spec.indexOf("@")

  if (versionSeparatorIndex === -1) {
    return {
      _tag: "registry",
      name: spec,
      registry,
    } satisfies RegistryPackageSpec
  }

  const specifier = spec.slice(versionSeparatorIndex + 1)

  const packageSpec: RegistryPackageSpecBuilder = {
    _tag: "registry",
    name: spec.slice(0, versionSeparatorIndex),
    registry,
  }

  if (specifier.length > 0) {
    packageSpec.specifier = specifier
  }

  return packageSpec
})
