import { isIP } from 'node:net';
import type { IncomingMessage } from 'node:http';
import { normalizeAddress } from '../config/parse-config';

export function networkIdentity(
  request: Pick<IncomingMessage, 'headers'> & { socket: { remoteAddress?: string } },
  trusted: readonly string[],
): string {
  const remote = normalizeAddress(request.socket.remoteAddress ?? 'unknown');
  const forwarded = request.headers['x-forwarded-for'];
  if (!trusted.includes(remote) || typeof forwarded !== 'string' || forwarded.length > 2048)
    return remote;
  const chain = forwarded.split(',').map((value) => value.trim());
  if (chain.length > 16 || chain.some((value) => !isIP(value))) return remote;
  let address = remote;
  for (const next of chain.reverse()) {
    if (!trusted.includes(address)) break;
    address = normalizeAddress(next);
  }
  return address;
}
