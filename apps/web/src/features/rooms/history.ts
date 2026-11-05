import { isBroadcastPlaylistUrl, type BroadcastResponse } from '@stageflow/shared';

/** Replay route for a finished catalog playlist. Every other row stays on the workspace. */
export function replayHref(
  broadcast: Pick<BroadcastResponse, 'id' | 'status' | 'playlistUrl'>,
): string | null {
  if (broadcast.status !== 'READY' || !broadcast.playlistUrl) return null;
  if (!isBroadcastPlaylistUrl(broadcast.playlistUrl)) return null;
  return `/replay/${broadcast.id}`;
}

/** Keep earlier rows when a later page repeats an id. */
export function mergeById<T extends { id: string }>(groups: readonly (readonly T[])[]): T[] {
  const seen = new Set<string>();
  const items: T[] = [];
  for (const group of groups) {
    for (const item of group) {
      if (seen.has(item.id)) continue;
      seen.add(item.id);
      items.push(item);
    }
  }
  return items;
}

/** Keep page cursors and ordering while replacing or removing this replay in loaded pages. */
export function updateBroadcastPages<T extends { pages: Array<{ items: BroadcastResponse[] }> }>(
  data: T | undefined,
  id: string,
  replacement: BroadcastResponse | null,
): T | undefined {
  if (!data) return data;
  return {
    ...data,
    pages: data.pages.map((page) => ({
      ...page,
      items: page.items.flatMap((item) =>
        item.id === id ? (replacement ? [replacement] : []) : [item],
      ),
    })),
  };
}
