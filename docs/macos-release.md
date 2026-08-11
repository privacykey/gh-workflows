# macOS release and CI workflows

`macos-sparkle-release.yml` and `macos-app-ci.yml`, in detail. The short
version and the caller snippets live in [the README](../README.md).

## Using the release workflow

A consumer `release.yml` is ~15 lines:

```yaml
name: Release
on:
  push:
    tags: ['v*']
concurrency:
  group: release-${{ github.ref }}
  cancel-in-progress: false
permissions:
  contents: write
jobs:
  release:
    uses: privacykey/gh-workflows/.github/workflows/macos-sparkle-release.yml@v1
    with:
      xcodeproj: MyApp/MyApp.xcodeproj
      scheme: MyApp
      uses_xcodegen: true
    secrets: inherit
```

Notes on that snippet:

- **`secrets: inherit`** is the recommended mode. The release job inside the
  reusable workflow declares `environment: macos-signing`; environment
  secrets (`SPARKLE_PRIVATE_KEY` lives there) only resolve inside that job.
  Explicit `secrets:` mappings are resolved in the *caller's* context, which
  has no environment, and would come back empty. If all your secrets are
  repo/org-scoped, explicit mapping works too.
- **`permissions: contents: write`** on the caller is required — a called
  workflow can only reduce the caller's token permissions, never raise them.
- **`concurrency` in the caller** is deliberate duplication: GitHub's
  handling of workflow-level `concurrency` inside a *called* workflow is
  inconsistent, so both sides declare it.
- The `macos-signing` environment is auto-created (unprotected) on first
  run. Add a **required-reviewers rule** to it so releases pause for human
  approval before any secret is read. Tests run *before* that gate.

Frequently used inputs (see the workflow header for the full list and the
release-script contract):

| Input | Default | Notes |
|---|---|---|
| `xcodeproj` | — | Path to the `.xcodeproj`. Optional **only** when `release_script` is set — see [Apps without an Xcode project](#apps-without-an-xcode-project) |
| `scheme` | — | Required whenever `xcodeproj` is set; also assumed to be the target name |
| `test_script` | empty | Replaces the built-in `xcodebuild test`. Required when `xcodeproj` is empty |
| `version_plist` | empty | Info.plist to check the tag against when there is no project. Empty skips the check with a warning |
| `app_name` | scheme | Used in the DMG filename |
| `uses_xcodegen` | `false` | `brew install xcodegen` + `xcodegen generate` first |
| `sparkle_version` / `sparkle_sha256` | `2.9.5` / pinned digest | Bump together, always |
| `dmg_name` | `{app}-{version}.dmg` | Verified against the release script's output |
| `cask_name` / `tap_repo` | empty | Both set (plus `HOMEBREW_TAP_TOKEN`) enables the cask PR flow (see below); template lives at `packaging/homebrew/<cask_name>.rb` |
| `appcast_branch` | `gh-pages` | Where appcast.xml is pushed |
| `runner` | `macos-15` | Plain label, or a JSON array string for the self-hosted fleet — see [Self-hosted runners](self-hosted-runners.md) |
| `release_runner` | same as `runner` | Set separately to keep signing off the ordinary CI machine |
| `macos_runner` | empty | Deprecated, superseded by `runner`; a non-empty value still wins so existing callers keep working |
| `release_tag` | triggering ref name | Tag to release as when the caller was started by `workflow_dispatch` rather than a tag push |
| `publish_dsym` | `false` | `true` attaches the dSYM zip to the public Release (it is always kept as a private 365-day workflow artefact) |
| `release_script` | `./scripts/release.sh` | Must honour the env contract below |
| `appcast_script` | empty (built-in) | Only set if your repo needs a custom appcast |

### Release script contract

The consumer repo owns its build script (so releases can be dry-run
locally). The workflow invokes it with:

- **reads (env):** `APPLE_SIGNING_IDENTITY`, `APPLE_API_KEY_PATH`,
  `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `KEYCHAIN_PATH`, `SCHEME`
- **writes:** `dist/<app>-<version>.dmg` (signed + notarized + stapled),
  optionally `symbols/<app>-<version>.app.dSYM.zip`

A typical implementation: xcodebuild archive → export → notarytool
submit --wait → staple → hdiutil DMG → codesign + notarize + staple the
DMG.

The tag-verification step assumes the app target has the same name as the
scheme, and that `MARKETING_VERSION` matches the pushed tag
(tag `v1.2.3` ⇔ `MARKETING_VERSION` `1.2.3`).

### Homebrew cask updates (PR-based)

When `cask_name`, `tap_repo`, and the `HOMEBREW_TAP_TOKEN` secret are all
set, the release job:

1. renders `packaging/homebrew/<cask_name>.rb` from the consumer repo's
   template, substituting `@@VERSION@@` / `@@SHA256@@` / `@@URL@@`;
2. pushes the rendered cask to a **`release/<cask_name>-<version>`
   branch** in the tap repo;
3. opens a **pull request** in the tap (via `gh`, authenticated with
   `HOMEBREW_TAP_TOKEN`) whose body links the triggering GitHub Release
   and carries the version/SHA-256/DMG details.

Nothing is ever pushed to the tap's default branch. Merging the tap PR is
the publish action — that's when `brew upgrade --cask <cask_name>` starts
seeing the new version. Re-running a release force-refreshes the same
`release/<cask_name>-<version>` branch and reuses the already-open PR
instead of stacking duplicates. If any of the three settings is missing,
the step skips cleanly and the rest of the release is unaffected.

Token requirements: `HOMEBREW_TAP_TOKEN` must be a fine-grained PAT
scoped to **only** the tap repo, with **Contents: read & write** *and*
**Pull requests: read & write**. A token that only carries Contents
fails at `gh pr create`.

## Apps without an Xcode project

A SwiftPM package, a Makefile build, a shell script — anything producing a
`.app` without an `.xcodeproj` — uses the same pipeline by leaving `xcodeproj`
empty and owning both the build and the tests:

```yaml
    with:
      app_name: "Runner Menu"              # required: normally defaults to scheme
      test_script: ./run-tests.sh          # required: the built-in test step is xcodebuild
      release_script: ./scripts/release.sh
      version_plist: Resources/Info.plist  # optional tag cross-check
```

Signing, notarization, DMG, appcast, Release and the cask PR are unchanged.
Only the steps that drive `xcodebuild` are skipped: the built-in test step, the
unsigned Release build, and the `-showBuildSettings` version lookup.

A preflight step rejects half-wired combinations before any secret is read — a
missing `release_script` or `test_script`, `uses_xcodegen` with no project to
generate, or an empty `app_name` that would produce a DMG called `-1.0.dmg`.

`version_plist` must hold a literal version. `$(MARKETING_VERSION)` is resolved
by Xcode at build time, so the workflow fails rather than comparing a tag
against placeholder text. Omit it and the tag simply is not cross-checked,
which warns rather than failing — a weaker release, not a broken one.

## Using the CI workflow

```yaml
name: CI
on:
  push:
    branches: [main]
  pull_request:
    branches: [main]
concurrency:
  group: ci-${{ github.ref }}
  cancel-in-progress: true
jobs:
  ci:
    uses: privacykey/gh-workflows/.github/workflows/macos-app-ci.yml@v1
    with:
      xcodeproj: MyApp/MyApp.xcodeproj
      scheme: MyApp
      uses_xcodegen: true
```

No secrets, `CODE_SIGNING_ALLOWED=NO`, xcresult uploaded as a 7-day
artifact. `test_script` overrides the default `xcodebuild test` invocation
if a repo needs something custom.

## Secret names: gen-1 → gen-3 mapping

Repos that predate the current secret scheme use gen-1 names. Same
*values* where noted — mostly this is a rename plus swapping Apple-ID
notarization for an App Store Connect API key.

| gen-1 (old) | gen-3 (this repo) | Migration |
|---|---|---|
| `APPLE_DEVELOPER_ID_CERT` | `APPLE_CERTIFICATE` | Rename — same base64 `.p12` |
| `APPLE_DEVELOPER_ID_PASSWORD` | `APPLE_CERTIFICATE_PASSWORD` | Rename — same passphrase |
| *(none — script probed the keychain)* | `APPLE_SIGNING_IDENTITY` | New: the exact `"Developer ID Application: … (TEAMID)"` string |
| `APPLE_NOTARY_USER` (Apple ID) | *(retired)* | Replaced by ASC API key auth |
| `APPLE_NOTARY_PASSWORD` (app-specific password) | *(retired)* | Replaced by ASC API key auth |
| `APPLE_NOTARY_TEAM_ID` | *(retired)* | Team ID is derived from the signing identity |
| *(none)* | `APPLE_API_KEY` | New: full PEM contents of the ASC `.p8` |
| *(none)* | `APPLE_API_KEY_ID` | New: 10-char Key ID |
| *(none)* | `APPLE_API_ISSUER` | New: Issuer UUID |
| `SPARKLE_PRIVATE_KEY` | `SPARKLE_PRIVATE_KEY` | Unchanged — but move it into the `macos-signing` environment |
| *(none)* | `HOMEBREW_TAP_TOKEN` (optional) | Fine-grained PAT scoped to the tap repo only — Contents **and** Pull requests, read & write (the cask lands as a tap PR, not a direct push) |

Why the ASC API key beats Apple-ID + app-specific password: revocable
per-key in one click, immune to Apple ID 2FA prompts, and org-shareable
without sharing an account.

## Migrating a consumer repo

Repo-specific migration steps live in each consumer repo's migration PR.
The generic sequence:

1. Mint an App Store Connect API key; add `APPLE_API_KEY`,
   `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`. Rename any gen-1 secrets per
   the mapping table above.
2. Create the `macos-signing` environment; move `SPARKLE_PRIVATE_KEY`
   into it; add a required-reviewers rule.
3. Bring the repo's release script onto the env contract above
   (notarytool `--key/--key-id/--issuer`; honour `KEYCHAIN_PATH` via
   `codesign --keychain` on any direct `codesign` calls).
4. Replace `release.yml` with the ~15-line caller (`secrets: inherit`)
   and `ci.yml` with the `macos-app-ci.yml` caller.
5. If the app ships a Homebrew cask: add the
   `packaging/homebrew/<cask_name>.rb` template, set `cask_name` /
   `tap_repo`, and mint a `HOMEBREW_TAP_TOKEN` PAT (Contents *and* Pull
   requests, read & write). After each release, merging the tap PR is
   the cask publish step.
6. Retire the gen-1 secrets (`APPLE_NOTARY_*`, `APPLE_DEVELOPER_ID_*`)
   once the new flow is proven.
