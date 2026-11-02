import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import { buildHlsArgs, type ChunkHistory } from '@stageflow/shared';

export type FfmpegExit = { code: number | null; error: string; premature: boolean };
export type SpawnFfmpeg = (binary: string, args: string[]) => ChildProcessWithoutNullStreams;

/** One instance owns one child. It can never restart that child. */
export class FfmpegSupervisor {
  history: ChunkHistory = { nextExpected: 0, acceptedHashes: new Map() };
  writing = false;
  outcome: FfmpegExit | undefined;
  private child: ChildProcessWithoutNullStreams | undefined;
  private started = false;
  private stopping = false;
  private stderr = '';
  private complete!: (exit: FfmpegExit) => void;
  readonly done = new Promise<FfmpegExit>((resolve) => {
    this.complete = resolve;
  });

  constructor(
    readonly binary: string,
    private readonly spawnChild: SpawnFfmpeg = (binary, args) =>
      spawn(binary, args, { windowsHide: true }),
    private readonly stopTimeoutMs = 10_000,
    private readonly writeTimeoutMs = 5_000,
  ) {}

  private settle(code: number | null): void {
    if (this.outcome) return;
    this.outcome = { code, error: this.stderr, premature: !this.stopping };
    this.complete(this.outcome);
  }

  async start(outputDir: string): Promise<void> {
    if (this.started) throw new Error('FFmpeg has already been started.');
    this.started = true;
    await new Promise<void>((resolve, reject) => {
      const child = this.spawnChild(this.binary, buildHlsArgs(outputDir));
      this.child = child;
      const timer = setTimeout(() => {
        this.stderr = `FFmpeg ${this.binary} did not spawn.`.slice(-2000);
        child.kill('SIGKILL');
        this.settle(null);
        reject(new Error(this.stderr));
      }, 5000);
      child.stdout.resume();
      child.stderr.on('data', (data: Buffer) => {
        this.stderr = (this.stderr + data.toString()).slice(-2000);
      });
      child.once('spawn', () => {
        clearTimeout(timer);
        resolve();
      });
      child.on('error', (error) => {
        clearTimeout(timer);
        this.stderr = `FFmpeg ${this.binary}: ${error.message}`.slice(-2000);
        reject(new Error(this.stderr));
      });
      child.stdin.on('error', (error) => {
        this.stderr = (this.stderr + error.message).slice(-2000);
        child.kill('SIGKILL');
      });
      child.once('close', (code) => {
        clearTimeout(timer);
        this.settle(code);
      });
    });
  }

  async write(bytes: Buffer): Promise<void> {
    const child = this.child;
    if (!child || this.outcome || this.stopping) throw new Error('FFmpeg is not accepting chunks.');
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.stderr = 'FFmpeg input stalled.';
        child.kill('SIGKILL');
        this.settle(null);
        reject(new Error(this.stderr));
      }, this.writeTimeoutMs);
      child.stdin.write(bytes, (error) => {
        clearTimeout(timer);
        if (error) reject(error);
        else resolve();
      });
    });
  }

  async stop(): Promise<FfmpegExit> {
    if (this.outcome) return this.outcome;
    this.stopping = true;
    const timer = setTimeout(() => {
      this.stderr = 'FFmpeg did not exit after stop.';
      this.child?.kill('SIGKILL');
      this.settle(null);
    }, this.stopTimeoutMs);
    this.child?.stdin.end();
    try {
      return await this.done;
    } finally {
      clearTimeout(timer);
    }
  }

  abort(message: string): void {
    this.stderr = message.slice(-2000);
    this.child?.kill('SIGKILL');
    this.settle(null);
  }
}
