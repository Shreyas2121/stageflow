// A rejected operation does not poison later work on the same key.
export class SerializedOperations {
  private readonly queues = new Map<string, Promise<unknown>>();
  run<T>(key: string, action: () => Promise<T>): Promise<T> {
    const task = (this.queues.get(key) ?? Promise.resolve()).catch(() => undefined).then(action);
    this.queues.set(key, task);
    void task
      .finally(() => {
        if (this.queues.get(key) === task) this.queues.delete(key);
      })
      .catch(() => undefined);
    return task;
  }
}
