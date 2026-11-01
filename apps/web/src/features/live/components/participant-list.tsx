import type { ParticipantState } from '@stageflow/shared';

export function ParticipantList({
  participants,
  selfSocketId,
}: {
  participants: readonly ParticipantState[];
  selfSocketId: string | null;
}) {
  return (
    <div className="roster-panel" aria-labelledby="roster-heading">
      <h2 id="roster-heading">
        In this room <span className="roster-count">{participants.length}</span>
      </h2>
      <ul className="roster" aria-live="polite">
        {participants.map((participant) => (
          <li key={participant.socketId} className="roster-row">
            <div className="roster-person">
              <strong>
                {participant.displayName}
                {participant.socketId === selfSocketId ? ' (You)' : ''}
                {participant.isSyntheticBot && <span className="demo-badge">Demo</span>}
              </strong>
              <span className="role-label">{participant.role}</span>
            </div>
            <div className="roster-flags">
              <span>{participant.isAudioMuted ? 'Muted' : 'Mic on'}</span>
              <span>{participant.isVideoOff ? 'Video off' : 'Video on'}</span>
              {participant.isScreenSharing && <span>Screen sharing</span>}
              {participant.isHandRaised && <span className="raised-hand">Hand raised</span>}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
}
