import { create } from 'zustand';
import type { GuestSessionResponse } from '@stageflow/shared';

const storageKey = 'stageflow.session';

function readStoredSession(): GuestSessionResponse | null {
  try {
    const raw = sessionStorage.getItem(storageKey);
    if (raw === null) return null;
    const value: unknown = JSON.parse(raw);
    if (
      typeof value === 'object' &&
      value !== null &&
      'token' in value &&
      typeof value.token === 'string' &&
      value.token.length > 0 &&
      'userId' in value &&
      typeof value.userId === 'string' &&
      value.userId.length > 0 &&
      'displayName' in value &&
      typeof value.displayName === 'string' &&
      value.displayName.length > 0
    ) {
      return { token: value.token, userId: value.userId, displayName: value.displayName };
    }
  } catch {
    // Invalid JSON and unavailable storage both leave the tab without a session.
  }
  try {
    sessionStorage.removeItem(storageKey);
  } catch {
    // The browser may deny storage access altogether.
  }
  return null;
}

type SessionStore = {
  session: GuestSessionResponse | null;
  setSession: (session: GuestSessionResponse) => void;
};

export const useSessionStore = create<SessionStore>((set) => ({
  session: readStoredSession(),
  setSession: (session) => {
    sessionStorage.setItem(storageKey, JSON.stringify(session));
    set({ session });
  },
}));
