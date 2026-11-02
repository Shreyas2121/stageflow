import { isUuid } from '@stageflow/shared';
import { useQuery } from '@tanstack/react-query';
import { Link, useParams } from 'react-router';
import { PageState } from '../components/ui/page-state';
import { BroadcastPlayer } from '../features/broadcast/components/broadcast-player';
import { broadcastQueryOptions } from '../features/broadcast/query-options';
import { replayPlayback } from '../features/broadcast/services/playback';
import { useSessionStore } from '../features/session/session-store';

const alertClass =
  'mt-4 rounded-control border border-danger-line bg-danger-surface px-4.5 py-3.5 text-sm text-danger wrap-anywhere';

export function ReplayPage() {
  const { broadcastId = '' } = useParams();
  const session = useSessionStore((state) => state.session);
  const broadcastQuery = useQuery(broadcastQueryOptions(broadcastId, session));

  if (!session) {
    return (
      <PageState eyebrow="A name before you enter" title="Let’s get you a guest session.">
        <p className="text-sm text-muted">
          Enter a name on the home page, then open this replay again.
        </p>
        <Link
          className="mt-4 inline-flex items-center gap-5 text-[13px] text-accent underline-offset-4 hover:underline"
          to="/"
        >
          Enter your name <span aria-hidden="true">↗</span>
        </Link>
      </PageState>
    );
  }

  if (!isUuid(broadcastId)) {
    return (
      <PageState title="Unable to open this replay.">
        <p className={alertClass} role="alert">
          Error: No broadcast exists for that id.
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

  if (broadcastQuery.isPending)
    return (
      <p className="py-16 text-sm text-muted" role="status">
        Opening replay…
      </p>
    );
  if (broadcastQuery.isError) {
    return (
      <PageState title="Unable to open this replay.">
        <p className={alertClass} role="alert">
          Error: {broadcastQuery.error.message}
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

  const view = replayPlayback(broadcastQuery.data);
  return (
    <section className="pt-9.5 pb-16 layout:pt-15" aria-labelledby="replay-heading">
      <Link
        className="inline-flex items-center gap-5 text-[13px] text-accent underline-offset-4 hover:underline"
        to="/"
      >
        ← Back to home
      </Link>
      <div className="mt-9.5 min-w-0">
        <p className="mb-4 text-[11px] font-semibold tracking-[0.11em] text-eyebrow uppercase">
          Saved broadcast
        </p>
        <h1 className="mb-0" id="replay-heading">
          Replay
        </h1>
      </div>
      <p className="mt-6 text-sm text-muted">Status: {broadcastQuery.data.status}</p>
      {view.kind === 'unavailable' && view.message && (
        <p className={alertClass} role="alert">
          Error: {view.message}
        </p>
      )}
      {view.kind === 'vod' && (
        <BroadcastPlayer playlistUrl={view.playlistUrl} token={session.token} mode="vod" />
      )}
    </section>
  );
}
