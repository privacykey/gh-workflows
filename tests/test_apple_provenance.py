#!/usr/bin/env python3
"""Run the workflow's source guard on tagged, newer, dirty and untagged checkouts."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import yaml

ROOT = Path(__file__).resolve().parents[1]
class AppleProvenance(unittest.TestCase):
    def test_checkout_contract_and_real_tag_guard(self):
        reference = None
        for name in ("ios-release.yml", "macos-app-ci.yml", "macos-sparkle-release.yml"):
            doc = yaml.safe_load((ROOT / ".github/workflows" / name).read_text())
            for job in doc["jobs"].values():
                steps = job.get("steps", [])
                for i, step in enumerate(steps):
                    if not step.get("uses", "").startswith("actions/checkout@"):
                        continue
                    self.assertEqual(step["with"]["fetch-depth"], 0)
                    if name == "macos-sparkle-release.yml":
                        self.assertEqual(step["with"]["ref"], "${{ inputs.release_tag && format('refs/tags/{0}', inputs.release_tag) || github.ref }}")
                    report = steps[i + 1]
                    self.assertEqual(report["name"], "Report checked-out source")
                    self.assertEqual(report["shell"], "bash")
                    if reference is not None:
                        self.assertEqual(report["run"], reference)
                    reference = report["run"]
        with tempfile.TemporaryDirectory() as directory:
            repo = Path(directory)
            env = {k: v for k, v in os.environ.items() if not k.startswith("GIT_")}
            env.update(GIT_CONFIG_GLOBAL=os.devnull, GIT_CONFIG_NOSYSTEM="1")
            def git(*args):
                return subprocess.check_output(["git", *args], cwd=repo, env=env, text=True).strip()
            git("init", "-q")
            git("config", "user.name", "Source test")
            git("config", "user.email", "source@example.invalid")
            (repo / "source").write_text("release")
            git("add", ".")
            git("-c", "commit.gpgsign=false", "commit", "-qm", "release")
            git("-c", "tag.gpgsign=false", "tag", "v1.2.3")
            release_sha = git("rev-parse", "HEAD")
            def guard(tag=""):
                return subprocess.run(["bash", "-c", reference], cwd=repo,
                                      env=dict(env, RELEASE_TAG=tag), capture_output=True, text=True)
            tagged = guard("v1.2.3")
            self.assertEqual(tagged.returncode, 0, tagged.stderr)
            self.assertIn("dirty=NO version-tag-at-HEAD=YES", tagged.stdout)
            (repo / "source").write_text("local change")
            self.assertIn("dirty=YES version-tag-at-HEAD=YES", guard("v1.2.3").stdout)
            git("add", ".")
            git("-c", "commit.gpgsign=false", "commit", "-qm", "newer main")
            self.assertNotEqual(guard("v1.2.3").returncode, 0)
            self.assertIn("dirty=NO version-tag-at-HEAD=NO", guard().stdout)
            self.assertNotEqual(guard("v9.9.9").returncode, 0)
            self.assertNotEqual(guard("v1-preview").returncode, 0)
            git("checkout", "-q", "--detach", "refs/tags/v1.2.3")
            self.assertEqual(git("rev-parse", "HEAD"), release_sha)
            self.assertEqual(guard("v1.2.3").returncode, 0)
            self.assertIn("branch=HEAD", guard("v1.2.3").stdout)

if __name__ == "__main__":
    unittest.main()
