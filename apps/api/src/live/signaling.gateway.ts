import { OnModuleDestroy } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import {
  ConnectedSocket,
  MessageBody,
  OnGatewayDisconnect,
  OnGatewayInit,
  OnGatewayConnection,
  SubscribeMessage,
  WebSocketGateway,
  WebSocketServer,
} from '@nestjs/websockets';
import { Server, Socket } from 'socket.io';
import {
  parseJoinRoomRequest,
  parseDescriptionRequest,
  parseIceCandidateRequest,
  parseMediaPatch,
  parseHandRequest,
  parseStageTargetRequest,
  parseStageLockRequest,
} from '@stageflow/shared';

import type {
  ClientToServerEvents,
  CommandAck,
  IceServer,
  JoinAck,
  ServerToClientEvents,
} from '@stageflow/shared';
import { env } from '../config/env';
import { SessionsService } from '../sessions/sessions.service';
import type { User } from '../users/user.entity';
import { LiveConnection } from './live.connection';
import type { LiveRoom } from './live.repository';
import { LiveService, type LiveSession, type LiveTransport } from './live.service';
import { failure } from './signaling.messages';
import { socketOptions } from './socket-options';
import { WindowBudget } from '../admission/window-budget';
import { networkIdentity } from '../admission/network-identity';

type SocketData = { user: User; room?: LiveRoom; participantId?: string };
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
@WebSocketGateway(socketOptions)
export class SignalingGateway
  implements OnGatewayInit, OnGatewayConnection, OnGatewayDisconnect, OnModuleDestroy
{
  @WebSocketServer() server: RoomServer;
  private shuttingDown = false;
  private pendingAuth = 0;
  private readonly connections = new WindowBudget(
    env.SOCKET_CONNECT_RATE_LIMIT,
    env.RATE_WINDOW_MS,
    env.RATE_KEYS_MAX,
  );
  private readonly events = new WindowBudget(
    env.SOCKET_EVENT_RATE_LIMIT,
    env.RATE_WINDOW_MS,
    env.RATE_KEYS_MAX,
  );
  private readonly iceServers: IceServer[] = [
    ...(env.STUN_URL ? [{ urls: env.STUN_URL }] : []),
    ...(env.TURN_URL
      ? [{ urls: env.TURN_URL, username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL }]
      : []),
  ];
  constructor(
    private readonly sessions: SessionsService,
    private readonly live: LiveService,
    private readonly connection: LiveConnection,
  ) {}
  private session(client: GuestSocket): LiveSession {
    return {
      id: client.id,
      user: client.data.user,
      get participantId() {
        return client.data.participantId;
      },
      set participantId(participantId: string | undefined) {
        if (participantId) client.data.participantId = participantId;
        else delete client.data.participantId;
      },
      get connected() {
        return client.connected;
      },
      get room() {
        return client.data.room;
      },
      set room(room: LiveRoom | undefined) {
        if (room) client.data.room = room;
        else delete client.data.room;
      },
    };
  }
  private readonly transport: LiveTransport = {
    join: async (socketId, roomId) => {
      await this.server.sockets.sockets.get(socketId)?.join(roomId);
    },
    leave: async (socketId, roomId) => {
      await this.server.sockets.sockets.get(socketId)?.leave(roomId);
    },
    publish: (snapshot) => {
      this.server.to(snapshot.roomId).emit('room:state', snapshot);
    },
    forceMute: (socketId, payload) => {
      this.server.sockets.sockets.get(socketId)?.emit('stage:force-mute', payload);
    },
    peer: (socketId) => {
      const peer = this.server.sockets.sockets.get(socketId);
      return peer ? { connected: peer.connected, roomId: peer.data.room?.roomId } : undefined;
    },
    end: async (roomId) => {
      this.server.to(roomId).emit('room:ended', { roomId });
      await this.server.in(roomId).socketsLeave(roomId);
      for (const socket of this.server.sockets.sockets.values()) {
        if (socket.data.room?.roomId === roomId) {
          delete socket.data.room;
          delete socket.data.participantId;
        }
      }
    },
  };
  afterInit(server: RoomServer): void {
    this.connection.whenLost(() => {
      // Leave cannot finish while Redis is down, and catalog rows stay LIVE until a later restart.
      this.shuttingDown = true;
      server.disconnectSockets(true);
    });
    server.use((socket, next) => {
      if (
        this.pendingAuth >= env.AUTH_PENDING_LIMIT ||
        !this.connections.consume(networkIdentity(socket.request, env.TRUSTED_PROXIES))
      ) {
        next(new Error('Too many connection attempts. Try again shortly.'));
        return;
      }
      this.pendingAuth++;
      void this.sessions
        .verifyToken(socket.handshake.auth?.token)
        .then((user) => {
          socket.data.user = user;
          next();
        })
        .catch(() => next(new Error('Sign in as a guest before calling this route.')))
        .finally(() => {
          this.pendingAuth--;
        });
    });
  }

  handleConnection(client: GuestSocket): void {
    client.use((packet, next) => {
      if (packet[0] === 'room:leave' || this.events.consume(client.data.user.id)) {
        next();
        return;
      }
      const ack: unknown = packet.at(-1);
      if (typeof ack === 'function') ack(failure('rate_limited'));
    });
  }

  @SubscribeMessage('room:join')
  async join(
    @ConnectedSocket() client: GuestSocket,
    @MessageBody() payload: unknown,
  ): Promise<JoinAck> {
    const request = parseJoinRoomRequest(payload);
    if (!request) return failure('invalid_payload');
    const result = await this.live.join(
      this.session(client),
      request,
      this.transport,
      randomUUID(),
    );
    return result.ok
      ? { ok: true, participantId: client.data.participantId!, iceServers: this.iceServers }
      : result;
  }
  @SubscribeMessage('webrtc:description')
  description(
    @ConnectedSocket() client: GuestSocket,
    @MessageBody() payload: unknown,
  ): Promise<CommandAck> | CommandAck {
    const request = parseDescriptionRequest(payload);
    if (!request) return failure('invalid_payload');
    const { toParticipantId, description } = request;
    return this.live.relay(this.session(client), toParticipantId, this.transport, (socketId) => {
      const target = this.server.sockets.sockets.get(socketId)!;
      target.emit('webrtc:description', {
        toParticipantId,
        fromParticipantId: client.data.participantId!,
        description: { type: description.type, sdp: description.sdp },
      });
    });
  }

  @SubscribeMessage('webrtc:ice-candidate')
  iceCandidate(
    @ConnectedSocket() client: GuestSocket,
    @MessageBody() payload: unknown,
  ): Promise<CommandAck> | CommandAck {
    const request = parseIceCandidateRequest(payload);
    if (!request) return failure('invalid_payload');
    return this.live.relay(
      this.session(client),
      request.toParticipantId,
      this.transport,
      (socketId) => {
        const target = this.server.sockets.sockets.get(socketId)!;
        target.emit('webrtc:ice-candidate', {
          toParticipantId: request.toParticipantId,
          fromParticipantId: client.data.participantId!,
          candidate:
            request.candidate === null
              ? null
              : {
                  candidate: request.candidate.candidate,
                  sdpMid: request.candidate.sdpMid,
                  sdpMLineIndex: request.candidate.sdpMLineIndex,
                  ...(request.candidate.usernameFragment
                    ? { usernameFragment: request.candidate.usernameFragment }
                    : {}),
                },
        });
      },
    );
  }

  @SubscribeMessage('media:state')
  media(
    @ConnectedSocket() client: GuestSocket,
    @MessageBody() payload: unknown,
  ): Promise<CommandAck> | CommandAck {
    const patch = parseMediaPatch(payload);
    if (!patch) return failure('invalid_payload');
    return this.live.update(
      this.session(client),
      {
        type: 'patchMedia',
        participantId: client.data.participantId!,
        patch,
      },
      this.transport,
    );
  }

  @SubscribeMessage('stage:raise-hand')
  hand(
    @ConnectedSocket() client: GuestSocket,
    @MessageBody() payload: unknown,
  ): Promise<CommandAck> | CommandAck {
    const request = parseHandRequest(payload);
    if (!request) return failure('invalid_payload');
    return this.live.update(
      this.session(client),
      {
        type: 'setHand',
        participantId: client.data.participantId!,
        raised: request.raised,
        raisedAt: Date.now(),
      },
      this.transport,
    );
  }

  @SubscribeMessage('stage:promote')
  promote(
    @ConnectedSocket() client: GuestSocket,
    @MessageBody() payload: unknown,
  ): Promise<CommandAck> | CommandAck {
    const request = parseStageTargetRequest(payload);
    if (!request) return failure('invalid_payload');
    return this.live.update(
      this.session(client),
      {
        type: 'promote',
        actorParticipantId: client.data.participantId!,
        targetParticipantId: request.targetParticipantId,
      },
      this.transport,
    );
  }

  @SubscribeMessage('stage:demote')
  demote(
    @ConnectedSocket() client: GuestSocket,
    @MessageBody() payload: unknown,
  ): Promise<CommandAck> | CommandAck {
    const request = parseStageTargetRequest(payload);
    if (!request) return failure('invalid_payload');
    return this.live.update(
      this.session(client),
      {
        type: 'demote',
        actorParticipantId: client.data.participantId!,
        targetParticipantId: request.targetParticipantId,
      },
      this.transport,
    );
  }

  @SubscribeMessage('stage:set-lock')
  setLock(
    @ConnectedSocket() client: GuestSocket,
    @MessageBody() payload: unknown,
  ): Promise<CommandAck> | CommandAck {
    const request = parseStageLockRequest(payload);
    if (!request) return failure('invalid_payload');
    return this.live.update(
      this.session(client),
      {
        type: 'setHostLock',
        actorParticipantId: client.data.participantId!,
        ...request,
      },
      this.transport,
    );
  }

  @SubscribeMessage('broadcast:start')
  startBroadcast(@ConnectedSocket() client: GuestSocket): Promise<CommandAck> {
    return this.live.startBroadcast(this.session(client), this.transport);
  }

  @SubscribeMessage('broadcast:stop')
  stopBroadcast(@ConnectedSocket() client: GuestSocket): Promise<CommandAck> {
    return this.live.stopBroadcast(this.session(client), this.transport);
  }

  @SubscribeMessage('room:leave')
  leave(@ConnectedSocket() client: GuestSocket): Promise<CommandAck> {
    return this.live.leave(this.session(client), this.transport);
  }
  handleDisconnect(client: GuestSocket): void {
    if (!this.shuttingDown) void this.leave(client);
  }

  onModuleDestroy(): void {
    this.shuttingDown = true;
  }
}
