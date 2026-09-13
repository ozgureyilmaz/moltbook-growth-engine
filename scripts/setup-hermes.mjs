import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { assertNode, projectRoot } from './runtime.mjs';

export function shellQuote(value) { return `'${value.replaceAll("'", "'\\''")}'`; }

export function hermesConfig(account, root) {
  if (!/^[A-Za-z0-9_-]+$/.test(account)) throw new Error('--account must be the claimed agent name (letters, numbers, underscores, hyphens)');
  return {
    account,
    project_dir: resolve(root),
    pending_dir: resolve(root, 'outbox/pending'),
    handoff_dir: resolve(root, 'outbox/handoff'),
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
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assertNode();
    if (process.argv.includes('--help')) {
      console.log('Usage: npm run setup:hermes -- --account CLAIMED_AGENT [--publisher-script /absolute/path/publish_moltbook_action.py]\nGenerates ignored local configuration and env.sh; never installs Hermes, copies credentials, enables publishing, or starts a service. The supplied publisher uses macOS Keychain.');
    } else {
      if (process.platform !== 'darwin') throw new Error('The current external publisher requires macOS Keychain. Use macOS for publishing; public live drafts do not require Hermes.');
      const args = process.argv.slice(2);
      const options = new Map();
      for (let i = 0; i < args.length; i += 2) {
        if (!['--account', '--publisher-script'].includes(args[i]) || !args[i + 1] || args[i + 1].startsWith('--') || options.has(args[i])) throw new Error('Usage: npm run setup:hermes -- --account CLAIMED_AGENT [--publisher-script PATH]');
        options.set(args[i], args[i + 1]);
      }
      const config = hermesConfig(options.get('--account') ?? '', projectRoot);
      const home = process.env.HERMES_HOME ?? join(homedir(), '.hermes');
      const script = resolve(options.get('--publisher-script') ?? join(home, 'skills/automation/moltbook-deterministic-publisher/scripts/publish_moltbook_action.py'));
      if (!existsSync(script)) throw new Error('Reviewed publisher script not found. Install the team-supplied moltbook-deterministic-publisher skill first; see README.md.');
      const local = join(projectRoot, '.local');
      const configDirectory = join(local, 'config');
      const publisherConfig = join(local, 'hermes/moltbook-publisher.json');
      const environment = join(local, 'hermes/env.sh');
      if (existsSync(publisherConfig) || existsSync(environment)) throw new Error('Local Hermes config already exists. Review/edit .local/hermes instead of overwriting an existing operator setup.');
      const { parse, stringify } = await import('yaml');
      mkdirSync(configDirectory, { recursive: true, mode: 0o700 });
      mkdirSync(join(local, 'hermes'), { recursive: true, mode: 0o700 });
      for (const name of ['system.yaml', 'submolts.yaml', 'experiments.yaml', 'feed.yaml'].filter((name) => existsSync(join(projectRoot, 'config', name)))) {
        const target = join(configDirectory, name);
        if (existsSync(target)) continue;
        let text = readFileSync(join(projectRoot, 'config', name), 'utf8');
        if (name === 'system.yaml') {
          const system = parse(text);
          system.source.mode = 'live_read_only';
          system.publishing.enabled = false;
          system.publisher_bridge.enabled = false;
          system.execution.dry_run_by_default = true;
          text = stringify(system);
        }
        writeFileSync(target, text, { flag: 'wx', mode: 0o600 });
      }
      writeFileSync(publisherConfig, JSON.stringify(config, null, 2) + '\n', { flag: 'wx', mode: 0o600 });
      const exports = {
        MARX_GROWTH_CONFIG_DIR: configDirectory,
        MARX_GROWTH_NODE: process.execPath,
        MOLTBOOK_PUBLISHER_PYTHON: process.env.MOLTBOOK_PUBLISHER_PYTHON ?? 'python3',
        MOLTBOOK_PUBLISHER_SCRIPT: script,
        MOLTBOOK_PUBLISHER_CONFIG: publisherConfig,
      };
      writeFileSync(environment, '# Local paths only; no credentials.\n' + Object.entries(exports).map(([key, value]) => `export ${key}=${shellQuote(value)}\n`).join(''), { flag: 'wx', mode: 0o600 });
      console.log(`Local config prepared: ${publisherConfig}\nLoad paths: source ${shellQuote(environment)}\nPublishing was not enabled. Complete the README credential, validation, and activation steps.`);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
