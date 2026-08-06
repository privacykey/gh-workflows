<!--
README patch for privacykey/gh-workflows.

1. Add this row to the Contents table (after the macos-app-ci.yml row):

| `.github/workflows/ios-release.yml` | iOS archive/TestFlight: unsigned validate gate → signed archive → .ipa + dSYM artefacts → optional `altool` TestFlight upload; dual signing modes (self-hosted runner keychain / hosted cert import) |

2. Insert everything below as a new top-level section after
   "## Using the CI workflow" and before "## Secret names: gen-1 → gen-3
   mapping".

3. Append the two migration checklists to the existing
   "## Migration checklist per consumer repo" section.
   (They are written inline here to keep this patch file self-contained.)
-->

## Using the iOS release workflow

`ios-release.yml` generalises TrainieTalkie's working release automation
(its `ios-release.yml` signed-archive job + `Scripts/archive.sh`): a
secret-free unsigned Release build gate, then a signed archive → `.ipa`
export → IPA + dSYM artefacts → optional TestFlight upload. It is the iOS
sibling of `macos-sparkle-release.yml`, with one structural difference:
iOS has **two signing modes**, selected by the required `signing` input.

| Mode | Runner | Where signing material lives | Apple secrets in GitHub |
|---|---|---|---|
| `runner-keychain` | self-hosted fleet (e.g. `'["self-hosted", "macOS", "ARM64"]'`) | Runner's login keychain + signed-in Xcode account; ASC `.p8` at `~/.appstoreconnect/private_keys/` | **None** (two non-key IDs only if uploading) |
| `import` | GitHub-hosted (e.g. `macos-15`) | Ephemeral keychain via `setup-apple-keychain`, `.p8` via `write-asc-api-key`, both cleaned up `always()` | Cert + ASC key secrets, required |

In `runner-keychain` mode the workflow **never imports certificates and
never deletes keychains** — the fleet's keychain is persistent shared
state. In `import` mode it reuses the same composite actions as the macOS
release pipeline; note the certificate is an **Apple Distribution** `.p12`
(iOS App Store), *not* the macOS "Developer ID Application" one — set it
repo-scoped on iOS consumers so it shadows any org-level macOS cert.

### Consumer: self-hosted, TrainieTalkie shape

Keeps PR/push release validation and the manually-dispatched signed
archive in one workflow, exactly like the workflow it replaces:

```yaml
name: iOS Release validation
on:
  pull_request:
    paths: ["TrainieTalkie/**", "Widget/**", "Messages/**", "project.yml",
            "Scripts/ExportOptions.plist", ".github/workflows/ios-release.yml"]
  push:
    branches: [main]
    paths: ["TrainieTalkie/**", "Widget/**", "Messages/**", "project.yml",
            "Scripts/ExportOptions.plist", ".github/workflows/ios-release.yml"]
  workflow_dispatch:
    inputs:
      signed_archive:
        description: Build and export a signed IPA after Release validation
        required: false
        default: false
        type: boolean
permissions:
  contents: read
concurrency:
  group: ios-release-${{ github.ref }}
  cancel-in-progress: false
jobs:
  release:
    uses: privacykey/gh-workflows/.github/workflows/ios-release.yml@v1
    with:
      xcodeproj: TrainieTalkie.xcodeproj
      scheme: TrainieTalkie
      uses_xcodegen: true
      signing: runner-keychain
      runner: '["self-hosted", "macOS", "ARM64"]'
      export_options_path: Scripts/ExportOptions.plist
      signed_archive: ${{ github.event_name == 'workflow_dispatch' && inputs.signed_archive }}
      # upload_to_testflight: true   # needs APPLE_API_KEY_ID + APPLE_API_ISSUER (IDs only)
```

No `secrets:` block at all while `upload_to_testflight` is off — the
self-hosted model keeps zero Apple secrets in GitHub.

### Consumer: hosted, restauranteer-ios shape

```yaml
name: iOS Release
on:
  workflow_dispatch:
    inputs:
      upload_to_testflight:
        description: Upload the exported IPA to TestFlight
        required: false
        default: false
        type: boolean
permissions:
  contents: read
concurrency:
  group: ios-release-${{ github.ref }}
  cancel-in-progress: false
jobs:
  release:
    uses: privacykey/gh-workflows/.github/workflows/ios-release.yml@v1
    with:
      xcodeproj: Restauranteer.xcodeproj
      scheme: Restauranteer
      uses_xcodegen: true
      signing: import
      runner: macos-15                # pick an image whose Xcode has the SDK you pin
      xcode_version: latest-stable    # restauranteer needs the iOS 26 SDK — see its ci.yml
      team_id: ${{ vars.APPLE_TEAM_ID }}   # repo variable: the team stays out of committed files
      spm_resolved_path: Restauranteer.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved
      upload_to_testflight: ${{ inputs.upload_to_testflight }}
    secrets: inherit
```

With `spm_resolved_path` set, every `xcodebuild` gets
`-onlyUsePackageVersionsFromResolvedFile` and the committed pin file is
drift-checked after `xcodegen generate` and after the build — resolution
may fetch, but it may not move off the committed pins.

No `export_options_path` here: the workflow generates a minimal
automatic-signing plist (`method` + `teamID` + `destination: export`), the
shape restauranteer's own `docs/appstore/testflight.md` documents.

### Secrets by mode (names only)

| Secret | `runner-keychain` | `import` |
|---|---|---|
| `APPLE_CERTIFICATE` (Apple Distribution `.p12`, base64) | never read | required |
| `APPLE_CERTIFICATE_PASSWORD` | never read | required |
| `APPLE_API_KEY` (`.p8` PEM) | never read — the `.p8` lives on the runner | required |
| `APPLE_API_KEY_ID` | only when `upload_to_testflight` | required |
| `APPLE_API_ISSUER` | only when `upload_to_testflight` | required |

All five are declared `required: false` at the `workflow_call` level and
enforced at runtime per mode, with fail-closed errors. Scope them to the
`ios-signing` environment and call with `secrets: inherit` (same
resolution rule as `macos-signing` — environment secrets only resolve
inside the job that declares the environment).

The `archive` job declares `environment: ios-signing`; it is auto-created
(unprotected) on first run — add a required-reviewers rule so signing
pauses for human approval. The `validate` job runs before that gate and
reads no secrets.

### Upload tooling (why altool, and the exit ramp)

`Scripts/archive.sh` — the portfolio's only proven CLI upload — uses
`xcrun altool --upload-app -f <ipa> -t ios --apiKey <id> --apiIssuer
<issuer>` with App Store Connect API-key auth. That exact invocation is
kept, in both modes (`import` mode stages the `.p8` for altool via
`API_PRIVATE_KEYS_DIR`). Notes:

- `xcrun notarytool` replaced altool **for notarization only** (a
  macOS/DMG concern); it cannot upload iOS builds and has no role here.
- `altool --upload-app` is Apple-deprecated but still ships and still
  works — TrainieTalkie ships with it. The workflow probes
  `xcrun --find altool` and fails with a migration pointer if a future
  Xcode drops it.
- The documented migration, already described in both consumer repos, is
  ExportOptions `destination: upload` on the `-exportArchive` step (or
  Transporter). It would land here once, behind the same inputs — which
  is why there is no speculative `upload_tool` input today.

### Frequently used inputs

Full list and semantics in the workflow header.

| Input | Default | Notes |
|---|---|---|
| `xcodeproj` / `workspace` | — | Exactly one required |
| `scheme` | — (required) | Also names the archive and artefacts |
| `signing` | — (required) | `runner-keychain` or `import` |
| `runner` | `macos-15` | Plain label, or a JSON array string for self-hosted label sets |
| `uses_xcodegen` | `false` | brew-installed in `import` mode; must be preinstalled on self-hosted |
| `export_options_path` | empty | Committed plist wins; empty generates one from `export_method` + `team_id` |
| `export_method` | `app-store-connect` | Or `ad-hoc`; only used when generating the plist |
| `team_id` | empty | Required when generating the plist; also injected as `DEVELOPMENT_TEAM` when set |
| `build_number` | `auto` | archive.sh's minutes-since-epoch scheme; `project` leaves `CURRENT_PROJECT_VERSION` alone; integer forces |
| `signed_archive` | `true` | `false` runs only the secret-free validate job |
| `upload_to_testflight` | `false` | `altool --upload-app` with ASC API-key auth |
| `run_tests` / `test_script` | `false` / empty | Validate-job tests + xcresult artefact; default off to match TrainieTalkie (its unit tests run in separate CI) |
| `spm_resolved_path` | empty | Package.resolved drift gate + `-onlyUsePackageVersionsFromResolvedFile` |
| `ipa_retention_days` | `14` | dSYM artefact is always 365 days |

What the workflow deliberately does **not** do: bump `MARKETING_VERSION`
(archive.sh's `-v` writes project.yml and wants a commit — versioning
stays a local, human act), create App Store Connect records, or perform
first-run capability provisioning (see each repo's runbook).

<!-- ── Append to "## Migration checklist per consumer repo" ────────── -->

### TrainieTalkie / transportnotify (self-hosted, zero new secrets)

- [ ] Replace `.github/workflows/ios-release.yml` with the caller above
      (keep the PR/push `paths:` filters and the `workflow_dispatch`
      boolean; the `signed_archive` expression reproduces the old
      dispatch-gated signed-archive job).
- [ ] Keep `Scripts/ExportOptions.plist` and pass it as
      `export_options_path` — the generated-plist path is for repos
      without one.
- [ ] Keep `Scripts/archive.sh` for the local ship flow (version bumps
      via `-v`, local uploads). The workflow replicates its archive/export
      steps and its auto build number (`build_number_epoch` defaults to
      archive.sh's 2026-07-12 epoch — do not change it for this app).
- [ ] Keep `ios-ci.yml` (unit tests) as is. Optionally pass a
      `test_script` reproducing its invocation
      (`-only-testing:TrainieTalkieTests -parallel-testing-enabled NO`
      against the TT-TestRunner simulator) to also gate signing on tests.
- [ ] No secrets needed for the current behaviour (IPA artefact only,
      manual Transporter upload). To turn on `upload_to_testflight`: add
      `APPLE_API_KEY_ID` + `APPLE_API_ISSUER` (identifiers, not key
      material — the `.p8` stays at `~/.appstoreconnect/private_keys/` on
      the runner fleet, preserving "no Apple private keys in GitHub").
- [ ] First run auto-creates the `ios-signing` environment; add a
      required-reviewers rule if fleet archives should pause for approval.
- [ ] Runners: confirm xcodegen stays preinstalled and
      `/opt/homebrew/bin` reachable (the workflow prepends it, matching
      the old steps).

### restauranteer-ios (hosted, new secrets)

- [ ] One-time, still manual (CI cannot do these):  App Store Connect app
      record + name reservation, and the first device build from Xcode
      that auto-provisions the App IDs / iCloud container / App Group —
      `docs/appstore/testflight.md` §1–2.
- [ ] Mint an ASC API key; add repo (or `ios-signing` environment)
      secrets `APPLE_API_KEY`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`.
- [ ] Export the **Apple Distribution** cert + key as `.p12`; add
      `APPLE_CERTIFICATE` (base64) + `APPLE_CERTIFICATE_PASSWORD`
      **repo-scoped** — they intentionally shadow the org-level macOS
      Developer ID values of the same names.
- [ ] Add the team as a repo variable (`APPLE_TEAM_ID`) and pass
      `team_id: ${{ vars.APPLE_TEAM_ID }}` — keeps the team ID out of
      committed files, per the repo README's warning; it also substitutes
      for the gitignored `Config/Signing.local.xcconfig` in CI via a
      `DEVELOPMENT_TEAM` override.
- [ ] Add the `release.yml` caller above; keep `ci.yml` (packages +
      simulator build + keychain host tests) untouched.
- [ ] Pass `spm_resolved_path` so the release build enforces the same
      §D34 pin gate as CI.
- [ ] Build numbers: the default `build_number: auto` overrides the
      xcconfig's `CURRENT_PROJECT_VERSION` per build — monotonic, so the
      "must increase for every TestFlight upload" rule (and the
      `NSUbiquitousContainers` re-read trick) is satisfied without
      editing `Config/Shared.xcconfig`. Pass `build_number: project` to
      keep hand-managed numbers instead.
- [ ] Runner/Xcode: pick a hosted image whose Xcode carries the iOS 26
      SDK the project pins (`Config/Shared.xcconfig`); set
      `runner` / `xcode_version` accordingly.
- [ ] Create the `ios-signing` environment protection rule before adding
      real secrets.
