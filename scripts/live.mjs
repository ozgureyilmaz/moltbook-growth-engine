import { existsSync } from 'node:fs';
import { pathToFileURL } from 'node:url';
import { ensureNode22, cliPath, runNode } from './runtime.mjs';

export function normalizeArticleUrl(input) {
  const text = (input ?? '').trim();
  const markdown = /^\[([^\]\r\n]*)\]\((https:\/\/[^\s()]+)\)$/.exec(text);
  if (markdown && /^https?:\/\//.test(markdown[1]) && markdown[1] !== markdown[2]) {
    throw new Error('The Markdown label and destination differ. Paste the plain Marx URL.');
  }
  const url = markdown ? markdown[2] : text;
  if (!/^https:\/\/marx\.finance\/feed\/[A-Za-z0-9_-]+$/.test(url)) throw new Error('Provide --article-url https://marx.finance/feed/FEED_ID');
  return url;
}

export function livePlan(argv) {
  const options = new Map();
  const allowed = new Set(['article-url', 'limit', 'actions', 'search-limit', 'output', 'with-agent-quotes', 'no-agent-quotes']);
  const booleanFlags = new Set(['with-agent-quotes', 'no-agent-quotes']);
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
    if (booleanFlags.has(key) && match[2] === undefined && (!argv[i + 1] || argv[i + 1].startsWith('--'))) {
      options.set(key, 'true');
      continue;
    }
    const value = match[2] ?? argv[++i];
    if (!value || value.startsWith('--')) throw new Error(`--${key} requires a value`);
    if (booleanFlags.has(key) && value !== 'true' && value !== 'false') throw new Error(`--${key} must be true or false`);
    options.set(key, value);
  }
  const article = normalizeArticleUrl(options.get('article-url'));
  options.set('article-url', article);
  for (const key of ['limit', 'actions', 'search-limit']) {
    if (options.has(key) && (!/^\d+$/.test(options.get(key)) || !Number.isSafeInteger(Number(options.get(key))) || Number(options.get(key)) < 1)) {
      throw new Error(`--${key} must be a positive integer`);
    }
  }
  if (!options.has('limit')) options.set('limit', '8');
  if (!options.has('actions')) options.set('actions', '5');
  if (!options.has('search-limit')) options.set('search-limit', '10');
  if (!options.has('output')) options.set('output', 'reports/');
  if (options.get('with-agent-quotes') === 'true' && options.get('no-agent-quotes') === 'true') throw new Error('Choose either --with-agent-quotes or --no-agent-quotes');
  if (!options.get('output').endsWith('.md') && !options.get('output').endsWith('/')) options.set('output', `${options.get('output')}/`);
  const values = [...options].flatMap(([key, value]) => booleanFlags.has(key) ? (value === 'true' ? [`--${key}`] : []) : [`--${key}`, value]);
  const doctor = ['doctor', '--public-read', '--article-url', article, '--model-smoke'];
  if (publish) doctor.push('--live-read', '--autonomous', '--publisher');
  return {
    publish,
    doctor,
    run: publish
      ? ['marx-specific-cycle', ...values, '--real-model', '--publish']
      : ['article-run', ...values, '--dry-run', '--real-model', ...(options.get('with-agent-quotes') === 'true' ? ['--with-agent-quotes'] : ['--no-agent-quotes'])],
  };
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try {
    ensureNode22();
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
