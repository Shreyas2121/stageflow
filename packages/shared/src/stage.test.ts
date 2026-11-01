import { describe, expect, it } from 'vitest';
import { applyStageCommand, type LiveState, type StageCommand, type StageError } from './stage';

function empty(mode: LiveState['mode'] = 'MEETING'): LiveState {
  return {
    roomId: 'room',
    hostId: 'host',
    mode,
    status: 'LIVE',
    participants: [],
    stageSocketIds: [],
    hands: [],
  };
}

function join(id: string, userId = id): StageCommand {
  return {
    type: 'join',
    socketId: id,
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
  Object.freeze(state.stageSocketIds);
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
  actorSocketId: 'host',
  targetSocketId: id,
});
const hand = (id: string, raisedAt = 2000): StageCommand => ({
  type: 'setHand',
  socketId: id,
  raised: true,
  raisedAt,
});

describe('applyStageCommand', () => {
  it('reserves a meeting for the host and assigns host and speaker roles', () => {
    rejects(empty(), join('guest'), 'host_not_present');
    const host = step(empty(), join('host'));
    expect(host.stageSocketIds).toEqual(['host']);
    expect(host.participants[0]).toEqual({
      socketId: 'host',
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
    expect(state.stageSocketIds).toEqual(['guest', 'host']);
  });

  it('rejects a fifth stage member and the same user on a new socket', () => {
    let state = step(empty(), join('host'));
    for (const id of ['z', 'b', 'a']) state = step(state, join(id));
    rejects(state, join('fifth'), 'stage_full');
    rejects(state, join('new-socket', 'host'), 'already_joined');
    rejects(state, join('a', 'different-user'), 'already_joined');
    expect(state.stageSocketIds).toEqual(['a', 'b', 'host', 'z']);
  });

  it('admits webinar attendees before and after the host, without granting stage access to bots', () => {
    let state = step(empty('WEBINAR'), { ...join('z'), isSyntheticBot: true } as StageCommand);
    expect(state.participants[0]?.role).toBe('ATTENDEE');
    expect(state.stageSocketIds).toEqual([]);
    state = step(step(state, join('host')), join('a'));
    expect(state.participants.map((p) => p.role)).toEqual(['ATTENDEE', 'HOST', 'ATTENDEE']);
    expect(state.stageSocketIds).toEqual(['host']);
  });

  it('rejects joins to ended rooms', () => {
    rejects({ ...empty(), status: 'ENDED' }, join('host'), 'room_ended');
  });

  it('leaves unknown sockets without a revision bump and removes all memberships on leave', () => {
    expect(run(empty(), { type: 'leave', socketId: 'missing' })).toMatchObject({
      ok: true,
      changed: false,
      roomEnded: false,
    });
    let state = step(webinar(), hand('a'));
    state = step(state, promote('a'));
    expect(state.hands).toEqual([]);
    state = step(state, { type: 'leave', socketId: 'a' });
    expect(state.participants.some((p) => p.socketId === 'a')).toBe(false);
    expect(state.stageSocketIds).toEqual(['host']);
    state = step(step(state, hand('b')), { type: 'leave', socketId: 'b' });
    expect(state.hands).toEqual([]);
  });

  it('ends and empties a room when the host leaves', () => {
    const result = run(step(webinar(), hand('a')), { type: 'leave', socketId: 'host' });
    expect(result).toMatchObject({
      ok: true,
      changed: true,
      roomEnded: true,
      state: { status: 'ENDED', participants: [], stageSocketIds: [], hands: [] },
    });
  });

  it('orders hands by timestamp then socket id, preserves repeated raises, and rejects non-attendees', () => {
    let state = step(step(step(webinar(), hand('c', 3000)), hand('b')), hand('a'));
    expect(state.hands.map((h) => h.socketId)).toEqual(['a', 'b', 'c']);
    expect(run(state, hand('a', 9000))).toMatchObject({ ok: true, changed: false, state });
    state = step(state, { type: 'setHand', socketId: 'a', raised: false, raisedAt: 4000 });
    expect(state.participants.find((p) => p.socketId === 'a')?.isHandRaised).toBe(false);
    state = step(state, promote('b'));
    rejects(state, hand('b'), 'not_attendee');
    rejects(state, hand('host'), 'not_attendee');
    rejects(state, hand('missing'), 'participant_not_found');
  });

  it('promotes into the fourth slot, clears hands, and rejects a full stage', () => {
    let state = step(step(step(webinar(), promote('a')), promote('b')), hand('c'));
    state = step(state, promote('c'));
    expect(state.stageSocketIds).toEqual(['a', 'b', 'c', 'host']);
    expect(state.hands).toEqual([]);
    expect(state.participants.find((p) => p.socketId === 'c')).toMatchObject({
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
        actorSocketId: 'a',
        targetSocketId: 'b',
        kind: 'audio',
        locked: true,
      } as Extract<StageCommand, { actorSocketId: string }>;
      rejects(webinar(), command, 'not_host');
      rejects(webinar(), { ...command, actorSocketId: 'missing' }, 'not_host');
      rejects(
        webinar(),
        { ...command, actorSocketId: 'host', targetSocketId: 'missing' },
        'participant_not_found',
      );
    }
  });

  it('demotes a speaker without raising a hand and never demotes the host', () => {
    const command: StageCommand = { type: 'demote', actorSocketId: 'host', targetSocketId: 'a' };
    rejects(webinar(), { ...command, targetSocketId: 'host' }, 'cannot_demote_host');
    rejects(webinar(), command, 'not_speaker');
    const state = step(step(webinar(), promote('a')), command);
    expect(state.participants.find((p) => p.socketId === 'a')).toMatchObject({
      role: 'ATTENDEE',
      isHandRaised: false,
    });
    expect(state.stageSocketIds).toEqual(['host']);
    expect(state.hands).toEqual([]);
  });

  it.each(['audio', 'video'] as const)(
    'forces %s off while locked and leaves it off after unlocking',
    (kind) => {
      const flag = kind === 'audio' ? 'isAudioMuted' : 'isVideoOff';
      const lock: StageCommand = {
        type: 'setHostLock',
        actorSocketId: 'host',
        targetSocketId: 'a',
        kind,
        locked: true,
      };
      let state = step(webinar(), lock);
      const patch: StageCommand = {
        type: 'patchMedia',
        socketId: 'a',
        patch: { [flag]: false, isScreenSharing: true },
      };
      rejects(state, patch, kind === 'audio' ? 'audio_locked' : 'video_locked');
      expect(run(state, lock)).toMatchObject({ ok: true, changed: false });
      state = step(state, { ...lock, locked: false });
      expect(state.participants.find((p) => p.socketId === 'a')?.[flag]).toBe(true);
      state = step(state, patch);
      expect(state.participants.find((p) => p.socketId === 'a')).toMatchObject({
        [flag]: false,
        isScreenSharing: true,
      });
    },
  );

  it('patches only supplied media flags and avoids bumps for unchanged values', () => {
    let state = webinar();
    rejects(state, { type: 'patchMedia', socketId: 'missing', patch: {} }, 'participant_not_found');
    expect(run(state, { type: 'patchMedia', socketId: 'a', patch: {} })).toMatchObject({
      ok: true,
      changed: false,
    });
    state = step(state, { type: 'patchMedia', socketId: 'a', patch: { isAudioMuted: true } });
    expect(state.participants.find((p) => p.socketId === 'a')).toMatchObject({
      isAudioMuted: true,
      isVideoOff: false,
    });
    expect(
      run(state, { type: 'patchMedia', socketId: 'a', patch: { isAudioMuted: true } }),
    ).toMatchObject({ ok: true, changed: false });
  });
});
