import type { ParticipantState } from '@stageflow/shared';

export function ParticipantList({
  participants,
  selfSocketId,
}: {
  participants: readonly ParticipantState[];
  selfSocketId: string | null;
}) {
  return (
    <div className="min-w-0" aria-labelledby="roster-heading">
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
          </li>
        ))}
      </ul>
    </div>
  );
}
