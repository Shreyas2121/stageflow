import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, readFile, readdir, rm, writeFile, access, open } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { createSharedBuilder } from './shared-build.mjs';
import { checkGraph, runChecks } from './checks.mjs';

const script = new URL('./shared-build.mjs', import.meta.url).href;
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function until(predicate, timeoutMs = 15_000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await delay(30);
  }
  throw new Error('Timed out waiting for fixture state.');
}
async function fixture(t) {
  const root = await mkdtemp(join(tmpdir(), 'sf-shared-build-'));
  assert.ok(resolve(root).startsWith(resolve(tmpdir(), 'sf-shared-build-')));
  const shared = join(root, 'packages/shared');
  const source = join(shared, 'src/index.ts');
  const dist = join(shared, 'dist');
  const lock = join(root, 'node_modules/.cache/stageflow-shared-writer');
  await mkdir(dirname(source), { recursive: true });
  await writeFile(join(shared, 'package.json'), '{"type":"commonjs"}');
  await writeFile(
    join(shared, 'tsconfig.build.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'CommonJS',
        strict: true,
        skipLibCheck: true,
        declaration: true,
        rootDir: 'src',
        outDir: 'dist',
        types: [],
      },
      include: ['src'],
      exclude: ['src/**/*.test.ts'],
    }),
  );
  await writeFile(source, 'export const value: number = 1;\n');
  await writeFile(
    join(root, 'consumer.ts'),
    'import { value } from "./packages/shared/dist"; export const checked: number = value;\n',
  );
  const children = [];
  const watches = [];
  t.after(async () => {
    for (const watch of watches) await watch.stop();
    for (const child of children) {
      if (child.exitCode === null && child.signalCode === null) {
        child.kill();
        await once(child, 'exit');
      }
    }
    // This is only the explicitly created disposable root, never workspace dist or locks.
    assert.ok(resolve(root).startsWith(resolve(tmpdir(), 'sf-shared-build-')));
    await rm(root, { recursive: true, force: true });
  });
  const builder = createSharedBuilder({ root, timeoutMs: 12_000, pollMs: 30 });
  const state = async () => {
    try {
      const files = await readdir(lock);
      const name = files.find((name) => name.endsWith('.json'));
      if (!name) return null;
      const owner = JSON.parse(await readFile(join(lock, name), 'utf8'));
      const state = files
        .filter((file) => file.startsWith(`${owner.token}.`) && file.endsWith('.state'))
        .sort()
        .at(-1);
      return state ? JSON.parse(await readFile(join(lock, state), 'utf8')) : owner;
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
  };
  const worker = (body) => {
    const child = spawn(
      process.execPath,
      [
        '--input-type=module',
        '-e',
        `
      import { createSharedBuilder } from ${JSON.stringify(script)};
      const builder = createSharedBuilder({ root: ${JSON.stringify(root)}, timeoutMs: 12000, pollMs: 20 });
      ${body}
    `,
      ],
      { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
    );
    children.push(child);
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (data) => {
      stdout += data;
    });
    child.stderr.on('data', (data) => {
      stderr += data;
    });
    const done = once(child, 'exit').then(([code]) => ({ code, stdout, stderr }));
    return { child, done, output: () => stdout };
  };
  return {
    root,
    source,
    shared,
    dist,
    lock,
    state,
    worker,
    builder,
    async watch(options) {
      const watch = await builder.watchShared(options);
      watches.push(watch);
      return watch;
    },
  };
}

test(
  'cold app-build consumers serialize writers and never delete a previous consumer output',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    // Each consumer keeps reading the complete declarations while the other consumers build.
    const body = `
    import { readFile } from 'node:fs/promises';
    import { createRequire } from 'node:module';
    await builder.buildShared();
    const ts = createRequire(${JSON.stringify(script)})('typescript');
    const program = ts.createProgram([${JSON.stringify(join(f.root, 'consumer.ts'))}], {
      target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.CommonJS,
      noEmit: true, strict: true, skipLibCheck: true, types: []
    });
    const diagnostics = ts.getPreEmitDiagnostics(program);
    if (diagnostics.length) throw new Error(ts.formatDiagnostics(diagnostics, {
      getCurrentDirectory: () => '', getCanonicalFileName: file => file, getNewLine: () => '\\n'
    }));
    for (let i = 0; i < 100; i++) {
      const dts = await readFile(${JSON.stringify(join(f.dist, 'index.d.ts'))}, 'utf8');
      if (!dts.includes('value: number')) throw new Error('Missing or partial declaration');
      await new Promise(resolve => setTimeout(resolve, 10));
    }
  `;
    const results = await Promise.all([
      f.worker(body).done,
      f.worker(body).done,
      f.worker(body).done,
    ]);
    for (const result of results) assert.equal(result.code, 0, result.stderr);
    assert.equal(await f.state(), null);
    assert.match(await readFile(join(f.dist, 'index.js'), 'utf8'), /value = 1/);
  },
);

test(
  'watch readiness follows the latest source through a failed rebuild and recovery',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const rebuilds = [];
    const watch = await f.watch({ onRebuild: () => rebuilds.push(true) });
    await watch.ready;
    const initial = await f.state();
    assert.equal(initial.status, 'ready');
    const reused = f.worker('await builder.buildShared();');
    assert.equal((await reused.done).code, 0);
    assert.equal((await f.state()).generation, initial.generation);
    await writeFile(f.source, 'export const value: number = "invalid";\n');
    // Start before TypeScript's debounce: a prior ready marker must not pass.
    const rejected = f.worker('await builder.buildShared();');
    await until(async () => (await f.state())?.status === 'failed');
    const failure = await rejected.done;
    assert.notEqual(failure.code, 0);
    assert.match(failure.stderr, /not assignable/);
    assert.match(await readFile(join(f.dist, 'index.js'), 'utf8'), /value = 1/);
    assert.equal(rebuilds.length, 0);
    await writeFile(f.source, 'export const value: number = 2;\n');
    const recovered = f.worker('await builder.buildShared();');
    assert.equal((await recovered.done).code, 0);
    assert.match(await readFile(join(f.dist, 'index.js'), 'utf8'), /value = 2/);
    assert.ok((await f.state()).generation > initial.generation);
    assert.equal(rebuilds.length, 1);
  },
);

test(
  'missing output cannot satisfy watcher readiness and a later compile repairs it',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const watch = await f.watch();
    await watch.ready;
    await rm(join(f.dist, 'index.d.ts'));
    const impatient = createSharedBuilder({ root: f.root, timeoutMs: 250, pollMs: 20 });
    await assert.rejects(impatient.buildShared(), /missing output/);
    await writeFile(f.source, 'export const value: number = 3;\n');
    await f.builder.buildShared();
    await access(join(f.dist, 'index.d.ts'));
  },
);

test(
  'followers notify only successful generations and do not own or stop the writer',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const owner = await f.watch();
    await owner.ready;
    const rebuilds = [];
    const follower = await f.watch({ onRebuild: () => rebuilds.push(true) });
    await follower.ready;
    assert.equal(follower.owned, false);
    assert.equal(follower.protocol, true);
    await writeFile(f.source, 'export const value: number = "invalid";\n');
    await until(async () => (await f.state())?.status === 'failed');
    assert.equal(rebuilds.length, 0);
    await writeFile(f.source, 'export const value: number = 4;\n');
    await until(() => rebuilds.length === 1);
    await follower.stop();
    assert.equal((await f.state()).status, 'ready');
    await f.builder.buildShared();
  },
);

test(
  'stopping a writer invalidates readiness and preserves a newer owner on repeated stop',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const first = await f.watch();
    await first.ready;
    await first.stop();
    await assert.rejects(f.builder.waitForSharedReady(), /exited/);
    const next = await f.watch();
    await next.ready;
    const token = (await f.state()).token;
    await first.stop();
    assert.equal((await f.state()).token, token);
  },
);

test(
  'a dead writer is reclaimed safely by racing consumers; a live writer is never stolen',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const dead = f.worker(
      'const watch = await builder.watchShared(); await watch.ready; console.log("READY");',
    );
    await until(() => dead.output().includes('READY'));
    dead.child.kill();
    await dead.done;
    const stale = await f.state();
    assert.ok(stale);
    await writeFile(
      join(f.lock, `${stale.token}.json.interrupted.tmp`),
      'interrupted metadata publication',
    );
    const results = await Promise.all([
      f.worker('await builder.buildShared();').done,
      f.worker('await builder.buildShared();').done,
    ]);
    for (const result of results) assert.equal(result.code, 0, result.stderr);
    assert.equal(await f.state(), null);
    const watch = await f.watch();
    await watch.ready;
    const live = await f.state();
    await f.builder.buildShared();
    assert.equal((await f.state()).token, live.token);
  },
);

test(
  'failed first compile and failed one-shot leave no usable stale readiness',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    await f.builder.buildShared();
    await writeFile(f.source, 'export const value: number = "invalid";\n');
    await assert.rejects(f.builder.buildShared(), /not assignable/);
    assert.equal(await f.state(), null);
    const watch = await f.watch();
    await assert.rejects(watch.ready, /not assignable/);
    await assert.rejects(f.builder.buildShared(), /not assignable/);
  },
);

test(
  'successful publication removes obsolete output without clearing unchanged files',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const old = join(f.shared, 'src/old.ts');
    await writeFile(old, 'export const old = 1;\n');
    await f.builder.buildShared();
    await rm(old);
    await f.builder.buildShared();
    await assert.rejects(access(join(f.dist, 'old.d.ts')), { code: 'ENOENT' });
    await access(join(f.dist, 'index.js'));
  },
);

test(
  'a changed inherited configuration invalidates an older successful generation',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const base = join(f.root, 'tsconfig.base.json');
    await writeFile(base, '{"compilerOptions":{"noUnusedLocals":false}}');
    const config = join(f.shared, 'tsconfig.build.json');
    const parsed = JSON.parse(await readFile(config, 'utf8'));
    parsed.extends = '../../tsconfig.base.json';
    await writeFile(config, JSON.stringify(parsed));
    await writeFile(f.source, 'const unused = 1; export const value: number = 1;\n');
    const watch = await f.watch();
    await watch.ready;
    await writeFile(base, '{"compilerOptions":{"noUnusedLocals":true}}');
    const consumer = f.worker('await builder.buildShared();');
    const result = await consumer.done;
    assert.notEqual(result.code, 0);
    assert.match(result.stderr, /never read/);
    await writeFile(base, '{"compilerOptions":{"noUnusedLocals":false}}');
    await f.builder.buildShared();
  },
);

test(
  'a consumer waiting for output recovers when its watcher process exits',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const writer = f.worker(
      'const watch = await builder.watchShared(); await watch.ready; console.log("READY");',
    );
    await until(() => writer.output().includes('READY'));
    await rm(join(f.dist, 'index.d.ts'));
    const consumer = f.worker('await builder.buildShared();');
    await delay(250);
    writer.child.kill();
    await writer.done;
    const result = await consumer.done;
    assert.equal(result.code, 0, result.stderr);
    await access(join(f.dist, 'index.d.ts'));
  },
);

test(
  'an empty lock left during owner release can be reclaimed on Windows',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    await mkdir(f.lock, { recursive: true });
    await f.builder.buildShared();
    assert.equal(await f.state(), null);
    await access(join(f.dist, 'index.d.ts'));
  },
);

test(
  'a reader holding an old generation record cannot block a newer publication',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const watch = await f.watch();
    await watch.ready;
    const original = await f.state();
    const record = (await readdir(f.lock))
      .filter((name) => name.endsWith('.state'))
      .sort()
      .at(-1);
    const reader = await open(join(f.lock, record), 'r');
    try {
      await writeFile(f.source, 'export const value: number = 5;\n');
      await f.builder.buildShared();
      assert.ok((await f.state()).generation > original.generation);
      const held = JSON.parse(await reader.readFile('utf8'));
      assert.equal(held.generation, original.generation);
      assert.equal(held.status, 'ready');
    } finally {
      await reader.close();
    }
  },
);

test(
  'one release preparation is reused by all six independent app tasks',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    let prepared = 0;
    const consumers = [];
    await runChecks('check:release', {
      prepare: async () => {
        assert.equal((await f.builder.buildShared({ force: true })).built, true);
        prepared++;
      },
      run: async (args) => {
        if (args[0] !== '--filter' || args[1] === '@stageflow/shared') return;
        const consumer = await f.worker('console.log(JSON.stringify(await builder.buildShared()));')
          .done;
        assert.equal(consumer.code, 0, consumer.stderr);
        assert.match(consumer.stdout, /"built":false/);
        assert.doesNotMatch(consumer.stdout, /\[shared\] Compiled/);
        consumers.push(args);
      },
    });
    assert.equal(prepared, 1);
    assert.equal(consumers.length, 6);
    // Production reuse does not remove the shared test-source typecheck from the graph.
    assert.ok(
      checkGraph('check:release').some(
        (args) => args.join(' ') === '--filter @stageflow/shared typecheck',
      ),
    );
  },
);

test(
  'standalone ensure repairs deleted, changed and extra artifacts instead of trusting the cache',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    assert.equal((await f.builder.buildShared()).built, true);
    assert.equal((await f.builder.buildShared()).built, false);
    await rm(join(f.dist, 'index.d.ts'));
    assert.equal((await f.builder.buildShared()).built, true);
    await writeFile(join(f.dist, 'index.js'), 'corrupt output');
    assert.equal((await f.builder.buildShared()).built, true);
    await writeFile(join(f.dist, 'accidental.test.js'), 'unwanted test artifact');
    assert.equal((await f.builder.buildShared()).built, true);
    await assert.rejects(access(join(f.dist, 'accidental.test.js')), { code: 'ENOENT' });
    // The explicitly disposable dist may be deleted completely, as in a cold clone.
    assert.equal(dirname(resolve(f.dist)), resolve(f.shared));
    await rm(f.dist, { recursive: true });
    assert.equal((await f.builder.buildShared()).built, true);
    const result = await f.worker('console.log(JSON.stringify(await builder.buildShared()));').done;
    assert.equal(result.code, 0, result.stderr);
    assert.match(result.stdout, /"built":false/);
  },
);

test(
  'source, inherited configuration, dependency metadata and manifests invalidate reuse',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const config = join(f.shared, 'tsconfig.build.json');
    const base = join(f.root, 'tsconfig.base.json');
    const parsed = JSON.parse(await readFile(config, 'utf8'));
    parsed.extends = '../../tsconfig.base.json';
    await writeFile(base, '{"compilerOptions":{"strictNullChecks":true}}');
    await writeFile(config, JSON.stringify(parsed));
    await f.builder.buildShared();
    assert.equal((await f.builder.buildShared()).built, false);
    await writeFile(f.source, 'export const value: number = 9;\n');
    assert.equal((await f.builder.buildShared()).built, true);
    await writeFile(base, '{"compilerOptions":{"strictNullChecks":false}}');
    assert.equal((await f.builder.buildShared()).built, true);
    await writeFile(join(f.root, 'pnpm-lock.yaml'), 'lockfileVersion: 9.0\n');
    assert.equal((await f.builder.buildShared()).built, true);
    await writeFile(join(f.shared, 'package.json'), '{"type":"commonjs","version":"0.0.1"}');
    assert.equal((await f.builder.buildShared()).built, true);
    assert.equal((await f.builder.buildShared()).built, false);
  },
);

test(
  'a failed changed build cannot reuse old success, while excluded tests stay out of production',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    await f.builder.buildShared();
    await writeFile(f.source, 'export const value: number = "invalid";\n');
    await assert.rejects(f.builder.buildShared(), /not assignable/);
    const failed = await f.worker('await builder.buildShared();').done;
    assert.notEqual(failed.code, 0);
    await writeFile(f.source, 'export const value: number = 10;\n');
    assert.equal((await f.builder.buildShared()).built, true);
    await writeFile(
      join(f.shared, 'src/index.test.ts'),
      'const invalid: number = "test must still be typechecked";\n',
    );
    assert.equal((await f.builder.buildShared()).built, false);
    assert.deepEqual((await readdir(f.dist)).sort(), ['index.d.ts', 'index.js']);
  },
);

test(
  'a malformed success record is repaired and a graph aborts when preparation fails',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    await f.builder.buildShared();
    const directory = join(f.root, 'node_modules/.cache/stageflow-shared-builds');
    const record = (await readdir(directory)).find((file) => file.endsWith('.json'));
    await writeFile(join(directory, record), '{bad');
    assert.equal((await f.builder.buildShared()).built, true);
    const repaired = (await readdir(directory)).find((file) => file.endsWith('.json'));
    const malformed = JSON.parse(await readFile(join(directory, repaired), 'utf8'));
    malformed.files = [null];
    await writeFile(join(directory, repaired), JSON.stringify(malformed));
    assert.equal((await f.builder.buildShared()).built, true);
    let ran = false;
    await assert.rejects(
      runChecks('build', {
        prepare: async () => {
          throw new Error('expected preparation failure');
        },
        run: async () => {
          ran = true;
        },
      }),
      /expected preparation failure/,
    );
    assert.equal(ran, false);
  },
);

test(
  'a source edit between graph tasks is rebuilt rather than skipped by graph preparation',
  { timeout: 30_000 },
  async (t) => {
    const f = await fixture(t);
    const builds = [];
    await runChecks('build', {
      prepare: () => f.builder.buildShared({ force: true }),
      run: async () => {
        if (!builds.length) await writeFile(f.source, 'export const value: number = 11;\n');
        builds.push((await f.builder.buildShared()).built);
      },
    });
    assert.deepEqual(builds, [true, false]);
    assert.match(await readFile(join(f.dist, 'index.js'), 'utf8'), /value = 11/);
  },
);
