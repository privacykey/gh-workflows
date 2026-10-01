const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function context(env) {
  if (env.GITHUB_ACTIONS !== 'true' || !/^\d+$/.test(env.GITHUB_RUN_ID || '') ||
      !/^\d+$/.test(env.GITHUB_RUN_ATTEMPT || '') ||
      !/^[A-Za-z0-9_-]+$/.test(env.GITHUB_JOB || '') ||
      !/^[A-Za-z0-9_-]+$/.test(env.INPUT_INSTANCE || '0') ||
      !/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(env.GITHUB_REPOSITORY || '')) {
    throw new Error('A complete GitHub Actions job context is required.');
  }
  if (!path.isAbsolute(env.GITHUB_WORKSPACE || '') || !path.isAbsolute(env.RUNNER_TEMP || '')) {
    throw new Error('Absolute runner workspace and temporary paths are required.');
  }
  if (/[\r\n\0]/.test(env.GITHUB_WORKSPACE + env.RUNNER_TEMP)) {
    throw new Error('Runner paths must not contain line breaks or NUL characters.');
  }
  const root = fs.realpathSync(path.dirname(env.RUNNER_TEMP));
  const workspace = fs.realpathSync(env.GITHUB_WORKSPACE);
  const relative = path.relative(root, workspace).split(path.sep);
  if (relative.length !== 2 || relative.some(p => !p || p.startsWith('_') || p === '..')) {
    throw new Error('Workspace must be the runner’s repository checkout, not a runner or home directory.');
  }
  return { workspace, root, repository: env.GITHUB_REPOSITORY,
    run: env.GITHUB_RUN_ID, attempt: env.GITHUB_RUN_ATTEMPT, job: env.GITHUB_JOB,
    instance: env.INPUT_INSTANCE || '0' };
}

function simulatorPrefix(owner) {
  // Brackets/colon cannot occur in validated job IDs. Avoid prefix collisions
  // between jobs such as "test" and "test-ios", and between matrix instances.
  return `${owner.repository.split('/')[1]}-ci-${owner.run}-${owner.attempt}-[${owner.job}:${owner.instance}]`;
}

function paths(input) {
  const values = [...new Set(input.split(/\r?\n/).map(p => p.trim()).filter(Boolean))];
  for (const value of values) {
    const parts = value.split('/');
    if (path.isAbsolute(value) || /[\\\0]/.test(value) ||
        parts.some(p => !p || p === '.' || p === '..') || ['.git', '.github'].includes(parts[0])) {
      throw new Error(`Unsafe cleanup path: ${value}`);
    }
  }
  return values;
}

function register(env) {
  const owner = context(env);
  const targets = paths(env.INPUT_PATHS || '');
  // Always include the isolated Xcode/Fastlane cache exported below.
  if (!targets.includes('.ci-derived-data')) targets.push('.ci-derived-data');
  const enabled = env.INPUT_SIMULATORS || 'false';
  if (!['true', 'false'].includes(enabled)) throw new Error('simulators must be true or false.');
  const prefix = enabled === 'true'
    ? simulatorPrefix(owner) : '';
  const state = JSON.stringify({ owner, targets, prefix });
  fs.appendFileSync(env.GITHUB_STATE, `cleanup=${state}\n`);
  fs.appendFileSync(env.GITHUB_OUTPUT, `simulator-name=${prefix}\n`);
  const derived = path.join(owner.workspace, '.ci-derived-data');
  fs.appendFileSync(env.GITHUB_ENV,
    `CI_DERIVED_DATA=${derived}\nGYM_DERIVED_DATA_PATH=${derived}\nSCAN_DERIVED_DATA_PATH=${derived}\n` +
    `CI_SIMULATOR_NAME_PREFIX=${prefix}\n`);
  console.log('Registered cleanup after artifact uploads, cache saves and checkout post-actions.');
}

function targetPaths(workspace, targets) {
  return paths(targets.join('\n')).map(value => {
    const target = path.join(workspace, value);
    // A terminal symlink is unlinked, never followed. Ancestor symlinks are refused.
    let parent = path.dirname(target);
    while (parent !== workspace) {
      if (fs.existsSync(parent) && fs.lstatSync(parent).isSymbolicLink()) {
        throw new Error(`Cleanup path has a symlink ancestor: ${value}`);
      }
      parent = path.dirname(parent);
    }
    return target;
  });
}

function ownedDevices(devices, prefix) {
  const escaped = prefix.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const name = new RegExp(`^(?:Clone [0-9]+ of )*${escaped}(?:-[A-Za-z0-9_-]+)?$`);
  const owned = Object.values(devices).flat().filter(d => name.test(d.name || ''));
  for (const device of owned) {
    if (!/^[0-9a-f]{8}(?:-[0-9a-f]{4}){3}-[0-9a-f]{12}$/i.test(device.udid || '')) {
      throw new Error('Invalid simulator UUID; no devices removed.');
    }
  }
  return owned;
}

function cleanup(env, execute = execFileSync, remove = fs.rmSync) {
  if (!env.STATE_cleanup) return 0; // Registration failed before any resource was created.
  const state = JSON.parse(env.STATE_cleanup);
  const owner = context(env);
  if (JSON.stringify(owner) !== JSON.stringify(state.owner)) {
    throw new Error('Cleanup state belongs to a different job or workspace.');
  }
  const expected = simulatorPrefix(owner);
  if (state.prefix && state.prefix !== expected) throw new Error('Simulator ownership does not match this job.');
  let failed = 0;
  if (state.prefix) {
    const simctl = (...args) => execute('xcrun', ['simctl', ...args], { encoding: 'utf8', timeout: 45000 });
    try {
      const inventory = JSON.parse(simctl('list', 'devices', '--json'));
      const devices = ownedDevices(inventory.devices, state.prefix);
      for (const device of devices) {
        if (device.state !== 'Shutdown') {
          try { simctl('shutdown', device.udid); }
          catch (error) { console.warn(`::warning::Shutdown failed for ${device.udid}: ${error.message}`); }
        }
        try {
          simctl('delete', device.udid);
          console.log(`Deleted owned simulator ${device.name} (${device.udid}).`);
        } catch (error) {
          failed++;
          console.error(`::error::Simulator deletion failed for ${device.udid}: ${error.message}`);
        }
      }
    } catch (error) {
      failed++;
      console.error(`::error::Owned simulator cleanup failed: ${error.message}`);
    }
  }
  try {
    // Validate all destinations before removing any workspace output.
    const targets = targetPaths(owner.workspace, state.targets);
    for (const target of targets) {
      try {
        remove(target, { recursive: true, force: true, maxRetries: 3, retryDelay: 1000 });
        console.log(`Removed generated output ${path.relative(owner.workspace, target)}.`);
      } catch (error) {
        failed++;
        console.error(`::error::Output cleanup failed: ${error.message}`);
      }
    }
  } catch (error) {
    failed++;
    console.error(`::error::Workspace cleanup refused: ${error.message}`);
  }
  return failed ? 1 : 0;
}

module.exports = { context, paths, register, targetPaths, ownedDevices, cleanup };
