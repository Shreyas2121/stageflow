import { ROOM_SLUG_LENGTH } from './limits';
export function isUuid(value: unknown): value is string {
  return (
    typeof value === 'string' &&
    value.length === 36 &&
    /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value)
  );
}
export function isRoomSlug(value: unknown): value is string {
  return (
    typeof value === 'string' && value.length === ROOM_SLUG_LENGTH && /^[A-Za-z0-9]+$/.test(value)
  );
}
const slugAlphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

export function createRoomSlug(nextByte: () => number): string {
  let slug = '';
  let consecutiveRejects = 0;
  while (slug.length < ROOM_SLUG_LENGTH) {
    const byte = nextByte();
    if (!Number.isInteger(byte) || byte < 0 || byte > 255) throw new Error('invalid_slug_byte');
    if (byte >= 248) {
      consecutiveRejects += 1;
      if (consecutiveRejects === 32) throw new Error('slug_source_exhausted');
      continue;
    }
    consecutiveRejects = 0;
    slug += slugAlphabet.charAt(byte % slugAlphabet.length);
  }
  return slug;
}

export function createRoomSlugFromCrypto(): string {
  const bytes = new Uint8Array(1);
  return createRoomSlug(() => {
    crypto.getRandomValues(bytes);
    return bytes[0]!;
  });
}
