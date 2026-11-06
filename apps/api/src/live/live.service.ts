import { roomPrefix } from './live.keys';
import { Logger } from '@nestjs/common';
import { createHash, createHmac, randomBytes } from 'node:crypto';
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
import type { ChatRepository } from '../chat/chat.repository';
import type { QaRepository } from '../qa/qa.repository';
export type BroadcastControl = {
  service: Pick<BroadcastsService, 'snapshot' | 'start' | 'stopRoom' | 'failInterrupted'>;
  repository: Pick<
    LiveRepository,
    'readBroadcast' | 'readParticipant' | 'refreshSnapshot' | 'tryBeginBroadcast' | 'clearBroadcast'
  >;
};
export interface LiveSession {
  id: string;
  user: { id: string; displayName: string; isGuest?: boolean };
  readonly connected: boolean;
  room: LiveRoom | undefined;
  participantId?: string;
  generation?: number;
  isSyntheticBot?: boolean;
  resumeEnabled?: boolean;
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
// One in-flight join or resume on a socket. Disconnect marks it before client.room exists.
type BindingAttempt = { abandoned: boolean };
// Transport effects run inside the operation queue to preserve snapshot/membership ordering.
export interface LiveTransport {
  join(socketId: string, roomId: string): Promise<void>;
  leave(socketId: string, roomId: string): Promise<void>;
  publish(snapshot: RoomSnapshot): void;
  resumeCredential?(
    socketId: string,
    payload: { roomId: string; participantId: string; resumeCredential: string },
  ): void;
  forceMute(socketId: string, payload: StageForceMute): void;
  peer(socketId: string): { connected: boolean; roomId: string | undefined } | undefined;
  end(roomId: string): void | Promise<void>;
}
export class LiveService {
  private readonly logger = new Logger(LiveService.name);
  private readonly credentialSecret = randomBytes(32);
  private readonly roomViews = new Map<string, LiveRoom>();
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
  private readonly bindingAttempts = new Map<string, BindingAttempt>();
  // When the transport died during binding. Grace uses this instant, not the later suspend.
  private readonly disconnectedAt = new Map<string, number>();
  private cancelSweep?: () => void;
  private disposed = false;
  constructor(
    private readonly rooms: Pick<
      RoomsService,
      'getById' | 'end' | 'startScheduled' | 'cancelScheduled'
    >,
    private readonly live: Pick<
      LiveRepository,
      'apply' | 'readStage' | 'readConnectedStage' | 'readSocket' | 'readParticipant' | 'deleteRoom'
    > &
      Partial<Pick<LiveRepository, 'grantResume'>>,
    private readonly operations: SerializedOperations,
    private readonly availability: { isReady(): boolean } = { isReady: () => true },
    private readonly namespace = 'sf',
    private readonly broadcasts?: BroadcastControl,
    private readonly clock: LiveClock = systemClock,
    private readonly chat?: Pick<ChatRepository, 'delete'>,
    private readonly qa?: Pick<QaRepository, 'delete'>,
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
    client.resumeEnabled = undefined;
  }

  private openBinding(client: LiveSession): BindingAttempt {
    const attempt: BindingAttempt = { abandoned: false };
    this.bindingAttempts.set(client.id, attempt);
    return attempt;
  }

  private closeBinding(client: LiveSession, attempt: BindingAttempt): void {
    if (this.bindingAttempts.get(client.id) === attempt) this.bindingAttempts.delete(client.id);
  }

  // Record the loss even when membership is not associated yet. A later commit must compensate.
  private noteBindingLoss(client: LiveSession): void {
    const attempt = this.bindingAttempts.get(client.id);
    if (!attempt) return;
    attempt.abandoned = true;
    if (!this.disconnectedAt.has(client.id)) this.disconnectedAt.set(client.id, this.clock.now());
  }

  private bindingLost(client: LiveSession, attempt: BindingAttempt): boolean {
    return attempt.abandoned || !client.connected;
  }

  private settleDisconnect(client: LiveSession): void {
    this.pendingDisconnects.delete(client.id);
    this.disconnectedAt.delete(client.id);
  }

  private attachMembership(
    client: LiveSession,
    room: LiveRoom,
    participantId: string,
    generation: number,
    isSyntheticBot: boolean,
  ): void {
    const sharedRoom = this.roomViews.get(room.roomId) ?? room;
    Object.assign(sharedRoom, room);
    this.roomViews.set(room.roomId, sharedRoom);
    client.room = sharedRoom;
    client.participantId = participantId;
    client.generation = generation;
    client.isSyntheticBot = isSyntheticBot;
  }

  // Null means the transport is still bound and the caller may publish. Otherwise compensate later,
  // after this socket operation releases the queue, so suspend cannot deadlock behind itself.
  private abandonIfLost(
    client: LiveSession,
    attempt: BindingAttempt,
    abandonedCommit: { current: boolean },
  ): Extract<CommandAck, { ok: false }> | null {
    if (!this.bindingLost(client, attempt)) return null;
    abandonedCommit.current = true;
    return failure('not_joined');
  }

  private async adoptIfCommitted(
    client: LiveSession,
    room: LiveRoom,
    participantId: string,
    generation: number,
    isSyntheticBot: boolean,
  ): Promise<boolean> {
    try {
      const current = await this.live.readParticipant(
        roomPrefix(room.roomId, this.namespace),
        participantId,
      );
      if (current?.presence !== 'connected' || current.socketId !== client.id) return false;
      this.attachMembership(
        client,
        room,
        participantId,
        current.connectionGeneration,
        isSyntheticBot,
      );
      return true;
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : 'Live binding read failed.');
      this.attachMembership(client, room, participantId, generation, isSyntheticBot);
      return true;
    }
  }

  private finishBinding<T extends CommandAck>(
    client: LiveSession,
    transport: LiveTransport,
    result: Promise<T>,
    abandonedCommit: { current: boolean },
  ): Promise<T> {
    return result.then(async (ack) => {
      if (abandonedCommit.current) await this.disconnect(client, transport);
      else if (!this.pendingDisconnects.has(client.id)) this.disconnectedAt.delete(client.id);
      return ack;
    });
  }

  // Chat shares membership authority without entering either stage operation queue.
  async authorizeChat(client: LiveSession, room: LiveRoom): Promise<CommandAck> {
    if (!this.availability.isReady()) return failure('chat_busy');
    if (!client.room) return failure('not_joined');
    if (!client.connected || client.room !== room) return failure('stale_transport');
    if (this.ending.has(room.roomId) || room.status === 'ENDED') return failure('room_ended');
    const invalid = await this.validateBinding(client, room);
    if (invalid) return failure(invalid);
    if (client.room !== room || this.ending.has(room.roomId)) return failure('room_ended');
    return { ok: true };
  }

  // Moderation checks host authority before the submit/vote/state eligibility rules.
  async authorizeQa(client: LiveSession, room: LiveRoom, hostOnly = false): Promise<CommandAck> {
    if (!this.availability.isReady()) return failure('qa_busy');
    if (!client.room) return failure('not_joined');
    if (!client.connected || client.room !== room) return failure('stale_transport');
    if (this.ending.has(room.roomId) || room.status === 'ENDED') return failure('room_ended');
    const participant = client.participantId
      ? await this.live.readParticipant(
          roomPrefix(room.roomId, this.namespace),
          client.participantId,
        )
      : null;
    if (
      !participant ||
      participant.presence !== 'connected' ||
      participant.socketId !== client.id ||
      participant.connectionGeneration !== client.generation
    )
      return failure('stale_transport');
    if (client.room !== room || this.ending.has(room.roomId)) return failure('room_ended');
    if (hostOnly && participant.role !== 'HOST') return failure('not_host');
    if (!['HOST', 'SPEAKER', 'ATTENDEE'].includes(participant.role) || participant.isSyntheticBot)
      return failure('qa_not_allowed');
    return { ok: true };
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
    const view = this.roomViews.get(roomId);
    if (view) view.status = result.state.status;
    if (!result.state.participants.length) this.roomViews.delete(roomId);
    const pending = this.unpublished.get(roomId);
    // A changed command supersedes an older unpublished revision. An unchanged retry delivers it.
    const delivery = result.changed ? result : pending;
    if (!delivery) return;
    try {
      // Pre-start members had no credential. Enable recovery only after Lua releases them.
      if (delivery.state.status === 'LIVE' && transport.resumeCredential && this.live.grantResume) {
        for (const p of delivery.state.participants) {
          if (
            p.role === 'WAITING' ||
            (!delivery.state.stageParticipantIds.includes(p.participantId) &&
              p.role !== 'ATTENDEE') ||
            p.isSyntheticBot ||
            p.presence !== 'connected' ||
            delivery.state.resumeDigests[p.participantId]
          )
            continue;
          const credential = createHmac('sha256', this.credentialSecret)
            .update(JSON.stringify([roomId, p.participantId]))
            .digest('base64url');
          const digest = createHash('sha256').update(credential).digest('hex');
          if (
            await this.live.grantResume(
              roomPrefix(roomId, this.namespace),
              p.participantId,
              p.connectionGeneration,
              digest,
            )
          )
            transport.resumeCredential(p.socketId!, {
              roomId,
              participantId: p.participantId,
              resumeCredential: credential,
            });
        }
      }
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
      waitingParticipantIds: state.waitingParticipantIds,
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
    const abandonedCommit = { current: false };
    return this.finishBinding(
      client,
      transport,
      this.execute(client, async (): Promise<CommandAck> => {
        if (!client.connected) return failure('not_joined');
        if (client.room && client.room.roomId !== request.roomId) return failure('already_joined');
        const attempt = this.openBinding(client);
        try {
          return await this.operations.run(
            `room:${request.roomId}`,
            async (): Promise<CommandAck> => {
              if (this.ending.has(request.roomId)) return failure('room_ended');
              // Publication failure leaves membership in place. The same join delivers that revision
              // from this queue and does not apply join again.
              if (client.room) {
                const abandoned = this.abandonIfLost(client, attempt, abandonedCommit);
                if (abandoned) return abandoned;
                const pending = this.unpublished.get(request.roomId);
                if (!pending) return failure('already_joined');
                await this.publish({ ...pending, changed: false }, transport);
                return this.abandonIfLost(client, attempt, abandonedCommit) ?? { ok: true };
              }
              if (this.bindingLost(client, attempt)) return failure('not_joined');
              const room = await this.rooms.getById(request.roomId);
              if (this.bindingLost(client, attempt)) return failure('not_joined');
              if (!room) return failure('room_not_found');
              if (room.status === 'ENDED') return failure('room_ended');
              const liveRoom: LiveRoom = {
                roomId: room.id,
                hostId: room.hostId,
                mode: room.mode,
                status: room.status,
                requireAdmission: room.requireAdmission,
              };
              const user = client.user;
              const now = this.clock.now();
              if (this.suspendedRooms.has(room.id)) {
                await this.expireInRoom(liveRoom, transport, now);
                if (
                  this.ending.has(room.id) ||
                  (await this.rooms.getById(room.id))?.status === 'ENDED'
                )
                  return failure('room_ended');
              }
              if (this.bindingLost(client, attempt)) return failure('not_joined');
              const prefix = roomPrefix(room.id, this.namespace);
              let result: LiveResult;
              try {
                result = await this.live.apply(prefix, liveRoom, {
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
                  ...(resumeDigest && room.status === 'LIVE' ? { resumeDigest } : {}),
                });
              } catch (error) {
                if (
                  this.bindingLost(client, attempt) &&
                  (await this.adoptIfCommitted(
                    client,
                    liveRoom,
                    participantId,
                    1,
                    request.isSyntheticBot,
                  ))
                )
                  abandonedCommit.current = true;
                throw error;
              }
              if (!result.ok) return this.failedResult(result, liveRoom, transport);
              client.resumeEnabled = !!result.state.resumeDigests[participantId];
              liveRoom.status = result.state.status;
              this.attachMembership(client, liveRoom, participantId, 1, request.isSyntheticBot);
              const abandoned = this.abandonIfLost(client, attempt, abandonedCommit);
              if (abandoned) return abandoned;
              await transport.join(client.id, room.id);
              const lost = this.abandonIfLost(client, attempt, abandonedCommit);
              if (lost) return lost;
              await this.publish(result, transport);
              return this.abandonIfLost(client, attempt, abandonedCommit) ?? { ok: true };
            },
          );
        } finally {
          // A throw after Redis committed still has to reach the cleanup queue.
          if (client.room && (attempt.abandoned || !client.connected))
            abandonedCommit.current = true;
          this.closeBinding(client, attempt);
        }
      }),
      abandonedCommit,
    );
  }

  resume(
    client: LiveSession,
    request: ResumeRoomRequest,
    transport: LiveTransport,
  ): Promise<ResumeResult> {
    const abandonedCommit = { current: false };
    return this.finishBinding(
      client,
      transport,
      this.execute(client, async (): Promise<ResumeResult> => {
        if (client.room)
          return failure(
            client.room.roomId === request.roomId && client.participantId === request.participantId
              ? 'already_connected'
              : 'already_joined',
          );
        if (!client.connected) return failure('not_joined');
        const attempt = this.openBinding(client);
        try {
          // Observe before entering the room queue so concurrent attempts carry the same generation.
          const observed = await this.live.readParticipant(
            roomPrefix(request.roomId, this.namespace),
            request.participantId,
          );
          if (this.bindingLost(client, attempt)) return failure('not_joined');
          return await this.operations.run(
            `room:${request.roomId}`,
            async (): Promise<ResumeResult> => {
              if (this.ending.has(request.roomId)) return failure('room_ended');
              if (this.bindingLost(client, attempt)) return failure('not_joined');
              const room = await this.rooms.getById(request.roomId);
              if (this.bindingLost(client, attempt)) return failure('not_joined');
              if (!room) return failure('room_not_found');
              if (room.status === 'ENDED') return failure('room_ended');
              const liveRoom: LiveRoom = {
                roomId: room.id,
                hostId: room.hostId,
                mode: room.mode,
                status: room.status,
                requireAdmission: room.requireAdmission,
              };
              if (this.suspendedRooms.has(room.id)) {
                await this.expireInRoom(liveRoom, transport, this.clock.now());
                if ((await this.rooms.getById(room.id))?.status === 'ENDED')
                  return failure('room_ended');
                if (
                  observed?.presence === 'suspended' &&
                  !(await this.live.readParticipant(
                    roomPrefix(room.id, this.namespace),
                    request.participantId,
                  ))
                )
                  return failure('resume_expired');
              }
              if (this.bindingLost(client, attempt)) return failure('not_joined');
              const prefix = roomPrefix(room.id, this.namespace);
              const generation = (observed?.connectionGeneration ?? 0) + 1;
              let result: LiveResult;
              try {
                result = await this.live.apply(prefix, liveRoom, {
                  type: 'resume',
                  participantId: request.participantId,
                  userId: client.user.id,
                  socketId: client.id,
                  resumeDigest: createHash('sha256').update(request.resumeCredential).digest('hex'),
                  expectedGeneration: observed?.connectionGeneration ?? 0,
                  now: this.clock.now(),
                });
              } catch (error) {
                if (
                  this.bindingLost(client, attempt) &&
                  (await this.adoptIfCommitted(
                    client,
                    liveRoom,
                    request.participantId,
                    generation,
                    false,
                  ))
                )
                  abandonedCommit.current = true;
                throw error;
              }
              if (!result.ok) return this.failedResult(result, liveRoom, transport);
              liveRoom.status = result.state.status;
              const participant = result.state.participants.find(
                (p) => p.participantId === request.participantId,
              )!;
              this.attachMembership(
                client,
                liveRoom,
                participant.participantId,
                participant.connectionGeneration,
                false,
              );
              const abandoned = this.abandonIfLost(client, attempt, abandonedCommit);
              if (abandoned) return abandoned;
              this.trackSuspended(result, liveRoom, transport);
              await transport.join(client.id, room.id);
              const lost = this.abandonIfLost(client, attempt, abandonedCommit);
              if (lost) return lost;
              const snapshot = await this.roomSnapshot(result);
              const unpublished = this.abandonIfLost(client, attempt, abandonedCommit);
              if (unpublished) return unpublished;
              await this.publish(result, transport);
              const afterPublish = this.abandonIfLost(client, attempt, abandonedCommit);
              if (afterPublish) return afterPublish;
              return {
                ok: true,
                participantId: participant.participantId,
                connectionGeneration: participant.connectionGeneration,
                snapshot,
              };
            },
          );
        } finally {
          if (client.room && (attempt.abandoned || !client.connected))
            abandonedCommit.current = true;
          this.closeBinding(client, attempt);
        }
      }),
      abandonedCommit,
    );
  }

  disconnect(client: LiveSession, transport: LiveTransport): Promise<CommandAck> {
    this.noteBindingLoss(client);
    if (!client.room) return Promise.resolve({ ok: true });
    if (client.isSyntheticBot) {
      this.disconnectedAt.delete(client.id);
      return this.leave(client, transport);
    }
    if (!this.disconnectedAt.has(client.id)) this.disconnectedAt.set(client.id, this.clock.now());
    const pending = this.pendingDisconnects.get(client.id) ?? {
      client,
      transport,
      now: this.disconnectedAt.get(client.id) ?? this.clock.now(),
    };
    this.pendingDisconnects.set(client.id, pending);
    return this.execute(
      client,
      async () => {
        const room = client.room;
        if (!room) {
          this.settleDisconnect(client);
          return { ok: true };
        }
        return this.operations.run(
          `room:${room.roomId}`,
          async () => {
            if (client.room !== room) {
              this.settleDisconnect(client);
              return { ok: true };
            }
            if (this.ending.has(room.roomId)) {
              await this.finishShutdown(room, transport);
              this.clearBinding(client);
              this.settleDisconnect(client);
              return { ok: true };
            }
            const current = client.participantId
              ? await this.live.readParticipant(
                  roomPrefix(room.roomId, this.namespace),
                  client.participantId,
                )
              : null;
            // A lost Start reply can leave the local/catalog view behind Redis.
            if (
              room.status === 'SCHEDULED' &&
              (await this.live.readStage(roomPrefix(room.roomId, this.namespace))).length
            )
              room.status = 'LIVE';
            if (room.status === 'SCHEDULED' || current?.role === 'WAITING') {
              const invalid = await this.validateBinding(client, room, true);
              if (invalid) {
                this.settleDisconnect(client);
                return failure(invalid);
              }
              const result = await this.live.apply(roomPrefix(room.roomId, this.namespace), room, {
                type: 'leave',
                participantId: client.participantId!,
                transport: this.binding(client),
              });
              if (!result.ok) return failure(result.error);
              this.clearBinding(client);
              this.settleDisconnect(client);
              // A lost leave reply can hide a committed removal; the retry still publishes it.
              await this.publish({ ...result, changed: result.changed || !current }, transport);
              await transport.leave(client.id, room.roomId);
              return { ok: true };
            }
            // A lost Redis reply can hide a committed suspension. Adopt that generation without
            // extending its deadline; an old generation must never adopt a later suspension.
            const committed =
              current?.presence === 'suspended' &&
              current.connectionGeneration === client.generation;
            const invalid = committed ? null : await this.validateBinding(client, room);
            if (invalid) {
              this.settleDisconnect(client);
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
            this.settleDisconnect(client);
            await this.publish({ ...result, changed: result.changed || committed }, transport);
            await transport.leave(client.id, room.roomId);
            return { ok: true };
          },
          true,
        );
      },
      true,
    ).then((result) => {
      if (!result.ok) this.scheduleSweep();
      return result;
    });
  }

  scheduleCommand(
    client: LiveSession,
    type: 'start' | 'cancel',
    transport: LiveTransport,
  ): Promise<CommandAck> {
    return this.execute(client, async () => {
      const room = client.room;
      if (!room) return failure('not_joined');
      return this.operations.run(`room:${room.roomId}`, async () => {
        if (client.room !== room) return failure('not_joined');
        if (this.ending.has(room.roomId)) {
          await this.finishShutdown(room, transport);
          return { ok: true };
        }
        const invalid = await this.validateBinding(client, room);
        if (invalid) return failure(invalid);
        const actor = await this.live.readParticipant(
          roomPrefix(room.roomId, this.namespace),
          client.participantId!,
        );
        if (actor?.role !== 'HOST') return failure('not_host');
        const stored = await this.rooms.getById(room.roomId);
        if (!stored) return failure('room_not_found');
        const catalogRoom = {
          ...room,
          status: stored.status,
          requireAdmission: stored.requireAdmission,
        };
        if (type === 'cancel') {
          if (
            stored.status !== 'SCHEDULED' ||
            room.status === 'LIVE' ||
            (await this.live.readStage(roomPrefix(room.roomId, this.namespace))).includes(
              client.participantId!,
            )
          )
            return failure('not_scheduled');
          if (!(await this.rooms.cancelScheduled(room.roomId))) return failure('not_scheduled');
          // Catalog end is durable before Redis cleanup. Shutdown retains retry intent.
          this.ending.add(room.roomId);
          await this.live.apply(roomPrefix(room.roomId, this.namespace), catalogRoom, {
            type: 'cancel',
            actorParticipantId: client.participantId!,
            transport: this.binding(client),
          });
          await this.finishShutdown(room, transport);
          return { ok: true };
        }
        const result = await this.live.apply(roomPrefix(room.roomId, this.namespace), catalogRoom, {
          type,
          actorParticipantId: client.participantId!,
          transport: this.binding(client),
        });
        if (!result.ok) return failure(result.error);
        room.status = 'LIVE';
        await this.publish({ ...result, changed: true }, transport);
        await this.rooms.startScheduled(room.roomId);
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
        const invalid = await this.validateBinding(client, room);
        if (invalid) return failure(invalid);
        const removed =
          command.type === 'removeWaiter'
            ? await this.live.readParticipant(
                roomPrefix(room.roomId, this.namespace),
                command.targetParticipantId,
              )
            : null;
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
        if (removed?.socketId) await transport.leave(removed.socketId, room.roomId);
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
        return broadcasts.service.start(
          room.roomId,
          client.user.id,
          {
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
          },
          client.user.isGuest === true,
        );
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
      await this.chat?.delete(roomPrefix(room.roomId, this.namespace));
      await this.qa?.delete(roomPrefix(room.roomId, this.namespace));
      await transport.end(room.roomId);
      this.ending.delete(room.roomId);
      this.roomViews.delete(room.roomId);
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
              if (client.user.id === room.hostId && room.status === 'LIVE')
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
