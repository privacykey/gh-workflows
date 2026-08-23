#!/usr/bin/env python3
"""Sync a static site's displayed release version from a product repo's
GitHub Releases.

Reads the latest releases of one repository, writes `version.json` at the
site root, and rewrites the marker elements in every *.html under the site
directory. Standard library only; runs on the runner's system python3.

Markers (attribute order inside the tag does not matter):

    <span data-release="NAME">v0.1.5</span>
        inner text  -> display version ("v" + version)
    <a data-release-link="NAME" href="...">
        href        -> the release's html_url (added if missing)
    <time data-release-date="NAME" datetime="...">8 Aug 2026</time>
        datetime    -> YYYY-MM-DD of published_at (added if missing)
        inner text  -> "8 Aug 2026"

NAME is a component from the `--tags` spec, e.g. `app=v*` or
`cli=cli-v*,full=full-v*`. For each component the newest non-draft
(and, unless enabled, non-prerelease) release whose tag matches the glob
wins; its version is the tag with the glob's literal prefix (everything
before the first `*`) stripped. A component with no matching release is
reported with a ::notice and its markup is left exactly as it was.

Nothing is written unless the API call succeeds. Files are rewritten only
when their content would actually change, so a second run is a no-op and
`changed=false` means exactly that.

Outputs (to $GITHUB_OUTPUT when set, and always echoed):
    changed=true|false   any file written
    tags=cli-v0.2.0,...  the tags that resolved, in spec order
    files=a.html,b.html  files written, comma-separated
"""

from __future__ import annotations

import argparse
import fnmatch
import json
import os
import re
import sys
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

API = "https://api.github.com"
SKIP_DIRS = {".git", ".gh-workflows", "node_modules"}
MONTHS = ["Jan", "Feb", "Mar", "Apr", "May", "Jun",
          "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"]


# ---------------------------------------------------------------- helpers --

def log(msg: str) -> None:
    print(msg, flush=True)


def notice(msg: str) -> None:
    log(f"::notice::{msg}")


def fail(msg: str) -> None:
    log(f"::error::{msg}")
    sys.exit(1)


def parse_tags(spec: str) -> list[tuple[str, str]]:
    """'cli=cli-v*,full=full-v*' -> [('cli', 'cli-v*'), ('full', 'full-v*')]"""
    out: list[tuple[str, str]] = []
    for item in spec.split(","):
        item = item.strip()
        if not item:
            continue
        if "=" not in item:
            fail(f"tags entry '{item}' is not NAME=GLOB")
        name, glob = (s.strip() for s in item.split("=", 1))
        if not re.fullmatch(r"[A-Za-z0-9_-]+", name):
            fail(f"component name '{name}' may only contain [A-Za-z0-9_-]")
        if "*" not in glob:
            fail(f"glob '{glob}' for '{name}' has no '*' — nothing to strip as a prefix")
        out.append((name, glob))
    if not out:
        fail("tags spec is empty")
    return out


def fetch_releases(repo: str, token: str) -> list[dict]:
    url = f"{API}/repos/{repo}/releases?per_page=100"
    req = urllib.request.Request(url, headers={
        "Accept": "application/vnd.github+json",
        "X-GitHub-Api-Version": "2022-11-28",
        "User-Agent": "privacykey-site-release-version",
    })
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=30) as resp:
            if resp.status != 200:
                fail(f"GET {url} returned HTTP {resp.status}")
            return json.load(resp)
    except urllib.error.HTTPError as e:
        remaining = e.headers.get("x-ratelimit-remaining")
        if e.code in (403, 429) and remaining == "0":
            reset = e.headers.get("x-ratelimit-reset", "?")
            fail(f"GitHub API rate limit exhausted (resets at epoch {reset}); nothing written")
        fail(f"GET {url} returned HTTP {e.code} {e.reason}; nothing written")
    except (urllib.error.URLError, TimeoutError) as e:
        fail(f"GET {url} failed: {e}; nothing written")
    return []  # unreachable; keeps type-checkers quiet


def resolve(releases: list[dict], tags: list[tuple[str, str]],
            prereleases: bool) -> dict[str, dict]:
    candidates = [r for r in releases
                  if not r.get("draft") and (prereleases or not r.get("prerelease"))
                  and r.get("published_at")]
    found: dict[str, dict] = {}
    for name, glob in tags:
        prefix = glob.split("*", 1)[0]
        matches = [r for r in candidates if fnmatch.fnmatchcase(r["tag_name"], glob)]
        if not matches:
            notice(f"{name}: no published release matches '{glob}' — markup left untouched")
            continue
        best = max(matches, key=lambda r: r["published_at"])
        tag = best["tag_name"]
        version = tag[len(prefix):] if tag.startswith(prefix) else tag
        found[name] = {
            "tag": tag,
            "version": version,
            "url": best["html_url"],
            "published_at": best["published_at"],
        }
        log(f"{name}: {tag} -> {version} ({best['published_at']})")
    return found


def display(version: str) -> str:
    return version if version.startswith("v") else f"v{version}"


def human_date(iso: str) -> tuple[str, str]:
    """'2026-08-08T15:24:33Z' -> ('2026-08-08', '8 Aug 2026')"""
    dt = datetime.fromisoformat(iso.replace("Z", "+00:00")).astimezone(timezone.utc)
    return dt.strftime("%Y-%m-%d"), f"{dt.day} {MONTHS[dt.month - 1]} {dt.year}"


# ---------------------------------------------------------------- rewrite --

def _attr(name: str, value: str) -> str:
    """Regex for an attribute with a given value, either quote style."""
    return rf'\b{name}=(?:"{re.escape(value)}"|\'{re.escape(value)}\')'


def _set_attr(tag: str, name: str, value: str) -> str:
    """Replace (or add, right after the tag name) an attribute in an opening tag."""
    pattern = re.compile(rf'\b{name}=(?:"[^"]*"|\'[^\']*\')')
    new = f'{name}="{value}"'
    if pattern.search(tag):
        return pattern.sub(new, tag, count=1)
    return re.sub(r"^(<[A-Za-z][A-Za-z0-9-]*)", rf"\1 {new}", tag, count=1)


def rewrite_html(html: str, found: dict[str, dict]) -> str:
    for name, rel in found.items():
        shown = display(rel["version"])
        iso, human = human_date(rel["published_at"])

        # <span data-release="NAME">...</span>
        html = re.sub(
            rf'(<span\b[^>]*{_attr("data-release", name)}[^>]*>)(.*?)(</span>)',
            lambda m: f"{m.group(1)}{shown}{m.group(3)}",
            html, flags=re.DOTALL)

        # <a data-release-link="NAME" ...>
        html = re.sub(
            rf'<a\b[^>]*{_attr("data-release-link", name)}[^>]*>',
            lambda m: _set_attr(m.group(0), "href", rel["url"]),
            html)

        # <time data-release-date="NAME" ...>...</time>
        html = re.sub(
            rf'(<time\b[^>]*{_attr("data-release-date", name)}[^>]*>)(.*?)(</time>)',
            lambda m: f'{_set_attr(m.group(1), "datetime", iso)}{human}{m.group(3)}',
            html, flags=re.DOTALL)
    return html


def html_files(site_dir: Path):
    for root, dirs, files in os.walk(site_dir):
        dirs[:] = sorted(d for d in dirs if d not in SKIP_DIRS)
        for f in sorted(files):
            if f.endswith(".html"):
                yield Path(root) / f


def unknown_markers(html: str, known: set[str]) -> set[str]:
    names = set(re.findall(r'\bdata-release(?:-link|-date)?=(?:"([^"]+)"|\'([^\']+)\')', html))
    return {a or b for a, b in names} - known


# ------------------------------------------------------------------- main --

def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__.split("\n\n")[0])
    ap.add_argument("--repo", required=True, help="owner/name of the product repository")
    ap.add_argument("--tags", default="app=v*", help="comma-separated NAME=GLOB list")
    ap.add_argument("--include-prereleases", default="false")
    ap.add_argument("--site-dir", default=".")
    args = ap.parse_args()

    if not re.fullmatch(r"[A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+", args.repo):
        fail(f"repo '{args.repo}' is not owner/name")
    tags = parse_tags(args.tags)
    prereleases = args.include_prereleases.strip().lower() in ("true", "1", "yes")
    site_dir = Path(args.site_dir).resolve()
    if not site_dir.is_dir():
        fail(f"site-dir '{site_dir}' is not a directory")
    token = os.environ.get("GITHUB_TOKEN", "")
    if not token:
        notice("GITHUB_TOKEN not set — calling the API anonymously (60 requests/hour)")

    # Everything that can fail does so here, before anything is written.
    releases = fetch_releases(args.repo, token)
    log(f"{args.repo}: {len(releases)} release(s) returned")
    found = resolve(releases, tags, prereleases)
    if not found:
        notice("no component resolved to a release — nothing to write")

    touched: list[str] = []

    # version.json — no generated-at field, on purpose: the file must only
    # change when a release does, or every hourly run would commit.
    manifest = {"source": args.repo, "components": found}
    new_json = json.dumps(manifest, indent=2) + "\n"
    json_path = site_dir / "version.json"
    if found and (not json_path.exists() or json_path.read_text(encoding="utf-8") != new_json):
        json_path.write_text(new_json, encoding="utf-8")
        touched.append("version.json")

    known = {name for name, _ in tags}
    for path in html_files(site_dir):
        original = path.read_text(encoding="utf-8")
        rel_path = path.relative_to(site_dir).as_posix()
        for name in sorted(unknown_markers(original, known)):
            notice(f"{rel_path}: marker for unknown component '{name}' (not in --tags) left untouched")
        updated = rewrite_html(original, found)
        if updated != original:
            path.write_text(updated, encoding="utf-8")
            touched.append(rel_path)

    changed = bool(touched)
    tag_list = ",".join(found[n]["tag"] for n, _ in tags if n in found)
    summary = (f"Updated {len(touched)} file(s): {', '.join(touched)}" if changed
               else "Already up to date — nothing written")
    log(summary)

    if out := os.environ.get("GITHUB_OUTPUT"):
        with open(out, "a", encoding="utf-8") as fh:
            fh.write(f"changed={'true' if changed else 'false'}\n")
            fh.write(f"tags={tag_list}\n")
            fh.write(f"files={','.join(touched)}\n")
    if step_summary := os.environ.get("GITHUB_STEP_SUMMARY"):
        with open(step_summary, "a", encoding="utf-8") as fh:
            fh.write(f"### Release version sync — `{args.repo}`\n\n")
            fh.write("| Component | Tag | Version | Published |\n|---|---|---|---|\n")
            for name, _ in tags:
                r = found.get(name)
                fh.write(f"| `{name}` | {r['tag'] if r else '—'} | "
                         f"{display(r['version']) if r else '(no matching release)'} | "
                         f"{r['published_at'][:10] if r else '—'} |\n")
            fh.write(f"\n{summary}\n")


if __name__ == "__main__":
    main()
