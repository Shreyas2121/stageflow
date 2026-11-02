import type { ParticipantState } from '@stageflow/shared';
import { Button } from '../../../components/ui/button';

type ModerationControls = {
  disabled: boolean;
  onPromote: (socketId: string) => void;
  onDemote: (socketId: string) => void;
  onSetLock: (socketId: string, kind: 'audio' | 'video', locked: boolean) => void;
};

export function ParticipantList({
  participants,
  selfSocketId,
  handSocketIds,
  moderation,
}: {
  participants: readonly ParticipantState[];
  selfSocketId: string | null;
  handSocketIds: readonly string[];
  moderation?: ModerationControls;
}) {
  const hands = handSocketIds.flatMap((id) => {
    const participant = participants.find((person) => person.socketId === id);
    return participant?.role === 'ATTENDEE' ? [participant] : [];
  });
  return (
    <div className="min-w-0" aria-labelledby="roster-heading">
      {moderation && (
        <section className="mb-6" aria-labelledby="hand-queue-heading">
          <h2 className="text-base" id="hand-queue-heading">
            Hand queue
          </h2>
          {hands.length === 0 ? (
            <p className="mt-3 text-xs text-muted">No hands raised.</p>
          ) : (
            <ol className="mt-3 list-none p-0" aria-live="polite">
              {hands.map((participant) => (
                <li
                  key={participant.socketId}
                  className="flex items-center justify-between gap-3 border-t border-line py-3"
                >
                  <span className="min-w-0 text-sm wrap-anywhere">{participant.displayName}</span>
                  <Button
                    type="button"
                    disabled={moderation.disabled}
                    onClick={() => moderation.onPromote(participant.socketId)}
                  >
                    Promote
                  </Button>
                </li>
              ))}
            </ol>
          )}
        </section>
      )}
      <h2 className="flex items-center justify-between text-base" id="roster-heading">
        In this room{' '}
        <span className="rounded bg-badge px-2 py-1 text-xs text-accent">
          {participants.length}
        </span>
      </h2>
      <ul className="mt-4.5 list-none p-0" aria-live="polite">
        {participants.map((participant) => (
          <li key={participant.socketId} className="border-t border-line py-4">
            <div className="flex items-baseline justify-between gap-3">
              <strong className="min-w-0 text-sm font-medium wrap-anywhere">
                {participant.displayName}
                {participant.socketId === selfSocketId ? ' (You)' : ''}
                {participant.isSyntheticBot && (
                  <span className="ml-2 inline-block rounded border border-live-line px-1.5 py-0.75 text-[10px] font-semibold text-accent">
                    Demo
                  </span>
                )}
              </strong>
              <span className="shrink-0 text-[10px] tracking-widest text-accent">
                {participant.role}
              </span>
            </div>
            <div className="mt-2 flex flex-wrap gap-x-3.5 gap-y-2 text-[11px] text-muted">
              <span>{participant.isAudioMuted ? 'Muted' : 'Mic on'}</span>
              <span>{participant.isVideoOff ? 'Video off' : 'Video on'}</span>
              {participant.isScreenSharing && <span>Screen sharing</span>}
              {participant.isHandRaised && <span className="text-hand">Hand raised</span>}
            </div>
            {moderation && participant.socketId !== selfSocketId && (
              <div
                className="mt-3 flex flex-wrap gap-2"
                aria-label={`Controls for ${participant.displayName}`}
              >
                {participant.role === 'ATTENDEE' && (
                  <Button
                    type="button"
                    disabled={moderation.disabled}
                    onClick={() => moderation.onPromote(participant.socketId)}
                  >
                    Promote
                  </Button>
                )}
                {participant.role === 'SPEAKER' && (
                  <Button
                    type="button"
                    disabled={moderation.disabled}
                    onClick={() => moderation.onDemote(participant.socketId)}
                  >
                    Demote
                  </Button>
                )}
                <Button
                  type="button"
                  disabled={moderation.disabled}
                  onClick={() =>
                    moderation.onSetLock(
                      participant.socketId,
                      'audio',
                      !participant.hostAudioLocked,
                    )
                  }
                >
                  {participant.hostAudioLocked ? 'Unlock microphone' : 'Lock microphone'}
                </Button>
                <Button
                  type="button"
                  disabled={moderation.disabled}
                  onClick={() =>
                    moderation.onSetLock(
                      participant.socketId,
                      'video',
                      !participant.hostVideoLocked,
                    )
                  }
                >
                  {participant.hostVideoLocked ? 'Unlock camera' : 'Lock camera'}
                </Button>
              </div>
            )}
          </li>
        ))}
      </ul>
    </div>
  );
}
