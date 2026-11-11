#!/usr/bin/env node
// Runs before dependencies are installed, including on unsupported Node majors.
'use strict';

function checkNodeVersion(version) {
  const match = /^v?(\d+)\.(\d+)\.(\d+)(?:[-+].*)?$/.exec(version);
  if (!match || Number(match[1]) !== 24) {
    return {
      ok: false,
      message: `Node.js 24.x is required (found ${version}). Install Node 24, then run: corepack enable && pnpm install --frozen-lockfile`,
    };
  }
  return { ok: true, message: `Node.js ${version} satisfies the 24.x requirement.` };
}

if (require.main === module) {
  const result = checkNodeVersion(process.version);
  (result.ok ? process.stdout : process.stderr).write(result.message + '\n');
  if (!result.ok) process.exitCode = 1;
}
module.exports = { checkNodeVersion };
