import { queryOptions, skipToken, type QueryClient } from '@tanstack/react-query';
import type { GuestSessionResponse } from '@stageflow/shared';
import { getRoom, listBroadcasts, listRooms, listReplayDeletions } from './api';
import { useSessionStore } from '../session/session-store';
import { catalogQueryOptions } from './catalog-paging';

export function roomQueryOptions(slug: string, session: GuestSessionResponse | null) {
  return queryOptions({
    queryKey: ['private', session?.userId ?? null, 'room', slug],
    queryFn: session ? ({ signal }) => getRoom(slug, session.token, signal) : skipToken,
    retry: false,
  });
}

export function roomsQueryOptions(session: GuestSessionResponse | null) {
  return catalogQueryOptions(
    ['private', session?.userId ?? null, 'rooms'],
    session ? (cursor, signal) => listRooms(session.token, cursor, signal) : skipToken,
  );
}

export function roomBroadcastsQueryOptions(session: GuestSessionResponse | null, slug: string) {
  return catalogQueryOptions(
    ['private', session?.userId ?? null, 'room-broadcasts', slug],
    session ? (cursor, signal) => listBroadcasts(slug, session.token, cursor, signal) : skipToken,
  );
}

export function bindSessionCache(client: QueryClient): () => void {
  return useSessionStore.subscribe((state, previous) => {
    if (state.session === previous.session) return;
    void client.cancelQueries({ queryKey: ['private'] });
    client.removeQueries({ queryKey: ['private'] });
  });
}

export function replayDeletionsQueryOptions(session: GuestSessionResponse | null, slug: string) {
  return catalogQueryOptions(
    ['private', session?.userId ?? null, 'replay-deletions', slug],
    session
      ? (cursor, signal) => listReplayDeletions(slug, session.token, cursor, signal)
      : skipToken,
  );
}
