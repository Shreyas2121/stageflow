export const demoPeerNames = ['Demo Peer 1', 'Demo Peer 2', 'Demo Peer 3'] as const;

export function nextDemoPeerName(
  usedNames: Iterable<string>,
): (typeof demoPeerNames)[number] | null {
  const used = new Set(usedNames);
  return demoPeerNames.find((name) => !used.has(name)) ?? null;
}
