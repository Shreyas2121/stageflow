import { timingSafeEqual } from 'node:crypto';
import { rm } from 'node:fs/promises';
import net from 'node:net';
import { tmpdir } from 'node:os';
import { isAbsolute, join, resolve, sep } from 'node:path';

const ID_PATTERN = /^[A-Za-z0-9-]{8,80}$/;

/** Local channel for one API process. Not an HTTP route and not a public bind. */
export function devShutdownPath(id) {
  if (!ID_PATTERN.test(id)) throw new Error('Invalid dev shutdown id.');
  if (process.platform === 'win32') return `\\\\.\\pipe\\stageflow-dev-${id}`;
  return join(tmpdir(), `stageflow-dev-${id}.sock`);
}

export function assertDevShutdownPath(channel) {
  if (typeof channel !== 'string' || channel.length > 256) {
    throw new Error('Dev shutdown channel must be a local stageflow pipe or socket.');
  }
  if (process.platform === 'win32') {
    if (!/^\\\\\.\\pipe\\stageflow-dev-[A-Za-z0-9-]{8,80}$/.test(channel)) {
      throw new Error('Dev shutdown channel must be a local stageflow named pipe.');
    }
    return;
  }
  const root = resolve(tmpdir());
  const resolved = resolve(channel);
  if (
    !isAbsolute(resolved) ||
    (resolved !== root && !resolved.startsWith(root + sep)) ||
    !resolved.endsWith('.sock') ||
    !/stageflow-dev-[A-Za-z0-9-]{8,80}\.sock$/.test(resolved)
  ) {
    throw new Error('Dev shutdown channel must be a local socket under the temp directory.');
  }
}

function tokenMatches(expected, received) {
  const left = Buffer.from(expected);
  const right = Buffer.from(received);
  return left.length === right.length && left.length > 0 && timingSafeEqual(left, right);
}

export async function startShutdownServer({ channel, token, onShutdown }) {
  assertDevShutdownPath(channel);
  if (typeof token !== 'string' || token.length < 16) {
    throw new Error('Dev shutdown token is missing.');
  }
  let accepted = false;
  const server = net.createServer((socket) => {
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('data', (chunk) => {
      buffer += chunk;
      const newline = buffer.indexOf('\n');
      if (newline === -1) {
        if (buffer.length > 256) socket.end('denied\n');
        return;
      }
      const line = buffer.slice(0, newline);
      if (!tokenMatches(token, line)) {
        socket.end('denied\n');
        return;
      }
      if (accepted) {
        socket.end('busy\n');
        return;
      }
      accepted = true;
      // Reply before closing Nest so the supervisor observes acceptance even if close is slow.
      socket.end('ok\n', () => {
        void Promise.resolve(onShutdown()).catch((error) => {
          console.error(error instanceof Error ? error.message : error);
        });
      });
    });
  });
  return new Promise((resolveServer, reject) => {
    const fail = (error) => reject(error);
    server.once('error', fail);
    void (async () => {
      if (process.platform !== 'win32') await rm(channel, { force: true });
      server.listen(channel, () => {
        server.off('error', fail);
        resolveServer({
          close() {
            return new Promise((done) => {
              server.close(() => done());
            });
          },
        });
      });
    })().catch(fail);
  });
}

export function requestDevShutdown(channel, token, timeoutMs = 1000) {
  assertDevShutdownPath(channel);
  return new Promise((resolveRequest, reject) => {
    const socket = net.connect(channel);
    let settled = false;
    const finish = (error, value) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      if (error) reject(error);
      else resolveRequest(value);
    };
    const timer = setTimeout(() => {
      finish(new Error('Dev shutdown channel timed out.'));
    }, timeoutMs);
    let buffer = '';
    socket.setEncoding('utf8');
    socket.on('connect', () => socket.write(`${token}\n`));
    socket.on('data', (chunk) => {
      buffer += chunk;
      if (!buffer.includes('\n')) return;
      const line = buffer.slice(0, buffer.indexOf('\n'));
      if (line === 'ok') finish(null, undefined);
      else finish(new Error('Dev shutdown channel refused the request.'));
    });
    socket.on('error', (error) => finish(error));
  });
}
