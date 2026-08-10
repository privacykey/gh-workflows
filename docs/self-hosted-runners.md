# Self-hosted runners

Both macOS workflows and `ios-release.yml` default to GitHub-hosted images.
Pointing one at self-hosted hardware is an explicit, per-consumer opt-in —
pass a JSON array of labels:

```yaml
    with:
      runner: '["self-hosted", "macOS", "ARM64", "repo-ci"]'
```

**The rule the workflows enforce: self-hosted runners are for private
repositories only.**

The reasoning is short. A self-hosted runner is a persistent machine that is
not wiped between jobs, so a job that runs on it can read whatever the
previous job left, plus whatever else that account can reach. A public
repository accepts pull requests from anyone, and a pull request is a
proposal to run the author's code. Meanwhile Actions minutes for public
repositories are free — so a public repository on owned hardware takes on
the entire risk in exchange for nothing.

Two independent gates enforce it:

1. **Job-level `if:`** — rejects fork pull requests *before a runner is
   allocated*, so fork code never reaches the host at all.
2. **`actions/assert-trusted-runner`** — the first step of every job, before
   checkout. Re-checks visibility and fork status on the runner itself and
   fails the job if either is wrong. On a GitHub-hosted runner it is a no-op,
   which is what lets it live in a shared workflow.

Visibility is read from the event payload and **fails closed**: if it cannot
be determined, the job stops.

Two things the gates deliberately do *not* do:

- They do not make a self-hosted runner safe for code from people you don't
  trust. Anyone who can push a branch to a private repository can run code on
  the host on purpose — the gates keep out strangers, not collaborators. Keep
  the runner account free of credentials and personal data regardless.
- They do not replace the account boundary. `repo-ci` and `release-signing`
  are labels; labels route jobs, they don't isolate them. Separate macOS
  accounts do. A `repo-ci` runner must never hold a distribution certificate.

Consumers on the fleet also inherit two behaviour changes, both automatic:
`maxim-lobanov/setup-xcode` is skipped (it re-points the *machine's* selected
Xcode, which on a shared host would reach into every other repository's
builds), and `xcodegen` is expected to be preinstalled rather than
`brew install`ed per job. The workflow checks for it and fails with a clear
message if it is missing.

`actions/assert-trusted-runner` is also usable on its own, as the first step
of a job in a workflow that is not one of the reusable ones here — that is
how most consumer repos use it:

```yaml
      - uses: privacykey/gh-workflows/actions/assert-trusted-runner@v1
```
