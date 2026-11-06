import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import type { Repository } from 'typeorm';
import { expect, it, vi } from 'vitest';
import type { RoomsService } from '../rooms/rooms.service';
import type { Broadcast } from './broadcast.entity';
import { BroadcastsService } from './broadcasts.service';

function fixture() {
  const rows = new Map<string, Broadcast>();
  const repository = {
    findOne: vi.fn(
      async ({ where }: { where: { roomId: string } }) => rows.get(where.roomId) ?? null,
    ),
    findOneBy: vi.fn(async ({ id, roomId }: { id: string; roomId: string }) => {
      const row = rows.get(roomId);
      return row?.id === id ? row : null;
    }),
  };
  const service = new BroadcastsService(
    repository as unknown as Repository<Broadcast>,
    {} as RoomsService,
  );
  return { rows, repository, service };
}

it('bounds 10,000 missing-room projections and reloads an evicted negative result', async () => {
  const f = fixture();
  for (let i = 0; i < 10_000; i++) await f.service.snapshot(`history-${i}`, null);
  expect((Reflect.get(f.service, 'views') as Map<string, unknown>).size).toBeLessThanOrEqual(256);
  f.repository.findOne.mockClear();
  expect(await f.service.snapshot('history-9999', null)).toBeNull();
  expect(f.repository.findOne).not.toHaveBeenCalled();
  expect(await f.service.snapshot('history-0', null)).toBeNull();
  expect(f.repository.findOne).toHaveBeenCalledOnce();
});

it('keeps recently read null projections while evicting the least recently used room', async () => {
  const f = fixture();
  for (let i = 0; i < 256; i++) await f.service.snapshot(`room-${i}`, null);
  await f.service.snapshot('room-0', null);
  await f.service.snapshot('extra-room', null);
  f.repository.findOne.mockClear();
  await f.service.snapshot('room-0', null);
  expect(f.repository.findOne).not.toHaveBeenCalled();
  await f.service.snapshot('room-1', null);
  expect(f.repository.findOne).toHaveBeenCalledOnce();
});

it.each(['STARTING', 'LIVE', 'STOPPING', 'READY', 'FAILED'] as const)(
  'reloads an evicted %s projection from its durable row',
  async (status) => {
    const f = fixture();
    const roomId = randomUUID(),
      id = randomUUID();
    f.rows.set(roomId, {
      id,
      roomId,
      status,
      visibility: 'HOST',
      playlistPath: status === 'READY' ? `broadcasts/${id}/index.m3u8` : null,
      thumbnailPath: null,
      errorMessage: status === 'FAILED' ? 'encoder failed' : null,
      startedAt: new Date(),
      createdAt: new Date(),
      endedAt: null,
    } as Broadcast);
    const original = await f.service.snapshot(roomId, id);
    for (let i = 0; i < 1_000; i++) await f.service.snapshot(`old-room-${i}`, null);
    expect(await f.service.snapshot(roomId, id)).toEqual(original);
    expect(f.repository.findOneBy).toHaveBeenCalledTimes(2);
    expect(await f.service.snapshot(roomId, null)).toEqual(original);
  },
);

it('does not cache a failed repository read as a missing broadcast', async () => {
  const f = fixture();
  f.repository.findOne.mockRejectedValueOnce(new Error('database unavailable'));
  await expect(f.service.snapshot('room', null)).rejects.toThrow('database unavailable');
  expect(await f.service.snapshot('room', null)).toBeNull();
  expect(f.repository.findOne).toHaveBeenCalledTimes(2);
});

it('bounds unfinished loads too and does not resurrect evicted entries when they resolve', async () => {
  const f = fixture();
  let resolve!: (row: Broadcast | null) => void;
  const gate = new Promise<Broadcast | null>((done) => {
    resolve = done;
  });
  f.repository.findOne.mockImplementation(() => gate);
  const pending = Array.from({ length: 1_000 }, (_, i) => f.service.snapshot(`pending-${i}`, null));
  expect((Reflect.get(f.service, 'views') as Map<string, unknown>).size).toBeLessThanOrEqual(256);
  resolve(null);
  await Promise.all(pending);
  expect((Reflect.get(f.service, 'views') as Map<string, unknown>).size).toBeLessThanOrEqual(256);
  f.repository.findOne.mockClear();
  await f.service.snapshot('pending-999', null);
  expect(f.repository.findOne).not.toHaveBeenCalled();
  await f.service.snapshot('pending-0', null);
  expect(f.repository.findOne).toHaveBeenCalledOnce();
});
