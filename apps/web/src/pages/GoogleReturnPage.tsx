import { useEffect, useRef, useState } from 'react';
import { Link, useNavigate } from 'react-router';
import type { GuestSessionResponse } from '@stageflow/shared';
import { PageState } from '../components/ui/page-state';
import { redeemGoogleTicket } from '../features/session/api';
import { useSessionStore } from '../features/session/session-store';
import { ApiError } from '../lib/http/api-error';

const rejected = 'Google did not confirm this sign-in.';
const linked = 'That Google account is already linked to another user.';
export function parseGoogleReturn(
  search: string,
): { kind: 'ticket'; ticket: string } | { kind: 'linked' } | { kind: 'error'; message: string } {
  const params = new URLSearchParams(search.replace(/^[?#]/, ''));
  if ([...params].length === 1) {
    const ticket = params.get('ticket');
    if (ticket) return { kind: 'ticket', ticket };
    if (params.get('linked') === '1') return { kind: 'linked' };
    if (params.get('error') === 'google_linked') return { kind: 'error', message: linked };
  }
  return { kind: 'error', message: rejected };
}

export function GoogleReturnPage() {
  const [result] = useState(() =>
    parseGoogleReturn(window.location.hash || window.location.search),
  );
  const [error, setError] = useState(result.kind === 'error' ? result.message : '');
  const redemption = useRef<Promise<GuestSessionResponse> | null>(null);
  const initiatingToken = useRef(useSessionStore.getState().session?.token ?? null);
  const navigate = useNavigate();
  useEffect(() => {
    // Preserve router history state while removing the one-time return location.
    window.history.replaceState(window.history.state, '', '/auth/google');
    let active = true;
    if (result.kind === 'linked') void navigate('/', { replace: true });
    if (result.kind === 'ticket') {
      // StrictMode repeats effects; both subscriptions share one redemption request.
      redemption.current ??= redeemGoogleTicket(
        result.ticket,
        initiatingToken.current ?? undefined,
      );
      void redemption.current.then(
        (session) => {
          if (!active) return;
          if ((useSessionStore.getState().session?.token ?? null) !== initiatingToken.current) {
            setError('Your session changed. Please try again.');
            return;
          }
          useSessionStore.getState().setSession(session);
          void navigate('/', { replace: true });
        },
        (error: unknown) => {
          if (active)
            setError(
              error instanceof ApiError && error.code === 'google_linked' ? linked : rejected,
            );
        },
      );
    }
    return () => {
      active = false;
    };
  }, [navigate, result]);
  return (
    <PageState
      eyebrow="Host account"
      title={error ? 'Google sign-in could not finish.' : 'Finishing sign-in…'}
    >
      {error ? (
        <>
          <p role="alert" className="text-sm text-danger">
            {error}
          </p>
          <Link to="/" className="text-sm text-accent underline">
            Back to home
          </Link>
        </>
      ) : (
        <p role="status" className="text-sm text-muted">
          Updating your session…
        </p>
      )}
    </PageState>
  );
}
