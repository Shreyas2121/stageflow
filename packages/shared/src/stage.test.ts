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
    hands: [],
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
  Object.freeze(state.hands);
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
    let state = step(empty('WEBINAR'), { ...join('z'), isSyntheticBot: true } as StageCommand);
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
    const state = step(empty('WEBINAR'), { ...join('guest'), ...flags } as StageCommand);
    expect(state.participants[0]).toMatchObject({
      role: 'ATTENDEE',
      isAudioMuted: true,
      isVideoOff: true,
      isScreenSharing: false,
      isSyntheticBot: flags.isSyntheticBot,
    });
    expect(state.stageParticipantIds).toEqual([]);
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
      } as Extract<StageCommand, { actorParticipantId: string }>;
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
