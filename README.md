# gh-workflows

Reusable GitHub Actions workflows and composite actions for the privacykey
macOS app portfolio. One pipeline, one place to fix it.

## Contents

| Path | What it is |
|---|---|
| `.github/workflows/macos-sparkle-release.yml` | Tag-triggered release: test gate → sign → notarize → DMG → appcast → GitHub Release → optional Homebrew cask PR against the tap |
| `.github/workflows/macos-app-ci.yml` | Push/PR CI: unsigned build + tests, zero secrets |
| `actions/setup-apple-keychain` | Ephemeral keychain + Developer ID cert import (`-T codesign`, `set-key-partition-list`, masked password) |
| `actions/write-asc-api-key` | Stages the App Store Connect `.p8` as a mode-600 file |
| `actions/install-sparkle-cli` | Pinned Sparkle release tarball with SHA-256 verification |
| `actions/publish-gh-pages-file` | Worktree-based single-file publish to a branch (appcast.xml → gh-pages) |

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
| `xcodeproj` | — (required) | Path to the `.xcodeproj` |
| `scheme` | — (required) | Also assumed to be the target name |
| `app_name` | scheme | Used in the DMG filename |
| `uses_xcodegen` | `false` | `brew install xcodegen` + `xcodegen generate` first |
| `sparkle_version` / `sparkle_sha256` | `2.9.5` / pinned digest | Bump together, always |
| `dmg_name` | `{app}-{version}.dmg` | Verified against the release script's output |
| `cask_name` / `tap_repo` | empty | Both set (plus `HOMEBREW_TAP_TOKEN`) enables the cask PR flow (see below); template lives at `packaging/homebrew/<cask_name>.rb` |
| `appcast_branch` | `gh-pages` | Where appcast.xml is pushed |
| `macos_runner` | `macos-15` | |
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

## Pinning model

- **Consumers pin this repo's workflows by tag:** `...@v1`. Cut annotated
  tags here (`v1`, `v1.x.y`) and move the major tag deliberately.
- **Inside the workflows, the composite actions are referenced as
  `privacykey/gh-workflows/actions/<name>@main`.** GitHub resolves those
  refs at run time, independently of the tag the *workflow* was pinned at —
  a relative path can't be used because the job's checkout is the consumer
  repo, not this one. Consequence: a push to `main` here changes behaviour
  under consumers pinned to `@v1`. Treat `main` as release-stable, or (more
  robust) update the `@main` refs to `@v1` as part of cutting each release
  tag so the whole dependency chain is tag-pinned.
- Third-party actions are SHA-pinned with a version comment. Current pins:
  - `actions/checkout@df4cb1c069e1874edd31b4311f1884172cec0e10` — v6.0.3
  - `maxim-lobanov/setup-xcode@ed7a3b1fda3918c0306d1b724322adc0b8cc0a90` — v1.7.0
  - `softprops/action-gh-release@3d0d9888cb7fd7b750713d6e236d1fcb99157228` — v3.0.2
  - `actions/upload-artifact@043fb46d1a93c77aae656e7c1c64a875d1fc6a0a` — v7.0.1
- Sparkle CLI: version `2.9.5`, tarball SHA-256
  `015336b601493e05c237964954bff6191370003d94edefe663724c88840d73cc`.
  Bump `sparkle_version` and `sparkle_sha256` together.

## Design decisions (short version)

- **Tests before secrets.** The `test` job has no secrets and no
  environment; the `macos-signing` approval gate sits between it and the
  `release` job.
- **Fail closed, not degraded.** No graceful-degradation ladder (no cert
  → unsigned; no ASC key → signed-not-notarized): for DMG-shipping
  consumer apps, a half-signed public release is worse than a failed run.
  All signing secrets are `required`.
- **No nested Sparkle re-sign step.** The xcodebuild archive/export path
  signs nested code (Sparkle's XPC services included) correctly on its
  own; a separate re-sign step is only needed for hand-assembled .app
  bundles, which this pipeline does not support.
- **Build scripts stay in consumer repos** (local dry-runs), the
  orchestration lives here. Appcast generation is built in, including
  key-format validation.
