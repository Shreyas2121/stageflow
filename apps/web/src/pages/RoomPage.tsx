import { Link, useParams } from 'react-router';
import { useCallback, useEffect, useRef, useState } from 'react';
import { skipToken, useQuery } from '@tanstack/react-query';
import type { CommandAck, GuestSessionResponse, RoomResponse } from '@stageflow/shared';
import { nextDemoPeerName } from '@stageflow/shared';
import { getRoom } from '../api';
import { useSessionStore } from '../session';
import { LocalMedia, type DeviceChoices } from '../live/local-media';
import { openSignaling, type RoomConnection } from '../live/signaling';
import { useRoomStore } from '../live/room-store';
import { PeerManager, type RemoteStreams } from '../live/peer-manager';
import { StageGrid } from '../live/stage-grid';
import { ActiveSpeaker } from '../live/active-speaker';
import { StatsDrawer } from '../live/stats-drawer';
import { DemoPeer } from '../live/demo-peer';

export function RoomPage() {
  const { slug = '' } = useParams();
  const session = useSessionStore((state) => state.session);
  const roomQuery = useQuery({
    queryKey: ['room', slug, session?.token],
    queryFn: session ? () => getRoom(slug, session.token) : skipToken,
    retry: false,
  });

  if (!session) {
    return (
      <section className="page-state">
        <p className="eyebrow">A name before you enter</p>
        <h1>Let’s get you a guest session.</h1>
        <p className="muted">Enter a name on the home page, then join using this room’s slug.</p>
        <p className="room-slug">{slug}</p>
        <Link className="text-link" to="/">
          Enter your name <span aria-hidden="true">↗</span>
        </Link>
      </section>
    );
  }

  if (roomQuery.isPending)
    return (
      <p className="page-state muted" role="status">
        Opening room…
      </p>
    );
  if (roomQuery.isError) {
    return (
      <section className="page-state">
        <h1>Unable to open this room.</h1>
        <p className="error-message" role="alert">
          Error: {roomQuery.error.message}
        </p>
        <Link className="text-link" to="/">
          Back to home <span aria-hidden="true">↗</span>
        </Link>
      </section>
    );
  }

  return (
    <RoomContents
      key={`${roomQuery.data.id}:${session.userId}`}
      room={roomQuery.data}
      session={session}
    />
  );
}

function RoomContents({ room, session }: { room: RoomResponse; session: GuestSessionResponse }) {
  const [ended, setEnded] = useState(room.status === 'ENDED');
  const isEnded = ended || room.status === 'ENDED';
  return (
    <section className="room-page" aria-labelledby="room-heading">
      <Link className="back-link" to="/">
        ← Back to home
      </Link>
      <div className="room-heading-row">
        <div>
          <p className="eyebrow">Your room</p>
          <h1 id="room-heading">{room.title}</h1>
        </div>
        <span className={`status-badge${isEnded ? ' status-ended' : ''}`}>
          <span aria-hidden="true" />
          {isEnded ? 'ENDED' : room.status}
        </span>
      </div>
      <dl className="room-details">
        <div>
          <dt>Format</dt>
          <dd>{room.mode}</dd>
        </div>
        <div>
          <dt>Room slug</dt>
          <dd className="room-slug">{room.slug}</dd>
        </div>
        <div>
          <dt>Hosted by</dt>
          <dd>{room.hostDisplayName}</dd>
        </div>
      </dl>
      {isEnded ? (
        <p className="room-ended" role="status">
          This room has ended.
        </p>
      ) : (
        <LiveRoom room={room} session={session} onEnded={() => setEnded(true)} />
      )}
      <aside className="foundation-note room-foundation">
        <span className="note-marker" aria-hidden="true">
          i
        </span>
        <div>
          <h2>A shared room.</h2>
          <p>
            People on stage can see and hear each other. Stage video is only for people on stage.
          </p>
        </div>
      </aside>
    </section>
  );
}

function MicrophoneMeter({ media }: { media: LocalMedia }) {
  const [level, setLevel] = useState(0);
  useEffect(() => {
    media.setLevelListener(setLevel);
    return () => {
      media.setLevelListener(null);
      media.releaseLobby();
    };
  }, [media]);
  return (
    <>
      <label className="meter-label" htmlFor="microphone-level">
        Microphone level
      </label>
      <meter id="microphone-level" min={0} max={1} value={level} aria-label="Microphone level" />
    </>
  );
}

function LiveRoom({
  room,
  session,
  onEnded,
}: {
  room: RoomResponse;
  session: GuestSessionResponse;
  onEnded: () => void;
}) {
  const attendee = room.mode === 'WEBINAR' && room.hostId !== session.userId;
  const [media] = useState(() => new LocalMedia());
  const preview = useRef<HTMLVideoElement>(null);
  const connection = useRef<RoomConnection | null>(null);
  const peers = useRef<PeerManager | null>(null);
  const [peerManager, setPeerManager] = useState<PeerManager | null>(null);
  const [streams, setStreams] = useState<RemoteStreams>(new Map());
  const [activeSocketId, setActiveSocketId] = useState<string | null>(null);
  const [speaker] = useState(() => new ActiveSpeaker(setActiveSocketId));
  const operation = useRef(0);
  const shareVersion = useRef(0);
  const [isSharing, setSharing] = useState(false);
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [speakerError, setSpeakerError] = useState('');
  const [choices, setChoices] = useState<DeviceChoices>({ cameraId: '', microphoneId: '' });
  const [speakerId, setSpeakerId] = useState('');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [sinkSupported, setSinkSupported] = useState(false);
  const demoPeers = useRef(new Map<string, DemoPeer>());
  const demoStartVersion = useRef(0);
  const demoStartPending = useRef(false);
  const [demoCount, setDemoCount] = useState(0);
  const [demoStarting, setDemoStarting] = useState(false);
  const [isAudioMuted, setAudioMuted] = useState(false);
  const [isVideoOff, setVideoOff] = useState(false);
  const snapshot = useRoomStore((state) => state.snapshot);
  const selfSocketId = useRoomStore((state) => state.selfSocketId);
  const self = snapshot?.participants.find((participant) => participant.socketId === selfSocketId);
  const joined = selfSocketId !== null;

  const stopDemoPeers = useCallback(() => {
    demoStartVersion.current += 1;
    demoStartPending.current = false;
    const running = [...demoPeers.current.values()];
    demoPeers.current.clear();
    for (const peer of running) peer.stop();
    setDemoCount(0);
    setDemoStarting(false);
  }, []);

  useEffect(() => {
    // Subscribe outside React so offers cannot overtake a stage snapshot render.
    const sync = () => {
      const { selfSocketId, snapshot, iceServers } = useRoomStore.getState();
      if (!selfSocketId || !snapshot?.stageSocketIds.includes(selfSocketId) || !media.ready) {
        peers.current?.close();
        peers.current = null;
        setPeerManager(null);
        return;
      }
      const active = connection.current;
      if (!active) return;
      try {
        if (!peers.current) {
          peers.current = new PeerManager(media, active, setStreams, setError);
          setPeerManager(peers.current);
        }
        peers.current.sync(selfSocketId, snapshot.stageSocketIds, iceServers);
      } catch {
        setError('Unable to start stage media. You can still use the roster and leave the room.');
      }
    };
    const unsubscribe = useRoomStore.subscribe(sync);
    return () => {
      unsubscribe();
      operation.current += 1;
      stopDemoPeers();
      connection.current?.close();
      connection.current = null;
      peers.current?.close();
      peers.current = null;
      speaker.close();
      media.stop();
    };
  }, [media, speaker, stopDemoPeers]);

  useEffect(() => {
    const tracks = new Map<string, MediaStreamTrack>();
    if (peerManager && selfSocketId && snapshot?.stageSocketIds.includes(selfSocketId)) {
      for (const id of snapshot.stageSocketIds) {
        const track =
          id === selfSocketId ? media.microphoneTrack() : streams.get(id)?.getAudioTracks()[0];
        const person = snapshot.participants.find((participant) => participant.socketId === id);
        if (track && !person?.isAudioMuted) tracks.set(id, track);
      }
    }
    try {
      speaker.sync(tracks);
    } catch {
      speaker.close();
    }
  }, [media, peerManager, selfSocketId, snapshot, speaker, streams]);

  useEffect(() => {
    media.applyFlags(self?.isAudioMuted ?? isAudioMuted, self?.isVideoOff ?? isVideoOff);
  }, [media, self, isAudioMuted, isVideoOff, ready]);

  function stopMedia() {
    operation.current += 1;
    stopDemoPeers();
    peers.current?.close();
    peers.current = null;
    speaker.close();
    media.stop();
    setSharing(false);
    setPeerManager(null);
    setReady(false);
    setBusy(false);
  }

  async function spawnDemoPeer() {
    const active = connection.current;
    if (!active || self?.role !== 'HOST' || demoStartPending.current) return;
    const name = nextDemoPeerName(demoPeers.current.keys());
    if (!name) return;
    const generation = operation.current;
    const version = ++demoStartVersion.current;
    const valid = () => generation === operation.current && connection.current === active;
    demoStartPending.current = true;
    setDemoStarting(true);
    setError('');
    let demo: DemoPeer | null = null;
    try {
      const context = new AudioContext();
      demo = new DemoPeer(
        name,
        context,
        (message) => {
          if (valid()) setError(message);
        },
        () => {
          if (demoPeers.current.get(name) !== demo) return;
          demoPeers.current.delete(name);
          setDemoCount(demoPeers.current.size);
        },
      );
      demoPeers.current.set(name, demo);
      setDemoCount(demoPeers.current.size);
      // Resume synchronously in the click, before minting the guest or opening its socket.
      await context.resume();
      if (!valid() || version !== demoStartVersion.current) {
        demo.stop();
        return;
      }
      await demo.start(room.id);
    } catch (failure) {
      demo?.stop();
      if (valid() && version === demoStartVersion.current)
        setError(failure instanceof Error ? failure.message : 'Unable to start a demo peer.');
    } finally {
      if (version === demoStartVersion.current) {
        demoStartPending.current = false;
        setDemoStarting(false);
      }
    }
  }

  async function prepare(nextChoices = choices) {
    const video = preview.current;
    if (!video || attendee) return;
    const current = ++operation.current;
    setBusy(true);
    setReady(false);
    setError('');
    setSpeakerError('');
    setChoices(nextChoices);
    try {
      const prepared = await media.prepare(video, nextChoices);
      if (current !== operation.current || !prepared) return;
      setDevices(await navigator.mediaDevices.enumerateDevices());
      if (current !== operation.current) return;
      const route = await media.setSpeaker(speakerId);
      if (current !== operation.current) return;
      setSinkSupported(route.supported);
      if (route.ok) setSpeakerId(route.deviceId);
      else {
        setSpeakerId('');
        setSpeakerError(route.message);
      }
      setReady(media.ready);
    } catch (failure) {
      if (current === operation.current) {
        media.stop();
        setReady(false);
        setError(failure instanceof Error ? failure.message : 'Unable to prepare your devices.');
      }
    } finally {
      if (current === operation.current) setBusy(false);
    }
  }

  async function join() {
    if (!attendee && !media.ready) {
      setReady(false);
      setError('Enable your camera and microphone before joining.');
      return;
    }
    setBusy(true);
    setError('');
    let active: RoomConnection | null = null;
    try {
      active = openSignaling(session.token, room.id, {
        onDescription: (payload) => peers.current?.description(payload),
        onCandidate: (payload) => peers.current?.candidate(payload),
        onEnded: () => {
          connection.current = null;
          stopMedia();
          onEnded();
        },
        onDisconnect: () => {
          connection.current = null;
          stopMedia();
          setError('The live room reset. Join again.');
        },
      });
      connection.current = active;
      const result = await active.join({
        roomId: room.id,
        isAudioMuted: attendee || isAudioMuted,
        isVideoOff: attendee || isVideoOff,
        isSyntheticBot: false,
      });
      if (connection.current !== active) return;
      if (!result.ok) {
        active.close();
        connection.current = null;
        setError(result.message);
        if (result.error === 'room_ended') {
          stopMedia();
          onEnded();
        }
      } else media.releaseLobby();
    } catch (failure) {
      if (active && connection.current !== active) return;
      active?.close();
      connection.current = null;
      setError(failure instanceof Error ? failure.message : 'Unable to join this room.');
    } finally {
      setBusy(false);
    }
  }

  async function send(action: (active: RoomConnection) => Promise<CommandAck>) {
    const active = connection.current;
    if (!active) return;
    setBusy(true);
    setError('');
    try {
      const result = await action(active);
      if (connection.current === active && !result.ok) setError(result.message);
    } catch {
      if (connection.current === active) setError('Unable to update the room. Try again.');
    } finally {
      setBusy(false);
    }
  }

  async function leave() {
    const active = connection.current;
    stopMedia();
    setBusy(true);
    setError('');
    try {
      if (active) {
        const result = await active.leave();
        if (!result.ok) setError(result.message);
      }
    } catch {
      // Closing the socket below also uses the server's leave path.
    } finally {
      active?.close();
      connection.current = null;
      setBusy(false);
    }
  }

  async function stopSharing(expectedTrack = media.screenTrack()) {
    if (media.screenTrack() !== expectedTrack) return;
    const active = connection.current;
    const manager = peers.current;
    const current = operation.current;
    const version = ++shareVersion.current;
    if (expectedTrack) expectedTrack.onended = null;
    setBusy(true);
    setError('');
    try {
      await manager?.replaceVideoTrack(media.cameraTrack());
    } catch {
      if (current === operation.current)
        setError('Unable to restore your camera. Leave and join again to retry.');
    } finally {
      if (media.screenTrack() === expectedTrack) media.stopScreenShare();
    }
    if (current !== operation.current || version !== shareVersion.current) return;
    setSharing(false);
    try {
      if (active && connection.current === active) {
        const result = await active.media({ isScreenSharing: false });
        if (!result.ok && current === operation.current) setError(result.message);
      }
    } catch {
      if (current === operation.current)
        setError('Screen sharing stopped, but the room could not be updated.');
    } finally {
      if (current === operation.current) setBusy(false);
    }
  }

  async function startSharing() {
    const active = connection.current;
    const manager = peers.current;
    if (!active || !manager || !selfSocketId || !snapshot?.stageSocketIds.includes(selfSocketId))
      return;
    const current = operation.current;
    const version = ++shareVersion.current;
    const valid = () =>
      current === operation.current &&
      version === shareVersion.current &&
      connection.current === active &&
      peers.current === manager;
    let track: MediaStreamTrack | undefined;
    let announced = false;
    setBusy(true);
    setError('');
    try {
      track = await media.startScreenShare();
      if (!valid()) return;
      track.onended = () => {
        void stopSharing(track);
      };
      await manager.replaceVideoTrack(track);
      if (!valid()) return;
      setSharing(true);
      announced = true;
      const result = await active.media({ isScreenSharing: true });
      if (!result.ok) throw new Error(result.message);
    } catch (failure) {
      if (!valid()) return;
      if (track) {
        try {
          await manager.replaceVideoTrack(media.cameraTrack());
        } catch {
          /* The error below leaves the roster and leave action available. */
        }
        if (!valid()) return;
        media.stopScreenShare();
        setSharing(false);
      }
      if (announced) await active.media({ isScreenSharing: false }).catch(() => undefined);
      if (valid())
        setError(
          failure instanceof Error ? failure.message : 'Unable to share your screen. Try again.',
        );
    } finally {
      if (valid()) setBusy(false);
    }
  }

  return (
    <div className="live-room">
      <div className="lobby-heading">
        <div>
          <p className="eyebrow">{joined ? 'In the room' : 'Before you join'}</p>
          <h2>{joined ? `Welcome, ${session.displayName}` : 'Your green room'}</h2>
        </div>
        <span className="muted">
          {attendee ? 'Joining as an attendee' : 'Up to 4 people on stage'}
        </span>
      </div>
      {joined &&
        snapshot &&
        selfSocketId &&
        snapshot.stageSocketIds.includes(selfSocketId) &&
        peerManager && (
          <StageGrid
            snapshot={snapshot}
            selfSocketId={selfSocketId}
            localStream={media.previewStream()}
            streams={streams}
            manager={peerManager}
            speakerId={speakerId}
            activeSocketId={activeSocketId}
          />
        )}
      {self?.role === 'HOST' &&
        snapshot &&
        selfSocketId &&
        snapshot.stageSocketIds.includes(selfSocketId) &&
        peerManager && <StatsDrawer manager={peerManager} snapshot={snapshot} />}
      {self?.role === 'HOST' && (
        <div className="demo-controls" aria-label="Demo peers" aria-busy={demoStarting}>
          <button
            id="spawn-demo-peer"
            className="button button-secondary"
            disabled={busy || demoStarting || demoCount >= 3}
            onClick={() => void spawnDemoPeer()}
          >
            Spawn demo peer
          </button>
          <button
            id="remove-demo-peers"
            className="button button-secondary"
            disabled={demoCount === 0}
            onClick={stopDemoPeers}
          >
            Remove demo peers
          </button>
          <span className="muted" role="status">
            {demoStarting ? 'Starting demo peer…' : `${demoCount} of 3 demo peers`}
          </span>
        </div>
      )}
      <div className={attendee || joined ? 'attendee-lobby' : 'lobby-grid'}>
        {!attendee && !joined && (
          <div className="preview-panel">
            <div className="preview-frame">
              <video ref={preview} autoPlay muted playsInline aria-label="Your camera preview" />
              {(!ready || (self?.isVideoOff ?? isVideoOff)) && (
                <p className="preview-placeholder">
                  {ready ? 'Your camera is off' : 'Your preview will appear here'}
                </p>
              )}
              <span className="preview-name">{session.displayName} · You</span>
            </div>
            <MicrophoneMeter media={media} />
          </div>
        )}
        {!joined && (
          <div className="device-panel">
            {attendee ? (
              <p className="muted">
                You will join as an attendee. You can see the roster and raise your hand. No camera
                or microphone is needed.
              </p>
            ) : (
              <>
                <p className="muted">
                  Check your camera and microphone before joining. Both permissions are required.
                </p>
                <button
                  id="enable-devices"
                  className="button button-secondary"
                  disabled={busy}
                  onClick={() => void prepare()}
                >
                  {busy
                    ? 'Preparing…'
                    : ready
                      ? 'Check devices again'
                      : 'Enable camera and microphone'}
                </button>
                <fieldset className="device-fields" disabled={busy || !ready}>
                  <legend className="sr-only">Your devices</legend>
                  <label htmlFor="camera-device">Camera</label>
                  <select
                    id="camera-device"
                    value={choices.cameraId}
                    onChange={(event) => void prepare({ ...choices, cameraId: event.target.value })}
                  >
                    <option value="">System default</option>
                    {devices
                      .filter((device) => device.kind === 'videoinput' && device.deviceId)
                      .map((device, index) => (
                        <option key={device.deviceId} value={device.deviceId}>
                          {device.label || `Camera ${index + 1}`}
                        </option>
                      ))}
                  </select>
                  <label htmlFor="microphone-device">Microphone</label>
                  <select
                    id="microphone-device"
                    value={choices.microphoneId}
                    onChange={(event) =>
                      void prepare({ ...choices, microphoneId: event.target.value })
                    }
                  >
                    <option value="">System default</option>
                    {devices
                      .filter((device) => device.kind === 'audioinput' && device.deviceId)
                      .map((device, index) => (
                        <option key={device.deviceId} value={device.deviceId}>
                          {device.label || `Microphone ${index + 1}`}
                        </option>
                      ))}
                  </select>
                  <label htmlFor="speaker-device">Speaker</label>
                  <select
                    id="speaker-device"
                    value={speakerId}
                    disabled={!sinkSupported}
                    onChange={(event) => {
                      const id = event.target.value;
                      void media.setSpeaker(id).then((result) => {
                        setSinkSupported(result.supported);
                        if (result.ok) {
                          setSpeakerId(result.deviceId);
                          setSpeakerError('');
                        } else {
                          setSpeakerId('');
                          setSpeakerError(result.message);
                        }
                      });
                    }}
                  >
                    <option value="">System default</option>
                    {sinkSupported &&
                      devices
                        .filter((device) => device.kind === 'audiooutput' && device.deviceId)
                        .map((device, index) => (
                          <option key={device.deviceId} value={device.deviceId}>
                            {device.label || `Speaker ${index + 1}`}
                          </option>
                        ))}
                  </select>
                  {!sinkSupported && (
                    <p className="field-hint">This browser uses the default speaker output.</p>
                  )}
                  {speakerError && (
                    <p className="error-message" role="alert">
                      {speakerError}
                    </p>
                  )}
                </fieldset>
              </>
            )}
          </div>
        )}
        {joined && snapshot && (
          <div className="roster-panel" aria-labelledby="roster-heading">
            <h2 id="roster-heading">
              In this room <span className="roster-count">{snapshot.participants.length}</span>
            </h2>
            <ul className="roster" aria-live="polite">
              {snapshot.participants.map((participant) => (
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
        )}
      </div>
      {error && (
        <p className="error-message" role="alert">
          Error: {error}
        </p>
      )}
      <div className="live-actions" aria-busy={busy}>
        {!attendee && (
          <>
            <button
              id="toggle-audio"
              className="button button-secondary"
              disabled={busy || (!joined && !ready)}
              aria-pressed={self?.isAudioMuted ?? isAudioMuted}
              onClick={() =>
                self
                  ? void send((active) => active.media({ isAudioMuted: !self.isAudioMuted }))
                  : setAudioMuted(!isAudioMuted)
              }
            >
              {(self?.isAudioMuted ?? isAudioMuted) ? 'Unmute microphone' : 'Mute microphone'}
            </button>
            <button
              id="toggle-video"
              className="button button-secondary"
              disabled={busy || (!joined && !ready)}
              aria-pressed={self?.isVideoOff ?? isVideoOff}
              onClick={() =>
                self
                  ? void send((active) => active.media({ isVideoOff: !self.isVideoOff }))
                  : setVideoOff(!isVideoOff)
              }
            >
              {(self?.isVideoOff ?? isVideoOff) ? 'Turn camera on' : 'Turn camera off'}
            </button>
          </>
        )}
        {joined &&
          selfSocketId &&
          snapshot?.stageSocketIds.includes(selfSocketId) &&
          peerManager && (
            <button
              id="toggle-screen-share"
              className="button button-secondary"
              disabled={busy}
              aria-pressed={isSharing}
              onClick={() => void (isSharing ? stopSharing() : startSharing())}
            >
              {isSharing ? 'Stop sharing' : 'Share screen'}
            </button>
          )}
        {self?.role === 'ATTENDEE' && (
          <button
            id="toggle-hand"
            className="button button-secondary"
            disabled={busy}
            aria-pressed={self.isHandRaised}
            onClick={() => void send((active) => active.hand(!self.isHandRaised))}
          >
            {self.isHandRaised ? 'Lower hand' : 'Raise hand'}
          </button>
        )}
        {joined ? (
          <button
            id="leave-room"
            className="button button-secondary leave-button"
            disabled={busy}
            onClick={() => void leave()}
          >
            Leave room
          </button>
        ) : (
          <button
            id="join-live-room"
            className="button button-primary"
            disabled={busy || (!attendee && !ready)}
            onClick={() => void join()}
          >
            {busy ? 'Please wait…' : attendee ? 'Join as attendee' : 'Join live room'}
          </button>
        )}
      </div>
    </div>
  );
}
