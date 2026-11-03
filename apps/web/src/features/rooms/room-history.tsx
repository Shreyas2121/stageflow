import type { BroadcastResponse, GuestSessionResponse } from '@stageflow/shared';
import { useQueries } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { Button } from '../../components/ui/button';
import { mergeById, replayHref } from './history';
import { roomBroadcastsQueryOptions } from './query-options';
import { Thumbnail } from './thumbnail';

function trimmed(message: string | null): string {
  return message?.trim() ?? '';
}

export function RoomHistory({
  session,
  slug,
  title,
}: {
  session: GuestSessionResponse;
  slug: string;
  title: string;
}) {
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const queries = useQueries({
    queries: cursors.map((cursor) => roomBroadcastsQueryOptions(session, slug, cursor)),
  });
  const items = mergeById(queries.flatMap((query) => (query.data ? [query.data.items] : [])));
  let nextCursor: string | null = null;
  for (let index = queries.length - 1; index >= 0; index -= 1) {
    const data = queries[index]?.data;
    if (!data) continue;
    nextCursor = data.nextCursor;
    break;
  }
  const latest = queries[queries.length - 1];
  const first = queries[0];

  function loadMore() {
    if (latest?.isError) {
      void latest.refetch();
      return;
    }
    if (!nextCursor) return;
    setCursors((current) => (current.includes(nextCursor) ? current : [...current, nextCursor]));
  }

  return (
    <div role="region" aria-label={`Recordings for ${title}`} className="mt-4 grid gap-3">
      {first?.isPending && (
        <p className="text-sm text-muted" role="status">
          Loading recordings…
        </p>
      )}
      {first?.isError && (
        <p className="text-sm text-danger wrap-anywhere" role="alert">
          {first.error.message}
        </p>
      )}
      {first?.isSuccess && items.length === 0 && (
        <p className="text-sm text-muted">This room has no broadcast attempts.</p>
      )}
      {items.length > 0 && (
        <ul className="m-0 grid list-none gap-3 p-0">
          {items.map((broadcast) => (
            <BroadcastRow key={broadcast.id} broadcast={broadcast} token={session.token} />
          ))}
        </ul>
      )}
      {queries.length > 1 && latest?.isError && (
        <p className="text-sm text-danger wrap-anywhere" role="alert">
          {latest.error.message}
        </p>
      )}
      {nextCursor !== null && (
        <Button type="button" disabled={Boolean(latest?.isPending)} onClick={loadMore}>
          Load more
        </Button>
      )}
    </div>
  );
}

function BroadcastRow({ broadcast, token }: { broadcast: BroadcastResponse; token: string }) {
  const href = replayHref(broadcast);
  const reason = trimmed(broadcast.errorMessage);
  return (
    <li className="flex items-start gap-3 rounded-control border border-line p-3">
      <Thumbnail url={broadcast.thumbnailUrl} token={token} status={broadcast.status} />
      <div className="min-w-0">
        <p className="m-0 text-xs font-semibold tracking-wide">{broadcast.status}</p>
        {reason && <p className="mt-1 mb-0 text-sm text-muted wrap-anywhere">{reason}</p>}
        {href && (
          <Link
            to={href}
            className="mt-2 inline-flex min-h-11 items-center text-xs font-semibold text-accent underline-offset-4 hover:underline"
          >
            Watch replay
          </Link>
        )}
      </div>
    </li>
  );
}
