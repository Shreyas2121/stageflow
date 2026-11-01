import type { RoomConnection } from './signaling';

export type ScreenShareMedia = {
  cameraTrack(): MediaStreamTrack | null;
  screenTrack(): MediaStreamTrack | null;
  startScreenShare(): Promise<MediaStreamTrack>;
  stopScreenShare(): void;
};

export type ScreenSharePeers = {
  replaceVideoTrack(track: MediaStreamTrack | null): Promise<void>;
};

export type ScreenShareHost = {
  readonly generation: number;
  readonly connection: RoomConnection | null;
  readonly peers: ScreenSharePeers | null;
  readonly media: ScreenShareMedia;
  onStage(): boolean;
  setSharing(sharing: boolean): void;
  setPending(pending: boolean): void;
  setError(message: string): void;
};

export class ScreenShareController {
  private version = 0;

  constructor(private readonly host: ScreenShareHost) {}

  /** Drops an in-flight share. The caller stops the captured track. */
  invalidate(): void {
    this.version += 1;
  }

  async start(): Promise<void> {
    const active = this.host.connection;
    const manager = this.host.peers;
    if (!active || !manager || !this.host.onStage()) return;
    const generation = this.host.generation;
    const version = ++this.version;
    const valid = () =>
      generation === this.host.generation &&
      version === this.version &&
      this.host.connection === active &&
      this.host.peers === manager;
    let track: MediaStreamTrack | undefined;
    let announced = false;
    this.host.setPending(true);
    this.host.setError('');
    try {
      track = await this.host.media.startScreenShare();
      if (!valid()) return;
      track.onended = () => {
        void this.stop(track);
      };
      await manager.replaceVideoTrack(track);
      if (!valid()) return;
      this.host.setSharing(true);
      announced = true;
      const result = await active.media({ isScreenSharing: true });
      if (!result.ok) throw new Error(result.message);
    } catch (failure) {
      if (!valid()) return;
      if (track) {
        try {
          await manager.replaceVideoTrack(this.host.media.cameraTrack());
        } catch {
          // The error below leaves the roster and leave action available.
        }
        if (!valid()) return;
        this.host.media.stopScreenShare();
        this.host.setSharing(false);
      }
      if (announced) await active.media({ isScreenSharing: false }).catch(() => undefined);
      if (valid()) {
        this.host.setError(
          failure instanceof Error ? failure.message : 'Unable to share your screen. Try again.',
        );
      }
    } finally {
      if (valid()) this.host.setPending(false);
    }
  }

  async stop(
    expectedTrack: MediaStreamTrack | null = this.host.media.screenTrack(),
  ): Promise<void> {
    if (this.host.media.screenTrack() !== expectedTrack) return;
    const active = this.host.connection;
    const manager = this.host.peers;
    const generation = this.host.generation;
    const version = ++this.version;
    if (expectedTrack) expectedTrack.onended = null;
    this.host.setPending(true);
    this.host.setError('');
    try {
      await manager?.replaceVideoTrack(this.host.media.cameraTrack());
    } catch {
      if (generation === this.host.generation) {
        this.host.setError('Unable to restore your camera. Leave and join again to retry.');
      }
    } finally {
      if (this.host.media.screenTrack() === expectedTrack) this.host.media.stopScreenShare();
    }
    if (generation !== this.host.generation || version !== this.version) return;
    this.host.setSharing(false);
    try {
      if (active && this.host.connection === active) {
        const result = await active.media({ isScreenSharing: false });
        if (!result.ok && generation === this.host.generation) this.host.setError(result.message);
      }
    } catch {
      if (generation === this.host.generation) {
        this.host.setError('Screen sharing stopped, but the room could not be updated.');
      }
    } finally {
      if (generation === this.host.generation) this.host.setPending(false);
    }
  }
}
