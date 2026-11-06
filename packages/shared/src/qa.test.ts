import { describe, expect, it } from 'vitest';
import {
  QA_TEXT_MAX_BYTES,
  parseQaQuestionId,
  parseQaSetSubmissions,
  parseQaSubmit,
} from './index';

const invalidPayload = { ok: false, error: 'invalid_payload' };
const invalidText = { ok: false, error: 'qa_invalid' };

describe('parseQaSubmit', () => {
  it('trims before validation, preserves angle brackets as text, and leaves input alone', () => {
    const body = { text: ' \r\n<b>hi</b>\t ' };
    expect(parseQaSubmit(body)).toEqual({ ok: true, value: { text: '<b>hi</b>' } });
    expect(body.text).toBe(' \r\n<b>hi</b>\t ');
  });

  it.each(['a', 'a'.repeat(200), '\u754c'.repeat(200), '\ud83d\ude00'.repeat(100)])(
    'accepts up to 200 UTF-16 code units after trim (case %#)',
    (text) => {
      expect(parseQaSubmit({ text: ` \t${text}\n` })).toEqual({ ok: true, value: { text } });
    },
  );

  it.each(['', ' \t\n\u00a0 ', 'a'.repeat(201), '\ud83d\ude00'.repeat(101)])(
    'rejects empty or excessive UTF-16 text (case %#)',
    (text) => {
      expect(parseQaSubmit({ text })).toEqual(invalidText);
    },
  );

  it('rejects text at and above the byte cap when it also exceeds the code-unit cap', () => {
    // UTF-8 uses at most three bytes per UTF-16 code unit: a valid 200-unit
    // question cannot reach 1,000 bytes. Keep the explicit byte budget anyway.
    expect(QA_TEXT_MAX_BYTES).toBe(1_000);
    for (const text of ['a'.repeat(1_000), '\u754c'.repeat(334)]) {
      expect(new TextEncoder().encode(text).byteLength).toBeGreaterThanOrEqual(QA_TEXT_MAX_BYTES);
      expect(parseQaSubmit({ text })).toEqual(invalidText);
    }
  });

  it.each(Array.from({ length: 33 }, (_, index) => (index === 32 ? 127 : index)))(
    'rejects embedded ASCII control code %s',
    (code) => {
      expect(parseQaSubmit({ text: `a${String.fromCharCode(code)}b` })).toEqual(invalidText);
    },
  );

  it.each([null, undefined, [], 'text', 42, true, {}, { text: null }, { text: 1 }])(
    'rejects malformed bodies (case %#)',
    (body) => {
      expect(parseQaSubmit(body)).toEqual(invalidPayload);
    },
  );

  it.each(['displayName', 'participantId', 'userId', 'authorName', 'votes', 'createdAt', 'extra'])(
    'rejects forged or extra field %s on every payload parser',
    (field) => {
      expect(parseQaSubmit({ text: 'Hello', [field]: 'forged' })).toEqual(invalidPayload);
      expect(parseQaQuestionId({ questionId: '1', [field]: 'forged' })).toEqual(invalidPayload);
      expect(parseQaSetSubmissions({ open: true, [field]: 'forged' })).toEqual(invalidPayload);
    },
  );
});

describe('parseQaQuestionId', () => {
  it.each(['1', '10', '9999999999999999999'])(
    'preserves decimal id %s as a string',
    (questionId) => {
      expect(parseQaQuestionId({ questionId })).toEqual({ ok: true, value: { questionId } });
    },
  );

  it.each(['', '0', '01', '-1', '1.5', '1e2', ' 1', '1 ', '1\n', 'a', '1'.repeat(20), 1, null])(
    'rejects malformed id %s',
    (questionId) => {
      expect(parseQaQuestionId({ questionId })).toEqual(invalidPayload);
    },
  );

  it.each([null, undefined, [], {}, '1', true])('rejects malformed body (case %#)', (body) => {
    expect(parseQaQuestionId(body)).toEqual(invalidPayload);
  });
});

describe('parseQaSetSubmissions', () => {
  it.each([true, false])('accepts open: %s', (open) => {
    expect(parseQaSetSubmissions({ open })).toEqual({ ok: true, value: { open } });
  });

  it.each([null, undefined, [], {}, true, { open: 'false' }, { open: 0 }, { open: null }])(
    'requires a boolean in an object (case %#)',
    (body) => {
      expect(parseQaSetSubmissions(body)).toEqual(invalidPayload);
    },
  );
});
