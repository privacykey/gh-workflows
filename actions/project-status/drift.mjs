#!/usr/bin/env node
// Weekly reality check against status.json.
//
// It reports FACTS, not tiers. An earlier version re-derived each repo's whole
// tier from activity signals and flagged 28 of 61 repos — nearly all of them
// false, because the signals can't tell a billing block from an abandoned repo,
// or a reusable workflow from a broken one. A weekly PR full of noise gets
// ignored, and an ignored check is worse than no check.
//
// So this only reports things that are objectively true and worth acting on:
// a URL that doesn't load, a tap serving a stale version, a queue nobody
// answered. Tier suggestions are limited to the two unambiguous directions.
//
// Needs a token that can read all three owners: STATUS_TOKEN in the environment.

import { readFileSync } from 'node:fs'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'

const argOf = (n) => { const i = process.argv.indexOf(n); return i === -1 ? null : process.argv[i + 1] }
const HUB = argOf('--hub') ?? process.cwd()
const TOKEN = process.env.STATUS_TOKEN || process.env.GITHUB_TOKEN
const NOW = Date.now()
const DAY = 86_400_000
const BOT = /\[bot\]$/
const SWEEP = /adopt shared renovate preset|single-source toolchain|migrate release to reusable|strip internal authoring|sha-pin/i

const data = JSON.parse(readFileSync(join(HUB, 'status.json'), 'utf8'))
const OWNER = data.owner

const api = async (path) => {
  const res = await fetch(`https://api.github.com/${path}`, {
    headers: { accept: 'application/vnd.github+json', ...(TOKEN ? { authorization: `Bearer ${TOKEN}` } : {}) },
  })
  if (!res.ok) return { status: res.status, body: null }
  return { status: res.status, body: await res.json() }
}

const probe = async (url) => {
  try {
    const res = await fetch(url, { redirect: 'follow', signal: AbortSignal.timeout(12_000) })
    return res.status
  } catch { return 0 }
}

const findings = []   // { repo, kind, detail }
const suggests = []   // { repo, claimed, suggest, why }
const pinned = []
const unread = []
const add = (repo, kind, detail) => findings.push({ repo, kind, detail })

// ---------------------------------------------------------------- tap index
// Which cask/formula serves which repo, and at what version. A tap that has
// fallen behind its own repo's latest release is the one breakage that silently
// ships an old build to everyone who installs it.
const taps = new Map()
for (const tap of [...new Set([`${data.owner}/homebrew-tap`, 'privacykey/homebrew-tap'])]) {
  for (const dir of ['Casks', 'Formula']) {
    const list = await api(`repos/${tap}/contents/${dir}`)
    for (const f of list.body ?? []) {
      if (!f.name.endsWith('.rb')) continue
      const file = await api(`repos/${tap}/contents/${dir}/${f.name}`)
      if (!file.body?.content) continue
      const src = Buffer.from(file.body.content, 'base64').toString('utf8')
      const version = src.match(/^\s*version\s+"([^"]+)"/m)?.[1]
      const target = src.match(/github\.com\/([\w.-]+\/[\w.-]+)\/releases/i)?.[1]
      if (version && target) taps.set(target.toLowerCase(), { tap, file: `${dir}/${f.name}`, version })
    }
  }
}

// ---------------------------------------------------------------- per repo
{
  const owner = OWNER
  for (const [repo, r] of Object.entries(data.repos)) {
    const full = `${owner}/${repo}`
    if (r.pin) { pinned.push({ full, tier: r.tier, ...r.pin }); continue }
    if (r.tier === 'Archived' || r.tier === 'Fork') continue
    if (repo === '.github' && r.tier === 'Maintained') continue // this hub grades everything but itself
    if (full === 'AdamXweb/AdamXweb') continue

    const meta = await api(`repos/${full}`)
    if (!meta.body) { unread.push(`${full} — HTTP ${meta.status}`); continue }

    // --- hard mismatches against GitHub's own flags ------------------------
    if (meta.body.archived && r.tier !== 'Archived') suggests.push({ repo: full, claimed: r.tier, suggest: 'Archived', why: 'GitHub reports this repo as archived' })
    if (meta.body.fork && r.tier !== 'Fork') suggests.push({ repo: full, claimed: r.tier, suggest: 'Fork', why: 'GitHub reports this repo as a fork' })
    if (meta.body.private === r.public) add(full, 'visibility', `status.json says public: ${r.public}, GitHub says private: ${meta.body.private}`)

    // --- empty repo / no README -------------------------------------------
    if (meta.body.size === 0) { add(full, 'empty', 'the repository has no commits at all'); continue }
    const readme = await api(`repos/${full}/readme`)
    if (!readme.body || readme.body.size < 200) {
      add(full, 'no readme', readme.body ? `README is only ${readme.body.size} bytes` : 'no README at all')
    }

    // --- advertised URLs ---------------------------------------------------
    if (meta.body.homepage) {
      const code = await probe(meta.body.homepage)
      if (code === 0 || code >= 400) {
        add(full, 'dead link', `homepage ${meta.body.homepage} → ${code === 0 ? 'did not resolve' : `HTTP ${code}`}`)
      }
    }

    // --- releases ----------------------------------------------------------
    const rels = await api(`repos/${full}/releases?per_page=20`)
    const all = rels.body ?? []
    const published = all.filter((x) => !x.draft && !x.prerelease)
    const latest = published[0]
    if (!published.length && all.some((x) => x.draft)) {
      add(full, 'draft release', 'the only release is a draft — invisible to everyone, and it creates no tag')
    }

    // --- tap freshness -----------------------------------------------------
    const tapped = taps.get(full.toLowerCase())
    if (tapped && latest) {
      // Tags aren't uniform across the portfolio: v0.1.2, cli-v0.1.6, 0.4.0.
      // Compare the version part only, or every prefixed tag reads as stale.
      const tag = latest.tag_name.match(/(\d[\d.]*)$/)?.[1] ?? latest.tag_name
      if (tapped.version !== tag) {
        const age = Math.round((NOW - Date.parse(latest.published_at)) / DAY)
        add(full, 'stale tap', `${tapped.tap} ${tapped.file} serves ${tapped.version}, but ${latest.tag_name} shipped ${age} days ago`)
      }
    }

    // --- workflow health ---------------------------------------------------
    // startup_failure is a platform/billing state, not a repo state — Actions
    // billing is currently blocked on two of the three owners. And a workflow
    // that only has `workflow_call` triggers always fails when run directly,
    // so it is excluded rather than reported as a fault.
    const wfs = await api(`repos/${full}/actions/workflows`)
    const callable = new Set()
    for (const w of wfs.body?.workflows ?? []) {
      const f = await api(`repos/${full}/contents/${w.path}`)
      if (!f.body?.content) continue
      const src = Buffer.from(f.body.content, 'base64').toString('utf8')
      if (/workflow_call:/.test(src) && !/\bpush:|\bpull_request:|\bschedule:/.test(src)) callable.add(w.id)
    }
    const runs = await api(`repos/${full}/actions/runs?branch=${meta.body.default_branch}&per_page=30`)
    const real = (runs.body?.workflow_runs ?? []).filter(
      (x) => x.conclusion && x.conclusion !== 'startup_failure' && !callable.has(x.workflow_id),
    )
    if (real.length >= 3 && !real.some((x) => x.conclusion === 'success')) {
      add(full, 'ci failing', `the last ${real.length} completed runs on ${meta.body.default_branch} all failed`)
    }

    // --- an ignored queue --------------------------------------------------
    // Skipped for Reference, where the queue is a submissions inbox rather than
    // a bug tracker, and a slow one says nothing about whether the list works.
    if (r.tier !== 'Reference') {
      const issues = await api(`repos/${full}/issues?state=open&sort=created&direction=asc&per_page=100`)
      const stale = (issues.body ?? []).filter(
        (i) => !i.pull_request && i.user?.login !== owner && i.user?.login !== 'AdamXweb'
          && !BOT.test(i.user?.login ?? '') && NOW - Date.parse(i.created_at) > 180 * DAY,
      )
      if (stale.length) {
        add(full, 'ignored queue', `${stale.length} outside issue(s) unanswered for 180+ days, oldest #${stale[0].number} from ${stale[0].created_at.slice(0, 10)}`)
      }
    }

    // --- the only two tier suggestions worth making ------------------------
    if (r.tier === 'Active') {
      const since = new Date(NOW - 90 * DAY).toISOString()
      const cs = await api(`repos/${full}/commits?sha=${meta.body.default_branch}&since=${since}&per_page=100`)
      const human = (cs.body ?? []).filter(
        (c) => c.parents?.length < 2 && !BOT.test(c.author?.login ?? '') && !SWEEP.test(c.commit.message.split('\n')[0]),
      )
      if (!human.length) suggests.push({ repo: full, claimed: 'Active', suggest: 'Maintained or lower', why: 'no human commits on the default branch in 90 days' })
    }
    if (r.tier === 'Building' && latest) {
      suggests.push({ repo: full, claimed: 'Building', suggest: 'Active or Maintained', why: `it has a published release (${latest.tag_name}) — Building means nothing has shipped` })
    }
  }
}

// ---------------------------------------------------------------- report
const date = new Date(NOW).toISOString().slice(0, 10)
let md = `_${OWNER} — checked ${date}. Tiers last reviewed by hand: ${data.reviewed}._\n\n`

if (NOW - Date.parse(data.reviewed) > 90 * DAY) {
  md += `> **The tiers haven't been reviewed by hand in over 90 days.** This list is only as`
    + ` trustworthy as that date.\n\n`
}

if (!findings.length && !suggests.length) {
  md += `Nothing to report. Every advertised link resolves, no queue is being ignored,`
    + ` and no repo contradicts its claimed tier.\n\n`
}

if (findings.length) {
  md += `## ${findings.length} thing(s) to fix\n\n| Repo | What | Detail |\n| --- | --- | --- |\n`
  for (const f of findings) md += `| [${f.repo}](https://github.com/${f.repo}) | ${f.kind} | ${f.detail} |\n`
  md += `\n`
}

if (suggests.length) {
  md += `## ${suggests.length} tier(s) worth a second look\n\n| Repo | Says | Suggests | Why |\n| --- | --- | --- | --- |\n`
  for (const s of suggests) md += `| [${s.repo}](https://github.com/${s.repo}) | ${s.claimed} | ${s.suggest} | ${s.why} |\n`
  md += `\nNothing has been changed — edit \`status.json\` to accept any of these.\n\n`
}

if (pinned.length) {
  md += `## Pinned — deliberately not re-checked\n\n`
  for (const p of pinned) md += `- **${p.full}** (${p.tier}, pinned ${p.reviewed}) — ${p.reason}\n`
  md += `\n`
}
if (unread.length) {
  md += `## Not checked\n\n${unread.map((s) => `- ${s}`).join('\n')}\n\n`
    + `_These were not evaluated at all — usually a token that can't read them, which means`
    + ` their absence above is not a clean bill of health._\n`
}

process.stdout.write(md)
