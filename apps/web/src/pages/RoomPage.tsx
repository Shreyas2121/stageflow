import { PageState } from '../components/ui/page-state';
import { Link, useParams } from 'react-router';
import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import type { GuestSessionResponse, RoomResponse } from '@stageflow/shared';
import { roomQueryOptions } from '../features/rooms/query-options';
import { LiveRoom } from '../features/live/components/live-room';
import { useSessionStore } from '../features/session/session-store';

export function RoomPage() {
  const { slug = '' } = useParams();
  const session = useSessionStore((state) => state.session);
  const roomQuery = useQuery(roomQueryOptions(slug, session));

  if (!session) {
    return (
      <PageState eyebrow="A name before you enter" title="Let’s get you a guest session.">
        <p className="text-sm text-muted">
          Enter a name on the home page, then join using this room’s slug.
        </p>
        <p className="font-mono tracking-wide wrap-anywhere">{slug}</p>
        <Link
          className="mt-4 inline-flex items-center gap-5 text-[13px] text-accent underline-offset-4 hover:underline"
          to="/"
        >
          Enter your name <span aria-hidden="true">↗</span>
        </Link>
      </PageState>
    );
  }

  if (roomQuery.isPending)
    return (
      <p className="py-16 text-sm text-muted" role="status">
        Opening room…
      </p>
    );
  if (roomQuery.isError) {
    return (
      <PageState title="Unable to open this room.">
        <p
          className="mt-4 rounded-control border border-danger-line bg-danger-surface px-4.5 py-3.5 text-sm text-danger wrap-anywhere"
          role="alert"
        >
          Error: {roomQuery.error.message}
        </p>
        <Link
          className="mt-4 inline-flex items-center gap-5 text-[13px] text-accent underline-offset-4 hover:underline"
          to="/"
        >
          Back to home <span aria-hidden="true">↗</span>
        </Link>
      </PageState>
    );
  }

  return (
    <RoomContents
      key={`${roomQuery.data.id}:${session.userId}`}
      room={roomQuery.data}
      session={session}
    />
  );
}

function RoomContents({ room, session }: { room: RoomResponse; session: GuestSessionResponse }) {
  const [ended, setEnded] = useState(room.status === 'ENDED');
  const isEnded = ended || room.status === 'ENDED';
  return (
    <section className="pt-9.5 pb-16 layout:pt-15" aria-labelledby="room-heading">
      <Link
        className="inline-flex items-center gap-5 text-[13px] text-accent underline-offset-4 hover:underline"
        to="/"
      >
        ← Back to home
      </Link>
      <div className="mt-9.5 flex flex-col items-start justify-between gap-6 layout:flex-row layout:items-center">
        <div className="min-w-0">
          <p className="mb-4 text-[11px] font-semibold tracking-[0.11em] text-eyebrow uppercase">
            Your room
          </p>
          <h1 className="mb-0" id="room-heading">
            {room.title}
          </h1>
        </div>
        <span
          className={`inline-flex shrink-0 items-center gap-2 rounded border px-3 py-2 text-[11px] font-semibold tracking-widest ${isEnded ? 'border-input-line bg-ended-surface text-ended' : 'border-live-line bg-live text-accent'}`}
        >
          <span className="size-1.5 rounded-full bg-current" aria-hidden="true" />
          {isEnded ? 'ENDED' : room.status}
        </span>
      </div>
      <dl className="mt-9 grid gap-6 rounded-[10px] border border-line bg-surface p-6 layout:grid-cols-[0.85fr_1.2fr_1fr] layout:gap-0 layout:p-7 [&>div]:min-w-0 layout:[&>div]:border-l layout:[&>div]:border-line layout:[&>div]:px-6 layout:[&>div:first-child]:border-0 layout:[&>div:first-child]:pl-0">
        <div>
          <dt>Format</dt>
          <dd>{room.mode}</dd>
        </div>
        <div>
          <dt>Room slug</dt>
          <dd className="font-mono tracking-wide wrap-anywhere">{room.slug}</dd>
        </div>
        <div>
          <dt>Hosted by</dt>
          <dd>{room.hostDisplayName}</dd>
        </div>
      </dl>
      {isEnded ? (
        <p className="mt-8 rounded-lg border border-input-line p-6" role="status">
          This room has ended.
        </p>
      ) : (
        <LiveRoom room={room} session={session} onEnded={() => setEnded(true)} />
      )}
      <aside className="mt-6.5 flex items-start gap-3 rounded-lg border border-dashed border-note-line px-5 py-4.5">
        <span
          className="mt-0.5 size-5 shrink-0 rounded-full border border-note-marker-line text-center font-serif text-xs leading-[18px] text-note-marker"
          aria-hidden="true"
        >
          i
        </span>
        <div>
          <h2 className="mb-1 text-[13px] font-semibold tracking-normal">A shared room.</h2>
          <p className="m-0 text-xs text-muted">
            People on stage can see and hear each other. Stage video is only for people on stage.
          </p>
        </div>
      </aside>
    </section>
  );
}
