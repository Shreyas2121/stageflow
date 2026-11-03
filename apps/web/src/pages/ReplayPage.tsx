import { DISPLAY_NAME_MAX_LENGTH } from '@stageflow/shared';
import { useQuery } from '@tanstack/react-query';
import { useEffect, useState } from 'react';
import { Link, useParams } from 'react-router';
import { Button } from '../components/ui/button';
import { FormField } from '../components/ui/form-field';
import { PageState } from '../components/ui/page-state';
import { BroadcastPlayerGate } from '../features/broadcast/components/broadcast-player-gate';
import { broadcastQueryOptions } from '../features/broadcast/query-options';
import { replayPlayback } from '../features/broadcast/services/playback';
import { SpeakerSelect } from '../features/live/components/device-panel';
import {
  audioOutputSupported,
  selectAudioOutput,
  selectedOutputId,
} from '../features/live/services/output-route';
import {
  GuestEntryCancelled,
  replayPathFor,
  useReplayGuestEntry,
} from '../features/session/guest-entry';
import { usableSession, useSessionStore } from '../features/session/session-store';

const alertClass =
  'mt-4 rounded-control border border-danger-line bg-danger-surface px-4.5 py-3.5 text-sm text-danger wrap-anywhere';

export function ReplayPage() {
  const { broadcastId = '' } = useParams();
  const session = usableSession(useSessionStore((state) => state.session));
  const destination = replayPathFor(broadcastId);
  const broadcastQuery = useQuery(broadcastQueryOptions(broadcastId, session));

  if (!destination) {
    return (
      <PageState title="Unable to open this replay.">
        <p className={alertClass} role="alert">
          Error: No broadcast exists for that id.
        </p>
        <Link
          className="mt-4 inline-flex items-center gap-5 text-[13px] text-accent underline-offset-4 hover:underline"
          to="/"
        >
          Back to home <span aria-hidden="true">↗</span>
        </Link>
      </PageState>
    );
  }

  if (!session) return <ReplayGuestForm destination={destination} />;

  if (broadcastQuery.isPending) {
    return (
      <>
        <ReplayOutput />
        <p className="py-16 text-sm text-muted" role="status">
          Opening replay…
        </p>
      </>
    );
  }
  if (broadcastQuery.isError) {
    return (
      <>
        <ReplayOutput />
        <PageState title="Unable to open this replay.">
          <p className={alertClass} role="alert">
            Error: {broadcastQuery.error.message}
          </p>
          <Link
            className="mt-4 inline-flex items-center gap-5 text-[13px] text-accent underline-offset-4 hover:underline"
            to="/"
          >
            Back to home <span aria-hidden="true">↗</span>
          </Link>
        </PageState>
      </>
    );
  }

  const view = replayPlayback(broadcastQuery.data);
  return (
    <section className="pt-9.5 pb-16 layout:pt-15" aria-labelledby="replay-heading">
      <Link
        className="inline-flex items-center gap-5 text-[13px] text-accent underline-offset-4 hover:underline"
        to="/"
      >
        ← Back to home
      </Link>
      <div className="mt-9.5 min-w-0">
        <p className="mb-4 text-[11px] font-semibold tracking-[0.11em] text-eyebrow uppercase">
          Saved broadcast
        </p>
        <h1 className="mb-0" id="replay-heading">
          Replay
        </h1>
      </div>
      <p className="mt-6 text-sm text-muted">Status: {broadcastQuery.data.status}</p>
      <ReplayOutput />
      {view.kind === 'unavailable' && view.message && (
        <p className={alertClass} role="alert">
          Error: {view.message}
        </p>
      )}
      {view.kind === 'vod' && (
        <BroadcastPlayerGate playlistUrl={view.playlistUrl} token={session.token} mode="vod" />
      )}
    </section>
  );
}

function useOutputDevices(): MediaDeviceInfo[] {
  const [devices, setDevices] = useState<MediaDeviceInfo[]>([]);
  useEffect(() => {
    const media = typeof navigator === 'undefined' ? undefined : navigator.mediaDevices;
    if (!media?.enumerateDevices) return;
    let active = true;
    const refresh = () => {
      void media.enumerateDevices().then(
        (list) => {
          if (active) setDevices(list);
        },
        () => {
          if (active) setDevices([]);
        },
      );
    };
    refresh();
    media.addEventListener('devicechange', refresh);
    return () => {
      active = false;
      media.removeEventListener('devicechange', refresh);
    };
  }, []);
  return devices;
}

function ReplayOutput() {
  const devices = useOutputDevices();
  const [speakerId, setSpeakerId] = useState(() => selectedOutputId());
  const [speakerError, setSpeakerError] = useState('');
  return (
    <fieldset className="mt-6 min-w-0 border-0 p-0">
      <legend className="sr-only">Replay speaker</legend>
      <SpeakerSelect
        id="replay-speaker-device"
        devices={devices}
        speakerId={speakerId}
        sinkSupported={audioOutputSupported()}
        speakerError={speakerError}
        onSpeaker={(deviceId) => {
          void selectAudioOutput(deviceId).then((result) => {
            setSpeakerId(result.deviceId);
            setSpeakerError(result.ok ? '' : result.message);
          });
        }}
      />
    </fieldset>
  );
}

function ReplayGuestForm({ destination }: { destination: string }) {
  const entry = useReplayGuestEntry();
  const [displayName, setDisplayName] = useState('');
  const [pending, setPending] = useState(false);
  const [error, setError] = useState('');

  return (
    <PageState eyebrow="A name before you enter" title="Let’s get you a guest session.">
      <p className="text-sm text-muted">Enter your name to watch this replay. No account needed.</p>
      <form
        className="mt-6 max-w-md"
        aria-busy={pending}
        noValidate
        onSubmit={(event) => {
          event.preventDefault();
          setError('');
          setPending(true);
          void entry.submit(displayName, destination).then(
            () => setPending(false),
            (failure: unknown) => {
              if (failure instanceof GuestEntryCancelled) return;
              setPending(false);
              setError(
                failure instanceof Error
                  ? failure.message
                  : 'Unable to start a guest session. Try again.',
              );
            },
          );
        }}
      >
        <FormField
          id="replay-display-name"
          name="displayName"
          label="Your display name"
          hint="The name others will see. No account needed."
          autoComplete="nickname"
          placeholder="e.g. Ava"
          maxLength={DISPLAY_NAME_MAX_LENGTH}
          value={displayName}
          disabled={pending}
          onChange={(event) => setDisplayName(event.target.value)}
        />
        <Button className="mt-4.5" variant="primary" type="submit" disabled={pending}>
          Watch replay <span aria-hidden="true">&#8599;</span>
        </Button>
      </form>
      {pending && (
        <p className="mt-4 text-sm text-focus" role="status">
          Starting your guest session…
        </p>
      )}
      {error && (
        <p className={alertClass} role="alert">
          Error: {error}
        </p>
      )}
      <Link
        className="mt-4 inline-flex items-center gap-5 text-[13px] text-accent underline-offset-4 hover:underline"
        to="/"
      >
        Back to home <span aria-hidden="true">↗</span>
      </Link>
    </PageState>
  );
}
