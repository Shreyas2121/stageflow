import { Button } from '../../../components/ui/button';
import { useEffect, useRef, useState } from 'react';
import type { ParticipantState, RoomSnapshot } from '@stageflow/shared';
import type { PeerManager, RemoteStreams } from '../services/peer-manager';
import { bindAudioOutput, routeAudioOutput, selectedOutputId } from '../services/output-route';

const gridColumns = {
  single: 'grid-cols-1',
  multiple: 'grid-cols-1 min-[480px]:grid-cols-2',
  sharing: 'grid-cols-1 min-[480px]:grid-cols-3',
};
const tileSize = {
  normal: 'aspect-[4/3]',
  shared: 'col-span-full row-start-1 aspect-video',
};
const videoFit = {
  camera: 'object-cover',
  presentation: 'object-contain',
};
const videoTransform = {
  localCamera: '-scale-x-100',
  unmirrored: 'transform-none',
};
const tileBorder = {
  speaking: 'border-accent ring-1 ring-accent',
  quiet: 'border-line',
};

export function StageGrid({
  snapshot,
  selfSocketId,
  localStream,
  streams,
  manager,
  activeSocketId,
  onVideo,
}: {
  snapshot: RoomSnapshot;
  selfSocketId: string;
  localStream: MediaStream | null;
  streams: RemoteStreams;
  manager: PeerManager;
  activeSocketId: string | null;
  onVideo?: (socketId: string, element: HTMLVideoElement | null) => void;
}) {
  const stage = snapshot.stageSocketIds.flatMap((id) => {
    const participant = snapshot.participants.find((person) => person.socketId === id);
    return participant ? [participant] : [];
  });
  const sharing = stage.find((person) => person.isScreenSharing)?.socketId;
  return (
    <div
      className={`mb-7 grid gap-3 ${gridColumns[sharing ? 'sharing' : stage.length === 1 ? 'single' : 'multiple']}`}
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
          large={person.socketId === sharing}
          speaking={person.socketId === activeSocketId}
          onVideo={onVideo}
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
  large,
  speaking,
  onVideo,
}: {
  person: ParticipantState;
  local: boolean;
  stream: MediaStream | null;
  manager: PeerManager;
  large: boolean;
  speaking: boolean;
  onVideo?: (socketId: string, element: HTMLVideoElement | null) => void;
}) {
  const video = useRef<HTMLVideoElement>(null);
  const [autoplayBlocked, setAutoplayBlocked] = useState(false);
  const [outputError, setOutputError] = useState<string | null>(null);
  useEffect(() => {
    if (!onVideo) return;
    onVideo(person.socketId, video.current);
    return () => onVideo(person.socketId, null);
  }, [onVideo, person.socketId]);
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
    if (local || !element) return;
    let active = true;
    const unbind = bindAudioOutput(element, (result) => {
      if (!active) return;
      setOutputError(result.ok ? null : result.message);
    });
    return () => {
      active = false;
      unbind();
    };
  }, [local]);
  async function retryBlockedPlayback() {
    const element = video.current;
    if (!element) return;
    if (outputError) {
      const result = await routeAudioOutput(element, selectedOutputId());
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
      className={`relative min-w-0 overflow-hidden rounded-lg border-2 bg-video ${tileSize[large ? 'shared' : 'normal']} ${tileBorder[speaking ? 'speaking' : 'quiet']}`}
      aria-label={`${person.displayName}${local ? ' (You)' : ''}`}
    >
      <video
        className={`h-full w-full ${videoFit[person.isScreenSharing || large || person.isSyntheticBot ? 'presentation' : 'camera']} ${videoTransform[local && !person.isScreenSharing && !large ? 'localCamera' : 'unmirrored']}`}
        ref={video}
        autoPlay
        playsInline
        {...(local ? { muted: true } : {})}
        aria-label={`${person.displayName}'s video`}
      />
      {((person.isVideoOff && !person.isScreenSharing) || !stream) && (
        <div className="absolute inset-0 flex flex-col items-center justify-center gap-2 bg-video p-5 text-[13px] text-muted">
          <strong className="text-ink wrap-anywhere">{person.displayName}</strong>
          <span>{person.isVideoOff ? 'Video off' : 'Connecting…'}</span>
        </div>
      )}
      <div className="absolute inset-x-0 bottom-0 flex flex-wrap justify-between gap-2 bg-overlay px-3 py-2.5 text-xs wrap-anywhere">
        <span>
          {person.displayName}
          {local ? ' · You' : ''}
        </span>
        <span>{person.isAudioMuted ? 'Muted' : 'Mic on'}</span>
      </div>
      {speaking && (
        <span className="absolute top-2.5 right-2.5 rounded bg-accent px-2 py-1 text-xs font-semibold text-accent-ink">
          Speaking
        </span>
      )}
      {(autoplayBlocked || outputError) && (
        <Button
          type="button"
          className="absolute inset-x-2.5 top-2.5"
          onClick={() => void retryBlockedPlayback()}
        >
          {outputError ? 'Retry speaker output' : 'Play stage audio and video'}
        </Button>
      )}
      {outputError && (
        <p className="mt-4 rounded-control border border-danger-line bg-danger-surface px-4.5 py-3.5 text-sm text-danger wrap-anywhere">
          {outputError}
        </p>
      )}
    </article>
  );
}
