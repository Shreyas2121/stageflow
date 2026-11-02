import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';

const root = fileURLToPath(new URL('../', import.meta.url));
const args = process.argv.slice(2);
assert(
  args.every((arg) => ['--api', '--web'].includes(arg)),
  'Use --api or --web, or omit flags for both.',
);
async function files(directory) {
  const result = [];
  for (const entry of await readdir(directory, { withFileTypes: true })) {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) result.push(...(await files(path)));
    else result.push(path);
  }
  return result;
}

if (!args.length || args.includes('--api')) {
  const dist = join(root, 'apps/api/dist');
  const output = await files(dist);
  assert(output.includes(join(dist, 'main.js')), 'Missing API entry.');
  assert(
    !output.some((path) => /(?:\.(?:test|spec)\.|[/\\]__tests__[/\\])/.test(path)),
    'Tests leaked into API output.',
  );
  for (const path of output.filter((path) => path.endsWith('.js'))) {
    assert(
      !/require\(["']vitest["']\)/.test(await readFile(path, 'utf8')),
      `Vitest leaked into ${path}.`,
    );
  }
  const source = join(root, 'apps/api/src/live/scripts');
  const lua = (await readdir(source)).filter((name) => name.endsWith('.lua')).sort();
  assert.equal(lua.length, 10);
  assert.deepEqual(
    (await readdir(join(dist, 'live/scripts'))).filter((name) => name.endsWith('.lua')).sort(),
    lua,
  );
  for (const name of lua)
    assert.deepEqual(
      await readFile(join(dist, 'live/scripts', name)),
      await readFile(join(source, name)),
      name,
    );
  const require = createRequire(join(root, 'apps/api/package.json'));
  const { LiveRepository } = require(join(dist, 'live/live.repository.js'));
  const { roomPrefix, liveKeys } = require(join(dist, 'live/live.keys.js'));
  new LiveRepository({}); // Loads every compiled Lua asset without connecting to a service.
  assert.equal(liveKeys(roomPrefix('probe', 'sf_ci')).length, 6);
  const shared = require('@stageflow/shared');
  assert.equal(shared.isUuid('00000000-0000-4000-8000-000000000001'), true);
  console.log(
    'API artifacts: production modules load, ten Lua files match source, no emitted tests.',
  );
}

if (!args.length || args.includes('--web')) {
  const dist = join(root, 'apps/web/dist');
  const manifest = JSON.parse(await readFile(join(dist, '.vite/manifest.json'), 'utf8'));
  const entryKey = Object.keys(manifest).find((key) => manifest[key].isEntry);
  assert(entryKey, 'Missing web entry.');
  const entry = manifest[entryKey];
  const roomKey = (entry.dynamicImports ?? []).find((key) => /RoomPage/.test(key));
  assert(roomKey && manifest[roomKey]?.isDynamicEntry, 'Room route must remain a dynamic entry.');
  const html = await readFile(join(dist, 'index.html'), 'utf8');
  assert(html.includes(entry.file), 'HTML must load the manifest entry.');
  assert(!html.includes(manifest[roomKey].file), 'HTML eagerly loads the room chunk.');
  function graph(key, seen = new Set()) {
    if (seen.has(key)) return seen;
    assert(manifest[key], `Missing imported chunk ${key}.`);
    seen.add(key);
    for (const imported of manifest[key].imports ?? []) graph(imported, seen);
    return seen;
  }
  const home = graph(entryKey);
  assert(!home.has(roomKey), 'Home statically imports the room.');
  for (const chunk of Object.values(manifest)) {
    for (const file of [chunk.file, ...(chunk.css ?? []), ...(chunk.assets ?? [])]) {
      const path = resolve(dist, file);
      assert(path.startsWith(resolve(dist) + sep), 'Artifact path leaves dist.');
      assert((await stat(path)).isFile(), `Missing asset ${file}.`);
    }
  }
  const room = graph(roomKey, new Set(home));
  for (const [name, keys] of [
    ['home', home],
    ['room including entry', room],
  ]) {
    const paths = new Set(
      [...keys].flatMap((key) => [manifest[key].file, ...(manifest[key].css ?? [])]),
    );
    let bytes = 0;
    for (const path of paths) bytes += (await stat(join(dist, path))).size;
    console.log(`Web ${name}: ${bytes} raw bytes across ${paths.size} JS/CSS assets.`);
  }
  console.log(
    `Web artifacts: ${entry.file}; lazy room ${manifest[roomKey].file}; all manifest assets exist.`,
  );
}
