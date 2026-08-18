import * as Effect from "effect/Effect"
import * as Match from "effect/Match"
import * as Option from "effect/Option"
import { maxSatisfying, valid } from "semver"
import type { NpmPackageMetadata } from "#lib/registries/npm/metadata.ts"
import { PackageVersionNotFoundError } from "#lib/core/errors.ts"
import { NpmRegistryClient } from "#lib/registries/npm/client.ts"
import { defineRegistry } from "#lib/registries/registry.ts"

export const resolveVersion = (metadata: NpmPackageMetadata, requestedSpecifier: string) => {
  if (requestedSpecifier === "latest") {
    return Option.fromNullishOr(metadata["dist-tags"].latest).pipe(
      Option.filter((latest) => metadata.versions[latest] !== undefined)
    )
  }

  return Match.value(valid(requestedSpecifier)).pipe(
    Match.when(Match.string, (exactVersion) =>
      Option.fromNullishOr(metadata.versions[exactVersion]).pipe(Option.as(exactVersion))
    ),
    Match.orElse(() =>
      Option.fromNullishOr(maxSatisfying(Object.keys(metadata.versions), requestedSpecifier))
    )
  )
}

export default defineRegistry({
  name: "npm",
  resolve: (spec) =>
    Effect.gen(function* () {
      const client = yield* NpmRegistryClient
      const metadata = yield* client.getPackageMetadata(spec.name)
      const requestedSpecifier = spec.specifier ?? "latest"
      const resolvedVersion = resolveVersion(metadata, requestedSpecifier)

      if (Option.isNone(resolvedVersion)) {
        return yield* new PackageVersionNotFoundError({
          name: spec.name,
          registry: spec.registry,
          specifier: requestedSpecifier,
        })
      }

      const version = resolvedVersion.value
      const versionMetadata = metadata.versions[version]

      if (versionMetadata === undefined) {
        return yield* new PackageVersionNotFoundError({
          name: spec.name,
          registry: spec.registry,
          specifier: requestedSpecifier,
        })
      }

      const repository = versionMetadata.repository ?? metadata.repository
      const normalizedRepository = Option.fromNullishOr(repository).pipe(
        Option.map(
          Match.type<string | Exclude<typeof repository, string | undefined>>().pipe(
            Match.when(Match.string, (url) => ({ url })),
            Match.orElse(({ directory, url }) => ({ directory, url }))
          )
        ),
        Option.getOrUndefined
      )

      return {
        identity: {
          name: spec.name,
          registry: spec.registry,
          version,
        },
        repository: normalizedRepository,
        tarballUrl: versionMetadata.dist.tarball,
      }
    }),
})
