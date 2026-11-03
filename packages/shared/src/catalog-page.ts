import type { ParseResult } from './contracts';
import { isUuid } from './identifiers';

/**
 * Catalog page size and history cursor.
 * These parsers do not read a store and do not grant access to a row.
 */
export const CATALOG_PAGE_DEFAULT = 20;
export const CATALOG_PAGE_MAX = 50;

const PAGE_MESSAGE = 'Choose a page size from 1 to 50.';
const CURSOR_MESSAGE = 'That page cursor is not valid.';
const CATALOG_INSTANT = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const BASE64URL_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_';

export type HistoryCursor = {
  createdAt: string;
  id: string;
};

function invalidPage(): ParseResult<number> {
  return { ok: false, error: 'invalid_page', message: PAGE_MESSAGE };
}

function invalidCursor(): ParseResult<HistoryCursor | null> {
  return { ok: false, error: 'invalid_cursor', message: CURSOR_MESSAGE };
}

function isCanonicalInstant(value: string): boolean {
  if (!CATALOG_INSTANT.test(value)) return false;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) && new Date(parsed).toISOString() === value;
}

function encodeBase64Url(bytes: Uint8Array): string {
  let encoded = '';
  for (let index = 0; index < bytes.length; index += 3) {
    const first = bytes.at(index);
    const second = bytes.at(index + 1);
    const third = bytes.at(index + 2);
    if (first === undefined) break;
    encoded += BASE64URL_ALPHABET.charAt(first >> 2);
    if (second === undefined) {
      encoded += BASE64URL_ALPHABET.charAt((first & 0x03) << 4);
      break;
    }
    encoded += BASE64URL_ALPHABET.charAt(((first & 0x03) << 4) | (second >> 4));
    if (third === undefined) {
      encoded += BASE64URL_ALPHABET.charAt((second & 0x0f) << 2);
      break;
    }
    encoded += BASE64URL_ALPHABET.charAt(((second & 0x0f) << 2) | (third >> 6));
    encoded += BASE64URL_ALPHABET.charAt(third & 0x3f);
  }
  return encoded;
}

function decodeBase64Url(value: string): Uint8Array | null {
  if (value.length === 0 || value.length % 4 === 1) return null;
  const digits: number[] = [];
  for (const character of value) {
    const digit = BASE64URL_ALPHABET.indexOf(character);
    if (digit < 0) return null;
    digits.push(digit);
  }
  const bytes: number[] = [];
  for (let index = 0; index < digits.length; index += 4) {
    const first = digits[index];
    const second = digits[index + 1];
    const third = digits[index + 2];
    const fourth = digits[index + 3];
    if (first === undefined || second === undefined) return null;
    bytes.push((first << 2) | (second >> 4));
    if (third === undefined) break;
    bytes.push(((second & 0x0f) << 4) | (third >> 2));
    if (fourth === undefined) break;
    bytes.push(((third & 0x03) << 6) | fourth);
  }
  const decoded = Uint8Array.from(bytes);
  if (encodeBase64Url(decoded) !== value) return null;
  return decoded;
}

export function parseCatalogLimit(input: unknown): ParseResult<number> {
  if (input === undefined) return { ok: true, value: CATALOG_PAGE_DEFAULT };
  if (typeof input !== 'string' || !/^[1-9][0-9]?$/.test(input)) return invalidPage();
  const value = Number(input);
  if (value < 1 || value > CATALOG_PAGE_MAX) return invalidPage();
  return { ok: true, value };
}

/** Unpadded base64url of `v1`, the catalog instant, and the lowercase id. Null when either part is unusable. */
export function encodeHistoryCursor(createdAt: string, id: string): string | null {
  if (typeof createdAt !== 'string' || typeof id !== 'string') return null;
  if (!isCanonicalInstant(createdAt) || !isUuid(id)) return null;
  const payload = `v1\n${createdAt}\n${id.toLowerCase()}`;
  return encodeBase64Url(new TextEncoder().encode(payload));
}

export function parseHistoryCursor(input: unknown): ParseResult<HistoryCursor | null> {
  if (input === undefined || input === null || input === '') return { ok: true, value: null };
  if (typeof input !== 'string') return invalidCursor();
  const bytes = decodeBase64Url(input);
  if (!bytes) return invalidCursor();
  let text: string;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    return invalidCursor();
  }
  const parts = text.split('\n');
  if (parts.length !== 3) return invalidCursor();
  const version = parts[0];
  const createdAt = parts[1];
  const id = parts[2];
  if (version !== 'v1' || !createdAt || !id) return invalidCursor();
  if (!isCanonicalInstant(createdAt) || !isUuid(id) || id !== id.toLowerCase())
    return invalidCursor();
  return { ok: true, value: { createdAt, id } };
}
