import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { runDev } from './dev.mjs';
import { createSharedBuilder } from './shared-build.mjs';

// All processes and shared state belong to the disposable root supplied by the test.
const [root, failure] = process.argv.slice(2);
const report = (event) => process.stdout.write(`fixture ${JSON.stringify(event)}\n`);
const compiler = fileURLToPath(new URL('./dev-compiler-fixture.mjs', import.meta.url));
const missing = join(root, 'missing-dev-executable');
const shared = await createSharedBuilder({ root, pollMs: 30 }).watchShared();
let api;
const apiBody =
  failure === 'early'
    ? 'process.exit(7)'
    : "console.log('ready'); process.stdin.once('data', () => process.exit(7)); setInterval(() => {}, 1000);";
const session = await runDev('all', {
  restartDelayMs: 30,
  shared: {
    ...shared,
    async stop() {
      await shared.stop();
      await new Promise((resolve) =>
        process.stdout.write(
          `fixture ${JSON.stringify({ stopped: 'shared', owned: shared.owned })}\n`,
          resolve,
        ),
      );
    },
  },
  apiCommand: failure === 'api-spawn' ? [missing] : [process.execPath, '-e', apiBody],
  apiStdio: ['pipe', 'pipe', 'pipe'],
  apiCompilerCommand: failure === 'compiler-spawn' ? [missing] : [process.execPath, compiler],
  webCommand: failure === 'web-spawn' ? [missing] : [process.execPath, compiler],
  webStdio: ['pipe', 'pipe', 'pipe'],
  onApi(child) {
    api = child;
    if (child.pid) report({ role: 'api', pid: child.pid });
    child.stdout?.on('data', (chunk) => {
      if (chunk.toString().includes('ready')) report({ ready: 'api' });
    });
  },
});
for (const role of ['compiler', 'web']) {
  if (session[role]?.pid) report({ role, pid: session[role].pid });
}
process.stdin.on('data', () => api?.stdin?.write('exit\n'));
if (failure !== 'compiler-spawn') session.compiler.stdin.write('compile\n');
