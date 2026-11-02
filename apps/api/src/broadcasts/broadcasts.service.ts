import { Injectable, Logger } from '@nestjs/common';
import { InjectRepository } from '@nestjs/typeorm';
import { acceptChunk, isUuid, type CommandAck, type RoomSnapshot } from '@stageflow/shared';
import { createHash } from 'node:crypto';
import { resolve } from 'node:path';
import { In, Repository } from 'typeorm';
import { ApiException } from '../http/api.exception';
import { RoomsService } from '../rooms/rooms.service';
import { Broadcast } from './broadcast.entity';
import { env } from '../config/env';
import { FfmpegSupervisor, type FfmpegExit } from './ffmpeg-supervisor';
import { checkedHlsPath, prepareBroadcastDirectory } from './hls-path';
import { failure } from '../live/signaling.messages';

export type BroadcastHooks = {
  reserve(id: string): Promise<boolean>;
  clear(id: string): Promise<void>;
  publish(): Promise<void>;
  onExit(action: () => Promise<void>): void;
};
type RunningBroadcast = {
  row: Broadcast;
  hostId: string;
  supervisor: FfmpegSupervisor;
  hooks: BroadcastHooks;
  starting: boolean;
  stopping: boolean;
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
    const row = await this.broadcasts.save(
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
    if (!(await hooks.reserve(row.id))) {
      await this.broadcasts.delete(row.id);
      return failure('broadcast_active');
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
      if (!entry.starting && !entry.stopping) hooks.onExit(() => this.finish(entry, exit));
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
      entry.supervisor.abort(error instanceof Error ? error.message : 'Broadcast start failed.');
      await this.finish(entry, {
        code: null,
        premature: true,
        error: `FFmpeg ${entry.supervisor.binary}: ${error instanceof Error ? error.message : 'failed to start'}`,
      });
      return failure('ffmpeg_unavailable');
    }
    return { ok: true };
  }

  private finish(entry: RunningBroadcast, exit: FfmpegExit): Promise<void> {
    if (entry.finishing) return entry.finishing;
    entry.finishing = (async () => {
      let ready = false;
      if (!exit.premature && exit.code === 0) {
        try {
          await checkedHlsPath(this.dataRoot, entry.row.id, 'index.m3u8');
          ready = true;
        } catch {
          /* No playlist is a failure. */
        }
      }
      Object.assign(entry.row, {
        status: ready ? 'READY' : 'FAILED',
        endedAt: new Date(),
        playlistPath: ready ? `broadcasts/${entry.row.id}/index.m3u8` : null,
        errorMessage: ready
          ? null
          : (
              exit.error ||
              (exit.premature ? 'FFmpeg exited before stop.' : 'FFmpeg exited without a playlist.')
            ).slice(-2000),
      });
      await this.broadcasts.save(entry.row);
      this.remember(entry.row);
      await entry.hooks.clear(entry.row.id);
      await entry.hooks.publish();
      this.running.delete(entry.row.id);
    })().catch((error: unknown) => {
      entry.finishing = undefined;
      throw error;
    });
    return entry.finishing;
  }

  async stopRoom(roomId: string): Promise<void> {
    const entry = [...this.running.values()].find((value) => value.row.roomId === roomId);
    if (!entry) return;
    entry.stopping = true;
    entry.row.status = 'STOPPING';
    await this.broadcasts.save(entry.row);
    this.remember(entry.row);
    await entry.hooks.publish();
    await this.finish(entry, await entry.supervisor.stop());
  }

  async upload(id: string, userId: string, sequence: number, bytes: Buffer): Promise<void> {
    const entry = this.running.get(id);
    if (!entry || entry.row.status !== 'LIVE' || entry.supervisor.outcome)
      throw new ApiException(409, 'broadcast_not_active', 'The broadcast is not accepting chunks.');
    if (userId !== entry.hostId)
      throw new ApiException(403, 'not_host', 'Only the host can upload chunks.');
    if (!Number.isSafeInteger(sequence) || sequence < 0 || !Buffer.isBuffer(bytes))
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
