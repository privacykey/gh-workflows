const fs = require('node:fs');
const path = require('node:path');
const assert = require('node:assert/strict');
const output = path.join(process.env.GITHUB_WORKSPACE, 'cleanup-fixture', 'cache-output');
const checked = path.join(process.env.GITHUB_WORKSPACE, 'cleanup-order-checked');
if (process.env.STATE_stage === 'before-cleanup') {
  assert.equal(fs.readFileSync(output, 'utf8'), 'cache and artifact input');
  fs.writeFileSync(checked, 'post-consumers-completed');
} else {
  assert.equal(process.env.STATE_stage, 'after-cleanup');
  assert.equal(fs.existsSync(output), false);
  assert.equal(fs.readFileSync(checked, 'utf8'), 'post-consumers-completed');
  fs.unlinkSync(checked);
}
console.log(`Post-action order verified: ${process.env.STATE_stage}.`);
