import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

export const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export function assertNode(version = process.versions.node) {
  if (Number(version.split('.')[0]) !== 22) {
    throw new Error(`Node 22 is required (current: ${version}). Run nvm install && nvm use in the repository, then npm run setup.`);
  }
}

export function runNode(args, options = {}) {
  const result = spawnSync(process.execPath, args, {
    cwd: projectRoot,
    stdio: 'inherit',
    ...options,
  });
  if (result.error) throw new Error(`Could not start Node: ${result.error.message}`);
  if (result.status !== 0) throw new Error(`Command failed (${result.signal ?? result.status}): ${args[0]}`);
}

export function runNpm(args) {
  const cli = process.env.npm_execpath;
  if (!cli) throw new Error('Start this script through npm run.');
  runNode([cli, ...args], {
    env: {
      ...process.env,
      PATH: `${dirname(process.execPath)}${process.platform === 'win32' ? ';' : ':'}${process.env.PATH ?? ''}`,
      npm_node_execpath: process.execPath,
    },
  });
}

export const cliPath = join(projectRoot, 'dist/cli/main.js');
