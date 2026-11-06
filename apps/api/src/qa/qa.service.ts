import { Logger } from '@nestjs/common';
import {
  QA_BOARD_MAX,
  QA_IDLE_TTL_SECONDS,
  QA_MAX_QUEUED_OPERATIONS,
  QA_SUBMIT_PARTICIPANT_LIMIT,
  QA_SUBMIT_ROOM_LIMIT,
  QA_VOTE_PARTICIPANT_LIMIT,
  QA_VOTE_ROOM_LIMIT,
  QA_RATE_WINDOW_MS,
  QA_USER_RATE_MAX_FIELDS,
  type QaState,
  type QaStateAck,
  type QaSubmitRequest,
  type TransportBinding,
} from '@stageflow/shared';
import type { QaRepository, QaLimits, QaStoreResult } from './qa.repository';
import type { LiveService, LiveSession } from '../live/live.service';
import { roomPrefix } from '../live/live.keys';
import { SerializedOperations, WorkCapacityError } from '../live/serialized-operations';
import { failure } from '../live/signaling.messages';

export interface QaTransport {
  state(roomId: string, state: QaState): void;
}

const limits: QaLimits = {
  boardMax: QA_BOARD_MAX,
  ttlSeconds: QA_IDLE_TTL_SECONDS,
  submitParticipantLimit: QA_SUBMIT_PARTICIPANT_LIMIT,
  submitRoomLimit: QA_SUBMIT_ROOM_LIMIT,
  voteParticipantLimit: QA_VOTE_PARTICIPANT_LIMIT,
  voteRoomLimit: QA_VOTE_ROOM_LIMIT,
  rateWindowMs: QA_RATE_WINDOW_MS,
  userRateMaxFields: QA_USER_RATE_MAX_FIELDS,
};

export class QaService {
  private readonly logger = new Logger(QaService.name);
  private readonly operations = new SerializedOperations({
    maxPending: 512,
    // One running command and 32 waiting, independent of chat and stage queues.
    maxPerKey: QA_MAX_QUEUED_OPERATIONS + 1,
    cleanupReserve: 0,
  });

  constructor(
    private readonly repository: Pick<QaRepository, 'submit' | 'vote' | 'state'>,
    private readonly live: Pick<LiveService, 'authorizeQa'>,
    private readonly namespace = 'sf',
    private readonly now = () => Date.now(),
  ) {}

  onModuleDestroy(): Promise<void> {
    return this.operations.onModuleDestroy();
  }

  private execute(
    client: LiveSession,
    action: (prefix: string, binding: TransportBinding) => Promise<QaStoreResult>,
    transport?: QaTransport,
  ): Promise<QaStateAck> {
    const room = client.room;
    if (!room) return Promise.resolve(failure('not_joined'));
    const binding: TransportBinding = {
      participantId: client.participantId ?? '',
      socketId: client.id,
      generation: client.generation ?? 0,
    };
    return this.operations
      .run(`room:${room.roomId}:qa`, async () => {
        if (
          client.room !== room ||
          client.participantId !== binding.participantId ||
          client.generation !== binding.generation
        )
          return failure('stale_transport');
        const authorized = await this.live.authorizeQa(client, room);
        if (!authorized.ok) return authorized;
        const result = await action(roomPrefix(room.roomId, this.namespace), binding);
        if (!result.ok) return failure(result.error);
        if (transport) {
          const { submissionsOpen, featured, questions } = result.value;
          transport.state(room.roomId, { submissionsOpen, featured, questions });
        }
        return { ok: true as const, ...result.value };
      })
      .catch((error: unknown) => {
        if (!(error instanceof WorkCapacityError))
          this.logger.error(error instanceof Error ? error.message : 'Question command failed.');
        return failure('qa_busy');
      });
  }

  submit(
    client: LiveSession,
    request: QaSubmitRequest,
    transport: QaTransport,
  ): Promise<QaStateAck> {
    return this.execute(
      client,
      (prefix, binding) => this.repository.submit(prefix, binding, request, limits, this.now()),
      transport,
    );
  }

  vote(client: LiveSession, questionId: string, transport: QaTransport): Promise<QaStateAck> {
    return this.execute(
      client,
      (prefix, binding) => this.repository.vote(prefix, binding, questionId, limits, this.now()),
      transport,
    );
  }

  state(client: LiveSession): Promise<QaStateAck> {
    return this.execute(client, (prefix, binding) => this.repository.state(prefix, binding));
  }
}
