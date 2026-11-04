import { isUuid } from './identifiers';
import {
  CHAT_HISTORY_DEFAULT_LIMIT,
  CHAT_HISTORY_MAX_LIMIT,
  CHAT_TEXT_MAX_BYTES,
  CHAT_TEXT_MAX_LENGTH,
  CHAT_TEXT_MIN_LENGTH,
} from './limits';
import type { ParticipantRole } from './stage';

export type ChatSendRequest = { requestId: string; text: string };
export type ChatHistoryRequest = { beforeSequence?: number; limit?: number };
export type ChatSetPausedRequest = { paused: boolean };

export type ChatMessage = {
  sequence: number;
  participantId: string;
  displayName: string;
  role: ParticipantRole;
  text: string;
  /** Server clock in milliseconds since the Unix epoch. */
  sentAt: number;
};

export type ChatHistoryResult = {
  paused: boolean;
  /** Bounds of the retained room history; both are null when it is empty. */
  oldestSequence: number | null;
  latestSequence: number | null;
  retentionGap: boolean;
  /** The requested page in ascending sequence order. */
  messages: ChatMessage[];
};

export type ChatParseResult<T> =
  { ok: true; value: T } | { ok: false; error: 'invalid_payload' | 'chat_invalid' };

function hasOnlyFields(value: unknown, fields: string[]): value is Record<string, unknown> {
  return (
    typeof value === 'object' &&
    value !== null &&
    !Array.isArray(value) &&
    Object.keys(value).every((key) => fields.includes(key))
  );
}

export function parseChatSendRequest(value: unknown): ChatParseResult<ChatSendRequest> {
  if (
    !hasOnlyFields(value, ['requestId', 'text']) ||
    !isUuid(value.requestId) ||
    typeof value.text !== 'string'
  )
    return { ok: false, error: 'invalid_payload' };

  const text = value.text.trim();
  if (
    text.length < CHAT_TEXT_MIN_LENGTH ||
    text.length > CHAT_TEXT_MAX_LENGTH ||
    new TextEncoder().encode(text).byteLength > CHAT_TEXT_MAX_BYTES
  )
    return { ok: false, error: 'chat_invalid' };

  return { ok: true, value: { requestId: value.requestId, text } };
}

/** Missing fields select the latest default page; numeric cursors are exclusive. */
export function parseChatHistoryRequest(
  value: unknown,
): ChatParseResult<ChatHistoryRequest & { limit: number }> {
  const body = value === undefined ? {} : value;
  if (!hasOnlyFields(body, ['beforeSequence', 'limit']))
    return { ok: false, error: 'invalid_payload' };

  const { beforeSequence } = body;
  const limit = body.limit === undefined ? CHAT_HISTORY_DEFAULT_LIMIT : body.limit;
  if (
    (beforeSequence !== undefined &&
      (typeof beforeSequence !== 'number' ||
        !Number.isSafeInteger(beforeSequence) ||
        beforeSequence < 1)) ||
    typeof limit !== 'number' ||
    !Number.isInteger(limit) ||
    limit < 1 ||
    limit > CHAT_HISTORY_MAX_LIMIT
  )
    return { ok: false, error: 'invalid_payload' };

  return {
    ok: true,
    value: { ...(beforeSequence === undefined ? {} : { beforeSequence }), limit },
  };
}

export function parseChatSetPausedRequest(value: unknown): ChatParseResult<ChatSetPausedRequest> {
  if (!hasOnlyFields(value, ['paused']) || typeof value.paused !== 'boolean')
    return { ok: false, error: 'invalid_payload' };
  return { ok: true, value: { paused: value.paused } };
}
