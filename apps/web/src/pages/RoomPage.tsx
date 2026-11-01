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
      <section className="page-state">
        <p className="eyebrow">A name before you enter</p>
        <h1>Let’s get you a guest session.</h1>
        <p className="muted">Enter a name on the home page, then join using this room’s slug.</p>
        <p className="room-slug">{slug}</p>
        <Link className="text-link" to="/">
          Enter your name <span aria-hidden="true">↗</span>
        </Link>
      </section>
    );
  }

  if (roomQuery.isPending)
    return (
      <p className="page-state muted" role="status">
        Opening room…
      </p>
    );
  if (roomQuery.isError) {
    return (
      <section className="page-state">
        <h1>Unable to open this room.</h1>
        <p className="error-message" role="alert">
          Error: {roomQuery.error.message}
        </p>
        <Link className="text-link" to="/">
          Back to home <span aria-hidden="true">↗</span>
        </Link>
      </section>
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
