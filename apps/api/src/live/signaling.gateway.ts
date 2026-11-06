import { OnModuleDestroy } from '@nestjs/common';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
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
  parseResumeRoomRequest,
  parseChatSendRequest,
  parseChatHistoryRequest,
  parseChatSetPausedRequest,
  parseQaSubmit,
  parseQaQuestionId,
  parseQaSetSubmissions,
} from '@stageflow/shared';

import type {
  ClientToServerEvents,
  CommandAck,
  IceServer,
  JoinAck,
  ResumeAck,
  ServerToClientEvents,
  ChatSendAck,
  ChatHistoryAck,
  ChatSetPausedAck,
  QaStateAck,
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
import { ChatService, type ChatTransport } from '../chat/chat.service';
import { QaService, type QaTransport } from '../qa/qa.service';
import { SocketAuthorization } from './socket-authorization';

function isEmptyPayload(payload: unknown): boolean {
  return (
    payload === undefined ||
    (typeof payload === 'object' &&
      payload !== null &&
      !Array.isArray(payload) &&
      Object.keys(payload).length === 0)
  );
}

type SocketData = {
  user: User;
  authorization?: SocketAuthorization;
  room?: LiveRoom;
  participantId?: string;
  generation?: number;
  isSyntheticBot?: boolean;
  joinCredential?: string;
  resumeEnabled?: boolean;
};
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
  private unsubscribeSessions?: () => void;
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
    private readonly chat: ChatService,
    private readonly qa: QaService,
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
      get generation() {
        return client.data.generation;
      },
      set generation(value: number | undefined) {
        client.data.generation = value;
      },
      get isSyntheticBot() {
        return client.data.isSyntheticBot;
      },
      set isSyntheticBot(value: boolean | undefined) {
        client.data.isSyntheticBot = value;
      },
      get resumeEnabled() {
        return client.data.resumeEnabled;
      },
      set resumeEnabled(value: boolean | undefined) {
        client.data.resumeEnabled = value;
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
      const socket = this.server.sockets.sockets.get(socketId);
      await socket?.leave(roomId);
      if (socket?.data.room?.roomId === roomId) {
        delete socket.data.room;
        delete socket.data.participantId;
        delete socket.data.generation;
        delete socket.data.isSyntheticBot;
        delete socket.data.resumeEnabled;
      }
    },
    publish: (snapshot) => {
      this.server.to(snapshot.roomId).emit('room:state', snapshot);
    },
    resumeCredential: (socketId, payload) => {
      this.server.sockets.sockets.get(socketId)?.emit('room:resume-credential', payload);
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
          delete socket.data.generation;
          delete socket.data.isSyntheticBot;
          delete socket.data.joinCredential;
        }
      }
    },
  };
  private readonly chatTransport: ChatTransport = {
    message: (roomId, message) => {
      this.server.to(roomId).emit('chat:message', message);
    },
    paused: (roomId, payload) => {
      this.server.to(roomId).emit('chat:paused', payload);
    },
  };
  private readonly qaTransport: QaTransport = {
    state: (roomId, state) => {
      this.server.to(roomId).emit('qa:state', state);
    },
  };
  afterInit(server: RoomServer): void {
    this.unsubscribeSessions = this.sessions.onSessionChange((userId) => {
      for (const socket of server.sockets.sockets.values()) {
        if (socket.data.user.id === userId) socket.data.authorization?.revoke();
      }
    });
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
    client.data.authorization = new SocketAuthorization(
      this.sessions,
      client.handshake.auth.token as string,
      client.data.user,
      this.sessions.tokenDeadline(client.handshake.auth.token as string),
      () => client.disconnect(true),
    );
    client.use((packet, next) => {
      if (packet[0] === 'room:leave') {
        next();
        return;
      }
      const ack: unknown = packet.at(-1);
      if (!this.events.consume(client.data.user.id)) {
        if (typeof ack === 'function') ack(failure('rate_limited'));
        return;
      }
      const proceed = (valid: boolean) => {
        if (valid && client.connected) next();
        else if (typeof ack === 'function') ack(failure('not_connected'));
      };
      const valid = client.data.authorization!.valid();
      if (typeof valid === 'boolean') proceed(valid);
      else void valid.then(proceed);
    });
  }

  @SubscribeMessage('room:join')
  async join(
    @ConnectedSocket() client: GuestSocket,
    @MessageBody() payload: unknown,
  ): Promise<JoinAck> {
    const request = parseJoinRoomRequest(payload);
    if (!request) return failure('invalid_payload');
    if (!request.isSyntheticBot && !client.data.joinCredential && !client.data.room)
      client.data.joinCredential = randomBytes(32).toString('base64url');
    const credential = client.data.joinCredential;
    const result = await this.live.join(
      this.session(client),
      request,
      this.transport,
      randomUUID(),
      credential ? createHash('sha256').update(credential).digest('hex') : undefined,
    );
    if (!result.ok) {
      if (!client.data.room) delete client.data.joinCredential;
      return result;
    }
    delete client.data.joinCredential;
    return {
      ok: true,
      participantId: client.data.participantId!,
      iceServers: this.iceServers,
      ...(credential &&
      client.data.resumeEnabled !== false &&
      client.data.room?.status === 'LIVE' &&
      !(
        client.data.room.mode === 'MEETING' &&
        client.data.room.requireAdmission &&
        client.data.user.id !== client.data.room.hostId
      )
        ? { resumeCredential: credential }
        : {}),
    };
  }

  @SubscribeMessage('room:resume')
  async resume(
    @ConnectedSocket() client: GuestSocket,
    @MessageBody() payload: unknown,
  ): Promise<ResumeAck> {
    const request = parseResumeRoomRequest(payload);
    if (!request) return failure('invalid_payload');
    try {
      const user = await this.sessions.verifyToken(client.handshake.auth?.token);
      if (user.id !== client.data.user.id) return failure('invalid_resume');
    } catch {
      return failure('invalid_resume');
    }
    const result = await this.live.resume(this.session(client), request, this.transport);
    return result.ok ? { ...result, iceServers: this.iceServers } : result;
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

  @SubscribeMessage('room:start')
  startRoom(@ConnectedSocket() client: GuestSocket): Promise<CommandAck> {
    return this.live.scheduleCommand(this.session(client), 'start', this.transport);
  }

  @SubscribeMessage('room:cancel')
  cancelRoom(@ConnectedSocket() client: GuestSocket): Promise<CommandAck> {
    return this.live.scheduleCommand(this.session(client), 'cancel', this.transport);
  }

  @SubscribeMessage('stage:admit')
  admit(
    @ConnectedSocket() client: GuestSocket,
    @MessageBody() payload: unknown,
  ): Promise<CommandAck> | CommandAck {
    const request = parseStageTargetRequest(payload);
    if (!request) return failure('invalid_payload');
    return this.live.update(
      this.session(client),
      { type: 'admit', actorParticipantId: client.data.participantId!, ...request },
      this.transport,
    );
  }

  @SubscribeMessage('stage:remove-waiter')
  removeWaiter(
    @ConnectedSocket() client: GuestSocket,
    @MessageBody() payload: unknown,
  ): Promise<CommandAck> | CommandAck {
    const request = parseStageTargetRequest(payload);
    if (!request) return failure('invalid_payload');
    return this.live.update(
      this.session(client),
      { type: 'removeWaiter', actorParticipantId: client.data.participantId!, ...request },
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

  @SubscribeMessage('chat:send')
  sendChat(
    @ConnectedSocket() client: GuestSocket,
    @MessageBody() payload: unknown,
  ): Promise<ChatSendAck> | ChatSendAck {
    const request = parseChatSendRequest(payload);
    if (!request.ok) return failure(request.error);
    return this.chat.send(this.session(client), request.value, this.chatTransport);
  }

  @SubscribeMessage('chat:history')
  chatHistory(
    @ConnectedSocket() client: GuestSocket,
    @MessageBody() payload: unknown,
  ): Promise<ChatHistoryAck> | ChatHistoryAck {
    const request = parseChatHistoryRequest(payload);
    if (!request.ok) return failure(request.error);
    return this.chat.history(this.session(client), request.value);
  }

  @SubscribeMessage('chat:set-paused')
  setChatPaused(
    @ConnectedSocket() client: GuestSocket,
    @MessageBody() payload: unknown,
  ): Promise<ChatSetPausedAck> | ChatSetPausedAck {
    const request = parseChatSetPausedRequest(payload);
    if (!request.ok) return failure(request.error);
    return this.chat.setPaused(this.session(client), request.value.paused, this.chatTransport);
  }
  @SubscribeMessage('qa:submit')
  submitQuestion(
    @ConnectedSocket() client: GuestSocket,
    @MessageBody() payload: unknown,
  ): Promise<QaStateAck> | QaStateAck {
    const request = parseQaSubmit(payload);
    if (!request.ok) return failure(request.error);
    return this.qa.submit(this.session(client), request.value, this.qaTransport);
  }

  @SubscribeMessage('qa:vote')
  voteQuestion(
    @ConnectedSocket() client: GuestSocket,
    @MessageBody() payload: unknown,
  ): Promise<QaStateAck> | QaStateAck {
    const request = parseQaQuestionId(payload);
    if (!request.ok) return failure(request.error);
    return this.qa.vote(this.session(client), request.value.questionId, this.qaTransport);
  }

  @SubscribeMessage('qa:state')
  questionState(
    @ConnectedSocket() client: GuestSocket,
    @MessageBody() payload: unknown,
  ): Promise<QaStateAck> | QaStateAck {
    if (!isEmptyPayload(payload)) return failure('invalid_payload');
    return this.qa.state(this.session(client));
  }

  @SubscribeMessage('qa:dismiss')
  dismissQuestion(
    @ConnectedSocket() client: GuestSocket,
    @MessageBody() payload: unknown,
  ): Promise<QaStateAck> | QaStateAck {
    const request = parseQaQuestionId(payload);
    if (!request.ok) return failure(request.error);
    return this.qa.dismiss(this.session(client), request.value.questionId, this.qaTransport);
  }

  @SubscribeMessage('qa:feature')
  featureQuestion(
    @ConnectedSocket() client: GuestSocket,
    @MessageBody() payload: unknown,
  ): Promise<QaStateAck> | QaStateAck {
    const request = parseQaQuestionId(payload);
    if (!request.ok) return failure(request.error);
    return this.qa.feature(this.session(client), request.value.questionId, this.qaTransport);
  }

  @SubscribeMessage('qa:clear-feature')
  clearFeaturedQuestion(
    @ConnectedSocket() client: GuestSocket,
    @MessageBody() payload: unknown,
  ): Promise<QaStateAck> | QaStateAck {
    if (!isEmptyPayload(payload)) return failure('invalid_payload');
    return this.qa.clearFeature(this.session(client), this.qaTransport);
  }

  @SubscribeMessage('qa:set-submissions')
  setQuestionSubmissions(
    @ConnectedSocket() client: GuestSocket,
    @MessageBody() payload: unknown,
  ): Promise<QaStateAck> | QaStateAck {
    const request = parseQaSetSubmissions(payload);
    if (!request.ok) return failure(request.error);
    return this.qa.setSubmissions(this.session(client), request.value.open, this.qaTransport);
  }

  handleDisconnect(client: GuestSocket): void {
    client.data?.authorization?.dispose();
    delete client.data?.joinCredential;
    if (!this.shuttingDown) void this.live.disconnect(this.session(client), this.transport);
  }

  onModuleDestroy(): void {
    this.shuttingDown = true;
    this.unsubscribeSessions?.();
    for (const socket of this.server?.sockets.sockets.values() ?? [])
      socket.data.authorization?.dispose();
  }
}
