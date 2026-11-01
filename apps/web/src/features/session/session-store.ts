import { create } from 'zustand';
import type { GuestSessionResponse } from '@stageflow/shared';
import { parseGuest } from './api';

const storageKey = 'stageflow.session';
// Read exp only to discard an expired token; the server verifies authenticity.
export function expiresAt(token: string): number | null {
  try {
    const payload: unknown = JSON.parse(
      atob((token.split('.')[1] ?? '').replace(/-/g, '+').replace(/_/g, '/')),
    );
    if (
      typeof payload === 'object' &&
      payload !== null &&
      'exp' in payload &&
      typeof payload.exp === 'number' &&
      Number.isFinite(payload.exp)
    )
      return payload.exp * 1000;
  } catch {
    /* The server remains the authority for opaque or invalid tokens. */
  }
  return null;
}
function persist(session: GuestSessionResponse | null): void {
  try {
    if (session) sessionStorage.setItem(storageKey, JSON.stringify(session));
    else sessionStorage.removeItem(storageKey);
  } catch {
    /* Denied storage still permits an in-memory guest session. */
  }
}
export function readStoredSession(): GuestSessionResponse | null {
  try {
    const raw = sessionStorage.getItem(storageKey);
    if (raw === null) return null;
    const session = parseGuest(JSON.parse(raw));
    if ((expiresAt(session.token) ?? Infinity) > Date.now()) return session;
  } catch {
    /* Invalid or unavailable storage starts a fresh name flow. */
  }
  persist(null);
  return null;
}
type SessionStore = {
  session: GuestSessionResponse | null;
  setSession: (session: GuestSessionResponse) => void;
  clearSession: (token?: string) => void;
};
export const useSessionStore = create<SessionStore>((set, get) => ({
  session: readStoredSession(),
  setSession: (session) => {
    const next = (expiresAt(session.token) ?? Infinity) > Date.now() ? session : null;
    persist(next);
    set({ session: next });
  },
  clearSession: (token) => {
    if (token !== undefined && get().session?.token !== token) return;
    persist(null);
    set({ session: null });
  },
}));
let expiryTimer: ReturnType<typeof setTimeout> | undefined;
function scheduleExpiry(): void {
  clearTimeout(expiryTimer);
  const session = useSessionStore.getState().session;
  const expiry = session ? expiresAt(session.token) : null;
  if (!session || expiry === null) return;
  expiryTimer = setTimeout(
    () => {
      if (expiry <= Date.now()) useSessionStore.getState().clearSession(session.token);
      else scheduleExpiry();
    },
    Math.max(0, Math.min(expiry - Date.now(), 2_147_483_647)),
  );
}
useSessionStore.subscribe(scheduleExpiry);
scheduleExpiry();
