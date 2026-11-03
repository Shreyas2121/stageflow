import { STAGE_CAPACITY } from './limits';
import type { RoomMode, RoomStatus } from './contracts';

export type ParticipantRole = 'HOST' | 'SPEAKER' | 'ATTENDEE';

export type ParticipantState = {
  participantId: string;
  socketId: string | null;
  connectionGeneration: number;
  presence: 'connected' | 'suspended';
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
  stageParticipantIds: string[];
  hands: { participantId: string; raisedAt: number }[];
};

export type MediaPatch = Partial<
  Pick<ParticipantState, 'isAudioMuted' | 'isVideoOff' | 'isScreenSharing'>
>;

export function connectedStageIds(
  state: Pick<LiveState, 'participants' | 'stageParticipantIds'>,
): string[] {
  const connected = new Set(
    state.participants.filter((p) => p.presence === 'connected').map((p) => p.participantId),
  );
  return state.stageParticipantIds.filter((id) => connected.has(id));
}

export type StageCommand =
  | {
      type: 'join';
      participantId: string;
      socketId: string;
      userId: string;
      displayName: string;
      isAudioMuted: boolean;
      isVideoOff: boolean;
      isSyntheticBot: boolean;
      joinedAt: number;
    }
  | { type: 'leave'; participantId: string }
  | { type: 'suspend'; participantId: string }
  | { type: 'patchMedia'; participantId: string; patch: MediaPatch }
  | { type: 'setHand'; participantId: string; raised: boolean; raisedAt: number }
  | { type: 'promote'; actorParticipantId: string; targetParticipantId: string }
  | { type: 'demote'; actorParticipantId: string; targetParticipantId: string }
  | {
      type: 'setHostLock';
      actorParticipantId: string;
      targetParticipantId: string;
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
  | 'not_on_stage'
  | 'not_attendee'
  | 'not_host'
  | 'cannot_demote_host'
  | 'not_speaker'
  | 'not_connected';

export type StageResult =
  | { ok: true; state: LiveState; changed: boolean; roomEnded: boolean }
  | { ok: false; error: StageError };

// Use code-unit ordering, also reproducible by Redis Lua's byte ordering for participant IDs.
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function applyStageCommand(state: LiveState, command: StageCommand): StageResult {
  const next: LiveState = {
    ...state,
    participants: state.participants.map((participant) => ({ ...participant })),
    stageParticipantIds: [...state.stageParticipantIds],
    hands: state.hands.map((hand) => ({ ...hand })),
  };
  const fail = (error: StageError): StageResult => ({ ok: false, error });
  const success = (changed: boolean, roomEnded = false): StageResult => {
    next.participants.sort((a, b) => compareIds(a.participantId, b.participantId));
    next.stageParticipantIds.sort(compareIds);
    next.hands.sort(
      (a, b) => a.raisedAt - b.raisedAt || compareIds(a.participantId, b.participantId),
    );
    return { ok: true, state: next, changed, roomEnded };
  };
  const removeHand = (participantId: string) => {
    next.hands = next.hands.filter((hand) => hand.participantId !== participantId);
  };

  if (command.type === 'join') {
    if (state.status === 'ENDED') return fail('room_ended');
    if (
      state.participants.some(
        (p) =>
          p.userId === command.userId ||
          p.participantId === command.participantId ||
          p.socketId === command.socketId,
      )
    ) {
      return fail('already_joined');
    }
    const isHost = command.userId === state.hostId;
    if (state.mode === 'MEETING' && !isHost && !state.participants.some((p) => p.role === 'HOST')) {
      return fail('host_not_present');
    }
    const onStage = isHost || state.mode === 'MEETING';
    if (onStage && state.stageParticipantIds.length >= STAGE_CAPACITY) return fail('stage_full');
    next.participants.push({
      participantId: command.participantId,
      socketId: command.socketId,
      connectionGeneration: 1,
      presence: 'connected',
      userId: command.userId,
      displayName: command.displayName,
      role: isHost ? 'HOST' : onStage ? 'SPEAKER' : 'ATTENDEE',
      isAudioMuted: onStage ? command.isAudioMuted : true,
      isVideoOff: onStage ? command.isVideoOff : true,
      isScreenSharing: false,
      isHandRaised: false,
      isSyntheticBot: command.isSyntheticBot,
      hostAudioLocked: false,
      hostVideoLocked: false,
      joinedAt: command.joinedAt,
    });
    if (onStage) next.stageParticipantIds.push(command.participantId);
    return success(true);
  }

  if ('participantId' in command) {
    const participant = next.participants.find((p) => p.participantId === command.participantId);
    if (command.type === 'leave') {
      // A later leave must still report shutdown after the host record is gone.
      if (state.status === 'ENDED') return success(false, true);
      if (!participant) return success(false);
      if (participant.role === 'HOST') {
        next.status = 'ENDED';
        next.participants = [];
        next.stageParticipantIds = [];
        next.hands = [];
        return success(true, true);
      }
      next.participants = next.participants.filter(
        (p) => p.participantId !== command.participantId,
      );
      next.stageParticipantIds = next.stageParticipantIds.filter(
        (id) => id !== command.participantId,
      );
      removeHand(command.participantId);
      return success(true);
    }
    if (!participant) return fail('participant_not_found');
    if (command.type === 'suspend') {
      if (participant.presence === 'suspended') return success(false);
      participant.presence = 'suspended';
      participant.socketId = null;
      participant.isAudioMuted = true;
      participant.isVideoOff = true;
      participant.isScreenSharing = false;
      return success(true);
    }
    if (command.type === 'patchMedia') {
      if (!next.stageParticipantIds.includes(participant.participantId)) {
        if (
          command.patch.isAudioMuted === false ||
          command.patch.isVideoOff === false ||
          command.patch.isScreenSharing === true
        )
          return fail('not_on_stage');
        const changed =
          participant.isAudioMuted !== true ||
          participant.isVideoOff !== true ||
          participant.isScreenSharing !== false;
        participant.isAudioMuted = true;
        participant.isVideoOff = true;
        participant.isScreenSharing = false;
        return success(changed);
      }
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
    removeHand(command.participantId);
    if (command.raised)
      next.hands.push({ participantId: command.participantId, raisedAt: command.raisedAt });
    return success(true);
  }

  if (
    !next.participants.some(
      (p) => p.participantId === command.actorParticipantId && p.role === 'HOST',
    )
  ) {
    return fail('not_host');
  }
  const target = next.participants.find((p) => p.participantId === command.targetParticipantId);
  if (!target) return fail('participant_not_found');
  if (command.type === 'promote') {
    if (target.role !== 'ATTENDEE') return fail('not_attendee');
    if (target.presence !== 'connected') return fail('not_connected');
    if (next.stageParticipantIds.length >= STAGE_CAPACITY) return fail('stage_full');
    target.role = 'SPEAKER';
    target.isHandRaised = false;
    removeHand(target.participantId);
    next.stageParticipantIds.push(target.participantId);
  } else if (command.type === 'demote') {
    if (target.role === 'HOST') return fail('cannot_demote_host');
    if (target.role !== 'SPEAKER') return fail('not_speaker');
    target.role = 'ATTENDEE';
    target.isAudioMuted = true;
    target.isVideoOff = true;
    target.isScreenSharing = false;
    target.isHandRaised = false;
    removeHand(target.participantId);
    next.stageParticipantIds = next.stageParticipantIds.filter((id) => id !== target.participantId);
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
