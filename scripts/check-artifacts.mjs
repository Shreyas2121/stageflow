import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import { gzipSync } from 'node:zlib';

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
  assert.equal(lua.length, 19);
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
  const { ChatRepository } = require(join(dist, 'chat/chat.repository.js'));
  const { roomPrefix, liveKeys } = require(join(dist, 'live/live.keys.js'));
  new LiveRepository({}); // Loads every compiled Lua asset without connecting to a service.
  const chatSource = join(root, 'apps/api/src/chat/scripts');
  const chatLua = (await readdir(chatSource)).filter((name) => name.endsWith('.lua')).sort();
  assert.deepEqual(chatLua, ['accept.lua', 'history.lua', 'setPaused.lua']);
  assert.deepEqual(
    (await readdir(join(dist, 'chat/scripts'))).filter((name) => name.endsWith('.lua')).sort(),
    chatLua,
  );
  for (const name of chatLua)
    assert.deepEqual(
      await readFile(join(dist, 'chat/scripts', name)),
      await readFile(join(chatSource, name)),
      name,
    );
  new ChatRepository({});
  const { QaRepository } = require(join(dist, 'qa/qa.repository.js'));
  const qaSource = join(root, 'apps/api/src/qa/scripts');
  const qaLua = (await readdir(qaSource)).filter((name) => name.endsWith('.lua')).sort();
  assert.deepEqual(qaLua, ['delete.lua', 'state.lua', 'submit.lua', 'vote.lua']);
  assert.deepEqual(
    (await readdir(join(dist, 'qa/scripts'))).filter((name) => name.endsWith('.lua')).sort(),
    qaLua,
  );
  for (const name of qaLua)
    assert.deepEqual(
      await readFile(join(dist, 'qa/scripts', name)),
      await readFile(join(qaSource, name)),
      name,
    );
  new QaRepository({});
  assert.equal(liveKeys(roomPrefix('probe', 'sf_ci')).length, 10);
  assert.equal(liveKeys(roomPrefix('probe', 'sf_ci'))[5], 'sf_ci:room:probe:broadcast');
  const shared = require('@stageflow/shared');
  assert.equal(shared.isUuid('00000000-0000-4000-8000-000000000001'), true);
  console.log(
    'API artifacts: production modules load, nineteen live, three chat, and four Q&A Lua files match source, no emitted tests.',
  );
}

if (!args.length || args.includes('--web')) {
  const dist = join(root, 'apps/web/dist');
  const manifest = JSON.parse(await readFile(join(dist, '.vite/manifest.json'), 'utf8'));
  const entryKey = Object.keys(manifest).find((key) => manifest[key].isEntry);
  assert(entryKey, 'Missing web entry.');
  const entry = manifest[entryKey];
  const roomKey = (entry.dynamicImports ?? []).find((key) => /RoomPage/.test(key));
  const replayKey = (entry.dynamicImports ?? []).find((key) => /ReplayPage/.test(key));
  assert(roomKey && manifest[roomKey]?.isDynamicEntry, 'Room route must remain a dynamic entry.');
  assert(
    replayKey && manifest[replayKey]?.isDynamicEntry,
    'Replay route must remain a dynamic entry.',
  );
  const html = await readFile(join(dist, 'index.html'), 'utf8');
  assert(html.includes(entry.file), 'HTML must load the manifest entry.');
  assert(!html.includes(manifest[roomKey].file), 'HTML eagerly loads the room chunk.');
  assert(!html.includes(manifest[replayKey].file), 'HTML eagerly loads the replay chunk.');
  // Static imports only. Dynamic imports stay available for the playback request.
  function closure(key, seen = new Set(), dynamic = new Set()) {
    if (seen.has(key)) return { seen, dynamic };
    assert(manifest[key], `Missing imported chunk ${key}.`);
    seen.add(key);
    for (const imported of manifest[key].dynamicImports ?? []) dynamic.add(imported);
    for (const imported of manifest[key].imports ?? []) closure(imported, seen, dynamic);
    return { seen, dynamic };
  }
  function exclusive(root, shared) {
    const seen = new Set();
    function visit(key) {
      if (seen.has(key) || shared.has(key)) return;
      assert(manifest[key], `Missing imported chunk ${key}.`);
      seen.add(key);
      for (const imported of manifest[key].imports ?? []) visit(imported);
    }
    visit(root);
    return seen;
  }
  const home = closure(entryKey);
  assert(!home.seen.has(roomKey), 'Home statically imports the room.');
  assert(!home.seen.has(replayKey), 'Home statically imports the replay.');
  for (const chunk of Object.values(manifest)) {
    for (const file of [chunk.file, ...(chunk.css ?? []), ...(chunk.assets ?? [])]) {
      const path = resolve(dist, file);
      assert(path.startsWith(resolve(dist) + sep), 'Artifact path leaves dist.');
      assert((await stat(path)).isFile(), `Missing asset ${file}.`);
    }
  }
  const room = closure(roomKey, new Set(home.seen));
  const replay = closure(replayKey, new Set(home.seen));
  const playbackKeys = [...room.dynamic, ...replay.dynamic].filter((key) =>
    key.endsWith('broadcast-player.tsx'),
  );
  assert.equal(
    new Set(playbackKeys).size,
    1,
    'Attendee playback and replay must share one deferred player chunk.',
  );
  const playerKey = playbackKeys[0];
  assert(!home.dynamic.has(playerKey), 'Home dynamically imports the HLS player.');
  assert(!room.seen.has(playerKey), 'A meeting or host room statically imports the HLS player.');
  assert(!replay.seen.has(playerKey), 'Opening replay statically imports the HLS player.');
  assert(!html.includes(manifest[playerKey].file), 'HTML preloads the HLS player.');
  const playback = exclusive(playerKey, room.seen);
  const hlsMarker = 'hlsMediaAttaching';
  async function measure(keys) {
    const files = [];
    for (const path of new Set(
      [...keys].flatMap((key) => [manifest[key].file, ...(manifest[key].css ?? [])]),
    )) {
      const body = await readFile(join(dist, path));
      files.push({
        path,
        raw: body.length,
        gzip: gzipSync(body).length,
        text: body.toString('utf8'),
      });
    }
    return {
      raw: files.reduce((sum, file) => sum + file.raw, 0),
      gzip: files.reduce((sum, file) => sum + file.gzip, 0),
      files,
    };
  }
  const homeMeasured = await measure(home.seen);
  const roomMeasured = await measure(room.seen);
  const replayMeasured = await measure(replay.seen);
  const playbackMeasured = await measure(playback);
  for (const file of [...homeMeasured.files, ...roomMeasured.files, ...replayMeasured.files]) {
    assert(
      !file.text.includes(hlsMarker),
      `Static graph includes the HLS runtime in ${file.path}.`,
    );
  }
  assert(
    playbackMeasured.files.some((file) => file.text.includes(hlsMarker)),
    'Deferred playback chunk does not contain the HLS runtime.',
  );
  // NODE_ENV=production on 2026-11-03, player deferred: home 328220 raw / 103199
  // gzip-estimate; room including entry 457729 / 141946; replay including entry
  // 341894 / 108456; deferred player 579836 / 178964. Development React output is
  // larger. These ceilings still fail if that player returns to a static graph.
  // They do not hide Vite's chunk-size warning. Gzip figures estimate compressed
  // artifacts; they are not observed network transfer.
  assert(homeMeasured.raw <= 650_000, `Home static graph is ${homeMeasured.raw} raw bytes.`);
  assert(
    roomMeasured.raw <= 800_000,
    `Meeting/host room static graph is ${roomMeasured.raw} raw bytes.`,
  );
  assert(replayMeasured.raw <= 700_000, `Replay static graph is ${replayMeasured.raw} raw bytes.`);
  assert(
    playbackMeasured.raw >= 400_000,
    `Deferred HLS player is ${playbackMeasured.raw} raw bytes.`,
  );
  for (const [name, measured] of [
    ['home', homeMeasured],
    ['room including entry', roomMeasured],
    ['replay including entry', replayMeasured],
    ['deferred playback', playbackMeasured],
  ]) {
    console.log(
      `Web ${name}: ${measured.raw} raw bytes, ${measured.gzip} gzip-estimate bytes across ${measured.files.length} JS/CSS assets. Gzip figures are compressed artifact sizes, not observed network transfer.`,
    );
    for (const file of [...measured.files].sort((left, right) => right.raw - left.raw)) {
      console.log(`  ${file.raw} raw, ${file.gzip} gzip-estimate ${file.path}`);
    }
  }
  console.log(
    `Web artifacts: ${entry.file}; lazy room ${manifest[roomKey].file}; lazy replay ${manifest[replayKey].file}; deferred player ${manifest[playerKey].file}; all manifest assets exist.`,
  );
}
