import { Logger } from '@nestjs/common';
import {
  CHAT_DEDUP_MAX_ENTRIES,
  CHAT_IDLE_TTL_SECONDS,
  CHAT_MAX_QUEUED_OPERATIONS,
  CHAT_MESSAGE_RETENTION,
  CHAT_PARTICIPANT_RATE_LIMIT,
  CHAT_RATE_WINDOW_MS,
  CHAT_ROOM_RATE_LIMIT,
  CHAT_USER_RATE_MAX_FIELDS,
  type ChatHistoryAck,
  type ChatHistoryRequest,
  type ChatMessage,
  type ChatSendAck,
  type ChatSendRequest,
  type ChatSetPausedAck,
  type CommandAck,
  type TransportBinding,
} from '@stageflow/shared';
import type { ChatRepository, ChatAcceptLimits } from './chat.repository';
import type { LiveService, LiveSession } from '../live/live.service';
import { roomPrefix } from '../live/live.keys';
import { SerializedOperations, WorkCapacityError } from '../live/serialized-operations';
import { failure } from '../live/signaling.messages';

export interface ChatTransport {
  message(roomId: string, message: ChatMessage): void;
  paused(roomId: string, payload: { paused: boolean }): void;
}

const limits: ChatAcceptLimits = {
  retention: CHAT_MESSAGE_RETENTION,
  dedupCapacity: CHAT_DEDUP_MAX_ENTRIES,
  ttlSeconds: CHAT_IDLE_TTL_SECONDS,
  participantRateLimit: CHAT_PARTICIPANT_RATE_LIMIT,
  roomRateLimit: CHAT_ROOM_RATE_LIMIT,
  rateWindowMs: CHAT_RATE_WINDOW_MS,
  userRateMaxFields: CHAT_USER_RATE_MAX_FIELDS,
};

export class ChatService {
  private readonly logger = new Logger(ChatService.name);
  // SerializedOperations counts the running job too: one running plus 32 waiting.
  private readonly operations = new SerializedOperations({
    maxPending: 512,
    maxPerKey: CHAT_MAX_QUEUED_OPERATIONS + 1,
    cleanupReserve: 0,
  });

  constructor(
    private readonly repository: Pick<ChatRepository, 'accept' | 'history' | 'setPaused'>,
    private readonly live: Pick<LiveService, 'authorizeChat'>,
    private readonly namespace = 'sf',
    private readonly now = () => Date.now(),
  ) {}

  onModuleDestroy(): Promise<void> {
    return this.operations.onModuleDestroy();
  }

  private execute<T extends { ok: true }>(
    client: LiveSession,
    action: (
      prefix: string,
      binding: TransportBinding,
      roomId: string,
    ) => Promise<T | Extract<CommandAck, { ok: false }>>,
  ): Promise<T | Extract<CommandAck, { ok: false }>> {
    const room = client.room;
    if (!room) return Promise.resolve(failure('not_joined'));
    const binding: TransportBinding = {
      participantId: client.participantId ?? '',
      socketId: client.id,
      generation: client.generation ?? 0,
    };
    return this.operations
      .run(`room:${room.roomId}:chat`, async () => {
        if (
          client.room !== room ||
          client.participantId !== binding.participantId ||
          client.generation !== binding.generation
        )
          return failure('stale_transport');
        const authorized = await this.live.authorizeChat(client, room);
        if (!authorized.ok) return authorized;
        return action(roomPrefix(room.roomId, this.namespace), binding, room.roomId);
      })
      .catch((error: unknown) => {
        if (!(error instanceof WorkCapacityError))
          this.logger.error(error instanceof Error ? error.message : 'Chat command failed.');
        return failure('chat_busy');
      });
  }

  send(
    client: LiveSession,
    request: ChatSendRequest,
    transport: ChatTransport,
  ): Promise<ChatSendAck> {
    return this.execute(client, async (prefix, binding, roomId) => {
      const result = await this.repository.accept(prefix, binding, request, limits, this.now());
      if (!result.ok) return failure(result.error);
      transport.message(roomId, result.value);
      return { ok: true, message: result.value };
    });
  }

  history(
    client: LiveSession,
    request: ChatHistoryRequest & { limit: number },
  ): Promise<ChatHistoryAck> {
    return this.execute(client, async (prefix, binding) => {
      const result = await this.repository.history(prefix, binding, request);
      return result.ok ? { ok: true, ...result.value } : failure(result.error);
    });
  }

  setPaused(
    client: LiveSession,
    paused: boolean,
    transport: ChatTransport,
  ): Promise<ChatSetPausedAck> {
    return this.execute(client, async (prefix, binding, roomId) => {
      const result = await this.repository.setPaused(
        prefix,
        binding,
        paused,
        CHAT_IDLE_TTL_SECONDS,
      );
      if (!result.ok) return failure(result.error);
      transport.paused(roomId, result.value);
      return { ok: true, ...result.value };
    });
  }
}
