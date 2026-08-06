<!--
README patch for privacykey/gh-workflows.

1. Add this row to the Contents table (after the macos-app-ci.yml row):

| `.github/workflows/ios-release.yml` | iOS archive/TestFlight: unsigned validate gate → signed archive → .ipa + dSYM artefacts → optional `altool` TestFlight upload; dual signing modes (self-hosted runner keychain / hosted cert import) |

2. Insert everything below as a new top-level section after
   "## Using the CI workflow" and before "## Secret names: gen-1 → gen-3
   mapping".
-->

## Using the iOS release workflow

`ios-release.yml` runs a secret-free unsigned Release build gate, then a
signed archive → `.ipa` export → IPA + dSYM artefacts → optional
TestFlight upload. It is the iOS sibling of
`macos-sparkle-release.yml`, with one structural difference: iOS has
**two signing modes**, selected by the required `signing` input.

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

### Consumer: self-hosted (`runner-keychain`)

Keeps PR/push release validation and the manually-dispatched signed
archive in one workflow:

```yaml
name: iOS Release validation
on:
  pull_request:
    paths: ["MyApp/**", "project.yml",
            "Scripts/ExportOptions.plist", ".github/workflows/ios-release.yml"]
  push:
    branches: [main]
    paths: ["MyApp/**", "project.yml",
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
      xcodeproj: MyApp.xcodeproj
      scheme: MyApp
      uses_xcodegen: true
      signing: runner-keychain
      runner: '["self-hosted", "macOS", "ARM64"]'
      export_options_path: Scripts/ExportOptions.plist
      signed_archive: ${{ github.event_name == 'workflow_dispatch' && inputs.signed_archive }}
      # upload_to_testflight: true   # needs APPLE_API_KEY_ID + APPLE_API_ISSUER (IDs only)
```

No `secrets:` block at all while `upload_to_testflight` is off — the
self-hosted model keeps zero Apple secrets in GitHub.

### Consumer: hosted (`import`)

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
      xcodeproj: MyApp.xcodeproj
      scheme: MyApp
      uses_xcodegen: true
      signing: import
      runner: macos-15                # pick an image whose Xcode has the SDK you pin
      xcode_version: latest-stable    # or a version spec if the project pins an SDK
      team_id: ${{ vars.APPLE_TEAM_ID }}   # repo variable: the team stays out of committed files
      spm_resolved_path: MyApp.xcodeproj/project.xcworkspace/xcshareddata/swiftpm/Package.resolved
      upload_to_testflight: ${{ inputs.upload_to_testflight }}
    secrets: inherit
```

With `spm_resolved_path` set, every `xcodebuild` gets
`-onlyUsePackageVersionsFromResolvedFile` and the committed pin file is
drift-checked after `xcodegen generate` and after the build — resolution
may fetch, but it may not move off the committed pins.

No `export_options_path` here: the workflow generates a minimal
automatic-signing plist (`method` + `teamID` + `destination: export`).

### Fastlane mode (`use_fastlane: true`)

Orthogonal to the signing mode: the repo's fastlane lanes replace the
inline `xcodebuild` invocations, and everything around them — preflight,
xcodegen, the SPM drift gates, the `ios-signing` environment gate,
keychain/ASC-key setup, artefact uploads, the TestFlight upload, and
signing-material cleanup — is identical in both modes. With
`use_fastlane: false` (the default) nothing changes.

Repo prerequisites:

- Committed `Gemfile` + `Gemfile.lock` containing the `fastlane` gem —
  Ruby is set up with `ruby/setup-ruby` (`bundler-cache: true`), which
  installs from the lockfile.
- A Ruby version declared where `ruby/setup-ruby` can find it:
  `.ruby-version`, `.tool-versions`, or the Gemfile's `ruby` line.
- `fastlane/Fastfile` defining both lanes.

What each job runs:

- **validate** — `bundle exec fastlane <fastlane_test_lane>` (default
  lane name `test`) replaces the unsigned Release build and the
  `run_tests` / `test_script` invocation; those inputs apply to the
  non-fastlane path only. If the lane writes
  `build/TestResults/Tests.xcresult`, that bundle is uploaded as the
  test artefact.
- **archive** — `bundle exec fastlane <fastlane_archive_lane>` (default
  lane name `archive`) replaces the `xcodebuild archive` /
  `-exportArchive` steps.

Archive lane contract:

| Direction | Contract |
|---|---|
| reads (env) | `KEYCHAIN_PATH`, `APPLE_SIGNING_IDENTITY`, `APPLE_API_KEY_PATH`, `APPLE_API_KEY_ID`, `APPLE_API_ISSUER`, `EXPORT_METHOD`, `BUILD_NUMBER` |
| writes | `build/export/<name>.ipa` — verified, uploaded as the IPA artefact, and what the TestFlight upload sends |
| writes | `build/<scheme>.xcarchive` — dSYMs are zipped from it (a missing archive degrades to the no-dSYMs warning) |

Env notes: `KEYCHAIN_PATH` and `APPLE_API_KEY_PATH` are empty in
`runner-keychain` mode (the signing material already lives on the
runner); `BUILD_NUMBER` is empty with `build_number: project`, meaning
leave `CURRENT_PROJECT_VERSION` alone. The export-options resolution
still runs, but its plist is not passed to the lane — the lane owns its
export options and receives the `export_method` input as
`EXPORT_METHOD`. With `spm_resolved_path` set, the drift gates apply to
the lanes too: a lane that moves the committed pins fails the
post-archive check.

### Secrets by mode (names only)

| Secret | `runner-keychain` | `import` |
|---|---|---|
| `APPLE_CERTIFICATE` (Apple Distribution `.p12`, base64) | never read | required |
| `APPLE_CERTIFICATE_PASSWORD` | never read | required |
| `APPLE_API_KEY` (`.p8` PEM) | never read — the `.p8` lives on the runner | required |
| `APPLE_API_KEY_ID` | only when `upload_to_testflight` | required |
| `APPLE_API_ISSUER` | only when `upload_to_testflight` | required |
| `APPLE_SIGNING_IDENTITY` (common-name string) | only exported to the fastlane archive lane; optional | only exported to the fastlane archive lane; optional |

All are declared `required: false` at the `workflow_call` level and
enforced at runtime per mode, with fail-closed errors. Scope them to the
`ios-signing` environment and call with `secrets: inherit` (same
resolution rule as `macos-signing` — environment secrets only resolve
inside the job that declares the environment).

The `archive` job declares `environment: ios-signing`; it is auto-created
(unprotected) on first run — add a required-reviewers rule so signing
pauses for human approval. The `validate` job runs before that gate and
reads no secrets.

### Upload tooling (why altool, and the exit ramp)

The upload is `xcrun altool --upload-app -f <ipa> -t ios --apiKey <id>
--apiIssuer <issuer>` with App Store Connect API-key auth, in both modes
(`import` mode stages the `.p8` for altool via `API_PRIVATE_KEYS_DIR`).
Notes:

- `xcrun notarytool` replaced altool **for notarization only** (a
  macOS/DMG concern); it cannot upload iOS builds and has no role here.
- `altool --upload-app` is Apple-deprecated but still ships and still
  works. The workflow probes `xcrun --find altool` and fails with a
  migration pointer if a future Xcode drops it.
- The exit ramp is ExportOptions `destination: upload` on the
  `-exportArchive` step (or Transporter). It would land here once, behind
  the same inputs — which is why there is no speculative `upload_tool`
  input today.

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
| `build_number` | `auto` | Minutes-since-epoch scheme; `project` leaves `CURRENT_PROJECT_VERSION` alone; integer forces |
| `signed_archive` | `true` | `false` runs only the secret-free validate job |
| `upload_to_testflight` | `false` | `altool --upload-app` with ASC API-key auth |
| `run_tests` / `test_script` | `false` / empty | Validate-job tests + xcresult artefact; default off for repos whose unit tests run in separate CI; non-fastlane path only |
| `use_fastlane` | `false` | Lanes replace the inline `xcodebuild` invocations; see "Fastlane mode" above |
| `fastlane_test_lane` | `test` | Validate-job lane in fastlane mode |
| `fastlane_archive_lane` | `archive` | Archive-job lane in fastlane mode; env/output contract above |
| `spm_resolved_path` | empty | Package.resolved drift gate + `-onlyUsePackageVersionsFromResolvedFile` |
| `ipa_retention_days` | `14` | dSYM artefact is always 365 days |

What the workflow deliberately does **not** do: bump `MARKETING_VERSION`
(versioning stays a local, human act), create App Store Connect records,
or perform first-run capability provisioning (see each repo's runbook).

### Migrating a consumer repo

Repo-specific migration steps live in each consumer repo's migration PR.
