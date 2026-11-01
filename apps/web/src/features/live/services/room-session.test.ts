import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  JoinAck,
  ParticipantRole,
  ParticipantState,
  RelayedDescription,
  RoomResponse,
  RoomSnapshot,
} from '@stageflow/shared';
import type { DemoFactory } from './demo-registry';
import type { PeerManager } from './peer-manager';
import { RoomSession, type RoomMedia } from './room-session';
import { useRoomStore } from '../stores/room-store';

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

function person(socketId: string, role: ParticipantRole): ParticipantState {
  return {
    socketId,
    userId: socketId,
    displayName: socketId,
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
  socketId: string,
  role: ParticipantRole,
  onStage: boolean,
  revision: number,
): RoomSnapshot {
  return {
    revision,
    roomId: room.id,
    mode: 'MEETING',
    status: 'LIVE',
    participants: [person(socketId, role)],
    stageSocketIds: onStage ? [socketId] : [],
    handSocketIds: [],
    broadcast: null,
  };
}

class FakeMedia implements RoomMedia {
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
  }
  releaseLobby(): void {
    this.lobbyReleased += 1;
  }
  applyFlags(): void {}
  setSpeaker(): Promise<{ ok: boolean; supported: boolean; deviceId: string; message: string }> {
    return Promise.resolve({ ok: true, supported: false, deviceId: '', message: '' });
  }
  microphoneTrack(): null {
    return null;
  }
  cameraTrack(): null {
    return null;
  }
  screenTrack(): null {
    return null;
  }
  previewStream(): null {
    return null;
  }
  startScreenShare(): Promise<MediaStreamTrack> {
    return Promise.reject(new Error('Screen sharing is not used in this test.'));
  }
  stopScreenShare(): void {}
  setLevelListener(): void {}
}

function fakePeers() {
  return {
    sync: vi.fn(),
    close: vi.fn(),
    description: vi.fn(),
    candidate: vi.fn(),
    replaceVideoTrack: vi.fn(() => Promise.resolve()),
    statsConnections: () => [],
  };
}

function fakeConnection() {
  return {
    description: vi.fn(() => Promise.resolve({ ok: true as const })),
    candidate: vi.fn(() => Promise.resolve({ ok: true as const })),
    join: vi.fn<() => Promise<JoinAck>>(() =>
      Promise.resolve({ ok: true, selfSocketId: 'self', iceServers: [] }),
    ),
    media: vi.fn(() => Promise.resolve({ ok: true as const })),
    hand: vi.fn(() => Promise.resolve({ ok: true as const })),
    leave: vi.fn(() => Promise.resolve({ ok: true as const })),
    close: vi.fn(),
  };
}

function harness(options?: {
  room?: RoomResponse;
  userId?: string;
  onEnded?: () => void;
  createDemo?: DemoFactory;
}) {
  const media = new FakeMedia();
  const peers = fakePeers();
  const connection = fakeConnection();
  const speaker = { sync: vi.fn(), close: vi.fn() };
  let callbacks: {
    onDescription: (payload: RelayedDescription) => void;
    onEnded: () => void;
    onDisconnect: () => void;
  } | null = null;
  const session = new RoomSession({
    room: options?.room ?? room,
    userId: options?.userId ?? 'user-1',
    token: 'token',
    onEnded: options?.onEnded ?? (() => undefined),
    media,
    openSignaling: (_token, roomId, next) => {
      callbacks = next;
      useRoomStore.getState().begin(roomId);
      return connection;
    },
    createPeers: () => peers as unknown as PeerManager,
    createSpeaker: () => speaker,
    createDemo: options?.createDemo,
    createAudioContext: () => ({
      state: 'running',
      resume: () => Promise.resolve(),
      close: () => Promise.resolve(),
    }),
    enumerateDevices: () => Promise.resolve([]),
  });
  session.attach();
  return {
    session,
    media,
    peers,
    connection,
    speaker,
    callbacks: () => callbacks,
  };
}

describe('RoomSession', () => {
  const sessions: RoomSession[] = [];

  afterEach(() => {
    for (const session of sessions) session.dispose();
    sessions.length = 0;
    useRoomStore.getState().clear();
  });

  function open(options?: Parameters<typeof harness>[0]) {
    const created = harness(options);
    sessions.push(created.session);
    return created;
  }

  it('applies the stage snapshot before a description that follows it', async () => {
    const order: string[] = [];
    const { session, media, peers, connection, callbacks } = open();
    media.ready = true;
    const description: RelayedDescription = {
      fromSocketId: 'other',
      toSocketId: 'self',
      description: { type: 'offer', sdp: 'v=0' },
    };
    connection.join.mockImplementation(async () => {
      useRoomStore.getState().receive(snapshot('self', 'HOST', true, 1));
      useRoomStore.getState().joined('self', []);
      order.push('after-store');
      callbacks()?.onDescription(description);
      order.push('after-description');
      return { ok: true, selfSocketId: 'self', iceServers: [] };
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
    finishJoin({ ok: true, selfSocketId: 'self', iceServers: [] });
    await joining;
    expect(session.phase).toBe('joined');
  });

  it('does not capture media when an attendee is promoted', async () => {
    const { session, media, connection } = open({ room: webinar, userId: 'guest' });
    connection.join.mockImplementation(async () => {
      useRoomStore.getState().joined('self', []);
      useRoomStore.getState().receive(snapshot('self', 'ATTENDEE', false, 1));
      return { ok: true, selfSocketId: 'self', iceServers: [] };
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
      return { ok: true, selfSocketId: 'self', iceServers: [] };
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

  async function joinStage(
    session: RoomSession,
    media: FakeMedia,
    connection: ReturnType<typeof fakeConnection>,
  ) {
    media.ready = true;
    connection.join.mockImplementation(async () => {
      useRoomStore.getState().joined('self', []);
      useRoomStore.getState().receive(snapshot('self', 'HOST', true, 1));
      return { ok: true, selfSocketId: 'self', iceServers: [] };
    });
    await session.join();
  }

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
      return { ok: true, selfSocketId: 'self', iceServers: [] };
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
});
