import { Logger, OnModuleDestroy } from '@nestjs/common';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayDisconnect,
  OnGatewayInit,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import { canRelay } from '@stageflow/shared';
import type { DescriptionRequest, IceCandidateRequest } from '@stageflow/shared';
import type {
  ClientToServerEvents,
  CommandAck,
  IceServer,
  JoinAck,
  MediaPatch,
  RoomSnapshot,
  ServerToClientEvents,
  SignalingError,
  StageCommand,
} from '@stageflow/shared';
import { env } from '../config/env';
import { RoomsService } from '../rooms/rooms.service';
import { SessionsService } from '../sessions/sessions.service';
import type { User } from '../users/user.entity';
import { LiveRepository, type LiveRoom, type LiveResult } from './live.repository';

type SocketData = { user: User; room?: LiveRoom };
type GuestSocket = Socket<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;
type RoomServer = Server<
  ClientToServerEvents,
  ServerToClientEvents,
  Record<string, never>,
  SocketData
>;
const messages: Record<SignalingError, string> = {
  room_ended: 'This room has ended.',
  already_joined: 'This guest is already in the room.',
  host_not_present: 'The host has to join this meeting before anyone else.',
  stage_full: 'This meeting already has 4 people on stage.',
  room_not_found: 'No room exists for that slug.',
  not_attendee: 'Only attendees can raise a hand.',
  audio_locked: 'The host has muted your microphone.',
  video_locked: 'The host has turned off your camera.',
  participant_not_found: 'This participant is no longer in the room.',
  not_host: 'Only the host can do that.',
  cannot_demote_host: 'The host must stay on stage.',
  not_speaker: 'This participant is not a speaker.',
  invalid_payload: 'The room command is invalid.',
  not_joined: 'Join the room first.',
  server_error: 'Unable to update the live room. Join again.',
  not_on_stage: 'Only people on stage can exchange media.',
  peer_unavailable: 'That person is no longer on stage.',
};
function failure(error: SignalingError): Extract<CommandAck, { ok: false }> {
  return { ok: false, error, message: messages[error] };
}
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

@WebSocketGateway({ cors: { origin: env.CORS_ORIGIN } })
export class SignalingGateway implements OnGatewayInit, OnGatewayDisconnect, OnModuleDestroy {
  @WebSocketServer() server: RoomServer;
  private readonly logger = new Logger(SignalingGateway.name);
  private readonly queues = new Map<string, Promise<unknown>>();
  private shuttingDown = false;
  private readonly iceServers: IceServer[] = [
    ...(env.STUN_URL ? [{ urls: env.STUN_URL }] : []),
    ...(env.TURN_URL
      ? [{ urls: env.TURN_URL, username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL }]
      : []),
  ];

  constructor(
    private readonly sessions: SessionsService,
    private readonly rooms: RoomsService,
    private readonly live: LiveRepository,
  ) {}

  afterInit(server: RoomServer): void {
    server.use((socket, next) => {
      void this.sessions
        .verifyToken(socket.handshake.auth?.token)
        .then((user) => {
          socket.data.user = user;
          next();
        })
        .catch(() => next(new Error('Sign in as a guest before calling this route.')));
    });
  }

  // Serialize socket lifecycle and room operations, including PostgreSQL ending and Redis deletion.
  private queue<T>(key: string, action: () => Promise<T>): Promise<T> {
    const task = (this.queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(action);
    this.queues.set(key, task);
    void task
      .finally(() => {
        if (this.queues.get(key) === task) this.queues.delete(key);
      })
      .catch(() => undefined);
    return task;
  }

  private execute<T extends CommandAck>(
    client: GuestSocket,
    action: () => Promise<T>,
  ): Promise<T | Extract<CommandAck, { ok: false }>> {
    return this.queue(`socket:${client.id}`, action).catch((error: unknown) => {
      this.logger.error(error instanceof Error ? error.message : 'Live room command failed.');
      return failure('server_error');
    });
  }

  private publish(result: Extract<LiveResult, { ok: true }>): void {
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
    this.server.to(state.roomId).emit('room:state', snapshot);
  }

  @SubscribeMessage('room:join')
  join(@ConnectedSocket() client: GuestSocket, @MessageBody() payload: unknown): Promise<JoinAck> {
    return this.execute(client, async (): Promise<JoinAck> => {
      if (!client.connected) return failure('not_joined');
      if (
        !record(payload) ||
        typeof payload.roomId !== 'string' ||
        !['isAudioMuted', 'isVideoOff', 'isSyntheticBot'].every(
          (key) => typeof payload[key] === 'boolean',
        )
      ) {
        return failure('invalid_payload');
      }
      if (client.data.room) return failure('already_joined');
      return this.queue(`room:${payload.roomId}`, async (): Promise<JoinAck> => {
        const room = await this.rooms.getById(payload.roomId as string);
        if (!room) return failure('room_not_found');
        if (room.status === 'ENDED') return failure('room_ended');
        const liveRoom: LiveRoom = {
          roomId: room.id,
          hostId: room.hostId,
          mode: room.mode,
          status: room.status,
        };
        const user = client.data.user;
        const result = await this.live.apply(`sf:room:${room.id}`, liveRoom, {
          type: 'join',
          socketId: client.id,
          userId: user.id,
          displayName: user.displayName,
          isAudioMuted: payload.isAudioMuted as boolean,
          isVideoOff: payload.isVideoOff as boolean,
          isSyntheticBot: payload.isSyntheticBot as boolean,
          joinedAt: Date.now(),
        });
        if (!result.ok) return failure(result.error);
        client.data.room = liveRoom;
        await client.join(room.id);
        this.publish(result);
        return { ok: true, selfSocketId: client.id, iceServers: this.iceServers };
      });
    });
  }

  private update(client: GuestSocket, command: StageCommand): Promise<CommandAck> {
    return this.execute(client, async () => {
      const room = client.data.room;
      if (!room) return failure('not_joined');
      return this.queue(`room:${room.roomId}`, async () => {
        // Host leave clears room association on every socket before releasing this queue.
        if (client.data.room !== room) return failure('room_ended');
        const result = await this.live.apply(`sf:room:${room.roomId}`, room, command);
        if (!result.ok) return failure(result.error);
        this.publish(result);
        return { ok: true };
      });
    });
  }

  private relay(
    client: GuestSocket,
    toSocketId: string,
    send: (target: GuestSocket) => void,
  ): Promise<CommandAck> {
    return this.execute(client, async () => {
      const room = client.data.room;
      if (!room) return failure('not_joined');
      return this.queue(`room:${room.roomId}`, async () => {
        if (client.data.room !== room) return failure('room_ended');
        const stage = await this.live.readStage(`sf:room:${room.roomId}`);
        if (!canRelay(stage, client.id, toSocketId)) return failure('not_on_stage');
        const target = this.server.sockets.sockets.get(toSocketId);
        if (!target?.connected || target.data.room?.roomId !== room.roomId)
          return failure('peer_unavailable');
        send(target);
        return { ok: true };
      });
    });
  }

  @SubscribeMessage('webrtc:description')
  description(
    @ConnectedSocket() client: GuestSocket,
    @MessageBody() payload: unknown,
  ): Promise<CommandAck> | CommandAck {
    if (
      !record(payload) ||
      typeof payload.toSocketId !== 'string' ||
      !payload.toSocketId ||
      !record(payload.description) ||
      !['offer', 'answer'].includes(payload.description.type as string) ||
      typeof payload.description.sdp !== 'string'
    )
      return failure('invalid_payload');
    const { toSocketId, description } = payload as DescriptionRequest;
    return this.relay(client, toSocketId, (target) => {
      target.emit('webrtc:description', {
        toSocketId,
        fromSocketId: client.id,
        description: { type: description.type, sdp: description.sdp },
      });
    });
  }

  @SubscribeMessage('webrtc:ice-candidate')
  iceCandidate(
    @ConnectedSocket() client: GuestSocket,
    @MessageBody() payload: unknown,
  ): Promise<CommandAck> | CommandAck {
    if (!record(payload) || typeof payload.toSocketId !== 'string' || !payload.toSocketId)
      return failure('invalid_payload');
    const candidate = payload.candidate;
    if (
      candidate !== null &&
      (!record(candidate) ||
        typeof candidate.candidate !== 'string' ||
        (candidate.sdpMid !== null && typeof candidate.sdpMid !== 'string') ||
        (candidate.sdpMLineIndex !== null &&
          (typeof candidate.sdpMLineIndex !== 'number' ||
            !Number.isInteger(candidate.sdpMLineIndex) ||
            candidate.sdpMLineIndex < 0)))
    )
      return failure('invalid_payload');
    const request = payload as IceCandidateRequest;
    return this.relay(client, request.toSocketId, (target) => {
      target.emit('webrtc:ice-candidate', {
        toSocketId: request.toSocketId,
        fromSocketId: client.id,
        candidate:
          request.candidate === null
            ? null
            : {
                candidate: request.candidate.candidate,
                sdpMid: request.candidate.sdpMid,
                sdpMLineIndex: request.candidate.sdpMLineIndex,
              },
      });
    });
  }

  @SubscribeMessage('media:state')
  media(
    @ConnectedSocket() client: GuestSocket,
    @MessageBody() payload: unknown,
  ): Promise<CommandAck> | CommandAck {
    if (
      !record(payload) ||
      Object.keys(payload).some(
        (key) =>
          !['isAudioMuted', 'isVideoOff', 'isScreenSharing'].includes(key) ||
          typeof payload[key] !== 'boolean',
      )
    ) {
      return failure('invalid_payload');
    }
    return this.update(client, {
      type: 'patchMedia',
      socketId: client.id,
      patch: payload as MediaPatch,
    });
  }

  @SubscribeMessage('stage:raise-hand')
  hand(
    @ConnectedSocket() client: GuestSocket,
    @MessageBody() payload: unknown,
  ): Promise<CommandAck> | CommandAck {
    if (!record(payload) || typeof payload.raised !== 'boolean') return failure('invalid_payload');
    return this.update(client, {
      type: 'setHand',
      socketId: client.id,
      raised: payload.raised,
      raisedAt: Date.now(),
    });
  }

  @SubscribeMessage('room:leave')
  leave(@ConnectedSocket() client: GuestSocket): Promise<CommandAck> {
    return this.execute(client, async () => {
      const room = client.data.room;
      if (!room) return { ok: true };
      return this.queue(`room:${room.roomId}`, async () => {
        if (client.data.room !== room) return { ok: true };
        const prefix = `sf:room:${room.roomId}`;
        const result = await this.live.apply(prefix, room, { type: 'leave', socketId: client.id });
        if (!result.ok) return failure(result.error);
        if (result.roomEnded) {
          await this.rooms.end(room.roomId);
          await this.live.deleteRoom(prefix);
          this.server.to(room.roomId).emit('room:ended', { roomId: room.roomId });
          for (const socket of this.server.sockets.sockets.values()) {
            if (socket.data.room?.roomId === room.roomId) delete socket.data.room;
          }
          this.server.in(room.roomId).socketsLeave(room.roomId);
        } else {
          this.publish(result);
          await client.leave(room.roomId);
        }
        delete client.data.room;
        return { ok: true };
      });
    });
  }

  handleDisconnect(client: GuestSocket): void {
    if (!this.shuttingDown) void this.leave(client);
  }

  onModuleDestroy(): void {
    this.shuttingDown = true;
  }
}
