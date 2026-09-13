import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { assertNode, cliPath, runNode } from './runtime.mjs';

export function livePlan(argv) {
  const options = new Map();
  const allowed = new Set(['article-url', 'limit', 'actions', 'search-limit', 'output']);
  let publish = false;
  for (let i = 0; i < argv.length; i += 1) {
    if (argv[i] === '--publish') {
      if (publish) throw new Error('Duplicate --publish');
      publish = true;
      continue;
    }
    const match = /^--([a-z-]+)(?:=(.*))?$/.exec(argv[i]);
    if (!match || !allowed.has(match[1])) throw new Error(`Unsupported option: ${argv[i]}`);
    const key = match[1];
    if (options.has(key)) throw new Error(`Duplicate --${key}`);
    const value = match[2] ?? argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`--${key} requires a value`);
    options.set(key, value);
  }
  const article = options.get('article-url');
  if (!article || !/^https:\/\/marx\.finance\/feed\/[A-Za-z0-9_-]+$/.test(article)) {
    throw new Error('Provide --article-url https://marx.finance/feed/FEED_ID');
  }
  for (const key of ['limit', 'actions', 'search-limit']) {
    if (options.has(key) && (!/^\d+$/.test(options.get(key)) || !Number.isSafeInteger(Number(options.get(key))) || Number(options.get(key)) < 1)) {
      throw new Error(`--${key} must be a positive integer`);
    }
  }
  if (!options.has('limit')) options.set('limit', '8');
  if (!options.has('actions')) options.set('actions', '5');
  if (!options.has('search-limit')) options.set('search-limit', '10');
  if (!options.has('output')) options.set('output', 'reports/');
  if (!options.get('output').endsWith('.md') && !options.get('output').endsWith('/')) options.set('output', `${options.get('output')}/`);
  const values = [...options].flatMap(([key, value]) => [`--${key}`, value]);
  const doctor = ['doctor', '--public-read', '--article-url', article, '--model-smoke'];
  if (publish) doctor.push('--live-read', '--autonomous', '--publisher');
  return {
    publish,
    doctor,
    run: publish
      ? ['marx-specific-cycle', ...values, '--real-model', '--publish']
      : ['article-run', ...values, '--dry-run', '--real-model', '--no-agent-quotes'],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    assertNode();
    if (process.argv.includes('--help')) {
      console.log('Usage: npm run live -- --article-url https://marx.finance/feed/FEED_ID [--limit N] [--actions N] [--search-limit N] [--output PATH] [--publish]\nReads live data and uses real models. Publishing requires a separate local production configuration and publisher setup.');
    } else {
      const plan = livePlan(process.argv.slice(2));
      if (!existsSync(cliPath)) throw new Error('Build is missing. Run npm run setup first.');
      console.log(plan.publish ? 'Checking production dependencies before publishing…' : 'Checking public sources and actual model access…');
      runNode([cliPath, ...plan.doctor]);
      runNode([cliPath, ...plan.run]);
    }
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
