import { createHash, randomUUID } from 'node:crypto';
import {
  existsSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  renameSync,
  rmdirSync,
  unlinkSync,
  writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';

const workspace = fileURLToPath(new URL('../', import.meta.url));
const require = createRequire(import.meta.url);
const delay = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    if (error.code === 'ESRCH') return false;
    if (error.code === 'EPERM') return true;
    throw error;
  }
};
function inside(root, file) {
  const path = relative(root, file);
  if (!path || path.startsWith('..') || isAbsolute(path))
    throw new Error(`Unsafe shared output path: ${file}`);
  return path;
}
function missing(error) {
  if (error.code !== 'ENOENT') throw error;
}
// Windows readers/virus scanners can briefly deny replacement or deletion.
// Retry the atomic operation; never unlink the destination to make it succeed.
function sharingRetry(action) {
  const deadline = Date.now() + 2_000;
  const signal = new Int32Array(new SharedArrayBuffer(4));
  for (;;) {
    try {
      return action();
    } catch (error) {
      if (
        process.platform !== 'win32' ||
        !['EPERM', 'EACCES', 'EBUSY'].includes(error.code) ||
        Date.now() >= deadline
      )
        throw error;
      Atomics.wait(signal, 0, 0, 10);
    }
  }
}
function atomicJson(file, value) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    writeFileSync(temporary, JSON.stringify(value));
    sharingRetry(() => renameSync(temporary, file));
  } finally {
    try {
      sharingRetry(() => unlinkSync(temporary));
    } catch (error) {
      missing(error);
    }
  }
}

/** A separate root lets concurrency tests exercise real compilers without touching workspace output. */
export function createSharedBuilder({ root = workspace, timeoutMs = 60_000, pollMs = 100 } = {}) {
  root = resolve(root);
  const shared = join(root, 'packages/shared');
  const config = join(shared, 'tsconfig.build.json');
  const dist = join(shared, 'dist');
  const cache = join(root, 'node_modules/.cache');
  const successes = join(cache, 'stageflow-shared-builds');
  const lock = join(cache, 'stageflow-shared-writer');
  const ts = () => require('typescript');

  function readOwner() {
    let entries;
    try {
      entries = readdirSync(lock);
    } catch (error) {
      missing(error);
      return null;
    }
    const files = entries.filter((name) => name.endsWith('.json'));
    if (!files.length) return null;
    if (files.length !== 1)
      throw new Error('Ambiguous shared writer ownership; stop writers before recovery.');
    let owner;
    try {
      owner = JSON.parse(sharingRetry(() => readFileSync(join(lock, files[0]), 'utf8')));
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    if (
      !Number.isSafeInteger(owner.pid) ||
      owner.pid <= 0 ||
      !['build', 'watch'].includes(owner.mode) ||
      files[0] !== `${owner.token}.json`
    )
      throw new Error('Invalid shared writer ownership; stop writers before recovery.');
    const state = entries
      .filter((name) => name.startsWith(`${owner.token}.`) && name.endsWith('.state'))
      .sort()
      .at(-1);
    if (!state) return owner;
    try {
      return JSON.parse(readFileSync(join(lock, state), 'utf8'));
    } catch (error) {
      missing(error);
      // A newer state may have superseded this one between the directory and file reads.
      return { ...owner, status: 'compiling' };
    }
  }
  function removeOwner(owner) {
    // Never recursively remove the lock. A competing owner has a different filename,
    // and rmdir cannot remove a newly acquired, nonempty directory.
    try {
      for (const file of readdirSync(lock)) {
        if (
          file.startsWith(`${owner.token}.`) &&
          (file.endsWith('.tmp') || file.endsWith('.state'))
        )
          sharingRetry(() => unlinkSync(join(lock, file)));
      }
    } catch (error) {
      missing(error);
    }
    try {
      sharingRetry(() => unlinkSync(join(lock, `${owner.token}.json`)));
    } catch (error) {
      missing(error);
    }
    try {
      sharingRetry(() => rmdirSync(lock));
    } catch (error) {
      if (!['ENOENT', 'ENOTEMPTY', 'EEXIST'].includes(error.code)) throw error;
    }
  }
  function legacyOwner() {
    const file = join(cache, 'stageflow-shared-watch.pid');
    if (!existsSync(file)) return;
    const pid = Number(readFileSync(file, 'utf8').trim());
    if (!Number.isSafeInteger(pid) || pid <= 0 || alive(pid))
      throw new Error(
        'Stop the shared watcher using the old build protocol before starting a new writer.',
      );
  }
  async function acquire(mode, deadline) {
    mkdirSync(cache, { recursive: true });
    legacyOwner();
    const owner = {
      pid: process.pid,
      token: randomUUID(),
      mode,
      generation: 0,
      status: 'starting',
    };
    const candidate = join(cache, `stageflow-shared-candidate-${owner.token}`);
    mkdirSync(candidate);
    writeFileSync(join(candidate, `${owner.token}.json`), JSON.stringify(owner));
    try {
      while (Date.now() < deadline) {
        const current = readOwner();
        if (current && !alive(current.pid)) {
          removeOwner(current);
          continue;
        }
        if (current?.mode === 'watch') return { owner: current, owned: false };
        if (!current) {
          // Windows cannot replace an existing directory even if it is empty.
          // Empty is unowned: every acquired directory already contains its record.
          try {
            rmdirSync(lock);
          } catch (error) {
            if (!['ENOENT', 'ENOTEMPTY', 'EEXIST', 'EPERM', 'EACCES'].includes(error.code))
              throw error;
          }
          try {
            renameSync(candidate, lock);
            return { owner, owned: true };
          } catch (error) {
            if (
              !['EEXIST', 'ENOTEMPTY', 'EPERM', 'EACCES'].includes(error.code) ||
              !existsSync(lock)
            )
              throw error;
          }
        }
        await delay(pollMs);
      }
      throw new Error('Timed out waiting for the shared package writer.');
    } finally {
      if (existsSync(candidate)) {
        unlinkSync(join(candidate, `${owner.token}.json`));
        rmdirSync(candidate);
      }
    }
  }
  function parseConfig() {
    const compiler = ts();
    const reads = new Map();
    const read = (file) => {
      const content = compiler.sys.readFile(file);
      reads.set(resolve(file), content ?? '(missing)');
      return content;
    };
    const loaded = compiler.readConfigFile(config, read);
    const parsed = compiler.parseJsonConfigFileContent(
      loaded.config ?? {},
      { ...compiler.sys, readFile: read },
      shared,
      undefined,
      config,
    );
    return { parsed, reads, errors: [...(loaded.error ? [loaded.error] : []), ...parsed.errors] };
  }
  function inputHash() {
    const { parsed, reads } = parseConfig();
    for (const file of parsed.fileNames) {
      try {
        reads.set(file, readFileSync(file));
      } catch (error) {
        missing(error);
        reads.set(file, '(missing)');
      }
    }
    for (const file of [
      join(shared, 'package.json'),
      join(root, 'package.json'),
      join(root, 'pnpm-lock.yaml'),
      join(root, 'pnpm-workspace.yaml'),
    ]) {
      try {
        reads.set(file, readFileSync(file));
      } catch (error) {
        missing(error);
      }
    }
    const hash = createHash('sha256')
      .update(ts().version)
      .update(readFileSync(fileURLToPath(import.meta.url)));
    for (const [file, content] of [...reads].sort(([a], [b]) => a.localeCompare(b)))
      hash.update(file).update('\0').update(content).update('\0');
    return hash.digest('hex');
  }
  const digest = (bytes) => createHash('sha256').update(bytes).digest('hex');
  function outputsMatch(snapshot) {
    if (!Array.isArray(snapshot.files) || !snapshot.files.length) return false;
    const expected = new Set();
    try {
      for (const file of snapshot.files) {
        if (
          !file ||
          typeof file.path !== 'string' ||
          typeof file.hash !== 'string' ||
          isAbsolute(file.path) ||
          file.path.startsWith('..')
        )
          return false;
        const path = resolve(dist, file.path);
        if (relative(dist, path).startsWith('..')) return false;
        if (digest(readFileSync(path)) !== file.hash) return false;
        expected.add(path);
      }
      if (!expected.has(join(dist, 'index.js')) || !expected.has(join(dist, 'index.d.ts')))
        return false;
      const visit = (directory) => {
        for (const entry of readdirSync(directory, { withFileTypes: true })) {
          const path = join(directory, entry.name);
          if (entry.isDirectory()) {
            if (!visit(path)) return false;
          } else if (!entry.isFile() || !expected.delete(path)) return false;
        }
        return true;
      };
      return visit(dist) && expected.size === 0;
    } catch (error) {
      missing(error);
      return false;
    }
  }
  function reusableBuild() {
    if (!existsSync(successes)) return false;
    const input = inputHash();
    for (const file of readdirSync(successes)
      .filter((name) => name.endsWith('.json'))
      .sort()
      .reverse()) {
      let record;
      try {
        record = JSON.parse(readFileSync(join(successes, file), 'utf8'));
      } catch (error) {
        if (error instanceof SyntaxError || error.code === 'ENOENT') continue;
        throw error;
      }
      if (
        record?.version === 1 &&
        record.input === input &&
        outputsMatch(record) &&
        input === inputHash()
      )
        return true;
    }
    return false;
  }
  function rememberBuild(owner) {
    mkdirSync(successes, { recursive: true });
    const name = `${Date.now()}-${randomUUID()}.json`;
    atomicJson(join(successes, name), { version: 1, input: owner.input, files: owner.files });
    for (const file of readdirSync(successes)) {
      if (file === name || !file.endsWith('.json')) continue;
      try {
        unlinkSync(join(successes, file));
      } catch (error) {
        if (!['ENOENT', 'EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      }
    }
  }
  function currentReady(owner) {
    if (!owner || owner.status !== 'ready' || owner.input !== inputHash()) return false;
    try {
      if (!outputsMatch(owner)) return false;
      const current = readOwner();
      return (
        current?.token === owner.token &&
        current.generation === owner.generation &&
        current.status === 'ready'
      );
    } catch (error) {
      missing(error);
      return false;
    }
  }
  async function waitForOwner(owner, deadline, cancelled = () => false) {
    while (Date.now() < deadline) {
      if (cancelled()) throw new Error('Shared watcher subscription stopped.');
      const current = readOwner();
      if (!current || current.token !== owner.token || !alive(current.pid)) return false;
      if (currentReady(current)) return current;
      if (current.status === 'failed' && current.input === inputHash())
        throw new Error(current.error ?? 'Shared watcher compile failed.');
      await delay(pollMs);
    }
    throw new Error('Timed out waiting for the current shared package compile or missing output.');
  }
  function save(owner) {
    // Immutable records avoid overwriting metadata held by a Windows reader,
    // including an asynchronous reader in the watcher process itself.
    owner.sequence = (owner.sequence ?? 0) + 1;
    const name = `${owner.token}.${String(owner.sequence).padStart(12, '0')}.state`;
    atomicJson(join(lock, name), owner);
    const older = readdirSync(lock)
      .filter((file) => file.startsWith(`${owner.token}.`) && file.endsWith('.state'))
      .sort()
      .slice(0, -2);
    for (const file of older) {
      try {
        unlinkSync(join(lock, file));
      } catch (error) {
        // Busy old records can be collected on a later generation or owner release.
        if (!['ENOENT', 'EPERM', 'EACCES', 'EBUSY'].includes(error.code)) throw error;
      }
    }
  }
  function begin(owner) {
    owner.generation++;
    owner.status = 'compiling';
    owner.input = inputHash();
    delete owner.files;
    delete owner.error;
    save(owner);
  }
  function failed(owner, error) {
    owner.status = 'failed';
    owner.error = error.message;
    save(owner);
  }
  function prune(directory, emitted) {
    if (!existsSync(directory)) return;
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      inside(dist, path);
      if (entry.isDirectory()) prune(path, emitted);
      else if (!emitted.has(path)) sharingRetry(() => unlinkSync(path));
    }
  }
  function emit(owner, program) {
    const compiler = ts();
    const errors = compiler
      .getPreEmitDiagnostics(program)
      .filter((item) => item.category === compiler.DiagnosticCategory.Error);
    const output = new Map();
    const staging = join(cache, `stageflow-shared-output-${owner.token}`);
    const result = errors.length
      ? { emitSkipped: true, diagnostics: [] }
      : program.emit(undefined, (file, contents) => {
          const path = resolve(dist, inside(staging, resolve(file)));
          inside(dist, path);
          output.set(path, contents);
        });
    errors.push(
      ...result.diagnostics.filter((item) => item.category === compiler.DiagnosticCategory.Error),
    );
    if (errors.length || result.emitSkipped)
      throw new Error(
        compiler.formatDiagnostics(errors, {
          getCurrentDirectory: () => shared,
          getCanonicalFileName: (file) => file,
          getNewLine: () => '\n',
        }) || 'Shared compiler skipped output.',
      );
    if (!output.has(join(dist, 'index.js')) || !output.has(join(dist, 'index.d.ts')))
      throw new Error('Shared build did not emit index.js and index.d.ts.');
    if (owner.input !== inputHash())
      throw new Error('Shared inputs changed during compilation; retry after the current compile.');
    // Each complete file replaces its predecessor atomically. Unchanged files stay
    // in place, including while another app reads the previous successful build.
    for (const [file, content] of output) {
      mkdirSync(dirname(file), { recursive: true });
      if (existsSync(file) && readFileSync(file, 'utf8') === content) continue;
      const temporary = `${file}.${owner.token}.tmp`;
      try {
        writeFileSync(temporary, content);
        sharingRetry(() => renameSync(temporary, file));
      } finally {
        try {
          sharingRetry(() => unlinkSync(temporary));
        } catch (error) {
          missing(error);
        }
      }
    }
    prune(dist, output);
    if (owner.input !== inputHash())
      throw new Error('Shared inputs changed during publication; retry after the current compile.');
    owner.files = [...output].map(([file, content]) => ({
      path: relative(dist, file),
      hash: digest(content),
    }));
    owner.status = 'ready';
    save(owner);
    rememberBuild(owner);
  }
  function compilerOptions(owner) {
    return {
      noEmit: false,
      noEmitOnError: true,
      incremental: false,
      outDir: join(cache, `stageflow-shared-output-${owner.token}`),
    };
  }
  async function buildShared({ force = false } = {}) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const { owner, owned } = await acquire('build', deadline);
      if (!owned) {
        if (await waitForOwner(owner, deadline)) {
          console.log(`[shared] Using watcher generation ${readOwner()?.generation}.`);
          return { built: false };
        }
        continue;
      }
      try {
        if (!force && reusableBuild()) {
          console.log('[shared] Reusing verified output.');
          return { built: false };
        }
        begin(owner);
        const { parsed, errors } = parseConfig();
        if (errors.length)
          throw new Error(
            ts().formatDiagnosticsWithColorAndContext(errors, {
              getCurrentDirectory: () => shared,
              getCanonicalFileName: (file) => file,
              getNewLine: () => '\n',
            }),
          );
        const program = ts().createProgram({
          rootNames: parsed.fileNames,
          options: { ...parsed.options, ...compilerOptions(owner) },
        });
        emit(owner, program);
        console.log(`[shared] Compiled ${shared}.`);
        return { built: true };
      } catch (error) {
        failed(owner, error);
        throw error;
      } finally {
        removeOwner(owner);
      }
    }
  }
  async function waitForSharedReady(waitMs = timeoutMs) {
    const owner = readOwner();
    if (!owner || owner.mode !== 'watch' || !(await waitForOwner(owner, Date.now() + waitMs)))
      throw new Error('Shared watcher exited before the current compile was ready.');
  }
  async function watchShared({ onRebuild, onExit } = {}) {
    const { owner, owned } = await acquire('watch', Date.now() + timeoutMs);
    if (!owned) {
      let last;
      let stopped = false;
      const ready = waitForOwner(owner, Date.now() + timeoutMs, () => stopped).then((state) => {
        if (!state) throw new Error('Shared watcher exited before readiness.');
        last = state.generation;
      });
      ready.catch(() => {});
      const timer = setInterval(() => {
        if (stopped) return;
        try {
          const state = readOwner();
          if (state && state.token === owner.token && alive(state.pid)) {
            if (last !== undefined && state.generation !== last && currentReady(state)) {
              last = state.generation;
              onRebuild?.();
            }
            return;
          }
        } catch (error) {
          console.error(error.message);
        }
        stopped = true;
        clearInterval(timer);
        onExit?.(1);
      }, pollMs);
      return {
        owned: false,
        protocol: true,
        ready,
        waitForReady: waitForSharedReady,
        stop: async () => {
          stopped = true;
          clearInterval(timer);
        },
      };
    }
    let watcher;
    let stopped = false;
    let settled = false;
    let resolveReady;
    let rejectReady;
    const ready = new Promise((resolve, reject) => {
      resolveReady = resolve;
      rejectReady = reject;
    });
    ready.catch(() => {});
    const compiler = ts();
    const host = compiler.createWatchCompilerHost(
      config,
      compilerOptions(owner),
      compiler.sys,
      compiler.createAbstractBuilder,
      (diagnostic) => {
        console.error(compiler.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
      },
      () => {},
    );
    const createProgram = host.createProgram;
    host.createProgram = (...args) => {
      begin(owner);
      return createProgram(...args);
    };
    host.afterProgramCreate = (builder) => {
      try {
        emit(owner, builder.getProgram());
        console.log(`[shared] Generation ${owner.generation} ready.`);
        if (!settled) {
          settled = true;
          resolveReady();
        } else onRebuild?.();
      } catch (error) {
        failed(owner, error);
        console.error(error.message);
        if (!settled) {
          settled = true;
          rejectReady(error);
        }
      }
    };
    host.onUnRecoverableConfigFileDiagnostic = (diagnostic) => {
      const error = new Error(compiler.flattenDiagnosticMessageText(diagnostic.messageText, '\n'));
      failed(owner, error);
      rejectReady(error);
      setImmediate(() => onExit?.(1));
    };
    try {
      watcher = compiler.createWatchProgram(host);
    } catch (error) {
      removeOwner(owner);
      throw error;
    }
    return {
      owned: true,
      protocol: true,
      ready,
      waitForReady: waitForSharedReady,
      stop: async () => {
        if (stopped) return;
        stopped = true;
        watcher.close();
        rejectReady(new Error('Shared watcher stopped.'));
        removeOwner(owner);
      },
    };
  }
  return { buildShared, watchShared, waitForSharedReady };
}

const defaultBuilder = createSharedBuilder();
export const { buildShared, watchShared, waitForSharedReady } = defaultBuilder;
if (process.argv[1] && pathToFileURL(process.argv[1]).href === import.meta.url) {
  const command = process.argv[2];
  const run = async () => {
    if (command === 'build') return buildShared({ force: true });
    if (command === 'ensure') return buildShared();
    if (command !== 'watch')
      throw new Error('Usage: node scripts/shared-build.mjs <build|ensure|watch>');
    let watch;
    const stop = async (code) => {
      await watch?.stop();
      process.exit(code);
    };
    watch = await watchShared({
      onExit: (code) => {
        void stop(code);
      },
    });
    process.on('SIGINT', () => {
      void stop(0);
    });
    process.on('SIGTERM', () => {
      void stop(0);
    });
    try {
      await watch.ready;
    } catch (error) {
      console.error(error.message);
      await stop(1);
    }
  };
  run().catch((error) => {
    console.error(error.message);
    process.exitCode = 1;
  });
}
