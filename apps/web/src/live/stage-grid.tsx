import { useEffect, useRef, useState } from 'react';
import type { ParticipantState, RoomSnapshot } from '@stageflow/shared';
import type { PeerManager, RemoteStreams } from './peer-manager';

export function StageGrid({ snapshot, selfSocketId, localStream, streams, manager, speakerId }: {
  snapshot: RoomSnapshot; selfSocketId: string; localStream: MediaStream | null;
  streams: RemoteStreams; manager: PeerManager; speakerId: string;
}) {
  const stage = snapshot.stageSocketIds.flatMap((id) => {
    const participant = snapshot.participants.find((person) => person.socketId === id);
    return participant ? [participant] : [];
  });
  const sharing = stage.find((person) => person.isScreenSharing)?.socketId;
  return <div className={`stage-grid stage-count-${stage.length}${sharing ? ' stage-sharing' : ''}`} aria-label="Stage">
    {stage.map((person) => <StageTile key={person.socketId} person={person}
      local={person.socketId === selfSocketId} stream={person.socketId === selfSocketId ? localStream : streams.get(person.socketId) ?? null}
      manager={manager} speakerId={speakerId} large={person.socketId === sharing} />)}
  </div>;
}

function StageTile({ person, local, stream, manager, speakerId, large }: {
  person: ParticipantState; local: boolean; stream: MediaStream | null;
  manager: PeerManager; speakerId: string; large: boolean;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [blocked, setBlocked] = useState(false);
  useEffect(() => {
    const element = video.current;
    if (!element) return;
    const detach = manager.attach(element);
    element.srcObject = stream;
    let active = true;
    if (stream) void element.play().then(() => { if (active) setBlocked(false); })
      .catch(() => { if (active) setBlocked(true); });
    return () => { active = false; detach(); };
  }, [stream, manager]);
  useEffect(() => {
    const element = video.current;
    if (!local && element && 'setSinkId' in element) {
      void element.setSinkId(speakerId).catch(() => setBlocked(true));
    }
  }, [local, speakerId]);
  return <article className={`stage-tile${local ? ' stage-local' : ''}${large ? ' stage-large' : ''}`} aria-label={`${person.displayName}${local ? ' (You)' : ''}`}>
    <video ref={video} autoPlay playsInline {...(local ? { muted: true } : {})} aria-label={`${person.displayName}'s video`} />
    {(person.isVideoOff || !stream) && <div className="stage-placeholder"><strong>{person.displayName}</strong><span>{person.isVideoOff ? 'Video off' : 'Connecting…'}</span></div>}
    <div className="stage-caption"><span>{person.displayName}{local ? ' · You' : ''}</span><span>{person.isAudioMuted ? 'Muted' : 'Mic on'}</span></div>
    {blocked && <button className="button button-secondary stage-play" onClick={() => {
      void video.current?.play().then(() => setBlocked(false)).catch(() => setBlocked(true));
    }}>Play stage audio and video</button>}
  </article>;
}
