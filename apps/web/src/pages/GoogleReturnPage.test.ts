import { expect, it } from 'vitest';
import { parseGoogleReturn } from './GoogleReturnPage';
it('accepts one ticket or the link success marker', () => {
  expect(parseGoogleReturn('?ticket=one-time')).toEqual({ kind: 'ticket', ticket: 'one-time' });
  expect(parseGoogleReturn('?linked=1')).toEqual({ kind: 'linked' });
});
it.each([
  '',
  '?ticket=',
  '?ticket=a&ticket=b',
  '?ticket=a&linked=1',
  '?linked=0',
  '?token=forged',
  '?error=unknown',
  '?returnUrl=https://evil.test',
  '?error=google_rejected',
])('rejects unsupported return query %s', (search) => {
  expect(parseGoogleReturn(search)).toEqual({
    kind: 'error',
    message: 'Google did not confirm this sign-in.',
  });
});
it('shows the linked-account conflict without accepting provider text', () => {
  expect(parseGoogleReturn('?error=google_linked')).toEqual({
    kind: 'error',
    message: 'That Google account is already linked to another user.',
  });
  expect(parseGoogleReturn('?error=google_linked&message=forged')).toEqual({
    kind: 'error',
    message: 'Google did not confirm this sign-in.',
  });
});
