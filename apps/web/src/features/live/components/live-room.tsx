import { useCallback } from 'react';
import type { GuestSessionResponse, RoomResponse } from '@stageflow/shared';
import { AttendeeBroadcast } from '../../broadcast/components/attendee-broadcast';
import { useRoomStore } from '../stores/room-store';
import { deviceSelects } from '../services/device-controls';
import { useDemoPeers } from '../hooks/use-demo-peers';
import { useLiveRoom } from '../hooks/use-live-room';
import { useScreenShare } from '../hooks/use-screen-share';
import { DemoControls } from './demo-controls';
import { DevicePanel } from './device-panel';
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
  const onStageVideo = useCallback(
    (socketId: string, element: HTMLVideoElement | null) => {
      live.setStageVideo(socketId, element);
    },
    [live],
  );
  const selects = deviceSelects({
    phase: live.phase,
    audience: live.audience,
    needsCaptureConsent: live.needsCaptureConsent,
  });

  return (
    <div className="mt-8 min-w-0 rounded-panel border border-line bg-surface p-5 layout:p-7">
      <div className="mb-6 flex items-start justify-between gap-5 layout:items-center">
        <div className="min-w-0">
          <p className="mb-2 text-[11px] font-semibold tracking-[0.11em] text-eyebrow uppercase">
            {inRoom ? 'In the room' : 'Before you join'}
          </p>
          <h2 className="m-0 text-[22px] font-medium tracking-tight wrap-anywhere">
            {inRoom ? `Welcome, ${session.displayName}` : 'Your green room'}
          </h2>
        </div>
        <span className="max-w-[110px] shrink-0 text-right text-xs text-muted layout:max-w-none">
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
          activeSocketId={live.activeSocketId}
          onVideo={onStageVideo}
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
      <div
        className={
          showPreview
            ? 'grid items-start gap-7 layout:grid-cols-[minmax(0,1.2fr)_minmax(0,1fr)]'
            : ''
        }
      >
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
          <ParticipantList
            participants={snapshot.participants}
            selfSocketId={selfSocketId}
            handSocketIds={snapshot.handSocketIds}
            moderation={
              live.phase === 'joined' && self?.role === 'HOST'
                ? {
                    disabled: live.mediaPending,
                    onPromote: (socketId) => void live.promote(socketId),
                    onDemote: (socketId) => void live.demote(socketId),
                    onSetLock: (socketId, kind, locked) =>
                      void live.setLock(socketId, kind, locked),
                  }
                : undefined
            }
          />
        )}
      </div>
      {live.phase === 'joined' && self?.role === 'ATTENDEE' && (
        <AttendeeBroadcast broadcast={snapshot?.broadcast ?? null} token={session.token} />
      )}
      {(selects.camera || selects.microphone || selects.speaker) && (
        <DevicePanel
          selects={selects}
          devices={live.devices}
          cameraId={live.choices.cameraId}
          microphoneId={live.choices.microphoneId}
          speakerId={live.speakerId}
          cameraPending={live.replacingCamera}
          microphonePending={live.replacingMicrophone}
          cameraUnavailable={live.cameraUnavailable}
          microphoneUnavailable={live.microphoneUnavailable}
          sinkSupported={live.sinkSupported}
          speakerError={live.speakerError}
          onCamera={(deviceId) => {
            void live.replaceDevice('camera', deviceId);
          }}
          onMicrophone={(deviceId) => {
            void live.replaceDevice('microphone', deviceId);
          }}
          onSpeaker={(deviceId) => {
            void live.setSpeaker(deviceId);
          }}
        />
      )}
      {live.error && (
        <p
          className="mt-4 rounded-control border border-danger-line bg-danger-surface px-4.5 py-3.5 text-sm text-danger wrap-anywhere"
          role="alert"
        >
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
        audioLocked={live.audioLocked}
        videoLocked={live.videoLocked}
        sharing={share.sharing}
        handRaised={self?.isHandRaised ?? false}
        showHand={self?.role === 'ATTENDEE'}
        showShare={Boolean(inRoom && onStage && live.peerManager)}
        showBroadcast={live.phase === 'joined' && room.mode === 'WEBINAR' && self?.role === 'HOST'}
        broadcasting={live.broadcastActive}
        onStartBroadcast={() => void live.startBroadcast()}
        onStopBroadcast={() => void live.stopBroadcast()}
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
