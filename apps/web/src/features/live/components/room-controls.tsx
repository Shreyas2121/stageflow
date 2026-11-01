export function RoomControls({
  attendee,
  inRoom,
  joining,
  busy,
  leaving,
  mediaPending,
  sharePending,
  ready,
  needsCaptureConsent,
  audioMuted,
  videoOff,
  sharing,
  handRaised,
  showHand,
  showShare,
  onToggleAudio,
  onToggleVideo,
  onToggleShare,
  onToggleHand,
  onLeave,
  onJoin,
}: {
  attendee: boolean;
  inRoom: boolean;
  joining: boolean;
  busy: boolean;
  leaving: boolean;
  mediaPending: boolean;
  sharePending: boolean;
  ready: boolean;
  needsCaptureConsent: boolean;
  audioMuted: boolean;
  videoOff: boolean;
  sharing: boolean;
  handRaised: boolean;
  showHand: boolean;
  showShare: boolean;
  onToggleAudio: () => void;
  onToggleVideo: () => void;
  onToggleShare: () => void;
  onToggleHand: () => void;
  onLeave: () => void;
  onJoin: () => void;
}) {
  const mediaLocked =
    mediaPending || leaving || (!inRoom && !ready) || (needsCaptureConsent && !ready);
  return (
    <div
      className="live-actions"
      aria-busy={busy || joining || leaving || mediaPending || sharePending}
    >
      {!attendee && (
        <>
          <button
            id="toggle-audio"
            className="button button-secondary"
            disabled={mediaLocked}
            aria-pressed={audioMuted}
            onClick={onToggleAudio}
          >
            {audioMuted ? 'Unmute microphone' : 'Mute microphone'}
          </button>
          <button
            id="toggle-video"
            className="button button-secondary"
            disabled={mediaLocked}
            aria-pressed={videoOff}
            onClick={onToggleVideo}
          >
            {videoOff ? 'Turn camera on' : 'Turn camera off'}
          </button>
        </>
      )}
      {showShare && (
        <button
          id="toggle-screen-share"
          className="button button-secondary"
          disabled={sharePending || leaving}
          aria-pressed={sharing}
          onClick={onToggleShare}
        >
          {sharing ? 'Stop sharing' : 'Share screen'}
        </button>
      )}
      {showHand && (
        <button
          id="toggle-hand"
          className="button button-secondary"
          disabled={mediaPending || leaving}
          aria-pressed={handRaised}
          onClick={onToggleHand}
        >
          {handRaised ? 'Lower hand' : 'Raise hand'}
        </button>
      )}
      {inRoom ? (
        <button
          id="leave-room"
          className="button button-secondary leave-button"
          disabled={leaving}
          onClick={onLeave}
        >
          Leave room
        </button>
      ) : (
        <button
          id="join-live-room"
          className="button button-primary"
          disabled={joining || busy || (attendee ? false : !ready)}
          onClick={onJoin}
        >
          {joining ? 'Joining…' : attendee ? 'Join as attendee' : 'Join live room'}
        </button>
      )}
    </div>
  );
}
