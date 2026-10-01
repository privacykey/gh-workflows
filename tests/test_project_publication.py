"""Exercise conditional project gates and their placement before remote publication."""
import os
from pathlib import Path
import subprocess
import tempfile
import unittest
import yaml

ROOT=Path(__file__).resolve().parents[1]
class ProjectPublication(unittest.TestCase):
    def doc(self,name):return yaml.safe_load((ROOT/'.github/workflows'/name).read_text())
    def run_step(self,step,repo,**extra):
        env=dict(os.environ,RUNNER_TEMP=str(repo/'temporary'),**extra)
        return subprocess.run(['bash','-c',step['run']],cwd=repo,env=env,capture_output=True,text=True)
    def fixture(self,path,fail):
        (path/'temporary').mkdir();(path/'.project').mkdir()
        (path/'.project/commands.json').write_text('{}')
        (path/'.project/projectctl.py').write_text('''import pathlib,sys
command=sys.argv[1]
with pathlib.Path('temporary/calls').open('a') as output: output.write(' '.join(sys.argv[1:])+'\\n')
if command==%r: raise SystemExit(1)
'''%fail)
    def test_source_rejection_prevents_capture_and_signing(self):
        steps=self.doc('ios-release.yml')['jobs']['archive']['steps']
        capture=next(x for x in steps if x.get('name')=='Capture original project source')
        self.assertLess(steps.index(capture),next(i for i,x in enumerate(steps) if x.get('name')=='Build signed archive'))
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);self.fixture(root,'source-check')
            result=self.run_step(capture,root,PUBLISH='true')
            self.assertNotEqual(result.returncode,0)
            self.assertEqual((root/'temporary/calls').read_text().splitlines(),['source-check --channel testflight'])
    def test_ios_checks_exact_export_before_upload(self):
        steps=self.doc('ios-release.yml')['jobs']['archive']['steps']
        gate=next(x for x in steps if x.get('name')=='Record and verify the original archive and export')
        self.assertLess(steps.index(gate),next(i for i,x in enumerate(steps) if x.get('name')=='Upload to TestFlight'))
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);self.fixture(root,'artifact-verify')
            result=self.run_step(gate,root,PUBLISH='true',SCHEME='Example',IPA='build/export/Original.ipa')
            self.assertNotEqual(result.returncode,0)
            calls=(root/'temporary/calls').read_text()
            self.assertIn('record-artifact build/Example.xcarchive',calls)
            self.assertIn('record-artifact build/export/Original.ipa',calls)
            self.assertIn('artifact-verify build/Example.xcarchive --channel testflight',calls)
    def test_package_failure_precedes_github_and_appcast_publication(self):
        steps=self.doc('macos-sparkle-release.yml')['jobs']['release']['steps']
        gate=next(x for x in steps if x.get('name')=='Verify project package before publication')
        for name in ['Attach assets to GitHub Release','Publish appcast to Pages branch']:
            self.assertLess(steps.index(gate),next(i for i,x in enumerate(steps) if x.get('name')==name))
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);self.fixture(root,'artifact-verify')
            result=self.run_step(gate,root,DMG='dist/Original.dmg')
            self.assertNotEqual(result.returncode,0)
            self.assertEqual((root/'temporary/calls').read_text().strip(),'artifact-verify dist/Original.dmg --channel release')
    def test_projects_without_contract_keep_existing_workflow_behavior(self):
        steps=self.doc('ios-release.yml')['jobs']['archive']['steps']
        gate=next(x for x in steps if x.get('name')=='Record and verify the original archive and export')
        with tempfile.TemporaryDirectory() as temp:
            root=Path(temp);(root/'temporary').mkdir()
            result=self.run_step(gate,root,PUBLISH='true',SCHEME='Example',IPA='build/export/Original.ipa')
            self.assertEqual(result.returncode,0,result.stderr)
            self.assertFalse((root/'temporary/calls').exists())

if __name__=='__main__':unittest.main()
