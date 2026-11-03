import { roomPrefix } from './live.keys';
import { Logger } from '@nestjs/common';
import { createHash } from 'node:crypto';
import {
  canRelay,
  type CommandAck,
  type JoinRoomRequest,
  type ResumeRoomRequest,
  type StageError,
  type TransportBinding,
  type RoomSnapshot,
  type StageCommand,
  type StageForceMute,
} from '@stageflow/shared';
import type { RoomsService } from '../rooms/rooms.service';
import type { LiveRepository, LiveRoom, LiveResult } from './live.repository';
import { SerializedOperations, WorkCapacityError } from './serialized-operations';
import { failure } from './signaling.messages';
import type { BroadcastsService } from '../broadcasts/broadcasts.service';
export type BroadcastControl = {
  service: Pick<BroadcastsService, 'snapshot' | 'start' | 'stopRoom' | 'failInterrupted'>;
  repository: Pick<
    LiveRepository,
    'readBroadcast' | 'readParticipant' | 'refreshSnapshot' | 'tryBeginBroadcast' | 'clearBroadcast'
  >;
};
export interface LiveSession {
  id: string;
  user: { id: string; displayName: string };
  readonly connected: boolean;
  room: LiveRoom | undefined;
  participantId?: string;
  generation?: number;
  isSyntheticBot?: boolean;
}
export type LiveClock = { now(): number; schedule(action: () => void, delay: number): () => void };
const systemClock: LiveClock = {
  now: () => Date.now(),
  schedule(action, delay) {
    const timer = setTimeout(action, delay);
    timer.unref();
    return () => clearTimeout(timer);
  },
};
type ResumeResult =
  | { ok: true; participantId: string; connectionGeneration: number; snapshot: RoomSnapshot }
  | Extract<CommandAck, { ok: false }>;
// Transport effects run inside the operation queue to preserve snapshot/membership ordering.
export interface LiveTransport {
  join(socketId: string, roomId: string): Promise<void>;
  leave(socketId: string, roomId: string): Promise<void>;
  publish(snapshot: RoomSnapshot): void;
  forceMute(socketId: string, payload: StageForceMute): void;
  peer(socketId: string): { connected: boolean; roomId: string | undefined } | undefined;
  end(roomId: string): void | Promise<void>;
}
export class LiveService {
  private readonly logger = new Logger(LiveService.name);
  // Rooms whose host shutdown has not finished catalog end, key deletion, and notification.
  private readonly ending = new Set<string>();
  // Known broadcast projection. A missing key is not loaded; null means no attempt.
  private readonly broadcastView = new Map<string, RoomSnapshot['broadcast']>();
  // Revisions Redis already committed whose room snapshot was not published.
  private readonly unpublished = new Map<string, Extract<LiveResult, { ok: true }>>();
  private readonly leaving = new Map<
    string,
    { task: Promise<CommandAck>; followup?: Promise<CommandAck> }
  >();
  private readonly suspendedRooms = new Map<
    string,
    { room: LiveRoom; transport: LiveTransport; deadline: number }
  >();
  private readonly pendingDisconnects = new Map<
    string,
    { client: LiveSession; transport: LiveTransport; now: number }
  >();
  private cancelSweep?: () => void;
  private disposed = false;
  constructor(
    private readonly rooms: Pick<RoomsService, 'getById' | 'end'>,
    private readonly live: Pick<
      LiveRepository,
      'apply' | 'readStage' | 'readConnectedStage' | 'readSocket' | 'readParticipant' | 'deleteRoom'
    >,
    private readonly operations: SerializedOperations,
    private readonly availability: { isReady(): boolean } = { isReady: () => true },
    private readonly namespace = 'sf',
    private readonly broadcasts?: BroadcastControl,
    private readonly clock: LiveClock = systemClock,
  ) {}

  private binding(client: LiveSession): TransportBinding {
    return {
      participantId: client.participantId ?? '',
      socketId: client.id,
      generation: client.generation ?? 0,
    };
  }

  private async validateBinding(
    client: LiveSession,
    room: LiveRoom,
    allowMissing = false,
  ): Promise<StageError | null> {
    const participant = client.participantId
      ? await this.live.readParticipant(
          roomPrefix(room.roomId, this.namespace),
          client.participantId,
        )
      : null;
    if (!participant) return allowMissing ? null : 'stale_transport';
    return participant.presence === 'connected' &&
      participant.socketId === client.id &&
      participant.connectionGeneration === client.generation
      ? null
      : 'stale_transport';
  }

  private clearBinding(client: LiveSession): void {
    client.room = undefined;
    client.participantId = undefined;
    client.generation = undefined;
    client.isSyntheticBot = undefined;
  }

  private scheduleSweep(): void {
    if (
      this.disposed ||
      this.cancelSweep ||
      (!this.suspendedRooms.size && !this.pendingDisconnects.size)
    )
      return;
    const earliest = Math.min(...[...this.suspendedRooms.values()].map((entry) => entry.deadline));
    const remaining = earliest - this.clock.now();
    const delay = remaining > 0 ? Math.min(1000, remaining) : 1000;
    this.cancelSweep = this.clock.schedule(() => {
      this.cancelSweep = undefined;
      void this.sweep()
        .catch((error: unknown) =>
          this.logger.error(
            error instanceof Error ? error.message : 'Live reservation sweep failed.',
          ),
        )
        .finally(() => this.scheduleSweep());
    }, delay);
  }

  private trackSuspended(
    result: Extract<LiveResult, { ok: true }>,
    room: LiveRoom,
    transport: LiveTransport,
  ): void {
    if (!result.roomEnded && result.state.participants.some((p) => p.presence === 'suspended'))
      this.suspendedRooms.set(room.roomId, {
        room,
        transport,
        deadline: Math.min(...Object.values(result.state.deadlines)),
      });
    else this.suspendedRooms.delete(room.roomId);
    this.scheduleSweep();
  }

  async sweep(): Promise<void> {
    for (const { client, transport } of this.pendingDisconnects.values())
      await this.disconnect(client, transport);
    for (const roomId of this.suspendedRooms.keys()) await this.expire(roomId);
  }

  onModuleDestroy(): void {
    this.disposed = true;
    this.cancelSweep?.();
    this.cancelSweep = undefined;
  }

  private async expireInRoom(room: LiveRoom, transport: LiveTransport, now: number): Promise<void> {
    if (this.ending.has(room.roomId)) {
      await this.finishShutdown(room, transport);
      return;
    }
    const result = await this.live.apply(roomPrefix(room.roomId, this.namespace), room, {
      type: 'expire',
      now,
    });
    if (!result.ok) throw new Error('Live reservation expiry failed.');
    if (result.roomEnded) await this.finishShutdown(room, transport);
    else {
      this.trackSuspended(result, room, transport);
      await this.publish(result, transport);
    }
  }

  // Internal operation shared by scheduled expiry and the socket smoke. It is never a socket event.
  async expire(roomId: string, now = this.clock.now()): Promise<CommandAck> {
    const tracked = this.suspendedRooms.get(roomId);
    if (!tracked) return { ok: true };
    try {
      await this.operations.run(
        `room:${roomId}`,
        () => this.expireInRoom(tracked.room, tracked.transport, now),
        true,
      );
      return { ok: true };
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : 'Live reservation expiry failed.');
      return failure('server_error');
    }
  }

  private async failedResult(
    result: Extract<LiveResult, { ok: false }>,
    room: LiveRoom,
    transport: LiveTransport,
  ): Promise<Extract<CommandAck, { ok: false }>> {
    if (result.expiry) {
      if (result.expiry.roomEnded) await this.finishShutdown(room, transport);
      else {
        const expiry = { ...result.expiry, revision: result.revision };
        this.trackSuspended(expiry, room, transport);
        await this.publish(expiry, transport);
      }
    }
    return failure(result.error);
  }
  private execute<T extends CommandAck>(
    client: LiveSession,
    action: () => Promise<T>,
    cleanup = false,
  ): Promise<T | Extract<CommandAck, { ok: false }>> {
    return this.operations
      .run(
        `socket:${client.id}`,
        async () => {
          if (!this.availability.isReady()) return failure('server_error');
          if (!cleanup && !client.connected) return failure('not_joined');
          return action();
        },
        cleanup,
      )
      .catch((error: unknown) => {
        if (error instanceof WorkCapacityError) return failure('server_busy');
        this.logger.error(error instanceof Error ? error.message : 'Live room command failed.');
        return failure('server_error');
      });
  }

  private async publish(
    result: Extract<LiveResult, { ok: true }>,
    transport: LiveTransport,
  ): Promise<void> {
    const roomId = result.state.roomId;
    const pending = this.unpublished.get(roomId);
    // A changed command supersedes an older unpublished revision. An unchanged retry delivers it.
    const delivery = result.changed ? result : pending;
    if (!delivery) return;
    try {
      transport.publish(await this.roomSnapshot(delivery));
      const stored = this.unpublished.get(roomId);
      if (stored && stored.revision <= delivery.revision) this.unpublished.delete(roomId);
    } catch (error) {
      const stored = this.unpublished.get(roomId);
      if (!stored || stored.revision <= delivery.revision) this.unpublished.set(roomId, delivery);
      throw error;
    }
  }

  private async roomSnapshot(result: Extract<LiveResult, { ok: true }>): Promise<RoomSnapshot> {
    const { state, revision } = result;
    return {
      roomId: state.roomId,
      mode: state.mode,
      status: state.status,
      revision,
      participants: state.participants,
      stageParticipantIds: state.stageParticipantIds,
      handParticipantIds: state.hands.map((hand) => hand.participantId),
      broadcast: await this.broadcastProjection(state),
    };
  }

  private async broadcastProjection(
    state: Extract<LiveResult, { ok: true }>['state'],
  ): Promise<RoomSnapshot['broadcast']> {
    if (!this.broadcasts || state.mode !== 'WEBINAR') return null;
    if (this.broadcastView.has(state.roomId)) return this.broadcastView.get(state.roomId) ?? null;
    const view = await this.broadcasts.service.snapshot(
      state.roomId,
      await this.broadcasts.repository.readBroadcast(roomPrefix(state.roomId, this.namespace)),
    );
    this.broadcastView.set(state.roomId, view);
    return view;
  }

  join(
    client: LiveSession,
    request: JoinRoomRequest,
    transport: LiveTransport,
    participantId: string,
    resumeDigest?: string,
  ): Promise<CommandAck> {
    return this.execute(client, async (): Promise<CommandAck> => {
      if (!client.connected) return failure('not_joined');
      if (client.room && client.room.roomId !== request.roomId) return failure('already_joined');
      return this.operations.run(`room:${request.roomId}`, async (): Promise<CommandAck> => {
        if (this.ending.has(request.roomId)) return failure('room_ended');
        // Publication failure leaves membership in place. The same join delivers that revision
        // from this queue and does not apply join again.
        if (client.room) {
          const pending = this.unpublished.get(request.roomId);
          if (!pending) return failure('already_joined');
          await this.publish({ ...pending, changed: false }, transport);
          return { ok: true };
        }
        const room = await this.rooms.getById(request.roomId);
        if (!room) return failure('room_not_found');
        if (room.status === 'ENDED') return failure('room_ended');
        const liveRoom: LiveRoom = {
          roomId: room.id,
          hostId: room.hostId,
          mode: room.mode,
          status: room.status,
        };
        const user = client.user;
        const now = this.clock.now();
        if (this.suspendedRooms.has(room.id)) {
          await this.expireInRoom(liveRoom, transport, now);
          if (this.ending.has(room.id) || (await this.rooms.getById(room.id))?.status === 'ENDED')
            return failure('room_ended');
        }
        const result = await this.live.apply(roomPrefix(room.id, this.namespace), liveRoom, {
          type: 'join',
          participantId,
          socketId: client.id,
          userId: user.id,
          displayName: user.displayName,
          isAudioMuted: request.isAudioMuted,
          isVideoOff: request.isVideoOff,
          isSyntheticBot: request.isSyntheticBot,
          joinedAt: now,
          now,
          ...(resumeDigest ? { resumeDigest } : {}),
        });
        if (!result.ok) return this.failedResult(result, liveRoom, transport);
        client.room = liveRoom;
        client.participantId = participantId;
        client.generation = 1;
        client.isSyntheticBot = request.isSyntheticBot;
        await transport.join(client.id, room.id);
        await this.publish(result, transport);
        return { ok: true };
      });
    });
  }

  resume(
    client: LiveSession,
    request: ResumeRoomRequest,
    transport: LiveTransport,
  ): Promise<ResumeResult> {
    return this.execute(client, async (): Promise<ResumeResult> => {
      if (client.room)
        return failure(
          client.room.roomId === request.roomId && client.participantId === request.participantId
            ? 'already_connected'
            : 'already_joined',
        );
      // Observe before entering the room queue so concurrent attempts carry the same generation.
      const observed = await this.live.readParticipant(
        roomPrefix(request.roomId, this.namespace),
        request.participantId,
      );
      return this.operations.run(`room:${request.roomId}`, async (): Promise<ResumeResult> => {
        if (this.ending.has(request.roomId)) return failure('room_ended');
        const room = await this.rooms.getById(request.roomId);
        if (!room) return failure('room_not_found');
        if (room.status === 'ENDED') return failure('room_ended');
        const liveRoom: LiveRoom = {
          roomId: room.id,
          hostId: room.hostId,
          mode: room.mode,
          status: room.status,
        };
        if (this.suspendedRooms.has(room.id)) {
          await this.expireInRoom(liveRoom, transport, this.clock.now());
          if ((await this.rooms.getById(room.id))?.status === 'ENDED') return failure('room_ended');
          if (
            observed?.presence === 'suspended' &&
            !(await this.live.readParticipant(
              roomPrefix(room.id, this.namespace),
              request.participantId,
            ))
          )
            return failure('resume_expired');
        }
        const result = await this.live.apply(roomPrefix(room.id, this.namespace), liveRoom, {
          type: 'resume',
          participantId: request.participantId,
          userId: client.user.id,
          socketId: client.id,
          resumeDigest: createHash('sha256').update(request.resumeCredential).digest('hex'),
          expectedGeneration: observed?.connectionGeneration ?? 0,
          now: this.clock.now(),
        });
        if (!result.ok) return this.failedResult(result, liveRoom, transport);
        const participant = result.state.participants.find(
          (p) => p.participantId === request.participantId,
        )!;
        client.room = liveRoom;
        client.participantId = participant.participantId;
        client.generation = participant.connectionGeneration;
        client.isSyntheticBot = false;
        this.trackSuspended(result, liveRoom, transport);
        await transport.join(client.id, room.id);
        const snapshot = await this.roomSnapshot(result);
        await this.publish(result, transport);
        return {
          ok: true,
          participantId: participant.participantId,
          connectionGeneration: participant.connectionGeneration,
          snapshot,
        };
      });
    });
  }

  disconnect(client: LiveSession, transport: LiveTransport): Promise<CommandAck> {
    if (!client.room) return Promise.resolve({ ok: true });
    if (client.isSyntheticBot) return this.leave(client, transport);
    const pending = this.pendingDisconnects.get(client.id) ?? {
      client,
      transport,
      now: this.clock.now(),
    };
    this.pendingDisconnects.set(client.id, pending);
    this.scheduleSweep();
    return this.execute(
      client,
      async () => {
        const room = client.room;
        if (!room) {
          this.pendingDisconnects.delete(client.id);
          return { ok: true };
        }
        return this.operations.run(
          `room:${room.roomId}`,
          async () => {
            if (client.room !== room) {
              this.pendingDisconnects.delete(client.id);
              return { ok: true };
            }
            if (this.ending.has(room.roomId)) {
              await this.finishShutdown(room, transport);
              this.clearBinding(client);
              this.pendingDisconnects.delete(client.id);
              return { ok: true };
            }
            const current = client.participantId
              ? await this.live.readParticipant(
                  roomPrefix(room.roomId, this.namespace),
                  client.participantId,
                )
              : null;
            // A lost Redis reply can hide a committed suspension. Adopt that generation without
            // extending its deadline; an old generation must never adopt a later suspension.
            const committed =
              current?.presence === 'suspended' &&
              current.connectionGeneration === client.generation;
            const invalid = committed ? null : await this.validateBinding(client, room);
            if (invalid) {
              this.pendingDisconnects.delete(client.id);
              return failure(invalid);
            }
            if (client.user.id === room.hostId) {
              await this.broadcasts?.service.failInterrupted(room.roomId);
              this.broadcastView.delete(room.roomId);
            }
            const result = await this.live.apply(roomPrefix(room.roomId, this.namespace), room, {
              type: 'suspend',
              participantId: client.participantId!,
              now: pending.now,
              ...(committed ? {} : { transport: this.binding(client) }),
            });
            if (!result.ok) return failure(result.error);
            this.trackSuspended(result, room, transport);
            this.clearBinding(client);
            this.pendingDisconnects.delete(client.id);
            await this.publish({ ...result, changed: result.changed || committed }, transport);
            await transport.leave(client.id, room.roomId);
            return { ok: true };
          },
          true,
        );
      },
      true,
    );
  }

  update(
    client: LiveSession,
    command: StageCommand,
    transport: LiveTransport,
  ): Promise<CommandAck> {
    return this.execute(client, async () => {
      const room = client.room;
      if (!room) return failure('not_joined');
      return this.operations.run(`room:${room.roomId}`, async () => {
        // Shutdown clears every association before releasing this queue. Until then, block the room.
        if (client.room !== room || this.ending.has(room.roomId)) return failure('room_ended');
        const invalid = await this.validateBinding(client, room);
        if (invalid) return failure(invalid);
        const result = await this.live.apply(roomPrefix(room.roomId, this.namespace), room, {
          ...command,
          transport: this.binding(client),
        });
        if (!result.ok) return failure(result.error);
        if (command.type === 'setHostLock' && result.changed) {
          const socketId = await this.live.readSocket(
            roomPrefix(room.roomId, this.namespace),
            command.targetParticipantId,
          );
          if (socketId)
            transport.forceMute(socketId, { kind: command.kind, locked: command.locked });
        }
        await this.publish(result, transport);
        return { ok: true };
      });
    });
  }

  private async publishBroadcast(room: LiveRoom, transport: LiveTransport): Promise<void> {
    const prefix = roomPrefix(room.roomId, this.namespace);
    if (!(await this.live.readStage(prefix)).length) return;
    const broadcasts = this.broadcasts!;
    // Refresh before the lifecycle revision. A failed read must not commit a stale snapshot.
    this.broadcastView.set(
      room.roomId,
      await broadcasts.service.snapshot(
        room.roomId,
        await broadcasts.repository.readBroadcast(prefix),
      ),
    );
    await this.publish(await broadcasts.repository.refreshSnapshot(prefix, room), transport);
  }

  private broadcastCommand(
    client: LiveSession,
    transport: LiveTransport,
    start: boolean,
  ): Promise<CommandAck> {
    return this.execute(client, async () => {
      const room = client.room;
      if (!room) return failure('not_joined');
      return this.operations.run(`room:${room.roomId}`, async () => {
        if (client.room !== room || this.ending.has(room.roomId)) return failure('room_ended');
        if (room.mode !== 'WEBINAR') return failure('broadcast_not_available');
        const broadcasts = this.broadcasts;
        if (!broadcasts) return failure('broadcast_not_available');
        const prefix = roomPrefix(room.roomId, this.namespace);
        const invalid = await this.validateBinding(client, room);
        if (invalid) return failure(invalid);
        const actor = client.participantId
          ? await broadcasts.repository.readParticipant(prefix, client.participantId)
          : null;
        if (actor?.role !== 'HOST') return failure('not_host');
        if (!start) {
          await broadcasts.service.stopRoom(room.roomId);
          return { ok: true };
        }
        if (await broadcasts.repository.readBroadcast(prefix)) return failure('broadcast_active');
        return broadcasts.service.start(room.roomId, client.user.id, {
          reserve: (id) => broadcasts.repository.tryBeginBroadcast(prefix, id),
          clear: (id) => broadcasts.repository.clearBroadcast(prefix, id),
          publish: () => this.publishBroadcast(room, transport),
          onExit: (action) => {
            void this.operations
              .run(`room:${room.roomId}`, action, true)
              .catch((error: unknown) =>
                this.logger.error(
                  error instanceof Error ? error.message : 'Broadcast exit cleanup failed.',
                ),
              );
          },
        });
      });
    });
  }

  startBroadcast(client: LiveSession, transport: LiveTransport): Promise<CommandAck> {
    return this.broadcastCommand(client, transport, true);
  }

  stopBroadcast(client: LiveSession, transport: LiveTransport): Promise<CommandAck> {
    return this.broadcastCommand(client, transport, false);
  }

  relay(
    client: LiveSession,
    toParticipantId: string,
    transport: LiveTransport,
    send: (socketId: string) => void,
  ): Promise<CommandAck> {
    return this.execute(client, async () => {
      const room = client.room;
      if (!room) return failure('not_joined');
      return this.operations.run(`room:${room.roomId}`, async () => {
        if (client.room !== room || this.ending.has(room.roomId)) return failure('room_ended');
        const prefix = roomPrefix(room.roomId, this.namespace);
        const invalid = await this.validateBinding(client, room);
        if (invalid) return failure(invalid);
        const socketId = await this.live.readSocket(prefix, toParticipantId);
        if (!socketId) return failure('not_connected');
        const stage = await this.live.readConnectedStage(prefix);
        if (!client.participantId || !canRelay(stage, client.participantId, toParticipantId))
          return failure('not_on_stage');
        const target = transport.peer(socketId);
        if (!target?.connected || target.roomId !== room.roomId) return failure('peer_unavailable');
        send(socketId);
        return { ok: true };
      });
    });
  }

  // Intent stays until catalog end, Redis deletion, and notification all succeed. PostgreSQL or Redis
  // failure skips notification and leaves members associated so leave or disconnect can retry.
  // Notification failure after key deletion keeps the in-memory intent, so retry does not need the
  // host participant. Process restart still drops this namespace's room keys and does not mark the catalog ENDED.
  private async finishShutdown(room: LiveRoom, transport: LiveTransport): Promise<void> {
    this.ending.add(room.roomId);
    try {
      await this.broadcasts?.service.stopRoom(room.roomId);
      await this.rooms.end(room.roomId);
      await this.live.deleteRoom(roomPrefix(room.roomId, this.namespace));
      await transport.end(room.roomId);
      this.ending.delete(room.roomId);
      this.broadcastView.delete(room.roomId);
      this.unpublished.delete(room.roomId);
      this.suspendedRooms.delete(room.roomId);
    } catch (error: unknown) {
      const detail = error instanceof Error ? error.message : 'unknown failure';
      throw new Error(`Incomplete shutdown for room ${room.roomId}: ${detail}`, { cause: error });
    }
  }

  leave(client: LiveSession, transport: LiveTransport): Promise<CommandAck> {
    const pending = this.leaving.get(client.id);
    if (pending) {
      if (!pending.followup) {
        pending.followup = pending.task.then((result) =>
          result.ok ? result : this.performLeave(client, transport),
        );
        void pending.followup.then(() => {
          if (this.leaving.get(client.id) === pending) this.leaving.delete(client.id);
        });
      }
      return pending.followup;
    }
    const entry = {
      task: this.performLeave(client, transport),
      followup: undefined as Promise<CommandAck> | undefined,
    };
    this.leaving.set(client.id, entry);
    void entry.task.then(() => {
      if (!entry.followup && this.leaving.get(client.id) === entry) this.leaving.delete(client.id);
    });
    return entry.task;
  }

  private performLeave(client: LiveSession, transport: LiveTransport): Promise<CommandAck> {
    return this.execute(
      client,
      async () => {
        const room = client.room;
        if (!room) return { ok: true };
        return this.operations.run(
          `room:${room.roomId}`,
          async () => {
            if (client.room !== room) return { ok: true };
            if (!this.ending.has(room.roomId)) {
              const invalid = await this.validateBinding(client, room, true);
              if (invalid) return failure(invalid);
              if (client.user.id === room.hostId)
                await this.broadcasts?.service.stopRoom(room.roomId);
              const result = await this.live.apply(roomPrefix(room.roomId, this.namespace), room, {
                type: 'leave',
                participantId: client.participantId!,
                transport: this.binding(client),
              });
              if (!result.ok) return failure(result.error);
              if (!result.roomEnded) {
                await this.publish(result, transport);
                await transport.leave(client.id, room.roomId);
                this.clearBinding(client);
                return { ok: true };
              }
            }
            await this.finishShutdown(room, transport);
            this.clearBinding(client);
            return { ok: true };
          },
          true,
        );
      },
      true,
    );
  }
}
