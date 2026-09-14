import { chmod, mkdir, open, readFile, stat, unlink, link } from 'node:fs/promises';
import { randomBytes, randomUUID } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import { parse, stringify } from 'yaml';

export const PUBLISH_SECRET_KEYS = [
  'MOLTBOOK_API_KEY',
  'MARX_TRACKER_API_TOKEN',
  'MOLTBOOK_PUBLISHER_CONTRACT_SECRET',
];

export const DEFAULT_PUBLISHER_CONFIG = {
  credential_service: 'marx-moltbook-growth-engine',
  credential_account: 'moltbook-read-client',
  contract_keychain_service: 'marx-moltbook-growth-engine',
  contract_keychain_account: 'publisher-contract',
  contract_key_id: 'contract-v1',
  allowed_domains: ['www.moltbook.com'],
  max_actions_per_cycle: 5,
  daily_comment_cap: 50,
  comment_cooldown_seconds: 20,
  request_timeout_seconds: 30,
  secret_provider: 'environment',
  api_key_environment_variable: 'MOLTBOOK_API_KEY',
  contract_secret_environment_variable: 'MOLTBOOK_PUBLISHER_CONTRACT_SECRET',
};

export function validateAccount(account) {
  if (typeof account !== 'string' || !/^[A-Za-z0-9_-]+$/u.test(account)) {
    throw new Error('--account must be the claimed agent name (letters, numbers, underscores, hyphens)');
  }
  return account;
}

export function absoluteFromRoot(root, value, fallback) {
  const selected = value ?? fallback;
  if (typeof selected !== 'string' || selected.trim() === '') throw new Error('Configured path must be a non-empty string');
  return isAbsolute(selected) ? resolve(selected) : resolve(root, selected);
}

export function canonicalProjectPaths(root, system = {}) {
  const storage = system.storage ?? {};
  const publishing = system.publishing ?? {};
  const outbox = publishing.outbox ?? {};
  const bridge = system.publisher_bridge ?? {};
  const operations = system.operations ?? {};
  return {
    databasePath: absoluteFromRoot(root, storage.database_path, 'data/marx_growth.sqlite'),
    strategyStatsPath: absoluteFromRoot(root, storage.strategy_stats_path, 'data/strategy-stats.json'),
    pendingPath: absoluteFromRoot(root, outbox.pending_path, 'outbox/pending'),
    acknowledgedPath: absoluteFromRoot(root, outbox.acknowledged_path, 'outbox/acknowledged'),
    failedPath: absoluteFromRoot(root, outbox.failed_path, 'outbox/failed'),
    handoffPath: absoluteFromRoot(root, bridge.handoff_path, 'outbox/handoff'),
    runtimeDirectory: absoluteFromRoot(root, operations.runtime_directory, 'data/runtime'),
    killSwitchPath: absoluteFromRoot(root, operations.kill_switch_path, 'data/runtime/kill-switch.json'),
    killSwitchAuditPath: absoluteFromRoot(root, operations.kill_switch_audit_path, 'data/runtime/kill-switch.audit.jsonl'),
  };
}

export function buildPublishSystemConfig(source, root) {
  const system = parse(source || '{}');
  if (!system || typeof system !== 'object' || Array.isArray(system)) throw new Error('config/system.yaml must contain a YAML object');
  system.environment = 'production';
  system.execution = { ...(system.execution ?? {}), dry_run_by_default: false };
  system.source = {
    ...(system.source ?? {}),
    mode: 'authorized_autonomous',
    secret_provider: 'environment',
    api_key_environment_variable: 'MOLTBOOK_API_KEY',
  };
  system.publishing = { ...(system.publishing ?? {}), enabled: true, platform: 'moltbook' };
  system.publisher_bridge = {
    ...(system.publisher_bridge ?? {}),
    enabled: true,
    type: 'local_process',
    handoff_path: system.publisher_bridge?.handoff_path ?? 'outbox/handoff',
    contract_secret_provider: 'environment',
    contract_secret_environment_variable: 'MOLTBOOK_PUBLISHER_CONTRACT_SECRET',
    contract_key_id: system.publisher_bridge?.contract_key_id ?? 'contract-v1',
  };
  const paths = canonicalProjectPaths(root, system);
  system.storage = {
    ...(system.storage ?? {}),
    database_path: paths.databasePath,
    strategy_stats_path: paths.strategyStatsPath,
  };
  system.publishing.outbox = {
    ...(system.publishing.outbox ?? {}),
    pending_path: paths.pendingPath,
    acknowledged_path: paths.acknowledgedPath,
    failed_path: paths.failedPath,
  };
  system.publisher_bridge.handoff_path = paths.handoffPath;
  system.operations = {
    ...(system.operations ?? {}),
    runtime_directory: paths.runtimeDirectory,
    kill_switch_path: paths.killSwitchPath,
    kill_switch_audit_path: paths.killSwitchAuditPath,
  };
  system.safety = {
    ...(system.safety ?? {}),
    allowed_domains: ['www.moltbook.com'],
  };
  return { system, paths };
}

export function buildPublisherConfig(account, root, overrides = {}) {
  validateAccount(account);
  const { system, paths: configuredPaths, ...publisherOverrides } = overrides;
  const paths = configuredPaths ?? canonicalProjectPaths(root, system ?? {});
  return {
    ...DEFAULT_PUBLISHER_CONFIG,
    account,
    project_dir: resolve(root),
    pending_dir: paths.pendingPath,
    handoff_dir: paths.handoffPath,
    ...publisherOverrides,
    secret_provider: 'environment',
    api_key_environment_variable: 'MOLTBOOK_API_KEY',
    contract_secret_environment_variable: 'MOLTBOOK_PUBLISHER_CONTRACT_SECRET',
  };
}

export function buildPublishSettings({ account, root, python, script, configDirectory, publisherConfig, secretsPath, paths }) {
  validateAccount(account);
  return {
    schema_version: '1',
    account,
    project_dir: resolve(root),
    config_directory: resolve(configDirectory),
    publisher: {
      python,
      script: resolve(script),
      config: resolve(publisherConfig),
    },
    secrets_path: resolve(secretsPath),
    engine: {
      database_path: resolve(paths.databasePath),
      outbox: {
        pending_path: resolve(paths.pendingPath),
        acknowledged_path: resolve(paths.acknowledgedPath),
        failed_path: resolve(paths.failedPath),
        handoff_path: resolve(paths.handoffPath),
      },
    },
  };
}

export function pythonAvailable(python = 'python3', executor = spawnSync) {
  const result = executor(python, ['-c', 'import sys; raise SystemExit(0 if sys.version_info[0] >= 3 else 1)'], { stdio: 'ignore' });
  return result?.status === 0;
}

export function requirePython3(python = 'python3', executor = spawnSync) {
  if (!pythonAvailable(python, executor)) throw new Error(`Python 3 is required but was not found: ${python}`);
  return python;
}

export function promptSecretWithPython(python, name, executor = spawnSync) {
  if (!process.stdin.isTTY) throw new Error(`Missing ${name}; set ${name} in the environment for non-interactive setup`);
  const prompt = `${name}: `;
  const code = `import getpass,sys; sys.stdout.write(getpass.getpass(${JSON.stringify(prompt)}))`;
  const result = executor(python, ['-c', code], { stdio: ['inherit', 'pipe', 'inherit'], encoding: 'utf8' });
  if (result?.status !== 0) throw new Error(`Could not read ${name} securely`);
  const value = String(result.stdout ?? '').trim();
  if (!value) throw new Error(`${name} cannot be empty`);
  return value;
}

export function collectPublishSecrets({ env = process.env, python = 'python3', promptSecret = (name) => promptSecretWithPython(python, name), random = () => randomBytes(32).toString('hex') } = {}) {
  const secrets = {};
  for (const name of ['MOLTBOOK_API_KEY', 'MARX_TRACKER_API_TOKEN']) {
    const value = typeof env[name] === 'string' && env[name].trim() ? env[name].trim() : promptSecret(name);
    if (!value) throw new Error(`${name} cannot be empty`);
    secrets[name] = value;
  }
  const suppliedContract = typeof env.MOLTBOOK_PUBLISHER_CONTRACT_SECRET === 'string' && env.MOLTBOOK_PUBLISHER_CONTRACT_SECRET.trim();
  secrets.MOLTBOOK_PUBLISHER_CONTRACT_SECRET = suppliedContract || random();
  if (!secrets.MOLTBOOK_PUBLISHER_CONTRACT_SECRET) throw new Error('MOLTBOOK_PUBLISHER_CONTRACT_SECRET cannot be empty');
  return secrets;
}

export async function writeExclusiveAtomic(path, value, mode = 0o600) {
  await mkdir(dirname(path), { recursive: true, mode: 0o700 });
  const temporary = `${path}.${process.pid}.${randomUUID()}.tmp`;
  let handle;
  try {
    handle = await open(temporary, 'wx', mode);
    await handle.writeFile(value, 'utf8');
    await handle.sync();
    await handle.close();
    handle = undefined;
    await link(temporary, path);
  } catch (error) {
    if ((error?.code ?? '') === 'EEXIST' && path === temporary) throw error;
    throw error;
  } finally {
    await handle?.close().catch(() => undefined);
    await unlink(temporary).catch(() => undefined);
  }
}

export async function ensurePrivatePath(path, kind = 'file') {
  if (process.platform === 'win32') return;
  const info = await stat(path);
  if (kind === 'directory' && !info.isDirectory()) throw new Error(`Expected private directory: ${path}`);
  if (kind === 'file' && !info.isFile()) throw new Error(`Expected private file: ${path}`);
  if ((info.mode & 0o077) !== 0) throw new Error(`Refusing insecure permissions on ${path}; use mode 600 for files and 700 for directories`);
}

export async function createPrivateDirectory(path) {
  await mkdir(path, { mode: 0o700 });
  await chmod(path, 0o700);
  await ensurePrivatePath(path, 'directory');
}

export async function readPrivateJson(path) {
  await ensurePrivatePath(path, 'file');
  try {
    return JSON.parse(await readFile(path, 'utf8'));
  } catch (error) {
    throw new Error(`Unable to read private JSON at ${path}: ${error instanceof Error ? error.message : String(error)}`);
  }
}

export function serializeYaml(value) {
  return stringify(value, { lineWidth: 120 });
}
