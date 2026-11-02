import { expect, it } from 'vitest';
import { networkIdentity } from './network-identity';
const request = (remoteAddress: string, forwarded: string) => ({
  socket: { remoteAddress },
  headers: { 'x-forwarded-for': forwarded },
});
it('ignores spoofed forwarding headers from untrusted peers and walks only trusted hops', () => {
  expect(networkIdentity(request('fe80:0:0:0:0:0:0:1%eth0', '1.2.3.4'), [])).toBe('fe80::1%eth0');
  expect(networkIdentity(request('::ffff:127.0.0.1', '1.2.3.4'), [])).toBe('127.0.0.1');
  expect(networkIdentity(request('127.0.0.1', '9.9.9.9, 1.2.3.4'), ['127.0.0.1'])).toBe('1.2.3.4');
  expect(networkIdentity(request('127.0.0.1', '9.9.9.9, 1.2.3.4'), ['127.0.0.1', '1.2.3.4'])).toBe(
    '9.9.9.9',
  );
  expect(networkIdentity(request('127.0.0.1', 'garbage'), ['127.0.0.1'])).toBe('127.0.0.1');
  expect(networkIdentity(request('127.0.0.1', '2001:0db8:0:0:0:0:0:1'), ['127.0.0.1'])).toBe(
    '2001:db8::1',
  );
});
