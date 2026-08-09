# gh-workflows

Reusable GitHub Actions workflows and composite actions for the macOS and iOS
app repositories across my privacykey and AdamXweb accounts. One pipeline, one
place to fix it.

[![Project status](https://img.shields.io/endpoint?url=https%3A%2F%2Fraw.githubusercontent.com%2Fprivacykey%2F.github%2Fmain%2Fbadges%2Fgh-workflows.json)](https://github.com/privacykey/.github/blob/main/STATUS.md#gh-workflows) [![Licence](https://img.shields.io/github/license/privacykey/gh-workflows?label=licence)](LICENSE)

<!-- disclosure:start -->
> [!WARNING]
> **Project status.** The badge above is generated from [the privacykey status list](https://github.com/privacykey/.github/blob/main/STATUS.md), which says what I promise for this project and every other one.
<!-- disclosure:end -->

---

Nothing here is installed or run on its own. Other repositories call into it,
so quiet is the intended state: a shared workflow nobody has touched in
months is one that is still doing its job. Changes land here only when a
consumer needs something new, or when a pin needs bumping.

## What's here

| Path | What it is |
|---|---|
| `.github/workflows/macos-sparkle-release.yml` | Tag-triggered macOS release: test gate → sign → notarize → DMG → appcast → GitHub Release → optional Homebrew cask PR against the tap |
| `.github/workflows/macos-app-ci.yml` | Push/PR CI for macOS apps: unsigned build + tests, zero secrets |
| `.github/workflows/ios-release.yml` | iOS archive/TestFlight: unsigned validate gate → signed archive → .ipa + dSYM artefacts → optional `altool` upload; two signing modes (self-hosted runner keychain, or hosted cert import) |
| `.github/workflows/project-status.yml` | Regenerates one account's status badges, `STATUS.md` and profile section from its own `status.json`, then reports what has drifted |
| `actions/assert-trusted-runner` | Fail-closed guard: on a self-hosted runner, refuses to continue unless the repository is private and the pull request is not from a fork |
| `actions/setup-apple-keychain` | Ephemeral keychain + certificate import (`-T codesign`, `set-key-partition-list`, masked password) |
| `actions/write-asc-api-key` | Stages the App Store Connect `.p8` as a mode-600 file |
| `actions/install-sparkle-cli` | Pinned Sparkle release tarball with SHA-256 verification |
| `actions/publish-gh-pages-file` | Worktree-based single-file publish to a branch (appcast.xml → gh-pages) |
| `actions/project-status` | The Node scripts and canonical tier definitions behind `project-status.yml` |

## What consumes this

Six repositories call in today — that is a code search across the privacykey,
adamXbot and AdamXweb accounts, public and private repositories both. The two
public ones:

| Repository | Uses |
|---|---|
| [privacykey/privacycommand](https://github.com/privacykey/privacycommand) | `macos-sparkle-release.yml@v1`, `macos-app-ci.yml@v1` |
| [privacykey/.github](https://github.com/privacykey/.github) | `project-status.yml@v1` |

The other four are private and are not linked here. Between them they use
`ios-release.yml@v1` (one repo) and `assert-trusted-runner@v1` (all four —
across nine workflows in total, since one repo calls the guard from six).

## How a consumer uses it

A caller is thin by design — the pipeline lives here, the build script and
the version number stay in the consumer repo. A macOS `release.yml` is about
fifteen lines:

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

`secrets: inherit` is not optional advice when `SPARKLE_PRIVATE_KEY` lives in
the `macos-signing` environment: explicitly mapped secrets resolve in the
caller's context, which has no environment, and come back empty.

- **macOS** — inputs, the release-script env contract, the Homebrew cask PR
  flow, the gen-1 → gen-3 secret rename and the migration sequence:
  [docs/macos-release.md](docs/macos-release.md).
- **iOS** — the two signing modes, fastlane mode, secrets by mode, inputs:
  [docs/ios-release.md](docs/ios-release.md).
- **Self-hosted runners** — how to opt in, and the private-repositories-only
  rule the workflows enforce:
  [docs/self-hosted-runners.md](docs/self-hosted-runners.md).
- **Project status** — called from an account's own hub repo, with a
  read-only token scoped to that account:

  ```yaml
  jobs:
    status:
      uses: privacykey/gh-workflows/.github/workflows/project-status.yml@v1
      secrets:
        status-token: ${{ secrets.STATUS_TOKEN }}
  ```

## The version contract

- **Consumers pin by tag.** `...@v1` is the moving major tag and is what
  every consumer above uses. Exact tags `v1.0.0`, `v1.0.1`, `v1.0.2`,
  `v1.1.0` and `v1.2.0` also exist. There are no GitHub Releases — the tags
  are the whole contract.
- **`v1` is moved deliberately**, as the release action. It currently points
  at the same commit as `v1.2.0`.
- **An exact pin is not a full freeze.** Inside these workflows the composite
  actions are referenced as `privacykey/gh-workflows/actions/<name>@v1`, and
  GitHub resolves those refs at run time independently of the tag the
  *workflow* was pinned at. A caller on `v1.1.0` therefore gets that
  workflow, but whatever `v1` currently points at for the actions it calls.
  A relative path cannot be used instead, because the job's checkout is the
  consumer repo, not this one.
- **Third-party actions are SHA-pinned** with a version comment — currently
  `actions/checkout`, `actions/upload-artifact`, `maxim-lobanov/setup-xcode`,
  `softprops/action-gh-release` and `ruby/setup-ruby`. The digests live in
  the workflow files rather than being repeated here, so they cannot drift
  out of sync with what actually runs. `project-status.yml` is the exception:
  it runs on `ubuntu-latest` and uses floating `actions/checkout@v4` /
  `actions/setup-node@v4`.
- **The Sparkle CLI** is pinned to version `2.9.5`, and its tarball digest is
  verified before extraction. Bump the `sparkle_version` and `sparkle_sha256`
  inputs together or the check fails, by design.

## Changing it safely

The blast radius of an edit here is every consumer above, and it lands the
moment `v1` moves — not when `main` moves. Pushing to `main` changes nothing
for consumers, because both their pins and this repo's internal action
references resolve through tags. So merge to `main` freely, then move `v1` as
a separate, deliberate act once you are satisfied. Before that:

- Run `just lint` — `actionlint` over the workflows plus a YAML parse of
  every `actions/*/action.yml`. `actionlint` has to be installed locally,
  because there is no CI in this repository: every workflow here is
  `workflow_call`-only, so none of them can run on a push.
- Removing or renaming an input is a breaking change for a caller pinned at
  `@v1`, and it will break at run time rather than at merge time. The
  deprecated `macos_runner` input is the pattern to copy: keep the old name
  working, document the replacement, migrate callers, remove later.
- Adding a `secrets:` entry to `macos-app-ci.yml` is out of bounds. It
  declares none and must never gain any — that is what makes it safe to run
  on pull requests.
- Design rationale for the current shape:
  [docs/design-decisions.md](docs/design-decisions.md).

## Licence

Apache-2.0. See [LICENSE](LICENSE) and [NOTICE](NOTICE).
