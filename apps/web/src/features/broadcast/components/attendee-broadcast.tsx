import { Link } from 'react-router';
import type { RoomSnapshot } from '@stageflow/shared';
import { attendeePlayback } from '../services/playback';
import { BroadcastPlayerGate } from './broadcast-player-gate';

const alertClass =
  'mt-3 rounded-control border border-danger-line bg-danger-surface px-4.5 py-3.5 text-sm text-danger wrap-anywhere';

export function AttendeeBroadcast({
  broadcast,
  token,
}: {
  broadcast: RoomSnapshot['broadcast'];
  token: string;
}) {
  const view = attendeePlayback(broadcast);
  return (
    <section className="mt-5 text-sm text-muted" aria-label="Broadcast">
      {view.kind === 'waiting' && <p>The host has not started the broadcast.</p>}
      {view.kind === 'failed' && (
        <p className={alertClass} role="alert">
          Error: {view.message}
        </p>
      )}
      {view.kind === 'pending' && (
        <>
          <p>The broadcast is {view.status}.</p>
          {view.message && (
            <p className={alertClass} role="alert">
              Error: {view.message}
            </p>
          )}
        </>
      )}
      {view.kind === 'live' && (
        <BroadcastPlayerGate playlistUrl={view.playlistUrl} token={token} mode="live" />
      )}
      {view.kind === 'vod' && (
        <>
          <BroadcastPlayerGate playlistUrl={view.playlistUrl} token={token} mode="vod" />
          <Link
            className="mt-3 inline-flex items-center gap-5 text-[13px] text-accent underline-offset-4 hover:underline"
            to={`/replay/${view.broadcastId}`}
          >
            Open the replay <span aria-hidden="true">↗</span>
          </Link>
        </>
      )}
    </section>
  );
}
