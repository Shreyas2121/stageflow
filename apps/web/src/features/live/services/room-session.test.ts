import { afterEach, describe, expect, it, vi } from 'vitest';
import type {
  JoinAck,
  ParticipantRole,
  ParticipantState,
  RelayedDescription,
  RoomResponse,
  RoomSnapshot,
  StageForceMute,
} from '@stageflow/shared';
import type { DemoFactory } from './demo-registry';
import type { PeerManager } from './peer-manager';
import { RoomSession, type RoomMedia } from './room-session';
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
  applyFlags = vi.fn<RoomMedia['applyFlags']>();
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
    onForceMute?: (payload: StageForceMute) => void;
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
      useRoomStore
        .getState()
        .receive({ ...snapshot('self', 'HOST', true, 1), stageSocketIds: ['self', 'other'] });
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
      return { ok: true, selfSocketId: 'self', iceServers: [] };
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
      handSocketIds: ['guest'],
    };
    connection.join.mockImplementation(async () => {
      useRoomStore.getState().joined('self', []);
      useRoomStore.getState().receive(original);
      return { ok: true, selfSocketId: 'self', iceServers: [] };
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
      stageSocketIds: ['self', 'guest'],
      handSocketIds: [],
    };
    useRoomStore.getState().receive(promoted);
    expect(useRoomStore.getState().snapshot).toBe(original);
    useRoomStore.getState().receive({ ...promoted, revision: 2 });
    expect(useRoomStore.getState().snapshot?.participants[1]?.role).toBe('SPEAKER');
    const current = useRoomStore.getState().snapshot;
    await session.setLock('guest', 'video', true);
    await session.demote('guest');
    expect(connection.setLock).toHaveBeenCalledExactlyOnceWith({
      targetSocketId: 'guest',
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
      return { ok: true, selfSocketId: 'self', iceServers: [] };
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
      return { ok: true, selfSocketId: 'self', iceServers: [] };
    });
    await h.session.join();
    const promoted: RoomSnapshot = {
      ...offStage,
      revision: 2,
      stageSocketIds: ['self', 'host'],
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
      expect(useRoomStore.getState().snapshot?.stageSocketIds).toContain('self');
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
      toSocketId: 'self',
      fromSocketId: 'host',
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
        toSocketId: 'self',
        fromSocketId: 'host',
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
