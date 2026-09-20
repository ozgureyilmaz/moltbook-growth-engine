import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import { delimiter } from 'node:path';
import { existsSync, readdirSync, realpathSync } from 'node:fs';
import { homedir } from 'node:os';

export const projectRoot = dirname(dirname(fileURLToPath(import.meta.url)));

export function findNode22({ env = process.env, home = homedir(), execPath = process.execPath, version = process.versions.node, probe = probeNode } = {}) {
  if (Number(version.split('.')[0]) === 22) return execPath;
  const candidates = [];
  if (env.MARX_GROWTH_NODE) candidates.push(env.MARX_GROWTH_NODE);
  const versions = join(env.NVM_DIR || join(home, '.nvm'), 'versions/node');
  if (existsSync(versions)) {
    const installed = readdirSync(versions).filter((name) => /^v22\.\d+\.\d+$/.test(name));
    installed.sort((a, b) => b.localeCompare(a, undefined, { numeric: true }));
    candidates.push(...installed.map((name) => join(versions, name, 'bin/node')));
  }
  candidates.push('/opt/homebrew/opt/node@22/bin/node', '/usr/local/opt/node@22/bin/node');
  candidates.push(...(env.PATH ?? '').split(delimiter).filter(Boolean).map((directory) => join(directory, process.platform === 'win32' ? 'node.exe' : 'node')));
  for (const candidate of [...new Set(candidates)]) {
    if (probe(candidate)) return candidate;
  }
  return undefined;
}

function probeNode(binary) {
  if (!existsSync(binary)) return false;
  const result = spawnSync(binary, ['-p', 'process.versions.node'], { encoding: 'utf8', timeout: 5000 });
  return result.status === 0 && /^22\.\d+\.\d+$/.test(result.stdout.trim());
}

export function ensureNode22() {
  if (Number(process.versions.node.split('.')[0]) === 22) return;
  const binary = findNode22();
  if (!binary || process.env.MARX_NODE_RELAUNCHED === '1') {
    throw new Error('Node 22 was not found. Install it once with nvm install 22.17.0, or set MARX_GROWTH_NODE to a Node 22 executable, then rerun npm run setup.');
  }
  const env = { ...process.env, PATH: `${dirname(binary)}${delimiter}${process.env.PATH ?? ''}`, npm_node_execpath: binary, MARX_NODE_RELAUNCHED: '1' };
  // npm itself must come from the selected runtime when setup installs native addons.
  const npm = join(dirname(realpathSync(binary)), '../lib/node_modules/npm/bin/npm-cli.js');
  if (existsSync(npm)) env.npm_execpath = npm;
  console.log(`Using Node 22 automatically: ${binary}`);
  const result = spawnSync(binary, process.argv.slice(1), { cwd: process.cwd(), env, stdio: 'inherit' });
  if (result.error) throw new Error(`Could not start Node 22: ${result.error.message}`);
  process.exit(result.status ?? 1);
}

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
