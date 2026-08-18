import * as Effect from "effect/Effect"
import * as Match from "effect/Match"
import * as Option from "effect/Option"
import type {
  NormalizedRepositorySource,
  RepositorySourceCandidate,
  ResolvedRepositoryRef,
} from "#lib/core/source.ts"
import {
  InvalidRepositoryUrlError,
  TagNotFoundError,
  UnsupportedRepositoryHostError,
} from "#lib/core/errors.ts"
import {
  REPOSITORY_PROVIDER_HOSTS,
  SUPPORTED_REPOSITORY_PROVIDERS,
  type PackageIdentity,
  type RepositoryPackageSpec,
  type RepositoryProvider,
} from "#lib/core/packages.ts"
import { matchRepositoryTag, RemoteTagReader } from "#lib/sources/repository/tags.ts"

const COMMIT_SHA_PATTERN = /^[0-9a-f]{40}$/iu

const HOST_PROVIDERS = new Map<string, RepositoryProvider>(
  SUPPORTED_REPOSITORY_PROVIDERS.map((provider) => [REPOSITORY_PROVIDER_HOSTS[provider], provider])
)

const DEFAULT_SHORTHAND_PROVIDER = "github" satisfies RepositoryProvider
const SHORTHAND_PATTERN = new RegExp(
  `^(?<provider>${SUPPORTED_REPOSITORY_PROVIDERS.join("|")}):(?<repositoryPath>.+)$`,
  "u"
)

const checkIsKnownProvider = (value: string): value is RepositoryProvider =>
  SUPPORTED_REPOSITORY_PROVIDERS.some((provider) => provider === value)

const cleanRepositoryPath = (repositoryPath: string) =>
  repositoryPath
    .replace(/\/+$/u, "")
    .replace(/\.git$/u, "")
    .replace(/^\/+/u, "")

const invalidRepositoryUrl = (candidate: RepositorySourceCandidate, reason: string) =>
  new InvalidRepositoryUrlError({ reason, url: candidate.url })

const makeNormalizedSource = (
  candidate: RepositorySourceCandidate,
  host: string,
  rawRepositoryPath: string
) => {
  const repositoryPath = cleanRepositoryPath(rawRepositoryPath)

  if (repositoryPath.length === 0) {
    return Effect.fail(invalidRepositoryUrl(candidate, "repository path must not be empty"))
  }

  const provider = HOST_PROVIDERS.get(host)
  const fetchRepositoryPath =
    provider === "sourcehut" ? repositoryPath.replace(/^~/u, "") : repositoryPath

  const source: NormalizedRepositorySource = {
    fetchSource: provider === undefined ? undefined : `${provider}:${fetchRepositoryPath}`,
    host,
    type: "repository",
    url: `https://${host}/${repositoryPath}`,
  }

  if (candidate.directory !== undefined) {
    Object.assign(source, { directory: candidate.directory })
  }

  if (candidate.requestedRef !== undefined) {
    Object.assign(source, { requestedRef: candidate.requestedRef })
  }

  return Effect.succeed(source)
}

const normalizeFromShorthandUrl = (
  candidate: RepositorySourceCandidate,
  provider: RepositoryProvider,
  repositoryPath: string
) => {
  const barePath = cleanRepositoryPath(repositoryPath).replace(/^~/u, "")

  if (barePath.length === 0) {
    return Effect.fail(invalidRepositoryUrl(candidate, "repository path must not be empty"))
  }

  return makeNormalizedSource(
    candidate,
    REPOSITORY_PROVIDER_HOSTS[provider],
    provider === "sourcehut" ? `~${barePath}` : barePath
  )
}

const normalizeFromStandardUrl = (candidate: RepositorySourceCandidate, rawUrl: string) =>
  Effect.try({
    catch: (cause) => invalidRepositoryUrl(candidate, `failed to parse URL (${String(cause)})`),
    try: () => new URL(rawUrl),
  }).pipe(
    Effect.flatMap((parsedUrl) =>
      makeNormalizedSource(candidate, parsedUrl.host.toLowerCase(), parsedUrl.pathname)
    )
  )

const normalizeFromScpLikeUrl = (candidate: RepositorySourceCandidate, rawUrl: string) => {
  const groups = Option.fromNullishOr(
    /^(?:[^@]+@)?(?<host>[^:]+):(?<repositoryPath>.+)$/u.exec(rawUrl)
  ).pipe(Option.flatMap((match) => Option.fromNullishOr(match.groups)))
  const host = Option.getOrUndefined(groups)?.host
  const repositoryPath = Option.getOrUndefined(groups)?.repositoryPath

  if (host === undefined || repositoryPath === undefined) {
    return Effect.fail(invalidRepositoryUrl(candidate, "unsupported repository URL format"))
  }

  return makeNormalizedSource(candidate, host.toLowerCase(), repositoryPath)
}

export const normalizeRepositorySource = Effect.fn("normalizeRepositorySource")((
  candidate: RepositorySourceCandidate
) => {
  const url = candidate.url.trim().replace(/^git\+/u, "")
  const shorthandGroups = Option.fromNullishOr(SHORTHAND_PATTERN.exec(url)).pipe(
    Option.flatMap((match) => Option.fromNullishOr(match.groups))
  )
  const provider = Option.getOrUndefined(shorthandGroups)?.provider
  const shorthandPath = Option.getOrUndefined(shorthandGroups)?.repositoryPath

  if (provider !== undefined && shorthandPath !== undefined && checkIsKnownProvider(provider)) {
    return normalizeFromShorthandUrl(candidate, provider, shorthandPath)
  }

  if (/^[^/:\s]+\/[^/:\s]+$/u.test(url)) {
    return normalizeFromShorthandUrl(candidate, DEFAULT_SHORTHAND_PROVIDER, url)
  }

  if (/^[a-z][a-z0-9+.-]*:\/\//iu.test(url)) {
    return normalizeFromStandardUrl(candidate, url)
  }

  return normalizeFromScpLikeUrl(candidate, url)
})

export interface ResolvedDirectRepositoryRef {
  readonly identity: PackageIdentity
  readonly repository: ResolvedRepositoryRef
}

export const resolveDirectRepositoryRef = Effect.fn("resolveDirectRepositoryRef")(function* (
  spec: RepositoryPackageSpec
) {
  const source = yield* normalizeRepositorySource(spec.repository)

  if (source.fetchSource === undefined) {
    return yield* new UnsupportedRepositoryHostError({ host: source.host, url: source.url })
  }

  const remoteTagReader = yield* RemoteTagReader
  const refs = yield* remoteTagReader.listRefs(source)
  const requestedRef = spec.specifier
  const tagSha = requestedRef === undefined ? undefined : refs.tags.get(requestedRef)
  const branchSha = requestedRef === undefined ? undefined : refs.heads.get(requestedRef)
  const resolved = yield* Match.value({ branchSha, head: refs.head, requestedRef, tagSha }).pipe(
    Match.when(
      ({ head, requestedRef }) => requestedRef === undefined && head !== undefined,
      ({ head }) => Effect.succeed({ ref: head ?? "", version: head ?? "" })
    ),
    Match.when(
      ({ requestedRef, tagSha }) => requestedRef !== undefined && tagSha !== undefined,
      ({ tagSha }) => Effect.succeed({ ref: tagSha ?? "", version: tagSha ?? "" })
    ),
    Match.when(
      ({ branchSha, requestedRef }) => requestedRef !== undefined && branchSha !== undefined,
      ({ branchSha }) => Effect.succeed({ ref: branchSha ?? "", version: branchSha ?? "" })
    ),
    Match.when(
      ({ requestedRef }) => requestedRef !== undefined && COMMIT_SHA_PATTERN.test(requestedRef),
      ({ requestedRef }) => {
        const commitSha = requestedRef?.toLowerCase() ?? ""

        return Effect.succeed({ ref: commitSha, version: commitSha })
      }
    ),
    Match.orElse(({ requestedRef }) =>
      Effect.fail(new TagNotFoundError({ repository: source.url, version: requestedRef ?? "HEAD" }))
    )
  )

  const resolvedSource: NormalizedRepositorySource = { ...source }

  if (requestedRef !== undefined) {
    Object.assign(resolvedSource, { requestedRef })
  }

  return {
    identity: { name: spec.name, registry: spec.registry, version: resolved.version },
    repository: {
      ref: resolved.ref,
      source: resolvedSource,
    },
  } satisfies ResolvedDirectRepositoryRef
})

export const resolveRepositoryRef = Effect.fn("resolveRepositoryRef")(function* (
  identity: PackageIdentity,
  candidate: RepositorySourceCandidate
) {
  const source = yield* normalizeRepositorySource(candidate)

  if (source.fetchSource === undefined) {
    return yield* new UnsupportedRepositoryHostError({
      host: source.host,
      url: source.url,
    })
  }

  const remoteTagReader = yield* RemoteTagReader
  const tags = yield* remoteTagReader.list(source)
  const ref = matchRepositoryTag(identity, tags)

  if (Option.isNone(ref)) {
    return yield* new TagNotFoundError({
      repository: source.url,
      version: identity.version,
    })
  }

  return {
    ref: ref.value,
    source,
  } satisfies ResolvedRepositoryRef
})
