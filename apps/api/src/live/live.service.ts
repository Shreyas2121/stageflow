import { roomPrefix } from './live.keys';
import { Logger } from '@nestjs/common';
import {
  canRelay,
  type CommandAck,
  type JoinRoomRequest,
  type RoomSnapshot,
  type StageCommand,
} from '@stageflow/shared';
import type { RoomsService } from '../rooms/rooms.service';
import type { LiveRepository, LiveRoom, LiveResult } from './live.repository';
import { SerializedOperations, WorkCapacityError } from './serialized-operations';
import { failure } from './signaling.messages';
export interface LiveSession {
  id: string;
  user: { id: string; displayName: string };
  readonly connected: boolean;
  room: LiveRoom | undefined;
}
// Transport effects run inside the operation queue to preserve snapshot/membership ordering.
export interface LiveTransport {
  join(socketId: string, roomId: string): Promise<void>;
  leave(socketId: string, roomId: string): Promise<void>;
  publish(snapshot: RoomSnapshot): void;
  peer(socketId: string): { connected: boolean; roomId: string | undefined } | undefined;
  end(roomId: string): void | Promise<void>;
}
export class LiveService {
  private readonly logger = new Logger(LiveService.name);
  // Rooms whose host shutdown has not finished catalog end, key deletion, and notification.
  private readonly ending = new Set<string>();
  private readonly leaving = new Map<
    string,
    { task: Promise<CommandAck>; followup?: Promise<CommandAck> }
  >();
  constructor(
    private readonly rooms: Pick<RoomsService, 'getById' | 'end'>,
    private readonly live: Pick<LiveRepository, 'apply' | 'readStage' | 'deleteRoom'>,
    private readonly operations: SerializedOperations,
    private readonly availability: { isReady(): boolean } = { isReady: () => true },
    private readonly namespace = 'sf',
  ) {}
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

  private publish(result: Extract<LiveResult, { ok: true }>, transport: LiveTransport): void {
    if (!result.changed) return;
    const { state, revision } = result;
    const snapshot: RoomSnapshot = {
      roomId: state.roomId,
      mode: state.mode,
      status: state.status,
      revision,
      participants: state.participants,
      stageSocketIds: state.stageSocketIds,
      handSocketIds: state.hands.map((hand) => hand.socketId),
      broadcast: null,
    };
    transport.publish(snapshot);
  }

  join(
    client: LiveSession,
    request: JoinRoomRequest,
    transport: LiveTransport,
  ): Promise<CommandAck> {
    return this.execute(client, async (): Promise<CommandAck> => {
      if (!client.connected) return failure('not_joined');
      if (client.room) return failure('already_joined');
      return this.operations.run(`room:${request.roomId}`, async (): Promise<CommandAck> => {
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
        const user = client.user;
        const result = await this.live.apply(roomPrefix(room.id, this.namespace), liveRoom, {
          type: 'join',
          socketId: client.id,
          userId: user.id,
          displayName: user.displayName,
          isAudioMuted: request.isAudioMuted,
          isVideoOff: request.isVideoOff,
          isSyntheticBot: request.isSyntheticBot,
          joinedAt: Date.now(),
        });
        if (!result.ok) return failure(result.error);
        client.room = liveRoom;
        await transport.join(client.id, room.id);
        this.publish(result, transport);
        return { ok: true };
      });
    });
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
        const result = await this.live.apply(
          roomPrefix(room.roomId, this.namespace),
          room,
          command,
        );
        if (!result.ok) return failure(result.error);
        this.publish(result, transport);
        return { ok: true };
      });
    });
  }

  relay(
    client: LiveSession,
    toSocketId: string,
    transport: LiveTransport,
    send: () => void,
  ): Promise<CommandAck> {
    return this.execute(client, async () => {
      const room = client.room;
      if (!room) return failure('not_joined');
      return this.operations.run(`room:${room.roomId}`, async () => {
        if (client.room !== room || this.ending.has(room.roomId)) return failure('room_ended');
        const stage = await this.live.readStage(roomPrefix(room.roomId, this.namespace));
        if (!canRelay(stage, client.id, toSocketId)) return failure('not_on_stage');
        const target = transport.peer(toSocketId);
        if (!target?.connected || target.roomId !== room.roomId) return failure('peer_unavailable');
        send();
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
      await this.rooms.end(room.roomId);
      await this.live.deleteRoom(roomPrefix(room.roomId, this.namespace));
      await transport.end(room.roomId);
      this.ending.delete(room.roomId);
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
              const result = await this.live.apply(roomPrefix(room.roomId, this.namespace), room, {
                type: 'leave',
                socketId: client.id,
              });
              if (!result.ok) return failure(result.error);
              if (!result.roomEnded) {
                this.publish(result, transport);
                await transport.leave(client.id, room.roomId);
                client.room = undefined;
                return { ok: true };
              }
            }
            await this.finishShutdown(room, transport);
            client.room = undefined;
            return { ok: true };
          },
          true,
        );
      },
      true,
    );
  }
}
