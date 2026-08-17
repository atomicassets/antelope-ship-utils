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

    `.github/workflows/publish.yml` starts and waits on the `npm-publish`
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

5. Approve the `npm-publish` environment for the tag. With more than one
   release waiting, approve in ascending version order, so the npm `latest`
   tag stays monotonic.

    The first publish of 1.0.0 is the one exception: npm's trusted publisher
    needs a package that already exists on the registry before it accepts a
    workflow's OIDC token, so that publish is done by hand from a clean
    checkout of the tag:

    ```sh
    git clone --branch v1.0.0 https://github.com/atomicassets/antelope-ship-utils.git
    cd antelope-ship-utils
    pnpm install --frozen-lockfile
    pnpm run build
    npm publish --access public
    ```

    Every release after that goes through the workflow.

6. Verify the published version and the rendered Release:

    ```sh
    npm view @atomichub/antelope-ship-utils version
    gh release view vX.Y.Z
    ```

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
