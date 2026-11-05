import { useCatalogPages } from './catalog-paging';
import { CatalogPagingControls } from './catalog-paging-controls';
import type { BroadcastResponse, GuestSessionResponse } from '@stageflow/shared';
import { Link } from 'react-router';
import { replayHref } from './history';
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
  const page = useCatalogPages(roomBroadcastsQueryOptions(session, slug));
  const { items } = page;

  return (
    <div role="region" aria-label={`Recordings for ${title}`} className="mt-4 grid gap-3">
      {items.length > 0 && (
        <ul className="m-0 grid list-none gap-3 p-0">
          {items.map((broadcast) => (
            <BroadcastRow key={broadcast.id} broadcast={broadcast} token={session.token} />
          ))}
        </ul>
      )}
      <CatalogPagingControls
        page={page}
        name="recordings"
        empty="This room has no broadcast attempts."
      />
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
