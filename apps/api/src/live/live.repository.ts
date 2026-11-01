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

export class LiveRepository {
  private readonly scripts: Record<StageCommand['type'], { source: string; sha: string }>;

  constructor(private readonly redis: Redis) {
    // Source assets also work with Nest's compiled dist/live directory.
    const directory = join(__dirname, 'scripts');
    const common = readFileSync(join(directory, 'common.lua'), 'utf8');
    this.scripts = Object.fromEntries(
      commandTypes.map((type) => {
        const source = `${common}\n${readFileSync(join(directory, `${type}.lua`), 'utf8')}`;
        return [type, { source, sha: createHash('sha1').update(source).digest('hex') }];
      }),
    ) as Record<StageCommand['type'], { source: string; sha: string }>;
  }

  async apply(prefix: string, room: LiveRoom, command: StageCommand): Promise<LiveResult> {
    const script = this.scripts[command.type];
    const keys = liveKeys(prefix);
    const payload = JSON.stringify({ ...command, room });
    let result: unknown;
    try {
      result = await this.redis.evalsha(script.sha, keys.length, ...keys, payload);
    } catch (error) {
      // NOSCRIPT guarantees the command did not execute. Never retry ambiguous transport failures
      // or Lua errors, which could otherwise apply a mutation twice.
      if (!(error instanceof Error) || !/^NOSCRIPT\b/.test(error.message)) throw error;
      result = await this.redis.eval(script.source, keys.length, ...keys, payload);
    }
    if (typeof result !== 'string') throw new Error('Invalid Redis stage result.');
    return JSON.parse(result) as LiveResult;
  }

  async readStage(prefix: string): Promise<string[]> {
    return this.redis.smembers(`${prefix}:stage`);
  }

  async deleteRoom(prefix: string): Promise<void> {
    await this.redis.del(...liveKeys(prefix));
  }
}
