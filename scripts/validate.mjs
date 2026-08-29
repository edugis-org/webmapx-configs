/**
 * Validates every config in configs/ with webmapx's own validator.
 *
 * The validator is not vendored here on purpose: it must be the code that
 * actually reads these files at runtime, at a version we can point at, rather
 * than a copy that drifts. `WEBMAPX_VALIDATE` names the built CLI to use, which
 * is how CI runs the same configs against several versions of webmapx.
 *
 * JavaScript rather than TypeScript because this is the script that runs before
 * anything is installed; it has no build step to rely on.
 */
import { readdir } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import path from 'node:path';
import process from 'node:process';
import { existsSync } from 'node:fs';

const repoRoot = path.dirname(new URL(import.meta.url).pathname);
const configsDir = path.resolve(repoRoot, '..', 'configs');

const validator = process.env.WEBMAPX_VALIDATE
  ?? path.resolve(repoRoot, '..', 'node_modules', '@edugis-org', 'webmapx', 'dist-lib', 'webmapx-validate.js');

if (!existsSync(validator)) {
  console.error(`Validator not found at ${validator}.`);
  console.error('Install webmapx (npm install @edugis-org/webmapx), or set WEBMAPX_VALIDATE');
  console.error('to a built dist-lib/webmapx-validate.js — see .github/workflows/validate.yml.');
  process.exit(2);
}

const entries = await readdir(configsDir, { withFileTypes: true });
const configs = entries
  .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
  .map((entry) => path.join(configsDir, entry.name))
  .sort();

if (configs.length === 0) {
  console.error(`No configs found in ${configsDir}`);
  process.exit(2);
}

const args = [validator, ...configs, ...process.argv.slice(2)];
const child = spawn(process.execPath, args, { stdio: 'inherit' });
child.on('exit', (code) => process.exit(code ?? 1));
