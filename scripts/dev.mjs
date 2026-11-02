import { spawn, spawnSync } from 'node:child_process';
import { readFileSync, watch } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { watchShared } from './shared-build.mjs';

const apiDir = fileURLToPath(new URL('../apps/api/', import.meta.url));
const webDir = fileURLToPath(new URL('../apps/web/', import.meta.url));
const envFile = fileURLToPath(new URL('../.env', import.meta.url));
const distDir = fileURLToPath(new URL('../packages/shared/dist/', import.meta.url));
function resolveBin(packageJsonPath, packageName, binName) {
  const segments = packageName.split('/');
  const manifestPath = join(dirname(packageJsonPath), 'node_modules', ...segments, 'package.json');
  const manifest = JSON.parse(readFileSync(manifestPath, 'utf8'));
  const bin = typeof manifest.bin === 'string' ? manifest.bin : manifest.bin?.[binName];
  if (!bin) throw new Error(`Package ${packageName} has no ${binName} binary.`);
  return join(dirname(manifestPath), bin);
}

const apiPackage = fileURLToPath(new URL('../apps/api/package.json', import.meta.url));
const webPackage = fileURLToPath(new URL('../apps/web/package.json', import.meta.url));
const dotenvCli = resolveBin(apiPackage, 'dotenv-cli', 'dotenv');
const nestBin = resolveBin(apiPackage, '@nestjs/cli', 'nest');
const viteBin = resolveBin(webPackage, 'vite', 'vite');

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

function waitForExit(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
  });
}

export async function runDev(mode = 'all', options = {}) {
  if (mode !== 'api' && mode !== 'web' && mode !== 'all') {
    throw new Error('Usage: node scripts/dev.mjs [api|web]');
  }

  const wantsApi = mode === 'api' || mode === 'all';
  const wantsWeb = mode === 'web' || mode === 'all';
  let stopping = false;
  let restarting = false;
  let pendingRestart = false;
  let acceptRestarts = false;
  let apiChild = null;
  let webChild = null;
  let distWatcher = null;
  let restartTimer = null;

  const shared = await watchShared({
    onRebuild: () => {
      if (wantsApi) scheduleApiRestart(150);
    },
    onExit: (code) => {
      void shutdown(code);
    },
  });

  function spawnNode(script, args, cwd, stdio) {
    return spawn(process.execPath, [script, ...args], {
      cwd,
      env: process.env,
      windowsHide: true,
      stdio,
    });
  }

  function startApi() {
    const stdio = options.apiStdio ?? 'inherit';
    const child = options.apiCommand
      ? spawn(options.apiCommand[0], options.apiCommand.slice(1), {
          cwd: apiDir,
          env: process.env,
          windowsHide: true,
          stdio,
        })
      : spawnNode(dotenvCli, ['-e', envFile, '--', nestBin, 'start', '--watch'], apiDir, stdio);
    apiChild = child;
    options.onApi?.(child);
    child.on('exit', (code) => {
      if (stopping || restarting || apiChild !== child) return;
      console.error(`[stageflow] API dev server exited (${code ?? 'signal'}).`);
      void shutdown(code ?? 1);
    });
  }

  function startWeb() {
    webChild = spawnNode(viteBin, [], webDir, 'inherit');
    webChild.on('exit', (code) => {
      if (stopping) return;
      console.error(`[stageflow] Web dev server exited (${code ?? 'signal'}).`);
      void shutdown(code ?? 1);
    });
  }

  async function stopApi() {
    const previous = apiChild;
    apiChild = null;
    if (!previous) return;
    killTree(previous);
    await Promise.race([waitForExit(previous), delay(5_000)]);
  }

  function scheduleApiRestart(delayMs = 400) {
    if (stopping || !acceptRestarts) return;
    if (restarting) {
      pendingRestart = true;
      return;
    }
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      void restartApi();
    }, delayMs);
  }

  async function restartApi() {
    if (stopping) return;
    restarting = true;
    console.log('[stageflow] Shared output updated; restarting the API.');
    await stopApi();
    if (stopping) return;
    startApi();
    restarting = false;
    if (pendingRestart) {
      pendingRestart = false;
      scheduleApiRestart();
    }
  }

  function watchDist() {
    distWatcher = watch(distDir, { recursive: true }, () => {
      scheduleApiRestart();
    });
  }

  async function shutdown(code = 0) {
    if (stopping) return;
    stopping = true;
    acceptRestarts = false;
    clearTimeout(restartTimer);
    distWatcher?.close();
    await stopApi();
    if (webChild) killTree(webChild);
    await shared.stop();
    if (options.exitOnStop !== false) process.exit(code);
  }

  process.on('SIGINT', () => {
    void shutdown(0);
  });
  process.on('SIGTERM', () => {
    void shutdown(0);
  });

  try {
    await shared.ready;
  } catch (error) {
    await shared.stop();
    throw error;
  }

  if (wantsApi) startApi();
  if (wantsWeb) startWeb();
  acceptRestarts = wantsApi;
  if (wantsApi && !shared.owned) watchDist();

  return {
    api: apiChild,
    web: webChild,
    stop: () => shutdown(0),
  };
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function isDirectRun() {
  const entry = process.argv[1];
  return Boolean(entry) && pathToFileURL(entry).href === import.meta.url;
}

if (isDirectRun()) {
  runDev(process.argv[2] ?? 'all').catch((error) => {
    console.error(error instanceof Error ? error.message : error);
    process.exit(1);
  });
}
