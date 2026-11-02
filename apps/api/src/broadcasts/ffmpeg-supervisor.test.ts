import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';
import type { ChildProcessWithoutNullStreams } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { afterEach, expect, it, vi } from 'vitest';
import { FfmpegSupervisor, type SpawnFfmpeg } from './ffmpeg-supervisor';
import { buildHlsArgs } from '@stageflow/shared';

function fixture() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  const spawn = vi.fn<SpawnFfmpeg>(() => {
    queueMicrotask(() => child.emit('spawn'));
    return child as unknown as ChildProcessWithoutNullStreams;
  });
  const supervisor = new FfmpegSupervisor('ffmpeg-test', spawn, 100, 100);
  return { child, spawn, supervisor };
}
afterEach(() => vi.useRealTimers());

it('starts one child, writes stdin bytes, and closes stdin on clean stop', async () => {
  const { supervisor, child, spawn } = fixture();
  await supervisor.start('server directory');
  expect(spawn).toHaveBeenCalledWith('ffmpeg-test', buildHlsArgs('server directory'));
  await expect(supervisor.start('again')).rejects.toThrow('already');
  const bytes = Buffer.from('header and media');
  await supervisor.write(bytes);
  expect(child.stdin.read()).toEqual(bytes);
  child.stdin.once('finish', () => child.emit('close', 0));
  expect(await supervisor.stop()).toEqual({ code: 0, error: '', premature: false });
  expect(spawn).toHaveBeenCalledOnce();
});

it('captures a premature exit, caps stderr, and never spawns a replacement', async () => {
  const { supervisor, child, spawn } = fixture();
  await supervisor.start('server directory');
  child.stderr.write('x'.repeat(2500) + 'last error');
  child.emit('close', 1);
  const result = await supervisor.done;
  expect(result.premature).toBe(true);
  expect(result.code).toBe(1);
  expect(result.error).toHaveLength(2000);
  expect(result.error.endsWith('last error')).toBe(true);
  await expect(supervisor.write(Buffer.from('late'))).rejects.toThrow();
  expect(spawn).toHaveBeenCalledOnce();
});

it('kills a child that does not exit after stdin closes', async () => {
  const { supervisor, child } = fixture();
  await supervisor.start('server directory');
  vi.useFakeTimers();
  const stopped = supervisor.stop();
  await vi.advanceTimersByTimeAsync(100);
  expect(await stopped).toMatchObject({
    code: null,
    premature: false,
    error: 'FFmpeg did not exit after stop.',
  });
  expect(child.kill).toHaveBeenCalledWith('SIGKILL');
});

it('reports a missing binary without failing construction or restarting', async () => {
  const supervisor = new FfmpegSupervisor(`missing-ffmpeg-${randomUUID()}`);
  await expect(supervisor.start('unused')).rejects.toThrow('missing-ffmpeg-');
  const exit = await supervisor.done;
  expect(exit.premature).toBe(true);
  expect(exit.code).not.toBe(0);
});

it('bounds a stalled stdin write and terminates the child without advancing history', async () => {
  const { supervisor, child } = fixture();
  await supervisor.start('server directory');
  child.stdin.cork();
  vi.useFakeTimers();
  const write = supervisor.write(Buffer.from('blocked'));
  const refused = expect(write).rejects.toThrow('input stalled');
  await vi.advanceTimersByTimeAsync(100);
  await refused;
  expect(child.kill).toHaveBeenCalledWith('SIGKILL');
  expect(supervisor.history.nextExpected).toBe(0);
  expect(await supervisor.done).toMatchObject({ code: null, premature: true });
});
