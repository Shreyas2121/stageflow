import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { MemoryRouter } from 'react-router';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import type { BroadcastResponse } from '@stageflow/shared';
import { RoomHistory } from './room-history';
import { roomBroadcastsQueryOptions } from './query-options';
import { describe, expect, it } from 'vitest';
import { mergeById, replayHref, updateBroadcastPages } from './history';

const id = '11111111-1111-4111-8111-111111111111';
const playlistUrl = `/api/broadcasts/${id}/hls/index.m3u8`;

describe('replayHref', () => {
  it('links only a READY row whose playlist is a catalog playlist', () => {
    expect(replayHref({ id, status: 'READY', playlistUrl })).toBe(`/replay/${id}`);
    for (const status of ['STARTING', 'LIVE', 'STOPPING', 'FAILED'] as const) {
      expect(replayHref({ id, status, playlistUrl })).toBeNull();
    }
    expect(replayHref({ id, status: 'READY', playlistUrl: null })).toBeNull();
    expect(
      replayHref({ id, status: 'READY', playlistUrl: 'https://cdn.example/live.m3u8' }),
    ).toBeNull();
    expect(
      replayHref({
        id,
        status: 'READY',
        playlistUrl: `/api/broadcasts/${id}/hls/segment000001.ts`,
      }),
    ).toBeNull();
  });
});

describe('mergeById', () => {
  it('keeps the earlier row when a later page repeats an id', () => {
    expect(
      mergeById([
        [{ id: 'a', n: 1 }],
        [
          { id: 'a', n: 2 },
          { id: 'b', n: 3 },
        ],
      ]),
    ).toEqual([
      { id: 'a', n: 1 },
      { id: 'b', n: 3 },
    ]);
  });
});

function replay(
  status: BroadcastResponse['status'] = 'READY',
  visibility: BroadcastResponse['visibility'] = 'LINK',
): BroadcastResponse {
  return {
    id,
    roomId: '22222222-2222-4222-8222-222222222222',
    status,
    visibility,
    playlistUrl,
    thumbnailUrl: null,
    errorMessage: null,
    createdAt: '2026-11-05T00:00:00.000Z',
    startedAt: '2026-11-05T00:00:00.000Z',
    endedAt: null,
  };
}

it('updates or removes every loaded copy without losing cursors or mutating the old pages', () => {
  const original = replay();
  const other = { ...original, id: 'other' };
  const data = {
    pages: [
      { items: [original, other], nextCursor: 'cursor' },
      { items: [original], nextCursor: null },
    ],
    pageParams: [null, 'cursor'],
  };
  const hidden = { ...original, visibility: 'HOST' as const };
  expect(updateBroadcastPages(data, id, hidden)).toEqual({
    ...data,
    pages: [
      { items: [hidden, other], nextCursor: 'cursor' },
      { items: [hidden], nextCursor: null },
    ],
  });
  expect(updateBroadcastPages(data, id, null)).toEqual({
    ...data,
    pages: [
      { items: [other], nextCursor: 'cursor' },
      { items: [], nextCursor: null },
    ],
  });
  expect(data.pages[0]?.items[0]).toBe(original);
  expect(updateBroadcastPages(undefined, id, hidden)).toBeUndefined();
});

it('shows visibility to guests and offers finished-row controls only to registered hosts', () => {
  const session = { token: 'token', userId: 'owner', displayName: 'Owner' };
  for (const isHost of [true, false]) {
    for (const status of ['STARTING', 'LIVE', 'STOPPING', 'READY', 'FAILED'] as const) {
      for (const visibility of ['LINK', 'HOST'] as const) {
        const client = new QueryClient();
        const options = roomBroadcastsQueryOptions(session, 'RoomSlug001');
        client.setQueryData(options.queryKey, {
          pages: [{ items: [replay(status, visibility)], nextCursor: null }],
          pageParams: [null],
        });
        const html = renderToStaticMarkup(
          createElement(
            QueryClientProvider,
            { client },
            createElement(
              MemoryRouter,
              null,
              createElement(RoomHistory, { session, slug: 'RoomSlug001', title: 'Review', isHost }),
            ),
          ),
        );
        expect(html).toContain(visibility === 'LINK' ? 'Anyone with the link' : 'Only you');
        const canManage = isHost && (status === 'READY' || status === 'FAILED');
        expect(html.includes('Delete replay')).toBe(canManage);
        expect(html.includes(visibility === 'LINK' ? 'Hide replay' : 'Share replay')).toBe(
          canManage,
        );
        expect(html).not.toContain('Delete this replay');
        client.clear();
      }
    }
  }
});
