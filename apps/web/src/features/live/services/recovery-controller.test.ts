import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { ResumeAck } from '@stageflow/shared';
import { RecoveryController, type RecoveryHost } from './recovery-controller';
import type { RoomConnection } from './signaling';

function success(): Extract<ResumeAck, { ok: true }> {
  return {
    ok: true,
    participantId: 'member',
    connectionGeneration: 2,
    iceServers: [],
    snapshot: {
      roomId: 'room',
      mode: 'MEETING',
      status: 'LIVE',
      revision: 2,
      participants: [],
      stageParticipantIds: [],
      waitingParticipantIds: [],
      handParticipantIds: [],
      broadcast: null,
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

async function settle() {
  for (let index = 0; index < 20; index++) await Promise.resolve();
}

const controllers: RecoveryController[] = [];

function harness() {
  let connection: RoomConnection | null = null;
  let phase = 'recovering';
  const attempts: {
    connection: RoomConnection;
    onResumed: Parameters<RecoveryHost['open']>[0];
    close: ReturnType<typeof vi.fn>;
    leave: ReturnType<typeof vi.fn>;
  }[] = [];
  const resume = vi.fn<RoomConnection['resume']>(() => new Promise(() => {}));
  const starts: number[] = [];
  const host: RecoveryHost = {
    get connection() {
      return connection;
    },
    canRecover: () => phase === 'recovering',
    hasJoined: () => phase === 'joined',
    setConnection: (next) => {
      connection = next;
    },
    open: vi.fn((onResumed) => {
      starts.push(Date.now());
      const close = vi.fn();
      const leave = vi.fn(async () => ({ ok: true }));
      const next = { resume, close, leave } as unknown as RoomConnection;
      attempts.push({ connection: next, onResumed, close, leave });
      return next;
    }),
    resumed: vi.fn(() => {
      phase = 'joined';
    }),
    retrying: vi.fn(),
    failed: vi.fn(() => {
      phase = 'lobby';
    }),
    ended: vi.fn(),
  };
  const recovery = new RecoveryController('room', host);
  recovery.remember('member', 'page-only-credential');
  controllers.push(recovery);
  return {
    host,
    recovery,
    resume,
    attempts,
    starts,
    setPhase: (next: string) => {
      phase = next;
    },
  };
}

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});

afterEach(() => {
  for (const controller of controllers.splice(0)) controller.cancel();
  vi.useRealTimers();
});

describe('RecoveryController', () => {
  it('owns the absolute 0/1/2/4-second schedule and expires at twenty seconds', async () => {
    const h = harness();
    h.recovery.start();
    await vi.advanceTimersByTimeAsync(4000);
    expect(h.starts).toEqual([0, 1000, 2000, 4000]);
    for (const attempt of h.attempts.slice(0, -1)) expect(attempt.close).toHaveBeenCalledOnce();
    expect(h.resume).toHaveBeenLastCalledWith({
      roomId: 'room',
      participantId: 'member',
      resumeCredential: 'page-only-credential',
    });
    await vi.advanceTimersByTimeAsync(16000);
    expect(h.host.connection).toBeNull();
    expect(h.host.failed).toHaveBeenCalledExactlyOnceWith(
      'The connection was gone too long. Join again.',
    );
    expect(h.recovery.hasCredential).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
    await vi.advanceTimersByTimeAsync(30000);
    expect(h.starts).toHaveLength(4);
  });

  it.each([
    ['server_busy', 'The live server is busy. Try again shortly.'],
    ['server_error', 'Unable to update the live room. Join again.'],
    ['rate_limited', 'Too many room commands. Try again shortly.'],
    ['already_connected', 'This participant is already connected.'],
    ['resume_lost', 'Another connection resumed this membership.'],
  ] as const)('retries %s without leaving a possible generation winner', async (error, message) => {
    const h = harness();
    h.resume
      .mockResolvedValueOnce({ ok: false, error, message: 'server sentence' })
      .mockResolvedValueOnce(success());
    h.recovery.start();
    await settle();
    expect(h.host.retrying).toHaveBeenCalledExactlyOnceWith(message);
    expect(h.host.connection).toBeNull();
    expect(h.attempts[0]!.leave).not.toHaveBeenCalled();
    expect(h.recovery.hasCredential).toBe(true);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.host.resumed).toHaveBeenCalledExactlyOnceWith(h.attempts[1]!.connection, success());
    expect(h.starts).toEqual([0, 1000]);
    expect(h.host.failed).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each([
    ['participant_not_found', 'The live room reset. Join again.'],
    ['invalid_resume', 'The connection was gone too long. Join again.'],
    ['resume_expired', 'The connection was gone too long. Join again.'],
    ['room_ended', 'This room has ended.'],
    ['stale_transport', 'The connection was gone too long. Join again.'],
  ] as const)('ends the budget on %s and drops the credential', async (error, message) => {
    const h = harness();
    h.resume.mockResolvedValueOnce({ ok: false, error, message: 'server sentence' });
    h.recovery.start();
    await settle();
    expect(h.host.failed).toHaveBeenCalledExactlyOnceWith(message);
    expect(h.recovery.hasCredential).toBe(false);
    expect(h.host.ended).toHaveBeenCalledTimes(error === 'room_ended' ? 1 : 0);
    expect(h.attempts[0]!.leave).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30000);
    expect(h.starts).toEqual([0]);
  });

  it('keeps the next selected time after a thrown resume', async () => {
    const h = harness();
    h.resume.mockRejectedValueOnce(new Error('transport')).mockResolvedValueOnce(success());
    h.recovery.start();
    await settle();
    expect(h.attempts[0]!.close).toHaveBeenCalledOnce();
    expect(h.host.connection).toBeNull();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.starts).toEqual([0, 1000]);
    expect(h.host.resumed).toHaveBeenCalledOnce();
  });

  it('applies a success delivered by both the callback and acknowledgement only once', async () => {
    const h = harness();
    h.resume.mockImplementationOnce(async () => {
      h.attempts[0]!.onResumed(success());
      return success();
    });
    h.recovery.start();
    await settle();
    expect(h.host.resumed).toHaveBeenCalledOnce();
    expect(h.attempts[0]!.leave).not.toHaveBeenCalled();
    expect(vi.getTimerCount()).toBe(0);
  });

  it('leaves an obsolete successful binding once while preserving a newer winner', async () => {
    const h = harness();
    const old = deferred<ResumeAck>();
    h.resume.mockReturnValueOnce(old.promise).mockResolvedValueOnce(success());
    h.recovery.start();
    await vi.advanceTimersByTimeAsync(1000);
    const winner = h.host.connection;
    h.attempts[0]!.onResumed(success());
    old.resolve(success());
    await settle();
    expect(h.attempts[0]!.leave).toHaveBeenCalledOnce();
    expect(h.attempts[1]!.leave).not.toHaveBeenCalled();
    expect(h.host.connection).toBe(winner);
    expect(h.host.resumed).toHaveBeenCalledOnce();
    expect(h.host.failed).not.toHaveBeenCalled();
  });

  it('ignores a superseded generation-lost reply after a newer success', async () => {
    const h = harness();
    const old = deferred<ResumeAck>();
    h.resume.mockReturnValueOnce(old.promise).mockResolvedValueOnce(success());
    h.recovery.start();
    await vi.advanceTimersByTimeAsync(1000);
    const winner = h.host.connection;
    old.resolve({ ok: false, error: 'resume_lost', message: 'loser' });
    await settle();
    expect(h.host.connection).toBe(winner);
    expect(h.host.retrying).not.toHaveBeenCalled();
    expect(h.attempts[0]!.leave).not.toHaveBeenCalled();
  });

  it('deduplicates leave across explicit cancellation and repeated late successes', async () => {
    const h = harness();
    const pending = deferred<ResumeAck>();
    h.resume.mockReturnValueOnce(pending.promise);
    h.recovery.start();
    const active = h.attempts[0]!.connection;
    const leave = h.recovery.requestLeave(active);
    expect(h.recovery.requestLeave(active)).toBe(leave);
    h.recovery.cancel();
    h.setPhase('lobby');
    h.host.setConnection(null);
    h.attempts[0]!.onResumed(success());
    pending.resolve(success());
    await settle();
    expect(h.attempts[0]!.leave).toHaveBeenCalledOnce();
    expect(h.host.resumed).not.toHaveBeenCalled();
    expect(h.host.failed).not.toHaveBeenCalled();
    expect(h.recovery.hasCredential).toBe(false);
    expect(vi.getTimerCount()).toBe(0);
  });

  it('rejects a success beyond the deadline even when the grace timer has not run', async () => {
    const h = harness();
    const pending = deferred<ResumeAck>();
    h.resume.mockReturnValueOnce(pending.promise);
    h.recovery.start();
    vi.setSystemTime(21000);
    pending.resolve(success());
    await settle();
    expect(h.host.resumed).not.toHaveBeenCalled();
    expect(h.attempts[0]!.leave).toHaveBeenCalledOnce();
    expect(h.host.failed).toHaveBeenCalledExactlyOnceWith(
      'The connection was gone too long. Join again.',
    );
    expect(vi.getTimerCount()).toBe(0);
  });

  it('does not open a selected retry after a delayed event loop crosses the deadline', async () => {
    const h = harness();
    h.recovery.start();
    vi.setSystemTime(21000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.starts).toEqual([0]);
    expect(h.host.failed).toHaveBeenCalledOnce();
  });

  it('keeps credentials only when cancellation explicitly preserves them', () => {
    const h = harness();
    h.recovery.start();
    h.recovery.cancel(false);
    expect(h.recovery.hasCredential).toBe(true);
    expect(vi.getTimerCount()).toBe(0);
    h.recovery.cancel();
    expect(h.recovery.hasCredential).toBe(false);
    h.recovery.remember('member');
    expect(h.recovery.hasCredential).toBe(false);
  });
});
