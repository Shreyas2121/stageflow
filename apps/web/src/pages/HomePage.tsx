import { useState } from 'react';
import { useNavigate } from 'react-router';
import { useMutation } from '@tanstack/react-query';
import { parseDisplayName, parseRoomMode, parseRoomTitle } from '@stageflow/shared';
import type { RoomMode } from '@stageflow/shared';
import { createGuest, createRoom, getRoom } from '../api';
import { useSessionStore } from '../session';

export function HomePage() {
  const session = useSessionStore((state) => state.session);
  const setSession = useSessionStore((state) => state.setSession);
  const [displayName, setDisplayName] = useState(session?.displayName ?? '');
  const [title, setTitle] = useState('');
  const [slug, setSlug] = useState('');
  const navigate = useNavigate();
  const submit = useMutation({
    mutationFn: async (action: RoomMode | 'join') => {
      const name = parseDisplayName(displayName);
      if (!name.ok) throw new Error(name.message);
      if (action === 'join') {
        if (!/^[A-Za-z0-9]{12}$/.test(slug)) throw new Error('Enter the 12 character room slug.');
        const guest = await createGuest(name.value);
        setSession(guest);
        return getRoom(slug, guest.token);
      }
      const parsedTitle = parseRoomTitle(title);
      if (!parsedTitle.ok) throw new Error(parsedTitle.message);
      const mode = parseRoomMode(action);
      if (!mode.ok) throw new Error(mode.message);
      const guest = await createGuest(name.value);
      setSession(guest);
      return createRoom({ title: parsedTitle.value, mode: mode.value }, guest.token);
    },
    onSuccess: (room) => {
      void navigate(`/r/${room.slug}`);
    },
  });

  return (
    <section className="home-page" aria-labelledby="home-title">
      <div className="page-heading">
        <p className="eyebrow">Your next conversation</p>
        <h1 id="home-title">Start with a room.</h1>
        <p className="muted">Create a meeting or webinar, or open a room with its slug.</p>
      </div>
      <fieldset disabled={submit.isPending} className="room-controls" aria-busy={submit.isPending}>
        <legend className="sr-only">Your name and room options</legend>
        <div className="identity-field">
          <div>
            <label htmlFor="display-name">Your display name</label>
            <p className="field-hint" id="name-hint">
              The name others will see. No account needed.
            </p>
          </div>
          <input
            id="display-name"
            name="displayName"
            autoComplete="nickname"
            placeholder="e.g. Ava"
            aria-describedby="name-hint"
            value={displayName}
            onChange={(event) => setDisplayName(event.target.value)}
          />
        </div>
        <div className="room-options">
          <form
            className="room-option"
            onSubmit={(event) => {
              event.preventDefault();
              submit.mutate('MEETING');
            }}
            noValidate
          >
            <p className="option-number" aria-hidden="true">
              01 / CREATE
            </p>
            <h2>A room of your own</h2>
            <p className="muted option-description">
              Give your conversation a title and choose a format.
            </p>
            <label htmlFor="room-title">Room title</label>
            <input
              id="room-title"
              name="title"
              placeholder="e.g. Design review"
              value={title}
              onChange={(event) => setTitle(event.target.value)}
            />
            <div className="create-actions">
              <button className="button button-primary" type="submit">
                Create meeting <span aria-hidden="true">↗</span>
              </button>
              <button
                className="button button-secondary"
                type="button"
                onClick={() => submit.mutate('WEBINAR')}
              >
                Create webinar
              </button>
            </div>
          </form>
          <form
            className="room-option"
            onSubmit={(event) => {
              event.preventDefault();
              submit.mutate('join');
            }}
            noValidate
          >
            <p className="option-number" aria-hidden="true">
              02 / JOIN
            </p>
            <h2>Have a room slug?</h2>
            <p className="muted option-description">
              Enter the slug shared with you to open that room.
            </p>
            <label htmlFor="room-slug">Room slug</label>
            <input
              id="room-slug"
              className="slug-input"
              name="slug"
              placeholder="12 character slug"
              autoComplete="off"
              autoCapitalize="none"
              spellCheck={false}
              value={slug}
              onChange={(event) => setSlug(event.target.value)}
            />
            <button className="button button-secondary join-button" type="submit">
              Join room <span aria-hidden="true">→</span>
            </button>
          </form>
        </div>
      </fieldset>
      {submit.isPending && (
        <p className="request-status" role="status">
          {submit.variables === 'join' ? 'Opening your room…' : 'Creating your room…'}
        </p>
      )}
      {submit.isError && (
        <p className="error-message" role="alert">
          Error: {submit.error.message}
        </p>
      )}
      <aside className="foundation-note">
        <span className="note-marker" aria-hidden="true">
          i
        </span>
        <div>
          <h2>A shared roster, for now.</h2>
          <p>
            Check your devices in the green room, then join the roster. Video between people arrives
            in a later phase.
          </p>
        </div>
      </aside>
    </section>
  );
}
