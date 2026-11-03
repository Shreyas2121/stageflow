import { expect, it } from 'vitest';
import {
  parseJoinRoomRequest,
  parseResumeRoomRequest,
  parseDescriptionRequest,
  parseIceCandidateRequest,
  parseMediaPatch,
  parseHandRequest,
  parseStageTargetRequest,
  parseStageLockRequest,
} from './signaling.parsers';
import {
  SDP_MAX_LENGTH,
  ICE_CANDIDATE_MAX_LENGTH,
  ICE_UFRAG_MAX_LENGTH,
  PARTICIPANT_ID_MAX_LENGTH,
  SDP_MID_MAX_LENGTH,
} from './limits';
const join = {
  roomId: '01234567-89ab-cdef-0123-456789abcdef',
  isAudioMuted: false,
  isVideoOff: false,
  isSyntheticBot: false,
};
const ice = { candidate: 'candidate', sdpMid: '0', sdpMLineIndex: 0 };
it('accepts a bounded resume credential and membership UUID without client-controlled generations', () => {
  const request = {
    roomId: join.roomId,
    participantId: join.roomId,
    resumeCredential: 'x'.repeat(43),
  };
  expect(parseResumeRoomRequest(request)).toEqual(request);
  for (const value of [
    null,
    {},
    { ...request, participantId: 'socket-id' },
    { ...request, resumeCredential: 'x'.repeat(44) },
    { ...request, resumeCredential: '/'.repeat(43) },
    { ...request, generation: 2 },
  ])
    expect(parseResumeRoomRequest(value)).toBeNull();
});
it('accepts bounded moderation targets and rejects missing targets and unknown keys', () => {
  expect(parseStageTargetRequest({ targetParticipantId: 'peer' })).toEqual({
    targetParticipantId: 'peer',
  });
  expect(
    parseStageTargetRequest({ targetParticipantId: 'x'.repeat(PARTICIPANT_ID_MAX_LENGTH) }),
  ).not.toBeNull();
  for (const value of [
    {},
    { targetParticipantId: '' },
    { targetParticipantId: 1 },
    { targetParticipantId: 'x'.repeat(PARTICIPANT_ID_MAX_LENGTH + 1) },
    { targetParticipantId: 'peer', role: 'SPEAKER' },
  ]) {
    expect(parseStageTargetRequest(value)).toBeNull();
  }
});
it('accepts only audio/video boolean host locks with no extra fields', () => {
  for (const kind of ['audio', 'video']) {
    for (const locked of [true, false]) {
      const request = { targetParticipantId: 'peer', kind, locked };
      expect(parseStageLockRequest(request)).toEqual(request);
    }
  }
  const request = { targetParticipantId: 'peer', kind: 'audio', locked: true };
  for (const value of [
    {},
    { kind: 'audio', locked: true },
    { ...request, targetParticipantId: '' },
    { ...request, targetParticipantId: 1 },
    { ...request, targetParticipantId: 'x'.repeat(PARTICIPANT_ID_MAX_LENGTH + 1) },
    { ...request, kind: 'screen' },
    { ...request, kind: undefined },
    { ...request, locked: 'true' },
    { ...request, locked: undefined },
    { ...request, actorParticipantId: 'host' },
  ]) {
    expect(parseStageLockRequest(value)).toBeNull();
  }
});
it('copies join fields without accepting invalid identifiers or booleans', () => {
  expect(parseJoinRoomRequest({ ...join, role: 'HOST' })).toEqual(join);
  expect(parseJoinRoomRequest({ ...join, roomId: 'room' })).toBeNull();
  expect(parseJoinRoomRequest({ ...join, isVideoOff: 'false' })).toBeNull();
});
it.each([null, undefined, [], 'text', 42])('rejects non-object payload %j', (value) => {
  for (const parse of [
    parseJoinRoomRequest,
    parseDescriptionRequest,
    parseIceCandidateRequest,
    parseMediaPatch,
    parseHandRequest,
    parseStageTargetRequest,
    parseStageLockRequest,
  ])
    expect(parse(value)).toBeNull();
});
it('bounds descriptions and strips extra fields', () => {
  const value = {
    toParticipantId: 'peer',
    description: { type: 'offer', sdp: 'a'.repeat(SDP_MAX_LENGTH) },
  };
  expect(parseDescriptionRequest({ ...value, extra: 1 })).toEqual(value);
  expect(
    parseDescriptionRequest({
      ...value,
      description: { type: 'answer', sdp: 'a'.repeat(SDP_MAX_LENGTH + 1) },
    }),
  ).toBeNull();
  expect(
    parseDescriptionRequest({ ...value, description: { type: 'rollback', sdp: '' } }),
  ).toBeNull();
  for (const id of ['', 'x'.repeat(PARTICIPANT_ID_MAX_LENGTH + 1), null])
    expect(parseDescriptionRequest({ ...value, toParticipantId: id })).toBeNull();
});
it('preserves both end markers and rejects unidentified nonempty candidates', () => {
  expect(parseIceCandidateRequest({ toParticipantId: 'peer', candidate: null })).toEqual({
    toParticipantId: 'peer',
    candidate: null,
  });
  expect(
    parseIceCandidateRequest({
      toParticipantId: 'peer',
      candidate: { candidate: '', sdpMid: null, sdpMLineIndex: null },
    }),
  ).not.toBeNull();
  expect(
    parseIceCandidateRequest({
      toParticipantId: 'peer',
      candidate: { ...ice, sdpMid: null, sdpMLineIndex: null },
    }),
  ).toBeNull();
  expect(
    parseIceCandidateRequest({ toParticipantId: 'peer', candidate: { ...ice, sdpMid: null } }),
  ).not.toBeNull();
  expect(
    parseIceCandidateRequest({
      toParticipantId: 'peer',
      candidate: { ...ice, sdpMLineIndex: null },
    }),
  ).not.toBeNull();
});
it.each([-1, 0.5, NaN, Infinity, 65536, undefined])(
  'rejects invalid candidate index %s',
  (index) => {
    expect(
      parseIceCandidateRequest({
        toParticipantId: 'peer',
        candidate: { ...ice, sdpMLineIndex: index },
      }),
    ).toBeNull();
  },
);
it('bounds candidate strings, identifiers and mid', () => {
  expect(
    parseIceCandidateRequest({
      toParticipantId: 'x'.repeat(PARTICIPANT_ID_MAX_LENGTH),
      candidate: {
        ...ice,
        candidate: 'x'.repeat(ICE_CANDIDATE_MAX_LENGTH),
        sdpMid: 'x'.repeat(SDP_MID_MAX_LENGTH),
        sdpMLineIndex: 65535,
      },
    }),
  ).not.toBeNull();
  for (const candidate of [
    { ...ice, candidate: 'x'.repeat(ICE_CANDIDATE_MAX_LENGTH + 1) },
    { ...ice, sdpMid: 'x'.repeat(SDP_MID_MAX_LENGTH + 1) },
    { ...ice, sdpMid: undefined },
  ])
    expect(parseIceCandidateRequest({ toParticipantId: 'peer', candidate })).toBeNull();
  expect(parseIceCandidateRequest({ toParticipantId: '', candidate: ice })).toBeNull();
  expect(parseIceCandidateRequest({ toParticipantId: 'peer' })).toBeNull();
});
it('preserves an ICE username fragment without requiring one', () => {
  expect(
    parseIceCandidateRequest({
      toParticipantId: 'peer',
      candidate: { ...ice, usernameFragment: 'answer-ufrag' },
    }),
  ).toEqual({
    toParticipantId: 'peer',
    candidate: { ...ice, usernameFragment: 'answer-ufrag' },
  });
  expect(
    parseIceCandidateRequest({ toParticipantId: 'peer', candidate: ice })?.candidate,
  ).not.toHaveProperty('usernameFragment');
  expect(
    parseIceCandidateRequest({
      toParticipantId: 'peer',
      candidate: { ...ice, usernameFragment: null },
    })?.candidate,
  ).not.toHaveProperty('usernameFragment');
  for (const usernameFragment of ['', 'x'.repeat(ICE_UFRAG_MAX_LENGTH + 1), 1, {}]) {
    expect(
      parseIceCandidateRequest({
        toParticipantId: 'peer',
        candidate: { ...ice, usernameFragment },
      }),
    ).toBeNull();
  }
});
it('keeps partial and empty media patches idempotent and rejects unknown policy fields', () => {
  expect(parseMediaPatch({})).toEqual({});
  expect(parseMediaPatch({ isAudioMuted: false })).toEqual({ isAudioMuted: false });
  expect(parseMediaPatch({ role: 'HOST' })).toBeNull();
  expect(parseMediaPatch({ isScreenSharing: 1 })).toBeNull();
  expect(parseHandRequest({ raised: false, ignored: 1 })).toEqual({ raised: false });
  expect(parseHandRequest({ raised: 1 })).toBeNull();
});
