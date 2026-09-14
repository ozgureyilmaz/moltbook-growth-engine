import { existsSync } from 'node:fs';
import { lstat, readFile } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureNode22, projectRoot } from './runtime.mjs';
import {
  buildPublishSettings,
  buildPublishSystemConfig,
  buildPublisherConfig,
  canonicalProjectPaths,
  collectPublishSecrets,
  createPrivateDirectory,
  requirePython3,
  serializeYaml,
  validateAccount,
  writeExclusiveAtomic,
} from './publish-config.mjs';

export function parseSetupPublishArgs(argv) {
  let account;
  let help = false;
  for (let index = 0; index < argv.length; index += 1) {
    const value = argv[index];
    if (value === '--help' || value === '-h') {
      help = true;
      continue;
    }
    if (value !== '--account' || account !== undefined) throw new Error('Usage: npm run setup:publish -- --account CLAIMED_AGENT');
    const next = argv[index + 1];
    if (!next || next.startsWith('--')) throw new Error('--account requires a value');
    account = next;
    index += 1;
  }
  if (help) return { help: true };
  if (account === undefined) throw new Error('Usage: npm run setup:publish -- --account CLAIMED_AGENT');
  validateAccount(account);
  return { account, help: false };
}

export const setupPublishHelp = 'Usage: npm run setup:publish -- --account CLAIMED_AGENT\nCreates a private, local publishing configuration and secrets file. It never publishes or copies another operator\'s credentials.';

async function readOptional(path, fallback = '{}\n') {
  if (!existsSync(path)) return fallback;
  return readFile(path, 'utf8');
}

async function assertFreshPublishDirectory(project) {
  const localDirectory = join(project, '.local');
  const publishDirectory = join(localDirectory, 'publish');
  const candidates = [
    localDirectory,
    publishDirectory,
    join(publishDirectory, 'config'),
    join(publishDirectory, 'settings.json'),
    join(publishDirectory, 'secrets.json'),
    join(publishDirectory, 'publisher-config.json'),
  ];
  for (const path of candidates) {
    try {
      const info = await lstat(path);
      if (info.isSymbolicLink()) throw new Error(`Refusing symbolic link in private publishing path: ${path}`);
      if (path === localDirectory && !info.isDirectory()) throw new Error(`Expected private directory: ${path}`);
      if (path !== localDirectory) throw new Error(`Local publishing setup already exists at ${path}; review it instead of overwriting it`);
    } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

export async function setupPublish({
  argv = [],
  root = projectRoot,
  env = process.env,
  python = 'python3',
  pythonExecutor,
  promptSecret,
  publisherScript,
} = {}) {
  const parsed = parseSetupPublishArgs(argv);
  if (parsed.help) return { help: true, message: setupPublishHelp };
  if (process.platform === 'win32') throw new Error('Publishing requires a POSIX host; Windows is not supported');
  const project = resolve(root);
  // Refuse an existing operator setup before checking credentials or prompting
  // for secrets. A failed rerun must never create a second credential bundle.
  await assertFreshPublishDirectory(project);
  const pythonBinary = requirePython3(python, pythonExecutor);
  const script = resolve(publisherScript ?? join(project, 'integrations/moltbook-publisher/publish.py'));
  if (!existsSync(script)) throw new Error(`Bundled publisher script was not found at ${script}`);

  const sourceConfigDirectory = join(project, 'config');
  const systemSource = await readOptional(join(sourceConfigDirectory, 'system.yaml'));
  const { system, paths } = buildPublishSystemConfig(systemSource, project);
  const secrets = collectPublishSecrets({
    env,
    python: pythonBinary,
    ...(promptSecret ? { promptSecret } : {}),
  });

  const localDirectory = join(project, '.local');
  const publishDirectory = join(localDirectory, 'publish');
  await createPrivateDirectory(localDirectory);
  // mkdir without recursive is intentional: setup must never replace a prior
  // operator configuration or silently merge credentials into it.
  await createPrivateDirectory(publishDirectory);
  const configDirectory = join(publishDirectory, 'config');
  await createPrivateDirectory(configDirectory);

  await writeExclusiveAtomic(join(configDirectory, 'system.yaml'), serializeYaml(system), 0o600);
  for (const name of ['submolts.yaml', 'experiments.yaml', 'feed.yaml']) {
    const source = await readOptional(join(sourceConfigDirectory, name));
    await writeExclusiveAtomic(join(configDirectory, name), source, 0o600);
  }

  const publisherConfigPath = join(publishDirectory, 'publisher-config.json');
  const publisherConfig = buildPublisherConfig(parsed.account, project, { paths });
  await writeExclusiveAtomic(publisherConfigPath, `${JSON.stringify(publisherConfig, null, 2)}\n`, 0o600);

  const secretsPath = join(publishDirectory, 'secrets.json');
  await writeExclusiveAtomic(secretsPath, `${JSON.stringify(secrets, null, 2)}\n`, 0o600);
  const settingsPath = join(publishDirectory, 'settings.json');
  const settings = buildPublishSettings({
    account: parsed.account,
    root: project,
    python: pythonBinary,
    script,
    configDirectory,
    publisherConfig: publisherConfigPath,
    secretsPath,
    paths,
  });
  await writeExclusiveAtomic(settingsPath, `${JSON.stringify(settings, null, 2)}\n`, 0o600);

  return {
    help: false,
    account: parsed.account,
    directory: publishDirectory,
    configDirectory,
    publisherConfig: publisherConfigPath,
    secretsPath,
    settingsPath,
    // Report paths only. Never include secret values in this result.
    paths: canonicalProjectPaths(project, system),
  };
}

async function main() {
  ensureNode22();
  const result = await setupPublish({ argv: process.argv.slice(2) });
  if (result.help) {
    console.log(result.message);
    return;
  }
  console.log(`Private publishing configuration prepared for ${result.account}.\nConfig: ${result.configDirectory}\nPublisher: ${result.publisherConfig}\nSecrets: ${result.secretsPath}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
