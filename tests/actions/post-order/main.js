require('node:fs').appendFileSync(process.env.GITHUB_STATE, `stage=${process.env.INPUT_STAGE}\n`);
