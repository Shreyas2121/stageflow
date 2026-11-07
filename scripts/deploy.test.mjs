import assert from 'node:assert/strict';
import { test } from 'node:test';
import { mkdtempSync, mkdirSync, copyFileSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { checkProfile, removeFencedGuard } from '../deploy/ops.mjs';

const profile = {
  NODE_ENV: 'production',
  HOST: '127.0.0.1',
  TRUSTED_PROXIES: '127.0.0.1',
  CORS_ORIGIN: 'https://stageflow.test',
  DATA_ROOT: '/srv/stageflow/media',
  DATABASE_URL: 'postgresql://stageflow:unique@127.0.0.1:5542/stageflow',
  REDIS_URL: 'redis://:unique@127.0.0.1:6381',
  JWT_SECRET: 'a'.repeat(64),
  ENCODER_GLOBAL_LIMIT: '1',
  FFMPEG_THREADS: '1',
};

test('the operations CLI executes through a current release symlink', (t) => {
  const root = mkdtempSync(join(tmpdir(), 'sf-deploy-cli-'));
  assert(root.startsWith(join(tmpdir(), 'sf-deploy-cli-')));
  t.after(() => rmSync(root, { recursive: true, force: true }));
  const release = join(root, 'release');
  mkdirSync(join(release, 'deploy'), { recursive: true });
  copyFileSync(new URL('../deploy/ops.mjs', import.meta.url), join(release, 'deploy/ops.mjs'));
  symlinkSync(release, join(root, 'current'), 'junction');
  const result = spawnSync(
    process.execPath,
    [join(root, 'current/deploy/ops.mjs'), 'invalid-action'],
    { encoding: 'utf8', windowsHide: true },
  );
  assert.equal(result.status, 1);
  assert.match(result.stderr, /StageFlow invalid-action failed/);
});

test('the profile refuses public dependencies, development defaults, unsafe media and placeholder secrets', () => {
  checkProfile(profile);
  for (const change of [
    { NODE_ENV: 'development' },
    { HOST: '0.0.0.0' },
    { TRUSTED_PROXIES: '0.0.0.0' },
    { CORS_ORIGIN: 'http://stageflow.test' },
    { CORS_ORIGIN: 'https://stageflow.example.com' },
    { DATA_ROOT: '/opt/stageflow/current/media' },
    { DATA_ROOT: 'media' },
    { JWT_SECRET: 'CHANGE_ME'.repeat(8) },
    { DATABASE_URL: 'postgresql://stageflow:unique@db.example.com/stageflow' },
    { REDIS_URL: 'redis://127.0.0.1:6381' },
    { ENCODER_GLOBAL_LIMIT: '2' },
    { FFMPEG_THREADS: '2' },
  ])
    assert.throws(() => checkProfile({ ...profile, ...change }));
});

test('guard recovery refuses all unsafe service states before touching Redis', async () => {
  const stopped = { fenced: true, active: 'inactive', pid: '0', job: '', populated: false };
  let calls = 0;
  const redis = {
    eval: async () => {
      calls++;
      return 1;
    },
  };
  const token = '123:11111111-1111-4111-8111-111111111111';
  for (const change of [
    { fenced: false },
    { active: 'active' },
    { active: 'activating' },
    { active: 'deactivating' },
    { pid: '123' },
    { job: '12/start' },
    { populated: true },
  ])
    await assert.rejects(removeFencedGuard(redis, 'sf_fixture', token, { ...stopped, ...change }));
  assert.equal(calls, 0);
  await assert.rejects(removeFencedGuard(redis, 'sf_fixture', 'wrong', stopped));
  assert.equal(calls, 0);
  await removeFencedGuard(redis, 'sf_fixture', token, stopped);
  assert.equal(calls, 1);
});

test('recovery uses one compare-delete and refuses a missing or replacement owner', async () => {
  let argumentsSeen;
  const redis = {
    eval: async (...args) => {
      argumentsSeen = args;
      return 0;
    },
  };
  const token = '123:11111111-1111-4111-8111-111111111111';
  await assert.rejects(
    removeFencedGuard(redis, 'sf_fixture', token, {
      fenced: true,
      active: 'failed',
      pid: '0',
      job: '',
      populated: false,
    }),
    /nothing was deleted/,
  );
  assert.deepEqual(argumentsSeen.slice(1), [1, 'sf_fixture:owner', token]);
  assert.match(argumentsSeen[0], /GET.*ARGV\[1\].*DEL/);
});
