#!/usr/bin/env node
// Regenerates one account's status artefacts from its own status.json:
//   badges/<repo>.json   shields /endpoint payloads (public + listed only)
//   STATUS.md            the uncollapsed link target every badge points at
//   <target>.md          the collapsed section, between the STATUS markers
//
// Each account owns its own hub, so a privacykey badge is served from a
// privacykey repo and no credential ever has to reach across identities.
// Tier definitions live here rather than in each hub, so three copies of the
// same promise can't drift apart.
//
//   node build.mjs --hub <dir>                     write
//   node build.mjs --hub <dir> --check             verify only
//   node build.mjs --hub <dir> --aggregate a/b,c/d also pull in other hubs
//
// --aggregate fetches other hubs' status.json over plain HTTPS. It needs no
// token: every hub lives in a public repo and each already withholds its
// private repos, so aggregating cannot surface anything not already published.

import { readFileSync, writeFileSync, mkdirSync, rmSync, existsSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = dirname(fileURLToPath(import.meta.url))
const arg = (name) => {
  const i = process.argv.indexOf(name)
  return i === -1 ? null : process.argv[i + 1]
}
const HUB = arg('--hub') ?? process.cwd()
const CHECK = process.argv.includes('--check')
const AGGREGATE = (arg('--aggregate') ?? '').split(',').map((s) => s.trim()).filter(Boolean)
const TARGET = arg('--target') ?? 'README.md'
// Collapsed on a personal profile, where this is one section among many.
// Expanded on an org profile, where the project list IS the page.
const COLLAPSED = arg('--collapsed') !== 'false'

const die = (m) => { console.error(`✗ ${m}`); process.exit(1) }

const { tiers, groups } = JSON.parse(readFileSync(join(HERE, 'tiers.json'), 'utf8'))
const hub = JSON.parse(readFileSync(join(HUB, 'status.json'), 'utf8'))

if (!/^\d{4}-\d{2}-\d{2}$/.test(hub.reviewed ?? '')) die('status.json: "reviewed" must be YYYY-MM-DD')
if (!hub.owner) die('status.json: "owner" is required')

const DISTRIBUTIONS = ['open-source', 'appstore-closed', 'public-pending', 'private']

const load = (owner, repos, source) => {
  const out = []
  for (const [repo, r] of Object.entries(repos)) {
    const full = `${owner}/${repo}`
    if (!tiers[r.tier]) die(`${full}: unknown tier "${r.tier}"`)
    if (!groups[r.group]) die(`${full}: unknown group "${r.group}"`)
    if (!DISTRIBUTIONS.includes(r.distribution)) die(`${full}: bad distribution "${r.distribution}"`)
    if (typeof r.public !== 'boolean' || typeof r.listed !== 'boolean') die(`${full}: "public" and "listed" must be booleans`)
    // A hub lives in a PUBLIC repo, so status.json is browsable by anyone. An
    // earlier version tracked private repos here and withheld them from the
    // rendered output — but the source file itself named 25 unreleased
    // projects. Withholding a private repo from the badges is not enough; it
    // must not be in the file at all.
    if (!r.public) die(`${full}: private repos must not appear in a public hub's status.json — remove the entry`)
    if (r.listed && !r.public) die(`${full}: listed:true but public:false`)
    if (r.tier === 'Fork' && !r.canonical) die(`${full}: Fork requires "canonical"`)
    out.push({ owner, repo, full, source, ...r })
  }
  return out
}

const own = load(hub.owner, hub.repos, null)

// Other hubs contribute their listed repos to the rendered view only. Their
// badges stay theirs — nothing here writes into another account's namespace.
const foreign = []
const RAW = process.env.STATUS_RAW_BASE ?? 'https://raw.githubusercontent.com'
for (const ref of AGGREGATE) {
  const url = `${RAW}/${ref}/main/status.json`
  const res = await fetch(url)
  if (!res.ok) die(`--aggregate ${ref}: ${url} returned HTTP ${res.status}`)
  const other = await res.json()
  foreign.push(...load(other.owner, other.repos, ref).filter((e) => e.listed))
}

const byTier = (a, b) => tiers[a.tier].order - tiers[b.tier].order || a.repo.localeCompare(b.repo)
const ownListed = own.filter((e) => e.listed)
const allListed = [...ownListed, ...foreign]

// Badges for this account's public, listed repos only. The badges directory is
// browsable, so one file per repo would publish an index of unreleased work.
const outputs = new Map()
for (const e of ownListed) {
  outputs.set(`badges/${e.repo}.json`, JSON.stringify({
    schemaVersion: 1, label: 'status', message: e.tier,
    color: tiers[e.tier].color, style: 'flat', cacheSeconds: 3600,
  }, null, 2) + '\n')
}

// ---------------------------------------------------------------- STATUS.md
// Repo names are unique within an account, so a bare `#<repo>` anchor is
// unambiguous here — the collision risk that forced owner-qualified anchors
// under a single combined hub doesn't exist once each account owns its own.
let md = `# Project status\n\n`
  + `What I promise for each ${hub.owner} project, and what I don't. Every repo's\n`
  + `status badge links here.\n\n`
  + `**Tiers last reviewed: ${hub.reviewed}.** Set by hand — it's when I last actually\n`
  + `looked, not when a script last ran.\n\n`
  + `| Tier | What it means |\n| --- | --- |\n`
  + Object.entries(tiers).sort((a, b) => a[1].order - b[1].order)
      .filter(([n]) => own.some((e) => e.tier === n))
      .map(([n, t]) => `| ${t.emoji} **${n}** | ${t.promise} |`).join('\n')
  + `\n\nPrivate and pre-announcement projects aren't listed here.\n\n---\n\n`

for (const [gk, g] of Object.entries(groups).sort((a, b) => a[1].order - b[1].order)) {
  const inGroup = ownListed.filter((e) => e.group === gk).sort(byTier)
  if (!inGroup.length) continue
  md += `## ${g.title}\n\n`
  for (const e of inGroup) {
    const t = tiers[e.tier]
    md += `### ${e.repo}\n\n${t.emoji} **${e.tier}** — ${t.oneLiner}\n\n${t.promise}\n\n`
    if (e.distribution === 'appstore-closed') md += `_Ships on the App Store; source is closed._\n\n`
    if (e.submissions) md += `_Submissions are ${e.submissions}._\n\n`
    if (e.seekingMaintainer) md += `**Open to a new maintainer** — get in touch.\n\n`
    if (e.note) md += `${e.note}\n\n`
    md += `<https://github.com/${e.full}>\n\n`
  }
}
outputs.set('STATUS.md', md.trimEnd() + '\n')

// ---------------------------------------------------------------- rendered region
// No GitHub alerts in here — they don't render inside a <details> block.
const scope = AGGREGATE.length ? 'every project I maintain' : `every ${hub.owner} project`
let region = COLLAPSED
  ? `<details>\n  <summary><b>📋 Project status</b> — what I promise for ${scope} (reviewed ${hub.reviewed})</summary>\n  <p>\n\n`
  : `## Projects\n\nWhat I promise for ${scope}, and what I don't. Reviewed ${hub.reviewed}.\n\n`
region += `Each badge links to the full promise. Private and pre-announcement projects aren't listed.\n\n`
  + `| | Tier | What it means |\n| - | - | - |\n`
  + Object.entries(tiers).sort((a, b) => a[1].order - b[1].order)
      .filter(([n]) => allListed.some((e) => e.tier === n))
      .map(([n, t]) => `| ${t.emoji} | **${n}** | ${t.oneLiner} |`).join('\n')
  + `\n\n`

for (const [gk, g] of Object.entries(groups).sort((a, b) => a[1].order - b[1].order)) {
  const inGroup = allListed.filter((e) => e.group === gk).sort(byTier)
  if (!inGroup.length) continue
  region += `**${g.title}**\n\n| Project | Status | |\n| - | - | - |\n`
  for (const e of inGroup) {
    const extra = [
      e.distribution === 'appstore-closed' ? 'App Store, source closed' : '',
      e.seekingMaintainer ? 'maintainer wanted' : '',
      e.submissions === 'open' ? 'submissions open' : '',
    ].filter(Boolean).join(' · ')
    region += `| [${e.repo}](https://github.com/${e.full}) | ${tiers[e.tier].emoji} ${e.tier} | ${extra} |\n`
  }
  region += `\n`
}
region += COLLAPSED ? `  </p>\n</details>` : `See [STATUS.md](STATUS.md) for what each tier promises.`

const START = '<!-- STATUS:START -->'
const END = '<!-- STATUS:END -->'
const targetPath = join(HUB, TARGET)
if (!existsSync(targetPath)) die(`${TARGET} not found in ${HUB}`)
const doc = readFileSync(targetPath, 'utf8')
if (!doc.includes(START) || !doc.includes(END)) die(`${TARGET} is missing the ${START} / ${END} markers`)
outputs.set(TARGET, doc.slice(0, doc.indexOf(START) + START.length) + `\n${region}\n` + doc.slice(doc.indexOf(END)))

// ---------------------------------------------------------------- write / check
if (CHECK) {
  const stale = [...outputs].filter(([p, want]) => {
    const abs = join(HUB, p)
    return !existsSync(abs) || readFileSync(abs, 'utf8') !== want
  }).map(([p]) => p)
  if (stale.length) {
    console.error(`✗ ${stale.length} generated file(s) stale or hand-edited:`)
    stale.forEach((p) => console.error(`    ${p}`))
    process.exit(1)
  }
  console.log(`✓ ${hub.owner}: all ${outputs.size} generated files match status.json`)
  process.exit(0)
}

// Rebuilt from scratch so a repo going private drops its badge rather than
// leaving a stale public one behind.
const badgeDir = join(HUB, 'badges')
if (existsSync(badgeDir)) rmSync(badgeDir, { recursive: true })
for (const [p, content] of outputs) {
  const abs = join(HUB, p)
  mkdirSync(dirname(abs), { recursive: true })
  writeFileSync(abs, content)
}

const counts = {}
for (const e of own) counts[e.tier] = (counts[e.tier] ?? 0) + 1
console.log(`✓ ${hub.owner}: ${own.length} repos, ${ownListed.length} listed`
  + (foreign.length ? `, +${foreign.length} aggregated` : ''))
console.log(`  ${Object.entries(counts).sort((a, b) => tiers[a[0]].order - tiers[b[0]].order)
  .map(([t, n]) => `${tiers[t].emoji} ${t} ${n}`).join('  ')}`)
