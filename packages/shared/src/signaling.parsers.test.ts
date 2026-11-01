import { expect, it } from 'vitest';
import {
  parseJoinRoomRequest,
  parseDescriptionRequest,
  parseIceCandidateRequest,
  parseMediaPatch,
  parseHandRequest,
} from './signaling.parsers';
import {
  SDP_MAX_LENGTH,
  ICE_CANDIDATE_MAX_LENGTH,
  ICE_UFRAG_MAX_LENGTH,
  SOCKET_ID_MAX_LENGTH,
  SDP_MID_MAX_LENGTH,
} from './limits';
const join = {
  roomId: '01234567-89ab-cdef-0123-456789abcdef',
  isAudioMuted: false,
  isVideoOff: false,
  isSyntheticBot: false,
};
const ice = { candidate: 'candidate', sdpMid: '0', sdpMLineIndex: 0 };
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
  ])
    expect(parse(value)).toBeNull();
});
it('bounds descriptions and strips extra fields', () => {
  const value = {
    toSocketId: 'peer',
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
  for (const id of ['', 'x'.repeat(SOCKET_ID_MAX_LENGTH + 1), null])
    expect(parseDescriptionRequest({ ...value, toSocketId: id })).toBeNull();
});
it('preserves both end markers and rejects unidentified nonempty candidates', () => {
  expect(parseIceCandidateRequest({ toSocketId: 'peer', candidate: null })).toEqual({
    toSocketId: 'peer',
    candidate: null,
  });
  expect(
    parseIceCandidateRequest({
      toSocketId: 'peer',
      candidate: { candidate: '', sdpMid: null, sdpMLineIndex: null },
    }),
  ).not.toBeNull();
  expect(
    parseIceCandidateRequest({
      toSocketId: 'peer',
      candidate: { ...ice, sdpMid: null, sdpMLineIndex: null },
    }),
  ).toBeNull();
  expect(
    parseIceCandidateRequest({ toSocketId: 'peer', candidate: { ...ice, sdpMid: null } }),
  ).not.toBeNull();
  expect(
    parseIceCandidateRequest({ toSocketId: 'peer', candidate: { ...ice, sdpMLineIndex: null } }),
  ).not.toBeNull();
});
it.each([-1, 0.5, NaN, Infinity, 65536, undefined])(
  'rejects invalid candidate index %s',
  (index) => {
    expect(
      parseIceCandidateRequest({ toSocketId: 'peer', candidate: { ...ice, sdpMLineIndex: index } }),
    ).toBeNull();
  },
);
it('bounds candidate strings, identifiers and mid', () => {
  expect(
    parseIceCandidateRequest({
      toSocketId: 'x'.repeat(SOCKET_ID_MAX_LENGTH),
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
    expect(parseIceCandidateRequest({ toSocketId: 'peer', candidate })).toBeNull();
  expect(parseIceCandidateRequest({ toSocketId: '', candidate: ice })).toBeNull();
  expect(parseIceCandidateRequest({ toSocketId: 'peer' })).toBeNull();
});
it('preserves an ICE username fragment without requiring one', () => {
  expect(
    parseIceCandidateRequest({
      toSocketId: 'peer',
      candidate: { ...ice, usernameFragment: 'answer-ufrag' },
    }),
  ).toEqual({
    toSocketId: 'peer',
    candidate: { ...ice, usernameFragment: 'answer-ufrag' },
  });
  expect(
    parseIceCandidateRequest({ toSocketId: 'peer', candidate: ice })?.candidate,
  ).not.toHaveProperty('usernameFragment');
  expect(
    parseIceCandidateRequest({
      toSocketId: 'peer',
      candidate: { ...ice, usernameFragment: null },
    })?.candidate,
  ).not.toHaveProperty('usernameFragment');
  for (const usernameFragment of ['', 'x'.repeat(ICE_UFRAG_MAX_LENGTH + 1), 1, {}]) {
    expect(
      parseIceCandidateRequest({ toSocketId: 'peer', candidate: { ...ice, usernameFragment } }),
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
