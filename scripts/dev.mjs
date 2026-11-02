import { spawn, spawnSync } from 'node:child_process';
import { randomBytes, randomUUID } from 'node:crypto';
import { readFileSync, watch } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { devShutdownPath, requestDevShutdown } from './dev-shutdown.mjs';
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

export const gracefulStopMs = 15_000;

/**
 * Nest's `start --watch` restarts by calling `taskkill /T /F` on Windows, which skips
 * application shutdown and leaves the non-expiring owner guard behind. Compile with
 * `nest build --watch` and stop the API through the local channel before replacing it.
 */
export function devProcessCommands(binaries) {
  const {
    execPath,
    dotenvCli: dotenvBin,
    nestBin: nest,
    envFile: env,
    apiDir: directory,
  } = binaries;
  return {
    compiler: [execPath, dotenvBin, '-e', env, '--', nest, 'build', '--watch'],
    api: [execPath, dotenvBin, '-e', env, '--', execPath, join(directory, 'dist', 'main.js')],
  };
}

export function forceStopMessage(graceMs) {
  return `[stageflow] API graceful shutdown exceeded ${graceMs}ms. Force-stopping the process tree. The Redis owner guard was not released by this stop. Confirm no API or FFmpeg process remains for this namespace, inspect <LIVE_NAMESPACE>:owner, and delete only that key before starting another API. This supervisor will not take over a surviving guard.`;
}

function isAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error.code === 'EPERM';
  }
}

export function killPid(pid) {
  if (!Number.isInteger(pid) || pid <= 0 || pid === process.pid) return;
  if (process.platform === 'win32') {
    spawnSync('taskkill', ['/pid', String(pid), '/t', '/f'], {
      windowsHide: true,
      stdio: 'ignore',
    });
    return;
  }
  try {
    process.kill(pid, 'SIGTERM');
  } catch (error) {
    if (error.code !== 'ESRCH') throw error;
  }
}

export function killTree(child) {
  if (!child?.pid || !isAlive(child.pid)) return;
  killPid(child.pid);
}

export function listDescendantPids(rootPid) {
  if (!Number.isInteger(rootPid) || rootPid <= 0) return [];
  if (process.platform === 'win32') {
    const script = [
      `$root = ${rootPid}`,
      '$all = @(Get-CimInstance Win32_Process | Select-Object ProcessId,ParentProcessId)',
      '$pending = [System.Collections.Generic.Queue[int]]::new()',
      '$pending.Enqueue($root)',
      '$seen = @{}',
      'while ($pending.Count -gt 0) {',
      '  $parent = $pending.Dequeue()',
      '  foreach ($row in $all) {',
      '    $procId = [int]$row.ProcessId',
      '    if ($row.ParentProcessId -eq $parent -and -not $seen.ContainsKey($procId)) {',
      '      $seen[$procId] = $true',
      '      $pending.Enqueue($procId)',
      '      Write-Output $procId',
      '    }',
      '  }',
      '}',
    ].join('\n');
    const result = spawnSync(
      'powershell.exe',
      ['-NoProfile', '-NonInteractive', '-Command', script],
      { encoding: 'utf8', windowsHide: true },
    );
    if (result.status !== 0) {
      throw new Error(`Unable to list child processes. ${result.stderr ?? ''}`.trim());
    }
    return result.stdout
      .split(/\r?\n/)
      .map((line) => Number(line.trim()))
      .filter((pid) => Number.isInteger(pid) && pid > 0);
  }
  const result = spawnSync('ps', ['-A', '-o', 'pid=,ppid='], { encoding: 'utf8' });
  if (result.status !== 0 || !result.stdout) throw new Error('Unable to list child processes.');
  const children = new Map();
  for (const line of result.stdout.split('\n')) {
    const match = line.trim().match(/^(\d+)\s+(\d+)$/);
    if (!match) continue;
    const pid = Number(match[1]);
    const parent = Number(match[2]);
    const list = children.get(parent) ?? [];
    list.push(pid);
    children.set(parent, list);
  }
  const found = [];
  const walk = (parent) => {
    for (const pid of children.get(parent) ?? []) {
      found.push(pid);
      walk(pid);
    }
  };
  walk(rootPid);
  return found;
}

function waitForExit(child) {
  if (!child || child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolve) => {
    child.once('exit', () => resolve());
  });
}

function hasExited(child) {
  return !child || child.exitCode !== null || child.signalCode !== null;
}

function treeExited(child, watched) {
  return hasExited(child) && watched.every((pid) => !isAlive(pid));
}

async function safeDescendants(list, pid) {
  try {
    return await list(pid);
  } catch (error) {
    console.error(error instanceof Error ? error.message : error);
    return [];
  }
}

export async function stopSupervised(child, options = {}) {
  if (hasExited(child)) return { forced: false };
  const graceMs = options.graceMs ?? gracefulStopMs;
  const list = options.listDescendants ?? listDescendantPids;
  const kill = options.killTree ?? killTree;
  let watched = await safeDescendants(list, child.pid);
  const deadline = Date.now() + graceMs;
  let accepted = false;
  while (Date.now() < deadline) {
    if (treeExited(child, watched)) return { forced: false };
    if (!accepted && options.channel && options.token) {
      const remaining = deadline - Date.now();
      try {
        await requestDevShutdown(
          options.channel,
          options.token,
          Math.max(50, Math.min(300, remaining)),
        );
        accepted = true;
        watched = await safeDescendants(list, child.pid);
      } catch (error) {
        if (error instanceof Error && error.message.includes('refused')) accepted = true;
      }
    }
    if (treeExited(child, watched)) return { forced: false };
    await delay(Math.min(50, Math.max(0, deadline - Date.now())));
  }
  if (treeExited(child, watched)) return { forced: false };
  const message = forceStopMessage(graceMs);
  console.error(message);
  options.onForceStop?.(message);
  kill(child);
  for (const pid of watched) killPid(pid);
  await Promise.race([waitForExit(child), delay(options.forceWaitMs ?? 5_000)]);
  return { forced: true };
}

function readLines(stream, onLine) {
  if (!stream) return;
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
  let needsOwnerRecovery = false;
  let recoveryAnnounced = false;
  let compilerStarted = false;
  let apiChild = null;
  let compilerChild = null;
  let webChild = null;
  let distWatcher = null;
  let restartTimer = null;
  const restartDelay = options.restartDelayMs ?? 400;
  const quickDelay = options.restartDelayMs ?? 150;

  const shared =
    options.shared ??
    (await watchShared({
      onRebuild: () => {
        if (wantsApi) scheduleApiRestart(quickDelay, 'Shared output updated');
      },
      onExit: (code) => {
        void shutdown(code);
      },
    }));

  function spawnNode(script, args, cwd, stdio) {
    return spawn(process.execPath, [script, ...args], {
      cwd,
      env: process.env,
      windowsHide: true,
      stdio,
    });
  }

  function announceRecovery() {
    if (recoveryAnnounced) return;
    recoveryAnnounced = true;
    console.error(
      '[stageflow] Further API restarts are paused until the owner guard is recovered. This supervisor will not delete it.',
    );
  }

  function startApi() {
    if (stopping || needsOwnerRecovery) {
      if (needsOwnerRecovery) announceRecovery();
      return;
    }
    const shutdown = {
      channel: devShutdownPath(randomUUID()),
      token: randomBytes(16).toString('hex'),
    };
    const stdio = options.apiStdio ?? ['ignore', 'inherit', 'inherit'];
    const command =
      options.apiCommand ??
      devProcessCommands({
        execPath: process.execPath,
        dotenvCli,
        nestBin,
        envFile,
        apiDir,
      }).api;
    const child = spawn(command[0], command.slice(1), {
      cwd: apiDir,
      env: {
        ...process.env,
        STAGEFLOW_DEV_SHUTDOWN: shutdown.channel,
        STAGEFLOW_DEV_SHUTDOWN_TOKEN: shutdown.token,
      },
      windowsHide: true,
      stdio,
    });
    child.stageflowShutdown = shutdown;
    apiChild = child;
    options.onApi?.(child);
    child.on('exit', (code) => {
      if (stopping || restarting || apiChild !== child) return;
      console.error(`[stageflow] API dev server exited (${code ?? 'signal'}).`);
      void shutdown(code ?? 1);
    });
  }

  function onCompilerLine(line) {
    // TypeScript's watch status is the same sentence Nest uses to decide a compile succeeded.
    const visible = line
      .split(String.fromCharCode(27))
      .map((part, index) => (index === 0 ? part : part.replace(/^[[0-9;]*m/, '')))
      .join('');
    if (!visible.includes('0 errors')) return;
    if (!compilerStarted) {
      compilerStarted = true;
      startApi();
      return;
    }
    scheduleApiRestart(quickDelay, 'API build updated');
  }

  function startCompiler() {
    const commands = devProcessCommands({
      execPath: process.execPath,
      dotenvCli,
      nestBin,
      envFile,
      apiDir,
    });
    const command = options.apiCompilerCommand ?? commands.compiler;
    const child = spawn(command[0], command.slice(1), {
      cwd: apiDir,
      env: process.env,
      windowsHide: true,
      stdio: [options.apiCompilerCommand ? 'pipe' : 'inherit', 'pipe', 'pipe'],
    });
    compilerChild = child;
    const echo = (line, write) => {
      if (!options.apiCompilerCommand) write(`${line}\n`);
      onCompilerLine(line);
    };
    readLines(child.stdout, (line) => echo(line, (text) => process.stdout.write(text)));
    readLines(child.stderr, (line) => echo(line, (text) => process.stderr.write(text)));
    child.on('exit', (code) => {
      if (stopping || compilerChild !== child) return;
      console.error(`[stageflow] API compiler exited (${code ?? 'signal'}).`);
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
    const result = await stopSupervised(previous, {
      channel: previous.stageflowShutdown?.channel,
      token: previous.stageflowShutdown?.token,
      graceMs: options.graceMs,
      onForceStop: options.onForceStop,
    });
    if (result.forced) needsOwnerRecovery = true;
  }

  function scheduleApiRestart(delayMs = restartDelay, reason = 'Shared output updated') {
    if (stopping || !acceptRestarts || needsOwnerRecovery) {
      if (needsOwnerRecovery) announceRecovery();
      return;
    }
    if (restarting) {
      pendingRestart = true;
      return;
    }
    clearTimeout(restartTimer);
    restartTimer = setTimeout(() => {
      void restartApi(reason);
    }, delayMs);
  }

  async function restartApi(reason) {
    if (stopping) return;
    restarting = true;
    console.log(`[stageflow] ${reason}; restarting the API.`);
    await stopApi();
    if (!stopping && !needsOwnerRecovery) startApi();
    else if (needsOwnerRecovery) announceRecovery();
    restarting = false;
    if (pendingRestart) {
      pendingRestart = false;
      scheduleApiRestart(restartDelay, reason);
    }
  }

  function watchDist() {
    distWatcher = watch(options.distDir ?? distDir, { recursive: true }, () => {
      scheduleApiRestart(restartDelay, 'API output updated');
    });
  }

  const onSigint = () => {
    void shutdown(0);
  };
  const onSigterm = () => {
    void shutdown(0);
  };

  async function shutdown(code = 0) {
    if (stopping) return;
    stopping = true;
    acceptRestarts = false;
    clearTimeout(restartTimer);
    distWatcher?.close();
    try {
      await stopApi();
      if (compilerChild) {
        const compiler = compilerChild;
        compilerChild = null;
        killTree(compiler);
        await Promise.race([waitForExit(compiler), delay(5_000)]);
      }
      if (webChild) {
        const web = webChild;
        webChild = null;
        killTree(web);
        await Promise.race([waitForExit(web), delay(5_000)]);
      }
      await shared.stop();
    } finally {
      process.off('SIGINT', onSigint);
      process.off('SIGTERM', onSigterm);
      if (options.exitOnStop !== false) process.exit(code);
    }
  }

  process.on('SIGINT', onSigint);
  process.on('SIGTERM', onSigterm);

  try {
    await shared.ready;
  } catch (error) {
    await shared.stop();
    process.off('SIGINT', onSigint);
    process.off('SIGTERM', onSigterm);
    throw error;
  }

  acceptRestarts = wantsApi;
  const usesCompiler = wantsApi && (options.apiCompilerCommand || !options.apiCommand);
  if (usesCompiler) startCompiler();
  else if (wantsApi) startApi();
  if (wantsWeb) startWeb();
  if (wantsApi && !shared.owned) watchDist();

  return {
    api: apiChild,
    compiler: compilerChild,
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
