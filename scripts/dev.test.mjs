import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import {
  devProcessCommands,
  forceStopMessage,
  killTree,
  listDescendantPids,
  runDev,
  stopSupervised,
} from './dev.mjs';
import { devShutdownPath, requestDevShutdown, startShutdownServer } from './dev-shutdown.mjs';
import { createSharedBuilder } from './shared-build.mjs';

const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const Redis = require('ioredis');
const fixturePath = fileURLToPath(new URL('./dev-owner-fixture.mjs', import.meta.url));
const compilerPath = fileURLToPath(new URL('./dev-compiler-fixture.mjs', import.meta.url));
const failurePath = fileURLToPath(new URL('./dev-failure-fixture.mjs', import.meta.url));

function redisUrl() {
  if (process.env.REDIS_URL) return process.env.REDIS_URL;
  const text = readFileSync(fileURLToPath(new URL('../.env', import.meta.url)), 'utf8');
  const line = text.split(/\r?\n/).find((item) => item.startsWith('REDIS_URL='));
  if (!line) throw new Error('REDIS_URL is required for dev owner tests.');
  return line.slice('REDIS_URL='.length).trim();
}

function openRedis() {
  const redis = new Redis(redisUrl(), {
    connectTimeout: 2000,
    maxRetriesPerRequest: 1,
    enableOfflineQueue: false,
    lazyConnect: true,
  });
  redis.on('error', () => {});
  return redis;
}

function namespaceId() {
  return `sf_itest_${randomBytes(4).toString('hex')}`;
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function alive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

function track(child) {
  const lines = [];
  const errors = [];
  let notify = () => {};
  const collect = (stream, target) => {
    if (!stream) return;
    stream.setEncoding('utf8');
    stream.on('data', (chunk) => {
      target.push(chunk);
      notify();
    });
  };
  let buffer = '';
  if (child.stdout) {
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', (chunk) => {
      buffer += chunk;
      let newline = buffer.indexOf('\n');
      while (newline !== -1) {
        lines.push(buffer.slice(0, newline).replace(/\r$/, ''));
        buffer = buffer.slice(newline + 1);
        newline = buffer.indexOf('\n');
      }
      notify();
    });
  }
  collect(child.stderr, errors);
  return {
    lines,
    errors,
    waitFor(predicate, timeoutMs = 8_000) {
      const ready = () => predicate(lines);
      if (ready()) return Promise.resolve();
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          notify = () => {};
          reject(
            new Error(
              `Timed out waiting for API output. Saw: ${lines.join(' | ') || '(none)'}. Errors: ${errors.join('')}`,
            ),
          );
        }, timeoutMs);
        notify = () => {
          if (!ready()) return;
          clearTimeout(timer);
          resolve();
        };
      });
    },
  };
}

function childPid(lines) {
  const line = lines.find((item) => item.startsWith('child '));
  const pid = Number(line?.slice('child '.length));
  if (!Number.isInteger(pid) || pid <= 0)
    throw new Error(`Missing child pid in ${lines.join(' | ')}`);
  return pid;
}

function ownerToken(lines) {
  const line = lines.find((item) => item.startsWith('owner '));
  if (!line) throw new Error(`Missing owner token in ${lines.join(' | ')}`);
  return line.slice('owner '.length);
}

test('dev commands compile with Nest watch and do not let Nest kill the API', () => {
  const commands = devProcessCommands({
    execPath: 'node',
    dotenvCli: 'dotenv',
    nestBin: 'nest',
    envFile: '.env',
    apiDir: 'apps/api',
  });
  assert.deepEqual(commands.compiler.slice(-3), ['nest', 'build', '--watch']);
  assert.equal(commands.compiler.includes('start'), false);
  assert.equal(commands.api.includes('start'), false);
  assert.equal(commands.api.at(-1), join('apps/api', 'dist', 'main.js'));
  assert.match(forceStopMessage(15_000), /will not take over a surviving guard/);
});

test('the API shutdown module path is the same from source and dist', () => {
  const script = fileURLToPath(new URL('./dev-shutdown.mjs', import.meta.url));
  for (const base of ['../apps/api/src/dev-shutdown.ts', '../apps/api/dist/dev-shutdown.js']) {
    const source = new URL(base, import.meta.url);
    const moduleUrl = new URL(
      '../../../scripts/dev-shutdown.mjs',
      pathToFileURL(fileURLToPath(source)),
    );
    assert.equal(fileURLToPath(moduleUrl), script);
  }
});

test('the shutdown channel rejects a public bind and a wrong token', async () => {
  assert.throws(() => devShutdownPath('../escape'), /Invalid/);
  await assert.rejects(
    () =>
      startShutdownServer({
        channel: '127.0.0.1:9',
        token: randomBytes(16).toString('hex'),
        onShutdown: async () => {},
      }),
    /local/,
  );
  const channel = devShutdownPath(randomUUID());
  const token = randomBytes(16).toString('hex');
  let closed = 0;
  const server = await startShutdownServer({
    channel,
    token,
    onShutdown: async () => {
      closed += 1;
    },
  });
  try {
    await assert.rejects(() => requestDevShutdown(channel, 'not-the-real-token', 1000), /refused/);
    assert.equal(closed, 0);
    await requestDevShutdown(channel, token, 1000);
    const started = Date.now();
    while (closed !== 1 && Date.now() - started < 1000) await delay(10);
    assert.equal(closed, 1);
  } finally {
    await server.close();
  }
});

test('lists supervised descendants and stops that tree', async () => {
  const parent = spawn(
    process.execPath,
    [
      '-e',
      "const {spawn}=require('node:child_process'); const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{stdio:'ignore',windowsHide:true}); process.stdout.write(String(child.pid)+'\\n'); setInterval(()=>{},1000);",
    ],
    { stdio: ['ignore', 'pipe', 'inherit'], windowsHide: true },
  );
  const output = track(parent);
  try {
    await output.waitFor((lines) => lines.length > 0);
    const pid = Number(output.lines[0]);
    const descendants = listDescendantPids(parent.pid);
    assert.equal(descendants.includes(pid), true, descendants.join(','));
    killTree(parent);
    await new Promise((resolve) => parent.once('exit', resolve));
    const started = Date.now();
    while (alive(pid) && Date.now() - started < 3000) await delay(50);
    assert.equal(alive(pid), false);
    assert.equal(alive(parent.pid), false);
  } finally {
    if (alive(parent.pid)) killTree(parent);
  }
});

test('a channel shutdown exits the process and its child without a force kill', async () => {
  const channel = devShutdownPath(randomUUID());
  const token = randomBytes(16).toString('hex');
  const child = spawn(process.execPath, [fixturePath, namespaceId(), 'channel'], {
    env: { ...process.env, STAGEFLOW_DEV_SHUTDOWN: channel, STAGEFLOW_DEV_SHUTDOWN_TOKEN: token },
    stdio: ['ignore', 'pipe', 'pipe'],
    windowsHide: true,
  });
  const output = track(child);
  try {
    await output.waitFor((lines) => lines.includes('ready'));
    const pid = childPid(output.lines);
    const forces = [];
    const result = await stopSupervised(child, {
      channel,
      token,
      graceMs: 5_000,
      onForceStop: (message) => forces.push(message),
    });
    assert.equal(result.forced, false);
    assert.deepEqual(forces, []);
    assert.equal(child.exitCode, 0);
    assert.equal(alive(pid), false);
  } finally {
    if (alive(child.pid)) killTree(child);
  }
});

async function withRedis(run) {
  const redis = openRedis();
  const namespace = namespaceId();
  const foreign = `${namespace}_kept`;
  const keys = [`${namespace}:owner`, `${foreign}:owner`];
  try {
    await redis.connect();
    await redis.set(`${foreign}:owner`, 'kept-owner');
    await run({ redis, namespace, foreign });
  } finally {
    await redis.del(...keys).catch(() => {});
    redis.disconnect();
  }
}

async function supervise(mode, options = {}) {
  const generations = [];
  const forces = [];
  const directory = options.distDir;
  const session = await runDev('api', {
    exitOnStop: false,
    graceMs: options.graceMs ?? 8_000,
    restartDelayMs: 40,
    apiStdio: ['ignore', 'pipe', 'pipe'],
    apiCommand: [process.execPath, fixturePath, options.namespace, mode],
    apiCompilerCommand: options.compiler ? [process.execPath, compilerPath] : undefined,
    distDir: directory,
    shared: {
      owned: !directory,
      ready: Promise.resolve(),
      waitForReady: options.sharedWaitForReady,
      async stop() {},
    },
    onApi: (child) => generations.push({ child, output: track(child) }),
    onForceStop: (message) => forces.push(message),
  });
  return { session, generations, forces };
}

async function waitGeneration(generations, index) {
  const started = Date.now();
  while (!generations[index]) {
    if (Date.now() - started > 10_000) {
      throw new Error(`Generation ${index} did not start. Saw ${generations.length}.`);
    }
    await delay(20);
  }
  await generations[index].output.waitFor((lines) => lines.includes('ready'));
  return generations[index];
}

async function failureFixture(t, { failure, follower = false }) {
  const root = mkdtempSync(join(tmpdir(), 'sf-dev-failure-'));
  const sharedDir = join(root, 'packages/shared');
  const source = join(sharedDir, 'src/index.ts');
  mkdirSync(join(sharedDir, 'src'), { recursive: true });
  writeFileSync(source, 'export const value = 1;\n');
  writeFileSync(
    join(sharedDir, 'tsconfig.build.json'),
    JSON.stringify({
      compilerOptions: {
        target: 'ES2022',
        module: 'CommonJS',
        rootDir: 'src',
        outDir: 'dist',
        declaration: true,
        types: [],
        skipLibCheck: true,
      },
      include: ['src'],
    }),
  );
  let rebuilds = 0;
  const writer = follower
    ? await createSharedBuilder({ root, pollMs: 30 }).watchShared({
        onRebuild: () => {
          rebuilds++;
        },
      })
    : null;
  if (writer) await writer.ready;
  const lock = join(root, 'node_modules/.cache/stageflow-shared-writer');
  const child = spawn(process.execPath, [failurePath, root, failure], {
    windowsHide: true,
    stdio: ['pipe', 'pipe', 'pipe'],
  });
  const output = track(child);
  const events = () =>
    output.lines
      .filter((line) => line.startsWith('fixture '))
      .map((line) => JSON.parse(line.slice('fixture '.length)));
  const exited = new Promise((done) => child.once('close', (code) => done(code)));
  t.after(async () => {
    if (alive(child.pid)) killTree(child);
    for (const event of events()) {
      if (event.pid && alive(event.pid)) killTree({ pid: event.pid });
    }
    await writer?.stop();
    assert.ok(resolve(root).startsWith(resolve(tmpdir(), 'sf-dev-failure-')));
    rmSync(root, { recursive: true, force: true });
  });
  return { child, output, events, exited, lock, source, writer, rebuilds: () => rebuilds };
}

for (const follower of [false, true]) {
  for (const failure of ['early', 'ready']) {
    test(
      `unexpected API exit ${failure} stops siblings and the shared ${follower ? 'follower' : 'writer'}`,
      { timeout: 30_000 },
      async (t) => {
        await withRedis(async ({ redis, namespace, foreign }) => {
          await redis.set(`${namespace}:owner`, 'unrelated-owner');
          const f = await failureFixture(t, { failure, follower });
          if (failure === 'ready') {
            await f.output.waitFor(() => f.events().some((event) => event.ready === 'api'));
            f.child.stdin.write('crash\n');
          }
          assert.equal(await f.exited, 7, f.output.errors.join(''));
          const events = f.events();
          assert.deepEqual(
            events.filter((event) => event.stopped),
            [{ stopped: 'shared', owned: !follower }],
          );
          assert.deepEqual(
            events
              .filter((event) => event.role)
              .map((event) => event.role)
              .sort(),
            ['api', 'compiler', 'web'],
          );
          for (const event of events.filter((event) => event.pid))
            assert.equal(alive(event.pid), false, `Owned ${event.role} ${event.pid} survived`);
          assert.equal(existsSync(f.lock), follower);
          if (follower) {
            const before = f.rebuilds();
            writeFileSync(f.source, 'export const value = 2;\n');
            const deadline = Date.now() + 8_000;
            while (f.rebuilds() === before && Date.now() < deadline) await delay(30);
            assert.ok(f.rebuilds() > before, 'The external shared writer must still rebuild');
            await f.writer.waitForReady();
          }
          assert.equal(await redis.get(`${namespace}:owner`), 'unrelated-owner');
          assert.equal(await redis.get(`${foreign}:owner`), 'kept-owner');
          assert.doesNotMatch(f.output.errors.join(''), /TypeError|Force-stopping/);
        });
      },
    );
  }
}

for (const role of ['api', 'compiler', 'web']) {
  test(
    `${role} spawn failure cleans owned siblings and shared state`,
    { timeout: 30_000 },
    async (t) => {
      const f = await failureFixture(t, { failure: `${role}-spawn` });
      assert.equal(await f.exited, 1);
      assert.deepEqual(
        f.events().filter((event) => event.stopped),
        [{ stopped: 'shared', owned: true }],
      );
      for (const event of f.events().filter((event) => event.pid))
        assert.equal(alive(event.pid), false, `Owned ${event.role} ${event.pid} survived`);
      assert.equal(existsSync(f.lock), false);
      assert.match(f.output.errors.join(''), /ENOENT/);
      assert.doesNotMatch(f.output.errors.join(''), /Unhandled 'error' event|Force-stopping/);
    },
  );
}

test('repeated stop calls await the same complete cleanup', { timeout: 10_000 }, async (t) => {
  let release;
  let started;
  let stops = 0;
  const cleanup = new Promise((resolve) => {
    release = resolve;
  });
  const stopping = new Promise((resolve) => {
    started = resolve;
  });
  const session = await runDev('web', {
    exitOnStop: false,
    webCommand: [process.execPath, '-e', 'setInterval(() => {}, 1000)'],
    webStdio: 'ignore',
    shared: {
      owned: true,
      ready: Promise.resolve(),
      stop() {
        stops++;
        started();
        return cleanup;
      },
    },
  });
  t.after(async () => {
    release();
    await session.stop();
  });
  const first = session.stop();
  const second = session.stop();
  assert.equal(first, second);
  let finished = false;
  void second.then(() => {
    finished = true;
  });
  await stopping;
  await Promise.resolve();
  assert.equal(finished, false);
  assert.equal(alive(session.web.pid), false);
  release();
  await second;
  assert.equal(stops, 1);
  assert.equal(finished, true);
});

test('two Nest watch restarts release the owner and every child', async () => {
  await withRedis(async ({ redis, namespace, foreign }) => {
    const supervised = await supervise('release', { namespace, compiler: true });
    try {
      const compile = () => supervised.session.compiler.stdin.write('compile\n');
      compile();
      const first = await waitGeneration(supervised.generations, 0);
      const firstOwner = ownerToken(first.output.lines);
      const firstChild = childPid(first.output.lines);
      assert.equal(await redis.get(`${namespace}:owner`), firstOwner);
      compile();
      const second = await waitGeneration(supervised.generations, 1);
      assert.equal(first.child.exitCode, 0);
      assert.equal(alive(firstChild), false);
      const secondOwner = ownerToken(second.output.lines);
      assert.notEqual(secondOwner, firstOwner);
      assert.equal(await redis.get(`${namespace}:owner`), secondOwner);
      compile();
      const third = await waitGeneration(supervised.generations, 2);
      assert.equal(second.child.exitCode, 0);
      assert.equal(await redis.get(`${namespace}:owner`), ownerToken(third.output.lines));
      await supervised.session.stop();
      assert.equal(third.child.exitCode, 0);
      assert.equal(alive(childPid(third.output.lines)), false);
      assert.equal(await redis.get(`${namespace}:owner`), null);
      assert.equal(await redis.get(`${foreign}:owner`), 'kept-owner');
      assert.deepEqual(supervised.forces, []);
    } finally {
      await supervised.session.stop();
      for (const generation of supervised.generations) {
        if (alive(generation.child.pid)) killTree(generation.child);
      }
    }
  });
});

test('two shared-output restarts release the owner the same way', async () => {
  await withRedis(async ({ redis, namespace, foreign }) => {
    const directory = mkdtempSync(join(tmpdir(), 'stageflow-dev-'));
    const supervised = await supervise('release', { namespace, distDir: directory });
    try {
      const first = await waitGeneration(supervised.generations, 0);
      assert.equal(await redis.get(`${namespace}:owner`), ownerToken(first.output.lines));
      writeFileSync(join(directory, 'one.js'), '1');
      const second = await waitGeneration(supervised.generations, 1);
      assert.equal(first.child.exitCode, 0);
      assert.equal(await redis.get(`${namespace}:owner`), ownerToken(second.output.lines));
      writeFileSync(join(directory, 'two.js'), '2');
      const third = await waitGeneration(supervised.generations, 2);
      assert.equal(second.child.exitCode, 0);
      assert.equal(await redis.get(`${namespace}:owner`), ownerToken(third.output.lines));
      await supervised.session.stop();
      assert.equal(third.child.exitCode, 0);
      assert.equal(await redis.get(`${namespace}:owner`), null);
      assert.equal(await redis.get(`${foreign}:owner`), 'kept-owner');
      assert.deepEqual(supervised.forces, []);
    } finally {
      await supervised.session.stop();
      for (const generation of supervised.generations) {
        if (alive(generation.child.pid)) killTree(generation.child);
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

test('a missed shutdown force-stops the tree, keeps the guard, and refuses the next owner', async () => {
  await withRedis(async ({ redis, namespace, foreign }) => {
    const directory = mkdtempSync(join(tmpdir(), 'stageflow-dev-'));
    const supervised = await supervise('ignore', { namespace, distDir: directory, graceMs: 700 });
    try {
      const first = await waitGeneration(supervised.generations, 0);
      const owned = ownerToken(first.output.lines);
      const pid = childPid(first.output.lines);
      writeFileSync(join(directory, 'restart.js'), '1');
      const started = Date.now();
      while (supervised.forces.length === 0 && Date.now() - started < 8_000) await delay(20);
      assert.equal(supervised.forces.length > 0, true);
      assert.match(supervised.forces[0], /Force-stopping the process tree/);
      assert.match(supervised.forces[0], /will not take over a surviving guard/);
      const exited = Date.now();
      while (alive(pid) && Date.now() - exited < 3_000) await delay(50);
      assert.equal(alive(pid), false);
      assert.equal(await redis.get(`${namespace}:owner`), owned);
      assert.equal(await redis.get(`${foreign}:owner`), 'kept-owner');
      writeFileSync(join(directory, 'again.js'), '2');
      await delay(300);
      assert.equal(supervised.generations.length, 1);
      const refused = spawn(process.execPath, [fixturePath, namespace, 'release'], {
        env: {
          ...process.env,
          STAGEFLOW_DEV_SHUTDOWN: devShutdownPath(randomUUID()),
          STAGEFLOW_DEV_SHUTDOWN_TOKEN: randomBytes(16).toString('hex'),
        },
        stdio: ['ignore', 'pipe', 'pipe'],
        windowsHide: true,
      });
      const output = track(refused);
      try {
        await output.waitFor((lines) => lines.includes('refused'));
        if (refused.exitCode === null) {
          await new Promise((resolve) => refused.once('exit', () => resolve()));
        }
        assert.equal(refused.exitCode, 1);
      } finally {
        if (alive(refused.pid)) killTree(refused);
      }
      assert.equal(await redis.get(`${namespace}:owner`), owned);
      assert.equal(await redis.get(`${foreign}:owner`), 'kept-owner');
    } finally {
      await supervised.session.stop();
      for (const generation of supervised.generations) {
        if (alive(generation.child.pid)) killTree(generation.child);
      }
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

test('graceful shutdown never deletes a foreign owner token', async () => {
  await withRedis(async ({ redis, namespace, foreign }) => {
    const supervised = await supervise('yield', { namespace });
    try {
      const first = await waitGeneration(supervised.generations, 0);
      await supervised.session.stop();
      assert.equal(first.child.exitCode, 0);
      assert.equal(alive(childPid(first.output.lines)), false);
      assert.equal(await redis.get(`${namespace}:owner`), 'foreign-owner');
      assert.equal(await redis.get(`${foreign}:owner`), 'kept-owner');
      assert.deepEqual(supervised.forces, []);
    } finally {
      await supervised.session.stop();
      for (const generation of supervised.generations) {
        if (alive(generation.child.pid)) killTree(generation.child);
      }
    }
  });
});

test('API startup and restarts wait for the current successful shared generation', async () => {
  await withRedis(async ({ redis, namespace }) => {
    let valid = false;
    let checks = 0;
    const supervised = await supervise('release', {
      namespace,
      compiler: true,
      sharedWaitForReady: async () => {
        checks++;
        if (!valid) throw new Error('Expected shared compile failure');
      },
    });
    const compile = () => supervised.session.compiler.stdin.write('compile\n');
    const waitChecks = async (count) => {
      const deadline = Date.now() + 5000;
      while (checks < count && Date.now() < deadline) await delay(20);
      assert.equal(checks, count);
    };
    try {
      compile();
      await waitChecks(1);
      assert.equal(supervised.generations.length, 0);
      assert.equal(await redis.get(`${namespace}:owner`), null);
      valid = true;
      compile();
      const first = await waitGeneration(supervised.generations, 0);
      const owned = ownerToken(first.output.lines);
      valid = false;
      compile();
      await waitChecks(3);
      assert.equal(first.child.exitCode, null);
      assert.equal(await redis.get(`${namespace}:owner`), owned);
      valid = true;
      compile();
      const next = await waitGeneration(supervised.generations, 1);
      assert.equal(first.child.exitCode, 0);
      assert.notEqual(ownerToken(next.output.lines), owned);
      assert.deepEqual(supervised.forces, []);
    } finally {
      await supervised.session.stop();
      for (const generation of supervised.generations)
        if (alive(generation.child.pid)) killTree(generation.child);
    }
    assert.equal(await redis.get(`${namespace}:owner`), null);
  });
});
