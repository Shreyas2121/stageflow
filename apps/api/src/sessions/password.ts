import { existsSync } from 'node:fs';
import { availableParallelism } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';
import { env } from '../config/env';

const JOB_TIMEOUT_MS = 20_000;
const FAILURE_LIMIT = 3;

export class PasswordBusyError extends Error {
  constructor(readonly reason: 'full' | 'closed' | 'failed') {
    super('Password work is unavailable.');
    this.name = 'PasswordBusyError';
  }
}

type PasswordOp = 'hash' | 'compare';
type WorkerReply = { id?: unknown; ok?: unknown; value?: unknown };
type HashJob = {
  id: number;
  op: PasswordOp;
  password: string;
  passwordHash?: string;
  promise: Promise<string | boolean>;
  resolve: (value: string | boolean) => void;
  reject: (error: Error) => void;
  timer?: NodeJS.Timeout;
  settled: boolean;
};
type WorkerSlot = { worker: Worker; job: HashJob | null; stopping: boolean; exited: boolean };

export type PasswordPoolOptions = {
  workers?: number;
  queueLimit?: number;
  jobTimeoutMs?: number;
  workerFile?: string;
};

// One process-wide pool. Callers that find it full are rejected and are not retained.
export function passwordWorkerFile(): string {
  return join(__dirname, 'password.worker.cjs');
}

export function passwordWorkerCount(configured = env.PASSWORD_WORKER_LIMIT): number {
  return Math.max(1, Math.min(configured, Math.max(1, availableParallelism())));
}

export function passwordAdmissionLimit(): number {
  return passwordWorkerCount() + env.PASSWORD_QUEUE_LIMIT;
}

export class PasswordPool {
  private readonly size: number;
  private readonly queueLimit: number;
  private readonly jobTimeoutMs: number;
  private readonly workerFile: string;
  private readonly workers: WorkerSlot[] = [];
  private readonly waiting: HashJob[] = [];
  private admitted = 0;
  private nextId = 0;
  private started = 0;
  private consecutiveFailures = 0;
  private closed = false;
  private broken = false;

  constructor(options: PasswordPoolOptions = {}) {
    this.size = Math.max(1, options.workers ?? passwordWorkerCount());
    this.queueLimit = Math.max(0, options.queueLimit ?? env.PASSWORD_QUEUE_LIMIT);
    this.jobTimeoutMs = options.jobTimeoutMs ?? JOB_TIMEOUT_MS;
    this.workerFile = options.workerFile ?? passwordWorkerFile();
  }

  get capacity(): number {
    return this.size + this.queueLimit;
  }

  workersStarted(): number {
    return this.started;
  }

  retainedPasswordCount(): number {
    const waiting = this.waiting.filter((job) => job.password.length > 0).length;
    const running = this.workers.filter((slot) => slot.job && slot.job.password.length > 0).length;
    return waiting + running;
  }

  tryAdmit(): () => void {
    if (this.closed || this.broken || this.admitted >= this.capacity) {
      throw new PasswordBusyError(this.closed || this.broken ? 'closed' : 'full');
    }
    this.admitted += 1;
    let released = false;
    return () => {
      if (released) return;
      released = true;
      this.admitted -= 1;
    };
  }

  hash(password: string): Promise<string> {
    return this.dispatch('hash', password) as Promise<string>;
  }

  compare(password: string, passwordHash: string): Promise<boolean> {
    return this.dispatch('compare', password, passwordHash) as Promise<boolean>;
  }

  async discardRunningWorker(): Promise<void> {
    const slot = this.workers.find((item) => item.job);
    if (!slot) throw new Error('No running password worker.');
    const exited = new Promise<void>((resolve) => slot.worker.once('exit', () => resolve()));
    await slot.worker.terminate();
    await exited;
  }

  async close(): Promise<void> {
    if (this.closed) return;
    this.closed = true;
    const queued = this.waiting.splice(0);
    for (const job of queued) this.finish(job, new PasswordBusyError('closed'));
    await Promise.all(this.workers.map((slot) => this.killAndWait(slot)));
    this.admitted = 0;
  }

  private dispatch(
    op: PasswordOp,
    password: string,
    passwordHash?: string,
  ): Promise<string | boolean> {
    if (this.closed) return Promise.reject(new PasswordBusyError('closed'));
    if (this.broken) return Promise.reject(new PasswordBusyError('failed'));
    const idle = this.workers.find((slot) => slot.job === null && !slot.stopping);
    if (!idle && this.workers.length >= this.size && this.waiting.length >= this.queueLimit) {
      return Promise.reject(new PasswordBusyError('full'));
    }
    const job = this.createJob(op, password, passwordHash);
    if (idle) this.start(idle, job);
    else if (this.workers.length < this.size) {
      const slot = this.spawn();
      if (!slot) this.finish(job, new PasswordBusyError('failed'));
      else this.start(slot, job);
    } else this.waiting.push(job);
    return job.promise;
  }

  private createJob(op: PasswordOp, password: string, passwordHash?: string): HashJob {
    let resolve!: (value: string | boolean) => void;
    let reject!: (error: Error) => void;
    const promise = new Promise<string | boolean>((onResolve, onReject) => {
      resolve = onResolve;
      reject = onReject;
    });
    this.nextId += 1;
    return {
      id: this.nextId,
      op,
      password,
      passwordHash,
      promise,
      resolve,
      reject,
      settled: false,
    };
  }

  private spawn(): WorkerSlot | null {
    if (this.closed || this.broken) return null;
    if (!existsSync(this.workerFile)) {
      this.noteFailure();
      return null;
    }
    let worker: Worker;
    try {
      const workerEnv = { ...process.env };
      delete workerEnv.NODE_OPTIONS;
      worker = new Worker(this.workerFile, { execArgv: [], env: workerEnv });
    } catch {
      this.noteFailure();
      return null;
    }
    const slot: WorkerSlot = { worker, job: null, stopping: false, exited: false };
    worker.on('message', (message: WorkerReply) => this.onMessage(slot, message));
    worker.on('error', () => {
      // The exit handler settles the job. Listening keeps the worker error off the API thread.
    });
    worker.on('exit', () => this.onExit(slot));
    // An idle worker must not pin a one-shot script. A running job references it again.
    worker.unref();
    this.workers.push(slot);
    this.started += 1;
    return slot;
  }

  private start(slot: WorkerSlot, job: HashJob): void {
    slot.worker.ref();
    slot.job = job;
    job.timer = setTimeout(() => this.kill(slot, 'failed'), this.jobTimeoutMs);
    job.timer.unref();
    try {
      slot.worker.postMessage({
        id: job.id,
        op: job.op,
        password: job.password,
        passwordHash: job.passwordHash,
      });
    } catch {
      this.finish(job, new PasswordBusyError('failed'));
      slot.job = null;
      this.releaseIdle(slot);
      this.noteFailure();
    } finally {
      job.password = '';
      job.passwordHash = undefined;
    }
  }

  private onMessage(slot: WorkerSlot, message: WorkerReply): void {
    const job = slot.job;
    if (!job || message.id !== job.id) return;
    slot.job = null;
    this.consecutiveFailures = 0;
    const valid =
      message.ok === true &&
      (job.op === 'hash' ? typeof message.value === 'string' : typeof message.value === 'boolean');
    if (valid) this.finish(job, null, message.value as string | boolean);
    else this.finish(job, new PasswordBusyError('failed'));
    this.releaseIdle(slot);
    this.pump();
  }

  private onExit(slot: WorkerSlot): void {
    slot.exited = true;
    const index = this.workers.indexOf(slot);
    if (index >= 0) this.workers.splice(index, 1);
    if (!slot.stopping && slot.job) {
      this.finish(slot.job, new PasswordBusyError('failed'));
      slot.job = null;
      this.noteFailure();
    }
    if (!this.closed && !this.broken) this.pump();
  }

  private pump(): void {
    while (this.waiting.length > 0 && !this.closed && !this.broken) {
      const idle = this.workers.find((slot) => slot.job === null && !slot.stopping);
      const slot = idle ?? (this.workers.length < this.size ? this.spawn() : null);
      if (!slot) return;
      const job = this.waiting.shift();
      if (!job) return;
      this.start(slot, job);
    }
  }

  private noteFailure(): void {
    this.consecutiveFailures += 1;
    if (this.consecutiveFailures < FAILURE_LIMIT) return;
    this.broken = true;
    const queued = this.waiting.splice(0);
    for (const job of queued) this.finish(job, new PasswordBusyError('failed'));
  }

  private releaseIdle(slot: WorkerSlot): void {
    if (slot.job === null && !slot.stopping && !slot.exited) slot.worker.unref();
  }

  private kill(slot: WorkerSlot, reason: 'closed' | 'failed'): void {
    if (slot.stopping) return;
    slot.stopping = true;
    // Keep the terminating worker observable until its exit event.
    slot.worker.ref();
    if (slot.job) this.finish(slot.job, new PasswordBusyError(reason));
    slot.job = null;
    if (!slot.exited) void slot.worker.terminate();
  }

  private killAndWait(slot: WorkerSlot): Promise<void> {
    if (slot.exited) return Promise.resolve();
    const exited = new Promise<void>((resolve) => slot.worker.once('exit', () => resolve()));
    this.kill(slot, 'closed');
    return exited;
  }

  private finish(job: HashJob, error: PasswordBusyError | null, value?: string | boolean): void {
    if (job.settled) return;
    job.settled = true;
    if (job.timer) clearTimeout(job.timer);
    job.password = '';
    job.passwordHash = undefined;
    if (error) job.reject(error);
    else job.resolve(value as string | boolean);
  }
}

let singleton: PasswordPool | undefined;

function sharedPool(): PasswordPool {
  singleton ??= new PasswordPool();
  return singleton;
}

export function admitPasswordWork(): () => void {
  return sharedPool().tryAdmit();
}

export function hashPassword(password: string): Promise<string> {
  return sharedPool().hash(password);
}

export function verifyPassword(password: string, passwordHash: string): Promise<boolean> {
  return sharedPool().compare(password, passwordHash);
}

export async function closePasswordWorkers(): Promise<void> {
  const current = singleton;
  singleton = undefined;
  await current?.close();
}
