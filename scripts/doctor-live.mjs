import { ensureNode22, cliPath, runNode } from './runtime.mjs';

try {
  ensureNode22();
  runNode([cliPath, 'doctor', '--public-read', '--model-smoke', ...process.argv.slice(2)]);
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
