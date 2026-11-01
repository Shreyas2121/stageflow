import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import type { Redis } from 'ioredis';
import type { LiveState, StageCommand, StageError } from '@stageflow/shared';

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
  private readonly scripts: Record<StageCommand['type'], string>;

  constructor(private readonly redis: Redis) {
    // Source assets also work with Nest's compiled dist/live directory.
    const directory = join(__dirname, 'scripts');
    const common = readFileSync(join(directory, 'common.lua'), 'utf8');
    this.scripts = Object.fromEntries(
      commandTypes.map((type) => [
        type,
        `${common}\n${readFileSync(join(directory, `${type}.lua`), 'utf8')}`,
      ]),
    ) as Record<StageCommand['type'], string>;
  }

  async apply(prefix: string, room: LiveRoom, command: StageCommand): Promise<LiveResult> {
    const result = await this.redis.eval(
      this.scripts[command.type],
      1,
      prefix,
      JSON.stringify({ ...command, room }),
    );
    if (typeof result !== 'string') throw new Error('Invalid Redis stage result.');
    return JSON.parse(result) as LiveResult;
  }

  async readStage(prefix: string): Promise<string[]> {
    return this.redis.smembers(`${prefix}:stage`);
  }

  async deleteRoom(prefix: string): Promise<void> {
    await this.redis.del(
      ...['rev', 'participants', 'stage', 'hands'].map((suffix) => `${prefix}:${suffix}`),
    );
  }
}
