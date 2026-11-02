import { join } from 'node:path';
import { pathToFileURL } from 'node:url';

type ShutdownServer = { close(): Promise<void> };
type ShutdownModule = {
  startShutdownServer(options: {
    channel: string;
    token: string;
    onShutdown(): Promise<void>;
  }): Promise<ShutdownServer>;
};

/**
 * Opens the supervisor's local shutdown channel before the process owns Redis.
 * `scripts/dev-shutdown.mjs` is the channel implementation shared with the dev supervisor.
 * The relative path is the same from `src/` under Vitest and from Nest's `dist/` emit.
 * The API package compiles to CommonJS, so this uses `__dirname` rather than `import.meta`.
 */
export async function bindDevShutdown(
  close: () => Promise<void>,
): Promise<ShutdownServer | undefined> {
  const channel = process.env.STAGEFLOW_DEV_SHUTDOWN;
  const token = process.env.STAGEFLOW_DEV_SHUTDOWN_TOKEN;
  if (!channel && !token) return undefined;
  if (!channel || !token)
    throw new Error('Dev shutdown channel requires a local path and a token.');
  if (process.env.NODE_ENV === 'production') {
    throw new Error('Dev shutdown channel is not available in production.');
  }
  const moduleUrl = pathToFileURL(join(__dirname, '../../../scripts/dev-shutdown.mjs'));
  const shutdown = (await import(moduleUrl.href)) as ShutdownModule;
  let closing = false;
  return shutdown.startShutdownServer({
    channel,
    token,
    onShutdown: async () => {
      if (closing) return;
      closing = true;
      await close();
    },
  });
}
