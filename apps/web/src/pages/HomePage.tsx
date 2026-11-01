import { Button } from '../components/ui/button';
import { FormField } from '../components/ui/form-field';
import {
  DISPLAY_NAME_MAX_LENGTH,
  ROOM_TITLE_MAX_LENGTH,
  ROOM_SLUG_LENGTH,
  isRoomSlug,
} from '@stageflow/shared';
import { useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation } from '@tanstack/react-query';
import { parseDisplayName, parseRoomMode, parseRoomTitle } from '@stageflow/shared';
import type { RoomMode } from '@stageflow/shared';
import { createGuest } from '../features/session/api';
import { createRoom, getRoom } from '../features/rooms/api';
import { useSessionStore } from '../features/session/session-store';

export function HomePage() {
  const session = useSessionStore((state) => state.session);
  const setSession = useSessionStore((state) => state.setSession);
  const [displayName, setDisplayName] = useState(session?.displayName ?? '');
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const navigate = useNavigate();
  const pendingRequest = useRef<AbortController | null>(null);
  useEffect(() => () => pendingRequest.current?.abort(), []);
  const submit = useMutation({
    mutationFn: async (action: RoomMode | 'join') => {
      pendingRequest.current?.abort();
      const controller = new AbortController();
      pendingRequest.current = controller;
      const name = parseDisplayName(displayName);
      if (!name.ok) throw new Error(name.message);
      if (action === 'join') {
        if (!isRoomSlug(slug)) throw new Error('Enter the 12 character room slug.');
        const guest = await createGuest(name.value, controller.signal);
        setSession(guest);
        return getRoom(slug, guest.token, controller.signal);
      }
      const parsedTitle = parseRoomTitle(title);
      if (!parsedTitle.ok) throw new Error(parsedTitle.message);
      const mode = parseRoomMode(action);
      if (!mode.ok) throw new Error(mode.message);
      const guest = await createGuest(name.value, controller.signal);
      setSession(guest);
      return createRoom(
        { title: parsedTitle.value, mode: mode.value },
        guest.token,
        controller.signal,
      );
    },
    onSuccess: (room) => {
      if (!pendingRequest.current?.signal.aborted) void navigate(`/r/${room.slug}`);
    },
  });

  return (
    <section className="pt-9 pb-16 layout:pt-15" aria-labelledby="home-title">
      <div>
        <p className="mb-4 text-[11px] font-semibold tracking-[0.11em] text-eyebrow uppercase">
          Your next conversation
        </p>
        <h1
          id="home-title"
          className="mb-4 text-[clamp(30px,4vw,40px)] leading-tight font-medium tracking-[-0.03em]"
        >
          Start with a room.
        </h1>
        <p className="m-0 text-sm text-muted">
          Create a meeting or webinar, or open a room with its slug.
        </p>
      </div>
      <fieldset
        disabled={submit.isPending}
        className="mt-9 min-w-0 overflow-visible rounded-panel border border-line bg-surface p-0"
        aria-busy={submit.isPending}
      >
        <legend className="sr-only">Your name and room options</legend>
        <FormField
          id="display-name"
          name="displayName"
          label="Your display name"
          hint="The name others will see. No account needed."
          autoComplete="nickname"
          placeholder="e.g. Ava"
          maxLength={DISPLAY_NAME_MAX_LENGTH}
          value={displayName}
          onChange={(event) => setDisplayName(event.target.value)}
          className="grid items-center gap-4 border-b border-line p-6 layout:grid-cols-2 layout:gap-8 layout:px-7.5 layout:py-6.5"
        />
        <div className="grid layout:grid-cols-2">
          <form
            className="min-w-0 px-6 py-6 layout:p-7.5"
            onSubmit={(event) => {
              event.preventDefault();
              submit.mutate('MEETING');
            }}
            noValidate
          >
            <p
              className="mb-5 font-mono text-[10px] font-semibold tracking-widest text-subtle uppercase"
              aria-hidden="true"
            >
              01 / CREATE
            </p>
            <h2 className="mb-2.5 text-[22px] font-medium tracking-tight">A room of your own</h2>
            <p className="mb-6 text-sm text-muted layout:mb-7 layout:min-h-11 layout:max-w-70">
              Give your conversation a title and choose a format.
            </p>
            <FormField
              id="room-title"
              name="title"
              label="Room title"
              placeholder="e.g. Design review"
              maxLength={ROOM_TITLE_MAX_LENGTH}
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
            <div className="mt-4.5 grid gap-2 min-[380px]:grid-cols-[1.15fr_1fr] layout:grid-cols-[1.15fr_1fr]">
              <Button variant="primary" type="submit">
                Create meeting <span aria-hidden="true">&#8599;</span>
              </Button>
              <Button type="button" onClick={() => submit.mutate('WEBINAR')}>
                Create webinar
              </Button>
            </div>
          </form>
          <form
            className="min-w-0 border-t border-line px-6 py-6 layout:border-t-0 layout:border-l layout:p-7.5"
            onSubmit={(event) => {
              event.preventDefault();
              submit.mutate('join');
            }}
            noValidate
          >
            <p
              className="mb-5 font-mono text-[10px] font-semibold tracking-widest text-subtle uppercase"
              aria-hidden="true"
            >
              02 / JOIN
            </p>
            <h2 className="mb-2.5 text-[22px] font-medium tracking-tight">Have a room slug?</h2>
            <p className="mb-6 text-sm text-muted layout:mb-7 layout:min-h-11 layout:max-w-70">
              Enter the slug shared with you to open that room.
            </p>
            <FormField
              id="room-slug"
              name="slug"
              label="Room slug"
              placeholder="12 character slug"
              inputClassName="font-mono tracking-wide"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              maxLength={ROOM_SLUG_LENGTH}
              value={slug}
              onChange={(event) => setSlug(event.target.value)}
            />
            <Button className="mt-4.5 w-full" type="submit">
              Join room <span aria-hidden="true">&#8594;</span>
            </Button>
          </form>
        </div>
      </fieldset>
      {submit.isPending && (
        <p className="mt-4 text-sm text-focus" role="status">
          {submit.variables === 'join' ? 'Opening your room…' : 'Creating your room…'}
        </p>
      )}
      {submit.isError && (
        <p
          className="mt-4 rounded-control border border-danger-line bg-danger-surface px-4 py-3.5 text-sm text-danger wrap-anywhere"
          role="alert"
        >
          Error: {submit.error.message}
        </p>
      )}
      <aside className="mt-6.5 flex items-start gap-3 rounded-lg border border-dashed border-note-line px-5 py-4.5">
        <span
          className="mt-0.5 size-5 shrink-0 rounded-full border border-note-marker-line text-center font-serif text-xs leading-[18px] text-note-marker"
          aria-hidden="true"
        >
          i
        </span>
        <div>
          <h2 className="mb-1 text-[13px] font-semibold tracking-normal">Meet on stage.</h2>
          <p className="m-0 text-xs text-muted">
            Check your devices in the green room, then join. People on stage can see and hear each
            other and share a screen. Webinar attendees join without a camera or microphone.
          </p>
        </div>
      </aside>
    </section>
  );
}
