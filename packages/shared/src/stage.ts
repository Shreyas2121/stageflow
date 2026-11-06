import { RECONNECT_GRACE_MS, STAGE_CAPACITY } from './limits';
import type { RoomMode, RoomStatus } from './contracts';

export type ParticipantRole = 'HOST' | 'SPEAKER' | 'ATTENDEE' | 'WAITING';

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
  requireAdmission?: boolean;
  participants: ParticipantState[];
  stageParticipantIds: string[];
  waitingParticipantIds: string[];
  hands: { participantId: string; raisedAt: number }[];
  // Server-only metadata; RoomSnapshot deliberately does not project these maps.
  resumeDigests: Record<string, string>;
  deadlines: Record<string, number>;
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

type StageOperation =
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
      now?: number;
      resumeDigest?: string;
    }
  | { type: 'start'; actorParticipantId: string }
  | { type: 'cancel'; actorParticipantId: string }
  | { type: 'admit'; actorParticipantId: string; targetParticipantId: string }
  | { type: 'removeWaiter'; actorParticipantId: string; targetParticipantId: string }
  | { type: 'leave'; participantId: string }
  | { type: 'suspend'; participantId: string; now?: number }
  | { type: 'expire'; now: number }
  | {
      type: 'resume';
      participantId: string;
      userId: string;
      socketId: string;
      resumeDigest: string;
      expectedGeneration: number;
      now?: number;
    }
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

export type TransportBinding = { participantId: string; socketId: string; generation: number };
export type StageCommand = StageOperation & { transport?: TransportBinding };

export type StageError =
  | 'room_ended'
  | 'already_joined'
  | 'host_not_present'
  | 'stage_full'
  | 'waiting_full'
  | 'already_started'
  | 'not_scheduled'
  | 'not_waiting'
  | 'admission_off'
  | 'demo_not_ready'
  | 'participant_not_found'
  | 'audio_locked'
  | 'video_locked'
  | 'not_on_stage'
  | 'not_attendee'
  | 'not_host'
  | 'cannot_demote_host'
  | 'not_speaker'
  | 'not_connected'
  | 'invalid_resume'
  | 'resume_expired'
  | 'already_connected'
  | 'resume_lost'
  | 'stale_transport';

export type StageSuccess = { ok: true; state: LiveState; changed: boolean; roomEnded: boolean };
export type StageResult = StageSuccess | { ok: false; error: StageError; expiry?: StageSuccess };

// Use code-unit ordering, also reproducible by Redis Lua's byte ordering for participant IDs.
function compareIds(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
}

export function applyStageCommand(state: LiveState, command: StageCommand): StageResult {
  if (command.transport) {
    const binding = command.transport;
    const actor = state.participants.find((p) => p.participantId === binding.participantId);
    if (
      (!actor && command.type !== 'leave') ||
      (actor &&
        (actor.connectionGeneration !== binding.generation ||
          actor.socketId !== binding.socketId ||
          actor.presence !== 'connected'))
    )
      return { ok: false, error: 'stale_transport' };
  }
  if ((command.type === 'join' || command.type === 'resume') && command.now !== undefined) {
    const expiry = applyStageCommand(state, { type: 'expire', now: command.now });
    if (expiry.ok && expiry.changed) {
      const expiredSelf =
        command.type === 'resume' &&
        state.participants.some(
          (p) =>
            p.participantId === command.participantId &&
            p.presence === 'suspended' &&
            (state.deadlines[p.participantId] ?? Infinity) <= command.now!,
        );
      const result =
        expiredSelf && !expiry.roomEnded
          ? { ok: false as const, error: 'resume_expired' as const }
          : applyStageCommand(expiry.state, { ...command, now: undefined });
      return result.ok ? { ...result, changed: true } : { ...result, expiry };
    }
  }
  const next: LiveState = {
    ...state,
    participants: state.participants.map((participant) => ({ ...participant })),
    stageParticipantIds: [...state.stageParticipantIds],
    waitingParticipantIds: [...state.waitingParticipantIds],
    hands: state.hands.map((hand) => ({ ...hand })),
    resumeDigests: { ...state.resumeDigests },
    deadlines: { ...state.deadlines },
  };
  let filledWaiting = false;
  const fail = (error: StageError): StageResult => ({
    ok: false,
    error,
    ...(filledWaiting ? { expiry: success(true) } : {}),
  });
  const success = (changed: boolean, roomEnded = false): StageSuccess => {
    next.participants.sort((a, b) => compareIds(a.participantId, b.participantId));
    next.stageParticipantIds.sort(compareIds);
    const arrivals = new Map(next.participants.map((p) => [p.participantId, p.joinedAt]));
    next.waitingParticipantIds.sort(
      (a, b) => arrivals.get(a)! - arrivals.get(b)! || compareIds(a, b),
    );
    next.hands.sort(
      (a, b) => a.raisedAt - b.raisedAt || compareIds(a.participantId, b.participantId),
    );
    return { ok: true, state: next, changed, roomEnded };
  };
  const removeHand = (participantId: string) => {
    next.hands = next.hands.filter((hand) => hand.participantId !== participantId);
  };
  const removeMember = (id: string) => {
    next.participants = next.participants.filter((p) => p.participantId !== id);
    next.stageParticipantIds = next.stageParticipantIds.filter((value) => value !== id);
    next.waitingParticipantIds = next.waitingParticipantIds.filter((value) => value !== id);
    removeHand(id);
    delete next.resumeDigests[id];
    delete next.deadlines[id];
  };
  const fillWaiting = () => {
    if (next.status !== 'LIVE' || next.mode !== 'MEETING' || next.requireAdmission) return;
    const arrivals = new Map(next.participants.map((p) => [p.participantId, p.joinedAt]));
    next.waitingParticipantIds.sort(
      (a, b) => arrivals.get(a)! - arrivals.get(b)! || compareIds(a, b),
    );
    while (next.stageParticipantIds.length < STAGE_CAPACITY && next.waitingParticipantIds.length) {
      const id = next.waitingParticipantIds.shift()!;
      next.participants.find((p) => p.participantId === id)!.role = 'SPEAKER';
      next.stageParticipantIds.push(id);
    }
  };
  const endRoom = () => {
    next.status = 'ENDED';
    next.participants = [];
    next.stageParticipantIds = [];
    next.waitingParticipantIds = [];
    next.hands = [];
    next.resumeDigests = {};
    next.deadlines = {};
    return success(true, true);
  };
  if (command.type === 'expire') {
    if (state.status === 'ENDED') return success(false, true);
    const overdue = next.participants.filter(
      (p) =>
        p.presence === 'suspended' && (next.deadlines[p.participantId] ?? Infinity) <= command.now,
    );
    if (overdue.some((p) => p.role === 'HOST')) return endRoom();
    const freed = overdue.some((p) => next.stageParticipantIds.includes(p.participantId));
    for (const participant of overdue) removeMember(participant.participantId);
    if (freed) fillWaiting();
    return success(overdue.length > 0);
  }
  if (command.type === 'resume') {
    if (state.status === 'ENDED') return fail('room_ended');
    const participant = next.participants.find((p) => p.participantId === command.participantId);
    if (!participant) return fail('participant_not_found');
    if (
      participant.userId !== command.userId ||
      participant.isSyntheticBot ||
      !next.resumeDigests[participant.participantId] ||
      next.resumeDigests[participant.participantId] !== command.resumeDigest
    )
      return fail('invalid_resume');
    if (participant.connectionGeneration !== command.expectedGeneration) return fail('resume_lost');
    if (participant.presence === 'connected') return fail('already_connected');
    if (next.participants.some((p) => p.socketId === command.socketId))
      return fail('already_joined');
    participant.presence = 'connected';
    participant.socketId = command.socketId;
    participant.connectionGeneration++;
    participant.isAudioMuted = participant.isVideoOff = true;
    participant.isScreenSharing = false;
    delete next.deadlines[participant.participantId];
    return success(true);
  }

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
    const scheduled = state.status === 'SCHEDULED';
    if (
      command.isSyntheticBot &&
      (scheduled ||
        !state.participants.some(
          (p) => p.role === 'HOST' && state.stageParticipantIds.includes(p.participantId),
        ))
    )
      return fail('demo_not_ready');
    if (
      !scheduled &&
      state.mode === 'MEETING' &&
      !isHost &&
      !state.participants.some((p) => p.role === 'HOST')
    ) {
      return fail('host_not_present');
    }
    const waitingBeforeFill = next.waitingParticipantIds.length;
    fillWaiting();
    filledWaiting = next.waitingParticipantIds.length !== waitingBeforeFill;
    const waiting =
      !isHost &&
      (scheduled ||
        (state.mode === 'MEETING' && !!state.requireAdmission && !command.isSyntheticBot));
    if (waiting && state.waitingParticipantIds.length >= 100) return fail('waiting_full');
    const onStage = !scheduled && !waiting && (isHost || state.mode === 'MEETING');
    if (onStage && next.stageParticipantIds.length >= STAGE_CAPACITY) return fail('stage_full');
    next.participants.push({
      participantId: command.participantId,
      socketId: command.socketId,
      connectionGeneration: 1,
      presence: 'connected',
      userId: command.userId,
      displayName: command.displayName,
      role: isHost ? 'HOST' : waiting ? 'WAITING' : onStage ? 'SPEAKER' : 'ATTENDEE',
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
    if (waiting) next.waitingParticipantIds.push(command.participantId);
    if (!scheduled && !waiting && !command.isSyntheticBot && command.resumeDigest)
      next.resumeDigests[command.participantId] = command.resumeDigest;
    return success(true);
  }

  if ('participantId' in command) {
    const participant = next.participants.find((p) => p.participantId === command.participantId);
    if (command.type === 'leave') {
      // A later leave must still report shutdown after the host record is gone.
      if (state.status === 'ENDED') return success(false, true);
      if (!participant) return success(false);
      if (participant.role === 'HOST' && state.status !== 'SCHEDULED') {
        return endRoom();
      }
      const freed = next.stageParticipantIds.includes(command.participantId);
      removeMember(command.participantId);
      if (freed) fillWaiting();
      return success(true);
    }
    if (!participant) return fail('participant_not_found');
    if (command.type === 'suspend') {
      if (
        participant.isSyntheticBot ||
        state.status === 'SCHEDULED' ||
        participant.role === 'WAITING'
      ) {
        const freed = next.stageParticipantIds.includes(participant.participantId);
        removeMember(participant.participantId);
        if (freed) fillWaiting();
        return success(true);
      }
      if (participant.presence === 'suspended') return success(false);
      participant.presence = 'suspended';
      participant.socketId = null;
      participant.isAudioMuted = true;
      participant.isVideoOff = true;
      participant.isScreenSharing = false;
      next.deadlines[participant.participantId] = (command.now ?? 0) + RECONNECT_GRACE_MS;
      if (participant.role === 'HOST') {
        for (const bot of next.participants.filter((p) => p.isSyntheticBot))
          removeMember(bot.participantId);
      }
      return success(true);
    }
    if (participant.presence !== 'connected') return fail('not_connected');
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
      (p) =>
        p.participantId === command.actorParticipantId &&
        p.role === 'HOST' &&
        p.presence === 'connected',
    )
  ) {
    return fail('not_host');
  }
  if (command.type === 'start') {
    if (next.status !== 'SCHEDULED') return fail('already_started');
    next.status = 'LIVE';
    next.stageParticipantIds.push(command.actorParticipantId);
    if (next.mode === 'WEBINAR') {
      for (const p of next.participants) if (p.role === 'WAITING') p.role = 'ATTENDEE';
      next.waitingParticipantIds = [];
    } else fillWaiting();
    return success(true);
  }
  if (command.type === 'cancel') {
    if (next.status !== 'SCHEDULED') return fail('not_scheduled');
    return endRoom();
  }
  if (command.type === 'admit' || command.type === 'removeWaiter') {
    if (
      command.type === 'admit' &&
      (next.status !== 'LIVE' || next.mode !== 'MEETING' || !next.requireAdmission)
    )
      return fail('admission_off');
    const target = next.participants.find((p) => p.participantId === command.targetParticipantId);
    if (!target || target.role !== 'WAITING') return fail('not_waiting');
    if (command.type === 'removeWaiter') removeMember(target.participantId);
    else {
      if (next.stageParticipantIds.length >= STAGE_CAPACITY) return fail('stage_full');
      target.role = 'SPEAKER';
      next.waitingParticipantIds = next.waitingParticipantIds.filter(
        (id) => id !== target.participantId,
      );
      next.stageParticipantIds.push(target.participantId);
    }
    return success(true);
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
    fillWaiting();
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
