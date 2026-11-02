import type {
  CommandAck,
  IceServer,
  ParticipantRole,
  ParticipantState,
  RoomResponse,
  StageForceMute,
  RelayedDescription,
  RelayedIceCandidate,
} from '@stageflow/shared';
import {
  StageRecorder,
  type BroadcastRecorder,
  type RecorderFinish,
  type StageSource,
} from '../../broadcast/services/stage-recorder';
import { ActiveSpeaker } from './active-speaker';
import { DemoPeer } from './demo-peer';
import { DemoRegistry, type DemoAudio, type DemoFactory } from './demo-registry';
import { LocalMedia, type DeviceChoices } from './local-media';
import type { OutputRouteResult } from './output-route';
import { PeerManager, type RemoteStreams, type TrackSource } from './peer-manager';
import { audienceFor, roleTransition, type StageMembership } from './role-transition';
import { ScreenShareController } from './screen-share';
import { openSignaling, type RoomConnection } from './signaling';
import { useRoomStore } from '../stores/room-store';

export type ConnectionPhase = 'lobby' | 'joining' | 'joined' | 'leaving';
type PendingStageEvent =
  | { type: 'description'; payload: RelayedDescription }
  | { type: 'candidate'; payload: RelayedIceCandidate };

export type RoomMedia = TrackSource & {
  readonly ready: boolean;
  prepare(video: HTMLVideoElement, choices: DeviceChoices): Promise<boolean>;
  stop(): void;
  releaseLobby(): void;
  applyFlags(isAudioMuted: boolean, isVideoOff: boolean): void;
  setSpeaker(deviceId: string): Promise<OutputRouteResult>;
  previewStream(): MediaStream | null;
  setLevelListener(listener: ((level: number) => void) | null): void;
  startScreenShare(): Promise<MediaStreamTrack>;
  stopScreenShare(): void;
};

type RoomSpeaker = {
  sync(tracks: ReadonlyMap<string, MediaStreamTrack>): void;
  close(): void;
};

export type RoomSessionOptions = {
  room: RoomResponse;
  userId: string;
  token: string;
  onEnded: () => void;
  media?: RoomMedia;
  openSignaling?: typeof openSignaling;
  createPeers?: (
    media: TrackSource,
    connection: RoomConnection,
    publish: (streams: RemoteStreams) => void,
    onError: (message: string) => void,
  ) => PeerManager;
  createSpeaker?: (publish: (socketId: string | null) => void) => RoomSpeaker;
  createDemo?: DemoFactory;
  createAudioContext?: () => DemoAudio;
  enumerateDevices?: () => Promise<MediaDeviceInfo[]>;
  createRecorder?: (options: {
    broadcastId: string;
    token: string;
    onCap: () => void;
  }) => BroadcastRecorder;
};

/**
 * One owner for join, leave, disconnect, room end, and unmount.
 * Peer sync runs inside the room-store subscriber so a snapshot is applied
 * before a description or ICE candidate queued behind it.
 * Promotion asks for device consent. Demotion releases capture.
 */
export class RoomSession {
  private activationPending = false;
  private forcedAudio = false;
  private forcedVideo = false;
  private forceRevision = -1;
  private pendingStageEvents: PendingStageEvent[] = [];
  private pendingStageBytes = 0;
  private consentSignalingFailed = false;
  readonly media: RoomMedia;
  readonly share: ScreenShareController;
  readonly demos: DemoRegistry;

  private readonly room: RoomResponse;
  private readonly userId: string;
  private readonly token: string;
  private readonly onEnded: () => void;
  private readonly open: typeof openSignaling;
  private readonly createPeers: NonNullable<RoomSessionOptions['createPeers']>;
  private readonly enumerateDevices: () => Promise<MediaDeviceInfo[]>;
  private readonly speaker: RoomSpeaker;
  private readonly listeners = new Set<() => void>();
  private readonly createRecorder: NonNullable<RoomSessionOptions['createRecorder']>;

  private connection: RoomConnection | null = null;
  private peers: PeerManager | null = null;
  private recorder: BroadcastRecorder | null = null;
  private recordingId: string | null = null;
  private armedBroadcast = false;
  private readonly stageVideos = new Map<string, HTMLVideoElement>();
  private unsubscribe: (() => void) | null = null;
  private attached = false;
  private generation = 0;
  private prepareToken = 0;
  private settled: StageMembership | null = null;
  private endedNotified = false;

  private readonly state: {
    phase: ConnectionPhase;
    preparing: boolean;
    mediaPending: boolean;
    sharePending: boolean;
    ready: boolean;
    error: string;
    speakerError: string;
    choices: DeviceChoices;
    speakerId: string;
    devices: MediaDeviceInfo[];
    sinkSupported: boolean;
    isAudioMuted: boolean;
    isVideoOff: boolean;
    streams: RemoteStreams;
    peerManager: PeerManager | null;
    activeSocketId: string | null;
    needsCaptureConsent: boolean;
    sharing: boolean;
    role: ParticipantRole | null;
    onStage: boolean;
  } = {
    phase: 'lobby',
    preparing: false,
    mediaPending: false,
    sharePending: false,
    ready: false,
    error: '',
    speakerError: '',
    choices: { cameraId: '', microphoneId: '' },
    speakerId: '',
    devices: [],
    sinkSupported: false,
    isAudioMuted: false,
    isVideoOff: false,
    streams: new Map(),
    peerManager: null,
    activeSocketId: null,
    needsCaptureConsent: false,
    sharing: false,
    role: null,
    onStage: false,
  };

  constructor(options: RoomSessionOptions) {
    this.room = options.room;
    this.userId = options.userId;
    this.token = options.token;
    this.onEnded = options.onEnded;
    this.media = options.media ?? new LocalMedia();
    this.open = options.openSignaling ?? openSignaling;
    this.createPeers =
      options.createPeers ??
      ((media, connection, publish, onError) =>
        new PeerManager(media, connection, publish, onError));
    this.enumerateDevices =
      options.enumerateDevices ?? (() => navigator.mediaDevices.enumerateDevices());
    this.createRecorder = options.createRecorder ?? ((recorder) => new StageRecorder(recorder));
    const publishSpeaker = (socketId: string | null) => {
      this.state.activeSocketId = socketId;
      this.emit();
    };
    this.speaker = options.createSpeaker
      ? options.createSpeaker(publishSpeaker)
      : new ActiveSpeaker(publishSpeaker);
    const generation = () => this.generation;
    const connection = () => this.connection;
    const peers = () => this.peers;
    this.share = new ScreenShareController({
      get generation() {
        return generation();
      },
      get connection() {
        return connection();
      },
      get peers() {
        return peers();
      },
      media: this.media,
      onStage: () => this.state.onStage && this.state.phase === 'joined',
      setSharing: (sharing) => {
        this.state.sharing = sharing;
        this.syncRecorder();
        this.emit();
      },
      setPending: (pending) => {
        this.state.sharePending = pending;
        this.emit();
      },
      setError: (message) => {
        this.state.error = message;
        this.emit();
      },
    });
    this.demos = new DemoRegistry({
      get generation() {
        return generation();
      },
      get connection() {
        return connection();
      },
      roomId: this.room.id,
      role: () => this.state.role,
      setError: (message) => {
        this.state.error = message;
        this.emit();
      },
      emit: () => this.emit(),
      createDemo:
        options.createDemo ??
        ((name, context, onError, onStopped) =>
          new DemoPeer(name, context as AudioContext, onError, onStopped)),
      createAudioContext: options.createAudioContext ?? (() => new AudioContext()),
    });
  }

  get catalogAttendee(): boolean {
    return this.room.mode === 'WEBINAR' && this.room.hostId !== this.userId;
  }

  get phase(): ConnectionPhase {
    return this.state.phase;
  }
  get preparing(): boolean {
    return this.state.preparing;
  }
  get mediaPending(): boolean {
    return this.state.mediaPending || this.activationPending;
  }
  get sharePending(): boolean {
    return this.state.sharePending;
  }
  get ready(): boolean {
    return this.state.ready;
  }
  get error(): string {
    return this.state.error;
  }
  get speakerError(): string {
    return this.state.speakerError;
  }
  get choices(): DeviceChoices {
    return this.state.choices;
  }
  get speakerId(): string {
    return this.state.speakerId;
  }
  get devices(): MediaDeviceInfo[] {
    return this.state.devices;
  }
  get sinkSupported(): boolean {
    return this.state.sinkSupported;
  }
  get isAudioMuted(): boolean {
    return this.state.isAudioMuted;
  }
  get isVideoOff(): boolean {
    return this.state.isVideoOff;
  }
  get streams(): RemoteStreams {
    return this.state.streams;
  }
  get peerManager(): PeerManager | null {
    return this.state.peerManager;
  }
  get activeSocketId(): string | null {
    return this.state.activeSocketId;
  }
  get needsCaptureConsent(): boolean {
    return this.state.needsCaptureConsent;
  }
  get sharing(): boolean {
    return this.state.sharing;
  }
  get audioLocked(): boolean {
    return this.forcedAudio || Boolean(this.selfParticipant()?.hostAudioLocked);
  }
  get videoLocked(): boolean {
    return this.forcedVideo || Boolean(this.selfParticipant()?.hostVideoLocked);
  }
  get role(): ParticipantRole | null {
    return this.state.role;
  }
  get onStage(): boolean {
    return this.state.onStage;
  }
  get demoCount(): number {
    return this.demos.count;
  }
  get demoStarting(): boolean {
    return this.demos.starting;
  }
  get audience(): 'attendee' | 'stage' {
    return audienceFor(this.state.role, this.catalogAttendee);
  }
  get broadcastActive(): boolean {
    const status = useRoomStore.getState().snapshot?.broadcast?.status;
    return (
      this.armedBroadcast ||
      this.recorder !== null ||
      status === 'STARTING' ||
      status === 'LIVE' ||
      status === 'STOPPING'
    );
  }

  subscribe(listener: () => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.unsubscribe = useRoomStore.subscribe(() => this.syncFromStore());
    if (typeof window !== 'undefined') window.addEventListener('pagehide', this.onPageHide);
  }

  dispose(): void {
    if (!this.attached) return;
    this.attached = false;
    if (typeof window !== 'undefined') window.removeEventListener('pagehide', this.onPageHide);
    this.teardownLocal();
    this.connection?.close();
    this.connection = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.state.phase = 'lobby';
    this.emit();
  }

  async prepare(video: HTMLVideoElement, nextChoices = this.state.choices): Promise<void> {
    if (this.catalogAttendee && !this.state.needsCaptureConsent) return;
    if (this.state.needsCaptureConsent && this.consentSignalingFailed) return;
    const token = ++this.prepareToken;
    const generation = this.generation;
    const promoted = this.state.phase === 'joined' && this.state.needsCaptureConsent;
    this.state.preparing = true;
    this.state.ready = false;
    this.state.error = '';
    this.state.speakerError = '';
    this.state.choices = nextChoices;
    this.emit();
    try {
      this.applyLocalFlags();
      const prepared = await this.media.prepare(video, nextChoices);
      if (token !== this.prepareToken || generation !== this.generation) {
        if (prepared) this.media.stop();
        return;
      }
      if (!prepared) return;
      this.state.devices = await this.enumerateDevices();
      if (token !== this.prepareToken || generation !== this.generation) return;
      const route = await this.media.setSpeaker(this.state.speakerId);
      if (token !== this.prepareToken || generation !== this.generation) return;
      this.state.sinkSupported = route.supported;
      if (route.ok) this.state.speakerId = route.deviceId;
      else {
        this.state.speakerId = '';
        this.state.speakerError = route.message;
      }
      this.state.ready = this.media.ready;
      this.applyLocalFlags();
      if (this.state.phase === 'joined' && this.media.ready) {
        if (!this.state.onStage) return;
        this.activationPending = promoted;
        this.state.needsCaptureConsent = false;
        this.media.releaseLobby();
        this.syncFromStore();
        if (promoted && this.connection) {
          const active = this.connection;
          let accepted = false;
          try {
            const result = await active.media({
              isAudioMuted: this.state.isAudioMuted || this.audioLocked,
              isVideoOff: this.state.isVideoOff || this.videoLocked,
            });
            if (
              token !== this.prepareToken ||
              generation !== this.generation ||
              this.connection !== active
            )
              return;
            accepted = result.ok;
            if (!result.ok) this.state.error = result.message;
          } catch {
            if (token === this.prepareToken && this.connection === active)
              this.state.error = 'Unable to update the room. Try again.';
          } finally {
            if (
              token === this.prepareToken &&
              generation === this.generation &&
              this.connection === active
            ) {
              this.activationPending = false;
              if (accepted) this.applyLocalFlags();
              else this.media.applyFlags(true, true);
            }
          }
        }
      }
    } catch (failure) {
      if (token === this.prepareToken && generation === this.generation) {
        this.media.stop();
        this.state.ready = false;
        this.state.error =
          failure instanceof Error ? failure.message : 'Unable to prepare your devices.';
      }
    } finally {
      if (token === this.prepareToken && generation === this.generation)
        this.state.preparing = false;
      this.emit();
    }
  }

  async setSpeaker(deviceId: string): Promise<void> {
    const generation = this.generation;
    const route = await this.media.setSpeaker(deviceId);
    if (generation !== this.generation) return;
    this.state.sinkSupported = route.supported;
    if (route.ok) {
      this.state.speakerId = route.deviceId;
      this.state.speakerError = '';
    } else {
      this.state.speakerId = '';
      this.state.speakerError = route.message;
    }
    this.emit();
  }

  async join(): Promise<void> {
    if (this.state.phase !== 'lobby' || this.state.preparing) return;
    if (!this.catalogAttendee && !this.media.ready) {
      this.state.ready = false;
      this.state.error = 'Enable your camera and microphone before joining.';
      this.emit();
      return;
    }
    const generation = this.generation;
    this.state.phase = 'joining';
    this.state.error = '';
    this.emit();
    const opened: { current: RoomConnection | null } = { current: null };
    let active: RoomConnection | null = null;
    try {
      active = this.open(this.token, this.room.id, {
        onForceMute: (payload) => this.forceMute(payload),
        onDescription: (payload) => this.receiveStage({ type: 'description', payload }),
        onCandidate: (payload) => this.receiveStage({ type: 'candidate', payload }),
        onEnded: () => {
          if (opened.current) this.finishEnded(opened.current);
        },
        onDisconnect: () => {
          if (opened.current) this.finishDisconnect(opened.current);
        },
      });
      opened.current = active;
      this.connection = active;
      const result = await active.join({
        roomId: this.room.id,
        isAudioMuted: this.catalogAttendee || this.state.isAudioMuted,
        isVideoOff: this.catalogAttendee || this.state.isVideoOff,
        isSyntheticBot: false,
      });
      if (generation !== this.generation || this.connection !== active) return;
      if (!result.ok) {
        active.close();
        if (this.connection === active) this.connection = null;
        this.state.phase = 'lobby';
        this.state.error = result.message;
        if (result.error === 'room_ended') {
          this.teardownLocal();
          this.notifyEnded();
        }
        return;
      }
      this.state.phase = 'joined';
      this.media.releaseLobby();
      this.syncFromStore();
    } catch (failure) {
      if (generation !== this.generation || (active && this.connection !== active)) return;
      active?.close();
      if (active && this.connection === active) this.connection = null;
      this.state.phase = 'lobby';
      this.state.error = failure instanceof Error ? failure.message : 'Unable to join this room.';
    } finally {
      this.emit();
    }
  }

  async leave(): Promise<void> {
    if (this.state.phase === 'leaving') return;
    const active = this.connection;
    this.state.phase = 'leaving';
    this.state.error = '';
    this.teardownLocal();
    this.emit();
    try {
      if (active) {
        const result = await active.leave();
        if (this.connection === active && !result.ok) this.state.error = result.message;
      }
    } catch {
      // Closing the socket below also uses the server's leave path.
    } finally {
      if (this.connection === active) {
        active?.close();
        this.connection = null;
      }
      if (this.attached) this.state.phase = 'lobby';
      this.emit();
    }
  }

  toggleAudio(): void {
    if (this.audioLocked || this.activationPending) return;
    const self = this.selfParticipant();
    if (self && this.connection && this.state.phase === 'joined') {
      void this.send((active) => active.media({ isAudioMuted: !self.isAudioMuted }));
      return;
    }
    this.state.isAudioMuted = !this.state.isAudioMuted;
    this.applyLocalFlags();
    this.emit();
  }

  toggleVideo(): void {
    if (this.videoLocked || this.activationPending) return;
    const self = this.selfParticipant();
    if (self && this.connection && this.state.phase === 'joined') {
      void this.send((active) => active.media({ isVideoOff: !self.isVideoOff }));
      return;
    }
    this.state.isVideoOff = !this.state.isVideoOff;
    this.applyLocalFlags();
    this.emit();
  }

  toggleHand(): void {
    const self = this.selfParticipant();
    if (!self || this.state.phase !== 'joined') return;
    void this.send((active) => active.hand(!self.isHandRaised));
  }

  promote(targetSocketId: string): Promise<void> {
    return this.moderate((active) => active.promote(targetSocketId));
  }

  startBroadcast(): Promise<void> {
    if (this.room.mode !== 'WEBINAR' || !this.canModerate()) return Promise.resolve();
    return this.send(async (active) => {
      const result = await active.startBroadcast();
      if (result.ok && this.connection === active && this.state.phase === 'joined')
        this.armRecorder();
      return result;
    });
  }

  stopBroadcast(): Promise<void> {
    if (this.room.mode !== 'WEBINAR') return Promise.resolve();
    return this.moderate(async (active) => {
      const finished = await this.finishRecorder();
      if (this.connection !== active || this.state.phase !== 'joined') return { ok: true };
      const result = await active.stopBroadcast();
      if (
        this.connection === active &&
        result.ok &&
        !finished.ok &&
        finished.reason !== 'aborted'
      ) {
        this.state.error = unfinishedRecordingMessage(finished.reason);
      }
      return result;
    });
  }

  setStageVideo(socketId: string, element: HTMLVideoElement | null): void {
    const current = this.stageVideos.get(socketId) ?? null;
    if (current === element) return;
    if (element) this.stageVideos.set(socketId, element);
    else this.stageVideos.delete(socketId);
    this.syncRecorder();
  }

  demote(targetSocketId: string): Promise<void> {
    return this.moderate((active) => active.demote(targetSocketId));
  }

  setLock(targetSocketId: string, kind: 'audio' | 'video', locked: boolean): Promise<void> {
    return this.moderate((active) => active.setLock({ targetSocketId, kind, locked }));
  }

  private canModerate(): boolean {
    return (
      this.state.phase === 'joined' &&
      this.selfParticipant()?.role === 'HOST' &&
      !this.state.mediaPending
    );
  }

  private moderate(action: (active: RoomConnection) => Promise<CommandAck>): Promise<void> {
    if (!this.canModerate()) return Promise.resolve();
    return this.send(action);
  }

  startSharing(): Promise<void> {
    if (this.state.phase !== 'joined') return Promise.resolve();
    return this.share.start();
  }

  stopSharing(): Promise<void> {
    return this.share.stop();
  }

  spawnDemo(): Promise<void> {
    if (this.state.phase !== 'joined') return Promise.resolve();
    return this.demos.spawn();
  }

  removeDemos(): void {
    this.demos.stopAll();
    this.emit();
  }

  private async send(action: (active: RoomConnection) => Promise<CommandAck>): Promise<void> {
    const active = this.connection;
    if (!active || this.state.phase !== 'joined') return;
    this.state.mediaPending = true;
    this.state.error = '';
    this.emit();
    try {
      const result = await action(active);
      if (this.connection === active && !result.ok) this.state.error = result.message;
    } catch {
      if (this.connection === active) this.state.error = 'Unable to update the room. Try again.';
    } finally {
      if (this.connection === active) this.state.mediaPending = false;
      this.emit();
    }
  }

  private finishEnded(active: RoomConnection): void {
    if (this.connection !== active) return;
    this.connection = null;
    this.teardownLocal();
    this.state.phase = 'lobby';
    this.emit();
    this.notifyEnded();
  }

  private finishDisconnect(active: RoomConnection): void {
    if (this.connection !== active) return;
    this.connection = null;
    this.teardownLocal();
    this.state.phase = 'lobby';
    this.state.error = 'The live room reset. Join again.';
    this.emit();
  }

  private notifyEnded(): void {
    if (this.endedNotified) return;
    this.endedNotified = true;
    this.onEnded();
  }

  /** Stops local work and keeps the socket for the caller to close. */
  private teardownLocal(): void {
    this.stopRecorder();
    this.stageVideos.clear();
    this.consentSignalingFailed = false;
    this.clearPendingStage();
    this.activationPending = false;
    this.forcedAudio = this.forcedVideo = false;
    this.forceRevision = -1;
    this.generation += 1;
    this.prepareToken += 1;
    this.share.invalidate();
    this.demos.stopAll();
    this.closePeers();
    this.speaker.close();
    this.media.stop();
    this.settled = null;
    this.state.ready = false;
    this.state.preparing = false;
    this.state.mediaPending = false;
    this.state.sharePending = false;
    this.state.sharing = false;
    this.state.needsCaptureConsent = false;
    this.state.role = null;
    this.state.onStage = false;
    this.state.activeSocketId = null;
  }

  private closePeers(): void {
    this.peers?.close();
    this.peers = null;
    this.state.peerManager = null;
    this.state.streams = new Map();
  }

  private syncFromStore(): void {
    const { selfSocketId, snapshot, iceServers } = useRoomStore.getState();
    if (snapshot && snapshot.revision > this.forceRevision) {
      this.forcedAudio = this.forcedVideo = false;
    }
    const self = snapshot?.participants.find(
      (participant) => participant.socketId === selfSocketId,
    );
    if (self && selfSocketId && snapshot) {
      this.observeRole(self.role, snapshot.stageSocketIds.includes(selfSocketId));
    }
    const onStage = Boolean(selfSocketId && snapshot?.stageSocketIds.includes(selfSocketId));
    if (!selfSocketId || !onStage || !this.media.ready || this.state.needsCaptureConsent)
      this.closePeers();
    else if (this.connection && snapshot)
      this.ensurePeers(selfSocketId, snapshot.stageSocketIds, iceServers);
    if (this.peers) {
      const pending = this.pendingStageEvents;
      this.clearPendingStage();
      for (const event of pending) this.receiveStage(event);
    }
    this.applyLocalFlags();
    this.syncSpeaker();
    this.syncRecorder();
    this.emit();
  }

  private observeRole(role: ParticipantRole, onStage: boolean): void {
    const next = { role, onStage };
    const change = roleTransition(this.settled, next);
    this.settled = next;
    this.state.role = role;
    this.state.onStage = onStage;
    if (change === 'initial') this.state.needsCaptureConsent = false;
    if (change === 'promoted') this.onPromoted();
    if (change === 'demoted') this.onDemoted();
  }

  /** Phase 5 can send the role change. Capture waits for a later prepare(). */
  private onPromoted(): void {
    this.state.needsCaptureConsent = !this.media.ready;
  }

  /** Phase 5 demotion lands here. Local camera, microphone, and screen tracks stop. */
  private onDemoted(): void {
    this.consentSignalingFailed = false;
    this.clearPendingStage();
    this.activationPending = false;
    this.state.preparing = false;
    const wasSharing = this.state.sharing;
    this.share.invalidate();
    this.prepareToken += 1;
    this.state.sharing = false;
    this.state.sharePending = false;
    this.state.needsCaptureConsent = false;
    this.state.ready = false;
    this.media.stop();
    this.closePeers();
    this.speaker.close();
    if (wasSharing && this.connection) {
      void this.connection.media({ isScreenSharing: false }).catch(() => undefined);
    }
  }

  private ensurePeers(
    selfSocketId: string,
    stageSocketIds: readonly string[],
    iceServers: IceServer[],
  ): void {
    try {
      if (!this.peers && this.connection) {
        const active = this.connection;
        this.peers = this.createPeers(
          this.media,
          active,
          (streams) => {
            this.state.streams = streams;
            this.syncSpeaker();
            this.syncRecorder();
            this.emit();
          },
          (message) => {
            this.state.error = message;
            this.emit();
          },
        );
        this.state.peerManager = this.peers;
      }
      this.peers?.sync(selfSocketId, stageSocketIds, iceServers);
    } catch {
      this.state.error =
        'Unable to start stage media. You can still use the roster and leave the room.';
    }
  }

  private applyLocalFlags(): void {
    const self = this.selfParticipant();
    const waiting = this.state.needsCaptureConsent || this.activationPending;
    this.media.applyFlags(
      waiting || this.audioLocked || (self?.isAudioMuted ?? this.state.isAudioMuted),
      waiting || this.videoLocked || (self?.isVideoOff ?? this.state.isVideoOff),
    );
  }

  private forceMute({ kind, locked }: StageForceMute): void {
    if (!locked) return;
    this.forceRevision = useRoomStore.getState().snapshot?.revision ?? -1;
    if (kind === 'audio') this.forcedAudio = true;
    else this.forcedVideo = true;
    this.applyLocalFlags();
    this.emit();
  }

  private clearPendingStage(): void {
    this.pendingStageEvents = [];
    this.pendingStageBytes = 0;
  }

  private receiveStage(event: PendingStageEvent): void {
    const { snapshot, selfSocketId } = useRoomStore.getState();
    if (
      !selfSocketId ||
      event.payload.toSocketId !== selfSocketId ||
      !snapshot?.stageSocketIds.includes(selfSocketId) ||
      !snapshot.stageSocketIds.includes(event.payload.fromSocketId)
    )
      return;
    if (this.peers) {
      if (event.type === 'description') this.peers.description(event.payload);
      else this.peers.candidate(event.payload);
      return;
    }
    if (!this.state.needsCaptureConsent || this.consentSignalingFailed) return;
    const bytes = JSON.stringify(event).length;
    if (this.pendingStageEvents.length >= 32 || this.pendingStageBytes + bytes > 256 * 1024) {
      this.clearPendingStage();
      this.consentSignalingFailed = true;
      this.state.error =
        'Stage signaling overflowed while waiting for device consent. Leave and join again.';
      this.emit();
      return;
    }
    this.pendingStageEvents.push(event);
    this.pendingStageBytes += bytes;
  }

  private syncSpeaker(): void {
    const tracks = new Map<string, MediaStreamTrack>();
    const { snapshot, selfSocketId } = useRoomStore.getState();
    if (this.peers && selfSocketId && snapshot?.stageSocketIds.includes(selfSocketId)) {
      for (const id of snapshot.stageSocketIds) {
        const track =
          id === selfSocketId
            ? this.media.microphoneTrack()
            : this.state.streams.get(id)?.getAudioTracks()[0];
        const person = snapshot.participants.find((participant) => participant.socketId === id);
        if (track && !person?.isAudioMuted) tracks.set(id, track);
      }
    }
    try {
      this.speaker.sync(tracks);
    } catch {
      this.speaker.close();
    }
  }

  private selfParticipant(): ParticipantState | null {
    const { snapshot, selfSocketId } = useRoomStore.getState();
    if (!snapshot || !selfSocketId) return null;
    return (
      snapshot.participants.find((participant) => participant.socketId === selfSocketId) ?? null
    );
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private readonly onPageHide = (): void => {
    this.stopRecorder();
  };

  private armRecorder(): void {
    this.armedBroadcast = true;
    this.syncRecorder();
  }

  /** Chunks are accepted only while the broadcast is LIVE, which the start ack already waited for. */
  private syncRecorder(): void {
    const broadcast = useRoomStore.getState().snapshot?.broadcast ?? null;
    if (this.recorder) {
      const live =
        this.state.phase === 'joined' &&
        broadcast?.id === this.recordingId &&
        broadcast.status === 'LIVE';
      if (!live) {
        this.stopRecorder();
        return;
      }
      this.recorder.update(this.stageSources());
      return;
    }
    if (!this.armedBroadcast || this.state.phase !== 'joined' || broadcast?.status !== 'LIVE')
      return;
    this.armedBroadcast = false;
    this.recordingId = broadcast.id;
    try {
      const recorder = this.createRecorder({
        broadcastId: broadcast.id,
        token: this.token,
        onCap: () => this.onRecorderCap(),
      });
      this.recorder = recorder;
      recorder.start();
      recorder.update(this.stageSources());
    } catch {
      this.recorder?.stop();
      this.recorder = null;
      this.recordingId = null;
      const active = this.connection;
      if (active && this.state.phase === 'joined')
        void active.stopBroadcast().catch(() => undefined);
    }
  }

  private onRecorderCap(): void {
    this.stopRecorder();
    void this.moderate((active) => active.stopBroadcast());
  }

  /** Uploads the final blob before the caller sends broadcast:stop. */
  private finishRecorder(): Promise<RecorderFinish> {
    this.armedBroadcast = false;
    const recorder = this.recorder;
    if (!recorder) return Promise.resolve({ ok: true });
    return recorder.finish().finally(() => {
      if (this.recorder === recorder) {
        this.recorder = null;
        this.recordingId = null;
      }
    });
  }

  private stopRecorder(): void {
    this.armedBroadcast = false;
    const recorder = this.recorder;
    this.recorder = null;
    this.recordingId = null;
    recorder?.stop();
  }

  private stageSources(): StageSource[] {
    const { snapshot, selfSocketId } = useRoomStore.getState();
    if (!snapshot || !selfSocketId) return [];
    const sources: StageSource[] = [];
    for (const id of snapshot.stageSocketIds) {
      const person = snapshot.participants.find((participant) => participant.socketId === id);
      if (!person) continue;
      const remote = this.state.streams.get(id)?.getAudioTracks()[0] ?? null;
      sources.push({
        id,
        video: this.stageVideos.get(id) ?? null,
        audioTrack: person.isAudioMuted
          ? null
          : id === selfSocketId
            ? this.media.microphoneTrack()
            : remote,
        muted: person.isAudioMuted,
        screenSharing: person.isScreenSharing || (id === selfSocketId && this.state.sharing),
      });
    }
    return sources;
  }
}

function unfinishedRecordingMessage(reason: 'timeout' | 'upload'): string {
  return reason === 'timeout'
    ? 'The broadcast stopped before the last of the recording uploaded.'
    : 'The broadcast stopped before every recorded chunk was accepted.';
}
