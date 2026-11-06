import { beforeHistoryCursor } from '../database/catalog-cursor';
import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import {
  acceptChunk,
  broadcastPlaylistUrl,
  broadcastThumbnailUrl,
  encodeHistoryCursor,
  isUuid,
  parseCatalogLimit,
  parseHistoryCursor,
  parseBroadcastVisibility,
  type BroadcastResponse,
  type CommandAck,
  type RoomSnapshot,
  type ReplayDeletionPage,
} from '@stageflow/shared';
import { createHash } from 'node:crypto';
import { join, resolve } from 'node:path';
import { In, Not, Repository } from 'typeorm';
import { UploadAllowance } from '../admission/upload-allowance';
import { env } from '../config/env';
import { EncoderBudget } from './encoder-budget';
import {
  diskStorageProbe,
  measureStoredBytes,
  recordingBudgetFromEnv,
  RECORDING_SIZE_MESSAGE,
  RECORDING_TIME_MESSAGE,
  StorageScanError,
  type GuestUsage,
  type RecordingBudget,
  type StorageProbe,
} from './storage-budget';
import { readOrderingInstant } from '../database/ordering-instant';
import { ApiException } from '../http/api.exception';
import { failure } from '../live/signaling.messages';
import { RoomsService } from '../rooms/rooms.service';
import type { User } from '../users/user.entity';
import { Broadcast } from './broadcast.entity';
import { FfmpegSupervisor, type FfmpegExit } from './ffmpeg-supervisor';
import {
  checkedHlsPath,
  checkedThumbnailPath,
  prepareBroadcastDirectory,
  removeBroadcastDirectory,
} from './hls-path';

export type ActiveBroadcastReader = {
  read(roomId: string): Promise<string | null>;
  close(): Promise<void>;
};

export type BroadcastHooks = {
  reserve(id: string): Promise<boolean>;
  clear(id: string): Promise<void>;
  publish(): Promise<void>;
  onExit(action: () => Promise<void>): void;
};
const DELETE_FAILED = 'The replay could not be deleted. Try again.';
const CLEANUP_ATTEMPTS = 3;
const RESERVATION_CLEANUP_FAILED = 'Broadcast reservation cleanup failed.';
type AttemptCleanup = { saved: boolean; cleared: boolean; published: boolean };
type AbandonedReservation = {
  row: Broadcast;
  hooks: BroadcastHooks;
  cleared: boolean;
};
type RunningBroadcast = {
  row: Broadcast;
  hostId: string;
  supervisor: FfmpegSupervisor;
  hooks: BroadcastHooks;
  starting: boolean;
  stopping: boolean;
  outcome?: FfmpegExit;
  terminal?: Pick<Broadcast, 'status' | 'endedAt' | 'playlistPath' | 'errorMessage'>;
  cleanup?: AttemptCleanup;
  finishing?: Promise<void>;
  releaseEncoder?: () => void;
  acceptedBytes: number;
  /** Retained guest bytes measured before this recording. Absent for a registered host. */
  guestBaseline?: number;
};

export type BroadcastPage = {
  items: BroadcastResponse[];
  nextCursor: string | null;
};

function catalog(row: Broadcast): BroadcastResponse {
  if (row.status === 'DELETING') throw new Error('A delete claim is not a catalog entry.');
  const thumbnailUrl =
    row.thumbnailPath === `broadcasts/${row.id}/thumbnail.jpg`
      ? broadcastThumbnailUrl(row.id)
      : null;
  return {
    id: row.id,
    roomId: row.roomId,
    status: row.status,
    visibility: row.visibility,
    playlistUrl: row.playlistPath ? broadcastPlaylistUrl(row.id) : null,
    thumbnailUrl,
    errorMessage: row.errorMessage,
    startedAt: row.startedAt.toISOString(),
    endedAt: row.endedAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
  };
}

@Injectable()
export class BroadcastsService {
  private readonly logger = new Logger(BroadcastsService.name);
  private readonly running = new Map<string, RunningBroadcast>();
  // A rejected reserve can still have committed its claim. The attempt stays until that id is
  // conditionally cleared and its row delete resolves. Cleanup never targets a different id.
  private readonly abandoned = new Map<string, AbandonedReservation>();
  // Last projection for a room. A missing key is not loaded; null means no attempt was found.
  private readonly views = new Map<string, RoomSnapshot['broadcast']>();
  private closing = false;
  private readonly deleting = new Set<string>();
  /** Guest starts run one at a time so the allowance sees the previous row. */
  private guestQueue: Promise<void> = Promise.resolve();
  constructor(
    @InjectRepository(Broadcast) private readonly broadcasts: Repository<Broadcast>,
    private readonly rooms: RoomsService,
    private readonly createSupervisor = () =>
      new FfmpegSupervisor(
        env.FFMPEG_PATH,
        undefined,
        undefined,
        undefined,
        undefined,
        env.FFMPEG_THREADS,
      ),
    private readonly dataRoot = resolve(__dirname, '../../../..', env.DATA_ROOT),
    private readonly uploads = new UploadAllowance(env),
    private readonly activeBroadcast: ActiveBroadcastReader = {
      read: async () => {
        throw new Error('Active broadcast reader is unavailable.');
      },
      close: async () => {},
    },
    private readonly encoders = new EncoderBudget(
      env.ENCODER_GLOBAL_LIMIT,
      env.ENCODER_PRINCIPAL_LIMIT,
    ),
    private readonly recording: RecordingBudget = recordingBudgetFromEnv(env),
    private readonly storage: StorageProbe = diskStorageProbe(dataRoot),
  ) {}

  async snapshot(roomId: string, activeId: string | null): Promise<RoomSnapshot['broadcast']> {
    if (this.views.has(roomId)) return this.views.get(roomId) ?? null;
    const row = activeId
      ? await this.broadcasts.findOneBy({ id: activeId, roomId })
      : await this.broadcasts.findOne({
          where: { roomId },
          order: { createdAt: 'DESC', id: 'DESC' },
        });
    const view = this.projection(row);
    this.views.set(roomId, view);
    return view;
  }

  private remember(row: Broadcast): void {
    this.views.set(row.roomId, this.projection(row));
  }

  private projection(row: Broadcast | null): RoomSnapshot['broadcast'] {
    return row && row.status !== 'DELETING'
      ? {
          id: row.id,
          status: row.status,
          playlistUrl: catalog(row).playlistUrl,
          errorMessage: row.errorMessage,
        }
      : null;
  }

  async start(
    roomId: string,
    hostId: string,
    hooks: BroadcastHooks,
    guest = false,
  ): Promise<CommandAck> {
    // A guest waits for the previous guest start so the count includes that row.
    const attempt = () => this.startBudgeted(roomId, hostId, hooks, guest);
    return guest ? this.enqueueGuest(attempt) : attempt();
  }

  private enqueueGuest<T>(action: () => Promise<T>): Promise<T> {
    const run = this.guestQueue.then(action, action);
    this.guestQueue = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async startBudgeted(
    roomId: string,
    hostId: string,
    hooks: BroadcastHooks,
    guest: boolean,
  ): Promise<CommandAck> {
    if (this.closing) return failure('server_error');
    // Measure disk and the guest allowance before taking a slot.
    const admission = await this.admitStorage(hostId, guest);
    if (admission.decision !== 'ok') {
      return failure(admission.decision === 'full' ? 'storage_full' : 'server_error');
    }
    const releaseEncoder = this.encoders.tryAcquire(hostId);
    if (!releaseEncoder) return failure('encoder_capacity');
    let ownedByEntry = false;
    try {
      let guestBaseline = admission.guestBaseline;
      if (guest) {
        const again = await this.admitStorage(hostId, true, true);
        if (again.decision !== 'ok') {
          return failure(again.decision === 'full' ? 'storage_full' : 'server_error');
        }
        guestBaseline = again.guestBaseline;
      }
      return await this.startReserved(
        roomId,
        hostId,
        hooks,
        releaseEncoder,
        () => {
          ownedByEntry = true;
        },
        guestBaseline,
      );
    } finally {
      if (!ownedByEntry) releaseEncoder();
    }
  }

  private async startReserved(
    roomId: string,
    hostId: string,
    hooks: BroadcastHooks,
    releaseEncoder: () => void,
    own: () => void,
    guestBaseline: number | undefined,
  ): Promise<CommandAck> {
    if (!(await this.reconcileAbandoned(roomId))) return failure('server_error');
    let row: Broadcast;
    try {
      row = await this.broadcasts.save(
        this.broadcasts.create({
          roomId,
          status: 'STARTING',
          playlistPath: null,
          thumbnailPath: null,
          errorMessage: null,
          startedAt: new Date(),
          endedAt: null,
        }),
      );
    } catch (error) {
      // The database assigns the id. A lost insert reply has no claim and is not cleared.
      this.logger.error(error instanceof Error ? error.message : 'Broadcast row insert failed.');
      return failure('server_error');
    }
    try {
      if (!(await hooks.reserve(row.id))) {
        await this.deleteRow(row.id);
        return failure('broadcast_active');
      }
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : 'Broadcast reservation failed.');
      this.abandoned.set(roomId, { row, hooks, cleared: false });
      await this.reconcileAbandoned(roomId);
      return failure('server_error');
    }
    this.remember(row);
    const entry: RunningBroadcast = {
      row,
      hostId,
      supervisor: this.createSupervisor(),
      hooks,
      starting: true,
      stopping: false,
      releaseEncoder,
      acceptedBytes: 0,
      guestBaseline,
    };
    this.running.set(row.id, entry);
    own();
    void entry.supervisor.done.then((exit) => {
      // Start and stop own an in-flight exit. Shutdown sets stopping and leaves catalog recovery
      // to the next process, so it must not finalize here either.
      if (entry.starting || entry.stopping || entry.cleanup?.published || entry.finishing) return;
      hooks.onExit(() => this.finish(entry, exit));
    });
    try {
      const directory = await prepareBroadcastDirectory(this.dataRoot, row.id);
      await hooks.publish();
      await entry.supervisor.start(directory);
      row.status = 'LIVE';
      row.playlistPath = `broadcasts/${row.id}/index.m3u8`;
      await this.broadcasts.save(row);
      this.remember(row);
      entry.starting = false;
      if (entry.supervisor.outcome) {
        await this.finish(entry, entry.supervisor.outcome);
        return failure('ffmpeg_unavailable');
      }
      await hooks.publish();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'failed to start';
      entry.supervisor.abort(`FFmpeg ${entry.supervisor.binary}: ${message}`.slice(-2000));
      const outcome = entry.supervisor.outcome ?? {
        code: null,
        premature: true,
        error: `FFmpeg ${entry.supervisor.binary}: ${message}`.slice(-2000),
      };
      try {
        await this.finish(entry, outcome);
      } catch (cleanupError) {
        this.logger.error(
          cleanupError instanceof Error ? cleanupError.message : 'Broadcast cleanup failed.',
        );
        entry.hooks.onExit(() => this.finish(entry, entry.outcome ?? outcome));
      }
      entry.starting = false;
      return failure('ffmpeg_unavailable');
    }
    return { ok: true };
  }

  private releaseEncoder(entry: RunningBroadcast): void {
    entry.releaseEncoder?.();
    entry.releaseEncoder = undefined;
  }

  private async admitStorage(
    hostId: string,
    guest: boolean,
    guestOnly = false,
  ): Promise<{ decision: 'ok'; guestBaseline?: number } | { decision: 'full' | 'error' }> {
    try {
      if (!guestOnly) {
        const free = await this.storage.freeBytes();
        const stored = await this.storage.storedBytes();
        const projected = stored + this.recording.maxRecordingBytes;
        if (
          !Number.isFinite(free) ||
          free < this.recording.minFreeBytes ||
          !Number.isFinite(stored) ||
          stored < 0 ||
          !Number.isSafeInteger(projected) ||
          projected > this.recording.maxStorageBytes
        ) {
          return { decision: 'full' };
        }
      }
      if (!guest) return { decision: 'ok' };
      const usage = await this.guestUsage(hostId);
      if (
        !Number.isFinite(usage.recordings) ||
        !Number.isFinite(usage.bytes) ||
        usage.recordings < 0 ||
        usage.bytes < 0 ||
        usage.recordings >= this.recording.guestRecordingLimit ||
        usage.bytes >= this.recording.guestStorageBytes
      ) {
        return { decision: 'full' };
      }
      return { decision: 'ok', guestBaseline: usage.bytes };
    } catch (error) {
      this.logger.error(
        error instanceof Error ? error.message : 'Recording storage could not be measured.',
      );
      return { decision: error instanceof StorageScanError ? 'full' : 'error' };
    }
  }

  private async guestUsage(hostId: string): Promise<GuestUsage> {
    if (this.storage.guestUsage) return this.storage.guestUsage(hostId);
    return this.queryGuestUsage(hostId);
  }

  /** Bounded read of one guest's recordings. Deleted rows are not an allowance. */
  private async queryGuestUsage(hostId: string): Promise<GuestUsage> {
    const limit = this.recording.guestRecordingLimit;
    const rows = await this.broadcasts
      .createQueryBuilder('broadcast')
      .innerJoin('broadcast.room', 'room')
      .where('room.hostId = :hostId', { hostId })
      .andWhere('broadcast.status != :deleting', { deleting: 'DELETING' })
      .orderBy('broadcast.createdAt', 'DESC')
      .addOrderBy('broadcast.id', 'DESC')
      .limit(limit)
      .getMany();
    if (rows.length >= limit) return { recordings: rows.length, bytes: 0 };
    let bytes = 0;
    for (const row of rows) {
      if (!isUuid(row.id)) throw new StorageScanError();
      const size = await measureStoredBytes(join(this.dataRoot, 'broadcasts', row.id));
      const next = bytes + size;
      bytes = Number.isSafeInteger(next) ? next : Number.MAX_SAFE_INTEGER;
      if (bytes >= this.recording.guestStorageBytes) break;
    }
    return { recordings: rows.length, bytes };
  }

  private async enforceRecordingBudget(entry: RunningBroadcast, nextBytes: number): Promise<void> {
    const elapsed = Date.now() - entry.row.startedAt.getTime();
    if (Number.isFinite(elapsed) && elapsed >= this.recording.maxDurationMs) {
      await this.finalizeForBudget(entry);
      throw new ApiException(409, 'recording_limit', RECORDING_TIME_MESSAGE);
    }
    const nextTotal = entry.acceptedBytes + nextBytes;
    if (!Number.isSafeInteger(nextTotal) || nextTotal > this.recording.maxRecordingBytes) {
      await this.finalizeForBudget(entry);
      throw new ApiException(409, 'recording_limit', RECORDING_SIZE_MESSAGE);
    }
    if (entry.guestBaseline !== undefined) {
      const guestTotal = entry.guestBaseline + nextTotal;
      if (!Number.isSafeInteger(guestTotal) || guestTotal > this.recording.guestStorageBytes) {
        await this.finalizeForBudget(entry);
        throw new ApiException(507, 'storage_full', failure('storage_full').message);
      }
    }
    let free: number;
    try {
      free = await this.storage.freeBytes();
    } catch (error) {
      this.logger.error(
        error instanceof Error ? error.message : 'Recording storage could not be measured.',
      );
      await this.finalizeForBudget(entry);
      throw new ApiException(507, 'storage_full', failure('storage_full').message);
    }
    if (!Number.isFinite(free) || free < this.recording.minFreeBytes) {
      await this.finalizeForBudget(entry);
      throw new ApiException(507, 'storage_full', failure('storage_full').message);
    }
  }

  /** Stop this attempt so a playlist can finish. Other recordings stay on disk. */
  private async finalizeForBudget(entry: RunningBroadcast): Promise<void> {
    if (entry.cleanup?.published || entry.row.status === 'READY' || entry.row.status === 'FAILED') {
      return;
    }
    entry.stopping = true;
    try {
      await this.stopRoom(entry.row.roomId);
    } catch (error) {
      this.logger.error(
        error instanceof Error ? error.message : 'Recording budget finalization failed.',
      );
    }
  }

  private async deleteRow(id: string): Promise<void> {
    for (let attempt = 0; attempt < CLEANUP_ATTEMPTS; attempt++) {
      try {
        await this.broadcasts.delete(id);
        return;
      } catch (error) {
        if (attempt === CLEANUP_ATTEMPTS - 1) {
          this.logger.error(
            error instanceof Error ? error.message : 'Broadcast row delete failed.',
          );
        }
      }
    }
  }

  // True only after this attempt's conditional clear and its row delete both resolve.
  // A resolved clear preserves a newer claim. A thrown clear or delete keeps the attempt.
  private async reconcileAbandoned(roomId: string): Promise<boolean> {
    const pending = this.abandoned.get(roomId);
    if (!pending) return true;
    let lastError: unknown;
    for (let attempt = 0; attempt < CLEANUP_ATTEMPTS; attempt++) {
      try {
        if (!pending.cleared) {
          await pending.hooks.clear(pending.row.id);
          pending.cleared = true;
        }
        await this.broadcasts.delete(pending.row.id);
        this.abandoned.delete(roomId);
        return true;
      } catch (error) {
        lastError = error;
      }
    }
    this.logger.error(lastError instanceof Error ? lastError.message : RESERVATION_CLEANUP_FAILED);
    return false;
  }

  private finish(entry: RunningBroadcast, exit: FfmpegExit): Promise<void> {
    entry.outcome ??= exit;
    if (entry.finishing) return entry.finishing;
    entry.finishing = this.drain(entry).finally(() => {
      if (!entry.cleanup?.published) entry.finishing = undefined;
    });
    return entry.finishing;
  }

  private async drain(entry: RunningBroadcast): Promise<void> {
    const exit = entry.outcome!;
    if (!entry.terminal) {
      let ready = false;
      if (!exit.premature && exit.code === 0) {
        try {
          await checkedHlsPath(this.dataRoot, entry.row.id, 'index.m3u8');
          ready = true;
        } catch {
          /* No playlist is a failure. */
        }
      }
      entry.terminal = {
        status: ready ? 'READY' : 'FAILED',
        endedAt: new Date(),
        playlistPath: ready ? `broadcasts/${entry.row.id}/index.m3u8` : null,
        errorMessage: ready
          ? null
          : (
              exit.error ||
              (exit.premature ? 'FFmpeg exited before stop.' : 'FFmpeg exited without a playlist.')
            ).slice(-2000),
      };
    }
    const cleanup = (entry.cleanup ??= { saved: false, cleared: false, published: false });
    let lastError: unknown;
    for (let attempt = 0; attempt < CLEANUP_ATTEMPTS && !cleanup.published; attempt++) {
      try {
        if (!cleanup.saved) {
          Object.assign(entry.row, entry.terminal);
          await this.broadcasts.save(entry.row);
          this.remember(entry.row);
          cleanup.saved = true;
        }
        if (!cleanup.cleared) {
          await entry.hooks.clear(entry.row.id);
          cleanup.cleared = true;
        }
        if (!cleanup.published) {
          await entry.hooks.publish();
          cleanup.published = true;
          this.running.delete(entry.row.id);
          this.releaseEncoder(entry);
        }
      } catch (error) {
        lastError = error;
      }
    }
    if (!cleanup.published) {
      throw lastError instanceof Error ? lastError : new Error('Broadcast cleanup failed.');
    }
  }

  private async childOutcome(entry: RunningBroadcast): Promise<FfmpegExit> {
    if (entry.outcome) return entry.outcome;
    try {
      return await entry.supervisor.stop();
    } catch (error) {
      const message = error instanceof Error ? error.message : 'FFmpeg stop failed.';
      entry.supervisor.abort(message);
      return (
        entry.supervisor.outcome ?? {
          code: null,
          premature: true,
          error: message,
        }
      );
    }
  }

  async stopRoom(roomId: string): Promise<void> {
    const reconciled = await this.reconcileAbandoned(roomId);
    const entry = [...this.running.values()].find((value) => value.row.roomId === roomId);
    if (!entry) {
      if (!reconciled) throw new Error(RESERVATION_CLEANUP_FAILED);
      return;
    }
    entry.stopping = true;
    if (!entry.cleanup?.saved && entry.row.status !== 'READY' && entry.row.status !== 'FAILED') {
      try {
        entry.row.status = 'STOPPING';
        await this.broadcasts.save(entry.row);
        this.remember(entry.row);
        await entry.hooks.publish();
      } catch (error) {
        this.logger.error(
          error instanceof Error ? error.message : 'Broadcast stop notification failed.',
        );
      }
    }
    await this.finish(entry, await this.childOutcome(entry));
    if (!reconciled) throw new Error(RESERVATION_CLEANUP_FAILED);
  }

  async failInterrupted(roomId: string): Promise<void> {
    // Membership suspension awaits this. Reservation cleanup must not block it.
    await this.reconcileAbandoned(roomId);
    const entry = [...this.running.values()].find((value) => value.row.roomId === roomId);
    if (!entry) return;
    // Own the abort/cleanup so the child-exit callback cannot queue a competing graceful stop.
    entry.stopping = true;
    entry.supervisor.abort('Host connection lost.');
    if (!entry.cleanup?.saved) {
      entry.outcome = { code: null, premature: true, error: 'Host connection lost.' };
      entry.terminal = undefined;
    }
    await this.finish(entry, { code: null, premature: true, error: 'Host connection lost.' });
  }

  async upload(id: string, userId: string, sequence: number, bytes: Buffer): Promise<void> {
    const entry = this.running.get(id);
    if (!entry || entry.row.status !== 'LIVE' || entry.stopping || entry.supervisor.outcome)
      throw new ApiException(409, 'broadcast_not_active', 'The broadcast is not accepting chunks.');
    if (userId !== entry.hostId)
      throw new ApiException(403, 'not_host', 'Only the host can upload chunks.');
    const retryAfterSeconds = this.uploads.limit(userId, id);
    if (retryAfterSeconds !== null)
      throw new ApiException(
        429,
        'rate_limited',
        'Too many requests. Try again shortly.',
        retryAfterSeconds,
      );
    if (
      !Number.isSafeInteger(sequence) ||
      sequence < 0 ||
      !Buffer.isBuffer(bytes) ||
      bytes.length === 0
    )
      throw new ApiException(400, 'invalid_chunk', 'Invalid chunk metadata or body.');
    if (entry.supervisor.writing)
      throw new ApiException(409, 'chunk_conflict', 'A chunk is still being written.');
    const sha256 = createHash('sha256').update(bytes).digest('hex');
    const decision = acceptChunk(entry.supervisor.history, {
      sequence,
      byteLength: bytes.length,
      sha256,
    });
    if (decision.kind === 'duplicate') return;
    if (decision.kind === 'oversize')
      throw new ApiException(413, 'invalid_chunk', 'Chunk exceeds 2,000,000 bytes.');
    if (decision.kind !== 'accept')
      throw new ApiException(409, 'chunk_conflict', `Chunk is ${decision.kind}.`);
    // Hold the in-flight flag across the disk check so a second chunk cannot pass it.
    entry.supervisor.writing = true;
    try {
      await this.enforceRecordingBudget(entry, bytes.length);
      await entry.supervisor.write(bytes);
      entry.acceptedBytes += bytes.length;
      entry.supervisor.history.acceptedHashes.set(sequence, sha256);
      entry.supervisor.history.nextExpected = sequence + 1;
    } finally {
      entry.supervisor.writing = false;
    }
  }

  async mediaPath(id: string, file: string, user: User): Promise<string> {
    await this.readableRow(id, user);
    try {
      return await checkedHlsPath(this.dataRoot, id, file);
    } catch {
      throw new ApiException(404, 'media_not_found', 'No HLS file exists for that path.');
    }
  }

  async thumbnailFile(id: string, user: User): Promise<string> {
    const missing = new ApiException(
      404,
      'media_not_found',
      'No thumbnail exists for that broadcast.',
    );
    const row = await this.readableRow(id, user);
    if (row.thumbnailPath !== `broadcasts/${row.id}/thumbnail.jpg`) throw missing;
    try {
      return await checkedThumbnailPath(this.dataRoot, id, 'thumbnail.jpg');
    } catch {
      throw missing;
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    try {
      await this.activeBroadcast.close();
    } catch (error) {
      this.logger.error(error instanceof Error ? error.message : 'Broadcast reader close failed.');
    }
    await Promise.all(
      [...this.running.values()].map(async (entry) => {
        // Catalog/key cleanup is done by the next owning startup if shutdown cannot finish.
        entry.stopping = true;
        try {
          await entry.supervisor.stop();
        } catch (error) {
          this.logger.error(error);
        } finally {
          this.releaseEncoder(entry);
        }
      }),
    );
  }

  async failInFlight(): Promise<void> {
    await this.broadcasts.update(
      { status: In(['STARTING', 'LIVE', 'STOPPING']) },
      { status: 'FAILED', errorMessage: 'api restarted', endedAt: new Date() },
    );
  }

  async listByRoomSlug(
    slug: string,
    query: Record<string, unknown>,
    user: User,
  ): Promise<BroadcastPage> {
    const limit = parseCatalogLimit(query.limit);
    if (!limit.ok) throw new ApiException(400, limit.error, limit.message);
    const cursor = parseHistoryCursor(query.cursor);
    if (!cursor.ok) throw new ApiException(400, cursor.error, cursor.message);

    const catalogRoom = await this.rooms.getBySlug(slug);
    const room = await this.rooms.getById(catalogRoom.id);
    if (!room) throw new ApiException(404, 'room_not_found', 'No room exists for that slug.');
    const rows = await this.broadcasts.find({
      where: {
        roomId: room.id,
        status: Not('DELETING'),
        visibility:
          user.isGuest === false && user.id === room.hostId ? In(['LINK', 'HOST']) : 'LINK',
        ...(cursor.value
          ? { id: beforeHistoryCursor(cursor.value.createdAt, cursor.value.id) }
          : {}),
      },
      order: { createdAt: 'DESC', id: 'DESC' },
      take: limit.value + 1,
    });
    const items = (rows.length > limit.value ? rows.slice(0, limit.value) : rows).map(catalog);
    if (rows.length <= limit.value) return { items, nextCursor: null };
    const last = items.at(-1);
    const ordering = last
      ? await readOrderingInstant(
          (sql, parameters) => this.broadcasts.query(sql, parameters),
          'broadcasts',
          last.id,
        )
      : null;
    const nextCursor = last && ordering ? encodeHistoryCursor(ordering, last.id) : null;
    if (!nextCursor)
      throw new ApiException(500, 'server_busy', 'The broadcast page could not be read.');
    return { items, nextCursor };
  }

  async setVisibility(id: string, user: User, body: unknown): Promise<BroadcastResponse> {
    const row = await this.ownedReplay(id, user);
    if (row.status === 'DELETING') throw this.broadcastNotFound();
    if (row.status !== 'READY' && row.status !== 'FAILED')
      throw new ApiException(409, 'broadcast_not_ready', 'Hide a replay after it has finished.');
    const visibility = parseBroadcastVisibility(body);
    if (!visibility.ok) throw new ApiException(400, visibility.error, visibility.message);
    if (visibility.value === row.visibility) return catalog(row);
    const result = await this.broadcasts.update(
      { id, status: In(['READY', 'FAILED']) },
      { visibility: visibility.value },
    );
    if (!result.affected) throw this.broadcastNotFound();
    return this.getById(id, user);
  }

  async listReplayDeletions(
    slug: string,
    query: Record<string, unknown>,
    user: User,
  ): Promise<ReplayDeletionPage> {
    const catalogRoom = await this.rooms.getBySlug(slug);
    const room = await this.rooms.getById(catalogRoom.id);
    if (!room || room.hostId !== user.id) throw this.broadcastNotFound();
    if (user.isGuest !== false)
      throw new ApiException(
        403,
        'replay_owner_required',
        'Create a host account before changing this replay.',
      );
    const limit = parseCatalogLimit(query.limit);
    if (!limit.ok) throw new ApiException(400, limit.error, limit.message);
    const cursor = parseHistoryCursor(query.cursor);
    if (!cursor.ok) throw new ApiException(400, cursor.error, cursor.message);
    const rows = await this.broadcasts.find({
      where: {
        roomId: room.id,
        status: 'DELETING',
        ...(cursor.value
          ? { id: beforeHistoryCursor(cursor.value.createdAt, cursor.value.id) }
          : {}),
      },
      order: { createdAt: 'DESC', id: 'DESC' },
      take: limit.value + 1,
    });
    const items = rows.slice(0, limit.value).map((row) => ({
      id: row.id,
      roomId: row.roomId,
      createdAt: row.createdAt.toISOString(),
    }));
    if (rows.length <= limit.value) return { items, nextCursor: null };
    const last = items.at(-1)!;
    const ordering = await readOrderingInstant(
      (sql, parameters) => this.broadcasts.query(sql, parameters),
      'broadcasts',
      last.id,
    );
    const nextCursor = ordering ? encodeHistoryCursor(ordering, last.id) : null;
    if (!nextCursor)
      throw new ApiException(500, 'server_busy', 'The deletion page could not be read.');
    return { items, nextCursor };
  }

  async deleteReplay(id: string, user: User, pendingOnly = false): Promise<void> {
    const row = await this.ownedReplay(id, user);
    if (pendingOnly && row.status !== 'DELETING') throw this.broadcastNotFound();
    if (this.deleting.has(id)) throw this.broadcastNotFound();
    this.deleting.add(id);
    try {
      await this.removeReplay(row, user);
    } finally {
      this.deleting.delete(id);
    }
  }

  private async removeReplay(row: Broadcast, user: User): Promise<void> {
    const id = row.id;
    if (!['READY', 'FAILED', 'DELETING'].includes(row.status))
      throw new ApiException(409, 'broadcast_not_deletable', 'A live broadcast cannot be deleted.');
    const previousStatus = row.status;
    let activeId: string | null;
    try {
      activeId = await this.activeBroadcast.read(row.roomId);
    } catch {
      throw new ApiException(500, 'broadcast_delete_failed', DELETE_FAILED);
    }
    if (activeId === id)
      throw new ApiException(409, 'broadcast_not_deletable', 'A live broadcast cannot be deleted.');
    // Redis can take time to answer. Recheck ownership/state before touching disk.
    const current = await this.ownedReplay(id, user);
    if (current.roomId !== row.roomId || current.status !== previousStatus)
      throw this.broadcastNotFound();
    if (previousStatus !== 'DELETING') {
      const claim = await this.broadcasts.update(
        { id, status: previousStatus },
        { status: 'DELETING' },
      );
      if (!claim.affected) throw this.broadcastNotFound();
    }
    // Invalidate a cached completed projection; the next snapshot reloads the claimed row.
    this.views.delete(row.roomId);
    let canRestore = previousStatus !== 'DELETING';
    try {
      await removeBroadcastDirectory(this.dataRoot, id, () => {
        canRestore = false;
      });
      // Also retain deletion intent if the directory was already missing.
      canRestore = false;
      const deleted = await this.broadcasts.delete({ id, status: 'DELETING' });
      if (!deleted.affected && (await this.broadcasts.findOneBy({ id })))
        throw new Error(DELETE_FAILED);
    } catch (error) {
      try {
        await this.broadcasts.update(
          { id, status: 'DELETING' },
          { ...(canRestore ? { status: previousStatus } : {}), errorMessage: DELETE_FAILED },
        );
      } catch (updateError) {
        this.logger.error(updateError instanceof Error ? updateError.message : DELETE_FAILED);
      }
      this.views.delete(row.roomId);
      this.logger.error(error instanceof Error ? error.message : DELETE_FAILED);
      throw new ApiException(500, 'broadcast_delete_failed', DELETE_FAILED);
    }
    this.views.delete(row.roomId);
  }

  private broadcastNotFound(): ApiException {
    return new ApiException(404, 'broadcast_not_found', 'No broadcast exists for that id.');
  }

  private async ownedReplay(id: string, user: User): Promise<Broadcast> {
    if (!isUuid(id)) throw this.broadcastNotFound();
    const row = await this.broadcasts.findOneBy({ id });
    if (!row) throw this.broadcastNotFound();
    const room = await this.rooms.getById(row.roomId);
    if (!room || room.hostId !== user.id) throw this.broadcastNotFound();
    if (user.isGuest !== false)
      throw new ApiException(
        403,
        'replay_owner_required',
        'Create a host account before changing this replay.',
      );
    return row;
  }

  async getById(id: string, user: User): Promise<BroadcastResponse> {
    return catalog(await this.readableRow(id, user));
  }

  private async readableRow(id: string, user: User): Promise<Broadcast> {
    const notFound = new ApiException(
      404,
      'broadcast_not_found',
      'No broadcast exists for that id.',
    );
    if (!isUuid(id)) throw notFound;
    const row = await this.broadcasts.findOneBy({ id });
    if (!row || row.status === 'DELETING') throw notFound;
    const room = await this.rooms.getById(row.roomId);
    if (!room || (row.visibility === 'HOST' && (user.isGuest !== false || user.id !== room.hostId)))
      throw notFound;
    return row;
  }
}
