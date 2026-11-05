import type { LocalMedia, DeviceChoices, InputKind } from './local-media';
import {
  audioOutputSupported,
  selectedOutputId,
  subscribeAudioOutput,
  type OutputRouteResult,
} from './output-route';

export type InCallDeviceMedia = Pick<
  LocalMedia,
  | 'microphoneTrack'
  | 'cameraTrack'
  | 'screenTrack'
  | 'replaceInput'
  | 'commitInput'
  | 'abortInput'
  | 'setEndedListener'
  | 'setSpeaker'
>;

export type InCallDeviceHost = {
  active(): boolean;
  canReplace(): boolean;
  muted(kind: InputKind): boolean;
  applyFlags(): void;
  replaceSender(kind: InputKind, track: MediaStreamTrack | null): Promise<void>;
  committed(): void;
  disableInput(kind: InputKind): void;
  inputLost(kind: InputKind): void;
  setError(message: string): void;
};

export type InCallDeviceSnapshot = Readonly<{
  choices: DeviceChoices;
  devices: MediaDeviceInfo[];
  speakerId: string;
  speakerError: string;
  sinkSupported: boolean;
  cameraUnavailable: boolean;
  microphoneUnavailable: boolean;
  replacingCamera: boolean;
  replacingMicrophone: boolean;
}>;

export function deviceSwitchError(kind: InputKind): string {
  return kind === 'microphone'
    ? 'Unable to switch your microphone. Try again.'
    : 'Unable to switch your camera. Try again.';
}

function disabledDeviceError(kind: InputKind): string {
  return kind === 'microphone'
    ? 'Unable to switch your microphone. The microphone is off until you choose another.'
    : 'Unable to switch your camera. The camera is off until you choose another.';
}

/** Owns device operations and their cancellation; capture and RTP senders stay with their owners. */
export class InCallDeviceController {
  private state: InCallDeviceSnapshot = {
    choices: { cameraId: '', microphoneId: '' },
    devices: [],
    speakerId: selectedOutputId(),
    speakerError: '',
    sinkSupported: audioOutputSupported(),
    cameraUnavailable: false,
    microphoneUnavailable: false,
    replacingCamera: false,
    replacingMicrophone: false,
  };
  private readonly listeners = new Set<() => void>();
  private generation = 0;
  private enumerationRequest = 0;
  private replacement: Promise<void> = Promise.resolve();
  private readonly pending = { camera: 0, microphone: 0 };
  private attached = false;
  private events: MediaDevices | null = null;
  private unsubscribeOutput: (() => void) | null = null;

  constructor(
    private readonly media: InCallDeviceMedia,
    private readonly host: InCallDeviceHost,
    private readonly enumerateDevices: () => Promise<MediaDeviceInfo[]> = () =>
      navigator.mediaDevices.enumerateDevices(),
  ) {
    media.setEndedListener((kind) => this.markInputLost(kind));
  }

  readonly getSnapshot = (): InCallDeviceSnapshot => this.state;
  readonly subscribe = (listener: () => void): (() => void) => {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  };

  attach(): void {
    if (this.attached) return;
    this.attached = true;
    this.unsubscribeOutput = subscribeAudioOutput((result) => {
      if (this.available()) this.applyOutput(result);
    });
    if (
      typeof navigator !== 'undefined' &&
      typeof navigator.mediaDevices?.addEventListener === 'function'
    ) {
      this.events = navigator.mediaDevices;
      this.events.addEventListener('devicechange', this.onDeviceChange);
    }
  }

  dispose(): void {
    this.attached = false;
    this.generation += 1;
    this.enumerationRequest += 1;
    this.events?.removeEventListener('devicechange', this.onDeviceChange);
    this.events = null;
    this.unsubscribeOutput?.();
    this.unsubscribeOutput = null;
  }

  /** The room calls this after stopping capture on leave, demotion, disconnect, or page exit. */
  reset(): void {
    this.generation += 1;
    this.enumerationRequest += 1;
    this.update({ cameraUnavailable: false, microphoneUnavailable: false });
  }

  beginPreparation(choices: DeviceChoices): void {
    this.enumerationRequest += 1;
    this.update({ choices, speakerError: '' });
  }

  async enumerateForPreparation(): Promise<void> {
    const generation = this.generation;
    const request = ++this.enumerationRequest;
    // Permission/preparation failures still belong to the green-room operation.
    const devices = await this.enumerateDevices();
    if (generation === this.generation && request === this.enumerationRequest)
      this.update({ devices });
  }

  async setSpeaker(deviceId: string, current: () => boolean = () => true): Promise<void> {
    const generation = this.generation;
    const route = await this.media.setSpeaker(deviceId);
    if (generation === this.generation && current()) this.applyOutput(route);
  }

  async refresh(): Promise<void> {
    const generation = this.generation;
    const request = ++this.enumerationRequest;
    let devices: MediaDeviceInfo[];
    try {
      devices = await this.enumerateDevices();
    } catch {
      return;
    }
    if (!this.available() || generation !== this.generation || request !== this.enumerationRequest)
      return;
    this.update({ devices });
    if (this.inputMissing('camera', devices)) this.markInputLost('camera');
    if (this.inputMissing('microphone', devices)) this.markInputLost('microphone');
  }

  replace(kind: InputKind, deviceId: string): Promise<void> {
    const generation = this.generation;
    this.pending[kind] += 1;
    this.publishPending(kind);
    const run = this.replacement
      .then(async () => {
        // A queued user action belongs to its original membership, just like an active capture.
        if (generation === this.generation) await this.finishReplacement(kind, deviceId);
      })
      .finally(() => {
        this.pending[kind] -= 1;
        this.publishPending(kind);
      });
    this.replacement = run.then(
      () => undefined,
      () => undefined,
    );
    return run;
  }

  private async finishReplacement(kind: InputKind, deviceId: string): Promise<void> {
    if (!this.host.canReplace()) return;
    const generation = this.generation;
    const valid = () => generation === this.generation && this.host.canReplace();
    this.host.applyFlags();
    let track: MediaStreamTrack | null;
    try {
      track = await this.media.replaceInput(kind, deviceId);
    } catch (failure) {
      if (valid())
        this.host.setError(failure instanceof Error ? failure.message : deviceSwitchError(kind));
      return;
    }
    if (!track || !valid()) {
      if (track) this.media.abortInput(track);
      return;
    }
    track.enabled = !this.host.muted(kind);
    if (kind === 'camera' && this.media.screenTrack()?.readyState === 'live') {
      this.commit(kind, track, deviceId);
      return;
    }
    const previous =
      kind === 'microphone' ? this.media.microphoneTrack() : this.media.cameraTrack();
    try {
      await this.host.replaceSender(kind, track);
    } catch (failure) {
      if (!valid()) {
        this.media.abortInput(track);
        return;
      }
      await this.rollback(kind, track, previous, failure, valid);
      return;
    }
    if (!valid()) {
      this.media.abortInput(track);
      return;
    }
    this.commit(kind, track, deviceId);
  }

  private commit(kind: InputKind, track: MediaStreamTrack, deviceId: string): void {
    this.media.commitInput(kind, track);
    this.update(
      kind === 'camera'
        ? { cameraUnavailable: false, choices: { ...this.state.choices, cameraId: deviceId } }
        : {
            microphoneUnavailable: false,
            choices: { ...this.state.choices, microphoneId: deviceId },
          },
    );
    this.host.committed();
  }

  private async rollback(
    kind: InputKind,
    track: MediaStreamTrack,
    previous: MediaStreamTrack | null,
    failure: unknown,
    valid: () => boolean,
  ): Promise<void> {
    try {
      await this.host.replaceSender(kind, previous);
    } catch {
      this.media.abortInput(track);
      if (!valid()) return;
      this.host.disableInput(kind);
      this.host.applyFlags();
      this.host.setError(disabledDeviceError(kind));
      return;
    }
    this.media.abortInput(track);
    if (valid())
      this.host.setError(failure instanceof Error ? failure.message : deviceSwitchError(kind));
  }

  private markInputLost(kind: InputKind): void {
    if (!this.available()) return;
    const key = kind === 'microphone' ? 'microphoneUnavailable' : 'cameraUnavailable';
    if (this.state[key]) return;
    this.update({ [key]: true });
    this.host.inputLost(kind);
  }

  private inputMissing(kind: InputKind, devices: MediaDeviceInfo[]): boolean {
    const id = kind === 'camera' ? this.state.choices.cameraId : this.state.choices.microphoneId;
    if (!id) return false;
    const deviceKind = kind === 'camera' ? 'videoinput' : 'audioinput';
    return !devices.some((device) => device.kind === deviceKind && device.deviceId === id);
  }

  private available(): boolean {
    return this.attached && this.host.active();
  }

  private readonly onDeviceChange = (): void => {
    if (this.available()) void this.refresh();
  };

  private publishPending(kind: InputKind): void {
    this.update(
      kind === 'camera'
        ? { replacingCamera: this.pending.camera > 0 }
        : { replacingMicrophone: this.pending.microphone > 0 },
    );
  }

  private applyOutput(route: OutputRouteResult): void {
    this.update({
      sinkSupported: route.supported,
      speakerId: route.deviceId,
      speakerError: route.ok ? '' : route.message,
    });
  }

  private update(patch: Partial<InCallDeviceSnapshot>): void {
    if (
      Object.entries(patch).every(
        ([key, value]) => this.state[key as keyof InCallDeviceSnapshot] === value,
      )
    )
      return;
    this.state = { ...this.state, ...patch };
    for (const listener of this.listeners) listener();
  }
}
