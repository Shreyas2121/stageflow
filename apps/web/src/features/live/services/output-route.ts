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
