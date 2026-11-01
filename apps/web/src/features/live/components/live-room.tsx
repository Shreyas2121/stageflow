import type { GuestSessionResponse, RoomResponse } from '@stageflow/shared';
import { useRoomStore } from '../stores/room-store';
import { useDemoPeers } from '../hooks/use-demo-peers';
import { useLiveRoom } from '../hooks/use-live-room';
import { useScreenShare } from '../hooks/use-screen-share';
import { DemoControls } from './demo-controls';
import { GreenRoom } from './green-room';
import { ParticipantList } from './participant-list';
import { RoomControls } from './room-controls';
import { StageGrid } from './stage-grid';
import { StatsDrawer } from './stats-drawer';

export function LiveRoom({
  room,
  session,
  onEnded,
}: {
  room: RoomResponse;
  session: GuestSessionResponse;
  onEnded: () => void;
}) {
  const live = useLiveRoom(room, session, onEnded);
  const share = useScreenShare(live);
  const demos = useDemoPeers(live);
  const snapshot = useRoomStore((state) => state.snapshot);
  const selfSocketId = useRoomStore((state) => state.selfSocketId);
  const self = snapshot?.participants.find((participant) => participant.socketId === selfSocketId);
  const inRoom = live.phase === 'joined' || live.phase === 'leaving';
  const onStage = Boolean(selfSocketId && snapshot?.stageSocketIds.includes(selfSocketId));
  const showLobby = !inRoom || live.needsCaptureConsent;
  const showPreview = showLobby && live.audience === 'stage';
  const audioMuted = self?.isAudioMuted ?? live.isAudioMuted;
  const videoOff = self?.isVideoOff ?? live.isVideoOff;

  return (
    <div className="live-room">
      <div className="lobby-heading">
        <div>
          <p className="eyebrow">{inRoom ? 'In the room' : 'Before you join'}</p>
          <h2>{inRoom ? `Welcome, ${session.displayName}` : 'Your green room'}</h2>
        </div>
        <span className="muted">
          {live.audience === 'attendee' ? 'Joining as an attendee' : 'Up to 4 people on stage'}
        </span>
      </div>
      {inRoom && onStage && snapshot && selfSocketId && live.peerManager && (
        <StageGrid
          snapshot={snapshot}
          selfSocketId={selfSocketId}
          localStream={live.media.previewStream()}
          streams={live.streams}
          manager={live.peerManager}
          speakerId={live.speakerId}
          activeSocketId={live.activeSocketId}
        />
      )}
      {self?.role === 'HOST' && onStage && snapshot && live.peerManager && (
        <StatsDrawer manager={live.peerManager} snapshot={snapshot} />
      )}
      {self?.role === 'HOST' && (
        <DemoControls
          count={demos.count}
          starting={demos.starting}
          spawnDisabled={demos.starting || demos.count >= 3 || live.phase === 'leaving'}
          onSpawn={demos.spawn}
          onRemove={demos.remove}
        />
      )}
      <div className={showPreview ? 'lobby-grid' : 'attendee-lobby'}>
        {showLobby && (
          <GreenRoom
            attendee={!showPreview}
            media={live.media}
            displayName={session.displayName}
            ready={live.ready}
            preparing={live.preparing}
            devicesDisabled={
              live.preparing || live.phase === 'joining' || live.phase === 'leaving' || !live.ready
            }
            enableDisabled={live.preparing || live.phase === 'joining' || live.phase === 'leaving'}
            cameraOff={videoOff}
            choices={live.choices}
            devices={live.devices}
            speakerId={live.speakerId}
            sinkSupported={live.sinkSupported}
            speakerError={live.speakerError}
            onPrepare={(video, choices) => void live.prepare(video, choices)}
            onSpeaker={(deviceId) => void live.setSpeaker(deviceId)}
          />
        )}
        {inRoom && snapshot && (
          <ParticipantList participants={snapshot.participants} selfSocketId={selfSocketId} />
        )}
      </div>
      {live.error && (
        <p className="error-message" role="alert">
          Error: {live.error}
        </p>
      )}
      <RoomControls
        attendee={live.audience === 'attendee'}
        inRoom={inRoom}
        joining={live.phase === 'joining'}
        busy={live.preparing}
        leaving={live.phase === 'leaving'}
        mediaPending={live.mediaPending}
        sharePending={share.pending}
        ready={live.ready}
        needsCaptureConsent={live.needsCaptureConsent}
        audioMuted={audioMuted}
        videoOff={videoOff}
        sharing={share.sharing}
        handRaised={self?.isHandRaised ?? false}
        showHand={self?.role === 'ATTENDEE'}
        showShare={Boolean(inRoom && onStage && live.peerManager)}
        onToggleAudio={() => live.toggleAudio()}
        onToggleVideo={() => live.toggleVideo()}
        onToggleShare={() => (share.sharing ? share.stop() : share.start())}
        onToggleHand={() => live.toggleHand()}
        onLeave={() => void live.leave()}
        onJoin={() => void live.join()}
      />
    </div>
  );
}
