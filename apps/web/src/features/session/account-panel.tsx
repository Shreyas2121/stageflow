import {
  parseDisplayName,
  parseEmail,
  parsePassword,
  type GuestSessionResponse,
} from '@stageflow/shared';
import { useMutation } from '@tanstack/react-query';
import { useEffect, useRef, useState } from 'react';
import { Button } from '../../components/ui/button';
import { FormField } from '../../components/ui/form-field';
import { changePassword, login, promote, register } from './api';
import { isHostSession, useSessionStore } from './session-store';

type AccountAction = 'register' | 'login' | 'promote' | 'password';

export function AccountPanel({
  session,
  displayName,
  disabled,
  onPendingChange,
}: {
  session: GuestSessionResponse | null;
  displayName: string;
  disabled: boolean;
  onPendingChange: (pending: boolean) => void;
}) {
  const isHost = isHostSession(session);
  const [mode, setMode] = useState<'login' | 'register'>('register');
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [currentPassword, setCurrentPassword] = useState('');
  const pendingRequest = useRef<AbortController | null>(null);
  useEffect(() => () => pendingRequest.current?.abort(), [session?.token]);
  const action: AccountAction = isHost
    ? 'password'
    : session && mode !== 'login'
      ? 'promote'
      : mode;
  const label = {
    register: 'Register',
    login: 'Log in',
    promote: 'Create host account',
    password: 'Change password',
  }[action];
  const submit = useMutation({
    mutationFn: async () => {
      pendingRequest.current?.abort();
      const controller = new AbortController();
      pendingRequest.current = controller;
      const token = session?.token;
      if ((useSessionStore.getState().session?.token ?? null) !== (token ?? null))
        throw new Error('Your session changed. Please try again.');
      const parsedPassword = parsePassword(password);
      if (!parsedPassword.ok) throw new Error(parsedPassword.message);
      if (action === 'password') {
        const current = parsePassword(currentPassword);
        if (!current.ok) throw new Error(current.message);
        return changePassword(current.value, parsedPassword.value, token!, controller.signal);
      }
      const parsedEmail = parseEmail(email);
      if (!parsedEmail.ok) throw new Error(parsedEmail.message);
      if (action === 'promote')
        return promote(parsedEmail.value, parsedPassword.value, token!, controller.signal);
      if (action === 'login')
        return login(parsedEmail.value, parsedPassword.value, controller.signal);
      const name = parseDisplayName(displayName);
      if (!name.ok) throw new Error(name.message);
      return register(name.value, parsedEmail.value, parsedPassword.value, controller.signal);
    },
    onMutate: () => onPendingChange(true),
    onSuccess: (next) => {
      if (
        !pendingRequest.current?.signal.aborted &&
        (useSessionStore.getState().session?.token ?? null) === (session?.token ?? null)
      ) {
        setPassword('');
        setCurrentPassword('');
        useSessionStore.getState().setSession(next);
      }
    },
    onSettled: () => onPendingChange(false),
  });

  return (
    <section
      className="mt-8 rounded-panel border border-line bg-surface p-6 layout:p-7.5"
      aria-labelledby="account-title"
    >
      <fieldset
        disabled={disabled || submit.isPending}
        aria-busy={submit.isPending}
        className="min-w-0 border-0 p-0"
      >
        <legend className="sr-only">Account options</legend>
        <div className="mb-5 flex flex-wrap items-center justify-between gap-3">
          <h2 id="account-title" className="m-0 text-[22px] font-medium tracking-tight">
            {isHost
              ? 'Host account'
              : action === 'login'
                ? 'Log in to your account'
                : session
                  ? 'Keep your rooms'
                  : 'Create a host account'}
          </h2>
          {isHost ? (
            <Button
              type="button"
              onClick={() => useSessionStore.getState().clearSession(session!.token)}
            >
              Log out
            </Button>
          ) : (
            <Button
              type="button"
              onClick={() => {
                submit.reset();
                setMode(mode === 'login' ? 'register' : 'login');
              }}
            >
              {mode === 'login'
                ? session
                  ? 'Create host account instead'
                  : 'Register instead'
                : session
                  ? 'Log in to another account'
                  : 'Log in instead'}
            </Button>
          )}
        </div>
        {action === 'register' && (
          <p className="mb-5 text-sm text-muted">
            Register with the display name above to return to your rooms on another browser.
          </p>
        )}
        {action === 'promote' && (
          <p className="mb-5 text-sm text-muted">
            Keep this guest session's rooms by creating a host account. Leave any live room first.
          </p>
        )}
        {action === 'login' && session && (
          <p className="mb-5 text-sm text-muted">
            Logging in replaces this guest session. Rooms that were not promoted stay on this guest
            session.
          </p>
        )}
        <form
          noValidate
          onSubmit={(event) => {
            event.preventDefault();
            submit.mutate();
          }}
        >
          <div className="grid gap-4 layout:grid-cols-2">
            {isHost ? (
              <FormField
                id="account-current-password"
                label="Current password"
                name="currentPassword"
                type="password"
                autoComplete="current-password"
                value={currentPassword}
                onChange={(event) => setCurrentPassword(event.target.value)}
              />
            ) : (
              <FormField
                id="account-email"
                label="Email"
                name="email"
                type="email"
                autoComplete="username"
                autoCapitalize="none"
                spellCheck={false}
                value={email}
                onChange={(event) => setEmail(event.target.value)}
              />
            )}
            <FormField
              id="account-password"
              label={isHost ? 'New password' : 'Password'}
              name="password"
              type="password"
              autoComplete={action === 'login' ? 'current-password' : 'new-password'}
              value={password}
              onChange={(event) => setPassword(event.target.value)}
            />
          </div>
          <Button type="submit" variant="primary" className="mt-4.5">
            {label}
          </Button>
        </form>
      </fieldset>
      {submit.isPending && (
        <p className="mt-4 mb-0 text-sm text-focus" role="status">
          Updating your session…
        </p>
      )}
      {submit.isSuccess && isHost && (
        <p className="mt-4 mb-0 text-sm text-focus" role="status">
          Password changed.
        </p>
      )}
      {submit.isError && (
        <p
          className="mt-4 mb-0 rounded-control border border-danger-line bg-danger-surface px-4 py-3.5 text-sm text-danger wrap-anywhere"
          role="alert"
        >
          {submit.error.message}
        </p>
      )}
    </section>
  );
}
