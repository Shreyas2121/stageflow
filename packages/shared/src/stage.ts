import { STAGE_CAPACITY } from './limits';
import type { RoomMode, RoomStatus } from './contracts';

export type ParticipantRole = 'HOST' | 'SPEAKER' | 'ATTENDEE';

export type ParticipantState = {
  socketId: string;
  userId: string;
  displayName: string;
  role: ParticipantRole;
  isAudioMuted: boolean;
  isVideoOff: boolean;
  isScreenSharing: boolean;
  isHandRaised: boolean;
  isSyntheticBot: boolean;
  hostAudioLocked: boolean;
  hostVideoLocked: boolean;
  joinedAt: number;
};

export type LiveState = {
  roomId: string;
  hostId: string;
  mode: RoomMode;
  status: RoomStatus;
  participants: ParticipantState[];
  stageSocketIds: string[];
  hands: { socketId: string; raisedAt: number }[];
};

export type MediaPatch = Partial<
  Pick<ParticipantState, 'isAudioMuted' | 'isVideoOff' | 'isScreenSharing'>
>;

export type StageCommand =
  | {
      type: 'join';
      socketId: string;
      userId: string;
      displayName: string;
      isAudioMuted: boolean;
      isVideoOff: boolean;
      isSyntheticBot: boolean;
      joinedAt: number;
    }
  | { type: 'leave'; socketId: string }
  | { type: 'patchMedia'; socketId: string; patch: MediaPatch }
  | { type: 'setHand'; socketId: string; raised: boolean; raisedAt: number }
  | { type: 'promote'; actorSocketId: string; targetSocketId: string }
  | { type: 'demote'; actorSocketId: string; targetSocketId: string }
  | {
      type: 'setHostLock';
      actorSocketId: string;
      targetSocketId: string;
      kind: 'audio' | 'video';
      locked: boolean;
    };

export type StageError =
  | 'room_ended'
  | 'already_joined'
  | 'host_not_present'
  | 'stage_full'
  | 'participant_not_found'
  | 'audio_locked'
  | 'video_locked'
  | 'not_attendee'
  | 'not_host'
  | 'cannot_demote_host'
  | 'not_speaker';

export type StageResult =
  | { ok: true; state: LiveState; changed: boolean; roomEnded: boolean }
  | { ok: false; error: StageError };

// Use code-unit ordering, also reproducible by Redis Lua's byte ordering for socket IDs.
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function applyStageCommand(state: LiveState, command: StageCommand): StageResult {
  const next: LiveState = {
    ...state,
    participants: state.participants.map((participant) => ({ ...participant })),
    stageSocketIds: [...state.stageSocketIds],
    hands: state.hands.map((hand) => ({ ...hand })),
  };
  const fail = (error: StageError): StageResult => ({ ok: false, error });
  const success = (changed: boolean, roomEnded = false): StageResult => {
    next.participants.sort((a, b) => compareIds(a.socketId, b.socketId));
    next.stageSocketIds.sort(compareIds);
    next.hands.sort((a, b) => a.raisedAt - b.raisedAt || compareIds(a.socketId, b.socketId));
    return { ok: true, state: next, changed, roomEnded };
  };
  const removeHand = (socketId: string) => {
    next.hands = next.hands.filter((hand) => hand.socketId !== socketId);
  };

  if (command.type === 'join') {
    if (state.status === 'ENDED') return fail('room_ended');
    if (
      state.participants.some((p) => p.userId === command.userId || p.socketId === command.socketId)
    ) {
      return fail('already_joined');
    }
    const isHost = command.userId === state.hostId;
    if (state.mode === 'MEETING' && !isHost && !state.participants.some((p) => p.role === 'HOST')) {
      return fail('host_not_present');
    }
    const onStage = isHost || state.mode === 'MEETING';
    if (onStage && state.stageSocketIds.length >= STAGE_CAPACITY) return fail('stage_full');
    next.participants.push({
      socketId: command.socketId,
      userId: command.userId,
      displayName: command.displayName,
      role: isHost ? 'HOST' : onStage ? 'SPEAKER' : 'ATTENDEE',
      isAudioMuted: command.isAudioMuted,
      isVideoOff: command.isVideoOff,
      isScreenSharing: false,
      isHandRaised: false,
      isSyntheticBot: command.isSyntheticBot,
      hostAudioLocked: false,
      hostVideoLocked: false,
      joinedAt: command.joinedAt,
    });
    if (onStage) next.stageSocketIds.push(command.socketId);
    return success(true);
  }

  if ('socketId' in command) {
    const participant = next.participants.find((p) => p.socketId === command.socketId);
    if (command.type === 'leave') {
      if (!participant) return success(false);
      if (participant.role === 'HOST') {
        next.status = 'ENDED';
        next.participants = [];
        next.stageSocketIds = [];
        next.hands = [];
        return success(true, true);
      }
      next.participants = next.participants.filter((p) => p.socketId !== command.socketId);
      next.stageSocketIds = next.stageSocketIds.filter((id) => id !== command.socketId);
      removeHand(command.socketId);
      return success(true);
    }
    if (!participant) return fail('participant_not_found');
    if (command.type === 'patchMedia') {
      if (command.patch.isAudioMuted === false && participant.hostAudioLocked)
        return fail('audio_locked');
      if (command.patch.isVideoOff === false && participant.hostVideoLocked)
        return fail('video_locked');
      let changed = false;
      for (const key of ['isAudioMuted', 'isVideoOff', 'isScreenSharing'] as const) {
        const value = command.patch[key];
        if (value !== undefined && participant[key] !== value) {
          participant[key] = value;
          changed = true;
        }
      }
      return success(changed);
    }
    if (participant.role !== 'ATTENDEE') return fail('not_attendee');
    if (participant.isHandRaised === command.raised) return success(false);
    participant.isHandRaised = command.raised;
    removeHand(command.socketId);
    if (command.raised) next.hands.push({ socketId: command.socketId, raisedAt: command.raisedAt });
    return success(true);
  }

  if (!next.participants.some((p) => p.socketId === command.actorSocketId && p.role === 'HOST')) {
    return fail('not_host');
  }
  const target = next.participants.find((p) => p.socketId === command.targetSocketId);
  if (!target) return fail('participant_not_found');
  if (command.type === 'promote') {
    if (target.role !== 'ATTENDEE') return fail('not_attendee');
    if (next.stageSocketIds.length >= STAGE_CAPACITY) return fail('stage_full');
    target.role = 'SPEAKER';
    target.isHandRaised = false;
    removeHand(target.socketId);
    next.stageSocketIds.push(target.socketId);
  } else if (command.type === 'demote') {
    if (target.role === 'HOST') return fail('cannot_demote_host');
    if (target.role !== 'SPEAKER') return fail('not_speaker');
    target.role = 'ATTENDEE';
    target.isHandRaised = false;
    removeHand(target.socketId);
    next.stageSocketIds = next.stageSocketIds.filter((id) => id !== target.socketId);
  } else {
    const lock = command.kind === 'audio' ? 'hostAudioLocked' : 'hostVideoLocked';
    const flag = command.kind === 'audio' ? 'isAudioMuted' : 'isVideoOff';
    const changed = target[lock] !== command.locked || (command.locked && !target[flag]);
    target[lock] = command.locked;
    if (command.locked) target[flag] = true;
    return success(changed);
  }
  return success(true);
}
