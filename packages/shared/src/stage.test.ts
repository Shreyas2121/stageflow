import { describe, expect, it } from 'vitest';
import {
  applyStageCommand,
  connectedStageIds,
  type LiveState,
  type StageCommand,
  type StageError,
} from './stage';
import { canRelay, meshPeers } from './negotiation';

function empty(mode: LiveState['mode'] = 'MEETING'): LiveState {
  return {
    roomId: 'room',
    hostId: 'host',
    mode,
    status: 'LIVE',
    participants: [],
    stageParticipantIds: [],
    waitingParticipantIds: [],
    hands: [],
    resumeDigests: {},
    deadlines: {},
  };
}

function join(id: string, userId = id): StageCommand {
  return {
    type: 'join',
    participantId: id,
    socketId: `socket-${id}`,
    userId,
    displayName: id,
    isAudioMuted: false,
    isVideoOff: false,
    isSyntheticBot: false,
    joinedAt: 1000,
  };
}

// Freeze every input so successful and rejected transitions both prove immutability.
function run(state: LiveState, command: StageCommand) {
  for (const participant of state.participants) Object.freeze(participant);
  for (const hand of state.hands) Object.freeze(hand);
  Object.freeze(state.participants);
  Object.freeze(state.stageParticipantIds);
  Object.freeze(state.waitingParticipantIds);
  Object.freeze(state.hands);
  Object.freeze(state.deadlines);
  Object.freeze(state.resumeDigests);
  Object.freeze(state);
  const before = structuredClone(state);
  const result = applyStageCommand(state, command);
  expect(state).toEqual(before);
  return result;
}

function step(state: LiveState, command: StageCommand): LiveState {
  const result = run(state, command);
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.error);
  expect(result.state).not.toBe(state);
  return result.state;
}

function rejects(state: LiveState, command: StageCommand, error: StageError) {
  expect(run(state, command)).toEqual({ ok: false, error });
}

describe('scheduled membership', () => {
  it.each(['MEETING', 'WEBINAR'] as const)(
    'waits off stage in arrival/id order before the %s host arrives',
    (mode) => {
      let state: LiveState = { ...empty(mode), status: 'SCHEDULED' };
      for (const [id, joinedAt] of [
        ['late', 2000],
        ['b', 1000],
        ['a', 1000],
      ] as const) {
        state = step(state, {
          ...join(id),
          joinedAt,
          resumeDigest: `digest-${id}`,
        } as StageCommand);
      }
      state = step(state, { ...join('host'), resumeDigest: 'digest-host' } as StageCommand);
      expect(state.waitingParticipantIds).toEqual(['a', 'b', 'late']);
      expect(state.stageParticipantIds).toEqual([]);
      expect(state.resumeDigests).toEqual({});
      expect(state.deadlines).toEqual({});
      expect(
        state.participants.every((p) => p.isAudioMuted && p.isVideoOff && !p.isScreenSharing),
      ).toBe(true);
      expect(state.participants.find((p) => p.participantId === 'host')?.role).toBe('HOST');
      expect(state.participants.filter((p) => p.role === 'WAITING')).toHaveLength(3);
      rejects(
        state,
        { type: 'patchMedia', participantId: 'a', patch: { isAudioMuted: false } },
        'not_on_stage',
      );
      rejects(
        state,
        { type: 'patchMedia', participantId: 'host', patch: { isVideoOff: false } },
        'not_on_stage',
      );
      rejects(
        state,
        { type: 'setHand', participantId: 'a', raised: true, raisedAt: 3000 },
        'not_attendee',
      );
      expect(meshPeers('a', connectedStageIds(state))).toEqual([]);
      expect(canRelay(connectedStageIds(state), 'a', 'host')).toBe(false);
      state = step(state, { type: 'leave', participantId: 'host' });
      expect(state.status).toBe('SCHEDULED');
      expect(state.waitingParticipantIds).toEqual(['a', 'b', 'late']);
      state = step(state, { type: 'suspend', participantId: 'a', now: 3000 });
      expect(state.participants.some((p) => p.participantId === 'a')).toBe(false);
      state = step(state, { ...join('rejoined', 'a'), joinedAt: 4000 } as StageCommand);
      expect(state.waitingParticipantIds).toEqual(['b', 'late', 'rejoined']);
      expect(state.deadlines).toEqual({});
    },
  );

  it('caps only waiters at 100 and permits a host to arrive and drop without grace', () => {
    let state: LiveState = { ...empty(), status: 'SCHEDULED' };
    for (let index = 0; index < 100; index++) state = step(state, join(`guest-${index}`));
    rejects(state, join('overflow'), 'waiting_full');
    state = step(state, join('host'));
    state = step(state, { type: 'suspend', participantId: 'host', now: 2000 });
    expect(state.status).toBe('SCHEDULED');
    expect(state.participants).toHaveLength(100);
    expect(state.waitingParticipantIds).toHaveLength(100);
    expect(state.deadlines).toEqual({});
    rejects(state, join('live-guest'), 'waiting_full');
  });
});

function webinar() {
  let state = step(empty('WEBINAR'), join('host'));
  for (const id of ['c', 'b', 'a', 'd']) state = step(state, join(id));
  return state;
}

const promote = (id: string): StageCommand => ({
  type: 'promote',
  actorParticipantId: 'host',
  targetParticipantId: id,
});
const hand = (id: string, raisedAt = 2000): StageCommand => ({
  type: 'setHand',
  participantId: id,
  raised: true,
  raisedAt,
});

function resumable(mode: LiveState['mode'] = 'MEETING') {
  let state = step(empty(mode), { ...join('host'), resumeDigest: 'host-digest' } as StageCommand);
  state = step(state, { ...join('a'), resumeDigest: 'guest-digest' } as StageCommand);
  return state;
}
const resumeGuest = (now = 2001): StageCommand => ({
  type: 'resume',
  participantId: 'a',
  userId: 'a',
  socketId: 'new-a',
  resumeDigest: 'guest-digest',
  expectedGeneration: 1,
  now,
});

it('resumes within grace to the same locked membership with media off and a higher generation', () => {
  let state = resumable('WEBINAR');
  state = step(state, hand('a'));
  state = step(state, {
    type: 'setHostLock',
    actorParticipantId: 'host',
    targetParticipantId: 'a',
    kind: 'audio',
    locked: true,
  });
  const before = state.participants.find((p) => p.participantId === 'a')!;
  state = step(state, { type: 'suspend', participantId: 'a', now: 2000 });
  expect(state.deadlines.a).toBe(22000);
  state = step(state, resumeGuest());
  expect(state.participants.find((p) => p.participantId === 'a')).toEqual({
    ...before,
    socketId: 'new-a',
    connectionGeneration: 2,
  });
  expect(state.deadlines).toEqual({});
  expect(state.hands).toEqual([{ participantId: 'a', raisedAt: 2000 }]);
  rejects(state, resumeGuest(), 'resume_lost');
  rejects(state, { ...resumeGuest(), expectedGeneration: 2 } as StageCommand, 'already_connected');
  rejects(
    state,
    {
      type: 'leave',
      participantId: 'a',
      transport: { participantId: 'a', socketId: 'socket-a', generation: 1 },
    },
    'stale_transport',
  );
  expect(step(state, { type: 'expire', now: 99999 }).participants).toEqual(state.participants);
});

it('expires at the exact deadline, removes the verifier, and prevents an overdue resume', () => {
  let state = step(resumable(), { type: 'suspend', participantId: 'a', now: 2000 });
  expect(step(state, { type: 'expire', now: 21999 }).participants).toHaveLength(2);
  const expired = run(state, resumeGuest(22000));
  expect(expired).toMatchObject({ ok: false, error: 'resume_expired', expiry: { changed: true } });
  if (expired.ok || !expired.expiry) throw new Error('Expected expiry.');
  state = expired.expiry.state;
  expect(state.participants.map((p) => p.participantId)).toEqual(['host']);
  expect(state.resumeDigests).toEqual({ host: 'host-digest' });
  expect(state.deadlines).toEqual({});
  rejects(state, resumeGuest(22001), 'participant_not_found');
});

it('clears synthetic members on host suspension and ends the room only at host expiry', () => {
  let state = step(resumable(), { ...join('bot'), isSyntheticBot: true } as StageCommand);
  state = step(state, { type: 'suspend', participantId: 'host', now: 2000 });
  expect(state.status).toBe('LIVE');
  expect(state.participants.map((p) => p.participantId)).toEqual(['a', 'host']);
  const ended = step(state, { type: 'expire', now: 22000 });
  expect(ended.status).toBe('ENDED');
  expect(ended.resumeDigests).toEqual({});
  expect(ended.deadlines).toEqual({});
  expect(ended.participants).toEqual([]);
});

it('sorts membership and hands by participant id independently of socket ordering', () => {
  let state = step(empty('WEBINAR'), { ...join('z'), socketId: 'socket-a' } as StageCommand);
  state = step(state, { ...join('a'), socketId: 'socket-z' } as StageCommand);
  state = step(step(state, hand('z')), hand('a'));
  expect(state.participants.map((p) => p.participantId)).toEqual(['a', 'z']);
  expect(state.hands.map((h) => h.participantId)).toEqual(['a', 'z']);
});

it('keeps a suspended stage reservation within the cap and outside the relay mesh', () => {
  let state = step(empty(), join('host'));
  for (const id of ['a', 'b', 'c']) state = step(state, join(id));
  const before = state.participants.find((p) => p.participantId === 'a')!;
  state = step(state, { type: 'suspend', participantId: 'a' });
  expect(state.participants.find((p) => p.participantId === 'a')).toEqual({
    ...before,
    socketId: null,
    presence: 'suspended',
    isAudioMuted: true,
    isVideoOff: true,
    isScreenSharing: false,
  });
  expect(state.stageParticipantIds).toEqual(['a', 'b', 'c', 'host']);
  rejects(state, join('fifth'), 'stage_full');
  const connected = connectedStageIds(state);
  expect(connected).toEqual(['b', 'c', 'host']);
  expect(meshPeers('host', connected)).toEqual(['b', 'c']);
  expect(meshPeers('a', connected)).toEqual([]);
  expect(canRelay(connected, 'host', 'a')).toBe(false);
});

it('rejects promotion of a suspended attendee while preserving the hand and join order', () => {
  let state = step(webinar(), hand('a'));
  const before = state.participants.find((p) => p.participantId === 'a')!;
  state = step(state, { type: 'suspend', participantId: 'a' });
  rejects(state, promote('a'), 'not_connected');
  expect(state.hands).toEqual([{ participantId: 'a', raisedAt: 2000 }]);
  expect(state.participants.find((p) => p.participantId === 'a')).toMatchObject({
    joinedAt: before.joinedAt,
    isHandRaised: true,
    socketId: null,
    connectionGeneration: 1,
  });
});

it('demotes a suspended speaker, freeing the slot while retaining the membership', () => {
  let state = webinar();
  for (const id of ['a', 'b', 'c']) state = step(state, promote(id));
  state = step(state, { type: 'suspend', participantId: 'a' });
  state = step(state, { type: 'demote', actorParticipantId: 'host', targetParticipantId: 'a' });
  expect(state.stageParticipantIds).toEqual(['b', 'c', 'host']);
  expect(state.participants.find((p) => p.participantId === 'a')).toMatchObject({
    role: 'ATTENDEE',
    presence: 'suspended',
    socketId: null,
  });
  state = step(state, promote('d'));
  expect(state.stageParticipantIds).toHaveLength(4);
});

describe('applyStageCommand', () => {
  it('reserves a meeting for the host and assigns host and speaker roles', () => {
    rejects(empty(), join('guest'), 'host_not_present');
    const host = step(empty(), join('host'));
    expect(host.stageParticipantIds).toEqual(['host']);
    expect(host.participants[0]).toEqual({
      participantId: 'host',
      socketId: 'socket-host',
      connectionGeneration: 1,
      presence: 'connected',
      userId: 'host',
      displayName: 'host',
      role: 'HOST',
      joinedAt: 1000,
      isAudioMuted: false,
      isVideoOff: false,
      isSyntheticBot: false,
      isScreenSharing: false,
      isHandRaised: false,
      hostAudioLocked: false,
      hostVideoLocked: false,
    });
    const state = step(host, join('guest'));
    expect(state.participants.map((p) => p.role)).toEqual(['SPEAKER', 'HOST']);
    expect(state.stageParticipantIds).toEqual(['guest', 'host']);
  });

  it('rejects a fifth stage member and the same user on a new socket', () => {
    let state = step(empty(), join('host'));
    for (const id of ['z', 'b', 'a']) state = step(state, join(id));
    rejects(state, join('fifth'), 'stage_full');
    rejects(state, join('new-socket', 'host'), 'already_joined');
    rejects(state, join('a', 'different-user'), 'already_joined');
    expect(state.stageParticipantIds).toEqual(['a', 'b', 'host', 'z']);
  });

  it('admits webinar attendees before and after the host, without granting stage access to bots', () => {
    rejects(
      empty('WEBINAR'),
      { ...join('z'), isSyntheticBot: true } as StageCommand,
      'demo_not_ready',
    );
    let state = step(empty('WEBINAR'), join('z'));
    expect(state.participants[0]?.role).toBe('ATTENDEE');
    expect(state.stageParticipantIds).toEqual([]);
    state = step(step(state, join('host')), join('a'));
    expect(state.participants.map((p) => p.role)).toEqual(['ATTENDEE', 'HOST', 'ATTENDEE']);
    expect(state.stageParticipantIds).toEqual(['host']);
  });

  it.each(
    [false, true].flatMap((isAudioMuted) =>
      [false, true].flatMap((isVideoOff) =>
        [false, true].map((isSyntheticBot) => ({ isAudioMuted, isVideoOff, isSyntheticBot })),
      ),
    ),
  )('normalizes attendee joins with requested flags %j', (flags) => {
    const state = step(step(empty('WEBINAR'), join('host')), {
      ...join('guest'),
      ...flags,
    } as StageCommand);
    expect(state.participants[0]).toMatchObject({
      role: 'ATTENDEE',
      isAudioMuted: true,
      isVideoOff: true,
      isScreenSharing: false,
      isSyntheticBot: flags.isSyntheticBot,
    });
    expect(state.stageParticipantIds).toEqual(['host']);
  });

  it.each([
    { isAudioMuted: false },
    { isVideoOff: false },
    { isScreenSharing: true },
    { isAudioMuted: true, isVideoOff: false, isScreenSharing: false },
  ])('rejects active off-stage flags atomically: %j', (patch) => {
    rejects(
      step(webinar(), hand('a')),
      { type: 'patchMedia', participantId: 'a', patch },
      'not_on_stage',
    );
  });

  it.each([
    {},
    { isAudioMuted: true },
    { isVideoOff: true },
    { isScreenSharing: false },
    { isAudioMuted: true, isVideoOff: true, isScreenSharing: false },
  ])('keeps safe attendee patch %j idempotent', (patch) => {
    const state = step(webinar(), hand('a'));
    expect(run(state, { type: 'patchMedia', participantId: 'a', patch })).toMatchObject({
      ok: true,
      changed: false,
      state,
    });
  });

  it('repairs legacy off-stage flags through a safe patch without granting membership or changing identity/hand/locks', () => {
    const state = step(webinar(), hand('a'));
    const legacy = {
      ...state,
      participants: state.participants.map((p) =>
        p.participantId === 'a'
          ? {
              ...p,
              isAudioMuted: false,
              isVideoOff: false,
              isScreenSharing: true,
              isSyntheticBot: true,
              hostAudioLocked: true,
            }
          : { ...p },
      ),
    };
    const repaired = run(legacy, { type: 'patchMedia', participantId: 'a', patch: {} });
    expect(repaired).toMatchObject({ ok: true, changed: true });
    if (!repaired.ok) throw new Error(repaired.error);
    expect(repaired.state.participants.find((p) => p.participantId === 'a')).toEqual({
      ...legacy.participants.find((p) => p.participantId === 'a'),
      isAudioMuted: true,
      isVideoOff: true,
      isScreenSharing: false,
    });
    expect(repaired.state.stageParticipantIds).toEqual(state.stageParticipantIds);
    expect(repaired.state.hands).toEqual(state.hands);
    expect(
      run(repaired.state, { type: 'patchMedia', participantId: 'a', patch: {} }),
    ).toMatchObject({
      ok: true,
      changed: false,
    });
  });

  it('rejects joins to ended rooms', () => {
    rejects({ ...empty(), status: 'ENDED' }, join('host'), 'room_ended');
  });

  it('leaves unknown sockets without a revision bump and removes all memberships on leave', () => {
    expect(run(empty(), { type: 'leave', participantId: 'missing' })).toMatchObject({
      ok: true,
      changed: false,
      roomEnded: false,
    });
    let state = step(webinar(), hand('a'));
    state = step(state, promote('a'));
    expect(state.hands).toEqual([]);
    state = step(state, { type: 'leave', participantId: 'a' });
    expect(state.participants.some((p) => p.participantId === 'a')).toBe(false);
    expect(state.stageParticipantIds).toEqual(['host']);
    state = step(step(state, hand('b')), { type: 'leave', participantId: 'b' });
    expect(state.hands).toEqual([]);
  });

  it('ends and empties a room when the host leaves', () => {
    const result = run(step(webinar(), hand('a')), { type: 'leave', participantId: 'host' });
    expect(result).toMatchObject({
      ok: true,
      changed: true,
      roomEnded: true,
      state: { status: 'ENDED', participants: [], stageParticipantIds: [], hands: [] },
    });
  });

  it('reports room shutdown again after the host participant is gone', () => {
    const ended = step(step(empty(), join('host')), { type: 'leave', participantId: 'host' });
    expect(run(ended, { type: 'leave', participantId: 'host' })).toMatchObject({
      ok: true,
      changed: false,
      roomEnded: true,
      state: { status: 'ENDED', participants: [], stageParticipantIds: [], hands: [] },
    });
    expect(run(ended, { type: 'leave', participantId: 'guest' })).toMatchObject({
      ok: true,
      changed: false,
      roomEnded: true,
    });
    rejects(ended, join('late'), 'room_ended');
  });

  it('orders hands by timestamp then socket id, preserves repeated raises, and rejects non-attendees', () => {
    let state = step(step(step(webinar(), hand('c', 3000)), hand('b')), hand('a'));
    expect(state.hands.map((h) => h.participantId)).toEqual(['a', 'b', 'c']);
    expect(run(state, hand('a', 9000))).toMatchObject({ ok: true, changed: false, state });
    state = step(state, { type: 'setHand', participantId: 'a', raised: false, raisedAt: 4000 });
    expect(state.participants.find((p) => p.participantId === 'a')?.isHandRaised).toBe(false);
    state = step(state, promote('b'));
    rejects(state, hand('b'), 'not_attendee');
    rejects(state, hand('host'), 'not_attendee');
    rejects(state, hand('missing'), 'participant_not_found');
  });

  it('promotes into the fourth slot, clears hands, and rejects a full stage', () => {
    let state = step(step(step(webinar(), promote('a')), promote('b')), hand('c'));
    state = step(state, promote('c'));
    expect(state.stageParticipantIds).toEqual(['a', 'b', 'c', 'host']);
    expect(state.hands).toEqual([]);
    expect(state.participants.find((p) => p.participantId === 'c')).toMatchObject({
      role: 'SPEAKER',
      isHandRaised: false,
    });
    rejects(state, promote('d'), 'stage_full');
    rejects(state, promote('a'), 'not_attendee');
  });

  it('requires a host actor and an existing target for moderation', () => {
    for (const type of ['promote', 'demote', 'setHostLock'] as const) {
      const command = {
        type,
        actorParticipantId: 'a',
        targetParticipantId: 'b',
        kind: 'audio',
        locked: true,
      } as Extract<StageCommand, { targetParticipantId: string }>;
      rejects(webinar(), command, 'not_host');
      rejects(webinar(), { ...command, actorParticipantId: 'missing' }, 'not_host');
      rejects(
        webinar(),
        { ...command, actorParticipantId: 'host', targetParticipantId: 'missing' },
        'participant_not_found',
      );
    }
  });

  it('demotes a speaker without raising a hand and never demotes the host', () => {
    const command: StageCommand = {
      type: 'demote',
      actorParticipantId: 'host',
      targetParticipantId: 'a',
    };
    rejects(webinar(), { ...command, targetParticipantId: 'host' }, 'cannot_demote_host');
    rejects(webinar(), command, 'not_speaker');
    const active = step(step(webinar(), promote('a')), {
      type: 'patchMedia',
      participantId: 'a',
      patch: { isAudioMuted: false, isVideoOff: false, isScreenSharing: true },
    });
    const state = step(active, command);
    expect(state.participants.find((p) => p.participantId === 'a')).toMatchObject({
      role: 'ATTENDEE',
      isHandRaised: false,
      isAudioMuted: true,
      isVideoOff: true,
      isScreenSharing: false,
    });
    expect(state.stageParticipantIds).toEqual(['host']);
    expect(state.hands).toEqual([]);
  });

  it.each(['audio', 'video'] as const)(
    'forces %s off while locked and leaves it off after unlocking',
    (kind) => {
      const flag = kind === 'audio' ? 'isAudioMuted' : 'isVideoOff';
      const lock: StageCommand = {
        type: 'setHostLock',
        actorParticipantId: 'host',
        targetParticipantId: 'a',
        kind,
        locked: true,
      };
      let state = step(step(webinar(), promote('a')), lock);
      const patch: StageCommand = {
        type: 'patchMedia',
        participantId: 'a',
        patch: { [flag]: false, isScreenSharing: true },
      };
      rejects(state, patch, kind === 'audio' ? 'audio_locked' : 'video_locked');
      expect(run(state, lock)).toMatchObject({ ok: true, changed: false });
      state = step(state, { ...lock, locked: false });
      expect(state.participants.find((p) => p.participantId === 'a')?.[flag]).toBe(true);
      state = step(state, patch);
      expect(state.participants.find((p) => p.participantId === 'a')).toMatchObject({
        [flag]: false,
        isScreenSharing: true,
      });
    },
  );

  it('patches only supplied media flags and avoids bumps for unchanged values', () => {
    let state = step(step(webinar(), promote('a')), {
      type: 'patchMedia',
      participantId: 'a',
      patch: { isAudioMuted: false, isVideoOff: false },
    });
    rejects(
      state,
      { type: 'patchMedia', participantId: 'missing', patch: {} },
      'participant_not_found',
    );
    expect(run(state, { type: 'patchMedia', participantId: 'a', patch: {} })).toMatchObject({
      ok: true,
      changed: false,
    });
    state = step(state, { type: 'patchMedia', participantId: 'a', patch: { isAudioMuted: true } });
    expect(state.participants.find((p) => p.participantId === 'a')).toMatchObject({
      isAudioMuted: true,
      isVideoOff: false,
    });
    expect(
      run(state, { type: 'patchMedia', participantId: 'a', patch: { isAudioMuted: true } }),
    ).toMatchObject({ ok: true, changed: false });
  });
});

describe('scheduled stage commands', () => {
  it('seats leftover waiters before rejecting a newcomer at capacity', () => {
    let state: LiveState = { ...empty(), status: 'SCHEDULED', requireAdmission: true };
    for (const id of ['host', 'a', 'b', 'c', 'd']) state = step(state, join(id));
    state = step(state, { type: 'start', actorParticipantId: 'host' });
    // Seed the partially filled automatic-admission state the join rule must repair.
    state = { ...state, requireAdmission: false };
    const result = run(state, join('new'));
    expect(result).toMatchObject({
      ok: false,
      error: 'stage_full',
      expiry: {
        state: { stageParticipantIds: ['a', 'b', 'c', 'host'], waitingParticipantIds: ['d'] },
      },
    });
  });

  it('starts with the host and oldest three; frees a real seat before filling a waiter', () => {
    let state = { ...empty(), status: 'SCHEDULED' as const } as LiveState;
    for (const id of ['e', 'd', 'c', 'b', 'a'])
      state = step(state, { ...join(id), joinedAt: id.charCodeAt(0) } as StageCommand);
    state = step(state, join('host'));
    rejects(state, { ...join('bot'), isSyntheticBot: true } as StageCommand, 'demo_not_ready');
    rejects(state, { type: 'start', actorParticipantId: 'a' }, 'not_host');
    state = step(state, { type: 'start', actorParticipantId: 'host' });
    expect(state.status).toBe('LIVE');
    expect(state.stageParticipantIds).toEqual(['a', 'b', 'c', 'host']);
    expect(state.waitingParticipantIds).toEqual(['d', 'e']);
    rejects(state, { type: 'start', actorParticipantId: 'host' }, 'already_started');
    state = step(state, { type: 'suspend', participantId: 'a', now: 1000 });
    expect(state.stageParticipantIds).toHaveLength(4);
    expect(state.waitingParticipantIds).toEqual(['d', 'e']);
    state = step(state, { type: 'leave', participantId: 'b' });
    expect(state.stageParticipantIds).toEqual(['a', 'c', 'd', 'host']);
    expect(state.participants.find((p) => p.participantId === 'd')).toMatchObject({
      role: 'SPEAKER',
      isAudioMuted: true,
      isVideoOff: true,
    });
    state = step(state, { type: 'expire', now: 21000 });
    expect(state.stageParticipantIds).toEqual(['c', 'd', 'e', 'host']);
  });

  it('requires Admit when enabled, preserves a full waiter, and Remove seats nobody', () => {
    let state: LiveState = { ...empty(), status: 'SCHEDULED', requireAdmission: true };
    for (const id of ['host', 'a', 'b', 'c', 'd']) state = step(state, join(id));
    state = step(state, { type: 'start', actorParticipantId: 'host' });
    expect(state.stageParticipantIds).toEqual(['host']);
    state = step(state, join('e'));
    expect(state.waitingParticipantIds).toEqual(['a', 'b', 'c', 'd', 'e']);
    expect(state.resumeDigests).toEqual({});
    for (const id of ['a', 'b', 'c'])
      state = step(state, { type: 'admit', actorParticipantId: 'host', targetParticipantId: id });
    rejects(
      state,
      { type: 'admit', actorParticipantId: 'host', targetParticipantId: 'd' },
      'stage_full',
    );
    state = step(state, { type: 'leave', participantId: 'a' });
    expect(state.stageParticipantIds).toHaveLength(3);
    state = step(state, {
      type: 'removeWaiter',
      actorParticipantId: 'host',
      targetParticipantId: 'd',
    });
    expect(state.stageParticipantIds).toHaveLength(3);
    rejects(
      state,
      { type: 'admit', actorParticipantId: 'host', targetParticipantId: 'd' },
      'not_waiting',
    );
    state = step(state, { type: 'suspend', participantId: 'e', now: 2000 });
    expect(state.participants.some((p) => p.participantId === 'e')).toBe(false);
    expect(state.deadlines.e).toBeUndefined();
  });

  it('releases webinar attendees and cancels only a scheduled room', () => {
    let state: LiveState = { ...empty('WEBINAR'), status: 'SCHEDULED' };
    for (const id of ['a', 'b', 'host']) state = step(state, join(id));
    const cancelled = step(state, { type: 'cancel', actorParticipantId: 'host' });
    expect(cancelled).toMatchObject({
      status: 'ENDED',
      participants: [],
      stageParticipantIds: [],
      waitingParticipantIds: [],
    });
    state = step(state, { type: 'start', actorParticipantId: 'host' });
    expect(state.stageParticipantIds).toEqual(['host']);
    expect(state.waitingParticipantIds).toEqual([]);
    expect(state.participants.filter((p) => p.role === 'ATTENDEE')).toHaveLength(2);
    rejects(state, { type: 'cancel', actorParticipantId: 'host' }, 'not_scheduled');
    rejects(
      state,
      { type: 'admit', actorParticipantId: 'host', targetParticipantId: 'a' },
      'admission_off',
    );
  });
});
