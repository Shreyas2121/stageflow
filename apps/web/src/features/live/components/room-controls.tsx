import { Button } from '../../../components/ui/button';
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
  audioLocked,
  videoLocked,
  sharing,
  handRaised,
  showHand,
  showShare,
  showBroadcast,
  broadcasting,
  onStartBroadcast,
  onStopBroadcast,
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
  audioLocked: boolean;
  videoLocked: boolean;
  sharing: boolean;
  handRaised: boolean;
  showHand: boolean;
  showShare: boolean;
  showBroadcast: boolean;
  broadcasting: boolean;
  onStartBroadcast: () => void;
  onStopBroadcast: () => void;
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
      className="mt-6 flex flex-wrap gap-2.5 border-t border-line pt-6 [&>button]:flex-[1_1_140px] layout:[&>button]:flex-none"
      aria-busy={busy || joining || leaving || mediaPending || sharePending}
    >
      {!attendee && (
        <>
          <Button
            type="button"
            id="toggle-audio"
            disabled={mediaLocked || audioLocked}
            aria-pressed={audioMuted}
            onClick={onToggleAudio}
          >
            {audioMuted ? 'Unmute microphone' : 'Mute microphone'}
          </Button>
          <Button
            type="button"
            id="toggle-video"
            disabled={mediaLocked || videoLocked}
            aria-pressed={videoOff}
            onClick={onToggleVideo}
          >
            {videoOff ? 'Turn camera on' : 'Turn camera off'}
          </Button>
        </>
      )}
      {showShare && (
        <Button
          type="button"
          id="toggle-screen-share"
          disabled={sharePending || leaving}
          aria-pressed={sharing}
          onClick={onToggleShare}
        >
          {sharing ? 'Stop sharing' : 'Share screen'}
        </Button>
      )}
      {showHand && (
        <Button
          type="button"
          id="toggle-hand"
          disabled={mediaPending || leaving}
          aria-pressed={handRaised}
          onClick={onToggleHand}
        >
          {handRaised ? 'Lower hand' : 'Raise hand'}
        </Button>
      )}
      {showBroadcast && (
        <>
          <Button
            type="button"
            id="start-broadcast"
            disabled={mediaPending || leaving || broadcasting}
            onClick={onStartBroadcast}
          >
            Start broadcast
          </Button>
          <Button
            type="button"
            id="stop-broadcast"
            disabled={mediaPending || leaving || !broadcasting}
            onClick={onStopBroadcast}
          >
            Stop broadcast
          </Button>
        </>
      )}
      {inRoom ? (
        <Button
          type="button"
          id="leave-room"
          variant="danger"
          className="flex-[1_1_140px] layout:ml-auto layout:flex-none"
          disabled={leaving}
          onClick={onLeave}
        >
          Leave room
        </Button>
      ) : (
        <Button
          type="button"
          id="join-live-room"
          variant="primary"
          className="flex-[1_1_140px] layout:ml-auto layout:flex-none"
          disabled={joining || busy || (attendee ? false : !ready)}
          onClick={onJoin}
        >
          {joining ? 'Joining…' : attendee ? 'Join as attendee' : 'Join live room'}
        </Button>
      )}
    </div>
  );
}
