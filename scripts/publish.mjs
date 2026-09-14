import { existsSync } from 'node:fs';
import { spawnSync } from 'node:child_process';
import { join, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import { ensureNode22, cliPath, projectRoot } from './runtime.mjs';
import { livePlan } from './live.mjs';
import { readPrivateJson, ensurePrivatePath } from './publish-config.mjs';

export function publishPaths(root = projectRoot) {
  const directory = join(root, '.local', 'publish');
  return { directory, settings: join(directory, 'settings.json'), secrets: join(directory, 'secrets.json') };
}

function runNode(args, env, capture = false) {
  const result = spawnSync(process.execPath, args, { cwd: projectRoot, env, stdio: capture ? ['inherit', 'pipe', 'inherit'] : 'inherit', encoding: 'utf8' });
  if (result.error) throw result.error;
  if (result.status !== 0) throw new Error(`Publishing step failed (${result.status ?? result.signal ?? 'unknown'})`);
  return result;
}

export async function publishOnce({ argv = process.argv.slice(2), root = projectRoot, env = process.env } = {}) {
  ensureNode22();
  // The npm script itself is the explicit publication opt-in; accept an
  // optional --publish for symmetry with the lower-level live wrapper.
  const plan = livePlan(argv.includes('--publish') ? argv : [...argv, '--publish']);
  const paths = publishPaths(root);
  await ensurePrivatePath(paths.settings, 'file');
  await ensurePrivatePath(paths.secrets, 'file');
  const settings = await readPrivateJson(paths.settings);
  const secrets = await readPrivateJson(paths.secrets);
  const publisher = settings.publisher;
  if (settings.project_dir !== resolve(root) || settings.account !== publisher?.account) throw new Error('Local publishing settings do not belong to this clone/account');
  const required = [publisher?.python, publisher?.script, publisher?.config, secrets.MOLTBOOK_API_KEY, secrets.MARX_TRACKER_API_TOKEN, secrets.MOLTBOOK_PUBLISHER_CONTRACT_SECRET];
  if (required.some((value) => typeof value !== 'string' || value.trim() === '') || !existsSync(publisher.script) || !existsSync(publisher.config)) throw new Error('Local publishing setup is incomplete; rerun npm run setup:publish');
  const runtimeEnv = { ...env, MARX_GROWTH_CONFIG_DIR: settings.config_directory, MARX_GROWTH_DB: settings.engine.database_path, MOLTBOOK_API_KEY: secrets.MOLTBOOK_API_KEY, MARX_TRACKER_API_TOKEN: secrets.MARX_TRACKER_API_TOKEN, MOLTBOOK_PUBLISHER_CONTRACT_SECRET: secrets.MOLTBOOK_PUBLISHER_CONTRACT_SECRET, MOLTBOOK_PUBLISHER_CONFIG: publisher.config, MOLTBOOK_PUBLISHER_SCRIPT: publisher.script, MOLTBOOK_PUBLISHER_PYTHON: publisher.python, MARX_GROWTH_NODE: process.execPath };
  let success = false;
  try {
    // The default kill switch is engaged. Run non-autonomous checks first;
    // clear a fresh signed window only after identity/config/source checks pass.
    runNode([cliPath, 'doctor', '--public-read', '--model-smoke', '--live-read', '--publisher'], runtimeEnv);
    const identity = spawnSync(publisher.python, [publisher.script, '--config', publisher.config, '--check'], { cwd: projectRoot, env: runtimeEnv, stdio: 'inherit' });
    if (identity.error || identity.status !== 0) throw new Error('Publisher identity check failed; no publication attempted');
    runNode([cliPath, 'ops', 'kill-clearance-create', '--output', join(paths.directory, 'clearance.json'), '--minutes', '30', '--reason', 'bounded operator-approved publication pilot', '--actor', settings.account], runtimeEnv);
    runNode([cliPath, 'ops', 'kill-clear', '--clearance', join(paths.directory, 'clearance.json')], runtimeEnv);
    runNode([cliPath, 'doctor', '--autonomous', '--publisher', '--model-smoke', '--live-read'], runtimeEnv);
    runNode([cliPath, ...plan.run], runtimeEnv);
    success = true;
  } finally {
    try { runNode([cliPath, 'ops', 'kill-engage', '--reason', success ? 'publication pilot completed' : 'publication attempt stopped; reconcile before retry'], runtimeEnv); } catch (error) { console.error(`WARNING: kill-switch cleanup failed: ${error.message}`); }
  }
}

export const publishHelp = 'Usage: npm run publish -- --article-url https://marx.finance/feed/FEED_ID [--actions N] [--limit N] [--search-limit N]';

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  if (process.argv.includes('--help')) console.log(publishHelp);
  else publishOnce().catch((error) => { console.error(error.message); process.exitCode = 1; });
}
