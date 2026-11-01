import { Link, useParams } from 'react-router';
import { skipToken, useQuery } from '@tanstack/react-query';
import { getRoom } from '../api';
import { useSessionStore } from '../session';

export function RoomPage() {
  const { slug = '' } = useParams();
  const session = useSessionStore((state) => state.session);
  const roomQuery = useQuery({
    queryKey: ['room', slug, session?.token],
    queryFn: session ? () => getRoom(slug, session.token) : skipToken,
    retry: false,
  });

  if (!session) {
    return (
      <section className="page-state">
        <p className="eyebrow">A name before you enter</p>
        <h1>Let’s get you a guest session.</h1>
        <p className="muted">Enter a name on the home page, then join using this room’s slug.</p>
        <p className="room-slug">{slug}</p>
        <Link className="text-link" to="/">Enter your name <span aria-hidden="true">↗</span></Link>
      </section>
    );
  }

  if (roomQuery.isPending) return <p className="page-state muted" role="status">Opening room…</p>;
  if (roomQuery.isError) {
    return (
      <section className="page-state">
        <h1>Unable to open this room.</h1>
        <p className="error-message" role="alert">Error: {roomQuery.error.message}</p>
        <Link className="text-link" to="/">Back to home <span aria-hidden="true">↗</span></Link>
      </section>
    );
  }

  const room = roomQuery.data;
  return (
    <section className="room-page" aria-labelledby="room-heading">
      <Link className="back-link" to="/">← Back to home</Link>
      <div className="room-heading-row">
        <div><p className="eyebrow">Your room</p><h1 id="room-heading">{room.title}</h1></div>
        <span className="status-badge"><span aria-hidden="true" />{room.status}</span>
      </div>
      <dl className="room-details">
        <div><dt>Format</dt><dd>{room.mode}</dd></div>
        <div><dt>Room slug</dt><dd className="room-slug">{room.slug}</dd></div>
        <div><dt>Hosted by</dt><dd>{room.hostDisplayName}</dd></div>
      </dl>
      <aside className="foundation-note room-foundation">
        <span className="note-marker" aria-hidden="true">i</span>
        <div><h2>You’re in the room shell.</h2><p>Foundation build. The green room and video arrive in a later phase.</p></div>
      </aside>
    </section>
  );
}
