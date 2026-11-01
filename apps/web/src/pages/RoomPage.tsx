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
        <p className="muted">Enter a name on the home page, then join using this room’s slug.</p>
        <p className="room-slug">{slug}</p>
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
        <p className="error-message" role="alert">
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
    <section className="room-page" aria-labelledby="room-heading">
      <Link className="back-link" to="/">
        ← Back to home
      </Link>
      <div className="room-heading-row">
        <div>
          <p className="eyebrow">Your room</p>
          <h1 id="room-heading">{room.title}</h1>
        </div>
        <span className={`status-badge${isEnded ? ' status-ended' : ''}`}>
          <span aria-hidden="true" />
          {isEnded ? 'ENDED' : room.status}
        </span>
      </div>
      <dl className="room-details">
        <div>
          <dt>Format</dt>
          <dd>{room.mode}</dd>
        </div>
        <div>
          <dt>Room slug</dt>
          <dd className="room-slug">{room.slug}</dd>
        </div>
        <div>
          <dt>Hosted by</dt>
          <dd>{room.hostDisplayName}</dd>
        </div>
      </dl>
      {isEnded ? (
        <p className="room-ended" role="status">
          This room has ended.
        </p>
      ) : (
        <LiveRoom room={room} session={session} onEnded={() => setEnded(true)} />
      )}
      <aside className="foundation-note room-foundation">
        <span className="note-marker" aria-hidden="true">
          i
        </span>
        <div>
          <h2>A shared room.</h2>
          <p>
            People on stage can see and hear each other. Stage video is only for people on stage.
          </p>
        </div>
      </aside>
    </section>
  );
}
