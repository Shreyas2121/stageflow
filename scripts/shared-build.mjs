import { spawn, spawnSync } from 'node:child_process';
import { access, mkdir, open, readFile, rm, writeFile } from 'node:fs/promises';
import { fileURLToPath, pathToFileURL } from 'node:url';

const sharedDir = fileURLToPath(new URL('../packages/shared/', import.meta.url));
const tscBin = fileURLToPath(new URL('../node_modules/typescript/bin/tsc', import.meta.url));
const tsconfig = fileURLToPath(new URL('../packages/shared/tsconfig.build.json', import.meta.url));
const distDir = fileURLToPath(new URL('../packages/shared/dist/', import.meta.url));
const distIndex = fileURLToPath(new URL('../packages/shared/dist/index.js', import.meta.url));
const cacheDir = fileURLToPath(new URL('../node_modules/.cache/', import.meta.url));
const lockFile = fileURLToPath(
  new URL('../node_modules/.cache/stageflow-shared-watch.pid', import.meta.url),
);
const readyFile = fileURLToPath(
  new URL('../node_modules/.cache/stageflow-shared-watch.ready', import.meta.url),
);

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

async function readWatchOwner() {
  try {
    const pid = Number((await readFile(lockFile, 'utf8')).trim());
    if (Number.isInteger(pid) && pid > 0 && isAlive(pid)) return pid;
  } catch (error) {
    if (error.code !== 'ENOENT') throw error;
  }
  return null;
}

function killTree(child) {
  if (!child?.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(child.pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    return;
  }
  try {
    process.kill(child.pid, 'SIGTERM');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

function readLines(stream, onLine) {
  let buffer = '';
  stream.setEncoding('utf8');
  stream.on('data', (chunk) => {
    buffer += chunk;
    let newline = buffer.indexOf('\n');
    while (newline !== -1) {
      onLine(buffer.slice(0, newline).replace(/\r$/, ''));
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf('\n');
    }
  });
}

function runTsc(args) {
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [tscBin, ...args], {
      cwd: sharedDir,
      windowsHide: true,
      stdio: ['ignore', 'inherit', 'inherit'],
    });
    child.on('error', reject);
    child.on('exit', (code) => {
      if (code === 0) resolve();
      else reject(new Error(`Shared build failed (tsc exit ${code ?? 'signal'}).`));
    });
  });
}

async function assertEmitted() {
  try {
    await access(distIndex);
  } catch {
    throw new Error('Shared build did not emit packages/shared/dist/index.js.');
  }
}

export async function buildShared() {
  const owner = await readWatchOwner();
  if (owner) {
    await waitForSharedReady();
    console.log(`[shared] Using the running watcher output (pid ${owner}).`);
    return;
  }
  await rm(lockFile, { force: true });
  await rm(readyFile, { force: true });
  await rm(distDir, { recursive: true, force: true });
  await runTsc(['-p', tsconfig, '--pretty', 'false']);
  await assertEmitted();
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

export async function waitForSharedReady(timeoutMs = 60_000) {
  const started = Date.now();
  while (Date.now() - started < timeoutMs) {
    try {
      await access(readyFile);
      await access(distIndex);
      return;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
    }
    await delay(100);
  }
  throw new Error('Timed out waiting for the shared package watcher.');
}

async function acquireWatchLock() {
  await mkdir(cacheDir, { recursive: true });
  for (;;) {
    try {
      const handle = await open(lockFile, 'wx');
      await handle.writeFile(String(process.pid));
      await handle.close();
      return true;
    } catch (error) {
      if (error.code !== 'EEXIST') throw error;
      const owner = await readWatchOwner();
      if (owner) return false;
      await rm(lockFile, { force: true });
    }
  }
}

export async function watchShared({ onRebuild, onExit } = {}) {
  const owned = await acquireWatchLock();
  if (!owned) {
    await waitForSharedReady();
    return { owned: false, ready: Promise.resolve(), stop: async () => {} };
  }

  await rm(readyFile, { force: true });
  await rm(distDir, { recursive: true, force: true });
  const child = spawn(
    process.execPath,
    [tscBin, '-p', tsconfig, '--watch', '--preserveWatchOutput', '--pretty', 'false'],
    { cwd: sharedDir, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] },
  );

  let failed = false;
  let announced = false;
  let stopped = false;
  let resolveReady;
  let rejectReady;
  const ready = new Promise((resolve, reject) => {
    resolveReady = resolve;
    rejectReady = reject;
  });

  const onLine = (line) => {
    if (line.length > 0) console.log(`[shared] ${line}`);
    if (/error TS\d+/.test(line)) failed = true;
    if (!line.includes('Watching for file changes')) return;
    const compileFailed = failed || /Found [1-9]\d* error/.test(line);
    failed = false;
    if (!announced) {
      announced = true;
      if (compileFailed) {
        rejectReady(new Error('Shared watcher failed its first compile.'));
        return;
      }
      publishReady().then(resolveReady).catch(rejectReady);
      return;
    }
    if (!compileFailed) {
      publishReady()
        .then(() => onRebuild?.())
        .catch((error) => {
          console.error(error instanceof Error ? error.message : error);
        });
    }
  };

  const publishReady = () => writeFile(readyFile, new Date().toISOString());

  readLines(child.stdout, onLine);
  readLines(child.stderr, onLine);
  child.on('error', rejectReady);
  child.on('exit', (code) => {
    if (stopped) return;
    if (!announced) {
      rejectReady(new Error(`Shared watcher exited before it was ready (${code ?? 'signal'}).`));
      return;
    }
    console.error(`[shared] Watcher exited (${code ?? 'signal'}).`);
    onExit?.(code ?? 1);
  });

  return {
    owned: true,
    ready,
    stop: async () => {
      if (stopped) return;
      stopped = true;
      killTree(child);
      await rm(lockFile, { force: true });
      await rm(readyFile, { force: true });
    },
  };
}

function isDirectRun() {
  const entry = process.argv[1];
  return Boolean(entry) && pathToFileURL(entry).href === import.meta.url;
}

if (isDirectRun()) {
  const command = process.argv[2];
  if (command === 'build') {
    buildShared().catch((error) => {
      console.error(error instanceof Error ? error.message : error);
      process.exit(1);
    });
  } else if (command === 'watch') {
    watchShared()
      .then(async (watch) => {
        const stop = async (code) => {
          await watch.stop();
          process.exit(code);
        };
        process.on('SIGINT', () => {
          void stop(0);
        });
        process.on('SIGTERM', () => {
          void stop(0);
        });
        try {
          await watch.ready;
        } catch (error) {
          console.error(error instanceof Error ? error.message : error);
          await stop(1);
        }
      })
      .catch((error) => {
        console.error(error instanceof Error ? error.message : error);
        process.exit(1);
      });
  } else {
    console.error('Usage: node scripts/shared-build.mjs <build|watch>');
    process.exit(1);
  }
}
