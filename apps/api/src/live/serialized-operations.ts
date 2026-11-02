export class WorkCapacityError extends Error {
  constructor() {
    super('Live work capacity is full.');
  }
}
type Job = { cleanup: boolean; action: () => Promise<void> };
type Queue = { running: boolean; normal: number; jobs: Job[] };
export class SerializedOperations {
  private readonly queues = new Map<string, Queue>();
  private readonly idle = new Set<() => void>();
  onModuleDestroy(): Promise<void> {
    if (!this.queues.size) return Promise.resolve();
    return new Promise((resolve) => {
      this.idle.add(resolve);
    });
  }
  private readonly pending = { socket: { normal: 0, cleanup: 0 }, room: { normal: 0, cleanup: 0 } };
  constructor(private readonly limits = { maxPending: 512, maxPerKey: 32, cleanupReserve: 128 }) {}
  run<T>(key: string, action: () => Promise<T>, cleanup = false): Promise<T> {
    const scope = key.startsWith('room:') ? this.pending.room : this.pending.socket;
    const queue = this.queues.get(key) ?? { running: false, normal: 0, jobs: [] };
    if (
      cleanup
        ? scope.cleanup >= this.limits.cleanupReserve
        : scope.normal >= this.limits.maxPending || queue.normal >= this.limits.maxPerKey
    )
      return Promise.reject(new WorkCapacityError());
    this.queues.set(key, queue);
    if (cleanup) scope.cleanup++;
    else {
      scope.normal++;
      queue.normal++;
    }
    const result = new Promise<T>((resolve, reject) => {
      queue.jobs.push({
        cleanup,
        action: async () => {
          try {
            const value = await action();
            finish();
            resolve(value);
          } catch (error) {
            finish();
            reject(error);
          }
        },
      });
    });
    const pump = () => {
      if (queue.running) return;
      const priority = queue.jobs.findIndex((job) => job.cleanup);
      const job = queue.jobs.splice(priority < 0 ? 0 : priority, 1)[0];
      if (!job) {
        this.queues.delete(key);
        if (!this.queues.size) {
          for (const resolve of this.idle) resolve();
          this.idle.clear();
        }
        return;
      }
      queue.running = true;
      void Promise.resolve()
        .then(job.action)
        .catch(() => undefined);
    };
    const finish = () => {
      if (cleanup) scope.cleanup--;
      else {
        scope.normal--;
        queue.normal--;
      }
      queue.running = false;
      pump();
    };
    pump();
    return result;
  }
}
