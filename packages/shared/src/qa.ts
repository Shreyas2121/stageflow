import { QA_TEXT_MAX_BYTES, QA_TEXT_MAX_LENGTH, QA_TEXT_MIN_LENGTH } from './limits';

export type QaSubmitRequest = { text: string };
export type QaQuestionIdRequest = { questionId: string };
export type QaSetSubmissionsRequest = { open: boolean };

export type QaParseResult<T> =
  { ok: true; value: T } | { ok: false; error: 'invalid_payload' | 'qa_invalid' };

function hasOnlyFields(value: unknown, fields: string[]): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => fields.includes(key))
  );
}

export function parseQaSubmit(value: unknown): QaParseResult<QaSubmitRequest> {
  if (!hasOnlyFields(value, ['text']) || typeof value.text !== 'string')
    return { ok: false, error: 'invalid_payload' };

  const text = value.text.trim();
  if (
    text.length < QA_TEXT_MIN_LENGTH ||
    text.length > QA_TEXT_MAX_LENGTH ||
    new TextEncoder().encode(text).byteLength > QA_TEXT_MAX_BYTES ||
    Array.from(text).some((character) => {
      const code = character.charCodeAt(0);
      return code <= 31 || code === 127;
    })
  )
    return { ok: false, error: 'qa_invalid' };

  return { ok: true, value: { text } };
}

export function parseQaQuestionId(value: unknown): QaParseResult<QaQuestionIdRequest> {
  if (
    !hasOnlyFields(value, ['questionId']) ||
    typeof value.questionId !== 'string' ||
    !/^[1-9][0-9]{0,18}$/.test(value.questionId)
  )
    return { ok: false, error: 'invalid_payload' };
  return { ok: true, value: { questionId: value.questionId } };
}

export function parseQaSetSubmissions(value: unknown): QaParseResult<QaSetSubmissionsRequest> {
  if (!hasOnlyFields(value, ['open']) || typeof value.open !== 'boolean')
    return { ok: false, error: 'invalid_payload' };
  return { ok: true, value: { open: value.open } };
}
