export type OutputRouteResult = {
  ok: boolean;
  supported: boolean;
  deviceId: string;
  message: string;
};

type SinkElement = HTMLMediaElement & {
  setSinkId?: (sinkId: string) => Promise<void>;
  sinkId?: string;
};

export const defaultSpeakerSentence = 'This browser uses the default speaker output.';

const outputStorageKey = 'stageflow.output';

let memoryId = '';
let memoryAhead = false;

function readStoredId(): string {
  if (memoryAhead || typeof sessionStorage === 'undefined') return memoryId;
  try {
    const stored = sessionStorage.getItem(outputStorageKey);
    if (typeof stored === 'string') memoryId = stored;
  } catch {
    return memoryId;
  }
  return memoryId;
}

function writeStoredId(deviceId: string): void {
  memoryId = deviceId;
  if (typeof sessionStorage === 'undefined') {
    memoryAhead = false;
    return;
  }
  try {
    sessionStorage.setItem(outputStorageKey, deviceId);
    memoryAhead = false;
  } catch {
    // Keep the id in memory. The next write tries storage again.
    memoryAhead = true;
  }
}

export function selectedOutputId(): string {
  return readStoredId();
}

export function audioOutputSupported(): boolean {
  return typeof HTMLMediaElement !== 'undefined' && 'setSinkId' in HTMLMediaElement.prototype;
}

function routeMessage(error: unknown): string {
  const detail = error instanceof Error && error.message ? error.message : '';
  return detail
    ? `Unable to use that speaker. ${detail}`
    : 'Unable to use that speaker. The default output is still available.';
}

export async function routeAudioOutput(
  element: SinkElement,
  deviceId: string,
): Promise<OutputRouteResult> {
  if (typeof element.setSinkId !== 'function') {
    return { ok: true, supported: false, deviceId: '', message: '' };
  }
  if ((element.sinkId ?? '') === deviceId) {
    return { ok: true, supported: true, deviceId, message: '' };
  }
  try {
    await element.setSinkId(deviceId);
    return { ok: true, supported: true, deviceId, message: '' };
  } catch (error) {
    if (deviceId !== '') {
      try {
        if ((element.sinkId ?? '') !== '') await element.setSinkId('');
      } catch {
        // Keep the selected-device error. The default output could not be restored either.
      }
    }
    return { ok: false, supported: true, deviceId: '', message: routeMessage(error) };
  }
}

type Binding = {
  element: SinkElement;
  onResult?: (result: OutputRouteResult) => void;
};

type Routed = { binding: Binding; result: OutputRouteResult };

const bindings = new Set<Binding>();
const listeners = new Set<(result: OutputRouteResult) => void>();

/** Selection controls observe the final result, including a newly bound element's fallback. */
export function subscribeAudioOutput(listener: (result: OutputRouteResult) => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function publish(result: OutputRouteResult): void {
  for (const listener of listeners) listener(result);
}

// Binds and selects share this queue. A task must not wait on the queue.
let queue: Promise<unknown> = Promise.resolve();

function enqueue<T>(task: () => Promise<T>): Promise<T> {
  const run = queue.then(task, task);
  queue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

async function routeBinding(binding: Binding, deviceId: string): Promise<OutputRouteResult> {
  if (!bindings.has(binding)) {
    return { ok: true, supported: false, deviceId, message: '' };
  }
  const result = await routeAudioOutput(binding.element, deviceId);
  if (bindings.has(binding)) binding.onResult?.(result);
  return result;
}

async function routeAll(deviceId: string, alreadyRouted?: Binding): Promise<Routed[]> {
  const routed: Routed[] = [];
  const seen = new Set<Binding>(alreadyRouted ? [alreadyRouted] : []);
  let pending = [...bindings].filter((binding) => !seen.has(binding));
  while (pending.length > 0) {
    for (const binding of pending) {
      seen.add(binding);
      routed.push({ binding, result: await routeBinding(binding, deviceId) });
    }
    pending = [...bindings].filter((binding) => !seen.has(binding));
  }
  return routed;
}

function stillBound(routed: Routed[]): Routed[] {
  return routed.filter((item) => bindings.has(item.binding));
}

async function fallBackToDefault(
  result: OutputRouteResult,
  alreadyRouted?: Binding,
): Promise<OutputRouteResult> {
  writeStoredId('');
  const live = stillBound(await routeAll('', alreadyRouted));
  const failure = live.find((item) => !item.result.ok);
  return {
    ...(!result.ok ? result : (failure?.result ?? result)),
    deviceId: '',
  };
}

async function applySelection(deviceId: string): Promise<OutputRouteResult> {
  const previous = readStoredId();
  if (deviceId === '') {
    writeStoredId('');
    const live = stillBound(await routeAll(''));
    const failure = live.find((item) => !item.result.ok);
    if (failure) {
      return { ok: false, supported: true, deviceId: '', message: failure.result.message };
    }
    if (live.length === 0) {
      return { ok: true, supported: audioOutputSupported(), deviceId: '', message: '' };
    }
    return {
      ok: true,
      supported: live.some((item) => item.result.supported),
      deviceId: '',
      message: '',
    };
  }

  const live = stillBound(await routeAll(deviceId));
  if (live.length === 0) {
    writeStoredId(deviceId);
    return { ok: true, supported: audioOutputSupported(), deviceId, message: '' };
  }
  if (!live.some((item) => item.result.supported)) {
    return { ok: true, supported: false, deviceId: previous, message: '' };
  }
  const failure = live.find((item) => !item.result.ok);
  if (failure) {
    const restored = stillBound(await routeAll(previous));
    if (restored.some((item) => !item.result.ok)) return fallBackToDefault(failure.result);
    return {
      ok: false,
      supported: true,
      deviceId: previous,
      message: failure.result.message,
    };
  }
  writeStoredId(deviceId);
  return { ok: true, supported: true, deviceId, message: '' };
}

export function selectAudioOutput(deviceId: string): Promise<OutputRouteResult> {
  return enqueue(async () => {
    const result = await applySelection(deviceId);
    publish(result);
    return result;
  });
}

export function bindAudioOutput(
  element: HTMLMediaElement,
  onResult?: (result: OutputRouteResult) => void,
): () => void {
  const binding: Binding = { element, onResult };
  bindings.add(binding);
  void enqueue(async () => {
    if (!bindings.has(binding)) return;
    let result = await routeAudioOutput(binding.element, readStoredId());
    if (!bindings.has(binding)) return;
    if (!result.ok || !result.supported) {
      result = await fallBackToDefault(result, binding);
    }
    if (bindings.has(binding)) binding.onResult?.(result);
    publish(result);
  });
  return () => {
    bindings.delete(binding);
  };
}
