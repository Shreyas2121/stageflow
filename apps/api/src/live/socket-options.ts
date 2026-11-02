import type { IncomingMessage } from 'node:http';
import { env } from '../config/env';
export const socketOptions = {
  cors: { origin: env.CORS_ORIGIN },
  maxHttpBufferSize: env.SOCKET_MESSAGE_BYTES,
  allowRequest: (
    request: IncomingMessage,
    callback: (error: string | null, success: boolean) => void,
  ) => {
    const allowed = !request.headers.origin || request.headers.origin === env.CORS_ORIGIN;
    callback(allowed ? null : 'Origin not allowed.', allowed);
  },
};
