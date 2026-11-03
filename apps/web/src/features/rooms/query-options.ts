import { queryOptions, skipToken, type QueryClient } from '@tanstack/react-query';
import type { GuestSessionResponse } from '@stageflow/shared';
import { getRoom, listBroadcasts, listRooms } from './api';
import { useSessionStore } from '../session/session-store';

export function roomQueryOptions(slug: string, session: GuestSessionResponse | null) {
  return queryOptions({
    queryKey: ['private', session?.userId ?? null, 'room', slug],
    queryFn: session ? ({ signal }) => getRoom(slug, session.token, signal) : skipToken,
    retry: false,
  });
}

export function roomsQueryOptions(session: GuestSessionResponse | null, cursor: string | null) {
  return queryOptions({
    queryKey: ['private', session?.userId ?? null, 'rooms', cursor],
    queryFn: session ? ({ signal }) => listRooms(session.token, cursor, signal) : skipToken,
    retry: false,
  });
}

export function roomBroadcastsQueryOptions(
  session: GuestSessionResponse | null,
  slug: string,
  cursor: string | null,
) {
  return queryOptions({
    queryKey: ['private', session?.userId ?? null, 'room-broadcasts', slug, cursor],
    queryFn: session
      ? ({ signal }) => listBroadcasts(slug, session.token, cursor, signal)
      : skipToken,
    retry: false,
  });
}

export function bindSessionCache(client: QueryClient): () => void {
  return useSessionStore.subscribe((state, previous) => {
    if (state.session === previous.session) return;
    void client.cancelQueries({ queryKey: ['private'] });
    client.removeQueries({ queryKey: ['private'] });
  });
}
