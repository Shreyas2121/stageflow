import { isUuid, parseDisplayName, type GuestSessionResponse } from '@stageflow/shared';
import { useEffect, useState } from 'react';
import { createGuest } from './api';
import { usableSession, useSessionStore } from './session-store';

const RETURN_ORIGIN = 'https://replay.invalid';
const REPLAY_PREFIX = '/replay/';

/**
 * Exactly `/replay/<uuid>`. A value the URL parser would rewrite or send to another origin is refused.
 */
export function replayReturnPath(value: string): string | null {
  const id = value.startsWith(REPLAY_PREFIX) ? value.slice(REPLAY_PREFIX.length) : '';
  if (value.length !== REPLAY_PREFIX.length + 36 || !isUuid(id)) return null;
  try {
    const url = new URL(value, RETURN_ORIGIN);
    if (url.origin !== RETURN_ORIGIN || url.pathname !== value || url.search || url.hash)
      return null;
  } catch {
    return null;
  }
  return value;
}

export function replayPathFor(broadcastId: string): string | null {
  return replayReturnPath(`${REPLAY_PREFIX}${broadcastId}`);
}

export class GuestEntryCancelled extends Error {
  constructor() {
    super('The guest request was cancelled.');
    this.name = 'GuestEntryCancelled';
  }
}

export type ReplayGuestHost = {
  createGuest(displayName: string, signal: AbortSignal): Promise<GuestSessionResponse>;
  setSession(session: GuestSessionResponse): void;
  now(): number;
};

/** Creates one guest and returns only a validated replay path. It does not create or join a room. */
export class ReplayGuestEntry {
  private controller: AbortController | null = null;
  private generation = 0;

  constructor(private readonly host: ReplayGuestHost) {}

  cancel(): void {
    this.generation += 1;
    this.controller?.abort(new GuestEntryCancelled());
    this.controller = null;
  }

  async submit(displayName: string, returnTo: string): Promise<string> {
    const destination = replayReturnPath(returnTo);
    if (!destination) throw new Error('That replay link is not valid.');
    const name = parseDisplayName(displayName);
    if (!name.ok) throw new Error(name.message);

    this.controller?.abort(new GuestEntryCancelled());
    const controller = new AbortController();
    this.controller = controller;
    const generation = ++this.generation;
    try {
      const session = await this.host.createGuest(name.value, controller.signal);
      if (generation !== this.generation || controller.signal.aborted)
        throw new GuestEntryCancelled();
      if (!usableSession(session, this.host.now()))
        throw new Error('That guest session expired. Enter your name again.');
      this.host.setSession(session);
      return destination;
    } finally {
      if (this.controller === controller) this.controller = null;
    }
  }
}

export function useReplayGuestEntry(): ReplayGuestEntry {
  const setSession = useSessionStore((state) => state.setSession);
  const [entry] = useState(
    () =>
      new ReplayGuestEntry({
        createGuest,
        setSession,
        now: () => Date.now(),
      }),
  );
  useEffect(() => () => entry.cancel(), [entry]);
  return entry;
}
