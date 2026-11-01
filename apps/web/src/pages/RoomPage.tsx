import { Link, useParams } from 'react-router';
import { useEffect, useRef, useState } from 'react';
import { skipToken, useQuery } from '@tanstack/react-query';
import type { CommandAck, GuestSessionResponse, RoomResponse } from '@stageflow/shared';
import { getRoom } from '../api';
import { useSessionStore } from '../session';
import { LocalMedia, type DeviceChoices } from '../live/local-media';
import { openSignaling, type RoomConnection } from '../live/signaling';
import { useRoomStore } from '../live/room-store';
import { PeerManager, type RemoteStreams } from '../live/peer-manager';
import { StageGrid } from '../live/stage-grid';
import { ActiveSpeaker } from '../live/active-speaker';

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
        <Link className="text-link" to="/">Enter your name <span aria-hidden="true">↗</span></Link>
      </section>
    );
  }

  if (roomQuery.isPending) return <p className="page-state muted" role="status">Opening room…</p>;
  if (roomQuery.isError) {
    return (
      <section className="page-state">
        <h1>Unable to open this room.</h1>
        <p className="error-message" role="alert">Error: {roomQuery.error.message}</p>
        <Link className="text-link" to="/">Back to home <span aria-hidden="true">↗</span></Link>
      </section>
    );
  }

  return <RoomContents key={`${roomQuery.data.id}:${session.userId}`} room={roomQuery.data} session={session} />;
}

function RoomContents({ room, session }: { room: RoomResponse; session: GuestSessionResponse }) {
  const [ended, setEnded] = useState(room.status === 'ENDED');
  const isEnded = ended || room.status === 'ENDED';
  return (
    <section className="room-page" aria-labelledby="room-heading">
      <Link className="back-link" to="/">← Back to home</Link>
      <div className="room-heading-row">
        <div><p className="eyebrow">Your room</p><h1 id="room-heading">{room.title}</h1></div>
        <span className={`status-badge${isEnded ? ' status-ended' : ''}`}><span aria-hidden="true" />{isEnded ? 'ENDED' : room.status}</span>
      </div>
      <dl className="room-details">
        <div><dt>Format</dt><dd>{room.mode}</dd></div>
        <div><dt>Room slug</dt><dd className="room-slug">{room.slug}</dd></div>
        <div><dt>Hosted by</dt><dd>{room.hostDisplayName}</dd></div>
      </dl>
      {isEnded ? <p className="room-ended" role="status">This room has ended.</p>
        : <LiveRoom room={room} session={session} onEnded={() => setEnded(true)} />}
      <aside className="foundation-note room-foundation">
        <span className="note-marker" aria-hidden="true">i</span>
        <div><h2>A shared room.</h2><p>People on stage can see and hear each other. Stage video is only for people on stage.</p></div>
      </aside>
    </section>
  );
}

function LiveRoom({ room, session, onEnded }: {
  room: RoomResponse; session: GuestSessionResponse; onEnded: () => void;
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
  const [ready, setReady] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [level, setLevel] = useState(0);
  const [choices, setChoices] = useState<DeviceChoices>({ cameraId: '', microphoneId: '' });
  const [speakerId, setSpeakerId] = useState('');
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  const [sinkSupported, setSinkSupported] = useState(false);
  const [isAudioMuted, setAudioMuted] = useState(false);
  const [isVideoOff, setVideoOff] = useState(false);
  const snapshot = useRoomStore((state) => state.snapshot);
  const selfSocketId = useRoomStore((state) => state.selfSocketId);
  const self = snapshot?.participants.find((participant) => participant.socketId === selfSocketId);
  const joined = selfSocketId !== null;

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
      connection.current?.close();
      connection.current = null;
      peers.current?.close();
      peers.current = null;
      speaker.close();
      media.stop();
    };
  }, [media, speaker]);

  useEffect(() => {
    const tracks = new Map<string, MediaStreamTrack>();
    if (peerManager && selfSocketId && snapshot?.stageSocketIds.includes(selfSocketId)) {
      for (const id of snapshot.stageSocketIds) {
        const track = id === selfSocketId ? media.microphoneTrack() : streams.get(id)?.getAudioTracks()[0];
        const person = snapshot.participants.find((participant) => participant.socketId === id);
        if (track && !person?.isAudioMuted) tracks.set(id, track);
      }
    }
    try { speaker.sync(tracks); }
    catch { speaker.close(); }
  }, [media, peerManager, selfSocketId, snapshot, speaker, streams]);

  useEffect(() => {
    media.applyFlags(self?.isAudioMuted ?? isAudioMuted, self?.isVideoOff ?? isVideoOff);
  }, [media, self, isAudioMuted, isVideoOff, ready]);

  function stopMedia() {
    operation.current += 1;
    peers.current?.close();
    peers.current = null;
    speaker.close();
    media.stop();
    setPeerManager(null);
    setReady(false);
    setLevel(0);
    setBusy(false);
  }

  async function prepare(nextChoices = choices) {
    const video = preview.current;
    if (!video || attendee) return;
    const current = ++operation.current;
    setBusy(true);
    setReady(false);
    setError('');
    setLevel(0);
    setChoices(nextChoices);
    try {
      const prepared = await media.prepare(video, nextChoices, setLevel);
      if (current !== operation.current || !prepared) return;
      setDevices(await navigator.mediaDevices.enumerateDevices());
      if (current !== operation.current) return;
      setSinkSupported(await media.setSpeaker(speakerId));
      setReady(media.ready);
    } catch (failure) {
      if (current === operation.current) {
        media.stop();
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
        onEnded: () => { connection.current = null; stopMedia(); onEnded(); },
        onDisconnect: () => {
          connection.current = null;
          stopMedia();
          setError('The live room reset. Join again.');
        },
      });
      connection.current = active;
      const result = await active.join({ roomId: room.id, isAudioMuted: attendee || isAudioMuted,
        isVideoOff: attendee || isVideoOff, isSyntheticBot: false });
      if (connection.current !== active) return;
      if (!result.ok) {
        active.close();
        connection.current = null;
        setError(result.message);
        if (result.error === 'room_ended') { stopMedia(); onEnded(); }
      }
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

  return (
    <div className="live-room">
      <div className="lobby-heading">
        <div><p className="eyebrow">{joined ? 'In the room' : 'Before you join'}</p><h2>{joined ? `Welcome, ${session.displayName}` : 'Your green room'}</h2></div>
        <span className="muted">{attendee ? 'Joining as an attendee' : 'Up to 4 people on stage'}</span>
      </div>
      {joined && snapshot && selfSocketId && snapshot.stageSocketIds.includes(selfSocketId) && peerManager &&
        <StageGrid snapshot={snapshot} selfSocketId={selfSocketId} localStream={media.previewStream()}
          streams={streams} manager={peerManager} speakerId={speakerId} activeSocketId={activeSocketId} />}
      <div className={attendee || joined ? 'attendee-lobby' : 'lobby-grid'}>
        {!attendee && !joined && <div className="preview-panel">
          <div className="preview-frame">
            <video ref={preview} autoPlay muted playsInline aria-label="Your camera preview" />
            {(!ready || (self?.isVideoOff ?? isVideoOff)) && <p className="preview-placeholder">{ready ? 'Your camera is off' : 'Your preview will appear here'}</p>}
            <span className="preview-name">{session.displayName} · You</span>
          </div>
          <label className="meter-label" htmlFor="microphone-level">Microphone level</label>
          <meter id="microphone-level" min={0} max={1} value={level} aria-label="Microphone level" />
        </div>}
        {!joined && <div className="device-panel">
          {attendee ? <p className="muted">You will join as an attendee. You can see the roster and raise your hand. No camera or microphone is needed.</p> : <>
            <p className="muted">Check your camera and microphone before joining. Both permissions are required.</p>
            <button id="enable-devices" className="button button-secondary" disabled={busy} onClick={() => void prepare()}>{busy ? 'Preparing…' : ready ? 'Check devices again' : 'Enable camera and microphone'}</button>
            <fieldset className="device-fields" disabled={busy || !ready}>
              <legend className="sr-only">Your devices</legend>
              <label htmlFor="camera-device">Camera</label>
              <select id="camera-device" value={choices.cameraId} onChange={(event) => void prepare({ ...choices, cameraId: event.target.value })}>
                <option value="">System default</option>
                {devices.filter((device) => device.kind === 'videoinput' && device.deviceId).map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Camera ${index + 1}`}</option>)}
              </select>
              <label htmlFor="microphone-device">Microphone</label>
              <select id="microphone-device" value={choices.microphoneId} onChange={(event) => void prepare({ ...choices, microphoneId: event.target.value })}>
                <option value="">System default</option>
                {devices.filter((device) => device.kind === 'audioinput' && device.deviceId).map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Microphone ${index + 1}`}</option>)}
              </select>
              <label htmlFor="speaker-device">Speaker</label>
              <select id="speaker-device" value={speakerId} disabled={!sinkSupported} onChange={(event) => {
                const id = event.target.value;
                setSpeakerId(id);
                void media.setSpeaker(id).catch(() => setError('Unable to select that speaker. Try another output.'));
              }}>
                <option value="">System default</option>
                {sinkSupported && devices.filter((device) => device.kind === 'audiooutput' && device.deviceId).map((device, index) => <option key={device.deviceId} value={device.deviceId}>{device.label || `Speaker ${index + 1}`}</option>)}
              </select>
              {!sinkSupported && <p className="field-hint">This browser uses the default speaker output.</p>}
            </fieldset>
          </>}
        </div>}
        {joined && snapshot && <div className="roster-panel" aria-labelledby="roster-heading">
          <h2 id="roster-heading">In this room <span className="roster-count">{snapshot.participants.length}</span></h2>
          <ul className="roster" aria-live="polite">
            {snapshot.participants.map((participant) => <li key={participant.socketId} className="roster-row">
              <div className="roster-person"><strong>{participant.displayName}{participant.socketId === selfSocketId ? ' (You)' : ''}</strong><span className="role-label">{participant.role}</span></div>
              <div className="roster-flags"><span>{participant.isAudioMuted ? 'Muted' : 'Mic on'}</span><span>{participant.isVideoOff ? 'Video off' : 'Video on'}</span>{participant.isHandRaised && <span className="raised-hand">Hand raised</span>}</div>
            </li>)}
          </ul>
        </div>}
      </div>
      {error && <p className="error-message" role="alert">Error: {error}</p>}
      <div className="live-actions" aria-busy={busy}>
        {!attendee && <>
          <button id="toggle-audio" className="button button-secondary" disabled={busy || (!joined && !ready)} aria-pressed={self?.isAudioMuted ?? isAudioMuted}
            onClick={() => self ? void send((active) => active.media({ isAudioMuted: !self.isAudioMuted })) : setAudioMuted(!isAudioMuted)}>
            {(self?.isAudioMuted ?? isAudioMuted) ? 'Unmute microphone' : 'Mute microphone'}
          </button>
          <button id="toggle-video" className="button button-secondary" disabled={busy || (!joined && !ready)} aria-pressed={self?.isVideoOff ?? isVideoOff}
            onClick={() => self ? void send((active) => active.media({ isVideoOff: !self.isVideoOff })) : setVideoOff(!isVideoOff)}>
            {(self?.isVideoOff ?? isVideoOff) ? 'Turn camera on' : 'Turn camera off'}
          </button>
        </>}
        {self?.role === 'ATTENDEE' && <button id="toggle-hand" className="button button-secondary" disabled={busy} aria-pressed={self.isHandRaised}
          onClick={() => void send((active) => active.hand(!self.isHandRaised))}>{self.isHandRaised ? 'Lower hand' : 'Raise hand'}</button>}
        {joined ? <button id="leave-room" className="button button-secondary leave-button" disabled={busy} onClick={() => void leave()}>Leave room</button>
          : <button id="join-live-room" className="button button-primary" disabled={busy || (!attendee && !ready)} onClick={() => void join()}>{busy ? 'Please wait…' : attendee ? 'Join as attendee' : 'Join live room'}</button>}
      </div>
    </div>
  );
}
