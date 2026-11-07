import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { mkdir, readFile, readdir } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { basename, dirname, join, resolve } from 'node:path';
import { tmpdir } from 'node:os';

const require = createRequire(new URL('../apps/api/package.json', import.meta.url));
const baselineNames = [
  'CreateUsersAndRooms1730332800000',
  'CreateBroadcasts1793577600000',
  'IndexRoomsByHost1793664000000',
];

/** Seed the real pre-V3 schema only inside the broadcast harness's disposable database/root. */
export async function prepareLegacyUpgrade({ options, mediaRoot, ffmpeg, command, jwtSecret }) {
  assert.match(new URL(options.url).pathname, /^\/sf_broadcast_[a-f0-9]{32}$/);
  assert.equal(dirname(resolve(mediaRoot)), resolve(tmpdir()));
  assert(basename(mediaRoot).startsWith('stageflow-broadcast-'));
  const migrations = options.migrations.slice(0, 3);
  assert.deepEqual(
    migrations.map((migration) => migration.name),
    baselineNames,
  );
  const { DataSource } = require('typeorm');
  const legacy = new DataSource({ ...options, entities: [], migrations, logging: false });
  const userId = randomUUID(),
    liveRoomId = randomUUID(),
    endedRoomId = randomUUID(),
    readyId = randomUUID();
  const timestamp = '2026-01-02T03:04:05.123456Z';
  const directory = join(mediaRoot, 'broadcasts', readyId);
  await mkdir(directory, { recursive: true });
  await command(ffmpeg, [
    '-hide_banner',
    '-loglevel',
    'error',
    '-y',
    '-f',
    'lavfi',
    '-i',
    'color=c=0x184841:s=1280x720:r=24',
    '-f',
    'lavfi',
    '-i',
    'sine=frequency=440:sample_rate=48000',
    '-t',
    '2',
    '-c:v',
    'libx264',
    '-threads',
    '1',
    '-preset',
    'ultrafast',
    '-pix_fmt',
    'yuv420p',
    '-g',
    '24',
    '-c:a',
    'aac',
    '-b:a',
    '128k',
    '-ac',
    '2',
    '-f',
    'hls',
    '-hls_time',
    '1',
    '-hls_playlist_type',
    'event',
    '-hls_flags',
    'independent_segments',
    '-hls_segment_filename',
    join(directory, 'segment%06d.ts'),
    join(directory, 'index.m3u8'),
  ]);
  const hashes = async () =>
    Object.fromEntries(
      await Promise.all(
        (await readdir(directory)).sort().map(async (name) => [
          name,
          createHash('sha256')
            .update(await readFile(join(directory, name)))
            .digest('hex'),
        ]),
      ),
    );
  const originalHashes = await hashes();
  assert(Object.keys(originalHashes).some((name) => /^segment\d{6}\.ts$/.test(name)));
  const snapshot = async (source) => ({
    users: await source.query(
      'SELECT id, display_name, is_guest, created_at::text FROM users WHERE id = $1',
      [userId],
    ),
    rooms: await source.query(
      'SELECT id, slug, title, mode, status, host_id, created_at::text, ended_at::text FROM rooms WHERE host_id = $1 ORDER BY id',
      [userId],
    ),
    broadcasts: await source.query(
      'SELECT id, room_id, status, playlist_path, thumbnail_path, error_message, started_at::text, ended_at::text, created_at::text FROM broadcasts WHERE id = $1',
      [readyId],
    ),
  });
  let original;
  await legacy.initialize();
  try {
    assert.deepEqual(
      (await legacy.runMigrations()).map((migration) => migration.name),
      baselineNames,
    );
    assert.equal(
      (
        await legacy.query(
          "SELECT column_name FROM information_schema.columns WHERE table_name = 'users' AND column_name = 'session_version'",
        )
      ).length,
      0,
    );
    await legacy.query(
      'INSERT INTO users (id, display_name, is_guest, created_at) VALUES ($1, $2, true, $3)',
      [userId, 'Pre-V3 guest', timestamp],
    );
    for (const [id, status] of [
      [liveRoomId, 'LIVE'],
      [endedRoomId, 'ENDED'],
    ]) {
      await legacy.query(
        'INSERT INTO rooms (id, slug, title, mode, status, host_id, created_at, ended_at) VALUES ($1, $2, $3, $4, $5, $6, $7, $8)',
        [
          id,
          randomUUID().replaceAll('-', '').slice(0, 12),
          `Pre-V3 ${status}`,
          'WEBINAR',
          status,
          userId,
          timestamp,
          status === 'ENDED' ? timestamp : null,
        ],
      );
    }
    await legacy.query(
      "INSERT INTO broadcasts (id, room_id, status, playlist_path, started_at, ended_at, created_at) VALUES ($1, $2, 'READY', $3, $4, $4, $4)",
      [readyId, endedRoomId, `broadcasts/${readyId}/index.m3u8`, timestamp],
    );
    original = await snapshot(legacy);
  } finally {
    await legacy.destroy();
  }
  const { JwtService } = require('@nestjs/jwt');
  // Legacy tokens deliberately have neither an sv nor guest claim.
  const token = new JwtService({ secret: jwtSecret }).sign({ sub: userId }, { expiresIn: '12h' });
  return {
    baselineNames,
    async verify(source, request) {
      assert.deepEqual(
        await snapshot(source),
        original,
        'Upgrade/restart changed pre-V3 catalog data.',
      );
      assert.deepEqual(await hashes(), originalHashes, 'Upgrade/restart changed pre-V3 HLS bytes.');
      assert.deepEqual(
        await source.query(
          'SELECT email, password_hash, session_version, google_subject FROM users WHERE id = $1',
          [userId],
        ),
        [{ email: null, password_hash: null, session_version: 0, google_subject: null }],
      );
      assert.deepEqual(
        await source.query('SELECT visibility FROM broadcasts WHERE id = $1', [readyId]),
        [{ visibility: 'LINK' }],
      );
      assert(
        (
          await source.query(
            'SELECT scheduled_start_at, require_admission FROM rooms WHERE host_id = $1',
            [userId],
          )
        ).every((room) => room.scheduled_start_at === null && room.require_admission === false),
      );
      assert.deepEqual(await source.runMigrations(), []);
      if (request) {
        const rooms = await (await request('/rooms', token)).json();
        assert.deepEqual(
          rooms.items.map((room) => room.id).sort(),
          [liveRoomId, endedRoomId].sort(),
        );
        const replay = await (await request(`/broadcasts/${readyId}`, token)).json();
        assert.equal(replay.status, 'READY');
        assert.equal(replay.visibility, 'LINK');
        const playlist = await (
          await request(`/broadcasts/${readyId}/hls/index.m3u8`, token)
        ).text();
        assert.match(playlist, /#EXT-X-ENDLIST/);
        for (const name of playlist
          .split(/\r?\n/)
          .filter((line) => line && !line.startsWith('#'))) {
          assert.match(name, /^segment\d{6,}\.ts$/);
          const bytes = Buffer.from(
            await (await request(`/broadcasts/${readyId}/hls/${name}`, token)).arrayBuffer(),
          );
          assert.equal(createHash('sha256').update(bytes).digest('hex'), originalHashes[name]);
        }
        const decoded = await command(ffmpeg, [
          '-hide_banner',
          '-i',
          join(directory, 'index.m3u8'),
          '-map',
          '0:v:0',
          '-map',
          '0:a:0',
          '-f',
          'null',
          '-',
        ]);
        assert.match(decoded, /Video: h264/);
        assert.match(decoded, /1280x720/);
        assert.match(decoded, /Audio: aac/);
      }
    },
  };
}
