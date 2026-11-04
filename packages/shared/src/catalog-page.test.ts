import { describe, expect, it } from 'vitest';
import {
  CATALOG_PAGE_DEFAULT,
  CATALOG_PAGE_MAX,
  encodeHistoryCursor,
  parseCatalogLimit,
  parseHistoryCursor,
} from './index';

const createdAt = '2026-11-03T15:04:05.006Z';
const ordering = '2026-11-03T15:04:05.123900Z';
const id = '550e8400-e29b-41d4-a716-446655440000';
const cursor =
  'djEKMjAyNi0xMS0wM1QxNTowNDowNS4wMDZaCjU1MGU4NDAwLWUyOWItNDFkNC1hNzE2LTQ0NjY1NTQ0MDAwMA';
const orderingCursor =
  'djIKMjAyNi0xMS0wM1QxNTowNDowNS4xMjM5MDBaCjU1MGU4NDAwLWUyOWItNDFkNC1hNzE2LTQ0NjY1NTQ0MDAwMA';
const pageFailure = {
  ok: false as const,
  error: 'invalid_page' as const,
  message: 'Choose a page size from 1 to 50.',
};
const cursorFailure = {
  ok: false as const,
  error: 'invalid_cursor' as const,
  message: 'That page cursor is not valid.',
};

describe('parseCatalogLimit', () => {
  it('uses 20 when the limit is missing and accepts an unpadded size from 1 to 50', () => {
    expect(CATALOG_PAGE_DEFAULT).toBe(20);
    expect(CATALOG_PAGE_MAX).toBe(50);
    expect(parseCatalogLimit(undefined)).toEqual({ ok: true, value: 20 });
    expect(parseCatalogLimit('20')).toEqual({ ok: true, value: 20 });
    expect(parseCatalogLimit('1')).toEqual({ ok: true, value: 1 });
    expect(parseCatalogLimit('50')).toEqual({ ok: true, value: 50 });
  });

  it.each(['0', '51', '020', '', '   ', ['20'], 20, null])('rejects %j', (input) => {
    expect(parseCatalogLimit(input)).toEqual(pageFailure);
  });
});

describe('history cursor', () => {
  it('round-trips a canonical instant and a lowercase id', () => {
    expect(encodeHistoryCursor(createdAt, id)).toBe(cursor);
    expect(encodeHistoryCursor(createdAt, id.toUpperCase())).toBe(cursor);
    expect(cursor.includes('=')).toBe(false);
    expect(parseHistoryCursor(cursor)).toEqual({ ok: true, value: { createdAt, id } });
  });

  it('round-trips a microsecond ordering instant as v2 and keeps an issued v1 cursor', () => {
    expect(encodeHistoryCursor(ordering, id)).toBe(orderingCursor);
    expect(encodeHistoryCursor(ordering, id.toUpperCase())).toBe(orderingCursor);
    expect(orderingCursor.includes('=')).toBe(false);
    expect(parseHistoryCursor(orderingCursor)).toEqual({
      ok: true,
      value: { createdAt: ordering, id },
    });
    expect(parseHistoryCursor(cursor)).toEqual({ ok: true, value: { createdAt, id } });
    expect(encodeHistoryCursor('2024-02-29T00:00:00.000000Z', id)).not.toBeNull();
  });

  it('treats a missing or empty cursor as the first page', () => {
    expect(parseHistoryCursor(undefined)).toEqual({ ok: true, value: null });
    expect(parseHistoryCursor(null)).toEqual({ ok: true, value: null });
    expect(parseHistoryCursor('')).toEqual({ ok: true, value: null });
  });

  it('rejects a padded base64 value and a cursor whose instant is not canonical', () => {
    const shifted =
      'djEKMjAyMC0wMi0zMVQwMDowMDowMC4wMDBaCjU1MGU4NDAwLWUyOWItNDFkNC1hNzE2LTQ0NjY1NTQ0MDAwMA';
    expect(encodeHistoryCursor('2020-02-31T00:00:00.000Z', id)).toBeNull();
    expect(encodeHistoryCursor('2020-02-31T00:00:00.000000Z', id)).toBeNull();
    expect(encodeHistoryCursor('2023-02-29T00:00:00.000000Z', id)).toBeNull();
    expect(encodeHistoryCursor(ordering.slice(0, -1), id)).toBeNull();
    expect(encodeHistoryCursor(createdAt, 'not-a-uuid')).toBeNull();
    expect(parseHistoryCursor(`${cursor}=`)).toEqual(cursorFailure);
    expect(parseHistoryCursor(`${cursor}==`)).toEqual(cursorFailure);
    expect(parseHistoryCursor(shifted)).toEqual(cursorFailure);
    expect(
      parseHistoryCursor(
        'djEKMjAyNi0xMS0wM1QxNTowNDowNS4xMjM5MDBaCjU1MGU4NDAwLWUyOWItNDFkNC1hNzE2LTQ0NjY1NTQ0MDAwMA',
      ),
    ).toEqual(cursorFailure);
    expect(
      parseHistoryCursor(
        'djIKMjAyNi0xMS0wM1QxNTowNDowNS4wMDZaCjU1MGU4NDAwLWUyOWItNDFkNC1hNzE2LTQ0NjY1NTQ0MDAwMA',
      ),
    ).toEqual(cursorFailure);
    expect(
      parseHistoryCursor(
        'djMKMjAyNi0xMS0wM1QxNTowNDowNS4xMjM5MDBaCjU1MGU4NDAwLWUyOWItNDFkNC1hNzE2LTQ0NjY1NTQ0MDAwMA',
      ),
    ).toEqual(cursorFailure);
  });
});
