import { raw } from 'express';

// Mounted only on the upload route, after HTTP admission and before the JSON parser.
export const broadcastChunkParser = raw({
  type: 'application/octet-stream',
  limit: 2_000_000,
  inflate: false,
});
