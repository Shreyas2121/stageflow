import { OnModuleDestroy } from '@nestjs/common';
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
import {
  parseJoinRoomRequest,
  parseDescriptionRequest,
  parseIceCandidateRequest,
  parseMediaPatch,
  parseHandRequest,
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
import type { LiveRoom } from './live.repository';
import { LiveService, type LiveSession, type LiveTransport } from './live.service';
import { failure } from './signaling.messages';

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
@WebSocketGateway({ cors: { origin: env.CORS_ORIGIN } })
export class SignalingGateway implements OnGatewayInit, OnGatewayDisconnect, OnModuleDestroy {
  @WebSocketServer() server: RoomServer;
  private shuttingDown = false;
  private readonly iceServers: IceServer[] = [
    ...(env.STUN_URL ? [{ urls: env.STUN_URL }] : []),
    ...(env.TURN_URL
      ? [{ urls: env.TURN_URL, username: env.TURN_USERNAME, credential: env.TURN_CREDENTIAL }]
      : []),
  ];
  constructor(
    private readonly sessions: SessionsService,
    private readonly live: LiveService,
  ) {}
  private session(client: GuestSocket): LiveSession {
    return {
      id: client.id,
      user: client.data.user,
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
    peer: (socketId) => {
      const peer = this.server.sockets.sockets.get(socketId);
      return peer ? { connected: peer.connected, roomId: peer.data.room?.roomId } : undefined;
    },
    end: async (roomId) => {
      this.server.to(roomId).emit('room:ended', { roomId });
      await this.server.in(roomId).socketsLeave(roomId);
      for (const socket of this.server.sockets.sockets.values())
        if (socket.data.room?.roomId === roomId) delete socket.data.room;
    },
  };
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

  @SubscribeMessage('room:join')
  async join(
    @ConnectedSocket() client: GuestSocket,
    @MessageBody() payload: unknown,
  ): Promise<JoinAck> {
    const request = parseJoinRoomRequest(payload);
    if (!request) return failure('invalid_payload');
    const result = await this.live.join(this.session(client), request, this.transport);
    return result.ok ? { ok: true, selfSocketId: client.id, iceServers: this.iceServers } : result;
  }
  @SubscribeMessage('webrtc:description')
  description(
    @ConnectedSocket() client: GuestSocket,
    @MessageBody() payload: unknown,
  ): Promise<CommandAck> | CommandAck {
    const request = parseDescriptionRequest(payload);
    if (!request) return failure('invalid_payload');
    const { toSocketId, description } = request;
    return this.live.relay(this.session(client), toSocketId, this.transport, () => {
      const target = this.server.sockets.sockets.get(toSocketId)!;
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
    const request = parseIceCandidateRequest(payload);
    if (!request) return failure('invalid_payload');
    return this.live.relay(this.session(client), request.toSocketId, this.transport, () => {
      const target = this.server.sockets.sockets.get(request.toSocketId)!;
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
    const patch = parseMediaPatch(payload);
    if (!patch) return failure('invalid_payload');
    return this.live.update(
      this.session(client),
      {
        type: 'patchMedia',
        socketId: client.id,
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
        socketId: client.id,
        raised: request.raised,
        raisedAt: Date.now(),
      },
      this.transport,
    );
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
