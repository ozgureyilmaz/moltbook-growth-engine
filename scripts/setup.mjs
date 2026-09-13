import { mkdtempSync, mkdirSync, copyFileSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { ensureNode22, cliPath, projectRoot, runNode, runNpm } from './runtime.mjs';

try {
  ensureNode22();
  console.log('Installing locked dependencies with the current Node 22 runtime…');
  runNpm(['ci']);
  runNpm(['run', 'build']);
  // Keep rehearsal state and inherited production settings out of the operator database.
  const directory = mkdtempSync(join(tmpdir(), 'marx-setup-'));
  const config = join(directory, 'config');
  mkdirSync(config);
  for (const name of ['submolts.yaml', 'experiments.yaml']) copyFileSync(join(projectRoot, 'config', name), join(config, name));
  const { parse, stringify } = await import('yaml');
  const settings = parse(readFileSync(join(projectRoot, 'config/system.yaml'), 'utf8'));
  settings.source.mode = 'disabled';
  settings.publishing.enabled = false;
  settings.publisher_bridge.enabled = false;
  settings.storage.strategy_stats_path = join(directory, 'strategy-stats.json');
  const experiments = parse(readFileSync(join(config, 'experiments.yaml'), 'utf8'));
  if (experiments.tracking) experiments.tracking.strategy_stats_path = join(directory, 'strategy-stats.json');
  writeFileSync(join(config, 'experiments.yaml'), stringify(experiments));
  settings.observability.run_log_directory = join(directory, 'logs');
  settings.observability.error_log_directory = join(directory, 'errors');
  writeFileSync(join(config, 'system.yaml'), stringify(settings));
  runNode([cliPath, 'run', '--fixture', join(projectRoot, 'tests/fixtures/moltbook.json'), '--dry-run', '--real-model=false'], {
    env: { ...process.env, MARX_GROWTH_CONFIG_DIR: config, MARX_GROWTH_DB: join(directory, 'smoke.sqlite') },
  });
  console.log(`Setup passed. Fixture evidence: ${directory}\nNext: authenticate Codex, then npm run doctor:live. See README.md.`);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
