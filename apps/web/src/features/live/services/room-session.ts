import { connectedStageIds, RECONNECT_GRACE_MS } from '@stageflow/shared';
import type {
  CommandAck,
  IceServer,
  ParticipantRole,
  ParticipantState,
  RoomResponse,
  StageForceMute,
  RelayedDescription,
  RelayedIceCandidate,
  ResumeAck,
} from '@stageflow/shared';
import { BroadcastSession, recordingFinishError } from '../../broadcast/services/broadcast-session';
import {
  StageRecorder,
  type BroadcastRecorder,
  type StageSource,
} from '../../broadcast/services/stage-recorder';
import { ActiveSpeaker } from './active-speaker';
import { DemoPeer } from './demo-peer';
import { DemoRegistry, type DemoAudio, type DemoFactory } from './demo-registry';
import { LocalMedia, type DeviceChoices, type InputKind } from './local-media';
import { audioOutputSupported, selectedOutputId, type OutputRouteResult } from './output-route';
import { PeerManager, type RemoteStreams, type TrackSource } from './peer-manager';
import { audienceFor, roleTransition, type StageMembership } from './role-transition';
import { ScreenShareController } from './screen-share';
import { openSignaling, type RoomConnection } from './signaling';
import { useRoomStore } from '../stores/room-store';

export type ConnectionPhase = 'lobby' | 'joining' | 'joined' | 'recovering' | 'leaving';
type PendingStageEvent =
  | { type: 'description'; payload: RelayedDescription }
  | { type: 'candidate'; payload: RelayedIceCandidate };

export type RoomMedia = TrackSource & {
  readonly ready: boolean;
  prepare(video: HTMLVideoElement, choices: DeviceChoices): Promise<boolean>;
  stop(): void;
  releaseLobby(): void;
  applyFlags(isAudioMuted: boolean, isVideoOff: boolean): void;
  replaceInput(kind: InputKind, deviceId: string): Promise<MediaStreamTrack | null>;
  commitInput(kind: InputKind, track: MediaStreamTrack): void;
  abortInput(track: MediaStreamTrack): void;
  setEndedListener(listener: ((kind: InputKind) => void) | null): void;
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
  createSpeaker?: (publish: (participantId: string | null) => void) => RoomSpeaker;
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
 * Broadcast start, sync, finish, and abort belong to BroadcastSession.
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

  private connection: RoomConnection | null = null;
  private peers: PeerManager | null = null;
  private readonly broadcastSession: BroadcastSession;
  private readonly stageVideos = new Map<string, HTMLVideoElement>();
  private unsubscribe: (() => void) | null = null;
  private attached = false;
  private pageHidden = false;
  private locallyTornDown = false;
  private generation = 0;
  private deviceReplacement: Promise<void> = Promise.resolve();
  private readonly inputPending = { camera: 0, microphone: 0 };
  private deviceGeneration = 0;
  private prepareToken = 0;
  private settled: StageMembership | null = null;
  private endedNotified = false;
  private resumeIdentity: { participantId: string; resumeCredential: string } | null = null;
  private recoveryEpoch = 0;
  private recoveryDeadline = 0;
  private recoveryTimers: ReturnType<typeof setTimeout>[] = [];
  private resumedWithoutCapture = false;
  private readonly leaveRequests = new WeakMap<RoomConnection, Promise<CommandAck>>();

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
    cameraUnavailable: boolean;
    microphoneUnavailable: boolean;
    streams: RemoteStreams;
    peerManager: PeerManager | null;
    activeParticipantId: string | null;
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
    speakerId: selectedOutputId(),
    devices: [],
    sinkSupported: audioOutputSupported(),
    isAudioMuted: false,
    isVideoOff: false,
    cameraUnavailable: false,
    microphoneUnavailable: false,
    streams: new Map(),
    peerManager: null,
    activeParticipantId: null,
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
    this.media.setEndedListener((kind) => this.markInputLost(kind));
    this.open = options.openSignaling ?? openSignaling;
    this.createPeers =
      options.createPeers ??
      ((media, connection, publish, onError) =>
        new PeerManager(media, connection, publish, onError));
    this.enumerateDevices =
      options.enumerateDevices ?? (() => navigator.mediaDevices.enumerateDevices());
    this.broadcastSession = new BroadcastSession({
      token: this.token,
      createRecorder: options.createRecorder ?? ((recorder) => new StageRecorder(recorder)),
      stopBroadcast: () => {
        const active = this.connection;
        if (active && this.state.phase === 'joined')
          void active.stopBroadcast().catch(() => undefined);
      },
      onError: (message) => {
        this.state.error = message;
        this.emit();
      },
    });
    const publishSpeaker = (participantId: string | null) => {
      this.state.activeParticipantId = participantId;
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
        this.syncBroadcast();
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
  get cameraUnavailable(): boolean {
    return this.state.cameraUnavailable;
  }
  get microphoneUnavailable(): boolean {
    return this.state.microphoneUnavailable;
  }
  get replacingCamera(): boolean {
    return this.inputPending.camera > 0;
  }
  get replacingMicrophone(): boolean {
    return this.inputPending.microphone > 0;
  }
  get streams(): RemoteStreams {
    return this.state.streams;
  }
  get peerManager(): PeerManager | null {
    return this.state.peerManager;
  }
  get activeParticipantId(): string | null {
    return this.state.activeParticipantId;
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
      this.broadcastSession.active ||
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
    if (typeof window !== 'undefined') {
      window.addEventListener('pagehide', this.onPageHide);
      window.addEventListener('pageshow', this.onPageShow);
    }
    this.deviceEvents()?.addEventListener('devicechange', this.onDeviceChange);
  }

  dispose(): void {
    if (!this.attached) return;
    this.attached = false;
    this.deviceGeneration += 1;
    if (typeof window !== 'undefined') {
      window.removeEventListener('pagehide', this.onPageHide);
      window.removeEventListener('pageshow', this.onPageShow);
    }
    this.deviceEvents()?.removeEventListener('devicechange', this.onDeviceChange);
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.closeSession();
    this.state.phase = 'lobby';
    this.emit();
  }

  async prepare(video: HTMLVideoElement, nextChoices = this.state.choices): Promise<void> {
    if (this.pageHidden || this.state.phase === 'recovering') return;
    if (this.catalogAttendee && !this.state.needsCaptureConsent) return;
    if (this.state.needsCaptureConsent && this.consentSignalingFailed) return;
    this.locallyTornDown = false;
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
      this.state.speakerId = route.deviceId;
      this.state.speakerError = route.ok ? '' : route.message;
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
    this.state.speakerId = route.deviceId;
    this.state.speakerError = route.ok ? '' : route.message;
    this.emit();
  }

  async join(): Promise<void> {
    if (this.pageHidden) return;
    if (this.state.phase !== 'lobby' || this.state.preparing) return;
    if (!this.catalogAttendee && !this.media.ready) {
      this.state.ready = false;
      this.state.error = 'Enable your camera and microphone before joining.';
      this.emit();
      return;
    }
    const generation = this.generation;
    this.cancelRecovery();
    this.resumedWithoutCapture = false;
    this.locallyTornDown = false;
    this.state.phase = 'joining';
    this.state.error = '';
    this.emit();
    const opened: { current: RoomConnection | null } = { current: null };
    let active: RoomConnection | null = null;
    try {
      active = this.open(this.token, this.room.id, this.callbacksFor(opened));
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
      this.resumeIdentity = result.resumeCredential
        ? { participantId: result.participantId, resumeCredential: result.resumeCredential }
        : null;
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
    this.cancelRecovery();
    this.state.phase = 'leaving';
    this.state.error = '';
    this.teardownLocal();
    const generation = this.generation;
    this.emit();
    try {
      if (active) {
        const result = await this.requestLeave(active);
        if (this.connection === active && !result.ok) this.state.error = result.message;
      }
    } catch {
      // Closing the socket below also uses the server's leave path.
    } finally {
      if (this.connection === active) {
        active?.close();
        this.connection = null;
      }
      if (this.attached && generation === this.generation && this.state.phase === 'leaving')
        this.state.phase = 'lobby';
      this.emit();
    }
  }

  toggleAudio(): void {
    if (this.state.phase === 'recovering' || this.audioLocked || this.activationPending) return;
    const self = this.selfParticipant();
    if (self && this.connection && this.state.phase === 'joined') {
      if (this.resumedWithoutCapture && self.isAudioMuted && !this.media.microphoneTrack()) {
        void this.enableResumedInput('microphone');
        return;
      }
      void this.send((active) => active.media({ isAudioMuted: !self.isAudioMuted }));
      return;
    }
    this.state.isAudioMuted = !this.state.isAudioMuted;
    this.applyLocalFlags();
    this.emit();
  }

  toggleVideo(): void {
    if (this.state.phase === 'recovering' || this.videoLocked || this.activationPending) return;
    const self = this.selfParticipant();
    if (self && this.connection && this.state.phase === 'joined') {
      if (this.resumedWithoutCapture && self.isVideoOff && !this.media.cameraTrack()) {
        void this.enableResumedInput('camera');
        return;
      }
      void this.send((active) => active.media({ isVideoOff: !self.isVideoOff }));
      return;
    }
    this.state.isVideoOff = !this.state.isVideoOff;
    this.applyLocalFlags();
    this.emit();
  }

  replaceDevice(kind: InputKind, deviceId: string): Promise<void> {
    this.inputPending[kind] += 1;
    this.emit();
    const run = this.deviceReplacement
      .then(() => this.finishDeviceReplacement(kind, deviceId))
      .finally(() => {
        this.inputPending[kind] -= 1;
        this.emit();
      });
    this.deviceReplacement = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  toggleHand(): void {
    const self = this.selfParticipant();
    if (!self || this.state.phase !== 'joined') return;
    void this.send((active) => active.hand(!self.isHandRaised));
  }

  promote(targetParticipantId: string): Promise<void> {
    return this.moderate((active) => active.promote(targetParticipantId));
  }

  startBroadcast(): Promise<void> {
    if (this.room.mode !== 'WEBINAR' || !this.canModerate()) return Promise.resolve();
    return this.send(async (active) => {
      const result = await active.startBroadcast();
      if (result.ok && this.connection === active && this.state.phase === 'joined') {
        this.broadcastSession.arm();
        this.syncBroadcast();
      }
      return result;
    });
  }

  stopBroadcast(): Promise<void> {
    if (this.room.mode !== 'WEBINAR') return Promise.resolve();
    return this.moderate(async (active) => {
      const finished = await this.broadcastSession.finish();
      if (this.connection !== active || this.state.phase !== 'joined') return { ok: true };
      const result = await active.stopBroadcast();
      if (this.connection === active && result.ok) {
        const message = recordingFinishError(finished);
        if (message) this.state.error = message;
      }
      return result;
    });
  }

  setStageVideo(participantId: string, element: HTMLVideoElement | null): void {
    const current = this.stageVideos.get(participantId) ?? null;
    if (current === element) return;
    if (element) this.stageVideos.set(participantId, element);
    else this.stageVideos.delete(participantId);
    this.syncBroadcast();
  }

  demote(targetParticipantId: string): Promise<void> {
    return this.moderate((active) => active.demote(targetParticipantId));
  }

  setLock(targetParticipantId: string, kind: 'audio' | 'video', locked: boolean): Promise<void> {
    return this.moderate((active) => active.setLock({ targetParticipantId, kind, locked }));
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
    this.cancelRecovery();
    this.teardownLocal();
    this.state.phase = 'lobby';
    this.state.error = 'This room has ended.';
    this.emit();
    this.notifyEnded();
  }

  private finishDisconnect(active: RoomConnection): void {
    if (this.connection !== active) return;
    this.connection = null;
    if (this.state.phase === 'recovering') {
      this.emit();
      return;
    }
    const canResume =
      this.state.phase === 'joined' &&
      this.attached &&
      !this.pageHidden &&
      this.resumeIdentity !== null;
    const role = this.state.role;
    this.teardownLocal();
    if (canResume) {
      this.state.phase = 'recovering';
      this.state.role = role;
      this.state.isAudioMuted = this.state.isVideoOff = true;
      this.state.error = '';
      this.startRecovery();
      this.emit();
      return;
    }
    this.cancelRecovery();
    this.state.phase = 'lobby';
    this.state.error = 'The live room reset. Join again.';
    this.emit();
  }

  private notifyEnded(): void {
    if (this.endedNotified) return;
    this.endedNotified = true;
    this.onEnded();
  }

  private callbacksFor(opened: {
    current: RoomConnection | null;
  }): Parameters<typeof openSignaling>[2] {
    const current = () =>
      opened.current !== null && this.connection === opened.current && !this.pageHidden;
    return {
      onForceMute: (payload) => {
        if (current()) this.forceMute(payload);
      },
      onDescription: (payload) => {
        if (current()) this.receiveStage({ type: 'description', payload });
      },
      onCandidate: (payload) => {
        if (current()) this.receiveStage({ type: 'candidate', payload });
      },
      onEnded: () => {
        if (opened.current) this.finishEnded(opened.current);
      },
      onDisconnect: () => {
        if (opened.current) this.finishDisconnect(opened.current);
      },
    };
  }

  private cancelRecovery(dropCredential = true): void {
    this.recoveryEpoch += 1;
    for (const timer of this.recoveryTimers) clearTimeout(timer);
    this.recoveryTimers = [];
    if (dropCredential) this.resumeIdentity = null;
  }

  private startRecovery(): void {
    this.cancelRecovery(false);
    const epoch = this.recoveryEpoch;
    this.recoveryDeadline = Date.now() + RECONNECT_GRACE_MS;
    for (const delay of [1000, 2000, 4000])
      this.recoveryTimers.push(
        setTimeout(() => {
          void this.resumeAttempt(epoch);
        }, delay),
      );
    this.recoveryTimers.push(
      setTimeout(() => {
        if (epoch === this.recoveryEpoch)
          this.failRecovery('The connection was gone too long. Join again.');
      }, RECONNECT_GRACE_MS),
    );
    void this.resumeAttempt(epoch);
  }

  private async resumeAttempt(epoch: number): Promise<void> {
    if (
      epoch !== this.recoveryEpoch ||
      this.state.phase !== 'recovering' ||
      !this.resumeIdentity ||
      this.pageHidden ||
      !this.attached
    )
      return;
    if (Date.now() >= this.recoveryDeadline) {
      this.failRecovery('The connection was gone too long. Join again.');
      return;
    }
    const identity = this.resumeIdentity;
    const previous = this.connection;
    this.connection = null;
    previous?.close();
    const opened: { current: RoomConnection | null } = { current: null };
    let active: RoomConnection | null = null;
    try {
      active = this.open(this.token, this.room.id, {
        ...this.callbacksFor(opened),
        onResumed: (result) => {
          if (opened.current) this.completeResume(opened.current, result, epoch);
        },
      });
      opened.current = active;
      this.connection = active;
      const result = await active.resume({ roomId: this.room.id, ...identity });
      if (result.ok) {
        this.completeResume(active, result, epoch);
        return;
      }
      if (epoch !== this.recoveryEpoch || this.connection !== active) return;
      const message =
        result.error === 'participant_not_found'
          ? 'The live room reset. Join again.'
          : result.error === 'room_ended'
            ? 'This room has ended.'
            : 'The connection was gone too long. Join again.';
      this.failRecovery(message);
      if (result.error === 'room_ended') this.notifyEnded();
    } catch {
      active?.close();
      if (this.connection === active) this.connection = null;
      // The next attempt keeps its absolute schedule. The final attempt may wait until grace ends.
    }
  }

  private completeResume(
    active: RoomConnection,
    result: Extract<ResumeAck, { ok: true }>,
    epoch: number,
  ): void {
    if (this.connection === active && this.state.phase === 'joined') return;
    if (
      epoch === this.recoveryEpoch &&
      this.connection === active &&
      this.state.phase === 'recovering' &&
      Date.now() >= this.recoveryDeadline
    ) {
      void this.requestLeave(active).catch(() => undefined);
      this.failRecovery('The connection was gone too long. Join again.');
      return;
    }
    if (
      epoch !== this.recoveryEpoch ||
      this.connection !== active ||
      this.state.phase !== 'recovering' ||
      this.pageHidden ||
      !this.attached
    ) {
      void this.requestLeave(active).then(
        () => active.close(),
        () => active.close(),
      );
      return;
    }
    this.cancelRecovery(false);
    this.locallyTornDown = false;
    this.resumedWithoutCapture = true;
    this.state.isAudioMuted = this.state.isVideoOff = true;
    this.state.sharing = false;
    this.state.needsCaptureConsent = false;
    this.state.error = '';
    // Atomic baseline replacement also supports test and alternate signaling adapters.
    useRoomStore.getState().resumed(result.participantId, result.iceServers, result.snapshot);
    this.state.phase = 'joined';
    this.syncFromStore();
  }

  private failRecovery(message: string): void {
    const active = this.connection;
    this.connection = null;
    this.cancelRecovery();
    active?.close();
    this.teardownLocal();
    this.state.phase = 'lobby';
    this.state.error = message;
    this.emit();
  }

  private requestLeave(active: RoomConnection): Promise<CommandAck> {
    const pending = this.leaveRequests.get(active);
    if (pending) return pending;
    const result = active.leave();
    this.leaveRequests.set(active, result);
    return result;
  }

  private async enableResumedInput(kind: InputKind): Promise<void> {
    const generation = this.generation;
    const active = this.connection;
    this.activationPending = true;
    this.emit();
    try {
      await this.replaceDevice(
        kind,
        kind === 'camera' ? this.state.choices.cameraId : this.state.choices.microphoneId,
      );
      if (
        generation !== this.generation ||
        this.connection !== active ||
        this.state.phase !== 'joined'
      )
        return;
      const track = kind === 'camera' ? this.media.cameraTrack() : this.media.microphoneTrack();
      const locked = kind === 'camera' ? this.videoLocked : this.audioLocked;
      if (track && !locked)
        await this.send((connection) =>
          connection.media(kind === 'camera' ? { isVideoOff: false } : { isAudioMuted: false }),
        );
    } catch (failure) {
      if (generation === this.generation && this.connection === active)
        this.state.error =
          failure instanceof Error ? failure.message : this.deviceSwitchError(kind);
    } finally {
      if (generation === this.generation) {
        this.activationPending = false;
        this.applyLocalFlags();
        this.emit();
      }
    }
  }

  /** Stops local work and keeps the socket for the caller to close. */
  private teardownLocal(): void {
    this.state.role = null;
    this.state.onStage = false;
    this.settled = null;
    this.resumedWithoutCapture = false;
    if (this.locallyTornDown) return;
    this.locallyTornDown = true;
    this.generation += 1;
    this.broadcastSession.abort();
    this.stageVideos.clear();
    this.consentSignalingFailed = false;
    this.clearPendingStage();
    this.activationPending = false;
    this.forcedAudio = this.forcedVideo = false;
    this.forceRevision = -1;
    this.prepareToken += 1;
    this.share.invalidate();
    this.demos.stopAll();
    this.closePeers();
    this.speaker.close();
    this.media.stop();
    this.state.cameraUnavailable = false;
    this.state.microphoneUnavailable = false;
    this.settled = null;
    this.state.ready = false;
    this.state.preparing = false;
    this.state.mediaPending = false;
    this.state.sharePending = false;
    this.state.sharing = false;
    this.state.needsCaptureConsent = false;
    this.state.role = null;
    this.state.onStage = false;
    this.state.activeParticipantId = null;
  }

  private closePeers(): void {
    this.peers?.close();
    this.peers = null;
    this.state.peerManager = null;
    this.state.streams = new Map();
  }

  private syncFromStore(): void {
    if (this.pageHidden || !this.connection || this.state.phase === 'recovering') return;
    const { selfParticipantId, snapshot, iceServers } = useRoomStore.getState();
    if (snapshot && snapshot.revision > this.forceRevision) {
      this.forcedAudio = this.forcedVideo = false;
    }
    const self = snapshot?.participants.find(
      (participant) => participant.participantId === selfParticipantId,
    );
    if (self && selfParticipantId && snapshot) {
      this.observeRole(self.role, snapshot.stageParticipantIds.includes(selfParticipantId));
    }
    const onStage = Boolean(
      selfParticipantId && snapshot?.stageParticipantIds.includes(selfParticipantId),
    );
    if (
      !selfParticipantId ||
      !onStage ||
      (!this.media.ready && !this.resumedWithoutCapture) ||
      this.state.needsCaptureConsent
    )
      this.closePeers();
    else if (this.connection && snapshot)
      this.ensurePeers(selfParticipantId, connectedStageIds(snapshot), iceServers);
    if (this.peers) {
      const pending = this.pendingStageEvents;
      this.clearPendingStage();
      for (const event of pending) this.receiveStage(event);
    }
    this.applyLocalFlags();
    this.syncSpeaker();
    this.syncBroadcast();
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
    this.generation += 1;
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
    this.state.cameraUnavailable = false;
    this.state.microphoneUnavailable = false;
    this.closePeers();
    this.speaker.close();
    if (wasSharing && this.connection) {
      void this.connection.media({ isScreenSharing: false }).catch(() => undefined);
    }
  }

  private ensurePeers(
    selfParticipantId: string,
    stageParticipantIds: readonly string[],
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
            this.syncBroadcast();
            this.emit();
          },
          (message) => {
            this.state.error = message;
            this.emit();
          },
        );
        this.state.peerManager = this.peers;
      }
      this.peers?.sync(selfParticipantId, stageParticipantIds, iceServers);
    } catch {
      this.state.error =
        'Unable to start stage media. You can still use the roster and leave the room.';
    }
  }

  private applyLocalFlags(): void {
    this.media.applyFlags(this.mutedCapture(), this.videoOffCapture());
  }

  private canReplaceDevice(): boolean {
    return (
      this.state.phase === 'joined' &&
      this.state.onStage &&
      !this.state.needsCaptureConsent &&
      this.audience !== 'attendee'
    );
  }

  private async finishDeviceReplacement(kind: InputKind, deviceId: string): Promise<void> {
    if (!this.canReplaceDevice()) return;
    const generation = this.generation;
    this.applyLocalFlags();
    let track: MediaStreamTrack | null;
    try {
      track = await this.media.replaceInput(kind, deviceId);
    } catch (failure) {
      if (generation !== this.generation || !this.canReplaceDevice()) return;
      this.state.error = failure instanceof Error ? failure.message : this.deviceSwitchError(kind);
      this.emit();
      return;
    }
    if (!track || generation !== this.generation || !this.canReplaceDevice()) {
      if (track) this.media.abortInput(track);
      return;
    }
    this.applyHeldFlag(kind, track);
    const screen = this.media.screenTrack();
    if (kind === 'camera' && screen?.readyState === 'live') {
      this.commitReplacedInput(kind, track, deviceId);
      return;
    }
    const previous =
      kind === 'microphone' ? this.media.microphoneTrack() : this.media.cameraTrack();
    try {
      await this.replaceSender(kind, track);
    } catch (failure) {
      if (generation !== this.generation || !this.canReplaceDevice()) {
        this.media.abortInput(track);
        return;
      }
      await this.rollbackSender(kind, track, previous, failure);
      return;
    }
    if (generation !== this.generation || !this.canReplaceDevice()) {
      this.media.abortInput(track);
      return;
    }
    this.commitReplacedInput(kind, track, deviceId);
  }

  private commitReplacedInput(kind: InputKind, track: MediaStreamTrack, deviceId: string): void {
    this.media.commitInput(kind, track);
    if (kind === 'microphone') this.state.microphoneUnavailable = false;
    else this.state.cameraUnavailable = false;
    this.state.choices =
      kind === 'camera'
        ? { cameraId: deviceId, microphoneId: this.state.choices.microphoneId }
        : { cameraId: this.state.choices.cameraId, microphoneId: deviceId };
    this.state.error = '';
    this.syncSpeaker();
    this.syncBroadcast();
    this.emit();
  }

  private async replaceSender(kind: InputKind, track: MediaStreamTrack | null): Promise<void> {
    const peers = this.peers;
    if (!peers) return;
    if (kind === 'microphone') await peers.replaceAudioTrack(track);
    else await peers.replaceVideoTrack(track);
  }

  private async rollbackSender(
    kind: InputKind,
    track: MediaStreamTrack,
    previous: MediaStreamTrack | null,
    failure: unknown,
  ): Promise<void> {
    try {
      await this.replaceSender(kind, previous);
    } catch {
      this.media.abortInput(track);
      this.forceRevision = useRoomStore.getState().snapshot?.revision ?? this.forceRevision;
      if (kind === 'microphone') this.forcedAudio = true;
      else this.forcedVideo = true;
      this.applyLocalFlags();
      this.state.error = this.disabledDeviceError(kind);
      this.emit();
      return;
    }
    this.media.abortInput(track);
    this.state.error = failure instanceof Error ? failure.message : this.deviceSwitchError(kind);
    this.emit();
  }

  private applyHeldFlag(kind: InputKind, track: MediaStreamTrack): void {
    track.enabled = kind === 'microphone' ? !this.mutedCapture() : !this.videoOffCapture();
  }

  private mutedCapture(): boolean {
    const self = this.selfParticipant();
    const waiting = this.state.needsCaptureConsent || this.activationPending;
    return (
      waiting ||
      this.audioLocked ||
      this.state.microphoneUnavailable ||
      (self?.isAudioMuted ?? this.state.isAudioMuted)
    );
  }

  private videoOffCapture(): boolean {
    const self = this.selfParticipant();
    const waiting = this.state.needsCaptureConsent || this.activationPending;
    return (
      waiting ||
      this.videoLocked ||
      this.state.cameraUnavailable ||
      (self?.isVideoOff ?? this.state.isVideoOff)
    );
  }

  private markInputLost(kind: InputKind): void {
    if (!this.attached || this.pageHidden || this.state.phase === 'leaving') return;
    if (kind === 'microphone' ? this.state.microphoneUnavailable : this.state.cameraUnavailable) {
      return;
    }
    if (kind === 'microphone') {
      this.state.microphoneUnavailable = true;
      this.state.isAudioMuted = true;
    } else {
      this.state.cameraUnavailable = true;
      this.state.isVideoOff = true;
    }
    this.applyLocalFlags();
    this.emit();
    if (this.state.phase !== 'joined' || !this.state.onStage) return;
    const patch = kind === 'microphone' ? { isAudioMuted: true } : { isVideoOff: true };
    void this.send((active) => active.media(patch));
  }

  private readonly onDeviceChange = (): void => {
    if (!this.attached || this.pageHidden || this.state.phase === 'leaving') return;
    void this.refreshDevices();
  };

  private deviceEvents(): MediaDevices | null {
    if (typeof navigator === 'undefined' || navigator.mediaDevices == null) return null;
    const devices = navigator.mediaDevices;
    if (typeof devices.addEventListener !== 'function') return null;
    return devices;
  }

  private async refreshDevices(): Promise<void> {
    const generation = this.generation;
    const request = ++this.deviceGeneration;
    let devices: MediaDeviceInfo[];
    try {
      devices = await this.enumerateDevices();
    } catch {
      return;
    }
    if (
      !this.attached ||
      this.pageHidden ||
      generation !== this.generation ||
      request !== this.deviceGeneration
    ) {
      return;
    }
    this.state.devices = devices;
    this.noteMissingDevices(devices);
    this.emit();
  }

  private noteMissingDevices(devices: MediaDeviceInfo[]): void {
    if (this.inputMissing('camera', devices)) this.markInputLost('camera');
    if (this.inputMissing('microphone', devices)) this.markInputLost('microphone');
  }

  private inputMissing(kind: InputKind, devices: MediaDeviceInfo[]): boolean {
    const id = kind === 'camera' ? this.state.choices.cameraId : this.state.choices.microphoneId;
    // An empty id is the browser default. Only its ended event is loss.
    if (!id) return false;
    const deviceKind = kind === 'camera' ? 'videoinput' : 'audioinput';
    return !devices.some((device) => device.kind === deviceKind && device.deviceId === id);
  }

  private deviceSwitchError(kind: InputKind): string {
    return kind === 'microphone'
      ? 'Unable to switch your microphone. Try again.'
      : 'Unable to switch your camera. Try again.';
  }

  private disabledDeviceError(kind: InputKind): string {
    return kind === 'microphone'
      ? 'Unable to switch your microphone. The microphone is off until you choose another.'
      : 'Unable to switch your camera. The camera is off until you choose another.';
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
    const { snapshot, selfParticipantId } = useRoomStore.getState();
    if (
      !selfParticipantId ||
      event.payload.toParticipantId !== selfParticipantId ||
      !(snapshot && connectedStageIds(snapshot).includes(selfParticipantId)) ||
      !connectedStageIds(snapshot).includes(event.payload.fromParticipantId)
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
    const { snapshot, selfParticipantId } = useRoomStore.getState();
    if (
      this.peers &&
      selfParticipantId &&
      snapshot?.stageParticipantIds.includes(selfParticipantId)
    ) {
      for (const id of connectedStageIds(snapshot)) {
        const track =
          id === selfParticipantId
            ? this.media.microphoneTrack()
            : this.state.streams.get(id)?.getAudioTracks()[0];
        const person = snapshot.participants.find(
          (participant) => participant.participantId === id,
        );
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
    const { snapshot, selfParticipantId } = useRoomStore.getState();
    if (!snapshot || !selfParticipantId) return null;
    return (
      snapshot.participants.find(
        (participant) => participant.participantId === selfParticipantId,
      ) ?? null
    );
  }

  private emit(): void {
    for (const listener of this.listeners) listener();
  }

  private readonly onPageHide = (): void => {
    if (this.pageHidden) return;
    this.pageHidden = true;
    // No unload acknowledgements or uploads: server disconnect/producer loss owns finalization.
    this.closeSession();
    this.state.phase = 'lobby';
    this.emit();
  };

  private readonly onPageShow = (): void => {
    if (!this.pageHidden) return;
    this.pageHidden = false;
    this.state.error = 'You left the live room when this page was hidden. Join again.';
    this.emit();
  };

  /** Clear ownership before closing so synchronous callbacks cannot restore old state. */
  private closeSession(): void {
    const active = this.connection;
    this.connection = null;
    this.cancelRecovery();
    this.teardownLocal();
    active?.close();
  }

  private syncBroadcast(): void {
    this.broadcastSession.sync({
      joined: this.state.phase === 'joined',
      broadcast: useRoomStore.getState().snapshot?.broadcast ?? null,
      sources: () => this.stageSources(),
    });
  }

  private stageSources(): StageSource[] {
    const { snapshot, selfParticipantId } = useRoomStore.getState();
    if (!snapshot || !selfParticipantId) return [];
    const sources: StageSource[] = [];
    for (const id of connectedStageIds(snapshot)) {
      const person = snapshot.participants.find((participant) => participant.participantId === id);
      if (!person) continue;
      const remote = this.state.streams.get(id)?.getAudioTracks()[0] ?? null;
      sources.push({
        id,
        video: this.stageVideos.get(id) ?? null,
        audioTrack: person.isAudioMuted
          ? null
          : id === selfParticipantId
            ? this.media.microphoneTrack()
            : remote,
        muted: person.isAudioMuted,
        screenSharing: person.isScreenSharing || (id === selfParticipantId && this.state.sharing),
      });
    }
    return sources;
  }
}
