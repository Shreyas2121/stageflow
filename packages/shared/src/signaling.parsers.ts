import type {
  DescriptionRequest,
  IceCandidateRequest,
  JoinRoomRequest,
  StageTargetRequest,
  StageLockRequest,
} from './signaling';
import type { MediaPatch } from './stage';
import { isUuid } from './identifiers';
import {
  SDP_MAX_LENGTH,
  ICE_CANDIDATE_MAX_LENGTH,
  SOCKET_ID_MAX_LENGTH,
  SDP_MID_MAX_LENGTH,
  SDP_MLINE_INDEX_MAX,
  ICE_UFRAG_MAX_LENGTH,
} from './limits';
function record(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function bounded(value: unknown, max: number): value is string {
  return typeof value === 'string' && value.length <= max;
}
function socketId(value: unknown): value is string {
  return bounded(value, SOCKET_ID_MAX_LENGTH) && value.length > 0;
}
export function parseJoinRoomRequest(value: unknown): JoinRoomRequest | null {
  if (
    !record(value) ||
    !isUuid(value.roomId) ||
    typeof value.isAudioMuted !== 'boolean' ||
    typeof value.isVideoOff !== 'boolean' ||
    typeof value.isSyntheticBot !== 'boolean'
  )
    return null;
  return {
    roomId: value.roomId,
    isAudioMuted: value.isAudioMuted,
    isVideoOff: value.isVideoOff,
    isSyntheticBot: value.isSyntheticBot,
  };
}
export function parseDescriptionRequest(value: unknown): DescriptionRequest | null {
  if (!record(value) || !socketId(value.toSocketId) || !record(value.description)) return null;
  const { type, sdp } = value.description;
  if ((type !== 'offer' && type !== 'answer') || !bounded(sdp, SDP_MAX_LENGTH)) return null;
  return { toSocketId: value.toSocketId, description: { type, sdp } };
}
export function parseIceCandidateRequest(value: unknown): IceCandidateRequest | null {
  if (!record(value) || !socketId(value.toSocketId)) return null;
  if (value.candidate === null) return { toSocketId: value.toSocketId, candidate: null };
  if (!record(value.candidate)) return null;
  const { candidate, sdpMid, sdpMLineIndex, usernameFragment } = value.candidate;
  if (
    !bounded(candidate, ICE_CANDIDATE_MAX_LENGTH) ||
    (sdpMid !== null && !bounded(sdpMid, SDP_MID_MAX_LENGTH)) ||
    (sdpMLineIndex !== null &&
      (typeof sdpMLineIndex !== 'number' ||
        !Number.isInteger(sdpMLineIndex) ||
        sdpMLineIndex < 0 ||
        sdpMLineIndex > SDP_MLINE_INDEX_MAX)) ||
    (usernameFragment != null &&
      (typeof usernameFragment !== 'string' ||
        usernameFragment.length === 0 ||
        usernameFragment.length > ICE_UFRAG_MAX_LENGTH))
  )
    return null;
  if (candidate !== '' && sdpMid === null && sdpMLineIndex === null) return null;
  return {
    toSocketId: value.toSocketId,
    candidate: {
      candidate,
      sdpMid,
      sdpMLineIndex,
      ...(typeof usernameFragment === 'string' ? { usernameFragment } : {}),
    },
  };
}
export function parseMediaPatch(value: unknown): MediaPatch | null {
  if (
    !record(value) ||
    Object.keys(value).some(
      (key) =>
        !['isAudioMuted', 'isVideoOff', 'isScreenSharing'].includes(key) ||
        typeof value[key] !== 'boolean',
    )
  )
    return null;
  const patch: MediaPatch = {};
  if (typeof value.isAudioMuted === 'boolean') patch.isAudioMuted = value.isAudioMuted;
  if (typeof value.isVideoOff === 'boolean') patch.isVideoOff = value.isVideoOff;
  if (typeof value.isScreenSharing === 'boolean') patch.isScreenSharing = value.isScreenSharing;
  return patch;
}
export function parseHandRequest(value: unknown): { raised: boolean } | null {
  return record(value) && typeof value.raised === 'boolean' ? { raised: value.raised } : null;
}
export function parseStageTargetRequest(value: unknown): StageTargetRequest | null {
  if (
    !record(value) ||
    !socketId(value.targetSocketId) ||
    Object.keys(value).some((key) => key !== 'targetSocketId')
  )
    return null;
  return { targetSocketId: value.targetSocketId };
}
export function parseStageLockRequest(value: unknown): StageLockRequest | null {
  if (
    !record(value) ||
    !socketId(value.targetSocketId) ||
    (value.kind !== 'audio' && value.kind !== 'video') ||
    typeof value.locked !== 'boolean' ||
    Object.keys(value).some((key) => !['targetSocketId', 'kind', 'locked'].includes(key))
  )
    return null;
  return { targetSocketId: value.targetSocketId, kind: value.kind, locked: value.locked };
}
