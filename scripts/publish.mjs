import { lstat, mkdir, open, readFile, readdir, unlink } from 'node:fs/promises';
import { spawn } from 'node:child_process';
import { join, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { parse } from 'yaml';
import { ensureNode22, projectRoot } from './runtime.mjs';
import { livePlan } from './live.mjs';
import {
  buildPublishSystemConfig,
  canonicalProjectPaths,
  ensurePrivatePath,
  readPrivateJson,
  validateAccount,
} from './publish-config.mjs';

const SAFE_ENVIRONMENT_KEYS = [
  'PATH', 'HOME', 'TMPDIR', 'LANG', 'LC_ALL', 'CODEX_HOME', 'NVM_DIR',
  'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'TERM', 'MARX_GROWTH_CODEX_BIN',
];
const SECRET_KEYS = ['MOLTBOOK_API_KEY', 'MARX_TRACKER_API_TOKEN', 'MOLTBOOK_PUBLISHER_CONTRACT_SECRET'];
const SAFE_TERMINAL_STATUSES = new Set(['PUBLISHED', 'ACKNOWLEDGED', 'QUARANTINED', 'NO_ACTION', 'DRY_RUN', 'RECONCILED', 'CANCELLED']);

export function publishPaths(root = projectRoot) {
  const directory = join(resolve(root), '.local', 'publish');
  return {
    directory,
    configDirectory: join(directory, 'config'),
    settings: join(directory, 'settings.json'),
    secrets: join(directory, 'secrets.json'),
    publisherConfig: join(directory, 'publisher-config.json'),
  };
}

function projectPath(root, value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} must be a non-empty path`);
  const project = resolve(root);
  const candidate = resolve(value);
  const path = relative(project, candidate);
  if (path !== '' && (path === '..' || path.startsWith(`..${process.platform === 'win32' ? '\\' : '/'}`) || /^([A-Za-z]:[\\/]|[\\/])/.test(path))) {
    throw new Error(`${label} must remain inside this project`);
  }
  return candidate;
}

function safeEnvironment(source, additions = {}, secretNames = [], secrets = {}) {
  const environment = {};
  for (const key of SAFE_ENVIRONMENT_KEYS) {
    if (typeof source[key] === 'string') environment[key] = source[key];
  }
  if (!environment.PATH) environment.PATH = '/usr/bin:/bin';
  for (const [key, value] of Object.entries(additions)) {
    if (value !== undefined && value !== null) environment[key] = String(value);
  }
  for (const name of secretNames) {
    if (typeof secrets[name] !== 'string' || !secrets[name].trim()) throw new Error(`Required secret is unavailable: ${name}`);
    environment[name] = secrets[name];
  }
  return environment;
}

function commandError(command, args, result) {
  const status = result?.signal ? `signal ${result.signal}` : `status ${result?.status ?? 'unknown'}`;
  return new Error(`Publishing step failed (${status}): ${command} ${args.join(' ')}`);
}

function createCommandRunner() {
  let child;
  return {
    run({ command, args, cwd, env }) {
      return new Promise((resolveResult, reject) => {
        const processChild = spawn(command, args, { cwd, env, stdio: 'inherit' });
        child = processChild;
        processChild.once('error', reject);
        processChild.once('close', (status, signal) => {
          if (child === processChild) child = undefined;
          if (status === 0) resolveResult({ status, signal });
          else reject(commandError(command, args, { status, signal }));
        });
      });
    },
    terminate(signal) {
      if (child && !child.killed) child.kill(signal);
    },
  };
}

export async function runNode(args, { root = projectRoot, env = process.env, runner } = {}) {
  const commandRunner = runner ?? createCommandRunner();
  return commandRunner.run({ command: process.execPath, args, cwd: resolve(root), env });
}

function controlArgs(argv) {
  const remaining = [];
  let checkOnly = false;
  let stop = false;
  let reason;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--check-only') {
      if (checkOnly) throw new Error('Duplicate --check-only');
      checkOnly = true;
    } else if (value === '--stop') {
      if (stop) throw new Error('Duplicate --stop');
      stop = true;
    } else if (value === '--reason') {
      const next = argv[++index];
      if (!next || next.startsWith('--')) throw new Error('--reason requires a value');
      reason = next;
    } else {
      remaining.push(value);
    }
  }
  if (stop && (checkOnly || remaining.length > 0)) throw new Error('--stop cannot be combined with a publish or check-only command');
  return { remaining, checkOnly, stop, reason: reason ?? 'operator emergency stop' };
}

function valueFor(options, key) {
  const value = options[key];
  return typeof value === 'string' ? value : undefined;
}

function positiveInteger(value, label) {
  if (!/^\d+$/.test(String(value)) || !Number.isSafeInteger(Number(value)) || Number(value) < 1) throw new Error(`${label} must be a positive integer`);
  return Number(value);
}

function requestedActions(argv, maxActions, dailyCap) {
  let requested;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--actions') {
      if (requested !== undefined) throw new Error('Duplicate --actions');
      requested = positiveInteger(argv[++index], '--actions');
    } else if (value.startsWith('--actions=')) {
      if (requested !== undefined) throw new Error('Duplicate --actions');
      requested = positiveInteger(value.slice('--actions='.length), '--actions');
    }
  }
  requested ??= 1;
  if (requested > maxActions) throw new Error(`Requested actions (${requested}) exceed publisher max_actions_per_cycle (${maxActions})`);
  if (requested > dailyCap) throw new Error(`Requested actions (${requested}) exceed publisher daily_comment_cap (${dailyCap})`);
  return requested;
}

async function noSymlinkDirectory(path, label) {
  try {
    const info = await lstat(path);
    if (info.isSymbolicLink()) throw new Error(`Refusing symbolic link for ${label}: ${path}`);
    if (!info.isDirectory()) throw new Error(`Expected directory for ${label}: ${path}`);
  } catch (error) {
    if (error?.code === 'ENOENT') return false;
    throw error;
  }
  return true;
}

async function noSymlinkFile(path, label) {
  const info = await lstat(path);
  if (info.isSymbolicLink()) throw new Error(`Refusing symbolic link for ${label}: ${path}`);
  if (!info.isFile()) throw new Error(`Expected file for ${label}: ${path}`);
}

function comparePath(actual, expected, label) {
  if (typeof actual !== 'string' || resolve(actual) !== resolve(expected)) throw new Error(`${label} does not match this clone's loaded configuration`);
}

function validatePublisherCaps(config) {
  const maxActions = config.max_actions_per_cycle;
  const dailyCap = config.daily_comment_cap;
  if (!Number.isSafeInteger(maxActions) || maxActions < 1) throw new Error('Publisher max_actions_per_cycle must be a positive integer');
  if (!Number.isSafeInteger(dailyCap) || dailyCap < 1) throw new Error('Publisher daily_comment_cap must be a positive integer');
  if (maxActions > dailyCap) throw new Error('Publisher max_actions_per_cycle exceeds daily_comment_cap');
  return { maxActions, dailyCap };
}

function validateSystemConfig(system, root) {
  if (system.environment !== 'production') throw new Error('Local publish config must use environment=production');
  if (system.execution?.dry_run_by_default !== true) throw new Error('Local publish config must keep dry_run_by_default=true; publish is explicit');
  if (system.source?.mode !== 'authorized_autonomous') throw new Error('Local publish config must use source.mode=authorized_autonomous');
  if (system.publishing?.enabled !== true || system.publisher_bridge?.enabled !== true) throw new Error('Local publish gates are incomplete');
  if (system.publisher_bridge?.type !== 'local_process') throw new Error('Local publish config must use the bundled local_process publisher');
  return canonicalProjectPaths(root, system);
}

async function loadPublishBundle(root, { withSecrets = true } = {}) {
  const project = resolve(root);
  const paths = publishPaths(project);
  await ensurePrivatePath(paths.directory, 'directory');
  await ensurePrivatePath(paths.settings, 'file');
  const settings = await readPrivateJson(paths.settings);
  if (settings.schema_version !== '1') throw new Error('Local publishing settings schema is unsupported');
  comparePath(settings.project_dir, project, 'settings.project_dir');
  const publisher = settings.publisher;
  if (!publisher || typeof publisher !== 'object' || Array.isArray(publisher)) throw new Error('Local publishing settings publisher section is invalid');
  const configDirectory = projectPath(project, settings.config_directory, 'settings.config_directory');
  const publisherConfigPath = projectPath(project, publisher.config, 'settings.publisher.config');
  const publisherScriptPath = projectPath(project, publisher.script, 'settings.publisher.script');
  const secretsPath = projectPath(project, settings.secrets_path, 'settings.secrets_path');
  await ensurePrivatePath(configDirectory, 'directory');
  await ensurePrivatePath(publisherConfigPath, 'file');
  if (withSecrets) await ensurePrivatePath(secretsPath, 'file');
  await noSymlinkFile(publisherScriptPath, 'publisher script');
  const publisherConfig = await readPrivateJson(publisherConfigPath);
  const account = validateAccount(publisherConfig.account);
  comparePath(publisherConfig.project_dir, project, 'publisher.project_dir');
  const systemPath = join(configDirectory, 'system.yaml');
  await ensurePrivatePath(systemPath, 'system config');
  const systemText = await readFile(systemPath, 'utf8');
  let parsedSystem;
  try {
    parsedSystem = parse(systemText);
  } catch {
    throw new Error(`Unable to read private YAML at ${systemPath}`);
  }
  if (!parsedSystem || typeof parsedSystem !== 'object' || Array.isArray(parsedSystem)) throw new Error('Local publish system config must be a YAML object');
  const loadedPaths = validateSystemConfig(parsedSystem, project);
  const built = buildPublishSystemConfig(systemText, project);
  for (const key of Object.keys(loadedPaths)) comparePath(loadedPaths[key], built.paths[key], `system.${key}`);
  const engineOutbox = settings.engine?.outbox;
  comparePath(settings.engine?.database_path, loadedPaths.databasePath, 'settings.engine.database_path');
  const settingsPaths = {
    pending_path: loadedPaths.pendingPath,
    acknowledged_path: loadedPaths.acknowledgedPath,
    failed_path: loadedPaths.failedPath,
    handoff_path: loadedPaths.handoffPath,
    operation_lock_path: join(loadedPaths.handoffPath, 'publish-operation.lock'),
  };
  for (const [key, expected] of Object.entries(settingsPaths)) comparePath(engineOutbox?.[key], expected, `settings.engine.outbox.${key}`);
  comparePath(publisherConfig.pending_dir, loadedPaths.pendingPath, 'publisher.pending_dir');
  comparePath(publisherConfig.handoff_dir, loadedPaths.handoffPath, 'publisher.handoff_dir');
  comparePath(publisherConfig.lock_path ?? join(loadedPaths.handoffPath, 'publisher.lock'), join(loadedPaths.handoffPath, 'publisher.lock'), 'publisher.lock_path');
  comparePath(publisherConfig.state_path ?? join(loadedPaths.handoffPath, 'publisher-state.json'), join(loadedPaths.handoffPath, 'publisher-state.json'), 'publisher.state_path');
  comparePath(publisherConfig.operation_lock_path ?? join(loadedPaths.handoffPath, 'publish-operation.lock'), join(loadedPaths.handoffPath, 'publish-operation.lock'), 'publisher.operation_lock_path');
  if (!Array.isArray(publisherConfig.allowed_domains) || publisherConfig.allowed_domains.length !== 1 || publisherConfig.allowed_domains[0] !== 'www.moltbook.com') throw new Error('Publisher allowed_domains must contain only www.moltbook.com');
  const caps = validatePublisherCaps(publisherConfig);
  const secrets = withSecrets ? await readPrivateJson(secretsPath) : undefined;
  if (settings.account !== undefined && settings.account !== account) throw new Error('Top-level publishing account does not match publisher-config account');
  return { project, paths, settings, publisher, publisherConfig, account, system: parsedSystem, loadedPaths, secrets, caps };
}

async function readPublishState(bundle) {
  const path = bundle.publisherConfig.state_path ?? join(bundle.loadedPaths.handoffPath, 'publisher-state.json');
  try {
    await ensurePrivatePath(path, 'publisher state');
  } catch (error) {
    if (error?.code === 'ENOENT') return { date: undefined, published: 0 };
    throw error;
  }
  const value = await readPrivateJson(path);
  if (value.date !== undefined && typeof value.date !== 'string') throw new Error('Publisher state date is invalid');
  if (!Number.isSafeInteger(value.published ?? 0) || (value.published ?? 0) < 0) throw new Error('Publisher state published count is invalid');
  return { date: value.date, published: value.published ?? 0 };
}

async function jsonFiles(path) {
  if (!await noSymlinkDirectory(path, 'publisher state directory')) return [];
  return (await readdir(path, { withFileTypes: true }))
    .filter((entry) => entry.isFile() && entry.name.endsWith('.json'))
    .map((entry) => join(path, entry.name));
}

async function parseStateFile(path) {
  try {
    const value = JSON.parse(await readFile(path, 'utf8'));
    if (!value || typeof value !== 'object' || Array.isArray(value)) throw new Error('object expected');
    return value;
  } catch {
    throw new Error(`Unresolved publisher state file: ${path}`);
  }
}

export async function findOutstandingPublisherWork(bundle) {
  const blockers = [];
  for (const path of await jsonFiles(bundle.loadedPaths.pendingPath)) {
    const value = await parseStateFile(path);
    if (value.action === 'COMMENT') blockers.push(`pending COMMENT ${value.action_id ?? path}`);
    else if (value.action !== 'NO_ACTION') blockers.push(`pending unknown action ${path}`);
  }
  const requestsPath = join(bundle.loadedPaths.handoffPath, 'requests');
  const receiptsPath = join(bundle.loadedPaths.handoffPath, 'receipts');
  const receipts = new Map();
  for (const path of await jsonFiles(receiptsPath)) receipts.set(path.split('/').pop().replace(/\.json$/u, ''), await parseStateFile(path));
  for (const path of await jsonFiles(requestsPath)) {
    const requestId = path.split('/').pop().replace(/\.json$/u, '');
    const receipt = receipts.get(requestId);
    if (!receipt || !SAFE_TERMINAL_STATUSES.has(String(receipt.status))) blockers.push(`unresolved publisher request ${requestId}`);
  }
  const attemptsPath = join(bundle.loadedPaths.handoffPath, 'attempts');
  for (const path of await jsonFiles(attemptsPath)) {
    const value = await parseStateFile(path);
    const status = String(value.status ?? '').toUpperCase();
    if (status && !SAFE_TERMINAL_STATUSES.has(status)) blockers.push(`unresolved publisher attempt ${value.attemptId ?? path}`);
  }
  return blockers;
}

export async function acquireOperationLock(path, { root = projectRoot, now = () => new Date() } = {}) {
  const lockPath = projectPath(root, path, 'publisher operation lock');
  await mkdir(join(resolve(root), 'outbox', 'handoff'), { recursive: true, mode: 0o700 });
  let handle;
  try {
    handle = await open(lockPath, 'wx', 0o600);
    await handle.writeFile(`${JSON.stringify({ schema_version: '1', pid: process.pid, started_at: now().toISOString() })}\n`, 'utf8');
    await handle.sync();
  } catch (error) {
    await handle?.close().catch(() => undefined);
    if (error?.code === 'EEXIST') throw new Error(`Publisher operation lock is already held: ${lockPath}`);
    throw error;
  }
  let released = false;
  return {
    path: lockPath,
    async release() {
      if (released) return;
      released = true;
      await handle.close();
      await unlink(lockPath);
    },
  };
}

export async function trackerReadOnlyCheck({ system, secrets, fetcher = globalThis.fetch } = {}) {
  const tracker = system?.tracking?.production;
  const baseUrl = tracker?.base_url;
  if (typeof baseUrl !== 'string' || new URL(baseUrl).origin !== 'https://marx-tracker.marxx.workers.dev') throw new Error('Production tracker base URL is not the approved origin');
  const tokenName = tracker?.token_environment_variable ?? 'MARX_TRACKER_API_TOKEN';
  const token = secrets?.[tokenName] ?? secrets?.MARX_TRACKER_API_TOKEN;
  if (typeof token !== 'string' || !token.trim()) throw new Error('Production tracker token is unavailable');
  if (typeof fetcher !== 'function') throw new Error('Tracker read-only check requires fetch');
  const response = await fetcher(`${new URL(baseUrl).origin}/health`, { method: 'GET', headers: { accept: 'application/json', authorization: `Bearer ${token}` } });
  if (!response?.ok) throw new Error(`Production tracker read-only check failed (HTTP ${response?.status ?? 'unknown'})`);
  return { status: 'PASS', method: 'GET', endpoint: `${new URL(baseUrl).origin}/health` };
}

async function runStep(steps, name, operation) {
  await operation();
  steps.push({ name, status: 'PASS' });
}

async function runChecks(bundle, article, source, runner, steps, { tracker = trackerReadOnlyCheck } = {}) {
  const cliPath = join(bundle.project, 'dist', 'cli', 'main.js');
  await runStep(steps, 'public/article/model', () => runNode([cliPath, 'doctor', '--public-read', '--article-url', article, '--model-smoke'], { root: bundle.project, env: safeEnvironment(source, { MARX_GROWTH_CONFIG_DIR: bundle.settings.config_directory, MARX_GROWTH_DB: bundle.settings.engine.database_path }), runner }));
  await runStep(steps, 'source-read', () => runNode([cliPath, 'doctor', '--live-read'], { root: bundle.project, env: safeEnvironment(source, { MARX_GROWTH_CONFIG_DIR: bundle.settings.config_directory, MARX_GROWTH_DB: bundle.settings.engine.database_path }, ['MOLTBOOK_API_KEY'], bundle.secrets), runner }));
  await runStep(steps, 'publisher-python-check', () => runner.run({ command: bundle.publisher.python, args: [bundle.publisher.script, '--config', bundle.publisher.config, '--check'], cwd: bundle.project, env: safeEnvironment(source, { MARX_GROWTH_CONFIG_DIR: bundle.settings.config_directory, MARX_GROWTH_DB: bundle.settings.engine.database_path }, ['MOLTBOOK_API_KEY'], bundle.secrets) }));
  await runStep(steps, 'tracker-authenticated-read', () => tracker({ system: bundle.system, secrets: bundle.secrets }));
}

function productionEngineEnvironment(bundle, source) {
  return safeEnvironment(source, {
    MARX_GROWTH_CONFIG_DIR: bundle.settings.config_directory,
    MARX_GROWTH_DB: bundle.settings.engine.database_path,
    MARX_GROWTH_NODE: process.execPath,
    MOLTBOOK_PUBLISHER_CONFIG: bundle.publisher.config,
    MOLTBOOK_PUBLISHER_SCRIPT: bundle.publisher.script,
    MOLTBOOK_PUBLISHER_PYTHON: bundle.publisher.python,
  }, SECRET_KEYS, bundle.secrets);
}

export async function publishOnce({
  argv = process.argv.slice(2),
  root = projectRoot,
  env = process.env,
  runCommand,
  trackerCheck,
  propagateSignal = (signal) => process.kill(process.pid, signal),
  signalEmitter = process,
} = {}) {
  ensureNode22();
  const controls = controlArgs(argv);
  const commandRunner = runCommand ? { run: runCommand, terminate: () => undefined } : createCommandRunner();
  if (controls.stop) {
    const bundle = await loadPublishBundle(root, { withSecrets: false });
    const stopEnv = safeEnvironment(env, { MARX_GROWTH_CONFIG_DIR: bundle.settings.config_directory, MARX_GROWTH_DB: bundle.settings.engine.database_path });
    await runNode([join(bundle.project, 'dist', 'cli', 'main.js'), 'ops', 'kill-engage', '--reason', controls.reason, '--actor', 'operator'], { root: bundle.project, env: stopEnv, runner: commandRunner });
    return { mode: 'stop', status: 'PASS', kill: 'ENGAGED' };
  }
  const bundle = await loadPublishBundle(root);
  const planArgs = [...controls.remaining];
  if (!planArgs.includes('--actions') && !planArgs.some((value) => value.startsWith('--actions='))) planArgs.push('--actions', '1');
  const actionCount = requestedActions(planArgs, bundle.caps.maxActions, bundle.caps.dailyCap);
  const plan = livePlan(planArgs.includes('--publish') ? planArgs : [...planArgs, '--publish']);
  const articleArgIndex = plan.run.findIndex((value) => value === '--article-url');
  const articleUrl = articleArgIndex >= 0 ? plan.run[articleArgIndex + 1] : undefined;
  if (!articleUrl) throw new Error('Publishing requires --article-url https://marx.finance/feed/FEED_ID');
  const steps = [];
  if (controls.checkOnly) {
    await runChecks(bundle, articleUrl, env, commandRunner, steps, { tracker: trackerCheck ?? trackerReadOnlyCheck });
    return { mode: 'check-only', status: 'PASS', actionCount, steps };
  }
  const state = await readPublishState(bundle);
  if (state.date === new Date().toISOString().slice(0, 10) && state.published >= bundle.caps.dailyCap) throw new Error('Publisher daily_comment_cap has already been reached');
  const blockers = await findOutstandingPublisherWork(bundle);
  if (blockers.length > 0) throw new Error(`Previous publisher work requires reconciliation: ${blockers.join('; ')}`);
  const lock = await acquireOperationLock(bundle.publisherConfig.operation_lock_path, { root: bundle.project });
  let receivedSignal;
  const onSignal = (signal) => {
    receivedSignal ??= signal;
    commandRunner.terminate?.(signal);
  };
  signalEmitter.once('SIGINT', onSignal);
  signalEmitter.once('SIGTERM', onSignal);
  let runError;
  let cleanupError;
  try {
    await runChecks(bundle, articleUrl, env, commandRunner, steps, { tracker: trackerCheck ?? trackerReadOnlyCheck });
    const engineEnv = productionEngineEnvironment(bundle, env);
    const cliPath = join(bundle.project, 'dist', 'cli', 'main.js');
    await runStep(steps, 'kill-clearance-create', () => runNode([cliPath, 'ops', 'kill-clearance-create', '--output', join(bundle.paths.directory, 'clearance.json'), '--minutes', '30', '--reason', 'bounded operator-approved publication pilot', '--actor', bundle.account], { root: bundle.project, env: engineEnv, runner: commandRunner }));
    await runStep(steps, 'kill-clear', () => runNode([cliPath, 'ops', 'kill-clear', '--clearance', join(bundle.paths.directory, 'clearance.json')], { root: bundle.project, env: engineEnv, runner: commandRunner }));
    await runStep(steps, 'autonomous-doctor', () => runNode([cliPath, 'doctor', '--autonomous', '--publisher', '--model-smoke', '--live-read'], { root: bundle.project, env: engineEnv, runner: commandRunner }));
    // marx-specific-cycle owns the single downstream publisher invocation.
    await runStep(steps, 'engine-specific-cycle', () => runNode([cliPath, ...plan.run], { root: bundle.project, env: engineEnv, runner: commandRunner }));
  } catch (error) {
    runError = error;
  } finally {
    try {
      const cleanupEnv = safeEnvironment(env, { MARX_GROWTH_CONFIG_DIR: bundle.settings.config_directory, MARX_GROWTH_DB: bundle.settings.engine.database_path });
      await runNode([join(bundle.project, 'dist', 'cli', 'main.js'), 'ops', 'kill-engage', '--reason', runError ? 'publication attempt stopped; reconcile before retry' : 'publication pilot completed', '--actor', 'operator'], { root: bundle.project, env: cleanupEnv, runner: commandRunner });
      steps.push({ name: 'kill-engage', status: 'PASS' });
    } catch (error) {
      cleanupError = error;
      steps.push({ name: 'kill-engage', status: 'FAIL' });
    }
    signalEmitter.removeListener('SIGINT', onSignal);
    signalEmitter.removeListener('SIGTERM', onSignal);
    await lock.release();
  }
  if (cleanupError) throw new Error(`Publisher cleanup failed; kill switch state is not verified: ${cleanupError.message}`);
  if (receivedSignal) {
    await propagateSignal(receivedSignal);
    throw new Error(`Publishing interrupted by ${receivedSignal}`);
  }
  if (runError) throw runError;
  return { mode: 'publish', status: 'PASS', actionCount, steps };
}

export const publishHelp = 'Usage: npm run publish -- --article-url https://marx.finance/feed/FEED_ID [--actions N] [--limit N] [--search-limit N] [--check-only | --stop]';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--help')) console.log(publishHelp);
  else publishOnce().then((result) => console.log(JSON.stringify(result, null, 2))).catch((error) => { console.error(error.message); process.exitCode = 1; });
}
