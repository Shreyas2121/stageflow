import { queryOptions, skipToken } from '@tanstack/react-query';
import { isUuid, type GuestSessionResponse } from '@stageflow/shared';
import { getBroadcast } from './api';

export function broadcastQueryOptions(id: string, session: GuestSessionResponse | null) {
  return queryOptions({
    queryKey: ['private', session?.userId ?? null, 'broadcast', id],
    queryFn:
      session && isUuid(id) ? ({ signal }) => getBroadcast(id, session.token, signal) : skipToken,
    retry: false,
  });
}
