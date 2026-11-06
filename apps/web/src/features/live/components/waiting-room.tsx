import { useState } from 'react';
import type { RoomSnapshot } from '@stageflow/shared';
import { Button } from '../../../components/ui/button';

export function WaitingRoom({
  snapshot,
  host,
  joined,
  scheduled,
  requireAdmission,
  busy,
  retryStart = false,
  onJoin,
  onLeave,
  onStart,
  onCancel,
  onAdmit,
  onRemove,
}: {
  snapshot: RoomSnapshot | null;
  host: boolean;
  joined: boolean;
  scheduled: boolean;
  requireAdmission: boolean;
  busy: boolean;
  retryStart?: boolean;
  onJoin: () => void;
  onLeave: () => void;
  onStart: () => void;
  onCancel: () => void;
  onAdmit: (id: string) => void;
  onRemove: (id: string) => void;
}) {
  const [confirmCancel, setConfirmCancel] = useState(false);
  const managingLive = host && !scheduled;
  return (
    <section aria-labelledby="waiting-heading" className="mt-4">
      <h3 id="waiting-heading">Waiting room</h3>
      <p className="text-sm text-muted">
        {scheduled
          ? 'The host starts this room. The advertised time does not start it.'
          : managingLive
            ? 'Manage the waiting queue. Waiting people keep their camera and microphone off.'
            : 'Wait for the host to admit you.'}{' '}
        {!managingLive && 'You are off stage. Your camera and microphone stay off.'}
      </p>
      <div className="flex flex-wrap gap-2">
        {!joined && (
          <Button type="button" variant="primary" disabled={busy} onClick={onJoin}>
            Join waiting room
          </Button>
        )}
        {joined && !managingLive && (
          <Button type="button" disabled={busy} onClick={onLeave}>
            Leave waiting room
          </Button>
        )}
        {host && joined && (scheduled || retryStart) && (
          <Button type="button" variant="primary" disabled={busy} onClick={onStart}>
            {retryStart ? 'Retry Start' : 'Start'}
          </Button>
        )}
        {host && joined && scheduled && (
          <>
            {!confirmCancel ? (
              <Button type="button" disabled={busy} onClick={() => setConfirmCancel(true)}>
                Cancel room
              </Button>
            ) : (
              <>
                <Button type="button" disabled={busy} onClick={onCancel}>
                  Cancel this room
                </Button>
                <Button type="button" disabled={busy} onClick={() => setConfirmCancel(false)}>
                  Keep waiting
                </Button>
              </>
            )}
          </>
        )}
      </div>
      {joined && (
        <>
          <h4 className="mt-5">Waiting ({snapshot?.waitingParticipantIds.length ?? 0})</h4>
          <ol className="m-0 grid list-none gap-3 p-0">
            {snapshot?.waitingParticipantIds.map((id) => (
              <li
                key={id}
                className="flex flex-wrap items-center gap-2 rounded-control border border-line p-3"
              >
                <span className="min-w-0 flex-1 wrap-anywhere">
                  {snapshot.participants.find((p) => p.participantId === id)?.displayName}
                  <span className="block font-mono text-xs text-muted">{id}</span>
                </span>
                {host && (
                  <>
                    {!scheduled && snapshot.mode === 'MEETING' && requireAdmission && (
                      <Button type="button" disabled={busy} onClick={() => onAdmit(id)}>
                        Admit
                      </Button>
                    )}
                    <Button type="button" disabled={busy} onClick={() => onRemove(id)}>
                      Remove
                    </Button>
                  </>
                )}
              </li>
            ))}
          </ol>
          {!snapshot?.waitingParticipantIds.length && (
            <p className="text-sm text-muted">Nobody is waiting.</p>
          )}
        </>
      )}
    </section>
  );
}
