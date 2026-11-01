import { useEffect, useRef, useState } from 'react';
import type { ParticipantState, RoomSnapshot } from '@stageflow/shared';
import type { PeerManager, RemoteStreams } from '../services/peer-manager';
import { routeAudioOutput } from '../services/output-route';

export function StageGrid({
  snapshot,
  selfSocketId,
  localStream,
  streams,
  manager,
  speakerId,
  activeSocketId,
}: {
  snapshot: RoomSnapshot;
  selfSocketId: string;
  localStream: MediaStream | null;
  streams: RemoteStreams;
  manager: PeerManager;
  speakerId: string;
  activeSocketId: string | null;
}) {
  const stage = snapshot.stageSocketIds.flatMap((id) => {
    const participant = snapshot.participants.find((person) => person.socketId === id);
    return participant ? [participant] : [];
  });
  const sharing = stage.find((person) => person.isScreenSharing)?.socketId;
  return (
    <div
      className={`stage-grid stage-count-${stage.length}${sharing ? ' stage-sharing' : ''}`}
      aria-label="Stage"
    >
      {stage.map((person) => (
        <StageTile
          key={person.socketId}
          person={person}
          local={person.socketId === selfSocketId}
          stream={
            person.socketId === selfSocketId ? localStream : (streams.get(person.socketId) ?? null)
          }
          manager={manager}
          speakerId={speakerId}
          large={person.socketId === sharing}
          speaking={person.socketId === activeSocketId}
        />
      ))}
    </div>
  );
}

function StageTile({
  person,
  local,
  stream,
  manager,
  speakerId,
  large,
  speaking,
}: {
  person: ParticipantState;
  local: boolean;
  stream: MediaStream | null;
  manager: PeerManager;
  speakerId: string;
  large: boolean;
  speaking: boolean;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const [outputError, setOutputError] = useState<string | null>(null);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    const detach = manager.attach(element);
    element.srcObject = stream;
    let active = true;
    if (stream)
      void element
        .play()
        .then(() => {
          if (active) setAutoplayBlocked(false);
        })
        .catch(() => {
          if (active) setAutoplayBlocked(true);
        });
    return () => {
      active = false;
      detach();
    };
  }, [stream, manager]);
  useEffect(() => {
    const element = video.current;
    if (local || !element || !('setSinkId' in element)) return;
    let active = true;
    void routeAudioOutput(element, speakerId).then((result) => {
      if (!active) return;
      setOutputError(result.ok ? null : result.message);
    });
    return () => {
      active = false;
    };
  }, [local, speakerId]);
  async function retryBlockedPlayback() {
    const element = video.current;
    if (!element) return;
    if (outputError) {
      const result = await routeAudioOutput(element, speakerId);
      if (!result.ok) {
        setOutputError(result.message);
        return;
      }
      setOutputError(null);
    }
    try {
      await element.play();
      setAutoplayBlocked(false);
    } catch {
      setAutoplayBlocked(true);
    }
  }
  return (
    <article
      className={`stage-tile${local ? ' stage-local' : ''}${person.isSyntheticBot ? ' stage-demo' : ''}${large ? ' stage-large' : ''}${person.isScreenSharing ? ' stage-screen' : ''}${speaking ? ' stage-speaking' : ''}`}
      aria-label={`${person.displayName}${local ? ' (You)' : ''}`}
    >
      <video
        ref={video}
        autoPlay
        playsInline
        {...(local ? { muted: true } : {})}
        aria-label={`${person.displayName}'s video`}
      />
      {((person.isVideoOff && !person.isScreenSharing) || !stream) && (
        <div className="stage-placeholder">
          <strong>{person.displayName}</strong>
          <span>{person.isVideoOff ? 'Video off' : 'Connecting…'}</span>
        </div>
      )}
      <div className="stage-caption">
        <span>
          {person.displayName}
          {local ? ' · You' : ''}
        </span>
        <span>{person.isAudioMuted ? 'Muted' : 'Mic on'}</span>
      </div>
      {speaking && <span className="stage-speaking-label">Speaking</span>}
      {(autoplayBlocked || outputError) && (
        <button
          className="button button-secondary stage-play"
          onClick={() => void retryBlockedPlayback()}
        >
          {outputError ? 'Retry speaker output' : 'Play stage audio and video'}
        </button>
      )}
      {outputError && <p className="error-message">{outputError}</p>}
    </article>
  );
}
