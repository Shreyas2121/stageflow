import type { GuestSessionResponse, RoomResponse } from '@stageflow/shared';
import { useQueries } from '@tanstack/react-query';
import { useState } from 'react';
import { Link } from 'react-router';
import { Button } from '../../components/ui/button';
import { mergeById } from './history';
import { roomsQueryOptions } from './query-options';
import { RoomHistory } from './room-history';

function catalogTimeLabel(value: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return value;
  return `${new Intl.DateTimeFormat('en-GB', {
    dateStyle: 'medium',
    timeStyle: 'short',
    timeZone: 'UTC',
  }).format(parsed)} UTC`;
}

function invitationHref(slug: string): string {
  return new URL(`/r/${slug}`, window.location.origin).href;
}

export function RoomList({ session }: { session: GuestSessionResponse }) {
  const [cursors, setCursors] = useState<Array<string | null>>([null]);
  const queries = useQueries({
    queries: cursors.map((cursor) => roomsQueryOptions(session, cursor)),
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
    <div className="mt-4">
      {first?.isPending && (
        <p className="text-sm text-muted" role="status">
          Loading rooms…
        </p>
      )}
      {first?.isError && (
        <p className="text-sm text-danger wrap-anywhere" role="alert">
          {first.error.message}
        </p>
      )}
      {first?.isSuccess && items.length === 0 && (
        <p className="text-sm text-muted">This guest session has no rooms.</p>
      )}
      {items.length > 0 && (
        <ul className="m-0 grid list-none gap-3 p-0">
          {items.map((room) => (
            <RoomRow key={room.id} room={room} session={session} />
          ))}
        </ul>
      )}
      {queries.length > 1 && latest?.isError && (
        <p className="mt-3 text-sm text-danger wrap-anywhere" role="alert">
          {latest.error.message}
        </p>
      )}
      {nextCursor !== null && (
        <Button
          className="mt-3"
          type="button"
          disabled={Boolean(latest?.isPending)}
          onClick={loadMore}
        >
          Load more
        </Button>
      )}
    </div>
  );
}

function RoomRow({ room, session }: { room: RoomResponse; session: GuestSessionResponse }) {
  const [open, setOpen] = useState(false);
  const [copyState, setCopyState] = useState<'idle' | 'copied' | 'failed'>('idle');
  const [invitation, setInvitation] = useState('');
  const panelId = `recordings-${room.id}`;

  async function copyInvitation() {
    const url = invitationHref(room.slug);
    try {
      await navigator.clipboard.writeText(url);
      setInvitation('');
      setCopyState('copied');
    } catch {
      setInvitation(url);
      setCopyState('failed');
    }
  }

  return (
    <li className="rounded-panel border border-line bg-surface px-5 py-4">
      <h3 className="mb-2 text-base font-medium tracking-tight">{room.title}</h3>
      <p className="m-0 text-xs tracking-wide text-muted">
        {room.mode} · {room.status}
      </p>
      <p className="mt-2 mb-0 text-sm">
        <time dateTime={room.createdAt}>{catalogTimeLabel(room.createdAt)}</time>
      </p>
      <div className="mt-3 flex flex-wrap items-center gap-2">
        <Link
          to={`/r/${room.slug}`}
          className="inline-flex min-h-11 items-center justify-center rounded-control border border-input-line bg-control px-3 py-2.5 text-xs font-semibold text-ink"
        >
          Open room
        </Link>
        <Button type="button" onClick={() => void copyInvitation()}>
          Copy invitation
        </Button>
        <Button
          type="button"
          aria-expanded={open}
          aria-controls={panelId}
          onClick={() => setOpen((current) => !current)}
        >
          Recordings
        </Button>
      </div>
      {copyState === 'copied' && (
        <p className="mt-3 mb-0 text-sm text-focus" role="status">
          Invitation copied.
        </p>
      )}
      {copyState === 'failed' && (
        <div className="mt-3">
          <p className="mb-2 text-sm" role="status">
            The invitation was not copied.
          </p>
          <input
            readOnly
            value={invitation}
            aria-label={`Invitation link for ${room.title}`}
            className="block w-full min-w-0 rounded-control border border-input-line bg-field px-3.5 py-3 text-sm text-ink"
          />
        </div>
      )}
      {open && (
        <div id={panelId}>
          <RoomHistory session={session} slug={room.slug} title={room.title} />
        </div>
      )}
    </li>
  );
}
