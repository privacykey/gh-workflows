# gh-workflows

Reusable GitHub Actions workflows and composite actions for the privacykey
macOS app portfolio. One pipeline, one place to fix it — instead of five
copy-pasted `release.yml`s at three generations of drift.

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

FrameSplash's `scripts/release.sh` is the reference implementation
(xcodebuild archive → export → notarytool submit --wait → staple →
hdiutil DMG → codesign + notarize + staple the DMG).

### Homebrew cask updates (PR-based — the org standard)

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
**Pull requests: read & write**. The Pull-requests permission is new with
the PR flow — tokens minted for the old direct-push flow only carried
Contents and will fail at `gh pr create` until reissued.

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

Repos that predate the current secret scheme (BananaBlitz) use gen-1 names.
Same *values* where noted — mostly this is a rename plus swapping Apple-ID
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

## Migration checklist per consumer repo

### BananaBlitz (gen-1 → gen-3, biggest jump)

- [ ] Mint an ASC API key; add `APPLE_API_KEY`, `APPLE_API_KEY_ID`,
      `APPLE_API_ISSUER` secrets.
- [ ] Rename `APPLE_DEVELOPER_ID_CERT` → `APPLE_CERTIFICATE`,
      `APPLE_DEVELOPER_ID_PASSWORD` → `APPLE_CERTIFICATE_PASSWORD`; add
      `APPLE_SIGNING_IDENTITY`.
- [ ] Delete `APPLE_NOTARY_USER` / `APPLE_NOTARY_PASSWORD` /
      `APPLE_NOTARY_TEAM_ID` once the new flow is proven.
- [ ] Create the `macos-signing` environment; move `SPARKLE_PRIVATE_KEY`
      into it; add a required-reviewers rule.
- [ ] Update `Scripts/release.sh` to the env contract above (it currently
      reads `APPLE_NOTARY_*` and probes the keychain for the identity;
      switch notarytool to `--key/--key-id/--issuer`, honour
      `KEYCHAIN_PATH` via `codesign --keychain`).
- [ ] Replace `release.yml` with the ~15-line caller; pass
      `release_script: ./Scripts/release.sh` (capital S) and
      `uses_xcodegen: true`.
- [ ] Replace `ci.yml` with the `macos-app-ci.yml` caller.
- [ ] Gone for free: the unpinned `brew install --cask sparkle` is replaced
      by the pinned, checksummed tarball install.

### FrameSplash (gen-3 reference — mostly deletion)

- [ ] Replace `.github/workflows/release.yml` with the caller; pass
      `uses_xcodegen: true`, `cask_name: framesplash`,
      `tap_repo: adamxbot/homebrew-tap`.
- [ ] Keep `scripts/release.sh` (it already honours the contract);
      `scripts/generate-appcast.sh` can be deleted once the built-in
      appcast path is proven (or kept and wired via `appcast_script`).
- [ ] Add a CI caller for `macos-app-ci.yml` (FrameSplash has no push/PR
      workflow today — tests only run at release time).
- [ ] Verify `HOMEBREW_TAP_TOKEN` is set if the tap step should run, and
      that the PAT carries **Pull requests: read & write** in addition to
      Contents — the shared workflow uses the PR-based tap flow, not
      FrameSplash's old direct push to the tap default branch.
- [ ] Adjust the release routine: after each release, a
      `release/<cask_name>-<version>` PR appears in the tap — **merging it
      is the cask publish step** (`brew upgrade --cask` sees the version
      only after merge).

### privacycommand (gen-3, minor deltas)

- [ ] Replace `.github/workflows/release.yml` with the caller;
      `uses_xcodegen: false` (project is committed), no cask inputs.
- [ ] Set `publish_dsym: true` to keep its current behaviour of attaching
      the dSYM to the public Release (or accept the new default `false`,
      which keeps symbols private — recommended).
- [ ] Its old keychain step lacked `-T /usr/bin/codesign` and
      `set-key-partition-list` (it worked because its script signs via
      xcodebuild only); the shared keychain action adds both — no repo
      change needed, headless `codesign` invocations now also work.
- [ ] Update `scripts/release.sh` to pass `--keychain "$KEYCHAIN_PATH"`
      to any direct `codesign` calls (env var is already provided).
- [ ] Add a CI caller for `macos-app-ci.yml`.

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
- Third-party actions are SHA-pinned with a version comment. Current pins
  (checkout and upload-artifact reuse the SHAs already proven elsewhere in
  the portfolio):
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
- **Fail closed, not degraded.** claudelog's graceful-degradation ladder
  (no cert → unsigned; no ASC key → signed-not-notarized) was deliberately
  *not* ported: for DMG-shipping consumer apps, a half-signed public
  release is worse than a failed run. All signing secrets are `required`.
  Its `.sha256` sidecar *was* ported.
- **No nested Sparkle re-sign step.** claudelog re-signs Sparkle's XPC
  services because it hand-assembles its .app from `swift build`. The
  xcodebuild archive/export path used here signs nested code correctly on
  its own.
- **Build scripts stay in consumer repos** (local dry-runs), the
  orchestration lives here. The per-repo `generate-appcast.sh` copies are
  replaced by a built-in appcast step (same key-format validation).
