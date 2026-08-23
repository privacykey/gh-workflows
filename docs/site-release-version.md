# Site release version and deploy

`site-release-version.yml` and `site-deploy.yml`, in detail. The short
version and the caller pointers live in [the README](../README.md).

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
4. Commits and pushes — only if something changed.
5. Deploys with the site's own `just deploy`, if the Cloudflare secrets
   are present and either something changed or the run was dispatched
   by hand.

A second run on the same releases changes nothing: no timestamp is
written anywhere, so the hourly schedule does not produce hourly commits.

`site-deploy.yml` is the ordinary deploy for an ordinary merge to `main`.
Both are thin: the sync logic is `actions/site-release-version/sync.py`,
the deploy is `actions/site-deploy`, and both reusable workflows fetch
those actions from the same commit the workflow file itself came from.

## Why the sync deploys itself

A commit pushed with `GITHUB_TOKEN` never triggers another workflow —
that is GitHub's guard against recursive runs. So the bot's
`chore(site): sync release version …` commit on `main` will **not** fire
the site's push-to-main `deploy.yml`. If the sync did not deploy, the
repository would carry the new version and the live site would not. The
deploy step inside `site-release-version.yml` is what closes that gap;
`site-deploy.yml` covers every human merge.

## Consumer

Two files in the site repository. The version sync, hourly:

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
    secrets: inherit
```

And the deploy on merge:

```yaml
name: Deploy
on:
  push:
    branches: [main]
    paths-ignore: ['.github/**', '*.md']
  workflow_dispatch:
concurrency:
  group: deploy
  cancel-in-progress: false
permissions:
  contents: read
jobs:
  deploy:
    uses: privacykey/gh-workflows/.github/workflows/site-deploy.yml@v1
    secrets: inherit
```

`secrets: inherit` is what lets the reusable workflow see
`CLOUDFLARE_API_TOKEN` and `CLOUDFLARE_ACCOUNT_ID` when they are
organisation secrets; without them both workflows still succeed and print
a `::notice` saying the deploy was skipped.

The `push` trigger on the sync, limited to its own file, means an edit to
the caller is exercised once against real input when it lands. The `17`
in the cron is deliberate: on-the-hour schedules queue behind everyone
else's.

### `.assetsignore`

Both workflows check this repository out into `.gh-workflows/` inside the
site checkout — a local composite action has to live under the workspace,
there is no other place to put it. The site's `.assetsignore` must
therefore contain:

```
.gh-workflows/
```

or wrangler's `--assets .` uploads the action source as part of the site.
While there, list `.git/` too: wrangler has no default excludes — the
asset walker is a plain recursive `readdir` filtered only by
`.assetsignore` — so a deploy from any clone uploads the `.git` directory
unless it is listed. The commit step stages `version.json` and modified
tracked files only, so `.gh-workflows/` never reaches the commit either.

### Inputs of `site-release-version.yml`

| Input | Default | Meaning |
|---|---|---|
| `repo` | — | `owner/name` of the product repository to read releases from |
| `tags` | `app=v*` | Comma-separated `NAME=GLOB`. One entry per independently versioned component; the version is the tag minus the glob's literal prefix |
| `include-prereleases` | `false` | Let a prerelease win when it is the newest match |
| `deploy` | `true` | Deploy after a change or on dispatch. `false` stops after the commit |

Secrets: `CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`, both optional.
`site-deploy.yml` takes no inputs and the same two optional secrets.

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

## Cloudflare secrets

Organisation secrets, scoped to the website repositories only:

| Secret | Value |
|---|---|
| `CLOUDFLARE_API_TOKEN` | An API token with **Account → Workers Scripts → Edit** and **Account → Account Settings → Read**, restricted to the one account |
| `CLOUDFLARE_ACCOUNT_ID` | The account id from the Cloudflare dashboard sidebar |

Both names are what wrangler reads from the environment, which is why
`actions/site-deploy` sets exactly those and otherwise just runs the
site's `just deploy` recipe. Until they exist, every run ends with
`Cloudflare secrets not set — skipped deploy; run just deploy locally`
and a green tick: the version commit still lands, the site is deployed
by hand.

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
- **Deploy never runs on an unchanged scheduled run.** Only a change or a
  manual dispatch deploys, so an hourly schedule costs one API call and
  a few seconds of runner time.

## Release ordering

A new consumer needs the workflow and the actions on a tag before its
`@v1` pin resolves. The order is:

1. Merge here, to `main`.
2. Tag the next minor (`v1.5.0`, since two workflows and two actions are
   new) and move `v1` to the same commit.
3. Merge the site pull requests that call `site-release-version.yml@v1`
   and `site-deploy.yml@v1`. Their first scheduled run is at most an hour
   away; dispatch by hand to see it sooner.
4. Add the two Cloudflare secrets when ready. Nothing needs to change in
   any workflow; the next changed run deploys.
