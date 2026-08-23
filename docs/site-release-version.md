# Site release version

`site-release-version.yml`, in detail. The short version and the caller
pointers live in [the README](../README.md).

## What it does

A static site shows the version of the product it describes — in the
footer, in a hero line — and that number goes stale the moment a release
ships. `site-release-version.yml` keeps it honest from the product side:

1. Reads the product repository's GitHub Releases with the workflow's
   own `GITHUB_TOKEN`. The product repositories are public, so no
   cross-repository secret is needed.
2. Picks, per component, the newest published release whose tag matches
   a glob; strips the glob's literal prefix to get the version.
3. Writes `version.json` at the site root and rewrites the markers in
   every `*.html` under the site.
4. Commits and pushes — only if something changed. Then it stops.

A second run on the same releases changes nothing: no timestamp is
written anywhere, so the hourly schedule does not produce hourly commits.

The workflow is thin: the logic is `actions/site-release-version/sync.py`,
and the workflow fetches that action from the same commit the workflow
file itself came from.

## How the commit reaches the live site

The sites deploy through **Cloudflare Workers Builds** (Git integration):
Cloudflare's GitHub App is installed on each site repository, watches
`main`, and runs `npx wrangler deploy` on every push. No deploy step
lives in GitHub Actions and no Cloudflare credential lives in GitHub.

That still works for the bot's commit. A commit pushed with
`GITHUB_TOKEN` never triggers another **workflow** — GitHub's guard
against recursive runs — so nothing in `.github/workflows` of the site
will fire for `chore(site): sync release version …`. But the guard
suppresses workflow triggers only. The push webhook still goes out to
every app and integration subscribed to the repository, Cloudflare's
GitHub App included, so Workers Builds picks the commit up like any
other. The sync commits; Cloudflare deploys.

`just deploy` in each site repository remains as the manual path — a
local `npx wrangler deploy` for when Cloudflare's build is broken or a
change has to go out without a merge.

## Consumer

One file in the site repository, run hourly:

```yaml
name: Release version
on:
  schedule:
    - cron: '17 * * * *'
  workflow_dispatch:
  push:
    branches: [main]
    paths: ['.github/workflows/release-version.yml']
concurrency:
  group: release-version
  cancel-in-progress: false
permissions:
  contents: write
jobs:
  sync:
    uses: privacykey/gh-workflows/.github/workflows/site-release-version.yml@v1
    with:
      repo: privacykey/privacycommand
      tags: app=v*
```

No `secrets:` block: the workflow needs nothing beyond the job's own
`GITHUB_TOKEN`, which `permissions: contents: write` grants.

The `push` trigger, limited to the workflow's own file, means an edit to
the caller is exercised once against real input when it lands. The `17`
in the cron is deliberate: on-the-hour schedules queue behind everyone
else's.

### `.assetsignore`

The workflow checks this repository out into `.gh-workflows/` inside the
site checkout — a local composite action has to live under the workspace,
there is no other place to put it. The commit step stages `version.json`
and modified tracked files only, so `.gh-workflows/` never reaches the
commit, and Cloudflare builds from the commit, not from the runner's
working tree. The site's `.assetsignore` lists `.gh-workflows/` anyway,
as a belt-and-braces measure, alongside `.git/`: wrangler has no default
excludes — the asset walker is a plain recursive `readdir` filtered only
by `.assetsignore` — so a deploy from a local clone uploads the `.git`
directory unless it is listed.

### Inputs of `site-release-version.yml`

| Input | Default | Meaning |
|---|---|---|
| `repo` | — | `owner/name` of the product repository to read releases from |
| `tags` | `app=v*` | Comma-separated `NAME=GLOB`. One entry per independently versioned component; the version is the tag minus the glob's literal prefix |
| `include-prereleases` | `false` | Let a prerelease win when it is the newest match |

No secrets.

## Markers

The sync touches only elements carrying one of three attributes.
Attribute order within the tag does not matter; everything else in the
page is left alone.

| Marker | What is rewritten |
|---|---|
| `<span data-release="NAME">v0.1.5</span>` | Inner text → `v` + version |
| `<a data-release-link="NAME" href="…">` | `href` → the release page (added if absent) |
| `<time data-release-date="NAME" datetime="…">8 Aug 2026</time>` | `datetime` → `YYYY-MM-DD`; inner text → `8 Aug 2026` |

`NAME` is a component from `tags`. A component whose glob matches no
published release is reported with a `::notice` and its markup is left
exactly as it was — so a site can carry markers for a component that has
not shipped yet (they keep whatever placeholder text they were written
with). A marker naming a component that is not in `tags` gets the same
notice. Drafts are always skipped; prereleases unless enabled.

A footer line, seeded with the current values so the page is right even
before the first run:

```html
© 2026 privacykey ·
<a data-release-link="app" href="https://github.com/privacykey/privacycommand/releases/tag/v0.1.5"><span data-release="app">v0.1.5</span></a>
· made by …
```

## `version.json`

Written at the site root, served with the site, and the only file the
sync creates. No generated-at field, on purpose — it must change only
when a release does.

```json
{
  "source": "privacykey/mantis",
  "components": {
    "cli": {
      "tag": "cli-v0.2.0",
      "version": "0.2.0",
      "url": "https://github.com/privacykey/mantis/releases/tag/cli-v0.2.0",
      "published_at": "2026-08-08T15:24:33Z"
    }
  }
}
```

Components without a matching release are absent from `components`.
Order follows the `tags` input.

## Cloudflare side

Each site repository carries a `wrangler.jsonc` naming its Worker, with
`assets.directory` at the repository root, and is connected in the
Cloudflare dashboard: Workers & Pages → the Worker → Settings → Builds →
Connect to Git — production branch `main`, no build command, deploy
command `npx wrangler deploy`, root `/`. Wrangler reads the name and the
assets directory from the config, so the deploy command takes no flags.
Nothing about Cloudflare is configured in GitHub.

## Things to know

- **Scheduled workflows switch off after 60 days without a commit.**
  GitHub disables `schedule` triggers in a repository with no activity
  for 60 days and emails the owner. A site that ships nothing for two
  months stops syncing until someone re-enables the workflow from the
  Actions tab or pushes a commit. The sync's own commits count as
  activity, so a product that releases at least every two months keeps
  its site alive by itself.
- **The product repository's token is not needed.** `GITHUB_TOKEN` of the
  site repository can read any public repository's releases. If a
  product went private the sync would fail with a 404 and write nothing.
- **Nothing is written on API failure.** A non-200 from the releases
  endpoint, including an exhausted rate limit, fails the sync before the
  first file is touched; the previous values stay in place.
- **An unchanged run costs one API call** and a few seconds of runner
  time; nothing is committed, so Cloudflare builds nothing.

## Release ordering

A consumer gets a change here only when `v1` moves. The order is:

1. Merge here, to `main`.
2. Tag the next version and move `v1` to the same commit.
3. Merge the site pull requests. Their first scheduled run is at most an
   hour away; dispatch by hand to see it sooner.
