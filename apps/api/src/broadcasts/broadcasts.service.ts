import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { acceptChunk, isUuid, type CommandAck, type RoomSnapshot } from '@stageflow/shared';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { In, Repository } from 'typeorm';
import { UploadAllowance } from '../admission/upload-allowance';
import { env } from '../config/env';
import { ApiException } from '../http/api.exception';
import { failure } from '../live/signaling.messages';
import { RoomsService } from '../rooms/rooms.service';
import { Broadcast } from './broadcast.entity';
import { FfmpegSupervisor, type FfmpegExit } from './ffmpeg-supervisor';
import { checkedHlsPath, prepareBroadcastDirectory } from './hls-path';

export type BroadcastHooks = {
  reserve(id: string): Promise<boolean>;
  clear(id: string): Promise<void>;
  publish(): Promise<void>;
  onExit(action: () => Promise<void>): void;
};
const CLEANUP_ATTEMPTS = 3;
type AttemptCleanup = { saved: boolean; cleared: boolean; published: boolean };
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
};

export type BroadcastCatalog = Pick<
  Broadcast,
  'id' | 'roomId' | 'status' | 'playlistPath' | 'thumbnailPath' | 'errorMessage'
> & { startedAt: string; endedAt: string | null; createdAt: string; playlistUrl: string | null };

function catalog(row: Broadcast): BroadcastCatalog {
  return {
    id: row.id,
    roomId: row.roomId,
    status: row.status,
    playlistPath: row.playlistPath,
    playlistUrl: row.playlistPath ? `/api/broadcasts/${row.id}/hls/index.m3u8` : null,
    thumbnailPath: row.thumbnailPath,
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
  // Last projection for a room. A missing key is not loaded; null means no attempt was found.
  private readonly views = new Map<string, RoomSnapshot['broadcast']>();
  private closing = false;
  constructor(
    @InjectRepository(Broadcast) private readonly broadcasts: Repository<Broadcast>,
    private readonly rooms: RoomsService,
    private readonly createSupervisor = () => new FfmpegSupervisor(env.FFMPEG_PATH),
    private readonly dataRoot = resolve(__dirname, '../../../..', env.DATA_ROOT),
    private readonly uploads = new UploadAllowance(env),
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
    return row
      ? {
          id: row.id,
          status: row.status,
          playlistUrl: catalog(row).playlistUrl,
          errorMessage: row.errorMessage,
        }
      : null;
  }

  async start(roomId: string, hostId: string, hooks: BroadcastHooks): Promise<CommandAck> {
    if (this.closing) return failure('server_error');
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
      await this.deleteRow(row.id);
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
    };
    this.running.set(row.id, entry);
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
    const entry = [...this.running.values()].find((value) => value.row.roomId === roomId);
    if (!entry) return;
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
  }

  async upload(id: string, userId: string, sequence: number, bytes: Buffer): Promise<void> {
    const entry = this.running.get(id);
    if (!entry || entry.row.status !== 'LIVE' || entry.supervisor.outcome)
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
    const decision = acceptChunk(entry.supervisor.history, {
      sequence,
      byteLength: bytes.length,
      sha256: createHash('sha256').update(bytes).digest('hex'),
    });
    if (decision.kind === 'duplicate') return;
    if (decision.kind === 'oversize')
      throw new ApiException(413, 'invalid_chunk', 'Chunk exceeds 2,000,000 bytes.');
    if (decision.kind !== 'accept')
      throw new ApiException(409, 'chunk_conflict', `Chunk is ${decision.kind}.`);
    entry.supervisor.writing = true;
    try {
      await entry.supervisor.write(bytes);
      entry.supervisor.history = decision;
    } finally {
      entry.supervisor.writing = false;
    }
  }

  async mediaPath(id: string, file: string): Promise<string> {
    await this.getById(id);
    try {
      return await checkedHlsPath(this.dataRoot, id, file);
    } catch {
      throw new ApiException(404, 'media_not_found', 'No HLS file exists for that path.');
    }
  }

  async onModuleDestroy(): Promise<void> {
    this.closing = true;
    await Promise.all(
      [...this.running.values()].map(async (entry) => {
        // Catalog/key cleanup is done by the next owning startup if shutdown cannot finish.
        entry.stopping = true;
        try {
          await entry.supervisor.stop();
        } catch (error) {
          this.logger.error(error);
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

  async listByRoomSlug(slug: string): Promise<BroadcastCatalog[]> {
    const room = await this.rooms.getBySlug(slug);
    const rows = await this.broadcasts.find({
      where: { roomId: room.id },
      order: { createdAt: 'DESC', id: 'DESC' },
    });
    return rows.map(catalog);
  }

  async getById(id: string): Promise<BroadcastCatalog> {
    const notFound = new ApiException(
      404,
      'broadcast_not_found',
      'No broadcast exists for that id.',
    );
    if (!isUuid(id)) throw notFound;
    const row = await this.broadcasts.findOneBy({ id });
    if (!row) throw notFound;
    return catalog(row);
  }
}
