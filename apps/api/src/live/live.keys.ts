export function parseLiveNamespace(value: string | undefined): string {
  const namespace = value ?? 'sf';
  if (!/^[A-Za-z0-9_-]{1,64}$/.test(namespace))
    throw new Error('LIVE_NAMESPACE must contain 1 to 64 letters, digits, underscores or hyphens.');
  return namespace;
}

export function roomPrefix(roomId: string, namespace: string): string {
  return `${namespace}:room:${roomId}`;
}

// These are real Redis keys, passed together to every script. Standalone Redis only.
export function liveKeys(prefix: string): [string, string, string, string, string, string] {
  return [
    `${prefix}:rev`,
    `${prefix}:participants`,
    `${prefix}:stage`,
    `${prefix}:hands`,
    `${prefix}:ending`,
    `${prefix}:broadcast`,
  ];
}
