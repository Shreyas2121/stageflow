import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join } from 'node:path';
import type { Redis } from 'ioredis';
import type { LiveState, StageCommand, StageError } from '@stageflow/shared';
import { liveKeys } from './live.keys';

export type LiveRoom = Pick<LiveState, 'roomId' | 'hostId' | 'mode' | 'status'>;
export type LiveResult =
  | { ok: true; state: LiveState; revision: number; changed: boolean; roomEnded: boolean }
  | { ok: false; error: StageError; revision: number };

const commandTypes = [
  'join',
  'leave',
  'patchMedia',
  'setHand',
  'promote',
  'demote',
  'setHostLock',
] as const;
const scriptNames = [...commandTypes, 'tryBeginBroadcast', 'clearBroadcast'] as const;
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
          type === 'tryBeginBroadcast' || type === 'clearBroadcast' ? body : `${common}\n${body}`;
        return [type, { source, sha: createHash('sha1').update(source).digest('hex') }];
      }),
    ) as Record<ScriptName, { source: string; sha: string }>;
  }

  async apply(prefix: string, room: LiveRoom, command: StageCommand): Promise<LiveResult> {
    const result = await this.execute(command.type, prefix, JSON.stringify({ ...command, room }));
    if (typeof result !== 'string') throw new Error('Invalid Redis stage result.');
    return JSON.parse(result) as LiveResult;
  }

  async tryBeginBroadcast(prefix: string, broadcastId: string): Promise<boolean> {
    return (await this.execute('tryBeginBroadcast', prefix, broadcastId)) === 1;
  }

  async clearBroadcast(prefix: string): Promise<void> {
    await this.execute('clearBroadcast', prefix);
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
