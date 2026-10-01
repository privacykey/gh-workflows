const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const action = require('../actions/cleanup-job/cleanup.js');

function fixture(t, extra = {}) {
  for (const level of ['log', 'warn', 'error']) t.mock.method(console, level, () => {});
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cleanup-action-test-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const work = path.join(root, '_work');
  const workspace = path.join(work, 'Example', 'Example');
  const temporary = path.join(work, '_temp');
  fs.mkdirSync(workspace, { recursive: true });
  fs.mkdirSync(temporary);
  const env = { GITHUB_ACTIONS: 'true', GITHUB_WORKSPACE: workspace,
    RUNNER_TEMP: temporary, GITHUB_RUN_ID: '12345', GITHUB_RUN_ATTEMPT: '2',
    GITHUB_JOB: 'test', GITHUB_REPOSITORY: 'example/Example',
    GITHUB_ENV: path.join(root, 'env'), GITHUB_OUTPUT: path.join(root, 'output'),
    GITHUB_STATE: path.join(root, 'state'), INPUT_PATHS: 'build/DerivedData\nTestResults.xcresult',
    ...extra };
  const write = (name, text = 'fixture') => {
    const target = path.join(workspace, name);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, text);
    return target;
  };
  return { root, workspace, env, write };
}

function register(f) {
  action.register(f.env);
  f.env.STATE_cleanup = fs.readFileSync(f.env.GITHUB_STATE, 'utf8').trim().slice('cleanup='.length);
  return JSON.parse(f.env.STATE_cleanup);
}

test('post cleanup deletes declared outputs while preserving source, archive and runner siblings', t => {
  const f = fixture(t);
  f.write('build/DerivedData/object'); f.write('TestResults.xcresult/log');
  f.write('.ci-derived-data/object');
  const source = f.write('Sources/App.swift');
  const archive = f.write('build/Original.xcarchive/product');
  const sibling = path.join(f.root, '_work', 'Other', 'Other', 'build');
  fs.mkdirSync(sibling, { recursive: true });
  register(f);
  assert.equal(action.cleanup(f.env), 0);
  for (const name of ['build/DerivedData', 'TestResults.xcresult', '.ci-derived-data'])
    assert.equal(fs.existsSync(path.join(f.workspace, name)), false);
  for (const name of [source, archive, sibling]) assert.equal(fs.existsSync(name), true);
  assert.equal(action.cleanup(f.env), 0);
});

test('another workspace cannot consume this action state', t => {
  const f = fixture(t); const output = f.write('build/DerivedData/object'); register(f);
  const other = path.join(f.root, '_work', 'Other', 'Other'); fs.mkdirSync(other, { recursive: true });
  assert.throws(() => action.cleanup({ ...f.env, GITHUB_WORKSPACE: other }));
  assert.equal(fs.existsSync(output), true);
});

test('registration exports a local Xcode and Fastlane cache and exact simulator ownership', t => {
  const f = fixture(t, { INPUT_SIMULATORS: 'true', INPUT_INSTANCE: '3' });
  const state = register(f);
  assert.equal(state.prefix, 'Example-ci-12345-2-[test:3]');
  const values = fs.readFileSync(f.env.GITHUB_ENV, 'utf8');
  for (const key of ['CI_DERIVED_DATA', 'GYM_DERIVED_DATA_PATH', 'SCAN_DERIVED_DATA_PATH'])
    assert.ok(values.includes(`${key}=${state.owner.workspace}/.ci-derived-data\n`));
});

test('unsafe paths fail registration without creating cleanup state', t => {
  for (const value of ['/', '.', '..', '../Other', 'build/../../Other', '.git', '.github/workflows', 'a//b', 'a\\..\\b']) {
    const f = fixture(t, { INPUT_PATHS: value });
    assert.throws(() => action.register(f.env));
    assert.equal(fs.existsSync(f.env.GITHUB_STATE), false);
  }
});

test('missing CI ownership and runner-root or external workspaces are rejected', t => {
  for (const extra of [{ GITHUB_ACTIONS: '' }, { GITHUB_RUN_ID: '' }, { GITHUB_JOB: 'unsafe/job' }]) {
    const f = fixture(t, extra); assert.throws(() => action.register(f.env));
  }
  const f = fixture(t);
  for (const workspace of [f.root, path.dirname(f.workspace), f.env.RUNNER_TEMP])
    assert.throws(() => action.register({ ...f.env, GITHUB_WORKSPACE: workspace }));
});

test('job, attempt, matrix instance and workspace changes refuse all deletion', t => {
  for (const extra of [{ GITHUB_JOB: 'test-ios' }, { GITHUB_RUN_ATTEMPT: '3' }, { INPUT_INSTANCE: '1' }]) {
    const f = fixture(t); const output = f.write('build/DerivedData/object'); register(f);
    assert.throws(() => action.cleanup({ ...f.env, ...extra }));
    assert.equal(fs.existsSync(output), true);
  }
});

test('symlink ancestors refuse the complete workspace selection', t => {
  const f = fixture(t, { INPUT_PATHS: 'build/DerivedData\nlinked/output' });
  const keep = f.write('build/DerivedData/object');
  const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'output'), 'preserve');
  fs.symlinkSync(outside, path.join(f.workspace, 'linked'));
  register(f);
  assert.equal(action.cleanup(f.env), 1);
  assert.equal(fs.existsSync(keep), true);
  assert.equal(fs.readFileSync(path.join(outside, 'output'), 'utf8'), 'preserve');
});

test('terminal symlinks are unlinked without following their targets', t => {
  const f = fixture(t, { INPUT_PATHS: 'build-link' });
  const outside = path.join(f.root, 'outside'); fs.mkdirSync(outside);
  fs.writeFileSync(path.join(outside, 'keep'), 'preserve');
  fs.symlinkSync(outside, path.join(f.workspace, 'build-link'));
  register(f); assert.equal(action.cleanup(f.env), 0);
  assert.equal(fs.existsSync(path.join(f.workspace, 'build-link')), false);
  assert.equal(fs.existsSync(path.join(outside, 'keep')), true);
});

const ids = ['11111111-1111-1111-1111-111111111111', '22222222-2222-2222-2222-222222222222',
  '33333333-3333-3333-3333-333333333333', '44444444-4444-4444-4444-444444444444'];

test('partial creation, profile devices and nested test clones are owned, other jobs and matrices are protected', t => {
  const f = fixture(t, { INPUT_SIMULATORS: 'true' }); const state = register(f);
  const inventory = { runtime: [
    { name: state.prefix, udid: ids[0], state: 'Creating' },
    { name: `Clone 1 of Clone 2 of ${state.prefix}-ipad`, udid: ids[1], state: 'Booted' },
    { name: 'Example-ci-12345-2-[test-ios:0]', udid: ids[2], state: 'Booted' },
    { name: 'Example-ci-12345-2-[test:1]', udid: ids[3], state: 'Booted' },
  ] };
  const calls = [];
  const execute = (command, args) => { calls.push(args); return JSON.stringify({ devices: inventory }); };
  assert.equal(action.cleanup(f.env, execute), 0);
  assert.deepEqual(calls.filter(a => a[1] === 'delete').map(a => a[2]), ids.slice(0, 2));
  assert.ok(!calls.some(a => ids.slice(2).includes(a[2])));
});

test('a simulator deletion failure is reported and workspace output is still cleaned', t => {
  const f = fixture(t, { INPUT_SIMULATORS: 'true' }); const state = register(f);
  const output = f.write('build/DerivedData/object');
  const execute = (command, args) => {
    if (args[1] === 'delete') throw new Error('injected delete failure');
    return JSON.stringify({ devices: { runtime: [{ name: state.prefix, udid: ids[0], state: 'Shutdown' }] } });
  };
  assert.equal(action.cleanup(f.env, execute), 1);
  assert.equal(fs.existsSync(output), false);
});

test('invalid owned UUID refuses the complete simulator selection', t => {
  const f = fixture(t, { INPUT_SIMULATORS: 'true' }); const state = register(f);
  const calls = [];
  const execute = (command, args) => {
    calls.push(args); return JSON.stringify({ devices: { runtime: [
      { name: state.prefix, udid: ids[0] }, { name: `${state.prefix}-ipad`, udid: 'all' }] } });
  };
  assert.equal(action.cleanup(f.env, execute), 1);
  assert.equal(calls.length, 1);
});

test('cleanup with no saved state is a no-op and never calls simctl', t => {
  const f = fixture(t);
  assert.equal(action.cleanup(f.env, () => { throw new Error('unexpected simctl'); }), 0);
});

test('output removal failures are surfaced', t => {
  const f = fixture(t); register(f);
  assert.equal(action.cleanup(f.env, undefined, () => { throw new Error('injected remove failure'); }), 1);
});
