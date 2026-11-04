import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  JoinAck,
  ParticipantRole,
  ParticipantState,
  RelayedDescription,
  RoomResponse,
  RoomSnapshot,
  ResumeAck,
} from '@stageflow/shared';
import type { DemoFactory } from './demo-registry';
import type { PeerManager } from './peer-manager';
import type { BroadcastRecorder, RecorderFinish } from '../../broadcast/services/stage-recorder';
import type { InputKind } from './local-media';
import { RoomSession, type RoomMedia, type RoomSessionOptions } from './room-session';
import { useRoomStore } from '../stores/room-store';
import type { RoomConnection } from './signaling';

const room: RoomResponse = {
  id: 'room-1',
  slug: 'room-slug',
  title: 'Demo',
  mode: 'MEETING',
  status: 'LIVE',
  hostId: 'user-1',
  hostDisplayName: 'Ada',
  createdAt: '2026-11-01T00:00:00.000Z',
  endedAt: null,
};

const webinar: RoomResponse = { ...room, mode: 'WEBINAR', hostId: 'host-user' };

function person(participantId: string, role: ParticipantRole): ParticipantState {
  return {
    participantId,
    socketId: `socket-${participantId}`,
    connectionGeneration: 1,
    presence: 'connected',
    userId: participantId,
    displayName: participantId,
    role,
    isAudioMuted: false,
    isVideoOff: false,
    isScreenSharing: false,
    isHandRaised: false,
    isSyntheticBot: false,
    hostAudioLocked: false,
    hostVideoLocked: false,
    joinedAt: 0,
  };
}

function snapshot(
  participantId: string,
  role: ParticipantRole,
  onStage: boolean,
  revision: number,
): RoomSnapshot {
  return {
    revision,
    roomId: room.id,
    mode: 'MEETING',
    status: 'LIVE',
    participants: [person(participantId, role)],
    stageParticipantIds: onStage ? [participantId] : [],
    handParticipantIds: [],
    broadcast: null,
  };
}

function liveTrack(kind: 'audio' | 'video'): MediaStreamTrack {
  const captured = {
    kind,
    enabled: true,
    readyState: 'live' as MediaStreamTrackState,
    stop: vi.fn(() => {
      captured.readyState = 'ended';
    }),
  };
  return captured as unknown as MediaStreamTrack;
}

class FakeMedia implements RoomMedia {
  screen: MediaStreamTrack | null = null;
  microphone: MediaStreamTrack | null = null;
  camera: MediaStreamTrack | null = null;
  held: { kind: InputKind; track: MediaStreamTrack } | null = null;
  ready = false;
  stopped = 0;
  lobbyReleased = 0;
  prepareCalls = 0;
  prepareImpl: RoomMedia['prepare'] = async () => {
    this.prepareCalls += 1;
    this.ready = true;
    return true;
  };

  prepare(video: HTMLVideoElement, choices: { cameraId: string; microphoneId: string }) {
    return this.prepareImpl(video, choices);
  }
  stop(): void {
    this.stopped += 1;
    this.ready = false;
    this.stopScreenShare();
  }
  releaseLobby(): void {
    this.lobbyReleased += 1;
  }
  applyFlags = vi.fn<RoomMedia['applyFlags']>();
  replaceInput = vi.fn<RoomMedia['replaceInput']>(async (kind) => {
    const track = liveTrack(kind === 'camera' ? 'video' : 'audio');
    this.held = { kind, track };
    return track;
  });
  commitInput = vi.fn<RoomMedia['commitInput']>((kind, track) => {
    if (this.held?.track !== track || this.held.kind !== kind) {
      track.stop();
      return;
    }
    this.held = null;
    if (kind === 'microphone') {
      this.microphone?.stop();
      this.microphone = track;
      return;
    }
    this.camera?.stop();
    this.camera = track;
  });
  abortInput = vi.fn<RoomMedia['abortInput']>((track) => {
    if (this.held?.track === track) this.held = null;
    track.stop();
  });
  ended: ((kind: InputKind) => void) | null = null;
  setEndedListener(listener: ((kind: InputKind) => void) | null): void {
    this.ended = listener;
  }
  setSpeaker(): Promise<{ ok: boolean; supported: boolean; deviceId: string; message: string }> {
    return Promise.resolve({ ok: true, supported: false, deviceId: '', message: '' });
  }
  microphoneTrack(): MediaStreamTrack | null {
    return this.microphone?.readyState === 'live' ? this.microphone : null;
  }
  cameraTrack(): MediaStreamTrack | null {
    return this.camera?.readyState === 'live' ? this.camera : null;
  }
  screenTrack(): MediaStreamTrack | null {
    return this.screen;
  }
  previewStream(): null {
    return null;
  }
  startScreenShare(): Promise<MediaStreamTrack> {
    return Promise.reject(new Error('Screen sharing is not used in this test.'));
  }
  stopScreenShare(): void {
    this.screen?.stop();
    this.screen = null;
  }
  setLevelListener(): void {}
}

function fakePeers() {
  return {
    sync: vi.fn(),
    close: vi.fn(),
    description: vi.fn(),
    candidate: vi.fn(),
    replaceVideoTrack: vi.fn<(track: MediaStreamTrack | null) => Promise<void>>(() =>
      Promise.resolve(),
    ),
    replaceAudioTrack: vi.fn<(track: MediaStreamTrack | null) => Promise<void>>(() =>
      Promise.resolve(),
    ),
    statsConnections: () => [],
  };
}

function fakeConnection() {
  return {
    chatHistory: vi.fn<RoomConnection['chatHistory']>(async () => ({
      ok: true,
      paused: false,
      messages: [],
      oldestSequence: null,
      latestSequence: null,
      retentionGap: false,
    })),
    chatSend: vi.fn<RoomConnection['chatSend']>(),
    chatSetPaused: vi.fn<RoomConnection['chatSetPaused']>(),
    resume: vi.fn<RoomConnection['resume']>(async () => ({
      ok: true,
      participantId: 'self',
      connectionGeneration: 2,
      iceServers: [],
      snapshot: recoveredSnapshot(),
    })),
    description: vi.fn(() => Promise.resolve({ ok: true as const })),
    candidate: vi.fn(() => Promise.resolve({ ok: true as const })),
    join: vi.fn<() => Promise<JoinAck>>(() =>
      Promise.resolve({ ok: true, participantId: 'self', iceServers: [] }),
    ),
    media: vi.fn<RoomConnection['media']>(async () => ({ ok: true })),
    hand: vi.fn(() => Promise.resolve({ ok: true as const })),
    promote: vi.fn<RoomConnection['promote']>(async () => ({ ok: true })),
    demote: vi.fn<RoomConnection['demote']>(async () => ({ ok: true })),
    setLock: vi.fn<RoomConnection['setLock']>(async () => ({ ok: true })),
    startBroadcast: vi.fn<RoomConnection['startBroadcast']>(async () => ({ ok: true })),
    stopBroadcast: vi.fn<RoomConnection['stopBroadcast']>(async () => ({ ok: true })),
    leave: vi.fn(() => Promise.resolve({ ok: true as const })),
    close: vi.fn(),
  };
}

function recorderFake() {
  return {
    start: vi.fn(),
    update: vi.fn(),
    stop: vi.fn(),
    finish: vi.fn(() => Promise.resolve<RecorderFinish>({ ok: true })),
  };
}

function harness(options?: {
  room?: RoomResponse;
  userId?: string;
  onEnded?: () => void;
  createDemo?: DemoFactory;
  createRecorder?: (options: {
    broadcastId: string;
    token: string;
    onCap: () => void;
  }) => BroadcastRecorder;
  enumerateDevices?: () => Promise<MediaDeviceInfo[]>;
  freshConnections?: boolean;
  resume?: RoomConnection['resume'];
}) {
  const media = new FakeMedia();
  const peers = fakePeers();
  const connection = fakeConnection();
  const speaker = { sync: vi.fn(), close: vi.fn() };
  type SessionCallbacks = Parameters<NonNullable<RoomSessionOptions['openSignaling']>>[2];
  let callbacks: SessionCallbacks | null = null;
  const opened: { connection: ReturnType<typeof fakeConnection>; callbacks: SessionCallbacks }[] =
    [];
  const opens = vi.fn<NonNullable<RoomSessionOptions['openSignaling']>>((_token, roomId, next) => {
    callbacks = next;
    const nextConnection =
      options?.freshConnections && opened.length ? fakeConnection() : connection;
    if (options?.resume) nextConnection.resume.mockImplementation(options.resume);
    opened.push({ connection: nextConnection, callbacks: next });
    useRoomStore.getState().begin(roomId);
    return nextConnection;
  });
  const session = new RoomSession({
    room: options?.room ?? room,
    userId: options?.userId ?? 'user-1',
    token: 'token',
    onEnded: options?.onEnded ?? (() => undefined),
    media,
    openSignaling: opens,
    createPeers: () => peers as unknown as PeerManager,
    createSpeaker: () => speaker,
    createDemo: options?.createDemo,
    createAudioContext: () => ({
      state: 'running',
      resume: () => Promise.resolve(),
      close: () => Promise.resolve(),
    }),
    enumerateDevices: options?.enumerateDevices ?? (() => Promise.resolve([])),
    createRecorder: options?.createRecorder,
  });
  session.attach();
  return {
    session,
    media,
    peers,
    connection,
    speaker,
    opens,
    opened,
    callbacks: () => callbacks,
  };
}

function recoveredSnapshot(role: ParticipantRole = 'HOST', revision = 10): RoomSnapshot {
  return {
    ...snapshot('self', role, role !== 'ATTENDEE', revision),
    participants: [
      {
        ...person('self', role),
        connectionGeneration: 2,
        socketId: 'resumed-self',
        isAudioMuted: true,
        isVideoOff: true,
      },
    ],
  };
}

function device(kind: MediaDeviceKind, deviceId: string): MediaDeviceInfo {
  return { kind, deviceId, label: deviceId, groupId: '' } as MediaDeviceInfo;
}

function stubDeviceList() {
  const target = new EventTarget();
  const names = new Set<EventListener>();
  const getUserMedia = vi.fn();
  const mediaDevices = {
    getUserMedia,
    addEventListener(type: string, listener: EventListener) {
      if (type === 'devicechange') names.add(listener);
      target.addEventListener(type, listener);
    },
    removeEventListener(type: string, listener: EventListener) {
      if (type === 'devicechange') names.delete(listener);
      target.removeEventListener(type, listener);
    },
    dispatch() {
      target.dispatchEvent(new Event('devicechange'));
    },
  };
  vi.stubGlobal('navigator', { mediaDevices });
  return { getUserMedia, names, dispatch: () => mediaDevices.dispatch() };
}

describe('RoomSession', () => {
  const sessions: RoomSession[] = [];

  afterEach(() => {
    for (const session of sessions) session.dispose();
    sessions.length = 0;
    useRoomStore.getState().clear();
    vi.unstubAllGlobals();
    vi.useRealTimers();
  });

  function open(options?: Parameters<typeof harness>[0]) {
    const created = harness(options);
    sessions.push(created.session);
    return created;
  }

  function pageLifecycle() {
    const target = new EventTarget();
    vi.stubGlobal('window', {
      addEventListener: target.addEventListener.bind(target),
      removeEventListener: target.removeEventListener.bind(target),
    });
    return (name: 'pagehide' | 'pageshow') => target.dispatchEvent(new Event(name));
  }

  it('discards permission that resolves after page exit and keeps restored capture disabled', async () => {
    const page = pageLifecycle();
    const h = open();
    let resolvePrepare!: (ready: boolean) => void;
    h.media.prepareImpl = () =>
      new Promise((resolve) => {
        resolvePrepare = resolve;
      });
    const preparing = h.session.prepare({} as HTMLVideoElement);
    page('pagehide');
    page('pageshow');
    h.media.ready = true;
    resolvePrepare(true);
    await preparing;
    expect(h.media.ready).toBe(false);
    expect(h.session.ready).toBe(false);
    expect(h.session.preparing).toBe(false);
    expect(h.session.phase).toBe('lobby');
    expect(h.connection.join).not.toHaveBeenCalled();
  });

  it('ignores a join acknowledgement and disconnect callbacks from the exited session', async () => {
    const page = pageLifecycle();
    const onEnded = vi.fn();
    const h = open({ onEnded });
    h.media.ready = true;
    let resolveJoin!: (ack: JoinAck) => void;
    h.connection.join.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveJoin = resolve;
        }),
    );
    const joining = h.session.join();
    page('pagehide');
    page('pageshow');
    resolveJoin({ ok: true, participantId: 'self', iceServers: [] });
    await joining;
    h.callbacks()?.onDisconnect();
    h.callbacks()?.onEnded();
    expect(h.session.phase).toBe('lobby');
    expect(h.session.role).toBeNull();
    expect(h.media.stopped).toBe(1);
    expect(h.connection.close).toHaveBeenCalledOnce();
    expect(onEnded).not.toHaveBeenCalled();
    h.session.dispose();
    expect(h.media.stopped).toBe(1);
    page('pageshow');
    expect(h.connection.join).toHaveBeenCalledOnce();
  });

  it('stops screen capture and demo peers on exit without waiting for server acknowledgement', async () => {
    const page = pageLifecycle();
    const demo = { start: vi.fn(async () => {}), stop: vi.fn() };
    const h = open({ createDemo: () => demo });
    await joinStage(h.session, h.media, h.connection);
    const screen = { stop: vi.fn(), onended: null } as unknown as MediaStreamTrack;
    h.media.screen = screen;
    vi.spyOn(h.media, 'startScreenShare').mockResolvedValue(screen);
    await h.session.startSharing();
    await h.session.spawnDemo();
    expect(h.session.sharing).toBe(true);
    expect(h.session.demoCount).toBe(1);
    h.connection.leave.mockImplementation(() => new Promise(() => {}));
    page('pagehide');
    expect(screen.stop).toHaveBeenCalledOnce();
    expect(demo.stop).toHaveBeenCalledOnce();
    expect(h.session.sharing).toBe(false);
    expect(h.session.demoCount).toBe(0);
    expect(h.connection.close).toHaveBeenCalledOnce();
    expect(h.connection.leave).not.toHaveBeenCalled();
    h.session.dispose();
    expect(screen.stop).toHaveBeenCalledOnce();
    expect(demo.stop).toHaveBeenCalledOnce();
  });

  it('applies the stage snapshot before a description that follows it', async () => {
    const order: string[] = [];
    const { session, media, peers, connection, callbacks } = open();
    media.ready = true;
    const description: RelayedDescription = {
      fromParticipantId: 'other',
      toParticipantId: 'self',
      description: { type: 'offer', sdp: 'v=0' },
    };
    connection.join.mockImplementation(async () => {
      useRoomStore.getState().receive({
        ...snapshot('self', 'HOST', true, 1),
        participants: [person('self', 'HOST'), person('other', 'SPEAKER')],
        stageParticipantIds: ['self', 'other'],
      });
      useRoomStore.getState().joined('self', []);
      order.push('after-store');
      callbacks()?.onDescription(description);
      order.push('after-description');
      return { ok: true, participantId: 'self', iceServers: [] };
    });
    peers.sync.mockImplementation(() => order.push('sync'));
    peers.description.mockImplementation(() => order.push('description'));

    await session.join();

    expect(order).toEqual(['sync', 'after-store', 'description', 'after-description', 'sync']);
    expect(session.phase).toBe('joined');
    expect(media.lobbyReleased).toBe(1);
    expect(media.stopped).toBe(0);
  });

  it('keeps prepare and join as separate operation states', async () => {
    const { session, media, connection } = open();
    let finishPrepare: (value: boolean) => void = () => undefined;
    media.prepareImpl = () =>
      new Promise((resolve) => {
        finishPrepare = (value) => {
          media.ready = value;
          resolve(value);
        };
      });
    const preparing = session.prepare({} as HTMLVideoElement, {
      cameraId: '',
      microphoneId: '',
    });
    expect(session.preparing).toBe(true);
    expect(session.phase).toBe('lobby');
    await session.join();
    expect(session.phase).toBe('lobby');

    finishPrepare(true);
    await preparing;
    expect(session.preparing).toBe(false);
    expect(session.ready).toBe(true);
    expect(session.phase).toBe('lobby');

    let finishJoin: (ack: JoinAck) => void = () => undefined;
    connection.join.mockImplementation(
      () =>
        new Promise((resolve) => {
          finishJoin = resolve;
        }),
    );
    const joining = session.join();
    expect(session.phase).toBe('joining');
    expect(session.preparing).toBe(false);
    finishJoin({ ok: true, participantId: 'self', iceServers: [] });
    await joining;
    expect(session.phase).toBe('joined');
  });

  it.each(['startBroadcast', 'stopBroadcast'] as const)(
    'shows the %s rejection without inventing broadcast or roster state',
    async (action) => {
      const h = open({ room: webinar, userId: 'host-user' });
      await joinStage(h.session, h.media, h.connection);
      const original = useRoomStore.getState().snapshot;
      h.connection[action].mockResolvedValue({
        ok: false,
        error: 'broadcast_not_available',
        message: 'Broadcast is not available yet.',
      });
      await h.session[action]();
      expect(h.connection[action]).toHaveBeenCalledExactlyOnceWith();
      expect(h.session.error).toBe('Broadcast is not available yet.');
      expect(useRoomStore.getState().snapshot).toBe(original);
      expect(useRoomStore.getState().snapshot?.broadcast).toBeNull();
      expect(h.connection.media).not.toHaveBeenCalled();
    },
  );

  it('stops the stage recorder when the host leaves a live broadcast', async () => {
    const recorder = recorderFake();
    let seen: { broadcastId: string; token: string } | null = null;
    const h = open({
      room: webinar,
      userId: 'host-user',
      createRecorder: (recorderOptions) => {
        seen = recorderOptions;
        return recorder;
      },
    });
    await joinWebinarHost(h);
    h.connection.startBroadcast.mockResolvedValueOnce({ ok: true });
    await h.session.startBroadcast();
    expect(recorder.start).not.toHaveBeenCalled();
    const element = { readyState: 2 } as HTMLVideoElement;
    h.session.setStageVideo('self', element);
    useRoomStore.getState().receive({
      ...snapshot('self', 'HOST', true, 2),
      mode: 'WEBINAR',
      broadcast: {
        id: 'broadcast-1',
        status: 'LIVE',
        playlistUrl: '/api/broadcasts/broadcast-1/hls/index.m3u8',
        errorMessage: null,
      },
    });
    expect(recorder.start).toHaveBeenCalledOnce();
    expect(seen).toEqual({
      broadcastId: 'broadcast-1',
      token: 'token',
      onCap: expect.any(Function),
    });
    expect(recorder.update).toHaveBeenCalledWith([
      expect.objectContaining({ id: 'self', video: element, muted: false, screenSharing: false }),
    ]);
    useRoomStore.getState().receive({
      ...snapshot('self', 'HOST', true, 3),
      mode: 'WEBINAR',
      broadcast: {
        id: 'broadcast-1',
        status: 'LIVE',
        playlistUrl: '/api/broadcasts/broadcast-1/hls/index.m3u8',
        errorMessage: null,
      },
      participants: [{ ...person('self', 'HOST'), isAudioMuted: true }],
    });
    expect(recorder.update).toHaveBeenLastCalledWith([
      expect.objectContaining({ id: 'self', video: element, muted: true, audioTrack: null }),
    ]);
    await h.session.leave();
    expect(recorder.stop).toHaveBeenCalledOnce();
    expect(recorder.finish).not.toHaveBeenCalled();
    expect(h.media.stopped).toBe(1);
    expect(h.peers.close).toHaveBeenCalled();
    expect(h.connection.close).toHaveBeenCalled();
    expect(h.session.phase).toBe('lobby');
  });

  it('calls broadcast stop when the recorder overflows', async () => {
    const recorder = recorderFake();
    const caps: Array<() => void> = [];
    const h = open({
      room: webinar,
      userId: 'host-user',
      createRecorder: (recorderOptions) => {
        caps.push(recorderOptions.onCap);
        return recorder;
      },
    });
    await joinWebinarHost(h);
    h.connection.startBroadcast.mockImplementation(async () => {
      useRoomStore.getState().receive({
        ...snapshot('self', 'HOST', true, 2),
        mode: 'WEBINAR',
        broadcast: {
          id: 'broadcast-1',
          status: 'LIVE',
          playlistUrl: null,
          errorMessage: null,
        },
      });
      return { ok: true };
    });
    await h.session.startBroadcast();
    expect(recorder.start).toHaveBeenCalledOnce();
    caps[0]?.();
    expect(recorder.stop).toHaveBeenCalledOnce();
    expect(h.connection.stopBroadcast).toHaveBeenCalledOnce();
    expect(h.media.stopped).toBe(0);
    expect(h.peers.close).not.toHaveBeenCalled();
  });

  it.each([false, true])(
    'tears down the whole room on pagehide (persisted: %s) and requires explicit rejoin',
    async (persisted) => {
      const listeners = new Map<string, EventListener>();
      vi.stubGlobal('window', {
        addEventListener: (type: string, listener: EventListener) => listeners.set(type, listener),
        removeEventListener: (type: string) => listeners.delete(type),
      });
      try {
        const recorder = recorderFake();
        const h = open({
          room: webinar,
          userId: 'host-user',
          createRecorder: () => recorder,
        });
        await joinWebinarHost(h);
        useRoomStore.getState().receive({
          ...snapshot('self', 'HOST', true, 2),
          mode: 'WEBINAR',
          broadcast: {
            id: 'broadcast-1',
            status: 'LIVE',
            playlistUrl: null,
            errorMessage: null,
          },
        });
        h.connection.startBroadcast.mockResolvedValue({ ok: true });
        await h.session.startBroadcast();
        expect(recorder.start).toHaveBeenCalledOnce();
        const hide = Object.assign(new Event('pagehide'), { persisted });
        listeners.get('pageshow')?.(Object.assign(new Event('pageshow'), { persisted: false }));
        expect(h.session.phase).toBe('joined');
        listeners.get('pagehide')?.(hide);
        listeners.get('pagehide')?.(hide);
        expect(recorder.stop).toHaveBeenCalledOnce();
        expect(recorder.finish).not.toHaveBeenCalled();
        expect(h.media.stopped).toBe(1);
        expect(h.peers.close).toHaveBeenCalledOnce();
        expect(h.speaker.close).toHaveBeenCalledOnce();
        expect(h.connection.close).toHaveBeenCalledOnce();
        expect(h.connection.leave).not.toHaveBeenCalled();
        expect(h.connection.stopBroadcast).not.toHaveBeenCalled();
        expect(h.session.phase).toBe('lobby');
        expect(h.session.ready).toBe(false);
        expect(h.session.role).toBeNull();
        const updates = recorder.update.mock.calls.length;
        useRoomStore.getState().receive({ ...snapshot('self', 'HOST', true, 3), mode: 'WEBINAR' });
        expect(recorder.update).toHaveBeenCalledTimes(updates);
        expect(h.session.role).toBeNull();
        await h.session.prepare({} as HTMLVideoElement);
        await h.session.join();
        expect(h.media.prepareCalls).toBe(0);
        expect(h.connection.join).toHaveBeenCalledOnce();
        listeners.get('pageshow')?.(Object.assign(new Event('pageshow'), { persisted }));
        expect(h.session.error).toBe(
          'You left the live room when this page was hidden. Join again.',
        );
        expect(h.connection.join).toHaveBeenCalledOnce();
        expect(recorder.start).toHaveBeenCalledOnce();
        expect(h.media.prepareCalls).toBe(0);
        await h.session.prepare({} as HTMLVideoElement);
        await h.session.join();
        expect(h.session.phase).toBe('joined');
        expect(h.connection.join).toHaveBeenCalledTimes(2);
        expect(recorder.start).toHaveBeenCalledOnce();
        h.session.dispose();
        expect(listeners.size).toBe(0);
      } finally {
        vi.unstubAllGlobals();
      }
    },
  );

  it('asks the server to stop only after the final chunks are accepted', async () => {
    const events: string[] = [];
    let resolveFinish: (result: RecorderFinish) => void = () => undefined;
    const recorder = recorderFake();
    recorder.finish.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFinish = (result) => {
            events.push('chunks-accepted');
            resolve(result);
          };
        }),
    );
    const h = open({
      room: webinar,
      userId: 'host-user',
      createRecorder: () => recorder,
    });
    await startLiveBroadcast(h);
    h.connection.stopBroadcast.mockImplementation(async () => {
      events.push('server-stop');
      return { ok: true };
    });
    const stopping = h.session.stopBroadcast();
    expect(h.session.mediaPending).toBe(true);
    expect(recorder.finish).toHaveBeenCalledOnce();
    expect(recorder.stop).not.toHaveBeenCalled();
    expect(h.connection.stopBroadcast).not.toHaveBeenCalled();
    resolveFinish({ ok: true });
    await stopping;
    expect(events).toEqual(['chunks-accepted', 'server-stop']);
    expect(h.session.mediaPending).toBe(false);
    expect(h.session.error).toBe('');
  });

  it('shows a failure when the recording drain times out and still stops the server', async () => {
    let resolveFinish: (result: RecorderFinish) => void = () => undefined;
    const recorder = recorderFake();
    recorder.finish.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFinish = resolve;
        }),
    );
    const h = open({
      room: webinar,
      userId: 'host-user',
      createRecorder: () => recorder,
    });
    await startLiveBroadcast(h);
    const stopping = h.session.stopBroadcast();
    expect(h.session.mediaPending).toBe(true);
    expect(h.connection.stopBroadcast).not.toHaveBeenCalled();
    resolveFinish({ ok: false, reason: 'timeout' });
    await stopping;
    expect(h.connection.stopBroadcast).toHaveBeenCalledOnce();
    expect(h.session.error).toBe(
      'The broadcast stopped before the last of the recording uploaded.',
    );
    expect(h.session.mediaPending).toBe(false);
    expect(h.media.stopped).toBe(0);
    expect(h.peers.close).not.toHaveBeenCalled();
  });

  it('leaves without waiting for a finish that is still uploading', async () => {
    let resolveFinish: (result: RecorderFinish) => void = () => undefined;
    const recorder = recorderFake();
    recorder.finish.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFinish = resolve;
        }),
    );
    recorder.stop.mockImplementation(() => {
      resolveFinish({ ok: false, reason: 'aborted' });
    });
    const h = open({
      room: webinar,
      userId: 'host-user',
      createRecorder: () => recorder,
    });
    await startLiveBroadcast(h);
    const stopping = h.session.stopBroadcast();
    expect(h.connection.stopBroadcast).not.toHaveBeenCalled();
    await h.session.leave();
    await stopping;
    expect(recorder.stop).toHaveBeenCalled();
    expect(h.media.stopped).toBe(1);
    expect(h.peers.close).toHaveBeenCalled();
    expect(h.session.phase).toBe('lobby');
    expect(h.connection.stopBroadcast).not.toHaveBeenCalled();
  });

  it('aborts an ongoing normal finish on page exit without sending unload commands', async () => {
    const page = pageLifecycle();
    let resolveFinish!: (result: RecorderFinish) => void;
    const recorder = recorderFake();
    recorder.finish.mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveFinish = resolve;
        }),
    );
    recorder.stop.mockImplementation(() => resolveFinish({ ok: false, reason: 'aborted' }));
    const h = open({ room: webinar, userId: 'host-user', createRecorder: () => recorder });
    await startLiveBroadcast(h);
    const stopping = h.session.stopBroadcast();
    page('pagehide');
    expect(h.media.stopped).toBe(1);
    expect(h.connection.close).toHaveBeenCalledOnce();
    await stopping;
    expect(recorder.stop).toHaveBeenCalledOnce();
    expect(h.connection.stopBroadcast).not.toHaveBeenCalled();
    expect(h.connection.leave).not.toHaveBeenCalled();
    expect(h.session.phase).toBe('lobby');
    expect(h.session.mediaPending).toBe(false);
  });

  it('does not send broadcast commands from a meeting host or a webinar attendee', async () => {
    const meeting = open();
    await joinStage(meeting.session, meeting.media, meeting.connection);
    await meeting.session.startBroadcast();
    await meeting.session.stopBroadcast();
    expect(meeting.connection.startBroadcast).not.toHaveBeenCalled();
    expect(meeting.connection.stopBroadcast).not.toHaveBeenCalled();
    const guest = open({ room: webinar, userId: 'guest' });
    guest.connection.join.mockImplementation(async () => {
      useRoomStore.getState().joined('self', []);
      useRoomStore
        .getState()
        .receive({ ...snapshot('self', 'ATTENDEE', false, 1), mode: 'WEBINAR' });
      return { ok: true, participantId: 'self', iceServers: [] };
    });
    await guest.session.join();
    await guest.session.startBroadcast();
    await guest.session.stopBroadcast();
    expect(guest.connection.startBroadcast).not.toHaveBeenCalled();
    expect(guest.connection.stopBroadcast).not.toHaveBeenCalled();
  });

  it('surfaces failed promote and waits for a higher snapshot revision after successful moderation', async () => {
    const { session, media, connection } = open({ room: webinar, userId: 'host-user' });
    media.ready = true;
    const original: RoomSnapshot = {
      ...snapshot('self', 'HOST', true, 1),
      mode: 'WEBINAR',
      participants: [person('self', 'HOST'), person('guest', 'ATTENDEE')],
      handParticipantIds: ['guest'],
    };
    connection.join.mockImplementation(async () => {
      useRoomStore.getState().joined('self', []);
      useRoomStore.getState().receive(original);
      return { ok: true, participantId: 'self', iceServers: [] };
    });
    await session.join();
    connection.promote.mockResolvedValueOnce({
      ok: false,
      error: 'stage_full',
      message: 'This meeting already has 4 people on stage.',
    });
    await session.promote('guest');
    expect(connection.promote).toHaveBeenCalledExactlyOnceWith('guest');
    expect(session.error).toBe('This meeting already has 4 people on stage.');
    expect(useRoomStore.getState().snapshot).toBe(original);
    expect(session.mediaPending).toBe(false);
    await session.promote('guest');
    expect(session.error).toBe('');
    expect(useRoomStore.getState().snapshot).toBe(original);
    const promoted = {
      ...original,
      participants: [person('self', 'HOST'), person('guest', 'SPEAKER')],
      stageParticipantIds: ['self', 'guest'],
      handParticipantIds: [],
    };
    useRoomStore.getState().receive(promoted);
    expect(useRoomStore.getState().snapshot).toBe(original);
    useRoomStore.getState().receive({ ...promoted, revision: 2 });
    expect(useRoomStore.getState().snapshot?.participants[1]?.role).toBe('SPEAKER');
    const current = useRoomStore.getState().snapshot;
    await session.setLock('guest', 'video', true);
    await session.demote('guest');
    expect(connection.setLock).toHaveBeenCalledExactlyOnceWith({
      targetParticipantId: 'guest',
      kind: 'video',
      locked: true,
    });
    expect(connection.demote).toHaveBeenCalledExactlyOnceWith('guest');
    expect(useRoomStore.getState().snapshot).toBe(current);
  });

  it('does not send moderation commands before join or as an attendee', async () => {
    const { session, connection } = open({ room: webinar, userId: 'guest' });
    await session.promote('other');
    await session.demote('other');
    await session.setLock('other', 'audio', true);
    connection.join.mockImplementation(async () => {
      useRoomStore.getState().joined('self', []);
      useRoomStore.getState().receive(snapshot('self', 'ATTENDEE', false, 1));
      return { ok: true, participantId: 'self', iceServers: [] };
    });
    await session.join();
    await session.promote('other');
    await session.demote('other');
    await session.setLock('other', 'audio', true);
    expect(connection.promote).not.toHaveBeenCalled();
    expect(connection.demote).not.toHaveBeenCalled();
    expect(connection.setLock).not.toHaveBeenCalled();
  });

  it('does not capture media when an attendee is promoted', async () => {
    const { session, media, connection } = open({ room: webinar, userId: 'guest' });
    connection.join.mockImplementation(async () => {
      useRoomStore.getState().joined('self', []);
      useRoomStore.getState().receive(snapshot('self', 'ATTENDEE', false, 1));
      return { ok: true, participantId: 'self', iceServers: [] };
    });

    await session.join();
    expect(session.role).toBe('ATTENDEE');
    expect(session.needsCaptureConsent).toBe(false);
    expect(media.prepareCalls).toBe(0);

    useRoomStore.getState().receive(snapshot('self', 'SPEAKER', true, 2));
    expect(session.role).toBe('SPEAKER');
    expect(session.audience).toBe('stage');
    expect(session.needsCaptureConsent).toBe(true);
    expect(media.prepareCalls).toBe(0);
    expect(media.stopped).toBe(0);
    expect(connection.close).not.toHaveBeenCalled();
    expect(session.phase).toBe('joined');
  });

  it('releases capture on demotion without closing the room connection', async () => {
    const { session, media, peers, connection } = open();
    media.ready = true;
    connection.join.mockImplementation(async () => {
      useRoomStore.getState().joined('self', []);
      useRoomStore.getState().receive(snapshot('self', 'HOST', true, 1));
      return { ok: true, participantId: 'self', iceServers: [] };
    });

    await session.join();
    expect(peers.sync).toHaveBeenCalled();
    useRoomStore.getState().receive(snapshot('self', 'ATTENDEE', false, 2));

    expect(session.role).toBe('ATTENDEE');
    expect(session.audience).toBe('attendee');
    expect(media.stopped).toBe(1);
    expect(peers.close).toHaveBeenCalled();
    expect(connection.close).not.toHaveBeenCalled();
    expect(session.phase).toBe('joined');
    expect(session.needsCaptureConsent).toBe(false);
  });

  async function promotedAttendee(locked = false) {
    const h = open({ room: webinar, userId: 'guest' });
    const offStage = {
      ...snapshot('self', 'ATTENDEE', false, 1),
      mode: 'WEBINAR' as const,
      participants: [
        {
          ...person('self', 'ATTENDEE'),
          isAudioMuted: true,
          isVideoOff: true,
          hostAudioLocked: locked,
        },
      ],
    };
    h.connection.join.mockImplementation(async () => {
      useRoomStore.getState().joined('self', []);
      useRoomStore.getState().receive(offStage);
      return { ok: true, participantId: 'self', iceServers: [] };
    });
    await h.session.join();
    const promoted: RoomSnapshot = {
      ...offStage,
      revision: 2,
      stageParticipantIds: ['self', 'host'],
      participants: [{ ...offStage.participants[0]!, role: 'SPEAKER' }, person('host', 'HOST')],
    };
    useRoomStore.getState().receive(promoted);
    expect(h.media.prepareCalls).toBe(0);
    expect(h.peers.sync).not.toHaveBeenCalled();
    expect(h.connection.media).not.toHaveBeenCalled();
    return { ...h, promoted };
  }

  it('opens peers only after consent and sends one on-stage patch with green-room intentions', async () => {
    const h = await promotedAttendee();
    h.connection.media.mockImplementation(async (patch) => {
      expect(useRoomStore.getState().snapshot?.stageParticipantIds).toContain('self');
      expect(h.peers.sync).toHaveBeenCalledWith('self', ['self', 'host'], []);
      expect(h.media.applyFlags).toHaveBeenLastCalledWith(true, true);
      useRoomStore.getState().receive({
        ...h.promoted,
        revision: 3,
        participants: [{ ...h.promoted.participants[0]!, ...patch }, person('host', 'HOST')],
      });
      expect(h.media.applyFlags).toHaveBeenLastCalledWith(true, true);
      return { ok: true };
    });
    await h.session.prepare({} as HTMLVideoElement);
    expect(h.media.prepareCalls).toBe(1);
    expect(h.connection.media).toHaveBeenCalledExactlyOnceWith({
      isAudioMuted: false,
      isVideoOff: false,
    });
    expect(h.media.applyFlags).toHaveBeenLastCalledWith(false, false);
    expect(h.session.needsCaptureConsent).toBe(false);
  });

  it('keeps tracks disabled and surfaces the server sentence when the activation patch fails', async () => {
    const h = await promotedAttendee();
    h.connection.media.mockResolvedValue({
      ok: false,
      error: 'audio_locked',
      message: 'The host has muted your microphone.',
    });
    await h.session.prepare({} as HTMLVideoElement);
    expect(h.session.error).toBe('The host has muted your microphone.');
    expect(h.media.applyFlags).toHaveBeenLastCalledWith(true, true);
    expect(h.session.phase).toBe('joined');
  });

  it('keeps a permission-denied speaker joined without connections or an activation patch', async () => {
    const h = await promotedAttendee();
    h.media.prepareImpl = async () => {
      throw new Error('Unable to use your microphone. Allow microphone permission.');
    };
    await h.session.prepare({} as HTMLVideoElement);
    expect(h.session.error).toContain('microphone permission');
    expect(h.session.needsCaptureConsent).toBe(true);
    expect(h.session.phase).toBe('joined');
    expect(h.session.role).toBe('SPEAKER');
    expect(h.peers.sync).not.toHaveBeenCalled();
    expect(h.connection.media).not.toHaveBeenCalled();
    expect(h.connection.close).not.toHaveBeenCalled();
  });

  it('retains only current-stage signaling during consent and discards it on demotion', async () => {
    const h = await promotedAttendee();
    const description: RelayedDescription = {
      toParticipantId: 'self',
      fromParticipantId: 'host',
      description: { type: 'offer', sdp: 'on-stage' },
    };
    h.callbacks()?.onDescription(description);
    expect(h.peers.description).not.toHaveBeenCalled();
    await h.session.prepare({} as HTMLVideoElement);
    expect(h.peers.description).toHaveBeenCalledExactlyOnceWith(description);
    useRoomStore.getState().receive(snapshot('self', 'ATTENDEE', false, 3));
    h.peers.description.mockClear();
    h.callbacks()?.onDescription({
      ...description,
      description: { type: 'offer', sdp: 'off-stage' },
    });
    useRoomStore.getState().receive({ ...h.promoted, revision: 4 });
    h.callbacks()?.onDescription(description);
    useRoomStore.getState().receive(snapshot('self', 'ATTENDEE', false, 5));
    useRoomStore.getState().receive({ ...h.promoted, revision: 6 });
    await h.session.prepare({} as HTMLVideoElement);
    expect(h.peers.description).not.toHaveBeenCalled();
  });

  it('bounds signaling retained while consent is pending', async () => {
    const h = await promotedAttendee();
    for (let i = 0; i < 33; i++)
      h.callbacks()?.onDescription({
        toParticipantId: 'self',
        fromParticipantId: 'host',
        description: { type: 'offer', sdp: 'pending' },
      });
    expect(h.session.error).toContain('Stage signaling overflowed');
    await h.session.prepare({} as HTMLVideoElement);
    expect(h.peers.description).not.toHaveBeenCalled();
  });

  it('never sends an enabling microphone patch while the host lock is on', async () => {
    const h = await promotedAttendee(true);
    await h.session.prepare({} as HTMLVideoElement);
    expect(h.connection.media).toHaveBeenCalledExactlyOnceWith({
      isAudioMuted: true,
      isVideoOff: false,
    });
    h.session.toggleAudio();
    expect(h.connection.media).toHaveBeenCalledTimes(1);
    expect(h.media.applyFlags).toHaveBeenLastCalledWith(true, true);
    expect(h.session.audioLocked).toBe(true);
  });

  it('applies force-mute immediately and lets only a newer snapshot clear its effect', async () => {
    const h = open();
    await joinStage(h.session, h.media, h.connection);
    h.callbacks()?.onForceMute?.({ kind: 'audio', locked: true });
    expect(h.media.applyFlags).toHaveBeenLastCalledWith(true, false);
    h.session.toggleAudio();
    expect(h.connection.media).not.toHaveBeenCalled();
    h.callbacks()?.onForceMute?.({ kind: 'audio', locked: false });
    expect(h.media.applyFlags).toHaveBeenLastCalledWith(true, false);
    const locked = {
      ...snapshot('self', 'HOST', true, 2),
      participants: [{ ...person('self', 'HOST'), hostAudioLocked: true, isAudioMuted: true }],
    };
    useRoomStore.getState().receive(locked);
    expect(h.session.audioLocked).toBe(true);
    useRoomStore.getState().receive({
      ...locked,
      revision: 3,
      participants: [{ ...locked.participants[0]!, hostAudioLocked: false }],
    });
    expect(h.session.audioLocked).toBe(false);
    expect(h.media.applyFlags).toHaveBeenLastCalledWith(true, false);
    h.session.toggleAudio();
    expect(h.connection.media).toHaveBeenCalledExactlyOnceWith({ isAudioMuted: false });
  });

  it('discards permission resolving after demotion and keeps the same joined socket', async () => {
    const h = await promotedAttendee();
    let finish!: (value: boolean) => void;
    h.media.prepareImpl = () =>
      new Promise((resolve) => {
        finish = resolve;
      });
    const pending = h.session.prepare({} as HTMLVideoElement);
    useRoomStore.getState().receive(snapshot('self', 'ATTENDEE', false, 3));
    finish(true);
    await pending;
    expect(h.connection.media).not.toHaveBeenCalled();
    expect(h.peers.sync).not.toHaveBeenCalled();
    expect(h.media.ready).toBe(false);
    expect(h.session.preparing).toBe(false);
    expect(h.session.phase).toBe('joined');
    expect(h.connection.close).not.toHaveBeenCalled();
  });

  async function startLiveBroadcast(h: ReturnType<typeof harness>) {
    await joinWebinarHost(h);
    h.connection.startBroadcast.mockImplementation(async () => {
      useRoomStore.getState().receive({
        ...snapshot('self', 'HOST', true, 2),
        mode: 'WEBINAR',
        broadcast: {
          id: 'broadcast-1',
          status: 'LIVE',
          playlistUrl: null,
          errorMessage: null,
        },
      });
      return { ok: true };
    });
    await h.session.startBroadcast();
  }

  async function joinWebinarHost(h: ReturnType<typeof harness>) {
    h.media.ready = true;
    h.connection.join.mockImplementation(async () => {
      useRoomStore.getState().joined('self', []);
      useRoomStore.getState().receive({ ...snapshot('self', 'HOST', true, 1), mode: 'WEBINAR' });
      return { ok: true, participantId: 'self', iceServers: [] };
    });
    await h.session.join();
  }

  async function joinStage(
    session: RoomSession,
    media: FakeMedia,
    connection: ReturnType<typeof fakeConnection>,
  ) {
    media.ready = true;
    connection.join.mockImplementation(async () => {
      useRoomStore.getState().joined('self', []);
      useRoomStore.getState().receive(snapshot('self', 'HOST', true, 1));
      return { ok: true, participantId: 'self', iceServers: [] };
    });
    await session.join();
  }

  async function joinRecoverable(h: ReturnType<typeof harness>, role: ParticipantRole = 'HOST') {
    h.media.ready = role !== 'ATTENDEE';
    h.connection.join.mockImplementation(async () => {
      useRoomStore.getState().joined('self', []);
      useRoomStore.getState().receive(snapshot('self', role, role !== 'ATTENDEE', 1));
      return {
        ok: true,
        participantId: 'self',
        iceServers: [],
        resumeCredential: 'page-credential',
      };
    });
    await h.session.join();
  }

  it('recovers with media off, fresh peers and no capture until the existing device control is used', async () => {
    vi.useFakeTimers();
    const devices = stubDeviceList();
    const h = open({ freshConnections: true });
    await joinRecoverable(h);
    const original = h.opened[0]!;
    original.callbacks.onDisconnect();
    expect(h.session.phase).toBe('recovering');
    expect(h.media.stopped).toBe(1);
    expect(h.peers.close).toHaveBeenCalledOnce();
    expect(h.speaker.close).toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.session.phase).toBe('joined');
    const resumed = h.opened[1]!.connection;
    expect(resumed.resume).toHaveBeenCalledExactlyOnceWith({
      roomId: room.id,
      participantId: 'self',
      resumeCredential: 'page-credential',
    });
    expect(resumed.join).not.toHaveBeenCalled();
    expect(resumed.startBroadcast).not.toHaveBeenCalled();
    expect(h.media.prepareCalls).toBe(0);
    expect(h.media.replaceInput).not.toHaveBeenCalled();
    expect(devices.getUserMedia).not.toHaveBeenCalled();
    expect(h.session.needsCaptureConsent).toBe(false);
    expect(h.peers.sync).toHaveBeenLastCalledWith('self', ['self'], []);
    expect(h.media.applyFlags).toHaveBeenLastCalledWith(true, true);
    original.callbacks.onForceMute?.({ kind: 'audio', locked: true });
    original.callbacks.onEnded();
    original.callbacks.onDescription({
      toParticipantId: 'self',
      fromParticipantId: 'old',
      description: { type: 'offer', sdp: 'old' },
    });
    expect(h.session.audioLocked).toBe(false);
    expect(h.session.phase).toBe('joined');
    h.session.toggleAudio();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.media.replaceInput).toHaveBeenCalledExactlyOnceWith('microphone', '');
    expect(resumed.media).toHaveBeenCalledExactlyOnceWith({ isAudioMuted: false });
    expect(h.media.prepareCalls).toBe(0);
    expect(devices.getUserMedia).not.toHaveBeenCalled();
  });

  it('retries on the absolute 0, 1, 2 and 4 second schedule and stops at twenty seconds', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const starts: number[] = [];
    const h = open({
      freshConnections: true,
      resume: () => {
        starts.push(Date.now());
        return new Promise(() => {});
      },
    });
    await joinRecoverable(h);
    h.callbacks()!.onDisconnect();
    expect(starts).toEqual([0]);
    await vi.advanceTimersByTimeAsync(4000);
    expect(starts).toEqual([0, 1000, 2000, 4000]);
    for (const attempt of h.opened.slice(1, -1))
      expect(attempt.connection.close).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(16000);
    expect(h.session.phase).toBe('lobby');
    expect(h.session.error).toBe('The connection was gone too long. Join again.');
    await vi.advanceTimersByTimeAsync(30000);
    expect(starts).toHaveLength(4);
    for (const attempt of h.opened.slice(1)) expect(attempt.connection.join).not.toHaveBeenCalled();
  });

  it('does not start a delayed retry once the twenty-second budget has elapsed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const h = open({ freshConnections: true, resume: () => new Promise(() => {}) });
    await joinRecoverable(h);
    h.callbacks()!.onDisconnect();
    vi.setSystemTime(21000);
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.opens).toHaveBeenCalledTimes(2);
    expect(h.session.phase).toBe('lobby');
  });

  it('leaves a late successful binding when the grace timer itself has been delayed', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let resolve!: (result: ResumeAck) => void;
    const h = open({
      freshConnections: true,
      resume: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    await joinRecoverable(h);
    h.callbacks()!.onDisconnect();
    vi.setSystemTime(21000);
    resolve({
      ok: true,
      participantId: 'self',
      connectionGeneration: 2,
      iceServers: [],
      snapshot: recoveredSnapshot(),
    });
    for (let index = 0; index < 10; index++) await Promise.resolve();
    expect(h.session.phase).toBe('lobby');
    expect(h.session.error).toBe('The connection was gone too long. Join again.');
    expect(h.opened[1]!.connection.leave).toHaveBeenCalledOnce();
    expect(h.media.prepareCalls).toBe(0);
  });

  it.each([
    ['participant_not_found', 'The live room reset. Join again.'],
    ['invalid_resume', 'The connection was gone too long. Join again.'],
    ['resume_expired', 'The connection was gone too long. Join again.'],
    ['room_ended', 'This room has ended.'],
    ['stale_transport', 'The connection was gone too long. Join again.'],
  ] as const)('stops the budget on %s and drops the resume credential', async (error, message) => {
    vi.useFakeTimers();
    const h = open({
      freshConnections: true,
      resume: async () => ({ ok: false, error, message: 'server sentence' }),
    });
    await joinRecoverable(h);
    h.callbacks()!.onDisconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.session.phase).toBe('lobby');
    expect(h.session.error).toBe(message);
    expect(h.session.role).toBeNull();
    await vi.advanceTimersByTimeAsync(30000);
    expect(h.opens).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['server_busy', 'The live server is busy. Try again shortly.'],
    ['server_error', 'Unable to update the live room. Join again.'],
    ['rate_limited', 'Too many room commands. Try again shortly.'],
    ['already_connected', 'This participant is already connected.'],
  ] as const)(
    'retries %s on the selected schedule and resumes the same membership',
    async (error, message) => {
      vi.useFakeTimers();
      vi.setSystemTime(0);
      const devices = stubDeviceList();
      let calls = 0;
      const h = open({
        freshConnections: true,
        resume: async () => {
          calls += 1;
          if (calls === 1) return { ok: false, error, message: 'server sentence' };
          return {
            ok: true,
            participantId: 'self',
            connectionGeneration: 2,
            iceServers: [],
            snapshot: recoveredSnapshot(),
          };
        },
      });
      await joinRecoverable(h);
      const original = h.opened[0]!.connection;
      h.callbacks()!.onDisconnect();
      await vi.advanceTimersByTimeAsync(0);
      expect(h.session.phase).toBe('recovering');
      expect(h.session.error).toBe(message);
      const failed = h.opened[1]!.connection;
      expect(failed.close).toHaveBeenCalled();
      expect(failed.leave).not.toHaveBeenCalled();
      expect(failed.join).not.toHaveBeenCalled();
      expect(failed.media).not.toHaveBeenCalled();
      expect(original.leave).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(1000);
      expect(h.session.phase).toBe('joined');
      expect(h.session.error).toBe('');
      expect(calls).toBe(2);
      expect(h.opened[2]!.connection.resume).toHaveBeenCalledExactlyOnceWith({
        roomId: room.id,
        participantId: 'self',
        resumeCredential: 'page-credential',
      });
      expect(h.opened[2]!.connection.join).not.toHaveBeenCalled();
      expect(h.media.prepareCalls).toBe(0);
      expect(devices.getUserMedia).not.toHaveBeenCalled();
      await vi.advanceTimersByTimeAsync(30000);
      expect(calls).toBe(2);
    },
  );

  it('does not adopt a lost generation and lets the next selected attempt bind', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const devices = stubDeviceList();
    let calls = 0;
    const h = open({
      freshConnections: true,
      resume: async () => {
        calls += 1;
        if (calls === 1)
          return {
            ok: false,
            error: 'resume_lost',
            message: 'Another connection resumed this membership.',
          };
        return {
          ok: true,
          participantId: 'self',
          connectionGeneration: 3,
          iceServers: [],
          snapshot: {
            ...recoveredSnapshot(),
            participants: [{ ...recoveredSnapshot().participants[0]!, connectionGeneration: 3 }],
          },
        };
      },
    });
    await joinRecoverable(h);
    h.callbacks()!.onDisconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.session.phase).toBe('recovering');
    expect(h.session.error).toBe('Another connection resumed this membership.');
    expect(useRoomStore.getState().snapshot).toBeNull();
    expect(useRoomStore.getState().selfParticipantId).toBeNull();
    expect(h.opened[1]!.connection.leave).not.toHaveBeenCalled();
    expect(h.opened[1]!.connection.join).not.toHaveBeenCalled();
    expect(h.opened[1]!.connection.media).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.session.phase).toBe('joined');
    expect(useRoomStore.getState().snapshot?.participants[0]?.connectionGeneration).toBe(3);
    expect(h.opened[1]!.connection.leave).not.toHaveBeenCalled();
    expect(h.opened[2]!.connection.leave).not.toHaveBeenCalled();
    expect(h.media.prepareCalls).toBe(0);
    expect(devices.getUserMedia).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(30000);
    expect(calls).toBe(2);
  });

  it('keeps recovering when an older attempt loses the generation after a newer socket replaced it', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    let finishLost!: (result: ResumeAck) => void;
    let calls = 0;
    const h = open({
      freshConnections: true,
      resume: () => {
        calls += 1;
        if (calls === 1)
          return new Promise((resolve) => {
            finishLost = resolve;
          });
        if (calls === 2)
          return Promise.resolve({
            ok: false,
            error: 'already_connected',
            message: 'This participant is already connected.',
          });
        return Promise.resolve({
          ok: true,
          participantId: 'self',
          connectionGeneration: 3,
          iceServers: [],
          snapshot: recoveredSnapshot(),
        });
      },
    });
    await joinRecoverable(h);
    h.callbacks()!.onDisconnect();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.session.phase).toBe('recovering');
    expect(h.session.error).toBe('This participant is already connected.');
    finishLost({
      ok: false,
      error: 'resume_lost',
      message: 'Another connection resumed this membership.',
    });
    await vi.advanceTimersByTimeAsync(0);
    expect(h.session.phase).toBe('recovering');
    expect(h.session.error).toBe('This participant is already connected.');
    expect(h.opened[1]!.connection.leave).not.toHaveBeenCalled();
    expect(h.opened[2]!.connection.leave).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1000);
    expect(h.session.phase).toBe('joined');
    expect(calls).toBe(3);
    expect(h.opened[1]!.connection.join).not.toHaveBeenCalled();
    expect(h.opened[2]!.connection.join).not.toHaveBeenCalled();
    expect(h.opened[3]!.connection.join).not.toHaveBeenCalled();
    expect(h.media.prepareCalls).toBe(0);
    await vi.advanceTimersByTimeAsync(30000);
    expect(calls).toBe(3);
  });

  it('stops at twenty seconds when every selected attempt is transiently busy', async () => {
    vi.useFakeTimers();
    vi.setSystemTime(0);
    const h = open({
      freshConnections: true,
      resume: async () => ({
        ok: false,
        error: 'server_busy',
        message: 'The live server is busy. Try again shortly.',
      }),
    });
    await joinRecoverable(h);
    h.callbacks()!.onDisconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.session.phase).toBe('recovering');
    expect(h.session.error).toBe('The live server is busy. Try again shortly.');
    await vi.advanceTimersByTimeAsync(4000);
    expect(h.opens).toHaveBeenCalledTimes(5);
    expect(h.session.phase).toBe('recovering');
    await vi.advanceTimersByTimeAsync(16000);
    expect(h.session.phase).toBe('lobby');
    expect(h.session.error).toBe('The connection was gone too long. Join again.');
    await vi.advanceTimersByTimeAsync(30000);
    expect(h.opens).toHaveBeenCalledTimes(5);
    for (const attempt of h.opened.slice(1)) {
      expect(attempt.connection.join).not.toHaveBeenCalled();
      expect(attempt.connection.leave).not.toHaveBeenCalled();
      expect(attempt.connection.close).toHaveBeenCalled();
    }
  });

  it('cancels later attempts after a transient failure when the page hides', async () => {
    vi.useFakeTimers();
    const page = pageLifecycle();
    let calls = 0;
    const h = open({
      freshConnections: true,
      resume: async () => {
        calls += 1;
        return {
          ok: false,
          error: 'server_busy',
          message: 'The live server is busy. Try again shortly.',
        };
      },
    });
    await joinRecoverable(h);
    h.callbacks()!.onDisconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.session.phase).toBe('recovering');
    page('pagehide');
    await vi.advanceTimersByTimeAsync(30000);
    expect(calls).toBe(1);
    expect(h.session.phase).toBe('lobby');
    expect(h.media.prepareCalls).toBe(0);
    expect(h.opened[1]!.connection.join).not.toHaveBeenCalled();
  });

  it('cancels later attempts after a transient failure when the member leaves', async () => {
    vi.useFakeTimers();
    let calls = 0;
    const h = open({
      freshConnections: true,
      resume: async () => {
        calls += 1;
        return {
          ok: false,
          error: 'already_connected',
          message: 'This participant is already connected.',
        };
      },
    });
    await joinRecoverable(h);
    h.callbacks()!.onDisconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.session.phase).toBe('recovering');
    await h.session.leave();
    await vi.advanceTimersByTimeAsync(30000);
    expect(calls).toBe(1);
    expect(h.session.phase).toBe('lobby');
    expect(h.opens).toHaveBeenCalledTimes(2);
    expect(h.opened[1]!.connection.join).not.toHaveBeenCalled();
    expect(h.opened[1]!.connection.leave).not.toHaveBeenCalled();
    expect(h.media.prepareCalls).toBe(0);
  });

  it('leaves a resume binding that succeeds after leave and cancels all further attempts', async () => {
    vi.useFakeTimers();
    let resolve!: (result: ResumeAck) => void;
    const h = open({
      freshConnections: true,
      resume: () =>
        new Promise((done) => {
          resolve = done;
        }),
    });
    await joinRecoverable(h);
    h.callbacks()!.onDisconnect();
    const recovering = h.opened[1]!.connection;
    await h.session.leave();
    resolve({
      ok: true,
      participantId: 'self',
      connectionGeneration: 2,
      iceServers: [],
      snapshot: recoveredSnapshot(),
    });
    await vi.advanceTimersByTimeAsync(30000);
    expect(h.session.phase).toBe('lobby');
    expect(recovering.leave).toHaveBeenCalledOnce();
    expect(h.opens).toHaveBeenCalledTimes(2);
    expect(h.media.prepareCalls).toBe(0);
  });

  it.each(['pagehide', 'dispose'] as const)(
    'does not resume after %s during recovery',
    async (action) => {
      vi.useFakeTimers();
      const page = pageLifecycle();
      const h = open({ freshConnections: true, resume: () => new Promise(() => {}) });
      await joinRecoverable(h);
      h.callbacks()!.onDisconnect();
      if (action === 'pagehide') {
        page('pagehide');
        page('pageshow');
      } else h.session.dispose();
      await vi.advanceTimersByTimeAsync(30000);
      expect(h.opens).toHaveBeenCalledTimes(2);
      expect(h.session.phase).toBe('lobby');
      expect(h.session.role).toBeNull();
      expect(h.media.prepareCalls).toBe(0);
    },
  );

  it('resumes an attendee with no peers or capture', async () => {
    vi.useFakeTimers();
    const devices = stubDeviceList();
    const h = open({
      room: webinar,
      userId: 'attendee',
      freshConnections: true,
      resume: async () => ({
        ok: true,
        participantId: 'self',
        connectionGeneration: 2,
        iceServers: [],
        snapshot: recoveredSnapshot('ATTENDEE'),
      }),
    });
    await joinRecoverable(h, 'ATTENDEE');
    h.callbacks()!.onDisconnect();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.session.phase).toBe('joined');
    expect(h.session.role).toBe('ATTENDEE');
    expect(h.peers.sync).not.toHaveBeenCalled();
    expect(h.media.prepareCalls).toBe(0);
    expect(h.media.replaceInput).not.toHaveBeenCalled();
    expect(devices.getUserMedia).not.toHaveBeenCalled();
  });

  it('drops a suspended non-host source while preserving the active recorder', async () => {
    const recorder = recorderFake();
    const h = open({ room: webinar, userId: 'host-user', createRecorder: () => recorder });
    await joinWebinarHost(h);
    await startLiveBroadcast(h);
    const baseline = useRoomStore.getState().snapshot!;
    const remote = person('remote', 'SPEAKER');
    useRoomStore.getState().receive({
      ...baseline,
      revision: 3,
      participants: [person('self', 'HOST'), remote],
      stageParticipantIds: ['self', 'remote'],
    });
    expect(
      recorder.update.mock.calls.at(-1)?.[0].map((source: { id: string }) => source.id),
    ).toEqual(['self', 'remote']);
    useRoomStore.getState().receive({
      ...baseline,
      revision: 4,
      participants: [
        person('self', 'HOST'),
        {
          ...remote,
          socketId: null,
          presence: 'suspended',
          isAudioMuted: true,
          isVideoOff: true,
        },
      ],
      stageParticipantIds: ['self', 'remote'],
    });
    expect(
      recorder.update.mock.calls.at(-1)?.[0].map((source: { id: string }) => source.id),
    ).toEqual(['self']);
    expect(recorder.stop).not.toHaveBeenCalled();
    expect(h.connection.stopBroadcast).not.toHaveBeenCalled();
    expect(h.peers.sync).toHaveBeenLastCalledWith('self', ['self'], []);
  });

  it('stops sharing, demos and the upload producer on a host drop, and keeps them stopped after resume', async () => {
    vi.useFakeTimers();
    const recorder = recorderFake();
    const demo = { start: vi.fn(async () => {}), stop: vi.fn() };
    const h = open({
      room: webinar,
      userId: 'host-user',
      freshConnections: true,
      createRecorder: () => recorder,
      createDemo: () => demo,
    });
    await joinRecoverable(h);
    await startLiveBroadcast(h);
    const screen = { stop: vi.fn(), onended: null } as unknown as MediaStreamTrack;
    h.media.screen = screen;
    vi.spyOn(h.media, 'startScreenShare').mockResolvedValue(screen);
    await h.session.startSharing();
    await h.session.spawnDemo();
    h.callbacks()!.onDisconnect();
    expect(screen.stop).toHaveBeenCalledOnce();
    expect(demo.stop).toHaveBeenCalledOnce();
    expect(recorder.stop).toHaveBeenCalledOnce();
    expect(recorder.finish).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(0);
    expect(h.session.phase).toBe('joined');
    expect(h.session.sharing).toBe(false);
    expect(h.session.demoCount).toBe(0);
    expect(recorder.start).toHaveBeenCalledOnce();
    expect(h.opened[1]!.connection.startBroadcast).not.toHaveBeenCalled();
    expect(h.connection.stopBroadcast).not.toHaveBeenCalled();
  });

  it('keeps host locks effective after resume and discards a replacement that finishes after the drop', async () => {
    vi.useFakeTimers();
    const locked = recoveredSnapshot();
    locked.participants[0]!.hostAudioLocked = true;
    locked.participants[0]!.hostVideoLocked = true;
    const h = open({
      freshConnections: true,
      resume: async () => ({
        ok: true,
        participantId: 'self',
        connectionGeneration: 2,
        iceServers: [],
        snapshot: locked,
      }),
    });
    await joinRecoverable(h);
    let resolve!: (track: MediaStreamTrack) => void;
    h.media.replaceInput.mockImplementationOnce(
      () =>
        new Promise((done) => {
          resolve = done;
        }),
    );
    const replacing = h.session.replaceDevice('camera', 'late');
    await vi.advanceTimersByTimeAsync(0);
    h.callbacks()!.onDisconnect();
    await vi.advanceTimersByTimeAsync(0);
    const late = liveTrack('video');
    resolve(late);
    await replacing;
    expect(late.stop).toHaveBeenCalledOnce();
    expect(h.peers.replaceVideoTrack).not.toHaveBeenCalled();
    h.session.toggleAudio();
    h.session.toggleVideo();
    expect(h.opened[1]!.connection.media).not.toHaveBeenCalled();
    expect(h.media.replaceInput).toHaveBeenCalledOnce();
  });

  it('stops local work once when leaving', async () => {
    const { session, media, peers, speaker, connection } = open();
    await joinStage(session, media, connection);
    await session.leave();
    expect(media.stopped).toBe(1);
    expect(peers.close).toHaveBeenCalledTimes(1);
    expect(speaker.close).toHaveBeenCalled();
    expect(connection.close).toHaveBeenCalledTimes(1);
    expect(session.phase).toBe('lobby');
  });

  it('resets after disconnect without closing the socket a second time', async () => {
    const { session, media, peers, connection, callbacks } = open();
    await joinStage(session, media, connection);
    callbacks()?.onDisconnect();
    expect(media.stopped).toBe(1);
    expect(peers.close).toHaveBeenCalledTimes(1);
    expect(session.phase).toBe('lobby');
    expect(session.error).toBe('The live room reset. Join again.');
    expect(connection.close).not.toHaveBeenCalled();
  });

  it('notifies the ended room once', async () => {
    const onEnded = vi.fn();
    const { session, media, connection, callbacks } = open({ onEnded });
    await joinStage(session, media, connection);
    callbacks()?.onEnded();
    callbacks()?.onEnded();
    expect(onEnded).toHaveBeenCalledOnce();
    expect(media.stopped).toBe(1);
    expect(session.phase).toBe('lobby');
  });

  it('keeps chat busy failures away from the active stage and broadcast and retains text on room end', async () => {
    const recorder = recorderFake();
    const h = open({ room: webinar, userId: 'host-user', createRecorder: () => recorder });
    expect(h.session.chat.visible).toBe(false);
    await startLiveBroadcast(h);
    await Promise.resolve();
    expect(h.connection.chatHistory).toHaveBeenCalledExactlyOnceWith({});
    const line = {
      sequence: 1,
      participantId: 'self',
      displayName: 'Ava',
      role: 'HOST' as const,
      text: 'Starting now.',
      sentAt: 0,
    };
    h.callbacks()!.onChatMessage?.(line);
    h.connection.chatSend.mockResolvedValueOnce({
      ok: false,
      error: 'chat_busy',
      message: 'Chat is busy. Try again shortly.',
    });
    h.session.chat.setDraft('Question');
    h.session.chat.sendDraft();
    await Promise.resolve();
    expect(h.session.phase).toBe('joined');
    expect(h.session.error).toBe('');
    expect(h.peers.close).not.toHaveBeenCalled();
    expect(h.connection.stopBroadcast).not.toHaveBeenCalled();
    expect(recorder.start).toHaveBeenCalledOnce();
    expect(recorder.stop).not.toHaveBeenCalled();
    expect(h.session.broadcastActive).toBe(true);
    h.callbacks()!.onEnded();
    expect(h.session.chat.getSnapshot().phase).toBe('closed');
    expect(h.session.chat.getSnapshot().messages).toEqual([line]);
    expect(h.session.chat.visible).toBe(true);
    expect(h.session.chat.canSend).toBe(false);
  });

  it('refetches chat after resume without replaying uncertain sends', async () => {
    vi.useFakeTimers();
    const h = open({ freshConnections: true });
    await joinRecoverable(h);
    h.connection.chatSend.mockImplementationOnce(() => new Promise(() => undefined));
    h.session.chat.setDraft('Uncertain question');
    h.session.chat.sendDraft();
    h.callbacks()!.onDisconnect();
    expect(h.session.chat.getSnapshot().attempts[0]?.status).toBe('failed');
    expect(h.session.chat.canSend).toBe(false);
    await vi.advanceTimersByTimeAsync(0);
    expect(h.session.phase).toBe('joined');
    expect(h.opened[1]!.connection.chatHistory).toHaveBeenCalledExactlyOnceWith({});
    expect(h.opened[1]!.connection.chatSend).not.toHaveBeenCalled();
    h.opened[0]!.callbacks.onChatMessage?.({
      sequence: 20,
      participantId: 'self',
      displayName: 'Ava',
      role: 'HOST',
      text: 'stale',
      sentAt: 0,
    });
    expect(h.session.chat.getSnapshot().messages).toEqual([]);
  });

  it('ignores a second dispose', async () => {
    const { session, media, connection } = open();
    await joinStage(session, media, connection);
    session.dispose();
    expect(media.stopped).toBe(1);
    session.dispose();
    expect(media.stopped).toBe(1);
  });

  it('keeps capture when join is rejected and releases it when the room has ended', async () => {
    const rejected = open();
    rejected.media.ready = true;
    rejected.connection.join.mockResolvedValue({
      ok: false,
      error: 'stage_full',
      message: 'The stage is full.',
    });
    await rejected.session.join();
    expect(rejected.session.phase).toBe('lobby');
    expect(rejected.session.error).toBe('The stage is full.');
    expect(rejected.media.stopped).toBe(0);
    expect(rejected.connection.close).toHaveBeenCalledOnce();

    const onEnded = vi.fn();
    const ended = open({ onEnded });
    ended.media.ready = true;
    ended.connection.join.mockResolvedValue({
      ok: false,
      error: 'room_ended',
      message: 'This room has ended.',
    });
    await ended.session.join();
    expect(onEnded).toHaveBeenCalledOnce();
    expect(ended.media.stopped).toBe(1);
    expect(ended.session.error).toBe('This room has ended.');
  });

  it('drops a demo peer removed while it is still starting', async () => {
    let releaseStart: () => void = () => undefined;
    const demo = {
      stop: vi.fn(),
      start: () =>
        new Promise<void>((resolve) => {
          releaseStart = resolve;
        }),
    };
    const { session, media, connection } = open({ createDemo: () => demo });
    media.ready = true;
    connection.join.mockImplementation(async () => {
      useRoomStore.getState().joined('self', []);
      useRoomStore.getState().receive(snapshot('self', 'HOST', true, 1));
      return { ok: true, participantId: 'self', iceServers: [] };
    });
    await session.join();

    const spawning = session.spawnDemo();
    await vi.waitFor(() => expect(session.demoCount).toBe(1));
    expect(session.demoStarting).toBe(true);
    session.removeDemos();
    expect(demo.stop).toHaveBeenCalled();
    expect(session.demoCount).toBe(0);
    expect(session.demoStarting).toBe(false);
    releaseStart();
    await spawning;
    expect(session.demoCount).toBe(0);
    expect(session.phase).toBe('joined');
  });

  it('does not capture when the member cannot replace a device', async () => {
    const getUserMedia = vi.fn();
    vi.stubGlobal('navigator', { mediaDevices: { getUserMedia } });

    const lobby = open();
    await lobby.session.replaceDevice('microphone', 'mic-2');
    expect(lobby.session.replacingMicrophone).toBe(false);
    expect(lobby.media.replaceInput).not.toHaveBeenCalled();
    expect(lobby.media.prepareCalls).toBe(0);

    const attendee = open({ room: webinar, userId: 'guest' });
    attendee.connection.join.mockImplementation(async () => {
      useRoomStore.getState().joined('self', []);
      useRoomStore
        .getState()
        .receive({ ...snapshot('self', 'ATTENDEE', false, 1), mode: 'WEBINAR' });
      return { ok: true, participantId: 'self', iceServers: [] };
    });
    await attendee.session.join();
    await attendee.session.replaceDevice('camera', 'cam-2');
    expect(attendee.media.replaceInput).not.toHaveBeenCalled();

    const stage = open();
    await joinStage(stage.session, stage.media, stage.connection);
    useRoomStore.getState().receive(snapshot('self', 'ATTENDEE', false, 2));
    await stage.session.replaceDevice('microphone', 'mic-2');
    expect(stage.media.replaceInput).not.toHaveBeenCalled();

    const consent = await promotedAttendee();
    await consent.session.replaceDevice('microphone', 'mic-2');
    expect(consent.media.replaceInput).not.toHaveBeenCalled();
    expect(consent.media.prepareCalls).toBe(0);
    expect(getUserMedia).not.toHaveBeenCalled();
  });

  it('marks only the requested kind busy until that replacement settles', async () => {
    const h = open();
    await joinStage(h.session, h.media, h.connection);
    let release = (): void => {
      throw new Error('The replacement has not started.');
    };
    h.media.replaceInput.mockImplementation(
      (kind) =>
        new Promise((resolve) => {
          const track = liveTrack(kind === 'camera' ? 'video' : 'audio');
          h.media.held = { kind, track };
          release = () => resolve(track);
        }),
    );
    const pending = h.session.replaceDevice('microphone', 'mic-2');
    expect(h.session.replacingMicrophone).toBe(true);
    expect(h.session.replacingCamera).toBe(false);
    expect(h.media.prepareCalls).toBe(0);
    await vi.waitFor(() => expect(h.media.replaceInput).toHaveBeenCalledOnce());
    release();
    await pending;
    expect(h.session.replacingMicrophone).toBe(false);
    expect(h.session.replacingCamera).toBe(false);
    expect(h.media.microphoneTrack()).toBeTruthy();
    expect(h.media.prepareCalls).toBe(0);
  });

  it('keeps a host-locked microphone disabled and does not send an unmute', async () => {
    const h = open();
    h.media.ready = true;
    h.connection.join.mockImplementation(async () => {
      useRoomStore.getState().joined('self', []);
      useRoomStore.getState().receive({
        ...snapshot('self', 'HOST', true, 1),
        participants: [{ ...person('self', 'HOST'), hostAudioLocked: true, isAudioMuted: true }],
      });
      return { ok: true, participantId: 'self', iceServers: [] };
    });
    await h.session.join();
    h.connection.media.mockClear();
    const next = liveTrack('audio');
    h.media.replaceInput.mockImplementation(async (kind) => {
      h.media.held = { kind, track: next };
      return next;
    });
    await h.session.replaceDevice('microphone', 'mic-2');
    expect(h.media.prepareCalls).toBe(0);
    expect(h.media.replaceInput).toHaveBeenCalledExactlyOnceWith('microphone', 'mic-2');
    expect(next.enabled).toBe(false);
    expect(h.peers.replaceAudioTrack).toHaveBeenCalledExactlyOnceWith(next);
    expect(h.connection.media).not.toHaveBeenCalled();
    expect(h.media.applyFlags).toHaveBeenCalledWith(true, false);
    expect(h.session.audioLocked).toBe(true);
  });

  it('publishes a replaced microphone to the broadcast only after it is committed', async () => {
    const recorder = recorderFake();
    const h = open({ room: webinar, userId: 'host-user', createRecorder: () => recorder });
    const previous = liveTrack('audio');
    const next = liveTrack('audio');
    h.media.microphone = previous;
    h.media.replaceInput.mockImplementation(async (kind) => {
      h.media.held = { kind, track: next };
      return next;
    });
    await startLiveBroadcast(h);
    expect(recorder.update.mock.calls.at(-1)?.[0]).toEqual([
      expect.objectContaining({ id: 'self', audioTrack: previous }),
    ]);
    h.peers.replaceAudioTrack.mockImplementation(async (track) => {
      expect(track).toBe(next);
      expect(h.media.microphoneTrack()).toBe(previous);
      expect(recorder.update.mock.calls.every((call) => call[0][0]?.audioTrack === previous)).toBe(
        true,
      );
    });
    await h.session.replaceDevice('microphone', 'mic-2');
    expect(h.media.prepareCalls).toBe(0);
    expect(h.media.microphoneTrack()).toBe(next);
    expect(previous.readyState).toBe('ended');
    expect(recorder.update.mock.calls.at(-1)?.[0]).toEqual([
      expect.objectContaining({ id: 'self', audioTrack: next }),
    ]);
    const committedAt = h.media.commitInput.mock.invocationCallOrder[0];
    const publishedAt = recorder.update.mock.invocationCallOrder.at(-1);
    expect(committedAt).toBeLessThan(publishedAt ?? 0);
    const heard = h.speaker.sync.mock.calls.at(-1)?.[0] as Map<string, MediaStreamTrack>;
    expect(heard.get('self')).toBe(next);
  });

  it('stores a camera chosen during screen share and restores it when the share stops', async () => {
    const h = open();
    await joinStage(h.session, h.media, h.connection);
    const previous = liveTrack('video');
    const next = liveTrack('video');
    const screen = liveTrack('video');
    h.media.camera = previous;
    h.media.screen = screen;
    h.media.replaceInput.mockImplementation(async (kind) => {
      h.media.held = { kind, track: next };
      return next;
    });
    await h.session.replaceDevice('camera', 'cam-2');
    expect(h.peers.replaceVideoTrack).not.toHaveBeenCalled();
    expect(h.media.cameraTrack()).toBe(next);
    expect(previous.readyState).toBe('ended');
    expect(screen.readyState).toBe('live');
    expect(h.media.screenTrack()).toBe(screen);
    await h.session.stopSharing();
    expect(h.peers.replaceVideoTrack).toHaveBeenCalledExactlyOnceWith(next);
    expect(screen.readyState).toBe('ended');
  });

  it('restores the previous microphone when a sender rejects the replacement', async () => {
    const h = open();
    await joinStage(h.session, h.media, h.connection);
    const previous = liveTrack('audio');
    const next = liveTrack('audio');
    h.media.microphone = previous;
    h.media.replaceInput.mockImplementation(async (kind) => {
      h.media.held = { kind, track: next };
      return next;
    });
    h.peers.replaceAudioTrack.mockRejectedValueOnce(new Error('replace failed'));
    await h.session.replaceDevice('microphone', 'mic-2');
    expect(h.peers.replaceAudioTrack).toHaveBeenNthCalledWith(1, next);
    expect(h.peers.replaceAudioTrack).toHaveBeenNthCalledWith(2, previous);
    expect(h.media.abortInput).toHaveBeenCalledWith(next);
    expect(h.media.commitInput).not.toHaveBeenCalled();
    expect(h.media.microphoneTrack()).toBe(previous);
    expect(previous.readyState).toBe('live');
    expect(next.readyState).toBe('ended');
    expect(h.session.error).toBe('replace failed');
    expect(h.session.phase).toBe('joined');
    expect(h.session.audioLocked).toBe(false);
  });

  it('disables the microphone when rolling the sender back fails', async () => {
    const h = open();
    await joinStage(h.session, h.media, h.connection);
    const previous = liveTrack('audio');
    const next = liveTrack('audio');
    h.media.microphone = previous;
    h.media.replaceInput.mockImplementation(async (kind) => {
      h.media.held = { kind, track: next };
      return next;
    });
    h.peers.replaceAudioTrack.mockRejectedValue(new Error('replace failed'));
    await h.session.replaceDevice('microphone', 'mic-2');
    expect(h.peers.replaceAudioTrack).toHaveBeenNthCalledWith(1, next);
    expect(h.peers.replaceAudioTrack).toHaveBeenNthCalledWith(2, previous);
    expect(h.media.abortInput).toHaveBeenCalledWith(next);
    expect(h.media.commitInput).not.toHaveBeenCalled();
    expect(h.media.microphoneTrack()).toBe(previous);
    expect(next.readyState).toBe('ended');
    expect(h.session.audioLocked).toBe(true);
    expect(h.media.applyFlags).toHaveBeenLastCalledWith(true, false);
    expect(h.session.error).toBe(
      'Unable to switch your microphone. The microphone is off until you choose another.',
    );
    expect(h.session.phase).toBe('joined');
  });

  it('stops a replacement that resolves after leave and does not replace the sender', async () => {
    const h = open();
    await joinStage(h.session, h.media, h.connection);
    let finish!: (track: MediaStreamTrack) => void;
    h.media.replaceInput.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const pending = h.session.replaceDevice('microphone', 'mic-2');
    await vi.waitFor(() => expect(h.media.replaceInput).toHaveBeenCalled());
    const leaving = h.session.leave();
    const late = liveTrack('audio');
    finish(late);
    await pending;
    await leaving;
    expect(h.peers.replaceAudioTrack).not.toHaveBeenCalled();
    expect(h.media.abortInput).toHaveBeenCalledWith(late);
    expect(late.readyState).toBe('ended');
    expect(h.session.phase).toBe('lobby');
  });

  it('stops a replacement that resolves after demotion and does not replace the sender', async () => {
    const h = open();
    await joinStage(h.session, h.media, h.connection);
    let finish!: (track: MediaStreamTrack) => void;
    h.media.replaceInput.mockReturnValue(
      new Promise((resolve) => {
        finish = resolve;
      }),
    );
    const pending = h.session.replaceDevice('camera', 'cam-2');
    await vi.waitFor(() => expect(h.media.replaceInput).toHaveBeenCalled());
    useRoomStore.getState().receive(snapshot('self', 'ATTENDEE', false, 2));
    const late = liveTrack('video');
    finish(late);
    await pending;
    expect(h.peers.replaceVideoTrack).not.toHaveBeenCalled();
    expect(h.media.abortInput).toHaveBeenCalledWith(late);
    expect(late.readyState).toBe('ended');
    expect(h.media.stopped).toBe(1);
    expect(h.session.phase).toBe('joined');
    expect(h.connection.close).not.toHaveBeenCalled();
  });

  it('mutes an ended microphone and stays joined', async () => {
    const devices = stubDeviceList();
    const h = open();
    await joinStage(h.session, h.media, h.connection);
    h.connection.media.mockClear();
    h.media.ended?.('microphone');
    expect(h.connection.media).toHaveBeenCalledExactlyOnceWith({ isAudioMuted: true });
    expect(h.session.phase).toBe('joined');
    expect(h.session.microphoneUnavailable).toBe(true);
    expect(h.session.isAudioMuted).toBe(true);
    expect(h.session.cameraUnavailable).toBe(false);
    expect(h.media.applyFlags).toHaveBeenLastCalledWith(true, false);
    expect(h.connection.leave).not.toHaveBeenCalled();
    expect(h.peers.close).not.toHaveBeenCalled();
    expect(h.media.replaceInput).not.toHaveBeenCalled();
    expect(devices.getUserMedia).not.toHaveBeenCalled();
    h.media.ended?.('microphone');
    expect(h.connection.media).toHaveBeenCalledOnce();
  });

  it('does not replace the screen sender when the camera ends', async () => {
    const h = open();
    await joinStage(h.session, h.media, h.connection);
    const camera = liveTrack('video');
    const screen = liveTrack('video');
    h.media.camera = camera;
    h.media.screen = screen;
    h.connection.media.mockClear();
    h.peers.replaceVideoTrack.mockClear();
    h.media.ended?.('camera');
    expect(h.connection.media).toHaveBeenCalledExactlyOnceWith({ isVideoOff: true });
    expect(h.peers.replaceVideoTrack).not.toHaveBeenCalled();
    expect(h.peers.replaceAudioTrack).not.toHaveBeenCalled();
    expect(screen.readyState).toBe('live');
    expect(h.media.screenTrack()).toBe(screen);
    expect(h.session.phase).toBe('joined');
    expect(h.session.cameraUnavailable).toBe(true);
    expect(h.session.isVideoOff).toBe(true);
    expect(h.connection.leave).not.toHaveBeenCalled();
    camera.stop();
    await h.session.stopSharing();
    expect(h.peers.replaceVideoTrack).toHaveBeenCalledExactlyOnceWith(null);
    expect(camera.readyState).toBe('ended');
  });

  it('refreshes the device list when an input is added and does not capture', async () => {
    const devices = stubDeviceList();
    let listed: MediaDeviceInfo[] = [];
    const enumerate = vi.fn(async () => listed);
    const h = open({ enumerateDevices: enumerate });
    await joinStage(h.session, h.media, h.connection);
    h.connection.media.mockClear();
    listed = [device('audioinput', 'mic-new')];
    devices.dispatch();
    await vi.waitFor(() =>
      expect(h.session.devices.map((item) => item.deviceId)).toEqual(['mic-new']),
    );
    expect(devices.getUserMedia).not.toHaveBeenCalled();
    expect(h.media.replaceInput).not.toHaveBeenCalled();
    expect(h.media.prepareCalls).toBe(0);
    expect(h.connection.media).not.toHaveBeenCalled();
    expect(h.connection.leave).not.toHaveBeenCalled();
    expect(h.session.microphoneUnavailable).toBe(false);
    expect(h.session.cameraUnavailable).toBe(false);
    expect(h.session.phase).toBe('joined');
  });

  it('marks a missing selected camera unavailable and keeps the default microphone', async () => {
    const devices = stubDeviceList();
    let listed = [device('videoinput', 'cam-1'), device('audioinput', 'mic-1')];
    const enumerate = vi.fn(async () => listed);
    const h = open({ enumerateDevices: enumerate });
    await joinStage(h.session, h.media, h.connection);
    await h.session.prepare({} as HTMLVideoElement, { cameraId: 'cam-1', microphoneId: '' });
    h.connection.media.mockClear();
    h.media.replaceInput.mockClear();
    listed = [device('audioinput', 'mic-1')];
    devices.dispatch();
    await vi.waitFor(() =>
      expect(h.connection.media).toHaveBeenCalledExactlyOnceWith({ isVideoOff: true }),
    );
    expect(h.session.cameraUnavailable).toBe(true);
    expect(h.session.isVideoOff).toBe(true);
    expect(h.session.microphoneUnavailable).toBe(false);
    expect(h.session.isAudioMuted).toBe(false);
    expect(h.session.phase).toBe('joined');
    expect(devices.getUserMedia).not.toHaveBeenCalled();
    expect(h.media.replaceInput).not.toHaveBeenCalled();
    expect(h.connection.leave).not.toHaveBeenCalled();
    expect(h.peers.close).not.toHaveBeenCalled();
    const calls = enumerate.mock.calls.length;
    devices.dispatch();
    await vi.waitFor(() => expect(enumerate.mock.calls.length).toBeGreaterThan(calls));
    expect(h.connection.media).toHaveBeenCalledOnce();
  });

  it('marks a missing selected microphone unavailable without leaving', async () => {
    const devices = stubDeviceList();
    let listed = [device('audioinput', 'mic-1'), device('videoinput', 'cam-1')];
    const h = open({ enumerateDevices: async () => listed });
    await joinStage(h.session, h.media, h.connection);
    await h.session.prepare({} as HTMLVideoElement, {
      cameraId: 'cam-1',
      microphoneId: 'mic-1',
    });
    h.connection.media.mockClear();
    listed = [device('videoinput', 'cam-1')];
    devices.dispatch();
    await vi.waitFor(() =>
      expect(h.connection.media).toHaveBeenCalledExactlyOnceWith({ isAudioMuted: true }),
    );
    expect(h.session.microphoneUnavailable).toBe(true);
    expect(h.session.cameraUnavailable).toBe(false);
    expect(h.session.phase).toBe('joined');
    expect(devices.getUserMedia).not.toHaveBeenCalled();
    expect(h.media.replaceInput).not.toHaveBeenCalled();
    expect(h.connection.leave).not.toHaveBeenCalled();
  });

  it('removes the devicechange listener when the session detaches', async () => {
    const devices = stubDeviceList();
    let release!: (value: MediaDeviceInfo[]) => void;
    const enumerate = vi.fn(
      () =>
        new Promise<MediaDeviceInfo[]>((resolve) => {
          release = resolve;
        }),
    );
    const h = open({ enumerateDevices: enumerate });
    expect(devices.names.size).toBe(1);
    devices.dispatch();
    await vi.waitFor(() => expect(enumerate).toHaveBeenCalledOnce());
    h.session.dispose();
    expect(devices.names.size).toBe(0);
    release([device('audioinput', 'mic-late')]);
    await Promise.resolve();
    expect(h.session.devices).toEqual([]);
    expect(h.session.microphoneUnavailable).toBe(false);
    devices.dispatch();
    expect(enumerate).toHaveBeenCalledOnce();
    h.session.dispose();
    expect(devices.names.size).toBe(0);
  });

  it('keeps the previous device list when enumeration fails', async () => {
    const devices = stubDeviceList();
    const listed = [device('audioinput', 'mic-1')];
    let failed = false;
    const enumerate = vi
      .fn<() => Promise<MediaDeviceInfo[]>>()
      .mockResolvedValueOnce(listed)
      .mockImplementationOnce(async () => {
        failed = true;
        throw new Error('unavailable');
      });
    const h = open({ enumerateDevices: enumerate });
    devices.dispatch();
    await vi.waitFor(() => expect(h.session.devices).toEqual(listed));
    devices.dispatch();
    await vi.waitFor(() => expect(failed).toBe(true));
    expect(h.session.devices).toEqual(listed);
    expect(h.session.microphoneUnavailable).toBe(false);
    expect(h.session.cameraUnavailable).toBe(false);
  });

  it('clears microphone unavailability when a replacement commits and keeps the mute', async () => {
    const h = open();
    await joinStage(h.session, h.media, h.connection);
    h.media.ended?.('microphone');
    expect(h.session.microphoneUnavailable).toBe(true);
    useRoomStore.getState().receive({
      ...snapshot('self', 'HOST', true, 2),
      participants: [{ ...person('self', 'HOST'), isAudioMuted: true }],
    });
    const next = liveTrack('audio');
    h.media.replaceInput.mockImplementation(async (kind) => {
      h.media.held = { kind, track: next };
      return next;
    });
    h.connection.media.mockClear();
    await h.session.replaceDevice('microphone', 'mic-2');
    expect(h.session.microphoneUnavailable).toBe(false);
    expect(h.session.isAudioMuted).toBe(true);
    expect(next.enabled).toBe(false);
    expect(h.session.choices.microphoneId).toBe('mic-2');
    expect(h.connection.media).not.toHaveBeenCalled();
    expect(h.media.prepareCalls).toBe(0);
    expect(h.session.phase).toBe('joined');
  });

  it('leaves the microphone unavailable when replacement fails', async () => {
    const h = open();
    await joinStage(h.session, h.media, h.connection);
    h.media.ended?.('microphone');
    h.media.replaceInput.mockRejectedValueOnce(new Error('denied'));
    await h.session.replaceDevice('microphone', 'mic-3');
    expect(h.session.microphoneUnavailable).toBe(true);
    expect(h.session.isAudioMuted).toBe(true);
    expect(h.session.choices).toEqual({ cameraId: '', microphoneId: '' });
    expect(h.session.phase).toBe('joined');
    expect(h.connection.leave).not.toHaveBeenCalled();
  });
});
