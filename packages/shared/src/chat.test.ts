import { describe, expect, it } from 'vitest';
import {
  CHAT_TEXT_MAX_BYTES,
  parseChatHistoryRequest,
  parseChatSendRequest,
  parseChatSetPausedRequest,
} from './index';

const requestId = '550e8400-e29b-41d4-a716-446655440000';
const request = { requestId, text: 'Hello' };
const invalidPayload = { ok: false, error: 'invalid_payload' };
const invalidText = { ok: false, error: 'chat_invalid' };

describe('parseChatSendRequest', () => {
  it('trims the edges, preserves internal newlines and plain text, and leaves input alone', () => {
    const body = { requestId, text: ' \r\n <b>Hello</b>\nhttps://example.com \t' };
    expect(parseChatSendRequest(body)).toEqual({
      ok: true,
      value: { requestId, text: '<b>Hello</b>\nhttps://example.com' },
    });
    expect(body.text).toBe(' \r\n <b>Hello</b>\nhttps://example.com \t');
  });

  it.each(['a', 'a'.repeat(1_000), '界'.repeat(1_000), '😀'.repeat(500)])(
    'accepts text within both length budgets (case %#)',
    (text) => {
      expect(parseChatSendRequest({ requestId, text: ` \n${text}\t ` })).toEqual({
        ok: true,
        value: { requestId, text },
      });
    },
  );

  it.each(['', ' \t\r\n\u00a0 ', 'a'.repeat(1_001), '😀'.repeat(501)])(
    'returns chat_invalid for empty or excessive UTF-16 text (case %#)',
    (text) => {
      expect(parseChatSendRequest({ requestId, text })).toEqual(invalidText);
    },
  );

  it('rejects text above the UTF-8 byte budget', () => {
    const text = '😀'.repeat(1_001);
    expect(new TextEncoder().encode(text).byteLength).toBeGreaterThan(CHAT_TEXT_MAX_BYTES);
    expect(parseChatSendRequest({ requestId, text })).toEqual(invalidText);
  });

  it.each([
    null,
    undefined,
    [],
    'text',
    42,
    true,
    {},
    { text: 'Hello' },
    { requestId },
    { ...request, requestId: 'not-a-uuid' },
    { ...request, requestId: ` ${requestId}` },
    { ...request, requestId: 1 },
    { ...request, text: null },
    { ...request, text: 1 },
    { ...request, text: ['Hello'] },
  ])('returns invalid_payload for malformed bodies (case %#)', (body) => {
    expect(parseChatSendRequest(body)).toEqual(invalidPayload);
  });

  it.each([
    'roomId',
    'participantId',
    'displayName',
    'role',
    'sequence',
    'sentAt',
    'timestamp',
    'extra',
  ])('rejects the extra field %s rather than trusting client authority', (field) => {
    expect(parseChatSendRequest({ ...request, [field]: 'forged' })).toEqual(invalidPayload);
  });
});

describe('parseChatHistoryRequest', () => {
  it.each([undefined, {}, { beforeSequence: undefined, limit: undefined }])(
    'selects the latest default page when fields are omitted (case %#)',
    (body) => {
      expect(parseChatHistoryRequest(body)).toEqual({ ok: true, value: { limit: 50 } });
    },
  );

  it('accepts an exclusive positive sequence and the page boundaries', () => {
    expect(parseChatHistoryRequest({ beforeSequence: 1 })).toEqual({
      ok: true,
      value: { beforeSequence: 1, limit: 50 },
    });
    expect(parseChatHistoryRequest({ limit: 1 })).toEqual({ ok: true, value: { limit: 1 } });
    expect(
      parseChatHistoryRequest({ beforeSequence: Number.MAX_SAFE_INTEGER, limit: 100 }),
    ).toEqual({
      ok: true,
      value: { beforeSequence: Number.MAX_SAFE_INTEGER, limit: 100 },
    });
  });

  it.each([0, -1, 0.5, 101, NaN, Infinity, '50', null, true])(
    'rejects invalid page size %s',
    (limit) => {
      expect(parseChatHistoryRequest({ limit })).toEqual(invalidPayload);
    },
  );

  it.each([0, -1, 1.5, NaN, Infinity, Number.MAX_SAFE_INTEGER + 1, '10', null, true])(
    'rejects invalid sequence cursor %s',
    (beforeSequence) => {
      expect(parseChatHistoryRequest({ beforeSequence })).toEqual(invalidPayload);
    },
  );

  it.each([null, [], 'text', 42, true, { roomId: requestId }, { limit: 50, extra: true }])(
    'rejects invalid history bodies and extra fields (case %#)',
    (body) => {
      expect(parseChatHistoryRequest(body)).toEqual(invalidPayload);
    },
  );
});

describe('parseChatSetPausedRequest', () => {
  it.each([true, false])('accepts paused: %s', (paused) => {
    expect(parseChatSetPausedRequest({ paused })).toEqual({ ok: true, value: { paused } });
  });

  it.each([
    null,
    undefined,
    [],
    'text',
    42,
    true,
    {},
    { paused: undefined },
    { paused: null },
    { paused: 'false' },
    { paused: 0 },
    { paused: false, roomId: requestId },
    { paused: true, role: 'HOST' },
  ])('rejects a missing boolean or extra fields (case %#)', (body) => {
    expect(parseChatSetPausedRequest(body)).toEqual(invalidPayload);
  });
});
