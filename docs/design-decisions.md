# Design decisions (short version)

- **Tests before secrets.** The `test` job has no secrets and no
  environment; the `macos-signing` approval gate sits between it and the
  `release` job. `ios-release.yml` has the same shape, with `validate`
  before the `ios-signing` gate.
- **Fail closed, not degraded.** No graceful-degradation ladder (no cert
  → unsigned; no ASC key → signed-not-notarized): for DMG-shipping
  consumer apps, a half-signed public release is worse than a failed run.
  All signing secrets on `macos-sparkle-release.yml` are `required`.
- **No nested Sparkle re-sign step.** The xcodebuild archive/export path
  signs nested code (Sparkle's XPC services included) correctly on its
  own; a separate re-sign step is only needed for hand-assembled .app
  bundles, which this pipeline does not support.
- **Build scripts stay in consumer repos** (local dry-runs), the
  orchestration lives here. Appcast generation is built in, including
  key-format validation.
- **Composite actions cannot run `post:` steps**, so the two that stage
  signing material (`setup-apple-keychain`, `write-asc-api-key`) require
  the calling job to include an `if: always()` cleanup step. The reusable
  workflows here already do; a hand-written caller must.
- **Each account owns its own status hub.** `project-status.yml` is called
  from a hub repo with a token scoped to that account only, so a
  privacykey badge is served from a privacykey repo and no credential
  reaches across identities. Tier definitions live in
  `actions/project-status/tiers.json` rather than in each hub, so three
  copies of the same promise cannot drift apart.
