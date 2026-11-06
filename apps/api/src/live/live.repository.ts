import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Redis } from 'ioredis';
import type {
  LiveState,
  ParticipantState,
  StageCommand,
  StageError,
  StageSuccess,
} from '@stageflow/shared';
import { liveKeys } from './live.keys';

export type LiveRoom = Pick<
  LiveState,
  'roomId' | 'hostId' | 'mode' | 'status' | 'requireAdmission'
>;
export type LiveResult =
  | { ok: true; state: LiveState; revision: number; changed: boolean; roomEnded: boolean }
  | { ok: false; error: StageError; revision: number; expiry?: StageSuccess };

const commandTypes = [
  'start',
  'admit',
  'removeWaiter',
  'cancel',
  'join',
  'leave',
  'patchMedia',
  'setHand',
  'promote',
  'demote',
  'setHostLock',
  'suspend',
  'resume',
  'expire',
] as const;
const scriptNames = [
  ...commandTypes,
  'tryBeginBroadcast',
  'clearBroadcast',
  'grantResume',
  'snapshot',
] as const;
type ScriptName = (typeof scriptNames)[number];

export class LiveRepository {
  private readonly scripts: Record<ScriptName, { source: string; sha: string }>;

  constructor(private readonly redis: Redis) {
    // Source assets also work with Nest's compiled dist/live directory.
    const directory = join(__dirname, 'scripts');
    const common = readFileSync(join(directory, 'common.lua'), 'utf8');
    this.scripts = Object.fromEntries(
      scriptNames.map((type) => {
        const body = readFileSync(join(directory, `${type}.lua`), 'utf8');
        const source =
          type === 'tryBeginBroadcast' || type === 'clearBroadcast' || type === 'grantResume'
            ? body
            : `${common}\n${body}`;
        return [type, { source, sha: createHash('sha1').update(source).digest('hex') }];
      }),
    ) as Record<ScriptName, { source: string; sha: string }>;
  }

  async apply(prefix: string, room: LiveRoom, command: StageCommand): Promise<LiveResult> {
    const result = await this.execute(command.type, prefix, JSON.stringify({ ...command, room }));
    if (typeof result !== 'string') throw new Error('Invalid Redis stage result.');
    const parsed = JSON.parse(result) as LiveResult;
    if (!parsed.ok && parsed.expiry)
      delete (parsed.expiry as StageSuccess & { revision?: number }).revision;
    return parsed;
  }

  async grantResume(
    prefix: string,
    participantId: string,
    generation: number,
    digest: string,
  ): Promise<boolean> {
    return (
      (await this.execute(
        'grantResume',
        prefix,
        JSON.stringify({ participantId, generation, digest }),
      )) === 1
    );
  }

  async tryBeginBroadcast(prefix: string, broadcastId: string): Promise<boolean> {
    return (await this.execute('tryBeginBroadcast', prefix, broadcastId)) === 1;
  }

  async clearBroadcast(prefix: string, id?: string): Promise<void> {
    await this.execute('clearBroadcast', prefix, ...(id ? [id] : []));
  }

  async readBroadcast(prefix: string): Promise<string | null> {
    return this.redis.get(`${prefix}:broadcast`);
  }

  async readParticipant(prefix: string, participantId: string): Promise<ParticipantState | null> {
    const value = await this.redis.hget(`${prefix}:participants`, participantId);
    return value ? (JSON.parse(value) as ParticipantState) : null;
  }

  async readSocket(prefix: string, participantId: string): Promise<string | null> {
    const participant = await this.readParticipant(prefix, participantId);
    if (participant?.presence !== 'connected' || !participant.socketId) return null;
    return (await this.redis.hget(`${prefix}:transports`, participant.socketId)) === participantId
      ? participant.socketId
      : null;
  }

  async readConnectedStage(prefix: string): Promise<string[]> {
    const stage = await this.readStage(prefix);
    const sockets = await Promise.all(stage.map((id) => this.readSocket(prefix, id)));
    return stage.filter((_id, index) => sockets[index] !== null);
  }

  async refreshSnapshot(
    prefix: string,
    room: LiveRoom,
  ): Promise<Extract<LiveResult, { ok: true }>> {
    const result = await this.execute('snapshot', prefix, JSON.stringify({ room }));
    if (typeof result !== 'string') throw new Error('Invalid Redis snapshot result.');
    return JSON.parse(result) as Extract<LiveResult, { ok: true }>;
  }

  private async execute(name: ScriptName, prefix: string, ...args: string[]): Promise<unknown> {
    const script = this.scripts[name];
    const keys = liveKeys(prefix);
    try {
      return await this.redis.evalsha(script.sha, keys.length, ...keys, ...args);
    } catch (error) {
      // NOSCRIPT guarantees the command did not execute. Never retry ambiguous transport failures
      // or Lua errors, which could otherwise apply a mutation twice.
      if (!(error instanceof Error) || !/^NOSCRIPT\b/.test(error.message)) throw error;
      return this.redis.eval(script.source, keys.length, ...keys, ...args);
    }
  }

  async readStage(prefix: string): Promise<string[]> {
    return this.redis.smembers(`${prefix}:stage`);
  }

  async deleteRoom(prefix: string): Promise<void> {
    await this.redis.del(...liveKeys(prefix));
  }
}
