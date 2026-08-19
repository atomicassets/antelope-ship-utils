# Releasing @atomichub/antelope-ship-utils

How a version of this package reaches npm and GitHub. A release ends at a
rendered GitHub Release, not at the npm publish.

## Checklist

1. The feature PR carries the `CHANGELOG.md` entry for the version under
   `## [X.Y.Z]`, written in the section shape below with H3 headings, and
   lands on `main`. The entry is the editorial text of the Release, so it is
   written once, in the PR that makes the change.

2. Land a `chore(release): X.Y.Z` commit on `main` that bumps the version in
   `package.json`. Read the `CHANGELOG.md` entry against the template below
   now, because the next step publishes a tag.

3. Tag the release commit and push the tag:

    ```sh
    git tag vX.Y.Z && git push origin vX.Y.Z
    ```

    `.github/workflows/publish.yml` starts; its build job runs the release
    gates (tag matches version, tag on main), the install, the tests, and
    packs the tarball; its publish job waits on the `npm-publish`
    environment. The tag is the release: consumers pin or float on it, so
    push it only once the entry and the code behind it are ready.

4. Compose the body, read it, then create the Release:

    ```sh
    scripts/release-notes.sh vX.Y.Z > notes.md
    gh release create vX.Y.Z --verify-tag --title vX.Y.Z --notes-file notes.md
    ```

    With more than one release in flight, create them in ascending version
    order, so the latest marker stays monotonic. `v1.0.0` has no earlier tag,
    so the script refuses it; write that body by hand as the summary plus
    `Initial release.` instead.

5. Approve the `npm-publish` environment for the tag once the run is green
   through the build gates, the tag-on-main check included, which proves
   the tagged commit sits on `main`. With more than one release waiting,
   approve in ascending version order, so the npm `latest` tag stays
   monotonic.

6. Verify the published version and the rendered Release:

    ```sh
    npm view @atomichub/antelope-ship-utils version
    gh release view vX.Y.Z
    ```

## Publish auth

The publish job authenticates through npm trusted publishing (OIDC). It holds
no npm token and sets no registry URL on the setup step, so nothing writes an
`.npmrc` auth entry and npm 11.5.1 or later exchanges the job's OIDC identity
for a short-lived credential of its own. The `npm-publish` environment is the
gate on that identity: the build job runs immediately on the pushed tag, and
the publish job waits until a maintainer approves it.

`publishConfig.provenance` in `package.json` makes a default local npm publish
fail, because no OIDC identity is available outside CI to satisfy it. It is
data inside the manifest being published, not an access control. The durable
control is the npm-side package setting that requires trusted publishing,
which closes the classic-token path that no workflow change can reach.

## Body template

The Release title is the tag name verbatim. The body is an optional
one-sentence summary, then the sections that have items, then the commit
list, then the compare link as the last line. Nothing follows the link, and
a section with no items is left out.

```
<one-sentence summary, optional>

## Breaking changes

- <what changed, and what the reader does about it>. (#N)

## Upgrading

- <a renamed export, a configuration key to set, or a step to run>. (#N)

## Features

- <what is new>. (#N)

## Bug fixes

- <what was wrong and is not now>. (#N)

## Security

- <the advisory or the dependency lift, named>. (#N)

## Deprecations

- <what is deprecated and what replaces it>. (#N)

## Other changes

- <a change a consumer notices that fits no section above>. (#N)

## Commits

- <short sha> <subject>

Full changelog: https://github.com/atomicassets/antelope-ship-utils/compare/<PREV>...<TAG>
```

The section order is breaking changes, upgrading, features, bug fixes,
security, deprecations, other changes. `## Security` carries advisories and
dependency lifts, each naming its GHSA or CVE identifier; a release with
none leaves the section out.

## Voice

- Neutral and factual, the register of the Node.js or esbuild release notes.
- Sectioned. The heading says what kind of change it is, so the item does
  not repeat it.
- One to three plain sentences per item: what changed, and what the reader
  does about it when action is needed. Code identifiers in backticks.
- Every item ends with its PR reference `(#N)`, or with its short sha in
  backticks when the change had no PR.
- No preface, no motivation essay, no clause chain explaining how the
  author got there. The why stays only where it changes what the reader
  does.
- Present tense for the new behavior, sentence-case headings, straight
  quotes, and no em-dash.

## The CHANGELOG entry

`CHANGELOG.md` is where the editorial text is written, and the Release body
is that entry with its headings promoted one level. An entry heading is
`## [X.Y.Z]`. Under it comes an optional one-line summary, then the H3
sections in the order above.

## Tag ranges and older releases

- `PREV` for a stable tag is the nearest earlier stable `v*` tag, so a
  stable release lists every commit since the last stable release and skips
  the prereleases between them. `PREV` for a prerelease tag is the nearest
  earlier tag of any kind. A stable tag whose only earlier tags are
  prereleases takes the nearest of them.
- `## Commits` lists the whole `PREV..TAG` range, oldest first, including
  the release commit. Its line count equals `git rev-list --count
  PREV..TAG`.
- A tag with no earlier tag has no `PREV`. Its body is the summary and the
  sentence `Initial release.`, with no commit list and no compare link, and
  it is written by hand. `v1.0.0` is this case.
- A prerelease tag (`vX.Y.Z-rc.1` and the like) is created with
  `--prerelease`.
- A Release created for a tag older than the current latest is created with
  `--latest=false`, so the latest marker stays on the newest version.

`scripts/release-notes.sh` needs bash, git, awk and sed. It reads the
`CHANGELOG.md` at the tag rather than from the working tree, so the body
describes what the tag ships. It exits non-zero and names what is missing
when no tag is given, when the tag is not v-prefixed, when the tag does not
exist, when the CHANGELOG at that tag carries no entry for the version, and
when no earlier `v*` tag exists.

## Published package metadata

A release publishes a package page as well as a Release, and the page reads
`package.json`. It carries `name` and `version`; `description` (one sentence
on what the package does and for whom); `license`, with the `LICENSE` file
shipped; `homepage`; `repository` (an object with `type: git` and the
`git+https` URL); `bugs` (an object with the issues URL); `author` (an object
with `name` and `url`); `keywords`; `engines`; `main`, `types` and the
`exports` map; `files` (the build output and the notices that must ship);
`sideEffects`; and `publishConfig` with `access: public` and
`provenance: true`, so a publish outside `publish.yml` either carries the
same access and provenance or fails instead of publishing without them.
The package ships CommonJS only, because the parallel deserializer loads
its worker by a path relative to the compiled entry, so there is no
`module` field.

The README is the npm page: it opens with the package name, badges for the
npm version, CI and license, a short introduction, and an install line.
`npm pack --dry-run` lists what the tarball ships: `dist/` with its type
declarations and source maps, `README.md`, `LICENSE`, `NOTICE`,
`CHANGELOG.md` and `package.json`, and anything else is a `files` mistake.
`src/packaging.test.ts` runs that check in CI, so the tarball is proven
before the tag.
