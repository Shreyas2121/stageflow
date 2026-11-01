import { nextDemoPeerName, type ParticipantRole } from '@stageflow/shared';
import type { RoomConnection } from './signaling';

export type DemoAudio = {
  state: AudioContextState;
  resume(): Promise<void>;
  close(): Promise<void>;
};

export type DemoHandle = {
  start(roomId: string): Promise<void>;
  stop(): void;
};

export type DemoFactory = (
  name: string,
  context: DemoAudio,
  onError: (message: string) => void,
  onStopped: () => void,
) => DemoHandle;

export type DemoRegistryHost = {
  readonly generation: number;
  readonly connection: RoomConnection | null;
  readonly roomId: string;
  role(): ParticipantRole | null;
  setError(message: string): void;
  emit(): void;
  createDemo: DemoFactory;
  createAudioContext(): DemoAudio;
};

export class DemoRegistry {
  count = 0;
  starting = false;
  private peers = new Map<string, DemoHandle>();
  private version = 0;
  private pending = false;

  constructor(private readonly host: DemoRegistryHost) {}

  stopAll(): void {
    this.version += 1;
    this.pending = false;
    const running = [...this.peers.values()];
    this.peers.clear();
    for (const peer of running) peer.stop();
    this.count = 0;
    this.starting = false;
  }

  async spawn(): Promise<void> {
    const active = this.host.connection;
    if (!active || this.host.role() !== 'HOST' || this.pending) return;
    const name = nextDemoPeerName(this.peers.keys());
    if (!name) return;
    const generation = this.host.generation;
    const version = ++this.version;
    const valid = () =>
      generation === this.host.generation &&
      version === this.version &&
      this.host.connection === active;
    this.pending = true;
    this.starting = true;
    this.host.setError('');
    this.host.emit();
    let demo: DemoHandle | null = null;
    try {
      const context = this.host.createAudioContext();
      demo = this.host.createDemo(
        name,
        context,
        (message) => {
          if (valid()) this.host.setError(message);
        },
        () => {
          if (this.peers.get(name) !== demo) return;
          this.peers.delete(name);
          this.count = this.peers.size;
          this.host.emit();
        },
      );
      this.peers.set(name, demo);
      this.count = this.peers.size;
      this.host.emit();
      await context.resume();
      if (!valid()) {
        demo.stop();
        return;
      }
      await demo.start(this.host.roomId);
    } catch (failure) {
      demo?.stop();
      if (valid()) {
        this.host.setError(
          failure instanceof Error ? failure.message : 'Unable to start a demo peer.',
        );
      }
    } finally {
      if (version === this.version) {
        this.pending = false;
        this.starting = false;
        this.host.emit();
      }
    }
  }
}
