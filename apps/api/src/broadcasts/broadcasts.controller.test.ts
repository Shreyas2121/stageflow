import 'reflect-metadata';
import { randomUUID } from 'node:crypto';
import { lstat, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Module } from '@nestjs/common';
import { NestFactory } from '@nestjs/core';
import { JwtService } from '@nestjs/jwt';
import type { NestExpressApplication } from '@nestjs/platform-express';
import type { FindOperator, Repository } from 'typeorm';
import { expect, it, vi } from 'vitest';
import { ApiExceptionFilter } from '../http/api-exception.filter';
import { RoomsService } from '../rooms/rooms.service';
import { SessionsService } from '../sessions/sessions.service';
import { JwtAuthGuard } from '../sessions/jwt-auth.guard';
import type { User } from '../users/user.entity';
import type { Broadcast } from './broadcast.entity';
import { BroadcastsController } from './broadcasts.controller';
import { BroadcastsService } from './broadcasts.service';
import { prepareBroadcastDirectory } from './hls-path';

// Vitest does not emit Nest constructor metadata.
Reflect.defineMetadata('design:paramtypes', [BroadcastsService], BroadcastsController);
Reflect.defineMetadata('design:paramtypes', [SessionsService], JwtAuthGuard);

it('enforces replay privacy on authenticated JSON, history, thumbnail, playlist, and segment routes', async () => {
  const root = await mkdtemp(join(tmpdir(), 'sf-replay-http-'));
  const owner = {
    id: randomUUID(),
    isGuest: false,
    email: 'owner@example.test',
    sessionVersion: 0,
  } as User;
  const googleOwner = {
    id: randomUUID(),
    isGuest: false,
    email: null,
    passwordHash: null,
    googleSubject: 'fixture-subject',
    sessionVersion: 0,
  } as User;
  const guestOwner = { id: randomUUID(), isGuest: true, sessionVersion: 0 } as User;
  const otherHost = { ...owner, id: randomUUID() };
  const guest = { ...guestOwner, id: randomUUID() };
  const users = [owner, googleOwner, guestOwner, otherHost, guest];
  const rooms = users
    .slice(0, 3)
    .map((user) => ({ id: randomUUID(), hostId: user.id, slug: randomUUID().slice(0, 12) }));
  const rows: Broadcast[] = [];
  type MutationWhere = {
    id: string;
    status?: Broadcast['status'] | FindOperator<Broadcast['status'][]>;
  };
  const match = (row: Broadcast, where: MutationWhere) =>
    row.id === where.id &&
    (where.status === undefined ||
      (typeof where.status === 'string'
        ? row.status === where.status
        : where.status.value.includes(row.status)));
  const repository = {
    update: vi.fn(async (where: MutationWhere, patch: Partial<Broadcast>) => {
      const row = rows.find((row) => match(row, where));
      if (!row) return { affected: 0 };
      Object.assign(row, patch);
      return { affected: 1 };
    }),
    delete: vi.fn(async (where: MutationWhere) => {
      const index = rows.findIndex((row) => match(row, where));
      if (index < 0) return { affected: 0 };
      rows.splice(index, 1);
      return { affected: 1 };
    }),
    findOneBy: vi.fn(async ({ id }: { id: string }) => rows.find((row) => row.id === id) ?? null),
    find: vi.fn(
      async ({ where }: { where: { roomId: string; visibility?: unknown; status: unknown } }) =>
        rows.filter(
          (row) =>
            row.roomId === where.roomId &&
            (where.status === 'DELETING' ? row.status === 'DELETING' : row.status !== 'DELETING') &&
            (where.visibility !== 'LINK' || row.visibility === 'LINK'),
        ),
    ),
  };
  const roomService = {
    getById: async (id: string) => rooms.find((room) => room.id === id) ?? null,
    getBySlug: async (slug: string) => rooms.find((room) => room.slug === slug),
  };
  const service = new BroadcastsService(
    repository as unknown as Repository<Broadcast>,
    roomService as unknown as RoomsService,
    undefined,
    root,
    undefined,
    { read: async () => null, close: async () => {} },
  );
  const jwt = new JwtService({
    secret: randomUUID(),
    signOptions: { algorithm: 'HS256', expiresIn: '12h' },
  });
  const sessions = new SessionsService(
    {
      findOneBy: async ({ id }: { id: string }) => users.find((user) => user.id === id) ?? null,
    } as unknown as Repository<User>,
    jwt,
  );
  class FixtureModule {}
  Module({
    controllers: [BroadcastsController],
    providers: [
      { provide: BroadcastsService, useValue: service },
      { provide: SessionsService, useValue: sessions },
    ],
  })(FixtureModule);
  let app: NestExpressApplication | undefined;
  try {
    for (const room of rooms) {
      for (const visibility of ['LINK', 'HOST'] as const) {
        const id = randomUUID();
        const directory = await prepareBroadcastDirectory(root, id);
        await writeFile(
          join(directory, 'index.m3u8'),
          '#EXTM3U\nsegment000001.ts\n#EXT-X-ENDLIST\n',
        );
        await writeFile(join(directory, 'segment000001.ts'), 'fixture-segment');
        await writeFile(join(directory, 'thumbnail.jpg'), 'fixture-thumbnail');
        rows.push({
          id,
          roomId: room.id,
          status: 'READY',
          visibility,
          playlistPath: `broadcasts/${id}/index.m3u8`,
          thumbnailPath: `broadcasts/${id}/thumbnail.jpg`,
          errorMessage: null,
          createdAt: new Date(),
          startedAt: new Date(),
          endedAt: new Date(),
        } as Broadcast);
      }
    }
    app = await NestFactory.create<NestExpressApplication>(FixtureModule, {
      logger: false,
      abortOnError: false,
    });
    app.setGlobalPrefix('api');
    app.useGlobalFilters(new ApiExceptionFilter());
    await app.listen(0, '127.0.0.1');
    const url = await app.getUrl();
    async function read(path: string, user?: User, method = 'GET', body?: unknown) {
      const headers: Record<string, string> = {};
      if (user)
        headers.Authorization = `Bearer ${await jwt.signAsync({ sub: user.id, sv: user.sessionVersion, guest: user.isGuest })}`;
      if (body !== undefined) headers['Content-Type'] = 'application/json';
      return fetch(`${url}/api/${path}`, {
        headers,
        method,
        body: body === undefined ? undefined : JSON.stringify(body),
      });
    }
    const missing = {
      statusCode: 404,
      error: 'broadcast_not_found',
      message: 'No broadcast exists for that id.',
    };
    for (const room of rooms) {
      const registeredOwner = users.find((user) => user.id === room.hostId && !user.isGuest);
      for (const row of rows.filter((row) => row.roomId === room.id)) {
        for (const suffix of ['', '/thumbnail.jpg', '/hls/index.m3u8', '/hls/segment000001.ts']) {
          const path = `broadcasts/${row.id}${suffix}`;
          const unauthenticated = await read(path);
          expect(unauthenticated.status).toBe(401);
          await unauthenticated.text();
          for (const user of users) {
            const response = await read(path, user);
            const allowed = row.visibility === 'LINK' || user === registeredOwner;
            expect(response.status, `${row.visibility} ${suffix} ${user.id}`).toBe(
              allowed ? 200 : 404,
            );
            if (!allowed) expect(await response.json()).toEqual(missing);
            else if (!suffix)
              expect(await response.json()).toMatchObject({
                id: row.id,
                visibility: row.visibility,
              });
            else
              expect(await response.text()).toContain(
                suffix === '/thumbnail.jpg'
                  ? 'fixture-thumbnail'
                  : suffix.endsWith('.ts')
                    ? 'fixture-segment'
                    : '#EXTM3U',
              );
          }
        }
      }
      for (const user of users) {
        const response = await read(`rooms/${room.slug}/broadcasts`, user);
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({
          items: rows
            .filter(
              (row) =>
                row.roomId === room.id && (row.visibility === 'LINK' || user === registeredOwner),
            )
            .map((row) => ({ id: row.id, visibility: row.visibility })),
          nextCursor: null,
        });
      }
    }
    const privateRow = rows.find((row) => row.visibility === 'HOST')!;
    await rm(join(root, 'broadcasts', privateRow.id, 'segment000001.ts'));
    expect((await read(`broadcasts/${privateRow.id}/hls/segment000001.ts`, owner)).status).toBe(
      404,
    );
    expect(
      await (await read(`broadcasts/${privateRow.id}/hls/segment000001.ts`, owner)).json(),
    ).toMatchObject({ error: 'media_not_found' });
    expect(await (await read(`broadcasts/${randomUUID()}`, guest)).json()).toEqual(missing);
    privateRow.status = 'DELETING';
    expect(await (await read(`rooms/${rooms[0]!.slug}/broadcast-deletions`, owner)).json()).toEqual(
      {
        items: [
          {
            id: privateRow.id,
            roomId: privateRow.roomId,
            createdAt: privateRow.createdAt.toISOString(),
          },
        ],
        nextCursor: null,
      },
    );
    for (const user of [guest, otherHost]) {
      const response = await read(`rooms/${rooms[0]!.slug}/broadcast-deletions`, user);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual(missing);
    }
    for (const user of [owner, guest]) {
      for (const suffix of ['', '/thumbnail.jpg', '/hls/index.m3u8', '/hls/segment000001.ts'])
        expect(await (await read(`broadcasts/${privateRow.id}${suffix}`, user)).json()).toEqual(
          missing,
        );
      expect(await (await read(`rooms/${rooms[0]!.slug}/broadcasts`, user)).json()).toMatchObject({
        items: [{ visibility: 'LINK' }],
        nextCursor: null,
      });
    }

    privateRow.status = 'READY';
    for (const [user, expected] of [
      [guest, 404],
      [otherHost, 404],
      [undefined, 401],
    ] as const) {
      const hidden = await read(`broadcasts/${privateRow.id}/visibility`, user, 'POST', {
        visibility: 'LINK',
      });
      expect(hidden.status).toBe(expected);
      await hidden.text();
      const deleted = await read(`broadcasts/${privateRow.id}`, user, 'DELETE');
      expect(deleted.status).toBe(expected);
      await deleted.text();
    }
    const guestReplay = rows.find((row) => row.roomId === rooms[2]!.id)!;
    for (const response of [
      await read(`broadcasts/${guestReplay.id}/visibility`, guestOwner, 'POST', {
        visibility: 'HOST',
      }),
      await read(`broadcasts/${guestReplay.id}`, guestOwner, 'DELETE'),
    ]) {
      expect(response.status).toBe(403);
      expect(await response.json()).toMatchObject({ error: 'replay_owner_required' });
    }
    for (const user of [owner, googleOwner]) {
      const replay = rows.find(
        (row) =>
          row.roomId === rooms.find((room) => room.hostId === user.id)!.id &&
          row.visibility === 'LINK',
      )!;
      for (const visibility of ['HOST', 'LINK']) {
        const response = await read(`broadcasts/${replay.id}/visibility`, user, 'POST', {
          visibility,
          status: 'LIVE',
        });
        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ visibility, status: 'READY' });
      }
      const invalid = await read(`broadcasts/${replay.id}/visibility`, user, 'POST', {
        visibility: 'host',
      });
      expect(invalid.status).toBe(400);
      expect(await invalid.json()).toMatchObject({ error: 'invalid_visibility' });
      replay.status = 'LIVE';
      expect((await read(`broadcasts/${replay.id}`, user, 'DELETE')).status).toBe(409);
      expect(
        (await read(`broadcasts/${replay.id}/visibility`, user, 'POST', { visibility: 'HOST' }))
          .status,
      ).toBe(409);
      replay.status = 'READY';
      const staleRetry = await read(`broadcasts/${replay.id}/deletion-retry`, user, 'POST');
      expect(staleRetry.status).toBe(404);
      expect(await staleRetry.json()).toEqual(missing);
      // A failed catalog delete after media removal must not publish the old READY projection.
      expect(await service.snapshot(replay.roomId, replay.id)).toMatchObject({ status: 'READY' });
      repository.delete.mockRejectedValueOnce(new Error('database unavailable after removal'));
      const failedDelete = await read(`broadcasts/${replay.id}`, user, 'DELETE');
      expect(failedDelete.status).toBe(500);
      expect(await failedDelete.json()).toMatchObject({
        error: 'broadcast_delete_failed',
        message: 'The replay could not be deleted. Try again.',
      });
      expect(replay.status).toBe('DELETING');
      expect(await service.snapshot(replay.roomId, replay.id)).toBeNull();
      await expect(lstat(join(root, 'broadcasts', replay.id))).rejects.toMatchObject({
        code: 'ENOENT',
      });
      for (const reader of [user, otherHost, guest]) {
        for (const suffix of ['', '/thumbnail.jpg', '/hls/index.m3u8', '/hls/segment000001.ts']) {
          const response = await read(`broadcasts/${replay.id}${suffix}`, reader);
          expect(response.status).toBe(404);
          expect(await response.json()).toEqual(missing);
        }
        const history = await read(
          `rooms/${rooms.find((room) => room.id === replay.roomId)!.slug}/broadcasts`,
          reader,
        );
        expect(history.status).toBe(200);
        expect(await history.json()).toMatchObject({
          items: expect.not.arrayContaining([expect.objectContaining({ id: replay.id })]),
        });
      }
      const foreignRetry = await read(`broadcasts/${replay.id}`, otherHost, 'DELETE');
      expect(foreignRetry.status).toBe(404);
      expect(await foreignRetry.json()).toEqual(missing);
      const visibilityRetry = await read(`broadcasts/${replay.id}/visibility`, user, 'POST', {
        visibility: 'LINK',
      });
      expect(visibilityRetry.status).toBe(404);
      expect(await visibilityRetry.json()).toEqual(missing);
      const deletionPage = await read(
        `rooms/${rooms.find((room) => room.id === replay.roomId)!.slug}/broadcast-deletions`,
        user,
      );
      expect(await deletionPage.json()).toMatchObject({
        items: [expect.objectContaining({ id: replay.id })],
      });
      const deleted = await read(`broadcasts/${replay.id}/deletion-retry`, user, 'POST');
      expect(deleted.status).toBe(204);
      expect(await deleted.text()).toBe('');
      expect(await (await read(`broadcasts/${replay.id}`, user)).json()).toEqual(missing);
      expect(rooms.some((room) => room.id === replay.roomId)).toBe(true);
    }
  } finally {
    await app?.close();
    await rm(root, { recursive: true, force: true });
  }
});
