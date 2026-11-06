export const STAGE_CAPACITY = 4;
export const RECONNECT_GRACE_MS = 20_000;
export const DISPLAY_NAME_MAX_LENGTH = 40;
export const ROOM_TITLE_MAX_LENGTH = 80;
export const ROOM_SLUG_LENGTH = 12;
// UTF-16 code-unit budgets, enforced before queuing or forwarding signaling.
export const SDP_MAX_LENGTH = 65_536;
export const ICE_CANDIDATE_MAX_LENGTH = 4_096;
export const ICE_UFRAG_MAX_LENGTH = 256;
export const PARTICIPANT_ID_MAX_LENGTH = 128;
export const SDP_MID_MAX_LENGTH = 256;
export const SDP_MLINE_INDEX_MAX = 65_535;

// Chat text is trimmed before applying the UTF-16 code-unit and UTF-8 byte bounds.
export const CHAT_TEXT_MIN_LENGTH = 1;
export const CHAT_TEXT_MAX_LENGTH = 1_000;
export const CHAT_TEXT_MAX_BYTES = 4_000;
export const CHAT_MESSAGE_RETENTION = 500;
export const CHAT_IDLE_TTL_SECONDS = 86_400;
export const CHAT_HISTORY_DEFAULT_LIMIT = 50;
export const CHAT_HISTORY_MAX_LIMIT = 100;
export const CHAT_PARTICIPANT_RATE_LIMIT = 10;
export const CHAT_ROOM_RATE_LIMIT = 100;
export const CHAT_RATE_WINDOW_MS = 10_000;
export const CHAT_DEDUP_MAX_ENTRIES = 500;
export const CHAT_MAX_PENDING_SENDS = 5;
export const CHAT_USER_RATE_MAX_FIELDS = 1_000;
export const CHAT_MAX_QUEUED_OPERATIONS = 32;

// Question text is trimmed before applying the UTF-16 code-unit and UTF-8 byte bounds.
export const QA_TEXT_MIN_LENGTH = 1;
export const QA_TEXT_MAX_LENGTH = 200;
export const QA_TEXT_MAX_BYTES = 1_000;
export const QA_BOARD_MAX = 100;
export const QA_SUBMIT_PARTICIPANT_LIMIT = 5;
export const QA_SUBMIT_ROOM_LIMIT = 30;
export const QA_VOTE_PARTICIPANT_LIMIT = 20;
export const QA_VOTE_ROOM_LIMIT = 100;
export const QA_RATE_WINDOW_MS = 10_000;
export const QA_USER_RATE_MAX_FIELDS = 1_000;
export const QA_MAX_QUEUED_OPERATIONS = 32;
export const QA_IDLE_TTL_SECONDS = 86_400;
